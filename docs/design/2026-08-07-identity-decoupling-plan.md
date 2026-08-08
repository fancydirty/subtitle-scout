# identifyOnly 空报告误判修复方案（v3 · 终版）

**日期**: 2026-08-07 深夜
**触发**: 作品单元管线上线后首轮 live test（commit `a7a58e4`）
**修订史**: v1 被对抗性审计推翻（误诊）→ v2 收缩到一处但裁决错一条 → v3 采纳审计建议的只读判据
**误诊记录见文末 §9**（保留，防重踩）

---

## 1. 要改什么（三行）

`identifyOnly` worker 字幕工具零挂载，**物理上无法**产出任何字幕桶，但失败判据只认字幕桶
→ 识别成功被判"空报告" → `completeError` → `error_attempt` **单调累积到天级退避**。

改法：加一个只读的"还有几条没被识别走"判据；有产出就不记 failure。

---

## 2. 为什么值得改（不是因为刷红）

### 现象

首轮 live test：11 部作品识别成功、40 集入库、30 条字幕，但 runs 表里每条 `identity` 成功
都配一条 `empty batch report`：

```
#31 [identity] tmdb:1218925 Chainsaw Man — 识别成功
#32 [error]    empty batch report          ← 同一单元
#33 [identity] tmdb:539972                 — 识别成功
#34 [error]    empty batch report
```

### 🔴 真正的危害：吞吐被单调绞紧，且无自愈路径

v2 把影响面写成"下一轮延迟"，**这个论证是错的**（对抗性审计 ⑫ 指出）。亲验后的真实机制：

1. 每个识别成功的单元 → `failures.push` → `completeError`（`unidentifiedFindSubtitle.ts:573-577`）
2. `completeError` 推进 **`error_attempt`**，退避梯是 `30s → 15min → 升级为每天`
   （`jobsRepo.ts:402-405` 注释原文）
3. orchestrator 下一轮重派**无法缩短它**：`upsertWorkerTask` 对 `failed` 态走 `coalesced` 分支，
   **只刷 payload，不动 `next_retry_at`**（`jobsRepo.ts:185-188`，F-R2-5 裁决锁定的语义边界）

所以这是**自加速退化**：识别越顺 → 每轮红得越多 → `error_attempt` 涨得越快 → 退避越长。
`unidentified-backlog` 是识别管线的**唯一入口**，它被推到天级后，剩余 441 个 parked 路径的
处理速率从"每轮一批"退化成"每天一批"。

**"什么都不做"的零风险是假的** —— 不做 = 让 `error_attempt` 无界增长。

### 根因

`unidentifiedFindSubtitle.ts:495`：

```ts
if (installedToRecord.length === 0 && noMatch.length === 0
    && retryLater.length === 0 && hardsubAssumed.length === 0) {
  failures.push('worker returned an empty batch report')
```

四个桶全是**字幕结果**。而 `identifyOnly` 形态下字幕工具零挂载
（`findSubtitleWorker.ts:209` 的 `...(deps.identifyOnly ? {} : subtitleTools())`，2026-07-28
管线拆分事故的修复措施：424 写库 / 7 搜索 / 384 编造）。

识别成功的单元**必然四桶全空**。拿"字幕产出"当唯一成功判据去衡量一个**不负责找字幕**的
worker，是判据用错了对象。

### 为什么库行 scope 没这问题

`findSubtitleWorkerTask.ts:596` 的同款判据多两项：`substantiated`（有证据的 no_safe_match）
与 **`retryLaterFromFabrication`**（`:581`，编造条目的去处）。库行 scope 挂了字幕工具，
"找不到字幕"进 `no_safe_match`；即使编造也被兜进 retry_later 轨。

（v2 在这里论证错了，说是靠 `substantiated`。真正兜住编造的是 `retryLaterFromFabrication`。
这个区别有后果：它提醒我们本轮修法也要想清编造条目的去处 —— 见 §5 的风险表。）

---

## 3. 判据：一次只读查询

判据必须是**机械事实**（不能问 agent —— `identity` 是 advisory schema，
`findSubtitleWorker.schemas.ts:172-177`）。

