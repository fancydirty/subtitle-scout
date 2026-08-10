# Plan B — 观测面补强：电影索引/详情 + 母语媒体可见性 + 波形第三轨

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**上游 Spec:** `docs/superpowers/specs/2026-08-02-spec-b-observability-design.md` (已裁决)

**Goal:** 补四个观测缺口——① Library 加电影类型视角（纯前端过滤）；② 电影详情端点 + 详情页（含 PosterCard 接链接）；③ 库索引 DTO 加语言字段 + 母语标记 + "显示母语条目"开关；④ 波形 peaks 端点（cloud 拒、lan/local 抽取）+ InspectPanel 第三轨接线。

**Architecture:** 后端两个新只读 GET (`/api/v2/library/movies/:id` 电影详情、`/api/v2/subtitle/waveform-peaks?itemId=` 波形)；`buildLibrary` DTO 加 `originLang` + `nativeAudio` 两键；前端电影详情页用 Spec C 栈（Tailwind/shadcn 自绘件）；Library 海报墙（SeriesGrid/PosterCard）由 Spec C Task 19 已随迁（行为冻结），本 spec 的增量（类型 chip、母语开关、PosterCard movie 接链接）落在随迁后组件上。

**Tech Stack:** React 19 + Vite 7 + TypeScript；Tailwind v4 + shadcn/ui copy-in（Spec C 已落底座）；后端 Node ≥22 ESM/TS + better-sqlite3 + vitest。

**前置依赖:** Spec C (Plan C) 已完成——电影详情页消费 C 的新栈，Library 海报墙已随迁。

---

## 0. 读这份计划之前必须知道的事

1. **上游 spec 是 `docs/superpowers/specs/2026-08-02-spec-b-observability-design.md`**。本计划每个任务回溯到 spec 某一节。**spec 说"不做"的事一律不做**——不新增写路径、不给 dormant 唤醒按钮、不改母语判定规则本身、不做 peaks 持久化缓存。
2. **Spec C (Plan C) 已落地**：Tailwind v4 + shadcn/ui + AI Elements 已就位；Library 海报墙 (SeriesGrid/PosterCard) 已随迁（Spec C Task 19）。电影详情页直接用 C 的新栈组件。
3. **`web/` 仓库里没有 linter**。缩进与换行是纯装饰，不影响验收。不要为"格式"改动既有行。
4. **后端 `tsconfig.json` 的 `include` 是 `["src"]`**——改导出类型后必须 `npm run check`。
5. **禁触文件：`src/v2/realignExecutor.ts`、`src/agent/skills/`**。本计划不需要碰它们。
6. **`docs/` 是 gitignored**——本计划文件不进 commit。commit message 不要用反引号。
7. **ES2020 禁止 `??` 与 `||`/`&&` 不加括号混用**（TS5076）。
8. **铁律②（DTO 键集合封闭）贯穿全 spec**：显式列键、禁 spread，零泄漏。

---

## 1. 任务分解概览

Plan B 共 **15 个任务**，分四组：

**A. 后端数据层（Tasks 1-5）**
1. buildLibrary DTO 增量（originLang + nativeAudio 两键）
2. 电影详情端点（buildLibraryMovieDetail + GET /api/v2/library/movies/:id）
3. 波形 peaks 端点（GET /api/v2/subtitle/waveform-peaks?itemId=）
4. router.ts 接线两个新端点
5. 后端全量测试 + type check

**B. 前端数据层 + 类型视角（Tasks 6-8）**
6. 前端 DTO 类型手抄 + client 包装（MovieDetailDTO + peaks 响应）
7. Library 类型视角 chip（KindFilter + SeriesGrid 消费）
8. 前端类型视角测试

**C. 电影详情页（Tasks 9-11）**
9. 路由改造（parseShellHash 识别 movies 段 + libraryItemHref movie 分支）
10. MovieDetailPage 组件（hero + 六段 + Spec C 栈）
11. 电影详情页测试

**D. 母语可见性 + 波形第三轨（Tasks 12-15）**
12. 母语标记 + 显示开关（PosterCard 标记 + localStorage 开关 + 空态）
13. PosterCard movie 分支接链接
14. InspectPanel 第三轨接线（peaks 请求 + 三轨渲染 + 失败回退）
15. 全量验证 + 部署 + 实机验收

---

## 2. Task 1: buildLibrary DTO 增量（originLang + nativeAudio）

**Files:**
- Modify: `src/dashboard/apiV2.ts` (buildLibrary 函数，约 :174)
- Modify: `src/dashboard/apiV2.test.ts`

**目标:** `LibraryItemDTO` 加两键 `originLang: string | null` + `nativeAudio: boolean`。

**Step 1: 读现状**

```bash
# 确认 LibraryItemDTO 当前键集合
grep -A 20 "interface LibraryItemDTO" src/dashboard/apiV2.ts
# 确认 buildLibrary 的 series SELECT
awk '/buildLibrary.*function/,/movies JOIN/' src/dashboard/apiV2.ts | head -50
```

**Step 2: 修改 LibraryItemDTO 接口**

在 `apiV2.ts` 顶部类型区（约 `:40-80`），找到 `LibraryItemDTO` 接口，追加两键：

```ts
interface LibraryItemDTO {
  // ... 既有九键不动 ...
  originLang: string | null
  nativeAudio: boolean
}
```

**Step 3: 修改 buildLibrary 实现**

在 `buildLibrary` 函数内（约 `:174`）：

① series SELECT 加一列（约 `:177`，genres 那行后面）：

```sql
SELECT 
  s.library_id, s.name, s.chinese_title, s.year, s.poster_path, 
  s.backdrop_path, s.overview, s.path, s.sub_status, s.genres,
  s.origin_lang  -- 新增
FROM series s
```

② movie SELECT 也加一列（约 `:230`）：

```sql
SELECT 
  m.id, m.name, m.chinese_title, m.year, m.poster_path, m.path, 
  m.sub_status, m.origin_lang  -- 新增
FROM movies m
```

③ 在函数开头（约 `:176`，series SELECT 之前）计算 originSkipLanguages：

```ts
export function buildLibrary(db: ScoutDb, settingsRepo: SettingsRepo): LibraryItemDTO[] {
  // 复用与 ingest 同一条求值式：settings 优先、空串回落 env、含 SKIP_CHINESE_ORIGIN 腿
  const { originSkipLanguages } = resolveTargetLanguages(
    process.env,
    settingsRepo.get('target_languages'),
  )
  
  // series SELECT ...
```

④ series 行构造加两键（约 `:185-195`，existing DTO 构造块内）：

```ts
const seriesItems: LibraryItemDTO[] = seriesRows.map((row) => {
  // ... 既有键不动 ...
  return {
    libraryId: row.library_id,
    // ... name/chineseTitle/year/posterPath/backdropPath/overview/path/subStatus/genres ...
    kind: 'series' as const,
    originLang: row.origin_lang,
    nativeAudio: row.origin_lang != null && originSkipLanguages.includes(langOf(row.origin_lang)),
  }
})
```

⑤ movie 行构造加两键（约 `:235-245`，movie DTO 构造块内）：

```ts
const movieItems: LibraryItemDTO[] = movieRows.map((row) => {
  // ... 既有键不动 ...
  return {
    libraryId: row.id,
    // ... name/chineseTitle/year/posterPath/path/subStatus ...
    kind: 'movie' as const,
    originLang: row.origin_lang,
    nativeAudio: row.origin_lang != null && originSkipLanguages.includes(langOf(row.origin_lang)),
  }
})
```

**Step 4: 加 import**

确认 `langOf` import（顶部应该已有，若无则加）：

```ts
import { langOf } from '../agent/languages.js'
```

确认 `resolveTargetLanguages` import（顶部应该已有，若无则加）：

```ts
import { resolveTargetLanguages } from '../cli/targetLanguages.js'
```

