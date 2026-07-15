import type { Job, JobsRepo } from '../v2/jobsRepo.js'

/** W0-4 切 feed 路由决策（纯函数，独立于 cmdWatch 的 executeJob 闭包以便单测——cmdWatch 本身
 *  门在 requireEnv 系列/assemble()，没法在不起真实 LLM 连接的情况下实例化测试；
 *  这个模块本身零副作用，不像 cli/index.ts 顶层跑 main()，测试可以直接 value-import）。
 *  三个旧 kind（worker_task 已在调用点被更早的 if 分支拦截，不会到达这里）里：
 *  - 'realign' 仍然走老 executor.ts 的 executeJob——它的第一行就 dispatch 进
 *    executeRealignBranch（5 重安全层的 realignExecutor.ts 调用链），从不触碰下面
 *    series_season/movie 的旧内部逻辑，是保留机械，不在今天的退休范围内。
 *  - 'series_season'/'movie' 是本任务实际退休的两个 kind：旧执行器不再接线，存量行
 *    墓碑退休（tombstoneLegacyJob），v3 orchestrator 的 list_missing_coverage 接棒。 */
export type LegacyJobKind = 'series_season' | 'movie' | 'realign'
export function routeLegacyJob(kind: LegacyJobKind): 'execute-realign' | 'tombstone' {
  return kind === 'realign' ? 'execute-realign' : 'tombstone'
}

/** W0-4 存量墓碑：series_season/movie 旧 kind 行经 claimNext 领到（state='searching'）后，
 *  旧管线执行器已切断，体面收场——jobsRepo.retireClaimed 把它从 active 态转 done（非
 *  error：它们不是故障，是被 v3 替代；同 series/movie 的缺口由 orchestrator 正常派活覆盖）。
 *  单独抽出成可单测的纯函数——job/jobs/log 都收窄成结构类型，测试不需要真实 JobsRepo/DB。 */
export function tombstoneLegacyJob(
  job: Pick<Job, 'id' | 'kind'>,
  jobs: Pick<JobsRepo, 'retireClaimed'>,
  log: (msg: string) => void,
  now: number
): void {
  const transitioned = jobs.retireClaimed(job.id, now)
  log(`retired legacy ${job.kind} job ${job.id} (old pipeline retired; v3 covers it)`)
  if (!transitioned) log(`warn: job ${job.id} tombstone 但 complete* 守卫未命中（stale lease）`)
}
