// web/src/lib/episode.ts
// 集覆盖格子的态映射（纯函数，供详情页格子与图例、状态摘要共用）。
import type { SeriesEpisodeDTO, LibraryJobDTO } from '../api/types.js'

export type EpisodeCellState = 'cov' | 'emb' | 'miss' | 'work' | 'unav'

const CELL_LABEL: Record<EpisodeCellState, string> = {
  cov: '已补齐',
  emb: '自带中字',
  miss: '缺字幕',
  work: '处理中',
  unav: '暂时没找到（会定期复查）',
}

export function cellLabel(state: EpisodeCellState): string {
  return CELL_LABEL[state]
}

/**
 * 集态映射：sub_status 直译；当该季 job 真实在跑且该集仍未补齐（missing/unavailable），
 * 覆盖为 work（脉冲）：脉冲只在真实 in-flight。covered/embedded 已到位，不受 job 影响。
 */
export function episodeCellState(ep: SeriesEpisodeDTO, seasonJobActive: boolean): EpisodeCellState {
  if (ep.subStatus === 'covered') return 'cov'
  if (ep.subStatus === 'embedded') return 'emb'
  if (ep.subStatus === 'ignored') return 'emb' // 策略跳过：视觉等同不需处理
  if (seasonJobActive && (ep.subStatus === 'missing' || ep.subStatus === 'unavailable')) return 'work'
  if (ep.subStatus === 'unavailable') return 'unav'
  return 'miss'
}

const ACTIVE = new Set(['searching', 'downloading', 'verifying'])
export function isJobActive(job: LibraryJobDTO | { state: string } | null): boolean {
  return job != null && ACTIVE.has(job.state)
}
