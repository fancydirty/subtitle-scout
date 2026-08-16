# Sandbox Library Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let maintainers exercise identify + find-subtitle on a rich fake library of 0-byte videos (movie/TV/anime, classic/modern, CN/US/JP/KR/EU) under two audience profiles, without downloading real video and without touching the production database.

**Architecture:** Same `identifyWorker` / `findSubtitleWorker` / `ScoutDaemonV2` as production. A CLI-only flag `librarySandbox: true` prepends a test addendum and exposes a short skill doc. Catalog JSON is the seed source of truth; a materializer writes 0-byte files; `inspectOnce()` runs one full inspection (not the 24h watch loop). Mechanical tests mock workers. Live LLM + subtitle providers run only in OrbStack.

**Tech Stack:** TypeScript, vitest, better-sqlite3, existing daemonV2 / settings / sidecar stack, Docker/OrbStack for the live pass.

**Spec:** `docs/superpowers/specs/2026-08-16-sandbox-library-test-design.md`

**Out of scope (do not implement):** translate agent, frontend, open-source hygiene, production `watch` behavior changes, auto-enable on `size===0`, muxed black-frame videos, season-pack fixtures, opening `~/.subtitle-scout/cache/scout.db`.

---

## File map

| File | Responsibility |
|---|---|
| `fixtures/sandbox-libraries/catalog.json` | Seed source of truth (profiles, axes, TMDB ids, relative paths) |
| `src/cli/sandboxLibrary/catalog.ts` | Load + types + coverage-axis checker |
| `src/cli/sandboxLibrary/catalog.test.ts` | Coverage axes, control variables, one-episode-per-title |
| `src/cli/sandboxLibrary/materialize.ts` | Write 0-byte videos under a root |
| `src/cli/sandboxLibrary/materialize.test.ts` | Size 0, directory shape, no sparse truncate |
| `src/cli/sandboxLibrary/report.ts` | Pure cell verdicts (PASS / FAIL-PIPE / FAIL-SOURCE / FAIL-SKIP) |
| `src/cli/sandboxLibrary/report.test.ts` | Verdict matrix |
| `src/cli/sandboxLibrary/run.ts` | CLI orchestration: materialize → temp db → inspectOnce → report |
| `src/cli/sandboxLibrary/run.test.ts` | Mechanical daemon with stubbed identify/subtitle |
| `src/agent/librarySandbox.ts` | Addendum constant + preamble helper |
| `src/agent/skills/librarySandboxSkill.ts` | Skill `library-sandbox-test` |
| `src/agent/librarySandbox.test.ts` | Flag on/off prompt + skill index |
| `src/agent/identifyWorker.ts` | Optional `librarySandbox`; prepend addendum |
| `src/agent/findSubtitleWorker.ts` | Optional `librarySandbox`; prepend addendum; skill index only when on |
| `src/v2/scanner.test.ts` | Pin `isScannable(path, 0)` |
| `src/v2/daemonV2.ts` | Public `inspectOnce()` → existing `runInspection` |
| `src/v2/daemonV2.inspectOnce.test.ts` | 0-byte file is scanned; 24h gate bypassed |
| `src/cli/index.ts` | Dispatch `sandbox-library`; USAGE line |
| `src/cli/watchWiring.test.ts` | Production watch never sets `librarySandbox: true` |
| `scripts/run-sandbox-library-in-orbstack.sh` | Live zh-viewer then en-viewer |
| `sandbox-scratch/` | gitignored live scratch |

Do **not** add `librarySandbox` to `watchWiring.ts` / `cmdWatch`. Do **not** copy `runInspectionInner`.

---

### Task 1: Catalog schema, rich seeds, coverage tests

**Files:**
- Create: `src/cli/sandboxLibrary/catalog.ts`
- Create: `src/cli/sandboxLibrary/catalog.test.ts`
- Create: `fixtures/sandbox-libraries/catalog.json`

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/sandboxLibrary/catalog.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadCatalog, coverageGaps, eraOf, CONTROL_NEZHA_TMDB, CONTROL_MATRIX_TMDB,
  type Catalog,
} from './catalog.js'

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/sandbox-libraries/catalog.json')

