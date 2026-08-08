# v3 实现计划

**方案**: `docs/design/2026-08-07-identity-decoupling-plan.md`（v3 终版，已过两轮对抗性审计）
**基线**: commit `a7a58e4` · 根 tsc 0 错 · 后端 7 红（既有债务）· 前端 863 绿

---

## 任务切分

两步，串行（步 2 依赖步 1 的新方法）。每步 TDD，完成后起新鲜子代理对抗审计。

### 步 1：`LibraryRepo.countParked`

**文件**: `src/v2/libraryRepo.ts` + `src/v2/libraryRepo.test.ts`

纯新增，零既有行为改动。

```ts
countParked(paths: readonly string[]): number
```

实现要点：
- 空数组 → 直接 `return 0`，**不发查询**（SQLite 的 `IN ()` 是语法错误）
- 参数化 IN：`WHERE path IN (${paths.map(() => '?').join(',')})`
- 🔴 SQLite 变量上限 999。`MAX_TARGETS_PER_JOB=60` 远低于此，但**超限单元可能 80+**
  （spec §3.3.2 允许单元自身超限时整单元上车）。分片处理，片大小取 500
- 绝不用 `LIKE` —— 媒体路径合法含 `%`/`_`（`100% Pascal-sensei`、`Look_Back`），
  `libraryRepo.ts:138-141` 的既有注释已记录这个陷阱

测试（回归锁 #8）：
1. 空数组 → 0
2. 混合存在/不存在 → 只数存在的
3. 路径含 `%` 与 `_` 字面量 → 精确匹配，不当通配符
4. 超 500 条 → 分片正确（构造 1200 条，其中 700 条存在）

### 步 2：失败判据 + 删 `:501` + `:493` 注释

**文件**: `src/cli/unidentifiedFindSubtitle.ts` + `src/cli/unidentifiedFindSubtitle.test.ts`

三处改动（方案 §4 的改动 2/3/4）：

**① 四桶全空分支加身份产出维度**

```ts
if (installedToRecord.length === 0 && noMatch.length === 0
    && retryLater.length === 0 && hardsubAssumed.length === 0) {
  const stillParked = deps.lib.countParked(targets.map(t => t.videoPath))
  if (stillParked < targets.length) {
    // 有产出：识别成功但没找字幕。identifyOnly worker 字幕工具零挂载
    // （findSubtitleWorker.ts:209），四桶必然全空——这是正常终局，不是失败。
    // 字幕由 orchestrator 下一轮派 per-series find_subtitle 去找（方案 §6 验证链通）。
    // 不 bump：已识别的路径已被 clearParkedPath 清出，剩下的下一轮自然重来。
  } else {
    bumpUnit()
    failures.push('worker returned an empty batch report')
    recordRun('error', 'empty batch report')
  }
}
```

**② 删 `:501` 的 `if (report.identity?.outcome !== 'unidentified') bumpUnit()`**

⚠️ 只删 `:501`。`:468`（identity 分支）与 `:506`（retry_later 分支）**保留**——
形状互补不重复，删错会回归 spec §3.3.1 定罪的活锁。

**③ `:493` 补注释**：`merged.identity` 零消费方，不承载控制流。

测试（回归锁 #1-7）：
| # | 构造 | 断言 |
|---|---|---|
| 1 | 2 文件都识别成功（clearParkedPath）+ 四桶全空 | `completeDone`、runs 无 error |
| 2 | 2 文件都没识别 + 四桶全空 | `completeError` + runs 有 error + `retry_count` +1 |
| 3 | 1 成功 1 失败 + 四桶全空 | 不记 failure、失败那个 `retry_count` **+0** |
| 4 | `identity: null` + 四桶全空 + 零产出 | `retry_count` **恰好 +1**（锁死 `:501` 已删） |
| 5 | `outcome:'unidentified'` + 四桶全空 + 零产出 | `retry_count` **恰好 +1**（锁死 `:468` 与新判据不重复） |
| 6 | replica 分支（库中已有行 + 旧文件在） | `stillParked=0` → 不记 failure |
| 7 | 1 成功 + agent 报 `outcome:'unidentified'` | 不记 failure |

#4/#5 是本轮最关键的两条——它们锁死"恰好一次 bump"，是删 `:501` 正确性的唯一证据。

---

## 自审：三个最容易写错的地方

来自对抗性审计的警告，逐条给防护：

**① 求值顺序**
`countParked` 是只读的，所以不存在 v2 那个"bump 短路"陷阱。但仍要注意 `stillParked` 必须在
`if` **外面**先算——写成 `if (deps.lib.countParked(...) < targets.length)` 虽然行为正确，
但会让后续维护者难以在调试时看到中间值。用显式 `const`。

**② 删 `:501` 时的连带风险**
`:468` 和 `:501` 在代码里相距 30 行且长得像。实现前先 `grep -n "bumpUnit()"` 确认恰好三处，
删完再 grep 确认剩两处（`:468` 与 `:506`）。

**③ `countParked` 的 IN 子句**
分片逻辑最易错在"最后一片"。测试 #4 构造 1200 条正是为此（1200 = 2 片 + 200 余）。

## 自审：与已有回归锁的兼容

现有 `unidentifiedFindSubtitle.test.ts` 32 条测试里，有 4 条覆盖 bump 行为
（"活锁防线①②③④"）。步 2 会改变它们的**期望值**吗？

- 防线①（拒识有证据）：走 `:450→:468`，四桶全空 → 新判据。若该测试的 fixture 让 parked
  留存（零产出）→ `:468` 一次 + 新判据 bump 一次 = **+2**？

🔴 **这是个真风险**。`:468` 在 identity 分支无条件 bump，新判据在失败分支也 bump。
两者在"`outcome==='unidentified'` + 四桶全空 + 零产出"这个形状下**会同时执行**。

方案 §4 改动 3 只说删 `:501`，但没解决 `:468` 与新判据的重叠。回归锁 #5 恰好锁的就是这个
（"`retry_count` 恰好 +1"）——所以实现时**必须让两者不重复**。

正确解法：新判据的 bump 加守卫，只在 `:468` 没执行时 bump：

```ts
} else {
  // :468 已对 outcome==='unidentified' 的形状 bump 过，不重复
  if (report.identity?.outcome !== 'unidentified') bumpUnit()
  failures.push(...)
}
```

**这恰好就是 `:501` 原来的守卫。** 所以真相是：`:501` 的守卫**不该删**，该删的是它的**位置**
——它现在在四桶全空分支的**外面**（无条件执行），应该移到新判据的失败分支**里面**。

方案 §4 改动 3 的表述"删 `:501`"是**不精确的**，正确表述是"把 `:501` 的 bump 移进失败分支，
守卫保留"。这样：
- 有产出 → 不 bump（新增行为，正确）
- 无产出 + `outcome==='unidentified'` → `:468` 一次（守卫拦住新判据）
- 无产出 + 其它（含 null）→ 新判据一次

三个形状各恰好一次。回归锁 #4/#5 都能过。

**我在计划里修正方案的这处表述**，实现按本计划走。

---

## 验收（每步后跑）

```
npx tsc --noEmit                      # 0 错
npx vitest run src/v2/libraryRepo.test.ts src/cli/unidentifiedFindSubtitle.test.ts
npx vitest run                        # 红仍为 7 且逐条同名
```

全部完成后加 web 与构建门，然后提交推送、归零开跑。
