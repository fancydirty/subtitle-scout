# 胶水层修复 + 全仓语义考古 + 债务清算 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 铁律（本仓库既有纪律，覆盖默认）：不用 Workflow 工具；不用 worktree；实现子代理用 sonnet、主控逐 diff 亲自复核；`src/agent/skills/*` 只许主控亲手改，任何子代理不得触碰；`src/v2/realignExecutor.ts` 五重安全层神圣不可侵犯，本战役零改动。

**Goal:** 主代理季级意图端到端存活——处决 `representativeEpisodeId()` 机械降解点，FindSubtitleTask 改为批量事实清单，worker 一轮 run 收割整季；先全仓考古确认没有其他旧世界残魂，再修复，再清三件债务。

**Architecture:** spec 见 `docs/design/2026-07-16-glue-layer-repair-and-semantic-audit-design.md`。执行顺序（用户令）：第二部分考古 → 第一部分胶水层修复 → 第三部分债务三件 → R1/R2 收官纪律 → 真站闸门。阶段〇的裁决可以修订阶段一/二的任务细节（考古先行的全部意义就在这里）。

**Tech Stack:** TypeScript (Node 22, ESM), better-sqlite3, zod + ai-sdk ToolLoopAgent（finalize-tool 模式）, vitest。测试命令一律 `npx vitest run <file>`；全量 `npx tsc --noEmit && npx vitest run`。

---

## 阶段〇 · 全仓语义考古（spec 第二部分，先行）

产出物：`docs/design/2026-07-16-old-world-lineage-registry.md`（R3 造册 + 逐项裁决表）。本阶段无生产代码改动。

### Task 0.1: R3 血统申报机械横扫（子代理，sonnet 可）

**Files:**
- Create: `docs/design/2026-07-16-old-world-lineage-registry.md`

- [ ] **Step 1: 派一个子代理做机械横扫**，prompt 要点：
  - 在仓库根跑 `grep -rn "旧管线\|old pipeline\|同 executor\|抄自\|remainingTargets\|旧逻辑\|历史行为\|沿用历史" src/ --include="*.ts" | grep -v ".test.ts"`（测试文件另列一节，不混入生产清单）。
  - 每条命中登记：`文件:行号 | 注释原文（截断到一行）| 它守护的代码在做什么（读上下文 20 行总结）`。
  - 输出 markdown 表格，按文件分组。不做任何裁决——只造册。
- [ ] **Step 2: 主控把造册写入 registry 文档骨架**（裁决列留空待 Task 0.3），提交：

```bash
git add docs/design/2026-07-16-old-world-lineage-registry.md
git commit -m "docs(考古): R3 血统申报首次全仓造册（裁决待 0.3）"
```

### Task 0.2: 架构灵魂审计官 ×3（子代理，模型继承主控，整个项目范围）

- [ ] **Step 1: 并行派 3 个对抗人格审计子代理**。共同人格设定（每个 prompt 都带）：

> 你是"架构灵魂审计官"。你的输入是北极星清单（下附）与 spec `docs/design/2026-07-16-glue-layer-repair-and-semantic-audit-design.md`。你的任务不是审"这个改动对不对"，而是审"这个系统整体还符合它存在的理由吗"。你是对抗人格：假设代码里藏着"活着但灵魂是旧的"逻辑，你的职责是把它揪出来，而不是为现状辩护。已知事故样本（供校准嗅觉）：`findSubtitleWorkerTask.ts` 的 `representativeEpisodeId()` 有引用、有测试、gates 全绿，却把主代理的季级意图机械降解成单集指令——引用考古发现不了它，只有语义质询能。可用 serena MCP 符号级工具（先 `activate_project` 到本仓库，然后 `find_referencing_symbols`/`find_symbol`/`get_symbols_overview`）做语义遍历，勿只靠 grep。北极星清单：①agent 像人判断不敲计算器，确定性检查绝不当守门人（事实盘点除外）；②主代理=胶水层/理性中介，其意图必须原样抵达执行者；③子代理粒度=季/批，合集包是最高效命中；④机械层只产事实永不产指令；⑤拿不准就停车，错认比停车糟；⑥零误触发。发现输出格式：`{file:line, 嫌疑描述, 证据（引用代码/注释）, 违反北极星第几条, 建议裁决(处决/改造/哲学豁免)+理由}`。没有发现也要明说"此区域已质询、无发现"，列出你质询过的符号清单。

  分工（各自 prompt 附加）：
  - **审计官 A（队列与执行缝）**：`src/v2/` 全部——jobsRepo 的 attempt/error_attempt/next_retry_at 双轨退避梯（谁在决定"放弃"？agent 还是系统？dormant 是判决还是事实？）、executor.ts 存留部分、findSubtitleWorkerTask/realignWorkerTask、daemon 派发循环、legacyJobRouting。spec 嫌疑 #1/#3 归你。
  - **审计官 B（agent 工具面与技能）**：`src/agent/` 全部——orchestratorAgent.tools 是否有"替 agent 做了判断"的隐藏过滤/排序/截断、resultHandles 分页语义、coerce 容错边界、playbooks/skills 文本里是否残留旧世界预设、findSubtitleWorker 工具面。spec 嫌疑 #6 归你。
  - **审计官 C（摄取/识别/整理/CLI）**：`src/recognition/ src/daemon/ src/files/ src/cli/ src/adapters/ src/core/`——`sub_status='unavailable'+recheck_after` 退避梯作为事实层退避是否哲学兼容还是变相确定性守门（spec 嫌疑 #2 归你）、realign 触发链的信号死活（嫌疑 #5，已知 exceedsSeasonTable 近死）、ingest 的 park/override 消歧是否有越权判断。
- [ ] **Step 2: 主控逐条复核三份报告**——每个发现亲自打开现场代码验证，剔除误报。

### Task 0.3: 主控汇总裁决（checkpoint，闸门）

- [ ] **Step 1: 裁决表落入 registry 文档**：每条 R3 造册项 + 每条审计发现 → 处决（列入本战役任务）/ 改造（列入本战役或立项）/ 哲学豁免（写明理由，豁免理由必须援引北极星条款而非"改起来麻烦"）。
- [ ] **Step 2: 依裁决修订本计划阶段一/二任务**（尤其嫌疑 #2/#3 的退避梯裁决直接影响 Task 8 的队列语义代码——下面写的是 spec 默认语义，裁决若推翻以裁决为准，修订须写回本文件）。
- [ ] **Step 3: 提交**：

```bash
git add docs/design/2026-07-16-old-world-lineage-registry.md docs/superpowers/plans/2026-07-16-glue-layer-repair-campaign.md
git commit -m "docs(考古): 残余清单逐项裁决 + 计划修订（阶段〇收官）"
```

---

## 阶段一 · 胶水层修复 + 批量收割（spec 第一部分）

### Task 1: 批量任务形状与批量报告 schema

**Files:**
- Modify: `src/agent/coerce.ts`（新增 tolerantArray）
- Modify: `src/agent/findSubtitleWorker.schemas.ts`（全量换形）
- Test: `src/agent/coerce.test.ts`, `src/agent/findSubtitleWorker.schemas.test.ts`

- [ ] **Step 1: 写失败测试**（schemas.test.ts 追加；旧 FindSubtitleDecisionSchema 的测试将在 Step 3 删除）：

```ts
import { FindSubtitleBatchReportSchema } from './findSubtitleWorker.schemas.js'

describe('FindSubtitleBatchReportSchema', () => {
  it('接受三桶批量报告', () => {
    const r = FindSubtitleBatchReportSchema.parse({
      installed: [{ itemId: 'tmdb:1/s1e1', installedPath: '/m/a.zh-Hans.srt', installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok' }],
      no_safe_match: [{ itemId: 'tmdb:1/s1e2', reason: 'no entry in any pack' }],
      retry_later: [],
    })
    expect(r.installed).toHaveLength(1)
  })
  it('真模型哨兵容错：缺桶/None/null 一律折叠为空数组', () => {
    const r = FindSubtitleBatchReportSchema.parse({ installed: 'None', no_safe_match: null } as unknown)
    expect(r.installed).toEqual([])
    expect(r.no_safe_match).toEqual([])
    expect(r.retry_later).toEqual([])
  })
  it('installed 项的 installedPath 必须非空（覆盖入账不许无路径）', () => {
    expect(() => FindSubtitleBatchReportSchema.parse({
      installed: [{ itemId: 'x', installedPath: '', reason: 'r' }], no_safe_match: [], retry_later: [],
    })).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run src/agent/findSubtitleWorker.schemas.test.ts` → FAIL（FindSubtitleBatchReportSchema 未导出）
- [ ] **Step 3: 实现**。coerce.ts 追加：

