# Spec C — 四屏重建：AI Elements 栈落地 + Astryx 退役

日期：2026-08-02 ｜ 状态：已裁决待实现 ｜ 上游：草稿 6（`.superpowers/brainstorm/69834-1785560038/content/draft-6.html`，四轮内部审计过的行为蓝本）+ 栈拍板（见 §3）+ Spec A §5.4/§5.5（Settings 改造与 hero 发动机开关的数据侧，本 spec 接视觉侧）

## 1. 背景与设计模型

本项目前端的定位（用户原话压缩）：**观测台，不是控制台**——可操作面只有三处（bootstrap、点火开关、极少数一键决策），其余全是读。草稿 6 把这一定位落成四屏具体设计，并且用六条铁律管住了自己（§3）。本 spec 的工作不是再设计，而是**把草稿 6 转成可施工契约**：每个界面元素钉死后端出处或显式标"新拟"，每条行为不变量钉死代码锚点，每个迁移步骤钉死验收标准。

现状差距（全部经代码核实）：

- 视觉栈是 @astryxdesign/core，已拍板整体退役换 **Tailwind v4 + shadcn/ui + Vercel AI Elements（copy-in）**；
- 活动页行为本身已是蓝本级（态A/态B 互斥、传送带、阶段条、卡死零入口），**行为不动，只换视觉实现与组件底座**；
- Triage 想加的两个新区（timing 列表、dormant 列表）**数据层有、HTTP 端点缺**——需补两个只读 GET，零写路径、零状态机改动（§4）；
- Library 详情、Settings 的结构与文案基本正确，随栈迁移换新视觉，结构不动。

**草稿 6 明确不覆盖的三条实时不变量，本 spec 从代码侧取证补齐**（§6）：SSE 管道细节、15s 轮询、秒表锚点。这三条是重建期最容易写漂的地方。

## 2. 范围

**In：** 四屏重建（Activity / Library detail / Triage / Settings）+ 全局壳（侧栏、顶栏）；AI Elements 选定组件 copy-in + 自绘件 token 化；两个只读 GET（shifted 列表、dormant 列表）；Astryx 五步退役迁移；组件测试随迁。

**Out：** Bootstrap wizard（Spec A）；movies index/detail、母语媒体开关、波形 peaks 端点（Spec B）；任何新写路径（除 §3 决策 1 明确的"不新增"外，correct/revert/unexclude 均为既有端点接线）；对话式 AI 组件（assistant-ui 等，无对话场景）；独立 UI 语言切换器（既定铁律：i18n 联动 target_languages，不由本 spec 碰）；空态新视觉稿（沿用规格承诺三句文案，栈随迁）。

## 3. 已裁决决策清单（spec 的硬约束）

**栈裁决（用户 2026-08-01 拍板，记忆 `frontend-redesign-stack-2026-08`）：** Tailwind v4 + shadcn/ui + Vercel AI Elements（copy-in，不进包管理器）；@astryxdesign/core 整体退役；**新屏先落地、逐屏迁移、Astryx 最后卸载**（§7 五步）。

**草稿 6 六条自律铁律（全部继承为本 spec 硬约束）：**

1. 红色只给卡死事实层：红点 + 唯一红字事实句；卡片底色/边框/banner 一律不红；
2. UI 不展示任何毫秒数/内部分数——`offset_ms`/`score`/`reference_tier`/`detail` 在 API 层就被剥掉（`src/dashboard/subtitleVerifyApi.ts:8` 文件头、`:68` 显式三键序列化），前端想犯错都拿不到字段；
3. 英文文案逐字抄自真实字符串表（`web/src/activity/text.ts`、`web/src/workflow/phrases.ts`、`web/src/i18n/en.ts`）；无处可抄的显式标"新拟"，集中登记（§5.7），审计可逐条砍；
4. 收件箱式页面（Triage）只写已发生的事实 + 用户该做的动作，**零预告**系统行为；
5. 行为蓝本逐字节对齐现网：分区互斥、每句文案、每个按钮的有无，全照 ActivityPage/ActivityHero/ActivityStuck/text.ts 现状；视觉换新不等于行为重设计；
6. 行内数据全是示意样本；设计承诺是分区、字段、按钮有无与出处表，不是示例数字。

