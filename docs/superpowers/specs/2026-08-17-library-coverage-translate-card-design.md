# Spec：海报卡字幕覆盖 + AI 翻译卡 rest 态

日期：2026-08-17 ｜ 状态：用户已口头批准两段口径（海报卡选 B；翻译卡对齐 LLM rest 态）｜ 上游：媒体库《美国恐怖故事》黄字「还缺 125 集」；设置页 AI 翻译开关开着却报「三个字段都必须填写」

## 1. 问题

Scout 管的是「本地这几集有没有字幕」，不是「TMDB 全集你下齐了没有」。

海报卡把 `missingEpisodeCount`（`max(0, TMDB应有 − 本地)`）画成黄字「还缺 N 集」。AHS 本地 20 集已全部有字幕（已下载 9 + 自带 11），黄字却报还缺 125 集——那是 Sonarr 的收藏缺口。三个灰色数字并列，要心算才知道齐不齐。

AI 翻译卡：生产库里 `secret:TRANSLATE_*` 三键都在、`ai_translate_enabled=true`。UI 却把打码值放在 **placeholder**，`value` 是空草稿。失焦就报「三个字段都必须填写」。LLM 卡配齐后是绿「已配置」+ 测试/编辑 + 打码键值。开关关掉再打开只写行为键，并不删凭证，但当前 UI 看起来像要重填。

## 2. 范围

**In**

- 海报卡覆盖读数改成方案 B：`字幕 covered/onDisk` + 绿/蓝细条 + 已下载/自带拆行；缺口黄字改口「还有 N 集没字幕」（电影「还没字幕」）。
- DTO 新增后端计算的 `uncoveredEpisodeCount`。卡片不再渲染 `missingEpisodeCount`。
- `TranslateCard` 配齐后走 LLM 同款 rest 态；开关不删凭证；未配齐才摊开必填表单。
- 设置页「排除特典」开关：死控件，删掉。

**Out**

- 详情页虚线格（磁盘上没有的集）。那是点进去才看的，本轮不动。
- 删掉 `missingEpisodeCount` 字段或停止后端计算。接口仍带，卡片不读。
- Daemon 双门控（`tryAutoTranslateCfg` ∧ `ai_translate_enabled==='true'`）、不回落默认 LLM、手动 `translate-item` 不受开关限制。
- 翻译凭证的删除 UI。空输入 = 不改该键，与 `ProviderCard` 相同。
- 设置页再读 env 当翻译凭证来源（2026-08-15：设置页只认库）。`allEnv` 只读分支随重写删掉，不复活。
- 改 `subtitleJudge` 规则 0。特典仍**永远**不算找字幕范围（2026-08-13 裁决），与这个死开关无关。
- 删库里可能残留的 `exclude_extras` 行（无读取方，留着无害）。
- `hardsub_mode`：仍被找字幕 worker 读取，不是死开关，本轮不动。

## 3. 海报卡

### 3.1 口径

分母永远是 `onDiskEpisodeCount`（本地去重后的格数）。

- `covered` 不单独存：展示用 `subtitledEpisodeCount + embeddedEpisodeCount` 的**后端已保证互斥**之和。前端分数的分子取 DTO 上这两个字段，**不做** `onDisk - missing` 之类第二套减法。
- `uncoveredEpisodeCount` = `max(0, onDisk - subtitled - embedded)`，**只在后端算**。前端 `coverageParts` 原样映射：`> 0` 才给黄字，`0` → null（沉默即好消息）。
- 细条两段宽度是排版：`subtitled/onDisk` 绿、`embedded/onDisk` 蓝。`onDisk === 0` 不画条（海报墙本就不收录无文件的空壳）。这不是第二份缺口判据。
- 颜色：已下载 `--color-fn-green`，自带 `--color-fn-blue`，缺口黄字沿用 `.media-card-missing` 的 amber。分数在 `uncovered === 0` 时用绿色。

### 3.2 文案

| 情况 | 主行 | 细条下 | 黄字 |
| --- | --- | --- | --- |
| 剧集，全齐（AHS 9+11 / 20） | `字幕 20/20` | `已下载 9 · 自带 11` | 无 |
| 剧集，有缺口（12 / 30，自带 0） | `字幕 12/30` | `已下载 12` | `还有 18 集没字幕` |
| 电影，有字幕 | `字幕 1/1` | 有外挂则 `已下载 1`；仅自带则 `自带 1` | 无 |
| 电影，没字幕 | `字幕 0/1` | 无拆行 | `还没字幕`（不说「集」） |

自带为 0：**整段不出现**（含细条下的 `· 自带`），与现卡相同。不再出现「本地视频 N」——N 就是分数的分母。

「N 个文件没归入季集」仍单独一行，判据仍是 `unplacedFileCount > 0`。

### 3.3 无障碍

分数 `字幕 20/20` 是可读文本，细条是装饰。**不要** `role="progressbar"`、不要百分比数字（活动页 L10 同纪律：条不是给用户读的量）。

