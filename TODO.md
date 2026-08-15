# Subtitle Scout 待办事项

**更新日期**: 2026-08-15（Phase 3 完成：runs 前端消费页 + 全部技术债清偿/失效判定）

---

## 🔥 当前状态：agent 身份纠错已闭环并经审计加固

**Spec**: `docs/design/2026-07-26-subtitle-agent-identity-spec.md`（正文是实施前设计稿，**先读文末「实施偏离记录」**——最终走路 A，落地方式与正文不同）

### 已完成（commits 1fe4b9a → 3fb9609）

**能力本体**
- 共享 TMDB 证据工具（`src/agent/tmdbTools.ts`），rescue 与 find-subtitle 共用
- find-subtitle agent 加 Step 0 识别验证：two-evidence bar（名字 + 季表/年份/时长）、反脑补红线、year 矛盾一票否决、目录名是标题主证据、禁搜纯技术 token
- 纠错落地：写 `identify_overrides` 认领 → 下轮 ingest 按新身份建行 + 清旧错行（**不**手写 id 迁移）
- finalize 加 `identity_verified`（确认的去处）+ `identity_correction`（纠错的去处）

**审计修出的真问题（两轮子代理，含 3 条实测复现的数据损坏）**
- 🔴 闭环曾在生产路径上**根本不通**：ingest CHEAP PATH 在 recognize 之前早退，认领永久悬空。且我原来的端到端测试伪造了 mtime 变化才绿——**假测试**。已补认领穿透 + 真实 statSync 回归锁
- 🔴 安全闸第一版把多季剧（最常见布局）永久锁死 → 改为公共祖先 + 严格深于配置根
- 🔴 correction + installed 共存时字幕装到 agent 自己刚宣布错误的身份上（Peacemaker 事故形状）→ schema superRefine + runner 两道防御
- 🔴 幻觉但合法数字的 tmdbId 建出永久鬼影剧（genres='[]' 404 熄火哨兵，永不自愈）→ 落地前验存在性
- 认领表加 `source` 列（schema v24）：agent 永不覆盖人工认领；前缀匹配落到路径边界（`Show` 不再吞 `Showgirls`）
- 人类控制面：撤销认领（此前**零删除路径**，agent 认错就永久钉死）、来源角标、两个新 decision 词进词表、runs detail 补旧身份、i18n 文案不再说谎
- `deleteSeriesIfEmpty` 连带清 `tmdb_seasons` 孤儿

**auto research 十轮迭代 → 识别评估 11/11**
- 评估集 9 case（含 The Rig / Peacemaker 两起真实生产事故 + S04E13 红线）+ 2 道 ground truth 防腐 preflight
- 修出三类根因：措辞层（决策表/边界规则）、机制层（identity_verified 字段 / 空转纠错拦截）、plumbing 层（布尔字符串容错 / **目录名从未进过 prompt**）

**门禁**：后端 2054 passed，web 301 passed，识别评估 11/11；所有修复经 mutation 验证

---

## 📋 下一步

**Phase 2 已完成** ✅
- ✅ 删 rescue agent（commit `e889e2a`，2026-07-27）
- ✅ resolveToTmdb 已不存在（代码里搜不到）
- ✅ ingest 整条链已删（commit `10bd7c5`，2026-08-13，净 -4698 行）
- ⏳ parked_paths 表还在（仍被 `cli/unidentifiedFindSubtitle.ts` 读写，属"保留待裁"的 handleWorkerTask 族，见 10bd7c5 的四张表评估）