**本 spec 新增三条裁决（用户休息期间授权主控按推荐拍板，记忆 `autopilot-pipeline-acb-2026-08`）：**

1. **Dormant 唤醒通道：不补，保持只读。** 理由：本 spec 的后端纪律是"零写路径、零状态机改动"；dormant 的复入口径本就是 realign-gated 自动重入（`src/v2/jobsRepo.ts:469-477`），而 `jobsRepo.ts:110` 原因串里"修复后手动唤醒"承诺的通道（`:440` 无 wake 实现）属于产品缺口，补它是新写路径 + 状态机新边，超出"换视觉"范畴，真要做应单独立项。UI 因此零按钮（草稿 6 §屏3 保真点原样成立）。
2. **卡死 hero 冻结阶段条：不接线，维持 `stageAtFailure` 恒 null、整条不渲染。** 现网行为即如此（`web/src/activity/ActivityPage.tsx:87` 赋值 null，`:76` 注释说明依据：held 记录没有 trail，无据可画）；且 `ActivityStuck.test.tsx:184` 已把"null → 不渲染"锁成回归用例（空条读作 0%=清零、扫动条谎称在干活，两个错误方向都被论证排除）。接线 = 编造一个后端拿不出的数字，违背铁律"零编造"。组件保留支持非 null 的渲染分支（未来若有真实数据源可接），本 spec 不产该数据源。
3. **Triage 第三区（Timing looks off）与 Library 详情的偏移行并存，不互斥。** Triage 是全局收件箱（跨系列列表），Library 详情是单系列上下文，两者读同一个 GET（§4.1），语义一致、各得其所。

**跨 spec 绑定点（来自 Spec A，本 spec 接视觉侧）：**

- Activity hero 要承载**发动机总开关**（Spec A §5.5：数据侧 `engineEnabled` 在 settings GET/PUT 已就绪；本 spec 定它的视觉落点，§5.3）；
- Settings 要承载 Spec A §5.4 的 Providers 区与 System 区 "Re-run setup wizard"（本 spec 只规定它们随屏迁移后的结构位置，交互契约以 Spec A 为准）；
- 引擎关闭 banner（Spec A §5.6）渲染在所有主屏顶部，视觉归本 spec §5.8 全局壳。

## 4. 后端设计：两个只读 GET

纪律：**零写路径、零状态机改动、零 schema 迁移。** 两个端点都挂现有 admin 鉴权后，都是 repo 已有查询的 HTTP 薄壳。

### 4.1 GET /api/v2/subtitle/shifted

- 数据源：`src/v2/subtitleVerifyRepo.ts:95` `listShifted()`（`verdict='shifted' ORDER BY checked_at DESC`；`src/v2/db.ts:145` 已有 verdict 索引，无需新索引）；
- DTO 每行：`{ itemId, seriesId, seriesName, season, episode, checkedAt, hasPriorCorrection }`：
  - 系列名/季集号走 library 既有 join（series 表）；
  - **`offset_ms`/`score`/`reference_tier`/`detail` 绝不进 DTO**（铁律②；序列化仿 `subtitleVerifyApi.ts:68` 显式列键，禁止 spread）；
  - `hasPriorCorrection` = 该 item 是否存在可还原的校正备份（驱动前端 Undo 按钮的置灰——草稿 6 L363 第三行 Undo 置灰的数据依据；**推导源 = revert 自己的前置门**：备份文件存在性 `exists(subtitle_path + backupSuffix)`，`src/dashboard/subtitleVerifyApi.ts` revertSubtitle 内"有备份可还原"是放行撤销的唯一前置；代码库**不存在** correction 记录表，不要去 invent 一张；实现期照此口径核实，不新增列、不碰写路径）；
- 空库返回 `[]`，不 404。

### 4.2 GET /api/v2/workflow/dormant

