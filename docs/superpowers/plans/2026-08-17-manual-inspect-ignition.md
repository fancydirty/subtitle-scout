# Manual inspect ignition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activity status bar shows when the next automatic check is due and a Run now button starts a full inspect this round, including subtitle/translate items still in backoff.

**Architecture:** Copy the `requestScan` flag+wakeIdle pattern as `requestInspect`. The main loop consumes the flag, bypasses the 24h gate and failure backoff, runs `runInspection` with a one-shot `skipBackoffThisInspect`. Health adds `nextInspectAt = lastInspectAt + INSPECT_INTERVAL_MS`. The activity status bar reads that field and POSTs `/api/v2/library/inspect`. `/library/scan` stays scan-only.

**Tech Stack:** TypeScript, vitest, React Testing Library, existing dashboard HTTP + daemonV2.

**Spec:** `docs/superpowers/specs/2026-08-17-manual-inspect-ignition-design.md`

**Hard rules:**
- TDD: failing test first, watch it fail, then implement.
- Natural 24h inspect must keep `includeBackoff` false (C26).
- Do not change `subtitleJudge` or `scan_interval_ms` wiring.
- Do not add per-title run buttons.
- `docs/` is gitignored except `docs/design/`; force-add spec/plan with `git add -f`.
- Commit after each task. Do not push unless asked.
- User works on `main`; do not create a side branch.

---

## File map

| File | Role |
|---|---|
| `src/dashboard/server.ts` | `nextInspectAt` on health; `POST /api/v2/library/inspect`; `DashboardOpts.requestInspect` |
| `src/dashboard/health.test.ts` | `nextInspectAt` cases; health key list |
| `src/dashboard/server.test.ts` | inspect HTTP 200/409/503/405/401 |
| `src/v2/daemonV2.ts` | `requestInspect`, flag, skipBackoff this round, inspect-before-scan coalescing |
| `src/v2/daemonV2.test.ts` | ignition vs natural backoff vs already_running vs wakeIdle |
| `src/cli/index.ts` | holder wiring like `requestScan` |
| `web/src/api/types.ts` | `HealthDTO.nextInspectAt` |
| `web/src/api/contracts.ts` | declare `nextInspectAt` |
| `web/src/api/client.ts` | `triggerInspect` |
| `web/src/workbench/inspectFreshness.ts` | `relUntilLabel`; idle uses next |
| `web/src/workbench/ActivityPage.tsx` | copy + button |
| `web/src/i18n/en.ts` + `zh.ts` | new keys |
| `web/src/workbench/ActivityPage.test.tsx` | status bar + POST |
| `web/src/api/contract.test.ts` + health fixtures | new required field |

---

### Task 1: `nextInspectAt` on health

