import { describe, it, expect } from 'vitest'
import { buildFromSeasonConcat, absoluteFor, buildFromAbsoluteOrder, resolveAbsoluteEpisode } from './absoluteEpisodes.js'

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
  it('returns null for a null season/episode (movies / unknown)', async () => {
    const absolute = await resolveAbsoluteEpisode(null, null, { getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null })
    expect(absolute).toBeNull()
  })
})
