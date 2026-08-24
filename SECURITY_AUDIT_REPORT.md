# 敏感信息审计报告

**审计日期**: 2026-08-24  
**仓库**: subtitle-scout  
**审计范围**: 当前代码库 + Git 历史 + 配置文件 + 文档

---

## 1. 当前代码库（main 分支最新）

### ✅ 高危
**无高危问题**

### ⚠️ 中危

- [x] **.env 文件包含真实凭据** (已在 .gitignore)
  - 位置: `.env`
  - 内容: LLM API keys, TMDB token, ASSRT token, OpenSubtitles 密码等
  - 状态: ✅ 已在 `.gitignore` 第 12 行明确排除
  - 建议: **删除 `.env` 文件**，只保留 `.env.example` 模板

- [x] **docker-compose.bundle.yml 透传凭据环境变量**
  - 位置: `docker-compose.bundle.yml:51-92`
  - 问题: 从 `.env` 读取并透传所有凭据（LLM_API_KEY, ASSRT_TOKEN 等）
  - 状态: ⚠️ 旧版配置文件，但已在 2026-08-20 架构变更后标记为遗留
  - 说明: 主 `docker-compose.yml` 已移除凭据透传（见第 38-42 行注释），但 bundle/local/test 版本仍保留旧模式
  - 建议: 考虑在 bundle/local.yml 中也移除凭据透传，或在注释中明确标注"仅用于本地测试"

- [x] **.claude/settings.local.json 包含个人路径**
  - 位置: `.claude/settings.local.json:4`
  - 内容: `/Users/dirtyfancy/projects/subtitle-scout/web/src/i18n/en.ts`
  - 状态: ✅ 已在 `.gitignore` 第 37 行排除 `.claude/`
  - 建议: 确认该文件未被跟踪（应该已被忽略）

### ℹ️ 低危/假阳性

- [x] **代码中的 localhost / 127.0.0.1 引用** - 合法用途
  - `docker-compose.yml:26`, `docker-compose.local.yml:21`: 健康检查
  - `vite.config.ts:11`: 开发代理配置
  - 这些都是标准的本地开发配置，无需修改

- [x] **测试代码中的 password/token 字符串** - 假阳性
  - `web/src/lib/errorText.ts`: 错误提示文案
  - `web/src/i18n/en.ts`, `web/src/i18n/zh.ts`: i18n 标签
  - `web/src/api/client.ts`: API 客户端逻辑（不包含实际凭据）

---

## 2. Git 历史

### ✅ 已清理的 commit

**commit `ebb16fae` (2026-08-19)** 已执行过一次敏感信息清理：

删除了以下敏感内容：
- `docs/design/*` 中的内网 IP (`192.168.100.1`)
- `SETTINGS_VISUAL_MOCKUP.md` 中的 `xiaomimimo.com` 端点示例
- `docs/design/2026-08-08-CURRENT-STATE.md` 中的服务器信息和 LLM 端点配置
- `docs/design/2026-07-21-handoff-to-opencode.md` 中的直连 SSH 信息
- 大量内部设计文档、部署脚本、截图等

### ⚠️ 历史中仍可见的敏感信息

虽然文件已被删除，但 Git 历史中仍可追溯到以下信息：

#### 服务器信息
- **内网 IP**: `192.168.100.1` (软路由地址)
- **DNS**: `192.168.0.1` (宿主 dnsmasq)
- **文件路径**: `/mnt/nvme0n1-4` (生产存储路径)
- commit: `ebb16fae` 及之前的多个 commit

#### LLM 端点
- **xiaomimimo.com**: `https://token-plan-sgp.xiaomimimo.com/v1`
- **bothyouandme.com**: `https://new.bothyouandme.com/v1`
- 出现在已删除的设计文档和配置示例中
- commit: `ebb16fae` 及之前

#### 用户名
- **dirtyfancy**: Git author、文件路径中多次出现
- **OpenSubtitles 用户名**: 在已删除的设计文档示例中可见

### ⚠️ 当前历史中的风险点

1. **commit `ebb16fae` 的 diff 本身暴露了所有被删除的敏感信息**
   - 任何能访问仓库历史的人都能看到完整的删除内容
   - 包括内网 IP、端点 URL、服务器配置等

2. **`.env` 文件从未被提交** ✅
   - 搜索 Git 历史未发现 `.env` 文件的提交记录
   - API keys 和 tokens 未泄露到历史中

---

## 3. 配置安全

### ✅ 通过项

