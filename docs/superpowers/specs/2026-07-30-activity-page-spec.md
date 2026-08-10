# 活动页重做 spec（运行态展示，取代 Workflow 三泳道）

- 日期：2026-07-30
- 状态：已自审 + 已过子代理事实审计（审计记录 `/tmp/audit-activity-facts.md`；
  抓出 2 条假断言 + 2 条不精确，均已修正；自审另补 §4.2.2 taskType 分族漏洞）
- 取代：`web/src/workflow/` 的三泳道页（Lanes/PendingLane/ActivityFeed/SummaryLine）

## 1. 这一页要解决什么

现在的 Workflow 页是**账目**：三条泳道、停牌计数、receipts chips、可点开的 trace。它回答的是
"系统都干了什么"。

用户裁决把它重新定义为**运行态展示**：回答"现在怎么样了，我可以不管了吗"。

> 「活动页是运行态展示，不是账本」「Steam 的下载页」「连图片都没了根本称不上活动页」
> 「用户关心活干得好不好，不关心干得累不累」

这句差别决定了后面每一条：**缓解焦虑是目的，取证不是**。取证归真实日志。

## 2. 铁律（用户裁决，不许自行放宽）

| # | 铁律 | 出处 |
|---|---|---|
| L1 | **只有绿和红，永不用黄/琥珀** | 「黄色会让用户觉得这项目有病」 |
| L2 | **分数/偏移量/置信度只进内部，永不上界面** | 同上 |
| L3 | **永不暴露机械**：界面不出现 agent/orchestrator/asset/ledger/worker/pass | 「用户关心活干得好不好」 |
| L4 | **必须有图**（海报/剧照） | 「连图片都没了根本称不上活动页」 |
| L5 | 队列海报必须 **2:3 竖版**，不是 16:9 | 用户明确纠正 |
| L6 | 字幕齐了**不写字说"齐了"**，只显示完成列表 | 「Steam 只显示完成列表」 |
| L7 | **不做点开看 trace**——"青黄不接的中间点"；但界面仍须让问题**看得见** | 用户裁决 |
| L8 | 传送带：新事件把列往上顶，旧的被顶出去（不是原地淡出） | 用户裁决 |
| L9 | **硬出，不做渐隐遮罩** | 2026-07-30 裁决 |
| L10 | 进度条 = **agent 工作阶段**，不是集数；**不写百分比数字** | 2026-07-30 裁决 |
| L11 | 无暂停按钮 | 用户裁决（语义想不清就别画） |
| L12 | 痕迹短语**跟随 UI 语言** | 2026-07-30 裁决（DESIGN.md §7） |

## 3. 页面骨架（Steam 下载页解剖）

```
┌─────────────────────────────────────────────┐
│ HERO ── 当前这一件事（背景大图出血）          │  ~36% 视口
│  海报 2:3 │ 标题 / 副标题(含状态) / 传送带    │
│           │ 阶段进度条 / 已进行时长           │
├─────────────────────────────────────────────┤
│ 接下来 (n)         [自动检查已开启]           │  低墨排
│  38px 海报 │ 剧名 · 第N季 · M集缺字幕 │ 等待中│
├─────────────────────────────────────────────┤
│ 刚刚完成 (n)                                 │  L6：只有列表
│  38px 海报 │ 剧名 · 装了M集 │ 查看            │
└─────────────────────────────────────────────┘
```

hero:队列 图片尺寸比 ~5:1 —— 层级靠**图片大小**编码，因此不需要徽章/状态列/术语。

## 4. 阶段进度条（L10 的落地）

### 4.1 数据来源（已核实可观测）

`traceBus` 事件带 `tool` 字段（`src/core/traceBus.ts:14`），SSE 已在直播，前端已消费
（`TraceRows.tsx`）。阶段**是观测到的，不是编的**。

`WorkflowRunningWorkerDTO.trail` 已提供 `traceBus.peek` 的尾部 20 条，首屏即有初始阶段。

### 4.2 阶段权重

工具名取自真实注册表：`src/agent/findSubtitleWorker.ts:175-208`（字幕工具 + 条件挂载的识别
工具）与 `src/agent/reasoningAgent.ts:19/104/125`（`finalize` 由 reasoningAgent 统一注入，
**不在** findSubtitleWorker 的表里）。

| 到达阶段 | 触发工具 | 条宽 |
|---|---|---|
| 起手 | （run 开始，尚无工具事件） | 6% |
| 在认片子 | `search_tmdb` / `get_tmdb_details` / `write_identified_media` | 14% |
| 在搜来源 | `search_source` | 22% |
| 在核对候选 | `list_candidates` / `get_candidate` | 44% |
| 在下载 | `download_candidate` | 66% |
| 在装到位 | `install_subtitle` | 88% |
| 收尾 | `finalize` | 100% |