describe('sandbox library catalog', () => {
  it('loads and every tmdbId is a positive integer', () => {
    const catalog = loadCatalog(catalogPath)
    expect(catalog.entries.length).toBeGreaterThan(20)
    for (const e of catalog.entries) {
      expect(Number.isInteger(e.tmdbId) && e.tmdbId > 0).toBe(true)
      expect(['zh-viewer', 'en-viewer']).toContain(e.profile)
      expect(['find', 'origin-skip']).toContain(e.role)
      expect(e.relPath).not.toMatch(/^[/\\]/)
    }
  })

  it('eraOf: 1999 is classic, 2000 is modern', () => {
    expect(eraOf(1999)).toBe('classic')
    expect(eraOf(1942)).toBe('classic')
    expect(eraOf(2000)).toBe('modern')
    expect(eraOf(2024)).toBe('modern')
  })

  it('coverage axes from spec §5.1 are all present (gaps empty)', () => {
    const catalog = loadCatalog(catalogPath)
    expect(coverageGaps(catalog)).toEqual([])
  })

  it('Nezha (612399) and Matrix (603) appear in both profiles with opposite roles', () => {
    const catalog = loadCatalog(catalogPath)
    const nezha = catalog.entries.filter(e => e.tmdbId === CONTROL_NEZHA_TMDB)
    const matrix = catalog.entries.filter(e => e.tmdbId === CONTROL_MATRIX_TMDB)
    expect(nezha.find(e => e.profile === 'zh-viewer')?.role).toBe('origin-skip')
    expect(nezha.find(e => e.profile === 'en-viewer')?.role).toBe('find')
    expect(matrix.find(e => e.profile === 'zh-viewer')?.role).toBe('find')
    expect(matrix.find(e => e.profile === 'en-viewer')?.role).toBe('origin-skip')
  })

  it('each title contributes exactly one video file; TV paths are S01E01', () => {
    const catalog = loadCatalog(catalogPath)
    const ids = catalog.entries.map(e => `${e.profile}:${e.id}`)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of catalog.entries.filter(x => x.format === 'tv')) {
      expect(e.relPath).toMatch(/S01E01/i)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/sandboxLibrary/catalog.test.ts`

Expected: FAIL because `./catalog.js` cannot be resolved.

- [ ] **Step 3: Write types, loader, coverageGaps, and catalog.json**

`src/cli/sandboxLibrary/catalog.ts`:

```ts
import { readFileSync } from 'node:fs'

export const CONTROL_NEZHA_TMDB = 612399
export const CONTROL_MATRIX_TMDB = 603

export type SandboxProfile = 'zh-viewer' | 'en-viewer'
export type SandboxRole = 'find' | 'origin-skip'
export type SandboxFormat = 'movie' | 'tv'
export type SandboxRegion = 'us' | 'gb' | 'fr' | 'jp' | 'kr' | 'cn' | 'hk'

export interface CatalogEntry {
  id: string
  profile: SandboxProfile
  role: SandboxRole
  relPath: string
  tmdbKind: 'movie' | 'tv'
  tmdbId: number
  year: number
  region: SandboxRegion
  format: SandboxFormat
  animation: boolean
  expectedOriginLang: string
}

export interface Catalog {
  entries: CatalogEntry[]
}

export function eraOf(year: number): 'classic' | 'modern' {
  return year <= 1999 ? 'classic' : 'modern'
}

export function loadCatalog(path: string): Catalog {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Catalog
  if (!Array.isArray(raw.entries)) throw new Error(`catalog missing entries: ${path}`)
  return raw
}

export function entriesFor(catalog: Catalog, profile: SandboxProfile, role?: SandboxRole): CatalogEntry[] {
  return catalog.entries.filter(e => e.profile === profile && (role == null || e.role === role))
}

function has(entries: CatalogEntry[], pred: (e: CatalogEntry) => boolean, n = 1): boolean {
  return entries.filter(pred).length >= n
}

/** Returns human-readable missing-axis labels. Empty array = spec §5.1 satisfied. */
export function coverageGaps(catalog: Catalog): string[] {
  const gaps: string[] = []
  const zhFind = entriesFor(catalog, 'zh-viewer', 'find')
  const zhSkip = entriesFor(catalog, 'zh-viewer', 'origin-skip')
  const enFind = entriesFor(catalog, 'en-viewer', 'find')
  const enSkip = entriesFor(catalog, 'en-viewer', 'origin-skip')

  const need = (ok: boolean, label: string) => { if (!ok) gaps.push(label) }

  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic' && e.region === 'us'), 'zh-find movie classic us')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic' && e.region === 'jp'), 'zh-find movie classic jp')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'us'), 'zh-find movie modern us')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'kr'), 'zh-find movie modern kr')
  need(has(zhFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'fr'), 'zh-find movie modern fr')
  need(has(zhFind, e => e.format === 'movie' && e.animation && e.region === 'jp' && eraOf(e.year) === 'classic'), 'zh-find animation-movie jp classic')
  need(has(zhFind, e => e.format === 'movie' && e.animation && e.region === 'jp' && eraOf(e.year) === 'modern'), 'zh-find animation-movie jp modern')
  need(has(zhFind, e => e.format === 'movie' && e.animation && e.region === 'us'), 'zh-find animation-movie us')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'us' && eraOf(e.year) === 'classic'), 'zh-find tv us classic')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'us' && eraOf(e.year) === 'modern'), 'zh-find tv us modern')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'gb'), 'zh-find tv gb')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'kr'), 'zh-find tv kr')
  need(has(zhFind, e => e.format === 'tv' && !e.animation && e.region === 'jp'), 'zh-find tv jp live-action')
  need(has(zhFind, e => e.format === 'tv' && e.animation && e.region === 'jp' && eraOf(e.year) === 'classic'), 'zh-find tv-animation jp classic')
  need(has(zhFind, e => e.format === 'tv' && e.animation && e.region === 'jp' && eraOf(e.year) === 'modern', 2), 'zh-find tv-animation jp modern ×2')

  need(has(zhSkip, e => e.region === 'cn' && e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic'), 'zh-skip movie classic cn')
  need(has(zhSkip, e => e.region === 'cn' && e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern'), 'zh-skip movie modern cn')
  need(has(zhSkip, e => e.region === 'cn' && e.format === 'movie' && e.animation), 'zh-skip animation-movie cn')
  need(has(zhSkip, e => e.region === 'cn' && e.format === 'tv'), 'zh-skip tv cn')

  need(has(enFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'classic' && (e.region === 'cn' || e.region === 'hk')), 'en-find movie classic cn/hk')
  need(has(enFind, e => e.format === 'movie' && !e.animation && eraOf(e.year) === 'modern' && e.region === 'cn'), 'en-find movie modern cn')
  need(has(enFind, e => e.format === 'movie' && e.animation && e.region === 'cn'), 'en-find animation-movie cn')
  need(has(enFind, e => e.format === 'movie' && e.region === 'hk'), 'en-find movie hk')
  need(enFind.filter(e => e.format === 'tv' && e.region === 'cn').length >= 2, 'en-find tv cn ×2 different years')
  const enCnTvYears = new Set(enFind.filter(e => e.format === 'tv' && e.region === 'cn').map(e => e.year))
  need(enCnTvYears.size >= 2, 'en-find tv cn distinct years')

  need(has(enSkip, e => e.format === 'movie' && eraOf(e.year) === 'classic' && e.expectedOriginLang === 'en'), 'en-skip classic en movie')
  need(has(enSkip, e => e.format === 'movie' && eraOf(e.year) === 'modern' && e.expectedOriginLang === 'en'), 'en-skip modern en movie')

  return gaps
}
```

Write `fixtures/sandbox-libraries/catalog.json` with **all** of these entries (exact ids/paths). `expectedOriginLang` is the TMDB-style origin the mechanical stub should write (`zh` for Chinese titles so `judgeSubtitle`'s exact `includes()` hits; live runs use real TMDB).

**zh-viewer / find:**

| id | relPath | tmdbKind | tmdbId | year | region | format | animation | expectedOriginLang |
|---|---|---|---|---|---|---|---|---|
| casablanca | `Movies/Casablanca (1942)/Casablanca.1942.mkv` | movie | 289 | 1942 | us | movie | false | en |
| seven-samurai | `Movies/Seven Samurai (1954)/Shichinin.no.Samurai.1954.mkv` | movie | 346 | 1954 | jp | movie | false | ja |
| totoro | `Movies/My Neighbor Totoro (1988)/Tonari.no.Totoro.1988.mkv` | movie | 8392 | 1988 | jp | movie | true | ja |
| friends-s01e01 | `TV/Friends (1994)/Season 01/Friends.S01E01.mkv` | tv | 1668 | 1994 | us | tv | false | en |
| cowboy-bebop-s01e01 | `TV/Cowboy Bebop (1998)/Season 01/Cowboy.Bebop.S01E01.mkv` | tv | 30983 | 1998 | jp | tv | true | ja |
| matrix | `Movies/The Matrix (1999)/The.Matrix.1999.1080p.mkv` | movie | 603 | 1999 | us | movie | false | en |
| amelie | `Movies/Amelie (2001)/Le.Fabuleux.Destin.d.Amelie.Poulain.2001.mkv` | movie | 194 | 2001 | fr | movie | false | fr |
| spirited-away | `Movies/Spirited Away (2001)/Sen.to.Chihiro.2001.mkv` | movie | 129 | 2001 | jp | movie | true | ja |
| oldboy | `Movies/Oldboy (2003)/Oldboy.2003.mkv` | movie | 670 | 2003 | kr | movie | false | ko |
| sherlock-s01e01 | `TV/Sherlock (2010)/Season 01/Sherlock.S01E01.mkv` | tv | 19885 | 2010 | gb | tv | false | en |
| aot-s01e01 | `TV/Attack on Titan (2013)/Season 01/Attack.on.Titan.S01E01.mkv` | tv | 1429 | 2013 | jp | tv | true | ja |
| spider-verse | `Movies/Spider-Man Into the Spider-Verse (2018)/Spiderverse.2018.mkv` | movie | 324857 | 2018 | us | movie | true | en |
| parasite | `Movies/Parasite (2019)/Gisaengchung.2019.mkv` | movie | 496243 | 2019 | kr | movie | false | ko |
| squid-game-s01e01 | `TV/Squid Game (2021)/Season 01/Squid.Game.S01E01.mkv` | tv | 93405 | 2021 | kr | tv | false | ko |
| spy-family-s01e01 | `TV/SPY x FAMILY (2022)/Season 01/SPY.x.FAMILY.S01E01.mkv` | tv | 120089 | 2022 | jp | tv | true | ja |
| the-bear-s01e01 | `TV/The Bear (2022)/Season 01/The.Bear.S01E01.mkv` | tv | 136315 | 2022 | us | tv | false | en |
| frieren-s01e01 | `TV/Frieren (2023)/Season 01/Frieren.S01E01.mkv` | tv | 209867 | 2023 | jp | tv | true | ja |
| oppenheimer | `Movies/Oppenheimer (2023)/Oppenheimer.2023.mkv` | movie | 872585 | 2023 | us | movie | false | en |
| shogun-s01e01 | `TV/Shogun (2024)/Season 01/Shogun.S01E01.mkv` | tv | 126308 | 2024 | us | tv | false | en |
| midnight-diner-s01e01 | `TV/Midnight Diner (2009)/Season 01/Midnight.Diner.S01E01.mkv` | tv | 47008 | 2009 | jp | tv | false | ja |

**zh-viewer / origin-skip:**

| id | relPath | tmdbKind | tmdbId | year | region | format | animation | expectedOriginLang |
|---|---|---|---|---|---|---|---|---|
| red-lantern-skip | `Movies/Raise the Red Lantern (1991)/Dahong.Denglong.1991.mkv` | movie | 10494 | 1991 | cn | movie | false | zh |
| nezha-skip | `Movies/哪吒之魔童降世 (2019)/Nezha.2019.mkv` | movie | 612399 | 2019 | cn | movie | true | zh |
| wandering-earth-skip | `Movies/The Wandering Earth (2019)/Liulang.Diqiu.2019.mkv` | movie | 535167 | 2019 | cn | movie | false | zh |
| nirvana-skip | `TV/Nirvana in Fire (2015)/Season 01/Nirvana.in.Fire.S01E01.mkv` | tv | 64197 | 2015 | cn | tv | false | zh |

**en-viewer / find:**

| id | relPath | tmdbKind | tmdbId | year | region | format | animation | expectedOriginLang |
|---|---|---|---|---|---|---|---|---|
| red-lantern | `Movies/Raise the Red Lantern (1991)/大红灯笼高高挂.1991.mkv` | movie | 10494 | 1991 | cn | movie | false | zh |
| in-the-mood | `Movies/In the Mood for Love (2000)/花样年华.2000.mkv` | movie | 843 | 2000 | hk | movie | false | zh |
| hero | `Movies/Hero (2002)/英雄.2002.mkv` | movie | 79 | 2002 | cn | movie | false | zh |
| big-fish | `Movies/Big Fish and Begonia (2016)/大鱼海棠.2016.mkv` | movie | 271706 | 2016 | cn | movie | true | zh |
| nezha | `Movies/Nezha (2019)/哪吒之魔童降世.2019.mkv` | movie | 612399 | 2019 | cn | movie | true | zh |
| wandering-earth | `Movies/The Wandering Earth (2019)/流浪地球.2019.mkv` | movie | 535167 | 2019 | cn | movie | false | zh |
| journey-west-s01e01 | `TV/Journey to the West (1986)/Season 01/Journey.to.the.West.S01E01.mkv` | tv | 13923 | 1986 | cn | tv | false | zh |
| nirvana-s01e01 | `TV/Nirvana in Fire (2015)/Season 01/琅琊榜.S01E01.mkv` | tv | 64197 | 2015 | cn | tv | false | zh |
| untamed-s01e01 | `TV/The Untamed (2019)/Season 01/陈情令.S01E01.mkv` | tv | 96111 | 2019 | cn | tv | false | zh |

**en-viewer / origin-skip:**

| id | relPath | tmdbKind | tmdbId | year | region | format | animation | expectedOriginLang |
|---|---|---|---|---|---|---|---|---|
| casablanca-skip | `Movies/Casablanca (1942)/Casablanca.1942.mkv` | movie | 289 | 1942 | us | movie | false | en |
| matrix-skip | `Movies/The Matrix (1999)/The.Matrix.1999.mkv` | movie | 603 | 1999 | us | movie | false | en |
| oppenheimer-skip | `Movies/Oppenheimer (2023)/Oppenheimer.2023.mkv` | movie | 872585 | 2023 | us | movie | false | en |

JSON shape: `{ "entries": [ { "id", "profile", "role", "relPath", "tmdbKind", "tmdbId", "year", "region", "format", "animation", "expectedOriginLang" }, ... ] }`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/cli/sandboxLibrary/catalog.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sandboxLibrary/catalog.ts src/cli/sandboxLibrary/catalog.test.ts fixtures/sandbox-libraries/catalog.json
git commit -m "$(cat <<'EOF'
feat(sandbox-library): seed a rich fake-library catalog

Cover movie/TV/anime, classic/modern, and CN/US/JP/KR/EU axes so
the mock library exercises find-subtitle instead of a handful of titles.
EOF
)"
```

---

### Task 2: Materialize 0-byte files + pin isScannable(0)

**Files:**
- Create: `src/cli/sandboxLibrary/materialize.ts`
- Create: `src/cli/sandboxLibrary/materialize.test.ts`
- Modify: `src/v2/scanner.test.ts` (add one case inside the existing `isScannable` describe)

- [ ] **Step 1: Write the failing tests**

Add to `src/v2/scanner.test.ts` in `describe('isScannable…')`:

```ts
  it('0 字节占位视频可扫（假片库；R8 空快照会把整根跳过）', () => {
    expect(isScannable('/media/TV/Show/S01E01.mkv', 0).ok).toBe(true)
  })
```

`src/cli/sandboxLibrary/materialize.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalog } from './catalog.js'
import { materializeLibrary } from './materialize.js'

const catalogPath = new URL('../../../fixtures/sandbox-libraries/catalog.json', import.meta.url)

describe('materializeLibrary', () => {
  it('writes 0-byte videos for one profile and nothing else', () => {
    const catalog = loadCatalog(catalogPath.pathname)
    const root = mkdtempSync(join(tmpdir(), 'sandbox-lib-'))
    const written = materializeLibrary(catalog, 'zh-viewer', root)
    expect(written.length).toBe(catalog.entries.filter(e => e.profile === 'zh-viewer').length)
    for (const p of written) {
      expect(existsSync(p)).toBe(true)
      expect(statSync(p).size).toBe(0)
    }
    const stray = written.find(p => p.includes('哪吒之魔童降世.2019')) // en-viewer only
    expect(stray).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/v2/scanner.test.ts src/cli/sandboxLibrary/materialize.test.ts`

Expected: scanner case **passes** (characterization pin of existing `size > 0 && size < 10MB` behavior — that is OK; do not change `isScannable`). materialize test FAIL (module missing).

If the scanner case **fails**, stop and report BLOCKED — someone already changed the 0-byte gate.

- [ ] **Step 3: Implement materialize**

```ts
// src/cli/sandboxLibrary/materialize.ts
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Catalog, SandboxProfile } from './catalog.js'

export function materializeLibrary(catalog: Catalog, profile: SandboxProfile, root: string): string[] {
  const out: string[] = []
  for (const e of catalog.entries.filter(x => x.profile === profile)) {
    const abs = join(root, e.relPath)
    mkdirSync(dirname(abs), { recursive: true })
    closeSync(openSync(abs, 'w'))
    out.push(abs)
  }
  return out
}
```

Do **not** use `truncate` / sparse files.

- [ ] **Step 4: Re-run tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sandboxLibrary/materialize.ts src/cli/sandboxLibrary/materialize.test.ts src/v2/scanner.test.ts
git commit -m "$(cat <<'EOF'
feat(sandbox-library): materialize 0-byte videos and pin the scan gate

Empty placeholders must remain scannable so R8 does not skip the whole root.
EOF
)"
```

---

### Task 3: librarySandbox addendum + skill (production stays dark)

**Files:**
- Create: `src/agent/librarySandbox.ts`
- Create: `src/agent/skills/librarySandboxSkill.ts`
- Create: `src/agent/librarySandbox.test.ts`
- Modify: `src/agent/identifyWorker.ts` (`IdentifyWorkerDeps.librarySandbox?: boolean`; prepend via helper)
- Modify: `src/agent/findSubtitleWorker.ts` (`FindSubtitleWorkerDeps.librarySandbox?: boolean`; prepend; include skill only when true)

Addendum text (must start with `LIBRARY SANDBOX TEST`, exact block from spec §6):

```
LIBRARY SANDBOX TEST (ignore in production — this block is absent there).

The video files in this run are empty placeholders (0-byte .mkv/.mp4). ffprobe will
fail or return no duration and no subtitle streams. File size is not evidence.

Do NOT treat probe failure, missing duration, or 0-byte size as: damaged media, a
trailer, a sample, a fake title, or a reason to skip identification / search.

Identify each file as the real world title implied by its directory and file name.
Then find and install real subtitles for that title in the task's target language,
using the same evidence bar and fail-closed rules as production.

For runtime / subtitle-span checks, use TMDB runtime (and the task's
runtimeMinutes), never the placeholder file's ffprobe duration.

You still must not install a subtitle for the wrong episode or the wrong language.
Empty video is not a license to guess.
```

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/librarySandbox.test.ts
import { describe, it, expect } from 'vitest'
import { LIBRARY_SANDBOX_ADDENDUM, withLibrarySandboxPreamble } from './librarySandbox.js'
import { LIBRARY_SANDBOX_SKILL } from './skills/librarySandboxSkill.js'
import { identifySystemPrompt } from './identifyWorker.js'
import { findSubtitleSystemPrompt } from './findSubtitleWorker.js'

describe('librarySandbox preamble', () => {
  it('starts with the production-absent marker', () => {
    expect(LIBRARY_SANDBOX_ADDENDUM.startsWith('LIBRARY SANDBOX TEST')).toBe(true)
  })
  it('off: body unchanged; on: addendum is prefixed', () => {
    expect(withLibrarySandboxPreamble('BODY', false)).toBe('BODY')
    expect(withLibrarySandboxPreamble('BODY', true).startsWith('LIBRARY SANDBOX TEST')).toBe(true)
    expect(withLibrarySandboxPreamble('BODY', true).endsWith('BODY')).toBe(true)
  })
  it('identify default prompt does not mention the test', () => {
    expect(identifySystemPrompt()).not.toContain('LIBRARY SANDBOX TEST')
    expect(identifySystemPrompt(true)).toContain('LIBRARY SANDBOX TEST')
  })
  it('find-subtitle default prompt and skill index omit the test doc', () => {
    const off = findSubtitleSystemPrompt({ librarySandbox: false, identifyOnly: false })
    expect(off.instructions).not.toContain('LIBRARY SANDBOX TEST')
    expect(off.skillNames).not.toContain('library-sandbox-test')
    const on = findSubtitleSystemPrompt({ librarySandbox: true, identifyOnly: false })
    expect(on.instructions.startsWith('LIBRARY SANDBOX TEST')).toBe(true)
    expect(on.skillNames[0]).toBe('library-sandbox-test')
  })
  it('skill name is library-sandbox-test and restates fail-closed', () => {
    expect(LIBRARY_SANDBOX_SKILL.descriptor.name).toBe('library-sandbox-test')
    expect(LIBRARY_SANDBOX_SKILL.content.toLowerCase()).toContain('fail-closed')
  })
})
```

Export `identifySystemPrompt` / `findSubtitleSystemPrompt` from the workers. `findSubtitleSystemPrompt` is a **pure assembler** used by `makeFindSubtitleWorker` — do not duplicate the instruction paragraphs; extract the existing strings.

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/agent/librarySandbox.test.ts`

Expected: FAIL (modules / exports missing).

- [ ] **Step 3: Implement**

`librarySandbox.ts`:

```ts
export const LIBRARY_SANDBOX_ADDENDUM = `LIBRARY SANDBOX TEST (ignore in production — this block is absent there).
...exact spec §6...`

export function withLibrarySandboxPreamble(body: string, on: boolean): string {
  if (!on) return body
  return `${LIBRARY_SANDBOX_ADDENDUM}\n\n${body}`
}
```

Skill: name `library-sandbox-test`. Three sentences: empty file is not identity evidence; use TMDB runtime for span checks; fail-closed is not relaxed.

`IdentifyWorkerDeps` add `librarySandbox?: boolean`. `runIdentify` uses `identifySystemPrompt(deps.librarySandbox === true)`.

`FindSubtitleWorkerDeps` add `librarySandbox?: boolean`. When true, prepend addendum to both identifyOnly and normal instruction strings, and unshift `LIBRARY_SANDBOX_SKILL` onto `skillDocs` **before** `makeReadDocTool` / `systemPromptSkillIndex`.

Do **not** change `makeFindSubtitleSkill` production body.

Do **not** auto-enable from file size.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/librarySandbox.test.ts src/agent/dryRun.test.ts src/agent/skills/registry.test.ts src/agent/skills/findSubtitleSkill.test.ts`

Expected: PASS. Production skill tests still do not see `library-sandbox-test`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/librarySandbox.ts src/agent/librarySandbox.test.ts src/agent/skills/librarySandboxSkill.ts src/agent/identifyWorker.ts src/agent/findSubtitleWorker.ts
git commit -m "$(cat <<'EOF'
feat(sandbox-library): inject a test-only worldview into identify and find-subtitle

Production prompts stay dark unless the CLI flag is set, so empty placeholders
are not treated as trailers.
EOF
)"
```

---

### Task 4: Public `inspectOnce()`

**Files:**
- Modify: `src/v2/daemonV2.ts` (add public method immediately after `requestScan()`)
- Create: `src/v2/daemonV2.inspectOnce.test.ts`

`runInspection` stays private. `inspectOnce` must call it, not copy `runInspectionInner`. This bypasses the 24h gate in `run()` — that is the point.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, closeSync, openSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { ScoutDaemonV2, INSPECT_INTERVAL_MS } from './daemonV2.js'

function mkDeps(db: ReturnType<typeof openDb>, over: Record<string, unknown> = {}) {
  return {
    db,
    roots: ['/media'],
    identify: { db, runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }), worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } } },
    subtitleWorker: async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }),
    targetLanguage: 'zh',
    probe: async () => null,
    probeDuration: async () => null,
    log: () => {},
    sleep: async () => {},
    inspectEveryMs: INSPECT_INTERVAL_MS,
    now: () => 1_000_000_000_000,
    ...over,
  } as any
}

describe('ScoutDaemonV2.inspectOnce', () => {
  it('is public and scans a 0-byte mkv into files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inspect-once-'))
    const dir = join(root, 'Movies', 'Casablanca (1942)')
    mkdirSync(dir, { recursive: true })
    const video = join(dir, 'Casablanca.1942.mkv')
    closeSync(openSync(video, 'w'))
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: [root], rootsProvider: () => [root] }))
    await daemon.inspectOnce(new AbortController().signal)
    const row = db.prepare('SELECT path, size FROM files').get() as { path: string; size: number } | undefined
    expect(row?.path).toBe(video)
    expect(row?.size).toBe(0)
    db.close()
  })

  it('runs even when last_inspect_at is recent (bypasses the 24h gate)', async () => {
    const db = openDb(':memory:')
    const now = 1_000_000_000_000
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(now - 60_000))
    const identifySpy = async () => ({ tmdbId: null, title: null, reason: 'noop' })
    const calls = { n: 0 }
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => now,
      identify: { db, runIdentify: async () => { calls.n++; return { tmdbId: null, title: null, reason: 'noop' } }, worker: {} },
    }))
    await daemon.inspectOnce(new AbortController().signal)
    expect(calls.n).toBeGreaterThanOrEqual(0) // scan still happens; identify only if files exist
    // source pin: inspectOnce must call runInspection, not a copied inner
    const src = readFileSync(new URL('./daemonV2.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/async inspectOnce\([^)]*AbortSignal[^)]*\)[^{]*\{[^}]*this\.runInspection/s)
    db.close()
  })
})
```

Fix the source-pin regex if the method formatting differs; the behavioral 0-byte scan is the real assertion. The source pin must still require `this.runInspection` inside `inspectOnce`.

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/v2/daemonV2.inspectOnce.test.ts`

Expected: FAIL (`inspectOnce` is not a function).

- [ ] **Step 3: Implement**

In `ScoutDaemonV2`, after `requestScan()`:

```ts
  /** One full inspection (scan → identify → judge → subtitles), ignoring the 24h watch gate.
   *  Who writes: sandbox-library CLI only. Production watch keeps using run().
   *  Must not copy runInspectionInner. */
  async inspectOnce(signal: AbortSignal): Promise<void> {
    await this.runInspection(signal)
  }
```

- [ ] **Step 4: Re-run**

Expected: PASS. Also run `npx vitest run src/v2/daemonV2.test.ts --reporter=dot` if time allows; at least `inspectOnce` file + `npm test` later.

- [ ] **Step 5: Commit**

```bash
git add src/v2/daemonV2.ts src/v2/daemonV2.inspectOnce.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): expose inspectOnce for one-shot sandbox runs

