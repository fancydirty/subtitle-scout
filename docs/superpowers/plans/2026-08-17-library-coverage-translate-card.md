# Library coverage + translate rest state Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Poster cards show local subtitle coverage (`字幕 n/onDisk` + green/blue bar), never TMDB missing-episode counts; AI translate settings match the LLM rest state; remove the dead Exclude extras switch.

**Architecture:** Backend adds `uncoveredEpisodeCount = max(0, onDisk - subtitled - embedded)` on `buildMediaLibrary`. Frontend `coverageParts` maps that field; the card renders fraction + decorative bar. `TranslateCard` rest state copies `ProviderCard` (configured badge, test/edit, masked secrets). `exclude_extras` leaves the settings whitelist and UI. `subtitleJudge` rule 0 stays always-on.

**Tech Stack:** TypeScript, vitest, React Testing Library, existing dashboard DTO/contracts.

**Spec:** `docs/superpowers/specs/2026-08-17-library-coverage-translate-card-design.md`

**Hard rules:**
- TDD: failing test first, watch it fail, then implement.
- Do not change `subtitleJudge` rule 0.
- Keep computing and shipping `missingEpisodeCount`; stop rendering it on the poster card.
- Do not add a translate-secret delete UI.
- Do not open production `scout.db`.
- Do not commit `PROJECT_AUDIT_2026.md`, hygiene draft, monitor PNGs, or `.env`.
- `docs/` is gitignored except `docs/design/`; force-add this plan: `git add -f docs/superpowers/plans/2026-08-17-library-coverage-translate-card.md`.
- Commit after each task. Do not push unless asked.

---

## File map

| File | Role |
|---|---|
| `src/dashboard/mediaLibraryApi.ts` | Add `uncoveredEpisodeCount` on DTO + builder |
| `src/dashboard/mediaLibraryApi.test.ts` | Backend coverage cases |
| `web/src/api/types.ts` | DTO field |
| `web/src/api/contracts.ts` | Declare `uncoveredEpisodeCount` |
| `web/src/api/contract.test.ts` + wiring fixtures | New required field |
| `web/src/media/MediaLibraryPage.tsx` | Card B layout |
| `web/src/media/MediaLibraryPage.test.tsx` | Card copy tests |
| `web/src/styles.css` | Coverage bar |
| `web/src/i18n/en.ts` + `zh.ts` | New copy; drop extras labels |
| `web/src/settings/TranslateCard.tsx` + `.test.tsx` | Rest state |
| `web/src/settings/BehaviorSection.tsx` + tests | Remove extras switch |
| `src/dashboard/apiV2.ts` + tests | Drop `exclude_extras` from whitelist |
| `web/src/api/types.ts` `SettingsKey` | Drop `exclude_extras` |
| Fixture settings objects in web/src tests | Drop the key |
| `README.md` | Extras copy no longer gated on the switch |

---

### Task 1: `uncoveredEpisodeCount` on the library builder

**Files:**
- Modify: `src/dashboard/mediaLibraryApi.ts`
- Modify: `src/dashboard/mediaLibraryApi.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('buildMediaLibrary（列表：海报墙）')`:

