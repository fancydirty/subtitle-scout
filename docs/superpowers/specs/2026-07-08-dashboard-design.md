# Dashboard Design: 嵌入式监控页(观测 + agent 故事)

Status: approved-in-direction by user on 2026-07-08(视觉方向 + 范围已定,细节落此 spec)
Scope: 给 subtitle-scout 加一个嵌入式 Web 监控页。MVP。让用户(含非技术者)一眼看到"实例在为我干活、
字幕有没有落盘",并能点开某次运行看 agent 的工作故事。**不做**营销官网/live SSE 流/设置编辑 UI(见"不做什么")。

## 动因

现在观测只有 CLI(`report`)+ ledger.jsonl + journals。诉求两条:
1. **可见性**:让人(尤其不懂技术的)看到 agent 在做什么、字幕有没有下好——呼应项目初心"明早知道昨晚发生了啥"。
2. **门面**:开源时 README 里最能卖货的一张截图;让人觉得"这东西很牛、很 SaaS"。

## 技术形态:嵌入式 Vite React 静态 SPA(不是 Next.js)

产品感来自 **React 生态**(组件化、Tailwind、shadcn/ui、Recharts),不来自 Next.js。监控页只需读只读 JSON 并渲染,
不需要 SSR/路由/API routes/鉴权中间件——故用 **Vite + React 构建成纯静态 `dist/`**,由 daemon 的一个小 HTTP 端点托管。
运行期零 Node 服务、镜像几乎不胖,契合"轻量 headless sidecar"定位。Next.js 留给未来的完整产品 Web 应用(设置界面/多实例/官网)。

- 前端目录 `web/`:Vite + React + TypeScript + Tailwind + shadcn/ui + Recharts。构建 `dist/` 拷进镜像。
- daemon 新增 HTTP 端点(小 `http.createServer` 或极小框架):
  - 静态托管 `web/dist/`
  - JSON API(见"数据与 API")
- 可选只读 `DASHBOARD_TOKEN`(暴露的是媒体标题/路径,家庭 LAN 低风险但给开关):设了则 API 校验 `?token=`/header。
- 端口经 env(如 `DASHBOARD_PORT`,默认关闭或指定);compose 暴露。

## 视觉方向(调研 VoltAgent/awesome-design-md + shadcn 收敛)

**暗色优先、单一强调色、克制** —— "Sentry 的数据沉稳 + Linear 的克制"。但**第一眼必须平静、简单、敢用**(见"简洁哲学")。

- 画布 `#0C0D0F`(不用纯黑,避免 halation);卡片靠**微光影分层而非边框**(surface `#151619`/elevated `#1a1c20`,hairline `#242629` 仅必要处)。
- 文本 `#F2F3F5`(不用纯白)/ muted `#9a9ea4` / faint `#63676c`。
- **单一强调色 teal `#2DD4BF`**,只用在:活动/成功、关键数字、选中态。语义色去饱和(green `#54d883`、amber、red)不与强调色抢戏。
- **字体自带 woff2,禁 CDN**:UI 用 Inter/Geist Sans;**CJK 必须处理**——内嵌 Noto Sans SC 子集(受众是中文用户,fallback 到 PingFang SC)。机器数据(id/路径/时间戳)一律等宽(SF Mono/JetBrains Mono)。
- 圆角 8–16px、软低透明度阴影(elevation 非 drop-shadow drama)。
- 可把 awesome-design-md 的 Sentry/Linear `DESIGN.md` 拉进 `web/` 当视觉真相源喂实现代理保证一致。

## 简洁哲学(用户两条硬反馈,优先级最高)

1. **第一眼做减法,渐进披露**。抖音脑时代,信息密度即劝退,连 GitHub 用户都会"太复杂算了"。首屏 = 平静 + 让人放心
   (一句话状态 + 最近活动流),**图表/队列/统计/失败明细降级**到次级导航(想看再点),不堆首屏。