```ts
// LibraryRepo 新增（纯读，零副作用）
countParked(paths: readonly string[]): number   // 一条 SELECT COUNT(*) ... WHERE path IN (...)
```

```ts
const stillParked = deps.lib.countParked(targets.map(t => t.videoPath))
const identityProgress = stillParked < targets.length
```

差值 > 0 ⇒ 有路径被清出 parked ⇒ 身份落库发生（`write_identified_media` 的事务在
`identityTools.ts:172/229/242/274` 调 `clearParkedPath`）。

### 为什么是只读方法，而不是让 `bumpParkedRetry` 返回 boolean（v2 原案）

审计建议 ⑩，采纳。对比：

| 维度 | v2（bump 返回值兼职统计） | v3（独立只读方法） |
|---|---|---|
| 双重 bump 风险 | 需要小心避开（v2 §5 恰好裁决错了，见 §9） | **结构上不可能** —— bump 只在失败分支调 |
| SQL 次数 | 60 次单行 SELECT | **1 次** IN 查询 |
| 回归锁数量 | 5 条（含返回值语义 + 向后兼容） | **3 条** |
| 符号写反的后果 | `return true` 会让判据全盘反转（所有成功单元判失败） | 无此风险 |
| 语义 | 写操作兼职回答读问题 | 读就是读 |

v2 声称"零新 SQL"是记账把戏 —— 把 60 次单行 SELECT 算成 0，把 1 次 IN 查询算成"新增"。

### 污染路径逐条判定

`parked_paths` 的**全部**删除点（含不走 `clearParkedPath` 的）：

| 删除点 | 会污染判据吗 | 判定 |
|---|---|---|
| `identityTools.ts:172/229/242/274` | — | 这就是要检测的信号 |
| `ingest.ts:879`（文件从磁盘消失） | 会 | **无害**：那形状下文件已不在盘上，"不记 failure"正确 —— 下一轮它也不会再上车。⚠️ 注意 parked 清理是**单轮**的（`ingest.ts:876` 明说"不接入②消失去抖/③骤降哨兵"），CIFS/云盘抖动一次即可触发 |
| `triageOps.ts:35`（甄别翻案） | 不会 | 只对 `park_reason==='excluded-extra'` 生效（`:30`），那类行被 `isParkedPathEligible` 滤掉，**从不上车**（`unidentifiedFindSubtitle.ts:82`） |
| 🔴 **`settingsRepo.ts:199-201`（removeRoot 批删）** | 会 | **v2 漏了这条**（它用 `DELETE FROM parked_paths WHERE substr(...)`，**绕过 `clearParkedPath`**，grep 找不到）。用户删媒体根时撞上 in-flight job → 该根下 parked 全消 → 误判有产出。但同事务也删了 `episodes/movies`（`:179-184`），整批数据已被用户主动移除，此时 job 的结局无关紧要。**接受，不加防护** |

### 并发重 park 会让 stillParked 虚高吗（v2 未讨论，审计 ② 提出）

一次 `runTask` 是完整 LLM run（`stepCap: 2000`，超时硬顶 1h），期间 ingest 心跳可跑 2-3 轮
（`daemon.ts:214`，且 `hasActiveRealignWorkerTask()` 互斥闸**只挡 realign 不挡 find_subtitle**）。
已识别路径会被重新 park 吗？**不会**，两道短路：

- `fresh-or-same`/`promote` 分支（建了库行）：`ingest.ts:573` `findRowByPath` 命中 → 走
  CHEAP PATH/memo-repair（`:576-593`），而 `identityTools.ts:224/270` 无条件 `setProbeMemo`
  保证 memo 命中 → 不重 park
- `replica` 分支（不建库行）：`ingest.ts:604` `getItemFileByPath` 命中 → `:613` continue → 不重 park

🔴 **这个免疫依赖上述两条短路**。日后改 ingest 若打破任一条，本判据会**静默失效**（虚高
→ 误判无产出 → 回到刷红 + 累积退避）。此依赖必须写进实现的代码注释。

---

## 4. 改动清单

### 改动 1：`LibraryRepo.countParked`（新增，纯读）