**Step 5: 写测试**

在 `apiV2.test.ts` 找到 `describe('buildLibrary', ...)` 块（约 `:400+`），追加四条用例：

```ts
it('adds originLang and nativeAudio keys to series items', () => {
  db.exec(`INSERT INTO series (library_id, name, origin_lang, path) VALUES ('s1', 'Shogun', 'ja', '/media/shogun')`)
  db.exec(`INSERT INTO series (library_id, name, origin_lang, path) VALUES ('s2', 'Breaking Bad', NULL, '/media/bb')`)
  const items = buildLibrary(db, settingsRepo)
  const shogun = items.find((x) => x.libraryId === 's1')
  const bb = items.find((x) => x.libraryId === 's2')
  expect(shogun).toMatchObject({ originLang: 'ja', nativeAudio: false })
  expect(bb).toMatchObject({ originLang: null, nativeAudio: false })
})

it('sets nativeAudio=true when originLang归一化命中 originSkipLanguages', () => {
  // settings target_languages 含 'zh' → originSkipLanguages 含 'zh'（langOf 归一化）
  settingsRepo.set('target_languages', 'en,zh')
  db.exec(`INSERT INTO series (library_id, name, origin_lang, path) VALUES ('s1', '庆余年', 'zh-CN', '/media/qyn')`)
  db.exec(`INSERT INTO series (library_id, name, origin_lang, path) VALUES ('s2', '琅琊榜', 'ZH', '/media/ljb')`)
  const items = buildLibrary(db, settingsRepo)
  expect(items.find((x) => x.libraryId === 's1')).toMatchObject({ originLang: 'zh-CN', nativeAudio: true })
  expect(items.find((x) => x.libraryId === 's2')).toMatchObject({ originLang: 'ZH', nativeAudio: true })
})

it('adds originLang and nativeAudio keys to movie items', () => {
  db.exec(`INSERT INTO movies (id, name, origin_lang, path) VALUES ('m1', 'Dune', 'en', '/media/dune.mkv')`)
  db.exec(`INSERT INTO movies (id, name, origin_lang, path) VALUES ('m2', 'Unknown', NULL, '/media/unknown.mkv')`)
  const items = buildLibrary(db, settingsRepo)
  const dune = items.find((x) => x.libraryId === 'm1')
  const unknown = items.find((x) => x.libraryId === 'm2')
  expect(dune).toMatchObject({ originLang: 'en', nativeAudio: false })
  expect(unknown).toMatchObject({ originLang: null, nativeAudio: false })
})

it('target_languages 变更后重建 DTO，nativeAudio 翻转（无重启）', () => {
  db.exec(`INSERT INTO series (library_id, name, origin_lang, path) VALUES ('s1', '庆余年', 'zh-CN', '/media/qyn')`)
  
  // 第一次：target_languages 不含 zh
  settingsRepo.set('target_languages', 'en,ja')
  const before = buildLibrary(db, settingsRepo)
  expect(before.find((x) => x.libraryId === 's1')).toMatchObject({ nativeAudio: false })
  
  // 第二次：target_languages 加入 zh
  settingsRepo.set('target_languages', 'en,zh')
  const after = buildLibrary(db, settingsRepo)
  expect(after.find((x) => x.libraryId === 's1')).toMatchObject({ nativeAudio: true })
})
```

**Step 6: 跑测试**

```bash
npm test src/dashboard/apiV2.test.ts
```

Expected: 全绿（既有 + 新增四条）。

**Step 7: Type check**

```bash
npm run check
```

Expected: 无错误（前端 `web/src/api/types.ts` 的 `LibraryItemDTO` 手抄件在 Task 6 同步）。

**Step 8: 提交**

