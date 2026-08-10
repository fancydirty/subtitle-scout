# 剧集详情页重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把剧集详情页从"只有海报+格阵"重做成元数据丰盛但克制的媒体库详情页——TMDB 剧集简介 + 渐变 hero 背景图 + 季手风琴 + 逐集剧照 + 点集行内展开该集简介，并移除右侧滑入面板。

**Architecture:** 后端补一条 TMDB 富化数据管线（DB 加列 → adapter 提取 → catalog/upsertSeries 落库 → 强制回填），经 DTO 透传给前端；前端拆成 Hero / FactsRail / SeasonAccordion / EpisodeRow 组件，复用 `buildGridCells` 事实源与既有 5px 语义点，超长季（>50 集）回落紧凑格阵。

**Tech Stack:** better-sqlite3 · TypeScript · undici fetch · React 19 · @astryxdesign/core · vitest · testing-library

依据 spec：`docs/design/2026-07-20-detail-page-redesign-design.md`

**测试命令：** 后端 `npm test`（root，vitest run）；前端 `cd web && npx vitest run <file>`；类型 root `npm run check`、web `cd web && npx tsc --noEmit`。

---

## 阶段一 · 后端数据层

### Task 1: DB 迁移——加列 + 强制回填

**Files:**
- Modify: `src/v2/db.ts`（MIGRATIONS 数组末尾追加一条）
- Test: `src/v2/db.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { openDb } from './db.js'

it('v16 迁移：series 加 overview/backdrop_path，tmdb_seasons 加 overview/air_date/still_path', () => {
  const db = openDb(':memory:')
  const seriesCols = (db.prepare(`PRAGMA table_info(series)`).all() as { name: string }[]).map((c) => c.name)
  expect(seriesCols).toEqual(expect.arrayContaining(['overview', 'backdrop_path']))
  const tsCols = (db.prepare(`PRAGMA table_info(tmdb_seasons)`).all() as { name: string }[]).map((c) => c.name)
  expect(tsCols).toEqual(expect.arrayContaining(['overview', 'air_date', 'still_path']))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/v2/db.test.ts`
Expected: FAIL（新列不存在）。若 `openDb` 导出名不同，先 `grep -n "export function openDb\|export const openDb\|export function open" src/v2/db.ts` 对齐导入。

- [ ] **Step 3: 追加迁移**

在 `src/v2/db.ts` 的 `MIGRATIONS` 数组**末尾**追加（版本随数组长度自动顺延）：

```ts
  // v16（详情页重设计 item B，design: docs/design/2026-07-20-detail-page-redesign-design.md）：
  // TMDB 元数据富化——series 剧集简介/背景图 + tmdb_seasons 逐集简介/首播日/剧照。纯 ADD COLUMN，
  // 不触发建新表。加列后现有 tmdb_seasons 行新字段为 NULL；UPDATE fetched_at=0 强制下轮
  // refreshSeriesCatalog 重富化回填（不干等 7 天 TTL）。series 层靠既有富化重试 pass 连带补齐。
  `ALTER TABLE series ADD COLUMN overview TEXT;
   ALTER TABLE series ADD COLUMN backdrop_path TEXT;
   ALTER TABLE tmdb_seasons ADD COLUMN overview TEXT;
   ALTER TABLE tmdb_seasons ADD COLUMN air_date TEXT;
   ALTER TABLE tmdb_seasons ADD COLUMN still_path TEXT;
   UPDATE tmdb_seasons SET fetched_at = 0`,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/v2/db.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/db.ts src/v2/db.test.ts
git commit -m "feat(db): v16 迁移——series+tmdb_seasons 加 TMDB 富化列，强制回填"
```

---

### Task 2: TMDB adapter——提取 backdrop + 逐集 overview/air_date/still

**Files:**
- Modify: `src/adapters/providers/tmdb.ts`（`TmdbDetails` 接口、`getDetails`、`getSeasonEpisodes`）
- Test: `src/adapters/providers/tmdb.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
function fakeFetch(json: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

it('getDetails 提取 backdropPath（空/缺 → null）', async () => {
  const c = new TmdbClient({ apiKey: 'k', fetchImpl: fakeFetch({ overview: 'o', backdrop_path: '/bd.jpg', seasons: [] }) })
  const d = await c.getDetails('tv', '1')
  expect(d?.backdropPath).toBe('/bd.jpg')
  const c2 = new TmdbClient({ apiKey: 'k', fetchImpl: fakeFetch({ overview: 'o' }) })
  expect((await c2.getDetails('tv', '1'))?.backdropPath).toBeNull()
})

it('getSeasonEpisodes 提取 overview/airDate/stillPath（空串/缺 → null）', async () => {
  const c = new TmdbClient({ apiKey: 'k', fetchImpl: fakeFetch({ episodes: [
    { episode_number: 1, name: 'E1', overview: 'ov1', air_date: '2011-10-05', still_path: '/s1.jpg' },
    { episode_number: 2, name: 'E2', overview: '', air_date: '', still_path: null },
  ] }) })
  const eps = await c.getSeasonEpisodes('1', 1)
  expect(eps?.[0]).toEqual({ episode: 1, title: 'E1', overview: 'ov1', airDate: '2011-10-05', stillPath: '/s1.jpg' })
  expect(eps?.[1]).toEqual({ episode: 2, title: 'E2', overview: null, airDate: null, stillPath: null })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/adapters/providers/tmdb.test.ts`
Expected: FAIL（`backdropPath` undefined；getSeasonEpisodes 返回缺 overview/airDate/stillPath）

- [ ] **Step 3: 实现**

`TmdbDetails` 接口增字段：

```ts
  posterPath: string | null
  backdropPath: string | null
```

`getDetails` 在 `const posterPath = ...` 之后加：

```ts
    const rawBackdrop = d.backdrop_path
    const backdropPath = typeof rawBackdrop === 'string' && rawBackdrop ? rawBackdrop : null
```