The fake-library CLI needs a full inspection without waiting 24 hours
or racing the watch loop.
EOF
)"
```

---

### Task 5: Report verdicts + sandbox-library CLI (mechanical)

**Files:**
- Create: `src/cli/sandboxLibrary/report.ts`
- Create: `src/cli/sandboxLibrary/report.test.ts`
- Create: `src/cli/sandboxLibrary/run.ts`
- Create: `src/cli/sandboxLibrary/run.test.ts`
- Modify: `src/cli/index.ts` (USAGE + dispatch; keep `cmdSandboxLibrary` thin — call `runSandboxLibraryCommand`)
- Modify: `src/cli/watchWiring.test.ts` (source pin: `cmdWatch` / `makeFindSubtitleWorker` in index.ts never passes `librarySandbox: true`)

Sidecar language tags: zh-viewer accepts tags in `tagsForLanguage('zh')` (at least `zh-Hans` / `zh-Hant`). en-viewer accepts `en` / `eng` (`tagsForLanguage('en')`). Cue count: use `parseSrtCues` from `src/files/subtitleInspect.ts` (and `parseAssCues` if `.ass`). Threshold: `> 10`.

Continue all cells; final exit non-zero if any find/skip cell is not PASS.

Missing keys: CLI exits non-zero with a message to set env (TMDB + LLM + at least one subtitle source). Mechanical tests inject deps and skip the env gate.

Never open `join(homedir(), '.subtitle-scout', 'cache', 'scout.db')`. DB path = `<root>/../cache/scout.db` or `join(opts.cacheDir, 'scout.db')` under the temp/scratch tree. Set `SUBTITLE_SCOUT_CACHE_DIR` to that cache dir before `openDb`.

`translateEnabled` for this daemon: `() => false`.

`engine_enabled`: `'true'`. `target_languages`: `'zh'` or `'en'`. `addRoot` the materialized root.

Workers for **production CLI path**: `runIdentify` from identifyWorker with `librarySandbox: true`; `makeFindSubtitleWorker({ ..., librarySandbox: true })`. Copy the identify `getDetails` enrichment pattern from `cmdWatch`'s `identifyDeps` (origin language + chinese titles). Do not start a dashboard.

Workers for **unit test path**: inject stubs (see below).

- [ ] **Step 1: Write failing report tests**

```ts
// src/cli/sandboxLibrary/report.test.ts
import { describe, it, expect } from 'vitest'
import { evaluateFindCell, evaluateSkipCell } from './report.js'

