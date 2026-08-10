# Chinese-Origin Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **IRON LAW:** each implementer works in an ISOLATED git worktree (or strictly sequential on the shared dir — tasks here are sequential). Task N+1 starts from the merged result of task N.

**Goal:** Stop the subtitle workflow from ever triggering on Chinese-origin content, using TMDB `original_language` (self-queried on the early tmdbId) as the authoritative signal — closing both the movie cold-start race and the total lack of protection for Chinese TV.

**Architecture:** (spec: `docs/design/2026-07-11-chinese-origin-detection-design.md`) Scan-time resolve + per-title DB cache (Approach A). Add `TmdbClient.getOriginLanguage`; cache the result on `movies.origin_lang`/`series.origin_lang`; `classifyItem` reads the cached origin and returns `ignored` for `zh` before any other rule; a fallback ladder (ProductionLocations → Han-not-kana-not-hangul heuristic → fail-open) covers the TMDB-unavailable degraded mode.

**Tech Stack:** Node 22 ESM, TypeScript 6 (tsx, no compile), zod v4, vitest v4 (co-located `*.test.ts`), better-sqlite3, ffmpeg (fixtures).

**Branch:** create `chinese-origin` off `main` before Task 1.

**Key existing shapes (already read; implementers should re-open as needed):**
- `src/adapters/providers/tmdb.ts` — `TmdbClient` (`getJson` private fail-soft helper; `getChineseTitles`), `resolveTmdbRef(item, getItem) → {mediaType:'tv'|'movie', tmdbId} | null` (ALREADY handles Movie/Series/Episode→series), `TmdbRef` type.
- `src/daemon/triggers.ts` — `isChineseOrigin(item)` (ProductionLocations regex; keep as fallback), `CHINESE_LANG_TAGS`.
- `src/v2/scanner.ts` — `classifyItem(item, deps)` (sync; rules: chinese-origin→ignored, zh-track→covered/embedded, sidecar→covered, else missing) and `scanLibrary(jf, lib, opts)` (loops pages; for Episode: warns if no SeriesId, upserts series at :100, then upserts episode; for Movie: upserts movie).
- `src/v2/libraryRepo.ts` — `upsertSeries`/`upsertMovie` (explicit-column upserts, won't touch a new column), `getEpisode`/`getMovie`, `SubStatus` type.
- `src/v2/db.ts` — `MIGRATIONS` array (exported), `openDb` runs each via `db.exec` inside a transaction, version in `meta.schema_version`.
- `src/cli/index.ts` — `assemble()` builds `TmdbClient | null` (line ~94, gated on `TMDB_API_KEY`); `cmdWatch` wires the scanner via `ScoutDaemon`.
- `scripts/gen-mock-library.sh` — ffmpeg 1s-black-clip generator; `docker-compose.local.yml` local stack.

---

## Task 1: `getOriginLanguage` + origin predicates (TmdbClient + triggers, additive)

**Files:**
- Modify: `src/adapters/providers/tmdb.ts` (one method)
- Modify: `src/daemon/triggers.ts` (two pure predicates)
- Test: `src/adapters/providers/tmdb.origin.test.ts` (new), extend `src/daemon/triggers.test.ts`

- [ ] **Step 1: Write failing tests.**

`src/adapters/providers/tmdb.origin.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { TmdbClient } from './tmdb.js'

const okJson = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))

describe('TmdbClient.getOriginLanguage', () => {
  it('returns lowercased original_language for a movie', async () => {
    let url = ''
    const c = new TmdbClient({ apiKey: 'k', fetchImpl: ((u: string) => { url = String(u); return okJson({ original_language: 'zh' }) }) as never })
    expect(await c.getOriginLanguage('movie', '535167')).toBe('zh')
    expect(url).toContain('/movie/535167')
  })
  it('uses the tv endpoint for tv', async () => {
    let url = ''
    const c = new TmdbClient({ apiKey: 'k', fetchImpl: ((u: string) => { url = String(u); return okJson({ original_language: 'JA' }) }) as never })
    expect(await c.getOriginLanguage('tv', '1429')).toBe('ja')
    expect(url).toContain('/tv/1429')
  })
  it('returns null on non-2xx / missing field / network error (fail-soft)', async () => {
    const c404 = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.resolve(new Response('x', { status: 404 }))) as never })
    expect(await c404.getOriginLanguage('movie', '1')).toBeNull()
    const cEmpty = new TmdbClient({ apiKey: 'k', fetchImpl: (() => okJson({})) as never })
    expect(await cEmpty.getOriginLanguage('movie', '1')).toBeNull()
    const cErr = new TmdbClient({ apiKey: 'k', fetchImpl: (() => Promise.reject(new Error('net'))) as never })
    expect(await cErr.getOriginLanguage('movie', '1')).toBeNull()
  })
})
```

Extend `src/daemon/triggers.test.ts` (add a describe block):
```ts
import { isChineseLang, looksChineseTitle } from './triggers.js'  // add to existing imports

describe('isChineseLang', () => {
  it('true for zh/cn, false for others/nullish', () => {
    expect(isChineseLang('zh')).toBe(true)
    expect(isChineseLang('cn')).toBe(true)
    expect(isChineseLang('ja')).toBe(false)
    expect(isChineseLang('ko')).toBe(false)
    expect(isChineseLang('en')).toBe(false)
    expect(isChineseLang(null)).toBe(false)
    expect(isChineseLang(undefined)).toBe(false)
  })
})
describe('looksChineseTitle', () => {
  it('Han-only → true; kana/hangul present → false', () => {
    expect(looksChineseTitle('英雄')).toBe(true)
    expect(looksChineseTitle('流浪地球')).toBe(true)
    expect(looksChineseTitle('進撃の巨人')).toBe(false) // の is kana
    expect(looksChineseTitle('오징어 게임')).toBe(false) // hangul
    expect(looksChineseTitle('Peacemaker')).toBe(false) // no Han
    expect(looksChineseTitle(null)).toBe(false)
    expect(looksChineseTitle('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/adapters/providers/tmdb.origin.test.ts src/daemon/triggers.test.ts`

- [ ] **Step 3: Implement.** Add to `TmdbClient` (after `getChineseTitles`):
```ts
/** TMDB detail 端点的 original_language（movie/tv 通用，小写化）。失败静默返回 null（增益路径）。 */
async getOriginLanguage(mediaType: 'tv' | 'movie', tmdbId: string): Promise<string | null> {
  const d = await this.getJson(`/${mediaType}/${tmdbId}`)
  const lang = d?.original_language
  return typeof lang === 'string' ? lang.toLowerCase() : null
}
```
Add to `src/daemon/triggers.ts`:
```ts
/** TMDB original_language 判国产：'zh' 及历史别名 'cn'。ja/ko/en 等一律 false。 */
export function isChineseLang(lang: string | null | undefined): boolean {
  return lang === 'zh' || lang === 'cn'
}

const HAN = /[一-鿿]/
const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯]/
/** 兜底启发式：含汉字且无假名无谚文 → 视作中文（排除日番/韩剧）。无 TMDB 信号时用。 */
export function looksChineseTitle(title: string | null | undefined): boolean {
  return !!title && HAN.test(title) && !KANA.test(title) && !HANGUL.test(title)
}
```

- [ ] **Step 4: Run tests → PASS**; full gate `npx tsc --noEmit && npx vitest run` green (additive).

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(tmdb): getOriginLanguage + isChineseLang/looksChineseTitle origin predicates"`

---

## Task 2: `origin_lang` migration + LibraryRepo accessors

**Files:**
- Modify: `src/v2/db.ts` (append migration)
- Modify: `src/v2/libraryRepo.ts` (3 accessors)
- Test: extend `src/v2/libraryRepo.test.ts`; migration assertion in `src/v2/db.test.ts` (or the migration test file pattern)

- [ ] **Step 1: Write failing tests.**

Migration test (follow the pattern in `src/v2/migration.provider-ref.test.ts` — replay MIGRATIONS up to the prior HEAD, then `openDb` applies the new one; simplest robust form: fresh `openDb(':memory:')` and assert the columns exist since there's no data to migrate for a nullable ADD COLUMN):
```ts
import { describe, it, expect } from 'vitest'
import { openDb } from './db.js'

describe('origin_lang migration', () => {
  it('adds nullable origin_lang to movies and series', () => {
    const db = openDb(':memory:')
    const movieCols = (db.prepare('PRAGMA table_info(movies)').all() as { name: string }[]).map(c => c.name)
    const seriesCols = (db.prepare('PRAGMA table_info(series)').all() as { name: string }[]).map(c => c.name)
    expect(movieCols).toContain('origin_lang')
    expect(seriesCols).toContain('origin_lang')
    db.close()
  })
})
```

LibraryRepo test (extend `libraryRepo.test.ts` — reuse its in-memory `openDb` + `LibraryRepo` setup):
```ts
it('origin_lang: set + get for series and movie, null by default', () => {
  lib.upsertSeries({ id: 's1', name: 'S', posterTag: null })
  expect(lib.getSeriesOriginLang('s1')).toBeNull()
  lib.setSeriesOriginLang('s1', 'zh')
  expect(lib.getSeriesOriginLang('s1')).toBe('zh')

  lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing', posterTag: null, year: null, providerIds: null })
  expect(lib.getMovieOriginLang('m1')).toBeNull()
  lib.setMovieOriginLang('m1', 'ja')
  expect(lib.getMovieOriginLang('m1')).toBe('ja')
})
it('getSeriesOriginLang returns null for unknown series', () => {
  expect(lib.getSeriesOriginLang('nope')).toBeNull()
})
it('upsertMovie/upsertSeries do not clobber an existing origin_lang', () => {
  lib.upsertMovie({ id: 'm2', name: 'M', path: '/m.mkv', subStatus: 'missing', posterTag: null, year: null, providerIds: null })
  lib.setMovieOriginLang('m2', 'zh')
  lib.upsertMovie({ id: 'm2', name: 'M2', path: '/m2.mkv', subStatus: 'covered', posterTag: null, year: 2020, providerIds: null })
  expect(lib.getMovieOriginLang('m2')).toBe('zh') // upsert never writes origin_lang column
})
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement.** Append to `MIGRATIONS` in `src/v2/db.ts` (one new string entry; multi-statement is fine — `db.exec`):
```sql
ALTER TABLE movies ADD COLUMN origin_lang TEXT;
ALTER TABLE series ADD COLUMN origin_lang TEXT;
```
(NULL = 未解析；ISO code = 已解析、不再回查。`upsertMovie`/`upsertSeries` 不含 origin_lang 列，天然不覆盖。)

Add to `LibraryRepo` (near `getMovie`/`getEpisode`):
```ts
getSeriesOriginLang(seriesId: string): string | null {
  const row = this.db.prepare('SELECT origin_lang FROM series WHERE id = ?').get(seriesId) as { origin_lang: string | null } | undefined
  return row?.origin_lang ?? null
}
getMovieOriginLang(movieId: string): string | null {
  const row = this.db.prepare('SELECT origin_lang FROM movies WHERE id = ?').get(movieId) as { origin_lang: string | null } | undefined
  return row?.origin_lang ?? null
}
setSeriesOriginLang(seriesId: string, lang: string): void {
  this.db.prepare('UPDATE series SET origin_lang = ? WHERE id = ?').run(lang, seriesId)
}
setMovieOriginLang(movieId: string, lang: string): void {
  this.db.prepare('UPDATE movies SET origin_lang = ? WHERE id = ?').run(lang, movieId)
}
```
If `doctor.ts` has an `EXPECTED_VERSION = String(MIGRATIONS.length)` it auto-tracks; verify it's not a hardcoded literal (it was fixed to `String(MIGRATIONS.length)` in the provider_ref work — confirm).

- [ ] **Step 4: Run tests → PASS**; `npx tsc --noEmit && npx vitest run` green.

- [ ] **Step 5: Commit** — `git commit -am "feat(v2): origin_lang column + LibraryRepo get/set accessors"`

---

## Task 3: scanner origin resolution + classify wiring + fallback ladder

**Files:**
- Modify: `src/v2/scanner.ts` (classifyItem signature + scan loop reorder + resolver plumbing)
- Modify: `src/cli/index.ts` (pass origin-resolution deps into the scanner)
- Test: extend `src/v2/scanner.test.ts`

The scanner currently classifies BEFORE upserting the series (spec §3 ordering note). New per-item flow:
- **Movie**: read `lib.getMovieOriginLang(id)`; if null and item has `ProviderIds.Tmdb` and a resolver is present → `resolver.originFor(item)` → if non-null `setMovieOriginLang`. Then `classifyItem(item, {...deps, originLang})` → upsertMovie.
- **Episode**: resolve series ref; upsert series FIRST; if `lib.getSeriesOriginLang(seriesId)` is null and resolvable → resolve + `setSeriesOriginLang`; read origin; `classifyItem(item, {...deps, originLang})` → upsertEpisode.

To keep `scanLibrary` testable without a live TMDB, inject an optional resolver:
```ts
export interface OriginResolver {
  // returns original_language for the item's own TMDB ref (movie) or its series ref (episode/series), or null
  originFor: (item: JellyfinItem) => Promise<string | null>
}
```

- [ ] **Step 1: Write failing tests** (extend `scanner.test.ts` — reuse its in-memory lib + fake `getItemsPage`; add a fake resolver):
```ts
it('classifyItem: zh origin → ignored before any other rule', () => {
  // even a would-be-missing item with no subs is ignored when originLang=zh
  const status = classifyItem(
    { Id: 'm', Type: 'Movie', Name: 'X', Path: '/x.mkv', MediaStreams: [] } as never,
    { fileExists: () => false, mappings: [], skipChineseOrigin: true, originLang: 'zh' })
  expect(status).toBe('ignored')
})
it('classifyItem: ja origin → NOT ignored (falls through to missing)', () => {
  const status = classifyItem(
    { Id: 'm', Type: 'Movie', Name: 'X', Path: '/x.mkv', MediaStreams: [] } as never,
    { fileExists: () => false, mappings: [], skipChineseOrigin: true, originLang: 'ja' })
  expect(status).toBe('missing')
})
it('classifyItem fallback: null origin + Chinese ProductionLocations (movie) → ignored', () => {
  const status = classifyItem(
    { Id: 'm', Type: 'Movie', Name: 'X', Path: '/x.mkv', MediaStreams: [], ProductionLocations: ['China'] } as never,
    { fileExists: () => false, mappings: [], skipChineseOrigin: true, originLang: null })
  expect(status).toBe('ignored')
})
it('classifyItem fallback: null origin + Han-only series title → ignored', () => {
  const status = classifyItem(
    { Id: 'e', Type: 'Episode', Name: 'X', Path: '/x.mkv', MediaStreams: [], SeriesName: '三体' } as never,
    { fileExists: () => false, mappings: [], skipChineseOrigin: true, originLang: null })
  expect(status).toBe('ignored')
})
it('classifyItem fallback: null origin + kana series title → NOT ignored', () => {
  const status = classifyItem(
    { Id: 'e', Type: 'Episode', Name: 'X', Path: '/x.mkv', MediaStreams: [], SeriesName: '進撃の巨人' } as never,
    { fileExists: () => false, mappings: [], skipChineseOrigin: true, originLang: null })
  expect(status).toBe('missing')
})

it('scanLibrary caches series origin once and reads it for episodes', async () => {
  let calls = 0
  const resolver = { originFor: async () => { calls++; return 'zh' } }
  // page with two episodes of the same series, then empty page
  const jf = { getItemsPage: async (start: number) => start === 0 ? [ep('e1','s9',1), ep('e2','s9',2)] : [] }
  await scanLibrary(jf as never, lib, { pageSize: 50, fileExists: () => false, mappings: [], skipChineseOrigin: true, resolver })
  expect(lib.getSeriesOriginLang('s9')).toBe('zh')
  expect(lib.getEpisode('e1')!.sub_status).toBe('ignored')
  expect(calls).toBe(1) // resolved once, second episode reads cache
})
```
(Define local `ep(id, seriesId, n)` helper returning a minimal Episode JellyfinItem with `SeriesId`, `ProviderIds:{Tmdb:'x'}`. If `scanner.test.ts` already has such a helper, reuse it.)

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement classifyItem** — add `originLang` to the deps param and the new rule 0:
```ts
export function classifyItem(
  item: JellyfinItem,
  deps: {
    fileExists: (path: string) => boolean
    mappings: PathMapping[]
    skipChineseOrigin: boolean
    originLang?: string | null
  }
): SubStatus {
  // 0. 国产（TMDB original_language=zh）→ ignored（先于一切）
  if (deps.skipChineseOrigin && isChineseLang(deps.originLang)) return 'ignored'

  // 1. Chinese origin fallback (movie ProductionLocations) — only when TMDB gave nothing
  if (deps.skipChineseOrigin && deps.originLang == null && isChineseOrigin(item)) return 'ignored'
  // 1b. Chinese origin fallback (series/episode title heuristic)
  if (deps.skipChineseOrigin && deps.originLang == null && looksChineseTitle(item.SeriesName ?? item.OriginalTitle)) return 'ignored'

  // ... existing rules 2-4 unchanged (zh track covered/embedded, sidecar covered, else missing)
}
```
Import `isChineseLang`, `looksChineseTitle` from `../daemon/triggers.js`.

- [ ] **Step 4: Implement scanLibrary reorder + resolver** — thread an optional `resolver?: OriginResolver` through `opts`. In the loop: for Movie, resolve/read movie origin then classify; for Episode, upsert series first, resolve/read series origin, then classify. Cache-check before every resolve (`getMovieOriginLang`/`getSeriesOriginLang` non-null → skip the call). Persist newly-resolved non-null via the setters. Pass `originLang` into `classifyItem`.

- [ ] **Step 5: Wire the real resolver in `src/cli/index.ts`** — build an `OriginResolver` from the existing `tmdb` client (null when `tmdb` is null → resolver omitted, degraded ladder kicks in). Use `resolveTmdbRef(item, id => jf.getItem(id))` then `tmdb.getOriginLanguage(ref.mediaType, ref.tmdbId)`:
```ts
const originResolver = tmdb ? {
  originFor: async (item) => {
    const ref = await resolveTmdbRef(item, id => jf.getItem(id))
    return ref ? tmdb.getOriginLanguage(ref.mediaType, ref.tmdbId) : null
  },
} : undefined
```
Pass it into the scanner options where `scanLibrary`/`ScoutDaemon` is constructed. (Read how `cmdWatch` currently supplies scanner opts and thread `resolver` alongside `skipChineseOrigin`/`mappings`.)

- [ ] **Step 6: Run tests → PASS**; `npx tsc --noEmit && npx vitest run` green (existing scanner tests must still pass — the `originLang` param is optional, defaulting to today's behavior).

- [ ] **Step 7: Commit** — `git commit -am "feat(scanner): TMDB-origin gate — resolve+cache origin_lang, ignore zh, fallback ladder"`

---

## Task 4: mock-library fixtures (国产剧 + 国产动画 + 日番 negative control)

**Files:**
- Modify: `scripts/gen-mock-library.sh`
- Test: manual verification (script run + TMDB curl sanity)

- [ ] **Step 1: Add three clips** to `scripts/gen-mock-library.sh` (after the existing TV block):
```bash
# —— 国产剧（TMDB original_language=zh，应判 ignored）——
clip "TV/Three-Body (2023)/Season 01/Three-Body (2023) S01E01 1080p.mkv"
# —— 国产动画（zh，应 ignored）——
clip "TV/Scissor Seven (2018)/Season 01/Scissor Seven (2018) S01E01 1080p.mkv"
# —— 日番负对照（ja，必须仍被处理、照下中文字幕）——
clip "TV/Attack on Titan (2013)/Season 01/Attack on Titan (2013) S01E01 1080p.mkv"
```

- [ ] **Step 2: Verify the titles resolve as expected** — sanity curl (uses repo `.env` TMDB key; helper to extract original_language):
```bash
source <(grep TMDB_API_KEY ~/projects/subtitle-scout/.env)
for q in "Three-Body" "Scissor Seven" "Attack on Titan"; do
  curl -s "https://api.themoviedb.org/3/search/tv?query=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$q")" \
    -H "Authorization: Bearer $TMDB_API_KEY" | node -e 'let s="";process.stdin.on("d",c=>s+=c).on("end",()=>{const r=JSON.parse(s).results?.[0];console.log(r?.name, "→", r?.original_language)})'
done
```
Expected: Three-Body → `zh`, Scissor Seven → `zh`, Attack on Titan → `ja`. If a title resolves ambiguously, pick a cleaner unambiguous 国产 show/anime and update the fixture + this plan note.

- [ ] **Step 3: Regenerate + verify files** — `scripts/gen-mock-library.sh && find fixtures/media/TV -name '*.mkv' | sort` shows the 3 new files; each < 100KB; `bash -n scripts/gen-mock-library.sh` clean.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(dev): mock fixtures — 国产剧/国产动画 (zh) + 日番 negative control (ja) for origin detection"`

---

## Task 5: Controller cold-start e2e + merge (main loop, NOT a subagent)

The controller runs this on OrbStack. User has authorized generous local testing.

- [ ] **Step 1: Fresh cold-start stack.** Tear down + recreate to genuinely reproduce cold-start (fresh Jellyfin config so metadata scrapes from zero):
```bash
cd ~/projects/subtitle-scout
docker compose -f docker-compose.local.yml down -v
scripts/gen-mock-library.sh
docker compose -f docker-compose.local.yml up -d --build
```
Then automate the Jellyfin wizard + libraries + API key (as in the prior e2e), refresh `.env` JELLYFIN_API_KEY, recreate scout.

- [ ] **Step 2: Acceptance checklist** (watch logs + inspect SQLite):
  1. After reconcile, `movies.origin_lang` and `series.origin_lang` are populated (`sqlite3`/node dump): Hero/Wandering Earth = `zh`, Three-Body/Scissor Seven = `zh`, Attack on Titan = `ja`, Peacemaker/Young Sheldon/LDR = their real codes (en/…).
  2. **The bug is fixed:** Hero, Wandering Earth, Three-Body, Scissor Seven → `ignored`, **no jobs created, no subtitles downloaded** for them (check `jobs` table has none for those ids; check no sidecar files appear under their dirs).
  3. **Negative control holds:** Attack on Titan → episodes `missing` → job created → subtitle hunt runs (it should still try to get Chinese subs for the anime). Whether it finds one is irrelevant; it must not be `ignored`.
  4. **Race closed:** the Chinese films are `ignored` at the FIRST reconcile (not downloaded-then-corrected). Confirm via `runs` table: zero download runs for Hero/Wandering Earth this run.
  5. Non-Chinese Western content (Peacemaker/Young Sheldon) still processed normally (regression check).
- [ ] **Step 3: Fix anything found** (loop back to the owning task with a fix subagent), re-run from a clean `down -v`.
- [ ] **Step 4: Adversarial final review** (opus) of the whole branch diff; address findings; then merge via superpowers:finishing-a-development-branch. NAS deploy stays FROZEN until the user says go.

---

## Self-Review Notes (done at plan time)

- **Spec coverage:** §1 signal → Task 1; §2 cache → Task 2; §3 scan+classify+ordering → Task 3; §4 fallback ladder → Task 3 (classifyItem rules 1/1b) + Task 1 (predicates); §5 residual → accepted, no code; §6 fixtures → Task 4; §7 testing → distributed across every task's tests + Task 5 e2e.
- **Type consistency:** `getOriginLanguage(mediaType, tmdbId)`, `isChineseLang`, `looksChineseTitle`, `getSeriesOriginLang`/`getMovieOriginLang`/`setSeriesOriginLang`/`setMovieOriginLang`, `classifyItem(..., {originLang})`, `OriginResolver.originFor` — names consistent across Tasks 1-3.
- **Known risk for implementers:** Task 3 reorders scan-loop series-upsert above classify; the existing "Episode without SeriesId → skip" guard must stay before the series upsert. Keep every existing scanner test green (originLang optional → default behavior unchanged). The fallback heuristic (rule 1b) fires only when TMDB returned nothing — verify it does not regress non-Chinese titles that happen to contain a stray Han character in a mostly-Latin name (acceptable: such a title needs Han AND no kana/hangul AND no resolved origin — extremely narrow; the e2e Western shows confirm no false positives).
