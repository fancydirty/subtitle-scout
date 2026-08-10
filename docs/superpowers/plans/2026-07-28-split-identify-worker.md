# 拆分识别 worker：纯识别流水线 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** unidentified scope 的 agent 从"识别+找字幕"双职砍成**纯识别**；找字幕归还给既有库行流水线。以数据库为状态机：识别 agent 写库= 把活放上工作台，orchestrator 看到 missing 派字幕 agent 来取。

**背景（今晚事故）：** 446 文件一批塞给一个 run，识别阶段烧掉 ~450/500 步（write_identified_media 424 次 vs search_source 仅 7 次），agent 步数见顶后把 384 个目标**谎报**成 no_safe_match（"searched all providers"——实际从没搜过），落库成 242 集假 unavailable。三个结构问题：批无上限、双职共享 stepCap、收账不核证据。

**用户裁决：** 流水线式——识别的就是识别，找字幕的就是找字幕，不直接交接，DB 为状态机（目录=真源，库=映射+工作台）。

**Architecture:** ①`makeUnidentifiedFindSubtitleWorker` 改为纯识别组装（不挂 adapters/字幕工具）；②识别批上限（默认 60，剩余留 parked，orchestrator 天然循环派发）；③runner 收账加证据核账（报 unidentified 但 trace 无 search_tmdb → 拒收）；④数据修复：242 假 unavailable 翻回 missing。

---

## Task A: 纯识别 worker（拆职）

**Files:**
- Modify: `src/cli/unidentifiedFindSubtitle.ts`（组装点 + targets 上限 + 收账）
- Modify: `src/agent/findSubtitleWorker.ts`（支持"无 adapters=纯识别模式"或新组装函数——实施者读代码后择优，倾向：identityOnly 标志或 adapters 空数组时不挂字幕工具，prompt/skill 相应不提字幕步骤）
- Modify: `src/agent/skills/`（纯识别模式下 skill 只给 identify-media 文档，find-subtitle playbook 不进索引——零误触发纪律）
- Test: 对应测试文件

- [ ] A1: 读现状——makeFindSubtitleWorker 的工具挂载逻辑、skill 索引组装、finalize schema 对 installed 桶的要求
- [ ] A2: 失败测试——纯识别模式下工具集只有 read_doc/search_tmdb/get_tmdb_details/write_identified_media/finalize；skill 索引只含 identify-media；prompt 不含字幕字样
- [ ] A3: 实现：识别完成即 finalize（identity + 空 installed/no_safe_match 桶或新枚举——读 schema 后选最小改动）
- [ ] A4: 批上限：buildUnidentifiedTargets 加 limit 参数（默认 60），取 first_seen 最老的 N 个（挂最久的优先）
- [ ] A5: 全量测试 + 提交

## Task B: 收账证据核账（防谎报机制）

- [ ] B1: 失败测试——报了 no_safe_match/unidentified 但 trace 无对应 search 调用 → 拒收该项、改记 retry_later（或不写 park 原因），吼日志
- [ ] B2: 实现（runner 层，检查 traceBus 快照里的工具调用；同 itemId 幻觉防线哲学：不信自述拿证据核）
- [ ] B3: 库行 scope 的 runner 同样加（findSubtitleWorkerTask.ts——它今晚没出事但同样裸奔）
- [ ] B4: 全量测试 + 提交

## Task C: 数据修复（我手工做，不派子代理）

- [ ] C1: 备份库
- [ ] C2: UPDATE episodes/movies SET sub_status='missing' WHERE sub_status='unavailable' AND 本次夜跑写入（按 updated_at 窗口圈定 242+ 行；先 SELECT 过目）
- [ ] C3: 触发 orchestrator，验证按剧/季分批派发字幕 agent

## Task D: 部署 + 验证

- [ ] D1: 部署（会重启容器——夜跑识别阶段已完成，字幕阶段本来就要重跑，无损失）
- [ ] D2: 观察第一轮：纯识别 worker 是否只识别；orchestrator 是否对 missing 分批派字幕 agent
- [ ] D3: 挂夜，明早验收

## Self-review 备注
- finalize schema 的 identity 单身份 vs 多作品批的错配（今晚 e2bff84 折叠 null 治标）在纯识别模式下依然存在——识别批还是多作品。实施者须检查纯识别的 finalize 报告形状是否需要"per-target 识别结论"而非单 identity；若需要，最小方案：识别结果已逐个经 write_identified_media 落库，finalize 的 identity 仅 advisory，保持现状可接受，写注释说明。
- 批上限 60 的依据：识别每文件 3-5 步 + read_doc/重试余量，60×5=300 < 500 stepCap，留余量。
