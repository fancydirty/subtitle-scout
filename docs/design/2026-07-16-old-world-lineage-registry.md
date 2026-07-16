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

### C 区（摄取/识别/整理/CLI）——主控已复核（C-B5 修正主控先前判断）

| # | 现场 | 发现 | 北极星 | 主控复核 | 建议裁决 |
|---|---|---|---|---|---|
| C-A1~A3 | findSubtitleWorkerTask:310 + libraryRepo 谓词 + jobsRepo dormant | 嫌疑#2 主裁决：语义判决被记账✓、时间判决被系统窃取✗；dormant=意图黑洞（与 A-F1/F3/F6 独立复现，双审吻合） | ①②⑥ | 成立（与 A 区交叉验证一致） | 并入 R-2/R-3 统一裁决 |
| C-A4 | libraryRepo.ts:390-412 resetRecheck | 退避窗唯一逃生舱零生产引用（播放触发已死）——退避无任何 agent/人为覆盖通道 | R3 | 成立（grep 亲验，A-F9 同报） | 处决；等价能力由活文档事实+orchestrator 判断替代 |
| C-A5 | ingest.ts:100-108 resolveStatusToWrite | missing 新事实被旧 unavailable 判决否决（护住退避窗口） | ④边缘 | 成立 | 有条件豁免：R-3 落地后它是诚实的状态记忆 |
| C-B1 | realignExecutor.ts:704-709 | 时长抽查死枝（getDurationSeconds 从未接线）+ expectedRuntime=24 动漫硬编码——若被好心激活会整剧误 park 45分钟剧 | ①近死 | 成立 | 登记为债：本战役不激活不删除（神圣文件最小改动），注释加"禁止带24硬编码激活"警示 |
| C-B2 | realignExecutor.ts:596-598 + port:126 | enableRealtimeMonitor 恒死分支（纯 Jellyfin 残肢） | 近死 | 成立 | 随 T9c 窄 diff 处决（含接口字段） |
| C-B3 | realignExecutor waitForJellyfinIdle | 互斥机制活着（D4 双向排他亲核成立），但命名/威胁模型主语是死掉的 Jellyfin；原威胁（外部媒体服务器共库扫描）失去观测手段 | 灵魂错位 | 成立 | 机制哲学豁免；改名/注释改造随 T9c；共库扫描风险书面登记入部署文档 |
| C-B4 | realignExecutor buildRealignMediaContext + core/schemas MediaContextSchema | 旧管线 MediaContext 类型当传声筒（恒空旧字段），生产消费仅剩此链 | R3 | 成立 | 改造：直接构造 FindSubtitleTask；MediaContextSchema 随之处决出 core |
| C-B5 | seasonShape + tools | **修正主控先前判断**：exceedsSeasonTable 并非全死——"Season NN 文件夹+裸数字文件"误刮形态下镜像仍可超表；真·平铺才被摄取规范化。布局事实列是补充信号不是替代 | 链路事实 | 成立（identifyFromPath 规则 3/4 亲核） | 债务D1 修订：diskLayoutNonstandard 与 exceedsSeasonTable 并列为两个事实信号，均不守门 |
| C-B6/B7 | realignExecutor:353,:600-601 | 验收文案"Jellyfin 报告 N 集"撒谎；provider_ids"从未被写入"断言已失实 | 表述/R3 | 成立 | 随 T9c 注释改造 |
| C-C1 | ingest.ts:167-190 rule 1b + ORIGIN_UNKNOWN | 标题启发式猜测→永久静默 ignored，零申诉通道（C 主张处决；A-F11 主张有条件豁免） | ①⑤⑥ | 成立 | **合議裁决**：本战役改造-lite（status_reason='ignored-by-heuristic' 落库可稽核）；曝光/申诉通道归 dashboard 战役救援页；永久性（ORIGIN_UNKNOWN 不回查）登记为债 |
| C-D1 | subtitleWriter pickFromZip + zimukuAdapter fileList:[] + download_candidate 返回值 | **zip 包内选择被机械层偷走**：zimuku 恰是季包大户，agent 不能选也不知道包里有什么，只能盲拿第一个文件——③被废掉一半；批量收割的直接障碍 | ②③ | 成立（zimuku fileList:[] 注释引已删 pipeline.ts 为据） | 改造并入阶段一（T5 扩展）：download_candidate 返回压缩包内清单事实+支持按名选取 |
| C-E1~E3 | adapters 层 | 无隐藏排序过滤（清白）；assrt slice(0,2)/zimuku 只用 queries[0] 未申报；陈旧引用两处 | ②边缘/R3 | 成立 | 截断申报（工具描述一句话）；注释随清洗波 |
| C-F1 | cli report.ts + core/ledger.ts | report 命令给死人记账：Ledger 零生产写入，汇报 journal/llmProfile/queue 全是已删世界 | R3 典型 | 成立（grep 亲验零 .append 生产调用） | 处决（cmdReport+report.ts+ledger.ts 连测试） |
| C-F2 | core/schemas.ts | 九个已处决 agent 的 schema 尸体零生产引用，靠测试供养 | R3 | 成立 | 处决（SearchPlan/RankDecision/RankedCandidate/VerifyDecision/FinalDecision/OrphanDecision/IdentityMatch/SeasonMap/LooseEpisodesMap/MediaContext + IDENTITY_MATCHES，连专属测试；SubtitleCandidate/candidateKey 等活体保留） |
| C-F3 | core/episode.ts SeasonEpisode | PlayerAdapter 已死，接口零引用 | R3 | 成立 | 处决；matchesEpisodeCode 活体保留、注释改造 |
| C-F4 | 全仓 17 文件陈旧血统注释 | scanner/providerPort/pipeline/rankCandidates/diagnoseSeason/triggers 幽灵坐标 | R3 | 成立 | 批量注释清洗波（T12b，sonnet 机械执行，零行为改动） |

