import { describe, it, expect } from 'vitest'
import { translateTimeoutMs, sourceLangDisplayName } from './translateItemCommand.js'

// 真机逼出(F1 验收):34-cue 大批经慢端点 120s(LLM_TIMEOUT_MS)必然超时 → 整档 false-held。
// 翻译批的超时独立可配且默认更宽(300s),不与 captcha 等快路径共享 120s。
describe('translateTimeoutMs — 翻译批超时可配', () => {
  it('未配 TRANSLATE_TIMEOUT_MS → 默认 300s(大批慢端点容忍)', () => {
    expect(translateTimeoutMs({})).toBe(300_000)
  })

  it('配了合法毫秒数 → 用之', () => {
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: '600000' })).toBe(600_000)
  })

  it('脏值(非数字/零/负) → 回退默认 300s', () => {
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: 'abc' })).toBe(300_000)
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: '0' })).toBe(300_000)
    expect(translateTimeoutMs({ TRANSLATE_TIMEOUT_MS: '-5' })).toBe(300_000)
  })
})

describe('sourceLangDisplayName — F2 prompt 源语言名', () => {
  it('en → 英文;ja/jpn → 日文;缺省 → 英文;未知 → 源语言', () => {
    expect(sourceLangDisplayName('en')).toBe('英文')
    expect(sourceLangDisplayName('en-US')).toBe('英文')
    expect(sourceLangDisplayName('ja')).toBe('日文')
    expect(sourceLangDisplayName('jpn')).toBe('日文')
    expect(sourceLangDisplayName(null)).toBe('英文')
    expect(sourceLangDisplayName(undefined)).toBe('英文')
    expect(sourceLangDisplayName('ko')).toBe('源语言')
  })
})
