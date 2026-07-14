import type { BacklogShape } from './seedBacklog.js'

/** Catalog of declarative library "shapes" the v3 orchestrator's dispatch judgment is tested
 *  against. Each shape's `expected` records the dispatch outcome the orchestrator SHOULD produce
 *  — asserted deterministically here (Phase 1: seeded-world consistency) and by the real-model
 *  judgment runner (Phase 2, not this file). The pole star across the whole catalog is
 *  zero-false-trigger on realign: `realignSeriesIds` must never include a series whose backlog is
 *  merely missing subtitles, only one whose mirror genuinely overshoots the TMDB season table. */
export const ORCHESTRATOR_BACKLOG_SHAPES: BacklogShape[] = [
  {
    name: 'clean',
    represents: 'a fully-covered library — nothing to dispatch',
    series: [{ id: 'ok', tmdbId: '1', seasons: [{ season: 1, episodes: 12, missing: 0, tmdbEpisodeCount: 12 }] }],
    movies: [{ id: 'okmov', missing: false }],
    expected: { findSubtitle: [], realignSeriesIds: [] },
  },
  {
    name: 'normal-missing',
    represents: 'a normal series with a handful of missing episodes in one season — find_subtitle only',
    series: [{ id: 'norm', tmdbId: '2', seasons: [{ season: 1, episodes: 12, missing: 3, tmdbEpisodeCount: 12 }] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 'norm', season: 1, movieId: null }], realignSeriesIds: [] },
  },
  {
    name: 'messy-realign',
    represents: 'an absolute-numbering flat series whose mirror overshoots the TMDB season table — realign, not find_subtitle',
    series: [{ id: 'mess', tmdbId: '3', seasons: [{ season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 }] }],
    movies: [],
    expected: { findSubtitle: [], realignSeriesIds: ['mess'] },
  },
  {
    name: 'one-season',
    represents: 'a single season entirely missing (e.g. a freshly-added series) — find_subtitle only',
    series: [{ id: 's', tmdbId: '4', seasons: [{ season: 2, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 's', season: 2, movieId: null }], realignSeriesIds: [] },
  },
  {
    name: 'mixed-partial-and-full',
    represents: 'one series with a fully-missing season, a partially-missing season, and a fully-covered season — find_subtitle for the two incomplete seasons only',
    series: [{
      id: 'mix', tmdbId: '5',
      seasons: [
        { season: 1, episodes: 12, missing: 12, tmdbEpisodeCount: 12 },
        { season: 2, episodes: 12, missing: 2, tmdbEpisodeCount: 12 },
        { season: 3, episodes: 12, missing: 0, tmdbEpisodeCount: 12 },
      ],
    }],
    movies: [],
    expected: {
      findSubtitle: [
        { seriesId: 'mix', season: 1, movieId: null },
        { seriesId: 'mix', season: 2, movieId: null },
      ],
      realignSeriesIds: [],
    },
  },
  {
    name: 'realign-and-find-same-series',
    represents: 'one series where season 1 is a messy realign candidate and season 2 is a normal missing-episodes season — a realign-candidate series gets a realign dispatch and NOTHING else this pass; its season-2 find is DEFERRED to a later pass (after realign restructures the layout and the rescan refreshes the living-doc), so dispatching find now would target files about to move',
    series: [{
      id: 'both', tmdbId: '6',
      seasons: [
        { season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 },
        { season: 2, episodes: 12, missing: 4, tmdbEpisodeCount: 12 },
      ],
    }],
    movies: [],
    expected: {
      // find DEFERRED — a realign-candidate series gets realign only this pass (see orchestratorSkill.ts step 2).
      findSubtitle: [],
      realignSeriesIds: ['both'],
    },
  },
]
