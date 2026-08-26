import { describe, it, expect } from 'vitest'
import {
  languageName, tagsForLanguage, langOf,
  SELECTABLE_TARGET_LANGUAGES, LANGUAGE_NAMES, LANGUAGE_TAGS,
} from './languages.js'

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 C51 对账守卫 · 设置页选项集 ↔ 本文件两张码表
//
// 病根（opensubtitlesAdapter.ts:52-65 已点名，此处补上真正闭环的那一刀）：
// 「设置页选项集与码表之间没有对账机制」。2026-08-26 zh→pt 实案里，设置页早就能选 pt，
// 而 LANGUAGE_NAMES / LANGUAGE_TAGS 只有 zh/en/ja/ko 四条——两张表都**静默降级**
// （languageName('pt') 返回 'pt' 喂给 worker prompt；tagsForLanguage('pt') 只探 `.pt.srt`，
// 不认 por / pt-BR / pt-PT），于是既不报错也找不到字幕。
//
// 守卫的形状要求（用户裁决）：选项集必须是**共享常量**，本测试 import 它而不是重抄一份
// 十元素字面量——本仓已因「留两份漂移实现」栽过（C30 两处标签集各漏一半），再抄一份
// 只会让守卫守住抄本、守不住真值。
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 C51 language codebook reconciliation guard', () => {
  it('every selectable target language has a human-readable name (worker prompt 不许收到裸码)', () => {
    for (const code of SELECTABLE_TARGET_LANGUAGES) {
      expect(Object.keys(LANGUAGE_NAMES), `'${code}' is selectable in settings but missing from LANGUAGE_NAMES`)
        .toContain(code)
      expect(languageName(code)).not.toBe(code)
    }
  })

  it('every selectable target language has on-disk sidecar tags (磁盘探测不许只认裸 2 字母码)', () => {
    for (const code of SELECTABLE_TARGET_LANGUAGES) {
      expect(Object.keys(LANGUAGE_TAGS), `'${code}' is selectable in settings but missing from LANGUAGE_TAGS`)
        .toContain(code)
      // 只有裸码 = 落进 tagsForLanguage 的 fallback，等于没配：ISO 639-2 三字母形态探不到。
      expect(tagsForLanguage(code).length, `'${code}' only maps to its bare code — add its 3-letter form`)
        .toBeGreaterThan(1)
    }
  })

  it('两张码表不许有设置页选不到的孤儿键（反向对账，防码表堆积死条目）', () => {
    const selectable = new Set<string>(SELECTABLE_TARGET_LANGUAGES)
    for (const code of Object.keys(LANGUAGE_NAMES)) expect(selectable, `LANGUAGE_NAMES has orphan '${code}'`).toContain(code)
    for (const code of Object.keys(LANGUAGE_TAGS)) expect(selectable, `LANGUAGE_TAGS has orphan '${code}'`).toContain(code)
  })
})

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

  // C51（2026-08-26）：这条原来拿 'fr' 当「未登记语言」的样本，而 fr 从来就是设置页选项之一
  // ——码表补齐后它当然不再走 fallback。改用 'xx'（同上面 languageName fallback 那条的口径）：
  // 保险丝要挂在真正未登记的码上，否则「补齐一个设置页语言」这个正确动作会伪装成回归。
  it('falls back to [code] for an unregistered language', () => {
    expect(tagsForLanguage('xx')).toEqual(['xx'])
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
