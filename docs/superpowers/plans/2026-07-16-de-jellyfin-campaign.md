# 去 Jellyfin 化战役 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（sonnet 子代理逐 Task，主控编排+两阶段复核）。checkbox 跟踪。
> **执行前置**：设计=`docs/design/2026-07-16-de-jellyfin-design.md`(4bebfe9)；坐标源=2026-07-16 深夜全仓 Jellyfin 触点侦察（本计划已内联全部关键坐标，坐标以 4bebfe9 为准，执行前 grep 复核）。铁律：sonnet 子代理实现/不用 Workflow/不用 worktree/skill 只主控改/realign 5 重安全层零触碰主控逐 hunk 亲验/别停摆。基线：main=4bebfe9、1218 绿、tsc 干净。用户已授权软路由"生产"栈随便动（媒体视频文件本身不删、无关容器不扰）。

**Goal**：Jellyfin 从依赖/env/部署栈完全消失——自有 id 空间 + recognize() 直写摄取 + ffprobe 探针 + 全缝切换 + realign port 换芯 + 一次性 park 救援 + 真库终极闸门。

**Architecture**：P1 探针独立先行 → P2 schema v9 全新库 → P3 摄取换芯（双信号坍缩） → P4 缝合切换 → P5 realign port（锁承载安全属性） → P6 救援页 → P7 出口+真库闸门。

**Tech Stack**：既有 v3 栈 + `ffprobe-static`（新依赖）+ TMDB 公开图片 CDN。

**Gate 纪律**：每 Task `npx tsc --noEmit` 干净 + `npx vitest run` 绿 + 逐 Task 提交（trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`）。

**现场设计决定（侦察 surprises 的裁决，实现者不再议）**：
- D1 死 port 方法直接删：`RealignJellyfinPort.deleteItem`（realignExecutor.ts:348 声明、cli/index.ts:228 接线、测试 mock，**全仓零调用**）与 `PlayerServer.getSeasonEpisodes`（jellyfin.ts:235-260，零生产调用）。
- D2 `MEDIA_PATH_MAPPINGS` 软退役：env/README/.env.example/doctor(checkPathMappings) 全撤；`mapPath` 函数与 realign 内 7+ 调用点**保留不动**（空映射=恒等）——不为它碰 realign。
- D3 海报代理整删：TMDB 图片是公开 CDN（`https://image.tmdb.org/t/p/w400<poster_path>`，无 key）——`proxyPoster`(apiV2.ts:397-445)、`/api/poster` 路由(server.ts:66-76)、dashboard 的 jellyfin `{baseUrl,apiKey}` 凭证管道全删，web 端直拼 CDN URL。
- D4 realign 防赛跑安全属性由**进程内摄取锁**承载：port 的 `getScheduledTasks` 新实现在摄取 pass 进行中返回 Running 形状 → `waitForJellyfinIdle`(realignExecutor.ts:288-304) **逻辑一个字节不改**照常轮询等待；反向（realign 进行中摄取跳过）由 daemon 侧检查同一把锁。锁随进程死，无陈旧锁问题（realign 崩溃恢复由既有 GAP A 机制管）。
- D5 `series.provider_ids` 死列复活：v9 起 ingest 正常写入（orchestratorAgent.tools.ts:76-77 的"unreliable historical mirror"注释随 P4 缝切换一并更正）。
- D6 `setSeriesChineseTitle`（libraryRepo.ts:420-428）疑似死写者：T3 执行者 grep 定夺——死则删，活则改由 ingest 经 `tmdb.getChineseTitles` 填充；`chinese_title` 列本身保留（dashboard 显示用，ingest 时顺手填）。
- D7 schema v9 = **MIGRATIONS 数组整体替换为单条终态 entry**（旧 DB 全弃，保留 8 条死迁移无意义）；openDb 机制不变（空库 version 0 → 跑全数组）。

---

## Task 1（P1）：ffprobe 内嵌字幕探针

**Files**: Create `src/files/streamProbe.ts`、`streamProbe.test.ts`；Modify `package.json`（`npm i ffprobe-static`）。

