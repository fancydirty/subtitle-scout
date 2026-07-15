import { describe, it, expect } from 'vitest'
import { languageName, tagsForLanguage, langOf } from './languages.js'

describe('languageName', () => {
  it('resolves zh to Chinese', () => {
    expect(languageName('zh')).toBe('Chinese')
  })

  it('resolves en to English', () => {
    expect(languageName('en')).toBe('English')
  })

  it('falls back to the raw code for an unknown language', () => {
    expect(languageName('xx')).toBe('xx')
  })
})

describe('tagsForLanguage', () => {
  it('zh maps to the historical Chinese sidecar tag set', () => {
    expect(tagsForLanguage('zh')).toEqual(['zh-Hans', 'zh-Hant', 'zh', 'chs', 'cht', 'chi', 'zho'])
  })

  it('en maps to en/eng', () => {
    expect(tagsForLanguage('en')).toEqual(['en', 'eng'])
  })

  it('falls back to [code] for an unregistered language', () => {
    expect(tagsForLanguage('fr')).toEqual(['fr'])
  })
})

describe('langOf', () => {
  it('normalizes bare zh', () => {
    expect(langOf('zh')).toBe('zh')
  })

  it('normalizes the historical TMDB alias cn', () => {
    expect(langOf('cn')).toBe('zh')
  })

  it('normalizes ISO 639-2 chi/zho and ISO 639-3 cmn', () => {
    expect(langOf('chi')).toBe('zh')
    expect(langOf('zho')).toBe('zh')
    expect(langOf('cmn')).toBe('zh')
  })

  it('drops a region/script suffix before matching', () => {
    expect(langOf('zh-CN')).toBe('zh')
    expect(langOf('zh_TW')).toBe('zh')
  })

  it('passes through a plain non-Chinese code unchanged (lowercased)', () => {
    expect(langOf('en')).toBe('en')
    expect(langOf('JA')).toBe('ja')
  })

  it('returns empty string for null/undefined (never accidentally matches a real target)', () => {
    expect(langOf(null)).toBe('')
    expect(langOf(undefined)).toBe('')
  })
})
