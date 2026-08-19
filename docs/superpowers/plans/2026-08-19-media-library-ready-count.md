# Media Library Ready Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the media-library poster cards report a truthful, conserved ready count by separating downloaded, built-in, and origin-language episodes.

**Architecture:** Keep the existing backend `aggregateDot` and `aggregateState` as the single per-cell evidence sources. `buildMediaLibrary` will derive mutually exclusive list counters from those aggregates and return `readyEpisodeCount` plus `originLanguageEpisodeCount`; the React card will render those DTO values without recomputing them.

**Tech Stack:** TypeScript, Vitest, React, Testing Library, existing API shape validator, existing CSS/i18n tokens.

---

### Task 1: Lock the backend counter contract with RED tests

**Files:**
- Modify: `src/dashboard/mediaLibraryApi.test.ts`
- Modify: `src/dashboard/router.test.ts`

- [ ] **Step 1: Add production-shaped backend counter tests**

Add a test group beside the existing target-language tests. Seed numbered files with `needsSubtitle: 0`, `skipReason: 'origin-skip'`, and the requested embedded-language arrays. Assert the exact DTO partition:

```ts
expect(item).toMatchObject({
  onDiskEpisodeCount: 16,
  subtitledEpisodeCount: 0,
  embeddedEpisodeCount: 0,
  originLanguageEpisodeCount: 16,
  readyEpisodeCount: 16,
  uncoveredEpisodeCount: 0,
})
expect(item.readyEpisodeCount + item.uncoveredEpisodeCount).toBe(item.onDiskEpisodeCount)
```

Add equivalent 7 embedded + 1 origin-native and 8 embedded + 8 origin-native cases. Assert that an embedded target track wins the display bucket over `origin-skip`, so a row with `skip_reason='origin-skip'` and `embedded_langs=['eng']` contributes to `embeddedEpisodeCount`, not `originLanguageEpisodeCount`.

- [ ] **Step 2: Extend the router fixture type immediately so RED is isolated to behavior**

Add `readyEpisodeCount` and `originLanguageEpisodeCount` to `mediaLibraryItem` in `src/dashboard/router.test.ts`, with values that conserve against its existing `onDiskEpisodeCount`.

- [ ] **Step 3: Run the focused backend test and verify RED**

Run:

```bash
npx vitest run src/dashboard/mediaLibraryApi.test.ts
```

Expected: the new assertions fail because the DTO does not yet contain the two new fields.

### Task 2: Implement the backend partition and DTO

**Files:**
- Modify: `src/dashboard/mediaLibraryApi.ts:508-572, 674-710`

- [ ] **Step 1: Add the two numeric DTO fields**

Add `readyEpisodeCount` and `originLanguageEpisodeCount` beside the existing coverage counters. Document that native-language cells are only counted when the aggregate dot is `none`; this prevents overlap with sidecar or embedded buckets.

- [ ] **Step 2: Derive one aggregate object per local cell**

Replace the separate `dots` and `states` passes with one `aggregates` array:

```ts
const aggregates = [...cells.values()].map((rows) => aggregateDot(rows, targetLanguage))
const subtitled = aggregates.filter((a) => a.dot === 'green').length
const embedded = aggregates.filter((a) => a.dot === 'blue').length
const originLanguage = aggregates.filter(
  (a) => a.dot === 'none' && a.episodeState === 'origin-skip',
).length
const ready = subtitled + embedded + originLanguage
```

Keep the existing `extra` handling unchanged for this task; do not reclassify numbered extras or change the detail-page state model.

- [ ] **Step 3: Return conserved counters**

Return `readyEpisodeCount: ready`, `originLanguageEpisodeCount: originLanguage`, and compute `uncoveredEpisodeCount` from `Math.max(0, onDisk - ready)`. Preserve the existing downloaded and embedded semantics.

- [ ] **Step 4: Run the focused backend tests and verify GREEN**

Run:

```bash
npx vitest run src/dashboard/mediaLibraryApi.test.ts src/dashboard/router.test.ts
```

Expected: all focused backend tests pass, including the existing AHS, target-language, movie, duplicate-directory, and extra regressions.

### Task 3: Lock the frontend contract and card rendering with RED tests

**Files:**
- Modify: `web/src/media/MediaLibraryPage.test.tsx`
- Modify: `web/src/media/mediaTitle.i18n.test.tsx`
- Modify: `web/src/api/contract.test.ts`

- [ ] **Step 1: Add new fields to frontend test fixtures**

Update `item()` and `libItem()` defaults with conserved `readyEpisodeCount` and `originLanguageEpisodeCount` values.

- [ ] **Step 2: Add rendering tests for the approved model**

Add a test with `ready=16`, `onDisk=16`, `subtitled=0`, `embedded=0`, and `originLanguage=16`. Assert the card shows `Ready 16/16`, `Downloaded 0`, `Native 16`, and no uncovered warning. Add a mixed test with `ready=8`, `embedded=7`, `originLanguage=1`; assert both labels render and the built-in count remains 7.

Assert that `coverageParts` returns `ready` and `originLanguage` exactly from the DTO, rather than calculating `subtitled + embedded` in the browser.

