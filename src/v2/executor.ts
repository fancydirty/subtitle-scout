import type { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, Job } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import type { RealignExecutionResult } from './realignExecutor.js'

export interface ExecutorDeps {
  lib: LibraryRepo
  jobs: JobsRepo
  /** realign job 执行闭包（可选）：executeJob 遇到 kind==='realign' 时调用——生产接线为
   *  realignExecutor.executeRealign 的柯里化（见 RealignExecutionResult）。未注入（生产
   *  接线不完整/仅测试省略）时停车（park → dormant，不自动重试）而不是 completeError——
   *  接线缺失不是瞬时故障，短退避重试只会陷入无穷 errorloop（D-review #3）。 */
  executeRealign?: (job: Job) => Promise<RealignExecutionResult>
  now: () => number
  log: (msg: string) => void
}

/**
 * 剧级执行器：kind==='realign' 路由到 executeRealignBranch（5 重安全层的 realignExecutor.ts
 * 调用链，保留机械，一行未动）。
 *
 * 退役T7 (Wave 2A)：series_season/movie 的旧管线执行内部（代表集重derive/onCovered/
 * complete* 决策路由、makeRunEpisode Layer 2 接线、以及只服务它们的 pad2/coveredDetail/
 * briefCause/SOURCE_BY_DECISION/remainingTargets 等 helper）已整体删除——旧执行器不再
 * 接线。claimNext() 领到的存量 series_season/movie 行在到达这里之前，已经被
 * cli/index.ts 的 routeLegacyJob 分流给 tombstoneLegacyJob 体面退休（见
 * cli/legacyJobRouting.ts）；这两个 kind 按今天的接线不可能真正调用到这个函数体。
 * 下面的 throw 不是"尚未实现"，是一道接线回归警报——任何未来把这两个 kind 重新接回
 * 这里的改动会立刻在测试/生产日志里炸出来，而不是被静默吞掉。
 */
export async function executeJob(job: Job, deps: ExecutorDeps): Promise<void> {
  if (job.kind === 'realign') {
    await executeRealignBranch(job, deps)
    return
  }
  throw new Error(`old-pipeline kind ${job.kind} retired (Wave 2A)`)
}

/** realign job 的执行分支：租约/退避复用既有状态机（completeDone/completeError），
 *  不新增状态转移。executeRealign 未注入（D-review #3）时停车（park → dormant）而不是
 *  completeError——接线缺失是配置性缺陷，不是瞬时故障，走 error 轨会陷入 30s→15min→daily
 *  的无穷 errorloop（每轮都白记一条 runs）。dormant 不参与派发，接线修好后可 wake 唤醒。 */
async function executeRealignBranch(job: Job, deps: ExecutorDeps): Promise<void> {
  const { jobs, now, log } = deps
  const runs = new RunsRepo(deps.lib.db)
  const startedAt = now()
  if (!deps.executeRealign) {
    jobs.park(job.id, 'realign executor not wired', now())
    runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: '整理执行器未接线，已停车（不自动重试；接线后重启或手动唤醒）', journalPath: null })
    log(`warn: job ${job.id} realign 未接线，已停车（dormant，不自动重试）`)
    return
  }
  try {
    const result = await deps.executeRealign(job)
    if (result.decision === 'realigned') {
      const transitioned = jobs.completeDone(job.id, now())
      runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'realigned', detail: result.detail, journalPath: null })
      if (!transitioned) log(`warn: job ${job.id} realign 完成但 complete* 守卫未命中（stale lease）`)
    } else if (result.decision === 'park') {
      // IMP#11：确定性失败（计划闸门/挂载能力 abandon/库根推导失败等配置与数据缺陷）——
      // 重试一万次也不会自己变好，走 error 轨只会陷入 30s→15min→daily 的无穷重试环，
      // 每天空跑还可能反复触碰媒体目录。停车（dormant），修好后可手动/播放唤醒。
      const transitioned = jobs.park(job.id, result.detail, now())
      runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: `已停车（确定性失败，不自动重试）：${result.detail}`, journalPath: null })
      log(`warn: job ${job.id} realign 确定性失败，已停车（dormant）：${result.detail}`)
      if (!transitioned) log(`warn: job ${job.id} realign 停车但守卫未命中（stale lease）`)
    } else {
      const transitioned = jobs.completeError(job.id, result.detail, now())
      runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: result.detail, journalPath: null })
      if (!transitioned) log(`warn: job ${job.id} realign 失败但 complete* 守卫未命中（stale lease）`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: `整理失败，稍后自动重试：${msg}`, journalPath: null })
  }
}
