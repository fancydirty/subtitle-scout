# Agent-First 识别收尾战役 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent-first 识别管线在真实环境（含阿里云盘）端到端跑通，并给"认不出"的文件一个正确的归宿（等用户改名，而非无限重试）。

**Architecture:** 三块互相独立的改动 + 一次部署 + 两阶段真库验证。①探针并发化（云盘 12s/文件，串行不可接受）；②`[tmdbid-N]` 证据通道接回（我在重构中丢弃的最强证据）；③park 原因二分（`insufficient-evidence` 指纹未变则永不重试 / `identification-failed` 照常退避）。三者都不改识别本身的判断逻辑。

**Tech Stack:** TypeScript + vitest + better-sqlite3 + zod（模型面 schema 一律用 `src/agent/coerce.ts` 的容错 helper）+ rclone/OpenList（挂载层）+ docker compose（软路由）

**前置事实（已实测，勿重新假设）:**
- 备份已完成并校验：`/mnt/nvme0n1-4/backup/subtitles-pre-agent-first-20260728.tar.gz`（1893 个字幕，与盘上数量一致）；库备份 `cache/backups/scout.db.pre-agent-first-20260727-205530`
- 云盘挂载胜者 = rclone WebDAV → OpenList（详见 Spec 1 §3.1）。**NFS 不可行**（OpenList 无此 egress；`rclone serve nfs` 实测 49s 且 I/O error）
- `parked_paths.park_reason` 是裸 `TEXT NOT NULL`，**无 CHECK 约束**（真库 DDL 已确认）→ 加新值零迁移
- `LibraryRepo.updateParkReason(path, reason, now)` 已存在（`libraryRepo.ts:891`）→ 回写不需新写口
- **`upsertParkedPath` 在 reason 变化时会重置退避到 1h 档**（`libraryRepo.ts:805-817`）。这与 park 二分的交互见 Task 3.4，必须理解后再动
- 真库 schema **16**，代码 25，部署时自动迁移（`db.ts:461` 事务 + 迁移前 FK 体检）
- `docker-compose.yml` 由软路由持有，`deploy.sh` 用 `--filter='protect'` 保护 → **compose 改动必须手工 ssh 编辑，不能走部署脚本**

---

## Task 1: 探针并发化（Spec 1 §3.3）

**为什么：** 云盘单文件 ffprobe 12-16s，27 个文件串行 ≈ 6 分钟；全量若接入更多云盘文件会成为硬瓶颈。CIFS 上 1.09s，并发收益小，故并发度必须**可配且默认保守**。

**Files:**
- Modify: `src/v2/ingest.ts`（FULL PATH 的探针段，约 `:610-640`）
- Test: `src/v2/ingest.probeConcurrency.test.ts`（新建）

- [ ] **Step 1.1: 先读现状，理解失败隔离语义**

读 `src/v2/ingest.ts` 的 FULL PATH 探针段。当前形状（逐文件、串行、各自 try/catch）：

```ts
let durationSec: number | null = null
let embeddedLangs: string[] | null = null
try {
  durationSec = await deps.probeDuration(path)
} catch (err) {
  deps.log(`probeDuration failed for ${path}: ${err}`)
}
try {
  const tracks = await deps.probe(path)
  embeddedLangs = tracks === null ? null : usableEmbeddedLangs(tracks)
} catch (err) {
  deps.log(`probe failed for ${path}: ${err}`)
}
```

关键约束（**必须保持**）：一个文件的探针失败只影响它自己，不拖垮整轮 pass。并发化后用 `Promise.allSettled` 语义，**绝不用 `Promise.all`**（一个 reject 丢弃其余结果）。

- [ ] **Step 1.2: 写失败的测试**

创建 `src/v2/ingest.probeConcurrency.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mapWithConcurrency } from './probeConcurrency.js'

describe('mapWithConcurrency', () => {
  it('并发上限被遵守（峰值不超过 limit）', async () => {
    let inFlight = 0
    let peak = 0
    const items = [1, 2, 3, 4, 5, 6, 7, 8]
    await mapWithConcurrency(items, 3, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return n * 2
    })
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1) // 真的并发了，不是退化成串行
  })

  it('结果按输入顺序归属，不按完成顺序', async () => {
    const items = [50, 10, 30] // 故意让后面的先完成
    const out = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms))
      return ms
    })
    expect(out).toEqual([
      { status: 'fulfilled', value: 50 },
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 30 },
    ])
  })

  it('一个失败不影响其余（allSettled 语义，不是 all）', async () => {
    const items = ['ok1', 'boom', 'ok2']
    const out = await mapWithConcurrency(items, 2, async (s) => {
      if (s === 'boom') throw new Error('probe exploded')
      return s.toUpperCase()
    })
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'OK1' })
    expect(out[1].status).toBe('rejected')
    expect(out[2]).toEqual({ status: 'fulfilled', value: 'OK2' })
  })

  it('limit=1 等价串行', async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--; return n
    })
    expect(peak).toBe(1)
  })

  it('空输入返回空数组，不抛', async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([])
  })
})
```

- [ ] **Step 1.3: 跑测试确认失败**

Run: `npx vitest run src/v2/ingest.probeConcurrency.test.ts`
Expected: FAIL — `Failed to resolve import "./probeConcurrency.js"`

- [ ] **Step 1.4: 写最小实现**

创建 `src/v2/probeConcurrency.ts`：

