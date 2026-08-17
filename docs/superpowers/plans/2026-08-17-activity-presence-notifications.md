# Activity presence + notifications + library refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Running card shows file-level progress, human steps, TMDB 16:9 mask bleed, and i18n chrome; queue drops the in-flight work; notifications auto-reload with artwork; media library refreshes after install.

**Architecture:** `ScoutCurrent` carries identity + lastStep in `/health`. Daemon emits file-granularity `progress` and bridges `traceBus.tool` into `data.step` on the existing `/api/v2/events` SSE. Frontend maps step ids through i18n, filters `current.workId` out of the queue, and reloads media/notifications from GET on `found` / current-cleared. CSS: `mask-image` on the run card; queue fade px-only.

**Tech Stack:** TypeScript, vitest, React Testing Library, existing ScoutEventBus / traceBus / dashboard SSE.

**Spec:** `docs/superpowers/specs/2026-08-17-activity-presence-notifications-design.md`

**Hard rules:**
- TDD: failing test first, watch it fail, then implement.
- Do not open production `~/.subtitle-scout/cache/scout.db`.
- Do not resurrect Workflow page or subscribe `/api/v2/workflow/trace-stream` from Activity.
- Do not add a second user SSE. Do not render `event.message` or raw CoT on run/notification cards.
- Do not write `covered` from `markInstalled` (R24).
- Do not change `PROGRESS_THROTTLE_MS`. `updateCurrent` stays before the throttle gate.
- Do not add interpolation to `t()`.
- Do not commit `PROJECT_AUDIT_2026.md`, hygiene draft, monitor PNGs, `.env`, or `.cursor/`.
- `docs/` is gitignored except `docs/design/`; force-add only this spec/plan if committing docs.
- After each task: `git commit` on `main`. Do not push.

---

## File map

| File | Role |
|---|---|
| `src/core/scoutEvents.ts` | `ScoutCurrent` new fields; `updateCurrent` copy/retain rules |
| `src/core/scoutEvents.test.ts` | Snapshot tests; helper for full current shape |
| `web/src/api/types.ts` | `ScoutCurrentDTO`, `ActivityQueueItemDTO.awaitingRescan`, `FoundGroupDTO` art fields |
| `src/v2/subtitleScheduler.ts` | `backdropPath` + `subRecheckAt` on queue files; optional `onInstalled` tick |
| `src/v2/daemonV2.ts` | File-level progress; `requestScan` after subtitle found; trace→progress bridge |
| `src/v2/daemonV2.events.test.ts` | 0/N then 1/N; requestScan; step bridge + unsubscribe |
| `src/dashboard/activityApi.ts` | `awaitingRescan` projection |
| `src/v2/notificationsRepo.ts` | Join `chineseTitle` + `backdropPath` onto `FoundGroup` |
| `web/src/i18n/en.ts` / `zh.ts` | New chrome keys |
| `web/src/workbench/stepPhrase.ts` | Closed tool→key map |
| `web/src/workbench/displayTitle.ts` | lang-aware title |
| `web/src/workbench/WorkbenchCards.tsx` | RunCard: bar, steps, log, mask layout |
| `web/src/workbench/ActivityPage.tsx` | Queue filter; wire new RunCard props |
| `web/src/styles.css` | mask-image; queue fade px; legend width |
| `web/src/notifications/*` | Auto-reload; hero card |
| `web/src/api/hooks.ts` | Media reload on found + current→null |

---

### Task 1: ScoutCurrent snapshot fields

**Files:**
- Modify: `src/core/scoutEvents.ts` (`ScoutCurrent`, `updateCurrent`)
- Modify: `src/core/scoutEvents.test.ts`
- Modify: `web/src/api/types.ts` (`ScoutCurrentDTO`)

- [ ] **Step 1: Write the failing tests**

In `src/core/scoutEvents.test.ts`, add a helper used by new tests AND replace existing `toEqual({ kind, title, index, total })` objects (they will fail until implementation, then must include the new keys or they stay red):

```ts
import type { ScoutCurrent } from './scoutEvents.js'

function cur(p: Partial<ScoutCurrent> & Pick<ScoutCurrent, 'kind'>): ScoutCurrent {
  return {
    title: null, index: null, total: null,
    workId: null, backdropPath: null, chineseTitle: null,
    startedAt: null, lastStep: null,
    ...p,
  }
}
```