```ts
/** 批量 finalize 的桶容错（同 nullableTolerant 的动机）：真模型对空桶会省略键或串编码
 *  "None"/"null"/""——一律折叠为 []，绝不让空桶哨兵炸掉整份报告的入账。 */
export const tolerantArray = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess(
    (v) => (v === undefined || v === null || v === 'None' || v === 'null' || v === '' ? [] : v),
    z.array(item),
  )
```

schemas.ts 全量换形（删除 FindSubtitleDecisionSchema/FindSubtitleDecision 与旧 FindSubtitleTask 单集字段；文件头注释更新为批量语义——引用 spec 第一部分第 1/3 条）：

```ts
import { z } from 'zod'
import { nullableTolerant, tolerantArray } from './coerce.js'

/** 一个缺口目标的事实行（机械预清洗产物，作为事实呈现，不作为指令）。itemId 是 own id
 *  空间的 episodes.id/movies.id——信使原样携带，收割入账按它 markCovered/markUnavailable。 */
export interface FindSubtitleTargetFact {
  itemId: string
  videoPath: string
  videoFilename: string
  season: number | null
  episode: number | null
  /** 系统算出的全剧绝对集号（定位 hint，非归属证明）；movie/算不出为 null。 */
  absoluteEpisode: number | null
}

/** 一次 find-subtitle worker run 的输入：季级（或单 movie）范围 + 当前缺口事实清单。
 *  胶水层修复（2026-07-16 事故）：单集字段废除，worker 一轮 run 吃掉清单内全部可完成目标。 */
export interface FindSubtitleTask {
  jobId: string
  /** 本任务的 INNER 沙盒根：全部 targets 路径的公共祖先目录（mapper 推导并已验证在
   *  MEDIA_ROOTS 内）。 */
  mediaRoot: string
  title: string
  originalTitle: string | null
  year: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
  targetLanguage: string
  /** ≥1。排序是清单排序（episode 升序），不是执行顺序指令。 */
  targets: FindSubtitleTargetFact[]
}

export const FindSubtitleInstalledItemSchema = z.object({
  itemId: z.string().min(1),
  installedPath: z.string().min(1),
  installedLanguage: nullableTolerant(z.string().min(1)),
  candidateProvider: nullableTolerant(z.string()),
  candidateProviderId: nullableTolerant(z.string()),
  reason: z.string().min(1),
})
export const FindSubtitleUnresolvedItemSchema = z.object({
  itemId: z.string().min(1),
  reason: z.string().min(1),
})

/** 批量收割报告（finalize 工具的 inputSchema）：worker 对清单内每个目标逐集验证归属、
 *  逐集安装；单集拿不准跳过该集不弃整包。retry_later=瞬时故障需重试的目标（本季剩余部分），
 *  no_safe_match=真穷尽后判无。北极星不变量：无 confidence 分数，decision+plain reason。 */
export const FindSubtitleBatchReportSchema = z.object({
  installed: tolerantArray(FindSubtitleInstalledItemSchema),
  no_safe_match: tolerantArray(FindSubtitleUnresolvedItemSchema),
  retry_later: tolerantArray(FindSubtitleUnresolvedItemSchema),
})
export type FindSubtitleBatchReport = z.infer<typeof FindSubtitleBatchReportSchema>
export type FindSubtitleInstalledItem = z.infer<typeof FindSubtitleInstalledItemSchema>
```

- [ ] **Step 4: 跑测试**：`npx vitest run src/agent/findSubtitleWorker.schemas.test.ts src/agent/coerce.test.ts` → 新增 PASS。此刻 `npx tsc --noEmit` 预期大面积红（消费者未跟进）——这是本任务的已知中间态，Task 2-8 逐步收绿，阶段一收官前必须全绿。
- [ ] **Step 5: 提交**：`git commit -m "feat(胶水层): 批量任务形状 + 批量收割报告 schema（旧单集 decision 处决开始）"`

### Task 2: absoluteEpisodes 抽取 resolveAbsoluteTable（取表一次，逐集查询）

**Files:**
- Modify: `src/agent/absoluteEpisodes.ts`
- Test: `src/agent/absoluteEpisodes.test.ts`

- [ ] **Step 1: 写失败测试**：

```ts
it('resolveAbsoluteTable: 官方分组优先，季表兜底，两路独立 try/catch', async () => {
  const src = {
    getAbsoluteOrder: async () => { throw new Error('flaky') },
    getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 2 }, { seasonNumber: 2, episodeCount: 3 }],
  }
  const table = await resolveAbsoluteTable(src, '42')
  expect(table).not.toBeNull()
  expect(absoluteFor(table!, 2, 1)).toBe(3)
})
```

- [ ] **Step 2: 确认失败**：`npx vitest run src/agent/absoluteEpisodes.test.ts` → FAIL（未导出）
- [ ] **Step 3: 实现**——把 resolveAbsoluteEpisode / seasonEpisodeForAbsolute 共有的"官方分组优先（独立 try/catch）→ 季表 concat 兜底（独立 try/catch）"数据源纪律原样抽出，两个既有函数改为调用它（行为零变化，既有测试是锁）：

```ts
/** 数据源纪律的唯一实现（FALLBACK-DENIAL 注释语义原样保留）：官方 Absolute 分组优先，
 *  瞬时抛错绝不连坐季表兜底。批量 mapper（胶水层修复）用它取表一次、逐集 absoluteFor，
 *  替代逐集调 resolveAbsoluteEpisode 造成的 2N 次 TMDB 往返。 */
export async function resolveAbsoluteTable(
  src: AbsoluteOrderSource, tvId: string,
): Promise<AbsoluteEpisodeTable | null> {
  let official: { season: number; episode: number }[] | null = null
  try { official = await src.getAbsoluteOrder(tvId) } catch { official = null }
  if (official && official.length > 0) return buildFromAbsoluteOrder(official)
  try {
    const seasons = await src.getSeasonTable(tvId)
    if (!seasons) return null
    return buildFromSeasonConcat(seasons)
  } catch { return null }
}

export async function resolveAbsoluteEpisode(
  season: number | null, episode: number | null, src: AbsoluteOrderSource, tvId = '',
): Promise<number | null> {
  if (season == null || episode == null) return null
  const table = await resolveAbsoluteTable(src, tvId)
  return table ? absoluteFor(table, season, episode) : null
}

export async function seasonEpisodeForAbsolute(
  absolute: number, src: AbsoluteOrderSource, tvId: string,
): Promise<{ season: number; episode: number } | null> {
  const table = await resolveAbsoluteTable(src, tvId)
  return table ? seasonEpisodeFor(table, absolute) : null
}
```

- [ ] **Step 4: 跑测试**：`npx vitest run src/agent/absoluteEpisodes.test.ts` → 全 PASS（含既有锁测试）
- [ ] **Step 5: 提交**：`git commit -m "refactor(胶水层): 抽取 resolveAbsoluteTable——批量映射取表一次逐集查询"`

### Task 3: LibraryRepo.listMissingEpisodesInSeason（事实清单）

**Files:**
- Modify: `src/v2/libraryRepo.ts`（missingBySeason 附近）
- Test: `src/v2/libraryRepo.test.ts`

- [ ] **Step 1: 写失败测试**（用该测试文件既有的建库/插行 helper 风格）：

```ts
it('listMissingEpisodesInSeason: 返回全部缺口事实行（missing ∪ 到期 unavailable），episode 升序', () => {
  // 建 3 集：e1 missing, e2 covered, e3 unavailable 且 recheck_after 已到期
  // （插行方式沿用本文件既有 upsertEpisode helper）
  const rows = lib.listMissingEpisodesInSeason('tmdb:7', 1, NOW)
  expect(rows.map(r => r.episode)).toEqual([1, 3])
  expect(rows[0]).toMatchObject({ id: 'tmdb:7/s1e1', season: 1 })
  expect(typeof rows[0].path).toBe('string')
})
it('listMissingEpisodesInSeason: 未到期 unavailable 不算缺口', () => {
  const rows = lib.listMissingEpisodesInSeason('tmdb:7', 1, NOW_BEFORE_RECHECK)
  expect(rows.map(r => r.episode)).toEqual([1])
})
```

- [ ] **Step 2: 确认失败** → FAIL（方法不存在）
- [ ] **Step 3: 实现**（谓词与 missingBySeason 逐字一致，只是展开到集级——这是"机械层只产事实清单"的落点，representativeEpisodeId 的 LIMIT 1 死于此处）：

```ts
export interface MissingEpisodeFact { id: string; path: string; season: number; episode: number }

/** 胶水层修复（2026-07-16）：某剧某季当前全部缺口的事实清单。机械预清洗产物，呈事实不做
 *  选择——ORDER BY episode 是清单排序，不是执行顺序指令（顺序决策归 worker/orchestrator）。
 *  谓词与 missingBySeason 完全一致。 */
listMissingEpisodesInSeason(seriesId: string, season: number, now: number): MissingEpisodeFact[] {
  return this.db
    .prepare(
      `SELECT id, path, season, episode FROM episodes
       WHERE series_id = ? AND season = ?
       AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))
       ORDER BY episode ASC`
    )
    .all(seriesId, season, now) as MissingEpisodeFact[]
}
```

