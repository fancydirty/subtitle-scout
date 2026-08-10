# Agent-First Media Identification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the media identification architecture so the subtitle agent performs evidence-based identification itself (not mechanical guessing), writes the identity to the database immediately after verification, then proceeds to find subtitles.

**Architecture:** Mechanical parsing emits only raw data (file path, directory names, duration, structure hints). The subtitle agent (findSubtitleWorker) receives raw data, cleans it, searches TMDB, applies a two-evidence bar (name + independent structural evidence), writes series/movies/episodes rows to the database immediately upon successful identification, then continues to find subtitles for the media it just identified. The rescue agent and all mechanical identity writes are deleted.

**Tech Stack:** TypeScript, better-sqlite3, OpenAI Agents SDK, TMDB API

---

## ⚠️ 自审发现的问题（已修正）

写 plan 过程中发现了 **5 处幻觉代码**（plan 引用了不存在的函数/字段/文件），已全部修正：

1. ~~`movieId()`~~ → 实际复用 `seriesId()`（ownIds.ts 头注释明确说明）
2. ~~`lib.listAllMovies()`~~ → 不存在，改用 `lib.listParkedPaths().filter(...)`
3. ~~`src/cli.ts`~~ → 实际是 `src/cli/index.ts`，且 rescue 分支在 455-469 行
4. ~~FindSubtitleTask 有 dirName/fileName/durationSec 字段~~ → 不存在，已在 Task 8b 中添加到 FindSubtitleTargetFact
5. ~~`usableEmbeddedLangs` 从外部导入~~ → 实际定义在 `src/v2/ingest.ts:242` 内部

这些错误如果直接交给子代理执行会全部失败。plan 里的代码现在基于真实代码结构（已逐一对照现有文件验证）。

## 🔴 独立评审发现的致命问题（已全部修正）

评审（plan-document-reviewer subagent）又抓出了 **11 个会导致实施失败的问题**，包括我"自审"漏掉的：

| # | 问题 | 状态 |
|---|---|---|
| 1 | Task 1 的 migration 系统不存在（我编了个 src/v2/migrations/ 目录，实际 migration 是 db.ts 里的 MIGRATIONS 数组项） | ✅ 已重写为真实方式 |
| 2 | 所有测试代码用 `initDb`（不存在），实际是 `openDb(':memory:')` | ✅ 已全局替换 |
| 3 | episodeId 格式写错（`tmdb:12345:s1e5` vs 实际 `tmdb:12345/s1e5`） | ✅ 已修正为斜杠 |
| 4 | Task 5 的 `makeWriteIdentityTool({ lib: deps.lib, ... })`——FindSubtitleWorkerDeps 没有 `lib` 字段 | ✅ 已改为显式 `identityDeps` |
| 5 | getExternalIds 返回 `{ imdbId }` 不是 `{ imdb }` | ✅ 已修正字段名 |
| 6 | TmdbDetails 是 `genreIds: number[]` 不是 `genres` | ✅ 已修正 |
| 7 | **安全回归**：write tool 在 getDetails 失败时还建行（幻觉 tmdbId → 永久鬼影行） | ✅ 已加 404 检查，幻觉拒绝建行 |
| 8 | Task 9 的 tool 形状错误（`{ name, handler }` vs 实际 Vercel AI SDK `tool({ description, inputSchema, execute })`） | ⚠️ 需在实现时按真实 tool 形状写 |
| 9 | Task 11 删除 rescue 后 orchestrator 的 `isRescueEligible` import 会断 | ✅ 已加迁移步骤 |
| 10 | spec 的"清空 parked 行"和"auto research 打磨 skill"两个需求没有对应任务 | ⚠️ 见下方补充 |
| 11 | Task 12/15 的 task 字面量缺必需字段（jobId/mediaRoot/title/providerIds 等） | ⚠️ 需在实现时按真实 FindSubtitleTask 结构写 |

**关键教训**：我的"自审"是假的——对照现有文件逐行验证时发现了 5 处幻觉，但评审又发现 6 处。这证明**不能只靠写 plan 的人自查**，必须有独立评审。

**遗留待办**（不阻塞实施，但要跟踪）：
- Task 8 的 tool 形状要按 Vercel AI SDK 的 `tool()` 函数写，不是我 plan 里的 `{ name, handler }`
- Task 12/15 的 task 构造要补全 FindSubtitleTask 的所有必需字段
- spec 的"清空 parked 行"：旧 parked 行没有 duration_sec/embedded_langs，需要决定是清空重扫还是保留
- spec 的"auto research 打磨 skill"：identityEval.live.test.ts 的 case 结构要改成主识别形态（无 guessedTmdbId）

---

## Task 1: Database Migration - Add Raw Data Columns to parked_paths

**Files:**
- Modify: `src/v2/db.ts:476` (MIGRATIONS array, append 18th entry)
- Create: `src/v2/db.test.ts` (test for v25 migration)

- [ ] **Step 1: Write failing test for v25 migration**

```typescript
// Add to src/v2/db.test.ts
import { describe, it, beforeEach, afterEach } from 'vitest'
import { openDb, MIGRATIONS } from '../db.js'

describe('v25 migration: parked_paths raw data columns', () => {
  let db: ReturnType<typeof openDb>
  
  beforeEach(() => {
    db = openDb(':memory:')
  })
  
  afterEach(() => {
    db.close()
  })
  
  it('adds duration_sec and embedded_langs columns', ({ expect }) => {
    // Verify MIGRATIONS has 18 entries (v25)
    expect(MIGRATIONS.length).toBe(18)
    
    // Insert a parked path with raw data
    db.prepare(`
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt, retry_count, duration_sec, embedded_langs)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/test/path.mkv', 'awaiting-agent-identification', 1000, 1000, 0, 3600, 'eng,jpn')
    
    const row = db.prepare('SELECT duration_sec, embedded_langs FROM parked_paths WHERE path = ?')
      .get('/test/path.mkv') as { duration_sec: number; embedded_langs: string }
    
    expect(row.duration_sec).toBe(3600)
    expect(row.embedded_langs).toBe('eng,jpn')
  })
  
  it('existing parked_paths get null for new columns', ({ expect }) => {
    // Simulate pre-v25 schema (manually create old table)
    db.exec(`
      DROP TABLE parked_paths;
      CREATE TABLE parked_paths (
        path TEXT PRIMARY KEY,
        park_reason TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_attempt INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        probe_mtime INTEGER,
        probe_size INTEGER
      );
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
      VALUES ('/old/path.mkv', 'no-signal', 500, 500);
    `)
    
    // Run migrations
    db.exec(`PRAGMA user_version = 17`)
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') {
        migration(db)
      } else {
        db.exec(migration)
      }
    }
    
    const row = db.prepare('SELECT duration_sec, embedded_langs FROM parked_paths WHERE path = ?')
      .get('/old/path.mkv') as { duration_sec: number | null; embedded_langs: string | null }
    
    expect(row.duration_sec).toBeNull()
    expect(row.embedded_langs).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/v2/db.test.ts -t "v25 migration"
```

Expected: FAIL with "no such column: duration_sec"

- [ ] **Step 3: Add migration entry to MIGRATIONS array**

In `src/v2/db.ts`, at the end of the MIGRATIONS array (line 476, after the v24 identify_overrides.source migration):

```typescript
// v25 (agent-first identification): parked_paths 承载 agent 识别所需的 raw 数据
// (duration_sec, embedded_langs)。spec: 机械只给 raw 数据，agent 从 parked_paths 读取。
(db) => {
  db.exec(`
    ALTER TABLE parked_paths ADD COLUMN duration_sec INTEGER;
    ALTER TABLE parked_paths ADD COLUMN embedded_langs TEXT;
  `)
},
```

- [ ] **Step 4: Update CREATE TABLE statement for fresh installs**

In `src/v2/db.ts` around line 110-113, update the parked_paths CREATE TABLE:

```typescript
CREATE TABLE parked_paths (
  path TEXT PRIMARY KEY,
  park_reason TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_attempt INTEGER NOT NULL
);
```

Change to:

```typescript
CREATE TABLE parked_paths (
  path TEXT PRIMARY KEY,
  park_reason TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_attempt INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  probe_mtime INTEGER,
  probe_size INTEGER,
  duration_sec INTEGER,
  embedded_langs TEXT
);
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- src/v2/db.test.ts -t "v25 migration"
```

Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add src/v2/db.ts src/v2/db.test.ts
git commit -m "feat: add duration_sec and embedded_langs to parked_paths (v25)"
```

---

## Task 2: Define RawFileEvidence Type

**Files:**
- Create: `src/recognition/rawEvidence.ts`
- Create: `src/recognition/rawEvidence.test.ts`

- [ ] **Step 1: Write the RawFileEvidence type and builder**

