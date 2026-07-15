import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { buildLibrary, buildSeriesDetail, buildRuns, sectionOf, commonRootDepth, buildParked, claimParked } from './apiV2.js'

let db: ScoutDb
let lib: LibraryRepo
const NOW = 1_700_000_000_000

function insertJob(
  db: ScoutDb,
  fields: { kind: 'series_season' | 'movie'; seriesId?: string; season?: number; movieId?: string; state: string; priority: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, state, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.kind,
      fields.seriesId ?? null,
      fields.season ?? null,
      fields.movieId ?? null,
      fields.state,
      fields.priority,
      NOW,
      NOW,
    )
  return Number(info.lastInsertRowid)
}

/** v3 worker_task job: series_id/season/movie_id land in their own COLUMNS (upsertWorkerTask's
 *  INSERT list, jobsRepo.ts) — payload only carries taskType/reason. Mirrors that shape here so
 *  tests exercise apiV2's dual-source queries against the real column/payload split, not a
 *  simplified stand-in. */
function insertWorkerTaskJob(
  db: ScoutDb,
  fields: { seriesId?: string; season?: number | null; movieId?: string; taskType: string; state: string; priority: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, payload, state, priority, created_at, updated_at)
       VALUES ('worker_task', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.seriesId ?? null,
      fields.season ?? null,
      fields.movieId ?? null,
      JSON.stringify({ taskType: fields.taskType, reason: 'test' }),
      fields.state,
      fields.priority,
      NOW,
      NOW,
    )
  return Number(info.lastInsertRowid)
}