describe('evaluateFindCell', () => {
  it('PASS when identity, covered sidecar in target lang, cues > 10', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 603,
      skipReason: null, needsSubtitle: 1, subStatus: 'covered',
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('PASS')
  })
  it('FAIL-PIPE when wrong title', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 604,
      skipReason: null, needsSubtitle: 1, subStatus: 'covered',
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('FAIL-PIPE')
  })
  it('FAIL-PIPE when en-viewer installs Chinese', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 612399, actualTmdbId: 612399,
      skipReason: null, needsSubtitle: 1, subStatus: 'covered',
      sidecarTags: ['zh-Hans'], cueCount: 11, findSubtitleRuns: 1, targetLanguage: 'en',
    }).verdict).toBe('FAIL-PIPE')
  })
  it('FAIL-SOURCE when identity ok but no_safe_match / not covered', () => {
    expect(evaluateFindCell({
      expectedTmdbId: 603, actualTmdbId: 603,
      skipReason: 'missing', needsSubtitle: 1, subStatus: null,
      sidecarTags: [], cueCount: 0, findSubtitleRuns: 1, targetLanguage: 'zh',
    }).verdict).toBe('FAIL-SOURCE')
  })
})

describe('evaluateSkipCell', () => {
  it('PASS when origin-skip, no worker run, no new sidecar', () => {
    expect(evaluateSkipCell({
      skipReason: 'origin-skip', needsSubtitle: 0,
      findSubtitleRuns: 0, sidecarTags: [],
    }).verdict).toBe('PASS')
  })
  it('FAIL-SKIP when worker ran', () => {
    expect(evaluateSkipCell({
      skipReason: 'origin-skip', needsSubtitle: 0,
      findSubtitleRuns: 1, sidecarTags: [],
    }).verdict).toBe('FAIL-SKIP')
  })
})
```

- [ ] **Step 2: Run to fail, then implement report.ts**

`evaluateFindCell` logic:
- no/wrong `actualTmdbId` → FAIL-PIPE
- sidecar language not in `tagsForLanguage(targetLanguage)` (or Chinese installed for `en`) → FAIL-PIPE
- identity ok, worker ran, but `subStatus !== 'covered'` or `cueCount <= 10` → FAIL-SOURCE
- otherwise PASS

`evaluateSkipCell`:
- `skipReason === 'origin-skip'` && `needsSubtitle === 0` && `findSubtitleRuns === 0` && no target-language sidecar → PASS
- worker ran or sidecar appeared → FAIL-SKIP
- skip reason missing/wrong → FAIL-PIPE

Use `tagsForLanguage` from `src/agent/languages.ts`. Do not invent a second tag table.

- [ ] **Step 3: Write failing CLI / run tests**

`run.test.ts` (mechanical, no LLM):

1. Load catalog, materialize `zh-viewer` into tmp.
2. `openDb` under tmp cache.
3. Settings: `target_languages=zh`, `engine_enabled=true`, `addRoot(root)`.
4. Build `ScoutDaemonV2` with:
   - **real** scan (disk)
   - stub `runIdentify`: map each `facts.workDir` to the catalog entry whose `join(root, relPath)` sits under that workDir; return `{ tmdbId: String(entry.tmdbId), title: entry.id, reason: 'stub' }`
   - stub `tmdb.getDetails`: return `{ id, title: dir-derived or entry.id, originalTitle, year: entry.year, originLanguage: entry.expectedOriginLang, chineseTitles: [], ... }` so `verifyEvidence` can pass. Title must survive `verifyEvidence` / `titleFromDir` — use TMDB-like titles that match the directory (`Casablanca`, `Friends`, `哪吒之魔童降世`, etc.). Put a `title` field on catalog entries **only if needed**; prefer matching dir names already in relPath.
   - stub `subtitleWorker`: for each task target, write a 12-cue SRT next to the video using `stagingLangTag` semantics (`zh-Hans` for zh, `en` for en), return `installed` containing those paths. Count calls per `videoPath`.
5. `await daemon.inspectOnce(signal)`
6. `collectReport(db, catalog, 'zh-viewer', { findSubtitleRunsByPath, sidecarProbe })`
7. Expect every zh-viewer find cell PASS and every skip cell PASS; skip paths have `findSubtitleRuns === 0`.

If `verifyEvidence` rejects stub titles, adjust stub titles to the directory's `titleFromDir` output rather than weakening verifyEvidence.

Also test: `runSandboxLibraryCommand` refuses when `dbPath` would be the default production path (assert it throws / exits before open). Easiest: function `sandboxDbPath(cacheDir: string)` must equal `join(cacheDir, 'scout.db')` and a test that `cacheDir` defaults to something under `os.tmpdir()` or `--root`'s sibling, never `join(homedir(), '.subtitle-scout', 'cache')`.

CLI parsing: `--profile zh-viewer|en-viewer|all`, optional `--root`, optional `--catalog`. `all` runs zh then en with **separate** roots and DBs.

Print a human table of id / verdict / detail. Exit 1 if any non-PASS.

`index.ts` USAGE becomes:

`usage: subtitle-scout watch | doctor | sandbox-library | translate-item <videoPath> | realign-rollback <archiveDir> | auth reset`

Dispatch: `if (cmd === 'sandbox-library') return cmdSandboxLibrary(process.argv.slice(3))`

- [ ] **Step 4: Production-watch negative pin**

In `watchWiring.test.ts` (or a small new test next to it):

```ts
it('cmdWatch 组装的 find-subtitle worker 不许打开 librarySandbox', () => {
  const src = readFileSync('src/cli/index.ts', 'utf8')
  // sandbox-library 命令可以传 true；watch 那条 makeFindSubtitleWorker 不许
  const watchChunk = src.slice(src.indexOf('async function cmdWatch'), src.indexOf('async function cmdDoctor'))
  expect(watchChunk).not.toMatch(/librarySandbox:\s*true/)
})
```

Adjust slice bounds if `cmdDoctor` is not the next function; grep-anchor on `subtitleWorkerV2` assignment instead:

```ts
expect(src).toMatch(/makeFindSubtitleWorker\(\{ model: reasoningModel, adapters: realignAdapters, cacheRoot, tmdb \}\)/)
```

The existing production call must remain without the flag (undefined/false).

- [ ] **Step 5: Implement run.ts / index.ts, make tests pass**

Env gate for live/CLI (not unit stubs): require `TMDB_API_KEY`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`, and (`ASSRT_TOKEN` or OpenSubtitles trio). Message in Chinese is fine.