- [ ] **Step 3: Add API-shape RED coverage for missing fields**

Extend the shape-contract test's required numeric-field list with `readyEpisodeCount` and `originLanguageEpisodeCount`, and add each field to the broken-object loop. The test must fail before the shape is updated.

- [ ] **Step 4: Run focused web tests and verify RED**

Run:

```bash
cd web && npx vitest run src/media/MediaLibraryPage.test.tsx src/media/mediaTitle.i18n.test.tsx src/api/contract.test.ts
```

Expected: the new rendering and shape assertions fail because the frontend DTO and card still use the old numerator.

### Task 4: Implement frontend DTO, i18n, and visual segments

**Files:**
- Modify: `web/src/api/types.ts:474-510`
- Modify: `web/src/api/contracts.ts:102-117`
- Modify: `web/src/media/MediaLibraryPage.tsx:65-159`
- Modify: `web/src/i18n/zh.ts:395-410`
- Modify: `web/src/i18n/en.ts:461-479`
- Modify: `web/src/styles.css:2331-2345`

- [ ] **Step 1: Add the two required frontend DTO fields and shape fields**

Declare both counters as numbers in `MediaLibraryItemDTO` and require both in `MEDIA_LIBRARY_ITEM_SHAPE` alongside the existing arithmetic fields.

- [ ] **Step 2: Make `coverageParts` pass through backend values**

Return `ready: item.readyEpisodeCount` and `originLanguage: item.originLanguageEpisodeCount > 0 ? item.originLanguageEpisodeCount : null`. Keep `subtitled`, `embedded`, `onDisk`, `uncovered`, `missing`, and `unplaced` unchanged.

- [ ] **Step 3: Render the conserved numerator and native statistic**

Use `ready` for the fraction. Keep the downloaded and built-in spans, add a conditional native span, and do not calculate a numerator from the other counters.

- [ ] **Step 4: Add the third bar segment**

Render a native segment only when `originLanguage !== null`; add `.media-card-bar-n` using `var(--color-muted-foreground)`, the exact neutral token already used for `origin-skip` in the detail styles. Keep widths based on the backend counters and guard the entire bar with `onDisk > 0`.

- [ ] **Step 5: Update labels**

Change the coverage label to `就绪` / `Ready` and add `原生` / `Native`. Do not rename `已下载` / `Downloaded` or `自带` / `Built-in`.

- [ ] **Step 6: Run focused web tests and verify GREEN**

Run:

```bash
cd web && npx vitest run src/media/MediaLibraryPage.test.tsx src/media/mediaTitle.i18n.test.tsx src/api/contract.test.ts
```

Expected: all focused web tests pass.

### Task 5: Full verification and production rollout

**Files:**
- No additional source files expected.

- [ ] **Step 1: Run all checks**

Run:

```bash
npx vitest run
npm run check
cd web && npx vitest run
npm run check
```

Expected: root tests and checks pass; web tests and web TypeScript check pass.

- [ ] **Step 2: Review the diff and commit the implementation branch**

Create branch `fix/media-library-ready-count`, inspect `git diff` and `git status`, then commit only the listed source and test files with:

```bash
git status --short
git diff -- src/dashboard/mediaLibraryApi.ts src/dashboard/mediaLibraryApi.test.ts src/dashboard/router.test.ts web/src/api/types.ts web/src/api/contracts.ts web/src/media/MediaLibraryPage.tsx web/src/media/MediaLibraryPage.test.tsx web/src/media/mediaTitle.i18n.test.tsx web/src/api/contract.test.ts web/src/i18n/zh.ts web/src/i18n/en.ts web/src/styles.css
git add src/dashboard/mediaLibraryApi.ts src/dashboard/mediaLibraryApi.test.ts src/dashboard/router.test.ts web/src/api/types.ts web/src/api/contracts.ts web/src/media/MediaLibraryPage.tsx web/src/media/MediaLibraryPage.test.tsx web/src/media/mediaTitle.i18n.test.tsx web/src/api/contract.test.ts web/src/i18n/zh.ts web/src/i18n/en.ts web/src/styles.css
git commit -m "fix(dashboard): expose native-language episodes in media coverage counts"
```

- [ ] **Step 3: Merge and deploy**

Merge with `--no-ff` into `main`, then run:

```bash
DEPLOY_SSH_HOST=media-router-wan bash deploy/deploy.sh
```

- [ ] **Step 4: Verify production JSON and conservation**

Fetch `/api/v2/mediaLibrary` with the production API key and verify:

```text
Young Sheldon: ready 16/16, downloaded 0, built-in 0, native 16, uncovered 0
IT: Welcome to Derry: ready 8/8, downloaded 0, built-in 7, native 1, uncovered 0
Peacemaker: ready 16/16, downloaded 0, built-in 8, native 8, uncovered 0
Invasion: ready 30/30, downloaded 0, built-in 30, native 0, uncovered 0
```

For every row, assert `readyEpisodeCount + uncoveredEpisodeCount === onDiskEpisodeCount` and compare the native/embedded split against the detail endpoint's `episodeState` and `dot` values.
