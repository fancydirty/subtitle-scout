# 审校报告 — Task 1a-2（`SettingsRepo.addRoot` 守备目录嵌套闸门）

- 审校对象：`addRoot` 返回 `AddRootResult`、`transaction().immediate()`、入库前 `resolve()`、`seedRootsFromEnv` 返回 `{seeded, rejected}`、`nestedRootSkipWarning()`、3 处生产调用点适配
- 审校方式：对抗性，读代码 + 跑测试 + 运行时探针实测，不推测
- 状态：**已完成**

---

## 1. 破坏性变更的调用方适配 — ✅ 通过（无漏改）

### 全仓 `addRoot(` 调用点穷尽枚举

`rg -n 'addRoot' --glob '!node_modules'` 的全部 `.ts/.tsx` 命中，按性质分类：

**生产调用点（2 个，均已适配）**
| 位置 | 是否消费返回值 | 结论 |
|---|---|---|
| `src/dashboard/apiV2.ts:856-864` | ✅ `const added = settingsRepo.addRoot(resolved, now)` → `if (!added.ok)` → 按 `relation` 分岔文案 | 正确 |
| `src/v2/settingsRepo.ts:235-237`（`seedRootsFromEnv` 内） | ✅ `if (r.ok) seeded.push(...) else rejected.push(...)` | 正确 |

**测试调用点（12 处，全部是"造前提"用法，忽略返回值合法）**
`apiV2.test.ts:454,465,476,487,617`、`server.test.ts:403,612,637,663`、`ingest.test.ts:1636,1641`、`settingsRepo.test.ts:73,78,79,84,85,97,114,182,193,204,222`、`settingsRepo.addRoot.test.ts` 内多处。这些都是 arrange 阶段建初始状态，不消费返回值不构成缺陷。

**`web/src/api/client.ts:199` 的 `addRoot`** 是前端 HTTP 封装（`post<{ok:true}>('/api/v2/settings/roots')`），与 repo 方法同名但无关。它的返回类型仍写 `{ok:true}` —— server 侧失败时返回 400 + `{error}`，由 `post` 的非 2xx 分支抛错处理，**未受本次变更影响**。

### 结构类型 mock 风险 — ✅ 实测排除（这是本项审查的重点，结论是安全的）

审校任务点出的高危假设：`apiV2.addMediaRoot` 参数是 `Pick<SettingsRepo, 'addRoot' | 'listRoots'>`（`apiV2.ts:822`），若测试里传结构 mock 且 `addRoot` 仍返回 `undefined`，则 `!added.ok` = `!undefined` = `true`，**正常加根会被误判成冲突**。

实测排查：
```
rg -n "Pick<SettingsRepo|as unknown as SettingsRepo|Partial<SettingsRepo|addRoot:" 
```
全仓仅 4 处命中，全是 `apiV2.ts` 自己的签名声明（`:648` `:822` `:925`）+ `web/src/api/client.ts:199`（无关）。**零个结构 mock 实参**。

`addMediaRoot` 的全部调用点：
- 生产：`src/dashboard/server.ts:598`，实参是真 `SettingsRepo` 实例
- 测试：`apiV2.test.ts:437,438,455,466,477,488`，实参全是 `new SettingsRepo(openDb(':memory:'))` 真实例（见 `:453` `:464` `:475` `:482`）

所以这条高危路径**当前不可达**。但它是一枚定时炸弹（见 🟡 F5）。

### `seedRootsFromEnv` 调用点 — ✅ 2 处生产全部消费 `.rejected`

| 位置 | 代码 |
|---|---|
| `src/cli/index.ts:195-197` | `for (const r of settingsRepo.seedRootsFromEnv(...).rejected) console.warn(nestedRootSkipWarning(r.path, r.conflict))` |
| `src/cli/index.ts:273-275` | 同款 |

测试侧 `settingsRepo.test.ts:92,98,103,105` 忽略返回值（arrange 用法，合法）。

**无动态调用**：`rg` 未发现 `['addRoot']` / `repo[method]` 一类反射式调用。

---

## 2. `resolve()` 归一化引入的新风险

### 🔴 F1 — `seedRootsFromEnv` 的相对路径被 `resolve()` 静默拼上 cwd，种出一个不存在的根，且**没有任何告警**

**证据**