- 数据源：jobs 表 `state='dormant'`（`src/v2/jobsRepo.ts:23` 状态枚举、`:106` `REAP_PARK_THRESHOLD = 5`）；
- DTO 每行：`{ jobId, task, targetLabel, attempts }`（四键封闭）：
  - `task` = 裸工具名（如 `find_subtitle`），前端按既有惯例 mono 弱显（草稿 6 L367-377）；
  - `targetLabel` 由后端组好（"The Rig, Season 2" 粒度），前端不拼；
  - **`reason` 内部原因串不透传**——现网该串为中文（`jobsRepo.ts:110`），且含内部措辞；英文句子 "Failed 5 times, automatic retries stopped." 由前端用 `attempts` 组（登记为新拟文案，§5.7）；
  - **不带任何时刻字段**：草稿 6 dormant 行不渲染时刻，DTO 保持最小封闭（jobs 表无 `last_error_at` 列；`updated_at` 虽冻结于 park 时刻可推导，但无 UI 消费方不进 DTO——R1 审计裁决）；
- 空库返回 `[]`。

### 4.3 既有端点接线（零改动，仅登记）

Triage 两桶沿用既有 parked 端点；Restore = `POST /api/v2/triage/unexclude`（`src/dashboard/server.ts:426-449` POST-only，`src/v2/triageOps.ts:30-32` 拒绝 excluded-extra 以外的 reason——这个拒绝语义**保留**，前端只给 excluded 行画 Restore）；Fix the timing = `POST /api/v2/subtitle/correct`（`web/src/library/SeasonAccordion.tsx:60` 既有活调用）；Undo = `POST /api/v2/subtitle/revert`（`web/src/api/client.ts:147` wrapper 已存在、现零调用方，本 spec 首次接线）。

## 5. 前端设计

### 5.1 栈与 token 架构

- **Tailwind v4**（Vite 插件接入，无 postcss.config 旧式挂法）+ **shadcn/ui**（copy-in 通用件：Button/Input/Switch/Select/Card/Accordion）+ **AI Elements copy-in**（只装 §5.2 清单内的四个）；
- 暗色 token → shadcn CSS 变量映射表（写死，实现期照表落 `--background` 等）：

| 语义 | 值 | 用途 |
|---|---|---|
| `--background` | `#0b0c0f` | 页面底 |
| `--card` | `#111318` | 卡片底 |
| `--accent`（面） | `#16181f` | hover/活跃面 |
| `--border` | `rgba(255,255,255,0.07)` | 卡边框（次级分隔 0.05） |
| `--foreground` | `#e6e8ec` | 主文本 |
| `--muted-foreground` | `#9aa1ac` | 次文本 |
| 弱文本 | `#6b7280` | 传送带旧行、辅助行 |
| 最弱文本 | `#4b5563` | missing 点、最弱辅助 |
| 功能紫 | `#8b7cf6` | hero 脉动点（1.6s） |
| 功能红 | `#e11d48` | 卡死点/事实句（**仅此两处用红**） |
| 功能绿 | `#28bf5c` | covered 点/完成行 |
| 侧栏激活 | `#a3e635`（lime） | 侧栏当前项字色 |

- 圆角：卡 12px / 钮与导航 8px / chip 999px；字体栈 `-apple-system,"Helvetica Neue",sans-serif`，mono `ui-monospace,SFMono-Regular,Menlo`；
- 写死的度量：hero 海报 132px 2:3（电影 160px）；行海报 38px 2:3（**测试锁**）；阶段条高 3px、轨道 `rgba(255,255,255,0.09)`、填充 `#9aa1ac`（styles.css:1514-1528 逐行核实值随迁）；红点/紫点 6px；ep-dot 5px。

### 5.2 AI Elements 装 / 不装清单

| 界面块 | 实现 |
|---|---|
| hero 出血美术 / 传送带 / 阶段条 / ep-dot 集格 | **自绘（token 化）**——蓝本件，两个轮子库都没有对应物 |
| 传送带在跑行 / 加载态微光 | AI Elements **shimmer**（替换"最亮行"的静态高亮，声明式换法，见 §5.3） |
| Up next / Just finished 列表 | AI Elements **queue**（分区列表 + 完成标记 + 动作位，plain props 喂 DTO） |
| Triage 分区卡 | AI Elements **task**（可折叠）+ shadcn 通用行 |
| RunDetail 痕迹回放（"View" 下钻） | AI Elements **tool**（工具调用卡：名称/入参/结果/错误位，喂 TraceEvent） |
| Settings 表单 | shadcn switch/input/select |
| **不装** | conversation / message / prompt-input / suggestion / confirmation / reasoning / plan / persona / voice 全家 / web-preview / canvas / artifact / open-in-chat / code-block / terminal——无对话场景、无 LLM 文本流、无重依赖场景 |

