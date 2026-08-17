# Year-folder typo (1–2 years, unique title) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat a 1–2 year directory/TMDB mismatch as a folder typo when the exact title is unique across years, so Casablanca (1942) vs TMDB 1943 still installs; never relax Dune/Peacemaker-style same-name traps.

**Architecture:** Pure function `yearFolderTypoOk` in `src/v2/identify.ts` (same `normalize` as title evidence). Skills teach the exception. Find-subtitle worker injects a prompt FACT when the exception holds, then after `readFinalized()` strips year/`identification-failed` `no_safe_match` rows for already-bound targets and moves them to `retry_later` if nothing was installed. Do **not** reject `finalize` via schema. CLI `--ids` filters the fake-library catalog for a targeted OrbStack retest.

**Tech Stack:** TypeScript, vitest, existing find-subtitle worker + TMDB client, sandbox-library CLI, OrbStack Docker runner.

**Spec:** `docs/superpowers/specs/2026-08-17-year-folder-typo-design.md`

**Hard rules:**
- TDD: failing test first, watch it fail, then implement.
- Do not change catalog Casablanca path away from `(1942)`.
- Do not change `BATCH_BASE_TIMEOUT_MS`.
- Do not enable `librarySandbox` from file size.
- Do not open production `~/.subtitle-scout/cache/scout.db`.
- Do not commit `PROJECT_AUDIT_2026.md`, hygiene draft, monitor PNGs, or `.env`.
- `docs/` is gitignored except `docs/design/`; force-add only this spec/plan if committing docs.
- After each task: `git commit` on `feat/sandbox-library-test`. Do not push.

---

## File map

| File | Role |
|---|---|
| `src/v2/identify.ts` | `YearHit`, `yearFolderTypoOk`, `applyYearFolderTypoGate` (reuse private `normalize`) |
| `src/v2/identify.test.ts` | Pure-function tests |
| `src/agent/skills/identifyMediaSkill.ts` | Exception in two-evidence bar + descriptor |
| `src/agent/skills/identifyMediaSkill.test.ts` | New anchors; keep decade/Peacemaker fail |
| `src/agent/skills/findSubtitleSkill.ts` | Bound target: do not `identification-failed` on 1–2 unique-title slack |
| `src/agent/skills/findSubtitleSkill.test.ts` | New anchors; keep Peacemaker/Rig |
| `src/agent/findSubtitleWorker.ts` | Pre-generate FACT + post-`readFinalized()` gate |
| `src/agent/findSubtitleWorker.test.ts` | Prompt FACT + stripped `no_safe_match` |
| `src/cli/sandboxLibrary/catalog.ts` | `parseSandboxIds`, `filterCatalogByIds` |
| `src/cli/sandboxLibrary/catalog.test.ts` | Filter / unknown-id tests |
| `src/cli/sandboxLibrary/run.ts` | `--ids` |
| `src/cli/sandboxLibrary/run.test.ts` | Materialize only listed ids |
| `src/cli/sandboxLibrary/orbstackScript.test.ts` | Extra args forwarded |
| `scripts/run-sandbox-library-in-orbstack.sh` | Pass args after profile |

---

### Task 1: `yearFolderTypoOk`

