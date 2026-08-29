import { describe, it, expect } from 'vitest'
import type { ProviderRowDTO } from '../api/types.js'
import { parseTargets, deriveVisibleRows, groupSourceRows } from './sourceDerivation.js'

const row = (id: ProviderRowDTO['id'], kind: 'infra' | 'source', languages: '*' | string[] | null): ProviderRowDTO =>
  ({ id, kind, languages, secrets: [], lastTest: null, quota: null })

// 后端 buildProviders 的真实行序（infra 前、源按注册表声明序）
const ROWS: ProviderRowDTO[] = [
  row('tmdb', 'infra', null),
  row('llm', 'infra', null),
  row('translate', 'infra', null),
  row('assrt', 'source', ['zh']),
  row('opensubtitles', 'source', '*'),
  row('jimaku', 'source', ['ja']),
  row('subhd', 'source', ['zh']),
  row('zimuku', 'source', ['zh']),
  row('r3sub', 'source', ['zh']),
  row('subdl', 'source', '*'),
]

describe('parseTargets', () => {
  it('CSV → 主码数组；子标签取主码；空白剔除', () => {
    expect(parseTargets('zh')).toEqual(['zh'])
    expect(parseTargets('zh-Hant,en')).toEqual(['zh', 'en'])
    expect(parseTargets(' ja , ko ')).toEqual(['ja', 'ko'])
  })
  it('未设/空 → 运行期默认 zh（与 daemon parseTargetLanguages 同口径）', () => {
    expect(parseTargets(null)).toEqual(['zh'])
    expect(parseTargets(undefined)).toEqual(['zh'])
    expect(parseTargets('')).toEqual(['zh'])
  })
})

describe('deriveVisibleRows', () => {
  it('zh 用户：infra 全见 + 中文源 + 通用源，不见 jimaku', () => {
    const ids = deriveVisibleRows(ROWS, 'zh').map((r) => r.id)
    expect(ids).toEqual(['tmdb', 'llm', 'translate', 'assrt', 'opensubtitles', 'subhd', 'zimuku', 'r3sub', 'subdl'])
  })
  it('en 用户：infra + 通用源，中文/日文源全部隐身', () => {
    const ids = deriveVisibleRows(ROWS, 'en').map((r) => r.id)
    expect(ids).toEqual(['tmdb', 'llm', 'translate', 'opensubtitles', 'subdl'])
  })
  it('ja 用户：jimaku 在列，assrt/subhd/zimuku/r3sub 不在', () => {
    const ids = deriveVisibleRows(ROWS, 'ja').map((r) => r.id)
    expect(ids).toEqual(['tmdb', 'llm', 'translate', 'opensubtitles', 'jimaku', 'subdl'])
  })
  it('多语言并集：zh,ja 全家桶', () => {
    expect(deriveVisibleRows(ROWS, 'zh,ja')).toHaveLength(10)
  })
})

describe('groupSourceRows（多语言时的 section 分组）', () => {
  it('单语言 → 单组（无标题诉求，调用方平铺）', () => {
    const g = groupSourceRows(ROWS, ['zh'])
    expect(g).toHaveLength(1)
    expect(g[0].lang).toBe('all')
    expect(g[0].rows.map((r) => r.id)).toEqual(['assrt', 'opensubtitles', 'subhd', 'zimuku', 'r3sub', 'subdl'])
  })
  it('多语言 → 每语言一组（专属源）+ 通用组殿后', () => {
    const g = groupSourceRows(ROWS, ['zh', 'ja'])
    expect(g.map((x) => x.lang)).toEqual(['zh', 'ja', 'universal'])
    expect(g[0].rows.map((r) => r.id)).toEqual(['assrt', 'subhd', 'zimuku', 'r3sub'])
    expect(g[1].rows.map((r) => r.id)).toEqual(['jimaku'])
    expect(g[2].rows.map((r) => r.id)).toEqual(['opensubtitles', 'subdl'])
  })
  it('多语言但某语言无专属源 → 该组不产出空壳', () => {
    const g = groupSourceRows(ROWS, ['en', 'ja'])
    expect(g.map((x) => x.lang)).toEqual(['ja', 'universal'])
  })
})
