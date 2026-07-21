import { describe, it, expect, beforeEach } from 'vitest'
import { makeJimakuAdapter, jimakuQueryVariants, _clearJimakuFileCache } from './jimakuAdapter.js'

describe('jimakuQueryVariants', () => {
  it('全称 → 冒号前主标题 → 首词(真机:长英文全称 0 命中,短名才有)', () => {
    expect(jimakuQueryVariants("Frieren: Beyond Journey's End")).toEqual([
      "Frieren: Beyond Journey's End",
      'Frieren',
    ])
  })
})

beforeEach(() => _clearJimakuFileCache())

function fakeClient(opts: {
  entries?: { id: number; name: string; english_name?: string; japanese_name?: string }[]
  filesByEntry?: Record<number, { url: string; name: string }[]>
} = {}) {
  return {
    search: async () => opts.entries ?? [],
    files: async (id: number, _ep?: number) => opts.filesByEntry?.[id] ?? [],
  }
}

describe('makeJimakuAdapter.enabled', () => {
  it('仅 ja 语言启用', () => {
    const a = makeJimakuAdapter(fakeClient())
    expect(a.enabled({ queries: ['x'], languages: ['ja'] }, {})).toBe(true)
    expect(a.enabled({ queries: ['x'], languages: ['ja-JP'] }, {})).toBe(true)
    expect(a.enabled({ queries: ['x'], languages: ['en'] }, {})).toBe(false)
    expect(a.enabled({ queries: ['x'], languages: ['zh'] }, {})).toBe(false)
  })
})

describe('makeJimakuAdapter.search', () => {
  it('entry→files 产候选,provider=jimaku language=ja,fileList 按 index', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 729, name: 'Sousou no Frieren', english_name: 'Frieren', japanese_name: '葬送のフリーレン' }],
      filesByEntry: {
        729: [
          { url: 'https://j/a.srt', name: 'Frieren - 01.srt' },
          { url: 'https://j/b.srt', name: 'Frieren - 01 alt.srt' },
        ],
      },
    }))
    const r = await a.search({ queries: ['Frieren'], episode: 1, languages: ['ja'] }, () => {})
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      provider: 'jimaku', providerId: '729', language: 'ja',
      videoName: 'Frieren', nativeName: '葬送のフリーレン',
    })
    expect(r[0].fileList).toEqual([
      { index: 0, name: 'Frieren - 01.srt' },
      { index: 1, name: 'Frieren - 01 alt.srt' },
    ])
  })

  it('files 空 → 该 entry 不贡献候选', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 1, name: 'X' }],
      filesByEntry: { 1: [] },
    }))
    expect(await a.search({ queries: ['X'], episode: 1, languages: ['ja'] }, () => {})).toEqual([])
  })

  it('长全称 0 命中时回退短名变体(Frieren 全称→Frieren)', async () => {
    const queries: string[] = []
    const client = {
      search: async ({ query }: { query?: string }) => {
        queries.push(query ?? '')
        if (query === 'Frieren') return [{ id: 729, name: 'Sousou no Frieren', english_name: 'Frieren' }]
        return []
      },
      files: async () => [{ url: 'https://j/a.srt', name: '01.srt' }],
    }
    const a = makeJimakuAdapter(client)
    const r = await a.search({ queries: ["Frieren: Beyond Journey's End"], episode: 1, languages: ['ja'] }, () => {})
    expect(queries[0]).toBe("Frieren: Beyond Journey's End")
    expect(queries).toContain('Frieren')
    expect(r).toHaveLength(1)
    expect(r[0].providerId).toBe('729')
  })
})

describe('makeJimakuAdapter.resolve', () => {
  it('fileIndex 定位直链', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 729, name: 'F' }],
      filesByEntry: {
        729: [
          { url: 'https://j/0.srt', name: '0.srt' },
          { url: 'https://j/1.srt', name: '1.srt' },
        ],
      },
    }))
    await a.search({ queries: ['F'], episode: 1, languages: ['ja'] }, () => {})
    const r = await a.resolve({ provider: 'jimaku', providerId: '729', fileIndex: 1 }, () => {})
    expect(r).toEqual({ url: 'https://j/1.srt', filename: '1.srt' })
  })

  it('fileIndex 越界 → 抛(宁停不猜)', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 1, name: 'X' }],
      filesByEntry: { 1: [{ url: 'https://j/a.srt', name: 'a.srt' }] },
    }))
    await a.search({ queries: ['X'], episode: 1, languages: ['ja'] }, () => {})
    await expect(a.resolve({ provider: 'jimaku', providerId: '1', fileIndex: 9 }, () => {}))
      .rejects.toThrow(/越界/)
  })

  it('fileIndex null → 取第一项', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 1, name: 'X' }],
      filesByEntry: { 1: [{ url: 'https://j/a.srt', name: 'a.srt' }] },
    }))
    await a.search({ queries: ['X'], languages: ['ja'] }, () => {})
    const r = await a.resolve({ provider: 'jimaku', providerId: '1', fileIndex: null }, () => {})
    expect(r.url).toBe('https://j/a.srt')
  })
})
