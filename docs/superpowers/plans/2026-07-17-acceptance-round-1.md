# 验收修复轮一 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 铁律（本仓库既有纪律）：不用 Workflow 工具；不用 worktree；实现子代理 sonnet、主控逐 diff 亲核；前端子代理必读 `web/DESIGN.md` + spec §B 五铁律；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

**Goal:** 按 spec（docs/design/2026-07-17-acceptance-round-1-design.md，必读）落地用户首轮验收反馈：A 分区元数据化+富化重试、B Workflow 叙事化（全英文）、C 甄别目录组认领三件。

**Architecture:** 后端小刀（v13 迁移、enrich 扩展、两个端点扩容、requestIngest 闭包）+ 前端两页重排（workflow/ 重造、triage/ 重构）；既有 RunDetail/TraceRows 工程层零删除。

**Tech Stack:** 既有栈（better-sqlite3/zod/vitest；React 19+Astryx）。

**现状坐标（zero-context 者先读）**：`src/dashboard/apiV2.ts`（sectionOf/SECTION_LABELS 在 80-127 行附近；buildWorkflowWorkers/buildParked/claimParked）；`src/v2/ingest.ts`（enrichNewSeriesOrMovie 与 tv 分支调用点）；`src/v2/libraryRepo.ts`（upsertSeries）；`src/adapters/providers/tmdb.ts`（getDetails/TmdbDetails）；`src/daemon/ingestTrigger.ts`（makeIngestTrigger——cmdWatch 已构造 ingestTrigger）；`web/src/workflow/`（Lanes/PendingLane/WorkerCard/TraceRows/RunDetail/text.ts/time.ts）；`web/src/triage/`（TriagePage/PendingBox/ClaimDialog/text.ts）。

---

### Task V1: A 案后端——v13 genres + 元数据分区 + 富化重试

**Files:** Modify `src/v2/db.ts`+test（MIGRATIONS 第 5 条：`ALTER TABLE series ADD COLUMN genres TEXT`，schema_version='5'）、`src/adapters/providers/tmdb.ts`+test（TmdbDetails 加 `genreIds: number[]`，解析 `genres[].id`，缺失→`[]`）、`src/v2/ingest.ts`+test、`src/v2/libraryRepo.ts`+test、`src/dashboard/apiV2.ts`+test

- [ ] Step 1 失败测试（先全写）：

```ts
// db.test.ts：schema_version '4'→'5'（叙事注释顺延）+ pragma series 有 genres 列
// tmdb.test.ts：getDetails 解析 genres[].id → genreIds；响应缺 genres → []
// libraryRepo.test.ts：
it('upsertSeries 落 genres（JSON 数组字符串）', ...)
it('listSeriesNeedingEnrich(limit): name 为空或 genres IS NULL 的行，最多 limit 条', ...)
it('applyEnrichment 只回填缺失字段：name 非空不覆盖、genres NULL 才写', ...)
// ingest.test.ts：
it('pass 末尾富化重试：空名 series 被补拍 name/genres（fake tmdb），每轮 cap 10', ...)
it('TMDB 失败时重试不写任何字段、不抛（下轮再试）', ...)
// apiV2.test.ts：
it('sectionOf 元数据优先：genres 含 16 → 动漫；不含 → 剧集；movie 条目恒 电影', ...)
it('genres NULL → 路径派生兜底；路径也未知 → 其他（不再原样漏出目录名）', ...)
```

- [ ] Step 3 实现契约：
  - `libraryRepo`：`upsertSeries` 参数对象加 `genres?: number[] | null`（存 `JSON.stringify` 或 NULL）；新方法 `listSeriesNeedingEnrich(limit: number): { id: string }[]`（`WHERE name = '' OR genres IS NULL LIMIT ?`）；新方法 `applyEnrichment(id, e: { name?: string|null; chineseTitle?: string|null; posterPath?: string|null; year?: number|null; genres?: number[]|null })`——单 UPDATE，`name = CASE WHEN name='' AND @name IS NOT NULL THEN @name ELSE name END` 手法逐字段，genres 用 `COALESCE(genres, @genres)`。
  - `ingest`：tv 首次入库 upsertSeries 带 genres（enrich 返回值透传，enrichNewSeriesOrMovie 返回值加 `genres: number[]|null`）；pass 收尾（seenPaths 处理完后）`for (const {id} of lib.listSeriesNeedingEnrich(10))` 逐个 enrich→applyEnrichment，try/catch 单剧失败只 log 继续。
  - `apiV2`：`sectionOf` 改签名或新增 `sectionForItem(kind: 'series'|'movie', genresJson: string|null, path: string, rootDepth: number)`：movie→'电影'；genres 解析含 16→'动漫' 否则 '剧集'；NULL→旧路径派生但**未知目录名→'其他'**（删 titleCase 漏出）。buildLibrary 的 series 查询补 genres 列。
- [ ] Step 4-5 GREEN（全量含存量硬编码 schema_version 断言更新）+ commit `feat(验收轮一-V1): 分区元数据化——v13 genres + 富化重试 + sectionOf 新规`。

### Task V2: C 案——甄别目录组认领 + requestIngest + duplicate 分组

**Files:** Modify `src/dashboard/server.ts`+test（DashboardOpts 加 `requestIngest?: () => void`；claim 分支成功后 fire）、`src/cli/index.ts`（cmdWatch 传 ingestTrigger 的触发闭包——读 makeIngestTrigger 现状取正确函数）、`web/src/triage/`（PendingBox 重构目录分组、ClaimDialog 改单目录入参、TriagePage 装配）+ 全部对应测试、`web/src/i18n/`（新键双语）

- [ ] Step 1 失败测试：