**Spec**：`export interface EmbeddedSubtitleTrack { lang: string | null; codec: string | null; isImageBased: boolean }`；`export async function probeEmbeddedSubtitles(videoPath: string, opts?: { ffprobePath?: string; timeoutMs?: number }): Promise<EmbeddedSubtitleTrack[] | null>`。
- 二进制解析顺序：`opts.ffprobePath` → `process.env.FFPROBE_PATH` → `ffprobe-static` 的路径导出。
- 实现：`execFile(ffprobe, ['-v','quiet','-print_format','json','-show_streams','-select_streams','s', videoPath], {timeout: opts?.timeoutMs ?? 15000})`，解析 `streams[]`：`lang = stream.tags?.language ?? null`（**原样保留 ISO 值**，语言归一是消费方用 langOf/tagsForLanguage 的事）；`isImageBased = ['hdmv_pgs_subtitle','dvd_subtitle','dvb_subtitle','xsub'].includes(codec_name)`。
- **返回 null = 探测不可用**（无二进制/execFile 抛错/超时/JSON 坏）——消费方降级"只认 sidecar"；返回 `[]` = 探测成功且无内嵌轨。区别写进 JSDoc（宁多查勿漏配口径）。
- 记忆化**不在本模块**（纯函数；memo 在 T3 摄取层按 (path,mtime,size) 走 DB 列）。

- [ ] Step1 失败测试：①mock execFile 返回真实形状 ffprobe JSON（两条轨：chi/srt + eng/hdmv_pgs_subtitle）→ 断言两条 track 形状与 isImageBased；②execFile 抛 ENOENT → null；③超时 → null；④空 streams → []。execFile 注入 seam（`deps?.execFileImpl`）便于测试。
- [ ] Step2 红 → Step3 实现 → Step4 绿+tsc。
- [ ] Step5 可选真样本冒烟（本机若有 ffprobe + 任一 mkv 则跑一次真探测 console 打印，写成 `it.skipIf(!existsSync(...))` 形式不入 CI 强依赖）。
- [ ] Step6 提交 `feat(probe): ffprobe embedded-subtitle probe with graceful degradation`。

## Task 2（P2）：schema v9 + libraryRepo 新面

**Files**: Modify `src/v2/db.ts`（D7：MIGRATIONS 整体替换单条终态）、`src/v2/libraryRepo.ts`（新方法族）；Test 对应 + 现有 migration 测试清算（旧迁移链测试随链删除，保 openDb 空库建库测试）。

**v9 终态 schema 要点**（在现 v8 终态基础上改）：
- id 语义换自有：注释更新（series.id=`tmdb:<id>`、episodes.id=`tmdb:<id>/s<N>e<M>`、movies.id=`tmdb:<id>`）；TEXT 主键不变故无结构变化，**变化在写入方（T3）**。
- series/movies 加列：`poster_path TEXT`（TMDB 图片路径）；episodes/movies 加探针 memo 列：`probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT`（JSON 数组，null=未探测/不可用）。
- 新表：
```sql
CREATE TABLE parked_paths (
  path TEXT PRIMARY KEY, park_reason TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL
);
CREATE TABLE identify_overrides (
  path_prefix TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL,
  is_tv INTEGER NOT NULL, created_at INTEGER NOT NULL
);
```
- jobs/subtitles/runs/meta 原样（series_id/movie_id/item_id 自动跟随新 id 值域）。

**libraryRepo 新方法**：`upsertParkedPath(path, reason, now)`、`clearParkedPath(path)`、`listParkedPaths(): {path,park_reason,first_seen,last_attempt}[]`、`findOverride(path): {tmdbId, isTv} | null`（**最长前缀匹配**：`SELECT * FROM identify_overrides WHERE ? GLOB path_prefix || '*' ORDER BY length(path_prefix) DESC LIMIT 1` 或等价实现）、`addOverride(prefix, tmdbId, isTv, now)`、`probeMemo(itemId): {mtime,size,langs}|null` + `setProbeMemo(...)`、`deleteEpisodeByPath(path)`/`deleteMovieByPath(path)`（T3 移除语义用）；`upsertSeries` 增 `posterPath`/`providerIds`（D5）。

- [ ] Step1 失败测试：新表 CRUD 各一；最长前缀匹配（两条 override 前缀嵌套 → 取长）；openDb 空库直达 v9。
- [ ] Step2 红 → Step3 实现（D7 数组替换）→ Step4 绿+tsc（旧 migration.*.test.ts 按 D7 清算——测试对象是被删的迁移链）。
- [ ] Step5 提交 `feat(db)!: schema v9 own-id world — parked_paths + identify_overrides + poster/probe columns (fresh-bootstrap, migrations collapsed)`。