**Files:**
- Modify: `src/v2/identify.ts`
- Modify: `src/v2/identify.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `src/v2/identify.test.ts`)

Import `yearFolderTypoOk` from `./identify.js`. Add this describe (do not implement the function yet):

```ts
describe('yearFolderTypoOk（目录年 vs TMDB 年差 1–2、同名无第二年）', () => {
  const casablancaHits = [
    { title: 'Casablanca', originalTitle: 'Casablanca', year: 1943 },
    { title: 'Casablanca: An Unlikely Classic', originalTitle: null, year: 2012 },
  ]

  it('Casablanca 1942 vs TMDB 1943、唯一整串同名 → true（副标题条目不算同名）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', casablancaHits)).toBe(true)
  })

  it('差 2 年同样 true', () => {
    expect(yearFolderTypoOk(1941, 1943, 'Casablanca', casablancaHits)).toBe(true)
  })

  it('年份完全一致 → false（不是 typo）', () => {
    expect(yearFolderTypoOk(1943, 1943, 'Casablanca', casablancaHits)).toBe(false)
  })

  it('差 ≥3 年 → false', () => {
    expect(yearFolderTypoOk(2013, 2023, 'The Conjuring', [
      { title: 'The Conjuring', originalTitle: null, year: 2023 },
    ])).toBe(false)
  })

  it('Dune 同名两个年份 → false（不得放行 1984/2021）', () => {
    expect(yearFolderTypoOk(1984, 2021, 'Dune', [
      { title: 'Dune', originalTitle: 'Dune', year: 1984 },
      { title: 'Dune', originalTitle: 'Dune', year: 2021 },
    ])).toBe(false)
  })

  it('零同名 hits → false（fail-closed）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [])).toBe(false)
  })

  it('dirYear 或 tmdbYear 缺席 → false', () => {
    expect(yearFolderTypoOk(null, 1943, 'Casablanca', casablancaHits)).toBe(false)
    expect(yearFolderTypoOk(1942, null, 'Casablanca', casablancaHits)).toBe(false)
  })

  it('originalTitle 整串相等也算同名', () => {
    expect(yearFolderTypoOk(2019, 2020, '寄生虫', [
      { title: 'Parasite', originalTitle: '기생충', year: 2019 },
    ])).toBe(false) // claimed is 寄生虫, neither title nor originalTitle normalizes to 寄生虫
    expect(yearFolderTypoOk(2019, 2020, 'Parasite', [
      { title: 'Gisaengchung', originalTitle: 'Parasite', year: 2019 },
    ])).toBe(true)
  })
})
```

Fix the 寄生虫 case in the test you actually commit: the first `expect(...).toBe(false)` is documenting that `normalize` does not treat CJK vs Latin as equal — keep it as a separate `it('claimedTitle 与 hits 无整串相等 → false')`. Do **not** require fuzzy/substring matching here (that is `verifyEvidence` only). Exact `normalize` full-string equality only.

- [ ] **Step 2: Run tests, confirm they fail**

```bash
npx vitest run src/v2/identify.test.ts
```

Expected: FAIL — `yearFolderTypoOk` is not exported.

- [ ] **Step 3: Implement in `src/v2/identify.ts`** (after `normalize`, before `yearFromDir`)

```ts
export interface YearHit {
  title: string
  originalTitle: string | null
  year: number | null
}

function exactName(hit: YearHit, claimedTitle: string): boolean {
  const claimed = normalize(claimedTitle)
  if (!claimed) return false
  if (normalize(hit.title) === claimed) return true
  if (hit.originalTitle != null && normalize(hit.originalTitle) === claimed) return true
  return false
}

/** Directory year vs TMDB year off by 1–2, and no other exact-name title in a different year. */
export function yearFolderTypoOk(
  dirYear: number | null,
  tmdbYear: number | null,
  claimedTitle: string,
  hits: YearHit[],
): boolean {
  if (dirYear == null || tmdbYear == null) return false
  const delta = Math.abs(dirYear - tmdbYear)
  if (delta !== 1 && delta !== 2) return false
  const sameName = hits.filter((h) => exactName(h, claimedTitle))
  if (sameName.length === 0) return false
  return !sameName.some((h) => h.year != null && h.year !== tmdbYear)
}
```

Keep existing private `normalize`. Do not export it.

- [ ] **Step 4: Re-run tests**

```bash
npx vitest run src/v2/identify.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/v2/identify.ts src/v2/identify.test.ts
git commit -m "$(cat <<'EOF'
feat(identify): treat 1–2 year unique-title folder typos as the same work

Casablanca (1942) vs TMDB 1943 is a directory typo, not a different film.
Dune-style same-name multi-year hits stay rejected.
EOF
)"
```

---

### Task 2: identify-media skill exception

**Files:**
- Modify: `src/agent/skills/identifyMediaSkill.ts`
- Modify: `src/agent/skills/identifyMediaSkill.test.ts`

Context: `src/agent/skills/identifyMediaSkill.ts` currently says “A year mismatch is an automatic fail…” (around the two-evidence bar, ~line 74) and the descriptor repeats that phrase (~line 216). Keep the Conjuring-decade / Peacemaker teaching. Add the 1–2 unique-title exception immediately after the automatic-fail paragraph. Descriptor must mention the exception (spec: do not freeze “automatic fail” in the descriptor without the exception).

- [ ] **Step 1: Write failing tests first**

In `identifyMediaSkill.test.ts`, keep existing `/year mismatch is an automatic fail/i` on **content** (decade still fails). Change the **descriptor** assertion: it must still mention year mismatch, **and** mention a 1–2 year / folder typo / unique title exception.

Add:

```ts
  it('目录年与 TMDB 年差 1–2 且同名无第二年 → 文件夹写错年，过 bar', ({ expect }) => {
    expect(skill.content).toMatch(/1\s*[–-]\s*2|one or two years/i)
    expect(skill.content).toMatch(/folder typo|directory year/i)
    expect(skill.content).toMatch(/exact title|same name/i)
    expect(skill.content).toMatch(/Casablanca|unique/i)
  })
