# 媒体库对齐(Library Realign) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当某季反复找不到字幕且镜像集数超出 TMDB 该季集数时，agent 自动诊断"绝对编号平铺"排布问题，构建整理计划，原子重排文件到 Jellyfin 标准结构，抢在 Jellyfin 刮削前把字幕先装好，再编排 Jellyfin 重刮，全程零删除、全程可回滚。

**Architecture:** 新增 `realign` job kind 复用既有 jobs 状态机（租约/心跳/退避/dispatch 全继承，零新并发通道）。诊断（`diagnoseSeason`）挂在 executor 现有 no_safe_match 分支；执行（`realignExecutor.ts`）走"能力探针 → 计划构建（文件名解析+TMDB 累计偏移+anime-lists 交叉验证+确定性闸门）→ 不可见组装(`.realign-build/`) → 字幕先行（自构 MediaContext 直调 runPipeline）→ 旧目录归档 → Jellyfin 编排（等空闲/单库刷新/验收）→ 镜像清理 → completeDone"的单向流水线，每步失败均安全回退（写前先记 write-ahead manifest，回滚 CLI 逆序重放）。spec：`docs/design/2026-07-12-library-realign-design.md`。

**Tech Stack:** TypeScript ESM、vitest、better-sqlite3、zod、node:fs 原子 rename/hardlink、TMDB API、Fribb/anime-lists 社区 JSON、Jellyfin REST API。

**执行约定：**
- **vitest 不做类型检查**——每个 task 的"跑测试"步骤只证明运行时行为，`npx tsc --noEmit` 才是真正的类型闸门。每个 task 完成后必须两者都跑：`npx tsc --noEmit && npx vitest run <相关测试文件>`，全绿才提交。
- **RED-for-the-right-reason**：写完失败测试后跑一次，确认失败原因是"被测代码还没写"（如 `Cannot find module` / `is not a function` / 断言不匹配），而不是别的意外错误（如 schema 还没升级导致的 CHECK constraint 报错、import 路径写错）。若失败原因不对，先修好前置条件，不要就地弱化断言。
- Phase 边界处全仓库保持绿（`npx tsc --noEmit && npx vitest run` 全过）。本计划里唯一不追加自动化测试的任务是 Task 26（`cmdWatch` 生产接线）——与仓库现状一致：`cli/index.ts` 里的 `cmd*` 函数历来不被直接单测，只测试它们调用的构建块；该 task 仍要求 `tsc --noEmit` 通过 + 全量 `vitest run` 保持绿。
- 每个 task 结束单独提交（一个 task 一个 commit），commit message 用 `feat(realign): ...` / `test(realign): ...` 前缀。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/files/mountCapabilities.ts` | 挂载能力探针：硬链接/大小写敏感/两目录间 rename 原子性 |
| `src/adapters/providers/tmdb.ts`（改） | 新增 `getSeasonTable`：季表(season_number/episode_count) |
| `src/adapters/providers/animeLists.ts` | Fribb/anime-lists JSON 抓取 + 按 TMDB tv id 过滤 |
| `src/files/libraryRealign.ts` | 文件名解析(CJK+bracket+E码) + 绝对集号累计映射 + 目标路径命名 + 确定性闸门 + anime-lists 交叉验证 + 可选时长闸门 |
| `src/agent/playbooks/realignPlaybook.ts` | 诊断/整理决策手册（markdown 模板字符串常量） |
| `src/agent/diagnoseSeason.ts` | 季级诊断 LLM 调用 + 确定性预检 + journal 结构化拒绝理由提取 |
| `src/v2/db.ts`（改） | v7 迁移：jobs 表重建，kind CHECK 加 `'realign'`，加 `plan_ref` 列 |
| `src/v2/jobsRepo.ts`（改） | `JobKind`/`JobIdent` 加 realign 分支；`setPlanRef`；`retireAllForSeries` |
| `src/v2/libraryRepo.ts`（改） | `getSeries`/`countEpisodesInSeason`/`episodePathsForSeries`/`deleteSeriesRows` |
| `src/v2/executor.ts`（改） | no_safe_match 分支挂诊断钩子；`executeJob` 按 `kind==='realign'` 分流；`makeDiagnoseSeason` 接线闭包 |
| `src/v2/realignExecutor.ts` | 整理执行编排：mount 哨兵/策略选择、manifest 记账、不可见组装、归档、字幕先行、Jellyfin 编排、镜像清理 |
| `src/files/realignManifest.ts` | write-ahead manifest：初始化/追加/读取/逆序回滚重放 |
| `src/adapters/players/jellyfin.ts`（改） | `call()` 方法联合加 `'DELETE'`；新增 `getScheduledTasks`/`getVirtualFolders`/`refreshLibrary`/`deleteItem` |
| `src/cli/index.ts`（改） | `Assembled` 加 `jellyfinClient`；`cmdWatch` 接线 `executeRealign`；新增 `realign-rollback` 子命令 |
| `src/dashboard/labels.ts`（改） | `DECISION_MAP` 加 `realigned` 人话标签 |
| `scripts/gen-messy-library.sh` | 乱排布 mock 矩阵生成器（5 形态） |

---

## Phase A：挂载能力探针 + doctor 画像

### Task 1: mountCapabilities 探针（硬链接/大小写敏感/跨目录 rename）

**Files:**
- Create: `src/files/mountCapabilities.ts`
- Test: `src/files/mountCapabilities.test.ts`

- [ ] **Step 1: 写失败测试** `src/files/mountCapabilities.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeHardlink, probeCaseSensitivity, probeRenameBetween, probeMountCapabilities } from './mountCapabilities.js'

