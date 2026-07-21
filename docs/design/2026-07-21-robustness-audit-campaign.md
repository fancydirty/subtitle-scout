# 健壮性打磨战役:agency-agents 人格审计(2026-07-21 夜)

> 与从零 live test 并行。四个人格(agency-agents 仓 135k⭐)并行审计 → 分级修复 → TDD。
> 全部修复已部署生产(迁移 v13 自动快照+首 tick 备份即上线即生效)。

## 人格与分工

| 人格 | 范围 | 产出 |
|---|---|---|
| Code Reviewer | F1/F2 翻译新代码 | 2🔴(写盘覆盖源视频/jimaku 缓存失集)+ 9🟡 |
| SRE | daemon 可靠性 | 2🔴(崩溃循环 money fire/held 无限重试)+ F3-F8 |
| DB Reliability | SQLite 层 | 3🔴(无备份/checkpoint、NORMAL sync、迁移无快照)+ 级联漏孤儿 |
| Reality Checker | 近 4 commit 声明核验 | 4 项⚠️WEAK(接线真但无测试锁) |

## 已修(commits,全 TDD)

1. `fix(translate) 审计🔴三连`:sidecarPathFor 防覆盖源视频+原子写;jimaku providerId 自描述 `#ep`+缓存失集 fail-closed+变体循环/诚实空/逐条解析/连字符;零 cue→held
2. `fix(jobs+translate) 崩溃循环隔离`:jobs.reap_count(schema v20→落库 13)触阈 park;批重试 3s/5s 递增退避+lastErr 进 reason
3. `feat(db) 耐久层`:synchronous=FULL;openDb quick_check;迁移前自动快照;daemon dbMaintenance(小时 checkpoint+天级 VACUUM INTO 留7);.immediate() 事务;removeRoot 级联 item_files/pending_removals;SIGTERM 关库
4. `fix(translate) critic 超时同门`:-nostdin;sourceLangName 三跳断言;ja 重排稳定性断言
5. 顺手:ai_translate 开关改**每 tick 惰性**(原启动快照,设置页改了不重启不生效——SRE F3/RC f 双料实锤)

测试基线:**1901 passed** + tsc 净。

## 留评审/接受风险(不擅动)

| 项 | 决策 |
|---|---|
| SRE F2:held 每日重试至永远 | 退避到天级后成本封顶(1 item/天),记此;要"held 上限→park"需用户拍板 |
| CR11:字幕文本注入 prompt(critic 可被 [] 绕过) | 接受为已知风险并记录:确定性闸兜底,critic 只是增益层 |
| CR15:pipelineOpts 不可配 | 非阻塞,YAGNI |
| SRE F6:claimed_at 列/失败计数告警 | 下一波观测增强 |
| 💭 mergeGlossary 存未 trim | 行为正确,纯洁癖 |

## 部署验证(2026-07-21 16:24 UTC)

- 迁移 v13 自动落 `scout.db.pre-v13.bak`
- 首 tick `db backup: /cache/backups/scout-20260721.db`
- boot reap 旧进程孤儿租约,零跑任务无缝续跑

## 心跳

opencode 无 timer;主控短轮询 + nohup/done + 本文件时间线。
