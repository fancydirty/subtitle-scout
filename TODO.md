# Subtitle Scout 待办事项

**更新日期**: 2026-07-25 (Ralph Loop 完成后)  
**快照日期**: 2026-07-25 03:30 AM（此后有 7 个新 commits，见 git log）

---

## ✅ 已完成（本次 Ralph Loop）

### Wave 3 审计验收
- [x] TranslateSection UI 测试（6/6 passed）
- [x] Workflow 页翻译观测性测试（109/109 passed）
- [x] CLI 库内/库外行为测试（库外正确拒绝）
- [x] 全量测试（1930/1931 passed）

### 架构债务清理
- [x] **C6**: 消除中文 tag 表重复（`c6b7500`）
- [x] **C5**: 验证 sidecar 写路径已统一（文档 `ea8cc5a`）
- [x] **C1-C3**: fetchLib/traceBus/triageOps 倒挂（Wave 2）
- [x] **C7**: 翻译双轨漂移（Wave 3-D，legacy 退役）
- [x] **C8**: gatherSeriesContext 重复（Wave 3-D）
- [x] **C9**: mappings 僵尸参数（刻意留痕，不处理）

### 代码质量检查
- [x] CSS 结构检查（1574 行，结构清晰，设计文档完备）
- [x] apiV2 评估（1245 行，纯数据层，无明显问题）
- [x] 未使用代码检查（TypeScript clean，无未使用导入）
- [x] 错误处理检查（合理使用 console.error，空 catch 块有意为之）

### 文档更新
- [x] Wave 3 完成报告（`2026-07-25-wave3-audit-completion.md`）
- [x] C5 sidecar 验证文档（`2026-07-25-C5-sidecar-write-paths-verification.md`）
- [x] 工作会话总结（`2026-07-25-session-work-summary.md`）
- [x] 添加 .opencode/ 到 gitignore

---

## 📊 代码库状态

**Git HEAD**: `859f6e4`  
**总 commits**: 10 个（Wave 0-3 + C6 + 文档）  
**测试状态**: 1930 passed / 1 skipped (1931 total)  
**TypeScript**: 无错误  
**构建**: 成功  

**净变化**（自 Wave 0 起）:
- Wave 0-3: -1346 行（删除 legacy 管道）
- C6: +6/-6 行（消除重复定义）
- 文档: +369 行（3 个设计文档）

---

## 🎯 下一步建议

### 立即可做
1. **部署到生产环境**
   - 检查 TRANSLATE_* 三件套配置
   - 重建容器让 deploy gate 就位
   - Settings 页打开 AI 翻译开关
   - 观察 Workflow 页翻译 trace

2. **生产监控**（可选）
   - LLM 调用数趋势
   - Held 队列积压
   - 翻译成功率

### Wave 4（如需要时）
- apiV2 拆分方案设计
- 术语表 UI 原型
- ⌘K 搜索需求澄清
- CSS 模块化（当前已足够好）

---

## 📝 架构债务完整清单

| 编号 | 描述 | 状态 | 备注 |
|------|------|------|------|
| C1 | fetchLib 住 cli 层 | ✅ 已解决 | Wave 2 移至 adapters |
| C2 | traceBus 住 dashboard | ✅ 已解决 | Wave 2 移至 core |
| C3 | claimParked 住 apiV2 | ✅ 已解决 | Wave 2 移至 triageOps |
| C4 | apiV2 平行 SQL 层 | ⏸️ 待设计 | 需架构级重构 |
| C5 | sidecar 三写路径 | ✅ 已统一 | 只有一个 writeSidecarAtomic |
| C6 | 中文 tag 表×5 | ✅ 已解决 | 导出 CHINESE_SIDECAR_TAGS |
| C7 | 翻译双轨漂移 | ✅ 已解决 | Wave 3-D legacy 退役 |
| C8 | gatherSeriesContext 重复 | ✅ 已解决 | Wave 3-D 随 legacy 删除 |
| C9 | mappings 僵尸参数 | ✅ 留痕 | 刻意保留，不处理 |

---

## 🚀 已交付功能

### Wave 3 主要功能
1. **Dashboard 翻译观测性**
   - LLM 调用数显示
   - Held 队列 badge
   - 决策短语显示
   - Trace 快照渲染

2. **TranslateSection 设置 UI**
   - 部署门三件套状态显示
   - 开关确认对话框（配额警告）
   - 休眠警示 Banner
   - Workflow 页链接

3. **Legacy 管道退役**
   - 删除 8 个文件（-1730 行）
   - workspace agent 成为唯一路径
   - 库外文件诚实拒绝

---

## 🎉 总结

**Ralph Loop 成果**:
- ✅ 完成 Wave 3 全部验收
- ✅ 清理 6 个架构矛盾（C1-C3, C6-C8）
- ✅ 验证代码质量（CSS/apiV2/未使用代码/错误处理）
- ✅ 更新 3 篇设计文档
- ✅ 所有测试通过，TypeScript clean

**代码库状态**: 健康，可随时部署  
**剩余工作**: 仅 C4（apiV2 平行层）需要架构级设计，属于 Wave 4 范畴  

---

**最后更新**: 2026-07-25 02:30 AM
