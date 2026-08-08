# 作品单元管线 + 甄别下架 SPEC

**日期**: 2026-08-07
**状态**: 待实施
**前置**: `docs/agent-first-identification-architecture.md`（2026-07-27，agent-first 识别已落地）

---

## 0. 为什么有这一轮

昨夜生产实测暴露：干净库 + doctor 全绿 + 492 个真媒体文件的情况下，`unidentified-backlog`
job **一次都没跑起来**，连续 10 次以同一个错误失败：

```
拒绝在媒体根目录之外写入: /hostroot/mnt/nvme0n1-4/nas_media
```

根因不是配置歪，是代码缺陷（§2）。修它的过程中，用户裁决了三个架构问题（§3、§4、§5），
本 spec 把四项合并成一轮实施。

**北极星（沿用既有铁律，本轮不新增）**：
- 机械层只产事实，绝不产指令；身份裁决全在 agent
- DB 是状态机，每步产出立即落库
- 宁可不下，也不下错

---

## 1. 术语（先钉死，避免继续误读）

| 词 | 指什么 | 是否 LLM |
|---|---|---|
| **ingest** | 走盘收 raw data（路径/目录名/时长/内嵌轨/`[tmdbid-N]`），认不出就 park | 机械 |
| **identifyFromPath** | 把路径拆成结构提示。**不裁决身份**，无 tmdbId 产出 | 机械 |
| **orchestrator** | 看全局账本决定派什么活，自己不干活 | **LLM agent** |
| **识别 agent** | identifyOnly worker：清标题→搜 TMDB→双证据核验→`write_identified_media` | **LLM agent** |
| **字幕 agent** | 消费库行：搜候选→沙盒→体检→终审→装盘 | **LLM agent** |
| **作品单元 (work unit)** | 一部剧/一部电影的全部文件，队列的新粒度（本轮引入） | — |

`identifyFromPath` 保留是正确的：它是 agent 的**证据来源**，不是竞争性的识别器。删了它
agent 只能拿到裸路径字符串。

---

## 2. 改动 A：修 commonDir 越界 bug（阻塞级）

### 现状

`src/cli/unidentifiedFindSubtitle.ts:188-196`：

```ts
for (const t of targets) assertDirSafe(dirname(t.videoPath), deps.mediaRoots)  // ① 逐个校验
const dirs = [...new Set(targets.map((t) => dirname(t.videoPath)))]
const mediaRoot = commonDir(dirs)                                              // ② 求公共祖先
if (!isUnderRoots(mediaRoot, deps.mediaRoots)) throw ...                       // ③ 再校验祖先
```

`commonDir` 向上爬直到覆盖所有目标目录。当目标散落在 `Movies/`、`TV/`、`anime/` 三个根下，
公共祖先是它们的**父目录** `nas_media`，而 MEDIA_ROOTS 里只有那三个子目录 → ③ 必炸。

### 判定：③ 是设计缺陷，不是安全网

① 已经逐个文件校验过"每个目标目录都在配置根内"。③ 想额外保证的是"INNER 沙盒根也在根内"，
但**多根部署下公共祖先天然越界**，这个约束与多根共存在逻辑上不可同时满足。

### 改法

`unidentified` scope 不再求全局公共祖先。§3 引入作品单元后，一个 job = N 个作品单元，
每个单元的 `mediaRoot` = **该单元的作品根**（定义见 §3.2），它天然在某个配置根内。

- 保留 ①（逐目标 `assertDirSafe`）——真正的 OUTER 沙盒门
- 保留 `stagingRootFor`，并按 §3.2.1 补 `containingRoot !== null` 断言（替代 ③ 的守卫职责）
- 删除 ②③ 这对"求祖先 + 校验祖先"

### 🔴 `commonDir` 的另一个调用方（独立审计 M6）

`commonDir` 有**两个**生产调用方，初稿只审了一个：

| 调用点 | 本轮处置 |
|---|---|
| `src/cli/unidentifiedFindSubtitle.ts:191` | 本节改掉 |
| `src/v2/findSubtitleWorkerTask.ts:318`（库行 mapper，series 分支） | **保持现状**，理由见下 |

第二处是逐字相同的模式（逐目标 `assertDirSafe` → `commonDir` → `isUnderRoots` 抛错），
§2 的论证（多根下公共祖先天然越界）对它同样成立。但**本轮不改**，理由：

1. 它的越界条件严格更窄：需要"**同一部剧的集**散落在多个配置根下"。而 unidentified scope
   的越界条件是"**任意两个待识别文件**分属不同配置根"——492 个文件分布在三个根时必然触发。
2. 库行 scope 的 targets 来自 `listMissingEpisodesForSeries`（同一 series_id），同一部剧跨配置根
   需要用户手工把季目录搬到另一个根下，属于异常布局。
3. 它落地后有真实回归锁（`findSubtitleWorkerTask.test.ts:507` 断言该抛错），改它要连带改测试
   的期望语义，超出本轮"让工作流跑起来"的范围。

**记为已知债务**，条件成熟（作品单元推导函数稳定后）可用同一套 `workRootOf` 替换。
这里显式写明，避免实施者以为 `commonDir` 只有一个调用方。

### 回归锁

