import { describe, it, expect } from 'vitest'
import { SubtitleCandidateSchema, candidateKey, parseCandidateKey } from './schemas.js'

describe('SubtitleCandidate', () => {
  it('parses a minimal candidate and defaults fileList to []', () => {
    const c = SubtitleCandidateSchema.parse({ provider: 'assrt', providerId: '673114' })
    expect(c.fileList).toEqual([])
    expect(c.videoName ?? null).toBeNull()
  })
  it('rejects unknown providers', () => {
    expect(() => SubtitleCandidateSchema.parse({ provider: 'subhd', providerId: 'x' })).toThrow()
  })
  it('candidateKey/parseCandidateKey roundtrip', () => {
    expect(candidateKey({ provider: 'assrt', providerId: '673114' })).toBe('assrt:673114')
    expect(parseCandidateKey('opensubtitles:7174766')).toEqual({ provider: 'opensubtitles', providerId: '7174766' })
    expect(parseCandidateKey('garbage')).toBeNull()
    expect(parseCandidateKey('subhd:1')).toBeNull()
  })
})