```bash
git add src/dashboard/apiV2.ts src/dashboard/apiV2.test.ts
git commit -m "feat(api): buildLibrary DTO 增量——originLang + nativeAudio 两键（spec B §4.1）

originLang 直译 series.origin_lang / movies.origin_lang；
nativeAudio 后端派生（langOf 归一化 + originSkipLanguages 命中），
复用与 ingest rule 0 同一条 resolveTargetLanguages 求值式。

target_languages 改后下次轮询自然翻转，无重启路径。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 3. Task 2: 电影详情端点

**Files:**
- Modify: `src/dashboard/apiV2.ts` (buildLibraryMovieDetail + MovieDetailDTO)
- Modify: `src/dashboard/apiV2.test.ts`

**目标:** 新函数 `buildLibraryMovieDetail(db, id): MovieDetailDTO | null`，仿 `buildLibrarySeriesDetail` 形状。

**Step 1: 读 series 详情模板**

```bash
# 确认 series 详情形状
awk '/buildLibrarySeriesDetail/,/^}$/' src/dashboard/apiV2.ts | head -60
# 确认 itemFileCoverage 签名
grep -A 5 "function itemFileCoverage" src/dashboard/lib.ts
```

**Step 2: 定义 MovieDetailDTO**

在 `apiV2.ts` 类型区（`LibraryItemDTO` 之后），追加：

```ts
export interface MovieDetailDTO {
  id: string
  name: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  // 无 backdropPath——前端恒走模糊海报降级
  path: string
  subStatus: SubStatus
  statusReason: string | null
  recheckAfter: number | null
  originLang: string | null
  nativeAudio: boolean
  files: ItemFileCoverage[]
  subtitles: { language: string; path: string }[]
  recentJobs: { id: number; state: string; priority: number; updatedAt: number }[]
}
```

**Step 3: 实现 buildLibraryMovieDetail**

在 `buildLibrarySeriesDetail` 之后、文件末尾之前，追加：

```ts
export function buildLibraryMovieDetail(
  db: ScoutDb,
  settingsRepo: SettingsRepo,
  id: string,
): MovieDetailDTO | null {
  // 复用与 buildLibrary 同一条求值式
  const { originSkipLanguages } = resolveTargetLanguages(
    process.env,
    settingsRepo.get('target_languages'),
  )
  
  const row = db
    .prepare(
      `SELECT id, name, chinese_title, year, poster_path, path, sub_status, 
              status_reason, recheck_after, origin_lang
       FROM movies
       WHERE id = ?`,
    )
    .get(id) as {
    id: string
    name: string
    chinese_title: string | null
    year: number | null
    poster_path: string | null
    path: string
    sub_status: SubStatus
    status_reason: string | null
    recheck_after: number | null
    origin_lang: string | null
  } | undefined

  if (!row) return null

  // 副本覆盖（重复源）
  const files = itemFileCoverage(db, id)

  // 字幕清单
  const subtitleRows = db
    .prepare(`SELECT language, path FROM subtitles WHERE item_id = ? ORDER BY language`)
    .all(id) as { language: string; path: string }[]

  // 最近五个任务（movie 目标 = movie_id 命中 + series_id IS NULL）
  const jobRows = db
    .prepare(
      `SELECT id, state, priority, updated_at
       FROM jobs
       WHERE movie_id = ? AND series_id IS NULL
       ORDER BY id DESC
       LIMIT 5`,
    )
    .all(id) as { id: number; state: string; priority: number; updated_at: number }[]

  return {
    id: row.id,
    name: row.name,
    chineseTitle: row.chinese_title,
    year: row.year,
    posterPath: row.poster_path,
    path: row.path,
    subStatus: row.sub_status,
    statusReason: row.status_reason,
    recheckAfter: row.recheck_after,
    originLang: row.origin_lang,
    nativeAudio: row.origin_lang != null && originSkipLanguages.includes(langOf(row.origin_lang)),
    files,
    subtitles: subtitleRows.map((s) => ({ language: s.language, path: s.path })),
    recentJobs: jobRows.map((j) => ({
      id: j.id,
      state: j.state,
      priority: j.priority,
      updatedAt: j.updated_at,
    })),
  }
}
```

**Step 4: 加 import**

确认 `itemFileCoverage` import（顶部）：

```ts
import { itemFileCoverage, type ItemFileCoverage } from './lib.js'
```

**Step 5: 写测试**

在 `apiV2.test.ts` 找到 series 详情测试块之后，追加 `describe('buildLibraryMovieDetail', ...)`：

```ts
describe('buildLibraryMovieDetail', () => {
  it('returns null when movie not found', () => {
    const result = buildLibraryMovieDetail(db, settingsRepo, 'nonexistent')
    expect(result).toBeNull()
  })

  it('returns DTO with all keys when movie exists', () => {
    db.exec(`
      INSERT INTO movies (id, name, chinese_title, year, poster_path, path, sub_status, status_reason, recheck_after, origin_lang)
      VALUES ('m1', 'Dune', '沙丘', 2021, '/posters/dune.jpg', '/media/dune.mkv', 'covered', NULL, NULL, 'en')
    `)
    db.exec(`INSERT INTO files (path, item_id, source) VALUES ('/media/dune.mkv', 'm1', 'local')`)
    db.exec(`INSERT INTO subtitles (item_id, language, path) VALUES ('m1', 'en', '/subs/dune.en.srt')`)
    db.exec(`
      INSERT INTO jobs (id, kind, movie_id, series_id, state, priority, updated_at, payload)
      VALUES (101, 'find_subtitle', 'm1', NULL, 'completed', 5, 1609459200000, '{}')
    `)
    db.exec(`
      INSERT INTO jobs (id, kind, movie_id, series_id, state, priority, updated_at, payload)
      VALUES (102, 'verify_subtitles', 'm1', NULL, 'completed', 3, 1609545600000, '{}')
    `)

    const result = buildLibraryMovieDetail(db, settingsRepo, 'm1')

    expect(result).toEqual({
      id: 'm1',
      name: 'Dune',
      chineseTitle: '沙丘',
      year: 2021,
      posterPath: '/posters/dune.jpg',
      path: '/media/dune.mkv',
      subStatus: 'covered',
      statusReason: null,
      recheckAfter: null,
      originLang: 'en',
      nativeAudio: false,
      files: [{ path: '/media/dune.mkv', sources: ['local'], status: 'ok' }],
      subtitles: [{ language: 'en', path: '/subs/dune.en.srt' }],
      recentJobs: [
        { id: 102, state: 'completed', priority: 3, updatedAt: 1609545600000 },
        { id: 101, state: 'completed', priority: 5, updatedAt: 1609459200000 },
      ],
    })
  })

  it('键集合封闭：无 backdrop/overview/genres 泄漏', () => {
    db.exec(`INSERT INTO movies (id, name, path, origin_lang) VALUES ('m1', 'Test', '/test.mkv', 'ja')`)
    const result = buildLibraryMovieDetail(db, settingsRepo, 'm1')!
    const keys = Object.keys(result).sort()
    expect(keys).toEqual([
      'chineseTitle',
      'files',
      'id',
      'name',
      'nativeAudio',
      'originLang',
      'path',
      'posterPath',
      'recentJobs',
      'recheckAfter',
      'statusReason',
      'subStatus',
      'subtitles',
      'year',
    ])
    expect(result).not.toHaveProperty('backdropPath')
    expect(result).not.toHaveProperty('overview')
    expect(result).not.toHaveProperty('genres')
  })

  it('nativeAudio=true when originLang 命中 originSkipLanguages', () => {
    settingsRepo.set('target_languages', 'en,zh')
    db.exec(`INSERT INTO movies (id, name, path, origin_lang) VALUES ('m1', '战狼', '/zl.mkv', 'zh-CN')`)
    const result = buildLibraryMovieDetail(db, settingsRepo, 'm1')
    expect(result).toMatchObject({ originLang: 'zh-CN', nativeAudio: true })
  })

  it('recentJobs 只取 movie_id 命中 + series_id IS NULL 的行', () => {
    db.exec(`INSERT INTO movies (id, name, path) VALUES ('m1', 'Test', '/test.mkv')`)
    db.exec(`INSERT INTO series (library_id, name, path) VALUES ('s1', 'Series', '/series')`)
    // movie 任务
    db.exec(`INSERT INTO jobs (id, kind, movie_id, series_id, state, priority, updated_at, payload) VALUES (1, 'find_subtitle', 'm1', NULL, 'completed', 5, 1000, '{}')`)
    // series 任务（不该出现）
    db.exec(`INSERT INTO jobs (id, kind, movie_id, series_id, state, priority, updated_at, payload) VALUES (2, 'find_subtitle', NULL, 's1', 'completed', 5, 2000, '{}')`)
    // movie_id 命中但 series_id 非 NULL（不该出现）
    db.exec(`INSERT INTO jobs (id, kind, movie_id, series_id, state, priority, updated_at, payload) VALUES (3, 'other', 'm1', 's1', 'completed', 5, 3000, '{}')`)

    const result = buildLibraryMovieDetail(db, settingsRepo, 'm1')
    expect(result?.recentJobs).toHaveLength(1)
    expect(result?.recentJobs[0].id).toBe(1)
  })
})
```

**Step 6: 跑测试**

```bash
npm test src/dashboard/apiV2.test.ts
```

Expected: 全绿。

**Step 7: 提交**

```bash
git add src/dashboard/apiV2.ts src/dashboard/apiV2.test.ts
git commit -m "feat(api): 电影详情端点 buildLibraryMovieDetail（spec B §4.2）

MovieDetailDTO 14 键封闭（无 backdrop/overview/genres）；
未找到 → null；
nativeAudio 后端派生（同 Task 1）；
recentJobs 取 movie_id 命中 + series_id IS NULL 的五元组。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

(continuing with remaining tasks...)


## 4. Task 3: 波形 peaks 端点

**Files:**
- Modify: `src/dashboard/subtitleCompareApi.ts` (新函数 extractWaveformPeaks)
- Modify: `src/dashboard/subtitleCompareApi.test.ts`
- Modify: `src/dashboard/server.ts` (新路由 GET /api/v2/subtitle/waveform-peaks)

**目标:** 新端点返回 `{ itemId, peaks: number[], sampleRate: 100, durationMs }`，cloud 拒绝，lan/local 抽取。

**Step 1: 读现状**

```bash
# 确认 compare 端点形状
awk '/router\.get.*\/api\/v2\/subtitle\/compare/,/^  \}$/' src/dashboard/server.ts | head -80
# 确认 classifyPath 签名
grep -A 3 "export function classifyPath" src/core/mountKind.ts
# 确认 resolveDurationMs 签名
grep -A 5 "function resolveDurationMs" src/dashboard/subtitleCompareApi.ts
```

**Step 2: 在 subtitleCompareApi.ts 实现 extractWaveformPeaks**

在文件末尾（注释 `:338-358` peaks 设计之后）追加：

```ts
export interface WaveformPeaksResult {
  itemId: string
  peaks: number[]
  sampleRate: number
  durationMs: number
}

export interface ExtractPeaksDeps {
  spawn: (cmd: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: Buffer; code: number }>
  classifyPath: (path: string) => 'cloud' | 'lan' | 'local'
  resolveDurationMs: (itemPath: string) => Promise<number>
}

export async function extractWaveformPeaks(
  item: { id: string; path: string },
  deps: ExtractPeaksDeps,
): Promise<WaveformPeaksResult> {
  const mountKind = deps.classifyPath(item.path)
  if (mountKind === 'cloud') {
    throw new Error('waveform is not available for cloud-mounted media')
  }

  // ffmpeg 抽音频流：-map 0:a:0 第一条音轨，-ac 1 混单声道，-ar 100 降采样到 100Hz，
  // -f s16le 输出小端 16 位整数 PCM
  const { stdout, code } = await deps.spawn(
    'ffmpeg',
    ['-i', item.path, '-map', '0:a:0', '-ac', '1', '-ar', '100', '-f', 's16le', '-'],
    { timeout: 30000 },
  )

  if (code !== 0) {
    throw new Error(`ffmpeg exited with code ${code}`)
  }

  // s16le Buffer → 归一化峰值数组
  const samples = new Int16Array(
    stdout.buffer,
    stdout.byteOffset,
    stdout.byteLength / 2,
  )
  const peaks: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i])
    const normalized = abs / 32767
    peaks.push(Math.round(normalized * 1000) / 1000) // 保留 3 位小数
  }

  const durationMs = await deps.resolveDurationMs(item.path)

  return {
    itemId: item.id,
    peaks,
    sampleRate: 100,
    durationMs,
  }
}
```

