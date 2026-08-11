# 前端实施设计（第 8 步）· v2

**创建**: 2026-08-11
**修订**: v2 — 经对抗性审计（6 条 🔴 / 7 条 🟡）后重写
**状态**: 待用户确认 → **确认后仍不实施**（用户明确要求）
**前置**: `2026-08-11-FRONTEND-SPEC.md`（R-F1~R-F15）/ `DESIGN.md`（Linear 视觉基准）

---

## 零、v1 被审计击穿的地方（先记教训，再讲设计）

v1 的推理没被攻破，**事实基座塌了**。审计逐条核实后发现：

### ⚠️ 教训一：我引用了一份已被自己销毁的数据快照

v1 写「115 库实测 `origin-skip 276 / missing 240 / embedded 131`、58 个作品」。
审计查活库：

```
files=60（不是 647）  作品=8（不是 58）  covered=1（不是 214）
embedded=0（不是 131）  target_languages=en（不是 zh）
```

**原因是我自己造成的**：为了验证 R-F15，我把守备目录切到 NAS 测试库、把目标语言改成 en，
然后照着**切换前**的 115 数字写文档。

`embedded` 从 131 变成 0 不是 bug——目标语言变成 en 后，中文内嵌轨自然不再算"已覆盖"。
**这恰恰证明 R-F15 работает**。但它也意味着：

> **任何 `skip_reason` 分布数字，脱离 `target_languages` 口径就是无意义的。**

v1 把一个瞬时快照当成了库的稳态属性——这是本项目栽过三次的
「把中间量说成结论量」的**第四次**，而且这次是我写在设计文档里。

**修正**：本文档所有生产数字必须标注**采样时刻 + 当时的 `target_languages`**。
§6 验收标准不许钉死片名，改为"验收时现查样本"。

### ⚠️ 教训二：同型缺陷在这份文档里复发了三次

「加了能力却没定谁写/谁读/谁触发」——项目已栽 7 次，v1 又贡献三例：

| | 缺陷 | 详见 |
|---|---|---|
| 1 | SSE `found` 事件载荷 ≠ 通知页需要的形状 | §3.4 |
| 2 | `health` 事件只有发射点、没有撤销点 | §3.5 |
| 3 | `web/src/api/` 1851 行既有数据层，没定新页面复不复用 | §2.1 |

### ⚠️ 教训三：v1 的行数表漏了 4037 行

审计核对：`find | wc -l` = 24709，而 v1 表格十行相加 = 20672。
漏掉的恰好是**两个未定处置的功能区**（`api/` 1851、`subtitleVerify/` 1758）。

---

## 一、第一性原理：这个前端的本质

### 1.1 它是观察窗，不是应用

用户原话：「前端页面就完全只有监视和折腾设置的作用。」

```
后端全自动日巡检，用户不参与决策
  ↓
前端没有"用户发起的业务操作"（不请求资源、不审批、不调度）
  ↓
前端 = 只读投影 + 少量配置写入
  ↓
不需要乐观更新（没有会失败的用户操作）
不需要服务端状态同步库（React Query / SWR 之流解决的问题不存在）
```

⚠️ **审计纠正了这条推导的一个跳步**：「只读」能推出"不需要**服务端状态同步**"，
但推不出"不需要**跨组件状态**"。§3.3 的 SSE 分发结构本身就是跨组件的
（health 是全局横幅、found 同时被两个页面消费）。

**修正后的结论**：
- 不引外部状态库（Zustand/Redux）✅ 这条成立
- 但**必须用 React Context 承载 SSE 分发**，形状见 §3.3
- 不许 prop drilling 穿过路由层把四个事件流全传下去

### 1.2 数据有两种时间尺度，必须分开

| 尺度 | 数据 | 变化频率 | 传输 |
|---|---|---|---|
| **事件流** | 正在处理什么、找到了什么 | 巡检期间秒级，其余静止 | SSE |
| **快照** | 媒体库有什么、缺什么 | 一天一次 | HTTP |

混在一起的两种错法：
- 用 SSE 推媒体库全量 = 每次巡检推几百个作品的数据
- 用轮询看活动 = 日巡检下 99% 的轮询返回"没变化"

### 1.3 「一天大部分时间什么都不发生」是核心约束

日巡检（R4）下系统一天只忙几小时。推论：

- **空闲态是常态**。空列表 + 转圈是错的，用户会以为坏了
- 三个页面都要有明确的空闲态文案，且说清"下次什么时候动"
- **空闲态与错误态必须视觉可区分**（见 §4.4）——
  API 失败时显示"今天已完成"是谎报，同 §零教训一的病