C 区无发现区域：recognition 四文件（全仓最贴近北极星⑤的子系统）、daemon 两文件、doctor/subtitle-fetch/buildAdapters/targetLanguages、mediaContext/fileLogger、streamProbe/subtitleInspect/stagingSandbox 等安全机械层。

## 四、裁决记录（Task 0.3 · 主控终审，2026-07-16）

三审合流后的统一裁决。**总方针（采纳审计官A总意见）：旧灵魂是一条贯穿暗线，F1/F2/F3/F6 与事故本体同刀，否则事故换符号名重演。**

| 裁决号 | 内容 | 落点 |
|---|---|---|
| R-1 | **批量胶水层**（事故本体 F4/B4-worker侧）：处决 representativeEpisodeId/representativeMovieId/claim时目标重推导概念；任务形状=季级事实清单 | 阶段一 T1-T7（原计划） |
| R-2 | **dispatch 事实回执**（F1/F2/B2/B3/B11）：upsertWorkerTask 返回 created/revived/coalesced/blocked_dormant 事实；dispatch 工具如实转告且 coalesced/blocked 不耗 cap；wake/boostPriority 处决；sibling 的 remainingWorkSummary 注入 prompt | 阶段一新任务 T8b/T8d |
| R-3 | **退避梯下沉事实层**（F3/F6/C-A1~A5/F5 部分）：内容退避从 jobs 状态机整体迁到 item 事实列（episodes/movies 新列 search_attempts，v10）；recheck=CONTENT_BACKOFF_DAYS 阶梯、第5次起 30d——仍是事实、永不隐形；worker_task 永不再 dormant；completeNoMatch 处决；retry_later→completeError 保留为节流豁免；活文档呈现停牌事实（unavailable 数/nextRecheckAt/原因样本/剧名） | 阶段一 T8（语义重写）/T8c、阶段二 T10（v10 扩容） |
| R-4 | **工具面事实诚实化**（B6/B7/B9/B10/B12/C-E2）：check_series_layout 报 tmdbUnavailable、描述去 diagnoseSeason 幽灵；search_source 报 providerFailures+申报默认语言过滤；缺口行带剧名；provider 查询截断申报 | 阶段一新任务 T8c |
| R-5 | **zip 清单事实**（C-D1）：download_candidate 返回压缩包内字幕清单，支持按名/序选取，pickFromZip 升级——季包批量收割的直接前提 | 阶段一 T5 扩展 |
| R-6 | **清算波**（F7/F8/F9/F10/F15/B8/B13/C-A4/C-F1/C-F2/C-F3）：legacyJobRouting+executor.ts 整体处决；jobsRepo/libraryRepo 死器官群处决（含 completeNoMatch/completePartial/quota管道/wake/boost/find/findMovie/listByState/setJournalRef/retire/resetRecheck/hasSubtitleRecord/setMovieChineseTitle/knownPaths+selfScan死链）；retireAllForSeries 改指 worker_task；realignPlaybook+deep字段+report/ledger+schemas尸体+SeasonEpisode 处决；apiV2 合成 id 改用常量 | 阶段一新任务 T9a（收绿前执行） |
| R-7 | **realign 窄 diff**（C-B2/B3/B4/B6/B7 + A-F13）：批量 FindSubtitleTask 适配、MediaContext 传声筒处决、TMDB 富化补面、恒死监视分支处决、命名/注释主语纠正；**五重安全层字节不动，主控逐 hunk 亲验**（P5 纪律）；C-B1 时长死枝不激活不删除仅加警示注释 | 阶段一新任务 T9c |
| R-8 | **债务D1 修订**（C-B5）：exceedsSeasonTable 保留（仍可点火），diskLayoutNonstandard 并列第二信号，skill 的 MUST/never 守门措辞改为事实+理由式教导（B5） | 阶段二 T11（修订） |
| R-9 | **血统注释清洗波**（C-F4/E3/B14/F9注释）：17 文件幽灵坐标批量改写，零行为改动 | 阶段三前 T12b（sonnet） |
| R-10 | **豁免与登记**：瞬时错误轨（30s→15min→日）=故障自愈机械豁免；claimNext FIFO=事实豁免；rule 1b=改造-lite+债登记；ingest resolveStatusToWrite=R-3 后诚实豁免；realign 五重安全层+16MB fail-closed+沙盒检查=既有定论豁免；C-B1 时长死枝/quota 呈报通道/多语言单值截断/ORIGIN_UNKNOWN 不回查/外部媒体服务器共库扫描风险=登记立项 | 本册+spec |
| R-11 | **用户已裁决（2026-07-16）**（B15）：派活范围既不恒为季也不恒为剧——**主代理按刮削出的磁盘实际情况具体裁量**（"进击的巨人有三季资源分别缺字幕→一个任务带全剧缺口清单告诉子代理找什么资源哪些季各缺多少集及路径；只有 S3 资源→任务自然就是 S3"）。落地：taskType 进 jobs 身份元组（v11 索引重建，消灭 find/realign 同 identity 碰撞——原 null-season 拒绝守卫随之处决）；dispatch_find_subtitle_task 输入改 seriesId+可选 seasons 数组（null=全部有缺口的季）；mapper 加全剧清单推导；orchestrator skill 教范围裁量（主控亲改）。并入本战役阶段一（T4b/T8b 扩容） | 阶段一 T4b（新）/T8b（扩）/T7/T11 skill |

