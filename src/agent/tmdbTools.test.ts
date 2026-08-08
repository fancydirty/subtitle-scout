import { describe, it, expect, vi } from 'vitest'
import { makeTmdbEvidenceTools, type TmdbEvidenceToolsDeps } from './tmdbTools.js'
import type { SeasonTableEntry, TmdbDetails, TmdbSearchHit } from '../adapters/providers/tmdb.js'

function fakeDeps(overrides: Partial<TmdbEvidenceToolsDeps> = {}): TmdbEvidenceToolsDeps {
  return {
    tmdb: {
      search: vi.fn(async () => [] as TmdbSearchHit[]),
      getDetails: vi.fn(async () => null as TmdbDetails | null),
      getSeasonTable: vi.fn(async () => null as SeasonTableEntry[] | null),
    },
    ...overrides,
  }
}

describe('makeTmdbEvidenceTools', () => {
  it('search_tmdb returns normalized hits without posterPath', async () => {
    const tmdb = {
      search: vi.fn(async (_mediaType: 'tv' | 'movie', _query: string, _year?: number) => [
        { id: 123, title: 'Show', originalTitle: 'Original', year: 2024, posterPath: '/poster.jpg' },
      ] as TmdbSearchHit[]),
      getDetails: vi.fn(),
      getSeasonTable: vi.fn(),
    }
    const tools = makeTmdbEvidenceTools(fakeDeps({ tmdb }))
    const result = await tools.search_tmdb.execute({ query: 'Show', mediaType: 'tv', year: 2024 }, {} as any)
    expect(result).toEqual({
      hits: [{ id: '123', title: 'Show', originalTitle: 'Original', year: 2024 }],
    })
    expect(tmdb.search).toHaveBeenCalledWith('tv', 'Show', 2024)
  })

  it('search_tmdb works without a year filter', async () => {
    const tmdb = fakeDeps().tmdb
    const tools = makeTmdbEvidenceTools({ tmdb })
    const result = await tools.search_tmdb.execute({ query: 'Show', mediaType: 'movie' }, {} as any)
    expect(result).toEqual({ hits: [] })
    expect(tmdb.search).toHaveBeenCalledWith('movie', 'Show', undefined)
  })

  it('get_tmdb_details returns details and season table for tv', async () => {
    const details: TmdbDetails = {
      title: 'Show',
      overview: 'Overview',
      runtimeMinutes: 24,
      posterPath: null,
      backdropPath: null,
      originalTitle: null,
      year: 2024,
      genreIds: [],
    }
    const seasons: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 12, airDate: null }]
    const tmdb = {
      search: vi.fn(),
      getDetails: vi.fn(async (_mediaType: 'tv' | 'movie', _id: string) => details),
      getSeasonTable: vi.fn(async (_id: string) => seasons),
    }
    const tools = makeTmdbEvidenceTools(fakeDeps({ tmdb }))
    const result = await tools.get_tmdb_details.execute({ tmdbId: '123', isTv: true }, {} as any)
    expect(result).toEqual({ details, seasons })
    expect(tmdb.getDetails).toHaveBeenCalledWith('tv', '123')
    expect(tmdb.getSeasonTable).toHaveBeenCalledWith('123')
  })

  it('get_tmdb_details skips the season table for movies', async () => {
    const tmdb = {
      search: vi.fn(),
      getDetails: vi.fn(async () => null),
      getSeasonTable: vi.fn(async () => null),
    }
    const tools = makeTmdbEvidenceTools(fakeDeps({ tmdb }))
    const result = await tools.get_tmdb_details.execute({ tmdbId: '456', isTv: false }, {} as any)
    expect(result).toEqual({ details: null, seasons: null })
    expect(tmdb.getDetails).toHaveBeenCalledWith('movie', '456')
    expect(tmdb.getSeasonTable).not.toHaveBeenCalled()
  })
})