---

## 二、旧前端：共存而非推倒

### 2.1 完整清点（审计补全，合计对得上 24709）

```
web/src  208 个 ts/tsx 文件 / 24709 行 / 78 个测试文件
```

| 功能区 | 行数 | 测试文件 | 状态 | 处置 |
|---|---|---|---|---|
| activity | 4703 | 8 | ⚠️ **当前已不在导航里**（route.ts 只有 library/workflow/settings） | **重写** |
| settings | 3853 | — | ✅ live test 全程在用 | **保留** |
| library | 2670 | — | ❌ 读 `series`（生产 0 行） | **重写** |
| workflow | 1640 | — | ❌ 含假按钮 redispatch | **删** |
| **api** | **1851** | — | ⚠️ **v1 漏了** | **见下方裁决** |
| **subtitleVerify** | **1758** | 3 | ⚠️ **v1 漏了** | **见下方裁决** |
| components | 1743 | — | ✅ 与数据源无关 | **复用** |
| shell | 1145 | 4 | ⚠️ 导航要改 | **改造** |
| triage | 1077 | — | ❌ 已被雪藏 | **删** |
| i18n | 862 | — | ✅ | **复用**（文案策略见 §4.5） |
| lib | 300 | — | ✅ | **复用** |
| 顶层 + testSupport | 428 | 若干 | — | 随 shell 改造 |
| **合计** | **24709** | **78** | | |

#### 裁决 A：`web/src/api/` 1851 行 —— **复用其基础设施，新增三个 hook**

它是所有页面的数据访问层（`client.ts` 定义端点、`hooks.ts` 定义 `useXxx`）。
新页面**不另起一套 fetch**——那会造出第二份错误处理、第二份鉴权头拼装。

具体：
- `client.ts` 加三个函数：`mediaLibrary()` / `mediaLibraryDetail(id)` / `notifications()`
- `hooks.ts` 加对应 hook，但**不沿用它的 15 秒轮询模式**（新页面靠 SSE + 手动重拉）
- 旧的 `useLibrary` 等原样留着给 `_legacy` 用

#### 裁决 B：`subtitleVerify/` 1758 行 —— **移入 `_legacy`，不进新导航**

它有 3 个测试、6 个后端端点（`/api/v2/subtitle/compare|correct|revert|verify` 等）支撑。
用户定的三页导航里没有它的位置，但它是**能用的功能**（字幕校验/纠偏），
不该因为改导航就删掉。

**处置**：与旧 library/workflow 一起进 `_legacy`，保留可达性。
是否最终删除，等新前端跑稳后单独裁决。

### 2.2 路由：继续用 hash（审计纠正 v1 的 path 路由假设）

**现状实测**：`web/src/shell/route.ts` 是 **hash 路由**，
`Tab = 'library' | 'workflow' | 'settings'`，`parseShellHash` 按白名单匹配。

v1 写的 `/notifications`、`/_legacy/*` 是 path 形态，**与现有实现不兼容**，
换成 History API 会波及 `EngineBanner`/`CommandK`/`Sidebar`/`SideNav` 四个组件。

**裁决：继续 hash 路由**，新的 Tab 联合类型：

```ts
export type Tab =
  | 'activity'      // #/activity  新活动页（默认）
  | 'notifications' // #/notifications
  | 'library'       // #/library   新媒体库页
  | 'settings'      // #/settings  旧设置页（原样）
  | 'legacy'        // #/legacy/<sub>  旧页面容器，不在导航里
```

`legacy` 用二级段区分：`#/legacy/library`、`#/legacy/workflow`、`#/legacy/verify`。
`parseShellHash` 要支持读第二段（现在只读第一段）。

⚠️ **`_legacy` 期间的 SSE 连接数**：审计发现 `workflow/` 在用另一条 SSE
（`/api/v2/workflow/trace-stream`，痕迹通道）。用户开着 `#/legacy/workflow` 时
就是 2 条 SSE + 新 shell 1 条 = 3 条。虽未超 6 条上限，但要在 `_legacy` 页面
**离开时显式关闭 trace-stream**，不能靠组件卸载碰运气。

**删除时机**：新页面在生产跑满一个完整巡检周期、对账无差异后，才删 `_legacy`。

---

## 三、数据层

### 3.1 端点清单（含待补）

```
✅ GET  /api/v2/mediaLibrary          → MediaLibraryItemDTO[]
✅ GET  /api/v2/mediaLibrary/:workId  → MediaLibraryDetailDTO | null
✅ GET  /api/v2/events                → SSE（4 类事件）
❌ GET  /api/v2/notifications         → FoundGroup[]        ← 待补，见 3.2
❌ GET  /api/v2/health                → HealthDTO           ← 待补，见 3.5
```

