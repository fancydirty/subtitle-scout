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

describe('resolveTargetLanguages (TARGET_LANGUAGES + legacy SKIP_CHINESE_ORIGIN compat)', () => {
  it('default env (both unset) → [\'zh\'] — byte-compatible with pre-A4 skipChineseOrigin:true', () => {
    expect(resolveTargetLanguages({})).toEqual(['zh'])
  })

  it('SKIP_CHINESE_ORIGIN unset + explicit TARGET_LANGUAGES → passed through unchanged', () => {
    expect(resolveTargetLanguages({ TARGET_LANGUAGES: 'zh,en' })).toEqual(['zh', 'en'])
  })

  it('SKIP_CHINESE_ORIGIN=true (explicit) is a no-op, same as unset', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'true' })).toEqual(['zh'])
  })

  it('SKIP_CHINESE_ORIGIN=false + default TARGET_LANGUAGES (zh) → drops zh, leaving the gate fully disabled (historical opt-out: Chinese-origin content still gets zh subtitle tasks)', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false' })).toEqual([])
  })

  it('SKIP_CHINESE_ORIGIN=false + TARGET_LANGUAGES=zh,en → drops only zh, en is untouched', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false', TARGET_LANGUAGES: 'zh,en' })).toEqual(['en'])
  })

  it('the "genuinely ambiguous" case: SKIP_CHINESE_ORIGIN=false + TARGET_LANGUAGES=en (zh not even a target) → no-op, least-surprising reading is "nothing to opt out of"', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'false', TARGET_LANGUAGES: 'en' })).toEqual(['en'])
  })

  it('any value other than the literal string "false" counts as SKIP_CHINESE_ORIGIN=true (matches the old `!== \'false\'` parsing)', () => {
    expect(resolveTargetLanguages({ SKIP_CHINESE_ORIGIN: 'nope' })).toEqual(['zh'])
  })
})
