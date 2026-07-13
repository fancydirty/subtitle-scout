import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { mirrorExceedsSeasonTable } from './diagnoseSeason.js'

export interface MissingSeasonRow { kind: 'season'; seriesId: string; season: number; missing: number }
export interface MissingMovieRow { kind: 'movie'; movieId: string; name: string }
export type MissingCoverageRow = MissingSeasonRow | MissingMovieRow

export interface MissingCoveragePage {
  rows: MissingCoverageRow[]
  total: number
  offset: number
  hasMore: boolean
}

const DEFAULT_MISSING_COVERAGE_LIMIT = 50
const MAX_MISSING_COVERAGE_LIMIT = 200

/** Paginated (mirrors resultHandles.ts's list_candidates(id, offset, limit) shape) — the 100-cap
 *  on dispatch exists specifically to bound how much the orchestrator ingests per turn, and an
 *  unbounded inline dump here would defeat that premise on a large-enough library even though
 *  season-aggregation keeps the realistic common case small (5000 episodes -> ~200 season rows).
 *  Seasons and movies are combined into one flat, offset-addressable list rather than paginated
 *  separately, so a single (offset, limit) pair pages through the whole backlog. */
export function makeListMissingCoverageTool(lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies'>, now: () => number) {
  return tool({
    description:
      'Read the mechanical pre-scan\'s living-doc: which series/seasons and movies are ' +
      'currently missing a Chinese subtitle. This is factual bookkeeping only — it does not ' +
      'judge whether any particular subtitle is correct. Paginated: returns at most `limit` ' +
      'rows per call (default 50, max 200) starting at `offset`. When `hasMore` is true, call ' +
      'again with a higher `offset` to see the rest — do not assume one call returned the whole ' +
      'backlog.',
    inputSchema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_MISSING_COVERAGE_LIMIT).default(DEFAULT_MISSING_COVERAGE_LIMIT),
    }),
    execute: async ({ offset, limit }): Promise<MissingCoveragePage> => {
      const seasonRows: MissingCoverageRow[] = lib.missingBySeason(now()).map(s => ({
        kind: 'season', seriesId: s.series_id, season: s.season, missing: s.missing,
      }))
      const movieRows: MissingCoverageRow[] = lib.missingMovies(now()).map(m => ({
        kind: 'movie', movieId: m.id, name: m.name,
      }))
      const all = [...seasonRows, ...movieRows]
      const total = all.length
      const rows = all.slice(offset, offset + limit)
      return { rows, total, offset, hasMore: offset + rows.length < total }
    },
  })
}

/** Advisory inventory fact-check, NOT a code-level gate: the orchestrator's own instructions
 *  (skill text + system prompt) tell it to consult this before dispatch_realign_task, but that
 *  requirement is prompt-enforced only — dispatch_realign_task itself never reads
 *  exceedsSeasonTable, so nothing in code stops a model that ignores its instructions from
 *  dispatching a realign task on a hunch. The real code-level, zero-false-trigger
 *  ("正常库零误触发") gate lives downstream in executeRealign (phase ⑥, unchanged) — that is the
 *  safety net by design (the model decides dispatch; executeRealign is what actually must never
 *  misfire on an aligned library), not this tool. Reuses mirrorExceedsSeasonTable — the exact
 *  same pure primary-signal check src/agent/diagnoseSeason.ts already uses to short-circuit to
 *  'unknown' without spending an LLM call when the signal doesn't hold — confirmed unchanged by
 *  reading diagnoseSeason.ts directly. A season with mirrorEpisodeCount <= tmdbEpisodeCount is
 *  reported as NOT a realign candidate; the tool reports that fact, it does not enforce it. */
export function makeCheckSeriesLayoutTool(
  lib: Pick<LibraryRepo, 'countEpisodesInSeason'>,
  tmdb: Pick<TmdbClient, 'getSeasonTable'>,
) {
  return tool({
    description:
      'Deterministic check: does this series/season\'s mirror episode count exceed TMDB\'s ' +
      'recorded episode count for that season? Only a TRUE result is even a candidate for ' +
      'dispatch_realign_task — this is the same primary signal diagnoseSeason.ts already uses ' +
      'to rule out realign candidates without spending an LLM call.',
    inputSchema: z.object({ seriesId: z.string(), season: z.number().int(), tmdbId: z.string() }),
    execute: async ({ seriesId, season, tmdbId }) => {
      const mirrorEpisodeCount = lib.countEpisodesInSeason(seriesId, season)
      const seasonTable = await tmdb.getSeasonTable(tmdbId)
      const tmdbEpisodeCount = seasonTable?.find(s => s.seasonNumber === season)?.episodeCount ?? null
      const exceedsSeasonTable = mirrorExceedsSeasonTable({ seriesId, season, mirrorEpisodeCount, tmdbEpisodeCount })
      return { mirrorEpisodeCount, tmdbEpisodeCount, exceedsSeasonTable }
    },
  })
}