## Task 3（P3a）：TMDB 补面 + 自有摄取核心

**Files**: Modify `src/adapters/providers/tmdb.ts`（纯增量：search mapper 捕获 `poster_path`（:299-321 加字段）；新 `getDetails(mediaType,tmdbId): Promise<{overview: string|null, runtimeMinutes: number|null, posterPath: string|null, originalTitle: string|null, year: number|null}|null>`——tv 用 name/first_air_date/episode_run_time[0]，movie 用 title/release_date/runtime）；Create `src/v2/ingest.ts` + `.test.ts`；Modify `src/recognition/resolveToTmdb.ts`（override 前置：`deps` 增可选 `findOverride(path)`——**注意签名演化**：recognize 链要把原始 videoPath 传到 resolve 层，识别前查 override 命中则直通构造 Recognized）。

**`src/v2/ingest.ts` 形状**：
```ts
export interface IngestDeps {
  roots: string[]
  lib: LibraryRepo
  tmdb: TmdbClient
  recognize: (videoPath: string) => Promise<Recognized | Park>
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  listVideoFiles?: (root: string) => string[]   // 复用 selfScan walker 提取（见下）
  fileExists?: (p: string) => boolean
  targetLanguages: string[]
  originSkipLanguages?: string[]
  log: (msg: string) => void
  now?: () => number
}
export interface IngestResult { scanned: number; upserted: number; parked: number; removed: number; changed: boolean }
export function makeIngestPass(deps: IngestDeps): () => Promise<IngestResult>
```
- 流程：走盘 → 对每个视频文件：已有行且 (mtime,size) 未变 → 只做覆盖复核（廉价路径）；新/变 → recognize()（内部先 override）→ 命中：`tmdb.getDetails` + `getOriginLanguage` + `getChineseTitles`（D6）补面 → 计算 sub_status（**语义移植自 classifyItemDetailed rule 0-4**，scanner.ts:82-187：权威门 originSkip、中文启发式兜底仅 zh（title 源改用识别产物 title——`isChineseOrigin(ProductionLocations)` 无对应物，**删**，rule 1 只剩 looksChineseTitle）、rule 2 换探针结果∩tagsForLanguage(targets)、rule 3 findExternalSidecar 直接本地路径**无 mapPath**）→ upsert series/episode/movie 行（id=`tmdb:` 形状，provider_ids/poster_path/chinese_title/probe memo 全填）→ clearParkedPath；park：upsertParkedPath。
- 移除语义：库行 path 不在盘上 → delete 行；parked_paths 同理。字幕被删=sidecar 消失+无内嵌 → sub_status 回 missing（覆盖复核路径捕获——**这是 P7 终极验收的机制**）。
- walker 复用：把 selfScan.ts 的默认 walker（:141-177，dot-dir/@ 排除已含）提取为共享导出（selfScan 引用同一实现，行为零变）。
- **摄取锁（D4 的一半）**：模块导出 `export const ingestLock = { held: false }` 级别的简单互斥（或小类）；makeIngestPass 执行期间持锁。

- [ ] Step1 失败测试（fake tmdb/recognize/probe/walker）：新文件命中→行 upsert 全字段（id 形状断言）；park→parked_paths；override 直通；(mtime,size) 未变跳过 recognize；文件消失→行删除；sidecar 消失→missing；探针 null→只认 sidecar；启发式兜底仅 zh；removed/changed 计数。
- [ ] Step2 红 → Step3 实现 → Step4 绿+tsc。
- [ ] Step5 提交 `feat(ingest): recognize()-direct ingestion — own-id rows, TMDB enrichment, probe+sidecar coverage, disk-truth removal`（D6 判定结果写提交信息）。

## Task 4（P3b）：daemon 换芯 + 死件清算