```

Keep Peacemaker + Conjuring anchors. Do not delete `/year mismatch is an automatic fail/i` from content tests.

Update descriptor test from exact `year mismatch is an automatic fail` to something that still matches year mismatch **and** the exception, e.g. `/year mismatch/i` plus `/1\s*[–-]\s*2|folder typo/i`.

- [ ] **Step 2: Run tests, confirm descriptor and/or new it fail**

```bash
npx vitest run src/agent/skills/identifyMediaSkill.test.ts
```

- [ ] **Step 3: Edit skill content + descriptor**

After the “A year mismatch is an automatic fail…” paragraph, add (English, same voice as the rest of the skill):

- A **1 or 2 year** gap between the **directory year** and **this suspect’s TMDB year** is a folder typo when `search_tmdb` (no year filter) shows **no other hit whose title/originalTitle normalizes to the same full string in a different year**.
- Then the year line still counts; claim the identity; do not `identification-failed`.
- Exact full-string name only: `Casablanca` ≠ `Casablanca: An Unlikely Classic`.
- Two works sharing the exact name in different years (Dune 1984/2021) → no slack.
- Decade gaps (Conjuring) stay an automatic fail.

Descriptor: mention two-evidence bar, year mismatch, **and** the 1–2 year unique-title folder-typo exception.

- [ ] **Step 4: Re-run skill tests — PASS**

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills/identifyMediaSkill.ts src/agent/skills/identifyMediaSkill.test.ts
git commit -m "$(cat <<'EOF'
fix(identify-media): allow 1–2 year unique-title folder typos

Keep decade and same-name multi-year mismatches as automatic fails.
EOF
)"
```

---

### Task 3: find-subtitle skill exception

**Files:**
- Modify: `src/agent/skills/findSubtitleSkill.ts`
- Modify: `src/agent/skills/findSubtitleSkill.test.ts`

Context: the same-name trap section (~line 171) says a year mismatch disqualifies a **candidate pack**. Keep that for Peacemaker/Rauhantekijä vs DC Peacemaker. Add: if the **task already has `itemId`** and the mismatch is directory year vs **this work’s** TMDB year by 1–2 with unique exact title, that is not `identification-failed` — install. A candidate pack whose year matches the directory year (or TMDB year ±1–2) of this unique title is still this work. A pack that is a **different title** (Rauhantekijä) is still a trap.

- [ ] **Step 1: Failing tests**

Keep the existing Peacemaker/Rig/`year mismatch` test. Add:

```ts
  it('已绑定 itemId 时，目录年 vs TMDB 年差 1–2 且同名无第二年 → 不要 identification-failed，要装字幕', () => {
    const c = makeFindSubtitleSkill('zh').content
    expect(c).toMatch(/itemId/)
    expect(c).toMatch(/identification-failed/)
    expect(c).toMatch(/1\s*[–-]\s*2|one or two years/i)
    expect(c).toMatch(/folder typo|directory year/i)
    expect(c).toMatch(/install/i)
  })
```

- [ ] **Step 2: Run — FAIL** (new it)

```bash
npx vitest run src/agent/skills/findSubtitleSkill.test.ts
```

- [ ] **Step 3: Add a short paragraph** after the year-mismatch candidate rule, not replacing it.

- [ ] **Step 4: Re-run — PASS** (Peacemaker/Rig still pass)

- [ ] **Step 5: Commit**