并在 return 对象里加 `backdropPath`。

`getSeasonEpisodes` 返回类型与映射改为：

```ts
  async getSeasonEpisodes(tvId: string, season: number): Promise<{ episode: number; title: string | null; overview: string | null; airDate: string | null; stillPath: string | null }[] | null> {
    const d = await this.getJsonStrict(`/tv/${tvId}/season/${season}`)
    if (!d) return null
    const episodes = d.episodes
    if (!Array.isArray(episodes)) return null
    return (episodes as Array<{ episode_number?: number; name?: string; overview?: string; air_date?: string; still_path?: string | null }>)
      .filter((e): e is { episode_number: number; name?: string; overview?: string; air_date?: string; still_path?: string | null } => typeof e.episode_number === 'number')
      .map(e => ({
        episode: e.episode_number,
        title: typeof e.name === 'string' && e.name ? e.name : null,
        overview: typeof e.overview === 'string' && e.overview ? e.overview : null,
        airDate: typeof e.air_date === 'string' && e.air_date ? e.air_date : null,
        stillPath: typeof e.still_path === 'string' && e.still_path ? e.still_path : null,
      }))
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全 adapter 套件**

Run: `npm test -- src/adapters/providers/tmdb.test.ts`
Expected: PASS（含既有测试不回归）

- [ ] **Step 5: 提交**

```bash
git add src/adapters/providers/tmdb.ts src/adapters/providers/tmdb.test.ts
git commit -m "feat(tmdb): 提取 backdrop_path + 逐集 overview/air_date/still_path"
```

---

## 阶段二 · 持久化与 catalog

### Task 3: tmdbCatalog——落库 + 读出逐集富化字段

**Files:**
- Modify: `src/v2/tmdbCatalog.ts`（`refreshSeriesCatalog` 的 rows/INSERT、`canonicalEpisodes` 的 SELECT/返回）
- Test: `src/v2/tmdbCatalog.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('refresh 把逐集 overview/air_date/still 写库，canonicalEpisodes 读回', async () => {
  const db = openDb(':memory:')
  const tmdb = {
    getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 1, airDate: null }],
    getSeasonEpisodes: async () => [{ episode: 1, title: 'E1', overview: 'ov1', airDate: '2011-10-05', stillPath: '/s1.jpg' }],
  }
  await refreshSeriesCatalog(db, tmdb as never, 'tmdb:9', 1_700_000_000_000)
  const eps = canonicalEpisodes(db, 'tmdb:9', 1)
  expect(eps[0]).toEqual({ episode: 1, title: 'E1', overview: 'ov1', airDate: '2011-10-05', stillPath: '/s1.jpg' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/v2/tmdbCatalog.test.ts`
Expected: FAIL（canonicalEpisodes 只返回 episode/title）

- [ ] **Step 3: 实现**

`refreshSeriesCatalog` 内 `rows` 类型与 push、INSERT 改为：

```ts
  const rows: { season: number; episode: number; title: string | null; overview: string | null; airDate: string | null; stillPath: string | null }[] = []
  for (const s of seasonTable) {
    let episodes: Awaited<ReturnType<typeof tmdb.getSeasonEpisodes>>
    try {
      episodes = await tmdb.getSeasonEpisodes(tmdbId, s.seasonNumber)
    } catch {
      return
    }
    if (!episodes) return
    for (const e of episodes) rows.push({ season: s.seasonNumber, episode: e.episode, title: e.title, overview: e.overview, airDate: e.airDate, stillPath: e.stillPath })
  }

  const writeRows = db.transaction(() => {
    db.prepare('DELETE FROM tmdb_seasons WHERE series_id = ?').run(seriesId)
    const insert = db.prepare(
      'INSERT INTO tmdb_seasons (series_id, season, episode, title, overview, air_date, still_path, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const r of rows) insert.run(seriesId, r.season, r.episode, r.title, r.overview, r.airDate, r.stillPath, now)
  })
  writeRows()
```

`canonicalEpisodes` 改为：

```ts
export function canonicalEpisodes(
  db: ScoutDb,
  seriesId: string,
  season: number,
): { episode: number; title: string | null; overview: string | null; airDate: string | null; stillPath: string | null }[] {
  return db
    .prepare('SELECT episode, title, overview, air_date AS airDate, still_path AS stillPath FROM tmdb_seasons WHERE series_id = ? AND season = ? ORDER BY episode ASC')
    .all(seriesId, season) as { episode: number; title: string | null; overview: string | null; airDate: string | null; stillPath: string | null }[]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/v2/tmdbCatalog.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/tmdbCatalog.ts src/v2/tmdbCatalog.test.ts
git commit -m "feat(catalog): tmdb_seasons 落库+读出逐集 overview/air_date/still"
```

---

### Task 4: libraryRepo.upsertSeries——落 overview/backdrop

**Files:**
- Modify: `src/v2/libraryRepo.ts`（`SeriesUpsertParams` 类型、`upsertSeries` 的 INSERT/COALESCE）
- Test: `src/v2/libraryRepo.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('upsertSeries 落 overview/backdrop，COALESCE 不清空既有', () => {
  const db = openDb(':memory:')
  const repo = new LibraryRepo(db)
  repo.upsertSeries({ id: 'tmdb:9', name: 'S', overview: 'ov', backdropPath: '/bd.jpg' })
  let row = db.prepare(`SELECT overview, backdrop_path FROM series WHERE id='tmdb:9'`).get() as { overview: string; backdrop_path: string }
  expect(row).toEqual({ overview: 'ov', backdrop_path: '/bd.jpg' })
  repo.upsertSeries({ id: 'tmdb:9', name: 'S' }) // 无新值 → 不清空
  row = db.prepare(`SELECT overview, backdrop_path FROM series WHERE id='tmdb:9'`).get() as { overview: string; backdrop_path: string }
  expect(row).toEqual({ overview: 'ov', backdrop_path: '/bd.jpg' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/v2/libraryRepo.test.ts`
Expected: FAIL（`overview`/`backdropPath` 非 upsertSeries 已知参数；列写不进）。先 `grep -n "upsertSeries\|SeriesUpsertParams\|INSERT INTO series" src/v2/libraryRepo.ts` 对齐参数类型名与 INSERT 位置。

- [ ] **Step 3: 实现**

`SeriesUpsertParams`（约 L14 一族）增：

```ts
  overview?: string | null
  backdropPath?: string | null
```

`upsertSeries` 内（约 L191-221）：在 `const posterPath = params.posterPath ?? null` 附近加 `const overview = params.overview ?? null` 与 `const backdropPath = params.backdropPath ?? null`；INSERT 列表与 VALUES 加 `overview, backdrop_path`；ON CONFLICT SET 加：

```ts
           overview = COALESCE(excluded.overview, overview),
           backdrop_path = COALESCE(excluded.backdrop_path, backdrop_path),
```

并把 `overview, backdropPath` 加进 `.run(...)` 的绑定参数（顺序对齐 INSERT 列）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/v2/libraryRepo.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat(repo): upsertSeries 落 overview/backdrop（COALESCE 不清空）"
```

---

### Task 5: ingest 富化——把 overview/backdrop 传进 upsertSeries

**Files:**
- Modify: `src/v2/ingest.ts`（getDetails 结果落 series 的调用点，现已传 posterPath）
- Test: 复用 `src/v2/ingest.test.ts` 现有 getDetails 富化用例扩断言

- [ ] **Step 1: 定位调用点**

Run: `grep -n "upsertSeries\|getDetails\|posterPath" src/v2/ingest.ts`
找到把 `TmdbDetails` 落 series 行的那处 `upsertSeries({... posterPath: details.posterPath ...})`。

- [ ] **Step 2: 写失败断言**

在 `src/v2/ingest.test.ts` 覆盖"新剧 enrich 落 series 元数据"的用例里，让 mock 的 `getDetails` 返回带 `overview`/`backdropPath` 的 `TmdbDetails`，断言落库后 `series.overview`/`backdrop_path` 非空。

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- src/v2/ingest.test.ts`
Expected: FAIL（overview/backdrop 未落）

- [ ] **Step 4: 实现**

在 Step 1 定位的 `upsertSeries({...})` 调用里补：

```ts
      overview: details.overview,
      backdropPath: details.backdropPath,
```

（`details` 即该处 `TmdbDetails` 变量名，以现场为准。）

- [ ] **Step 5: 跑测试确认通过 + 全 root 套件**

Run: `npm test -- src/v2/ingest.test.ts` 然后 `npm test`
Expected: PASS，全绿

- [ ] **Step 6: 提交**

```bash
git add src/v2/ingest.ts src/v2/ingest.test.ts
git commit -m "feat(ingest): 富化落 series overview/backdrop（存量剧回填路径）"
```

---

## 阶段三 · DTO 与 API

### Task 6: DTO 透传新字段

**Files:**
- Modify: `src/dashboard/apiV2.ts`（`LibrarySeriesSummaryDTO` L1075、`LibraryCanonicalEpisodeDTO` L1083、`LibrarySeriesRow` L1113、`buildLibrarySeriesDetail` L1141 的 SELECT 与 series 构造）
- Modify: `web/src/api/types.ts`（同名接口，前后端保持一致）
- Test: `src/dashboard/apiV2.test.ts`（或 buildLibrarySeriesDetail 现有测试文件）

- [ ] **Step 1: 写失败测试**

```ts
it('buildLibrarySeriesDetail 出参带 series.overview/backdropPath 与逐集 canonical overview/airDate/stillPath', () => {
  const db = openDb(':memory:')
  db.prepare(`INSERT INTO series (id, name, overview, backdrop_path) VALUES ('tmdb:9','S','ov','/bd.jpg')`).run()
  db.prepare(`INSERT INTO tmdb_seasons (series_id, season, episode, title, overview, air_date, still_path, fetched_at) VALUES ('tmdb:9',1,1,'E1','eov','2011-10-05','/s1.jpg',1)`).run()
  const dto = buildLibrarySeriesDetail(db, 'tmdb:9')!
  expect(dto.series.overview).toBe('ov')
  expect(dto.series.backdropPath).toBe('/bd.jpg')
  expect(dto.seasons[0].canonical[0]).toEqual({ episode: 1, title: 'E1', overview: 'eov', airDate: '2011-10-05', stillPath: '/s1.jpg' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/dashboard/apiV2.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现（apiV2.ts）**

`LibrarySeriesSummaryDTO` 增 `overview: string | null` `backdropPath: string | null`；
`LibraryCanonicalEpisodeDTO` 增 `overview: string | null` `airDate: string | null` `stillPath: string | null`；
`LibrarySeriesRow` 增 `overview: string | null` `backdrop_path: string | null`；
`buildLibrarySeriesDetail` 的 series SELECT 改为 `SELECT id, name, chinese_title, poster_path, overview, backdrop_path, year, layout_nonstandard FROM series WHERE id = ?`；
series 构造对象（return 里 `series: {...}`）加 `overview: row.overview, backdropPath: row.backdrop_path`。
`canonical: canonicalEpisodes(...)` 已随 Task 3 返回新字段，无需再改。

- [ ] **Step 4: 实现（web/src/api/types.ts）**

同名接口 `LibrarySeriesSummaryDTO` / `LibraryCanonicalEpisodeDTO` 增完全相同的字段（保持前后端一致，见文件顶部注释约定）。

- [ ] **Step 5: 跑测试 + 双端类型**

Run: `npm test -- src/dashboard/apiV2.test.ts` && `npm run check` && `cd web && npx tsc --noEmit && cd ..`
Expected: 后端 PASS；此时 web tsc 会因组件尚未消费新字段而**仍通过**（新字段可选消费）。

- [ ] **Step 6: 提交**

```bash
git add src/dashboard/apiV2.ts web/src/api/types.ts src/dashboard/apiV2.test.ts
git commit -m "feat(dto): series overview/backdrop + 逐集 overview/airDate/still 透传"
```

---

## 阶段四 · 前端地基

### Task 7: 图片 URL——backdropUrl / stillUrl

**Files:**
- Modify: `web/src/api/client.ts`（`posterUrl` 附近 L24-31）
- Test: `web/src/api/client.test.ts`（无则新建）

- [ ] **Step 1: 写失败测试**

```ts
import { backdropUrl, stillUrl } from './client.js'
it('backdrop 用 w1280、still 用 w300；null → null', () => {
  expect(backdropUrl('/bd.jpg')).toBe('https://image.tmdb.org/t/p/w1280/bd.jpg')
  expect(stillUrl('/s.jpg')).toBe('https://image.tmdb.org/t/p/w300/s.jpg')
  expect(backdropUrl(null)).toBeNull()
  expect(stillUrl(null)).toBeNull()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/api/client.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现**

在 `client.ts` 的 `posterUrl` 之后追加：

```ts
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280'
const TMDB_STILL_BASE = 'https://image.tmdb.org/t/p/w300'

/** 背景大图 URL（hero 用），无 path → null 让调用方降级纯排印头部。 */
export function backdropUrl(path: string | null): string | null {
  if (!path) return null
  return `${TMDB_BACKDROP_BASE}${path}`
}

/** 逐集剧照缩略图 URL，无 path → null 让调用方不渲染 img。 */
export function stillUrl(path: string | null): string | null {
  if (!path) return null
  return `${TMDB_STILL_BASE}${path}`
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/api/client.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/api/client.ts web/src/api/client.test.ts
git commit -m "feat(web): backdropUrl(w1280)/stillUrl(w300)"
```

---

### Task 8: episodeState——GridCell 携带 canonical 富化字段

**Files:**
- Modify: `web/src/library/episodeState.ts`（`GridCell` 接口、`buildGridCells`、新增 `EPISODE_ROW_CAP`）
- Test: `web/src/library/episodeState.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it('GridCell 透传 canonical overview/airDate/stillPath（dashed 与 onDisk 都带）', () => {
  const s = season({
    canonical: [{ episode: 1, title: 'E1', overview: 'ov1', airDate: '2011-10-05', stillPath: '/s1.jpg' }],
    onDisk: [{ episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] }],
  })
  const [cell] = buildGridCells(s, NOW)
  expect(cell.overview).toBe('ov1')
  expect(cell.airDate).toBe('2011-10-05')
  expect(cell.stillPath).toBe('/s1.jpg')
})

it('EPISODE_ROW_CAP 为 50', () => {
  expect(EPISODE_ROW_CAP).toBe(50)
})
```

同时把 `episodeState.test.ts` 顶部 `season()` 工厂里 canonical 元素补齐新字段（现有测试的 canonical 用 `{ episode, title }` → 需允许可选新字段；测试工厂给默认 null）。并更新 `web/src/api/types.ts` 的 `LibraryCanonicalEpisodeDTO` 已在 Task 6 加好，测试 fixture 里显式给这三字段即可。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/library/episodeState.test.ts`
Expected: FAIL（GridCell 无 overview/airDate/stillPath；EPISODE_ROW_CAP 未定义）

- [ ] **Step 3: 实现**

`episodeState.ts`：

```ts
export const EPISODE_ROW_CAP = 50

export interface GridCell {
  episode: number
  state: EpisodeCellState
  title: string | null
  overview: string | null
  airDate: string | null
  stillPath: string | null
  onDisk: LibraryOnDiskEpisodeDTO | null
}
```

`buildGridCells` 的 `.map` 里，从 `canonicalByEp.get(episode)` 取三字段：

```ts
    .map((episode) => {
      const disk = onDiskByEp.get(episode) ?? null
      const c = canonicalByEp.get(episode)
      const base = { episode, title: c?.title ?? null, overview: c?.overview ?? null, airDate: c?.airDate ?? null, stillPath: c?.stillPath ?? null }
      if (disk) return { ...base, state: classifyOnDisk(disk, now), onDisk: disk }
      return { ...base, state: 'dashed' as const, onDisk: null }
    })
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/library/episodeState.test.ts`
Expected: PASS（含 A 修的 embedded tally 用例不回归）

- [ ] **Step 5: 提交**

```bash
git add web/src/library/episodeState.ts web/src/library/episodeState.test.ts
git commit -m "feat(web): GridCell 携带 canonical overview/airDate/still + EPISODE_ROW_CAP=50"
```

---

## 阶段五 · 前端组件

> 通用测试范式（照 `web/src/library/SeriesPage.test.tsx`）：`render(<I18nProvider><Comp .../></I18nProvider>)` + testing-library。**i18n key 在 Task 9 Step 0 先加齐**（Task 10-13 组件都依赖，必须先落，否则 `TKey` 类型报错 + t() 取不到文案）。

### Task 9: SeriesHero 组件（+ 先落齐 Phase 5 全部 i18n key）

**Files:**
- Modify: `web/src/i18n/en.ts` `web/src/i18n/zh.ts`（Phase 5 全部新 key，一次落齐）
- Create: `web/src/library/SeriesHero.tsx`
- Create: `web/src/library/SeriesHero.test.tsx`
- Modify: `web/src/styles.css`（`.library-hero*` 原子样式）

- [ ] **Step 0: 先加齐 Phase 5 全部 i18n key（Task 10-13 依赖）**

`zh.ts` 与 `en.ts` 各加（放 `library_detail_*` 一族附近）：

```ts
// zh.ts
  library_detail_embedded_short: '内嵌',
  library_episode_no_overview: '暂无本集简介（TMDB 未提供）',
  library_facts_coverage: '覆盖',
  library_facts_embedded_unit: '集内嵌',
// en.ts
  library_detail_embedded_short: 'embedded',
  library_episode_no_overview: 'No synopsis for this episode (not provided by TMDB).',
  library_facts_coverage: 'covered',
  library_facts_embedded_unit: 'embedded',
```

提交这一步（key 先行）：`git add web/src/i18n/en.ts web/src/i18n/zh.ts && git commit -m "feat(web/i18n): 详情页 Phase 5 文案 key"`

**Files:**
- Create: `web/src/library/SeriesHero.tsx`
- Create: `web/src/library/SeriesHero.test.tsx`
- Modify: `web/src/styles.css`（`.library-hero*` 原子样式）

- [ ] **Step 1: 写失败测试**

```ts
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SeriesHero } from './SeriesHero.js'

function wrap(ui: React.ReactElement) { return render(<I18nProvider>{ui}</I18nProvider>) }

it('有 backdrop → 渲染背景图；有 overview → 渲染简介', () => {
  wrap(<SeriesHero name="美国恐怖故事" originalName="American Horror Story" year={2011} seriesId="tmdb:1413" posterPath={null} backdropPath="/bd.jpg" overview="每季一个独立恐怖故事" />)
  expect(screen.getByText('美国恐怖故事')).toBeInTheDocument()
  expect(screen.getByText('每季一个独立恐怖故事')).toBeInTheDocument()
  expect(document.querySelector('.library-hero-backdrop')).toBeTruthy()
})

it('无 backdrop → 降级纯排印（无背景图节点）；无 overview → 不渲染简介段', () => {
  wrap(<SeriesHero name="X" originalName={null} year={null} seriesId="tmdb:2" posterPath={null} backdropPath={null} overview={null} />)
  expect(document.querySelector('.library-hero-backdrop')).toBeNull()
  expect(screen.getByText('X')).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/library/SeriesHero.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现组件**

```tsx
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { backdropUrl } from '../api/client.js'
import { PosterThumb } from './PosterThumb.js'

interface Props {
  name: string
  originalName: string | null
  year: number | null
  seriesId: string
  posterPath: string | null
  backdropPath: string | null
  overview: string | null
}

export function SeriesHero({ name, originalName, year, seriesId, posterPath, backdropPath, overview }: Props) {
  const bd = backdropUrl(backdropPath)
  return (
    <div className="library-hero">
      {bd ? <div className="library-hero-backdrop" style={{ backgroundImage: `url(${bd})` }} aria-hidden="true" /> : null}
      <div className="library-hero-scrim" />
      <HStack gap={4} className="library-hero-body">
        <div className="library-detail-header-poster">
          <PosterThumb posterPath={posterPath} name={name} />
        </div>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center">
            <Text type="large" weight="semibold">{name}</Text>
            <Text type="code" color="secondary">{seriesId}</Text>
          </HStack>
          <Text type="supporting" color="secondary">
            {[originalName, year ? String(year) : null].filter(Boolean).join(' · ')}
          </Text>
          {overview ? <Text type="body" color="secondary">{overview}</Text> : null}
        </VStack>
      </HStack>
    </div>
  )
}
```

- [ ] **Step 4: 加样式（styles.css）**

```css
.library-hero { position: relative; border-radius: 12px; overflow: hidden; padding: 20px; }
.library-hero-backdrop { position: absolute; inset: 0; background-size: cover; background-position: center 20%; z-index: 0; }
.library-hero-scrim { position: absolute; inset: 0; z-index: 1;
  background: linear-gradient(180deg, rgba(11,12,15,.35) 0%, var(--color-background-body) 82%); }
.library-hero-body { position: relative; z-index: 2; }
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `cd web && npx vitest run src/library/SeriesHero.test.tsx`
Expected: PASS

```bash
git add web/src/library/SeriesHero.tsx web/src/library/SeriesHero.test.tsx web/src/styles.css
git commit -m "feat(web): SeriesHero——渐变压暗背景图 + 简介，无图降级纯排印"
```

---

### Task 10: FactsRail 组件

**Files:**
- Create: `web/src/library/FactsRail.tsx`
- Create: `web/src/library/FactsRail.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it('渲染覆盖计数与来源（mono 技术读数）', () => {
  render(<I18nProvider><FactsRail covered={8} total={8} embedded={8} langs={['zh-Hans', 'en']} /></I18nProvider>)
  expect(screen.getByText(/8 \/ 8/)).toBeInTheDocument() // 文本节点整体是"覆盖 8 / 8"，用正则子串匹配
  expect(screen.getByText('zh-Hans · en')).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/library/FactsRail.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { useT } from '../i18n/useT.js'

interface Props { covered: number; total: number; embedded: number; langs: string[] }

export function FactsRail({ covered, total, embedded, langs }: Props) {
  const { t } = useT()
  return (
    <HStack gap={4} wrap="wrap" className="library-facts-rail">
      <Text type="code" color="secondary">{t('library_facts_coverage')} {covered} / {total}</Text>
      {langs.length ? <Text type="code" color="secondary">{langs.join(' · ')}</Text> : null}
      {embedded > 0 ? <Text type="code" color="secondary">{embedded} {t('library_facts_embedded_unit')}</Text> : null}
    </HStack>
  )
}
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `cd web && npx vitest run src/library/FactsRail.test.tsx`
Expected: PASS

```bash
git add web/src/library/FactsRail.tsx web/src/library/FactsRail.test.tsx
git commit -m "feat(web): FactsRail——mono 覆盖计数/语言/内嵌事实栏"
```

---

### Task 11: EpisodeRow 组件（逐集行 + 行内展开 + 剧照）

**Files:**
- Create: `web/src/library/EpisodeRow.tsx`
- Create: `web/src/library/EpisodeRow.test.tsx`
- Modify: `web/src/styles.css`（`.library-eprow*`）

- [ ] **Step 1: 写失败测试**

```ts
import { fireEvent } from '@testing-library/react'
function cell(over: Partial<GridCell> = {}): GridCell {
  return { episode: 1, state: 'covered', title: 'Pilot', overview: 'ov1', airDate: '2011-10-05', stillPath: '/s1.jpg', onDisk: null, ...over }
}

it('展开态显示该集简介；未展开不显示', () => {
  const { rerender } = render(<I18nProvider><EpisodeRow cell={cell()} expanded={false} onToggle={() => {}} /></I18nProvider>)
  expect(screen.queryByText('ov1')).not.toBeInTheDocument()
  rerender(<I18nProvider><EpisodeRow cell={cell()} expanded={true} onToggle={() => {}} /></I18nProvider>)
  expect(screen.getByText('ov1')).toBeInTheDocument()
})

it('点击行触发 onToggle', () => {
  const onToggle = vi.fn()
  render(<I18nProvider><EpisodeRow cell={cell()} expanded={false} onToggle={onToggle} /></I18nProvider>)
  fireEvent.click(screen.getByRole('button', { name: /Pilot/ }))
  expect(onToggle).toHaveBeenCalled()
})

it('overview 为 null → 展开显示"暂无本集简介"占位（不空白）', () => {
  render(<I18nProvider><EpisodeRow cell={cell({ overview: null })} expanded={true} onToggle={() => {}} /></I18nProvider>)
  expect(screen.getByText('暂无本集简介（TMDB 未提供）')).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/library/EpisodeRow.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import type { GridCell } from './episodeState.js'
import { stillUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'

interface Props { cell: GridCell; expanded: boolean; onToggle: () => void }

const DOT_CLASS: Record<string, string> = {
  covered: 'ep-dot-covered', hardsub: 'ep-dot-hardsub', missing: 'ep-dot-missing',
  throttled: 'ep-dot-throttled', partial: 'ep-dot-partial', error: 'ep-dot-missing', dashed: 'ep-dot-missing',
}

export function EpisodeRow({ cell, expanded, onToggle }: Props) {
  const { t } = useT()
  const isEmbedded = cell.onDisk?.subStatus === 'embedded'
  const still = stillUrl(cell.stillPath)
  const epLabel = `E${String(cell.episode).padStart(2, '0')}`
  return (
    <div className={`library-eprow${expanded ? ' library-eprow-active' : ''}`}>
      <button type="button" className="library-eprow-head" onClick={onToggle} aria-expanded={expanded}>
        <span className={`ep-dot ${DOT_CLASS[cell.state] ?? 'ep-dot-missing'}`} aria-hidden="true" />
        <Text type="code" color="secondary">{epLabel}</Text>
        <Text type="label" color="primary">{cell.title ?? epLabel}</Text>
        {isEmbedded ? <span className="library-eprow-tag">{t('library_detail_embedded_short')}</span> : null}
        <span className="library-eprow-spacer" />
        {still ? <img className="library-eprow-still" src={still} alt="" loading="lazy" /> : null}
        {cell.airDate ? <Text type="code" color="secondary">{cell.airDate}</Text> : null}
      </button>
      {expanded ? (
        <VStack gap={1} className="library-eprow-body">
          <Text type="body" color="secondary">{cell.overview ?? t('library_episode_no_overview')}</Text>
        </VStack>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: 加样式**

```css
.library-eprow { border-top: 1px solid var(--color-border); }
.library-eprow-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 4px 9px 10px;
  background: transparent; border: 0; border-left: 2px solid transparent; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.library-eprow-head:hover { background: var(--color-background-card); }
.library-eprow-active > .library-eprow-head { border-left-color: var(--color-accent); background: var(--color-background-card); }
.library-eprow-spacer { flex: 1; }
.library-eprow-still { width: 112px; height: 63px; object-fit: cover; border-radius: 6px; border: 1px solid var(--color-border); }
.library-eprow-tag { font-family: var(--font-code, ui-monospace); font-size: 10px; color: var(--color-text-secondary);
  border: 1px solid var(--color-border); border-radius: 4px; padding: 0 5px; }
.library-eprow-body { padding: 2px 10px 12px 40px; }
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `cd web && npx vitest run src/library/EpisodeRow.test.tsx`
Expected: PASS

```bash
git add web/src/library/EpisodeRow.tsx web/src/library/EpisodeRow.test.tsx web/src/styles.css
git commit -m "feat(web): EpisodeRow——文字在左+剧照+点击行内展开该集简介"
```

---

### Task 12: SeasonGridBody（超长季紧凑格阵回落）

**Files:**
- Create: `web/src/library/SeasonGridBody.tsx`
- Create: `web/src/library/SeasonGridBody.test.tsx`

- [ ] **Step 1: 写失败测试**

```ts
it('点格阵中一格 → 格阵下方展开该集简介', () => {
  const cells: GridCell[] = Array.from({ length: 3 }, (_, i) => ({
    episode: i + 1, state: 'covered', title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null, onDisk: null,
  }))
  render(<I18nProvider><SeasonGridBody cells={cells} /></I18nProvider>)
  expect(screen.queryByText('ov2')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '2' }))
  expect(screen.getByText('ov2')).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/library/SeasonGridBody.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
import { useState } from 'react'
import { VStack } from '@astryxdesign/core/VStack'
import { Text } from '@astryxdesign/core/Text'
import type { GridCell } from './episodeState.js'
import { EpisodeCell } from './EpisodeCell.js'
import { useT } from '../i18n/useT.js'

export function SeasonGridBody({ cells }: { cells: GridCell[] }) {
  const { t } = useT()
  const [sel, setSel] = useState<number | null>(null)
  const active = cells.find((c) => c.episode === sel) ?? null
  return (
    <VStack gap={2}>
      <div className="ep-grid">
        {cells.map((cell) => (
          <EpisodeCell key={cell.episode} cell={cell} isSelected={cell.episode === sel}
            onSelect={() => setSel((p) => (p === cell.episode ? null : cell.episode))} />
        ))}
      </div>
      {active ? (
        <VStack gap={1} className="library-eprow-body" style={{ paddingLeft: 10 }}>
          <Text type="supporting" color="secondary">{`S·E${String(active.episode).padStart(2, '0')}`} {active.title ?? ''}</Text>
          <Text type="body" color="secondary">{active.overview ?? t('library_episode_no_overview')}</Text>
        </VStack>
      ) : null}
    </VStack>
  )
}
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `cd web && npx vitest run src/library/SeasonGridBody.test.tsx`
Expected: PASS

```bash
git add web/src/library/SeasonGridBody.tsx web/src/library/SeasonGridBody.test.tsx
git commit -m "feat(web): SeasonGridBody——超长季紧凑格阵+点格下方展开简介"
```

---

### Task 13: SeasonAccordion（季手风琴 + 卷起汇总 + 行/格阵分派）

**Files:**
- Create: `web/src/library/SeasonAccordion.tsx`
- Create: `web/src/library/SeasonAccordion.test.tsx`
- Modify: `web/src/styles.css`（`.library-season*`）

- [ ] **Step 1: 写失败测试**

```ts
function seasonDTO(nEps: number): LibrarySeasonDTO {
  return { season: 1,
    canonical: Array.from({ length: nEps }, (_, i) => ({ episode: i + 1, title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null })),
    onDisk: Array.from({ length: nEps }, (_, i) => ({ episode: i + 1, path: `/m/e${i + 1}.mkv`, subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] })),
    coverage: [] }
}

it('默认展开：≤50 集用行式（EpisodeRow），点集展开简介', () => {
  render(<I18nProvider><SeasonAccordion season={seasonDTO(3)} now={NOW} defaultOpen /></I18nProvider>)
  expect(screen.queryByText('ov2')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /E2/ }))
  expect(screen.getByText('ov2')).toBeInTheDocument()
})

it('>50 集回落格阵（SeasonGridBody：格子是数字按钮，不是逐集行头）', () => {
  render(<I18nProvider><SeasonAccordion season={seasonDTO(60)} now={NOW} defaultOpen /></I18nProvider>)
  // 行式头是 "E0N + 标题"，格阵是裸数字 → 存在纯数字 name 的按钮即证明走了格阵
  expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument()
})

it('季头卷起汇总：覆盖句（含缺口时的 clause）', () => {
  const s = seasonDTO(2); s.onDisk[1].subStatus = 'missing'
  render(<I18nProvider><SeasonAccordion season={s} now={NOW} defaultOpen={false} /></I18nProvider>)
  expect(screen.getByText(/1 \/ 2/)).toBeInTheDocument()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/library/SeasonAccordion.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现**

```tsx
import { useState } from 'react'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import type { LibrarySeasonDTO } from '../api/types.js'
import { buildGridCells, tallyGridCells, isCanonicalPending, EPISODE_ROW_CAP } from './episodeState.js'
import { seasonCoverageSentence } from './text.js'
import { EpisodeRow } from './EpisodeRow.js'
import { SeasonGridBody } from './SeasonGridBody.js'
import { useT, type Lang } from '../i18n/useT.js'

interface Props { season: LibrarySeasonDTO; now: number; defaultOpen?: boolean }

export function SeasonAccordion({ season, now, defaultOpen = true }: Props) {
  const { t, lang } = useT()
  const [open, setOpen] = useState(defaultOpen)
  const [expandedEp, setExpandedEp] = useState<number | null>(null)
  const cells = buildGridCells(season, now)
  const tally = tallyGridCells(cells)
  const sentence = seasonCoverageSentence(season.season, tally, lang as Lang)
  const useGrid = cells.length > EPISODE_ROW_CAP

  return (
    <VStack gap={2}>
      <button type="button" className="library-season-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`library-season-chev${open ? ' open' : ''}`} aria-hidden="true">›</span>
        <Text type="body" color="secondary">
          {sentence.prefix} <Text as="span" weight="semibold" color="primary" size="lg">{sentence.emphasis}</Text> {sentence.suffix}
          {sentence.clause ? <Text as="span" color="secondary"> — {sentence.clause}</Text> : null}
        </Text>
      </button>
      {isCanonicalPending(season) ? <Text type="code" color="secondary">{t('library_detail_canonical_pending')}</Text> : null}
      {open ? (
        useGrid ? <SeasonGridBody cells={cells} /> : (
          <div>
            {cells.map((cell) => (
              <EpisodeRow key={cell.episode} cell={cell} expanded={expandedEp === cell.episode}
                onToggle={() => setExpandedEp((p) => (p === cell.episode ? null : cell.episode))} />
            ))}
          </div>
        )
      ) : null}
    </VStack>
  )
}
```

- [ ] **Step 4: 加样式**

```css
.library-season-head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 11px 2px;
  background: transparent; border: 0; color: inherit; cursor: pointer; font: inherit; text-align: left; }
.library-season-chev { color: var(--color-text-gray); transition: transform .18s ease; display: inline-block; }
.library-season-chev.open { transform: rotate(90deg); }
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `cd web && npx vitest run src/library/SeasonAccordion.test.tsx`
Expected: PASS

```bash
git add web/src/library/SeasonAccordion.tsx web/src/library/SeasonAccordion.test.tsx web/src/styles.css
git commit -m "feat(web): SeasonAccordion——季手风琴+卷起汇总+行/格阵按 50 集分派"
```

---

### Task 14: i18n key + SeriesPage 重接线 + 删 EpisodeDetail

**Files:**
- Modify: `web/src/library/SeriesPage.tsx`（编排 Hero+FactsRail+SeasonAccordion，删 selection/EpisodeDetail 右板分支）
- Delete: `web/src/library/EpisodeDetail.tsx`
- Modify: `web/src/library/SeriesPage.test.tsx`（删除"详情板开合"针对右侧面板的用例，改为断言行内展开走 SeasonAccordion/EpisodeRow）

> i18n key 已在 Task 9 Step 0 落齐，本任务不再动 i18n。

- [ ] **Step 2: 重写 SeriesPage 主体**

把 `SeriesPage.tsx` 的 `return`（成功分支，约 L171-219）主体替换为：删掉 `selection`/`selectedSeason`/`EpisodeDetail` 相关 state 与 JSX、删掉 `SeasonBlock`/`Legend` 内联组件里被 SeasonAccordion 取代的部分，改为：

```tsx
  const { series, seasons } = detail.data
  const title = series.chineseTitle ?? series.name
  const originalName = series.chineseTitle && series.chineseTitle !== series.name ? series.name : null
  const now = Date.now()
  // 顶部覆盖汇总喂 FactsRail：跨季合计
  const totals = seasons.reduce((acc, s) => {
    const t = tallyGridCells(buildGridCells(s, now))
    return { covered: acc.covered + t.covered, total: acc.total + t.total, embedded: acc.embedded + t.embedded }
  }, { covered: 0, total: 0, embedded: 0 })
  const langs = [...new Set(seasons.flatMap((s) => s.coverage.map((c) => c.lang)))].sort()

  return (
    <Section padding={4}>
      <VStack gap={6}>
        <SeriesHero name={title} originalName={originalName} year={series.year} seriesId={series.id}
          posterPath={series.posterPath} backdropPath={series.backdropPath} overview={series.overview} />
        {series.layoutNonstandard ? <Text type="supporting" color="secondary">{t('library_detail_layout_nonstandard')}</Text> : null}
        <FactsRail covered={totals.covered} total={totals.total} embedded={totals.embedded} langs={langs} />
        <VStack gap={6}>
          {seasons.map((season) => (<SeasonAccordion key={season.season} season={season} now={now} defaultOpen={seasons.length === 1} />))}
        </VStack>
      </VStack>
    </Section>
  )
```

更新 import：加 `SeriesHero`/`FactsRail`/`SeasonAccordion`/`tallyGridCells`/`buildGridCells`；删 `EpisodeCell`/`EpisodeDetail`/`seasonCoverageSentence`（后者移入 SeasonAccordion）/`isCanonicalPending`（移入）/`GridCell`/`Selection` 等已不用的。保留 loading/error/404 三态分支不动。

- [ ] **Step 3: 删 EpisodeDetail 组件**

```bash
git rm web/src/library/EpisodeDetail.tsx
```

移除 `styles.css` 里 `.library-detail-panel` / `.library-detail-close` 等仅右板用到的规则（`.library-detail-header-poster` 被 Hero 复用，保留）。

- [ ] **Step 4: 改 SeriesPage.test.tsx**

删掉 `describe('SeriesPage：详情板开合')` 整块（右侧面板已不存在）与其 `detailFixture`；新增一条走新结构的用例：

```ts
it('点击某集 → 行内展开该集 TMDB 简介（无右侧面板）', async () => {
  const detail: LibrarySeriesDetailDTO = {
    series: { ...baseSeries(), overview: null, backdropPath: null },
    seasons: [{ season: 1,
      canonical: [{ episode: 1, title: 'Pilot', overview: '哈蒙一家搬进凶宅', airDate: '2011-10-05', stillPath: null }],
      onDisk: [{ episode: 1, path: '/m/e1.mkv', subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] }],
      coverage: [] }],
  }
  renderPage(asyncData(detail))
  fireEvent.click(await screen.findByRole('button', { name: /Pilot/ }))
  expect(screen.getByText('哈蒙一家搬进凶宅')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument() // 无右侧面板
})
```

`baseSeries()` 增 `overview: null, backdropPath: null` 默认；其余现有用例（三层合成/覆盖句/layoutNonstandard/canonical 未建/三态）的 `series` fixture 同步补这两字段（TS 需要），断言按新结构微调（覆盖句现由 SeasonAccordion 渲染，文案不变仍可 findByText）。

- [ ] **Step 5: 跑全 web 套件 + tsc**

Run: `cd web && npx vitest run && npx tsc --noEmit`
Expected: 全 PASS，tsc 净

- [ ] **Step 6: 提交**

```bash
git add web/src/i18n/en.ts web/src/i18n/zh.ts web/src/library/SeriesPage.tsx web/src/library/SeriesPage.test.tsx web/src/styles.css
git commit -m "feat(web): SeriesPage 重接线（Hero+FactsRail+手风琴），删右侧 EpisodeDetail 面板"
```

---

## 收尾验收

### Task 15: 全栈回归 + 手测清单

- [ ] **Step 1: 全套件**

Run: `npm test && npm run check && cd web && npx vitest run && npx tsc --noEmit && cd ..`
Expected: root 全绿 + web 全绿 + 双端 tsc 净

- [ ] **Step 2: 手测清单（本地起 dev 或部署后）**
  - 有 backdrop 的剧：hero 背景图 + 渐变压暗 + 简介可读。
  - 无 backdrop 的剧：降级纯排印头部，不留灰空图。
  - 点某集 → 行内展开该集 TMDB 简介；再点收起；同一时刻至多一行开。
  - 内嵌集：行内 tag "内嵌"，展开区若无 overview 显示占位而非空白。
  - 超长季（国产剧 >50 集）：回落紧凑格阵，点格下方展开简介。
  - 右侧滑入面板确认已彻底消失。
  - 剧照开关：EpisodeRow 恒显剧照（本轮定稿为"开"，无 UI 开关；still 为 null 的行不显图）。

- [ ] **Step 3: 更新 roadmap 台账**：`docs/design/2026-07-20-post-deploy-roadmap.md` 标注 item B 完成。提交。