**Files**: Modify `src/v2/daemon.ts`（tickInner：reconcile 分支的 `scan()` 与 self-scan 分支合并为单一 `ingest()` 节拍（沿用 `last_self_scan_at` 门/`SCAN_INTERVAL_MS`；`last_reconcile_at` 门退役）；**session 轮询/播放优先级删除**——getSessions/episodeForSession/queue 相关 deps 与 tick 逻辑）、`src/daemon/selfScanTrigger.ts`（坍缩：去 getVirtualFolders/refreshLibrary/awaiting/knownSnapshot（:76-190），保 `SELF_SCAN_ORCHESTRATE_SERIES_ID` 同 identity 去重——新形状：`ingest() → result.changed ⇒ upsertWorkerTask(orchestrate)`；文件更名 `src/daemon/ingestTrigger.ts` 连测试一起迁）、`src/cli/index.ts`（cmdWatch/cmdReconcileAll 接线：scanLibrary→makeIngestPass；originResolver 管道删除——origin 由 ingest 直填）、Delete `src/daemon/watcher.ts`、`queue.ts`（v1 遗骸+tests）、`src/v2/scanner.ts` 的 Jellyfin 面（**scanner.ts 大部退役**：getItemsPage 循环/classifyItemDetailed 的 JellyfinItem 形状/Episode-without-SeriesId 守卫:266——`findExternalSidecar`/`tagsForLanguage` 消费已迁 ingest.ts；文件若只剩死壳则整删+测试语义迁移）、`src/daemon/triggers.ts`（孤儿清算：isTriggerableType/needsChineseSubtitle/isChineseLang 删；isChineseOrigin 随 rule1 删；looksChineseTitle 迁 ingest 消费处或留 triggers.ts 瘦身）。
- daemon 侧锁检查（D4 另一半）：tick 的 ingest 分支在 realign worker_task 活跃时跳过本轮（查 jobs 表 active realign 或共享锁——实现者按 D4 注释判，写明机制）。
- **A 组门控测试整体迁移重锁**：scanner.test.ts 中 targetLanguages/originSkip/sidecar/启发式的行为测试全部在 ingest.test.ts 语义等价重建（红先跑不了就逐条移植后删旧文件）。

- [ ] Step1 失败测试：tick 单节拍调 ingest；changed→orchestrate 入队一次（同 identity 去重）；unchanged→静默；realign 活跃→本轮跳过；session 轮询字段从 DaemonDeps 消失（编译期）。
- [ ] Step2 红 → Step3 实现 → Step4 绿+tsc + `grep -rn "getSessions\|episodeForSession\|PrefetchQueue\|watcher" src/ --include="*.ts" | grep -v test` 零命中。
- [ ] Step5 提交 `feat(daemon)!: single ingest heartbeat replaces scan+refresh-bridge; delete session polling + v1 corpses`。

## Task 5（P4a）：orchestrator/任务上下文缝切换

**Files**: Modify `src/agent/orchestratorAgent.tools.ts`（check_series_layout :94-95 的 `jf.getItem` → `seriesId` 自解析：`tmdbIdFromOwnId(seriesId)`（`tmdb:` 前缀截取，放 `src/v2/ownIds.ts` 小工具连同 `episodeId(tmdbId,s,e)` 构造器供 T3 复用——**若 T3 已建则沿用其命名**）；D5 注释更正；工具 deps 去 jf）、`src/v2/findSubtitleWorkerTask.ts`（mapper :94-154 重写：`targetItemId` 直查库行取 path/名段；chinese title 用 `tmdb.getChineseTitles`；上下文字段从行+`tmdb.getDetails` 取；`resolveTmdbRef*` 调用删除）、`src/adapters/providers/tmdb.ts`（删 `resolveTmdbRefStrict`/`resolveTmdbRef`/`ItemLike`/`JellyfinItemNotFoundError` import——**原子提交**，同步修 `src/core/mediaContext.ts`（buildMediaContext 的 JellyfinItem 版整删或收缩为 realign 仍需的部分——先 grep 现存调用者定夺）、`src/v2/reconcileAll.ts`（jf 线程剥离）、`src/testing/seedBacklog.ts:16,69` + `scripts/run-orchestrator-matrix.ts:2,42,47`（fake 形状随缝更新）。
- [ ] Step1 失败测试：check_series_layout 无 jf deps 仍产 exceeds 判定（seriesId=`tmdb:209867`）；mapper 从库行构造 FindSubtitleTask 全字段。
- [ ] Step2 红 → Step3 实现 → Step4 绿+tsc + `grep -rn "resolveTmdbRef\|ItemLike" src/ scripts/ --include="*.ts"` 零非注释命中。
- [ ] Step5 提交 `refactor(seams)!: orchestrator + task context read own ids/rows — resolveTmdbRef retired`。

