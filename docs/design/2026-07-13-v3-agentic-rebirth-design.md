# v3:Agent 化重生 — 主子代理树 + 数据库状态机 + 沙盒 + 活文档 skill

日期:2026-07-13。状态:设计中(brainstorming,用户已给足决策授权一次成型)。
前置:代码审计(现架构=固定 TS 流+10 个强制吐 JSON 单发 LLM 调用,还主动关 thinking)、
两路调研(agentic 最佳实践 / 活文档 skill / 框架存在性)、真实安装版本核实(ai@7.0.15,ToolLoopAgent/Output/reasoning 全在)。

## 北极星(铁律,不可违背)

1. **agent 像人一样判断,不敲计算器**。目标资源该配哪个字幕,靠 agent 智能判断归属(看元数据/上下文,像人找字幕那样),**不读对白内容**(开膛破肚验 DNA=过度工程),**不算置信度分数**。
2. **确定性检查(集号 token 匹配/评分/阈值卡准入)= Bazarr 那套失败方案。这个项目就是要取代 Bazarr,绝不让确定性检查当"字幕对不对"的守门人。** 确定性只用于**纯事实盘点**(有没有同名字幕文件、轨道有没有内嵌、语言是不是中文、目录对没对齐 TMDB),不用于判断字幕归属。
3. **病灶精确定位**:现架构的错不在"没读内容",在**不让模型思考**——`llm.ts` 用 `toolChoice:{type:'tool'}` 强制第一 token 吐 JSON,`quirks.ts` 为了让强制生效**主动关 thinking**,用着推理模型却当贴标签机;schema 全"答案优先"(布尔在前=先定罪后找证据)。
   **修法=开 thinking + reason-then-answer(结构化输出只在末尾)+ 元数据判断归属**,不是加读内容能力。

## 框架选型(已用真实安装版本裁定,零新依赖)

- **用已装好的 `ai@7.0.15`**:`ToolLoopAgent`(agent 循环:调模型→跑工具→循环到 stopWhen)、`Output.object()`(结构化输出只在循环末尾,不在 token 0 强制)、`reasoning` 选项(开推理,治关思考的病)。
- **不引 Vercel eve**:eve(2026-06 发布,理念完美契合——"agent 是目录"、子代理上下文隔离自带 tools/sandbox、durable checkpoint 续跑)是**理念的镜子**,但 4 周大 beta,durability 依赖 Vercel Workflows 或自托管 Postgres。我们是 SQLite NAS,上 eve = 用重框架+拖 Postgres 换掉一个已实战验证的 SQLite 状态机。**抄 eve 的架构,不抄它的代码,长在现有 SQLite 状态机上。**
- **不引** Temporal(要集群)/Inngest(要编排服务器)/LangGraph(Python 优先且 checkpoint 是弱 durability)。DBOS(TS+SQLite 的 durable-execution 库)列为"若手写 per-step checkpoint 变复杂再评估"的候选,当前不引。

## 架构骨架:主-子代理树

**触发**:dashboard「全仓校验」(或定时/watcher)→ 机械预清洗 → 主代理编排 → 子代理消费。

**① 机械预清洗(纯代码,纯事实,非 Bazarr 判断)**:扫 Jellyfin 全库,每个资源判定:有同名字幕/有内嵌轨/国产免配/确实缺;目录集数排布对没对齐 TMDB。结果写入 DB,成为**活文档**(可查询的表,不塞进任何 agent 上下文)。

**② 主代理(orchestrator,只编排不干活)**:初始上下文只植入两样——"怎么查活文档" + "怎么据此派活"(以 skill 形式)。行为:查活文档看谁缺字幕/谁目录乱 → 用脑子想编排顺序(例:间谍过家家目录乱,先派整理任务,理好再派找字幕任务,有依赖顺序)→ 把任务**写进 DB 的 pending 队列并标记已派**(幂等/exactly-once,防崩溃重启重复派)。
- **100 任务/主代理硬上限**(写死,防上下文长度爆):超过则在 DB 开 sibling orchestrator 分片续派,树状 fan-out。这个数是硬约束,不等观测(与"测试期步数不设限"是两回事——后者是怕浪费时间,前者是物理上下文上限)。

**③ 两类子代理(无状态 worker,从 DB 认领任务,不知主代理存在)**:
- **整理子代理**:认领"整理 X 目录"→沙盒只见 X 目录→按 TMDB 重排(复用 realign 能力)。
- **找字幕子代理**:认领"给 X 找字幕"→沙盒只见 X 目录→**ToolLoopAgent 开 reasoning,像人一样判断候选归属、能再搜、能对比、末尾 Output 结构化结论**→装字幕(复用 staging/gate/provider 能力,但把"强制吐 JSON 单发"换成推理循环)。

**④ 数据库即状态机**:主/子代理的状态**不在消息链,在 DB**(现有 jobs 表 lease/heartbeat/claim-next 就是这套骨架)。主崩子崩都能重启读 DB 从断点续。子代理认领=claim,完成=写结果。