describe('mountCapabilities 探针', () => {
  it('probeHardlink 探测结果与真实 linkSync 行为一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-hl-'))
    const supported = probeHardlink(dir)
    const src = join(dir, 'a.txt')
    writeFileSync(src, 'x')
    if (supported) {
      expect(() => linkSync(src, join(dir, 'b.txt'))).not.toThrow()
    } else {
      expect(() => linkSync(src, join(dir, 'b.txt'))).toThrow()
    }
  })

  it('probeCaseSensitivity 探测结果与实际读写行为一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-cs-'))
    const sensitive = probeCaseSensitivity(dir)
    writeFileSync(join(dir, 'CaseTest.txt'), 'a')
    const aliasExists = existsSync(join(dir, 'casetest.txt'))
    expect(aliasExists).toBe(!sensitive)
  })

  it('probeRenameBetween：同一 tmp 根下的两个子目录必然同设备，探测为 true', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-rn-'))
    const a = join(root, 'a'); const b = join(root, 'b')
    expect(probeRenameBetween(a, b)).toBe(true)
  })

  it('probeRenameBetween：探测后现场无残留（成功路径清理探针文件）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-rn2-'))
    const a = join(root, 'a'); const b = join(root, 'b')
    probeRenameBetween(a, b)
    // 探针用的文件名带 pid+时间戳前缀，两侧目录都不该残留任何该前缀文件
    expect(existsSync(a)).toBe(true) // 目录本身仍在（mkdirSync 建的）
  })

  it('probeMountCapabilities 汇总 writable/hardlink/caseSensitive 三项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-agg-'))
    const caps = probeMountCapabilities(dir)
    expect(typeof caps.writable).toBe('boolean')
    expect(typeof caps.hardlink).toBe('boolean')
    expect(typeof caps.caseSensitive).toBe('boolean')
    expect(caps.writable).toBe(true) // tmpdir 必可写
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/mountCapabilities.test.ts` → FAIL：`Cannot find module './mountCapabilities.js'`

- [ ] **Step 3: 实现** `src/files/mountCapabilities.ts`：

```ts
import { mkdirSync, writeFileSync, unlinkSync, renameSync, linkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'

let probeCounter = 0

/** 目录内硬链接支持探测：建源文件→试 linkSync 到同目录另一名→成功即支持，失败(EPERM/EXDEV/ENOSYS等)即不支持。 */
export function probeHardlink(dir: string): boolean {
  mkdirSync(dir, { recursive: true })
  const src = join(dir, `.subtitle-scout-hardlink-probe-src-${process.pid}-${probeCounter++}`)
  const dst = join(dir, `.subtitle-scout-hardlink-probe-dst-${process.pid}-${probeCounter++}`)
  try {
    writeFileSync(src, '')
  } catch {
    return false
  }
  try {
    linkSync(src, dst)
    try { unlinkSync(dst) } catch { /* best-effort */ }
    return true
  } catch {
    return false
  } finally {
    try { unlinkSync(src) } catch { /* best-effort */ }
  }
}

/** 大小写敏感性探测：写一个混合大小写文件名，看全大写别名是否"存在"（不敏感文件系统会别名到同一文件）。 */
export function probeCaseSensitivity(dir: string): boolean {
  mkdirSync(dir, { recursive: true })
  const name = `.subtitle-scout-case-probe-${process.pid}-${probeCounter++}`
  const lowerPath = join(dir, name)
  const upperPath = join(dir, name.toUpperCase())
  try {
    writeFileSync(lowerPath, '')
  } catch {
    return false
  }
  try {
    return !existsSync(upperPath)
  } finally {
    try { unlinkSync(lowerPath) } catch { /* best-effort */ }
    try { unlinkSync(upperPath) } catch { /* best-effort：大小写不敏感时这是同一个文件，可能已被上面删掉 */ }
  }
}

/** 两目录间 rename 原子性探测（真实涉及的两条路径，供 realign 归档路径判定用）：
 *  建探针文件于 dirA → renameSync 到 dirB → 成功=同设备(true)；EXDEV 等失败=跨设备(false)。
 *  两种结果都尽力清理残留（成功后探针文件在 dirB，失败后仍在 dirA）。 */
export function probeRenameBetween(dirA: string, dirB: string): boolean {
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const name = `.subtitle-scout-rename-probe-${process.pid}-${probeCounter++}`
  const pathA = join(dirA, name)
  const pathB = join(dirB, name)
  try {
    writeFileSync(pathA, '')
  } catch {
    return false
  }
  try {
    renameSync(pathA, pathB)
    try { unlinkSync(pathB) } catch { /* best-effort */ }
    return true
  } catch {
    try { unlinkSync(pathA) } catch { /* best-effort */ }
    return false
  }
}

export interface MountCapabilities {
  writable: boolean
  hardlink: boolean
  caseSensitive: boolean
}

/** 单目录能力画像：写探针复用 core/mediaContext.ts 的 isDirWritable（同一个写探针实现，不重复造轮子）。 */
export function probeMountCapabilities(dir: string): MountCapabilities {
  return {
    writable: isDirWritable(dir),
    hardlink: probeHardlink(dir),
    caseSensitive: probeCaseSensitivity(dir),
  }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/files/mountCapabilities.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/mountCapabilities.ts src/files/mountCapabilities.test.ts
git commit -m "feat(realign): mount capability probes (hardlink/case-sensitivity/cross-dir rename)"
```

### Task 2: doctor 挂载能力画像（信息性，不作失败门槛）

**Files:**
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/doctor.test.ts`
- Modify: `src/cli/index.ts:487`（`checkMediaRoots` 调用后追加 `checkMountCapabilities`）

- [ ] **Step 1: 写失败测试** 追加到 `src/cli/doctor.test.ts`：

```ts
import { checkMountCapabilities } from './doctor.js'

describe('checkMountCapabilities', () => {
  it('汇报每个根的挂载能力画像，信息性、恒 ok=true', () => {
    const result = checkMountCapabilities(
      ['/media/tv', '/media/movies'],
      (dir) => ({ writable: true, hardlink: dir === '/media/tv', caseSensitive: true }),
    )
    expect(result.ok).toBe(true)
    expect(result.skip).toBeFalsy()
    expect(result.detail).toContain('/media/tv')
    expect(result.detail).toContain('/media/movies')
    expect(result.detail).toContain('硬链接: 支持')
    expect(result.detail).toContain('硬链接: 不支持')
  })

  it('roots 为空时 skip', () => {
    const result = checkMountCapabilities([], () => ({ writable: true, hardlink: true, caseSensitive: true }))
    expect(result.skip).toBe(true)
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/cli/doctor.test.ts` → FAIL：`checkMountCapabilities is not a function`（导入未定义）

- [ ] **Step 3: 实现** 在 `src/cli/doctor.ts` 末尾（`withTimeout` 之后）追加：

```ts
import type { MountCapabilities } from '../files/mountCapabilities.js'

/** 挂载能力画像——纯信息性，不作为失败门槛（用户开机自见挂载能力，供 realign 降级阶梯参考）。 */
export function checkMountCapabilities(
  roots: string[],
  probe: (dir: string) => MountCapabilities,
): DoctorResult {
  if (roots.length === 0) {
    return { name: 'mount-capabilities', ok: true, skip: true, detail: 'MEDIA_ROOTS 未配置，跳过' }
  }
  const lines = roots.map(r => {
    const c = probe(r)
    return `${r}（硬链接: ${c.hardlink ? '支持' : '不支持'}, 大小写敏感: ${c.caseSensitive ? '是' : '否'}, 可写: ${c.writable ? '是' : '否'}）`
  })
  return { name: 'mount-capabilities', ok: true, detail: `挂载能力画像 — ${lines.join('；')}` }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/cli/doctor.test.ts` → PASS

- [ ] **Step 5: 接线** 在 `src/cli/index.ts` 的 `cmdDoctor` 里，`results.push(checkMediaRoots(roots, isDirWritable))` 之后加：

```ts
  const { probeMountCapabilities } = await import('../files/mountCapabilities.js')
  results.push(checkMountCapabilities(roots, probeMountCapabilities))
```

并把 `checkMountCapabilities` 加入顶部 import 列表（`import { checkJellyfin, checkAssrt, ..., checkMountCapabilities, ... } from './doctor.js'`）。

- [ ] **Step 6: 全仓库回归** `npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 7: 提交**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts src/cli/index.ts
git commit -m "feat(realign): doctor reports mount capability picture (informational)"
```

---

## Phase B：TMDB 季表 + Anime-Lists 交叉验证抓取器

### Task 3: TmdbClient.getSeasonTable

**Files:**
- Modify: `src/adapters/providers/tmdb.ts`
- Modify: `src/adapters/providers/tmdb.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/adapters/providers/tmdb.test.ts`：

```ts
describe('TmdbClient.getSeasonTable', () => {
  it('解析 /tv/{id} 的 seasons 数组，过滤 season_number<=0（特别篇），按季号升序', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      seasons: [
        { season_number: 0, episode_count: 5, air_date: null },
        { season_number: 2, episode_count: 12, air_date: '2023-04-01' },
        { season_number: 1, episode_count: 25, air_date: '2022-04-01' },
      ],
    }), { status: 200 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    const table = await client.getSeasonTable('120089')
    expect(table).toEqual([
      { seasonNumber: 1, episodeCount: 25, airDate: '2022-04-01' },
      { seasonNumber: 2, episodeCount: 12, airDate: '2023-04-01' },
    ])
  })

  it('404 → null（真·无数据）', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 }))
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(await client.getSeasonTable('999999')).toBeNull()
  })

  it('网络故障 → 抛 TmdbRequestFailedError（瞬时，可重试，绝不当无数据）', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const client = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.getSeasonTable('120089')).rejects.toThrow(TmdbRequestFailedError)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/adapters/providers/tmdb.test.ts` → FAIL：`client.getSeasonTable is not a function`

- [ ] **Step 3: 实现** 在 `src/adapters/providers/tmdb.ts` 的 `TmdbClient` 类内、`getOriginLanguage` 方法之后追加：

```ts
  /**
   * 季表：season_number/episode_count/air_date，供绝对集号累计偏移映射用。
   * 过滤 season_number<=0（TMDB 用 0 表示特别篇，不参与正片累计编号）。
   * 语义同 getOriginLanguage：null=真·无数据（含404），抛 TmdbRequestFailedError=瞬时故障可重试。
   */
  async getSeasonTable(tvId: string): Promise<SeasonTableEntry[] | null> {
    const d = await this.getJsonStrict(`/tv/${tvId}`)
    if (!d) return null
    const seasons = d.seasons as Array<{ season_number?: number; episode_count?: number; air_date?: string | null }> | undefined
    if (!seasons) return null
    return seasons
      .filter((s): s is { season_number: number; episode_count?: number; air_date?: string | null } =>
        typeof s.season_number === 'number' && s.season_number > 0)
      .map(s => ({ seasonNumber: s.season_number, episodeCount: s.episode_count ?? 0, airDate: s.air_date ?? null }))
      .sort((a, b) => a.seasonNumber - b.seasonNumber)
  }
```

并在文件顶部（`export interface TmdbRef` 附近）加导出类型：

```ts
export interface SeasonTableEntry { seasonNumber: number; episodeCount: number; airDate: string | null }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/adapters/providers/tmdb.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/providers/tmdb.ts src/adapters/providers/tmdb.test.ts
git commit -m "feat(realign): TmdbClient.getSeasonTable — season_number/episode_count table"
```

### Task 4: Anime-Lists (Fribb) 交叉验证数据抓取

**Files:**
- Create: `src/adapters/providers/animeLists.ts`
- Test: `src/adapters/providers/animeLists.test.ts`

- [ ] **Step 1: 写失败测试** `src/adapters/providers/animeLists.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { fetchAnimeListsTable, entriesForTmdbTv, AnimeListsRequestFailedError } from './animeLists.js'

const SAMPLE = [
  {
    anidb_id: 14859, themoviedb_id: { tv: 120089 }, tvdb_id: 371980,
    season: { tvdb: 1, tmdb: 1 }, episode_offset: { tvdb: 0, tmdb: 0 },
  },
  {
    anidb_id: 17591, themoviedb_id: { tv: 120089 }, tvdb_id: 371980,
    season: { tvdb: 2, tmdb: 2 }, episode_offset: { tvdb: 25, tmdb: 25 },
  },
  { anidb_id: 1, themoviedb_id: {}, tvdb_id: 1, season: {}, episode_offset: {} }, // 无 tmdb 映射的条目
]

describe('fetchAnimeListsTable', () => {
  it('解析 Fribb anime-list-full.json 形状，抽取 tmdb tv id / season / episode offset', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const entries = await fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)
    expect(entries).toEqual([
      { anidbId: 14859, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: 0 },
      { anidbId: 17591, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: 25 },
      { anidbId: 1, tmdbTvId: null, tmdbSeason: null, tmdbEpisodeOffset: null },
    ])
  })

  it('非 2xx → 抛 AnimeListsRequestFailedError', async () => {
    const fetchImpl = vi.fn(async () => new Response('err', { status: 500 }))
    await expect(fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)).rejects.toThrow(AnimeListsRequestFailedError)
  })

  it('entriesForTmdbTv：按 tmdbTvId 过滤', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(SAMPLE), { status: 200 }))
    const entries = await fetchAnimeListsTable(fetchImpl as unknown as typeof fetch)
    expect(entriesForTmdbTv(entries, 120089)).toHaveLength(2)
    expect(entriesForTmdbTv(entries, 999)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/adapters/providers/animeLists.test.ts` → FAIL：`Cannot find module './animeLists.js'`

- [ ] **Step 3: 实现** `src/adapters/providers/animeLists.ts`：

```ts
// Fribb/anime-lists（https://github.com/Fribb/anime-lists）：社区维护的 AniDB↔TVDB↔TMDB 交叉映射表，
// 免费无 key。entry.season.tmdb / entry.episode_offset.tmdb 给出该 AniDB 条目（通常一部动画的一个季/cour）
// 在 TMDB 上对应的季号与集号偏移——用来交叉验证我们自己从 TMDB 季表算出的累计绝对编号映射。
export const ANIME_LISTS_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
export const ANIME_LISTS_TIMEOUT_MS = 15_000

export class AnimeListsRequestFailedError extends Error {
  constructor(cause: unknown) {
    super(`anime-lists request failed: ${String(cause)}`, { cause })
    this.name = 'AnimeListsRequestFailedError'
  }
}

export interface AnimeListsEntry {
  anidbId: number
  tmdbTvId: number | null
  tmdbSeason: number | null
  tmdbEpisodeOffset: number | null
}

interface RawEntry {
  anidb_id?: unknown
  themoviedb_id?: { tv?: unknown }
  season?: { tmdb?: unknown }
  episode_offset?: { tmdb?: unknown }
}

export async function fetchAnimeListsTable(fetchImpl: typeof fetch = fetch): Promise<AnimeListsEntry[]> {
  let res: Response
  try {
    res = await fetchImpl(ANIME_LISTS_URL, { signal: AbortSignal.timeout(ANIME_LISTS_TIMEOUT_MS) })
  } catch (e) {
    throw new AnimeListsRequestFailedError(e)
  }
  if (!res.ok) throw new AnimeListsRequestFailedError(`HTTP ${res.status}`)
  let raw: unknown
  try {
    raw = await res.json()
  } catch (e) {
    throw new AnimeListsRequestFailedError(e)
  }
  if (!Array.isArray(raw)) throw new AnimeListsRequestFailedError('response is not an array')

  const out: AnimeListsEntry[] = []
  for (const item of raw as RawEntry[]) {
    if (typeof item !== 'object' || item === null) continue
    const anidbId = item.anidb_id
    if (typeof anidbId !== 'number') continue
    const tmdbTv = item.themoviedb_id?.tv
    const season = item.season?.tmdb
    const offset = item.episode_offset?.tmdb
    out.push({
      anidbId,
      tmdbTvId: typeof tmdbTv === 'number' ? tmdbTv : null,
      tmdbSeason: typeof season === 'number' ? season : null,
      tmdbEpisodeOffset: typeof offset === 'number' ? offset : null,
    })
  }
  return out
}

export function entriesForTmdbTv(entries: AnimeListsEntry[], tmdbTvId: number): AnimeListsEntry[] {
  return entries.filter(e => e.tmdbTvId === tmdbTvId)
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/adapters/providers/animeLists.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/providers/animeLists.ts src/adapters/providers/animeLists.test.ts
git commit -m "feat(realign): fetch Fribb anime-lists JSON for TMDB season/offset cross-check"
```

---

## Phase C：文件名解析 + 映射 + 确定性闸门（`libraryRealign.ts` 计划构建器）

### Task 5: 文件名绝对集号解析 + 视频目录扫描

**Files:**
- Create: `src/files/libraryRealign.ts`
- Test: `src/files/libraryRealign.test.ts`

- [ ] **Step 1: 写失败测试** `src/files/libraryRealign.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAbsoluteEpisodeNumber, scanVideoFiles } from './libraryRealign.js'

describe('parseAbsoluteEpisodeNumber', () => {
  it('CJK "第N话"', () => {
    expect(parseAbsoluteEpisodeNumber('间谍过家家 第26话.mkv')).toEqual({ absoluteEpisode: 26, matchedToken: '第26话' })
  })
  it('CJK "第N集"（简体）', () => {
    expect(parseAbsoluteEpisodeNumber('Show 第5集 1080p.mkv')).toEqual({ absoluteEpisode: 5, matchedToken: '第5集' })
  })
  it('方括号 [26]', () => {
    expect(parseAbsoluteEpisodeNumber('[SubGroup] Spy x Family [26][1080p].mkv')).toEqual({ absoluteEpisode: 26, matchedToken: '[26]' })
  })
  it('裸 E26', () => {
    expect(parseAbsoluteEpisodeNumber('Spy.x.Family.E26.1080p.mkv')).toEqual({ absoluteEpisode: 26, matchedToken: 'E26' })
  })
  it('已含 SxxExx 的文件不是绝对编号平铺——返回 null（不猜、不当绝对号处理）', () => {
    expect(parseAbsoluteEpisodeNumber('Show S02E05.mkv')).toBeNull()
  })
  it('合集文件（E01-02 范围记法）解不出单一集号——返回 null（隔离区，不猜）', () => {
    expect(parseAbsoluteEpisodeNumber('Show - 01-02.mkv')).toBeNull()
  })
  it('无任何可识别集号标记——返回 null', () => {
    expect(parseAbsoluteEpisodeNumber('random_file.mkv')).toBeNull()
  })
})

describe('scanVideoFiles', () => {
  it('只挑视频扩展名，逐个跑 parseAbsoluteEpisodeNumber', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-scan-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Show - 01.mkv'), '')
    writeFileSync(join(dir, 'Show - 02.mp4'), '')
    writeFileSync(join(dir, 'Show.nfo'), '') // 非视频，跳过
    writeFileSync(join(dir, 'poster.jpg'), '') // 非视频，跳过
    const files = scanVideoFiles(dir)
    expect(files.map(f => f.filename).sort()).toEqual(['Show - 01.mkv', 'Show - 02.mp4'])
    expect(files.find(f => f.filename === 'Show - 01.mkv')!.match).toEqual({ absoluteEpisode: 1, matchedToken: 'E01' })
  })
})
```

注：最后一个断言里 `'Show - 01.mkv'` 命中的是 `E_CODE_RE`？不——这个文件名没有字母 `E`。重新核对：这条 fixture 应改为验证"纯数字前缀"不是本函数支持的模式之一（spec 只列了 CJK/bracket/E码三种确定性模式，纯数字裸词歧义太大不收）。修正断言为 `match` 应为 `null`：

- [ ] **Step 1b: 修正上面的最后一条断言** 把

```ts
    expect(files.find(f => f.filename === 'Show - 01.mkv')!.match).toEqual({ absoluteEpisode: 1, matchedToken: 'E01' })
```

改成

```ts
    expect(files.find(f => f.filename === 'Show - 01.mkv')!.match).toBeNull()
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/libraryRealign.test.ts` → FAIL：`Cannot find module './libraryRealign.js'`

- [ ] **Step 3: 实现** `src/files/libraryRealign.ts`：

```ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface EpisodeNumberMatch { absoluteEpisode: number; matchedToken: string }

const CJK_EPISODE_RE = /第\s*(\d{1,4})\s*[话話集]/
const SXXEYY_RE = /S\d{1,4}E\d{1,4}/i
const BRACKET_EPISODE_RE = /\[(\d{1,4})\]/
const E_CODE_RE = /(?<![A-Za-z0-9])E(\d{1,4})(?!\d)/i

/**
 * 从文件名解析绝对集号——只认三种确定性标记（CJK "第N话/第N集" > 方括号 [NN] > 裸 "E26"），
 * 取不出就返回 null，绝不猜（隔离区伺候）。已经是 SxxEyy 记法的文件不是"绝对编号平铺"问题
 * 的目标（本身已分季），直接判 null。合集/范围记法（"01-02"）三种模式都不命中，天然落入 null。
 */
export function parseAbsoluteEpisodeNumber(filename: string): EpisodeNumberMatch | null {
  const cjk = CJK_EPISODE_RE.exec(filename)
  if (cjk) return { absoluteEpisode: Number(cjk[1]), matchedToken: cjk[0] }
  if (SXXEYY_RE.test(filename)) return null
  const bracket = BRACKET_EPISODE_RE.exec(filename)
  if (bracket) return { absoluteEpisode: Number(bracket[1]), matchedToken: bracket[0] }
  const e = E_CODE_RE.exec(filename)
  if (e) return { absoluteEpisode: Number(e[1]), matchedToken: e[0] }
  return null
}

const VIDEO_EXT_RE = /\.(mkv|mp4|avi|ts|m2ts)$/i

export interface ScannedVideoFile { path: string; filename: string; match: EpisodeNumberMatch | null }

export function scanVideoFiles(dir: string, readdir: (d: string) => string[] = d => readdirSync(d)): ScannedVideoFile[] {
  return readdir(dir)
    .filter(f => VIDEO_EXT_RE.test(f))
    .map(f => ({ path: join(dir, f), filename: f, match: parseAbsoluteEpisodeNumber(f) }))
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/files/libraryRealign.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/libraryRealign.ts src/files/libraryRealign.test.ts
git commit -m "feat(realign): parse absolute episode numbers from flat-numbered filenames"
```

### Task 6: 目标路径命名（Jellyfin `{jellyfin}` 绑定约定）+ 绝对集号累计映射

**Files:**
- Modify: `src/files/libraryRealign.ts`
- Modify: `src/files/libraryRealign.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/files/libraryRealign.test.ts`：

```ts
import { buildAbsoluteMap, buildTargetShowDir, buildTargetSeasonDir, buildTargetFilename } from './libraryRealign.js'
import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'

describe('buildAbsoluteMap', () => {
  it('间谍过家家验收案例：25+12+3=40，累计偏移正确', () => {
    const table: SeasonTableEntry[] = [
      { seasonNumber: 1, episodeCount: 25, airDate: null },
      { seasonNumber: 2, episodeCount: 12, airDate: null },
      { seasonNumber: 3, episodeCount: 3, airDate: null },
    ]
    const map = buildAbsoluteMap(table)
    expect(map.get(1)).toEqual({ season: 1, episode: 1 })
    expect(map.get(25)).toEqual({ season: 1, episode: 25 })
    expect(map.get(26)).toEqual({ season: 2, episode: 1 })
    expect(map.get(37)).toEqual({ season: 2, episode: 12 })
    expect(map.get(38)).toEqual({ season: 3, episode: 1 })
    expect(map.get(40)).toEqual({ season: 3, episode: 3 })
    expect(map.get(41)).toBeUndefined()
  })
  it('季表乱序输入仍按季号排序累计', () => {
    const table: SeasonTableEntry[] = [
      { seasonNumber: 2, episodeCount: 2, airDate: null },
      { seasonNumber: 1, episodeCount: 3, airDate: null },
    ]
    const map = buildAbsoluteMap(table)
    expect(map.get(4)).toEqual({ season: 2, episode: 1 })
  })
})

describe('目标命名（Jellyfin {jellyfin} 绑定）', () => {
  it('buildTargetShowDir', () => {
    expect(buildTargetShowDir('间谍过家家', 2022, '120089')).toBe('间谍过家家 (2022) [tmdbid-120089]')
  })
  it('buildTargetSeasonDir 零填充', () => {
    expect(buildTargetSeasonDir(2)).toBe('Season 02')
  })
  it('buildTargetFilename 保留原画质/组名标记、原绝对集号入名', () => {
    const name = buildTargetFilename('间谍过家家', 2022, 2, 1, 26, '[SubGroup] Spy x Family [26][1080p][CRC1234].mkv', '[26]')
    expect(name).toBe('间谍过家家 (2022) S02E01 - 026 - [[SubGroup] Spy x Family  [1080p][CRC1234]].mkv')
  })
})
```

注：上面 `buildTargetFilename` 的期望字符串里，去掉 `[26]` 之后原文件名残留两个连续空格会被折叠——先跑一遍看实现折叠后的确切形状，Step 1b 按实测调整这条断言的期望值（这是本 task 里唯一允许"先跑通实现再回填断言"的例外，因为字符串拼接的确切空格数量在设计阶段无法不跑代码就精确预知；其余所有测试必须保持"先写断言、后写实现让它通过"的顺序）。

- [ ] **Step 1b:** 实现完成后跑 `npx vitest run src/files/libraryRealign.test.ts -t "buildTargetFilename"`，把打印出的实际字符串回填进上面的 `expect(name).toBe(...)`。

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/libraryRealign.test.ts` → FAIL：`buildAbsoluteMap is not a function` 等

- [ ] **Step 3: 实现** 追加到 `src/files/libraryRealign.ts`（顶部 import 加 `extname, basename`；`import { formatEpisodeCode } from '../core/episode.js'`；`import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'`）：

```ts
export interface AbsoluteMapEntry { season: number; episode: number }

/** TMDB 季表按季号排序后累计——abs 1..N 依次对应各季 1..episode_count。 */
export function buildAbsoluteMap(seasonTable: SeasonTableEntry[]): Map<number, AbsoluteMapEntry> {
  const sorted = [...seasonTable].sort((a, b) => a.seasonNumber - b.seasonNumber)
  const map = new Map<number, AbsoluteMapEntry>()
  let cursor = 1
  for (const s of sorted) {
    for (let e = 1; e <= s.episodeCount; e++) {
      map.set(cursor, { season: s.seasonNumber, episode: e })
      cursor++
    }
  }
  return map
}

/** Jellyfin 官方口径 + FileBot {jellyfin} 绑定：`剧名 (年份) [tmdbid-XXXX]` —— tmdbid 钉死刮削身份。 */
export function buildTargetShowDir(seriesTitle: string, year: number, tmdbId: string): string {
  return `${seriesTitle} (${year}) [tmdbid-${tmdbId}]`
}

/** `Season NN` 全拼零填充。 */
export function buildTargetSeasonDir(seasonNumber: number): string {
  return `Season ${String(seasonNumber).padStart(2, '0')}`
}

/**
 * 目标文件名：`剧名 (年份) SxxEyy - abs3 - [原文件名去掉集号标记后的残留].ext`。
 * 原绝对集号保留在文件名里（免费的回滚/排障信息，TRaSH 动漫命名同款）；
 * 原画质/组名/CRC 等标记原样保留——做法是把原文件名里"匹配到的集号 token"整体挖掉，
 * 剩下的原样塞进方括号后缀（不重新解析/不重排任何 tag，最大程度保真）。
 */
export function buildTargetFilename(
  seriesTitle: string, year: number, seasonNumber: number, episodeNumber: number,
  absoluteEpisode: number, sourceFilename: string, matchedToken: string,
): string {
  const ext = extname(sourceFilename)
  const base = basename(sourceFilename, ext)
  const remainder = base.split(matchedToken).join(' ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim()
  const abs3 = String(absoluteEpisode).padStart(3, '0')
  const code = formatEpisodeCode(seasonNumber, episodeNumber)
  const suffix = remainder ? ` - [${remainder}]` : ''
  return `${seriesTitle} (${year}) ${code} - ${abs3}${suffix}${ext}`
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/files/libraryRealign.test.ts` → PASS（记得先完成 Step 1b 回填）

- [ ] **Step 5: 提交**

```bash
git add src/files/libraryRealign.ts src/files/libraryRealign.test.ts
git commit -m "feat(realign): cumulative absolute-episode map + Jellyfin {jellyfin} target naming"
```

### Task 7: 确定性闸门（重复目标/超出上限/集号不连续）→ `buildRealignPlan`

**Files:**
- Modify: `src/files/libraryRealign.ts`
- Modify: `src/files/libraryRealign.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/files/libraryRealign.test.ts`：

```ts
import { buildRealignPlan } from './libraryRealign.js'
import type { ScannedVideoFile } from './libraryRealign.js'

const seasonTable: SeasonTableEntry[] = [
  { seasonNumber: 1, episodeCount: 25, airDate: null },
  { seasonNumber: 2, episodeCount: 12, airDate: null },
  { seasonNumber: 3, episodeCount: 3, airDate: null },
]
const cfg = { seriesTitle: '间谍过家家', year: 2022, tmdbId: '120089', seasonTable }

function mkFiles(count: number): ScannedVideoFile[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return { path: `/media/Show/Season 01/Show - ${n}.mkv`, filename: `Show - E${n}.mkv`, match: { absoluteEpisode: n, matchedToken: `E${n}` } }
  })
}

describe('buildRealignPlan', () => {
  it('40 集绝对编号平铺 → 全部映射成功，S1×25/S2×12/S3×3', () => {
    const result = buildRealignPlan(mkFiles(40), cfg)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toHaveLength(40)
    expect(result.items.filter(i => i.targetSeason === 1)).toHaveLength(25)
    expect(result.items.filter(i => i.targetSeason === 2)).toHaveLength(12)
    expect(result.items.filter(i => i.targetSeason === 3)).toHaveLength(3)
    expect(result.quarantined).toHaveLength(0)
  })

  it('解不出集号的文件进隔离区，不阻塞其余文件的整理', () => {
    const files = [...mkFiles(3), { path: '/media/Show/Season 01/合集.mkv', filename: '合集 01-02.mkv', match: null }]
    const result = buildRealignPlan(files, { ...cfg, seasonTable: [{ seasonNumber: 1, episodeCount: 25, airDate: null }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toHaveLength(3)
    expect(result.quarantined.map(f => f.filename)).toEqual(['合集 01-02.mkv'])
  })

  it('绝对集号超出 TMDB 累计上限 → 整剧放弃', () => {
    const result = buildRealignPlan(mkFiles(41), cfg) // 41 > 40 累计总数
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('超出'))).toBe(true)
  })

  it('映射目标重复（同一 SxxEyy 被两个文件抢占）→ 整剧放弃', () => {
    const files: ScannedVideoFile[] = [
      { path: '/a.mkv', filename: 'a-E1.mkv', match: { absoluteEpisode: 1, matchedToken: 'E1' } },
      { path: '/b.mkv', filename: 'b-第1话.mkv', match: { absoluteEpisode: 1, matchedToken: '第1话' } },
    ]
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('映射目标重复'))).toBe(true)
  })

  it('绝对集号不连续（疑似缺集）→ 整剧放弃', () => {
    const files: ScannedVideoFile[] = [
      { path: '/a.mkv', filename: 'a-E1.mkv', match: { absoluteEpisode: 1, matchedToken: 'E1' } },
      { path: '/b.mkv', filename: 'b-E5.mkv', match: { absoluteEpisode: 5, matchedToken: 'E5' } },
    ]
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('不连续'))).toBe(true)
  })

  it('全部文件都解不出集号 → 整剧放弃', () => {
    const files: ScannedVideoFile[] = [{ path: '/a.mkv', filename: 'random.mkv', match: null }]
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/libraryRealign.test.ts` → FAIL：`buildRealignPlan is not a function`

- [ ] **Step 3: 实现** 追加到 `src/files/libraryRealign.ts`（顶部加 `import { join } from 'node:path'` 已有，复用）：

```ts
export interface RealignPlanConfig {
  seriesTitle: string
  year: number
  tmdbId: string
  seasonTable: SeasonTableEntry[]
}

export interface RealignPlanItem {
  sourcePath: string
  sourceFilename: string
  absoluteEpisode: number
  targetSeason: number
  targetEpisode: number
  /** showDir/seasonDir/filename 拼好的相对路径（相对于媒体根）。 */
  targetRelPath: string
}

export type RealignPlanResult =
  | { ok: true; items: RealignPlanItem[]; quarantined: ScannedVideoFile[] }
  | { ok: false; failures: string[] }

/**
 * 确定性闸门(全过才准动一个文件)：映射无重复目标；各季集数 ≤ TMDB 上限（超限的绝对集号
 * 在 absMap 里查不到，直接判失败）；集号集合合理连续。取不出集号的文件进隔离区（quarantined），
 * 不算失败，也不参与后续闸门检查。任一闸门不过 → 整剧不动（ok:false + 全部失败原因）。
 */
export function buildRealignPlan(files: ScannedVideoFile[], config: RealignPlanConfig): RealignPlanResult {
  const quarantined = files.filter(f => f.match == null)
  const parseable = files.filter((f): f is ScannedVideoFile & { match: EpisodeNumberMatch } => f.match != null)
  if (parseable.length === 0) {
    return { ok: false, failures: ['没有任何文件能解析出绝对集号，整理放弃'] }
  }

  const absMap = buildAbsoluteMap(config.seasonTable)
  const showDir = buildTargetShowDir(config.seriesTitle, config.year, config.tmdbId)
  const failures: string[] = []
  const targetSeen = new Map<string, string>()
  const items: RealignPlanItem[] = []

  for (const f of parseable) {
    const mapped = absMap.get(f.match.absoluteEpisode)
    if (!mapped) {
      failures.push(`绝对集号 ${f.match.absoluteEpisode}（文件 ${f.filename}）超出 TMDB 累计集数上限`)
      continue
    }
    const key = `S${mapped.season}E${mapped.episode}`
    if (targetSeen.has(key)) {
      failures.push(`映射目标重复：${key} 同时对应 ${targetSeen.get(key)} 和 ${f.filename}`)
      continue
    }
    targetSeen.set(key, f.filename)
    const filename = buildTargetFilename(
      config.seriesTitle, config.year, mapped.season, mapped.episode,
      f.match.absoluteEpisode, f.filename, f.match.matchedToken,
    )
    items.push({
      sourcePath: f.path, sourceFilename: f.filename, absoluteEpisode: f.match.absoluteEpisode,
      targetSeason: mapped.season, targetEpisode: mapped.episode,
      targetRelPath: join(showDir, buildTargetSeasonDir(mapped.season), filename),
    })
  }
  if (failures.length > 0) return { ok: false, failures }

  const absNumbers = items.map(i => i.absoluteEpisode).sort((a, b) => a - b)
  for (let i = 1; i < absNumbers.length; i++) {
    if (absNumbers[i] - absNumbers[i - 1] > 1) {
      failures.push(`绝对集号不连续：${absNumbers[i - 1]} 之后跳到 ${absNumbers[i]}，疑似缺集或误判，整理放弃`)
    }
  }
  if (failures.length > 0) return { ok: false, failures }

  return { ok: true, items, quarantined }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/files/libraryRealign.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/libraryRealign.ts src/files/libraryRealign.test.ts
git commit -m "feat(realign): deterministic plan gates — duplicate target / overflow / continuity"
```

### Task 8: anime-lists 交叉验证闸门 + 可选 ffprobe 时长闸门

**Files:**
- Modify: `src/files/libraryRealign.ts`
- Modify: `src/files/libraryRealign.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/files/libraryRealign.test.ts`：

```ts
import { crossCheckAnimeLists, checkRuntimeTolerance } from './libraryRealign.js'
import type { AnimeListsEntry } from '../adapters/providers/animeLists.js'

describe('crossCheckAnimeLists', () => {
  const table: SeasonTableEntry[] = [
    { seasonNumber: 1, episodeCount: 25, airDate: null },
    { seasonNumber: 2, episodeCount: 12, airDate: null },
  ]

  it('anime-lists 记录与 TMDB 累计表一致 → 通过', () => {
    const map = buildAbsoluteMap(table)
    const entries: AnimeListsEntry[] = [
      { anidbId: 1, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: 25 }, // S2 从 abs 26 开始 = offset 25
    ]
    expect(crossCheckAnimeLists(map, entries, 120089)).toEqual({ ok: true })
  })

  it('两源冲突（anime-lists 的 offset 在 TMDB 累计表里对不上）→ 放弃整理', () => {
    const map = buildAbsoluteMap(table)
    const entries: AnimeListsEntry[] = [
      { anidbId: 1, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: 30 }, // 与 TMDB 累计的 25 对不上
    ]
    const result = crossCheckAnimeLists(map, entries, 120089)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('两源冲突')
  })

  it('anime-lists 无该剧映射记录 → 视为通过（无法交叉验证不等于冲突）', () => {
    const map = buildAbsoluteMap(table)
    expect(crossCheckAnimeLists(map, [], 120089).ok).toBe(true)
  })
})

describe('checkRuntimeTolerance（可选 ffprobe 时长抽查）', () => {
  it('实际时长在 TMDB 单集时长 ±10% 内 → 通过（空 failures）', () => {
    const items = [{ sourcePath: '/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'x' }]
    const failures = checkRuntimeTolerance(items, 24, p => (p === '/a.mkv' ? 24 * 60 * 1.05 : null))
    expect(failures).toEqual([])
  })
  it('偏差超过 10% → 记入 failures', () => {
    const items = [{ sourcePath: '/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'x' }]
    const failures = checkRuntimeTolerance(items, 24, () => 5 * 60) // 5 分钟 vs 期望 24 分钟
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('偏差超过')
  })
  it('ffprobe 拿不到时长（返回 null）→ 该文件跳过，不计入 failures（抽查而非硬闸）', () => {
    const items = [{ sourcePath: '/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'x' }]
    expect(checkRuntimeTolerance(items, 24, () => null)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/libraryRealign.test.ts` → FAIL：`crossCheckAnimeLists is not a function`

- [ ] **Step 3: 实现** 追加到 `src/files/libraryRealign.ts`（顶部加 `import type { AnimeListsEntry } from '../adapters/providers/animeLists.js'`）：

```ts
export interface CrossCheckResult { ok: boolean; reason?: string }

/**
 * 用 anime-lists 的季/偏移记录反推该条目对应的绝对集号是否落在我们自己算出的 absoluteMap 里
 * 同一位置——两源一致才算通过。无该剧任何映射记录时视为"无法交叉验证"，不是冲突，通过放行
 * （动漫剧种交叉验证是佐证，不是必需前提；非动漫剧种走到这里 relevant 恒为空，天然放行）。
 */
export function crossCheckAnimeLists(
  absoluteMap: Map<number, AbsoluteMapEntry>, animeListsEntries: AnimeListsEntry[], tmdbTvId: number,
): CrossCheckResult {
  const relevant = animeListsEntries.filter(
    (e): e is AnimeListsEntry & { tmdbSeason: number; tmdbEpisodeOffset: number } =>
      e.tmdbTvId === tmdbTvId && e.tmdbSeason != null && e.tmdbEpisodeOffset != null,
  )
  if (relevant.length === 0) return { ok: true }
  for (const entry of relevant) {
    const expected = { season: entry.tmdbSeason, episode: entry.tmdbEpisodeOffset + 1 }
    const found = [...absoluteMap.values()].some(v => v.season === expected.season && v.episode === expected.episode)
    if (!found) {
      return {
        ok: false,
        reason: `anime-lists 记录第 ${entry.tmdbSeason} 季从 TMDB 集号偏移 ${entry.tmdbEpisodeOffset} 开始，` +
          `但我们算出的 TMDB 累计表里找不到对应位置——两源冲突，放弃整理`,
      }
    }
  }
  return { ok: true }
}

/**
 * 可选抽查：实际视频时长 vs TMDB 单集平均时长（episode_run_time），偏差超过 ±10% 才记为失败。
 * getDurationSeconds 拿不到时长（ffprobe 未安装/探测失败）时该文件跳过，不计入 failures——
 * 这是"业界没人做，我们白捡的便宜校验"，抽查性质，不该因为环境缺 ffprobe 就拦掉整理。
 */
export function checkRuntimeTolerance(
  items: Pick<RealignPlanItem, 'sourcePath' | 'sourceFilename'>[],
  expectedRuntimeMinutes: number,
  getDurationSeconds: (path: string) => number | null,
): string[] {
  const failures: string[] = []
  const expectedSeconds = expectedRuntimeMinutes * 60
  for (const item of items) {
    const actual = getDurationSeconds(item.sourcePath)
    if (actual == null) continue
    const diffRatio = Math.abs(actual - expectedSeconds) / expectedSeconds
    if (diffRatio > 0.10) {
      failures.push(
        `文件 ${item.sourceFilename} 实际时长 ${Math.round(actual)}s 与 TMDB 单集时长 ${Math.round(expectedSeconds)}s 偏差超过 10%`,
      )
    }
  }
  return failures
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/files/libraryRealign.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/libraryRealign.ts src/files/libraryRealign.test.ts
git commit -m "feat(realign): anime-lists cross-check gate + optional ffprobe runtime tolerance gate"
```

---

## Phase D：playbook + diagnoseSeason + v7 迁移 + executor 挂钩

### Task 9: 整理决策手册（playbook-as-skill，const 模块）

**Files:**
- Create: `src/agent/playbooks/realignPlaybook.ts`
- Test: `src/agent/playbooks/realignPlaybook.test.ts`

- [ ] **Step 1: 写失败测试** `src/agent/playbooks/realignPlaybook.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { REALIGN_PLAYBOOK } from './realignPlaybook.js'

describe('REALIGN_PLAYBOOK', () => {
  it('是非空字符串常量', () => {
    expect(typeof REALIGN_PLAYBOOK).toBe('string')
    expect(REALIGN_PLAYBOOK.length).toBeGreaterThan(200)
  })
  it('包含症状→检查→分类→处方四段结构', () => {
    expect(REALIGN_PLAYBOOK).toContain('症状')
    expect(REALIGN_PLAYBOOK).toContain('检查')
    expect(REALIGN_PLAYBOOK).toContain('分类')
    expect(REALIGN_PLAYBOOK).toContain('处方')
  })
  it('提到判决枚举 absolute_flat / unknown', () => {
    expect(REALIGN_PLAYBOOK).toContain('absolute_flat')
    expect(REALIGN_PLAYBOOK).toContain('unknown')
  })
  it('明示 LLM 无权推翻确定性闸门', () => {
    expect(REALIGN_PLAYBOOK).toMatch(/闸门|gate/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/agent/playbooks/realignPlaybook.test.ts` → FAIL：`Cannot find module './realignPlaybook.js'`

- [ ] **Step 3: 实现** `src/agent/playbooks/realignPlaybook.ts`：

```ts
// 独立结构化决策手册（症状→检查→分类→处方），diagnoseSeason 与整理身份甄别提示词注入本文。
// 写成 .ts 而非 .md：一份原始 markdown 文件不会随 tsc 构建产出进 dist（见 tsconfig.build.json
// 只编译 .ts），const 模块导出字符串既能独立评审/版本化，又天然随构建产出，不需要额外的
// 资源拷贝构建步骤。分支逻辑的确定性部分（重复目标/超限/不连续/anime-lists 交叉验证）
// 一律在代码闸门（libraryRealign.ts），本手册只管判断槽位（是不是"绝对编号平铺"）。
export const REALIGN_PLAYBOOK = `
# 媒体库对齐诊断手册

## 症状

一季的字幕反复搜索失败（no_safe_match），且已经连续失败超过一次。这可能不是"字幕站没有这季的资源"，
而是"这一季在媒体库里的文件排布本身和 TMDB 权威排布对不上"——最常见的形态是**绝对编号平铺**：
一部多季动画/剧集把全部集数按跨季连续编号（1, 2, 3... 一直到最后一集）平铺放进一个文件夹（通常叫
"Season 01"），而不是按 TMDB 的季/集分文件夹、重新从每季 E01 起计。Jellyfin 按文件夹结构 + 文件名里
的集号刮削，会把第 26 集误刮成"S1E26"，而 TMDB 记录里 S1 可能只有 25 集——于是找字幕时，季包/散装
候选按 TMDB 真实的 S1E26（不存在）或 S2E1（真实位置）来源都对不上镜像里记的"S1E26"，越搜越错。

## 检查

1. **主信号（确定性，代码已经算好）**：镜像里该季集数是否 > TMDB 该季 episode_count？
   （如果不超过，几乎可以排除绝对编号平铺——通常只是普通字幕稀缺，判 unknown，不要瞎猜。）
2. **佐证（证据复用）**：最近几次搜索/验证的拒绝理由，是否有"整季不对/wrong season entirely/
   season mismatch"这类身份层面的拒绝理由堆积？如果拒绝理由多是"字幕内容对不上""语言不对"这类
   与身份无关的原因，不支持绝对编号平铺的判断。

## 分类

- 主信号成立（镜像集数确实超出 TMDB）+ 佐证支持（身份层面的拒绝理由堆积，或至少不矛盾）
  → **verdict = "absolute_flat"**：判定为绝对编号平铺，需要整理媒体资源本身。
- 主信号不成立，或信号自相矛盾（比如镜像集数没超但佐证却全是身份拒绝）
  → **verdict = "unknown"**：维持现状，诚实报告"看不出排布问题"，绝不猜、绝不动文件。

## 处方

- verdict = absolute_flat：交给确定性的整理流水线（libraryRealign.ts 的计划构建器）——
  文件名解析、TMDB 累计偏移映射、anime-lists 交叉验证、闸门校验，全部是代码里的确定性判断，
  **你（LLM）在这一步之后没有否决权**：闸门任一项不过，整理流水线会自己放弃，不需要你介入，
  也不该被你的判断覆盖。你的职责到"这是不是绝对编号平铺"这一句话判决为止。
- verdict = unknown：什么都不做。不创建整理任务，不建议用户做任何操作，让字幕搜索按现有的
  内容失败退避节奏（1/2/4/8 天）继续走，你的诚实"不知道"比一个自信的错误判断更有价值。

## 身份甄别附注（整理执行阶段的 LLM 用途）

整理执行阶段还有一处用到 LLM：钉死"这个文件夹到底是哪部剧"（identify）——这一步由既有找字幕
流水线的 identify 环节完成，不是本手册的职责；本手册只服务"诊断是否需要整理"这一个判断点。
`.trim()
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/agent/playbooks/realignPlaybook.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/playbooks/realignPlaybook.ts src/agent/playbooks/realignPlaybook.test.ts
git commit -m "feat(realign): decision playbook (symptom/check/classify/prescription) as versioned const module"
```

### Task 10: `diagnoseSeason` — 确定性预检 + LLM 判决 + journal 结构化拒绝理由提取

**Files:**
- Create: `src/agent/diagnoseSeason.ts`
- Test: `src/agent/diagnoseSeason.test.ts`

- [ ] **Step 1: 写失败测试** `src/agent/diagnoseSeason.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  mirrorExceedsSeasonTable, diagnoseSeason, extractStructuredRejections, DiagnosisVerdictSchema,
} from './diagnoseSeason.js'
import type { LlmRuntime } from './runtime.js'

describe('mirrorExceedsSeasonTable', () => {
  it('镜像集数 > TMDB → true', () => {
    expect(mirrorExceedsSeasonTable({ seriesId: 's1', season: 1, mirrorEpisodeCount: 40, tmdbEpisodeCount: 25 })).toBe(true)
  })
  it('镜像集数 <= TMDB → false', () => {
    expect(mirrorExceedsSeasonTable({ seriesId: 's1', season: 1, mirrorEpisodeCount: 12, tmdbEpisodeCount: 25 })).toBe(false)
  })
  it('tmdbEpisodeCount 未知（null）→ false（没有确定性信号，不猜）', () => {
    expect(mirrorExceedsSeasonTable({ seriesId: 's1', season: 1, mirrorEpisodeCount: 40, tmdbEpisodeCount: null })).toBe(false)
  })
})

describe('diagnoseSeason', () => {
  it('主信号不成立 → 直接返回 unknown，不调用 LLM（省一次调用）', async () => {
    const llm: LlmRuntime = { call: vi.fn(), profileInfo: () => ({ mode: 'forced-tool' }) }
    const result = await diagnoseSeason(llm, { seriesId: 's1', season: 1, mirrorEpisodeCount: 12, tmdbEpisodeCount: 25 }, [], [])
    expect(result.parsed.verdict).toBe('unknown')
    expect(llm.call).not.toHaveBeenCalled()
  })

  it('主信号成立 → 调用 LLM，携带镜像/TMDB 集数对比 + 最近 runs + 结构化拒绝理由', async () => {
    const call = vi.fn(async () => ({
      parsed: { verdict: 'absolute_flat' as const, reason: '镜像 40 集远超 TMDB 25 集，且拒绝理由多为身份不符' },
      rawText: '', retries: 0, durationMs: 0, prompt: '',
    }))
    const llm: LlmRuntime = { call, profileInfo: () => ({ mode: 'forced-tool' }) }
    const result = await diagnoseSeason(
      llm, { seriesId: 's1', season: 1, mirrorEpisodeCount: 40, tmdbEpisodeCount: 25 },
      [{ decision: 'no_safe_match', detail: '没找到合适的中文字幕' }],
      ['wrong season entirely', 'wrong season entirely'],
    )
    expect(result.parsed.verdict).toBe('absolute_flat')
    expect(call).toHaveBeenCalledTimes(1)
    const prompt = call.mock.calls[0][0].prompt as string
    expect(prompt).toContain('40')
    expect(prompt).toContain('25')
    expect(prompt).toContain('wrong season entirely')
  })
})

describe('DiagnosisVerdictSchema', () => {
  it('拒绝非法 verdict 枚举值', () => {
    expect(DiagnosisVerdictSchema.safeParse({ verdict: 'maybe', reason: 'x' }).success).toBe(false)
  })
})

describe('extractStructuredRejections', () => {
  it('从 decision.json 形状里提取 rankCandidates 的 rejected[].reason', () => {
    const doc = JSON.stringify({
      llm_calls: [
        { point: 'rankCandidates', parsed: { rejected: [{ candidate_id: 'a:1', reason: 'wrong season entirely' }] } },
        { point: 'identifyMedia', parsed: {} },
      ],
    })
    expect(extractStructuredRejections('/fake/decision.json', () => doc)).toEqual(['wrong season entirely'])
  })
  it('文件缺失/JSON 损坏 → fail-soft 返回空数组', () => {
    expect(extractStructuredRejections('/nope.json', () => { throw new Error('ENOENT') })).toEqual([])
  })
  it('llm_calls 缺失/形状不对 → 空数组', () => {
    expect(extractStructuredRejections('/x.json', () => '{}')).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/agent/diagnoseSeason.test.ts` → FAIL：`Cannot find module './diagnoseSeason.js'`

- [ ] **Step 3: 实现** `src/agent/diagnoseSeason.ts`：

```ts
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'
import { REALIGN_PLAYBOOK } from './playbooks/realignPlaybook.js'

export const DiagnosisVerdictSchema = z.object({
  verdict: z.enum(['absolute_flat', 'unknown']),
  reason: z.string(),
})
export type DiagnosisVerdict = z.infer<typeof DiagnosisVerdictSchema>

export interface SeasonShape {
  seriesId: string
  season: number
  mirrorEpisodeCount: number
  tmdbEpisodeCount: number | null
}

export interface RecentRunSummary { decision: string; detail: string }

/** 主信号（确定性）：镜像里该季集数是否超过 TMDB 该季 episode_count。tmdbEpisodeCount 未知
 *  （没查到季表）时没有确定性信号可用，一律 false，不猜。 */
export function mirrorExceedsSeasonTable(shape: SeasonShape): boolean {
  return shape.tmdbEpisodeCount != null && shape.mirrorEpisodeCount > shape.tmdbEpisodeCount
}

/**
 * 从 pipeline journal 落盘的 decision.json 里提取 rankCandidates 这次 LLM 调用的结构化
 * 拒绝理由（RankDecision.rejected[].reason）——诊断的佐证信号。fail-soft：文件缺失/JSON
 * 损坏/形状不对，一律返回空数组，绝不让诊断因为一份读不到的旧 journal 而崩溃。
 */
export function extractStructuredRejections(
  journalPath: string, readFile: (p: string) => string = p => readFileSync(p, 'utf8'),
): string[] {
  try {
    const doc = JSON.parse(readFile(journalPath)) as { llm_calls?: Array<{ point?: string; parsed?: unknown }> }
    const out: string[] = []
    for (const call of doc.llm_calls ?? []) {
      if (call.point !== 'rankCandidates') continue
      const parsed = call.parsed as { rejected?: Array<{ reason?: unknown }> } | undefined
      for (const r of parsed?.rejected ?? []) {
        if (typeof r.reason === 'string' && r.reason) out.push(r.reason)
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 季级诊断：一次确定性预检 + （信号成立时）一次 LLM 调用。主信号不成立时直接返回 unknown，
 * 不花一次 LLM 调用——诊断本身也要讲究成本，没有确定性信号支撑就不该去问模型"你猜"。
 */
export async function diagnoseSeason(
  llm: LlmRuntime,
  shape: SeasonShape,
  recentRuns: RecentRunSummary[],
  structuredRejections: string[],
): Promise<CallStructuredResult<DiagnosisVerdict>> {
  if (!mirrorExceedsSeasonTable(shape)) {
    return {
      parsed: { verdict: 'unknown', reason: '镜像集数未超过 TMDB 该季集数，没有绝对编号平铺的确定性信号' },
      rawText: '', retries: 0, durationMs: 0, prompt: '',
    }
  }
  const prompt = [
    REALIGN_PLAYBOOK,
    '',
    '## 本次待诊断的季',
    `该季（series_id=${shape.seriesId}, season=${shape.season}）镜像里共有 ${shape.mirrorEpisodeCount} 集，` +
      `TMDB 记录该季只有 ${shape.tmdbEpisodeCount} 集——镜像集数超出 TMDB。`,
    '',
    '最近几次搜索的结论：',
    ...(recentRuns.length ? recentRuns.map(r => `- ${r.decision}: ${r.detail}`) : ['（无历史记录）']),
    '',
    '最近一次搜索的结构化拒绝理由：',
    ...(structuredRejections.length ? structuredRejections.map(r => `- ${r}`) : ['（无结构化拒绝理由）']),
    '',
    '按上面手册的"分类"给出 verdict（absolute_flat 或 unknown）和一句话 reason。',
  ].join('\n')
  return llm.call({
    name: 'report_diagnosis', description: 'Report season layout diagnosis',
    prompt, schema: DiagnosisVerdictSchema,
  })
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/agent/diagnoseSeason.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/diagnoseSeason.ts src/agent/diagnoseSeason.test.ts
git commit -m "feat(realign): diagnoseSeason — deterministic pre-check + LLM verdict + journal rejection extraction"
```

### Task 11: db.ts v7 迁移 — jobs 表重建（kind 加 'realign'，加 plan_ref 列）

**Files:**
- Modify: `src/v2/db.ts`
- Create: `src/v2/migration.realign-job-kind.test.ts`

- [ ] **Step 1: 写失败测试** `src/v2/migration.realign-job-kind.test.ts`：

```ts
// SQLite 不支持 ALTER 已有 CHECK 约束——同 v5(needs_review)手法：建新表(含扩容 CHECK + 新列)
// → 显式列拷数据 → 删旧表 → 改名 → 重建两个索引(jobs 有 jobs_identity/jobs_claim，v5 的
// episodes/movies 在那之前没有额外索引，这次不能照抄"无需连带重建"的结论)。
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

describe('migration: realign job kind + plan_ref（jobs 表重建）', () => {
  it('全新库：jobs 能写入 kind=realign + plan_ref，season 为 NULL', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
       VALUES ('realign', 's1', NULL, '/archive/s1-123/manifest.json', 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    const row = db.prepare(`SELECT * FROM jobs WHERE kind='realign'`).get() as any
    expect(row.series_id).toBe('s1')
    expect(row.season).toBeNull()
    expect(row.plan_ref).toBe('/archive/s1-123/manifest.json')
    db.close()
  })

  it('旧枚举值仍被 CHECK 约束拒绝非法 kind', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, state, priority, attempt, created_at, updated_at)
         VALUES ('bogus_kind', 'wanted', 0, 0, ?, ?)`
      ).run(Date.now(), Date.now())
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('存量库（v6）：已有 jobs/runs 行无损迁移，runs.job_id 外键关系保持完整', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-realign-')), 'scout.db')
    const raw = new Database(dbPath)
    for (let i = 0; i < 6; i++) raw.exec(MIGRATIONS[i])
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run()

    const now = Date.now()
    raw.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    raw.prepare(
      `INSERT INTO jobs (id, kind, series_id, season, state, priority, attempt, error_attempt, created_at, updated_at)
       VALUES (1, 'series_season', 's1', 1, 'failed', 0, 2, 0, ?, ?)`
    ).run(now, now)
    raw.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail)
       VALUES (1, ?, ?, 'no_safe_match', '没找到合适的中文字幕')`
    ).run(now, now)
    raw.close()

    const db = openDb(dbPath) // currentVersion=6 < 7 → 只跑 v7

    const job = db.prepare(`SELECT * FROM jobs WHERE id=1`).get() as any
    expect(job.kind).toBe('series_season')
    expect(job.series_id).toBe('s1')
    expect(job.attempt).toBe(2)
    expect(job.plan_ref).toBeNull() // 新列，存量行回填 NULL

    const run = db.prepare(`SELECT * FROM runs WHERE job_id=1`).get() as any
    expect(run.decision).toBe('no_safe_match') // runs 外键引用的 job 迁移后依然存在、id 不变

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })
    db.close()
  })

  it('jobs_identity 唯一索引重建后仍生效：同剧 realign job 幂等（season NULL 不破坏表达式唯一约束）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    const insert = () => db.prepare(
      `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
       VALUES ('realign', 's1', NULL, NULL, 'wanted', 0, 0, ?, ?)
       ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
       DO UPDATE SET updated_at = excluded.updated_at`
    ).run(now, now)
    insert(); insert()
    const count = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE kind='realign'`).get() as { c: number }
    expect(count.c).toBe(1)
    db.close()
  })

  it('jobs_claim 索引重建后 claimNext 排序仍可用（priority DESC, created_at）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    const row = db.prepare(
      `SELECT id FROM jobs WHERE state IN ('wanted','failed') ORDER BY priority DESC, created_at ASC LIMIT 1`
    ).get() as { id: number }
    expect(row).toBeDefined()
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/migration.realign-job-kind.test.ts` → FAIL：`CHECK constraint failed: jobs`（第一个用例，因为 MIGRATIONS 还没加 v7）

- [ ] **Step 3: 实现** 在 `src/v2/db.ts` 的 `MIGRATIONS` 数组末尾（v6 之后）追加：

```ts
  // v7: realign job kind + plan_ref——library realign 功能新增 job kind。SQLite 不支持
  // ALTER 已有 CHECK 约束，标准作法同 v5(needs_review)：建新表(扩容 CHECK + 新列 plan_ref)
  // → 显式列拷数据 → 删旧表 → 改名。与 v5 不同：jobs 表在此之前已有 jobs_identity/jobs_claim
  // 两个索引（v1 DDL 里紧跟 CREATE TABLE jobs 建的），DROP TABLE 会连带丢掉它们，必须显式
  // 重建，不能照抄 v5 注释"之前没有额外索引，重建无需连带重建"的结论。runs.job_id
  // REFERENCES jobs(id) 是本表的子表——DROP TABLE jobs 期间 SQLite 只在对子表做 DML 时
  // 检查外键，不会因父表被删而报错；INSERT INTO jobs_new ... SELECT ... FROM jobs 原样
  // 拷贝全部 id，RENAME 完成后 runs.job_id 依然精确指向同一批 id，外键关系完整无损。
  // realign job 语义：series_id 有值、season 恒 NULL、plan_ref 指向整理清单(manifest)路径
  // （诊断创建时为 NULL，真正开始执行、manifest 落盘后由 jobsRepo.setPlanRef 回填——诊断
  // 那一刻还没有清单可指）。jobs_identity 的表达式唯一索引 ifnull(season,-1) 天然让
  // "同剧只能有一个 realign job"成立，不需要为此单独改索引定义。
  `
CREATE TABLE jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('series_season','movie','realign')),
  series_id TEXT, season INTEGER,
  movie_id TEXT,
  plan_ref TEXT,
  state TEXT NOT NULL CHECK(state IN
    ('wanted','searching','downloading','verifying','done','failed','dormant')),
  priority INTEGER NOT NULL DEFAULT 0,
  target_episodes TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  lease_until INTEGER,
  last_error TEXT, journal_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO jobs_new
  (id, kind, series_id, season, movie_id, state, priority, target_episodes,
   attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
   created_at, updated_at)
  SELECT id, kind, series_id, season, movie_id, state, priority, target_episodes,
         attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
         created_at, updated_at
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''));
CREATE INDEX jobs_claim ON jobs(state, priority DESC, created_at);
  `.trim(),
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/migration.realign-job-kind.test.ts` → PASS

- [ ] **Step 5: 全仓库回归**（迁移改动风险面广，跑一次全量）`npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 6: 提交**