- 目标散落多个配置根 → 不再抛错（当前会抛）
- 单个作品单元内的目标 → `mediaRoot` 恰为作品根
- 目标目录真的越出全部配置根 → ① 仍抛（安全性不回退）

---

## 3. 改动 B：队列粒度从"文件"改成"作品单元"

### 3.1 为什么

现状 `buildUnidentifiedTargets` 扁平取 60 个文件（`first_seen ASC` 后掐头）。后果：

1. **兄弟被切散**：Constellation 7 集可能跨两批 → 裸集号 absolute/seasonal 歧义无判据。
   这个缺口 `identifyMediaSkill.ts` 头注释已记为"今夜不做"：
   > sibling 证据维度（M9 / F1）：裸集号之争唯一判据是同目录 sibling 文件……真正的
   > readdir(dirName) 列举需要三层改动，今夜不做，缺口记在此处
2. **重复搜索烧 token**：同一部剧在两批里各搜一次 TMDB
3. **字幕源是整季合集**：按季/按批找字幕会把同一个合集页搜多次（用户裁决：按作品搜一次）

### 3.2 作品根定义（机械可判，零 LLM）

从文件所在目录 `dirname(videoPath)` 起向上爬，按顺序检查停止条件：

| # | 条件 | 动作 |
|---|---|---|
| 1 | **当前目录本身就是某个配置根** | **停**。作品根 = 当前目录（该配置根下的扁平文件共享此单元） |
| 2 | **当前目录的父目录是某个配置根** | **停**。作品根 = 当前目录 |
| 3 | 当前目录名匹配季目录形态 | 继续上爬 |
| 4 | **以上都不满足** | 继续上爬（🔴 初稿漏了这条，见下） |

**硬上界**：上爬过程中一旦 `containingRoot(candidate, mediaRoots) === null`（爬出了全部配置根），
**立即停并返回上一个仍在根内的目录**。没有这条，`Show/Season 1/Part 2/ep.mkv` 这类不匹配任何
已知形态的中间层会让循环一路爬到 `nas_media` 之上——正是 §2 要修的越界 bug 原地重生。

**季目录形态**：完整定义见 `SEASON_FOLDER_PATTERNS`（`src/recognition/identifyFromPath.ts:58-63`），
本 spec **不重述**（初稿重述时漏了 `Series NN`、`第N集`、`第N部` 三种，其中 `第N集` 是
"莉可丽丝识别成'第1集'"那个 root cause 的修复，有测试锁）。

**`detectSeasonFolder` 的复用方式**（初稿只说"复用"没说怎么复用，该函数是模块私有）：
给它加 `export`。这是零行为改动的最小触碰。虽然 `identifyFromPath.ts` 是识别核心
（`libraryRepo.ts:143-145` 称之为"圣文件"），但单加导出关键字不改任何逻辑，比抽新模块
（要动 `isCanonicalEpisodePath` + 主函数共三个调用点）风险低一个量级。**替代方案"复制一份
正则"明令禁止**——两份正则必然漂移。

四种真实布局的推导结果（配置根 = `TV` / `Movies` / `anime`）：

```
TV/Constellation/S01E03.mkv              → 条件2 命中 → 作品根 TV/Constellation
TV/Spy x Family/Season 01/S01E03.mkv     → 条件3 上爬 → 条件2 命中 → 作品根 TV/Spy x Family
Movies/Pulp Fiction (1994)/movie.mkv     → 条件2 命中 → 作品根 Movies/Pulp Fiction (1994)
Movies/some.movie.2024.mkv               → 条件1 命中 → 作品根 Movies（该根下扁平文件同单元）
TV/Show/Season 1/Part 2/ep.mkv           → 条件4 上爬 → 条件3 上爬 → 条件2 → 作品根 TV/Show
```

🔴 **扁平文件的分组粒度**（二轮审计 R2-B2 推翻一轮修法）：

一轮修法让"配置根下所有扁平文件"成为**一个单元**，这是 §3.3.2 最坏情况的制造者（`Movies/` 下
200 个扁平电影 = 一个 200 目标的 job），且 `relative(mediaRoot, dirName)` 恒为空串会让
`findSubtitleWorker.ts:281` 的 `dir` 段整体消失——而"目录名从未进过 prompt"正是 2026-07-26
修过的事故（`findSubtitleWorker.ts:250-258` 头注释：模型直接写下 "No directory names were
provided, so re-identification is impossible"）。

**改为：扁平文件按"每 8 个一组"切成合成单元。** 理由：
- 扁平文件之间**本来就没有 sibling 关系**（没有共同作品目录 = 各是各的作品），所以切分不违反
  §3.1 "兄弟不能切散"的原则——那条原则保护的是同一部剧的集数
- 8 个一组让单个 job 的目标数可控，且仍比"一文件一 job"省 TMDB 往返
- `mediaRoot` 取配置根（合成单元没有真实作品目录），`dir` 段消失是这类布局的固有信息缺失
  （文件名是唯一证据），不是本轮引入的退化

合成单元的 id 用 `<配置根>#flat-<序号>` 形态，仅用于分组，不落库。

🔴 **两个边界**（二轮审计 R2-M1）：

