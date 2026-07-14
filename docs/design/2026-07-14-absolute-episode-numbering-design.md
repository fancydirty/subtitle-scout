# 绝对集数调和能力（Absolute-Episode Numbering Reconciliation）设计

日期：2026-07-14。状态：设计定稿（brainstorming，用户已逐点拍板并委托主控推进）。
前置：v3 找字幕 A 层测试矩阵机器已建成，锚点 + 反例格实弹稳定；本能力是铺"高信号格子"前必须先造的**产品功能**（非测试夹具）。

## 为什么（打 Bazarr 七寸）

字幕源对"季"的理解 ≠ 权威（TMDB / 用户文件）对"季"的理解。两个真实方向：
- **季集 → 绝对号**：文件 `进击的巨人.S02E01.mkv`，字幕组按全系列连续编号，S02E01 = 全系列**第 26 集**（S1 共 25 集），包里文件叫 `... 26.ass`。
- **无季/发明季 → 绝对号**：咒术回战 TMDB 官方**不分季**，但资源自己发明了 S1/S2/S3（S3=死灭回游，还按上/下拆）。间谍过家家同理（用户本人的库就是这种）。

**Bazarr 的死法**：只认一套字面编号，找不到 "S02E01" 就报"无资源"，哪怕那集字幕就躺在包里叫 "26"。v3 靠 agent 智能破这个局——但 agent 需要一个**共同标尺**才能翻译两套编号。

## 核心思想（用户点破）

**别让 agent 算编号，让系统算好了端上来。**
- "S1 有 25 集 ⇒ S02E01 = 第 26 集"这种算术，笨模型正会在此翻车。系统（确定性代码）算这个永不出错。
- **绝对集数 = 两套编号的"普通话"**：不管源怎么切季，都通过"全系列第 N 集"这个锚点对表。
- 这是 v3 既有"机械预清洗打前站 / 活期文档"原则的延伸：系统先算好事实参照，摆在主/子代理面前。

**北极星对齐（关键）**：这张表给的是**事实参照**（第26集=S2E1），不是"这字幕归不归属"的确定性守门。绝对号是 worker 的**强线索/面包屑，不是守门闸**——表说"包里的 26 = 我这集"，worker 仍要看该文件元数据是否真对得上才装，不是"号对上就闭眼装"。确定性只负责算术，归属判断永远留给 agent（否则就退回 Bazarr）。

## Schema：绝对集数交叉表（"画像"）

每部剧一张，系统按 TMDB 一次算好：

```ts
interface AbsoluteEpisodeTable {
  seriesId: string
  entries: { absolute: number; season: number; episode: number }[]  // 绝对号 ↔ (季, 季内集)
  totalEpisodes: number
  source: 'tmdb-episode-group' | 'tmdb-season-concat'   // 推导来源，供可信度判断
  reliable: boolean   // false ⇒ 结构异常/数据不足，不硬喂绝对号（见"边界处理"）
}
```

主代理拿整张（全局视野）；子代理**只拿与自己那一集相关的切片**（沙盒不变）——具体：`FindSubtitleTask` 新增 `absoluteEpisode: number | null`（该集的绝对号；movie / 不可信 / 无法算 ⇒ null）。

## 从 TMDB 推导（确定性，无 LLM）

- **基线（现成）**：`TmdbClient.getSeasonTable(tvId)` 已返回 `{seasonNumber, episodeCount, airDate}[]`，**已排除第 0 季（特别篇）**并按季排序。按季首尾拼接、累加 `episodeCount` 即得 `绝对号 ↔ (季,集)`。`source='tmdb-season-concat'`。
- **增强（新增 TMDB 调用）**：有官方 Episode Groups（`/tv/{id}/episode_groups` → 找 type=Absolute 的组，取 `/tv/episode_group/{group_id}`）时，优先用它——因为对动画，TMDB 的 season 切分常与播出/绝对顺序不一致，官方绝对分组才准。`source='tmdb-episode-group'`。
- **可信度标记**：结构异常（例：单一巨型季 + 无绝对分组；集数缺失；剧场版/OVA 混入正片季）⇒ `reliable=false`，`absoluteEpisode` 注入 null。**拿不准宁可不喂**——喂错的绝对号比不喂更糟（worker 会拿错号进包装错集）。
- **movie**：无季集概念，`absoluteEpisode=null`。

