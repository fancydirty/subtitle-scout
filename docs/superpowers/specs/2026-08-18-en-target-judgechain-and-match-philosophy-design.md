# 英文目标切换暴露的判定链缺陷 + 匹配哲学重构（2026-08-18）

## 0. 用户裁决（字面原文，本 spec 的上位法）

> 「无论中英还是其他语言，都不以匹配压制为目标，因为对用户而言，重点是在于有字幕，
> 而非是否完美匹配，哪怕需要微调对齐，也比没有字幕更好。也就是要分清主次矛盾。」

> 「虽然 agent 自己能做到强大的语义理解……但它所需的时间会比机械解析多得多，所以机械
> 解析还是不得不用……当前的逻辑是 agent 认资源（作品身份），但资源是第几季第几集交给
> 机械解析。所以咱们就得保证它的准确性。」

推论：
- **身份 = 作品 + 季/集**。release group / release name 是弱证据，最多用于时轴参考，**绝不作为安装 blocker**。
- 安全底线不变：**不是同一作品或同一集 → 不装**（no_safe_match）。放宽的是「同作品同集但
  不同压制/不同分辨率/年份差一」这一档——它们属于同一身份，必须装。
- 架构分工不变：agent 认作品（语义层，贵而准），机械解析认季集（速度层，必须准）。

## 1. 背景

2026-08-18 用户首次把 `target_languages` 切到 `en` 并跑了一轮巡检。结果：92 个英文字幕
装上（OpenSubtitles 主力），但暴露四个缺陷——一张永远「等待重试」的僵尸卡片（DxD）、
一批被白跑的目标（67% 有内嵌英文轨却仍被判需要找字幕）、一组解析错的季集（Overflow
s80e720）、以及一个对英语目标说「已有中文覆盖」的翻译 worker。

## 2. 根因（四条，各自带生产证据）

### F1 判需规则 2 不认三字母语言码（eng ≠ en）

`subtitleJudge.ts:79-80`：
```ts
input.embeddedLangs.some((l) => deps.targetLanguages.includes(langOf(l)))
```
`langOf` 只折叠中文别名（chi/zho/cmn→zh），对 `eng` 透传得 `eng`；targetLanguages 是
`['en']` → `includes('eng')` 恒 false → **有内嵌英文文本轨的文件被判「需要找字幕」**。

讽刺：同文件 `isLang()`（:124）就是为 3 字母码写的，注释逐字论证了 jpn/eng 陷阱
（ffprobe 写 ISO-639-2 三字母、TMDB 写两字母），规则 2 没用它。

生产伤害：本轮 222 个目标里 **149 个（67%）有内嵌 eng 轨**——整场找字幕大半在为
不需要字幕的文件白烧 agent session。DxD ep01（`embedded_langs=["jpn","eng"]`）正是
这样进的找字幕流。

### F2 翻译 worker 的 already-covered 硬编码中文

`translateWorker.tools.ts:133-141`：embedded 检查写死 `zh/chi/zho/chs/cht` 前缀；
sidecar 检查叫 `readExistingChineseSidecar`。目标语言是 en 时，worker 对着盘上的
zh-Hans 旧 sidecar 说「already-covered（已有中文）」——与目标无关的答案。

### F3 already-covered × 目标语言扫描 = 永久日循环（僵尸卡片）

`applyTranslateOutcome`（translateWorkerTask.ts:239）成功轨**故意**保持
`sub_status='handoff_translate'` 等扫描确认（R24：扫描独占写 covered）。但扫描按
目标语言找 sidecar（daemonV2:2056 `tagsForLanguage(targetLanguage)`）——**中文
sidecar 对 en 目标永远确认不了**。于是：翻译队列每日重领 → 再判 already-covered →
再 +1 天退避 → 无限循环，界面永远显示「等待重试」。这是「装好的陷阱」注释
（translateWorkerTask.ts:138）预言的那类用户可见假话，第一次被踩响。

前置问题（为何会进翻译流）：`sub_attempt=8` 是 zh 时代的遗产（语言切换不清失败
计数）+ 有日文内嵌轨 → translatable=1 → 移交。F1 修掉后该文件 needs=0，整条链
不会再发生；但**已卡死的行需要出队通路**（见 §4.2）。

### F4 机械解析器的对抗性缺陷（生产实案 + 语料测试）

