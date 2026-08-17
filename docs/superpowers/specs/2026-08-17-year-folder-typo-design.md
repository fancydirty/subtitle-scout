# Spec：目录年份写错 1–2 年仍当同一部片

日期：2026-08-17 ｜ 状态：已批准（用户选 B：改 skill + 机械兜底；catalog 卡萨布兰卡保持 1942；针对性活测 Casablanca + Oppenheimer）｜ 上游：假片库活体第二轮 Casablanca `no_safe_match`（TMDB 1943 vs 目录 1942）

## 1. 问题

假片库 `Casablanca (1942)` 识别已绑定 `tmdb:289`。找字幕 worker 搜到 29 条、下载了 1522 cue 的正确中字，却因 identify-media skill 的「year mismatch is an automatic fail」报 `identification-failed` 扔掉。

这是 **文件夹年份与 TMDB 上映年差一年**（1942 首映 vs 1943 发行），不是认成别的片。Dune 1984/2021 这种同名多部不同年 **不** 在本例外里。

`finalize` 工具一旦被调用，循环即停（`hasToolCall('finalize')`）。用 schema 拒收 finalize **不会**让模型改去 install——identityEval 已踩过。机械兜底必须在 **finalize 之后改写报告**，并在 **generate 之前**把「这是文件夹写错年」写成 FACT 喂进 prompt。

## 2. 范围

**In**

- 纯函数：目录年 vs TMDB 年差 1 或 2，且同名没有其他年份 → 文件夹写错年。
- identify-media / find-subtitle skill 文案：year 一票否决增加该例外。
- 找字幕 worker：generate 前若例外成立，prompt 写明 FACT；finalize 后从 `no_safe_match` 去掉「已绑定 target + 年份/identification-failed」且例外成立的项。
- sandbox-library `--ids`：只物化/验收列出的 catalog id。
- OrbStack 针对性活测：zh-viewer 的 `casablanca` + `oppenheimer`。catalog **不**把 Casablanca 改成 1943。

**Out**

- 改 5 分钟总超时 / 单步 timeout。
- 开源卫生、翻译、前端。
- 差 ≥3 年放行。
- 用 schema 拒收 finalize 逼模型重试。
- 自动把 staging 文件装盘（仍由模型 `install_subtitle`；机械层只禁止把「写错年」写成 identity 失败）。

## 3. 纯函数 `yearFolderTypoOk`

```
yearFolderTypoOk(dirYear, tmdbYear, claimedTitle, hits) → boolean
```

`hits`：一次 **不带年份** 的 TMDB 搜索结果（title / originalTitle / year）。

为真当且仅当：

1. `dirYear`、`tmdbYear` 都是数字。
2. `|dirYear - tmdbYear|` 是 1 或 2（0 不是 typo；≥3 仍否决）。
3. `hits` 里「同名」条目（`normalize(title)` 或 `normalize(originalTitle)` 等于 `normalize(claimedTitle)`）中，**没有** `year != null && year !== tmdbYear` 的另一条。
4. 同名条目至少 1 条（零同名 → 没有独一性证据 → 假，fail-closed）。

同名是整串归一化相等。`Casablanca` ≠ `Casablanca: An Unlikely Classic`。`Dune` 1984 与 `Dune` 2021 同名不同年 → 假。

`normalize` 复用 `identify.ts` 现有实现（导出或与 `yearFolderTypoOk` 同文件私有共用）。

## 4. Skill

identify-media：保留「差十年 / 同名不同年一票否决」教材（Conjuring、Peacemaker/芬兰剧）。增加：目录年与 **当前 suspect 的 TMDB 年** 差 1–2，且 search 没有第二部同名别年 → 当作用户写错年，过 bar，继续。

descriptor 不得再写死「year mismatch is an automatic fail」而不提例外。

find-subtitle playbook：target 已有 `itemId` 时，不要用差 1–2 年报 `identification-failed`；没有第二部同名别年就装字幕。候选是 **另一部同名剧**（芬兰 Peacemaker）仍先核身份再 fileList。

## 5. Worker 接线

在 `runFindSubtitleTask`：

1. 已绑定（`itemId != null`）时，用 `yearFromDir(dirName)`、`task.year`、`task.title`，`tmdb.search` 不带年，算 `yearFolderTypoOk`。
2. 若为真，prompt 增加一行 FACT：directory year vs TMDB year is a 1–2 year folder typo; unique exact title; do not report identification-failed; install.
3. `readFinalized()` 之后：对 `no_safe_match` 中 itemId 已绑定、reason 匹配 year / identification-failed、且例外为真的项 **删除**。不把它们改写成「源站没货」。未装上则走既有无结局/退避，而不是 `sub:no-match`。
4. TMDB 不可用或 search 失败 → 不启用例外（fail-closed）。

## 6. CLI 与活测

`sandbox-library --ids casablanca,oppenheimer`：只保留这些 catalog id；未知 id → exit 2。`--profile zh-viewer` 只跑中国观众库那两格。

OrbStack 脚本把 profile 之后的参数原样传给 CLI。

活测不进 `npm test`。Casablanca 保持路径 `Movies/Casablanca (1942)/`。

## 7. 成功标准

- 单测：Casablanca 1942 vs 1943 唯一同名 → true；Dune 双年 → false；差 10 年 → false；零 hits → false。
- Skill 测试：例外在场；差十年仍否决；Peacemaker 同名陷阱仍在。
- 报告闸：已绑定 + identification-failed 年份 + typo ok → 该项从 no_safe_match 消失。
- `--ids` 机械测试：只物化列出的条目。
- 活体：zh-viewer 这两格。Casablanca 期望装上中字（或至少不再 `sub:no-match` 因 1942/1943）。Oppenheimer 记录是否再超时；本 spec 不改超时。