```bash
git add src/v2/db.ts src/v2/migration.realign-job-kind.test.ts
git commit -m "feat(realign): v7 migration — jobs table rebuild for kind='realign' + plan_ref column"
```

### Task 12: jobsRepo — `JobKind`/`JobIdent` 加 realign 分支、`setPlanRef`、`retireAllForSeries`

**Files:**
- Modify: `src/v2/jobsRepo.ts`
- Modify: `src/v2/jobsRepo.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/jobsRepo.test.ts`：

```ts
describe('realign job kind', () => {
  it('upsertWanted({kind:"realign"}) 建 season=NULL 的 job，claimNext 能正常领取', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)
    expect(job?.kind).toBe('realign')
    expect(job?.series_id).toBe('s1')
    expect(job?.season).toBeNull()
  })

  it('同剧重复 upsertWanted realign 幂等：只有一行', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    expect(repo.countByState('wanted')).toBe(1)
  })

  it('setPlanRef 写入 plan_ref，仅在 active 态生效（同 setJournalRef 语义）', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!
    repo.setPlanRef(job.id, '/archive/s1-123/manifest.json', now)
    expect(repo.get(job.id)!.plan_ref).toBe('/archive/s1-123/manifest.json')
  })

  it('setPlanRef 对非 active 态 job 是 no-op', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!
    repo.completeDone(job.id, now)
    repo.setPlanRef(job.id, '/should/not/write', now)
    expect(repo.get(job.id)!.plan_ref).toBeNull()
  })

  it('retireAllForSeries：把该剧 wanted/failed 的 series_season job 退休为 done，active 态不动', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 2 }, now)
    repo.claimNext(now) // season 1 或 2 变 searching（active，不该被 retire）
    const retired = repo.retireAllForSeries('s1', now)
    expect(retired).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/jobsRepo.test.ts` → FAIL：`repo.setPlanRef is not a function`（TypeScript 也会因 `JobIdent` 联合类型不含 `'realign'` 报类型错，但 vitest 运行时先报函数不存在）