## 边界处理（诚实优先）

- **资源发明了 TMDB 没有的集**（死灭回游下还没播、不在 TMDB）：表只覆盖 TMDB 已知集；超出部分 worker 走判断，宁可 `no_safe_match` 也不硬凑。
- **不可信推导**：`absoluteEpisode=null` 时 worker 退回纯元数据判断（现有能力），不因缺绝对号就摆烂——只是少一条强线索。
- 绝对号是**面包屑**：worker 用它快速定位候选，但装前仍做归属核对（时长/标题/集号元数据），不盲信。

## 语言策略（覆盖优先，用户拍板）

**不设简/繁偏好。** 简繁中国人都看得懂；对字幕而言优先是"能覆盖"，纠结简还是繁太傲慢。落地：
- 正确答案口径：装上**任意一个正确那一集的中文字幕**（`zh-Hans` 或 `zh-Hant`）都算对，不 pin 死。
- **非中文（如日文）不算覆盖** ⇒ 多版本格子仍是有效判断测试（考"认出中文、别抓日文"）。
- skill 精修：去掉任何"优先简体"倾向；加"覆盖优先、简繁皆可、非中文不算覆盖"。
- 矩阵断言：`CellExpectation.installedLanguage` 支持"zh-* 皆可"（当前是单值，需放宽为可选集合）。

## 管线（主-子代理，沙盒不变）

- **orchestrator**（有全局视野）：派活时用 `getSeasonTable`（+ 可选 episode-groups）算表，把 worker 那一集的 `absoluteEpisode` 注入 `FindSubtitleTask`。
- **worker**（沙盒）：只多拿到自己这一集的绝对号；仍只看自己那一个媒体目录，不知全剧结构、不知其他集。
- 表的计算是 orchestrator 职责；worker 只消费。契约扩展 = `FindSubtitleTask` 加 `absoluteEpisode`。

## 测试

- **确定性单元测**（推导层）：给定季表 → 正确的 `绝对号↔(季,集)` 映射；特别篇排除；episode-group 覆盖季表；集数缺失/结构异常 ⇒ `reliable=false`。无 LLM，是地基。
- **A 层实弹格子**（喂增强后的任务、真模型）：进击的巨人（绝对号包）、咒术回战（发明季）、多版本（简/繁/日）。真实度沿用矩阵 A3（真模型 + 录制响应）。
- **真实 API**：用户拍板——该调真 assrt / OS 就调，舍不得孩子套不着狼，本就要真测。旗舰格子倾向真录制（比合成夹具保真），录制时人工把关"正确答案"。

## 分阶段（功能先行，测试压后；用户已认可此顺序）

1. **绝对集数 schema + TMDB 推导**（确定性，单元测全覆盖）——地基。含 episode-groups 拉取 + 可信度标记。
2. **注入任务 + 主子代理管线**：`FindSubtitleTask.absoluteEpisode`；orchestrator 派活时填。
3. **skill 精修**（人工=用户+主控）：教 worker 用绝对号进包定位、仍核归属；写入覆盖优先语言策略。
4. **测试矩阵格子**：进击/咒术/多版本，喂增强任务、真模型实弹；`CellExpectation` 语言放宽。

## 风险 / 待核（实现期）

- **Episode Groups API**：TmdbClient 当前无此调用，阶段 1 需新增；需确认该端点形状与 type=Absolute 分组的存在性/覆盖率。
- **TMDB 动画排序可信度**：季表拼接对乱排动画可能算错绝对号——靠"官方绝对分组优先 + reliable 标记 + 拿不准不喂"三道兜。可信度启发式的具体阈值阶段 1 定。
- **worker 不可盲信**：阶段 3 的 skill 必须保住"绝对号是线索非守门"，避免退化成"号对上就装"的确定性归属（Bazarr 回归）。

## 不在本 spec（已排期在后 / backlog）

- A 层其余格子铺满（国产/欧美/电影 × 各形态）：本能力跑通后继续，属矩阵填充。
- 旧 pipeline 退役（v3 阶段⑧）：用户拍板"该退就退、无保险一说"——独立收尾。
- **i18n 反向**（为国产资源找英文字幕）：用户明确 backlog——国际化意味着当前被正确跳过的国产资源要反过来找英文字幕,复杂度过高,不入当前待办。