1. **嵌套配置根**：`MEDIA_ROOTS` 允许嵌套（`containingRoot` 注释明说"最长前缀命中，避免嵌套
   配置时 `/media` 抢了 `/media/tv` 的活"）。若同时配了 `/media` 与 `/media/tv`，则目录
   `/media/tv` **同时满足条件 1（它是根）与条件 2（父 `/media` 也是根）**。表格顺序让条件 1
   先命中 → 整个 `tv` 根成一个单元，与意图相反。
   **裁决**：条件 1 改为"当前目录是**最长匹配**的那个配置根"（用 `containingRoot` 的返回值比
   而不是 `roots.includes()`）。嵌套时 `/media/tv/Show` 的 `containingRoot` 是 `/media/tv`，
   所以 `/media/tv/Show` 走条件 2 → 作品根 `/media/tv/Show`，正确。
   **注**：§0 新增的 overlap 校验（改动 0，已实施）从此禁止用户在 UI 里加出嵌套根，但
   `MEDIA_ROOTS` env 种子仍可能带进嵌套值，所以这条边界必须处理。

2. **`mediaRoots` 为空**（开发/测试态）：`containingRoot` 恒返回 null（`mediaContext.ts:42`），
   "硬上界"在第一次检查就触发，但**从未有过在根内的目录**。
   **裁决**：`mediaRoots` 为空时 `workRootOf` 直接返回 `dirname(videoPath)`（退化为"文件所在
   目录即单元"）。这与既有代码在空 roots 下的降级哲学一致（`isUnderRoots` 把空数组当"不限制"，
   `findSubtitleWorkerTask.test.ts:431` 有注释锁死该语义）。**不抛错**——否则会把一个有测试锁
   的既有降级路径改成硬失败。

### 3.2.1 与 stagingRootFor 的契约（一轮 B1 / 二轮 R2-M2）

删掉 §2 的 ③ 后，补断言：**`containingRoot(workRoot, mediaRoots) !== null`**。

理由：`stagingRootFor` 内部调 `containingRoot`，找不到就 `console.error` + 退化返回 `dir`
本身（`findSubtitleWorkerTask.ts:187-197`）。退化后 staging 目录不再挂配置根一级，`gcOrphans`
永远扫不到 → 永久泄漏。这是 H4（2026-07-18 数据安全审计，gcOrphans 盲区修复）的既有防线，
③ 恰好是它唯一的前置守卫。

🔴 **断言不是死代码，且失败时必须降级而非抛错**（二轮审计 R2-M2）：两个可失败场景——
① `mediaRoots` 为空（开发态，见上方边界 2）；② 派发与执行之间用户删了守备目录
（`currentRoots()` 每次新鲜读取，`cli/index.ts:455`，推导用旧根、断言用新根）。

**裁决**：断言失败时**沿用 `stagingRootFor` 既有的 warn + 退化**（不抛错）。本轮只保证"正常
路径下作品根必在配置根内"这个更强的性质由 §3.2 的推导保证，异常路径维持既有降级行为不回退。
§9 的验收门不为这条设判据（它是防御纵深，不是可观测行为）。

### 3.3 新的组批语义

```
listParkedPaths()
  → filter(eligible)                        // 既有：excluded-extra/duplicate-content 不上车
  → filter(!insufficientEvidence)            // 既有：agent 判过证据不足且指纹未变 → 不烧 token
  → filter(退避窗已过)                        // 🔴 新增，见下方"活锁防线"
  → groupBy(workRootOf(path))                // 新增：按作品根分组
  → sort(单元内最早 last_attempt ASC)         // 🔴 改：不用 first_seen，见下方
  → take(UNIT_LIMIT)                         // 新增：按单元数限流，不按文件数
```

`UNIT_LIMIT` 默认 **3**（不是 1，见活锁防线）。

### 3.3.1 🔴🔴 活锁防线（二轮审计 R2-B1 推翻一轮修法，这是本 spec 最关键的一节）

**一轮初稿的错**：`UNIT_LIMIT=1` + `first_seen ASC` → 坏单元永久占队首。

**一轮修法也错了**（二轮审计定罪，我已亲手核验）：修法说"消费既有退避阶梯 + 改
`last_attempt ASC`"，但**这两道防线对两条失败路径完全是空的**：

| agent 结局 | 落库动作 | `last_attempt` | `retry_count`/`next_retry_at` |
|---|---|---|---|
| 拒识（**有** search 证据） | `updateParkReason` (:335) | ✅ 更新 | ❌ 不动 |
| **编造（无 search 证据）** | **仅 `console.error`，零 DB 写**（:326-332） | ❌ 不动 | ❌ 不动 |
| 空报告 / retry_later | `completeError`（只动 jobs 表） | ❌ 不动 | ❌ 不动 |

亲手核验的两条铁证：
1. `unidentifiedFindSubtitle.ts:326-332` 的 `if (!hasSearchEvidence)` 分支体**只有一条
   `console.error`**，没有任何 repo 调用。
2. `updateParkReason`（`libraryRepo.ts:927`）的 SQL 是
   `UPDATE parked_paths SET park_reason=?, last_attempt=? WHERE path=?` ——只写两列。
3. `upsertParkedPath`（**唯一**推进 `retry_count`/`next_retry_at` 的方法）的生产调用点只有
   `ingest.ts:569,627,743` 三处，identify 失败路径**一次都没碰过它**。

