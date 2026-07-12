import { describe, it, expect } from 'vitest'
import { runOrphanGate } from './orphanGate.js'
import type { OrphanDecision } from './schemas.js'

const orphans = [{ filename: 'a.ass', path: '/m/a.ass', sample: 's' }]
const base: OrphanDecision = { adopt: true, file: 'a.ass', language: 'zh-Hans', confidence: 0.92, reasons: ['zh content'] }

describe('runOrphanGate', () => {
  it('passes a valid adoption', () => {
    expect(runOrphanGate(base, orphans).ok).toBe(true)
  })
  it('rejects file not in scanned set', () => {
    const r = runOrphanGate({ ...base, file: 'hallucinated.ass' }, orphans)
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toMatch(/scanned/)
  })
  it('adopt=false passes through as not-ok without failures', () => {
    const r = runOrphanGate({ adopt: false, confidence: 0.3, reasons: [] }, orphans)
    expect(r.ok).toBe(false)
    expect(r.failures).toEqual([])
  })
  it('trusts the model\'s adopt=true verdict without a confidence floor', () => {
    const decision = { adopt: true, file: 'x.ass', language: 'zh-Hans' as const, confidence: 0.1, reasons: ['looks right'] }
    const r = runOrphanGate(decision, [{ path: '/m/x.ass', filename: 'x.ass', sample: '' }])
    expect(r.ok).toBe(true)
  })
})
