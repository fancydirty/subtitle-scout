# v3 Live Test Matrix — A Layer (find-subtitle worker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the machinery to test the find-subtitle worker against real provider responses and a real (mimo-v2.5) model across the resource-type × source-return-form matrix, and seed one fully-working anchor cell end-to-end — so the matrix can then be *populated* (auto-research loop) as ongoing operation.

**Architecture:** A provider-agnostic **fetch-layer record/replay** shim (`src/testing/replayFetch.ts`) is injected into the *real* adapters (`makeAssrtAdapter` etc.) via their existing `fetchImpl` seam. Recorded raw provider responses live under `fixtures/v3-live/<resourceType>/<sourceForm>/responses/` next to a `cell.json` (task + expected answer). Two consumers share this: (1) an **in-suite deterministic integration test** — real adapters + replay + a *scripted mock model* — proving the recorded responses parse and the plumbing carries them; (2) an **out-of-band matrix runner** (`scripts/run-live-matrix.ts`, real mimo-v2.5, never in `npm test`) — proving *judgment*. A separate **recorder** (`scripts/record-provider-responses.ts`) hits real providers once (rate-limited) to mint a cell's `responses/`.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, `ai`@7 + `ai/test` MockLanguageModelV4, zod, tsx (out-of-band scripts), OrbStack/Docker (isolation recipe). Real providers: assrt (workhorse, Chinese), opensubtitles (欧美 anchor). Real model: mimo-v2.5 via `makeModel`.

**Why this shape (explicit decisions):**
- **Replay at the `fetch` layer, not the assrt on-disk response cache.** The on-disk cache is TTL/mtime-sensitive and embeds the token in its key — it goes stale in 24h and isn't a stable fixture. The `fetchImpl` seam already exists on every provider client *and* on the worker (`deps.fetchImpl` for the download step), so one shim serves both, is TTL-free, network-free, and exercises the *real* parse path.
- **Matrix runner is out-of-band (a script), not `npm test`.** It hits a real non-deterministic model, needs secrets, and burns quota — exactly what must never be in CI. It mirrors the existing `scripts/live-accept-find-subtitle.ts` (guarded with `if (process.env.VITEST) throw`).
- **OrbStack container is isolation convenience, not load-bearing.** The runner mkdtemp's a throwaway media tree per cell (like the eval test), so it never touches the NAS. In *replay* mode it needs only the LLM network. A thin `docker run` recipe honors the "在 OrbStack 容器跑" requirement without a new long-lived service.
- **This plan builds the machine + one anchor cell.** Populating all cells is the auto-research loop (the runbook), driven by live quota over days — execution, not build.

---

## File Structure

**New files:**
- `src/testing/replayFetch.ts` — `requestSignature`, `makeReplayFetch`, `makeRecordingFetch`. Provider-agnostic fetch-layer record/replay. One responsibility: turn a `responses/` dir into a deterministic `typeof fetch`, and vice-versa.
- `src/testing/replayFetch.test.ts` — unit tests for the shim (signature normalization, exact/unique-path/ambiguous resolution, record round-trip).
- `src/testing/liveMatrix.ts` — `LiveMatrixCell` type, `RESOURCE_TYPES`/`SOURCE_FORMS` axis constants, `CELL_CATALOG`, `loadCell`, `cellDir`. One responsibility: describe and load matrix cells.
- `src/testing/liveMatrix.test.ts` — validates every catalog entry that is marked `seeded: true` has a well-formed `cell.json` and a non-empty `responses/`.
- `src/testing/findSubtitleWorker.replay.test.ts` — the in-suite deterministic integration test: real adapters + replay + scripted mock model over seeded cells.
- `scripts/record-provider-responses.ts` — out-of-band recorder (real providers, rate-limited).
- `scripts/run-live-matrix.ts` — out-of-band real-model matrix runner + reporter.
- `scripts/run-live-matrix-in-orbstack.sh` — OrbStack `docker run` recipe.
- `docs/design/2026-07-13-v3-live-matrix-runbook.md` — the auto-research loop runbook.
- `fixtures/v3-live/anime/only-pack/cell.json` + `responses/*.json` — the seeded anchor cell (日漫 / only-合集包).

**Modified files:**
- `.gitignore` — ignore the runner's scratch dir.

---

## Task 1: Fetch-layer replay — signature + `makeReplayFetch`

**Files:**
- Create: `src/testing/replayFetch.ts`
- Test: `src/testing/replayFetch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/testing/replayFetch.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestSignature, makeReplayFetch } from './replayFetch.js'

describe('requestSignature', () => {
  it('normalizes: drops token/api_key, sorts query, keeps method+path', () => {
    const a = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?token=SECRET&q=hi&filelist=1', undefined)
    const b = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?filelist=1&q=hi&token=OTHER', undefined)
    expect(a).toBe(b)
    expect(a).toContain('GET')
    expect(a).toContain('/v1/sub/search')
    expect(a).not.toContain('SECRET')
  })

  it('folds POST body into the signature', () => {
    const a = requestSignature('POST', 'https://x/api/download', JSON.stringify({ file_id: 1 }))
    const b = requestSignature('POST', 'https://x/api/download', JSON.stringify({ file_id: 2 }))
    expect(a).not.toBe(b)
  })
})

describe('makeReplayFetch resolution', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'replay-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  function record(sig: string, body: unknown, status = 200, headers: Record<string, string> = {}) {
    const name = requestSignature.hash(sig)
    const bodyBase64 = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)).toString('base64')
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ signature: sig, status, headers, bodyBase64 }))
  }

  it('serves an exact-signature match as a real Response', async () => {
    const sig = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?q=hi', undefined)
    record(sig, { status: 0, sub: { subs: [] } })
    const fetchImpl = makeReplayFetch(dir)
    const res = await fetchImpl('https://api.assrt.net/v1/sub/search?token=T&q=hi')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 0, sub: { subs: [] } })
  })

  it('falls back to the unique response for the same method+path when query differs', async () => {
    // Recorded under q=進撃の巨人; model searches q=Attack on Titan -> different exact sig,
    // but there is exactly ONE recorded response for GET /v1/sub/search, so serve it.
    const recordedSig = requestSignature('GET', 'https://api.assrt.net/v1/sub/search?q=%E9%80%B2%E6%92%83', undefined)
    record(recordedSig, { status: 0, sub: { subs: [{ id: 1 }] } })
    const fetchImpl = makeReplayFetch(dir)
    const res = await fetchImpl('https://api.assrt.net/v1/sub/search?token=T&q=Attack%20on%20Titan')
    expect((await res.json()).sub.subs[0].id).toBe(1)
  })

  it('throws a loud miss when a path+method is ambiguous (2 recorded, no exact)', async () => {
    record(requestSignature('GET', 'https://api.assrt.net/v1/sub/detail?id=1', undefined), { status: 0, a: 1 })
    record(requestSignature('GET', 'https://api.assrt.net/v1/sub/detail?id=2', undefined), { status: 0, a: 2 })
    const fetchImpl = makeReplayFetch(dir)
    await expect(fetchImpl('https://api.assrt.net/v1/sub/detail?token=T&id=999'))
      .rejects.toThrow(/no recorded response/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/replayFetch.test.ts`
