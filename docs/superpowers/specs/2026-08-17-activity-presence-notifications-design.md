# Spec：活动页在场感 + 通知成果卡 + 片库刷新

日期：2026-08-17 ｜ 状态：用户已批准（在跑卡骨架、通知 C、出血 A、i18n 跟界面语言）｜ 上游：活动页「正在处理」无进度、`1/1` 无信息、无进度条、看不到步骤、在跑作品仍在排队、装完仍「等待重试」、排队卡右侧缺口、媒体库不刷新、通知像 MVP、海报出血要渐变遮罩

本 spec **取代** 2026-07-30 活动页 spec 的 L9（硬出、不做渐隐遮罩）与 L10（进度条=agent 阶段、不写百分比数字）在**在跑卡片**上的效力。队列卡仍用 2:3 竖海报（L5 保留）。Workflow 页不复活。

## 1. 问题（每条必须有解法）

| # | 用户原话 / 现场 | 根因（代码） | 本 spec 解法 |
| --- | --- | --- | --- |
| P1 | 正在处理、无进度 | daemon `progress.data.done/total` 是本轮**作品队列**下标；单作品 inspect → 一次 `1/1`，装盘过程零 tick | §3：粒度改成当前作品的文件数；开工 `0/N`；每次装盘成功 +1 |
| P2 | `1/1` 没有信息 | 同上；`RunCard` 只渲染 `"${index}/${total}"` 字符串 | §4：百分比条 + 人话步骤 + 已用时 + 滚动 log |
| P3 | 无进度条 | `RunCard` 没有条 | §4.2 `role="progressbar"`，值=已装文件/本作品文件 |
| P4 | 看不到 agent 步骤 | 步骤在 `traceBus`（`/api/v2/workflow/trace-stream`）；活动页不订；`onStepEvent` 不转发 reasoning | §3.3：飞行中把 `trace.tool` 折进现有 `progress` SSE 的 `data.step`；UI 映射 i18n，不订第二条 SSE，不渲染 CoT |
| P5 | 在跑的作品仍在排队 | `GET /api/v2/activity` 用 `includeBackoff: true`，飞行中作品不出队；前端不过滤 `current.workId`；测试锁「SSE 1/1 且队列仍显示该项」 | §5：当前 tab 列表剔掉 `current.workId`；改掉那条锁错行为的测试 |
| P6 | 装完仍「等待重试」 | `markInstalled` 写 `recheck_after=now+1d`、`sub_recheck_at=0`，**不写** `covered`、不 `requestScan`；`dueNow=false` → `wb_queue_retry_in` | §6：字幕装盘后 `requestScan()`（与翻译同款）；DTO 加 `awaitingRescan`；文案走核对片库 |
| P7 | 排队卡右侧像缺一块 | `.wb-queue-fade` 混用 `44%`/`68%`（相对**整卡宽**）和 `118px` | §8.2：stop 纯 px |
| P8 | 图例右侧缺一块 | `.media-legend` 未 `width: 100%` | §8.3 |
| P9 | 媒体库成功后不更新 | 字幕 found 不 `requestScan`；`useMediaLibrary` / `useMediaLibraryDetail` 一次加载、不订 `found` | §6 + §7 |
| P10 | 通知像 MVP | GET 是账本但 SSE 只点亮「点击刷新」；英文 title、无图、无下一动作密度 | §9：found 自动重拉；当天 C 英雄卡；读时 join 中文名+backdrop |
| P11 | 海报出血要渐变遮罩、真 TMDB 16:9 | `.wb-run-fade` 是罩一层黑；mock 曾用假色块 | §8.1：`mask-image` 溶进 `--color-card`；字在左（方案 A）；`backdropUrl(w1280)` |
| P12 | 新逻辑显示语言跟界面语言 | mock 写死中文；片名无条件 `chineseTitle ?? title` | §10：chrome 进 `en.ts`/`zh.ts`；片名按 `lang` |

## 2. 范围

**In**

