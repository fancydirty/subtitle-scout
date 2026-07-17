import { describe, it, expect, vi } from 'vitest'
import { TmdbClient, TmdbRequestFailedError } from './tmdb.js'

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
    // 否则调用方（今天是 v2/ingest.ts 的 resolveOriginLang；同一区分点在已删除的 scanner.ts
    // 里也曾经需要）没法区分"该缓存哨兵"还是"该重试"。
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

describe('TmdbRequestFailedError', () => {
  it('sets name and chains the original error via cause (preserves stack instead of stringifying)', () => {
    const original = new Error('socket hang up')
    const err = new TmdbRequestFailedError(original)
    expect(err.name).toBe('TmdbRequestFailedError')
    expect(err.cause).toBe(original)
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

describe('TmdbClient.getSeasonEpisodes', () => {
  it('解析 /tv/{id}/season/{n} 的 episodes 数组，取 episode_number/name', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(new URL(String(url)).pathname).toBe('/3/tv/120089/season/1')
      return new Response(JSON.stringify({
        episodes: [
          { episode_number: 1, name: 'Pilot' },
          { episode_number: 2, name: '' }, // 空标题 → null
        ],
      }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getSeasonEpisodes('120089', 1)).toEqual([
      { episode: 1, title: 'Pilot' },
      { episode: 2, title: null },
    ])
  })

  it('404（该季不存在）→ null（真·无数据）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getSeasonEpisodes('120089', 99)).toBeNull()
  })

  it('网络故障 → 抛 TmdbRequestFailedError（瞬时，可重试，绝不当无数据）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getSeasonEpisodes('120089', 1)).rejects.toThrow(TmdbRequestFailedError)
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

describe('TmdbClient.getDetails', () => {
  it('tv: episode_run_time[0]/first_air_date 年份/original_name/poster_path/overview', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(new URL(String(url)).pathname).toBe('/3/tv/108964')
      return new Response(JSON.stringify({
        overview: 'A family of spies.',
        episode_run_time: [24, 25],
        first_air_date: '2022-04-09',
        original_name: 'SPY×FAMILY',
        poster_path: '/abc123.jpg',
      }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getDetails('tv', '108964')).toEqual({
      overview: 'A family of spies.',
      runtimeMinutes: 24,
      posterPath: '/abc123.jpg',
      originalTitle: 'SPY×FAMILY',
      year: 2022,
      genreIds: [],
    })
  })

  it('movie: runtime/release_date 年份/original_title/poster_path/overview', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(new URL(String(url)).pathname).toBe('/3/movie/603')
      return new Response(JSON.stringify({
        overview: 'A computer hacker learns...',
        runtime: 136,
        release_date: '1999-03-30',
        original_title: 'The Matrix',
        poster_path: '/matrix.jpg',
      }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getDetails('movie', '603')).toEqual({
      overview: 'A computer hacker learns...',
      runtimeMinutes: 136,
      posterPath: '/matrix.jpg',
      originalTitle: 'The Matrix',
      year: 1999,
      genreIds: [],
    })
  })

  it('missing/blank fields → all null (not crash), genreIds → []', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getDetails('tv', '1')).toEqual({
      overview: null, runtimeMinutes: null, posterPath: null, originalTitle: null, year: null,
      genreIds: [],
    })
  })

  // 验收修复轮一 Task V1（design §A）：genres[].id 解析——16=Animation 是 sectionOf 新规的
  // 判据来源，必须逐字段准确提取，不受其余 genre 字段（如 name）干扰。
  it('genres[].id → genreIds（如 [16,35]，16=Animation，动漫分区判据来源）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      genres: [{ id: 16, name: 'Animation' }, { id: 35, name: 'Comedy' }],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    const details = await client.getDetails('tv', '108964')
    expect(details?.genreIds).toEqual([16, 35])
  })

  it('genres 非数组或元素 id 非 number → 过滤兜底为 []（宁多防勿信脏数据）', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      genres: 'not-an-array',
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect((await client.getDetails('movie', '1'))?.genreIds).toEqual([])

    const fetchImpl2 = vi.fn(async () => new Response(JSON.stringify({
      genres: [{ id: 'bogus' }, { name: 'no id field' }, { id: 12 }],
    }), { status: 200 }))
    const client2 = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl2 as unknown as typeof fetch })
    expect((await client2.getDetails('movie', '1'))?.genreIds).toEqual([12])
  })

  it('404 → null（真·无数据，不是失败）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getDetails('movie', '999999')).toBeNull()
  })

  it('网络故障 → 抛 TmdbRequestFailedError（瞬时，可重试，绝不当无数据静默降级）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getDetails('tv', '108964')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('非 2xx（非 404）→ 抛 TmdbRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getDetails('tv', '108964')).rejects.toThrow(TmdbRequestFailedError)
  })
})

