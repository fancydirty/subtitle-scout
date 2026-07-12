import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { buildLibrary, buildSeriesDetail, buildRuns, proxyPoster, sectionOf, commonRootDepth } from './apiV2.js'

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
  lib.upsertSeries({ id: 's1', name: 'Series A', chineseTitle: '甲剧', posterTag: 'ptag-s1', year: 2021 })
  lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/tv/Series A/S01/e1.mkv', subStatus: 'covered' })
  lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/tv/Series A/S01/e2.mkv', subStatus: 'missing' })
  lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 1, episode: 3, name: 'E3', path: '/media/tv/Series A/S01/e3.mkv', subStatus: 'embedded' })
  lib.upsertEpisode({ id: 'e4', seriesId: 's1', season: 2, episode: 1, name: 'E4', path: '/media/tv/Series A/S02/e4.mkv', subStatus: 'unavailable' })
  // needs_review 已从 v2/libraryRepo 的 SubStatus 类型中移除（Phase 6：human-review 判定链拔除），
  // 但 CHECK 约束仍容忍这个历史枚举值（YAGNI，不整表重建）——直接写 SQL 模拟一条存量遗留行，
  // 验证 apiV2 的覆盖计数在这种数据下仍不炸。
  db.prepare(
    `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('e5', 's1', 2, 2, 'E5', '/media/tv/Series A/S02/e5.mkv', 'needs_review', NOW)

  // Movie Z（路径在 /media/movies 下）
  lib.upsertMovie({ id: 'm1', name: 'Movie Z', path: '/media/movies/Movie Z/z.mkv', subStatus: 'missing', posterTag: 'ptag-m1', year: 2019 })

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
    expect(series.posterTag).toBe('ptag-s1')
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 1, unavailable: 1, needsReview: 1 })
    expect(series.job).toEqual({ state: 'searching', priority: 100 })

    const movie = lib2.find(x => x.id === 'm1')!
    expect(movie.kind).toBe('movie')
    expect(movie.coverage).toEqual({ covered: 0, missing: 1, embedded: 0, unavailable: 0, needsReview: 0 })
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
    expect(item.coverage).toEqual({ covered: 0, missing: 0, embedded: 0, unavailable: 0, needsReview: 0 })
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

describe('proxyPoster', () => {
  it('转发 URL 带 tag 与 quality，成功回 immutable 头', async () => {
    const calls: string[] = []
    const headers: Record<string, string>[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(String(url))
      headers.push(init.headers as Record<string, string>)
      return new Response(Buffer.from('IMG'), { status: 200, headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch

    const res = await proxyPoster('item-1', 'abc123', { baseUrl: 'http://jf.local', apiKey: 'SECRET', fetchImpl })
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('image/png')
    expect(res.cacheControl).toContain('immutable')
    expect(res.body).not.toBeNull()
    expect(calls[0]).toContain('/Items/item-1/Images/Primary')
    expect(calls[0]).toContain('tag=abc123')
    expect(calls[0]).toContain('quality=90')
    expect(calls[0]).toContain('maxWidth=400')
    // API key 走请求头，不出现在 URL 里
    expect(calls[0]).not.toContain('SECRET')
    expect(headers[0]['X-Emby-Token']).toBe('SECRET')
  })

  it('上游 404 → 404 且无 body', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    const res = await proxyPoster('item-1', undefined, { baseUrl: 'http://jf.local', apiKey: 'SECRET', fetchImpl })
    expect(res.status).toBe(404)
    expect(res.body).toBeNull()
  })

  it('上游异常 → 404', async () => {
    const fetchImpl = (async () => { throw new Error('network') }) as unknown as typeof fetch
    const res = await proxyPoster('item-1', 'x', { baseUrl: 'http://jf.local', apiKey: 'SECRET', fetchImpl })
    expect(res.status).toBe(404)
  })
})