function insertRun(db: ScoutDb, jobId: number, startedAt: number, decision: string, detail: string): void {
  db.prepare(
    `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(jobId, startedAt, startedAt + 1000, decision, detail, `/j/${startedAt}/decision.json`)
}

beforeEach(() => {
  db = openDb(':memory:')
  lib = new LibraryRepo(db)

  // Series A: 覆盖各态各一（路径在 /media/tv 下）
  lib.upsertSeries({ id: 's1', name: 'Series A', chineseTitle: '甲剧', posterPath: 'ptag-s1', year: 2021 })
  lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/tv/Series A/S01/e1.mkv', subStatus: 'covered' })
  lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/tv/Series A/S01/e2.mkv', subStatus: 'missing' })
  lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 1, episode: 3, name: 'E3', path: '/media/tv/Series A/S01/e3.mkv', subStatus: 'embedded' })
  lib.upsertEpisode({ id: 'e4', seriesId: 's1', season: 2, episode: 1, name: 'E4', path: '/media/tv/Series A/S02/e4.mkv', subStatus: 'unavailable' })

  // Movie Z（路径在 /media/movies 下）
  lib.upsertMovie({ id: 'm1', name: 'Movie Z', path: '/media/movies/Movie Z/z.mkv', subStatus: 'missing', posterPath: 'ptag-m1', year: 2019 })

  // Jobs: s1 season1 (searching, 100), movie m1 (wanted, 0)
  const seriesJobId = insertJob(db, { kind: 'series_season', seriesId: 's1', season: 1, state: 'searching', priority: 100 })
  insertJob(db, { kind: 'movie', movieId: 'm1', state: 'wanted', priority: 0 })

  // Two runs on the series job
  insertRun(db, seriesJobId, NOW - 2000, 'no_safe_match', '暂时没找到')
  insertRun(db, seriesJobId, NOW - 1000, 'download', '下好一集')
})

describe('buildLibrary', () => {
  it('聚合每剧覆盖计数 + 最新 job，电影单行', () => {
    const lib2 = buildLibrary(db)
    const series = lib2.find(x => x.id === 's1')!
    expect(series.kind).toBe('series')
    expect(series.name).toBe('Series A')
    expect(series.chineseTitle).toBe('甲剧')
    expect(series.year).toBe(2021)
    expect(series.posterPath).toBe('ptag-s1')
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 1, unavailable: 1 })
    expect(series.job).toEqual({ state: 'searching', priority: 100 })

    const movie = lib2.find(x => x.id === 'm1')!
    expect(movie.kind).toBe('movie')
    expect(movie.coverage).toEqual({ covered: 0, missing: 1, embedded: 0, unavailable: 0 })
    expect(movie.job).toEqual({ state: 'wanted', priority: 0 })
  })

  it('按库目录派生 section：tv→剧集、movies→电影', () => {
    const lib2 = buildLibrary(db)
    expect(lib2.find(x => x.id === 's1')!.section).toBe('剧集')
    expect(lib2.find(x => x.id === 'm1')!.section).toBe('电影')
  })

  it('无集数的孤儿剧 section 回退为其他', () => {
    lib.upsertSeries({ id: 's9', name: 'Orphan' })
    const item = buildLibrary(db).find(x => x.id === 's9')!
    expect(item.section).toBe('其他')
  })

  it('无 job 的条目 job=null', () => {
    lib.upsertSeries({ id: 's9', name: 'Orphan' })
    const item = buildLibrary(db).find(x => x.id === 's9')!
    expect(item.job).toBeNull()
    expect(item.coverage).toEqual({ covered: 0, missing: 0, embedded: 0, unavailable: 0 })
  })
})

describe('section 派生（纯函数）', () => {
  it('三种路径在同一媒体根下派生出各自分区', () => {
    const paths = [
      '/media/tv/Peacemaker/S01/e1.mkv',
      '/media/anime/Frieren/S01/e1.mkv',
      '/media/movies/The Matrix (1999)/matrix.mkv',
    ]
    const depth = commonRootDepth(paths) // /media → ['', 'media'] = 2
    expect(depth).toBe(2)
    expect(sectionOf(paths[0], depth)).toBe('剧集')
    expect(sectionOf(paths[1], depth)).toBe('动漫')
    expect(sectionOf(paths[2], depth)).toBe('电影')
  })

  it('未知目录名首字母大写原样展示；空路径→其他', () => {
    const paths = ['/srv/media/kids/Bluey/e1.mkv', '/srv/media/tv/Show/e1.mkv']
    const depth = commonRootDepth(paths) // /srv/media → 3
    expect(sectionOf('/srv/media/kids/Bluey/e1.mkv', depth)).toBe('Kids')
    expect(sectionOf('', depth)).toBe('其他')
  })
})

describe('buildSeriesDetail', () => {
  it('按季分节 + runs 经 job_id 关联本剧，desc 排序', () => {
    const detail = buildSeriesDetail(db, 's1')!
    expect(detail.name).toBe('Series A')
    expect(detail.chineseTitle).toBe('甲剧')
    expect(detail.seasons.map(s => s.season)).toEqual([1, 2])
    expect(detail.seasons[0].episodes.map(e => e.episode)).toEqual([1, 2, 3])
    expect(detail.seasons[0].episodes[1]).toMatchObject({ id: 'e2', subStatus: 'missing' })
    expect(detail.seasons[1].episodes[0]).toMatchObject({ id: 'e4', subStatus: 'unavailable' })
    // runs desc: 最近的 download 在前
    expect(detail.runs.map(r => r.decision)).toEqual(['download', 'no_safe_match'])
    expect(detail.runs[0].detail).toBe('下好一集')
  })

  it('未找到返回 null', () => {
    expect(buildSeriesDetail(db, 'nope')).toBeNull()
  })
})

// 退役 T2 (W0-3b)：双源过渡期——v3 worker_task job 也要驱动活动徽章/时间线，旧
// kind='series_season'/'movie' 行照常工作（双源叠加，不是替换）。
describe('活动/时间线双源兼容 worker_task（退役 T2）', () => {
  it('series 活动：v3 find_subtitle worker_task 反映为该剧的 job 状态', () => {
    lib.upsertSeries({ id: 's2', name: 'Series B' })
    insertWorkerTaskJob(db, { seriesId: 's2', season: 1, taskType: 'find_subtitle', state: 'searching', priority: 50 })
    const item = buildLibrary(db).find(x => x.id === 's2')!
    expect(item.job).toEqual({ state: 'searching', priority: 50 })
  })

  it('series 活动：v3 realign worker_task 同样反映为该剧的 job 状态', () => {
    lib.upsertSeries({ id: 's3', name: 'Series C' })
    insertWorkerTaskJob(db, { seriesId: 's3', season: null, taskType: 'realign', state: 'wanted', priority: 10 })
    const item = buildLibrary(db).find(x => x.id === 's3')!
    expect(item.job).toEqual({ state: 'wanted', priority: 10 })
  })

  it('movie 活动：movie 目标 worker_task 走 movie_id 列（非 payload）反映为该片 job 状态', () => {
    lib.upsertMovie({ id: 'm2', name: 'Movie Y', path: '/media/movies/Movie Y/y.mkv', subStatus: 'missing' })
    insertWorkerTaskJob(db, { movieId: 'm2', taskType: 'find_subtitle', state: 'searching', priority: 20 })
    const item = buildLibrary(db).find(x => x.id === 'm2')!
    expect(item.job).toEqual({ state: 'searching', priority: 20 })
  })

  it('runs 时间线：worker_task job 上的 v3 runs 行出现在 buildSeriesDetail 里', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', season: 1, taskType: 'find_subtitle', state: 'wanted', priority: 5 })
    insertRun(db, jobId, NOW, 'installed', '装好了')
    const detail = buildSeriesDetail(db, 's1')!
    expect(detail.runs.map(r => r.decision)).toContain('installed')
  })

  it('反例：orchestrate 类 worker_task 永不算作 series 活动，即使它是该 series_id 下最新的 job', () => {
    // s1 在 beforeEach 里已有一条 state=searching/priority=100 的 series_season job。这里插入
    // 一条 id 更大（更新）、taskType=orchestrate 的 worker_task——若过滤条件漏掉 taskType 排除，
    // max(id) 会把它错当"最新 job"顶替上去。
    insertWorkerTaskJob(db, { seriesId: 's1', season: null, taskType: 'orchestrate', state: 'wanted', priority: 999 })
    const item = buildLibrary(db).find(x => x.id === 's1')!
    expect(item.job).toEqual({ state: 'searching', priority: 100 })

    // self-scan 触发器用的合成 series_id 也不该冒出一条幽灵库行
    insertWorkerTaskJob(db, { seriesId: 'self-scan-trigger', season: null, taskType: 'orchestrate', state: 'wanted', priority: 1 })
    expect(buildLibrary(db).find(x => x.id === 'self-scan-trigger')).toBeUndefined()
  })

  it('回归：旧 kind 行在双源变更后照常工作（叠加，不是替换）', () => {
    const item = buildLibrary(db).find(x => x.id === 's1')!
    expect(item.job).toEqual({ state: 'searching', priority: 100 })
    const movie = buildLibrary(db).find(x => x.id === 'm1')!
    expect(movie.job).toEqual({ state: 'wanted', priority: 0 })
    const detail = buildSeriesDetail(db, 's1')!
    expect(detail.runs.map(r => r.decision)).toEqual(['download', 'no_safe_match'])
  })
})

// 去 Jellyfin 化 P6：park 救援页——一次性脚手架，不做搜索/候选/批量。
describe('buildParked / claimParked（P6 park 救援）', () => {
  it('buildParked 转发 listParkedPaths（first_seen desc），DTO 字段驼峰化', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW - 5000)
    lib.upsertParkedPath('/media/tv/Another Show/e1.mkv', 'no match', NOW - 1000)

    const parked = buildParked(db)
    expect(parked).toEqual([
      { path: '/media/tv/Another Show/e1.mkv', parkReason: 'no match', firstSeen: NOW - 1000, lastAttempt: NOW - 1000 },
      { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 5000, lastAttempt: NOW - 5000 },
    ])
  })

  it('claimParked：合法认领写入 identify_overrides，覆盖目标是 path 所在的目录（dirname），不是文件本身', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/S01/e1.mkv', 'ambiguous match', NOW)

    const result = claimParked(db, { path: '/media/tv/Unknown Show/S01/e1.mkv', tmdbId: '12345', isTv: true })
    expect(result).toEqual({ ok: true })

    // 目录前缀命中，兄弟集也会命中（最长前缀匹配）
    expect(lib.findOverride('/media/tv/Unknown Show/S01/e2.mkv')).toEqual({ tmdbId: '12345', isTv: true, season: null })
    expect(lib.findOverride('/media/tv/Unknown Show/S01/e1.mkv')).toEqual({ tmdbId: '12345', isTv: true, season: null })
  })

  // P7 disambiguation 补丁：可选 season 入参。
  it('claimParked：带 season 的认领原样写入 identify_overrides.season', () => {
    lib.upsertParkedPath('/media/TV/High School D×D/Hero - 01.mkv', 'no-signal', NOW)

    const result = claimParked(db, {
      path: '/media/TV/High School D×D/Hero - 01.mkv', tmdbId: '24240', isTv: true, season: 4,
    })
    expect(result).toEqual({ ok: true })
    expect(lib.findOverride('/media/TV/High School D×D/Hero - 01.mkv')).toEqual({
      tmdbId: '24240', isTv: true, season: 4,
    })
  })

  it('claimParked：拒绝非正整数 season（0/负数/小数）', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
    for (const bad of [0, -1, 1.5]) {
      const result = claimParked(db, { path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true, season: bad })
      expect(result).toEqual({ ok: false, error: expect.any(String) })
    }
    expect(lib.findOverride('/media/tv/Unknown Show/e1.mkv')).toBeNull()
  })

  it('claimParked：season 省略/null 等价——不指定即为未知（原有行为）', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
    const result = claimParked(db, { path: '/media/tv/Unknown Show/e1.mkv', tmdbId: '1', isTv: true, season: null })
    expect(result).toEqual({ ok: true })
    expect(lib.findOverride('/media/tv/Unknown Show/e1.mkv')).toEqual({ tmdbId: '1', isTv: true, season: null })
  })

  it('claimParked：认领不立即清 parked_paths——那一行等下一轮巡检 recognize 命中 override 后由摄取层自己清', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/S01/e1.mkv', 'ambiguous match', NOW)
    claimParked(db, { path: '/media/tv/Unknown Show/S01/e1.mkv', tmdbId: '12345', isTv: false })
    expect(lib.listParkedPaths().some(p => p.path === '/media/tv/Unknown Show/S01/e1.mkv')).toBe(true)
  })

  it('claimParked：拒绝空 path', () => {
    const result = claimParked(db, { path: '', tmdbId: '1', isTv: false })
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('claimParked：拒绝不在 parked_paths 里的 path（未挂 park 户口/已被清）', () => {
    const result = claimParked(db, { path: '/media/tv/Never Parked/e1.mkv', tmdbId: '1', isTv: false })
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('claimParked：拒绝非数字 tmdbId', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)
    const result = claimParked(db, { path: '/media/tv/Unknown Show/e1.mkv', tmdbId: 'abc', isTv: false })
    expect(result).toEqual({ ok: false, error: expect.any(String) })
    expect(lib.findOverride('/media/tv/Unknown Show/e1.mkv')).toBeNull()
  })
})

describe('buildRuns', () => {
  it('全局历史按 id desc，limit/offset 生效', () => {
    const all = buildRuns(db, 0, 50)
    expect(all.length).toBe(2)
    expect(all[0].decision).toBe('download') // 最近插入
    const page = buildRuns(db, 1, 50)
    expect(page.length).toBe(1)
    expect(page[0].decision).toBe('no_safe_match')
  })
})