推论：坏单元的 `next_retry_at` 永久停在 ingest 首次 park 写的 `now+1h`；一小时后该值恒为过去，
退避窗恒开。`last_attempt` 对"编造"路径恒为最老 → **恒排队首**。一轮修法只剩 `UNIT_LIMIT=3`
在起作用，而那只是把"1 个坏单元卡死全部"降级成"3 个坏单元卡死全部"——多根部署下前 3 个最老
单元往往是同一类畸形布局，仍会永久停摆。

### 真正的修法：给 identify 失败路径接上退避轨

**新增 repo 方法** `LibraryRepo.bumpParkedRetry(path, now)`：

```sql
UPDATE parked_paths
   SET retry_count = retry_count + 1,
       last_attempt = ?,
       next_retry_at = ? + (CASE
         WHEN retry_count = 0 THEN 3600000        -- 下次 1h
         WHEN retry_count = 1 THEN 14400000       -- 下次 4h
         ELSE 86400000 END)                       -- 下次 24h
 WHERE path = ?
```

阶梯值与 `upsertParkedPath` 既有的 1h→4h→24h **共用同一组常量**（不写第二份字面量）。
与 `upsertParkedPath` 的区别：它**只推进退避轨，不改 `park_reason`、不重置阶梯**
（`upsertParkedPath` 在 reason 变化时会把阶梯重置回 1h 档，见 `unidentifiedFindSubtitle.ts:308`
的既有注释——那是给 ingest 的语义，不是这里要的）。

**三条失败路径全部接线**（缺一条就漏一个活锁入口）：

| 路径 | 现状 | 改为 |
|---|---|---|
| 拒识（有证据） | `updateParkReason` | `updateParkReason` + `bumpParkedRetry` |
| 编造（无证据） | 仅 `console.error` | 保留 console.error（反幻觉证据不变）+ `bumpParkedRetry` |
| 空报告 / retry_later | 仅 `completeError` | + 对本批全部 targetPaths `bumpParkedRetry` |

第二条的关键：**拒绝回写 `park_reason` 是对的**（反幻觉红线，不能让编造的结论污染 reason），
但"不回写 reason"≠"不记这次尝试"。尝试次数是机械事实，与 agent 说了什么无关。

**组批时消费退避窗**（现在才真正有意义）：

```
listParkedPaths()
  → filter(eligible)                          // 既有
  → filter(!insufficientEvidence)              // 既有
  → filter(next_retry_at == null || now >= it) // 新增：现在真的会前进了
  → groupBy(workRootOf(path))
  → sort(单元内最小 last_attempt ASC)          // 现在三条路径都会更新它
  → filter(单元总文件数 + 已选 <= MAX_TARGETS)  // 见 §3.3.2
  → take(UNIT_LIMIT)
```

`UNIT_LIMIT` 默认 **3**。§10 的开放问题 1 一并改成 3（一轮修订漏改，会让实施者读到矛盾值）。

**回归锁（必须有，三条路径各一条）**：
- 拒识 → `retry_count` +1、`next_retry_at` 前进、下一轮该单元不在候选里
- 编造 → 同上，且 `park_reason` **仍是** `awaiting-agent-identification`（反幻觉不回退）
- 空报告 → 同上
- 综合：构造"第一个单元恒失败"，断言第 2/3 个单元仍被处理，且第 4 轮时第一个单元已退出队首

### 3.3.2 🔴 文件数硬上限（二轮审计 R2-B3，一轮完全漏了）

`UNIT_LIMIT` 按单元计数后，**文件数失去全部约束**。最坏情况：

- §3.2 条件 1 让"配置根下所有扁平文件"成为一个单元 → `Movies/` 有 200 个扁平文件就是 200 目标
- 3 个单元 × 48 集 = 144 目标；含一个 200 文件扁平单元 = 296 目标
- 296 × 5 步 = 1480 步，逼近 stepCap 2000；agent 每目标多花两步就烧穿
- **而"步数见底"正是 2026-07-28 那场 384 条编造事故的唯一诱因**
  （`unidentifiedFindSubtitle.ts:24-28`）
- `timeoutFor(n) = min(300s + 120s×(n-1), 3600s)`（`findSubtitleWorker.ts:85-89`），n≥28 即触
  1 小时硬顶 → 296 目标拿到的还是 1 小时 → 被 `AbortSignal.timeout` 中途砍断 → 抛错 →
  `completeError` → 单元原地留队首（若无 §3.3.1 的 bump 就是活锁 + 烧钱复合体）

**定 `MAX_TARGETS_PER_JOB = 60`**（对齐既有实测安全值，那是 2026-07-28 事故后定的批次上限）。

**整单元不上车，绝不切半**：若某单元自身文件数 > 60，它单独成一个 job（接受超限，因为切半会
回到 §3.1 "兄弟被切散"的原始问题——那是本轮要修的东西）；若累加会超 60，该单元留到下一轮。

### 3.4 单元级上下文（二轮审计 R2-M7：一轮的"留给 plan"不可接受，这里给确定结论）

一轮说"具体字段设计留给 plan 阶段（可能要动 schema）"——**这个模糊会误导实施者去动圣文件**。
二轮已把接线查清，结论是确定的：

