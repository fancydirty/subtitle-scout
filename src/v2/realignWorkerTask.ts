import { executeRealign, type RealignExecutorDeps, type RealignExecutionResult } from './realignExecutor.js'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { RunsRepo } from './runsRepo.js'
import { traceBus } from '../core/traceBus.js'

export interface RealignWorkerTaskPayload { taskType: 'realign'; seriesId: string; reason: string }

/** runs.detail is a human-readable summary the dashboard shows directly (src/v2/runsRepo.ts) —
 *  trim/cap so a raw detail/thrown error message (which can run long) doesn't blow out the
 *  timeline UI. Mirrors findSubtitleWorkerTask.ts's own capDetail (kept file-local rather than
 *  shared, matching this codebase's existing per-file small-helper idiom). */
function capDetail(s: string, max = 200): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/** 退役T1 (W0-3a): RealignExecutorDeps (realignExecutor.ts, safety-critical, not touched by this
 *  campaign step) plus an optional `runs` sink this thin runner writes a timeline row to. Optional
 *  so existing callers/tests keep compiling without threading it — when absent, this silently
 *  skips writing a runs row (no throw). Extending rather than modifying RealignExecutorDeps: `deps`
 *  is still structurally assignable to RealignExecutorDeps when passed into executeRealign below
 *  (TS only excess-property-checks object literals, not variables), so this needs no change to
 *  realignExecutor.ts itself. */
export interface RealignWorkerTaskDeps extends RealignExecutorDeps {
  runs?: Pick<RunsRepo, 'insert'>
}

/** Claims-and-runs one worker_task row whose payload.taskType === 'realign'. Called from the
 *  same claim-dispatch switch as the find-subtitle worker (phase ⑦) — job.kind === 'worker_task'
 *  is generic, the payload's taskType discriminates which handler to invoke. This is the exact
 *  row shape src/agent/orchestratorAgent.tools.ts's makeDispatchRealignTaskTool already writes
 *  (phase ⑤, merged): kind='worker_task', series_id=<seriesId>, season=NULL, movie_id=NULL,
 *  payload={taskType:'realign', reason}. executeRealign itself only ever reads job.series_id/
 *  job.id/job.plan_ref — it is kind-agnostic, so a worker_task row works identically to the
 *  older standalone kind='realign' row it was originally tested against.
 *  Inherits all five of executeRealign's existing safety layers unchanged; this wrapper only
 *  bridges a worker_task row's identity (series_id column) to the Job shape executeRealign
 *  expects (job.series_id) and its completion back onto the jobs table via the existing
 *  completeDone/completeError/park methods — no new safety logic.
 *
 *  Review fix (v3 phase ⑦, throw-containment): executeRealign genuinely throws — several of its
 *  steps (getVirtualFolders/getItem/waitForIngestIdle in realignExecutor.ts) sit outside its own
 *  result-returning try/catch, so a Jellyfin outage mid-call propagates as a rejected promise, not
 *  a structured {decision:'error'}. Left unhandled, that throw would escape this wrapper entirely:
 *  the job stays 'searching' forever, reapOrphaned eventually bounces it back to 'wanted' with
 *  neither error_attempt incremented nor next_retry_at set, it gets re-claimed almost immediately,
 *  and throws again — an unbounded, backoff-free spin loop that floods the runs table and
 *  monopolizes the realign concurrency slot for the entire outage. Mirrors the old path's
 *  executeRealignBranch (src/v2/executor.ts, deleted in the old-pipeline retirement) and this
 *  file's two siblings (runFindSubtitleWorkerTask, runOrchestrateWorkerTask), both of which
 *  already wrap their respective call in try/catch → completeError. */
export async function runRealignWorkerTask(
  job: Job, deps: RealignWorkerTaskDeps, jobs: Pick<JobsRepo, 'completeDone' | 'completeError' | 'park'>, now: () => number,
): Promise<RealignExecutionResult | null> {
  const startedAt = now()
  // R2D-13（R2 复审）：字幕先行阶段不是单一 runKey——deps.runEpisode 逐集调用（realignExecutor.ts
  // 步骤 12），每次调用把 `${job.id}-${item.absoluteEpisode}` 当作 jobId 传给 makeRealignRunEpisode
  // 组出的 FindSubtitleTask，find-subtitle worker 的 onStepEvent 桥接因此把工具调用痕迹发布到
  // `job-${job.id}-${absoluteEpisode}` 这个逐集 runKey——从未等于本函数自己的 `job-${job.id}`。
  // 收官快照必须用 snapshotPrefix 把"以 job-${job.id}- 开头"的全部子集缓冲一并收走，否则：
  // ①这些缓冲无上界残留在 traceBus 的进程级 Map 里，永远没有 snapshot 调用把它们清空
  // ②realign runs 行永远没有 trace_json（Workflow 页 realign WorkerCard 直播因此也永远空白，
  // 见 apiV2.ts buildWorkflowWorkers 对应的 peekPrefix 改法）。
  const runKeyPrefix = `job-${job.id}-`
  // 退役T1 (W0-3a): one runs row per terminal outcome, mirroring executor.ts's own
  // executeRealignBranch shape (decision + human-readable detail, journalPath null — this runner
  // has no journal). executor.ts itself was deleted in the old-pipeline retirement; this comment
  // only documents where the shape was borrowed from. decision strings are prefixed 'realign:' to
  // disambiguate from the find-subtitle worker's own decision vocabulary in the shared runs
  // table/dashboard timeline. recordRun is called exactly once per invocation (one of the three
  // success branches below, or the catch) — no lazy-cache needed here, unlike
  // findSubtitleWorkerTask.ts's recordRun (which can fire multiple times per invocation).
  const recordRun = (decision: string, detail: string): void => {
    // 复审修复（可选链短路陷阱，同 findSubtitleWorkerTask.ts 先例）：snapshotPrefix() 必须先于
    // 可选链求值——留在 insert 实参位置的话，deps.runs 缺席时可选链连实参求值一起短路，逐集
    // runKey 缓冲永不排空（无上界残留，审计脚本已实证）。runs 缺席=只排空不落账。
    const events = traceBus.snapshotPrefix(runKeyPrefix)
    const traceJson = events.length > 0 ? JSON.stringify(events) : null
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: capDetail(detail), journalPath: null, traceJson,
    })
  }
  try {
    const result = await executeRealign(job, deps)
    if (result.decision === 'realigned') {
      jobs.completeDone(job.id, now())
      recordRun('realign:done', result.detail)
    } else if (result.decision === 'park') {
      jobs.park(job.id, result.detail, now())
      recordRun('realign:parked', result.detail)
    } else {
      jobs.completeError(job.id, result.detail, now())
      recordRun('realign:error', result.detail)
    }
    return result
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('realign:error', msg)
    return null
  }
}
