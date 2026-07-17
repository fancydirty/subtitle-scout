import { describe, it, expect } from 'vitest'
import {
  truncate, missingBadge, throttledLine, receiptChips, decisionVariant, outcomeMessageKey,
} from './text.js'
import type { DispatchReceiptsDTO } from '../api/types.js'

describe('truncate', () => {
  it('短字符串原样返回', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })
  it('超长字符串截断并加省略号', () => {
    expect(truncate('a'.repeat(10), 5)).toBe('aaaa…')
  })
})

describe('missingBadge', () => {
  it('拼出 "{n} missing"', () => {
    expect(missingBadge(5)).toBe('5 missing')
    expect(missingBadge(1)).toBe('1 missing')
  })
})

describe('throttledLine（DESIGN.md §8：throttled 显示原因+next recheck，不许渲染成失败）', () => {
  const NOW = 1_700_000_000_000
  it('throttled<=0 → null（不渲染这一行）', () => {
    expect(throttledLine(0, null, NOW)).toBeNull()
    expect(throttledLine(-1, null, NOW)).toBeNull()
  })
  it('throttled>0 且有 nextRecheckAt → "{n} throttled · next recheck in {相对}"', () => {
    expect(throttledLine(2, NOW + 3 * 24 * 60 * 60_000, NOW)).toBe('2 throttled · next recheck in 3d')
  })
  it('throttled>0 但 nextRecheckAt 缺失（防御性兜底）→ 只给计数', () => {
    expect(throttledLine(2, null, NOW)).toBe('2 throttled')
  })
})

describe('receiptChips（非零才显示，unknown → "N unparsed"）', () => {
  it('全零 → 空数组', () => {
    const r: DispatchReceiptsDTO = { created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 }
    expect(receiptChips(r)).toEqual([])
  })
  it('非零按固定顺序出现，unknown 显示为 "unparsed"', () => {
    const r: DispatchReceiptsDTO = { created: 3, revived: 0, coalesced: 1, blocked_dormant: 0, unknown: 1 }
    expect(receiptChips(r)).toEqual(['3 created', '1 coalesced', '1 unparsed'])
  })
  it('blocked_dormant 显示为 "blocked"', () => {
    const r: DispatchReceiptsDTO = { created: 0, revived: 0, coalesced: 0, blocked_dormant: 2, unknown: 0 }
    expect(receiptChips(r)).toEqual(['2 blocked'])
  })
})

describe('decisionVariant（排队/中性=灰铁律，DESIGN.md §2）', () => {
  it('installed → success', () => {
    expect(decisionVariant('installed')).toBe('success')
  })
  it('error → error', () => {
    expect(decisionVariant('error')).toBe('error')
  })
  it('no_safe_match/retry_later/null 都是 neutral（灰）', () => {
    expect(decisionVariant('no_safe_match')).toBe('neutral')
    expect(decisionVariant('retry_later')).toBe('neutral')
    expect(decisionVariant(null)).toBe('neutral')
  })
})

describe('outcomeMessageKey（四态各自一个键）', () => {
  it('四态各不相同', () => {
    const keys = new Set([
      outcomeMessageKey('created'),
      outcomeMessageKey('revived'),
      outcomeMessageKey('coalesced'),
      outcomeMessageKey('blocked_dormant'),
    ])
    expect(keys.size).toBe(4)
  })
})
