import { describe, it, expect, vi } from 'vitest'
import { TmdbClient, resolveTmdbRef } from './tmdb.js'

interface RouteBodies {
  translations?: unknown
  alternativeTitles?: unknown
  translationsStatus?: number
  altStatus?: number
}

// 按 URL path 路由到两端点响应；status>=400 → 非 ok 响应。
function routedFetch(routes: RouteBodies) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/translations')) {
      const s = routes.translationsStatus ?? 200
      return new Response(s >= 400 ? 'err' : JSON.stringify(routes.translations ?? {}), { status: s })
    }
    if (u.includes('/alternative_titles')) {
      const s = routes.altStatus ?? 200
      return new Response(s >= 400 ? 'err' : JSON.stringify(routes.alternativeTitles ?? {}), { status: s })
    }
    return new Response('not found', { status: 404 })
  })
}

function mkClient(routes: RouteBodies, apiKey = 'a'.repeat(32)) {
  const fetchImpl = routedFetch(routes)
  const client = new TmdbClient({ apiKey, fetchImpl: fetchImpl as unknown as typeof fetch })
  return { client, fetchImpl }
}

// Love, Death & Robots 生产实锤：translations 官方 CN 名 + alternative_titles CN 区变体。
const ldrTranslations = {
  translations: [
    { iso_639_1: 'zh', iso_3166_1: 'CN', data: { name: '爱，死亡和机器人' } },
    { iso_639_1: 'zh', iso_3166_1: 'TW', data: { name: '愛，死亡與機器人' } },
    { iso_639_1: 'en', iso_3166_1: 'US', data: { name: 'Love, Death & Robots' } },
  ],
}
const ldrAltTitles = {
  results: [
    { iso_3166_1: 'CN', title: '爱死亡与机器人' },
    { iso_3166_1: 'CN', title: '爱、死亡 & 机器人' },
    { iso_3166_1: 'CN', title: '爱，死亡和机器人' }, // 与官方 CN 译名重复 → 去重
    { iso_3166_1: 'US', title: 'Love Death Robots' }, // 非 CN/TW/HK 区 → 丢弃
  ],
}

describe('TmdbClient.getChineseTitles', () => {
  it('merges both endpoints, dedupes, official CN translation first', async () => {
    const { client } = mkClient({ translations: ldrTranslations, alternativeTitles: ldrAltTitles })
    const titles = await client.getChineseTitles('tv', '86831')
    expect(titles).toEqual([
      '爱，死亡和机器人', // 官方 CN translation 排首位
      '愛，死亡與機器人', // TW translation
      '爱死亡与机器人',   // alternative_titles CN 变体
      '爱、死亡 & 机器人', // alternative_titles CN 变体
    ])
  })

  it('v4 JWT token → Authorization: Bearer header, no api_key query', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.payload.sig'
    const { client, fetchImpl } = mkClient(
      { translations: ldrTranslations, alternativeTitles: ldrAltTitles }, jwt,
    )
    await client.getChineseTitles('tv', '86831')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).not.toContain('api_key')
    expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: `Bearer ${jwt}` })
  })

  it('v3 hex key → api_key query param, no Authorization header', async () => {
    const key = 'a'.repeat(32)
    const { client, fetchImpl } = mkClient(
      { translations: ldrTranslations, alternativeTitles: ldrAltTitles }, key,
    )
    await client.getChineseTitles('movie', '603')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain(`api_key=${key}`)
    expect((init as RequestInit | undefined)?.headers).toBeUndefined()
  })

  it('movie response reads data.title (translations) and titles[] (alternative_titles)', async () => {
    const { client } = mkClient({
      translations: { translations: [{ iso_639_1: 'zh', iso_3166_1: 'CN', data: { title: '黑客帝国' } }] },
      alternativeTitles: { titles: [{ iso_3166_1: 'TW', title: '駭客任務' }] },
    })
    const titles = await client.getChineseTitles('movie', '603')
    expect(titles).toEqual(['黑客帝国', '駭客任務'])
  })

  it('one endpoint 500 → other endpoint still ships', async () => {
    const { client } = mkClient({ translationsStatus: 500, alternativeTitles: ldrAltTitles })
    const titles = await client.getChineseTitles('tv', '86831')
    // translations 挂掉 → 只剩 alternative_titles 的 CN 区变体（US 区被滤）
    expect(titles).toEqual(['爱死亡与机器人', '爱、死亡 & 机器人', '爱，死亡和机器人'])
  })

  it('both endpoints throw → returns []', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getChineseTitles('tv', '86831')).toEqual([])
  })

  it('filters non-CJK and empty strings', async () => {
    const { client } = mkClient({
      translations: { translations: [
        { iso_639_1: 'zh', iso_3166_1: 'CN', data: { name: '' } },        // 空串
        { iso_639_1: 'zh', iso_3166_1: 'TW', data: { name: 'Latin Only' } }, // 非 CJK
        { iso_639_1: 'zh', iso_3166_1: 'HK', data: { name: '中文名' } },
      ] },
      alternativeTitles: { results: [] },
    })
    expect(await client.getChineseTitles('tv', '1')).toEqual(['中文名'])
  })
})

describe('resolveTmdbRef', () => {
  it('Movie → { movie, own Tmdb id }', async () => {
    const ref = await resolveTmdbRef(
      { Type: 'Movie', ProviderIds: { Tmdb: '603' } },
      async () => { throw new Error('should not be called') },
    )
    expect(ref).toEqual({ mediaType: 'movie', tmdbId: '603' })
  })

  it('Series → { tv, own Tmdb id }', async () => {
    const ref = await resolveTmdbRef(
      { Type: 'Series', ProviderIds: { Tmdb: '86831' } },
      async () => { throw new Error('should not be called') },
    )
    expect(ref).toEqual({ mediaType: 'tv', tmdbId: '86831' })
  })

  it('Episode → resolves series Tmdb id via getItem', async () => {
    const getItem = vi.fn(async () => ({ Type: 'Series', ProviderIds: { Tmdb: '86831' } }))
    const ref = await resolveTmdbRef(
      { Type: 'Episode', SeriesId: 'series-1', ProviderIds: { Tmdb: '99999' } },
      getItem,
    )
    expect(ref).toEqual({ mediaType: 'tv', tmdbId: '86831' })
    expect(getItem).toHaveBeenCalledWith('series-1')
  })

  it('missing Tmdb id → null', async () => {
    const ref = await resolveTmdbRef({ Type: 'Movie', ProviderIds: {} }, async () => ({}))
    expect(ref).toBeNull()
  })

  it('Episode getItem failure → null (silent)', async () => {
    const ref = await resolveTmdbRef(
      { Type: 'Episode', SeriesId: 'series-1' },
      async () => { throw new Error('jf down') },
    )
    expect(ref).toBeNull()
  })
})