**零 `FindSubtitleTargetFact` schema 改动。** 理由：
- 作品根路径已能从 `task.mediaRoot` 拿到（§3.2 让它就是作品根）
- 单元内文件总数已能从 `task.targets.length` 拿到，且 `findSubtitleWorker.ts:379` **已经在
  渲染** `targets (${task.targets.length} item(s), unidentified parked files)`
- 🔴 **改 `FindSubtitleTargetFact` 会破坏库行 scope**：该类型被 `realignExecutor.ts` 的
  `makeRealignRunEpisode` 复用，schema 注释（`findSubtitleWorker.schemas.ts:50-52`）明确写
  "必须可选（`?:`）——realignExecutor.ts（**圣文件，不可动**）"。加必填字段即破坏该构造点。

**唯一改动**：`findSubtitleWorker.ts` 的 `identityBlock`（`:337-345`）加一句措辞——告诉 agent
"本批全部 target 属于同一个作品目录，请当一部作品的完整文件集来识别，一次搜索覆盖全部"。
这是让 §3 的分组收益真正落到模型行为上的最后一环：二轮审计 R2-m6 指出**同批 ≠ agent 意识到
它们是一组**（`targetsBlock` 逐行渲染，模型需自己横向比对才能推出"这是完整 7 集"）。

合成扁平单元（§3.2）例外——那批 target 彼此**不是**同一部作品，措辞必须分支。为此给
`FindSubtitleTask` 加**可选**字段 `workUnitKind?: 'work-dir' | 'flat-batch'`
（`FindSubtitleTask` 不是圣文件，新增可选字段对既有构造点零影响）。

---

## 4. 改动 C：字幕搜索按作品为单位（**不合并 job**）

### 用户目标

> 最好不要按季来，而且一般而言这些字幕也不是每一集都得找，一般都会是合集。按季来的话就又会
> 重新搜索，那反而总的步数消耗更大，更没效率。

即：**一部剧只搜一次字幕**，别按季重复搜同一个合集页。

### 🔴 自审撤回：不合并识别与字幕 job

本 spec 初稿写的是"识别 → 立即找字幕，一趟做完（worker 改全工具挂载）"。**这是错的，已撤回。**

反证（`src/cli/index.ts:436` 的事故裁决注释）：

> 管线拆分（2026-07-28 事故裁决：**424 写库 / 7 搜索 / 384 编造 / 242 假 unavailable**——
> 识别归识别，找字幕归找字幕，DB 为状态机）

`identifyOnly`（只挂识别工具，字幕工具零挂载）**正是那场事故的修复措施**。一个 run 里同时
给 agent 识别与字幕两套工具，实测结果是它写了 424 次库、只搜 7 次字幕、编造 384 条、
假报 242 条 unavailable。撤掉 identifyOnly 等于原地重演该事故。

### 正确认识：粒度目标不需要合并 job

"一部剧搜一次字幕"由 §3 的作品单元分组**自动达成**，与 job 边界无关：

```
识别 job（identifyOnly）
  拿一个作品单元的全部文件 → 一次 TMDB 搜索 → write_identified_media
  → 整部剧的 episodes 行一次建好（全部 sub_status=missing）
       ↓
orchestrator 下一轮 list_missing_coverage
  看到该剧有 N 集缺字幕
       ↓
派 find_subtitle job（seasons: null = 全剧，既有语义）
  → 字幕 agent 一次搜索覆盖全剧 → 看到合集 → 批量装盘
```

关键在于**识别 job 必须把整部剧的库行一次建全**（而不是散着建），这正是 §3 作品单元分组的
效果。库行建全后，orchestrator 天然派"全剧"任务（`seasons: null`），字幕 agent 只搜一次。

### 本改动的实际内容

**代码改动为零**。既有 `find_subtitle` 管线的 `seasons: null` 语义已经是"全剧覆盖有缺口的
季"。§3 落地后自动生效。

唯一要做的是**验收锁**：确认一个作品单元识别后，orchestrator 派的是全剧任务而非逐季任务。

### stepCap

用户裁决放开。🔴 初稿说"代码改动为零"又说要改 stepCap，自相矛盾（独立审计 M10）。且实际
接线与初稿暗示不同：`cli/index.ts:445-450` 的调用点**根本没传 `stepCap`**，默认值来自
`findSubtitleWorker.ts:426` 的 `deps.stepCap ?? 500` ——那是**识别与字幕两个 scope 共享的
兜底常量**。

**正确改法**：在 `cli/index.ts` 的 `makeUnidentifiedFindSubtitleWorker(...)` 调用处**显式传
`stepCap: 2000`**。绝不动 `findSubtitleWorker.ts:426` 的共享兜底——那会把库行 scope 的字幕
worker 一起提上去，那是不同的活，不该被顺带放开。

2000 不是无限（无限意味着一个死循环 agent 能烧到配额见底）。48 集大单元按 5 步/集估
≈ 300-400 步，2000 留足余量。

---

## 5. 改动 D：甄别页 + 字幕校验页下架

### 用户裁决

> 甄别页完全 archive，字幕校验功能同时 archive。目的是先让 agent 工作流跑顺跑对，
> 用户能通过浏览器看通知一样的东西就够了。代码可以不删，但页面 archive。

### 改法（前端 only，后端一行不动）

🔴 初稿只列了 4 个改点，独立审计 M7 实测**引用面更大**。完整清单：

