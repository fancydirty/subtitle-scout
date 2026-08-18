# Split Hero B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activity run cards, queue cards, and notification rows share one B split chrome: left 16:9 TMDB backdrop, right solid text column, height follows the left pane.

**Architecture:** One CSS geometry on `.wb-run-card` / `.wb-run-img` / `.wb-run-body`. `SplitHero` owns img + `data-noimg`. `QueueCard` switches to `backdropUrl`. `NotificationRow` drops `compact` and puts the clock in the text column. No backend changes.

**Tech Stack:** TypeScript, React, vitest, Testing Library, existing `backdropUrl`.

**Spec:** `docs/superpowers/specs/2026-08-18-split-hero-b-design.md`

**Hard rules:**
- TDD: failing test first, watch it fail, then implement. Never write production code before a failing test.
- Do not open production `scout.db`.
- Do not change daemon / SSE / queue filter / i18n keys / media-library 2:3 posters.
- Do not commit `PROJECT_AUDIT_2026.md`, hygiene draft, monitor PNGs, `.env`, `.cursor/`.
- `docs/` is gitignored except `docs/design/`; this spec/plan are already on the branch — do not re-add unrelated docs.
- After each task: `git commit` on the current feature branch (`split-hero-b`). Do not push. Do not merge to main.
- Work from the repo root. Frontend tests: `npm test -- --dir web` is wrong; run `npm test --prefix web -- <file>`.

---

## File map

| File | Role |
|---|---|
| `web/src/workbench/cards.css.test.ts` | Lock B geometry; delete 2:3 / 186px / 118px / compact assertions |
| `web/src/styles.css` | Shared split chrome; kill compact + queue fade overlay + old vars |
| `web/src/workbench/WorkbenchCards.tsx` | `SplitHero`; RunCard + QueueCard consume it; queue uses backdrop |
| `web/src/workbench/ActivityPage.test.tsx` | Queue img is w1280 backdrop; poster-only → noimg |
| `web/src/notifications/NotificationRow.tsx` | Drop compact; clock in body |
| `web/src/notifications/NotificationsPage.tsx` | Stop passing compact |
| `web/src/notifications/NotificationsPage.test.tsx` | Yesterday is full B, no compact class |

---

### Task 1: CSS B geometry

**Files:**
- Modify: `web/src/workbench/cards.css.test.ts`
- Modify: `web/src/styles.css` (activity card vars + `.wb-run-*` / `.wb-queue-*` / `.notif-row.wb-run-card`)

- [ ] **Step 1: Rewrite the failing CSS tests**

In `web/src/workbench/cards.css.test.ts`, replace the `R-F13：尺寸走 CSS 变量` describe **and** the `R-F13：渐变终点是 surface 实色` describe with the following. Keep 切片自检 and `R-F11：拒绝投影` (but in the R-F11 border test, `.wb-queue-card` may still exist as an alias — keep asserting `.wb-run-card` border; if `.wb-queue-card` block is deleted, drop that one expect).

Replace the two R-F13 describes with:

