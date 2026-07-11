// web/src/lib/detail.ts：详情页纯逻辑：状态摘要句 + unavailable/needs_review 复查时间人话化。
import type { SeriesSeasonDTO, SeriesEpisodeDTO } from '../api/types.js'
import { episodeCellState } from './episode.js'

export interface StateTally {
  cov: number
  emb: number
  miss: number
  work: number
  unav: number
  /** task 2: ask_user 找到候选待确认，独立于 unav（搜索穷尽）计数。 */
  review: number
}

export function tallySeasons(seasons: SeriesSeasonDTO[], jobActive: boolean): StateTally {
  const t: StateTally = { cov: 0, emb: 0, miss: 0, work: 0, unav: 0, review: 0 }
  for (const s of seasons) for (const ep of s.episodes) t[episodeCellState(ep, jobActive)]++
  return t
}

/** 冷峻状态摘要：只报存在的态。全空返回空串。 */
export function statusSummary(t: StateTally): string {
  const parts: string[] = []
  if (t.cov) parts.push(`${t.cov} 集已补齐`)
  if (t.work) parts.push(`${t.work} 集处理中`)
  if (t.miss) parts.push(`${t.miss} 集缺字幕`)
  if (t.review) parts.push(`${t.review} 集待确认`)
  if (t.unav) parts.push(`${t.unav} 集暂时没找到`)
  if (t.emb) parts.push(`${t.emb} 集自带中字`)
  return parts.join(' · ')
}

function ymd(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** 复查提示的公共结构：原因 + 复查时间人话化，unavailable/needs_review 共用。 */
function recheckTooltip(statusReason: string | null, recheckAfter: number | null, now: number, fallback: string): string {
  const bits: string[] = []
  bits.push(statusReason ?? fallback)
  if (recheckAfter != null) {
    bits.push(recheckAfter <= now ? '即将复查' : `${ymd(recheckAfter)} 复查`)
  }
  return bits.join(' · ')
}

/** unavailable 集的原生 title 提示：原因 + 复查时间人话化。 */
export function unavailableTooltip(ep: SeriesEpisodeDTO, now: number): string {
  return recheckTooltip(ep.statusReason, ep.recheckAfter, now, '搜索穷尽，暂时没找到')
}

/** needs_review 集的原生 title 提示（task 2）：原因（含置信数字）+ 复查时间人话化。 */
export function needsReviewTooltip(ep: SeriesEpisodeDTO, now: number): string {
  return recheckTooltip(ep.statusReason, ep.recheckAfter, now, '找到候选但把握不足，待确认')
}
