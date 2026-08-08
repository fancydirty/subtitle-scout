# 对抗性审校 — Task 1a-1（`findOverlappingRoot` 下移到 settingsRepo）

审校对象：`git diff src/dashboard/apiV2.ts src/v2/settingsRepo.ts` + 新增 `src/v2/settingsRepo.overlap.test.ts`
审校日期：2026-08-09
状态：**审校完成**

---

## 1. 零行为变化验证

### ✅ 实现逐字符等价 — 通过

`git diff` 显示删除块与新增块的函数体完全一致（`settingsRepo.ts:27-36` vs 原 `apiV2.ts:809-818`）：

```
for (const root of existing) {
  if (candidate === root) continue
  if (candidate.startsWith(root + sep)) return { root, relation: 'child' }
  if (root.startsWith(candidate + sep)) return { root, relation: 'parent' }
}
return null
```

签名、循环顺序、`continue` 语义、返回结构全部未动。

### ✅ `sep` import 来源一致 — 通过

- 原位置：`src/dashboard/apiV2.ts:4` `import { dirname, resolve, sep } from 'node:path'`
- 新位置：`src/v2/settingsRepo.ts:2` `import { sep } from 'node:path'`

同一模块同一具名导出，**无 `node:path/posix` 偷换**。这是最容易翻车的点（posix 版 `sep` 恒为 `/`，会让 Windows 行为静默改变），实现是对的。

### ✅ 错误文案生成逻辑未动 — 通过

`src/dashboard/apiV2.ts:844-853` 的 `hit.relation === 'child' ? ... : ...` 三元与两条文案字符串完全不在 diff hunk 范围内，原样保留。

### ✅ 测试数字核实 — 通过（声称属实）

| 命令 | 结果 |
|---|---|
| `npx vitest run src/dashboard/apiV2.test.ts` | **110 passed** |
| `npx vitest run src/v2/settingsRepo.overlap.test.ts` | **7 passed** |
| `npx tsc --noEmit` | EXIT=0，无输出 |

117 = 110 + 7 属实。

### 🟡 F1 — `sep` 在 apiV2.ts 已成未使用 import

**证据**：
- `src/dashboard/apiV2.ts:4` — `import { dirname, resolve, sep } from 'node:path'`
- `rg -n '\bsep\b' src/dashboard/apiV2.ts` 全文件仅两处命中：第 **4** 行（import 本身）、第 **803** 行（**注释文字**，"比较时给两侧都补 sep"）

`sep` 唯一的真实使用者随函数搬走了；`dirname`/`resolve` 仍在用，`sep` 现在是死 import。

**为什么 tsc 没抓到**：`tsconfig.json` 只有 `strict: true`，**没有 `noUnusedLocals`**（`strict` 不含该项）。仓库也无任何 lint 配置（`.eslintrc*`/`eslint.config.*`/`biome.json` 均不存在，`package.json` 无 `lint` script）。所以"tsc 干净"是真的，但它**不构成 import 未残留的证据**——这个声称掩盖了残留。

**修法**：`apiV2.ts:4` → `import { dirname, resolve } from 'node:path'`。

### 🟢 F2 — 孤儿 JSDoc：22 行论证注释留在 apiV2，未挂任何声明

**证据**：`src/dashboard/apiV2.ts:792-808` 是原 `findOverlappingRoot` 的完整 JSDoc（`/** 重叠校验（业界标准 overlapping-paths validation…`，含 4 段论证）；其后 `apiV2.ts:809-810` 是两行迁移说明 `//`，**再往下是空行 + `addMediaRoot` 自己的 JSDoc**（`apiV2.ts:812`）。这段 `/** … */` 现在悬空，且同一内容已被完整复制到 `src/v2/settingsRepo.ts:5-26`。

**问题**：
1. **这正是本 task 要消灭的"两份漂移"的文档版**。将来改 settingsRepo 那份论证（例如补大小写不敏感说明），apiV2 这份会静默过期，而它读起来像权威说明。
2. 悬空块注释在部分 IDE 会被错误关联到下一个声明，`addMediaRoot` 的 hover 提示串味。

**修法**：删掉 `apiV2.ts:792-808` 整段块注释，只留 809-810 那两行指路注释（写得很好，应保留）。

---

## 2. 测试质量（不是数量）

