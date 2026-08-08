# Chinese-Origin Detection Design

**Date:** 2026-07-11
**Status:** Draft for User Review
**Context:** During multi-source Phase 1 e2e (fresh OrbStack Jellyfin), Chinese-origin films (英雄/流浪地球) were wrongly given downloaded Chinese subtitles. Investigation revealed the origin filter (`isChineseOrigin`) is **movie-only and race-prone**, and Chinese TV series are entirely unprotected. This design replaces the origin signal with TMDB `original_language`, closing both the cold-start race and the TV gap.

North-star tie-in: "用户挂上就再也不用管字幕" requires the workflow to **never wrongly touch 国产 content** — the gate's admission criterion (which media triggers the subtitle hunt) is the coverage ceiling. This is a gate-quality fix.

---

## Problem (verified 2026-07-10/11)

Current origin detection: `isChineseOrigin(item)` (`src/daemon/triggers.ts:12`) tests `item.ProductionLocations` against a China regex.

1. **Movie cold-start race.** `ProductionLocations` is a TMDB-sourced field Jellyfin scrapes **asynchronously after** the initial file scan. On a fresh/cold library, the first reconcile classifies a Chinese film before locations are populated → `isChineseOrigin` returns false (it fails open: "元数据缺失返回 false") → classified `missing` → job → subtitle downloaded. The next reconcile (~15 min) reclassifies to `ignored`, but the wasteful download already happened. **Reproduced:** Hero (`ProductionLocations: ["Hong Kong","China"]`), The Wandering Earth (`["China"]`) — jobs created at first reconcile (15:02:48), downloaded 15:07/15:09, only marked `ignored` at the second reconcile (15:18:00).
2. **TV entirely unprotected.** Episodes carry no `ProductionLocations`; the *series* doesn't get it either — verified: Peacemaker series after a forced `FullRefresh&replaceAllMetadata=true` still has `ProductionLocations: undefined` (Jellyfin does not map origin to `ProductionLocations` for TV). And `classifyItem` never resolves an episode to its series. So `isChineseOrigin` is structurally a no-op for all TV → Chinese series/anime are always triggered.
3. **The CJK trap.** `OriginalTitle` arrives early (with `ProviderIds`) and is CJK for 国产 content (英雄/流浪地球), but **CJK ≠ Chinese**: Japanese anime and Korean dramas also have CJK original titles, and those MUST still be processed (the user wants Chinese subtitles for them). A naive "skip CJK original title" would strand all anime — a north-star violation.

## Signal choice: TMDB `original_language`

TMDB's `original_language` is authoritative and cleanly distinguishes `zh` (Chinese) from `ja`/`ko`, works for both movies and TV, and — critically — **we query TMDB ourselves using only the early-available `tmdbId`**, so origin is known as soon as Jellyfin assigns `ProviderIds.Tmdb` (early, with the rest of ProviderIds), independent of Jellyfin's slow ProductionLocations scrape. This collapses the race at the signal layer. `TMDB_API_KEY` + `TmdbClient` already exist in the codebase.

---

## Design

### 1. Origin resolution (TmdbClient)

Add one method to `src/adapters/providers/tmdb.ts`:

```ts
/** TMDB detail 端点的 original_language（movie/tv 通用）。失败静默返回 null（增益路径）。 */
async getOriginLanguage(mediaType: 'tv' | 'movie', tmdbId: string): Promise<string | null> {
  const d = await this.getJson(`/${mediaType}/${tmdbId}`)
  const lang = d?.original_language
  return typeof lang === 'string' ? lang.toLowerCase() : null
}
```

Episode→series resolution reuses the existing `resolveTmdbRef(item, getItem)` (`tmdb.ts`), which already returns `{ mediaType, tmdbId }` for Movie / Series / Episode→series.

A small pure predicate decides Chinese-origin from a language code:
```ts
// 'zh' 及历史别名 'cn' 判国产；ja/ko/en 等一律不是。
export function isChineseLang(lang: string | null | undefined): boolean {
  return lang === 'zh' || lang === 'cn'
}
```