### 5.3 屏 1 · Activity（重建，行为蓝本逐字节对齐）

**两态互斥**（`web/src/activity/ActivityPage.tsx:110-112` 现状）：有 held → 整页只剩卡死区；否则常态（在跑 hero + Up next + Just finished；三者皆无 → 空态）。

**态 A · 卡死（ActivityStuck 替换整页）：**

- 每卡：132px 海报 → 标题（16px/600）→ 红点 6px `#e11d48`（**不动画**）+ 红字 13px `"hit a problem — will retry"`（整页唯一红字，`.act-stuck-fact` styles.css:1723-1725）→ 弱色 mono 重试行（`formatRetryIn`，`web/src/activity/text.ts:290`：≥24h 滚成天，退避阶梯 +1d/+3d/+7d，`nextRetryAt` 非空才出现，如 "retries in 1d" / "retrying shortly"）；
- **零按钮、零展开、零下钻；reason 自由文本不透传**；冻结阶段条不渲染（§3 决策 2）；
- 多卡并列按现网排序（不新增排序规则）。

**态 B · 常态：**

- **在跑 hero**：出血背景（电影走模糊海报降级）→ 132px 海报 → 标题 → 紫点 `#8b7cf6` 6px 1.6s 脉动 + 副标题动词族（`heroSubtitle` 逐字，如 "Looking for subtitles for every season with gaps"）→ 传送带 3 行（逐步骤短语 = `workflow/phrases.ts` `TOOL_PHRASES.en`，键 = 真实工具注册表，`dispatch_*` → "Planning work"，未登记 → mono 裸名兜底；最新行在底部把旧行往上顶；亮度三档 灰`#6b7280`→中`#9aa1ac`→**新行换 AI Elements shimmer**——这是"最亮"线索的声明式替换；`role="log"` 随栈迁移保留）→ 阶段条 3px（条宽 = 工具序列深度，`web/src/activity/stage.ts` `STAGE_START=6`，无数字、`aria-hidden`）→ 底部双 fact：左 `"Running for 2m 14s"`（`formatElapsed`，**永无 ETA**）、右 `"5 episodes missing subtitles"`（`missingLine`），两 fact 同色弱灰；
- **hero 上的发动机开关**（Spec A §5.5 绑定点）：hero 右上区一个 shadcn Switch + 状态词（on = 引擎在跑 / off = 暂停态文案走 Spec A §5.6 banner 同义），操作 `engineEnabled` 同一键；**无 held、无在跑时 hero 不渲染，开关随之不出现**——此时开关只在 Settings Behavior（这是有意取舍：hero 是"发动机在干活"的舞台，引擎关停时的控制面归 Settings，避免空舞台挂开关的视觉矛盾）；
- **Up next (N)**（AI Elements queue）：行 = 38px 海报 + `"名 · Season N"` + 副行 `"N episodes missing subtitles"` + 右端灰 `"queued"`（`queueHeading/queuedLabel`；电影行副行 = `"missing subtitles"`，`movieMissingLine`）；
- **Just finished (N)**（AI Elements queue）：行 = 38px 海报 + 标题 + 圆点三档（绿 `"subtitles installed"` / 红 `"no safe match found"` / 灰——`phrases.ts DECISION_TEXTS.en` + `DECISION_TONES`，**没有黄**）+ `"2m ago"`（`relativeFinished`）+ `"View"` 按钮（`openLabel`，下钻 RunDetail，AI Elements tool 卡回放 TraceEvent）；
- **空态**（未画稿，规格承诺）：`"No subtitles in progress"` + `"Last checked 3m ago"`（`lastScanAt=null` → `"Not scanned yet"`，**绝不编时刻**）+ `"12 / 282 checked"` + 内嵌 Just finished 列表（`ActivityEmpty.tsx:108` 现状结构随迁）。