7 条用例逐条读过（`settingsRepo.overlap.test.ts:14-46`）。断言强度总体合格——用的是 `toEqual({root, relation})` 全对象比对而非 `toBeTruthy()`，`toBeNull()` 也是精确的。第 5 条（`:32-37`）尤其好：双向验证同名前缀不误判，并在注释里点明"裸 `startsWith` 会误判"，这是契约级测试而非实现细节。

但覆盖有真实缺口，且有一条准假绿。

### 🔴 F3 — 尾部斜杠未测，且这是一个**真实可达的漏检漏洞**

**证据**：7 条用例全部使用无尾斜杠的规范路径（`:15,20,25,29,35,36,40,45`），没有任何一条测 `/media/tv/`。

这不只是"覆盖缺口"——实测确认漏检真实存在：

```
DB 根(带尾斜杠) = ['/media/tv/']   候选 = /media/tv/anime
findOverlappingRoot -> null        // 应为 child，却漏放
```

原因：`candidate.startsWith('/media/tv/' + '/')` → 找 `//`，不匹配。

**为什么可达**（这是要点，不是理论风险）：
- `addMediaRoot`（HTTP 路径）先 `resolve()` 再比对（`apiV2.ts:834`），`resolve('/media/tv/')` → `/media/tv`，**HTTP 入口安全**。
- 但 **`seedRootsFromEnv` 零规范化**：`settingsRepo.ts:159-161` 把 env 逗号切分后 `trim()` 直接 `addRoot(root, now)`，**不经 `resolve`**。`addRoot`（`settingsRepo.ts:146-150`）也是裸 `INSERT OR IGNORE`。
- 这一点仓库里已有明文承认——`src/v2/workUnit.ts:97` 注释：*"addRoot 是裸 INSERT 零规范化，settingsRepo.ts:113——根侧不干净真实可达"*。
- 于是 `MEDIA_ROOTS=/media/tv/` 会让库里存着 `/media/tv/`，此后 HTTP 加 `/media/tv/anime` **绕过 D7 闸门** → 嵌套根成立 → 触发 C29 删库路径。

**注意本 task 没有引入这个洞**（原实现同样如此），但 **task 1a-2 要把这个函数变成 `addRoot` 的唯一闸门**，闸门带漏检就是新增风险面。而且下移这一步正是补测试锁的时机。

**修法**（二选一，推荐前者）：
1. 在 `findOverlappingRoot` 内部对两侧做边界归一（剥尾 `sep` 后再补 `sep`），与 `removeRoot` 的既有手法（`settingsRepo.ts:189` `path.endsWith('/') ? path : path + '/'`）和 `ingest.ts:155-158` `pathUnderRoot` 的手法对齐。**这三处应该收敛成同一口径**（见 F6）。
2. 至少先加两条红灯测试锁住行为，把归一化留给 1a-2 的 `addRoot` 闸门统一做。

### 🟡 F4 — 第 6 条用例"返回第一个命中"是准假绿：断言的顺序在生产中不可能出现

**证据**：`settingsRepo.overlap.test.ts:39-42`

```
const hit = findOverlappingRoot('/media/tv/anime', ['/data', '/media/tv', '/media'])
expect(hit).toEqual({ root: '/media/tv', relation: 'child' })
```

**问题**：唯一的生产调用方是 `apiV2.ts:844` `settingsRepo.listRoots().map(r => r.path)`，而 `listRoots()` 的 SQL 是 `... ORDER BY path`（`settingsRepo.ts:138`）。排序后真实数组是 `['/data','/media','/media/tv']`，实测第一个命中是：

```
ORDER BY path 真实顺序 = ['/data','/media','/media/tv'] -> {"root":"/media","relation":"child"}
```

即：测试精心构造了一个 `listRoots()` **永远不会返回**的乱序数组，锁住的是"数组遍历顺序"这个实现细节，而非用户可见契约。用例标题说"错误文案要指名道姓说跟哪个撞了"，但它锁的顺序恰好与生产相反——生产会报最外层的 `/media`，测试断言最近的 `/media/tv`。

**为什么这算缺陷而非吹毛求疵**：错误文案的产品价值是"告诉用户该删哪个根"。撞上 `/media` 和撞上 `/media/tv` 给用户的行动指引完全不同。当前既没有明确契约（"返回最近的"还是"返回任意一个"），测试又锁了个假顺序，1a-2 若把入口换成排序输入，文案会静默变化而测试仍绿。