- `ScoutCurrent` 补 `workId` / `backdropPath` / `chineseTitle` / `startedAt` / `lastStep`（一律 `| null`，进 `/health`）。
- 字幕/翻译在跑：同一卡片骨架（条 + 人话 + 已用时 + log）。
- `progress.data.done/total` = 当前作品文件进度。
- `traceBus` → 现有 `progress` SSE（`data.step` = 稳定工具 id）。
- 队列前端过滤 `current.workId`；`awaitingRescan` 文案。
- 字幕装盘成功 → `requestScan()`。
- 媒体库 hook：`found` 重拉 + `health.current` 有→无再拉一次。
- 通知：去掉点击刷新横幅；当天英雄卡 C+A；更早的天同一出血矮卡。
- `FoundGroup` 读时 join `chineseTitle` + `backdropPath`。
- 在跑/通知 16:9 mask；排队卡 fade 纯 px；legend `width: 100%`。
- 新 chrome 双表 i18n。

**Out**

- 复活 Workflow 页或活动页订 `/api/v2/workflow/trace-stream`。
- 第二条用户 SSE。
- raw CoT / reasoning token 进 `aria-live` 或 log 正文。
- 已读/未读。
- 给 `t()` 加插值引擎。
- 新语言开关（仍是 wizard 首选语言 → `scout-lang`）。
- 媒体库海报墙全局改标题策略（只改本 spec 的新表面）。
- 排队卡改成 16:9。
- 让 `markInstalled` 直接写 `covered`（R24：只有扫描写 covered）。
- 改 `PROGRESS_THROTTLE_MS`（1s 保留）。`updateCurrent` 已在节流之前，保持。

## 3. 进度合约

### 3.1 `ScoutCurrent`（`src/core/scoutEvents.ts` + `ScoutCurrentDTO`）

现有 `kind/title/index/total` 保留。新增（JSON 里必须出现，禁止 `undefined` 消失）：

| 字段 | 含义 | 谁写 |
| --- | --- | --- |
| `workId` | `works.id` | activity/progress 的 `data.workId` |
| `backdropPath` | TMDB 裸路径，前端 `backdropUrl` | 同，从 works 行带上。无图 → `null` |
| `chineseTitle` | 中文译名或 `null` | 同 |
| `startedAt` | 这部作品开工的 epoch ms | activity 那条，总线 `now()` |
| `lastStep` | 稳定工具 id（如 `search_source`），**不是**译文 | progress `data.step`；没有 step 的 progress 保留旧值 |

`updateCurrent`：

- 无 `workbench` → `current = null`（不变）。
- `activity` + 有 workbench → 新作品：`index/total = null`，写入 `workId/backdropPath/chineseTitle`，`startedAt = now()`，`lastStep = null`。
- `progress` → 写 `index/total`（`data.done/total` 非有限数 → `null`）；`workId/backdropPath/chineseTitle` 若本条 `data` 有则覆盖，缺席则**保留**上一次（progress 不必每条重复静态资料）；`startedAt` 保留；`data.step` 为非空字符串则更新 `lastStep`。
- `found` / `health` 仍不动 `current`。

前端 `useCurrentState` 的本地 `Current` 不再把 `workId` 当成「只有 SSE 才有」。`/health` 快照必须带齐，重连不断图、不断时。

**禁止**用 title 去队列里反查 `workId`（同名翻拍）。

### 3.2 daemon：文件粒度

字幕（`daemonV2` 阶段 3）与翻译（阶段 4）同一口径。

开工立刻发一条 progress（可与 activity 紧挨着）：

```
data: { done: 0, total: fileCount, workId, backdropPath, chineseTitle }
```

`fileCount` = 这次派给 worker 的文件数（字幕=`item.files.length`；翻译=该作品本轮候选文件数）。**不是** `subtitleQueue.length`。

每成功装盘一文件再发 progress：`done` 为本作品已装上的累计（1…N），`total` 不变。发送点：字幕在 `subtitleScheduler` `markInstalled` 成功回写之后（路径反解成功才算）；翻译在既有 installed 回写点。禁止用「作品在队列里的序号」冒充 `done`。

作品结束（worker 返回）不必为了清零再发一条；下一部的 activity 会重置。巡检结束的无 workbench activity 仍清 `current`。

### 3.3 `traceBus` → `progress`（一条 SSE）

不新开端点。活动页继续只订 `/api/v2/events`。

飞行中：daemon 对当前 `runKey`（已有 `job-${jobId}`）订阅 `traceBus`。每条 `TraceEvent.tool` 发 progress：

```
data: { done, total, workId, step: tool }
```

