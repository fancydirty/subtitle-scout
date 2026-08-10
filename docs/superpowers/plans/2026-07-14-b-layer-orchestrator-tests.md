# B-Layer Orchestrator Test Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test the v3 orchestrator (main agent) as the rational glue-layer / zero-false-trigger intelligent gate — proving it dispatches only warranted, well-formed worker_tasks and NEVER false-triggers destructive realign on a normal library.

**Architecture:** A shared in-memory `seedBacklog(lib, shape)` factory + a `BacklogShape` catalog (named library shapes × expected dispatch outcome). Two consumers, mirroring the A-layer split: (1) a deterministic in-suite layer (scripted MockLanguageModelV4) proving the seed factory + tool FACTS + dispatch plumbing; (2) an out-of-band real-model runner proving the orchestrator's JUDGMENT (esp. realign zero-false-trigger). The orchestrator's whole world is in-memory (better-sqlite3 `:memory:` + controlled tmdb/jf fakes) — NO provider replay needed (unlike A-layer), because the orchestrator makes no HTTP calls beyond `tmdb.getSeasonTable`/`jf.getItem`, both faked.

**Tech Stack:** TypeScript ESM, vitest, `ai/test` MockLanguageModelV4, better-sqlite3 (`:memory:`), the real `LibraryRepo`/`JobsRepo`/`makeOrchestratorAgent`, `makeToolCallTap` (real-model observability), `makeModel` (real mimo). No network in either layer (deterministic = scripted model; real-model runner = real LLM + faked tmdb/jf).

**Reference:** spec `docs/design/2026-07-14-b-layer-orchestrator-test-design.md`. North star: the orchestrator is the incarnate rational gate — mechanical direct-dispatch would stamp holy marks (realign) on normal libraries and make the sub-agents run mad; the orchestrator's defining job is to withhold. Zero-false-trigger on the destructive realign is the pole star.

**Verified codebase facts (read during planning):**
- `openDb(':memory:')` → `new JobsRepo(db)`, `new LibraryRepo(db)`.
- `lib.upsertSeries({ id, name })`, `lib.upsertEpisode({ id, seriesId, season, episode, name, path, subStatus })`, `lib.upsertMovie({ id, name, path, subStatus })`. `SubStatus = 'missing'|'covered'|'embedded'|'unavailable'|'ignored'`.
- `lib.countEpisodesInSeason(seriesId, season)` = COUNT(*) of ALL episodes in the season (the mirror count). `lib.missingBySeason(now)` = episodes with `sub_status='missing'` grouped by season.
- `makeOrchestratorAgent({ model, lib, tmdb, jf, jobs, now, orchestratorJobId, stepCap?, maxDispatchesPerOrchestrator? })` returns `runPass()` → `OrchestratorDecision`. `tmdb: Pick<TmdbClient,'getSeasonTable'>`, `jf: Pick<PlayerServer,'getItem'>`.
- check_series_layout resolves tmdbId via `jf.getItem(seriesId).ProviderIds.Tmdb`, then `tmdb.getSeasonTable(tmdbId)`; `exceedsSeasonTable = mirror > tmdbCount` (mirror>tmdb ⇒ realign candidate). So a shape drives realign-vs-find via `episodes` (mirror) vs `tmdbEpisodeCount` (fake).
- Assertions on dispatch: `jobs.listByState('wanted').filter(j => j.kind === 'worker_task')` → rows with `series_id/season/movie_id/payload/parent_job_id`; `jobs.countByState('wanted')`.
- Existing scripted-model helpers to reuse verbatim (orchestratorAgent.test.ts:11-53): `toolCallResult(id,name,input)`, `finalizeResult(output)`, `findToolResultValueById(prompt,id)`.

---

## File Structure

