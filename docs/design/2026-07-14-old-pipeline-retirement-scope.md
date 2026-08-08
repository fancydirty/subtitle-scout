# 旧管线退役 · 爆炸半径盘点（read-only survey，2026-07-14）

状态：只读盘点完成，**未删任何代码**，等用户 go/no-go + 优先级拍板后再动手。
背景：v3 真站验收 + 真模型矩阵均已通过，v3 阶段⑧（退役旧 pre-v3 pipeline）的门解锁。用户曾拍板"该退就退、无保险一说"——**但那是在不知道爆炸半径前说的**；本盘点揭示旧管线仍是 v3 两个功能的承重墙，判断依据已变，需用户据此重新拍板。

## 一句话结论

**"退役旧管线"不是删文件，是一次多步迁移**——旧管线目前仍被 **① daemon 自动路径**（每 15 分钟 aggregate→series_season/movie job）喂着，且被 **② v3 的两个功能实际调用**：
- **验证码求解**（`solveNumericCaptcha`，v3 找字幕 worker 的 zimuku 路径用）仍跑在旧的 `LlmRuntime`/`callStructured` 强制 JSON 栈上 → `llm.ts`/`runtime.ts`/`probe.ts`/`profile.ts`/`quirks.ts` 经此可达，**删不掉**直到验证码迁移。
- **v3 realign worker**（阶段⑥）仍调用旧的 `runPipeline` 抓字幕 → `runPipeline` 是 v3 realign 的活依赖,**删不掉**直到 realign 改接 v3 找字幕流。

## 两条管线并存（按 job.kind 路由，cli/index.ts:520-539）

- `worker_task` → `handleWorkerTask` → **v3 新路径**（find_subtitle/realign/orchestrate，手动/dashboard 触发，需 TMDB_API_KEY）。
- `series_season | movie | realign` → `executeJob`（v2/executor.ts）→ **旧 `runPipeline`**（daemon 每 15 分钟自动喂）。

旧路径**不是**藏在开关后的死代码——daemon 仍在自动跑它。

## 纯旧路径（可删候选）

- **核心确定性流水**：`core/pipeline.ts`(1027行,`runPipeline`)、`core/gate.ts`(确定性集号守门人 `runGate`+`matchesEpisodeCode` 位置回退)、`core/orphanGate.ts`、`core/seasonPackGate.ts`、`core/cache.ts`(DecisionCache)、`core/journal.ts`。
- **强制工具调用 LLM 层**："不让模型思考"三件套 `probe.ts`/`profile.ts`/`quirks.ts` + `llm.ts` 的 `callStructured`(toolChoice 强制单发)/`callPromptJson` + `runtime.ts` 的 `LlmRuntime.call` 自愈包装。**⚠ 经验证码可达 v3,见下。**
- **10 个单发 agent**（设计里"溶进子代理推理"）：identifyMedia/planSearch/rankCandidates(LLM 部分)/verifySubtitle/judgeOrphan/mapSeasonPack/mapLooseEpisodes/diagnoseSeason/harvestAlias。`solveNumericCaptcha` 设计里"保留为干净工具"但目前仍绑旧栈。
- **v2 executor 旧 job 处理**：`executeJob` 的 series_season/movie 分支、`makeRunEpisode`→`runPipeline`、`makeDiagnoseSeason`。
- **旧 job.kind 喂料**：`v2/aggregator.ts` 的 `aggregate` 造 series_season/movie job（daemon reconcile 调）——退旧 kind 必须同时退它。

## 共享符号（旧模块定义、v3 仍 import，**先提取别误删**）

