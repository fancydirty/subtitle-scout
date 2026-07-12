import { describe, it, expect, vi } from 'vitest'
import { fetchAnimeListsTable, entriesForTmdbTv, AnimeListsRequestFailedError } from './animeLists.js'

// 真实形状（live anime-list-full.json 实测，SPY×FAMILY tmdb tv 120089）：
// 季界条目（cour 1 / 整季起点）没有 episode_offset 字段；mid-cour 条目才携带（季内偏移）。
const SAMPLE = [
  {
    type: 'TV', anidb_id: 16947, themoviedb_id: { tv: 120089 }, tvdb_id: 405920,
    season: { tvdb: 1, tmdb: 1 }, // S1 cour 1：无 episode_offset
  },
  {
    type: 'TV', anidb_id: 17061, themoviedb_id: { tv: 120089 }, tvdb_id: 405920,
    season: { tvdb: 1, tmdb: 1 }, episode_offset: { tvdb: 12, tmdb: 12 }, // S1 cour 2（Part II）
  },
  {
    type: 'TV', anidb_id: 17784, themoviedb_id: { tv: 120089 }, tvdb_id: 405920,
    season: { tvdb: 2, tmdb: 2 }, // S2：无 episode_offset
  },
  { anidb_id: 1, themoviedb_id: {}, tvdb_id: 1, season: {}, episode_offset: {} }, // 无 tmdb 映射的条目
]

describe('fetchAnimeListsTable', () => {
  it('解析 Fribb anime-list-full.json 真实形状：季界条目 offset=null，mid-cour 条目才有季内偏移', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const entries = await fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)
    expect(entries).toEqual([
      { anidbId: 16947, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: null },
      { anidbId: 17061, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: 12 },
      { anidbId: 17784, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: null },
      { anidbId: 1, tmdbTvId: null, tmdbSeason: null, tmdbEpisodeOffset: null },
    ])
  })

  it('非 2xx → 抛 AnimeListsRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }))
    await expect(fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)).rejects.toThrow(AnimeListsRequestFailedError)
  })

  it('entriesForTmdbTv：按 tmdbTvId 过滤', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const entries = await fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)
    expect(entriesForTmdbTv(entries, 120089)).toHaveLength(3)
    expect(entriesForTmdbTv(entries, 999)).toHaveLength(0)
  })
})