**Files:**
- Modify: `src/dashboard/server.ts` (`HealthDTO` + GET `/api/v2/health` body)
- Modify: `src/dashboard/health.test.ts`
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/contracts.ts` (`HEALTH_SHAPE`)
- Modify: `web/src/api/contract.test.ts` and every `HealthDTO` fixture that TypeScript will flag (`web/src/api/health.hook.test.tsx`, `contractWiring.test.tsx`, `ActivityPage.test.tsx` `HEALTH_IDLE`, `App.test.tsx` HEALTH, shell tests if they construct full HealthDTO)

- [ ] **Step 1: Write the failing tests** in `src/dashboard/health.test.ts`

Import is already `INSPECT_INTERVAL_MS` from `../v2/daemonV2.js`.

In the cold-start test, add:

```ts
expect(body.nextInspectAt).toBeNull()
```

In the `lastInspectAt` reads meta test, add:

```ts
expect(body.nextInspectAt).toBe(NOW + INSPECT_INTERVAL_MS)
```

Change the keys-list test to include `'nextInspectAt'`.

- [ ] **Step 2: Run** `npx vitest run src/dashboard/health.test.ts` — FAIL (property missing)

- [ ] **Step 3: Implement**

On `HealthDTO` in `src/dashboard/server.ts` add `nextInspectAt: number | null`.

When building the body:

```ts
const lastInspectAt = Number.isFinite(lastInspectNum) ? lastInspectNum : null
const body: HealthDTO = {
  lastInspectAt,
  nextInspectAt: lastInspectAt === null ? null : lastInspectAt + INSPECT_INTERVAL_MS,
  // ...existing fields
}
```

`INSPECT_INTERVAL_MS` is already imported in `server.ts`.

Mirror on `web/src/api/types.ts` `HealthDTO`. Add `nextInspectAt: nullable(num())` to `HEALTH_SHAPE` (activity will read it; missing must not look like "no next check" via undefined math).

Add `nextInspectAt: null` (or `lastInspectAt + 24h` when lastInspectAt is set) to every HealthDTO fixture the compiler flags. For `HEALTH_IDLE` in ActivityPage tests: `nextInspectAt: (HEALTH_IDLE.lastInspectAt as number) + 24 * 60 * 60 * 1000` — compute from the same lastInspectAt already in the object.

- [ ] **Step 4: Pass** `npx vitest run src/dashboard/health.test.ts` and `cd web && npx vitest run src/api/contract.test.ts src/api/health.hook.test.tsx`

- [ ] **Step 5: Commit** `feat(health): expose nextInspectAt on /api/v2/health`

---

### Task 2: `requestInspect` on the daemon (skip backoff this round)

**Files:**
- Modify: `src/v2/daemonV2.ts`
- Modify: `src/v2/daemonV2.test.ts` (append a new describe after the `requestScan` describe)

- [ ] **Step 1: Write failing tests** — new describe `ScoutDaemonV2.requestInspect · 手动点火`

Seed helper (inline in tests, do not invent a shared helper unless one already exists):

```ts
function seedBackoffSubtitle(db: ReturnType<typeof openDb>, now: number) {
  db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run('tmdb:ahs-wait', 'Cassandra', 'tv', now, now)
  db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, recheck_after, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('/media/C/E01.mkv', '/media/C', 'E01.mkv', 100, 1000, '/media/C', 'tmdb:ahs-wait', 1, now + 16 * 3600_000, now)
}
```

Tests:

1. Gate closed (`inspectEveryMs: Number.MAX_SAFE_INTEGER` + recent `last_inspect_at`) + backoff row + `fileExists` for that path + `writableRoots` + spy `subtitleWorker`. `run()` then `requestInspect()`. Expect worker called with that title/path. (Natural inspect would not call it.)

2. Same seed, **do not** call `requestInspect`, let a **due** natural inspect run (`last_inspect_at` old enough / cold). Expect worker **not** called for the backoff row. (Keep C26.)

3. `requestInspect()` while `runInspection` is in flight → `'already_running'`. Model: spy/delay `subtitleWorker` with a hanging promise; call `requestInspect()` from inside the worker; expect `'already_running'`.

4. Wake idle: `maintenanceTickMs: 30_000`, gate closed, `requestInspect()`, worker (or identify spy) called within ~150ms.

5. `requestInspect()` return `'queued'` when idle.

Use `mkDeps` / `fakeFs` / `writableRoots` the same way as `requestScan` tests and the in-flight subtitle test (`fileExists` required or R12 drops the cluster).

- [ ] **Step 2: Run** `npx vitest run src/v2/daemonV2.test.ts -t "requestInspect"` — FAIL

- [ ] **Step 3: Implement**

On `ScoutDaemonV2`:

```ts
private inspectRequested = false
private inspecting = false
private skipBackoffThisInspect = false

