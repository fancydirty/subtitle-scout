# 实施计划：en-target 判定链修复 + 匹配哲学重构（2026-08-18）

Spec: docs/superpowers/specs/2026-08-18-en-target-judgechain-and-match-philosophy-design.md

纪律：每个任务先写 RED 测试（跑出红）→ 实施 → GREEN → 全量回归。提交按一任务一分支。

## Wave 1（并行）

### T1 判需 isLang + 翻译队列卫生 + 洗库迁移
文件：
- src/v2/subtitleJudge.ts（规则 2 改 isLang）
- src/v2/subtitleJudge.test.ts（RED：embedded ['jpn','eng'] × target ['en'] → needs=false 'embedded'；回归：['zh-Hans'] × ['zh'] 仍 false；['jpn'] × ['en'] 仍 true）
- src/v2/translateWorkerTask.ts（TRANSLATE_QUEUE_WHERE 加 `AND f.needs_subtitle = 1`，注释：needs=0 比停牌态更真理 / DxD 僵尸卡片案）
- src/v2/translateWorkerTask.test.ts（RED：needs=0 的 handoff 行 daemon 与 includeBackoff 两口径都不取；needs=1 照取）
- src/v2/db.ts（MIGRATIONS 追加：`UPDATE files SET needs_subtitle = NULL, skip_reason = NULL`，注释引 spec §4.2b：judge 判据修正后的全量重判通路，照 retarget 先例）
- src/v2/db.test.ts（迁移后全行 needs IS NULL；不碰 sub_status）

### T3 解析器四修 + PARSER_VERSION 2
文件：
- src/recognition/parseFilename.ts：
  - R3：seasonnumber 前加 `(?<!\d)`、epnumber 后加 `(?!\d)`
  - R1：epnumber 后加 `(?:v\d{1,2})?`（多集组之前）
  - R5：epnumber 后加 `(?:v\d{1,2})?`
  - 全规则 episode/absoluteEpisode === 0 → 视同失配（集号从 1 起）
  - R8：分隔符加前置数字闸 `(?<!\d)[\s._-]`（5.1/2.0 小数尾拒收）
- src/v2/scanner.ts：PARSER_VERSION = 2（注释：v2 = WxH 边界 / vN 后缀 / 0 集 / 小数声道四修，Overflow s80e720 实案）
- src/recognition/parseFilename.test.ts：固化对抗语料（spec §5 表）：
  - 生产实案：Overflow → abs 1..8（不是 s80e720）；Nukitashi `S01E04v2` → s1e4（不是 e0）；芬芳 `S01E05v3` → s1e5；Hi10 `.v2` 点分隔 → 保持正常；`DDP5.1.Atmos` → 无季集
  - 合成：`1280x720`/`1920x1080`/`3840x2160` 不产季集；`AAC2.0`/`2.0` 不产集；多集 E05E06 取 5 不回退；`E05v3` R5 路径
  - 已知边界锁现状（P4 不修）：`第一季 第05話` → abs=5 无季；`E7` 单位数 → null
- 验证：npx tsx 重跑 /tmp 语料脚本对照

## Wave 2（串行，与 T1 同域避免冲突）

### T2 翻译 worker 目标语言化
文件：
- src/agent/translateWorker.tools.ts（already-covered 两检查改目标语言：embedded 用 isLang(l, task.targetLanguage)；sidecar 用 deps.readExistingSidecar(videoPath, tags)）
- src/agent/translateWorker.ts（deps 形状更新 + 透传）
- src/cli/translateItemCommand.ts（readExistingChineseSidecar → readExistingSidecar，tags = tagsForLanguage(target)；手动 CLI 从 settings 取 target）
- src/cli/index.ts（daemon 接线传 targetLanguage）
- workspace task 类型加 targetLanguage（找到 TranslateWorkspaceTask 定义处）
- 测试（RED）：en 目标 + zh sidecar → 不短路继续找源；en 目标 + en sidecar → already-covered；zh 目标回归不变

## Wave 3（需本地 LLM env，dry-run TDD）

### T4 skill 重构（identity-first）
- 先跑现状 RED：在 src/agent/dryRun.test.ts 追加 SC-A/SC-B/SC-C（跨压制组/年份±1/版本后缀 → 必须 install）与 SC-D/SC-E 回归闸，对当前 skill 跑出 SC-A/B/C 红
- 改 src/agent/skills/findSubtitleSkill.ts 的 one rule 段（spec §4.5）：身份=作品+季+集+结构验证；release 名降为注释性证据；vN=重定时；no_safe_match 收窄
- GREEN：SC-A/B/C 绿 + 既有 S1–S8 全绿（放宽不破安全）
- 提交含 RED→GREEN 的场景代码与（若日志大）输出摘要

## Wave 4

### T5 验收 + 部署
- npm test 全量（root + web）
- npm run check
- 部署 deploy/deploy.sh（推送→CI→软路由）
- 软路由验收：boot 后 judge 重判（DxD 行 needs→0、僵尸卡消失）、重解析（Overflow s1e1-8）、下一轮巡检不再对内嵌 eng 行派工

## 分支
fix/judge-embedded-islang（T1）/ fix/parser-v2-guards（T3）/ fix/translate-target-lang（T2）/ fix/skill-identity-first（T4），逐一 no-ff 合入 main。
