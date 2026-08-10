# 旧 Pipeline 退役战役 Wave 0-3 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（sonnet 子代理逐 Task 执行，主控编排+两阶段复核）。Steps 用 checkbox 跟踪。
> **执行前置**（fresh 上下文先读）：设计=`docs/design/2026-07-15-old-pipeline-retirement-campaign-design.md`(a13d3d2)；辐射分析=`docs/design/2026-07-15-old-pipeline-radiation-analysis.md`(e837bbc)；铁律见记忆 `project-v3-agentic-rebirth`（sonnet 子代理实现/不用 Workflow/不用 worktree 隔离/realign 5 重安全层零触碰/skill 只主控改）。基线：main=a13d3d2 之后、1501 绿、tsc 干净。真站访问：在公司走 `ssh media-router-tunnel`，长作业 detached+轮询。

**Goal**：切断旧管线三条活承重边（Wave 0）→ 分簇删除旧管线全部模块（Wave 2）→ 清算 LLM 旧栈（Wave 3），全程 v3 行为无回归、dashboard 不冻结、realign 出生/复跑不断。

**Architecture**：先换 dashboard 数据源（防冻结窗口）→ 移交 realign 出生权给已验证的 orchestrator → 用测试锁死复跑链 → 切 feed（含存量旧 job 墓碑处理）→ 真站闸门 → 三组互引簇逐组删 → LLM 五件套收官。

**Tech Stack**：TypeScript ESM(.js specifier)、vitest、better-sqlite3、既有 v3 栈。

**Gate 纪律**：每 Task 后 `npx tsc --noEmit` 干净 + `npx vitest run` 绿；删除类 Task 加"grep 零活引用"步；逐 Task 提交，conventional message + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

## Task 1（W0-3a）：v3 runner 写 runs 行

**Files**: Modify `src/v2/findSubtitleWorkerTask.ts`、`src/v2/realignWorkerTask.ts`、`src/cli/index.ts`（cmdWatch 把已有的 `runs = new RunsRepo(db)` 注入两个 runner deps）；Test 对应 `.test.ts`。

**现状**：v3 任务不写 runs（全仓唯一写入 = `RunsRepo.insert`，src/v2/runsRepo.ts:18-43，签名 `{jobId,startedAt,finishedAt,decision,detail,journalPath,llmCalls?,assrtCalls?}`）；dashboard 时间线因此只见旧管线。

- [ ] Step1 失败测试：runFindSubtitleWorkerTask 完成（installed 与 no_safe_match 两例）后 runs 表各有一行，`decision`=worker decision、`detail`=reason、`job_id`=该 job。realignWorkerTask 同理一例（decision 用 `realign:<结果>` 形式）。
- [ ] Step2 红。
- [ ] Step3 实现：两 runner 的 deps 增 `runs: Pick<RunsRepo,'insert'>`（可选，未注入则跳过写行——测试外旧调用点不破）；在 completeDone/completeError/park 各汇合点前记录 startedAt（claim 时刻取 `now()` 入闭包）写一行。orchestrate 任务**不写**（编排非内容产出）。cli/index.ts cmdWatch 注入。
- [ ] Step4 绿 + tsc。
- [ ] Step5 提交 `feat(dashboard): v3 worker tasks write runs rows (timeline parity with old pipeline)`。

## Task 2（W0-3b）：apiV2 活动/时间线兼容 worker_task

**Files**: Modify `src/dashboard/apiV2.ts`（三处：:147-157 series 活动、:181-190 movie 活动、:292-299 runs 时间线）；Test `src/dashboard/apiV2.test.ts`（沿用既有测试造数据的 idiom）。

- [ ] Step1 失败测试：①只有 `worker_task`(taskType=find_subtitle,series_id=S) 活跃 job 时，buildLibrary 该 series 的 `job.state` 非空；②movie 同理；③v3 runs 行（Task1 产物）出现在 buildSeriesDetail 时间线。
- [ ] Step2 红。
- [ ] Step3 实现：series 活动查询扩为双源，形如
  ```sql
  WHERE (j.kind = 'series_season'
     OR (j.kind = 'worker_task'
         AND json_extract(j.payload,'$.taskType') IN ('find_subtitle','realign')))
    AND j.series_id IS NOT NULL
  ```
  （保持"每 series 取 max(id)"语义）。movie 分支先读 `makeDispatchFindSubtitleTaskTool`（src/agent/orchestratorAgent.tools.ts）确认 movie 任务写的是 `movie_id` 列还是仅 payload——按实际落列写查询（若仅 payload 用 `json_extract(j.payload,'$.movieId')`）。runs 时间线 JOIN 的 kind 过滤同样扩双源。DTO 形状不变，web/ 零改动。