**不推进阶段但仍进传送带**（辅助动作，可在任意阶段发生）：
`read_doc`、`check_episode_code_safety`。

识别三工具（`search_tmdb`/`get_tmdb_details`/`write_identified_media`）是**条件挂载**的：
前两个仅 `deps.tmdb` 非空时挂上，第三个仅 `identityDeps` 提供时挂上
（`findSubtitleWorker.ts:204/208`）。它们不出现时阶段表照常工作——14% 那档只是不会被触发。

### 4.2.1 必须有兜底分支（不许落未定义）

阶段函数**必须**对未登记工具名返回 `null`（= 不推进），而不是 `undefined` 或抛错。
理由：工具表会随后端演进（本 spec 初稿就漏了上面三个识别工具），未来新增工具必然先于
UI 更新到达。兜底返回 null 时进度条停在原处、传送带照常显示该行——诚实降级。

判据见 §11.10。

### 4.2.2 `taskType` 不止一种（自审补漏）

`jobs.payload.taskType` 实际有四种值：`find_subtitle` / `realign` / `translate` /
`orchestrate`（`orchestratorAgent.tools.ts:287/369/421`、`realignWorkerTask.ts:6`、
`translateWorkerTask.ts:98`）。上面那张权重表**只覆盖 `find_subtitle`**。

本期范围裁决：
- `find_subtitle`：按 §4.2 表走阶段进度条。
- `realign` / `translate`：**不显示阶段进度条**，改显示不定态（indeterminate）的细条 +
  传送带照常。理由：这两族的工具序列本 spec 未调研，凭空给权重就是编造（违反"阶段是观测到的"
  这个前提）。不定态条诚实表达"在干活、但阶段未建模"。
- `orchestrate`：不进 hero（那是编排层，属 L3 要隐藏的机械）。

`realign` 另有一个既有陷阱：它**逐集起 runKey**（`job-${jobId}-${absoluteEpisode}`），
后端已用 `peekPrefix` 合并（`apiV2.ts:959-961`）。前端按 `trail` 直接消费即可，
但 `key` 必须带 runKey（§5 已要求），否则多子集的 `seq=0` 会撞 React key。

### 4.3 单调不倒退（关键）

只取"到达过的最远阶段"：`stage = max(stage, weightOf(tool))`。

理由：agent 反复搜多个来源时会回到 `search_source`，条若倒退用户会以为出问题了。
多来源搜索因此表现为**条停在 22% 但传送带在动**——这个组合恰好准确：进度没变，但确实在干活。

### 4.4 不预测剩余时间

不做 ETA。搜 5 个来源还是 1 个取决于运气，给一个会跳的假 ETA 比不给更伤信任。
只给 `已进行 2 分 14 秒`，让用户自己判断。

## 5. 传送带（L8 + L9）

- 整列 `translateY`，新行在**底部**，旧行被顶出**上边界**。
- **整行步进**：位移恒为 `-20px × 溢出行数`，容器高 = `4 × 20px = 80px`。
  行要么完整可见、要么完全在界外，**永不切半行**（这是硬出的前提，L9 去掉遮罩后
  半行浮在边界上会很难看）。
- 副作用好处：位移不需要测量 DOM 高度（测量是 layout thrash 常见来源）。
- 亮度分级：`:nth-last-child(1..4)` 由亮到暗，`n+5` 最暗。**不是 opacity**（状态→颜色，
  见 ai-elements `ChainOfThought` 口径）。
- **只动新行**：容器 bottom-pinned + 正常文档流，旧行由 compositor 自然上移，
  不对"被顶走"做动画（assistant-ui `reasoning.tsx` 的做法）。
- `slide-in-from-top-2`、200ms、`cubic-bezier(0.32,0.72,0,1)`。零动效依赖。
- React `key` 必须是稳定的事件 id（`${runKey}#${seq}`，同 TraceRows 既有口径）；
  用数组下标会让入场动画只触发一次。

### 5.1 无障碍

容器 `role="log"`（WCAG ARIA23）。该规范**明确允许旧信息消失**，所以传送带合规。
不加 `aria-live="assertive"`（会把每条痕迹念出来，噪音）。

## 6. 词汇表（L1/L2/L3 的落地）

痕迹行短语走 `workflow/phrases.ts` 的 `toolPhrase(tool, lang)`（L12，已实现）。

状态词只有三档，**没有黄**：