requestInspect(): 'queued' | 'already_running' {
  if (this.inspecting) return 'already_running'
  this.inspectRequested = true
  this.wakeIdle?.()
  return 'queued'
}
```

Wrap `runInspection` so `inspecting` is true for the whole call (including inner).

In `run()` loop, **before** the 24h gate block:

```ts
if (this.inspectRequested) {
  this.inspectRequested = false
  this.scanRequested = false
  const permitted = this.deps.workPermitted?.() ?? true
  if (permitted) {
    this.skipBackoffThisInspect = true
    try {
      // same emit/log/writeLastInspectAt success path as the natural branch
      await this.runInspection(signal)
      this.writeLastInspectAt(nowCapturedAtStart)
      // success: clear inspectRetryAfter like natural success
    } catch (e) {
      // same failure emit as natural; still do NOT require inspectRetryAfter to block the next requestInspect
    } finally {
      this.skipBackoffThisInspect = false
    }
  }
  continue
}
```

Capture `now` at start of this requested inspect for `writeLastInspectAt`, same D4 start-time semantics.

Stage 3:

```ts
const subtitleQueue = listSubtitleQueue(
  this.deps.db, this.writableRoots(), this.deps.now?.() ?? Date.now(),
  this.skipBackoffThisInspect ? { includeBackoff: true } : {},
)
```

Stage 4 `advanceTranslateOnce`:

```ts
const candidates = listNewTranslateCandidates(
  db, now, this.skipBackoffThisInspect ? { includeBackoff: true } : {},
)
```

Do **not** change identify listing.

Natural 24h branch must leave `skipBackoffThisInspect` false.

- [ ] **Step 4: Pass** the new describe + existing `requestScan` tests still pass

- [ ] **Step 5: Commit** `feat(daemon): requestInspect runs a full inspect including backoff`

---

### Task 3: HTTP + watch wiring

**Files:**
- Modify: `src/dashboard/server.ts` (`DashboardOpts.requestInspect`, route next to `/library/scan`)
- Modify: `src/dashboard/server.test.ts` (`start()` extra options — **do not add a 7th positional**; put `requestInspect` on the existing `extra?:` object)
- Modify: `src/cli/index.ts` (`daemonHolder` type + `requestInspect` closure passed into `startDashboard`)

- [ ] **Step 1: Failing HTTP tests** in `server.test.ts` beside the scan describe:

```ts
describe('POST /api/v2/library/inspect（手动点火完整巡检）', () => {
  it('🔴 POST → 200 且 requestInspect 返回 queued', async () => {
    const { base } = await start(distWith('<!doctype html>'), 'tok', undefined, undefined, undefined, undefined, undefined, undefined, {
      requestInspect: () => 'queued',
    })
    const res = await fetch(`${base}/api/v2/library/inspect?token=tok`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
  it('already_running → 409', async () => { /* ... */ })
  it('未注入 → 503', async () => { /* start() without extra */ })
  it('not_ready → 503', async () => { /* return 'not_ready' */ })
  it('GET → 405')
  it('无凭据 → 401')
})
```

**Check the actual `start()` signature before adding extra fields.** Today `extra` is the last argument. Add `requestInspect?: () => 'queued' | 'already_running' | 'not_ready'` there and pass it to `startDashboard`. Do not shift positional `requestScan` callers.

- [ ] **Step 2: Run those tests — FAIL**

- [ ] **Step 3: Implement route** copying `/library/scan` comments/structure:

- missing callback → 503 `inspect trigger not configured (watch daemon not running)`
- `not_ready` → 503 `inspect trigger not ready (daemon still starting up)`
- `already_running` → 409 `{ error: 'already running' }`
- `queued` → 200 `{ ok: true }`

`cli/index.ts`: widen holder:

```ts
const daemonHolder: { current: {
  requestScan: () => void
  requestInspect: () => 'queued' | 'already_running'
} | null } = { current: null }

const requestInspect = (): 'queued' | 'already_running' | 'not_ready' => {
  const d = daemonHolder.current
  if (!d) return 'not_ready'
  return d.requestInspect()
}
```

Pass `requestInspect` into `startDashboard`. After `new ScoutDaemonV2`, assign holder including both methods.

- [ ] **Step 4: Pass** `npx vitest run src/dashboard/server.test.ts src/cli/watchWiring.test.ts`

- [ ] **Step 5: Commit** `feat(api): add POST /api/v2/library/inspect`

---

### Task 4: Activity status bar

**Files:**
- Modify: `web/src/api/client.ts` + `client.test.ts` (POST URL lock like `triggerScan`)
- Modify: `web/src/i18n/en.ts`, `zh.ts`
- Modify: `web/src/workbench/inspectFreshness.ts` + `inspectFreshness.test.ts`
- Modify: `web/src/workbench/ActivityPage.tsx` + `ActivityPage.test.tsx`

- [ ] **Step 1: Failing tests**

`client.test.ts` (next to triggerScan):

```ts
it('🔴 triggerInspect 打的是 /api/v2/library/inspect 且用 POST', async () => {
  // same fetch stub pattern as triggerScan
  await api.triggerInspect()
  // assert path and method
})
```

`inspectFreshness.test.ts`: idle + `nextInspectAt` in the future → tests consume `relUntilLabel` (add function). Don't break stale/running/never.

`ActivityPage.test.tsx`:

- Replace the idle test that requires `wb_inspect_idle` ("Last automatic check") with: idle line contains `Next automatic check` and a button `Run now`.
- `HEALTH_IDLE` includes `nextInspectAt` ~23h ahead.
- running → button disabled.
- `workPermitted: false, engineEnabled: false` → no Run now button.
- click Run now → fetch POST `/api/v2/library/inspect`.
- 409 → alert `A check is already running`.

- [ ] **Step 2: Run web tests — FAIL**

- [ ] **Step 3: Implement**

`api.triggerInspect: () => post<{ ok: true }>('/api/v2/library/inspect')`

i18n keys from spec §3.4.

`relUntilLabel(deltaMs, lang)`: zh `18 小时后` / `即将开始` when delta <= 0; en `18h`.

Status bar: if `perm === 'permitted'`, render button. Idle copy: `wb_inspect_next` + `relUntilLabel`. `nextInspectAt == null` and idle should not happen if lastInspectAt exists; if nextInspectAt missing, fall back to computing from lastInspectAt + same 24h constant already in inspectFreshness (only as defensive fallback; production health always sends the field).

On click: disable immediately, `api.triggerInspect()`, on 409/error set alert text. No dialog.

- [ ] **Step 4: Pass** `cd web && npx vitest run src/workbench/ActivityPage.test.tsx src/workbench/inspectFreshness.test.tsx src/api/client.test.ts src/i18n/i18n.test.ts`

- [ ] **Step 5: Commit** `feat(web): show next inspect time and Run now on the activity bar`

---

### Task 5: Full suite

```bash
npx vitest run
npx tsc --noEmit -p tsconfig.json
cd web && npx vitest run && npx tsc --noEmit -p tsconfig.json
```

Fix fallout (HealthDTO fixtures, zh/en key parity). Commit only if something remains.

---

## Spec coverage

| Spec | Task |
|---|---|
| §3.1 nextInspectAt | 1, 4 |
| §3.2 requestInspect + skipBackoff this round only | 2 |
| §3.3 HTTP + holder | 3 |
| §3.4 status bar copy + errors | 4 |
| C26 natural inspect still filters backoff | 2 test 2 |
| `/library/scan` unchanged | 3 (do not edit scan route) |