- [ ] Step4 绿 + tsc。
- [ ] Step5 提交 `feat(dashboard): activity badge + runs timeline read worker_task jobs (dual-source during transition)`。

## Task 3（W0-1）：realign 出生权移交 orchestrator

**Files**: Modify `src/v2/executor.ts`（删 :345-357 诊断钩子整块；删 `makeDiagnoseSeason` :530-568）、`src/cli/index.ts`（删 diagnoseSeasonClosure 构造与传参——grep `diagnoseSeason` 找全）、`src/v2/executor.test.ts`（删/改覆盖该钩子的用例）。**不动** `src/agent/diagnoseSeason.ts` 文件本体（Wave 2 组C删）。

- [ ] Step1 先写保障测试（若无）：orchestrator 侧已有 messy-realign 覆盖（B 层矩阵），本 Task 只需 executor 测试调整——确认删钩子后 no_safe_match 分支行为不变（job 正常退避，无 realign 副作用）。
- [ ] Step2 删钩子+接线；executeJob 的 deps 类型去掉 `diagnoseSeason` 字段。
- [ ] Step3 绿 + tsc + `grep -rn "diagnoseSeason" src/ --include="*.ts" | grep -v "agent/diagnoseSeason"` 只剩 agent 文件自身与其 test。
- [ ] Step4 提交 `refactor(retirement): realign birth-right moved to orchestrator — remove executor no_safe_match diagnose hook`（提交信息写等价性论证：check_series_layout 同源信号 mirrorExceedsSeasonTable[orchestratorAgent.tools.ts:88 注释自证]+触发面更早更宽+B 层 12/12+真站零误触发）。

## Task 4（W0-2）：复跑链集成测试

**Files**: Modify `src/daemon/selfScanTrigger.test.ts`（新用例）；`src/daemon/selfScanTrigger.ts` 只允许加注释（复跑链说明落在这，**realignExecutor.ts 一行不碰**）。

- [ ] Step1 新失败用例（红先）：模拟重排完成语义——pass1 `knownPaths={A,B}`(旧路径)；pass2 `knownPaths={C,D}`(重排后新路径，旧同时消失)。断言 pass2 触发 orchestrate 入队（增长 diff 非空，移除不抑制新增）。用例注释写明它锁的是"realign 完成→scan 镜像→Signal B→orchestrate 复跑"链（retireAllForSeries 后的 v3 恢复路径，替代旧 aggregate 重聚合）。
- [ ] Step2 实现应已天然绿（现有 grow-diff 逻辑）；若不绿说明 removals 处理有 bug——按 systematic-debugging 修。
- [ ] Step3 绿 + tsc，提交 `test(retirement): lock post-realign resume via self-scan Signal B (replaces aggregate re-derivation)`。

## Task 5（W0-4）：切 feed + 存量旧 job 墓碑

**Files**: Modify `src/cli/index.ts`（cmdWatch：daemonDeps 摘 `aggregate` 接线 :572 一带；executeJob 闭包删旧 kind 路由 :584-592，加墓碑分支；删 `cmdRun`/`cmdRunItem` 及 CLI 注册 :845 一带；顺藤移除仅服务上述的死构造——`makeRunEpisode`/`runEpisode`/`withJournal` 调用点/`makeDeps` 闭包中 identify/plan/rank/verify/adoption/seasonPack 的引用，以 grep+tsc 双重确认）、`src/v2/daemon.ts`（reconcile 分支保 `scan()` 删 `aggregate()` 调用与 DaemonDeps.aggregate 字段）、对应测试。

**墓碑语义（存量 DB 安全）**：生产 DB 里可能残留 kind∈{series_season,movie,realign} 的 wanted/退避 job；切走旧 executeJob 后 claimNext 仍可能领到它们。executeJob 闭包加：
```ts
// Retirement tombstone: 旧管线 kind 不再有执行器。存量行退休（非 error——它们不是故障，
// 是被 v3 替代），realign 旧 kind 同理（v3 的 realign 走 worker_task/taskType='realign'）。
if (job.kind !== 'worker_task') {
  jobs.retire(job.id, Date.now())
  log(`retired legacy ${job.kind} job ${job.id} (old pipeline retired; v3 covers it)`)
  return
}
```
（`jobs.retire` 若无此单 id 方法，按 jobsRepo 现有 retire 语义补一个最小方法+测试。）

