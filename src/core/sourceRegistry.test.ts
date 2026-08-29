import { describe, it, expect } from 'vitest'
import { SOURCE_REGISTRY, sourcesForLanguages } from './sourceRegistry.js'

const ids = (targets: string[]) => sourcesForLanguages(targets).map((s) => s.id)

describe('SOURCE_REGISTRY', () => {
  it('declares all seven subtitle sources exactly once', () => {
    expect(SOURCE_REGISTRY.map((s) => s.id).sort()).toEqual(
      ['assrt', 'jimaku', 'opensubtitles', 'r3sub', 'subdl', 'subhd', 'zimuku'],
    )
  })
  it('credential shapes: subhd/zimuku are toggles, the rest keyed', () => {
    for (const s of SOURCE_REGISTRY) {
      expect(s.credential).toBe(s.id === 'subhd' || s.id === 'zimuku' ? 'toggle' : 'keyed')
    }
  })
})

describe('sourcesForLanguages', () => {
  it('zh viewer gets the full Chinese stack plus universal sources', () => {
    expect(ids(['zh']).sort()).toEqual(
      ['assrt', 'opensubtitles', 'r3sub', 'subdl', 'subhd', 'zimuku'],
    )
  })
  it('ja viewer gets jimaku plus universal sources only', () => {
    expect(ids(['ja']).sort()).toEqual(['jimaku', 'opensubtitles', 'subdl'])
  })
  it('en (and any other) viewer gets universal sources only', () => {
    expect(ids(['en']).sort()).toEqual(['opensubtitles', 'subdl'])
    expect(ids(['fr']).sort()).toEqual(['opensubtitles', 'subdl'])
  })
  it('multi-language targets union their stacks', () => {
    expect(ids(['zh', 'ja']).sort()).toEqual(
      ['assrt', 'jimaku', 'opensubtitles', 'r3sub', 'subdl', 'subhd', 'zimuku'],
    )
  })
  it('BCP-47 subtags match on the primary code (zh-Hant hits zh sources)', () => {
    expect(ids(['zh-Hant']).sort()).toEqual(ids(['zh']).sort())
  })
  it('empty targets fail open: every source is offered', () => {
    expect(ids([]).sort()).toEqual(SOURCE_REGISTRY.map((s) => s.id).sort())
  })
  it('registry declaration order is preserved in results', () => {
    const zh = ids(['zh'])
    const declared = SOURCE_REGISTRY.map((s) => s.id).filter((id) => zh.includes(id))
    expect(zh).toEqual(declared)
  })
})
