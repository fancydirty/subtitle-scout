# Subtitle Scout 待办事项

**更新日期**: 2026-07-25

---

## 🔥 高优先级

### 1. Wave 3 手动验收测试
**负责人**: @dirtyfancy  
**预计时间**: 30 分钟

- [ ] 启动 dev server (`npm run dev` in web/, `npm run watch` in src/)
- [ ] 打开 Settings 页，检查 TranslateSection：
  - [ ] 部署门三件套显示正确（present/absent）
  - [ ] off→on 弹确认对话框，显示配额警告
  - [ ] 确认后开关打开，取消后保持关闭
  - [ ] 开关打开但部署门缺失 → 黄色 Banner "Deploy gate missing"
- [ ] 触发翻译任务，查看 Workflow 页：
  - [ ] Trace 卡片显示 LLM 调用数（紫色 badge）
  - [ ] Held 的任务显示橙色 badge 和原因
- [ ] CLI 测试：
  - [ ] `translate-item <库内视频>` → 走 workspace agent，正常翻译
  - [ ] `translate-item <库外视频>` → 打印错误拒绝，exit 1

**完成标准**: 所有勾选项通过，无明显 bug

---

### 2. Wave 3 代码推送
**负责人**: @dirtyfancy  
**预计时间**: 5 分钟

- [ ] 确认 4 个 commit 质量（已完成 Wave 3 验收）
- [ ] `git push origin main`
- [ ] 检查 CI/CD 是否通过（如果有）

**依赖**: 完成 #1 手动验收

---

## 📋 中优先级

### 3. 部署前准备（生产环境）
**负责人**: @dirtyfancy  
**预计时间**: 15 分钟

- [ ] 检查 .env 配置：
  - [ ] TRANSLATE_BASE_URL（例如 `https://api.openai.com/v1`）
  - [ ] TRANSLATE_MODEL（例如 `gpt-4o`）
  - [ ] TRANSLATE_API_KEY（有效的 API key）
  - [ ] TRANSLATE_CRITIC=on（可选，建议开启）
- [ ] 重建容器让 deploy gate 就位
- [ ] 登录 dashboard，Settings 页打开 AI 翻译开关
- [ ] 观察 Workflow 页是否开始出现 translate trace

**依赖**: 完成 #2 代码推送

---

### 4. 监控指标设计（生产上线后）
**负责人**: TBD  
**预计时间**: 2-4 小时

考虑添加以下 Prometheus metrics 或日志监控：

- [ ] `translate_llm_calls_total` - LLM 总调用数（按 job_id/status 分组）
- [ ] `translate_held_queue_size` - Held 队列积压数
- [ ] `translate_success_rate` - 翻译成功率（installed / 总任务数）
- [ ] `translate_duration_seconds` - 翻译任务耗时分布（P50/P95/P99）
- [ ] `translate_llm_token_usage` - Token 消耗（如果 LLM 返回 usage）

**优先级**: 低（先用 Workflow 页人工观察，如果需求明确再加）

---

## 🧹 技术债（低优先级）

### 5. 文档清理
**负责人**: TBD  
**预计时间**: 30 分钟

- [ ] 检查 docs/design/ 中提及 `--legacy` flag 的文档，添加"已退役"注释
- [ ] 更新 CHANGELOG（如果维护的话），记录 Wave 3 变更
- [ ] 考虑写一篇 "Translate Workspace Agent 迁移指南"（面向用户/运维）

**优先级**: 最低（现有文档已够用，旧设计文档保留作历史参考）

---

### 6. 代码优化建议（可选）
**负责人**: TBD  
**预计时间**: 不定

- [ ] TranslateSection 的确认对话框文案可考虑 A/B 测试（当前偏技术性）
- [ ] Workflow 页的 trace 快照可考虑折叠长 decision phrase（超过 3 行时）
- [ ] 质量闸 held 原因可考虑增加"重试建议"文案（例如 "尝试换更强的模型"）
- [ ] GlossaryRepo 可考虑加 `countByRoot` 方法（CLI 当前只是 try-catch 初始化）

**优先级**: 极低（当前实现已满足需求）

---

## ✅ 已完成

- [x] Wave 3 审计全部交付（4 commits）
  - [x] A. Dashboard 翻译观测性
  - [x] B. Hardsub 默认值对齐
  - [x] C. TranslateSection 设置 UI
  - [x] D. Legacy 管道退役
- [x] 所有测试通过（1930 tests, TypeScript clean）
- [x] Wave 3 完成报告 (`docs/design/2026-07-25-wave3-audit-completion.md`)

---

## 📝 备注

- **Wave 4 规划**: 暂无明确计划，等 Wave 3 部署验证后再决定
- **已知问题**: 无（Wave 3 scope 内）
- **风险**: TranslateSection 的部署门逻辑依赖后端 `/api/v2/settings/deploy` 接口，如果后端版本过老（缺少 TRANSLATE_* 字段），前端会显示 "absent"（符合预期，不算 bug）

---

**下次更新**: 完成 #1 手动验收测试后
