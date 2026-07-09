import { describe, it, expect } from 'vitest'
import { mkdtempSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger, type LedgerEvent } from './ledger.js'

const file = () => join(mkdtempSync(join(tmpdir(), 'led-')), 'ledger.jsonl')

const runEvent: LedgerEvent = {
  ts: 1000, type: 'run', itemId: 'i1', name: 'Movie', source: 'queue',
  decision: 'download', confidence: 0.9, subtitlePath: '/m/x.ass',
  journalPath: '/j/decision.json', llmProfile: { mode: 'forced-tool' },
  durationMs: 1234, llmCalls: 3, assrtCalls: 2,
}

describe('Ledger', () => {
  it('appends and reads back events', () => {
    const l = new Ledger(file())
    l.append(runEvent)
    l.append({ ts: 2000, type: 'queue', event: 'enqueued', itemId: 'i2', name: 'M2' })
    const r = l.read(0)
    expect(r.events.length).toBe(2)
    expect(r.events[0]).toMatchObject({ type: 'run', decision: 'download' })
    expect(r.badLines).toBe(0)
  })
  it('read filters by since timestamp', () => {
    const l = new Ledger(file())
    l.append(runEvent)                                    // ts 1000
    l.append({ ...runEvent, ts: 5000 })
    expect(l.read(2000).events.length).toBe(1)
  })
  it('skips corrupt lines and counts them', () => {
    const f = file()
    const l = new Ledger(f)
    l.append(runEvent)
    appendFileSync(f, '{corrupt json\n')
    appendFileSync(f, '{"ts":1,"type":"nonsense"}\n')     // schema 不认
    l.append({ ...runEvent, ts: 9000 })
    const r = l.read(0)
    expect(r.events.length).toBe(2)
    expect(r.badLines).toBe(2)
  })
  it('read on missing file returns empty', () => {
    const l = new Ledger(join(mkdtempSync(join(tmpdir(), 'led-')), 'nope.jsonl'))
    expect(l.read(0)).toEqual({ events: [], badLines: 0 })
  })
})