**数据流一句话**:机械清洗填活文档 → 主代理读活文档写 pending 队列(标记已派)→ 子代理认领队列干活写结果 → 全程状态在 DB。

## 沙盒(harness 两头堵,2026 正统 defense-in-depth)

- **代码层**:子代理的工具实现把所有路径校验/解析到"当次任务那一个媒体根",越界即拒(复用 realign 已有的 containingRoot/isUnderRoots)。
- **提示词/skill 层**:子代理的 skill 只描述"你负责 X 目录",任务上下文里根本不出现其他目录名——子代理"不知道其他目录存在"。
- (Linux NAS 可选加 OS 级 jail:@anthropic-ai/sandbox-runtime/bubblewrap 或 Docker 单目录 bind-mount;v1 先做前两层,OS 层记 backlog。)

## 活文档 / skill(防上下文腐化,2026 正统 progressive disclosure)

- **工作流指导 = skill 形式**(不塞提示词字符串):主代理的"如何派活"、子代理的"如何判断归属/遇到各分支怎么走/哪些是铁律(MUST/NEVER)"都写成按需加载的 markdown skill。本地自建循环(非 provider 托管)用手写 `read_doc(name)` 工具 + system prompt 只放 skill 名+描述清单实现渐进披露(约 30 行,不用 ai@7 的 uploadSkill——那是 provider 托管沙箱用的)。
- **各字幕源返回结果 = 可调用活文档**(句柄化,不内联):`search_source` 把完整结果写 DB/文件,只返回 `{result_set_id, count, top-N 摘要}`;`list_candidates(id, offset, limit)` / `get_candidate(id, concise|detailed)` 让子代理**逐块查看**大结果集,而非一股脑吞进上下文(照 Anthropic writing-tools 规范)。
- **auto-research 迭代 skill(带护栏,不放任自改)**:维护覆盖"新片/在更剧/老片/老剧/乱排布"的固定评测集;每次失败 → Claude A/B 式把新规则**增量追加**进对应 skill(带日期、进 git)、由独立步骤/人 curation 把关。**严禁让模型整篇重写自己的 skill**(斯坦福 ACE 论文证实会 context collapse:越改越侵蚀原规则)。硬铁律作 SKILL.md 顶部显式区块 + 强措辞。

## 测试哲学(用户明确要求)

- **测试期不设步数上限**(实际用生成的大天花板如 stepCountIs(500) + 硬 token/成本预算 + 全程 tracing):目的是**观测 agent 在每个环节实际打转多少步、卡哪、卡多久**,拿够数据后**再据数据经验性设限**。不是怕上下文,是怕它浪费时间瞎打转要看清楚。
- 观测工具:ai@7 的 experimental_telemetry → OTel spans;自托管 Langfuse 或本地存储(NAS 友好)。记录每阶段步数,事后定限。
- 全形态评测(既有要求延续):新片/在更剧/老片/老剧/乱排布(间谍过家家)全测;正常库零误触发(整理子代理不许误动已对齐的库)。

## 能力复用图(Explore 实测,演进路线的原材料)

**代码仓锁定 `/Users/dirtyfancy/projects/subtitle-scout`(不是 subtitle-plugin 那个旧 OSS fork)。**

**可直接当 v3 子代理工具(纯函数/依赖注入,零 LLM 耦合)——一寸不改:**
- 字幕获取:`fetchLib.ts` runSearch/runResolve(fan-out+去重+fail-soft)、三家 provider client 的 search/detail、`downloadDirect`。找字幕子代理的"搜索/取候选/下载"全调这些。
- 数据安全核心:`stagingSandbox.ts` allocate/install/cleanup/gcOrphans——`install()` 纯 fs(NFC+原子 rename+EXDEV 兜底),零 pipeline 耦合,**这就是要保住的血换地基**。
- 开箱:`subtitleWriter.writeSubtitle`(zip 解压+编码)、`subtitleInspect.inspectSubtitle`(出原始信号不打分)。
- 整理:`libraryRealign.buildRealignPlan`+gates(纯)、`realignManifest`(先行清单+回滚,纯 fs)。
- 机械分类:`scanner.classifyItemDetailed`(纯:covered/embedded/missing/ignored[国产免],走 TMDB origin 阶梯)、`libraryRepo.missingBySeason/missingMovies`。

**需轻度提取/改造:**
- `realignExecutor.executeRealign`:已是依赖注入(14 字段 deps),可当"整理目录"能力整包调用;唯一成本是组装 deps(它经 runEpisode 回调字幕流水)。→ 整理子代理包这个。
- `runGate`:纯确定性,但它是为"警察 forced-JSON rank 输出"而生。v3 里降级为**子代理可选调用的"检查我选的候选文件索引/集号安不安全"工具**,不再是强制闸门(符合北极星:不当守门人)。
- `scanLibrary`:自包含但把结果写进 LibraryRepo(副作用);活文档可直接读 LibraryRepo 的 sub_status,不用改。