`librarySandbox: true` only in this CLI's worker assembly.

- [ ] **Step 6: Run**

`npx vitest run src/cli/sandboxLibrary src/cli/watchWiring.test.ts src/agent/librarySandbox.test.ts src/v2/daemonV2.inspectOnce.test.ts src/v2/scanner.test.ts`

Then `npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add src/cli/sandboxLibrary src/cli/index.ts src/cli/watchWiring.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add sandbox-library one-shot pipeline

Materialize a fake library, inspect once against a temp db, and report
per-title verdicts without touching the production cache.
EOF
)"
```

---

### Task 6: OrbStack live run (out of band)

**Files:**
- Create: `scripts/run-sandbox-library-in-orbstack.sh`
- Modify: `.gitignore` add `sandbox-scratch/`
- Do **not** add this script to `npm test`

Follow `scripts/run-live-matrix-in-orbstack.sh` (repo mount + `--env-file .env`) **plus** `npm rebuild better-sqlite3` inside Linux so Darwin native bindings are not used. Install ffmpeg in the container (ffprobe will fail on 0-byte files; that is expected). Do **not** copy host `better-sqlite3` as the Linux binary.

```bash
#!/usr/bin/env bash
# Live fake-library run inside OrbStack/Docker: real TMDB + LLM + subtitle providers,
# 0-byte videos. Not part of npm test.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p sandbox-scratch
PROFILE="${1:-all}"
docker run --rm \
  --env-file .env \
  -v "$PWD":/app -w /app \
  -v "$PWD/sandbox-scratch":/tmp/sandbox-scratch \
  -e TMPDIR=/tmp/sandbox-scratch \
  -e SUBTITLE_SCOUT_CACHE_DIR=/tmp/sandbox-scratch/cache \
  node:22-slim \
  sh -lc 'apt-get update -qq && apt-get install -y -qq python3 make g++ ffmpeg ca-certificates >/dev/null && npm rebuild better-sqlite3 && npx tsx src/cli/index.ts sandbox-library --profile "$0" --root /tmp/sandbox-scratch/lib' \
  "$PROFILE"
```

