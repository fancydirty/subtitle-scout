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
 *  completeDone/completeError/park methods — no new safety logic. */
export async function runRealignWorkerTask(
  job: Job, deps: RealignExecutorDeps, jobs: Pick<JobsRepo, 'completeDone' | 'completeError' | 'park'>, now: () => number,
): Promise<RealignExecutionResult> {
  const result = await executeRealign(job, deps)
  if (result.decision === 'realigned') jobs.completeDone(job.id, now())
  else if (result.decision === 'park') jobs.park(job.id, result.detail, now())
  else jobs.completeError(job.id, result.detail, now())
  return result
}