### 5.4 屏 2 · Library detail（栈随迁，结构不动）

- hero：132px 海报 → 标题 20px → meta `originalName · year`（`SeriesHero.tsx:36` 真实格式；**DTO 无 genre，不画流派**）→ 摘要行 `"2 seasons · 16 episodes"`（**新拟**，前端由 seasons 数组组，零后端改动）→ 简介整段（无折叠、无返回键——tab 路由现状）→ mono `"covered 14 / 16"`（`en.ts:101` FactsRail 格式）；
- 季手风琴（shadcn Accordion 换皮）：区头 = `seasonCoverageSentence` 真实句式（`web/src/library/text.ts:21-23`，如 "Season 2 has 6 of 8 episodes covered"）→ ep-dot 集格（**真实域六变体** covered/hardsub/partial/missing/throttled/error，styles.css:310-338 值随迁；dashed 边框空格 = canonical 有而磁盘无）→ 偏移行：红点 + `"E03 · timing looks off"`（`en.ts:68`）+ `"checked 2h ago"`（**新拟**句子格式，`checked_at` 真实字段）+ `"Fix the timing"`（`en.ts:93`，接既有 correct）+ `"Undo"`（**新拟**措辞，接 revert wrapper；无在先校正记录时置灰，§4.1 `hasPriorCorrection`）；
- **偏移不是 ep-dot 变体**：E03 集格保持 covered 绿点、仍计入覆盖数；红只在行级（aligned 与 unverifiable 皆绿、仅 shifted 红是仓库刻意裁决）；偏移行**零毫秒数**（铁律②）；
- 缺集只显状态、**不给按钮**（无逐条获取端点，kill-list #1）。

### 5.5 屏 3 · Triage（升级成唯一收件箱，四区，全页零预告）

- 页头：h1 `"Triage"` + 副标题 `"Items the system parked instead of guessing. Nothing here blocks automatic work."`（**新拟**，登记）；
- **Pending**（`en.ts:160` 逐字）：按目录分组（`web/src/triage/text.ts groupPending` 两桶蓝本：excluded-extra vs 其余一切）——组头 mono 目录名 + `"8 files"` + 首末行 `"First seen 3d ago, last attempt 2h ago."`（**新拟**句子格式，`firstSeen`/`lastAttempt` 是 ParkedItemDTO 真实字段）→ 文件行 mono 文件名 → >5 折叠 `"+6 more"`（折叠阈 = `FILES_COLLAPSE_AT=5`，PendingBox 既有常量）→ 命名指引 `"Correct naming skips manual triage — best practice: Title (Year)/Season NN/Title SNNENN.mkv"`（前缀 = `en.ts:170` 逐字；路径样例 = `web/src/triage/PendingBox.tsx:21` `NAMING_PATTERN` 常量——两处合起来才是整句，R1 审计补引）；
- **Excluded extras**：行 = mono 路径 + `"Restore"`（接 unexclude，仅本桶可见，§4.3）；
- **Timing looks off · N**（区标题借 `en.ts:68` 真实措辞）：行 = 红点 + `"Peacemaker S2E03"` + `"checked 2h ago"` + `"Fix the timing"` + `"Undo"`（置灰规则同 §5.4）；数据源 = §4.1 新 GET；
- **Dormant tasks · N**：行 = 灰点 + `"The Rig, Season 2"` + `"Failed 5 times, automatic retries stopped."`（**新拟**英文句，前端用 `attempts` 组；内部中文 reason 不透传）+ 右端 mono 裸工具名（如 `find_subtitle`）；**零按钮**（§3 决策 1）；数据源 = §4.2 新 GET；
- 侧栏 badge 计数 = 同一 parked 池（`web/src/shell/Sidebar.tsx:47` 现状语义随迁，示例 9 = 8 files + 1 excluded）。

### 5.6 屏 4 · Settings（栈随迁 + Spec A 落位）