```ts
/** 判据用：这批路径里还有几条留在 parked_paths。纯读、零副作用、一次查询。
 *  消费方：unidentifiedFindSubtitle 的 identityProgress —— "身份产出"的机械判据
 *  （不问 agent，identity 是 advisory schema）。空数组 → 0，不发查询。 */
countParked(paths: readonly string[]): number
```

参数化 IN 子句要注意 SQLite 变量上限（999，`MAX_TARGETS_PER_JOB=60` 远低于此，但超限单元
可能 80+ —— 实现时分片或断言）。

### 改动 2：失败判据加身份产出维度

`unidentifiedFindSubtitle.ts` 四桶全空分支：

```ts
if (四桶全空) {
  const stillParked = deps.lib.countParked(targets.map(t => t.videoPath))
  if (stillParked < targets.length) {
    // 识别成功但没找字幕 —— identifyOnly worker 无字幕工具，这是正常终局。
    // 不记 failure；runs 的 identity 行已在下方记账；字幕由 orchestrator 下一轮派
    // per-series find_subtitle 任务去找（§6 已验证该链通）。
  } else {
    bumpUnit()                    // 真失败才推退避轨
    failures.push('worker returned an empty batch report')
    recordRun('error', 'empty batch report')
  }
}
```

### 改动 3：把 `:501` 的 bump 移进失败分支，**守卫保留**（表述已修正）

> 🔴 **本节表述经计划阶段自审修正。** v3 初稿写的是"删 `:501`"，那是**不精确的** ——
> 删掉守卫会让 `:468` 与新判据在"`outcome==='unidentified'` + 四桶全空 + 零产出"这个形状下
> 同时执行 → 仍是双重 bump。正确做法是**移位置 + 留守卫**。

现状 `:501` 在四桶全空分支**外面**无条件执行：

```ts
if (report.identity?.outcome !== 'unidentified') bumpUnit()   // :501，位置在分支外
```

改为移进新判据的**失败分支内**，守卫原样保留：

```ts
} else {
  // :468 已对 outcome==='unidentified' 的形状 bump 过（那是 agent 明确拒识的路径），
  // 这里的守卫防的正是与它重复。
  if (report.identity?.outcome !== 'unidentified') bumpUnit()
  failures.push('worker returned an empty batch report')
  recordRun('error', 'empty batch report')
}
```

三个形状各恰好 bump 一次：

| 形状 | `:468` | 新判据失败分支 | 总计 |
|---|---|---|---|
| 有产出（`stillParked < targets.length`） | 视 identity 而定 | **不进此分支** | 0 或 1 |
| 无产出 + `outcome==='unidentified'` | 1 次 | 守卫拦住 | **1** ✅ |
| 无产出 + 其它（含 `identity===null`） | 不执行 | 1 次 | **1** ✅ |

⚠️ **不要删 `:468`** —— 它服务"agent 明确拒识"（此时桶可能非空，不进四桶全空分支）。
删错会让那条路径零 bump → 回归 spec §3.3.1 定罪的活锁。

`:506`（retry_later 分支）**原样保留** —— `retryLater.length > 0` 与四桶全空互斥。

### 改动 4：`:493` 补注释

`merged.identity` 恒 null（多单元常态）但**零消费方**（唯一读点是 `:581` return，而调用方
`cli/index.ts:462` 是裸 `await` 丢弃返回值）。加注释说明它不承载控制流 —— v1 就是误读这里
才误诊的（§9）。

---

## 5. 明确的非目标

| 不做 | 理由 |
|---|---|
| 删装盘门 `:423` | `install_subtitle` **不校验库行**（`InstallSubtitleDeps` 无 `LibraryRepo`，execute 零 DB）。删了会打开"B 的字幕记到 A 的行上"的洞（v1 被推翻的设计，§9） |
| 查 `episodes`/`movies` 判产出 | 误报（`promoteOldestReplica` 改 path）+ 漏报（replica 分支不建库行）+ 两列**无索引**全表扫（v1 被推翻的设计） |
| 改 identity schema | 改 prompt 契约要重跑 identityEval live 评估（11 case）；且真正的 schema 病（§7 静默折叠）改 schema 也治不了 |
| 改 orchestrator | 实测正常（`#57 dispatched 20 find`），§6 已验证字幕链通 |
| 动 `:468` / `:506` | 形状互补，见改动 3 的警告 |

