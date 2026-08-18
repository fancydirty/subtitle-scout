# 通知卡片恒定高度（96px）设计

## 1. 背景与问题

2026-08-18 的 SplitHero B 切分（`8d802de`）让三张卡共用同一套几何：

- 左栏 `width: var(--card-split-poster)`（61%）
- 左栏 `aspect-ratio: 16 / 9` + `height: auto`
- 卡片**不定高**——高度由左栏 16:9 海报撑开

这个「宽 → 高」的推导在活动页在跑卡 / 排队卡上是对的（右栏有进度条、步骤、5 行 log，需要 ~390px 高度）。**在通知页上是错的**：通知行只有时钟 + 片名 + 一行副标题 + 一个 ghost 按钮，内容根本不需要 390px。用户截图实测：一条「黑暗智宅」的通知把卡片撑到 ~400px，页面密度极低。

## 2. 用户意图（字面原文）

> 「卡片高度恒定，只是让海报本身的比例保持 16:9 而已。」
>
> 「这样做的好处是显示器宽度变化不会影响海报和文字的排布，只会影响去片库看和影视标题间的距离。」

即：**高恒定 → 宽被推高**，不是**宽恒定 → 高被推高**。

## 3. 方案（选定 B）

通知行单独覆写 SplitHero 几何：

| 属性 | 活动页在跑/排队卡（不动） | 通知行（本次改） |
|---|---|---|
| 卡片高度 | 不定高（由 16:9 海报撑开） | **恒定 `var(--notif-card-h)` = 96px** |
| 海报宽度 | `61%` | **由高度 × 16/9 推出 ≈ 171px** |
| 海报高度 | `auto`（由宽度推出） | **`100%`** |
| 海报 aspect-ratio | `16 / 9` | `16 / 9`（不变） |
| 右栏宽度 | `39%`（100% - 61%） | **弹性**（`flex: 1`） |

视口变宽时：海报 171px 恒定，右栏弹性变宽，「去片库看」与标题的距离拉大。视口变窄时同理。海报本身永远 171×96。

## 4. 实施

### 4.1 CSS 变量

`:root` 新增 `--notif-card-h: 96px`。移动端 media query 只改变量值，不改组件（同既有裁决）。

### 4.2 覆写选择器

`.notif-row.wb-run-card` 上：
- `height: var(--notif-card-h)`（覆盖 `height: auto`）
- `display: flex; align-items: stretch; gap: 0; padding: 0`（保持既有）

`.notif-row.wb-run-card .wb-run-img` 上：
- `width: auto`（覆盖 `width: var(--card-split-poster)`）
- `height: 100%`（覆盖 `height: auto`）
- `aspect-ratio: 16 / 9`（保持）

### 4.3 右栏

`.notif-row.wb-run-card .wb-run-body` 保持既有：absolute inset 右栏，左边界仍是 `var(--card-split-poster)`。这个 61% 在通知行上**不是**海报宽度，只是右栏左边界——但海报现在只有 ~171px（在 1200px 页面上 ≈ 14%），所以右栏实际上从 14% 开始，文字右对齐，视觉上「去片库看」按钮会离标题很远。

**需要调整**：通知行的右栏左边界应该跟海报实际宽度对齐，而不是 61%。做法：`.notif-row.wb-run-card .wb-run-body` 的 `left` 改为 `calc(var(--notif-card-h) * 16 / 9)`，即 ≈ 171px。这样文字紧跟海报右侧，「去片库看」在右端，标题在左端（因为 text-align: right 下标题也在右端……等等）。

重新想：右栏 `text-align: right`，所以所有文字都靠右。海报在左，文字在右栏的右边。如果右栏左边界是 171px，文字在右栏内右对齐，那么标题和「去片库看」会挤在卡片最右边，中间大片空白。用户截图里就是这个效果——但用户没抱怨这个，他抱怨的是**高度**。

所以本次只改高度，右栏布局保持 `text-align: right` + `left: var(--card-split-poster)` 不变？不行，61% 在 1200px 页面上是 732px，海报只有 171px，右栏从 732px 开始，中间 561px 是空的——这比截图还糟。

**正确做法**：通知行的右栏左边界必须等于海报实际宽度。海报宽度 = `var(--notif-card-h) * 16 / 9` ≈ 171px。所以：

```css
.notif-row.wb-run-card .wb-run-body {
  left: calc(var(--notif-card-h) * 16 / 9);
}
```

这样右栏紧跟海报右侧，文字在右栏内右对齐，标题和按钮都在卡片右端，中间没有多余空白。

## 5. 测试锁（RED → GREEN）

新增/修改断言：

1. `--notif-card-h: 96px` 在 `:root` 上
2. `.notif-row.wb-run-card` `height` = `var(--notif-card-h)`，**不是** `auto`
3. `.notif-row.wb-run-card .wb-run-img` `height` = `100%`，`width` = `auto`（不是 `var(--card-split-poster)`）
4. `.notif-row.wb-run-card .wb-run-body` `left` = `calc(var(--notif-card-h) * 16 / 9)`（不是 `var(--card-split-poster)`）
5. 反向禁令：`.notif-row.wb-run-card` 上**不许**出现 `height: auto` / `height: 186px` / `height: 390px`
6. 既有守卫不破坏：活动页 `.wb-run-card` / `.wb-queue-card` 仍 `height: auto` / `width: var(--card-split-poster)`

## 6. 对 2026-08-18 spec 的显式覆盖

| 旧条 | 本 spec |
|---|---|
| §3.1「卡：不定高」 | 通知行**恒定 96px**；活动页在跑/排队卡仍不定高 |
| §3.1「左栏 width: var(--card-split-poster)」 | 通知行海报 `width: auto; height: 100%` |
| §3.1「右栏 left: var(--card-split-poster)」 | 通知行右栏 `left: calc(var(--notif-card-h) * 16 / 9)` |

## 7. 自审

- 占位：无 TBD。
- 内部：通知行与活动页卡几何解耦，各自断言互不影响。
- 范围：只改 `.notif-row` 相关 CSS + 测试，不改组件 JS。
- 歧义已钉：96px；`calc()` 表达式；右栏 `text-align: right` 保持。