**v3 替换掉的(单一 LLM 路径,10 agent 全走它):**
- `llm.ts` callStructured(`toolChoice:{type:'tool'}` 强制单发)、`runtime.ts` dispatch、`quirks.ts`/`probe.ts`/`profile.ts`(关 thinking 三件套)——**换成 ai@7 ToolLoopAgent + Output.object(末尾结构化)+ reasoning(开思考)**,关思考三件套退役(SDK 自己处理模型)。
- 10 个 agent 的去向:
  - **溶解进子代理自身判断**(不再是独立单发调用):identifyMedia/planSearch/**rankCandidates**/**verifySubtitle**/judgeOrphan/mapSeasonPack/mapLooseEpisodes/diagnoseSeason/harvestAlias——这些"判断"变成 ToolLoopAgent 开着 reasoning 边想边调工具的过程。
  - **保留为干净工具**:`solveNumericCaptcha`(窄、多模态 OCR,子代理按需调)。
  - 各 agent 里已拆出的纯 helper(isGraphicOnly/filterGraphicOnly/neededEpisodeCodesFor/compactCandidates/mirrorExceedsSeasonTable 等)留作确定性工具。
- journaling 消费的 CallStructuredResult 遥测(retries/durationMs/prompt)要在 ToolLoop 迁移时重新安家。

## 数据库状态机扩展(v3 backbone)

现有 jobs 表(v7,kind∈series_season/movie/realign,带 lease/heartbeat/claim-next/backoff)= 教科书级 DB 队列+无状态 worker 认领,**lease/claim 机械 kind-无关,直接复用**。
需加的:
- **新 kind**(如 worker_task / orchestrate)走**已验证的 v7 整表重建配方**(SQLite 不能 ALTER CHECK:建 jobs_new→copy→drop→rename→重建 jobs_identity/jobs_claim 索引;有 migration.realign-job-kind.test.ts 模板)。
- **结构性约束(真正的限制,不是 CHECK)**:identity/dedup 硬编码 series_id/season/movie_id 三列(ON CONFLICT 那套)。通用"主代理派了任务 N 待 worker 认领"的行没有自然归属→同一迁移里加 `payload`(任务载荷 JSON)+ `parent_job_id`(树状溯源/100 溢出分片)列。
- **幂等/exactly-once**:主代理"标记已派"= 写库那一下,状态列(pending→claimed)+ 唯一约束保证崩溃重启不重复派(不靠主代理记忆)。

## 迁移路径(演进,不重生;分阶段,每阶段 repo 保持绿)

大原则:**先在 ToolLoopAgent 里把一个子代理(找字幕)跑通、真站验收,再逐步把主代理/整理子代理/触发流接上,最后退役旧 pipeline。旧 pipeline 在新路径真站验收通过前不删。**
- 阶段序(细节留 writing-plans):①llm 层加 ToolLoopAgent-based reasoning 路径(与旧 callStructured 并存,不动旧的)②活文档工具(read_doc + 源结果句柄化 search_source/list_candidates/get_candidate)③找字幕子代理(ToolLoopAgent+reasoning+沙盒+复用获取/staging 工具)+ 全形态离线评测 + 真站验收 ④DB 加 worker_task kind+payload+parent 列(v8 迁移)⑤主代理(读活文档→派 pending→100 溢出树)⑥整理子代理(包 executeRealign)⑦触发流(dashboard 全仓校验)⑧旧 pipeline/10 单发 agent/关思考三件套退役。

## 风险台账

- **成本爆炸**:多代理调研实测比单代理烧 ~15x token,且经典失败=为简单查询 spawn 50 个子代理。对策:主代理 skill 里植入 effort-scaling 铁律(简单=少派);测试期不设步数上限但设硬 token/成本预算+全程 tracing 观测,据数据事后设限。
- **上下文腐化**:活文档渐进披露(名+描述先行,正文按需)+ 源结果句柄化(不内联);skill auto-research 只增量追加+评测兜底+curation 把关,**严禁模型整篇自改 skill**(ACE 证实 context collapse)。
- **沙盒逃逸**:代码层路径校验(复用 containingRoot/isUnderRoots)是硬边界,提示词层只是"不告诉它别的目录";两者都做,别只靠提示词(提示词不是安全边界)。
- **数据安全(整理动用户文件)**:realign 的五重防线(闸门全过才动/原子 rename/先行清单可回滚/永不删除/空挂载哨兵)在 v3 里由整理子代理继承,不因 agent 化而放松。
- **wrong-repo**:实现锁定 subtitle-scout。
- **回归**:旧 pipeline 保留到新路径真站验收通过;每阶段双包绿(root+web)+ tsc。

## 测试与验收(北极星级硬门)

- 全形态离线评测:新片/在更剧/老片/老剧/乱排布(间谍过家家)。
- **正常库零误触发**(整理子代理不许误动已对齐库)= 硬门。
- **真站端到端硬门**(延续 zimuku 教训):找字幕子代理必须在真站真的搜到→判断→下载→解压→装上真字幕,不止离线夹具绿。
- 观测优先:测试期大天花板(如 stepCountIs(500))+ 记录每阶段实际步数,据数据定生产限。
