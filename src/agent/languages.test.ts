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
  it('zh maps to the historical Chinese sidecar tag set plus BCP-47 region variants', () => {
    expect(tagsForLanguage('zh')).toEqual([
      'zh-Hans', 'zh-Hant', 'zh', 'chs', 'cht', 'chi', 'zho',
      'zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg',
    ])
  })

  it('P0(zimuku大考): 地区变体两种大小写形态都必须在探测集内——探测机制是构造路径后 fileExists,大小写敏感 FS 上只能显式枚举(zh-CN=agent白名单装机形态,zh-cn=Bazarr遗留惯例)', () => {
    const tags = tagsForLanguage('zh')
    for (const t of ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']) {
      expect(tags).toContain(t)
    }
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
