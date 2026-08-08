# Spec: Subtitle Agent 接管识别（删 rescue agent，机械识别降级为 raw 数据提供者）

**日期**: 2026-07-26
**状态（2026-07-27 更新）**: **Phase 1/2/3 全部已实施完毕**（commits `669d3b0`→`df01bc1`，17 个任务）。rescue agent 已整套删除；机械层已降级为纯 raw 数据提供者（ingest FULL PATH 290→37 行）；`resolveToTmdb` 已删；Phase 3 的 auto research 已跑 8 轮，live eval **连续两轮 16/16 全绿**（弱模型 mimo-v2.5）。
**⚠️ 正文写于实施前，多处与最终实现不符——先读文末「实施偏离记录」。**

**⚠️ 本文档已不再是当前工作的依据。** 下一阶段的设计见 `docs/superpowers/specs/2026-07-27-INDEX.md`（六份 spec）。本文档仅作历史记录保留。

**本文档已知的过时之处**（曾误导过一次工作，故显式列出）：
- 原「状态」行称 Phase 2 未开工 —— 早已完成。**过时的状态文档比没有文档更危险。**
- §1.2 要求 raw 数据带 `identify_overrides` 的 hint —— 认领机制即将整体废除，见 Spec 3；路径标签 `[tmdbid-N]` 这条证据通道的修复见 Spec 4。
- §201/§205 描述的 `identify_overrides` 认领落地方式（含 `source='agent'` 逃生阀）—— 已被 `write_identified_media` 取代，认领表待删。

---

## 背景与问题

当前架构是**不优雅且不可纠正**的：

1. **机械识别当主识别**：`identifyFromPath → resolveToTmdb` 用正则/机械规则判定影视身份（series.name / tmdb_id），识别错就**永久错**——没有任何 agent 能纠正已入库的错误身份。
2. **rescue agent 是伪 agent**：只在 parked（识别不出）时兜底，本质是"批量目录→逐个调 TMDB→finalize 一次性返回"的**无状态 API 调用器**。它：
   - 没有真工作流（不像 findSubtitleWorker 有 search→download→verify→install 的多步判断）
   - 把状态憋在内存里（finalize 才返回），agent 死了全丢，违背"数据库维系工作流"
   - 管不了"识别错"（已入库但绑错 TMDB），只管"识别不出"
3. **两条路径割裂**：机械识别给身份 → findSubtitleWorker 拿身份找字幕。机械识别一错，后面全错。

**用户核心诉求**：
- **识别错的必须能纠正**——机械识别写库了识别错没人能改。
- **刮削只起辅助作用**——机械解析给 raw 数据（候选提示），不做最终判定。
- **每个识别都由 agent 做**——subtitle agent 被唤起时**自己识别**这是哪部剧，基于自己识别的身份找字幕。
- **rescue agent 干掉**——它的逻辑并进找字幕 agent，不再是独立的"无状态调用器"。

## 目标架构

```
机械解析（identifyFromPath，只给 raw 数据，不判定身份）
  → 候选提示：文件路径 / 目录名 / 资源名 / 时长 / 结构提示（SxxEyy/第N集）/ 可能的 imdb hint
  ↓
subtitle agent 被唤起（findSubtitleWorker，一个真 agent 一气呵成）
  ↓
【识别步骤】agent 脑中清洗 raw 数据 → 理解出正确影视名称
  ↓ 调 TMDB search 拿候选 → get_tmdb_details 佐证（证据先行，不脑补）
  ↓ two-evidence bar：名字匹配 + 第二个独立证据（season table/year/duration/结构）吻合才认领
  ↓ 识别对了 → 【立刻回填库】（series.name / tmdb_id 落库，状态机第一步）
  ↓
【找字幕工作流】基于识别的身份找字幕（原有流程，install 每集立刻落库，状态机继续）
```

**数据库是状态机**：每一步产出（识别身份、装了哪几集）立刻落库。断了下个 agent 读库接续，不依赖内存。

## 核心设计原则

### 1. 证据先行（绝不脑补）
- agent 的模型知识库有星球大战/招魂/莉可丽丝，但**绝不能用"我记得"判定**。
- 必须调 TMDB 拿证据：search 拿候选 → details 验证（season table/year/duration/结构吻合）。
- **two-evidence bar**：名字匹配不够，要第二个独立证据吻合才认领。
- 识别错了 agent 能回头再搜再判断，但每一步证据驱动。

### 2. 数据库维系工作流（不是内存）
- 识别回填**立刻落库**（series.name/tmdb_id）——哪怕后面找字幕断了，库里已有正确身份。
- install 每集**立刻落库**（subtitles 行）——断了下次知道装到第几集。
- rescue agent 的"finalize 一次性返回"违背此原则，故删。

