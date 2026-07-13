import { executeRealign, type RealignExecutorDeps, type RealignExecutionResult } from './realignExecutor.js'
import type { Job, JobsRepo } from './jobsRepo.js'

export interface RealignWorkerTaskPayload { taskType: 'realign'; seriesId: string; reason: string }

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
 *  steps (getVirtualFolders/getItem/waitForJellyfinIdle in realignExecutor.ts) sit outside its own
 *  result-returning try/catch, so a Jellyfin outage mid-call propagates as a rejected promise, not
 *  a structured {decision:'error'}. Left unhandled, that throw would escape this wrapper entirely:
 *  the job stays 'searching' forever, reapOrphaned eventually bounces it back to 'wanted' with
 *  neither error_attempt incremented nor next_retry_at set, it gets re-claimed almost immediately,
 *  and throws again — an unbounded, backoff-free spin loop that floods the runs table and
 *  monopolizes the realign concurrency slot for the entire outage. Mirrors the old path's
 *  executeRealignBranch (src/v2/executor.ts) and this file's two siblings
 *  (runFindSubtitleWorkerTask, runOrchestrateWorkerTask), both of which already wrap their
 *  respective call in try/catch → completeError. */
export async function runRealignWorkerTask(
  job: Job, deps: RealignExecutorDeps, jobs: Pick<JobsRepo, 'completeDone' | 'completeError' | 'park'>, now: () => number,
): Promise<RealignExecutionResult | null> {
  try {
    const result = await executeRealign(job, deps)
    if (result.decision === 'realigned') jobs.completeDone(job.id, now())
    else if (result.decision === 'park') jobs.park(job.id, result.detail, now())
    else jobs.completeError(job.id, result.detail, now())
    return result
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    return null
  }
}
