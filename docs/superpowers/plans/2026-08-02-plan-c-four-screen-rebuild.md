# 四屏重建（AI Elements 栈落地 + Astryx 退役）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 dashboard 的四屏（Activity / Library detail / Triage / Settings）与全局壳从 @astryxdesign/core 迁到 Tailwind v4 + shadcn/ui + Vercel AI Elements（copy-in），补两个只读 GET 喂 Triage 的两个新区，最后卸载 Astryx——行为逐字冻结，只换视觉实现与组件底座。

**Architecture:** 后端只加两个纯读 GET（`/api/v2/subtitle/shifted`、`/api/v2/workflow/dormant`），走既有 `handleApiRoute` 纯函数路由 + `RouterDeps` 注入闭包，鉴权由 `server.ts` 的统一前置门免费覆盖；零写路径、零状态机改动、零 schema 迁移。前端分三层推进：先落底座与组件件（shadcn 补件 + 自绘 primitive + AI Elements copy-in），再逐屏把 Astryx JSX 换成新件（一屏一任务、组件测试随迁绿），最后一步才卸载 `@astryxdesign/core` 并把 Tailwind preflight 顶上原来的 Astryx reset。`web/src/styles.css` 里的 `.act-*` 自绘美术 CSS 全程保留——它不是 Astryx 的东西。

**Tech Stack:** React 19 + Vite 7 + TypeScript（`web/`）；Tailwind v4（`@tailwindcss/vite`）；shadcn/ui new-york v4 copy-in；Vercel AI Elements copy-in（shimmer / queue / task / tool）；Radix primitives；lucide-react；motion；vitest + @testing-library/react（jsdom）；后端 Node ≥22 ESM/TS + better-sqlite3 + vitest。

---

## 0. 读这份计划之前必须知道的十件事

1. **上游 spec 是 `docs/superpowers/specs/2026-08-02-spec-c-four-screen-rebuild-design.md`**（已审计通过）。本计划的每个任务都可以回溯到 spec 的某一节。**spec 说"不做"的事一律不做**——尤其：不新增任何写路径端点、不接卡死 hero 的冻结阶段条、不给 dormant 行画唤醒按钮、不装 AI Elements 对话系组件、不做独立语言切换器、不画流派。
2. **这份计划的前置依赖是 Plan A（`docs/superpowers/plans/2026-08-02-plan-a-bootstrap-engine.md`）的 Task 13 已经落地。** Plan A Task 13 已经装好 Tailwind v4 + `@tailwindcss/vite`、写好 `web/src/tw.css`（token 层）、`web/src/lib/utils.ts`（`cn()`）、以及四个 shadcn 件（`button` / `input` / `switch` / `card`），并在 `web/src/main.tsx` 里 `import './tw.css'`。**本计划消费它们，不重新定义。** 如果你发现 `web/src/tw.css` 不存在，停下来——Plan A 没做完，本计划不能开工。
3. **`web/` 仓库里没有 linter**（无 eslint / prettier / biome 配置）。缩进与换行是纯装饰，永远不影响验收；只有**代码放在哪个文件、哪个作用域**才算。不要为了"格式"改动任何既有行。
4. **`web/tsconfig.json` 的 `types` 是白名单**（`["vitest/globals","@testing-library/jest-dom"]`）。在 `web/src` 下 `import` 任何 node 内建模块（`node:fs` 等）会因为缺 `@types/node` 而编译失败。测试里要读 CSS 文本请用既有的 `__STYLES_CSS__` 全局（`web/vitest.config.ts` 用 `define` 注进来的），**不要**改 tsconfig 的 `types`。
5. **`web/vitest.config.ts` 的 `maxWorkers: 3` 是实测结论**（5 workers 时 flake 率 >30%）。不要动它。
6. **五个既有测试文件在读 `__STYLES_CSS__` 断言真实 CSS 文本**（`ConveyorFeed` / `ActivityQueue` / `ActivityHero` / `ActivityStuck` / `ActivityDone`）——它们锁的是海报 2:3、阶段条 indeterminate 动画、脉动点非黄这类**美术不变量**。换栈时这些断言**继续有效**，因为 `.act-*` CSS 全程保留。如果某个断言开始失败，说明你误删了 `styles.css` 里的自绘 CSS，不是断言过时了。
7. **后端 `tsconfig.json`（根）的 `include` 是 `["src"]`**——`src/dashboard/apiV2.ts` 的类型变动会连带影响 `src/**/*.test.ts` 的编译。改导出类型后必须 `npm run check`。
8. **ES2020 禁止 `??` 与 `||`/`&&` 不加括号混用**（`a ?? b || c` 是 TS5076）。前后端都吃这一条。
9. **禁触文件：`src/v2/realignExecutor.ts`（圣文件）、`src/agent/skills/`（主控亲笔）。** 本计划任何任务都不需要碰它们；如果你觉得需要，你走错路了。
10. **`docs/` 是 gitignored**——本计划文件本身不进 commit。代码改动照常提交，commit message **不要用反引号**（zsh 会吃掉）。

---

## 1. File Structure

### 1.1 后端（新增/修改）

| 文件 | 责任 | 任务 |
|---|---|---|
| `src/v2/subtitleVerifyRepo.ts` | 加一个**只读**方法 `listShiftedWithMedia()`：shifted 行 join episodes/series 拿系列名与季集号。不碰任何写方法。 | 1 |
| `src/v2/subtitleVerifyRepo.test.ts` | 新方法的 join / 排序 / 电影行（join 不中）三组用例。 | 1 |
| `src/dashboard/subtitleVerifyApi.ts` | 加 `ShiftedItemDTO` + `buildShiftedDTOs()`：**铁律②的执行点**——显式列键、禁 spread，`offset_ms`/`score`/`reference_tier`/`detail` 一个都不许出去；`hasPriorCorrection` 由 `exists(subtitle_path + backupSuffix)` 推导。 | 2 |
| `src/dashboard/subtitleVerifyApi.test.ts` | 键集合封闭回归锁（`Object.keys` 全等）+ `hasPriorCorrection` 有/无两态 + 空表 `[]`。 | 2 |
| `src/dashboard/apiV2.ts` | 加 `DormantTaskDTO` + `dormantTargetLabel()`（纯函数，可独立测）+ `buildDormantTasks()`。中文 `reason` 串**绝不进 DTO**。 | 3 |
| `src/dashboard/apiV2.test.ts` | dormant DTO 四键封闭 + reason 不泄漏 + `attempts` 双计数器取大 + targetLabel 五种形状 + 空表 `[]`。 | 3 |
| `src/dashboard/router.ts` | `RouterDeps` 加两个闭包 + `handleApiRoute` 注册两个 pathname。纯函数层不摸文件系统（fs 探测关在 server.ts 的注入闭包里，同 `fsList` 先例）。 | 4 |
| `src/dashboard/router.test.ts` | 两个 pathname 命中 200 + 透传 deps 返回值。 | 4 |
| `src/dashboard/server.ts` | `const deps: RouterDeps` 里接两个真实实现（`:235` 区域）。鉴权无需新增——统一前置门在 `:344`。 | 4 |
| `src/dashboard/server.test.ts` | 两个新端点无 token → 401。 | 4 |

### 1.2 前端数据层（新增/修改）

| 文件 | 责任 | 任务 |
|---|---|---|
| `web/src/api/types.ts` | 手抄两个 DTO 类型（本仓惯例：前端手抄后端 DTO，不共享类型包）。 | 5 |
| `web/src/api/client.ts` | `api.subtitleShifted()` / `api.workflowDormant()` 两个 `get` 包装。 | 5 |
| `web/src/api/hooks.ts` | `useShiftedSubtitles()` / `useDormantTasks()`，复用既有 `LIBRARY_POLL_MS = 15_000` 节律 + visibilitychange 暂停，**不新增更快轮询**。 | 5 |

### 1.3 前端底座与组件件（新增）

| 文件 | 责任 | 任务 |
|---|---|---|
| `web/package.json` | 加 `lucide-react` / `motion` / **`tw-animate-css`** / 五个 Radix 包。 | 6 |
| `web/src/tw.css`（Plan A 任务 13 建）| **只追加、不改 Plan A 已写的行**：`@import "tw-animate-css";` + accordion 的 `@theme` keyframes 块。 | 6（追加）、31（换 preflight）|
| `web/src/components/ui/badge.tsx`, `skeleton.tsx`, `collapsible.tsx`, `accordion.tsx`, `dialog.tsx`, `alert-dialog.tsx`, `select.tsx` | shadcn new-york v4 copy-in（相对 import + `.js` 后缀，`cn` 来自 `../../lib/utils.js`）。 | 7 |
| `web/src/setupTests.ts`（既有）| 追加 Radix 在 jsdom 缺的五个原生能力（pointer capture ×3、scrollIntoView、ResizeObserver）。 | 7 |
| `web/src/testSupport/radix.ts` | 测试辅助：`openRadixSelect()`——Radix Select 只认 `pointerdown`，`fireEvent.click` 打不开它。 | 7 |
| `web/src/components/ui/shadcn.smoke.test.tsx` | Select 开合 / Dialog Escape / Accordion 展开三条冒烟锁 + 构建产物含动画类。 | 7 |
| `web/src/components/ui/primitives.test.tsx` | 八件自绘件的角色契约锁（`status` / `img` / `separator` / `radiogroup`+`radio` / `alert`）。 | 8 |
| `web/src/lib/useHotkeys.test.tsx` | mod 键跨平台、输入框内不触发、`allowInInputs`、`isDisabled`、首个命中即停、未写明 shift 仍触发、handler 换新、卸载退订。 | 9 |
| `web/src/components/ai/aiElements.test.tsx` | shimmer 的高光宽度纯函数 + 行内 span、queue 的列表语义（任务 10）；task/tool 的结构与开合锁、`ToolOutput` 双空返回 null（任务 11 往同一文件追加）。 | 10、11 |
| `web/src/components/ui/empty-state.tsx`, `status-dot.tsx`, `kbd.tsx`, `section.tsx`, `separator.tsx`, `aspect-ratio.tsx`, `segmented.tsx`, `banner.tsx` | Astryx 有、shadcn 没有的八件，自绘、token 化。 | 8 |
| `web/src/lib/useHotkeys.ts` | 替 Astryx 的 `useHotkeys`（⌘K 与 RunDetail 用）。**落 `lib/` 不新开 `hooks/`**：本仓没有 `hooks/` 目录（hook 一律跟领域走，见 `api/hooks.ts`、`workflow/useLiveTrail.ts`），而它 import 的 `lib/platform.ts` 就在同目录。 | 9 |
| `web/src/components/ai/shimmer.tsx`, `queue.tsx` | AI Elements copy-in。**裁剪与偏离逐条登记在任务 10**：shimmer 去多态化 + 高光换 token（官方源假设浅色主题）；queue 官方 16 个导出只抄 3 个、去掉 Radix ScrollArea。 | 10 |
| `web/src/components/ai/task.tsx`, `tool.tsx` | AI Elements copy-in（task 三处偏离、tool 九处偏离——`ai` 包不装导致的整族重塑，逐条见任务 11）。 | 11 |

### 1.4 逐屏迁移（修改，行为冻结）

| 屏 | 文件 | 任务 |
|---|---|---|
| Activity | `activity/ConveyorFeed.tsx` / `ActivityHero.tsx` / `ActivityQueue.tsx` / `ActivityDone.tsx` / `ActivityStuck.tsx` / `ActivityEmpty.tsx` / `ActivityPage.tsx` | 12-18 |
| Library | `library/PosterCard.tsx` / `SeriesGrid.tsx` / `SeriesHero.tsx` / `FactsRail.tsx` / `SeasonAccordion.tsx` / `SeasonGridBody.tsx` / `EpisodeRow.tsx` / `SeriesPage.tsx` | 19-21 |
| Triage | `triage/PendingBox.tsx` / `ExcludedBox.tsx` / `TriagePage.tsx` + 两个新区 | 22-24 |
| Settings | `settings/SettingsPage.tsx` / `BehaviorSection.tsx` / `TranslateSection.tsx` / `SecuritySection.tsx` / `RootsManager.tsx` / `DirBrowser.tsx` / `RemoveRootDialog.tsx` / `DeploySection.tsx` | 25-27 |
| 全局壳 | `shell/AppShell.tsx` / `Sidebar.tsx` / `Topbar.tsx` / `CommandK.tsx` | 28-29 |
| 掉队件 | `auth/LoginPage.tsx` / `ConnectionError.tsx` / `SetupWizard.tsx` / `subtitleVerify/InspectPanel.tsx` / `InspectBoundary.tsx` / `workflow/RerunDialog.tsx` / `RunDetail.tsx` | 30 |

### 1.5 收尾

| 文件 | 责任 | 任务 |
|---|---|---|
| `web/package.json` / `web/src/styles.css` / `web/src/main.tsx` / `web/src/setupTests.ts` / `web/src/theme/` | 卸 `@astryxdesign/core` + 删 `theme:build` 脚本与 `@astryxdesign/cli` devDep、删 `styles.css:7-9` 的**三行** `@import`、补一个替代 preflight（Astryx 的 reset.css 是 437 行的真 reset，tw.css 故意没带 preflight，详见 Task 12 尾注）、删 `main.tsx` 里的 `<Theme>` 包裹、删 `web/src/theme/` 主题产物、清注释里的 Astryx 提法。**`web/src/styles.css` 本体与 `main.tsx` 的 `import './styles.css'` + `import './tw.css'` 两行一个都不删**（`tw.css` 是新栈 token 层）。 | 31 |
| — | 全量 `npm run check` + 双侧 `npm test` + Astryx 残留全 grep 核销。 | 32 |
| — | 部署 + 实机四屏视觉验收（主控执行）。 | 33 |

---

## 2. 任务

### Task 1: subtitleVerifyRepo 加只读 join 查询

**Files:**
- Modify: `src/v2/subtitleVerifyRepo.ts`（在 `listShifted()` 之后、`needsRecheck()` 之前插入）
- Test: `src/v2/subtitleVerifyRepo.test.ts`

**为什么加新方法而不是复用 `listShifted()`：** `listShifted()` 返回裸 `SubtitleVerifyRow`，没有系列名/季集号——DTO 需要它们（spec §4.1）。仓库里**不存在** correction 记录表，也不存在"item_id → 系列名"的现成查询。spec §11-4 明确授权："如需新查询则在 subtitleVerifyRepo 加只读方法，不碰写路径"。

**`item_id` 的真实语义（已核实）：** 它就是 `episodes.id`（形如 `tmdb:100/s2e3`，见 `src/v2/db.ts:32`）或 `movies.id`（形如 `tmdb:100`，`:48`）。所以 join 用 `LEFT JOIN`：电影行 join 不中，四个媒体字段全 null，前端按 spec §8 的既有降级惯例回落成 mono itemId 占位。**不要**为电影另写一条 join——spec §4.1 的 DTO 键集合是封闭的七键，电影行只是这七键里有四个为 null。

- [ ] **Step 1: 写失败的测试**

在 `src/v2/subtitleVerifyRepo.test.ts` 里，`describe('SubtitleVerifyRepo', () => {` 块内、文件末尾的 `})` 之前追加：

```ts
  describe('listShiftedWithMedia (Plan C：Triage/Library 偏移行的数据源)', () => {
    it('把 shifted 行 join 到 episodes/series，按 checked_at 倒序', () => {
      db.prepare(`INSERT INTO series (id, name, year) VALUES ('tmdb:100', 'The Rig', 2023)`).run()
      db.prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
         VALUES ('tmdb:100/s2e3', 'tmdb:100', 2, 3, 'Ep3', '/media/rig.s02e03.mkv', 'covered', 1)`,
      ).run()
      db.prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
         VALUES ('tmdb:100/s1e1', 'tmdb:100', 1, 1, 'Ep1', '/media/rig.s01e01.mkv', 'covered', 1)`,
      ).run()
      repo.upsertVerifyResult({
        itemId: 'tmdb:100/s1e1', verdict: 'shifted', subtitlePath: '/media/rig.s01e01.zh.srt',
        checkedAt: 1000, offsetMs: 2000, score: 0.9, referenceTier: 'embedded', subtitleHash: 'h1',
      })
      repo.upsertVerifyResult({
        itemId: 'tmdb:100/s2e3', verdict: 'shifted', subtitlePath: '/media/rig.s02e03.zh.srt',
        checkedAt: 3000, offsetMs: -1500, score: 0.8, referenceTier: 'embedded', subtitleHash: 'h2',
      })

      const rows = repo.listShiftedWithMedia()

      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual({
        item_id: 'tmdb:100/s2e3',
        checked_at: 3000,
        subtitle_path: '/media/rig.s02e03.zh.srt',
        series_id: 'tmdb:100',
        series_name: 'The Rig',
        season: 2,
        episode: 3,
      })
      expect(rows[1].item_id).toBe('tmdb:100/s1e1')
    })

    it('只出 shifted——aligned/unverifiable 一律不出', () => {
      for (const [itemId, verdict] of [
        ['tmdb:1/s1e1', 'aligned'],
        ['tmdb:1/s1e2', 'unverifiable'],
        ['tmdb:1/s1e3', 'shifted'],
      ] as const) {
        repo.upsertVerifyResult({
          itemId, verdict, subtitlePath: `/media/${itemId}.srt`, checkedAt: 100, subtitleHash: 'h',
        })
      }
      expect(repo.listShiftedWithMedia().map((r) => r.item_id)).toEqual(['tmdb:1/s1e3'])
    })

    it('join 不中（电影行 / 库里已无此集）时四个媒体字段为 null，行本身仍然出', () => {
      repo.upsertVerifyResult({
        itemId: 'tmdb:777', verdict: 'shifted', subtitlePath: '/media/movie.zh.srt',
        checkedAt: 500, subtitleHash: 'h',
      })
      const rows = repo.listShiftedWithMedia()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({
        item_id: 'tmdb:777',
        checked_at: 500,
        subtitle_path: '/media/movie.zh.srt',
        series_id: null,
        series_name: null,
        season: null,
        episode: null,
      })
    })

    it('空表返回空数组', () => {
      expect(repo.listShiftedWithMedia()).toEqual([])
    })
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/v2/subtitleVerifyRepo.test.ts -t listShiftedWithMedia
```

预期：FAIL，`repo.listShiftedWithMedia is not a function`。

- [ ] **Step 3: 写最小实现**

在 `src/v2/subtitleVerifyRepo.ts` 里，`SubtitleVerifyRow` 接口定义之后追加行类型：

```ts
/** Plan C（spec §4.1）：shifted 行 + 媒体标识的 join 行。**刻意不是 `SubtitleVerifyRow` 的
 *  超集**——`offset_ms`/`score`/`reference_tier`/`detail` 四个禁出字段从 SELECT 列表里就不选，
 *  这样 DTO 层即使写错（比如手滑 spread）也无从泄漏。`subtitle_path` 是唯一一个"进得来、
 *  出不去"的字段：DTO 层要用它探备份文件是否存在（hasPriorCorrection），但它自己不进 DTO。
 *  四个媒体字段可 null：item_id 是电影 id（movies.id）或库里已被删掉的集时 LEFT JOIN 不中，
 *  行仍然要出（用户仍该看到这条偏移事实），前端按既有降级惯例回落 mono itemId 占位。 */
export interface ShiftedMediaRow {
  item_id: string
  checked_at: number
  subtitle_path: string
  series_id: string | null
  series_name: string | null
  season: number | null
  episode: number | null
}
```

在 `listShifted()` 方法之后追加：

```ts
  /** Plan C（spec §4.1）：shifted 行连媒体标识一起取，供 Triage 第三区与 Library 详情偏移行。
   *  与 listShifted() 并存而不是取代它——后者是既有调用方的契约，签名不动。
   *  纯读，无写路径。verdict 索引（src/v2/db.ts:145）已覆盖 WHERE，无需新索引。 */
  listShiftedWithMedia(): ShiftedMediaRow[] {
    return this.db
      .prepare(
        `SELECT v.item_id       AS item_id,
                v.checked_at    AS checked_at,
                v.subtitle_path AS subtitle_path,
                e.series_id     AS series_id,
                s.name          AS series_name,
                e.season        AS season,
                e.episode       AS episode
           FROM subtitle_verify v
           LEFT JOIN episodes e ON e.id = v.item_id
           LEFT JOIN series   s ON s.id = e.series_id
          WHERE v.verdict = 'shifted'
          ORDER BY v.checked_at DESC`,
      )
      .all() as ShiftedMediaRow[]
  }
```

（`this.db` 的字段名以文件里现有方法的写法为准——照抄 `listShifted()` 那一行的 receiver，不要自己猜。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/v2/subtitleVerifyRepo.test.ts && npm run check
```

预期：全绿，`check` 无输出。

- [ ] **Step 5: 提交**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/v2/subtitleVerifyRepo.ts src/v2/subtitleVerifyRepo.test.ts
git commit -m "feat(plan-c): subtitleVerifyRepo 加只读 listShiftedWithMedia join 查询"
```

---

### Task 2: shifted DTO 构造器（铁律②的执行点）

**Files:**
- Modify: `src/dashboard/subtitleVerifyApi.ts`
- Test: `src/dashboard/subtitleVerifyApi.test.ts`

**为什么放在这个文件：** `subtitleVerifyApi.ts` 是既有的 DTO 防火墙——文件头就写着"响应体只含 itemId/state/checked"，`toVerifyDTO` 显式列键、从不 spread。shifted DTO 是同一族语义、同一条铁律，放在一起，审计时一眼能看到两个构造器用的是同一种手法。**不要**为它新建文件。

**`hasPriorCorrection` 的推导口径（spec §4.1 + §11-4 已裁决，实现期已核实）：** 仓库里**没有** correction 记录表，唯一"这条字幕有没有可还原的在先校正"的事实来源是 `revertSubtitle` 自己的前置门——`deps.exists(\`${row.subtitle_path}${opts.backupSuffix}\`)`（Task 2 进场后位于 `src/dashboard/subtitleVerifyApi.ts:406`，`correctSubtitle` 里的同一个门在 `:354`；Task 2 之前在 `:364`/`:312`）。所以 `hasPriorCorrection` = 同一个探测。注意：**备份门通过 ≠ 撤销必成功**——`revertSubtitle` 还有第二道 C-A1 陈旧门（isRecordStale：字幕被换过时保护性拒绝），UI 上"可撤销"只是"有可撤销之物"，不是"这次撤销一定放行"。`BACKUP_SUFFIX = '.scout-backup'`（`src/subtitleVerify/shiftTiming.ts:215`）由调用方以 `opts` 传入，与 `correctSubtitle`/`revertSubtitle` 的既有签名形状对称——**不要**在这个文件里 import 常量，保持依赖注入。

- [ ] **Step 1: 写失败的测试**

在 `src/dashboard/subtitleVerifyApi.test.ts` 末尾追加（如果文件顶部还没从 `'./subtitleVerifyApi.js'` 引入 `buildShiftedDTOs`，在那个 import 块里加这个名字；`ShiftedMediaRow` 从 `'../v2/subtitleVerifyRepo.js'` 引入类型）：

```ts
describe('buildShiftedDTOs（Plan C spec §4.1）', () => {
  const row = (over: Partial<ShiftedMediaRow> = {}): ShiftedMediaRow => ({
    item_id: 'tmdb:100/s2e3',
    checked_at: 3000,
    subtitle_path: '/media/rig.s02e03.zh.srt',
    series_id: 'tmdb:100',
    series_name: 'The Rig',
    season: 2,
    episode: 3,
    ...over,
  })
  const deps = (rows: ShiftedMediaRow[], exists: (p: string) => boolean) => ({
    repo: { listShiftedWithMedia: () => rows },
    exists,
  })

  it('DTO 键集合封闭为七键——四个禁出字段一个都不许出现（铁律②回归锁）', () => {
    const dto = buildShiftedDTOs(deps([row()], () => false), { backupSuffix: '.scout-backup' })
    expect(Object.keys(dto[0]).sort()).toEqual(
      ['checkedAt', 'episode', 'hasPriorCorrection', 'itemId', 'season', 'seriesId', 'seriesName'],
    )
    // 显式再钉一遍：这四个键（以及承载它们的 snake_case 原名）永远不该在响应体里。
    // 扫的是 JSON 键形（"key":）而非裸词——裸词会被 fixture 文案里的 'Filmscore'/'detailed' 误伤。
    const serialized = JSON.stringify(dto)
    for (const forbidden of [
      '"offsetMs":', '"offset_ms":', '"score":', '"referenceTier":',
      '"reference_tier":', '"detail":', '"subtitlePath":', '"subtitle_path":',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('逐字段映射 snake_case → camelCase', () => {
    const dto = buildShiftedDTOs(deps([row()], () => false), { backupSuffix: '.scout-backup' })
    expect(dto[0]).toEqual({
      itemId: 'tmdb:100/s2e3',
      seriesId: 'tmdb:100',
      seriesName: 'The Rig',
      season: 2,
      episode: 3,
      checkedAt: 3000,
      hasPriorCorrection: false,
    })
  })

  it('hasPriorCorrection 探的是 subtitle_path + backupSuffix 这个确切路径', () => {
    const probed: string[] = []
    const dto = buildShiftedDTOs(
      deps([row()], (p) => { probed.push(p); return true }),
      { backupSuffix: '.scout-backup' },
    )
    expect(probed).toEqual(['/media/rig.s02e03.zh.srt.scout-backup'])
    expect(dto[0].hasPriorCorrection).toBe(true)
  })

  it('join 不中的行（电影 / 已删集）四个媒体字段为 null，行仍然出', () => {
    const dto = buildShiftedDTOs(
      deps([row({ item_id: 'tmdb:777', series_id: null, series_name: null, season: null, episode: null })], () => false),
      { backupSuffix: '.scout-backup' },
    )
    expect(dto).toHaveLength(1)
    expect(dto[0].seriesName).toBeNull()
    expect(dto[0].itemId).toBe('tmdb:777')
  })

  it('空表返回空数组（不是 null、不 404）', () => {
    expect(buildShiftedDTOs(deps([], () => false), { backupSuffix: '.scout-backup' })).toEqual([])
  })

  it('多行：逐行探测且行序原样透传（repo 的 checked_at DESC 不打乱）', () => {
    const probed: string[] = []
    const rows = [
      row(), // rig.s02e03，checked_at 3000（较近，排前）
      row({ item_id: 'tmdb:100/s1e1', checked_at: 1000, subtitle_path: '/media/rig.s01e01.zh.srt', season: 1, episode: 1 }),
    ]
    const dto = buildShiftedDTOs(
      deps(rows, (p) => { probed.push(p); return false }),
      { backupSuffix: '.scout-backup' },
    )
    expect(probed).toEqual([
      '/media/rig.s02e03.zh.srt.scout-backup',
      '/media/rig.s01e01.zh.srt.scout-backup',
    ])
    expect(dto[0].itemId).toBe('tmdb:100/s2e3')
    expect(dto[1].itemId).toBe('tmdb:100/s1e1')
  })

  it('backupSuffix 由调用方注入：探测路径跟着 opts 走（不硬编码 .scout-backup）', () => {
    const probed: string[] = []
    buildShiftedDTOs(
      deps([row()], (p) => { probed.push(p); return false }),
      { backupSuffix: '.bak' },
    )
    expect(probed).toEqual(['/media/rig.s02e03.zh.srt.bak'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/dashboard/subtitleVerifyApi.test.ts -t buildShiftedDTOs
```

预期：FAIL，`buildShiftedDTOs is not a function`（或 import 解析失败）。

- [ ] **Step 3: 写最小实现**

在 `src/dashboard/subtitleVerifyApi.ts` 里，`toVerifyDTO` / `SubtitleVerifyListDTO` 那一族定义之后追加。注意 import：文件顶部从 `'../v2/subtitleVerifyRepo.js'` 引入的类型块里追加 `ShiftedMediaRow`。

```ts
/** Plan C（spec §4.1）：GET /api/v2/subtitle/shifted 的行 DTO。**七键封闭**——加字段走新 spec。
 *  四个媒体字段可 null（item_id 是电影或库里已无此集），前端降级 mono itemId 占位（spec §8）。 */
export interface ShiftedItemDTO {
  itemId: string
  seriesId: string | null
  seriesName: string | null
  season: number | null
  episode: number | null
  checkedAt: number
  /** 有没有可还原的在先校正 = 前端 Undo 按钮给不给点。**推导源就是 revertSubtitle 自己的
   *  前置门**（本文件 :406 revert / :354 correct 同一道 `exists(subtitle_path + backupSuffix)`）
   *  ——仓库里不存在 correction 记录表，这是唯一诚实的事实来源。用同一个探测，UI 上的
   *  "可撤销"就与后端"撤销会成功"天然一致，不会出现按钮能点但请求必败的错位。
   *  撤销仍可能被 C-A1 陈旧门拒（isRecordStale：字幕被换过时的保护性拒绝，非按钮状态错误）。 */
  hasPriorCorrection: boolean
}

/** buildShiftedDTOs 的依赖：repo 只读查询 + 文件存在性探测。形状是 SubtitleWriteDeps 的
 *  真子集，server.ts 直接拿既有的 subDeps 喂它（同一个 exists 实现，见 server.ts:228）。 */
export interface ShiftedListDeps {
  repo: { listShiftedWithMedia: () => ShiftedMediaRow[] }
  exists: (p: string) => boolean
}

/** 铁律②的第二个执行点（第一个是 toVerifyDTO）：**显式列键，禁止 `{...row}`。**
 *  `subtitle_path` 在这里用完就丢——它进得来（探备份路径要用），出不去（DTO 里没有它）。
 *  `offset_ms`/`score`/`reference_tier`/`detail` 在 SQL 的 SELECT 列表里就没选，双层设防。 */
export function buildShiftedDTOs(
  deps: ShiftedListDeps,
  opts: { backupSuffix: string },
): ShiftedItemDTO[] {
  return deps.repo.listShiftedWithMedia().map((row) => ({
    itemId: row.item_id,
    seriesId: row.series_id,
    seriesName: row.series_name,
    season: row.season,
    episode: row.episode,
    checkedAt: row.checked_at,
    hasPriorCorrection: deps.exists(`${row.subtitle_path}${opts.backupSuffix}`),
  }))
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/dashboard/subtitleVerifyApi.test.ts && npm run check
```

预期：全绿。

- [ ] **Step 5: 提交**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/dashboard/subtitleVerifyApi.ts src/dashboard/subtitleVerifyApi.test.ts
git commit -m "feat(plan-c): shifted 列表 DTO 构造器，键集合封闭七键"
```

---

### Task 3: dormant DTO 构造器 + targetLabel 纯函数

**Files:**
- Modify: `src/dashboard/apiV2.ts`（在 `buildWorkflowWorkers` 之后）
- Test: `src/dashboard/apiV2.test.ts`

**为什么放 apiV2.ts：** 所有 workflow 侧 DTO 构造器都在这里（`buildWorkflowPending` / `buildWorkflowPasses` / `buildWorkflowWorkers`），它们都吃 `db` 直接写 SQL。dormant 是同一族，跟着惯例走。

**四个字段的真实出处（全部已核实）：**

- `jobId` = `jobs.id`。
- `task` = `json_extract(payload,'$.taskType')`（worker_task 的裸工具名，如 `find_subtitle`；见 `src/v2/findSubtitleWorkerTask.ts:31`、`src/v2/jobsRepo.ts:129`）。**null 时回落 `jobs.kind`**——`kind` 的值域是 `('series_season','movie','realign','worker_task')`（`src/v2/db.ts:59`），旧 kind 的创建方法已随死器官删除，实际库里应当只有 `worker_task`，但回落必须存在，否则老行会渲染成空字符串。
- `attempts` = **`max(attempt, reap_count)`**。这是本任务唯一需要判断的地方，理由：dormant 有两条到达路径，各自有独立计数器——内容失败轨走 `jobs.attempt`（"1/2/4/8 天退避梯 + 第 5 次 dormant"，`src/v2/db.ts:69`），崩溃循环轨走 `jobs.reap_count`（到 `REAP_PARK_THRESHOLD = 5` 由 reap 直接 park，`src/v2/jobsRepo.ts:106`、`:304`）。取大 = 取"实际把这行推到 dormant 的那个计数器"，两条路径都得到诚实的数字。**不要**相加（混合情形会得出无意义的和），也不要只取一个（另一条路径的行会显示 0 次失败）。
- `targetLabel` 由后端组好（spec §4.2："The Rig, Season 2" 粒度，前端不拼）。季号的取法有坑：**`jobs.season` 对 `find_subtitle` 任务恒为 null**（R-11 裁决，`src/v2/jobsRepo.ts:56` 区域），派活范围改由 `payload.seasons` 承载（数组 = 季子集，null = 全剧，缺席 = 存量行按旧语义）。所以 label 逻辑必须先看 `payload.seasons`，再回落 `jobs.season`。另外 `series_id` 可能是**合成 id**（如 `orchestrator-shard-<parentJobId>-<n>`，`src/v2/db.ts:76` 区域注释），join 不中 series 表——此时如实回落成那个 id 本身，不要伪造名字。

**新拟文案登记（spec §5.7 的延伸，审计可砍）：** 多季标签 `"The Rig, Seasons 1, 2"`。spec 只给了单季形状；多季是同一格式的机械延伸，非散文。**不新增任何"预告系统行为"的句子**（铁律④）。

- [ ] **Step 1: 写失败的测试**

在 `src/dashboard/apiV2.test.ts` 末尾追加（顶部从 `'./apiV2.js'` 的 import 块里追加 `buildDormantTasks, dormantTargetLabel`）：

```ts
describe('dormantTargetLabel（Plan C spec §4.2：后端组标签，前端不拼）', () => {
  const base = {
    id: 1, series_id: 'tmdb:100', movie_id: null, season: null,
    series_name: 'The Rig', movie_name: null, seasons_json: null as string | null,
  }

  it('payload.seasons 单季 → "名, Season N"', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '[2]' })).toBe('The Rig, Season 2')
  })

  it('payload.seasons 多季 → "名, Seasons a, b"（升序）', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '[2,1]' })).toBe('The Rig, Seasons 1, 2')
  })

  it('payload.seasons 缺席但 jobs.season 有值 → 回落用列（存量 series_season 行）', () => {
    expect(dormantTargetLabel({ ...base, season: 3 })).toBe('The Rig, Season 3')
  })

  it('两处季信息都没有 → 只给系列名（全剧任务）', () => {
    expect(dormantTargetLabel(base)).toBe('The Rig')
  })

  it('电影行 → 电影名', () => {
    expect(dormantTargetLabel({
      ...base, series_id: null, series_name: null, movie_id: 'tmdb:777', movie_name: 'Dune',
    })).toBe('Dune')
  })

  it('join 不中（合成 series_id 的通用任务）→ 如实回落 id 本身，不伪造名字', () => {
    expect(dormantTargetLabel({
      ...base, series_id: 'orchestrator-shard-42-1', series_name: null,
    })).toBe('orchestrator-shard-42-1')
  })

  it('连 id 都没有 → 回落 job 号', () => {
    expect(dormantTargetLabel({ ...base, id: 77, series_id: null, series_name: null })).toBe('job #77')
  })

  it('seasons_json 是畸形 JSON 时不抛，按"没有季信息"处理', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '{oops' })).toBe('The Rig')
  })
})

describe('buildDormantTasks（Plan C spec §4.2）', () => {
  let db: ScoutDb
  beforeEach(() => { db = openDb(':memory:') })

  const insertJob = (over: Record<string, unknown> = {}) => {
    const row = {
      kind: 'worker_task', series_id: 'tmdb:100', season: null, movie_id: null,
      payload: JSON.stringify({ taskType: 'find_subtitle', reason: 'gaps', seasons: [2] }),
      state: 'dormant', attempt: 5, reap_count: 0,
      last_error: '连续 5 次进程崩溃/租约死亡回收未竟全功——疑确定性崩溃(poison task)',
      created_at: NOW, updated_at: NOW,
      ...over,
    }
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, payload, state, attempt, reap_count,
                         last_error, created_at, updated_at)
       VALUES (@kind, @series_id, @season, @movie_id, @payload, @state, @attempt, @reap_count,
               @last_error, @created_at, @updated_at)`,
    ).run(row)
  }

  it('DTO 键集合封闭为四键，中文 reason 串不泄漏', () => {
    db.prepare(`INSERT INTO series (id, name, year) VALUES ('tmdb:100', 'The Rig', 2023)`).run()
    insertJob()
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(1)
    expect(Object.keys(dto[0]).sort()).toEqual(['attempts', 'jobId', 'targetLabel', 'task'])
    expect(dto[0]).toEqual({ jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5 })
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain('崩溃')
    expect(serialized).not.toContain('poison')
    expect(serialized).not.toMatch(/"(reason|lastError|last_error|updatedAt|updated_at)":/)
  })

  it('只出 dormant——其余六态一律不出', () => {
    for (const state of ['wanted', 'searching', 'downloading', 'verifying', 'done', 'failed'] as const) {
      insertJob({ state, series_id: `tmdb:${state}` })
    }
    // parked 行刻意不带 payload.seasons：assert 的是纯 id 回落形状（若沿用 insertJob 默认
    // payload 的 seasons:[2]，label 会是 'tmdb:parked, Season 2'——实现轮实测发现的计划内部矛盾）。
    insertJob({ state: 'dormant', series_id: 'tmdb:parked', payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(1)
    expect(dto[0].targetLabel).toBe('tmdb:parked')
  })

  it('attempts 取两个计数器的大者——崩溃循环轨（reap_count=5, attempt=0）也报 5', () => {
    insertJob({ attempt: 0, reap_count: 5 })
    expect(buildDormantTasks(db)[0].attempts).toBe(5)
  })

  it('attempts 取两个计数器的大者——内容失败轨（attempt=5, reap_count=1）报 5', () => {
    insertJob({ attempt: 5, reap_count: 1 })
    expect(buildDormantTasks(db)[0].attempts).toBe(5)
  })

  it('payload 无 taskType 时 task 回落 kind，不给空串', () => {
    insertJob({ kind: 'realign', payload: null })
    expect(buildDormantTasks(db)[0].task).toBe('realign')
  })

  it('空表返回空数组', () => {
    expect(buildDormantTasks(db)).toEqual([])
  })

  it('排序钉死 ORDER BY updated_at DESC：最近停车的排前面', () => {
    insertJob({ series_id: 'tmdb:old', updated_at: NOW - 1000, payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    insertJob({ series_id: 'tmdb:new', updated_at: NOW, payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(2)
    expect(dto.map((d) => d.targetLabel)).toEqual(['tmdb:new', 'tmdb:old'])
  })
})
```

（`ScoutDb` / `openDb` / `NOW` 在 `apiV2.test.ts` 里**已经存在**：`openDb` 在 `:5`、`NOW = 1_700_000_000_000` 在 `:22`。**不要重复声明**——重复 `const` 是编译期 TS2451。`beforeEach` 若顶部未引入则在 vitest import 块里补。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/dashboard/apiV2.test.ts -t dormant
```

预期：FAIL，`buildDormantTasks is not a function`。

- [ ] **Step 3: 写最小实现**

在 `src/dashboard/apiV2.ts` 里 `buildWorkflowWorkers` 之后追加：

```ts
/** Plan C（spec §4.2）：GET /api/v2/workflow/dormant 的行 DTO。**四键封闭。**
 *  刻意缺席的字段与理由：
 *   - `reason`/`last_error`：现网该串是中文且含内部措辞（`src/v2/jobsRepo.ts:110`），
 *     不透传；英文句子由前端用 attempts 组（spec §5.7 新拟 #3）。
 *   - 任何时刻字段：草稿 6 的 dormant 行不渲染时刻，jobs 表也没有 `last_error_at` 列；
 *     `updated_at` 虽然冻结在 park 时刻可以推导，但没有 UI 消费方，不进 DTO（R1 审计裁决）。
 *     它只用于 ORDER BY（最近停车的排前面），不序列化。 */
export interface DormantTaskDTO {
  jobId: number
  /** 裸工具名（如 `find_subtitle`），前端 mono 弱显。payload 无 taskType 时回落 jobs.kind。 */
  task: string
  /** 后端组好的目标标签（"The Rig, Season 2" 粒度），前端不拼。 */
  targetLabel: string
  /** 实际把这行推到 dormant 的失败次数 = max(内容轨 attempt, 崩溃轨 reap_count)。 */
  attempts: number
}

/** buildDormantTasks 的 join 行（导出仅为让 dormantTargetLabel 可独立单测）。 */
export interface DormantJobRow {
  id: number
  series_id: string | null
  movie_id: string | null
  season: number | null
  series_name: string | null
  movie_name: string | null
  /** `json_extract(payload,'$.seasons')` 的原样结果：数组时是 JSON 文本（如 `'[2]'`），
   *  payload 里是 null / 缺席 / 根本没有 payload 时是 SQL NULL。 */
  seasons_json: string | null
}

/** 目标标签组装（纯函数，无 I/O，可直接单测）。
 *
 *  季号有两个来源且**顺序不能颠倒**：`payload.seasons` 优先，`jobs.season` 兜底。理由：
 *  R-11 裁决（`src/v2/jobsRepo.ts:56` 区域）之后，`jobs.season` 对 find_subtitle 任务**恒为
 *  null**，派活范围搬到了 payload；只看列的话现网所有 worker_task 都会退化成"只有系列名"。
 *
 *  名字查不到时如实回落 id（合成 series_id 如 `orchestrator-shard-42-1` 本来就不在 series
 *  表里，`src/v2/db.ts:76` 区域注释）——**不伪造名字**，让人看到一个能拿去查库的真串。 */
export function dormantTargetLabel(row: DormantJobRow): string {
  const name = row.series_name
    ?? row.movie_name
    ?? row.series_id
    ?? row.movie_id
    ?? `job #${row.id}`
  const seasons = parseSeasonsJson(row.seasons_json)
  if (seasons !== null && seasons.length === 1) return `${name}, Season ${seasons[0]}`
  if (seasons !== null && seasons.length > 1) return `${name}, Seasons ${seasons.join(', ')}`
  if (row.season !== null) return `${name}, Season ${row.season}`
  return name
}

/** `json_extract` 出来的 seasons 文本 → 升序数字数组；不是数组/畸形 JSON/空数组一律 null
 *  （按"没有季信息"处理，让 dormantTargetLabel 走 jobs.season 或纯名字分支）。
 *  不抛保证只覆盖这一段：抽出来的 seasons 文本畸形 → null。注意若 **payload 本身**畸形，
 *  json_extract 在 SQL 层就先抛 SqliteError，根本走不到这里——但应用内所有 payload 写入
 *  都过 JSON.stringify（jobsRepo），只有手工改库才能造出畸形 payload，实践中不可达，
 *  不为它加防御层。 */
function parseSeasonsJson(raw: string | null): number[] | null {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const nums = parsed.filter((n): n is number => typeof n === 'number')
    return nums.length > 0 ? [...nums].sort((a, b) => a - b) : null
  } catch {
    return null
  }
}

/** Plan C（spec §4.2）：dormant 任务清单。纯读、零状态机改动。
 *  ORDER BY updated_at DESC = 最近停车的排前面（updated_at 在 park 时冻结，见 jobsRepo
 *  的 park/reap SQL）——**它只参与排序，不进 DTO**。 */
export function buildDormantTasks(db: ScoutDb): DormantTaskDTO[] {
  const rows = db
    .prepare(
      `SELECT j.id          AS id,
              j.kind        AS kind,
              j.series_id   AS series_id,
              j.movie_id    AS movie_id,
              j.season      AS season,
              j.attempt     AS attempt,
              j.reap_count  AS reap_count,
              json_extract(j.payload, '$.taskType') AS task_type,
              json_extract(j.payload, '$.seasons')  AS seasons_json,
              s.name        AS series_name,
              m.name        AS movie_name
         FROM jobs j
         LEFT JOIN series s ON s.id = j.series_id
         LEFT JOIN movies m ON m.id = j.movie_id
        WHERE j.state = 'dormant'
        ORDER BY j.updated_at DESC`,
    )
    .all() as Array<DormantJobRow & { kind: string; attempt: number; reap_count: number; task_type: string | null }>

  return rows.map((row) => ({
    jobId: row.id,
    task: row.task_type ?? row.kind,
    targetLabel: dormantTargetLabel(row),
    attempts: Math.max(row.attempt, row.reap_count),
  }))
}
```

（`ScoutDb` 类型在 `apiV2.ts` 里已经引入——照抄 `buildWorkflowWorkers` 的签名写法。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/dashboard/apiV2.test.ts && npm run check
```

预期：全绿。`check` 尤其重要——`apiV2.ts` 的导出类型变动会连带影响 `src/**` 全部测试文件的编译。

- [ ] **Step 5: 提交**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/dashboard/apiV2.ts src/dashboard/apiV2.test.ts
git commit -m "feat(plan-c): dormant 任务 DTO 四键封闭 + targetLabel 组装纯函数"
```

---

### Task 4: 两个 GET 上路由 + server 接线 + 401 回归锁

**Files:**
- Modify: `src/dashboard/router.ts`（`RouterDeps` 接口 + `handleApiRoute` 注册）
- Modify: `src/dashboard/server.ts`（`const deps: RouterDeps` 在 `:235` 区域）
- Test: `src/dashboard/router.test.ts`, `src/dashboard/server.test.ts`

**为什么走 `handleApiRoute` 而不是 server.ts 的独立 rawPath 分支：** 两个端点都是**纯同步 GET**，没有 body 解析、没有 await。`router.ts` 的既有注释写死了这条分界（"四个都是纯同步 GET，走这个纯函数路由表；写入端点……落在 server.ts 的独立 rawPath 分支"）。`/api/v2/subtitle/shifted` 需要一次 `existsSync` 探测——这**不违反** "纯函数路由本身不摸文件系统"，因为 I/O 关在 server.ts 注入的闭包里，同 `fsList` 先例（`router.ts:20-24` 注释明说这个手法）。

**鉴权不需要写任何代码：** 唯一的门是 `server.ts:344` 的统一前置门（`if (!authed) { 401 }`），它在 `handleApiRoute` 分发**之前**。两个新路径自动落在门后。但**必须加测试**把这件事钉住（spec §9 要求"两端点鉴权：无 token 401"）——将来有人把门挪位置时，测试会响。

- [ ] **Step 1: 写失败的测试**

`src/dashboard/router.test.ts`，在 `describe('handleApiRoute (v2)', ...)` 内追加：

```ts
  it('GET /api/v2/subtitle/shifted → 200 + 透传 deps.shiftedSubtitles()', () => {
    const rows = [{
      itemId: 'tmdb:100/s2e3', seriesId: 'tmdb:100', seriesName: 'The Rig',
      season: 2, episode: 3, checkedAt: 3000, hasPriorCorrection: true,
    }]
    const r = route('/api/v2/subtitle/shifted', { deps: { shiftedSubtitles: () => rows } })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(rows)
  })

  it('GET /api/v2/workflow/dormant → 200 + 透传 deps.dormantTasks()', () => {
    const rows = [{ jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5 }]
    const r = route('/api/v2/workflow/dormant', { deps: { dormantTasks: () => rows } })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(rows)
  })
```

**先读 `src/dashboard/router.test.ts:100-110` 看清那个 `route(...)` 辅助函数的真实签名再落笔**（`:105` 是 `handleApiRoute({ pathname, query: opts.query ?? {} }, deps)`）。如果它不接受 per-call 的 deps 覆盖，就照文件里既有用例的写法构造完整 deps 桩，**不要**改辅助函数的签名去迁就新用例。

`src/dashboard/server.test.ts`，照文件里既有的"无 token 撞 401"用例的写法追加两条：

```ts
  it('两个 Plan C 只读端点：无凭据 401，带 session 200 且为空清单', async () => {
    for (const path of ['/api/v2/subtitle/shifted', '/api/v2/workflow/dormant']) {
      const res = await fetch(`${base}${path}`)
      expect(res.status).toBe(401)
    }
  })
```

**先读 `server.test.ts` 里既有的 401 用例**（`:267` 区域附近有关于"method-then-token 校验顺序"的注释），照它的 fixture 起服务方式写——`base` / 起停 server 的写法以文件现状为准，不要自己发明。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/dashboard/router.test.ts src/dashboard/server.test.ts
```

预期：router 两条 FAIL（404，路径未注册）；server 两条视鉴权门现状可能已经通过——**如果它们一开始就绿，那是好事**（说明统一门确实覆盖），保留测试作为回归锁，在 Step 3 之后再确认仍绿。

- [ ] **Step 3: 写实现**

`src/dashboard/router.ts`：顶部 import 类型块里追加 `ShiftedItemDTO`（来自 `'./subtitleVerifyApi.js'`）与 `DormantTaskDTO`（来自 `'./apiV2.js'`）。`RouterDeps` 接口在 `runTrace` 之后追加：

```ts
  /** Plan C（spec §4.1）：GET /api/v2/subtitle/shifted——Triage 第三区 + Library 详情偏移行。
   *  纯读。备份文件存在性探测（hasPriorCorrection）关在 server.ts 的注入闭包里，这一层
   *  和 fsList 一样不碰文件系统。 */
  shiftedSubtitles: () => ShiftedItemDTO[]
  /** Plan C（spec §4.2）：GET /api/v2/workflow/dormant——Triage 第四区。纯读，零按钮语义
   *  （唤醒通道本 spec 明确不补，见 spec §3 决策 1）。 */
  dormantTasks: () => DormantTaskDTO[]
```

`handleApiRoute` 里，紧跟在 `/api/v2/workflow/pending` 那一行之后追加：

```ts
  // ---- Plan C 两个只读 GET（spec §4）：零写路径、零状态机改动 ----
  if (pathname === '/api/v2/subtitle/shifted') return { status: 200, json: deps.shiftedSubtitles() }
  if (pathname === '/api/v2/workflow/dormant') return { status: 200, json: deps.dormantTasks() }
```

`src/dashboard/server.ts`：顶部 import 里，从 `'./subtitleVerifyApi.js'` 的既有 import 块追加 `buildShiftedDTOs`，从 `'./apiV2.js'` 的既有 import 块追加 `buildDormantTasks`。`const deps: RouterDeps = {` 里，在 `runTrace` 之后追加：

```ts
    // Plan C：两个只读 GET。shifted 复用 subDeps 的 repo + exists（同一份 existsSync 实现，
    // 见上方 subDeps 的 wiring），backupSuffix 用与两个写扳手同一个常量——三处必须同源，
    // 否则 UI 上"可撤销"与后端"撤销会成功"会错位。
    shiftedSubtitles: () => buildShiftedDTOs(
      { repo: verifyRepo, exists: subDeps.exists },
      { backupSuffix: BACKUP_SUFFIX },
    ),
    dormantTasks: () => buildDormantTasks(db),
```

（`BACKUP_SUFFIX` 已在 server.ts 顶部引入——`:661` 已在用它。`verifyRepo` 在 `:199`、`subDeps` 在 `:200`，都在 `deps` 之前，无 TDZ 问题。）

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/dashboard/ && npm run check
```

预期：全绿。**如果 `router.test.ts` 里别的用例开始报 "missing property shiftedSubtitles"**，说明那些用例在构造完整 deps 对象——把两个新键补进它们的桩（返回 `[]` 即可），这是接口扩张的正常代价，不是设计问题。

- [ ] **Step 5: 提交**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add src/dashboard/router.ts src/dashboard/router.test.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat(plan-c): 两个只读 GET 上路由与 server 接线，鉴权门覆盖加回归锁"
```

---

### Task 5: 前端数据层接两个新 GET

**Files:**
- Modify: `web/src/api/types.ts`（末尾追加）
- Modify: `web/src/api/client.ts`（`api` 对象里，`subtitleVerify` 之后）
- Modify: `web/src/api/hooks.ts`（末尾追加两个 hook）

**惯例说明：** 本仓前端**手抄**后端 DTO 类型到 `web/src/api/types.ts`，不共享类型包（`web/tsconfig.json` 的 `include` 只有 `web/src`，够不到 `src/`）。抄的时候把后端那段"为什么某字段不存在"的注释一起带过来——那是防止后人"顺手补字段"的唯一屏障。

- [ ] **Step 1: 加类型**

`web/src/api/types.ts` 末尾追加：

```ts
/** Plan C（spec §4.1）：GET /api/v2/subtitle/shifted 的行。后端 `ShiftedItemDTO` 的手抄件。
 *  **七键封闭**——`offsetMs`/`score`/`referenceTier`/`detail` 在 API 层就被剥掉了（铁律②），
 *  前端想犯错也拿不到字段。四个媒体字段可 null（电影行或库里已无此集），此时降级 mono
 *  itemId 占位（spec §8）。 */
export interface ShiftedItemDTO {
  itemId: string
  seriesId: string | null
  seriesName: string | null
  season: number | null
  episode: number | null
  checkedAt: number
  /** 有没有可还原的在先校正 = Undo 按钮给不给点。后端探的是备份文件存在性，与 revert
   *  自己的前置门同源，所以"能点"与"点了会成功"天然一致——仍可能被 C-A1 陈旧门拒
   * （保护性拒绝，非按钮状态错误）。 */
  hasPriorCorrection: boolean
}

/** Plan C（spec §4.2）：GET /api/v2/workflow/dormant 的行。后端 `DormantTaskDTO` 的手抄件。
 *  **四键封闭。** 刻意没有 reason（现网是中文内部串，不透传——英文句子前端用 attempts 组）
 *  也没有任何时刻字段（草稿 6 的 dormant 行不渲染时刻）。**零按钮**：唤醒通道 spec 明确
 *  不补（§3 决策 1），别在 UI 上画一个打不通的按钮。 */
export interface DormantTaskDTO {
  jobId: number
  /** 裸工具名（如 `find_subtitle`），mono 弱显。 */
  task: string
  targetLabel: string
  attempts: number
}
```

- [ ] **Step 2: 加 client 包装**

`web/src/api/client.ts`：顶部 `from './types.js'` 的 import 块里追加 `ShiftedItemDTO, DormantTaskDTO`；`api` 对象里 `subtitleVerify` 之后追加：

```ts
  // Plan C（spec §4.1）：偏移清单——Triage 第三区与 Library 详情偏移行共用同一份数据。
  subtitleShifted: (signal?: AbortSignal) =>
    get<ShiftedItemDTO[]>('/api/v2/subtitle/shifted', signal),
  // Plan C（spec §4.2）：停车任务清单——只读，零动作。
  workflowDormant: (signal?: AbortSignal) =>
    get<DormantTaskDTO[]>('/api/v2/workflow/dormant', signal),
```

- [ ] **Step 3: 加两个 hook**

`web/src/api/hooks.ts`：顶部 `from './types.js'` 的 import 块里追加 `ShiftedItemDTO, DormantTaskDTO`；文件末尾追加。**逐字照抄既有 hook 的骨架**（`useWorkflowWorkers` 是最近的样板，`:312` 起），只换 `api.*` 调用与类型——`LIBRARY_POLL_MS` 复用、visibilitychange 暂停复用，**不新增更快的轮询节律**（spec §6-2）：

```ts
/** Plan C（spec §4.1）：偏移清单。15s 轮询同既有节律——偏移是"检出后静置"的事实，
 *  不需要更快的刷新（SSE 只喂在跑任务的痕迹，与这里无关）。 */
export function useShiftedSubtitles(): Async<ShiftedItemDTO[]> {
  const [data, setData] = useState<ShiftedItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.subtitleShifted()
      setData(rows)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}

/** Plan C（spec §4.2）：停车任务清单。同 15s 节律。 */
export function useDormantTasks(): Async<DormantTaskDTO[]> {
  const [data, setData] = useState<DormantTaskDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.workflowDormant()
      setData(rows)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}
```

- [ ] **Step 4: 类型检查 + 全量前端测试**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx tsc --noEmit && npm test
```

预期：`tsc` 无输出；测试全绿（本任务纯增量，不该动到任何既有断言）。

**本任务没有新增单测**，理由：这三处都是逐字复制既有样板的样板代码（类型声明 / 一行 `get` 包装 / 与 `useWorkflowWorkers` 逐字同构的轮询骨架），仓库里既有的四个同构 hook 也都没有各自的单测——真正的行为契约在消费方的组件测试里（Task 22-24 会通过 mock `api` 覆盖这两个 hook 的数据路径）。给它们补三个"复制粘贴对了吗"的测试是仪式，不是保障。

- [ ] **Step 5: 提交**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/api/types.ts web/src/api/client.ts web/src/api/hooks.ts
git commit -m "feat(plan-c): 前端数据层接偏移清单与停车清单两个只读 GET"
```

---

---

## 阶段二 · 组件底座层（Task 6-11）

这一层不碰任何屏幕。它只做三件事：把新栈缺的依赖和 CSS 动画层补齐（Task 6）、把 shadcn 通用件 copy-in 并解决 Radix 在 jsdom 里的可测性（Task 7-8）、把 AI Elements 四件 copy-in 并本地化（Task 9-11）。**Task 12 起才动屏幕**，届时所有底座件都已有测试锁。

底座层的共同纪律（每个任务都适用，不再重复）：

- **copy-in 不是 npm 装**：shadcn/AI Elements 的源码抄进 `web/src/components/`，此后归本仓维护；每个文件头两行注释写清"抄自哪里 + 本仓改了什么"，审计据此逐条核销。
- **四条 copy-in 改造铁规**：① 相对 import 且带 `.js` 后缀（本仓无 `@/` alias，`web/src` 全量惯例）；② 删掉所有 `dark:` 变体（Tailwind v4 的 `dark:` 默认等于 `@media (prefers-color-scheme: dark)`，本仓恒暗色且从不挂 `.dark` 类，留着会让外观跟着操作系统走）；③ 圆角按本仓 token 换（弹层/卡面 `rounded-card`、控件 `rounded-control`，其余保留 shadcn 原 `rounded-md`）；④ 颜色只用 §5.1 表里的 token，禁止 `text-green-600` 这类 Tailwind 调色板裸色。
- **`React.ComponentProps<'x'>` + `data-slot` 房规**：与 Plan A Task 14 已落地的 `button.tsx`/`input.tsx`/`switch.tsx`/`card.tsx` 保持同一写法（`import * as React from 'react'`、每个根节点带 `data-slot`、`cn` 来自 `'../../lib/utils.js'`）。

---

### Task 6: 新栈依赖进场 + tw.css 补动画层与 accordion/skeleton keyframes

**Files:**
- Modify: `web/package.json`（依赖区）
- Modify: `web/src/tw.css`（Plan A Task 13 建立的文件，本任务只做两处追加）

**为什么这个任务必须在 Task 7 之前**：Task 7 抄进来的 dialog/alert-dialog/select 三件用了 `animate-in` / `animate-out` / `fade-in-0` / `fade-out-0` / `zoom-in-95` / `zoom-out-95` 六个 utility，accordion 用了 `animate-accordion-down` / `animate-accordion-up`。**这八个 class 没有一个来自 Tailwind v4 核心**：前六个来自 `tw-animate-css`（v3 时代 `tailwindcss-animate` 插件的 v4 继任者），后两个要靠本仓自己声明 `--animate-*` token + keyframes（写计划时的判断；实际装到的 tw-animate-css@1.4.0 已自带 accordion 一对——本仓仍显式声明是有意的版本钉，见 Step 5 块内注释）。缺了它们，Tailwind 会**静默地不生成任何规则**——组件照样渲染、测试照样绿、只是弹层没有过渡动画，而且没有任何报错指向病因。所以本任务的验收里有一条硬检查（Task 7 Step 12 的 dist grep）专门抓这个静默失败。

**依赖清单与安装方式的裁决**：

| 包 | 位置 | 谁要用 |
|---|---|---|
| `lucide-react` | dependencies | Task 7 accordion/dialog/select 的图标，Task 8 banner 的状态图标，Task 10-11 的 queue/task/tool |
| `motion` | dependencies | Task 10 shimmer（`motion/react`） |
| `@radix-ui/react-collapsible` | dependencies | Task 7 collapsible → Task 10-11 的 queue/task/tool 全都建在它上面 |
| `@radix-ui/react-accordion` | dependencies | Task 7 accordion → Task 19-21 季手风琴 |
| `@radix-ui/react-dialog` | dependencies | Task 7 dialog → Task 28-29 ⌘K、Task 30 RunDetail |
| `@radix-ui/react-alert-dialog` | dependencies | Task 7 alert-dialog → Task 30 RerunDialog |
| `@radix-ui/react-select` | dependencies | Task 7 select → Task 25 `hardsub_mode` |
| `tw-animate-css` | **devDependencies** | 纯 CSS、只在构建期被 `@import` 消费，运行时零 JS |

**这里故意跟 Plan A Task 12 的做法不一致，审计不要判为漂移**：Plan A 是"先手写 pinned 版本号进 `package.json`，再 `npm install`"；本任务是"直接 `npm install <包名>`（不钉版本）"。理由是 Plan A 钉的六个包我当时逐个核过版本号，而这八个包的最新版本我在写计划时无法保证——写错一个 pin，执行者拿到的是 `ERESOLVE`/404 死路，而它没有上网核版本的手段；`npm install` 让 npm 自己解析出可安装的版本并写回 `package.json`，这也是 shadcn 官方文档的做法。**代价是版本号由安装时刻决定**，所以 Step 3 的核查只查"键在不在"，不查版本号。

- [ ] **Step 1: 装七个运行时依赖**

```bash
cd web && npm install lucide-react motion @radix-ui/react-collapsible @radix-ui/react-accordion @radix-ui/react-dialog @radix-ui/react-alert-dialog @radix-ui/react-select
```

预期：`added N packages` 且无 `ERESOLVE`。若出现 peer 冲突（本仓 React 19），**先读报错再决定**，不要盲加 `--legacy-peer-deps`——Radix 全家和 lucide/motion 都已支持 React 19，出冲突说明装错了包名。

- [ ] **Step 2: 装一个构建期依赖**

```bash
cd web && npm install -D tw-animate-css
```

- [ ] **Step 3: 核查八个键都进了 package.json**

```bash
cd web && for pkg in lucide-react motion @radix-ui/react-collapsible @radix-ui/react-accordion @radix-ui/react-dialog @radix-ui/react-alert-dialog @radix-ui/react-select tw-animate-css; do grep -q "\"$pkg\"" package.json && echo "OK   $pkg" || echo "MISS $pkg"; done
```

预期：八行全是 `OK`。

**为什么用 grep 而不是 `node -e "require('./package.json')"`**：`web/package.json` 和仓根 `package.json` 都是 `"type": "module"`，`require` 在这个包域里直接抛 `ERR_REQUIRE_ESM`，那条看起来更"正规"的检查在本仓是必错的。

- [ ] **Step 4: tw.css 追加 tw-animate-css 的 @import**

在 `web/src/tw.css` 里找到这一行（Plan A Task 13 写下的，全文件唯一）：

```css
@import "tailwindcss/utilities.css" layer(utilities);
```

在它**正下方**插入两行：

```css
/* tw-animate-css：animate-in / animate-out / fade-* / zoom-* / slide-* 这一族 enter-exit 动画 utility。
   Tailwind v4 核心不含它们；shadcn 的 dialog/alert-dialog/select 与 AI Elements 的 task/tool 全靠它。 */
@import "tw-animate-css";
```

（css 注释里通配符与斜杠之间必须留空格：`fade-*` 与 `/zoom-*` 连写成 `fade-*/zoom-*` 时，星号加斜杠会提前终止 CSS 注释，构建直接挂——初版此处踩过，vite 报 `Invalid declaration`。教训写在这里而不是 css 块里，免得复制时把活弹药又带回去。）

**两条不能违反的位置约束**：

1. **必须在文件顶部的 `@import` 区里**，不能挪到文件末尾。CSS 规范要求 `@import` 出现在任何样式规则之前（只允许 `@charset` 和 `@layer` 语句在它前面），放到后面会被解析器**直接丢弃**——又是一次静默失败。
2. **不要包 `layer(...)`**。`tw-animate-css` 内部是用 `@utility` 声明的，Tailwind 自己会把这些 utility 编进 utilities 层；外面再套一层 `layer(utilities)` 会让 Tailwind 拿到的不是可处理的 `@utility` 而是被提前分层的普通规则。

- [ ] **Step 5: tw.css 末尾追加第二个 @theme**

把下面整块**追加到 `web/src/tw.css` 文件末尾**：

```css

/* ── 第二个 @theme：Tailwind v4 会合并同一文件里的多个 @theme 块，所以上面 Plan A 那块
      保持逐字节不动，新增全部落在这里（这样 Task 32 的回归对照能一眼看出本 spec 加了什么）。
      追加到文件末尾而不是插在上一块后面：@theme 的先后顺序不影响结果，末尾追加就不必依赖
      上一块的精确缩进做锚点。 */
@theme {
  /* accordion 展开/收起：shadcn accordion 的 data-state 动画消费这两个变量，Tailwind 会
     据此生成 animate-accordion-down / animate-accordion-up。
     tw-animate-css@1.4.0 其实已自带这一对 token + keyframes（还白送 collapsible-down/up，
     Task 10-11 的 collapsible 动画直接用那对，本仓不另声明）；这里仍显式声明是有意的
     版本钉——依赖哪天升级改值，手风琴的 0.2s ease-out 不跟着漂。行为与自带版一致：
     --radix-accordion-content-height 由 Radix 在运行时注入到元素 style 上，不是本仓 token，
     不要试图在这里给它赋值。 */
  --animate-accordion-down: accordion-down 0.2s ease-out;
  --animate-accordion-up: accordion-up 0.2s ease-out;

  /* skeleton 的呼吸：值逐字取自 Astryx Skeleton（src/Skeleton/Skeleton.tsx:44-71）——
     keyframes 0.25 → 1、时长 --duration-medium-max = 550ms、steps(10, end)、infinite alternate。
     Task 7 的 skeleton.tsx 用 animate-skeleton-fade 消费它，并另配 motion-reduce:animate-none
     复刻 Astryx 的 prefers-reduced-motion 分支。 */
  --animate-skeleton-fade: skeleton-fade 550ms steps(10, end) infinite alternate;

  /* keyframes 必须写在 @theme 内部。写在 @theme 外面时，Lightning CSS 在没有静态引用的情况下
     可能把它们当死代码清掉（引用只出现在 --animate-* 变量的值里，不是它能看见的 animation 简写）。 */
  @keyframes accordion-down {
    from { height: 0; }
    to { height: var(--radix-accordion-content-height); }
  }
  @keyframes accordion-up {
    from { height: var(--radix-accordion-content-height); }
    to { height: 0; }
  }
  @keyframes skeleton-fade {
    from { opacity: 0.25; }
    to { opacity: 1; }
  }

  /* Astryx 退役前补齐的三个缺口 token。三个值全部有出处，零发明：
     --color-fn-amber       = Astryx 暗色 --color-warning       #F2C00B
     --color-fn-amber-muted = Astryx 暗色 --color-warning-muted #E2A4003F
       （这两个是 Task 8 banner.tsx 的 warning 态用色；spec §5.1 的表里没有琥珀色是因为
        它只出现在 banner 这一处，而 banner 今天在 TranslateSection 是活件——
        §5.1 表管的是四屏主色，不是全部功能色。scout.css 未覆盖 Astryx 的这两个值。）
     --color-stage-track = rgba(255,255,255,0.09)，即 spec §5.1 已经写死的阶段条轨道值
       （styles.css:1514-1528）。Task 8 的 segmented.tsx 底槽（Astryx 用 --color-neutral
        #E1E4DA33）复用同一个值，不为"轨道"和"底槽"发明两个近似值。
        前缀 stage- 是换栈过渡期 token 迁移铁律逼出来的：裸名 --color-track 已被
        scout.css:110 / scout.js:43 / astryx.css:48 三方占用，同名会被 Astryx 产品面反遮蔽，
        改名前已 grep 验证两处均无 stage-track。 */
  --color-fn-amber: #f2c00b;
  --color-fn-amber-muted: #e2a4003f;
  --color-stage-track: rgba(255, 255, 255, 0.09);
}
```

**复盘记录（2026-08-03，Task 6 代码评审抓到，已修）**：本块初版用裸名 `--color-track`，直接违反换栈过渡期 token 迁移铁律——`scout.css:110`、`scout.js:43`、`astryx.css:48` 三方已占用该名，过渡期 scout 值赢，同名 token 会被反遮蔽（Task 8 segmented.tsx 的底槽会拿到 Astryx 的灰绿而不是 spec 的白 9%）。执行时的 scout 碰撞 grep 只查了 amber 两个**值**（warning / F2C00B / E2A400），漏查了 track 这个**名**本身。教训：铁律的碰撞 grep 要名值两查——值有出处不代表名没主。已改名 `--color-stage-track`（改名前 grep 验证 scout.css 与 astryx dist 均无 stage-track）。

- [ ] **Step 6: 确认新 @import 能被解析（构建通过）**

```bash
cd web && npm run build
```

预期：构建成功。若报 `Failed to resolve import "tw-animate-css"`，说明 Step 2 没装上或装到了仓根而不是 `web/`。

**本步只验证"`@import` 能解析"，不验证 utility 是否真被生成**。原因：Tailwind 只为**源码里实际出现过**的 class 生成规则，而此刻 `animate-in` 等 class 在 `web/src` 里还一个都没有，去 grep `dist` 必然是空的。那条 grep 检查归 Task 7 Step 12——那时七个组件已经落地，class 有了真实引用。

- [ ] **Step 7: 提交**

本任务不新增单元测试。理由：改动物是依赖清单与 CSS 变量声明，两者都没有可断言的 JS 行为面；真正的回归锁是 Task 7 Step 12 的 dist grep（抓 CSS 是否真生成）和 Task 7 的 smoke 测试（抓组件是否真能开合）。为一个 `@theme` 块写 `expect(true)` 式的测试是噪音。

```bash
git add web/package.json web/package-lock.json web/src/tw.css
git commit -m "chore(plan-c): 新栈依赖进场 + tw.css 补动画层与 accordion/skeleton keyframes"
```

---

### Task 7: shadcn 七件 copy-in + Radix 在 jsdom 的可测性底座

**Files:**
- Modify: `web/src/setupTests.ts`（追加五个 Radix 需要的 DOM polyfill）
- Create: `web/src/testSupport/radix.ts`
- Create: `web/src/components/ui/badge.tsx`
- Create: `web/src/components/ui/skeleton.tsx`
- Create: `web/src/components/ui/collapsible.tsx`
- Create: `web/src/components/ui/accordion.tsx`
- Create: `web/src/components/ui/dialog.tsx`
- Create: `web/src/components/ui/alert-dialog.tsx`
- Create: `web/src/components/ui/select.tsx`
- Test: `web/src/components/ui/shadcn.smoke.test.tsx`

**这七件为什么是这七件**（对照 spec §5.2 与全仓 `*ByRole` 普查）：`badge` 只有 Task 11 的 `tool.tsx` 要用（全仓现无 Badge 调用点）；`skeleton` 对应 Library 的四个骨架调用点；`collapsible` 是 Task 10-11 三个 AI Elements 件的共同底座；`accordion` 对应 §5.4 季手风琴；`dialog` 对应 ⌘K 面板（`App.test.tsx:198-225` 锁了 `role="dialog"` + `role="combobox"` + Escape 关闭）与 RunDetail；`alert-dialog` 对应 RerunDialog（全仓 6 处 `alertdialog` 断言）；`select` 对应 `hardsub_mode`（`BehaviorSection.test.tsx:55/88/121` 锁了 `role="combobox"` + `role="option"`）。**不抄 shadcn 的 scroll-area / label / tooltip / dropdown-menu**：scroll-area 被 Task 10 的改造删掉了（见那里），label 在 Plan A Task 14 已裁掉（本仓用 `aria-label` 而非 `<label htmlFor>`），tooltip 的唯一调用点是 `CompareTimeline.test.tsx:176`（Task 30 自绘，不值得为一处引 `@radix-ui/react-tooltip`），dropdown-menu 全仓零调用点。

- [ ] **Step 1: 先补 jsdom 的 Radix 底座（polyfill + Select 开合助手）**

Radix 的弹层组件在 jsdom 里会直接崩，因为 jsdom 不实现 Pointer Capture、`scrollIntoView` 和 `ResizeObserver`。把下面整块**追加到 `web/src/setupTests.ts` 末尾**：

```ts
// ── Radix 在 jsdom 里缺的五个 DOM 能力。Radix 的 Select/Dialog 一族会无条件调用它们，
// 不补的话测试会抛 "target.hasPointerCapture is not a function" 之类的错，
// 而不是给出一个和组件行为有关的失败信息。
// 这里用无条件赋值（而不是 `if (!Element.prototype.x)` 守卫）：本仓 tsconfig 下读取
// 一个 TS 认为"必然存在"的属性做真值判断会触发 TS2774（把方法引用当条件用），
// 无条件覆盖既躲开它，语义上也无损——jsdom 里没有真实现可覆盖。
Element.prototype.hasPointerCapture = () => false
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
Element.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver = class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
```

然后新建 `web/src/testSupport/radix.ts`：

```ts
// Radix Select 的触发器监听的是 pointerdown，不是 click——用 fireEvent.click 打它，
// 下拉永远不会开，而且测试的失败信息只会是"找不到 option"，非常难反查。
// 全仓所有需要打开 Select 的测试都走这个助手，别各自 fireEvent.pointerDown。
//
// 为什么不能直接 fireEvent.pointerDown(trigger, {button: 0, ...})：jsdom 没有
// PointerEvent（jsdom#2527），testing-library 会退化成裸 Event，init 里的
// button/ctrlKey/pointerType/pointerId 全部被构造器丢弃；而 Radix 2.x 的 Trigger
// 要求 event.button === 0 && event.ctrlKey === false && event.pointerType === 'mouse'
// 三者齐备才开单。所以这里手工构造 MouseEvent（button/ctrlKey 走构造器），
// 再补挂两个 pointer 属性（defineProperty 挂在实例上，React 合成事件读得到）。
// 同理，将来要断言 Radix 用 pointermove 维护的 data-highlighted，也得这样手工构造
// pointermove——fireEvent.pointerMove 在同一个坑里（裸 Event 丢光坐标与 button）。
import { fireEvent } from '@testing-library/react'

export function openRadixSelect(trigger: HTMLElement): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ctrlKey: false,
  })
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  })
  fireEvent(trigger, event)
}
```

（2026-08-03 审计对齐：本代码块已替换为实际落地的 MouseEvent 版本——原 `fireEvent.pointerDown(trigger, { pointerId: 1, button: 0, ctrlKey: false })` 一行版在 jsdom 下打不开 Radix 2.3.7 的 Select，根因见块内注释；Step 11 的排错提示未覆盖这一层。同轮另有三处**纯注释**对齐，产品行为零变化：skeleton.tsx 调用点计数四个→五个（SeriesGrid ×2 传 index、SeriesPage ×3 吃默认）、CompareTimeline.tsx 的 setPointerCapture 注释更新为"jsdom 里是 setupTests 的无操作垫片、真实老引擎仍可能缺席"、SeasonAccordion.test.tsx 的 ResizeObserver 注释更新为"全局垫片是 no-op、本文件另 stub 会回调的功能版"。）

- [ ] **Step 2: 写失败的 smoke 测试**

新建 `web/src/components/ui/shadcn.smoke.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion.js'
import { Badge } from './badge.js'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible.js'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js'
import { Skeleton } from './skeleton.js'
import { openRadixSelect } from '../../testSupport/radix.js'

describe('shadcn copy-in smoke', () => {
  it('accordion 点开区头后内容可见', () => {
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="s1">
          <AccordionTrigger>Season 1 has 6 of 8 episodes covered</AccordionTrigger>
          <AccordionContent>episode grid</AccordionContent>
        </AccordionItem>
      </Accordion>,
    )
    expect(screen.queryByText('episode grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Season 1 has 6 of 8 episodes covered' }))
    expect(screen.getByText('episode grid')).toBeVisible()
  })

  it('collapsible 默认收起、点击后展开', () => {
    render(
      <Collapsible>
        <CollapsibleTrigger>Up next</CollapsibleTrigger>
        <CollapsibleContent>queued rows</CollapsibleContent>
      </Collapsible>,
    )
    expect(screen.queryByText('queued rows')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Up next' }))
    expect(screen.getByText('queued rows')).toBeVisible()
  })

  it('dialog 打开后按 Escape 关闭', async () => {
    render(
      <Dialog>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent>
          <DialogTitle className="sr-only">Run detail</DialogTitle>
          body
        </DialogContent>
      </Dialog>,
    )
    fireEvent.click(screen.getByText('open'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('select 关闭时选项不可及，pointerdown 打开后可及', async () => {
    render(
      <Select>
        <SelectTrigger aria-label="Hardsub assumption">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Off</SelectItem>
          <SelectItem value="agent">Agent</SelectItem>
        </SelectContent>
      </Select>,
    )
    const trigger = screen.getByRole('combobox', { name: 'Hardsub assumption' })
    expect(screen.queryByRole('option', { name: 'Off', hidden: true })).toBeNull()
    openRadixSelect(trigger)
    expect(await screen.findByRole('option', { name: 'Off', hidden: true })).toBeInTheDocument()
  })

  it('badge 出文案、skeleton 按 index 排错动画延迟', () => {
    render(
      <>
        <Badge variant="secondary">Running</Badge>
        <Skeleton className="h-3 w-1/2 rounded-sm" data-testid="sk" index={2} />
      </>,
    )
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('sk')).toHaveStyle({ animationDelay: '1200ms' })
  })
})
```

**这五个断言各自锁的是什么**（不是凑数）：accordion/collapsible 锁"Radix 在 jsdom 里真能开合"（polyfill 装对了）；dialog 锁 `App.test.tsx:198-225` 已有的 ⌘K 契约里最容易被换栈弄坏的一环（Escape 关闭），并且 `DialogTitle` 用 `sr-only` 出现是为了让 Radix 的无障碍告警永不触发——Radix 缺 Title 时会往 console 打警告，那种警告在 CI 里很容易被当噪音忽略掉；select 锁"关闭时 option 不可及、`pointerDown` 才打开"这条最反直觉的行为，同时证明 `hidden: true` 查询既安全又有意义（Radix 关闭时把 `SelectContent` 的子树留在一个**脱离文档**的 portal 里，所以关闭态 `queryByRole` 拿不到它）；skeleton 锁 Astryx 的 `DELAY_TIME + STAGGER_TIME * index` 交错时序（1000 + 100×2 = 1200ms）没在换栈时丢掉。

- [ ] **Step 3: 跑测试确认它红**

```bash
cd web && npx vitest run src/components/ui/shadcn.smoke.test.tsx
```

预期：FAIL，报 `Failed to resolve import "./accordion.js"` 一类的模块解析错误（七个文件还不存在）。

- [ ] **Step 4: 抄 badge.tsx**

新建 `web/src/components/ui/badge.tsx`：

```tsx
// web/src/components/ui/badge.tsx：shadcn/ui Badge（new-york，v4）copy-in。
// 本仓改造：相对 import + .js 后缀；删 dark: 变体；保留 shadcn 原 rounded-md（Badge 是小方角标签，
// 不进本仓 card/control 两档圆角体系）。唯一调用点是 Task 11 的 tool.tsx。
import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils.js'

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'span'
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
```

- [ ] **Step 5: 抄 skeleton.tsx（与 Astryx 调用点对账过的版本）**

新建 `web/src/components/ui/skeleton.tsx`：

```tsx
// web/src/components/ui/skeleton.tsx：shadcn/ui Skeleton copy-in，但**行为取自 Astryx**
// （node_modules/@astryxdesign/core/src/Skeleton/Skeleton.tsx:32-71），因为本仓五个调用点
// （SeriesGrid.tsx:37/39、SeriesPage.tsx:37/40/41）依赖的是 Astryx 的交错延迟语义：
//   DELAY_TIME=1000ms 起播（快速加载时根本不闪骨架）+ STAGGER_TIME=100ms × index 逐个错开。
//   SeriesPage 的三个调用点不传 index，吃默认 0 → 延迟 1000ms，与 Astryx 原件的默认值一致。
// shadcn 原版只有一句 animate-pulse，没有 delay/stagger，直接用会把这个语义丢掉。
// 动画本体是 tw.css 的 --animate-skeleton-fade（550ms steps(10,end) infinite alternate，
// keyframes 0.25 → 1），逐字复刻 Astryx。
//
// 三处有意的取舍（审计对照 Astryx 原件时会看到差异，都是明知故犯）：
// 1. 底色用 --color-faint (#4b5563)，不用 Astryx scout 暗色 --color-skeleton (#44483C)。
//    #44483C 是橄榄色（68,72,60），是 Astryx 主题的遗留色调；新栈调色板（spec §5.1）里没有
//    橄榄色，而 #4b5563（75,85,99）明度基本相当、色相中性。换的是色相，不是明度。
// 2. 不实现 Astryx 的 @media (prefers-contrast: more) 提对比分支——本仓无高对比需求登记，YAGNI。
// 3. **不给默认圆角**。本仓五个调用点全部显式传 radius（radius={2}=8px / radius={1}=4px），
//    换栈后改为传 className；如果组件里再写一个默认 rounded-card，"谁赢"就取决于 tailwind-merge
//    是否把自定义 radius 后缀（card / control）识别成同一冲突组——v3 对非 t-shirt-size 的自定义
//    后缀不保证合并，赌不起。所以圆角一律由调用点给。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

const DELAY_MS = 1000
const STAGGER_MS = 100

function Skeleton({
  className,
  index = 0,
  style,
  ...props
}: React.ComponentProps<'div'> & { index?: number }) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-skeleton-fade bg-faint opacity-25 motion-reduce:animate-none', className)}
      style={{ animationDelay: `${DELAY_MS + STAGGER_MS * index}ms`, ...style }}
      {...props}
    />
  )
}

export { Skeleton }
```

- [ ] **Step 6: 抄 collapsible.tsx**

新建 `web/src/components/ui/collapsible.tsx`：

```tsx
// web/src/components/ui/collapsible.tsx：shadcn/ui Collapsible copy-in（零改造，纯透传）。
// Task 10-11 的 queue / task / tool 三件全都建在它上面。
import * as React from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'

function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
```

- [ ] **Step 7: 抄 accordion.tsx**

新建 `web/src/components/ui/accordion.tsx`：

```tsx
// web/src/components/ui/accordion.tsx：shadcn/ui Accordion copy-in。
// 本仓改造：相对 import + .js；删 dark:；触发器圆角 rounded-md → rounded-control（焦点环形状
// 跟本仓控件一致）；**删掉 shadcn 原有的 hover:underline**——本仓季区头是一整句英文
// （"Season 2 has 6 of 8 episodes covered"，library/text.ts:21-23），整句 hover 下划线噪音很大。
import * as React from 'react'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { ChevronDownIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'

function Accordion({ ...props }: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  return <AccordionPrimitive.Root data-slot="accordion" {...props} />
}

function AccordionItem({ className, ...props }: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('border-b last:border-b-0', className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'flex flex-1 items-start justify-between gap-4 rounded-control py-4 text-left text-sm font-medium outline-none transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 translate-y-0.5 text-muted-foreground transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
      {...props}
    >
      <div className={cn('pt-0 pb-4', className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
```

注意 `border-b` 只设边宽不设颜色——颜色来自 Plan A Task 13 在 `tw.css` 里落的 `@layer base { *, ::before, ::after { border-color: var(--color-border) } }`。这也是那条 base 规则存在的原因，不要删。

- [ ] **Step 8: 抄 dialog.tsx**

新建 `web/src/components/ui/dialog.tsx`：

```tsx
// web/src/components/ui/dialog.tsx：shadcn/ui Dialog copy-in。
// 本仓改造：相对 import + .js；删 dark:；内容面圆角 rounded-lg → rounded-card；
// 内容面底色 bg-background → bg-card（#111318）——shadcn 原版用 bg-background，
// 但本仓页面底本身就是 --background (#0b0c0f)，弹层用同色会跟页面糊在一起；
// spec §5.1 把 --card 定义为"卡片底"，模态是浮在页面上的卡面。遮罩保留 shadcn 的 bg-black/50。
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { XIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-card border bg-card p-6 shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-lg leading-none font-semibold', className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
```

- [ ] **Step 9: 抄 alert-dialog.tsx**

新建 `web/src/components/ui/alert-dialog.tsx`：

```tsx
// web/src/components/ui/alert-dialog.tsx：shadcn/ui AlertDialog copy-in。
// 本仓改造：相对 import + .js；删 dark:；内容面 rounded-lg → rounded-card、bg-background → bg-card
// （同 dialog.tsx 的理由）；Action/Cancel 复用 Plan A Task 14 已落地的 buttonVariants，
// 不重复声明一套按钮样式（DRY）。唯一调用点是 Task 30 的 RerunDialog。
import * as React from 'react'
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog'
import { buttonVariants } from './button.js'
import { cn } from '../../lib/utils.js'

function AlertDialog({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Root>) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />
}

function AlertDialogTrigger({ ...props }: React.ComponentProps<typeof AlertDialogPrimitive.Trigger>) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
}

function AlertDialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Overlay>) {
  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  )
}

function AlertDialogContent({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal">
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-card border bg-card p-6 shadow-lg duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg',
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

function AlertDialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      className={cn('text-lg font-semibold', className)}
      {...props}
    />
  )
}

function AlertDialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

function AlertDialogAction({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return <AlertDialogPrimitive.Action className={cn(buttonVariants(), className)} {...props} />
}

function AlertDialogCancel({
  className,
  ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    />
  )
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogTitle,
  AlertDialogTrigger,
}
```

- [ ] **Step 10: 抄 select.tsx（只留五件）**

新建 `web/src/components/ui/select.tsx`：

```tsx
// web/src/components/ui/select.tsx：shadcn/ui Select copy-in。
// 本仓改造：
// 1. 相对 import + .js；删 dark:；触发器圆角 rounded-md → rounded-control，弹层 rounded-md → rounded-card。
// 2. **只导出五件**（Select / SelectTrigger / SelectValue / SelectContent / SelectItem）。
//    删掉 SelectGroup / SelectLabel / SelectSeparator / SelectScrollUpButton / SelectScrollDownButton：
//    本仓唯一调用点是 hardsub_mode 的三个枚举值（off/agent/aggressive，apiV2.ts:621），
//    既不分组也不可能长到需要滚动按钮。YAGNI。
// 3. Viewport 去掉 shadcn 的 h-(--radix-select-trigger-height)——那句会把下拉高度钉成一行触发器的高度；
//    保留 w-full min-w-(--radix-select-trigger-width) scroll-my-1（宽度对齐触发器是要的）。
//    滚动由 Content 上的 overflow-y-auto 兜住，这也是删掉两个 ScrollButton 后仍然安全的原因。
import * as React from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import { CheckIcon, ChevronDownIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: 'sm' | 'default' }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "flex w-fit items-center justify-between gap-2 rounded-control border border-input bg-transparent px-3 py-2 text-sm whitespace-nowrap text-foreground outline-none transition-colors data-[size=default]:h-9 data-[size=sm]:h-8 data-[placeholder]:text-weak focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn(
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-card border bg-popover text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        {...props}
      >
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper' && 'w-full min-w-(--radix-select-trigger-width) scroll-my-1',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  )
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2 text-sm outline-none select-none focus:bg-secondary focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
```

- [ ] **Step 11: 跑测试确认全绿 + 类型通过**

```bash
cd web && npx tsc --noEmit && npx vitest run src/components/ui/shadcn.smoke.test.tsx
```

预期：`tsc` 无输出；smoke 五个用例全 PASS。

若 select 用例报"找不到 option"，**先确认 Step 1 的五个 polyfill 真的追加进了 `setupTests.ts`**，再确认测试走的是 `openRadixSelect` 而不是 `fireEvent.click`。

- [ ] **Step 12: 构建并核对八个动画 class 真的进了 CSS（抓 Task 6 的静默失败）**

```bash
cd web && npm run build && for cls in animate-in animate-out fade-in-0 fade-out-0 zoom-in-95 zoom-out-95 accordion-down accordion-up; do grep -rq "$cls" dist --include='*.css' && echo "OK   $cls" || echo "MISS $cls"; done
```

预期：八行全是 `OK`。

- `MISS animate-in` / `animate-out` / `fade-*` / `zoom-*` → Task 6 Step 4 的 `@import "tw-animate-css";` 没生效：要么没装、要么被放到了文件里第一条样式规则之后（CSS 解析器会静默丢弃位置非法的 `@import`）、要么错误地套了 `layer(...)`。
- `MISS accordion-down` / `accordion-up` → Task 6 Step 5 的第二个 `@theme` 没落地，或者 `@keyframes` 被写在了 `@theme` 外面被当死代码清掉。

**只查这八个**。`slide-in-from-top-2` / `slide-out-to-top-2` 这两个也来自 `tw-animate-css`，但它们的引用只出现在 Task 11 的 `task.tsx` / `tool.tsx` 里——此刻源码中无引用，Tailwind 本就不会生成，放进本步的循环会得到一个假失败。那两个由 Task 11 自己核。

- [ ] **Step 13: 提交**

```bash
git add web/src/setupTests.ts web/src/testSupport/radix.ts web/src/components/ui
git commit -m "feat(plan-c): shadcn 七件 copy-in + Radix 在 jsdom 的可测性底座"
```

---

### Task 8: 八个自绘 primitive（Astryx 无 shadcn 对应物的那些）

**Files:**
- Create: `web/src/lib/platform.ts`
- Create: `web/src/components/ui/empty-state.tsx`
- Create: `web/src/components/ui/status-dot.tsx`
- Create: `web/src/components/ui/kbd.tsx`
- Create: `web/src/components/ui/section.tsx`
- Create: `web/src/components/ui/separator.tsx`
- Create: `web/src/components/ui/aspect-ratio.tsx`
- Create: `web/src/components/ui/segmented.tsx`
- Create: `web/src/components/ui/banner.tsx`
- Test: `web/src/components/ui/primitives.test.tsx`

**为什么要自绘这八个**：它们是 Astryx 有、shadcn 没有（或 shadcn 版本与本仓契约不符）的那部分。Task 31 卸载 `@astryxdesign/core` 时这八个是硬依赖，缺一个就有悬空 import 打断构建。**每个的行为与无障碍语义逐字取自 Astryx 源码**（路径写在每个文件头），因为全仓有 105 处 `*ByRole` 断言直接压在这些语义上——把 `role="separator"` 写成 `<hr>`、把 SegmentedControl 的 `role="radio"` 写成普通按钮，都会让既有测试红成一片，而失败信息只会说"找不到某个 role"，不会告诉你是换栈换漏了。

**本任务只按调用点普查落地真正在用的能力**（YAGNI 依据，实现期不要"顺手补全 API"）：

| 组件 | 调用点 | 只实现 |
|---|---|---|
| `EmptyState` | 9 处 | `title` / `description` / `isCompact` / `actions`——**丢掉 Astryx 的 `icon` 与 `headingLevel`**（全仓零使用） |
| `StatusDot` | 3 处（`ProvidersSection.tsx:89`、`TranslateSection.tsx:27`、`RunDetail.tsx:94`） | `variant: success \| error \| neutral`——**丢掉 `isPulsing`**（零使用；活动页 hero 的 1.6s 紫点脉动是 `.act-*` 自绘 CSS，Task 12-18 的地盘，不走这个组件） |
| `Kbd` | 2 处（`Topbar.tsx:76` `mod+k`、`RunDetail.tsx:84` `escape`） | `keys` 一个 prop |
| `Section` | 5 处，**全部是 `<Section padding={4}>`** | 无 prop，`p-4` 写死 |
| `Separator` | 1 处（`RunDetail.tsx:87`），**零 prop** | `orientation`（`aria-orientation` 是契约的一部分，留着）——丢掉 subtle/strong 变体 |
| `AspectRatio` | 1 处（`PosterCard.tsx:37` `ratio={2/3} fit="cover"`） | `ratio` / `fit` |
| `Segmented` | 1 处（`SeriesGrid.tsx:59-63` `value/onChange/items/label`） | 同名四个 prop |
| `Banner` | 1 处（`TranslateSection.tsx:88-122` `status="warning"` + `title`） | `status: warning \| error \| success` + `title` / `description` / `children`——**丢掉 `info`**（零调用点，且 §5.1 调色板没有"信息蓝/信息紫"这一档，现造一个就是发明） |

#### ⚠️ 本 task 通用前提：`--text-*-size` 的 px 值要走 **scout.css**，不要走 Astryx 的 `tokens.stylex.ts`

下面八个文件头的排版换算都写着"逐条取自 Astryx 源码"。**Astryx 源码里的 px 注释是它自己默认主题
的值，本仓不用那套。** `web/src/theme/scout.css:114-124` 把整条 `--font-size-*` 阶梯**重定义**过一
遍，而 `--text-*-size` 全是 `var(--font-size-*)` 的间接引用（`scout.css:125-157`），所以真正落在屏
上的字号是 scout 那一档：

| 语义 token | 解析到 | **本仓实际 px** | Astryx 默认 px | 行盒 = px × leading |
|---|---|---|---|---|
| `--text-body-size` | `--font-size-base` = `0.8125rem` | **13** | 14 | 13 × 1.5385 = 20（weight 400） |
| `--text-label-size` | `--font-size-base` | **13** | 14 | 13 × 1.5385 = 20（weight **500**） |
| `--text-code-size` | `--font-size-base` | **13** | 14 | 13 × 1.5385 = 20（weight 400） |
| `--text-large-size` | `--font-size-lg` = `1rem` | **16** | 17 | 16 × 1.5 = 24（weight **600**） |
| `--text-supporting-size` | `--font-size-sm` = `0.6875rem` | **11** | 12 | 11 × 1.4545 = 16（weight 400） |
| `--text-heading-3-size` | `--font-size-lg` | **16** | 17 | 16 × 1.5 = 24（weight **600**） |
| `--font-size-2xs`（`size` prop 用） | 字面量 `0.5rem` | **8** | 8 | 两侧同值，唯一不受影响的一档 |

（weight 那三个 token：`--font-weight-normal/medium/semibold` = 400/500/600，`scout.css` **没有**
重定义它们，取自 `node_modules/@astryxdesign/core/src/theme/tokens.stylex.ts:333-335`。）

两条推论，实现期照着办：

1. **Tailwind 的 `text-sm`(14px) / `text-xs`(12px) 在这里表达不了上面任何一档**——13 / 11 都不在
   Tailwind 的默认 ramp 上，写 `text-sm` 就是每个字大 1px。一律写任意值 `text-[13px]` /
   `text-[11px]` / `text-[16px]`。`text-[16px]` 与 `text-base` 巧合等值，仍写任意值，为的是让"这个
   数是从 token 算出来的"在代码里看得见。
2. **leading 的写法取决于"这个元素的字号会不会变"。** Astryx 的 `--text-*-leading` 全是**无单位**
   的，而 `sizeStyles` 只设 `fontSize`、不设 `lineHeight`（已逐条核对
   `node_modules/@astryxdesign/core/src/Text/text.stylex.ts:153-185`）——所以只要某个变体只换字号
   （`EmptyState` 的 `isCompact`、`Text` 的 `size` prop），行盒必须跟着字号缩，**只能**写无单位任意
   值 `leading-[1.5385]`。反过来，字号写死不变的调用点（Task 13-18 迁的那些 `<span>`）写 rem 工具类
   是精确等价的、也是已经落地的写法：13 × 1.5385 = 20.0px = `leading-5`、11 × 1.4545 = 16px =
   `leading-4`、16 × 1.5 = 24px = `leading-6`。两种写法都对，别把已落地的 `leading-5` 改回去。

**这一条没有任何测试守得住**：jsdom 不算 computed style，`primitives.test.tsx` 也一条字号断言都没有
（它扫的是 role 与 DOM 结构）。写错的后果是屏上每个字大 1px、而且全绿——所以只能在这里靠纪律。

（一处例外：`kbd.tsx` 的 `text-[10px]`。Astryx 根本没有 `Kbd` 组件，那个值不是换算出来的，是命令面
板这一档小字形的新设计值，**别**按上表去"修正"它。）

- [ ] **Step 1: 写失败的测试**

新建 `web/src/components/ui/primitives.test.tsx`：

```tsx
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AspectRatio } from './aspect-ratio.js'
import { Banner } from './banner.js'
import { EmptyState } from './empty-state.js'
import { Kbd } from './kbd.js'
import { Section } from './section.js'
import { Segmented } from './segmented.js'
import { Separator } from './separator.js'
import { StatusDot } from './status-dot.js'

describe('自绘 primitive 的 role 契约', () => {
  it('EmptyState 是 role=status，标题是 heading，描述不是 <p>', () => {
    render(<EmptyState description="Nothing parked right now." title="All clear" />)
    const region = screen.getByRole('status')
    expect(region).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'All clear' })).toBeInTheDocument()
    // 描述必须是 <div>：调用点会往 EmptyState 里塞块级内容，<p> 不能合法包块级子节点，
    // 浏览器解析器会把它拆出去，导致 SSR/hydration 结构不一致。
    expect(screen.getByText('Nothing parked right now.').tagName).toBe('DIV')
  })

  it('StatusDot 无 label 时对无障碍树隐身', () => {
    render(
      <>
        <StatusDot data-testid="dot" variant="success" />
        <span>Deployed</span>
      </>,
    )
    expect(screen.getByTestId('dot')).toHaveAttribute('aria-hidden', 'true')
  })

  it('StatusDot 传 label 时升级为 role=img（本仓三个调用点全走这条）', () => {
    render(<StatusDot variant="error" label="Failed" />)
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument()
  })

  it('Banner error 是 role=alert', () => {
    render(<Banner status="error" title="Save failed." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed.')
  })

  it('Segmented 换 value 重渲染时 aria-checked 跟着翻', () => {
    const { rerender } = render(
      <Segmented items={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]} label="x" onChange={() => {}} value="a" />,
    )
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('aria-checked', 'true')
    rerender(<Segmented items={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]} label="x" onChange={() => {}} value="b" />)
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true')
  })

  it('Kbd 是 role=img 且可读名由按键组合拼出（jsdom 非苹果平台 → Control）', () => {
    render(<Kbd keys="mod+k" />)
    expect(screen.getByRole('img', { name: 'Control + K' })).toBeInTheDocument()
  })

  it('Kbd 单键也走同一条拼名路径', () => {
    render(<Kbd keys="escape" />)
    expect(screen.getByRole('img', { name: 'Escape' })).toBeInTheDocument()
  })

  it('Section 渲染子节点', () => {
    render(
      <Section>
        <span>panel body</span>
      </Section>,
    )
    expect(screen.getByText('panel body')).toBeInTheDocument()
  })

  it('Separator 是 role=separator 且带 aria-orientation', () => {
    render(<Separator />)
    const sep = screen.getByRole('separator')
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('AspectRatio 把比例落在 style 上', () => {
    render(
      <AspectRatio data-testid="ar" fit="cover" ratio={2 / 3}>
        <img alt="" src="/p.jpg" />
      </AspectRatio>,
    )
    expect(screen.getByTestId('ar').style.aspectRatio).toBe(String(2 / 3))
  })

  it('Segmented 是 radiogroup + radio，并回调选中值', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        items={[
          { label: 'Has gaps', value: 'gaps' },
          { label: 'Fully covered', value: 'covered' },
        ]}
        label="Library filter"
        onChange={onChange}
        value="gaps"
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'Library filter' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Has gaps' })).toHaveAttribute('aria-checked', 'true')
    const other = screen.getByRole('radio', { name: 'Fully covered' })
    expect(other).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(other)
    expect(onChange).toHaveBeenCalledWith('covered')
  })

  it('Banner warning 是 role=alert 且自带状态图标', () => {
    render(<Banner status="warning" title="Translation is paused." />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Translation is paused.')
    // Astryx Banner 在未传 icon 时会渲染一个默认状态图标（Banner.tsx: {icon ?? <Icon …/>}），
    // 本仓唯一调用点就没传 icon——不复刻默认图标等于 Task 31 静默删掉一个屏幕上看得见的字形。
    expect(alert.querySelector('svg')).not.toBeNull()
  })

  it('Banner success 是 role=status（非警报）', () => {
    render(<Banner status="success" title="All roots reachable." />)
    expect(screen.getByRole('status')).toHaveTextContent('All roots reachable.')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认它红**

```bash
cd web && npx vitest run src/components/ui/primitives.test.tsx
```

预期：FAIL，模块解析失败（八个文件还不存在）。

- [ ] **Step 3: 建 platform.ts**

新建 `web/src/lib/platform.ts`：

```ts
// 苹果平台探测。两个消费方：Kbd（mod → ⌘ 还是 Ctrl 的字形）与 Task 9 的 useHotkeys
// （mod → metaKey 还是 ctrlKey）。抽出来是为了两处判定永远一致——一处判成 Mac、
// 另一处判成 Windows 会让"界面上写 ⌘K，按 ⌘K 没反应"这种最难查的 bug 成为可能。
//
// Astryx 的 Kbd 用 useSyncExternalStore 订阅平台变化（src/Kbd/Kbd.tsx）。这里不订阅：
// 运行中的浏览器不会换操作系统，那层订阅在本仓是纯开销。
//
// navigator.platform 已被标记为 deprecated 但所有浏览器仍实现；userAgentData.platform
// 是替代品（Chromium 系有，Safari/Firefox 没有），所以两个都读，优先新的。
// jsdom 里 navigator.platform 是空串 → 返回 false → 测试里 mod 显示为 Ctrl，这是预期的。
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}
```

- [ ] **Step 4: 建 empty-state.tsx**

新建 `web/src/components/ui/empty-state.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 EmptyState。
// 排版逐条换算自 src/EmptyState/EmptyState.tsx 的 stylex.create 块：
//   container      flex-col items-center justify-center text-center gap-4 py-8 px-6
//   compact        gap-2 + p-4
//   textGroup      flex-col items-center max-w-[360px]
//   title          --text-large-size (16px) / semibold / leading 1.5 / 主文本色
//   titleCompact   --text-label-size  (13px)，行高不变
//   description    --text-body-size   (13px) / normal / leading 1.5385 / 次文本色
//   descCompact    --text-supporting-size (11px)，行高不变
//   actions        flex items-center gap-2 mt-1；compact 时改 flex-col
// ⚠️ 上面四个 px 值走的是 scout.css 覆盖后的阶梯（见本 task 开头那张表），不是 Astryx 源码注释里
// 的 17/14/14/12——那是 Astryx 自己默认主题的值，本仓不用。
// 行高写成无单位任意值（leading-[1.5] 等）而不是让 Tailwind 用每个字号的默认行高：compact 只换字号
// 不换行高，靠默认行高会在 11px 档偏出 ~1px（Tailwind text-[11px] 会拿 16px 默认行高，
// 而这里要的是 11 × 1.5385 ≈ 16.9px）。
//
// 与 Astryx 的两处有意差异：
// 1. 丢掉 icon / headingLevel 两个 prop（全仓 9 个调用点零使用）。
// 2. description 用 <div> 不用 <p>（Astryx 的 Banner 文件头对同一问题有说明）：<p> 不能合法
//    包块级子节点，解析器会把它拆开。primitives.test.tsx 把这条锁成回归用例。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function EmptyState({
  title,
  description,
  isCompact = false,
  actions,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  title: string
  description?: React.ReactNode
  isCompact?: boolean
  actions?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      role="status"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        isCompact ? 'gap-2 p-4' : 'gap-4 px-6 py-8',
        className,
      )}
      {...props}
    >
      <div className="flex max-w-[360px] flex-col items-center">
        <h3
          className={cn(
            'm-0 font-semibold leading-[1.5] text-foreground',
            isCompact ? 'text-[13px]' : 'text-[16px]',
          )}
        >
          {title}
        </h3>
        {description != null && (
          <div
            className={cn(
              'm-0 font-normal leading-[1.5385] text-muted-foreground',
              isCompact ? 'text-[11px]' : 'text-[13px]',
            )}
          >
            {description}
          </div>
        )}
      </div>
      {actions != null && (
        <div className={cn('mt-1 flex items-center gap-2', isCompact && 'flex-col')}>{actions}</div>
      )}
    </div>
  )
}

export { EmptyState }
```

- [ ] **Step 5: 建 status-dot.tsx**

新建 `web/src/components/ui/status-dot.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 StatusDot（src/StatusDot/StatusDot.tsx）。
// 逐字保留的：8×8px、正圆、flex-shrink:0。
// 三档色改用 spec §5.1 的功能色（Astryx 的变体色表是它自己主题的，随主题一起退役）：
//   success → --color-fn-green (#28bf5c)
//   error   → --color-fn-red   (#e11d48)
//   neutral → --color-weak     (#6b7280)  ← §5.1"弱文本"，即 Just finished 灰点那一档
// 丢掉 Astryx 的 isPulsing（全仓零使用；hero 紫点的 1.6s 脉动是 .act-* 自绘 CSS）。
//
// 无障碍：不传 label 时整体 aria-hidden。本仓三个调用点的点都紧挨着一段说明文字
// （"Deployed" / "Idle" / 决策短语），再给点配一个 aria-label 只会让读屏器把状态念两遍。
// 传了 label 才升级成 role="img"（预留给"点是唯一状态载体"的将来场景）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

const STATUS_DOT_COLORS = {
  success: 'bg-fn-green',
  error: 'bg-fn-red',
  neutral: 'bg-weak',
} as const

export type StatusDotVariant = keyof typeof STATUS_DOT_COLORS

function StatusDot({
  variant,
  label,
  className,
  ...props
}: React.ComponentProps<'span'> & { variant: StatusDotVariant; label?: string }) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true }
  return (
    <span
      data-slot="status-dot"
      className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_DOT_COLORS[variant], className)}
      {...a11y}
      {...props}
    />
  )
}

export { StatusDot }
```

- [ ] **Step 6: 建 kbd.tsx**

新建 `web/src/components/ui/kbd.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 Kbd。
// **行为与无障碍逐字复刻** src/Kbd/Kbd.tsx：外层 <span role="img" aria-label="可读名">，
// 内层每个键一个 <kbd aria-hidden="true">，可读名 = 各键长名以 " + " 连接，
// 显示 = 各键字形；mod 在苹果平台是 ⌘/Command，其他平台是 Ctrl/Control。
// 两张映射表也逐字照抄（含 Unicode 码点）。
//
// **视觉是自拟的**：Astryx Kbd 的 stylex 块本计划未逐字取证，所以键帽外观按 §5.1 token
// 自拟（弱文本色 + accent 面 + border + mono 小字）。Task 33 的实机核对覆盖这一处；
// 若届时觉得偏，按 §5.1 token 调，**不要回头抄 Astryx**（那时它已卸载）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'
import { isApplePlatform } from '../../lib/platform.js'

const KEY_DISPLAY: Record<string, string> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  enter: '↵',
  backspace: '⌫',
  escape: 'Esc',
  tab: '⇥',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  plus: '+',
}

const KEY_LABEL: Record<string, string> = {
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  backspace: 'Backspace',
  escape: 'Escape',
  tab: 'Tab',
  up: 'Up arrow',
  down: 'Down arrow',
  left: 'Left arrow',
  right: 'Right arrow',
  plus: 'Plus',
}

function keyDisplay(key: string, isMac: boolean): string {
  if (key === 'mod') return isMac ? '⌘' : 'Ctrl'
  return KEY_DISPLAY[key] ?? key.toUpperCase()
}

function keyLabel(key: string, isMac: boolean): string {
  if (key === 'mod') return isMac ? 'Command' : 'Control'
  return KEY_LABEL[key] ?? key.toUpperCase()
}

function Kbd({ keys, className, ...props }: React.ComponentProps<'span'> & { keys: string }) {
  const isMac = isApplePlatform()
  const parts = keys.split('+').map((key) => key.trim().toLowerCase())
  const accessibleName = parts.map((key) => keyLabel(key, isMac)).join(' + ')
  return (
    <span
      data-slot="kbd"
      role="img"
      aria-label={accessibleName}
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    >
      {parts.map((key) => (
        <kbd
          aria-hidden="true"
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-border bg-secondary px-1 font-mono text-[10px] leading-none text-muted-foreground"
          key={key}
        >
          {keyDisplay(key, isMac)}
        </kbd>
      ))}
    </span>
  )
}

export { Kbd }
```

- [ ] **Step 7: 建 section.tsx**

新建 `web/src/components/ui/section.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 Section。
// **不是纯布局件**：Astryx Section 的默认 variant 'section' 会刷 --color-background-surface
// （src/Section/Section.tsx），而 scout 主题把它设为 #16181f（src/theme/scout.css:90）——
// 也就是本仓 --color-accent。当成"透明容器"实现会让五个调用点的面色凭空消失。
// 另外 Astryx Section **没有圆角**（dist/astryx.css 里 --_section-radius 零命中），
// 所以这里也是方角，不要顺手加 rounded-card。
// padding 写死 p-4：全仓五个调用点（SeriesGrid.tsx:56、SeriesPage.tsx:52/61/67/93）
// 全部是 <Section padding={4}>，留一个只有一个取值的 prop 是噪音。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Section({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="section" className={cn('bg-secondary p-4', className)} {...props} />
}

export { Section }
```

- [ ] **Step 8: 建 separator.tsx**

新建 `web/src/components/ui/separator.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 Divider（src/Divider/Divider.tsx）。
// 逐字保留：role="separator" + aria-orientation。
// 丢掉 subtle/strong 变体：全仓唯一调用点（RunDetail.tsx:87）零 prop，
// 用的就是 subtle（--color-border）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Separator({
  orientation = 'horizontal',
  className,
  ...props
}: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      data-slot="separator"
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}

export { Separator }
```

- [ ] **Step 9: 建 aspect-ratio.tsx**

新建 `web/src/components/ui/aspect-ratio.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 AspectRatio（src/AspectRatio/AspectRatio.tsx）。
// 逐字保留：外层 position:relative / width:100% / overflow:clip / min-height:0 / flex-shrink:0
// + 内联 aspect-ratio。
//
// **关键：cover/contain 的子元素裁切在 Astryx 里不在组件里，而在它的 reset.css 中**
// （组件只往内层 wrapper 挂 data-astryx-aspect-ratio-override={fit}，真正的
// object-fit 规则写在 reset.css）。Task 31 会删掉 reset.css——所以这里必须自己实现裁切，
// 否则唯一调用点（PosterCard.tsx:37 ratio={2/3} fit="cover"）的海报会在卸载那一刻悄悄变形，
// 而且是"构建通过、测试全绿、只有肉眼能看出来"的那种坏法。
// 这里把 Astryx 的内层 wrapper 拍平了（只有一个子节点，多一层 div 没有收益）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function AspectRatio({
  ratio,
  fit = 'cover',
  className,
  style,
  ...props
}: React.ComponentProps<'div'> & { ratio: number; fit?: 'cover' | 'contain' }) {
  return (
    <div
      data-slot="aspect-ratio"
      className={cn(
        'relative min-h-0 w-full shrink-0 overflow-clip',
        '[&>*]:absolute [&>*]:inset-0 [&>*]:h-full [&>*]:w-full',
        fit === 'cover' ? '[&>img]:object-cover [&>video]:object-cover' : '[&>img]:object-contain [&>video]:object-contain',
        className,
      )}
      style={{ aspectRatio: ratio, ...style }}
      {...props}
    />
  )
}

export { AspectRatio }
```

- [ ] **Step 10: 建 segmented.tsx**

新建 `web/src/components/ui/segmented.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 SegmentedControl / SegmentedControlItem。
// **role 契约是硬的**：SeriesGrid.test.tsx:75/90 用 getByRole('radio', { name: 'Has gaps' })
// 和 { name: 'Fully covered' } 取这两个分段——所以外层必须 role="radiogroup"、
// 分段必须 role="radio"，写成普通 button 会让那两个断言直接红。
//
// 度量逐条取证（TSX 里没有 borderRadius，圆角藏在主题层发的 --_*-radius 自定义属性里，
// 是从 dist/astryx.css 扫出来的）：
//   轨道  inline-flex items-center gap-0.5 + padding 2px + 圆角 --radius-element = 8px  → rounded-control p-0.5 gap-0.5
//   分段  圆角 max(0px, calc(8px - 2px)) = 6px                                        → rounded-[6px]
//   分段  paddingInline --spacing-3 = 12px，**完全没有 paddingBlock**（高度只由行盒决定）→ px-3，且不许加 py-*
//   分段  --text-label-size = **13px**（`--font-size-base` 被 scout.css:118 覆盖成 0.8125rem，
//         不是 Astryx 默认的 14px）/ medium / leading 1.5385                                → text-[13px] font-medium leading-[1.5385]
//   选中  --color-text-primary + semibold + --color-background-surface + --shadow-low    → text-foreground font-semibold bg-secondary shadow-sm
//   悬停  --color-overlay-hover = #FFFFFF0D（白 5%）                                     → hover:bg-white/5
//          （Tailwind v4 的 hover: 本身就包在 @media (hover: hover) 里，正好等价于
//            Astryx 那层 hover 媒体查询，不用再自己写。）
//   轨道底 Astryx 用 --color-neutral (#E1E4DA33)。这里改用 Task 6 加的 --color-stage-track
//          （rgba(255,255,255,0.09)，即 spec §5.1 已写死的阶段条轨道值）——同一个"底槽"
//          语义不给两个近似值。
//
// 焦点环改成本仓统一的 --ring（Astryx 用它自己的 lime accent 描边）：本栈里 button/input/
// select 的焦点环全是 ring-ring/50，分段控件跟着统一。
//
// **键盘：分段就是原生 <button>，全部可 Tab 到、Enter/Space 激活；不做 roving tabindex +
// 方向键导航。** 注意：Astryx 原件**有** roving tabindex + Arrow/Home/End（SegmentedControl.tsx:176-243
// 的 useListFocus）——所以这是有意的行为回退而非行为冻结（质量审抓获的计划前提错误，2026-08-03）。
// WCAG 达标（原生 button 全键盘可达 + radiogroup/radio 语义正确），恢复路径 = 将来补 useListFocus 同款。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

export type SegmentedItem = { value: string; label: string }

function Segmented({
  items,
  value,
  onChange,
  label,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onChange'> & {
  items: readonly SegmentedItem[]
  value: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <div
      data-slot="segmented"
      role="radiogroup"
      aria-label={label}
      className={cn('inline-flex items-center gap-0.5 rounded-control bg-stage-track p-0.5', className)}
      {...props}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            aria-checked={selected}
            className={cn(
              'inline-flex items-center justify-center gap-1 rounded-[6px] px-3 text-[13px] leading-[1.5385] transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              selected
                ? 'bg-secondary font-semibold text-foreground shadow-sm'
                : 'font-medium text-muted-foreground hover:bg-white/5',
            )}
            key={item.value}
            onClick={() => onChange(item.value)}
            role="radio"
            type="button"
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

export { Segmented }
```

- [ ] **Step 11: 建 banner.tsx**

新建 `web/src/components/ui/banner.tsx`：

```tsx
// 自绘，取代 @astryxdesign/core 的 Banner（src/Banner/Banner.tsx）。
// 逐条取自源码：
//   role        warning/error → "alert"；success → "status"
//   header      flex items-start gap-2 py-3 px-4；独立卡时 borderRadius --radius-container (12px)
//   居中        description == null && 有 actions 时改 items-center（Astryx headerCentered）
//   title       --text-label-size **13px** / semibold / leading 1.5385
//   description --text-supporting-size **11px** / normal / leading **1.4545**
//               （两个 px 与那个 leading 都走 scout.css 覆盖后的值——见本 task 开头那张表。
//                 Astryx 源码注释写的是 14 / 12 / 1.6667，那是它自己默认主题的一套。）
//   图标        **{icon ?? <Icon icon={默认状态图标} …/>}——未传 icon 时有默认图标**。
//               本仓唯一调用点（TranslateSection.tsx:88-122）就没传 icon，所以今天屏幕上
//               有一个警告三角；不复刻它，Task 31 就等于静默删掉一个可见字形。
//               图标容器 aria-hidden="true"（源码如此）。
//
// 三处有意差异：
// 1. **丢掉 info 档**：零调用点，且 §5.1 调色板没有"信息色"这一档，现造一个就是发明。
// 2. warning 底色用 Task 6 加的 --color-fn-amber-muted（#e2a4003f，逐字取自 Astryx 暗色
//    --color-warning-muted）——它是唯一活调用点，保真优先。error/success 零调用点，
//    用本仓功能色的 /25（Astryx 那两个 muted 的基色跟本仓 fn-red/fn-green 本来就不同色），
//    不为零调用点再引两个新 token。
// 3. 图标换 lucide（Astryx 的 Icon 组件随主题退役）。
import * as React from 'react'
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export type BannerStatus = 'warning' | 'error' | 'success'

const BANNER_ROLE: Record<BannerStatus, 'alert' | 'status'> = {
  warning: 'alert',
  error: 'alert',
  success: 'status',
}

const BANNER_SURFACE: Record<BannerStatus, string> = {
  warning: 'bg-fn-amber-muted',
  error: 'bg-fn-red/25',
  success: 'bg-fn-green/25',
}

const BANNER_ICON_COLOR: Record<BannerStatus, string> = {
  warning: 'text-fn-amber',
  error: 'text-fn-red',
  success: 'text-fn-green',
}

function defaultIcon(status: BannerStatus): React.ReactNode {
  const className = cn('size-4 shrink-0', BANNER_ICON_COLOR[status])
  if (status === 'warning') return <TriangleAlertIcon className={className} />
  if (status === 'error') return <CircleXIcon className={className} />
  return <CircleCheckIcon className={className} />
}

function Banner({
  status,
  title,
  description,
  icon,
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  status: BannerStatus
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
}) {
  const isSingleLine = description == null && children != null
  return (
    <div
      data-slot="banner"
      role={BANNER_ROLE[status]}
      className={cn(
        'flex gap-2 rounded-card px-4 py-3',
        isSingleLine ? 'items-center' : 'items-start',
        BANNER_SURFACE[status],
        className,
      )}
      {...props}
    >
      <div aria-hidden="true" className="flex shrink-0 items-center">
        {icon ?? defaultIcon(status)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="m-0 text-[13px] font-semibold leading-[1.5385] text-foreground">{title}</div>
        {description != null && (
          <div className="m-0 text-[11px] font-normal leading-[1.4545] text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

export { Banner }
```

`title` / `description` 都用 `<div>` 而非 `<h*>`/`<p>`：这是 Astryx 源码里带注释的裁决（`<p>` 不能合法包块级子节点，解析器会把它拆出去造成 SSR/hydration 结构不一致；`margin: 0` 让外观完全一致）。照抄。

- [ ] **Step 12: 跑测试确认全绿 + 类型通过**

```bash
cd web && npx tsc --noEmit && npx vitest run src/components/ui/primitives.test.tsx
```

预期：`tsc` 无输出；十个用例全 PASS。

若 `Kbd` 用例报可读名不是 `'Control + K'` 而是 `'Command + K'`，说明 `isApplePlatform()` 在 jsdom 里返回了 true——检查 `setupTests.ts` 里有没有人 stub 过 `navigator.platform`。

- [ ] **Step 13: 提交**

```bash
git add web/src/lib/platform.ts web/src/components/ui
git commit -m "feat(plan-c): 八个自绘 primitive 落地并锁死 role 契约"
```

### Task 9: 自绘 useHotkeys（全应用键盘契约的唯一实现）

**Files:**
- Create: `web/src/lib/useHotkeys.ts`
- Create: `web/src/lib/useHotkeys.test.tsx`

**放 `lib/` 不放新建的 `hooks/`**：本仓没有 `web/src/hooks/` 目录，hook 一律跟着领域走（`web/src/api/hooks.ts`、`web/src/workflow/useLiveTrail.ts`）。useHotkeys 是跨领域件（shell + workflow 各一个调用点），而 Task 8 刚建的 `web/src/lib/` 正是跨领域件的落点，且它 import 的 `platform.ts` 就在同目录——`./platform.js` 一跳可达。不为一个文件新开目录。

**本任务只建 + 只测，不改调用点。** 和 Task 8 同一纪律（八个 primitive 也是建完就停）：换栈的接线按屏走——`web/src/shell/CommandK.tsx:7` 的 import 在 Task 28-29（Shell 重建）换源，`web/src/workflow/RunDetail.tsx:17` 的在 Task 12-18（Activity 的 "View" 下钻链）换源。全仓只有这两处 `@astryxdesign/core/hooks` 导入（grep 实证），Task 31 卸载后若漏改会以"模块不存在"打断构建、Task 32 的残留 grep 也会抓到，不会静默漏。**实现期不要提前改这两个文件**——提前改会让 Task 28-29/12-18 的"旧实现摘除"步骤对不上现状。

**逐字复刻的对象**：`web/node_modules/@astryxdesign/core/dist/hooks/useHotkeys.js`（Task 31 之前它还在磁盘上，可随时对读）。**只有一处刻意偏离**：平台探测改成 import Task 8 的 `lib/platform.ts`，不再自带一份。Astryx 里 `Kbd` 和 `useHotkeys` 各实现了一份 `isApplePlatform`——两份一旦走偏就会出现"界面上写着 ⌘K、按 ⌘K 没反应"这种最难查的 bug（Astryx 自己的源码注释也把"显示与处理必须同源"写成了理由）。

**为什么这里不像 Task 8 那样按调用点裁剪 API**：两个调用点（`mod+k`、`escape`）都没用 `allowInInputs` 和 `isDisabled`，按 Task 8 的 YAGNI 表看似该砍。裁剪线的真实位置是——**凡是要我们新拟的（视觉度量、样式块）一律砍到调用点**，因为每保留一个未取证的 prop 就是一处编造风险；**凡是逐字照抄来的纯逻辑，砍反而要动刀改被抄的循环体**，那是净增的漂移风险。这两个字段各自只是循环里的一行 `continue`，留着比删掉安全，且这个文件是全应用键盘语义的唯一落点。

- [ ] **Step 1: 写失败的测试**

新建 `web/src/lib/useHotkeys.test.tsx`：

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { isApplePlatform } from './platform.js'
import { useHotkeys, type Hotkey } from './useHotkeys.js'

// 平台探测在这里被替换掉：真实的 navigator 嗅探已经由 Task 8 的 primitives.test.tsx
// 通过 Kbd 压过一遍，这里只关心"判成苹果/判成非苹果时 mod 分别落到哪个修饰键"。
vi.mock('./platform.js', () => ({ isApplePlatform: vi.fn(() => false) }))

// 宿主组件：hook 没法单独渲染。顺带放一个 textbox，"焦点在输入框里"的两条用例要用。
function Host({ hotkeys }: { hotkeys: Hotkey[] }) {
  useHotkeys(hotkeys)
  return <input aria-label="probe" />
}

beforeEach(() => {
  // isApple 是在挂载 effect 里取一次的，所以每条用例都必须在 render 之前设定好。
  vi.mocked(isApplePlatform).mockReturnValue(false)
})

describe('useHotkeys', () => {
  it('非苹果平台上 mod+k = Ctrl+K，并且吃掉浏览器默认行为', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    // fireEvent 返回 false 表示事件被 preventDefault 了（keyDown 是 cancelable）。
    expect(fireEvent.keyDown(window, { key: 'k', ctrlKey: true })).toBe(false)
    expect(onPress).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('苹果平台上 mod+k = ⌘K，Ctrl+K 不算', () => {
    vi.mocked(isApplePlatform).mockReturnValue(true)
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(onPress).not.toHaveBeenCalled()

    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('escape 无修饰键触发（RunDetail 的实际组合）', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'escape', onPress }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('esc 是 escape 的别名', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'esc', onPress }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('焦点在输入框里时默认不触发', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', ctrlKey: true })
    expect(onPress).not.toHaveBeenCalled()
  })

  it('allowInInputs 打开后输入框里也触发', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress, allowInInputs: true }]} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'k', ctrlKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('isDisabled 的条目整条跳过', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress, isDisabled: true }]} />)

    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    expect(onPress).not.toHaveBeenCalled()
  })

  it('同一组合键只有数组里第一条被调用', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(<Host hotkeys={[{ keys: 'escape', onPress: first }, { keys: 'escape', onPress: second }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('已经被别人 preventDefault 的事件整体跳过', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'escape', onPress }]} />)

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    event.preventDefault()
    window.dispatchEvent(event)
    expect(onPress).not.toHaveBeenCalled()
  })

  it('没写明 shift 时，按住 ⇧ 依然触发（Astryx 既有语义，行为冻结）', () => {
    const onPress = vi.fn()
    render(<Host hotkeys={[{ keys: 'mod+k', onPress }]} />)

    fireEvent.keyDown(window, { key: 'K', ctrlKey: true, shiftKey: true })
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('handler 换新后调用的是新的那个（ref 刷新，不重订阅）', () => {
    const stale = vi.fn()
    const fresh = vi.fn()
    const { rerender } = render(<Host hotkeys={[{ keys: 'escape', onPress: stale }]} />)
    rerender(<Host hotkeys={[{ keys: 'escape', onPress: fresh }]} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(stale).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
  })

  it('卸载后监听器被摘掉', () => {
    const onPress = vi.fn()
    const { unmount } = render(<Host hotkeys={[{ keys: 'escape', onPress }]} />)
    unmount()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onPress).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd web && npx vitest run src/lib/useHotkeys.test.tsx
```

预期：FAIL，模块解析失败（`./useHotkeys.js` 还不存在）。

- [ ] **Step 3: 建 useHotkeys.ts**

新建 `web/src/lib/useHotkeys.ts`：

```ts
// 自绘，取代 @astryxdesign/core/hooks 的 useHotkeys。
// **逻辑逐字复刻** dist/hooks/useHotkeys.js（含它两处不对称语义，见下方注释），唯一偏离是
// 平台探测 import ./platform.js，不再自带一份——Astryx 里 Kbd 与 useHotkeys 各有一份
// isApplePlatform，两份走偏就会出现"界面写 ⌘K、按 ⌘K 没反应"。
import { useEffect, useRef } from 'react'
import { isApplePlatform } from './platform.js'

export interface Hotkey {
  /** 组合键，形如 'mod+k' / 'escape' / 'ctrl+shift+p'；mod = 苹果平台 ⌘、其他平台 Ctrl。 */
  keys: string
  onPress: (event: KeyboardEvent) => void
  /** 默认 false：焦点在输入类元素里时不触发。 */
  allowInInputs?: boolean
  isDisabled?: boolean
}

// 别名表逐字照抄。注意 ' ' 和 '+' 两条：空格键的 event.key 是字面空格，而 '+' 没法直接写进
// 组合键串（'ctrl++' 会被 split('+') 切成空段），所以必须写 'ctrl+plus'。写 'esc' 而不是
// 'escape' 若没有这张表就会静默永不匹配——这类拼写 bug 最难查，表和它的用例都留着。
const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  space: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  return: 'enter',
  plus: '+',
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function matchesCombo(keys: string, event: KeyboardEvent, isApple: boolean): boolean {
  const parts = keys
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return false
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const wantsMod = mods.has('mod')
  const wantsCtrl = mods.has('ctrl') || (wantsMod && !isApple)
  const wantsMeta = mods.has('meta') || (wantsMod && isApple)
  const wantsAlt = mods.has('alt')
  const wantsShift = mods.has('shift')
  if (event.ctrlKey !== wantsCtrl) return false
  if (event.metaKey !== wantsMeta) return false
  if (event.altKey !== wantsAlt) return false
  // 不对称①：ctrl/meta/alt 是**精确相等**，shift 只在写明时才校验。也就是说没写 shift 的
  // 组合键在 ⇧ 按下时依然触发（⌘⇧K 会开命令面板）。这是 Astryx 的既有语义，本 spec 是
  // 换视觉、行为冻结，不准"顺手改成精确相等"——有用例压着（'没写明 shift 时…'）。
  if (wantsShift && !event.shiftKey) return false
  const expected = KEY_ALIASES[key] ?? key
  return event.key.toLowerCase() === expected
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  const hotkeysRef = useRef(hotkeys)
  // 故意不给依赖数组：每次渲染后把最新的 handler 数组塞进 ref。调用点传的都是内联数组
  // 字面量（每渲染一个新引用），写成依赖数组会让它每渲染都重订阅；而把 handler 直接
  // 捕获进监听器闭包（naive 的 [] 写法）会永远调用首渲染那一版。
  useEffect(() => {
    hotkeysRef.current = hotkeys
  })

  // 依赖数组恒空：整个生命周期只挂一个 window keydown 监听器。
  useEffect(() => {
    const isApple = isApplePlatform()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const isTyping = isTypingTarget(event.target)
      for (const hotkey of hotkeysRef.current) {
        if (hotkey.isDisabled) continue
        if (isTyping && !hotkey.allowInInputs) continue
        if (matchesCombo(hotkey.keys, event, isApple)) {
          event.preventDefault()
          hotkey.onPress(event)
          // 不对称②：首个命中即 return——同组合键的后续条目不会被调用。
          return
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])
}
```

- [ ] **Step 4: 跑测试确认全绿 + 类型通过**

```bash
cd web && npx tsc --noEmit && npx vitest run src/lib/useHotkeys.test.tsx
```

预期：`tsc` 无输出；十二个用例全 PASS。

**高发点：**

1. 全部用例都报 `onPress` 没被调用 → 检查 `vi.mock('./platform.js', …)` 的路径串是否和 `useHotkeys.ts` 里的 import 串**逐字一致**（都得带 `.js`）。写成 `'./platform'` 会 mock 到另一个模块 id，真实实现照跑（jsdom 里返回 false），此时只有"苹果平台"那条会红，其余反而是绿的——所以只有那一条红时先怀疑这里。
2. "苹果平台上 mod+k = ⌘K" 单条红 → `isApple` 是在挂载 effect 里取一次的，`mockReturnValue(true)` 必须在 `render` **之前**。别挪到 render 之后。
3. "已经被别人 preventDefault 的事件整体跳过" 单条红 → 这条不能用 `fireEvent`（它自己构造事件、没法预先 preventDefault），必须手搓 `new KeyboardEvent(...)` 再 `window.dispatchEvent`；`cancelable: true` 不能漏，否则 `preventDefault()` 不生效、`defaultPrevented` 恒 false。
4. "handler 换新后调用的是新的那个" 红成 stale 被调用 → 刷新 ref 那个 `useEffect` 被人加上了依赖数组。它的空注释不是笔误，别补 `[hotkeys]`（每渲染都重订阅）、更别补 `[]`（永远停在首渲染那版）。
5. 第一条报的是 `expect(fireEvent.keyDown(...)).toBe(false)` 失败 → `preventDefault()` 那行漏了，或者被挪到了 `onPress` 之后而 `onPress` 里抛了异常。

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/useHotkeys.ts web/src/lib/useHotkeys.test.tsx
git commit -m "feat(plan-c): 自绘 useHotkeys 并锁死两处不对称键盘语义"
```

---

### Task 10: AI Elements copy-in 之一 —— shimmer + queue

**Files:**
- Create: `web/src/components/ai/shimmer.tsx`
- Create: `web/src/components/ai/queue.tsx`
- Test: `web/src/components/ai/aiElements.test.tsx`（Task 11 往同一个文件追加 task/tool 的用例，别新建第二个）

**这两件抄的是哪儿的源**：Vercel AI Elements 官方 registry 的 `shimmer.tsx` / `queue.tsx`（copy-in 组件，不进包管理器——spec §5.1 的裁决）。Task 7 定下的**四条 copy-in 改造铁规**在这里同样适用：① 相对 import 带 `.js`；② 删 `dark:` 变体（这两个文件本来就没有）；③ 圆角按 token 换（弹层/卡面 `rounded-card`、控件 `rounded-control`、其余保留 `rounded-md`）；④ 颜色只用 §5.1 表里的 token。

#### shimmer 的四处偏离（逐条有理由，实现期照做，不要"回归官方源"）

1. **去掉 `as?: ElementType` 多态，固定成 `motion.span`。** 官方源在**渲染体里**调 `motion.create(Component)`——每渲染一次就产出一个新的组件类型，React 会把 DOM 节点整个卸载重建。传送带最新行每来一条 trace 事件就重渲染，这会变成真实的节点抖动（外面那层 `memo` 挡不住：`children` 每次都在变）。唯一调用点只需要一种元素，固定成静态的 `motion.span` 一次解决多态与重建两件事。
2. **`duration` / `spread` 两个 prop 降为文件内常量**（2 秒 / 每字符 2px，都取官方源的默认值）。零调用点传它们（YAGNI）。`className` 留着——Task 12-18 要靠它给传送带行定字号。
3. **高光色从 `var(--color-background)` 换成 `var(--color-foreground)`。** 官方源假设浅色主题：白底、灰字、白色高光扫过。本仓恒暗色，`--color-background` 是 `#0b0c0f`，照抄的结果是**一条近黑的暗带**扫过 `#9aa1ac` 的字——比不动还暗，而 §5.3 要的是最新行读起来最亮（灰 `#6b7280` → 中 `#9aa1ac` → 最新行 shimmer）。所以底色留 `--color-muted-foreground`、高光换 `--color-foreground` `#e6e8ec`。**这是换 token 不是发明颜色**：两个变量都在 Plan A Task 13 写下的 `@theme` 块里（`--color-foreground: #e6e8ec`、`--color-muted-foreground: #9aa1ac`）。这一处偏离**没有单元测试能抓**（jsdom 不算 computed style），它的验收在 Task 33 的实机核对——所以注释必须留在文件里，否则将来有人"照官方源修回去"时看不到理由。
4. **抽一个导出的纯函数 `shimmerSpreadPx(text)`。** shimmer 里唯一的真实逻辑就是这个乘法，抽出来能直接断言；不抽就只能去读 motion 写进 DOM 的 `--spread` 内联变量，那是第三方的 style 合并实现细节，锁它等于埋一颗"motion 升级即红"的雷。

#### queue 的裁剪：官方 16 个导出只抄 3 个

| 官方导出 | 本仓 | 为什么 |
|---|---|---|
| `Queue` | **抄**（`rounded-xl` → `rounded-card`） | 分区容器。两者都是 12px，纯粹是按铁规③统一叫法，不是改视觉 |
| `QueueList` | **抄，但去掉 ScrollArea** | 官方是 Radix `ScrollArea` 包一层 `max-h-40 pr-4` 的内滚区。三个理由：**(a)** Task 6 的依赖清单里没有 `@radix-ui/react-scroll-area`，那份清单是审计过的闭集，不在这里偷偷加第八个包；**(b)** `max-h-40` = 160px，现网 ActivityQueue 是全量列表不内滚，加个内滚区会把第三行往下的都裁进滚动条里，属行为改动（铁律 5）；**(c)** Radix ScrollArea 在 jsdom 还要另加 mock。改成朴素 `<ul>` |
| `QueueItem` | **抄** | `<li>`。ul/li 的列表语义比现网的 div 堆好，且全仓没有 `list`/`listitem` 的 `*ByRole` 断言（角色普查实证），换过去不动任何既有测试 |
| `QueueItemIndicator` | 不抄 | 它是 `completed?: boolean` 的两态点。§5.3 的 Just finished 要三档（绿/红/灰，`DECISION_TONES`），Task 8 的 `StatusDot` 正是这个。抄进来就是两个点组件并存 |
| `QueueItemContent` / `QueueItemDescription` | 不抄 | 两者的 `completed` 态都是 `line-through`。把已完成的剧集标题划掉是错的语义（它不是被取消的待办）；而颜色档位 §5.1 已写死，Task 12-18 直接用 token 组行 |
| `QueueItemAction` / `QueueItemActions` | 不抄 | `QueueItemAction` 是 `opacity-0 group-hover:opacity-100` 的图标幽灵钮——"View"（`openLabel`）在现网是常显文字钮，改成悬停才出现等于改按钮的有无（铁律 5）。Task 7 的 shadcn `Button variant="ghost" size="sm"` 就够用；`QueueItemActions` 只是 `flex gap-1`，不值一个组件 |
| `QueueSection` / `QueueSectionTrigger` / `QueueSectionLabel` / `QueueSectionContent` | 不抄 | 这四件把分区做成可折叠。蓝本里 Up next / Just finished 没有折叠钮，加它 = 新增按钮（铁律 5）。区头就是 `queueHeading` 那一行字 |
| `QueueItemAttachment` / `QueueItemImage` / `QueueItemFile` | 不抄 | 聊天附件（图片缩略图 / 文件小票）。本仓零附件场景 |
| `QueueMessage` / `QueueMessagePart` / `QueueTodo` 三个 type | 不抄 | 聊天消息与 todo 的形状。本仓喂的是 DTO |

**抄完只剩三个薄壳，那还抄它干嘛？** 因为 spec §5.2 把这两个列表指定给了 AI Elements queue，而 §11-1 授权"以官方源为准调整接线层"——保留这层的实际收益是：`Queue` 容器那行 classes 是有出处的真实视觉，Task 12-18 有个稳定落点挂列表样式，且 `<ul>/<li>` 的语义被组件保证（不会有人随手写成 div）。**`bg-background` 不是笔误**：它跟页面底同色，读作"有边框的区域"而不是浮起来的卡片，与 §5.1 只让卡片用 `--card` 的分工一致——Task 12-18 用 `Queue` 包 Up next / Just finished 时不要覆盖它。

- [ ] **Step 1: 写失败的测试**

新建 `web/src/components/ai/aiElements.test.tsx`：

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Shimmer, shimmerSpreadPx } from './shimmer.js'
import { Queue, QueueItem, QueueList } from './queue.js'

describe('AI Elements copy-in · shimmer', () => {
  it('高光宽度按字符数摊开', () => {
    // 'Planning work' 13 字符 × 每字符 2px。这是 shimmer 里唯一的真实逻辑，直接断言纯函数，
    // 不去读 motion 写进 DOM 的 --spread 内联变量（那是第三方 style 合并的实现细节）。
    expect(shimmerSpreadPx('Planning work')).toBe(26)
    expect(shimmerSpreadPx('')).toBe(0)
  })

  it('渲染成行内 span，文本原样出现', () => {
    render(<Shimmer>Planning work</Shimmer>)
    // 固定 span（不是官方源默认的 <p>）：传送带行自己是块级容器，shimmer 只负责那段字。
    expect(screen.getByText('Planning work').tagName).toBe('SPAN')
  })
})

describe('AI Elements copy-in · queue', () => {
  it('Queue/QueueList/QueueItem 给出真正的列表语义', () => {
    render(
      <Queue>
        <QueueList>
          <QueueItem>The Rig, Season 2</QueueItem>
          <QueueItem>Peacemaker, Season 2</QueueItem>
        </QueueList>
      </Queue>,
    )

    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd web && npx vitest run src/components/ai/aiElements.test.tsx
```

预期：FAIL，模块解析失败（`./shimmer.js` 与 `./queue.js` 都还不存在）。

- [ ] **Step 3: 建 shimmer.tsx**

新建 `web/src/components/ai/shimmer.tsx`：

```tsx
// AI Elements shimmer 的 copy-in。四处记录在案的偏离见 Plan C 任务 10。
//
// **最要紧的一条：高光色是 --color-foreground，不是官方源的 --color-background。**
// 官方源假设浅色主题（白底/灰字/白色高光扫过）；本仓恒暗色，--color-background 是 #0b0c0f，
// 照抄会变成一条近黑的暗带扫过 #9aa1ac 的字，比不动还暗——而 spec §5.3 要的是传送带最新行
// 读起来最亮。将来若有人"照官方源修回去"，请先读这段。
//
// 另外三处：① 去掉 as 多态、固定 motion.span（官方源在渲染体里 motion.create()，每渲染都产出
// 新组件类型，会让 DOM 节点反复卸载重建，传送带每条 trace 事件都重渲染，抖动是真实的）；
// ② duration/spread 两个 prop 降为常量（零调用点传）；③ 抽出 shimmerSpreadPx 便于直接断言。
import { memo, useMemo, type CSSProperties } from 'react'
import { motion } from 'motion/react'
import { cn } from '../../lib/utils.js'

// 每字符摊 2px 高光宽度：短语越长亮带越宽，观感才一致。官方源 spread 的默认值。
const SPREAD_PER_CHAR = 2
// 一轮扫动 2 秒、linear、无限循环。官方源 duration 的默认值。
const DURATION_SECONDS = 2

export function shimmerSpreadPx(text: string): number {
  return text.length * SPREAD_PER_CHAR
}

export type ShimmerProps = {
  children: string
  className?: string
}

const ShimmerComponent = ({ children, className }: ShimmerProps) => {
  const spread = useMemo(() => shimmerSpreadPx(children), [children])

  return (
    <motion.span
      animate={{ backgroundPosition: '0% center' }}
      className={cn(
        'relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent',
        '[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-foreground),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]',
        className,
      )}
      initial={{ backgroundPosition: '100% center' }}
      style={
        {
          '--spread': `${spread}px`,
          backgroundImage:
            'var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))',
        } as CSSProperties
      }
      transition={{ repeat: Number.POSITIVE_INFINITY, duration: DURATION_SECONDS, ease: 'linear' }}
    >
      {children}
    </motion.span>
  )
}

export const Shimmer = memo(ShimmerComponent)
```

**两个 class 串里的下划线不是笔误**：Tailwind 的任意值语法不允许裸空格，官方源用 `#0000_calc(50%-var(--spread))` 这种写法把空格编码成 `_`。抄的时候整串照搬，别"格式化"它。

- [ ] **Step 4: 建 queue.tsx**

新建 `web/src/components/ai/queue.tsx`：

```tsx
// AI Elements queue 的 copy-in。官方 16 个导出这里只保留三个薄壳，逐条裁剪理由见 Plan C
// 任务 10 的表（要点：指示点用 Task 8 的 StatusDot 三档、动作位用 shadcn Button 常显文字钮、
// 分区不做可折叠——这三条都是"不改按钮的有无"这条铁律的直接后果）。
//
// QueueList 去掉了官方的 Radix ScrollArea：现网 Up next / Just finished 是全量列表，官方那层
// max-h-40（160px）内滚会把第三行往下的都裁进滚动条，属行为改动；且 Task 6 的依赖闭集里
// 没有 @radix-ui/react-scroll-area。
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export type QueueProps = ComponentProps<'div'>

export const Queue = ({ className, ...props }: QueueProps) => (
  <div
    className={cn(
      // rounded-xl → rounded-card：两者都是 12px，只是按 copy-in 铁规③统一叫法。
      // bg-background 与页面底同色是有意的：这是"有边框的区域"，不是浮起来的卡片。
      'flex flex-col gap-2 rounded-card border border-border bg-background px-3 pt-2 pb-2 shadow-xs',
      className,
    )}
    {...props}
  />
)

export type QueueListProps = ComponentProps<'ul'>

// 官方源在 ScrollArea 上挂的是 `-mb-1 mt-2`：那个负下边距是给 ScrollArea 抵边距用的，
// 没有那层就不该留（留着会让区块底部少 4px）。
export const QueueList = ({ className, ...props }: QueueListProps) => (
  <ul className={cn('mt-2', className)} {...props} />
)

export type QueueItemProps = ComponentProps<'li'>

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      // rounded-md 按铁规③保留（列表行既不是控件也不是弹层）；hover:bg-muted 里的
      // --color-muted 已经是 §5.1 表内的 token（#16181f），不用换。
      'group flex flex-col gap-1 rounded-md px-3 py-1 text-sm transition-colors hover:bg-muted',
      className,
    )}
    {...props}
  />
)
```

- [ ] **Step 5: 跑测试确认全绿 + 类型通过**

```bash
cd web && npx tsc --noEmit && npx vitest run src/components/ai/aiElements.test.tsx
```

预期：`tsc` 无输出；三个用例全 PASS。

**高发点：**

1. 报 `Cannot find module 'motion/react'` → Task 6 Step 1 的 `motion` 没装上，或装到了仓根而不是 `web/`。回 Task 6 Step 3 的八行核查。
2. 渲染 Shimmer 时报 `window.matchMedia is not a function` → `setupTests.ts` 里的 matchMedia 垫片被删了（Task 7 往同一文件追加时最容易误伤）。motion 用它读 `prefers-reduced-motion`。
3. `expect(...).toBe('SPAN')` 拿到 `'P'` → 有人把 `motion.span` 换回了官方源的多态写法（默认 `as = 'p'`）。按偏离①改回固定 span。
4. 找不到 `list` role → `QueueList` 被写成了 `<div>`。官方源用的就是 `<ul>`，这个语义是有意保留的（见裁剪表）。
5. `tsc` 报 `Type '{ "--spread": string; backgroundImage: string; }' is not assignable to type 'CSSProperties'` → `as CSSProperties` 那个断言被删了。CSS 自定义属性不在 `CSSProperties` 的键集里，官方源正是靠这个断言过类型，照抄。
6. 三个用例全绿但实机上传送带最新行**看不见字**（不是变暗，是完全透明）→ `bg-clip-text text-transparent` 生效但 `background-image` 没生成，即 `[--bg:...]` 那串被"格式化"时把 `_` 换成了空格。jsdom 抓不到这个，Task 33 实机核对时按这条查。

- [ ] **Step 6: 提交**

```bash
git add web/src/components/ai
git commit -m "feat(plan-c): AI Elements shimmer + queue copy-in，裁剪与偏离随文注明"
```

---

### Task 11: AI Elements copy-in 之二 —— task + tool

**Files:**
- Create: `web/src/components/ai/task.tsx`
- Create: `web/src/components/ai/tool.tsx`
- Modify: `web/src/components/ai/aiElements.test.tsx`（Task 10 建的那个文件，本任务往里追加两个 `describe`）

**同 Task 9 的纪律：本任务只交付壳，一个屏都不改。** `task.tsx` 的接线在 Task 22-24（Triage 分区卡），`tool.tsx` 的接线在 Task 12-18（RunDetail 的痕迹回放）。谁当折叠触发器、默认开还是关，都留到那两处对着现网 markup 定——**现在别提前改 `PendingBox.tsx` / `RunDetail.tsx`**。

#### task.tsx：官方 5 个导出留 3 个

| 官方导出 | 本仓 | 为什么 |
|---|---|---|
| `Task` | **抄，原样**（含 `defaultOpen = true`） | `Collapsible` 薄壳 |
| `TaskTrigger` | **抄，删 `SearchIcon`** | 放大镜宣称一个"搜索"动作，而这是个分组区头（铁律 5：图标/按钮的有无照现网，不凭空多一个动作暗示）。chevron 留着——它是折叠的唯一可视 affordance。`children ??` 那个逃生口也留着：§5.5 的组头有三段信息（mono 目录名 + `"8 files"` + 首末行），Task 22-24 会传自己的 children |
| `TaskContent` | **抄，`border-muted` → `border-border`** | 官方假设浅色主题：`--muted` 在白底上是可见的浅灰。本仓 `--color-muted` 是 `#16181f`，画在 `#0b0c0f` 页底（或 `#111318` 卡底）上那条左竖线**几乎不可见**，等于没画。`--color-border`（`rgba(255,255,255,0.07)`，叠出来约 `#22242a`）才是 §5.1 派给分隔线的 token。这和 Task 10 shimmer 的高光色是同一类偏离——官方源的浅色假设 |
| `TaskItem` | 不抄 | `text-muted-foreground text-sm` 两个 class 的裸 `div`，无语义（不是 `li`）。同 Task 10 对 `QueueItemActions` 的判断。§5.5 的文件行是 mono 弱色，跟这两个 class 也不一样，Task 22-24 直接用 token 写 |
| `TaskItemFile` | 不抄 | 行内文件小票（带边框的 chip）。§5.5 的文件行是**整行 mono 文件名**，不是 chip；零调用点。注：它用的 `bg-secondary` 在 Plan A tw.css 里**是有的**（`--color-secondary: #16181f`），砍它不是因为缺 token，纯 YAGNI |

**`text-popover-foreground` 原样保留**（`TaskContent` 与 `ToolContent` 各一处）。它看着像野生 class，其实 Plan A Task 13 的 `@theme` 里有 `--color-popover-foreground: #e6e8ec`——跟 `--color-foreground` 同值，顺手换成 `text-foreground` 只是制造无谓 diff。

#### tool.tsx：五个导出全留，但形状按真实产出方重塑

**根因一处**：官方源第一行 `import type { ToolUIPart } from "ai"`。`ai` 包（Vercel AI SDK）本仓没装、也不会装（§5.2 不装清单把对话系整族挡在门外）。`ToolUIPart` 描述的是**聊天里的一次工具调用**；本仓的产出方是 `TraceEvent`（`web/src/api/types.ts:144-152`，七键封闭：`runKey`/`seq`/`tool`/`argsSummary`/`resultSummary`/`tookMs`/`at`）。下面每一条偏离都是这个根因的下游：

1. **`state` 七态 → 本地 `ToolState = 'running' | 'completed'`。** 官方那七态里有两个还挂着 `@ts-expect-error`（AI SDK v6 才有的 approval 态）。本仓只有这两态有真实产出方：回放里每条 TraceEvent 都是**已完成**事件（`tookMs`/`resultSummary` 都在），直播尾巴那一行是"仍在跑"（`TraceRows.tsx` 的 `live` 分支现状）。剩下五态（pending / awaiting approval / responded / denied / error）零产出方，抄进来就是五个永不为真的分支加两个 `@ts-expect-error`。两个 label 逐字取官方表（`input-available` → `"Running"`、`output-available` → `"Completed"`）。
2. **`type` prop 与 `title ?? type.split("-").slice(1).join("-")` 兜底删掉，`title` 从可选变必填。** 那个 split 在剥 AI SDK 的 `tool-` 前缀，我们的 `TraceEvent.tool` 本来就是裸工具名。
3. **`title` 就是原始工具名，不要在这里套 `toolPhrase`。** RunDetail 走的是**快照回放**路径：`TraceRows.tsx` 的文件头注释写明 `phraseMode=false` 显示原始工具名，那是技术值，i18n §7"技术值永不翻译"管它，且既有测试锁着。commit `d5988e0` 修的"裸工具名上界面"是**活动页传送带**那条 `phraseMode=true` 的路径（Task 12-18 的地盘），两条路径别搞混。
4. **完成图标的 `text-green-600` → `text-fn-green`。** 裸调色板违 copy-in 铁规④；`--color-fn-green`（`#28bf5c`）就是 §5.1 派给"covered/完成行"的那个绿。running 的时钟图标官方本来就没给颜色，保持无色 + `animate-pulse`。
5. **`ToolHeader` 的触发器补一个 `group` class。** 官方源的 chevron 写了 `group-data-[state=open]:rotate-180`，但 `Tool` 和 `ToolHeader` 两处都没有 `group`——**那个旋转在官方源里是死的**（`task.tsx` 里他们记得加，`tool.tsx` 里漏了）。补在 `CollapsibleTrigger` 上（Radix 会给它挂 `data-state`）。这不是新增按钮或图标，是让已经抄进来的那个 class 生效。
6. **`ToolInput` / `ToolOutput` 的 `CodeBlock` → `<pre>`，`input`/`output` 收成 `string`、不再 `JSON.stringify`。** 三条理由：(a) 产出方是 `argsSummary` / `resultSummary`，**本来就是给人看的摘要串**，再 stringify 会给它套一层引号并把内部引号全转义；(b) `code-block` 在 spec §5.2 的**不装清单**里（它拉 shiki 一族的重依赖）；(c) 现网 RunDetail 的 detail 本来就是 mono 块（`RunDetail.tsx` 文件头注释"detail 全文 mono 块"），`<pre>` 与现状同形。官方 `ToolOutput` 里 `isValidElement` / object / string 的三分支判别随之整块消失。顺带删掉 `[&_table]:w-full`（那是给 markdown 表格准备的，`<pre>` 里没有表格）。
7. **错误分支去红**：`bg-destructive/10 text-destructive` → 与结果同一块底（`bg-muted/50 text-foreground`），错误与结果的区别只留在标题词（`"Error"` vs `"Result"`）。理由是 draft-6 铁律 1 写死的"红色只给卡死事实层：红点 + 唯一红字事实句；**卡片底色/边框/banner 一律不红**"，`bg-destructive/10` 正是卡片底色；§5.1 也把功能红限死在卡死点与那一句事实句两处。（`--color-destructive` 在 Plan A tw.css 里有值 `#e11d48`，砍它不是缺 token，是铁律。）同时把官方"errorText 与 output 两块都渲染"改成 `errorText ?? output` 二选一——标题词已经是 `Error` 了，底下再挂一块 Result 内容是自相矛盾。
8. **`if (!(output || errorText)) return null` 这条双空短路照抄不动。** `resultSummary` 允许是空串（不是每条 trace 都有结果），这一句是"别渲染一个只有 `Result` 标题的空块"的唯一闸门。有测试锁。
9. **`Tool` 的容器**：`not-prose` 删掉（本仓不装 `@tailwindcss/typography`，这个 class 没有对应规则，是官方源给 prose 容器留的逃生口）；`rounded-md` → `rounded-card`（spec §5.1 圆角表写死"卡 12px"，这是张带边框的卡面——跟 Task 10 里 `QueueItem` **保留** `rounded-md` 不矛盾：那是列表行，既非卡面也非控件）。裸 `border` 不用补 `border-border`，颜色来自 Plan A tw.css 的 `@layer base { *, ::before, ::after { border-color: var(--color-border) } }`。

**spec §5.2 给 tool 卡列的四位（名称/入参/结果/错误位）在此仍然齐全**——错误位以"标题词 + 文本"的形式交付，只是不给它红底。但要如实记一笔：**当前 `TraceEvent` 没有 error 字段**，所以接线后 `errorText` 会恒为 `null`，直到将来有 spec 给它数据源。保留这个 prop 是"留出位置"，不是假装有数据；砍掉它则要动刀改抄来的双空短路与标题三元（Task 9 定的那条 YAGNI 分界线：照抄的纯逻辑砍反而要改被抄的逻辑体）。

- [ ] **Step 1: 往 `aiElements.test.tsx` 追加失败的测试**

先把文件顶部的 import 段改成下面这样（多一个 `fireEvent`、多两行组件 import，其余不动）：

```tsx
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Shimmer, shimmerSpreadPx } from './shimmer.js'
import { Queue, QueueItem, QueueList } from './queue.js'
import { Task, TaskContent, TaskTrigger } from './task.js'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from './tool.js'
```

然后把这两个 `describe` **追加到文件末尾**：

```tsx
describe('AI Elements copy-in · task', () => {
  it('默认展开，点区头收起内容', () => {
    render(
      <Task>
        <TaskTrigger title="8 files" />
        <TaskContent>Peacemaker.S02E03.mkv</TaskContent>
      </Task>,
    )

    // Task 的 defaultOpen 默认为 true（官方源如此，与 Tool 不同）。
    expect(screen.getByText('Peacemaker.S02E03.mkv')).toBeInTheDocument()

    // 不能用 getByRole('button') 找区头：官方源的默认触发器是 CollapsibleTrigger asChild 套一个
    // <div>，Radix 只把 props 合并上去，不会补 role="button"。这个 a11y wart 原样保留——
    // Task 22-24 接线时会传自己的 <button> 当 children（§5.5 的组头有三段信息）。
    fireEvent.click(screen.getByText('8 files'))
    expect(screen.queryByText('Peacemaker.S02E03.mkv')).not.toBeInTheDocument()
  })
})

describe('AI Elements copy-in · tool', () => {
  it('展开时给出工具名、状态徽标、入参与结果', () => {
    render(
      <Tool defaultOpen>
        <ToolHeader state="completed" title="find_subtitle" />
        <ToolContent>
          <ToolInput input="series=The Rig, season=2" />
          <ToolOutput errorText={null} output="installed 3 subtitles" />
        </ToolContent>
      </Tool>,
    )

    // 回放路径显示的是原始工具名（技术值），不套人话短语——见 tool.tsx 里的注释。
    expect(screen.getByText('find_subtitle')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.getByText('series=The Rig, season=2')).toBeInTheDocument()
    expect(screen.getByText('Result')).toBeInTheDocument()
    expect(screen.getByText('installed 3 subtitles')).toBeInTheDocument()
  })

  it('running 态用官方那个词', () => {
    render(
      <Tool defaultOpen>
        <ToolHeader state="running" title="find_subtitle" />
      </Tool>,
    )

    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('不传 defaultOpen 时默认收起（与 Task 的刻意不对称）', () => {
    render(
      <Tool>
        <ToolHeader state="completed" title="find_subtitle" />
        <ToolContent>
          <ToolInput input="x=1" />
        </ToolContent>
      </Tool>,
    )
    expect(screen.getByText('find_subtitle')).toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
  })

  it('结果与错误双空时整块不渲染', () => {
    // resultSummary 允许是空串。没有这条短路，界面上会多出一个只有 "Result" 标题的空块。
    const { container } = render(<ToolOutput errorText={null} output="" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('有 errorText 时标题词换成 Error，结果块让位', () => {
    render(<ToolOutput errorText="provider timed out" output="" />)

    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
    expect(screen.getByText('provider timed out')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

```bash
cd web && npx vitest run src/components/ai/aiElements.test.tsx
```

预期：FAIL，模块解析失败（`./task.js` 与 `./tool.js` 都还不存在）。Task 10 那三个用例此刻也一起红——同一个文件解析不过。

- [ ] **Step 3: 建 task.tsx**

新建 `web/src/components/ai/task.tsx`：

```tsx
// AI Elements task 的 copy-in——§5.5 Triage 分区卡的折叠底座。偏离三处（删 SearchIcon、
// border-muted → border-border、不抄 TaskItem/TaskItemFile），逐条理由见 Plan C 任务 11。
// 接线在 Task 22-24：谁当触发器、默认开合，那里对着 PendingBox.tsx 现状定。
import type { ComponentProps } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js'
import { cn } from '../../lib/utils.js'

export type TaskProps = ComponentProps<typeof Collapsible>

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
)

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string
}

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  // `group` 是 chevron 那个 group-data-[state=open]:rotate-180 的锚，别删。
  <CollapsibleTrigger asChild className={cn('group', className)} {...props}>
    {children ?? (
      // 官方源这里还有一个 <SearchIcon />：删掉——放大镜宣称一个"搜索"动作，而这是分组区头。
      <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <p className="text-sm">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
)

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  >
    {/* 官方源这条左竖线是 border-muted：那是浅色主题下的可见浅灰，本仓 --color-muted 是
        #16181f，画在 #0b0c0f 页底上几乎不可见。--color-border 才是 §5.1 派给分隔线的 token。 */}
    <div className="mt-4 space-y-2 border-border border-l-2 pl-4">{children}</div>
  </CollapsibleContent>
)
```

- [ ] **Step 4: 建 tool.tsx**

新建 `web/src/components/ai/tool.tsx`：

```tsx
// AI Elements tool 的 copy-in——RunDetail 的痕迹回放卡（spec §5.2：名称/入参/结果/错误位）。
//
// 官方源第一行 import 的 `ToolUIPart`（`ai` 包，Vercel AI SDK）本仓没装也不会装（§5.2 不装
// 清单）。那个类型描述的是聊天里的一次工具调用；本仓的产出方是 TraceEvent
// （web/src/api/types.ts:144-152，七键封闭）。所以 state 收成两态、input/output 收成 string、
// CodeBlock 换 <pre>、错误分支去红——九条偏离逐条记在 Plan C 任务 11。
// 接线在 Task 12-18（RunDetail 回放），本任务不改任何屏。
import type { ComponentProps } from 'react'
import { CheckCircleIcon, ChevronDownIcon, ClockIcon, WrenchIcon } from 'lucide-react'
import { Badge } from '../ui/badge.js'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js'
import { cn } from '../../lib/utils.js'

/** 只有这两态有真实产出方：回放里每条 TraceEvent 都是已完成事件，直播尾巴那一行是"仍在跑"。 */
export type ToolState = 'running' | 'completed'

/** 两个词逐字取自官方源的 labels 表（input-available / output-available 两项）。 */
const STATE_LABELS: Record<ToolState, string> = {
  running: 'Running',
  completed: 'Completed',
}

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  // 官方源是 `not-prose mb-4 w-full rounded-md border`。not-prose 删（本仓不装
  // @tailwindcss/typography，无对应规则）；rounded-md → rounded-card（§5.1 圆角表：卡 12px）。
  // 裸 border 的颜色来自 tw.css 的 @layer base 全局 border-color，不用补 border-border。
  // 注意：官方源**不给** Tool 设 defaultOpen（与 Task 相反），默认是收起的。
  <Collapsible className={cn('mb-4 w-full rounded-card border', className)} {...props} />
)

export type ToolHeaderProps = {
  /** TraceEvent.tool——**原始工具名**。不要在这里套 toolPhrase：回放路径显示技术值
   *  （见 TraceRows.tsx 文件头与 i18n §7）。commit d5988e0 修的"裸工具名上界面"是活动页
   *  传送带那条 phraseMode 路径，不是这一条。 */
  title: string
  state: ToolState
  className?: string
}

export const ToolHeader = ({ className, title, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    // `group` 是官方源漏掉的一个 class：chevron 的 group-data-[state=open]:rotate-180 在官方
    // 源里因此是死的（他们在 task.tsx 里记得加）。补在这里——Radix 会给触发器挂 data-state。
    className={cn('group flex w-full items-center justify-between gap-4 p-3', className)}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-4 text-muted-foreground" />
      <span className="font-medium text-sm">{title}</span>
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        {state === 'running' ? (
          <ClockIcon className="size-4 animate-pulse" />
        ) : (
          // 官方源这里是 text-green-600（裸调色板，违 copy-in 铁规④）。
          <CheckCircleIcon className="size-4 text-fn-green" />
        )}
        {STATE_LABELS[state]}
      </Badge>
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
)

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
)

// 官方源这两块用的是 <CodeBlock language="json">：spec §5.2 的不装清单点名不装 code-block
// （它拉 shiki 一族重依赖），而现网 RunDetail 的 detail 本来就是 mono 块，<pre> 与现状同形。
const BLOCK_CLASS = 'overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs text-foreground'
const HEADING_CLASS = 'font-medium text-muted-foreground text-xs uppercase tracking-wide'

export type ToolInputProps = ComponentProps<'div'> & {
  /** TraceEvent.argsSummary——已经是给人看的摘要串，不要再 JSON.stringify（会套引号并转义）。 */
  input: string
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden p-4', className)} {...props}>
    <h4 className={HEADING_CLASS}>Parameters</h4>
    <pre className={BLOCK_CLASS}>{input}</pre>
  </div>
)

export type ToolOutputProps = ComponentProps<'div'> & {
  /** TraceEvent.resultSummary，允许空串。 */
  output: string
  /** 目前恒为 null——TraceEvent 没有 error 字段。留位不留假数据，见 Plan C 任务 11。 */
  errorText: string | null
}

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  // 双空短路照抄不动：resultSummary 允许是空串，这一句是"别渲染一个只有 Result 标题的空块"
  // 的唯一闸门。
  if (!(output || errorText)) {
    return null
  }

  return (
    <div className={cn('space-y-2 p-4', className)} {...props}>
      <h4 className={HEADING_CLASS}>{errorText ? 'Error' : 'Result'}</h4>
      {/* 官方源给错误分支的是 bg-destructive/10 text-destructive，且 errorText 与 output 两块
          都渲染。draft-6 铁律1 写死"卡片底色/边框/banner 一律不红"，红只留给卡死点与那一句红字
          事实句——所以错误与结果同底，区别只在标题词；标题已经是 Error 了，就不再挂 Result 内容。 */}
      <pre className={BLOCK_CLASS}>{errorText ?? output}</pre>
    </div>
  )
}
```

注：`ToolOutput` 的标题用真值判断（`errorText ? 'Error' : 'Result'`）而内容用空值合并（`errorText ?? output`）——退化输入 `errorText=''` 会渲染成 Result 标题配空 `<pre>`，但在 `string | null` 契约下不可达（`''` 会被双空短路拦下）；本 plan 保留 `??` 原样。

- [ ] **Step 5: 跑测试确认全绿 + 类型通过**

```bash
cd web && npx tsc --noEmit && npx vitest run src/components/ai/aiElements.test.tsx
```

预期：`tsc` 无输出；九个用例（Task 10 三个 + 本任务六个）全 PASS。

- [ ] **Step 6: 核两个动画 class 真的进了 CSS，并扫一遍禁用残留**

```bash
cd web && npm run build && for cls in slide-in-from-top-2 slide-out-to-top-2; do grep -rq "$cls" dist --include='*.css' && echo "OK   $cls" || echo "MISS $cls"; done
```

预期：两行都是 `OK`。这两个 class 是 Task 7 Step 12 特意跳过的那两个（那时源码里还没有引用，放进去会得到假失败），到本任务才第一次进源码。

```bash
cd web && grep -n "destructive\|green-600\|red-600\|yellow-600\|blue-600\|orange-600\|not-prose\|CodeBlock\|from 'ai'" src/components/ai/task.tsx src/components/ai/tool.tsx || echo "CLEAN"
```

预期：code 行零命中（注释行内的偏离说明豁免——tool.tsx 文件头与偏离注记按原文保留 `CodeBlock`/`not-prose`/`text-green-600`/`destructive` 等词，命中这些词的注释行不算残留）。任何一条 class 串、import 或 JSX 属性命中，说明官方源的某处被原样抄了进来。

**高发点：**

1. `MISS slide-in-from-top-2` → 两种病因。要么是 Task 6 Step 4 的 `@import "tw-animate-css";` 出了问题（三种可能见 Task 7 Step 12 的诊断）；要么是 `ToolContent` / `TaskContent` 那条长 class 串被"整理"成了拼接表达式——**Tailwind v4 扫的是源码里的字面量**，拼出来的 class 名它一个都认不出，而且不报错。
2. `tsc` 报 `Cannot find module 'ai'` → 官方源第一行的 `import type { ToolUIPart } from 'ai'` 被抄进来了。那个包不装，`state`/`input`/`output` 三个类型按本任务给的形状自定。
3. `getByRole('button')` 找不到 task 区头 → 见测试里的注释，官方默认触发器是 `asChild` 套的 `<div>`，Radix 不补 `role`。**别为了让它有 role 就改成 `<button>`**：Task 22-24 大概率传自己的 children，改了等于凭空定下一个接线层的决定。
4. 点了 task 区头内容不消失，或报 `ResizeObserver is not defined` → Task 7 Step 1 的五个 jsdom polyfill 没追加进 `setupTests.ts`。Radix Collapsible 收起时是真卸载子节点的（没有 `forceMount`），polyfill 齐了这条断言就成立。
5. tool 卡展开态 chevron 不转 → `ToolHeader` 上的 `group` 掉了（官方源本来就漏这个 class，见偏离 5）。
6. tool 测试里内容不渲染 → `<Tool>` 没传 `defaultOpen`。这是官方源刻意的不对称（`Task` 默认展开、`Tool` 默认收起），**别顺手给 `Tool` 补一个 `defaultOpen = true`**：默认开合是接线层的决定，留给 Task 12-18。
7. `expect(container).toBeEmptyDOMElement()` 红 → 双空短路（`if (!(output || errorText)) return null`）被删或被改成了只判 `errorText`。

- [ ] **Step 7: 提交**

```bash
git add web/src/components/ai
git commit -m "feat(plan-c): AI Elements task + tool copy-in，state 收两态并按 TraceEvent 重塑入参出参"
```


### Task 12: ConveyorFeed —— 传送带 token 迁移 + 最新行换 shimmer

Activity 六件的第一件（叶子优先）。ConveyorFeed 是活动页里**唯一零 Astryx import** 的组件，
所以它是整个活动页迁移里风险最低的入口：不需要替换任何 Astryx 组件，只做两件事——
① `styles.css` 里传送带段的 legacy token 换新 token；② 最新一行的"最亮"线索从 CSS 静态色
换成 Task 10 copy-in 的 AI Elements `Shimmer`（Spec C §5.3 原话："最新行换 AI Elements
shimmer——这是"最亮"线索的声明式替换"）。

**先把 Activity 六件的 Astryx 面一次讲清（Tasks 13-18 引用本段，不再重复）：**

全 `web/src/activity/` 目录对 `@astryxdesign/core` 的 import 只有四个名字，逐文件核实如下：

| 文件 | Astryx import | 本 plan 的替换 |
|---|---|---|
| `ActivityPage.tsx:21` | `VStack` | 朴素 `<div className="flex flex-col gap-N">` |
| `ActivityHero.tsx:65-67` | `Text` / `VStack` / `HStack` | `Text` → 语义标签 + Tailwind 字号类；`VStack`/`HStack` → 朴素 `<div className="flex …">` |
| `ActivityQueue.tsx:31-32` | `Text` / `HStack` | 同上 |
| `ActivityDone.tsx:36-38` | `Button` / `Text` / `HStack` | 同上，外加 `Button` → **Plan A Task 14** 落地的 `components/ui/button.tsx`（**不是** Plan C Task 7——Task 7 那七件是 badge/skeleton/collapsible/accordion/dialog/alert-dialog/select，里头没有 button） |
| `ActivityStuck.tsx:72-74` | `Text` / `VStack` / `HStack` | 同 hero |
| `ActivityEmpty.tsx:51-53` | `Text` / `VStack` / `HStack` | 同 hero |
| `ConveyorFeed.tsx` | **无** | 本 task 只动样式与最新行渲染 |

也就是说：活动页没有用到任何 Astryx 的"复杂件"（无 Dialog、无 Select、无 Table），
六件的迁移全部是 `Text`/`VStack`/`HStack` → 朴素 flex 标记；**`Button` 全目录只出现一次**
（`ActivityDone.tsx:36`，"再放一遍"那个入口），只有 Task 15 需要碰 shadcn Button。
尤其注意 **hero 与 stuck 两屏一个 `Button` 都没有**——那不是遗漏，是用户裁决 L11（"语义想不清
就别画"）的落地，`ActivityHero.test.tsx:527` 有 `querySelectorAll('button')).toHaveLength(0)`
的回归锁。谁在这两屏"顺手补个按钮"就会当场变红，那条红是对的。
**Tasks 13-18 不得引入本表以外的 Astryx 替换动作**；若实现期在某文件发现第五个 Astryx 名字，
停下来报告（说明本 plan 的取证过期了），不要自行发挥。

**Files:**
- Modify: `web/src/tw.css`（一处一词编辑：`@theme {` → `@theme static {`。这是 Task 6 建的文件，但这条约束是**本 task 的需求**，由本 task 付账，理由见 Step 1）
- Modify: `web/src/styles.css`（传送带段 `:1369-1425`：五处 legacy 颜色 var + 一处字体栈换新 token，两处注释补写；`.conveyor` / `.conveyor-track` 的盒模型与 `@keyframes` **一行不动**）
- Modify: `web/src/activity/ConveyorFeed.tsx`（文件头注释 `:19-20`、import 区 `:44-46`、`map` 体 `:77-85`）
- Create: `web/src/lib/usePrefersReducedMotion.ts`
- Test: `web/src/activity/ConveyorFeed.test.tsx`（**追加**四条用例；既有 19 条一条都不改）

**两个 commit：** ① token 迁移（纯改名 + `@theme static`，既有 19 条测试就是回归网）；② shimmer 接线（TDD：先写红测试）。

---

#### 背景一：为什么 `@theme` 必须改成 `@theme static`

Tailwind v4 官方文档（https://tailwindcss.com/docs/theme，"Theme variable namespaces / Using your
theme variables" 一节）原文：

> By default only used CSS variables will be generated in the final CSS output.

以及紧接着的关键限定：

> References in your own hand-written CSS (or arbitrary values, components, etc.) are invisible to that mechanism.

翻成本仓的处境：Task 6 建的 `tw.css` 用普通 `@theme { … }` 声明了 `--color-weak` / `--color-faint`
/ `--font-mono` 等 token。Tailwind 只会把**被 utility 类用到的** token 写进产物。而本 task（以及
Tasks 13-30 的每一次 `styles.css` 迁移）是在**手写 CSS 里** `var(--color-weak)` 引用它们——
这种引用在 Tailwind 眼里不存在。后果极其阴险：

- 不报错、不警告、构建成功；
- 产物 CSS 里根本没有 `--color-weak` 这个变量声明；
- `color: var(--color-weak)` 因此解析为无效值，元素继承父色；
- **组件测试照样全绿**（jsdom 不做级联求值，`cssDecl` 读的是 CSS 源文本里的声明，不是计算值）；
- 只有真人打开页面盯着看，才会发现传送带旧行的三档亮度全糊成一个颜色。

`@theme static { … }` 的语义是"无条件发射本块内所有变量"，正是手写 CSS 消费 token 时要的行为。
一词改动，代价是产物 CSS 多几百字节（token 数量级是几十个），换来的是 Tasks 12-30 的 token 引用
全部真实生效。**这个改动必须在第一次手写 `var(--color-*)` 落地之前完成，所以它在本 task 的 Step 1。**

#### 背景二：为什么 tier-1 那条颜色规则**不删**

直觉上"最新行换 shimmer 了，那 `.conveyor-row:nth-last-child(1) { color: … }` 就是死代码"——
**错的**。看 Task 10 落的 `Shimmer` 实现：它是 `bg-clip-text text-transparent` +
`background-image` 渐变。也就是说 shimmer 的可见文字来自**背景**，元素自身的 `color` 被设成
`transparent`，父级/自身的 `color` 声明根本不参与显示。所以那条规则与 shimmer **不冲突、不重叠**。

而它有一个真实的消费者：**reduced-motion 分支**。本 task 在 `prefers-reduced-motion: reduce` 下
最新行退回纯文本（不渲染 `Shimmer`），那一刻最新行的颜色**就是靠这条规则给的**。删了它，
偏好减少动效的用户会看到最新行掉成继承色。

另外一个安心点：shimmer 高光色取的是 `var(--color-foreground)`（`#e6e8ec`），而现网 tier-1 的
`--color-text-primary` 也正是 `#e6e8ec`（`web/src/theme/scout.css:96`）。**峰值亮度一字节没变**，
变的只是"它现在会动"。这不是重设计，是同一个视觉线索换了实现方式。

#### 背景三：为什么 reduced-motion 必须在 TSX 里判，不能只靠 CSS

`styles.css:1423-1425` 已有 `@media (prefers-reduced-motion: reduce) { .conveyor-row { animation: none; } }`
——这个组件**已经在遵守**减少动效纪律（铁律5：行为蓝本逐字节对齐，不得让迁移把既有无障碍行为退化）。
但 `Shimmer` 的动画是 motion 驱动的 **JS 内联样式**（`animate={{ backgroundPosition }}`），
CSS 的 `animation: none` 管不到它。要守住这条纪律，只能在渲染层判断：reduced-motion 时干脆
不渲染 `Shimmer`。

**不用 motion 自带的 `useReducedMotion()`**：它在模块作用域初始化时就把偏好读进缓存
（`initPrefersReducedMotion` 在 import 时跑一次），测试里事后替换 `window.matchMedia` 换不动它，
分支就成了不可测/依赖 import 顺序的代码。所以本 task 自建一个 14 行的 hook，每次 render 现读。

---

- [ ] **Step 1: `tw.css` 的 `@theme` 改成 `@theme static`**

打开 `web/src/tw.css`，把 Task 6 写下的这一行：

```css
@theme {
```

改成：

```css
/* static：无条件发射全部 token。Tailwind v4 默认只发射"被 utility 用到"的变量，
   而手写 CSS（styles.css）里的 var(--color-weak) 这类引用对它是不可见的
   ——官方文档原话 "By default only used CSS variables will be generated in the
   final CSS output."。传送带等自绘件从 styles.css 直接读 token，不加 static
   会静默失效（不报错、测试还全绿、只有真人看页面才发现颜色糊了）。 */
@theme static {
```

文件其余部分（`@layer` 声明、两个 `@import`、所有 token 行）**一个字符都不动**。

- [ ] **Step 2: 迁移传送带段的 token**

打开 `web/src/styles.css`，定位到传送带段（段落注释在 `:1369-1379`，规则在 `:1380-1425`）。

改动一（`:1399` 字体栈）——把：

```css
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
```

改成：

```css
  font-family: var(--font-mono);
```

> 为什么可以丢掉 `'Geist Mono'`：全仓**没有任何 `@font-face`、也没有字体文件资源**（这一点在
> Step 3 的验证里会被 grep 复核）。也就是说 `'Geist Mono'` 只对"本机恰好装了 Geist Mono 的人"
> 生效，对其他所有人是空跳到下一档 `ui-monospace`。刻意裁决：**不依赖不随包发布的字体**，
> 统一走 `--font-mono`（值 = `ui-monospace, SFMono-Regular, Menlo, monospace`，即原字体栈去掉
> 首档）。装了 Geist Mono 的开发者本机会看到字形变化，这是预期内的、正确的变化。

改动二（`:1414-1418` 四档亮度）——把：

```css
.conveyor-row:nth-last-child(1) { color: var(--color-text-primary); }
.conveyor-row:nth-last-child(2) { color: var(--color-text-secondary); }
.conveyor-row:nth-last-child(3) { color: var(--color-text-gray); }
.conveyor-row:nth-last-child(4) { color: var(--color-text-disabled); }
.conveyor-row:nth-last-child(n + 5) { color: var(--color-text-disabled); }
```

改成：

```css
/* 第 1 档（最新行）在常态下由 Shimmer 用 bg-clip-text 自己画字，不吃这里的 color；
   这条规则是 prefers-reduced-motion 下退回纯文本时的兜底色——不要因为"看起来没用"删掉。
   值 #e6e8ec 与 Shimmer 高光色 var(--color-foreground) 相同，两条路径峰值亮度一致。 */
.conveyor-row:nth-last-child(1) { color: var(--color-foreground); }
.conveyor-row:nth-last-child(2) { color: var(--color-muted-foreground); }
.conveyor-row:nth-last-child(3) { color: var(--color-weak); }
.conveyor-row:nth-last-child(4) { color: var(--color-faint); }
.conveyor-row:nth-last-child(n + 5) { color: var(--color-faint); }
```

**这是纯改名，四个颜色值逐字节相同**，出处对照（两侧都实测过）：

| legacy token | 值 | 出处 | 新 token | 出处 |
|---|---|---|---|---|
| `--color-text-primary` | `#e6e8ec` | `web/src/theme/scout.css:96` | `--color-foreground` | `web/src/tw.css`（Task 6） |
| `--color-text-secondary` | `#9aa1ac` | `scout.css:97` | `--color-muted-foreground` | 同上 |
| `--color-text-gray` | `#6b7280` | `scout.css:175` | `--color-weak` | 同上 |
| `--color-text-disabled` | `#4b5563` | `scout.css:98` | `--color-faint` | 同上 |

改动三（段落注释）——段首注释里描述亮度分级的那句，补一句说明最新行的新实现。把段注释里
"最新行最亮"一类措辞所在的行，改写为（措辞可依现场文字微调，事实必须齐全）：

```css
   亮度分级：最新行（nth-last-child(1)）常态下由 AI Elements Shimmer 渲染（bg-clip-text，
   自带高光扫动）；往上三档 muted-foreground → weak → faint 递弱，第 5 行起与第 4 档同色。
   reduced-motion 下最新行退回纯文本，取上面那条 --color-foreground 兜底色。
```

`.conveyor`（`:1380-1388`）、`.conveyor-track`（`:1391-1394`）、`.conveyor-row` 的
`height`/`line-height`/`flex`/`font-size`/`animation`、`@keyframes conveyor-in`、
`@media (prefers-reduced-motion)` 块——**全部原样保留，一行不动**。特别地：
`.conveyor` 故意**没有** `justify-content: flex-end`（贴底是靠 track 的 `translateY` 位移做的，
见文件头 ⚠️ 段），不要"顺手补上"。

- [ ] **Step 3: 验证 token 迁移干净且真的进了产物**

第一验证：传送带段里不再有 legacy 颜色 token、不再有 Geist Mono。

```bash
cd web && awk '/活动页传送带/,/活动页 hero/' src/styles.css | grep -n "color-text-\|Geist Mono"
```

Expected: 无输出（grep 退出码 1）。

第二验证：全仓确实没有字体资源（复核 Step 2 丢 Geist Mono 的依据）。

```bash
cd web && grep -rn "@font-face" src/ ; ls src/assets 2>/dev/null
```

Expected: 无 `@font-face` 命中；`src/assets` 不存在或不含字体文件。

第三验证（最重要，`@theme static` 是否真的生效）：构建后到产物里找变量声明。

```bash
cd web && npm run build && grep -ro -- "--color-weak:[^;]*" dist --include='*.css' | head -5
```

Expected: 至少一条命中，形如 `dist/assets/index-XXXX.css:--color-weak: #6b7280`。

> **若这条为空**：说明 `@theme static` 没生效（Step 1 漏改，或 tw.css 未被 main.tsx import）。
> 不要往下走——这正是背景一描述的静默失效，此刻不抓住，后面 20 个 task 的 token 引用全是哑弹。
> 注意 `--include='*.css'` 的引号是必需的：zsh 下未加引号的 glob 若无匹配会直接中止整条命令。

同样核一下字体变量在场：

```bash
cd web && grep -ro -- "--font-mono:[^;]*" dist --include='*.css' | head -3
```

Expected: 至少一条命中。

- [ ] **Step 4: 跑既有测试确认零回归**

```bash
cd web && npx vitest run src/activity/ConveyorFeed.test.tsx
```

Expected: 19 passed。

> 为什么这一步没有"先写失败测试"：Step 2 是**纯改名**（四个颜色值逐字节相同），没有新行为可测，
> 既有 19 条（含两条 `cssDecl` 的 JS↔CSS 耦合锁）就是这次改名的回归网。真正的 TDD 从 Step 6 开始。

顺带核一次活动页其它测试没被 `styles.css` 改动波及：

```bash
cd web && npx vitest run src/activity/
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/tw.css web/src/styles.css
git commit -m "refactor(web): 传送带段 token 迁移到新栈 + tw.css 改 @theme static"
```

- [ ] **Step 6: 写失败的测试（四条，追加到文件末尾）**

打开 `web/src/activity/ConveyorFeed.test.tsx`，**在文件最末追加**下面整块。既有的
`declare const __STYLES_CSS__`、`cssDecl`、`events`、`rect`、`beforeEach`/`afterEach`、
`renderFeed`、`rowsOf` 全部复用，**一个字都不改**。

```tsx
/** 把 window.matchMedia 临时换成"用户要求减少动效"，跑完立刻还原。
 *  不用 vi.spyOn：window.matchMedia 在 setupTests.ts 里是直接赋值的普通属性，
 *  spy 的 configurability 与 restoreAllMocks 的交互容易出玄学问题；显式存/还原更好懂。 */
function withReducedMotion<T>(fn: () => T): T {
  const real = window.matchMedia
  window.matchMedia = ((q: string) => ({
    matches: /prefers-reduced-motion/.test(q),
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  try {
    return fn()
  } finally {
    window.matchMedia = real
  }
}

describe('ConveyorFeed 最新行的 shimmer', () => {
  it('最新一行的文字包在 Shimmer 的 span 里', () => {
    const { container } = renderFeed(events(3))
    const rows = rowsOf(container)
    const last = rows[rows.length - 1]
    // Shimmer 渲染 motion.span；文字不再是 .conveyor-row 的直接文本节点
    const span = last.querySelector('span')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe(last.textContent)
    expect(last.textContent).not.toBe('')
  })

  it('旧行不套 span，文字直接坐在 .conveyor-row 上', () => {
    const { container } = renderFeed(events(3))
    const rows = rowsOf(container)
    for (const row of Array.from(rows).slice(0, -1)) {
      expect(row.querySelector('span')).toBeNull()
      expect(row.textContent).not.toBe('')
    }
  })

  it('reduced-motion 下最新行退回纯文本', () => {
    const { container } = withReducedMotion(() => renderFeed(events(3)))
    const rows = rowsOf(container)
    const last = rows[rows.length - 1]
    expect(last.querySelector('span')).toBeNull()
    expect(last.textContent).not.toBe('')
  })

  it('只有一条事件时，那一条就是最新行（走 shimmer）', () => {
    const { container } = renderFeed(events(1))
    const rows = rowsOf(container)
    expect(rows).toHaveLength(1)
    expect(rows[0].querySelector('span')).not.toBeNull()
  })
})
```

> **为什么既有 6 条几何测试不受影响**（实现者不必额外操心，但要知道原因）：`Shimmer` 渲染的是
> 行内 `<span>`，塞在 `.conveyor-row` **内部**；行本身仍是 `.conveyor-track` 的直接子节点。
> 既有 `beforeEach` 里 `getBoundingClientRect` 垫片算行 top 用的是
> `Array.prototype.indexOf.call(track.children, row)`——口径完全没变。同理 `rowsOf` 用
> `.conveyor-row` 选择器，也不受内部多一层 span 影响。
>
> **为什么默认（不包 `withReducedMotion`）就会走 shimmer 分支**：`web/src/setupTests.ts` 里的
> `window.matchMedia` 垫片返回 `matches: false`，所以 hook 读到"不要求减少动效"。

- [ ] **Step 7: 跑测试确认失败**

```bash
cd web && npx vitest run src/activity/ConveyorFeed.test.tsx
```

Expected: 19 passed，**4 failed**。失败信息形如 `expected null not to be null`
（最新行还没有 span）以及 `reduced-motion` 那条报"找到了 span"之类——具体措辞不重要，
关键是**新增四条必须先红**。若有任何一条一上来就绿，说明测试没测到东西，停下来查。

- [ ] **Step 8: 建 `usePrefersReducedMotion` hook**

Create `web/src/lib/usePrefersReducedMotion.ts`:

```ts
/**
 * 读 prefers-reduced-motion 媒体查询，并跟随变化。
 *
 * 为什么不用 motion 自带的 useReducedMotion()：那个实现在模块作用域初始化时就把偏好
 * 读进缓存（import 时跑一次），测试里事后替换 window.matchMedia 换不动它——依赖它会让
 * "reduced-motion 下退回纯文本"这个分支变成不可测、且依赖 import 顺序的代码。
 *
 * 每次 render 现读 matchMedia，并订阅 change 事件（用户在系统设置里现场改也能跟上）。
 * SSR / 没有 matchMedia 的环境返回 false（不减少动效），与浏览器默认一致。
 */
import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

function read(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(QUERY).matches
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(read)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mql.addEventListener?.('change', onChange)
    return () => mql.removeEventListener?.('change', onChange)
  }, [])
  return reduced
}
```

> `addEventListener?.(...)` 的可选调用不是防御性废话：测试垫片给的是手写对象，
> 老 Safari 的 MediaQueryList 也只有 `addListener`。少一层可选调用，测试环境直接抛。

- [ ] **Step 9: 接线 `ConveyorFeed.tsx`**

改动一（import 区 `:44-46`）——现在是三行，改成五行，**按路径字母序**：

```tsx
import type { TraceEvent } from '../api/types.js'
import { Shimmer } from '../components/ai/shimmer.js'
import { useT } from '../i18n/useT.js'
import { usePrefersReducedMotion } from '../lib/usePrefersReducedMotion.js'
import { toolPhrase } from '../workflow/phrases.js'
```

改动二（函数体的 `map`）——把：

```tsx
  const { lang } = useT()
  const visible = Math.max(1, Math.floor(rows))
```

改成：

```tsx
  const { lang } = useT()
  const reducedMotion = usePrefersReducedMotion()
  const visible = Math.max(1, Math.floor(rows))
  const latest = events.length - 1
```

并把 `map` 那段：

```tsx
        {events.map((e) => (
          <div className="conveyor-row" key={`${e.runKey}#${e.seq}`}>
            {toolPhrase(e.tool, lang)}
          </div>
        ))}
```

改成：

```tsx
        {events.map((e, i) => {
          const phrase = toolPhrase(e.tool, lang)
          return (
            // key 仍然是 runKey#seq —— i 只用来判"是不是最新行"，绝不进 key
            <div className="conveyor-row" key={`${e.runKey}#${e.seq}`}>
              {i === latest && !reducedMotion ? <Shimmer>{phrase}</Shimmer> : phrase}
            </div>
          )
        })}
```

> ⚠️ **`i` 绝不进 key。** 本文件文件头明令禁止下标 key，且既有两条测试（滑动窗口掐头 /
> 纯追加，都断言 DOM 节点 identity 不变）会立刻抓住违规。引入 `i` 唯一的用途是回答
> "这是不是数组最后一个"，用完即弃。

改动三（文件头注释 `:19-20`）——那两行讲亮度分级的话现在不再准确（最新行不再靠 CSS 上色），
改写为（措辞可微调，事实必须齐全）：

```tsx
 * 亮度分级：最新行（数组末位）常态下用 AI Elements Shimmer 渲染，高光扫动即"正在发生"的线索；
 * 往上三档由 styles.css 的 :nth-last-child(2..4) 递弱上色。prefers-reduced-motion 下最新行
 * 退回纯文本，取 :nth-last-child(1) 的 --color-foreground 兜底色（那条 CSS 规则因此不是死代码）。
```

文件头的 L8/L9 决策记录、以及 ⚠️ 那段讲"贴底靠 track translateY、不靠 justify-content"的说明，
**逐字保留**。

- [ ] **Step 10: 跑测试确认全绿 + 类型检查**

```bash
cd web && npx vitest run src/activity/ConveyorFeed.test.tsx
```

Expected: **23 passed**（19 既有 + 4 新增）。

```bash
cd web && npx tsc --noEmit
```

Expected: 无输出。

```bash
cd web && npx vitest run src/activity/
```

Expected: 全绿（确认 shimmer 接线没波及 ActivityPage 等消费方的测试）。

- [ ] **Step 11: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/lib/usePrefersReducedMotion.ts web/src/activity/ConveyorFeed.tsx web/src/activity/ConveyorFeed.test.tsx
git commit -m "feat(web): 传送带最新行改用 AI Elements shimmer, 尊重 reduced-motion"
```

---

**Task 31 前置备忘（写在这里因为本 task 第一次碰 `styles.css` 的 `@import` 邻域，别到卸载那天才发现）：**

`web/src/styles.css:7-9` 是**三行** `@import`，不是两行：

```css
@import '@astryxdesign/core/reset.css';
@import '@astryxdesign/core/astryx.css';
@import './theme/scout.css';
```

第一行那个 `reset.css` 的真实文件是 `node_modules/@astryxdesign/core/src/reset.css`
（`/reset.css` 是 package.json export map 的别名），**437 行**，文件头自述
"Built on the same principles as Tailwind Preflight and modern-normalize"：全局
`box-sizing: border-box`、`:where()` 零特异性、`@layer reset`。而 Task 6 建的 `tw.css`
**故意没有引 preflight**（理由当时写的是"Astryx reset.css 已是全局 reset，双 reset 互踩"）。

所以 Task 31 删这三行 `@import` 时，**必须同时补一个 reset**，否则整站丢掉 437 行的
盒模型/normalize 基线，表现是全站间距与默认样式集体走形（而且不会有任何构建报错）。
替代方案就一条：`tw.css` 顶部加 `@import "tailwindcss/preflight" layer(base);`
（或把三个分片 import 换成整包 `@import "tailwindcss";`）。Task 31 会把这件事写成显式步骤。

### Task 13: ActivityHero —— Astryx 卸载 + hero 发动机开关

Activity 六件的第二件。hero 是活动页的门面，也是**唯一一个既要换栈又要长出新功能**的组件：
Spec C §5.2 要求"hero 右上角一枚发动机开关"（用户原话："发动机开关那个我觉得可以放在活动页
hero 的右上角，因为那是我最常盯的一屏"）。两件事一个 commit 里混着做会让回归网失效，所以本
task 严格分成两个 commit：① 纯栈迁移，零行为变化，既有 **53** 条测试一条不改就是回归网；
② 开关，TDD 先红。

Astryx 面按 Task 12 那张表：hero 的 import 是 `Text` / `VStack` / `HStack` 三个，**没有
`Button`**（那是 L11 裁决，`ActivityHero.test.tsx:527` 有 `toHaveLength(0)` 的锁）。

**Files:**
- Modify: `web/src/styles.css`（hero 段 `:1427-1587`：四处 legacy 颜色 token 改名 + 两处注释补写。盒模型、两条渐变、`aspect-ratio`、`filter`、`transform`、三个 `@keyframes`、`@media (prefers-reduced-motion)` **一行不动**）
- Modify: `web/src/activity/ActivityHero.tsx`（删 `:65-67` 三行 Astryx import；`return` 体 `:130-201` 换朴素标记；commit ② 再加两个可选 prop + 一个 `Switch`）
- Test: `web/src/activity/ActivityHero.test.tsx`（既有 **53** 条一条不改；`:14` 的 import 加一个 `fireEvent`；文件末尾追加一个 `describe`，7 条）

**两个 commit：** ① token 迁移 + Astryx→Tailwind 标记替换（零行为变化）；② hero 发动机开关（先写红测试）。

---

#### 背景一：本 task 用到的全部五种 Astryx→Tailwind 替换（逐项等价依据）

| 原写法 | 替换 | 等价依据 |
|---|---|---|
| `<HStack gap={4} className="X">` | `<div className="X flex gap-4">` | Astryx HStack = `display:flex` + `gap`，默认 `vAlign='stretch'`——与 flex 的 `align-items` 默认值同义，所以**不补** `items-*`；间距刻度两栈逐字节相同（`gap-4` = 1rem = Astryx `gap={4}`） |
| `<VStack gap={2} className="X">` | `<div className="X flex flex-col gap-2">` | 同上 + `flex-direction:column` |
| `<HStack gap={2} vAlign="center">` | `<div className="flex items-center gap-2">` | `vAlign='center'` → `align-items:center` |
| `<HStack vAlign="center" hAlign="between">` | `<div className="flex items-center justify-between">` | `hAlign='between'` → `justify-content:space-between` |
| `<Text type="large" weight="semibold">` | `<span className="text-base font-semibold">` | Astryx Text 渲染 `<span>`；`type="large"` = `1rem` / `line-height:1.5` / 无字重（`weight="semibold"` 给 600）。Tailwind `text-base` = `1rem` / `1.5rem`（即 1.5），`font-semibold` = 600 |
| `<Text type="body" color="secondary">` | `<span className="text-[13px] leading-5 text-muted-foreground">` | `type="body"` = `0.8125rem`（13px）/ `line-height:1.5385`（=20px）/ 400；`color="secondary"` = `var(--color-text-secondary)` = `#9aa1ac` = 新栈 `--color-muted-foreground`（**已核对两侧十六进制**） |
| `<Text type="code" color="secondary">` | `<span className="font-mono text-[13px] leading-5">`（**不给颜色类**） | `type="code"` = body 的字号/行高 + `var(--font-family-code)`。颜色为什么不给：见背景四第 4 行 |

**`font-mono` 与 `--font-family-code` 的差异，以及为什么它在真机上是零差异（本 task 现场核实）：**

`web/src/theme/scout.css:174` 是
`--font-family-code: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;`，
新栈 `tw.css` 的 `--font-mono` 是 `ui-monospace, SFMono-Regular, Menlo, monospace`——少了首位的
`"Geist Mono"`。核实结论：**Geist Mono 从来没被加载过**，所以那一位一直是死字：

- `web/index.html` 全文 11 行，`<head>` 里只有 `charset` / `viewport` / `<title>`，**没有任何字体 `<link>`**；
- `web/` 下没有任何 `.woff/.woff2/.ttf/.otf` 资源（`find` 过，排除 node_modules 后为空）；
- `web/src` 下 `@font-face` 零命中；
- `web/package.json` 没有 `geist` 依赖；`@astryxdesign/core` 包里 "Geist" 的命中全在 `theme/types.ts` / `defineTheme.ts` 这类**类型与默认值**文件里，不含字体文件。

也就是说 `font-family` 解析时首位 `"Geist Mono"` 恒不可用、直接落到 `ui-monospace`——与新栈第一位
同名同序。Task 12 给传送带做同一处替换时的取值因此也是对的。**不要**为了"保真"去把 Geist Mono
装进来：那是新增一个字体依赖，不是迁移。

#### 背景二：`.act-hero-body` / `.act-hero-main` 的 `display:flex` 从来不在 CSS 里

这是本 task 最容易踩塌的一处。`styles.css` 里：

```css
.act-hero-body { position: relative; z-index: 2; height: 100%; }   /* :1466-1470 —— 没有 display */
.act-hero-poster { …; flex: none; … }                              /* :1476 */
.act-hero-main  { min-width: 0; flex: 1; }                         /* :1491-1494 —— 没有 display */
```

`flex: none` 与 `flex: 1` 都在 CSS 里，但**把父元素变成 flex 容器这件事一直是 Astryx
HStack/VStack 干的**。所以替换时那两个 `flex` / `flex-col` 类是**承重结构**，不是装饰：漏掉
`.act-hero-body` 的 `flex`，`flex:none` 与 `flex:1` 双双失效 → 海报横向铺满、主栏掉到下一行，
而 **jsdom 不做布局，53 条测试全绿**，只有真人开页面才看得见。Task 33 的实机目视是这条的唯一
兜底，所以 Step 5 的代码块里给这件事留了一段注释——别删。

同一个坑在 `ActivityStuck.tsx` 也有一份：它 `:151/:155` 复用了 `.act-hero-body` / `.act-hero-main`
（整套几何复用，见该文件 `:127` 的注释）。**Task 16 替换 stuck 的 HStack/VStack 时必须同样补上
`flex` / `flex flex-col`**。本 task 只改 hero 一侧；Astryx 卸载在 Task 31，所以 13→16 之间
stuck 仍由 Astryx 供 flex，中间态不坏。

#### 背景三：发动机状态必须当 props 进来，不能在 hero 内部 `useSetupStatus()`

`engineEnabled` 只挂在两个 DTO 上：`SetupStatusDTO`（Plan A `:1029`）与 `SettingsDTO`
（Plan A `:2463`）。hero 拿到的 `WorkflowRunningWorkerDTO` 上**没有**这个字段，所以状态必须另找
来源。两条路：

1. hero 内部自己调 `useSetupStatus()`；
2. 由 `ActivityPage` 调，结果当 props 传进来。

**必须走 2。** 走 1 会当场毁掉既有的 53 条测试：`useSetupStatus()` 是 `web/src/api/hooks.ts`
的自轮询 hook（`Async<T>` = `{ data, loading, error, reload }`，15 秒一拍，仓库里没有
react-query/swr，每个实例各自轮询），而 53 条用例里没有一条 mock 过 `fetch`。后果是每条用例都
在 `act()` 外收到异步 setState 警告、并挂上一个 15 秒 interval——一个"给 hero 加个开关"的改动会
让整个文件变成噪音场。

而 props 注入正是这个文件**已有的**成文约定：`now` 就是这么处理的（`:85-87` 原注释："由调用方
注入（不在组件内读 `Date.now`）——时间是入参而非副作用，测试才能确定性地断言读数"）。
`missingCount` 同理。发动机状态属于同一类：外部世界的事实，从上面流下来。

两个 prop 都设计成**可选**，都缺席时开关整块不渲染。这条不是偷懒，它有两个真实收益：
① 既有 53 条用例（`renderHero` 只传 `running`/`missingCount`/`now`）一行不改，且 `:527` 那条
`querySelectorAll('button')).toHaveLength(0)` 的 L11 锁**逐字保留**——不需要为了新控件去放宽它；
② `ActivityStuck` 之类将来可能复用 hero 的地方不会被迫接线发动机。

写入侧（PUT `settings` + `reload()`）全部在 Task 18 的 `ActivityPage` 里，见本 task 末尾的备忘。

#### 背景四：`:1427-1587` 区间内 legacy token 的逐处清单

区间内 `--color-*` 的 legacy 名共出现 **6** 次，但只有 **4** 处需要改名：

| 行 | 现值 | 处置 | 依据 |
|---|---|---|---|
| `:1444` | `var(--color-background-card)` | → `var(--color-card)` | 两侧都是 `#111318`（`scout.css:104` vs `tw.css` `--color-card`） |
| `:1479` | `var(--color-border)` | **不动** | 新旧同名，且值同为 `rgba(255,255,255,0.07)`（`scout.css:107`）。Task 31 删掉 `scout.css` 后由 `tw.css` 的声明接管，无缝 |
| `:1480` | `var(--color-background-surface)` | → `var(--color-secondary)`（评审修订：accent 被 scout.css 遮蔽成柠檬绿，铁律走 secondary 同值） |
| `:1496` | `--color-text-orange` | **在注释里**，随注释一起重写 | 它是旧主题的黄；新栈不提供任何黄 token，注释按新事实改写（见 Step 2 的第 2 处编辑） |
| `:1524` | `var(--color-text-secondary)` | → `var(--color-muted-foreground)` | 两侧都是 `#9aa1ac`（`scout.css:97`） |
| `:1546` | `var(--color-text-gray)` | → `var(--color-weak)` | 两侧都是 `#6b7280`（`scout.css:175`） |

（`scout.css` 里这些值写成 `light-dark(#xxx, #xxx)`，两参同值，等价于常量——本项目只有暗色一套。）

**`.act-hero-facts > *` 这一条是跨屏共用的，本 task 迁一次、迁完为止：**
`ActivityStuck.tsx:195` 也套 `.act-hero-facts`，而 `styles.css:1725-1727` 的注释明确写了
stuck 的"4 小时后重试"那行**刻意不另写颜色**、就吃 hero 这条 gray 规则。所以：

- 本 task 把 `:1546` 改成 `var(--color-weak)`，两屏一起受益；
- **Task 16 不要再迁移它一次**（那条规则届时已经是新 token 了）。Task 16 名下的 stuck 颜色只有
  `.act-stuck-fact`（`:1722-1724`）与 `.act-hero-pulse[data-tone='bad']`（`:1717-1719`）那两处
  `--color-text-red`，且 `ActivityStuck.test.tsx:105` 对后者的值有 `cssDecl` 断言，Task 16 改
  token 名时必须同步那一行。

**为什么四处改名不会弄红任何既有断言（已逐条核对）：**

- `ActivityHero.test.tsx` 里读 CSS 源文件的断言只有五处：`.act-hero-poster` 的 `aspect-ratio`
  （`:122`、`:216`）、`.act-hero-blur-poster` 的 `filter`/`transform`（`:205`、`:209`）、
  `.act-hero[data-art='blur-poster'] .act-hero-poster` 的 `width`（`:218`、`:221`）、
  `.act-hero-pulse` 的 `background`（`:566`，值是裸 `#8b7cf6` 不是 token）。**没有一条读上表里的
  四个属性。**
- `:589` 那条颜色白名单扫描的允许式是 `/^(var\(--color-[a-z-]+\)|#8b7cf6|transparent|currentColor|inherit|none|0)$/`，
  `--color-card` / `--color-accent` / `--color-muted-foreground` / `--color-weak` 四个新名全部
  匹配 `var\(--color-[a-z-]+\)`（纯小写+连字符）→ 照绿。
- `ActivityStuck.test.tsx:171-181` 扫所有含 `act-hero-bar` 的规则块，断言里面**没有红**
  （`color-text-red` / `#f8xxxx` / `\bred\b`）。`--color-muted-foreground` 三条都不沾 → 照绿。
- `ActivityDone.test.tsx:252` 断言某个 `data-tone='neutral'` 块里有 `--color-text-gray`——那是
  **Done 段**的规则（不在 `:1427-1587` 内），本 task 不碰它；它归 Task 15。

---

- [ ] **Step 1: 先跑基线，确认 53 条本来就是绿的**

```bash
cd web && npx vitest run src/activity/ActivityHero.test.tsx
```

Expected: **53 passed**。若这里就有红，停下来报告——不要在红底子上做迁移（分不清是谁弄红的）。

- [ ] **Step 2: `styles.css` hero 段：四处 token 改名 + 两处注释重写**

第 1 处（`.act-hero` 的卡片底色）。把

```css
  min-height: 36vh;
  background: var(--color-background-card);
}
```

改成

```css
  min-height: 36vh;
  background: var(--color-card);
}
```

第 2 处（海报框的面色；顺带说明 `--color-border` 为什么留着）。把整条 `.act-hero-poster` 规则

```css
.act-hero-poster {
  aspect-ratio: 2 / 3;
  width: 132px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-background-surface);
}
```

改成

```css
.act-hero-poster {
  aspect-ratio: 2 / 3;
  width: 132px;
  /* flex:none / .act-hero-main 的 flex:1 都在这里，但**父元素的 display:flex 不在 CSS 里**
     ——它由 ActivityHero.tsx 的 `.act-hero-body flex` 类给（迁移前是 Astryx HStack）。
     删了那个类这两行就一起失效，而 jsdom 不做布局、测试照绿。 */
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  /* --color-border 新旧两栈同名同值（rgba(255,255,255,0.07)），故沿用不改名：
     Task 31 删掉 scout.css 后由 tw.css 的那条声明接管。 */
  border: 1px solid var(--color-border);
  background: var(--color-secondary); /* 评审修订：accent 被 scout.css 遮蔽成柠檬绿，过渡期铁律走 secondary（同值 #16181f） */
}
```

第 3 处（脉动点上方那段注释里的旧黄 token 名）。把

```css
/* 脉动点：正常运行态唯一的"活着"信号。中性紫——**不是黄**（黄在本设计系统里是警示色
   --color-text-orange，用它报"一切正常"会和真警示撞语义），也不是 accent lime（每屏至多一处
   亮色的配额留给别处，DESIGN.md §2）。
   data-tone 是给下一个任务（卡死态转红）留的色彩钩子：颜色按属性选，组件层不写死任何红。 */
```

改成

```css
/* 脉动点：正常运行态唯一的"活着"信号。中性紫——**不是黄**（黄是警示色，用它报"一切正常"会
   和真警示撞语义。旧 Astryx 主题里那个黄叫 --color-text-orange，新栈的 tw.css 索性一个黄
   token 都不提供），也不是 accent lime（每屏至多一处亮色的配额留给别处，DESIGN.md §2）。
   data-tone 是给卡死态（ActivityStuck）留的色彩钩子：颜色按属性选，组件层不写死任何红。 */
```

第 4 处（进度条填充色）。把

```css
.act-hero-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--color-text-secondary);
```

改成

```css
.act-hero-bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--color-muted-foreground);
```

第 5 处（事实行的弱色——跨屏共用的那条）。把

```css
.act-hero-facts > * {
  /* ink 弱（DESIGN.md §2 的 --color-text-gray）。Text 的 color 枚举里没有 gray，
     所以这一档只能在 CSS 里给——不是绕过设计系统，是补它没暴露的那一档。 */
  color: var(--color-text-gray);
}
```

改成

```css
.act-hero-facts > * {
  /* ink 弱那一档。**hero 与 ActivityStuck 共用这一条**（stuck 的事实行也套
     .act-hero-facts，见 :1725 的注释：它刻意不另写颜色，就吃这条）。
     组件层一律**不给颜色类**。迁移前这里有第二个颜色来源（Astryx Text 的 color="secondary"
     → scout.css 的 .astryx-text.secondary），本规则赢它靠的**不是特异性**（`.act-hero-facts > *`
     是 0-1-0，输给 0-2-0），而是 **cascade layer**：那条在 @layer astryx-theme 里
     （scout.css:79 开层、:275 那行），而 styles.css 全文没有 @layer——未分层声明优先于任何
     分层声明。所以这一档 ink 一直是 --color-text-gray 而不是 secondary，迁移后颜色只剩这
     一个来源，那场架不存在了。
     ⚠️ 同一条 layer 规则也意味着：在套了本类的元素上加 text-* 颜色工具类是**无效**的
     （Tailwind utilities 也在 @layer utilities 里，照样输给未分层的本条）。
     ⚠️ 本条的 token 迁移属于 Task 13，Task 16 不要再迁一次。 */
  color: var(--color-weak);
}
```

- [ ] **Step 3: 跑测试确认 token 改名没弄红任何断言**

```bash
cd web && npx vitest run src/activity/
```

Expected: 全绿（hero 53 条 + queue/done/stuck/empty/conveyor/page 各自的既有条数）。
特别关注三条会被误伤的：hero 的颜色白名单扫描、stuck 的"条上无红"扫描、done 的
`data-tone='neutral'` 块断言——它们全绿才说明改名边界切对了。

- [ ] **Step 4: 删掉 `ActivityHero.tsx` 的三行 Astryx import**

删除 `:65-67`：

```tsx
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
```

**不加任何替代 import**（朴素 `div`/`span` 不需要）。其余 import（`backdropUrl` / `posterUrl` /
`useT` / `PosterThumb` / `ConveyorFeed` / `useLiveTrail` / `stageFromTrail` / `stageModeOf` /
`formatElapsed` / `heroSubtitle` / `missingLine`）一行不动。

- [ ] **Step 5: 换掉 `return` 体（`:130-201`）**

整块替换成下面这段。**每一条既有注释都在里面**（progressbar 无障碍那段、indeterminate 不给
width 那段、data-tone 钩子那段、scrim / 模糊降级那两段）——它们是裁决的现场记录，不是废话：

```tsx
  return (
    // data-art 让 CSS 知道走的是哪条美术路径：'backdrop' 正常出血、'blur-poster' 模糊海报降级、
    // 'none' 图都没有。海报尺寸按它选（模糊分支下海报更大，因为背景不再承担叙事）。
    <div className="act-hero" data-testid="activity-hero" data-art={bd ? 'backdrop' : blurred ? 'blur-poster' : 'none'}>
      {bd ? (
        <div
          className="act-hero-backdrop"
          style={{ backgroundImage: `url(${bd})` }}
          aria-hidden="true"
          data-testid="activity-hero-backdrop"
        />
      ) : null}
      {/* 模糊海报背景（spec §8.3 电影降级）。blur/scale 全在 CSS 里——比例与滤镜是这条裁决的
          真身，测试对着 CSS 源文件断言 blur 确实在场。 */}
      {blurred ? (
        <div
          className="act-hero-blur-poster"
          style={{ backgroundImage: `url(${blurred})` }}
          aria-hidden="true"
          data-testid="activity-hero-blur-poster"
        />
      ) : null}
      {/* 左侧渐变遮罩压暗：让排印在任何一张背景图上都可读。纯装饰，aria-hidden。 */}
      <div className="act-hero-scrim" aria-hidden="true" />
      {/* `flex gap-4` 替代原来的 <HStack gap={4}>。两件事记牢：
          ① Astryx HStack 的默认 vAlign 是 'stretch'，与 flex 的 align-items 默认值同义，
             所以这里**不补** items-* 类（补了才是改设计）。
          ② 这个 flex 是**承重**的：.act-hero-poster 的 flex:none 与 .act-hero-main 的 flex:1
             写在 styles.css 里，但 display:flex 从来只由这里给。删掉它 → 海报横向铺满、主栏
             掉行，而 jsdom 不做布局，测试不会红。 */}
      <div className="act-hero-body flex gap-4">
        <div className="act-hero-poster" data-testid="activity-hero-poster">
          <PosterThumb posterPath={running.posterPath} name={title} />
        </div>
        <div className="act-hero-main flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold">{title}</span>
            {/* ⚠️ 这个 flex 是**承重**的，不是装饰：.act-hero-pulse 在 CSS 里只有
                width/height/border-radius/flex/background/animation，**没有 display**
                （styles.css:1499-1506）。<span> 默认 inline，而 inline 元素忽略 width/height——
                这个点能是个 6px 的圆，全靠它作为 flex item 被 blockify。删掉这里的 flex，
                点会**整个消失**，而 jsdom 不做布局、测试照绿。 */}
            <div className="flex items-center gap-2">
              {/* 脉动点：正常运行态的唯一"活着"信号。中性紫，不是黄/蓝（铁律①）。
                  data-tone 是给下一个任务（卡死态转红）留的钩子——这里恒 'live'，
                  颜色分支在 CSS 里按 data-tone 选，本组件不写死任何红。 */}
              <span className="act-hero-pulse" data-tone="live" aria-hidden="true" />
              <span className="text-[13px] leading-5 text-muted-foreground">{subtitle}</span>
            </div>
          </div>
          <ConveyorFeed events={trail} rows={3} />
          {/* 进度条：无 role="progressbar"、无 aria-valuenow。这是刻意的——
              progressbar 的无障碍契约要求可读的 value/百分比，而裁决 L10 恰恰是"UI 层面把百分
              比这个麻烦事消掉"。给屏幕阅读器念一个百分比会从后门把它加回来，且那个数字对"agent
              走到哪个阶段"这个语义本身就没有用户可解释的含义。真正的进展叙述由上方的传送带
              （role="log"）承担，那才是可读的。所以这里是纯装饰条，aria-hidden。 */}
          <div
            className="act-hero-bar"
            data-mode={mode}
            aria-hidden="true"
            data-testid="activity-hero-bar"
          >
            <div
              className="act-hero-bar-fill"
              data-testid="activity-hero-bar-fill"
              // indeterminate 时**不给 width**：宽度由 CSS 动画驱动（一段固定宽度的亮块来回
              // 扫）。给了 style.width 就等于假装知道走到哪了。
              style={width === null ? undefined : { width: `${width}%` }}
            />
          </div>
          {/* 两行事实。font-mono + text-[13px] + leading-5 = 原 Text type="code" 的等价三件
              （字族/字号/行高）。**颜色刻意不给类**：弱色那一档由 styles.css 的
              `.act-hero-facts > *` 统一给，那条规则与 ActivityStuck 共用。
              这里不是"少写一个类"，是**写了也没用**——styles.css 全文未分层，而 Tailwind
              utilities 在 @layer utilities 里，未分层声明赢任何分层声明（跟特异性无关）。
              想改这一档 ink 只能改 CSS 那一条。 */}
          <div className="act-hero-facts flex items-center justify-between">
            <span className="font-mono text-[13px] leading-5">{elapsed}</span>
            {/* 右下角背景信息。missingCount 缺席（undefined/null）→ 整行不渲染。 */}
            {typeof missingCount === 'number' ? (
              <span className="font-mono text-[13px] leading-5" data-testid="activity-hero-missing">
                {missingLine(missingCount, lang)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
```

`:90-128` 那一整段（`useT()` / `stageModeOf` / `useLiveTrail` / `mode === 'hidden'` 的 early
return / `bd` / `blurred` / `kind` / `title` / `subtitle` / `elapsed` / `width`）**一行不动**。
特别是 `:105-109` 那段"early return 必须在所有 hook 之后"的注释与它约束的顺序——本 task 不
碰它，commit ② 也不碰（新加的 prop 不引入 hook）。

- [ ] **Step 6: 跑测试 + 类型检查**

```bash
cd web && npx vitest run src/activity/ActivityHero.test.tsx
```

Expected: **53 passed**（一条不多一条不少——本 commit 是零行为变化）。

```bash
cd web && npx tsc --noEmit
```

Expected: 无输出。若报 `Text`/`VStack`/`HStack` 未使用之类，说明 Step 4 的三行没删干净。

```bash
cd web && grep -n "astryxdesign" src/activity/ActivityHero.tsx || echo "clean"
```

Expected: `clean`。

- [ ] **Step 7: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/activity/ActivityHero.tsx
git commit -m "refactor(web): hero 卸 Astryx 换 Tailwind 标记 + hero 段 token 迁移"
```

- [ ] **Step 8: 写发动机开关的红测试（追加 7 条）**

先把 `:14` 的 import 加一个 `fireEvent`（仓库既有惯例就是它，`App.test.tsx:102` 等处；
`web/package.json` 没有 `@testing-library/user-event`，别引新依赖）：

```tsx
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
```

然后在**文件末尾**追加：

```tsx
// ── hero 发动机开关（Spec C §5.2：用户原话"放在活动页 hero 的右上角，因为那是我最常盯的一屏"）
//
// 两个 prop 都是可选的，且**都缺席时整块不渲染**——所以上面那 53 条用例（renderHero 只传
// running/missingCount/now）一行不用改，`:527` 那条 L11 "无暂停按钮" 的
// querySelectorAll('button')).toHaveLength(0) 也逐字保留。开关在场时的按钮唯一性由本段
// 自己的锁负责（下面第 2 条）。
//
// 为什么状态是 props 而不是组件内 useSetupStatus()：那是个 15 秒自轮询的 hook，53 条用例没有
// 一条 mock 过 fetch，引进来等于给整个文件挂上 act() 外的异步 setState + 一个 interval。
// 这个文件对 `now` 早就是同一手法（见 Props 的注释）。写入侧（PUT settings + reload）在
// ActivityPage（Task 18）。
function renderEngineHero(opts: {
  engineEnabled: boolean
  onEngineChange?: (next: boolean) => void
  lang?: Lang
  over?: Partial<WorkflowRunningWorkerDTO>
}) {
  const lang: Lang = opts.lang ?? 'zh'
  return render(
    <I18nProvider initialLang={lang}>
      <ActivityHero
        running={running(opts.over)}
        missingCount={9}
        now={T0 + 134_000}
        engineEnabled={opts.engineEnabled}
        onEngineChange={opts.onEngineChange ?? (() => {})}
      />
    </I18nProvider>,
  )
}

describe('ActivityHero：发动机开关', () => {
  it('不传发动机 props → 开关整块不渲染（既有调用方一行不改也不会多出控件）', () => {
    const { container } = renderHero({}, { missingCount: 9 })
    expect(container.querySelector('[data-testid="activity-hero-engine"]')).toBeNull()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('engineEnabled=true → 开关在场、aria-checked=true，且它是整屏唯一的可点控件', () => {
    const { container } = renderEngineHero({ engineEnabled: true })
    const sw = screen.getByRole('switch')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    // L11 的"无暂停按钮"在开关在场时演化成"只有这一个控件"：多出第二个就是有人偷偷加了
    // 暂停/重试之类的入口。顺带把 pause 的文案与类名锁一起重复一遍。
    const buttons = container.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toBe(sw)
    expect(container.innerHTML.toLowerCase()).not.toContain('pause')
    expect(container.textContent).not.toContain('暂停')
  })

  it('engineEnabled=false → aria-checked=false（关态照实渲染，不是不渲染）', () => {
    renderEngineHero({ engineEnabled: false })
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  })

  it('开态点一下 → onEngineChange(false)', () => {
    const calls: boolean[] = []
    renderEngineHero({ engineEnabled: true, onEngineChange: (n) => calls.push(n) })
    fireEvent.click(screen.getByRole('switch'))
    expect(calls).toEqual([false])
  })

  it('关态点一下 → onEngineChange(true)', () => {
    const calls: boolean[] = []
    renderEngineHero({ engineEnabled: false, onEngineChange: (n) => calls.push(n) })
    fireEvent.click(screen.getByRole('switch'))
    expect(calls).toEqual([true])
  })

  it('开关旁的可见文案取既有 i18n 键 settings_engine_label（不新拟文案）', () => {
    renderEngineHero({ engineEnabled: true, lang: 'en' })
    expect(screen.getByText('Engine')).toBeInTheDocument()
    cleanup()
    renderEngineHero({ engineEnabled: true, lang: 'zh' })
    expect(screen.getByText('发动机')).toBeInTheDocument()
  })

  it('hidden 模式（orchestrate）→ 整个 hero 不渲染，开关随之缺席（Spec C §9）', () => {
    const { container } = renderEngineHero({
      engineEnabled: true,
      over: { taskType: 'orchestrate' },
    })
    expect(container.querySelector('.act-hero')).toBeNull()
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
```

- [ ] **Step 9: 跑，确认红在预期位置**

```bash
cd web && npx vitest run src/activity/ActivityHero.test.tsx
```

Expected: **55 passed / 5 failed**（合计 60）。逐条对照：

- 第 1 条（不传 props → 无开关）与第 7 条（hidden 模式）**现在就是绿的**——它们是守门锁，
  作用是在实现之后仍然保持绿。看到它们绿是对的，不是"测试没生效"。
- 其余 5 条全部死在 `getByRole('switch')`：
  `TestingLibraryElementError: Unable to find an accessible element with the role "switch"`。

```bash
cd web && npx tsc --noEmit
```

Expected: 报 `engineEnabled` / `onEngineChange` 不在 `ActivityHero` 的 props 上
（`Type '{ … engineEnabled: boolean; … }' is not assignable to type 'IntrinsicAttributes & Props'`）。
这条 tsc 红也是预期的——vitest 走 esbuild 不做类型检查，所以类型错不会让上面那 55 条变红。

- [ ] **Step 10: 实现：两个可选 prop + 一枚 `Switch`**

① import 区追加一行（放在既有 `import { useT }` 上方，与其他相对 import 同一段）：

```tsx
import { Switch } from '../components/ui/switch.js'
```

来源确认：`web/src/components/ui/switch.tsx` 由 **Plan A** copy-in（Plan A `:3140`），Radix
底座，`data-[state=checked]:bg-fn-green`。A→C→B 的执行顺序保证它此刻已在。**不要自画开关、
不要装 `@radix-ui/react-label`**（Plan A 明确只 copy 四件：button/input/switch/card）。
路径是 `../components/ui/switch.js`（activity 只往上一层，同 `../library/PosterThumb.js`）。

jsdom 说明：Radix Switch 只在 `<form>` 内才渲染那个用到 `useSize`/`ResizeObserver` 的
`BubbleInput`——本处没有 form，所以它不渲染，`ResizeObserver` 用不到（Plan A 的两处 Switch
测试没垫 ResizeObserver 也是绿的，就是这个原因）。Task 7 的 `setupTests.ts` 垫片是额外保险。
也因此 DOM 里只有**一个** `<button role="switch">`，上面那条按钮唯一性锁才成立。

② `Props` 接口末尾追加：

```tsx
  /** 发动机总开关的当前状态（`SettingsDTO.engineEnabled` / `SetupStatusDTO.engineEnabled`）。
   *
   *  **由调用方注入**，本组件不调 `useSetupStatus()`——那是 15 秒自轮询的 hook，塞进来会让本
   *  文件既有的五十多条用例集体收到 act() 外的异步 setState 并挂上 interval。同 `now` 的口径：
   *  外部世界的事实从上面流下来。写入侧（PUT settings + reload）在 ActivityPage。
   *
   *  与 `onEngineChange` 两者都缺席时**整块开关不渲染**——既有调用方一行不改也不会多出控件。 */
  engineEnabled?: boolean
  /** 用户拨动开关时回调，参数是**目标态**（true=开）。本组件只报告"用户拨了它"，不自己写库。 */
  onEngineChange?: (next: boolean) => void
```

③ 函数签名与 `useT()` 解构：

```tsx
export function ActivityHero({ running, missingCount, now, engineEnabled, onEngineChange }: Props) {
  const { t, lang } = useT()
```

（`useT()` 返回 `{ lang, setLang, t }`，`t: (key: TKey) => string`，`TKey = keyof typeof en`；
`settings_engine_label` 这个键由 Plan A Task 15 加进 `en.ts`/`zh.ts`，值是 `'Engine'`/`'发动机'`。）

④ 在 `<div className="act-hero-scrim" aria-hidden="true" />` 与
`<div className="act-hero-body flex gap-4">` 之间插入：

```tsx
      {/* 发动机总开关（Spec C §5.2：用户要它在最常盯的这一屏的右上角）。
          - 定位：.act-hero 是 position:relative + padding:20px，所以 top-5/right-5（=20px）
            正好贴在内容边界上；z-[3] 压在 scrim(z-1) 与 body(z-2) 之上。
          - 文案：复用既有键 settings_engine_label，**不新拟文案**。"关了会怎样"那句解释
            （engine_banner_off）由全局横幅唯一承担——同一屏上说两遍是重复，不是强调。
          - 无障碍：可见文案挂 id，开关用 aria-labelledby 指过去（不用 aria-label 复述一遍，
            避免读屏念两次）。项目没有 label 组件，也不为这一处引一个。
          - 两个 prop 缺一个就整块不渲染：调用方要么两个都给，要么都不给。 */}
      {typeof engineEnabled === 'boolean' && onEngineChange !== undefined ? (
        <div
          className="absolute top-5 right-5 z-[3] flex items-center gap-2"
          data-testid="activity-hero-engine"
        >
          <span
            id="activity-hero-engine-label"
            className="text-[13px] leading-5 text-muted-foreground"
          >
            {t('settings_engine_label')}
          </span>
          <Switch
            aria-labelledby="activity-hero-engine-label"
            checked={engineEnabled}
            onCheckedChange={onEngineChange}
          />
        </div>
      ) : null}
```

- [ ] **Step 11: 全绿 + 类型检查 + 活动页整目录**

```bash
cd web && npx vitest run src/activity/ActivityHero.test.tsx
```

Expected: **60 passed**（53 既有 + 7 新增）。

```bash
cd web && npx tsc --noEmit
```

Expected: 无输出。

```bash
cd web && npx vitest run src/activity/
```

Expected: 全绿（确认新增 prop 没波及 ActivityPage 等消费方——它们还没传这两个 prop，
可选性就是为此）。

- [ ] **Step 12: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/activity/ActivityHero.tsx web/src/activity/ActivityHero.test.tsx
git commit -m "feat(web): 活动页 hero 右上角加发动机总开关"
```

---

**Task 18 备忘（`ActivityPage` 接线，本 task 刻意不做）：**

hero 只报告"用户拨了开关"，真正的读写在 `ActivityPage`：

```tsx
const setup = useSetupStatus()
// 失败开放：只有精确的 'false' 才算关。字段缺席/请求还没回来一律按"开"渲染——
// 拿不到状态时把开关画成"关"会诬告后端停了工。
const engineEnabled = setup.data ? setup.data.engineEnabled : true
…
<ActivityHero
  running={r}
  missingCount={m}
  now={now}
  engineEnabled={engineEnabled}
  onEngineChange={async (next) => {
    await api.updateSettings({ engine_enabled: next ? 'true' : 'false' })
    setup.reload()
  }}
/>
```

Task 18 名下要落的三件（本 task 不写，写在这里免得漏）：
1. 上面这段接线（`useSetupStatus()` 的第二个实例——本仓没有 react-query/swr，每个 hook 实例
   各自 15 秒轮询，与 EngineBanner 同频，是既有约定；Spec C §6-2 只禁止**更快**的轮询）；
2. 一条断言"拨开关真发出 `PUT settings` 且 body 是 `{ engine_enabled: 'false' }`"的用例
   （fetch 层的断言归页面级测试，hero 那边只测回调被调用）；
3. `ActivityPage.tsx:21` 那个 `VStack` 的替换。

**Task 30（收尾）备忘（本 task 现场发现，与 hero 无关但别丢）：**
`web/index.html:2` 是 `<html lang="zh">` 硬编码——i18n 切到 en 时 `lang` 属性仍是 `zh`，读屏
会用中文发音念英文。修法是在 `I18nProvider` 里同步 `document.documentElement.lang`。
**这不是加语言切换 UI**（那条禁令不变），只是让既有的语言状态诚实地反映到 DOM 上。

---

### Task 14: ActivityQueue —— Astryx 卸载

Activity 六件的第三件，也是**最省事的一件**：纯栈迁移，零新功能、零行为变化。既有 **20** 条测试
就是回归网，另加 3 条迁移锁（理由见 Step 6）。

Astryx 面按 Task 12 那张表：`ActivityQueue.tsx:31-32` 的 `Text` / `HStack` 两个，没有别的。

**Files:**
- Modify: `web/src/styles.css`（队列/完成共用的行几何段 `:1588-1657`：**四处** token 改名。`.act-row-dot` 一族 `:1658-1675` 归 **Task 15**，本 task 不碰）
- Modify: `web/src/activity/ActivityQueue.tsx`（删 `:31-32` 两行 import；`QueueRow` `:60-83` 与 `ActivityQueue` `:93-126` 里共 7 处标记替换）
- Test: `web/src/activity/ActivityQueue.test.tsx`（既有 **20** 条一条不改；末尾追加 1 个 `describe`，3 条 → **23**）

一个 commit 就够（没有新行为要 TDD）。

---

#### 背景一：这个文件里"谁给 display:flex"是**不统一**的，逐个容器核对过

Task 13 踩的那个坑（`.act-hero-body` 的 `display:flex` 只由 Astryx 给、CSS 里没有）在本文件里
**只对一半容器成立**。照抄 Task 13 的结论会多给两个 `flex` 类（无害但冗余），照抄反面则会漏掉
两个承重类（有害且测试抓不到）。逐条核实如下：

| 容器 | `styles.css` 里有没有 `display` | 组件层怎么写 |
|---|---|---|
| `.act-section`（`:1592`） | **有**：`display:flex; flex-direction:column; gap:2px` | `<section className="act-section">` **不加任何 flex 类** |
| `.act-section-head`（`:1600`） | **没有**（只有 `width:100%` + `padding`） | 必须给 `flex items-center justify-between` |
| `.act-row`（`:1612`） | **没有**（只有 `width` / `padding` / `border-radius`） | 必须给 `flex items-center gap-3`——**承重**，见下 |
| `.act-row-main`（`:1640`） | **有**：`display:flex; flex-direction:column; gap:1px` | **不加任何 flex 类** |

`.act-row` 那个 `flex` 是承重的，和 hero 同一个机理：`.act-row-poster` 有 `flex: none`
（`:1625`）、`.act-row-main` 有 `flex: 1`（`:1645`），两行都指望父级是 flex 容器。漏掉 `flex`
→ 38px 海报横向铺开、事实句掉行，而 **jsdom 不做布局，20 条用例全绿**。Step 6 的第 1 条锁就是
为这个漏洞设的（它也是本 task 唯一值得加锁的地方）。

#### 背景二：三处 `color="secondary"` 为什么替换成"不给颜色类"

`.act-auto-chip`（`:1610`）、`.act-row-fact`（`:1648`）、`.act-row-status, .act-row-time`
（`:1653`）三条 CSS 都已经在给 `color: var(--color-text-gray)`，而组件层同时又写了 Astryx 的
`color="secondary"`（→ `#9aa1ac`，比 gray 亮一档）。两个来源，谁赢？

**CSS 那三条赢，靠的是 cascade layer 而不是特异性。** 取证：

- `scout.css:79` 是 `@layer astryx-theme {`，`.astryx-text.secondary { color: var(--color-text-secondary) }`
  在其内（`:275`）；
- `styles.css` 全文**没有 `@layer`**（文件开头三行 `@import` 之后就是裸规则，`:11` 的
  `.cmdk-trigger` 起）；
- CSS 级联规则：**未分层的常规声明优先于任何分层的常规声明**，与特异性无关。
  （纯比特异性的话 `.astryx-text.secondary` 是 0-2-0，赢 `.act-row-fact` 的 0-1-0——所以
  "靠特异性赢"这个说法是错的，别在注释里那么写。）

⇒ 这三处的现状 ink **一直是 `--color-text-gray`**，`color="secondary"` 从来没生效过。所以迁移
时把它替换成"不给颜色类"是**逐像素等价**，不是取舍。

同一条 layer 规则还有个反向推论，值得记牢（Tasks 15-30 都吃这一条）：**在套了这些类的元素上加
`text-muted-foreground` 之类的颜色工具类是无效的**——Tailwind 的 utilities 也在
`@layer utilities` 里（Plan A 的 `tw.css` 用 `@import "tailwindcss/utilities.css" layer(utilities);`
引入），照样输给未分层的 `styles.css`。想改这一档 ink 只能改 CSS 那一条。

反过来，**段标题那处可以给颜色类**：`.act-section-head` 里没有任何 `color` 声明（核对过
`:1600-1604` 只有 `width` + `padding`），原来的 `color="secondary"` 是真在生效的
`#9aa1ac`，所以它要换成 `text-muted-foreground`（= `#9aa1ac`，Plan A `tw.css` 的 `@theme`）。
**这一处给、那三处不给**，区别就在 CSS 里有没有人已经管了颜色。

#### 背景三：`:1588-1657` 区间内 legacy token 的逐处清单

| 行 | 现值 | 处置 | 依据 |
|---|---|---|---|
| `:1598` | `var(--color-border)`（`.act-section` 的发丝线） | **不动** | 新旧同名同值 |
| `:1608` | `var(--color-border)`（chip 边框） | **不动** | 同上 |
| `:1610` | `var(--color-text-gray)` | → `var(--color-weak)` | 两侧都是 `#6b7280` |
| `:1618` | `rgba(255, 255, 255, 0.03)`（`.act-row:hover`） | **不动** | 裸 rgba，不是 token；且它**不会**弄红 hero 那条颜色白名单扫描——该扫描从值里挖"看起来像颜色"的原子（`/#[0-9a-f]{3,8}\|\bvar\(--[a-z-]+\)\|\b[a-z]{3,20}\b/gi`），`rgba(255,255,255,0.03)` 只挖出 `rgba` 这一个原子，而 `rgba` 在函数名跳过表里。数字不被任何一支匹配。已逐字核对 `ActivityHero.test.tsx:589-621` |
| `:1628` | `var(--color-border)`（海报框边） | **不动** | 同上 |
| `:1629` | `var(--color-background-surface)` | → `var(--color-secondary)`（评审修订：同上，柠檬绿铁律） |
| `:1648` | `var(--color-text-gray)`（`.act-row-fact`） | → `var(--color-weak)` | 同上 |
| `:1653` | `var(--color-text-gray)`（`.act-row-status, .act-row-time`） | → `var(--color-weak)` | 同上。⚠️ **跨段共用**，见下 |

**`.act-row-status, .act-row-time` 是队列段与完成段共用的一条**（`.act-row-time` 是
`ActivityDone` 的类，整套 `.act-row*` 行几何两段共用，见 `styles.css:1588-1591` 的段头注释）。
本 task 迁一次，**Task 15 不要再迁它**。

**Task 15 名下剩的（本 task 一律不碰，写在这里免得两边抢）：**
`.act-row-dot` 一族 `:1659-1675` 四处——`:1664` 与 `:1673` 的 `--color-text-gray` → `--color-weak`、
`:1667` 的 `--color-text-green` → `--color-fn-green`（两侧都是 `#28bf5c`）、`:1670` 的
`--color-text-red` → `--color-fn-red`（两侧都是 `#e11d48`）。**且 Task 15 必须同步改
`ActivityDone.test.tsx:250-252` 那三行断言**（它们 `toContain('--color-text-green')` /
`toContain('--color-text-red')` / `toMatch(/data-tone='neutral'\][^}]*--color-text-gray/)`，
不改就当场变红）。同理 Task 16 要同步 `ActivityStuck.test.tsx:99` 与 `:106` 的
`toBe('var(--color-text-red)')`。

**为什么四处改名不弄红既有 20 条：** `ActivityQueue.test.tsx` 里唯一读 CSS 的断言是
`cssDecl('.act-row-poster', 'aspect-ratio')`（`:135`）与 `cssDecl('.act-row-poster', 'width')`
（`:143`）——`2 / 3` 与 `38px`，两个都不是颜色。`ActivityDone.test.tsx:255-258` 那条"红只染点
不铺块"扫 `.act-row*` 规则块里有没有红底：`--color-accent`（`#16181f`）与 `--color-weak` 都不沾
红，且该断言是 `not.toMatch`，改名只会让它更绿。

---

- [ ] **Step 1: 跑基线**

```bash
cd web && npx vitest run src/activity/ActivityQueue.test.tsx
```

Expected: **20 passed**。有红先停下报告。

- [ ] **Step 2: `styles.css` 四处 token 改名**

第 1 处，把

```css
.act-auto-chip {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-gray);
}
```

改成

```css
.act-auto-chip {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  /* 未分层声明，赢过组件层任何 text-* 工具类（Tailwind utilities 在 @layer utilities 里）。
     所以组件层不给颜色类——给了也不生效。 */
  color: var(--color-weak);
}
```

第 2 处，把

```css
.act-row-poster {
  aspect-ratio: 2 / 3;
  width: 38px;
  flex: none;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-background-surface);
}
```

改成

```css
.act-row-poster {
  aspect-ratio: 2 / 3;
  width: 38px;
  /* flex:none 指望父级 .act-row 是 flex 容器，而那个 display:flex **不在 CSS 里**——
     它由 ActivityQueue.tsx 的 `.act-row flex` 类给。删了那个类这行就失效，
     且 jsdom 不做布局、测试照绿。 */
  flex: none;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  background: var(--color-secondary); /* 评审修订：accent 被 scout.css 遮蔽成柠檬绿，过渡期铁律走 secondary（同值 #16181f） */
}
```

第 3 处，把

```css
.act-row-fact {
  color: var(--color-text-gray);
}
```

改成

```css
.act-row-fact {
  color: var(--color-weak);
}
```

第 4 处，把

```css
.act-row-status,
.act-row-time {
  flex: none;
  color: var(--color-text-gray);
}
```

改成

```css
.act-row-status,
.act-row-time {
  flex: none;
  /* ⚠️ 这一条**队列段与完成段共用**（.act-row-time 是 ActivityDone 的类）。
     token 迁移在 Task 14 做一次，Task 15 不要再迁它。 */
  color: var(--color-weak);
}
```

- [ ] **Step 3: 跑测试，确认 token 改名没弄红任何断言**

```bash
cd web && npx vitest run src/activity/
```

Expected: 全绿。重点看 `ActivityDone.test.tsx` 那两条扫 `.act-row*` 的（`:245` 起与 `:255` 起）——
它们全绿说明本 task 的改名边界没侵入 Task 15 的地盘。

- [ ] **Step 4: 删掉 `ActivityQueue.tsx` 的两行 Astryx import**

删除 `:31-32`：

```tsx
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
```

不加替代 import。其余（`useT` / 两个 DTO 类型 / `PosterThumb` / `./text.js` 那五个函数）不动。

- [ ] **Step 5: 七处标记替换**

① `QueueRow` 的行容器（`:63` 与 `:81` 的闭合）。把

```tsx
    <HStack gap={3} vAlign="center" className="act-row" data-testid="activity-queue-row">
```

改成

```tsx
    // `flex` 是**承重**的：.act-row-poster 的 flex:none 与 .act-row-main 的 flex:1 写在
    // styles.css 里，但 display:flex 只由这里给（CSS 的 .act-row 只有 width/padding/圆角）。
    // gap-3 = 原 HStack gap={3}；items-center = 原 vAlign="center"。
    <div className="act-row flex items-center gap-3" data-testid="activity-queue-row">
```

并把 `:81` 的 `</HStack>` 改成 `</div>`。

② 行标题（`:72`）。把

```tsx
        <Text type="body">{title}</Text>
```

改成

```tsx
        {/* 原 Text type="body"（13px / 20px / 400）。**不给颜色**：body 的默认 ink 是
            primary，自 Theme 根继承而来（非 <body>——reset 与 styles.css 都不在 body 上设色），工具类里不需要复述。 */}
        <span className="text-[13px] leading-5">{title}</span>
```

③ 事实句（`:73-75`）。把

```tsx
        {fact ? (
          <Text type="code" color="secondary" className="act-row-fact">{fact}</Text>
        ) : null}
```

改成

```tsx
        {fact ? (
          // 颜色不给类：.act-row-fact 已在 styles.css 里给 --color-weak，且它未分层，
          // 赢过任何 text-* 工具类（给了不生效，不是"多写一个"）。
          <span className="act-row-fact font-mono text-[13px] leading-5">{fact}</span>
        ) : null}
```

④ 状态词（`:78-80`）。把

```tsx
      <Text type="code" color="secondary" className="act-row-status" data-testid="activity-queue-status">
        {queuedLabel(lang)}
      </Text>
```

改成

```tsx
      <span
        className="act-row-status font-mono text-[13px] leading-5"
        data-testid="activity-queue-status"
      >
        {queuedLabel(lang)}
      </span>
```

⑤ 段头（`:95` 与 `:104` 的闭合）。把

```tsx
      <HStack vAlign="center" hAlign="between" className="act-section-head">
```

改成

```tsx
      {/* .act-section-head 在 CSS 里只有 width/padding，没有 display——这三个类是它的布局本体。
          （注意 .act-section 与 .act-row-main 相反：那两个的 display:flex 在 CSS 里，
          组件层一个 flex 类都不给。） */}
      <div className="act-section-head flex items-center justify-between">
```

并把 `:104` 的 `</HStack>` 改成 `</div>`。

⑥ 段标题（`:96`）。把

```tsx
        <Text type="body" color="secondary">{queueHeading(count, lang)}</Text>
```

改成

```tsx
        {/* 这一处**要**给颜色类：.act-section-head 里没人管颜色，原来的 color="secondary"
            是真在生效的 #9aa1ac = text-muted-foreground。与上面那三处的区别就在这儿。 */}
        <span className="text-[13px] leading-5 text-muted-foreground">{queueHeading(count, lang)}</span>
```

⑦ 自动检查标签（`:99-103`）。把

```tsx
        {autoCheck === true ? (
          <Text type="code" color="secondary" className="act-auto-chip" data-testid="activity-auto-chip">
            {lang === 'zh' ? '自动检查已开启' : 'auto-check on'}
          </Text>
        ) : null}
```

改成

```tsx
        {autoCheck === true ? (
          <span
            className="act-auto-chip font-mono text-[13px] leading-5"
            data-testid="activity-auto-chip"
          >
            {lang === 'zh' ? '自动检查已开启' : 'auto-check on'}
          </span>
        ) : null}
```

`<section className="act-section">`（`:94`）与 `<div className="act-row-main">`（`:71`）、
`<div className="act-row-poster">`（`:68`）**一个字不改**——前两个的 `display:flex` 在 CSS 里。

- [ ] **Step 6: 追加 3 条迁移锁**

在文件末尾追加。这三条不是"测功能"，是补 jsdom 抓不到的洞（本文件既有 20 条没有一条能发现
`flex` 类被删）：

```tsx
// ── 迁移锁（Astryx → Tailwind，Task 14）
//
// 为什么值得为"一个类名"加锁：本段的行布局从 Astryx HStack 换成了工具类，而
// .act-row-poster{flex:none} / .act-row-main{flex:1} 两行留在 CSS 里指望父级是 flex 容器。
// 删掉 .act-row 上的 `flex` 会让海报横向铺开、事实句掉行——**而 jsdom 不做布局，上面 20 条
// 全绿**。所以这里破例断言类名：在这个点上类名就是机制本身，没有 CSS 声明可断言。
describe('ActivityQueue：迁移锁', () => {
  it('.act-row 带 flex（承重：海报的 flex:none 与主栏的 flex:1 全靠它）', () => {
    const { container } = renderQueue({ series: [seriesRow()] })
    const row = container.querySelector('.act-row')
    expect(row).toBeTruthy()
    expect(row!.className.split(/\s+/)).toContain('flex')
    // 配对记录一个**不对称**：.act-row-main 的 display:flex 在 CSS 里，所以组件层不给
    // flex 类。这条断言在这里的作用是：将来谁把 CSS 那行删了想"挪到组件层"，会先看见它。
    expect(cssDecl('.act-row-main', 'display')).toBe('flex')
  })

  it('.act-section-head 带 flex + justify-between（CSS 里没有 display，布局全在类上）', () => {
    const { container } = renderQueue({ series: [seriesRow()], autoCheck: true })
    const head = container.querySelector('.act-section-head')
    expect(head).toBeTruthy()
    const classes = head!.className.split(/\s+/)
    expect(classes).toContain('flex')
    expect(classes).toContain('justify-between')
    expect(cssDecl('.act-section-head', 'display')).toBeNull()
  })

  it('DOM 里不再有任何 astryx-* 类名（迁移完成锁）', () => {
    const { container } = renderQueue({
      series: [seriesRow()],
      movies: [movieRow()],
      autoCheck: true,
    })
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 行/段/标签三层都渲染过了才算扫全（上面那份数据把三条分支都覆盖了）。
    expect(screen.getAllByTestId('activity-queue-row')).toHaveLength(2)
    expect(screen.getByTestId('activity-auto-chip')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: 全绿 + 类型检查 + 残留 grep**

```bash
cd web && npx vitest run src/activity/ActivityQueue.test.tsx
```

Expected: **23 passed**（20 既有 + 3 新增）。

```bash
cd web && npx tsc --noEmit
```

Expected: 无输出。

```bash
cd web && grep -n "astryxdesign" src/activity/ActivityQueue.tsx || echo "clean"
```

Expected: `clean`。

```bash
cd web && npx vitest run src/activity/
```

Expected: 全绿。

- [ ] **Step 8: Commit**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/activity/ActivityQueue.tsx web/src/activity/ActivityQueue.test.tsx
git commit -m "refactor(web): 队列段卸 Astryx 换 Tailwind 标记 + 行几何 token 迁移"
```

---

### Task 15: ActivityDone —— Astryx 卸载 + 语义点 token 迁移

Activity 六件的第四件。三件事：`.act-row-dot` 一族的 token 改名（**含四行测试断言同步**）、
卸 Astryx、把 Astryx `Button` 换成 shadcn `Button`（本 task 唯一一处真 API 变更）。

Astryx 面按 Task 12 那张表：`ActivityDone.tsx:36-38` 的 `Button` / `Text` / `HStack` 三个。
**整个 Activity 目录里唯一的 Astryx `Button` 就在这个文件**（`:91`）。

**Files:**
- Modify: `web/src/styles.css`（`.act-row-dot` 一族 `:1659-1674`：四处改名。CSS 侧本 task **只碰这一族**）
- Modify: `web/src/activity/ActivityDone.tsx`（删 `:36-38` 三行 import；6 处标记替换）
- Modify: `web/src/activity/ActivityDone.test.tsx`（**必须**同步改 4 行断言：`:249` / `:250` / `:252` / `:264`；既有 **30** 条数量不变；末尾追加 1 个 `describe`，3 条 → **33**）

两个 commit：① CSS 改名 + 测试断言同步（一个原子的 token 迁移），② 组件卸 Astryx + 迁移锁。

---

#### 背景一：这是唯一一个"不改测试就会**静默失去保护**"的迁移 —— 先读这一段

`ActivityDone.test.tsx` 有四行断言按**名字**引用 legacy token。其中三行改名后会**自己变红**（它们是
正向断言），第四行不会——它会**变绿而且永远绿**：

| 测试行 | 现断言 | 改名后 | 处置 |
|---|---|---|---|
| `:249` | `expect(block).toContain('--color-text-green')` | **变红**（自己会喊） | 改成 `'--color-fn-green'` |
| `:250` | `expect(block).toContain('--color-text-red')` | **变红** | 改成 `'--color-fn-red'` |
| `:252` | `toMatch(/data-tone='neutral'\][^}]*--color-text-gray/)` | **变红** | 改成 `--color-weak` |
| `:264` | `expect(b).not.toMatch(/background[^;]*--color-text-red/)` | ⚠️ **变绿，且从此空转** | 放宽正则，见下 |

`:264` 那条是"**红只染点不铺块**"（铁律①）的真身——它扫所有 `.act-row*` 规则块、跳过 dot、断言
没有别的东西拿红色 token 当背景。改名之后全库再没有 `--color-text-red` 这个字符串，于是这条
`not.toMatch` 对**任何**输入都成立：它不会变红提醒你，它会安静地变成一条永真断言。将来谁给
`.act-row` 加一句 `background: var(--color-fn-red)`（正是这条锁要防的事），它照样绿。

这跟这个文件自己在 `:196-198` 记下的那个坑是同一型的镜像——那次是"红了但不是因为你想的原因"，
这次是"绿了但不是因为它安全"。**Step 4 有一次变异验证专门证明放宽后的正则不空转，别跳过。**

改法（把 legacy 名与新名一并覆盖，Task 31 卸掉 Astryx 后旧名自然消失，正则留着也无害）：

```tsx
      expect(b).not.toMatch(/background[^;]*--color-(?:fn-|text-)?red/)
```

`:248` 那条 `not.toMatch(/\b(gold|yellow|amber|orange)\b/i)` 与名字无关，不用动（新名里没有黄）。

#### 背景二：`.act-row-dot` 是个 `<span>`，CSS 里**没有 `display`** —— 圆点靠父级 flex 存在

已逐行核对 `styles.css:1659-1665`：只有 `width` / `height` / `border-radius` / `flex` /
`background`，**没有 `display`**。而它在 `ActivityDone.tsx:74-79` 是个裸 `<span>`。

inline 元素**忽略 `width` / `height`**。所以这个点能是一个 6px 的圆，靠的是它作为 **flex item 被
blockify**（CSS Display §2.7：flex 容器的 in-flow 子元素 `display` 被 blockify）。

⇒ 包着它的那个 `<HStack gap={2} vAlign="center">`（`:71`，**连 `className` 都没有**，看起来最像
"纯装饰、可以拍平"的一个）迁移时必须给足 `flex items-center gap-2`。掉了 `flex` 的后果：点
**整个消失**——而 L1 那 8 条 `data-tone` 断言**全绿**，它们只读 `dataset.tone`，属性还在。

hero 的 `.act-hero-pulse` 是同一个机理（`styles.css:1499-1506` 同样没有 `display`），Task 13 的
替换体里已给足并写了注释。两处别在任何一处"简化"掉那个 flex。Step 6 的第 1 条锁就是为这个洞设的。

#### 背景三：Astryx `Button` → shadcn `Button` 的接口差异

这是本 task 唯一一处**真 API 变更**（其余都是 `Text`/`HStack` → 标签+类）：

| | Astryx | shadcn（**Plan A Task 14** 落地的 `web/src/components/ui/button.tsx`——不是 Plan C Task 7，那七件里没有 button） |
|---|---|---|
| 文案 | **`label` prop** | **children** |
| 变体 | `variant="ghost"` | `variant="ghost"`（cva variants 里同名同义） |
| 尺寸 | `size="sm"` | `size="sm"`（同名同义） |
| 点击 | `onClick` | `onClick`（原生透传） |

⇒ 写成 `<Button size="sm" variant="ghost" onClick={() => onOpen(row)}>{openLabel(lang)}</Button>`。

三条既有按钮断言为什么照绿：`:274` / `:290` 的 `getAllByRole('button', { name: '查看' })` 取的是
**可及名**，而 children 文本与原 `label` prop 渲染出的可及名是同一个东西（都是按钮的文本内容）；
`:284` 的 `querySelectorAll('button')` 只数数量。**这一处即使写错也是"自己会喊"的**：忘了把
`label` 搬进 children 就得到一个空按钮，`:274` 与 `:290` 当场变红。

#### 背景四：token 改名逐处（`:1659-1674`，四处，全部同值）

| 行 | 现值 | 改成 | 值核对 |
|---|---|---|---|
| `:1664` | `var(--color-text-gray)`（`.act-row-dot` 默认档） | `var(--color-weak)` | 两侧都是 `#6b7280` |
| `:1667` | `var(--color-text-green)`（`[data-tone='ok']`） | `var(--color-fn-green)` | 两侧都是 `#28bf5c` |
| `:1670` | `var(--color-text-red)`（`[data-tone='bad']`） | `var(--color-fn-red)` | 两侧都是 `#e11d48` |
| `:1673` | `var(--color-text-gray)`（`[data-tone='neutral']`） | `var(--color-weak)` | 同 `:1664` |

**Task 14 已经迁完、本 task 不要再碰的：** `.act-row`（`:1612`）/ `.act-row-poster`（`:1622`）/
`.act-row-main`（`:1640`）/ `.act-row-fact`（`:1647`）/ `.act-row-status, .act-row-time`（`:1650`）
五条。⚠️ 尤其 `.act-row-time` 是**本组件**的类（`ActivityDone.tsx:86`），但它与 `.act-row-status`
共用一条规则，Task 14 一次迁掉了——**不要因为"这是 Done 的类"就再迁一遍**（那会把 `--color-weak`
改成一个不存在的名字，或者制造一次无意义的 diff）。

往这四条规则**体内**加注释是安全的（`:245` 先剥注释再跑 `:246` 的正则），但没必要——段头
`:1656-1658` 已经有一段完整论证，说明写在那里更集中。

**Task 16 名下剩的（写在这里免得两边抢）：** `.act-hero-pulse[data-tone='bad']`（`:1717-1719`）与
`.act-stuck-fact`（`:1723-1725`）两处 `--color-text-red` → `--color-fn-red`，以及 `.act-empty-stamp`
（`:1695`，归 **Task 17**）的 `--color-text-gray` → `--color-weak`。Task 16 **必须**同步
`ActivityStuck.test.tsx:99` 与 `:105` 那两条 `cssDecl(...)).toBe('var(--color-text-red)')`（正向断言，
会自己变红），并放宽 `:178` 的 `expect(block).not.toMatch(/color-text-red/)`——那一条是 `:264` 的同型
静默坑（好在紧邻的 `:180` 有一条 `not.toMatch(/\bred\b/i)`，`--color-fn-red` 里的 `red` 前后都是
非词字符，所以那条仍然抓得住，锁不会完全失守；但 `:178` 本身该跟着改）。

---

- [ ] **Step 1: 跑基线**

```bash
cd web && npx vitest run src/activity/ActivityDone.test.tsx
```

Expected: **30 passed**（含 `it.each` 展开的 6 条）。有红先停下报告。

- [ ] **Step 2: `styles.css` 四处 token 改名**

把 `:1659-1674` 这一整段

```css
.act-row-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--color-text-gray);
}
.act-row-dot[data-tone='ok'] {
  background: var(--color-text-green);
}
.act-row-dot[data-tone='bad'] {
  background: var(--color-text-red);
}
.act-row-dot[data-tone='neutral'] {
  background: var(--color-text-gray);
}
```

改成

```css
.act-row-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--color-weak);
}
.act-row-dot[data-tone='ok'] {
  background: var(--color-fn-green);
}
.act-row-dot[data-tone='bad'] {
  background: var(--color-fn-red);
}
.act-row-dot[data-tone='neutral'] {
  background: var(--color-weak);
}
```

（`width`/`height`/`border-radius`/`flex` 四行一个字不动——尤其**不要**顺手补一句 `display:block`
"让它更稳"：那会让背景二那条锁失去意义，也会改掉 hero 那个点的既有渲染路径。）

- [ ] **Step 3: 同步四行测试断言**

`web/src/activity/ActivityDone.test.tsx`，把 `:249-252` 三行

```tsx
    expect(block).toContain('--color-text-green')
    expect(block).toContain('--color-text-red')
    // neutral 必须是灰（spec §6 的三档），不是黄不是蓝。
    expect(block).toMatch(/data-tone='neutral'\][^}]*--color-text-gray/)
```

改成

```tsx
    expect(block).toContain('--color-fn-green')
    expect(block).toContain('--color-fn-red')
    // neutral 必须是灰（spec §6 的三档），不是黄不是蓝。
    expect(block).toMatch(/data-tone='neutral'\][^}]*--color-weak/)
```

再把 `:264` 那一行

```tsx
      expect(b).not.toMatch(/background[^;]*--color-text-red/)
```

改成

```tsx
      // ⚠️ 正则同时覆盖 legacy 名（--color-text-red）与新名（--color-fn-red）。只写一个的话，
      // token 改名会让这条 not.toMatch 变成永真断言——不变红，只是从此不再保护任何东西。
      expect(b).not.toMatch(/background[^;]*--color-(?:fn-|text-)?red/)
```

- [ ] **Step 4: 跑测试 + 变异验证那条放宽后的正则不空转**

```bash
cd web && npx vitest run src/activity/ActivityDone.test.tsx
```

Expected: **30 passed**。

现在证明 `:264` 真的还在干活。临时把 `.act-row-poster` 的背景染红（`styles.css:1629`，Task 14 刚把
它迁成 `var(--color-accent)`）：

先确认正则本身能区分三种输入（不碰任何文件）：

```bash
cd web && node -e 'const re=/background[^;]*--color-(?:fn-|text-)?red/;
console.log("legacy:", re.test("background: var(--color-text-red);"));
console.log("new   :", re.test("background: var(--color-fn-red);"));
console.log("safe  :", re.test("background: var(--color-accent);"));'
```

Expected: `legacy: true` / `new   : true` / `safe  : false`。

再证明它在**真的接线里**也抓得住——把 `.act-row-poster` 的背景临时染红。sed 的地址范围锁在那一条
规则内，所以不会碰到 `.act-row-dot[data-tone='bad']` 里同名的那行值：

```bash
cd web && sed -i '' '/^\.act-row-poster {/,/^}/s|var(--color-accent)|var(--color-fn-red)|' src/styles.css && grep -c "color-fn-red" src/styles.css && npx vitest run src/activity/ActivityDone.test.tsx 2>&1 | tail -20
```

Expected: 先打印 `2`（poster 一处 + dot[bad] 一处），然后 **1 failed**，失败的正是
`铁律①：红只染点不铺块（没有任何红底色的行/卡片规则）`。
若它照绿 → 正则写错了，停下来修（这一步的全部意义就在这里）。

改回来（同一个地址范围，反向替换）：

```bash
cd web && sed -i '' '/^\.act-row-poster {/,/^}/s|var(--color-fn-red)|var(--color-accent)|' src/styles.css && grep -n "color-fn-red" src/styles.css
```

Expected: 只剩**一行**，且它属于 `.act-row-dot[data-tone='bad']`。

```bash
cd web && npx vitest run src/activity/ActivityDone.test.tsx
```

Expected: 回到 **30 passed**。

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/activity/ActivityDone.test.tsx
git commit -m "refactor(web): 语义点 token 迁移 + 同步铁律一那条红底扫描的正则"
```

- [ ] **Step 6: 删三行 Astryx import + 6 处标记替换**

删除 `:36-38`：

```tsx
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
```

换成一行（shadcn Button，Plan C Task 7 落地的）：

```tsx
import { Button } from '../components/ui/button.js'
```

① 行容器（`:62`，闭合在 `:98`）。把

```tsx
    <HStack gap={3} vAlign="center" className="act-row" data-testid="activity-done-row">
```

改成

```tsx
    // flex 承重：.act-row-poster{flex:none} 与 .act-row-main{flex:1} 写在 CSS 里、指望父级是
    // flex 容器，而 .act-row 自己在 CSS 里没有 display（Task 14 已核实）。.act-row-main 的
    // flex:1 就是把时间与「查看」推到右侧的那股力。
    <div className="act-row flex items-center gap-3" data-testid="activity-done-row">
```

并把 `:98` 的 `</HStack>` 改成 `</div>`。

② 行标题（`:69`）。把

```tsx
        <Text type="body">{title}</Text>
```

改成

```tsx
        <span className="text-[13px] leading-5">{title}</span>
```

③ 点 + 短语的包装层（`:71`，闭合在 `:81`）。把

```tsx
          <HStack gap={2} vAlign="center">
```

改成

```tsx
          // ⚠️ 这个 flex 是**承重**的，不是装饰：.act-row-dot 在 CSS 里没有 display
          // （styles.css:1659 起只有 width/height/border-radius/flex/background），而它是个
          // <span>。inline 元素忽略 width/height——那个 6px 的圆全靠它作为 flex item 被
          // blockify。删掉 flex，点会整个消失，而 L1 那 8 条 data-tone 断言照绿。
          <div className="flex items-center gap-2">
```

并把 `:81` 的 `</HStack>` 改成 `</div>`。

④ 短语文本（`:80`）。把

```tsx
            <Text type="code" color="secondary" className="act-row-fact">{phrase.text}</Text>
```

改成

```tsx
            {/* 不给颜色类：.act-row-fact 已在 styles.css 里给 --color-weak，且 styles.css 全文
                未分层，赢过 @layer utilities 里的任何 text-* 工具类（给了不生效）。 */}
            <span className="act-row-fact font-mono text-[13px] leading-5">{phrase.text}</span>
```

⑤ 相对时间（`:86-88`）。把

```tsx
        <Text type="code" color="secondary" className="act-row-time" data-testid="activity-done-time">
          {relativeFinished(now - row.finishedAt, lang)}
        </Text>
```

改成

```tsx
        <span
          className="act-row-time font-mono text-[13px] leading-5"
          data-testid="activity-done-time"
        >
          {relativeFinished(now - row.finishedAt, lang)}
        </span>
```

（同样不给颜色类：`.act-row-status, .act-row-time` 那条共用规则已在 Task 14 迁成 `--color-weak`。）

⑥ 「查看」按钮（`:90-97`）。把

```tsx
      {onOpen ? (
        <Button
          size="sm"
          variant="ghost"
          label={openLabel(lang)}
          onClick={() => onOpen(row)}
        />
      ) : null}
```

改成

```tsx
      {onOpen ? (
        // shadcn Button 的文案走 children，**没有 label prop**（Astryx 有）。忘了搬会得到一个
        // 空按钮——好在那是"自己会喊"的：按可及名取按钮的两条用例当场变红。
        <Button size="sm" variant="ghost" onClick={() => onOpen(row)}>
          {openLabel(lang)}
        </Button>
      ) : null}
```

⑦ 段头（`:110`，闭合在 `:112`）。把

```tsx
      <HStack vAlign="center" className="act-section-head">
        <Text type="body" color="secondary">{doneHeading(recent.length, lang)}</Text>
      </HStack>
```

改成

```tsx
      {/* .act-section-head 在 CSS 里只有 width/padding，没有 display。注意这里**没有**
          justify-between（原文也没有 hAlign）——本段头只有一个子元素，队列段那个才是两端对齐。 */}
      <div className="act-section-head flex items-center">
        {/* 这一处**要**给颜色类：.act-section-head 里没人管颜色，原 color="secondary" 是真在
            生效的 #9aa1ac = text-muted-foreground。 */}
        <span className="text-[13px] leading-5 text-muted-foreground">{doneHeading(recent.length, lang)}</span>
      </div>
```

`<section className="act-section">`（`:109`）、`<div className="act-row-main">`（`:68`）、
`<div className="act-row-poster">`（`:65`）**一个字不改**——前两个的 `display:flex` 在 CSS 里。

- [ ] **Step 7: 跑测试 + 类型检查 + 残留 grep**

```bash
cd web && npx vitest run src/activity/ActivityDone.test.tsx
```

Expected: **30 passed**。特别确认 `:180` 那条 `expect(section.children).toHaveLength(1 + 3)` 仍绿——
段头由 `HStack` 换成 `div` 不改变直系子元素个数（若它红了，说明你多包了一层）。

```bash
cd web && npx tsc --noEmit
```

Expected: 无输出。

```bash
cd web && grep -n "astryxdesign" src/activity/ActivityDone.tsx || echo "clean"
```

Expected: `clean`。

- [ ] **Step 8: 追加 3 条迁移锁**

在 `ActivityDone.test.tsx` 末尾追加。这三条补的是 jsdom 抓不到的洞（既有 30 条没有一条能发现
flex 类被删、或按钮退化成非原生元素）：

```tsx
// ── 迁移锁（Astryx → Tailwind，Task 15）
//
// 破例断言类名的理由：本段的行布局与那个 6px 圆点从 Astryx HStack 换成了工具类，而
// .act-row-dot / .act-row-poster / .act-row-main 三条 CSS 都指望父级是 flex 容器。
// 在这个点上**类名就是机制本身**，没有别的 CSS 声明可以断言。
describe('ActivityDone：迁移锁', () => {
  it('语义点的父级带 flex——点是 inline span，靠 blockify 才有 6px 圆形', () => {
    renderDone()
    const parent = screen.getByTestId('activity-done-dot').parentElement!
    const classes = parent.className.split(/\s+/)
    expect(classes).toContain('flex')
    expect(classes).toContain('items-center')
    // 上面那条为什么值得存在：.act-row-dot 在 CSS 里**没有 display**，而它是个 <span>。
    // inline 元素忽略 width/height，所以那个圆全靠 flex item 的 blockify。父级掉了 flex，
    // 点直接消失，而 L1 那 8 条 data-tone 断言照绿（它们只读 dataset.tone）。
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const dotBlock = /\.act-row-dot\s*\{([^}]*)\}/.exec(noComments)?.[1] ?? ''
    expect(dotBlock).toContain('border-radius')   // 确认扫到了正确的块，不是空扫
    expect(dotBlock).not.toMatch(/\bdisplay\b/)
  })

  it('行容器带 flex（.act-row-main 的 flex:1 把时间与「查看」推到右侧全靠它）', () => {
    renderDone({ onOpen: () => {} })
    expect(screen.getByTestId('activity-done-row').className.split(/\s+/)).toContain('flex')
    // 配对记录一个**不对称**：.act-row-main 的 display:flex 在 CSS 里，所以组件层不给它
    // flex 类。将来谁想把 CSS 那行"挪到组件层"，会先看见这条。
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(noComments).toMatch(/\.act-row-main\s*\{[^}]*display:\s*flex/)
  })

  it('DOM 里不再有 astryx-* 类名，且「查看」仍是原生 <button>', () => {
    const { container } = renderDone({
      recent: [recentRow(), recentRow({ id: 902, decision: 'error' })],
      onOpen: () => {},
    })
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // shadcn Button 渲染原生 <button>，不是 div[role=button]——上面三条按钮用例与整套
    // 键盘可及性都依赖这一点。
    expect(container.querySelector('button')).toBeInstanceOf(HTMLButtonElement)
    // 行/点/时间/按钮四层都渲染过了才算扫全。
    expect(screen.getAllByTestId('activity-done-row')).toHaveLength(2)
    expect(screen.getAllByTestId('activity-done-dot')).toHaveLength(2)
  })
})
```

- [ ] **Step 9: 全绿**

```bash
cd web && npx vitest run src/activity/ActivityDone.test.tsx
```

Expected: **33 passed**（30 既有 + 3 新增）。

```bash
cd web && npx vitest run src/activity/ && npx tsc --noEmit
```

Expected: 全绿 + tsc 无输出。

- [ ] **Step 10: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/activity/ActivityDone.tsx web/src/activity/ActivityDone.test.tsx
git commit -m "refactor(web): 完成段卸 Astryx，查看按钮换 shadcn Button"
```

---

### Task 16: ActivityStuck —— Astryx 卸载 + 卡死态红色 token 迁移

Activity 六件的第五件。这一屏**几何整套复用 hero 的 `.act-hero*`**（它说的还是"当前这一件事"，
只是那件事停住了），所以它踩的坑与 Task 13 同型——而且必须**自己再踩一遍**，见背景一。

Astryx 面：`ActivityStuck.tsx:72-74` 的 `Text` / `VStack` / `HStack` 三个，8 处用法。
**本文件没有 `Button`**（L7：不提供任何展开入口，`:216` 的注释与 `:211-239` 那个 describe
的回归锁都在守这一条）。

**Files:**
- Modify: `web/src/styles.css`（`.act-hero-pulse[data-tone='bad']` `:1717-1720` 与 `.act-stuck-fact` `:1723-1725`：两处 `--color-text-red` → `--color-fn-red`。**只碰这两条**）
- Modify: `web/src/activity/ActivityStuck.tsx`（删 `:72-74`；8 处标记替换）
- Modify: `web/src/activity/ActivityStuck.test.tsx`（改 `:97` 标题 + `:99` / `:105` 两条正向断言 + 放宽 `:178`；既有 **30** 条数量不变；末尾追加 1 个 `describe`、3 条 → **33**）

两个 commit：① CSS 改名 + 测试断言同步，② 组件卸 Astryx + 迁移锁。

---

#### 背景一：Task 13 给 hero 补的 flex 类**不会传染到这个文件** —— 必须原样再给一遍

`.act-hero-body`（`styles.css:1466-1470`，全文只有 `position/z-index/height`）与
`.act-hero-main`（`:1491-1494`，只有 `min-width/flex`）在 CSS 里**都没有 `display`**——
Astryx 的 `HStack`/`VStack` 是它们 flex 的唯一来源（Task 13 背景二有完整取证）。

Task 13 迁 `ActivityHero.tsx` 时补了 `flex gap-4` / `flex flex-col gap-2`，但那是**组件层的
类名**，只作用于 hero 那个文件的 JSX。`ActivityStuck.tsx:151` / `:155` 用的是**同两个 CSS 类、
同两个 Astryx 组件**，各自独立。所以本 task 要原样再给一遍——漏了就是整屏塌成竖排（海报和文字
上下摞着），而 jsdom 不做布局、测试照绿。

⚠️ **不要**去 CSS 里给那两条补 `display: flex` "一次性解决两屏"。三个理由：
- Task 13 已把 hero 段 `:1427-1587` 的 box model 定为"一行不动"，那一段的 diff 边界是它的验收面；
- 补了之后 Task 13 与本 task 的组件层 flex 类都变成冗余，下一个读代码的人会删掉其中一处，
  而删哪一处都会在**另一屏**上出问题（类共用、组件不共用，看不出关联）；
- 真正该统一收拾几何的时机是 Task 31（Astryx 彻底卸掉之后），不是现在。

#### 背景二：四个承重 flex，其中一个决定红点存不存在

| 行 | 现状 | 换成 | 为什么承重 |
|---|---|---|---|
| `:151` | `<HStack gap={4} className="act-hero-body">` | `flex gap-4` | `.act-hero-body` 无 `display`（`:1466-1470`） |
| `:155` | `<VStack gap={2} className="act-hero-main">` | `flex flex-col gap-2` | `.act-hero-main` 无 `display`，且它自己的 `flex:1` 指望父级是 flex |
| `:156` | 裸 `<VStack gap={1}>`（无 className） | `flex flex-col gap-1` | 纯布局，Astryx 是唯一来源 |
| `:158` | 裸 `<HStack gap={2} vAlign="center">`（无 className） | `flex items-center gap-2` | ⚠️ **红点存亡**，见下 |
| `:195` | `<HStack className="act-hero-facts" vAlign="center" hAlign="between">` | `flex items-center justify-between` | `.act-hero-facts` 只有 `width/padding` 一族 |

`:158` 那个：`.act-hero-pulse`（`styles.css:1499-1506`）只有
`width/height/border-radius/flex/background/animation`，**没有 `display`**，而它在 `:162-167` 是个
裸 `<span>`。inline 元素**忽略 `width`/`height`**——那个 6px 红点能存在，全靠它作为 **flex item 被
blockify**（CSS Display §2.7）。掉了 `flex`：**红点整个消失**，而"问题看得见"这一屏最核心的视觉
信号就没了；同时 `:85-89` 那条 `dot.dataset.tone === 'bad'` **照绿**（它只读属性）。这与 Task 15
的 `.act-row-dot` 是同一个机理，Step 10 的第 2 条锁守它。

`<section className="act-stuck">`（`:217`）**不给** flex 类：`.act-stuck`（`:1709-1713`）在 CSS 里
自带 `display:flex; flex-direction:column; gap:10px`。

#### 背景三：三处 `Text` 的颜色类——三处都不给

| 行 | 现状 | 换成 | 颜色 |
|---|---|---|---|
| `:157` | `<Text type="large" weight="semibold">` | `<span className="text-base font-semibold">` | **不给**——primary 由 `<body>` 继承 |
| `:169` | `<Text type="body" className="act-stuck-fact" …>` | `<span className="act-stuck-fact text-[13px] leading-5" …>` | **不给**——见下 |
| `:201` | `<Text type="code" …>`（**本来就没有** `color` prop） | `<span className="font-mono text-[13px] leading-5" …>` | **不给**——见下 |

`:169` 原文**本来也没有** `color` prop（Astryx 默认 primary），而屏上它一直是**红**的——因为
`.act-stuck-fact` 那条 `color: var(--color-text-red)` 在未分层的 `styles.css` 里，赢过
`@layer astryx-theme` 里的 Astryx 默认色。迁移后同理赢过 `@layer utilities` 里的任何 `text-*`
工具类。所以红色只能留在 CSS 那一条上，组件层给了不生效（而且会骗人）。

`:201` 同理：`.act-hero-facts > *` 那条（Task 13 已迁成 `--color-weak`）未分层，赢任何工具类。
**那一条是 hero 与本屏共用的，Task 13 已经迁过——本 task 不要再迁它**。
`styles.css:1726-1728` 的注释说的就是这件事：那行"4 小时后重试"刻意不另写颜色。

#### 背景四：token 改名两处 + 测试四行（其中一行是静默坑）

CSS：

| 行 | 现值 | 改成 | 值核对 |
|---|---|---|---|
| `:1718` | `background: var(--color-text-red)`（`.act-hero-pulse[data-tone='bad']`） | `var(--color-fn-red)` | 两侧都是 `#e11d48` |
| `:1724` | `color: var(--color-text-red)`（`.act-stuck-fact`） | `var(--color-fn-red)` | 同上 |

`:1719` 的 `animation: none` 一个字不动——`:106` 断言着它。
`.act-hero-pulse` 基础规则（`:1499-1506`）的 `background: #8b7cf6` 也不动：裸 hex 在颜色扫描的
`ALLOWED` 名单里，Task 13 已经确认过。

测试：

| 行 | 现断言 | 改名后 | 处置 |
|---|---|---|---|
| `:97` | 用例**标题**里写着 `--color-text-red` | 不影响结果 | 一并改成新名（不改不会红，但标题从此说谎） |
| `:99` | `expect(cssDecl('.act-stuck-fact','color')).toBe('var(--color-text-red)')` | **变红**（自己会喊） | → `'var(--color-fn-red)'` |
| `:105` | `expect(cssDecl(".act-hero-pulse[data-tone='bad']",'background')).toBe('var(--color-text-red)')` | **变红** | → `'var(--color-fn-red)'` |
| `:178` | `expect(block).not.toMatch(/color-text-red/)` | ⚠️ **变绿且空转** | → `/color-(?:fn-\|text-)?red/` |

`:178` 是 Task 15 里 `ActivityDone.test.tsx:264` 那个静默坑的同型——改名后全库再没有
`color-text-red` 这个字符串，于是这条 `not.toMatch` 变成永真断言，不会变红提醒你。

**诚实交代它的真实分量**：紧邻的 `:180` 有一条 `expect(block).not.toMatch(/\bred\b/i)`，而
`--color-fn-red` 里 `red` 前后都是非词字符（`-` 与 `)`），`\bred\b` **抓得住**。所以这一族并没有
真的失守，`:178` 的广化是可读性 + 纵深防御，不是"救回一条已经失效的锁"。但它必须改：留着一条
永真的 `not.toMatch` 在那儿，下一个人会以为那条正则在管事，而它不管。
Step 5 的变异验证专门确认**是 `:178` 先响**（而不是掉到 `:180` 才响），以此证明它没空转。

**⚠️ 在这一段写 CSS 注释时的一个真实陷阱：** 本测试文件的 `cssDecl`（`:30-37`）是
`new RegExp(选择器 + '\\s*\\{([^}]*)\\}').exec(CSS)`——它在**原始 CSS** 上找"选择器紧跟大括号"，
**剥注释是在匹配到块之后**才做的。所以注释里**不要**写出形如 `.act-stuck-fact {` 的东西（选择器
后面直接跟大括号），那会让 `cssDecl` 匹配到注释里的假块、`:99` 读到 `null` 而变红。
现状是安全的：`:1701` 写的是 `.act-stuck-fact 的 color`、`:1702` 写的是
`.act-hero-pulse[data-tone='bad']（就在下面一条）`，后面跟的都不是大括号。照这个写法就行。

#### 背景五：不能顺手破坏的四条既有锁

| 行 | 锁的东西 | 迁移时怎么踩到 |
|---|---|---|
| `:212-221` | 零 `button` / `[role=button]` / `a` / `details` / `summary`（L7） | 把 `HStack` 换成 `<button>` 之类 |
| `:235` 一带 | `container.innerHTML` 不含 `aria-label` / `aria-expanded` / `aria-controls` | 给新 `<div>` 顺手加 `aria-label`——**一个都不要加** |
| `:164` | `fill.getAttribute('style')` 严格等于 `'width: 66%;'` | 动进度条那两层（`:181-194`）。**一个字不改** |
| `:161-162` | 条与填充上都没有 `data-tone` | 同上 |

`:351` 一带还有 `cssDecl('.act-hero-poster','aspect-ratio')`——`.act-hero-poster`
（`:1473-1481`）本 task 不碰。

---

- [ ] **Step 1: 跑基线**

```bash
cd web && npx vitest run src/activity/ActivityStuck.test.tsx
```

Expected: **30 passed**。有红先停下报告。

- [ ] **Step 2: `styles.css` 两处改名**

把 `:1717-1720`

```css
.act-hero-pulse[data-tone='bad'] {
  background: var(--color-text-red);
  animation: none;
}
```

改成

```css
.act-hero-pulse[data-tone='bad'] {
  background: var(--color-fn-red);
  animation: none;
}
```

把 `:1723-1725`

```css
.act-stuck-fact {
  color: var(--color-text-red);
}
```

改成

```css
.act-stuck-fact {
  color: var(--color-fn-red);
}
```

按选择器核对这两条改到位了（**不要**用 `grep -rn "color-text-red" src/` 来核——见下面那段）：

```bash
cd web && grep -A3 "^\.act-hero-pulse\[data-tone='bad'\] {" src/styles.css && grep -A2 "^\.act-stuck-fact {" src/styles.css
```

Expected: 两个块里都是 `--color-fn-red`，都不再出现 `--color-text-red`；
`.act-hero-pulse[data-tone='bad']` 那个块里 `animation: none;` 仍在。

⚠️ **全库范围的 `grep -rn "color-text-red" src/` 此时仍有大量命中，那是正常的，不是漏改。**
逐处交代（**一处都不要顺手改**）：

| 命中 | 归属 |
|---|---|
| `styles.css:282` / `:303` / `:339` | 分诊/设置区段 → Tasks 22-27 |
| `styles.css:889` / `:996` / `:1112` / `:1155` / `:1156` / `:1162` | 库/分诊区段 → Tasks 19-24 |
| `styles.css:1247` / `:1248` / `:1249` / `:1289` | 同上 |
| `styles.css:1670`（`.act-row-dot[data-tone='bad']`） | **Task 15 已改**。若这里还是 legacy 名，说明 Task 15 没跑完，停下来报告 |
| `theme/scout.css:178` + `theme/scout.ts:36` + `theme/scout.js:111` | token **定义**在 Astryx 主题文件里，留到 Task 31 卸载时一并消失 |
| `ActivityDone.test.tsx:250` / `:264` | Task 15 已按新名改过（`:264` 是同时覆盖两名的正则，刻意留着 legacy 名） |

- [ ] **Step 3: 同步 `:97-107` 那两个用例**

`web/src/activity/ActivityStuck.test.tsx`，把

```tsx
  it('那行事实确实是红的（CSS 里 .act-stuck-fact 走 --color-text-red）', () => {
    // 这条裁决的真身在 CSS——只断言类名在场的话，把颜色改成灰会全绿。
    expect(cssDecl('.act-stuck-fact', 'color')).toBe('var(--color-text-red)')
    const { container } = renderStuck()
    expect(container.querySelector('.act-stuck-fact')).toBeTruthy()
  })

  it('红点在 CSS 里确实转红，且脉动停掉（活停着，让它继续呼吸是假话）', () => {
    expect(cssDecl(".act-hero-pulse[data-tone='bad']", 'background')).toBe('var(--color-text-red)')
    expect(cssDecl(".act-hero-pulse[data-tone='bad']", 'animation')).toBe('none')
  })
```

改成

```tsx
  it('那行事实确实是红的（CSS 里 .act-stuck-fact 走 --color-fn-red）', () => {
    // 这条裁决的真身在 CSS——只断言类名在场的话，把颜色改成灰会全绿。
    expect(cssDecl('.act-stuck-fact', 'color')).toBe('var(--color-fn-red)')
    const { container } = renderStuck()
    expect(container.querySelector('.act-stuck-fact')).toBeTruthy()
  })

  it('红点在 CSS 里确实转红，且脉动停掉（活停着，让它继续呼吸是假话）', () => {
    expect(cssDecl(".act-hero-pulse[data-tone='bad']", 'background')).toBe('var(--color-fn-red)')
    expect(cssDecl(".act-hero-pulse[data-tone='bad']", 'animation')).toBe('none')
  })
```

- [ ] **Step 4: 放宽 `:178`**

把

```tsx
      expect(block).not.toMatch(/color-text-red/)
```

改成

```tsx
      // ⚠️ 同时覆盖 legacy 名与新名。只写一个的话，token 改名会让这条 not.toMatch 变成
      // 永真断言——不变红，只是从此不再保护任何东西（下面那条 /\bred\b/i 才是真正兜住
      // 这一族的锁：`--color-fn-red` 里 red 前后都是非词字符，它抓得住）。
      expect(block).not.toMatch(/color-(?:fn-|text-)?red/)
```

- [ ] **Step 5: 跑测试 + 变异验证 `:178` 确实先响**

```bash
cd web && npx vitest run src/activity/ActivityStuck.test.tsx
```

Expected: **30 passed**。

现在把进度条填充临时染红，看那条 CSS 扫描是否响、以及**哪一行**先响。用 python 精确插入一行
（`sed` 在 BSD 上往替换串里塞换行不可靠）。把下面这段存成 `/tmp/mut.py` 再跑，**不要**用
heredoc（本文件里嵌套的 heredoc 定界符会提前终止外层）：

```python
import io
p = 'src/styles.css'
s = io.open(p, encoding='utf-8').read()
anchor = '\n.act-hero-bar-fill {\n'
assert s.count(anchor) == 1, s.count(anchor)
io.open(p, 'w', encoding='utf-8').write(
    s.replace(anchor, anchor + '  background: var(--color-fn-red);\n'))
print('mutated')
```

```bash
cd web && python3 /tmp/mut.py
```

Expected: 打 `mutated`。

（锚点带前导换行是必需的：`:1531` 的 `.act-hero-bar[data-mode='indeterminate'] .act-hero-bar-fill {`
也以 `.act-hero-bar-fill {` + 换行结尾，不带前导换行会匹配到两处。那个 `assert` 会替你拦住。）

```bash
cd web && npx vitest run src/activity/ActivityStuck.test.tsx 2>&1 | tail -25
```

Expected: **1 failed**，失败用例是
`CSS 里没有任何把进度条填充染红的规则（这条裁决的真身在 CSS）`，且报错里引的模式是
**`/color-(?:fn-|text-)?red/`**（循环体里它排第一，先响）。

- 若引的是 `/\bred\b/i` → 说明 Step 4 那行没生效（改错文件/改错行），回去看。
- 若整个测试照绿 → 说明扫描根本没扫到 bar-fill 这个块，停下来报告，不要继续。

改回来。把下面这段存成 `/tmp/unmut.py`：

```python
import io
p = 'src/styles.css'
s = io.open(p, encoding='utf-8').read()
inj = '\n.act-hero-bar-fill {\n  background: var(--color-fn-red);\n'
assert s.count(inj) == 1, s.count(inj)
io.open(p, 'w', encoding='utf-8').write(
    s.replace(inj, '\n.act-hero-bar-fill {\n'))
print('reverted')
```

```bash
cd web && python3 /tmp/unmut.py
git -C /Users/dirtyfancy/projects/subtitle-scout diff --numstat web/src/styles.css
cd web && npx vitest run src/activity/ActivityStuck.test.tsx
```

Expected: 打 `reverted`；`--numstat` 显示 `2	2	web/src/styles.css`（只剩 Step 2 的两处改名）；
测试回到 **30 passed**。

- [ ] **Step 6: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/activity/ActivityStuck.test.tsx
git commit -m "refactor(web): 卡死态红色 token 迁移 + 广化进度条红底扫描的正则"
```

- [ ] **Step 7: 删三行 Astryx import**

删除 `web/src/activity/ActivityStuck.tsx:72-74`：

```tsx
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
```

**不加**任何替代 import（本文件没有 `Button`，L7；标记全走原生标签 + Tailwind 类）。

- [ ] **Step 8: 8 处标记替换**

① `:151`（闭合标签在 `:207`）。把

```tsx
      <HStack gap={4} className="act-hero-body">
```

改成

```tsx
      {/* .act-hero-body 在 CSS 里只有 position/z-index/height，**没有 display**
          （styles.css:1466-1470）——Astryx 的 HStack 曾是它 flex 的唯一来源。Task 13 给
          ActivityHero.tsx 补的类**不作用于本文件**（CSS 类共用、组件不共用），所以这里要
          原样再给一遍。 */}
      <div className="act-hero-body flex gap-4">
```

并把 `:207` 的 `</HStack>` 改成 `</div>`。

② `:155`（闭合在 `:206`）。把

```tsx
        <VStack gap={2} className="act-hero-main">
```

改成

```tsx
        {/* 同上：.act-hero-main（:1491-1494）只有 min-width/flex，没有 display。 */}
        <div className="act-hero-main flex flex-col gap-2">
```

并把 `:206` 的 `</VStack>` 改成 `</div>`。

③ `:156`（闭合在 `:173`）。把 `<VStack gap={1}>` 改成 `<div className="flex flex-col gap-1">`，
并把 `:173` 的 `</VStack>` 改成 `</div>`。

④ `:157`。把

```tsx
            <Text type="large" weight="semibold">{title}</Text>
```

改成

```tsx
            <span className="text-base font-semibold">{title}</span>
```

（`type="large"` = 16px/600，`text-base font-semibold` 逐值等价。不给颜色类：primary 靠继承。）

⑤ `:158`（闭合在 `:172`）。把 `<HStack gap={2} vAlign="center">` 改成

```tsx
            {/* ⚠️ 这个 flex 是**红点存亡**所系，不是装饰：.act-hero-pulse 在 CSS 里没有 display
                （styles.css:1499-1506 只有 width/height/border-radius/flex/background/animation），
                而它在下面是个裸 <span>。inline 元素忽略 width/height——那个 6px 红点全靠它作为
                flex item 被 blockify。删掉这个 flex，"问题看得见"这一屏最核心的视觉信号直接
                消失，而那条 dataset.tone === 'bad' 的断言照绿（jsdom 不做布局）。 */}
            <div className="flex items-center gap-2">
```

并把 `:172` 的 `</HStack>` 改成 `</div>`。
`:162-167` 那个 `<span className="act-hero-pulse" …>` **一个字不改**。

⑥ `:169-171`。把

```tsx
              <Text type="body" className="act-stuck-fact" data-testid="activity-stuck-fact">
                {phrase.text}
              </Text>
```

改成

```tsx
              {/* 不给颜色类：红由 .act-stuck-fact 那条 CSS 给，而 styles.css 全文未分层，赢过
                  @layer utilities 里的任何 text-* 工具类（给了不生效，只会骗人）。原文也
                  本来没有 color prop——它一直是靠那条 CSS 变红的。 */}
              <span
                className="act-stuck-fact text-[13px] leading-5"
                data-testid="activity-stuck-fact"
              >
                {phrase.text}
              </span>
```

⑦ `:195`（闭合在 `:205`）。把

```tsx
          <HStack className="act-hero-facts" vAlign="center" hAlign="between">
```

改成

```tsx
          <div className="act-hero-facts flex items-center justify-between">
```

并把 `:205` 的 `</HStack>` 改成 `</div>`。

⑧ `:201-203`。把

```tsx
              <Text type="code" data-testid="activity-stuck-retry">
                {formatRetryIn(item.held.nextRetryAt - now, lang)}
              </Text>
```

改成

```tsx
              {/* 不给颜色类：.act-hero-facts > * 那条（Task 13 已迁成 --color-weak）未分层，
                  赢任何工具类。那一条是 hero 与本屏**共用**的，别在这里再迁一次。 */}
              <span
                className="font-mono text-[13px] leading-5"
                data-testid="activity-stuck-retry"
              >
                {formatRetryIn(item.held.nextRetryAt - now, lang)}
              </span>
```

`<section className="act-stuck">`（`:217`）、`.act-hero-poster`（`:152-154`）、进度条那两层
（`:181-194`）、三层背景 div（`:134-150`）**一个字不改**。

- [ ] **Step 9: 跑测试 + 类型检查 + 残留 grep**

```bash
cd web && npx vitest run src/activity/ActivityStuck.test.tsx
```

Expected: **30 passed**。特别确认这三条仍绿（它们是最容易被这次改动碰坏的）：
- `没有任何按钮 / 可点控件 / 链接`（`:212` 一带）——`HStack`→`div` 不引入 button；若它红了说明
  你换错了标签；
- 那条扫"详情/展开/查看痕迹"措辞的（`:223` 一带）——它顺带断言 `innerHTML` 里没有
  `aria-label` / `aria-expanded` / `aria-controls`，所以**别给任何新 div 加 aria-label**；
- `进度条元素的类/内联样式里没有红`（`:161` 一带）——它断言 `fill.getAttribute('style')` 严格等于
  `'width: 66%;'`，所以进度条那两层一个字都不能动。

```bash
cd web && npx tsc --noEmit && grep -n "astryxdesign" src/activity/ActivityStuck.tsx || echo "clean"
```

Expected: tsc 无输出，grep 打 `clean`。

- [ ] **Step 10: 追加 3 条迁移锁**

在 `ActivityStuck.test.tsx` 末尾追加：

```tsx
// ── 迁移锁（Astryx → Tailwind，Task 16）
//
// 这一屏的几何整套复用 .act-hero*，而那几条 CSS 规则**故意没有 display**（Astryx 的
// HStack/VStack 曾是唯一来源）。迁移后类名就是机制本身，没有别的 CSS 声明可以断言——
// 所以这里破例断言类名，并且每条都配一个"CSS 侧确实缺 display"的取证断言。
describe('ActivityStuck：迁移锁', () => {
  it('hero 几何的两个容器都带 flex（CSS 里它们没有 display，这两个类就是布局本体）', () => {
    const { container } = renderStuck()
    const body = container.querySelector('.act-hero-body')!
    const main = container.querySelector('.act-hero-main')!
    expect(body.className.split(/\s+/)).toContain('flex')
    expect(main.className.split(/\s+/)).toContain('flex')
    expect(main.className.split(/\s+/)).toContain('flex-col')
    // 配对取证：CSS 侧确实没有 display——这才是上面三条断言承重的原因。
    // 若将来有人往 CSS 补了 display:flex，这两条会红，提醒把组件层的冗余类一并收拾
    // （注意：那两个类是 hero 与本屏**共用**的，改 CSS 会同时改另一屏）。
    expect(cssDecl('.act-hero-body', 'display')).toBeNull()
    expect(cssDecl('.act-hero-main', 'display')).toBeNull()
  })

  it('红点的父级带 flex——点是 inline span，靠 blockify 才有 6px 圆形', () => {
    renderStuck()
    const parent = screen.getByTestId('activity-stuck-dot').parentElement!
    const classes = parent.className.split(/\s+/)
    expect(classes).toContain('flex')
    expect(classes).toContain('items-center')
    // .act-hero-pulse 在 CSS 里没有 display，而 inline 元素忽略 width/height。父级掉了 flex，
    // 红点整个消失，而上面那条 dataset.tone === 'bad' 照绿。
    expect(cssDecl('.act-hero-pulse', 'display')).toBeNull()
    expect(cssDecl('.act-hero-pulse', 'width')).toBe('6px')
  })

  it('DOM 里不再有 astryx-* 类名，且 L7 没被顺手破坏', () => {
    const { container } = renderStuck([
      item(),
      item({ held: held({ jobId: 42 }), title: '风骚律师' }),
    ])
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 迁移不该引入任何可点控件（换标签时最容易顺手写成 <button>）。
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
    // 两屏都渲染过了才算扫全（单屏扫不到"只在第二条上写错"的情况）。
    expect(screen.getAllByTestId('activity-stuck-hero')).toHaveLength(2)
    expect(screen.getAllByTestId('activity-stuck-fact')).toHaveLength(2)
  })
})
```

- [ ] **Step 11: 全绿**

```bash
cd web && npx vitest run src/activity/ActivityStuck.test.tsx
```

Expected: **33 passed**（30 既有 + 3 新增）。

```bash
cd web && npx vitest run src/activity/ && npx tsc --noEmit
```

Expected: 全绿 + tsc 无输出。

- [ ] **Step 12: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/activity/ActivityStuck.tsx web/src/activity/ActivityStuck.test.tsx
git commit -m "refactor(web): 卡死态卸 Astryx 换 Tailwind 标记"
```

**给 Task 17（ActivityEmpty）的备忘：** `.act-empty-stamp`（`styles.css:1695-1697`）的
`color: var(--color-text-gray)` → `--color-weak` 归你，本 task 没碰。空态那一屏没有红色，
所以它没有本 task 这种 token 同步问题。

---

### Task 17: ActivityEmpty —— Astryx 卸载 + 时间戳弱色 token 迁移

Activity 六件的第六件（最后一件组件），也是**这一屏最常见的状态**（守护大部分时间无事可做，
CSS 段头 `:1677` 自己写着"不是边缘兜底"）。

Astryx 面：`ActivityEmpty.tsx:51-53` 的 `Text` / `VStack` / `HStack` 三个，**5 处**用法。
**本文件没有 `Button`**——空态没有需要用户做的决定（`:84` 的注释与 `:270-272` 的回归锁都在守
这一条；`:275-277` 那个「查看」按钮是 `ActivityDone` 的，Task 15 已经迁过，本 task 不碰）。

这一屏与前五件有一个**结构性的不同**，它决定了本 task 的形状：

- 前五件的颜色**全部**已经被 `styles.css` 里未分层的规则管住了，所以组件层一律"不给颜色类"；
- 这一屏有**一处相反**：`:88` 那行诚实状态行**没有 className**，CSS 侧没有任何人管它的颜色，
  于是 `color="secondary"` 一直是**真在生效**的 `#9aa1ac`。迁移时它**必须**拿到
  `text-muted-foreground`——漏了它，那行字会从 `#9aa1ac` 跳回 `<body>` 继承的 primary
  `#e6e8ec`，而 jsdom 不算 computed style，**所有 27 条既有测试照绿**。

这正是 Task 14 背景二末尾那条推论的正面用例（那里写的是"段标题那处可以给颜色类……
**这一处给、那三处不给**，区别就在 CSS 里有没有人已经管了颜色"）。本 task 两种情形**同时**
出现在一个文件里，所以下面背景一把两侧都列全。

**Files:**
- Modify: `web/src/styles.css`（`.act-empty-stamp` 那一条：`--color-text-gray` → `--color-weak`。**全文只碰这一处**）
- Modify: `web/src/activity/ActivityEmpty.tsx`（删 `:51-53`；5 处标记替换；顺手改 `:39` 注释里的 legacy token 名）
- Modify: `web/src/activity/ActivityEmpty.test.tsx`（引入 `__STYLES_CSS__` + `cssDecl` 底座；既有 **27** 条一条不动；追加 2 个 `describe`、4 条 → **31**）

两个 commit：① 先写锁再改 CSS（TDD：本文件此刻**一条 CSS 断言都没有**，见背景三），
② 组件卸 Astryx + 迁移锁。

---

#### 背景一：5 处标记逐处裁决——颜色类 **1 给 4 不给**

| 行 | 现状 | 换成 | 颜色类 |
|---|---|---|---|
| `:85` | `<section className="act-empty">` | **不动**（本来就是原生 `section`） | — |
| `:86`（闭合 `:104`） | `<VStack gap={1} className="act-empty-facts">` | `<div className="act-empty-facts flex flex-col gap-1">` | 不给（它不是文本节点） |
| `:88-90` | `<Text type="body" color="secondary" data-testid="activity-empty-idle">` | `<span className="text-[13px] leading-5 text-muted-foreground" data-testid="activity-empty-idle">` | ✅ **给** |
| `:91`（闭合 `:103`） | `<HStack gap={2} vAlign="center">`（裸，无 className） | `<div className="flex items-center gap-2">` | 不给 |
| `:95-97` | `<Text type="code" className="act-empty-stamp" data-testid="activity-empty-stamp">` | `<span className="act-empty-stamp font-mono text-[13px] leading-5" …>` | ❌ 不给 |
| `:99-101` | `<Text type="code" className="act-empty-stamp" data-testid="activity-empty-checked">` | `<span className="act-empty-stamp font-mono text-[13px] leading-5" …>` | ❌ 不给 |

（`:85` 的 `<section className="act-empty">` **一个字不改**：`.act-empty` 在 CSS 里自带
`display:flex; flex-direction:column`，不需要补类。`:108` 的 `<ActivityDone …>` 也一个字不改。）

**为什么 `:88` 给、`:95`/`:99` 不给**——同一条 CSS 级联规则的两面：

- 未分层的常规声明**优先于任何分层的常规声明**，与特异性无关。`styles.css` 全文没有 `@layer`
  （`web/src/styles.css` 只有三条 `@import`），而 Tailwind 的工具类在 `@layer utilities` 里
  （Plan A 的 `tw.css` 走 `@import "tailwindcss/utilities.css" layer(utilities);`）。
- `:95`/`:99` 套着 `.act-empty-stamp`，那条规则有 `color` → 未分层，**赢**任何 `text-*` 工具类。
  给了不生效，而且会骗人（下一个读代码的人会以为颜色在组件层）。
- `:88` **没有 className**，CSS 里没有任何选择器命中它（`.act-empty` 与 `.act-empty-facts`
  都不含 `color`，全库也没有裸元素选择器——已核对 `grep -n "^\(span\|\*\|div\|section\|p\)[[:space:]]*[,{]" src/styles.css` **零命中**）。
  它的颜色**只能**来自工具类。

值核对（换 token 不是换颜色）：`color="secondary"` = `var(--color-text-secondary)`
= `#9aa1ac`（`theme/scout.css:97`），新栈 `--color-muted-foreground` = `#9aa1ac`
（Plan A Task 13 的 `@theme` 块）。**两侧十六进制相同**。

字号核对：`type="body"` = `0.8125rem`（13px）/ `line-height:1.5385`（=20px）/ 400
→ `text-[13px] leading-5`；`type="code"` 同度量 + 等宽族 → `font-mono text-[13px] leading-5`。
Geist Mono 从来没被加载过（Plan C 背景已取证），所以 `font-mono` 这一换在屏上不可见。

#### 背景二：`.act-empty-facts` 只有 `padding` —— `:86` 的 flex 是承重的

```css
.act-empty {                    /* 自带 flex，section 不需要补类 */
  display: flex;
  flex-direction: column;
}
.act-empty-facts {              /* ⚠️ 全文只有这一条声明 */
  padding: 22px 4px 18px;
}
```

`.act-empty-facts` **没有 `display`**——Astryx 的 `VStack` 是它 flex 的唯一来源。`:86` 掉了
`flex flex-col`，两行事实会退成两个连排的 inline/block 混合体、`gap` 消失（`:88` 是 span、
`:91` 换成 div 之后是 block，屏上表现为"行距忽然不对、时间戳贴着上一行"）。而 jsdom 不做布局，
**27 条既有测试照绿**。

`:91` 那个裸 `HStack` 同理：它的 `flex items-center gap-2` 让时间戳与裸计数**并排**。掉了它，
两个 `<span>` 仍在同一行（span 是 inline），但 `gap-2` 消失 → 两句话之间没有间距，读作一句
（"最近检查 3 分钟前12 / 282 已检查"）。这一处不像 Task 16 的红点那样"元素直接消失"，但同样
是所有测试照绿的静默降级。

⚠️ **不要**去 CSS 里给 `.act-empty-facts` 补 `display: flex` "省掉组件层的类"。理由同 Task 16
背景一：段头 `:1676-1683` 那段论证界定了这一段 CSS 的职责（只管 padding 与 ink），补了之后组件层
的 flex 类变成冗余，下一个人会删掉其中一处；真正该统一收拾几何的时机是 Task 31。

#### 背景三：token 改名只有一处，但本测试文件**此刻一条 CSS 断言都没有**

CSS：

| 选择器 | 现值 | 改成 | 值核对 |
|---|---|---|---|
| `.act-empty-stamp` | `color: var(--color-text-gray)` | `var(--color-weak)` | 两侧都是 `#6b7280`（`theme/scout.css:175` / Plan A `tw.css` 的 `@theme`） |

这是 Task 15 背景二里点名"归 **Task 17**"的那一处，也是本 task 在 CSS 里碰的**唯一**一行。

**决定：给这个测试文件补上 `__STYLES_CSS__` + `cssDecl` 底座。** 不是可选项，理由是：

`ActivityEmpty.test.tsx` 与同目录的 `ActivityHero` / `ActivityDone` / `ActivityStuck` 三个测试
文件**不同**——它**没有** `declare const __STYLES_CSS__`，也**没有** `cssDecl` 辅助函数，全部
27 条断言都只看 DOM。于是：

- 改名这一步**没有任何测试会因此变红**（既是好事也是坏事：好在不用同步断言，坏在这一步是**无
  验证**的改动——把 `--color-weak` 打成 `--color-week` 会静默变成"无颜色声明"，那行字跳回
  primary，27 条照绿）。
- 更要紧的是背景一那条"`:88` 必须给颜色类"的裁决，它的**取证**只能来自 CSS 侧
  （`cssDecl('.act-empty-facts','color')` 为 `null` ⇒ CSS 不管这行的颜色 ⇒ 工具类是唯一来源）。
  没有 `cssDecl`，这条锁就只剩一句"断言类名在场"，而单纯断言类名在场是这份计划一直在避免的
  空锁形状。

所以 Step 2 把 `ActivityStuck.test.tsx:25-37` 那 13 行底座**逐字**搬过来（同一份实现在四个
Activity 测试文件里保持一致，不要顺手"优化"它）。走 `define` 而不是 `?raw` / `node:fs` 的
论证在 `ActivityHero.test.tsx` 里，`vitest.config.ts:21` 是 `define: { __STYLES_CSS__: JSON.stringify(STYLES_CSS) }`
——**全局** define，任何测试文件加一行 `declare` 就能用，不需要改配置。

⚠️ **写 CSS 注释时的陷阱（同 Task 16 背景四）：** `cssDecl` 在**原始 CSS** 上找"选择器紧跟大括号"
（`new RegExp(选择器 + '\\s*\\{([^}]*)\\}')`），剥注释是在匹配到块**之后**才做的。所以注释里
**不要**写出形如 `.act-empty-stamp {` 的东西。**本 task 在 CSS 里不加任何注释**——段头
`:1691-1693` 已经写清了"ink 最弱的一档"的理由，改的只是 token 名，没有新论证要落。现状安全：
那段注释写的是 `新鲜度时间戳 + "N / M 已检查"：mono 弱色小字`，后面跟的不是大括号。

#### 背景四：不能顺手破坏的五条既有锁

| 行 | 锁的东西 | 迁移时怎么踩到 |
|---|---|---|
| `:159` | `container.querySelector('.act-empty .act-hero-pulse')` 为 `null` | 依赖 `.act-empty` 留在 `:85` 那个 `section` 上。**别改那个类名** |
| `:161` | `container.querySelectorAll('.act-empty-facts svg')` 长度 0 | 依赖 `.act-empty-facts` 留在 `:86` 上；也别给空态加任何图标 |
| `:264-267` | `.act-empty-facts` 里没有 `[data-tone]`；其 `innerHTML` 不匹配 `/color\s*:\s*(red\|green\|#f8\|#3f\|#d2\|#e8)/i` | 给新 `<div>`/`<span>` 加 `data-tone` 或内联 `style={{color:…}}`。⚠️ 注意 `text-muted-foreground` 这个类名里**没有** `color:`，不会触发那条正则（已核对） |
| `:270-272` | `container.querySelectorAll('button')` 长度 0（`onOpen` 缺席） | 把 `HStack` 换成 `<button>` 之类 |
| `:275-277` | `onOpen` 在场时 `screen.getByText('查看')` 在场 | 那个按钮在 `ActivityDone` 里（Task 15 已迁）。**本 task 不碰 `:108`** |

另外 `:127` 那条 L6 锁扫的是 `textContent`（含 `not.toContain('齐')`）、`:250` 那条铁律③锁扫的也是
`textContent`（含 `not.toContain('pass')`）——两条都只看文本节点，类名不参与，所以
`text-muted-foreground` / `font-mono` 之类的类名不会误触。**但反过来**：任何往 DOM 里加文案的
改动都会撞上它们，而本 task 一个字的文案都不加。

---

- [ ] **Step 1: 跑基线**

```bash
cd web && npx vitest run src/activity/ActivityEmpty.test.tsx
```

Expected: **27 passed**。有红先停下报告。

- [ ] **Step 2: 给测试文件补 `cssDecl` 底座**

`web/src/activity/ActivityEmpty.test.tsx`，在 `:16` 那行 import 之后、`:18` 的 `const T0` 之前
插入。把

```tsx
import { ActivityEmpty } from './ActivityEmpty.js'

const T0 = 1_700_000_000_000
```

改成

```tsx
import { ActivityEmpty } from './ActivityEmpty.js'

// CSS 断言的取值方式同 ActivityHero / ActivityDone / ActivityStuck 三个测试文件（那里有完整
// 论证）：`?raw` 在 vitest 里恒返回空串（断言会全部变成永假），`node:fs` 会撞 tsconfig 的
// types 白名单——所以走 vitest.config.ts:21 的 `define` 在编译期把文件内容替换进来。
//
// 这一屏为什么需要读 CSS：它的两档 ink 分居两侧——时间戳那档在 CSS（.act-empty-stamp），
// 诚实状态行那档在组件层（text-muted-foreground，因为 CSS 里没人管那行的颜色）。哪一档在哪儿
// 是**级联分层**决定的，不是风格选择；只看 DOM 的话，把任意一档改错都是全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明。先剥注释（同上述三个文件的既有实现：声明前隔着
 *  一条注释会读不到，且注释里提到的颜色名不该被当成真声明）。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

const T0 = 1_700_000_000_000
```

- [ ] **Step 3: 先写锁（会红）**

在 `ActivityEmpty.test.tsx` **文件末尾**追加：

```tsx
// ── 时间戳的 ink 档位：这一档的真身在 CSS，不在组件里 ──────────────────────────
//
// .act-empty-stamp 那条 color 是这一屏 CSS 侧**唯一**的颜色声明（.act-empty 与
// .act-empty-facts 都不管颜色）。组件层给不了它：styles.css 全文未分层，赢过 @layer utilities
// 里的任何 text-* 工具类——所以这一档只能在这里锁。
describe('ActivityEmpty：时间戳的 ink 档位（真身在 CSS）', () => {
  it('.act-empty-stamp 走 --color-weak（ink 最弱的一档：它是给人核对的背景事实，不是主角）', () => {
    expect(cssDecl('.act-empty-stamp', 'color')).toBe('var(--color-weak)')
    // 配对取证：DOM 侧那两个元素确实套着这个类，否则上面锁的是一条没人用的规则。
    renderEmpty()
    for (const testId of ['activity-empty-stamp', 'activity-empty-checked']) {
      expect(screen.getByTestId(testId).className.split(/\s+/)).toContain('act-empty-stamp')
    }
  })
})
```

```bash
cd web && npx vitest run src/activity/ActivityEmpty.test.tsx 2>&1 | tail -20
```

Expected: **1 failed / 27 passed**，失败的是新增那条，报错形如
`expected 'var(--color-text-gray)' to be 'var(--color-weak)'`。

若报错是 `expected null to be 'var(--color-weak)'` → `cssDecl` 没读到那个块，说明 Step 2 的底座
搬错了（或 `__STYLES_CSS__` 没生效），停下来报告，**不要**去改 CSS 蒙过它。

- [ ] **Step 4: 改 CSS 那一行**

把 `web/src/styles.css` 里

```css
.act-empty-stamp {
  color: var(--color-text-gray);
}
```

改成

```css
.act-empty-stamp {
  color: var(--color-weak);
}
```

```bash
cd web && npx vitest run src/activity/ActivityEmpty.test.tsx
```

Expected: **28 passed**。

按选择器核对改到位了：

```bash
cd web && grep -A2 "^\.act-empty-stamp {" src/styles.css
```

Expected: 块里是 `color: var(--color-weak);`，不再有 `--color-text-gray`。

按**区段**核对没有漏（内容锚定，不写死行号——前面几个 task 都是原地改名不挪行，但别指望这一点）：

```bash
cd web && awk '/^\.act-empty \{/,/^\/\* ── 活动页的卡死态/' src/styles.css | grep -c -- "color-text-gray"
```

Expected: **`0`**。

⚠️ **全库范围的 `grep -rn "color-text-gray" src/` 此时仍有三十多处命中，那是正常的，不是漏改。**
逐类交代（**一处都不要顺手改**）：

| 命中位置 | 归属 |
|---|---|
| `styles.css` 里 `.act-empty` 段**之前**的绝大多数（库/分诊/设置各区段，约三十处） | Tasks 19-27 |
| `styles.css` hero 段（`.act-hero*` 一族） | **Task 13 已改**。若还是 legacy 名，说明 Task 13 没跑完，停下来报告 |
| `styles.css` 行段/段标题（`.act-section-head` / `.act-row-fact` / `.act-row-status, .act-row-time`） | **Task 14 已改**，同上 |
| `styles.css` `.act-row-dot` 一族（默认档 + `[data-tone='neutral']`） | **Task 15 已改**，同上 |
| `theme/scout.css:175` + `theme/scout.ts` + `theme/scout.js` | token **定义**在 Astryx 主题文件里，留到 Task 31 卸载时一并消失 |

（`ActivityDone.test.tsx` 里那条 `toMatch(/data-tone='neutral'\][^}]*--color-weak/)` 已经是新名了
——那是 Task 15 Step 里同步过的。若它还是 legacy 名，同样说明 Task 15 没跑完。）

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/activity/ActivityEmpty.test.tsx
git commit -m "refactor(web): 空态时间戳弱色 token 迁移 + 给空态测试补 CSS 断言底座"
```

- [ ] **Step 6: 删三行 Astryx import**

删除 `web/src/activity/ActivityEmpty.tsx:51-53`：

```tsx
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
```

**不加**任何替代 import（本文件没有 `Button`；标记全走原生标签 + Tailwind 类）。

- [ ] **Step 7: 5 处标记替换**

① `:86`（闭合标签在 `:104`）。把

```tsx
      <VStack gap={1} className="act-empty-facts">
```

改成

```tsx
      {/* .act-empty-facts 在 CSS 里**只有一条 padding**，没有 display——Astryx 的 VStack 曾是
          它 flex 的唯一来源。掉了这两个类：两行事实的 gap 消失、行距不对（时间戳贴着上一行），
          而 jsdom 不做布局，全部既有断言照绿。 */}
      <div className="act-empty-facts flex flex-col gap-1">
```

并把 `:104` 的 `</VStack>` 改成 `</div>`。

② `:88-90`。把

```tsx
        <Text type="body" color="secondary" data-testid="activity-empty-idle">
          {idleLine(lang)}
        </Text>
```

改成

```tsx
        {/* ⚠️ 这一处**要给颜色类**，和这一屏别处相反：这行字没有 className，CSS 里没有任何
            选择器命中它（.act-empty / .act-empty-facts 都不含 color，全库也没有裸元素选择器），
            所以 color="secondary" 一直是真在生效的 #9aa1ac。漏了 text-muted-foreground，
            它会跳回 <body> 继承的 primary #e6e8ec，而 jsdom 不算 computed style——全绿。
            值核对：--color-text-secondary #9aa1ac === --color-muted-foreground #9aa1ac。 */}
        <span
          className="text-[13px] leading-5 text-muted-foreground"
          data-testid="activity-empty-idle"
        >
          {idleLine(lang)}
        </span>
```

③ `:91`（闭合在 `:103`）。把

```tsx
        <HStack gap={2} vAlign="center">
```

改成

```tsx
        {/* 时间戳与裸计数并排。掉了 gap-2 两句话会贴成一句（"最近检查 3 分钟前12 / 282 已检查"）
            ——span 是 inline，所以不像别处那样元素消失，但同样全绿。 */}
        <div className="flex items-center gap-2">
```

并把 `:103` 的 `</HStack>` 改成 `</div>`。

④ `:95-97`。把

```tsx
          <Text type="code" className="act-empty-stamp" data-testid="activity-empty-stamp">
            {lastCheckedLine(meta.lastScanAt, now, lang)}
          </Text>
```

改成

```tsx
          {/* 不给颜色类：.act-empty-stamp 那条 color（Step 4 已迁成 --color-weak）在未分层的
              styles.css 里，赢过 @layer utilities 里的任何 text-* 工具类。给了不生效，只会骗人。
              与上面 idle 那行的区别就在这儿：CSS 里有没有人已经管了颜色。 */}
          <span
            className="act-empty-stamp font-mono text-[13px] leading-5"
            data-testid="activity-empty-stamp"
          >
            {lastCheckedLine(meta.lastScanAt, now, lang)}
          </span>
```

⑤ `:99-101`。把

```tsx
            <Text type="code" className="act-empty-stamp" data-testid="activity-empty-checked">
              {checkedCountLine(meta.verifiedItems, meta.verifiableItems, lang)}
            </Text>
```

改成

```tsx
            <span
              className="act-empty-stamp font-mono text-[13px] leading-5"
              data-testid="activity-empty-checked"
            >
              {checkedCountLine(meta.verifiedItems, meta.verifiableItems, lang)}
            </span>
```

`<section className="act-empty">`（`:85`）与 `<ActivityDone recent={recent} now={now} onOpen={onOpen} />`
（`:108`）**一个字不改**。前者 CSS 自带 `display:flex; flex-direction:column`；后者是 Task 15
的地盘（`:275-277` 那条「查看」锁靠它）。

- [ ] **Step 8: 顺手改 `:39` 注释里的 legacy token 名**

`ActivityEmpty.tsx:39` 现在写着

```
//    事实——所以全屏走灰（--color-text-gray / secondary），没有绿钩、没有红点，尤其没有黄。
```

两个名字迁移后都不在了。改成

```
//    事实——所以全屏走灰（--color-weak / text-muted-foreground），没有绿钩、没有红点，尤其没有黄。
```

（纯注释改动，不影响任何断言。留着 legacy 名会让下一个人 grep 到一处不存在的 token。）

- [ ] **Step 9: 跑测试 + 类型检查 + 残留 grep**

```bash
cd web && npx vitest run src/activity/ActivityEmpty.test.tsx
```

Expected: **28 passed**。特别确认这四条仍绿（最容易被这次改动碰坏的）：
- `没有横幅/绿勾/插画类装饰`（`:156` 一带）——它靠 `.act-empty` 与 `.act-empty-facts` 两个**类名
  仍在原位**；若它红了，说明你把类名挪到了别的元素上；
- `铁律①：空态没有红也没有绿的状态块`（`:261` 一带）——它扫 `.act-empty-facts` 的 `innerHTML`
  找 `color:`，所以**别给任何新元素加内联 `style={{ color: … }}`**；
- `空态没有按钮`（`:270` 一带）——`HStack`/`VStack` → `div`，不引入 `button`；
- `onOpen 在场时完成行才有「查看」`（`:275` 一带）——`:108` 一个字都不能动。

```bash
cd web && npx tsc --noEmit && grep -n "astryxdesign" src/activity/ActivityEmpty.tsx || echo "clean"
```

Expected: tsc 无输出，grep 打 `clean`。

- [ ] **Step 10: 追加 3 条迁移锁**

在 `ActivityEmpty.test.tsx` **文件末尾**追加：

```tsx
// ── 迁移锁（Astryx → Tailwind，Task 17）
//
// 这一屏的两档 ink 分居两侧，而"哪一档在哪儿"是级联分层决定的：未分层的 styles.css 赢过
// @layer utilities。所以下面每条类名断言都配一个"CSS 侧到底管不管这个属性"的取证断言——
// 只断言类名在场的锁，改错哪一侧都是全绿。
describe('ActivityEmpty：迁移锁', () => {
  it('两行事实区带 flex flex-col（CSS 里它只有 padding，这两个类就是布局本体）', () => {
    const { container } = renderEmpty()
    const facts = container.querySelector('.act-empty-facts')!
    const classes = facts.className.split(/\s+/)
    expect(classes).toContain('flex')
    expect(classes).toContain('flex-col')
    expect(classes).toContain('gap-1')
    // 配对取证：CSS 侧确实没有 display——这才是上面两条断言承重的原因。若将来有人往 CSS 补了
    // display:flex，这一条会红，提醒把组件层的冗余类一并收拾。
    expect(cssDecl('.act-empty-facts', 'display')).toBeNull()
    expect(cssDecl('.act-empty-facts', 'padding')).toBe('22px 4px 18px')
    // 时间戳与裸计数的并排容器同理（裸 div，没有 CSS 类可查——它的 flex 只能在这里锁）。
    const row = screen.getByTestId('activity-empty-stamp').parentElement!
    expect(row.className.split(/\s+/)).toContain('flex')
    expect(row.className.split(/\s+/)).toContain('items-center')
    expect(row.className.split(/\s+/)).toContain('gap-2')
  })

  it('诚实状态行的灰由工具类给（这一屏唯一一处颜色类真生效的地方），时间戳那两个不给', () => {
    renderEmpty()
    // 给：这行字没有 CSS 类，CSS 侧没人管它的颜色 ⇒ 工具类是唯一来源。漏了它，这行会从
    // #9aa1ac 跳回 <body> 继承的 primary #e6e8ec，而 jsdom 不算 computed style。
    expect(screen.getByTestId('activity-empty-idle').className.split(/\s+/))
      .toContain('text-muted-foreground')
    expect(cssDecl('.act-empty-facts', 'color')).toBeNull()
    expect(cssDecl('.act-empty', 'color')).toBeNull()
    // 不给：.act-empty-stamp 有 color 且未分层，赢任何工具类——加了不生效，只会骗人。
    // （上面那个 describe 已断言它确实是 var(--color-weak)。）
    for (const testId of ['activity-empty-stamp', 'activity-empty-checked']) {
      expect(screen.getByTestId(testId).className).not.toMatch(/\btext-(muted-foreground|weak|faint)\b/)
    }
  })

  it('DOM 里不再有 astryx-* 类名，且既有的"零按钮 / 零插画"契约没被顺手破坏', () => {
    const { container } = renderEmpty({ recent: [recentRow()] })
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 迁移不该引入任何可点控件（换标签时最容易顺手写成 <button>）。onOpen 缺席 ⇒ 完成行也不给。
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
    // 也不该顺手加图标（L6：空态一个装饰都不要）。
    expect(container.querySelectorAll('.act-empty-facts svg')).toHaveLength(0)
    // 两行事实仍在场——迁移不该让任何一行消失。
    expect(screen.getByTestId('activity-empty-idle')).toBeInTheDocument()
    expect(screen.getByTestId('activity-empty-stamp')).toBeInTheDocument()
  })
})
```

- [ ] **Step 11: 全绿**

```bash
cd web && npx vitest run src/activity/ActivityEmpty.test.tsx
```

Expected: **31 passed**（27 既有 + Step 3 的 1 + 本步的 3）。

```bash
cd web && npx vitest run src/activity/ && npx tsc --noEmit
```

Expected: 全绿 + tsc 无输出。**这一步是 Activity 六件组件的收口**——`src/activity/` 目录下此刻
应当一个 `@astryxdesign` import 都没有了，核对一下：

```bash
cd web && grep -rn "astryxdesign" src/activity/ || echo "activity/ clean"
```

Expected: **一处命中，且只有 `src/activity/ActivityPage.tsx:21` 的 `VStack`**（接线层，归
**Task 18**）——`grep` 有命中所以 `|| echo` 不会打印，看到那一行就是对的。若命中的是别的文件，
照实报告文件名，**不要**在本 task 里顺手迁。

（⚠️ 不要去找 `ActivityFeed.tsx`：那个文件**已经不存在**。它旧址是
`web/src/workflow/ActivityFeed.tsx`（255 行），连同它的测试一起在 `2bb6d10`
"refactor(web): 清理旧 Workflow 组件 + 传送带接上 SSE 直播"（2026-07-31）里删掉了。
`ActivityStuck.tsx:86` 的注释里还引着 `ActivityFeed.tsx:153`，那是一句**过期注释**——它引的手法
本身没错（靠 `jobId` 去 `recent[]` 里 join 出剧名与海报），只是出处已经没了。
另外 `styles.css:350`、`workflow/text.ts:3` `:57`、`i18n/en.ts:121` 也各有一处提到这个旧组件名。
这五处注释归 **Task 30** 的零碎收尾，本 task 与 Task 18 都不碰。）

- [ ] **Step 12: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/activity/ActivityEmpty.tsx web/src/activity/ActivityEmpty.test.tsx
git commit -m "refactor(web): 空态卸 Astryx 换 Tailwind 标记"
```

**给 Task 18（ActivityPage 接线 + 发动机开关）的备忘：** 六件组件的 Astryx 已经全卸完，
`src/activity/` 下只剩**接线层一处**：`ActivityPage.tsx:21` 的 `import { VStack }`，全文只用了
一次（Step 11 最后那条 grep 会替你点名，Expected 就是这一行）。另外本 task 引入的 `cssDecl` 底座
让 `src/activity/` 下四个测试文件都有了同一份实现——Task 18 若也要读 CSS，**照搬那 13 行，不要抽
公共模块**（抽出去会让每个文件的"为什么走 define"论证离开它的现场，而那段论证是这几条锁能不能被
读懂的前提）。

---

### Task 18: ActivityPage —— 发动机开关接线 + Activity 目录卸完 Astryx

Activity 的**接线层**，也是这一屏的收口。三件事（Task 13 的备忘 `:4573-4600` 已经把范围钉死，
这里不扩）：

1. `useSetupStatus()` 接进来，把发动机开关的状态与回调透给 hero；
2. 一条**页面级**的写路径锁：拨开关真发出 `PUT /api/v2/settings`，body 是 `{ engine_enabled: 'false' }`
   （hero 那边只测「回调被调用」，fetch 层的断言归这里）；
3. 删掉 `ActivityPage.tsx:21` 那个 `VStack`——**`src/activity/` 最后一处 Astryx**。

**前置：本 task 依赖 Plan A 已经落地。** `useSetupStatus` / `SetupStatusDTO` / `SettingsKey` 的
`'engine_enabled'` / i18n 键 `settings_engine_label` 四样都是 Plan A 造的（此刻本仓一处都没有，
已核对）。实现顺序是 A → C → B，所以跑到这里时它们都在；Step 1 有一条前置核对，缺了就立刻停，
免得把「Plan A 没落地」误读成「Task 18 写错了」。

**Files:**
- Modify: `web/src/activity/ActivityPage.tsx`（加两个 import；加 `useSetupStatus()` + `engineEnabled` + `onEngineChange`；hero 传两个 prop；删 `:21` 与 `:137`/`:153` 的 `VStack`）
- Modify: `web/src/activity/ActivityPage.test.tsx`（扩 `stub()` 第三参 + `SETUP` fixture；既有 **9** 条一条不动；追加 1 个 `describe`、6 条 → **15**）

两个 commit：① 发动机接线 + 6 条锁，② 卸 `VStack`。分开是为了让 Astryx 卸载的 diff 单独成条——
Task 31 的卸载前置检查要按 commit 回溯「哪一处 import 是什么时候没的」。

---

#### 背景一：`stub()` 的 `{}` 兜底会把开关**静默地弄没**——这是本 task 的核心决定

`ActivityPage.test.tsx:48-59` 那个 `stub()` 对**任何**不认识的 URL 返回 `{}`：

```tsx
    const body = url.includes('/workflow/pending') ? pending
      : url.includes('/workflow/workers') ? workers
        : {}
```

`useSetupStatus()` 接上之后，`/api/v2/setup/status` 就落进这个兜底：`get<SetupStatusDTO>` 不做运行时
校验，于是 `setup.data === {}`（**真值**）→ `setup.data.engineEnabled === undefined` →
hero 那道守卫 `typeof engineEnabled === 'boolean' && onEngineChange !== undefined`（Plan C `:4485`）
不成立 → **开关整块不渲染**，而 9 条既有断言**全绿**。

这是这份计划一路在拆的静默失败家族里的第四种形状（前三种：静默变永真的负向断言、承重的 flex 类、
缺失的颜色工具类），而且是最阴的一种——**测试替身本身**把被测特性关掉了，没有任何一条断言会响。

**决定：扩 `stub()` 的第三参，默认给一份完整的 `SETUP`。** 备选是另开一个 `stubWithSetup()`
只给新用例用（改动面最小、零风险），不采用，两个理由：

- **生产保真**：真环境里 `useSetupStatus` 永远会拿到一份完整 DTO，开关**永远在场**。让 9 条既有
  用例也照这个样子渲染，它们扫的就是真实 DOM；留着 `{}` 等于让绝大多数用例跑在一个「开关不存在」
  的假世界里。
- **让开关落进既有的铁律③扫描**：`:163-173` 那条扫的是**整页** `textContent`。开关默认在场，
  它的可见文案就自动被那条锁管着；走 `stubWithSetup()` 的话，全站最新的这个控件恰好是唯一
  逃过铁律③的东西。

改动面（**9 条既有用例逐条走过一遍**，确认没有一条会因此变红）：

| 用例 | 走哪一屏 | hero 在场？ | 开关的影响 |
|---|---|---|---|
| `:70` held+running → 卡死态 | stuck | 否 | 无（`ActivityStuck` 不收 engine props） |
| `:78` 无 held 有在跑 → hero | running | **是** | 多一个 `<button role="switch">` + 文案「发动机」。断言是 `getByText('Silo')`，不冲突 |
| `:84` 两者皆空 → 空态 | empty | 否 | 无。`:89` 的 L6 锁扫 `/都齐了\|全部完成\|一切正常/`，「发动机」不匹配 |
| `:92` 两源皆未到位 → 空白 | — | 否（`:108` 提前 `return null`） | 无。`textContent === ''` 仍成立 |
| `:103` / `:113` / `:121` / `:132` held 四条 | stuck | 否 | 无 |
| `:142` / `:155` missing 汇总两条 | running / running | **是** | `:142` 断言 `/7 集缺字幕/`、`:155` 断言 `/集缺字幕/` **不**在场——「发动机」不匹配任何一边 |
| `:164` 铁律③ | running | **是** | 扫 `/agent\|orchestrator\|worker\|\bpass\b\|asset\|ledger/i`。zh 下开关文案是「发动机」，en 下是 `Engine`——**两个都不匹配**（`renderPage` 固定 `initialLang="zh"`）。Radix `Switch` 渲染的是 `<button role="switch">` + 一个空 `<span>` 拇指，自身**不带文本** |

jsdom 侧还有一处要提前交代清楚：Radix `Switch` 只在**外层有 `<form>`** 时才渲染那个需要
`useSize`/`ResizeObserver` 的隐藏 `BubbleInput`。hero 里没有 form，所以本 task **不需要**
`ResizeObserver` 垫片（`setupTests.ts` 里也没有），而且 DOM 里 `[role="switch"]` **恰好只有一个**
——第 4 条锁那个「全屏只有一个开关」才立得住。

#### 背景二：失败开放的写法，与两种会静默说谎的写歪

Task 13 备忘钉的是这一行：

```tsx
const engineEnabled = setup.data ? setup.data.engineEnabled : true
```

**只有 `data === null`（还没回来 / 拉取失败）才回落成「开」。** 两种看着等价的写法都会说谎，
而且都不会被 hero 那边的测试抓住（那边是直接喂 prop 的）：

| 写歪 | 后果 | 哪条锁抓它 |
|---|---|---|
| `setup.data?.engineEnabled ?? false` 或 `!!setup.data?.engineEnabled` | 拉取失败时画成**关**——诬告后端停了工，而它正在干活 | 第 3 条（`setup` 500 → 仍为开） |
| `setup.data?.engineEnabled \|\| true` | 引擎**真的关了**也画成开——「关」这个态从此在屏上不存在 | 第 2 条（`engineEnabled: false` → 关态照实渲染） |

第二种尤其像手滑：`|| true` 读起来就像「默认为开」。少了第 2 条锁，它会一直绿。

（`SetupStatusDTO.engineEnabled` 在类型上是必填 `boolean`，所以「拿到了 DTO 但缺这个字段」在
生产里不可能发生——`{}` 那种形状只会来自宽松的测试替身，正是背景一在收拾的事。）

#### 背景三：开关只挂**第一条** hero——修正 Task 13 备忘里的一处失手

`ActivityPage.tsx:115-122` 是 `running.map(...)`：**并发在跑时会有多条 hero**。Task 13 的备忘把
两个 prop 写在 map 里的 `<ActivityHero>` 上，等于**每条 hero 各挂一个开关**——同一个全局状态在
屏上出现两次，拨一个另一个跟着变，读起来像「每个任务各有自己的发动机」。那份备忘写的时候没想到
多条的情形，这里按实际改：

```tsx
      engineEnabled={i === 0 ? engineEnabled : undefined}
      onEngineChange={i === 0 ? onEngineChange : undefined}
```

hero 的两个 prop 本来就是 optional，守卫对 `undefined` 的处理就是「不渲染这一块」（Plan C `:4485`），
所以**组件侧一个字都不用改**。第 4 条锁守这条（两条在跑 → 全屏仍只有一个 `[role="switch"]`）。

#### 背景四：失败的可见后果是「开关纹丝不动」——所以 `catch` 里是空的，但不是吞

```tsx
  const onEngineChange = async (next: boolean) => {
    try {
      await api.updateSettings({ engine_enabled: next ? 'true' : 'false' })
    } catch {
      // 见下面注释
    }
    setup.reload()
  }
```

开关是**全受控件**：`checked={engineEnabled}`，真值只在 `setup.data.engineEnabled`——拇指在
拨动后**不会立刻动**，要等那次 `setup.reload()` 把服务端值拉回来才位移。PUT 失败时回读拿到的
还是旧值，开关**自始至终纹丝不动**——这一屏没有 toast 承接错误文案（L7：不给排查入口），而
「拨了没反应」本身就是诚实的失败信号。（叙事必须写对：说成「弹回原位」会邀请后来者用乐观
本地 state 去「修」它——那就给受控件开了第二个真值源。）

`catch` 不能省：`try/finally` 不带 `catch` 的话 rejection 照旧往外抛，变成控制台里一条
unhandled rejection——**那才是真的没人看见**。第 6 条锁专门守这个分支（否则这个 `catch` 就是一段
没有任何测试走过的代码）。

`onEngineChange` 直接给 async 函数、不套 `() => void f()`：hero 那侧 prop 类型是
`(next: boolean) => void`，而 TS 允许把返回 `Promise<void>` 的函数赋给返回 `void` 的签名；本仓
**没有 eslint**（只跑 `tsc --noEmit`，已核对无 root/web eslint 配置、无 lint script），所以没有
`no-misused-promises` 这类规则要绕。Plan A 的 `EngineBanner` 写成 `onClick={() => void turnOn()}`
是因为那处是 JSX 上的内联事件，形状不同，不必强行统一。

#### 背景五：`VStack gap={3}` → `<div className="flex flex-col gap-3">` 逐值等价

`ActivityPage.tsx:137` 那个 `VStack` 是**裸的**（只有 `gap={3}`，没有 `className`），所以 CSS 里
没有任何选择器命中它——`flex flex-col gap-3` 是它布局的**唯一**来源，掉了就是整页三块贴在一起。

三处等价核对（都已在 `web/node_modules/@astryxdesign` 里逐行看过；注意 Astryx 装在 **`web/`** 下，
不在仓库根的 `node_modules`）：

| 项 | Astryx 侧 | 新栈侧 |
|---|---|---|
| 元素 | `Stack.tsx:221` `as: element = 'div'` | `<div>` |
| 方向 | `VStack.tsx:69-86` 是 `Stack` 的薄壳，写死 `direction="vertical"` | `flex flex-col` |
| 间距 | `stack.stylex.ts:112-136` 的 `gapStyles` 把键 `3` 映到 `spacingVars['--spacing-3']`，而 `@astryxdesign/core/src/theme/tokens.stylex.ts:158` 是 `'--spacing-3': '12px'` | `gap-3` = `0.75rem` = **12px** |

`0.75rem === 12px` 的前提是根字号没被改过——`styles.css` 与 `theme/scout.css` 里**都没有**
`html` / `:root` / `body` 的 `font-size` 规则（`scout.css:16-68` 那些 `font-size` 是
`@layer reset` 里的 h1–h6/p，不是根），已核对。所以是**精确**等价，不是「差不多」。

#### 背景六：不能顺手破坏的四条既有锁

| 行 | 锁的东西 | 怎么踩到 |
|---|---|---|
| `:92-96` | 两源皆未到位 → `container.textContent === ''` | 把 `useSetupStatus()` 的结果拿去参与 `:108` 那个 early return 的判断（**不要**——发动机状态与「有没有数据可显示」无关，掺进去会让首载多一个空白条件） |
| `:113` | `container.querySelector('img')` truthy（L4：必须有图） | 动 `stuck` memo 或 `:110-134` 那个优先级阶梯 |
| `:121` / `:132` | `textContent` 不含 `tmdb:1396` / `videoPath` / `translate job 41` | 往页面加任何调试文案 |
| `:164-173` | 铁律③整页文案扫描 | 加任何含 `agent`/`worker`/`pass`/`asset`/`ledger` 的可见字 |

`:96-104` 那个 `missingBySeries`（连同 `:96-97` 那条「字段是 `series` 不是 `missingBySeason`」的
注释）与 `:46-52` 的每秒 `now`（2026-07-31 秒表冻结的修复）**一个字不改**。

---

- [ ] **Step 1: 前置核对 + 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && \
  grep -c "export function useSetupStatus" src/api/hooks.ts && \
  grep -c "engine_enabled" src/api/types.ts && \
  grep -c "settings_engine_label" src/i18n/en.ts src/i18n/zh.ts
```

Expected: 四个计数都 **≥ 1**（`grep -c` 命中 0 时退出码非 0，`&&` 链会当场断掉）。

若任何一条打 `0` 或整条链提前结束 → **Plan A 还没落地**。停下来报告，**不要**在这里自己补
`useSetupStatus` 或 i18n 键（那是 Plan A Task 13/14/15 的地盘，两处各写一份必然漂移）。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/activity/ActivityPage.test.tsx
```

Expected: **9 passed**。有红先停下报告。

- [ ] **Step 2: 扩 `stub()` 的第三参 + `SETUP` fixture**

`web/src/activity/ActivityPage.test.tsx`。先把 `:9-12` 的类型 import 补一个（**只加
`SetupStatusDTO`**，别动别的）：

```tsx
import type {
  WorkflowPendingDTO, WorkflowWorkersDTO, WorkflowRunningWorkerDTO,
  WorkflowRecentRunDTO, WorkflowHeldJobDTO, SetupStatusDTO,
} from '../api/types.js'
```

然后把 `:48-59` 整个 `stub()` 替换成（`SETUP` 放在它上面）：

```tsx
// 发动机开关的状态源。**默认给全的**，不走 stub 的 {} 兜底——那个兜底会让 setup.data 变成
// 一个真值空对象，engineEnabled 于是是 undefined，hero 那道
// `typeof engineEnabled === 'boolean'` 守卫不成立，**开关整块静默消失**，而下面 9 条断言全绿。
// 真环境里这份 DTO 永远是完整的、开关永远在场，所以让既有用例也照这个样子渲染才是保真的；
// 顺带让开关的可见文案落进 :164 那条铁律③的整页扫描里（另开一个 stubWithSetup() 就恰好漏掉它）。
// 需要「引擎关」的形状时用 { ...SETUP, engineEnabled: false }，别再加一个工厂函数。
const SETUP: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: true, source: 'db', masked: 'ass••••123' },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: false, source: 'env', captchaReady: true },
  },
  roots: { count: 1 },
  engineEnabled: true,
}

function stub(
  pending: WorkflowPendingDTO | null,
  workers: WorkflowWorkersDTO | null,
  setup: SetupStatusDTO | null = SETUP,
) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/workflow/pending') ? pending
      : url.includes('/workflow/workers') ? workers
        : url.includes('/setup/status') ? setup
          : {}
    if (body === null) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}
```

（`null` 表示「这一路 500」是这个 helper 的既有约定，第三参照用同一套——第 3 条锁就靠
`stub(..., null)` 造出「拉不到 setup」。`PUT /api/v2/settings` 三个 `includes` 都不命中，
落 `{}` 兜底返回 200——`mutate()` 里 `await res.json()` 拿到 `{}` 正常 resolve，正合用。）

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/activity/ActivityPage.test.tsx
```

Expected: 仍然 **9 passed**。

这一步刻意**不碰组件**：此刻 `ActivityPage` 还没调 `useSetupStatus`，那个 `/setup/status` 分支是
死代码。分开跑一次是为了把「替身能供上 setup」与「页面真去取 setup」拆成两次独立的绿/红，
Step 3 的红才没有歧义。

- [ ] **Step 3: 追加 6 条锁（会红）**

先补两个 import。`:5-6` 改成：

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
```

`:8` 之后补一行：

```tsx
import { api } from '../api/client.js'
```

在**文件末尾**追加：

```tsx
// ── 发动机开关（Spec C §5.3 的落点在 hero，写路径归容器）
//
// hero 那边测的是「给了 prop 就渲染、拨一下就调回调」；这里测的是容器的三件事：状态从哪来、
// 拿不到状态时画成什么、拨一下之后**网络上真的发生了什么**。
//
// 每条都先 await 剧名再**同步**查开关：这样接线没做时是 getByRole 立刻抛，而不是 findByRole
// 干等 5 秒（setupTests.ts:9 把 RTL 的 asyncUtilTimeout 提到了 5000）——6 条用例的红要
// 秒回，不是等半分钟。
describe('ActivityPage：发动机开关', () => {
  /** 命中过 /api/v2/settings 的 PUT 请求（fetch 层，不看 api 层）。 */
  const puts = () => vi.mocked(globalThis.fetch).mock.calls.filter(
    ([u, init]) => String(u).includes('/api/v2/settings') && init?.method === 'PUT',
  )
  /** 命中过 setup/status 的请求次数——用来看 reload 有没有真的回读。 */
  const statusHits = () => vi.mocked(globalThis.fetch).mock.calls.filter(
    ([u]) => String(u).includes('/setup/status'),
  ).length

  it('在跑 hero 上挂着开关，且照服务端真值渲染（状态来自 setup/status，不是本地 state）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    renderPage()
    await screen.findByText('Silo')
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
  })

  it('engineEnabled=false → 开关照实渲染成关态（守 `|| true` 那类手滑）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }), { ...SETUP, engineEnabled: false })
    renderPage()
    await screen.findByText('Silo')
    // 写成 `setup.data?.engineEnabled || true` 的话这里会是 'true'——引擎真的关了也画成开，
    // 「关」这个态从此在屏上不存在，而别的锁都不会响。
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
  })

  it('setup/status 拉不到 → 开关仍在场且为开（失败开放：宁可少报也不诬告后端停工）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }), null)
    renderPage()
    await screen.findByText('Silo')
    await waitFor(() => expect(statusHits()).toBeGreaterThan(0))
    // 写成 `?? false` / `!!setup.data?.engineEnabled` 的话这里是 'false'——守卫仍成立、开关
    // 还在场，只是把「在干活」画成了「已停工」。所以必须断言 aria-checked，不能只断言在场。
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('并发两条在跑 → 全屏只有一个开关（发动机是全局的，不是每个任务一台）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow(), runningRow({ jobId: 8 })] }))
    renderPage()
    expect(await screen.findAllByText('Silo')).toHaveLength(2)
    // 两条 hero 各挂一个的话这里是 2：同一个全局状态在屏上出现两次，拨一个另一个跟着变。
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getAllByTestId('activity-hero-engine')).toHaveLength(1)
  })

  it('拨掉开关 → PUT /api/v2/settings body 是 { engine_enabled: "false" }，并立刻回读一次', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    renderPage()
    await screen.findByText('Silo')
    const before = statusHits()
    fireEvent.click(screen.getByRole('switch'))
    // 断在 fetch 层而不是 spy 在 api.updateSettings 上：这样连「客户端有没有把 patch 正确
    // 序列化进 body」也一起锁住了（mutate() 的 body 是 JSON.stringify(patch)）。
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(JSON.parse(String(puts()[0]![1]!.body))).toEqual({ engine_enabled: 'false' })
    // reload：不等 15 秒轮询就把新态取回来。首载那一次不算，所以比基线大才算。
    await waitFor(() => expect(statusHits()).toBeGreaterThan(before))
  })

  it('PUT 失败 → 开关纹丝不动（受控件，位移只随回读），且仍然回读（catch 不吞，把失败交给受控值表达）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    renderPage()
    await screen.findByText('Silo')
    const before = statusHits()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(statusHits()).toBeGreaterThan(before))
    // 开关是全受控件，真值只在 setup.data.engineEnabled——拇指从头到尾没动过：点击只发出 PUT，
    // 位移要等回读落地；PUT 失败后回读拿到的还是「开」，aria-checked 保持 'true'。
    // 「拨了没反应」就是诚实的失败信号（本屏无 toast 承接错误，L7）。
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/activity/ActivityPage.test.tsx 2>&1 | tail -30
```

Expected: **6 failed / 9 passed**。六条都死在同一句话上：
`Unable to find an accessible element with the role "switch"`（第 4 条是
`getAllByRole` 的同族报错）——此刻 hero 还没收到那两个 prop，所以开关不渲染。

若某条反而报 `Found multiple elements with the role "switch"` → 说明你已经把 prop 传给了
`running.map` 里的**每一条** hero（见背景三），回去只传 `i === 0`。

- [ ] **Step 4: 接线 `ActivityPage.tsx`**

① `:22` 那行 import 补上 `useSetupStatus`，并在它下面加一行 `api`：

```tsx
import { useSetupStatus, useWorkflowPending, useWorkflowWorkers } from '../api/hooks.js'
import { api } from '../api/client.js'
```

② `:35-36` 之后补第三个 hook：

```tsx
  const pending = useWorkflowPending()
  const workers = useWorkflowWorkers()
  // 发动机开关的状态源（spec A §5.5 出数据、spec C §5.3 定位置）。这是 useSetupStatus 的第二个
  // 实例（另一个在 EngineBanner 里）——本仓没有 react-query/swr，每个 hook 实例各自 15 秒轮询，
  // 与 banner 同频，是既有约定（Spec C §6-2 只禁止**更快**的轮询，不禁止同频的第二个实例）。
  const setup = useSetupStatus()
```

③ `:110` 那行 `const body = ...` **之前**插入这两段：

```tsx
  // 失败开放：只有 data === null（还没回来 / 拉取失败）才回落成「开」。写成 `?? false` 会在
  // 拉取失败时把正在干活的后端画成「已停工」；写成 `|| true` 会让真的关掉也显示成开——两种都
  // 不会被 hero 那边的测试抓住（那边是直接喂 prop 的），所以本页测试里各有一条锁守着。
  const engineEnabled = setup.data ? setup.data.engineEnabled : true

  const onEngineChange = async (next: boolean) => {
    try {
      await api.updateSettings({ engine_enabled: next ? 'true' : 'false' })
    } catch {
      // 不吞：受控件不位移——checked={engineEnabled}，真值只在 setup.data.engineEnabled，
      // 拨动后拇指**不会立刻动**，要等下面这次回读把服务端值拉回来才动；PUT 失败则纹丝不动，
      // 「拨了没反应」本身就是诚实的失败信号（本屏无 toast 承接错误文案，L7：不给排查入口）。
      // catch 不能省：不 catch，rejection 就是控制台里一条 unhandled rejection——那才真的没人看见。
    }
    setup.reload()
  }
```

④ `:115-122` 那个 `running.map`，把回调参数补上下标、并只给**第一条** hero 挂开关：

```tsx
          {running.map((r, i) => (
            <ActivityHero
              key={r.jobId}
              running={r}
              missingCount={r.seriesId === null ? null : missingBySeries.get(r.seriesId) ?? null}
              now={now}
              // 发动机是**全局**开关，只挂第一条。并发在跑时每条 hero 各挂一个的话，同一个状态
              // 在屏上出现两次、拨一个另一个跟着变，读起来像「每个任务各有一台发动机」。
              // hero 的两个 prop 都是 optional，给 undefined 就是那一块不渲染，组件侧不用改。
              engineEnabled={i === 0 ? engineEnabled : undefined}
              onEngineChange={i === 0 ? onEngineChange : undefined}
            />
          ))}
```

`:108` 那个 early return **一个字不改**：发动机状态与「有没有数据可显示」无关，把 `setup` 掺进
那个条件会让首载多一个空白条件，而 `:92-96` 那条 `textContent === ''` 照绿（它本来就是空的）。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/activity/ActivityPage.test.tsx
```

Expected: **15 passed**（9 既有 + 6 新增）。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx tsc --noEmit
```

Expected: 无输出。

若报 `Property 'engine_enabled' does not exist on type 'SettingsPatch'` → Plan A Task 14 的
`SettingsKey` 扩展没落地，回 Step 1 的前置核对。

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/activity/ActivityPage.tsx web/src/activity/ActivityPage.test.tsx
git commit -m "feat(web): 活动页 hero 接上发动机开关（状态取 setup/status，写回 PUT settings）"
```

- [ ] **Step 6: 卸掉最后一个 `VStack`**

① 删除 `web/src/activity/ActivityPage.tsx:21`：

```tsx
import { VStack } from '@astryxdesign/core/VStack'
```

② `:137` 的 `<VStack gap={3}>` 换成：

```tsx
    {/* 三块之间 12px。这个 VStack 是**裸的**（没有 className），CSS 里没有任何选择器命中它——
        flex flex-col gap-3 就是布局的唯一来源，掉了整页会贴成一坨。逐值等价：Astryx 的
        gap={3} → --spacing-3 = 12px（tokens.stylex.ts:158），Tailwind gap-3 = 0.75rem，
        而 styles.css 与 theme/scout.css 都没有改根字号，所以也是 12px。 */}
    <div className="flex flex-col gap-3">
```

③ `:153` 的 `</VStack>` 换成 `</div>`。

- [ ] **Step 7: 全绿 + `src/activity/` 收口**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/activity/ && npx tsc --noEmit
```

Expected: 全绿 + tsc 无输出。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/activity/ || echo "activity/ clean"
```

Expected: 打 **`activity/ clean`**。这一条到本 task 才真的成立——Task 17 跑完时它还剩
`ActivityPage.tsx:21` 这一处（Task 17 Step 11 的 Expected 就写着「一处命中」）。若还有命中，
照实报告文件名。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "VStack\|HStack" src/activity/ || echo "no stack left"
```

Expected: 打 `no stack left`。（`Text` 不查——那是个太常见的词，`ActivityQueue` 之类的注释里
可能正常提到；`astryxdesign` 那条 grep 才是权威判据。）

- [ ] **Step 8: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/activity/ActivityPage.tsx
git commit -m "refactor(web): 活动页容器卸 Astryx——src/activity 收口"
```

**给 Task 19（Library 海报墙）的备忘：** `src/activity/` 到此一处 Astryx 都没有了，六件组件 +
接线层全在新栈上。Library 那三个 task 会遇到本组没有的两样东西：① 它有真正的**网格**布局
（`.lib-grid` 一族），几何比 Activity 重，动手前先按 Task 13 的手法把每条 CSS 规则**有没有
`display`** 查一遍；② 它有 `Button`/`Input` 之类的交互件，落 shadcn（Task 7 的七件底座已进场），
不像 Activity 这样清一色原生标签。

`ActivityPage.test.tsx` 里那个 `SETUP` fixture 只服务本文件，**不要**把它抽成共享 fixture 模块
——它旁边那段「为什么默认给全、不走 `{}` 兜底」的论证是这几条锁能不能被读懂的前提，抽出去论证
就离开现场了（同 Task 17 对 `cssDecl` 的处置）。

---

### Task 19: SeriesGrid / PosterCard —— Library 海报墙卸 Astryx（纯调用点迁移 + 一段格阵 CSS）

Library（`#/library`）三件里的**列表页**。它是四屏重建里第一个有**真网格**的屏——几何比 Activity
重。好消息：它需要的每个 primitive 都已经落地了（Task 7 的 `Skeleton`、Task 8 的 `Section` /
`Segmented` / `AspectRatio` / `EmptyState`、Plan A Task 14 的 `Button`），所以这个 task **不新建任何
组件**，纯粹是把三个文件里的 Astryx JSX 换成新件的调用点，外加 `styles.css` 里那段海报墙原子 CSS
的 token 迁移 + 一条网格类。

**Files:**
- Modify: `web/src/styles.css`（`.library-poster-*` 一族 9 处 token 迁移 + 新增 `.library-grid` 一条。**全文只碰这个区段**）
- Modify: `web/src/library/SeriesGrid.tsx`（删 9 行 Astryx import；`Section`/`Segmented`/`Skeleton`/`EmptyState`/`Button` 换新件；`Grid`/`Heading`/`Text`/`HStack`/`VStack` 换标签+类；删 `GRID_COLUMNS` 常量）
- Modify: `web/src/library/PosterCard.tsx`（删 2 行 Astryx import；`AspectRatio` 换新件；3 个 `Text` 换 `<span>`+类；**丢掉 `hasTruncateTooltip`**）
- Modify: `web/src/library/SeriesGrid.test.tsx`（引入 `__STYLES_CSS__` + `cssDecl` 底座；既有 **6** 条一条不动；追加 2 个 `describe` → CSS 侧 4 条 + DOM 侧 3 条）
- **不碰**：`web/src/library/PosterThumb.tsx`——它**没有一个 Astryx import**（`useState` + `posterUrl` 而已），标题里带它只是因为它是海报图的下游，本 task 一个字都不动它。

两个 commit：① 先写 CSS 锁再改 `styles.css`（TDD：本文件此刻**一条 CSS 断言都没有**，同 Task 17
的处置），② 两个组件卸 Astryx + DOM 侧迁移锁。分开是为了让 CSS 迁移的 diff 单独成条——它带着这个
task 最阴的那处改动（见背景一）。

---

#### 背景一：`--color-accent` 跨栈同名撞车——海报墙这一屏最阴的一处，而且**过渡期就会炸**

这是全 Plan C 里最需要写清楚的一处。`styles.css:61` 现在是：

```css
.library-poster-card:focus-visible {
  outline: 2px solid var(--color-accent);
}
```

`--color-accent` **两套栈都定义了，值在光谱两端**：

- **新栈**（Plan A `tw.css` 的 `@theme`，`:40`）：`--color-accent: #16181f`——一个**深色面**（注释写
  "面：hover/活跃"）。
- **旧栈**（`theme/scout.css:86`）：`--color-accent: light-dark(#266D00, #96DA26)`——暗色解析成
  **#96DA26，一块柠檬绿**。

两处都是 `var(--color-accent)`，**文本一模一样**，所以：Task 31 删掉 `theme/scout.css` 的那一刻，这
个 `var()` 从"绿"静默切成"深灰"——而 `.library-poster-frame` 的 `background` 恰好就是
`#16181f`，焦点环于是**隐形**。这是这份计划一路在拆的静默失败家族里最狠的一种：**两套栈都定义了
这个 token**，所以没有 undefined-var 兜底会响；CSS 文本没动，diff 看着干净；jsdom 不算 computed
style，所有测试照绿。**只有真人用键盘 Tab 到海报卡、在卸载 Astryx 之后，才会发现焦点环没了。**

**裁决：焦点环迁到 `var(--color-ring)`（#8b7cf6 紫）。** 理由：`--color-ring` 是新栈**唯一的焦点
可供性 token**——`button.tsx`/`input.tsx`/`select`/Task 8 的 `segmented.tsx` 的焦点环全是
`focus-visible:ring-ring/50`，海报卡跟着统一。不选新栈那块绿（`--color-sidebar-active` #a3e635）：
那块绿在侧栏语义是"当前页"，拿来做海报焦点环会让它成为全站唯一一处绿焦点环。

**但撞车的影响不止焦点环——这是本背景真正的要害。** `--color-accent` 被 `scout.css` 定义在
`@scope ([data-astryx-theme="scout"]) to ([data-astryx-theme])` 里（`:84`），也就是说它**只对挂在
`<Theme data-astryx-theme="scout">` 里面的元素生效**，而整个 app 都在那个 wrapper 里（Task 31 才
拆）。自定义属性是继承的：离元素最近的那层祖先上的 `--color-accent` 声明赢——`[data-astryx-theme]`
那层（绿）是 `:root`（@theme 那层 #16181f）的后代，所以**过渡期内（Task 19～30，Astryx 还在）**，
海报墙里任何 `var(--color-accent)` 引用都解析成**柠檬绿**，不是 #16181f。

这直接推翻了一个看着"值对得上"的迁移写法：把 `.library-poster-frame` / `.library-poster-fallback`
的 `background`（现在是 `var(--color-background-surface)` = #16181f）迁成 `var(--color-accent)`。
论 Task 31 之后的终值，`--color-accent`(@theme) = #16181f，和原值一致，看着没问题。但**过渡期里它
会把每一张海报框、每一个无海报的首字母占位块刷成柠檬绿**，从 Task 19 一直绿到 Task 31——一个整整
十几个 task 的可见回归。

**裁决：`background` 迁到 `var(--color-secondary)`，不是 `var(--color-accent)`。** 已核对：
`scout.css` **不定义** `--color-secondary`（`grep -c` 打 0），而 `@theme` 里
`--color-secondary: #16181f`（Plan A `:55`）。所以 `var(--color-secondary)` 在过渡期（无 scout 遮蔽
→ 取 @theme #16181f）和 Task 31 之后（仍 @theme #16181f）**都是 #16181f，不撞车**。语义上它是 shadcn
的"次级面"token，#16181f 本就是面色，海报框读它站得住。

**为什么必须迁、不能留 `var(--color-background-surface)` 原样**：`--color-background-surface` 是
scout-only token（`@theme` 里没有），Task 31 删掉 scout 之后它 undefined，`background` 掉回透明
/继承——海报框和占位块的面色凭空消失。所以"留着不动"不是选项。

**这就是本 task 迁移目标选择的总规则**：迁移目标必须是 `scout.css` **不遮蔽**的 `@theme` token，
否则过渡期会渲染 scout 的值。逐个核对过（`grep -c <token> src/theme/scout.css`）：

| 迁移目标 | scout 是否遮蔽 | 过渡期 & 终值 | 用它安全？ |
|---|---|---|---|
| `--color-ring` | 否（0） | #8b7cf6 两期一致 | ✅ 焦点环 |
| `--color-secondary` | 否（0） | #16181f 两期一致 | ✅ 框/占位块底 |
| `--color-weak` | 否（0） | #6b7280 两期一致 | ✅ 占位块字 |
| `--color-fn-green` | 否（0） | #28bf5c 两期一致 | ✅ 全覆盖绿点 |
| `--color-background` | 否（0；scout 只有 `-body`/`-surface` 带后缀的） | #0b0c0f 两期一致 | ✅ 角标衬底 |
| `--radius-control` | 否（0） | 8px 两期一致 | ✅ 三处圆角 |
| `--color-accent` | **是（6，柠檬绿）** | 过渡期绿 / 终值 #16181f | ❌ **禁用**——见上 |
| `--color-border` | 是，但**值相同**（scout `:107` 与 @theme `:41` 都是 `rgba(255,255,255,0.07)`） | 两期都 rgba 白 0.07 | 边框**不迁**、留 `var(--color-border)` 即可 |

#### 背景二：CSS 迁移逐行表（值全部逐条核对过）

`styles.css` 的 `.library-poster-*` 区段（`:48-118`）。**换 token 名不换颜色**，值核对写在最后一列
（左值取自 `scout.css`，右值取自 `@theme`）：

| 选择器 | 属性 | 现值 | 新值 | 值核对 |
|---|---|---|---|---|
| `.library-poster-card` | `border-radius` | `var(--radius-element, 8px)` | `var(--radius-control)` | scout `:169`=8px；@theme `:69`=8px ✓ |
| `.library-poster-card:focus-visible` | `outline` | `2px solid var(--color-accent)` | `2px solid var(--color-ring)` | **有意改色**：#96DA26 绿 → #8b7cf6 紫（背景一） |
| `.library-poster-frame` | `border-radius` | `var(--radius-element, 8px)` | `var(--radius-control)` | 同上 8px ✓ |
| `.library-poster-frame` | `border` | `1px solid var(--color-border)` | **不动** | 两栈同值 rgba(255,255,255,0.07) ✓ |
| `.library-poster-frame` | `background` | `var(--color-background-surface)` | `var(--color-secondary)` | scout `:90`=#16181f；@theme `:55`=#16181f ✓（**不是 --color-accent**） |
| `.library-poster-fallback` | `background` | `var(--color-background-surface)` | `var(--color-secondary)` | 同上 #16181f ✓ |
| `.library-poster-fallback` | `color` | `var(--color-text-gray)` | `var(--color-weak)` | scout `:175`=#6b7280；@theme `:45`=#6b7280 ✓ |
| `.library-poster-dot` | `background` | `var(--color-text-green)` | `var(--color-fn-green)` | scout `:176`=#28bf5c；@theme `:49`=#28bf5c ✓ |
| `.library-poster-count` | `background` | `color-mix(in srgb, var(--color-background-body) 72%, transparent)` | 同式，`--color-background-body` → `--color-background` | scout `:91`=#0b0c0f；@theme `:38`=#0b0c0f ✓ |
| `.library-poster-skel-frame` | `border-radius` | `var(--radius-element, 8px)` | `var(--radius-control)` | 同上 8px ✓ |

**不动的**：`.library-poster-card` 的 `display:block`/`color:inherit`（承重，卡壳靠它）、`:hover` 的
`transform`/`border-color`（字面 rgba）、`.library-poster-frame img` 整条、`.library-poster-meta` 的
`padding-top:6px`、`.library-poster-dot` 尺寸、`.library-poster-count` 的 `padding`/`border-radius`
（3px 字面）、`.library-detail-header-poster`（那是 **Task 20** 的地盘，它的
`var(--radius-inner,4px)` / `var(--color-background-surface)` 留给 Task 20 迁）。

⚠️ **`.library-poster-fallback` 是共享类，本 task 迁它是对的、不是越界。** 它被
`.act-hero-poster` / `.act-row-poster`（Activity，Tasks 13-15）和 `.library-detail-header-poster`
（Task 20）用后代选择器复用（只改 `font-size`）。这条**基规则**在本 task 的 CSS 区段里，归本 task；
而且它现在读的两个 token（`--color-background-surface` / `--color-text-gray`）都是 scout-only，
Task 31 之后会 undefined——**不迁它，那三处 Activity 占位块的底色和字色会在卸载那一刻一起丢**。
所以迁它既是本屏所需，也顺带把复用它的下游一起救了（值不变，Activity 的既有断言只查
`.act-row-poster .library-poster-fallback` 存不存在、不查颜色，不受影响）。

#### 背景三：新增 `.library-grid`——几何为什么落 CSS，不落 Tailwind 任意值

现在两处网格走 Astryx 的 `<Grid columns={{minWidth:150, max:8}} gap={4}>`。Astryx 的
`buildCappedTemplate`（`node_modules/@astryxdesign/core/src/Grid/Grid.tsx:340-365`）把它编译成：

```
grid-template-columns: repeat(auto-fill, minmax(min(100%, max(150px, calc((100% - 7 * var(--spacing-4)) / 8))), 1fr));
display: grid;
gap: var(--spacing-4);
```

（`max:8` 把每条轨道的**最小值**顶起来，从而永远塞不下第 9 列；`7 * gap` 是 8 列之间的 7 道缝。
`--spacing-4` = 16px，已核对 `tokens.stylex.ts:159`。）

**裁决：这段几何落 `styles.css` 的 `.library-grid` 类，不写成 Tailwind 任意值。** 两个理由：

1. 写成 Tailwind arbitrary（`grid-cols-[repeat(auto-fill,minmax(min(100%,max(150px,calc((100%-7*1rem)/8))),1fr))]`）
   要把每个空格换成 `_`、每个逗号小心转义，一长串不可读、易错。
2. **这段 CSS 区段的段头自己就把"格阵网格"划进了它的职责**。`styles.css:40-45` 的段头写着：
   "…这几处是"组件语言表达不了"的原子级 UI（**格阵网格**、海报卡 hover 发丝线抬升、EpisodeCell
   的 5px 语义点 + 斜体、固定右侧板）…"。这与 Activity 段（Tasks 13-17）**恰好相反**——那边段头
   限定自己"只管 padding 与 ink"，所以那几个 task 一律禁止往 CSS 加几何（`display:flex` 都要留在
   组件层）。Library 段头显式认领几何，所以这里落 `.library-grid` 是遵段头、不是破例。审计时对照
   这处反差，别把它读成前后不一致。

`var(--spacing-4)` 换成字面 `1rem`（Tailwind v4 的 `--spacing` 是单一乘数基，没有 `--spacing-4`
这个名；`1rem` = 16px，与 Astryx 的 `--spacing-4` 逐值等价）。`gap` 也写字面 `1rem`（= Tailwind
`gap-4`，两处网格原本都是 `gap={4}`）。新类：

```css
.library-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, max(150px, calc((100% - 7 * 1rem) / 8))), 1fr));
}
```

放在 `.library-poster-skel-frame` 那条**之后**（海报卡区段的末尾），紧跟着才是
`/* ---- 剧集页头部海报缩略 ---- */`。

#### 背景四：`hasTruncateTooltip` 是**死 prop**，要丢掉、不要"翻译"成 `truncate`

`PosterCard.tsx:53` 的标题现在是：

```tsx
<Text type="label" color="primary" hasTruncateTooltip display="block">
```

`hasTruncateTooltip` 这个名字诱人把它"保真"成 `truncate` + `title`——**那是错的，会改行为**。逐条取证
自 `node_modules/@astryxdesign/core/src/Text/Text.tsx`：

- `:210` `hasTruncateTooltip` 默认 `true`；`maxLines` 默认 `0`。
- `:245` `const tooltipEnabled = maxLines > 0 && hasTruncateTooltip !== false && truncation.isTruncated`
  ——`maxLines=0` ⇒ **`tooltipEnabled` 恒 `false`**。
- `:234` `const resolvedDisplay = maxLines > 0 || hasCapsize ? 'block' : display`——`maxLines=0` ⇒
  用显式的 `display="block"`，**没有任何行夹取**。

`PosterCard` 传了 `hasTruncateTooltip` 却**从不传 `maxLines`**，所以这个 prop 今天**什么都没做**：
标题在 `.library-poster-meta`（只有 `padding-top:6px`，无行夹取）里**自由换行**。

**裁决：直接丢掉 `hasTruncateTooltip`，标题就是 `<span className="block …">`。** 翻译成
`truncate`（= `overflow:hidden;text-overflow:ellipsis;white-space:nowrap`）会把标题从"自由换行"变成
"单行截断加省略号"——那是**新增**行为，正是本 spec 对漂移的定义。这一条必须写明，因为 prop 的
**名字**恰好在诱导那个错误翻译，而错译看起来像"忠实保留"。

#### 背景五：五个 `Text`/`Heading` 调用点的逐处映射（字号走 scout 覆盖后的档，见 Task 8 开头那张表）

`scout.css:114-124` 把 `--font-size-*` 阶梯整条覆盖过，`--text-*-size` 都是它的间接引用，所以真正
落屏的字号是：`body/label/code` = **13px**、`supporting` = **11px**、`large/heading-3` = **16px**、
`--font-size-2xs` = **8px**。行高（`--text-*-leading`）是无单位的：`body/label/code` 1.5385（=20px）、
`supporting` 1.4545（=16px）、`heading-3` 1.5（=24px）。字号写死不变的调用点用 rem 工具类是精确等价、
也是 Task 13-18 已落地的写法（`leading-5`=20px、`leading-4`=16px、`leading-6`=24px）。

| 文件:行 | 现 Astryx | 换成 | 依据 |
|---|---|---|---|
| `SeriesGrid.tsx:65` | `<Text type="code" color="secondary">` | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">` | code 13/mono/leading 20；secondary=muted-foreground |
| `SeriesGrid.tsx:86` | `<Heading level={3} color="secondary">` | `<h3 className="m-0 text-[16px] font-semibold leading-6 text-muted-foreground">` | heading-3 16/semibold/leading 24；secondary=muted-foreground。`m-0`：Task 31 顶上 Tailwind preflight，heading 默认 margin 归 0，显式写死不受栈切换影响 |
| `PosterCard.tsx:53` | `<Text type="label" color="primary" hasTruncateTooltip display="block">` | `<span className="block text-[13px] font-medium leading-5 text-foreground">` | label 13/**medium(500)**/leading 20；primary=foreground；`hasTruncateTooltip` **丢**（背景四） |
| `PosterCard.tsx:56` | `<Text type="supporting" color="secondary" display="block">` | `<span className="block text-[11px] leading-4 text-muted-foreground">` | supporting 11/400/leading 16；不写 `font-normal`（400 是初值，同 Task 17 的 body 处置，且同容器内的 sibling 标题是 500、不会继承下来） |
| `PosterCard.tsx:22` | `<Text type="code" size="2xs" color="secondary">` | `<span className="font-mono text-[8px] leading-[1.5385] text-muted-foreground">` | `size="2xs"` 只覆盖 fontSize（`text.stylex.ts:153-185` 的 `sizeStyles` 只设 `fontSize`），**leading 仍是 code 的 1.5385**——所以写无单位 `leading-[1.5385]`，不是 `leading-5`（角标是 8px 单行，8×1.5385≈12.3px 行盒） |

（`type="label"` 权重是 `--font-weight-medium` = 500，`scout.css` 没覆盖权重 token，取自
`tokens.stylex.ts:333-335` 的 400/500/600。`heading-3` 权重 semibold=600。这两处**要写**
`font-medium`/`font-semibold`，因为 ≠ 400；`code`/`supporting` 是 400，不写权重类。）

#### 背景六：primitive 调用形状的对照（都已在 Task 7/8/Plan A Task 14 落地）

| 现 Astryx | 换成新件 | API 差异 |
|---|---|---|
| `<Section padding={4}>` | `<Section>` | Task 8 的 `section.tsx` 把 `p-4` **和 `bg-accent`（#16181f 面色）写死**——Astryx Section 默认 variant 就刷 `--color-background-surface`=#16181f，所以这不是丢背景、是逐值保真 |
| `<SegmentedControl value onChange label>` + `<SegmentedControlItem value label>` 子元素 | `<Segmented items={[{value,label}]} value onChange label />` | **`items` 数组 API**（不再 map 子元素）；`onChange: (value: string) => void` |
| `<Grid columns={GRID_COLUMNS} gap={4}>` | `<div className="library-grid">` | 见背景三；`GRID_COLUMNS` 常量删掉 |
| `<Skeleton radius={2} index={i}/>` | `<Skeleton index={i} className="h-full w-full rounded-control"/>` | Task 7 的 skeleton **无默认圆角/尺寸**，全由 className 给；radius=2→`rounded-control`(8px)，Astryx 默认 w/h=100%→`h-full w-full` |
| `<Skeleton height={12} width="70%" radius={1} index={i}/>` | `<Skeleton index={i} className="h-3 w-[70%] rounded-[4px]"/>` | height 12px→`h-3`(0.75rem=12px)；width 70%→`w-[70%]`；radius=1→`rounded-[4px]`（新栈无 4px 圆角 token，用字面） |
| `<EmptyState title description actions/>` | 同名，**零改动** | Task 8 的 `empty-state.tsx` 同 prop（`findByText('No library yet')` / `getByRole('button',{name:'Retry'})` 都靠它） |
| `<Button label={…} variant="secondary" onClick={reload}/>` | `<Button variant="secondary" onClick={reload}>{…}</Button>` | Plan A Task 14 的 button 用 **children**，不是 `label` prop |
| `<VStack gap={n}>` / `<HStack gap={n} vAlign wrap>` | `<div className="flex flex-col gap-n">` / `<div className="flex flex-wrap items-center gap-n">` | gap{2/3/4/6}→gap-{2/3/4/6}（4/8/12/16/24px 逐值，同 Task 18 已核对根字号未改） |

---

- [ ] **Step 1: 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesGrid.test.tsx
```

Expected: **6 passed**。有红先停下报告。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/library/PosterThumb.tsx || echo "PosterThumb clean"
```

Expected: 打 `PosterThumb clean`（确认它确实无 Astryx，本 task 不动它）。

- [ ] **Step 2: 给测试文件补 `cssDecl` 底座**

`web/src/library/SeriesGrid.test.tsx`，在 `:8` 那行 `import type { LibraryItemDTO }` 之后插入
（同 `ActivityHero`/`ActivityEmpty` 等文件里的实现，逐字一致，别"优化"）：

```tsx
// CSS 断言的取值方式同 src/activity 下四个测试文件（那里有完整论证）：`?raw` 在 vitest 里恒
// 返回空串，`node:fs` 撞 tsconfig 的 types 白名单——所以走 vitest.config.ts:21 的 `define` 在
// 编译期把 styles.css 内容替换进来。
//
// 这一屏为什么读 CSS：它最阴的一处改动（焦点环 --color-accent → --color-ring，海报框底
// --color-background-surface → --color-secondary）全在 CSS 侧，jsdom 不算 computed style，
// 只看 DOM 的话改错了也是全绿；而这两处又都踩在 --color-accent 跨栈撞车上（背景一）。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明。先剥注释。多选择器逗号组里若同名选择器先出现，
 *  exec 命中的是源码里第一个"选择器紧跟 {"的块——本 task 用到的 .library-poster-frame /
 *  .library-poster-fallback 的**主规则**都在各自后代/悬停规则之前，所以取到的是主规则。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}
```

- [ ] **Step 3: 先写 CSS 侧迁移锁（会红）**

在 `SeriesGrid.test.tsx` **文件末尾**追加：

```tsx
// ── CSS 侧迁移锁（Astryx token → 新栈 @theme token，Task 19）
//
// 这一屏最阴的改动全在 CSS：焦点环和海报框底都踩在 --color-accent 跨栈撞车上（新栈 #16181f 深面 /
// 旧栈 #96DA26 柠檬绿），而且旧栈那份是 @scope 到 [data-astryx-theme="scout"] 的——过渡期（Astryx
// 未卸）里任何 var(--color-accent) 都解析成绿。所以迁移目标必须是 scout 不遮蔽的 @theme token：
// 焦点环 → --color-ring，框/占位块底 → --color-secondary（不是 --color-accent！）。jsdom 不算
// computed style，这几条只能在 CSS 文本上锁。
describe('SeriesGrid：CSS 侧迁移锁', () => {
  it('焦点环走 --color-ring，不是 --color-accent（后者过渡期是绿、卸载后与框底同色 → 隐形）', () => {
    expect(CSS).toContain('outline: 2px solid var(--color-ring)')
    // 用完整 `outline: 2px solid var(--color-accent)` 做负向断言，避开侧栏那处 color: var(--color-accent)。
    expect(CSS).not.toContain('outline: 2px solid var(--color-accent)')
  })

  it('海报框 / 占位块底走 --color-secondary（#16181f，scout 不遮蔽），不是 --color-accent（过渡期会刷成绿）', () => {
    expect(cssDecl('.library-poster-frame', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.library-poster-fallback', 'background')).toBe('var(--color-secondary)')
    // 边框不迁：两栈同值 rgba(255,255,255,0.07)，留 --color-border。
    expect(cssDecl('.library-poster-frame', 'border')).toBe('1px solid var(--color-border)')
  })

  it('占位块字 → --color-weak、全覆盖绿点 → --color-fn-green、角标衬底 → --color-background', () => {
    expect(cssDecl('.library-poster-fallback', 'color')).toBe('var(--color-weak)')
    expect(cssDecl('.library-poster-dot', 'background')).toBe('var(--color-fn-green)')
    expect(CSS).toContain('color-mix(in srgb, var(--color-background) 72%, transparent)')
    // 三处圆角统一到 --radius-control（8px）。
    expect(cssDecl('.library-poster-card', 'border-radius')).toBe('var(--radius-control)')
    expect(cssDecl('.library-poster-frame', 'border-radius')).toBe('var(--radius-control)')
    expect(cssDecl('.library-poster-skel-frame', 'border-radius')).toBe('var(--radius-control)')
  })

  it('.library-grid 落地：display:grid + 那条 8 列封顶模板（几何归 CSS，见段头认领）', () => {
    expect(cssDecl('.library-grid', 'display')).toBe('grid')
    expect(CSS).toContain(
      'repeat(auto-fill, minmax(min(100%, max(150px, calc((100% - 7 * 1rem) / 8))), 1fr))',
    )
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesGrid.test.tsx 2>&1 | tail -25
```

Expected: **4 failed / 6 passed**。四条新锁都因为 CSS 还是旧 token 而红（`.library-grid` 那条报
`expected null to be 'grid'`，其余报旧值如 `var(--color-accent)` / `var(--color-background-surface)`）。

若某条报 `expected null to be …`（除了 `.library-grid` 那条）→ `cssDecl` 没读到块，说明 Step 2 的
底座搬错了或 `__STYLES_CSS__` 没生效，停下报告，**不要**改 CSS 蒙过它。

- [ ] **Step 4: 改 `styles.css`（9 处迁移 + 新增 .library-grid）**

`web/src/styles.css` 的 `.library-poster-*` 区段，逐处改。把 `:49-118` 整段替换成：

```css
.library-poster-card {
  display: block;
  color: inherit;
  text-decoration: none;
  border-radius: var(--radius-control);
  transition: transform 120ms ease, border-color 120ms ease;
}
.library-poster-card:hover,
.library-poster-card:focus-visible {
  transform: translateY(-2px);
}
.library-poster-card:focus-visible {
  /* --color-ring（#8b7cf6），不是 --color-accent：后者两栈同名值不同（新 #16181f / 旧 scout 柠檬绿），
     且旧值 @scope 到 [data-astryx-theme]，过渡期解析成绿、Task 31 卸载后又与框底 #16181f 同色 → 隐形。
     --color-ring 是新栈统一的焦点可供性 token（button/input/select/segmented 都用它）。 */
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}
.library-poster-frame {
  position: relative;
  border-radius: var(--radius-control);
  overflow: hidden;
  border: 1px solid var(--color-border);
  /* --color-secondary（#16181f），不是 --color-accent：--color-accent 被 scout 遮蔽成柠檬绿，
     过渡期会把整墙海报框刷绿；--color-secondary 两栈都不遮蔽、恒 #16181f。 */
  background: var(--color-secondary);
  transition: border-color 120ms ease;
}
.library-poster-card:hover .library-poster-frame {
  border-color: rgba(255, 255, 255, 0.14);
}
.library-poster-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.library-poster-fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-secondary);
  color: var(--color-weak);
  font-size: 22px;
  font-weight: 600;
}
.library-poster-meta {
  padding-top: 6px;
}
.library-poster-dot {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-fn-green);
}
.library-poster-count {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 4px;
  border-radius: 3px;
  /* 海报底图深浅不定，角标需要一层不透明衬底才能保证可读——颜色仍读页面底 token（color-mix 派生
     半透明版本），不是新起硬编码色值。--color-background = #0b0c0f（scout --color-background-body
     的等值 @theme 名，scout 不遮蔽 bare --color-background）。 */
  background: color-mix(in srgb, var(--color-background) 72%, transparent);
}
.library-poster-skel-frame {
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-control);
  overflow: hidden;
}
.library-grid {
  /* Astryx <Grid columns={{minWidth:150,max:8}} gap={4}> 的逐值等价（buildCappedTemplate 解码）：
     max:8 靠抬高每条轨道最小值来封顶列数；7*1rem 是 8 列之间的 7 道缝；--spacing-4=16px=1rem。
     几何落 CSS 而非 Tailwind 任意值：本区段段头显式认领"格阵网格"（与 Activity 段"只管 padding
     与 ink"相反）。 */
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, max(150px, calc((100% - 7 * 1rem) / 8))), 1fr));
}
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesGrid.test.tsx
```

Expected: **10 passed**（6 既有 + Step 3 的 4 条）。

按选择器抽查改到位、且**旧 token 名在本区段绝迹**（区段锚定，不写死行号）：

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && awk '/^\.library-poster-card \{/,/^\.library-grid \{/' src/styles.css | grep -c -- "--color-accent\|--color-background-surface\|--color-text-gray\|--color-text-green\|--color-background-body\|--radius-element"
```

Expected: **`0`**。

⚠️ 这条 `awk | grep -c` 把**注释行也算进去**——上面 CSS 块里那几条论证注释按名提到了
`--color-accent` / `--color-background-body`（解释为什么不能用它们），会贡献 3 个命中。要数的是
声明不是注释：先剥块注释再数（`awk … | perl -0777 -pe 's{/\*.*?\*/}{}gs' | grep -c …`），剥完是 `0`
才算干净。

⚠️ **全库 `grep -rn "--color-background-surface" src/` 此时仍有命中（`.library-detail-header-poster`
= Task 20、Triage/Settings 各区段 = Tasks 22-27、`theme/scout.css` 的定义本身 = Task 31），那是正常
的，不是漏改。** 只在上面那条 `awk` 区段里清零即可。

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/library/SeriesGrid.test.tsx
git commit -m "refactor(web): 海报墙 token 迁移到新栈 + 落 .library-grid——焦点环/框底避开 --color-accent 撞车"
```

- [ ] **Step 6: 迁 `SeriesGrid.tsx`**

整文件替换成（删 9 行 Astryx import 换 5 行新件；`Grid`/`Heading`/`Text`/`HStack`/`VStack` → 标签+类；
删 `GRID_COLUMNS`）：

```tsx
// web/src/library/SeriesGrid.tsx：海报墙列表页（#/library）——顶部筛选 chip 排 + 结果计数
// （mono）+ 分区海报墙（剧集/动漫/电影/其他）。三态齐（loading/error/empty）+ 筛选后零结果
// 单独一态（区别于"库本身是空的"）。
import { useState } from 'react'
import { Section } from '../components/ui/section.js'
import { Segmented } from '../components/ui/segmented.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useLibrary } from '../api/hooks.js'
import { useT, type TKey } from '../i18n/useT.js'
import { LIBRARY_FILTERS, type LibraryFilter, matchesLibraryFilter, groupBySection } from './filter.js'
import { sectionLabel } from './sectionLabel.js'
import { formatResultCount } from './text.js'
import { PosterCard } from './PosterCard.js'

const FILTER_LABEL_KEY: Record<LibraryFilter, TKey> = {
  all: 'library_filter_all',
  gap: 'library_filter_gap',
  throttled: 'library_filter_throttled',
  full: 'library_filter_full',
}

function SkeletonGrid() {
  return (
    <div aria-busy="true" aria-label="loading library">
      <div className="library-grid">
        {Array.from({ length: 12 }).map((_, i) => (
          <div className="flex flex-col gap-2" key={i}>
            <div className="library-poster-skel-frame">
              <Skeleton index={i} className="h-full w-full rounded-control" />
            </div>
            <Skeleton index={i} className="h-3 w-[70%] rounded-[4px]" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function SeriesGrid() {
  const { data, loading, error, reload } = useLibrary()
  const { t, lang } = useT()
  const [filter, setFilter] = useState<LibraryFilter>('all')

  const visible = (data ?? []).filter((it) => matchesLibraryFilter(it.coverage, filter))
  const sections = groupBySection(visible)

  return (
    <Section>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            items={LIBRARY_FILTERS.map((f) => ({ value: f, label: t(FILTER_LABEL_KEY[f]) }))}
            value={filter}
            onChange={(v) => setFilter(v as LibraryFilter)}
            label="Library filter"
          />
          {data ? (
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">
              {formatResultCount(visible.length, lang)}
            </span>
          ) : null}
        </div>

        {loading && !data ? (
          <SkeletonGrid />
        ) : error && !data ? (
          <EmptyState
            title={t('library_error_prefix') + error}
            actions={
              <Button variant="secondary" onClick={reload}>
                {t('library_retry')}
              </Button>
            }
          />
        ) : data && data.length === 0 ? (
          <EmptyState title={t('library_empty_title')} description={t('library_empty_desc')} />
        ) : visible.length === 0 ? (
          <EmptyState title={t('library_filtered_empty_title')} description={t('library_filtered_empty_desc')} />
        ) : (
          <div className="flex flex-col gap-6">
            {sections.map(({ section, items }) => (
              <div className="flex flex-col gap-3" key={section}>
                <h3 className="m-0 text-[16px] font-semibold leading-6 text-muted-foreground">
                  {sectionLabel(section, t)}
                </h3>
                <div className="library-grid">
                  {items.map((it) => (
                    <PosterCard key={it.id} item={it} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Section>
  )
}
```

（`Segmented` 的 `items` 要 `readonly {value:string;label:string}[]`：`LIBRARY_FILTERS.map` 给出
`{value: LibraryFilter; label: string}[]`，`LibraryFilter` 是字符串联合可赋给 `string`，可变数组可赋给
readonly，TS 通过。`onChange` 是 `(value: string) => void`，`setFilter(v as LibraryFilter)` 照旧。）

- [ ] **Step 7: 迁 `PosterCard.tsx`**

整文件替换成（删 2 行 Astryx import；`AspectRatio` 换新件；3 个 `Text` → `<span>`+类；丢
`hasTruncateTooltip`）：

```tsx
// web/src/library/PosterCard.tsx：一张海报卡——AspectRatio 2/3 海报 + 覆盖角标（灰 mono 数字
// 或全覆盖绿点，不做彩色大 badge）+ 底部标题行。系列可点进详情页；电影没有详情端点（G5 只做
// series/:id），非交互展示。
//
// hover 发丝线抬升（DESIGN.md §2：深色下零 drop-shadow）：卡片壳是原生 <a>/<div> +
// styles.css 里集中的一小段原子 CSS（.library-poster-card 家族），颜色全读 token。
import { AspectRatio } from '../components/ui/aspect-ratio.js'
import type { LibraryItemDTO } from '../api/types.js'
import { posterAngle } from './posterAngle.js'
import { PosterThumb } from './PosterThumb.js'
import { libraryItemHref } from '../shell/route.js'
import { useT } from '../i18n/useT.js'

function PosterBadge({ item }: { item: LibraryItemDTO }) {
  const angle = posterAngle(item.coverage)
  if (angle.kind === 'full') {
    return <span className="library-poster-dot" aria-hidden="true" />
  }
  if (angle.kind === 'gap') {
    return (
      <span className="library-poster-count">
        {/* type="code" size="2xs"：size 只覆盖 fontSize（8px），leading 仍是 code 的 1.5385 —— */}
        <span className="font-mono text-[8px] leading-[1.5385] text-muted-foreground">
          {angle.text}
        </span>
      </span>
    )
  }
  return null
}

function PosterFrame({ item, title }: { item: LibraryItemDTO; title: string }) {
  return (
    <div className="library-poster-frame">
      <AspectRatio ratio={2 / 3} fit="cover">
        <PosterThumb posterPath={item.posterPath} name={title} />
      </AspectRatio>
      <PosterBadge item={item} />
    </div>
  )
}

export function PosterCard({ item }: { item: LibraryItemDTO }) {
  const { t } = useT()
  const title = item.chineseTitle ?? item.name
  const kindLabel = item.kind === 'series' ? t('library_kind_series') : t('library_kind_movie')
  const subline = [item.year ? String(item.year) : null, kindLabel].filter(Boolean).join(' · ')

  const meta = (
    <div className="library-poster-meta">
      {/* hasTruncateTooltip 丢掉：它没配 maxLines，本就是死 prop（Text.tsx:245 tooltipEnabled 恒 false、
          :234 无行夹取），标题今天自由换行。翻译成 truncate 会改成单行截断——那是新增行为。 */}
      <span className="block text-[13px] font-medium leading-5 text-foreground">{title}</span>
      <span className="block text-[11px] leading-4 text-muted-foreground">{subline}</span>
    </div>
  )

  if (item.kind === 'series') {
    return (
      <a className="library-poster-card" href={libraryItemHref(item.id)} aria-label={title}>
        <PosterFrame item={item} title={title} />
        {meta}
      </a>
    )
  }

  return (
    <div className="library-poster-card library-poster-card-static">
      <PosterFrame item={item} title={title} />
      {meta}
    </div>
  )
}
```

（`.library-poster-card-static` 保留原样——它现在 `styles.css` 里没有对应规则、是个空标记类，
但这是本 task 之前就有的现状，纯迁移不动它。）

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesGrid.test.tsx && npx tsc --noEmit
```

Expected: **10 passed** + tsc 无输出。

若 tsc 报 `Property 'label' does not exist`（在 Segmented 或 Button 上）→ 你把新件当 Astryx 的
`label` prop 用了，Segmented 用 `items` 数组、Button 用 children。

- [ ] **Step 8: 追加 DOM 侧迁移锁（会绿）**

在 `SeriesGrid.test.tsx` **文件末尾**追加：

```tsx
// ── DOM 侧迁移锁（Task 19）
describe('SeriesGrid：DOM 侧迁移锁', () => {
  it('渲染后 DOM 里没有任何 astryx-* 类名（Section/Segmented/Skeleton/EmptyState 全换了新件）', async () => {
    const data: LibraryItemDTO[] = [item({ id: 's1', name: 'Series One', section: '剧集' })]
    vi.stubGlobal('fetch', mockFetch(data))
    const { container } = renderGrid()
    await screen.findByText('Series One')
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 分段仍是 radiogroup（既有 :63/:75/:90 靠 role=radio，这里补一条外层 role 的正向锁）。
    expect(screen.getByRole('radiogroup')).toBeInTheDocument()
    // 加载态的海报墙也走 .library-grid 类（不是 Astryx Grid 的行内模板）——骨架那条只锁了 loading 分支。
    expect(container.querySelectorAll('.library-grid').length).toBeGreaterThanOrEqual(1)
  })

  it('海报标题不被截断成单行——hasTruncateTooltip 丢掉、没翻译成 truncate/title（背景四的漂移陷阱）', async () => {
    const data: LibraryItemDTO[] = [item({ id: 's1', name: 'A Very Long Series Title That Would Wrap' })]
    vi.stubGlobal('fetch', mockFetch(data))
    renderGrid()
    const titleEl = await screen.findByText('A Very Long Series Title That Would Wrap')
    // block（display:block）保留，但**不能**有 truncate（那会 overflow:hidden + nowrap + 省略号）。
    expect(titleEl.className.split(/\s+/)).toContain('block')
    expect(titleEl.className).not.toMatch(/\btruncate\b/)
    expect(titleEl).not.toHaveAttribute('title')
  })

  it('骨架屏走 .library-grid + .library-poster-skel-frame（网格类落地、不是 Astryx Grid 的行内模板）', () => {
    // loading 且无 data：mockFetch 永不 resolve 才能停在 loading——这里用一个挂起的 fetch。
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const { container } = renderGrid()
    expect(container.querySelector('.library-grid')).toBeInTheDocument()
    expect(container.querySelectorAll('.library-poster-skel-frame').length).toBe(12)
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesGrid.test.tsx
```

Expected: **13 passed**（6 既有 + Step 3 的 4 + 本步 3）。

- [ ] **Step 9: 收口核对 + tsc**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/ && npx tsc --noEmit
```

Expected: 全绿 + tsc 无输出（`PosterCard`/`PosterThumb` 无独立测试，`SeriesGrid.test.tsx` 覆盖到它们）。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/library/SeriesGrid.tsx src/library/PosterCard.tsx src/library/PosterThumb.tsx || echo "3 files clean"
```

Expected: 打 `3 files clean`。

⚠️ **`grep -rn "astryxdesign" src/library/` 整目录此时仍有命中**（`SeriesPage`/`SeriesHero`/
`FactsRail` = Task 20，`SeasonAccordion`/`SeasonGridBody`/`EpisodeRow` = Task 21），照实、不顺手迁。

- [ ] **Step 10: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/library/SeriesGrid.tsx web/src/library/PosterCard.tsx web/src/library/SeriesGrid.test.tsx
git commit -m "refactor(web): 海报墙列表页 SeriesGrid/PosterCard 卸 Astryx 换新栈"
```

**给 Task 20（SeriesPage / SeriesHero / FactsRail）的备忘：** 海报墙列表页收口，但 `src/library/`
还剩详情页两组（Task 20 头部/hero/facts、Task 21 季手风琴/逐集）。三件要点：① `.library-poster-fallback`
共享基规则本 task 已迁到 `--color-secondary`/`--color-weak`，Task 20 的 `.library-detail-header-poster`
只需迁它**自己**那几条（`var(--radius-inner,4px)`、`var(--color-background-surface)`、`var(--color-border)`）
——注意它的 `--color-background-surface` 也要按背景一的规则迁到 `--color-secondary`，别迁 `--color-accent`；
② `AspectRatio`/`Section`/`EmptyState`/`Button` 新件本 task 已验证可用，直接调；③ 本 task 引入的
`cssDecl` 底座让 `SeriesGrid.test.tsx` 有了 CSS 断言能力，Task 20 若也读 CSS，**照搬那 13 行、不抽公共
模块**（同 Task 17 对 `cssDecl` 的处置，论证要留在现场）。

---

### Task 20: SeriesPage / SeriesHero / FactsRail —— 剧集页头部三件卸 Astryx

Library 详情页的**上半屏**：渐变 hero 头部（`SeriesHero`）+ 跨季覆盖事实栏（`FactsRail`）+ 页面壳
（`SeriesPage`，含三态 + 骨架 + 未找到态）。逐集季手风琴（`SeasonAccordion` / `SeasonGridBody` /
`EpisodeRow`）是**下半屏**，归 Task 21——本 task **不碰**它们，尽管 `SeriesPage` 会把它们当子组件
渲染。所需 primitive 全已落地（同 Task 19），纯调用点迁移 + 两处 CSS token 迁移。

**Files:**
- Modify: `web/src/styles.css`（`.library-detail-header-poster` 2 处 + `.library-hero-scrim` 1 处 token 迁移。**只碰这两条规则**）
- Modify: `web/src/library/SeriesPage.tsx`（删 7 行 Astryx import；`Section`/`Skeleton`/`EmptyState`/`Button` 换新件；`VStack`/`HStack`/`Text` 换标签+类）
- Modify: `web/src/library/SeriesHero.tsx`（删 3 行 Astryx import；`VStack`/`HStack`/`Text` 换标签+类）
- Modify: `web/src/library/FactsRail.tsx`（删 2 行 Astryx import；`HStack` 换 `<div>`+类；3 个 `Text` 换 `<span>`）
- Modify: `web/src/library/SeriesHero.test.tsx`（引入 `cssDecl` 底座；既有 **2** 条不动；追加 CSS 锁 1 个 `describe` 3 条 + DOM 锁 1 条）
- Modify: `web/src/library/FactsRail.test.tsx`（既有 **2** 条不动；追加 DOM 锁 1 条——mono 类 + 无 astryx）
- Modify: `web/src/library/SeriesPage.test.tsx`（既有 **10** 条不动；追加 DOM 锁 1 条——**不加**"全树无 astryx"，见下）
- **不碰**：`PosterThumb.tsx`（Task 19 已确认无 Astryx）、`SeasonAccordion`/`SeasonGridBody`/`EpisodeRow`（Task 21）

⚠️ **`SeriesPage.test.tsx` 的 DOM 锁不能写"全树无 astryx 类名"。** `SeriesPage` 渲染
`SeasonAccordion`（Task 21 才迁），过渡期它仍吐 astryx 类——`container.querySelector('[class*="astryx"]')`
在 `SeriesPage` 全树上**必然非空**。全树无-astryx 锁留到 Task 21 收口时加。本 task 只在**叶子组件**
（`SeriesHero`/`FactsRail`，迁后子树干净）上锁无-astryx。

两个 commit：① CSS 迁移 + `SeriesHero.test` 的 CSS 锁；② 三个组件卸 Astryx + 各自 DOM 锁。

---

#### 背景一：CSS 两处迁移——`.library-detail-header-poster` 又踩 `--color-accent` 撞车

本 task 在 CSS 里只碰两条规则，但其中一条又撞上 Task 19 背景一那个坑。

**`.library-detail-header-poster`（`styles.css:121-129`）**：

| 属性 | 现值 | 新值 | 依据 |
|---|---|---|---|
| `border-radius` | `var(--radius-inner, 4px)` | **`4px`**（字面） | `--radius-inner` 是 scout-only token（`scout.css:168`=4px），Task 31 后消失只剩 4px 兜底；新栈无 4px 圆角 token（只有 control 8 / card 12），所以直接写字面 4px（头部缩略是 72×104 小图，4px 是它专属的一档） |
| `background` | `var(--color-background-surface)` | **`var(--color-secondary)`** | **不是 `--color-accent`**——同 Task 19 背景一：`--color-accent` 被 scout 遮蔽成柠檬绿，过渡期会把头部缩略框刷绿。`--color-secondary` 两栈都 #16181f、scout 不遮蔽 |
| `border` | `1px solid var(--color-border)` | **不动** | 两栈同值 rgba(255,255,255,0.07) |

**`.library-hero-scrim`（`styles.css:154-159`）**：渐变的收尾色

| 属性 | 现值 | 新值 | 依据 |
|---|---|---|---|
| `background` | `linear-gradient(180deg, rgba(11, 12, 15, 0.35) 0%, var(--color-background-body) 82%)` | 同式，`--color-background-body` → `--color-background` | `--color-background-body` 是 scout-only（Task 31 后 undefined，渐变收尾色丢失、hero 底部不再压到页面底色）；`--color-background`=#0b0c0f、scout 不遮蔽、与 `-body` 同值。0% 处的 `rgba(11,12,15,0.35)` 是字面（=#0b0c0f@35%），**留字面不动** |

**不动的**：`.library-hero`（`border-radius:12px`/`padding:20px` 全字面，不读任何 token）、
`.library-hero-backdrop`（inset/background-size/position 全字面）、`.library-hero-body`（position/z-index）、
`.library-detail-header-poster img`（尺寸）、`.library-detail-header-poster .library-poster-fallback`
（只 `font-size:28px`；它继承的底色/字色靠 Task 19 已迁的 `.library-poster-fallback` 基规则，本 task
不重复迁）。`.library-facts-rail` **在 CSS 里没有规则**（已核对 `grep -c` 打 0），FactsRail 的布局全来自
`HStack`——所以本 task **不往 CSS 加 facts-rail 规则**，只在组件层给 `flex flex-wrap gap-4`。

（撞车规则的完整推导见 **Task 19 背景一**——两栈同名 token、scout `@scope` 遮蔽、过渡期渲染 scout 值。
迁任何 background 类 token 前先 `grep -c '<token>' src/theme/scout.css`，打 0 才用。）

#### 背景二：三件的 `Text`/`Heading`/`Stack` 逐处映射

字号/行高走 scout 覆盖后的档（同 Task 19 背景五、Task 8 开头那张表）：`body/label/code`=13px/leading 20
（`leading-5`）、`supporting`=11px/leading 16（`leading-4`）、`large`=16px/leading 24（`leading-6`）。
`Text` 无 `color` prop 时取 `defaultColorByType`（`Text.tsx:164-174`）：`large`/`code`/`body`=primary
（foreground）、`supporting`=secondary（muted-foreground）。`weight="semibold"` 覆盖成 600。

| 文件:行 | 现 Astryx | 换成 |
|---|---|---|
| `SeriesHero.tsx:32` | `<Text type="large" weight="semibold">{name}` | `<span className="text-[16px] font-semibold leading-6 text-foreground">{name}</span>` |
| `SeriesHero.tsx:33` | `<Text type="code" color="secondary">{seriesId}` | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">{seriesId}</span>` |
| `SeriesHero.tsx:35` | `<Text type="supporting" color="secondary">` | `<span className="text-[11px] leading-4 text-muted-foreground">` |
| `SeriesHero.tsx:38` | `<Text type="body" color="secondary">{overview}` | `<span className="text-[13px] leading-5 text-muted-foreground">{overview}</span>` |
| `SeriesPage.tsx:105` | `<Text type="supporting" color="secondary">` | `<span className="text-[11px] leading-4 text-muted-foreground">` |
| `FactsRail.tsx:18-20` | `<Text type="code" color="secondary">` ×3 | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">` ×3 |

Stack 映射（gap{1/2/4/6}=4/8/16/24px，同 Task 18/19 已核对根字号未改；`width="100%"`→`w-full`、
`vAlign="center"`→`items-center`、`wrap="wrap"`→`flex-wrap`）：

| 现 Astryx | 换成 |
|---|---|
| `<VStack gap={6}>` | `<div className="flex flex-col gap-6">` |
| `<VStack gap={2} width="100%">` | `<div className="flex w-full flex-col gap-2">` |
| `<VStack gap={1}>` | `<div className="flex flex-col gap-1">` |
| `<HStack gap={4} aria-busy="true" aria-label="loading series">` | `<div className="flex gap-4" aria-busy="true" aria-label="loading series">` |
| `<HStack gap={4} className="library-hero-body">` | `<div className="flex gap-4 library-hero-body">` |
| `<HStack gap={2} vAlign="center">` | `<div className="flex items-center gap-2">` |
| `<HStack gap={4} wrap="wrap" className="library-facts-rail">` | `<div className="library-facts-rail flex flex-wrap gap-4">` |

primitive 调用（同 Task 19）：`<Section padding={4}>`→`<Section>`；`<EmptyState …>` 零改；
`<Button label={…} …>`→`<Button …>{…}</Button>`；Skeleton 见背景三。

#### 背景三：`HeaderSkeleton` 的三个 Skeleton 映射

`SeriesPage.tsx:33-45` 的 `HeaderSkeleton`。Task 7 的 `skeleton.tsx` 无默认尺寸/圆角，全由 className 给
（Astryx 默认 `width/height='100%'`）：

| 现 Astryx | 换成 | 依据 |
|---|---|---|
| `<Skeleton radius={2} />`（在 `.library-detail-header-poster` 里） | `<Skeleton className="h-full w-full rounded-control" />` | 无 w/h → 默认 100% → `h-full w-full`；radius=2=`--radius-element`=8px→`rounded-control` |
| `<Skeleton height={20} width="40%" radius={1} />` | `<Skeleton className="h-5 w-[40%] rounded-[4px]" />` | 20px=`h-5`；radius=1=4px→`rounded-[4px]` |
| `<Skeleton height={13} width="60%" radius={1} />` | `<Skeleton className="h-[13px] w-[60%] rounded-[4px]" />` | 13px 不在 Tailwind ramp → `h-[13px]` |

---

- [ ] **Step 1: 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesPage.test.tsx src/library/SeriesHero.test.tsx src/library/FactsRail.test.tsx
```

Expected: **SeriesPage 10 passed / SeriesHero 2 passed / FactsRail 2 passed**（共 14）。有红先停下报告。

- [ ] **Step 2: 给 `SeriesHero.test.tsx` 补 `cssDecl` 底座**

`web/src/library/SeriesHero.test.tsx`，在 `:7` 那行 `import { SeriesHero }` 之后插入（同 Task 19 /
Activity 四文件的实现，逐字一致）：

```tsx
// CSS 断言取值同 src/activity 四文件与 Task 19 的 SeriesGrid.test（那里有完整论证）：走
// vitest.config.ts:21 的 define 把 styles.css 编译期替换进来。这一屏读 CSS 是因为
// .library-detail-header-poster 的底色迁移又踩在 --color-accent 跨栈撞车上（Task 19 背景一），
// 只看 DOM 改错了也全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}
```

- [ ] **Step 3: 先写 CSS 锁（会红）**

在 `SeriesHero.test.tsx` **文件末尾**追加：

```tsx
// ── CSS 侧迁移锁（Task 20）
describe('SeriesHero / 详情头部：CSS 侧迁移锁', () => {
  it('头部缩略框底走 --color-secondary（不是 --color-accent：后者过渡期是柠檬绿），圆角字面 4px', () => {
    expect(cssDecl('.library-detail-header-poster', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.library-detail-header-poster', 'border-radius')).toBe('4px')
    // 边框不迁：两栈同值。
    expect(cssDecl('.library-detail-header-poster', 'border')).toBe('1px solid var(--color-border)')
  })

  it('hero scrim 渐变收尾走 --color-background（scout-only 的 --color-background-body 会在 Task 31 后 undefined）', () => {
    const scrim = cssDecl('.library-hero-scrim', 'background')
    expect(scrim).toContain('var(--color-background) 82%')
    // 作用域限定在这条规则内断言旧名绝迹（全库别处仍有 --color-background-body，属 Tasks 22-27）。
    expect(scrim).not.toContain('--color-background-body')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesHero.test.tsx 2>&1 | tail -20
```

Expected: **2 failed / 2 passed**（两条新锁红：background 报旧 `var(--color-background-surface)`、
border-radius 报旧 `var(--radius-inner, 4px)`；scrim 报旧 `--color-background-body`）。

- [ ] **Step 4: 改 `styles.css` 两条规则**

`.library-detail-header-poster` 改成：

```css
.library-detail-header-poster {
  width: 72px;
  height: 104px;
  flex-shrink: 0;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  /* --color-secondary（#16181f），不是 --color-accent：后者被 scout 遮蔽成柠檬绿，过渡期会刷绿。 */
  background: var(--color-secondary);
}
```

`.library-hero-scrim` 改成：

```css
.library-hero-scrim {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(180deg, rgba(11, 12, 15, 0.35) 0%, var(--color-background) 82%);
}
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesHero.test.tsx
```

Expected: **4 passed**（2 既有 + 2 新锁）。

按区段核对旧名在这两条规则里绝迹：

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && awk '/^\.library-detail-header-poster \{/,/^\}/' src/styles.css | grep -c -- "--color-background-surface\|--radius-inner"
```

Expected: **`0`**。（`--color-background-surface` 全库别处仍有命中 = Tasks 22-27 / scout.css 定义本身，正常。）

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/library/SeriesHero.test.tsx
git commit -m "refactor(web): 详情页头部缩略框底 + hero scrim token 迁移（避开 --color-accent 撞车）"
```

- [ ] **Step 6: 迁 `FactsRail.tsx`**

整文件替换成：

```tsx
// web/src/library/FactsRail.tsx：详情页事实栏（详情页重设计 item B）——跨季合计的 mono 技术读数：
// 覆盖计数 + 语言清单 + 内嵌集数。空段（无语言 / 零内嵌）不渲染，不留孤零零的标签。
import { useT } from '../i18n/useT.js'

interface Props {
  covered: number
  total: number
  embedded: number
  langs: string[]
}

export function FactsRail({ covered, total, embedded, langs }: Props) {
  const { t } = useT()
  return (
    <div className="library-facts-rail flex flex-wrap gap-4">
      <span className="font-mono text-[13px] leading-5 text-muted-foreground">
        {t('library_facts_coverage')} {covered} / {total}
      </span>
      {langs.length ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">{langs.join(' · ')}</span>
      ) : null}
      {embedded > 0 ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">
          {embedded} {t('library_facts_embedded_unit')}
        </span>
      ) : null}
    </div>
  )
}
```

（`.library-facts-rail` 标记类保留——CSS 里没有它的规则，但保留以备后续，同 Task 19 对
`library-poster-card-static` 的处置。布局全靠 `flex flex-wrap gap-4`。）

- [ ] **Step 7: 迁 `SeriesHero.tsx`**

整文件替换成：

```tsx
// web/src/library/SeriesHero.tsx：剧集页 hero 头部（详情页重设计 item B）——渐变压暗的 TMDB
// 背景大图 + 海报缩略 + 名/年份/原名 + 剧集简介。无 backdrop 时降级纯排印头部（scrim 层仍在，
// 但不铺灰空图），无 overview 时不渲染简介段。
import { backdropUrl } from '../api/client.js'
import { PosterThumb } from './PosterThumb.js'

interface Props {
  name: string
  originalName: string | null
  year: number | null
  seriesId: string
  posterPath: string | null
  backdropPath: string | null
  overview: string | null
}

export function SeriesHero({ name, originalName, year, seriesId, posterPath, backdropPath, overview }: Props) {
  const bd = backdropUrl(backdropPath)
  return (
    <div className="library-hero">
      {bd ? <div className="library-hero-backdrop" style={{ backgroundImage: `url(${bd})` }} aria-hidden="true" /> : null}
      <div className="library-hero-scrim" />
      <div className="flex gap-4 library-hero-body">
        <div className="library-detail-header-poster">
          <PosterThumb posterPath={posterPath} name={name} />
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[16px] font-semibold leading-6 text-foreground">{name}</span>
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">{seriesId}</span>
          </div>
          <span className="text-[11px] leading-4 text-muted-foreground">
            {[originalName, year ? String(year) : null].filter(Boolean).join(' · ')}
          </span>
          {overview ? (
            <span className="text-[13px] leading-5 text-muted-foreground">{overview}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 8: 迁 `SeriesPage.tsx`**

整文件替换成（删 7 行 Astryx import 换 4 行新件；`VStack`/`HStack`/`Text` → 标签+类）：

```tsx
// web/src/library/SeriesPage.tsx：剧集页（#/library/:id）——渐变 hero 头部（SeriesHero，含 TMDB
// 剧集简介 + 背景大图）+ 跨季覆盖事实栏（FactsRail）+ 每季手风琴（SeasonAccordion，逐集行内展开
// 该集简介，超长季回落格阵）。详情页重设计 item B：移除旧的右侧滑入详情面板（EpisodeDetail）与
// 点格选中态。detail 数据由 Shell 传入（跟 Topbar 面包屑共用同一次 GET /api/v2/library/series/:id，
// 见 shell/AppShell.tsx 顶部注释），这里不自己再发一次请求。
import { Section } from '../components/ui/section.js'
import { Skeleton } from '../components/ui/skeleton.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import type { Async } from '../api/hooks.js'
import type { LibrarySeriesDetailDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { buildGridCells, tallyGridCells } from './episodeState.js'
import { SeriesHero } from './SeriesHero.js'
import { FactsRail } from './FactsRail.js'
import { SeasonAccordion } from './SeasonAccordion.js'

interface Props {
  detail: Async<LibrarySeriesDetailDTO>
}

// 未找到判定（dashboard 审计 #1）：series-detail 端点 404 时后端 body 是 {error:'not found'}
// （router.ts），client.ts 对 4xx 优先取 body.error → 错误串就是 'not found'。SeriesPage 的
// detail 只来自这一个端点（其 4xx 仅 'bad id'/'not found'），故这两种信号唯一对应真 404；
// '… → 404' 是非 JSON body 的兜底形态，一并认。
function isNotFoundError(error: string): boolean {
  return error === 'not found' || error.endsWith('→ 404')
}

function HeaderSkeleton() {
  return (
    <div className="flex gap-4" aria-busy="true" aria-label="loading series">
      <div className="library-detail-header-poster">
        <Skeleton className="h-full w-full rounded-control" />
      </div>
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-5 w-[40%] rounded-[4px]" />
        <Skeleton className="h-[13px] w-[60%] rounded-[4px]" />
      </div>
    </div>
  )
}

export function SeriesPage({ detail }: Props) {
  const { t } = useT()

  if (detail.loading && !detail.data) {
    return (
      <Section>
        <HeaderSkeleton />
      </Section>
    )
  }

  if (detail.error && !detail.data) {
    if (isNotFoundError(detail.error)) {
      return (
        <Section>
          <EmptyState title={t('library_detail_not_found_title')} description={t('library_detail_not_found_desc')} />
        </Section>
      )
    }
    return (
      <Section>
        <EmptyState
          title={t('library_detail_error_prefix') + detail.error}
          actions={
            <Button variant="secondary" onClick={detail.reload}>
              {t('library_retry')}
            </Button>
          }
        />
      </Section>
    )
  }

  if (!detail.data) return null

  const { series, seasons } = detail.data
  const title = series.chineseTitle ?? series.name
  const originalName = series.chineseTitle && series.chineseTitle !== series.name ? series.name : null
  const now = Date.now()
  // 顶部覆盖汇总喂 FactsRail：跨季合计（沿用 buildGridCells/tallyGridCells 同一事实源）。
  const totals = seasons.reduce(
    (acc, s) => {
      const ta = tallyGridCells(buildGridCells(s, now))
      return { covered: acc.covered + ta.covered, total: acc.total + ta.total, embedded: acc.embedded + ta.embedded }
    },
    { covered: 0, total: 0, embedded: 0 },
  )
  const langs = [...new Set(seasons.flatMap((s) => s.coverage.map((c) => c.lang)))].sort()

  return (
    <Section>
      <div className="flex flex-col gap-6">
        <SeriesHero
          name={title}
          originalName={originalName}
          year={series.year}
          seriesId={series.id}
          posterPath={series.posterPath}
          backdropPath={series.backdropPath}
          overview={series.overview}
        />
        {series.layoutNonstandard ? (
          <span className="text-[11px] leading-4 text-muted-foreground">{t('library_detail_layout_nonstandard')}</span>
        ) : null}
        <FactsRail covered={totals.covered} total={totals.total} embedded={totals.embedded} langs={langs} />
        <div className="flex flex-col gap-6">
          {seasons.map((season) => (
            <SeasonAccordion key={season.season} season={season} now={now} defaultOpen={seasons.length === 1} />
          ))}
        </div>
      </div>
    </Section>
  )
}
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesPage.test.tsx src/library/SeriesHero.test.tsx src/library/FactsRail.test.tsx && npx tsc --noEmit
```

Expected: **SeriesPage 10 / SeriesHero 4 / FactsRail 2** 全绿 + tsc 无输出。（`SeriesPage` 的
`.library-eprow-head`/`.ep-dot-covered` 断言仍绿——那些来自 `EpisodeRow`，Task 21 才迁，此刻照常渲染。）

- [ ] **Step 9: 追加 DOM 侧迁移锁**

`SeriesHero.test.tsx` 文件末尾追加：

```tsx
// ── DOM 侧迁移锁（Task 20）
describe('SeriesHero：DOM 侧迁移锁', () => {
  it('hero 子树无 astryx-* 类名，剧名/seriesId 仍在场', () => {
    const { container } = wrap(
      <SeriesHero name="美国恐怖故事" originalName="American Horror Story" year={2011}
        seriesId="tmdb:1413" posterPath={null} backdropPath="/bd.jpg" overview="每季一个独立恐怖故事" />,
    )
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    expect(screen.getByText('美国恐怖故事')).toBeInTheDocument()
    expect(screen.getByText('tmdb:1413')).toBeInTheDocument()
  })
})
```

`FactsRail.test.tsx` 文件末尾追加：

```tsx
// ── DOM 侧迁移锁（Task 20）
describe('FactsRail：DOM 侧迁移锁', () => {
  it('读数走 font-mono、子树无 astryx-* 类名', () => {
    const { container } = render(
      <I18nProvider>
        <FactsRail covered={8} total={8} embedded={8} langs={['zh-Hans', 'en']} />
      </I18nProvider>,
    )
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 三段 mono 读数（覆盖/语言/内嵌）都在场且带 font-mono。
    const monos = container.querySelectorAll('.library-facts-rail > span.font-mono')
    expect(monos.length).toBe(3)
  })
})
```

`SeriesPage.test.tsx` 文件末尾追加（**注意：不查全树 astryx**——`SeasonAccordion` 子组件 Task 21 才迁，
过渡期仍有 astryx 类；这里只锁 `SeriesPage` 自己那层不再用 `Section padding` 之类的 Astryx API 后果）：

```tsx
// ── DOM 侧迁移锁（Task 20）——只锁本组件自己那层；SeasonAccordion 子树的 astryx 归 Task 21 收口。
describe('SeriesPage：DOM 侧迁移锁', () => {
  it('未找到态用新栈 EmptyState（无 astryx），错误态重试按钮是 children 版 Button', async () => {
    const { container, rerender } = render(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: 'not found', reload: vi.fn() }} />
      </I18nProvider>,
    )
    // 未找到态整棵子树只有新栈 EmptyState，没有 SeasonAccordion，可以安全查全树无 astryx。
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    expect(await screen.findByText('Series not found')).toBeInTheDocument()
    // 错误态：Button 用 children 渲染文案（Astryx 是 label prop），可访问名仍是 Retry。
    rerender(
      <I18nProvider>
        <SeriesPage detail={{ data: null, loading: false, error: 'network down', reload: vi.fn() }} />
      </I18nProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeriesPage.test.tsx src/library/SeriesHero.test.tsx src/library/FactsRail.test.tsx
```

Expected: **SeriesPage 11 / SeriesHero 5 / FactsRail 3** 全绿。

- [ ] **Step 10: 收口核对**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/library/SeriesPage.tsx src/library/SeriesHero.tsx src/library/FactsRail.tsx || echo "3 files clean"
```

Expected: 打 `3 files clean`。（`grep -rn "astryxdesign" src/library/` 整目录仍有命中 = Task 21 的三件，正常。）

- [ ] **Step 11: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/library/SeriesPage.tsx web/src/library/SeriesHero.tsx web/src/library/FactsRail.tsx web/src/library/SeriesHero.test.tsx web/src/library/FactsRail.test.tsx web/src/library/SeriesPage.test.tsx
git commit -m "refactor(web): 剧集页头部三件（SeriesPage/SeriesHero/FactsRail）卸 Astryx"
```

**给 Task 21（SeasonAccordion / SeasonGridBody / EpisodeRow）的备忘：** 详情页头部三件收口，`src/library/`
只剩季手风琴那组（Step 10 整目录 grep 会点名）。三件要点：① 那组是 Library 里**几何最重**的一块
（`.library-eprow-*` 逐集行 + `.ep-cell` 格阵 + `.ep-dot-*` 语义点 + 斜体），CSS 段头认领了几何
（同 Task 19 背景三），动手前把每条 CSS 规则**有没有 display** 查一遍；② 迁那组的 background 类
token 时**照样先 `grep -c` 过 scout.css**、撞 `--color-accent` 就走 `--color-secondary`（Task 19/20
的铁律）；③ 那组迁完 `SeriesPage` 全树才干净——**到 Task 21 收口时**给 `SeriesPage.test` 补一条
"渲染完整 detail → 全树无 astryx" 的锁（本 task 因 `SeasonAccordion` 未迁没法加）。`cssDecl` 底座
`SeriesHero.test` 已有，Task 21 若在别的 test 文件读 CSS，照搬那 13 行、不抽公共模块。

---

### Task 21: SeasonAccordion / SeasonGridBody / EpisodeRow —— 季手风琴组卸 Astryx（Library 收口）

Library 详情页的**下半屏**，也是全 `src/library/` 目录的收口：季手风琴（`SeasonAccordion`）+ 超长季
格阵回落（`SeasonGridBody`）+ 逐集行（`EpisodeRow`）。这一组是 Library 里**几何最重**的一块——
`.ep-cell` 格阵 + `.ep-dot-*` 5px 语义点 + `.library-eprow-*` 逐集行 + 一堆语义色。三个组件带 Astryx；
另外两件 `EpisodeCell` / `VerifyChip` **没有 Astryx JSX**（Task 19 已确认），但它们的 CSS 读 Astryx
token，本 task 一并迁（否则 Task 31 卸载后那些格子/芯片会掉色）。

**Files:**
- Modify: `web/src/styles.css`（两段 CSS：F3 区的 `.library-eprow-*`/`.library-season-*`/`.ep-*`（`:166-347`）+ 字幕校验区里**属于本组组件**的 `.library-eprow-verify*`（`:1138-1166`）与 `.library-eprow-inspect`（`:1353-1367`）。约 20 处 token 迁移）
- Modify: `web/src/library/SeasonAccordion.tsx`（删 2 行 Astryx import；`VStack` 换 `<div>`；覆盖句嵌套 `Text` 换嵌套 `<span>`）
- Modify: `web/src/library/SeasonGridBody.tsx`（删 2 行 Astryx import；`VStack` 换 `<div>`；2 个 `Text` 换 `<span>`）
- Modify: `web/src/library/EpisodeRow.tsx`（删 2 行 Astryx import；`VStack` 换 `<div>`；4 个 `Text` 换 `<span>`）
- Modify: `web/src/library/EpisodeRow.test.tsx`（引入 `cssDecl` 底座；既有 **20** 条不动；追加 CSS 锁 1 个 `describe` + DOM 锁 1 条）
- Modify: `web/src/library/SeasonAccordion.test.tsx`（既有 **9** 条不动；追加 DOM 锁 1 条——见背景四的过渡期陷阱）
- Modify: `web/src/library/SeasonGridBody.test.tsx`（既有 **1** 条不动；追加 DOM 锁 1 条）
- **不碰 JSX**：`EpisodeCell.tsx` / `VerifyChip.tsx`（无 Astryx，只在 CSS 侧迁它们读的 token）
- **不碰**：字幕校验区里**不属于本组**的规则（`.vinspect` / `CompareTimeline` 一族 = Task 30 的 InspectPanel/InspectBoundary 地盘）

两个 commit：① CSS 迁移（两段）+ `EpisodeRow.test` 的 CSS 锁；② 三个组件卸 Astryx + 各自 DOM 锁。

---

#### 背景一：token 迁移总表（20 处，值全部逐条核对；新目标名全部经 `grep -c` 确认 scout 不遮蔽）

左值取 `scout.css`，右值取 `@theme`（Plan A `:38-72` + Plan C Task 6 `:117-119`）：

| 语义 | Astryx token（现） | 新栈 token | 值核对 |
|---|---|---|---|
| 主文本 | `--color-text-primary` | `--color-foreground` | 两侧 #e6e8ec ✓ |
| 次文本 | `--color-text-secondary` | `--color-muted-foreground` | 两侧 #9aa1ac ✓ |
| 弱文本 | `--color-text-gray` | `--color-weak` | 两侧 #6b7280 ✓ |
| 禁用文本 | `--color-text-disabled` | `--color-faint` | 两侧 #4b5563 ✓ |
| 覆盖绿 | `--color-text-green` | `--color-fn-green` | 两侧 #28bf5c ✓ |
| 错误红 | `--color-text-red` | `--color-fn-red` | 两侧 #e11d48 ✓ |
| 卡片底 | `--color-background-card` | `--color-card` | 两侧 #111318 ✓ |
| 面底 | `--color-background-surface` | `--color-secondary` | 两侧 #16181f ✓（**不是 --color-accent**，背景二） |
| 圆角 4px | `var(--radius-inner, 4px)` | 字面 `4px` | scout `--radius-inner`=4px；新栈无 4px token |
| mono 字族 | `var(--font-code, ui-monospace)` | `var(--font-mono)` | `--font-code` 无处定义（Astryx 基础 token，Task 31 后 undefined 落 ui-monospace 兜底）；`--font-mono`=`ui-monospace, SFMono-Regular, Menlo, monospace`（@theme `:72`） |
| **可见强调** | `--color-accent`（3 处） | `--color-ring` | **有意改色**：lime #96DA26 → 紫 #8b7cf6（背景二） |
| **半覆盖橙** | `--color-text-orange` | `--color-fn-amber` | **有意改值**：#e8a33d → #f2c00b（背景三） |

（新目标名 `--color-foreground`/`--color-muted-foreground`/`--color-weak`/`--color-faint`/
`--color-fn-green`/`--color-fn-red`/`--color-card`/`--color-secondary`/`--color-ring`/`--color-fn-amber`/
`--font-mono` 已逐个 `grep -c … src/theme/scout.css` = 0，**scout 都不遮蔽**，过渡期与终值一致。唯一
被遮蔽的是 `--color-accent`——所以它专门走背景二。）

`color-mix` 内部的两处也跟着换名（值不变）：`.ep-cell-hardsub .ep-num` / `.ep-dot-hardsub` 的
`color-mix(... --color-text-green 55%, --color-text-gray 45%)` → `color-mix(... --color-fn-green 55%,
--color-weak 45%)`；`.ep-dot-partial` 的 `linear-gradient(... --color-text-green 50%, --color-text-gray
50%)` → 同式换名。

**不迁的**：一切字面值（`.ep-cell:hover` 的 `rgba(255,255,255,0.14)`、`.ep-num` 的
`font-family:'Geist Mono',…` 字面栈、各种像素/圆角字面）、`var(--color-border)`（两栈同值，Task 19
已确认）。

#### 背景二：又是 `--color-accent` 撞车——但这次是**三处可见强调**，不是面底

本区段有 **3 处** `var(--color-accent)`（`awk` 已核对：`:199`/`:271`/`:275`），全部是**可见强调**用途：

- `.library-eprow-active > .library-eprow-head { border-left-color: var(--color-accent) }`（展开行的左强调条）
- `.ep-cell:focus-visible { outline: 2px solid var(--color-accent) }`（格子焦点环）
- `.ep-cell-selected { border-color: var(--color-accent) }`（选中格边框）

scout 里 `--color-accent` = 柠檬绿 #96DA26，这三处今天都是**看得见的绿强调**。而 `@theme` 的
`--color-accent` = #16181f（深面）——Task 31 卸 scout 后，这三处会变成深灰，跟各自的背景（卡底
#111318 / 面底 #16181f）几乎同色，**三个可见强调一起隐形**。这和 Task 19 的海报焦点环是同一个坑
（完整推导见 **Task 19 背景一**）。

**裁决：三处全迁 `--color-ring`（#8b7cf6 紫）。** scout 当年用它自己的 lime `--color-accent` 统一表达
了"焦点 / 选中 / 活跃"三种强调；新栈的统一强调色是 `--color-ring`（`button`/`input`/`select`/Task 8
`segmented` 的焦点环、Task 19 的海报焦点环都是它）。三处一起迁到 `--color-ring`，强调语义仍然统一，
只是从 lime 变紫。

#### 背景三：`.ep-cell-partial .ep-num` 橙 → 琥珀，是**有意的值变更**

唯一一处 `--color-text-orange`（半覆盖集的集号颜色，`:306`）。新栈调色板（spec §5.1）**没有橙色档**
——功能色只有 green / red / amber / purple（`@theme` + Task 6）。最接近的暖色是
`--color-fn-amber`（#f2c00b，Task 6 逐字取自 Astryx 暗色 `--color-warning`）。所以半覆盖集号从
#e8a33d（偏橙褐）变成 #f2c00b（偏金黄）。**这是有意的**：新栈只保留一个暖色档，半覆盖沿用它，不为
一处集号现造第五种功能色。屏上可见但极小（只有半覆盖集的两位数字），且 `.ep-dot-partial` 那个
左绿右灰的分体点本身不受影响（它不用橙）。

#### 背景四：CSS 分居两段 + 过渡期 InspectPanel 仍是 Astryx——两条边界

**边界①（物理分段）**：本组组件的 CSS 分居两处。`.library-eprow-*` 主体 / `.library-season-*` /
`.ep-*` 在 F3 区（`:166-347`）；而 `.library-eprow-verify*`（`VerifyChip` 渲染）与 `.library-eprow-inspect`
（`EpisodeRow` 展开区的检视入口按钮渲染）物理上落在**字幕校验区**（`:1138-1166` / `:1353-1367`）。
判据是"**哪个组件渲染这个类**"，不是"这条规则物理在哪一段"——这两处由本组组件渲染，归本 task；
同一段里的 `.vinspect` / 对照时间轴（`CompareTimeline`，`InspectPanel` 的内容）归 **Task 30**（那两个
`.tsx` 在 Plan C 文件结构表 `:80` 里明确划给 Task 30 的掉队件）。这样本组组件在过渡期和 Task 31 后
都渲染正确，不依赖 Task 30 的次序。

**边界②（过渡期 Astryx 子树）**：`SeasonAccordion` 在**点开红芯片**时才渲染 `InspectPanel` /
`InspectBoundary`（`src/subtitleVerify/`，Task 30 才迁，过渡期仍是 Astryx）。所以：

- `SeasonAccordion.test` 里凡是**点开面板**的用例（`:167`/`:191`/`:207`），其子树含 Astryx，**不能**
  加"全树无 astryx"锁。本 task 的 `SeasonAccordion` 无-astryx 锁只加在**不开面板**的渲染上
  （默认展开、芯片渲染但未点开）——那时子树只有 `EpisodeRow`（本 task 迁完）+ `VerifyChip`（无
  Astryx），是干净的。
- 同理 `SeriesPage`（Task 20）的"全树含面板无 astryx"锁仍要等 Task 30；但**不开面板**时
  `SeriesPage` 子树本 task 之后已全干净（它的 `SeasonAccordion` 子树干净了）。

#### 背景五：几何全保留；`EpisodeCell`/`VerifyChip` 只在 CSS 侧动

这一段 CSS 段头（`:247` `A 式格阵` / `:165` `逐集行`）认领几何（同 Task 19 背景三，与 Activity 段
"只管 padding 与 ink"相反），所以 `.ep-grid` 的 `grid-template-columns: repeat(auto-fill, 28px)`、
`.ep-cell` 的 flex 居中、`.ep-dot` 的绝对定位这些**几何一律原样保留**，本 task 只换颜色/圆角/字族
token，不动任何 `display`/`position`/`grid-*`/`flex`/尺寸。

`EpisodeCell.tsx` / `VerifyChip.tsx` 的 JSX **一个字不改**（它们没有 Astryx，视觉全靠 `.ep-cell`/
`.ep-dot`/`.library-eprow-verify*` 这些原子类）——但那些类读的 token 在本 task 的 CSS 迁移里换掉了，
所以这两个组件的**呈现**会跟着更新，无需碰它们的代码。

#### 背景六：`Text`/`Stack` 逐处映射（字号/行高同 Task 19/20；default color 见 `Text.tsx:164`）

`SeasonAccordion` 覆盖句是**嵌套** `Text`（外层 body + 内层 emphasis/clause 用 `as="span"`）。内层无
`type` → 默认 `type="body"`（`Text.tsx:204`），`size="lg"` 只覆盖字号（16px）、leading 仍是 body 的
1.5385 → 写无单位 `leading-[1.5385]`。`display` 默认 `inline` → 全是 `<span>`。

| 文件:行 | 现 Astryx | 换成 |
|---|---|---|
| `SeasonAccordion.tsx:85`（外层句） | `<Text type="body" color="secondary">` | `<span className="text-[13px] leading-5 text-muted-foreground">` |
| `SeasonAccordion.tsx:86`（嵌句大数字） | `<Text as="span" weight="semibold" color="primary" size="lg">` | `<span className="text-[16px] font-semibold leading-[1.5385] text-foreground">` |
| `SeasonAccordion.tsx:87`（clause） | `<Text as="span" color="secondary">` | `<span className="text-muted-foreground">`（内联，字号/行高从外层句继承 13/leading-5，颜色与外层同 secondary） |
| `SeasonAccordion.tsx:90` | `<Text type="code" color="secondary">` | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">` |
| `SeasonGridBody.tsx:29` | `<Text type="supporting" color="secondary">` | `<span className="text-[11px] leading-4 text-muted-foreground">` |
| `SeasonGridBody.tsx:30` | `<Text type="body" color="secondary">` | `<span className="text-[13px] leading-5 text-muted-foreground">` |
| `EpisodeRow.tsx:49` | `<Text type="code" color="secondary">{epLabel}` | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">` |
| `EpisodeRow.tsx:50` | `<Text type="label" color="primary">{title}` | `<span className="text-[13px] font-medium leading-5 text-foreground">` |
| `EpisodeRow.tsx:54` | `<Text type="code" color="secondary">{airDate}` | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">` |
| `EpisodeRow.tsx:60` | `<Text type="body" color="secondary">{overview}` | `<span className="text-[13px] leading-5 text-muted-foreground">` |

Stack（gap{1/2}=4/8px）：`<VStack gap={2}>`→`<div className="flex flex-col gap-2">`；`<VStack gap={1}
className="library-eprow-body" style={{paddingLeft:10}}>`→`<div className="library-eprow-body flex
flex-col gap-1" style={{paddingLeft:10}}>`；`<VStack gap={1} className="library-eprow-body">`→
`<div className="library-eprow-body flex flex-col gap-1">`。

---

- [ ] **Step 1: 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeasonAccordion.test.tsx src/library/SeasonGridBody.test.tsx src/library/EpisodeRow.test.tsx
```

Expected: **SeasonAccordion 9 / SeasonGridBody 1 / EpisodeRow 20**（共 30）。有红先停下报告。

- [ ] **Step 2: 给 `EpisodeRow.test.tsx` 补 `cssDecl` 底座**

`web/src/library/EpisodeRow.test.tsx`，在文件顶部 import 块之后插入（同 Task 19/20 逐字一致）：

```tsx
// CSS 断言取值同 Task 19/20 与 src/activity 四文件：走 vitest.config.ts:21 的 define 编译期替换。
// 这一屏读 CSS 是因为 3 处 --color-accent（活跃行左条/格子焦点环/选中格边框）和 .ep-cell 面底
// 都踩在跨栈撞车上（Task 19 背景一 / 本 task 背景二），只看 DOM 改错了也全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}
```

- [ ] **Step 3: 先写 CSS 锁（会红）**

在 `EpisodeRow.test.tsx` **文件末尾**追加：

```tsx
// ── CSS 侧迁移锁（Task 21）——三处可见强调避开 --color-accent 撞车 + 面底/圆角/绿点/橙→琥珀
describe('EpisodeRow / 季手风琴组：CSS 侧迁移锁', () => {
  it('三处可见强调走 --color-ring（不是 --color-accent：后者过渡期柠檬绿、卸载后与背景同色 → 隐形）', () => {
    expect(cssDecl('.ep-cell:focus-visible', 'outline')).toBe('2px solid var(--color-ring)')
    expect(cssDecl('.ep-cell-selected', 'border-color')).toBe('var(--color-ring)')
    // 活跃行左条：选择器含 `>`，用整串 includes 断言更稳。
    expect(CSS).toContain('border-left-color: var(--color-ring)')
    expect(CSS).not.toContain('border-left-color: var(--color-accent)')
  })

  it('格子面底走 --color-secondary（不是 --color-accent），圆角字面 4px', () => {
    expect(cssDecl('.ep-cell', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.ep-cell', 'border-radius')).toBe('4px')
  })

  it('语义色迁到新栈：绿点 --color-fn-green、半覆盖集号橙→琥珀 --color-fn-amber（有意改值）', () => {
    expect(cssDecl('.ep-dot-covered', 'background')).toBe('var(--color-fn-green)')
    // 半覆盖集号：新栈无橙档，沿用唯一暖色 --color-fn-amber（#f2c00b）。
    expect(CSS).toContain('var(--color-fn-amber)')
    expect(CSS).not.toContain('var(--color-text-orange)')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/EpisodeRow.test.tsx 2>&1 | tail -25
```

Expected: **3 failed / 20 passed**（三条新锁红，报旧值 `var(--color-accent)` / `var(--color-background-surface)` /
`var(--radius-inner, 4px)` / `var(--color-text-green)` / 缺 `--color-fn-amber`）。

- [ ] **Step 4: 改 `styles.css` 第一段（`:166-347` 全段替换）**

把 `.library-eprow` 到 `.ep-cell-dashed-swatch` 那一整段（`:166-347`）替换成：

```css
.library-eprow {
  border-top: 1px solid var(--color-border);
}
/* 2026-07-30（字幕校验）：.library-eprow-head 从 button 变成 div——校验芯片需要独立可点，
   button 套 button 是非法 HTML。容器保留 flex/padding/左边框/hover 底色（视觉不变），
   把"可点击展开"的那部分职责交给内部的 .library-eprow-toggle。 */
.library-eprow-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 4px 9px 10px;
  border-left: 2px solid transparent;
}
.library-eprow-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  padding: 0;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.library-eprow-head:hover {
  background: var(--color-card);
}
.library-eprow-active > .library-eprow-head {
  /* --color-ring（紫），不是 --color-accent：后者被 scout 遮蔽成柠檬绿，过渡期是绿、卸载后变
     #16181f 与卡底同色 → 左强调条隐形。三处可见强调（本条 + 焦点环 + 选中格）统一走 --color-ring。 */
  border-left-color: var(--color-ring);
  background: var(--color-card);
}
.library-eprow-spacer {
  flex: 1;
}
.library-eprow-still {
  width: 112px;
  height: 63px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--color-border);
}
.library-eprow-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--color-muted-foreground);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 0 5px;
}
.library-eprow-body {
  padding: 2px 10px 12px 40px;
}

/* ---- 季手风琴（SeasonAccordion，详情页重设计 item B）——季头卷起汇总 + 展开箭头。 ---- */
.library-season-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 11px 2px;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.library-season-chev {
  color: var(--color-weak);
  transition: transform 0.18s ease;
  display: inline-block;
}
.library-season-chev.open {
  transform: rotate(90deg);
}

/* ---- A 式格阵（EpisodeCell）---- */
.ep-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 28px);
  gap: 4px;
}
.ep-cell {
  position: relative;
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  /* --color-secondary（#16181f），不是 --color-accent（后者过渡期柠檬绿）。 */
  background: var(--color-secondary);
  cursor: pointer;
  font: inherit;
}
.ep-cell:hover {
  border-color: rgba(255, 255, 255, 0.14);
}
.ep-cell:focus-visible {
  /* --color-ring：见 .library-eprow-active 注释（三处可见强调统一）。 */
  outline: 2px solid var(--color-ring);
  outline-offset: 1px;
}
.ep-cell-selected {
  border-color: var(--color-ring);
}
.ep-cell-dashed {
  background: transparent;
  border-style: dashed;
}
.ep-cell-error {
  background: color-mix(in srgb, var(--color-fn-red) 6%, transparent);
}
.ep-num {
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 9.5px;
  color: var(--color-muted-foreground);
}
.ep-cell-dashed .ep-num {
  color: var(--color-faint);
}
.ep-cell-throttled .ep-num {
  font-style: italic;
  color: var(--color-weak);
}
.ep-cell-hardsub .ep-num {
  /* 救援R5：硬字幕假定——灰绿间调（已覆盖但非外挂确认），color-mix 混两个既有合法 token，
     不占用/不冒充 --color-fn-green。 */
  color: color-mix(in srgb, var(--color-fn-green) 55%, var(--color-weak) 45%);
}
.ep-cell-error .ep-num {
  color: var(--color-fn-red);
}
.ep-cell-partial .ep-num {
  /* 半覆盖：新栈无橙档，沿用唯一暖色 --color-fn-amber（#f2c00b，有意改值自旧 --color-text-orange #e8a33d）。 */
  color: var(--color-fn-amber);
}

/* 5px 语义点——左上角，跟 mono 集号并排读。 */
.ep-dot {
  position: absolute;
  left: 3px;
  top: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.ep-dot-covered {
  background: var(--color-fn-green);
}
.ep-dot-hardsub {
  background: color-mix(in srgb, var(--color-fn-green) 55%, var(--color-weak) 45%);
}
.ep-dot-partial {
  background: linear-gradient(90deg, var(--color-fn-green) 50%, var(--color-weak) 50%);
}
.ep-dot-missing {
  background: transparent;
  border: 1px solid var(--color-weak);
  width: 4px;
  height: 4px;
}
.ep-dot-throttled {
  background: var(--color-weak);
}
.ep-dot-error {
  background: var(--color-fn-red);
}
.ep-cell-dashed-swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  border: 1px dashed var(--color-faint);
}
```

- [ ] **Step 5: 改 `styles.css` 第二段（字幕校验区里本组的两处）**

`.library-eprow-verify` 一族（`:1138-1166`）改成：

```css
.library-eprow-verify {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  border-radius: 4px;
}
```

（`.library-eprow-verify-ok` 的 `background: var(--color-text-green)` → `var(--color-fn-green)`；
`.library-eprow-verify-shifted` 的 `color: var(--color-text-red)` → `var(--color-fn-red)`、
`border: 1px solid color-mix(in srgb, var(--color-text-red) 40%, transparent)` → 同式换
`var(--color-fn-red)`；`.library-eprow-verify-shifted:hover:not(:disabled)` 的
`border-color: var(--color-text-red)` → `var(--color-fn-red)`。逐条：）

```css
.library-eprow-verify-ok {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-fn-green);
}
.library-eprow-verify-shifted {
  color: var(--color-fn-red);
  border: 1px solid color-mix(in srgb, var(--color-fn-red) 40%, transparent);
  background: transparent;
  padding: 0 5px;
  cursor: pointer;
}
.library-eprow-verify-shifted:hover:not(:disabled) {
  border-color: var(--color-fn-red);
}
```

`.library-eprow-inspect` 一族（`:1353-1367`）改成：

```css
.library-eprow-inspect {
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--color-muted-foreground);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}
.library-eprow-inspect:hover {
  color: var(--color-foreground);
  border-color: var(--color-weak);
}
```

（其余 `.library-eprow-verify-shifted:disabled` 只有 `cursor:default`，不动。）

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/EpisodeRow.test.tsx
```

Expected: **23 passed**（20 既有 + 3 新锁）。

按区段核对旧 token 在本组 CSS 里绝迹：

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && awk '/^\.library-eprow \{/,/^\.ep-cell-dashed-swatch/' src/styles.css | grep -c -- "--color-accent\|--color-background-surface\|--color-background-card\|--color-text-\|--radius-inner\|--font-code"
```

Expected: **`0`**。（全库别处仍有 `--color-text-*` = Tasks 22-27 / scout 定义本身，正常。）

- [ ] **Step 6: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/library/EpisodeRow.test.tsx
git commit -m "refactor(web): 季手风琴组 CSS token 迁移（3 处可见强调避 --color-accent、橙→琥珀）"
```

- [ ] **Step 7: 迁 `EpisodeRow.tsx`**

删 `:10-11` 两行 Astryx import（`Text` / `VStack`），`:49`/`:50`/`:54` 三个 `Text` 换 `<span>`，`:59`
的 `VStack` 换 `<div>`、`:60` 的 `Text` 换 `<span>`。替换后的 `EpisodeRow` 函数体：

```tsx
  return (
    <div className={`library-eprow${expanded ? ' library-eprow-active' : ''}`}>
      <div className="library-eprow-head">
        <button type="button" className="library-eprow-toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className={`ep-dot ${DOT_CLASS[cell.state] ?? 'ep-dot-missing'}`} aria-hidden="true" />
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">{epLabel}</span>
          <span className="text-[13px] font-medium leading-5 text-foreground">{cell.title ?? epLabel}</span>
          {isEmbedded ? <span className="library-eprow-tag">{t('library_detail_embedded_short')}</span> : null}
          <span className="library-eprow-spacer" />
          {still ? <img className="library-eprow-still" src={still} alt="" loading="lazy" /> : null}
          {cell.airDate ? <span className="font-mono text-[13px] leading-5 text-muted-foreground">{cell.airDate}</span> : null}
        </button>
        {verify ? <VerifyChip state={verify.state} checked={verify.checked} onInspect={onInspect} /> : null}
      </div>
      {expanded ? (
        <div className="library-eprow-body flex flex-col gap-1">
          <span className="text-[13px] leading-5 text-muted-foreground">{cell.overview ?? t('library_episode_no_overview')}</span>
          {onInspect ? (
            <button type="button" className="library-eprow-inspect" onClick={onInspect}>
              {t('library_verify_inspect')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
```

（顶部 import 只删两行 Astryx；`VerifyChip` / `stillUrl` / `useT` / 类型 import 全留。`DOT_CLASS` 常量
与 `:61-69` 那段时间轴入口的长注释一字不动。）

- [ ] **Step 8: 迁 `SeasonGridBody.tsx`**

整文件替换成：

```tsx
// web/src/library/SeasonGridBody.tsx：超长季（>50 集，见 EPISODE_ROW_CAP）紧凑格阵回落（详情页
// 重设计 item B）——复用 A 式 EpisodeCell 格阵，点某格在格阵下方行内展开该集简介（不逐集铺行，
// 适配国产长剧上百集）。同一时刻至多一格选中，再点同格收起。
import { useState } from 'react'
import type { GridCell } from './episodeState.js'
import { EpisodeCell } from './EpisodeCell.js'
import { useT } from '../i18n/useT.js'

export function SeasonGridBody({ cells }: { cells: GridCell[] }) {
  const { t } = useT()
  const [sel, setSel] = useState<number | null>(null)
  const active = cells.find((c) => c.episode === sel) ?? null
  return (
    <div className="flex flex-col gap-2">
      <div className="ep-grid">
        {cells.map((cell) => (
          <EpisodeCell
            key={cell.episode}
            cell={cell}
            isSelected={cell.episode === sel}
            onSelect={() => setSel((p) => (p === cell.episode ? null : cell.episode))}
          />
        ))}
      </div>
      {active ? (
        <div className="library-eprow-body flex flex-col gap-1" style={{ paddingLeft: 10 }}>
          <span className="text-[11px] leading-4 text-muted-foreground">{`S·E${String(active.episode).padStart(2, '0')}`} {active.title ?? ''}</span>
          <span className="text-[13px] leading-5 text-muted-foreground">{active.overview ?? t('library_episode_no_overview')}</span>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 9: 迁 `SeasonAccordion.tsx`**

删 `:10-11` 两行 Astryx import（`VStack` / `Text`）。`:82` 的 `<VStack gap={2}>` 换 `<div className="flex
flex-col gap-2">`、`:132` 的 `</VStack>` 换 `</div>`。`:85-88` 的覆盖句嵌套 `Text` 换成嵌套 `<span>`，
`:90` 的 `Text` 换 `<span>`。替换后的 return（其余逻辑/hook/InspectBoundary 一字不动）：

```tsx
  return (
    <div className="flex flex-col gap-2">
      <button type="button" className="library-season-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`library-season-chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
        <span className="text-[13px] leading-5 text-muted-foreground">
          {sentence.prefix} <span className="text-[16px] font-semibold leading-[1.5385] text-foreground">{sentence.emphasis}</span> {sentence.suffix}
          {sentence.clause ? <span className="text-muted-foreground"> — {sentence.clause}</span> : null}
        </span>
      </button>
      {isCanonicalPending(season) ? <span className="font-mono text-[13px] leading-5 text-muted-foreground">{t('library_detail_canonical_pending')}</span> : null}
      {open ? (
        useGrid ? <SeasonGridBody cells={cells} /> : (
          <div>
            {cells.map((cell) => {
              const itemId = cell.onDisk?.itemId
              return (
                <EpisodeRow
                  key={cell.episode}
                  cell={cell}
                  expanded={expandedEp === cell.episode}
                  onToggle={() => setExpandedEp((p) => (p === cell.episode ? null : cell.episode))}
                  verify={itemId === undefined ? undefined : verifyByItem.get(itemId)}
                  onInspect={itemId === undefined ? undefined : () => setInspecting(itemId)}
                />
              )
            })}
          </div>
        )
      ) : null}
      {inspecting !== null ? (
        <InspectBoundary
          key={inspecting}
          title={inspectTitle}
          onClose={() => setInspecting(null)}
        >
          <InspectPanel
            isOpen
            onOpenChange={(o) => { if (!o) setInspecting(null) }}
            title={inspectTitle}
            data={compare.data}
            loading={compare.loading}
            error={compare.error}
            onCorrect={onCorrect}
            correcting={correcting}
          />
        </InspectBoundary>
      ) : null}
    </div>
  )
```

（`:111-114` 的错误边界长注释一字不动。`InspectBoundary`/`InspectPanel` 仍是 Astryx（Task 30 才迁），
本 task 只碰 `SeasonAccordion` 自己的 JSX。）

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeasonAccordion.test.tsx src/library/SeasonGridBody.test.tsx src/library/EpisodeRow.test.tsx && npx tsc --noEmit
```

Expected: **SeasonAccordion 9 / SeasonGridBody 1 / EpisodeRow 23** 全绿 + tsc 无输出。

- [ ] **Step 10: 追加 DOM 侧迁移锁**

`SeasonGridBody.test.tsx` 末尾追加：

```tsx
// ── DOM 侧迁移锁（Task 21）
describe('SeasonGridBody：DOM 侧迁移锁', () => {
  it('子树无 astryx-* 类名；展开区简介仍在场', () => {
    const cells: GridCell[] = Array.from({ length: 3 }, (_, i) => ({
      episode: i + 1, state: 'covered', title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null, onDisk: null,
    }))
    const { container } = render(<I18nProvider><SeasonGridBody cells={cells} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    expect(screen.getByText('ov2')).toBeInTheDocument()
  })
})
```

`EpisodeRow.test.tsx` 末尾追加（`renderRow` / fixture 沿用该文件既有 helper；若无同名 helper 则内联
一份最小 `cell`）：

```tsx
// ── DOM 侧迁移锁（Task 21）
describe('EpisodeRow：DOM 侧迁移锁', () => {
  it('子树无 astryx-* 类名；集号 mono、标题在场', () => {
    const cell: GridCell = {
      episode: 1, state: 'covered', title: 'Pilot', overview: 'ov', airDate: '2011-10-05', stillPath: null,
      onDisk: { itemId: 'ep1', episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] },
    }
    const { container } = render(
      <I18nProvider><EpisodeRow cell={cell} expanded={false} onToggle={() => {}} /></I18nProvider>,
    )
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 集号走 font-mono（type="code" 迁移后的证据）。
    expect(container.querySelector('span.font-mono')).toBeTruthy()
    expect(screen.getByText('Pilot')).toBeInTheDocument()
  })
})
```

`SeasonAccordion.test.tsx` 末尾追加（**不开面板**——背景四②：开面板会渲染 Astryx 的 InspectPanel）：

```tsx
// ── DOM 侧迁移锁（Task 21）——只在不开面板的渲染上锁；点开红芯片会渲染 Astryx 的 InspectPanel（Task 30）。
describe('SeasonAccordion：DOM 侧迁移锁', () => {
  it('默认展开、不点开面板 → 子树无 astryx-* 类名（EpisodeRow + VerifyChip 均已在新栈）', async () => {
    stubVerify([
      { itemId: 'ep1', state: 'ok', checked: true },
      { itemId: 'ep2', state: 'shifted', checked: true },
      { itemId: 'ep3', state: 'ok', checked: true },
    ])
    const { container } = render(
      <I18nProvider initialLang="zh"><SeasonAccordion season={seasonDTO(3)} now={NOW} defaultOpen /></I18nProvider>,
    )
    // 等芯片渲染出来（验证请求回来），确认没点开面板时子树干净。
    await screen.findByTestId('verify-chip-shifted')
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })
})
```

（这条锁放进 `SeasonAccordion：字幕校验接线` 那个 `describe` 也行——它需要 `stubVerify` 与 `NOW`/
`seasonDTO`，都在该文件既有作用域里；`ResizeObserver` 桩由那个 describe 的 `beforeEach` 提供。若放到
文件级新 describe，记得它不在 `beforeEach` 作用域内——但本用例不点开面板、不渲染 CompareTimeline，
不需要 `ResizeObserver`。为省事直接把这条 `it` 加进既有的 `字幕校验接线` describe 末尾。）

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/SeasonAccordion.test.tsx src/library/SeasonGridBody.test.tsx src/library/EpisodeRow.test.tsx
```

Expected: **SeasonAccordion 10 / SeasonGridBody 2 / EpisodeRow 24** 全绿。

- [ ] **Step 11: Library 收口核对**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/library/ && npx tsc --noEmit
```

Expected: 全绿 + tsc 无输出。

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/library/ || echo "library/ clean"
```

Expected: 打 **`library/ clean`**——**这是整个 `src/library/` 目录的收口**（11 个组件全在新栈）。若还有
命中，照实报告文件名。

- [ ] **Step 12: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/library/SeasonAccordion.tsx web/src/library/SeasonGridBody.tsx web/src/library/EpisodeRow.tsx web/src/library/SeasonAccordion.test.tsx web/src/library/SeasonGridBody.test.tsx
git commit -m "refactor(web): 季手风琴组卸 Astryx——src/library 目录收口"
```

**给 Task 22（Triage 双箱）的备忘：** `src/library/` 全清。剩余 Astryx 按目录分：`src/triage`（22-24）、
`src/settings`（25-27）、`src/shell`（28-29）、掉队件 `auth`/`subtitleVerify`/`workflow/RerunDialog`/
`RunDetail`/`SetupWizard`（30）。三条通用铁律本组已全部实践、Triage 照搬：① 迁 background/强调类
token 前先 `grep -c '<token>' src/theme/scout.css`，撞 `--color-accent` 就分辨"面底→`--color-secondary`
/ 可见强调→`--color-ring`"（背景二）；② 语义色映射表见背景一（text-primary→foreground、
text-secondary→muted-foreground、text-gray→weak、text-disabled→faint、text-green→fn-green、
text-red→fn-red、background-card→card、text-orange→fn-amber 有意改值、font-code→font-mono）；
③ 子组件仍带 Astryx 时不能加"全树无 astryx"锁（背景四②）。`cssDecl` 底座 `EpisodeRow.test` 已有，
Triage 若读 CSS 照搬那 13 行、不抽公共模块。

---

### Task 22: TriagePage 页壳 + Pending 区重设计（卸 Astryx + 目录组上 Task 折叠件）

Triage（甄别）是四屏里**唯一被 spec 升级、不是纯换皮**的一屏——§5.5 把它从"两箱"升级成"四区收件箱"
（Pending / Excluded / Timing looks off / Dormant，后两区是新增，消费 §4 的两个只读 GET）。本 task 是
Triage 三件（22-24，plan 硬绑定，见 `:970/:3137/:3144/:3197/:3266/:3463` 六处交叉引用）的第一件：

- **页壳**：加页头 h1 `"Triage"` + 副标题（§5.5 新拟句），迁 `TriagePage` 自身的 Astryx（loading 的
  `Text`、error 的 `EmptyState`+`Button`）；
- **Pending 区**：`PendingBox` 的目录组卡重设计到 AI Elements 的 `Task` 折叠件（组头三段信息：mono 目录名
  + 文件计数 + "首末行" First seen…/last attempt…），文件行 mono + >5 折叠 `"+N more"`（既有阈
  `FILES_COLLAPSE_AT=5`），命名指引照旧；
- **本区 CSS** 的 token 迁移。

**范围边界（按现状 vs 蓝本的取舍）**：`TriagePage` 现在是**两箱并排**（`.triage-boxes` = `1.2fr 1fr`，
Pending | Excluded）。四区重排（单列收件箱）与 Excluded/Timing/Dormant 三区留给 **Task 23-24**——本 task
**保留两箱布局**，只把 Pending 区落到位、把页壳搭好。这样每一步都可测、旧测试可增量保绿，符合"新屏先
落地、逐屏迁移"。`ExcludedBox` 本 task **不碰**（它连同 `.triage-excluded-*` CSS 归 Task 23）。

**Files:**
- Modify: `web/src/styles.css`（`.triage-box` + `.triage-dirgroup*` + `.triage-naming-hint*` + `.triage-dialog-more` 的 token 迁移。`.triage-excluded-*` 与 `.triage-boxes` 布局**不碰**）
- Modify: `web/src/triage/text.ts`（加 `groupParkTimeLine()` + 内部 `agoLabel()`——"首末行"的相对时间组装）
- Modify: `web/src/triage/PendingBox.tsx`（删 4 行 Astryx import；目录组卡 → `Task`/`TaskTrigger`/`TaskContent`；`Text`/`HStack`/`VStack`/`EmptyState` 换新件）
- Modify: `web/src/triage/TriagePage.tsx`（删 3 行 Astryx import；加页头 h1+副标题；loading 的 `Text`→`<span>`、error 的 `EmptyState`+`Button`→新件）
- Modify: `web/src/i18n/en.ts` + `web/src/i18n/zh.ts`（加 `triage_page_title` + `triage_subtitle` 两键）
- Modify: `web/src/triage/TriagePage.test.tsx`（引入 `cssDecl` 底座；既有 **5** 条保绿；追加 CSS 锁 1 条 + 页头/首末行 DOM 锁 1 条）
- Modify: `web/src/triage/text.test.ts`（若存在则追加 `groupParkTimeLine` 单测；不存在则新建）

两个 commit：① CSS token 迁移 + `TriagePage.test` 的 CSS 锁；② `text.ts`/`PendingBox`/`TriagePage`/i18n + DOM 锁。

---

#### 背景一：目录组卡上 `Task` 折叠件——组头三段信息作为 `TaskTrigger` 的 children

Task 11 造的 `web/src/components/ai/task.tsx` 导出 `Task` / `TaskTrigger` / `TaskContent`（`Task` =
`Collapsible` 薄壳，`defaultOpen=true`；`TaskTrigger` = `CollapsibleTrigger asChild className="group"`，
`children ??` 有默认 title+chevron 逃生口；`TaskContent` = `CollapsibleContent` + 内层
`mt-4 space-y-2 border-l-2 pl-4`）。plan `:3197` 明确："Task 22-24 接线时会传自己的 children（§5.5 的组头
有三段信息）"。

**每个目录组是一个 `Task`（`defaultOpen`——保留现网"文件默认可见"的行为）**，组头（mono 目录名 +
`"N files"` + 首末行）作为 `TaskTrigger` 的 children，文件行列表进 `TaskContent`。chevron 由 `TaskTrigger`
默认逃生口提供？不——这里传了自定义 children，默认那段（含 chevron）不渲染。所以**要自己在组头里放一个
chevron**（`ChevronDownIcon`，`group-data-[state=open]:rotate-180`，锚在 `TaskTrigger` 的 `group` 上）——
它是折叠的唯一可视 affordance（plan `:3144` 同款裁决）。

"首末行"= §5.5 的 `"First seen 3d ago, last attempt 2h ago."`——**不是**首/末个文件名，而是这一组的
**最早 firstSeen + 最晚 lastAttempt**（`ParkedItemDTO` 真实字段，`DirGroup.files` 是完整
`ParkedItemDTO[]`，`text.ts:47` 已核对）。

`TaskContent` 内层自带 `border-l-2 pl-4`——组卡文件列表本就该有左缩进（区分组头与文件），沿用即可，
不额外写 `.triage-dirgroup-files` 的缩进（那条 CSS 只保留 `gap`/`margin-top`）。

#### 背景二：`groupParkTimeLine` —— "首末行"的相对时间组装（新拟，§5.5/§5.7）

`web/src/triage/text.ts` 加一个纯函数。相对档位与 `web/src/activity/text.ts:194 relativeFinished` 逐字
一致（just now / Ns / Nm / Nh / Nd ago），但**本模块自持一份**、不跨目录 import（同 `settings/text.ts` 的
独立实现惯例，`triage/text.ts:37` 注释已点明这个分工）：

```ts
/** 相对"多久以前"——档位与 activity/text.ts 的 relativeFinished 逐字一致，本模块自持（不跨目录耦合）。 */
function agoLabel(deltaMs: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 5) return lang === 'zh' ? '刚刚' : 'just now'
  if (s < 60) return lang === 'zh' ? `${s} 秒前` : `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return lang === 'zh' ? `${m} 分钟前` : `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return lang === 'zh' ? `${h} 小时前` : `${h}h ago`
  const d = Math.floor(h / 24)
  return lang === 'zh' ? `${d} 天前` : `${d}d ago`
}

/** 目录组"首末行"（§5.5 新拟句式）——组内最早 firstSeen + 最晚 lastAttempt，都是 ParkedItemDTO
 *  真实字段。now 由调用方传入（保持纯函数、可测；同 activity 的 now 注入惯例）。 */
export function groupParkTimeLine(group: DirGroup, now: number, lang: Lang): string {
  const firstSeen = Math.min(...group.files.map((f) => f.firstSeen))
  const lastAttempt = Math.max(...group.files.map((f) => f.lastAttempt))
  const first = agoLabel(now - firstSeen, lang)
  const last = agoLabel(now - lastAttempt, lang)
  return lang === 'zh'
    ? `首次发现 ${first}，最近尝试 ${last}。`
    : `First seen ${first}, last attempt ${last}.`
}
```

（`DirGroup` 类型已 export，`agoLabel` 不 export——只服务 `groupParkTimeLine`。）

#### 背景三：CSS token 迁移（含 `.triage-dialog-more:focus-visible` 又一处 `--color-accent` 撞车）

本区 CSS 迁移（左 scout / 右 @theme，值全核对；迁移目标 scout 均不遮蔽，除 `--color-accent` 外——同
Task 19 背景一/Task 21 背景二的撞车规则）：

| 选择器 | 属性 | 现值 | 新值 |
|---|---|---|---|
| `.triage-box` | `border-radius` | `var(--radius-element, 8px)` | `var(--radius-control)` |
| `.triage-box` | `background` | `var(--color-background-card)` | `var(--color-card)`（#111318 两侧 ✓） |
| `.triage-box` | `border` | `var(--color-border)` | 不动 |
| `.triage-dirgroup` | `border-radius` | `var(--radius-inner, 4px)` | 字面 `4px` |
| `.triage-dirgroup` | `background` | `var(--color-background-surface)` | `var(--color-secondary)`（**不是 accent**） |
| `.triage-dirgroup-tail` | `color` | `var(--color-text-primary)` | `var(--color-foreground)` |
| `.triage-dirgroup-file` | `color` | `var(--color-text-secondary)` | `var(--color-muted-foreground)` |
| `.triage-naming-hint` | `color` | `var(--color-text-gray)` | `var(--color-weak)` |
| `.triage-naming-hint-code` | `color` | `var(--color-text-secondary)` | `var(--color-muted-foreground)` |
| `.triage-dialog-more` | `color` | `var(--color-text-gray)` | `var(--color-weak)` |
| `.triage-dialog-more:hover` | `color` | `var(--color-text-secondary)` | `var(--color-muted-foreground)` |
| `.triage-dialog-more:focus-visible` | `outline` | `2px solid var(--color-accent)` | `2px solid var(--color-ring)`（**撞车：可见焦点环，同 Task 19/21**） |

**不碰**：`.triage-boxes`（纯 grid/gap 字面，四区重排留 Task 24）、`.triage-excluded-*`（ExcludedBox，
Task 23）、`.triage-dirgroup-files` 的 `display:flex/gap/margin`（几何，保留）、一切 `'Geist Mono'` 字面族。

#### 背景四：既有 5 条 `TriagePage.test` 如何增量保绿

`TriagePage.test.tsx` 用 `mockFetchRouted` 打 `/api/v2/triage`。5 条断言全靠这些**类名/文案锚点**，本 task
一律保留：

- `.triage-dirgroup-tail`（组头 mono 目录名 span，现在长在 `TaskTrigger` 里）→ 保留类名；
- `.triage-actionable-groups`（组列表 wrapper）→ 保留，降序断言 `[...querySelectorAll('.triage-dirgroup-tail')]` 照旧；
- `fileCountLabel`（"2 files"/"1 file"）、箱头计数 `"3"`、`getByTitle(路径)`（文件行 mono）→ 保留；
- 命名指引整句 `"Title (Year)/Season NN/Title SNNENN.mkv"` → 保留；
- 空态 `"Every file found its identifier"`（`EmptyState`，`isCompact`）→ 保留。

关键：`Task` `defaultOpen=true` ⇒ `TaskContent`（文件行）**默认展开可见**，`getByTitle(文件路径)` 能命中
（现网文件也是默认可见，行为不变）。若写成 `defaultOpen={false}`，文件行进折叠态、`getByTitle` 找不到，
5 条里 3 条当场红——所以**组的 defaultOpen 必须是 true**。

#### 背景五：新拟文案两键（§5.7 登记）

| 键 | en | zh（本 spec 双语，adapt） |
|---|---|---|
| `triage_page_title` | `'Triage'` | `'甄别'` |
| `triage_subtitle` | `'Items the system parked instead of guessing. Nothing here blocks automatic work.'` | `'系统拿不准、宁可停放也不瞎猜的文件。这里的东西都不挡自动流程。'` |

（"首末行"句不进扁平表——它带运行期相对时间，走 `groupParkTimeLine`，同 `fileCountLabel`/`moreLabel`
的既有分工：带数字的句子在 `text.ts`，`t()` 故意不支持插值。）

---

- [ ] **Step 1: 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/TriagePage.test.tsx src/triage/ExcludedBox.test.tsx
```

Expected: **TriagePage 5 / ExcludedBox 3**。有红先停下报告。（ExcludedBox 本 task 不碰，跑它只是确认没被
误伤。）

- [ ] **Step 2: 给 `TriagePage.test.tsx` 补 `cssDecl` 底座**

在 `:14` 那行 `import type { TriageDTO }` 之后插入（同 Task 19-21 逐字一致）：

```tsx
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}
```

- [ ] **Step 3: 先写 CSS 锁（会红）**

在 `TriagePage.test.tsx` **文件末尾**追加：

```tsx
// ── CSS 侧迁移锁（Task 22）
describe('TriagePage / Pending 区：CSS 侧迁移锁', () => {
  it('箱底/组底走新栈 token（card/secondary），不是被 scout 遮蔽的 --color-accent', () => {
    expect(cssDecl('.triage-box', 'background')).toBe('var(--color-card)')
    expect(cssDecl('.triage-dirgroup', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.triage-box', 'border-radius')).toBe('var(--radius-control)')
  })
  it('"+N more" 折叠钮焦点环走 --color-ring（不是过渡期变绿的 --color-accent）', () => {
    expect(cssDecl('.triage-dialog-more:focus-visible', 'outline')).toBe('2px solid var(--color-ring)')
    expect(cssDecl('.triage-dirgroup-tail', 'color')).toBe('var(--color-foreground)')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/TriagePage.test.tsx 2>&1 | tail -20
```

Expected: **2 failed / 5 passed**（两条新锁红，报旧值 `var(--color-background-card)` / `var(--color-background-surface)` /
`var(--color-accent)` / `var(--color-text-primary)`）。

- [ ] **Step 4: 改 `styles.css`（Pending 区 token 迁移）**

按背景三的表逐处改（`.triage-box` / `.triage-dirgroup` / `.triage-dirgroup-tail` / `.triage-dirgroup-file` /
`.triage-naming-hint` / `.triage-naming-hint-code` / `.triage-dialog-more` 及其 `:hover` / `:focus-visible`）。
`.triage-dialog-more:focus-visible` 那条加一行注释：

```css
.triage-dialog-more:focus-visible {
  /* --color-ring：--color-accent 被 scout 遮蔽成柠檬绿，过渡期焦点环变绿、卸载后与背景同调。 */
  outline: 2px solid var(--color-ring);
  outline-offset: 2px;
}
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/TriagePage.test.tsx
```

Expected: **7 passed**（5 既有 + 2 新锁）。

区段核对旧 token 绝迹（`.triage-box` 到 `.triage-dialog-more` 段）：

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && awk '/^\.triage-box \{/,/^\.triage-dialog-more:focus-visible/' src/styles.css | grep -c -- "--color-accent\|--color-background-card\|--color-background-surface\|--color-text-primary\|--color-text-secondary\|--color-text-gray\|--radius-element\|--radius-inner"
```

Expected: ~~`0`~~（2026-08-03 Task 22 落地修订：awk 区间横跨 `.triage-excluded-*`，实际剩 **3** 条命中、
全部属于 `.triage-excluded-row`/`.triage-excluded-file` = Task 23 范围，正常。核对口径应看命中行的
**选择器归属**——Pending 侧 `.triage-box`/`.triage-dirgroup*`/`.triage-naming-hint*`/`.triage-dialog-more*`
必须零命中。）

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/triage/TriagePage.test.tsx
git commit -m "refactor(web): Triage Pending 区 CSS token 迁移（+N more 焦点环避 --color-accent 撞车）"
```

- [ ] **Step 6: `text.ts` 加 `groupParkTimeLine`**

把背景二的 `agoLabel` + `groupParkTimeLine` 追加到 `web/src/triage/text.ts`（`groupPending` 之后即可）。

若 `web/src/triage/text.test.ts` 存在，在其末尾追加单测；不存在则新建 `web/src/triage/text.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { groupParkTimeLine, type DirGroup } from './text.js'

function grp(files: Array<{ firstSeen: number; lastAttempt: number }>): DirGroup {
  return {
    dir: '/media/tv/Show',
    dirTail: 'Show',
    files: files.map((f, i) => ({ path: `/media/tv/Show/e${i}.mkv`, parkReason: 'x', firstSeen: f.firstSeen, lastAttempt: f.lastAttempt })),
  }
}

describe('groupParkTimeLine', () => {
  const NOW = 1_000_000_000_000
  it('取组内最早 firstSeen + 最晚 lastAttempt，档位同 relativeFinished（en）', () => {
    const g = grp([
      { firstSeen: NOW - 3 * 86_400_000, lastAttempt: NOW - 2 * 3_600_000 },
      { firstSeen: NOW - 1 * 86_400_000, lastAttempt: NOW - 30 * 60_000 },
    ])
    expect(groupParkTimeLine(g, NOW, 'en')).toBe('First seen 3d ago, last attempt 30m ago.')
  })
  it('zh 平移', () => {
    const g = grp([{ firstSeen: NOW - 2 * 3_600_000, lastAttempt: NOW - 1000 }])
    expect(groupParkTimeLine(g, NOW, 'zh')).toBe('首次发现 2 小时前，最近尝试 刚刚。')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/text.test.ts
```

Expected: 全绿（含新增 2 条）。

- [ ] **Step 7: 加 i18n 两键**

`web/src/i18n/en.ts` 的 `triage_pending_heading` 附近加：

```ts
  triage_page_title: 'Triage',
  triage_subtitle: 'Items the system parked instead of guessing. Nothing here blocks automatic work.',
```

`web/src/i18n/zh.ts` 对应位置加：

```ts
  triage_page_title: '甄别',
  triage_subtitle: '系统拿不准、宁可停放也不瞎猜的文件。这里的东西都不挡自动流程。',
```

- [ ] **Step 8: 迁 `PendingBox.tsx`**

整文件替换成（目录组卡 → `Task`；`Text`/`HStack`/`VStack`/`EmptyState` 换新件；保留 `.triage-*` 类名与
文件级 >5 折叠）：

```tsx
// web/src/triage/PendingBox.tsx：待甄别箱——按目录分组渲染 park 救援清单。组头=目录尾段 mono +
// 文件计数 + 首末行（First seen…/last attempt…），组体=文件名只读列表（>5 折叠），末尾命名指引。
// 目录组卡用 AI Elements 的 Task 折叠件（组头作 TaskTrigger children，chevron 是折叠的唯一可视
// affordance）。Claim 按钮/duplicates 桶均已退役（见既有头注释历史，语义不变）。
import { useState } from 'react'
import { Task, TaskTrigger, TaskContent } from '../components/ai/task.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { ChevronDownIcon } from 'lucide-react'
import { useT } from '../i18n/useT.js'
import { pathTail, fileCountLabel, moreLabel, groupParkTimeLine, type DirGroup } from './text.js'

// 命名最佳实践路径样例——技术值，mono 且不翻译（DESIGN.md §3/§7），两种语言下原样出现。
const NAMING_PATTERN = 'Title (Year)/Season NN/Title SNNENN.mkv'
const FILES_COLLAPSE_AT = 5

function DirGroupCard({ group }: { group: DirGroup }) {
  const { lang } = useT()
  const now = Date.now()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? group.files : group.files.slice(0, FILES_COLLAPSE_AT)
  const hidden = group.files.length - visible.length

  return (
    <div className="triage-dirgroup">
      <Task defaultOpen>
        <TaskTrigger>
          {/* 原生 button——Radix Slot 只合并 onClick/aria-expanded/data-state，不给 div 补
              role/tabIndex/keydown（Task 11 评审实证）；div 触发器键盘不可达。
              w-full text-left font-[inherit] bg-transparent border-0 抵掉按钮默认样式。
              （2026-08-03 Task 11 评审裁决修订：原块这里是 <div className="group flex w-full
              cursor-pointer …">，实证键盘不可达后裁为原生 button；plan :3197 本就判决
              "Task 22-24 会传自己的 children"。） */}
          <button type="button" className="group flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit">
            <span className="triage-dirgroup-tail" title={group.dir}>
              {group.dirTail}
            </span>
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">
              {fileCountLabel(group.files.length, lang)}
            </span>
            <span className="text-[11px] leading-4 text-muted-foreground">
              {groupParkTimeLine(group, now, lang)}
            </span>
            <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </TaskTrigger>
        <TaskContent>
          <div className="triage-dirgroup-files">
            {visible.map((f) => (
              <span key={f.path} className="triage-dirgroup-file" title={f.path}>
                {pathTail(f.path)}
              </span>
            ))}
            {hidden > 0 ? (
              <button type="button" className="triage-dialog-more" onClick={() => setExpanded(true)}>
                {moreLabel(hidden, lang)}
              </button>
            ) : null}
          </div>
        </TaskContent>
      </Task>
    </div>
  )
}

interface Props {
  /** 待识别的目录组（已由 TriagePage 通过 groupPending 分桶）。 */
  actionable: DirGroup[]
}

export function PendingBox({ actionable }: Props) {
  const { t } = useT()
  const actionableCount = actionable.reduce((n, g) => n + g.files.length, 0)

  return (
    <div className="triage-box">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_pending_heading')}</span>
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">{actionableCount}</span>
        </div>

        {actionable.length === 0 ? (
          <EmptyState isCompact title={t('triage_empty_title')} description={t('triage_empty_desc')} />
        ) : (
          <div className="triage-actionable-groups">
            <div className="flex flex-col gap-2">
              {actionable.map((group) => (
                <DirGroupCard key={group.dir} group={group} />
              ))}
            </div>
          </div>
        )}

        <div className="triage-naming-hint">
          {t('triage_naming_hint_prefix')}
          <code className="triage-naming-hint-code">{NAMING_PATTERN}</code>
        </div>
      </div>
    </div>
  )
}
```

（`TaskTrigger` 是 `asChild`——它把 Radix 的触发行为透传给**单个子元素**，所以 children 必须是**一个**
根节点：这里那个原生 `<button>` 就是那唯一根。`group` class 锚 chevron 的旋转——data-state 由 Radix
落在触发器（=这个 button）上，chevron 是其子孙，`group-data-[state=open]` 选择器前提成立（Task 22
落地时已用 DOM 锁实证：`.triage-dirgroup button[data-state]` 数量=组数、每个都带 `group` 类）。
`Task defaultOpen` 保证文件行默认可见，既有 `getByTitle` 断言不破，见背景四。另注：Task 22 接线时发现
`TaskTriggerProps.title` 是必填而自定义 children 时它是死 prop——已把 task.tsx 的 `title` 裁为 optional。）

- [ ] **Step 9: 迁 `TriagePage.tsx`**

整文件替换成（加页头；loading/error 换新件；保留两箱布局）：

```tsx
// web/src/triage/TriagePage.tsx：甄别 tab 主体（dashboard-F5）——收件箱：页头 + 两箱（Pending |
// Excluded）。四区重排（+Timing +Dormant）见 Task 23-24。数据面：GET /api/v2/triage 一次拿全 pending，
// 翻案后手动 reload（useTriage 不轮询）。认领已退役（见 src/v2/triageOps.ts 头注释）。
import { Section } from '../components/ui/section.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useTriage } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { PendingBox } from './PendingBox.js'
import { ExcludedBox } from './ExcludedBox.js'
import { groupPending } from './text.js'

export function TriagePage() {
  const { t } = useT()
  const triage = useTriage()

  const head = (
    <div className="flex flex-col gap-1">
      <h1 className="m-0 text-[19px] font-semibold leading-7 text-foreground">{t('triage_page_title')}</h1>
      <span className="text-[13px] leading-5 text-muted-foreground">{t('triage_subtitle')}</span>
    </div>
  )

  if (triage.loading && !triage.data) {
    return (
      <Section>
        {head}
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">loading…</span>
      </Section>
    )
  }
  if (triage.error && !triage.data) {
    return (
      <Section>
        {head}
        <EmptyState
          title={t('triage_error_prefix') + triage.error}
          actions={
            <Button variant="secondary" onClick={triage.reload}>
              {t('triage_retry_label')}
            </Button>
          }
        />
      </Section>
    )
  }
  if (!triage.data) return null

  const { actionable, excluded } = groupPending(triage.data.pending)

  const handleRestore = async (path: string) => {
    await api.unexclude(path)
    triage.reload()
  }

  return (
    <Section>
      <div className="flex flex-col gap-4">
        {head}
        <div className="triage-boxes">
          <PendingBox actionable={actionable} />
          <ExcludedBox excluded={excluded} onRestore={handleRestore} />
        </div>
      </div>
    </Section>
  )
}
```

（`<Section>` 是 Task 8 自绘件——写死 `bg-accent p-4`，给整页一个面。页头 h1 用
`text-[19px] leading-7`（`--font-size-xl`=19px，`heading` 语义；leading-7=28px 近似 19×1.47）。`ExcludedBox`
仍是 Astryx（Task 23 才迁），本 task 与它共存不碰。）

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/TriagePage.test.tsx src/triage/ExcludedBox.test.tsx && npx tsc --noEmit
```

Expected: **TriagePage 7 / ExcludedBox 3** 全绿 + tsc 无输出。

- [ ] **Step 10: 追加 DOM 锁**

`TriagePage.test.tsx` 末尾追加：

```tsx
// ── DOM 侧迁移锁（Task 22）——只锁 Pending 侧；ExcludedBox 子树仍是 Astryx（Task 23），不查全树。
describe('TriagePage / Pending：DOM 侧迁移锁', () => {
  it('页头标题+副标题在场；目录组头渲染首末行；Pending 侧无 astryx 类名', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([{ path: '/api/v2/triage', body: triageWithData() }]))
    const { container } = renderPage()
    await screen.findByText('S01')
    // 页头（新拟副标题）。
    expect(screen.getByText('Triage')).toBeInTheDocument()
    expect(screen.getByText(/Nothing here blocks automatic work/)).toBeInTheDocument()
    // 首末行（fixture: firstSeen=NOW-60s、lastAttempt=NOW → "First seen 1m ago, last attempt just now."）。
    // （2026-08-03 Task 22 落地修订：两个目录组各渲染一条首末行，getByText 遇多匹配会抛——
    // 实装用 getAllByText + toHaveLength(2)。）
    expect(screen.getAllByText(/First seen .* ago, last attempt/)).toHaveLength(2)
    // Pending 箱（.triage-actionable-groups 子树）无 astryx——ExcludedBox 空桶时不渲染，故此处全树也净，
    // 但为稳妥只查 Pending 箱子树。
    const pendingBox = container.querySelector('.triage-actionable-groups')!.closest('.triage-box')!
    expect(pendingBox.querySelector('[class*="astryx"]')).toBeNull()
  })

  // （2026-08-03 Task 22 落地增补，Task 11 评审台账裁决）组触发器必须是原生 button 的辨别锁：
  // getByRole('button', { name: /S01/ }) 可访问名查询 + container.querySelectorAll(
  // '.triage-dirgroup button[data-state]') 长度=组数、每枚带 group 类且 data-state='open'——
  // div 触发器两条都过不了。
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/
```

Expected: **TriagePage 8 / ExcludedBox 3 / text 2**（若新建 text.test）全绿。

- [ ] **Step 11: 收口核对**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/triage/PendingBox.tsx src/triage/TriagePage.tsx || echo "2 files clean"
```

Expected: 打 `2 files clean`。（`grep -rn "astryxdesign" src/triage/` 整目录仍命中 `ExcludedBox.tsx` = Task 23，正常。）

- [ ] **Step 12: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/triage/text.ts web/src/triage/text.test.ts web/src/triage/PendingBox.tsx web/src/triage/TriagePage.tsx web/src/i18n/en.ts web/src/i18n/zh.ts web/src/triage/TriagePage.test.tsx
git commit -m "feat(web): Triage 页壳 + Pending 区重设计（目录组上 Task 折叠件 + 首末行）"
```

**给 Task 23（Excluded + Timing looks off 两区）的备忘：** Pending 区与页壳落地，`.triage-boxes` 仍是两箱
布局。Task 23 做两件：① **ExcludedBox** 卸 Astryx——它的 `Collapsible`（`trigger` prop + `defaultIsOpen`）
换成 `Task`/`TaskTrigger`/`TaskContent`（`ExcludedBox.test.tsx:14` 的 `openBox()` 点 `getByText(/excluded
extras/)` 开箱、再 `findByRole('button',{name:/restore/})`——`Task defaultOpen={false}` + 触发器文案含
"Excluded extras" 即可满足；`Button isLoading/isDisabled/label` → `<Button disabled={busy}>{label}</Button>`，
双提交防护靠既有 `if (busy) return` 守卫，`ExcludedBox.test.tsx:26` 只断言 `onRestore` 调一次、不断言
spinner，所以丢 `isLoading` 视觉安全）；迁 `.triage-excluded-*` CSS token（background-surface→secondary、
text-secondary→muted-foreground）。② **Timing looks off · N** 新区——数据源 `useShiftedSubtitles()`
（Plan C Task 5 造，`ShiftedItemDTO` = `{itemId,seriesId,seriesName,season,episode,checkedAt,hasPriorCorrection}`），
行 = 红点 + `"Peacemaker S2E03"` + `"checked Xh ago"` + `"Fix the timing"`（`en.ts:93 verify_correct_action`
逐字，接 `POST /api/v2/subtitle/correct`）+ `"Undo"`（接 `revert`，`hasPriorCorrection===false` 时置灰）。
相对时间复用本 task 新加的 `agoLabel`（考虑 export 它，或 Timing 侧自持一份 `"checked …ago"` 组装）。
Task 24 再把四区重排成单列收件箱 + 加 Dormant 区 + 侧栏 badge 语义。CSS/token 撞车三铁律照旧
（见 Task 19 背景一）。`cssDecl` 底座 `TriagePage.test` 已具备。

---

### Task 23: ExcludedBox 卸 Astryx + Timing looks off 新区（Triage 第 2/3 区）

Triage 三件（22-24）的第二件。两块：

- **Excluded extras 区**（`ExcludedBox`）：卸 Astryx——`Collapsible`（`trigger` prop + `defaultIsOpen`）
  换成 `Task`/`TaskTrigger`/`TaskContent`，`Button`（`label`/`isLoading`/`isDisabled`）换 Plan A 的 shadcn
  `Button`（children + `disabled`）；`.triage-excluded-*` CSS token 迁移；
- **Timing looks off · N 区**（新增，§5.5 第三区）：读 `useShiftedSubtitles()`（Plan C Task 5 造），
  行 = 红点 + `"SeriesName S2E03"` + `"checked 2h ago"` + `"Fix the timing"`（接 `correct`）+ `"Undo"`
  （接 `revert`，`hasPriorCorrection===false` 置灰）。**是 Triage 首个"有动作"的新区**，也是四屏里
  `subtitle/revert` wrapper 的首次接线（spec §4.3）。

四区重排成单列收件箱 + Dormant 第四区留 **Task 24**。本 task 把 Timing 区**挂在两箱下方**（全宽），
增量落地、可测；Task 24 再统一成单列。

**Files:**
- Modify: `web/src/styles.css`（`.triage-excluded-row` + `.triage-excluded-file` token 迁移。Timing 行走 Tailwind 内联，不新增 CSS 类）
- Modify: `web/src/triage/text.ts`（加 `checkedAgoLine()` + `timingRowLabel()`，复用本模块 `agoLabel`）
- Modify: `web/src/triage/ExcludedBox.tsx`（删 5 行 Astryx；`Collapsible`→`Task`、`Button`→shadcn、`Text`/`HStack`/`VStack`→标签+类）
- Create: `web/src/triage/TimingBox.tsx`（新区组件）
- Modify: `web/src/triage/TriagePage.tsx`（两箱下方挂 `<TimingBox />`）
- Modify: `web/src/i18n/en.ts` + `web/src/i18n/zh.ts`（加 `triage_timing_heading` + `triage_timing_undo` 两键）
- Create: `web/src/triage/TimingBox.test.tsx`（新区行为测试）
- Modify: `web/src/triage/text.test.ts`（追加 `checkedAgoLine`/`timingRowLabel` 单测）
- Modify: `web/src/triage/ExcludedBox.test.tsx`（既有 **3** 条保绿；追加 DOM 锁 1 条）

两个 commit：① ExcludedBox 迁移 + CSS + DOM 锁；② Timing 新区（text 助手 + 组件 + i18n + 接线 + 测试）。

---

#### 背景一：`ExcludedBox` 的 Astryx `Collapsible` → `Task`，`Button` → shadcn

**Collapsible API 变了**：Astryx 是 `<Collapsible defaultIsOpen={false} trigger={<HStack>…</HStack>}>{children}</Collapsible>`；
`Task`（Task 11 的 `components/ai/task.tsx`）是 Radix 三段式 `<Task defaultOpen={false}><TaskTrigger>{触发器}</TaskTrigger><TaskContent>{内容}</TaskContent></Task>`。

`ExcludedBox.test.tsx:13-16` 的 `openBox()`：`fireEvent.click(getByText(/excluded extras|已排除/i))` 开箱 →
`findByRole('button',{name:/restore|恢复/i})`。所以：**触发器 children 里必须含 "Excluded extras" 文案**
（`triage_excluded_heading`），且 **`defaultOpen={false}`**（默认折叠，Restore 按钮进 `TaskContent` 折叠态，
点开才出现——正是那三条测试的前提；写成 `defaultOpen` 会让 Restore 一开始就在，`openBox` 的"点开才出现"
语义虽不炸但失真）。`TaskTrigger` 是 `asChild`——children 必须**单根**，用一个 `<div className="group flex …">`
裹住标题+计数+chevron。

**Button API 变了**（同 Task 15/plan 背景三）：Astryx `<Button size="sm" variant="secondary" label={…}
isLoading={busy} isDisabled={busy} onClick={restore} />` → shadcn `<Button size="sm" variant="secondary"
disabled={busy} onClick={restore}>{…}</Button>`。**丢掉 `isLoading` 的 spinner 视觉**：`ExcludedBox.test.tsx:26`
的防双提交断言的是 `onRestore` 只被调一次——靠 `restore()` 里既有的 `if (busy) return` 守卫 + `disabled={busy}`，
**不**断言 spinner，所以丢 spinner 安全（plan 已核实）。busy/error 的 `useState` 逻辑一字不动。

CSS token 迁移：

| 选择器 | 属性 | 现值 | 新值 |
|---|---|---|---|
| `.triage-excluded-row` | `border-radius` | `var(--radius-inner, 4px)` | `4px` |
| `.triage-excluded-row` | `background` | `var(--color-background-surface)` | `var(--color-secondary)` |
| `.triage-excluded-row` | `border` | `var(--color-border)` | 不动 |
| `.triage-excluded-file` | `color` | `var(--color-text-secondary)` | `var(--color-muted-foreground)` |

#### 背景二：Timing looks off 新区——首个"有动作"的新收件箱区

数据源 `useShiftedSubtitles(): Async<ShiftedItemDTO[]>`（`hooks.ts`，Plan C Task 5）。
`ShiftedItemDTO = { itemId, seriesId: string|null, seriesName: string|null, season: number|null,
episode: number|null, checkedAt: number, hasPriorCorrection: boolean }`（七键封闭，无毫秒/分数——铁律②）。

**行的四段 + 两按钮**（§5.5）：
- 红点：**行级**红，不是 ep-dot 变体（§5.4"偏移不是 ep-dot 变体"）→ `<span className="size-[5px] shrink-0 rounded-full bg-fn-red" aria-hidden="true" />`；
- 标签 `"Peacemaker S2E03"` = `timingRowLabel(row)`：媒体字段齐 → `${seriesName} S${season}E${pad2(episode)}`；任一为 null（电影行/库里已无此集）→ 降级 mono `itemId`（spec §8）；
- `"checked 2h ago"` = `checkedAgoLine(row.checkedAt, now, lang)`（新拟句式，`checked_at` 真实字段，复用 `agoLabel`）；
- **Fix the timing**（`verify_correct_action` = `en.ts:93` 逐字）→ `api.subtitleCorrect(itemId)` 后 `reload`；
- **Undo**（新拟 `triage_timing_undo`）→ `api.subtitleRevert(itemId)` 后 `reload`；**`hasPriorCorrection===false` 时 `disabled`**（§5.4/§4.1：能点 = 有可还原备份，与 revert 前置门同源）。

per-row `busy` 守卫防双提交（同 `ExcludedBox` 手法）。空清单（`data.length===0`）→ **整区不渲染**
（收件箱零预告，没有偏移就不占屏）。区头 `"Timing looks off · N"`（`triage_timing_heading` + `· ${N}`）。

行布局走 **Tailwind 内联**（不新增 `.triage-*` CSS 类）——Astryx 时代的原子 CSS 是"组件语言表达不了"的
补救，新栈能直接用 utilities 表达一个简单 flex 行；颜色走 @theme 生成的 `bg-fn-red`/`text-foreground`/
`text-muted-foreground`/`bg-secondary`/`border-border`（均由 Task 6/Plan A 的 `@theme` 自动生成）。

#### 背景三：`text.ts` 两个新助手（复用 Task 22 落的 `agoLabel`）

```ts
/** "checked 2h ago" / "2 小时前检查"——偏移行的新鲜度（§5.5 新拟，checkedAt 真实字段）。 */
export function checkedAgoLine(checkedAt: number, now: number, lang: Lang): string {
  const ago = agoLabel(now - checkedAt, lang)
  return lang === 'zh' ? `${ago}检查` : `checked ${ago}`
}

/** 偏移行标签——"Peacemaker S2E03"；媒体字段任一 null 时降级 mono itemId（spec §8）。 */
export function timingRowLabel(row: {
  seriesName: string | null; season: number | null; episode: number | null; itemId: string
}): string {
  if (row.seriesName === null || row.season === null || row.episode === null) return row.itemId
  return `${row.seriesName} S${row.season}E${String(row.episode).padStart(2, '0')}`
}
```

（`agoLabel` 是 Task 22 加进 `text.ts` 的模块私有函数——同模块内两个新助手直接调，**不必 export 它**。）

#### 背景四：新拟文案两键（§5.7 登记）

| 键 | en | zh |
|---|---|---|
| `triage_timing_heading` | `'Timing looks off'` | `'时间轴对不上'` |
| `triage_timing_undo` | `'Undo'` | `'撤销'` |

（"checked …ago" 与行标签带运行期值，走 `text.ts`，不进扁平表；"Fix the timing" 复用既有
`verify_correct_action`，不新增。）

---

- [ ] **Step 1: 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/
```

Expected: **TriagePage 8 / ExcludedBox 3 / text 2**（Task 22 落地后的数）。有红先停下报告。

- [ ] **Step 2: 迁 `.triage-excluded-*` CSS**

`web/src/styles.css` 的 `.triage-excluded-row` / `.triage-excluded-file` 按背景一表改（`--radius-inner,4px`→`4px`、
`--color-background-surface`→`--color-secondary`、`--color-text-secondary`→`--color-muted-foreground`；
border 不动）。

- [ ] **Step 3: 迁 `ExcludedBox.tsx`**

整文件替换成：

```tsx
// web/src/triage/ExcludedBox.tsx：excluded-extra 翻案箱——默认折叠，列出被 exclude_extras 当"特典"
// 排除的停车行，每行文件名 + Restore（接 unexclude），取消排除后回 pending 池重新 ingest。
import { useState } from 'react'
import { Task, TaskTrigger, TaskContent } from '../components/ai/task.js'
import { Button } from '../components/ui/button.js'
import { ChevronDownIcon } from 'lucide-react'
import type { ParkedItemDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { pathTail } from './text.js'

interface Props {
  excluded: ParkedItemDTO[]
  /** 翻案一行——返回 Promise，据其成败驱动 busy/error（dashboard 审计 #2）。 */
  onRestore: (path: string) => Promise<void>
}

function ExcludedRow({ row, onRestore }: { row: ParkedItemDTO; onRestore: (path: string) => Promise<void> }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    if (busy) return // 同步去重：飞行中不再触发（双提交防护）
    setBusy(true)
    setError(null)
    try {
      await onRestore(row.path)
    } catch (e) {
      setError(t('triage_restore_error_prefix') + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="triage-excluded-row">
      <span className="triage-excluded-file" title={row.path}>
        {pathTail(row.path)}
      </span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={restore}>
        {t('triage_excluded_restore_label')}
      </Button>
      {error && <span className="auth-error" role="alert">{error}</span>}
    </div>
  )
}

export function ExcludedBox({ excluded, onRestore }: Props) {
  const { t } = useT()
  if (excluded.length === 0) return null

  return (
    <div className="triage-box">
      <Task defaultOpen={false}>
        <TaskTrigger>
          <div className="group flex w-full cursor-pointer items-center gap-2">
            <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_excluded_heading')}</span>
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">{excluded.length}</span>
            <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </div>
        </TaskTrigger>
        <TaskContent>
          <div className="flex flex-col gap-2">
            {excluded.map((row) => (
              <ExcludedRow key={row.path} row={row} onRestore={onRestore} />
            ))}
          </div>
        </TaskContent>
      </Task>
    </div>
  )
}
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/ExcludedBox.test.tsx && npx tsc --noEmit
```

Expected: **3 passed** + tsc 无输出。（`openBox()` 点 "Excluded extras" 开折叠 → Restore 按钮出现；
双提交守卫 + `disabled={busy}` 保证 `onRestore` 只调一次。）

- [ ] **Step 4: ExcludedBox DOM 锁**

`ExcludedBox.test.tsx` 末尾追加：

```tsx
describe('ExcludedBox：DOM 侧迁移锁（Task 23）', () => {
  it('展开后子树无 astryx 类名；Restore 是 children 版按钮', async () => {
    const onRestore = vi.fn(() => Promise.resolve())
    const { container } = wrap(onRestore)
    const btn = await openBox()
    expect(btn).toHaveTextContent(/Restore|恢复/)
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/ExcludedBox.test.tsx
```

Expected: **4 passed**。

- [ ] **Step 5: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/triage/ExcludedBox.tsx web/src/triage/ExcludedBox.test.tsx
git commit -m "refactor(web): Triage Excluded 区卸 Astryx（Collapsible→Task, Button→shadcn）"
```

- [ ] **Step 6: `text.ts` 两个助手 + 单测**

把背景三的 `checkedAgoLine` / `timingRowLabel` 追加到 `web/src/triage/text.ts`。`text.test.ts` 追加：

```ts
import { checkedAgoLine, timingRowLabel } from './text.js'

describe('checkedAgoLine', () => {
  const NOW = 1_000_000_000_000
  it('en: checked Nh ago', () => {
    expect(checkedAgoLine(NOW - 2 * 3_600_000, NOW, 'en')).toBe('checked 2h ago')
  })
  it('zh: N小时前检查', () => {
    expect(checkedAgoLine(NOW - 2 * 3_600_000, NOW, 'zh')).toBe('2 小时前检查')
  })
})

describe('timingRowLabel', () => {
  it('媒体齐 → SeriesName SxxExx（集号补零）', () => {
    expect(timingRowLabel({ seriesName: 'Peacemaker', season: 2, episode: 3, itemId: 'it-1' })).toBe('Peacemaker S2E03')
  })
  it('任一 null → 降级 mono itemId', () => {
    expect(timingRowLabel({ seriesName: null, season: 2, episode: 3, itemId: 'it-1' })).toBe('it-1')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/text.test.ts
```

Expected: 全绿（含新增 4 条）。

- [ ] **Step 7: 加 i18n 两键**

`en.ts`（`triage_*` 区）：

```ts
  triage_timing_heading: 'Timing looks off',
  triage_timing_undo: 'Undo',
```

`zh.ts`：

```ts
  triage_timing_heading: '时间轴对不上',
  triage_timing_undo: '撤销',
```

- [ ] **Step 8: 建 `TimingBox.tsx`**

新建 `web/src/triage/TimingBox.tsx`：

```tsx
// web/src/triage/TimingBox.tsx：Triage 第三区「Timing looks off · N」（spec §5.5）——偏移字幕全局
// 收件箱。行 = 行级红点 + "SeriesName SxxExx" + "checked Xh ago" + Fix the timing（接 correct）+
// Undo（接 revert，无在先校正时置灰）。空清单整区不渲染（零预告）。毫秒/分数在 API 层已剥（铁律②）。
import { useCallback, useState } from 'react'
import { Button } from '../components/ui/button.js'
import type { ShiftedItemDTO } from '../api/types.js'
import { useShiftedSubtitles } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { checkedAgoLine, timingRowLabel } from './text.js'

function TimingRow({ row, now, onChanged }: { row: ShiftedItemDTO; now: number; onChanged: () => void }) {
  const { t, lang } = useT()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (action: 'fix' | 'undo') => {
      if (busy) return
      setBusy(true)
      try {
        if (action === 'fix') await api.subtitleCorrect(row.itemId)
        else await api.subtitleRevert(row.itemId)
        onChanged()
      } catch {
        // 失败的可见后果是行仍在场（reload 后偏移行还在）——这一屏无 toast（铁律 L7）。
      } finally {
        setBusy(false)
      }
    },
    [busy, row.itemId, onChanged],
  )

  return (
    <div className="flex items-center gap-3 rounded-[4px] border border-border bg-secondary px-3 py-2">
      <span className="size-[5px] shrink-0 rounded-full bg-fn-red" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground" title={timingRowLabel(row)}>{timingRowLabel(row)}</span>
      <span className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground">{checkedAgoLine(row.checkedAt, now, lang)}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => run('fix')}>
        {t('verify_correct_action')}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy || !row.hasPriorCorrection} onClick={() => run('undo')}>
        {t('triage_timing_undo')}
      </Button>
    </div>
  )
}

export function TimingBox() {
  const { t } = useT()
  const shifted = useShiftedSubtitles()
  const rows = shifted.data ?? []
  if (rows.length === 0) return null // 零偏移 → 不占屏（收件箱零预告）

  const now = Date.now()
  return (
    <div className="triage-box">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_timing_heading')}</span>
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">· {rows.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <TimingRow key={row.itemId} row={row} now={now} onChanged={shifted.reload} />
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: TriagePage 挂 TimingBox**

`web/src/triage/TriagePage.tsx`：`import { TimingBox } from './TimingBox.js'`；把成功分支的 return 改成两箱
下方挂 Timing 区：

```tsx
  return (
    <Section>
      <div className="flex flex-col gap-4">
        {head}
        <div className="triage-boxes">
          <PendingBox actionable={actionable} />
          <ExcludedBox excluded={excluded} onRestore={handleRestore} />
        </div>
        <TimingBox />
      </div>
    </Section>
  )
```

（`TimingBox` 自取数、空则渲染 null，所以 TriagePage 不必判空。四区单列重排留 Task 24。）

- [ ] **Step 10: 建 `TimingBox.test.tsx`**

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TimingBox } from './TimingBox.js'
import { api } from '../api/client.js'
import type { ShiftedItemDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const row = (over: Partial<ShiftedItemDTO> = {}): ShiftedItemDTO => ({
  itemId: 'it-1', seriesId: 'tmdb:1', seriesName: 'Peacemaker', season: 2, episode: 3,
  checkedAt: Date.now() - 2 * 3_600_000, hasPriorCorrection: true, ...over,
})

function stub(rows: ShiftedItemDTO[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/subtitle/shifted')) {
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const wrap = () => render(<I18nProvider initialLang="en"><TimingBox /></I18nProvider>)

describe('TimingBox', () => {
  it('空清单 → 整区不渲染（零预告）', async () => {
    stub([])
    const { container } = wrap()
    await waitFor(() => expect(container.textContent).not.toContain('Timing looks off'))
    expect(container.querySelector('.triage-box')).toBeNull()
  })

  it('有偏移行 → 区头计数 + 标签 + checked ago', async () => {
    stub([row()])
    wrap()
    expect(await screen.findByText('Timing looks off')).toBeInTheDocument()
    expect(screen.getByText('Peacemaker S2E03')).toBeInTheDocument()
    expect(screen.getByText('checked 2h ago')).toBeInTheDocument()
  })

  it('Fix the timing → POST correct', async () => {
    stub([row()])
    const spy = vi.spyOn(api, 'subtitleCorrect').mockResolvedValue(undefined as never)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Fix the timing' }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('it-1'))
  })

  it('hasPriorCorrection=false → Undo 置灰；=true → 可点触发 revert', async () => {
    stub([row({ hasPriorCorrection: false })])
    wrap()
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  it('hasPriorCorrection=true → Undo 点了走 revert', async () => {
    stub([row({ hasPriorCorrection: true })])
    const spy = vi.spyOn(api, 'subtitleRevert').mockResolvedValue(undefined as never)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('it-1'))
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/ && npx tsc --noEmit
```

Expected: 全绿（TriagePage 8 / ExcludedBox 4 / TimingBox 5 / text 6）+ tsc 无输出。

- [ ] **Step 11: 收口核对**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/triage/ExcludedBox.tsx src/triage/TimingBox.tsx src/triage/TriagePage.tsx src/triage/PendingBox.tsx || echo "4 files clean"
```

Expected: 打 `4 files clean`——**`src/triage/` 到此全部脱离 Astryx**（Timing 是新组件、天生无 Astryx）。

- [ ] **Step 12: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/triage/text.ts web/src/triage/text.test.ts web/src/triage/TimingBox.tsx web/src/triage/TimingBox.test.tsx web/src/triage/TriagePage.tsx web/src/i18n/en.ts web/src/i18n/zh.ts
git commit -m "feat(web): Triage 新增 Timing looks off 区（偏移收件箱：Fix/Undo 接 correct/revert）"
```

**给 Task 24（Dormant 区 + 四区单列重排 + Triage 收口）的备忘：** `src/triage/` 已全脱 Astryx；Timing 区
挂在两箱下方（临时布局）。Task 24 三件：① **Dormant tasks · N** 新区（`useDormantTasks()`，`DormantTaskDTO
= {jobId, task, targetLabel, attempts}`，**零按钮**——§3 决策 1 唤醒通道不补；行 = 灰点 + `targetLabel`
+ `"Failed N times, automatic retries stopped."`（新拟英文句，前端用 `attempts` 组，中文 reason 不透传）+
右端 mono 裸 `task` 工具名）；② **四区单列重排**——`.triage-boxes` 从 `1.2fr 1fr` 两箱改成单列收件箱
（Pending → Excluded → Timing → Dormant 顺序，§5.5），或直接四个 `.triage-box` 竖排；③ Triage 收口——
全页集成测试（四区齐渲染、dormant 零按钮断言、Restore 仅 excluded、侧栏 badge 语义 `Sidebar.tsx:47`），
`Dormant` 的"Failed N times…"句登记 §5.7。相对时间/撞车三铁律照旧；`agoLabel` 在 `text.ts` 模块内可复用。

---

### Task 24: Dormant 区 + 四区单列重排（Triage 收口）

Triage 三件的收尾。三块：

- **Dormant tasks · N 区**（新增，§5.5 第四区）：读 `useDormantTasks()`，行 = 灰点 + `targetLabel`
  + `"Failed N times, automatic retries stopped."`（新拟英文句，前端用 `attempts` 组）+ 右端 mono 裸工具名；
  **零按钮**（§3 决策 1：唤醒通道不补，别画打不通的按钮）；
- **四区单列重排**：`.triage-boxes` 从两箱 `1.2fr 1fr` 改成单列收件箱，四区按 §5.5 顺序竖排
  （Pending → Excluded → Timing → Dormant）；
- **Triage 收口**：全页集成测试（四区齐渲染、dormant 零按钮、Restore 仅 excluded 桶）。

`src/triage/` 到本 task 全部脱 Astryx（Task 22/23 已迁完组件；Dormant 是新组件、天生无 Astryx）。

**Files:**
- Modify: `web/src/styles.css`（`.triage-boxes` 两箱 grid → 单列 flex；删多余 `@media` 两列覆盖）
- Modify: `web/src/triage/text.ts`（加 `dormantReasonLine()`）
- Create: `web/src/triage/DormantBox.tsx`
- Modify: `web/src/triage/TriagePage.tsx`（`.triage-boxes` 内四区竖排，挂 `<DormantBox />`）
- Modify: `web/src/i18n/en.ts` + `web/src/i18n/zh.ts`（加 `triage_dormant_heading`）
- Create: `web/src/triage/DormantBox.test.tsx`
- Modify: `web/src/triage/text.test.ts`（追加 `dormantReasonLine` 单测）
- Modify: `web/src/triage/TriagePage.test.tsx`（既有保绿；追加四区集成锁 1 条）

两个 commit：① Dormant 区（text/组件/i18n/测试）；② 四区单列重排 + TriagePage 接线 + 集成锁。

> **修订登记（2026-08-03，controller 裁决携带项，实现轮已落地）：**
> - **C1**（Task 23 评审 Minor）：TimingBox 行标签 span 补 `title={timingRowLabel(row)}`——truncate 在窄宽
>   吃掉集号后缀，title 给完整标签（与 ExcludedRow `title={row.path}` 平齐）。上方 Task 23 组件块已同步。
> - **C2**（Task 3 评审 Minor）：DormantBox targetLabel span 同补 `title={row.targetLabel}`——多长季标签
>   截断时 tooltip 是诚实兜底。下方 Step 4 组件块已同步。
> - **C3**：Step 9 集成锁追加一条断言锁截断兜底平齐（Timing 行标签带 title）。下方集成锁块已同步。
>
> **修订登记二（2026-08-04，实现评审轮，amend 进 commit ②）：**
> - 集成锁名下"Restore 仅 excluded 桶"补上真断言（展开 excluded 箱后 findAllByRole 'Restore' 恰 1 枚
>   且落在 Excluded extras 箱——箱默认折叠、闭合时内容不挂载，故须先 fireEvent.click 触发器）。
> - 集成锁追加四区 DOM 顺序锁（四个 .triage-box 的 textContent 依序含 Pending/Excluded extras/Timing looks off/Dormant tasks）。
> - 陈旧注释两处刷新：styles.css F5 段 opener（两箱→四区单列收件箱）、AppShell.tsx TriagePage 描述
>   （两箱+认领对话框→四区收件箱、认领已退役）。

---

#### 背景一：Dormant 区——四屏里唯一的"零动作"新区

数据源 `useDormantTasks(): Async<DormantTaskDTO[]>`（`hooks.ts`，Plan C Task 5）。
`DormantTaskDTO = { jobId: number, task: string, targetLabel: string, attempts: number }`（四键封闭；
**刻意无 reason**——现网是中文内部串，不透传；**刻意无任何时刻字段**——草稿 6 dormant 行不渲染时刻）。

**行的三段 + 零按钮**（§5.5）：
- 灰点：`<span className="size-[5px] shrink-0 rounded-full bg-weak" aria-hidden="true" />`（`--color-weak`
  #6b7280，"停摆"是中性事实、不是错误，所以灰不是红——铁律①红只给卡死层，dormant 是"自动重试已停"
  的平静陈述）；
- `targetLabel`（后端组好的"The Rig, Season 2"粒度，前端**不拼**）；
- `"Failed N times, automatic retries stopped."` = `dormantReasonLine(row.attempts, lang)`（新拟英文句，
  §4.2 明确"前端用 attempts 组"，中文内部 reason 不进 DTO）；
- 右端 mono 裸工具名 `row.task`（如 `find_subtitle`，弱显——草稿 6 L367-377 的既有惯例）；
- **零按钮**：spec §3 决策 1 明确唤醒通道不补（`jobsRepo.ts:440` 无 wake 实现，补它是新写路径+状态机新边，
  超"换视觉"范畴）。所以行里**没有任何 `<button>`**——这是本区的硬契约，集成测试专门锁它。

空清单（`data.length===0`）→ 整区不渲染（同 Timing，零预告）。区头 `"Dormant tasks · N"`。行布局走 Tailwind
内联（同 Timing 区，理由见 Task 23 背景二）。

`dormantReasonLine`：

```ts
/** dormant 行的英文事实句（§4.2/§5.5 新拟，前端用 attempts 组；中文 reason 内部串不透传）。 */
export function dormantReasonLine(attempts: number, lang: Lang): string {
  return lang === 'zh'
    ? `失败 ${attempts} 次，已停止自动重试。`
    : `Failed ${attempts} times, automatic retries stopped.`
}
```

新拟文案一键（§5.7 登记）：`triage_dormant_heading` → en `'Dormant tasks'` / zh `'停摆任务'`。
（"Failed N times…"带数字，走 `text.ts` 不进扁平表。）

#### 背景二：四区单列重排

现状（Task 22/23 后）：`head` + `.triage-boxes`(两箱 `1.2fr 1fr` = Pending | Excluded) + `<TimingBox/>`
挂在下方。§5.5 的目标是**单列收件箱**，四区按序竖排。改法：

- `.triage-boxes`：`grid` + `grid-template-columns:1.2fr 1fr` + `@media` 两列覆盖 → **单列 flex**
  （`display:flex; flex-direction:column; gap:16px`）。`@media (max-width:767px)` 那条两列→单列的覆盖
  **删掉**（单列本就无需窄屏特判）；
- `TriagePage` 把四区全放进 `.triage-boxes`，按 §5.5 序：`PendingBox` → `ExcludedBox` → `TimingBox` →
  `DormantBox`。Excluded/Timing/Dormant 空时各自渲染 null，单列自然略过——不留空箱。

（PendingBox 恒渲染（空库给 EmptyState）；其余三区空则消失。这正是收件箱语义：只显"有东西"的区。）

#### 背景三：既有 `TriagePage.test` 保绿 + 新集成锁

既有 8 条（Task 22 后）都不碰两箱布局的**视觉**（jsdom 不算 layout），只碰 `.triage-actionable-groups`/
`.triage-dirgroup-tail`/文案/计数——单列重排后一律照绿。但集成测试的 `mockFetchRouted` 现在会多命中两个
新端点（`/subtitle/shifted`、`/workflow/dormant`）——既有用例只 stub 了 `/api/v2/triage`，另两个落
`mockFetchRouted` 的 404 兜底 → `useShiftedSubtitles`/`useDormantTasks` 拿到 error、`data` 保持 null →
Timing/Dormant 区渲染 null。**所以既有 8 条不受影响**（Timing/Dormant 本就不出现）。新集成锁单独 stub 三端点。

---

- [ ] **Step 1: 跑基线**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/
```

Expected: **TriagePage 8 / ExcludedBox 4 / TimingBox 5 / text 6**。有红先停下报告。

- [ ] **Step 2: `text.ts` 加 `dormantReasonLine` + 单测**

追加 `dormantReasonLine` 到 `web/src/triage/text.ts`。`text.test.ts` 追加：

```ts
import { dormantReasonLine } from './text.js'

describe('dormantReasonLine', () => {
  it('en', () => { expect(dormantReasonLine(5, 'en')).toBe('Failed 5 times, automatic retries stopped.') })
  it('zh', () => { expect(dormantReasonLine(5, 'zh')).toBe('失败 5 次，已停止自动重试。') })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/text.test.ts
```

Expected: 全绿（含新增 2 条 → text 8）。

- [ ] **Step 3: 加 i18n 键**

`en.ts`：`triage_dormant_heading: 'Dormant tasks',`　`zh.ts`：`triage_dormant_heading: '停摆任务',`

- [ ] **Step 4: 建 `DormantBox.tsx`**

```tsx
// web/src/triage/DormantBox.tsx：Triage 第四区「Dormant tasks · N」（spec §5.5）——自动重试已停的
// 停车任务，只读。行 = 灰点 + targetLabel + "Failed N times, automatic retries stopped." + 右端 mono
// 裸工具名。**零按钮**：唤醒通道 spec 明确不补（§3 决策 1），别画打不通的按钮。灰不是红：停摆是
// 平静事实、不是卡死（铁律①红只给卡死层）。空清单整区不渲染。无时刻字段（DTO 刻意不带）。
import type { DormantTaskDTO } from '../api/types.js'
import { useDormantTasks } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { dormantReasonLine } from './text.js'

export function DormantBox() {
  const { t, lang } = useT()
  const dormant = useDormantTasks()
  const rows: DormantTaskDTO[] = dormant.data ?? []
  if (rows.length === 0) return null

  return (
    <div className="triage-box">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_dormant_heading')}</span>
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">· {rows.length}</span>
        </div>
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <div key={row.jobId} className="flex items-center gap-3 rounded-[4px] border border-border bg-secondary px-3 py-2">
              <span className="size-[5px] shrink-0 rounded-full bg-weak" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-foreground" title={row.targetLabel}>{row.targetLabel}</span>
              <span className="shrink-0 text-[11px] leading-4 text-muted-foreground">{dormantReasonLine(row.attempts, lang)}</span>
              <span className="shrink-0 font-mono text-[11px] leading-4 text-weak">{row.task}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 建 `DormantBox.test.tsx`**

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { DormantBox } from './DormantBox.js'
import type { DormantTaskDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const row = (over: Partial<DormantTaskDTO> = {}): DormantTaskDTO =>
  ({ jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5, ...over })

function stub(rows: DormantTaskDTO[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/workflow/dormant')) {
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const wrap = () => render(<I18nProvider initialLang="en"><DormantBox /></I18nProvider>)

describe('DormantBox', () => {
  it('空清单 → 整区不渲染', async () => {
    stub([])
    const { container } = wrap()
    await waitFor(() => expect(container.querySelector('.triage-box')).toBeNull())
  })

  it('有停车任务 → 区头计数 + targetLabel + 事实句 + mono 裸工具名', async () => {
    stub([row()])
    wrap()
    expect(await screen.findByText('Dormant tasks')).toBeInTheDocument()
    expect(screen.getByText('The Rig, Season 2')).toBeInTheDocument()
    expect(screen.getByText('Failed 5 times, automatic retries stopped.')).toBeInTheDocument()
    expect(screen.getByText('find_subtitle')).toBeInTheDocument()
  })

  it('铁律：dormant 行零按钮（唤醒通道不补，§3 决策 1）', async () => {
    stub([row(), row({ jobId: 2, targetLabel: 'Silo, Season 1' })])
    const { container } = wrap()
    await screen.findByText('The Rig, Season 2')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/DormantBox.test.tsx && npx tsc --noEmit
```

Expected: **3 passed** + tsc 无输出。

- [ ] **Step 6: Commit ①**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/triage/text.ts web/src/triage/text.test.ts web/src/triage/DormantBox.tsx web/src/triage/DormantBox.test.tsx web/src/i18n/en.ts web/src/i18n/zh.ts
git commit -m "feat(web): Triage 新增 Dormant tasks 区（只读、零按钮、灰点平静事实）"
```

- [ ] **Step 7: 四区单列重排 CSS**

`web/src/styles.css` 的 `.triage-boxes` 改成单列，删掉 `@media (max-width:767px)` 那条两列覆盖：

```css
/* ---- 四区单列收件箱（TriagePage，§5.5）——Pending → Excluded → Timing → Dormant 竖排。
   （原两箱 1.2fr 1fr 双列已随四区升级退役。） ---- */
.triage-boxes {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
```

- [ ] **Step 8: TriagePage 挂 DormantBox + 四区竖排**

`web/src/triage/TriagePage.tsx`：`import { DormantBox } from './DormantBox.js'`；成功分支 return 改成：

```tsx
  return (
    <Section>
      <div className="flex flex-col gap-4">
        {head}
        <div className="triage-boxes">
          <PendingBox actionable={actionable} />
          <ExcludedBox excluded={excluded} onRestore={handleRestore} />
          <TimingBox />
          <DormantBox />
        </div>
      </div>
    </Section>
  )
```

- [ ] **Step 9: 集成锁 + 全绿**

`TriagePage.test.tsx` 末尾追加（stub 三端点，锁四区齐 + dormant 零按钮 + Restore 仅 excluded）：

```tsx
// ── 四区集成锁（Task 24：Triage 收口）
describe('TriagePage：四区收件箱集成', () => {
  const NOW2 = Date.now()
  it('三端点齐 → Pending/Excluded/Timing/Dormant 四区齐渲染；dormant 零按钮；Restore 仅 excluded 桶', async () => {
    vi.stubGlobal('fetch', mockFetchRouted([
      { path: '/api/v2/triage', body: { pending: [
        { path: '/media/tv/Show A/S01/a-ep1.mkv', parkReason: 'ambiguous match', firstSeen: NOW2 - 60_000, lastAttempt: NOW2 },
        { path: '/media/tv/Extras/x.mkv', parkReason: 'excluded-extra', firstSeen: NOW2 - 60_000, lastAttempt: NOW2 },
      ] } },
      { path: '/api/v2/subtitle/shifted', body: [
        { itemId: 'it-1', seriesId: 'tmdb:1', seriesName: 'Peacemaker', season: 2, episode: 3, checkedAt: NOW2 - 2 * 3_600_000, hasPriorCorrection: true },
      ] },
      { path: '/api/v2/workflow/dormant', body: [
        { jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5 },
      ] },
    ]))
    const { container } = renderPage()

    // 四区标题齐（Pending 恒在；Excluded/Timing/Dormant 有数据故在场）。
    expect(await screen.findByText('Pending')).toBeInTheDocument()
    expect(screen.getByText('Excluded extras')).toBeInTheDocument()
    expect(await screen.findByText('Timing looks off')).toBeInTheDocument()
    expect(await screen.findByText('Dormant tasks')).toBeInTheDocument()

    // 四区按 §5.5 序竖排——DOM 顺序锁（Pending → Excluded → Timing → Dormant）。
    const boxes = [...container.querySelectorAll('.triage-box')].map((el) => el.textContent ?? '')
    expect(boxes).toHaveLength(4)
    expect(boxes[0]).toContain('Pending')
    expect(boxes[1]).toContain('Excluded extras')
    expect(boxes[2]).toContain('Timing looks off')
    expect(boxes[3]).toContain('Dormant tasks')

    // Timing 行可 Fix；Dormant 行零按钮（唤醒通道不补）。
    expect(screen.getByRole('button', { name: 'Fix the timing' })).toBeInTheDocument()
    const dormantRow = screen.getByText('The Rig, Season 2').closest('.triage-box')!
    expect(dormantRow.querySelectorAll('button')).toHaveLength(0)

    // Restore 只出现在 excluded 桶（本集成锁名下三约之一，之前只写在名字里）——
    // excluded 箱默认折叠（defaultOpen=false），Radix Collapsible 闭合时内容不挂载，
    // 先展开再断言（评审 Fix 1 的机械适配：原句 getAllByRole 在折叠态找不到按钮）。
    fireEvent.click(screen.getByRole('button', { name: /Excluded extras/ }))
    const restoreButtons = await screen.findAllByRole('button', { name: 'Restore' })
    expect(restoreButtons).toHaveLength(1)
    expect(restoreButtons[0]!.closest('.triage-box')!.textContent).toContain('Excluded extras')

    // C3（Task 23/24 评审携带，controller 裁决）：截断兜底平齐锁——Timing 行标签带 title。
    expect(screen.getByText('Peacemaker S2E03')).toHaveAttribute('title', 'Peacemaker S2E03')
  })
})
```

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && npx vitest run src/triage/ && npx tsc --noEmit
```

Expected: 全绿（TriagePage 9 / ExcludedBox 4 / TimingBox 5 / DormantBox 3 / text 8）+ tsc 无输出。

- [ ] **Step 10: Triage 目录收口核对**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web && grep -rn "astryxdesign" src/triage/ || echo "triage/ clean"
```

Expected: 打 **`triage/ clean`**——**`src/triage/` 目录收口**（六个组件全在新栈，两个新区天生无 Astryx）。

- [ ] **Step 11: Commit ②**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout
git add web/src/styles.css web/src/triage/TriagePage.tsx web/src/triage/TriagePage.test.tsx
git commit -m "feat(web): Triage 四区单列收件箱重排（Pending/Excluded/Timing/Dormant）—— triage 目录收口"
```

**给 Task 25（Settings·Behavior 区）的备忘：** `src/library` + `src/triage` 均已收口。剩余 Astryx：
`src/settings`（25-27）、`src/shell`（28-29）、掉队件 `auth`/`subtitleVerify`/`workflow/RerunDialog`/
`RunDetail`/`SetupWizard`（30）。Settings（§5.6）六键 Behavior 区（`SETTINGS_KEYS`，`apiV2.ts:515-518`）：
`target_languages`(chips)/`ai_translate_enabled`(switch)/`hardsub_mode`(**select**，枚举 off/agent/aggressive，
`apiV2.ts:621`，用 Task 7 的 shadcn `select` + `testSupport/radix.ts` 的 `openRadixSelect`)/`exclude_extras`
(switch)/`scan_interval_ms`(number)/`trace_retention_days`(number)；描述句**对照 en.ts settings 区逐字核定**
（草稿示意句不作数，铁律③）；`target_languages` 生效文案 = `en.ts:189-190` `"Takes effect on the next
library scan."`（**不得写 restart**）；Behavior 区还落 Spec A 的 Engine 开关（与 hero 同键）。Settings 是
交互件最密的一屏（Button/Input/Switch/Select 全用上），撞车三铁律 + 语义色映射照旧（见 Task 19/21 背景）。

---

---

## 阶段五 · Settings 屏（Task 25-27）

> 2026-08-04 补写（执行期事实图：10 个 settings 文件的 Astryx 调用点与测试锚点已全部逐行核实）。
> 三个 task 共用一条核心映射纪律（下称"Settings 控件事典"）：
>
> | Astryx | 新栈 | 关键接线 |
>|---|---|---|
> | `Switch label={t(key)} value onChange isLoading status` | shadcn `Switch`（Plan A copy-in，无 label prop） | **props 改名：`value`→`checked`、`onChange`→`onCheckedChange`（Radix 签名——写成 onChange 编译不过）**；`aria-label={t(key)}` 手写（可及名契约），可见文案放旁边 `<span>`；`status` 错误 → 行内红字 `<p role="alert" className="text-fn-red text-[11px]">`（**role="alert" 必带**——Astryx FieldStatus 靠 role="alert"+aria-live 让 SR 播报错误，朴素 `<p>` 是静默的；条件插入即自动播报。Switch/TextInput/Selector/NumberInput 五类行通用，Task 26/27 照此）；isLoading → `disabled={saving}` |
> | `TextInput label value onChange(v) placeholder description status` | shadcn `Input` + `aria-label` | Astryx `onChange` 直接吃新值——shadcn 是 `(e) => e.target.value`；description → 弱色小字段落；status 同上 |
> | `Selector label value onChange options isDisabled status` | Task 7 的 Radix `Select` 五件 | **测试从 click 改 `openRadixSelect`**（testSupport/radix.ts——本仓唯一一处开仓点在 `:125-126`）；`role="option"` 查询带 `hidden: true` 照旧有效（Radix 关闭时内容在脱离文档的 portal） |
> | `NumberInput label value onChange onBlur onEnter isIntegerOnly min placeholder hasClear isDisabled status` | shadcn `Input type="number"` + 手写 blur/Enter 提交 | `role="spinbutton"` 由 `type="number"` 自动提供；`isIntegerOnly` → `step={1}`；`hasClear` 丢（清零=删空即可，既有测试无此断言）；`onEnter` → `onKeyDown` Enter 分支 |
> | `Button label={…} … isLoading isDisabled` | shadcn `Button`（children + `disabled`） | 文案进 children；`isLoading` 丢（既有测试不断言 spinner——丢之前逐文件核实） |
> | `EmptyState title description isCompact actions` | Task 8 的 `empty-state.tsx` | 同名零改 |
> | `Banner status="warning" title` | Task 8 的 `banner.tsx` | 同名 |
> | `StatusDot variant label` | Task 8 的 `status-dot.tsx` | variant 域 success/error/neutral——ProvidersSection 用的就是这三个 |
> | `AlertDialog isOpen onOpenChange title description actionLabel actionVariant isActionLoading onAction` | Task 7 的 `alert-dialog.tsx`（Radix） | **结构不同**：Radix 是组合式（Content/Header/Title/Description/Footer/Action/Cancel），title/description 是 JSX 不是字符串；`actionVariant="destructive"` → Action 上 `className={buttonVariants({variant:'destructive'})}`；`isActionLoading` → `disabled={busy}`；**Radix 关闭即整棵卸载**（Astryx 动画期留尸——TranslateSection.test 那条"关闭后 title 还在 DOM"的注释就此作废，测试按 role 缺席判关，本来就对） |
> | `Text type="label"` | `<span className="text-[13px] font-medium leading-5 text-foreground">` | label 13/500/20 |
> | `Text type="supporting" color="secondary"` | `<span className="text-[11px] leading-4 text-muted-foreground">` | supporting 11/400/16 |
> | `Text type="code" color="secondary"` | `<span className="font-mono text-[13px] leading-5 text-muted-foreground">` | code 13/mono/20 |
> | `Text type="body"` | `<span className="text-[13px] leading-5">` | 不给颜色类（继承） |
> | `VStack gap={n}` / `HStack gap={n}` | `<div className="flex flex-col gap-n">` / `<div className="flex items-center gap-n">` | 逐值 |

### Task 25: Settings —— SettingsPage + BehaviorSection（全 plan 最硬的一 task）

**Files:**
- Modify: `web/src/settings/BehaviorSection.tsx`（删 8 行 Astryx import；五行控件全换 + useFieldCommit 保留）
- Modify: `web/src/settings/SettingsPage.tsx`（删 1 行 `VStack`；换 `<div className="flex flex-col gap-8">`）
- Modify: `web/src/settings/BehaviorSection.test.tsx`（**只允许两类改动**：① Selector 唯一一处开仓点（`:125-126`）的 click→openRadixSelect（`:57`/`:92` 只读闭态触发器文本，不动）；② 如 shadcn 化后某锚点非改不可，逐条在报告里登记——目标是一条都不改）
- Modify: `web/src/settings/EngineRow.test.tsx`（同纪律——目标零改动）
- Test （新锁）: 追加到 `BehaviorSection.test.tsx` 末尾一个 `describe`（迁移锁，3 条）

**为什么最硬**：BehaviorSection 是全仓富 API 控件最密的文件（Switch/TextInput/Selector/NumberInput/Button 五种），
而它的测试文件有 12 条 role+name 硬契约（recon 已逐条登记）：
`textbox 'Target languages'` / `combobox 'Hardsub assumption'` + `option 'Off'` / `switch 'Exclude extras'` /
`switch 'Engine'`（EngineRow.test）/ `spinbutton 'Trace retention (days)'` / `spinbutton 'Scan interval (ms)'` /
`button 'Retry'` + 五句生效文案锚点 + 一条错误文案正则 + PUT body 断言四条。**迁移后这些必须逐字照绿**
——可及名全部靠 `aria-label` 手写对齐（Astryx 是把 label prop 提升为可及名）。

**hardsub_mode 的 Selector → Radix Select 是本 task 唯一的测试改写面。** Astryx Selector 点开用
`fireEvent.click(combobox)`；Radix Select 的触发器听 `pointerdown`——**测试必须改成 `openRadixSelect(trigger)`**
（Task 7 的 testSupport/radix.ts，计划外的第三种打开方式不存在）。Radix 的 option 在关闭时位于脱离文档的
portal，`queryByRole('option', { hidden: true })` 依旧查不到、打开后 `findByRole('option')` 可查——所以
`:125-126` 的语义不变，只换打开方式。对照改法（测试侧唯一允许的机械改动）：

```tsx
// 改前（Astryx Selector）：
fireEvent.click(screen.getByRole('combobox', { name: 'Hardsub assumption' }))
expect(await screen.findByRole('option', { name: 'Off', hidden: true })).toBeInTheDocument()
// 改后（Radix Select）：
openRadixSelect(screen.getByRole('combobox', { name: 'Hardsub assumption' }))
expect(await screen.findByRole('option', { name: 'Off', hidden: true })).toBeInTheDocument()
```

**实现样板**（HardsubModeRow——其余四行照"控件事典"同构）：

```tsx
function HardsubModeRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_hardsub_mode_label')}</span>
      <Select
        value={settings.hardsub_mode ?? 'off'}
        onValueChange={(v) => void commit('hardsub_mode', v)}
        disabled={saving}
      >
        <SelectTrigger aria-label={t('settings_hardsub_mode_label')} className="max-w-[280px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* 每个 SelectItem 挂 onClick 提交：受控 Radix 的 onValueChange 对同值重选去重不发，
              而 Astryx Selector 重选同值照常 onChange（既有用例在 null→'off' 兜底下重选 'Off'
              断言 PUT）——鼠标提交走 item onClick 对齐 Astryx 语义，onValueChange 留给键盘；
              改值时双路径同拍各调一次 commit，由 inFlightRef 同步闸去重（Task 25 实施期实证）。 */}
          <SelectItem value="off" onClick={() => void commit('hardsub_mode', 'off')}>{t('settings_hardsub_mode_option_off')}</SelectItem>
          <SelectItem value="agent" onClick={() => void commit('hardsub_mode', 'agent')}>{t('settings_hardsub_mode_option_agent')}</SelectItem>
          <SelectItem value="aggressive" onClick={() => void commit('hardsub_mode', 'aggressive')}>{t('settings_hardsub_mode_option_aggressive')}</SelectItem>
        </SelectContent>
      </Select>
      <span className="text-[11px] leading-4 text-muted-foreground">{t('settings_hardsub_mode_note')}</span>
      {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
    </div>
  )
}
```

要点逐条：① `value={settings.hardsub_mode ?? 'off'}`——settings 值可 null（未设），Astryx Selector 的
未设态显示什么以现网为准（先读现网 BehaviorSection 的 HardsubModeRow 取值写法，照它对齐 null 口径，
若它直接传 `settings.hardsub_mode` 给 Astryx 而其内部对 null 显示首项，则用 `?? 'off'` 并在注释里注明）。
② Radix `Select` 的 `onValueChange` 只在用户改选时触发，不会因受控值回写而循环。③ SelectTrigger 的
`aria-label` 就是 `combobox` 的可及名（既有断言取它）。④ `disabled` 而不是 `isDisabled`。

**TargetLanguagesRow 的 onBlur/onKeyDown 提交包装**：现状是 `<div onBlur={trySave} onKeyDown={Enter}>` 包
TextInput。换成 shadcn Input 后保留同一个 div 包装（行为不变：失焦/Enter 提交），Input 上
`aria-label={t('settings_target_languages_label')}` + `placeholder` 照旧 + `value/onChange` 受控。

**NumberSettingRow**：`Input type="number" min={1} step={1}` + `onBlur={trySave}` + `onKeyDown` Enter 分支 +
`placeholder`（'30'/'900000'）+ `aria-label`。`value` 是 `number|null`——受控 input 要 `value={draft ?? ''}`
+ `onChange={(e) => setDraft(e.target.value === '' ? null : Number(e.target.value))}`（空串↔null 互换，
既有"清空即删"语义）。注意 `Number('12abc')` 是 NaN——type=number 的浏览器已经只放行数字，jsdom 不拦，
测试只填合法值，现状语义保持；**trySave 加 `if (Number.isNaN(draft)) return` 早退闸**（真实浏览器把非法
输入清成 '' 走 null 早退，此闸永久关死 jsdom 限定的 String(NaN)='NaN' PUT 路径——Task 25 实施期 review 补入）。

**迁移锁（追加 3 条）**：

```tsx
describe('BehaviorSection：迁移锁', () => {
  it('六个控件的可及名与既有契约逐字一致（aria-label 手写对齐 Astryx label 提升）', () => {
    renderSection()
    expect(screen.getByRole('switch', { name: 'Engine' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Target languages' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Hardsub assumption' })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Exclude extras' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Trace retention (days)' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Scan interval (ms)' })).toBeInTheDocument()
  })
  it('DOM 里不再有 astryx-* 类名', () => {
    const { container } = renderSection()
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })
  it('Selector 换成 Radix Select 后 option 语义照旧（关闭不可及、pointerdown 可开）', async () => {
    renderSection()
    expect(screen.queryByRole('option', { name: 'Off', hidden: true })).toBeNull()
    openRadixSelect(screen.getByRole('combobox', { name: 'Hardsub assumption' }))
    expect(await screen.findByRole('option', { name: 'Off', hidden: true })).toBeInTheDocument()
  })
})
```

（`renderSection` 用既有 helper——**注意它要传 settings 参数**（`renderSection(settings)`，`renderSection()` 空调编译不过）；第三条与 `:125-126` 改写后的用例内容重复是**有意的**——一条是行为测试、
一条是迁移锁，锁负责在将来有人"换回 Astryx 写法"时立刻红。）

**Steps:**
1. 基线：`npx vitest run src/settings/`（BehaviorSection 12 + EngineRow 2 + 其余各文件既有数），有红先停。
2. 改测试文件的 Selector 三处打开方式（click→openRadixSelect）——此刻应红（Astryx 还在，pointerdown 打不开
   Astryx Selector…注意：若 Astryx Selector 的触发器也听 pointerdown，这一步可能意外绿；那就把这一步与组件
   迁移合并成一次红绿翻转，在报告里如实记录顺序）。
3. 迁 BehaviorSection.tsx（五控件 + 三态壳 + useFieldCommit 不动）+ SettingsPage.tsx（VStack→div）。
4. `npx vitest run src/settings/` 全绿 + `npx tsc --noEmit` + `grep -n astryxdesign` 两文件 clean。
5. 追加迁移锁 3 条，全绿。
6. Commit：`refactor(web): Settings Behavior 区 + 页壳卸 Astryx（五控件 aria-label 对齐可及名契约）`

### Task 26: Settings —— TranslateSection + ProvidersSection + SystemSection

**Files:**
- Modify: `web/src/settings/TranslateSection.tsx`（StatusDot/Switch/Banner/AlertDialog/Text/VStack 换新件）
- Modify: `web/src/settings/ProvidersSection.tsx`（Text/TextInput/Button/Switch/VStack/HStack/StatusDot 换新件）
- Modify: `web/src/settings/SystemSection.tsx`（Text/Button/VStack 换新件）
- Test: 三个测试文件**目标零改动**（没有任何例外——下面的要点全部对齐现网断言）；各自末尾追加迁移锁 1 条（无 astryx 子树）

**逐文件要点（全部按"控件事典"）**：

- **TranslateSection**：GateRow 的 StatusDot（success/neutral + label）→ Task 8 同款零改；
  主 Switch → shadcn Switch + `aria-label={t('settings_ai_translate_label')}`（既有用例 bare
  `getByRole('switch')` 单开关树，照绿）；dormant `Banner status="warning" title` → Task 8 同名零改
  （`data-testid="translate-dormant-warning"` 挂在哪层看现网——Banner 的根 div 接受 `...props` 透传）；
  确认 AlertDialog → Task 7 的 Radix 组合式：
  ```tsx
  <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('settings_translate_confirm_title')}</AlertDialogTitle>
        <AlertDialogDescription>{gateReady ? t('settings_translate_confirm_body_ready') : t('settings_translate_confirm_body_missing')}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={saving} onClick={(e) => { e.preventDefault(); onConfirm() }}>{t('settings_translate_confirm_action')}</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
  ```
  ⚠️ Radix AlertDialogAction 默认 **click 后自动关闭**——Astryx 的 `isActionLoading` 会让它在飞行中保持
  开启。现网语义（已核实）：`commitEnabled` 在 finally 里手动关，飞行中靠 isActionLoading 保持开启——
  所以 Action 的 onClick **必须** `e.preventDefault()` 阻止默认关闭（官方逃生口），成功/失败都交给
  现网的 finally 关。Cancel 文案用字面 `'Cancel'`（现网就是 Astryx 默认字面量，i18n 表里没有这个键——
  别为它加键，行为零变化）。i18n 键名已核实：`settings_translate_confirm_body_ready`/`_body_missing`（en.ts:225-228）。**逐字核对的既有断言**：开确认框的标题
  'Enable AI translation?'（getByText）、Enable 按钮（getByRole('button',{name:'Enable'})）、
  `fireEvent.keyDown(document.body, {key:'Escape'})` 取消（Radix 的 Escape 监听在 document 层，成立）、
  关闭判定 `queryByRole('dialog')` 缺席（Radix 整棵卸载——成立且更干净）。i18n 键名以现网文件为准。
- **ProvidersSection**：KeyedRow 的 Test/Edit/Save/Cancel 四钮（children 化，isLoading→disabled）；
  编辑态 TextInput → shadcn Input + `aria-label={s.name}`（`getByLabelText('ASSRT_TOKEN')` 的锚）+
  `placeholder={s.masked ?? ''}`；StatusDot（success/error + label）→ Task 8 同款；ToggleRow 的
  Switch → shadcn + `aria-label={PROVIDER_NAME[id]}` + `disabled={locked}`（既有
  `getByRole('switch')` + `toBeDisabled()` 锚在 testid  scoped 查询里，照绿）。⚠️ **结构钉**：
  `ProvidersSection.test.tsx:192-193/:206` 的 children 计数断言（okRow 2 / llm 5 / failRow 2）——
  KeyedRow 的根容器换成朴素 `<div className="flex flex-col gap-2" data-testid={…}>` 时**不许包出额外
  子节点**（VStack 是不包直接子的，换成 div 同样不包）。
- **SystemSection**：Re-run 按钮 children 化；`getByRole('button', { name: 'Re-run setup wizard' })` 照绿。

**迁移锁（每文件 1 条，追加到各自测试文件末尾）**：渲染后子树无 astryx-* 类名（TranslateSection 渲染
gate 三行 + Switch；ProvidersSection 用既有 PROVIDERS/SETUP fixture；SystemSection 直渲）。

**Steps:** ① 基线（TranslateSection 6 / ProvidersSection 11 / SystemSection 1）；② 迁三文件；
③ 三测试全绿 + tsc + 追加迁移锁后再全绿；④ `grep -rn astryxdesign src/settings/` 此时还剩
DeploySection/RootsManager/DirBrowser/RemoveRootDialog/SecuritySection（Task 27），照实登记；
⑤ Commit：`refactor(web): Settings Translate/Providers/System 三区卸 Astryx`

### Task 27: Settings —— DeploySection + RootsManager + DirBrowser + RemoveRootDialog + SecuritySection（Settings 收口）

**Files:**
- Modify: `web/src/settings/DeploySection.tsx`（Text/VStack 换标签——零交互件）
- Modify: `web/src/settings/RootsManager.tsx`（Text/Button/VStack/EmptyState 换新件）
- Modify: `web/src/settings/DirBrowser.tsx`（Text/Button/VStack/HStack 换新件；自绘 breadcrumb/entry 不动）
- Modify: `web/src/settings/RemoveRootDialog.tsx`（AlertDialog → Radix 组合式，两阶段复用保留）
- Modify: `web/src/settings/SecuritySection.tsx`（AlertDialog 换；Button 换；AuthField 本来就是原生、不动）
- Modify: `web/src/styles.css`（**settings 区段 token 迁移**：recon 登记的 :852-1015 全段——Geist Mono 字面栈 → `var(--font-mono)`，`--color-text-primary`→foreground / `-secondary`→muted-foreground / `-gray`→weak / `-disabled`→faint / `-green`→fn-green / `-red`→fn-red / `--color-background-surface`→secondary / `-card`→card / `--radius-inner`→字面 4px；`--color-border` 不动）
- Test: 五个测试文件目标零改动；各追加迁移锁 1 条（无 astryx 子树）

**要点**：

- **RemoveRootDialog / RerunDialog 型两阶段 AlertDialog**（confirm → result 复用同一个元素）→ Radix
  组合式：`phase` 状态机不变，Content 里按 phase 条件渲染 Title/Description/Footer；`actionVariant`
  destructive→secondary 的相位切换 → Action 的 className 条件换（`buttonVariants({variant})` 参数化）；
  `isActionLoading={phase==='submitting'}` → `disabled`；**Action 自动关闭问题同 Task 26**——两阶段的
  confirm→submitting 相位**不能在 confirm 点击时关**，所以 Action 的 onClick 里
  `e.preventDefault()` 阻止默认关闭、由 phase 推进到 done 后再 `onOpenChange(false)`。既有断言
  （`findByRole('alertdialog')`、`within(dialog).getByRole('button', {name:'Remove'})`、
  'removed 42 episodes · 3 series · 1 parked'、'/not a media root/'）全部按 role/文案锚定，与实现无关。
- **SecuritySection**：改密表单（真 `<form>` + AuthField）不动；API key 行的 Copy/Regenerate 两钮
  children 化；Regenerate 的 AlertDialog（destructive）同 RemoveRootDialog 手法。注意 `data-variant`
  断言**只在 SetupWizard.test 里**（Task 30 处理），SecuritySection.test 没有它。
- **DeploySection**：纯只读——Text/VStack 换标签；`.settings-deploy-*` 的 CSS 类名一个不换（断言
  有 `settings-deploy-key` 类名锚），只迁它们读的 token（本 task 的 styles.css 段）。零控件断言
  （`querySelectorAll('input, button, textarea, select')` 长度 0）必须照绿——**一个控件都不许引入**。
- **RootsManager/DirBrowser**：行内 Remove 钮、Add-a-root 钮、Add this directory 钮 children 化；
  DirBrowser 的自绘 breadcrumb/entry（原生 button + CSS 类）一个不动。

**Steps:** ① 基线（Deploy 7 / Roots 7 / DirBrowser 4 / Security 4）；② 迁五组件 + styles.css settings 段；
③ 全绿 + tsc；④ 追加迁移锁 5 条后再全绿；⑤ `grep -rn astryxdesign src/settings/` → **settings/ clean**；
⑥ Commit：`refactor(web): Settings Deploy/Roots/DirBrowser/Security 区卸 Astryx + settings 段 token 迁移——settings 目录收口`

---

## 阶段六 · 全局壳（Task 28-29）

### Task 28: AppShell + Sidebar + Topbar（导航三件）

**Files:**
- Create: `web/src/shell/SideNav.tsx`（自绘导航件——Astryx SideNav 无新栈对应物）
- Modify: `web/src/shell/AppShell.tsx`（AstryxAppShell → 自绘壳）
- Modify: `web/src/shell/Sidebar.tsx`（SideNav* → 自绘件调用）
- Modify: `web/src/shell/Topbar.tsx`（TopNav/Breadcrumbs → 语义标记 + 类；Kbd → Task 8 件）
- Modify: `web/src/styles.css`（shell 段 :11-39 token 迁移 + 侧栏选中态新规则；删 `.astryx-side-nav-item` 覆写）
- Test: `web/src/shell/Sidebar.test.tsx`（3 条保绿；追加迁移锁）+ 新建 `web/src/shell/SideNav.test.tsx`（选中态/徽标）

**要点**：

- **AstryxAppShell 的真实结构**（已核实 `AppShell.tsx:769-811` + `Layout.tsx:283-296`）：
  根是 **flex column, 100dvh** → **顶栏全宽在最前** → 中间行 `[侧栏 | 内容]`。DOM 序 = 顶栏先于侧栏
  （焦点序同）。自绘壳 = `<div className="flex h-screen flex-col">` → Topbar 全宽 →
  `<div className="flex flex-1 overflow-hidden">` 内 `SideNav`（**宽 260px**，SideNav.tsx:65——不是 240）
  + `<main className="flex-1 overflow-y-auto">`（contentPadding 0/4 → `p-0`/`p-4` 条件类）。
  **保留 skip-to-content 链接与 `role="main"`**（Astryx 壳有，AppShell.tsx:793-798——无测试覆盖但
  是真实无障碍件，保留成本一行）。
- **Sidebar**：`SideNavHeading`（wordmark）、`SideNavSection`（LIBRARY/AGENTS/SYSTEM 组名）、
  `SideNavItem`（`<a href="#/id">` + label + isSelected + endContent 徽标）。自绘 SideNav.tsx：
  ```tsx
  // web/src/shell/SideNav.tsx：自绘导航件（Astryx SideNav 无新栈对应物）。
  // 契约：item 是 <a>（App.test.tsx 的 findByRole('link', { name: 'Library' }) 靠它）；
  // 选中态走 aria-current="page"（比 data-selected 更正确的语义，样式按属性选）。
  export function SideNavItem({ href, label, selected, endContent }: {...}) {
    return (
      <a
        href={href}
        aria-current={selected ? 'page' : undefined}
        className="flex items-center justify-between rounded-control px-3 py-1.5 text-[13px] leading-5 text-muted-foreground transition-colors hover:bg-white/5 aria-[current=page]:bg-secondary aria-[current=page]:text-[var(--color-sidebar-active)]"
      >
        <span>{label}</span>
        {endContent}
      </a>
    )
  }
  ```
  （选中态颜色：Astryx 时代由 styles.css:37-39 的 `.astryx-side-nav-item[data-selected]` 覆写成
  `var(--color-accent)`——**柠檬绿撞车token**，过渡期它就是绿的。tw.css:34 **有**
  `--color-sidebar-active: #a3e635`（lime）——选中态文字用它（`aria-[current=page]:text-[var(--color-sidebar-active)]`
  或在 SideNav.tsx 里写死类），保住"当前页"的 lime 语义不脱钩；背景仍 `bg-secondary`。footer 的登出钮走 shadcn ghost。）
- **Topbar**：TopNav → `<div className="flex items-center justify-between border-b border-border px-4 py-2">`
  （先读现网 TopNav 的实际高度/边框再定类）；Breadcrumbs → `<nav aria-label="Breadcrumb"><ol className="flex items-center gap-1">`
  + `<li>` + 当前页 `aria-current="page"`；Kbd → Task 8 件（`keys="mod+k"` 零改）；freshness mono 行
  → `font-mono text-[13px] leading-5 text-muted-foreground`；cmdk-trigger 的原生 button 不动
  （`.cmdk-trigger` 的 CSS 迁 token：`--radius-element`→`--radius-control`、`:focus-visible` 的
  `--color-accent`→`--color-ring`——撞车惯例）。
- **App.test.tsx 的壳断言全部不许动**（`findByRole('link', { name: 'Library' })`、`getByText('Find anything')`、
  面包屑文案）——它们是壳的回归网。

**Steps:** ① 基线（Sidebar 3 + App.test 全套）；② SideNav.tsx + 三件迁移 + styles.css shell 段；
③ 全绿 + tsc；④ 迁移锁（Sidebar：选中项 `aria-current="page"` 在场、徽标计数渲染、无 astryx 子树）；
⑤ Commit：`refactor(web): 全局壳三件（AppShell/Sidebar/Topbar）卸 Astryx——自绘 SideNav，选中态走 aria-current`

### Task 29: CommandK —— 自绘命令面板（Astryx CommandPalette 退役）+ useHotkeys 换源

**Files:**
- Modify: `web/src/shell/CommandK.tsx`（整文件重写——CommandPalette/Typeahead 换 Task 7 dialog + 自绘过滤列表；`useHotkeys` 换 `./lib/useHotkeys.js`）
- Modify: `web/src/workflow/RunDetail.tsx` 的 `:17` import 换源（`@astryxdesign/core/hooks` → `../lib/useHotkeys.js`——**这一行随本 task 走**，因为 useHotkeys 旧源在 Task 31 消失，而 Task 29 是全仓键盘契约的验收点）
- Test: `web/src/shell/CommandK.test.tsx`（新建——把 App.test.tsx:198-233 那两条集成用例**搬**过来并扩到组件级；App.test.tsx 里那两条**保留不动**）

**为什么自绘而不装 cmdk**：Task 6 的依赖闭集是审计过的——不在这里加第八个运行时包。命令面板的
全部契约只有六条（recon Q8 + 2026-08-04 修正案）：开时 `role="dialog"`、输入框 `role="combobox"`、Escape 关、点项跳转+关、
项在侧栏之后的 DOM 序。⑥ 方向键移动高亮 + Enter 激活（aria-activedescendant/aria-selected 配套）——
2026-08-04 spec 审对抗扫描抓获的 recon 漏项（Astryx BaseTypeahead.js:403-446 本就有 ArrowUp/ArrowDown/Enter，
wrap 不 clamp、hover 同步高亮、结果集变化重置首项），plan 作者裁决补入。数据源是**静态 4 个 tab**（`createStaticSource` 做的事就是按输入过滤），
自绘 = dialog.tsx + 一个 `role="combobox"` 的受控 input + `role="listbox"`/`role="option"` 过滤列表，
约百行，零新依赖。

**实现骨架**：

```tsx
// web/src/shell/CommandK.tsx：⌘K 命令面板——自绘（Astryx CommandPalette/Typeahead 退役）。
// 五条硬契约（App.test.tsx:198-233 与 CommandK.test.tsx 压着的）：
//   ① 开时 role="dialog"、关时整棵不在 DOM（Radix Dialog 卸载语义免费给）；
//   ② 输入框 role="combobox"（aria-expanded/aria-controls 配套）；
//   ③ Escape 在 combobox 上按下 → 关（Radix Dialog 的 Esc 监听在 document，jsdom 里从 input 冒泡到 document 即触发）；
//   ④ 点项 → 跳转 + 关；
//   ⑤ 项渲染在侧栏之后的 DOM 序（面板在壳外 portal——天然满足）。
import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.js'
import { useHotkeys } from '../lib/useHotkeys.js'
// …（useT、TABS、route 的 go 等既有 import——真实形状：现网 `:23` 是
//    createStaticSource(TABS.map((m) => ({ id: m.id, label: t(m.labelKey) })))，TABS 来自 tabs.ts，
//    共 **4** 个 tab（library/workflow/triage/settings），go() = location.hash 赋值（route.ts:53-55））

export function CommandK({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  useHotkeys([{ keys: 'mod+k', onPress: () => onOpenChange(true) }])

  const items = useMemo(() => {
    const all = TABS.map((m) => ({ id: m.id, label: t(m.labelKey) }))
    const q = query.trim().toLowerCase()
    return q === '' ? all : all.filter((it) => it.label.toLowerCase().includes(q))
  }, [query, t])
  // 过滤语义：子串匹配（4 个静态 tab，Astryx createStaticSource 的 fuzzy 在这里没有可感差异；
  // 若将来项变多再升级，不在本 task）。

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 p-0 sm:max-w-md" /* 面板上移：命令面板不是居中对白；关 X（会压住输入框）；宽一档收窄 */>
        <DialogTitle className="sr-only">{t('cmdk_label')}</DialogTitle>
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-label={t('cmdk_label')}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
          placeholder={t('cmdk_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul role="listbox" id="cmdk-list" className="max-h-[300px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <li className="px-3 py-2 text-[13px] text-muted-foreground">{t('cmdk_empty')}</li>
          ) : items.map((it) => (
            <li
              key={it.id}
              role="option"
              aria-selected="false"
              className="cursor-pointer rounded-[4px] px-3 py-2 text-[13px] leading-5 hover:bg-white/5"
              onClick={() => { go(it.id); onOpenChange(false) }}
            >
              {it.label}
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
```

**逐条核对再落笔**：TABS/tab 列表的真实来源（现网 `:23` 的 createStaticSource 吃的是什么数组）、
`go()` 的现状（hash 跳转函数在哪）、`cmdk_empty`/`cmdk_label`/`cmdk_placeholder` 键的现名、
`useHotkeys` 在打开/关闭两态的注册现状（现网只在组件挂载即注册——`isOpen` 不影响 mod+k，照抄）。
**App.test.tsx 那两条不许动**——它们若红，说明契约破了，不许靠改测试过关。

**CommandK.test.tsx**（新建）至少锁：闭态无 dialog；open 后 dialog+combobox 在场；输入过滤
（'work' → Workflow 在、Library 不在）；Esc 关；点项 → hash 变 + 关；空查询全列出 4 项；
空结果文案；`useHotkeys` 换源后 `mod+k` 打开（fireEvent.keyDown(window, {key:'k', ctrlKey:true})——
jsdom 非苹果）。

**Steps:** ① 基线（App.test 全套绿）；② 重写 CommandK + RunDetail 换源；③ App.test + 新 CommandK.test
全绿 + tsc；④ Commit：`refactor(web): ⌘K 命令面板自绘（CommandPalette/Typeahead 退役）+ useHotkeys 换源`

---

## 阶段七 · 掉队件与卸载（Task 30-33）

### Task 30: 掉队件清仓（auth 三件 + InspectPanel/InspectBoundary + RerunDialog + RunDetail + 注释/死码零碎）

**Files:**
- Modify: `web/src/auth/LoginPage.tsx` / `ConnectionError.tsx` / `SetupWizard.tsx`（各只有 1 个 Astryx `Button`）
- Modify: `web/src/subtitleVerify/InspectPanel.tsx` / `InspectBoundary.tsx`（Astryx `Dialog`/`DialogHeader`/`Text` 换新件）
- Modify: `web/src/workflow/RerunDialog.tsx`（AlertDialog → Radix 组合式，同 Task 27 手法）
- Modify: `web/src/workflow/RunDetail.tsx`（Kbd/Switch/Text/VStack/HStack/Divider/Button/StatusDot 全换）
- Modify: `web/src/styles.css`（**五段 token 迁移**——auth + subtitleVerify + workflow + library/triage 的 6 处 Geist Mono 字面栈 + 两个漏网 token；含 `--color-accent` 硬编码 `#96da26` 回退值的处置）
- Modify: `web/src/tw.css`（**新增 `--color-fn-blue: #2694FE`**——workflow 蓝点的唯一出处，Astryx 基础主题值，scout 不遮蔽）
- Modify: `web/src/activity/ActivityPage.tsx`（删 `:29` 的 `stageFromTrail` 死 import）
- Modify: `web/src/activity/ActivityStuck.tsx:83` / `web/src/styles.css:372` / `web/src/workflow/text.ts:3` / `:57` / `web/src/i18n/en.ts:121`（五处 ActivityFeed 过期注释刷新）
- Test: `web/src/auth/SetupWizard.test.tsx`（**唯一允许的测试改写**：`:72`/`:76` 的 `data-variant` 断言）

**要点**：

- **auth 三件**：Button children 化；`LoginPage`/`SetupWizard` 的真 `<form>` 语义一寸不动
  （autocomplete/password-manager 契约是全仓最硬的）。**SetupWizard 的 `data-variant` 断言**：
  Astryx Button 往 DOM 上写 `data-variant` 属性，shadcn 不写。裁决：**改测试**——那两条断言锁的是
  "复制成功前后主按钮换色"（single-accent 规则），换成类名断言
  （`toHaveClass` 含 `bg-primary` / `bg-secondary`——cva 的类名在 DOM 里可读）。
  若类名断言不可行（tw-merge 合并顺序问题），退而用 `getByRole('button', { name: /copy/i })` 的
  存在性 + 视觉交给 Task 33 实机核对，并在报告里注明。
- **InspectPanel/InspectBoundary**：Astryx `Dialog`（`width="min(1080px, 94vw)" maxHeight="88vh"` +
  `DialogHeader title onOpenChange`）→ Task 7 的 dialog.tsx：
  ```tsx
  <Dialog open={isOpen} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[88vh] w-[min(1080px,94vw)] max-w-none overflow-y-auto sm:max-w-none">
      {/* ⚠️ 必须 sm:max-w-none：dialog.tsx 自带 sm:max-w-lg，twMerge 的 variant 组独立合并，
          裸 max-w-none 清不掉它——少了这个类，≥640px 视口下面板被钉死在 512px。 */}
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      …（.vinspect 容器与内容照旧）
    </DialogContent>
  </Dialog>
  ```
  既有 27 条 InspectPanel 断言全是 getByText/querySelector，与 Dialog 实现无关——照绿为验收。
  InspectBoundary 的 `data-testid="vinspect-failed"` 保留。
- **RerunDialog**：两阶段 AlertDialog，同 Task 27 RemoveRootDialog 的手法（preventDefault 阻止
  confirm 相位自动关闭）。
- **RunDetail**：`useHotkeys` 已在 Task 29 换源（本 task 只剩其余件）：Kbd→Task 8、Switch→shadcn
  （`labelSpacing="hug"` 丢掉——那是 Astryx 的排印 prop，换成行内布局类对齐现网间距，先读现网渲染再定）、
  Divider→Task 8 `separator.tsx`、StatusDot→Task 8、Button→shadcn、Text/VStack/HStack→标签。
  自管 `role="dialog"` + `.wf-rundetail-panel` 固定面板几何**不动**（它不是 Astryx 件）。
- **styles.css 五段 token 迁移**（审计后扩到五段，漏一段 Task 31 的 grep 门就过不去）：
  ① auth 段（:1016-1152）——`--color-accent` 带硬编码 `#96da26` 回退的写法（`:1089-1094`）迁
  `--color-ring`；`auth-error` 的硬 `#fb7185` → `var(--color-fn-red)`（**有意改值**写注释）。
  ② subtitleVerify 段（:1153-1385）与 ③ workflow 段（:371-744）——按事典映射表全量迁
  （text-*→新名、background-*→card/secondary、radius-inner→4px、font-code→font-mono、
  Geist Mono 字面栈→var(--font-mono)、--color-accent→按"面底 secondary / 可见强调 ring"分辨）。
  ④ **library/triage 段的 6 处 'Geist Mono' 字面栈**（`:309`、`:774`/`:788`/`:808`/`:826`/`:839`）
  ——Tasks 19-24 的区段只迁了颜色没迁字族，本 task 一并扫（→ `var(--font-mono)`）。
  ⑤ 两个审计抓获的漏网 token：`--color-icon-blue`（`:555`/`:613`/`:620`，workflow 蓝点/渐变条——
  值 #2694FE 取自 Astryx 基础主题，scout 未遮蔽；tw.css 无蓝档，**新增 `--color-fn-blue: #2694FE`**
  到 tw.css 的 Task 6 缺口 token 区，注释写出处）与 `--font-family-code`（`:463`——Astryx 基础主题的
  字族变量，直接换 `var(--font-mono)`）。
- **五处 ActivityFeed 过期注释**：ActivityFeed.tsx 已在 2bb6d10 删除——注释里引它的地方改成引
  `workflow/` 现存对应物或删句（逐条看上下文决定，纯注释）。

**Steps:** ① 基线（auth 12 + InspectPanel 29 + 其余各文件）；② 逐件迁移 + styles.css 五段；
③ 全绿 + tsc；④ 迁移锁（auth 三件各 1 条无 astryx；InspectPanel 1 条；RunDetail 1 条——
含 `role="dialog"` 与 Escape 关闭的钉）；⑤ `grep -rn astryxdesign web/src/` 此时**只剩 main.tsx**，
照实登记；⑥ Commit：`refactor(web): 掉队件清仓（auth/subtitleVerify/workflow）+ 五段 CSS token 迁移`

### Task 31: 卸载 Astryx（preflight 顶替 + theme 产物删除 + Theme 摘除）

**Files:**
- Modify: `web/src/styles.css`（删 `:7-9` 三行 `@import`）
- Modify: `web/src/tw.css`（顶部 import 区补 preflight）
- Modify: `web/src/main.tsx`（删 `Theme` 包裹与 `scoutTheme` import）
- Delete: `web/src/theme/`（整个目录：scout.ts/scout.d.ts/scout.css/scout.js）
- Modify: `web/package.json`（删 `@astryxdesign/core` dep + `@astryxdesign/cli` devDep + `theme:build` script）
- Modify: `web/src/styles.css` 残余（删 `.astryx-side-nav-item` 覆写段——若 Task 28 没删的话——及任何
  `astryx-*` 选择器残迹）

**铁序（不能乱）**：
1. **先补 preflight 再删 reset**：`tw.css` 顶部（`@import "tailwindcss/utilities.css"` 之前、
   `@import "tailwindcss/theme.css"` 之类的现有 import 区——按 Task 13 落地的实际 import 形状来）加
   `@import "tailwindcss/preflight" layer(base);`。Astryx reset.css 是 437 行真 reset
   （box-sizing/h1-h6 字号/margin 归零），直接删会让全站走形且零报错。
2. **preflight 进场的连带核对**（preflight 会改默认样式——Task 19 起各屏 h3 已写 `m-0` 的都有先见，
   但全站要复核）：`npm run build` 后逐屏目视（Task 33 的实机验收覆盖）；测试侧注意 preflight 的
   `button { background: transparent }` 等规则与自绘件的关系（我们所有按钮都显式给类，无恙）。
3. tw.css 文件头注释刷新（"不引 preflight"那段从此过时——preflight 已在，把理由改写成现状），然后 main.tsx 摘除 Theme：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
import './tw.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

（文件头注释改写：Theme/scout.css 的提及全部清掉，import 序的注释保留——tw.css 必须在 styles.css 之后。）
4. 删 `web/src/theme/` 整目录 + package.json 三处 + `npm uninstall` 后 `npm run build && npm test` 全绿。
5. **残留 grep 核销**（全零才算完）：

```bash
cd /Users/dirtyfancy/projects/subtitle-scout/web
grep -rn "from '@astryxdesign\|import.*astryxdesign\|require.*astryxdesign" src/ package.json index.html vite.config.ts
grep -rn "astryx-" src/ --include='*.tsx' | grep -v "astryx.*类名\|不再\|没有\|无 astryx\|现已\|曾是\|data-astryx"
perl -0777 -pe 's{/\*[\s\S]*?\*/}{}gs' src/styles.css | grep -c "Geist Mono\|--color-text-primary\|--color-text-secondary\|--color-text-gray\|--color-text-disabled\|--color-text-green\|--color-text-orange\|--color-text-red\|--color-background-body\|--color-background-card\|--color-background-surface\|--color-icon-blue\|--font-family-code\|--font-code\|--radius-element\|--radius-inner"
```

第一条预期**零命中**（**只查 import/require 行**——注释里的历史提及合法：ui/ 十一件与 useHotkeys/
setupTests 的文件头都有"抄自 Astryx"的溯源注释，那是审计资产，不删）。第三条预期 **0**
（perl 先剥块注释；行内 `//` 注释本文件没有）。还有一条总闸：**styles.css 里每个 `var(--x)` 都必须
能在 tw.css 里解析到**——`grep -oE 'var\(--[a-z-]+' src/styles.css | sort -u` 逐个对 tw.css 核销。
6. Commit：`chore(web): 卸载 @astryxdesign/core——preflight 顶替 reset，theme 产物删除，全栈新栈`

### Task 32: 全量验证（收口闸门）

1. `npm run check && npm test`（后端全量）。
2. `cd web && npx tsc --noEmit && npm test && npm run build`（前端全量 + 构建）。
3. `grep -rn "from '@astryxdesign\|import.*astryxdesign" web/src web/package.json web/index.html` → 零命中（只查 import 行；文件头溯源注释是审计资产，保留）。
4. `grep -rn "from '@astryxdesign/core/hooks'" web/src` → 零命中（useHotkeys 换源的专项核销）。
5. dist CSS 抽核：`--color-weak`、`--color-secondary`、`--color-ring`、`--animate-skeleton-fade`、
   `slide-in-from-top-2` 全在场；`preflight` 的 `box-sizing: border-box` 在场。
6. 若有任何修复，commit `chore: spec C 全量验证收口`。

### Task 33: 部署 + 实机四屏视觉验收（主控执行，非子代理）

部署走 `DEPLOY_SSH_HOST=media-router-wan DEPLOY_TIMEOUT_SECONDS=3000 timeout 1500 ./deploy/deploy.sh`
（LAN 22 口 banner 超时，走 WAN 隧道；dashboard 经 `ssh -N -L 18099:localhost:8099 media-router-wan`
持久隧道 + agent-browser 走查）。

**验收清单（逐条过，结果写进实现报告）：**
1. **四屏走查**（agent-browser）：Activity（hero + 传送带 shimmer + 发动机开关在右上角、功能正常）/
   Library（海报墙格阵 8 列封顶、焦点环紫色、骨架屏交错）/ 剧集详情（hero + 季手风琴开合 + 语义点色档）/
   Triage（四区单列、目录组折叠开合、Timing 区 Fix/Undo、Dormant 零按钮）/ Settings（**7** 区全、
   Behavior 六控件可操作：Switch 翻转、Select 开合选择、Number 输入提交、Provider 编辑保存、
   Re-run wizard 入口）。
2. **全局壳**：侧栏选中态、⌘K 开合/过滤/跳转/Escape、顶栏面包屑与 freshness、EngineBanner 关引擎时出现。
3. **专项核对（评审立案）**：① hero 开关窄视口碰撞（~480px 宽 + 长英文标题）；② OS 级 reduced-motion
   下传送带最新行退回纯文本（--color-foreground 兜底色）；③ Kbd 键帽视觉（自拟值首次实机看）；
   ④ shadcn 弹层动画在场（animate-in/fade/zoom——Task 6/7 静默失败的实机面）；⑤ 季手风琴
   accordion-down/up 动画；⑥ Settings 的 Select 弹层。（Settings 共 **7** 区：Behavior/Translate/Providers/Deploy/Roots/System/Security）
4. **回归确认**：setup wizard 不出现（env 部署零打扰，spec A §9 口径）；daemon 正常 tick；
   控制台零 error（agent-browser 读 console）。
5. 任何一项不过：回滚部署（git revert + 重部署），不带红灯收尾。

<!-- PLAN-TAIL-END -->