### 3.4 合约

`MediaLibraryItemDTO` / `buildMediaLibrary` 增加 `uncoveredEpisodeCount`。前后端同镜像部署，`MEDIA_LIBRARY_ITEM_SHAPE` **声明**该字段（缺席不能静默成「全齐」）。`missingEpisodeCount` 仍声明、仍计算，卡片 `coverageParts` 不再把它映射到 DOM。

## 4. 翻译卡

开关只写 `ai_translate_enabled`。`putSecret` / `deleteSecret` 不出现在开关路径上。

| 状态 | 界面 |
| --- | --- |
| 开关开 ∧ 三凭证都 `set` | `SettingsCard` `status=configured`（✓ 已配置）。测试、编辑、打码键值、`lastTest` 行。**没有**必填空输入，**没有**「三个字段都必须填写」。 |
| 开关开 ∧ 未配齐 | 三字段表单 + 保存。保存启用当且仅当「草稿或已存」凑齐三键（已存的不必重打）。先 `validateSetup('translate', 非空草稿)`（后端已是草稿优先、否则读库），通了再 `putSecret` 非空草稿。失败不写库、输入保留。 |
| 开关关 ∧ 三凭证都 `set` | 徽标「关闭」。不摊开必填框。一句「凭证已保存，打开后沿用」。打开后回到 rest 态。 |
| 开关关 ∧ 未配齐 | 徽标「关闭」。无表单、无那句凭证提示。 |

测试：`validateSetup('translate')` 不传草稿，走库里的专用三凭证。结果进既有 `secret_test:translate`。编辑：空输入 = 不改该键（与 `ProviderCard` 相同）。自动翻译仍只认 `TRANSLATE_*`，不跟随默认 LLM。

## 4.5 排除特典（死开关）

`exclude_extras` 只还活在设置页：`BehaviorSection` 单键 PUT，`SETTINGS_KEYS` 白名单收它。

生产路径已经不读：

- 唯一消费者是已删除的 `v2/ingest.ts` `excludeExtras` 分支（`isMechanicalExtra && !isExtrasExempt`）。
- `cli/` 零命中。`BehaviorSection` 头注释写的「cli/index.ts live getter」是过期债。
- 特典现由 `subtitleJudge` 规则 0 **无条件**判 `skip_reason='extra'`（用户原话「特典都完全不算在找字幕的范围」）。开关开或关，行为相同。
- 翻案箱 / `extras_exemptions` / triage `unexclude` 已于 2026-08-13 删。

因此关掉开关**不会**让 NCOP 重新进找字幕队列；打开也没有任何增量。注记「下一轮扫描生效」是假的。

本轮：拆掉该 Switch 与两句 i18n；从 `SETTINGS_KEYS` / zod / `SettingsKey` 去掉，PUT 不再接受。GET 不再回这个键。judge 规则 0 不动。README 里「需要打开 exclude_extras 才生效」那句一并改掉。

## 5. 错误处理

- `uncoveredEpisodeCount` 缺席：合约拦截整页媒体库，不许当成 0。
- 翻译探测失败：行内 alert，不 PUT。
- 开关 PUT 失败：开关不本地翻转成成功态；行内错误。
- 测试时三凭证不齐：后端既有 `skip: true` / not configured，前端当失败提示，不假装通过。

## 6. 测试

海报卡：

- 后端：AHS 形 9+11 / 20 → `uncovered=0`；12+0 / 30 → `18`；电影 0/1 → `1`；夹 0 不许变负。
- 前端：AHS 文案含 `20/20`、不含「还缺」「125」「本地视频」；缺口卡含「还有 18」；电影缺口含「还没字幕」、不含「集」；`unplaced` 仍单独一行；`coverageParts` 对 `uncovered` 原样映射、`0` → null。

翻译卡：

- 开/关只 `updateSettings({ ai_translate_enabled })`，零次 `putSecret`。
- 三键 `set` + 开关开：无 `required` 输入；无「三个字段都必须填写」；有测试/编辑。
- 关掉时出现「凭证已保存，打开后沿用」、无必填框；再打开回到 rest 态，不要求重填。
- 编辑时空草稿不 PUT 该键。
- 未配齐时保存仍先 validate 再 PUT。

排除特典：

- 设置页不再出现「排除特典」开关。
- PUT `{ exclude_extras: 'true' }` → 400（不在白名单）。
- `judgeSubtitle` 文件名命中 NCOP 仍 `needs=0, reason=extra`，与 settings 无关。

## 7. 成功标准

- 海报墙全齐的剧不再报 TMDB 缺集。
- 生产那张 AI 翻译卡打开设置页是「已配置」，不是红字必填。
- 关翻译开关再打开，daemon 仍能读到原来的 `TRANSLATE_*`，用户不用再输入。
- 设置页没有「排除特典」；NCOP 仍然不找字幕。