### 3. auto research 打磨识别 skill
- 识别 skill 不是一次性 prompt，是**活的文档**。
- 用真实命名压力测试集（招z魂z4 / H）后丨室 / fansub / BT站命名）喂给 agent，看它在证据先行下：
  - 识别对没有（title/tmdbId 正确）
  - 佐证链是否完整（有没有调 search + details，还是只凭名字就 claim）
  - 该 keep parked 的有没有乱 claim（北极星红线"绝不误认"）
- 根据结果迭代 skill 措辞，直到真实乱命名下也稳。

### 4. TMDB details 返回差异（按 mediaType 佐证）
- **movie**：title / original_title / year / overview / runtime（单文件时长）
- **tv**：name / original_name / first_air_date / overview / episode_run_time / **season table**（季集数表）
- 识别 skill 按 mediaType 用对应字段佐证（movie 看 runtime，tv 看 season table + first_air_date）。

## 范围

### 删除
- `src/agent/rescueWorker.ts`
- `src/v2/rescueWorkerTask.ts`
- `src/agent/skills/rescueSkill.ts`
- `src/agent/rescueWorker.tools.ts`
- 相关测试（rescueWorker.test.ts / rescueWorker.tools.test.ts / rescueSkill.test.ts / rescueWorker.schemas.test.ts / rescueWorkerTask.test.ts）
- daemon 里 `rescue-backlog` 的调度逻辑
- 机械识别写库"最终身份"的逻辑（resolveToTmdb 不再写 series.name / tmdb_id 当真相）

### 改造 findSubtitleWorker（加识别步骤）
- **加识别工具**：复用 rescue 的 `search_tmdb` / `get_tmdb_details`（干净，直接搬）。
- **task 组装改 raw 数据**：`findSubtitleWorkerTask.ts` 的 task 不再从库读 title/providerIds（机械识别结果），改成给 raw 数据（文件路径/目录名/资源名/时长/结构提示/可能的 imdb hint）。
- **findSubtitleSkill 加识别步骤**：
  - raw 数据脑中清洗 → 理解出正确影视名称
  - 调 TMDB search 拿候选 → get_tmdb_details 佐证（two-evidence bar）
  - 识别对了**立刻回填库**（series.name/tmdb_id 落库）
  - 然后基于识别的身份找字幕（原有工作流）

### 机械识别降级
- `identifyFromPath → resolveToTmdb` 只给 raw 数据（候选 query / 结构提示 / imdb hint），**不写库当真相**。
- `series.name / tmdb_id` 只在 agent 识别回填后才写。

## 关键决策（已对齐）
- **识别回填时机**：立刻回填（识别对了就写库）。数据库是状态机，回填后断了下个 agent 读库接续。
- **rescue agent 的 parked 文件**：**清空 parked 行**，让它们重新走新 findSubtitleWorker 流程（机械识别再扫一遍给 raw 数据，agent 自己识别+找字幕）。这些 parked 行是旧架构的产物（机械识别搞不定才停车的），新架构下每个文件都该由 agent 自己识别，不该继承"识别不出"的标签。
- **TMDB details 差异**：识别 skill 按 mediaType 用对应字段佐证（movie runtime / tv season table）。

---

# Plan: 实施步骤（writing plans）

## ⚠️ 架构硬约束（2026-07-26 接续时发现，spec 原假设错了）

**原 spec 的假设**：库行已存在（机械识别建的），agent 只是"改它的 name/provider_ids"。

**架构现实**：`series.id = 'tmdb:<TMDB id>'`（ownIds.ts）——**行 id 本身就编码了机械识别的 TMDB 判定**。ingest 时 `resolveToTmdb` 认领 tmdbId → `upsertSeries({ id: seriesId(tmdbId), name, providerIds })` 建行。如果机械识别不认领 TMDB，**连行都建不出来**；如果机械识别判错了 tmdbId，**id 就是错的**，agent 没法"回填"——得删错行建新行（own-id 空间假设 id 即身份）。

**这意味着**：要让"agent 自己识别"，不是"findSubtitleWorker 加工具 + task 改 raw 数据"这么简单，是**重写 ingest 的建行逻辑**：
1. ingest 扫到文件 → identifyFromPath 给结构（SxxEyy/标题候选）但**不 resolveToTmdb**
2. 所有文件先 parked（哪怕机械识别"认出"标题候选）——因为机械识别不认领 TMDB
3. agent 被唤起 → 自己识别（调 TMDB 佐证）→ 识别对了**当场建 series/movies 行 + episodes 行**（这时才有 tmdbId 构造 id）→ 找字幕

