import { describe, it, expect } from 'vitest'
import {
  truncate, missingBadge, throttledLine, receiptChips, decisionVariant, outcomeMessageKey,
  collapseRecentRuns,
} from './text.js'
import type { DispatchReceiptsDTO, WorkflowRecentRunDTO } from '../api/types.js'

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

describe('collapseRecentRuns（Activity 流连续重试折叠：同 jobId 同 decision 的连续行只保留一条，count=折叠数量）', () => {
  function row(overrides: Partial<WorkflowRecentRunDTO> & { id: number; jobId: number; decision: string }): WorkflowRecentRunDTO {
    return {
      detail: null,
      finishedAt: 1_700_000_000_000 - overrides.id * 60_000,
      seriesId: 's1',
      movieId: null,
      seriesName: 'Silo',
      movieName: null,
      ...overrides,
    }
  }

  it('12 条同 job 同 decision → 1 条 count 12（row=最新那条）', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: i + 1, jobId: 46, decision: 'error' }))
    const folded = collapseRecentRuns(rows)
    expect(folded).toHaveLength(1)
    expect(folded[0].count).toBe(12)
    expect(folded[0].row.id).toBe(1)
  })

  it('A,A,B,A → 三段（2,1,1），交错不跨段折叠', () => {
    const rows = [
      row({ id: 1, jobId: 1, decision: 'error' }),
      row({ id: 2, jobId: 1, decision: 'error' }),
      row({ id: 3, jobId: 1, decision: 'installed' }),
      row({ id: 4, jobId: 1, decision: 'error' }),
    ]
    const folded = collapseRecentRuns(rows)
    expect(folded.map((f) => f.count)).toEqual([2, 1, 1])
    expect(folded[0].row.id).toBe(1)
    expect(folded[1].row.id).toBe(3)
    expect(folded[2].row.id).toBe(4)
  })

  it('不同 jobId 但同 decision 不折叠', () => {
    const rows = [
      row({ id: 1, jobId: 1, decision: 'error' }),
      row({ id: 2, jobId: 2, decision: 'error' }),
    ]
    const folded = collapseRecentRuns(rows)
    expect(folded.map((f) => f.count)).toEqual([1, 1])
  })

  it('空数组 → 空数组', () => {
    expect(collapseRecentRuns([])).toEqual([])
  })

  it('单行 → 1 条 count 1', () => {
    const rows = [row({ id: 1, jobId: 1, decision: 'error' })]
    const folded = collapseRecentRuns(rows)
    expect(folded).toHaveLength(1)
    expect(folded[0].count).toBe(1)
  })
})
