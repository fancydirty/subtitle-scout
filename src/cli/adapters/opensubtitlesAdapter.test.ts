import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeOpenSubtitlesAdapter } from './opensubtitlesAdapter.js'
import type { OpenSubtitlesClient, OsSearchResponse, OsSearchParams } from '../../adapters/providers/opensubtitles.js'
import { OsSearchResponseSchema, OsQuotaExhaustedError } from '../../adapters/providers/opensubtitles.js'
import type { FetchArgs, FetchEvent } from '../fetchLib.js'

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

const args = (over: Partial<FetchArgs> = {}): FetchArgs => ({ queries: [], ...over })

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

  it('③b tt0000000 placeholder imdb falls back to title/season/episode query (not a doomed imdb_id=0 search)', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'tt0000000', queries: ['Peacemaker'], season: 1, episode: 1 }), () => {})

    const call = search.mock.calls[0][0]
    expect(call.imdbId).toBeUndefined()
    expect(call.query).toBe('Peacemaker')
    expect(call.season).toBe(1)
    expect(call.episode).toBe(1)
  })

  it('③c malformed imdb string (NaN after strip) falls back to title/season/episode query', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ imdb: 'https://imdb.com/title/tt13152020', queries: ['Peacemaker'], season: 1, episode: 1 }), () => {})

    const call = search.mock.calls[0][0]
    expect(call.imdbId).toBeUndefined()
    expect(call.query).toBe('Peacemaker')
  })

  // Shelby Oaks 实案（验收轮一，2026-07-17）：TMDB 主发行年 2025，OS 特征年 2024——严格年份
  // 过滤把 OS 上确实存在的两条简中字幕滤成零，agent 只看得见 assrt 的 PGS 包于是判无。跨年
  // 上映/节展片是常态，标题查询零命中且带过年份时必须去年份重试一次（召回优先——归属判断
  // 本来就归 agent，这里多召回不放大误装风险）。
  it('③d title query with year → 0 hits → retries ONCE without year (Shelby Oaks regression)', async () => {
    const search = vi.fn(async (p: OsSearchParams) => (p.year != null ? emptyResp : fixture))
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    const results = await adapter.search(args({ queries: ['Shelby Oaks'], year: 2025 }), () => {})

    expect(search).toHaveBeenCalledTimes(2)
    expect(search.mock.calls[0][0]).toMatchObject({ query: 'Shelby Oaks', year: 2025 })
    expect(search.mock.calls[1][0].year).toBeUndefined()
    expect(search.mock.calls[1][0].query).toBe('Shelby Oaks')
    expect(results.length).toBe(2)
  })

  it('③e title query with year that DOES hit → no retry (year filter kept for precision)', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => fixture)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ queries: ['Shelby Oaks'], year: 2025 }), () => {})

    expect(search).toHaveBeenCalledTimes(1)
  })

  it('③f title query without year → 0 hits → no pointless retry', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => emptyResp)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ queries: ['Shelby Oaks'] }), () => {})

    expect(search).toHaveBeenCalledTimes(1)
  })

  // Shelby Oaks 案第二层（真正的主刀）：A4 语言域泛化后任务目标语言是 BCP-47 主码 'zh'，
  // search_source 默认把它直传 adapter——OS API 的码表里没有裸 'zh'，静默返回 200+空集（不报错
  // 不进 providerFailures），OS 因此在默认配置下自 A4 起从未贡献过候选。provider 特定码表归
  // provider adapter：zh→zh-cn+zh-tw、zh-Hans→zh-cn、zh-Hant→zh-tw，其余原样透传。
  it('③g language mapping: bare zh → zh-cn+zh-tw (OS has no bare zh; silent-empty regression)', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => fixture)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ queries: ['Shelby Oaks'], languages: ['zh'] }), () => {})

    expect(search.mock.calls[0][0].languages).toEqual(['zh-cn', 'zh-tw'])
  })

  it('③h language mapping: zh-Hans→zh-cn, zh-Hant→zh-tw, en passthrough, dedupe', async () => {
    const search = vi.fn(async (_p: OsSearchParams) => fixture)
    const client = fakeClient({ search })
    const adapter = makeOpenSubtitlesAdapter(client)

    await adapter.search(args({ queries: ['x'], languages: ['zh-Hans', 'zh-Hant', 'en', 'zh'] }), () => {})

    expect(search.mock.calls[0][0].languages).toEqual(['zh-cn', 'zh-tw', 'en'])
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

  it('⑩resolve emits a provider_error with code=quota_exhausted + resetAt when resolveDownload throws OsQuotaExhaustedError, then rethrows', async () => {
    const err = new OsQuotaExhaustedError('2026-07-12T00:00:00.000Z', 0)
    const resolveDownload = vi.fn(async () => { throw err })
    const client = fakeClient({ resolveDownload })
    const adapter = makeOpenSubtitlesAdapter(client)
    const events: FetchEvent[] = []

    await expect(
      adapter.resolve({ provider: 'opensubtitles', providerId: '1', fileIndex: null }, e => events.push(e)),
    ).rejects.toBe(err)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'provider_error', provider: 'opensubtitles',
      code: 'quota_exhausted', resetAt: '2026-07-12T00:00:00.000Z',
    })
  })

  it('⑪resolve emits an informational provider_notice (NOT provider_error) when the download itself succeeds but remaining<=0 (proactive: backs off the NEXT call, journal must not read this as an error)', async () => {
    const resolveDownload = vi.fn(async () => ({
      link: 'https://os.example/download/ABC', file_name: 'e1.srt',
      remaining: 0, reset_time_utc: '2026-07-12T00:00:00.000Z',
    }))
    const client = fakeClient({ resolveDownload })
    const adapter = makeOpenSubtitlesAdapter(client)
    const events: FetchEvent[] = []

    const r = await adapter.resolve({ provider: 'opensubtitles', providerId: '1', fileIndex: null }, e => events.push(e))

    expect(r).toEqual({ url: 'https://os.example/download/ABC', filename: 'e1.srt' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'provider_notice', provider: 'opensubtitles',
      code: 'quota_exhausted', resetAt: '2026-07-12T00:00:00.000Z',
    })
    // this download SUCCEEDED — the proactive notice must never be mistaken for an error event
    expect(events[0].event).not.toBe('provider_error')
  })

  it('resolve does NOT emit a quota event when remaining is healthy (no false positives)', async () => {
    const resolveDownload = vi.fn(async () => ({
      link: 'https://os.example/download/ABC', file_name: 'e1.srt',
      remaining: 19, reset_time_utc: '2026-07-12T00:00:00.000Z',
    }))
    const client = fakeClient({ resolveDownload })
    const adapter = makeOpenSubtitlesAdapter(client)
    const events: FetchEvent[] = []

    await adapter.resolve({ provider: 'opensubtitles', providerId: '1', fileIndex: null }, e => events.push(e))

    expect(events).toHaveLength(0)
  })
})