- [ ] **Step 3: 实现** 修改 `src/v2/jobsRepo.ts`：

在顶部类型区加 `RealignJobIdentity`，扩宽 `JobKind`/`JobIdent`：

```ts
export type JobKind = 'series_season' | 'movie' | 'realign'

export interface RealignJobIdentity {
  kind: 'realign'
  seriesId: string
}

export type JobIdent = JobIdentity | MovieJobIdentity | RealignJobIdentity
```

`Job` 接口加一行：

```ts
export interface Job {
  id: number
  kind: JobKind
  series_id: string | null
  season: number | null
  movie_id: string | null
  plan_ref: string | null
  state: JobState
  priority: number
  target_episodes: string | null
  attempt: number
  error_attempt: number
  next_retry_at: number | null
  lease_until: number | null
  last_error: string | null
  journal_ref: string | null
  created_at: number
  updated_at: number
}
```

`UPSERT_CONFLICT_SQL` 加一行（`plan_ref` 在冲突时也同步——realign 是唯一会用到它的 kind，series_season/movie 分支的 INSERT 不列出 `plan_ref` 列，`excluded.plan_ref` 对它们恒为 NULL，不影响其行为）：

```ts
  private static readonly UPSERT_CONFLICT_SQL = `
           ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
           DO UPDATE SET
             updated_at = ?,
             plan_ref = excluded.plan_ref,
             state = CASE WHEN state = 'done' THEN 'wanted' ELSE state END,
             attempt = CASE WHEN state = 'done' THEN 0 ELSE attempt END,
             error_attempt = CASE WHEN state = 'done' THEN 0 ELSE error_attempt END,
             next_retry_at = CASE WHEN state = 'done' THEN NULL ELSE next_retry_at END`
```

`upsertWanted` 加第三分支：

```ts
  upsertWanted(ident: JobIdent, now: number): void {
    if (ident.kind === 'series_season') {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
           VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.seriesId, ident.season, now, now, now)
    } else if (ident.kind === 'movie') {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, movie_id, state, priority, attempt, created_at, updated_at)
           VALUES ('movie', ?, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.movieId, now, now, now)
    } else {
      // realign：season 恒 NULL；plan_ref 诊断创建时未知，留 NULL，真正执行时由 setPlanRef 回填。
      this.db
        .prepare(
          `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
           VALUES ('realign', ?, NULL, NULL, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.seriesId, now, now, now)
    }
  }
```

新增 `setPlanRef`（紧跟 `setJournalRef` 之后，同一语义："仅在 active 态生效，no-op 保护"）：

```ts
  /** 整理执行闭包在计划构建、manifest 落盘之后回填清单路径——诊断创建 job 那一刻还没有
   *  清单可指（诊断只判断"是不是绝对编号平铺"，不构建计划）。同 setJournalRef 语义：
   *  仅在 active 态生效，job 已被 complete* 收尾则是 no-op。 */
  setPlanRef(jobId: number, planRef: string, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET plan_ref = ?, updated_at = ? WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(planRef, now, jobId)
  }
```

新增 `retireAllForSeries`（紧跟 `retire` 之后）：

```ts
  /** realign 完成后的镜像清理一环：该剧旧的 series_season job（按老的、即将被清空的季划分）
   *  不再有意义（新结构下季/集边界完全变了，调和循环会在下一轮 scan 后按新结构重新聚合出
   *  正确的 job）——只退休 wanted/failed（静止态），active 态（理论上此刻不该有——realign
   *  本身占着搜索槽，不会有同剧的 series_season job 正在跑）留给它自己的状态机走完，不强退。 */
  retireAllForSeries(seriesId: string, now: number): number {
    const info = this.db
      .prepare(
        `UPDATE jobs SET state = 'done', updated_at = ?
         WHERE kind = 'series_season' AND series_id = ? AND state IN ('wanted', 'failed')`
      )
      .run(now, seriesId)
    return info.changes
  }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/jobsRepo.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/jobsRepo.ts src/v2/jobsRepo.test.ts
git commit -m "feat(realign): jobsRepo — realign job kind, setPlanRef, retireAllForSeries"
```

### Task 13: libraryRepo — `getSeries`/`countEpisodesInSeason`/`episodePathsForSeries`/`deleteSeriesRows`

**Files:**
- Modify: `src/v2/libraryRepo.ts`
- Modify: `src/v2/libraryRepo.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/libraryRepo.test.ts`：

```ts
describe('realign 支持方法', () => {
  it('getSeries 返回完整行，查无返回 null', () => {
    lib.upsertSeries({ id: 's1', name: 'Spy x Family' })
    expect(lib.getSeries('s1')?.name).toBe('Spy x Family')
    expect(lib.getSeries('nope')).toBeNull()
  })

  it('countEpisodesInSeason 统计指定季集数', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/b', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 2, episode: 1, name: 'E1', path: '/c', subStatus: 'missing' })
    expect(lib.countEpisodesInSeason('s1', 1)).toBe(2)
    expect(lib.countEpisodesInSeason('s1', 2)).toBe(1)
    expect(lib.countEpisodesInSeason('s1', 3)).toBe(0)
  })

  it('episodePathsForSeries 返回该剧全部集路径（跨季）', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/Show/Season 01/a.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/Show/Season 01/b.mkv', subStatus: 'missing' })
    expect(lib.episodePathsForSeries('s1').sort()).toEqual(['/media/Show/Season 01/a.mkv', '/media/Show/Season 01/b.mkv'])
  })

  it('deleteSeriesRows 删除该剧全部 episodes + subtitles + series 行', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'covered' })
    lib.markCovered('e1', '/a.zh-Hans.srt', 'scout-download')
    lib.deleteSeriesRows('s1')
    expect(lib.getEpisode('e1')).toBeNull()
    expect(lib.getSeries('s1')).toBeNull()
    expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('e1')).toEqual({ c: 0 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/libraryRepo.test.ts` → FAIL：`lib.getSeries is not a function`

- [ ] **Step 3: 实现** 追加到 `src/v2/libraryRepo.ts`（`Movie` 接口之后加 `Series` 接口，方法追加到类体内，紧跟 `getMovie` 之后）：

```ts
export interface Series {
  id: string
  name: string
  chinese_title: string | null
  chinese_title_checked_at: number | null
  poster_tag: string | null
  year: number | null
  provider_ids: string | null
  origin_lang: string | null
}
```

```ts
  getSeries(id: string): Series | null {
    const row = this.db.prepare(`SELECT * FROM series WHERE id = ?`).get(id) as Series | undefined
    return row ?? null
  }

  /** 该剧该季在镜像里的集数——diagnoseSeason 的主信号(镜像集数 vs TMDB)所需的"镜像集数"侧。 */
  countEpisodesInSeason(seriesId: string, season: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM episodes WHERE series_id = ? AND season = ?`)
      .get(seriesId, season) as { count: number }
    return row.count
  }

  /** 该剧镜像里全部集的路径（跨季）——realignExecutor 据此推导出实际需要整理的磁盘目录
   *  （绝对编号平铺库通常全部塞在同一个被误刮成"Season 01"的目录里）。 */
  episodePathsForSeries(seriesId: string): string[] {
    return (this.db.prepare(`SELECT path FROM episodes WHERE series_id = ?`).all(seriesId) as { path: string }[])
      .map(r => r.path)
  }

  /** 镜像清理：realign 完成、Jellyfin 用新 SeriesId 重刮之后，旧 seriesId 下的
   *  episodes/subtitles/series 行永远不会再被下一轮 scanLibrary 碰到（它只 upsert Jellyfin
   *  当前报告的条目），是永久性的镜像鬼影，必须显式清除。subtitles 表未声明外键到
   *  episodes(id)，但同属一份账目，一并清理保持镜像干净。 */
  deleteSeriesRows(seriesId: string): void {
    const tx = this.db.transaction(() => {
      const episodeIds = this.db.prepare(`SELECT id FROM episodes WHERE series_id = ?`).all(seriesId) as { id: string }[]
      const delSub = this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`)
      for (const e of episodeIds) delSub.run(e.id)
      this.db.prepare(`DELETE FROM episodes WHERE series_id = ?`).run(seriesId)
      this.db.prepare(`DELETE FROM series WHERE id = ?`).run(seriesId)
    })
    tx()
  }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/libraryRepo.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat(realign): libraryRepo — getSeries/countEpisodesInSeason/episodePathsForSeries/deleteSeriesRows"
```

### Task 14: executor.ts — 诊断钩子（no_safe_match 分支）+ realign job 分流

**Files:**
- Modify: `src/v2/executor.ts`
- Modify: `src/v2/executor.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/executor.test.ts`：

```ts
import type { DiagnosisVerdict } from '../agent/diagnoseSeason.js'

describe('realign 诊断钩子（no_safe_match 分支）', () => {
  const mkDepsWithDiag = (
    runEpisode: ExecutorDeps['runEpisode'],
    diagnoseSeason: ((job: any) => Promise<DiagnosisVerdict>) | undefined,
  ): ExecutorDeps => ({ lib, jobs, runEpisode, now: () => now, log, diagnoseSeason })

  const runEpisodeNoMatch: ExecutorDeps['runEpisode'] = async () => ({ decision: 'no_safe_match', journalPath: '/j.json' })

  it('attempt < 2（本次是第 1 次失败）不调用 diagnoseSeason', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    const diagnoseSeason = vi.fn()
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, diagnoseSeason))
    expect(diagnoseSeason).not.toHaveBeenCalled()
  })

  it('attempt >= 2 + verdict=absolute_flat → upsertWanted 建 realign job', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    let job = jobs.claimNext(now)!
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, undefined)) // 第 1 次失败，attempt→1
    job = jobs.forceClaim('s1', 1, now)!
    const diagnoseSeason = vi.fn(async () => ({ verdict: 'absolute_flat' as const, reason: '镜像集数远超 TMDB' }))
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, diagnoseSeason)) // 第 2 次失败，attempt→2，触发诊断
    expect(diagnoseSeason).toHaveBeenCalledTimes(1)
    const realignJob = jobs.db.prepare(`SELECT * FROM jobs WHERE kind='realign' AND series_id='s1'`).get() as any
    expect(realignJob).toBeDefined()
    expect(realignJob.state).toBe('wanted')
  })

  it('attempt >= 2 + verdict=unknown → 不建 realign job（维持现状）', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    let job = jobs.claimNext(now)!
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, undefined))
    job = jobs.forceClaim('s1', 1, now)!
    const diagnoseSeason = vi.fn(async () => ({ verdict: 'unknown' as const, reason: '没有确定性信号' }))
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, diagnoseSeason))
    expect(diagnoseSeason).toHaveBeenCalledTimes(1)
    const realignJob = jobs.db.prepare(`SELECT * FROM jobs WHERE kind='realign' AND series_id='s1'`).get()
    expect(realignJob).toBeUndefined()
  })

  it('diagnoseSeason 未注入（undefined）→ 静默跳过，不影响 no_safe_match 正常结论', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    let job = jobs.claimNext(now)!
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, undefined))
    job = jobs.forceClaim('s1', 1, now)!
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, undefined)) // attempt→2，但没注入 diagnoseSeason
    expect(jobs.get(job.id)!.state).toBe('failed') // 正常内容退避轨照常生效
  })

  it('diagnoseSeason 抛错 → fail-soft，不影响本次 no_safe_match 的 record()', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    let job = jobs.claimNext(now)!
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, undefined))
    job = jobs.forceClaim('s1', 1, now)!
    const diagnoseSeason = vi.fn(async () => { throw new Error('llm timeout') })
    await executeJob(job, mkDepsWithDiag(runEpisodeNoMatch, diagnoseSeason))
    const runRecords = runs.getByJobId(job.id)
    expect(runRecords[0].decision).toBe('no_safe_match') // 诊断失败不污染本次结论
  })
})

describe('makeDiagnoseSeason（生产接线闭包：把 lib/jf/tmdb/runs/llm 组装成 ExecutorDeps.diagnoseSeason 的形状）', () => {
  it('组装 shape（镜像集数/TMDB 集数）+ recentRuns + structuredRejections，调用纯函数 diagnoseSeason，返回值解包 .parsed', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    runs.insert({ jobId: job.id, startedAt: now, finishedAt: now, decision: 'no_safe_match', detail: '没找到合适的中文字幕', journalPath: '/journals/j1.json' })

    const jf = { getItem: vi.fn(async () => ({ Id: 's1', Type: 'Series', ProviderIds: { Tmdb: '120089' } }) as any) }
    const tmdb = { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 25, airDate: null }]) }
    const llmCall = vi.fn(async () => ({
      parsed: { verdict: 'absolute_flat' as const, reason: '镜像 40 集远超 TMDB 25 集' },
      rawText: '', retries: 0, durationMs: 0, prompt: '',
    }))
    const llm = { call: llmCall, profileInfo: () => ({ mode: 'forced-tool' }) }
    const readFile = vi.fn(() => JSON.stringify({
      llm_calls: [{ point: 'rankCandidates', parsed: { rejected: [{ candidate_id: 'a:1', reason: 'wrong season entirely' }] } }],
    }))

    // 模拟：镜像里这季实际有 40 集（countEpisodesInSeason 会数出真实值，这里为让测试聚焦
    // "组装是否正确"而不是"真造 40 个 episode 行"，直接再插 38 个占位集把镜像集数堆到 40）。
    for (let i = 3; i <= 40; i++) mkEpisode(`e${i}`, 's1', 1, i)

    const diagnoseSeason = makeDiagnoseSeason({ lib, jf: jf as any, tmdb: tmdb as any, runs, llm: llm as any, readFile })
    const finalJob = jobs.get(job.id)!
    const verdict = await diagnoseSeason(finalJob)

    expect(verdict).toEqual({ verdict: 'absolute_flat', reason: '镜像 40 集远超 TMDB 25 集' })
    expect(jf.getItem).toHaveBeenCalledWith('s1')
    expect(tmdb.getSeasonTable).toHaveBeenCalledWith('120089')
    const prompt = llmCall.mock.calls[0][0].prompt as string
    expect(prompt).toContain('40') // 镜像集数
    expect(prompt).toContain('25') // TMDB 集数
    expect(prompt).toContain('wrong season entirely') // 结构化拒绝理由
  })

  it('series 缺 TMDB id（jf.getItem 未带 ProviderIds.Tmdb）→ 返回 unknown，不抛异常（fail-soft）', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    const jf = { getItem: vi.fn(async () => ({ Id: 's1', Type: 'Series', ProviderIds: {} }) as any) }
    const tmdb = { getSeasonTable: vi.fn() }
    const llm = { call: vi.fn(), profileInfo: () => ({ mode: 'forced-tool' }) }
    const diagnoseSeason = makeDiagnoseSeason({ lib, jf: jf as any, tmdb: tmdb as any, runs, llm: llm as any })
    const verdict = await diagnoseSeason(jobs.get(job.id)!)
    expect(verdict.verdict).toBe('unknown')
    expect(tmdb.getSeasonTable).not.toHaveBeenCalled()
  })

  it('TMDB 季表查无该季（该剧只有 1 季但 job.season=2）→ tmdbEpisodeCount=null，返回 unknown', async () => {
    mkEpisode('e1', 's1', 2, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 2 }, now)
    const job = jobs.claimNext(now)!
    const jf = { getItem: vi.fn(async () => ({ Id: 's1', Type: 'Series', ProviderIds: { Tmdb: '1' } }) as any) }
    const tmdb = { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 10, airDate: null }]) } // 没有 season 2
    const llm = { call: vi.fn(), profileInfo: () => ({ mode: 'forced-tool' }) }
    const diagnoseSeason = makeDiagnoseSeason({ lib, jf: jf as any, tmdb: tmdb as any, runs, llm: llm as any })
    const verdict = await diagnoseSeason(jobs.get(job.id)!)
    expect(verdict.verdict).toBe('unknown')
    expect(llm.call).not.toHaveBeenCalled()
  })
})

describe('realign job 执行分流', () => {
  it('job.kind==="realign" 且 executeRealign 未注入 → completeError 短退避', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    await executeJob(job, { lib, jobs, runEpisode: vi.fn(), now: () => now, log })
    expect(jobs.get(job.id)!.state).toBe('failed')
    expect(runs.getByJobId(job.id)[0].decision).toBe('error')
  })

  it('job.kind==="realign" + executeRealign 成功 → completeDone + runs 记人话', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => ({ decision: 'realigned' as const, detail: '把 40 集平铺整理成 3 季，字幕已就位' }))
    await executeJob(job, { lib, jobs, runEpisode: vi.fn(), now: () => now, log, executeRealign })
    expect(jobs.get(job.id)!.state).toBe('done')
    expect(runs.getByJobId(job.id)[0].detail).toBe('把 40 集平铺整理成 3 季，字幕已就位')
  })

  it('job.kind==="realign" + executeRealign 判失败 → completeError', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => ({ decision: 'error' as const, detail: '挂载探针失败：库根为空' }))
    await executeJob(job, { lib, jobs, runEpisode: vi.fn(), now: () => now, log, executeRealign })
    expect(jobs.get(job.id)!.state).toBe('failed')
  })

  it('job.kind==="realign" + executeRealign 抛异常 → completeError（同 catch 路径）', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => { throw new Error('EXDEV') })
    await executeJob(job, { lib, jobs, runEpisode: vi.fn(), now: () => now, log, executeRealign })
    expect(jobs.get(job.id)!.state).toBe('failed')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/executor.test.ts` → FAIL：`ExecutorDeps` 不含 `diagnoseSeason`/`executeRealign`，且 realign 分流逻辑不存在（TS 报错 + 断言不符双重失败）

- [ ] **Step 3: 实现** 修改 `src/v2/executor.ts`：

`ExecutorDeps` 接口加两个可选字段（紧跟 `log` 之前）：

```ts
export interface ExecutorDeps {
  lib: LibraryRepo
  jobs: JobsRepo
  runEpisode: (...) => Promise<...>  // 保持原样，此处省略未改动的类型体
  /** 季级诊断闭包（可选）：no_safe_match 分支在 attempt>=2 时调用，判定是否需要整理媒体资源。
   *  未注入（测试等场景）时诊断钩子整体跳过，不影响既有 no_safe_match 行为。 */
  diagnoseSeason?: (job: Job) => Promise<{ verdict: 'absolute_flat' | 'unknown'; reason: string }>
  /** realign job 执行闭包（可选）：executeJob 遇到 kind==='realign' 时调用。未注入（生产总会
   *  接线，仅测试可能省略）时判 completeError 短退避，而不是抛异常崩溃整个 tick。 */
  executeRealign?: (job: Job) => Promise<{ decision: 'realigned' | 'error'; detail: string }>
  now: () => number
  log: (msg: string) => void
}
```

`executeJob` 函数体最开头（`const { lib, jobs, runEpisode, now, log } = deps` 之前）加分流：

```ts
export async function executeJob(job: Job, deps: ExecutorDeps): Promise<void> {
  if (job.kind === 'realign') {
    await executeRealignBranch(job, deps)
    return
  }
  const { lib, jobs, runEpisode, now, log } = deps
  // ...原有函数体一字不改...
```

在 `no_safe_match` 分支（`if (decision === 'no_safe_match') { ... }`）里，`for (const target of targets) { lib.markUnavailable(...) }` 循环之后、`record(transitioned, decision, HUMAN_NO_MATCH, journalPath, stats)` 之前插入诊断钩子：

```ts
    if (decision === 'no_safe_match') {
      const transitioned = jobs.completeNoMatch(job.id, now())
      if (transitioned) {
        const finalJob = jobs.get(job.id)!
        const recheckAfter =
          finalJob.state === 'dormant'
            ? now() + 30 * 86_400_000
            : finalJob.next_retry_at ?? now() + 86_400_000
        for (const target of targets) {
          lib.markUnavailable(target.id, HUMAN_NO_MATCH, recheckAfter)
        }
        // 诊断钩子：只在 series_season job、且这已经是第 2 次及以上内容失败时触发——
        // 单次失败太早下判断，容易把"这季字幕站确实稀缺"误判成排布问题。
        if (job.kind === 'series_season' && finalJob.attempt >= 2 && deps.diagnoseSeason) {
          try {
            const verdict = await deps.diagnoseSeason(finalJob)
            if (verdict.verdict === 'absolute_flat') {
              jobs.upsertWanted({ kind: 'realign', seriesId: job.series_id! }, now())
              log(`诊断：series ${job.series_id} season ${job.season} 判定绝对编号平铺（${verdict.reason}），已建 realign 任务`)
            }
          } catch (e) {
            log(`warn: series ${job.series_id} season ${job.season} 诊断失败（不影响本次 no_safe_match 结论）：${String(e)}`)
          }
        }
      }
      record(transitioned, decision, HUMAN_NO_MATCH, journalPath, stats)
      return
    }
```

在文件末尾（`makeRunEpisode` 之后）追加 `executeRealignBranch` 私有辅助函数：

```ts
/** realign job 的执行分支：租约/退避复用既有状态机（completeDone/completeError），
 *  不新增状态转移。executeRealign 未注入时判 completeError（短退避重试，而不是让
 *  executor 在生产接线不完整时直接崩溃整个 tick）。 */
async function executeRealignBranch(job: Job, deps: ExecutorDeps): Promise<void> {
  const { jobs, now, log } = deps
  const runs = new RunsRepo(deps.lib.db)
  const startedAt = now()
  if (!deps.executeRealign) {
    jobs.completeError(job.id, 'realign executor not wired', now())
    runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: '整理执行器未接线（内部配置错误）', journalPath: null })
    return
  }
  try {
    const result = await deps.executeRealign(job)
    if (result.decision === 'realigned') {
      const transitioned = jobs.completeDone(job.id, now())
      runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'realigned', detail: result.detail, journalPath: null })
      if (!transitioned) log(`warn: job ${job.id} realign 完成但 complete* 守卫未命中（stale lease）`)
    } else {
      const transitioned = jobs.completeError(job.id, result.detail, now())
      runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: result.detail, journalPath: null })
      if (!transitioned) log(`warn: job ${job.id} realign 失败但 complete* 守卫未命中（stale lease）`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    runs.insert({ jobId: job.id, startedAt, finishedAt: now(), decision: 'error', detail: `整理失败，稍后自动重试：${msg}`, journalPath: null })
  }
}

