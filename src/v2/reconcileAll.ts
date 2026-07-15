import { existsSync } from 'node:fs'
import type { LanguageModel } from 'ai'
import type { LibraryRepo } from './libraryRepo.js'
import type { Job, JobsRepo } from './jobsRepo.js'
import { scanLibrary, type OriginResolver } from './scanner.js'
import { makeOrchestratorAgent, type OrchestratorDecision, type OrchestratorAgentDeps } from '../agent/orchestratorAgent.js'
import type { PlayerServer } from '../adapters/players/types.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { PathMapping } from '../core/mediaContext.js'

export interface ReconcileAllDeps {
  jf: Pick<PlayerServer, 'getItemsPage' | 'getItem'>
  /** Full LibraryRepo, not a Pick: scanLibrary (the mechanical pre-scan) needs its whole surface
   *  (upsertSeries/upsertEpisode/etc), while makeOrchestratorAgent below only reads the narrower
   *  Pick it declares — LibraryRepo satisfies both. */
  lib: LibraryRepo
  jobs: OrchestratorAgentDeps['jobs']
  model: LanguageModel
  tmdb: OrchestratorAgentDeps['tmdb']
  mappings: PathMapping[]
  /** A4: target subtitle languages — drives scanLibrary's coverage detection (embedded/sidecar,
   *  scanner.ts rules 2/3). Threaded straight through, unchanged. Optional, defaults to `['zh']`
   *  inside scanLibrary (historical single-target-language default). */
  targetLanguages?: string[]
  /** A4 spec-review fix #2: origin-audio languages that suppress an item (scanner.ts rule 0/1/1b).
   *  Optional, defaults to the effective targetLanguages inside classifyItemDetailed — only the
   *  SKIP_CHINESE_ORIGIN=false compat path passes a narrower set (see cli/targetLanguages.ts). */
  originSkipLanguages?: string[]
  originResolver?: OriginResolver
  now: () => number
  /** null for the root pass (CLI `reconcile-all` / dashboard button, phase ⑦); a real jobs row
   *  id when this run IS a sibling orchestrator claimed off the jobs table (see
   *  runOrchestrateWorkerTask below) — makeOrchestratorAgent itself refuses a fabricated id
   *  (FK constraint on parent_job_id), so this must be a genuine `jobs.id` or null, never guessed. */
  orchestratorJobId: number | null
  stepCap?: number
  maxDispatchesPerOrchestrator?: number
}

/** Shared body for both `cmdReconcileAll` (CLI, src/cli/index.ts) and the dashboard's
 *  POST /api/v2/reconcile-all endpoint (phase ⑦ Task 3's explicit "factor into a shared function,
 *  don't duplicate" requirement): mechanical pre-scan (scanLibrary, unchanged) then one
 *  orchestrator pass over the resulting living-doc. */
export async function runReconcileAll(deps: ReconcileAllDeps): Promise<OrchestratorDecision> {
  await scanLibrary(deps.jf, deps.lib, {
    pageSize: 100,
    fileExists: p => existsSync(p),
    mappings: deps.mappings,
    targetLanguages: deps.targetLanguages,
    originSkipLanguages: deps.originSkipLanguages,
    resolver: deps.originResolver,
  })
  const runOrchestratorPass = makeOrchestratorAgent({
    model: deps.model,
    lib: deps.lib,
    tmdb: deps.tmdb,
    jf: deps.jf,
    jobs: deps.jobs,
    now: deps.now,
    orchestratorJobId: deps.orchestratorJobId,
    stepCap: deps.stepCap,
    maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator,
  })
  return runOrchestratorPass()
}

export interface OrchestrateWorkerTaskDeps {
  lib: OrchestratorAgentDeps['lib']
  tmdb: OrchestratorAgentDeps['tmdb']
  jf: Pick<PlayerServer, 'getItem'>
  model: LanguageModel
  now: () => number
  stepCap?: number
  maxDispatchesPerOrchestrator?: number
}

/** Claims-and-runs one worker_task row whose payload.taskType === 'orchestrate' (a sibling
 *  orchestrator spawned by spawn_sibling_orchestrator when a parent pass hit its 100-dispatch
 *  cap, phase ⑤). Mirrors runRealignWorkerTask/runFindSubtitleWorkerTask's shape (phases ⑥/⑦):
 *  wraps the agent invocation so a thrown error (schema mismatch, step-cap exhaustion, network)
 *  fails the job via completeError instead of propagating and crashing the daemon's claim loop —
 *  unlike those two worker kinds, a sibling orchestrator pass has no partial/no-match outcome to
 *  report; any successful return completes the job done. */
export async function runOrchestrateWorkerTask(
  job: Job, deps: OrchestrateWorkerTaskDeps, jobs: Pick<JobsRepo, 'upsertWorkerTask' | 'get' | 'completeDone' | 'completeError'>,
): Promise<OrchestratorDecision | null> {
  try {
    const runPass = makeOrchestratorAgent({
      model: deps.model, lib: deps.lib, tmdb: deps.tmdb, jf: deps.jf, jobs, now: deps.now, orchestratorJobId: job.id,
      stepCap: deps.stepCap, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator,
    })
    const decision = await runPass()
    jobs.completeDone(job.id, deps.now())
    return decision
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, deps.now())
    return null
  }
}