### 3.2 待补①：通知端点（第 7 次同型缺陷）

**实测**：`notificationsRepo.ts` 有 `listRecentFound` / `listRecentFoundGrouped`，
`notifications` 表有 27 行数据，**`src/dashboard/` 下零端点**。

```
GET /api/v2/notifications → FoundGroup[]
```
`FoundGroup` 已定义（`notificationsRepo.ts:48`）：
`{ workId, title, season, episodes[], latestAt, via }`，`via` 三态 `fetch|translate|mixed`。

### 3.3 SSE 分发：一条连接 + Context

```
AppShell
  └─ <ScoutEventsProvider>          ← 唯一的 EventSource（R-F10：6 连接上限）
       ├─ useActivity()   → 活动页
       ├─ useFound()      → 通知页 + 活动页"刚找到"提示
       ├─ useHealth()     → 全局横幅（任何页面都该看到）
       └─ useProgress()   → 活动页当前项进度
```

**不自己写重连**：浏览器 `EventSource` 自带重连 + `Last-Event-ID` 续传，
后端已实现 50 条环形缓冲。自己写会和浏览器内置的打架。

⚠️ **但 503 是例外**：`server.ts` 在 bus 缺失时返回 503，
而 `EventSource` 对非 200 会**无限重连**。必须在 `onerror` 里检测连续失败并退避
（见 §4.4）。

### 3.4 待补②：`found` 事件载荷 ≠ 通知页所需（审计 F-3）

**实测的载荷**（`daemonV2.ts:714`）：
```ts
{ type:'found', message:`${title}：装上了 N 条字幕`, title, data:{ installed:N, files:N } }
```
**通知页需要的**（`FoundGroup`）：`{ workId, season, episodes[], via, ... }`

**前端拿到 SSE 事件无法构造一个 FoundGroup**——没有 workId（`title` 是字符串，
而 R-F2 规定合并键是 `work_id`）、没有季集号。

更隐蔽的：`recordFound` 是**幂等刷新**（`ON CONFLICT DO UPDATE`），
同一集第二次找到不产生新行；而 SSE 每次都发。两条路给出的条目数会不一致。

**好消息**：`report.installed[]` 里有 `itemId`（形如 `tmdb:123/s1e2`），
**能反解出 workId + season + episode**。

**裁决（二选一，本文档选后者）**：
- (a) 扩 `found` 载荷带上 workId/season/episodes —— 要改 daemonV2 取数层
- (b) ✅ **SSE `found` 只做"有新内容"的提示，不直接插入列表**。
  前端收到后显示一个轻量角标/横幅「刚找到 3 条字幕 · 点击刷新」，
  用户点击才重拉 `/api/v2/notifications`。

选 (b) 的理由：避免两个数据源形状不一致导致的幂等冲突，
且改动只在前端。代价是通知页不是"自己跳出来"而是"提示你刷新"——
对一天动几次的系统，这个代价可以接受。

### 3.5 待补③：`health` 状态没有基线来源（审计 F-5）

**v1 的方案不成立**。v1 写「重连时拉一次媒体库列表做基线校正」，但：

- `health` 的三个发射点全是守备目录/挂载问题（`daemonV2.ts:1300/1306/1375/542`）
- `MediaLibraryItemDTO` **没有任何字段**反映挂载状态
- 更糟：守备目录读取失败时 daemon **本轮跳过不删数据**（R8 保护的设计目的），
  所以**故障时列表看起来完全正常**。这个信号信噪比是零
- 且 `health` 事件**只发不撤**——代码里没有"恢复"事件的发射点，
  横幅一旦亮起在当前实现下永远不灭

**裁决：补一个健康端点**
```
GET /api/v2/health → { roots: [{path, ok, lastError?}], lastInspectAt, engineEnabled }
```
前端在**首次加载**与**SSE 重连后**各拉一次，作为横幅的真实基线。
SSE 的 `health` 事件只负责"立刻亮起"，灭灯靠这个端点。

### 3.6 待补④：活动页当前状态没有快照端点（审计 F-6）

同理，`activity` 事件是**变化**不是快照。断线期间巡检跑完的话，
若缓冲被 progress 冲掉，前端会永远停在"正在处理 X"。

**裁决**：`/api/v2/health` 一并返回当前工作台快照：
```
{ ..., current: { kind:'subtitle'|'translate', title, index, total } | null, queue: [...] }
```
活动页首次加载与重连后拉它，之后靠 SSE 增量更新。

