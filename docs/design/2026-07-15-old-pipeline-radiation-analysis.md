# 旧 pipeline 退役·辐射分析（2026-07-15，HEAD e61f1af）

只读全仓引用扫描的结论，作为 Phase2/3 退役 Wave 0 设计的输入。校对基准：scope 文档
`2026-07-14-old-pipeline-retirement-scope.md`（本分析发现它有三处过时/低估，见下）。

## 头条结论：清单还不可删——三条活承重边 scope 文档没足额计价

Wall①（captcha，479f157）Wall②（realign→v3 worker，94457bd）确已断（直接读码确认）。但：

### 边 1：旧 scan→aggregate→executeJob→runPipeline 环仍在每 tick 并行跑
- `v2/daemon.ts:162-188`（旧 reconcile 分支）与 `:190-223`（B2 自扫分支）是 `tickInner()` 里
  两条**独立并存**的分支；`cli/index.ts:572`（aggregate 接线）、`:584-592`（executeJob 旧 kind 分支）。
- B1/B2 设计上不写库行（refresh-bridge），**依赖旧 `scan()` 做镜像、旧 `aggregate()` 造 job**。
  今天存量库条目的字幕获取大多仍走这条旧路。它不是闲置遗产，是在岗机制。
- （注：`scan()`/scanner.ts 是镜像机制，**KEEP**，不在删除清单。）

### 边 2：realign 的"出生"和"复跑"仍靠旧机器
- **出生**：`v2/executor.ts:345-357` no_safe_match 分支 → `deps.diagnoseSeason`（`makeDiagnoseSeason`
  `:530-568`，吃 `LlmRuntime`）→ `absolute_flat` 判定 → `jobs.upsertWanted({kind:'realign'})`。
  **realign job 只从旧单发 agent 栈出生**——Wall① 只断了 captcha 的 LlmRuntime 用途，没断这条。
- **复跑**：`realignExecutor.ts:803,:865` → `jobs.retireAllForSeries`（jobsRepo.ts:424-440）——
  重排后退休旧 series_season job，**依赖下一轮 aggregate 按新结构重新聚合**恢复搜索。
  砍 aggregate 就砍断 realign 的重排后恢复路径。

### 边 3：dashboard 直读旧 job kind
- `dashboard/apiV2.ts:147-157`（series_season）、`:181-190`（movie）、`:292-299`（runs 时间线）；
  前端 `web/src/components/PosterCard.tsx:14,19`（"处理中"徽章）、`SeriesDetail.tsx:45` 消费。
- 停掉旧 feed 后这些**静默冻结**（不报错，永远不更新）——scope 文档没查到这层。

## scope 文档的过时项
- `mirrorExceedsSeasonTable` 提取**已完成**（350d700 → core/seasonShape.ts，orchestratorAgent.tools.ts:101 在用）——步骤 1 无需再做。
- `dashboard/api.ts`（v1 遗孤，49 行 + test）**零生产引用**（server.ts/router.ts 只 import apiV2）——
  与退役无关但立即可删（Wave 1 已执行）。
- `files/orphanScanner.ts` 不在清单但属旧管线簇（pipeline/orphanGate/judgeOrphan/cli adoption 闭包），随 Wave 2 一起走。

## 九个单发 agent 唯一生产调用点（全在旧管线接线内，全 BLOCKED）
identifyMedia/planSearch/rankCandidates/verifySubtitle → cli/index.ts makeDeps :133-136；
judgeOrphan → :173；mapSeasonPack → :182；harvestAlias/mapLooseEpisodes → core/pipeline.ts:22-23；
diagnoseSeason → v2/executor.ts:565。
LLM 五件套：callStructured/callPromptJson + runtime/probe/profile/quirks 全部 BLOCKED 于上述栈；
`llm.ts` 里 makeModel/withConnectRetry/isConnectError/injectExtraBody/LLM_TIMEOUT_MS **KEEP**（v3/captcha 在用）。

## DB
jobs.kind CHECK 枚举**不动**（第 4 次全表重建不值得；死 kind 值无害；retireAllForSeries 等
一堆手写 SQL 读这些值）。删代码不需要迁移。

## 分波删除序列
- **Wave 0（前置设计+实现，真正的活）**：
  1. realign 出生权移交 orchestrator（check_series_layout + dispatch_realign_task 已存在且 B 层
     12/12 + 真站验证过）→ 删 executor.ts:345-357 触发器 + makeDiagnoseSeason。需先论证
     orchestrator 对存量乱排剧的覆盖等价性。
  2. realign 复跑路径改 v3 论证：重排改名 → 旧路径消失/新路径出现 → scan 镜像 + 自扫 Signal B
     → orchestrate pass → 正常派活。需真站/测试验证这条链在"重排完成后"场景成立。
  3. dashboard 活动源改 worker_task/orchestrator 派生（apiV2 三处 + PosterCard/SeriesDetail）。
  4. 以上落地后：停 aggregate 造旧 job、删 executeJob 旧 kind 分支、删 cmdRun/cmdRunItem 的
     runPipeline 调用。
- **Wave 1（立即，已做）**：删 dashboard/api.ts（+test）。
- **Wave 2（Wave 0 后，互引簇整体删）**：aggregator、executor 旧分支+makeRunEpisode+makeDiagnoseSeason、
  core/pipeline+gate+orphanGate+seasonPackGate+cache+journal、九单发 agent、orphanScanner、
  cmdRun/cmdRunItem+makeDeps 管件。注意 pipeline.test.ts 2704 行是全仓最大测试文件，预算真实时间。
- **Wave 3（Wave 2 后）**：llm.ts 的 callStructured/callPromptJson/StructuredOutputError 等、
  runtime/probe/profile/quirks 四件、LLM_EXTRA_BODY thinking-disabled 逃生舱清算、
  assemble() 里 profileStore/journalStore 残留。
