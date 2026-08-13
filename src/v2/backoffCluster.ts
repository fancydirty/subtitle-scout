// src/v2/backoffCluster.ts —— 「一簇文件的退避态」这两句话的**全仓唯一一份**实现。
//
// 两个工作台各有自己的退避列（字幕 `files.recheck_after` / 翻译 `files.tr_recheck_after`），
// 两条轨的**列不同、节奏不同**，但"这一簇现在会不会动 / 最早什么时候动"这两句话的
// 语义必须逐字相同——它们是同一个界面上并排的两个 tab，用户不该在两个 tab 之间
// 读到两套含义（一个 tab 的"在等"是"全簇都在等"、另一个是"至少一个在等"）。
//
// 🔴 为什么抽出来而不是各写一份（C30：两份判据必漂移）：2026-08-13 字幕台修这个洞时
// 把判据写在 subtitleScheduler 里，翻译台 2026-08-14 补同一个洞——若照抄一份，
// 以后有人把 `.some()` 改成 `.every()`（这正是下面那段论证反复警告的那个改法）
// 只会改到一处，两个 tab 静默劈叉。故这里只留一份文本，两条轨各自把自己的列喂进来。
//
// 入参刻意是**裸的时刻数组**而不是某个 Item 类型：两条轨的行结构完全不同
// （字幕是 SubtitleQueueItem.files[]，翻译是折叠前的 candidate[]），
// 让这个模块认识任何一方的类型都会把它绑死在一条轨上。

/** 这一簇现在**会不会被 daemon 取走**（至少一个文件到点）。`null` = 不在退避窗里。
 *
 *  🔴 判据是 `.some()` 而不是 `.every()`，这是这两个 helper 唯一需要论证的地方：
 *  两条轨的取件都是**逐文件**的——默认（daemon）模式下 SQL 把退避中的文件滤掉，
 *  剩一个到点的文件仍然会让这个作品当轮被领走。故"2 集在等、其中 1 集到点"这一项
 *  **现在真的会动**，说它 dueNow=false 是一句假话（用户会以为要等，实际下一轮就跑）。
 *  `.every()` 的语义是"整簇都到点"，那个问题没有任何界面在问。
 *
 *  空簇 → false：一个没有文件的"簇"不会被任何 daemon 取走，说它 dueNow=true 是假话。
 *  实际上两个调用方都不会构造空簇（簇是由至少一行折叠出来的），这里只是不留未定义行为。 */
export function clusterDueNow(recheckAts: readonly (number | null)[], now: number): boolean {
  return recheckAts.some((at) => at === null || at <= now)
}

/** 这一簇里**最早**的重试时刻；只要有任一文件已到点（即 `clusterDueNow` 为真）→ null。
 *
 *  与 dueNow 同向的收口：这一项现在就会动时，"最早 X 后重试"是一句无意义的话
 *  （它压根不在等）。两个 helper 的口径必须一致，否则界面会渲染出
 *  "现在就跑 · 16h 后重试"这种自相矛盾的副行。 */
export function clusterEarliestRetryAt(recheckAts: readonly (number | null)[], now: number): number | null {
  if (clusterDueNow(recheckAts, now)) return null
  let earliest: number | null = null
  for (const at of recheckAts) {
    if (at === null || at <= now) continue
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest
}