**改动半径**：ingest（建行逻辑从"机械识别认领"改成"agent 认领"）/ ownIds（id 空间是否还编码 tmdbId？）/ libraryRepo（upsertSeries/upsertMovie 的调用方）/ dashboard（救援页显示 parked）/ orchestrator（find-subtitle 派发的前提是行已存在）。

**两条路**：
- **路 A（保守，先验证识别质量）**：机械识别照旧建行（id 编码机械识别的 tmdbId），findSubtitleWorker 加识别工具，task 给 raw 数据 + 机械识别结果作"候选提示"（标注是 hint 不是真相），agent 每次 run 都重新识别（不盲从库里的身份），识别错了**建新行删错行**（agent 有权纠正机械识别的误判）。这样 ingest 不动，先验证 agent 识别质量，再谈 ingest 重写。
- **路 B（激进，一步到位）**：ingest 建行逻辑重写——所有文件先 parked，agent 识别对了才建行。own-id 空间可能也要改（不再编码 tmdbId，或者 agent 识别后才构造 id）。

**用户裁决点**：先走 A 验证识别质量（agent 有权纠正机械误判），还是直接走 B 重写 ingest？

---

## Phase 1: 给 findSubtitleWorker 加识别能力（不动 rescue，先并行）

### 1.1 加识别工具（复用 rescue 的）
- 把 `rescueWorker.tools.ts` 的 `search_tmdb` / `get_tmdb_details` 抽成共享模块（如 `src/agent/tools/tmdbTools.ts`），rescue 和 findSubtitleWorker 都用。
- findSubtitleWorker 的 `FindSubtitleWorkerDeps` 加 `tmdb: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'>`。
- `makeFindSubtitleWorker` 的 tools 里加 `search_tmdb` / `get_tmdb_details`。

### 1.2 task 组装改 raw 数据
- `findSubtitleWorkerTask.ts` 的 task 不再从库读 title/providerIds 当真相。
- 改成给 raw 数据：文件路径 / 目录名（parent/grandparent）/ 资源名（文件名）/ 时长（probe duration）/ 结构提示（SxxEyy/第N集/绝对集号）/ 可能的 imdb hint（identify_overrides 里的）。
- `FindSubtitleTask` schema 加 `rawEvidence` 字段（文件路径/目录名/时长/结构提示），保留 title/providerIds 作"机械识别的候选提示"（明确标注是 hint 不是真相）。

### 1.3 findSubtitleSkill 加识别步骤
- skill 开头加"识别步骤"指导：
  - 先读 raw 数据（文件路径/目录名/资源名/时长/结构提示）。
  - 脑中清洗出正确影视名称（考虑 fansub/BT站/版权规避乱写）。
  - 调 search_tmdb 拿候选（可多次换关键词：romaji/English/stripped tags）。
  - 调 get_tmdb_details 佐证：two-evidence bar（名字匹配 + season table/year/duration/结构吻合）。
  - **绝不脑补**——没有足够证据就 keep_parked（不写库，返回需要人工）。
  - 识别对了 → 调一个 `confirm_identity` 工具回填库（series.name/tmdb_id 落库）。
  - 然后基于识别的身份找字幕（原有流程）。

## Phase 2: 删 rescue agent（识别能力已并进 findSubtitleWorker）

### 2.1 删 rescue agent 全套
- `src/agent/rescueWorker.ts` / `src/v2/rescueWorkerTask.ts` / `src/agent/skills/rescueSkill.ts` / `src/agent/rescueWorker.tools.ts`
- 相关测试全删。
- daemon 里 `rescue-backlog` 调度逻辑删。

### 2.2 机械识别降级 + 清 parked 行
- `resolveToTmdb` 不再写 series.name / tmdb_id 当真相（写库逻辑删）。
- `identifyFromPath` 保留（给结构提示/raw 数据），但不写最终身份。
- **清空 parked 行**（`parked_paths` 表）：这些行是旧架构"机械识别搞不定才停车"的产物，新架构下每个文件都该由 agent 自己识别，不该继承"识别不出"的标签。清完后让机械识别再扫一遍给 raw 数据，agent 走新流程自己识别。

## Phase 3: auto research 打磨识别 skill

### 3.1 建真实命名压力测试集
- 招z魂z4 / H）后丨室 / fansub（[诸神字幕组][莉可丽丝]）/ BT站（[BT之家]铁拳教育）/ 季包（COMPLETE）/ 中文季目录（莉可丽丝/第1集）。
- 每个标注 ground truth（正确 title/tmdbId/season/episode）。