### 2. Caching (schema)

Origin is immutable per title → resolve once, store, never re-query. New migration (append to `MIGRATIONS` in `src/v2/db.ts`):
```sql
ALTER TABLE movies ADD COLUMN origin_lang TEXT;   -- NULL = 未解析；ISO code = 已解析
ALTER TABLE series ADD COLUMN origin_lang TEXT;
```
`origin_lang` semantics: `NULL` = not yet resolved (retry on next scan); a real code (`'zh'`, `'ja'`, `'en'`, …) = resolved, never re-queried. Episodes hold no origin column — they read their series' `origin_lang`.

`LibraryRepo` gains: `getSeriesOriginLang(seriesId): string | null`, `setMovieOriginLang(id, lang)`, `setSeriesOriginLang(id, lang)`, and `upsertMovie`/`upsertSeries` preserve an existing non-null `origin_lang` (never overwrite a resolved value with null).

### 3. Scan-time resolution + classify

In `scanLibrary` (`src/v2/scanner.ts`), before classifying each item, resolve-or-read its origin:

- **Movie**: if `movies.origin_lang` is NULL and the item has a Tmdb id → `getOriginLanguage('movie', tmdbId)`, persist via `setMovieOriginLang`. Use the resolved value (or the cached one) as `originLang`.
- **Series (upsert path for an episode)**: when first upserting the series row, if `series.origin_lang` is NULL and the series has a Tmdb id (resolve via `resolveTmdbRef` on the episode → series) → `getOriginLanguage('tv', tmdbId)`, persist via `setSeriesOriginLang`. Episodes then read `getSeriesOriginLang(seriesId)` as their `originLang`.

`classifyItem` gains a parameter `originLang: string | null` and a **first** rule:
```ts
// 0. 国产（TMDB original_language=zh）→ ignored（先于一切）
if (deps.skipChineseOrigin && originLang != null && isChineseLang(originLang)) return 'ignored'
```
The existing rules (ProductionLocations skip, covered/embedded/missing) follow unchanged.

**Ordering note (implementation-critical):** `classifyItem` currently runs at `scanner.ts:86` *before* the series is upserted (`:100`). Since an episode's `originLang` comes from its series row, the scan loop must, for an episode, **first** upsert+resolve the series origin, **then** read it and pass it into `classifyItem`. So the per-item flow becomes: (episode) resolve series ref → upsert series (resolving `origin_lang` if null) → read `getSeriesOriginLang` → `classifyItem(item, ..., originLang)` → upsert episode. For a movie: resolve/read the movie's own `origin_lang` → `classifyItem` → upsert movie. This reorders the existing series-upsert above the classify call.

Because origin is queried from the early `tmdbId`, an identified Chinese film resolves `origin_lang='zh'` at the **first** scan → `ignored` → never jobbed. Race closed for the common (identified) case.

### 4. Fallback ladder (no TMDB key / no tmdbId / TMDB call failed)

`originLang` will be `null` when: `TMDB_API_KEY` absent, item has no `ProviderIds.Tmdb` yet, or the TMDB call failed. In that degraded state, `classifyItem` falls through to the existing signals, in order:
1. **Movie**: existing `isChineseOrigin` (ProductionLocations regex) — race-prone, but only reached when TMDB is unavailable.
2. **Series/episode**: character heuristic on `SeriesName`/`OriginalTitle` — **Han present AND no Hiragana/Katakana AND no Hangul** → treat as Chinese (excludes Japanese/Korean). New helper:
   ```ts
   const HAN = /[一-鿿]/, KANA = /[぀-ヿ]/, HANGUL = /[가-힯]/
   export function looksChineseTitle(title: string | null | undefined): boolean {
     return !!title && HAN.test(title) && !KANA.test(title) && !HANGUL.test(title)
   }
   ```
