# 旧 pipeline 退役战役 · Wave 0-3 设计（2026-07-15）

状态：brainstorming 完成，用户批准（"哦了"），方向盘全权委托主控 Claude。
输入：辐射分析 `2026-07-15-old-pipeline-radiation-analysis.md`（e837bbc，HEAD=baacca2 时校验）。
范围：一次战役打穿 Wave 0（切活承重边）→ Wave 2（旧管线簇删除）→ Wave 3（LLM 旧栈清算）。
Wave 1（dashboard/api.ts 孤儿）已完成（baacca2）。

## 背景

A/C/B 三子系统已全线真站验证（见 project-v3-agentic-rebirth 记忆 2026-07-15 块）：v3 拥有
自研巡检触发+识别+orchestrator 智能闸门+worker。旧管线（scan→aggregate→executeJob→runPipeline
+ 九单发 agent + LlmRuntime 栈）在判断力上全面被替代，但辐射分析证明它仍有三条活承重边，
必须先切边（Wave 0）再删文件（Wave 2/3），否则 realign 断出生/断复跑、dashboard 静默冻结。

用户产品级拍板（2026-07-15）：该删就删；另注意用户根本不用 Jellyfin 播放（本战役不处理
去 Jellyfin 化，那是下一战役，但删除时不给 Jellyfin 依赖加新根）。

## Wave 0 · 切边（顺序固定：W0-3 → W0-1 → W0-2 → W0-4 → W0-5）

### W0-3 dashboard 活动源兼容 worker_task（先行，防切 feed 后徽章/时间线冻结窗口）
- `src/dashboard/apiV2.ts`：
  - `buildLibrary` series 活动（:147-157）：activity join 从 `kind='series_season'` 扩为
    「`series_season` OR（`worker_task` AND `json_extract(payload,'$.taskType') IN
    ('find_subtitle','realign') AND series_id=目标`）」。过渡期兼容双源，Wave 2 后旧 kind 行
    自然绝迹但查询无需再改。
  - movie 活动（:181-190）：同理扩 `worker_task` + `movie_id`。实现前先核 dispatch 工具是否
    给 movie 任务写 movie_id 列（radiation 分析未核到这层；若 payload 里才有，用 json_extract）。
  - runs 时间线（:292-299）：JOIN 条件同样扩双 kind。
- v3 runner 写 runs 行（现状：v3 全家不写 runs，时间线是旧管线独占）：
  - `src/v2/findSubtitleWorkerTask.ts`：完成时（done/no_safe_match/retry_later/error）写一行
    runs（decision=worker decision，detail=reason 人话摘要，journal_path 可空，llm_calls 可空）。
  - `src/v2/realignWorkerTask.ts`：同理（decision='realign'/结果，detail=摘要）。
  - orchestrate 任务不写 runs（它是编排不是内容产出，dashboard 不展示它）。
- 前端 web/ 零改动（DTO 形状不变）。

### W0-1 realign 出生权移交 orchestrator
- 删 `src/v2/executor.ts:345-357`（no_safe_match×2 → diagnoseSeason → upsertWanted(realign)
  触发器）与 `makeDiagnoseSeason`（:530-568）及其在 cli/index.ts 的接线（executor 文件本体
  Wave 2 才删，这里只切边）。
- 等价性论证（写进提交信息/注释）：orchestrator 的 check_series_layout 用同源确定性信号
  `mirrorExceedsSeasonTable`（orchestratorAgent.tools.ts:88 注释自证"same primary signal
  diagnoseSeason.ts already uses"）+模型判断；触发面从"同季两次 find 失败后"变为"每次
  orchestrate pass 检查 backlog 每剧"——更早更宽；零误触发已 B 层 12/12+真站验证。
  放弃的唯一东西："find 失败"这个间接证据线索，判断净收益为正（用户已委托）。
- 相应 executor 测试删/改；orchestrator 侧不动（已有覆盖）。

### W0-2 realign 复跑走 v3 链（零新生产代码，一个新测试）
- 保留 `retireAllForSeries`（realignExecutor.ts:803,:865）——清旧 job 语义仍需要。
- 复跑机制=既有链：重排改名 → scan() 镜像（scanner.ts KEEP）→ selfScanTrigger Signal B
  （knownPaths 增长）→ orchestrate pass → list_missing_coverage → 正常派活。B3 真站验证的
  同构场景（新增路径→触发）。
- 新增一个集成测试锁场景：模拟"重排完成"（库行路径批量换新+旧 worker_task 已退）→ 断言
  下一 selfScanTrigger pass Signal B 触发 orchestrate 入队。