**New files:**
- `src/testing/seedBacklog.ts` — `BacklogShape`/`BacklogSeriesSpec`/`BacklogSeasonSpec`/`BacklogMovieSpec` types, `seedBacklog(lib, shape)`, `makeBacklogFakes(shape)`. The reusable engine (seeds a LibraryRepo + builds tmdb/jf fakes matching the shape). One responsibility: turn a declarative shape into a seeded world.
- `src/testing/seedBacklog.test.ts` — proves seedBacklog produces the right `missingBySeason`/`countEpisodesInSeason` and the fakes drive check_series_layout correctly.
- `src/testing/orchestratorBacklog.ts` — `ORCHESTRATOR_BACKLOG_SHAPES` catalog (named shapes + expected dispatch), keyed by the spec's axis.
- `src/testing/orchestratorBacklog.test.ts` — validates catalog well-formedness + the deterministic FACTS assertion (check_series_layout returns the shape-intended `exceedsSeasonTable`).
- `src/agent/orchestratorBacklog.plumbing.test.ts` — deterministic end-to-end plumbing: seed a shape, scripted model dispatches per `expected`, assert DB rows.
- `scripts/run-orchestrator-matrix.ts` — out-of-band real-model runner + reporter.

**Modified files:** none in phase 1-2 (all additive). Phase 3 is operational.

---

## Phase 1 — seedBacklog factory + catalog + deterministic layer

### Task 1: `seedBacklog` + `makeBacklogFakes`

**Files:**
- Create: `src/testing/seedBacklog.ts`
- Test: `src/testing/seedBacklog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/testing/seedBacklog.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { seedBacklog, makeBacklogFakes, type BacklogShape } from './seedBacklog.js'
import { makeCheckSeriesLayoutTool } from '../agent/orchestratorAgent.tools.js'

let lib: LibraryRepo
beforeEach(() => { lib = new LibraryRepo(openDb(':memory:')) })

const SHAPE: BacklogShape = {
  name: 'test', represents: 'one messy series (mirror>tmdb) + one normal-missing series + a movie',
  series: [
    { id: 'messy', tmdbId: '100', seasons: [{ season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 }] },
    { id: 'normal', tmdbId: '200', seasons: [{ season: 1, episodes: 12, missing: 2, tmdbEpisodeCount: 12 }] },
  ],
  movies: [{ id: 'mov', missing: true }],
  expected: { findSubtitle: [], realignSeriesIds: ['messy'] }, // (expected asserted by later tasks)
}

describe('seedBacklog', () => {
  it('seeds episodes so missingBySeason and countEpisodesInSeason reflect the shape', () => {
    seedBacklog(lib, SHAPE)
    // mirror counts = total episodes seeded
    expect(lib.countEpisodesInSeason('messy', 1)).toBe(40)
    expect(lib.countEpisodesInSeason('normal', 1)).toBe(12)
    // missing = the seasons with missing>0, counted by missing episodes
    const missing = lib.missingBySeason(1000)
    expect(missing.find(m => m.series_id === 'messy')!.missing).toBe(3)
    expect(missing.find(m => m.series_id === 'normal')!.missing).toBe(2)
    // a fully-covered season would not appear
    expect(missing.every(m => m.missing > 0)).toBe(true)
    // movie missing
    expect(lib.missingMovies(1000).map(m => m.id)).toEqual(['mov'])
  })
})

describe('makeBacklogFakes drives check_series_layout', () => {
  it('reports exceedsSeasonTable true where mirror>tmdb, false where mirror<=tmdb', async () => {
    seedBacklog(lib, SHAPE)
    const { tmdb, jf } = makeBacklogFakes(SHAPE)
    const tool = makeCheckSeriesLayoutTool(lib, tmdb, jf)
    const messy = await tool.execute!({ seriesId: 'messy', season: 1 }, {} as any)
    expect(messy).toEqual({ mirrorEpisodeCount: 40, tmdbEpisodeCount: 25, exceedsSeasonTable: true })
    const normal = await tool.execute!({ seriesId: 'normal', season: 1 }, {} as any)
    expect(normal).toEqual({ mirrorEpisodeCount: 12, tmdbEpisodeCount: 12, exceedsSeasonTable: false })
  })
})
```

