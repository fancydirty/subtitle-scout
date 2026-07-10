import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { SubtitleCandidate, MediaIdentity, RankDecision, MediaContext } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: null, year: 1999, type: 'movie',
  season: null, episode: null, edition: null, confidence: 0.95, evidence: [],
}
const prefs: MediaContext['preferences'] = {
  language: 'zh-Hans', prefer_bilingual: true, allow_traditional: true,
  allow_machine_translated: false, auto_download_min_confidence: 0.86,
}
const candidates: SubtitleCandidate[] = [
  { provider: 'assrt', providerId: '673114', videoName: 'The.Matrix.1999', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'a.zh.ass' }] },
  { provider: 'assrt', providerId: '606770', videoName: 'Matrix Trilogy', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'animatrix.ass' }, { index: 1, name: 'matrix1.ass' }] },
]

const base: RankDecision = {
  decision: 'download', candidate_id: 'assrt:673114', file_index: 0,
  identity_match: 'uncertain', confidence: 0.91, reasons: ['match'], rejected: [],
}

describe('runGate', () => {
  it('passes a valid download decision', () => {
    const r = runGate(base, candidates, identity, prefs)
    expect(r.ok).toBe(true)
  })
  it('rejects candidate_id not in candidate set', () => {
    const r = runGate({ ...base, candidate_id: 'assrt:999999' }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures[0]).toMatch(/candidate_id/)
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
    const r = runGate({ ...base, decision: 'no_safe_match', candidate_id: null, file_index: null }, candidates, identity, prefs)
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
    expect(r.candidate?.providerId).toBe('673114')
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
  it('confirmed still cannot bypass structural safety (hallucinated candidate_id)', () => {
    const r = runGate({ ...base, identity_match: 'confirmed', candidate_id: 'assrt:999999' }, candidates, identity, prefs)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures[0]).toMatch(/candidate_id/)
  })
})
