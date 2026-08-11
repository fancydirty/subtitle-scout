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

## 零·二、v2 又被第二轮审计击穿的地方

v2 的推理质量比 v1 高一档，但它**把三个不同量级的后端工程压成了三行字**。
这是「把中间量说成结论量」的又一变体：**把"知道该补什么"说成"补起来是一步"**。

### ⚠️ 教训四：我在 §4.3 亲手写下了第 9 次同型缺陷

v2 §4.3 写「◇ 就是 `skip_reason` 唯一的读者——不接就是第 8 次同型缺陷」，
**却没说要改后端**。实测：

```
$ grep -n "skip_reason\|needs_subtitle" src/dashboard/mediaLibraryApi.ts
（零命中）
$ SubtitleDot = 'none' | 'blue' | 'green'   ← 只有三态
```

`MediaLibraryEpisodeDTO` 里**根本没有** `skip_reason` / `needs_subtitle` / `sub_status`，
两条 SQL 也没查 `skip_reason`。照 v2 实施，前端拿到的 DTO 里没有画 ◇ 和 ··· 的数据——
**第 9 次同型缺陷会当场发生，而且是我写进设计文档的那一段亲手造成的。**

### ⚠️ 教训五：`/api/v2/health` 是三个工程，我写了一行字

| 字段 | 数据源实况 |
|---|---|
| `lastInspectAt` / `engineEnabled` / `roots[].path` | ✅ 有落库 |
| **`roots[].ok` / `lastError`** | ❌ **不存在**——四个 health 发射点只 `log()` + `emit()`，零 UPDATE；`media_roots` 实测只有 `path/type/added_at/content_type` |
| **`current`** | ❌ **架构上拿不到**——dashboard 在 `index.ts:632` 启动、daemon 在 `:745` 才 new，且 `subtitleQueue`/`subtitleRounds` 是 `runInspection` 的**局部变量**（`daemonV2.ts:670-671`） |
| `queue` | 🟡 能查但语义相反——`listSubtitleQueue` 给的是"现在重查会捞到什么"，而 R4 的设计是**冻结快照** |

后果比 v1 更糟：v1 是「横幅永远不灭」，v2 会变成
**「永远误灭」**——端点不知道根坏了，只能返回 `ok:true`，用户刷新一次灯就灭，而根其实还坏着。

### ⚠️ 教训六：审计实测证伪了我两条断言

- **§八.2 的 `chinese_titles` 疑虑不成立**：实测 `110/110` 全非 NULL，海报墙不会显示英文名
- **§2.2 说「`parseShellHash` 现在只读第一段」是错的**：`route.ts:35-63` 已经在读三段
  （`#/library/movies/:id` 是生产在跑的路由）。我把一件已完成的事列成了待办

---

## 零·三、第三轮审计：找到了比前两轮都严重的一条

前两轮打事实层与遗漏层。第三轮打**设计决策本身**与**假修复**，
并在核实跨文档一致性时撞上一条谁都没发现的硬伤。

### 🔴🔴 教训七：两条用户裁决在生产代码里已经打起来了，而我同时引用两条却没发现

**R-F1 明令「识别不进活动页」。而生产代码正在推识别的 activity 事件：**

```
daemonV2.ts:519  activity  巡检开始
daemonV2.ts:531  activity  巡检完成，歇着等明天
daemonV2.ts:626  activity  正在识别：${item.workDir}     ← ⚠️ 违反 R-F1
daemonV2.ts:686  activity  正在找字幕：${item.title}
daemonV2.ts:1083 activity  正在翻译：${c.title}
```

`:625` 的注释还把它当功劳写着：
> 「识别是巡检里第一条真正"在动"的阶段，不推的话大库跑识别的那几小时活动页是死的。」

**后端在 R-F10（推什么事件）的名义下，单方面推翻了 R-F1（识别不进活动页）。
两条裁决在同一份 SPEC 里相隔 9 行。**

而我的 v3 §3.3 把 activity 画成「→ 活动页」、§4.1 按 R-F1 设计成两 tab——
**这两段自己就对不上，我引用了两条互斥的裁决却没发现。**

**第二层（这层是数据缺陷，不是 UI 决策）**：

```
:631  data: { done: identifyRounds, total: identifyQueue.length }   识别
:691  data: { done: subtitleRounds, total: subtitleQueue.length }   字幕
```
**`progress` 载荷没有任何工作台判别字段**。前端收到 `{done:3,total:47}`
**无法知道这是识别的 3/47 还是字幕的 3/47**。

且节流是**全局单标量**（`scoutEvents.ts:91` `private lastProgressAt = -Infinity`），
三个工作台共用一个 1 秒窗口——阶段切换那一秒会互相挤掉。

而 §3.5 的 `current: { kind:'subtitle'|'translate' }` 是**两态的，实际有三个工作台**。
这个 DTO 在写下的那一刻就漏了 identify。

**这是第 10 次同型缺陷，形态是新的**：
前 9 次是「加了能力没定谁读」，这次是
**「两条用户裁决互相矛盾，实现挑了一条执行，设计文档两条都引用却没发现冲突」**。

**裁决（选 c）**：
- 保留识别的 emit（那条"大库几小时活动页是死的"的顾虑成立）
- 但 `ScoutEventInput` **加必填 `workbench: 'identify'|'subtitle'|'translate'` 判别字段**
- 活动页仍是两 tab（守 R-F1），**识别态降级为顶部一行状态条**
  （「正在识别 3/47 部作品」），不占 tab