```ts
/** 有界并发 map，保持 allSettled 语义与输入顺序。
 *
 *  为什么需要它（Spec 1 §2.3 实测）：阿里云盘经 rclone WebDAV 的单文件 ffprobe 是 12-16s，
 *  其中 ~12s 是阿里云 CDN 的延迟地板（绕过 FUSE 直读签名 URL 同样 12.1s），**串行不可优化**。
 *  但 4 文件并发实测 16.1s 墙钟（vs FTP 挂载的 86.1s）——WebDAV 每个 range 请求 302 到 CDN，
 *  真并行。收益全在并发，不在换协议。
 *
 *  为什么是 allSettled 而不是 all：ingest 的既有铁律是"一个文件/一次抖动不能拖垮整轮 pass"
 *  （见 ingest.ts 收尾的 catch 注释）。`Promise.all` 一个 reject 就丢弃其余已完成结果，会把
 *  单文件探针失败升级成整批丢失。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return []
  const effective = Math.max(1, Math.floor(limit))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(effective, items.length) }, worker))
  return results
}
```

- [ ] **Step 1.5: 跑测试确认通过**

Run: `npx vitest run src/v2/ingest.probeConcurrency.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 1.6: 提交**

```bash
git add src/v2/probeConcurrency.ts src/v2/ingest.probeConcurrency.test.ts
git commit -m "feat(v2): 有界并发 map（allSettled 语义）——云盘探针并发化的地基

云盘经 rclone WebDAV 单文件 ffprobe 12-16s，~12s 是阿里云 CDN 延迟地板
（绕过 FUSE 直读签名 URL 同样 12.1s），串行无从优化。但 4 并发实测 16.1s
墙钟（FTP 挂载同场景 86.1s），收益全在并发。

allSettled 而非 all：ingest 的铁律是单文件失败不拖垮整轮 pass，Promise.all
一个 reject 会丢弃其余已完成结果，把单点失败升级成整批丢失。"
```

- [ ] **Step 1.7: 接进 ingest 的探针段**

修改 `src/v2/ingest.ts`。**注意**：FULL PATH 现在在一个逐文件的 `for` 循环里，探针是循环体内的两次 await。并发化需要把"收集待探针路径 → 批量并发探针 → 回填"这三步分离。

这一步是本 Task 唯一有结构风险的改动，实施时必须：
1. 先确认 FULL PATH 循环体内探针**之后**的逻辑（`upsertParkedPath` 调用）只依赖该文件自己的 `durationSec`/`embeddedLangs`，不依赖循环顺序
2. 保持每个文件失败时的日志措辞不变（现有运维习惯）
3. `deps.probeDuration` / `deps.probe` 的调用次数与参数不变（TMDB/ffprobe 侧无行为变化）

并发度来源：新增 `deps.probeConcurrency?: number`，默认 **2**（保守；CIFS 上 1.09s 并发收益小，云盘上 2 并发已能把 27 文件从 6 分钟压到 ~3 分钟）。真正的调优留给部署后实测。

- [ ] **Step 1.8: 跑全量测试 + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 tsc errors；全部通过（基线 1999 passed / 115 files）。**若有 ingest 测试失败，是 Step 1.7 改动的回归——必须修，不许改测试迁就实现。**

- [ ] **Step 1.9: 提交**

```bash
git add src/v2/ingest.ts
git commit -m "feat(v2): ingest 探针并发化（默认 2，可配）

云盘 27 文件串行探针约 6 分钟；并发 2 后约 3 分钟。CIFS 上探针 1.09s，
并发收益小，故默认值保守取 2，调优待部署后实测。

失败隔离语义不变：每个文件的探针失败只影响它自己（allSettled），
日志措辞逐字保留。"
```

---

## Task 2: 接回 `[tmdbid-N]` 证据通道（Spec 4）

**为什么：** 我在 agent-first 重构里把 ingest FULL PATH 砍到 37 行时丢了 `embeddedTmdbId`。这是**本项目自己产出的规范布局**（`buildTargetShowDir` 写的 `Show (Year) [tmdbid-N]`）——即"本项目整理过的库，再次扫描时认不出自己写下的 id"。且它正是 Spec 3 要求用户改名时**最精确的那种改名**。

**Files:**
- Modify: `src/v2/db.ts`（加迁移：`parked_paths.embedded_tmdb_id` 列）
- Modify: `src/v2/libraryRepo.ts`（`ParkedPath` 类型 + `upsertParkedPath` 写入 + `listParkedPaths` 读出）
- Modify: `src/v2/ingest.ts`（FULL PATH 落库）
- Modify: `src/cli/unidentifiedFindSubtitle.ts`（targets 组装）
- Modify: `src/agent/findSubtitleWorker.schemas.ts`（`FindSubtitleTargetFact` 加字段）
- Modify: `src/agent/findSubtitleWorker.ts`（`targetsBlock` 呈现）
- Modify: `src/agent/skills/identifyMediaSkill.ts`（教它：hint 不是判决）
- Delete: `src/recognition/rawEvidence.ts` + 其测试（死代码，用户裁决"该干掉就干掉"）
- Test: 各处对应测试

- [ ] **Step 2.1: 先确认 rawEvidence 真的是死代码（删之前必须验证，别伤筋动骨）**

Run:
```bash
rg -n "buildRawEvidence|RawFileEvidence" src/ --glob '!src/recognition/rawEvidence*'
```
Expected: 无输出（除了它自己的定义与测试）。**若有输出，停下来报告——说明它有调用者，不能删。**

- [ ] **Step 2.2: 写失败的测试（迁移 + 存取）**

在 `src/v2/libraryRepo.test.ts` 追加：

```ts
it('parked_paths 存取 embedded_tmdb_id（[tmdbid-N] 路径标签，Spec 4）', () => {
  const lib = new LibraryRepo(db)
  lib.upsertParkedPath('/media/tv/Show (2020) [tmdbid-1396]/S01E01.mkv', 'awaiting-agent-identification', 1000, {
    mtimeMs: 500, size: 1024, embeddedTmdbId: '1396',
  })
  const row = lib.listParkedPaths().find((p) => p.path.includes('tmdbid-1396'))
  expect(row?.embedded_tmdb_id).toBe('1396')
})