```bash
git add src/agent/skills/findSubtitleSkill.ts src/agent/skills/findSubtitleSkill.test.ts
git commit -m "$(cat <<'EOF'
fix(find-subtitle): do not identity-fail bound targets on 1–2 year folder typos

Same-name different-show packs (Peacemaker / The Rig) stay disqualified.
EOF
)"
```

---

### Task 4: Prompt FACT + post-`readFinalized()` gate

**Files:**
- Modify: `src/v2/identify.ts` (add `applyYearFolderTypoGate`)
- Modify: `src/v2/identify.test.ts`
- Modify: `src/agent/findSubtitleWorker.ts`
- Modify: `src/agent/findSubtitleWorker.test.ts`

**Do not** add `superRefine` / schema rejection on `finalize`. `hasToolCall('finalize')` stops the loop; invalid finalize throws. Documented in `findSubtitleWorker.ts` around the schema comment (~lines 421–426).

Gate semantics (spec §5):

1. If `yearFolderTypoOk` is false → return report unchanged.
2. If true → drop `no_safe_match` entries whose `itemId` is in `boundItemIds` **and** `reason` matches `/year|identification-failed/i`.
3. For each dropped entry that is not already in `installed` or `retry_later`, append `{ itemId, reason: 'year-folder-typo: directory year vs TMDB year is not a different work; do not treat as source-empty' }` to `retry_later`.
4. Leave genuine source-empty `no_safe_match` (reason does not match) untouched.

Worker wiring in `runFindSubtitleTask` **before** `agent.generate`:

- Skip when every target `itemId` is null (unidentified) or `deps.tmdb` is missing.
- `dirYear = yearFromDir(basename(task.mediaRoot))` (movie folders are `Casablanca (1942)`).
- `tmdbYear = task.year`, `claimedTitle = task.title`.
- `mediaType = task.targets.some(t => t.season != null) ? 'tv' : 'movie'`.
- `const raw = await deps.tmdb.search(mediaType, task.title)` — **omit the year argument**.
- Map hits to `YearHit`. On search throw/reject → fail-closed (no FACT, no gate).
- If `yearFolderTypoOk(...)` → append a FACT line to the user prompt: directory year vs TMDB year is a 1–2 year folder typo; unique exact title; do not report `identification-failed`; install.
- After `readFinalized()`, `return applyYearFolderTypoGate(report, { ... })` with `boundItemIds` = non-null target `itemId`s.

- [ ] **Step 1: Failing tests for `applyYearFolderTypoGate`** in `identify.test.ts`

```ts
import { yearFolderTypoOk, applyYearFolderTypoGate } from './identify.js'
import type { FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'

function emptyReport(over: Partial<FindSubtitleBatchReport> = {}): FindSubtitleBatchReport {
  return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], ...over }
}

describe('applyYearFolderTypoGate', () => {
  const hits = [{ title: 'Casablanca', originalTitle: 'Casablanca', year: 1943 }]
  const bound = new Set(['tmdb:289'])

  it('已绑定 + identification-failed 年份 + typo ok → 从 no_safe_match 去掉并进 retry_later', () => {
    const report = emptyReport({
      no_safe_match: [{
        itemId: 'tmdb:289',
        reason: 'identification-failed: TMDB year 1943 does not match file year 1942; two-evidence bar not met',
      }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toEqual([])
    expect(out.retry_later[0]?.itemId).toBe('tmdb:289')
    expect(out.retry_later[0]?.reason).toMatch(/year-folder-typo/)
  })

  it('typo 不成立时原样返回', () => {
    const report = emptyReport({
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'identification-failed: year' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1984, tmdbYear: 2021, claimedTitle: 'Dune',
      hits: [
        { title: 'Dune', originalTitle: null, year: 1984 },
        { title: 'Dune', originalTitle: null, year: 2021 },
      ],
      boundItemIds: new Set(['tmdb:289']),
    })
    expect(out.no_safe_match).toHaveLength(1)
    expect(out.retry_later).toEqual([])
  })

  it('已装上则只剥 no_safe_match，不重复塞 retry_later', () => {
    const report = emptyReport({
      installed: [{
        itemId: 'tmdb:289', installedPath: '/x.srt', installedLanguage: 'zh',
        candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok',
      }],
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'identification-failed: year 1942' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toEqual([])
    expect(out.retry_later).toEqual([])
    expect(out.installed).toHaveLength(1)
  })

  it('真正源站没货（reason 不含 year/identification-failed）不动', () => {
    const report = emptyReport({
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'no plausible candidate after search' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toHaveLength(1)
  })
})
```