Add (keep existing describe block):

```ts
it('🔴 activity 写入 workId/backdropPath/chineseTitle/startedAt，lastStep 为 null', () => {
  const { bus, at } = mkBus()
  bus.publish({
    type: 'activity', message: 'a', title: '甲剧', workbench: 'subtitle',
    data: { workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '黑暗智宅' },
  })
  expect(bus.getCurrent()).toEqual(cur({
    kind: 'subtitle', title: '甲剧',
    workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '黑暗智宅',
    startedAt: at(),
  }))
})

it('🔴 progress 更新 done/total 与 lastStep；静态字段缺席时保留', () => {
  const { bus, tick } = mkBus()
  bus.publish({
    type: 'activity', message: 'a', title: '甲剧', workbench: 'subtitle',
    data: { workId: 'tmdb:1', backdropPath: '/bd.jpg', chineseTitle: '中文' },
  })
  tick(PROGRESS_THROTTLE_MS)
  bus.publish({
    type: 'progress', message: 'p', title: '甲剧', workbench: 'subtitle',
    data: { done: 2, total: 6, step: 'search_source' },
  })
  const snap = bus.getCurrent()
  expect(snap?.index).toBe(2)
  expect(snap?.total).toBe(6)
  expect(snap?.workId).toBe('tmdb:1')
  expect(snap?.backdropPath).toBe('/bd.jpg')
  expect(snap?.chineseTitle).toBe('中文')
  expect(snap?.lastStep).toBe('search_source')
})

it('🔴 被节流折叠的 progress 仍更新 lastStep（快照在节流门前）', () => {
  const { bus } = mkBus()
  bus.publish({ type: 'progress', message: '1', workbench: 'subtitle', data: { done: 0, total: 6, step: 'search_source' } })
  bus.publish({ type: 'progress', message: '2', workbench: 'subtitle', data: { done: 0, total: 6, step: 'download_candidate' } })
  expect(bus.getCurrent()?.lastStep).toBe('download_candidate')
})

it('🔴 无 workbench 的 activity 清空含新字段的整个 current', () => {
  const { bus } = mkBus()
  bus.publish({ type: 'activity', message: 'a', title: '甲', workbench: 'subtitle', data: { workId: 'tmdb:1' } })
  bus.publish({ type: 'activity', message: '巡检完成' })
  expect(bus.getCurrent()).toBeNull()
})
```

Rewrite every existing `toEqual({ kind: …, title: …, index: …, total: … })` in this file to `cur({…})`, and for activity-driven cases set `startedAt: at()` (default mkBus start is `1_000_000`). Progress-only cases keep `startedAt: null`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/scoutEvents.test.ts`

Expected: FAIL — `ScoutCurrent` missing new keys and/or `toEqual` extra properties.

- [ ] **Step 3: Minimal implementation**

Extend `ScoutCurrent` with `workId`, `backdropPath`, `chineseTitle`, `startedAt`, `lastStep` — all `string | number | null` as spec, **not optional**.

Helpers inside `updateCurrent`:

```ts
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
```

- `activity` + workbench: new object; extras from `data`; `startedAt = this.nowFn()`; `lastStep = null`; `index/total = null`.
- `progress` + workbench: `same = this.current?.kind === input.workbench`; retain extras only when `same`; `lastStep = str(d?.step) ?? (same ? this.current.lastStep : null)`; `startedAt` retain only when `same`.
- Empty string / non-string `data` fields → `null`, never `Number()` coerce.

Mirror fields onto `ScoutCurrentDTO` in `web/src/api/types.ts` (all `| null`). `C_ScoutCurrentDTO` should keep compiling (backend extends frontend).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/scoutEvents.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/scoutEvents.ts src/core/scoutEvents.test.ts web/src/api/types.ts
git commit -m "$(cat <<'EOF'
feat(events): carry workId, artwork, lastStep on ScoutCurrent

Reconnect and the running card need identity and the latest tool id
even when progress SSE is throttled.
EOF
)"
```

---

### Task 2: File-level progress + subtitle requestScan

