# Phase 1 加固计划 — "发射后不管"验收线修复波

日期:2026-07-11。输入:对抗式健壮性审计(11 失败面 × 独立审计 + 每条发现两路对抗复核,
75 agent,29 条存活实锤:0 blocker / 6 high / 10 medium / 13 low)。

## 判决

Phase 1 逻辑正确性已由 548 单测 + e2e 背书,但**尚不满足"发射后不管"**。六条 high 全部
命中长期无人值守场景:超长任务被自己收割导致并发重入、退避被聚合器悄悄清零、季内横扫
无结构校验可整季串号、OS 无超时拖死子进程。全量测试(OrbStack 边角 + NAS 真数据)推迟到
本修复波合并之后,否则测的是已知有病的机器。

## 修复包(按文件所有权分包,互不相交,并行 worktree)

| 包 | 范围文件 | 修复主题 |
|---|---|---|
| A | src/v2/{jobsRepo,daemon,aggregator}.ts (+executor.ts:315) | 租约心跳/进程内重入防护;reap 不计 attempt;聚合器不得回收退避中 job、复活不得清零 attempt;transient/content 双轨计数分离;tick 错误隔离;transient track 封顶 |
| B | src/core/pipeline.ts, src/cli/adapters/assrtAdapter.ts | 横扫串号三连(候选↔集结构校验禁盲回退 [0]/candidate_id 去重/同集取最高置信);ask_user 部分候选集降级;横扫预算计失败+熔断;崩溃恢复先查库后下载;gems 失败上报 provider_error |
| C | src/adapters/providers/opensubtitles.ts, src/cli/adapters/opensubtitlesAdapter.ts | AbortSignal 超时;配额信号(remaining/reset_time_utc)消费+typed quota_exhausted 事件出 NDJSON;imdbDigits 0/NaN 回退标题查询;api_call 双计修复 |
| D | src/v2/scanner.ts | ProductionLocations 权威信号优先于标题启发式(治误杀);负/未知 origin 结果缓存(治每集重查放大) |
| E | src/files/subtitleWriter.ts | temp+rename 原子写;existsSync 不再把截断文件当完成 |
| F | web/src/lib/badge.ts | 「暂无」与「还没试」徽章分离 |
| W2(A/C 合并后串行) | src/v2/executor.ts(:251/:219) + dashboard | 消费 C 的 quota_exhausted → 按 reset_time_utc 退避;ask_user 不再谎报 unavailable,独立状态+dashboard 呈现 |

## Backlog(设计题,不进本波)

- daemon.ts:117 — 单 searching 槽无抢占,播放中 priority-100 job 最长等 30min(交互优先级形同虚设)。
- jobsRepo.ts:219 — 播放 priority 提到 100 后永不衰减。

## 流程

每包:sonnet 实现者独立 worktree(铁律:并行必须 worktree)→ TDD(先失败测试后修)→
全量 npm test + tsc 绿 → 对抗审查(强模型)→ 需改则修 → 主循环串行合并,每合一包全量回归。
合并全绿后进全量测试:OrbStack mock 边角彩排 + NAS 真数据满负荷(生产=测试环境,用户已授权)。

审计的 solid notes(各维度已验证扎实的不变量)存档于会话 scratchpad fixwave/solid-notes.md;
完整 29 条发现含失败场景在 fixwave/pkg-*.json。