- [ ] Step1 失败测试：①daemon tick 不再调用 aggregate（fake 断言）②executeJob 收到 series_season job → 被 retire+log，不 throw ③worker_task 照常路由。
- [ ] Step2 红 → 实现 → 绿 + tsc。
- [ ] Step3 `grep -rn "aggregate" src/cli src/v2/daemon.ts | grep -v test` 零命中；`grep -rn "cmdRun\b\|run-item" src/cli` 零命中；`npx tsx src/cli/index.ts --help` 不再列 run/run-item（人工瞄一眼输出）。
- [ ] Step4 提交 `feat(retirement)!: cut old feed — no aggregate, no old-kind execution (tombstone-retire legacy rows), drop cmdRun/cmdRunItem`。

## Task 6（W0-5）：真站闸门（Wave 2 大删前）

**主控亲自跑**（B3 同款打法：一次性测试 Jellyfin + 隔离目录 + detached + 监视器；辐射锁死测试区）。测试 Jellyfin 重建流程（B3 已验证的 wizard 序列）：node:22 复用本地镜像→`docker run -d --name scout-jellyfin-test -p 8097:8096 -v /mnt/nvme0n1-4/scout-test-jellyfin/config:/config -v /mnt/nvme0n1-4/nas_media/_scout_realign_test:/media:ro ghcr.io/jellyfin/jellyfin:latest`→`/Startup/Configuration`→`/Startup/User`(scouttest/scouttest123)→`/Startup/Complete`（header `X-Emby-Authorization: MediaBrowser Client="scout-test", Device="cli", DeviceId="b3", Version="1.0"`）→`/Users/AuthenticateByName` 取 token→`/Auth/Keys?App=scout-b3` 造 key→`/Library/VirtualFolders?name=ScoutTest&collectionType=tvshows&paths=/media/library&refreshLibrary=true`（body `{"LibraryOptions":{"EnableRealtimeMonitor":true}}`）。容器内 JELLYFIN_URL=`http://172.17.0.1:8097`。

- [ ] 部署 HEAD → 快节拍 daemon（SCAN_INTERVAL_MS=60000、RECONCILE_EVERY_MS=60000、独立 SUBTITLE_SCOUT_CACHE_DIR）。
- [ ] 断言①：跑 ≥5 tick 后查 jobs 表，kind∈{series_season,movie} **零新建**（id 与 created_at 判定）。
- [ ] 断言②：v3 链照常——投放新文件→Signal A/B→orchestrate→find_subtitle 派发（B3 同款日志指纹）。
- [ ] 断言③：dashboard API（server 起在容器内或直调 buildLibrary/buildSeriesDetail 脚本）活动徽章/时间线来自 worker_task/新 runs 行。
- [ ] 断言④（出生权移交实证）：造乱排剧目录（如平铺 `Frieren/01.mkv..05.mkv`，真文件拷自 NAS）→ orchestrate pass 对其派 realign worker_task（check_series_layout→dispatch_realign_task 日志/DB 证据）。
- [ ] 判 PASS 后拆测试 Jellyfin（`docker rm -f scout-jellyfin-test && rm -rf /mnt/nvme0n1-4/scout-test-jellyfin`）。FAIL→停战役，按 systematic-debugging 回修。

## Task 7（Wave 2 组A）：aggregator + executor 旧分支

**Files**: Delete `src/v2/aggregator.ts`、`src/v2/aggregator.test.ts`；Modify `src/v2/executor.ts`（删 series_season/movie 执行内部与 `makeRunEpisode`；**保留** `executeRealignBranch` 与 realign 安全调用链一行不动）、`src/v2/executor.test.ts`（删对应切片）。

- [ ] Step1 grep 复核：`aggregate`/`makeRunEpisode` 生产引用仅剩本组内部。
- [ ] Step2 删 → 绿 + tsc → `grep -rn "aggregator" src/ --include="*.ts"` 零命中。
- [ ] Step3 提交 `chore(retirement): wave 2A — delete aggregator + executor old-kind internals (realign branch kept intact)`。
- **复核重点（主控）**：executor.ts diff 里 executeRealignBranch/所有 realign 语句零 hunk。

## Task 8（Wave 2 组B）：pipeline + 四 gate + cache/journal

**Files**: Delete `src/core/pipeline.ts`(+`pipeline.test.ts` 2704 行)、`src/core/gate.ts`、`src/core/orphanGate.ts`、`src/core/seasonPackGate.ts`、`src/core/cache.ts`、`src/core/journal.ts`（+各 test）。

- [ ] Step1 grep 复核每个文件零生产引用（组A 完成后应成立；`core/episode.ts`/`core/schemas.ts` 等 KEEP 件不许误删）。
- [ ] Step2 删 → 绿 + tsc。若 journal.ts 被 cli/report.ts 或 ledger 链引用则该文件降级为"改引用后再删"，报告偏差。
- [ ] Step3 提交 `chore(retirement): wave 2B — delete runPipeline + gates + decision cache + journal`。

## Task 9（Wave 2 组C）：九单发 agent + orphanScanner

