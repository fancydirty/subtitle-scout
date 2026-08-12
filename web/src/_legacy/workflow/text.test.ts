import { describe, it, expect } from 'vitest'
import {
  truncate, missingBadge, throttledLine, receiptChips, decisionVariant, outcomeMessageKey,
  collapseRecentRuns,
} from './text.js'
import type { DispatchReceiptsDTO, WorkflowRecentRunDTO } from '../../api/types.js'

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
      posterPath: null,
      backdropPath: null,
      llmCalls: null,
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

// 2026-08-13 补：`outcomeMessageKey` 此前被 import 却**零断言**（清理时由 noUnusedLocals
// 抓出）。它不是死代码——RerunDialog.tsx:71 在生产路径上调它把四态回执翻成人话。
// 一个映射函数没有覆盖，DESIGN.md §8 那条"四个 outcome 不许都写成 success"的纪律就没有
// 任何机械守卫：有人把 blocked_dormant 也 return 成 workflow_outcome_created，
// 前端照样绿、用户看到"已派发"而实际上什么都没派。故补这一组，而不是删 import。
describe('outcomeMessageKey（四态回执 → i18n 键 / DESIGN.md §8）', () => {
  it('四个 outcome 各自映射到自己的键', () => {
    expect(outcomeMessageKey('created')).toBe('workflow_outcome_created')
    expect(outcomeMessageKey('revived')).toBe('workflow_outcome_revived')
    expect(outcomeMessageKey('coalesced')).toBe('workflow_outcome_coalesced')
    expect(outcomeMessageKey('blocked_dormant')).toBe('workflow_outcome_blocked_dormant')
  })

  it('🔴 四个键两两不同——DESIGN.md §8：不许把四态都折叠成一句 success', () => {
    const keys = (['created', 'revived', 'coalesced', 'blocked_dormant'] as const).map(outcomeMessageKey)
    expect(new Set(keys).size).toBe(4)
  })
})
