# 救援官战役 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。
> 执行器=K3（opencode company/kimi-k3，一单一任务，任务书自带全上下文+强制汇报收尾）；**R1-R3 涉及 src/agent/skills/ 的改动=主控亲笔，K3 禁触**。铁律与 trailer 同债务波计划头。spec=docs/design/2026-07-17-rescue-officer-design.md（必读）。

**Goal:** agent 清停车场 + 特典三级排除 + hardsub_mode 真消费。

**现状坐标：** parked_paths/identify_overrides（libraryRepo P2 面）；claimParked（apiV2）；reasoningAgent 工厂+traceBus 自动痕迹；orchestrator 工具面（orchestratorAgent.tools.ts dispatch 三件套+DispatchCounter）；jobs 身份 v11（json_extract taskType）；ffprobe=files/streamProbe.ts；settings 白名单（hardsub_mode/exclude_extras）。

### R1: rescue_identify 任务管道（后端机械层）
Modify `src/v2/jobsRepo.ts` 不动（身份元组兼容合成 seriesId）；Create `src/v2/rescueWorkerTask.ts`+test（mapper：parked_paths 非 excluded-extra 非 duplicate-content 行按 dirname 分组→RescueTask{groups:[{dir,files,reason,durationsSec}]}，ffprobe 逐文件时长注入=机械层备料，失败 null；runner：claim→跑 agent→按 finalize 收割——claimed 组走 claimParked 同路径+踢扫描、parked 组回写 reason、excluded 组标 excluded-extra；runs 行 decision=rescue:*+trace 快照沿 findSubtitleWorkerTask recordRun 先例含排空纪律）；cmdWatch claim 分支加 taskType 路由。测试：分组/收割三桶/幽灵防御（组内文件已消失）。commit `feat(救援R1): rescue_identify 任务管道`。

### R2: 救援 worker agent（主控亲笔 skill + K3 做工具）
Create `src/agent/rescueWorker.ts`+`rescueWorker.schemas.ts`+tools+test（工具五件：search_tmdb/get_tmdb_details/claim_directory/exclude_extras/keep_parked——契约见 spec §2；finalize schema=三桶逐组结局；reasoningAgent 组装同 findSubtitleWorker 先例，stepCap 500、超时按组数缩放沿 timeoutFor 手法）；Create `src/agent/skills/rescueSkill.ts`=**主控亲笔**（判断纪律：双证据/宁停不猜/季集数校验/灰区特典判据 TMDB S0 或时长≥15min）。测试：mock 模型走一组 claim+一组 keep 的端到端。commit `feat(救援R2): 识别救援 worker`。

### R3: orchestrator 接线（skill 段=主控亲笔）
Modify `src/agent/orchestratorAgent.tools.ts`+test（list_missing_coverage 附 parked 事实块；新 dispatch_rescue_task 工具——upsertWorkerTask 合成身份 `rescue-<dirhash>`、四态回执同款、共享 DispatchCounter）；orchestratorSkill 补"停车场>0 可派救援"段=**主控亲笔**；B-matrix 形态补一个 rescue 场景（orchestratorBacklog.ts）。commit `feat(救援R3): orchestrator 派发救援`。

### R4: 特典三级排除
Modify `src/v2/ingest.ts`+test（识别前置铁案过滤：词边界正则 NCOP|NCED|Menu|PV|CM|Trailer|Preview，exclude_extras='true' 才启用，落 park reason=excluded-extra）；`web/src/triage/`（第三箱 Excluded extras：默认折叠+一键翻案=DELETE 该 parked 行触发重识别——需小端点 POST /api/v2/triage/unexclude {path}，server.ts 分支照 claim 先例）+测试；设置页 exclude_extras 注记改"已生效"。commit `feat(救援R4): 特典三级排除+翻案箱`。

### R5: hardsub_mode 消费
Modify `src/v2/db.ts`（无新列——sub_status 收新词 hardsub-assumed，纯值域扩展）；`src/v2/findSubtitleWorkerTask.ts`+schemas（task 透传 hardsubMode，mapper 读 settings）；findSubtitleSkill 增判定段=**主控亲笔**（agent 档三条件：组名标记+无内嵌+无候选→可判 hardsub-assumed 结局，finalize 三桶外加第四桶 hardsub_assumed 或并入 no_safe_match 带 flag——实施定夺后统一）；harvest 落 `markHardsubAssumed(itemId)`（libraryRepo 新方法，sub_status=hardsub-assumed 不进退避梯）；aggressive 档=ingest 探针处机械直判；前端格阵/覆盖句/详情板收新态（独立样式非绿点，DESIGN.md 语义色内取灰绿间调，en 词 `hardsub assumed`）。测试：三档各一条端到端。commit `feat(救援R5): hardsub 三档真消费`。

### R6: README 命名最佳实践 + 收官
README 新节+甄别页指引文案对齐；双侧全绿；真站：测试台跑一轮救援 pass 验收 spec 口径四条；R2 对抗复审（一轮）+登记册落册。

## 自审
spec §1-§5 对应 R3/R2/R4/R5/R6 全覆盖；claim_directory 与 claimParked 单一实现路径（防漂移）；hardsub finalize 桶形留了一个实施定夺点（两案都合法，K3 单内定夺+主控亲核裁决）——已显式标注非 TBD。
