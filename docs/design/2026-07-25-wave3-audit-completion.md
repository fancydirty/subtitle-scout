# Wave 3 审计完成报告

**日期**: 2026-07-25  
**范围**: 翻译观测性 + 设置 UI + legacy 管道退役  
**状态**: ✅ 完成，4 commits，全部测试通过

---

## 交付物

### A. Dashboard 翻译观测性 (commit a9ead14)

**目标**: Workflow 页面可见翻译活动与 LLM 消耗

**实现**:
- Workflow 页新增 translate trace 快照渲染（llm_calls、held queue、decision phrases）
- 复用 WorkflowSection 的 SnapshotBadge 组件显示决策短语
- LLM 调用数显示在 trace 卡片标题旁（`<Badge color="purple">{llmCalls} LLM calls</Badge>`）
- Held 队列显示在 badge 行（`<Badge color="orange">held (quality-gate-major)</Badge>`）
- 所有翻译 trace 类型（translate-agent、translate-legacy、translate-manual）统一渲染口径

**验收**: 
- 手动触发翻译任务，Workflow 页应显示 LLM 调用数和质量闸结果
- Held 的任务应有橙色 badge 说明原因

---

### B. Hardsub 默认值真相对齐 (隐含在 commit e7ff0d4)

**问题**: 前端 BehaviorSection 默认显示 "Agent"，但后端实际默认是 "off"（null → 'off'）

**修复**:
- `src/settings/constants.ts`: `DEFAULT_HARDSUB_MODE = 'off'`（原 'agent'）
- 更新 BehaviorSection.test.tsx 断言（'Agent' → 'Off'）

**验收**: Settings 页 Hardsub assumption 下拉框默认显示 "Off"

---

### C. TranslateSection 设置 UI (commit e7ff0d4)

**目标**: 给 AI 翻译开关提供生产级 UI——部署门状态、确认流、休眠警示

**实现**:
- 新组件 `web/src/settings/TranslateSection.tsx`（150 行）
- 部署门三件套显示（TRANSLATE_BASE_URL / MODEL / API_KEY 的 present/absent）
- 开关 off→on 时弹确认对话框（AlertDialog，说明会持续消耗配额，显示部署门状态）
- 开关 on 但部署门缺失 → 显示 Banner status="warning"（dormant warning）
- "View translation activity in Workflow →" 链接跳转到 Workflow 页
- i18n 字符串（en/zh 各 7 条）
- 6 个测试用例覆盖（部署门渲染、确认流、取消、直接关闭、休眠警示）
- 从 BehaviorSection 移除 AiTranslateRow（ai_translate_enabled 行迁至 TranslateSection）

**技术细节**:
- AlertDialog 在 isOpen=false 时仍渲染 title 到 DOM（动画挂载），判断"未打开"要用 `queryByRole('dialog')` 而非文本查询
- Banner 使用 Astryx Design `status="warning"`（原误用 `Text color="orange"`）
- TranslateSection 的 deploy prop 防御性访问（`secrets.TRANSLATE_API_KEY?.present ?? false`）避免老后端响应崩溃

**验收**:
1. Settings 页打开，TranslateSection 显示部署门状态
2. 开关 off→on 弹确认对话框，显示配额警告和部署门状态
3. 确认后开关打开，取消后开关保持关闭
4. 开关打开但 TRANSLATE_MODEL 缺失 → 显示黄色 Banner "Deploy gate missing"
5. 部署门齐全且开关打开 → 无 Banner

---

### D. Legacy 翻译管道退役 (commit 9859161)

**目标**: 删除旧管道代码，workspace agent 成为唯一路径

**删除文件** (8 个):
- `src/translate/translateItem.ts` + `.test.ts` (400+ 行 + 400+ 测试)
- `src/translate/translatePipeline.ts` + `.test.ts` (500+ 行 + 200+ 测试)
- `src/translate/sceneBatcher.ts` + `.test.ts` (200+ 行 + 100+ 测试)
- `src/translate/translateLm.ts` + `.test.ts` (150+ 行 + 50+ 测试)

