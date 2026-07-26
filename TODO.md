# Subtitle Scout 待办事项

**更新日期**: 2026-07-26 (识别架构大改 spec 完成，等 compact 后实施)

---

## 🔥 当前进行中：识别架构大改

**Spec 已完成**: `docs/design/2026-07-26-subtitle-agent-identity-spec.md`

**核心架构（已对齐）**:
- 机械解析只给 raw 数据（文件路径/目录名/资源名/时长/结构提示/imdb hint），不做最终判定
- subtitle agent 被唤起时**自己识别**（脑中清洗 raw 数据 → 调 TMDB search/details 佐证 → two-evidence bar → 识别对了立刻回填库）
- 然后基于识别的身份找字幕（原有工作流）
- **rescue agent 干掉**（它是"无状态 API 调用器"，不是真 agent，逻辑并进找字幕 agent）
- **数据库是状态机**：识别/install 每步立刻落库，断了读库接续

**两个核心原则（用户钦定）**:
1. **证据先行**：绝不脑补（模型知识库有星球大战/招魂/莉可丽丝也不能用"我记得"判定，必须调 TMDB 拿证据，two-evidence bar）
2. **auto research 打磨识别 skill**：识别 skill 是活的文档，用真实命名压力测试集喂 agent 迭代措辞

**实施计划（3 个 Phase）**:
- Phase 1: findSubtitleWorker 加识别能力（识别工具 + raw 数据 task + skill 识别步骤）
- Phase 2: 删 rescue agent + 机械识别降级（不写库当真相）
- Phase 3: auto research 打磨识别 skill（真实命名压力测试集）

---

## ✅ 已完成（最近几轮）

### 网盘挂载测试（Openlist + 阿里云盘）
- ✅ Openlist FTP 挂载成功（扫描 27 mkv 5.48s，davfs 卡死做不到）
- ✅ subtitle-scout 完整跑通：扫描识别（招魂/2001）→ 找中文字幕 → 装到阿里云盘（.zh-Hans.srt 原子写）
- ✅ PGS 图形字幕正确识别为"不可用"，找文本字幕装上
- ⚠️ Openlist 登录限流：密码错误累积 429，重启容器清（不是 scout 问题）

### 识别层重写（Emby.Naming 架构）
- ✅ 按 Emby.Naming 架构重写 parseFilename/identifyFromPath（一组带优先级/防截断/防错闸的正则库）
- ✅ 真实命名压力测试全过（招z魂z4/H）后丨室/fansub/BT站/季包/中文季目录）
- ✅ 全量 1994/1994 全绿（commit cea02b1）

### 架构债务清理（R1-R8 审计）
- ✅ 多轮子代理审计，修复 80+ 问题（安全/SQL注入/内存泄漏/部署坑点/文档一致性）
- ✅ 所有修复经 mutation 验证（回退实现→测试变红）

---

## 📋 下一步（compact 后）

**Phase 1: findSubtitleWorker 加识别能力**
- [ ] 抽共享 TMDB 工具（search_tmdb / get_tmdb_details）给 findSubtitleWorker 和 rescue 共用
- [ ] FindSubtitleWorkerDeps 加 tmdb 依赖
- [ ] findSubtitleWorkerTask.ts 的 task 改 raw 数据（文件路径/目录名/资源名/时长/结构提示/imdb hint）
- [ ] findSubtitleSkill 加识别步骤（清洗→佐证→two-evidence bar→立刻回填库→找字幕）

**Phase 2: 删 rescue agent + 机械降级 + 清 parked 行**
- [ ] 删 rescueWorker/rescueWorkerTask/rescueSkill/rescueWorker.tools + 测试 + daemon 调度
- [ ] resolveToTmdb 不再写库当真相（series.name/tmdb_id 只在 agent 识别回填后写）
- [ ] **清空 parked_paths 表**（旧架构"机械识别搞不定才停车"的产物，新架构下每个文件都该由 agent 自己识别，不该继承"识别不出"的标签）

**Phase 3: auto research 打磨识别 skill**
- [ ] 建真实命名压力测试集（招z魂z4/H）后丨室/fansub/BT站/季包/中文季目录）
- [ ] 喂 agent 跑，看识别质量（对不对/佐证链/有没有乱 claim），迭代 skill 措辞

---

## 🧹 技术债（低优先级）

- [ ] 生产库识别错误评估：扫 NAS 看多少条目 title 是 "tv"/"movies"/分类目录/单字符垃圾（旧 bug 误识别的），需要重识别
- [ ] worker/（Cloudflare ASSRT 中继）孤儿组件，已标退役，可考虑删
- [ ] docs/product-shape.md 已加退役标记，docs/cloudflare-worker.md 已加退役标记

---

## 📝 备注

- **上下文快满了**：spec + plan 已写到 `docs/design/2026-07-26-subtitle-agent-identity-spec.md`，compact 后从 Phase 1 开始实施。
- **121 个 parked 文件**（谍战深海/重庆谍战/黑三角/莉可丽丝/铁拳教育等）：**清空 parked 行**，让它们重新走新 findSubtitleWorker 流程（机械识别再扫给 raw 数据，agent 自己识别）。这些行是旧架构"机械识别搞不定才停车"的产物，新架构下每个文件都该由 agent 自己识别，不该继承"识别不出"的标签。
- **rescue agent 的 two-evidence bar**：并进 findSubtitleSkill 的识别步骤（证据先行的核心逻辑）。

---

**下次更新**: Phase 1 完成后