| 语义 | 颜色 | 中文 | 英文 |
|---|---|---|---|
| 成功 | 绿 `#3fb950` | 字幕已装好 | subtitles installed |
| 中性/等待 | 灰 `#6e7681` | 稍后会再试一次 / 等待中 | will retry later / queued |
| 真故障 | 红 `#f85149` | 遇到问题——会重试 | hit a problem — will retry |

**"没找到能放心用的字幕"是灰不是红**（铁律④既有口径：等待/失败是面向下一步的中性事实）。
红只给**真故障**，且红只染点不铺块。

`tone` 与语言无关（`phrases.ts` 已如此实现），所以这条在中英同时成立。

## 7. 空态与卡死态（L6/L7）

### 7.1 全部齐了（最常见状态）

**不写"字幕都齐了"**（L6）。渲染：
- 一行诚实状态行 + **新鲜度时间戳**（`最近检查 3 分钟前`）
- 下面是"刚刚完成"列表，**用与 hero 同几何的海报**

时间戳是唯一"崩掉的系统produce不出来"的廉价元件；NN/G 记载未加限定的空态是最伤信任的设计。

### 7.2 卡死/出问题（L7 的张力）

L7 说不做点开看 trace，但**问题必须看得见**。解法：
- hero 副标题直接写红字事实（`遇到问题——会重试`）+ 红点
- 进度条**保持在故障发生时的阶段**，不清零、不变红条（L1：红只给点不给块）
- **不提供展开**。要查就去看真实日志——这是用户明确的取舍。

## 8. 数据来源与两个真实缺口

### 8.1 已有（无需改后端）

| UI 需要 | 来源 | 备注 |
|---|---|---|
| hero 主语 | `WorkflowRunningWorkerDTO.seriesName / movieName`（`apiV2.ts:848/849`） | null 时诚实降级为 id |
| 找哪些季 | `WorkflowRunningWorkerDTO.seasons: number[] \| null`（`:853`） | `null` = **当前有缺口的每一季**（不是字面全季）；空数组亦折成 null（`orchestratorAgent.tools.ts:247/287`） |
| 传送带初始行 | `WorkflowRunningWorkerDTO.trail`（`:855`） | 尾部 **20** 条；find_subtitle 走 `peek`，realign 走 `peekPrefix`（`apiV2.ts:959-961`） |
| 传送带增量 | 既有 SSE `trace-stream` | 已在跑 |
| 已进行时长 | `startedAtLease`（`:845`） | |
| 缺口集数 | `GET workflow/pending` → **`series[].missing`**（`WorkflowPendingSeriesDTO`，`apiV2.ts:699-707`） | ⚠️ **不是 `missingBySeason`**——那是 `LibraryRepo` 的方法名（`libraryRepo.ts:532`），`buildWorkflowPending` 已改名为 `series`（`apiV2.ts:741`）。按错名写会取到 undefined |
| 刚刚完成 | `WorkflowWorkersDTO.recent[]`（`decision` 在 `:860`） | 带 `decision` → `decisionPhrase` |
| 图片 URL | `posterUrl` / `backdropUrl` / `stillUrl`（`web/src/api/client.ts:28/39/45`） | 浏览器直连 TMDB，免 key |

### 8.2 缺口 ①：running/recent DTO 没有图片字段（阻断 L4）

`WorkflowRunningWorkerDTO` 与 `WorkflowRecentRunDTO` 只有 `seriesName/movieName`，
**没有 `posterPath/backdropPath`**。L4 要求必须有图 → 必须补。

改动：两个 DTO 各加
- `posterPath: string \| null`
- `backdropPath: string \| null`（仅 series 有，见 ②）

后端在既有 `LEFT JOIN series/movies`（`apiV2.ts` 的 `seriesName` 已经这么取）上多选两列即可，
**不新增查询、不新增端点**。

### 8.3 缺口 ②：`movies` 表没有 backdrop（真实不对称）

已核实：`series` 有 `poster_path` + `backdrop_path`（`src/v2/db.ts:279` 的 v-migration），
但 **`movies` 只有 `poster_path`**（`db.ts:49`）。

所有 mockup 都用剧集演示，**从未验证电影 hero**。这是真实约束，不是可以糊过去的细节。

裁决：**电影 hero 不用背景大图**，改为
- 海报放大到 140px 宽（2:3）
- 背景用海报本身的**模糊放大版**（`filter: blur(40px) saturate(1.4)`, `transform: scale(1.2)`）

理由：不为一个字段去改 schema + 回填 TMDB；模糊海报做背景是 Spotify/Apple Music 的成熟做法，
视觉上成立，且**不需要任何后端改动**。

> 这一条必须在实现时用真实电影数据看一眼，不许只在剧集上验完就收工。