- [x] **.env 已在 .gitignore**
  - 位置: `.gitignore:12-14`
  - 配置: `.env`, `.env.*`, `!.env.example`
  
- [x] **存在 .env.example 模板**
  - 位置: `.env.example` (63 行)
  - 质量: ✅ 优秀 - 仅包含配置说明，无真实凭据，有详细注释

- [x] **docker-compose.yml 默认无密码**
  - 主 compose 文件不包含硬编码密码
  - 所有凭据通过环境变量或设置向导配置

### ⚠️ 需注意

- [ ] **docker-compose.bundle.yml 仍透传凭据**
  - 该文件从 `.env` 读取并透传 LLM/ASSRT/OpenSubtitles 等凭据
  - 虽然有明确注释说明其为"旧架构遗留"，但可能造成混淆

---

## 4. 文档安全

### ✅ 公开文档（README, CONTRIBUTING, SECURITY, LICENSE）
- 未发现个人路径、真实 IP、域名或用户名
- README 正确引导用户使用 `.env.example`
- SECURITY.md 提供了安全报告指南

### ⚠️ docs/ 目录
- `.gitignore:22` 将整个 `docs/*` 排除（仅保留一个公开文档）
- 因此私有设计文档不会被推送到公开仓库
- 当前状态: ✅ 安全（docs 已被 gitignore）

---

## 5. 建议

### 🔴 高优先级（开源前必做）

1. **删除 `.env` 文件**
   ```bash
   rm .env
   # 确认它已在 .gitignore 中，不会被重新跟踪
   ```

2. **确认 .gitignore 生效**
   ```bash
   git status --ignored
   # 确认 .env, docs/*, deploy/, cache-local/ 等敏感目录都被正确忽略
   ```

3. **考虑 Git 历史重写（可选，谨慎操作）**
   - 如果需要完全抹除历史中的敏感信息，考虑使用 `git filter-repo` 或 BFG Repo-Cleaner
   - ⚠️ 这会改变所有 commit hash，已克隆仓库的用户需要重新 clone
   - 权衡：当前敏感信息（内网 IP、内部端点）泄露风险相对较低，可能不值得重写历史

### 🟡 中优先级

4. **统一 docker-compose 文件的凭据策略**
   - 选项 A: 在 `docker-compose.bundle.yml` 和 `docker-compose.local.yml` 的顶部添加醒目注释：
     ```yaml
     # ⚠️ 仅用于本地开发测试，不要在生产环境使用
     # 凭据配置已迁移到 dashboard 设置向导（见 docker-compose.yml）
     ```
   - 选项 B: 移除 bundle/local/test.yml 中的凭据透传，完全对齐主 compose 的新架构

5. **创建开源准备清单**
   ```markdown
   ## 开源前检查清单
   - [ ] 删除 .env 文件
   - [ ] 确认 git status --ignored 输出正确
   - [ ] 搜索代码中是否还有 "dirtyfancy" 字符串（Git author 除外）
   - [ ] 检查 package.json 中的仓库 URL 和作者信息
   - [ ] 确认 LICENSE 文件中的版权信息
   - [ ] 准备 GitHub 仓库描述和 topics
   ```

### 🟢 低优先级

6. **考虑添加 pre-commit hook**
   - 防止意外提交 `.env` 文件或其他敏感文件
   - 可以使用 `detect-secrets` 或类似工具

7. **文档改进**
   - 在 CONTRIBUTING.md 中添加"不要提交真实凭据"的提醒
   - 在 README 中强调 `.env.example` 是唯一应该提交的配置模板

---

## 6. 总结

### ✅ 安全现状
- **核心代码和配置已基本安全**，无硬编码凭据
- `.gitignore` 配置完善，覆盖了所有敏感目录和文件
- `.env.example` 是优秀的模板，不含真实凭据
- 2026-08-19 已执行过一次内部文档清理

### ⚠️ 主要风险
1. **本地 `.env` 文件仍存在**（虽然在 .gitignore 中）
2. **Git 历史中可追溯到内网 IP 和内部端点**（已删除文件的 diff）
3. **docker-compose.bundle.yml 保留了旧的凭据透传模式**（可能造成混淆）

### 🎯 开源前最小操作
1. 删除 `.env`
2. 运行 `git status --ignored` 确认无遗漏
3. 确认 package.json 等元数据文件中无敏感信息
4. 推送到 GitHub 公开仓库

**风险评估**: 当前状态下，如果删除本地 `.env` 文件并确认 .gitignore 生效，仓库可以安全开源。Git 历史中的内网 IP 和内部端点属于低风险信息（不是密码或 token），可以接受。