```ts
describe('uncoveredEpisodeCount（本地集 − 已下载 − 自带，后端夹 0）', () => {
  it('AHS 形：9 green + 11 blue / 20 onDisk → uncovered=0', () => {
    addWork('tmdb:ahs', { title: 'AHS' })
    for (let e = 1; e <= 9; e++) {
      addFile({ path: `/a/s1e${e}.mkv`, workId: 'tmdb:ahs', season: 1, episode: e, subStatus: 'covered' })
    }
    for (let e = 10; e <= 20; e++) {
      addFile({
        path: `/a/s1e${e}.mkv`, workId: 'tmdb:ahs', season: 1, episode: e,
        embeddedLangs: ['zh'],
      })
    }
    const [item] = buildMediaLibrary(db)
    expect(item.onDiskEpisodeCount).toBe(20)
    expect(item.subtitledEpisodeCount).toBe(9)
    expect(item.embeddedEpisodeCount).toBe(11)
    expect(item.uncoveredEpisodeCount).toBe(0)
  })

  it('12 covered + 0 embedded / 30 onDisk → uncovered=18', () => {
    addWork('tmdb:bb', { title: 'BB' })
    for (let e = 1; e <= 30; e++) {
      addFile({
        path: `/b/s1e${e}.mkv`, workId: 'tmdb:bb', season: 1, episode: e,
        subStatus: e <= 12 ? 'covered' : null,
      })
    }
    const [item] = buildMediaLibrary(db)
    expect(item.onDiskEpisodeCount).toBe(30)
    expect(item.subtitledEpisodeCount).toBe(12)
    expect(item.embeddedEpisodeCount).toBe(0)
    expect(item.uncoveredEpisodeCount).toBe(18)
  })

  it('电影 0/1 → uncovered=1；有 sidecar → 0', () => {
    addWork('tmdb:m0', { title: 'Bare', mediaType: 'movie' })
    addFile({ path: '/m/bare.mkv', workId: 'tmdb:m0', season: null, episode: null })
    expect(buildMediaLibrary(db)[0].uncoveredEpisodeCount).toBe(1)

    addWork('tmdb:m1', { title: 'Done', mediaType: 'movie' })
    addFile({ path: '/m/done.mkv', workId: 'tmdb:m1', season: null, episode: null, subStatus: 'covered' })
    expect(buildMediaLibrary(db).find((w) => w.workId === 'tmdb:m1')!.uncoveredEpisodeCount).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify fail**

```bash
npx vitest run src/dashboard/mediaLibraryApi.test.ts
```

Expected: FAIL — `uncoveredEpisodeCount` undefined.

- [ ] **Step 3: Minimal implementation**

On `MediaLibraryItemDTO` add:

```ts
/** 本地格里既无外挂也无自带中字的格数 = max(0, onDisk - subtitled - embedded)。卡片黄字只读这个。 */
uncoveredEpisodeCount: number
```

In `buildMediaLibrary` return, after computing `subtitled` / `embedded` / `onDisk`:

```ts
uncoveredEpisodeCount: Math.max(0, onDisk - subtitled - embedded),
```

- [ ] **Step 4: Re-run tests — pass**

- [ ] **Step 5: Commit** `feat(media-library): expose uncoveredEpisodeCount on poster DTO`

---

### Task 2: Frontend contract + `coverageParts`

**Files:**
- Modify: `web/src/api/types.ts`, `web/src/api/contracts.ts`, `web/src/api/contract.test.ts`
- Modify fixtures that construct `MediaLibraryItemDTO` (`MediaLibraryPage.test.tsx`, `shellWiring.test.tsx`, `contractWiring.test.tsx`, `mediaHooks.test.tsx`, `rootHealthWiring.test.tsx`)
- Modify: `web/src/media/MediaLibraryPage.tsx` (`coverageParts` only this task)

- [ ] **Step 1: Failing contract test**

In `web/src/api/contract.test.ts`, add `uncoveredEpisodeCount` to `ROW` and:

```ts
it('🔴 uncoveredEpisodeCount 缺席 → 拦（缺席会把缺口卡画成全齐）', () => {
  const { uncoveredEpisodeCount: _drop, ...broken } = ROW
  expect(checkShape(broken, MEDIA_LIBRARY_ITEM_SHAPE)?.path).toBe('uncoveredEpisodeCount')
})
```

Add `'uncoveredEpisodeCount'` to the numeric-keys loop if one exists.

- [ ] **Step 2: Run** `npx vitest run web/src/api/contract.test.ts` — FAIL until shape + ROW updated.

- [ ] **Step 3: Declare field**

`MEDIA_LIBRARY_ITEM_SHAPE`: `uncoveredEpisodeCount: num()`.
`MediaLibraryItemDTO`: same comment as backend.
Every test fixture `item({...})` default: `uncoveredEpisodeCount: 0` (or a number consistent with other counts).

`coverageParts`: drop `missing` from the mapped UI object; add `uncovered: item.uncoveredEpisodeCount > 0 ? item.uncoveredEpisodeCount : null`. Keep `missingEpisodeCount` on the DTO type. Update `coverageParts` unit tests: `missing` gone; `uncovered` 0→null, >0 passthrough.

Do **not** change MediaCard JSX yet (Task 3) except what must compile.

- [ ] **Step 4: `npx vitest run web/src/api/contract.test.ts web/src/media/MediaLibraryPage.test.tsx web/src/media/shellWiring.test.tsx web/src/api/contractWiring.test.tsx`**

- [ ] **Step 5: Commit** `feat(web): require uncoveredEpisodeCount on media library rows`

---

### Task 3: Poster card UI (option B)

**Files:**
- Modify: `web/src/media/MediaLibraryPage.tsx`, `web/src/media/MediaLibraryPage.test.tsx`
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/zh.ts`
- Modify: `web/src/styles.css`

