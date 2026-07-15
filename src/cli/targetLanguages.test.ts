import { describe, it, expect } from 'vitest'
import { parseTargetLanguages, resolveTargetLanguages } from './targetLanguages.js'

describe('parseTargetLanguages', () => {
  it('defaults to [\'zh\'] when unset', () => {
    expect(parseTargetLanguages(undefined)).toEqual(['zh'])
  })

  it('defaults to [\'zh\'] for an empty string', () => {
    expect(parseTargetLanguages('')).toEqual(['zh'])
  })

  it('splits a comma-separated list', () => {
    expect(parseTargetLanguages('zh,en')).toEqual(['zh', 'en'])
  })

  it('trims whitespace around entries', () => {
    expect(parseTargetLanguages(' zh , en ')).toEqual(['zh', 'en'])
  })

  it('drops empty entries from stray/trailing commas', () => {
    expect(parseTargetLanguages('zh,,en,')).toEqual(['zh', 'en'])
  })

  it('falls back to [\'zh\'] when every entry is empty after trimming', () => {
    expect(parseTargetLanguages(' , , ')).toEqual(['zh'])
  })

  it('a single non-zh language is honored as-is (no implicit zh)', () => {
    expect(parseTargetLanguages('en')).toEqual(['en'])
  })
})

describe('resolveTargetLanguages (TARGET_LANGUAGES + legacy SKIP_CHINESE_ORIGIN compat: two-concept split)', () => {
  // targetLanguages = which subtitle languages we hunt/count as coverage (scanner rules 2/3,
  // task construction). originSkipLanguages = which origin-audio languages suppress an item
  // (scanner rule 0/1/1b). SKIP_CHINESE_ORIGIN=false only ever weakens the SKIP side — it must
  // never stop zh from being a coverage target (that was the pre-A4 semantics: the flag never
  // affected embedded/sidecar zh detection).

  it('default env (both unset) → both lists [\'zh\'] — byte-compatible with pre-A4 skipChineseOrigin:true', () => {
    expect(resolveTargetLanguages({})).toEqual({ targetLanguages: ['zh'], originSkipLanguages: ['zh'] })
  })

  it('SKIP_CHINESE_ORIGIN unset + explicit TARGET_LANGUAGES → both lists mirror it unchanged', () => {
    expect(resolveTargetLanguages({ TARGET_LANGUAGES: 'zh,en' }))
      .toEqual({ targetLanguages: ['zh', 'en'], originSkipLanguages: ['zh', 'en'] })
  })

  it('SKIP_CHINESE_ORIGIN=true (explicit) is a no-op, same as unset', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'true' }))
      .toEqual({ targetLanguages: ['zh'], originSkipLanguages: ['zh'] })
  })

  it('SKIP_CHINESE_ORIGIN=false + default TARGET_LANGUAGES (zh): zh stays a coverage TARGET but is dropped from the origin-skip list (historical opt-out: Chinese-origin content still gets zh subtitle tasks, and existing zh subtitles still count as covered)', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false' }))
      .toEqual({ targetLanguages: ['zh'], originSkipLanguages: [] })
  })

  it('SKIP_CHINESE_ORIGIN=false + TARGET_LANGUAGES=zh,en → only the origin-skip list loses zh; en skipping unaffected', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false', TARGET_LANGUAGES: 'zh,en' }))
      .toEqual({ targetLanguages: ['zh', 'en'], originSkipLanguages: ['en'] })
  })

  it('the "genuinely ambiguous" case: SKIP_CHINESE_ORIGIN=false + TARGET_LANGUAGES=en (zh not even a target) → no-op, least-surprising reading is "nothing to opt out of"', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false', TARGET_LANGUAGES: 'en' }))
      .toEqual({ targetLanguages: ['en'], originSkipLanguages: ['en'] })
  })

  it('any value other than the literal string "false" counts as SKIP_CHINESE_ORIGIN=true (matches the old `!== \'false\'` parsing)', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'nope' }))
      .toEqual({ targetLanguages: ['zh'], originSkipLanguages: ['zh'] })
  })

  it('targetLanguages is never emptied by the flag — a defined primary target always exists (task construction relies on targetLanguages[0])', () => {
    const { targetLanguages } = resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false', TARGET_LANGUAGES: 'zh' })
    expect(targetLanguages.length).toBeGreaterThan(0)
    expect(targetLanguages[0]).toBe('zh')
  })
})