- **`mirrorExceedsSeasonTable`**（`diagnoseSeason.ts:24`,2 行纯函数）→ v3 import 方：`orchestratorAgent.tools.ts:6,83`（check_series_layout 事实核查）+ `libraryRealign.messyMatrix.test.ts`。**唯一真正的旧→新符号依赖,须先提取到独立模块再删 diagnoseSeason.ts**（正是设计说的"mirrorExceedsSeasonTable 要先提取"）。
- **可复用 core 基建**（本就不算"旧管线",列出防误删）：`core/episode.ts`(matchesEpisodeCode/formatEpisodeCode,v3 findSubtitleWorker.tools 的 check_episode_code_safety 顾问式复用)、`core/schemas.ts`、`core/mediaContext.ts`(沙盒)、`files/stagingSandbox.ts`、`cli/fetchLib.ts`、`adapters/download/direct.ts`、`files/subtitleWriter.ts`、`files/subtitleInspect.ts`。**全 KEEP。**
- **rankCandidates 纯 helper**（isGraphicOnly/filterGraphicOnly/compactCandidates/neededEpisodeCodesFor）：设计想留作确定性工具,但**当前无 v3 importer**（v3 走 core/episode.ts）——留是前瞻决定,非硬依赖。

## 两条承重墙（退役前必须先拆,否则 build/新路径炸）

1. **`solveNumericCaptcha` → LlmRuntime**（`buildAdapters.ts:11-13,60-68`,仅 ZIMUKU_ENABLED 时）：把验证码求解迁到 `reasoningAgent`/finalize-tool 或普通多模态 `generateText`,`buildAdapters` 改建普通 model。**这是解锁删 llm.ts/runtime.ts/probe.ts/profile.ts/quirks.ts 的闸。最高风险,先做。**
2. **v3 realign worker → `runPipeline`**（`realignWorkerTask.ts`→`executeRealign`→`makeRealignRunEpisode`→`runPipeline`,realignExecutor.ts:17,219,222）：把 realign 的字幕流改接 v3 找字幕 worker（或派 find_subtitle worker_task）。**第二高风险,深度纠缠,触及数据安全 realign 流。**

## 建议退役顺序（每步保持 tsc+vitest+web 绿）

1. 提取 `mirrorExceedsSeasonTable` 到独立模块,repoint 3 处引用。**低风险,先做,解锁后续。**
2. 决定 rankCandidates 纯 helper 去留（留则提取+搬测试+解开 rankCandidates.test 的 runGate import）。
3. **迁 `solveNumericCaptcha` 脱离 LlmRuntime**（承重墙①,最高风险,先于任何 LLM 层删除）。
4. **拆 realign worker 对 `runPipeline` 的依赖**（承重墙②,第二高风险,触及数据安全）。
5. 退旧喂料+路由：`aggregate` 停造 series_season/movie、去 cmdWatch 旧 executeJob 分支+daemon reconcile→aggregate 接线、去 cmdRun/cmdRunItem 的 runPipeline 调用。
6. 删旧模块（此时已无引用）：pipeline/gate/orphanGate/seasonPackGate/cache/journal + 9 个单发 agent + executor 旧内部 + aggregator + 各测试；确认步骤 3 后再删 LLM 五件套。
7. （末,可选）DB job.kind CHECK 去 series_season/movie——需全表重建配方,历史行使其最险,留着枚举值也无害。
8. 部署清算：清掉 operator 配置里的 LLM_EXTRA_BODY thinking-disabled 逃生舱,防与 reasoning_effort:high 冲突。

## 我的建议（据爆炸半径）

**不建议现在闷头做全量退役。** 理由:①旧管线并存不主动为害(只是 legacy 在旁边跑);②全量退役是触及数据安全 realign 流的多步迁移(承重墙①②),做错风险高;③更高北极星价值在别处——**B 层(orchestrator 编排判断,零测试覆盖)** 或真数据测试(暴露新问题)才是"暴露问题"北极星的正戏。
可现在做的**廉价安全一步**:提取 `mirrorExceedsSeasonTable`(步骤 1,搬 2 行纯函数,无论退不退都是净改进)。承重墙①②应作为独立 deliberate 效应在排优先级后再做。
