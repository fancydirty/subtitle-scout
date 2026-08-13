// src/dashboard/stalledJobsHealth.ts —— 「有几件活记着失败了，而且再也没人去重试」的读出面。
//
// ══════════════════════════════════════════════════════════════════════════════
// 生产事实（2026-08-13 实测）
// ══════════════════════════════════════════════════════════════════════════════
// `jobs` 表里有 2 行 `state='failed'`，是 67 小时前挂载掉线期间失败的。`next_retry_at`
// 已经过期 66 小时——按 jobsRepo 的设计，过期就该被 `claimNext` 领走重试。
// 但**队列已无任何认领者**：`claimNext` 生产零调用点（唯一路径经 `cli/handleWorkerTask.ts`，
// 那个模块自第 7 步起生产零 import，`handleWorkerTask.orphan.test.ts` 钉着这个事实）。
// 于是这两行会永远躺在那里，而**界面上一个字都没有**——三页产品没有任何地方读 jobs。
//
// ══════════════════════════════════════════════════════════════════════════════
// 「显示」还是「清理」——为什么两个都不选
// ══════════════════════════════════════════════════════════════════════════════
// ── 方案 A「照原样显示成失败任务」──────────────────────────────────────────
// 否掉。显示一个"失败了，会重试"的任务，而它**永远不会重试**——那是把一句假话换成
// 另一句假话，而且是更难拆穿的一句（用户会等）。旧的 `buildWorkflowWorkers` 就是这么
// 干的（`held: state='failed' 且 next_retry_at 未来`），它已被删，理由写在 apiV2.ts。
//
// ── 方案 B「清理掉」──────────────────────────────────────────────────────
// 否掉，两条理由：
//  ① 抹掉证据。那两行是"挂载掉线那段时间发生过什么"的唯一账目。
//  ② **它不解决问题，只是让问题隐身**。jobs 队列今天仍有一个活写入者
//     （`triageOps.redispatch` ← `POST /api/v2/workflow/redispatch`）。清理逻辑上线之后，
//     用户每按一次那个端点就写一行永远不会被领走的 `wanted`，而清理会把它悄悄扫掉——
//     "我派了活，什么都没发生，而且查不到痕迹"。这比今天更糟。
//
// ── 方案 C（采用）：把**真相**说出来，且判据是行为而非断言 ──────────────────
// 说的那句话是：「有 N 件活记着失败了，**已经 X 没有再被重试**」。这句话在今天为真
// （队列退役），在队列被接回 claim 之后**自动变假**——因为那时这些行会被真的领走，
// 谓词自然查不到它们，这一段自己消失。
//
// 🔴 这是本模块最要紧的设计：**它不硬编码"队列已退役"这个结论**。
// 硬编码的形态（比如 `if (QUEUE_RETIRED) …`）会在队列复活后继续报警，而那时它已经是
// 一句假话，且没有任何用例会红（本仓病 B 的经典形状：把一个中间量当成结论量钉死）。
// 行为谓词「该被领走而没被领走」既覆盖今天这两行，也覆盖将来"接回了 claim 但 worker
// 卡住了"的真故障——同一句话，两种成因，都为真。
//
// ══════════════════════════════════════════════════════════════════════════════
// 信息量边界（R-F9/R-F10：排障归排障）
// ══════════════════════════════════════════════════════════════════════════════
// 出：**条数** + **最久那件过期了多久**。后者是用户判断"这值不值得管"的唯一依据
//     （过期 10 分钟与过期 66 小时是完全不同的两件事）。
// 不出：`last_error` 原文（现网该串是中文且含内部措辞，jobsRepo.ts:110 的既有裁决）、
//       jobId、payload、taskType、series_id。那些全是排障读数，去处是 doctor 与日志——
//       同 `unidentifiedHealth.ts` 与 `rootHealth` 的既有边界，这里不开第三套口径。
// **也不给按钮**：唯一可能的按钮是 `POST /api/v2/workflow/redispatch`，而它会再写一行
//       同样没人领的记录。画一个打不通的按钮是 `UnidentifiedNote` 头注释里已经否掉的形态。
import type { ScoutDb } from '../v2/db.js'
import { ERROR_BACKOFF_DAILY_MS } from '../v2/jobsRepo.js'

