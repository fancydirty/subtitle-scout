import type { IngestResult } from '../v2/ingest.js'

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
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 2026-08-13「jobs 队列泄漏」裁决：**orchestrate 入队已删除，本模块不再写 jobs 表**
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 原本这里有一段 `deps.jobs.upsertWorkerTask({...taskType:'orchestrate'...})`。删掉它的
 * 理由不是"暂时没人认领"（那种理由会诱人写成"先留着，接回来就能用"），而是一条**结构性
 * 的不可执行**：
 *
 *   写入方：`taskType: 'orchestrate'`  ← 本模块，曾是全仓唯一
 *   执行方：全仓零个 orchestrate 处理分支（判据见本模块测试的「结构性判据」一条，
 *           它扫的是**代码行**而非注释——本段文字本身就会被它的注释过滤器排除）
 *
 * 注意"无输出"的范围：不只是活代码里没有，**连那个被提取出来待考的死认领者
 * `cli/handleWorkerTask.ts` 里也没有**。它的路由表只有 find_subtitle / realign /
 * translate 三支，orchestrate 会掉进最后的 else，走
 * `completeError('unknown worker_task taskType: orchestrate')`。
 *
 * → 也就是说：这行 job 不是"等着被接回来的活"，它是**即便 jobs 队列整体复活也只会立刻
 *   失败**的一行。orchestrator 那套架构（makeOrchestratorAgent / runOrchestrateWorkerTask
 *   / orchestrateWorkerTaskDeps）已于第 5.5 步随旧架构整体删除，不存在"恢复接线"这个选项
 *   ——要恢复得先重新实现一个 orchestrator。
 *
 * 这与 `handleWorkerTask` 的处境**性质不同**，所以处置也不同：handleWorkerTask 的三个
 * 分支背后是真实存在、测试覆盖的 runner（findSubtitleWorkerTask 等），缺的只是一根 claim
 * 接线，接回来当天就能跑——所以它保留待裁。orchestrate 背后什么都没有。
 *
 * 实测证据（2026-08-13，生产库 /cache/scout.db）：jobs 表 12 行，其中恰好一行
 * `state='wanted'`，就是本模块 2026-08-08 写下的那条 ingest-trigger orchestrate 行，
 * 已搁浅 4.66 天无人认领。固定 identity 的去重让它止步于一行（没有无界增长），但"至多
 * 泄漏一行"仍是泄漏——它会永久占据 dashboard 的待办语义，且是一行永远不可能被执行的活。
 *
 * 删除后本模块**完全不碰 jobs 表**（deps 里的 `jobs` 字段一并移除）。ingest() 本身照跑，
 * 三个调用点（甄别台认领、翻译装盘、daemonV2 requestIngest）的"踢一脚扫描"语义逐字不变
 * ——那才是它们真正想要的效果，orchestrate 入队从来只是搭车的副作用。
 *
 * 那条搁浅的生产行不由代码清理（本仓无 jobs 的 GC 通道，写一个只为删一行不值当）：它
 * state='wanted' 且无人 claim，对活代码零影响；下次谁若真的重建 orchestrator，它会自然
 * 被认领掉。
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface IngestTriggerDeps {
  /** 调用方预绑定好的 v2/ingest.ts makeIngestPass(...) 返回值。 */
  ingest: () => Promise<IngestResult>
  log: (msg: string) => void
}

export interface IngestTriggerResult {
  ingest: IngestResult
}

/** ingest-triggered 编排任务曾经使用的固定 worker_task 身份。
 *
 *  ⚠️ 2026-08-13：**唯一的使用点（orchestrate 入队）已删除**，见本文件头注释的裁决段。
 *  常量本体保留，只为一个用途：生产库里那条 2026-08-08 写下的搁浅行的 `series_id` 就是
 *  这个字符串，排查的人 grep 它要能落到这段解释上。它不再被任何写入路径引用。 */
export const INGEST_ORCHESTRATE_SERIES_ID = 'ingest-trigger'

/**
 * 建一个 ingest-trigger "tick"：跑一次 ingest()，把它的结果原样交回调用方。像
 * makeIngestPass/旧 makeSelfScanTrigger 一样不带自己的定时器——调用方决定何时调用它。
 * 今天的调用方是 cli/index.ts 里的三个"踢一脚"入口（甄别台认领后、翻译装盘后、daemonV2
 * 的 requestIngest），都是事件驱动的即时触发。
 *
 * 2026-08-13：本函数曾在 result.changed 时 upsert 一个 taskType='orchestrate' 的
 * worker_task。那行永远不可能被执行（全仓零 orchestrate 处理分支），入队已删除——完整
 * 论证见文件头的裁决段。ingest() 与 changed 日志逐字保留。
 */
export function makeIngestTrigger(deps: IngestTriggerDeps): () => Promise<IngestTriggerResult> {
  return async function ingestTriggerTick(): Promise<IngestTriggerResult> {
    const result = await deps.ingest()

    if (result.changed) {
      deps.log(
        `ingest trigger: pass changed library state (upserted=${result.upserted} removed=${result.removed})`,
      )
    }

    return { ingest: result }
  }
}