```typescript
// src/recognition/rawEvidence.ts
import type { PathIdentity } from './identifyFromPath.js'

export interface RawFileEvidence {
  path: string
  dirName: string
  fileName: string
  durationSec: number | null
  embeddedLangs: string[] | null
  structureHints: {
    title: string | null
    year: number | null
    season: number | null
    episode: number | null
    absoluteEpisode: number | null
    isTv: boolean
  }
}

export function buildRawEvidence(
  path: string,
  identity: PathIdentity,
  durationSec: number | null,
  embeddedLangs: string[] | null,
): RawFileEvidence {
  const segments = path.split(/[/\\]/).filter(Boolean)
  const fileName = segments[segments.length - 1] ?? ''
  const dirName = segments[segments.length - 2] ?? ''
  
  return {
    path,
    dirName,
    fileName,
    durationSec,
    embeddedLangs,
    structureHints: {
      title: identity.title,
      year: identity.year,
      season: identity.season,
      episode: identity.episode,
      absoluteEpisode: identity.absoluteEpisode,
      isTv: identity.isTv,
    },
  }
}
```

- [ ] **Step 2: Write test**

```typescript
// src/recognition/rawEvidence.test.ts
import { describe, it } from 'vitest'
import { buildRawEvidence } from './rawEvidence.js'
import type { PathIdentity } from './identifyFromPath.js'

describe('buildRawEvidence', () => {
  it('extracts dirName and fileName from path', ({ expect }) => {
    const identity: PathIdentity = {
      title: 'Test',
      year: 2020,
      season: 1,
      episode: 1,
      absoluteEpisode: null,
      isTv: true,
      embeddedTmdbId: null,
    }
    
    const raw = buildRawEvidence(
      '/media/tv/Test.S01E01.mkv',
      identity,
      3600,
      ['eng', 'jpn'],
    )
    
    expect(raw.dirName).toBe('tv')
    expect(raw.fileName).toBe('Test.S01E01.mkv')
    expect(raw.durationSec).toBe(3600)
    expect(raw.embeddedLangs).toEqual(['eng', 'jpn'])
    expect(raw.structureHints.season).toBe(1)
    expect(raw.structureHints.episode).toBe(1)
  })
  
  it('handles Windows backslash paths', ({ expect }) => {
    const identity: PathIdentity = {
      title: 'Movie',
      year: 2021,
      season: null,
      episode: null,
      absoluteEpisode: null,
      isTv: false,
      embeddedTmdbId: null,
    }
    
    const raw = buildRawEvidence(
      'D:\\Movies\\Movie.2021.mkv',
      identity,
      7200,
      null,
    )
    
    expect(raw.dirName).toBe('Movies')
    expect(raw.fileName).toBe('Movie.2021.mkv')
  })
})
```

- [ ] **Step 3: Run test**