| # | 规则 | 病灶 | 生产伤害 |
|---|---|---|---|
| P1 | R3 `1x03` | `1280x720` 的 "80x720" 命中（season 位 `\d{1,2}` 贪心吃掉宽度尾部；`isPlausibleSeason(80)` 放行；`looksLikeYear(80,720)=80720` 不是年） | Overflow ×8 → `s=80 e=720`，`parse_confidence='high'` |
| P2 | R1/R5 | 粘连版本后缀 `S01E04v2`：`\b` 在 `4|v` 之间不成立 → R1/R5 双双失配。点分隔 `.v2` 因 `1|.` 有边界而正常 | 三种形态：episode=0（Nukitashi ×8，R8 兜底吃掉 `AAC2.0` 的 `0`）、季集全 NULL（芬芳 Flowers ×7）、正常（Hi10 `.v2` 系列 ×11） |
| P3 | R8 兜底 | 小数声道：`DDP5.1.Atmos` 的 `1`（前置分隔符 `.`、后随 `.Atmos` 非数字）通过全部闸 → abs=1，电影变剧集；`AAC2.0` 的 `0` → episode=0 | 语料证实；`episode=0` 形态已在生产（Nukitashi） |
| P4 | R4 等 | 中文数字季「第一季」、ordinal「Second Season」、单位数「E7」不识别 | 低优先，agent 语义层可兜住，**本 spec 明确不修**，记录为已知边界 |

「episode=0」额外暴露一个全局缺口：**任何规则都不该产出 0**——集号从 1 起。

## 3. 为什么四个缺陷一个 spec

用户明示：「我并不认为这些问题需要分开收……怕做完 ①② 后收后面的你会漂移。」
四条根因共享同一上位裁决（§0）和同一验证语料（本轮 en 巡检的生产数据）。分开收
会让 skill 重构失去 F1/F4 的数据支撑，让 F4 的重解析失去 F2/F3 的状态机语境。

## 4. 方案

### 4.1 F1：规则 2 改用 isLang

```ts
const hasTargetEmbedded = input.embeddedLangs.some((l) =>
  deps.targetLanguages.some((t) => isLang(l, t)))
```
（`isLang` 已在同文件，含 tagsForLanguage 三字母映射。）规则 1 origin-skip 不动
（TMDB origin 恒两字母，`toLowerCase()` 已够；动它超出本次病灶）。

### 4.2 F3 根治：翻译队列卫生 + 一次性洗库

两层：

**a. 谓词卫生（永久）**：`TRANSLATE_QUEUE_WHERE`（translateWorkerTask.ts）加
`AND f.needs_subtitle = 1`。理由：移交只在 needs=1 时发生（subtitleScheduler），
needs 翻 0 后停牌态必须随之失去取件资格——「这个文件不再需要字幕」是比任何
停牌态更强的真理。daemon 领活与界面显示共用该 WHERE（includeBackoff 参数化），
一处改两处生效。字幕队列（SUBTITLE_QUEUE_WHERE）本就有 `needs_subtitle = 1`，
对称。

**b. 一次性迁移（洗存量）**：MIGRATIONS 追加一条：`UPDATE files SET
needs_subtitle = NULL, skip_reason = NULL`（全行）。judge 谓词是
`needs_subtitle IS NULL` → 下一次 boot/巡检全量重判（纯机械、零 LLM）。重判后
DxD ep01 needs=0 → 凭 a 出队；有内嵌 eng 轨的 149 行同批退出找字幕流。
照抄 retarget.ts 的既有先例（语言切换正是这么清的——本次等于「判据修了，重判
一遍」）。

**不做的**：不在迁移里清 sub_status/handoff（R24 铁律 + D10 乐观守卫的理由链
仍然成立；a 已让僵尸行失去全部取件资格，留着无害；用户将来切回 zh，needs 重判
翻 1，行自然复活，状态连续）。不在 SQL 里重写规则 2（一个判据只许一份实现）。

### 4.3 F2：目标语言接入翻译 worker

- `TranslateToolDeps`：`readExistingChineseSidecar` → `readExistingSidecar:
  (videoPath, tags: string[]) => string | null`（tags 由调用方用
  `tagsForLanguage(targetLanguage)` 组好传入）；embedded 检查改
  `isLang(l, targetLanguage)`（languages.ts 已有）。
- 接线：daemon 侧（cli/index.ts makeDaemonTranslateRunItem）与手动 CLI 侧
  （translateItemCommand）都从 settings 的 target_languages 取当前值传入。
  workspace task 增加 `targetLanguage` 字段（TranslateWorkspaceTask 形状）。

### 4.4 F4：解析器四修 + PARSER_VERSION 1→2

1. **R3 数字边界**：seasonnumber 前加 `(?<!\d)`，epnumber 后加 `(?!\d)`——
   「1280」里的「80」不再是独立季号 token。
2. **R1/R5 版本后缀**：episode 数字后允许 `(?:v\d{1,2})?` 再 `\b`——`S01E04v2`
   认出 s=1 e=4，v2 当重定时版本消化。
3. **全局 episode ≥ 1 闸**：extractSeasonEpisode 所有规则的 episode/absoluteEpisode
   为 0 时视同失配（0 不是集号）。杀掉 `AAC2.0`→episode=0 形态。
4. **R8 小数声道闸**：分隔符 `[\s._-]` 前若是数字（`(?<!\d)[\s._-]`），说明这是
   `5.1`/`2.0` 的小数尾——拒。杀掉 `DDP5.1`→abs=1 形态。