- **Behavior 区**六键（`SETTINGS_KEYS`，`src/dashboard/apiV2.ts:515-518`），每行 = mono 键名 + 描述句（对照 `en.ts` settings 区既有文案逐字核定，草稿示意句不作数）+ 右侧值控件：
  1. `target_languages`（chips 输入；生效语义文案 = `"Takes effect on the next library scan."` `en.ts:189-190`，**不得写 restart**）
  2. `ai_translate_enabled`（switch）
  3. `hardsub_mode`（select，枚举域 = off/agent/aggressive，`apiV2.ts:621` 已核实）
  4. `exclude_extras`（switch）
  5. `scan_interval_ms`（number input）
  6. `trace_retention_days`（number input）
  - Behavior 区同时落 Spec A 的 **Engine 开关**（与 hero 开关同键，§5.3 的"开关两处"裁决的另一半）；
- **Providers 区**（Spec A §5.4 交互契约的落位：打码值/source 徽标/上次测试点/编辑/Test，subhd·zimuku toggle 行）——视觉随本栈，行为以 Spec A 为准；
- **Media roots / Security / Translate / System 区**：结构不动随栈迁移；System 区落 "Re-run setup wizard"（Spec A）；
- **无语言切换器**（既定铁律：UI 语言联动 target_languages，不由 Settings 提供开关）。

### 5.7 文案纪律与新拟登记处

铁律③：能抄的一律逐字抄真实表（主要出处：`web/src/activity/text.ts` hero 全套/队列/空态；`web/src/workflow/phrases.ts` TOOL_PHRASES/DECISION_TEXTS；`web/src/i18n/en.ts:68/93/101/160/170/189-190`；`web/src/library/text.ts:21-23`）。**新拟清单（审计可逐条砍）：**

1. Triage 副标题一句（§5.5）；
2. `"Undo"` 按钮措辞（revert 无既有 UI 文案）；
3. `"Failed 5 times, automatic retries stopped."`（dormant 英文句格式）；
4. `"checked Nh ago"` / `"First seen …, last attempt …."` 两句格式；
5. Library hero 摘要行 `"2 seasons · 16 episodes"`；
6. 侧栏 `"Workflow"` → `"Activity"` 改名（`web/src/shell/tabs.ts:22`）与 wordmark `"subtitle-scout"` → `"Scout"`；侧栏分组 eyebrow 省略。

**非新拟登记（闭合草稿 6 出处表对照，R1 审计补）**：Triage badge 只是视觉换皮——计数语义既有（`Sidebar.tsx:47` + `apiV2.ts:762` `listParkedPaths().length` 同一 parked 池），不入新拟清单。

### 5.8 全局壳

- 左侧栏 196px：wordmark `"◈ Scout"` + Library / Activity（改名，§5.7-6）/ Triage（计数 badge，§5.5）/ Settings；激活项字色 lime `#a3e635`；
- 顶栏 44px：屏名 + 右端 mono 新鲜度行（`web/src/shell/freshness.ts` 口径逐字，含 `'awaiting first scan'` 分支）+ ⌘K chip（CommandK 既有，随迁）；
- **引擎关闭 banner**（Spec A §5.6）：所有主屏顶部常驻细条，仅 `engineEnabled=false` 渲染，文案 `"Engine off — polling and dispatch are paused."` + "Turn on" 快捷钮；不画任何新状态页面（铁规）。

## 6. 实时与行为不变量（代码侧取证，重建期不得写漂）

