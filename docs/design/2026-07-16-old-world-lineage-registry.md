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

### B 区（agent 工具面与技能）——15 条，主控已逐条复核，全部成立

| # | 现场 | 发现 | 北极星 | 主控复核 | 建议裁决 |
|---|---|---|---|---|---|
| B1 | orchestratorAgent.tools.ts:33-38 + libraryRepo.ts:305,317 | list_missing_coverage 自称"factual bookkeeping only"，但数据源谓词把退避窗口内的缺口整行隐藏——"放弃30天"由系统敲计算器决定，主代理不知情 | ④②⑤ | 成立（谓词亲读） | 改造：unavailable/recheck_after/status_reason 作为列呈现，重试判断上交 agent |
| B2 | orchestratorAgent.ts:64-82 + jobsRepo.ts:146-165 | 主代理对已派未完成任务零可见；upsert 静默合并与新建折叠成同一个 dispatched:true 回执——差额事实不存在于 agent 世界 | ②④⑥ | 成立（两处亲读） | 改造：dispatch 返回 created/coalesced 事实 + pending 任务事实源 |
| B3 | tools.ts:198-215 + reconcileAll.ts:66-82 | spawn_sibling 的 remainingWorkSummary 写入 payload 后从未被读——sibling 拿固定 prompt，父代理意图黑洞；与 representativeEpisodeId 同构。连带：sibling 重复 dispatch 静默 no-op 却消耗 cap，结构性连锁空转 | ② | 成立（runOrchestrateWorkerTask 亲读，不读 payload） | 改造：summary 注入 sibling prompt（或诚实处决该参数）+ 修 cap/no-op 交互 |
| B4 | findSubtitleWorker.schemas/worker/skill | worker 侧胶水层整体单集世界观（事故另一半的接口容器）；除此三处无第四个暗桩 | ③② | 成立 | 已立项（本战役阶段一） |
| B5 | orchestratorSkill.ts:26-38 + orchestratorAgent.ts:88-90 | "MUST call check_series_layout…only proceed if true…never dispatch"——确定性布尔当派活守门人，且该信号 own-ingest 世界近死→realign 结构性永派不出 | ① | 成立（skill 原文亲读；措辞系主控上战役亲写，记 R1） | 改造（并入债务D1：换布局事实列，MUST/never 改为事实+理由式教导） |
| B6 | tools.ts:96-103 | 查询失败折叠成 exceedsSeasonTable:false——报结论不报事实；false 偏置方向符合⑥但事实层应报"TMDB 不可达" | ④ | 成立（写计划时已亲读） | 改造（轻）：返回 tmdbUnavailable 字段 |
| B7 | tools.ts:90,:66-68 | 工具描述向活模型引用已删除的 diagnoseSeason.ts——幻觉参照系 | R3 | 成立（ls 确认文件不存在） | 改造：随 B5/B6 重写 |
| B8 | agent/playbooks/realignPlaybook.ts | 生产零引用的旧世界手册尸体，靠自测试全绿续命；内容通体旧魂（Jellyfin 刮削/旧退避梯/旧 identify/旧 journal） | R3 | 成立（grep 零命中） | 处决（连同其测试） |
| B9 | resultHandles.ts:149 + fetchLib.ts:62-87 | search_source emit 传空函数吞掉 provider 局部失败——agent 被要求做 retry_later/no_safe_match 判断却没有事实输入 | ④①⑤ | 成立（亲读） | 改造：返回 providerFailures 列表 |
| B10 | resultHandles.ts:145-148 | languages 省略时静默注入 targetLanguage 过滤，描述未申报 | ④轻 | 成立 | 改造（描述一句话申报） |
| B11 | orchestratorAgent.ts:14-18 | OrchestratorDecision 模型自报数非 DB 复核数（自供已知债） | ④轻 | 成立 | 登记，随 B2 顺手转 DB-authoritative |
| B12 | tools.ts:10-12 | 季级缺口行无剧名，orchestrator 对"哪部剧"零感知 | ②轻 | 成立 | 改造（顺手）：行内带 series name |
| B13 | fetchLib.ts:11 | FetchArgs.deep 全仓 adapters 零消费死字段 | R3 | 成立（grep 确认） | 处决 |
| B14 | agent/llm.ts:10-13 | extraBody 注释以已退役旧栈之病为例，机制本身健康 | 陈旧提及 | 成立 | 哲学豁免，顺手改注释 |
| B15 | orchestratorSkill.ts:42-43 | "one call per row" 与③"一个工作流配齐三季"张力：同剧多缺失季拆成多个独立 worker，跨季合集协同被丢弃 | ③张力 | 成立（哲学问题） | 上报用户/主控裁决（季=下限还是终态） |