Expected: FAIL — `Cannot find module './replayFetch.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/testing/replayFetch.ts` (only the `requestSignature` + `makeReplayFetch` halves in this task; `makeRecordingFetch` comes in Task 2):

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** One recorded HTTP exchange on disk: `<hash(signature)>.json`. Body is base64 so binary
 *  subtitle downloads (zip/gzip) round-trip losslessly alongside JSON API responses. */
export interface RecordedResponse {
  signature: string
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

const VOLATILE_PARAMS = new Set(['token', 'api_key', 'apikey'])

/** Canonical request identity used as the replay key. Deliberately strips volatile auth params
 *  (assrt puts `token` in the query; different runs/tokens must map to the same fixture) and
 *  sorts the remaining query so param order never matters. POST bodies are folded in so two
 *  different download payloads to the same path stay distinct. */
export function requestSignature(method: string, url: string, body: string | undefined): string {
  const u = new URL(url)
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !VOLATILE_PARAMS.has(k.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = params.map(([k, v]) => `${k}=${v}`).join('&')
  const bodyTag = body ? `#${createHash('sha1').update(body).digest('hex').slice(0, 12)}` : ''
  return `${method.toUpperCase()} ${u.origin}${u.pathname}${query ? `?${query}` : ''}${bodyTag}`
}
/** Filename stem for a signature. Attached to the function so tests/recorder share it. */
requestSignature.hash = (sig: string): string => createHash('sha1').update(sig).digest('hex')
/** Method+path only (no query, no body) — the fallback bucket key. */
requestSignature.pathOnly = (method: string, url: string): string => {
  const u = new URL(url)
  return `${method.toUpperCase()} ${u.origin}${u.pathname}`
}

function bodyOf(init: RequestInit | undefined): string | undefined {
  if (!init?.body) return undefined
  return typeof init.body === 'string' ? init.body : undefined
}

/** A `typeof fetch` that answers from a `responses/` dir. Resolution order:
 *  1. exact signature match;
 *  2. else, if exactly ONE recorded response shares the method+path, serve it (robust to the
 *     real model phrasing a search query differently than it was recorded);
 *  3. else throw — an ambiguous path (≥2 recorded, none exact) must be recorded precisely. */
export function makeReplayFetch(dir: string): typeof fetch {
  const all: RecordedResponse[] = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedResponse)
  const bySig = new Map(all.map(r => [r.signature, r]))
  const byPath = new Map<string, RecordedResponse[]>()
  for (const r of all) {
    // signature is "METHOD origin/path[?query][#bodytag]" — path bucket = up to the '?' or '#'
    const path = r.signature.replace(/[?#].*$/, '')
    const list = byPath.get(path) ?? []
    list.push(r)
    byPath.set(path, list)
  }
  const toResponse = (r: RecordedResponse) =>
    new Response(Buffer.from(r.bodyBase64, 'base64'), { status: r.status, headers: r.headers })

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    const sig = requestSignature(method, url, bodyOf(init))
    const exact = bySig.get(sig)
    if (exact) return toResponse(exact)
    const bucket = byPath.get(requestSignature.pathOnly(method, url))
    if (bucket && bucket.length === 1) return toResponse(bucket[0])
    throw new Error(
      `replayFetch: no recorded response for ${sig}` +
      (bucket ? ` (${bucket.length} recorded for this path — record the exact query)` : ' (path never recorded)'),
    )
  }) as typeof fetch
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/replayFetch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/testing/replayFetch.ts src/testing/replayFetch.test.ts
git commit -m "test(v3-matrix): fetch-layer replay shim (signature + makeReplayFetch)"
```

---

## Task 2: Fetch-layer replay — `makeRecordingFetch`

**Files:**
- Modify: `src/testing/replayFetch.ts` (append `makeRecordingFetch`)
- Test: `src/testing/replayFetch.test.ts` (append a record round-trip test)

- [ ] **Step 1: Write the failing test**

Append to `src/testing/replayFetch.test.ts`:

```ts
import { makeRecordingFetch } from './replayFetch.js'

describe('makeRecordingFetch round-trip', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'record-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('records a real fetch to disk and replays it identically', async () => {
    // Fake "real" fetch: returns a JSON body; recorder must persist it and hand back a
    // still-readable Response (body not consumed by the tee).
    const realFetch = (async () => new Response(JSON.stringify({ status: 0, sub: { subs: [{ id: 42 }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const recording = makeRecordingFetch(dir, realFetch)

    const live = await recording('https://api.assrt.net/v1/sub/search?token=T&q=hi')
    expect((await live.json()).sub.subs[0].id).toBe(42)   // caller still gets a usable body

    const replay = makeReplayFetch(dir)
    const played = await replay('https://api.assrt.net/v1/sub/search?token=DIFFERENT&q=hi')
    expect((await played.json()).sub.subs[0].id).toBe(42)  // persisted + token-insensitive
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/replayFetch.test.ts`
Expected: FAIL — `makeRecordingFetch` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/testing/replayFetch.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'

/** Wraps a real `fetch`: every call is teed to `dir` as a RecordedResponse keyed by its
 *  signature, then a fresh (unconsumed) Response is returned to the caller. Rate limiting is
 *  the *client's* job (assrt's MinIntervalLimiter) — this shim is pure I/O capture. */
export function makeRecordingFetch(dir: string, realFetch: typeof fetch = fetch): typeof fetch {
  mkdirSync(dir, { recursive: true })
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : 'GET')
    const body = init?.body && typeof init.body === 'string' ? init.body : undefined
    const res = await realFetch(input, init)
    const buf = Buffer.from(await res.clone().arrayBuffer())
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => { headers[k] = v })
    const sig = requestSignature(method, url, body)
    const record: RecordedResponse = { signature: sig, status: res.status, headers, bodyBase64: buf.toString('base64') }
    writeFileSync(join(dir, `${requestSignature.hash(sig)}.json`), JSON.stringify(record, null, 2))
    return res
  }) as typeof fetch
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/replayFetch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/testing/replayFetch.ts src/testing/replayFetch.test.ts
git commit -m "test(v3-matrix): fetch-layer recording wrapper (makeRecordingFetch)"
```

---

## Task 3: Matrix cell model — types, axes, catalog, loader

**Files:**
- Create: `src/testing/liveMatrix.ts`
- Test: `src/testing/liveMatrix.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/testing/liveMatrix.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { RESOURCE_TYPES, SOURCE_FORMS, CELL_CATALOG, cellDir, loadCell } from './liveMatrix.js'

describe('live matrix catalog', () => {
  it('every catalog cell names a valid axis pair', () => {
    for (const c of CELL_CATALOG) {
      expect(RESOURCE_TYPES).toContain(c.resourceType)
      expect(SOURCE_FORMS).toContain(c.sourceForm)
    }
  })

  it('cell ids are unique', () => {
    const ids = CELL_CATALOG.map(c => `${c.resourceType}/${c.sourceForm}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('cellDir maps to fixtures/v3-live/<type>/<form>', () => {
    expect(cellDir('anime', 'only-pack')).toMatch(/fixtures\/v3-live\/anime\/only-pack$/)
  })

  it('every SEEDED cell loads with a task, expected answer, and a non-empty responses dir', () => {
    for (const c of CELL_CATALOG.filter(x => x.seeded)) {
      const loaded = loadCell(c.resourceType, c.sourceForm)
      expect(loaded.task.title.length).toBeGreaterThan(0)
      expect(['installed', 'no_safe_match', 'retry_later']).toContain(loaded.expected.decision)
      expect(loaded.responseCount).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/liveMatrix.test.ts`
Expected: FAIL — `Cannot find module './liveMatrix.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/testing/liveMatrix.ts`:

```ts
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'

/** Resource-type axis (spec §两轴). Chinese-content types map to assrt as primary provider;
 *  `western` may use opensubtitles. */
export const RESOURCE_TYPES = ['anime', 'cdrama', 'western', 'movie'] as const
export type ResourceType = typeof RESOURCE_TYPES[number]

/** Source-return-form axis (spec §两轴) + the mandatory counter-example. `none` = the source
 *  genuinely returns nothing usable → the worker must honestly finalize no_safe_match
 *  ("不比 Bazarr 烂" floor). */
export const SOURCE_FORMS = ['only-pack', 'only-single', 'mixed', 'season-pack', 'multi-version', 'none'] as const
export type SourceForm = typeof SOURCE_FORMS[number]

/** The expected correct outcome for a cell — asserted by both the in-suite replay test and the
 *  out-of-band matrix runner. No confidence score (north star #1); we assert the *decision* and,
 *  for `installed`, which candidate/file/language is correct. */
export interface CellExpectation {
  decision: 'installed' | 'no_safe_match' | 'retry_later'
  /** installed only: the composite candidate the worker should have chosen. */
  candidateProvider?: string
  candidateProviderId?: string
  /** installed only: the basename that must appear beside the video, and its language tag. */
  installedFilename?: string
  installedLanguage?: 'zh-Hans' | 'zh-Hant'
}

/** On-disk `cell.json`. `task` omits the three runtime-supplied fields (the runner/test fills
 *  jobId/mediaRoot/videoPath), exactly like EvalFixture in findSubtitleWorker.eval.test.ts. */
export interface CellFile {
  task: Omit<FindSubtitleTask, 'jobId' | 'mediaRoot' | 'videoPath'>
  expected: CellExpectation
  note: string
}

export interface LoadedCell extends CellFile {
  resourceType: ResourceType
  sourceForm: SourceForm
  dir: string
  responsesDir: string
  responseCount: number
}

/** One row in the matrix. `seeded` gates the in-suite test: only cells whose fixtures actually
 *  exist are asserted; unseeded cells are the auto-research backlog (populate via the runbook). */
export interface CatalogEntry {
  resourceType: ResourceType
  sourceForm: SourceForm
  seeded: boolean
  /** Human note: the concrete resource this cell represents. */
  represents: string
}

/** The A-layer matrix. Seeded = fixtures present in this repo; the rest are the populate-me
 *  backlog. Start with the anchor (anime/only-pack — the live-acceptance cell) and grow. */
export const CELL_CATALOG: CatalogEntry[] = [
  { resourceType: 'anime', sourceForm: 'only-pack', seeded: true, represents: 'Attack on Titan S01E01 — only a Complete-Series pack exists (live-acceptance cell)' },
  { resourceType: 'anime', sourceForm: 'season-pack', seeded: false, represents: 'Attack on Titan — single-season pack, not full series' },
  { resourceType: 'anime', sourceForm: 'only-single', seeded: false, represents: 'Scissor Seven — per-episode subtitles only' },
  { resourceType: 'anime', sourceForm: 'mixed', seeded: false, represents: 'anime with both pack and single candidates' },
  { resourceType: 'anime', sourceForm: 'multi-version', seeded: false, represents: 'same episode, 简/繁/日 versions' },
  { resourceType: 'cdrama', sourceForm: 'only-pack', seeded: false, represents: 'Nirvana in Fire — whole-series pack' },
  { resourceType: 'cdrama', sourceForm: 'multi-version', seeded: false, represents: '琅琊榜 — 简/繁 versions' },
  { resourceType: 'western', sourceForm: 'only-single', seeded: false, represents: 'Peacemaker / Young Sheldon — per-episode' },
  { resourceType: 'western', sourceForm: 'mixed', seeded: false, represents: 'Love Death & Robots — anthology' },
  { resourceType: 'movie', sourceForm: 'multi-version', seeded: false, represents: 'Hero / Wandering Earth — 剪辑版/时长 variants' },
  { resourceType: 'movie', sourceForm: 'none', seeded: false, represents: 'obscure film — no correct subtitle exists (counter-example floor)' },
]

const FIXTURE_ROOT = 'fixtures/v3-live'

export function cellDir(resourceType: ResourceType, sourceForm: SourceForm): string {
  return join(FIXTURE_ROOT, resourceType, sourceForm)
}

export function loadCell(resourceType: ResourceType, sourceForm: SourceForm): LoadedCell {
  const dir = cellDir(resourceType, sourceForm)
  const file = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8')) as CellFile
  const responsesDir = join(dir, 'responses')
  const responseCount = existsSync(responsesDir)
    ? readdirSync(responsesDir).filter(f => f.endsWith('.json')).length
    : 0
  return { ...file, resourceType, sourceForm, dir, responsesDir, responseCount }
}
```

- [ ] **Step 4: Run test to verify it fails on the SEEDED assertion**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/liveMatrix.test.ts`
Expected: FAIL on the last test — `anime/only-pack` is marked `seeded: true` but its fixtures don't exist yet (`ENOENT ... fixtures/v3-live/anime/only-pack/cell.json`). The first three tests PASS. This failure is the driver for Task 4.

- [ ] **Step 5: Commit (catalog + loader; seeded assertion still red until Task 4)**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/testing/liveMatrix.ts src/testing/liveMatrix.test.ts
git commit -m "test(v3-matrix): live matrix cell model — axes, catalog, loader"
```

Note: committing with one test red is intentional here — Task 4 supplies the fixture that greens it, and the two tasks land back-to-back. If you prefer green-only commits, do Task 4 before committing this task.

---

## Task 4: Seed the anchor cell fixtures by hand (anime / only-pack)

This is an **operational task** (authoring fixture data), not red-green. It hand-authors the raw provider responses + subtitle bytes for the live-acceptance cell, so the machine is provable end-to-end offline before any real recording. The raw shapes match assrt's real API exactly (verified against `src/core/schemas.ts` FileListSchema `[{s?,f,url?}]` and `fixtures/assrt/detail-season-pack.json`).

**Files:**
- Create: `fixtures/v3-live/anime/only-pack/cell.json`
- Create: `fixtures/v3-live/anime/only-pack/responses/search.json`
- Create: `fixtures/v3-live/anime/only-pack/responses/similar.json`
- Create: `fixtures/v3-live/anime/only-pack/responses/detail.json`
- Create: `fixtures/v3-live/anime/only-pack/responses/download.json`

- [ ] **Step 1: Author `cell.json`**

`fixtures/v3-live/anime/only-pack/cell.json`:

```json
{
  "task": {
    "videoFilename": "Attack.on.Titan.S01E01.mkv",
    "title": "Attack on Titan",
    "originalTitle": "進撃の巨人",
    "year": 2013, "season": 1, "episode": 1,
    "alternativeTitles": ["進擊的巨人", "进击的巨人"],
    "overview": null, "runtimeMinutes": 24,
    "providerIds": { "tmdb": "1429" }
  },
  "expected": {
    "decision": "installed",
    "candidateProvider": "assrt",
    "candidateProviderId": "900900",
    "installedFilename": "Attack.on.Titan.S01E01.zh-Hant.srt",
    "installedLanguage": "zh-Hant"
  },
  "note": "Only candidate is a S1+S2+S3+OAD complete-series pack; the worker must enter the pack's filelist and pick S01E01 by fileIndex. This is the cell the first live acceptance passed."
}
```

- [ ] **Step 2: Author the recorded responses**

The replay shim keys by normalized signature but resolves via the unique-path fallback, so the exact recorded query text doesn't need to match what the model will search — one response per assrt endpoint suffices. Use the real assrt API base `https://api.assrt.net/v1`.

Compute each file's own `signature` with the real request the assrt client makes. To avoid hand-hashing, author with a placeholder signature and let a tiny inline node one-liner (Step 3) rewrite each `signature` to the canonical value — OR author the signatures directly using these exact strings (path-only fallback will serve them regardless of the model's query, so the query portion only needs to be present, not identical to runtime):

`fixtures/v3-live/anime/only-pack/responses/search.json`:

```json
{
  "signature": "GET https://api.assrt.net/v1/sub/search?filelist=1&no_muxer=1&q=Attack%20on%20Titan",
  "status": 200,
  "headers": { "content-type": "application/json" },
  "bodyBase64": "__RUN_STEP_3_TO_FILL__"
}
```

The decoded body for `search.json` must be this JSON (a single complete-series pack candidate, id 900900):

```json
{ "status": 0, "sub": { "subs": [ {
  "id": 900900,
  "videoname": "進擊的巨人 S1+S2+S3+OAD1~8 繁中字幕合集",
  "native_name": "進擊的巨人",
  "lang": { "desc": "繁" },
  "subtype": "Subrip(srt)",
  "release_site": "VCB-Studio",
  "filelist": [
    { "s": "40KB", "f": "Attack.on.Titan.S01E01.BDrip.1080p.繁体.srt" },
    { "s": "41KB", "f": "Attack.on.Titan.S01E02.BDrip.1080p.繁体.srt" },
    { "s": "42KB", "f": "Attack.on.Titan.S01E03.BDrip.1080p.繁体.srt" }
  ]
} ] } }
```

`fixtures/v3-live/anime/only-pack/responses/similar.json` — decoded body `{ "status": 0, "sub": { "subs": [] } }`, signature `GET https://api.assrt.net/v1/sub/similar?id=900900`.

`fixtures/v3-live/anime/only-pack/responses/detail.json` — signature `GET https://api.assrt.net/v1/sub/detail?id=900900`, decoded body (same pack, now with per-file `url`s):

```json
{ "status": 0, "sub": { "subs": [ {
  "id": 900900,
  "videoname": "進擊的巨人 S1+S2+S3+OAD1~8 繁中字幕合集",
  "native_name": "進擊的巨人",
  "lang": { "desc": "繁" },
  "subtype": "Subrip(srt)",
  "filelist": [
    { "s": "40KB", "f": "Attack.on.Titan.S01E01.BDrip.1080p.繁体.srt", "url": "http://file0.assrt.net/pack/900900/1" },
    { "s": "41KB", "f": "Attack.on.Titan.S01E02.BDrip.1080p.繁体.srt", "url": "http://file0.assrt.net/pack/900900/2" },
    { "s": "42KB", "f": "Attack.on.Titan.S01E03.BDrip.1080p.繁体.srt", "url": "http://file0.assrt.net/pack/900900/3" }
  ]
} ] } }
```

`fixtures/v3-live/anime/only-pack/responses/download.json` — signature `GET http://file0.assrt.net/pack/900900/1`, decoded body the actual subtitle text:

```
1
00:00:01,000 --> 00:00:03,000
繁體中文字幕 第１話

2
00:00:04,000 --> 00:00:06,000
第二句台詞
```

- [ ] **Step 3: Fill each `bodyBase64` and canonicalize each `signature` with a one-shot node script**

Run this from the repo root — it reads a sidecar `.body` for each response, base64-encodes it into the JSON, and normalizes the `signature` field via the shipped `requestSignature`. First create the four decoded bodies as sidecar files, then run:

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
D=fixtures/v3-live/anime/only-pack/responses
# write the decoded bodies (copy the JSON/text from Step 2 into these):
#   $D/search.body  $D/similar.body  $D/detail.body  $D/download.body
npx tsx -e '
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { requestSignature } from "./src/testing/replayFetch.js"
const D = "fixtures/v3-live/anime/only-pack/responses"
const map: Record<string,[string,string,string|undefined]> = {
  "search":   ["GET","https://api.assrt.net/v1/sub/search?filelist=1&no_muxer=1&q=x", undefined],
  "similar":  ["GET","https://api.assrt.net/v1/sub/similar?id=900900", undefined],
  "detail":   ["GET","https://api.assrt.net/v1/sub/detail?id=900900", undefined],
  "download": ["GET","http://file0.assrt.net/pack/900900/1", undefined],
}
for (const [name,[m,u,b]] of Object.entries(map)) {
  const body = readFileSync(join(D, name + ".body"))
  const rec = { signature: requestSignature(m,u,b), status: 200,
    headers: { "content-type": name === "download" ? "text/plain" : "application/json" },
    bodyBase64: body.toString("base64") }
  writeFileSync(join(D, name + ".json"), JSON.stringify(rec, null, 2))
}
console.log("wrote 4 recorded responses")
'
rm -f $D/*.body
```

Expected output: `wrote 4 recorded responses`.

- [ ] **Step 4: Verify the seeded catalog test now passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/liveMatrix.test.ts`
Expected: PASS (4 tests) — `anime/only-pack` now loads with `responseCount === 4`.

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add fixtures/v3-live/anime/only-pack src/testing/liveMatrix.ts
git commit -m "test(v3-matrix): seed anchor cell fixtures (anime/only-pack)"
```

---

## Task 5: In-suite deterministic replay integration test

Real adapters (`makeAssrtAdapter` + real `AssrtClient`) over the replay fetch + a scripted mock model, driving the anchor cell to `installed`. This proves the recorded raw responses parse through the *real* provider path and the pack fileIndex flows through — a stronger, deterministic complement to `findSubtitleWorker.eval.test.ts` (which used inline fake adapters). It is also the home for future deterministic **code-bug** regressions from the auto-research loop.

**Files:**
- Create: `src/testing/findSubtitleWorker.replay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/testing/findSubtitleWorker.replay.test.ts`:

```ts
// Deterministic integration: REAL assrt adapter + REAL AssrtClient over a REPLAY fetch of the
// cell's recorded raw responses, driven by a SCRIPTED mock model. Proves the recorded responses
// parse through the real provider path and the pack's fileIndex flows end-to-end to an installed
// file. It does NOT evaluate model judgment — that is scripts/run-live-matrix.ts (real mimo-v2.5).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { AssrtClient, MinIntervalLimiter } from '../adapters/providers/assrt.js'
import { makeAssrtAdapter } from '../cli/adapters/assrtAdapter.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import type { FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'
import { makeReplayFetch } from './replayFetch.js'
import { loadCell } from './liveMatrix.js'

function toolResult(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content as any[]) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') return part.output.value
    }
  }
  return undefined
}
function step(id: string, name: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
    warnings: [],
  }
}

describe('find-subtitle worker replay integration: anime/only-pack', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-replay-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('installs S01E01 from the recorded complete-series pack via the real assrt adapter', async () => {
    const cell = loadCell('anime', 'only-pack')
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Attack on Titan')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, cell.task.videoFilename)

    const replay = makeReplayFetch(cell.responsesDir)
    // Real client: replay fetch + zero-interval limiter (no 15s wait) + throwaway cache dir.
    const client = new AssrtClient({
      token: 'replay', cacheDir: join(root, 'assrt-cache'),
      fetchImpl: replay, limiter: new MinIntervalLimiter(0),
    })
    const adapters = [makeAssrtAdapter(client)]

    // Scripted mock, emitting args the way real mimo-v2.5 does (composite candidateKey id,
    // string fileIndex) — the shape that hid the param-flow bugs before the live trace.
    let call = 0
    const doGenerate = async (options: LanguageModelV4CallOptions) => {
      call++
      if (call === 1) return step('c1', 'search_source', { queries: [cell.task.title, cell.task.originalTitle] })
      if (call === 2) {
        const searched = toolResult(options.prompt, 'search_source')
        return step('c2', 'get_candidate', { result_set_id: searched.result_set_id, index: 0, detail: 'detailed' })
      }
      if (call === 3) {
        const got = toolResult(options.prompt, 'get_candidate')
        const entry = (got.fileList as { index: number; name: string }[]).find(f => /S01E01/i.test(f.name))!
        // composite id + STRING fileIndex — real-model shape
        return step('c3', 'download_candidate', { candidateId: `assrt:${cell.expected.candidateProviderId}`, fileIndex: String(entry.index) })
      }
      if (call === 4) {
        const dl = toolResult(options.prompt, 'download_candidate')
        return step('c4', 'install_subtitle', { stagedFileId: dl.stagedFileId, langTag: cell.expected.installedLanguage })
      }
      const installed = toolResult(options.prompt, 'install_subtitle')
      return step('finalize-1', 'finalize', {
        decision: 'installed', reason: 'picked S01E01 out of the recorded pack filelist',
        installedPath: installed.path, installedLanguage: cell.expected.installedLanguage,
        candidateProvider: cell.expected.candidateProvider, candidateProviderId: cell.expected.candidateProviderId,
      })
    }

    const runTask = makeFindSubtitleWorker({
      model: new MockLanguageModelV4({ doGenerate }),
      adapters, cacheRoot: join(root, 'cache'),
      fetchImpl: replay, stepCap: 12,   // worker's OWN download fetch also replays
    })

    const task: FindSubtitleTask = { ...cell.task, jobId: 'replay-anime-only-pack', mediaRoot, videoPath }
    const decision = await runTask(task)

    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(showDir, cell.expected.installedFilename!))
    expect(existsSync(decision.installedPath!)).toBe(true)
    expect(decision.candidateProviderId).toBe(cell.expected.candidateProviderId)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/findSubtitleWorker.replay.test.ts`
Expected: initially FAIL. Likely first failure is an assertion mismatch or a tool-arg shape issue — **do not paper over it**. Read the actual error. If `get_candidate`/`search_source`/`download_candidate` field names differ from what the mock reads, open `src/agent/resultHandles.ts` and `src/agent/findSubtitleWorker.tools.ts`, confirm the real returned field names, and fix the mock to match reality (PLAN-BUG DISCIPLINE: the plan's mock is a starting point; the real tool contract wins).

- [ ] **Step 3: Reconcile the mock to the real tool contract**

Read the two files to confirm the exact field names the tools return:

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && sed -n '1,200p' src/agent/resultHandles.ts` and `sed -n '1,120p' src/agent/findSubtitleWorker.tools.ts`

Adjust the mock's `toolResult(...)` field reads (`.result_set_id`, `.fileList`, `.stagedFileId`, `.path`) to whatever the tools actually return. Make the SMALLEST change that matches reality — one field at a time, re-running after each.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/testing/findSubtitleWorker.replay.test.ts`
Expected: PASS (1 test) — a real `.srt` installed at `Attack on Titan/Attack.on.Titan.S01E01.zh-Hant.srt`.

- [ ] **Step 5: Run the whole suite to confirm no regressions, then commit**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run`
Expected: all green (prior count + new tests).

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/testing/findSubtitleWorker.replay.test.ts
git commit -m "test(v3-matrix): deterministic replay integration over anchor cell"
```

---

## Task 6: Out-of-band recorder script

Mints a cell's `responses/` by running the real adapters against real providers once, with the recording fetch. Rate limiting is the client's own `MinIntervalLimiter` (assrt 15s). Guarded against CI.

**Files:**
- Create: `scripts/record-provider-responses.ts`

- [ ] **Step 1: Write the script**

Create `scripts/record-provider-responses.ts`:

```ts
// Out-of-band recorder — NOT part of `npm test`. Hits real providers to mint a matrix cell's
// recorded responses. Rate limiting is the assrt client's own MinIntervalLimiter.
//
// Usage:
//   npx tsx scripts/record-provider-responses.ts --type anime --form only-pack \
//     --title "Attack on Titan" [--original 進撃の巨人] [--season 1 --episode 1 --year 2013]
//
// Requires ASSRT_TOKEN (and/or OPENSUBTITLES_API_KEY) in .env. Writes:
//   fixtures/v3-live/<type>/<form>/responses/*.json
// You still hand-author cell.json's `expected` (the correct answer) — the recorder only captures
// what the source returned; deciding which candidate is CORRECT is the human's job.
import { parseArgs } from 'node:util'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import 'dotenv/config'
import { AssrtClient } from '../src/adapters/providers/assrt.js'
import { makeAssrtAdapter } from '../src/cli/adapters/assrtAdapter.js'
import type { FetchAdapter, FetchArgs } from '../src/cli/fetchLib.js'
import { runSearch, runResolve } from '../src/cli/fetchLib.js'
import { makeRecordingFetch } from '../src/testing/replayFetch.js'
import { cellDir, RESOURCE_TYPES, SOURCE_FORMS, type ResourceType, type SourceForm } from '../src/testing/liveMatrix.js'

if (process.env.VITEST) throw new Error('recorder must not run under vitest — it hits real providers')

const { values } = parseArgs({ options: {
  type: { type: 'string' }, form: { type: 'string' }, title: { type: 'string' },
  original: { type: 'string' }, season: { type: 'string' }, episode: { type: 'string' }, year: { type: 'string' },
} })
const type = values.type as ResourceType
const form = values.form as SourceForm
if (!RESOURCE_TYPES.includes(type) || !SOURCE_FORMS.includes(form) || !values.title) {
  console.error(`usage: --type <${RESOURCE_TYPES.join('|')}> --form <${SOURCE_FORMS.join('|')}> --title <title> [--original --season --episode --year]`)
  process.exit(1)
}

async function main() {
  const responsesDir = join(cellDir(type, form), 'responses')
  mkdirSync(responsesDir, { recursive: true })
  const recording = makeRecordingFetch(responsesDir)

  const adapters: FetchAdapter[] = []
  if (process.env.ASSRT_TOKEN) {
    // Recording fetch + throwaway cache dir so every call actually hits the network and is teed.
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN, cacheDir: join(responsesDir, '.throwaway-cache'), fetchImpl: recording,
    })
    adapters.push(makeAssrtAdapter(client))
  }
  if (adapters.length === 0) throw new Error('set ASSRT_TOKEN in .env to record')

  const queries = [values.title!, values.original].filter(Boolean) as string[]
  const args: FetchArgs = {
    queries, year: values.year ? Number(values.year) : undefined,
    season: values.season ? Number(values.season) : undefined,
    episode: values.episode ? Number(values.episode) : undefined,
    filename: undefined, languages: ['zh-cn', 'zh-tw'], deep: true,
  }
  const emit = (e: unknown) => console.error('[event]', JSON.stringify(e))
  const candidates = await runSearch(args, adapters, emit)
  console.error(`recorded search → ${candidates.length} candidate(s)`)
  candidates.forEach((c, i) => console.error(`  [${i}] ${c.provider}:${c.providerId} "${c.videoName ?? c.nativeName}" files=${c.fileList.length}`))

  // Also record detail/download for the top candidate so the download path is replayable. Pick
  // fileIndex 0 (or the pack entry you intend as the answer — re-run with the right one noted).
  if (candidates.length > 0) {
    const top = candidates[0]
    const fileIndex = top.fileList.length > 0 ? 0 : null
    const resolved = await runResolve({ provider: top.provider, providerId: top.providerId, fileIndex }, adapters, emit)
    console.error(`recorded detail+resolve → ${resolved.url}`)
    // Fetch the actual subtitle bytes THROUGH the recording fetch so download.json lands too.
    const res = await recording(resolved.url, resolved.headers ? { headers: resolved.headers } : undefined)
    console.error(`recorded download → ${res.status}, ${res.headers.get('content-type')}`)
  }
  console.error(`\n✅ responses written to ${responsesDir}`)
  console.error(`Next: hand-author ${cellDir(type, form)}/cell.json (task + the CORRECT expected answer), set the catalog entry seeded:true, run vitest.`)
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Typecheck the script (no network)**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsc --noEmit`
Expected: PASS (no type errors). This is the offline gate — it verifies the script wires the real constructors correctly without spending quota.

- [ ] **Step 3: Verify the usage guard prints without hitting network**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsx scripts/record-provider-responses.ts --type anime`
Expected: prints the `usage:` line and exits non-zero (missing `--form`/`--title`), no network call.

- [ ] **Step 4: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add scripts/record-provider-responses.ts
git commit -m "feat(v3-matrix): out-of-band provider-response recorder"
```

---

## Task 7: Out-of-band matrix runner (real mimo-v2.5)

Runs selected cells against the *real* model with replay adapters, asserts each cell's expected answer, and prints a report (decision vs expected, step count, pass/fail, thrown errors). Never in `npm test`.

**Files:**
- Create: `scripts/run-live-matrix.ts`

- [ ] **Step 1: Write the script**

Create `scripts/run-live-matrix.ts`:

```ts
// Out-of-band matrix runner — NOT part of `npm test`. Real mimo-v2.5 + REPLAY provider responses
// (network-free providers; only the LLM is live). Exposes judgment problems = the whole point.
//
// Usage:
//   npx tsx scripts/run-live-matrix.ts --all
//   npx tsx scripts/run-live-matrix.ts --type anime --form only-pack [--repeat 3]
//
// Requires LLM_BASE_URL/LLM_API_KEY/LLM_MODEL in .env. Provider creds NOT needed in replay mode.
import { parseArgs } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import 'dotenv/config'
import { makeModel } from '../src/agent/llm.js'
import { AssrtClient, MinIntervalLimiter } from '../src/adapters/providers/assrt.js'
import { makeAssrtAdapter } from '../src/cli/adapters/assrtAdapter.js'
import { makeFindSubtitleWorker } from '../src/agent/findSubtitleWorker.js'
import type { FindSubtitleTask } from '../src/agent/findSubtitleWorker.schemas.js'
import { makeReplayFetch } from '../src/testing/replayFetch.js'
import { CELL_CATALOG, loadCell, type CatalogEntry } from '../src/testing/liveMatrix.js'

if (process.env.VITEST) throw new Error('matrix runner must not run under vitest — it hits a real LLM')

const { values } = parseArgs({ options: {
  all: { type: 'boolean' }, type: { type: 'string' }, form: { type: 'string' }, repeat: { type: 'string' },
} })
const repeat = values.repeat ? Number(values.repeat) : 1

function selected(): CatalogEntry[] {
  const seeded = CELL_CATALOG.filter(c => c.seeded)
  if (values.all) return seeded
  return seeded.filter(c => (!values.type || c.resourceType === values.type) && (!values.form || c.sourceForm === values.form))
}

interface CellResult { cell: string; run: number; ok: boolean; got: string; want: string; steps: number | null; err?: string }

async function runOne(entry: CatalogEntry, run: number, model: ReturnType<typeof makeModel>): Promise<CellResult> {
  const cell = loadCell(entry.resourceType, entry.sourceForm)
  const id = `${entry.resourceType}/${entry.sourceForm}`
  const root = mkdtempSync(join(tmpdir(), 'scout-matrix-'))
  try {
    const mediaRoot = join(root, 'media', cell.task.title.replace(/[^\w.-]+/g, '_'))
    mkdirSync(mediaRoot, { recursive: true })
    const videoPath = join(mediaRoot, cell.task.videoFilename)
    const replay = makeReplayFetch(cell.responsesDir)
    const client = new AssrtClient({ token: 'replay', cacheDir: join(root, 'assrt-cache'), fetchImpl: replay, limiter: new MinIntervalLimiter(0) })
    const runTask = makeFindSubtitleWorker({
      model, adapters: [makeAssrtAdapter(client)], cacheRoot: join(root, 'cache'), fetchImpl: replay, stepCap: 500,
    })
    const task: FindSubtitleTask = { ...cell.task, jobId: `matrix-${id.replace('/', '-')}-${run}`, mediaRoot, videoPath }
    const decision = await runTask(task)
    // Assert per expectation. installed → decision + right file present + language; else → decision only.
    let ok = decision.decision === cell.expected.decision
    if (ok && cell.expected.decision === 'installed') {
      const want = join(mediaRoot, cell.expected.installedFilename!)
      ok = decision.installedPath === want && existsSync(want) && decision.installedLanguage === cell.expected.installedLanguage
    }
    return { cell: id, run, ok, got: decision.decision, want: cell.expected.decision, steps: null }
  } catch (e) {
    return { cell: id, run, ok: false, got: 'THREW', want: cell.expected.decision, steps: null, err: String(e) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const cells = selected()
  if (cells.length === 0) { console.error('no seeded cells match the selection'); process.exit(1) }
  const model = makeModel({ baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!, model: process.env.LLM_MODEL! })
  console.error(`running ${cells.length} cell(s) × ${repeat} run(s) against ${process.env.LLM_MODEL}\n`)
  const results: CellResult[] = []
  for (const c of cells) for (let r = 1; r <= repeat; r++) {
    const res = await runOne(c, r, model)
    results.push(res)
    console.error(`${res.ok ? '✅' : '❌'} ${res.cell} run ${r}: got=${res.got} want=${res.want}${res.err ? ` err=${res.err.slice(0, 200)}` : ''}`)
  }
  const passed = results.filter(r => r.ok).length
  console.error(`\n=== ${passed}/${results.length} passed ===`)
  // Per-cell stability (flakiness signal across repeats).
  for (const c of cells) {
    const rs = results.filter(r => r.cell === `${c.resourceType}/${c.sourceForm}`)
    const p = rs.filter(r => r.ok).length
    if (p !== rs.length) console.error(`  ⚠ ${c.resourceType}/${c.sourceForm}: ${p}/${rs.length} stable`)
  }
  process.exit(passed === results.length ? 0 : 2)
}
main().catch(e => { console.error(e); process.exit(1) })
```

- [ ] **Step 2: Typecheck (no network)**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Verify the no-match guard (no network)**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsx scripts/run-live-matrix.ts --type cdrama`
Expected: prints `no seeded cells match the selection` and exits non-zero (cdrama isn't seeded yet) — proves selection logic without hitting the LLM.

- [ ] **Step 4: Live smoke — run the seeded anchor cell against the real model**

This step spends real mimo-v2.5 quota (user's own plan; per spec "不用省只慢"). Ensure `.env` has LLM_* set.

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsx scripts/run-live-matrix.ts --type anime --form only-pack`
Expected: `✅ anime/only-pack run 1: got=installed want=installed` and exit 0. **If it fails, that is a real finding — stop and switch to systematic-debugging (step-trace the worker), do not patch the runner.** A red anchor cell here reproduces exactly the live-acceptance path, so a regression is meaningful.

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add scripts/run-live-matrix.ts
git commit -m "feat(v3-matrix): out-of-band real-model matrix runner + reporter"
```

---

## Task 8: OrbStack recipe, runbook, and gitignore

**Files:**
- Create: `scripts/run-live-matrix-in-orbstack.sh`
- Create: `docs/design/2026-07-13-v3-live-matrix-runbook.md`
- Modify: `.gitignore`

- [ ] **Step 1: Add the gitignore entry**

Append to `.gitignore` (the runner mkdtemp's under the OS tmpdir, but the OrbStack recipe mounts a scratch cache):

```
# v3 live matrix runner scratch (OrbStack recipe cache mount)
matrix-scratch/
```

- [ ] **Step 2: Write the OrbStack recipe**

Create `scripts/run-live-matrix-in-orbstack.sh` (make executable):

```bash
#!/usr/bin/env bash
# Run the live matrix inside an OrbStack/Docker container: clean filesystem + reproducible node,
# repo + fixtures mounted read-write, .env for the LLM key. Replay mode needs ONLY LLM network.
#
# Usage: scripts/run-live-matrix-in-orbstack.sh --type anime --form only-pack
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p matrix-scratch
docker run --rm \
  --env-file .env \
  -v "$PWD":/app -w /app \
  -v "$PWD/matrix-scratch":/tmp/matrix-scratch \
  node:22-slim \
  sh -lc 'npx --yes tsx scripts/run-live-matrix.ts "$@"' -- "$@"
```

- [ ] **Step 3: Make it executable and smoke-check the shell syntax**

Run:
```bash
cd /Users/dirtyfancy/projects/subtitle-scout
chmod +x scripts/run-live-matrix-in-orbstack.sh
bash -n scripts/run-live-matrix-in-orbstack.sh && echo "shell syntax ok"
```
Expected: `shell syntax ok`. (Actually launching the container is optional here — the host `tsx` run in Task 7 already proved the runner; this recipe just packages it. Run it once manually if you want to confirm the mount works: it should print the same `✅ anime/only-pack` line.)

- [ ] **Step 4: Write the runbook**

Create `docs/design/2026-07-13-v3-live-matrix-runbook.md`:

```markdown
# v3 Live Test Matrix — Runbook (auto-research loop)

The A-layer machine is built (see plan 2026-07-13-v3-live-matrix-a-layer.md). This is how to
*populate and run* the matrix — the ongoing loop that turns exposed problems into hardened skills
and code. Populating all cells is continuous operation, not a one-shot build.

## The two consumers
- **In-suite deterministic** (`src/testing/findSubtitleWorker.replay.test.ts`, in `npm test`):
  real adapters + replay + scripted mock. Proves recorded responses parse and plumbing carries
  them. Deterministic — safe for CI. Home for **code-bug** regressions.
- **Out-of-band real-model** (`scripts/run-live-matrix.ts`, NEVER in `npm test`): real mimo-v2.5
  + replay providers. Proves **judgment**. Non-deterministic — run manually, observe.

## Adding a cell
1. **Record** the source's real responses (rate-limited, one-time):
   `npx tsx scripts/record-provider-responses.ts --type <t> --form <f> --title "<title>" [--original … --season … --episode …]`
   → writes `fixtures/v3-live/<t>/<f>/responses/`.
2. **Author** `fixtures/v3-live/<t>/<f>/cell.json`: the `task`, and the **correct** `expected`
   answer (which candidate/file/language, or `no_safe_match` for a counter-example cell). Deciding
   the correct answer is the human's job — the recorder only captures what the source returned.
3. **Flip** the catalog entry in `src/testing/liveMatrix.ts` to `seeded: true`.
4. **Verify plumbing:** `npx vitest run src/testing/liveMatrix.test.ts` (cell loads) — optionally
   add a deterministic replay case mirroring `findSubtitleWorker.replay.test.ts`.
5. **Run judgment:** `npx tsx scripts/run-live-matrix.ts --type <t> --form <f> --repeat 3`.

## The loop (spec §暴露问题的处置)
Run a cell → problem exposed → **systematic-debugging** to root cause → classify:
- **Code bug** (param-flow / parse / plumbing): fix the code, add a deterministic regression to
  `findSubtitleWorker.replay.test.ts` (or `.eval.test.ts`) using the recorded response shape.
- **Judgment / cognition gap** (model mis-locates, mislabels 简/繁, treats a pack as "not single"):
  fix the **skill** (`src/agent/skills/findSubtitleSkill.ts`). **HARD LAW: skills are edited ONLY
  by the human + orchestrating Claude — the running agent NEVER self-edits a skill.** Re-run the
  cell (`--repeat`) to confirm the skill patch actually moved judgment (a step-trace, per the
  earlier misdiagnosis lesson — don't assume a patch landed without evidence).
Re-run the affected cells (bypass any negative cache) after each sediment.

## Quota reality
- assrt: 5/min rate limit, NO daily cap — record freely, just slowly (client enforces 15s).
- OpenSubtitles: 100/day but only *downloads* count; search/query is free.
- mimo-v2.5: user's own token plan, resets in days — don't conserve, just expect slowness.

## Containerized run
`scripts/run-live-matrix-in-orbstack.sh --type <t> --form <f>` — replay mode needs only the LLM
network; providers are served from mounted fixtures.
```

- [ ] **Step 5: Verify the whole suite is green, then commit**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run`
Expected: all green.

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add .gitignore scripts/run-live-matrix-in-orbstack.sh docs/design/2026-07-13-v3-live-matrix-runbook.md
git commit -m "docs(v3-matrix): OrbStack recipe + auto-research runbook + gitignore"
```

---

## Self-Review

**Spec coverage (docs/design/2026-07-13-v3-test-matrix-design.md):**
- A-layer两轴 (4 resource types × 5+1 source forms) → `RESOURCE_TYPES`/`SOURCE_FORMS`/`CELL_CATALOG` (Task 3). Anchor cell seeded (Task 4); rest are the runbook backlog (explicitly in-scope as *populate*, not *build*).
- 真实度 A3 (真 mimo-v2.5 + 录制响应，每类1全真锚点) → recorder (Task 6, real providers) + runner (Task 7, real model + replay) + the anchor cell (Task 4). "每类资源1个全真锚点" = recorder run per resource type, per runbook.
- 每格断言 (installed? right episode/version? language? sandbox? no throw?) → `CellExpectation` + runner assertions (Task 7). Step count observed (worker already logs `result.steps.length` to stderr; runner prints pass/fail); no hard step cap changed (stepCap 500 test-phase ceiling kept).
- 反例格 (honest no_safe_match) → `SOURCE_FORMS` includes `none`; `movie/none` catalog entry; runner asserts decision-only for non-installed (Task 7).
- 素材与录制 (fixtures/v3-live/<type>/<form>/, 永久回归资产) → exactly the layout (Task 4/6).
- auto-research 闭环 + skill 只由人改铁律 → runbook (Task 8) states the HARD LAW verbatim.
- 配额现实 → runbook Quota section (Task 8).
- OrbStack 容器跑 → recipe (Task 8); isolation via mkdtemp is the load-bearing part (documented decision).

**Placeholder scan:** The only intentional `__RUN_STEP_3_TO_FILL__` is a base64 field filled by the Step-3 one-liner in Task 4 — not a plan gap. No TBD/TODO/"handle edge cases".

**Type consistency:** `FindSubtitleTask` (jobId/mediaRoot/videoPath omitted in `CellFile.task`) matches the worker's schema and the eval test's `EvalFixture`. `makeReplayFetch(dir)`/`makeRecordingFetch(dir, realFetch)`/`requestSignature(method,url,body)` signatures are identical across the shim, tests, recorder, runner, and Task-4 one-liner. `AssrtClient` constructed with `{ token, cacheDir, fetchImpl, limiter }` (verified against `AssrtClientOpts`). `makeAssrtAdapter(client)`, `makeFindSubtitleWorker({ model, adapters, cacheRoot, fetchImpl, stepCap })`, `makeModel({ baseUrl, apiKey, model })` all match their real definitions read during planning. Decision field names (`decision`/`installedPath`/`installedLanguage`/`candidateProvider`/`candidateProviderId`) match `FindSubtitleDecisionSchema`.

**Known reconciliation point:** Task 5 Step 3 explicitly reconciles the scripted mock's tool-result field reads (`.result_set_id`/`.fileList`/`.stagedFileId`/`.path`) against the real `resultHandles.ts`/`findSubtitleWorker.tools.ts` contract — flagged as PLAN-BUG DISCIPLINE rather than assumed correct, because those exact field names were not re-verified line-by-line during planning (the eval test uses the same reads, so they are very likely correct, but the implementer confirms).
