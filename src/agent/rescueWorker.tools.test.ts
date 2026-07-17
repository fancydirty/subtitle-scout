import { describe, it, expect, vi } from 'vitest'
import { makeRescueWorkerTools, type RescueWorkerToolsDeps } from './rescueWorker.tools.js'
import type { SeasonTableEntry, TmdbDetails, TmdbSearchHit } from '../adapters/providers/tmdb.js'

function fakeDeps(overrides: Partial<RescueWorkerToolsDeps> = {}): RescueWorkerToolsDeps {
  return {
    tmdb: {
      search: vi.fn(async () => [] as TmdbSearchHit[]),
      getDetails: vi.fn(async () => null as TmdbDetails | null),
      getSeasonTable: vi.fn(async () => null as SeasonTableEntry[] | null),
    },
    taskDirs: new Set(['/media/A', '/media/B']),
    ...overrides,
  }
}

describe('makeRescueWorkerTools', () => {
  it('search_tmdb returns normalized hits without posterPath', async () => {
    const tmdb = {
      search: vi.fn(async (_mediaType: 'tv' | 'movie', _query: string, _year?: number) => [
        { id: 123, title: 'Show', originalTitle: 'Original', year: 2024, posterPath: '/poster.jpg' },
      ] as TmdbSearchHit[]),
      getDetails: vi.fn(),
      getSeasonTable: vi.fn(),
    }
    const tools = makeRescueWorkerTools(fakeDeps({ tmdb }))
    const result = await tools.search_tmdb.execute({ query: 'Show', mediaType: 'tv', year: 2024 }, {} as any)
    expect(result).toEqual({
      hits: [{ id: '123', title: 'Show', originalTitle: 'Original', year: 2024 }],
    })
    expect(tmdb.search).toHaveBeenCalledWith('tv', 'Show', 2024)
  })

  it('get_tmdb_details returns details and season table for tv', async () => {
    const details: TmdbDetails = {
      overview: 'Overview',
      runtimeMinutes: 24,
      posterPath: null,
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
    const tools = makeRescueWorkerTools(fakeDeps({ tmdb }))
    const result = await tools.get_tmdb_details.execute({ tmdbId: '123', isTv: true }, {} as any)
    expect(result).toEqual({ details, seasons })
    expect(tmdb.getDetails).toHaveBeenCalledWith('tv', '123')
    expect(tmdb.getSeasonTable).toHaveBeenCalledWith('123')
  })

  it('claim_directory records a valid decision', async () => {
    const tools = makeRescueWorkerTools(fakeDeps())
    const result = await tools.claim_directory.execute({ dir: '/media/A', tmdbId: '123', isTv: true, season: 1 }, {} as any)
    expect(result).toEqual({
      recorded: true,
      decision: { dir: '/media/A', tmdbId: '123', isTv: true, season: 1 },
      note: 'decision recorded — include it in your finalize report; nothing is applied until finalize',
    })
  })

  it('exclude_extras records a valid decision', async () => {
    const tools = makeRescueWorkerTools(fakeDeps())
    const result = await tools.exclude_extras.execute({ dir: '/media/A' }, {} as any)
    expect(result).toEqual({
      recorded: true,
      decision: { dir: '/media/A', outcome: 'excluded' },
      note: 'decision recorded — include it in your finalize report; nothing is applied until finalize',
    })
  })

  it('keep_parked records a valid decision', async () => {
    const tools = makeRescueWorkerTools(fakeDeps())
    const result = await tools.keep_parked.execute({ dir: '/media/B', reason: 'ambiguous candidates' }, {} as any)
    expect(result).toEqual({
      recorded: true,
      decision: { dir: '/media/B', outcome: 'parked', reason: 'ambiguous candidates' },
      note: 'decision recorded — include it in your finalize report; nothing is applied until finalize',
    })
  })

  it('claim_directory rejects unknown directory', async () => {
    const tools = makeRescueWorkerTools(fakeDeps())
    const result = await tools.claim_directory.execute({ dir: '/media/Unknown', tmdbId: '123', isTv: false }, {} as any)
    expect(result).toEqual({ error: 'unknown directory: /media/Unknown' })
  })

  it('claim_directory rejects non-numeric tmdbId', async () => {
    const tools = makeRescueWorkerTools(fakeDeps())
    // Bypass inputSchema validation by calling execute directly with an invalid string.
    const result = await tools.claim_directory.execute({ dir: '/media/A', tmdbId: 'abc', isTv: false } as any, {} as any)
    expect(result).toEqual({ error: 'tmdbId must be a numeric string: abc' })
  })
})