**Step 3: 写测试**

在 `subtitleCompareApi.test.ts` 末尾追加：

```ts
describe('extractWaveformPeaks', () => {
  it('cloud 路径拒绝且不 spawn', async () => {
    const spawn = vi.fn()
    const deps: ExtractPeaksDeps = {
      spawn,
      classifyPath: () => 'cloud',
      resolveDurationMs: async () => 120000,
    }
    await expect(
      extractWaveformPeaks({ id: 'item1', path: '/cloud/media.mkv' }, deps),
    ).rejects.toThrow('waveform is not available for cloud-mounted media')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('lan 路径正常抽取，归一化到 0..1 并保留 3 位小数', async () => {
    // 构造假 s16le Buffer：四个样本 [16383, -32767, 0, 32767]
    const buffer = Buffer.alloc(8)
    buffer.writeInt16LE(16383, 0)
    buffer.writeInt16LE(-32767, 2)
    buffer.writeInt16LE(0, 4)
    buffer.writeInt16LE(32767, 6)

    const spawn = vi.fn().mockResolvedValue({ stdout: buffer, code: 0 })
    const deps: ExtractPeaksDeps = {
      spawn,
      classifyPath: () => 'lan',
      resolveDurationMs: async () => 40, // 4 样本 @ 100Hz = 40ms
    }

    const result = await extractWaveformPeaks({ id: 'item1', path: '/lan/media.mkv' }, deps)

    expect(spawn).toHaveBeenCalledWith(
      'ffmpeg',
      ['-i', '/lan/media.mkv', '-map', '0:a:0', '-ac', '1', '-ar', '100', '-f', 's16le', '-'],
      { timeout: 30000 },
    )
    expect(result).toEqual({
      itemId: 'item1',
      peaks: [0.5, 1.0, 0.0, 1.0], // 16383/32767≈0.5, 32767/32767=1.0, 0/32767=0, 32767/32767=1.0
      sampleRate: 100,
      durationMs: 40,
    })
  })

  it('全零音轨合法返回', async () => {
    const buffer = Buffer.alloc(8)
    buffer.writeInt16LE(0, 0)
    buffer.writeInt16LE(0, 2)
    buffer.writeInt16LE(0, 4)
    buffer.writeInt16LE(0, 6)

    const spawn = vi.fn().mockResolvedValue({ stdout: buffer, code: 0 })
    const deps: ExtractPeaksDeps = {
      spawn,
      classifyPath: () => 'local',
      resolveDurationMs: async () => 40,
    }

    const result = await extractWaveformPeaks({ id: 'item1', path: '/local/silent.mkv' }, deps)
    expect(result.peaks).toEqual([0.0, 0.0, 0.0, 0.0])
  })

  it('ffmpeg 非零退出抛错', async () => {
    const spawn = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), code: 1 })
    const deps: ExtractPeaksDeps = {
      spawn,
      classifyPath: () => 'lan',
      resolveDurationMs: async () => 0,
    }

    await expect(
      extractWaveformPeaks({ id: 'item1', path: '/lan/corrupt.mkv' }, deps),
    ).rejects.toThrow('ffmpeg exited with code 1')
  })
})
```

**Step 4: 在 server.ts 添加路由**

在 `server.ts` 找到 subtitle 路由族（compare 路由附近，约 `:679`），追加：

```ts
router.get('/api/v2/subtitle/waveform-peaks', async (req, res) => {
  const itemId = typeof req.query.itemId === 'string' ? req.query.itemId : null
  if (!itemId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'itemId query parameter is required' }))
    return
  }

  // 查找 item
  const episodeRow = scoutDb
    .prepare('SELECT id, path FROM episodes WHERE id = ?')
    .get(itemId) as { id: string; path: string } | undefined
  const movieRow = scoutDb
    .prepare('SELECT id, path FROM movies WHERE id = ?')
    .get(itemId) as { id: string; path: string } | undefined
  const item = episodeRow || movieRow

  if (!item) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'item not found' }))
    return
  }

  try {
    const result = await extractWaveformPeaks(item, {
      spawn: async (cmd, args, opts) => {
        // 复用 extractEmbeddedSub 的 execFileAsync，加 encoding: 'buffer'
        const { stdout } = await execFileAsync(cmd, args, {
          timeout: opts.timeout,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          encoding: 'buffer',
          killSignal: 'SIGKILL',
        })
        return { stdout: stdout as Buffer, code: 0 }
      },
      classifyPath,
      resolveDurationMs: async (path) => {
        const meta = await getMetadata(scoutDb, path)
        return meta.durationMs
      },
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (err: any) {
    if (err.message?.includes('waveform is not available')) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message || 'ffmpeg failed' }))
    }
  }
})
```

**Step 5: 加 import**

在 `server.ts` 顶部确认/追加：

```ts
import { extractWaveformPeaks, type ExtractPeaksDeps } from './subtitleCompareApi.js'
import { execFileAsync } from '../files/extractEmbeddedSub.js'
```

**Step 6: 写集成测试**

在 `server.test.ts` 找到鉴权测试块（约 `:200+`），追加：

```ts
it('GET /api/v2/subtitle/waveform-peaks without token → 401', async () => {
  const res = await request(server).get('/api/v2/subtitle/waveform-peaks?itemId=item1')
  expect(res.status).toBe(401)
})
```

**Step 7: 跑测试**

```bash
npm test src/dashboard/subtitleCompareApi.test.ts
npm test src/dashboard/server.test.ts
```

Expected: 全绿。

**Step 8: 提交**

```bash
git add src/dashboard/subtitleCompareApi.ts src/dashboard/subtitleCompareApi.test.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat(api): 波形 peaks 端点 GET /api/v2/subtitle/waveform-peaks（spec B §4.3）

extractWaveformPeaks：cloud 拒绝（403）、lan/local 抽取；
ffmpeg -ar 100 降采样、s16le → 归一化 0..1 保留 3 位小数；
超时 30s SIGKILL；单飞护栏（未实现，首版）；
失败 → 502 人话 error。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 5. Task 4: router.ts 接线两个新端点

**Files:**
- Modify: `src/dashboard/router.ts`
- Modify: `src/dashboard/router.test.ts`

**目标:** `handleApiRoute` 注册 `/api/v2/library/movies/:id` 和 `/api/v2/subtitle/waveform-peaks`（已在 server.ts 实现，本 task 只做纯函数路由层测试）。

**注意:** server.ts 的路由已在 Task 3 实现，本 task 验收点是**纯函数路由层的单元测试**（若 router.ts 有独立路由注册逻辑才需要改，若 server.ts 直接挂路由则本 task 只补测试）。

**Step 1: 读现状**

```bash
# 确认 router.ts 是否有独立路由表
grep -A 10 "handleApiRoute" src/dashboard/router.ts | head -20
# 确认 server.ts 是否直接挂路由
grep "router\.get.*library.*movies" src/dashboard/server.ts
```

**Step 2: 若 router.ts 有路由表，追加两条**

（根据实际代码结构决定；若 server.ts 已直接挂，则跳到 Step 3）

假设 router.ts 有类似的路由表结构：

```ts
const routes = {
  'GET /api/v2/library': handleLibraryIndex,
  'GET /api/v2/library/series/:id': handleSeriesDetail,
  'GET /api/v2/library/movies/:id': handleMovieDetail, // 新增
  'GET /api/v2/subtitle/waveform-peaks': handleWaveformPeaks, // 新增
  // ...
}
```

**Step 3: 写测试**

在 `router.test.ts` 追加：

```ts
it('GET /api/v2/library/movies/:id routes to buildLibraryMovieDetail', () => {
  // 假设 router 有注册逻辑，测试路由命中
  const deps = { /* fake deps */ }
  const result = handleApiRoute('GET', '/api/v2/library/movies/m1', deps)
  expect(result).toBeDefined()
  // 根据实际路由机制断言
})

