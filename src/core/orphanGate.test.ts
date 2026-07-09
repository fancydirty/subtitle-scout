import { describe, it, expect } from 'vitest'
import { runOrphanGate } from './orphanGate.js'
import type { OrphanDecision } from './schemas.js'

const orphans = [{ filename: 'a.ass', path: '/m/a.ass', sample: 's' }]
const base: OrphanDecision = { adopt: true, file: 'a.ass', language: 'zh-Hans', confidence: 0.92, reasons: ['zh content'] }

describe('runOrphanGate', () => {
  it('passes a valid adoption', () => {
    expect(runOrphanGate(base, orphans, 0.86).ok).toBe(true)
  })
  it('rejects file not in scanned set', () => {
    const r = runOrphanGate({ ...base, file: 'hallucinated.ass' }, orphans, 0.86)
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toMatch(/scanned/)
  })
  it('rejects below-threshold confidence', () => {
    expect(runOrphanGate({ ...base, confidence: 0.5 }, orphans, 0.86).ok).toBe(false)
  })
  it('adopt=false passes through as not-ok without failures', () => {
    const r = runOrphanGate({ adopt: false, confidence: 0.3, reasons: [] }, orphans, 0.86)
    expect(r.ok).toBe(false)
    expect(r.failures).toEqual([])
  })
})
