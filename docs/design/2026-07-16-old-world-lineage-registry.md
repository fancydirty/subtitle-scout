# 旧世界血统申报登记册（R3 首次全仓执行 · 2026-07-16）

状态：造册完成（机械横扫，子代理执行、主控收录）。裁决列由主控在阶段〇 Task 0.3 填写——
每条必须裁决为 **处决**（列入本战役任务）/ **改造**（本战役或立项）/ **哲学豁免**（理由必须
援引北极星条款，"改起来麻烦"不是理由）。审计官 A/B/C 的语义发现随后并入第三节。

检索式：`grep -rn "旧管线|old pipeline|同 executor|抄自|remainingTargets|旧逻辑|历史行为|沿用历史|historical|legacy" src/ --include="*.ts"`

## 一、生产代码命中（39 条）

| # | 文件:行号 | 原文（截一行） | 守护的代码在做什么 | 调用方 | 裁决 |
|---|---|---|---|---|---|
| 1 | core/seasonShape.ts:2-4 | legacy season diagnosis / extracted out of diagnoseSeason.ts (legacy-pipeline module) | mirrorExceedsSeasonTable() 纯函数：镜像季集数 vs TMDB 季表 | orchestratorAgent.tools.ts | 待裁决 |
| 2 | agent/reasoningAgent.ts:30 | fix for the old pipeline's thinking-disable illness | makeReasoningAgent 的 reasoning 默认 'high' | findSubtitleWorker.ts、orchestratorAgent.ts | 待裁决 |
| 3 | agent/resultHandles.ts:118 | legacy callers without it fall through to runSearch's own ['zh'] | SearchSourceDeps.targetLanguage 缺省回退 | findSubtitleWorker.ts | 待裁决 |
| 4 | agent/findSubtitleWorker.tools.ts:36 | staging langTag 占位（zh→'zh-Hans'） | stagingLangTag()：下载暂存名 | 本文件 download_candidate | 待裁决 |
| 5 | agent/findSubtitleWorker.schemas.ts:29 | rather than the full legacy MediaContext | FindSubtitleTask 形状与旧 MediaContext 解耦声明 | 多处 | 待裁决 |
| 6 | agent/orchestratorAgent.tools.ts:78 | old "provider_ids is an unreliable historical mirror" caveat | check_series_layout 内部 tmdbId 解析说明 | orchestratorAgent.ts | 待裁决 |
| 7 | cli/legacyJobRouting.ts:18,28 | 旧管线执行器已切断，体面收场 | tombstoneLegacyJob()：存量旧 kind 行退休 | cli/index.ts cmdWatch | 待裁决 |
| 8 | cli/fetchLib.ts:51 | historical per-provider default ['zh'] | DEFAULT_ENABLED_CHECK_LANGUAGES：未指定语言时的 adapter enabled 计算 | resultHandles.ts、subtitle-fetch.ts | 待裁决 |
| 9 | cli/adapters/opensubtitlesAdapter.ts:45 | 旧逻辑把 imdb 误传 parent_imdb_id，实测 0 命中 | OS adapter 修复注记 | buildAdapters.ts | 待裁决 |
| 10 | cli/targetLanguages.ts:3,25,30 | historical single-target 默认 ['zh']；legacy SKIP_CHINESE_ORIGIN 兼容 | parseTargetLanguages/resolveTargetLanguages | cli/index.ts | 待裁决 |
| 11 | cli/index.ts:45,144,199 | legacy 分流导入 + SKIP_CHINESE_ORIGIN 兼容注记 | cmd 入口的语言解析与旧 job 分流接线 | cmdWatch/cmdReconcileAll | 待裁决 |
| 12 | cli/index.ts:211 | 这条新链路没有旧管线的（journal 记账） | emitProviderEvent：provider 事件→日志 | cmdWatch | 待裁决 |
| 13 | cli/index.ts:275,287-288 | 同旧管线每次子进程重建 adapters；RunsRepo 复用 | worker_task deps 组装注记 | cmdWatch | 待裁决 |
| 14 | v2/executor.ts:22-27 | 旧管线执行内部已删，realign 独苗 + 旧 kind throw 前置分流 | executeJob() 残躯 | cli/index.ts、daemon.ts | 待裁决 |
| 15 | v2/findSubtitleWorkerTask.ts:49 | 'zh' historical default | mapper targetLanguage 缺省 | 本文件 | 待裁决 |
| 16 | v2/findSubtitleWorkerTask.ts:94-97 | **事故样本**：same query remainingTargets() … LIMIT 1 | representativeEpisodeId()——季级意图机械降解点 | mapWorkerTaskToFindSubtitleTask | **处决**（本战役 Task 4，已裁） |
| 17 | v2/findSubtitleWorkerTask.ts:112 | mirrors remainingTargets()'s movie branch | representativeMovieId() | 同上 | **处决**（随 Task 4 一并，已裁） |
| 18 | v2/findSubtitleWorkerTask.ts:245,247 | RunsRepo 复用自旧管线构造；退役后时间线断供警告 | runs 可选依赖注记 | cli/index.ts | 待裁决 |
| 19 | v2/libraryRepo.ts:296 | 旧管线的聚合层（已删）历史指涉 | missingBySeason() 注释 | orchestratorAgent.tools.ts | 待裁决 |
| 20 | v2/libraryRepo.ts:340 | 默认 'zh-Hans' 沿用历史行为；注释还指涉已死的 executor.ts 调用方 | markCovered() language 参数 | findSubtitleWorkerTask.ts | 待裁决 |
| 21 | v2/jobsRepo.ts:406-407 | 原旧管线聚合层 cleanup；注释自供零生产调用点 | retire()——纯测试供养的活方法 | 仅测试 | 待裁决 |
| 22 | v2/jobsRepo.ts:432 | 旧管线执行器不再接线 | retireClaimed() | legacyJobRouting.ts | 待裁决 |
| 23 | v2/realignExecutor.ts:246 | 旧管线 callStructured 记账机制不再需要 | makeRealignRunEpisode 注记 | cli/index.ts | 待裁决 |
| 24 | files/subtitleWriter.ts:20 | historically only zh-Hans/zh-Hant，已泛化 | langTag 字段文档 | tools.ts、zimukuAdapter.ts | 待裁决 |

（同一函数的多行命中已并组；原始逐行清单见本文件 git 首版提交的子代理原始报告，此表为主控收录版。）

## 二、测试文件命中（16 条，只列坐标）

core/schemas.test.ts:228；agent/languages.test.ts:19,37；agent/resultHandles.test.ts:168；
cli/targetLanguages.test.ts:34,55；cli/legacyJobRouting.test.ts:2,31,45,56；
v2/executor.test.ts:28；v2/recovery.test.ts:50；v2/findSubtitleWorkerTask.test.ts:111,277；
v2/libraryRepo.test.ts:70；v2/realignWorkerTask.test.ts:192

测试命中不单独裁决——随其生产对应项的裁决联动（处决生产代码时其锁测试同死或改锚）。

## 三、审计官语义发现（A=队列缝 / B=工具面 / C=摄取识别）

（待审计官报告回收后由主控复核收录）

## 四、裁决记录（Task 0.3 填写）

（待）