it('GET /api/v2/subtitle/waveform-peaks routes to extractWaveformPeaks', () => {
  const deps = { /* fake deps */ }
  const result = handleApiRoute('GET', '/api/v2/subtitle/waveform-peaks?itemId=item1', deps)
  expect(result).toBeDefined()
})
```

**注意:** 若 server.ts 已直接挂路由（无独立 router.ts 路由表），本 task 实际上是"确认 server.ts 路由已实现 + 鉴权测试已在 Task 2/3 补全"，则本 task 可合并到前面 tasks 或标记为"验证既有实现"。

**Step 4: 跑测试**

```bash
npm test src/dashboard/router.test.ts
```

Expected: 全绿。

**Step 5: 提交**

```bash
git add src/dashboard/router.ts src/dashboard/router.test.ts
git commit -m "chore(api): router 确认两个新端点路由（spec B Task 4）

/api/v2/library/movies/:id → buildLibraryMovieDetail
/api/v2/subtitle/waveform-peaks → extractWaveformPeaks

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 6. Task 5: 后端全量测试 + type check

**Files:** N/A (验证步)

**目标:** 后端全量测试 + type check 全绿，确认 Tasks 1-4 集成无误。

**Step 1: 全量后端测试**

```bash
npm test
```

Expected: 所有后端测试全绿（2603+ passed）。

**Step 2: Type check**

```bash
npm run check
```

Expected: 无错误。

**Step 3: 若有失败，修复后重跑**

（若有失败，回到对应 task 修复，然后重新验证）

**Step 4: 记录**

无需 commit（验证步）。在 task list 标记 Task 5 completed。

---

## 7. Task 6: 前端 DTO 类型手抄 + client 包装

**Files:**
- Modify: `web/src/api/types.ts`
- Modify: `web/src/api/client.ts`

**目标:** 前端手抄 `MovieDetailDTO` + peaks 响应类型，client 加两个 GET 包装。

**Step 1: 修改 types.ts**

在 `LibraryItemDTO` 之后追加：

```ts
// Task 1: LibraryItemDTO 加两键（与后端同步）
export interface LibraryItemDTO {
  libraryId: string
  name: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  backdropPath: string | null
  overview: string | null
  path: string
  subStatus: SubStatus
  genres: string
  kind: 'series' | 'movie'
  originLang: string | null      // 新增
  nativeAudio: boolean           // 新增
}

// Task 2: 电影详情 DTO
export interface MovieDetailDTO {
  id: string
  name: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  path: string
  subStatus: SubStatus
  statusReason: string | null
  recheckAfter: number | null
  originLang: string | null
  nativeAudio: boolean
  files: ItemFileCoverage[]
  subtitles: { language: string; path: string }[]
  recentJobs: { id: number; state: string; priority: number; updatedAt: number }[]
}

// Task 3: 波形 peaks 响应
export interface WaveformPeaksResponse {
  itemId: string
  peaks: number[]
  sampleRate: number
  durationMs: number
}
```

**Step 2: 修改 client.ts**

在 `api` 对象末尾追加：

```ts
  // Plan B: 电影详情
  movieDetail: (id: string, signal?: AbortSignal) =>
    get<MovieDetailDTO>(`/api/v2/library/movies/${id}`, signal),
  
  // Plan B: 波形 peaks
  waveformPeaks: (itemId: string, signal?: AbortSignal) =>
    get<WaveformPeaksResponse>(`/api/v2/subtitle/waveform-peaks?itemId=${itemId}`, signal),
```

**Step 3: Type check**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误（前后端类型同步）。

**Step 4: 提交**

```bash
git add web/src/api/types.ts web/src/api/client.ts
git commit -m "feat(web): 前端 DTO 类型手抄 + client 包装（spec B Task 6）

LibraryItemDTO 加 originLang + nativeAudio；
MovieDetailDTO 手抄（14 键）；
WaveformPeaksResponse 手抄；
client.movieDetail / client.waveformPeaks 包装。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 8. Task 7: Library 类型视角 chip

**Files:**
- Modify: `web/src/library/filter.ts`
- Modify: `web/src/library/SeriesGrid.tsx`

**目标:** 纯前端过滤，`KindFilter` 类型 + 三个 chip（All / Series / Movies），与覆盖过滤相乘。

**Step 1: 读现状**

```bash
# 确认 filter.ts 现状
head -50 web/src/library/filter.ts
# 确认 SeriesGrid 的覆盖 chip 实现
grep -A 10 "SegmentedControl\|覆盖" web/src/library/SeriesGrid.tsx | head -20
```

**Step 2: 在 filter.ts 加 KindFilter**

在 `LIBRARY_FILTERS` 之后追加：

```ts
export type KindFilter = 'all' | 'series' | 'movies'

export const KIND_FILTERS: KindFilter[] = ['all', 'series', 'movies']

export function kindFilterLabel(f: KindFilter): string {
  switch (f) {
    case 'all':
      return 'All'
    case 'series':
      return 'Series'
    case 'movies':
      return 'Movies'
  }
}

export function applyKindFilter(items: LibraryItemDTO[], filter: KindFilter): LibraryItemDTO[] {
  if (filter === 'all') return items
  return items.filter((item) => {
    if (filter === 'series') return item.kind === 'series'
    if (filter === 'movies') return item.kind === 'movie'
    return true
  })
}
```

**Step 3: 在 SeriesGrid 加类型 chip**

在 `SeriesGrid.tsx` 找到覆盖 chip 的 `useState`（约 `:50`），追加类型 chip state：

```ts
const [coverageFilter, setCoverageFilter] = useState<LibraryFilter>('all')
const [kindFilter, setKindFilter] = useState<KindFilter>('all') // 新增
```

在覆盖 SegmentedControl 之后（工具行内），追加类型 chip：

```tsx
<Segmented
  label="Type filter"
  items={KIND_FILTERS.map((f) => ({ label: kindFilterLabel(f), value: f }))}
  value={kindFilter}
  onChange={(v) => setKindFilter(v as KindFilter)}
/>
```

在过滤逻辑处（约 `:80`，`applyLibraryFilter` 调用后），追加类型过滤：

```ts
const coverageFiltered = applyLibraryFilter(data, coverageFilter)
const kindFiltered = applyKindFilter(coverageFiltered, kindFilter) // 新增
const finalItems = kindFiltered // 或者继续接其他过滤
```

**Step 4: 加 import**

在 `SeriesGrid.tsx` 顶部确认/追加：

```ts
import {
  applyLibraryFilter,
  applyKindFilter, // 新增
  kindFilterLabel, // 新增
  KIND_FILTERS, // 新增
  type LibraryFilter,
  type KindFilter, // 新增
} from './filter.js'
```

**Step 5: Type check**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

**Step 6: 提交**

```bash
git add web/src/library/filter.ts web/src/library/SeriesGrid.tsx
git commit -m "feat(web): Library 类型视角 chip（spec B §5.1 Task 7）

KindFilter 纯前端过滤（all/series/movies）；
与覆盖过滤相乘（先类型后覆盖）；
不持久化（同覆盖 chip 惯例 useState）。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 9. Task 8: 前端类型视角测试