- `progress` 节流改成 **per-workbench**（`Map<workbench, lastAt>`）
- `current.kind` 扩成三态

### 🔴 教训八：七态判定优先级缺失，而冲突组合是**常态**不是边缘

`skip_reason` 与 `sub_status` 由**两个互不知情的阶段、按两套完全不同的判据**写入：

| 列 | 写入者 | 判据 |
|---|---|---|
| `skip_reason` | `judgeOnce`（阶段 2.5） | **纯语言事实**，`daemonV2.ts:865` 注释明写「不探磁盘」 |
| `sub_status` | `observeSubtitle`（阶段 1） | **纯磁盘事实**（R24），代码原文「不论原状态是 NULL 还是停牌态」 |

于是：**国产剧 + 用户手放一份 `.zh.srt`** → `skip_reason='origin-skip'` **且** `sub_status='covered'`。
这一格同时满足 E01 ✓（绿）与 E03 ◇（灰）。`embedded` + `covered` 同理。

v3 的七态表是**七行平铺、没有优先级序**。实施者必然停下来问；
自己猜的话两种猜法都说得通，而**猜错不报错、不红测试，只是全库一批格子颜色是错的**。

**裁决：写死优先级链**
```
1. sub_status='covered'           → ✓ 绿   磁盘事实最硬（用户可换可删）
2. sub_status='handoff_translate' → ⇄      在跑
3. sub_status='unsolvable'        → ⊘      终局
4. skip_reason='origin-skip'      → ◇      不需要
5. embedded_langs 含目标语言       → ◆
6. needs_subtitle=1               → ···
7. needs_subtitle IS NULL         → 未判定（§4.4 的"正在重新判定"过渡态）
```
⚠️ 第 7 档是 v3 漏的——**七态其实是八态**。§4.4 识别出了这个过渡态，§4.3 没给它位置。

### 🔴 教训九：§3.5 的"最小改法"是假修复，而专门验它的那条验收也被同一个洞穿透

v3 §3.5 写「四个 emit 点各加一句 UPDATE，**成功读取时清空**」。两处都不成立：

**① 四个 emit 点不同型。** `daemonV2.ts:542` 在 `run()` 的 catch 里包整个 `runInspection`，
**它手上没有 root**（已核实）。这一个 UPDATE 写到哪一行去？
全部 roots 一起标错是谎报（可能只坏一个根），不标则"四个"就是三个。

**② "成功时清空"的落点不存在**，而且不是忘了写——扫描循环的成功路径上有**三条**分支
（一次读成功 / 重试后成功 / C47 重读恢复），三条都得清，漏一条就从"永远误灭"变成"永远误亮"。
更隐蔽的是 C47 的分支②（判定为真实删除、照常放行）既不 emit 也是成功路径。

**③ 因此 §6③ 的验收（umount → ok=false → 恢复 → ok=true）测得出 false 但测不出回 true。**
那条验收本是专门用来钉"永远误灭"的，**它自己被同一个漏洞穿透了**。

**改法：不要"emit 点写 / 成功点清"，改成单点收敛**——每根循环末尾无论成败统一写一次：
```ts
db.prepare('UPDATE media_roots SET last_error=?, last_checked_at=? WHERE path=?')
  .run(rootFailed ? reason : null, now, root)
```
`:542` 那个巡检级 health 排除在 `roots[]` 之外，它属于 `/health` 顶层的 `lastInspectError`。

### 🔴 教训十：`#/library` 重定向到 legacy = 把用户送进一个恒空页面

v3 §2.2 判定「静默串页比 404 危险得多」，于是让 `#/library/*` 重定向到 `#/legacy/library/*`。
**但 §八.6 自己记着「旧 library 读 `series`（0 行）会显示空」——两段没连上。**

拼起来：老书签 → 重定向 → 读 0 行的表 → **白屏**。
v3 列的三种结局（正常/404/串页）**漏了实际会发生的第四种：稳定地什么都没有**。

**改法**：`#/library` 与 `#/library/:id` 都重定向到 **`#/media` 列表**，**丢弃 id 段**，
顶部一次性提示「媒体库地址已更新」。丢 id 消除串页风险，落到有数据的新列表而非 0 行旧表。
`_legacy/library` 只从设置页入口进入，不接管任何书签。

### 审计攻击过但没攻破的（它主动列出，我认可）

§3.4 选 (b)、§3.5 判定 `listSubtitleQueue` 语义相反、E06/E07 必须与 E04 可分、
hash 路由 + Tab 拆型、划掉 `chinese_titles` 疑虑、§4.4 五种异常态、
无循环依赖、「不自己写重连」——这八条实跑核实后成立。

---

## 零·四、第四轮：换成"新人视角"，卡在 9/12 步

前三轮攻**内容**（事实/遗漏/决策）。第四轮换角色——审计员扮演**入职第一天的工程师**，
拿着文档**真的去执行** §5 的 12 步。结果：**只有 1 步能独立完成**，可执行性评分 **35%**。

它的判词一针见血：
> **这份文档把「该做什么」想得很透，但把「怎么做」全留在了作者脑子里。**
> 它假设读者已经在这个仓里待了很久。

### 🔴🔴 教训十一：§2.1 的 activity/workflow 处置是**反的**，照做会立刻编译失败

我在 §2.1 写：
| activity | ⚠️ **当前已不在导航里** | 重写 |
| workflow | ❌ 含假按钮 redispatch | **删** |

