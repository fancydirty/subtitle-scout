# Subtitle Scout 待办事项

**更新日期**: 2026-07-26 (路 A Phase 1 + auto research 两轮完成，识别验证 5/5 绿)

---

## 🔥 当前状态：路 A Phase 1 完成 + auto research 识别验证 5/5

**Spec**: `docs/design/2026-07-26-subtitle-agent-identity-spec.md`（含架构硬约束发现：own-id 空间编码机械识别的 tmdbId，路 A/B 两条路，用户裁决先走 A）

**已完成（commits 1fe4b9a + 533c87f）**:
- ✅ 共享 TMDB 身份证据工具（`src/agent/tmdbTools.ts`），rescue 改复用
- ✅ findSubtitleWorker 加 Step 0 识别验证：deps.tmdb 提供时挂 search_tmdb/get_tmdb_details + skill 教核验流程（two-evidence bar / 反脑补红线 / year 一票否决）
- ✅ prompt 机械身份标注为 MECHANICAL GUESS；schema 加 identity_correction（nullableJsonTolerant）
- ✅ runner 记录 identity_correction（runs 时间线行，**不迁行**——迁行重派是后续切片）
- ✅ cli 两处 makeFindSubtitleWorker 接线 tmdb
- ✅ **auto research 识别评估**（`src/agent/identityEval.live.test.ts`，IDENTITY_EVAL_LIVE=1 门控）：真模型 + 真 TMDB，5 case ground truth
  - 第一轮 4/5 FAIL 暴露 3 根因（JSON 字符串编码 plumbing / 确认滥用 / year 矛盾失守）→ 全修
  - 第二轮 **5/5 全过**：核验通过 ×2 + 正确纠错 ×3（铁拳教育→276161 / 招z魂z4→1038392 / H）后丨室→1083381）

**全量 2013 passed / 6 skipped；mutation 验证 4 杀（skill 参数/工具挂载/runner 记录/schema 字段）**

---

## 📋 下一步

**Phase 1b: identity_correction 迁行落地（后续切片）**
- [ ] runner 收到 identity_correction 后执行迁行：建新 series/movies 行（正确 tmdbId 构造 own-id）→ 迁移 episodes/movies 行到新 id → 删旧错行 → 重置 item 退避让缺口立刻重派
- [ ] 涉及 ownIds/libraryRepo/ingest 的写路径——需要先想清楚幂等（迁行途中崩溃怎么恢复）

**Phase 2: 删 rescue agent + 机械降级 + 清 parked 行**（路 A 稳定后）
- [ ] 删 rescueWorker/rescueWorkerTask/rescueSkill/rescueWorker.tools + 测试 + daemon 调度
- [ ] resolveToTmdb 不再写库当真相（series.name/tmdb_id 只在 agent 识别回填后写）
- [ ] 清空 parked_paths 表（旧架构产物，agent 自己识别）

**Phase 3 延伸: 扩充识别评估集**
- [ ] 更多真实命名 case（后室剧集版歧义/怪奇物语中文名/多季剧 season 归属）
- [ ] 定期跑（模型升级后必跑——评估集就是识别能力的回归锁）

---

## ✅ 已完成（最近几轮）

### 网盘挂载测试（Openlist + 阿里云盘）
- ✅ Openlist FTP 挂载成功（扫描 27 mkv 5.48s，davfs 卡死做不到）
- ✅ subtitle-scout 完整跑通：扫描识别（招魂/2001）→ 找中文字幕 → 装到阿里云盘（.zh-Hans.srt 原子写）
- ✅ PGS 图形字幕正确识别为"不可用"，找文本字幕装上

### 识别层重写（Emby.Naming 架构）
- ✅ 按 Emby.Naming 架构重写 parseFilename/identifyFromPath（一组带优先级/防截断/防错闸的正则库）
- ✅ 真实命名压力测试全过（招z魂z4/H）后丨室/fansub/BT站/季包/中文季目录）
- ✅ 全量 1994/1994 全绿（commit cea02b1）

### 架构债务清理（R1-R8 审计）
- ✅ 多轮子代理审计，修复 80+ 问题（安全/SQL注入/内存泄漏/部署坑点/文档一致性）
- ✅ 所有修复经 mutation 验证（回退实现→测试变红）

---

## 🧹 技术债（低优先级）

- [ ] 生产库识别错误评估：扫 NAS 看多少条目 title 是 "tv"/"movies"/分类目录/单字符垃圾（旧 bug 误识别的），需要重识别
- [ ] worker/（Cloudflare ASSRT 中继）孤儿组件，已标退役，可考虑删
- [ ] docs/product-shape.md 已加退役标记，docs/cloudflare-worker.md 已加退役标记

---

## 📝 备注

- **auto research 方法论**（战役 12 沉淀 + DSPy 调研）：fail-closed，FAIL 是诊断原料；模型会虚构失败解释，只信数据不信叙述；每轮=暴露→根因→修→复验；评估集 ground truth 必须来自真实世界（真 TMDB 实查），train/test 分离防过拟合。
- **identityEval.live.test.ts 是识别能力的回归锁**：模型升级/skill 改动后必跑（`IDENTITY_EVAL_LIVE=1 npx vitest run src/agent/identityEval.live.test.ts`）。

---

**下次更新**: Phase 1b（迁行落地）或 Phase 2（删 rescue）开工时