- `settingsRepo.ts:201` `const canonical = resolve(path)` —— `resolve` 相对于 `process.cwd()`
- `settingsRepo.ts:231` env 解析只有 `split(',').map(trim).filter(Boolean)`，**无 `isAbsolute` 校验**（对比 apiV2 那条路 `apiV2.ts:827` 有 `isAbsoluteMediaPath` 门 + `:831` `existsSync` 门 + `:837` `isDirectory` 门）
- `settingsRepo.ts:236` `if (r.ok) seeded.push(root)` —— push 的是**原始** `root`，不是 `canonical`

**实测**（vitest 内探针，已删除探针文件）：
```
MEDIA_ROOTS='/media/tv/,media/rel'
seedResult = {"seeded":["/media/tv/","media/rel"],"rejected":[]}
dbRows     = ["/Users/dirtyfancy/projects/subtitle-scout/media/rel","/media/tv"]
```

**问题**

1. `media/rel` 被写成 `<cwd>/media/rel`。容器里 cwd 若是 `/app`，就落库成 `/app/media/rel` —— 一个几乎必然不存在的目录。
2. `addRoot` **不做存在性校验**（apiV2 那条路有，env 这条路没有），所以返回 `{ok:true}`，`rejected` 为空，`nestedRootSkipWarning` 不触发。**运维得不到任何提示**。
3. `seeded` 里 push 的是原始字符串 `media/rel`，与库里实际落的 `<cwd>/media/rel` **不一致**。目前 `seeded` 无消费者（`cli/index.ts:195` 只读 `.rejected`），但这是个已埋好的说谎字段。

**失效场景**（具体到用户操作）

运维在 compose 里写 `MEDIA_ROOTS=media/tv`（忘了前导斜杠，或从相对路径的 docs 抄来）。容器首启：
- 日志无任何警告
- dashboard 设置页显示守备目录 `/app/media/tv`（用户没写过这个路径，困惑）
- 扫描恒 0 文件，用户以为字幕功能坏了
- 更糟：`cli/index.ts:280-283` 的 `rootsMismatchWarningLine(envRoots, dbRoots)` 会因为 env 字符串与 DB 规范形态不等而**误报"env 与 DB 不一致"**。实测输出：
  ```
  [watch] ⚠️ MEDIA_ROOTS env (/media/tv/,media/rel) 与当前生效的守备目录
  (/Users/.../media/rel,/media/tv) 不一致——以 dashboard 设置页为准（env 仅首启种子）
  ```
  注意连**纯尾斜杠**这种完全合法的 env 写法（`/media/tv/`）也会触发这条误报 —— 归一化让 env 原文与 DB 规范形态必然不等。这是本 task 引入的**新回归**：1a-2 之前 `addRoot` 零规范化，env 原文直接落库，这条告警不会误报。

**修法**（两处，都在本 task 范围内）

1. `seedRootsFromEnv` 循环内加绝对路径守卫，非绝对的收进 `rejected`（或新增 `invalid` 字段）并告警：
   ```ts
   if (!isAbsolute(root)) { rejected.push({ path: root, conflict: ... }) ; continue }
   ```
   若不想动 `RootConflict` 形状，最低成本是在 `SeedRootsResult` 上加 `skipped: Array<{path, reason}>`，`cli/index.ts` 两处一并 warn。
2. `rootsMismatchWarningLine` 的比对两侧口径统一（env 侧也 `resolve()` 后再比），否则它从此永久误报。这是 F1 的连带修复，不修的话每个用了尾斜杠的部署都会看到一条假告警。

---

### 🟡 F2 — 存量非规范根未迁移，与新规范根**共存**成一对"逻辑相同、字符串不同"的行；`removeRoot` 对存量行永久失效

**证据**（实测）
```
// 库里预置存量行 '/media/tv/'（1a-2 之前的 seedRootsFromEnv 就能种出来）
legacyTrailing_then_canonical = {"ok":true}  rows=["/media/tv","/media/tv/"]

// 存量 '..' 形态
legacyDotDot_then_canonical   = {"ok":true}  rows=["/media/tv","/media/x/../tv"]
```

**根因**：`findOverlappingRoot:40` `if (c === r) continue` —— 归一化后相等被判为"重复提交，交给幂等"，但幂等落在 `INSERT OR IGNORE`（`settingsRepo.ts:209`），主键是 `canonical`，与存量的 `/media/tv/` 不等 → **插入成功，两行共存**。