`FindSubtitleBatchReport` may require `identity` — if the type includes it as optional, omit it; if tests fail on type, add `identity: null`.

- [ ] **Step 2: Run identify tests — FAIL on missing export**

```bash
npx vitest run src/v2/identify.test.ts
```

- [ ] **Step 3: Implement `applyYearFolderTypoGate` next to `yearFolderTypoOk`**

Import type `FindSubtitleBatchReport` from `../agent/findSubtitleWorker.schemas.js`. Do not mutate the input report (return a shallow copy).

- [ ] **Step 4: Identify tests PASS. Then worker tests (still failing until wiring):**

In `src/agent/findSubtitleWorker.test.ts`, add a describe that uses the existing `baseTask` / `finalizeResult` helpers. Mock `tmdb.search` (no year) returning Casablanca 1943 only. Task: `title: 'Casablanca'`, `year: 1943`, `mediaRoot` ending in `Casablanca (1942)`, one target `itemId: 'tmdb:289'`, `season: null`. Model immediately `finalize`s with the live Casablanca `identification-failed` reason.

Assertions:

1. User prompt contains a FACT about folder typo / 1942 / 1943 / install (and does not tell the model to `identification-failed`).
2. Returned report: `no_safe_match` empty, `retry_later` contains `tmdb:289`.
3. `tmdb.search` was called without a year argument (assert call args: query is the title, year omitted/undefined).
4. Control: `tmdb.search` returns Dune 1984+2021, task year 2021, mediaRoot `Dune (1984)` → prompt has **no** typo FACT; `no_safe_match` kept.
5. `tmdb.search` throws → fail-closed: `no_safe_match` kept, no FACT required.

Look at nearby tests for how they extract user message text from `options.prompt`.

- [ ] **Step 5: Wire worker. Re-run**

```bash
npx vitest run src/v2/identify.test.ts src/agent/findSubtitleWorker.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/v2/identify.ts src/v2/identify.test.ts src/agent/findSubtitleWorker.ts src/agent/findSubtitleWorker.test.ts
git commit -m "$(cat <<'EOF'
fix(find-subtitle): ignore year identification-failed on unique-title folder typos

Prompt FACT plus a post-finalize report gate. Do not schema-reject finalize.
EOF
)"
```

---

### Task 5: `sandbox-library --ids` + OrbStack extra args

**Files:**
- Modify: `src/cli/sandboxLibrary/catalog.ts`
- Modify: `src/cli/sandboxLibrary/catalog.test.ts`
- Modify: `src/cli/sandboxLibrary/run.ts`
- Modify: `src/cli/sandboxLibrary/run.test.ts`
- Modify: `scripts/run-sandbox-library-in-orbstack.sh`
- Modify: `src/cli/sandboxLibrary/orbstackScript.test.ts`

- [ ] **Step 1: Failing catalog tests**

```ts
import { loadCatalog, parseSandboxIds, filterCatalogByIds } from './catalog.js'

it('parseSandboxIds: comma list, trim, reject blanks', () => {
  expect(parseSandboxIds(undefined)).toBeUndefined()
  expect(parseSandboxIds('casablanca,oppenheimer')).toEqual(['casablanca', 'oppenheimer'])
  expect(parseSandboxIds(' casablanca , oppenheimer ')).toEqual(['casablanca', 'oppenheimer'])
  expect(() => parseSandboxIds('casablanca,,x')).toThrow(/empty/i)
})

it('filterCatalogByIds keeps listed ids; unknown id throws', () => {
  const catalog = loadCatalog(catalogPath)
  const filtered = filterCatalogByIds(catalog, ['casablanca', 'oppenheimer'])
  expect(filtered.entries.map(e => e.id).sort()).toEqual(['casablanca', 'oppenheimer'])
  expect(() => filterCatalogByIds(catalog, ['casablanca', 'not-a-seed'])).toThrow(/not-a-seed/)
})
```

Casablanca **must** remain `Movies/Casablanca (1942)/` in catalog.json — do not “fix” the year.

- [ ] **Step 2: Run catalog tests — FAIL**

```bash
npx vitest run src/cli/sandboxLibrary/catalog.test.ts
```

