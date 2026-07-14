import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { PlayerServer } from '../adapters/players/types.js'

export interface BacklogSeasonSpec {
  season: number
  /** total episodes seeded — becomes the mirror count (countEpisodesInSeason). */
  episodes: number
  /** the first `missing` episodes get subStatus 'missing' (→ missingBySeason), the rest 'covered'. */
  missing: number
  /** what the faked tmdb.getSeasonTable reports for this season; null = TMDB has no count. */
  tmdbEpisodeCount: number | null
}
export interface BacklogSeriesSpec {
  id: string
  /** faked jf.getItem(id) returns { ProviderIds: { Tmdb: tmdbId } }; null = unresolvable. */
  tmdbId: string | null
  seasons: BacklogSeasonSpec[]
}
export interface BacklogMovieSpec { id: string; missing: boolean }

/** A declarative library "shape" + the dispatch outcome the orchestrator SHOULD produce for it.
 *  `expected` is asserted by the real-model runner (Phase 2) + the plumbing test; realignSeriesIds
 *  empty = the zero-false-trigger pole star (the orchestrator must NOT dispatch destructive realign). */
export interface BacklogShape {
  name: string
  represents: string
  series: BacklogSeriesSpec[]
  movies: BacklogMovieSpec[]
  expected: {
    findSubtitle: { seriesId: string | null; season: number | null; movieId: string | null }[]
    realignSeriesIds: string[]
  }
}

/** Seed a real (in-memory) LibraryRepo to match the shape: episodes per season (mirror count),
 *  first `missing` of each season marked 'missing' (rest 'covered'), movies missing/covered. */
export function seedBacklog(lib: LibraryRepo, shape: BacklogShape): void {
  for (const s of shape.series) {
    lib.upsertSeries({ id: s.id, name: s.id })
    for (const se of s.seasons) {
      for (let ep = 1; ep <= se.episodes; ep++) {
        lib.upsertEpisode({
          id: `${s.id}-s${se.season}e${ep}`, seriesId: s.id, season: se.season, episode: ep,
          name: `E${ep}`, path: `/media/${s.id}/S${se.season}/e${ep}.mkv`,
          subStatus: ep <= se.missing ? 'missing' : 'covered',
        })
      }
    }
  }
  for (const m of shape.movies) {
    lib.upsertMovie({ id: m.id, name: m.id, path: `/media/${m.id}.mkv`, subStatus: m.missing ? 'missing' : 'covered' })
  }
}

/** Build tmdb/jf fakes so check_series_layout sees the shape's intended mirror-vs-TMDB relationship. */
export function makeBacklogFakes(shape: BacklogShape): {
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
  jf: Pick<PlayerServer, 'getItem'>
} {
  const seasonTableByTmdbId = new Map<string, { seasonNumber: number; episodeCount: number; airDate: null }[]>()
  const tmdbIdBySeries = new Map<string, string | null>()
  for (const s of shape.series) {
    tmdbIdBySeries.set(s.id, s.tmdbId)
    if (s.tmdbId != null) {
      seasonTableByTmdbId.set(s.tmdbId, s.seasons
        .filter(se => se.tmdbEpisodeCount != null)
        .map(se => ({ seasonNumber: se.season, episodeCount: se.tmdbEpisodeCount!, airDate: null })))
    }
  }
  return {
    tmdb: { getSeasonTable: async (tmdbId: string) => seasonTableByTmdbId.get(tmdbId) ?? null },
    jf: {
      getItem: async (id: string) => {
        const tmdbId = tmdbIdBySeries.get(id)
        return (tmdbId != null ? { ProviderIds: { Tmdb: tmdbId } } : null) as any
      },
    },
  }
}
