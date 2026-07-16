// web/src/workflow/time.ts：Workflow 区专属的相对时间/耗时格式化——纯函数，全部英文，故意不
// 进 i18n 表（同 shell/freshness.ts 的既有先例：技术层读数天生不需要翻译，t() 也不支持这里
// 需要的插值）。跟 library/text.ts 的 formatDuration 是同一挂算法思路，但那份要跟中文正文
// 混排（真的要双语），这里的调用点全部落在"Workflow 区永不本地化"的铁律范围内，独立一份
// 避免两个区域的格式化口径被迫耦合在一起演化。

/** 过去时刻 → 相对时长（"3d ago"/"just now"），Passes/Workers 两泳道的时间戳读数用。 */
export function relativeAgo(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** 未来时刻的倒计时——"next recheck in 3d" 式，throttled 行的复查读数用。措辞跟 Library 区
 *  EpisodeDetail 的既有先例（library_detail_next_recheck_prefix = 'next recheck in' +
 *  formatDuration）保持一致——同一个概念（停牌复查倒计时），两个区域不该各拼一套介词。
 *  deltaMs 为负（理论上不该发生：nextRecheckAt 已过期通常意味着后端下一轮巡检会把它从
 *  throttled 里摘掉，这里只做防御性 clamp，不炸渲染）时 clamp 到 0。 */
export function formatNextRecheck(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 60) return `next recheck in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `next recheck in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `next recheck in ${h}h`
  const d = Math.floor(h / 24)
  return `next recheck in ${d}d`
}

/** 工具调用耗时——mono 右对齐（"1.2s"/"840ms"），TraceRows 每行末尾读数，Inngest 式痕迹的
 *  核心技术字段。 */
export function formatTookMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