it('无标签路径的 embedded_tmdb_id 为 NULL（绝大多数情况的回归锁）', () => {
  const lib = new LibraryRepo(db)
  lib.upsertParkedPath('/media/tv/Plain/S01E01.mkv', 'awaiting-agent-identification', 1000, {
    mtimeMs: 500, size: 1024,
  })
  const row = lib.listParkedPaths().find((p) => p.path.includes('Plain'))
  expect(row?.embedded_tmdb_id).toBeNull()
})

it('指纹未变的重 park 保留已有 embedded_tmdb_id（不被无标签的重 park 冲掉）', () => {
  const lib = new LibraryRepo(db)
  const p = '/media/tv/Show (2020) [tmdbid-1396]/S01E01.mkv'
  lib.upsertParkedPath(p, 'awaiting-agent-identification', 1000, { mtimeMs: 500, size: 1024, embeddedTmdbId: '1396' })
  lib.upsertParkedPath(p, 'awaiting-agent-identification', 2000, { mtimeMs: 500, size: 1024 })
  expect(lib.listParkedPaths().find((r) => r.path === p)?.embedded_tmdb_id).toBe('1396')
})
```

- [ ] **Step 2.3: 跑测试确认失败**

Run: `npx vitest run src/v2/libraryRepo.test.ts -t 'embedded_tmdb_id'`
Expected: FAIL

- [ ] **Step 2.4: 加迁移 + 实现存取**

`src/v2/db.ts`：在 `MIGRATIONS` 数组**末尾追加**一条（成为 v26）。照 v25 那条的条件式写法（`db.ts:345` 附近是现成范例）：

```ts
  // v26（Spec 4：接回 [tmdbid-N] 证据通道）：parked_paths 加一列存路径里的 TMDB id 标签。
  // 这是本项目自己产出的规范布局（buildTargetShowDir: `Show (Year) [tmdbid-N]`）与外部
  // 整理工具（*arr 生态）都会写的标签，是**最强 hint**——但仍只是 hint：标签可能过期或
  // 写错，agent 必须 TMDB 核验后才能认领（否则等于重开一个绕过 two-evidence bar 的后门）。
  // NULL = 路径里没有标签（绝大多数情况），不是"未探测"——它是纯路径解析产物，同步、零 I/O。
  (db: ScoutDb) => {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(parked_paths)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    if (!columns.has('embedded_tmdb_id')) {
      db.exec(`ALTER TABLE parked_paths ADD COLUMN embedded_tmdb_id TEXT`)
    }
  },
```

同时更新 `db.ts:110` 的 `parked_paths` 终态 CREATE TABLE（fresh install 一次到位），照 v25 两列的既有注释风格补一行说明。

`src/v2/libraryRepo.ts`：
- `ParkedPathFingerprint` 加 `embeddedTmdbId?: string | null`
- `ParkedPath` 类型加 `embedded_tmdb_id: string | null`
- `upsertParkedPath` 的 SELECT/INSERT/ON CONFLICT 三处都加该列；保留语义与 `duration_sec` 完全一致（**仅指纹未变时保留库中已有值**，见 `libraryRepo.ts:820-825` 的既有注释）
- `listParkedPaths` 的 SELECT 加该列

- [ ] **Step 2.5: 跑测试确认通过**

Run: `npx vitest run src/v2/libraryRepo.test.ts -t 'embedded_tmdb_id'`
Expected: PASS（3 tests）

- [ ] **Step 2.6: 提交**

```bash
git add src/v2/db.ts src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat(v2): parked_paths 加 embedded_tmdb_id 列（schema v26）

接回 [tmdbid-N] 路径标签这条证据通道的第一段。该标签是本项目自己产出的
规范布局（buildTargetShowDir）与 *arr 生态都会写的形态，rawEvidence.ts 的
注释称它 STRONGEST hint——但它此前被静默丢弃（我在 agent-first 重构把
ingest FULL PATH 砍到 37 行时丢的，是 spec §1.2 的违背）。

保留语义与 duration_sec 一致：仅指纹未变时保留库中已有值。"
```

- [ ] **Step 2.7: ingest 落库**

`src/v2/ingest.ts` FULL PATH：`outcome`（`PathIdentity`）已含 `embeddedTmdbId`，把它传进 `upsertParkedPath` 的 fingerprint 参数。

**注意**：`identity` 变量在 `'park' in outcome` 分支后才可用；park 分支（`no-signal` 等）也可能需要它——但 `identifyFromPath` 的 park 分支不返回该字段，所以 park 分支传 `undefined` 即可（保持"NULL=无标签"语义）。

在 `src/v2/ingest.test.ts`（或既有 ingest 测试文件）加一条：

```ts
it('FULL PATH 把路径里的 [tmdbid-N] 落进 parked_paths（Spec 4）', async () => {
  // 沿用该文件既有的 ingest 测试脚手架构造一个带标签的路径，跑一轮 ingest，
  // 断言 listParkedPaths() 里该行的 embedded_tmdb_id === '1396'
})
```

- [ ] **Step 2.8: targets 组装 + prompt 呈现**

`src/agent/findSubtitleWorker.schemas.ts` 的 `FindSubtitleTargetFact` 加：

```ts
  /** 路径里的 `[tmdbid-N]` 标签（Spec 4）。null = 路径无标签（绝大多数）。
   *  **这是 hint 不是判决**：标签由上一轮 run 或外部整理工具写下，可能过期或错误，
   *  agent 必须 get_tmdb_details 核验通过才能认领——否则等于重开一个绕过
   *  two-evidence bar 的后门。 */
  embeddedTmdbId: string | null
