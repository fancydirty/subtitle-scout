import { describe, it, expect } from 'vitest'
import { episodeCellState, cellLabel, isJobActive } from './episode.js'
import type { SeriesEpisodeDTO } from '../api/types.js'

const ep = (subStatus: SeriesEpisodeDTO['subStatus']): SeriesEpisodeDTO =>
  ({ id: 'x', episode: 1, name: null, subStatus, statusReason: null, recheckAfter: null })

describe('episodeCellState 态映射', () => {
  it('covered → cov', () => expect(episodeCellState(ep('covered'), false)).toBe('cov'))
  it('embedded → emb', () => expect(episodeCellState(ep('embedded'), false)).toBe('emb'))
  it('ignored 视同 emb（不需处理）', () => expect(episodeCellState(ep('ignored'), false)).toBe('emb'))
  it('missing 无 job → miss', () => expect(episodeCellState(ep('missing'), false)).toBe('miss'))
  it('unavailable 无 job → unav', () => expect(episodeCellState(ep('unavailable'), false)).toBe('unav'))
  it('job 活跃时 missing → work（脉冲）', () => expect(episodeCellState(ep('missing'), true)).toBe('work'))
  it('job 活跃时 unavailable → work', () => expect(episodeCellState(ep('unavailable'), true)).toBe('work'))
  it('job 活跃不改变 covered/embedded', () => {
    expect(episodeCellState(ep('covered'), true)).toBe('cov')
    expect(episodeCellState(ep('embedded'), true)).toBe('emb')
  })
})

describe('cellLabel / isJobActive', () => {
  it('图例文案齐全', () => {
    expect(cellLabel('cov')).toBe('已补齐')
    expect(cellLabel('miss')).toBe('缺字幕')
    expect(cellLabel('unav')).toContain('复查')
  })
  it('isJobActive 仅三活跃态', () => {
    expect(isJobActive({ state: 'downloading' })).toBe(true)
    expect(isJobActive({ state: 'done' })).toBe(false)
    expect(isJobActive(null)).toBe(false)
  })
})