```ts
describe('B 切分：左 16:9 + 右实色（覆盖 R-F13 固定高度 / 2:3 排队）', () => {
  it('唯一几何变量 --card-split-poster 在 :root 上，值为 61%', () => {
    const root = /:root\s*\{([^}]*--card-split-poster[^}]*)\}/.exec(CSS)?.[1] ?? ''
    expect(root).toMatch(/--card-split-poster:\s*61%/)
    expect(CSS).not.toMatch(/--card-run-h\s*:/)
    expect(CSS).not.toMatch(/--card-run-img\s*:/)
    expect(CSS).not.toMatch(/--card-queue-w\s*:/)
    expect(CSS).not.toMatch(/--card-queue-h\s*:/)
    expect(CSS).not.toMatch(/--card-queue-fade\s*:/)
  })

  it('在跑图宽走变量、锁 16/9，不定高', () => {
    expect(decl('.wb-run-img', 'width')).toBe('var(--card-split-poster)')
    expect(decl('.wb-run-img', 'aspect-ratio')).toMatch(/16\s*\/\s*9/)
    expect(decl('.wb-run-card', 'height')).not.toBe('var(--card-run-h)')
    expect(decl('.wb-run-card', 'display')).toBe('flex')
  })

  it('mask 朝右溶进右栏，不是 to left，也不是 overlay fade', () => {
    const img = new RegExp('\\.wb-run-img\\s*\\{([^}]*)\\}').exec(WB_CSS)?.[1] ?? ''
    expect(img).toContain('mask-image')
    expect(img).toContain('-webkit-mask-image')
    expect(img).toContain('to right')
    expect(img).not.toContain('to left')
    expect(WB_CSS).not.toContain('.wb-queue-fade')
    expect(WB_CSS).not.toContain('.notif-hero-compact')
  })

  it('右栏 overflow hidden + text-align right；无图改左对齐', () => {
    expect(decl('.wb-run-body', 'overflow')).toBe('hidden')
    expect(decl('.wb-run-body', 'text-align')).toBe('right')
    expect(decl('.wb-run-body', 'width')).not.toBe('46%')
    expect(WB_CSS).toMatch(/\[data-noimg='true'\][\s\S]*?text-align:\s*left/)
  })

  it('🔴 **不许出现 clamp()**', () => {
    expect(WB_CSS).not.toContain('clamp(')
  })
})

describe('B 切分：实色栏与 legend', () => {
  it('🔴 .media-legend 宽度 100%', () => {
    expect(declFromFullCss('.media-legend', 'width')).toBe('100%')
  })

  it('🔴 **不引用 DESIGN.md 那套 surface-* token**', () => {
    expect(WB_CSS).not.toMatch(/--color-surface-\d/)
    expect(WB_CSS).not.toMatch(/--color-hairline/)
  })
})
```

If the 切片自检 still requires `.wb-queue-card` in WB_CSS, keep a `.wb-queue-card { }` rule that only adds nothing extra **or** change the 切片自检 expect from `.wb-queue-card` to still pass: easiest is leave `expect(WB_CSS).toContain('.wb-queue-card')` and keep a one-line alias:

```css
.wb-queue-card { /* same chrome as .wb-run-card; class kept for testid host */ }
```

Better: change the 切片自检 line `expect(WB_CSS).toContain('.wb-queue-card')` to stay, and in CSS keep `.wb-queue-card` grouped with `.wb-run-card`:

```css
.wb-run-card,
.wb-queue-card { ... }
```