裁决完毕。计划修订随本次提交（docs/superpowers/plans/2026-07-16-glue-layer-repair-campaign.md，本地文档不入库）。

## 五、R1 架构灵魂验收对照表（Task 13 · 主控亲笔，2026-07-16 收官）

对照面=本战役全部改动（a1a2cac..HEAD，含清算波）。逐条质询：

| 北极星条款 | 改动面质询 | 判定 |
|---|---|---|
| ①agent 像人判断，确定性检查绝不守门（事实盘点除外） | completeNoMatch 的第 5 次机械 dormant 判决已处决；退避降为 item 事实阶梯（永不隐形）；check_series_layout 双信号+tmdbUnavailable 均为事实；orchestratorSkill 的 MUST/never 守门措辞处决，改事实+理由式；活文档谓词守门人处决（throttled 可见）。**主动质询甲：三桶队列映射是否重新引入确定性守门？**——否：completeDone/completeError 只登记 worker 已作出的判断类别（报告入账 vs 瞬时重试），不产生任何"值不值得做"的判决；内容判决全部在 worker（no_safe_match per item）与 orchestrator（差额再派）手里。**主动质询乙：itemId 幻觉防线是否越权？**——属事实盘点豁免：它是入账层的账实核对（报告条目 ∈ 任务清单），等价于会计拒绝为不存在的科目记账，不评判任何字幕对错；且方向是漏记不错标（⑥同向） | 符合 |
| ②主代理意图原样抵达执行者 | representativeEpisodeId/representativeMovieId 处决（mapper 纯信使）；dormant 吞噬+谎报处决（四态回执）；sibling remainingWorkSummary 注入 prompt（明示 context-not-command）；retireAllForSeries 归位 worker_task；R-11 范围裁量进 payload.seasons 原样抵达 | 符合 |
| ③子代理粒度=季/批，合集是最高效命中 | 任务形状=范围事实清单（单季/多季/全剧由主代理裁量）；worker skill 教批量收割+跨季认知+"最高效命中"原文；zip 包内清单归 agent（zimuku 季包不再盲拿首文件）；超时按目标数缩放 | 符合 |
| ④机械层只产事实永不产指令 | 缺口清单 ORDER BY 注明"清单排序非执行指令"；活文档 missing/throttled/nextRecheckAt/sampleReason/seriesName 全事实化；providerFailures/archiveEntries/tmdbUnavailable/四态回执均为事实呈报；recheck_after 不再从 jobs 调度态倒灌（item 自算自持）。残留豁免：claimNext FIFO（到达序=事实，R-10）；worker timeout/stepCap/cap=资源自卫机械 | 符合 |
| ⑤拿不准就停车，错认比停车糟 | skill 逐集"跳过该集不弃整包"教导；rule 1b 启发式判决已可稽核（status_reason 落库，T12b）+曝光债登记 dashboard 战役；recognize/ingest park 纪律未动（审计 C 区认证的模范子系统）；dormant"停车即死刑"悖论消解（blocked_dormant 事实回执 + find 任务永不 dormant） | 符合 |
| ⑥零误触发 | realign 五重安全层字节未动（T9c 逐 hunk 亲验声明在案）；exceedsSeasonTable 保留（仍可点火的形态存在，C-B5）+diskLayoutNonstandard 并列，判断归 orchestrator，灾难防线在 executeRealign；itemId 幻觉防线为⑥在入账层的镜像；realign 富化补面降低字幕先行误认边际（A-F13） | 符合 |
| skill 修订权只在人+主控 | 本战役两次 skill 重写（findSubtitleSkill/orchestratorSkill）均主控亲笔（bd2c675/a1b720f），实现子代理 prompt 中明令禁区，无违例 | 符合 |

