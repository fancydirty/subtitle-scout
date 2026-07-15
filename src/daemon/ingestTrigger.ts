import type { IngestResult } from '../v2/ingest.js'
import type { JobsRepo } from '../v2/jobsRepo.js'

/**
 * 去 Jellyfin 化 T4（design §P3 "B2 双信号坍缩成单步"）：selfScanTrigger.ts 的两信号
 * refresh-bridge 整体退役——Signal A（我们自己探测到新路径 → 踢 Jellyfin 自己的扫描器
 * refreshLibrary，不触发编排）+ Signal B（knownPaths() 快照 diff，确认 Jellyfin 的镜像
 * 真的摄取完了才触发一次编排）之所以要拆成两步，是因为旧世界里"探测到"和"真的入库"是
 * 两件由不同系统各自完成的事，中间隔着 Jellyfin 自己的扫描周期，需要一层"等它真的做完"
 * 的确认机制。v2/ingest.ts 的 makeIngestPass 是"检测即摄取"的单步直写——识别、覆盖分类、
 * 写库在同一次调用里原地完成，没有"探测到了但还没真的进库"这个中间态需要等待。两信号因此
 * 坍缩成一个：ingest() 跑完后直接读它自己报告的 result.changed（本轮真的写了/删了行），
 * 这就是旧版"确认摄取完成"那一刻的等价物，不再需要外部快照 diff 去验证。
 *
 * 唯一保留的纪律：**orchestrate-trigger 的固定身份去重**（旧
 * SELF_SCAN_ORCHESTRATE_SERIES_ID，见旧模块同名常量的注释）——upsertWorkerTask 的
 * ON CONFLICT dedup 按 identity 走，同一个固定 seriesId 保证"任意时刻至多一个待处理的
 * ingest-triggered orchestrator job"，无需额外的去重表/内存集合。本模块把这个常量搬过来，
 * 改名为 INGEST_ORCHESTRATE_SERIES_ID（诚实性选择，不是必要项——见其自身注释）。
 *
 * 死掉的东西（不移植，语义随两信号机制一起退役）：
 *  - awaiting set（Signal A"已经反应过一次"的记忆）——ingest 自己没有"尝试过但没完成"这种
 *    中间态，一个路径这轮要么直接写成功，要么下一轮重试，没有东西需要"等待中"。
 *  - knownPaths 快照 diff（Signal B 的"确认摄取"判据）——被 result.changed 直接取代。
 *  - getVirtualFolders / refreshLibrary（整个 refresh-bridge 概念）——ingest 直写库，不存在
 *    第二个"别人的扫描器"需要被踢一脚去追赶。
 *  - 重启后"把已知的每条路径都当作新摄取"的一次性追赶式 orchestrate（旧版靠空快照人为
 *    制造这个效果）——新版没有快照这个状态，重启后第一次 ingest 只要真的有变化
 *    （result.changed）一样会正常触发一次编排，不需要刻意模拟"追赶"这个概念。
 */

export interface IngestTriggerDeps {
  /** 调用方预绑定好的 v2/ingest.ts makeIngestPass(...) 返回值。 */
  ingest: () => Promise<IngestResult>
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  log: (msg: string) => void
}

export interface IngestTriggerResult {
  ingest: IngestResult
  /** 本轮 ingest() 报告 changed=true 时为 true（至多一次 upsertWorkerTask 调用，identity 去重）。 */
  orchestratorTriggered: boolean
}

/** ingest-triggered 编排任务的固定 worker_task 身份（同旧 SELF_SCAN_ORCHESTRATE_SERIES_ID
 *  的去重把戏，见本文件头注释）。字符串值本可以延续旧值 'self-scan-trigger'（纯内部 dedup
 *  键，从不对外暴露），但这里选择重命名成 'ingest-trigger'：诚实性选择，不是必要项——P2
 *  已经是"全新库 bootstrap"（design §P2），没有旧数据需要向后兼容；旧值若真的还残留在某个
 *  开发库里，也只是一条不会再被任何代码路径碰到的死行，不影响正确性。 */
export const INGEST_ORCHESTRATE_SERIES_ID = 'ingest-trigger'

/**
 * 建一个 ingest-trigger "tick"：跑一次 ingest()，若本轮有实际变化（result.changed）就
 * upsert 一个 taskType='orchestrate' 的 worker_task（identity 固定，天然去重）。像
 * makeIngestPass/旧 makeSelfScanTrigger 一样不带自己的定时器——daemon（src/v2/daemon.ts）
 * 决定何时调用它，门在自己的 meta 表时间戳（详见 daemon.ts 的 tickInner）。
 */
export function makeIngestTrigger(deps: IngestTriggerDeps): () => Promise<IngestTriggerResult> {
  return async function ingestTriggerTick(): Promise<IngestTriggerResult> {
    const result = await deps.ingest()

    let orchestratorTriggered = false
    if (result.changed) {
      // 固定 identity → upsertWorkerTask 的 ON CONFLICT dedup 保证"至多一个待处理的
      // ingest-triggered orchestrator job"：本轮触发时若上一次触发的那行还没被认领/跑完
      // （仍是 wanted/searching/...），这里只是同一行的 payload/updated_at 被刷新，不会
      // 多出一行（见 jobsRepo.ts upsertWorkerTask 的 ON CONFLICT 分支）。
      deps.jobs.upsertWorkerTask(
        { seriesId: INGEST_ORCHESTRATE_SERIES_ID, season: null, movieId: null },
        {
          taskType: 'orchestrate',
          reason: `ingest: scanned=${result.scanned} upserted=${result.upserted} parked=${result.parked} removed=${result.removed}`,
        },
        null,
        deps.now(),
      )
      orchestratorTriggered = true
      deps.log(
        `ingest trigger: pass changed library state (upserted=${result.upserted} removed=${result.removed}) — orchestrator pass enqueued`,
      )
    }

    return { ingest: result, orchestratorTriggered }
  }
}
