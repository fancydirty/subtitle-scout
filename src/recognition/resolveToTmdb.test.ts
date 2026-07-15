import { describe, it, expect, vi } from 'vitest'
import { resolveToTmdb, type Recognized, type ResolveResult } from './resolveToTmdb.js'
import type { PathIdentity } from './identifyFromPath.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'

function isPark(result: ResolveResult): result is { park: string } {
  return 'park' in result
}

/** Full PathIdentity fixture builder — every field explicit so each test only overrides what it's
 *  actually exercising (the interface has no optional fields, C2's contract). */
function identity(overrides: Partial<PathIdentity>): PathIdentity {
  return {
    title: null,
    year: null,
    season: null,
    episode: null,
    absoluteEpisode: null,
    isTv: false,
    embeddedTmdbId: null,
    ...overrides,
  }
}

function mkTmdb(fetchImpl: typeof fetch) {
  return new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('resolveToTmdb — embedded tmdbId short-circuit (no search, no network)', () => {
  it('embedded tmdbId → direct pass-through with identity fields unchanged', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({
      title: 'Show', year: 2016, season: 2, episode: 3, absoluteEpisode: null, isTv: true, embeddedTmdbId: '65930',
    })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '65930', title: 'Show', isTv: true, season: 2, episode: 3, absoluteEpisode: null,
    } satisfies Recognized)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('embedded tmdbId on a movie-shaped identity (isTv false) passes isTv through unchanged', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Movie', year: 2020, isTv: false, embeddedTmdbId: '603' })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '603', title: 'Movie', isTv: false, season: null, episode: null, absoluteEpisode: null,
    } satisfies Recognized)
  })

  it('embedded tmdbId with no title in identity → title normalizes to empty string, not null', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: null, isTv: true, embeddedTmdbId: '999' })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '999', title: '', isTv: true, season: null, episode: null, absoluteEpisode: null,
    } satisfies Recognized)
  })
})

describe('resolveToTmdb — no title', () => {
  it('no title → park no-title, no search attempted', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await resolveToTmdb(identity({ title: null }), tmdb)
    expect(result).toEqual({ park: 'no-title' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('resolveToTmdb — tv/movie search pool separation', () => {
  it('tv identity queries /search/tv only, never /search/movie', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/search/tv')
      expect(String(url)).not.toContain('/search/movie')
      return jsonResponse({ results: [{ id: 1, name: 'Show', first_air_date: '2020-01-01' }] })
    })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Show', season: 1, episode: 1, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(isPark(result)).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('movie identity queries /search/movie only, never /search/tv', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/search/movie')
      expect(String(url)).not.toContain('/search/tv')
      return jsonResponse({ results: [{ id: 603, title: 'The Matrix', release_date: '1999-03-30' }] })
    })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'The Matrix', year: 1999, isTv: false })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '603', title: 'The Matrix', isTv: false, season: null, episode: null, absoluteEpisode: null,
    } satisfies Recognized)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('resolveToTmdb — unique hit', () => {
  it('exactly one search hit → adopts TMDB-authoritative title/id, season/episode passed through unchanged', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: '间谍过家家', season: 1, episode: 1, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    } satisfies Recognized)
  })

  it('unique hit for an anime-absolute identity → absoluteEpisode passed through, season/episode null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ id: 65930, name: 'My Hero Academia', first_air_date: '2016-04-03' }],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'My Hero Academia', absoluteEpisode: 26, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '65930', title: 'My Hero Academia', isTv: true, season: null, episode: null, absoluteEpisode: 26,
    } satisfies Recognized)
  })
})

describe('resolveToTmdb — multi-hit disambiguation by exact year', () => {
  it('multiple hits + identity.year narrows to exactly one → adopts that hit', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        { id: 1, name: 'Foo', first_air_date: '2010-01-01' },
        { id: 2, name: 'Foo', first_air_date: '2016-01-01' },
      ],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Foo', year: 2016, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '2', title: 'Foo', isTv: true, season: null, episode: null, absoluteEpisode: null,
    } satisfies Recognized)
  })

  it('multiple hits, no identity.year to narrow with → park ambiguous', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        { id: 1, name: 'Foo', first_air_date: '2010-01-01' },
        { id: 2, name: 'Foo', first_air_date: '2016-01-01' },
      ],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Foo', year: null, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({ park: 'ambiguous' })
  })

  it('multiple hits, identity.year matches none of them → park ambiguous (never guesses)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        { id: 1, name: 'Foo', first_air_date: '2010-01-01' },
        { id: 2, name: 'Foo', first_air_date: '2016-01-01' },
      ],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Foo', year: 1999, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({ park: 'ambiguous' })
  })

  it('multiple hits, identity.year matches more than one of them → park ambiguous', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [
        { id: 1, name: 'Foo', first_air_date: '2016-01-01' },
        { id: 2, name: 'Foo', first_air_date: '2016-06-01' },
      ],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Foo', year: 2016, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({ park: 'ambiguous' })
  })
})

describe('resolveToTmdb — zero hits', () => {
  it('zero hits with a year in play → retries once without the year, then adopts a resulting unique hit', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url))
      if (u.searchParams.has('first_air_date_year')) return jsonResponse({ results: [] })
      return jsonResponse({ results: [{ id: 42, name: 'Foo', first_air_date: '1999-01-01' }] })
    })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Foo', year: 2020, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({
      tmdbId: '42', title: 'Foo', isTv: true, season: null, episode: null, absoluteEpisode: null,
    } satisfies Recognized)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('zero hits, still zero after the year-less retry → park no-match', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Nonexistent Show', year: 2020, isTv: true })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({ park: 'no-match' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('zero hits, no year to retry with → park no-match without a second call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const id = identity({ title: 'Nonexistent', year: null, isTv: false })
    const result = await resolveToTmdb(id, tmdb)
    expect(result).toEqual({ park: 'no-match' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