`done/total` 用内存里最后一次文件进度（开工后是 0/N，装盘后递增）。`step` 是工具**名**原样（`search_source`、`install_subtitle`、`resolve_source`、`finalize`…）。

退订：该作品 `runSubtitleWorkDir` / 翻译对应 runner 的 `finally`。漏退订会把下一作品的步骤串到上一张卡——测试必须钉退订。

节流仍 1s/工作台。被折掉的 step 仍通过 `updateCurrent` 写进 `lastStep`，所以 `/health` 与重连看得到最后一步；滚动 log 只追加**实际送到浏览器**的 progress（允许 1s 内丢中间步，不允许编造没发生的步）。

`message` 字段可继续给日志用中文/英文内部句；**前端在跑卡与通知卡禁止渲染 `event.message`**。正文只来自 i18n 键 + DTO 片名。

## 4. 在跑卡片 UI

字幕 tab / 翻译 tab **同一组件骨架**。翻译的条按本作品本轮文件走，不另发明细阶段条。

### 4.1 布局（方案 A）

- 卡片高度沿用 `--card-run-h`（186px）。
- 图：`backdropUrl(backdropPath)` → `w1280`，`object-fit: cover`，`object-position` 保持主体（默认 `70% 38%`）。
- **字在左**（约 46% 宽），图在右。
- 无图：`data-noimg`，实色卡，不回落 2:3 poster（现纪律保留）。

### 4.2 内容

| 元素 | 规则 |
| --- | --- |
| 标题 | §10.2 |
| 副标题 | i18n「正在装字幕/正在翻译」+ 已用时（`now - startedAt`）。`startedAt` null 则不显示时分 |
| 条 | `role="progressbar"`，`aria-valuenow=done`，`aria-valuemin=0`，`aria-valuemax=total`。`index` 或 `total` 为 null 时**整条不渲染**（诚实 null，不编 0/0） |
| 分数行 | i18n 拼 `done / total`（prefix/suffix 或 `lang` 分支）。null 则整行不渲染 |
| 当前步 | `lastStep` → §10.1 闭包映射 → 一句人话。null 不渲染 |
| log | 最近最多 5 条已送达的 step 译文，`role="log"`。最新一条高对比，上方渐隐。不进 `aria-live` 的 raw 文本 |
| stale | 现有 `wb_run_maybe_stale` 保留 |

百分比数字可以出现在分数行（「3 / 6」），条本身是装饰+progressbar 无障碍，不在条上叠「50%」字。

## 5. 排队

GET `/api/v2/activity` **仍返回**飞行中作品（谓词不改，避免与 daemon 取件漂移）。

前端当前 tab：

```
queue.filter(item => item.workId !== current?.workId)
```

`current` 为 null 或 `kind` 与 tab 不符时不过滤。

**禁止**用 `queue.length` 当进度分母（既有纪律保留）。

改 `ActivityPage.test.tsx` 里锁「SSE 说 1/1 且队列仍显示该 workId」的用例：改为「在跑 workId 不出现在排队段」。另一条「进度来自 SSE 不是 queue.length」保留。

## 6. 装盘后扫描 + 「等待重试」假话

字幕 `found` 路径（`report.installed.length > 0`）调用 `this.requestScan()`，与 `translateWorkerTask` installed 分支同型。扫描仍只写 `covered`（R24）。

`ActivityQueueItemDTO` 增：

```
awaitingRescan: boolean
```

定义：该簇**每一个**仍在排队谓词里的文件都满足 `sub_recheck_at === 0`（`markInstalled` 的 IMMEDIATE_RECHECK 哨兵）。真失败退避（`bump` 写 `recheck_after=now+1d`、**不**把 `sub_recheck_at` 置 0）→ `false`。

前端：`awaitingRescan` → `wb_queue_awaiting_scan`（核对片库）。`dueNow === false && !awaitingRescan` 才用 `wb_queue_retry_in`。

翻译台若无该哨兵：`awaitingRescan` 恒 `false`（字段仍在，JSON 不许缺席）。

## 7. 媒体库刷新

`useMediaLibrary` / `useMediaLibraryDetail` **不定时轮询**（R-F6）。

新增触发（挂在已有 `reload()`）：

1. SSE `found`（与通知同一条事件）。
2. `health.current` 从非 null 变成 null（本轮扫盘已排进主循环；coverage 在 `scanOnce` 之后才真）。

