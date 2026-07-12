import { describe, it, expect } from 'vitest'
import { tallySeasons, statusSummary, unavailableTooltip } from './detail.js'
import type { SeriesSeasonDTO, SeriesEpisodeDTO } from '../api/types.js'

const ep = (id: string, episode: number, subStatus: SeriesEpisodeDTO['subStatus'], overrides: Partial<SeriesEpisodeDTO> = {}): SeriesEpisodeDTO =>
  ({ id, episode, name: null, subStatus, statusReason: null, recheckAfter: null, ...overrides })

const season = (episodes: SeriesEpisodeDTO[]): SeriesSeasonDTO => ({ season: 1, episodes })

describe('tallySeasons / statusSummary', () => {
  it('按态分桶计数', () => {
    const seasons = [season([ep('e1', 1, 'covered'), ep('e2', 2, 'missing'), ep('e3', 3, 'unavailable')])]
    const t = tallySeasons(seasons, false)
    expect(t.cov).toBe(1)
    expect(t.miss).toBe(1)
    expect(t.unav).toBe(1)
  })
  it('statusSummary 报告缺字幕集数', () => {
    const seasons = [season([ep('e1', 1, 'missing'), ep('e2', 2, 'missing')])]
    const summary = statusSummary(tallySeasons(seasons, false))
    expect(summary).toContain('2 集缺字幕')
  })
})

describe('unavailableTooltip', () => {
  it('原因 + 复查时间人话化', () => {
    const now = Date.now()
    const e = ep('e1', 1, 'unavailable', { statusReason: '搜索穷尽', recheckAfter: now + 1000 })
    expect(unavailableTooltip(e, now)).toContain('搜索穷尽')
  })
})
