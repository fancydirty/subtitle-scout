import type { LanguageModel } from 'ai'
import type { LibraryRepo } from './libraryRepo.js'
import type { Job, JobsRepo } from './jobsRepo.js'
import { makeOrchestratorAgent, type OrchestratorDecision, type OrchestratorAgentDeps } from '../agent/orchestratorAgent.js'
import type { PlayerServer } from '../adapters/players/types.js'

export interface ReconcileAllDeps {
  /** 去 Jellyfin 化 T4：摄取 pass（v2/ingest.ts 的 makeIngestPass 预绑定结果，调用方
   *  cli/index.ts 用同一份 buildIngestPass 帮手给 cmdWatch/cmdReconcileAll 各建一份）——
   *  替换旧的 jf+scanLibrary 机械预扫描（`jf.getItemsPage` 那半 Pick、mappings/
   *  targetLanguages/originSkipLanguages/originResolver 全部随之消失，摄取层自己持有这些）。
   *  返回值类型对 runReconcileAll 不重要——这里只 await 它跑完一轮即可，故意用 Promise<unknown>
   *  保持宽松，不强绑 IngestResult 的具体形状（reconcileAll.ts 不该反向依赖 ingest.ts 的返回
   *  结构）。 */
  ingest: () => Promise<unknown>
  /** Full LibraryRepo, not a Pick: makeOrchestratorAgent below reads the narrower Pick it
   *  declares — LibraryRepo satisfies it directly. */
  lib: LibraryRepo
  jobs: OrchestratorAgentDeps['jobs']
  model: LanguageModel
  tmdb: OrchestratorAgentDeps['tmdb']
  /** orchestrator 自己的 check_series_layout 等工具用（makeOrchestratorAgent 的既有依赖，
   *  未随本次改动变化）——摄取层不再需要它，`getItemsPage` 那半 Pick 随 scanLibrary 一起消失。 */
  jf: Pick<PlayerServer, 'getItem'>
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
 *  don't duplicate" requirement): one ingest pass (去 Jellyfin 化 T4: replaces the old mechanical
 *  scanLibrary pre-scan) then one orchestrator pass over the resulting living-doc. */
export async function runReconcileAll(deps: ReconcileAllDeps): Promise<OrchestratorDecision> {
  await deps.ingest()
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
