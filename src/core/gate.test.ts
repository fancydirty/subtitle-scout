import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { SubtitleCandidate, MediaIdentity, RankDecision } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: null, year: 1999, type: 'movie',
  season: null, episode: null, edition: null, confidence: 0.95, evidence: [],
}
const candidates: SubtitleCandidate[] = [
  { provider: 'assrt', providerId: '673114', videoName: 'The.Matrix.1999', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'a.zh.ass' }] },
  { provider: 'assrt', providerId: '606770', videoName: 'Matrix Trilogy', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'animatrix.ass' }, { index: 1, name: 'matrix1.ass' }] },
]

const rankWith = (order: RankDecision['order']): RankDecision => ({ order, rejected: [], reasons: [] })

describe('runGate', () => {
  it('builds a one-item queue from a valid order', () => {
    const r = runGate(rankWith([{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' }]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.decision).toBe('proceed')
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('673114')
    expect(r.queue[0].fileIndex).toBe(0)
    expect(r.queue[0].identityMatch).toBe('confirmed')
  })

  it('keeps both confirmed and uncertain candidates in the queue, preserving order', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain', reason: 'no season/episode signal' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue.map(q => q.candidate.providerId)).toEqual(['673114', '606770'])
  })

  it('drops a mismatch entry defensively even if rank disobeys the prompt and includes it', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'mismatch', reason: 'wrong film' },
    ]), candidates, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/mismatch/i)
    expect(r.queue).toEqual([])
  })

  it('skips an unresolvable candidate_id but keeps trying the rest of the order (fail-soft per item)', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:999999', file_index: 0, identity_match: 'confirmed', reason: 'x' },
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'y' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('673114')
    expect(r.failures[0]).toMatch(/candidate_id/)
  })

  it('skips an out-of-range file_index for one item without failing the whole gate', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 5, identity_match: 'confirmed', reason: 'x' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'confirmed', reason: 'y' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('606770')
  })

  it('empty fileList tolerates file_index null or 0, rejects >0', () => {
    const noFiles: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '7174766', videoName: 'The.Matrix.1999',
      nativeName: null, language: 'zh-CN', subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }
    const pool = [...candidates, noFiles]
    const ok = runGate(rankWith([{ candidate_id: 'opensubtitles:7174766', file_index: null, identity_match: 'uncertain', reason: 'x' }]), pool, identity)
    expect(ok.ok).toBe(true)
    const bad = runGate(rankWith([{ candidate_id: 'opensubtitles:7174766', file_index: 2, identity_match: 'uncertain', reason: 'x' }]), pool, identity)
    expect(bad.ok).toBe(false)
    expect(bad.decision).toBe('no_safe_match')
  })

  it('empty order → no_safe_match with an explanatory failure', () => {
    const r = runGate(rankWith([]), candidates, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.length).toBeGreaterThan(0)
  })

  it('self-heals a bare providerId (model dropped the provider prefix)', () => {
    const r = runGate(rankWith([{ candidate_id: '673114', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue[0].candidate.providerId).toBe('673114')
  })

  it('a bare providerId colliding across providers is skipped as ambiguous', () => {
    const pool: SubtitleCandidate[] = [
      { provider: 'assrt', providerId: '123', videoName: 'ASSRT Video', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] },
      { provider: 'opensubtitles', providerId: '123', videoName: 'OpenSubtitles Video', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] },
    ]
    const r = runGate(rankWith([{ candidate_id: '123', file_index: null, identity_match: 'confirmed', reason: 'x' }]), pool, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/ambiguous/i)
  })

  it('dedups the queue by resolved candidate identity + fileIndex, keeping first occurrence (quota protection: no double-download/double-verify)', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' },
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'literal duplicate order row' },
      { candidate_id: '673114', file_index: 0, identity_match: 'confirmed', reason: 'bare id self-heals to the same candidate' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain', reason: 'second, distinct candidate' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(2)
    expect(r.queue.map(q => q.candidate.providerId)).toEqual(['673114', '606770'])
    // first-occurrence reason preserved, not overwritten by the later duplicate rows
    expect(r.queue[0].identityMatch).toBe('confirmed')
  })

  it('episode media without resolved season/episode fails closed regardless of order contents', () => {
    const epIdentity: MediaIdentity = { ...identity, type: 'episode', season: null, episode: 3 }
    const r = runGate(rankWith([{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), candidates, epIdentity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.queue).toEqual([])
  })
})