---

## 6. 前提验证：识别成功后字幕链真的通

`identityTools.ts:158` → `subStatus = embeddedLangs?.length ? 'embedded' : 'missing'`，
`:213`（episode）/`:258`（movie）落库。

- `libraryRepo.ts:551` `missingBySeason`：`sub_status='missing'` 计入，`HAVING missing>0` ✅
- `libraryRepo.ts:617,622` `missingMovies`：`WHERE sub_status IN ('missing','unavailable')` ✅
- `orchestratorAgent.tools.ts:70-77` 两者都读 ✅

**链通**，与实测 `#57 dispatched 20 find` 一致。所以"不记 failure"不会让文件永远没字幕。

`completeDone` 后不会卡住：`unidentified-backlog` 是固定合成 identity
（`orchestratorAgent.tools.ts:338`），`upsertWorkerTask` 的 **done 分支**
（`jobsRepo.ts:167-177`）把 `state` 改回 `wanted` 且 `attempt/error_attempt/next_retry_at`
**全部归零** → 返回 `revived`。对比 `failed` 态只走 `coalesced`（不动退避）——
这正是 §2 说的"completeDone 严格优于 completeError"。

---

## 7. 已知债务（本轮不修，但记录本轮是否放大）

**`nullableJsonTolerantCaught` 静默折叠**（`findSubtitleWorker.schemas.ts:180`）：agent 报
`{outcome:'identified', isTv:true, season:null}` 撞 refine → 静默折叠成 null。
唯一可观测面是 `:544-548` 的告警（那段注释是 job 34 第二次失败的复盘产物，实测发生过）。

**本轮是否放大**：若保留 `:501`（v2 原案）会放大 —— 折叠的代价从"advisory 丢失"升级为
"退避跳档"。**改动 3 删掉 `:501` 后不再放大。**

不修的理由：那个容错是刻意设计，救了 43 次已落库的 write_identified_media 不被一份坏
finalize 炸掉。正确治法是"不让控制流读 identity"，但那要重新设计装盘门判据（做成逐路径的
"身份已落地"事实集合），是新设计不是修 bug。

**反编造门 job 级粒度**（`hasSearchEvidence` 的 `:261-270` 头注释）：本轮不碰，未放大。

**`identityTools.ts:109` 的全表扫**：`listParkedPaths().find(p => p.path === path)` ——
每次 `write_identified_media` 全表扫 492 行，60 目标单元 = 60 次。这是既有常态，
不是本轮引入，但它削弱了 §5"无索引全表扫"那条论据的说服力（既有代码量级更大）。

---

## 8. 回归锁

| # | 锁 | 判据 |
|---|---|---|
| 1 | 有产出 → 不记 failure | 单元 2 文件都识别成功（parked 被清）+ 四桶全空 → job `completeDone`、runs 无 error 行 |
| 2 | 无产出 → 仍记 error | 单元文件都没识别（parked 保留）+ 四桶全空 → `completeError` + runs 有 error 行 + `retry_count` +1 |
| 3 | 部分成功 | 2 文件 1 成功 1 失败 + 四桶全空 → 不记 failure、且**失败那个 `retry_count` 恰好 +0**（有产出走成功分支，不 bump） |
| 4 | 🔴 单次 bump（identity=null） | `identity: null` + 四桶全空 + 零产出 → `retry_count` **恰好 +1**（不是 +2，锁死 `:501` 已删） |
| 5 | 🔴 单次 bump（unidentified） | `outcome:'unidentified'` + 四桶全空 + 零产出 → `retry_count` **恰好 +1**（`:468` 一次，新判据一次会变 +2 —— 这条锁死两者不重复） |
| 6 | 🔴 replica 分支算产出 | 库中已有 `tmdb:X` 行 + 旧文件在 → agent 报同一 tmdbId → replica 分支 → `stillParked=0` → 不记 failure |
| 7 | 🔴 部分成功 + 报 unidentified | 2 文件 1 成功，agent 报 `outcome:'unidentified'`（混合单元的自然报法）→ 不记 failure |
| 8 | `countParked` 本身 | 空数组 → 0 不发查询；混合存在/不存在 → 只数存在的；路径含 `%`/`_` 字面量不被当通配符 |

