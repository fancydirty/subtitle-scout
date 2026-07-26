# Subtitle Scout 待办事项

**更新日期**: 2026-07-26（路 A Phase 1 + 1b 完成，两轮子代理审计修完，识别评估 11/11）

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

**Phase 2: 删 rescue agent + 机械降级 + 清 parked 行**
- [ ] 删 rescueWorker/rescueWorkerTask/rescueSkill/rescueWorker.tools + 测试 + daemon 调度
- [ ] resolveToTmdb 不再写库当真相（评估：路 A 下 agent 已能纠错，机械降级的收益还有多少）
- [ ] 清空 parked_paths 表（旧架构产物）

**审计遗留（低优先级，已记录未修）**
- [ ] movie 分支缺端到端闭环测试（TV 有；movie 的 ingest 路径有 placeholder upsert 这个结构差异）
- [ ] 可观测性：agent 纠错次数/拒写次数只能手写 SQL，无 dashboard 面板、无 CLI 查询
- [ ] identityEval 里那条 mtime 伪造的闭环测试是冗余的（真正load-bearing 的是生产条件锁），可合并
- [ ] 回滚窄窗口：v24 后回滚→期间人工认领→滚回，那条人工认领会失去 source 保护（三步齐全才命中，已在 db.ts 注释标注）

---

## 🧹 技术债（更早遗留）

- [ ] 生产库识别错误评估：扫 NAS 看多少条目 title 是 "tv"/"movies"/分类目录/单字符垃圾（旧 bug 误识别的）——现在 agent 能自己纠了，可以先观察一轮再决定要不要批量干预
- [ ] worker/（Cloudflare ASSRT 中继）孤儿组件，已标退役，可考虑删

---

## 📝 方法论备忘

- **auto research**（战役 12 沉淀 + 本轮十轮验证）：fail-closed，FAIL 是诊断原料；模型会虚构失败解释，只信数据不信叙述；每轮=暴露→根因→修→复验。本轮的教训：**改 skill 措辞会挪动模型行为**，一个 case 修好可能让另一个退化，必须每轮全量复跑；措辞加三四轮还拦不住的，说明是机制问题，该改 schema/字段设计而不是继续加话。
- **假测试的形状**：为了让测试通过而制造生产不存在的前提（伪造 mtime、手动插一条生产不可能存在的 parked 行）。判据：破坏实现的哪一行会让它红？想不出就是假的。
- **`identityEval.live.test.ts` 是识别能力的回归锁**：模型升级/skill 改动后必跑（`IDENTITY_EVAL_LIVE=1 npx vitest run src/agent/identityEval.live.test.ts`）。它自带 ground truth 漂移检测，TMDB 数据变了会明确报出来，不会伪装成模型退化。

---

**下次更新**: Phase 2 开工时
