import { describe, it, expect } from 'vitest'
import type { ProviderRowDTO } from '../../api/types.js'
import { visibleKeyedSourceIds, freeStepSkipped, wizardSourceVisible } from './derive.js'

const row = (id: ProviderRowDTO['id'], kind: 'infra' | 'source', languages: '*' | string[] | null): ProviderRowDTO =>
  ({ id, kind, languages, secrets: [], lastTest: null, quota: null })
const ROWS: ProviderRowDTO[] = [
  row('tmdb', 'infra', null), row('llm', 'infra', null), row('translate', 'infra', null),
  row('assrt', 'source', ['zh']), row('opensubtitles', 'source', '*'), row('jimaku', 'source', ['ja']),
  row('subhd', 'source', ['zh']), row('zimuku', 'source', ['zh']),
  row('r3sub', 'source', ['zh']), row('subdl', 'source', '*'),
]

describe('visibleKeyedSourceIds（keyed 源步分流）', () => {
  it('zh → ASSRT/OS/r3sub/SubDL，无 jimaku', () => {
    expect(visibleKeyedSourceIds({ targetLanguages: 'zh', providerRows: ROWS }))
      .toEqual(['assrt', 'opensubtitles', 'r3sub', 'subdl'])
  })
  it('ja → OS/Jimaku/SubDL', () => {
    expect(visibleKeyedSourceIds({ targetLanguages: 'ja', providerRows: ROWS }))
      .toEqual(['opensubtitles', 'jimaku', 'subdl'])
  })
  it('en/其他 → OS/SubDL', () => {
    expect(visibleKeyedSourceIds({ targetLanguages: 'en', providerRows: ROWS }))
      .toEqual(['opensubtitles', 'subdl'])
    expect(visibleKeyedSourceIds({ targetLanguages: 'fr', providerRows: ROWS }))
      .toEqual(['opensubtitles', 'subdl'])
  })
  it('rows 未到 / 语言未选 → fail-open 全员', () => {
    expect(visibleKeyedSourceIds({ targetLanguages: 'ja', providerRows: null })).toHaveLength(5)
    expect(visibleKeyedSourceIds({ targetLanguages: null, providerRows: ROWS })).toHaveLength(5)
  })
})

describe('freeStepSkipped（开关源步整步跳过）', () => {
  it('zh → 不跳（subhd/zimuku 在场）', () => {
    expect(freeStepSkipped({ targetLanguages: 'zh', providerRows: ROWS })).toBe(false)
  })
  it('ja / en → 跳（两家都不命中）', () => {
    expect(freeStepSkipped({ targetLanguages: 'ja', providerRows: ROWS })).toBe(true)
    expect(freeStepSkipped({ targetLanguages: 'en', providerRows: ROWS })).toBe(true)
  })
  it('证据不齐（rows 或语言缺席）→ 不跳（fail-open）', () => {
    expect(freeStepSkipped({ targetLanguages: null, providerRows: ROWS })).toBe(false)
    expect(freeStepSkipped({ targetLanguages: 'ja', providerRows: null })).toBe(false)
  })
})

describe('wizardSourceVisible', () => {
  it('zh-Hant 命中声明 zh 的源（BCP-47 主码匹配）', () => {
    expect(wizardSourceVisible(row('r3sub', 'source', ['zh']), 'zh-Hant')).toBe(true)
    expect(wizardSourceVisible(row('jimaku', 'source', ['ja']), 'zh-Hant')).toBe(false)
  })
})
