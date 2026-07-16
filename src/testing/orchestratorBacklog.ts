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
    series: [{ id: 'tmdb:1', seasons: [{ season: 1, episodes: 12, missing: 0, tmdbEpisodeCount: 12 }] }],
    movies: [{ id: 'okmov', missing: false }],
    expected: { findSubtitle: [], realignSeriesIds: [] },
  },
  {
    name: 'normal-missing',
    represents: 'a normal series with a handful of missing episodes in one season — find_subtitle only',
    series: [{ id: 'tmdb:2', seasons: [{ season: 1, episodes: 12, missing: 3, tmdbEpisodeCount: 12 }] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 'tmdb:2', season: 1, movieId: null }], realignSeriesIds: [] },
  },
  {
    name: 'messy-realign',
    represents: 'an absolute-numbering flat series whose mirror overshoots the TMDB season table — realign, not find_subtitle',
    series: [{ id: 'tmdb:3', seasons: [{ season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 }] }],
    movies: [],
    expected: { findSubtitle: [], realignSeriesIds: ['tmdb:3'] },
  },
  {
    name: 'one-season',
    represents: 'a single season entirely missing (e.g. a freshly-added series) — find_subtitle only',
    series: [{ id: 'tmdb:4', seasons: [{ season: 2, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 'tmdb:4', season: 2, movieId: null }], realignSeriesIds: [] },
  },
  {
    name: 'mixed-partial-and-full',
    represents: 'one series with a fully-missing season, a partially-missing season, and a fully-covered season — find_subtitle for the two incomplete seasons only',
    series: [{
      id: 'tmdb:5',
      seasons: [
        { season: 1, episodes: 12, missing: 12, tmdbEpisodeCount: 12 },
        { season: 2, episodes: 12, missing: 2, tmdbEpisodeCount: 12 },
        { season: 3, episodes: 12, missing: 0, tmdbEpisodeCount: 12 },
      ],
    }],
    movies: [],
    expected: {
      findSubtitle: [
        { seriesId: 'tmdb:5', season: 1, movieId: null },
        { seriesId: 'tmdb:5', season: 2, movieId: null },
      ],
      realignSeriesIds: [],
    },
  },
  {
    name: 'realign-and-find-same-series',
    represents: 'one series where season 1 is a messy realign candidate and season 2 is a normal missing-episodes season — a realign-candidate series gets a realign dispatch and NOTHING else this pass; its season-2 find is DEFERRED to a later pass (after realign restructures the layout and the rescan refreshes the living-doc), so dispatching find now would target files about to move',
    series: [{
      id: 'tmdb:6',
      seasons: [
        { season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 },
        { season: 2, episodes: 12, missing: 4, tmdbEpisodeCount: 12 },
      ],
    }],
    movies: [],
    expected: {
      // find DEFERRED — a realign-candidate series gets realign only this pass (see orchestratorSkill.ts step 2).
      findSubtitle: [],
      realignSeriesIds: ['tmdb:6'],
    },
  },
  {
    name: 'over-cap-spillover',
    // R-11（范围裁量化）修形：原形态是"一部剧三个季"——旧世界=三个独立身份能撞 cap；新世界
    // 模型一单全剧就配完（后续重复派发 coalesced 不耗预算，T8b 语义），前提死亡（D3 复跑
    // 2026-07-16 实测 <NO-SIBLING-SPAWN>）。改成五部各缺一季的剧：五个独立身份 vs cap=2，
    // 逼出 escape valve 的语义不变。
    represents: 'FIVE normal (non-realign) series each with a dispatchable season — more ' +
      'independent identities than a deliberately-low, test-only dispatch cap (capOverride: 2, ' +
      'vs the real 100) — the model must hit the cap-reached escape valve ' +
      '(spawn_sibling_orchestrator) after 2 dispatches instead of either silently truncating ' +
      'the backlog or dispatching past its own budget.',
    capOverride: 2,
    series: [
      { id: 'tmdb:71', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
      { id: 'tmdb:72', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
      { id: 'tmdb:73', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
      { id: 'tmdb:74', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
      { id: 'tmdb:75', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
    ],
    movies: [],
    expected: {
      // Not asserting which specific finds landed (only 2 of the 3 seasons fit under the cap,
      // and which 2 is the model's call) — the assertion for this shape is the cap+sibling-spawn
      // invariant below, checked by the runner's expectSiblingSpawn path.
      findSubtitle: [],
      realignSeriesIds: [],
      expectSiblingSpawn: true,
    },
  },
]
