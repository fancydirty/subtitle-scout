# subtitle-scout Dashboard · DESIGN.md

**每个动 `web/` 的子代理开工前必读本文件全文。**违反这里的铁律 = 复审直接打回，不讨论。
本文件是 spec §2（docs/design/2026-07-16-dashboard-rebuild-design.md）设计语言的执行细则，
视觉基准是 `.superpowers/brainstorm/83245-1784195119/content/full-design-v2.html`（用户过目版）。

## 0. Overview——这是什么气质的产品

一个**高端 SaaS 控制面**（Linear/Vercel/Trigger.dev/Inngest 的公约数），不是"家用 NAS 小工具面板"。
它的存活感来自**数据新鲜度**，不是装饰性声明：顶栏一行 mono 灰字
`watching /media · scanned 2m ago · 568 files` 就是全部的"系统在跑"信号。
**禁止**"● 守护运行中"式状态标语——这是 v1 被用户定罪"土的要死"的现场，原样重现即打回。

## 1. 技术底座——Astryx（F0 裁决采用）

- 组件库：`@astryxdesign/core`（Meta，预编译，无需 StyleX 构建插件）。
- 主题：`web/src/theme/scout.ts`（defineTheme 源）→ `npm run theme:build` 编译出
  `scout.css/scout.d.ts/scout.js`（产物随源码提交）。App 入口包
  `<Theme theme={scoutTheme} mode="dark">` 并 import scout.css。
- 全局 CSS 只允许三行 import（reset.css / astryx.css / scout.css，cascade layers 顺序敏感，
  见 `./node_modules/.bin/astryx docs migration` 的 Cascade Layer Safety）。
- **CLI 坑**：`npx astryx` 会解析到被抢注的空包——一律走 `./node_modules/.bin/astryx`
  或 `npm run theme:build`。查组件 API/theming targets：`./node_modules/.bin/astryx component <Name>`；
  查 token 全表：`... docs tokens`；找模板：`... search <query>`。
- 自定义样式优先级：①组件 props/variant ②主题层 components 覆盖（scout.ts）③`xstyle`/className
  兜底。**禁止**另起 CSS 文件堆板式——版式问题回 Layout/Stack/Grid 组件解决。

## 2. Colors——色是等级制度，不是装饰

| 用途 | token | 值 |
|---|---|---|
| canvas | `--color-background-body` | `#0b0c0f`（近黑微冷） |
| 卡片 | `--color-background-card` | `#111318` |
| 抬升面 | `--color-background-surface` | `#16181f` |
| 发丝线 | `--color-border` | `rgba(255,255,255,0.07)`（hover 可到 .14，微染面 .04） |
| ink 主 | `--color-text-primary` | `#e6e8ec` |
| ink 次 | `--color-text-secondary` | `#9aa1ac` |
| ink 弱 | `--color-text-gray` | `#6b7280` |
| ink 失效 | `--color-text-disabled` | `#4b5563` |
| accent | `--color-accent` | `#a3e635`（lime） |
| 成功 | `--color-text-green` | `#28bf5c` |
| 硬字幕假定 | `color-mix(in srgb, var(--color-text-green) 55%, var(--color-text-gray) 45%)`（灰绿间调，非新 token——defineTheme 的 TokenName 是第三方设计系统封闭枚举） | 混合色 |
| 警示 | `--color-text-orange` | `#e8a33d` |
| 错误 | `--color-text-red` | `#e11d48` |

铁律：

- **深色下零 drop-shadow**。层级只靠 surface 阶梯 + 发丝线。
- **单 accent 稀缺**：每屏至多一处亮色（主 CTA 或当前活跃项，二选一）。
- **语义色只给状态**（圆点+状态词）；**排队/中性/取消=灰**（Trigger.dev 源码实证），不是黄不是蓝。
- 错误行整行背景至多 6% 透明度微染，不许大红块。

## 3. Typography——13px 世界