Do that in Step 3 so the self-check does not go red.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --prefix web -- src/workbench/cards.css.test.ts
```

Expected: FAIL — `--card-split-poster` missing, old `--card-run-h` still present, mask still `to left`, `.wb-queue-fade` still in CSS.

If they pass, the tests are asserting current behavior. Fix the tests.

- [ ] **Step 3: Minimal CSS**

In `web/src/styles.css`:

1. Delete `--card-run-h`, `--card-run-img`, `--card-queue-w`, `--card-queue-h`, `--card-queue-fade` from `:root`. Add `--card-split-poster: 61%;`.

2. Replace `.notif-row.wb-run-card` / `.notif-hero-compact` block (the one that sets `display:block` + `height: var(--card-run-h)` + `height: 96px`) with:

```css
.notif-row.wb-run-card {
  display: flex;
  align-items: stretch;
  padding: 0;
  height: auto;
}
```

Delete `.notif-hero-compact` entirely.

3. Replace the activity-page run/queue card block (from `/* ---- 在跑卡片` through `.wb-queue-card[data-noimg='true'] .wb-queue-fade`) with:

```css
.wb-run-card,
.wb-queue-card {
  position: relative;
  display: flex;
  align-items: stretch;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-card);
}
.wb-run-img,
.wb-queue-img {
  width: var(--card-split-poster);
  flex-shrink: 0;
  aspect-ratio: 16 / 9;
  height: auto;
  object-fit: cover;
  object-position: 70% 38%;
  -webkit-mask-image: linear-gradient(to right, #000 58%, transparent 100%);
          mask-image: linear-gradient(to right, #000 58%, transparent 100%);
  display: block;
}
.wb-run-body,
.wb-queue-body {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 14px 16px;
  text-align: right;
}
.wb-run-card[data-noimg='true'] .wb-run-body,
.wb-queue-card[data-noimg='true'] .wb-queue-body {
  text-align: left;
}
.wb-run-bar {
  height: 4px;
  width: 100%;
  background: var(--color-border);
  border-radius: 2px;
  overflow: hidden;
}
.wb-run-bar-fill {
  height: 100%;
  background: var(--color-accent);
}
.wb-run-step {
  font-size: 12px;
  line-height: 18px;
  color: var(--color-fg);
}
.wb-run-log {
  font-size: 11px;
  line-height: 16px;
  color: var(--color-weak);
}
.wb-run-log-latest {
  color: var(--color-fg);
}
```

Keep `.wb-card-title` / `.wb-card-sub` / `.wb-card-progress` / `.wb-section-head` / `.wb-run-card[data-stale='true']` as they are.

Delete all `.wb-run-fade` and `.wb-queue-fade` rules. Delete `.wb-run-img { position:absolute; inset:0; width:100%; ... mask to left }`. Delete `.wb-run-body { width: 46%; height: 100%; }`.

Update the long comment above the activity card section: it currently says 在跑用横版、排队用竖版. Rewrite it to say both use B split (left 16:9 backdrop, right solid). Do not leave the old 2:3 rationale as if it were still in force.

- [ ] **Step 4: Re-run CSS tests**

```bash
npm test --prefix web -- src/workbench/cards.css.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/workbench/cards.css.test.ts web/src/styles.css
git commit -m "$(cat <<'EOF'
test(web): lock split-hero B geometry and drop 2:3 queue CSS

Cards now size from a 16:9 left pane so variable width cannot stretch the still.
EOF
)"
```

---

### Task 2: QueueCard + RunCard use SplitHero and backdrop

**Files:**
- Modify: `web/src/workbench/ActivityPage.test.tsx` (R-F13 全背景式卡片 describe)
- Modify: `web/src/workbench/WorkbenchCards.tsx`

**Context:** CSS from Task 1 is already B. Markup still uses absolute full-bleed mental model and queue still calls `posterUrl`. Tests in this file currently require queue `src` to contain `/p.jpg` and `w400`.

- [ ] **Step 1: Rewrite the failing activity card tests**

In `web/src/workbench/ActivityPage.test.tsx`, in describe `R-F13：全背景式卡片与无图降级`:

Change the first test title and assertions from poster w400 to backdrop w1280 for the queue card:

```ts
it('排队与在跑都用横版 backdrop（w1280），不再用竖版 poster', async () => {
  renderPage()
  await ready()
  const queued = screen.getAllByTestId('wb-queue-card')[0]!
  const qImg = queued.querySelector('img')!
  expect(qImg.getAttribute('src')).toContain('/bd.jpg')
  expect(qImg.getAttribute('src')).toContain('w1280')
  expect(qImg.getAttribute('src')).not.toContain('w400')

  act(() => {
    bus().emit(ev({
      type: 'activity', message: '正在找字幕：Queued Show', title: 'Queued Show',
      workbench: 'subtitle', data: { workId: 'tmdb:1' },
    }))
  })
  await waitFor(() => expect(screen.getByTestId('wb-run-card')).toBeInTheDocument())
  const rImg = screen.getByTestId('wb-run-card').querySelector('img')!
  expect(rImg.getAttribute('src')).toContain('/bd.jpg')
  expect(rImg.getAttribute('src')).toContain('w1280')
  expect(screen.getByTestId('wb-run-card').querySelector('.wb-run-fade')).toBeNull()
})
```

Change `posterPath 为 null → 无图降级` to:

```ts
it('backdropPath 为 null → 无图降级（有 poster 也不拿竖图填 16:9）', async () => {
  activityBody = {
    subtitleQueue: [{ ...QUEUE_ITEM, posterPath: '/p.jpg', backdropPath: null }],
    translateQueue: [],
  }
  renderPage()
  await ready()
  const card = screen.getAllByTestId('wb-queue-card')[0]!
  expect(card.getAttribute('data-noimg')).toBe('true')
  expect(card.querySelector('img')).toBeNull()
})
```

Keep `图加载失败（onError）` — it still fires error on the queue img (now a backdrop). Keep workId mismatch test.

- [ ] **Step 2: Run to verify fail**

```bash
npm test --prefix web -- src/workbench/ActivityPage.test.tsx
```

Expected: FAIL on queue src still being w400 `/p.jpg`, and the new poster-only case still showing an img.

- [ ] **Step 3: Minimal implementation**

In `web/src/workbench/WorkbenchCards.tsx`:

1. Rewrite the file-header comment. Delete the paragraph that says 在跑用横版 / 排队用竖版 and the 16:9@70px vs 2:3 rationale. State: both cards use SplitHero — left 16:9 backdrop, right solid. Noimg = no fake slot, no poster fallback.

2. Stop importing `posterUrl`. Queue uses `backdropUrl(face.backdropPath)` like RunCard.

3. Add `SplitHero` in this file (do not create a new file unless this file would exceed ~220 lines; if so, `web/src/workbench/SplitHero.tsx` is allowed):

```tsx
function SplitHero({
  src,
  className,
  testId,
  as: Tag = 'div',
  stale,
  children,
}: {
  src: string | null
  className: string
  testId: string
  as?: 'div' | 'li'
  stale?: boolean
  children: React.ReactNode
}) {
  const [failed, setFailed] = useState(false)
  const noimg = !src || failed
  return (
    <Tag
      className={className}
      data-noimg={noimg ? 'true' : 'false'}
      data-stale={stale ? 'true' : 'false'}
      data-testid={testId}
    >
      {!noimg && <CardImage src={src} className="wb-run-img" onFail={() => setFailed(true)} />}
      <div className="wb-run-body">{children}</div>
    </Tag>
  )
}
```

Queue card used `.wb-queue-img` / `.wb-queue-body`. After this, both use `.wb-run-img` / `.wb-run-body`. CSS from Task 1 still lists `.wb-queue-img` as a grouped selector — that is fine leftover; do not spend a commit deleting the alias unless tests require it.

4. `RunCard` becomes SplitHero with `className="wb-run-card"` `testId="wb-run-card"` `stale={!!staleNote}`. Do not render `.wb-run-fade`. Children stay the existing title / sub / bar / step / log / stale.

5. `QueueCard` becomes SplitHero `as="li"` `className="wb-queue-card"` `testId="wb-queue-card"` `src={backdropUrl(face.backdropPath)}`. Children: title + subtitle only. Remove the fade div.

`CardImage` stays. `WorkbenchCardFace` still has `posterPath` (callers still pass it; QueueCard ignores it).

- [ ] **Step 4: Re-run**

```bash
npm test --prefix web -- src/workbench/ActivityPage.test.tsx src/workbench/cards.css.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/workbench/WorkbenchCards.tsx web/src/workbench/ActivityPage.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): queue and run cards share split-hero backdrop pane

Queue no longer stretches a 2:3 poster; missing backdrop drops to a solid card.
EOF
)"
```

---

### Task 3: Notification rows drop compact; clock in the column

**Files:**
- Modify: `web/src/notifications/NotificationsPage.test.tsx` (describe `英雄卡：当天 backdrop 出血 + 更早的天矮卡`)
- Modify: `web/src/notifications/NotificationRow.tsx`
- Modify: `web/src/notifications/NotificationsPage.tsx`

- [ ] **Step 1: Rewrite the failing notification tests**

Replace the yesterday test. Keep the today backdrop test (still `.wb-run-card` / `.wb-run-img` / w1280). Add clock-in-body and title-visible assertions.

```ts
it('更早的天：同一套 B 卡，无 notif-hero-compact，片名可见', async () => {
  vi.stubGlobal('fetch', mock([art({ latestAt: NOW - 2 * DAY })]))
  renderPage()
  const row = await screen.findByRole('link', { name: 'Cassandra' })
  expect(row.className).toMatch(/wb-run-card/)
  expect(row.className).not.toMatch(/notif-hero-compact/)
  expect(row.querySelector('.wb-run-img')).not.toBeNull()
  expect(row.textContent).toContain('Cassandra')
  expect(row.textContent).toContain(en.notif_open_library)
  const body = row.querySelector('.wb-run-body')
  expect(body?.textContent).toContain('Cassandra')
  expect(row.querySelector('.wb-run-body')?.querySelector('.absolute')).toBeNull()
})
```

In the today test, after existing asserts, add:

```ts
const body = row.querySelector('.wb-run-body')
expect(body?.textContent).toMatch(/\d{2}:\d{2}/)
expect(row.querySelector('.wb-run-img')?.className).not.toMatch(/absolute right-3/)
```

Do **not** keep any expect for `notif-hero-compact` being present.

- [ ] **Step 2: Run to verify fail**

```bash
npm test --prefix web -- src/notifications/NotificationsPage.test.tsx
```

Expected: FAIL — yesterday still has `notif-hero-compact`; clock is outside `.wb-run-body`.

- [ ] **Step 3: Minimal implementation**

`NotificationRow.tsx`:
- Remove `compact` from props. Signature: `{ group }: { group: FoundGroupDTO }`.
- Class: `notif-row wb-run-card wb-hero-bleed` only.
- Reuse the same img + body structure as run cards (`.wb-run-img` + `.wb-run-body`). Prefer importing/using `SplitHero` from WorkbenchCards if it was exported in Task 2; if SplitHero is not exported, duplicate the img/onError/`data-noimg` pattern already in this file — do **not** invent a third chrome. Prefer export:

In Task 2, export `SplitHero`. Then NotificationRow:

```tsx
<SplitHero
  as="a"
  href={mediaItemHref(group.workId)}
  className="notif-row wb-run-card wb-hero-bleed"
  testId="notif-row"
  src={url}
  extra={{ 'data-via': group.via, 'data-shape': shape, 'aria-label': title }}
>
```

If extending SplitHero to `<a>` + extra attrs is messy, keep NotificationRow's own img/body markup but **must** put `formatClock` as the first child of `.wb-run-body` and delete the `absolute right-3 top-3` span. Delete `truncate` on the title (that plus compact was the clip). Title: `wb-card-title` class.

Right-column order: clock, title, meta (shape + via), CTA.

`NotificationsPage.tsx`: `<NotificationRow key={groupKey(g)} group={g} />` — no compact.

If TypeScript complains `compact` is still passed, that is the point — remove the prop at the call site in the same green step.

- [ ] **Step 4: Re-run**

```bash
npm test --prefix web -- src/notifications/NotificationsPage.test.tsx src/workbench/ActivityPage.test.tsx src/workbench/cards.css.test.ts
```

Expected: PASS.

Then:

```bash
npm test --prefix web
```

Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add web/src/notifications/NotificationRow.tsx web/src/notifications/NotificationsPage.tsx web/src/notifications/NotificationsPage.test.tsx web/src/workbench/WorkbenchCards.tsx
git commit -m "$(cat <<'EOF'
fix(web): notification heroes share split-hero B at every day

Yesterday no longer uses a 96px compact strip that clipped titles.
EOF
)"
```

---

## Self-review (plan vs spec)

| Spec | Task |
|---|---|
| §3.1 61% / 16:9 / mask to right / no fixed height | Task 1 |
| §3.2 noimg, poster-only = noimg | Task 2 |
| §4 SplitHero, queue backdrop, run content unchanged | Task 2 |
| §4 notif clock in flow, drop compact | Task 3 |
| §5 test rewrites | Tasks 1–3 |
| Out: media 2:3, backend, i18n keys | no task |

No TBD. No "similar to Task N".