/**
 * 「早就该被领走了」的容差。
 *
 * 🔴 复用 `ERROR_BACKOFF_DAILY_MS`（错误轨的**最长**退避阶梯）而不是就地写 48h：
 * 这个门的语义是"**几个最长退避周期**都过去了"，不是"几小时"。写死小时数之后，谁改了
 * 退避阶梯（`errorBackoffMs` 的 give-up 分支就是为此存在的），这里会静默漂移成一个与
 * 重试节奏无关的魔数——本仓 D7/C30「留两份实现必漂移」的既有形态。
 *
 * 为什么是 2× 而不是 1×：`next_retry_at` 一到点并不意味着**下一毫秒**就会被领走——
 * 派发循环有自己的节奏，一件长活跑着的时候后面的活就是会排队。1× 门下，一个正常但繁忙
 * 的队列会周期性地把自己报成"停摆"。2× = 完整错过一整个最长退避周期，那才是真的没人管。
 * （判据形态与 `server.ts` 的 `ROOT_HEALTH_STALE_AFTER_MS` 同源，那里的论证同样适用。）
 */
export const JOB_STALLED_AFTER_MS = 2 * ERROR_BACKOFF_DAILY_MS

/** `/api/v2/health` 的 `stalledJobs` 段。 */
export interface StalledJobsDTO {
  /** 早就该被重试、却一直没动的活的**条数**。0 = 没有这回事（前端整段不渲染）。 */
  count: number
  /**
   * 这些活里**最久**的那件，`next_retry_at` 已经过期多久（毫秒）。`count === 0` 时为 null。
   *
   * 为什么报"过期多久"而不是"失败于什么时候"：用户要判断的是"系统是不是不管了"，
   * 而那取决于**该动而没动了多久**，不是"什么时候摔的"。一件 3 天前失败、10 分钟前
   * 才到重试点的活完全正常；一件 10 分钟前失败、却已过期两天的活不可能存在——
   * 这个读数天然只在真出事时才大。
   */
  overdueMs: number | null
}

/**
 * `jobs` 里「该被领走而没被领走」的活。
 *
 * 🔴 谓词与 `JobsRepo.claimNext` 的取件谓词**同形再加一道时间门**——这是刻意的，
 * 也是本模块唯一需要论证的地方：
 *
 *   claimNext: `state IN ('wanted','failed') AND (next_retry_at IS NULL OR next_retry_at <= now)`
 *   本函数  : 同样两条，**但** `next_retry_at <= now - JOB_STALLED_AFTER_MS`
 *
 * 也就是说本函数查的是 claimNext **本该已经领走**的那批行的一个真子集。这保证了两件事：
 *  ① 队列一旦被接回 claim，这些行会被真的领走 → 谓词查不到 → 这一段**自动消失**。
 *    诚实性由行为保证，不由一个写死的常量保证。
 *  ② 不会误报"还没到点"的正常退避行（那正是字幕台 33 个文件的处境，见 🔴-1）。
 *
 * ⚠️ `next_retry_at IS NULL` 的行**刻意不计入**（与 claimNext 那一支的差别）：
 * 它们是"立刻可领"的新活，没有"过期多久"可言，一个刚被 redispatch 写进来的 `wanted`
 * 行会在写入的那一刻就满足 `IS NULL` → 当场被报成"停摆"。那是把冷启动误报成故障
 * （同 `inspectFreshness` 里「never 不许算成 56 年的陈旧」是同一条纪律）。
 * 代价如实记：`redispatch` 写的行确实永远不会被领走，而本函数看不见它们。
 * 那是**另一条链**（一个没有消费者的写入端点），修法是给那个端点一个结论，不是在这里
 * 把两件事混成一个数字。见报告"发现但没修"。
 *
 * 读失败返回空态而不抛错：同隔壁 `buildUnidentifiedHealth` / `listRecentFound` 的既有
 * 口径——这一段挂掉不许把整个 /health 带走（那会让守备目录健康度也一起查不到）。
 */
export function buildStalledJobs(db: ScoutDb, now: number): StalledJobsDTO {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c, MIN(next_retry_at) AS oldest FROM jobs
          WHERE state IN ('wanted', 'failed')
            AND next_retry_at IS NOT NULL
            AND next_retry_at <= ?`,
      )
      .get(now - JOB_STALLED_AFTER_MS) as { c: number; oldest: number | null }
    if (row.c === 0 || row.oldest === null) return { count: 0, overdueMs: null }
    // 夹 0：时钟回拨下 now < oldest 会算出负数，而"过期 -3 小时"只会让人以为界面坏了
    // （同 relAgo 的既有处置）。走到这里 row.oldest 必 <= now - 容差，故正常路径夹不到。
    return { count: row.c, overdueMs: Math.max(0, now - row.oldest) }
  } catch {
    return { count: 0, overdueMs: null }
  }
}
