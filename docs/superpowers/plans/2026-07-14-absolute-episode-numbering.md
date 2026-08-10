# Absolute-Episode Numbering Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the find-subtitle worker a system-computed "absolute episode number" per episode so it can locate the right file inside packs whose numbering scheme differs from TMDB's (the Bazarr-killer capability), without the model doing the arithmetic.

**Architecture:** A pure, deterministic derivation module turns a series' TMDB season structure into an `absolute ↔ (season, episode)` table. The orchestrator/mapper computes each episode's absolute number and injects it into `FindSubtitleTask.absoluteEpisode`. The worker receives it as a **hint** (surfaced in its prompt) but still verifies belonging before installing — the number is a breadcrumb, never a gate. The worker stays sandboxed (only its own episode's number, never the whole table).

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, zod, the existing `TmdbClient` (season table already available; episode-groups fetch added here). No LLM in phases 1-2 (deterministic + unit-tested); phase 3 is a human-curated skill edit; phase 4 reuses the v3 live-matrix machinery.

**Reference:** spec `docs/design/2026-07-14-absolute-episode-numbering-design.md`. North-star guard (repeated across phases): the absolute number is fact-provision, NOT deterministic belonging-gatekeeping — the worker must still judge, or we regress to Bazarr.

---

## File Structure

**New files:**
- `src/agent/absoluteEpisodes.ts` — pure derivation: `AbsoluteEpisodeTable` type, `buildFromSeasonConcat`, `buildFromAbsoluteOrder`, `absoluteFor`. Zero I/O, zero LLM. One responsibility: turn ordering data into a lookup table.
- `src/agent/absoluteEpisodes.test.ts` — unit tests for the above.
- `fixtures/v3-live/anime/season-pack/` (+ `cell.json`, `responses/`) — 进击的巨人 absolute-numbered-pack cell (phase 4).
- `fixtures/v3-live/anime/mixed/` (+ `cell.json`, `responses/`) — 咒术回战 invented-season cell (phase 4).
- `fixtures/v3-live/anime/multi-version/` (+ `cell.json`, `responses/`) — 简/繁/日 multi-version cell (phase 4).

**Modified files:**
- `src/adapters/providers/tmdb.ts` — add `getAbsoluteOrder(tvId)` (episode-groups fetch) + `TmdbEpisodeGroupOrderEntry` type.
- `src/adapters/providers/tmdb.test.ts` — tests for `getAbsoluteOrder`.
- `src/agent/findSubtitleWorker.schemas.ts` — `FindSubtitleTask` gains `absoluteEpisode: number | null`.
- `src/agent/findSubtitleWorker.ts` — surface `absoluteEpisode` in the worker prompt.
- `src/v2/findSubtitleWorkerTask.ts` — the mapper computes `absoluteEpisode` (injected TMDB dep) when building the task.
- `src/agent/orchestratorAgent.ts` / `src/cli/index.ts` — any other `FindSubtitleTask` construction sites the compiler flags once the field is required (set to `null` where no series context).
- `src/agent/skills/findSubtitleSkill.ts` (+ `.test.ts`) — phase 3, human-curated: teach using `absoluteEpisode` as a verify-first hint + coverage-first language policy.
- `src/testing/liveMatrix.ts` — `CellExpectation` language widened to accept "any zh" (phase 4).
- `scripts/run-live-matrix.ts` — assertion honors the widened language expectation (phase 4).

---

## Phase 1 — Absolute-episode derivation (deterministic foundation)

### Task 1: `AbsoluteEpisodeTable` + season-concatenation baseline

**Files:**
- Create: `src/agent/absoluteEpisodes.ts`
- Test: `src/agent/absoluteEpisodes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/absoluteEpisodes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildFromSeasonConcat, absoluteFor } from './absoluteEpisodes.js'

describe('buildFromSeasonConcat', () => {
  it('assigns absolute numbers by concatenating seasons in order', () => {
    // Attack on Titan: S1=25 eps, S2=12 eps -> S02E01 is absolute 26.
    const t = buildFromSeasonConcat([
      { seasonNumber: 1, episodeCount: 25 },
      { seasonNumber: 2, episodeCount: 12 },
    ])
    expect(t.totalEpisodes).toBe(37)
    expect(t.source).toBe('tmdb-season-concat')
    expect(t.reliable).toBe(true)
    expect(t.entries).toContainEqual({ absolute: 1, season: 1, episode: 1 })
    expect(t.entries).toContainEqual({ absolute: 25, season: 1, episode: 25 })
    expect(t.entries).toContainEqual({ absolute: 26, season: 2, episode: 1 })
    expect(t.entries).toContainEqual({ absolute: 37, season: 2, episode: 12 })
  })

  it('is unreliable (empty) when the season list is empty or malformed', () => {
    expect(buildFromSeasonConcat([]).reliable).toBe(false)
    expect(buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 0 }]).reliable).toBe(false)
  })

  it('sorts seasons by number before concatenating (defensive against unsorted input)', () => {
    const t = buildFromSeasonConcat([
      { seasonNumber: 2, episodeCount: 12 },
      { seasonNumber: 1, episodeCount: 25 },
    ])
    expect(t.entries).toContainEqual({ absolute: 26, season: 2, episode: 1 })
  })
})

describe('absoluteFor', () => {
  it('returns the absolute number for a (season, episode)', () => {
    const t = buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }])
    expect(absoluteFor(t, 2, 1)).toBe(26)
    expect(absoluteFor(t, 1, 1)).toBe(1)
  })
  it('returns null for an out-of-range or unknown (season, episode)', () => {
    const t = buildFromSeasonConcat([{ seasonNumber: 1, episodeCount: 25 }])
    expect(absoluteFor(t, 2, 1)).toBeNull()
    expect(absoluteFor(t, 1, 99)).toBeNull()
  })
  it('returns null on an unreliable table', () => {
    expect(absoluteFor(buildFromSeasonConcat([]), 1, 1)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/absoluteEpisodes.test.ts`
Expected: FAIL — `Cannot find module './absoluteEpisodes.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/agent/absoluteEpisodes.ts`:

```ts
/** A per-series cross-reference: whole-series absolute episode number <-> (season, episode-in-season).
 *  System-computed from TMDB so the model never does the arithmetic. Consumed as a HINT by the
 *  find-subtitle worker (surfaced in its prompt) — never as a belonging gate (north star: the worker
 *  still verifies the located file actually matches before installing). */
export interface AbsoluteEpisodeTable {
  entries: { absolute: number; season: number; episode: number }[]
  totalEpisodes: number
  /** Provenance / confidence signal: an official TMDB absolute-order episode group is more
   *  trustworthy for anime than naive season concatenation (whose order can disagree with fansub
   *  numbering). Both are usable; the worker treats concat as a weaker hint. */
  source: 'tmdb-episode-group' | 'tmdb-season-concat'
  /** false => data was missing/degenerate; callers must inject absoluteEpisode=null (never a guess). */
  reliable: boolean
}

/** Minimal structural shape of a season row — matches TmdbClient's SeasonTableEntry without
 *  importing it (keeps this module dependency-free / trivially unit-testable). */
interface SeasonRow { seasonNumber: number; episodeCount: number }

const EMPTY_UNRELIABLE: AbsoluteEpisodeTable = { entries: [], totalEpisodes: 0, source: 'tmdb-season-concat', reliable: false }

/** Baseline derivation: concatenate seasons in ascending season order, numbering episodes 1..N
 *  across the whole series. TMDB's getSeasonTable already excludes season 0 (specials), so OVAs/
 *  specials don't pollute the absolute axis. Degenerate input (no seasons, or zero total episodes)
 *  yields an unreliable table. */
export function buildFromSeasonConcat(seasons: SeasonRow[]): AbsoluteEpisodeTable {
  const clean = seasons.filter(s => Number.isInteger(s.seasonNumber) && Number.isInteger(s.episodeCount) && s.episodeCount > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
  if (clean.length === 0) return EMPTY_UNRELIABLE
  const entries: AbsoluteEpisodeTable['entries'] = []
  let running = 0
  for (const s of clean) {
    for (let ep = 1; ep <= s.episodeCount; ep++) {
      running++
      entries.push({ absolute: running, season: s.seasonNumber, episode: ep })
    }
  }
  return { entries, totalEpisodes: running, source: 'tmdb-season-concat', reliable: running > 0 }
}

/** Look up the absolute number for a (season, episode). Returns null on an unreliable table or an
 *  unknown coordinate — callers inject null into the task rather than guessing. */
export function absoluteFor(table: AbsoluteEpisodeTable, season: number, episode: number): number | null {
  if (!table.reliable) return null
  const hit = table.entries.find(e => e.season === season && e.episode === episode)
  return hit ? hit.absolute : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/absoluteEpisodes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/agent/absoluteEpisodes.ts src/agent/absoluteEpisodes.test.ts
git commit -m "feat(v3): absolute-episode table — season-concatenation baseline"
```

### Task 2: Official absolute-order derivation (`buildFromAbsoluteOrder`)

**Files:**
- Modify: `src/agent/absoluteEpisodes.ts`
- Test: `src/agent/absoluteEpisodes.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/agent/absoluteEpisodes.test.ts`:

```ts
import { buildFromAbsoluteOrder } from './absoluteEpisodes.js'

describe('buildFromAbsoluteOrder', () => {
  it('numbers episodes by the official absolute order, not by season concatenation', () => {
    // An official absolute group can order episodes differently than season concat would.
    const t = buildFromAbsoluteOrder([
      { season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 2, episode: 1 },
    ])
    expect(t.source).toBe('tmdb-episode-group')
    expect(t.reliable).toBe(true)
    expect(t.totalEpisodes).toBe(3)
    expect(t.entries).toEqual([
      { absolute: 1, season: 1, episode: 1 },
      { absolute: 2, season: 1, episode: 2 },
      { absolute: 3, season: 2, episode: 1 },
    ])
  })
  it('is unreliable when the ordered list is empty', () => {
    expect(buildFromAbsoluteOrder([]).reliable).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/absoluteEpisodes.test.ts`
Expected: FAIL — `buildFromAbsoluteOrder` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/agent/absoluteEpisodes.ts`:

```ts
/** Enhancement derivation: an official TMDB absolute-order episode group provides a flat, already-
 *  ordered list of (season, episode). Absolute number = position in that list. Preferred over
 *  season concatenation because it reflects broadcast/absolute order even when TMDB's season
 *  boundaries disagree with it (common for anime). */
export function buildFromAbsoluteOrder(ordered: { season: number; episode: number }[]): AbsoluteEpisodeTable {
  if (ordered.length === 0) return { ...EMPTY_UNRELIABLE, source: 'tmdb-episode-group' }
  const entries = ordered.map((e, i) => ({ absolute: i + 1, season: e.season, episode: e.episode }))
  return { entries, totalEpisodes: entries.length, source: 'tmdb-episode-group', reliable: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/absoluteEpisodes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/agent/absoluteEpisodes.ts src/agent/absoluteEpisodes.test.ts
git commit -m "feat(v3): absolute-episode table — official episode-group order"
```

### Task 3: `TmdbClient.getAbsoluteOrder` (episode-groups fetch)

**Files:**
- Modify: `src/adapters/providers/tmdb.ts`
- Test: `src/adapters/providers/tmdb.test.ts`

Background (read before implementing): `TmdbClient.getSeasonTable` (tmdb.ts:211) already exists and returns `SeasonTableEntry[]`. `getJsonStrict(path)` (tmdb.ts:120) is the private fetch helper — it appends `?api_key=` for v3 tokens, so pass a bare path with NO query string. The tmdb test convention (tmdb.test.ts) builds a `routedFetch(routes)` returning `Response` objects keyed by URL substring, then `new TmdbClient({ apiKey, fetchImpl })`. TMDB episode groups: `GET /tv/{id}/episode_groups` returns `{ results: [{ id, type, ... }] }` where `type === 2` denotes an **Absolute** ordering group; `GET /tv/episode_group/{group_id}` returns `{ groups: [{ order, episodes: [{ season_number, episode_number, order }] }] }`. Flatten groups in `order`, then episodes in their `order`, to get the absolute sequence.

- [ ] **Step 1: Write the failing test**

Append to `src/adapters/providers/tmdb.test.ts` (mirror the file's existing `routedFetch`/`makeClient` helper style — inspect the top of the file first and reuse its helpers; the snippet below shows the assertions and the two routes you must serve):

```ts
describe('getAbsoluteOrder', () => {
  it('returns the flattened absolute-ordered (season, episode) list from a type=2 group', async () => {
    const routes = {
      episodeGroups: { results: [{ id: 'grpA', type: 1 }, { id: 'grpB', type: 2 }] },
      episodeGroupDetail: { groups: [
        { order: 1, episodes: [
          { season_number: 1, episode_number: 1, order: 0 },
          { season_number: 1, episode_number: 2, order: 1 },
        ] },
        { order: 2, episodes: [ { season_number: 2, episode_number: 1, order: 0 } ] },
      ] },
    }
    // Route /tv/{id}/episode_groups -> routes.episodeGroups ; /tv/episode_group/grpB -> routes.episodeGroupDetail
    const client = makeAbsoluteOrderClient(routes)
    const ordered = await client.getAbsoluteOrder('1429')
    expect(ordered).toEqual([
      { season: 1, episode: 1 }, { season: 1, episode: 2 }, { season: 2, episode: 1 },
    ])
  })

  it('returns null when the show has no absolute (type=2) group', async () => {
    const client = makeAbsoluteOrderClient({ episodeGroups: { results: [{ id: 'x', type: 1 }] }, episodeGroupDetail: {} })
    expect(await client.getAbsoluteOrder('1429')).toBeNull()
  })
})
```

Add a `makeAbsoluteOrderClient(routes)` helper next to the existing test helpers that serves `/tv/{id}/episode_groups` from `routes.episodeGroups` and `/tv/episode_group/{gid}` from `routes.episodeGroupDetail`, matching by URL substring exactly like the file's existing `routedFetch`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/adapters/providers/tmdb.test.ts`
Expected: FAIL — `getAbsoluteOrder` is not a function.

- [ ] **Step 3: Write minimal implementation**

Add to `src/adapters/providers/tmdb.ts`, as a method on `TmdbClient` (place it right after `getSeasonTable`, before the closing brace at line 230):

```ts
  /** Official TMDB absolute-ordering episode group, flattened to a (season, episode) sequence, or
   *  null if the show has no Absolute-type group. Absolute-order groups have type === 2. Uses
   *  getJson (silent-on-error) since absence of a group is normal, not a failure. */
  async getAbsoluteOrder(tvId: string): Promise<{ season: number; episode: number }[] | null> {
    const list = await this.getJson(`/tv/${tvId}/episode_groups`)
    const results = Array.isArray(list?.results) ? (list!.results as Array<{ id?: string; type?: number }>) : []
    const abs = results.find(g => g.type === 2 && typeof g.id === 'string')
    if (!abs?.id) return null
    const detail = await this.getJson(`/tv/episode_group/${abs.id}`)
    const groups = Array.isArray(detail?.groups) ? (detail!.groups as Array<{ order?: number; episodes?: unknown[] }>) : []
    const ordered: { season: number; episode: number }[] = []
    for (const g of [...groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const eps = Array.isArray(g.episodes) ? (g.episodes as Array<{ season_number?: number; episode_number?: number; order?: number }>) : []
      for (const e of [...eps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        if (typeof e.season_number === 'number' && typeof e.episode_number === 'number') {
          ordered.push({ season: e.season_number, episode: e.episode_number })
        }
      }
    }
    return ordered.length > 0 ? ordered : null
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/adapters/providers/tmdb.test.ts`
Expected: PASS.

Note: `type === 2` for Absolute groups is TMDB's documented episode-group type code; if the live API disagrees during phase 4 real recording, that is a real finding — fix the constant then, don't guess further now.

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/adapters/providers/tmdb.ts src/adapters/providers/tmdb.test.ts
git commit -m "feat(v3): TmdbClient.getAbsoluteOrder — official episode-group absolute sequence"
```

### Task 4: `resolveAbsoluteEpisode` convenience (TMDB fetch → table → lookup)

**Files:**
- Modify: `src/agent/absoluteEpisodes.ts`
- Test: `src/agent/absoluteEpisodes.test.ts` (append)

Ties the pieces together with graceful degradation: prefer the official group, fall back to season concat, return `null` on any failure (never throw into dispatch).

- [ ] **Step 1: Write the failing test**

Append to `src/agent/absoluteEpisodes.test.ts`:

```ts
import { resolveAbsoluteEpisode } from './absoluteEpisodes.js'

describe('resolveAbsoluteEpisode', () => {
  const seasons = [{ seasonNumber: 1, episodeCount: 25 }, { seasonNumber: 2, episodeCount: 12 }]

  it('prefers the official absolute group when present', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, {
      getSeasonTable: async () => seasons,
      getAbsoluteOrder: async () => [{ season: 1, episode: 1 }, { season: 2, episode: 1 }], // S2E1 is absolute 2 here
    })
    expect(absolute).toBe(2)
  })

  it('falls back to season concatenation when there is no official group', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, {
      getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null,
    })
    expect(absolute).toBe(26)
  })

  it('returns null (never throws) when TMDB lookups fail', async () => {
    const absolute = await resolveAbsoluteEpisode(2, 1, {
      getSeasonTable: async () => { throw new Error('tmdb down') }, getAbsoluteOrder: async () => null,
    })
    expect(absolute).toBeNull()
  })

  it('returns null for a null season/episode (movies / unknown)', async () => {
    const absolute = await resolveAbsoluteEpisode(null, null, {
      getSeasonTable: async () => seasons, getAbsoluteOrder: async () => null,
    })
    expect(absolute).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/absoluteEpisodes.test.ts`
Expected: FAIL — `resolveAbsoluteEpisode` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/agent/absoluteEpisodes.ts`:

```ts
/** The two TMDB reads this needs, structurally typed so the mapper can pass a real TmdbClient and
 *  tests can pass fakes. */
export interface AbsoluteOrderSource {
  getSeasonTable: (tvId: string) => Promise<{ seasonNumber: number; episodeCount: number }[] | null>
  getAbsoluteOrder: (tvId: string) => Promise<{ season: number; episode: number }[] | null>
}

/** End-to-end resolve for one episode: official absolute group first, season concat as fallback,
 *  null on missing coords or ANY error (dispatch must degrade to metadata-only judgment, never
 *  crash and never guess). `tvId` defaults are the caller's concern — pass the series' TMDB id. */
export async function resolveAbsoluteEpisode(
  season: number | null, episode: number | null, src: AbsoluteOrderSource, tvId = '',
): Promise<number | null> {
  if (season == null || episode == null) return null
  try {
    const official = await src.getAbsoluteOrder(tvId)
    if (official && official.length > 0) {
      return absoluteFor(buildFromAbsoluteOrder(official), season, episode)
    }
    const seasons = await src.getSeasonTable(tvId)
    if (!seasons) return null
    return absoluteFor(buildFromSeasonConcat(seasons), season, episode)
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/absoluteEpisodes.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/agent/absoluteEpisodes.ts src/agent/absoluteEpisodes.test.ts
git commit -m "feat(v3): resolveAbsoluteEpisode — official-first, concat-fallback, null-on-failure"
```

---

## Phase 2 — Inject `absoluteEpisode` into the task + surface to the worker

### Task 5: Add `absoluteEpisode` to `FindSubtitleTask` and the worker prompt

**Files:**
- Modify: `src/agent/findSubtitleWorker.schemas.ts:28-42` (the `FindSubtitleTask` interface)
- Modify: `src/agent/findSubtitleWorker.ts:74-86` (the prompt block)

- [ ] **Step 1: Add the field (compiler will flag every construction site)**

In `src/agent/findSubtitleWorker.schemas.ts`, add to the `FindSubtitleTask` interface (after `episode: number | null`):

```ts
  /** Whole-series absolute episode number, system-computed from TMDB (see absoluteEpisodes.ts).
   *  null for movies, or when it couldn't be reliably derived. A HINT for locating the right file
   *  inside packs whose numbering differs from TMDB's — the worker still verifies belonging. */
  absoluteEpisode: number | null
```

- [ ] **Step 2: Run the typecheck to see every construction site that now fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsc --noEmit`
Expected: FAIL with "Property 'absoluteEpisode' is missing" at each `FindSubtitleTask` literal — expect these files: `src/v2/findSubtitleWorkerTask.ts`, `src/agent/orchestratorAgent.ts` (if it builds one), `src/cli/index.ts`, `scripts/live-accept-find-subtitle.ts`, `scripts/run-live-matrix.ts`, and the test files (`findSubtitleWorker.eval.test.ts`, `findSubtitleWorker.test.ts`, `src/testing/findSubtitleWorker.replay.test.ts`). This list IS your task checklist for step 3.

- [ ] **Step 3: Set `absoluteEpisode` at every flagged site**

For each flagged site, add `absoluteEpisode: null` to the literal EXCEPT the real mapper (`findSubtitleWorkerTask.ts`), which gets the real value in Task 6. For test/script literals, `absoluteEpisode: null` is correct (they don't have a series numbering context). Re-run `npx tsc --noEmit` until clean.

- [ ] **Step 4: Surface it in the worker prompt**

In `src/agent/findSubtitleWorker.ts`, in the `prompt` array (around line 80, right after the `season/episode:` line), add:

```ts
      ...(task.absoluteEpisode != null
        ? [`absolute episode number (across the whole series): ${task.absoluteEpisode}`]
        : []),
```

- [ ] **Step 5: Run the full suite + commit**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run && npx tsc --noEmit`
Expected: all green (the new field defaults to null everywhere; no behavior change yet).

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/agent/findSubtitleWorker.schemas.ts src/agent/findSubtitleWorker.ts src/v2/findSubtitleWorkerTask.ts src/agent/orchestratorAgent.ts src/cli/index.ts scripts/live-accept-find-subtitle.ts scripts/run-live-matrix.ts src/agent/findSubtitleWorker.eval.test.ts src/agent/findSubtitleWorker.test.ts src/testing/findSubtitleWorker.replay.test.ts
git commit -m "feat(v3): FindSubtitleTask.absoluteEpisode field + prompt surfacing (null everywhere for now)"
```

(Only `git add` the files that actually changed — run `git status` first and stage the real set.)

### Task 6: Compute `absoluteEpisode` in the task mapper

**Files:**
- Modify: `src/v2/findSubtitleWorkerTask.ts` (the mapper that builds the `FindSubtitleTask`, around line 108)
- Test: `src/v2/findSubtitleWorkerTask.test.ts`

Read `src/v2/findSubtitleWorkerTask.ts` fully first. The mapper builds the task from `ctx.media` (a MediaContext) and has a `deps` object. You will add a `tmdb` dep (a `TmdbClient` or the structural `AbsoluteOrderSource`) and the series' tmdb id from `ctx.media.provider_ids.tmdb`.

- [ ] **Step 1: Write the failing test**

Add a test asserting that, given a fake `AbsoluteOrderSource` returning a season table, the mapped task's `absoluteEpisode` is the resolved value. Follow the existing test's setup in `findSubtitleWorkerTask.test.ts` (reuse its fixture builders); the new assertion:

```ts
// Given media at S02E01 with tmdb id and a source where S1=25 eps, the task carries absolute 26.
expect(task.absoluteEpisode).toBe(26)
// Movies / no tmdb id / resolve failure -> null (add a second case asserting null).
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/v2/findSubtitleWorkerTask.test.ts`
Expected: FAIL — `absoluteEpisode` is null/undefined, not 26.

- [ ] **Step 3: Wire the resolve into the mapper**

Import `resolveAbsoluteEpisode` from `../agent/absoluteEpisodes.js`. Add `tmdb: AbsoluteOrderSource` to the mapper deps. In the task construction (line ~108), compute:

```ts
    absoluteEpisode: await resolveAbsoluteEpisode(
      ctx.media.season ?? null, ctx.media.episode ?? null, deps.tmdb, ctx.media.provider_ids?.tmdb ?? '',
    ),
```

Then thread a real `TmdbClient` into `deps.tmdb` at the mapper's construction site (find where these deps are assembled — likely `src/cli/buildAdapters.ts` or the daemon wiring; a `TmdbClient` is already constructed for title enrichment, reuse it). `TmdbClient` satisfies `AbsoluteOrderSource` structurally (it has `getSeasonTable` and, after Task 3, `getAbsoluteOrder`).

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run && npx tsc --noEmit`
Expected: green.

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/v2/findSubtitleWorkerTask.ts src/v2/findSubtitleWorkerTask.test.ts src/cli/buildAdapters.ts
git commit -m "feat(v3): mapper computes absoluteEpisode from TMDB when building the task"
```

(Stage the real changed set per `git status`.)

---

## Phase 3 — Skill refinement (HUMAN-CURATED — main loop, NOT a subagent)

> **HARD LAW:** skills are edited only by the human + the orchestrating Claude, never by a running agent or a mechanical implementer subagent. This phase is executed by the main loop directly, with the user in the loop. A plan-executing subagent must SKIP this phase and report it back to the controller.

### Task 7: Teach the worker to use `absoluteEpisode` (verify-first) + coverage-first language

**Files:**
- Modify: `src/agent/skills/findSubtitleSkill.ts`
- Modify: `src/agent/skills/findSubtitleSkill.test.ts` (if it asserts skill content)

- [ ] **Step 1 (main loop):** Read `src/agent/skills/findSubtitleSkill.ts`. Add, in the pack-handling section, guidance: "You may be given an `absolute episode number` for the whole series. Packs sometimes name files by that absolute number (e.g. `... 26 ...` for S02E01) instead of by season/episode. Use it to LOCATE the candidate file, then STILL verify the located file belongs to your episode (duration, title, episode markers) before installing — the absolute number is a hint, not proof." Keep it consistent with the existing "one rule that overrides everything" (no confidence score, judge by metadata, packs are normal).

- [ ] **Step 2 (main loop):** In the language section, remove any 简-first preference; add: "Chinese coverage is the goal — an installed zh-Hans OR zh-Hant subtitle for the correct episode is a success; do not rank Simplified vs Traditional. A non-Chinese subtitle (e.g. Japanese) is NOT coverage."

- [ ] **Step 3 (main loop):** If `findSubtitleSkill.test.ts` asserts specific skill substrings, update/extend it to cover the two additions. Run `npx vitest run src/agent/skills/findSubtitleSkill.test.ts`.

- [ ] **Step 4 (main loop):** Full suite green, commit:

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/agent/skills/findSubtitleSkill.ts src/agent/skills/findSubtitleSkill.test.ts
git commit -m "skill(v3): use absolute-episode as a verify-first locator hint; coverage-first language"
```

---

## Phase 4 — Live test cells (reuse the v3 matrix machinery)

### Task 8: Widen `CellExpectation` to accept "any Chinese" language

**Files:**
- Modify: `src/testing/liveMatrix.ts` (the `CellExpectation` interface + any consumer)
- Modify: `scripts/run-live-matrix.ts` (the installed-language assertion)
- Test: `src/testing/liveMatrix.test.ts`

- [ ] **Step 1:** Change `CellExpectation.installedLanguage?: 'zh-Hans' | 'zh-Hant'` to also accept `'zh-any'` (meaning either is correct). In `scripts/run-live-matrix.ts`'s installed-branch assertion, when expected is `'zh-any'`, accept `decision.installedLanguage` of either `zh-Hans` or `zh-Hant`; otherwise keep exact match.
- [ ] **Step 2:** Add/adjust a `liveMatrix.test.ts` case asserting a `zh-any` expectation validates. Run `npx vitest run src/testing/liveMatrix.test.ts`.
- [ ] **Step 3:** Commit: `git commit -m "test(v3-matrix): CellExpectation accepts zh-any (coverage-first, no 简/繁 ranking)"`

### Task 9: Seed the 进击的巨人 absolute-numbered-pack cell (anime/season-pack)

**Files:**
- Create: `fixtures/v3-live/anime/season-pack/cell.json` + `responses/`
- Modify: `src/testing/liveMatrix.ts` (flip `anime/season-pack` to `seeded: true`)

- [ ] **Step 1:** Hand-author (or record via `scripts/record-provider-responses.ts`) a search response whose only candidate is a Season-2 pack whose filelist names episodes by ABSOLUTE number (`Attack.on.Titan.26.chs.ass`, `...27...`, `...28...`). Task: S02E01, **`absoluteEpisode: 26`** (this is the whole point — the cell simulates the mapper having injected it). Follow the exact fixture mechanics from `fixtures/v3-live/anime/only-pack/` (signature via `requestSignature`, base64 body). Expected: `installed`, the file at absolute 26, `installedLanguage: zh-any` (or the pack's actual language).
- [ ] **Step 2:** Flip catalog `seeded: true`; `npx vitest run src/testing/liveMatrix.test.ts` (structural validation passes).
- [ ] **Step 3:** Full suite + commit fixtures + flip (two commits, fixtures first).
- [ ] **Step 4 (controller, real LLM — NOT in the plan's automated run):** `npx tsx scripts/run-live-matrix.ts --type anime --form season-pack --repeat 3`. Observe: does the model use absolute 26 to pick the right file AND still verify? Label/step trace per the runbook. A failure here is auto-research signal, not a plan defect.

### Task 10: Seed the 咒术回战 invented-season cell (anime/mixed) and a multi-version cell (anime/multi-version)

**Files:**
- Create: `fixtures/v3-live/anime/mixed/` and `fixtures/v3-live/anime/multi-version/` (`cell.json` + `responses/`)
- Modify: `src/testing/liveMatrix.ts` (flip both to `seeded: true`)

- [ ] **Step 1 (mixed / invented-season):** Task = a show TMDB models with no/one season (absoluteEpisode set to the plain episode index). Source returns a pack labeled with an INVENTED season the file doesn't use (e.g. pack "S3 死灭回游" for what TMDB calls episodes N..M). Expected: `installed` if the target episode is inside and locatable via absolute; `no_safe_match` if the target is beyond what exists (not-yet-aired). Author the fixture to a concrete, decidable case (target IS present) and document the correct answer in `cell.json.note`.
- [ ] **Step 2 (multi-version):** Source returns the correct episode in 简, 繁, AND 日. Expected: `installed`, `installedLanguage: zh-any` (either Chinese is correct; Japanese would be wrong). This exercises "recognize Chinese, reject Japanese" without ranking 简/繁.
- [ ] **Step 3:** Flip both catalog entries seeded; structural validation; full suite; commit (fixtures first, then flips).
- [ ] **Step 4 (controller, real LLM):** `npx tsx scripts/run-live-matrix.ts --type anime --repeat 3` (runs all seeded anime cells). Observe & classify per the runbook.

---

## Self-Review

**Spec coverage (docs/design/2026-07-14-absolute-episode-numbering-design.md):**
- Absolute-episode table schema → Task 1 (`AbsoluteEpisodeTable`). ✓
- Derivation: season-concat baseline → Task 1; official episode-group → Tasks 2-3; official-first/concat-fallback/null-on-failure → Task 4. ✓
- Specials excluded → relies on `getSeasonTable` already filtering season 0 (noted in Task 1 comment) + concat only over provided seasons. ✓
- `reliable` marking / never force-feed a guess → `reliable` flag + `absoluteFor` null + `resolveAbsoluteEpisode` null-on-failure (Tasks 1,4). ✓
- Both directions + no-season / invented-season → the absolute axis is the common key; Task 10 mixed cell exercises invented-season; not-yet-aired → `no_safe_match` (Task 10). ✓
- Plumbing (orchestrator computes, worker consumes, sandbox intact) → Task 6 mapper computes; Task 5 worker only sees its own number. ✓
- Worker treats it as hint, still verifies (north star) → Task 5 prompt wording + Task 7 skill. ✓
- Coverage-first language (no 简/繁 rank, reject non-Chinese) → Task 7 skill + Task 8 `zh-any` + Task 10 multi-version. ✓
- Test cells (进击/咒术/multi-version) → Tasks 9-10. ✓
- Risk: episode-groups API shape (type===2) → Task 3 note flags live-verification. ✓

**Placeholder scan:** No TBD/TODO. Tasks 6, 9, 10 defer some fixture/wiring specifics to "read the file / follow the exemplar" — acceptable because the exemplars (`fixtures/v3-live/anime/only-pack/`, existing mapper deps) are concrete and named; the pure/logic tasks (1-5, 8) are fully spelled out.

**Type consistency:** `AbsoluteEpisodeTable` / `buildFromSeasonConcat` / `buildFromAbsoluteOrder` / `absoluteFor` / `resolveAbsoluteEpisode` / `AbsoluteOrderSource` names are consistent across Tasks 1-6. `FindSubtitleTask.absoluteEpisode: number | null` (Task 5) matches its consumer in Task 6 and the prompt in Task 5. `getAbsoluteOrder(tvId): Promise<{season,episode}[]|null>` (Task 3) matches the `AbsoluteOrderSource` shape (Task 4) and the `resolveAbsoluteEpisode` call (Task 6). `CellExpectation` `'zh-any'` (Task 8) matches Task 10's usage.

**Note on Phase 3:** flagged HUMAN-CURATED — the subagent-driven executor must skip Task 7 and hand it back to the controller (skill-authority hard law).