```

`src/cli/unidentifiedFindSubtitle.ts` 的 `buildUnidentifiedTargets`：从 parked 行读该列填进去（**不要**用 `identifyFromPath` 重算——库里的值是摄取时的事实，且 Task 2.4 已保证它随指纹保留）。

`src/agent/findSubtitleWorker.ts` 的 `targetsBlock`（unidentified 分支）：加一段呈现，措辞必须明示可能过期：

```ts
const tag = t.embeddedTmdbId
  ? ` | path carries [tmdbid-${t.embeddedTmdbId}] (STRONGEST hint — but it may be stale or wrong; verify with get_tmdb_details before claiming it)`
  : ''
```

- [ ] **Step 2.9: skill 教它（hint 不是判决）**

`src/agent/skills/identifyMediaSkill.ts` 加一节（放在 two-evidence bar **之后**，因为它是"起点优化"而非"绕过门槛"）：

```
## When the path carries a `[tmdbid-N]` tag

Some paths carry an explicit TMDB id — either written by a previous run of this system or by an
external organizer (Sonarr/Radarr and similar). It is the strongest starting point you will get:
skip searching and call `get_tmdb_details` on that id directly.

It is a starting point, not a verdict. The tag may be stale or simply wrong — a previous run may
have misidentified the show, or whoever renamed the directory may have typed the wrong number.
So the two-evidence bar still applies in full: the details you get back must match the name
evidence AND the structure evidence. If the tagged id fails the bar, discard it and identify from
scratch (clean a title, search, verify) — do not claim an identity just because a number was
written in the path.
```

在 `src/agent/skills/identifyMediaSkill.test.ts` 加锚点：

```ts
it('[tmdbid-N] 标签是起点不是判决（Spec 4 红线）', ({ expect }) => {
  expect(skill.content).toMatch(/\[tmdbid-N\] tag/i)
  expect(skill.content).toMatch(/starting point, not a verdict/i)
  expect(skill.content).toMatch(/stale or simply wrong/i)
  // 核验失败必须回退到从零识别
  expect(skill.content).toMatch(/identify from\s+scratch/i)
  // 不许因为路径里写了个数字就认领
  expect(skill.content).toMatch(/not claim an identity just because a number/i)
})
```

- [ ] **Step 2.10: 删死代码 rawEvidence**

前提：Step 2.1 已确认零调用者。

```bash
rm src/recognition/rawEvidence.ts
rm -f src/recognition/rawEvidence.test.ts
rg -n "rawEvidence" src/    # 必须零输出
```

- [ ] **Step 2.11: 跑全量 + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors；全绿。

- [ ] **Step 2.12: 提交**

```bash
git add -A
git commit -m "feat(agent): [tmdbid-N] 证据通道全链路接回 + 删死代码 rawEvidence

三段全接：ingest 落库 → buildUnidentifiedTargets 读出 → targetsBlock 呈现。
skill 明确教它是**起点不是判决**：标签可能过期/写错，仍须过 two-evidence
bar，核验失败回退从零识别——否则等于重开一个绕过证据门的后门（这正是
Spec 3 要废掉的认领后门的另一种形态）。

顺手删 src/recognition/rawEvidence.ts：我写的死代码，零生产调用者（注释里
还自称 STRONGEST hint 却从未接上）。删前已 grep 确认无调用者。"
```

---

## Task 3: park 原因二分（Spec 2）

**为什么：** 现在 agent 认不出的文件，park 原因仍是 `awaiting-agent-identification`，负缓存按**时间**退避（1h→4h→24h），窗口一到必然重跑、必然又失败。用户裁决"认不出的责任在用户侧（去改名）"需要一个落地机制：证据集合为空的文件，**指纹未变则永不重试**。

**Files:**
- Modify: `src/agent/findSubtitleWorker.schemas.ts`（`identity` 的 `unidentified` 分支加分类字段）
- Modify: `src/agent/skills/identifyMediaSkill.ts`（教二分判据 + 四条反例）
- Modify: `src/v2/libraryRepo.ts`（`shouldRetryParkedPath` 加指纹门 + `PARK_REASON` 常量）
- Modify: `src/cli/unidentifiedFindSubtitle.ts`（收割时回写 park 原因）
- Test: 各处对应测试

- [ ] **Step 3.1: 写失败的测试（schema 容错——六轮血案的回归锁）**

在 `src/agent/findSubtitleWorker.schemas.test.ts` 追加。**这组测试是本 Task 最重要的部分**：模型对枚举字段会发各种变体，schema 太窄会让 agent"想报却报不进来"（`identityTools.ts:11-23` 记录了那次让六轮评估全废的血案）。

```ts
describe('identity.unidentified 的 kind 分类容错（Spec 2 + 六轮血案纪律）', () => {
  const base = { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
  const parse = (identity: unknown) =>
    FindSubtitleBatchReportSchema.safeParse({ ...base, identity })

  it('标准值：insufficient-evidence', () => {
    const r = parse({ outcome: 'unidentified', reason: '路径无任何片名信息', kind: 'insufficient-evidence' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('insufficient-evidence')
  })

  it('标准值：identification-failed', () => {
    const r = parse({ outcome: 'unidentified', reason: 'TMDB 无此条目', kind: 'identification-failed' })
    expect(r.success).toBe(true)
  })

  it('下划线变体（模型常发）折叠为连字符', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x', kind: 'insufficient_evidence' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('insufficient-evidence')
  })

  it('大写变体折叠', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x', kind: 'INSUFFICIENT-EVIDENCE' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('insufficient-evidence')
  })

  it('🔴 省略 kind → 安全默认 identification-failed（宁可多跑一轮，不可永久钉死文件）', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('identification-failed')
  })

  it('🔴 无法识别的值 → 安全默认 identification-failed，不炸报告', () => {
    const r = parse({ outcome: 'unidentified', reason: 'x', kind: 'i-have-no-idea' })
    expect(r.success).toBe(true)
    if (r.success) expect((r.data.identity as any).kind).toBe('identification-failed')
  })
})
```

- [ ] **Step 3.2: 跑测试确认失败**

Run: `npx vitest run src/agent/findSubtitleWorker.schemas.test.ts -t 'kind 分类容错'`
Expected: FAIL（`kind` 字段不存在 / 默认值缺失）

- [ ] **Step 3.3: 实现 schema（用 coerce.ts，不要新造窄门）**

`src/agent/findSubtitleWorker.schemas.ts` 的 `unidentified` 分支加：

```ts
    z.object({
      outcome: z.literal('unidentified'),
      reason: z.string().min(1),
      /** Spec 2：两种失败在物理上不同——`insufficient-evidence`（证据集合为空，重跑必然
       *  同样结果，**指纹未变则永不重试**，等用户改名）vs `identification-failed`（有证据
       *  但未过 two-evidence bar，可能 TMDB 后来收录/模型这轮不行/网络抖动 → 照常退避）。
       *
       *  🔴 安全默认是 identification-failed：省略键或发了无法识别的值时，宁可多跑一轮，
       *  也不可把一个可自愈的文件永久钉死。偏向"继续尝试"是刻意的不对称。
       *
       *  🔴 容错口径同 identityTools.ts 顶部记录的六轮血案：真模型对枚举会发下划线/大写/
       *  省略等变体，schema 太窄会让 agent"想报却报不进来"。这里 preprocess 折叠变体。 */
      kind: z.preprocess(
        (v) => {
          if (typeof v !== 'string') return 'identification-failed'
          const norm = v.trim().toLowerCase().replace(/_/g, '-')
          return norm === 'insufficient-evidence' ? 'insufficient-evidence' : 'identification-failed'
        },
        z.enum(['insufficient-evidence', 'identification-failed']),
      ),
    }),