**源码改点**：
1. `web/src/shell/tabs.ts`：`TABS` 去掉 `triage` 项；`NavLabelKey` 去掉 `'nav_triage'`
2. `web/src/shell/route.ts`：`Tab` 联合类型 + `TAB_IDS` 去掉 `'triage'`
   （降级已自动：`:37` 的 `isTab(raw) ? raw : 'library'`，无需额外代码——**已验证**）
3. `web/src/shell/Sidebar.tsx`：`TAB_ICONS: Record<Tab, ...>` 去掉 `triage` 键
   （🔴 不删会 TS 报"对象字面量多余属性"），`parked` prop 与角标 `endContent` 一并去掉
4. `web/src/shell/AppShell.tsx`：删 `route.tab === 'triage'` 分支；不再给 Sidebar 传 `parked`
5. `web/src/i18n/en.ts` + `zh.ts`：删 `nav_triage` 键（否则成孤儿；`i18n.test.ts` 只测两侧
   键集一致，孤儿不会红但是死代码）
6. 字幕校验渲染点（🔴 真正的改点**不在** `subtitleVerify/` 目录下）：
   - `web/src/library/EpisodeRow.tsx:14,54` — VerifyChip 渲染点
   - `web/src/library/SeasonAccordion.tsx:15,45` — `useSubtitleVerify` 取数点

**必改的测试（🔴 二轮审计 R2-M3 实测：一轮列的 7 条只是 shell 层，实际影响面 ~34 条）**

*shell 层（一轮已列，二轮逐条核对全部准确）*：
| 测试 | 行 | 为何红 |
|---|---|---|
| `App.test.tsx` "渲染四个 tab 项" | :91 | 断言 Triage 链接在场 → 改三项 |
| `App.test.tsx` tab 切换 | :110-113 | 点 Triage 断言 hash+空态 → 删该段 |
| `App.test.tsx` 新鲜度行 | :124 | `getByText('3')` 是甄别角标 → 删断言 |
| `App.test.tsx` 降级态 | :138 | 断言 Triage 链接在场 → 删 |
| `Sidebar.test.tsx` 甄别角标 | :53-57 | 整条主题是角标 → 删用例 |
| `CommandK.test.tsx` 选项列表 | :52 | 断言恰为四项 → 改三项 |
| `CommandK.test.tsx` 键盘 wrap ×2 | :166,197 | 断言 wrap 到末项 `cmdk-option-triage` → 末项变 Settings |

*🔴 字幕校验层（一轮完全漏了，二轮实测）*：
| 测试文件 | 条数 | 说明 |
|---|---|---|
| `web/src/library/EpisodeRow.test.tsx` | **20 条** | `:73,81,86,92,99,107,116,129,138,143,148,156,171,177,184,189,194,200` 等，全部 `renderRow({ verify: ... })` + 断言 `verify-chip-*` testid |
| `web/src/library/SeasonAccordion.test.tsx` | **7 条** | `:117`(整季批量请求) `:129`(红芯片/绿点) `:145`(折叠时不查) `:168`(点芯片开面板) `:192`(对照图失败) `:208`(面板抛错降级) `:246` |

*一轮漏掉的源码改点*：
- `EpisodeRow.tsx:21,37,70` — `verify?: SubtitleVerifyDTO` prop、`library_verify_inspect` i18n
  键、展开区检视入口（只删 `:14,54` 会留 TS 未使用告警 + 孤儿 i18n 键）
- `MovieDetailPage.tsx:202` — verify 结论渲染

**总计约 34 条测试需改**（7 shell + 27 校验层）。§9 的验收门按此计账。

CommandK **源码无需改**（`:39-46` 直接 `TABS.map`，删 TABS 项自动传导）；
`SideNav.test.tsx:28-38` 虽含 "Triage" 文案但自传 props 不读 TABS，**不会红——二轮已验证**。

**保留不动**：`web/src/triage/**`、`web/src/subtitleVerify/**` 全部源码与测试；后端
`/api/v2/triage`、`/api/v2/subtitle/verify|compare|correct|revert` 端点与 `verifySweep`
daemon 分支（`cli/index.ts:41,688,697`）。用户明确"代码可以不删"。

### 回归锁

- 侧栏渲染三项，不含甄别
- `#/triage` → 落地到 library，不白屏、不 404
- 剧集页不出现校验芯片
- `web/src/triage/**` 的既有测试仍全绿（源码未动的证据）

---

## 6. 非目标（本轮明确不做）

- **ingest 直接调 agent**（"未经 agent 过目的文件不进库"）：牵扯 daemon 是否内嵌 LLM 调用，
  部署架构级改动。现有负缓存（`shouldRetryParkedPath` 对 `insufficient-evidence` 永不重试）
  已经解决了"重复烧 token"这个实际痛点，用户已确认够用。
- **readdir(dirName) 真实列举**：§3 的作品单元分组已让同目录 parked 文件天然同批，
  sibling 证据缺口的主要形态已闭合。列举"已识别/非视频邻居"是增量优化，不在本轮。
- **修既有 7 个红测试**（deployContract 3 / zimuku 2 / secrets 1 / settingsRepo 1）：
  干净 HEAD 上就红，是本轮之前的债务，不混进本轮改动。**但 deployContract 那条
  `MEDIA_HOST_PATH :? 守卫` 例外**——它被本轮的 compose 改动直接破坏，必须在本轮修
  （见 §7）。