首载仍一次。错误态「重试」按钮仍在。

点进详情：扫描完成后格是覆盖态，不是 pending `...`。测试：found 后 hook 再请求一次；current 变 null 再请求一次。

## 8. 视觉

### 8.1 在跑 / 通知英雄：mask 不是 overlay

删掉「罩一层黑保证字底下永远实色」作为有图时的主路径。有图时：

```
.wb-run-img {
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 70% 38%;
  -webkit-mask-image: linear-gradient(to left, #000 0%, #000 42%, transparent 78%);
          mask-image: linear-gradient(to left, #000 0%, #000 42%, transparent 78%);
}
.wb-run-body { margin-left: 0; width: 46%; }
```

无图：不渲染 img；`.wb-run-fade` 仅在 `data-noimg` 时铺 `--color-card`（或直接不画 fade）。有图时 fade 层不存在或不透明度为 0——**禁止**再叠一层把图压暗。

`cards.css.test.ts` 里断言 `.wb-run-fade` 终点 `var(--card-run-img)` 的那条改为：有图走 `mask-image`；排队卡 overlay 纪律不变（仍 2:3 + 118px fade）。

通知英雄卡复用同一套 class（可抽 `.wb-hero-bleed`），高度可略矮（168px），mask 同。

### 8.2 排队卡 fade

`.wb-queue-fade` 全部 stop 用 px（`--card-queue-fade` = 118px）：

```
rgba(1,1,2,0) 0,
rgba(1,1,2,.2) 40px,
var(--color-card) 118px
```

禁止 `%` 与 px 混用。测试钉：声明里没有 `%`。

### 8.3 图例

`.media-legend { width: 100%; }`。测试钉该声明。

## 9. 通知

分工不变：**列表只由 GET `/api/v2/notifications` 出**。SSE 不插行。

变：`found` → **自动 `reload()`**。删除 `NewFoundBanner` 的「有新字幕 · 点击刷新」交互（组件可删或永不满）。`sseSeparation.test.tsx` 改为：found 后列表仍不直接插 SSE 剧名，但 **会**再打 GET；新组来自端点。

不做已读。整卡仍点进 `mediaItemHref(workId)`。

`FoundGroup` 增（读时 LEFT JOIN `works`，与 `mediaType` 同型，**不**改写入快照 `title`）：

| 字段 | 规则 |
| --- | --- |
| `chineseTitle` | `firstChineseTitle(works.chinese_titles)`，无则 `null` |
| `backdropPath` | `works.backdrop_path`，无则 `null` |

当天（`offset === 0` 的桶）每组一张 C 英雄卡：16:9 mask、标题 §10.2、成果句（既有 `notif_*` 形状 + 新拟「第 1 季已经齐了」仅当该季通知集数覆盖该季在库集数——**若端点没有「齐了」事实则不要编**，退回既有「第 3/5/7 集」句）、ghost「去片库看」。

更早的天：同一出血的矮卡（高度收一档，约 88–110px），不要回到无图英文行。

`via` 仍用现有 `notif_via_*`。

## 10. i18n

界面语言 = `useT().lang`（`en` \| `zh`），wizard 首选语言联动，本 spec 不改开关。

### 10.1 Chrome（双表都要写，key-parity 测试会红到人补）

| 键 | zh | en |
| --- | --- | --- |
| `wb_run_subtitle` | 正在装字幕 | Installing subtitles |
| `wb_run_translate` | 正在翻译 | Translating |
| `wb_run_files_done_suffix` | 集已装上 | files done |
| `wb_step_search` | 正在搜源 | Searching sources |
| `wb_step_review` | 正在看候选 | Checking candidates |
| `wb_step_download` | 正在下载 | Downloading |
| `wb_step_install` | 正在安装 | Installing |
| `wb_step_wrapup` | 正在收尾 | Wrapping up |
| `wb_step_working` | 还在处理 | Still working |
| `wb_queue_awaiting_scan` | 正在核对片库 | Checking the library |
| `notif_open_library` | 去片库看 | Open in library |

分数行不给 `t()` 加插值：`${done} / ${total}` + 空格 + `t('wb_run_files_done_suffix')`。电影与翻译共用同一 suffix（不必再拆「集/段」——数字已经是文件粒度）。