**两条都错，而且第一条方向是反的**：
```
$ grep -n "route.tab ===" web/src/shell/AppShell.tsx
94:  {route.tab === 'workflow' && <ActivityPage />}      ← workflow tab 渲染的就是活动页
$ grep -rn "from '../workflow/" web/src/activity/*.tsx
ActivityPage.tsx:29  RunDetail        ← activity 四处依赖 workflow
ActivityPage.tsx:30  RerunDialog
ActivityHero.tsx:71  useLiveTrail
ActivityDone.tsx:40  decisionPhrase
```

`AppShell.tsx:10-13` 的注释写得明明白白：「2026-07-31：Workflow tab 换成活动页……
Lanes 一族暂时保留在 workflow/ 下未删——**RunDetail 与 RerunDialog 仍被活动页复用**」。

**按字面执行：删掉 `workflow/` → `activity/` 的 8 个测试 + ActivityPage 立刻编译失败。**

前三轮查了 `route.ts` 三次，**没有一轮打开 `AppShell.tsx`**——
而 tab id 到页面组件的映射就在那里，且**和 tab 的名字不是一回事**。

**改**：
| activity | ✅ **生产在跑，挂在 `#/workflow` tab 下** | 重写 |
| workflow | ⚠️ Lanes 部分删，但 `RunDetail`/`RerunDialog`/`useLiveTrail`/`phrases` **被 activity 复用，必须先迁出** | 部分删 |

### 🔴 教训十二：`workbench` 必填字段有 6 个调用点填不了

实测 **13 个** emit 点（我文档里写的"11 个"也是错的），其中六个不属于任何工作台：

```
:519 巡检开始   :531 巡检完成   :542 巡检失败        ← 巡检级
:1300 :1306 :1375  三条 health   ← 阶段 1 扫描级，不属于识别/字幕/翻译任何一个
```

**必填 = 这六处必须编一个值**。编 `'identify'` 是撒谎；加 `'inspect'|'scan'` 就变五态，
而 §3.5 刚说 `current.kind` "扩成三态"——又对不上。

**裁决**：`workbench` 改成**可选**，只在三个工作台的 7 个点填；
判别靠 `workbench !== undefined`。`current.kind` 保持三态（它只描述工作台）。

### 🔴 教训十三：`npm test` 不查类型，58 处类型错误能全绿通过验收

```
$ node -e "..." → test: vitest run | check: tsc --noEmit    ← 两条独立命令
```
vitest 用 esbuild transpile，**类型错误直接忽略**。而 `workbench` 字段波及
**13 个生产调用点 + 45 处测试构造点 = 58 处**。

按文档做完 ⓪ 之后：`npm test` 全绿 / `npm run check` 58 个错误。
而 §6 的验收表**从头到尾没提过 `npm run check`**——新人会带着 58 个类型错误交差。

### 🔴 教训十四：后端测试基线是红的（7 条），而 §6 只给了前端基线

```
前端  78 文件 / 863 用例 / 0 失败    ✅ 我文档里的 78 是准的
后端 142 文件 / 3217 用例 / 7 失败   ← §6 完全没提
```

那 7 条（deployContract 3 / buildAdapters 2 / secrets 1 / settingsRepo 1）
是我接手前就有的债务，**我知道，却只把它写进 §八 债务，没写进 §6 的基线条目**。

后果：新人改完六个后端步骤后跑测试看到 7 红——**是我弄坏的还是本来就有的？**
六个后端步骤因此**永远没有"做完了"的判据**。这正是教训五控诉的病，只是这次长在验收层。

### 🟡 其余卡点（审计列了 9 个，摘要）

| 卡点 | 缺什么 |
|---|---|
| **文件路径全缺** | 全文引用 6 个文件名**一个都不带路径**。审计猜 `scoutEvents.ts` 在 dashboard（实际 `src/core/`）、猜 `notificationsRepo.ts` 在 core（实际 `src/v2/`） |
| **迁移隐含规则** | 新列**只能写进迁移数组的条件式 ALTER**，绝不能同时改顶部 CREATE TABLE 终态定义——这条规则只存在于 `works` 表定义末尾的源码注释里，文档一字未提。③ 和 ⑥ 会各踩一次 |
| **"循环末尾"到不了** | 教训九的单点收敛 SQL 说"每根循环末尾统一写一次"，但那个循环里有多处 `continue`，**末尾根本到不了**。要改 `try/finally` |
| **七态类型没定义** | 给了优先级链没给类型。且 `SubtitleDot` 被**三个 DTO 共用**，扩成七态会波及列表页海报卡 |
| **第 8 态无名无符号** | 教训八自承"七态其实是八态"，但第 8 态没进表、没有符号、§4.4 的"占比高"没给阈值 |
| **符号怎么渲染** | ⊘⇄◇◆✓··· 讨论了两节，**从没说是文本还是 SVG**。当文本则六个字符字宽基线全不一致 |
| **dev server 怎么起** | 文档 772 行零字。而 SSE 需要跑完整的 `watch`（daemon 会读守备目录、调 TMDB、可能烧 LLM），没有轻量模式 |
| **Tab 拆型波及 6 处** | `route.ts`/`tabs.ts`/`Sidebar.tsx`/`NavIcons.tsx`/`AppShell.tsx`/`i18n×2`。其中 `AppShell.tsx` 5 处分支 + i18n 三个 key **不报错只静默失效** |
| **Context 放哪** | 全文唯一线索是"`ScoutEventsProvider` 层"，没说目录、没说四个 Context 是四个文件还是一个 |

### 审计给的"补三处收益最大"（已采纳）