**Files:**
- Create: `web/src/library/filter.test.ts`
- Modify: `web/src/library/SeriesGrid.test.tsx`（若既有）

**目标:** `applyKindFilter` 纯函数测试 + SeriesGrid chip 渲染测试。

**Step 1: 写 filter.test.ts**

新建 `web/src/library/filter.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { applyKindFilter, type KindFilter } from './filter.js'
import type { LibraryItemDTO } from '../api/types.js'

describe('applyKindFilter', () => {
  const items: LibraryItemDTO[] = [
    {
      libraryId: 's1',
      name: 'Breaking Bad',
      kind: 'series',
      // ... 其他必填键用 null/'' 填充 ...
    } as LibraryItemDTO,
    {
      libraryId: 'm1',
      name: 'Dune',
      kind: 'movie',
      // ...
    } as LibraryItemDTO,
    {
      libraryId: 's2',
      name: 'Shogun',
      kind: 'series',
      // ...
    } as LibraryItemDTO,
  ]

  it('all 返回全部', () => {
    const result = applyKindFilter(items, 'all')
    expect(result).toHaveLength(3)
  })

  it('series 只返回 series 行', () => {
    const result = applyKindFilter(items, 'series')
    expect(result).toHaveLength(2)
    expect(result.every((x) => x.kind === 'series')).toBe(true)
  })

  it('movies 只返回 movie 行', () => {
    const result = applyKindFilter(items, 'movies')
    expect(result).toHaveLength(1)
    expect(result[0].libraryId).toBe('m1')
  })
})
```

**Step 2: 写 SeriesGrid 集成测试**

在 `SeriesGrid.test.tsx`（若存在）追加 chip 渲染测试：

```tsx
it('renders kind filter chip with three options', () => {
  render(<SeriesGrid />)
  expect(screen.getByRole('radiogroup', { name: /type filter/i })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'All' })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Series' })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Movies' })).toBeInTheDocument()
})
```

**Step 3: 跑测试**

```bash
cd web && npm test src/library/
```

Expected: 全绿。

**Step 4: 提交**

```bash
git add web/src/library/filter.test.ts web/src/library/SeriesGrid.test.tsx
git commit -m "test(web): Library 类型视角测试（spec B Task 8）

applyKindFilter 纯函数三态；
SeriesGrid chip 渲染锁。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

（Tasks 9-15 待续，篇幅原因分段写入...）


## 10. Task 9: 路由改造（parseShellHash 识别 movies 段）

**Files:**
- Modify: `web/src/route.ts`

**目标:** `parseShellHash` 识别 `/library/movies/:id`，`libraryItemHref` 加 movie 分支。

**Step 1: 读现状**

```bash
# 确认 parseShellHash 现状
grep -A 30 "function parseShellHash" web/src/route.ts
# 确认 libraryItemHref 现状
grep -A 10 "function libraryItemHref" web/src/route.ts
```

**Step 2: 修改 parseShellHash**

在 `parseShellHash` 函数内，找到 `/library/<seg>` 的解析分支（约 `:40-50`），改为：

```ts
if (parts[1] === 'library') {
  if (parts[2] === 'movies' && parts[3]) {
    // /library/movies/:id → movie detail
    return { page: 'movie-detail', movieId: parts[3] }
  }
  if (parts[2]) {
    // /library/:seriesId → series detail
    return { page: 'series-detail', libraryId: parts[2] }
  }
  // /library → library index
  return { page: 'library' }
}
```

**Step 3: 修改 libraryItemHref**

在 `libraryItemHref` 函数内，加 movie 分支：

```ts
export function libraryItemHref(item: { kind: 'series' | 'movie'; libraryId: string }): string {
  if (item.kind === 'movie') {
    return `#/library/movies/${item.libraryId}`
  }
  return `#/library/${item.libraryId}`
}
```

**Step 4: Type check**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

**Step 5: 提交**

```bash
git add web/src/route.ts
git commit -m "feat(web): 路由改造——parseShellHash 识别 movies 段（spec B §5.3 Task 9）

/library/movies/:id → movie-detail page；
/library/:seriesId → series-detail（原样）；
libraryItemHref 加 movie 分支。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 11. Task 10: MovieDetailPage 组件

**Files:**
- Create: `web/src/library/MovieDetailPage.tsx`
- Modify: `web/src/App.tsx`（路由接线）

**目标:** 电影详情页（hero + 六段），用 Spec C 栈自绘。

**Step 1: 建 MovieDetailPage.tsx**

新建 `web/src/library/MovieDetailPage.tsx`：

```tsx
// MovieDetailPage.tsx：电影详情页——hero（模糊海报降级）+ 六段（状态/副本/字幕/校验/对照/活动）。
// 用 Spec C 栈（Tailwind/shadcn 自绘件），仿 SeriesPage 布局粒度，无 backdrop（恒降级）、
// 无 overview、无 genres。
import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { Button } from '../components/ui/button.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { EmptyState } from '../components/ui/empty-state.js'
import type { MovieDetailDTO } from '../api/types.js'

export function MovieDetailPage({ movieId }: { movieId: string }) {
  const [data, setData] = useState<MovieDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { t } = useT()

  useEffect(() => {
    setLoading(true)
    api
      .movieDetail(movieId)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => {
        setError(String(e))
      })
      .finally(() => {
        setLoading(false)
      })
  }, [movieId])

  if (loading) return <div className="p-4">Loading...</div>
  if (error) return <div className="p-4 text-fn-red">{error}</div>
  if (!data) return <EmptyState title="Movie not found" description="This movie is not in the library." />

  // subStatus 人话句映射（复用活动页措辞族）
  let statusLine = ''
  if (data.subStatus === 'covered') statusLine = 'Subtitles installed'
  else if (data.subStatus === 'missing') statusLine = 'Missing subtitles'
  else if (data.subStatus === 'unavailable' && data.recheckAfter) {
    const mins = Math.ceil((data.recheckAfter - Date.now()) / 60000)
    statusLine = `Will retry in ${mins} minutes`
  } else if (data.subStatus === 'ignored' && data.nativeAudio) {
    statusLine = 'Native audio — no subtitles needed'
  } else if (data.subStatus === 'ignored') {
    statusLine = 'Marked as not needing subtitles during scan.'
  } else {
    statusLine = data.subStatus
  }

  return (
    <div className="movie-detail-page">
      {/* Hero：模糊海报出血背景 + 160px 海报 + 标题 meta */}
      <div className="relative overflow-hidden">
        {data.posterPath && (
          <div
            className="absolute inset-0 bg-cover bg-center opacity-20 blur-xl scale-110"
            style={{ backgroundImage: `url(${data.posterPath})` }}
            aria-hidden="true"
          />
        )}
        <div className="relative z-10 flex gap-4 p-4">
          {data.posterPath && (
            <img
              src={data.posterPath}
              alt={data.name}
              className="h-[240px] w-[160px] shrink-0 rounded-card object-cover"
            />
          )}
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">{data.name}</h1>
            {data.chineseTitle && <p className="text-muted-foreground">{data.chineseTitle}</p>}
            {data.year && <p className="text-sm text-weak">{data.year}</p>}
            <p className="font-mono text-sm text-muted-foreground">{statusLine}</p>
            {data.nativeAudio && <p className="text-sm text-weak">Native audio — no subtitles needed</p>}
          </div>
        </div>
      </div>

      {/* 副本质检段（多副本才渲染）*/}
      {data.files.length > 1 && (
        <div className="border-t border-border p-4">
          <h2 className="mb-2 text-sm font-semibold">Files</h2>
          {data.files.map((f) => (
            <div key={f.path} className="flex items-center gap-2 font-mono text-sm">
              <StatusDot variant={f.status === 'ok' ? 'success' : 'neutral'} />
              <span className="text-weak">{f.path}</span>
            </div>
          ))}
        </div>
      )}

      {/* 字幕清单段 */}
      {data.subtitles.length > 0 && (
        <div className="border-t border-border p-4">
          <h2 className="mb-2 text-sm font-semibold">Subtitles</h2>
          {data.subtitles.map((s) => (
            <div key={s.path} className="flex items-center gap-2 font-mono text-sm">
              <span className="rounded bg-secondary px-2 py-0.5 text-xs">{s.language}</span>
              <span className="text-weak">{s.path}</span>
            </div>
          ))}
        </div>
      )}

      {/* 校验段（shifted/aligned/unverifiable）*/}
      {/* TODO: 接 verify 结论 + Fix/Undo 按钮（Task 11）*/}

      {/* 对照图入口 */}
      <div className="border-t border-border p-4">
        <Button variant="secondary">Inspect</Button>
      </div>

      {/* 最近活动段 */}
      {data.recentJobs.length > 0 && (
        <div className="border-t border-border p-4">
          <h2 className="mb-2 text-sm font-semibold">Recent activity</h2>
          {data.recentJobs.map((j) => (
            <div key={j.id} className="flex items-center gap-2 font-mono text-sm">
              <span className="text-weak">{new Date(j.updatedAt).toLocaleString()}</span>
              <span>{j.state}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

**Step 2: 在 App.tsx 接线路由**

在 `App.tsx` 找到路由 switch（约 `:80-120`），追加：

```tsx
if (route.page === 'movie-detail') {
  return <MovieDetailPage movieId={route.movieId} />
}
```

**Step 3: 加 import**

在 `App.tsx` 顶部追加：

```tsx
import { MovieDetailPage } from './library/MovieDetailPage.js'
```

**Step 4: Type check**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

**Step 5: 提交**

```bash
git add web/src/library/MovieDetailPage.tsx web/src/App.tsx
git commit -m "feat(web): MovieDetailPage 组件（spec B §5.3 Task 10）