代码注释 `settingsRepo.ts:190-191` 明确声称"尾斜杠形态的重复提交…落到 INSERT OR IGNORE，同样幂等"。这个断言**只在"存量已是规范形态"时成立**。测试 `settingsRepo.addRoot.test.ts:55-59` 之所以绿，是因为它先 `addRoot('/media/tv')` 建立的前提**本身已被 resolve 过** —— 这是一条测不到真实攻击面的用例（见 🟡 F7）。

**失效场景**

1a-2 之前部署的实例，`MEDIA_ROOTS=/media/tv/` 已在库里种成 `/media/tv/`。升级到 1a-2 后：
- 用户在 dashboard 里输入 `/media/tv` 加根 → apiV2 上游 `findOverlappingRoot`（`:844`）判"相等 → null，非重叠"放行 → `addRoot` 插入 `/media/tv` → **库里两行**
- 两行覆盖完全相同的子树 → `walkVideoFiles` 每个文件走两遍（正是本文件注释 `:9-11` 说的"scanned 从 492 涨到 3140"），同一文件在两根下各自登记
- D1 逐根差集在这个状态下的行为未验证，但这恰恰是 C29 类灾难的土壤

**另一半问题**：`removeRoot` 对存量非规范行永久失效。`server.ts:585` `settingsRepo.removeRoot(resolve(path))`，`removeRoot:260` 是精确 `WHERE path = ?`。库里存 `/media/tv/`，用户点删除传 `/media/tv/` → `resolve` 成 `/media/tv` → 查不到 → 404 "not a media root"。**用户无法通过 UI 删掉这个根**（1a-2 之前不存在此问题：R2D-6 的注释 `server.ts:578-581` 正是为了修尾斜杠 404，而入库侧一旦改成 resolve 就得配套迁移，否则旧行重新变成"删不掉"）。

**spec 有无要求迁移**：有。`docs/design/2026-08-08-PIPELINE-SPEC.md:318` "已存在的嵌套配置在迁移时告警"；`audit-round4.md:386` "上线 D7 的同时必须跑一次检测并**告警**"。计划把它归到 Task 1a-3（`detectNestedRoots`）。但 **1a-3 计划里只有"嵌套"检测，没有"非规范形态"检测** —— F2 这类行既不嵌套也不重复，`detectNestedRoots` 抓不到。这是计划的缺口。

**修法**：在 `db.ts` 的迁移里做一次性 `UPDATE media_roots SET path = <resolved>`（需在 JS 侧读出→resolve→回写，SQLite 无 resolve），或至少在 1a-3 的启动检测里加"非规范形态根"一类告警。**建议归入 1a-3，不阻塞 1a-2**，但要立项，否则升级实例会静默进入双根状态。

---

### 🟢 F3 — Windows 路径语义：项目已声明 Linux 容器，风险可接受