**Files:**
- Modify: `src/v2/subtitleScheduler.ts` (SELECT `w.backdrop_path`, `f.sub_recheck_at`; `onProgress` after each `markInstalled`)
- Modify: `src/v2/daemonV2.ts` (emit `0/N` then ticks; `requestScan` on subtitle found)
- Modify: `src/v2/daemonV2.events.test.ts`
- Modify: `src/v2/translate` path in `daemonV2.ts` `advanceTranslateOnce` (`0/1` then `1/1` on installed)

- [ ] **Step 1: Write the failing tests**

In `src/v2/daemonV2.events.test.ts` (reuse `runOneInspection` / `seedSubtitleWork` / `mkEmit`):

```ts
it('🔴 单作品多文件：progress 是 0/N 起跳，不是作品队列 1/1', async () => {
  const db = openDb(':memory:')
  seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
  seedSubtitleWork(db, '/media/Show/E02.mkv', 2) // same workId tmdb:42 — follow existing seed helper; if it creates a new work, insert a second file on the same work_id instead
  const { emit, got } = mkEmit()
  await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
    emit, roots: ['/media'],
    listVideoFiles: () => ['/media/Show/E01.mkv', '/media/Show/E02.mkv'],
    statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
  })))
  const subProg = got.filter((e) => e.type === 'progress' && e.workbench === 'subtitle')
  expect(subProg[0]?.data).toMatchObject({ done: 0, total: 2 })
  expect(subProg.some((e) => e.data?.done === 1 && e.data?.total === 1)).toBe(false)
  db.close()
})
```

If `seedSubtitleWork` cannot attach two files to one work, open the helper and insert the second `files` row with the same `work_id` in the test (do not change production seed semantics globally unless the helper already supports it).

```ts
it('🔴 字幕装上了 → requestScan 被调用（与翻译 installed 同型）', async () => {
  // Drive a path where report.installed.length > 0 (existing found-event test fixture).
  // Spy: wrap daemon.requestScan or observe the scan flag / listVideoFiles called again.
  // If the existing found test already runs a real worker, assert a scanOnce side effect
  // the same way translateWorkerTask.test.ts asserts requestScan.
})
```

Also assert activity/progress `data` includes `backdropPath` when `works.backdrop_path` is set.

Translate: unit-level on `advanceTranslateOnce` is heavy; if no cheap harness, add a focused test next to the existing translate emit test: first translate progress `done: 0, total: 1`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/v2/daemonV2.events.test.ts`

Expected: FAIL — first subtitle progress is `1/1` (queue index) or missing `0/N`.

- [ ] **Step 3: Minimal implementation**

`listSubtitleQueue` SELECT add `w.backdrop_path`, `f.sub_recheck_at`. Put `backdropPath` on `SubtitleQueueItem`. Put `subRecheckAt: number | null` on each file.

`runSubtitleWorkDir`: add optional `onFileInstalled?: (done: number, total: number) => void`, call after each successful `markInstalled` with cumulative count and `item.files.length`.

`daemonV2` subtitle loop:

```ts
const total = item.files.length
const face = {
  workId: item.workId,
  backdropPath: item.backdropPath ?? null,
  chineseTitle: item.chineseTitles[0] ?? null,
}
this.emit({ type: 'activity', …, data: { ...face } })
this.emit({ type: 'progress', message: `0/${total}`, workbench: 'subtitle',
  data: { done: 0, total, ...face } })
await runSubtitleWorkDir(..., {
  onFileInstalled: (done, tot) => this.emit({
    type: 'progress', message: `${done}/${tot}`, workbench: 'subtitle',
    data: { done, total: tot, ...face },
  }),
})
```

**Delete** the emit that used `subtitleRounds / subtitleQueue.length` as `done/total`.

After subtitle `found` (`report.installed.length > 0`): `this.requestScan()`.

Translate `advanceTranslateOnce`: emit progress `{ done: 0, total: 1, workId }` with activity; on `status === 'installed'` emit `{ done: 1, total: 1, workId }` (in addition to existing found + requestScan).

Identify progress stays queue-index (out of spec).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/v2/daemonV2.events.test.ts src/v2/subtitleScheduler.test.ts src/v2/translateWorkerTask.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/v2/subtitleScheduler.ts src/v2/daemonV2.ts src/v2/daemonV2.events.test.ts src/v2/subtitleScheduler.test.ts
git commit -m "$(cat <<'EOF'
fix(daemon): emit per-file subtitle progress and scan after install

1/1 was the inspect work index; the running card needs 0/N file ticks
and a scan so coverage can leave pending.
EOF
)"
```

