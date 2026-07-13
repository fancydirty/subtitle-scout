import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { mirrorExceedsSeasonTable } from './diagnoseSeason.js'

export function makeListMissingCoverageTool(lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies'>, now: () => number) {
  return tool({
    description:
      'Read the mechanical pre-scan\'s living-doc: which series/seasons and movies are ' +
      'currently missing a Chinese subtitle. This is factual bookkeeping only — it does not ' +
      'judge whether any particular subtitle is correct.',
    inputSchema: z.object({}),
    execute: async () => ({
      missingSeasons: lib.missingBySeason(now()),
      missingMovies: lib.missingMovies(now()).map(m => ({ id: m.id, name: m.name })),
    }),
  })
}

/** Deterministic pre-check the orchestrator MUST consult before dispatching a realign task —
 *  this is what makes "正常库零误触发" (zero false-trigger on an already-aligned library) a
 *  code-level property of the orchestrator's own dispatch decision, not just something
 *  executeRealign's internal gates catch after the fact (phase ⑥ leaves those unchanged as a
 *  second, independent layer of defense). Reuses mirrorExceedsSeasonTable — the exact same
 *  pure primary-signal check src/agent/diagnoseSeason.ts already uses to short-circuit to
 *  'unknown' without spending an LLM call when the signal doesn't hold — confirmed unchanged
 *  by reading diagnoseSeason.ts directly. A season with mirrorEpisodeCount <= tmdbEpisodeCount
 *  is NOT a realign candidate, full stop; the tool reports that fact rather than letting the
 *  model infer it from nothing. */
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

export function makeDispatchFindSubtitleTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description: 'Dispatch a find-subtitle worker task for one series+season or one movie.',
    inputSchema: z.object({
      seriesId: z.string().nullable(), season: z.number().int().nullable(), movieId: z.string().nullable(),
      reason: z.string(),
    }),
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