**修法**：明确契约并让测试反映它。建议改成"返回**最深/最近**的根"（`hits.sort((a,b) => b.length - a.length)[0]`，与 `mediaContext.containingRoot:43` 和 `scanner.deriveWorkDir:42` 的既有取最长手法一致），用例改用排序输入验证。若坚持"任意一个"，就把用例改成断言 `hit.root` ∈ 候选集合，不锁具体值。

### 🟡 F5 — Windows / 大小写 / 相对路径 / `..` 四类边界的实际结论

实测（darwin，`sep === '/'`）：

| 场景 | 输入 | 结果 | 评价 |
|---|---|---|---|
| Windows 反斜杠 | `C:\media\tv\anime` vs `C:\media\tv` | **null（漏检）** | 在 posix 上跑必漏 |
| Windows 正斜杠 | `C:/media/tv/anime` vs `C:/media/tv` | child ✅ | |
| 大小写 | `/Media/TV` vs `/media/tv` | **null（漏检）** | macOS 默认 APFS 大小写不敏感→同一目录判为不重叠 |
| 相对路径 | `media/tv/anime` vs `media/tv` | child ✅ | 但 `addMediaRoot` 已在 `apiV2.ts:829` 用 `isAbsoluteMediaPath` 挡住 |
| `..` 未归一 | `/media/tv/../tv/anime` | child ✅（巧合命中） | HTTP 侧有 `resolve` 兜住 |

分项判断：