1. **§2.1 的 activity/workflow 处置** —— 唯一一条照做会立刻编译失败的
2. **全文补仓库相对路径 + §5 每步补"要改哪些文件"清单** —— 纯机械，一次解掉三个卡点。
   `tabs.ts:8-10` 的注释已经是现成模板（它列了"重启用一个 tab 要同步改的 5 处"）
3. **§6 加两条基线**：后端 142/3217/**已知 7 红**（点名）+ `npm run check` 与
   `cd web && npx tsc --noEmit` 退出码 0

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
| activity | 4703 | 8 | ✅ **生产在跑，挂在 `#/workflow` tab 下**（`AppShell.tsx:94`）。⚠️ v3 写「已不在导航里」**方向是反的** | **重写** |
| settings | 3853 | — | ✅ live test 全程在用 | **保留** |
| library | 2670 | — | ❌ 读 `series`（生产 0 行） | **重写** |
| workflow | 1640 | — | ⚠️ Lanes 部分含假按钮 redispatch，但 `RunDetail`/`RerunDialog`/`useLiveTrail`/`phrases` **被 activity 四处 import**（照 v3 判「删」会立刻编译失败） | **部分删，复用件先迁出** |
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

**裁决：继续 hash 路由。**

⚠️ 二轮审计纠正 v2 的一处错误现状：v2 说「`parseShellHash` 现在只读第一段」——
**是错的**。`route.ts:35-63` 已经在读三段（`#/library/movies/:id` 是生产在跑的路由），
`decodeURIComponent` 的 `URIError` 兜底也已经有了。`legacy` 只需加一个分支，不是改造 parser。

**Tab 必须拆成两个类型**（否则 `Record<Tab, Icon>` 会逼你给不进导航的 `legacy` 编个图标）：

```ts
export type NavTab = 'activity' | 'notifications' | 'media' | 'settings'  // 进导航
export type Route  = NavTab | 'legacy'                                     // 全部路由
```

`legacy` 用二级段：`#/legacy/library`、`#/legacy/workflow`、`#/legacy/verify`。

### ⚠️ 新媒体库页用 `#/media` 而不是复用 `#/library`（二轮审计 🔴）

v2 原本让新页面接管 `#/library`。**风险**：用户现存的 `#/library/tmdb:1396` 书签
会打开新详情页，而新旧读**不同的表、不同的 id 空间**——
旧的是 `series.id`、新的是 `works.id`，**两者都长成 `tmdb:<数字>`，肉眼不可分**。

三种结局都不报错：正常显示 / 404 / **显示另一部剧**。最后一种是静默错误。
而 `route.ts:37` 的兜底是「无法识别的 tab 一律降级到 `library`」，
连 `#/triage` 这种老书签也会落到新页面上。

**裁决：新页面用 `#/media`，`#/library/*` 重定向到 `#/legacy/library/*`。**
静默串页比 404 危险得多。

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
  └─ 唯一的 EventSource（R-F10：6 连接上限）
       └─ 四个**独立** Context，各自 setState
            ├─ <ActivityCtx>  → 活动页（按 workbench 分流，见下）
            ├─ <FoundCtx>     → 通知页角标 + 活动页"刚找到"
            ├─ <HealthCtx>    → 全局横幅
            └─ <ProgressCtx>  → 活动页当前项进度
```

⚠️ **必须是四个独立 Context，不能是一个**（三轮审计 🟡）：
React 的 Context 传播语义是「value 引用变化 → 所有 consumer 无条件重渲染」，
`memo` 挡不住 consumer 本身。progress 每秒一条 → 单 Context 会让
活动页 + 通知页 + 全局横幅**每秒全树重渲染**，巡检期间持续几小时。
拆四层后 progress 只碰 `ProgressCtx`。零依赖、零外部库，§七 的裁决仍成立。

⚠️ **activity/progress 必须按 `workbench` 分流**（教训七）：
后端要加必填判别字段后，活动页据它分三路——
`subtitle`/`translate` 进两个 tab，`identify` 进顶部状态条（守 R-F1）。

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

选 (b) 的理由：**单一数据源避免幂等口径分裂**（列表永远只由 `/api/v2/notifications` 出）。

⚠️ 二轮审计纠正了 v2 对 (a) 成本的夸大：v2 说 (a)「要改 daemonV2 取数层」，
但 §3.4 自己写着 `report.installed[].itemId` 已含 workId+season+episode——
**数据就在手边**，(a) 只是在 emit 里多带三个已有字段。所以理由不是"改动小"，是上面那条。

**消解条件（二轮审计 🔴：v2 全文 436 行没定义，会让实施靠猜）**：
- 角标**累积不自动清**，仅在成功拉取 `/api/v2/notifications` 后归零
- 跨页面保持（挂在 `ScoutEventsProvider` 层，不随页面卸载）

**文案不许报数**：写「有新字幕 · 点击刷新」，**不写「刚找到 3 条」**。
因为 `recordFound` 是幂等刷新而 SSE 每次都发——报 27 条、点开列表只多 19 条，
**这个差值就摆在用户眼前**。v2 已经论证过这个不一致，却又在文案里踩回去。

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

### ⚠️⚠️ 但这个端点是三个工程，不是一行字（二轮审计 🔴）

| 字段 | 数据源实况（已实测） | 成本 |
|---|---|---|
| `lastInspectAt` / `engineEnabled` / `roots[].path` | ✅ 有落库（`meta` / `settings` / `media_roots`） | 直查即可 |
| **`roots[].ok` / `lastError`** | ❌ **不存在**。四个 health 发射点（`daemonV2.ts:1300/1306/1375/542`）只 `log()` + `emit()`，**零 UPDATE**。`media_roots` 实测只有 `path/type/added_at/content_type` | **要加列 + 四处写入** |
| **`current`**（正在处理什么） | ❌ **架构上拿不到**。dashboard 在 `index.ts:632` 启动、daemon 在 `:745` 才 `new`；且 `subtitleQueue`/`subtitleRounds` 是 `runInspection` 的**局部变量**（`daemonV2.ts:670-671`），连实例字段都不是 | **要落库或改 holder 注入** |
| `queue` | 🟡 `listSubtitleQueue` 能调，但**语义相反**——它返回"现在重查会捞到什么"，而 R4 的设计是**冻结快照**（`daemonV2.ts:660` 有大段论证）。用它会让活动页 total 与 SSE 的 total 对不上，且越跑越飘 | **不许用它** |

**不补 `roots[].ok` 的后果比 v1 更糟**：端点不知道根坏了，只能返回 `ok:true`，
用户刷新一次灯就灭，而根其实还坏着。**从「永远不灭」退化成「永远误灭」。**

**最小改法**：
1. `media_roots` 加 `last_error TEXT` + `last_checked_at INTEGER`，
   四个 emit 点各加一句 UPDATE，成功读取时清空
2. `current` 二选一：落库到 `meta`（简单、天然跨对象）或改 `startDashboard` 为 getter 注入
   （照 `tmdb: () => clients.current.tmdb` 的既有 holder 模式）+ 把局部变量提成实例字段
3. `queue` 砍掉，活动页的 total 只信 SSE

⚠️ 附带实测发现：**`meta` 表里没有 `last_inspect_at` 行**
（只有 `last_ingest_at`/`last_orchestrate_at`/`last_trace_prune_at`/`schema_version`）——
生产 daemon **从未成功跑完一轮完整巡检**。所以 `lastInspectAt` 会返回 0，
前端必须把"0"当**冷启动**处理，不能显示成「上次巡检：1970-01-01」。
这也意味着 §5 第⑧步「跑满一个巡检周期后删 `_legacy`」这个 trigger **目前不可达**。

### 3.6 待补④：活动页当前状态没有快照端点（审计 F-6）

同理，`activity` 事件是**变化**不是快照。断线期间巡检跑完的话，
若缓冲被 progress 冲掉，前端会永远停在"正在处理 X"。

**裁决**：`/api/v2/health` 一并返回当前工作台快照：
```
{ ..., current: { kind:'subtitle'|'translate', title, index, total } | null, queue: [...] }
```
活动页首次加载与重连后拉它，之后靠 SSE 增量更新。

### 3.7 不做前端缓存

数据一天变一次，每次进页面重新拉最简单。加**前端状态缓存**要处理失效，
而失效时机恰好是"巡检完成"——那是个 SSE 事件，引入不必要的耦合。

⚠️ 但三轮审计指出 v3 的理由是**假两难**：后端 JSON 响应头实测**只有 content-type**，
无 `ETag`/`Last-Modified`/`max-age`，所以列表↔详情来回点会每次全表聚合
（`files` 1290 行 + `tmdb_seasons` 2144 行 + JS 端聚合）。

**加一个后端 `ETag`（`buildMediaLibrary` 结果的 hash）零失效逻辑**——
内容变了 hash 就变，不需要订阅 SSE。304 直接省掉传输。
「不做前端状态缓存」这个决策保留，但别拿"失效难"当不加 ETag 的理由。

（海报本身没问题：`posterPath` 直出 `image.tmdb.org`，TMDB CDN 自带长缓存。）

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
实线 + E03 ◇    原生同语言     skip_reason='origin-skip'          ← R-F15
实线 + E04 ···  待处理        needs_subtitle=1 且 sub_status IS NULL
实线 + E06 ⊘    无解停牌      sub_status='unsolvable'（终局）     ← 二轮审计补
实线 + E07 ⇄    翻译中        sub_status='handoff_translate'      ← 二轮审计补
虚线 + E08      磁盘上没有     tmdb_seasons 有、files 没有
```

**虚线格子不染色**（磁盘上没有文件，谈不上字幕状态）。

⚠️ **E06/E07 必须与 E04 视觉可分**（二轮审计 🔴）：
`unsolvable` 是**终局**（判定无解、永久停牌，不会再动），`handoff_translate` 是**在跑**
（已移交翻译流）。若都并进"待处理"，用户会等一个永远不来的结果，
或把正在翻译的当成卡住——**两个语义相反的状态同色**。
这是「把终局量说成中间量」，本仓栽过四次的镜像版。

⚠️ **`db.ts:555` 的值域注释已过期**（写 `NULL/missing/covered/embedded/unavailable`，
漏了这两个停牌态；而 `episodes`/`movies` 旧表的 CHECK 枚举也不含它们——两套表值域已劈叉）。

### ⚠️⚠️ 后端必须先改：DTO 现在给不出这五种里的三种

**实测**（二轮审计 🔴，我核实过）：
```
grep "skip_reason|needs_subtitle" src/dashboard/mediaLibraryApi.ts  →  零命中
SubtitleDot = 'none' | 'blue' | 'green'                             →  只有三态
MediaLibraryEpisodeDTO = { episode, title, onDisk, dot, fileCount, subtitledFileCount }
```

| 格子 | 数据源 | DTO 现状 |
|---|---|---|
| E01 ✓ | `dot==='green'` | ✅ 有 |
| E02 ◆ | `dot==='blue'` | ✅ 有 |
| E03 ◇ | `skip_reason` | ❌ **DTO 没有，SQL 也没查** |
| E04 ··· | `needs_subtitle` | ❌ **DTO 没有** |
| E06 ⊘ / E07 ⇄ | `sub_status` 原值 | ❌ **查了但只用来算 covered，之后丢弃** |
| E08 虚线 | `onDisk` | ✅ 有 |

**v2 §4.3 原文写「◇ 就是 skip_reason 唯一的读者——不接就是第 8 次同型缺陷」，
却没说要改后端。照那样实施，第 9 次当场发生。**

**修法（四轮审计要求钉死，v3 那个"或"把关键裁决留给了实施者）**：

**优先级链在后端 `src/dashboard/mediaLibraryApi.ts` 实现**（不透传原值让前端算——
前端不知道 `target_languages` 是什么，那是 R-F15 的后端判据）。

```ts
// 新增字段，八态。SubtitleDot 保持三态不动（它被三个 DTO 共用，
// 扩它会波及列表页海报卡，而列表页是"底部渐变嵌进度条"不是点）
export type EpisodeState =
  | 'covered'      // ✓ 绿   sub_status='covered'
  | 'translating'  // ⇄      sub_status='handoff_translate'
  | 'unsolvable'   // ⊘      sub_status='unsolvable'
  | 'origin-skip'  // ◇      skip_reason='origin-skip'
  | 'embedded'     // ◆      embedded_langs 含目标语言
  | 'pending'      // ···    needs_subtitle=1
  | 'unjudged'     // ?      needs_subtitle IS NULL（第 8 态，v3 漏了）
  | 'absent'       // 虚线   onDisk=false（不染色）
```

**第 8 态 `unjudged`**：符号用 `?`，中性灰。它在换语言重判期间是**多数态**
（生产实测 `skip_reason` 1192 行全 NULL）。§4.4 的"正在重新判定"横幅
触发阈值定为：**`unjudged` 占比 > 30%**。

**符号怎么渲染**（v3 讨论了两节从没说）：统一走一个
`<EpisodeMark state={...} />` 组件，**内联 SVG 12×12**，笔画照 `NavIcons.tsx` 的 1.8px 约定。
不用 Unicode 文本——`···`(U+22EF) 与 `⇄`(U+21C4) 的字宽基线不一致，塞进集号格会歪。

### 4.4 异常态（v1 完全没写，审计 F-11）

| 场景 | 处置 |
|---|---|
| API 500 / 网络失败 | 显示错误态 + 重试按钮。**绝不显示空闲态文案**（那是谎报） |
| SSE 503（bus 未接） | ⚠️ v3 原写"连续 3 次失败后停止重连"，**没有恢复路径**（三轮审计 🟡）——503 在 setup 模式下是常态，用户配完 key、bus 接上了，前端却已自杀且不会回来。<br>且 `EventSource` 的 `onerror` **区分不了 503 与普通断网**，30 秒断网就可能触发永久停连——**与 §6 的"断网 30 秒能自动重连"验收直接打架**。<br>**改法**：不硬停，改**指数退避到 60s 上限**；同时横幅带「实时更新不可用 · **重试**」按钮，点击 `new EventSource()` |
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

⚠️ 二轮审计：v2 把三个不同量级的后端工程压成了三行字。展开后是 11 步。

```
### 本地开发怎么跑起来（四轮审计：v3 772 行零字）

```bash
# ① 起后端（8099）。⚠️ watch 是完整日巡检 daemon，会读守备目录、调 TMDB、可能烧 LLM
SUBTITLE_SCOUT_CACHE_DIR=./cache-local npm run cli watch
# ② 起前端（5173，vite.config.ts 已配 /api → localhost:8099 代理）
cd web && npm run dev
```
⚠️ **SSE 必须跑 ①**：`events: scoutEvents` 只在 `cmdWatch` 里注入（`src/cli/index.ts:662`），
不跑 watch 的话 `/api/v2/events` 恒 503（`src/dashboard/server.ts:661`）。**没有轻量模式。**

### ⚠️ 迁移的隐含规则（③ 与 ⑥ 各会踩一次）

**新增列只能写进 `src/v2/db.ts` 迁移数组末尾的条件式 ALTER entry，
绝不能同时改顶部的 CREATE TABLE 终态定义。**

这条规则只存在于源码注释里（`works` 表定义末尾：「`provider_ids` 不在此终态定义里……
**两处都写会让"改一处忘另一处"变成可能**」）。可照抄的先例：
`media_roots.content_type`（v30）、`works.provider_ids`（v36）。

同时要改 `src/v2/db.test.ts` 的 **16 处**版本号字面量
（15 处 `value: 'NN'` + 1 处 `expect(MIGRATIONS.length).toBe(NN)`——后者不是 `value:` 形态，
两个 subagent 分别数成 14 和 15 都漏了它）。

**依赖图**（三轮审计 Y4：v3 只标了一处，实施者会以为全串行）
```
①②③④⑥⓪ 六步互不依赖，可全并行
⑤ ← ③④          （health 端点是前四步做完后的组装）
⑦ ← ⑤            （useHealth 的基线源；v3 说⑦是"共同地基"漏了这条）
⑧ ← ② + ⑦        （七态染色是媒体库页的核心视觉，v3 没标）
⑨ ← ⑥ + ⑦ + ⓪
⑩ ← ① + ⑦
```

```
后端（必须先做，每步都要有验收，见 §6）
⓪ ScoutEventInput 加**可选** workbench 字段 +      中：教训七。不做则前端拿到
  progress 节流改 per-workbench                     {done:3,total:47} 无法区分
  ⚠️ 必须**可选**不能必填（教训十二）：实测 13 个
  emit 点里有 6 个填不了——:519/:531/:542 是巡检级，
  :1300/:1306/:1375 是阶段 1 扫描级，都不属于任何工作台。
  判别靠 `workbench !== undefined`；current.kind 保持三态
  改动波及 13 生产点 + 45 测试构造点 = 58 处（必跑 npm run check）
① 补 GET /api/v2/notifications                    小：读函数已有，只缺端点
② mediaLibraryApi 补 skip_reason/needs_subtitle/  中：改 2 条 SQL + DTO + 染色判别
   sub_status 透传，DTO 从三态扩到七态             ← 不做则 ◇⊘⇄··· 无数据，第 9 次同型缺陷
③ media_roots 加 last_error + last_checked_at，   中：迁移 + 四个 emit 点各加 UPDATE
   四个 health 发射点落库                          ← 不做则 /health 的 roots.ok 只能撒谎
④ current 的数据源二选一（落库 meta / holder 注入） 中～大：涉及 daemonV2 + cli/index + server
⑤ 补 GET /api/v2/health（依赖 ③④）                小：前四步做完后只是组装
⑥ 补 works.backdrop_path + 回填 + identifyScheduler 中：迁移 + 回填 pass + 写入点
   写入点                                          ← 只补回填不补写入 = 只修一半

前端
⑦ shell 改造：Route/NavTab 拆型 + SSE Context      ← 需 ⑤ 先落地（useHealth 基线源）
   要改 6 处（四轮审计实测，v3 说"只需加一个分支"把工作量说小了）：
     web/src/shell/route.ts      Tab/TAB_IDS/isTab/ShellRoute.tab/go()
     web/src/shell/tabs.ts       TabMeta.id / NavLabelKey / TABS  ← 它的头注释就是现成模板
     web/src/shell/Sidebar.tsx   TAB_ICONS: Record<Tab,...> 穷尽映射
     web/src/shell/NavIcons.tsx  补 2 个图标（18×18、笔画 1.8px、currentColor）
     web/src/shell/AppShell.tsx  5 处 route.tab === 分支  ⚠️ 改错只静默失效不报错
     web/src/i18n/{en,zh}.ts     3 个新 nav_* key        ⚠️ 漏了只显示 key 不报错
   SSE Context 放 web/src/events/（四个独立 Context 各一文件 + Provider）
⑧ 媒体库页（列表 + 详情）                          ← 纯 HTTP，能在 SSE 未通时先验 ⑦
⑨ 活动页                                          ← 依赖 SSE + backdrop
⑩ 通知页                                          ← 依赖 ① + SSE 提示

收尾
⑪ 旧页面移入 _legacy；docker build 验证；
   跑满一个巡检周期后删（trigger 见下）
```

⚠️ **⑪ 的 trigger 目前不可达**：实测 `meta` 表**没有 `last_inspect_at` 行**，
生产 daemon 从未成功跑完一轮完整巡检。删除条件改成可观测量：
「`meta.last_inspect_at` 出现且 ≥ 实施完成时刻」。

⚠️ **⑪ 与 §七 的冲突（二轮审计 🔴）**：⑪ 说"跑满一周期后删 `_legacy`"，
而 §七说 `subtitleVerify` "跑稳后单独裁决"——两句话对同一个目录给出相反处置。
**裁决**：⑪ 只删 `_legacy/library` 与 `_legacy/workflow`；
`_legacy/verify` **不在本次删除范围**，其去留与它的 6 个后端端点一并单独裁决
（否则会留下一组无 UI 的活端点，正是本仓的招牌缺陷形态）。

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
| 通知页 | **组数**（端点返回 `FoundGroup[]` 是按 work+season 聚合的）== `SELECT COUNT(DISTINCT work_id\|\|'/'\|\|COALESCE(season,-1)) FROM notifications WHERE found_at > now-7d`。⚠️ v3 原写 `COUNT(*)`（逐集行数），与实现口径不符、永远不通过——同一份文档里两条验收对同一端点给了两个口径 |
| SSE | 断网 30 秒再恢复，页面自动重连；**且断线期间巡检若跑完，重连后活动页能靠 `/api/v2/health` 纠正**（这条专门验 F-6） |
| **前端测试** | `cd web && npx vitest run` → 文件数 >= **78**、用例 >= **863**、失败 **0**（实测基线，前端是干净的） |
| **后端测试** | `npx vitest run --exclude '**/web/**'` → 文件数 >= **142**、用例 >= **3217**、失败 **必须恰好是那 7 条既有债务**：deployContract×3 / buildAdapters×2 / secrets×1 / settingsRepo×1。<br>⚠️ **不得 >7、不得出现新面孔**。v3 只给了前端基线，导致六个后端步骤永远没有"做完了"的判据（教训十四） |
| **类型检查** | `npm run check` **且** `cd web && npx tsc --noEmit`，两条都要退出码 0。<br>⚠️ **vitest 不查类型**（esbuild transpile 直接忽略）——⓪ 的 `workbench` 字段波及 58 处，不跑这条会带着 58 个类型错误全绿交差（教训十三） |

### 后端六步的验收（二轮审计 🔴：v2 完全没有，那三步"永远算不完"）

| 步 | 验收 |
|---|---|
| ① notifications 端点 | `curl /api/v2/notifications \| jq length` == `SELECT COUNT(DISTINCT work_id\|\|'/'\|\|COALESCE(season,-1)) FROM notifications WHERE found_at > now-7d` |
| ② DTO 扩七态 | 对每个 `sub_status` 值域（含 `unsolvable`/`handoff_translate`）**造一行测试数据**，验 DTO 能透传。⚠️ 生产当前这两态是 **0 行**，不能靠生产样本验 |
| ③ media_roots 健康列 | ⚠️ **不许用 umount**（三轮审计 🟡）：容器把宿主 `/` 挂进 `/hostroot`，卸掉 115 的 rclone 挂载 = 全库不可访问，且 R8 三道闸里 umount 只触发第一道，而生产真实出事那次（04:07）走的是第三道 C47——**只验三分之一**。<br>**改注入式**，喂 `readRootWithRetry` 四种结局：① 抛 EIO 验 `:1300` ② 返回 `[]` 验 `:1306` ③ 返回 40% 文件验 `:1375`（C47，真出过的那档）④ 恢复正常验 `last_error` **被清空**（教训九说的那个缺失点）。<br>生产端到端想验一次：**临时新建空目录当守备目录再 `chmod 000`**，代价可控、不碰 115 |
| ④ current 数据源 | 巡检期间 `curl /api/v2/health` 的 `current.title` == `docker logs` 里当前那行「字幕 X (N 文件, 第 i/n 个)」的 X |
| ⑤ health 端点 | 逐字段核对：`lastInspectAt` 对 `meta`、`engineEnabled` 对 `settings`、`roots[]` 对 `media_roots`。⚠️ `lastInspectAt` 当前会返回 **0**（生产从未跑完一轮），前端要按冷启动处理 |
| ⑥ backdrop_path | 回填后 `SELECT COUNT(*) FROM works WHERE backdrop_path IS NULL` ≈ 0；**且新识别一部作品后再查一次**，验 `identifyScheduler` 的写入点也补了（只验回填不验写入 = 只修一半） |
| ⑪ 容器 | `docker build` 退出码 0 |

⚠️ **§6 的验收原则补一条**：查不到样本的状态记为**未验**，写进遗留——
**不许拿"没样本"当"通过"**。当前生产库 `skip_reason` 1192 行全 NULL、
`unsolvable`/`handoff_translate` 各 0 行，七态里有四态在生产上无法证伪。

⚠️ 最后一条是审计 F-10 补的：v1 知道 vitest 会静默丢文件（§八.3 写了），
**却没把它变成验收条目**——那本身就是"加了能力没定谁读"。

---

## 七、本轮不做，但要留路

⚠️ 审计 F-14 纠正 v1：v1 把移动端写进「明确不做的」，**曲解了用户裁决**。
用户原话是「先给桌面配置好了之后再说……将左侧 tab 变成下方 tab，然后折腾下宽度而已」——
这是**顺序**不是**排除**。

| 项 | 留什么路 |
|---|---|
| **移动端** | 用 **CSS 变量**落地，**不要用 clamp()**（三轮审计 🔵：clamp 要三个参数而 R-F13 只给了一个，实施者会卡住）。<br>`:root { --card-run-h:186px; --card-queue-w:59px; --card-queue-h:88px; --card-queue-fade:118px }`<br>移动端那轮**在 media query 里改变量值，不改组件**——这才是真正的"留路" |
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

2. ~~`works.chinese_titles` 可能普遍为 NULL~~ —— **二轮审计实测证伪：110/110 全非 NULL**，
   海报墙不会显示英文原名。此条划掉。

3. **SSE 缓冲会被 progress 冲刷**（审计 F-4）：`REPLAY_BUFFER_CAP=50`，
   而 progress 节流后仍可能几分钟内发几十条。巡检期间断线 2 分钟，
   `found`/`health` 会被挤出缓冲。这是 §3.5/§3.6 补两个快照端点的另一个理由。

4. **`vitest` 会静默丢整个测试文件**（实测 141 vs 142、总数少 220，
   而 `numFailedTests` 照样是 7）。验收必须同时断言文件数。

5. **SSE message 是后端硬编码中文**，与项目的国际化动机（R-F15）矛盾。
   将来做英文 UI 时这是第一个要改的地方。

6. **`_legacy` 期间两套页面读不同的表**。旧 library 读 `series`（0 行）会显示空——
   应在 `_legacy` 页面顶部加说明横幅，避免被当成 bug。

7. 🔺 **生产 daemon 从未成功跑完一轮完整巡检**（`meta` 无 `last_inspect_at`）。
   **三轮审计要求把它从"债务"升级为「实施前置调查项」**——理由很硬：
   若真相是"每轮都在中途失败"，那 `skip_reason` 1192 行全 NULL、
   两个停牌态各 0 行这些"七态无样本"现象**很可能同源于此**
   （judge 在阶段 2.5，若巡检总在阶段 1/2 挂掉，2.5 根本没跑过）。
   那样的话 §6 的"造数据补测"就不是权宜之计而是**唯一可能的验收方式**，
   且新前端上线后**长期只看得到四态**。
   一条命令定性：`docker logs subtitle-scout | grep -c "巡检失败"`。

8. **`sub_status` 值域在两套表之间已劈叉**：`files` 表无 CHECK 约束、实际有
   `handoff_translate`/`unsolvable`；而 `episodes`/`movies` 旧表的 CHECK 枚举不含它们。
   `db.ts:555` 的注释也已过期。删旧表时一并清理。

9. **七态里有四态在当前生产库无样本**（`skip_reason` 全 NULL、两个停牌态 0 行）。
   媒体库页的核心视觉在验收时**无法完全证伪**——必须靠造数据的单元测试补上。