B 区无发现区域（已质询确认干净）：coerce.ts、reasoningAgent.ts、solveNumericCaptcha.ts、absoluteEpisodes.ts、languages.ts、skills/registry.ts、findSubtitleWorker.tools.ts（沙盒检查属事实盘点豁免）、findSubtitleSkill 教导内容（除单集世界观）、llm.ts 机制层。

### A 区（v2 队列与执行缝）——15 条，主控已逐条复核（F4 加重情节之一有异议，其余成立）

| # | 现场 | 发现 | 北极星 | 主控复核 | 建议裁决 |
|---|---|---|---|---|---|
| F1 | jobsRepo.ts:146-165 + tools.ts:166-172 | **dormant/failed 行静默吞噬主代理新派发且谎报 dispatched:true**——5次no_safe_match→dormant→缺口重现→每轮派发每轮被吞→永久活锁。比事故本体更深的暗桩 | ②⑥ | 成立（两处代码写计划时已亲读，活锁链推演成立） | 改造（最高优先级）：upsert 返回 created/revived/coalesced/blocked_dormant 事实，dispatch 工具如实转告 |
| F2 | jobsRepo.ts:505-536,:389-404 | "dormant 不是死刑是停车"是谎言——wake/boostPriority 零生产调用，park 注释承诺的唤醒通道全是断头路 | ⑤② | 成立（grep 亲验零调用） | wake/boostPriority 处决；真 wake 通道=F1 的事实可见+复活语义 |
| F3 | jobsRepo.ts:294-322 + libraryRepo.ts:298-320 | "放弃"由系统判决（第5次机械升 dormant），agent 双侧均失明；dormant/unavailable/attempt 连作为事实都不可见（spec 嫌疑 #3 裁决实体） | ①②④ | 成立（亲读） | 改造：判决降格为事实列入活文档；瞬时错误轨（30s→15min）哲学豁免（故障自愈机械） |
| F4 | findSubtitleWorkerTask.ts:100-151,277-284 | 事故本体在役+两条加重：不仅降解粒度还选择目标与顺序；全季被 recheck 遮蔽时 !mapped→completeDone 单方面收工 | ②③① | 本体成立；**加重情节二主控有异议**：!mapped→completeDone 是幂等 no-op+done→wanted 可复活，与 spec"报告已入账"队列语义一致，裁定保留 | 本体处决（阶段一 Task 4，含 representativeMovieId 与 claim 时目标重推导概念整体消失） |
| F5 | findSubtitleWorkerTask.ts:302-304 | agent 的 retry_later 判断蹭瞬时错误退避梯（共用 error_attempt，20次后降为日试） | ①② | 成立（亲读） | 部分豁免：completeError 轨保留为节流事实（永不 dormant，封顶日试可辩）；"agent 表达何时再试"登记为后续演化，R4 观察 |
| F6 | findSubtitleWorkerTask.ts:306-313 | jobs 调度态倒灌事实层：recheck_after 抄自 job 退避梯，停牌期条目对 orchestrator 隐形（spec 嫌疑 #2 裁决实体）。unavailable+recheck_after 概念本身哲学兼容，当前实现不兼容 | ④① | 成立（亲读） | 改造：recheck 阶梯移到 item 事实层（见裁决 R-3），停牌条目以事实形态可见（随 B1） |
| F7 | cli/legacyJobRouting.ts + v2/executor.ts 全文件 | legacy 通路服务不可能非空的集合：upsertWanted 零调用+v9 空库直落终态→旧 kind 无出生点无存量；连带 hasActiveRealignWorkerTask 的 D4 互斥漏洞 | R3② | 成立（grep+db.ts:1-15 亲读） | 处决：两文件+cli 接线整体删除，daemon 收敛 worker_task 单通路；删后互斥窄查询自动成立 |
| F8 | jobsRepo.ts 死器官群 | upsertWanted/completePartial+PARTIAL_RETRY_MS/quotaRetryAt+QUOTA_RESET_MARGIN_MS+quotaResetAt 形参/boostPriority/wake/find/findMovie/listByState/setJournalRef/target_episodes 列——零生产调用；**quota resetAt 精确排期能力在换代中被静默丢失** | R3④ | 成立（grep 逐一亲验） | 死器官处决；quota 呈报通道改造**立项**（批量 finalize 落地后补 resetAt 呈报路径） |
| F9 | libraryRepo.ts 死器官 + apiV2 陈旧 id | resetRecheck/hasSubtitleRecord/setMovieChineseTitle/knownPaths（+makeSelfScanPass 链）零生产调用；deleteSeriesRows/markCovered 注释引用已死世界；apiV2.ts:153 过滤合成 id 仍写 'self-scan-trigger'（现实为 'ingest-trigger'） | R3 | 成立（grep 亲验；apiV2 陈旧 id 亲验） | 死器官处决；注释改造；apiV2 改用 INGEST_ORCHESTRATE_SERIES_ID 常量 |
| F10 | jobsRepo.ts:461-469 | retireAllForSeries 只作废已无出生点的 series_season kind；真正携带旧判决的 worker_task dormant/failed 行 realign 后原样存活卡死新结构（representativeEpisodeId 同款病理） | ②R3 | 成立（亲读） | 改造：退休范围改为该 series 的 worker_task 行 |
| F11 | ingest.ts:167-206 rule 1b | TMDB origin 缺席时汉字正则启发式直接判 'ignored' 且不落 status_reason——正则猜测代替停车，无从稽核；误判方向保守（漏配不误配） | ⑤④边缘 | 成立（引文与 T3 设计记录一致） | 有条件豁免+改造-lite：写入 status_reason 使判决可稽核 |
| F12 | jobsRepo.ts:167-183 claimNext | ORDER BY priority DESC, created_at ASC——生产中 priority 恒0，实际 FIFO=orchestrator 派发序原样保序 | 无违反 | 成立 | 哲学豁免（到达序是事实）；priority 盲肠随 F8 登记 |
| F13 | realignExecutor.ts:186-211,257-282 | realign 字幕先行任务硬编码空富化（no TMDB 佐证）——文件刚被重编号最需佐证的场景拿最少证据 | ⑥边际 | 成立 | 改造-lite：复用 fetchTmdbEnrichment 补面（五重安全层依既有定论豁免，零改动） |
| F14 | findSubtitleWorkerTask.ts:44-50 | 多语言配置机械截断为首项（A4 已申报债务） | ②边缘 | 成立 | 豁免（已申报），登记防跨战役失忆 |
| F15 | cli/index.ts:295-345 | tmdb 硬前置后不可达的降级分支；若真触发，park 出的 dormant 行按 F1/F2 永不复活（含 'ingest-trigger' 编排行→全系统停摆） | 登记 | 成立 | 随 F7 顺手清理 |

A 区无发现区域（已质询确认干净）：daemon.ts（故障机械+事实记账）、reconcileAll.ts（干净信使）、realignWorkerTask.ts（薄桥 1:1）、ownIds/runsRepo/db.ts（纯事实层）、realignLibraryPort.ts（换代工艺正面样板）、libraryRepo P2 面、ingest.ts 除 rule 1b 外（park 纪律模范）。

**A 区总裁决意见（主控采纳）**：representativeEpisodeId 只是同一具旧灵魂最显眼的一根手指。完整暗线：mapper 选目标（F4）→退避梯定放弃（F3/F6）→dormant 吞新意图谎报成功（F1）→上诉通道断头（F2）→realign 判决作废错位（F10）。**若 F1/F2/F3/F6 不与 F4 同刀处理，批量任务修好后第一个吃满 5 次 no_safe_match 的季照样掉进永久失明区，事故换符号名重演。**全部并入本战役。

### C 区（摄取/识别/整理/CLI）——待回收

## 四、裁决记录（Task 0.3 填写）

（待）