- **Windows 硬编码 `/` 是否假绿/假红？→ 都不是，但测试对 win32 无效**。因为用例硬编码 `/` 而 `sep` 在 win32 是 `\`，在 Windows 上跑第 1、2、6 条会全部返回 `null` → **测试变红（假红），不是假绿**。假红比假绿好，但意味着这套测试**不能跨平台跑**。对比仓库既有约定：`apiV2.test.ts:445-448` 用的是 `mkdtempSync` + `join(tmp,'movies')`，**平台可移植**。新测试偏离了这个约定。
  - **修法**：用 `join()` 或 `sep` 拼接（如 `` const root = `${sep}media${sep}tv` ``），或在文件顶部显式声明"本套仅 posix 语义"并配 `describe.skipIf(process.platform === 'win32')`。前者更好。
- **大小写不敏感**：`/Media/TV` vs `/media/tv` 当前**不算重叠**（漏检）。在 macOS 上这是真漏洞——两者是同一个目录，会种出"自我嵌套根"。这是**既有行为**，本 task 未改变，但同样属于"闸门带洞"。至少该加一条 `it.todo` 或注释显式记录这是已知取舍，否则下一个人会以为已经考虑过。
- **相对路径 / `..`**：由 `addMediaRoot` 的 `isAbsoluteMediaPath` + `resolve` 兜住，函数本身不设防是合理的分工。**但 1a-2 后 `addRoot` 成为闸门，`seedRootsFromEnv` 这条路径既不 `isAbsolute` 也不 `resolve`**（`settingsRepo.ts:159-161`）→ 分工假设失效。见 F8。

### ✅ 命名/位置符合仓库约定 — 通过

`src/v2/settingsRepo.overlap.test.ts` 与被测文件同目录、`<module>.<aspect>.test.ts` 形式，仓库既有同型先例：`src/v2/ingest.probeConcurrency.test.ts`、`src/files/libraryRealign.messyMatrix.test.ts`。合规。

---

## 3. 两份实现漂移

### ✅ `findOverlappingRoot` 全仓仅一份 — 通过

`rg -n "findOverlappingRoot" -g '!node_modules'` 命中的全部 `.ts` 位置：
- `src/v2/settingsRepo.ts:27` — 唯一定义（`export function`）
- `src/dashboard/apiV2.ts:9` — import；`:844` — 调用
- `src/v2/settingsRepo.overlap.test.ts:2` — import

`apiV2.ts` 内无残留定义（diff 确认整块删除）。计划清单第 159 行"全仓仅一份实现"达成。

### 🟡 F6 — 但存在 **5 处裸前缀判断**，各自独立实现同一语义

`rg -n "startsWith" src/{v2,dashboard,daemon,cli} -g '!*.test.ts'` 后筛路径相关：

| 位置 | 实现 | 归一化 | 边界 |
|---|---|---|---|
| `settingsRepo.ts:32-33` | `startsWith(root + sep)` | 无 | `sep` |
| `settingsRepo.ts:189` `removeRoot` | `path.endsWith('/') ? path : path+'/'` 再 `substr` 比对 | **剥尾斜杠** | 硬编码 `/` |
| `ingest.ts:155-158` `pathUnderRoot` | `root.endsWith('/') ? root : root+'/'` | **剥尾斜杠** | 硬编码 `/` |
| `subtitleScheduler.ts:43` | `r.path === root \|\| r.path.startsWith(root + '/')` | 无 | 硬编码 `/` |
| `scanner.ts:42` `deriveWorkDir` | `dir === r \|\| dir.startsWith(r + '/')` + 取最长 | 无 | 硬编码 `/` |
| `core/mediaContext.ts:37-44` `containingRoot` | `resolve` 两侧 + `startsWith(root+sep)` + 取最长 | **resolve** | `sep` |

**三种不同口径并存**：只补 `sep` / 剥尾斜杠再补 / 两侧 `resolve`。其中 `containingRoot` 是最健壮的一份（既 `resolve` 又用 `sep` 又取最长），而**新下移的 `findOverlappingRoot` 是最弱的一份**（三者皆无）。

**注意 `subtitleScheduler.ts:43` 和 `scanner.ts:42` 硬编码 `'/'` 而非 `sep`** —— 与 `findOverlappingRoot` 用 `sep` 不一致，win32 上行为分叉。

**这直接命中 spec 自己点名的陷阱**：`docs/design/2026-08-08-audit-round3.md:320` 提到要"避免两份实现漂移（C30「两处标签集互不兼容」的同型陷阱）"。本 task 消除了 `findOverlappingRoot` 的重复，但**同语义的裸实现仍有 5 份**。

**修法**（不属本 task 范围，应立项）：导出一个 `pathRelation(a, b): 'same'|'parent'|'child'|'unrelated'` 单一真相（内部做 `resolve` + `sep` + 尾斜杠归一），让 `findOverlappingRoot`、`pathUnderRoot`、`containingRoot`、`subtitleScheduler:43`、`scanner:42`、`removeRoot` 的前缀构造全部走它。建议作为 1a-3 或独立 task。

### 🟢 F7 — `removeRoot` 的 substr 前缀匹配不该收敛到本函数

**证据**：`settingsRepo.ts:189` + `:196-247`。

审校要求特别检查这条。结论是**不该合并**：`removeRoot` 的前缀是喂给 SQL `substr(path,1,length(?)) = ?` 的**字符串字面量**（`settingsRepo.ts:186-188` 注释详细论证了为何不用 `LIKE`——媒体路径可含 `%`/`_`），语义是"库内行的路径前缀过滤"，不是"两个根是否重叠"。强行共用会把 SQL 参数构造和内存判定耦合。

**但 `prefix` 的构造口径应该共享**：`removeRoot` 剥尾斜杠（`:189`），`findOverlappingRoot` 不剥（F3）。两者在同一文件里对同一件事用两套规则，正是漂移的温床。至少加交叉注释，理想是共用一个 `withTrailingSep(p)` 小工具。

### ✅ `daemonV2` 的 roots 处理 — 无重叠判断，不构成漂移

`daemonV2.ts:109,167,177` 三处只是 `for (const root of this.deps.roots)` 直接遍历（`writableRoots()` / `scanOnce()` 的 walk 循环），没有做任何父子关系判断。**这恰恰印证了 C29 的危害机制**：`scanOnce`（`:167-181`）对每个根独立 `walkVideoFiles` 并 upsert，嵌套根下同一文件被走两遍、按两个根各自登记，无任何去重。闸门必须在写入 `media_roots` 那一刻就位——daemonV2 这层不设防，符合"机械层不做判断"的架构，但也意味着**它完全依赖 D7 闸门的正确性**，F3 的漏检会直接穿透到这里。

### ✅ `subtitleScheduler.ts:42-45` — 语义不同，不该收敛

`subtitleScheduler.ts:43` 的 `inside` 判定是"这条 file 行是否落在**可写根**集合内"（配合 `daemonV2.writableRoots()` 做只读根过滤），语义是 path-under-root，与"两根是否重叠"不同。不该合并到 `findOverlappingRoot`，但应与 `ingest.pathUnderRoot` 收敛（两者语义完全相同，却是两份实现）——归入 F6。

---

## 4. 红灯基线

### ✅ 未变多、未变形 — 通过

`npx vitest run src/v2/settingsRepo.test.ts`：

```
Test Files  1 failed (1)
     Tests  1 failed | 28 passed (29)