describe('TmdbClient.getExternalIds', () => {
  it('happy path → returns imdbId', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(new URL(String(url)).pathname).toBe('/3/movie/603/external_ids')
      return new Response(JSON.stringify({ imdb_id: 'tt0133093', wikidata_id: 123 }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getExternalIds('movie', '603')).toEqual({ imdbId: 'tt0133093' })
  })

  it('缺失/空串/非字符串 imdb_id → {imdbId: null}', async () => {
    const fetchImpl1 = vi.fn(async () => new Response(JSON.stringify({ imdb_id: '' }), { status: 200 }))
    const client1 = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl1 as unknown as typeof fetch })
    expect(await client1.getExternalIds('tv', '1')).toEqual({ imdbId: null })

    const fetchImpl2 = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }))
    const client2 = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl2 as unknown as typeof fetch })
    expect(await client2.getExternalIds('tv', '1')).toEqual({ imdbId: null })
  })

  it('404 → {imdbId: null}（真·无数据）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getExternalIds('movie', '999999')).toEqual({ imdbId: null })
  })

  it('网络/非 2xx/非 JSON 故障 → 抛 TmdbRequestFailedError（瞬时，可重试）', async () => {
    const fetchImpl1 = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const client1 = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl1 as unknown as typeof fetch })
    await expect(client1.getExternalIds('tv', '1')).rejects.toThrow(TmdbRequestFailedError)

    const fetchImpl2 = vi.fn(async () => new Response('server error', { status: 500 }))
    const client2 = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl2 as unknown as typeof fetch })
    await expect(client2.getExternalIds('tv', '1')).rejects.toThrow(TmdbRequestFailedError)

    const fetchImpl3 = vi.fn(async () => new Response('not json', { status: 200 }))
    const client3 = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl3 as unknown as typeof fetch })
    await expect(client3.getExternalIds('tv', '1')).rejects.toThrow(TmdbRequestFailedError)
  })
})

describe('TmdbClient.search', () => {
  it('tv: hits normalized from name/first_air_date, hits /search/tv with URL-encoded query', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url))
      expect(u.pathname).toBe('/3/search/tv')
      expect(u.searchParams.get('query')).toBe('Spy x Family')
      return new Response(JSON.stringify({
        results: [{ id: 108964, name: 'Spy x Family', original_name: 'SPY×FAMILY', first_air_date: '2022-04-09', original_language: 'ja', poster_path: '/abc123.jpg' }],
      }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    const hits = await client.search('tv', 'Spy x Family')
    expect(hits).toEqual([{ id: 108964, title: 'Spy x Family', originalTitle: 'SPY×FAMILY', year: 2022, posterPath: '/abc123.jpg' }])
  })

  it('poster_path missing/blank → posterPath null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { id: 1, name: 'No Poster' },
        { id: 2, name: 'Blank Poster', poster_path: '' },
      ],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    const hits = await client.search('tv', 'X')
    expect(hits.map(h => h.posterPath)).toEqual([null, null])
  })

  it('tv: year param maps to first_air_date_year (not "year")', async () => {
    let seenUrl = ''
    const fetchImpl = vi.fn(async (url: string | URL) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.search('tv', 'Show', 2016)
    const u = new URL(seenUrl)
    expect(u.searchParams.get('first_air_date_year')).toBe('2016')
    expect(u.searchParams.has('year')).toBe(false)
  })

  it('movie: hits normalized from title/release_date, hits /search/movie; year param maps to "year"', async () => {
    let seenUrl = ''
    const fetchImpl = vi.fn(async (url: string | URL) => {
      seenUrl = String(url)
      return new Response(JSON.stringify({
        results: [{ id: 603, title: 'The Matrix', original_title: 'The Matrix', release_date: '1999-03-30' }],
      }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    const hits = await client.search('movie', 'The Matrix', 1999)
    const u = new URL(seenUrl)
    expect(u.pathname).toBe('/3/search/movie')
    expect(u.searchParams.get('year')).toBe('1999')
    expect(u.searchParams.has('first_air_date_year')).toBe(false)
    expect(hits).toEqual([{ id: 603, title: 'The Matrix', originalTitle: 'The Matrix', year: 1999, posterPath: null }])
  })

  it('movie originalTitle comes from original_title (CJK-origin film); missing/blank → null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { id: 9550, title: 'Hero', original_title: '英雄', release_date: '2002-07-23' },
        { id: 9551, title: 'Hero 2', release_date: '2004-01-01' },
        { id: 9552, title: 'Hero 3', original_title: '', release_date: '2006-01-01' },
      ],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.search('movie', 'Hero')).toEqual([
      { id: 9550, title: 'Hero', originalTitle: '英雄', year: 2002, posterPath: null },
      { id: 9551, title: 'Hero 2', originalTitle: null, year: 2004, posterPath: null },
      { id: 9552, title: 'Hero 3', originalTitle: null, year: 2006, posterPath: null },
    ])
  })

  it('multiple results preserved in order; missing/blank date → year null', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { id: 1, name: 'Foo', first_air_date: '' },
        { id: 2, name: 'Foo 2', first_air_date: '2010-01-01' },
      ],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.search('tv', 'Foo')).toEqual([
      { id: 1, title: 'Foo', originalTitle: null, year: null, posterPath: null },
      { id: 2, title: 'Foo 2', originalTitle: null, year: 2010, posterPath: null },
    ])
  })

  it('empty results → []', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.search('movie', 'Nonexistent')).toEqual([])
  })

  it('v4 JWT token → Authorization: Bearer header, no api_key query param', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.payload.sig'
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: jwt, fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.search('tv', 'Show')
    expect(seenUrl).not.toContain('api_key')
    expect(seenInit?.headers).toMatchObject({ Authorization: `Bearer ${jwt}` })
  })

  it('v3 hex key → api_key query param, no Authorization header', async () => {
    const key = 'a'.repeat(32)
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url)
      seenInit = init
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    })
    const client = new TmdbClient({ apiKey: key, fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.search('movie', 'Show')
    expect(new URL(seenUrl).searchParams.get('api_key')).toBe(key)
    expect(seenInit?.headers).toBeUndefined()
  })

  it('request failure (network throw) → rejects with TmdbRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.search('tv', 'Show')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('request failure (non-2xx status) → rejects with TmdbRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => new Response('server error', { status: 500 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.search('tv', 'Show')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('request failure (non-JSON body) → rejects with TmdbRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.search('tv', 'Show')).rejects.toThrow(TmdbRequestFailedError)
  })

  it('404 → treated as no data (empty array), not a failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.search('tv', 'Show')).toEqual([])
  })
})