i18n (both tables, same keys):

```
media_card_coverage: 'Subtitles' / '字幕'
media_card_downloaded: 'Downloaded' / '已下载'
media_card_embedded: keep meaning, shorten zh to '自带' if current is '自带字幕'
media_card_uncovered: 'Need subtitles for' / '还有'
media_card_uncovered_unit: 'episodes' / '集没字幕'
media_card_uncovered_movie: 'No subtitles yet' / '还没字幕'
```

Stop using `media_card_missing` / `media_card_ondisk` on the card (keys may remain unused until a later sweep — do not leave them referenced).

- [ ] **Step 1: Replace the 🟡-3 tests in `MediaLibraryPage.test.tsx`**

English `I18nProvider` (existing file uses `en`):

- Full cover: `subtitled=9, embedded=11, onDisk=20, uncovered=0` → text contains `9` and `11` and `20/20` (via `en.media_card_coverage`); **not** `en.media_card_missing`; no `media-card-missing` testid.
- Gap: `subtitled=12, embedded=0, onDisk=30, uncovered=18` → `12/30`, amber `media-card-uncovered` contains `18`.
- Movie gap: `mediaType:'movie', onDisk=1, subtitled=0, uncovered=1` → `en.media_card_uncovered_movie`, uncovered line does **not** contain `en.media_card_uncovered_unit`.
- Unplaced still its own testid.
- `coverageParts` uncovered mapping tests.

- [ ] **Step 2: Run — FAIL** (old missing line still there).

- [ ] **Step 3: Implement MediaCard**

Structure:

```tsx
const covered = subtitled + (embedded ?? 0)
// uncovered from coverageParts only — do not compute  onDisk - covered
<span data-testid="media-card-stats">
  <span className={uncovered === null ? 'media-card-frac media-card-frac-done' : 'media-card-frac'}>
    {t('media_card_coverage')} {covered}/{onDisk}
  </span>
</span>
{onDisk > 0 && (
  <span className="media-card-bar" aria-hidden="true">
    <i className="media-card-bar-g" style={{ width: `${(subtitled / onDisk) * 100}%` }} />
    {embedded !== null && (
      <i className="media-card-bar-b" style={{ width: `${(embedded / onDisk) * 100}%` }} />
    )}
  </span>
)}
<span className="media-card-stats">
  <span className="media-card-stat">{t('media_card_downloaded')} {subtitled}</span>
  {embedded !== null ? <span className="media-card-stat">· {t('media_card_embedded')} {embedded}</span> : null}
</span>
{uncovered !== null && (
  <span className="media-card-missing" data-testid="media-card-uncovered">
    {item.mediaType === 'movie'
      ? t('media_card_uncovered_movie')
      : `${t('media_card_uncovered')} ${uncovered} ${t('media_card_uncovered_unit')}`}
  </span>
)}
```

`coverageParts` must pass `mediaType` through or MediaCard reads `item.mediaType` for the movie string.

CSS: 3px flex bar, track `rgba(255,255,255,.08)`, `.media-card-bar-g` `--color-fn-green`, `.media-card-bar-b` `--color-fn-blue`. No `role="progressbar"`.

**Allowed sum:** `subtitled + embedded` for the fraction numerator (DTO comments already guarantee disjoint dots). **Forbidden:** `expected - onDisk` or `onDisk - subtitled - embedded` in the browser.

- [ ] **Step 4: Run MediaLibraryPage tests + `web/src/i18n` key-parity test**

- [ ] **Step 5: Commit** `feat(web): show local subtitle coverage on library cards`

---

### Task 4: TranslateCard rest state

**Files:**
- Modify: `web/src/settings/TranslateCard.tsx`, `web/src/settings/TranslateCard.test.tsx`
- Modify: `web/src/i18n/en.ts`, `zh.ts` (`settings_translate_creds_saved`)
- Tests that assume always-visible required inputs (`localizedChrome.test.tsx` / `humanLabels.test.tsx`) — update to incomplete-secrets fixtures.

