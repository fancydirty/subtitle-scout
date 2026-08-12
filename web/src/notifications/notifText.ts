// web/src/notifications/notifText.ts：通知页的纯函数层（分组键 / 集号排版 / 按天分桶）。
//
// 全部是纯函数、`now` 一律**入参**（不读 Date.now）：同 activity/ 五个子组件的既有铁律——
// 时间是入参而非副作用，测试才能确定性地断言"今天/昨天"这类读数。
//
// ⚠️ 这一层**一条业务规则都不实现**。一周窗、倒序、聚合口径全部长在后端
// （notificationsRepo.listRecentFoundGrouped）。这里只做排版：把后端已经排好序的
// `FoundGroup[]` 切成按天的段落。**尤其不做二次过滤**——一周窗在前端再写一份的话，
// 两份实现会静默漂移（后端注释里对读窗/清理共用同一常量的论证，同一个道理）。
import type { FoundGroupDTO } from '../api/types.js'

/**
 * React `key`。
 *
 * ── 为什么必须自己拼（不是懒得找 id）─────────────────────────────────────────
 * `FoundGroup` **没有稳定的行 id**：后端是**逐集存、读时聚合**，一个"组"根本不是表里的
 * 一行——它是 JS 里现 new 出来的对象，没有 rowid 可言。
 *
 * 拼法 = `workId + '/' + (season ?? -1)`，**逐字对齐后端聚合时用的那个键**
 * （notificationsRepo:127 `${r.workId}/${r.season ?? -1}`，也就是 notifications 表唯一索引
 * 的 `ON CONFLICT(work_id, ifnull(season,-1), …)` 口径）。三处同形不是巧合：它就是"一条
 * 通知"的身份。
 *
 * 为什么电影（season=null）要落到 `-1` 而不是 `'null'`/空串：与后端同形，且 `-1` 不可能
 * 与真实季号相撞。用 index 当 key 是**不行**的：刷新后组的顺序会变（latestAt 变了就往前
 * 排），index 复用会让 React 把 A 组的 DOM 状态套到 B 组身上。
 */
export function groupKey(g: Pick<FoundGroupDTO, 'workId' | 'season'>): string {
  return `${g.workId}/${g.season ?? -1}`
}

/**
 * 集号排版。后端给的是**升序** number[]（电影为空数组）。
 *
 * 连号折叠成区间：`[1,2,3,5,7,8]` → `'1–3 / 5 / 7–8'`。
 * 为什么折叠（spec 原文只写了「第 3/5/7 集」）：整季 24 集被找到时逐个列出来是
 * `1/2/3/…/24`，一条通知就占满一屏，把别的成果挤出视野——而 R-F3 明令**不做已读状态**，
 * 用户没有任何手段折叠它。折叠是排版，不改变任何事实（区间两端都是真实存在的集号）。
 *
 * 只有 2 个连号时**不折叠**（`'3 / 4'` 比 `'3–4'` 更短也更清楚，区间号在两项时是噪音）。
 * 用 en dash（–）不用 hyphen：它是范围符号的正字法，且与集号的数字宽度更协调。
 */
export function formatEpisodes(episodes: readonly number[]): string {
  if (episodes.length === 0) return ''
  const runs: number[][] = []
  for (const ep of episodes) {
    const last = runs[runs.length - 1]
    if (last && ep === last[last.length - 1]! + 1) last.push(ep)
    else runs.push([ep])
  }
  return runs
    .map((run) => (run.length >= 3 ? `${run[0]}–${run[run.length - 1]}` : run.join(' / ')))
    .join(' / ')
}

/** 本地日历日的零点（不是 UTC 零点）。"今天/昨天"是**用户所在时区**的概念——
 *  用 UTC 切分会让东八区晚上 8 点找到的字幕明天早上还显示"今天"。 */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** `latestAt` 距今几个日历日（0 = 今天，1 = 昨天，…）。**按日历日算，不是按 24 小时**：
 *  凌晨 1 点看昨晚 11 点的成果，人的直觉是"昨天"而不是"2 小时前"。
 *  未来时刻（时钟回拨/后端超前）clamp 到 0，不产生负数桶。 */
export function dayOffset(latestAt: number, now: number): number {
  const diff = startOfLocalDay(now) - startOfLocalDay(latestAt)
  return Math.max(0, Math.round(diff / 86_400_000))
}

/** `MM-DD`（本地时区）——两天前及更早的段落标题用。
 *  刻意用绝对日期而不是"3 天前"：t() 不支持插值（i18n/useT.ts 头注释明写），而拼
 *  「3 + 天前」这种碎片在中英两侧的语序都会别扭。绝对日期是语言中立的 mono 读数，
 *  同 shell/freshness.ts 那套"技术层读数不翻译"的既有先例。 */
export function formatDayStamp(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** `HH:MM`（本地时区）——每条通知右侧的时刻读数。同上，mono、不翻译。 */
export function formatClock(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 一天的段落。 */
export interface DayBucket {
  /** 距今几个日历日（0=今天）。段落标题选文案用。 */
  offset: number
  /** 该段内**任意**一条的时刻（拿来算 MM-DD 标题）——桶内同一天，取谁都一样。 */
  stampAt: number
  /** 桶内条目，**latestAt 倒序**。 */
  groups: FoundGroupDTO[]
}

/**
 * 按天分桶。**桶间倒序、桶内倒序**（R-F3「倒序流水」在前端这一侧的落点）。
 *
 * ── 为什么这里要显式排序，而不是"后端已经排好了直接铺" ──────────────────────
 * 后端的 `ORDER BY found_at DESC` 只保证**扁平序列**倒序。分桶这个动作本身会重排：
 * 用 Map 收集时桶的产生顺序确实继承输入序，但只要有人换成 `Object.keys()`（数字键会被
 * JS 引擎按升序重排）或先按日期字符串排一遍，倒序就静默翻转成正序——页面照常渲染、
 * 一条断言都不会红。故这一层自己把两级顺序钉死，并且有用例盯着（notifText.test.ts
 * 里喂**乱序输入**，断言输出仍是倒序——只有真的在排序才能通过）。
 *
 * ⚠️ **不做任何过滤**：进多少条出多少条（一周窗是后端的读窗，见文件头）。
 */
export function bucketByDay(groups: readonly FoundGroupDTO[], now: number): DayBucket[] {
  const byOffset = new Map<number, DayBucket>()
  for (const g of groups) {
    const offset = dayOffset(g.latestAt, now)
    let bucket = byOffset.get(offset)
    if (!bucket) {
      bucket = { offset, stampAt: g.latestAt, groups: [] }
      byOffset.set(offset, bucket)
    }
    bucket.groups.push(g)
    // 桶的日期戳取桶内**最新**那条——桶内条目都在同一日历日，但输入乱序时先进来的
    // 未必是最新的；取最大值让 MM-DD 与桶内容严格一致。
    if (g.latestAt > bucket.stampAt) bucket.stampAt = g.latestAt
  }
  const buckets = [...byOffset.values()]
  // 桶间：offset 小的在前（今天最上）——即时间倒序。
  buckets.sort((a, b) => a.offset - b.offset)
  // 桶内：latestAt 倒序。
  for (const b of buckets) b.groups.sort((x, y) => y.latestAt - x.latestAt)
  return buckets
}