(Confirm the `.execute!(args, opts)` call convention against orchestratorAgent.tools.test.ts's own check_series_layout tests — match whatever second-arg/`!` shape that file uses; adapt if it differs.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/seedBacklog.test.ts`
Expected: FAIL — `Cannot find module './seedBacklog.js'`.

- [ ] **Step 3: Implement `src/testing/seedBacklog.ts`**

```ts
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
 *  `expected` is asserted by the real-model runner (and the plumbing test); realignSeriesIds empty
 *  = the zero-false-trigger pole star (the orchestrator must NOT dispatch destructive realign). */
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

/** Seed a real LibraryRepo (in-memory) to match the shape: episodes per season (mirror count),
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

/** Build tmdb/jf fakes so check_series_layout sees the shape's intended mirror-vs-TMDB relationship:
 *  jf.getItem(seriesId) resolves the series' tmdbId; tmdb.getSeasonTable(tmdbId) returns per-season
 *  episodeCounts. This is the ONLY external surface the orchestrator touches — no network. */
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/seedBacklog.test.ts`
Expected: PASS (2 tests). If the `.execute!(args, opts)` signature differs, fix the test call to match the real tool contract (PLAN-BUG DISCIPLINE).

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/testing/seedBacklog.ts src/testing/seedBacklog.test.ts
git commit -m "test(v3-b): seedBacklog factory + tmdb/jf fakes for orchestrator backlog shapes"
```

### Task 2: Backlog shape catalog

**Files:**
- Create: `src/testing/orchestratorBacklog.ts`
- Test: `src/testing/orchestratorBacklog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/testing/orchestratorBacklog.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { seedBacklog, makeBacklogFakes } from './seedBacklog.js'
import { makeCheckSeriesLayoutTool } from '../agent/orchestratorAgent.tools.js'
import { ORCHESTRATOR_BACKLOG_SHAPES } from './orchestratorBacklog.js'

describe('ORCHESTRATOR_BACKLOG_SHAPES catalog', () => {
  it('names are unique and the pole-star shapes exist', () => {
    const names = ORCHESTRATOR_BACKLOG_SHAPES.map(s => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('clean')                 // zero dispatch
    expect(names).toContain('normal-missing')        // find yes, realign ZERO (the gate)
    expect(names).toContain('messy-realign')         // realign warranted
  })

  // The deterministic FACTS assertion: for every shape, the check_series_layout tool must report
  // exceedsSeasonTable == (this series is in the shape's realign expectation) for each season. This
  // proves the WORLD the real model will judge is set up correctly — so any realign misjudgment in
  // the real-model runner is the model's fault, not a mis-seeded fixture.
  it('every shape seeds a world where check_series_layout facts match the realign expectation', async () => {
    for (const shape of ORCHESTRATOR_BACKLOG_SHAPES) {
      const lib = new LibraryRepo(openDb(':memory:'))
      seedBacklog(lib, shape)
      const { tmdb, jf } = makeBacklogFakes(shape)
      const tool = makeCheckSeriesLayoutTool(lib, tmdb, jf)
      for (const s of shape.series) {
        for (const se of s.seasons) {
          const r: any = await tool.execute!({ seriesId: s.id, season: se.season }, {} as any)
          const shouldRealign = shape.expected.realignSeriesIds.includes(s.id)
          // a series flagged for realign must have at least one season where exceeds is true
          if (shouldRealign) {
            // don't over-assert per-season; assert the series has a realign-triggering season
          }
          expect(typeof r.exceedsSeasonTable).toBe('boolean')
        }
        if (shape.expected.realignSeriesIds.includes(s.id)) {
          const anyExceeds = await Promise.all(s.seasons.map(async se =>
            (await tool.execute!({ seriesId: s.id, season: se.season }, {} as any)).exceedsSeasonTable))
          expect(anyExceeds.some(Boolean)).toBe(true)
        } else {
          const anyExceeds = await Promise.all(s.seasons.map(async se =>
            (await tool.execute!({ seriesId: s.id, season: se.season }, {} as any)).exceedsSeasonTable))
          expect(anyExceeds.some(Boolean)).toBe(false) // non-realign series: NO season exceeds
        }
      }
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/orchestratorBacklog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/testing/orchestratorBacklog.ts`**

```ts
import type { BacklogShape } from './seedBacklog.js'

/** The B-layer backlog-shape catalog (spec §轴). Each shape is a declarative library world + the
 *  dispatch the orchestrator SHOULD produce. The pole star: `normal-missing` and `clean` must yield
 *  realignSeriesIds === [] — the intelligent gate withholds the destructive realign. Realign is
 *  warranted ONLY where a season's mirror count exceeds TMDB's (absolute-flat mislabel etc.). */
export const ORCHESTRATOR_BACKLOG_SHAPES: BacklogShape[] = [
  {
    name: 'clean', represents: 'everything covered — the orchestrator must dispatch NOTHING',
    series: [{ id: 'ok', tmdbId: '1', seasons: [{ season: 1, episodes: 12, missing: 0, tmdbEpisodeCount: 12 }] }],
    movies: [{ id: 'okmov', missing: false }],
    expected: { findSubtitle: [], realignSeriesIds: [] },
  },
  {
    name: 'normal-missing', represents: 'subs missing (find warranted) but layout normal (mirror<=tmdb) — realign must be ZERO',
    series: [{ id: 'norm', tmdbId: '2', seasons: [{ season: 1, episodes: 12, missing: 3, tmdbEpisodeCount: 12 }] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 'norm', season: 1, movieId: null }], realignSeriesIds: [] },
  },
  {
    name: 'messy-realign', represents: 'mirror 40 >> tmdb 25 (absolute-flat) + missing — realign warranted',
    series: [{ id: 'mess', tmdbId: '3', seasons: [{ season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 }] }],
    movies: [],
    expected: { findSubtitle: [], realignSeriesIds: ['mess'] },
  },
  {
    name: 'one-season', represents: 'one series, one missing season — one find task',
    series: [{ id: 's', tmdbId: '4', seasons: [{ season: 2, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 's', season: 2, movieId: null }], realignSeriesIds: [] },
  },
  {
    name: 'mixed-partial-and-full', represents: 'some seasons fully missing, some partial — one find task per missing season, no realign',
    series: [{ id: 'mix', tmdbId: '5', seasons: [
      { season: 1, episodes: 12, missing: 12, tmdbEpisodeCount: 12 },
      { season: 2, episodes: 12, missing: 2, tmdbEpisodeCount: 12 },
      { season: 3, episodes: 12, missing: 0, tmdbEpisodeCount: 12 },
    ] }],
    movies: [],
    expected: { findSubtitle: [
      { seriesId: 'mix', season: 1, movieId: null }, { seriesId: 'mix', season: 2, movieId: null },
    ], realignSeriesIds: [] },
  },
  {
    name: 'realign-and-find-same-series', represents: 'one series with a messy season (realign) AND a normal missing season (find) — order: realign before find',
    series: [{ id: 'both', tmdbId: '6', seasons: [
      { season: 1, episodes: 40, missing: 3, tmdbEpisodeCount: 25 },  // messy → realign
      { season: 2, episodes: 12, missing: 4, tmdbEpisodeCount: 12 },  // normal missing → find
    ] }],
    movies: [],
    expected: { findSubtitle: [{ seriesId: 'both', season: 2, movieId: null }], realignSeriesIds: ['both'] },
  },
]
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/orchestratorBacklog.test.ts`
Expected: PASS. This green means every shape's seeded world is internally consistent — non-realign series have NO exceeding season, realign series DO. That is the deterministic FACTS foundation the real-model runner stands on.

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/testing/orchestratorBacklog.ts src/testing/orchestratorBacklog.test.ts
git commit -m "test(v3-b): orchestrator backlog-shape catalog + deterministic facts assertion"
```

### Task 3: Deterministic dispatch plumbing test

Proves that WHEN the model dispatches per a shape's `expected`, the DB worker_task rows land correctly (identity/kind/payload/idempotency) — the plumbing the real-model runner's assertions depend on. Scripted model (not judgment).

**Files:**
- Create: `src/agent/orchestratorBacklog.plumbing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/orchestratorBacklog.plumbing.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from '../v2/db.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { makeOrchestratorAgent } from './orchestratorAgent.js'
import { seedBacklog, makeBacklogFakes, type BacklogShape } from '../testing/seedBacklog.js'

function toolCallResult(id: string, name: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
    warnings: [],
  }
}
function finalizeResult(output: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId: 'finalize-1', toolName: 'finalize', input: JSON.stringify(output) }],
    warnings: [],
  }
}

const MIXED: BacklogShape = {
  name: 'mixed', represents: 'two missing seasons + a movie → 3 find dispatches',
  series: [{ id: 'mix', tmdbId: '5', seasons: [
    { season: 1, episodes: 12, missing: 12, tmdbEpisodeCount: 12 },
    { season: 2, episodes: 12, missing: 2, tmdbEpisodeCount: 12 },
  ] }],
  movies: [{ id: 'mov', missing: true }],
  expected: { findSubtitle: [
    { seriesId: 'mix', season: 1, movieId: null }, { seriesId: 'mix', season: 2, movieId: null },
    { seriesId: null, season: null, movieId: 'mov' },
  ], realignSeriesIds: [] },
}

describe('orchestrator dispatch plumbing over a seeded backlog', () => {
  let jobs: JobsRepo, lib: LibraryRepo
  beforeEach(() => { const db = openDb(':memory:'); jobs = new JobsRepo(db); lib = new LibraryRepo(db) })

  it('a scripted model dispatching per shape.expected lands exactly those worker_task rows (idempotent on re-run)', async () => {
    seedBacklog(lib, MIXED)
    const { tmdb, jf } = makeBacklogFakes(MIXED)
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return toolCallResult('c1', 'dispatch_find_subtitle_task', { seriesId: 'mix', season: 1, movieId: null, reason: 's1' })
        if (call === 2) return toolCallResult('c2', 'dispatch_find_subtitle_task', { seriesId: 'mix', season: 2, movieId: null, reason: 's2' })
        if (call === 3) return toolCallResult('c3', 'dispatch_find_subtitle_task', { seriesId: null, season: null, movieId: 'mov', reason: 'movie' })
        return finalizeResult({ dispatchedFindSubtitle: 3, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'ok' })
      },
    })
    const runPass = makeOrchestratorAgent({ model, lib, tmdb, jf, jobs, now: () => 1000, orchestratorJobId: null, stepCap: 20 })
    await runPass()

    const rows = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(rows).toHaveLength(3)
    expect(rows.filter(r => JSON.parse(r.payload!).taskType === 'realign')).toHaveLength(0) // zero realign
    expect(rows.map(r => `${r.series_id ?? ''}/${r.season ?? ''}/${r.movie_id ?? ''}`).sort())
      .toEqual(['/​/mov', 'mix/1/', 'mix/2/'].sort().map(s => s.replace('​', ''))) // identity tuples

    // Idempotency: a second identical pass writes no NEW rows (dedup on kind+identity).
    let call2 = 0
    const model2 = new MockLanguageModelV4({ doGenerate: async () => {
      call2++
      if (call2 === 1) return toolCallResult('d1', 'dispatch_find_subtitle_task', { seriesId: 'mix', season: 1, movieId: null, reason: 's1-again' })
      return finalizeResult({ dispatchedFindSubtitle: 1, dispatchedRealign: 0, spawnedSiblings: 0, summary: 're-dispatch' })
    } })
    await makeOrchestratorAgent({ model: model2, lib, tmdb, jf, jobs, now: () => 2000, orchestratorJobId: null, stepCap: 20 })()
    expect(jobs.listByState('wanted').filter(j => j.kind === 'worker_task')).toHaveLength(3) // still 3, no dup
  })
})
```

(Note the identity-tuple assertion is finicky — simplify to asserting the SET of `{series_id, season, movie_id}` triples equals the expected set however reads cleanest against the real row shape; the intent is "exactly these three identities, no realign". Fix the assertion to be clean when you see the real rows.)

- [ ] **Step 2-4: Run → fail (module not found for seedBacklog is already resolved; this fails first because the file doesn't exist) → it should pass once written; iterate the identity assertion to match real rows.**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/orchestratorBacklog.plumbing.test.ts` → PASS.

- [ ] **Step 5: Full suite + commit**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run && npx tsc --noEmit` → green.

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/agent/orchestratorBacklog.plumbing.test.ts
git commit -m "test(v3-b): deterministic orchestrator dispatch plumbing + idempotency over a seeded backlog"
```

---

## Phase 2 — Out-of-band real-model orchestrator runner

### Task 4: `scripts/run-orchestrator-matrix.ts`

Real mimo runs the orchestrator against each seeded backlog shape; asserts the ACTUAL worker_task rows match `shape.expected` — the judgment layer. Pole star: `clean`/`normal-missing` → realign count 0. NEVER in `npm test`.

**Files:**
- Create: `scripts/run-orchestrator-matrix.ts`

- [ ] **Step 1: Write the script**

```ts
// Out-of-band orchestrator matrix runner — NOT part of `npm test`. Real reasoning model + fully
// in-memory world (seeded DB + faked tmdb/jf — the orchestrator makes no network calls). Proves the
// orchestrator's JUDGMENT: dispatches only warranted, well-formed worker_tasks, and NEVER
// false-triggers destructive realign on a normal library (the zero-false-trigger pole star).
//
// Usage: npx tsx scripts/run-orchestrator-matrix.ts [--shape <name>] [--repeat N]
// Requires LLM_BASE_URL/LLM_API_KEY/LLM_MODEL in .env. No provider creds needed.
import { parseArgs } from 'node:util'
import 'dotenv/config'
import { makeModel } from '../src/agent/llm.js'
import { openDb } from '../src/v2/db.js'
import { JobsRepo } from '../src/v2/jobsRepo.js'
import { LibraryRepo } from '../src/v2/libraryRepo.js'
import { makeOrchestratorAgent } from '../src/agent/orchestratorAgent.js'
import { makeToolCallTap } from '../src/testing/toolCallTap.js'
import { seedBacklog, makeBacklogFakes, type BacklogShape } from '../src/testing/seedBacklog.js'
import { ORCHESTRATOR_BACKLOG_SHAPES } from '../src/testing/orchestratorBacklog.js'

if (process.env.VITEST) throw new Error('orchestrator matrix runner must not run under vitest — it hits a real LLM')

const { values } = parseArgs({ options: { shape: { type: 'string' }, repeat: { type: 'string' } } })
const repeat = values.repeat ? Number(values.repeat) : 1
const shapes = values.shape ? ORCHESTRATOR_BACKLOG_SHAPES.filter(s => s.name === values.shape) : ORCHESTRATOR_BACKLOG_SHAPES
if (shapes.length === 0) { console.error(`no shape named ${values.shape}`); process.exit(1) }

function summarizeRows(jobs: JobsRepo): { find: string[]; realign: string[] } {
  const rows = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
  const find: string[] = [], realign: string[] = []
  for (const r of rows) {
    const p = JSON.parse(r.payload!)
    const id = `${r.series_id ?? ''}/${r.season ?? ''}/${r.movie_id ?? ''}`
    if (p.taskType === 'find_subtitle') find.push(id)
    else if (p.taskType === 'realign') realign.push(r.series_id ?? '')
  }
  return { find: find.sort(), realign: realign.sort() }
}

async function runShape(shape: BacklogShape, run: number, model: ReturnType<typeof makeModel>) {
  const db = openDb(':memory:'); const jobs = new JobsRepo(db); const lib = new LibraryRepo(db)
  seedBacklog(lib, shape)
  const { tmdb, jf } = makeBacklogFakes(shape)
  const tap = makeToolCallTap(model)
  let threw: string | undefined
  try {
    await makeOrchestratorAgent({ model: tap.model, lib, tmdb, jf, jobs, now: () => Date.now(), orchestratorJobId: null, stepCap: 500 })()
  } catch (e) { threw = String(e) }
  const got = summarizeRows(jobs)
  const wantRealign = [...shape.expected.realignSeriesIds].sort()
  const wantFind = shape.expected.findSubtitle.map(f => `${f.seriesId ?? ''}/${f.season ?? ''}/${f.movieId ?? ''}`).sort()
  // Pole star: realign set MUST match exactly (esp. empty on clean/normal). Find set: assert the
  // expected are present (the model may reasonably also dispatch find for a realign season — do not
  // over-penalize), but realign is the hard gate.
  const realignOk = JSON.stringify(got.realign) === JSON.stringify(wantRealign)
  const findOk = wantFind.every(f => got.find.includes(f))
  const ok = !threw && realignOk && findOk
  console.error(`${ok ? 'PASS' : 'FAIL'} ${shape.name} run ${run}: realign got=${JSON.stringify(got.realign)} want=${JSON.stringify(wantRealign)}${realignOk ? '' : ' ❌REALIGN'} | find got=${JSON.stringify(got.find)} want⊇=${JSON.stringify(wantFind)}${findOk ? '' : ' ❌FIND'}${threw ? ` THREW=${threw.slice(0, 160)}` : ''} | tools=${tap.toolCalls.join('→')}`)
  return ok
}

async function main() {
  const model = makeModel({ baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL! })
  console.error(`running ${shapes.length} shape(s) × ${repeat} against ${process.env.LLM_MODEL}\n`)
  let pass = 0, total = 0
  for (const s of shapes) for (let r = 1; r <= repeat; r++) { total++; if (await runShape(s, r, model)) pass++ }
  console.error(`\n=== ${pass}/${total} passed ===`)
  process.exit(pass === total ? 0 : 2)
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Typecheck (no network)**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsc --noEmit --ignoreConfig --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node scripts/run-orchestrator-matrix.ts`
Expected: clean. Fix `makeToolCallTap`'s exact return-type usage / any `.execute` mismatch against reality.

- [ ] **Step 3: Guard smoke (no network)**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsx scripts/run-orchestrator-matrix.ts --shape nonexistent`
Expected: `no shape named nonexistent`, exit 1 — before constructing the model.

- [ ] **Step 4: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add scripts/run-orchestrator-matrix.ts
git commit -m "feat(v3-b): out-of-band real-model orchestrator matrix runner (zero-false-trigger pole star)"
```

- [ ] **Step 5 (controller, real LLM — NOT automated):** `npx tsx scripts/run-orchestrator-matrix.ts --repeat 2`. Observe: does mimo dispatch NOTHING on `clean`, realign-ZERO on `normal-missing` (the gate), realign on `messy-realign`, realign-before-find on `realign-and-find-same-series`? A FAIL is auto-research signal (esp. a false realign = the gate leaking).

---

## Phase 3 — Real-model live run + monitor (operational)

- [ ] Controller runs `scripts/run-orchestrator-matrix.ts --repeat 2` and dispatches the monitor subagent to classify any FAIL per the runbook (code / judgment / fixture). A false realign on `normal-missing` is the highest-severity finding — the intelligent gate leaking, which in production would move files on a healthy library. Sediment fixes (skill edits are human-curated; code fixes get regression tests) and re-run.

---

## Self-Review

**Spec coverage (docs/design/2026-07-14-b-layer-orchestrator-test-design.md):**
- 智能闸门/零误触发 pole star → `clean` + `normal-missing` shapes with `realignSeriesIds: []`, asserted hard in the runner (Task 4) and facts-checked deterministically (Task 2). ✓
- realign-vs-find 对照 (benign mirror≤tmdb vs genuine mirror>tmdb) → `normal-missing` vs `messy-realign` (Task 2 facts + Task 4 judgment). ✓
- 该派谁 / 不漏不错 → `one-season`, `mixed-partial-and-full` + runner find-set assertion (Task 4). ✓
- 同剧顺序 (realign before find) → `realign-and-find-same-series` shape; runner observes tool order via toolCallTap (Task 4 prints `tools=` sequence for inspection). ✓ (Note: ordering is observed/reported, not hard-asserted, since a single pass's order is a soft signal — flagged for the monitor.)
- 规模缩放 / cap+溢出 → covered by existing orchestratorAgent.test.ts (cap) + an `over-100` shape can be added to the catalog when Phase 2 runs (deferred: YAGNI until the base shapes pass). ✓/deferred
- 幂等 → Task 3 re-run assertion. ✓
- 成形派活 → Task 3 asserts payload/identity; runner summarizes identities. ✓
- 两层结构 (deterministic in-suite + out-of-band real-model) → Phase 1 (Tasks 1-3) + Phase 2 (Task 4). ✓
- 复用 (MockLM 脚本/toolCallTap/真 in-mem DB+JobsRepo dedup/makeModel) → all used. ✓

**Placeholder scan:** The Task 3 identity-tuple assertion is explicitly flagged as "clean up against real rows" (a known finicky assertion, not a placeholder gap — the intent is stated). `over-100` shape deferred with a YAGNI note. No TBD/TODO.

**Type consistency:** `BacklogShape`/`seedBacklog`/`makeBacklogFakes` (Task 1) used identically in Tasks 2-4. `ORCHESTRATOR_BACKLOG_SHAPES` (Task 2) consumed by Tasks 2 & 4. `makeOrchestratorAgent({model,lib,tmdb,jf,jobs,now,orchestratorJobId,stepCap})` matches the real signature (verified). `makeCheckSeriesLayoutTool(lib,tmdb,jf)` matches the post-bugfix 3-arg signature. `jobs.listByState('wanted')` / `.kind==='worker_task'` / `payload` JSON — matches orchestratorAgent.test.ts.

**Known reconciliation point:** the tool `.execute!(args, opts)` call convention (Tasks 1-2) must match how orchestratorAgent.tools.test.ts invokes a `tool({...})`'s execute — the implementer confirms against that file and adjusts (the `ai` `tool()` execute signature is `(input, options)`; the `!` is because `execute` is optional on the type).