## 9. 不做的（明确排除）

- ❌ 不做播放器/字幕预览（已裁决：DTS-HD/TrueHD 浏览器无法解码；Chromium 不带 HEVC 软解且静默失败；
  MKV 在 `<video>` 不支持。Bazarr 8 年没有预览器）
- ❌ 不做 ETA
- ❌ 不做点开看 trace（L7）
- ❌ 不做暂停（L11）
- ❌ 不做黄色任何一档（L1）
- ❌ 不双语化 `text.ts` / `zh.ts` 那 36 个 `en.*` 引用键——它们属于本页要替换掉的旧组件，
  等本 spec 实现后随旧组件一起删

## 10. 复用 vs 新建

| 现有文件 | 处置 |
|---|---|
| `workflow/phrases.ts` | **复用**（已双语化 + 已修工具表脱节） |
| `workflow/time.ts` `formatTookMs` | 复用 |
| `workflow/traceStream.ts` | **复用**（SSE 单例连接，含断线重连） |
| `workflow/trail.ts` | **复用**（`mergeTrail` 去重合流——realign 多子集 runKey 的合并逻辑已在这里，别重写） |
| `workflow/useLiveTrail.ts` | **复用**（trail + SSE 增量的 hook，正是传送带需要的数据源） |
| `workflow/rerun.ts` | 保留（RunDetail/RerunDialog 用，活动页不引） |
| `workflow/TraceRows.tsx` | 不复用（Inngest 式三段网格 ≠ 传送带）；但其 `key=${runKey}#${seq}` 口径照抄 |
| `workflow/Lanes.tsx` `PendingLane.tsx` `ActivityFeed.tsx` `SummaryLine.tsx` | 本页上线后**删除** |
| `workflow/RunDetail.tsx` `RerunDialog.tsx` | **保留**（L7 只说活动页不给展开入口；RunDetail 仍是排障用的独立路由） |
| `library/PosterThumb.tsx` | 复用（队列行 38px 海报） |

## 11. 验收判据（可执行，非"看起来对"）

1. `tsc --noEmit` 0 错误；`web` 测试全绿（当前基线 304）。
2. 阶段单调性：喂入 `search_source → download_candidate → search_source` 三事件，
   条宽必须是 22% → 66% → **66%**（不回退到 22%）。
3. 传送带整行：容器高恒为 20 的整数倍；喂 7 条事件后，第 1-3 条必须
   `getBoundingClientRect().bottom <= 容器 top`（完全在界外，非半行）。
4. L1 回归锁：全页 CSS 与内联样式**不含任何黄/琥珀色值**（grep `#f0b|#d29|amber|warning` 为空）。
5. L2 回归锁：DOM 里不出现 `%`、`score`、`offset`、`confidence`、`ms` 形式的内部数值
   （`已进行 2 分 14 秒` 与 `4.0s` 耗时属允许的时间事实，不是评分）。
6. L3 回归锁：渲染后的 `textContent` 不含 `agent|orchestrator|worker|pass|asset|ledger`
   （大小写不敏感）。
7. L6：全部齐了的状态下，DOM 不含"齐"字样的断言句；必须存在新鲜度时间戳元素。
8. 中英各渲染一次，痕迹短语分别为中/英（L12）。
9. **电影 hero 用真实电影数据人工看一眼**（缺口 ② 的强制项）。
10. 阶段兜底（§4.2.1）：`stageOf('some_future_tool')` 必须返回 `null`，不抛错、不 undefined；
    喂入 `search_source → some_future_tool` 后条宽必须仍为 22%（未知工具不推进也不清零）。
11. `taskType` 分族（§4.2.2）：`realign` / `translate` 的 hero 必须**没有**阶段进度条元素，
    而是不定态条；`orchestrate` 不得出现在 hero。
12. `missingBySeason` 回归锁：全前端代码 grep `missingBySeason` 必须为空
    （那是后端 repo 的方法名，前端 DTO 里叫 `series`——审计发现的真实踩坑点）。

## 12. 实现顺序

1. 后端补两个 DTO 字段（缺口 ①）+ 测试。
2. `stageOf(tool)` 纯函数 + 单调 reducer + 测试（判据 2）。
3. 传送带组件（整行步进 + 硬出）+ 测试（判据 3）。
4. hero（剧集路径：backdrop 出血）。
5. hero（电影路径：模糊海报，缺口 ②）→ 人工看一眼。
6. 队列 + 刚刚完成两段。
7. 空态/卡死态（§7）。
8. 三条回归锁（判据 4/5/6）。
9. 删旧组件（§10）+ 清 `zh.ts` 里随之失效的键。