- [ ] **Step 1: Script exists and is executable; gitignore scratch**

- [ ] **Step 2: Run live**

`scripts/run-sandbox-library-in-orbstack.sh all`

This will take a long time (many identify + find-subtitle sessions). Do **not** abort remaining cells on first failure. Capture the printed report.

- [ ] **Step 3: Interpret**

- FAIL-PIPE / FAIL-SKIP → fix code (wrong identity, wrong language sidecar, skip dispatched worker). Re-run the failing profile.
- FAIL-SOURCE on a seed → first check TMDB id / title in catalog; only then blame the agent. Do not delete the coverage axis.
- If en-viewer installs `en` (or `eng`) sidecars, that string is the §8.3 answer — no spec edit required beyond what tagsForLanguage already says.
- Translate must not run (`translateEnabled` false).

Do not print API keys.

- [ ] **Step 4: Commit script + gitignore only** (not scratch, not downloaded srt under scratch)

```bash
git add scripts/run-sandbox-library-in-orbstack.sh .gitignore
git commit -m "$(cat <<'EOF'
chore(sandbox-library): add OrbStack live runner

Keep the LLM-and-provider pass off npm test and off Darwin sqlite bindings.
EOF
)"
```

If live revealed a real product bug (e.g. `origin_lang=cn` not skipping because judge uses exact `includes` not `langOf`), fix it in a **separate** commit with a failing unit test first. Do not silently weaken sandbox assertions.

---

## Anti-drift rules for implementers

- One episode per series. No Cassandra / German translate titles.
- Do not name the flag `sandbox` (collides with path isolation).
- Do not enable the flag from `size===0`.
- Do not open the production scout.db.
- Do not implement translate, frontend, or open-source hygiene in this branch.
- `npm test` must stay deterministic: no live network in unit tests.
- Work on `feat/sandbox-library-test`, not `main`.
- Commit after each task. Do not push.

## Spec coverage

| Spec | Task |
|---|---|
| §4.1 0-byte + isScannable + no black frames | 2 |
| §4.2 librarySandbox flag, prepend, skill, production dark | 3 |
| §4.3 live providers, not in npm test | 5 mechanical / 6 live |
| §4.4 two profiles, two dirs, two DBs | 5 |
| §5 coverage axes + control variables | 1 |
| §6 addendum text | 3 |
| §7 CLI + inspectOnce + OrbStack | 4, 5, 6 |
| §8 verdicts | 5 |
| Translate out of scope | 5 (`translateEnabled` false) |