Reuse `ProviderCard` patterns: `SettingsCard status`, Test/Edit buttons, `ProviderSecretField`-style masked rows, `api.validateSetup(row.id)` without drafts on Test, save only non-empty drafts.

- [ ] **Step 1: Rewrite tests first** (replace tests that require empty dedicated fields when secrets are set)

Must include:

1. Toggle on/off → only `updateSettings({ ai_translate_enabled })`, `putSecret` not called.
2. Three secrets `set: true`, `source: 'db'`, switch on → `getByText` configured badge; **no** `required` inputs; queryByText all-fields-required **null**; Test and Edit present.
3. Same secrets, switch off → saved copy `settings_translate_creds_saved`; no required inputs.
4. Switch off then on (mock update returning enabled true) → still no required inputs.
5. Edit + empty drafts → Save does not `putSecret` empty keys (click Save with no typing → putSecret times 0, or only typed keys).
6. Incomplete + switch on → three fields; Save still validate-then-put when all filled.

- [ ] **Step 2: Run TranslateCard tests — FAIL**

- [ ] **Step 3: Implement states from spec §4**

`isDedicated` = all three `.set`.
`allFilled` for incomplete save: each field `(drafts[n] ?? '').trim() !== '' || secretMap[n]?.set`.
On save dedicated: `credentials` object only includes non-empty drafts; `validateSetup('translate', credentials)`; `putSecret` only those keys.
Remove `allEnv` readonly branch.
`fieldError` only when incomplete setup, not when dedicated rest state.
Off + dedicated: one muted line, no form.
Test: `api.validateSetup('translate')` then `reload()`.

- [ ] **Step 4: Pass TranslateCard + related settings tests**

- [ ] **Step 5: Commit** `fix(settings): show translate credentials as configured rest state`

---

### Task 5: Remove dead `exclude_extras` switch

**Files:**
- Modify: `web/src/settings/BehaviorSection.tsx` (delete `ExcludeExtrasRow` and its render)
- Modify: `web/src/settings/BehaviorSection.test.tsx` (no Exclude extras switch; `"Takes effect on the next library scan."` count becomes 1 if scan interval still uses that string — **assert the extras switch is absent**, then fix the remaining note count to whatever is true)
- Modify: `src/dashboard/apiV2.ts` — drop key from `SETTINGS_KEYS` and `SETTINGS_VALUE_SCHEMAS`
- Modify: `src/dashboard/apiV2.test.ts` — expected GET objects without the key; add PUT `{ exclude_extras: 'true' }` → 400
- Modify: `web/src/api/types.ts` `SettingsKey`
- Modify every `exclude_extras: null` fixture listed in grep (web App/shell/EngineRow tests, `src/dashboard/server.test.ts`, `router.test.ts`)
- Modify: `README.md` extras bullet: mechanical extras are always skipped by judge; no settings switch.

Do **not** change `subtitleJudge.ts`.

- [ ] **Step 1: Failing tests**

BehaviorSection: `queryByRole('switch', { name: 'Exclude extras' })` → null.
apiV2: PUT extras → 400 (write this test before removing the schema so you watch it fail when you remove the key — or remove key first and write PUT 400; TDD: write PUT 400 expecting 400 while schema still accepts it would fail the wrong way. Order: add test `expect(screen.queryByRole(...Exclude extras...)).toBeNull()` first while switch still exists → FAIL. Then remove UI. Then add apiV2 PUT 400 test, remove from whitelist, make it pass.)

- [ ] **Step 2–4:** Remove UI, whitelist, fixtures, README. Run:

```bash
npx vitest run web/src/settings/BehaviorSection.test.tsx src/dashboard/apiV2.test.ts src/dashboard/server.test.ts src/v2/subtitleJudge.test.ts
```

Judge extras tests still pass.

- [ ] **Step 5: Commit** `fix(settings): remove dead exclude-extras switch`

---

### Task 6: Full suite

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
# plus web tsc if the repo uses a separate web tsconfig
```

Fix fallout. Commit only if something remains uncommitted.

---

## Spec coverage

| Spec | Task |
|---|---|
| §3 poster coverage B | 1–3 |
| §3.4 contract declares uncovered | 2 |
| §4 translate rest state + toggle | 4 |
| §4.5 dead extras switch | 5 |
| Judge rule 0 unchanged | 5 (explicit non-edit) |
