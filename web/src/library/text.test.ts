// web/src/library/text.test.ts
import { describe, it, expect } from 'vitest'
import { seasonCoverageSentence, formatResultCount, formatDuration } from './text.js'
import type { SeasonTally } from './episodeState.js'

function tally(p: Partial<SeasonTally>): SeasonTally {
  return { covered: 0, hardsub: 0, missing: 0, throttled: 0, error: 0, dashed: 0, partial: 0, embedded: 0, total: 0, ...p }
}

describe('seasonCoverageSentence', () => {
  it('英文：24 of 28，无 clause 时 clause 为 null', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 24, total: 28 }), 'en')
    expect(s.prefix).toBe('Season 1 has')
    expect(s.emphasis).toBe('24 of 28')
    expect(s.suffix).toBe('episodes covered')
    expect(s.clause).toBeNull()
  })

  it('中文：24 / 28', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 24, total: 28 }), 'zh')
    expect(s.prefix).toBe('第 1 季已覆盖')
    expect(s.emphasis).toBe('24 / 28')
    expect(s.suffix).toBe('集')
  })

  it('throttled + dashed 都非零时拼进 clause（英文）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 24, total: 28, throttled: 2, dashed: 2 }), 'en')
    expect(s.clause).toBe('2 throttled, 2 files missing on disk')
  })

  it('throttled + dashed 都非零时拼进 clause（中文）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 24, total: 28, throttled: 2, dashed: 2 }), 'zh')
    expect(s.clause).toBe('2 集停牌中，2 集磁盘缺档')
  })

  it('只有 throttled 时 clause 只报那一项', () => {
    const s = seasonCoverageSentence(1, tally({ throttled: 1 }), 'en')
    expect(s.clause).toBe('1 throttled')
  })

  it('hardsub assumed 非零时拼进 clause（英文）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 24, total: 28, hardsub: 3 }), 'en')
    expect(s.clause).toBe('3 hardsub assumed')
  })

  it('hardsub assumed 非零时拼进 clause（中文）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 24, total: 28, hardsub: 3 }), 'zh')
    expect(s.clause).toBe('3 集硬字幕假定')
  })

  it('embedded 非零时拼进 clause，标注覆盖里有几集是内嵌（英文）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 6, total: 6, embedded: 6 }), 'en')
    expect(s.clause).toBe('6 via embedded track')
  })

  it('embedded 非零时拼进 clause（中文）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 6, total: 6, embedded: 6 }), 'zh')
    expect(s.clause).toBe('6 集内嵌字幕')
  })

  it('embedded 与停牌等 clause 共存时按序拼接（内嵌是事实注解，殿后）', () => {
    const s = seasonCoverageSentence(1, tally({ covered: 20, total: 24, throttled: 2, embedded: 3 }), 'zh')
    expect(s.clause).toBe('2 集停牌中，3 集内嵌字幕')
  })
})

describe('formatResultCount', () => {
  it('英文单复数', () => {
    expect(formatResultCount(1, 'en')).toBe('1 title')
    expect(formatResultCount(12, 'en')).toBe('12 titles')
  })
  it('中文', () => {
    expect(formatResultCount(12, 'zh')).toBe('12 部')
  })
})

describe('formatDuration', () => {
  it('阶梯：s/m/h/d', () => {
    expect(formatDuration(30_000)).toBe('30s')
    expect(formatDuration(90_000)).toBe('1m')
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
  })
  it('负数钳制到 0', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })
})