`resolve()` 在 win32 上会加盘符前缀，且 `sep` 是 `\`。但：
- `apiV2.ts:714` `isAbsoluteMediaPath` 显式接受 `C:\` 形状，`apiV2.test.ts:433` 有 "POSIX 上诚实报不存在" 的用例 —— 说明项目**有意只做形状容忍，不做 win32 支持**
- 部署形态是容器（`deployContract.test.ts` 存在）

不构成阻塞。仅记录：`review-task1a-1.md:174` 已指出 `subtitleScheduler.ts:43` / `scanner.ts:42` 硬编码 `'/'` 而 `findOverlappingRoot` 用 `sep`，win32 上行为分叉 —— 归入 F8。

---

## 3. 事务正确性 — ✅ 基本正确，一处语义待确认

### ✅ N 条 = N 个事务，符合 spec 意图

`seedRootsFromEnv:234-238` 循环里逐条 `addRoot`，每条一个 `immediate` 事务。

- **原子性**：这是 spec 明确要的行为。`step1a-plan.md:57` "冲突的**跳过并收集**"、`settingsRepo.ts:222` "不中断整批"。第 3 条冲突时前 2 条已提交，正是意图。用整批一个事务反而违背意图。
- **性能**：env 种子最多几条路径，一次性首启操作，N 个事务无实际开销。

### ✅ 嵌套事务不会炸 —— 实测确认，但原因是运气不是设计

better-sqlite3 对嵌套 `transaction()` 用 SAVEPOINT，不抛 "cannot start a transaction within a transaction"。实测：
```
db.transaction(() => { addRoot('/data') }).immediate()  →  OK
```

代码路径检查：无任何路径在 `removeRoot` 事务内调 `addRoot`（`removeRoot:265-322` 全是 DELETE/SELECT），反之亦然。`apiV2.ts:785` 的 `settingsRepo.db.transaction` 只包 `set()`。**当前无嵌套**，且即便将来出现也不会炸。

一点提醒（🟢）：嵌套时外层若不是 `immediate`，内层 SAVEPOINT 拿不到写锁 —— 但这是假设性风险，不记为缺陷。

### ✅ WAL + immediate 的并发交互正确

`db.ts` 开 WAL + `busy_timeout=5000`。`immediate` 立即拿 RESERVED 写锁，避免 SQLite 的"读锁升级写锁"死锁 —— 这正是 `review-task1a-1.md:251` 建议的手法，且与 `removeRoot:324` 一致。WAL 下写事务不阻塞读者。**正确采纳。**

---

## 4. 测试质量

### 🟡 F4 — 「拒绝时表里不留新行」的断言只到"观察等价"，注释却声称更强

**证据** `settingsRepo.addRoot.test.ts:35-36`：
```ts
// 关键：拒绝必须是"什么都没写"，不是"写了再回滚"的观察等价——直接查表确认只有一行
expect(settings.listRoots().map((r) => r.path)).toEqual(['/media/tv'])
```

注释说"不是观察等价"，但 `listRoots()` **恰恰只能给出观察等价**。而且实现是 `return { ok:false }` 提前返回、根本没走 INSERT（`settingsRepo.ts:207`），所以"写了再回滚"的情形不存在 —— 注释的断言意图与代码手段不匹配。

**严重度**：低。断言本身是对的（契约层面"表里只有一行"就是用户可见的全部），只是注释夸大了强度。不阻塞。若要真正区分，得断言 `db.prepare('SELECT changes()')` 或用 `total_changes` —— 过度测试实现细节，不建议。

### 🔴 F5 — 缺少「`addMediaRoot` 消费 `addRoot` 新返回值」的测试，`Pick<>` mock 缺口无锁

**证据**：`apiV2.ts:856-864` 是本 task 新加的代码（消费 `added.ok`）。但 `apiV2.test.ts:442-491` 的 4 条重叠测试**全部在上游 `findOverlappingRoot` 那道门就返回了**（`:844-852`），根本走不到 `:856`。

即：`apiV2.ts:856-864` 这段新增的 9 行代码**零测试覆盖**。`:853-855` 的注释自己承认"闸门是双保险，理论上不该命中"—— 一段理论上不该执行的分支，加上零覆盖，等于无人验证它写对了。

**失效场景**：将来某人给 `addMediaRoot` 写一个结构 mock（`{ addRoot: vi.fn(), listRoots: () => [] }`，`Pick<>` 允许），`addRoot` 返回 `undefined` → `!added.ok` = `!undefined` = `true` → 访问 `added.conflict.relation` **抛 TypeError**（不是误判成冲突，是直接崩）。tsc 不拦：`vi.fn()` 推断成 `any`/`Mock`，赋给 `Pick<SettingsRepo,'addRoot'>` 通过。测试会红，但红在 TypeError 上，排查成本高。

**修法**（低成本，锁住新增分支）：加一条测试，用真 repo + 制造上游与闸门口径分叉的场景。最直接的做法是构造一个"上游 `listRoots` 看不见、但闸门能看见"的状态 —— 例如传一个 `Pick` 实现，`listRoots` 返回 `[]` 但 `addRoot` 委托给真 repo：
```ts
const real = new SettingsRepo(openDb(':memory:'))
real.addRoot(tmp, NOW)
const skewed = { listRoots: () => [], addRoot: real.addRoot.bind(real) }
const r = addMediaRoot(skewed, child, NOW)
expect(r).toEqual({ ok: false, error: expect.stringContaining('already covered') })
```
这一条同时锁住了"新分支文案正确"和"结构 mock 必须返回新形状"。

### ✅ 「累积集合」用例能区分两种实现 — 通过

`settingsRepo.addRoot.test.ts:101-107`：
```ts
seedRootsFromEnv('/media/tv,/data/anime,/data/anime/s1')
expect(r.seeded).toEqual(['/media/tv', '/data/anime'])
expect(r.rejected[0].path).toBe('/data/anime/s1')
```
若实现改成开头取一次快照（初始为空），第 3 条 `/data/anime/s1` 会因"快照里没有 /data/anime"而漏进 → `seeded` 变 3 项、`rejected` 为空 → **这条会红**。用例设计正确，能真正区分。（实现上闸门在 `addRoot` 内每次重查 `SELECT path FROM media_roots`，`:203-205`，天然是累积判定。）

### 🟡 F6 — 缺失的边界：`/` 作为根、空字符串、相对路径

实测出的三个未覆盖且**行为可疑**的边界：

| 输入 | 实测结果 | 评价 |
|---|---|---|
| `addRoot('')` | `{ok:true}`，落库 `<cwd>` | 🔴 空字符串应当拒绝，`resolve('')` = cwd 是纯陷阱 |
| 库里已有 `/media/tv`，`addRoot('/')` | `{ok:true}`，`rows=["/","/data","/media/tv"]` | 🔴 **`/` 是所有根的父目录，必须被挡** |
| 库里已有 `/`，`addRoot('/media/tv')` | `{ok:true}`，两行共存 | 🔴 同上，反方向也漏 |
| `seedRootsFromEnv('/,/media/tv')` | `seeded=["/","/media/tv"]`，零 rejected | 🔴 env 这条路完全放行 |

**根因**：`findOverlappingRoot:41-42` 的 `c.startsWith(r + sep)`。当 `r = '/'` 时 `r + sep = '//'`，`'/media/tv'.startsWith('//')` = false。`stripTrailingSep:50` 的 `while (end > 1 ...)` 刻意保留了 `/` 本身（注释 `:47` 说明是为了避免拼接全错），但**恰恰因此让 `/` 逃过了闸门**。

**失效场景**：运维配 `MEDIA_ROOTS=/,/media/tv`（或在 dashboard 输入 `/` 想"扫全盘"）。库里 `/` 与 `/media/tv` 并存 → 完全的嵌套配置 → `/media/tv` 挂载掉线时 `/` 的 walk 仍成功 → `/media/tv` 下全部 files 行落进 `/` 的差集被当成"消失的文件"全删 = **C29 灾难原样发生**。这是 D7 存在的唯一理由，而闸门在这个输入上漏了。

注意：apiV2 那条路（HTTP）也漏 —— `:844` 用的是同一个 `findOverlappingRoot`，`existsSync('/')` 为真、`isDirectory('/')` 为真，全部门都放行。

**修法**：`findOverlappingRoot` 里给 `/` 特判，或改用不依赖字符串拼接的判定：
```ts
const rel = relative(r, c)  // node:path
// rel === '' → same；rel 不以 '..' 开头且非绝对 → c 是 r 的后代
```
`relative('/', '/media/tv')` = `'media/tv'` → 正确判为 child。这一改同时消掉 `stripTrailingSep` 的整个特例分支。

空字符串同理，应在 `addRoot` 入口加 `if (!path.trim()) return`（需扩 `AddRootResult` 或走 F1 的 `skipped` 字段）。

**并发用例缺失**：🟢 不建议补。better-sqlite3 是同步 API，单进程内无法在 JS 层构造真并发；跨进程并发测试成本远超收益，`immediate` 事务已是正确防线。

### 🟢 事务失败回滚未测
`settingsRepo.addRoot.test.ts` 无"事务中途失败 → 无半写"用例。但 `addRoot` 事务内只有一条 INSERT，单语句本身原子，回滚测试意义有限。1a-4 给 `removeRoot` 补多表清理时才真正需要（计划里 1a-4 用例 6 已包含）。

---

## 5. 上一轮审校 3 条前瞻建议的采纳情况

| 建议 | 状态 | 证据 |
|---|---|---|
| **(a)** 包 `transaction().immediate()`（照抄 `removeRoot:247`） | ✅ **完全采纳** | `settingsRepo.ts:202` `const tx = this.db.transaction((): AddRootResult => {...}`；`:213` `return tx.immediate()`。与 `removeRoot:265/324` 手法一致 |
| **(b)** `seedRootsFromEnv` 三件套 | 🟡 **采纳 2.5 / 3** | ① 每条先 `resolve()` → **采纳但位置不同**：放在 `addRoot:201` 而非 `seedRootsFromEnv` 内。位置更好（覆盖全部入口），但**漏了配套的 `isAbsolute` 校验** → 这正是 F1。② 累积集合 → ✅ 完全采纳（`addRoot` 内每次重查，`:203-205`），且有测试锁（`addRoot.test.ts:101`）。③ 跳过打 WARN → ✅ 完全采纳（`watchStartupWarnings.ts:14-22` + `cli/index.ts:196,274`），文案含"跳了谁/跟谁撞/哪个方向/为什么不能留"，3 条测试锁（`watchStartupWarnings.test.ts:99-115`） |
| **(c)** 抽 `pathRelation()` 收敛 5 处裸前缀判断 | ❌ **未采纳** | `rg pathRelation` 零命中。5 处依旧：`findOverlappingRoot`(`sep`)、`ingest.ts:155 pathUnderRoot`(`/`+剥尾)、`mediaContext.ts:37 containingRoot`(`resolve`+`sep`+最长)、`subtitleScheduler.ts:43`(`/`)、`scanner.ts:42`(`/`+最长)、`removeRoot:263`(`/`+剥尾) |

### (c) 是否已成阻塞 — 🟡 尚未阻塞，但 F6 提高了它的优先级

评估：那 5 处的语义是 **path-under-root**（一条文件路径是否落在某根下），与闸门的 **root-vs-root 重叠**不同。口径不一致目前不会与新闸门冲突 —— 闸门只管 `media_roots` 表内部的两两关系，那 5 处管的是 `files/episodes` 行归属。

**但 F6 暴露了新论据**：`findOverlappingRoot` 用字符串拼接 `r + sep` 的手法在 `/` 上崩了，而 `containingRoot`（`mediaContext.ts:37`，`review-task1a-1.md:172` 评为"最健壮的一份"）用 `resolve` + `sep` 也是同款拼接 —— **同一个 `/` 缺陷很可能在 5 处全部存在**。若按 F6 的修法改成 `relative()` 语义，正是抽 `pathRelation()` 的天然时机。

**建议**：(c) 不列为 1a-2 阻塞，但与 F6 合并处理 —— 修 F6 时顺手把判定函数抽出来，让 5 处逐步迁移。

### 🟢 F7 — `settingsRepo.ts` 与 `apiV2.ts` 出现新的注释/文案漂移

1. **悬空 JSDoc 未清**（1a-1 遗留 + 本 task 未修）：`apiV2.ts:793-808` 是原 `findOverlappingRoot` 的完整 4 段论证 JSDoc，`:809-810` 是两行迁移说明，然后 `:811` 空行、`:812` 是 `addMediaRoot` 自己的 JSDoc。那段 `/** ... */` 现在**悬空且内容已完整复制到 `settingsRepo.ts:6-33`**。两份论证会漂移 —— 这正是 spec 自己在 `audit-round3.md:320` 点名要防的 C30 同型陷阱。
2. **错误文案两份**：`apiV2.ts:848-851`（上游门）与 `:860-863`（闸门）是**逐字相同**的两段三元表达式。改文案要改两处。
3. **陈旧注释**：`workUnit.ts:97` 与 `workUnit.test.ts:270` 仍写 *"addRoot 是裸 INSERT 零规范化，settingsRepo.ts:113"* —— 本 task 之后已不成立，行号也早已失效。`db.ts` 里 `substr` 前缀相关注释同理需核对。

不阻塞，但 (1) 和 (3) 是纯删除/改字，成本近零，建议一并清掉。

### 🟢 F8 — `settingsRepo.ts:190-196` 的 JSDoc 断言与 F2 实测冲突

`:190-191` "尾斜杠形态的重复提交…同样幂等" —— 只在存量已规范时成立（F2 实测反例：存量 `/media/tv/` + 新 `/media/tv` = 两行）。注释应加上"存量非规范根需迁移"的限定，否则将来读者会依赖一个不成立的保证。

---

## 6. 红灯基线核实 — ✅ 通过，7 红身份逐条对齐

`npx vitest run --exclude '**/web/**'`：
```
Test Files  4 failed | 135 passed | 2 skipped (141)
     Tests  7 failed | 2772 passed | 17 skipped (2796)
```
与声称的 2772 绿 / 7 红完全一致。

**身份核对**（`--reporter=json` 提取 fullName，非仅数量）：

| # | 文件 | 用例 | 对应基线分类 |
|---|---|---|---|
| 1 | `src/deployContract.test.ts` | synchronizes the complete whitelisted source without touching router-owned files | deployContract 3 |
| 2 | `src/deployContract.test.ts` | serializes one detached rollout and leaves one durable result marker | ↑ |
| 3 | `src/deployContract.test.ts` | preserves rollback evidence and verifies the deployed revision | ↑ |
| 4 | `src/adapters/buildAdapters.test.ts` | skips zimuku with a warning when ZIMUKU_ENABLED=true but LLM_* env is missing | buildAdapters 2 |
| 5 | `src/adapters/buildAdapters.test.ts` | cfg resolver … zimuku：flag 开但 LLM 缺 → 跳过 + warn 一行 | ↑ |
| 6 | `src/v2/secrets.test.ts` | SECRET_NAMES 白名单 恰为 12 键 | secrets 1 |
| 7 | `src/v2/settingsRepo.test.ts` | listSecretMeta 只回 set/source/masked，永不回明文 | settingsRepo 1 |

**分类分布完全吻合基线（3/2/1/1），无"修好一条又新坏一条凑成 7"**。第 6/7 两条的失败原因均为 `expected 15 to have length 12`（SECRET_NAMES 已扩到 15 键，测试仍断言 12），与守备目录无关，确认是既有红灯。

**注意**：`settingsRepo` 那 1 红正是 `settingsRepo.test.ts` 里的，与本 task 同文件 —— 计划 `step1a-plan.md` 执行纪律第 3 条特别提醒过要确认是哪条。已确认是 secret 键数断言，**与 addRoot 改动无关**。

---

## 7. Task 1a-3 / 1a-4 准备度

### 1a-3（`detectNestedRoots()`）— 🟡 需另加函数，且计划有缺口

**签名够不够**：`findOverlappingRoot(candidate, existing[])` 是"一对多"，返回**第一个**命中（`:41` 立即 return）。1a-3 要的是"两两全配对"，且计划用例 3 明确要"三层嵌套 `/a`+`/a/b`+`/a/b/c` → 返回**全部**成对关系"（3 对：a-b、a-c、b-c）。

用现有函数拼 `detectNestedRoots` 可行但别扭：对每个 root 调 `findOverlappingRoot(root, others)` 只能拿到第一个命中，拿不全 3 对。**必须新写双层循环**，或把 `findOverlappingRoot` 重构成返回数组的 `findAllOverlaps` 再包一层"取首个"。建议后者 —— 单一真相，`findOverlappingRoot` 变成 `findAllOverlaps(...)[0] ?? null`。

**计划缺口**：1a-3 只测"嵌套"，抓不到 F2 那类**非规范形态根**（`/media/tv` + `/media/tv/` 归一化后相等，`findOverlappingRoot` 判 `continue`，不算嵌套）。而 F2 证明这类行在 1a-2 之后**真实可产生**，且用户无法从 UI 删除。1a-3 应扩一类检测。

### 1a-4（`removeRoot` 补 `files` 清理）— ✅ 结构顺畅

- 事务结构现成：`removeRoot:265-322` 已是单 `immediate` 事务，`prefix`（`:263`）与 `substr` 手法都在，加一条 `DELETE FROM files WHERE substr(path,1,length(?)) = ?` 是纯插入，无结构改动
- `RemoveRootResult`（`:66-71`）是纯 interface，加 `files: number` 无破坏性 —— 且 `removeRoot` 的返回值消费点只有 `server.ts:585-591`（整体 `JSON.stringify(result)` 回给前端），加字段自动透传，无需改调用方。这一点比 1a-2 的 `void → object` 干净得多
- 计划用例 6 "同一事务，中途失败全回滚" 需要注入失败点，`removeRoot` 目前无缝可插 —— 可能要靠"制造 SQL 错误"（如临时 DROP 某表）之类的手法，实现时留意

---

## 结论

### Task 1a-2 是否通过审校：**需修后通过**

核心目标达成且质量不错：
- ✅ 破坏性返回值变更的**全部**调用点已正确适配，无漏改，无 `Pick<>` mock 陷阱（当前不可达）
- ✅ 上一轮 3 条建议中 (a) 完全采纳、(b) 采纳 2.5/3、(c) 未采纳但尚不阻塞
- ✅ 事务用 `immediate` 正确，嵌套安全，WAL 交互正确
- ✅ 红灯基线 2772/7 精确复现，7 红身份逐条对齐，零新增回归
- ✅ 「累积集合」用例设计扎实，能真正区分两种实现

但闸门本身在两个真实可达输入上**漏放**，而这两个漏放直通 D7 要防的 C29 灾难。

### 必须修（阻塞项，2 条）

1. **🔴 F6 — `/` 作为守备目录完全逃过闸门（双向）**
   `findOverlappingRoot:41-42` 的 `r + sep` 在 `r='/'` 时变 `'//'`，`startsWith` 永不命中。实测 `/` 与 `/media/tv` 可并存。这是 100% 的嵌套配置，`/media/tv` 掉线即触发 C29 全删。HTTP 与 env 两条路都漏。
   修法：改用 `relative()` 判定，或对 `/` 特判。附带补 2 条测试（`/` 在前 / `/` 在后）。

2. **🔴 F1 — `seedRootsFromEnv` 相对路径静默落成 `<cwd>/...`，零告警，且连带让 `rootsMismatchWarningLine` 对合法的尾斜杠 env 永久误报**
   `addRoot:201` 加了 `resolve` 但 `seedRootsFromEnv:231` 没配套 `isAbsolute` 门（apiV2 那条路有）。这是本 task 新引入的回归（此前 env 原文落库，mismatch 告警不误报）。
   修法：env 循环内加绝对路径守卫并收进告警；`rootsMismatchWarningLine` 两侧比对口径统一 resolve。

**建议同批修（成本近零）**：F5 补一条 `addMediaRoot` 消费新返回值的测试（当前 `apiV2.ts:856-864` 零覆盖）；F7(1) 删掉 `apiV2.ts:793-808` 的悬空 JSDoc；F7(3) 改掉 `workUnit.ts:97` 的陈旧断言。

**不阻塞**：F2（存量迁移，归 1a-3）、F3（win32）、F4（注释夸大）、F8（JSDoc 限定）、(c) `pathRelation` 抽取。

### 对 Task 1a-3 的前瞻建议（3 条）

1. **把 `findOverlappingRoot` 重构成 `findAllOverlaps(): Array<...>`，`findOverlappingRoot` 退化为取首个** —— 1a-3 计划用例 3 要求三层嵌套返回**全部** 3 对成对关系，现函数 `:41` 命中即 return 拿不全。同时在这次重构里落地 F6 的 `relative()` 修法（`/` 缺陷很可能在 `containingRoot`/`pathUnderRoot` 等 5 处同款拼接里都存在），顺势把 (c) 的 `pathRelation()` 抽出来 —— 三件事一次做完，比分三次改同一批代码便宜。

2. **1a-3 的启动检测必须扩一类"非规范形态根"，不只是嵌套** —— F2 实测证明 1a-2 之后 `/media/tv` 与 `/media/tv/` 可共存，`findOverlappingRoot` 判"相等 → continue" 不算嵌套，`detectNestedRoots` 抓不到；而这类根**用户无法从 UI 删除**（`removeRoot` 精确匹配 + `server.ts:585` 的 `resolve`）。建议 1a-3 一并给出 `detectNonCanonicalRoots()`，或在 `db.ts` 迁移里做一次性归一化回写。

3. **1a-3 应顺手为 `nestedRootSkipWarning` 之外补一条 dashboard 可见的告警面** —— 现在告警只在 `cli/index.ts:196,274` 的 `console.warn`，运维得翻容器日志。存量嵌套是持续性事实（不像 env 种子只发生一次），启动日志里滚过就没了。建议 1a-3 把 `detectNestedRoots` 的结果也接进某个 `/api/v2/...` 状态面，让 dashboard 设置页能显示"你的守备目录存在嵌套，有删库风险"。这与 spec `:318` "迁移时告警" 的意图一致，且不增加新判断逻辑（纯读聚合，符合 G5 的北极星约束）。

---

*审校方式说明：所有运行时结论均通过临时 vitest 探针实测得出（探针文件已删除，`git status` 确认工作区除本报告外无改动）。除 `docs/design/2026-08-08-review-task1a-2.md` 外未修改任何文件。*
