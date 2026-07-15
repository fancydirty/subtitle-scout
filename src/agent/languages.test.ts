import { describe, it, expect } from 'vitest'
import { languageName, tagsForLanguage } from './languages.js'

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
