import { describe, it, expect, beforeEach } from 'vitest'
import { makeJimakuAdapter, jimakuQueryVariants, _clearJimakuFileCache } from './jimakuAdapter.js'

beforeEach(() => _clearJimakuFileCache())

describe('jimakuQueryVariants', () => {
  it('全称 → 冒号前主标题 → 首词(真机:长英文全称 0 命中,短名才有)', () => {
    expect(jimakuQueryVariants("Frieren: Beyond Journey's End")).toEqual([
      "Frieren: Beyond Journey's End",
      'Frieren',
    ])
  })
  it('词内连字符不切(Spider-Man/K-On!),空格连字符季标才切', () => {
    expect(jimakuQueryVariants('Spider-Man: Homecoming')).toEqual([
      'Spider-Man: Homecoming',
      'Spider-Man',
    ])
    expect(jimakuQueryVariants('Attack on Titan - Season 2')).toEqual([
      'Attack on Titan - Season 2',
      'Attack on Titan',
      'Attack',
    ])
  })
})

function fakeClient(opts: {
  entries?: { id: number; name: string; english_name?: string; japanese_name?: string }[]
  entriesByQuery?: Record<string, { id: number; name: string; english_name?: string }[]>
  filesByEntry?: Record<number, { url: string; name: string }[]>
  throwOnQuery?: Record<string, Error>
} = {}) {
  return {
    search: async ({ query }: { query?: string }) => {
      if (opts.throwOnQuery?.[query ?? '']) throw opts.throwOnQuery[query ?? '']
      if (opts.entriesByQuery) return opts.entriesByQuery[query ?? ''] ?? []
      return opts.entries ?? []
    },
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
  it('entry→files 产候选,provider=jimaku language=ja,providerId 自描述带 episode', async () => {
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
      provider: 'jimaku', providerId: '729#ep1', language: 'ja',
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
    expect(r[0].providerId).toBe('729#ep1')
  })

  it('变体 entries 非空但拿不到当集文件 → 继续下个变体(无关 hit 不算命中)', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entriesByQuery: {
        'Show Full Title': [{ id: 1, name: 'Wrong Show' }],
        Show: [{ id: 2, name: 'Right Show' }],
      },
      filesByEntry: { 1: [], 2: [{ url: 'https://j/e1.srt', name: 'e1.srt' }] },
    }))
    const r = await a.search({ queries: ['Show Full Title'], episode: 1, languages: ['ja'] }, () => {})
    expect(r).toHaveLength(1)
    expect(r[0].providerId).toBe('2#ep1')
  })

  it('单变体报错+另一变体诚实空 → 不抛(诚实无结果,非 provider 故障)', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entriesByQuery: { 'Some Title': [], Some: [] },
      throwOnQuery: { 'Some Title': new Error('HTTP 500') },
    }))
    expect(await a.search({ queries: ['Some Title'], episode: 1, languages: ['ja'] }, () => {})).toEqual([])
  })

  it('所有变体都调用层失败 → 抛(全 provider 故障语义)', async () => {
    const a = makeJimakuAdapter(fakeClient({
      throwOnQuery: new Proxy({}, { get: () => new Error('HTTP 500') }) as Record<string, Error>,
    }))
    await expect(a.search({ queries: ['X'], languages: ['ja'] }, () => {})).rejects.toThrow('HTTP 500')
  })
})

describe('makeJimakuAdapter.resolve — fail-closed(审计🔴:缓存失集绝不重拉无过滤列表)', () => {
  it('fileIndex 定位直链(缓存来自 search)', async () => {
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
    const r = await a.resolve({ provider: 'jimaku', providerId: '729#ep1', fileIndex: 1 }, () => {})
    expect(r).toEqual({ url: 'https://j/1.srt', filename: '1.srt' })
  })

  it('缓存未命中 → 抛(拒绝无 episode 上下文重拉全季装错集)', async () => {
    const a = makeJimakuAdapter(fakeClient({
      filesByEntry: { 729: [{ url: 'https://j/s01.srt', name: 's01.srt' }] },
    }))
    await expect(a.resolve({ provider: 'jimaku', providerId: '729#ep3', fileIndex: null }, () => {}))
      .rejects.toThrow(/缓存未命中|重新 search/)
  })

  it('fileIndex 越界 → 抛(宁停不猜)', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 1, name: 'X' }],
      filesByEntry: { 1: [{ url: 'https://j/a.srt', name: 'a.srt' }] },
    }))
    await a.search({ queries: ['X'], episode: 1, languages: ['ja'] }, () => {})
    await expect(a.resolve({ provider: 'jimaku', providerId: '1#ep1', fileIndex: 9 }, () => {}))
      .rejects.toThrow(/越界/)
  })

  it('fileIndex null → 取当集列表第一项', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entries: [{ id: 1, name: 'X' }],
      filesByEntry: { 1: [{ url: 'https://j/a.srt', name: 'a.srt' }] },
    }))
    await a.search({ queries: ['X'], episode: 1, languages: ['ja'] }, () => {})
    const r = await a.resolve({ provider: 'jimaku', providerId: '1#ep1', fileIndex: null }, () => {})
    expect(r.url).toBe('https://j/a.srt')
  })

  it('多集交错:search E1 后 search E2,resolve E1 仍拿到 E1 的文件', async () => {
    const a = makeJimakuAdapter(fakeClient({
      entriesByQuery: {
        'Show E1': [{ id: 9, name: 'S' }],
        'Show E2': [{ id: 9, name: 'S' }],
      },
      filesByEntry: {},
    }))
    // files 按 episode 区分:fake client 需带 ep——简化:重写 client
    const c = {
      search: async () => [{ id: 9, name: 'S' }],
      files: async (_id: number, ep?: number) =>
        ep === 1 ? [{ url: 'https://j/e1.srt', name: 'e1.srt' }] : [{ url: 'https://j/e2.srt', name: 'e2.srt' }],
    }
    const a2 = makeJimakuAdapter(c)
    const r1 = await a2.search({ queries: ['Show'], episode: 1, languages: ['ja'] }, () => {})
    const r2 = await a2.search({ queries: ['Show'], episode: 2, languages: ['ja'] }, () => {})
    expect(r1[0].providerId).toBe('9#ep1')
    expect(r2[0].providerId).toBe('9#ep2')
    const d1 = await a2.resolve({ provider: 'jimaku', providerId: '9#ep1', fileIndex: null }, () => {})
    expect(d1.filename).toBe('e1.srt')
    void a
  })
})