---

### Task 3: traceBus → progress `data.step` + unsubscribe

**Files:**
- Modify: `src/v2/daemonV2.ts` (subscribe around subtitle/translate runner)
- Modify: `src/v2/daemonV2.events.test.ts` or new `src/v2/daemonV2.traceBridge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('🔴 飞行中 trace.tool 出现在 progress.data.step；finally 后退订，下一部不串步', async () => {
  const db = openDb(':memory:')
  seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
  const { emit, got } = mkEmit()
  const daemon = new ScoutDaemonV2(mkDeps(db, {
    emit, roots: ['/media'],
    listVideoFiles: () => ['/media/Show/E01.mkv'],
    statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
  }))
  const run = runOneInspection(daemon)
  // During the worker (or via a stub worker that publishes then returns):
  const runKey = `job-${subtitleJobId('tmdb:42')}`
  traceBus.publish({
    runKey, seq: 1, tool: 'search_source',
    argsSummary: '{}', resultSummary: '', tookMs: 1, at: Date.now(),
  })
  await run
  expect(got.some((e) => e.type === 'progress' && e.data?.step === 'search_source')).toBe(true)

  got.length = 0
  traceBus.publish({
    runKey, seq: 2, tool: 'install_subtitle',
    argsSummary: '{}', resultSummary: '', tookMs: 1, at: Date.now(),
  })
  expect(got.some((e) => e.data?.step === 'install_subtitle')).toBe(false)
  db.close()
})
```

If the real worker is too slow/unwired in this harness, inject a `subtitleWorker` mock that publishes one trace event then resolves an empty report — follow existing daemon test doubles.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/v2/daemonV2.events.test.ts`

Expected: FAIL — no `data.step`.

- [ ] **Step 3: Minimal implementation**

Around `runSubtitleWorkDir` / translate `runItem`:

```ts
const runKey = `job-${jobId}`
let done = 0
const total = item.files.length
const unsub = traceBus.subscribe((e) => {
  if (e.runKey !== runKey) return
  this.emit({
    type: 'progress',
    message: e.tool,
    title: item.title,
    workbench: 'subtitle',
    data: { done, total, workId: item.workId, step: e.tool },
  })
})
try {
  await runSubtitleWorkDir(..., {
    onFileInstalled: (d, t) => { done = d; this.emit(...) },
  })
} finally {
  unsub()
}
```

Same pattern for translate with `total = 1`, `runKey = job-${translateJobId(...)}`.

Do not subscribe globally for the daemon lifetime.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/v2/daemonV2.events.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/v2/daemonV2.ts src/v2/daemonV2.events.test.ts
git commit -m "$(cat <<'EOF'
feat(daemon): bridge in-flight trace tools onto progress SSE

Activity stays on one SSE; lastStep and the rolling log read data.step.
EOF
)"
```

---

### Task 4: `awaitingRescan` on activity queue

**Files:**
- Modify: `src/dashboard/activityApi.ts` (+ `ActivityQueueItemDTO`)
- Modify: `web/src/api/types.ts`
- Modify: `src/dashboard/activityApi.test.ts`

- [ ] **Step 1: Write the failing test**

Seed a subtitle queue row with `sub_recheck_at = 0` and `recheck_after = now + DAY` (post-`markInstalled` shape). `includeBackoff: true` list via `buildActivity` (or whatever the module exports — `getActivity` / `buildActivityDTO`).

```ts
it('🔴 markInstalled 哨兵 → awaitingRescan true（不是普通退避）', () => {
  // insert file needs_subtitle=1, sub_status NULL, sub_recheck_at=0, recheck_after=now+86400000
  const dto = buildActivity(db, { now })
  expect(dto.subtitleQueue[0]?.awaitingRescan).toBe(true)
})

it('bump 退避（sub_recheck_at 非 0）→ awaitingRescan false', () => {
  // recheck_after future, sub_recheck_at NULL or now+7d
  expect(dto.subtitleQueue[0]?.awaitingRescan).toBe(false)
})

it('translateQueue 每项 awaitingRescan === false 且字段存在', () => {
  expect(dto.translateQueue.every((x) => x.awaitingRescan === false)).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dashboard/activityApi.test.ts`

