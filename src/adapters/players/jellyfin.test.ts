import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { JellyfinClient, JellyfinSessionsSchema, JellyfinItemsResponseSchema, type JellyfinItem } from './jellyfin.js'

const sessionsFixture = readFileSync('fixtures/jellyfin/sessions-playing.json', 'utf8')
const idleFixture = readFileSync('fixtures/jellyfin/sessions-idle.json', 'utf8')
const itemsFixture = readFileSync('fixtures/jellyfin/items-detail.json', 'utf8')
const afterRefreshFixture = readFileSync('fixtures/jellyfin/item-after-refresh.json', 'utf8')

function makeClient(responses: string[]) {
  let i = 0
  const fetchImpl = vi.fn(async () => new Response(responses[Math.min(i++, responses.length - 1)]))
  return { client: new JellyfinClient({ baseUrl: 'http://jf:8096', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch }), fetchImpl }
}

describe('schemas ground truth', () => {
  it('parses recorded playing sessions', () => {
    const sessions = JellyfinSessionsSchema.parse(JSON.parse(sessionsFixture))
    const playing = sessions.filter(s => s.NowPlayingItem)
    expect(playing.length).toBeGreaterThan(0)
    expect(playing[0].NowPlayingItem!.Name).toBeTruthy()
    expect(playing[0].NowPlayingItem!.Id).toBeTruthy()
  })
  it('parses recorded idle sessions (no NowPlayingItem)', () => {
    const sessions = JellyfinSessionsSchema.parse(JSON.parse(idleFixture))
    expect(Array.isArray(sessions)).toBe(true)
    expect(sessions.every(s => !s.NowPlayingItem)).toBe(true)
  })
  it('parses recorded item detail with Path, ProviderIds, MediaStreams', () => {
    const r = JellyfinItemsResponseSchema.parse(JSON.parse(itemsFixture))
    expect(r.Items[0].Path).toContain('The.Matrix')
    expect(r.Items[0].ProviderIds?.Imdb).toBe('tt0133093')
    expect(Array.isArray(r.Items[0].MediaStreams)).toBe(true)
  })
  it('parses the after-refresh fixture with an external zh-hans subtitle stream', () => {
    const r = JellyfinItemsResponseSchema.parse(JSON.parse(afterRefreshFixture))
    const subs = (r.Items[0].MediaStreams ?? []).filter(s => s.Type === 'Subtitle')
    expect(subs.length).toBe(1)
    expect(subs[0].Language).toBe('zh-hans')
    expect(subs[0].IsExternal).toBe(true)
  })
})

describe('JellyfinClient', () => {
  it('getSessions sends token header and parses', async () => {
    const { client, fetchImpl } = makeClient([sessionsFixture])
    const sessions = await client.getSessions()
    expect(sessions.length).toBeGreaterThan(0)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('http://jf:8096/Sessions')
    expect((init.headers as Record<string, string>)['X-Emby-Token']).toBe('k')
  })
  it('getItem fetches by id with fields', async () => {
    const { client, fetchImpl } = makeClient([itemsFixture])
    const item = await client.getItem('anyid')
    expect(item.Path).toBeTruthy()
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('ids=anyid')
    expect(String(url)).toContain('fields=')
  })
  it('getItem throws when item not found', async () => {
    const { client } = makeClient([JSON.stringify({ Items: [], TotalRecordCount: 0 })])
    await expect(client.getItem('nope')).rejects.toThrow(/not found/i)
  })
  it('refreshItem POSTs FullRefresh (bare refresh does not rescan external subs)', async () => {
    const { client, fetchImpl } = makeClient([''])
    await client.refreshItem('abc')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/Items/abc/Refresh')
    expect(String(url)).toContain('metadataRefreshMode=FullRefresh')
    expect(init.method).toBe('POST')
  })
  it('reports api calls via onApiCall including failures', async () => {
    const calls: unknown[] = []
    const fetchImpl = vi.fn(async () => new Response('oops', { status: 500 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf:8096', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch, onApiCall: r => calls.push(r) })
    await expect(client.getSessions()).rejects.toThrow(/500/)
    expect(calls.length).toBe(1)
  })
  it('getRecentItems queries by DateCreated desc', async () => {
    const { client, fetchImpl } = makeClient([itemsFixture])
    await client.getRecentItems(50)
    expect(fetchImpl).toHaveBeenCalled()
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('sortBy=DateCreated')
    expect(String(url)).toContain('includeItemTypes=Movie,Episode')
    expect(String(url)).toContain('limit=50')
  })
})

function movieItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: 'x1', Name: 'Shelby Oaks', Type: 'Movie', ProductionYear: 2024,
    ProviderIds: { Tmdb: '937941' }, ...overrides,
  } as JellyfinItem
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as unknown as Response
}

describe('getChineseTitle', () => {
  it('returns the first zh-CN RemoteSearch result name', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: '寻踪迷镇', ProductionYear: 2024 }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem())).toBe('寻踪迷镇')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/Items/RemoteSearch/Movie')
    expect(init.method).toBe('POST')
    const sent = JSON.parse(init.body as string)
    expect(sent.SearchInfo.MetadataLanguage).toBe('zh-CN')
    expect(sent.SearchInfo.ProviderIds).toEqual({ Tmdb: '937941' })
  })
  it('returns null on empty results', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem())).toBeNull()
  })
  it('returns null silently on HTTP error (never throws)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem())).toBeNull()
  })
  it('returns null without calling when item has no provider ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: 'x' }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem({ ProviderIds: {} }))).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('returns null for non-movie/series types', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: 'x' }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem({ Type: 'Episode' }))).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('supports Series type with the Series endpoint', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([{ Name: '开心汉堡店', ProductionYear: 2024 }]))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getChineseTitle(movieItem({ Type: 'Series' }))).toBe('开心汉堡店')
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/Items/RemoteSearch/Series')
  })
})

describe('getSeasonEpisodes', () => {
  it('lists a season\'s episodes with codes and needsChinese', async () => {
    const CN = { Type: 'Subtitle', Language: 'zh-Hans', IsExternal: true, Codec: 'ass' }
    const body = { Items: [
      { Id: 'e1', Name: 'Episode 1', Type: 'Episode', Path: '/media/tv/Show/Season 2/Show.S02E01.mkv', ParentIndexNumber: 2, IndexNumber: 1, MediaStreams: [] },
      { Id: 'e2', Name: 'Episode 2', Type: 'Episode', Path: '/media/tv/Show/Season 2/Show.S02E02.mkv', ParentIndexNumber: 2, IndexNumber: 2, MediaStreams: [CN] },
    ] }
    const fetchImpl = vi.fn(async () => jsonResponse(body))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const seriesItem = { Id: 'ep-current', Type: 'Episode', SeriesId: 'series-9', ParentIndexNumber: 2, IndexNumber: 3 } as unknown as JellyfinItem
    const eps = await jf.getSeasonEpisodes(seriesItem)
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toContain('/Shows/series-9/Episodes')
    expect(eps.map(e => e.episodeCode)).toEqual(['S02E01', 'S02E02'])
    expect(eps[0].needsChinese).toBe(true)   // e1 no subs
    expect(eps[1].needsChinese).toBe(false)  // e2 has zh-Hans
    expect(eps[0].videoFilename).toBe('Show.S02E01.mkv')
  })
  it('returns [] when the item has no SeriesId (silent, no fetch)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ Items: [] }))
    const jf = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await jf.getSeasonEpisodes({ Id: 'x', Type: 'Episode' } as unknown as JellyfinItem)).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