- 边界（注释写明）：realign 进行中残留的 find worker_task 因旧路径消失会 sandbox 抛错→失败
  退避→下轮 orchestrate 按新路径重派；orchestrator realign-first 排序已把窗口压最小。

### W0-4 切 feed
- `src/cli/index.ts`：daemonDeps 摘除 `aggregate` 接线；`executeJob` 分支删旧 kind 路由
  （series_season/movie → executeJob 老内部），只留 worker_task 路由 + realign（若 realign
  kind 仍走老 executeRealignBranch——核实：realign kind 的执行在 executor.ts executeRealignBranch，
  它不在删除清单（含 5 重安全层的 realignExecutor 调用链），保留）。
- 删 `cmdRun`/`cmdRunItem`（runPipeline 手动入口）及其 CLI 注册；`assemble()`/`makeDeps` 中
  仅服务旧管线的构造（identify/plan/rank/verify/adoption/seasonPack 闭包）标记为 W2 删除点，
  本步先移除调用以保编译。
- `src/v2/daemon.ts`：reconcile 分支保留 scan()（镜像必须活着），aggregate 调用移除；
  daemon 测试相应调整。
- **DB 不迁移**：jobs.kind CHECK 枚举保留死值（第 4 次全表重建不值得，手写 SQL 多处读 kind）。

### W0-5 真站短验（Wave 2 大删前的闸门）
- 部署 HEAD 到软路由 scout-test，短跑 daemon（快节拍），断言：①旧 kind job 不再新建
  ②v3 链照常（自扫/触发/派活）③dashboard API 两个端点返回 worker_task 派生的活动/时间线
  ④realign 出生：造一个乱排测试剧目录，断言 orchestrate pass 派 realign（出生权移交实证）。
- 打法沿用 B3：一次性测试 Jellyfin 容器（SETUP-NOTES 在 /mnt/nvme0n1-4/scout-test-jellyfin
  已拆，照 B3 流程重建）、隔离测试目录、detached+监视器、辐射锁死测试区。

## Wave 2 · 旧管线簇删除（W0-5 PASS 后；互引簇分组删，每组一提交一 gates）

按辐射分析清单（坐标以其为准，删前逐个 grep 复核零活引用）：
- 组A：`v2/aggregator.ts`(+test)；executor.ts 的 series_season/movie 分支+makeRunEpisode+
  makeDiagnoseSeason 残体(+executor.test.ts 相应切片；executeRealignBranch 与 realign 安全链保留)。
- 组B：`core/pipeline.ts`(+2704 行 test，预算真实时间)、`core/gate.ts`、`core/orphanGate.ts`、
  `core/seasonPackGate.ts`、`core/cache.ts`、`core/journal.ts`(+各 test)。
- 组C：九单发 agent：identifyMedia/planSearch/rankCandidates/verifySubtitle/judgeOrphan/
  mapSeasonPack/mapLooseEpisodes/harvestAlias/diagnoseSeason(+各 test)；`files/orphanScanner.ts`(+test)。
- 组D：cli/index.ts 的 makeDeps/Assembled 旧管线管件收尾。
- 每组删后：`npx tsc --noEmit` + `npx vitest run` 绿 + grep 死引用清零。

## Wave 3 · LLM 旧栈清算（Wave 2 后）

- `agent/llm.ts`：删 callStructured/callPromptJson/StructuredOutputError/ToolChoiceRejectionError/
  isToolChoiceRejection/extractJson；**保留** makeModel/LlmConfig/LLM_TIMEOUT_MS/injectExtraBody/
  isConnectError/withConnectRetry（v3+captcha 在用）。
- 删 `agent/runtime.ts`、`agent/probe.ts`、`agent/profile.ts`、`agent/quirks.ts`(+各 test)。
- cli/index.ts assemble()：profileStore/journalStore/LlmRuntime 构造残留清算；
  LLM_EXTRA_BODY thinking-disabled 逃生舱按 scope 文档步骤 8 清算（核实 v3 reasoning 路径
  不受影响后删）。
- 终验：全套 gates + README/文档中旧管线描述扫一遍改掉 + 真站冒烟（可并入回家后节奏）。

## 测试策略
- 每步 TDD 或删除步"grep 零引用+gates 绿"纪律；W0-2 新集成测试；W0-5 真站闸门。
- 铁律不变：realign 5 重安全层零触碰（executeRealignBranch/realignExecutor 保留链除切边点外
  一行不动，复核 diff）；skill 只主控改（本战役不涉 skill）；sonnet 子代理实现+主控复核。

## YAGNI / 明确不做
- 不做 jobs.kind CHECK 收缩迁移；不做去 Jellyfin 化（下一战役）；不做 inotify；
  不动 scanner.ts 镜像机制；不动 web/ 前端。