## Task 6（P4b）：dashboard 海报直连 CDN（D3）

**Files**: Modify `src/dashboard/apiV2.ts`（DTO posterTag→posterPath；删 proxyPoster :397-445）、`src/dashboard/server.ts`（删 /api/poster :66-76 与 jellyfin deps :15-16,43,76）、`src/cli/index.ts`（dashboard 接线去凭证 :451-452 一带）、`web/src/api/client.ts:14-16` + `web/src/components/Poster.tsx`（`https://image.tmdb.org/t/p/w400${posterPath}`，null 显占位）、对应测试。
- [ ] Step1 失败测试：DTO 带 posterPath；server 无 /api/poster 路由。Step2 红 → Step3 实现 → Step4 绿+tsc（web 侧 `cd web && npx tsc --noEmit` 若有独立 tsconfig——照现有 web 测试惯例）。
- [ ] Step5 提交 `feat(dashboard)!: posters direct from TMDB CDN — poster proxy + jellyfin creds deleted`。

## Task 7（P5）：realign port 换芯（主控逐 hunk 亲验）

**Files**: Create `src/v2/realignLibraryPort.ts` + `.test.ts`（新实现）；Modify `src/v2/realignExecutor.ts`（**仅允许两类 hunk**：①接口 :342-349 删 `deleteItem` 行（D1）②若 import 类型需换源的 import 行——**其余零改动，尤其 :288-304 waitForJellyfinIdle 与 :459-680 安全层**）；Modify `src/cli/index.ts`（port 注入换新实现，删 :228 的 deleteItem 接线）、realignExecutor.test.ts（mock 形状去 deleteItem）。

**新 port 实现语义**（D4 承载安全属性）：
- `getItem(seriesId)` → 自有 series 行 → `{ProviderIds:{Tmdb: tmdbIdFromOwnId(id)}, Name: name, ProductionYear: year}` 形状适配（realign :589 消费面就这三个字段——先 read 确认再定 shim 宽度）。
- `getItemsPage(startIndex, limit)` → 自有 episodes/movies 查询产出 `{Id,Path,Type,SeriesId,ParentIndexNumber,IndexNumber}` 最小形状（verifyRealignedCounts :313-340 消费面——read 确认）。**注意**：重排刚落盘时自有库尚未 re-ingest，count 校验需要"现实视图"——实现为**直接走盘**（fs 扫 finalShowDir 数集）或"先踢 ingest 再查行"，实现者按 verifyRealignedCounts 的语义选择并注释（推荐走盘：验证的本来就是磁盘现实）。
- `getScheduledTasks()` → `ingestLock.held ? [{State:'Running'}] : []` 形状。
- `getVirtualFolders()` → MEDIA_ROOTS 合成 `[{id:'root:<i>', locations:[root]}]`。
- `refreshLibrary(_id)` → 触发一次 ingest pass（注入 `runIngest: () => Promise<void>`）。
- [ ] Step1 失败测试：新 port 六方法语义各一（含锁→Running 映射、走盘 count）。
- [ ] Step2 红 → Step3 实现+接线 → Step4 绿+tsc。
- [ ] Step5 **主控亲验点**：`git diff src/v2/realignExecutor.ts` 逐 hunk 声明（预期 ≤2 hunk 且不触 :288-304/:459-680）；realign 全测试套零缩水。
- [ ] Step6 提交 `feat(realign): library-native port implementation — ingest-lock carries the never-move-during-scan property (5 safety layers untouched)`。

## Task 8（P6）：park 救援页（一次性脚手架）

**Files**: Modify `src/dashboard/apiV2.ts`（`buildParked(db)` 读 parked_paths；claim 校验：tmdb_id 数字、prefix 非空）、`src/dashboard/router.ts`/`server.ts`（GET /api/parked、POST /api/parked/claim {path, tmdbId, isTv}→addOverride(dirname(path))）、web/ 朴素页（列表+输入框+按钮，样式随意）；Test API 两端点。
- [ ] Step1 失败测试：parked 列表返回；claim 写 override；claim 后（fake ingest 再跑）路径识别命中。
- [ ] Step2 红 → Step3 实现 → Step4 绿+tsc。
- [ ] Step5 提交 `feat(dashboard): disposable park-rescue page — list + claim-by-tmdbId (writes identify_overrides)`。