Expected: FAIL — field missing.

- [ ] **Step 3: Minimal implementation**

`awaitingRescan` = subtitle cluster files length > 0 and every file `subRecheckAt === 0`. Translate projection: always `false`. JSON key always present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/dashboard/activityApi.test.ts`

Expected: PASS. Also `cd web && npx tsc --noEmit` if `C_ActivityQueueItemDTO` complains — add the field to the frontend DTO in this task.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/activityApi.ts src/dashboard/activityApi.test.ts web/src/api/types.ts
git commit -m "$(cat <<'EOF'
feat(activity): flag queues awaiting rescan after install

sub_recheck_at=0 is the install sentinel, not a failed retry window.
EOF
)"
```

---

### Task 5: i18n keys + step map + displayTitle

**Files:**
- Create: `web/src/workbench/stepPhrase.ts`
- Create: `web/src/workbench/stepPhrase.test.ts`
- Create: `web/src/workbench/displayTitle.ts`
- Create: `web/src/workbench/displayTitle.test.ts`
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/zh.ts`

- [ ] **Step 1: Write the failing tests**

`stepPhrase.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stepPhraseKey } from './stepPhrase.js'

it('maps search_source → wb_step_search', () => {
  expect(stepPhraseKey('search_source')).toBe('wb_step_search')
})
it('maps install_sidecar → wb_step_install', () => {
  expect(stepPhraseKey('install_sidecar')).toBe('wb_step_install')
})
it('unknown → wb_step_working', () => {
  expect(stepPhraseKey('update_row')).toBe('wb_step_working')
  expect(stepPhraseKey('not_a_tool')).toBe('wb_step_working')
})
```

`displayTitle.test.ts`:

```ts
import { displayTitle } from './displayTitle.js'
it('zh prefers chineseTitle', () => {
  expect(displayTitle('zh', 'Cassandra', '黑暗智宅')).toBe('黑暗智宅')
})
it('en uses original title', () => {
  expect(displayTitle('en', 'Cassandra', '黑暗智宅')).toBe('Cassandra')
})
it('zh falls back to title', () => {
  expect(displayTitle('zh', 'Cassandra', null)).toBe('Cassandra')
})
```

Add keys from spec §10.1 to **en.ts only first** so `i18n.test.ts` parity fails until zh is filled (that's the existing discipline). Include zh in the same task after watching parity fail, or add both then rely on stepPhrase tests as the red.

Preferred: add keys to both tables in Step 3; Step 1 tests import `stepPhraseKey` which does not exist → fail.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/workbench/stepPhrase.test.ts web/src/workbench/displayTitle.test.ts`

Expected: FAIL — modules missing.

- [ ] **Step 3: Minimal implementation**

Closed `Record`/if-chain per spec §10.1. `stepPhraseKey` return type `TKey` or the union of those keys.

`displayTitle(lang, title, chineseTitle)`.

Add every spec §10.1 key to `en.ts` and `zh.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/workbench/stepPhrase.test.ts web/src/workbench/displayTitle.test.ts web/src/i18n/i18n.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/workbench/stepPhrase.ts web/src/workbench/stepPhrase.test.ts web/src/workbench/displayTitle.ts web/src/workbench/displayTitle.test.ts web/src/i18n/en.ts web/src/i18n/zh.ts
git commit -m "$(cat <<'EOF'
feat(web): i18n step phrases and lang-aware titles

New running-card chrome follows scout-lang; tool ids never reach the DOM.
EOF
)"
```

---

### Task 6: RunCard + queue filter + mask CSS

**Files:**
- Modify: `web/src/workbench/WorkbenchCards.tsx`
- Modify: `web/src/workbench/ActivityPage.tsx`
- Modify: `web/src/workbench/ActivityPage.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/workbench/cards.css.test.ts`

- [ ] **Step 1: Write the failing tests**

Change the test that locks 「SSE 1/1 AND queue still shows that work」:

```ts
it('在跑的 workId 不出现在排队段', async () => {
  // health/activity: queue contains tmdb:1; SSE activity+progress for tmdb:1
  // expect(screen.queryAllByTestId('wb-queue-card')).  none with that title
})
```

Keep the test 「进度来自 SSE done/total，不是 queue.length」.