- [ ] **Step 3: Implement `parseSandboxIds` and `filterCatalogByIds` in `catalog.ts`**

`parseSandboxIds(raw?: string): string[] | undefined` — undefined/empty string → undefined; split on comma; trim; if any token is empty after trim, throw. `filterCatalogByIds`: unknown ids throw listing them; return `{ entries: catalog.entries.filter(...) }` preserving relative order.

- [ ] **Step 4: Catalog tests PASS. Then CLI + materialize + script tests**

`run.ts`: add `ids: { type: 'string' }` to `parseArgs`. After `loadCatalog`, if `parseSandboxIds(values.ids)` is defined, `try { catalog = filterCatalogByIds(...) } catch { console.error; return 2 }`.

`run.test.ts`: load catalog, filter to `casablanca,oppenheimer`, `materializeLibrary(filtered, 'zh-viewer', root)`, expect exactly those two relative paths exist, and some other zh-viewer movie path does **not**.

`run-sandbox-library-in-orbstack.sh`:

```bash
PROFILE="${1:-all}"
shift || true
docker run --rm \
  ...existing flags... \
  node:22-slim \
  sh -lc 'apt-get update -qq && apt-get install -y -qq python3 make g++ ffmpeg ca-certificates >/dev/null && npm ci && npx tsx src/cli/index.ts sandbox-library --profile "$0" "$@"' \
  "$PROFILE" "$@"
```

Keep overlay `/app/node_modules`, `npm ci`, env-file, sandbox-scratch mounts. Do not use `npm install` / `npm rebuild`.

`orbstackScript.test.ts`: assert the inner command still runs `sandbox-library --profile "$0"` and that `"$@"` is forwarded (script contains `"$@"` after `--profile "$0"`). Update the usage comment at the top of the shell script to `[zh-viewer|en-viewer|all] [--ids a,b]`.

- [ ] **Step 5: Run**

```bash
npx vitest run src/cli/sandboxLibrary/catalog.test.ts src/cli/sandboxLibrary/run.test.ts src/cli/sandboxLibrary/orbstackScript.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/sandboxLibrary/catalog.ts src/cli/sandboxLibrary/catalog.test.ts src/cli/sandboxLibrary/run.ts src/cli/sandboxLibrary/run.test.ts src/cli/sandboxLibrary/orbstackScript.test.ts scripts/run-sandbox-library-in-orbstack.sh
git commit -m "$(cat <<'EOF'
feat(sandbox-library): filter live runs with --ids

Lets OrbStack retest casablanca,oppenheimer without wiping the whole matrix.
EOF
)"
```

---

### Task 6: OrbStack live retest (controller, not npm test)

**Files:** none in git except the report you paste back. Do not commit `sandbox-scratch/`.

- [ ] **Step 1: From repo root, with `.env` present**

```bash
scripts/run-sandbox-library-in-orbstack.sh zh-viewer --ids casablanca,oppenheimer
```

This wipes `/tmp/sandbox-scratch/lib/zh-viewer` inside the container (materialize `rmSync`s the profile root), then runs identify + find-subtitle for those two seeds only.

- [ ] **Step 2: Record outcomes**

Expect Casablanca: sidecar installed (PASS), **not** `sub:no-match` from 1942 vs 1943.

Oppenheimer: do **not** change the 5-minute timeout. If it hangs again at ~300s with only `read_doc`, record FAIL-PIPE/timeout honestly.

- [ ] **Step 3: Do not push. Do not merge. Report the table to the user.**

---

## Spec coverage (self-review)

| Spec | Task |
|---|---|
| `yearFolderTypoOk` rules (delta 1–2, exact name, fail-closed) | 1 |
| identify-media skill + descriptor exception | 2 |
| find-subtitle skill: bound target, no identity-fail | 3 |
| Prompt FACT | 4 |
| Post-`readFinalized()` strip, no schema reject | 4 |
| Prefer not `sub:no-match` → `retry_later` | 4 |
| TMDB search fail → fail-closed | 4 |
| `--ids` + unknown id exit 2 | 5 |
| OrbStack extra args | 5 |
| Live Casablanca 1942 + Oppenheimer, no timeout change | 6 |
| Out of scope: hygiene, translate, auto-install staging, catalog year 1943 | none (do not do) |