## Task 9（P7a）：出口清算

**Files**: Delete `src/adapters/players/jellyfin.ts`、`types.ts`（+tests；若 T7 后仍有薄类型消费先收缩进消费文件）；Modify `src/cli/index.ts`（requireEnv JELLYFIN_* :75 删；assemble 收缩）、`src/cli/doctor.ts`（checkJellyfin :15-25 与 checkPathMappings :119-142 删（D2）、cmdDoctor 调用点收缩）、README.md/.env.example/docker-compose*.yml（JELLYFIN_*、MEDIA_PATH_MAPPINGS 文档退役；compose 去 jellyfin 容器写成迁移说明段落）、`src/core/mediaContext.ts`（PathMapping/mapPath 保留（D2）+注释注明恒等现状；parsePathMappings 的 env 读取若无消费则删）。
- [ ] Step1 grep 复核 `JellyfinClient|PlayerServer|JELLYFIN_` 生产零命中（realign port shim 若留最小类型须已内联）。
- [ ] Step2 删+改 → 绿+tsc + doctor 冒烟（无 JELLYFIN env 跑 `npx tsx src/cli/index.ts doctor` 不再要求 JF）。
- [ ] Step3 提交 `feat(exit)!: Jellyfin fully removed — client/env/doctor/docs retired`。

## Task 10（P7b）：真库终极闸门（主控亲跑，Wave 判 PASS 才收官）

沿用 B3/W0-5 打法（detached+监视器+取证；`ssh media-router` 直连/在公司 tunnel）。**不再建测试 Jellyfin——这正是验收点**。
- [ ] 部署 HEAD → 无 JELLYFIN env 起 daemon（快节拍）→ **真库冷启动全量摄取**（roots=/mnt/nvme0n1-4/nas_media 的媒体子树：anime/TV/Movies + _scout_realign_test）→ 取证：识别率、park 清单、行数/id 形状抽查、探针命中率。
- [ ] **删光字幕重建验收**：`find <roots> -name "*.zh-Hans.*" -o -name "*.zh-Hant.*" ...`（脚本列清单存档后删除，**只删字幕文件**）→ 下轮 ingest 全库回 missing → orchestrate pass → find worker 真装回（观察若干集落盘即判机制成立，不必等全库装完）；OS/assrt 配额监控，逼近置顶报。
- [ ] park 救援走通：dashboard 认领一个真 park → override → 下轮识别命中。
- [ ] realign 真站（自有 port）：造/复用乱排目录 → orchestrator 派 realign → 5 层安全下重排完成 → ingest 拾取新布局。
- [ ] 判 PASS → 拆测试进程；FAIL → systematic-debugging 回修。

## Task 11：收官（文档+记忆）

- [ ] README 残余 Jellyfin 叙事清（T9 之外的散点）；记忆两库接续点更新（战役完成态、dashboard 大讨论=下一战役）；任务板收账。
- [ ] 提交 `docs: de-jellyfin campaign wrap`。

---

## 自我审查
- **Spec 覆盖**：P1→T1、P2→T2、P3→T3+T4、P4→T5+T6、P5→T7、P6→T8、P7→T9+T10、收官→T11；D1-D7 全部编号入任务。
- **占位符**：无 TBD；坐标全内联；新代码给形状/骨架，逐行留给能读码的执行子代理（本仓惯例）。
- **类型一致**：`ownIds.ts`（tmdbIdFromOwnId/episodeId）T3 建 T5/T7 用；`ingestLock` T3 建 T4/T7 用；`EmbeddedSubtitleTrack` T1 建 T3 用；`makeIngestPass`/`IngestResult.changed` T3 建 T4/T7(refreshLibrary) 用；parked/override 方法 T2 建 T3/T8 用——命名以先建者为准。
- **顺序**：T1/T2 可并（不同文件域但串行提交照旧）；T3 依赖 T1+T2；T4 依赖 T3；T5/T6 依赖 T4；T7 依赖 T3(锁)+T5(ownIds)；T8 依赖 T2；T9 依赖 T5-T8 全清；T10 gate；T11 收官。
