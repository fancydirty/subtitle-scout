import { describe, it, expect } from 'vitest'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { makeCheckSeriesLayoutTool } from '../agent/orchestratorAgent.tools.js'
import { seedBacklog, makeBacklogFakes, type BacklogShape } from './seedBacklog.js'

// Same fakeOpts shape .execute! expects as its 2nd arg — see orchestratorAgent.tools.test.ts:11.
const fakeOpts = { toolCallId: 't1', messages: [] } as any

const shape: BacklogShape = {
  name: 'messy-plus-normal',
  represents: 'one absolute-numbering flat series + one normally-covered series + a missing movie',
  series: [
    {
      id: 'tmdb:100',
      seasons: [{ season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 }],
    },
    {
      id: 'tmdb:200',
      seasons: [{ season: 1, episodes: 12, missing: 2, tmdbEpisodeCount: 12 }],
    },
  ],
  movies: [{ id: 'mov', missing: true }],
  expected: {
    findSubtitle: [
      { seriesId: 'tmdb:100', season: 1, movieId: null },
      { seriesId: 'tmdb:200', season: 1, movieId: null },
      { seriesId: null, season: null, movieId: 'mov' },
    ],
    realignSeriesIds: ['tmdb:100'],
  },
}

describe('seedBacklog', () => {
  it('seeds a real LibraryRepo so countEpisodesInSeason/missingBySeason/missingMovies match the shape', () => {
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)

    seedBacklog(lib, shape)

    expect(lib.countEpisodesInSeason('tmdb:100', 1)).toBe(40)
    expect(lib.countEpisodesInSeason('tmdb:200', 1)).toBe(12)

    const missing = lib.missingBySeason(0)
    expect(missing.find(m => m.series_id === 'tmdb:100' && m.season === 1)?.missing).toBe(3)
    expect(missing.find(m => m.series_id === 'tmdb:200' && m.season === 1)?.missing).toBe(2)

    expect(lib.missingMovies(0).map(m => m.id)).toEqual(['mov'])
  })

  it('makeBacklogFakes drives check_series_layout to the shape\'s intended mirror-vs-TMDB relationship', async () => {
    const { tmdb } = makeBacklogFakes(shape)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    seedBacklog(lib, shape)

    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const messyResult = await checkSeriesLayout.execute!({ seriesId: 'tmdb:100', season: 1 }, fakeOpts)
    expect(messyResult).toEqual({
      mirrorEpisodeCount: 40, tmdbEpisodeCount: 25, exceedsSeasonTable: true,
      tmdbUnavailable: false, diskLayoutNonstandard: false,
    })

    const normalResult = await checkSeriesLayout.execute!({ seriesId: 'tmdb:200', season: 1 }, fakeOpts)
    expect(normalResult).toEqual({
      mirrorEpisodeCount: 12, tmdbEpisodeCount: 12, exceedsSeasonTable: false,
      tmdbUnavailable: false, diskLayoutNonstandard: false,
    })
  })
})
