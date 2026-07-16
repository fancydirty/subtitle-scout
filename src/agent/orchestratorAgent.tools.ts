import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { tmdbIdFromOwnId } from '../v2/ownIds.js'
import { mirrorExceedsSeasonTable } from '../core/seasonShape.js'
import { coercibleInt, nullableTolerant } from './coerce.js'

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
 *  reported as NOT a realign candidate; the tool reports that fact, it does not enforce it.
 *
 *  tmdbId is resolved INTERNALLY via tmdbIdFromOwnId(seriesId) (src/v2/ownIds.ts), NOT taken as a
 *  model-supplied input — the orchestrator model has no source for a series' tmdbId
 *  (list_missing_coverage rows are {seriesId, season, missing} only), so a model-facing tmdbId
 *  param was uncallable in practice (the model could only fabricate one, which silently always
 *  resolved to exceedsSeasonTable:false). 去 Jellyfin 化 P4: the id IS the identity now
 *  (series.id = 'tmdb:<TMDB id>', T2/ownIds.ts) — extracting it is a pure, zero-I/O string parse,
 *  no more live jf.getItem(seriesId) round-trip to read ProviderIds.Tmdb. This also retires the
 *  old "lib.getSeries().provider_ids is an unreliable historical mirror" caveat: T3's ingest layer
 *  (design D5) now writes provider_ids on every row, but that column was never the primary source
 *  of truth here anyway — the own id embedded in seriesId itself is, and always will be, since the
 *  id space's whole point is that identity round-trips through the id with zero I/O. */
export function makeCheckSeriesLayoutTool(
  lib: Pick<LibraryRepo, 'countEpisodesInSeason'>,
  tmdb: Pick<TmdbClient, 'getSeasonTable'>,
) {
  return tool({
    description:
      'Deterministic check: does this series/season\'s mirror episode count exceed TMDB\'s ' +
      'recorded episode count for that season? Only a TRUE result is even a candidate for ' +
      'dispatch_realign_task — this is the same primary signal diagnoseSeason.ts already uses ' +
      'to rule out realign candidates without spending an LLM call. Resolves the series\' TMDB ' +
      'id internally from seriesId itself — you only need to pass seriesId and season.',
    inputSchema: z.object({ seriesId: z.string(), season: z.number().int() }),
    execute: async ({ seriesId, season }) => {
      const mirrorEpisodeCount = lib.countEpisodesInSeason(seriesId, season)
      const tmdbId = tmdbIdFromOwnId(seriesId)
      if (!tmdbId) {
        return { mirrorEpisodeCount, tmdbEpisodeCount: null, exceedsSeasonTable: false }
      }
      const seasonTable = await tmdb.getSeasonTable(tmdbId).catch(() => null)
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

/** A well-formed identity is exactly one of (seriesId non-null, movieId null) XOR (movieId
 *  non-null, seriesId null) — plain XOR, no season involved.
 *
 *  R-11（用户裁决 2026-07-16，原文锚点：「到底按季还是按剧，是根据具体情况具体分析的」）: this
 *  used to also force season non-null for a series dispatch, because upsertWorkerTask's identity
 *  tuple was (kind='worker_task', series_id, ifnull(season,-1), ifnull(movie_id,'')) and
 *  dispatch_realign_task ALSO writes kind='worker_task' with season forced to null for the same
 *  seriesId — a find_subtitle dispatch with a null season collided with that realign identity.
 *  Schema v11 (db.ts MIGRATIONS[2]) folded payload's taskType into the jobs_identity unique index
 *  (kind, series_id, season, movie_id, taskType), and jobsRepo.upsertWorkerTask's ON CONFLICT
 *  target follows suit — find_subtitle and realign no longer share a row for the same series no
 *  matter what season is. That was the null-season guard's ONLY reason to exist; with the
 *  collision gone, dispatch scope (which seasons) is the orchestrator's own judgment call, carried
 *  in the `seasons` array (see makeDispatchFindSubtitleTaskTool's description) rather than forced
 *  through the identity tuple. */
function hasWellFormedFindSubtitleIdentity(v: { seriesId: string | null; movieId: string | null }): boolean {
  const isSeries = v.seriesId !== null && v.movieId === null
  const isMovie = v.seriesId === null && v.movieId !== null
  return isSeries || isMovie
}

const FIND_SUBTITLE_IDENTITY_ERROR =
  'dispatch_find_subtitle_task requires exactly one identity: either seriesId (optionally with ' +
  'a seasons array) with movieId null, or movieId alone with seriesId null.'

export function makeDispatchFindSubtitleTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description:
      'Dispatch a find-subtitle worker task. Scope it by YOUR judgment of the on-disk reality: ' +
      'pass seasons:[3] when only season 3 exists on disk, seasons:[1,2,3] to have one worker ' +
      'sweep a series whose seasons are all missing subtitles (one season pack often covers them ' +
      'all), or omit seasons to cover every season that currently has gaps. For a movie pass ' +
      'movieId alone. Huge backlogs may be split into several dispatches at your discretion.',
    // Tolerant of the real model's natural shape (proven live, v3 live matrix, 2026-07-13): it
    // OMITS the other kind's field entirely (e.g. no `movieId` key at all when dispatching a
    // series) rather than sending an explicit JSON null, and may send seasons entries as strings
    // (`["1","2"]`) or the whole field as the sentinel "None". Plain `.nullable()` rejects an
    // omitted key (only `.nullish()`/`.optional()` accept `undefined`), so the tool-call failed
    // validation before execute() ever ran and zero rows landed — same class of bug as the
    // A-layer finalize-undefined fix. nullableTolerant/coercibleInt normalize omitted-key/
    // string-sentinel/string-number inputs to `null` (never `undefined`) before
    // hasWellFormedFindSubtitleIdentity below ever sees them.
    inputSchema: z.object({
      seriesId: nullableTolerant(z.string()),
      seasons: nullableTolerant(z.array(coercibleInt)),
      movieId: nullableTolerant(z.string()),
      reason: z.string(),
    }).refine(hasWellFormedFindSubtitleIdentity, { message: FIND_SUBTITLE_IDENTITY_ERROR }),
    execute: async ({ seriesId, seasons, movieId, reason }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      deps.jobs.upsertWorkerTask(
        { seriesId, season: null, movieId },
        { taskType: 'find_subtitle', seasons: seasons && seasons.length > 0 ? seasons : null, reason },
        deps.parentJobId, deps.now(),
      )
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