```

- [ ] **Step 3.4: 跑测试确认通过**

Run: `npx vitest run src/agent/findSubtitleWorker.schemas.test.ts -t 'kind 分类容错'`
Expected: PASS（6 tests）

- [ ] **Step 3.5: 提交**

```bash
git add src/agent/findSubtitleWorker.schemas.ts src/agent/findSubtitleWorker.schemas.test.ts
git commit -m "feat(agent): identity.unidentified 增 kind 分类（证据不足 / 识别失败）

两种失败在物理上不同：证据集合为空时重跑必然同样结果（等用户改名），
有证据但没过 bar 则可能自愈（TMDB 后来收录/模型这轮不行/网络抖动）。

安全默认刻意不对称：省略键或无法识别的值一律落 identification-failed
（照常重试）——宁可多跑一轮，不可把可自愈的文件永久钉死。

容错口径遵守 identityTools.ts 记录的六轮血案纪律：折叠下划线/大写变体，
schema 太窄会让 agent 想报却报不进来。"
```

- [ ] **Step 3.6: 负缓存加指纹门**

先在 `src/v2/libraryRepo.ts` 定义常量（避免字符串散落）：

```ts
/** park 原因的权威值域（Spec 2/3）。自由文本列，但代码内一律用这些常量。 */
export const PARK_REASON = {
  awaitingAgent: 'awaiting-agent-identification',
  insufficientEvidence: 'insufficient-evidence',
  identificationFailed: 'identification-failed',
  excludedExtra: 'excluded-extra',
  duplicateContent: 'duplicate-content',
  noSignal: 'no-signal',
} as const
```

写失败的测试（`src/v2/libraryRepo.test.ts`）：

```ts
describe('shouldRetryParkedPath 与 insufficient-evidence（Spec 2）', () => {
  it('🔴 insufficient-evidence + 指纹未变 → 不重试（等用户改名）', () => {
    const lib = new LibraryRepo(db)
    const fp = { mtimeMs: 500, size: 1024 }
    lib.upsertParkedPath('/media/movies/random/1.mp4', PARK_REASON.insufficientEvidence, 1000, fp)
    // 即使退避窗口早已过期，也不重试
    expect(lib.shouldRetryParkedPath('/media/movies/random/1.mp4', fp, 1000 + 999 * 3600_000)).toBe(false)
  })

  it('🔴 指纹变了（用户动了文件）→ 重试，优先级高于 insufficient-evidence', () => {
    const lib = new LibraryRepo(db)
    lib.upsertParkedPath('/media/movies/random/1.mp4', PARK_REASON.insufficientEvidence, 1000, { mtimeMs: 500, size: 1024 })
    expect(lib.shouldRetryParkedPath('/media/movies/random/1.mp4', { mtimeMs: 999, size: 1024 }, 2000)).toBe(true)
  })

  it('identification-failed 照常按时间退避', () => {
    const lib = new LibraryRepo(db)
    const fp = { mtimeMs: 500, size: 1024 }
    lib.upsertParkedPath('/media/tv/x.mkv', PARK_REASON.identificationFailed, 1000, fp)
    expect(lib.shouldRetryParkedPath('/media/tv/x.mkv', fp, 1000)).toBe(false)          // 窗内
    expect(lib.shouldRetryParkedPath('/media/tv/x.mkv', fp, 1000 + 3700_000)).toBe(true) // 1h 后
  })
})
```

Run: `npx vitest run src/v2/libraryRepo.test.ts -t 'insufficient-evidence'` → 预期 FAIL

实现：在 `shouldRetryParkedPath` 里加一条，**位置必须在"指纹变了 → 重试"之后**：

```ts
    if (row.probe_mtime !== fingerprint.mtimeMs || row.probe_size !== fingerprint.size) return true
    // Spec 2：可自愈的终局——证据集合为空，指纹未变时重跑必然同样结果，纯浪费。
    // 用户改名 → path 变 → 这一行随磁盘真相清理消失（ingest.ts:761）→ 新路径无 parked 行
    // → 上方 `if (!row) return true` 自然重走识别。指纹门的优先级刻意低于指纹变化：
    // 用户动了文件就该立刻重试，不受本条约束。
    if (row.park_reason === PARK_REASON.insufficientEvidence) return false