2. **零内部黑话**。用户只在乎字幕有没有落盘,不关心我们多辛苦。**"升格/gate/映射/no_safe_match/season pack" 等术语
   一律不出现在 UI**,换用户视角人话:
   - 整季升格成功 → "一次为整季 8 集都下好了中文字幕"
   - no_safe_match → "暂时没找到合适的中文字幕"
   - already_exists → "本来就有字幕,跳过了"
   - gate 拒绝 → 不暴露机制,只说结果
3. **文案冷峻,非 AI slop**。要"AI 时代的冷峻味":冷静、精准、克制、有底气;**砍掉暖萌助手腔**(如"你不用管,它自己会盯着"这种)。
   短句、事实、不卖乖、不拟人过度。示例基调:"运行中" / "37 部字幕已就位,今日" / "8 集已下好" / "未找到合适字幕"。
4. **桌面是桌面,别做成移动端**。窄栏(如 600px)在桌面显廉价;用横向空间做 **master–detail 宽布局**
   (左活动流 + 右运行详情并排),内容宽度舒展(~1080–1200px 级),但**密度依然低、留白足**。响应式向下收成单列(移动)。

## 布局(桌面 master–detail,低密度)

```
┌───────────────────────────────────────────────────────────────┐
│  subtitle-scout                              ● 运行中           │  ← 极简顶栏
├──────────────────────────────┬────────────────────────────────┤
│  今日 37 部字幕已就位          │   [选中一次运行时,这里是         │
│  （大字冷峻标题 + 一行事实）    │    agent 工作故事;未选时       │
│                              │    留白或轻量欢迎)              │
│  最近                         │                                │
│  ┌──────────────────────────┐│   Overflow · 第 1 季           │
│  │ ▸ Overflow S1  8集已就位  ││   ✓ 8 集已下好                 │
│  │ ● Overflow S1E2 找字幕中… ││   ── 故事时间线 ──             │
│  │ ▸ 招魂  已下好            ││   认出这部片                   │
│  │ ▸ 寻踪迷镇  未找到合适字幕 ││   找到覆盖整季的字幕            │
│  │ ▸ Family Plan 2 已有,跳过 ││   挑了最靠谱的一份             │
│  └──────────────────────────┘│   下好并放到位(8集)          │
│                              │   ▸ 原始细节(给好奇者)         │
├──────────────────────────────┴────────────────────────────────┤
│  全部记录 · 队列 24 · 统计 · 设置       (次级入口,不抢首屏)    │
└───────────────────────────────────────────────────────────────┘
```

- **首屏 = 顶栏 + 冷峻大标题 + 活动流 + (选中运行的)故事面板 + 底部次级链接**。就这些,不堆图表。
- 图表(决策分布、运行趋势)、队列全貌、失败明细 → 点次级入口进独立视图(或抽屉),不占首屏。

## 🎯 Hero:agent 工作故事(每次运行的时间线)

调研共识(Perplexity 步骤 + Claude 活动行 + AI Elements ChainOfThought/Reasoning):**竖向步骤时间线**,状态节点
(待→进行→成/失/跳)+ 动词标题 + 一行人话 reason + 可展开的 Tier-2 原始细节。数据全现成:journal 的
identify→plan→search→rank→gate→download→write 各步 + llm_calls 的 reason(identify 的 evidence / plan 的 query reason /
rank 的 reasons)。

- **默认呈现 = 4 步大白话故事(不是 7 步内部管线)**:认出片 → 找字幕(整季包时点明"覆盖整季")→ 挑最靠谱 → 下好放到位。
  冷峻事实句,零术语。整季场景的高光("一份覆盖整季的字幕 → 8 集全部就位")用人话讲。
- **Tier-2 给好奇者**:一个"▸ 原始细节"入口,展开才显真实管线步/prompt/结构化输出/延迟/模型(等宽、限高、静音色)——
  默认不吓人,想看引擎的能看。