New:

```ts
it('RunCard 在 index/total 有限时画出 progressbar', async () => { … expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3') })
it('en 在跑卡不出现「正在装字幕」', async () => {
  render(<I18nProvider initialLang="en">…</I18nProvider>)
  expect(screen.queryByText('正在装字幕')).not.toBeInTheDocument()
})
it('awaitingRescan 显示核对片库而不是等待重试', …)
```

CSS test: `.wb-run-img` contains `mask-image`; drop/replace the assertion that `.wb-run-fade` ends at `var(--card-run-img)` for the run card. Keep `--card-run-h: 186px`. `--card-run-img: 60%` is obsolete for the run card — stop requiring it for run fade; queue variables unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/workbench/ActivityPage.test.tsx web/src/workbench/cards.css.test.ts`

Expected: FAIL

- [ ] **Step 3: Minimal implementation**

`RunCard` props: `progress?: { done: number; total: number } | null`, `stepLabel?: string | null`, `logLines?: string[]`, `elapsedLabel?: string | null`. Render bar + log `role="log"`. Do not render `event.message`.

Layout CSS per spec §8.1 (full-bleed img, mask to left, body 46% left). No overlay darkening when `data-noimg='false'`.

`ActivityPage`:

```ts
const queued = items.filter((i) => i.workId !== current?.workId)
```

only when `current.kind` matches the tab (`subtitle` / `translate`).

Queue subtitle: `awaitingRescan` → `t('wb_queue_awaiting_scan')`; else `dueNow === false` → `t('wb_queue_retry_in')`.

Titles via `displayTitle(lang, title, chineseTitle)`.

Hydrate `workId`/`backdropPath`/`lastStep` from health snapshot in `useCurrentState` (fields now on DTO).

Rolling log: append `stepPhraseKey` translations from progress events actually received (max 5).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/workbench/ActivityPage.test.tsx web/src/workbench/cards.css.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/workbench web/src/styles.css
git commit -m "$(cat <<'EOF'
feat(web): running card progress, mask bleed, hide in-flight queue row

File ticks, mapped steps, and 16:9 mask replace 1/1 plus a fake overlay.
EOF
)"
```

---

### Task 7: Queue fade px-only + media legend width

**Files:**
- Modify: `web/src/styles.css`
- Modify: `web/src/workbench/cards.css.test.ts`
- Modify: add legend assertion in `web/src/media/MediaDetailPage.test.tsx` or a small CSS test

- [ ] **Step 1: Write the failing tests**

```ts
it('🔴 .wb-queue-fade 的 background 不含 %', () => {
  const queue = decl('.wb-queue-fade', 'background') ?? ''
  expect(queue).not.toMatch(/\d+%/)
  expect(queue).toContain('118px')
})

it('🔴 .media-legend 宽度 100%', () => {
  expect(declFromFullCss('.media-legend', 'width')).toBe('100%')
})
```