1. **SSE 管道原样保留**：`/api/v2/workflow/trace-stream` 单例 EventSource（`web/src/workflow/traceStream.ts`——整页一条连接、按 runKey 分发、引用计数归零才关闭）；断线 = 浏览器原生自动重连 + 致命关闭 3s 退避重建（`RECONNECT_DELAY_MS=3000`）。**断线窗口的弥补机制（事实陈述，R1 审计修订）**：`onTraceReconnect` 通道存在且有测试锁（`traceStream.ts:126` 定义、`traceStream.test.ts`），但自 Lanes 一族退役后**当前零生产订阅者**（全仓 grep 实证）——断线窗口实际由 15s 轮询刷 baseTrail + `useLiveTrail` 按 seq 去重合并（`trail.ts mergeTrail`）兜住，轮询刷新不丢直播已追加事件。**重建只随迁 traceStream/useLiveTrail/trail 三文件行为，不新增 onTraceReconnect 订阅**（新增订阅 = spec 未授权的行为变更，属漂移）。
2. **15s 轮询**：`web/src/api/hooks.ts:20` `LIBRARY_POLL_MS = 15_000`，四个数据 hook 共用（`:49/:228/:283/:339`）。重建后 Activity/Library/Triage 的数据 hook 沿用该节律，不新增更快轮询（SSE 已覆盖直播需求）。
3. **秒表锚点**：hero "Running for Nm Ns" 的锚 = `startedAtLease` ← **`jobs.lease_started_at`**（v29 迁移加的稳定列，`claimNext` 落一次、`renewLease` 绝不触碰；commit `173765f` 修的正是锚点错取心跳刷新的 `updated_at` 导致实机冻结）；前端 1s 滴答 `ActivityPage.tsx:50` `setInterval(setNow, 1000)`。**重建时不准把锚改回任何会被心跳刷新的字段**，`apiV2.test.ts` 已有回归锁（续租 5 分钟后 `startedAtLease` 仍为 claim 时刻），随迁保留。
4. **态A/态B 互斥与空态兜底**：`ActivityPage.tsx:110-112` 分支语义不变；空态三句 + `lastScanAt=null` 不编时刻（§5.3）。
5. **阶段条语义**：条宽 = 工具序列深度（`stage.ts`），不是集数、不是百分比进度；无数字、`aria-hidden`。
6. **卡死 hero 无 trail 假设**：held 记录没有 trail（`ActivityPage.tsx:76` 注释），卡死卡零下钻的交互依据；若未来后端给 held 补 trail，零下钻裁决需重议，本 spec 不覆盖。

## 7. 迁移顺序（Astryx 退役纪律：新屏先落地，最后才卸载）

1. **底座进场**：Tailwind v4 + shadcn/ui 初始化，§5.1 映射表落 CSS 变量；@astryxdesign/core 原样在跑，互不影响（同仓并存，路由级隔离）；
2. **两个只读 GET**（§4）——零写路径零状态机，前后端可并行；
3. **Activity 重建上线**（AI Elements queue/shimmer + 自绘 hero/传送带，SSE 管道原样，§6）；
4. **Triage 升级 → Library detail → Settings** 逐屏替换（每屏：新栈实现先挂上路由、旧实现摘除，组件测试随迁绿）。**（2026-08-02 Spec B R1 审计补注：Library 海报墙（`SeriesGrid.tsx`/`PosterCard.tsx`，两者 import @astryxdesign/core，`:5-10`）随本步一并栈随迁——行为冻结、零新功能（类型 chip/母语开关/电影链接都是 Spec B 的增量）；不随迁则第 5 步卸载 Astryx 会留悬空 import 打断构建。）**
5. **全屏验收后卸载** @astryxdesign/core + 删 scout 主题产物（`package.json` 依赖、构建配置、残留 import 一并清），收尾。

每步的完成判据：该屏/该层组件测试全绿 + 主控视觉核对通过（chrome-devtools 实机截图对照草稿 6 对应帧）。

## 8. 错误处理与降级

- 两个新 GET 失败：对应区显空态文案（`"No items"` 级别，沿用各区空态惯例），不弹 toast、不画错误页（观测台纪律）；
- correct/revert/unexclude 失败：行内短暂错误提示，沿用既有 mutation 错误处理模式；
- SSE 断线：无 UI 表现（原生重连 + 补拉，§6-1）；**不设计断连状态面**（铁规）；
- DTO 缺字段防御：系列名/海报缺失时降级为 mono itemId 占位（现网既有降级惯例随迁）。

## 9. 测试

**后端：**
- shifted GET：fixture 三态行（aligned/unverifiable/shifted）→ 只出 shifted；断言 DTO **不含** `offset_ms`/`score`/`reference_tier`/`detail` 四键（铁律②回归锁）；`hasPriorCorrection` 有/无可还原备份两态；空表 `[]`；
- dormant GET：造 `state='dormant'` 行（attempts=5）→ DTO 四键齐、reason 串不出现；空表 `[]`；
- 两端点鉴权：无 token 401。