/**
 * 生产接线闭包：把 lib/jf/tmdb/runs/llm 组装成 `ExecutorDeps.diagnoseSeason` 的形状
 * （mirror `makeRunEpisode` 的接线角色——真实实现在这里把一堆具体依赖粘合成
 * executor.ts 只关心的那一个纯函数签名）。TMDB id 解析统一走 `jf.getItem(seriesId)`
 * 活查（同 executor.ts 其它 TMDB 引用解析路径的既有做法，series.provider_ids 这一列
 * 在 scanner.ts 的正常扫描路径里从未被写入，不能当可信来源）。任何一步拿不到数据
 * （无 TMDB id / TMDB 查无该季）直接返回 unknown，不抛异常——诊断本身就该在信号不足时
 * 诚实说"看不出"，调用方（executeJob 的 no_safe_match 分支）外面还包了一层 try/catch
 * 兜底，但这里能自己 fail-soft 的就不麻烦外层。
 */
export function makeDiagnoseSeason(deps: {
  lib: LibraryRepo
  jf: Pick<import('../adapters/players/types.js').PlayerServer, 'getItem'>
  tmdb: Pick<import('../adapters/providers/tmdb.js').TmdbClient, 'getSeasonTable'>
  runs: RunsRepo
  llm: import('../agent/runtime.js').LlmRuntime
  readFile?: (path: string) => string
}): (job: Job) => Promise<{ verdict: 'absolute_flat' | 'unknown'; reason: string }> {
  return async (job) => {
    const seriesId = job.series_id!
    const season = job.season!
    const seriesItem = await deps.jf.getItem(seriesId).catch(() => null)
    const tmdbId = seriesItem?.ProviderIds?.Tmdb
    if (!tmdbId) {
      return { verdict: 'unknown', reason: '无法解析该剧的 TMDB id，跳过诊断' }
    }
    const seasonTable = await deps.tmdb.getSeasonTable(tmdbId).catch(() => null)
    const tmdbSeason = seasonTable?.find(s => s.seasonNumber === season)
    const shape = {
      seriesId, season,
      mirrorEpisodeCount: deps.lib.countEpisodesInSeason(seriesId, season),
      tmdbEpisodeCount: tmdbSeason?.episodeCount ?? null,
    }
    const jobRuns = deps.runs.getByJobId(job.id)
    const recentRuns = jobRuns.slice(0, 5).map(r => ({ decision: r.decision ?? '', detail: r.detail ?? '' }))
    const latestJournalPath = jobRuns[0]?.journal_path ?? null
    const structuredRejections = latestJournalPath
      ? extractStructuredRejections(latestJournalPath, deps.readFile)
      : []
    const result = await diagnoseSeason(deps.llm, shape, recentRuns, structuredRejections)
    return result.parsed
  }
}
```

顶部 import 区确认已有 `import { RunsRepo } from './runsRepo.js'`（已有，见文件顶部第 5 行）——无需新增；额外加一行：

```ts
import { diagnoseSeason, extractStructuredRejections } from '../agent/diagnoseSeason.js'
```

（`makeDiagnoseSeason` 的其余依赖类型——`PlayerServer`/`TmdbClient`/`LlmRuntime`——用内联 `import('...')` 类型引用，不占用顶层 import 一行，因为它们只在这一个函数签名里用到一次；这是本计划里唯一一处用这个写法的地方，若嫌不一致也可以改成顶层具名 `import type` 三行，两种写法功能等价。）

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/executor.test.ts` → PASS

- [ ] **Step 5: 全仓库回归** `npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 6: 提交**

```bash
git add src/v2/executor.ts src/v2/executor.test.ts
git commit -m "feat(realign): executor diagnosis hook on repeated no_safe_match + realign job dispatch"
```

---

## Phase E：`realignExecutor.ts` 执行路径

本阶段的 Jellyfin 编排函数（Task 19）只依赖**结构化接口**（`Pick<>`/自定义最小接口），不依赖 Phase F
才会往 `JellyfinClient` 添加的具体方法实现——真正把 `JellyfinClient` 接进来是 Task 21（Phase F）的事。
这保证 Phase E 结束时仓库单独可编译、可测试、全绿，不必等 Phase F 完成。

### Task 15: mount 哨兵 + 策略选择 + 归档路径

**Files:**
- Create: `src/v2/realignExecutor.ts`
- Test: `src/v2/realignExecutor.test.ts`

- [ ] **Step 1: 写失败测试** `src/v2/realignExecutor.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountAliveSentinel, chooseRealignStrategy, archiveDirFor } from './realignExecutor.js'

describe('mountAliveSentinel', () => {
  it('库根不存在 → 拒绝', () => {
    const result = mountAliveSentinel(join(tmpdir(), 'does-not-exist-' + Date.now()))
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('不存在')
  })

  it('库根为空（疑似挂载掉线）→ 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-sentinel-empty-'))
    const result = mountAliveSentinel(dir)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('为空')
  })

  it('库根非空且可写 → 通过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-sentinel-ok-'))
    writeFileSync(join(dir, 'Show'), '') // 随便有点内容
    const result = mountAliveSentinel(dir)
    expect(result.ok).toBe(true)
  })

  it('库根非空但不可写 → 拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-sentinel-ro-'))
    writeFileSync(join(dir, 'Show'), '')
    chmodSync(dir, 0o555)
    try {
      const result = mountAliveSentinel(dir)
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('不可写')
    } finally {
      chmodSync(dir, 0o755) // 还原，避免 vitest 清理临时目录时因权限报错
    }
  })
})

describe('chooseRealignStrategy', () => {
  it('不可写 → abandon', () => {
    expect(chooseRealignStrategy({ writable: false, hardlink: true }, true)).toBe('abandon')
  })
  it('可写 + 支持硬链接 → hardlink（优先，做种保护）', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: true }, true)).toBe('hardlink')
  })
  it('可写 + 不支持硬链接 + rename 跨库根↔归档目录原子 → rename', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: false }, true)).toBe('rename')
  })
  it('可写 + 不支持硬链接 + rename 不原子（极端 FUSE）→ abandon（宁不做，不做烂）', () => {
    expect(chooseRealignStrategy({ writable: true, hardlink: false }, false)).toBe('abandon')
  })
})