**"待核/TODO/暂时"零存活检查**：grep 零命中（两处"暂时"为正常语句非搁置标签）。
**跨战役登记（非搁置，已裁决立项/记录在案）**：quota 呈报通道（R-6 发现，立项）；ORIGIN_UNKNOWN 不回查（C-C1 债）；C-B1 时长死枝（警示注释在案）；多语言单值截断（A4 已申报）；外部媒体服务器共库扫描窗口风险（C-B3，部署文档责任）；retireClaimed 孤儿化+MediaIdentitySchema 零外引（T9a 新发现，下轮清算候选）；B-15 剧级合集终态（R-11 已裁"按事实裁量"，形已留）。

## 六、R2 复审双签记录（Task 14）

**第一轮复审（2026-07-16）：FAIL。** 审计官全项目复审推翻了 R1 对照表①行的"符合"判定：

- **F-R2-1（阻断）**：orchestratorAgent.ts:97-99 的 system prompt 仍留 "you MUST … only proceed
  if exceedsSeasonTable is true — never dispatch" 守门原文——B5 定罪现场是两处（skill+agent
  instructions），a1b720f 只处决了 skill 那半。每轮必达的权威信道与主控亲笔 skill 直接冲突，
  且在指令层判死 D1 第二信号。**主控认领：这是主控本人的漏改**——正是反省书"活着但灵魂是
  旧的"的定义，R2 纪律因此存在。已亲手处决（92bb23f），守门措辞全仓 grep 仅存死刑记录注释。
- **收官前修五项**（修复中，完成后追记）：F-R2-2 spawn_sibling 盲报成功；F-R2-3 orchestrator
  最终汇报黑洞（blocked_dormant"上报人类"无落地通道，与 R10 叠加=操作员零知情）；F-R2-4
  skill 教的"停牌提前重派"权力管道不存在（新违例：主控亲笔教导了不存在的能力）；F-R2-5
  coalesced 谎报 identical+新意图丢弃；F-R2-6 ingest 覆盖路径绕过阶梯归零。
- **登记十条**（移交下轮清算/立项）：park() 注释残留 wake 谎言；completeNoMatch 幽灵指针；
  db.ts v9 注释教旧灵魂（attempt/dormant/priority=100）；跨桶重复 itemId 无守卫（⑥边际，
  ingest 自愈兜底）；realign 崩溃恢复 detail 的 Jellyfin 主语残留；B11 决策数 DB-authoritative
  改判显式立项；seasons:[] 静默归一未申报；fetchLib 两处未墓碑幽灵；deleteSeriesRows 注释
  Jellyfin 叙事；**R10 结构性**：realign park 后无带内复活通道（wake 已删+upsert 拒绝+
  retireAllForSeries 循环依赖），F-R2-3 修复补上知情权后，复活通道归 dashboard 救援页战役。
- 审计官同时**确认**：五重安全层零改动宣称属实（git diff 亲验）；两项主动质询判定同意；
  清算波无删漏删错；v11 身份无错位；R-5/B9/B10/C-E2/F9/F10/F15 足额交付。

（第二轮复审与真站闸门报告随修复完成追加。）

## 四、裁决记录（Task 0.3 填写）

（待）