- [ ] **Step 4: 跑测试** → PASS；**Step 5: 提交** `git commit -m "feat(胶水层): 季级缺口事实清单 listMissingEpisodesInSeason"`

### Task 4: mapper 处决与降级（representativeEpisodeId 之死）

**Files:**
- Modify: `src/v2/findSubtitleWorkerTask.ts`（mapWorkerTaskToFindSubtitleTask 全量重写；representativeEpisodeId/representativeMovieId 删除）
- Test: `src/v2/findSubtitleWorkerTask.test.ts`（映射部分重写）

- [ ] **Step 1: 写失败测试**（核心断言——意图存活）:

```ts
it('季级 job 映射为携带全部缺口的批量任务（不是一集）', async () => {
  // 库内 tmdb:9 S1 共 5 集：e1/e3/e5 missing，e2 covered，e4 unavailable 未到期
  const task = await mapWorkerTaskToFindSubtitleTask(job /* series_id='tmdb:9', season=1 */, deps, NOW)
  expect(task!.targets.map(t => t.episode)).toEqual([1, 3, 5])
  expect(task!.targets.map(t => t.itemId)).toEqual(['tmdb:9/s1e1', 'tmdb:9/s1e3', 'tmdb:9/s1e5'])
})
it('绝对集号一次取表逐集折算（TMDB 只打一轮，不是每集两次）', async () => {
  const spy = vi.fn(async () => [{ seasonNumber: 1, episodeCount: 12 }, { seasonNumber: 2, episodeCount: 12 }])
  // deps.tmdb.getSeasonTable = spy; getAbsoluteOrder → null
  const task = await mapWorkerTaskToFindSubtitleTask(seasonTwoJob, deps, NOW)
  expect(task!.targets[0].absoluteEpisode).toBe(13)
  expect(spy).toHaveBeenCalledTimes(1)
})
it('mediaRoot=全部目标的公共祖先目录', async () => {
  // e1 path=/media/Show (2020) [tmdbid-9]/Season 01/a.mkv, e3 同目录
  expect(task!.mediaRoot).toBe('/media/Show (2020) [tmdbid-9]/Season 01')
})
it('movie job 映射为单目标批量任务', async () => {
  expect(movieTask!.targets).toHaveLength(1)
  expect(movieTask!.targets[0]).toMatchObject({ itemId: 'tmdb:555', season: null, episode: null })
})
it('全部已覆盖 → null（幂等 no-op 语义保留）', async () => { ... expect(mapped).toBeNull() })
it('目标目录在 MEDIA_ROOTS 之外 → throw（沙盒外层边界保留）', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**。删除 representativeEpisodeId/representativeMovieId/MappedFindSubtitleTask（返回值直接是 `FindSubtitleTask | null`——itemId 已入 targets，信使不再另携密）。新映射主体：

```ts
/** 全部目标目录的公共祖先（INNER 沙盒根推导）。目录相等视为 under（isUnderRoots 既有语义）。 */
function commonDir(dirs: string[]): string {
  let candidate = dirs[0]
  while (!dirs.every((d) => isUnderRoots(d, [candidate]))) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return candidate
}