- **状态生命周期**:in-flight 的片显示"找字幕中…"+ 活动脉冲;完成的片静态呈现绿勾——**完成态绝不伪造 live 脉冲/spinner**
  (replay 不装 live,是 #1 正确性坑)。
- **两个可选高光**(cheap):search 时候选 chip 闪现、rank 时选中项高亮——但要服从"冷峻简洁",不喧宾夺主。

**MVP 范围**:**回放为主**(读完成的 journal 静态渲染 + in-flight 状态)。**不做**逐步 live SSE 流(留 v2)。**不做**"▷ 重放"
再动画按钮(用户明确不需要)。轮询刷新(如每 10–15s)即可,in-flight 项打"找字幕中…"。

## 数据与 API

复用现有:`Ledger.read`(ledger.jsonl 事件)、journals 目录(每次运行 decision.json)、queue.json、`report.ts` 聚合逻辑。
- `GET /api/summary` → 复用 report 聚合:今日字幕数、成功率、队列深度、平均耗时、决策分布(内部枚举 → 映射成人话标签)。
- `GET /api/runs?limit=&since=` → 最近运行列表(name、用户视角结果标签、耗时、时间、itemId/journal 引用)。
- `GET /api/runs/:journalId` → 单次运行的故事数据:步骤 + 每步 reason(人话)+ Tier-2 原始(prompt/parsed/latency/model)。
  **决策枚举→人话标签的映射在服务端做**(单一事实源),前端只渲染。
- `GET /api/queue` → 队列(pending/dormant/in-flight),用户视角状态标签。
- 坏行/缺文件容错:沿用 ledger 坏行跳过;journal 缺失返回占位。

## 组件与"显贵"细节(shadcn,克制使用)

- shadcn:`Card`、`Badge`、`ScrollArea`、`Collapsible`(Tier-2)、`Skeleton`(加载态,不用 spinner)、`Tooltip`
  (相对时间 hover 显绝对时间)、`Command`(⌘K 跳转,cheap 且高级)。
- Recharts:决策分布(donut/bar)、运行趋势(area)——**放次级统计视图,不上首屏**。
- 显贵细节(挑克制的用):关键数字 tabular-nums、机器数据等宽 + 点击复制、骨架屏匹配布局、活动脉冲仅用于真 in-flight、
  相对时间戳、卡片 hover 轻微抬起(尊重 prefers-reduced-motion)。
- 避坑:纯黑背景、Bootstrap/AdminLTE 味重边框、彩虹色、CDN 字体、无 CJK 处理、密表无留白无空态、emoji 当 UI 图标(用 Lucide)。

## 测试

- 前端:组件单测(vitest + testing-library)——故事时间线的状态渲染(in-flight vs 完成、成功/失败/跳过标签)、
  人话标签映射、空态/加载态;`web/` 有独立 vitest 配置。
- 后端:API handler 单测——summary/runs/runs:id/queue 的聚合与人话标签映射(喂手造 ledger/journal fixture)、
  token 校验、坏行/缺文件容错。复用现有 report.ts 测试风格。
- 真实(controller):部署后浏览器打开,核对首屏平静度、活动流人话正确、点开 Overflow 那次能看到 4 步故事、
  in-flight 状态、无内部术语泄漏。

## 不做什么

- 不做 **Next.js / SSR / 营销官网 / live demo 站**(留到完整产品 Web 应用阶段)。
- 不做 **逐步 live SSE 流**(MVP 用回放 + 轮询;v2 触发条件:用户真需要"边跑边看每一步")。
- 不做 **设置编辑 UI**(只读监控;改配置仍走 env/compose)。
- 不做 **"▷ 重放"再动画按钮**(用户明确不需要)。
- 不做 **多用户/复杂鉴权**(仅可选只读 token)。
- **UI 绝不暴露内部术语/机制**(升格/gate/映射/负缓存/pipeline 步名)。

## 影响面

新增 `web/`(Vite React SPA,独立 package + 构建)、daemon 的 HTTP 端点模块(如 `src/dashboard/server.ts` + API handlers 复用 report/ledger/queue)、
Dockerfile 加前端构建阶段并拷 `dist/`、compose 暴露端口 + `DASHBOARD_PORT`/`DASHBOARD_TOKEN` env。核心 pipeline/判断点零改动。
参考样机:`.superpowers/brainstorm/55844-1783441901/content/dashboard-v2.html`(v2 简洁版,文案待改冷峻、布局待改桌面宽)。

实现计划:`docs/superpowers/plans/2026-07-08-dashboard.md`。
