import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { tmdbIdFromOwnId } from '../v2/ownIds.js'

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
  /** 去 Jellyfin 化 P2/P4: own-id space series id ('tmdb:<TMDB id>', see src/v2/ownIds.ts). The
   *  TMDB id lives INSIDE this id (no separate tmdbId field any more) — makeCheckSeriesLayoutTool
   *  extracts it via tmdbIdFromOwnId(id), a pure string parse with zero I/O. Build it with
   *  ownIds.seriesId(tmdbId), e.g. seriesId('10') === 'tmdb:10'. A non-conforming id (not matching
   *  the 'tmdb:<id>' shape) is a valid way to exercise the tool's graceful degraded path
   *  (tmdbIdFromOwnId returns null → exceedsSeasonTable:false, never throws). */
  id: string
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
  /** Override for `maxDispatchesPerOrchestrator` when the real-model matrix runner (Phase 2) runs
   *  this shape — undefined = the runner's default (100). Exists so a shape can cheaply exercise
   *  the cap-reached escape valve (spawn_sibling_orchestrator) at a low, test-only cap instead of
   *  needing a real 100-dispatch run against a live model just to reach the real cap. */
  capOverride?: number
  expected: {
    findSubtitle: { seriesId: string | null; season: number | null; movieId: string | null }[]
    realignSeriesIds: string[]
    /** when true, the real-model matrix runner additionally requires that the model called
     *  spawn_sibling_orchestrator after exhausting this shape's dispatch budget (capOverride, or
     *  the default 100 if capOverride is unset), and that no more worker_task rows landed than
     *  that budget allowed. */
    expectSiblingSpawn?: boolean
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

/** Build a tmdb fake so check_series_layout sees the shape's intended mirror-vs-TMDB relationship.
 *  去 Jellyfin 化 P4: no more `jf` fake — the tool resolves tmdbId straight out of seriesId itself
 *  (tmdbIdFromOwnId), so there's nothing left for a Jellyfin lookup to fake. */
export function makeBacklogFakes(shape: BacklogShape): {
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
} {
  const seasonTableByTmdbId = new Map<string, { seasonNumber: number; episodeCount: number; airDate: null }[]>()
  for (const s of shape.series) {
    const tmdbId = tmdbIdFromOwnId(s.id)
    if (tmdbId != null) {
      seasonTableByTmdbId.set(tmdbId, s.seasons
        .filter(se => se.tmdbEpisodeCount != null)
        .map(se => ({ seasonNumber: se.season, episodeCount: se.tmdbEpisodeCount!, airDate: null })))
    }
  }
  return {
    tmdb: { getSeasonTable: async (tmdbId: string) => seasonTableByTmdbId.get(tmdbId) ?? null },
  }
}