5. **PARSER_VERSION 常量 1→2**：既有 C48 机制自动重解析全库存量（指纹不变只重算
   work_dir/season/episode/parse_confidence，不碰字幕状态）。Overflow/Nukitashi/
   芬芳的错行全部自愈。

测试语料：把本次对抗语料（生产实案 5 条 + 合成陷阱 20+ 条）固化进
parseFilename.test.ts 作回归锁。

### 4.5 skill 重构：one rule 重写（identity-first）

`findSubtitleSkill.ts` 的「The one rule that overrides everything else」段重写：

- **身份判据（决定装不装）**：title/year/season/episode 对上作品与集；结构验证
  （时长比、cue 数、文字_script）不反常。**这一档 = 属于该作品该集 = INSTALL**，
  无论 release group / release name / 分辨率 / WEB vs BD 是否一致。
- **release name 降级为注释性证据**：可用于预判时轴偏移（装完后系统/用户微调），
  不构成拒绝理由。候选带 v2/v3 = 同集重定时，仍属匹配。
- **no_safe_match 收窄**：仅当候选不属于该作品（同名异作/年份出处矛盾）或不属于
  该集（集号对不上且无合理映射）。
- 保留既有全部安全条款：同名陷阱、混语言包、结构反常拒装、pack 逐集核验。
- dry-run TDD（auto-research 哲学）：**先对现状跑 RED**（证明当前 skill 在
  identity-match 场景会错判），改后 GREEN；既有 S1–S8 场景全数保持 GREEN
  （放宽不得破安全）。新场景：
  - SC-A 跨压制组：候选 release group/命名与视频文件完全不同，同作品同集 → 必须 install
  - SC-B 年份±1：跨年上映（Shelby Oaks 实案形态）→ 必须 install
  - SC-C 版本后缀：视频 `S01E05v3`，候选 `S01E05` → 必须 install
  - SC-D 同名异作（既有 S3 保持）→ 仍 no_safe_match（回归闸）
  - SC-E 错集：pack 里该集缺失/集号不符 → 仍不装（回归闸）

## 5. 测试锁总表（RED → GREEN 逐项）

| 层 | 锁 | 红 | 绿 |
|---|---|---|---|
| 单测 | subtitleJudge：embedded ['jpn','eng'] × target ['en'] → needs=false('embedded') | ✗ 现判 true | 4.1 |
| 单测 | translateWorker already-covered：en 目标 + en sidecar → already-covered；en 目标 + 仅 zh sidecar → **不**短路 | ✗ 现按 zh 短路 | 4.3 |
| 单测 | TRANSLATE_QUEUE_WHERE：needs=0 的 handoff 行不入队（daemon+界面两口径） | ✗ 现入队 | 4.2a |
| 迁移 | 洗库后全行 needs IS NULL；重判后 DxD 形态行 needs=0 | — | 4.2b |
| 单测 | parseFilename：语料逐条断言（Overflow→abs 1..8、Nukitashi v2→s1e4、芬芳 v3→s1e5、DDP5.1→无集、E7 单位数→无集（P4 已知边界，锁现状）） | ✗ 现错 | 4.4 |
| 单测 | PARSER_VERSION = 2 | — | 4.4 |
| dry-run | SC-A/B/C install；SC-D/E 拒装；S1–S8 全绿 | SC-A/B/C ✗ | 4.5 |

## 6. 显式覆盖

| 旧裁决 | 本 spec |
|---|---|
| findSubtitleSkill「judge by release name, native name, filelist」（one rule） | 身份优先；release name 降为注释性证据 |
| translateWorker already-covered = 中文检查 | 按目标语言检查 |
| judge 规则 2 `langOf` 直比 | `isLang`（三字母码） |
| PARSER_VERSION = 1 | 2 |

## 7. 不做什么（防漂移清单）

- 不动规则 1（origin-skip）、不动 translatable 判据（D9 两支）。
- 不清 sub_status 存量（§4.2b 论证）。
- 不修 P4（中文数字季/ordinal 季/单位数 E）——agent 语义层兜住，扩机械面需要新实案。
- 不引入「集号→TMDB 绝对集号映射」新能力（用户未裁决，YAGNI）。
- skill 重构不碰工具面（search/get/download/install 的 schema 不动），只动教法文本。

## 8. 自审

- 占位：无 TBD；P4 明确记录为不修而非待办。
- 主次：§0 裁决贯穿——四修全部服务「有字幕 > 完美匹配」+「机械解析必须准」。
- 内部一致：4.2a 的谓词卫生与 4.2b 的洗库互补（永久闸 + 存量清洗），与 R24/D10
  既有理由链无冲突（已逐条对照）。
- 测试先行：每项修复均有 RED 锁；dry-run 场景先跑现状取 RED 证据再改 skill。
- 回归面：既有 S1–S8、subtitleScheduler/translateWorkerTask/db 迁移测试全绿为
  合并门槛。