**Files**: Delete `src/agent/identifyMedia.ts`、`planSearch.ts`、`rankCandidates.ts`、`verifySubtitle.ts`、`judgeOrphan.ts`、`mapSeasonPack.ts`、`mapLooseEpisodes.ts`、`harvestAlias.ts`、`diagnoseSeason.ts`、`src/files/orphanScanner.ts`（+全部对应 test）。

- [ ] Step1 grep 复核零生产引用（尤其 `rankCandidates` 纯 helper 与 `filterGraphicOnly`——辐射分析已证无 v3 依赖，删前再证一次）。
- [ ] Step2 删 → 绿 + tsc。
- [ ] Step3 提交 `chore(retirement): wave 2C — delete nine single-shot agents + orphanScanner`。

## Task 10（Wave 2 组D）：cli 旧管线管件收尾

**Files**: Modify `src/cli/index.ts`（`assemble()`/`Assembled`/`makeDeps` 中仅服务已删模块的构造与 import 全清；`withJournal`/journalStore/profileStore 若只剩旧管线消费也一并动——若 Wave 3 更顺手则记录留给 Task 11，报告判断）。

- [ ] Step1 grep+tsc 找全死件 → 删 → 绿。
- [ ] Step2 提交 `chore(retirement): wave 2D — strip old-pipeline plumbing from cli assemble/makeDeps`。

## Task 11（Wave 3）：LLM 旧栈清算

**Files**: Modify `src/agent/llm.ts`（删 `callStructured`/`callPromptJson`/`StructuredOutputError`/`ToolChoiceRejectionError`/`isToolChoiceRejection`/`extractJson`+对应 test 切片；**保留** `makeModel`/`LlmConfig`/`LLM_TIMEOUT_MS`/`injectExtraBody`/`isConnectError`/`withConnectRetry`）；Delete `src/agent/runtime.ts`、`probe.ts`、`profile.ts`、`quirks.ts`(+各 test)；Modify `src/cli/index.ts`（LlmRuntime 构造 :119-124、profileStore/journalStore 残留清算）。

- [ ] Step1 grep 复核：`createLlmRuntime|callStructured|callPromptJson|quirks|LlmProfile` 生产引用仅剩本组。
- [ ] Step2 删 → 绿 + tsc → `grep -rn "LlmRuntime" src/` 零命中。
- [ ] Step3 LLM_EXTRA_BODY 逃生舱：读 README/`.env` 注释与 makeModel 现实现，确认 v3 reasoning 路径与 injectExtraBody 解耦后，把"thinking-disabled 逃生舱"相关文档措辞清算（机制 injectExtraBody 保留——generic escape hatch 仍有用）。
- [ ] Step4 提交 `chore(retirement): wave 3 — delete forced-JSON LLM runtime stack (callStructured/runtime/probe/profile/quirks)`。

## Task 12：终验 + 文档收尾

- [ ] 全套 gates；`grep -rn "runPipeline\|series_season" src/ --include="*.ts" | grep -v test | grep -v db.ts | grep -v jobsRepo` 审视残留（db/jobsRepo 的 kind 字面量与墓碑分支预期保留）。
- [ ] README.md + docs/ 里旧管线描述扫改（README 的架构段若述及九 agent/pipeline 更新为 v3 叙事）。
- [ ] 真站冒烟（可选并入用户到家后的节奏）：部署 HEAD 短跑 daemon 无异常。
- [ ] 提交 `docs(retirement): post-campaign doc sweep`；更新记忆接续点（战役完成状态、下一战役=去 Jellyfin 化）。

---

## 自我审查（writing-plans 要求）
- **Spec 覆盖**：设计 W0-3/W0-1/W0-2/W0-4/W0-5→Task1-6；Wave2 组A-D→Task7-10；Wave3→Task11；终验→Task12。dashboard 冻结/realign 出生复跑/墓碑/DB 不迁移各有落点。
- **占位符**：无 TBD；每 Task 有精确坐标+断言+提交信息；新代码给骨架、逐行留给执行子代理按坐标读码补全（本仓 handoff 级计划惯例，执行者是能读码的 Claude）。
- **类型一致**：runs 注入用 `Pick<RunsRepo,'insert'>`（Task1）与 Task2 时间线消费一致；墓碑用 `jobs.retire`（若缺单 id 变体则 Task5 内补齐并测试）；KEEP 清单（episode.ts/schemas.ts/scanner.ts/stagingSandbox/fetchLib/subtitleWriter/subtitleInspect/seasonShape/llm.ts 保留符号）在 Task7-11 反复出现且一致。
- **范围**：单战役；去 Jellyfin 化/ffprobe/多语言/CHECK 收缩明确不在内。
