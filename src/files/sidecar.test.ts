import { describe, it, expect } from 'vitest'
import { findExternalSidecar, languageForTag, KNOWN_LANGUAGE_TAGS } from './sidecar.js'
import { tagsForLanguage } from '../agent/languages.js'

// P0(zimuku 单源大考前置,2026-07-19):BCP-47 地区变体 tag 的语言换算与探测接线。
// 区码→简繁:CN/SG=简体(zh-Hans),TW/HK=繁体(zh-Hant);小写形态=Bazarr 装机遗留惯例。
describe('languageForTag — BCP-47 地区变体', () => {
  it.each([
    ['zh-CN', 'zh-Hans'], ['zh-cn', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'], ['zh-sg', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'], ['zh-tw', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'], ['zh-hk', 'zh-Hant'],
  ])('%s → %s', (tag, lang) => {
    expect(languageForTag(tag)).toBe(lang)
  })

  it('KNOWN_LANGUAGE_TAGS(传播 EEXIST 分支的"认不认识"判据)包含全部地区变体', () => {
    for (const t of ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']) {
      expect(KNOWN_LANGUAGE_TAGS).toContain(t)
    }
  })
})

describe('findExternalSidecar × tagsForLanguage 接线(P0 生产场景)', () => {
  it('盘上只有 .zh-CN.srt(agent 白名单装机形态) → 目标含 zh 命中,语言 zh-Hans', () => {
    const disk = new Set(['/media/T/ep1.zh-CN.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-CN.srt', language: 'zh-Hans' })
  })

  it('盘上只有 .zh-cn.srt(Bazarr 遗留小写) → 同样命中', () => {
    const disk = new Set(['/media/T/ep1.zh-cn.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-cn.srt', language: 'zh-Hans' })
  })

  it('繁体区码 .zh-TW.srt → 语言换算 zh-Hant', () => {
    const disk = new Set(['/media/T/ep1.zh-TW.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-TW.srt', language: 'zh-Hant' })
  })

  it('规范形态优先:.zh-Hans.srt 与 .zh-CN.srt 并存 → 返回 zh-Hans 那份(tag 序在前)', () => {
    const disk = new Set(['/media/T/ep1.zh-Hans.srt', '/media/T/ep1.zh-CN.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit!.path).toBe('/media/T/ep1.zh-Hans.srt')
  })
})