工具 id → 键（闭包，未知 → `wb_step_working`，**永不**把 `tool` 字符串画上屏幕）：

字幕（`findSubtitleWorker`）+ 识别：

```
search_source, search_tmdb, get_tmdb_details, write_identified_media
  → wb_step_search
list_candidates, get_candidate
  → wb_step_review
download_candidate
  → wb_step_download
install_subtitle
  → wb_step_install
finalize
  → wb_step_wrapup
```

翻译（`makeTranslateWorkspaceTools` 的导出键 + `read_doc` + `finalize`）：

```
resolve_source, read_doc, fetch_tmdb_context, fetch_series_target_subs,
fetch_wiki_context, materialize_agent_view, read_workspace_doc,
lookup_glossary, freeze_glossary
  → wb_step_search
list_rows, get_window, run_critic, run_structural_gate
  → wb_step_review
merge_to_srt, install_sidecar
  → wb_step_install
finalize
  → wb_step_wrapup
```

`update_row` / `update_rows` / `update_summary` 以及任何未列名 → `wb_step_working`。

已用时：沿用活动页现有 `lang === 'zh' ? …` 相对时间拼法，或抽到 `workbench/text.ts`。不新增插值引擎。

`en` 下渲染在跑卡/通知英雄：**不得**出现「正在装字幕」「搜源」「去片库看」「正在核对片库」等 §10.1 的中文 chrome。测试用 `initialLang="en"` 钉。

本区**不是** Workflow 痕迹，不受「Workflow 区永不本地化」约束。

### 10.2 片名

仅本 spec 新表面（在跑卡、通知英雄/矮卡）：

- `lang === 'zh'` → `chineseTitle ?? title`
- `lang === 'en'` → `title`

队列卡已用 `chineseTitle ?? title`：本轮一并改成与上式相同，避免同一页中英混用。媒体库海报墙/详情**不改**。

## 11. 测试锁（最低集）

- `ScoutCurrent`：activity 写入新字段；progress 更新 done/total 与 lastStep、静态字段缺席时保留；无 workbench 清空。
- daemon：单作品 6 文件 → 先 `0/6` 再随装盘 `1/6`…；**没有** `1/1` 当作品下标。
- 字幕 installed → `requestScan` 被调用。
- trace 订阅：飞行中 progress 带 `step`；finally 后退订，下一部不串步。
- ActivityPage：current.workId 不在排队 DOM；进度仍不来自 `queue.length`。
- `awaitingRescan` true → 中文「正在核对片库」，不是「等待重试」。
- CSS：queue-fade 无 `%`；legend `width: 100%`；run img 有 `mask-image`。
- i18n key-parity；en 在跑卡无上述中文 chrome。
- 通知：found 触发 GET；列表仍不插 SSE 里端点没有的剧。
- FoundGroup 形状含 `chineseTitle`/`backdropPath`（typeContract + 运行时 shape）。
- 媒体 hook：found 与 current→null 各触发 reload。

锁错行为的旧测试（队列仍显示在跑项；通知 found 禁止自动 GET）必须改，不许拿它们反驳本 spec。

## 12. 对 2026-07-30 活动页 spec 的显式覆盖

| 旧铁律 | 本 spec |
| --- | --- |
| L9 硬出、不做渐隐遮罩 | 在跑/通知英雄：**做** `mask-image` 溶边。队列卡仍 overlay，但 stop 纯 px |
| L10 条=agent 阶段、不写百分比数字 | 条=本作品已装文件 / 文件总数；分数行写 `done / total`；agent 阶段改走人话 + log |
| L12 痕迹短语跟随 UI 语言 | **继承**，落实为 §10 |
| L5 队列 2:3 | 继承 |
| L7 不做点开 trace | 继承：不复活 Workflow，log 只显示映射后的人话 |

## 13. 自审

占位：无 TBD。内部：`updateCurrent` 在节流前（已是现状）与 lastStep 一致；队列过滤只在前端以免改取件谓词。范围：一块实现计划可吞；若任务过长按后端合约 / 在跑 UI / 通知+片库 切，但仍是同一 spec。歧义已钉：进度分母=文件不是作品；mask 不是 overlay；未知工具 → `wb_step_working`；「齐了」无数据就不说。
