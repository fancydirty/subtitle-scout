// web/src/lib/detail.test.ts
// task 2: needs_review 需要进入 tallySeasons/statusSummary/needsReviewTooltip，
// 之前只有 unavailable 有对应的复查提示函数——之前该文件没有专属单测，借这次一并补上。
import { describe, it, expect } from 'vitest'
import { tallySeasons, statusSummary, unavailableTooltip, needsReviewTooltip } from './detail.js'
import type { SeriesSeasonDTO, SeriesEpisodeDTO } from '../api/types.js'

const ep = (id: string, episode: number, subStatus: SeriesEpisodeDTO['subStatus'], overrides: Partial<SeriesEpisodeDTO> = {}): SeriesEpisodeDTO =>
  ({ id, episode, name: null, subStatus, statusReason: null, recheckAfter: null, ...overrides })

const season = (episodes: SeriesEpisodeDTO[]): SeriesSeasonDTO => ({ season: 1, episodes })

describe('tallySeasons / statusSummary：needs_review 计入独立桶', () => {
  it('needs_review 计入 review 桶，不与 miss/unav 混同', () => {
    const seasons = [season([ep('e1', 1, 'needs_review'), ep('e2', 2, 'missing'), ep('e3', 3, 'unavailable')])]
    const t = tallySeasons(seasons, false)
    expect(t.review).toBe(1)
    expect(t.miss).toBe(1)
    expect(t.unav).toBe(1)
  })

  it('job 活跃时 needs_review 计入 work 桶（同 miss/unav 的活跃语义）', () => {
    const seasons = [season([ep('e1', 1, 'needs_review')])]
    const t = tallySeasons(seasons, true)
    expect(t.work).toBe(1)
    expect(t.review).toBe(0)
  })

  it('statusSummary 报告待确认集数', () => {
    const seasons = [season([ep('e1', 1, 'needs_review'), ep('e2', 2, 'needs_review')])]
    const summary = statusSummary(tallySeasons(seasons, false))
    expect(summary).toContain('2 集待确认')
  })
})

describe('needsReviewTooltip：结构对称于 unavailableTooltip', () => {
  it('原因 + 复查时间人话化', () => {
    const now = Date.now()
    const e = ep('e1', 1, 'needs_review', { statusReason: '找到候选但把握不足（置信 0.62 < 0.75）', recheckAfter: now + 86_400_000 })
    const tip = needsReviewTooltip(e, now)
    expect(tip).toContain('置信 0.62')
    expect(tip).toContain('复查')
  })
  it('无 statusReason 时兜底默认文案', () => {
    const now = Date.now()
    const e = ep('e1', 1, 'needs_review', { recheckAfter: null })
    expect(needsReviewTooltip(e, now)).toContain('待确认')
  })
  it('unavailableTooltip 行为不变（回归）', () => {
    const now = Date.now()
    const e = ep('e1', 1, 'unavailable', { statusReason: '搜索穷尽', recheckAfter: now + 1000 })
    expect(unavailableTooltip(e, now)).toContain('搜索穷尽')
  })
})