3. Still unknown → **fail-open** (proceed / trigger) — identical to today's default, only in the no-signal degraded mode. Degraded mode is never worse than the current behavior.

### 5. Residual edge (accepted, per user)

The one case not closed by §3: an item scanned when Jellyfin has **not yet assigned any `tmdbId`** (still unidentified). Origin is unresolvable → falls to the ladder; if the ladder is also empty it stays `missing` and may — as today — race a single wasteful download before the next reconcile identifies it and reclassifies `ignored`. This is a narrow window (only truly-unidentified-at-scan items). We **accept** it rather than add a `pending` status (which would ripple through dashboard coverage buckets) — YAGNI. Not worse than today; strictly better for every identified item.

### 6. Mock library fixtures (required to test)

`scripts/gen-mock-library.sh` adds three fixtures with TMDB-matchable filenames:
- **国产剧** (expected `original_language: zh`): `TV/Three-Body (2023)/Season 01/Three-Body (2023) S01E01 1080p.mkv` (Tencent 三体).
- **国产动画** (`zh`): `TV/Scissor Seven (2018)/Season 01/Scissor Seven (2018) S01E01 1080p.mkv` (伍六七).
- **日番负对照** (`ja` — MUST remain triggered): `TV/Attack on Titan (2013)/Season 01/Attack on Titan (2013) S01E01 1080p.mkv`.

The implementer verifies (quick TMDB curl) that these titles resolve to the expected `original_language` and that Jellyfin matches the filenames; adjust titles if a cleaner match exists. Keep all clips the existing 1-second black-video shape.

### 7. Testing

- **Unit** (`tmdb` + `triggers`): `getOriginLanguage` parses `original_language` (mock fetch); `isChineseLang` (zh/cn true, ja/ko/en false); `looksChineseTitle` (英雄→true, 進撃の巨人→false [kana], 오징어 게임→false [hangul], Peacemaker→false).
- **Scanner integration** (`scanner.test.ts`): a Chinese movie with a Tmdb id + injected `getOriginLanguage→'zh'` → `origin_lang` cached + status `ignored`; a `ja` series → episodes stay `missing` (triggered); episode reads series' cached origin (no re-query on second scan — assert the resolver is called once).
- **Fallback**: no-Tmdb-id Chinese movie with `ProductionLocations:['China']` → `ignored` via ladder step 1; no-Tmdb-id Chinese series named 《三体》with no kana → `ignored` via ladder step 2; unknown → `missing`.
- **e2e (mock library, controller)**: after reconcile, Three-Body + Scissor Seven episodes are `ignored` (no jobs, no downloads); Attack on Titan episodes are processed (job created, subtitle hunt runs); `movies.origin_lang`/`series.origin_lang` populated in SQLite.

---

## Out of Scope

- **Remediation of past wrong downloads** (today's e2e 英雄/流浪地球, any 国产 subs on the real NAS). User confirmed 2026-07-11: local subtitles are all dev/test data, deletable, no concern. Prevention only.
- A `pending` status for unidentified-at-scan items (§5 residual accepted).
- Emby/Plex/folder-scanner gate adapters (the "Jellyfin = replaceable gate" insight — future, YAGNI).

## Design Decisions (User Confirmed 2026-07-11)

1. **Signal = TMDB `original_language`** (authoritative, distinguishes zh/ja/ko, early via self-query on tmdbId). Character heuristic + ProductionLocations are fallbacks only.
2. **Placement = scan-time resolve + per-title DB cache (Approach A)** — `classifyItem` stays the single source of status truth; one TMDB call per title, ever.
3. **Accept the narrow unidentified-at-scan residual** rather than add a `pending` status (YAGNI).
4. **Prevention only, no remediation** of already-downloaded subtitles.

**Next:** user reviews this spec → `writing-plans` for the implementation plan (TDD, isolated worktree per implementer, adversarial review). Live e2e on the mock library is the acceptance gate.