### 3.7 不做前端缓存

数据一天变一次，每次进页面重新拉最简单。加缓存要处理失效，
而失效时机恰好是"巡检完成"——那是个 SSE 事件，引入不必要的耦合。

---

## 四、三个页面

### 4.1 活动页

**布局**（R-F13 已定）：全背景式卡片，图渐隐进 `surface-1` 实色。

```
在跑的：横版 backdrop 占 60% 宽，186px 高
排队的：竖版 poster 59px 宽，88px 高，渐变区 118px
```

⚠️ **依赖 `works.backdrop_path`，该列尚不存在**（R-F14）。
TMDB 客户端已在取（`tmdb.ts:355`），`identifyScheduler` 落库时漏了。
**实施前必须补列 + 回填**。

⚠️ **尺寸不许写死 px**（见 §7 移动端留路）。

**空闲态**：
```
今天的巡检已完成
下次 明天 03:00 · 今天找到 13 部作品的字幕
```

### 4.2 通知页

数据源：`GET /api/v2/notifications`（一周窗）+ SSE `found` 触发的"点击刷新"提示（§3.4 裁决 b）。
按天分组、倒序、不做已读（R-F3）。

### 4.3 媒体库页

**列表**：海报网格，底部渐变嵌进度条。

**详情**：backdrop hero + 季集网格。状态是**两个正交维度**（审计 F-15 纠正 v1 的混淆）：

| 维度 | 取值 | 数据源 |
|---|---|---|
| **卡片边框** | 实线 = 磁盘有此集 / 虚线 = 应有但没有 | `files` 有无该 season+episode |
| **集号染色** | ✓绿 / ◆蓝 / ◇灰 / ···灰 | `sub_status` + `embedded_langs` + `skip_reason` |

```
实线 + E01 ✓    已配字幕      sub_status='covered'
实线 + E02 ◆    内嵌目标语言   embedded_langs 含目标语言
实线 + E03 ◇    原生同语言     skip_reason='origin-skip'      ← R-F15
实线 + E04 ···  待处理        needs_subtitle=1 且非 covered
虚线 + E05      磁盘上没有     tmdb_seasons 有、files 没有
```

**虚线格子不染色**（磁盘上没有文件，谈不上字幕状态）。

⚠️ **`skip_reason` 目前零读者**。本页的 ◇ 就是它唯一的读者——不接就是第 8 次同型缺陷。

### 4.4 异常态（v1 完全没写，审计 F-11）

| 场景 | 处置 |
|---|---|
| API 500 / 网络失败 | 显示错误态 + 重试按钮。**绝不显示空闲态文案**（那是谎报） |
| SSE 503（bus 未接） | `onerror` 计数，连续 3 次失败后停止重连并显示"实时更新不可用"。不能让浏览器无限重连 |
| TMDB 图片 404 / `posterPath` 为 null | `onError` 换成占位块（`surface-2` + 作品首字母）。**这是必然分支**，DTO 注释明写可为 null |
| 加载中 | 骨架屏（`surface-1` 灰块），不白屏、不转圈 |
| 换语言重判进行中 | 媒体库四态会全部重算。检测到 `needs_subtitle IS NULL` 占比高时显示"正在重新判定"过渡态 |

### 4.5 文案与 i18n（审计 F-12）

**现状矛盾**：项目有 862 行 i18n 体系，但 SSE 事件的 `message` 是**后端硬编码中文**
（`scoutEvents.ts` 注释明写「给人看的一句话，前端直接渲染」）。
而 R-F15 的动机恰恰是"用户不止中国人"。

**裁决：承认现状，但划清边界**
- SSE `message` 直接渲染，不过 i18n（后端已单方面决定）
- **前端自己的文案走 i18n**（空闲态、错误态、按钮、表头）
- 这个不一致要写进 §八 已知债务——**将来真要做英文 UI 时，SSE message 是第一个要改的地方**

---

## 五、实施顺序

```
① 补 GET /api/v2/notifications              ← 第 7 次同型缺陷
② 补 GET /api/v2/health（含活动页快照）      ← 修 F-5/F-6，v1 的方案不成立
③ 补 works.backdrop_path + 回填              ← 活动页前置（R-F14）
④ shell 改造：hash 路由新 Tab + SSE Context  ← 三页共同地基
⑤ 媒体库页（列表 + 详情）                    ← 纯 HTTP，能在 SSE 未通时验证 ③④
⑥ 活动页                                    ← 依赖 SSE + backdrop
⑦ 通知页                                    ← 依赖 ① + SSE 提示
⑧ 旧页面移入 _legacy，跑满一个巡检周期后删
```