export async function mapWorkerTaskToFindSubtitleTask(
  job: Job, deps: FindSubtitleTaskMapperDeps, now: number,
): Promise<FindSubtitleTask | null> {
  // ---- movie 分支：单目标批量任务 ----
  if (job.movie_id) {
    const movie = deps.lib.getMovie(job.movie_id)
    if (!movie) return null
    const stillMissing =
      movie.sub_status === 'missing' || (movie.sub_status === 'unavailable' && (movie.recheck_after ?? 0) <= now)
    if (!stillMissing) return null
    const dir = dirname(movie.path)
    assertDirSafe(dir, deps.mediaRoots)   // 抽出的既有 isUnderRoots+isDirWritable 两连检
    const tmdbId = tmdbIdFromOwnId(movie.id)
    const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'movie', tmdbId)
    const originalTitle = details?.originalTitle ?? null
    return {
      jobId: String(job.id), mediaRoot: dir,
      title: movie.name, originalTitle,
      year: movie.year ?? details?.year ?? null,
      alternativeTitles: buildAlternativeTitles(chineseTitles, movie.chinese_title, movie.name, originalTitle),
      overview: details?.overview ?? null, runtimeMinutes: details?.runtimeMinutes ?? null,
      providerIds: parseProviderIds(movie.provider_ids),
      targetLanguage: deps.targetLanguage ?? 'zh',
      targets: [{
        itemId: movie.id, videoPath: movie.path, videoFilename: basename(movie.path),
        season: null, episode: null, absoluteEpisode: null,
      }],
    }
  }

  // ---- series+season 分支：事实清单整批上车 ----
  if (!job.series_id || job.season === null) {
    throw new Error(`worker_task job ${job.id} (find_subtitle) has neither movie_id nor series_id+season identity`)
  }
  const gaps = deps.lib.listMissingEpisodesInSeason(job.series_id, job.season, now)
  if (gaps.length === 0) return null   // 幂等 no-op：claim 时已无缺口
  const series = deps.lib.getSeries(job.series_id)
  if (!series) throw new Error(`series row ${job.series_id} not found for job ${job.id}`)

  const dirs = gaps.map((g) => dirname(g.path))
  for (const dir of dirs) assertDirSafe(dir, deps.mediaRoots)
  const mediaRoot = commonDir(dirs)
  if (!isUnderRoots(mediaRoot, deps.mediaRoots)) {
    throw new Error(`拒绝在媒体根目录之外写入: ${mediaRoot} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`)
  }

  const tmdbId = tmdbIdFromOwnId(series.id)
  const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'tv', tmdbId)
  const originalTitle = details?.originalTitle ?? null
  // 取表一次，逐集折算（Task 2 的 resolveAbsoluteTable）；取不到表 → 全部 null（hint 缺席不是 blocker）
  const absTable = deps.tmdb && tmdbId ? await resolveAbsoluteTable(deps.tmdb, tmdbId) : null

  return {
    jobId: String(job.id), mediaRoot,
    title: series.name, originalTitle,
    year: series.year ?? details?.year ?? null,
    alternativeTitles: buildAlternativeTitles(chineseTitles, series.chinese_title, series.name, originalTitle),
    overview: details?.overview ?? null, runtimeMinutes: details?.runtimeMinutes ?? null,
    providerIds: parseProviderIds(series.provider_ids),
    targetLanguage: deps.targetLanguage ?? 'zh',
    targets: gaps.map((g) => ({
      itemId: g.id, videoPath: g.path, videoFilename: basename(g.path),
      season: g.season, episode: g.episode,
      absoluteEpisode: absTable ? absoluteFor(absTable, g.season, g.episode) : null,
    })),
  }
}
```

  import 更新：`resolveAbsoluteTable, absoluteFor` 自 `../agent/absoluteEpisodes.js`；`FindSubtitleTaskMapperDeps.lib` 的 Pick 加 `listMissingEpisodesInSeason`。`assertDirSafe(dir, roots)` = 现有 isUnderRoots/isDirWritable 两连 throw 抽成模块内私有函数（两分支共用）。文件头注释更新：明写"2026-07-16 事故修复——mapper 是纯信使，零目标选择、零顺序决策"。
- [ ] **Step 4: 跑测试**：`npx vitest run src/v2/findSubtitleWorkerTask.test.ts` → 映射部分 PASS（收割部分 Task 8 前允许暂红——若红，在本 Task 内先把旧收割测试标 `.todo` 并注明 Task 8 复活，不许静默删除）
- [ ] **Step 5: 提交**：`git commit -m "feat(胶水层): mapper 降级纯信使——representativeEpisodeId 处决，事实清单整批上车"`

### Task 5: worker 工具逐目标化（download/install 认目标）+ zip 清单事实（裁决 R-5）

**Files:**
- Modify: `src/agent/findSubtitleWorker.tools.ts`
- Modify: `src/files/subtitleWriter.ts`（pickFromZip 升级）
- Test: `src/agent/findSubtitleWorker.tools.test.ts`, `src/files/subtitleWriter.test.ts`

R-5（审计 C-D1）：zimuku 等 provider 的候选 fileList 为空，包内选择被 pickFromZip 的
`entries[0]` 机械偷走——季包只能盲拿第一个文件。改造：
- `pickFromZip` 无 `selectFileName` 且 zip 内字幕条目 >1 时，不再默取第一个——返回
  `{ needsSelection: true, entries: string[] }` 形态（writeSubtitle 相应传出）；有
  `selectFileName` 时按名精确选取（既有能力保留）。
- `download_candidate` inputSchema 增 `archiveEntryName: nullableTolerant(z.string())`；
  执行时把它作为 selectFileName 传给 writeSubtitle。多条目且未选 → 返回
  `{ archiveEntries: string[], hint: 'call again with archiveEntryName to pick your episode' }`
  ——清单是事实，选择归 agent（skill Task 7 同步教导）。单条目照旧直落。

- [ ] **Step 1: 写失败测试**：

```ts
it('download_candidate: videoFilename 必须命中目标清单，staged 文件按该目标命名', async () => {
  const tool = makeDownloadCandidateTool({ ...deps, targetFilenames: ['a.mkv', 'b.mkv'] })
  const bad = await tool.execute!({ candidateId: 'assrt:1', fileIndex: null, videoFilename: 'zzz.mkv' }, opts)
  expect(bad).toHaveProperty('error')
})
it('download_candidate: 单目标任务省略 videoFilename 时默认唯一目标（真模型容错）', async () => {
  const tool = makeDownloadCandidateTool({ ...deps, targetFilenames: ['only.mkv'] })
  const r = await tool.execute!({ candidateId: 'assrt:1', fileIndex: null, videoFilename: null }, opts)
  expect(r).toHaveProperty('stagedFileId')
})
it('install_subtitle: 按 videoFilename 找到目标自己的 outDir，逐目标沙盒检查', async () => {
  const tool = makeInstallSubtitleTool({ stagedFiles, mediaRoot: ROOT, targets: [
    { videoFilename: 'a.mkv', outDir: join(ROOT, 'Season 01') },
    { videoFilename: 'b.mkv', outDir: join(ROOT, 'Season 01') },
  ]})
  const r = await tool.execute!({ stagedFileId: id, langTag: 'zh-Hans', videoFilename: 'b.mkv' }, opts)
  expect((r as { path: string }).path).toBe(join(ROOT, 'Season 01', 'b.zh-Hans.srt'))
})
it('install_subtitle: 未知 videoFilename → error（多目标下省略也 error）', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**。DownloadCandidateDeps：`videoFilename: string` → `targetFilenames: string[]`；inputSchema 加 `videoFilename: nullableTolerant(z.string())`；execute 开头解析目标：

```ts
const resolveTarget = (videoFilename: string | null, filenames: string[]): string | { error: string } => {
  if (videoFilename === null) {
    return filenames.length === 1
      ? filenames[0]
      : { error: `this task has ${filenames.length} targets — pass videoFilename to say which one this call is for` }
  }
  return filenames.includes(videoFilename)
    ? videoFilename
    : { error: `unknown videoFilename: ${videoFilename} — must be one of the task's target files` }
}
```

（模块内共享；download 用它选 writeSubtitle 的 videoFilename，install 用它选 targets 里的行。）InstallSubtitleDeps：`outDir/videoFilename` 两个单值字段 → `targets: { videoFilename: string; outDir: string }[]`；execute 按解析出的目标行取 outDir/videoBase，沙盒检查 `isUnderRoots(finalPath, [deps.mediaRoot])` 原样保留。两个工具的 description 补一句 per-target 用法（"pass videoFilename to say which target this download/install is for"）。check_episode_code_safety 不动。
- [ ] **Step 4: 跑测试** → PASS；**Step 5: 提交** `git commit -m "feat(胶水层): download/install 工具逐目标化——批量任务的沙盒逐集校验"`

### Task 6: findSubtitleWorker 批量 prompt + finalize + 超时缩放

**Files:**
- Modify: `src/agent/findSubtitleWorker.ts`
- Test: `src/agent/findSubtitleWorker.test.ts`, `src/agent/findSubtitleWorker.eval.test.ts`（fake-model 驱动的既有护栏改喂批量任务/批量 finalize）

- [ ] **Step 1: 写失败测试**（worker.test.ts 关键新断言）：

```ts
it('prompt 列出全部目标事实行（含绝对号 hint），沙盒 layer1 逐目标校验', async () => { ... })
it('finalize 走批量 schema，返回 FindSubtitleBatchReport', async () => { ... })
it('任一目标 videoPath 逃逸 mediaRoot → 整任务 throw（未起模型调用）', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**要点（全部在 runFindSubtitleTask 内）：

```ts
// 超时按目标数缩放：整季收割合法地比单集长跑。租约无忧——daemon 每 tick 为 inflight 续租。
export const BATCH_BASE_TIMEOUT_MS = 300_000
export const PER_TARGET_TIMEOUT_MS = 120_000
export const BATCH_TIMEOUT_CAP_MS = 3_600_000
const timeoutFor = (n: number) =>
  Math.min(BATCH_BASE_TIMEOUT_MS + PER_TARGET_TIMEOUT_MS * Math.max(0, n - 1), BATCH_TIMEOUT_CAP_MS)

// 沙盒 layer1：逐目标
for (const t of task.targets) {
  if (!isUnderRoots(dirname(t.videoPath), [task.mediaRoot])) {
    throw new Error(`task target ${t.videoPath} escapes its own sandboxed mediaRoot ${task.mediaRoot}`)
  }
}

// 工具接线（Task 5 的新依赖形状）
download_candidate: makeDownloadCandidateTool({
  adapters: deps.adapters, stagingDir, stagedFiles,
  targetFilenames: task.targets.map(t => t.videoFilename),
  targetLanguage: task.targetLanguage, fetchImpl: deps.fetchImpl,
}),
install_subtitle: makeInstallSubtitleTool({
  stagedFiles, mediaRoot: task.mediaRoot,
  targets: task.targets.map(t => ({ videoFilename: t.videoFilename, outDir: dirname(t.videoPath) })),
}),

// prompt：身份块保持，单集三行换为目标清单块
const targetsBlock = task.targets.map(t => {
  const se = t.season != null ? `S${t.season}E${t.episode}` : '(movie)'
  const abs = t.absoluteEpisode != null ? ` | absolute episode: ${t.absoluteEpisode}` : ''
  return `- itemId: ${t.itemId} | ${se}${abs} | file: ${t.videoFilename}`
}).join('\n')
const prompt = [
  `Find and install subtitles in ${languageName(task.targetLanguage)} for the target items listed below`,
  `— they all belong to the same series/scope, so ONE season pack will often cover many of them.`,
  `Report per-item outcomes via finalize exactly once (see the skill document).`,
  '', `target subtitle language: ${languageName(task.targetLanguage)}`,
  `title: ${task.title}`, ...同现有身份行（originalTitle/year/alternativeTitles/overview/runtime/providerIds）,
  '', `targets (${task.targets.length} item(s), current gaps in this scope):`, targetsBlock,
].join('\n')

// finalize schema 换批量；abort 换 timeoutFor(task.targets.length)
schema: FindSubtitleBatchReportSchema,
abortSignal: AbortSignal.timeout(deps.timeoutMs ?? timeoutFor(task.targets.length)),
```

  返回类型 `Promise<FindSubtitleBatchReport>`。stderr 诊断行保留（step 数照记，R4 观察续用）。stepCap 500 不动（测试期观察）。
- [ ] **Step 4: 跑测试**：`npx vitest run src/agent/findSubtitleWorker.test.ts src/agent/findSubtitleWorker.eval.test.ts` → PASS
- [ ] **Step 5: 提交**：`git commit -m "feat(胶水层): worker 批量任务——目标清单入 prompt、批量 finalize、超时按目标数缩放"`

### Task 7: skill 收割语义 ⚠️ 主控亲改（子代理跳过此任务，标记后移交）

**Files:**
- Modify: `src/agent/skills/findSubtitleSkill.ts`
- Test: `src/agent/skills/findSubtitleSkill.test.ts`（锁文本同步更新，同为主控亲改）

主控执笔要点（wording 现场写，语义点缺一不可）：
- [ ] Workflow 一节改批量收割：进包后**对清单内每个目标**逐集验证归属、逐集 install（install_subtitle 带 videoFilename 指明目标）；一个 pack 命中多集是常态与本意（"一个工作流配齐三季"）。
- [ ] 单集拿不准 → 跳过该集（该集报 no_safe_match），**不弃整包、不连坐其他集**；错认比停车糟的北极星语义原样保留到逐集粒度。
- [ ] finalize 恰好一次，形状 `{installed:[], no_safe_match:[], retry_later:[]}`：每个目标 itemId 必须落且只落一个桶；itemId 一字不差抄任务清单，不许编造；installed 项必须带 install_subtitle 返回的真实路径。
- [ ] retry_later 语义：瞬时故障（provider 报错/下载超时）未能处理的目标；"我不确定"仍然是 no_safe_match 不是 retry_later（既有语义逐字保留）。
- [ ] zh канonical 文本更新后，findSubtitleSkill.test.ts 的锁字符串同步重锚（锁的意义是防 refactor 漂移，不是防主控本人修订语义）。
- [ ] 跑 `npx vitest run src/agent/skills/` → PASS；提交 `git commit -m "feat(胶水层): 收割语义入 skill——逐集验证、跳过不弃包、批量 finalize（主控亲改）"`

### Task 8: 收割入账 + 队列语义（runFindSubtitleWorkerTask 重写）【0.3 裁决 R-3 已修订】

**Files:**
- Modify: `src/v2/findSubtitleWorkerTask.ts`
- Modify: `src/v2/libraryRepo.ts`（markUnavailable 改为 item 级退避阶梯）
- Test: `src/v2/findSubtitleWorkerTask.test.ts`（收割部分重写，Task 4 的 .todo 全部复活）、`src/v2/libraryRepo.test.ts`

**R-3 终局语义（替代原 spec 默认稿）**：内容退避从 jobs 状态机整体迁到 item 事实层。
- 前置：Task 10 的 v10 迁移含 `episodes/movies ADD COLUMN search_attempts INTEGER NOT NULL DEFAULT 0`
  （执行顺序上 Task 10 的迁移部分提前到本任务前完成，见阶段二注记）。
- `libraryRepo.markUnavailable(itemId, reason, now)` 签名改造：不再接收外算的 recheckAfter，
  内部 `attempts = search_attempts + 1`，`recheckAfter = attempts > 4 ? now + 30d : now + CONTENT_BACKOFF_DAYS[attempts-1] * 86_400_000`
  （CONTENT_BACKOFF_DAYS 移居 libraryRepo.ts，jobsRepo 不再导出），并写回 search_attempts。
  第 5 次起 30d——**仍是事实、到期重现、永不隐形**；worker_task 永不再 dormant。
- `markCovered` 顺带 `search_attempts = 0`（翻篇归零，同旧 done→wanted 复活语义的事实层版）。
- job 收尾：报告落地即 `completeDone`（"报告已入账"）；仅 retry_later 非空走 `completeError`
  （瞬时节流轨，R-10 豁免）；`completeNoMatch` 从此零调用（随 T9a 处决）。

- [ ] **Step 1: 写失败测试**：

```ts
it('批量入账：installed 逐项 markCovered，no_safe_match 逐项 markUnavailable', async () => { ... })
it('itemId 幻觉防线：报告里不在任务清单内的 itemId 被丢弃并告警，绝不入账（零误触发）', async () => {
  // report.installed 含 itemId 'tmdb:999/s9e9'（任务未携带）→ lib.markCovered 未被以该 id 调用
})
it('retry_later 非空 → completeError（季剩余走瞬时轨快重试），已判明目标的事实照记', async () => { ... })
it('no_safe_match → 逐项 markUnavailable，recheck 阶梯由 item 的 search_attempts 决定（1/2/4/8d→30d），job 一律 completeDone', async () => {
  // 同一 item 连续 5 轮 no_safe_match：recheck 间隔 1d,2d,4d,8d,30d；第 6 轮仍 30d（永不隐形）
  // completeNoMatch 全程零调用（spy 断言）
})
it('markCovered 归零 search_attempts（翻篇语义）', async () => { ... })
it('三桶全空的报告 → completeError（worker 白跑，瞬时轨重试）', async () => { ... })
it('runs 行按非空桶各记一行，decision 词表沿用 installed/no_safe_match/retry_later', async () => { ... })
it('mapper 返回 null → completeDone 幂等 no-op（不变量保留）', async () => { ... })
it('runTask throw → completeError + error run 行（worker 力竭防线保留）', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**（runFindSubtitleWorkerTask 主体替换；deps.runTask 类型改 `(task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>`）：

```ts
const task = await mapWorkerTaskToFindSubtitleTask(job, deps, now())
if (!task) { jobs.completeDone(job.id, now()); return null }
const report = await deps.runTask(task)

// itemId 幻觉防线：清单外 id 一律丢弃告警——markCovered 是两表盲 UPDATE，幻觉 id 可能砸中
// 任何行；宁可漏记一条真报告，不可错标一个非本任务目标（零误触发在入账层的镜像）。
const validIds = new Set(task.targets.map((t) => t.itemId))
const dropAlien = <T extends { itemId: string }>(bucket: T[], name: string): T[] =>
  bucket.filter((x) => {
    if (validIds.has(x.itemId)) return true
    console.error(`[find-subtitle-harvest] job ${job.id}: dropping alien itemId ${x.itemId} from ${name}`)
    return false
  })
const installed = dropAlien(report.installed, 'installed')
const noMatch = dropAlien(report.no_safe_match, 'no_safe_match')
const retryLater = dropAlien(report.retry_later, 'retry_later')

// 事实先入账（installed 永远先记——磁盘上字幕已经在了，队列怎么转都不改变这个事实）
for (const item of installed) {
  const providerRef = item.candidateProvider && item.candidateProviderId
    ? candidateKey({ provider: item.candidateProvider, providerId: item.candidateProviderId })
    : undefined
  deps.lib.markCovered(item.itemId, item.installedPath, 'scout-download', providerRef,
    item.installedLanguage ?? task.targetLanguage)
}

// R-3：no_safe_match 是 worker 的语义判决，落账为 item 事实；"何时再看"由 item 自己的
// search_attempts 阶梯（libraryRepo 内部，1/2/4/8d→30d 封顶，永不隐形）决定——jobs 状态机
// 从此不再持有任何内容判决。
for (const item of noMatch) deps.lib.markUnavailable(item.itemId, item.reason, now())

// 队列语义（R-3 终局）：报告落地即入账收官；仅 retry_later（瞬时故障的季剩余）走
// completeError 节流轨（R-10 豁免：30s→15min→日，永不 dormant）。completeNoMatch 已死。
if (installed.length === 0 && noMatch.length === 0 && retryLater.length === 0) {
  jobs.completeError(job.id, 'worker returned an empty batch report', now())
  recordRun('error', 'empty batch report')
} else if (retryLater.length > 0) {
  jobs.completeError(job.id,
    `retry_later ${retryLater.length} item(s): ${capDetail(retryLater[0].reason)}`, now())
} else {
  jobs.completeDone(job.id, now())
}

// runs：按非空桶各记一行，词表沿用（dashboard 时间线口径不破）
if (installed.length) recordRun('installed',
  `${installed.length} 集入账: ${installed.map((i) => i.itemId).join(', ')}`)
if (noMatch.length) recordRun('no_safe_match',
  `${noMatch.length} 集判无: ${noMatch.map((i) => `${i.itemId}(${i.reason})`).join('; ')}`)
if (retryLater.length) recordRun('retry_later',
  `${retryLater.length} 集待重试: ${retryLater.map((i) => i.itemId).join(', ')}`)
return report
```

  外层 try/catch（worker 力竭 → completeError + error run 行）原样保留。返回类型 `Promise<FindSubtitleBatchReport | null>`。文件头注释重写：单决定→批量收割，引用 spec。
- [ ] **Step 4: 跑测试**：`npx vitest run src/v2/findSubtitleWorkerTask.test.ts` → 全 PASS（含 .todo 复活）
- [ ] **Step 5: 提交**：`git commit -m "feat(胶水层): 批量收割入账——三桶队列语义、itemId 幻觉防线、runs 分桶记账"`

### Task 4b: 派活范围裁量化（用户裁决 R-11，2026-07-16 亲定）

**Files:**
- Modify: `src/v2/db.ts`（v11 entry：jobs_identity 索引重建，taskType 进身份元组）
- Modify: `src/v2/jobsRepo.ts`（upsertWorkerTask 的 ON CONFLICT 目标同步；WorkerTaskIdentity 语义注释更新）
- Modify: `src/v2/libraryRepo.ts`（listMissingEpisodesForSeries——全剧/季子集清单）
- Modify: `src/v2/findSubtitleWorkerTask.ts`（mapper 按 payload.seasons 推导范围）
- Modify: `src/agent/orchestratorAgent.tools.ts`（dispatch_find_subtitle_task 输入改 seasons 数组；null-season 拒绝守卫处决）
- Test: 对应各 test

**用户原话锚点**："根据刮削的实际情况来……到底按季还是按剧，是根据具体情况具体分析的"——
范围是主代理的判断，不是系统的常量。任务形状（targets 逐集带 season、绝对号全剧一张表、
mediaRoot 公共祖先）已天然支持，本任务只改派发面与推导面。

- [ ] v11 entry（ON CONFLICT 目标必须与索引表达式逐字一致，两处同步改）：

```ts
  // v11（R-11 用户裁决）：taskType 进身份元组——find_subtitle 与 realign 对同一 series 不再
  // 共享 identity，find 任务的 season 列恒 NULL（范围事实在 payload.seasons），原 null-season
  // 身份碰撞守卫（hasWellFormedFindSubtitleIdentity 的拒绝分支）随之失去存在理由。
  `DROP INDEX jobs_identity;
   CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''), ifnull(json_extract(payload,'$.taskType'),''))`,
```

- [ ] `listMissingEpisodesForSeries(seriesId, seasons: number[] | null, now)`：谓词同
  listMissingEpisodesInSeason，seasons=null 不加季过滤，非空则 `AND season IN (...)`，
  `ORDER BY season ASC, episode ASC`。旧的 per-season 方法保留（活文档聚合仍用）或内联复用。
- [ ] dispatch_find_subtitle_task：inputSchema `{seriesId: nullableTolerant(z.string()), seasons: tolerantArray(coercibleInt) 可空, movieId, reason}`；
  XOR 校验只剩 series/movie 互斥；payload `{taskType:'find_subtitle', seasons: seasons?.length ? seasons : null, reason}`；
  identity `{seriesId, season: null, movieId: null}`。描述改写：范围按你对磁盘事实的判断——
  单季/多季/全剧皆可；巨大缺口清单可自行分批派。
- [ ] mapper series 分支：`const payload = JSON.parse(job.payload ?? '{}')`；
  `const gaps = deps.lib.listMissingEpisodesForSeries(job.series_id, payload.seasons ?? null, now)`
  （job.season 不再参与推导——身份列已恒 NULL；兼容读旧行：payload.seasons 缺席=全剧）。
- [ ] T7/T11 skill（主控亲改时并入）：教"范围=对刮削事实的裁量"，含"只有 S3 资源就派 S3"
  与"三季都缺可一次配齐（合集包正是为此存在）"两个方向的示例；超大清单自行分批的提示。

提交 `git commit -m "feat(胶水层R-11): 派活范围裁量化——taskType 进身份元组，seasons 数组派发，范围判断归还主代理"`

### Task 8b: dispatch 事实回执 + 判决作废归位（裁决 R-2 / A-F1/F2/F10/B2/B3）

**Files:**
- Modify: `src/v2/jobsRepo.ts`（upsertWorkerTask 返回 outcome；retireAllForSeries 改指 worker_task）
- Modify: `src/agent/orchestratorAgent.tools.ts`（dispatch 工具转告事实；coalesced/blocked 不耗 cap）
- Modify: `src/v2/reconcileAll.ts` + `src/agent/orchestratorAgent.ts`（sibling 意图注入）
- Test: 对应三个 test 文件

- [ ] **Step 1: 写失败测试**：

```ts
// jobsRepo.test.ts
it('upsertWorkerTask 返回 outcome：新行=created，done行=revived，wanted/failed行=coalesced，dormant行=blocked_dormant+last_error', () => { ... })
// orchestratorAgent.tools.test.ts
it('dispatch 撞 dormant 行 → 返回 {dispatched:false, blocked:"dormant", reason:<last_error>}，不计入 cap', async () => { ... })
it('dispatch coalesced → {dispatched:false, coalesced:true, pendingState:"wanted"}，不计入 cap', async () => { ... })
// reconcileAll.test.ts
it('orchestrate job 携带 remainingWorkSummary → 注入 sibling 的 prompt', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**。jobsRepo：

```ts
export type WorkerTaskUpsertOutcome =
  | { outcome: 'created' } | { outcome: 'revived' }
  | { outcome: 'coalesced'; pendingState: JobState }
  | { outcome: 'blocked_dormant'; lastError: string | null }
```

  实现：upsert 前先 SELECT 该 identity 现行（state/last_error），据此分类返回；dormant 行**不 upsert**
  （blocked 是事实回执，复活与否是 orchestrator 未来的判断——本战役 R-3 已使 find_subtitle 任务
  永不 dormant，此分支实际只剩 realign park 类）。dispatch 工具 execute 里 outcome≠'created'/'revived'
  时不 `counter.count++` 并如实返回；工具描述补一句语义。retireAllForSeries：`kind='series_season'`
  改为 `kind='worker_task'`（same series_id，wanted/failed/dormant→done——realign 后旧判决作废归位）。
  reconcileAll.runOrchestrateWorkerTask：解析 `job.payload` 的 remainingWorkSummary，经
  makeOrchestratorAgent 新增可选参 `promptSuffix` 注入 pass prompt（意图抵达 sibling）。
- [ ] **Step 4: 跑测试** → PASS；**Step 5: 提交** `git commit -m "feat(胶水层R-2): dispatch 事实回执——吞噬与谎报之死；sibling 意图注入；判决作废归位 worker_task"`

### Task 8c: 活文档停牌事实 + 工具面诚实化（裁决 R-3 呈现面 / R-4）

**Files:**
- Modify: `src/v2/libraryRepo.ts`（missingBySeason/missingMovies 升级为 coverage 事实行）
- Modify: `src/agent/orchestratorAgent.tools.ts`（list_missing_coverage 新形状；check_series_layout 报 tmdbUnavailable+描述去幽灵）
- Modify: `src/agent/resultHandles.ts`（search_source 报 providerFailures + 申报默认语言过滤）
- Modify: `src/cli/fetchLib.ts`（runSearch 透出 provider 失败事实）、`src/cli/adapters/assrtAdapter.ts`/`zimukuAdapter.ts`（查询截断申报，描述层）
- Test: 对应 test 文件

- [ ] **Step 1: 写失败测试**：

```ts
// libraryRepo.test.ts
it('missingBySeason 行携带 name + 停牌事实：{missing, throttled, nextRecheckAt, sampleReason}', () => {
  // throttled=未到期 unavailable 数；缺口照旧计数；停牌不再整行隐形
})
// orchestratorAgent.tools.test.ts
it('list_missing_coverage 行含 seriesName 与停牌事实列', async () => { ... })
it('check_series_layout TMDB 不可达 → {tmdbUnavailable:true, exceedsSeasonTable:false}（事实与结论分离）', async () => { ... })
// resultHandles.test.ts
it('search_source 部分 provider 失败 → 返回 providerFailures:[{provider,message}]（agent 有了 retry_later 判断的事实输入）', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**。missingBySeason SQL 升级（谓词降级为计数拆分，不再整行过滤）：

```sql
SELECT e.series_id, s.name AS series_name, e.season,
  SUM(CASE WHEN e.sub_status='missing' OR (e.sub_status='unavailable' AND e.recheck_after <= ?) THEN 1 ELSE 0 END) AS missing,
  SUM(CASE WHEN e.sub_status='unavailable' AND e.recheck_after > ? THEN 1 ELSE 0 END) AS throttled,
  MIN(CASE WHEN e.sub_status='unavailable' AND e.recheck_after > ? THEN e.recheck_after END) AS next_recheck_at,
  MAX(CASE WHEN e.sub_status='unavailable' THEN e.status_reason END) AS sample_reason
FROM episodes e JOIN series s ON s.id = e.series_id
GROUP BY e.series_id, e.season
HAVING missing > 0 OR throttled > 0
```

  missingMovies 同构（movie 行原有 name）。list_missing_coverage 行形状加 seriesName/throttled/
  nextRecheckAt/sampleReason，描述改写：呈现全部覆盖事实（含停牌中的），"何时值得重派"是你的判断。
  check_series_layout：`tmdbUnavailable: boolean` 显式字段；描述删除 diagnoseSeason.ts 幽灵引用。
  runSearch 的 emit 回调收集 provider_error 事件 → search_source 返回 `providerFailures`；
  search_source 描述申报"languages 省略时默认按任务目标语言过滤"；assrt/zimuku 工具可见文案申报
  "每 provider 至多使用 N 条查询变体"。
- [ ] **Step 4: 跑测试** → PASS；**Step 5: 提交** `git commit -m "feat(胶水层R-3/R-4): 活文档停牌事实可见 + 工具面事实诚实化——SQL 谓词守门人之死"`

### Task 9c: realign 窄 diff（裁决 R-7；主控逐 hunk 亲验，五重安全层字节不动）

**Files:**
- Modify: `src/v2/realignExecutor.ts`（buildRealignMediaContext→直接构造批量 FindSubtitleTask；TMDB 富化补面；enableRealtimeMonitor 分支+接口字段处决；waitForJellyfinIdle 改名 waitForIngestIdle+注释主语纠正；:353 文案、:600-601/:704-709 注释修正）
- Modify: `src/v2/realignLibraryPort.ts`（对应字段）、`src/core/schemas.ts`（MediaContextSchema 处决——若 T9a 未先行）
- Test: `src/v2/realignExecutor.test.ts`

约束：`:459-680` 安全区与五重安全层语义字节不动（改名产生的标识符替换除外，主控逐 hunk 对照）；
C-B1 时长死枝不激活不删除，仅注释加"禁止带 24 硬编码激活"警示。realign 字幕先行任务=单目标
批量任务（targets 长度 1），复用 mapper 的 fetchTmdbEnrichment 富化（导出之）。
提交 `git commit -m "refactor(胶水层R-7): realign 窄 diff——MediaContext 传声筒处决、富化补面、主语纠正（安全层字节不动）"`

### Task 9a: 清算波（裁决 R-6——旧灵魂躯体总处决）

**Files（全部删除或修剪，连带各自测试）:**
- Delete: `src/cli/legacyJobRouting.ts`(+test)、`src/agent/playbooks/realignPlaybook.ts`(+test)、`src/cli/report.ts`(+test)、`src/core/ledger.ts`(+test)
- Modify: `src/v2/executor.ts`（整文件处决，realign 分支并入 cli 的 worker_task 路由）、`src/cli/index.ts`（routeLegacyJob/tombstone 接线、cmdReport、F15 不可达分支）、`src/v2/jobsRepo.ts`（upsertWanted/completeNoMatch/completePartial+PARTIAL_RETRY_MS/quotaRetryAt+QUOTA_RESET_MARGIN_MS+completeError 的 quotaResetAt 形参/boostPriority/wake/find/findMovie/listByState/setJournalRef/retire + JobIdent 三态类型收缩）、`src/v2/libraryRepo.ts`（resetRecheck/hasSubtitleRecord/setMovieChineseTitle/knownPaths）、`src/daemon/selfScan.ts`（makeSelfScanPass 死链，walkVideoFiles/常量保留）、`src/core/schemas.ts`（九尸+MediaContext+IDENTITY_MATCHES）、`src/core/episode.ts`（SeasonEpisode）、`src/cli/fetchLib.ts`（FetchArgs.deep）、`src/dashboard/apiV2.ts`（'self-scan-trigger'→INGEST_ORCHESTRATE_SERIES_ID 常量）

步骤：先 `mcp serena find_referencing_symbols` 逐符号终验零引用（删前最后一道闸），删除，
`npx tsc --noEmit` 驱动连锁清理，全测。db 死列（jobs.target_episodes/priority 盲肠）v10 不动
（SQLite 删列成本>收益，注释登记）。提交 `git commit -m "chore(胶水层R-6): 清算波——legacy 通路/死器官群/schema 尸体/给死人记账的 report 总处决"`

### Task 9b: 全链收绿 + 阶段一收官

- [ ] **Step 1**: `npx tsc --noEmit` → 清残留引用。禁止为收绿留任何旧单集字段兼容垫片。
- [ ] **Step 2**: `rg "representativeEpisodeId|FindSubtitleDecision\b|completeNoMatch|MediaContext" src/` → 零命中。
- [ ] **Step 3**: 全量 `npx tsc --noEmit && npx vitest run` + `cd web && npx vitest run` → 全绿。
- [ ] **Step 4: 提交**：`git commit -m "chore(胶水层): 全链收绿——旧单集任务形状与旧灵魂躯体出清"`

---

## 阶段二 · 债务三件（spec 第三部分）

### Task 10: schema v10 + 磁盘布局规范形事实（realign 出生信号换代·上半）

**Files:**
- Modify: `src/v2/db.ts`（MIGRATIONS 追加 v10）、`src/recognition/identifyFromPath.ts`、`src/v2/libraryRepo.ts`、`src/v2/ingest.ts`
- Test: `src/v2/db.test.ts`、`src/recognition/identifyFromPath.test.ts`（无则建）、`src/v2/ingest.test.ts`

- [ ] **Step 1: 写失败测试**：

```ts
// identifyFromPath.test.ts
it('isCanonicalEpisodePath: Show (Year) [tmdbid-N]/Season NN/file → true', () => {
  expect(isCanonicalEpisodePath('/m/Show (2020) [tmdbid-9]/Season 01/a.mkv')).toBe(true)
})
it('绝对编号平铺（无季夹层）→ false', () => {
  expect(isCanonicalEpisodePath('/m/Show (2020) [tmdbid-9]/a - 26.mkv')).toBe(false)
})
it('有季夹层但 show 目录无 tmdbid 标签 → false', () => {
  expect(isCanonicalEpisodePath('/m/Show (2020)/Season 01/a.mkv')).toBe(false)
})
// ingest.test.ts
it('摄取一轮后 series.layout_nonstandard 反映本轮磁盘观察（任一集不合规范形=1，全规范=0，含回落）', async () => { ... })
// db.test.ts：schema_version 断言 9→10
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**：
  - db.ts MIGRATIONS 追加终态后第一条增量（**注意：search_attempts 两列被 Task 8 前置依赖，
    v10 迁移在阶段一 Task 8 动工前先落地**——执行顺序：本 Step 的迁移子任务提前，其余照序）：

```ts
  `ALTER TABLE series ADD COLUMN layout_nonstandard INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE episodes ADD COLUMN search_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE movies ADD COLUMN search_attempts INTEGER NOT NULL DEFAULT 0`,
```

  - identifyFromPath.ts 导出（复用模块内 toSegments/detectSeasonFolder/TMDB_ID_PATTERN）：

```ts
/** 债务D1（realign 出生信号换代）：own-ingest 规范化让 mirror 永不超 TMDB 季表，
 *  exceedsSeasonTable 近死；"磁盘布局不合规范形"是识别层本来就看得见的替代事实。
 *  规范形 = `Show (Year) [tmdbid-N]/Season NN/<file>`（buildTargetShowDir 自产的形状）。
 *  只报事实——判断（要不要 realign）永远归 orchestrator。 */
export function isCanonicalEpisodePath(videoPath: string): boolean {
  const segments = toSegments(videoPath)
  if (segments.length < 3) return false
  const parentSeg = segments[segments.length - 2]
  const grandparentSeg = segments[segments.length - 3]
  return detectSeasonFolder(parentSeg) !== null && TMDB_ID_PATTERN.test(grandparentSeg)
}
```

  - libraryRepo.ts：`Series` 接口加 `layout_nonstandard: number`；新方法：

```ts
/** 债务D1：摄取层每轮 pass 结束时写回的磁盘布局事实（1=本轮观察到任一集路径不合规范形）。 */
setSeriesLayoutNonstandard(seriesId: string, nonstandard: boolean): void {
  this.db.prepare('UPDATE series SET layout_nonstandard = ? WHERE id = ?').run(nonstandard ? 1 : 0, seriesId)
}
```

  - ingest.ts（makeIngestPass 内）：pass 级 `const layoutObserved = new Map<string, boolean>()`；episode 走到 upsert（full-path）与 probe-memo 命中（cheap-path，行已知 series_id）两处都执行 `layoutObserved.set(seriesId, (layoutObserved.get(seriesId) ?? false) || !isCanonicalEpisodePath(path))`；pass 收尾（removed 处理之后）`for (const [sid, bad] of layoutObserved) deps.lib.setSeriesLayoutNonstandard(sid, bad)`——每轮全量重写，磁盘真相语义（state=disk, DB=index），realign 整理完成后下一轮自然回落 0。movies 豁免。
- [ ] **Step 4: 跑测试** → PASS（注意生产库需 `ALTER TABLE`——迁移机制自动做，真站闸门时验证 v10 自动升级）
- [ ] **Step 5: 提交**：`git commit -m "feat(债务D1): schema v10 + 磁盘布局规范形事实——识别层看见的落库为 series 级事实列"`

### Task 11: check_series_layout 消费新事实（下半）+ orchestratorSkill 增补

**Files:**
- Modify: `src/agent/orchestratorAgent.tools.ts`（makeCheckSeriesLayoutTool）
- Modify: `src/agent/skills/orchestratorSkill.ts` ⚠️ 此文件的改动为主控亲改，子代理只做 tools 部分
- Test: `src/agent/orchestratorAgent.tools.test.ts`

- [ ] **Step 1: 写失败测试**：

```ts
it('check_series_layout 返回 diskLayoutNonstandard 事实（与 exceedsSeasonTable 并列，互不守门）', async () => {
  // lib.getSeries → { ..., layout_nonstandard: 1 }
  const r = await tool.execute!({ seriesId: 'tmdb:9', season: 1 }, opts)
  expect(r).toMatchObject({ exceedsSeasonTable: false, diskLayoutNonstandard: true })
})
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**【R-8 修订，采纳审计 C-B5】：lib 的 Pick 加 `getSeries`；execute 返回值增 `diskLayoutNonstandard: !!(lib.getSeries(seriesId)?.layout_nonstandard)`；description 增补（"also reports diskLayoutNonstandard: whether ingest observed this series' on-disk layout deviating from the canonical Show (Year) [tmdbid-N]/Season NN/ shape. Two independent facts, two failure shapes: exceedsSeasonTable still fires for mis-scraped 'Season 01'-folder layouts; diskLayoutNonstandard catches flat layouts that ingest normalized. Both are facts, neither is a verdict"）。工具依旧只报事实不守门（北极星 #1/#4）。
- [ ] **Step 4（主控亲改）**: orchestratorSkill.ts 重写 layout 一节【R-8+B5 双裁决】：两个信号并列呈现（exceedsSeasonTable 抓误刮季夹层形态、diskLayoutNonstandard 抓被摄取规范化的平铺形态）；**废除 "you MUST … only proceed if true / never dispatch" 守门措辞**，改为事实+理由式教导（"这两个事实是你判断的输入，不是闸门；误触发的代价与零信号的含义如下……"）——确定性检查不再当守门人，判断归还 orchestrator（真正的零误触发防线仍是下游 executeRealign）。锁测试同步。
- [ ] **Step 5: 跑测试** → PASS；提交 `git commit -m "feat(债务D1): check_series_layout 报磁盘布局事实（orchestratorSkill 主控增补）"`

### Task 12: orchestrate 低频兜底心跳（债务D2）

**Files:**
- Modify: `src/v2/daemon.ts`、`src/daemon/ingestTrigger.ts`（导出 orchestrate 入队 helper 供复用，若提取更干净）
- Test: `src/v2/daemon.test.ts`

- [ ] **Step 1: 写失败测试**：

```ts
it('无变化世界 24h 后 tick 补一个 orchestrate 兜底 pass（identity 与 ingest 触发同一行，幂等）', async () => {
  // ingestTrigger stub 恒 orchestratorTriggered:false；假时钟推 24h+1tick
  // 断言 jobs 表出现 kind=worker_task, series_id='ingest-trigger', payload.taskType='orchestrate'
})
it('ingest 自己触发过 orchestrate 的 tick 会刷新心跳时钟（不重复入队）', async () => { ... })
it('心跳未到点不入队', async () => { ... })
```

- [ ] **Step 2: 确认失败** → FAIL
- [ ] **Step 3: 实现**（daemon.ts）：

```ts
export const ORCHESTRATE_HEARTBEAT_MS = 24 * 3_600_000
// DaemonDeps 加：orchestrateHeartbeatMs?: number（测试注入）
```

tickInner 的 ingest 分支成功路径里，`orchestratorTriggered===true` 时写 meta `last_orchestrate_at=now()`；ingest 分支之后、`bootIngestPending` 守卫之后追加：

```ts
// 2b. 债务D2：orchestrate 低频兜底心跳。无变化世界里 ingest 恒 changed=0、永不触发
// orchestrate，"识别晚到/pending 屏蔽"类惰性收敛洞永不愈合（R4：吞吐异象=架构信号）。
// 任何一次 orchestrate 入队（ingest 触发或本心跳）都刷新时钟；identity 复用
// INGEST_ORCHESTRATE_SERIES_ID——与 ingest 触发的 orchestrate 落同一 identity 行，天然幂等。
const hbRow = lib.db.prepare(`SELECT value FROM meta WHERE key = 'last_orchestrate_at'`).get() as { value: string } | undefined
const lastOrchestrate = hbRow ? Number(hbRow.value) : 0
if (now() - lastOrchestrate >= (this.deps.orchestrateHeartbeatMs ?? ORCHESTRATE_HEARTBEAT_MS)) {
  jobs.upsertWorkerTask(
    { seriesId: INGEST_ORCHESTRATE_SERIES_ID, season: null, movieId: null },
    { taskType: 'orchestrate', reason: 'heartbeat: periodic no-change-world convergence pass' },
    null, now(),
  )
  lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_orchestrate_at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now()))
  log('orchestrate heartbeat: enqueued periodic convergence pass (24h fallback)')
}
```

（import INGEST_ORCHESTRATE_SERIES_ID 自 `../daemon/ingestTrigger.js`。冷启动 meta 缺失 → 立即补一拍：停机期间的惰性洞正好接住，属期望行为，注释写明。）
- [ ] **Step 4: 跑测试** → PASS；**Step 5: 提交** `git commit -m "feat(债务D2): orchestrate 24h 兜底心跳——无变化世界的惰性收敛洞"`

债务D3（B-matrix 复跑）是真站行为，归 Task 15。

### Task 12b: 血统注释清洗波（裁决 R-9；sonnet 子代理，零行为改动）

**Files:** 审计 C-F4 列出的 17 个生产文件 + B14（llm.ts 注释）+ A-F9（libraryRepo 注释）+ E3（adapters 注释）

对每处引用已删除模块/已死世界观（scanner.ts/providerPort/pipeline.ts/rankCandidates/diagnoseSeason/
triggers.ts/Jellyfin 刮削叙事）的注释：改写为当下真实世界的表述或删除，**不改任何行为代码**。
ingest rule 1b 顺手落 `status_reason='ignored: 标题启发式，origin 未确认'`（C-C1 改造-lite，
唯一的行为性改动，走 TDD）。收尾 `npx tsc --noEmit && npx vitest run` 全绿。
提交 `git commit -m "docs(胶水层R-9): 血统注释清洗波——幽灵坐标出清 + rule1b 判决可稽核"`

---

## 阶段三 · 收官纪律 + 真站闸门

### Task 13: R1 架构灵魂验收（主控书面产出）

- [ ] 主控持北极星清单对**本战役全部改动面**逐条质询，产出对照表附到 registry 文档（每条：北极星条款 × 改动点 → 符合/违反/不适用+理由）。特别质询点：批量报告的三桶队列映射是否重新引入了确定性守门？itemId 幻觉防线是"事实盘点"还是越权判断？（预答案要写进表：它是入账层的账实核对，属事实盘点豁免——但要在表里正面回答，不许跳过。）
- [ ] 全仓 `rg "待核|TODO|暂时" src/ --include="*.ts"` → 每条当场排期或升级用户，零跨战役存活。
- [ ] 提交。

### Task 14: R2 对抗审计官复审（双签闸门）

- [ ] 派 1 个全新审计官子代理（Task 0.2 同人格 prompt，模型继承主控），输入=北极星清单+spec+**本战役全部 diff 所在文件的现状**，范围仍=整个项目。发现≥1 条成立 → 修复后重审；零成立发现 → 审计官签字（报告存 registry 文档）。
- [ ] 主控复核签字。双签缺一不可，缺签不得进 Task 15。

### Task 15: 真站闸门（主控亲跑；用户 2026-07-16 确认在公司=走 media-router-tunnel）

**用户升级令（2026-07-16 原话要旨）**："确保项目真的完全无病无旧后，我们才去讨论 dashboard"；
实战范围=**测试容器 + '生产'容器双份**，生产容器"字幕全删了重新测都行"；验收标准=工作流
真的没问题、agent 协作没问题、"确实能应对任何情况，尽己所能，优雅健壮甚至快速地找到所需
字幕"；预算=不设限，"哪怕调 OG API 到配额限制都无所谓"（配额停车本身也是待验行为之一——
quota 呈报通道虽立项在后，节流轨的实际表现要记录）。底线不变：媒体视频文件本体不删、
无关容器不碰。

- [ ] **准备**：router 上拉新代码构建（scout-test:node22-ffmpeg 派生镜像，FFPROBE_PATH 就位）；确认 soak daemon 停掉旧进程再起新进程；生产库自动迁移 v10 验证（T3 实测勘误：schema_version 落的是 MIGRATIONS.length——`SELECT value FROM meta WHERE key='schema_version'` → **2**，并 `PRAGMA table_info(episodes)` 确认 search_attempts 列在；"v10"只是战役标签）。
- [ ] **同季多缺口批量收割验证**（spec 第一部分验收条款）：挑一部有整季覆盖的剧删除该季全部 sidecar 字幕 → 触发 ingest → 观察**一次 claim 一轮 worker run 覆盖该季缺口的多数**（runs 表按桶查证；对照事故前每 claim 一集的形态）。R4 纪律：任何"怎么又一集一集跑"的形态直接停下查架构，不许归因环境。
- [ ] **B-matrix 复跑**（债务D3）：B 层真模型矩阵在 router 复跑——零误触发重验 + 新批量派活行为 + diskLayoutNonstandard 信号在 DxD/Frieren 这类历史 fixture 上的读数记录。
- [ ] **心跳验证**：meta 时钟人为回拨 25h → 观察 tick 补 orchestrate pass。
- [ ] 结果全部书面记入 registry 文档收官节；提交。**此闸门通过后，dashboard 讨论与生产切换才解冻（用户令）。**

---

## 附录 · 北极星清单（R1/R2 质询基准，与 spec 附录同文）

- agent 像人一样判断，不敲计算器；确定性检查绝不当守门人（事实盘点除外）
- 主代理=胶水层/理性中介：判断"什么需要做"，其意图必须原样抵达执行者
- 子代理粒度=季/批；合集包是最高效命中不是干扰；"一个工作流配齐三季"
- 机械层只产事实（活文档/清单/表格），永不产指令
- skill 修订权只在人+主控；拿不准就停车（park），错认比停车糟
- 零误触发是主代理存在的根本理由
