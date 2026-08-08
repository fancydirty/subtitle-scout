import { describe, it, expect } from 'vitest'
import { judgeSubtitle } from './subtitleJudge.js'

const DEPS = { targetLanguages: ['zh'] }

describe('judgeSubtitle（需字幕判定）', () => {
  it('英文影视 + 无内嵌 + 无 sidecar → 需要', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['jpn'], hasSidecarSubtitle: false }, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })
  it('中文影视（国产片）→ 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'zh', embeddedLangs: null, hasSidecarSubtitle: false }, DEPS,
    )).toEqual({ needs: false, reason: 'origin-skip' })
  })
  it('已有内嵌中字 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['chi', 'jpn'], hasSidecarSubtitle: false }, DEPS,
    )).toEqual({ needs: false, reason: 'embedded' })
  })
  it('已有 sidecar 中字 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: null, hasSidecarSubtitle: true }, DEPS,
    )).toEqual({ needs: false, reason: 'sidecar' })
  })
  it('多目标语言：origin_lang 是第二目标语言 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'ja', embeddedLangs: null, hasSidecarSubtitle: false },
      { targetLanguages: ['zh', 'ja'] },
    )).toEqual({ needs: false, reason: 'origin-skip' })
  })
  it('origin_lang null（TMDB 查不到）→ 不按国产片跳过，继续查内嵌/sidecar', () => {
    expect(judgeSubtitle(
      { originLang: null, embeddedLangs: null, hasSidecarSubtitle: false }, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })
})
