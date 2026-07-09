// src/dashboard/api.test.ts
import { describe, it, expect } from 'vitest'
import { buildSummary, buildRuns, localMidnight } from './api.js'
import type { LedgerEvent } from '../core/ledger.js'

const run = (over: Partial<Extract<LedgerEvent, { type: 'run' }>>): LedgerEvent => ({
  ts: 1000, type: 'run', itemId: 'i', name: 'Movie', source: 'queue',
  decision: 'download', confidence: 0.9, subtitlePath: '/m/x.ass',
  journalPath: '/cache/journals/i-1000/decision.json', llmProfile: { mode: 'forced-tool' },
  durationMs: 100, llmCalls: 3, assrtCalls: 2, ...over,
})

describe('buildSummary', () => {
  it('counts today (>= local midnight) and window totals + queue', () => {
    const now = Date.parse('2026-07-08T12:00:00+08:00')
    const mid = localMidnight(now)
    const events: LedgerEvent[] = [
      run({ ts: mid + 3600_000, decision: 'download' }),        // today
      run({ ts: mid + 3600_000, decision: 'adopted_local' }),   // today
      run({ ts: mid - 3600_000, decision: 'download' }),        // yesterday
      run({ ts: mid + 100, decision: 'no_safe_match' }),        // today, not ready
    ]
    const s = buildSummary(events, { pending: 24, dormant: 3 }, now)
    expect(s.status).toBe('running')
    expect(s.todayReady).toBe(2)
    expect(s.totalReady).toBe(3)
    expect(s.queuePending).toBe(24)
    expect(s.queueDormant).toBe(3)
    expect(s.runsInWindow).toBe(4)
  })
})

describe('buildRuns', () => {
  it('maps run events to plain-language DTO, newest first, honoring limit', () => {
    const events: LedgerEvent[] = [
      run({ ts: 1, name: 'A', decision: 'download' }),
      run({ ts: 3, name: 'C', decision: 'no_safe_match', journalPath: '/cache/journals/c-3/decision.json' }),
      run({ ts: 2, name: 'B', decision: 'already_exists' }),
      { ts: 5, type: 'queue', event: 'enqueued', itemId: 'q', name: 'Q' }, // ignored
    ]
    const out = buildRuns(events, 2)
    expect(out.map(r => r.name)).toEqual(['C', 'B'])   // ts desc, limited to 2
    expect(out[0]).toMatchObject({ id: 'c-3', outcomeLabel: '暂时没找到合适的中文字幕', tone: 'muted', clickable: true })
  })
  it('marks runs with empty journalPath as not clickable', () => {
    const out = buildRuns([run({ ts: 1, name: 'E', decision: 'error', journalPath: '' })], 10)
    expect(out[0]).toMatchObject({ id: '', clickable: false, tone: 'fail' })
  })
})
