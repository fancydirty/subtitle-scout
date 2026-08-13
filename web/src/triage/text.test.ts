// web/src/triage/text.test.ts：甄别区纯函数——TimingBox / DormantBox 两区的双语动态文案。
//
// 2026-08-13：本文件原有 14 条用例覆盖 pathTail / dirnameOf / groupPending /
// fileCountLabel / moreLabel / groupParkTimeLine 六个导出，它们随 parked 族
// （PendingBox + ExcludedBox）整体删除——被测函数不存在了，用例没有降级形态可留。
// 正本论证见 web/src/triage/TriagePage.tsx 头注释的「2.5 parked 族的结局」段。
import { describe, it, expect } from 'vitest'
import { checkedAgoLine, timingRowLabel, dormantReasonLine } from './text.js'

describe('checkedAgoLine', () => {
  const NOW = 1_000_000_000_000
  it('en: checked Nh ago', () => {
    expect(checkedAgoLine(NOW - 2 * 3_600_000, NOW, 'en')).toBe('checked 2h ago')
  })
  it('zh: N小时前检查', () => {
    expect(checkedAgoLine(NOW - 2 * 3_600_000, NOW, 'zh')).toBe('2 小时前检查')
  })
})

describe('timingRowLabel', () => {
  it('媒体齐 → SeriesName SxxExx（集号补零）', () => {
    expect(timingRowLabel({ seriesName: 'Peacemaker', season: 2, episode: 3, itemId: 'it-1' })).toBe('Peacemaker S2E03')
  })
  it('任一 null → 降级 mono itemId', () => {
    expect(timingRowLabel({ seriesName: null, season: 2, episode: 3, itemId: 'it-1' })).toBe('it-1')
  })
})

describe('dormantReasonLine', () => {
  it('en', () => { expect(dormantReasonLine(5, 'en')).toBe('Failed 5 times, automatic retries stopped.') })
  it('zh', () => { expect(dormantReasonLine(5, 'zh')).toBe('失败 5 次，已停止自动重试。') })
})