电影详情页：hero（模糊海报降级）+ 六段（状态/副本/字幕/校验/对照/活动）；
用 Spec C 栈（Tailwind/shadcn 自绘件）；
subStatus 七值人话句映射（复用活动页措辞族）；
校验段 + 对照图入口待 Task 11 接线。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 12. Task 11: 电影详情页测试

**Files:**
- Create: `web/src/library/MovieDetailPage.test.tsx`

**目标:** 七 subStatus 映射快照、ignored+rule1b 不透传中文、多副本段条件渲染。

**Step 1: 写测试**

新建 `web/src/library/MovieDetailPage.test.tsx`：

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MovieDetailPage } from './MovieDetailPage.js'
import * as client from '../api/client.js'
import type { MovieDetailDTO } from '../api/types.js'

vi.mock('../api/client.js')

describe('MovieDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const baseMovie: MovieDetailDTO = {
    id: 'm1',
    name: 'Dune',
    chineseTitle: '沙丘',
    year: 2021,
    posterPath: '/dune.jpg',
    path: '/media/dune.mkv',
    subStatus: 'covered',
    statusReason: null,
    recheckAfter: null,
    originLang: 'en',
    nativeAudio: false,
    files: [],
    subtitles: [],
    recentJobs: [],
  }

  it('covered → "Subtitles installed"', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue(baseMovie)
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => expect(screen.getByText('Subtitles installed')).toBeInTheDocument())
  })

  it('missing → "Missing subtitles"', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue({ ...baseMovie, subStatus: 'missing' })
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => expect(screen.getByText('Missing subtitles')).toBeInTheDocument())
  })

  it('unavailable + recheckAfter → "Will retry in N minutes"', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue({
      ...baseMovie,
      subStatus: 'unavailable',
      recheckAfter: Date.now() + 5 * 60 * 1000,
    })
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => expect(screen.getByText(/Will retry in \d+ minutes/)).toBeInTheDocument())
  })

  it('ignored + nativeAudio → "Native audio — no subtitles needed"', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue({
      ...baseMovie,
      subStatus: 'ignored',
      nativeAudio: true,
    })
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => expect(screen.getByText('Native audio — no subtitles needed')).toBeInTheDocument())
  })

  it('ignored + 非母语 → "Marked as not needing subtitles during scan."（不透传中文 reason）', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue({
      ...baseMovie,
      subStatus: 'ignored',
      statusReason: '标题含中文，判定为母语媒体', // rule 1b 中文串
      nativeAudio: false,
    })
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => {
      expect(screen.getByText('Marked as not needing subtitles during scan.')).toBeInTheDocument()
      expect(screen.queryByText(/标题含中文/)).not.toBeInTheDocument()
    })
  })

  it('多副本段：files.length > 1 才渲染', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue({
      ...baseMovie,
      files: [
        { path: '/media/dune.mkv', sources: ['local'], status: 'ok' },
        { path: '/backup/dune.mkv', sources: ['cifs'], status: 'ok' },
      ],
    })
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => {
      expect(screen.getByText('Files')).toBeInTheDocument()
      expect(screen.getByText('/media/dune.mkv')).toBeInTheDocument()
      expect(screen.getByText('/backup/dune.mkv')).toBeInTheDocument()
    })
  })

  it('单副本不渲染副本段', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue({
      ...baseMovie,
      files: [{ path: '/media/dune.mkv', sources: ['local'], status: 'ok' }],
    })
    render(<MovieDetailPage movieId="m1" />)
    await waitFor(() => {
      expect(screen.queryByText('Files')).not.toBeInTheDocument()
    })
  })

  it('404 → "Movie not found"', async () => {
    vi.mocked(client.api.movieDetail).mockResolvedValue(null)
    render(<MovieDetailPage movieId="nonexistent" />)
    await waitFor(() => expect(screen.getByText('Movie not found')).toBeInTheDocument())
  })
})
```

**Step 2: 跑测试**

```bash
cd web && npm test src/library/MovieDetailPage.test.tsx
```

Expected: 全绿。

**Step 3: 提交**

```bash
git add web/src/library/MovieDetailPage.test.tsx
git commit -m "test(web): MovieDetailPage 测试（spec B Task 11）

七 subStatus 人话句映射快照；
ignored+rule1b 不透传中文 reason；
多副本段条件渲染；
404 空态。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 13. Task 12: 母语标记 + 显示开关

**Files:**
- Modify: `web/src/library/PosterCard.tsx`
- Modify: `web/src/library/SeriesGrid.tsx`

**目标:** `nativeAudio=true` 海报卡加标记；SeriesGrid 加开关（localStorage `scout-show-native`）。

**Step 1: 修改 PosterCard.tsx**

在 PosterCard meta 区（覆盖点之后），追加母语标记：

```tsx
{item.nativeAudio && (
  <p className="text-xs text-weak">Native audio — no subtitles needed</p>
)}
```

**Step 2: 修改 SeriesGrid.tsx**

在 `SeriesGrid` 组件顶部，加开关 state：

```tsx
const [showNative, setShowNative] = useState(() => {
  const stored = localStorage.getItem('scout-show-native')
  return stored !== 'false' // fail-open：非 'false' 一律视为 ON
})

useEffect(() => {
  localStorage.setItem('scout-show-native', String(showNative))
}, [showNative])
```

在工具行（类型 chip 旁），加开关：

```tsx
<div className="flex items-center gap-2">
  <Switch checked={showNative} onCheckedChange={setShowNative} aria-label="Show native-language titles" />
  <span className="text-sm">Show native-language titles</span>
</div>
```

在过滤逻辑处（`kindFiltered` 之后），追加母语过滤：

```tsx
const nativeFiltered = showNative ? kindFiltered : kindFiltered.filter((x) => !x.nativeAudio)
const finalItems = nativeFiltered
```

在空态判断处，追加全母语空态：

```tsx
if (finalItems.length === 0 && !showNative && data.some((x) => x.nativeAudio)) {
  return (
    <EmptyState
      title="All titles are native-language"
      description='Turn on "Show native-language titles" to see them.'
    />
  )
}
```

