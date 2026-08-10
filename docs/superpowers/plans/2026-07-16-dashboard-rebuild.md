# Dashboard 重建 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 铁律（本仓库既有纪律）：不用 Workflow 工具；不用 worktree；实现子代理 sonnet、主控逐 diff 亲核；`src/agent/skills/*` 只许主控改（本战役不涉及）；R1/R2 收官纪律适用（北极星对照表 + 对抗审计官全项目复审双签）；commit trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
> **开工前置**：胶水层战役收尾两件先做完——①B-matrix 复跑（`src/testing/` 真模型矩阵，router 测试容器，主控亲跑）②真站闸门报告落进 docs/design/2026-07-16-old-world-lineage-registry.md 收官节（素材：session 内已验证清单 + router:/tmp/gate-sampler.log 收敛曲线 + prod runs 表四词表证据）。落册后 dashboard 解冻（用户令）。

**Goal:** 按 spec（docs/design/2026-07-16-dashboard-rebuild-design.md，必读）重建 dashboard：后端半场（应有集缓存/痕迹通道C/聚合API/settings+roots）→ 前端半场（Astryx 试点闸门 → 四 tab）。

**Architecture:** daemon 内嵌 serve 不变（apiV2 扩展 + 新 SSE 端点）；SQLite 真源；前端 Vite+React 19 SPA 重写 web/src（Astryx 或 shadcn 二选一后统一）。

**Tech Stack:** better-sqlite3 / zod / vitest；前端 Vite + React 19 + Astryx(试点)|shadcn + i18n(en/zh)。

**现状坐标（zero-context 者先读）**：`src/dashboard/apiV2.ts`（现有 JSON API：library/timeline 等，Express 风格接线看 `src/cli/index.ts` cmdWatch 尾部）；`src/v2/libraryRepo.ts`（missingBySeason 已带 throttled 事实）；`src/v2/runsRepo.ts`（runs 行）；`src/agent/reasoningAgent.ts`（ToolLoopAgent 工厂——痕迹挂钩点）；`web/src/`（现有 Vite SPA，可整体替换）；视觉基准=`.superpowers/brainstorm/83245-1784195119/content/full-design-v2.html`（用户过目的 v2 mockup）与两份调研报告结论（token/手法已凝进 spec §2）。

---

## 阶段甲 · 后端半场

### G1: v12 迁移——三张新表 + runs 加列

**Files:** Modify `src/v2/db.ts`、`src/v2/db.test.ts`

- [ ] Step 1 失败测试：db.test.ts 断言 schema_version='4'（MIGRATIONS.length 语义，勿写 '12'）+ PRAGMA 断言四个对象存在。
- [ ] Step 2 确认 RED。
- [ ] Step 3 实现——MIGRATIONS 追加第 4 条 entry：

```sql
CREATE TABLE tmdb_seasons (        -- spec §8.1 应有集缓存（三层格阵第一层）
  series_id TEXT NOT NULL,         -- own id: 'tmdb:<id>'
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  title TEXT,                      -- 集标题，可 NULL
  fetched_at INTEGER NOT NULL,     -- TTL 刷新锚（7 天）
  PRIMARY KEY (series_id, season, episode)
);
CREATE TABLE settings (            -- spec §7 行为级设置
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE media_roots (         -- spec §7 守备目录（Jellyfin 分界）
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'local',   -- 存储协议战役预留
  added_at INTEGER NOT NULL
);
ALTER TABLE runs ADD COLUMN trace_json TEXT;   -- 痕迹通道 C 收官快照
```

- [ ] Step 4 GREEN（含既有 doctor.test 派生断言自动跟随）。Step 5 commit `feat(dashboard-G1): v12 三表一列`。

### G2: TMDB 应有集缓存模块

**Files:** Create `src/v2/tmdbCatalog.ts` + test；Modify `src/v2/libraryRepo.ts`（读接口）

- [ ] Step 1 失败测试（fake tmdb，断言写表/TTL/降级）：

```ts
it('refreshSeriesCatalog: 拉季表+集标题写 tmdb_seasons，7 天内不重拉', ...)
it('TMDB 失败 → 保留旧缓存不清空（gain-path 降级）', ...)
it('canonicalEpisodes(seriesId, season) 返回缓存行', ...)
```

- [ ] Step 3 实现契约：

```ts
export const CATALOG_TTL_MS = 7 * 86_400_000
export async function refreshSeriesCatalog(
  db: ScoutDb, tmdb: Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes'>, seriesId: string, now: number,
): Promise<void>  // getSeasonEpisodes 若 TmdbClient 无此方法则补薄封装（GET /tv/{id}/season/{n}，读 tmdb.ts 现状适配）
export function canonicalEpisodes(db: ScoutDb, seriesId: string, season: number): { episode: number; title: string | null }[]
```

  刷新触发点：ingest 的 enrichNewSeriesOrMovie 后追加 fire-and-forget（失败仅 log）；API 读时过期同样惰性触发。