**Phase 3: 可观测性与测试补全（已完成）**
- [x] runs 记账接线（2026-08-15，生产实测发现）：v3 字幕轨对 runs 表**零写入**——唯一写方是已死的 jobs claim-dispatch 路径，而 `/api/v2/runs` 端点还活着。已把 `RunsRepo.insert` 接进 `runSubtitleWorkDir`（按非空桶各记一行，词表沿用，trace_json 一次快照挂多行，job_id=NULL）。测试：daemonV2.test.ts「runSubtitleWorkDir · runs 记账」4 条。
- [x] runs 的前端消费（2026-08-15）：活动页新增「决策历史」段（`web/src/workbench/RunsHistory.tsx`）——runs 行（decision 词不翻译 + 人话 detail + 相对时间）、点击惰性展开 trace 回放（`/api/v2/workflow/runs/:id/trace`，每行只取一次）、工作台级事件触发重拉、分页加载更多。README 已同步回真实描述（历史段在活动页，不再只说 curl）。
- [x] runs 保留期裁决（2026-08-15 用户裁决：**最多一周，与通知页同窗**）：`RunsRepo.pruneTraces` 从“行保留、只清 trace_json”改为过期整行 DELETE（进行中的行不删）；cli 默认值 30→7，`trace_retention_days` 设置仍可覆盖。先前“决策史不删”是开发期口径，已废。
- [x] subtitles 表处置（2026-08-15 评估裁决：**保留，不 DROP**）：3 处 INSERT 全在雪藏的 handleWorkerTask 族上（用户 2026-08-14 裁决「不删不接，等主链路 live test 没毛病再裁」），读方（verifySweep 族）同样雪藏。唯一活触碰点是 `settingsRepo.removeRoot` 的级联 DELETE——对 0 行表是无害 no-op。单方 DROP 等于替雪藏裁决做决定；处置与那族捆绑，等 live test 观察期结束后一起裁。
- [x] identityEval mtime 冗余测试：**已随 identityEval.live.test.ts 文件删除而消失**（agent-first 架构重构），死待办划掉。
- [x] 回滚窄窗口 v24：**已随 v27 认领退役失效**——identify_overrides 表（含 source 列）v27 已 DROP，db.ts 里那段三步齐全注释也已删；迁移链按 meta.schema_version 只进不退，"回滚到 v24-26 再滚回"的操作面不存在了。死待办划掉。

---

## 🧹 技术债（更早遗留）

- [x] 生产库识别错误评估（2026-08-15 实查）：36 个 works 全部干净——0 条可疑 title（"tv"/"movies"/分类目录/单字符垃圾）、0 条 year 缺失。现库是 8/15 从零 live test 重建的，识别全走 agent-first 新架构，旧 bug 存量脏数据不存在，无需干预。
- [x] worker/（Cloudflare ASSRT 中继）孤儿组件已删（2026-08-15）：目录本就被 .gitignore（从未入库），磁盘清除 + devDependencies 删 wrangler/@cloudflare/workers-types（lockfile 已刷新）+ .dockerignore 摘除条目。云上资源（workers.dev 部署与 KV namespace）是仓库外的，如需回收另行 wrangler delete。

---

## 📝 方法论备忘

- **auto research**（战役 12 沉淀 + 本轮十轮验证）：fail-closed，FAIL 是诊断原料；模型会虚构失败解释，只信数据不信叙述；每轮=暴露→根因→修→复验。本轮的教训：**改 skill 措辞会挪动模型行为**，一个 case 修好可能让另一个退化，必须每轮全量复跑；措辞加三四轮还拦不住的，说明是机制问题，该改 schema/字段设计而不是继续加话。
- **假测试的形状**：为了让测试通过而制造生产不存在的前提（伪造 mtime、手动插一条生产不可能存在的 parked 行）。判据：破坏实现的哪一行会让它红？想不出就是假的。
- **识别能力回归锁的历史口径**：`identityEval.live.test.ts`（`IDENTITY_EVAL_LIVE=1` 开门跑，真模型+真 TMDB，自带 ground truth 漂移检测）曾承担此职，**该文件已随 agent-first 识别架构重构删除**。识别质量的现行守卫是 `src/agent/skills/identifyMediaSkill.test.ts` 的措辞锚点锁 + 离线 eval（`findSubtitleWorker.eval.test.ts`）；若重建 live 评估，沿用该方法论（fail-closed、全量复跑、漂移检测不伪装成模型退化）。

---

**下次更新**: Phase 3 开工时
