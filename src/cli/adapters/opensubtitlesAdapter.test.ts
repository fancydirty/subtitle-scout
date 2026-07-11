import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeOpenSubtitlesAdapter } from './opensubtitlesAdapter.js'
import type { OpenSubtitlesClient, OsSearchResponse, OsSearchParams } from '../../adapters/providers/opensubtitles.js'
import { OsSearchResponseSchema } from '../../adapters/providers/opensubtitles.js'
import type { FetchArgs } from '../fetchLib.js'

type FakeOsClient = Pick<OpenSubtitlesClient, 'search' | 'resolveDownload'>

const fixture = OsSearchResponseSchema.parse(
  JSON.parse(readFileSync('fixtures/opensubtitles/search-peacemaker-s1.json', 'utf8')),
)
const emptyResp: OsSearchResponse = { total_count: 0, data: [] }

function fakeClient(overrides: Partial<FakeOsClient> = {}): FakeOsClient {
  return {
    search: vi.fn(async (_p: OsSearchParams) => emptyResp),
    resolveDownload: vi.fn(async () => ({ link: 'http://x', file_name: 'x.srt' })),
    ...overrides,
  } as FakeOsClient
}

const args = (over: Partial<FetchArgs> = {}): FetchArgs => ({ queries: [], deep: false, ...over })

describe('makeOpenSubtitlesAdapter: search', () => {
  it('①episode with imdb → imdb_id query, NO parentImdbId/season/episode (regression guard)', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'tt13152020', season: 1, episode: 1, queries: ['Peacemaker'] }), () => {})

    expect(search).toHaveBeenCalledTimes(1)
    const call = search.mock.calls[0][0]
    expect(call.imdbId).toBe(13152020)
    expect(call.parentImdbId).toBeUndefined()
    expect(call.season).toBeUndefined()
    expect(call.episode).toBeUndefined()
  })

  it('②movie with imdb (no season) → imdb_id query', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'tt0133093', queries: ['The Matrix'] }), () => {})

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ imdbId: 133093 }))
    const call = search.mock.calls[0][0]
    expect(call.parentImdbId).toBeUndefined()
  })

  it('③no imdb, episode → title query keeps season/episode', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ queries: ['Peacemaker'], season: 1, episode: 1, year: 2022 }), () => {})

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Peacemaker', season: 1, episode: 1, year: 2022,
    }))
    const call = search.mock.calls[0][0]
    expect(call.imdbId).toBeUndefined()
  })

  it('④imdb with tt prefix is stripped to a number', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'tt13152020', queries: [] }), () => {})

    expect(search.mock.calls[0][0].imdbId).toBe(13152020)
  })

  it('⑤languages default to zh-cn/zh-tw when args.languages absent', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'tt13152020' }), () => {})

    expect(search.mock.calls[0][0].languages).toEqual(['zh-cn', 'zh-tw'])
  })

  it('⑥languages pass through when args.languages given', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'tt13152020', languages: ['en'] }), () => {})

    expect(search.mock.calls[0][0].languages).toEqual(['en'])
  })

  it('⑦osToCandidates mapping flows through: fixture response → candidates with provider opensubtitles', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => fixture)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    const results = await adapter.search(args({ imdb: 'tt13152020' }), () => {})

    expect(results.length).toBe(2)
    expect(results[0]).toMatchObject({ provider: 'opensubtitles', providerId: '7174766' })
  })
})

describe('makeOpenSubtitlesAdapter: resolve', () => {
  it('⑧resolveDownload called with numeric providerId, returns url/filename', async () => {
    const resolveDownload = vi.fn(async () => ({ link: 'https://os.example/download/ABC', file_name: 'e1.srt' }))
    const client = fakeClient({ resolveDownload })
    const adapter = makeOpenSubtitlesAdapter(client)

    const r = await adapter.resolve({ provider: 'opensubtitles', providerId: '7174766', fileIndex: null }, () => {})

    expect(resolveDownload).toHaveBeenCalledWith(7174766)
    expect(r).toEqual({ url: 'https://os.example/download/ABC', filename: 'e1.srt' })
  })

  it('⑨resolve omits filename when file_name is nullish', async () => {
    const resolveDownload = vi.fn(async () => ({ link: 'https://os.example/download/ABC', file_name: null }))
    const client = fakeClient({ resolveDownload })
    const adapter = makeOpenSubtitlesAdapter(client)

    const r = await adapter.resolve({ provider: 'opensubtitles', providerId: '7174766', fileIndex: null }, () => {})

    expect(r).toEqual({ url: 'https://os.example/download/ABC', filename: undefined })
  })
})