- [ ] Step 4-5 GREEN + commit。

### G3: 痕迹通道 C（直播 + 收官快照）

**Files:** Create `src/dashboard/traceBus.ts` + test；Modify `src/agent/reasoningAgent.ts`（步事件回调）、`src/v2/findSubtitleWorkerTask.ts` + `src/v2/reconcileAll.ts`（快照落 runs）、`src/dashboard/apiV2.ts`（SSE 端点）

- [ ] Step 1 失败测试：

```ts
// traceBus.test.ts
it('publish/subscribe：订阅者收到 {runKey, seq, tool, argsSummary, resultSummary, tookMs, at}', ...)
it('环形缓冲 cap 512 条/runKey，溢出丢最旧', ...)
it('snapshot(runKey) 返回全量事件数组并 clear', ...)
// reasoningAgent.test.ts 增
it('onStepEvent 回调在每个工具调用结算后触发（finalize 也算一步）', ...)
```

- [ ] Step 3 实现契约：

```ts
// traceBus.ts —— 进程级单例，零持久化（真源哲学：过程证据≠账目）
export interface TraceEvent { runKey: string; seq: number; tool: string; argsSummary: string; resultSummary: string; tookMs: number; at: number }
export const traceBus: { publish(e: TraceEvent): void; subscribe(fn: (e: TraceEvent) => void): () => void; snapshot(runKey: string): TraceEvent[] }
// reasoningAgent: ReasoningAgentOptions 增 onStepEvent?: (e: Omit<TraceEvent,'runKey'|'seq'>) => void（agent 循环内每步结算处调用，摘要各 cap 200 字符）
```

  接线：makeFindSubtitleWorker/makeOrchestratorAgent 构造处把 onStepEvent → traceBus.publish（runKey=`job-${jobId}`）；runFindSubtitleWorkerTask/runOrchestrateWorkerTask 收官处 `runs.insert({..., traceJson: JSON.stringify(traceBus.snapshot(runKey))})`（RunsRepo.insert 加可选 traceJson 列写入）。SSE：apiV2 `GET /api/v2/workflow/trace-stream`（text/event-stream，订阅 traceBus 转发，心跳 15s）。
- [ ] Step 4-5 GREEN + commit（含 runsRepo 测试更新）。

### G4: settings + roots + 行为项消费

**Files:** Create `src/v2/settingsRepo.ts` + test；Modify `src/v2/ingest.ts`/`src/cli/index.ts`（roots 来源切换）、`src/cli/targetLanguages.ts`（settings 优先）、`src/dashboard/apiV2.ts`（读写端点 + 列目录）

- [ ] Step 1 失败测试：

```ts
it('get/set 任意 key，类型由调用方 zod 校验', ...)
it('listRoots/addRoot/removeRoot；removeRoot 级联删该根下 episodes/movies/series 空壳/parked 行', ...)
it('首启：settings 空且 env MEDIA_ROOTS 有值 → 种子写入 media_roots', ...)
it('resolveTargetLanguages: settings.target_languages 存在时覆盖 env', ...)
it('GET /api/v2/fs/list?path=… 只许已挂载可见路径，返回子目录名', ...)
it('POST /api/v2/settings/roots 加根后 ingest 下一轮扫它（注入 fake walker 断言 roots 传递）', ...)
```

- [ ] Step 3 实现契约：settingsRepo 类薄封装三表操作；cmdWatch 组装处 roots = `settingsRepo.listRoots()`（空则 env 种子化后再读）；删根走单事务级联（借 deleteSeriesRows 既有手法）；apiV2 端点 `GET/PUT /api/v2/settings`（行为键白名单：target_languages/hardsub_mode/exclude_extras/trace_retention_days/scan_interval_ms）、`GET /api/v2/settings/deploy`（env 脱敏只读：key 存在性布尔+尾 4 位）、`GET/POST/DELETE /api/v2/settings/roots`、`GET /api/v2/fs/list`。hardsub_mode/exclude_extras 本战役只存取展示（消费归救援官战役，spec §10）。
- [ ] Step 4-5 GREEN + commit。

### G5: workflow/library/甄别聚合 API

**Files:** Modify `src/dashboard/apiV2.ts` + test（先读现有端点风格与鉴权）

- [ ] Step 1 失败测试（每端点一条形状断言 + 一条边界）：