- 正文 `13px / 500 / -0.01em`（主题 scale base=13 已定）；**字重天花板 600**，700+ 禁用。
- display/大数字负字距；eyebrow/分区标 = uppercase 小号灰 mono（11px 级）。
- **mono（Geist Mono）是技术层专属声音**：路径、ID、时长、时间戳、语言码、工具名。
  正文/按钮/标题绝不 mono；反之技术值绝不用正文字体。
- 衬线全站只出现一次（空状态或欢迎语），再多即打回。

## 4. 状态呈现

- 状态 = **6px 圆点 + 一个同色词**（`● installed`），不做大 badge、不做胶囊底色块。
- 覆盖率写 **Midday 式人话句子**：`Season 1 has **24 of 28** episodes covered`——
  大数字嵌在句子里，不做仪表盘环形图。
- Loading/Empty/Error 三态每屏全覆盖；空状态允许全站唯一一次衬线。

## 5. 交互

- 键帽入 UI：⌘K 全局搜索、按钮内嵌快捷键提示、右侧板 esc 角标——键帽用 mono 小字 + 发丝线框。
- 过滤器 = chip 排下拉 + 结果计数（`12 series`），不做侧栏树。
- 详情 = **固定右侧板**（不跳页、不弹 modal）；destructive 操作（Rerun/删根）才用 AlertDialog。
- 动效只给四件事：active（在跑行的蓝点延展）/alert/focus/recency（新数据淡入）。装饰性动效禁。

## 6. 布局与信息架构

- 外壳：左侧栏（分区 uppercase 小标 LIBRARY / AGENTS / SYSTEM）+ 顶栏（面包屑 + mono 新鲜度行 + ⌘K）。
- 四 tab：Library / Workflow / Triage / Settings。
- Workflow 页 = 三泳道（pending 活文档 / orchestrator passes / workers 直播），
  痕迹行 = Inngest 式：等宽工具名 + 右对齐耗时 + 在跑行蓝点。移动端降级单列时间流。
- Library 剧集页 = 每季格阵：灰格 + 5px 语义点；**canonical 有而磁盘无 = dashed 空格**。

## 7. 语言（i18n）铁律

- **Workflow 区永不本地化**（用户裁决）：泳道名/状态词/工具名/痕迹行全部英文，zh 文案表中
  Workflow 键直接引用 en 值。
- Triage 的中文名 = **甄别**（用户钦定）。
- 技术值（路径/ID/decision 词表 installed/no_safe_match/retry_later/error）永不翻译。

## 8. 数据诚实（北极星④在前端的投影）

- 前端**只呈现事实，不替 agent 判断**：throttled 显示停牌原因+`next recheck in 3d`，
  不许把它渲染成"失败"；coalesced 回执显示"合并进在途任务"，不许显示"已派发新任务"。
- 唯二的写扳手：Rerun（redispatch，AlertDialog 确认 + includeThrottled 开关）与甄别认领。
  其余一切 UI 都是只读的。
- 已知债务如实标注：Settings 里 target_languages 改后**需重启生效**（后端启动时读一次）——
  UI 文案必须写明，不许假装即时生效。

## 9. Do / Don't 速查

| ✅ Do | ❌ Don't |
|---|---|
| mono 新鲜度行报活 | "● 守护运行中" 标语 |
| 灰格+5px 语义点 | 彩色大 badge 矩阵 |
| 人话覆盖句嵌大数字 | 环形进度仪表盘 |
| 发丝线+surface 阶梯分层 | drop-shadow / 玻璃拟态 |
| 每屏一处 lime | 到处亮色、渐变按钮 |
| 排队=灰 | 排队=黄/蓝 |
| 固定右侧详情板 | 跳页/全屏 modal |
| `./node_modules/.bin/astryx component X` 查 API | 凭记忆猜组件 props |

## 10. Iteration Guide——改样式的流程

1. 先问"这是 token 问题还是组件问题"：全局色/字/距 → 改 `scout.ts` + `npm run theme:build`；
   单组件 → 主题层 `components` 覆盖；单实例 → `xstyle`。
2. 动 `scout.ts` 后产物三件套一并提交。
3. 每个 tab 完工的验收基准：与 full-design-v2.html 并排看气质是否同族——不是像素级复刻，
   是"这两个页面出自同一个产品"级别的一致。
