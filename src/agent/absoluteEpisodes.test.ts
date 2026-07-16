import { describe, it, expect } from 'vitest'
import {
  buildFromSeasonConcat, absoluteFor, buildFromAbsoluteOrder, resolveAbsoluteEpisode,
  seasonEpisodeFor, seasonEpisodeForAbsolute, resolveAbsoluteTable,
} from './absoluteEpisodes.js'

describe('buildFromSeasonConcat', () => {
  it('assigns absolute numbers by concatenating seasons in order', () => {
    const t = buildFromSeasonConcat([
      { seasonNumber: 1, episodeCount: 25 },
      { seasonNumber: 2, episodeCount: 12 },
    ])
    expect(t.totalEpisodes).toBe(37)
    expect(t.source).toBe('tmdb-season-concat')
    expect(t.reliable).toBe(true)
    expect(t.entries).toContainEqual({ absolute: 1, season: 1, episode: 1 })
    expect(t.entries).toContainEqual({ absolute: 25, season: 1, episode: 25 })
    expect(t.entries).toContainEqual({ absolute: 26, season: 2, episode: 1 })
    expect(t.entries).toContainEqual({ absolute: 37, season: 2, episode: 12 })
  })
  it('is unreliable (empty) when the season list is empty or malformed', () => {
    expect(buildFromSeasonConcat([]).reliable).toBe(false)
    expect(buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 0 }]).reliable).toBe(false)
  })
  it('sorts seasons by number before concatenating (defensive against unsorted input)', () => {
    const t = buildFromSeasonConcat([
      { seasonNumber: 2, episodeCount: 12 },
      { seasonNumber: 1, episodeCount: 25 },
    ])
    expect(t.entries).toContainEqual({ absolute: 26, season: 2, episode: 1 })
  })
})
describe('absoluteFor', () => {
  it('returns the absolute number for a (season, episode)', () => {
    const t = buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }])
    expect(absoluteFor(t, 2, 1)).toBe(26)
    expect(absoluteFor(t, 1, 1)).toBe(1)
  })
  it('returns null for an out-of-range or unknown (season, episode)', () => {
    const t = buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 25 }])
    expect(absoluteFor(t, 2, 1)).toBeNull()
    expect(absoluteFor(t, 1, 99)).toBeNull()
  })
  it('returns null on an unreliable table', () => {
    expect(absoluteFor(buildFromSeasonConcat([]), 1, 1)).toBeNull()
  })
})
describe('buildFromAbsoluteOrder', () => {
  it('numbers episodes by the official absolute order, not by season concatenation', () => {
    const t = buildFromAbsoluteOrder([
      { season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 2, episode: 1 },
    ])
    expect(t.source).toBe('tmdb-episode-group')
    expect(t.reliable).toBe(true)
    expect(t.totalEpisodes).toBe(3)
    expect(t.entries).toEqual([
      { absolute: 1, season: 1, episode: 1 },
      { absolute: 2, season: 1, episode: 2 },
      { absolute: 3, season: 2, episode: 1 },
    ])
  })
  it('is unreliable when the ordered list is empty', () => {
    expect(buildFromAbsoluteOrder([]).reliable).toBe(false)
  })
})
describe('resolveAbsoluteEpisode', () => {
  const seasons = [{ seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }]
  it('prefers the official absolute group when present', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, {
      getSeasonTable: async () => seasons,
      getAbsoluteOrder: async () => [{ season: 1, episode: 1 }, { season: 2, episode: 1 }],
    })
    expect(absolute).toBe(2)
  })
  it('falls back to season concatenation when there is no official group', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, { getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null })
    expect(absolute).toBe(26)
  })
  it('returns null (never throws) when TMDB lookups fail', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, { getSeasonTable: async () => { throw new Error('tmdb down') }, getAbsoluteOrder: async () => null })
    expect(absolute).toBeNull()
  })
  it('degrades to concat when getAbsoluteOrder THROWS but getSeasonTable succeeds (no fallback-denial)', async () => {
    // 官方分组查询瞬时失败绝不能吞掉 concat 兜底——否则一次抖动会让本可算出的绝对集号退化成 null。
    const absolute = await resolveAbsoluteEpisode(2, 1, {
      getSeasonTable: async () => seasons,
      getAbsoluteOrder: async () => { throw new Error('episode-group lookup blew up') },
    })
    expect(absolute).toBe(26)
  })
  it('returns null when BOTH lookups throw', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, {
      getSeasonTable: async () => { throw new Error('tmdb down') },
      getAbsoluteOrder: async () => { throw new Error('episode-group down') },
    })
    expect(absolute).toBeNull()
  })
  it('returns null for a null season/episode (movies / unknown)', async () => {
    const absolute = await resolveAbsoluteEpisode(null, null, { getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null })
    expect(absolute).toBeNull()
  })
})
describe('seasonEpisodeFor (reverse table lookup)', () => {
  it('returns the (season, episode) for an absolute number', () => {
    const t = buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }])
    expect(seasonEpisodeFor(t, 26)).toEqual({ season: 2, episode: 1 })
    expect(seasonEpisodeFor(t, 1)).toEqual({ season: 1, episode: 1 })
  })
  it('returns null for an out-of-range absolute number', () => {
    const t = buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 25 }])
    expect(seasonEpisodeFor(t, 26)).toBeNull()
    expect(seasonEpisodeFor(t, 0)).toBeNull()
  })
  it('returns null on an unreliable table', () => {
    expect(seasonEpisodeFor(buildFromSeasonConcat([]), 1)).toBeNull()
  })
})
describe('seasonEpisodeForAbsolute', () => {
  const seasons = [{ seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }]
  it('prefers the official absolute group when present (order may disagree with season concat)', async () => {
    const resolved = await seasonEpisodeForAbsolute(2, {
      getSeasonTable: async () => seasons,
      // 官方顺序刻意与 concat 顺序不同：绝对 2 在官方表里直接跳到 S2E1（concat 会给 S1E2）——
      // 断言命中的必须是官方表。
      getAbsoluteOrder: async () => [{ season: 1, episode: 1 }, { season: 2, episode: 1 }],
    }, '120089')
    expect(resolved).toEqual({ season: 2, episode: 1 })
  })
  it('falls back to season concatenation when there is no official group', async () => {
    const resolved = await seasonEpisodeForAbsolute(26, { getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null }, '120089')
    expect(resolved).toEqual({ season: 2, episode: 1 })
  })
  it('degrades to concat when getAbsoluteOrder THROWS but getSeasonTable succeeds (no fallback-denial — mirrors the forward direction)', async () => {
    const resolved = await seasonEpisodeForAbsolute(26, {
      getSeasonTable: async () => seasons,
      getAbsoluteOrder: async () => { throw new Error('episode-group lookup blew up') },
    }, '120089')
    expect(resolved).toEqual({ season: 2, episode: 1 })
  })
  it('official group present but absolute out of ITS range → null, no cascade to concat (the official table is authoritative for the show)', async () => {
    const resolved = await seasonEpisodeForAbsolute(3, {
      getSeasonTable: async () => seasons, // concat 表能查到 3——若错误级联就会返回 S1E3
      getAbsoluteOrder: async () => [{ season: 1, episode: 1 }, { season: 1, episode: 2 }],
    }, '120089')
    expect(resolved).toBeNull()
  })
  it('absolute out of range of the concat fallback too → null', async () => {
    const resolved = await seasonEpisodeForAbsolute(1000, { getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null }, '120089')
    expect(resolved).toBeNull()
  })
  it('returns null (never throws) when BOTH lookups throw', async () => {
    const resolved = await seasonEpisodeForAbsolute(26, {
      getSeasonTable: async () => { throw new Error('tmdb down') },
      getAbsoluteOrder: async () => { throw new Error('episode-group down') },
    }, '120089')
    expect(resolved).toBeNull()
  })
  it('returns null when the season table is genuinely absent (404 no-data)', async () => {
    const resolved = await seasonEpisodeForAbsolute(26, { getSeasonTable: async () => null, getAbsoluteOrder: async () => null }, '120089')
    expect(resolved).toBeNull()
  })
})
describe('resolveAbsoluteTable', () => {
  it('resolveAbsoluteTable: 官方分组优先，季表兜底，两路独立 try/catch', async () => {
    const src = {
      getAbsoluteOrder: async () => { throw new Error('flaky') },
      getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 2 }, { seasonNumber: 2, episodeCount: 3 }],
    }
    const table = await resolveAbsoluteTable(src, '42')
    expect(table).not.toBeNull()
    expect(absoluteFor(table!, 2, 1)).toBe(3)
  })
  it('resolveAbsoluteTable: 官方分组非空时用官方表，不级联季表', async () => {
    const src = {
      getAbsoluteOrder: async () => [{ season: 1, episode: 1 }, { season: 2, episode: 1 }],
      getSeasonTable: async () => { throw new Error('must not be called') },
    }
    const table = await resolveAbsoluteTable(src, '42')
    expect(absoluteFor(table!, 2, 1)).toBe(2)
  })
})