```

**1 红 28 绿，与基线完全一致。**

唯一失败仍是 `listSecretMeta 只回 set/source/masked，永不回明文`（`settingsRepo.test.ts:300`）：

```
AssertionError: expected [ …(15) ] to have a length of 12 but got 15
```

形态与描述一致——`SECRET_NAMES` 扩容到 15 而测试仍期望 12，属测试未同步，**与本次改动无关**（本次未触碰 `secrets.ts` 或 secret 相关代码路径）。红灯数量、位置、断言内容均未变形。

`npx tsc --noEmit` EXIT=0，未引入类型回归。

---

## 5. 前瞻：够不够支撑 1a-2？

### ✅ 签名够用

`(candidate: string, existing: readonly string[])` → `{root, relation} | null`。1a-2 要把 `addRoot` 返回值改成 `{ok:true} | {ok:false, conflict}`，`conflict` 直接透传 `{root, relation}` 即可，`readonly string[]` 也正好吃 `listRoots().map(r=>r.path)`。无需改签名。

### 🔴 F8 — `addRoot` 当前**不在事务里**，1a-2 的"读 listRoots 再 INSERT"会有 TOCTOU 竞态

**证据**：`settingsRepo.ts:146-150`

```
addRoot(path: string, now: number): void {
  this.db
    .prepare("INSERT OR IGNORE INTO media_roots (path, type, added_at) VALUES (?, 'local', ?)")
    .run(path, now)
}
```

单条裸 `INSERT OR IGNORE`，**无事务包裹**。对比同文件 `removeRoot` 用了 `this.db.transaction(...)` + `tx.immediate()`（`settingsRepo.ts:191,247`），`apiV2.updateSettings` 也在 R5-7 修复里补了 `db.transaction`（`apiV2.ts:784-786`）。

1a-2 若写成"先 `listRoots()` 查、再 `INSERT`"，两步之间无原子性：两个并发请求分别加 `/media` 和 `/media/tv`，各自读到空表 → 双双通过校验 → 双双写入 → **嵌套根成立，闸门被绕过**。

**可达性评估**：dashboard HTTP 是否并发？`server.ts` 是标准 node http server，`addMediaRoot` 无锁，两个 POST 可交错。better-sqlite3 是同步 API，单条语句间不会被打断，但 `listRoots()` 与 `addRoot()` 是**两条独立语句**，Node 事件循环可在其间切换到另一个请求（两者都是同步的，实际上在单线程里 `addMediaRoot` 函数体内部不会被抢占——**函数体全同步，无 `await`**）。

复核 `apiV2.addMediaRoot`（`:821-855`）：全同步，无 `await`，因此**单进程内实际不可抢占**，竞态在当前架构下不可达。但：
1. 存在 `existsSync`/`statSync` 调用，若将来改成异步（`fs/promises`）竞态立刻成真；
2. **多进程可达**：`cli/index.ts:193` 与 `:268` 两处 `seedRootsFromEnv` 在独立进程里跑，与 dashboard 进程并发写同一 DB 文件时无互斥。

**修法（给 1a-2）**：把校验+写入包进 `this.db.transaction(...)` 并用 `.immediate()`（与 `removeRoot:247` 同手法，`IMMEDIATE` 拿写锁避免 SQLite 升级锁死）。既然 1a-2 本就要改 `addRoot` 签名，一并包事务是零额外成本。

### 🟡 F9 — `seedRootsFromEnv` 支持"单条冲突不中断整批"，但需注意两个陷阱

**证据**：`settingsRepo.ts:157-162`

```
seedRootsFromEnv(envRaw, now): void {
  const existing = ...COUNT(*)...; if (existing.c > 0) return
  const roots = (envRaw ?? '').split(',').map(s => s.trim()).filter(Boolean)
  for (const root of roots) this.addRoot(root, now)
}
```

循环体是逐条 `addRoot`，**天然支持"跳过冲突项、继续下一条"**——1a-2 只需把 `for` 体改成检查返回值并 `continue`（附告警日志）。结构上无障碍。

两个必须处理的陷阱：

1. **批内自冲突**。`MEDIA_ROOTS=/media,/media/115` 时，第 1 条种入成功，第 2 条与**刚种入的** `/media` 冲突。这要求校验读的是**当前库内已种入的集合**（每轮重查 `listRoots()`，或维护一个累积 accepted 数组），不能一次性读初始快照（初始是空表，会全部放行）。这正是 `audit-round3.md:317` 点名的场景。
2. **顺序依赖 + 静默降级**。`/media,/media/115` 保留 `/media`（父），`/media/115,/media` 保留 `/media/115`（子）——**env 里的书写顺序决定最终守备范围**，且用户看不到。必须打醒目 WARN（含被跳过的路径和撞上的根），否则用户会遇到"改了 MEDIA_ROOTS 顺序，扫描范围莫名变了"。若整批只剩 0 条被接受，更应显式告警而非静默空转。
3. **零规范化**（承 F3/F5）：这条路径不 `resolve` 不 `isAbsolute`，尾斜杠/相对路径/`..` 会原样落库并绕过闸门。**1a-2 应在 `seedRootsFromEnv` 内对每条先 `resolve()`**，让 env 路径与 HTTP 路径口径一致。这是 F3 那个洞在 1a-2 里的收口点。

---

## 结论

### Task 1a-1 审校结果：**需修后通过**

"搬函数"这一步做得干净——实现逐字符等价、`sep` 来源正确、错误文案未动、全仓仅一份实现、红灯基线未变形、测试数字属实、命名合规。核心目标达成，方向正确。

但有一项必须在 1a-2 之前处理，因为 1a-2 会把这个函数提升为唯一闸门。

### 必须修（少而精）

1. **🔴 F3 — 尾部斜杠漏检必须锁住**。`MEDIA_ROOTS=/media/tv/` → 库里存 `/media/tv/` → 加 `/media/tv/anime` 漏放，嵌套根成立。实测确认，路径为 `seedRootsFromEnv` 零规范化（`settingsRepo.ts:159-161`，`workUnit.ts:97` 已明文承认"根侧不干净真实可达"）。最低要求：补两条红灯测试锁住该行为；理想：函数内部做尾斜杠归一，与 `removeRoot:189`／`ingest.ts:155-158` 口径对齐。
2. **🟡 F1 — 删掉 `apiV2.ts:4` 的死 `sep` import**。30 秒的事，不做就是重构没收尾；`tsc` 抓不到（无 `noUnusedLocals`）。
3. **🟡 F4 — 第 6 条用例锁了生产不可能出现的顺序**。`listRoots()` 是 `ORDER BY path`，真实首个命中是 `/media` 而非测试断言的 `/media/tv`。要么明确契约为"返回最深的根"（与 `containingRoot:43`/`scanner:42` 取最长一致）并改测试，要么放宽断言为集合成员。

可选：F2（删孤儿 JSDoc，防文档漂移）、F5（测试改用 `join`/`sep` 以跨平台可跑，对齐 `apiV2.test.ts:445-448` 既有约定）。

### 对 Task 1a-2 的前瞻建议

1. **把校验+写入包进 `db.transaction(...).immediate()`**（F8）。当前 `addRoot` 是裸 INSERT 无事务，而 `removeRoot:247` 已用 `.immediate()`——照抄同手法。单进程内 `addMediaRoot` 全同步暂不可达竞态，但 `cli/index.ts:193,268` 的独立进程与 dashboard 并发写同一 DB 时可达，且将来改异步 fs 立刻成真。
2. **`seedRootsFromEnv` 三件套一起做**（F9）：① 每条先 `resolve()`（收口 F3/F5 的零规范化洞）；② 校验对象是"已累积接受的集合"而非初始空快照（否则批内自冲突全放行）；③ 跳过时打 WARN 含"被跳过的路径 + 撞上的根"，因为 env 书写顺序会静默决定最终守备范围。
3. **顺手立项收敛 5 份裸前缀判断**（F6）。`findOverlappingRoot`(`sep`)、`ingest.pathUnderRoot`(`/`+剥尾)、`containingRoot`(`resolve`+`sep`+最长)、`subtitleScheduler:43`(`/`)、`scanner:42`(`/`+最长)、`removeRoot:189`(`/`+剥尾) 共三种口径，其中新下移的这份最弱。建议抽 `pathRelation()` 单一真相。spec 自己在 `audit-round3.md:320` 点名要防这类漂移，本 task 只消除了一份重复。