```ts
it('GET /api/v2/workflow/pending → 活文档行[{seriesId,seriesName,season,missing,throttled,nextRecheckAt,sampleReason}] + parked 计数', ...)
it('GET /api/v2/workflow/passes?limit=20 → orchestrate runs 行（含 trace_json 解析出的回执分布 created/revived/coalesced/blocked_dormant 计数）', ...)
it('GET /api/v2/workflow/workers → 在跑（jobs searching + traceBus 尾部 N 条）+ 近期完成 runs（按桶）', ...)
it('GET /api/v2/library/series/:id → {series, seasons:[{season, canonical:[…], onDisk:[…], coverage:[…]}]}（三层合成，canonical 来自 tmdb_seasons）', ...)
it('GET /api/v2/triage → {pending:[parked_paths…含 reason], claimed:[overrides…]}', ...)
it('POST /api/v2/triage/claim {path, tmdbId, isTv, season?} → 写 identify_overrides（复用 P6 现有逻辑，读 apiV2 现状——若已有认领端点则只补形状测试）', ...)
it('POST /api/v2/workflow/redispatch {seriesId, seasons?, includeThrottled?} → upsertWorkerTask 定点扳手，回执原样返回', ...)
```

- [ ] Step 3 实现（纯读聚合 + 两个写扳手，全部走既有 repo，不新增判断逻辑——北极星④）。
- [ ] Step 4-5 GREEN + commit。

### G6: 后端半场收官

- [ ] `npx tsc --noEmit && npx vitest run` 全绿；主控抽核 G3 挂钩 diff（reasoningAgent 是共用件）；commit `feat(dashboard): 后端半场收官`。

## 阶段乙 · 前端半场

### F0: Astryx 试点闸门（决策task，主控裁决）

- [x] 新分支 `dashboard-astryx-pilot`：`npm i @astryxdesign/cli` 走 `npx astryx template dashboard` 出 shell，验证 React 19 + Vite 构建 + 深色主题定制到 spec §2 token 的可行度；**半天为限**——任一硬伤（R19 不兼容/构建不进 Vite/主题改不到位）即弃，落 shadcn（`npx shadcn init`，new-york/zinc/dark，注意 skill 里 Geist 字体坑：@theme inline 写字面量字体名）。裁决写进本文件此处再继续。