### 3.2 喂给 agent 跑，看识别质量
- 识别对没有（title/tmdbId 正确）
- 佐证链是否完整（有没有调 search + details）
- 该 keep parked 的有没有乱 claim
- 根据结果迭代 skill 措辞，直到真实乱命名下也稳。

## 验证标准
- findSubtitleWorker 能自己识别（raw 数据→TMDB 佐证→识别对）并找字幕，不再依赖机械识别的最终身份。
- rescue agent 全删，识别能力完全在 findSubtitleWorker 里。
- 机械识别只给 raw 数据，不写库当真相。
- 数据库是状态机：识别/install 每步立刻落库，断了读库接续。
- 真实命名压力测试集下，agent 证据先行识别对，该 keep parked 的不乱 claim。

## 风险与缓解
- **风险**：findSubtitleWorker 加识别步骤后变复杂，prompt 变长，LLM 可能跑偏。
  - **缓解**：skill 分两步写清楚（识别步骤→找字幕步骤），用 auto research 反复打磨。
- **风险**：机械识别降级后，库里已有 series.name/tmdb_id 的旧数据怎么办。
  - **缓解**：旧数据保留作"候选提示"（标注是 hint），agent 识别时优先用它作 query 起点，但仍要 TMDB 佐证才回填。
- **风险**：agent 识别回填后，如果识别错了，谁来纠正。
  - **缓解**：agent 每次 run 都重新识别（不盲从库里的旧身份，只把旧身份当候选提示），识别错了下次 run 纠正。

---

**下一步**：compact 后按此 plan 实施。先 Phase 1（findSubtitleWorker 加识别能力），再 Phase 2（删 rescue + 机械降级），最后 Phase 3（auto research 打磨）。

---

# 实施偏离记录（2026-07-26，实施完成后补记）

正文是实施前的设计稿。用户裁决走**路 A**（机械识别照旧建行，agent 核验+纠正），
外加两轮子代理审计的修正，最终实现与正文有以下偏离：

| 正文描述 | 实际实现 |
|---|---|
| 删 rescueWorker / rescueWorkerTask / rescueSkill | **未删**，Phase 2 未开工。只抽出了共享的 TMDB 证据工具（`src/agent/tmdbTools.ts`）给两边复用 |
| `resolveToTmdb` 不再写库当真相 | **未做**（路 A 的定义就是机械识别照旧建行） |
| `FindSubtitleTask` 加 `rawEvidence` 字段 | **未加**。raw 数据本就在 targets 里（path/filename/season/episode/runtime），补的是 prompt 侧的目录名两行（第九轮 auto research 发现目录名从未进过 prompt） |
| 识别对了调 `confirm_identity` 工具回填库 | **无此工具**。落地方式是写一条 `identify_overrides` 认领，下一轮 ingest 的 `recognize()` 消歧前查命中后按新身份建行、清旧行——刻意不手写 id 迁移（own-id 链 + 五张表外键，中途崩溃无幂等恢复点） |

正文完全没提、但实现里最重要的三件安全设计：

1. **认领安全闸**（`safeClaimPrefix`）：认领前缀取 targets 的公共祖先，且必须严格深于每个
   配置媒体根。第一版曾一刀切拒绝"跨目录"，反而把多季剧（最常见的 TV 布局）永久锁死——
   agent 每轮判对每轮被拒，是更坏的失效形态。
2. **`identify_overrides.source` 列**（schema v24）：区分 human/agent 认领，
   ON CONFLICT 的 WHERE 子句实现"agent 永不覆盖人工认领"。人的判断是终局，agent 的核验是
   会出错的启发式，两者权威等级不同。
3. **三道落地前校验**：tmdbId 必须是纯数字（堵幻觉 `tmdb:`/`tt` 前缀）、必须在 TMDB 上真实
   存在（堵合法数字的幻觉 id 建出永久鬼影剧）、不能等于库里现有 id（空转纠错=把确认塞进
   纠错字段）。

另外 finalize 报告多了 `identity_verified` 布尔字段——给"我核验过了，是对的"一个正当去处。
措辞加了四轮都拦不住模型把确认塞进 `identity_correction`，根因不是措辞：一个孤零零的可选
字段，模型天然想填满它来交代工作。

识别质量由 `src/agent/identityEval.live.test.ts` 把关（真模型 + 真 TMDB，9 个真实命名 case
+ 2 道 ground truth 防腐 preflight，`IDENTITY_EVAL_LIVE=1` 开门跑，CI 默认跳过）。
经十轮 auto research 迭代后 11/11 全绿。