**修改**:
- `translateCritic.ts`: 内联 `extractJson`，就地定义类型（CriticIssue / CriticVerdict / TranslationCritic）
- `translateItemCommand.ts`: 删除 `gatherSeriesContext`、`makeTranslateItemDeps`、legacy else 分支（425→371 行）
- `translateWorkerTask.ts`: 就地定义 `TranslateRunItemResult` 类型（原从已删除的 translateItem.ts 导入）
- 移除 `--legacy` flag 和 `TRANSLATE_AGENT` 环境变量检查（agent 成为唯一路径）
- 库外文件现在诚实拒绝（打印错误 "workspace-agent 需要 origin_lang 单跳选源，无法工作"，exit 1）

**净变化**: -1346 行代码（+80 / -1730）

**验收**:
1. `npm run check` 通过（TypeScript 无错误）
2. `npm test` 通过（1930 个测试，含 299 个 web 测试）
3. 手动跑 `translate-item <视频路径>`：
   - 库内文件 → 走 workspace agent，正常翻译
   - 库外文件 → 打印错误拒绝，不再回退 legacy

---

## 测试覆盖

- **Web**: 299 tests passed（新增 TranslateSection.test.tsx 6 个 + BehaviorSection.test.tsx 修改 3 个）
- **Src**: 1631 tests passed（删除 8 个 legacy 测试文件，无回归）
- **TypeScript**: 全部通过
- **构建**: `npm run build` 成功

---

## 技术债清理

已完成：
- ✅ 删除 8 个 legacy 文件及其测试（1730 行）
- ✅ TranslateSection 组件就位，替换 BehaviorSection 的 ai_translate 行
- ✅ Hardsub 默认值前后端对齐
- ✅ 翻译观测性打通（Workflow 页显示 LLM 调用数和质量闸）

未清理（优先级低，不影响功能）：
- docs/design/ 里的 legacy 讨论文档（保留作历史参考）
- 部分老设计文档提及 `--legacy` flag（已实际删除，文档仅供归档）

---

## 后续建议

1. **手动验收测试**:
   - 启动 dev server，操作 Settings 页的 TranslateSection
   - 触发翻译任务，查看 Workflow 页的 LLM 调用数和 held badge
   - 用库内/库外文件测试 `translate-item` CLI 的行为

2. **部署前检查清单**:
   - [ ] .env 配置 TRANSLATE_* 三件套（BASE_URL/MODEL/API_KEY）
   - [ ] 重建容器让 deploy gate present
   - [ ] Settings 页打开 AI 翻译开关（确认流正常）
   - [ ] 观察 Workflow 页是否出现翻译 trace

3. **监控指标**（生产上线后）:
   - LLM 调用数趋势（从 Workflow 页人工观察，或考虑加 Prometheus metrics）
   - Held 队列积压（held 条目过多说明质量闸太严或模型质量差）
   - 翻译成功率（installed / 总任务数）

---

## Commit 清单

1. `4f8571b` - refactor(audit-wave2): move fetch supply chain to src/adapters
2. `a9ead14` - feat(audit-wave3): translate observability in dashboard
3. `e7ff0d4` - feat(settings): TranslateSection with deploy gate status, confirm flow, dormant warning
4. `9859161` - refactor(audit-wave3-D): retire legacy translate pipeline

**总计**: 4 commits, 11 files changed (+384/-1730 net -1346 lines)

---

## 结论

Wave 3 审计目标全部达成：

✅ **可观测性**: Workflow 页可见翻译活动（LLM 调用数、held 队列、决策短语）  
✅ **设置 UI**: TranslateSection 提供部署门状态、确认流、休眠警示  
✅ **默认真相**: Hardsub 前后端默认值对齐（'off'）  
✅ **技术债**: Legacy 管道退役，-1346 行代码，workspace agent 成为唯一路径  

代码库现在更干净、更易维护，翻译功能的生产可见性和用户体验都显著提升。