（#4-7 是对抗性审计 ⑨ 指出 v2 缺失的四条。#3 的期望值从 v2 的"+1"改成"+0"—— 因为 v3 把
bump 移进失败分支，有产出就不 bump。）

---

## 9. 附录：v1/v2 的误诊与错裁记录（防重踩）

### v1 误诊：identity 恒 null 导致三处控制流失效

**全错**。三处控制流读的是循环内 `report.identity`（单元级**正常值**），不是
`merged.identity`。亲验：

| v1 主张 | 亲验 |
|---|---|
| `:423` 装盘门失效 | ❌ 没失效 |
| `:501/:506` 活锁防线失效 | ❌ 守卫是 `!== 'unidentified'`，null 天然通过 |
| `:528` 记账丢失 | ❌ `recordRun` 在循环内，11 部作品有 11 条 identity 行 |
| §9.1 ⑤ `retry_count>0` 为空 = 防线失效 | ❌ **这是识别成功的正常结果**：路径被 `clearParkedPath` 清出 → `bumpParkedRetry` 空操作 → `retry_count` 永远 0 |

**教训**：观测到反直觉数字时，第一步该问"它在正常路径下应该是什么"，而不是直接归因为 bug。
我为一个正确行为设计了整套修复。

（顺带：最后一行那个"清出 parked → bump 空操作"的机械事实，**正是 v3 判据的来源** ——
同一个事实先否证了 v1，又构造出了 v3。）

### v1 错设计 1：删装盘门

推理链"installed 非空 ⇒ 身份已定"断裂 —— `install_subtitle` 零 DB 访问、不校验库行。
反例：单元含 A/B，A 识别成功建行、B 失败，agent 报 `identity: unidentified` +
`installed: [{itemId: A的行, installedPath: B旁的字幕}]` → `isOwnedItemId` 通过 →
删门后 **B 的字幕记到 A 的行上**。

`isOwnedItemId` 问"这 id 是本批产物吗"，装盘门问"agent 承认身份定了吗"——**不同问题，
无覆盖关系**。

### v1 错设计 2：查 episodes/movies 判产出

- `ingest.ts:573-580`：库行**已存在**的路径走 CHEAP PATH **从不进 parked** → "在库+不在
  parked"是恒常状态，不是事件指纹
- `identityTools.ts:169-181` replica 分支不建库行 → **漏报**
- `libraryRepo.ts:1033-1041` `promoteOldestReplica` 改 path → **误报**
- 两列无索引 → 60 目标 × 2 表全表扫

### v2 错裁：把"不动 `:501/:506`"列为非目标

建立在"新判据不改变 bump 次数"的错误前提上。新判据把 bump 无条件化后 `:501` 成为重复出口
→ 真失败与静默折叠两个形状都双重 bump。**v3 改动 3 删 `:501`。**

### v2 错论证：库行 scope 靠 `substantiated` 免疫

真正兜住编造的是 `retryLaterFromFabrication`（`findSubtitleWorkerTask.ts:581`，在 `:596`
判据里）。结论对、论证错，且错的论证会让人以为"有 substantiated 就够"。

---

## 10. 验收

| 门 | 判据 |
|---|---|
| 类型 | 根 + web `tsc --noEmit` 0 错 |
| 后端测试 | 8 条新回归锁全绿；既有红仍为 **7** 且逐条同名（deployContract 3 / buildAdapters 2 / secrets 1 / settingsRepo 1） |
| 前端测试 | 863 绿不变 |
| 构建 | 两个 build 通过 |
| **生产冒烟** | ① 识别成功的单元不再产生 `empty batch report` ② `error_attempt` 不再单调累积（job 走 `completeDone`）③ 真失败的单元仍记 error 且 `retry_count` 恰好 +1 ④ 库行与字幕照常入账 |