> **F0 裁决（2026-07-16 深夜，主控亲测于 scratchpad，未动仓库）：PASS——采用 Astryx（@astryxdesign/* 0.1.6）**。
> 实测证据：①React 19.2.7 + Vite 8 生产构建全过（tsc+vite build 642ms，2239 模块）；②StyleX 是 peer 依赖但**无需构建插件**——core 组件预编译 + 主题走纯 CSS 自定义属性（cascade layers：@layer reset/astryx-base），官方有 example-vite；③spec §2 token 压进 defineTheme 自定义主题实测成功：`astryx theme build` 编译出 scout.css（#0b0c0f/hairline rgba(255,255,255,.07)/Geist Mono 均验证在产物里），token 面强类型（TS 逮住假 token 名），组件级覆盖+自定义 variant 带类型增强；④agent-ready 是原生卖点：`astryx init --agent claude` 出 agent docs、`--dense` token 省钱模式、`component <Name>` 给出每组件 theming targets——正中 subagent-driven 前端开发法。627 个模板含 dashboard/AppShell/shell-nav 全套。
> 坑位备忘（F1-F7 执行时注意）：**`npx astryx` 会解析到被抢注的空包 `astryx`**——必须 `npm i -D @astryxdesign/cli` 后走 `./node_modules/.bin/astryx`（或 package.json script）；`theme build` 要求 core 已本地安装；真实 token 名是 `--color-background-body/card/surface` 一族（不是 primary/secondary，写错 TS 会报）。
> 实施调整：F1 的 tokens.css 一项改为 `web/src/theme/scout.ts`（defineTheme 源）+ `astryx theme build` 产物（scout.css/scout.d.ts），DESIGN.md 记 spec §2 → Astryx token 的映射表；shadcn 后备通道封存不删（写在这里即可，不留代码）。

### F1: DESIGN.md + token 落地

**Files:** Create `web/DESIGN.md`、`web/src/styles/tokens.css`

- [ ] 按调研凝练稿写 DESIGN.md（9 节：Overview/Colors/Typography/Elevation/Components/Do's-Don'ts/Iteration Guide；token 值=spec §2：canvas #0b0c0f、surface 三档、hairline rgba(255,255,255,.07/.14/.04)、ink 四档、单 accent、语义色 #28bf5c/#e8a33d/#e11d48/排队灰、正文 13px/500/-0.01em、mono=Geist Mono）；tokens.css 落 CSS 变量。此后每个前端子代理 prompt 必带"先读 web/DESIGN.md"。commit。

### F2: 外壳 + i18n

**Files:** Create `web/src/shell/`（Sidebar/Topbar/CommandK）、`web/src/i18n/`（en.ts/zh.ts + useT()）

- [ ] 侧边栏（分区 uppercase 小标 Library/Agents/System，四项：Library/Workflow/Triage/Settings + 甄别角标=triage pending 计数）；顶栏（面包屑 + mono 新鲜度行 `watching {roots} · scanned {ago} · {n} files`（数据=GET /api/v2/workflow/pending 附带的 meta）+ ⌘K）；i18n：zh 文案表中 Workflow 区键直接引用 en 值（spec §3 永不本地化）。测试：i18n 键完整性 + 路由渲染冒烟（vitest + testing-library，沿 web 现有 App.test.tsx 风格）。commit。

### F3: Library tab

**Files:** Create `web/src/library/`（SeriesGrid/SeriesPage/EpisodeCell/EpisodeDetail）

- [ ] 列表页：海报卡 + 覆盖角标 + 筛选 chip（有缺口/停牌中/全覆盖）；剧集页：人话覆盖句（大数字嵌句）+ 每季 A 格阵（EpisodeCell=灰格+5px 语义点，dashed=canonical-有-磁盘-无，数据=G5 三层端点）+ 点格开 C 式右侧详情板（文件名/规格 mono、字幕来源、停牌原因+nextRecheck、esc 键帽）。测试：三层合成渲染断言（canonical 8 集/磁盘 6/覆盖 4 → 格阵形状）。commit。

### F4: Workflow tab（英文恒定）

**Files:** Create `web/src/workflow/`（Lanes/PendingLane/PassCard/WorkerCard/TraceRows/RunDetail）

- [ ] 三泳道桌面布局（视觉基准=workflow-page.html mockup A + full-design-v2 的痕迹卡）；WorkerCard 订阅 SSE trace-stream（EventSource，断线重连+落后补拉 workers 端点）；TraceRows=Inngest 式（等宽工具名+右对齐耗时+在跑行蓝点延展）；PassCard 展示回执分布 chip；RunDetail 右侧板=三桶报告+快照回放（trace_json）+ Rerun 按钮（POST redispatch，AlertDialog 确认，includeThrottled 开关）；移动端 = 单列时间流降级（mockup B）。测试：SSE mock 流入渲染 + 快照回放渲染。commit。

### F5: Triage（甄别）tab

**Files:** Create `web/src/triage/`（PendingBox/ClaimedBox/ClaimDialog）

- [ ] 两箱起步（待甄别/已认领——excluded-extra 箱等救援官战役，布局留位）；ClaimDialog=路径列表多选 + TMDB 搜索选条目 + season 可选（走 POST claim）；每行展示 park reason + 改名指引提示（README 最佳实践文案）。测试：认领流端到端（mock API）。commit。

### F6: Settings tab

**Files:** Create `web/src/settings/`（BehaviorSection/DeploySection/RootsManager）

- [ ] 行为区（target languages 编辑、hardsub 三档 select、特典开关、痕迹保留、扫描间隔）即时 PUT；部署区只读脱敏；RootsManager=目录浏览器（fs/list 逐级下钻）+ 加根（立即触发提示）+ 删根 AlertDialog（文案明示"清除该目录下全部索引行，磁盘文件不动"）。测试：删根确认流 + 只读区不可编辑。commit。

### F7: 收官

- [x] 全量绿（root+web）；R1 北极星对照表（重点：dashboard 有没有替 agent 判断的面——Rerun/claim 均为人类扳手=HITL 合法）+ R2 对抗审计官全项目复审双签；真站：router 部署后主控过一遍四 tab 真数据 + SSE 直播真 worker；报告落登记册；用户过目。

> **F7 完成（2026-07-17）**：R1 六星全过；R2 双签（一轮 FAIL 3 MAJOR→修复轮 91851fd→二轮 PASS→条件项主控亲修 8df4a85 清零）；真站四 tab 真数据+SSE 直播+三层格阵 dashed 缺档格全部实弹验证（串行窗口，底线零违）。全文见登记册 §八。剩余：用户过目 + 生产容器切换（compose build 重建，用户择机）。

---

## 自审记录

spec §1-§10 逐节对照：§8.5 回执分布=G5 从 trace_json 解析 ✓；§9 立项项不在本计划（正确）；§6 excluded-extra 箱留位不实现 ✓（spec §10 non-goal）。类型链：TraceEvent 贯穿 G3/G5/F4 一致；MissingBySeason 形状沿 T8c 既有。无 TBD 残留。前端任务给的是组件契约+验收断言而非全量 TSX——视觉真源是 DESIGN.md+mockup 文件，全量 TSX 在计划里必然过时，此为有意取舍（executor 按契约+基准实现，主控逐 diff 亲核兜质量）。
