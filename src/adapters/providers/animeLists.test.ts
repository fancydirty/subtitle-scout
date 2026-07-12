import { describe, it, expect, vi } from 'vitest'
import { fetchAnimeListsTable, entriesForTmdbTv, AnimeListsRequestFailedError } from './animeLists.js'

const SAMPLE = [
  {
    anidb_id: 14859, themoviedb_id: { tv: 120089 }, tvdb_id: 371980,
    season: { tvdb: 1, tmdb: 1 }, episode_offset: { tvdb: 0, tmdb: 0 },
  },
  {
    anidb_id: 17591, themoviedb_id: { tv: 120089 }, tvdb_id: 371980,
    season: { tvdb: 2, tmdb: 2 }, episode_offset: { tvdb: 25, tmdb: 25 },
  },
  { anidb_id: 1, themoviedb_id: {}, tvdb_id: 1, season: {}, episode_offset: {} }, // 无 tmdb 映射的条目
]

describe('fetchAnimeListsTable', () => {
  it('解析 Fribb anime-list-full.json 形状，抽取 tmdb tv id / season / episode offset', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const entries = await fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)
    expect(entries).toEqual([
      { anidbId: 14859, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: 0 },
      { anidbId: 17591, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: 25 },
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
    expect(entriesForTmdbTv(entries, 120089)).toHaveLength(2)
    expect(entriesForTmdbTv(entries, 999)).toHaveLength(0)
  })
})