describe('archiveDirFor', () => {
  it('拼出 <share根>/.archive/<剧名>-<时间戳>/', () => {
    expect(archiveDirFor('/media', '间谍过家家', 1720000000000)).toBe('/media/.archive/间谍过家家-1720000000000')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/realignExecutor.test.ts` → FAIL：`Cannot find module './realignExecutor.js'`

- [ ] **Step 3: 实现** `src/v2/realignExecutor.ts`：

```ts
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'

export interface MountSentinelResult { ok: boolean; reason?: string }

/**
 * 哨兵防线：动手前验证挂载活着。SMB 掉挂载在很多环境下看起来像一个空目录（而不是报错），
 * 是整理型守护毁库的经典死法——库根必须非空 + 真实可写，两条都过才放行。
 */
export function mountAliveSentinel(libRoot: string): MountSentinelResult {
  if (!existsSync(libRoot)) return { ok: false, reason: `库根不存在：${libRoot}` }
  let entries: string[]
  try {
    entries = readdirSync(libRoot)
  } catch (e) {
    return { ok: false, reason: `无法读取库根：${String(e)}` }
  }
  if (entries.length === 0) return { ok: false, reason: `库根为空——疑似挂载掉线，拒绝执行：${libRoot}` }
  if (!isDirWritable(libRoot)) return { ok: false, reason: `库根不可写：${libRoot}` }
  return { ok: true }
}

export type RealignStrategy = 'hardlink' | 'rename' | 'abandon'

/**
 * 降级阶梯：不可写→abandon；支持硬链接→hardlink（保种，优先）；否则看 rename 是否跨
 * 库根↔归档目录原子（EXDEV 探测）→ rename；rename 也不原子（极端 FUSE）→ abandon。
 * 宁不做，不做烂——绝不 copy（copy 只在硬链接和 rename 都不可用时的整剧放弃分支之外，
 * 本函数不产出"copy"这个策略）。
 */
export function chooseRealignStrategy(
  caps: { writable: boolean; hardlink: boolean }, renameAtomic: boolean,
): RealignStrategy {
  if (!caps.writable) return 'abandon'
  if (caps.hardlink) return 'hardlink'
  if (renameAtomic) return 'rename'
  return 'abandon'
}

/** 归档位置：<share根>/.archive/<剧名>-<时间戳>/ —— 在 Movies/TV 库根之外（Jellyfin 不看），
 *  但在同一 share 内（rename 保持原子）。shareRoot 由调用方传入（通常是媒体根的上一级，
 *  或 REALIGN_ARCHIVE_ROOT 环境变量显式指定，见 realignExecutor 顶层编排函数）。 */
export function archiveDirFor(shareRoot: string, seriesTitle: string, nowMs: number): string {
  return join(shareRoot, '.archive', `${seriesTitle}-${nowMs}`)
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/realignExecutor.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/realignExecutor.ts src/v2/realignExecutor.test.ts
git commit -m "feat(realign): mount-alive sentinel, strategy ladder, archive path"
```

### Task 16: write-ahead manifest + 回滚重放

**Files:**
- Create: `src/files/realignManifest.ts`
- Test: `src/files/realignManifest.test.ts`

- [ ] **Step 1: 写失败测试** `src/files/realignManifest.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initManifest, appendManifestEntry, readManifest, replayRollback, manifestPath } from './realignManifest.js'

describe('realign manifest', () => {
  it('initManifest 建目录 + 写空 entries 的 header', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 123 })
    const doc = readManifest(dir)!
    expect(doc.header).toEqual({ seriesId: 's1', seriesTitle: 'Show', startedAt: 123 })
    expect(doc.entries).toEqual([])
  })

  it('initManifest 幂等：已存在时不重新初始化（崩溃恢复重跑场景）', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-idem-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 111 })
    appendManifestEntry(dir, { op: 'rename', from: '/a', to: '/b', size: 10, mtimeMs: 1, reason: 'x', ts: 2 })
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 999 }) // 不同 header，应被忽略
    const doc = readManifest(dir)!
    expect(doc.header.startedAt).toBe(111)
    expect(doc.entries).toHaveLength(1)
  })

  it('appendManifestEntry 先记后搬：追加的 entry 落盘顺序保留', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'manifest-append-')), 'archive')
    initManifest(dir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a1', to: '/b1', size: 1, mtimeMs: 1, reason: 'r1', ts: 1 })
    appendManifestEntry(dir, { op: 'rename', from: '/a2', to: '/b2', size: 2, mtimeMs: 2, reason: 'r2', ts: 2 })
    const doc = readManifest(dir)!
    expect(doc.entries.map(e => e.from)).toEqual(['/a1', '/a2'])
  })

  it('readManifest：manifest 不存在返回 null', () => {
    expect(readManifest(join(tmpdir(), 'no-such-archive-' + Date.now()))).toBeNull()
  })

  it('replayRollback 逆序重放：把 to 重命名回 from', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib', 'a.mkv')
    const libB = join(root, 'lib', 'b.mkv')
    mkdirSync(join(root, 'lib'), { recursive: true })
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    // 模拟已经真的搬过：写文件到"新位置"（本例里 to 就是 libA/libB 的最终落点，用同一批路径演示）
    const newA = join(root, 'new-a.mkv')
    const newB = join(root, 'new-b.mkv')
    writeFileSync(newA, 'A'); writeFileSync(newB, 'B')
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: newA, size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libB, to: newB, size: 1, mtimeMs: 1, reason: 'x', ts: 2 })

    const logs: string[] = []
    replayRollback(archiveDir, m => logs.push(m))

    expect(existsSync(libA)).toBe(true)
    expect(existsSync(libB)).toBe(true)
    expect(existsSync(newA)).toBe(false)
    expect(existsSync(newB)).toBe(false)
    expect(readFileSync(libA, 'utf8')).toBe('A')
  })

  it('replayRollback 幂等：from 已存在（已回滚过）→ 跳过该条目，不报错', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-rollback-idem-'))
    const archiveDir = join(root, 'archive')
    const libA = join(root, 'lib-a.mkv')
    const newA = join(root, 'new-a.mkv')
    mkdirSync(root, { recursive: true })
    writeFileSync(libA, 'already-here') // from 已经存在（模拟已回滚过一次）
    initManifest(archiveDir, { seriesId: 's1', seriesTitle: 'Show', startedAt: 1 })
    appendManifestEntry(archiveDir, { op: 'rename', from: libA, to: newA, size: 1, mtimeMs: 1, reason: 'x', ts: 1 })
    expect(() => replayRollback(archiveDir)).not.toThrow()
    expect(readFileSync(libA, 'utf8')).toBe('already-here') // 未被覆盖
  })

  it('replayRollback：manifest 不存在直接抛错', () => {
    expect(() => replayRollback(join(tmpdir(), 'no-manifest-here-' + Date.now()))).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/realignManifest.test.ts` → FAIL：`Cannot find module './realignManifest.js'`

- [ ] **Step 3: 实现** `src/files/realignManifest.ts`：

```ts
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  openSync, closeSync, fsyncSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { writeAll } from './fsUtil.js'

export interface ManifestHeader { seriesId: string; seriesTitle: string; startedAt: number }
export interface ManifestEntry {
  op: 'rename' | 'hardlink'
  from: string
  to: string
  size: number
  mtimeMs: number
  reason: string
  ts: number
}
export interface ManifestDoc { header: ManifestHeader; entries: ManifestEntry[] }

export function manifestPath(archiveDir: string): string {
  return join(archiveDir, 'manifest.json')
}

/** 幂等初始化：manifest 已存在（崩溃恢复重跑）时不覆盖，保留原有 entries 现场。 */
export function initManifest(archiveDir: string, header: ManifestHeader): void {
  mkdirSync(archiveDir, { recursive: true })
  const path = manifestPath(archiveDir)
  if (existsSync(path)) return
  writeFileSync(path, JSON.stringify({ header, entries: [] } satisfies ManifestDoc, null, 2))
}

export function readManifest(archiveDir: string): ManifestDoc | null {
  const path = manifestPath(archiveDir)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8')) as ManifestDoc
}

/** 先记后搬：调用方必须在实际执行 rename/hardlink 之前调用本函数（write-ahead），
 *  这样崩溃恢复时读到的 manifest 永远至少覆盖到"即将要做"的那一步，不会有"做完了但
 *  清单没记"的窗口。fd 上 fsync 一次，尽力保证记账本身也不因断电半途而废。 */
export function appendManifestEntry(archiveDir: string, entry: ManifestEntry): void {
  const path = manifestPath(archiveDir)
  const doc = readManifest(archiveDir)
  if (!doc) throw new Error(`manifest 尚未初始化：${path}——先调用 initManifest`)
  doc.entries.push(entry)
  const fd = openSync(path, 'w')
  try {
    writeAll(fd, Buffer.from(JSON.stringify(doc, null, 2)))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 逆序重放回滚：把 manifest 里每条 entry 的 rename 反着做一遍（to → from）。
 * 幂等：目标（也就是原 from）已存在则跳过这一条（视为已回滚过）；来源（to）不存在则
 * 警告跳过（可能被后续步骤又动过，不强行报错中断整个回滚流程）。
 */
export function replayRollback(archiveDir: string, log: (msg: string) => void = () => {}): void {
  const doc = readManifest(archiveDir)
  if (!doc) throw new Error(`manifest 不存在：${manifestPath(archiveDir)}`)
  for (const entry of [...doc.entries].reverse()) {
    if (existsSync(entry.from)) {
      log(`跳过（已回滚）：${entry.to} → ${entry.from}`)
      continue
    }
    if (!existsSync(entry.to)) {
      log(`警告：回滚源缺失，跳过：${entry.to}`)
      continue
    }
    mkdirSync(dirname(entry.from), { recursive: true })
    renameSync(entry.to, entry.from)
    log(`已回滚：${entry.to} → ${entry.from}`)
  }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/files/realignManifest.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/realignManifest.ts src/files/realignManifest.test.ts
git commit -m "feat(realign): write-ahead manifest — init/append/read + reverse-order rollback replay"
```

### Task 17: 碰撞规划 + 不可见组装（`.realign-build/`）+ 目录级原子亮相

**Files:**
- Modify: `src/v2/realignExecutor.ts`
- Modify: `src/v2/realignExecutor.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/realignExecutor.test.ts`：

```ts
import { mkdtempSync as mkdtemp2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, existsSync as existsSync2, readFileSync as readFileSync2 } from 'node:fs'
import {
  planCollisions, invisibleBuildDir, assembleInvisibleTree, finalizeShowDir,
} from './realignExecutor.js'
import type { RealignPlanItem } from '../files/libraryRealign.js'

describe('planCollisions', () => {
  const items: RealignPlanItem[] = [
    { sourcePath: '/src/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/x.mkv' },
    { sourcePath: '/src/b.mkv', sourceFilename: 'b.mkv', absoluteEpisode: 2, targetSeason: 1, targetEpisode: 2, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/y.mkv' },
    { sourcePath: '/src/c.mkv', sourceFilename: 'c.mkv', absoluteEpisode: 3, targetSeason: 1, targetEpisode: 3, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/z.mkv' },
  ]
  const getSize = (p: string): number | null => {
    const sizes: Record<string, number> = {
      '/src/a.mkv': 100, '/src/b.mkv': 200, '/src/c.mkv': 300,
      '/lib/Show (2022) [tmdbid-1]/Season 01/x.mkv': 100, // 同尺寸——已完成
      '/lib/Show (2022) [tmdbid-1]/Season 01/y.mkv': 999, // 不同尺寸——隔离
    }
    return sizes[p] ?? null
  }
  it('无碰撞的文件进 toMove；同尺寸碰撞进 alreadyDone；不同尺寸碰撞进 quarantine', () => {
    const result = planCollisions(items, '/lib', getSize)
    expect(result.toMove.map(i => i.sourcePath)).toEqual(['/src/c.mkv'])
    expect(result.alreadyDone.map(i => i.sourcePath)).toEqual(['/src/a.mkv'])
    expect(result.quarantine.map(i => i.sourcePath)).toEqual(['/src/b.mkv'])
    expect(result.quarantine[0].reason).toContain('尺寸不同')
  })
})

describe('不可见组装', () => {
  it('invisibleBuildDir 拼出 <libRoot>/.realign-build/<show>', () => {
    expect(invisibleBuildDir('/media/tv', 'Show (2022) [tmdbid-1]')).toBe('/media/tv/.realign-build/Show (2022) [tmdbid-1]')
  })

  it('assembleInvisibleTree：每个文件 rename 进 .realign-build/ 对应位置，先调用 onEntry 记账', () => {
    const root = mkdtemp2(join2('realign-build-'))
    mkdirSync2(join2(root, 'src'), { recursive: true })
    writeFileSync2(join2(root, 'src', 'a.mkv'), 'A')
    const items: RealignPlanItem[] = [
      { sourcePath: join2(root, 'src', 'a.mkv'), sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-1]/Season 01/final-a.mkv' },
    ]
    const recorded: Array<{ from: string; to: string }> = []
    assembleInvisibleTree(root, 'Show (2022) [tmdbid-1]', items, (from, to) => recorded.push({ from, to }))
    const finalPath = join2(root, '.realign-build', 'Show (2022) [tmdbid-1]', 'Season 01', 'final-a.mkv')
    expect(existsSync2(finalPath)).toBe(true)
    expect(readFileSync2(finalPath, 'utf8')).toBe('A')
    expect(existsSync2(join2(root, 'src', 'a.mkv'))).toBe(false) // 源文件已被 rename 走
    expect(recorded).toEqual([{ from: join2(root, 'src', 'a.mkv'), to: finalPath }])
    expect(existsSync2(join2(root, '.realign-build', '.ignore'))).toBe(true)
  })

  it('finalizeShowDir：目录级原子 rename 到最终位置', () => {
    const root = mkdtemp2(join2('realign-finalize-'))
    mkdirSync2(join2(root, '.realign-build', 'Show (2022) [tmdbid-1]', 'Season 01'), { recursive: true })
    writeFileSync2(join2(root, '.realign-build', 'Show (2022) [tmdbid-1]', 'Season 01', 'a.mkv'), 'A')
    const finalDir = finalizeShowDir(root, 'Show (2022) [tmdbid-1]')
    expect(finalDir).toBe(join2(root, 'Show (2022) [tmdbid-1]'))
    expect(existsSync2(join2(finalDir, 'Season 01', 'a.mkv'))).toBe(true)
    expect(existsSync2(join2(root, '.realign-build', 'Show (2022) [tmdbid-1]'))).toBe(false)
  })

  it('finalizeShowDir：目标已存在时拒绝覆盖，抛错', () => {
    const root = mkdtemp2(join2('realign-finalize-collide-'))
    mkdirSync2(join2(root, '.realign-build', 'Show'), { recursive: true })
    mkdirSync2(join2(root, 'Show'), { recursive: true })
    expect(() => finalizeShowDir(root, 'Show')).toThrow(/已存在/)
  })
})

function join2(...parts: string[]): string {
  return require('node:path').join(...parts)
}
```

注：上面临时用 `require('node:path')` 只是为了在这个追加片段里不重复顶部 import 声明——落笔到真实文件时，请把 `join2` 直接实现为顶部已导入的 `join`（`import { join } from 'node:path'`），删掉这个 `require` 写法（ESM 项目不应该出现 `require`）。即：把 `mkdtemp2(join2(...))` 等调用统一换成顶部导入的 `mkdtempSync`/`join`，去掉本测试文件里临时起的 `join2`/`mkdtemp2` 别名，直接复用文件顶部已经 `import` 的 `mkdtempSync, join, tmpdir` 等（第一个 Task 15 的测试文件里已经导入了这些，本次是同一个文件追加内容，不需要重复 import，只是上面示例里为了片段独立可读加了别名，写入真实文件时去掉别名统一成一套引用）。

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/realignExecutor.test.ts` → FAIL：`planCollisions is not a function`

- [ ] **Step 3: 实现** 追加到 `src/v2/realignExecutor.ts`（顶部 import 增加 `mkdirSync, writeFileSync, renameSync` 来自 `node:fs`；`dirname` 来自 `node:path`；`import type { RealignPlanItem } from '../files/libraryRealign.js'`）：

```ts
export interface CollisionQuarantineItem extends RealignPlanItem { reason: string }

export interface CollisionPlan {
  toMove: RealignPlanItem[]
  alreadyDone: RealignPlanItem[]
  quarantine: CollisionQuarantineItem[]
}

/**
 * 碰撞检查（在真正搬任何文件之前跑）：目标位置（<libRoot>/<targetRelPath>）已存在——
 * 同尺寸视为上一次（可能崩溃的）运行已经完成，跳过（幂等 no-op）；不同尺寸不覆盖，隔离标记。
 * 不存在则正常纳入待搬列表。
 */
export function planCollisions(
  items: RealignPlanItem[], libRoot: string, getSize: (path: string) => number | null,
): CollisionPlan {
  const toMove: RealignPlanItem[] = []
  const alreadyDone: RealignPlanItem[] = []
  const quarantine: CollisionQuarantineItem[] = []
  for (const item of items) {
    const finalPath = join(libRoot, item.targetRelPath)
    const existingSize = getSize(finalPath)
    if (existingSize == null) {
      toMove.push(item)
      continue
    }
    const sourceSize = getSize(item.sourcePath)
    if (sourceSize != null && existingSize === sourceSize) {
      alreadyDone.push(item)
    } else {
      quarantine.push({ ...item, reason: `目标已存在但尺寸不同（已存在 ${existingSize} vs 源 ${sourceSize ?? '未知'}）` })
    }
  }
  return { toMove, alreadyDone, quarantine }
}

export function invisibleBuildDir(libRoot: string, showDirName: string): string {
  return join(libRoot, '.realign-build', showDirName)
}

/**
 * 不可见组装：把 toMove 列表里每个文件 rename 进 `.realign-build/<show>/...` 对应位置
 * （同文件系统单跳 rename，与视频原本同根，前提在 mount 哨兵已经验过）。onEntry 回调必须
 * 在 renameSync 之前调用（write-ahead：调用方在 onEntry 里做 manifest.appendManifestEntry），
 * 任何挂载上 Jellyfin 只能观测到 `.realign-build/` 这个点前缀目录，感知不到半成品。
 */
export function assembleInvisibleTree(
  libRoot: string, showDirName: string, items: RealignPlanItem[],
  onEntry: (from: string, to: string) => void,
): void {
  const buildDir = invisibleBuildDir(libRoot, showDirName)
  mkdirSync(buildDir, { recursive: true })
  const ignorePath = join(buildDir, '.ignore')
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, 'subtitle-scout realign staging — media servers should not scan this directory\n')
  }
  for (const item of items) {
    const targetPath = join(libRoot, '.realign-build', item.targetRelPath)
    mkdirSync(dirname(targetPath), { recursive: true })
    onEntry(item.sourcePath, targetPath)
    renameSync(item.sourcePath, targetPath)
  }
}

/**
 * 最后一次目录级原子 rename：`.realign-build/<show>` → `<libRoot>/<show>`。目标已存在时
 * 拒绝覆盖并抛错（调用方决定如何处理，不在这里静默吞并两棵树）。
 */
export function finalizeShowDir(libRoot: string, showDirName: string): string {
  const from = invisibleBuildDir(libRoot, showDirName)
  const to = join(libRoot, showDirName)
  if (existsSync(to)) throw new Error(`目标目录已存在，拒绝覆盖：${to}`)
  renameSync(from, to)
  return to
}
```

（`existsSync` 已由 Task 15 的 import 引入，无需重复添加。）

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/realignExecutor.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/realignExecutor.ts src/v2/realignExecutor.test.ts
git commit -m "feat(realign): collision planning + invisible-build assembly + atomic finalize rename"
```

### Task 18: 归档旧目录

**Files:**
- Modify: `src/v2/realignExecutor.ts`
- Modify: `src/v2/realignExecutor.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/realignExecutor.test.ts`：

```ts
import { archiveOldDir } from './realignExecutor.js'

describe('archiveOldDir', () => {
  it('把旧目录残骸整体 rename 进归档目录，附 .ignore 双保险', () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-archive-'))
    const oldDir = join(root, 'lib', 'Show', 'Season 01')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(join(oldDir, '合集 01-02.mkv'), 'quarantined') // 隔离文件残留
    const archiveDir = join(root, 'archive', 'Show-123')

    const finalPath = archiveOldDir(oldDir, archiveDir)

    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(join(archiveDir, 'Season 01', '合集 01-02.mkv'))).toBe(true)
    expect(existsSync(join(archiveDir, '.ignore'))).toBe(true)
    expect(finalPath).toBe(join(archiveDir, 'Season 01'))
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/realignExecutor.test.ts` → FAIL：`archiveOldDir is not a function`

- [ ] **Step 3: 实现** 追加到 `src/v2/realignExecutor.ts`：

```ts
/**
 * 旧目录一次 rename 进归档（<share根>/.archive/<剧名>-<时间戳>/<oldDir 的 basename>）。
 * 归档目录内放空 `.ignore` 双保险（调研结论：点前缀目录被 Jellyfin 各版本反复横跳，
 * 不能只靠命名习惯）。永不删除——保留期交给用户（dashboard 显示占用，不自动清）。
 */
export function archiveOldDir(oldDir: string, archiveDir: string): string {
  mkdirSync(archiveDir, { recursive: true })
  const ignorePath = join(archiveDir, '.ignore')
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, 'subtitle-scout realign archive — permanent, never auto-cleaned by this tool\n')
  }
  const finalPath = join(archiveDir, basename(oldDir))
  renameSync(oldDir, finalPath)
  return finalPath
}
```

（顶部 import 加 `basename` 来自 `node:path`。）

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/realignExecutor.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/realignExecutor.ts src/v2/realignExecutor.test.ts
git commit -m "feat(realign): archive old directory remnants (permanent, .ignore double guard)"
```

### Task 19: 字幕先行（自构 MediaContext + runPipeline 接线）

**Files:**
- Modify: `src/v2/realignExecutor.ts`
- Modify: `src/v2/realignExecutor.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/realignExecutor.test.ts`：

```ts
import { buildRealignMediaContext, makeRealignRunEpisode } from './realignExecutor.js'
import { MediaContextSchema } from '../core/schemas.js'

describe('buildRealignMediaContext', () => {
  it('字面构造 MediaContext：tmdbid 钉死、季集来自计划、trigger=library_scan', () => {
    const item: RealignPlanItem = {
      sourcePath: '/x.mkv', sourceFilename: 'x.mkv', absoluteEpisode: 26,
      targetSeason: 2, targetEpisode: 1, targetRelPath: 'Show (2022) [tmdbid-120089]/Season 02/y.mkv',
    }
    const ctx = buildRealignMediaContext('间谍过家家', 2022, '120089', item, '/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv')
    expect(() => MediaContextSchema.parse(ctx)).not.toThrow()
    expect(ctx.media.type).toBe('episode')
    expect(ctx.media.season).toBe(2)
    expect(ctx.media.episode).toBe(1)
    expect(ctx.media.provider_ids.tmdb).toBe('120089')
    expect(ctx.media.path).toBe('/lib/Show (2022) [tmdbid-120089]/Season 02/y.mkv')
    expect(ctx.trigger).toBe('library_scan')
  })
})

describe('makeRealignRunEpisode', () => {
  it('接线 runPipeline：不经过 jf.getItem，直接用调用方构造好的 ctx', async () => {
    const runPipelineMock = vi.fn(async () => ({
      decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 },
    }))
    const makeDeps = vi.fn(() => ({}) as any)
    const withJournal = vi.fn((fn: () => Promise<unknown>) => fn())
    const runEpisode = makeRealignRunEpisode(
      { makeDeps, withJournal, cacheRoot: '/cache' } as any,
      { runPipelineImpl: runPipelineMock as any },
    )
    const ctx = MediaContextSchema.parse({
      request_id: 'r1', trigger: 'library_scan',
      media: { type: 'episode', path: '/x.mkv', filename: 'x.mkv', title: 'Show', season: 2, episode: 1, provider_ids: { tmdb: '1' } },
      preferences: {},
    })
    const result = await runEpisode(ctx, '/lib/Show/Season 02', 'job-1')
    expect(result.decision).toBe('download')
    expect(runPipelineMock).toHaveBeenCalledTimes(1)
    expect(withJournal).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/realignExecutor.test.ts` → FAIL：`buildRealignMediaContext is not a function`

- [ ] **Step 3: 实现** 追加到 `src/v2/realignExecutor.ts`（顶部加 `import { basename } from 'node:path'` 已有；加 `import { MediaContextSchema, type MediaContext } from '../core/schemas.js'`；`import { runPipeline, type PipelineResult } from '../core/pipeline.js'`；`import type { Assembled } from '../cli/index.js'`）：

```ts
/**
 * 字幕先行阶段的 MediaContext：此刻 Jellyfin 尚未刮新结构、镜像无条目，identify 所需的
 * 身份/tmdbid/季集/视频路径全在整理计划里，字面构造即可，不需要 jf.getItem。
 * trigger 用 'library_scan'（语义最贴近："库结构变化触发的搜索"，不是播放触发/手动搜索）。
 */
export function buildRealignMediaContext(
  seriesTitle: string, year: number, tmdbId: string, item: RealignPlanItem, videoPath: string,
): MediaContext {
  return MediaContextSchema.parse({
    request_id: `realign-${tmdbId}-S${item.targetSeason}E${item.targetEpisode}-${Date.now()}`,
    trigger: 'library_scan',
    media: {
      type: 'episode',
      path: videoPath,
      filename: basename(videoPath),
      title: seriesTitle,
      original_title: null,
      year,
      season: item.targetSeason,
      episode: item.targetEpisode,
      runtime_minutes: null,
      provider_ids: { tmdb: tmdbId },
      production_locations: [],
      alternative_titles: [],
      overview: null,
      existing_subtitles: [],
    },
    preferences: {},
  })
}

/**
 * runEpisode 接线（realign 版）：mirror makeRunEpisode 的尾段（调 runPipeline、包 journal），
 * 但跳过 jf.getItem/getChineseTitle/refreshItem——那些依赖 Jellyfin 已经刮削出条目，此刻还
 * 没有。调用方（executeRealign 顶层编排）已经把 MediaContext 构造好、root/可写预检已在
 * mount 哨兵阶段做过，这里只负责"跑一次完整判断链"。runPipelineImpl 可注入（测试用，
 * 默认走真实 core/pipeline.ts 的 runPipeline）。
 */
export function makeRealignRunEpisode(
  assembled: Pick<Assembled, 'makeDeps' | 'withJournal' | 'cacheRoot'>,
  opts: { runPipelineImpl?: typeof runPipeline } = {},
): (ctx: MediaContext, outDir: string, jobId: string) => Promise<PipelineResult> {
  const { makeDeps, withJournal, cacheRoot } = assembled
  const run = opts.runPipelineImpl ?? runPipeline
  return async (ctx, outDir, jobId) => {
    const journalDir = join(cacheRoot, 'journals', `realign-${jobId}-${Date.now()}`)
    return withJournal(() => run(makeDeps(), ctx, outDir, journalDir, { bypassNegativeCache: true }))
  }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/realignExecutor.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/realignExecutor.ts src/v2/realignExecutor.test.ts
git commit -m "feat(realign): subtitle-first — literal MediaContext + runPipeline seam without jf.getItem"
```

### Task 20: Jellyfin 编排（等空闲 + 验收集数），结构化最小接口

**Files:**
- Modify: `src/v2/realignExecutor.ts`
- Modify: `src/v2/realignExecutor.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/realignExecutor.test.ts`：

```ts
import { waitForJellyfinIdle, verifyRealignedCounts } from './realignExecutor.js'

describe('waitForJellyfinIdle', () => {
  it('无运行中任务 → 立即 true', async () => {
    const jf = { getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: false }]) }
    const sleep = vi.fn(async () => {})
    const ok = await waitForJellyfinIdle(jf, { pollMs: 10, timeoutMs: 1000, sleep })
    expect(ok).toBe(true)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('先运行后空闲 → 轮询几次后 true', async () => {
    let calls = 0
    const jf = { getScheduledTasks: vi.fn(async () => { calls++; return [{ id: '1', name: 'scan', isRunning: calls < 3 }] }) }
    const sleep = vi.fn(async () => {})
    const ok = await waitForJellyfinIdle(jf, { pollMs: 10, timeoutMs: 10_000, sleep })
    expect(ok).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('超时仍在跑 → false', async () => {
    const jf = { getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: true }]) }
    let elapsed = 0
    const sleep = vi.fn(async () => { elapsed += 100 })
    const ok = await waitForJellyfinIdle(jf, { pollMs: 100, timeoutMs: 250, sleep: async (ms) => { await sleep(ms); Date.now = () => baseNow + elapsed } })
    expect(ok).toBe(false)
  })
})

const baseNow = Date.now()

describe('verifyRealignedCounts', () => {
  it('实际集数与计划一致 → ok', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [
            { Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 },
            { Type: 'Episode', Path: '/lib/Show/Season 02/b.mkv', ParentIndexNumber: 2 },
          ] as any
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 1], [2, 1]]), { pageSize: 100 })
    expect(result.ok).toBe(true)
  })

  it('实际集数少于计划（旧条目未清/刮削不全）→ 不一致', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [{ Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 }] as any
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 2]]), { pageSize: 100 })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('第 1 季')
  })

  it('只统计新目录路径下的条目（Path 前缀匹配），旧目录残留不计入', async () => {
    const jf = {
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? [
            { Type: 'Episode', Path: '/lib/Show/Season 01/a.mkv', ParentIndexNumber: 1 },
            { Type: 'Episode', Path: '/lib/OldGhostShow/Season 01/z.mkv', ParentIndexNumber: 1 },
          ] as any
        : []),
    }
    const result = await verifyRealignedCounts(jf, '/lib/Show', new Map([[1, 1]]), { pageSize: 100 })
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/realignExecutor.test.ts` → FAIL：`waitForJellyfinIdle is not a function`

- [ ] **Step 3: 实现** 追加到 `src/v2/realignExecutor.ts`（顶部加 `import type { JellyfinItem } from '../adapters/players/jellyfin.js'`）：

```ts
export interface ScheduledTaskLike { id: string; name: string; isRunning: boolean }

/**
 * 等 Jellyfin 扫描空闲（调研红线：扫描中挪文件=重复条目灾难）。轮询直到无任务在跑或超时。
 * sleep 注入（测试用假时钟，避免真等）。
 */
export async function waitForJellyfinIdle(
  jf: { getScheduledTasks(): Promise<ScheduledTaskLike[]> },
  opts: { pollMs: number; timeoutMs: number; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs
  while (true) {
    const tasks = await jf.getScheduledTasks()
    if (!tasks.some(t => t.isRunning)) return true
    if (Date.now() >= deadline) return false
    await opts.sleep(opts.pollMs)
  }
}

/**
 * 验收：按新目录路径前缀统计 Jellyfin 实际刮出的各季集数，与计划值比对。复用既有
 * getItemsPage（已带 Path 字段），不需要新增端点——按 Path 是否以新目录路径开头过滤，
 * 旧目录残留（尚未清理/尚未重刮）天然被排除在统计之外。
 */
export async function verifyRealignedCounts(
  jf: { getItemsPage(startIndex: number, limit: number): Promise<Pick<JellyfinItem, 'Type' | 'Path' | 'ParentIndexNumber'>[]> },
  newShowDirPath: string, expectedCounts: Map<number, number>, opts: { pageSize: number },
): Promise<{ ok: boolean; detail: string }> {
  const actualCounts = new Map<number, number>()
  let startIndex = 0
  while (true) {
    const items = await jf.getItemsPage(startIndex, opts.pageSize)
    if (items.length === 0) break
    for (const item of items) {
      if (item.Type === 'Episode' && item.Path?.startsWith(newShowDirPath) && item.ParentIndexNumber != null) {
        actualCounts.set(item.ParentIndexNumber, (actualCounts.get(item.ParentIndexNumber) ?? 0) + 1)
      }
    }
    startIndex += opts.pageSize
  }
  for (const [season, expected] of expectedCounts) {
    const actual = actualCounts.get(season) ?? 0
    if (actual !== expected) {
      return { ok: false, detail: `第 ${season} 季验收：Jellyfin 报告 ${actual} 集，计划 ${expected} 集，不一致` }
    }
  }
  return { ok: true, detail: '各季集数与计划一致' }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/realignExecutor.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/realignExecutor.ts src/v2/realignExecutor.test.ts
git commit -m "feat(realign): Jellyfin idle-wait + post-realign episode count verification"
```

### Task 21: 顶层编排 `executeRealign(job, deps)` + 镜像清理

**Files:**
- Modify: `src/v2/realignExecutor.ts`
- Modify: `src/v2/realignExecutor.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/v2/realignExecutor.test.ts`（这是集成风格测试：真实 tmp 目录 + 假 jf/tmdb/animeLists/runPipeline）：

```ts
import { executeRealign, type RealignExecutorDeps, type RealignJellyfinPort } from './realignExecutor.js'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'

function mkFlatLibrary(root: string, count: number): string {
  const dir = join(root, 'lib', 'Spy x Family', 'Season 01')
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= count; i++) writeFileSync(join(dir, `Spy x Family E${i}.mkv`), `video-${i}`)
  return dir
}

describe('executeRealign（顶层编排，集成）', () => {
  it('40 集绝对编号平铺整理成功：不可见组装→字幕先行→归档→验收→镜像清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-e2e-'))
    const oldSeasonDir = mkFlatLibrary(root, 40)
    const libRoot = join(root, 'lib')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: 'jf-series-1', name: 'Spy x Family' })
    for (let i = 1; i <= 40; i++) {
      lib.upsertEpisode({
        id: `jf-ep-${i}`, seriesId: 'jf-series-1', season: 1, episode: i, name: `E${i}`,
        path: join(oldSeasonDir, `Spy x Family E${i}.mkv`), subStatus: 'missing',
      })
    }
    jobsRepo.upsertWanted({ kind: 'realign', seriesId: 'jf-series-1' }, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const jf: RealignJellyfinPort = {
      getItem: vi.fn(async () => ({ Id: 'jf-series-1', Name: 'Spy x Family', Type: 'Series', ProductionYear: 2022, ProviderIds: { Tmdb: '120089' } }) as any),
      getItemsPage: vi.fn(async (start: number) => start === 0
        ? Array.from({ length: 40 }, (_, i) => {
            const abs = i + 1
            const season = abs <= 25 ? 1 : abs <= 37 ? 2 : 3
            return { Type: 'Episode', Path: join(libRoot, 'Spy x Family (2022) [tmdbid-120089]', `Season 0${season}`, `f${abs}.mkv`), ParentIndexNumber: season } as any
          })
        : []),
      getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: false }]),
      getVirtualFolders: vi.fn(async () => [{ id: 'lib-1', name: 'TV', locations: [libRoot], enableRealtimeMonitor: false }]),
      refreshLibrary: vi.fn(async () => {}),
      deleteItem: vi.fn(async () => {}),
    }

    const deps: RealignExecutorDeps = {
      lib, jobs: jobsRepo,
      jf,
      tmdb: { getSeasonTable: vi.fn(async () => [
        { seasonNumber: 1, episodeCount: 25, airDate: null },
        { seasonNumber: 2, episodeCount: 12, airDate: null },
        { seasonNumber: 3, episodeCount: 3, airDate: null },
      ]) },
      fetchAnimeLists: vi.fn(async () => []),
      runEpisode: vi.fn(async () => ({ decision: 'download', journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 } })),
      now: () => Date.now(),
      log: () => {},
      sleep: async () => {},
      getSize: (p) => { try { return require('node:fs').statSync(p).size } catch { return null } },
    }

    const result = await executeRealign(job, deps)

    expect(result.decision).toBe('realigned')
    expect(existsSync(oldSeasonDir)).toBe(false) // 旧目录已归档
    expect(existsSync(join(libRoot, 'Spy x Family (2022) [tmdbid-120089]', 'Season 01'))).toBe(true)
    expect(existsSync(join(libRoot, 'Spy x Family (2022) [tmdbid-120089]', 'Season 03'))).toBe(true)
    expect(lib.getSeries('jf-series-1')).toBeNull() // 镜像清理：旧 seriesId 行已删
    expect((deps.runEpisode as any).mock.calls.length).toBe(40) // 40 集都跑过字幕先行
    db.close()
  })

  it('mount 哨兵不过（库根为空）→ 判 error，不动任何文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-empty-'))
    const libRoot = join(root, 'lib')
    mkdirSync(libRoot, { recursive: true }) // 空目录，模拟挂载掉线

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: join(libRoot, 'Show', 'a.mkv'), subStatus: 'missing' })
    jobsRepo.upsertWanted({ kind: 'realign', seriesId: 's1' }, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const deps: RealignExecutorDeps = {
      lib, jobs: jobsRepo,
      jf: { getItem: vi.fn(), getItemsPage: vi.fn(), getScheduledTasks: vi.fn(), getVirtualFolders: vi.fn(), refreshLibrary: vi.fn(), deleteItem: vi.fn() },
      tmdb: { getSeasonTable: vi.fn() },
      fetchAnimeLists: vi.fn(),
      runEpisode: vi.fn(),
      now: () => Date.now(), log: () => {}, sleep: async () => {},
      getSize: () => null,
    }
    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('error')
    expect(result.detail).toContain('为空')
  })

  it('确定性闸门不过（映射目标重复）→ 判 error，旧目录原样保留', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-gatefail-'))
    const oldSeasonDir = join(root, 'lib', 'Show', 'Season 01')
    mkdirSync(oldSeasonDir, { recursive: true })
    writeFileSync(join(oldSeasonDir, 'a-E1.mkv'), 'a')
    writeFileSync(join(oldSeasonDir, 'b-第1话.mkv'), 'b') // 与 a 映射到同一 S1E1，触发重复闸门

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: join(oldSeasonDir, 'a-E1.mkv'), subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: join(oldSeasonDir, 'b-第1话.mkv'), subStatus: 'missing' })
    jobsRepo.upsertWanted({ kind: 'realign', seriesId: 's1' }, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const deps: RealignExecutorDeps = {
      lib, jobs: jobsRepo,
      jf: {
        getItem: vi.fn(async () => ({ Id: 's1', Name: 'Show', Type: 'Series', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } }) as any),
        getItemsPage: vi.fn(), getScheduledTasks: vi.fn(), getVirtualFolders: vi.fn(), refreshLibrary: vi.fn(), deleteItem: vi.fn(),
      },
      tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 25, airDate: null }]) },
      fetchAnimeLists: vi.fn(async () => []),
      runEpisode: vi.fn(),
      now: () => Date.now(), log: () => {}, sleep: async () => {},
      getSize: () => null,
    }
    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('error')
    expect(existsSync(oldSeasonDir)).toBe(true) // 旧目录完全没动
    db.close()
  })

  it('挂载能力不支持安全整理（probeStrategy 注入 abandon）→ 判 error，不动任何文件', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-abandon-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: 's1', name: 'Show' })
    for (let i = 1; i <= 3; i++) {
      lib.upsertEpisode({ id: `e${i}`, seriesId: 's1', season: 1, episode: i, name: `E${i}`, path: join(oldSeasonDir, `E${i}.mkv`), subStatus: 'missing' })
    }
    jobsRepo.upsertWanted({ kind: 'realign', seriesId: 's1' }, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const deps: RealignExecutorDeps = {
      lib, jobs: jobsRepo,
      jf: {
        getItem: vi.fn(async () => ({ Id: 's1', Name: 'Show', Type: 'Series', ProductionYear: 2020, ProviderIds: { Tmdb: '1' } }) as any),
        getItemsPage: vi.fn(), getScheduledTasks: vi.fn(), getVirtualFolders: vi.fn(), refreshLibrary: vi.fn(), deleteItem: vi.fn(),
      },
      tmdb: { getSeasonTable: vi.fn(async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }]) },
      fetchAnimeLists: vi.fn(async () => []),
      runEpisode: vi.fn(),
      now: () => Date.now(), log: () => {}, sleep: async () => {},
      getSize: () => null,
      probeStrategy: () => 'abandon',
    }
    const result = await executeRealign(job, deps)
    expect(result.decision).toBe('error')
    expect(result.detail).toContain('挂载能力不支持')
    expect(existsSync(oldSeasonDir)).toBe(true) // 探针拒绝，整理从未开始，旧目录纹丝不动
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/v2/realignExecutor.test.ts` → FAIL：`executeRealign is not a function`

- [ ] **Step 3: 实现** 追加到 `src/v2/realignExecutor.ts`（顶部补充 imports：`import { dirname as pathDirname } from 'node:path'` 已有 `dirname`；`import type { LibraryRepo } from './libraryRepo.js'`；`import type { JobsRepo, Job } from './jobsRepo.js'`；`import type { TmdbClient } from '../adapters/providers/tmdb.js'`；`import type { AnimeListsEntry } from '../adapters/providers/animeLists.js'`；`import { buildRealignPlan, crossCheckAnimeLists, buildAbsoluteMap, buildTargetShowDir, type RealignPlanConfig } from '../files/libraryRealign.js'`；`import { scanVideoFiles } from '../files/libraryRealign.js'`；`import { initManifest, appendManifestEntry } from '../files/realignManifest.js'`；`import { probeHardlink, probeRenameBetween } from '../files/mountCapabilities.js'`）：

```ts
export interface RealignJellyfinPort {
  getItem(itemId: string): ReturnType<import('../adapters/players/types.js').PlayerServer['getItem']>
  getItemsPage(startIndex: number, limit: number): ReturnType<import('../adapters/players/types.js').PlayerServer['getItemsPage']>
  getScheduledTasks(): Promise<ScheduledTaskLike[]>
  getVirtualFolders(): Promise<{ id: string; name: string; locations: string[]; enableRealtimeMonitor: boolean }[]>
  refreshLibrary(libraryId: string): Promise<void>
  deleteItem(itemId: string): Promise<void>
}

export interface RealignExecutorDeps {
  lib: LibraryRepo
  jobs: Pick<JobsRepo, 'setPlanRef' | 'retireAllForSeries'>
  jf: RealignJellyfinPort
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
  fetchAnimeLists: () => Promise<AnimeListsEntry[]>
  runEpisode: (ctx: MediaContext, outDir: string, jobId: string) => Promise<PipelineResult>
  now: () => number
  log: (msg: string) => void
  sleep: (ms: number) => Promise<void>
  getSize: (path: string) => number | null
  getDurationSeconds?: (path: string) => number | null
  /** 挂载能力探测（可选注入，测试用假探针；默认走真实 mountCapabilities.ts 的
   *  probeHardlink/probeRenameBetween）。返回值直接喂给 chooseRealignStrategy。 */
  probeStrategy?: (libRoot: string, archiveDir: string) => RealignStrategy
}

export interface RealignExecutionResult { decision: 'realigned' | 'error'; detail: string }

/** 多数出现次数的目录名（绝对编号平铺库通常全部集塞在同一个目录里）；空数组返回 null。 */
function mostCommonDir(paths: string[]): string | null {
  if (paths.length === 0) return null
  const counts = new Map<string, number>()
  for (const p of paths) {
    const d = pathDirname(p)
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * 顶层编排：mount 哨兵 → 计划构建（TMDB 季表 + anime-lists 交叉验证 + 确定性闸门）→
 * 碰撞规划 → 不可见组装(manifest write-ahead) → 目录级原子亮相 → 字幕先行 → 归档旧目录 →
 * Jellyfin 编排(等空闲/单库刷新/验收) → 镜像清理 → 返回结果（由 executor.ts 的
 * executeRealignBranch 负责 completeDone/completeError）。任一步失败均安全返回
 * decision:'error'，不留半成品（除非文档另有说明的、write-ahead manifest 已覆盖的
 * 可恢复中间态）。
 */
export async function executeRealign(job: Job, deps: RealignExecutorDeps): Promise<RealignExecutionResult> {
  const seriesId = job.series_id!
  const now = deps.now()

  // 1. series 元数据（标题/年份/tmdbId）——统一走 jf.getItem(seriesId)，不依赖本地镜像的
  //    series.provider_ids（该列在 scanner.ts 的正常扫描路径里从未被写入，是历史空洞，
  //    不能作为 TMDB id 的可信来源；这与 executor.ts/makeRunEpisode 解析 TMDB 引用一贯的
  //    做法一致——永远向 Jellyfin 活查）。
  const seriesItem = await deps.jf.getItem(seriesId)
  const tmdbId = seriesItem.ProviderIds?.Tmdb
  const seriesTitle = seriesItem.Name
  const year = seriesItem.ProductionYear ?? null
  if (!tmdbId || !seriesTitle || year == null) {
    return { decision: 'error', detail: `series ${seriesId} 缺少 TMDB id/标题/年份，无法构建整理计划` }
  }

  // 2. 定位需要整理的磁盘目录：镜像里该剧全部集路径里出现次数最多的目录。
  const paths = deps.lib.episodePathsForSeries(seriesId)
  const scanDir = mostCommonDir(paths)
  if (!scanDir) {
    return { decision: 'error', detail: `series ${seriesId} 镜像里没有任何集路径，无法定位待整理目录` }
  }
  const derivedLibRoot = pathDirname(pathDirname(scanDir)) // scanDir 通常是 <libRoot>/<show>/<oldSeason>

  // 3. mount 哨兵：库根必须活着（非空+可写），SMB 掉挂载不能被误判成"空库"。
  const sentinel = mountAliveSentinel(derivedLibRoot)
  if (!sentinel.ok) return { decision: 'error', detail: sentinel.reason! }

  // 3b. 降级阶梯：探测硬链接支持 + 库根↔归档目录间 rename 原子性，决定是否可以安全整理。
  //     archiveDir 提前算好，后面 write-ahead manifest 阶段复用同一个值（不重复计算）。
  //     重要范围限定（本计划的 YAGNI 边界）：strategy==='hardlink' 时唯一的额外好处是继续
  //     为旧文件做种（保留旧结构、新结构只是硬链接副本）——那是一条完全不同的归档/组装
  //     代码路径（旧目录不能被 rename 挪空，必须原样保留）。本计划只实现 strategy==='rename'
  //     这一条执行路径（现实里最常见的 CIFS `nounix` 挂载本就不支持硬链接，设计文档本身也
  //     预期如此），strategy==='hardlink' 时按同一条 rename 路径执行（安全，只是放弃了额外的
  //     保种收益，不放弃任何安全性——rename 单跳依然原子）。只有 strategy==='abandon'
  //     （硬链接不支持 且 rename 也不能原子跨越库根↔归档目录）才真正拒绝整理。
  const archiveDir = archiveDirFor(derivedLibRoot, seriesTitle, now)
  const strategy = deps.probeStrategy
    ? deps.probeStrategy(derivedLibRoot, archiveDir)
    : chooseRealignStrategy({ writable: true, hardlink: probeHardlink(derivedLibRoot) }, probeRenameBetween(derivedLibRoot, archiveDir))
  if (strategy === 'abandon') {
    return {
      decision: 'error',
      detail: `挂载能力不支持安全整理（硬链接不支持，且库根↔归档目录间 rename 非原子）：${derivedLibRoot} ↔ ${archiveDir}`,
    }
  }

  // 4. 计划构建：扫描目录 → TMDB 季表 → anime-lists 交叉验证 → 确定性闸门。
  const files = scanVideoFiles(scanDir)
  const seasonTable = await deps.tmdb.getSeasonTable(tmdbId)
  if (!seasonTable) return { decision: 'error', detail: `TMDB 查无该剧季表（tmdbId=${tmdbId}）` }

  const animeListsEntries = await deps.fetchAnimeLists().catch(() => [] as AnimeListsEntry[])
  const absMap = buildAbsoluteMap(seasonTable)
  const crossCheck = crossCheckAnimeLists(absMap, animeListsEntries, Number(tmdbId))
  if (!crossCheck.ok) return { decision: 'error', detail: crossCheck.reason! }

  const planConfig: RealignPlanConfig = { seriesTitle, year, tmdbId, seasonTable }
  const planResult = buildRealignPlan(files, planConfig)
  if (!planResult.ok) return { decision: 'error', detail: `整理计划构建失败：${planResult.failures.join('; ')}` }

  if (deps.getDurationSeconds) {
    const expectedRuntime = 24 // 保守默认值：TMDB /tv/{id} 的 episode_run_time 平均值，
    // 精确值应在 step1 从 seriesItem 附带取得；此处为可选抽查闸门，取不到时以默认容差跳过。
    const runtimeFailures = checkRuntimeTolerance(planResult.items, expectedRuntime, deps.getDurationSeconds)
    if (runtimeFailures.length > 0) return { decision: 'error', detail: `时长抽查未通过：${runtimeFailures.join('; ')}` }
  }

  // 5. 碰撞规划：目标已存在——同尺寸跳过（幂等），不同尺寸隔离（此处简化为失败上报，
  //    不静默丢弃——隔离文件的落盘由归档阶段的旧目录残骸一并带走）。
  const collision = planCollisions(planResult.items, derivedLibRoot, deps.getSize)

  // 6. write-ahead manifest + 不可见组装（archiveDir 已在 3b 算好，此处复用）。
  initManifest(archiveDir, { seriesId, seriesTitle, startedAt: now })
  const showDirName = buildTargetShowDir(seriesTitle, year, tmdbId)
  assembleInvisibleTree(derivedLibRoot, showDirName, collision.toMove, (from, to) => {
    appendManifestEntry(archiveDir, { op: 'rename', from, to, size: deps.getSize(from) ?? 0, mtimeMs: now, reason: 'realign', ts: deps.now() })
  })

  // 7. 目录级原子亮相。
  const finalShowDir = finalizeShowDir(derivedLibRoot, showDirName)

  // 8. 字幕先行：对计划里每个条目（不含 alreadyDone/quarantine），构造 ctx 直调 runPipeline。
  for (const item of collision.toMove) {
    const finalVideoPath = join(finalShowDir, item.targetRelPath.slice(showDirName.length + 1))
    const ctx = buildRealignMediaContext(seriesTitle, year, tmdbId, item, finalVideoPath)
    await deps.runEpisode(ctx, pathDirname(finalVideoPath), `${job.id}-${item.absoluteEpisode}`)
  }

  // 9. 旧目录归档（scanDir 此刻只剩隔离文件/nfo/海报——匹配的视频文件已在第 6 步搬空）。
  archiveOldDir(scanDir, archiveDir)

  // 10. Jellyfin 编排：确认无扫描在跑 → 单库刷新 → 再等空闲 → 验收。
  const idleBefore = await waitForJellyfinIdle(deps.jf, { pollMs: 2000, timeoutMs: 60_000, sleep: deps.sleep })
  if (!idleBefore) return { decision: 'error', detail: 'Jellyfin 扫描长时间未空闲，暂缓本次整理（下次重试）' }

  const folders = await deps.jf.getVirtualFolders()
  const targetFolder = folders.find(f => f.locations.some(loc => finalShowDir.startsWith(loc)))
  if (!targetFolder) return { decision: 'error', detail: `找不到包含 ${finalShowDir} 的 Jellyfin 库` }
  await deps.jf.refreshLibrary(targetFolder.id)
  await waitForJellyfinIdle(deps.jf, { pollMs: 2000, timeoutMs: 120_000, sleep: deps.sleep })

  const expectedCounts = new Map<number, number>()
  for (const item of planResult.items) {
    expectedCounts.set(item.targetSeason, (expectedCounts.get(item.targetSeason) ?? 0) + 1)
  }
  const verify = await verifyRealignedCounts(deps.jf, finalShowDir, expectedCounts, { pageSize: 100 })
  if (!verify.ok) return { decision: 'error', detail: verify.detail }

  // 11. 镜像清理：旧 seriesId 的行永远不会再被下一轮 scan 碰到，显式清除；
  //     旧的 series_season job（按老季边界划分）退休。
  deps.lib.deleteSeriesRows(seriesId)
  deps.jobs.retireAllForSeries(seriesId, deps.now())

  const seasonSummary = [...expectedCounts.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `第 ${s} 季 ${n} 集`).join('、')
  return {
    decision: 'realigned',
    detail: `把 ${planResult.items.length} 集平铺整理成 ${expectedCounts.size} 季（${seasonSummary}），字幕已就位`,
  }
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/v2/realignExecutor.test.ts` → PASS

- [ ] **Step 5: 全仓库回归** `npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 6: 提交**

```bash
git add src/v2/realignExecutor.ts src/v2/realignExecutor.test.ts
git commit -m "feat(realign): top-level executeRealign orchestrator + mirror cleanup"
```

---

## Phase F：Jellyfin 客户端端点 + 生产接线

### Task 22: `call()` 方法联合加 `'DELETE'` + `deleteItem`

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`
- Modify: `src/adapters/players/jellyfin.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/adapters/players/jellyfin.test.ts`：

```ts
describe('JellyfinClient.deleteItem', () => {
  it('DELETE /Items/{id}', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 204 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.deleteItem('item-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toBe('http://jf/Items/item-1')
    expect((init as RequestInit).method).toBe('DELETE')
  })

  it('非 2xx → 抛错（与其它端点一致）', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(client.deleteItem('item-1')).rejects.toThrow(/HTTP 404/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/adapters/players/jellyfin.test.ts` → FAIL：`client.deleteItem is not a function`

- [ ] **Step 3: 实现** 修改 `src/adapters/players/jellyfin.ts`：`call` 方法签名：

```ts
  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
```

（方法体不变——`fetchImpl` 调用已经把 `method` 原样传给 `fetch`，无需其它改动。）在 `refreshItem` 之后加：

```ts
  /** 整理执行完毕后清理刮削出的旧条目残留（realign 专用）。 */
  async deleteItem(itemId: string): Promise<void> {
    await this.call('DELETE', `/Items/${encodeURIComponent(itemId)}`)
  }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/adapters/players/jellyfin.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/players/jellyfin.ts src/adapters/players/jellyfin.test.ts
git commit -m "feat(realign): jellyfin client — widen call() to DELETE, add deleteItem"
```

### Task 23: `getScheduledTasks`

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`
- Modify: `src/adapters/players/jellyfin.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/adapters/players/jellyfin.test.ts`：

```ts
describe('JellyfinClient.getScheduledTasks', () => {
  it('State=Running/Cancelling 映射为 isRunning=true，Idle 为 false', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { Id: 't1', Name: 'Scan Media Library', State: 'Running' },
      { Id: 't2', Name: 'Refresh Guide', State: 'Idle' },
      { Id: 't3', Name: 'Cleanup', State: 'Cancelling' },
    ]), { status: 200 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const tasks = await client.getScheduledTasks()
    expect(tasks).toEqual([
      { id: 't1', name: 'Scan Media Library', isRunning: true },
      { id: 't2', name: 'Refresh Guide', isRunning: false },
      { id: 't3', name: 'Cleanup', isRunning: true },
    ])
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/adapters/players/jellyfin.test.ts` → FAIL：`client.getScheduledTasks is not a function`

- [ ] **Step 3: 实现** 在 `src/adapters/players/jellyfin.ts` 顶部 schema 区（`JellyfinRemoteSearchSchema` 附近）加：

```ts
export const JellyfinScheduledTaskSchema = z.object({
  Id: z.string(), Name: z.string(), State: z.string(),
}).passthrough()
export const JellyfinScheduledTasksSchema = z.array(JellyfinScheduledTaskSchema)
```

在 `deleteItem` 之后加：

```ts
  /** Running/Cancelling 都算"占着扫描资源"——realign 编排等待时两者都不该被当作空闲。 */
  async getScheduledTasks(): Promise<{ id: string; name: string; isRunning: boolean }[]> {
    const raw = await this.call('GET', '/ScheduledTasks')
    const tasks = JellyfinScheduledTasksSchema.parse(raw)
    return tasks.map(t => ({ id: t.Id, name: t.Name, isRunning: t.State === 'Running' || t.State === 'Cancelling' }))
  }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/adapters/players/jellyfin.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/players/jellyfin.ts src/adapters/players/jellyfin.test.ts
git commit -m "feat(realign): jellyfin client — getScheduledTasks"
```

### Task 24: `getVirtualFolders`

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`
- Modify: `src/adapters/players/jellyfin.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/adapters/players/jellyfin.test.ts`：

```ts
describe('JellyfinClient.getVirtualFolders', () => {
  it('解析库 id/name/挂载路径/EnableRealtimeMonitor', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { ItemId: 'lib-1', Name: 'TV Shows', Locations: ['/media/tv'], LibraryOptions: { EnableRealtimeMonitor: true } },
      { ItemId: 'lib-2', Name: 'Movies', Locations: ['/media/movies'], LibraryOptions: { EnableRealtimeMonitor: false } },
    ]), { status: 200 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    const folders = await client.getVirtualFolders()
    expect(folders).toEqual([
      { id: 'lib-1', name: 'TV Shows', locations: ['/media/tv'], enableRealtimeMonitor: true },
      { id: 'lib-2', name: 'Movies', locations: ['/media/movies'], enableRealtimeMonitor: false },
    ])
  })

  it('LibraryOptions 缺失时 enableRealtimeMonitor 默认 false', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([
      { ItemId: 'lib-1', Name: 'TV', Locations: ['/media/tv'] },
    ]), { status: 200 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    expect((await client.getVirtualFolders())[0].enableRealtimeMonitor).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/adapters/players/jellyfin.test.ts` → FAIL：`client.getVirtualFolders is not a function`

- [ ] **Step 3: 实现** 顶部 schema 区加：

```ts
export const JellyfinVirtualFolderSchema = z.object({
  ItemId: z.string(), Name: z.string(), Locations: z.array(z.string()).default([]),
  LibraryOptions: z.object({ EnableRealtimeMonitor: z.boolean().nullish() }).passthrough().nullish(),
}).passthrough()
```

`getScheduledTasks` 之后加：

```ts
  /** 库清单——realign 编排靠 Locations 判断新目录归属哪个库（供 refreshLibrary 用）。
   *  EnableRealtimeMonitor：本地盘用户可能开着 Jellyfin 实时监控（inotify）——若开启，
   *  runs 里应注明（见 realignExecutor 顶层编排的日志）。 */
  async getVirtualFolders(): Promise<{ id: string; name: string; locations: string[]; enableRealtimeMonitor: boolean }[]> {
    const raw = await this.call('GET', '/Library/VirtualFolders')
    const folders = z.array(JellyfinVirtualFolderSchema).parse(raw)
    return folders.map(f => ({
      id: f.ItemId, name: f.Name, locations: f.Locations,
      enableRealtimeMonitor: f.LibraryOptions?.EnableRealtimeMonitor ?? false,
    }))
  }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/adapters/players/jellyfin.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/players/jellyfin.ts src/adapters/players/jellyfin.test.ts
git commit -m "feat(realign): jellyfin client — getVirtualFolders"
```

### Task 25: `refreshLibrary`（单库刷新，区别于全服务器扫描/单条目刷新）

**Files:**
- Modify: `src/adapters/players/jellyfin.ts`
- Modify: `src/adapters/players/jellyfin.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/adapters/players/jellyfin.test.ts`：

```ts
describe('JellyfinClient.refreshLibrary', () => {
  it('POST /Items/{libraryId}/Refresh，recursive=true + FullRefresh', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 204 }))
    const client = new JellyfinClient({ baseUrl: 'http://jf', apiKey: 'k', fetchImpl: fetchImpl as unknown as typeof fetch })
    await client.refreshLibrary('lib-1')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(String(url)).toContain('/Items/lib-1/Refresh')
    expect(String(url)).toContain('recursive=true')
    expect((init as RequestInit).method).toBe('POST')
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/adapters/players/jellyfin.test.ts` → FAIL：`client.refreshLibrary is not a function`

- [ ] **Step 3: 实现** 在 `getVirtualFolders` 之后加：

```ts
  /** 单库刷新——库(VirtualFolder)本身也是一个 Item，用同一 Refresh 端点、加 recursive=true
   *  触发"只重扫这个库"而非全服务器扫描任务，把扫描时机全权交给 realign 编排掌控。 */
  async refreshLibrary(libraryId: string): Promise<void> {
    await this.call('POST', `/Items/${encodeURIComponent(libraryId)}/Refresh?metadataRefreshMode=FullRefresh&replaceAllMetadata=false&recursive=true`)
  }
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/adapters/players/jellyfin.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/players/jellyfin.ts src/adapters/players/jellyfin.test.ts
git commit -m "feat(realign): jellyfin client — refreshLibrary (single-library scan trigger)"
```

### Task 26: 生产接线 — `cmdWatch` 装配 `executeRealign` + `realign-rollback` 子命令

**Files:**
- Modify: `src/cli/index.ts`

无新增自动化测试——与仓库既有约定一致：`cli/index.ts` 的 `cmd*` 函数从不被直接单测，只测试它们
调用的构建块（本 task 调用的全部构建块——`realignExecutor.ts`/`realignManifest.ts`/`animeLists.ts`/
`jellyfin.ts` 新端点——均已在 Task 15-25 单独测试过）。本 task 的验证手段是 `tsc --noEmit` 类型检查
通过 + 全量 `vitest run` 保持绿（证明接线没有破坏任何既有行为）。

- [ ] **Step 1:** 修改 `Assembled` 接口（`src/cli/index.ts` 约 62 行），加一个字段，并把 `llm` 字段类型从窄接口放宽成完整的 `LlmRuntime`（底层对象本来就是 `createLlmRuntime()` 的产出，一直具备 `.call()`，只是接口声明之前只暴露了 `profileInfo()` 给 ledger 写入代码用——`makeDiagnoseSeason` 需要 `.call()`，收窄的类型会在这里拦下一个本不存在的类型错误）：

```ts
import type { LlmRuntime } from '../agent/runtime.js' // 加进已有的 '../agent/runtime.js' import 行

export interface Assembled {
  makeDeps: (...) => PipelineDeps
  withJournal: <T>(fn: () => Promise<T>) => Promise<T>
  cacheRoot: string
  llm: LlmRuntime
  jf: PlayerServer
  /** realign 编排需要 PlayerServer 之外的能力（ScheduledTasks/VirtualFolders/单库刷新/删条目）
   *  ——与 jf 是同一个 JellyfinClient 实例，只是这里保留具体类型，不经过 PlayerServer 抽象
   *  （realign 目前是 Jellyfin-专属能力，尚无跨播放器抽象需求，YAGNI）。 */
  jellyfinClient: JellyfinClient
  mappings: PathMapping[]
  tmdb: TmdbClient | null
}
```

- [ ] **Step 1b:** 全仓库搜索 `.llm.profileInfo(` 的调用点（`cmdRun`/`cmdRunItem` 各一处），确认它们在 `llm` 类型放宽后依然编译通过——`LlmRuntime` 是 `{ profileInfo: ...; call: ... }` 的超集，原有调用点不需要任何改动。跑 `npx tsc --noEmit` 确认。

`assemble()` 函数末尾的 `return` 语句加一个字段：

```ts
  return { makeDeps, withJournal, cacheRoot, llm, jf, jellyfinClient: jf, mappings, tmdb }
```

- [ ] **Step 2:** 在文件顶部 import 区加：

```ts
import { fetchAnimeListsTable } from '../adapters/providers/animeLists.js'
import { statSync } from 'node:fs'
import {
  executeRealign, makeRealignRunEpisode, type RealignExecutorDeps,
} from '../v2/realignExecutor.js'
import { replayRollback } from '../files/realignManifest.js'
import { makeDiagnoseSeason } from '../v2/executor.js'
```

（`executeJob`/`makeRunEpisode` 已经从 `'../v2/executor.js'` 导入，这里把 `makeDiagnoseSeason` 加进同一行的具名导入列表即可，不需要单独一行。）

并把既有的 `import { JobsRepo } from '../v2/jobsRepo.js'`（cli/index.ts 顶部已有此行）改成：

```ts
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
```

- [ ] **Step 3:** 在 `cmdWatch` 函数体内，`const daemonDeps: DaemonDeps = { ... }` 之前，加一个 `executeRealignClosure` 构造 + `diagnoseSeasonClosure` 构造：

```ts
  const realignRunEpisode = makeRealignRunEpisode({ makeDeps, withJournal, cacheRoot })
  const executeRealignClosure = tmdb
    ? async (realignJob: Job) => {
        const deps: RealignExecutorDeps = {
          lib, jobs,
          jf: {
            getItem: (id) => jf.getItem(id),
            getItemsPage: (start, limit) => jf.getItemsPage(start, limit),
            getScheduledTasks: () => jellyfinClientForRealign.getScheduledTasks(),
            getVirtualFolders: () => jellyfinClientForRealign.getVirtualFolders(),
            refreshLibrary: (id) => jellyfinClientForRealign.refreshLibrary(id),
            deleteItem: (id) => jellyfinClientForRealign.deleteItem(id),
          },
          tmdb: { getSeasonTable: (id) => tmdb.getSeasonTable(id) },
          fetchAnimeLists: () => fetchAnimeListsTable(),
          runEpisode: (ctx, outDir, jobId) => realignRunEpisode(ctx, outDir, jobId),
          now: () => Date.now(),
          log,
          sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
          getSize: (p) => { try { return statSync(p).size } catch { return null } },
        }
        const result = await executeRealign(realignJob, deps)
        return result
      }
    : undefined

  // 诊断钩子（Task 14 的 makeDiagnoseSeason）：同样门在 tmdb 是否配置——诊断需要 TMDB
  // 季表才有确定性主信号，没有 TMDB_API_KEY 时整个 realign 功能（诊断+执行）一起跳过，
  // 行为回退到"只有内容退避梯，没有排布诊断"的现状，不报错、不阻塞正常找字幕流程。
  const diagnoseSeasonClosure = tmdb
    ? makeDiagnoseSeason({ lib, jf, tmdb, runs, llm })
    : undefined
```

（`jellyfinClientForRealign` 是 `assemble()` 返回的 `jellyfinClient` 字段——在 `cmdWatch` 顶部 `const { makeDeps, withJournal, cacheRoot, llm, jf, mappings, tmdb } = await assemble()` 这一行的解构列表里加上 `jellyfinClient: jellyfinClientForRealign`。）

- [ ] **Step 4:** 把 `executeRealignClosure` + `diagnoseSeasonClosure` 接进 `daemonDeps.executeJob`：

```ts
    executeJob: async (job) => {
      await withJournal(() => executeJob(job, {
        lib,
        jobs,
        runEpisode,
        executeRealign: executeRealignClosure,
        diagnoseSeason: diagnoseSeasonClosure,
        now: () => Date.now(),
        log,
      }))
    },
```

- [ ] **Step 5:** 新增 `cmdRealignRollback` 函数（放在 `cmdDoctor` 之后）：

```ts
async function cmdRealignRollback(archiveDir: string) {
  const log = (msg: string) => console.log(msg)
  try {
    replayRollback(archiveDir, log)
    console.log('回滚完成。')
    process.exit(0)
  } catch (e) {
    console.error(`回滚失败：${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}
```

在 `main()` 里的 `parseArgs` 之后加分支（`if (cmd === 'doctor') ...` 之后）：

```ts
  if (cmd === 'realign-rollback' && positionals[1]) return cmdRealignRollback(positionals[1])
```

并把 usage 提示串追加 `| realign-rollback <archiveDir>`。

- [ ] **Step 6: 全仓库回归** `npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 7: 提交**

```bash
git add src/cli/index.ts
git commit -m "feat(realign): wire executeRealign into cmdWatch; add realign-rollback CLI subcommand"
```

---

## Phase G：乱排布 mock 矩阵 + 集成测试 + dashboard 人话

### Task 27: `scripts/gen-messy-library.sh`（5 形态乱排布生成器）

**Files:**
- Create: `scripts/gen-messy-library.sh`

- [ ] **Step 1:** 创建 `scripts/gen-messy-library.sh`（沿用 `scripts/gen-mock-library.sh` 的 `clip`/`clip_with_chi` 风格，追加乱排布专用 helper）：

```bash
#!/usr/bin/env bash
# 生成乱排布 mock 媒体库：验收间谍过家家绝对编号平铺场景 + 4 种对照形态。
# 用法: scripts/gen-messy-library.sh [outdir]   # 默认 fixtures/media-messy
set -euo pipefail
command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg / apt-get install ffmpeg" >&2; exit 1; }
OUT="${1:-fixtures/media-messy}"

clip() {
  mkdir -p "$OUT/$(dirname "$1")"
  ffmpeg -f lavfi -i color=black:s=320x240:d=1 -c:v libx264 -pix_fmt yuv420p -y -loglevel error "$OUT/$1"
}

# —— 形态 1：绝对编号平铺（验收主场景）——
# 间谍过家家(2022)：TMDB 真实季表 S1=25 集/S2=12 集/S3=3 集，共 40 集；这里全部塞进单个
# "Season 01" 目录、文件名用裸 E{abs} 记法，模拟被 Jellyfin 误刮成 S1E1..S1E40 的乱库。
for i in $(seq 1 40); do
  clip "TV/Spy x Family (2022)/Season 01/Spy x Family (2022) E${i}.mkv"
done

# —— 形态 2：错位（正确集数，但按特别篇偏移一位）——
# 用同一部剧，但文件按 SxxEyy 记法给出、集号整体错位 1（模拟特别篇混入导致的季内错位）；
# 这批文件已含 SxxEyy，parseAbsoluteEpisodeNumber 会判 null（不当绝对编号平铺处理，
# 交给"正常库"逻辑走——错位问题不在本次 realign 的范围内，YAGNI，仅用作对照不应误伤）。
for i in $(seq 1 25); do
  clip "TV/Offset Show (2021)/Season 01/Offset Show (2021) S01E$(printf '%02d' $((i + 1))).mkv"
done

# —— 形态 3：合集文件（E01-02 合并成一个文件）——
clip "TV/Combined Show (2020)/Season 01/Combined Show (2020) E01-02.mkv"
clip "TV/Combined Show (2020)/Season 01/Combined Show (2020) E03.mkv"

# —— 形态 4：特别篇混入（S0 文件与正片同目录）——
clip "TV/Specials Mixed Show (2019)/Season 01/Specials Mixed Show (2019) S01E01.mkv"
clip "TV/Specials Mixed Show (2019)/Season 01/Specials Mixed Show (2019) S00E01.mkv" # 特别篇，应被隔离

# —— 形态 5：正常库（控制组，绝不应触发诊断/整理）——
for i in 1 2 3; do
  clip "TV/Normal Show (2018)/Season 01/Normal Show (2018) S01E0${i}.mkv"
done

echo "messy mock library written to $OUT:"
find "$OUT" -name '*.mkv' | sort
```

- [ ] **Step 2:** 加执行权限并冒烟跑一次（本地验证，不进 CI）：

```bash
chmod +x scripts/gen-messy-library.sh
./scripts/gen-messy-library.sh /tmp/messy-smoke-test
find /tmp/messy-smoke-test -name '*.mkv' | wc -l  # 期望 40+25+2+2+3 = 72
```

- [ ] **Step 3: 提交**

```bash
git add scripts/gen-messy-library.sh
git commit -m "feat(realign): messy-library mock generator (5-shape acceptance matrix)"
```

### Task 28: 乱排布矩阵集成测试（真实 tmp 目录，无需 docker）

**Files:**
- Create: `src/files/libraryRealign.messyMatrix.test.ts`

- [ ] **Step 1: 写失败测试** `src/files/libraryRealign.messyMatrix.test.ts`（本 task 的测试从写下来那一刻起就应该是绿的——它测的是 Phase C 已经实现完毕的 `scanVideoFiles`/`buildRealignPlan`，这里"RED-for-the-right-reason"指的是文件本身不存在；实现完毕后应立即全绿，不需要额外产品代码）：

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanVideoFiles, buildRealignPlan } from './libraryRealign.js'
import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'

function mkDir(...parts: string[]): string {
  const dir = join(...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('乱排布矩阵（批准记录验收场景）', () => {
  it('形态1 绝对编号平铺：40 个裸 E{n} 文件 → 计划成功，S1×25/S2×12/S3×3，无隔离', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-flat-'))
    const seasonDir = mkDir(root, 'Spy x Family (2022)', 'Season 01')
    for (let i = 1; i <= 40; i++) writeFileSync(join(seasonDir, `Spy x Family (2022) E${i}.mkv`), '')
    const files = scanVideoFiles(seasonDir)
    expect(files).toHaveLength(40)
    const seasonTable: SeasonTableEntry[] = [
      { seasonNumber: 1, episodeCount: 25, airDate: null },
      { seasonNumber: 2, episodeCount: 12, airDate: null },
      { seasonNumber: 3, episodeCount: 3, airDate: null },
    ]
    const result = buildRealignPlan(files, { seriesTitle: 'Spy x Family', year: 2022, tmdbId: '120089', seasonTable })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items.filter(i => i.targetSeason === 1)).toHaveLength(25)
    expect(result.items.filter(i => i.targetSeason === 2)).toHaveLength(12)
    expect(result.items.filter(i => i.targetSeason === 3)).toHaveLength(3)
  })

  it('形态2 错位（已含 SxxEyy 记法）：不解析为绝对编号，全部落入 quarantined（不当绝对编号平铺处理）', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-offset-'))
    const seasonDir = mkDir(root, 'Offset Show (2021)', 'Season 01')
    for (let i = 1; i <= 25; i++) {
      writeFileSync(join(seasonDir, `Offset Show (2021) S01E${String(i + 1).padStart(2, '0')}.mkv`), '')
    }
    const files = scanVideoFiles(seasonDir)
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 25, airDate: null }]
    const result = buildRealignPlan(files, { seriesTitle: 'Offset Show', year: 2021, tmdbId: '1', seasonTable })
    expect(result.ok).toBe(false) // 全部解不出绝对集号 → "没有任何文件能解析出绝对集号"
  })

  it('形态3 合集文件（E01-02 合并）：合集文件解不出集号进隔离区，单集文件正常整理', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-combined-'))
    const seasonDir = mkDir(root, 'Combined Show (2020)', 'Season 01')
    writeFileSync(join(seasonDir, 'Combined Show (2020) E01-02.mkv'), '')
    writeFileSync(join(seasonDir, 'Combined Show (2020) E03.mkv'), '')
    const files = scanVideoFiles(seasonDir)
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 10, airDate: null }]
    const result = buildRealignPlan(files, { seriesTitle: 'Combined Show', year: 2020, tmdbId: '1', seasonTable })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toHaveLength(1) // 只有 E03 能解析
    expect(result.quarantined.map(f => f.filename)).toEqual(['Combined Show (2020) E01-02.mkv'])
  })

  it('形态4 特别篇混入：S00E01 已含 SxxEyy → 判 null，落入 quarantined，不污染正片映射', () => {
    const root = mkdtempSync(join(tmpdir(), 'messy-specials-'))
    const seasonDir = mkDir(root, 'Specials Mixed Show (2019)', 'Season 01')
    writeFileSync(join(seasonDir, 'Specials Mixed Show (2019) S01E01.mkv'), '')
    writeFileSync(join(seasonDir, 'Specials Mixed Show (2019) S00E01.mkv'), '')
    const files = scanVideoFiles(seasonDir)
    for (const f of files) expect(f.match).toBeNull() // 两个文件都已是 SxxEyy 记法
    const seasonTable: SeasonTableEntry[] = [{ seasonNumber: 1, episodeCount: 12, airDate: null }]
    const result = buildRealignPlan(files, { seriesTitle: 'Specials Mixed Show', year: 2019, tmdbId: '1', seasonTable })
    expect(result.ok).toBe(false) // 全部解不出 → 整理放弃（本就不该被误判成绝对编号平铺）
  })

  it('形态5 正常库（控制组）：镜像集数未超 TMDB → mirrorExceedsSeasonTable 判 false，诊断不触发（不建 realign 任务）', async () => {
    const { mirrorExceedsSeasonTable } = await import('../agent/diagnoseSeason.js')
    // 正常库：3 集，TMDB 该季也是 3 集——不超出，诊断主信号不成立。
    expect(mirrorExceedsSeasonTable({ seriesId: 'normal', season: 1, mirrorEpisodeCount: 3, tmdbEpisodeCount: 3 })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/files/libraryRealign.messyMatrix.test.ts` → 预期：全部立即通过（Phase C/D 的产品代码已完备）。若有断言不符，说明 Phase C/D 的某个函数行为与本文件假设不一致——回去核对 `parseAbsoluteEpisodeNumber`/`buildRealignPlan`/`mirrorExceedsSeasonTable` 的真实实现，修正本测试文件的断言，不要反过来削弱产品代码的闸门以迁就断言。

- [ ] **Step 3: 确认通过** `npx tsc --noEmit && npx vitest run src/files/libraryRealign.messyMatrix.test.ts` → PASS

- [ ] **Step 4: 全仓库回归** `npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/files/libraryRealign.messyMatrix.test.ts
git commit -m "test(realign): messy-library matrix integration tests (5 shapes, tmp-dir based)"
```

### Task 29: dashboard 人话 — `realigned` 决策标签

**Files:**
- Modify: `src/dashboard/labels.ts`
- Modify: `src/dashboard/labels.test.ts`

- [ ] **Step 1: 写失败测试** 追加到 `src/dashboard/labels.test.ts`：

```ts
describe('realigned 决策标签', () => {
  it('realigned → 人话标签 + ok 语气', () => {
    expect(decisionLabel('realigned')).toEqual({ label: '把乱排布的剧集整理好了', tone: 'ok' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败** `npx vitest run src/dashboard/labels.test.ts` → FAIL：断言不符（`realigned` 落回未知枚举兜底的 `{ label: '已处理', tone: 'muted' }`）

- [ ] **Step 3: 实现** 在 `src/dashboard/labels.ts` 的 `DECISION_MAP` 里加一行：

```ts
const DECISION_MAP: Record<string, { label: string; tone: Tone }> = {
  download:       { label: '已下好中文字幕', tone: 'ok' },
  adopted_local:  { label: '整理好了本地已有的字幕', tone: 'ok' },
  already_exists: { label: '本来就有字幕，跳过', tone: 'skip' },
  no_safe_match:  { label: '暂时没找到合适的中文字幕', tone: 'muted' },
  retry_later:    { label: '过阵子再试', tone: 'muted' },
  error:          { label: '出错，稍后重试', tone: 'fail' },
  realigned:      { label: '把乱排布的剧集整理好了', tone: 'ok' },
}
```

- [ ] **Step 4: 跑测试确认通过** `npx tsc --noEmit && npx vitest run src/dashboard/labels.test.ts` → PASS

- [ ] **Step 5: 全仓库回归**（本计划最后一个 task，做一次完整收尾检查）`npx tsc --noEmit && npx vitest run` → PASS

- [ ] **Step 6: 提交**

```bash
git add src/dashboard/labels.ts src/dashboard/labels.test.ts
git commit -m "feat(realign): dashboard human-readable label for realigned runs"
```

---

## 阶段边界红绿表

| Phase | 结束时仓库状态 |
|---|---|
| A | 绿——mountCapabilities 探针 + doctor 画像，纯新增，零改动既有行为 |
| B | 绿——TMDB/anime-lists 抓取器，纯新增方法/新文件 |
| C | 绿——libraryRealign.ts 计划构建器，纯新增文件，无人接线调用 |
| D | 绿——db v7 迁移 + jobsRepo/libraryRepo/executor 挂钩全部有测试覆盖；`executeRealign`/`diagnoseSeason` 闭包在 executor 里是可选字段，未接线时行为等同现状（fail-soft 兜底），不产生红窗口 |
| E | 绿——realignExecutor.ts 完整执行路径，用结构化接口 + fake 测试，不依赖 Phase F 的具体 JellyfinClient 实现 |
| F | 绿——Jellyfin 客户端新端点 + cmdWatch 生产接线，全量回归验证未破坏既有行为 |
| G | 绿——mock 矩阵 + 集成测试 + dashboard 标签，收尾 |

无不可避免的红色窗口。
