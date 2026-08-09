import { describe, it, expect } from 'vitest'
import { judgeSubtitle } from './subtitleJudge.js'

const DEPS = { targetLanguages: ['zh'] }

describe('judgeSubtitle（需字幕判定）', () => {
  it('英文影视 + 无内嵌 → 需要', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['jpn'] }, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })
  it('中文影视（国产片）→ 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'zh', embeddedLangs: null }, DEPS,
    )).toEqual({ needs: false, reason: 'origin-skip' })
  })
  it('已有内嵌中字 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['chi', 'jpn'] }, DEPS,
    )).toEqual({ needs: false, reason: 'embedded' })
  })
  it('多目标语言：origin_lang 是第二目标语言 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'ja', embeddedLangs: null },
      { targetLanguages: ['zh', 'ja'] },
    )).toEqual({ needs: false, reason: 'origin-skip' })
  })
  it('origin_lang null（TMDB 查不到）→ 不按国产片跳过，继续查内嵌', () => {
    expect(judgeSubtitle(
      { originLang: null, embeddedLangs: null }, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })

  // D8 职责切分（C27）：判据只有**语言事实**（origin_lang / 内嵌轨）。
  // 磁盘上当前有没有外挂字幕是 sub_status 的事，由扫描独占写入（R24）。
  // 两列都判 sidecar 会造出 needs_subtitle=0 + sub_status=NULL 的永久卡死态：
  // judge 谓词是 `needs_subtitle IS NULL`（不会重判它）、字幕工作台谓词是 `needs_subtitle=1`
  // （不会排它）→ 用户手删字幕后这一集再也不会被补。
  it('🔴 C27：judge 的入参里没有"磁盘有没有外挂字幕"这个事实', () => {
    // 类型层面已经删掉了 hasSidecarSubtitle；这条钉住**运行时**也不许从别处偷偷读到它。
    // 传一个多余字段进去（模拟未来某个调用方"顺手又塞回来"）也不得改变判决。
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: null, hasSidecarSubtitle: true } as any, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })
  it('🔴 C27：磁盘有外挂中字也不影响国产片/内嵌轨这两条规则', () => {
    expect(judgeSubtitle(
      { originLang: 'zh', embeddedLangs: null, hasSidecarSubtitle: true } as any, DEPS,
    )).toEqual({ needs: false, reason: 'origin-skip' })
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['chi'], hasSidecarSubtitle: true } as any, DEPS,
    )).toEqual({ needs: false, reason: 'embedded' })
  })
})
