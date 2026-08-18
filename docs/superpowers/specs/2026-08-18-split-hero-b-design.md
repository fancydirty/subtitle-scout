# Spec：活动 / 通知 / 排队共用 B 切分英雄卡

日期：2026-08-18 ｜ 状态：用户已批准（几何 + 三张卡右栏 + 排队也改 B；明示开干）｜ 上游：通知矮卡 96px 裁掉标题；全幅 mask 在可变宽下把 16:9 海报拉变形；排队仍 2:3 与在跑/通知不是同一套语言

本 spec **覆盖** `docs/superpowers/specs/2026-08-17-activity-presence-notifications-design.md` 的 §4.1、§8.1、§8.2、§9「更早的天矮卡」、§12 表里的 L5 / L9 队列行。进度合约、SSE、队列过滤 `current.workId`、`requestScan`、片库刷新、i18n 键与片名规则 **不改**。

## 1. 问题

| # | 现场 | 根因 | 解法 |
| --- | --- | --- | --- |
| S1 | 昨天通知只见副行 +「去片库看」，片名在 DOM 里但看不见 | `.notif-hero-compact { height: 96px }` + `overflow:hidden` + 标题/副行/按钮垂直居中 | 取消 compact；今天与昨天同一高度 |
| S2 | 全幅 backdrop + 字叠在 mask 上，宽一变 16:9 被卡高扯变形 | `.wb-run-card { height: var(--card-run-h) }` 图 `inset:0` 铺满 | 方案 B：左栏自己锁 16:9，卡高 = 左栏高 |
| S3 | 排队 2:3 竖海报，与在跑/通知不是一套 | L5 + `.wb-queue-*` 独立几何 | 排队改吃同一套 B |

## 2. 范围

**In**

- 在跑卡、排队卡、通知行（今天 + 昨天）共用 B chrome。
- 排队图源从 `posterUrl` 改为 `backdropUrl`（w1280）。
- 删 `--card-run-h` / `--card-run-img` / `--card-queue-w` / `--card-queue-h` / `--card-queue-fade`、`.notif-hero-compact`、`.wb-queue-fade` overlay。
- 改掉锁旧几何的测试。

**Out**

- 媒体库墙仍 2:3 poster（L5 只在片库保留）。
- 后端 DTO / daemon / SSE / `awaitingRescan` / 通知 GET 分工。
- 新 i18n 键。不编「这一季齐了」。
- Workflow 页。第二条 SSE。`t()` 插值引擎。

## 3. 共用 chrome（B）

三张卡同一骨架。语义 class 可保留（`wb-run-card` / `wb-queue-card` / `notif-row`），几何只写一套。

### 3.1 有图

- 左：`backdropUrl(path)` → `w1280`。宽 `var(--card-split-poster)`（`:root` 上 **61%**）。`aspect-ratio: 16 / 9`。`object-fit: cover`。`object-position: 70% 38%`。
- 卡：`display: flex`；**不定高**。卡高由左栏 16:9 决定，禁止 `height: 186px` / `height: 96px` / `height: var(--card-run-h)`。
- mask 在 img 上，方向 **朝右溶进右栏**（字在右）：

```
-webkit-mask-image: linear-gradient(to right, #000 58%, transparent 100%);
        mask-image: linear-gradient(to right, #000 58%, transparent 100%);
```

禁止再罩一层半透明黑 / `.wb-run-fade` / `.wb-queue-fade`。禁止 mask `to left`（那是字在左的旧方案 A）。
- 右：实色 `--color-card`。`flex: 1`；`min-width: 0`；`overflow: hidden`（log 再长也不撑破 16:9）。`text-align: right`。字只写在这一栏。
- 仍不许 `clamp()`、不许 `box-shadow`。尺寸继续走 CSS 变量，移动端只改变量。

### 3.2 无图

`data-noimg='true'`。不渲染 img，不留空海报槽，不回落 2:3 poster。

**有 poster 无 backdrop = 无图。** 竖图塞进 16:9 会变形。

右栏（此时是整张卡）`text-align: left`，高度跟内容。

## 4. 组件

抽 `SplitHero`（可放在 `web/src/workbench/WorkbenchCards.tsx` 或同目录新文件）。职责：取 `src`、`onError` → `data-noimg`、左 img / 右 children。`RunCard` / `QueueCard` / `NotificationRow` 只填右栏。

| 表面 | 根节点 | 图 | 右栏（上→下，有图时右对齐） |
| --- | --- | --- | --- |
| 通知 | 仍是 `<a class="notif-row wb-run-card">` | backdrop | 时钟（**进文档流**，禁止 `position:absolute` 贴角）→ 片名 → 既有形状句 + via → ghost「去片库看」 |
| 在跑 | `data-testid="wb-run-card"` | backdrop | 片名 → 正在装/译 + 已用时 → `done / total` + suffix → `role="progressbar"` → 当前步 → log（最多 5，最新高对比）→ stale |
| 排队 | `data-testid="wb-queue-card"` | **backdrop，不再 poster** | 片名 → 既有副标题（awaitingRescan / 重试规则不变） |

`NotificationRow` 删除 `compact` prop。`NotificationsPage` 不再按 `bucket.offset` 传 compact。

进度条 / 步骤 / log 的**内容规则**仍是 2026-08-17 spec §4.2；只搬家到右栏。

## 5. 测试锁

改掉锁错行为的旧断言，不许拿它们挡本 spec。

- CSS：`--card-split-poster: 61%`；img `aspect-ratio` 16/9；mask 含 `to right`、不含作为方向的 `to left`；卡不定高；`.notif-hero-compact` / `.wb-queue-fade` / `--card-queue-*` / `--card-run-h` 不存在。
- 排队卡 img `src` 含 `w1280` 与 backdrop path，不含 `w400` poster。
- 排队 `backdropPath: null` 且 `posterPath` 有值 → `data-noimg`，无 `<img>`。
- 昨天通知：有 backdrop、有片名、无 `notif-hero-compact`。
- 通知时钟在 `.wb-run-body`（或 SplitHero 右栏）里，不在 `absolute` 贴角节点。
- 既有：在跑 workId 不在排队；进度不是 `queue.length`；en 无中文 chrome；legend `width: 100%`。

## 6. 对 2026-08-17 spec 的显式覆盖

| 旧条 | 本 spec |
| --- | --- |
| §4.1 字在左 46%，卡高 186px，mask `to left` | 字在右实色栏；卡高 = 左 16:9；mask `to right` |
| §8.1 全幅 inset 0 + 通知可略矮 168px | 左栏 61% 16:9，不定高 |
| §8.2 排队 2:3 + 118px fade | 排队走 B；删 fade overlay |
| §9 更早的天 ~88–110px / 96px compact | 今天与昨天同一 B 卡 |
| §12 L5 队列 2:3 继承 | **作废**（队列）。片库墙 2:3 不动 |
| §2 Out「排队卡改成 16:9」 | **改成 16:9**（本 spec 的 In） |

## 7. 自审

占位：无 TBD。内部：三张卡同一几何；无图不回落 poster。范围：前端 chrome + 改测试，一块计划。歧义已钉：mask 朝右；61%；poster-only=无图；时钟进文档流；不定高。
