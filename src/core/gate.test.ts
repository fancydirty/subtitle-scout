import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { AssrtSub, MediaIdentity, RankDecision, MediaContext } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: null, year: 1999, type: 'movie',
  season: null, episode: null, edition: null, confidence: 0.95, evidence: [],
}
const prefs: MediaContext['preferences'] = {
  language: 'zh-Hans', prefer_bilingual: true, allow_traditional: true,
  allow_machine_translated: false, auto_download_min_confidence: 0.86,
}
const candidates = [
  { id: 673114, videoname: 'The.Matrix.1999', filelist: [{ f: 'a.zh.ass' }] },
  { id: 606770, videoname: 'Matrix Trilogy', filelist: [{ f: 'animatrix.ass' }, { f: 'matrix1.ass' }] },
] as unknown as AssrtSub[]

const base: RankDecision = {
  decision: 'download', assrt_id: 673114, file_index: 0,
  identity_match: 'uncertain', confidence: 0.91, reasons: ['match'], rejected: [],
}

describe('runGate', () => {
  it('passes a valid download decision', () => {
    const r = runGate(base, candidates, identity, prefs)
    expect(r.ok).toBe(true)
  })
  it('rejects assrt_id not in candidate set', () => {
    const r = runGate({ ...base, assrt_id: 999999 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures[0]).toMatch(/assrt_id/)
  })
  it('rejects out-of-range file_index', () => {
    const r = runGate({ ...base, file_index: 5 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.failures[0]).toMatch(/file_index/)
  })
  it('downgrades to ask_user below confidence threshold', () => {
    const r = runGate({ ...base, confidence: 0.7 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('ask_user')
  })
  it('passes through non-download decisions untouched', () => {
    const r = runGate({ ...base, decision: 'no_safe_match', assrt_id: null, file_index: null }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures).toEqual([])
  })
})

describe('runGate — identity verdict', () => {
  it('confirmed downloads even when scalar confidence is far below threshold', () => {
    const r = runGate({ ...base, identity_match: 'confirmed', confidence: 0.5 }, candidates, identity, prefs)
    expect(r.ok).toBe(true)
    expect(r.decision).toBe('download')
    expect(r.candidate?.id).toBe(673114)
  })
  it('mismatch rejects to no_safe_match even when scalar confidence is very high', () => {
    const r = runGate({ ...base, identity_match: 'mismatch', confidence: 0.99 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/mismatch/i)
  })
  it('uncertain + high confidence downloads via legacy scalar gate', () => {
    const r = runGate({ ...base, identity_match: 'uncertain', confidence: 0.91 }, candidates, identity, prefs)
    expect(r.ok).toBe(true)
    expect(r.decision).toBe('download')
  })
  it('uncertain + low confidence falls back to ask_user via legacy scalar gate', () => {
    const r = runGate({ ...base, identity_match: 'uncertain', confidence: 0.7 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('ask_user')
  })
  it('confirmed still cannot bypass structural safety (hallucinated assrt_id)', () => {
    const r = runGate({ ...base, identity_match: 'confirmed', assrt_id: 999999 }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures[0]).toMatch(/assrt_id/)
  })
})