**前端（随迁 + 新增）：**
- 既有测试全部随迁（ActivityHero/ActivityStuck/ActivityDone/ActivityQueue/ActivityEmpty/ConveyorFeed/stage/text/phrases/trail/traceStream/useLiveTrail 的测试文件即行为契约，换栈不改断言语义，只改渲染层查询方式）；
- 秒表锚点回归锁随迁（apiV2.test.ts 已有，前端侧 1s 滴答渲染断言随迁）；
- 态A/态B 互斥渲染测试（held 存在 → 无 hero/queue/done 三区）；
- 传送带 shimmer 行存在性 + `role="log"` 保留断言；
- Triage 四区渲染（含 Undo 置灰两态、dormant 零按钮断言、Restore 仅 excluded 桶可见）；
- hero 发动机开关：渲染在 hero 右上、PUT 同键、hero 不渲染时开关缺席；
- banner 仅 `engineEnabled=false` 出现（Spec A 测试口径随迁）；
- i18n parity 既有测试自动覆盖（本 spec 新拟文案进 en 表即被锁）。

**实机验收清单（media-router，部署后）：**
- 四屏逐屏对照草稿 6 帧截图核对（主控侧，flash 无视觉）；
- 在跑任务时 hero 秒表连续走字不冻结（30s 观察）；
- SSE 直播：跑一个真任务，传送带行实时推进、无刷新；
- 制造 shifted 行 → Triage 第三区出现、Fix the timing 走通、Undo 出现并可点；
- dormant 行（若库中有）只读呈现、零按钮；
- Engine off → banner 出现、hero 开关态翻转、下 tick 日志无 dispatch；on → 恢复（与 Spec A 联合验收）。

## 10. 兼容与并存

- Astryx 并存期：两栈同仓，路由级隔离，构建产物允许暂时双份 CSS；卸载步（§7-5）前不得删任何 Astryx 产物；
- API 纯增量：两个 GET 新路径，无既有端点契约变化；
- DTO 字段只出不进：shifted/dormant DTO 键集合写死在 §4，后续加字段走新 spec；
- 组件测试随迁不改变断言语义（§9），任何"顺手改行为"在审计口径里等同漂移。

## 11. 实现期验证项（plan 阶段落实）

1. AI Elements copy-in 的四个组件（shimmer/queue/task/tool）取当前 Vercel AI Elements 最新源，逐个核对 props 形状与本 spec 用法吻合；若 queue/task 的 plain-props 形状与草稿假设不符，以官方源为准调整接线层，不改屏结构；
2. Tailwind v4 在 Vite 7 下的接入方式（`@tailwindcss/vite`），暗色变量挂 `:root`（本应用恒暗色，无 light 变体需求）；
3. shadcn/ui 初始化配置（style/aliases）与既有 `web/` 目录结构的落位；Astryx 并存期 CSS 冲突实测（两栈同页不同阶段路由下互不染指）；
4. §4.1 `hasPriorCorrection` 的推导口径：实现期对照 revert 的备份文件门（`subtitleVerifyApi.ts` revertSubtitle 内 `exists(subtitle_path + backupSuffix)`）核实——代码库无 correction 记录表；如需新查询则在 subtitleVerifyRepo 加只读方法，不碰写路径；
5. `seasons` 数组组摘要行（"2 seasons · 16 episodes"）的既有 DTO 可用性核对（SeriesHero 现状数据面）；
6. 迁移第 5 步的 Astryx 残留清单（package.json/构建配置/import 全 grep）在卸载 PR 中逐条核销。

## 12. 明确不做

- 不新增任何写路径端点（含 dormant 唤醒 POST，§3 决策 1）；
- 不接卡死 hero 冻结阶段条（§3 决策 2）；
- 不动 SSE/轮询/秒表锚点三件套的行为（§6），只换视觉消费方；
- 不装 AI Elements 对话系组件（§5.2 不装清单）；
- 不做空态新视觉稿、不做独立语言切换器、不画流派（DTO 无 genre）；
- 不改 Triage 两桶分组语义（excluded-extra vs 其余一切）、不给 parked 行画 park_reason chips（值域 6 个，现网刻意两桶）；
- 不碰 `realignExecutor.ts`（圣文件）、`src/agent/skills/`（主控亲笔）；
- movies index/detail、母语媒体开关、波形端点——Spec B 的地盘，本 spec 不越界。