---

## 7. 改动 E：compose 挂载与它的契约测试

### 现状

昨夜把两条硬编码挂载换成 `/:/hostroot`：

```yaml
# 旧
- ${MEDIA_HOST_PATH:?...}/Movies:/media/movies
- ${MEDIA_HOST_PATH:?...}/TV:/media/tv
# 新
- /:/hostroot
```

`src/deployContract.test.ts` 有一条测试锁死"MEDIA_HOST_PATH 在所有挂载点都带 `:?` 守卫"，
被这个改动破坏。

### 判定

挂载宿主机根目录是**用户明确要求**的方向（"用户目录配置千奇百怪，应该挂根目录让用户自己选"），
不回退。但契约测试的**意图**仍然有效：防止 Docker 在变量未设时静默创建空目录树。

新形态下这个风险不存在（`/` 恒存在，不需要守卫），所以测试应改成锁新契约：

- 媒体挂载点是 `/hostroot`
- 不再引用 `MEDIA_HOST_PATH`（该变量随本轮退役）
- `./cache:/cache` 不变

### 🔴 bundle compose 必须一并裁决（独立审计 M9）

`deployContract.test.ts:76` 的循环**同时遍历 main 与 bundle** 两个 compose：

```ts
for (const [name, compose] of [['main', mainCompose], ['bundle', bundleCompose]] as const)
```

而 `docker-compose.bundle.yml` 的 `:22-24, 93-95` **四处**仍是旧形态
`${MEDIA_HOST_PATH:?...}/Movies:/media/movies`，一行未改。若只改 main 的测试断言，bundle
立刻不满足 → 卡住。

**裁决：bundle 跟着改成 `/:/hostroot`。** 理由：bundle 只是"顺手带一个 Jellyfin 当播放器"的
便利文件，与 scout 的字幕功能无关（compose 头注释自陈）。让两个 compose 的挂载语义分叉会
让契约测试永久需要按文件分支断言，维护成本高于收益。

`docker-compose.local.yml:55,60` 用的是 `MEDIA_ROOTS: /media` + `./fixtures/media:/media`，
**不引用 `MEDIA_HOST_PATH`，不受影响——已验证**。

### 顺带

- `MEDIA_ROOTS` 的语义从"容器内 `/media/*`"变成"容器内 `/hostroot/<宿主机绝对路径>`"
- `docker-compose.yml:74` 的 `MEDIA_ROOTS: ${MEDIA_ROOTS:-/media}` 默认值要改（`/media` 在
  新挂载下不存在）
- `.env.example:52-89` 的 `MEDIA_ROOTS`/`MEDIA_HOST_PATH` 说明段全是旧语义，要重写
- README 的挂载说明段同步
- `deployContract.test.ts:86-92` 与 `:102-108` 里的 `MEDIA_HOST_PATH` 豁免名要清（留着是
  不存在变量的死豁免）

---

## 8. 实施顺序与依赖

🔴 初稿画的 `A → B` **方向是反的**（独立审计 M11）：§2 的改法明确写着 `mediaRoot` = 作品根，
所以 A 的实现**需要 B 的推导函数先存在**。正确顺序：

```
B0 (detectSeasonFolder 加 export)
  ↓
B1 (workRootOf 推导函数 + 单测)
  ↓
B2 (buildUnidentifiedTargets 改按单元分组 + 三道活锁防线)
  ↓
A  (删 commonDir ②③，mediaRoot 换成作品根 + stagingRootFor 断言)
  ↓
E  (compose 契约测试 + bundle compose 裁决)

D (前端下架) ── 与后端零耦合，任意时机
C ── 已撤回为"零代码改动 + 验收锁"，不占实施步骤
```

每步独立可测、独立可提交。B1 是纯函数（最好测），A 依赖 B1 的产出。

## 9. 验收（全部必须通过才提交）

| 门 | 判据 |
|---|---|
| 类型 | `npx tsc --noEmit` 0 错；`cd web && npx tsc --noEmit` 0 错 |
| 后端测试 | 新增回归锁全绿；**既有红从 8 降到 7**（修掉 MEDIA_HOST_PATH 那条） |
| 前端测试 | 全绿——**含本轮必须改的 ~34 条**（见 §5 清单：7 shell + 27 校验层） |
| 构建 | `npm run build` + `cd web && npm run build` 通过 |
| 生产冒烟 | 见 §9.1 可执行判据 |

**既有红基线（二轮实测 8 个，一轮初稿写 7 是错的）**：
- `deployContract.test.ts` **4** 条（3 production contract + 1 MEDIA_HOST_PATH 守卫）
- `buildAdapters.test.ts` 2 条（zimuku + LLM 缺失）
- `secrets.test.ts` 1 条
- `settingsRepo.test.ts` 1 条

MEDIA_HOST_PATH 那条**已经是红的**（工作区 compose 已改），属既有债务而非本轮新增；
本轮 §7 修它 → 收官应为 **7 红**。

