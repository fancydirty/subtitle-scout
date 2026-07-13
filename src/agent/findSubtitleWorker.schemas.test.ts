import { describe, it, expect } from 'vitest'
import { FindSubtitleDecisionSchema } from './findSubtitleWorker.schemas.js'

describe('FindSubtitleDecisionSchema', () => {
  it('accepts an installed decision with all fields populated', () => {
    const parsed = FindSubtitleDecisionSchema.parse({
      decision: 'installed',
      reason: 'release name and cue count match',
      installedPath: '/media/Show/Show.S01E01.zh-Hans.srt',
      installedLanguage: 'zh-Hans',
      candidateProvider: 'assrt',
      candidateProviderId: '12345',
    })
    expect(parsed.decision).toBe('installed')
  })

  it('accepts a no_safe_match decision with null install fields', () => {
    const parsed = FindSubtitleDecisionSchema.parse({
      decision: 'no_safe_match',
      reason: 'no candidate plausibly named this episode',
      installedPath: null,
      installedLanguage: null,
      candidateProvider: null,
      candidateProviderId: null,
    })
    expect(parsed.decision).toBe('no_safe_match')
  })

  it('rejects an unknown decision value', () => {
    expect(() =>
      FindSubtitleDecisionSchema.parse({
        decision: 'maybe', reason: 'x',
        installedPath: null, installedLanguage: null, candidateProvider: null, candidateProviderId: null,
      }),
    ).toThrow()
  })

  it('rejects a missing reason', () => {
    expect(() =>
      FindSubtitleDecisionSchema.parse({
        decision: 'no_safe_match',
        installedPath: null, installedLanguage: null, candidateProvider: null, candidateProviderId: null,
      }),
    ).toThrow()
  })
})