```

**注意**：`shouldRetryParkedPath` 现在的 SELECT 没取 `park_reason`，要加上。

Run: `npx vitest run src/v2/libraryRepo.test.ts -t 'insufficient-evidence'` → 预期 PASS

- [ ] **Step 3.7: 提交**

```bash
git add src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat(v2): insufficient-evidence 的负缓存指纹门 + PARK_REASON 常量

证据集合为空的路径，指纹未变时永不重试——重跑必然同样结果，是确定不自愈
而非可能自愈。用户改名后 path 变，旧行随磁盘真相清理消失，新路径自然重走
识别（自愈链零新代码）。

指纹门优先级刻意低于指纹变化：用户动了文件立刻重试，不受本条约束。"
```

- [ ] **Step 3.8: 收割时回写 park 原因**

`src/cli/unidentifiedFindSubtitle.ts`：`identity.outcome === 'unidentified'` 时，对**本批目标**的每个路径调 `lib.updateParkReason(path, kind, now)`。

**关键约束（三条，都必须遵守）：**
1. 只回写本 task 的目标路径（同既有 itemId 幻觉防线纪律，`unidentifiedFindSubtitle.ts:209-215` 是现成范例）
2. 用 `updateParkReason`（`libraryRepo.ts:891`）而**不是** `upsertParkedPath`——后者在 reason 变化时会把退避重置到 1h 档（`libraryRepo.ts:805-817`），那会让 `identification-failed` 的退避阶梯每轮归零、永远停在 1h。`updateParkReason` 只改 reason + last_attempt，不碰退避列，正是需要的语义
3. 已识别成功的路径不回写（它们已被 `write_identified_media` 的事务 `clearParkedPath` 清掉）

测试（`src/cli/unidentifiedFindSubtitle.test.ts`）：

```ts
it('unidentified + kind=insufficient-evidence → 回写 park 原因（Spec 2）', async () => {
  // 用该文件既有的 stub 脚手架：让 runTask 返回
  // { identity: { outcome: 'unidentified', reason: '路径无片名信息', kind: 'insufficient-evidence' }, ... }
  // 断言 listParkedPaths() 里该路径的 park_reason === 'insufficient-evidence'
})

it('回写不重置退避阶梯（用 updateParkReason 而非 upsertParkedPath）', async () => {
  // 先把某路径推到 4h 档（retry_count=1），跑一轮 unidentified 回写，
  // 断言 retry_count 未被重置为 0
})

it('agent 报本批之外的路径 → 不回写并告警', async () => {
  // 断言库里那个外部路径的 park_reason 未变
})
```

- [ ] **Step 3.9: skill 教二分判据 + 四条反例**

`src/agent/skills/identifyMediaSkill.ts` 的「No candidate passes」一节改写，加入分类判据。**四条反例必须在文里**（Spec 2 §3 的最大风险就是模型把"我没查到"当"证据不足"）：

```
## No candidate passes

Install nothing, put every target into `no_safe_match`, and name the identification problem in
your reason. Guessing an identity is strictly worse than admitting you could not establish one.

Then classify WHY, because the two cases have different consequences:

- `insufficient-evidence` — the path itself carries no usable identifying information. The
  directory names and file name contain no title, only technical tokens, or a name so generic it
  identifies nothing (`1.mp4` under `/movies/random/`). Re-running would see the same empty
  evidence and reach the same conclusion, so the file waits for a human to rename it.
- `identification-failed` — you had real evidence to work with but could not confirm an identity
  against it. A later attempt may succeed.

Only the first case means "no information exists." These are NOT insufficient evidence:

- TMDB has no entry for a title you cleaned successfully — evidence existed, the database lacked
  the work. It may be added later.
- You could not find the right entry, but the path does carry a plausible title.
- A network or TMDB error interrupted you (that belongs in `retry_later`, not here).
- One target's episode number is out of range while the show itself is identified — that is not
  an identification failure at all; write the identity and report only that target.

When unsure which case applies, choose `identification-failed`. Claiming "no information exists"
when it does would strand a file that could have been identified on a later run.
```

测试锚点（`identifyMediaSkill.test.ts`）：

```ts
it('二分判据 + 四条反例（Spec 2 的最大风险点）', ({ expect }) => {
  expect(skill.content).toMatch(/insufficient-evidence/)
  expect(skill.content).toMatch(/identification-failed/)
  expect(skill.content).toMatch(/no usable identifying information/i)
  expect(skill.content).toMatch(/1\.mp4/)
  // 四条反例必须在
  expect(skill.content).toMatch(/TMDB has no entry/i)
  expect(skill.content).toMatch(/network or TMDB error/i)
  expect(skill.content).toMatch(/episode number is out of range/i)
  // 不确定时偏向重试
  expect(skill.content).toMatch(/When unsure which case applies, choose `identification-failed`/)
})
```

- [ ] **Step 3.10: 跑全量 + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 0 errors；全绿。

- [ ] **Step 3.11: 提交**

```bash
git add -A
git commit -m "feat(agent): park 原因二分落地（回写 + skill 判据 + 四条反例）

收割时把 agent 的分类回写 parked_paths：用 updateParkReason 而非
upsertParkedPath——后者在 reason 变化时重置退避到 1h 档，会让
identification-failed 的阶梯每轮归零永远停在 1h。