```ts
// server.test.ts：POST claim 成功 → requestIngest 被调一次；失败(400) → 不调；未配置不炸
// web triage 测试：
it('停车行按 dirname 分组渲染，组头=目录尾段 mono + 文件计数', ...)
it('duplicate-content 行单独成组、默认折叠、组头说明文案在场', ...)  // park reason 字段名先读 buildParked DTO 确认
it('组认领按钮 → ClaimDialog 收单目录（文件列表只读展示，无 checkbox）', ...)
it('认领成功 → 该组置灰 claimed · awaiting rescan 并沉底，actionable 计数减除', ...)
it('多目录多选已撤：页面无逐行 checkbox', ...)
```

- [ ] Step 3 实现要点：分组纯函数进 `web/src/triage/text.ts`（groupByDirname + reason 分箱）；ClaimDialog 的 TMDB 搜索/手动 id/season 逻辑原样保留，仅入参从 paths[] 改单 dir（提交一条 claim，取组内第一个文件 path）；置灰态存组件 state（刷新后靠真数据：行还在=还没扫完，如实）。
- [ ] Step 4-5 GREEN + commit `feat(验收轮一-V2): 甄别目录组认领 + claim 踢扫描 + duplicate 分组`。

### Task V3: B 案后端小件——workers 端点扩容

**Files:** Modify `src/dashboard/apiV2.ts`+test、`web/src/api/types.ts`

- [ ] Step 1 失败测试：

```ts
it('WorkflowWorkersDTO.recent 行带 seriesName/movieName（LEFT JOIN series/movies 取 name，空名→null）', ...)
it('WorkflowWorkersDTO.installedLast24h：runs 里 decision=installed 且 finished_at>now-86400e3 的计数', ...)
```

- [ ] Step 3 实现：buildWorkflowWorkers 的 recent 查询已 LEFT JOIN jobs——再 LEFT JOIN series/movies 取 name 两列；返回对象加 `installedLast24h: number`（单独 COUNT 查询，参数 now 由调用方传入——沿该文件 now 传参先例）。types.ts 同步。
- [ ] Step 4-5 GREEN + commit `feat(验收轮一-V3): workers 端点带剧名与 24h 安装计数`。

### Task V4: B 案前端——Workflow 叙事化重造

**Files:** Create `web/src/workflow/phrases.ts`（工具名/decision 短语映射纯函数）+ test、`web/src/workflow/SummaryLine.tsx`、`web/src/workflow/ActivityFeed.tsx`（Now working 卡 + recent 句子流 + Orchestrator log 折叠区）；Modify `web/src/workflow/Lanes.tsx`（两列重排：Gaps | Activity）、`TraceRows.tsx`（加 `phraseMode?: boolean`：映射工具名+隐藏 argsSummary；默认 false=RunDetail 回放原样）、`PendingLane.tsx`（仅组名改 Gaps，其余不动）、i18n（en 键即最终文案，zh 引用 en——Workflow 区裁决不变）；Delete `PassCard.tsx`/`WorkerCard.tsx` 中被 ActivityFeed 取代的部分（点开右侧板逻辑并入 ActivityFeed 行为，RunDetail 组件零改动）

- [ ] Step 1 失败测试（spec §B 逐条锚定）：

```ts
// phrases.test.ts
it('toolPhrase: read_doc→Reading the playbook…七个映射 + 未知工具名原样返回', ...)
it('decisionPhrase: installed→subtitles installed / retry_later→will retry later（中性）/ error→hit a problem — will retry / realign:done→library realigned …', ...)
// Lanes/ActivityFeed 测试
it('总览句渲染：Watching {gaps} gaps · {n} episodes installed in the last 24h · {m} agent(s) working', ...)
it('Now working 卡头=Searching subtitles for {seriesName}；TraceRows phraseMode：工具名已映射、argsSummary 不在 DOM', ...)
it('recent 行=名字+短语+右对齐相对时间；retry_later 行灰点无红样式；error 行红点且无红底块', ...)
it('Orchestrator log 默认折叠；展开后回执 chip 才可见', ...)
it('剧名缺失（seriesName null）降级显示 id', ...)
it('点开 recent 行/pass 行 → RunDetail 右侧板原样（原始工具名+argsSummary 在场）', ...)
```

- [ ] Step 3 实现要点：布局两列 grid（Gaps 窄列 | Activity 宽列），移动端沿现 Collapsible 单列手法；样式沿 styles.css 既有 `/* dashboard-F4 */` 段改造，颜色全 token；SSE/useLiveTrail/traceStream 机制零改动（只换渲染层）。
- [ ] Step 4-5 GREEN + commit `feat(验收轮一-V4): Workflow 叙事化——总览句/人话步骤/活动流/编排日志折叠`。

### Task V5: 收官（主控亲跑，不派子代理）

- [ ] 双侧 `tsc --noEmit` + `vitest run` 全绿 + `web npm run build`；主控逐 diff 抽核后 rsync src/+web/dist 到 scout-test 重启测试守护（串行窗口纪律）；富化重试实测：等 1-2 轮 pass 后确认 ? 卡有名字、动漫归位；用户复验四条验收口径（spec 末节）。

---

## 自审记录

spec A/B/C 逐节对照：A→V1（判据/迁移/重试/兜底四点全覆盖）；B→V3+V4（总览句数据/短语映射/折叠/两列/RunDetail 零改动）；C→V2（分组/单目录认领/置灰/踢扫描/duplicate 分箱）；非目标三条无对应任务（正确）。类型链：listSeriesNeedingEnrich/applyEnrichment 在 V1 内自洽；installedLast24h/seriesName 贯穿 V3→V4。无 TBD。前端给契约+断言而非全量 TSX（视觉真源=DESIGN.md+spec 铁律，主控逐 diff 亲核兜质量——沿 dashboard 战役计划同款取舍）。
