import type { LanguageModel } from 'ai'
import type { LibraryRepo } from './libraryRepo.js'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { RunsRepo } from './runsRepo.js'
import { makeOrchestratorAgent, type OrchestratorDecision, type OrchestratorAgentDeps } from '../agent/orchestratorAgent.js'
import { traceBus } from '../core/traceBus.js'

/** runs.detail is a human-readable summary the dashboard shows directly (src/v2/runsRepo.ts) —
 *  trim/cap so a long OrchestratorDecision.summary doesn't blow out the timeline UI. Mirrors
 *  findSubtitleWorkerTask.ts/realignWorkerTask.ts's own capDetail (kept file-local rather than
 *  shared, matching this codebase's existing per-file small-helper idiom). */
function capDetail(s: string, max = 200): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

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
  model: LanguageModel
  now: () => number
  stepCap?: number
  maxDispatchesPerOrchestrator?: number
  /** F-R2-3（R2 复审，审计定罪：orchestrator 汇报黑洞）：optional so existing callers/tests keep
   *  compiling without threading it — when absent, runOrchestrateWorkerTask silently skips writing
   *  a runs row (no throw). Mirrors findSubtitleWorkerTask.ts/realignWorkerTask.ts's own `runs?:
   *  Pick<RunsRepo,'insert'>` injection shape; cli/index.ts wires the same RunsRepo instance it
   *  already builds for the other two worker_task runners. */
  runs?: Pick<RunsRepo, 'insert'>
}

/** B3（审计发现，意图黑洞）：spawn_sibling_orchestrator (orchestratorAgent.tools.ts) writes
 *  remainingWorkSummary into the spawned worker_task's payload as free-text handoff context, but
 *  until this fix nothing ever read it back out — the parent pass's context vanished the moment
 *  it was written. Tolerant of a missing/malformed payload (no remainingWorkSummary key, payload
 *  is null, or outright invalid JSON): a dirty handoff note must never crash the sibling pass
 *  that's supposed to pick up the slack, so any parse failure silently degrades to "no note". */
function readRemainingWorkSummary(payload: string | null): string | undefined {
  if (!payload) return undefined
  try {
    const parsed = JSON.parse(payload) as { remainingWorkSummary?: unknown }
    return typeof parsed.remainingWorkSummary === 'string' ? parsed.remainingWorkSummary : undefined
  } catch {
    return undefined
  }
}

/** Claims-and-runs one worker_task row whose payload.taskType === 'orchestrate' (a sibling
 *  orchestrator spawned by spawn_sibling_orchestrator when a parent pass hit its 100-dispatch
 *  cap, phase ⑤). Mirrors runRealignWorkerTask/runFindSubtitleWorkerTask's shape (phases ⑥/⑦):
 *  wraps the agent invocation so a thrown error (schema mismatch, step-cap exhaustion, network)
 *  fails the job via completeError instead of propagating and crashing the daemon's claim loop —
 *  unlike those two worker kinds, a sibling orchestrator pass has no partial/no-match outcome to
 *  report; any successful return completes the job done. B3: reads the claimed job's own
 *  remainingWorkSummary (if the parent pass left one) and threads it through as promptSuffix.
 *
 *  F-R2-3（R2 复审，审计定罪：orchestrator 汇报黑洞）：拿到 OrchestratorDecision 后此前只
 *  completeDone，从不写 runs——decision.summary（连同 dispatchedFindSubtitle/dispatchedRealign/
 *  spawnedSiblings 三个计数）从未抵达 dashboard 的 runs 时间线，orchestrator 这一整类 job 在
 *  时间线上是黑洞。这是 blocked_dormant"surface this to the operator"教导（见
 *  orchestratorAgent.tools.ts 的 reportDispatchOutcome 注释）真正落地的通道：summary 写进 runs
 *  = 运维能在 dashboard 上看见。completeError 分支不写 runs——那个分支已经把 msg 写进
 *  jobs.last_error（completeError 自身的职责），runs 不是第二个上报通道，不重复记。 */
export async function runOrchestrateWorkerTask(
  job: Job, deps: OrchestrateWorkerTaskDeps, jobs: Pick<JobsRepo, 'upsertWorkerTask' | 'get' | 'completeDone' | 'completeError'>,
): Promise<OrchestratorDecision | null> {
  const startedAt = deps.now()
  try {
    const runPass = makeOrchestratorAgent({
      model: deps.model, lib: deps.lib, tmdb: deps.tmdb, jobs, now: deps.now, orchestratorJobId: job.id,
      stepCap: deps.stepCap, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator,
      promptSuffix: readRemainingWorkSummary(job.payload),
    })
    const decision = await runPass()
    const finishedAt = deps.now()
    const detail =
      `dispatched ${decision.dispatchedFindSubtitle} find / ${decision.dispatchedRealign} realign, ` +
      `siblings ${decision.spawnedSiblings}: ${decision.summary}`
    // 痕迹通道 C 收官快照：runKey 与 orchestratorAgent.ts 的 onStepEvent 接线处一致
    // （`job-${orchestratorJobId}`，此处 orchestratorJobId 即 job.id，见上面 makeOrchestratorAgent
    // 调用）。这条路径只写一行 runs（不像 find-subtitle 那样按桶分多行），snapshot 天然只调一次。
    const events = traceBus.snapshot(`job-${job.id}`)
    const traceJson = events.length > 0 ? JSON.stringify(events) : null
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt, decision: 'orchestrate', detail: capDetail(detail), journalPath: null,
      traceJson,
    })
    jobs.completeDone(job.id, finishedAt)
    return decision
  } catch (error) {
    // 痕迹通道 C（复审修复）：失败尝试的痕迹不入账（completeError 分支本来就不写 runs 行——
    // last_error 是它的上报通道，见上方 F-R2-3 注释），但必须排空丢弃——否则残留事件会污染
    // 同一 job 重试成功那次的快照：重试时 makeRunTracer 重新构造、seq 从 0 重计，新旧事件混在
    // 同一条环形缓冲里，seq 碰撞、回放乱序。snapshot 的清空副作用在这里正好是目的本身。
    traceBus.snapshot(`job-${job.id}`)
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, deps.now())
    return null
  }
}