skill 给出四条反例（TMDB 无条目/没找到但有标题/网络错误/单集越界），
因为最大风险是模型把'我没查到'当'证据不足'从而永久钉死可自愈的文件。
不确定时明确要求选 identification-failed。"
```

---

## Task 4: 部署 + 挂载 + 迁移（Spec 1 §3.1-3.2 + Spec 5 §2）

**这一步开始碰生产。每个子步骤都要先验证再前进。**

- [ ] **Step 4.1: 部署代码**

```bash
DEPLOY_SSH_HOST=media-router ./deploy/deploy.sh
```
Expected: 结尾打印 `revision=<HEAD sha>` 且 `docker compose ps` 显示 running。

- [ ] **Step 4.2: 验证 schema 16→25→26 迁移**

```bash
ssh media-router 'docker exec subtitle-scout node -e "
const D=require(\"better-sqlite3\");const d=new D(\"/cache/scout.db\",{readonly:true});
console.log(\"schema\", d.prepare(\"select value from meta where key=?\").get(\"schema_version\")?.value);
console.log(d.prepare(\"select sql from sqlite_master where name=?\").get(\"parked_paths\").sql);
"'
```
Expected: `schema 26`，且 `parked_paths` DDL 含 `duration_sec`、`embedded_langs`、`embedded_tmdb_id`。
**若迁移失败**：库会停在旧版本且整体回滚（`db.ts` 的事务语义）。读容器日志找 FK 违例详情，不要猜。

- [ ] **Step 4.3: 提高日志上限（夜跑前必须做）**

ssh 手工编辑 `/mnt/nvme0n1-4/docker/subtitle-scout/docker-compose.yml`，把 `subtitle-scout` 服务的 logging 改为 `max-size: "100m"`、`max-file: "5"`（用户批准：软路由还有 200G）。

**注意 compose 由软路由持有且被 deploy.sh 保护**，改完不要再跑部署脚本覆盖思路——直接 `docker compose up -d subtitle-scout` 生效。

- [ ] **Step 4.4: 建云盘 WebDAV 挂载**

按 Spec 1 §3.1 的 remote 配置与挂载命令。**凭据不要放 tmpfs**（davfs2 那个挂载正是因此在重启后失效——本机 38 分钟前刚重启过，已实证）。

验证：
```bash
ssh media-router 'ls /mnt/aliyun-webdav/ && ls "/mnt/aliyun-webdav/Anime/"'
```
Expected: 列出 Anime/Movie/TV；Anime 下有 `莉可丽丝 蓝光原盘REMUX [内封简日双字]`。

- [ ] **Step 4.5: 验证挂载重启存活**

```bash
ssh media-router 'reboot' ; sleep 90 ; ssh media-router 'mount | grep aliyun-webdav && ls /mnt/aliyun-webdav/'
```
Expected: 挂载仍在、能列目录。**这一步不能跳**——Spec 1 §3.1 明确要求实测一次重启存活。

- [ ] **Step 4.6: 加 compose 卷并验证容器内可见**

ssh 手工加 `- /mnt/aliyun-webdav:/media/aliyun:ro` 到 `subtitle-scout` 的 volumes，然后 `docker compose up -d subtitle-scout`。

```bash
ssh media-router 'docker exec subtitle-scout ls /media/ && docker exec subtitle-scout sh -c "ls /media/aliyun/"'
```
Expected: `/media` 下有 movies/tv/anime/aliyun 四项。

- [ ] **Step 4.7: 容器内实测云盘探针正确性**

```bash
ssh media-router 'docker exec subtitle-scout ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "/media/aliyun/Anime/莉可丽丝 蓝光原盘REMUX [内封简日双字]/第1集/Lycoris.Recoil.S01E01.2022.1080p.BluRay.REMUX.AVC.DTS-HD.MA.LPCM.2.0.mkv"'
```
Expected: **1442.048 附近**（24.03 分钟 = 莉可丽丝真实片长）。这是"云盘等同物理 NAS"的地基验证。
**若为空或报错**：停下来查，不要继续——后面所有云盘识别都建立在这条之上。

---

## Task 5: Spec 5 阶段一 —— 73 视频最小闭环

- [ ] **Step 5.1: 删字幕（备份已校验：1893 in / 1893 on disk）**

范围：NAS `anime` 4 目录（25 个）+ 云盘正常位置（1 个）。**`.archive/` 内 26 个保留**（用户裁决，留作对照）。

**执行前先 SELECT 出清单人工过目**（Spec 5 §8 的风险缓解），再删：
```bash
ssh media-router 'find /mnt/nvme0n1-4/nas_media/anime -type f \( -name "*.srt" -o -name "*.ass" -o -name "*.ssa" \) | tee /tmp/to-delete-nas.txt | wc -l'
ssh media-router 'find /mnt/aliyun-webdav -type f \( -name "*.srt" -o -name "*.ass" -o -name "*.ssa" \) | grep -v "/.archive/" | tee /tmp/to-delete-cloud.txt | wc -l'
```
过目后删除。

- [ ] **Step 5.2: 清这 73 个路径对应的库行**

**只清 anime + aliyun 前缀**。`TV`/`Movies` 的 28 剧 9 影不动（用户裁决：全量等他休息时）。

先 SELECT 出待删清单过目，再 DELETE。注意外键顺序：`subtitles`/`item_files` → `episodes`/`movies` → `series`（孤儿 series 行）。

- [ ] **Step 5.3: 触发巡检，验证 park 与 raw 数据**

```bash
ssh media-router 'docker exec subtitle-scout node -e "
const D=require(\"better-sqlite3\");const d=new D(\"/cache/scout.db\",{readonly:true});
const rows=d.prepare(\"select path,park_reason,duration_sec,embedded_langs,embedded_tmdb_id from parked_paths\").all();
console.log(\"parked:\", rows.length);
console.log(\"无时长:\", rows.filter(r=>r.duration_sec==null).length);
console.log(rows.slice(0,5));
"'
```
Expected: 73 行（或接近，取决于 extras 排除）；**云盘文件的 `duration_sec` 非空**。

- [ ] **Step 5.4: 触发识别 + 人工核对**

通过 dashboard 或 orchestrator 派发。核对 Spec 5 §6.2 的硬门：5 个污染命名 + anime 4 部的 tmdbId **逐个人工核对**，不依赖 agent 自述。

已知 ground truth（2026-07-26/27 核验过）：莉可丽丝 tv 154494（S01=13ep, 24min）；后室 movie 1083381；招魂4/Last Rites movie 1038392（136min）；招魂 movie 138843（2013, 112min）；铁拳教育 tv 276161（S01=10ep, 70min）。

- [ ] **Step 5.5: 记录结果，修 bug，再进阶段二**

若有 bug：**先查证据（trace/日志/库状态），查不出就调研，绝不靠猜改代码试**。一轮 agent 几十秒，猜测式调试最贵。

---

## Task 6: Spec 5 阶段二 —— 全量夜跑（用户明示休息时启动）

- [ ] **Step 6.1: 前置检查**
  - Task 1/2/3 全部落地且全量测试绿
  - Task 5 阶段一跑通且 bug 已修
  - 日志上限已提到 100m（Step 4.3）
  - 做一次 10 分钟冒烟，确认无系统性问题再放通宵

- [ ] **Step 6.2: 删全量字幕（1893 个，备份已校验）+ 清全量库行**

- [ ] **Step 6.3: 启动全量巡检 + 识别，落盘一份独立日志**

不依赖 docker 日志轮转，另存一份到文件，便于次日翻查前半夜。

- [ ] **Step 6.4: 次日验收（Spec 5 §6.2 全部判据）**

---

## Task 7: Spec 6 —— eve 识别能力矩阵（夜跑期间并行，不碰生产）

见 `docs/superpowers/specs/2026-07-27-spec6-eve-identification-matrix.md`。

- [ ] **Step 7.1: 起子代理调研 vague 命名特例**

**必须要求它边查边增量写入** `docs/superpowers/research/2026-07-27-vague-naming-cases.md`（用户纪律：公司主站 API 会断线，调研类子代理断了成果全失；增量写文件可判断进度并接续）。

- [ ] **Step 7.2: `npx eve@latest init` 独立目录，读包内自带文档**

`node_modules/eve/docs` 有完整文档（README 明说给 coding agent 读）。**不要信网上二手 API**——已发现博客的 `defineSkill`/`skills: [...]` 写法与官方 `agent/skills/*.md` + `agent/tools/*.ts` 文件系统约定不一致。

- [ ] **Step 7.3: skill 从 `identifyMediaSkill.ts` 生成 + 一致性检查**

不手抄（会漂移，漂移则结论不适用于产品）。不一致则实验台拒绝启动。

- [ ] **Step 7.4: 系统提示只说"代替机械刮削"，不提字幕**

grep 断言无字幕/库字样。这是用户的洞察：测纯识别任务下的**诚实度**。

- [ ] **Step 7.5: 跑矩阵（C1-C10 × D1-D6 关键档位），产出最小必要条件报告**

C9（`1.mp4`）的**幻觉率必须为 0** —— 硬门。若非零，Spec 2 的分类设计不可信，走 §6 回退方案。

- [ ] **Step 7.6: 结论回填 Spec 2 的判据章节**

---

## Task 8: Spec 3 —— 废认领 + 认领点 UI（代码今晚写，**部署留到明早**）

**为什么部署延后：** 部署会重启容器、打断夜跑；且这是破坏性删表迁移。用户已批准此排期。

见 `docs/superpowers/specs/2026-07-27-spec3-retire-claim-keep-triage.md`。要点：

- 删 `claimParked`/`unclaim`/`addOverride`/`findOverride`/`removeOverride`/`identify_overrides` 表/`recognize()` 的 override 分支/`recognize()` 遗留的 `tmdb` 参数
- **保留 `unexclude`**（性质不同：不指定身份，只把文件放回识别队列，身份仍由 agent 凭证据裁决）
- **保留富化重试机制**（它还在治 `genres` 回填这个正交缺口），只在文档记明"空名"那半适用面已归零
- 认领点 UI：park 原因人话 + 缺什么证据 + 建议改成什么名（可复制）+ 已知元数据；**无置信度**
- "重新触发"按钮必须诚实说明：未改名 + `insufficient-evidence` → 不入队、零消耗
- 删表前先导出现存 4 条认领内容记录在案

---

## Self-Review 记录

**Spec 覆盖检查：**
- Spec 1 → Task 1（并发）+ Task 4.3-4.7（挂载/卷/验证）✅
- Spec 2 → Task 3 全部 ✅
- Spec 3 → Task 8 ✅（代码今晚，部署明早，用户已批准）
- Spec 4 → Task 2 ✅（含删死代码，删前 grep 验证）
- Spec 5 → Task 5（阶段一）+ Task 6（阶段二）✅
- Spec 6 → Task 7 ✅

**类型/命名一致性：** `PARK_REASON` 常量在 Task 3.6 定义，Task 3.8 与 Task 8 复用同名；`embeddedTmdbId`（camelCase，TS 侧）↔ `embedded_tmdb_id`（snake_case，DB 侧）在 Task 2 全程一致；`mapWithConcurrency` 在 Task 1.4 定义、1.7 使用。

**发现并已写进计划的关键交互（自审收获）：**
1. `upsertParkedPath` 在 reason 变化时重置退避到 1h 档 → 回写必须用 `updateParkReason`（Task 3.8 约束②）。若用错，`identification-failed` 的退避阶梯会每轮归零、永远停在 1h。
2. `shouldRetryParkedPath` 现有 SELECT 未取 `park_reason`，加指纹门时要一并加（Task 3.6）。
3. 指纹门优先级必须低于指纹变化，否则用户动了文件也不重试（Task 3.6 测试第 2 条锁死）。
4. `rawEvidence.ts` 删除前必须 grep 验证零调用者（Task 2.1），用户嘱"别伤筋动骨"。