(`decl` today only scans WB_CSS — legend is outside. Read `__STYLES_CSS__` directly for `.media-legend`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/src/workbench/cards.css.test.ts`

Expected: FAIL — `%` still present / width missing.

- [ ] **Step 3: Minimal implementation**

`.wb-queue-fade`:

```css
background: linear-gradient(
  to right,
  rgba(1, 1, 2, 0) 0,
  rgba(1, 1, 2, 0.2) 40px,
  var(--color-card) 118px
);
```

`.media-legend { width: 100%; }`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/src/workbench/cards.css.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/styles.css web/src/workbench/cards.css.test.ts
git commit -m "$(cat <<'EOF'
fix(web): px-only queue fade and full-width media legend

Percent stops on a wide card painted a hole; the legend did not span.
EOF
)"
```

---

### Task 8: Notifications auto-reload + artwork + media hooks

**Files:**
- Modify: `src/v2/notificationsRepo.ts` (`FoundGroup` + SQL join)
- Modify: `web/src/api/types.ts`
- Modify: `web/src/notifications/NotificationsPage.tsx`
- Modify: `web/src/notifications/sseSeparation.test.tsx`
- Modify: `web/src/notifications/NotificationRow.tsx` (hero vs compact)
- Modify: `web/src/api/hooks.ts` (`useMediaLibrary`, `useMediaLibraryDetail`, `useNotifications`)
- Modify: `web/src/api/hooks` tests / `web/src/media/mediaHooks.test.tsx`
- Possibly delete or gut `NewFoundBanner` click-to-refresh

- [ ] **Step 1: Write the failing tests**

Notifications repo: grouped row includes `chineseTitle` / `backdropPath` from works.

`sseSeparation.test.tsx`: **change** the assertion that found must not refetch. New:

```ts
it('found 触发再 GET，但 SSE 剧名不直接进列表', async () => {
  // after found event, notifications() called again
  // a title only present on the SSE event still absent from DOM until GET returns it
})
```

`mediaHooks.test.tsx`:

```ts
it('found 事件后 useMediaLibrary 再请求一次', async () => { … })
it('health.current 从有变 null 后再请求一次', async () => { … })
```

Wire via EventsProvider + a health current prop or the same pattern Activity uses. If hooks cannot see health today, subscribe `useFoundEvent` inside the media hooks (found) and pass a `current: ScoutCurrentDTO | null` into a tiny `useReloadWhenCurrentClears(current, reload)` used from `AppShell` where health already lives — prefer **one** place: `AppShell` already has health + media hooks; add the effect there rather than inventing a global poll. Test the helper:

Create `web/src/api/reloadOnPresence.ts`:

```ts
export function shouldReloadMedia(prev: ScoutCurrentDTO | null, next: ScoutCurrentDTO | null, foundSeq: number, prevFoundSeq: number): boolean {
  if (foundSeq !== prevFoundSeq) return true
  if (prev !== null && next === null) return true
  return false
}
```

Unit test that. AppShell/hooks call reload when it returns true.

Notification UI: today bucket → if `offset === 0` render hero with backdrop mask (reuse run-card classes). Older days: shorter hero. `displayTitle`. Button `t('notif_open_library')`. **Do not** invent 「第 1 季已经齐了」 without a coverage field — keep existing episode sentence.

en test: hero does not contain `去片库看`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/v2/notificationsRepo.test.ts web/src/notifications/sseSeparation.test.tsx web/src/api/reloadOnPresence.test.ts web/src/media/mediaHooks.test.tsx`

Expected: FAIL

- [ ] **Step 3: Minimal implementation**

`listRecentFound` SELECT add `w.chinese_titles`, `w.backdrop_path`. Parse chinese like activityApi. Set on `FoundGroup` at first-seen.

`useNotifications`: on `useFoundEvent()` id change, `reload()` (not setHasNew). Remove banner that requires a click.

AppShell or media hooks: found + current-cleared → `mediaLibrary.reload()` and detail reload if a work is open.

Hero markup reuses `.wb-run-card` / `.wb-run-img` mask.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/v2/notificationsRepo.test.ts web/src/notifications web/src/media/mediaHooks.test.tsx web/src/api/reloadOnPresence.test.ts web/src/i18n/i18n.test.ts`

Expected: PASS

Then: `npx vitest run src/core/scoutEvents.test.ts src/v2/daemonV2.events.test.ts src/dashboard/activityApi.test.ts web/src/workbench/ActivityPage.test.tsx`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/v2/notificationsRepo.ts src/v2/notificationsRepo.test.ts web/src/notifications web/src/api web/src/media web/src/shell
git commit -m "$(cat <<'EOF'
feat(web): notification heroes and library reload on found

GET stays the ledger; found refetches. Artwork and Chinese titles join at read.
EOF
)"
```

---

## Self-review (plan vs spec)

| Spec | Task |
|---|---|
| P1/P2 file progress 0/N | 2 |
| P3 progressbar | 6 |
| P4 steps via progress.step | 3, 5, 6 |
| P5 queue filter | 6 |
| P6 requestScan + awaitingRescan copy | 2, 4, 6 |
| P7 queue fade % | 7 |
| P8 legend width | 7 |
| P9 media reload | 8 |
| P10 notification C + auto GET | 8 |
| P11 mask 16:9 A | 6 |
| P12 i18n + titles | 5, 6, 8 |
| ScoutCurrent fields | 1 |
| Translate 0/1 | 2 |
| No second SSE / no CoT | 3, 6 (explicit) |
| typeContract FoundGroup extras | 8 |

No TBD. `onFileInstalled` is the scheduler tick; trace bridge does not increment `done`.
