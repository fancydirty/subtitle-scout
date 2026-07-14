import { describe, it, expect, vi } from 'vitest'
import { TmdbClient, resolveTmdbRef, resolveTmdbRefStrict, TmdbRequestFailedError } from './tmdb.js'
import { JellyfinItemNotFoundError } from '../players/jellyfin.js'

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

describe('TmdbClient.getOriginLanguage', () => {
  it('success → lowercased original_language', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ original_language: 'ZH' }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getOriginLanguage('tv', '1')).toBe('zh')
  })

  it('genuine no-data (200 response, no original_language field) → null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getOriginLanguage('tv', '1')).toBeNull()
  })

  it('request failure (network throw) → rejects with TmdbRequestFailedError, NOT null', async () => {
    // 验证的关键区分点：网络失败必须是可观察的拒绝，不能被吞成和"无数据"一样的 null，
    // 否则 scanner.ts 没法区分"该缓存哨兵"还是"该重试"。
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getOriginLanguage('tv', '1')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('request failure (non-2xx status) → rejects with TmdbRequestFailedError, NOT null', async () => {
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getOriginLanguage('tv', '1')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('request failure (non-JSON body) → rejects with TmdbRequestFailedError, NOT null', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getOriginLanguage('tv', '1')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('404 (id does not exist on TMDB) → null, genuine no-data — NOT a transient failure', async () => {
    // 404 是"TMDB 明确答复：查无此 id"（脏/过期的 Tmdb provider id 是永久态），
    // 归入 no-data 让上游缓存哨兵、收敛回查；若归入 failure 会让坏 id 每轮 scan 重试到永远。
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getOriginLanguage('tv', '1')).toBeNull()
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

describe('TmdbRequestFailedError', () => {
  it('sets name and chains the original error via cause (preserves stack instead of stringifying)', () => {
    const original = new Error('socket hang up')
    const err = new TmdbRequestFailedError(original)
    expect(err.name).toBe('TmdbRequestFailedError')
    expect(err.cause).toBe(original)
  })
})

describe('resolveTmdbRefStrict', () => {
  // 与 resolveTmdbRef 的核心区别只在 Episode 分支的 getItem 失败处理：
  // 其余分支（Movie/Series/无引用）行为完全一致，此处复用同样的用例做回归锚点。
  it('Movie → { movie, own Tmdb id }', async () => {
    const ref = await resolveTmdbRefStrict(
      { Type: 'Movie', ProviderIds: { Tmdb: '603' } },
      async () => { throw new Error('should not be called') },
    )
    expect(ref).toEqual({ mediaType: 'movie', tmdbId: '603' })
  })

  it('Series → { tv, own Tmdb id }', async () => {
    const ref = await resolveTmdbRefStrict(
      { Type: 'Series', ProviderIds: { Tmdb: '86831' } },
      async () => { throw new Error('should not be called') },
    )
    expect(ref).toEqual({ mediaType: 'tv', tmdbId: '86831' })
  })

  it('Episode → resolves series Tmdb id via getItem', async () => {
    const getItem = vi.fn(async () => ({ Type: 'Series', ProviderIds: { Tmdb: '86831' } }))
    const ref = await resolveTmdbRefStrict(
      { Type: 'Episode', SeriesId: 'series-1', ProviderIds: { Tmdb: '99999' } },
      getItem,
    )
    expect(ref).toEqual({ mediaType: 'tv', tmdbId: '86831' })
    expect(getItem).toHaveBeenCalledWith('series-1')
  })

  it('missing Tmdb id on resolved series → null (genuine no-data, not a failure)', async () => {
    const ref = await resolveTmdbRefStrict(
      { Type: 'Episode', SeriesId: 'series-1' },
      async () => ({ Type: 'Series', ProviderIds: {} }),
    )
    expect(ref).toBeNull()
  })

  it('Episode → series genuinely not found on Jellyfin (JellyfinItemNotFoundError) → null, safe no-data', async () => {
    // 脏/过期的 SeriesId（系列已从 Jellyfin 删除）是永久态——和"查无此 TMDB id"同级语义，
    // 上游 scanner 应当安全负缓存，不必每轮重试一个永远不会恢复的引用。
    const ref = await resolveTmdbRefStrict(
      { Type: 'Episode', SeriesId: 'series-1' },
      async () => { throw new JellyfinItemNotFoundError('series-1') },
    )
    expect(ref).toBeNull()
  })

  it('Episode → transient getItem failure (Jellyfin network/5xx) → REJECTS, does not collapse into null', async () => {
    // 这是本次修复的核心区分点：生产接线（cli/index.ts originFor）必须能观察到这次拒绝，
    // 才能让 scanner 按"瞬时失败"而非"查无数据"处理——否则一次 Jellyfin 抖动会让扫过的
    // 条目被永久打上 unknown 哨兵，权威 origin gate 从此失效。
    await expect(resolveTmdbRefStrict(
      { Type: 'Episode', SeriesId: 'series-1' },
      async () => { throw new Error('jellyfin GET /Items: HTTP 503') },
    )).rejects.toThrow('jellyfin GET /Items: HTTP 503')
  })
})

describe('resolveTmdbRef delegates to resolveTmdbRefStrict but stays fail-soft (enrichment path, tmdbTitles)', () => {
  it('Episode → even a transient-shaped getItem failure still collapses to null (never throws)', async () => {
    const ref = await resolveTmdbRef(
      { Type: 'Episode', SeriesId: 'series-1' },
      async () => { throw new Error('jellyfin GET /Items: HTTP 503') },
    )
    expect(ref).toBeNull()
  })
})

describe('TmdbClient.getSeasonTable', () => {
  it('解析 /tv/{id} 的 seasons 数组，过滤 season_number<=0（特别篇），按季号升序', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      seasons: [
        { season_number: 0, episode_count: 5, air_date: null },
        { season_number: 2, episode_count: 12, air_date: '2023-04-01' },
        { season_number: 1, episode_count: 25, air_date: '2022-04-01' },
      ],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    const table = await client.getSeasonTable('120089')
    expect(table).toEqual([
      { seasonNumber: 1, episodeCount: 25, airDate: '2022-04-01' },
      { seasonNumber: 2, episodeCount: 12, airDate: '2023-04-01' },
    ])
  })

  it('404 → null（真·无数据）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getSeasonTable('999999')).toBeNull()
  })

  it('网络故障 → 抛 TmdbRequestFailedError（瞬时，可重试，绝不当无数据）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getSeasonTable('120089')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('正片季缺 episode_count → 抛 TmdbRequestFailedError（权威数据异常即中止，绝不 ??0 静默算错累计表）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      seasons: [
        { season_number: 1, episode_count: 25, air_date: null },
        { season_number: 2, air_date: null }, // 缺 episode_count
      ],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getSeasonTable('120089')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('seasons 非数组 → 抛 TmdbRequestFailedError（而非裸 TypeError）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ seasons: 'oops' }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getSeasonTable('120089')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('响应体缺 seasons 字段 → 同样按数据形状异常抛 TmdbRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 120089 }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getSeasonTable('120089')).rejects.toThrow(TmdbRequestFailedError)
  })
})

// 按 URL path 路由到 episode_groups 的两个端点（列表 + 详情）；status>=400 → 非 ok 响应。
interface EpisodeGroupRoutes {
  groupsList?: unknown
  groupsListStatus?: number
  groupDetail?: unknown
  groupDetailStatus?: number
}
function routedEpisodeGroupFetch(routes: EpisodeGroupRoutes) {
  return vi.fn(async (url: string | URL, _init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/episode_group/')) {
      const s = routes.groupDetailStatus ?? 200
      return new Response(s >= 400 ? 'err' : JSON.stringify(routes.groupDetail ?? {}), { status: s })
    }
    if (u.includes('/episode_groups')) {
      const s = routes.groupsListStatus ?? 200
      return new Response(s >= 400 ? 'err' : JSON.stringify(routes.groupsList ?? {}), { status: s })
    }
    return new Response('not found', { status: 404 })
  })
}
function mkEpisodeGroupClient(routes: EpisodeGroupRoutes, apiKey = 'a'.repeat(32)) {
  const fetchImpl = routedEpisodeGroupFetch(routes)
  const client = new TmdbClient({ apiKey, fetchImpl: fetchImpl as unknown as typeof fetch })
  return { client, fetchImpl }
}

describe('TmdbClient.getAbsoluteOrder', () => {
  it('type===2 (Absolute) 分组存在 → 展平为 (season, episode) 序列，按 group/episode order 排序', async () => {
    const { client } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'abs123', type: 2 }, { id: 'other', type: 1 }] },
      groupDetail: {
        groups: [
          {
            order: 0,
            episodes: [
              { season_number: 1, episode_number: 2, order: 1 },
              { season_number: 1, episode_number: 1, order: 0 },
            ],
          },
          {
            order: 1,
            episodes: [{ season_number: 2, episode_number: 1, order: 0 }],
          },
        ],
      },
    })
    const order = await client.getAbsoluteOrder('120089')
    expect(order).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 2 },
      { season: 2, episode: 1 },
    ])
  })

  it('没有 type===2 分组 → null', async () => {
    const { client } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'other', type: 1 }] },
    })
    expect(await client.getAbsoluteOrder('120089')).toBeNull()
  })

  it('episode_groups 列表为空 → null', async () => {
    const { client } = mkEpisodeGroupClient({ groupsList: { results: [] } })
    expect(await client.getAbsoluteOrder('120089')).toBeNull()
  })

  it('请求失败（网络拒绝）→ null（getJson 静默吞错，缺失分组是正常情形而非故障）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getAbsoluteOrder('120089')).toBeNull()
  })

  it('详情响应缺 groups 字段 → null（形状异常不裸崩，静默降级）', async () => {
    const { client } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'abs123', type: 2 }] },
      groupDetail: { id: 'abs123' }, // 无 groups 数组
    })
    expect(await client.getAbsoluteOrder('120089')).toBeNull()
  })

  it('某个 group 缺 episodes → 跳过该 group，仍返回其余 group 的集', async () => {
    const { client } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'abs123', type: 2 }] },
      groupDetail: {
        groups: [
          { order: 0 }, // 缺 episodes → 跳过
          { order: 1, episodes: [{ season_number: 2, episode_number: 1, order: 0 }] },
        ],
      },
    })
    expect(await client.getAbsoluteOrder('120089')).toEqual([{ season: 2, episode: 1 }])
  })

  it('单条 episode 缺 season_number/episode_number → 跳过该条，保留合法条目', async () => {
    const { client } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'abs123', type: 2 }] },
      groupDetail: {
        groups: [
          {
            order: 0,
            episodes: [
              { season_number: 1, episode_number: 1, order: 0 },
              { episode_number: 2, order: 1 },              // 缺 season_number → 跳过
              { season_number: 1, order: 2 },               // 缺 episode_number → 跳过
              { season_number: 1, episode_number: 3, order: 3 },
            ],
          },
        ],
      },
    })
    expect(await client.getAbsoluteOrder('120089')).toEqual([
      { season: 1, episode: 1 },
      { season: 1, episode: 3 },
    ])
  })

  it('多个 type===2 分组 → 取第一个', async () => {
    const { client, fetchImpl } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'abs-first', type: 2 }, { id: 'abs-second', type: 2 }] },
      groupDetail: { groups: [{ order: 0, episodes: [{ season_number: 1, episode_number: 1, order: 0 }] }] },
    })
    expect(await client.getAbsoluteOrder('120089')).toEqual([{ season: 1, episode: 1 }])
    // 详情端点必须请求的是第一个分组 id，不是第二个。
    const detailCall = fetchImpl.mock.calls.find(c => String(c[0]).includes('/episode_group/'))
    expect(String(detailCall?.[0])).toContain('/episode_group/abs-first')
    expect(String(detailCall?.[0])).not.toContain('abs-second')
  })

  it('groups 数组本身乱序（order 大的排前面）→ 展平序列仍按 group order 升序', async () => {
    const { client } = mkEpisodeGroupClient({
      groupsList: { results: [{ id: 'abs123', type: 2 }] },
      groupDetail: {
        groups: [
          { order: 2, episodes: [{ season_number: 3, episode_number: 1, order: 0 }] },
          { order: 1, episodes: [{ season_number: 2, episode_number: 1, order: 0 }] },
          { order: 0, episodes: [{ season_number: 1, episode_number: 1, order: 0 }] },
        ],
      },
    })
    expect(await client.getAbsoluteOrder('120089')).toEqual([
      { season: 1, episode: 1 },
      { season: 2, episode: 1 },
      { season: 3, episode: 1 },
    ])
  })
})
