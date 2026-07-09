import { describe, it, expect } from 'vitest'
import { parseSince, formatReport } from './report.js'
import type { LedgerEvent } from '../core/ledger.js'

describe('parseSince', () => {
  it('parses 24h and 7d relative to now', () => {
    const now = 1_000_000_000_000
    expect(parseSince('24h', now)).toBe(now - 24 * 3600_000)
    expect(parseSince('7d', now)).toBe(now - 7 * 86_400_000)
  })
  it('parses ISO dates', () => {
    expect(parseSince('2026-07-07', 0)).toBe(Date.parse('2026-07-07'))
  })
  it('throws on garbage', () => {
    expect(() => parseSince('yesterday-ish', 0)).toThrow(/since/i)
  })
})

const run = (over: Partial<Extract<LedgerEvent, { type: 'run' }>>): LedgerEvent => ({
  ts: 1000, type: 'run', itemId: 'i', name: 'Movie', source: 'queue',
  decision: 'download', confidence: 0.9, subtitlePath: null,
  journalPath: '/j/d.json', llmProfile: { mode: 'forced-tool' },
  durationMs: 100, llmCalls: 3, assrtCalls: 2, ...over,
})

describe('formatReport', () => {
  it('aggregates decisions, sources, failures, queue events, and consumption', () => {
    const events: LedgerEvent[] = [
      run({ decision: 'download', name: 'A' }),
      run({ decision: 'adopted_local', name: 'B', source: 'playback', llmCalls: 2, assrtCalls: 0 }),
      run({ decision: 'no_safe_match', name: 'C', error: null }),
      run({ decision: 'error', name: 'D', error: 'boom' }),
      { ts: 1, type: 'queue', event: 'enqueued', itemId: 'q1', name: 'E' },
      { ts: 2, type: 'queue', event: 'decayed', itemId: 'q1', name: 'E', attempts: 1 },
    ]
    const out = formatReport(events, 0, { pending: 3, dormant: 1 })
    expect(out).toContain('download: 1')
    expect(out).toContain('adopted_local: 1')
    expect(out).toContain('no_safe_match: 1')
    expect(out).toContain('error: 1')
    expect(out).toContain('C')                    // 失败明细含名字
    expect(out).toContain('/j/d.json')            // journal 指针
    expect(out).toContain('enqueued: 1')
    expect(out).toContain('pending=3')
    expect(out).toContain('LLM')                  // 资源统计段
    expect(out).toContain('ASSRT')
  })
  it('handles empty ledger', () => {
    expect(formatReport([], 0, { pending: 0, dormant: 0 })).toContain('无记录')
  })
})
