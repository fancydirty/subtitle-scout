import { describe, it, expect, vi } from 'vitest'
import { recognize } from './index.js'
import { TmdbClient, TmdbRequestFailedError } from '../adapters/providers/tmdb.js'

function mkTmdb(fetchImpl: typeof fetch) {
  return new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('recognize — park at the path-identity stage short-circuits TMDB entirely', () => {
  it('no-signal path never touches tmdb.search', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('movies/aaa/bbb.mkv', tmdb)
    expect(result).toEqual({ park: 'no-signal' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('recognize — happy path, full path-to-Recognized chain', () => {
  it('Show/Season NN/file layout resolves via a unique TMDB hit', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/search/tv')
      return jsonResponse({
        results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
      })
    })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb)
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('recognize — park at the TMDB-resolution stage still passes through', () => {
  it('a well-formed identity with zero TMDB hits parks no-match (not path-level park)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('movies/Hero.2002.1080p.BluRay.mkv', tmdb)
    expect(result).toEqual({ park: 'no-match' })
    // one call with the scraped year, one retry without it — proves resolveToTmdb actually ran.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('recognize — transient TMDB failure propagates, is not swallowed into a park', () => {
  it('TmdbRequestFailedError from tmdb.search rejects recognize() rather than parking', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    await expect(recognize('movies/Hero.2002.1080p.BluRay.mkv', tmdb)).rejects.toThrow(TmdbRequestFailedError)
  })
})

// 去 Jellyfin 化 P6（identify_overrides 消歧前查）：opts.findOverride 是识别层唯一的覆盖表消费点。
describe('recognize — identify_overrides consult (opts.findOverride)', () => {
  it('override hit short-circuits TMDB search entirely — no network call', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '999', isTv: true }))
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '999', title: '间谍过家家', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(findOverride).toHaveBeenCalledWith('间谍过家家/Season 1/ep 1.mp4')
  })

  it('override isTv wins over path structure, but season/episode/absoluteEpisode still come from the path', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '42', isTv: false }))
    const result = await recognize('Show/Season 2/ep 3.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '42', title: 'Show', isTv: false, season: 2, episode: 3, absoluteEpisode: null,
    })
  })

  it('embedded [tmdbid-N] tag still wins first — override is never consulted', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '999', isTv: true }))
    const result = await recognize('Show [tmdbid-65930]/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect((result as { tmdbId: string }).tmdbId).toBe('65930')
    expect(findOverride).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no override hit (findOverride returns null) → falls through to normal TMDB search disambiguation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => null)
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('no opts passed at all → unchanged existing behavior (backward compatible)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb)
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
  })

  it('path-level park (zero signal) short-circuits before override is ever consulted', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '1', isTv: false }))
    const result = await recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({ park: 'no-signal' })
    expect(findOverride).not.toHaveBeenCalled()
  })
})