**Step 3: 加 import**

在 `SeriesGrid.tsx` 顶部确认/追加：

```tsx
import { Switch } from '../components/ui/switch.js'
```

**Step 4: Type check**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

**Step 5: 提交**

```bash
git add web/src/library/PosterCard.tsx web/src/library/SeriesGrid.tsx
git commit -m "feat(web): 母语标记 + 显示开关（spec B §5.2 Task 12）

PosterCard nativeAudio 标记（meta 区弱色小字）；
SeriesGrid 开关（localStorage scout-show-native，默认 ON）；
全母语空态文案；
脏值 fail-open。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 14. Task 13: PosterCard movie 分支接链接

**Files:**
- Modify: `web/src/library/PosterCard.tsx`

**目标:** movie 分支从静态 div 改为 `<a href>`。

**Step 1: 读现状**

```bash
# 确认 PosterCard movie 分支现状
grep -A 10 "kind === 'movie'" web/src/library/PosterCard.tsx
```

**Step 2: 修改 PosterCard**

找到 movie 分支（约 `:62` 起），从：

```tsx
<div className="poster-card" data-testid="poster-card">
  {/* movie 内容 */}
</div>
```

改为：

```tsx
<a href={libraryItemHref(item)} className="poster-card" data-testid="poster-card">
  {/* movie 内容 */}
</a>
```

**Step 3: 加 import**

在 `PosterCard.tsx` 顶部确认/追加：

```tsx
import { libraryItemHref } from '../route.js'
```

**Step 4: 修改测试**

在 `PosterCard.test.tsx`（若存在），把 movie 分支的静态 div 断言改为 `<a>` 断言：

```tsx
it('movie 分支渲染 <a> 链接', () => {
  const movie: LibraryItemDTO = {
    libraryId: 'm1',
    name: 'Dune',
    kind: 'movie',
    // ...
  }
  render(<PosterCard item={movie} />)
  const card = screen.getByTestId('poster-card')
  expect(card.tagName).toBe('A')
  expect(card).toHaveAttribute('href', '#/library/movies/m1')
})
```

**Step 5: 跑测试**

```bash
cd web && npm test src/library/PosterCard.test.tsx
```

Expected: 全绿。

**Step 6: 提交**

```bash
git add web/src/library/PosterCard.tsx web/src/library/PosterCard.test.tsx
git commit -m "feat(web): PosterCard movie 分支接链接（spec B §5.3 Task 13）

movie 分支从静态 div 改为 <a href>；
libraryItemHref(item) → #/library/movies/:id。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 15. Task 14: InspectPanel 第三轨接线

**Files:**
- Modify: `web/src/subtitleVerify/InspectPanel.tsx`
- Modify: `web/src/subtitleVerify/CompareTimeline.tsx`（若需要骨架轨）

**目标:** `waveformAvailable=true` 时发 peaks 请求，成功 → 三轨，失败 → 双轨回退。

**Step 1: 读现状**

```bash
# 确认 InspectPanel 的 waveformPeaks 硬编码
grep -A 5 "waveformPeaks=" web/src/subtitleVerify/InspectPanel.tsx
# 确认 CompareTimeline 的 peaks 渲染逻辑
grep -A 10 "waveformPeaks" web/src/subtitleVerify/CompareTimeline.tsx
```

**Step 2: 修改 InspectPanel.tsx**

把 `:112` 的 `waveformPeaks={null}` 改为动态逻辑：

```tsx
const [peaks, setPeaks] = useState<number[] | null>(null)
const [peaksLoading, setPeaksLoading] = useState(false)

useEffect(() => {
  if (data.waveformAvailable) {
    setPeaksLoading(true)
    const controller = new AbortController()
    api
      .waveformPeaks(data.itemId, controller.signal)
      .then((res) => {
        setPeaks(res.peaks)
      })
      .catch(() => {
        // 静默回退双轨
        setPeaks(null)
      })
      .finally(() => {
        setPeaksLoading(false)
      })
    return () => controller.abort()
  }
}, [data.itemId, data.waveformAvailable])

// 传给 CompareTimeline
<CompareTimeline
  {...props}
  waveformPeaks={peaksLoading ? 'loading' : peaks}
/>
```

**Step 3: 修改 CompareTimeline（若需要骨架轨）**

在 `CompareTimeline.tsx` 找到 peaks 渲染块（约 `:178-181`），改为：

```tsx
{waveformPeaks === 'loading' && (
  <div className="h-[60px] animate-pulse bg-secondary" />
)}
{Array.isArray(waveformPeaks) && waveformPeaks.length > 0 && (
  <WaveTrack peaks={waveformPeaks} />
)}
```

**Step 4: Type check**

```bash
cd web && npx tsc --noEmit
```

Expected: 无错误。

**Step 5: 提交**

```bash
git add web/src/subtitleVerify/InspectPanel.tsx web/src/subtitleVerify/CompareTimeline.tsx
git commit -m "feat(web): InspectPanel 第三轨接线（spec B §5.5 Task 14）

waveformAvailable=true 时发 peaks 请求；
成功 → 传 peaks 数组；
loading → 骨架轨（shimmer）；
失败 → 静默回退双轨（不弹 toast）；
面板关闭 abort。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 16. Task 15: 全量验证 + 部署 + 实机验收

**Files:** N/A (验证步)

**目标:** 后端+前端全量测试、type check、build、部署、实机四项验收。

**Step 1: 后端全量测试**

```bash
npm test
```

Expected: 全绿（2603+ passed）。

**Step 2: 前端全量测试**

```bash
cd web && npm test
```

Expected: 全绿（820+ passed）。

**Step 3: 全量 type check**

```bash
npm run check
cd web && npx tsc --noEmit
```

Expected: 无错误。

**Step 4: 前端 build**

```bash
cd web && npm run build
```

Expected: 构建成功。

**Step 5: 部署**

```bash
DEPLOY_SSH_HOST=media-router-wan DEPLOY_TIMEOUT_SECONDS=3000 timeout 1500 ./deploy/deploy.sh
```

Expected: 部署成功，容器 Up。

**Step 6: 实机验收（media-router，主控执行）**

- [ ] 库中真实母语剧（国产剧）海报出现标记，开关 OFF 消失、ON 复现
- [ ] 真实电影点进详情：hero 降级美术、状态句、副本质检、校验段齐全
- [ ] LAN 库打开任一对照面板：第三轨在 ~10s 内出现波形
- [ ] 云盘条目（若有）显示既有云盘文案、不发 peaks 请求（DevTools Network 核实）

**Step 7: 记录**

验收通过后在 task list 标记 Task 15 completed。

---

## 17. 总结

Plan B 共 15 个任务，分四组：

- **Tasks 1-5:** 后端数据层（buildLibrary 增量 + 电影详情端点 + peaks 端点 + 路由接线 + 全量验证）
- **Tasks 6-8:** 前端数据层 + 类型视角（DTO 手抄 + client 包装 + KindFilter + 测试）
- **Tasks 9-11:** 电影详情页（路由改造 + MovieDetailPage 组件 + 测试）
- **Tasks 12-15:** 母语可见性 + 第三轨（母语标记+开关 + PosterCard 接链接 + InspectPanel 第三轨接线 + 全量验收）

**实现纪律：**
- 每个 task 一个 commit（one task = one commit）
- 审计在实现后进行（implementer → spec review → quality review，Plan C 成功模式）
- 测试随实现绿（每个 task 的测试步骤必须全绿才提交）

**前置依赖确认：**
- Spec C (Plan C) 已完成 ✅
- Library 海报墙已随迁（SeriesGrid/PosterCard 用 Spec C 栈）✅
- 电影详情页直接用 C 的新栈组件 ✅

Plan B 准备就绪，开始实现。