export interface DispatchDeps {
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  parentJobId: number | null
  maxDispatchesPerOrchestrator?: number
}

/** Shared mutable counter across every dispatch_* tool instance for one orchestrator run —
 *  the 100-cap is a single budget across ALL dispatch kinds, not 100 find-subtitle tasks PLUS
 *  100 realign tasks separately. */
export interface DispatchCounter { count: number }

function capCheck(counter: DispatchCounter, cap: number): { error: string } | null {
  if (counter.count >= cap) {
    return { error: `dispatch cap (${cap}) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly` }
  }
  return null
}

/** A well-formed identity is exactly one of (seriesId + season, movieId null) XOR (movieId only,
 *  seriesId/season both null). This matters beyond ordinary input hygiene: upsertWorkerTask's
 *  identity tuple is (kind='worker_task', series_id, ifnull(season,-1), ifnull(movie_id,'')), and
 *  dispatch_realign_task ALSO writes kind='worker_task' with season forced to null for the same
 *  seriesId — so a find_subtitle dispatch with a null season for a series that already has (or
 *  later gets) a pending realign task for that same series lands on the EXACT SAME identity row
 *  as that realign task. Whichever of the two upserts second silently no-ops onto the other's
 *  payload (upsertWorkerTask only overwrites payload/parent_job_id when the existing row's state
 *  is 'done') rather than creating the distinct find-subtitle task the caller intended. Refusing
 *  a null season up front prevents this identity collision from ever being possible. */
function hasWellFormedFindSubtitleIdentity(v: { seriesId: string | null; season: number | null; movieId: string | null }): boolean {
  const isSeriesSeason = v.seriesId !== null && v.season !== null && v.movieId === null
  const isMovie = v.seriesId === null && v.season === null && v.movieId !== null
  return isSeriesSeason || isMovie
}

const FIND_SUBTITLE_IDENTITY_ERROR =
  'dispatch_find_subtitle_task requires exactly one well-formed identity: either (seriesId + ' +
  'season) with movieId null, or movieId alone with seriesId and season both null. A null ' +
  'season with a non-null seriesId is rejected because it collides with dispatch_realign_task\'s ' +
  'worker_task identity for the same series (both would write kind=worker_task, series_id=X, ' +
  'season=NULL).'

export function makeDispatchFindSubtitleTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description: 'Dispatch a find-subtitle worker task for one series+season or one movie.',
    inputSchema: z.object({
      seriesId: z.string().nullable(), season: z.number().int().nullable(), movieId: z.string().nullable(),
      reason: z.string(),
    }).refine(hasWellFormedFindSubtitleIdentity, { message: FIND_SUBTITLE_IDENTITY_ERROR }),
    execute: async ({ seriesId, season, movieId, reason }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      deps.jobs.upsertWorkerTask({ seriesId, season, movieId }, { taskType: 'find_subtitle', reason }, deps.parentJobId, deps.now())
      counter.count++
      return { dispatched: true, remainingCapacity: cap - counter.count }
    },
  })
}

export function makeDispatchRealignTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description:
      'Dispatch a realign worker task for one series whose on-disk layout looks misaligned ' +
      'with TMDB (e.g. absolute-numbering flat layout). Dispatch this BEFORE find_subtitle for ' +
      'the same series if both are pending — realigning first means the subsequent ' +
      'find-subtitle task sees correctly-numbered files.',
    inputSchema: z.object({ seriesId: z.string(), reason: z.string() }),
    execute: async ({ seriesId, reason }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      deps.jobs.upsertWorkerTask({ seriesId, season: null, movieId: null }, { taskType: 'realign', reason }, deps.parentJobId, deps.now())
      counter.count++
      return { dispatched: true, remainingCapacity: cap - counter.count }
    },
  })
}

/** Does NOT count against the 100-dispatch cap — this IS the cap's escape valve. shardIndex is
 *  supplied by the model (or a simple incrementing counter the caller tracks) purely to keep
 *  the synthetic seriesId human-legible in the jobs table; it has no other significance. */
export function makeSpawnSiblingOrchestratorTool(deps: Omit<DispatchDeps, 'maxDispatchesPerOrchestrator'>) {
  return tool({
    description:
      'Hand off remaining dispatch work to a new sibling orchestrator job, once you have used ' +
      'up this orchestrator\'s dispatch capacity. Give it a short description of what remains.',
    inputSchema: z.object({ shardIndex: z.number().int(), remainingWorkSummary: z.string() }),
    execute: async ({ shardIndex, remainingWorkSummary }) => {
      const syntheticSeriesId = `orchestrator-shard-${deps.parentJobId ?? 'root'}-${shardIndex}`
      deps.jobs.upsertWorkerTask(
        { seriesId: syntheticSeriesId, season: null, movieId: null },
        { taskType: 'orchestrate', remainingWorkSummary },
        deps.parentJobId,
        deps.now(),
      )
      return { spawned: true, syntheticSeriesId }
    },
  })
}