⚠️ 审计纠正 v1：媒体库页**只依赖 ④**，不依赖 ①②③——v1 说它"能验证 ①②③"是错的
（又一次把 A 说成能验证 A+B+C）。它的价值是**在 SSE 未通时先验证 shell 与视觉基准**。

**⑨ 容器构建验证**：新页面若引入依赖要改 `web/package.json`，
而 Dockerfile 第一阶段走 `npm ci` + lock 文件。每批实施后跑一次 `docker build`。

---

## 六、验收标准

⚠️ **审计 F-1 的教训：不许钉死片名。** 生产数据随目标语言与巡检而变。

每条验收执行前，**先跑一次采样 SQL 拿到当时的真值**，再核对界面：

| 页面 | 验收方式 |
|---|---|
| 媒体库列表 | 作品数 == `SELECT COUNT(DISTINCT work_id) FROM files WHERE work_id IS NOT NULL`；随机抽 3 个作品核对"缺 N 集" == `tmdb_seasons` 减 `files` 去重格数 |
| 媒体库详情 | **现查四种染色各自的样本**：`SELECT work_id, season, episode, sub_status, skip_reason FROM files WHERE ... LIMIT 1` 各取一条，肉眼核对。**不预设哪部剧应该是什么颜色** |
| 活动页 | 巡检期间打开，卡片内容随 `docker logs` 的「字幕 X (N 文件, 第 i/n 个)」同步 |
| 通知页 | 条目数 == `SELECT COUNT(*) FROM notifications WHERE found_at > now-7d` |
| SSE | 断网 30 秒再恢复，页面自动重连；**且断线期间巡检若跑完，重连后活动页能靠 `/api/v2/health` 纠正**（这条专门验 F-6） |
| **前端测试** | 文件数 >= 78 且用例总数 >= 实施前基线。**实施前先跑一次锁定基线** |

⚠️ 最后一条是审计 F-10 补的：v1 知道 vitest 会静默丢文件（§八.3 写了），
**却没把它变成验收条目**——那本身就是"加了能力没定谁读"。

---

## 七、本轮不做，但要留路

⚠️ 审计 F-14 纠正 v1：v1 把移动端写进「明确不做的」，**曲解了用户裁决**。
用户原话是「先给桌面配置好了之后再说……将左侧 tab 变成下方 tab，然后折腾下宽度而已」——
这是**顺序**不是**排除**。

| 项 | 留什么路 |
|---|---|
| **移动端** | 卡片尺寸用 CSS 变量或 `clamp()`，**不写死 px**。R-F13 给的 186px/59px/88px/118px 是桌面基准值，要以变量形式落地 |
| 设置页减法（R-F9） | 本轮不动 settings，但新 shell 的导航要为它留位置 |
| `subtitleVerify` 去留 | 移入 `_legacy` 保留可达，跑稳后单独裁决 |

**真正明确不做的**（永久排除）：
- 不引外部状态库（用 Context）
- 不做前端缓存
- 不自己写 SSE 重连（503 退避除外）
- 不做已读状态（R-F3）
- 不引入通知外发体系（R-F9 的配置地狱）

---

## 八、已知风险与债务

1. **生产数据随 `target_languages` 变化**。任何 `skip_reason` 分布数字必须带语言口径。
   换语言会触发全库重判，重判完成前媒体库四态不完整（§4.4 有过渡态处置）。

2. **`works.chinese_titles` 可能普遍为 NULL**——上一个 subagent 报过疑虑但没实测。
   若为 NULL，海报墙全显示英文原名。**实施前应实测** `SELECT COUNT(*) FROM works WHERE chinese_titles IS NOT NULL`。

3. **SSE 缓冲会被 progress 冲刷**（审计 F-4）：`REPLAY_BUFFER_CAP=50`，
   而 progress 节流后仍可能几分钟内发几十条。巡检期间断线 2 分钟，
   `found`/`health` 会被挤出缓冲。这是 §3.5/§3.6 补两个快照端点的另一个理由。

4. **`vitest` 会静默丢整个测试文件**（实测 141 vs 142、总数少 220，
   而 `numFailedTests` 照样是 7）。验收必须同时断言文件数。

5. **SSE message 是后端硬编码中文**，与项目的国际化动机（R-F15）矛盾。
   将来做英文 UI 时这是第一个要改的地方。

6. **`_legacy` 期间两套页面读不同的表**。旧 library 读 `series`（0 行）会显示空——
   应在 `_legacy` 页面顶部加说明横幅，避免被当成 bug。
