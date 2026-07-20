import { describe, it, expect } from 'vitest'
import { SubtitleCandidateSchema, candidateKey, parseCandidateKey } from './schemas.js'

describe('SubtitleCandidate', () => {
  it('parses a minimal candidate and defaults fileList to []', () => {
    const c = SubtitleCandidateSchema.parse({ provider: 'assrt', providerId: '673114' })
    expect(c.fileList).toEqual([])
    expect(c.videoName ?? null).toBeNull()
  })
  it('rejects unknown providers', () => {
    expect(() => SubtitleCandidateSchema.parse({ provider: 'notaprovider', providerId: 'x' })).toThrow()
  })
  it('candidateKey/parseCandidateKey roundtrip', () => {
    expect(candidateKey({ provider: 'assrt', providerId: '673114' })).toBe('assrt:673114')
    expect(parseCandidateKey('opensubtitles:7174766')).toEqual({ provider: 'opensubtitles', providerId: '7174766' })
    expect(parseCandidateKey('garbage')).toBeNull()
    expect(parseCandidateKey('notaprovider:1')).toBeNull()
  })
  it('parseCandidateKey rejects malformed keys', () => {
    expect(parseCandidateKey('assrt:')).toBeNull() // 空 providerId
    expect(parseCandidateKey('')).toBeNull()
    expect(parseCandidateKey('assrt')).toBeNull() // 无冒号
  })
  it('parseCandidateKey splits on the FIRST colon: providerId may contain colons', () => {
    expect(parseCandidateKey('assrt:123:456')).toEqual({ provider: 'assrt', providerId: '123:456' })
  })
})
