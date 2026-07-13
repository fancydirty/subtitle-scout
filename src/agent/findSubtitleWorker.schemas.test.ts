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

  // Third instance of the same string-encoding class as download_candidate.fileIndex: on a
  // retry_later / no_safe_match finalize the real model emits the string "None" (or "null"/"")
  // for fields it means as null. `installedLanguage` is a NULLABLE ENUM — "None" is neither a
  // valid enum member nor JSON null, so it FAILS validation of the finalize tool's inputSchema,
  // `captured` never gets set, and readFinalized() throws (the whole run dies). The nullable
  // fields must collapse those sentinels to null before the enum/string check.
  it('collapses string null-sentinels ("None"/"null"/"") to null on nullable fields', () => {
    for (const sentinel of ['None', 'null', '', 'NONE']) {
      const parsed = FindSubtitleDecisionSchema.parse({
        decision: 'retry_later',
        reason: 'transient failure, will retry',
        installedPath: sentinel,
        installedLanguage: sentinel,
        candidateProvider: sentinel,
        candidateProviderId: sentinel,
      })
      expect(parsed.installedLanguage).toBeNull()
      expect(parsed.installedPath).toBeNull()
      expect(parsed.candidateProvider).toBeNull()
      expect(parsed.candidateProviderId).toBeNull()
    }
  })

  it('still accepts a real installedLanguage enum value and rejects a genuinely invalid one', () => {
    expect(
      FindSubtitleDecisionSchema.parse({
        decision: 'installed', reason: 'match',
        installedPath: '/media/Show/Show.S01E01.zh-Hant.srt', installedLanguage: 'zh-Hant',
        candidateProvider: 'assrt', candidateProviderId: '667241',
      }).installedLanguage,
    ).toBe('zh-Hant')
    expect(() =>
      FindSubtitleDecisionSchema.parse({
        decision: 'installed', reason: 'x',
        installedPath: null, installedLanguage: 'en', candidateProvider: null, candidateProviderId: null,
      }),
    ).toThrow()
  })
})