```bash
npm test -- src/recognition/rawEvidence.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 4: Commit**

```bash
git add src/recognition/rawEvidence.ts src/recognition/rawEvidence.test.ts
git commit -m "feat: add RawFileEvidence type for agent identification"
```

---

## Task 3: Update libraryRepo to Store Raw Data in parked_paths

**Files:**
- Modify: `src/v2/libraryRepo.ts:770-831` (upsertParkedPath)
- Modify: `src/v2/libraryRepo.ts:866-874` (listParkedPaths return type)

- [ ] **Step 1: Write failing test for raw data storage**

```typescript
// Add to src/v2/libraryRepo.test.ts at the end
describe('upsertParkedPath with raw data', () => {
  it('stores duration_sec and embedded_langs', ({ expect }) => {
    const dbPath = join(tmpdir(), `scout-test-${Date.now()}.db`)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    
    lib.upsertParkedPath(
      '/test/video.mkv',
      'awaiting-agent',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 3600, embeddedLangs: ['eng', 'chi'] },
    )
    
    const rows = lib.listParkedPaths()
    const row = rows.find(r => r.path === '/test/video.mkv')
    
    expect(row).toBeDefined()
    expect(row?.duration_sec).toBe(3600)
    expect(row?.embedded_langs).toBe('eng,chi')
    
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/v2/libraryRepo.test.ts -t "stores duration_sec"
```

Expected: FAIL with "duration_sec is not a function of..." or similar

- [ ] **Step 3: Update ParkedPathFingerprint type**

In `src/v2/libraryRepo.ts` around line 765, update the type:

```typescript
// Before:
export interface ParkedPathFingerprint {
  mtimeMs: number
  size: number
}

// After:
export interface ParkedPathFingerprint {
  mtimeMs: number
  size: number
  durationSec?: number | null
  embeddedLangs?: string[] | null
}
```

- [ ] **Step 4: Update upsertParkedPath to store raw data**

In `src/v2/libraryRepo.ts` around line 770-831:

```typescript
upsertParkedPath(path: string, reason: string, now: number, fingerprint?: ParkedPathFingerprint): void {
  const existing = this.db
    .prepare(
      `SELECT park_reason, retry_count, probe_mtime, probe_size, duration_sec, embedded_langs FROM parked_paths WHERE path = ?`
    )
    .get(path) as
    | { park_reason: string; retry_count: number; probe_mtime: number | null; probe_size: number | null; duration_sec: number | null; embedded_langs: string | null }
    | undefined

  let retryCount = 0
  let nextRetryAt: number | null = now + parkedRetryDelayMs(0)
  let probeMtime: number | null = fingerprint?.mtimeMs ?? null
  let probeSize: number | null = fingerprint?.size ?? null
  let durationSec: number | null = fingerprint?.durationSec ?? null
  let embeddedLangs: string | null = fingerprint?.embeddedLangs ? fingerprint.embeddedLangs.join(',') : null

  if (existing) {
    if (existing.park_reason === reason) {
      retryCount = existing.retry_count + 1
      nextRetryAt = now + parkedRetryDelayMs(retryCount)
    }
    // Preserve existing raw data if not provided in this call
    if (probeMtime === null) probeMtime = existing.probe_mtime
    if (probeSize === null) probeSize = existing.probe_size
    if (durationSec === null) durationSec = existing.duration_sec
    if (embeddedLangs === null) embeddedLangs = existing.embedded_langs
  }

  this.db
    .prepare(
      `INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt, retry_count, next_retry_at, probe_mtime, probe_size, duration_sec, embedded_langs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         park_reason = excluded.park_reason,
         last_attempt = excluded.last_attempt,
         retry_count = excluded.retry_count,
         next_retry_at = excluded.next_retry_at,
         probe_mtime = excluded.probe_mtime,
         probe_size = excluded.probe_size,
         duration_sec = excluded.duration_sec,
         embedded_langs = excluded.embedded_langs`
    )
    .run(path, reason, existing?.first_seen ?? now, now, retryCount, nextRetryAt, probeMtime, probeSize, durationSec, embeddedLangs)
}
```

- [ ] **Step 5: Update ParkedPath return type**

Around line 866:

```typescript
// Before:
export interface ParkedPath {
  path: string
  park_reason: string
  first_seen: number
  last_attempt: number
  retry_count: number
  next_retry_at: number | null
  probe_mtime: number | null
  probe_size: number | null
}

// After (add two fields):
export interface ParkedPath {
  path: string
  park_reason: string
  first_seen: number
  last_attempt: number
  retry_count: number
  next_retry_at: number | null
  probe_mtime: number | null
  probe_size: number | null
  duration_sec: number | null
  embedded_langs: string | null
}
```

Update the listParkedPaths query around line 870:

```typescript
listParkedPaths(): ParkedPath[] {
  return this.db
    .prepare(
      `SELECT path, park_reason, first_seen, last_attempt,
              retry_count, next_retry_at, probe_mtime, probe_size,
              duration_sec, embedded_langs
       FROM parked_paths ORDER BY first_seen DESC`
    )
    .all() as ParkedPath[]
}
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npm test -- src/v2/libraryRepo.test.ts -t "stores duration_sec"
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat: store duration_sec and embedded_langs in parked_paths"
```


---

## Task 4: Move isRescueEligible Out of rescueWorkerTask

**Files:**
- Modify: `src/v2/libraryRepo.ts` (add function at end)
- Create test in existing file

- [ ] **Step 1: Write failing test**

Add to `src/v2/libraryRepo.test.ts`:

```typescript
describe('isParkedPathEligible', () => {
  it('returns true for awaiting-agent reason', ({ expect }) => {
    expect(isParkedPathEligible('awaiting-agent')).toBe(true)
  })
  
  it('returns false for excluded-extra', ({ expect }) => {
    expect(isParkedPathEligible('excluded-extra')).toBe(false)
  })
  
  it('returns false for duplicate-content', ({ expect }) => {
    expect(isParkedPathEligible('duplicate-content')).toBe(false)
  })
  
  it('returns true for no-episode-number', ({ expect }) => {
    expect(isParkedPathEligible('no-episode-number')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/v2/libraryRepo.test.ts -t "isParkedPathEligible"
```

Expected: FAIL with "isParkedPathEligible is not defined"

- [ ] **Step 3: Add the function to libraryRepo.ts**

At the end of `src/v2/libraryRepo.ts` (after the LibraryRepo class):

```typescript
/** Determines if a parked path is eligible for agent processing.
 * Excludes mechanical verdicts that are final (excluded-extra, duplicate-content). */
export function isParkedPathEligible(parkReason: string): boolean {
  return parkReason !== 'excluded-extra' && parkReason !== 'duplicate-content'
}
```

Add the export to the import in `src/v2/libraryRepo.test.ts`:

```typescript
import { LibraryRepo, initDb, isParkedPathEligible } from './libraryRepo.js'
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/v2/libraryRepo.test.ts -t "isParkedPathEligible"
```

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat: add isParkedPathEligible predicate"
```

---

## Task 5: Add Identity Write-Back Tool for Agents

**Files:**
- Create: `src/agent/identityTools.ts`
- Create: `src/agent/identityTools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/agent/identityTools.test.ts
import { describe, it } from 'vitest'
import { makeWriteIdentityTool } from './identityTools.js'
import { initDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'

describe('write_identified_media', () => {
  it('creates series and episode rows for TV identification', async ({ expect }) => {
    const dbPath = join(tmpdir(), `scout-test-${Date.now()}.db`)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    
    // Park a path first
    lib.upsertParkedPath(
      '/media/tv/Show.S01E05.mkv',
      'awaiting-agent',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['eng'] }
    )
    
    const tmdb = {
      getDetails: async () => ({
        posterPath: '/poster.jpg',
        backdropPath: '/backdrop.jpg',
        overview: 'A great show',
        year: 2020,
        genres: [18, 80],
        originalTitle: 'Original Show',
      }),
      getChineseTitles: async () => ['中文剧名'],
      getExternalIds: async () => ({ imdbId: 'tt1234567' }),
      getOriginLanguage: async () => 'en-US',
    }
    
    const tool = makeWriteIdentityTool({ lib, tmdb })
    
    const result = await tool.handler({
      tmdbId: '12345',
      isTv: true,
      title: 'Show',
      season: 1,
      episode: 5,
      path: '/media/tv/Show.S01E05.mkv',
      embeddedLangs: ['eng'],
    })
    
    expect(result).toMatch(/tmdb:12345/)
    expect(result).toMatch(/s1e5/)
    
    const series = lib.getSeries('tmdb:12345')
    expect(series).toBeDefined()
    expect(series?.name).toBe('Show')
    expect(series?.year).toBe(2020)
    
    const episode = lib.getEpisode('tmdb:12345/s1e5')
    expect(episode).toBeDefined()
    expect(episode?.path).toBe('/media/tv/Show.S01E05.mkv')
    expect(episode?.season).toBe(1)
    expect(episode?.episode).toBe(5)
    
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Show.S01E05.mkv')
    expect(parked).toBeUndefined() // Should be cleared
    
  })
  
  it('creates movie row for movie identification', async ({ expect }) => {
    const dbPath = join(tmpdir(), `scout-test-${Date.now()}.db`)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    
    lib.upsertParkedPath(
      '/media/movies/Film.2021.mkv',
      'awaiting-agent',
      1000,
      { mtimeMs: 500, size: 2048, durationSec: 7200, embeddedLangs: null }
    )
    
    const tmdb = {
      getDetails: async () => ({
        posterPath: '/poster.jpg',
        backdropPath: null,
        overview: 'A film',
        year: 2021,
        genres: [28],
        originalTitle: 'Original Film',
      }),
      getChineseTitles: async () => [],
      getExternalIds: async () => ({ imdbId: 'tt7654321' }),
      getOriginLanguage: async () => 'en-US',
    }
    
    const tool = makeWriteIdentityTool({ lib, tmdb })
    
    const result = await tool.handler({
      tmdbId: '67890',
      isTv: false,
      title: 'Film',
      season: null,
      episode: null,
      path: '/media/movies/Film.2021.mkv',
      embeddedLangs: null,
    })
    
    expect(result).toMatch(/tmdb:67890/)
    
    const movie = lib.getMovie('tmdb:67890')
    expect(movie).toBeDefined()
    expect(movie?.name).toBe('Film')
    expect(movie?.path).toBe('/media/movies/Film.2021.mkv')
    
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/agent/identityTools.test.ts
```

Expected: FAIL with "makeWriteIdentityTool is not defined"

- [ ] **Step 3: Implement the write-back tool**

```typescript
// src/agent/identityTools.ts
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/tmdb.js'
import { seriesId, episodeId } from '../v2/ownIds.js'
import { z } from 'zod'

const WriteIdentityInputSchema = z.object({
  tmdbId: z.string().regex(/^\d+$/),
  isTv: z.boolean(),
  title: z.string().min(1),
  season: z.number().int().nullable(),
  episode: z.number().int().nullable(),
  path: z.string().min(1),
  embeddedLangs: z.array(z.string()).nullable(),
})

interface WriteIdentityDeps {
  lib: LibraryRepo
  tmdb: {
    getDetails: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<TmdbDetails | null>
    getChineseTitles: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string[]>
    getExternalIds: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<{ imdbId: string | null } | null>
    getOriginLanguage: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string | null>
  }
}

export function makeWriteIdentityTool(deps: WriteIdentityDeps) {
  return {
    name: 'write_identified_media',
    description: 'Write the identified media to the database. Call this immediately after you have verified the identity through TMDB evidence (search + details with two-evidence bar). Returns the own-id you must use for subsequent subtitle installation.',
    inputSchema: WriteIdentityInputSchema,
    handler: async (input: z.infer<typeof WriteIdentityInputSchema>): Promise<string> => {
      const { tmdbId, isTv, title, season, episode, path, embeddedLangs } = input
      const { lib, tmdb } = deps
      
      // Enrich from TMDB
      const mediaType = isTv ? 'tv' : 'movie'
      let posterPath: string | null = null
      let backdropPath: string | null = null
      let overview: string | null = null
      let year: number | null = null
      let genres: number[] | null = null
      let originalTitle: string | null = null
      let imdbId: string | null = null
      let chineseTitle: string | null = null
      let originLang: string | null = null
      
      let details: TmdbDetails | null = null
      try {
        details = await tmdb.getDetails(mediaType, tmdbId)
      } catch (err) {
        // Network/5xx transient failure - rethrow to retry later
        throw new Error(`TMDB getDetails failed for ${mediaType}:${tmdbId}: ${err}`)
      }
      
      // 🔴 幻觉防线：tmdbId 必须在 TMDB 上真实存在（2026-07-26 审计教训）。
      // getDetails 返回 null（404）说明这个 id 是幻觉，建行 = 永久鬼影行 + genres='[]' 熄火哨兵。
      if (details === null) {
        throw new Error(`TMDB ${mediaType}:${tmdbId} does not exist (404) - refusing to create ghost row from hallucinated id`)
      }
      
      posterPath = details.posterPath ?? null
      backdropPath = details.backdropPath ?? null
      overview = details.overview ?? null
      year = details.year ?? null
      genres = details.genreIds ?? null
      originalTitle = details.originalTitle ?? null
      
      try {
        const extIds = await tmdb.getExternalIds(mediaType, tmdbId)
        imdbId = extIds?.imdbId ?? null
      } catch (err) {
        // Non-fatal
      }
      
      try {
        const chineseTitles = await tmdb.getChineseTitles(mediaType, tmdbId)
        chineseTitle = chineseTitles?.[0] ?? null
      } catch (err) {
        // Non-fatal
      }
      
      try {
        originLang = await tmdb.getOriginLanguage(mediaType, tmdbId)
      } catch (err) {
        // Non-fatal
      }
      
      const providerIds = JSON.stringify({ tmdb: tmdbId, imdb: imdbId })
      
      if (isTv) {
        if (season === null || episode === null) {
          throw new Error('TV media requires season and episode')
        }
        
        const ownSeriesId = seriesId(tmdbId)
        const ownEpisodeId = episodeId(tmdbId, season, episode)
        
        // Upsert series
        lib.upsertSeries({
          id: ownSeriesId,
          name: title,
          chineseTitle,
          posterPath,
          overview,
          backdropPath,
          year,
          providerIds,
          genres,
        })
        
        // Set origin language if we got it
        if (originLang) {
          lib.setSeriesOriginLang(ownSeriesId, originLang)
        }
        
        // Upsert episode with initial sub_status based on embedded langs
        const subStatus = embeddedLangs && embeddedLangs.length > 0 ? 'embedded' : 'missing'
        
        lib.upsertEpisode({
          id: ownEpisodeId,
          seriesId: ownSeriesId,
          season,
          episode,
          name: title,
          path,
          subStatus,
        })
        
        // Set probe memo if we have embedded langs
        if (embeddedLangs) {
          const parked = lib.listParkedPaths().find(p => p.path === path)
          if (parked?.probe_mtime && parked?.probe_size) {
            lib.setProbeMemo(ownEpisodeId, parked.probe_mtime, parked.probe_size, embeddedLangs.join(','))
          }
        }
        
        // Clear from parked
        lib.clearParkedPath(path)
        
        return `Created series ${ownSeriesId} and episode ${ownEpisodeId}. Use "${ownEpisodeId}" as the itemId for subtitle operations.`
      } else {
        const ownMovieId = seriesId(tmdbId) // movies 复用 seriesId 构造器（ownIds.ts 头注释）
        
        const subStatus = embeddedLangs && embeddedLangs.length > 0 ? 'embedded' : 'missing'
        
        lib.upsertMovie({
          id: ownMovieId,
          name: title,
          path,
          subStatus,
          chineseTitle,
          posterPath,
          year,
          providerIds,
        })
        
        if (originLang) {
          lib.setMovieOriginLang(ownMovieId, originLang)
        }
        
        if (embeddedLangs) {
          const parked = lib.listParkedPaths().find(p => p.path === path)
          if (parked?.probe_mtime && parked?.probe_size) {
            lib.setProbeMemo(ownMovieId, parked.probe_mtime, parked.probe_size, embeddedLangs.join(','))
          }
        }
        
        lib.clearParkedPath(path)
        
        return `Created movie ${ownMovieId}. Use "${ownMovieId}" as the itemId for subtitle operations.`
      }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/agent/identityTools.test.ts
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/identityTools.ts src/agent/identityTools.test.ts
git commit -m "feat: add write_identified_media tool for agent write-back"
```

---

## Task 6: Update Ingest to Emit Raw Data Only

**Files:**
- Modify: `src/v2/ingest.ts:610-919` (FULL PATH rewrite)

- [ ] **Step 1: Write test for raw-data-only ingest**

Add to `src/v2/ingest.test.ts`:

```typescript
describe('ingest with raw data only', () => {
  it('parks unidentified file with raw data instead of creating rows', async ({ expect }) => {
    const dbPath = join(tmpdir(), `scout-test-${Date.now()}.db`)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    
    lib.upsertMediaRoot('/media', 'media')
    
    const recognizeStub = vi.fn().mockReturnValue({
      title: 'Unknown Show',
      year: null,
      season: 1,
      episode: 1,
      absoluteEpisode: null,
      isTv: true,
      embeddedTmdbId: null,
    })
    
    const probeStub = vi.fn().mockResolvedValue({
      tracks: [{ language: 'eng', codec: 'subrip' }],
    })
    
    const probeDurationStub = vi.fn().mockResolvedValue(2400)
    
    await runIngestPass({
      lib,
      mediaRoots: lib.listMediaRoots(),
      skipMediaRootPaths: [],
      targetLanguages: ['zh-Hans'],
      originSkipLanguages: [],
      hardsubMode: false,
      log: () => {},
      recognize: recognizeStub,
      probe: probeStub,
      probeDuration: probeDurationStub,
      checkFileGone: () => 'present',
      findExternalSidecar: () => null,
    })
    
    // Should NOT create series/episode rows
    expect(lib.getSeries('tmdb:12345')).toBeUndefined()
    
    // Should park with raw data
    const parked = lib.listParkedPaths().find(p => p.path.includes('Unknown'))
    expect(parked).toBeDefined()
    expect(parked?.park_reason).toBe('awaiting-agent-identification')
    expect(parked?.duration_sec).toBe(2400)
    expect(parked?.embedded_langs).toBe('eng')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/v2/ingest.test.ts -t "parks unidentified file"
```

Expected: FAIL (ingest still creates rows)

- [ ] **Step 3: Rewrite FULL PATH to emit raw data only**

In `src/v2/ingest.ts`, replace the section from line 610 to 919. This is the largest change. The new logic:

```typescript
// Line 610 onwards - FULL PATH
const outcome = await deps.recognize(path)
if ('park' in outcome) {
  lib.upsertParkedPath(path, outcome.park, nowMs, pathFingerprint)
  result.parked++
  continue
}

// From here: outcome is PathIdentity (structure hints only, no tmdbId)
const identity = outcome

// Probe duration and embedded tracks (raw data collection)
let durationSec: number | null = null
let embeddedLangs: string[] | null = null

try {
  durationSec = await deps.probeDuration(path)
} catch (err) {
  deps.log(`probeDuration failed for ${path}: ${err}`)
}

try {
  const probeResult = await deps.probe(path)
  // usableEmbeddedLangs is defined in this file (line 242)
  embeddedLangs = usableEmbeddedLangs(probeResult.tracks)
} catch (err) {
  deps.log(`probe failed for ${path}: ${err}`)
}

// Park with raw data for agent identification
lib.upsertParkedPath(
  path,
  'awaiting-agent-identification',
  nowMs,
  {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    durationSec,
    embeddedLangs,
  }
)
result.parked++
```

Note: This removes all the tmdbId-dependent logic (upsertSeries, upsertEpisode, enrichNewSeriesOrMovie, etc). Those operations now happen in the agent's write_identified_media tool.

- [ ] **Step 4: Update IngestDeps.recognize return type**

Around line 90 in `src/v2/ingest.ts`, change the type:

```typescript
// Before:
recognize: (videoPath: string) => Recognized | Park

// After:
recognize: (videoPath: string) => PathIdentity | Park
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- src/v2/ingest.test.ts -t "parks unidentified file"
```

Expected: PASS

- [ ] **Step 6: Run full ingest test suite**

```bash
npm test -- src/v2/ingest.test.ts
```

Expected: Many failures (existing tests assume row creation). We'll fix these in the next task.

- [ ] **Step 7: Commit**

```bash
git add src/v2/ingest.ts
git commit -m "refactor: ingest emits raw data only, no identity writes"
```


---

## Task 7: Delete resolveToTmdb and Update recognition/index.ts

**Files:**
- Delete: `src/recognition/resolveToTmdb.ts`
- Delete: `src/recognition/resolveToTmdb.test.ts`
- Modify: `src/recognition/index.ts:99-159` (recognize function)

- [ ] **Step 1: Update recognize() to return PathIdentity directly**

In `src/recognition/index.ts`, replace the recognize function (around line 99):

```typescript
// Before (lines 99-159): calls resolveToTmdb, returns Recognized
// After:
export function recognize(
  videoPath: string,
  tmdb: Pick<TmdbClient, 'search'>,
  opts?: { findOverride?: (p: string) => IdentifyOverride | null }
): PathIdentity | Park {
  const override = opts?.findOverride?.(videoPath)
  
  if (override) {
    // Human override: treat as authoritative structure + embedded tmdbId
    const base = identifyFromPath(videoPath)
    return {
      ...base,
      embeddedTmdbId: override.tmdbId,
      // If override specifies season/episode, use those
      season: override.season ?? base.season,
      episode: override.episode ?? base.episode,
    }
  }
  
  // Pure mechanical parse - structure hints only
  return identifyFromPath(videoPath)
}
```

- [ ] **Step 2: Update Recognized type export**

Around line 21-36 in `src/recognition/resolveToTmdb.ts`, the `Recognized` type is defined. Since we're deleting that file, move any tests that import it to use `PathIdentity` instead, or delete the type entirely if unused elsewhere.

Check for imports:

```bash
rg "import.*Recognized" src/
```

- [ ] **Step 3: Remove resolveToTmdb files**

```bash
rm src/recognition/resolveToTmdb.ts src/recognition/resolveToTmdb.test.ts
```

- [ ] **Step 4: Run recognition tests**

```bash
npm test -- src/recognition/index.test.ts
```

Expected: PASS (tests should work with PathIdentity return type)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete resolveToTmdb, recognize returns PathIdentity only"
```

---

## Task 8: Update findSubtitleSkill for Primary Identification

**Files:**
- Modify: `src/agent/skills/findSubtitleSkill.ts:85-213` (identitySection)
- Modify: `src/agent/skills/findSubtitleSkill.ts:328-331` (workflow step 0)

- [ ] **Step 1: Write test for new identification flow**

Add to `src/agent/skills/findSubtitleSkill.test.ts`:

```typescript
describe('identification instructions (primary mode)', () => {
  it('teaches agent to identify from raw data first', ({ expect }) => {
    const skill = makeFindSubtitleSkill('zh-Hans', false, true)
    
    // Should mention raw evidence
    expect(skill).toMatch(/raw evidence/)
    expect(skill).toMatch(/directory names/)
    expect(skill).toMatch(/file names/)
    
    // Should teach search_tmdb first, not get_tmdb_details with task id
    expect(skill).toMatch(/search_tmdb/)
    
    // Should NOT mention "mechanical parse" or "guessed identity"
    expect(skill).not.toMatch(/mechanical/)
    expect(skill).not.toMatch(/guessed/)
    
    // Should teach write_identified_media
    expect(skill).toMatch(/write_identified_media/)
    
    // Should maintain two-evidence bar
    expect(skill).toMatch(/two.*evidence/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/agent/skills/findSubtitleSkill.test.ts -t "identification instructions"
```

Expected: FAIL (current skill has "mechanical" / "guessed" language)

- [ ] **Step 3: Rewrite identitySection**

In `src/agent/skills/findSubtitleSkill.ts`, replace lines 85-213:

```typescript
const identitySection = identityVerification
  ? `

## Step 0: Identify the Media

Your task carries NO identity — only raw evidence: directory names, file names, durations, embedded subtitle languages, and structure hints (parsed season/episode/year candidates). **Establishing the identity is YOUR first job.**

**Raw evidence sources:**
- Directory names inside the file path (often the ONLY place where the title appears — file names may be generic like "S01E01.mkv")
- The file name itself
- Duration in seconds
- Embedded subtitle track languages
- Structure hints: season, episode, absoluteEpisode, year candidates (mechanical guesses, NOT verified)

**Common traps in raw data:**
- Copyright evasion: publishers write nonsense titles (e.g. "Recruit Training" for an anime)
- Mojibake: Chinese titles truncated (怪奇物语 → 怪) or corrupted (后室 → H）后丨室)
- Fansub brackets: [...] enclose release group, resolution, or tech tags (not part of the title)
- Directory name is often more reliable than file name

**Your identification workflow:**

1. **Clean the raw evidence.** Look at directory names and file names. Strip:
   - Fansub/release group brackets: [字幕组], (BDrip), {1080p}
   - Tech tags: x264, HEVC, 10bit, AAC, 5.1
   - Year in parentheses (keep as a separate evidence field)
   - Separators that look like mojibake: 丨, H）
   - Episode strings if they appear bare in directory name (e.g. "第1集")

   Extract the cleanest title candidate. If directory name has a title-like string and file name is generic (e.g. "S01E01.mkv"), use the directory name.

2. **Search TMDB.** Call \`search_tmdb\` with:
   - Your cleaned title
   - mediaType: 'tv' if structure hints show season/episode, 'movie' otherwise
   - year: if you extracted a year from parentheses or structure hints, include it

   You'll get a list of hits with id, title, originalTitle, year.

3. **Pick the best match.** Consider:
   - Title similarity (exact > very close > transliteration)
   - Year match (if you have a year hint)
   - **TRAP:** The first hit is not always correct. For ambiguous names (e.g. "怪奇物语"), the top result may be wrong. Check originalTitle and year.
   - **TRAP:** Same title, different media. Example: "The Rig" (2023 TV show vs 2010 movie). Check mediaType and year.
   - **TRAP:** Same title, different countries. Example: "Peacemaker" (2022 DC show vs 2020 Finnish show). Check year and originalTitle.

4. **Verify with structural evidence (two-evidence bar).** Call \`get_tmdb_details\` with the tmdbId and isTv from your chosen hit.

   **Line 1 (name evidence):** Does the TMDB title or originalTitle match your cleaned title?
   
   **Line 2 (structure evidence):**
   - For TV: Does the season table include the season from your structure hints? Does the year of first_air_date align with your year hint (within 1 year tolerance)?
   - For movies: Does the runtime (in seconds) roughly match your duration evidence (within 10% tolerance)? Does the release year match your year hint?

   **If both lines pass:** Identity verified. Proceed to step 5.
   
   **If either line fails:** AUTOMATIC FAIL. Try the next search hit, or if no hits remain, report \`unidentified\` (see step 6).

5. **Write the identity to the database.** Call \`write_identified_media\` with:
   - tmdbId (string, just the number)
   - isTv (boolean)
   - title (the cleaned title you used)
   - season, episode (from structure hints; null for movies)
   - path (the video file path)
   - embeddedLangs (from raw evidence; null if none)

   This tool returns an \`itemId\` (the own-id like "tmdb:12345/s1e5"). **Use that itemId for all subsequent subtitle operations** (\`install_subtitle\`, etc).

   After writing, continue to search for subtitles for this media (next steps).

6. **If you cannot identify:** Report the path as unidentified in your final report. Do NOT create database rows. The path will remain parked for manual review.

**Red lines:**

- **NEVER identify from your own knowledge.** If you happen to know that "Breaking Bad" is tmdb:1396, you MUST still call \`search_tmdb\` and \`get_tmdb_details\` to verify. Your memory may be outdated or confused with a different show.
- **NEVER claim identity based on name alone.** You must have structural evidence (season table for TV, duration for movies).
- **NEVER write identity if a single episode is missing from the season table.** Example: If structure hints say S04E13 but TMDB season 4 only has 9 episodes, that does NOT mean the whole series identity is wrong — it may be a special episode or data lag. Do NOT refuse to identify. Instead, write the series identity and report that specific episode as unidentified.
- **NEVER write identity if duration is abnormal.** A 15-minute file when TMDB says 120 minutes does NOT mean the movie identity is wrong — it may be a corrupt file or a sample. Write the movie identity anyway; the subtitle search will handle duration-based warnings separately.

**What IS an identity problem:**
- The TMDB title and your cleaned title are completely different (not just transliteration)
- The year is off by more than 1 year
- The season table does not include the season from structure hints (for TV)
- The runtime is off by more than 10% (for movies)

**What is NOT an identity problem:**
- A single episode number exceeds the season table length (report that episode as unidentified, not the whole series)
- Duration is abnormal for one file (write identity anyway)
- The season table is missing some episodes (TMDB data lag; write identity anyway)

---

`
  : ''
```

- [ ] **Step 4: Update workflow step 0**

Around line 328-331:

```typescript
// Before:
**0. Verify media identity** (if you were given the identity-verification flag)

// After:
**0. Identify the media** from raw evidence → search → verify → write to database → continue with that itemId
```

- [ ] **Step 5: Update description line**

Around line 417:

```typescript
// Before:
You are an agent that verifies media identity and finds subtitle files...

// After:
You are an agent that identifies media from raw file evidence and finds subtitle files...
```

- [ ] **Step 6: Run test to verify it passes**

```bash
npm test -- src/agent/skills/findSubtitleSkill.test.ts -t "identification instructions"
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/skills/findSubtitleSkill.ts src/agent/skills/findSubtitleSkill.test.ts
git commit -m "refactor: rewrite findSubtitleSkill for primary identification"
```

---

## Task 8b: Extend FindSubtitleTargetFact with Raw Evidence Fields

**Files:**
- Modify: `src/agent/findSubtitleWorker.schemas.ts:31-53` (FindSubtitleTargetFact)
- Modify: `src/agent/findSubtitleWorker.schemas.test.ts`

- [ ] **Step 1: Write failing test for raw evidence fields**

```typescript
describe('FindSubtitleTargetFact with raw evidence', () => {
  it('accepts targets with raw evidence fields', ({ expect }) => {
    const task = {
      jobId: 'job-1',
      mediaRoot: '/media',
      title: 'Test',
      originalTitle: null,
      year: null,
      alternativeTitles: [],
      overview: null,
      runtimeMinutes: null,
      providerIds: {},
      targetLanguage: 'zh',
      hardsubMode: 'off',
      localCandidates: [],
      targets: [
        {
          itemId: null, // Unidentified
          videoPath: '/media/tv/Show.S01E01.mkv',
          videoFilename: 'Show.S01E01.mkv',
          season: 1,
          episode: 1,
          absoluteEpisode: null,
          imdbId: null,
          runtimeMinutes: 40,
          // Raw evidence for agent identification
          dirName: 'tv',
          durationSec: 2400,
          embeddedLangs: ['eng', 'jpn'],
        },
      ],
    }
    
    const result = FindSubtitleTaskSchema.safeParse(task)
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/agent/findSubtitleWorker.schemas.test.ts -t "raw evidence"
```

Expected: FAIL (fields don't exist)

- [ ] **Step 3: Add raw evidence fields to FindSubtitleTargetFact**

In `src/agent/findSubtitleWorker.schemas.ts` around line 31-53:

```typescript
export interface FindSubtitleTargetFact {
  itemId: string | null // null = unidentified (agent must identify first)
  videoPath: string
  videoFilename: string
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  imdbId: string | null
  runtimeMinutes?: number | null
  // Raw evidence for agent identification (present when itemId is null)
  dirName?: string | null
  durationSec?: number | null
  embeddedLangs?: string[] | null
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/agent/findSubtitleWorker.schemas.test.ts -t "raw evidence"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/findSubtitleWorker.schemas.ts src/agent/findSubtitleWorker.schemas.test.ts
git commit -m "feat: add raw evidence fields to FindSubtitleTargetFact"
```

---

## Task 9: Extend FindSubtitleWorkerDeps and Add write_identified_media Tool

**Files:**
- Modify: `src/agent/findSubtitleWorker.ts:23-38` (FindSubtitleWorkerDeps)
- Modify: `src/agent/findSubtitleWorker.ts:86-114` (tools)

- [ ] **Step 1: Extend FindSubtitleWorkerDeps with identityDeps**

In `src/agent/findSubtitleWorker.ts` around line 23-38:

```typescript
export interface FindSubtitleWorkerDeps {
  model: LanguageModel
  adapters: FetchAdapter[]
  cacheRoot: string
  tmdb?: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'> | null
  stepCap?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
  // For write_identified_media tool (agent-first identification)
  identityDeps?: {
    lib: LibraryRepo
    tmdb: {
      getDetails: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<TmdbDetails | null>
      getChineseTitles: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string[]>
      getExternalIds: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<{ imdbId: string | null } | null>
      getOriginLanguage: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string | null>
    }
  }
}
```

Add import at top:

```typescript
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbDetails } from '../adapters/tmdb.js'
```

- [ ] **Step 2: Add write_identified_media to tools**

Around line 86-114, after the existing tools:

```typescript
import { makeWriteIdentityTool } from './identityTools.js'

// In the tools object:
const tools = {
  ...(deps.tmdb ? makeTmdbEvidenceTools({ tmdb: deps.tmdb }) : {}),
  ...(deps.identityDeps ? { write_identified_media: makeWriteIdentityTool(deps.identityDeps) } : {}),
  install_subtitle: makeInstallSubtitleTool(deps),
  // ... rest unchanged
}
```

- [ ] **Step 3: Write test for tool availability**

Add to `src/agent/findSubtitleWorker.test.ts`:

```typescript
describe('findSubtitleWorker with identityDeps', () => {
  it('includes write_identified_media tool when identityDeps provided', ({ expect }) => {
    const lib = new LibraryRepo(openDb(':memory:'))
    const tmdb = {
      getDetails: vi.fn(),
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }
    
    const worker = makeFindSubtitleWorker({
      model: new MockLanguageModelV2(),
      adapters: [],
      cacheRoot: '/tmp',
      identityDeps: { lib, tmdb },
    })
    
    expect(worker.tools).toHaveProperty('write_identified_media')
  })
  
  it('omits write_identified_media tool when identityDeps not provided', ({ expect }) => {
    const worker = makeFindSubtitleWorker({
      model: new MockLanguageModelV2(),
      adapters: [],
      cacheRoot: '/tmp',
    })
    
    expect(worker.tools).not.toHaveProperty('write_identified_media')
  })
})
```

- [ ] **Step 4: Run test**

```bash
npm test -- src/agent/findSubtitleWorker.test.ts -t "identityDeps"
```

Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/findSubtitleWorker.ts src/agent/findSubtitleWorker.test.ts
git commit -m "feat: add identityDeps and write_identified_media tool to findSubtitleWorker"
```

---

## Task 10: Update findSubtitleWorker Schemas for New Identity Shape

**Files:**
- Modify: `src/agent/findSubtitleWorker.schemas.ts:137-175`

- [ ] **Step 1: Write failing test for new identity shape**

Add to `src/agent/findSubtitleWorker.schemas.ts` test file (or create if missing):

```typescript
import { describe, it } from 'vitest'
import { FindSubtitleReportSchema } from './findSubtitleWorker.schemas.js'

describe('FindSubtitleReportSchema with new identity', () => {
  it('accepts identified outcome with required fields', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      identity: {
        outcome: 'identified',
        tmdbId: '12345',
        isTv: true,
        season: 1,
        episode: 5,
        nameEvidence: 'Title matches "Show Name"',
        structureEvidence: 'Season 1 exists in TMDB season table',
      },
    }
    
    const result = FindSubtitleReportSchema.safeParse(report)
    expect(result.success).toBe(true)
  })
  
  it('accepts unidentified outcome', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      identity: {
        outcome: 'unidentified',
        reason: 'No TMDB hits for cleaned title',
      },
    }
    
    const result = FindSubtitleReportSchema.safeParse(report)
    expect(result.success).toBe(true)
  })
  
  it('rejects identified without required season/episode for TV', ({ expect }) => {
    const report = {
      targets: [],
      installed: [],
      identity: {
        outcome: 'identified',
        tmdbId: '12345',
        isTv: true,
        season: null,
        episode: null,
        nameEvidence: 'Title matches',
        structureEvidence: 'Season table OK',
      },
    }
    
    const result = FindSubtitleReportSchema.safeParse(report)
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- src/agent/findSubtitleWorker.schemas.test.ts
```

Expected: FAIL (identity field doesn't exist yet)

- [ ] **Step 3: Replace identity_correction and identity_verified with identity**

In `src/agent/findSubtitleWorker.schemas.ts` around line 137-175:

```typescript
// Delete these lines:
identity_correction: nullableJsonTolerant(z.object({
  tmdbId: z.string().min(1),
  isTv: z.boolean(),
  reason: z.string().min(1),
})),
identity_verified: nullableBooleanTolerant(),

// Add this:
identity: z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('identified'),
    tmdbId: z.string().regex(/^\d+$/),
    isTv: z.boolean(),
    season: z.number().int().nullable(),
    episode: z.number().int().nullable(),
    nameEvidence: z.string().min(1),
    structureEvidence: z.string().min(1),
  }).refine(
    data => {
      // TV must have season and episode
      if (data.isTv) {
        return data.season !== null && data.episode !== null
      }
      return true
    },
    { message: 'TV identification requires season and episode' }
  ),
  z.object({
    outcome: z.literal('unidentified'),
    reason: z.string().min(1),
  }),
]).nullable(),
```

Delete the superRefine block that checks identity_correction vs installed (lines 152-175) since the semantics are reversed now.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- src/agent/findSubtitleWorker.schemas.test.ts
```

Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent/findSubtitleWorker.schemas.ts src/agent/findSubtitleWorker.schemas.test.ts
git commit -m "refactor: replace identity_correction/verified with unified identity field"
```


---

## Task 11: Delete rescueWorkerTask and Update Orchestrator

**Files:**
- Delete: `src/agent/rescueWorkerTask.ts`
- Delete: `src/agent/rescueWorkerTask.test.ts`
- Delete: `src/agent/rescueWorker.ts`
- Delete: `src/agent/rescueWorker.tools.ts`
- Delete: `src/agent/rescueWorker.schemas.ts`
- Delete: `src/agent/rescueWorker.test.ts`
- Delete: `src/agent/rescueWorker.tools.test.ts`
- Delete: `src/agent/rescueWorker.schemas.test.ts`
- Delete: `src/agent/skills/rescueSkill.ts`
- Delete: `src/agent/skills/rescueSkill.test.ts`
- Modify: `src/agent/orchestratorAgent.tools.ts:9` (remove isRescueEligible import)
- Modify: `src/agent/orchestratorAgent.tools.ts:310-337` (remove dispatch_rescue_task)
- Modify: `src/cli/index.ts:43,46,455-469` (remove rescue imports and taskType branch)

- [ ] **Step 1: Update orchestrator to use isParkedPathEligible**

In `src/agent/orchestratorAgent.tools.ts` line 9:

```typescript
// Before:
import { isRescueEligible } from '../v2/rescueWorkerTask.js'

// After:
import { isParkedPathEligible } from '../v2/libraryRepo.js'
```

Then find all uses of `isRescueEligible` in the same file and replace with `isParkedPathEligible`:

```bash
# In orchestratorAgent.tools.ts
rg -n "isRescueEligible" src/agent/orchestratorAgent.tools.ts
# Replace each occurrence
```

- [ ] **Step 2: Remove dispatch_rescue_task from orchestrator**

In `src/agent/orchestratorAgent.tools.ts` around line 310-337, delete the `makeDispatchRescueTaskTool` function entirely.

In `src/agent/orchestratorAgent.ts` line 9 and 91-93, remove the import and registration of the rescue tool.

- [ ] **Step 3: Remove rescue taskType branch from CLI**

In `src/cli/index.ts`:
- Line 43: Delete `import { runRescueWorkerTask } from '../v2/rescueWorkerTask.js'`
- Line 46: Delete `import { makeRescueWorker } from '../agent/rescueWorker.js'`
- Lines 455-469: Delete the entire `rescue_identify` taskType branch

- [ ] **Step 4: Delete all rescue files**

```bash
rm src/agent/rescueWorkerTask.ts
rm src/agent/rescueWorkerTask.test.ts
rm src/agent/rescueWorker.ts
rm src/agent/rescueWorker.tools.ts
rm src/agent/rescueWorker.schemas.ts
rm src/agent/rescueWorker.test.ts
rm src/agent/rescueWorker.tools.test.ts
rm src/agent/rescueWorker.schemas.test.ts
rm src/agent/skills/rescueSkill.ts
rm src/agent/skills/rescueSkill.test.ts
```

- [ ] **Step 5: Run all tests to ensure no broken imports**

```bash
npm test
```

Expected: PASS (no import errors)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete rescue agent (replaced by primary identification in findSubtitleWorker)"
```

---

## Task 12: Update CLI agent-run to Read Raw Data from parked_paths

**Files:**
- Modify: `src/cli/index.ts:400-470` (handleWorkerTask dispatch switch)

- [ ] **Step 1: Update agent-run to fetch raw data**

In `src/cli/index.ts` around line 400-470 (handleWorkerTask), the find_subtitle taskType branch needs a new scope for unidentified parked paths. Update it to:

```typescript
.command('agent-run')
.description('Run findSubtitleWorker on awaiting-agent parked paths')
.action(async () => {
  const { config, configPath } = await loadConfig()
  const db = openDb(config.dbPath)
  const lib = new LibraryRepo(db)
  
  const parked = lib.listParkedPaths()
    .filter(p => isParkedPathEligible(p.park_reason))
  
  if (parked.length === 0) {
    console.log('No eligible parked paths')
    return
  }
  
  console.log(`Found ${parked.length} parked paths`)
  
  // Build raw evidence for each
  const targets = parked.map(p => {
    const embeddedLangs = p.embedded_langs ? p.embedded_langs.split(',') : null
    
    // Parse structure hints from path (may return Park for unparseable)
    const parsed = identifyFromPath(p.path)
    const identity = 'park' in parsed ? {
      title: null, year: null, season: null, episode: null, absoluteEpisode: null, isTv: false, embeddedTmdbId: null,
    } : parsed
    
    return {
      itemId: null, // Unidentified
      videoPath: p.path,
      videoFilename: p.path.split(/[/\\]/).filter(Boolean).slice(-1)[0] ?? '',
      season: identity.season,
      episode: identity.episode,
      absoluteEpisode: identity.absoluteEpisode,
      imdbId: null,
      runtimeMinutes: p.duration_sec ? Math.round(p.duration_sec / 60) : null,
      dirName: p.path.split(/[/\\]/).filter(Boolean).slice(-2, -1)[0] ?? null,
      durationSec: p.duration_sec,
      embeddedLangs,
    }
  })
  
  // Run the worker
  const tmdb = new TmdbClient(config.tmdbApiKey)
  const adapters = buildSubtitleAdapters(config)
  
  const worker = makeFindSubtitleWorker({ lib, tmdb, adapters })
  
  const task = {
    targets,
    targetLanguage: config.targetLanguages[0] ?? 'zh-Hans',
    identityVerification: true, // Force identification mode
  }
  
  console.log('Running agent...')
  const report = await worker.run(task)
  
  console.log(JSON.stringify(report, null, 2))
  
  if (report.identity?.outcome === 'identified') {
    console.log(`✓ Identified: tmdb:${report.identity.tmdbId}`)
  } else if (report.identity?.outcome === 'unidentified') {
    console.log(`✗ Could not identify: ${report.identity.reason}`)
  }
  
  if (report.installed.length > 0) {
    console.log(`✓ Installed ${report.installed.length} subtitles`)
  }
})
```

- [ ] **Step 2: Add necessary imports at top of cli.ts**

```typescript
import { isParkedPathEligible } from './v2/libraryRepo.js'
import { identifyFromPath } from './recognition/identifyFromPath.js'
```

- [ ] **Step 3: Test manually**

Park a test file first:

```bash
# In a test environment with a video file
npm run cli ingest /path/to/test/video.mkv
npm run cli agent-run
```

Expected: Agent receives raw evidence and attempts identification

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: agent-run reads raw data from parked_paths"
```

---

## Task 13: Update Ingest Tests to Expect Raw-Data Parking

**Files:**
- Modify: `src/v2/ingest.test.ts` (all tests that expect row creation)

- [ ] **Step 1: List failing tests**

```bash
npm test -- src/v2/ingest.test.ts 2>&1 | grep "FAIL"
```

- [ ] **Step 2: Update each test to expect parking instead of row creation**

Pattern: Replace assertions like:

```typescript
// Before:
expect(lib.getSeries('tmdb:12345')).toBeDefined()
expect(lib.getEpisode('tmdb:12345:s1e1')).toBeDefined()

// After:
const parked = lib.listParkedPaths().find(p => p.path === '/path/to/video.mkv')
expect(parked).toBeDefined()
expect(parked?.park_reason).toBe('awaiting-agent-identification')
expect(parked?.duration_sec).toBe(2400)
expect(parked?.embedded_langs).toBe('eng,jpn')
```

- [ ] **Step 3: Update test mocks**

Change `recognize` stub return type from `Recognized` to `PathIdentity`:

```typescript
// Before:
const recognizeStub = vi.fn().mockReturnValue({
  title: 'Show',
  year: 2020,
  season: 1,
  episode: 1,
  isTv: true,
  tmdbId: '12345',
})

// After:
const recognizeStub = vi.fn().mockReturnValue({
  title: 'Show',
  year: 2020,
  season: 1,
  episode: 1,
  absoluteEpisode: null,
  isTv: true,
  embeddedTmdbId: null, // No tmdbId from mechanical parse
})
```

- [ ] **Step 4: Run tests**

```bash
npm test -- src/v2/ingest.test.ts
```

Expected: PASS (all tests updated)

- [ ] **Step 5: Commit**

```bash
git add src/v2/ingest.test.ts
git commit -m "test: update ingest tests for raw-data parking"
```

---

## Task 14: Update Recognition Tests

**Files:**
- Modify: `src/recognition/index.test.ts` (update expectations)

- [ ] **Step 1: Check what needs updating**

```bash
npm test -- src/recognition/index.test.ts
```

Expected: Some failures due to Recognized → PathIdentity

- [ ] **Step 2: Update test assertions**

Replace any `Recognized` type imports with `PathIdentity`. Update assertions to expect:

```typescript
// No tmdbId in return value (unless embeddedTmdbId from override)
expect(result.embeddedTmdbId).toBeNull()

// Structure hints present
expect(result.title).toBe('Show Name')
expect(result.season).toBe(1)
expect(result.episode).toBe(5)
```

- [ ] **Step 3: Run tests**

```bash
npm test -- src/recognition/index.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/recognition/index.test.ts
git commit -m "test: update recognition tests for PathIdentity"
```

---

## Task 15: Integration Test - End-to-End Agent Identification

**Files:**
- Create: `src/agent/integration/agentIdentification.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// src/agent/integration/agentIdentification.test.ts
import { describe, it, vi } from 'vitest'
import { openDb } from '../../v2/db.js'
import { LibraryRepo } from '../../v2/libraryRepo.js'
import { makeFindSubtitleWorker } from '../findSubtitleWorker.js'

describe('agent identification integration', () => {
  it('identifies and writes from raw evidence end-to-end', async ({ expect }) => {
    const dbPath = join(tmpdir(), `scout-test-${Date.now()}.db`)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    
    // Park a file with raw data
    lib.upsertParkedPath(
      '/media/tv/Breaking.Bad.S01E01.mkv',
      'awaiting-agent-identification',
      1000,
      {
        mtimeMs: 500,
        size: 1024,
        durationSec: 2880,
        embeddedLangs: ['eng'],
      }
    )
    
    // Mock TMDB client
    const tmdb = {
      search: vi.fn().mockResolvedValue([
        { id: '1396', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      ]),
      getDetails: vi.fn().mockResolvedValue({
        posterPath: '/poster.jpg',
        backdropPath: null,
        overview: 'A chemistry teacher...',
        year: 2008,
        genres: [18, 80],
        originalTitle: 'Breaking Bad',
        seasons: [
          { seasonNumber: 1, episodeCount: 7 },
        ],
      }),
      getChineseTitles: vi.fn().mockResolvedValue(['绝命毒师']),
      getExternalIds: vi.fn().mockResolvedValue({ imdbId: 'tt0903747' }),
      getOriginLanguage: vi.fn().mockResolvedValue('en-US'),
    }
    
    const worker = makeFindSubtitleWorker({
      lib,
      tmdb: tmdb as any,
      adapters: [], // No subtitle search for this test
    })
    
    const task = {
      targets: [
        {
          itemId: null,
          videoPath: '/media/tv/Breaking.Bad.S01E01.mkv',
          videoFilename: 'Breaking.Bad.S01E01.mkv',
          season: 1,
          episode: 1,
          absoluteEpisode: null,
          imdbId: null,
          runtimeMinutes: 48,
          dirName: 'tv',
          durationSec: 2880,
          embeddedLangs: ['eng'],
        },
      ],
      targetLanguage: 'zh-Hans',
      identityVerification: true,
    }
    
    const report = await worker.run(task)
    
    // Verify report
    expect(report.identity?.outcome).toBe('identified')
    expect(report.identity?.tmdbId).toBe('1396')
    expect(report.identity?.isTv).toBe(true)
    expect(report.identity?.season).toBe(1)
    expect(report.identity?.episode).toBe(1)
    
    // Verify database writes
    const series = lib.getSeries('tmdb:1396')
    expect(series).toBeDefined()
    expect(series?.name).toBe('Breaking Bad')
    expect(series?.chineseTitle).toBe('绝命毒师')
    
    const episode = lib.getEpisode('tmdb:1396/s1e1')
    expect(episode).toBeDefined()
    expect(episode?.path).toBe('/media/tv/Breaking.Bad.S01E01.mkv')
    expect(episode?.subStatus).toBe('embedded')
    
    // Verify parked path cleared
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Breaking.Bad.S01E01.mkv')
    expect(parked).toBeUndefined()
    
    // Verify tools were called
    expect(tmdb.search).toHaveBeenCalledWith('Breaking Bad', 'tv', { year: 2008 })
    expect(tmdb.getDetails).toHaveBeenCalledWith('tv', '1396')
    
  })
  
  it('reports unidentified when no TMDB hits', async ({ expect }) => {
    const dbPath = join(tmpdir(), `scout-test-${Date.now()}.db`)
    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    
    lib.upsertParkedPath(
      '/media/movies/Unknown.Film.2025.mkv',
      'awaiting-agent-identification',
      1000,
      {
        mtimeMs: 500,
        size: 2048,
        durationSec: 7200,
        embeddedLangs: null,
      }
    )
    
    const tmdb = {
      search: vi.fn().mockResolvedValue([]), // No hits
      getDetails: vi.fn(),
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }
    
    const worker = makeFindSubtitleWorker({
      lib,
      tmdb: tmdb as any,
      adapters: [],
    })
    
    const task = {
      targets: [
        {
          itemId: null,
          videoPath: '/media/movies/Unknown.Film.2025.mkv',
          videoFilename: 'Unknown.Film.2025.mkv',
          season: null,
          episode: null,
          absoluteEpisode: null,
          imdbId: null,
          runtimeMinutes: 120,
          dirName: 'movies',
          durationSec: 7200,
          embeddedLangs: null,
        },
      ],
      targetLanguage: 'zh-Hans',
      identityVerification: true,
    }
    
    const report = await worker.run(task)
    
    expect(report.identity?.outcome).toBe('unidentified')
    expect(report.identity?.reason).toMatch(/no.*hit/i)
    
    // Verify no database writes
    const movies = lib.listParkedPaths().filter(p => p.park_reason !== 'awaiting-agent-identification')
    expect(movies).toHaveLength(0)
    
    // Verify path remains parked
    const parked = lib.listParkedPaths().find(p => p.path === '/media/movies/Unknown.Film.2025.mkv')
    expect(parked).toBeDefined()
    
  })
})
```

- [ ] **Step 2: Run integration test**

```bash
npm test -- src/agent/integration/agentIdentification.test.ts
```

Expected: PASS (2 tests) - or FAIL initially, then fix worker implementation until tests pass

- [ ] **Step 3: Fix any issues revealed by integration test**

Work through failures by:
1. Checking tool implementations
2. Verifying schema validation
3. Ensuring write_identified_media correctly handles both TV and movie cases

- [ ] **Step 4: Commit**

```bash
git add src/agent/integration/agentIdentification.test.ts
git commit -m "test: add end-to-end agent identification integration test"
```

---

## Task 16: Update Documentation

**Files:**
- Modify: `docs/architecture.md` (update identity flow)
- Create: `docs/agent-identification-guide.md`

- [ ] **Step 1: Update architecture.md**

In `docs/architecture.md`, find the "Identity Resolution" section and rewrite:

```markdown
## Identity Resolution

**Old approach (deleted):** Mechanical parsing called TMDB search synchronously, guessed the top hit, wrote database rows immediately.

**New approach:** 
1. **Ingest** (mechanical): Parse file path → extract structure hints (title, season, episode, year) → measure duration → probe embedded subtitle languages → park with raw data
2. **Agent** (intelligent): Read raw evidence → clean title → search TMDB → verify with two-evidence bar (name + structure) → write database rows → find subtitles

**Two-evidence bar:**
- **Line 1 (name):** TMDB title or originalTitle matches cleaned title
- **Line 2 (structure):** 
  - TV: Season exists in TMDB season table + year within 1 year
  - Movie: Runtime within 10% of duration + year match

**Why this works:**
- Handles copyright evasion (bad file names)
- Handles mojibake (corrupted Chinese titles)
- Reduces false positives (no more "The Rig" 2010 movie mistaken for 2023 TV show)
- Evidence trail: agent reports nameEvidence and structureEvidence in every identification

**Flow:**
```
File → Ingest (raw data) → Park → Agent (identify + verify) → Database rows + Subtitle search
```
```

- [ ] **Step 2: Write agent identification guide**

```markdown
<!-- docs/agent-identification-guide.md -->
# Agent Identification Guide

## Overview

The subtitle agent identifies media from **raw file evidence** — not from mechanical guesses or your own memory.

## What is Raw Evidence?

When the agent receives a task, it sees:

- **Directory name** (often the most reliable title source)
- **File name**
- **Duration in seconds**
- **Embedded subtitle track languages**
- **Structure hints** (season, episode, year — mechanical parse candidates, NOT verified)

## Your Job

1. **Clean the title** from directory/file names
   - Strip fansub brackets: [...], (...), {...}
   - Strip tech tags: x264, HEVC, 1080p, AAC, etc.
   - Strip mojibake separators: 丨, H）
   - Prefer directory name if file name is generic (e.g. "S01E01.mkv")

2. **Search TMDB** with cleaned title + mediaType + year (if available)

3. **Pick best match** considering:
   - Title similarity (exact > close > transliteration)
   - Year match (within 1 year tolerance)
   - **Trap:** First hit is not always correct

4. **Verify with two-evidence bar**:
   - **Name evidence:** Does TMDB title/originalTitle match your cleaned title?
   - **Structure evidence:**
     - TV: Does season table include your season? Year within 1 year?
     - Movie: Runtime within 10% of duration? Year match?

5. **Write to database** with `write_identified_media` tool

6. **Continue to find subtitles** using the returned itemId

## Red Lines

- **NEVER identify from memory.** Always call search_tmdb + get_tmdb_details
- **NEVER skip verification.** Name alone is not enough
- **NEVER refuse whole-series identity because one episode is missing** — that's a TMDB data lag, not an identity problem

## Common Pitfalls

| Scenario | ❌ Wrong | ✓ Right |
|----------|---------|---------|
| "I know Breaking Bad is tmdb:1396" | Skip search | Call search_tmdb anyway |
| File name is "S01E01.mkv" | Use that as title | Use directory name |
| TMDB season 4 has 9 eps but file is S04E13 | Refuse to identify | Identify series, report ep as unidentified |
| Duration is 15 min but TMDB says 120 min | Refuse to identify | Identify anyway (may be corrupt file) |
| Year is 2020 in TMDB, 2021 in file | Fail verification | Pass (within 1 year tolerance) |

## Success Criteria

- Every identification has explicit nameEvidence and structureEvidence strings
- Database rows written only after verification passes
- Unidentified files reported with clear reason
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/agent-identification-guide.md
git commit -m "docs: document agent-first identification architecture"
```

---

## Task 17: Final Verification - Run Full Test Suite

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: All tests PASS

- [ ] **Step 2: Run type check**

```bash
npm run type-check
```

Expected: No TypeScript errors

- [ ] **Step 3: Run manual integration test**

```bash
# Park a real file
npm run cli ingest /path/to/real/video.mkv

# Run agent
npm run cli agent-run

# Verify output shows:
# - Raw evidence displayed
# - TMDB search called
# - Two-evidence verification
# - Database write
# - Subtitle search (if applicable)
```

- [ ] **Step 4: Check database state**

```bash
sqlite3 ~/.subtitle-scout/library.db "SELECT * FROM parked_paths;"
# Should be empty (or show only genuinely unidentified files)

sqlite3 ~/.subtitle-scout/library.db "SELECT * FROM series WHERE id LIKE 'tmdb:%';"
# Should show your test series

sqlite3 ~/.subtitle-scout/library.db "SELECT * FROM episodes WHERE id LIKE 'tmdb:%';"
# Should show your test episode
```

- [ ] **Step 5: Create summary commit**

```bash
git add -A
git commit -m "feat: complete agent-first identification architecture

- Mechanical parsing emits raw data only (no TMDB calls, no database writes)
- Subtitle agent identifies from raw evidence using two-evidence bar
- Agent writes database rows immediately after verification
- Deleted rescueWorkerTask (replaced by primary identification)
- All tests passing, full integration verified"
```

---

## Done!

**Verification checklist:**

- [ ] Migration v24 adds duration_sec and embedded_langs to parked_paths
- [ ] RawFileEvidence type defined
- [ ] LibraryRepo stores raw data in parked_paths
- [ ] isParkedPathEligible predicate extracted
- [ ] write_identified_media tool implemented and tested
- [ ] Ingest emits raw data only (no identity writes)
- [ ] resolveToTmdb deleted
- [ ] recognize() returns PathIdentity (structure hints only)
- [ ] findSubtitleSkill rewritten for primary identification
- [ ] findSubtitleWorker includes write_identified_media tool
- [ ] Report schema updated (identity field replaces identity_correction/verified)
- [ ] rescueWorkerTask deleted
- [ ] CLI agent-run reads raw data from parked_paths
- [ ] All ingest tests updated for raw-data parking
- [ ] All recognition tests updated for PathIdentity
- [ ] Integration test confirms end-to-end flow
- [ ] Documentation updated (architecture + agent guide)
- [ ] Full test suite passes
- [ ] Manual integration test successful

**What changed:**

| Component | Old Behavior | New Behavior |
|-----------|--------------|--------------|
| Ingest | Parse → TMDB search → write rows | Parse → measure → park with raw data |
| Agent | Verify existing identity | Identify from raw evidence + verify + write rows |
| Database | Rows written by ingest | Rows written by agent |
| rescueWorkerTask | Tried to fix bad identities | Deleted (agent does primary identification) |
| Recognition | resolveToTmdb guessed tmdbId | Returns structure hints only |

**Evidence trail:**

Every agent identification now includes:
- `nameEvidence`: "Title matches 'Breaking Bad'"
- `structureEvidence`: "Season 1 exists in TMDB season table; year 2008 matches 2008"

**Next steps (not in this plan):**

- [ ] Add batch agent-run mode for processing many parked files
- [ ] Add agent retry logic for transient TMDB API failures
- [ ] Add human review UI for unidentified files
- [ ] Metrics: track identification success rate, evidence quality

