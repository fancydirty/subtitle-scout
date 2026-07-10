// web/src/lib/detail.ts：详情页纯逻辑：状态摘要句 + unavailable 复查时间人话化。
import type { SeriesSeasonDTO, SeriesEpisodeDTO } from '../api/types.js'
import { episodeCellState } from './episode.js'

export interface StateTally {
  cov: number
  emb: number
  miss: number
  work: number
  unav: number
}

export function tallySeasons(seasons: SeriesSeasonDTO[], jobActive: boolean): StateTally {
  const t: StateTally = { cov: 0, emb: 0, miss: 0, work: 0, unav: 0 }
  for (const s of seasons) for (const ep of s.episodes) t[episodeCellState(ep, jobActive)]++
  return t
}

/** 冷峻状态摘要：只报存在的态。全空返回空串。 */
export function statusSummary(t: StateTally): string {
  const parts: string[] = []
  if (t.cov) parts.push(`${t.cov} 集已补齐`)
  if (t.work) parts.push(`${t.work} 集处理中`)
  if (t.miss) parts.push(`${t.miss} 集缺字幕`)
  if (t.unav) parts.push(`${t.unav} 集暂时没找到`)
  if (t.emb) parts.push(`${t.emb} 集自带中字`)
  return parts.join(' · ')
}

function ymd(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** unavailable 集的原生 title 提示：原因 + 复查时间人话化。 */
export function unavailableTooltip(ep: SeriesEpisodeDTO, now: number): string {
  const bits: string[] = []
  bits.push(ep.statusReason ?? '搜索穷尽，暂时没找到')
  if (ep.recheckAfter != null) {
    bits.push(ep.recheckAfter <= now ? '即将复查' : `${ymd(ep.recheckAfter)} 复查`)
  }
  return bits.join(' · ')
}