🔴 §7 的两处清理有**顺序耦合**（二轮 R2-M6）：删 `.env.example` 的 `MEDIA_HOST_PATH=` 行与清
`deployContract.test.ts:86-91` 的 `composeOnly` 豁免名**必须同一 commit**，否则中间态转红。
（`:100-107` 的 `behavioral` filter 是死代码——`passthroughKeys` 的正则只匹配 env 透传行，而
`MEDIA_HOST_PATH` 只出现在 volumes 行，从未被捕获。清它无风险。）

### 9.1 生产冒烟的可执行判据（二轮 R2-M4：一轮只有自然语言，运维无法执行）

```sql
-- ① 至少一个作品单元完成识别（decision='identity' 是 unidentifiedFindSubtitle.ts:384-391 写的）
SELECT COUNT(*) FROM runs WHERE decision = 'identity';           -- 期望 > 0

-- ② 识别产物真的落库
SELECT COUNT(*) FROM series;                                      -- 期望 > 0
SELECT COUNT(*) FROM episodes;                                    -- 期望 > 0

-- ③ 识别成功的路径退出停车场（clearParkedPath 生效）
SELECT COUNT(*) FROM parked_paths;                                -- 期望 < 492（有下降）

-- ④ 不再出现越界错误
SELECT COUNT(*) FROM jobs WHERE last_error LIKE '%拒绝在媒体根目录之外写入%';  -- 期望 = 0

-- ⑤ 活锁防线生效：失败单元的退避轨在前进
SELECT path, retry_count, next_retry_at FROM parked_paths
 WHERE retry_count > 0 ORDER BY retry_count DESC LIMIT 5;         -- 期望有行且 next_retry_at 在未来
```

容器侧：`docker ps` 状态为 `healthy`；`docker logs subtitle-scout | grep -c "拒绝在媒体根目录之外"`
为 0。

## 9.2 🔴 回滚方案（二轮 R2-M5：一轮全文零命中"回滚"）

**运行时开关**（不需要回滚代码）：`UNIT_LIMIT = 0` ⇒ 退回旧扁平语义（按文件取
`MAX_TARGETS_PER_JOB` 个，不分组）。§3.3 的实现必须保留这条分支并有测试锁。这是发现分组把某类
布局切错时的第一道退路。

**代码回滚的耦合警告**：§8 的 `B→A` 是**强耦合**——A 删掉了 `commonDir` 调用、`mediaRoot` 改由
`workRootOf` 提供，单独回滚 B 会让 A 的 `mediaRoot` 失去来源。所以一轮说的"每步独立可提交"在
回滚维度**不成立**：要回滚必须 A+B 一起回。实施时把 A、B 放在**相邻 commit** 并在 commit
message 里互相标注。

**部署层的不可逆变更**（本轮唯一需要人工迁移的东西）：`MEDIA_ROOTS` 语义从 `/media/*` 变成
`/hostroot/<宿主机绝对路径>`。存量部署的 DB 里 `media_roots` 表存的旧值（如 `/media/movies`）
在新挂载下**不存在** → doctor 会报 media-roots 不可写。

迁移动作（本项目当前部署已手工完成，开源用户需在 README 写明）：
```sql
-- 旧根失效，需按新挂载点重加。示例：
DELETE FROM media_roots WHERE path LIKE '/media/%';
-- 然后在 dashboard 的 Settings → Media 里用目录浏览器重选（起点 /hostroot）
```

---

## 10. 已裁决的参数（二轮审计 R2-m7：一轮把这些列为"开放问题"是错的，它们全是活锁/事故的分水岭）

| 参数 | 值 | 依据 |
|---|---|---|
| `UNIT_LIMIT` | **3** | 一轮初稿写 1 会造成活锁（§3.3.1）。3 是"单点失败不停摆"与"失败隔离仍有意义"的平衡。`0` 保留为回滚开关（§9.2） |
| `MAX_TARGETS_PER_JOB` | **60** | 对齐 2026-07-28 事故后定的实测安全值。无上限会烧穿 stepCap 并撞 1h timeout 硬顶（§3.3.2） |
| 扁平文件合成单元大小 | **8** | 扁平文件无 sibling 关系，切分不违反"兄弟不切散"；8 个一组让目标数可控（§3.2） |
| 识别 job `stepCap` | **2000** | 在 `MAX_TARGETS_PER_JOB=60` 的前提下才安全（60×5=300 步，余量足）。**必须在 `cli/index.ts` 调用处显式传，绝不动 `findSubtitleWorker.ts:426` 的共享兜底**（§4） |
| 退避阶梯 | 1h → 4h → 24h | 与 `upsertParkedPath` 既有阶梯共用同一组常量，不写第二份字面量（§3.3.1） |

**仍需用户裁决的唯一一项**：字幕校验的 daemon sweep（§5 只下架前端）是否一并停。

- 留着：每 6h 跑 ffmpeg 检测并写 `subtitle_verify` 表，但前端已看不见 → 表无上界增长且无 UI
  可清（二轮 R2-m7 判为"下架不彻底的隐性债务"），且软路由要付 CPU
- 停掉：`cli/index.ts` 的 `daemonDeps.verifySweep` 不注入即整分支休眠（既有 optional 设计，
  零成本），将来重启用只需把注入加回

**本 spec 默认取"停掉"**——理由：本轮目标是"让 agent 工作流跑顺"，一个用户看不见的后台
ffmpeg 巡检在软路由上纯属抢资源。用户若有异议在实施前说，改一行注入即可。
