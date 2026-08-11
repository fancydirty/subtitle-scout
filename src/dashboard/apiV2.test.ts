import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import {
  buildLibrary, buildSeriesDetail, buildRuns, sectionOf, sectionForItem, commonRootDepth, buildParked, unexclude,
  buildSettings, buildDeploySettings, listMediaSubdirs, SETTINGS_KEYS, updateSettings, addMediaRoot,
  buildWorkflowPending, buildWorkflowPasses, buildWorkflowWorkers, buildLibrarySeriesDetail,
  buildTriage, redispatch, buildRunTrace, buildDormantTasks, dormantTargetLabel, buildLibraryMovieDetail,
} from './apiV2.js'
// 清算波 R-6（F9b）：用真实常量而不是陈旧字符串 'self-scan-trigger'（去 Jellyfin 化 T4 已
// 改名为 INGEST_ORCHESTRATE_SERIES_ID='ingest-trigger'）造 ingest 触发器的合成 series_id 测试行。
import { INGEST_ORCHESTRATE_SERIES_ID } from '../daemon/ingestTrigger.js'
import { traceBus } from '../core/traceBus.js'
// 接缝回归（2026-08-10）：lastScanAt 的**真写入者**。见下方 🔴 用例——这条 import 的存在
// 本身就是那个缺口的修补：此前本文件只手写 INSERT 复述键名，从不碰真正的写入方。
import { ScoutDaemonV2 } from '../v2/daemonV2.js'

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
  fields: {
    seriesId?: string; season?: number | null; movieId?: string; taskType: string; state: string; priority: number
    /** G5：buildWorkflowWorkers 的 payload.seasons 解析测试用——省略=payload 不带这个键
     *  （parseWorkerPayload 视作 null，同旧调用点行为不变）。 */
    seasons?: number[] | null
  },
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
      JSON.stringify(
        fields.seasons !== undefined
          ? { taskType: fields.taskType, seasons: fields.seasons, reason: 'test' }
          : { taskType: fields.taskType, reason: 'test' }
      ),
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
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 1, unavailable: 1, hardsubAssumed: 0, partial: 0 })
    expect(series.job).toEqual({ state: 'searching', priority: 100 })

    const movie = lib2.find(x => x.id === 'm1')!
    expect(movie.kind).toBe('movie')
    expect(movie.coverage).toEqual({ covered: 0, missing: 1, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 })
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

  // 验收修复轮一 Task V1（design §A，用户裁决）：分区判据元数据优先——genres 含 16
  // 即动漫，哪怕路径落在按目录名会派生成"剧集"的 /media/tv/ 下也照样归动漫。
  it('genres 含 16 → 动漫，覆盖路径派生（元数据优先于目录名）', () => {
    lib.upsertSeries({ id: 's-anime', name: 'Peacemaker', genres: [16, 35] })
    lib.upsertEpisode({
      id: 'e-anime', seriesId: 's-anime', season: 1, episode: 1, name: 'E1',
      path: '/media/tv/Peacemaker/S01/e1.mkv', subStatus: 'missing',
    })
    const item = buildLibrary(db).find(x => x.id === 's-anime')!
    expect(item.section).toBe('动漫')
  })

  it('genres 已富化但不含 16 → 剧集', () => {
    lib.upsertSeries({ id: 's-drama', name: 'Drama Show', genres: [18] })
    lib.upsertEpisode({
      id: 'e-drama', seriesId: 's-drama', season: 1, episode: 1, name: 'E1',
      path: '/media/anime/Drama Show/S01/e1.mkv', subStatus: 'missing',
    })
    const item = buildLibrary(db).find(x => x.id === 's-drama')!
    expect(item.section).toBe('剧集')
  })

  it('无 job 的条目 job=null', () => {
    lib.upsertSeries({ id: 's9', name: 'Orphan' })
    const item = buildLibrary(db).find(x => x.id === 's9')!
    expect(item.job).toBeNull()
    expect(item.coverage).toEqual({ covered: 0, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0 })
  })

  // Plan B Task 1: originLang + nativeAudio 两键
  it('series: originLang=null 未富化 → nativeAudio=false', () => {
    const item = buildLibrary(db).find(x => x.id === 's1')!
    expect(item.originLang).toBeNull()
    expect(item.nativeAudio).toBe(false)
  })

  it('series: originLang=zh 且默认 TARGET_LANGUAGES=zh → nativeAudio=true', () => {
    lib.upsertSeries({ id: 's-zh', name: 'Chinese Show', originLang: 'zh' })
    lib.upsertEpisode({ id: 'e-zh', seriesId: 's-zh', season: 1, episode: 1, name: 'E1', path: '/media/tv/Show/e1.mkv', subStatus: 'missing' })
    const item = buildLibrary(db).find(x => x.id === 's-zh')!
    expect(item.originLang).toBe('zh')
    expect(item.nativeAudio).toBe(true)
  })

  it('movie: originLang=en 且默认 TARGET_LANGUAGES=zh → nativeAudio=false（en 不在 originSkipLanguages）', () => {
    lib.upsertMovie({ id: 'm-en', name: 'English Movie', path: '/media/movies/Movie/m.mkv', subStatus: 'missing', originLang: 'en' })
    const item = buildLibrary(db).find(x => x.id === 'm-en')!
    expect(item.originLang).toBe('en')
    expect(item.nativeAudio).toBe(false)
  })

  it('movie: originLang=zh-CN（地区变体）→ langOf 规范化为 zh → nativeAudio=true', () => {
    lib.upsertMovie({ id: 'm-zhcn', name: 'Chinese Movie', path: '/media/movies/Movie/m.mkv', subStatus: 'missing', originLang: 'zh-CN' })
    const item = buildLibrary(db).find(x => x.id === 'm-zhcn')!
    expect(item.originLang).toBe('zh-CN')
    expect(item.nativeAudio).toBe(true)
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

  // 验收修复轮一 Task V1（design §A，用户裁决）：未知目录名不再首字母大写原样漏出——一律归
  // '其他'（处决 `_scout_realign_test` 式陌生目录名直接展示成分区标签的旧行为）。
  it('未知目录名一律归其他（不再原样漏出目录名）；空路径→其他', () => {
    const paths = ['/srv/media/kids/Bluey/e1.mkv', '/srv/media/tv/Show/e1.mkv']
    const depth = commonRootDepth(paths) // /srv/media → 3
    expect(sectionOf('/srv/media/kids/Bluey/e1.mkv', depth)).toBe('其他')
    expect(sectionOf('', depth)).toBe('其他')
  })
})

describe('sectionForItem（分区判据：元数据优先，spec §A）', () => {
  it('genres 含 16 → 动漫；不含 → 剧集；movie 条目恒 电影', () => {
    expect(sectionForItem('series', JSON.stringify([16, 35]), '/media/tv/Show/e1.mkv', 2)).toBe('动漫')
    expect(sectionForItem('series', JSON.stringify([35, 18]), '/media/anime/Show/e1.mkv', 2)).toBe('剧集')
    // movie 恒电影，genres 参数（movies 表没有这一列）与路径都不影响判定
    expect(sectionForItem('movie', null, '/media/anime/Movie/m.mkv', 2)).toBe('电影')
    expect(sectionForItem('movie', JSON.stringify([16]), '/media/tv/Movie/m.mkv', 2)).toBe('电影')
  })

  it('genres NULL → 路径派生兜底；路径也未知 → 其他（不再原样漏出目录名）', () => {
    expect(sectionForItem('series', null, '/media/tv/Show/e1.mkv', 2)).toBe('剧集')
    expect(sectionForItem('series', null, '/media/kids/Bluey/e1.mkv', 2)).toBe('其他')
    expect(sectionForItem('series', null, '', 2)).toBe('其他')
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

    // ingest 触发器用的合成 series_id 也不该冒出一条幽灵库行
    insertWorkerTaskJob(db, { seriesId: INGEST_ORCHESTRATE_SERIES_ID, season: null, taskType: 'orchestrate', state: 'wanted', priority: 1 })
    expect(buildLibrary(db).find(x => x.id === INGEST_ORCHESTRATE_SERIES_ID)).toBeUndefined()
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

// 去 Jellyfin 化 P6：park 救援页（认领动作已随两证据红线裁决退役，见 triageOps.ts 头注释——
// 只剩"看见待识别文件"这一份事实呈现）。
describe('buildParked（P6 park 救援清单）', () => {
  it('buildParked 转发 listParkedPaths（first_seen desc），DTO 字段驼峰化', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW - 5000)
    lib.upsertParkedPath('/media/tv/Another Show/e1.mkv', 'no match', NOW - 1000)

    const parked = buildParked(db)
    expect(parked).toEqual([
      { path: '/media/tv/Another Show/e1.mkv', parkReason: 'no match', firstSeen: NOW - 1000, lastAttempt: NOW - 1000 },
      { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW - 5000, lastAttempt: NOW - 5000 },
    ])
  })
})

describe('unexclude（救援R4b 特典翻案）', () => {
  it('合法翻案：excluded-extra 行 → 写豁免 + 退 park 户口', () => {
    const path = '/media/tv/Show/Show - NCOP01.mkv'
    lib.upsertParkedPath(path, 'excluded-extra', NOW)

    const result = unexclude(db, { path })
    expect(result).toEqual({ ok: true })
    expect(lib.isExtrasExempt(path)).toBe(true)
    // park 户口已退——下一轮 ingest 靠豁免跳过铁案重走识别流
    expect(lib.listParkedPaths().some((p) => p.path === path)).toBe(false)
  })

  it('拒绝空 path', () => {
    expect(unexclude(db, { path: '' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('拒绝不在 parked_paths 的 path', () => {
    expect(unexclude(db, { path: '/media/never/parked.mkv' })).toEqual({ ok: false, error: expect.any(String) })
  })

  it('拒绝 reason 非 excluded-extra 的行（只翻特典的案，不误退普通停车行）', () => {
    const path = '/media/tv/Show/e1.mkv'
    lib.upsertParkedPath(path, 'no match', NOW)
    const result = unexclude(db, { path })
    expect(result).toEqual({ ok: false, error: expect.any(String) })
    // 普通停车行原样保留，未被误退、未被误豁免
    expect(lib.listParkedPaths().some((p) => p.path === path)).toBe(true)
    expect(lib.isExtrasExempt(path)).toBe(false)
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

// dashboard G4：settings/deploy/fs 三个只读端点的纯函数底座。
describe('buildSettings（GET /api/v2/settings：白名单键，未设置=null）', () => {
  it('全部未设置时九键皆 null + engineEnabled 兜底为 true', () => {
    const settings = new SettingsRepo(db)
    expect(buildSettings(settings)).toEqual({
      target_languages: null, hardsub_mode: null, exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      // engine_enabled 未设置 → fail-open 兜底为 true（本任务 ③ 的布尔别名）。
      engineEnabled: true,
    })
  })

  it('已设置的键原样带出字符串值，其余仍为 null', () => {
    const settings = new SettingsRepo(db)
    settings.set('target_languages', 'zh,en', NOW)
    settings.set('hardsub_mode', 'aggressive', NOW)
    expect(buildSettings(settings)).toEqual({
      target_languages: 'zh,en', hardsub_mode: 'aggressive', exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      engineEnabled: true,
    })
  })

  it('白名单外的 key 不出现在 DTO 里（哪怕 repo 里真有这行）', () => {
    const settings = new SettingsRepo(db)
    settings.set('not_a_real_setting', 'sneaky', NOW)
    const dto = buildSettings(settings)
    expect(Object.keys(dto).sort()).toEqual([...SETTINGS_KEYS, 'engineEnabled'].sort())
  })
})

describe('settings · 启动面三键（spec A §4.4/§4.6）', () => {
  it('PUT 接受 engine_enabled/provider:SUBHD_ENABLED/provider:ZIMUKU_ENABLED 的 true/false', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    const r = updateSettings(repo, { engine_enabled: 'false', 'provider:SUBHD_ENABLED': 'true', 'provider:ZIMUKU_ENABLED': 'true' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.settings.engine_enabled).toBe('false')
      expect(r.settings['provider:SUBHD_ENABLED']).toBe('true')
    }
  })

  it('三键拒绝非 true/false 值（全有或全无）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(updateSettings(repo, { engine_enabled: 'yes' }, NOW).ok).toBe(false)
    expect(updateSettings(repo, { 'provider:ZIMUKU_ENABLED': '1' }, NOW).ok).toBe(false)
    expect(updateSettings(repo, { engine_enabled: 'true', 'provider:SUBHD_ENABLED': 'on' }, NOW).ok).toBe(false)
    expect(repo.get('engine_enabled')).toBeNull()   // 非法批次不落任何键
  })

  it('GET DTO 的 engineEnabled 布尔别名：null→true（fail-open）、false→false、脏值→true', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(buildSettings(repo).engineEnabled).toBe(true)
    repo.set('engine_enabled', 'false', NOW)
    expect(buildSettings(repo).engineEnabled).toBe(false)
    repo.set('engine_enabled', '0', NOW)
    expect(buildSettings(repo).engineEnabled).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-F15 缺口③：换目标语言 → 全库重判的**触发点**就在这里。
// 「谁触发」必须钉死在一条能跑通的链路上——本仓栽过 6 次「加了能力却没定谁写/谁读/谁触发」。
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 R-F15 · PUT target_languages 变更触发全库重判', () => {
  const seedJudged = (d: ScoutDb, needs: number, reason: string) => {
    d.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id,
                                  needs_subtitle, skip_reason, updated_at)
               VALUES ('/m/a.mkv','/m','a.mkv',1,1,'tmdb:1',?,?,1)`).run(needs, reason)
  }
  const judgedRow = (d: ScoutDb) =>
    d.prepare('SELECT needs_subtitle, skip_reason FROM files').get()

  it('🔴 值真的变了 → 全库 needs_subtitle/skip_reason 清 NULL（下轮 judge 自然重判）', () => {
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 0, 'origin-skip')
    expect(updateSettings(repo, { target_languages: 'en' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: null, skip_reason: null })
  })

  it('🔴 幂等：PUT 同一个值 → 不触发重判（判决列原样保留）', () => {
    // 设置页保存按钮把整个表单一起 PUT，同值反复提交是**常态**。每次都清全库判决 =
    // 每次点保存都让全库重跑一遍 judge，并把 sub_status 按同一批语言重导一遍——
    // 一个纯粹的无变化保存变成周期性全库写。只有真的变了才触发。
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 0, 'origin-skip')
    expect(updateSettings(repo, { target_languages: 'zh' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: 0, skip_reason: 'origin-skip' })
  })

  it('🔴 只改别的键（body 不含 target_languages）→ 不触发重判', () => {
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 1, 'missing')
    expect(updateSettings(repo, { hardsub_mode: 'aggressive' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: 1, skip_reason: 'missing' })
  })

  it('🔴 校验失败的批次 → 一列都不许动（全有或全无，重判也在同一个事务里）', () => {
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 0, 'embedded')
    expect(updateSettings(repo, { target_languages: 'en', hardsub_mode: 'bogus' }, NOW + 1).ok).toBe(false)
    expect(repo.get('target_languages')).toBe('zh')
    expect(judgedRow(d)).toEqual({ needs_subtitle: 0, skip_reason: 'embedded' })
  })

  it('🔴 等价写法归一：`zh,en` → `zh, en` 只是空白差异，不算变更（不触发重判）', () => {
    // zod 的正则不允许空格，但 settings 表里可能有历史脏值/别的写入路径的产物。
    // 用解析后的语言**列表**比较而不是裸字符串——比较的是"目标语言集合变没变"这个语义，
    // 不是"这个字符串的字节变没变"（字段名必须与真实含义逐字对应）。
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh, en', NOW)
    seedJudged(d, 1, 'missing')
    expect(updateSettings(repo, { target_languages: 'zh,en' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: 1, skip_reason: 'missing' })
  })
})

describe('媒体根路径形状（spec A §11-1：win32 绝对路径不冤杀）', () => {
  it('listMediaSubdirs/addMediaRoot 接受 C:\\ 形状进入存在性检查（POSIX 上诚实报不存在），相对路径仍拒', () => {
    expect(listMediaSubdirs('C:\\media')).toEqual({ ok: false, error: 'path does not exist' })
    expect(listMediaSubdirs('relative/path')).toEqual({ ok: false, error: 'path must be an absolute path' })
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(addMediaRoot(repo, 'D:/media', NOW)).toEqual({ ok: false, error: 'path does not exist' })
    expect(addMediaRoot(repo, 'media', NOW)).toEqual({ ok: false, error: 'path must be an absolute path' })
  })
})

describe('addMediaRoot 重叠校验（业界标准 overlapping-paths validation）', () => {
  // 真实目录（存在性检查在重叠检查之前，所以测试必须用磁盘上真的存在的路径）
  let tmp: string
  let child: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scout-roots-'))
    child = join(tmp, 'movies')
    mkdirSync(child)
  })

  it('已登记某根后，其子目录被拒（子树已在扫描范围内）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    repo.addRoot(tmp, NOW)
    const r = addMediaRoot(repo, child, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('already covered by media root')
      expect(r.error).toContain(tmp)
    }
  })

  it('已登记某根后，其父目录被拒（会把已有根重复扫一遍）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    repo.addRoot(child, NOW)
    const r = addMediaRoot(repo, tmp, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('contains existing media root')
      expect(r.error).toContain(child)
    }
  })

  it('重复提交同一路径仍幂等放行（既有 INSERT OR IGNORE 语义不变）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    repo.addRoot(tmp, NOW)
    expect(addMediaRoot(repo, tmp, NOW)).toEqual({ ok: true })
    expect(repo.listRoots()).toHaveLength(1)
  })

  it('同名前缀的兄弟目录不算重叠（/media/tv 不挡 /media/tv2）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    const tv = join(tmp, 'tv')
    const tv2 = join(tmp, 'tv2')
    mkdirSync(tv)
    mkdirSync(tv2)
    repo.addRoot(tv, NOW)
    expect(addMediaRoot(repo, tv2, NOW)).toEqual({ ok: true })
    expect(repo.listRoots()).toHaveLength(2)
  })
})

describe('buildDeploySettings（GET /api/v2/settings/deploy：env 脱敏只读）', () => {
  it('secrets 未配置 → present:false，tail 空', () => {
    const dto = buildDeploySettings({})
    expect(dto.secrets.TMDB_API_KEY).toEqual({ present: false, tail: '' })
    expect(dto.secrets.DASHBOARD_TOKEN).toEqual({ present: false, tail: '' })
  })

  it('secrets 已配置（≥4位）→ present:true，tail 是尾 4 位，不泄露其余部分', () => {
    const dto = buildDeploySettings({ TMDB_API_KEY: 'sk-abcdef1234567890' })
    expect(dto.secrets.TMDB_API_KEY).toEqual({ present: true, tail: '7890' })
    expect(JSON.stringify(dto)).not.toContain('abcdef')
  })

  it('secrets 短于 4 位 → 全遮（不直接回显短密钥的任何字符）', () => {
    const dto = buildDeploySettings({ DASHBOARD_TOKEN: 'ab' })
    expect(dto.secrets.DASHBOARD_TOKEN).toEqual({ present: true, tail: '**' })
  })

  it('非机密项原样字符串带出；未设置为 null', () => {
    const dto = buildDeploySettings({ LLM_BASE_URL: 'https://api.deepseek.com/v1', LLM_MODEL: 'deepseek-chat' })
    expect(dto.nonSecrets.LLM_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(dto.nonSecrets.LLM_MODEL).toBe('deepseek-chat')
    expect(dto.nonSecrets.DASHBOARD_PORT).toBeNull()
  })

  it('已知全部 secret key 枚举：TMDB/LLM/DASHBOARD/ASSRT/OpenSubtitles 均被覆盖', () => {
    const dto = buildDeploySettings({})
    const keys: (keyof typeof dto.secrets)[] = [
      'TMDB_API_KEY', 'LLM_API_KEY', 'DASHBOARD_TOKEN', 'ASSRT_TOKEN', 'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD',
    ]
    for (const key of keys) {
      expect(dto.secrets[key]).toBeDefined()
    }
  })
})

describe('listMediaSubdirs（GET /api/v2/fs/list：只列子目录名，绝不列文件/读内容）', () => {
  it('列出子目录名，按字典序排序，排除文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-list-'))
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    writeFileSync(join(root, 'not-a-dir.txt'), 'x')
    const result = listMediaSubdirs(root)
    expect(result).toEqual({ ok: true, dirs: ['alpha', 'zeta'] })
  })

  it('相对路径拒绝（4xx 语义：ok:false）', () => {
    const result = listMediaSubdirs('relative/path')
    expect(result.ok).toBe(false)
  })

  it('不存在的路径拒绝', () => {
    const result = listMediaSubdirs('/definitely/does/not/exist/on/this/machine')
    expect(result.ok).toBe(false)
  })

  it('路径指向文件（非目录）拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-list-file-'))
    const file = join(root, 'a-file.txt')
    writeFileSync(file, 'x')
    const result = listMediaSubdirs(file)
    expect(result.ok).toBe(false)
  })

  it('空目录 → dirs 空数组', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-list-empty-'))
    const result = listMediaSubdirs(root)
    expect(result).toEqual({ ok: true, dirs: [] })
  })

  // 复审修复 2：权限拒绝（EACCES，NAS 挂载常态）是用户点目录浏览器时的正常路况，必须收敛成
  // ok:false 的 4xx 语义，不能同步抛错炸到 server.ts 变 500。用 chmod 000 真实触发 readdirSync
  // 的 EACCES；root 用户不受权限位约束（chmod 000 后照样能读），该场景下跳过——CI 若以 root
  // 跑，这条护栏由 try/catch 的存在本身兜底，无需 mock fs 层来强行复现。
  it.skipIf(process.getuid?.() === 0)('无读权限的目录（EACCES）→ ok:false，不抛错', () => {
    const parent = mkdtempSync(join(tmpdir(), 'fs-list-eacces-'))
    const locked = join(parent, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      const result = listMediaSubdirs(locked)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/not readable/)
    } finally {
      chmodSync(locked, 0o755) // 恢复权限，让临时目录可被系统正常清理
    }
  })
})

// dashboard G5：workflow/library/甄别聚合 API——纯读聚合 + 两个人类扳手（redispatch/claim）。
// 北极星约束：全部走既有 repo/模块，不新增任何判断逻辑——机械层只产出事实。

describe('buildWorkflowPending（GET /api/v2/workflow/pending：missingBySeason/missingMovies/parked/meta 直译聚合）', () => {
  // 2026-07-31：巡检可观测性。此前巡检只在容器日志里打一行，界面完全看不见——
  // 一个"全是绿点"的库有两种可能（真没问题 / 巡检没在跑），用户无从分辨。
  it('meta 带字幕校验的新鲜度与推进度', () => {
    const settings = new SettingsRepo(db)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_verify_sweep_at', ?)`).run(String(NOW - 600_000))
    // 两条 covered（e1 已有结论、e2 还没）
    db.prepare(
      `INSERT INTO subtitle_verify (item_id, verdict, subtitle_path, checked_at) VALUES (?,?,?,?)`,
    ).run('e1', 'aligned', '/media/tv/a.srt', NOW)

    const r = buildWorkflowPending(db, settings, NOW)
    expect(r.meta.lastVerifySweepAt).toBe(NOW - 600_000)
    expect(r.meta.verifiedItems).toBe(1)
    // verifiableItems = sub_status='covered' 的条目总数，与 fixture 一致即可（>0）
    expect(r.meta.verifiableItems).toBeGreaterThan(0)
    expect(r.meta.verifiedItems).toBeLessThanOrEqual(r.meta.verifiableItems)
  })

  it('从未跑过巡检时 lastVerifySweepAt 为 null（不编造一个时刻）', () => {
    const settings = new SettingsRepo(db)
    const r = buildWorkflowPending(db, settings, NOW)
    expect(r.meta.lastVerifySweepAt).toBeNull()
    expect(r.meta.verifiedItems).toBe(0)
  })

  it('camelCase 直译 + meta 新鲜度行（roots/lastScanAt/files）', () => {
    // e4（s1 season2, unavailable）经 markUnavailable 建立真实退避窗口，制造 throttled 事实
    // （plain upsertEpisode 不落 recheck_after，NULL 比较恒 falsy，missingBySeason 两桶都是 0）。
    lib.markUnavailable('e4', 'no_safe_match', NOW)
    lib.upsertParkedPath('/media/tv/Unknown/e1.mkv', 'ambiguous match', NOW)
    const settings = new SettingsRepo(db)
    settings.addRoot('/media/tv', NOW)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW))

    const result = buildWorkflowPending(db, settings, NOW)

    const s1Season1 = result.series.find(s => s.seriesId === 's1' && s.season === 1)!
    expect(s1Season1).toMatchObject({ seriesName: 'Series A', missing: 1, throttled: 0 })

    const s1Season2 = result.series.find(s => s.seriesId === 's1' && s.season === 2)!
    expect(s1Season2.missing).toBe(0)
    expect(s1Season2.throttled).toBe(1)
    expect(s1Season2.nextRecheckAt).toBe(NOW + 86_400_000) // 阶梯第 1 档=1 天
    expect(s1Season2.sampleReason).toBe('no_safe_match')

    expect(result.movies).toEqual([
      { id: 'm1', name: 'Movie Z', missing: 1, throttled: 0, nextRecheckAt: null, sampleReason: null },
    ])
    expect(result.parked).toBe(1)
    expect(result.meta).toEqual({
      roots: ['/media/tv'], lastScanAt: NOW, files: 5, // episodes(4)+movies(1)
      // 2026-07-31 新增：巡检还没跑过 → null + 0；covered 计数来自 fixture
      lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: result.meta.verifiableItems,
    })
  })

  it('空库：series/movies 空数组，parked 0，lastScanAt null（meta 表从未写过 last_inspect_at）', () => {
    const freshDb = openDb(':memory:')
    const settings = new SettingsRepo(freshDb)
    const result = buildWorkflowPending(freshDb, settings, NOW)
    expect(result).toEqual({
      series: [], movies: [], parked: 0,
      meta: {
        roots: [], lastScanAt: null, files: 0,
        lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0,
      },
    })
  })

  // ---- 接缝回归：daemonV2 的写入侧 ↔ dashboard 的读取侧（2026-08-10）----
  //
  // 🔴 防的是：**dashboard 读一个没有任何写入者的 meta 键**，于是"上次扫描"恒为 null，
  //    前端 text.ts lastCheckedLine() 显示"还没扫过"——即使 daemonV2 每天都在正常巡检。
  //    这是一句主动的假话，且已在生产里存活了 5 个 commit（第 2 步 915f3ec 让 ScoutDaemon
  //    不再被构造起，它 tickInner 里那唯一的 `last_ingest_at` 写入点就成了死代码；第 7 步
  //    B 组 d9096ec 删掉的只是尸体）。
  //
  // 为什么之前没被发现：两侧各自都有测试且都是绿的——daemonV2 的用例自己 INSERT
  // 'last_inspect_at'、dashboard 的用例自己 INSERT 'last_ingest_at'，各自复述了一份键名。
  // **没有任何测试同时用真写入者和真读取者**，所以两份键名漂移成两个不同的字符串时，
  // 全套件 3000+ 条一条都不红。这条用例的全部价值就是跨过那道接缝：写入侧必须是真的
  // ScoutDaemonV2（不是手写 INSERT），读取侧必须是真的 buildWorkflowPending（不是手写
  // SELECT）。任何一侧再改键名，这里当场变红。
  it('🔴 daemonV2 真跑一轮巡检后，dashboard 的 lastScanAt 能读到它写的时刻（不再是恒 null 的假话）', async () => {
    const seamDb = openDb(':memory:')
    const settings = new SettingsRepo(seamDb)
    const emptyRoot = mkdtempSync(join(tmpdir(), 'scout-seam-'))
    settings.addRoot(emptyRoot, NOW)

    // 巡检前：从未跑过 → null。text.ts 的"绝不编一个时刻出来"在这里是**真话**。
    expect(buildWorkflowPending(seamDb, settings, NOW).meta.lastScanAt).toBeNull()

    // 真的 daemonV2、真的 run()：冷启动（读不到时间门 ⇒ 0）第一圈就巡检，成功即写键。
    // 守备目录是个空临时目录，巡检本身无事可做——本用例只关心那次写入被读取侧看见。
    const daemon = new ScoutDaemonV2({
      db: seamDb,
      roots: [emptyRoot],
      identify: {
        db: seamDb,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any },
      },
      subtitleWorker: async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }),
      targetLanguage: 'zh',
      probe: async () => null,
      probeDuration: async () => null,
      log: () => {},
      now: () => NOW,
    } as any)
    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise((r) => setTimeout(r, 50))
    ctrl.abort()
    await p

    // 巡检后：读取侧拿到的正是写入侧记的那个时刻（daemonV2 记的是巡检**开始**时刻 = NOW）。
    expect(buildWorkflowPending(seamDb, settings, NOW).meta.lastScanAt).toBe(NOW)
    seamDb.close()
  })
})

describe('buildWorkflowPasses（GET /api/v2/workflow/passes：orchestrate runs + receipts 从 trace_json 解析）', () => {
  function insertOrchestrateRun(
    jobId: number, startedAt: number, finishedAt: number, detail: string, traceJson: string | null,
  ): void {
    db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
       VALUES (?, ?, ?, 'orchestrate', ?, NULL, ?)`
    ).run(jobId, startedAt, finishedAt, detail, traceJson)
  }

  it('形状：id/jobId/startedAt/finishedAt/detail + receipts（2 created + 1 coalesced + 1 截断→unknown，非 dispatch_ 前缀不计入）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-1', taskType: 'orchestrate', state: 'done', priority: 0 })
    const events = [
      { runKey: `job-${jobId}`, seq: 0, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: '{"dispatched":true,"outcome":"created","remainingCapacity":99}', tookMs: 5, at: NOW },
      { runKey: `job-${jobId}`, seq: 1, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: '{"dispatched":true,"outcome":"created","remainingCapacity":98}', tookMs: 5, at: NOW + 1 },
      { runKey: `job-${jobId}`, seq: 2, tool: 'dispatch_realign_task', argsSummary: '{}', resultSummary: '{"dispatched":false,"outcome":"coalesced","pendingState":"wanted","note":"merged"}', tookMs: 5, at: NOW + 2 },
      // 模拟 summarizeForTrace 的 200 字符截断——outcome 值本身被切断，正则提不出完整枚举词。
      { runKey: `job-${jobId}`, seq: 3, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: '{"dispatched":false,"outcome":"blocked_dorm…', tookMs: 5, at: NOW + 3 },
      // spawn_sibling_orchestrator 不以 'dispatch_' 开头——即使自带 outcome 字段也不计入 receipts。
      { runKey: `job-${jobId}`, seq: 4, tool: 'spawn_sibling_orchestrator', argsSummary: '{}', resultSummary: '{"spawned":true,"outcome":"created"}', tookMs: 5, at: NOW + 4 },
    ]
    insertOrchestrateRun(jobId, NOW - 1000, NOW, 'dispatched 3 find / 0 realign, siblings 0: done', JSON.stringify(events))

    const passes = buildWorkflowPasses(db, 20)
    expect(passes).toHaveLength(1)
    expect(passes[0]).toMatchObject({ jobId, startedAt: NOW - 1000, finishedAt: NOW, detail: 'dispatched 3 find / 0 realign, siblings 0: done' })
    expect(passes[0].receipts).toEqual({ created: 2, revived: 0, coalesced: 1, blocked_dormant: 0, unknown: 1 })
  })

  it('trace_json 为 NULL → receipts 全零（不是新账目，纯解析呈现，无快照即无事实）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-2', taskType: 'orchestrate', state: 'done', priority: 0 })
    insertOrchestrateRun(jobId, NOW - 1000, NOW, 'no dispatches', null)
    const passes = buildWorkflowPasses(db, 20)
    expect(passes[0].receipts).toEqual({ created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 })
  })

  it('只取 decision=orchestrate 的行，finished_at desc（beforeEach 里两条非 orchestrate 的 runs 不出现）', () => {
    const jobId1 = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-3', taskType: 'orchestrate', state: 'done', priority: 0 })
    const jobId2 = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-4', taskType: 'orchestrate', state: 'done', priority: 0 })
    insertOrchestrateRun(jobId1, NOW - 5000, NOW - 4000, 'first', null)
    insertOrchestrateRun(jobId2, NOW - 3000, NOW - 1000, 'second', null)
    const passes = buildWorkflowPasses(db, 20)
    expect(passes.map(p => p.detail)).toEqual(['second', 'first'])
  })
})

describe('buildWorkflowWorkers（GET /api/v2/workflow/workers：跑中 worker_task + 近期非 orchestrate runs）', () => {
  // 2026-07-31 审计 C-3：held 必须自带名字与海报。此前前端靠 recent[] 按 jobId 反查——
  // 设计假设对（同一次收官连续写两边），但 held 停留天级、recent 是 20 条滑动窗口，
  // 生产节奏（每小时 20 条）下一小时内就被挤出 → 卡死态没图（违反 L4「必须有图」）+
  // 退化显示 tmdb:1396/s12e04 这种技术标识符（违反 L3「不暴露机械」）。
  it('held 自带 seriesName/posterPath/backdropPath，不依赖 recent 反查', () => {
    // 裸 SQL 造 held 行（同本文件既有 held 用例的手法）：series_id 指向 fixture 里的 s1，
    // 那一行有 name='Series A' 与 poster_path='ptag-s1'。
    const heldJobId = Number(db.prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, priority, last_error, next_retry_at, error_attempt, created_at, updated_at)
       VALUES ('worker_task', 's1', ?, 'failed', 0, 'extract failed', ?, 2, ?, ?)`,
    ).run(JSON.stringify({ taskType: 'find_subtitle', seriesId: 's1' }), NOW + 86_400_000, NOW, NOW)
      .lastInsertRowid)

    const r = buildWorkflowWorkers(db, NOW)
    const h = r.held.find((x) => x.jobId === heldJobId)!
    // 关键：recent 里没有这个 jobId（它从没走完一轮），名字与海报仍然要在——
    // 这正是一小时后的真实状态，旧的前端 join 在这里会 MISS。
    expect(r.recent.some((x) => x.jobId === heldJobId)).toBe(false)
    expect(h.seriesName).toBe('Series A')
    expect(h.posterPath).toBe('ptag-s1')
    expect('backdropPath' in h).toBe(true)
  })

  it('running：state=searching 的 worker_task，payload 解析出 taskType/seasons，trail 来自 traceBus.peek', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', season: null, taskType: 'find_subtitle', state: 'searching', priority: 50, seasons: [1, 2] })
    traceBus.publish({ runKey: `job-${jobId}`, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 1, at: NOW })

    const result = buildWorkflowWorkers(db, NOW)
    const running = result.running.find(r => r.jobId === jobId)!
    expect(running).toMatchObject({ seriesId: 's1', movieId: null, taskType: 'find_subtitle', seasons: [1, 2] })
    expect(running.trail.map(e => e.tool)).toEqual(['search_source'])
    traceBus.snapshot(`job-${jobId}`) // 测试卫生：清空本用例写入的进程级单例缓冲，不留给别的用例
  })

  // 回归锁（2026-08-01，实机盯页面发现 hero "已进行 N 秒" 秒表在屏上冻住不动）：
  // startedAtLease 必须锚定 **claim 时刻**，绝不能锚 jobs.updated_at——daemon 心跳每 tick 调
  // renewLease 把 updated_at 刷到 ~now，若 startedAtLease 取 updated_at，则 now-startedAtLease
  // 每次 15s 轮询后又缩回极小值，秒表在屏上冻结（看起来像卡死，恰好破掉这一屏"系统还活着"的
  // 唯一信号）。必须走真实的 upsertWorkerTask→claimNext→renewLease 链路复现——上面那些用
  // insertWorkerTaskJob 裸 SQL 造行的用例把 updated_at 硬编码成 NOW，claim 与续租发生在同一
  // 时刻，天然复刻不出"续租把锚点往前拖"这个 bug。
  it('running：startedAtLease 锚定 claim 时刻，不随 renewLease 心跳前移（秒表冻结回归锁）', () => {
    const jobs = new JobsRepo(db)
    const T0 = NOW
    jobs.upsertWorkerTask(
      { seriesId: 's1', season: null, movieId: null },
      { taskType: 'find_subtitle', reason: 'x' },
      null,
      T0,
    )
    const claimed = jobs.claimNext(T0, { onlyTaskType: 'find_subtitle' })!
    expect(claimed.state).toBe('searching')

    // daemon 跑了 5 分钟，其间心跳续租刷了 lease_until + updated_at（生产每 tick 都发生）。
    const T5 = T0 + 5 * 60_000
    jobs.renewLease(claimed.id, T5)

    // 此刻页面轮询（now=T5）：秒表该读"已进行 5 分"——startedAtLease 必须是 T0（claim 时刻），
    // 不是 T5（最近一次续租时刻）。锚 updated_at 时这里会读到 T5，秒表归零。
    const running = buildWorkflowWorkers(db, T5).running.find(r => r.jobId === claimed.id)!
    expect(running.startedAtLease).toBe(T0)
  })

  it('recent：非 orchestrate 的 runs 行，finished_at desc（beforeEach 已插入 no_safe_match/download 两条）', () => {
    const result = buildWorkflowWorkers(db, NOW)
    expect(result.recent.map(r => r.decision)).toEqual(['download', 'no_safe_match'])
  })

  // R2D-1（R2 复审）：worker run 详情入口需要 runs.id（打开 RunDetail 的身份键——用它而不是
  // jobId 当 React key/请求参数，同一个 job 可能有多行 runs）+ 该 job 关联的 series_id/movie_id
  // （Rerun 按钮判断是否可用）。beforeEach 里的两条 runs 都挂在 kind='series_season'、
  // series_id='s1' 的 job 上。
  it('recent：每行带 runs.id 与该 job 的 seriesId/movieId（LEFT JOIN jobs）', () => {
    const result = buildWorkflowWorkers(db, NOW)
    expect(result.recent.every(r => typeof r.id === 'number')).toBe(true)
    // 两条 id 各不相同（各自一行 runs，不是同一行重复出现）
    expect(new Set(result.recent.map(r => r.id)).size).toBe(result.recent.length)
    expect(result.recent.every(r => r.seriesId === 's1' && r.movieId === null)).toBe(true)
  })

  it('recent：job_id 为 NULL 的行（理论边界）时 seriesId/movieId 降级 null，不炸查询', () => {
    db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
       VALUES (NULL, ?, ?, 'error', 'no job', '/j/orphan/decision.json')`
    ).run(NOW - 500, NOW - 400)
    const result = buildWorkflowWorkers(db, NOW)
    const orphan = result.recent.find(r => r.jobId === null)!
    expect(orphan).toMatchObject({ seriesId: null, movieId: null })
  })

  // R2D-13（R2 复审）：realign 字幕先行阶段逐集起 `job-${jobId}-${absoluteEpisode}` runKey——
  // 单 runKey 的 traceBus.peek(`job-${jobId}`, ...) 永远拿不到这些子集事件，Workflow 页 realign
  // WorkerCard 因此直播空转。taskType==='realign' 时改用 peekPrefix 合并读全部子集缓冲。
  it('running：taskType=realign 时 trail 用 peekPrefix 合并逐集 job-${jobId}-${ep} 缓冲', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's2', season: null, taskType: 'realign', state: 'searching', priority: 50 })
    traceBus.publish({ runKey: `job-${jobId}-3`, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 1, at: NOW })
    traceBus.publish({ runKey: `job-${jobId}-7`, seq: 0, tool: 'get_candidate', argsSummary: '{}', resultSummary: '{}', tookMs: 2, at: NOW + 1 })
    // 单一 runKey `job-${jobId}`（没有子集号）不该混进来干扰断言，但也不该被 peekPrefix 漏掉的
    // 相邻 job 前缀污染——这里只发子集事件，验证 peekPrefix 真的把两条都收拢。

    const result = buildWorkflowWorkers(db, NOW)
    const running = result.running.find(r => r.jobId === jobId)!
    expect(running.taskType).toBe('realign')
    expect(running.trail.map(e => e.tool)).toEqual(['search_source', 'get_candidate'])

    traceBus.snapshotPrefix(`job-${jobId}-`) // 测试卫生：排空本用例写入的进程级单例缓冲
  })

  it('running：taskType=find_subtitle 时 trail 维持 peek 原样（不受同名前缀子集事件影响）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's3', season: null, taskType: 'find_subtitle', state: 'searching', priority: 50 })
    traceBus.publish({ runKey: `job-${jobId}`, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 1, at: NOW })

    const result = buildWorkflowWorkers(db, NOW)
    const running = result.running.find(r => r.jobId === jobId)!
    expect(running.trail.map(e => e.tool)).toEqual(['search_source'])

    traceBus.snapshot(`job-${jobId}`)
  })

  it('空库：running/recent 皆空数组、installedLast24h=0', () => {
    const freshDb = openDb(':memory:')
    expect(buildWorkflowWorkers(freshDb, NOW)).toEqual({ running: [], recent: [], installedLast24h: 0, translatedLast24h: 0, held: [], providerQuota: [] })
  })

  // 验收修复轮一 Task V3（design §B）：recent 行的剧名/片名——LEFT JOIN series/movies 取 name，
  // 空名（P6 认领占位/尚未富化）诚实降级为 null，不假装有名字。
  it('recent：行带 seriesName/movieName（LEFT JOIN series/movies 取 name，空名→null）', () => {
    // beforeEach 的两条 runs 挂在 series_id='s1' 的 job 上，s1.name='Series A'。
    const withSeriesName = buildWorkflowWorkers(db, NOW)
    expect(withSeriesName.recent.every(r => r.seriesName === 'Series A' && r.movieName === null)).toBe(true)

    // 空名剧（P6 认领占位式）——诚实降级为 null，不原样吐空串。
    lib.upsertSeries({ id: 's-empty', name: '' })
    const emptyJobId = insertJob(db, { kind: 'series_season', seriesId: 's-empty', season: 1, state: 'wanted', priority: 0 })
    insertRun(db, emptyJobId, NOW - 300, 'installed', 'empty name series')
    const result = buildWorkflowWorkers(db, NOW)
    const emptyRow = result.recent.find(r => r.jobId === emptyJobId)!
    expect(emptyRow.seriesName).toBeNull()

    // movie 目标：LEFT JOIN movies 取 name（beforeEach 已占用 m1 的 jobs_identity 身份，这里
    // 新开一部电影避免撞车）。
    lib.upsertMovie({ id: 'm2', name: 'Movie Y', path: '/media/movies/Movie Y/y.mkv', subStatus: 'missing' })
    const movieJobId = insertJob(db, { kind: 'movie', movieId: 'm2', state: 'wanted', priority: 0 })
    insertRun(db, movieJobId, NOW - 200, 'installed', 'movie installed')
    const movieResult = buildWorkflowWorkers(db, NOW)
    const movieRow = movieResult.recent.find(r => r.jobId === movieJobId)!
    expect(movieRow).toMatchObject({ seriesName: null, movieName: 'Movie Y' })
  })

  // 活动页铁律「必须有图」：running/recent 两个 DTO 都带 posterPath/backdropPath（从已 LEFT JOIN
  // 上的 series/movies 多 SELECT 两列，不新增查询）。
  it('running/recent：series 条目带出 posterPath 与 backdropPath', () => {
    // s1 已在 beforeEach 建行（posterPath='ptag-s1'）；补 backdrop（upsertSeries 的 COALESCE
    // 语义允许后续调用补齐既有行的空列）。
    lib.upsertSeries({ id: 's1', name: 'Series A', posterPath: 'ptag-s1', backdropPath: 'btag-s1', year: 2021 })
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', season: null, taskType: 'find_subtitle', state: 'searching', priority: 50 })

    const result = buildWorkflowWorkers(db, NOW)
    const running = result.running.find(r => r.jobId === jobId)!
    expect(running).toMatchObject({ posterPath: 'ptag-s1', backdropPath: 'btag-s1' })
    // recent：beforeEach 的两条 runs 挂在 series_id='s1' 的 job 上
    expect(result.recent.every(r => r.posterPath === 'ptag-s1' && r.backdropPath === 'btag-s1')).toBe(true)
  })

  // 不对称的回归锁（见 WorkflowRunningWorkerDTO.posterPath 注释）：`movies` 表没有 backdrop_path
  // 列（src/v2/db.ts 只给 series 加过），所以 movie 目标的 backdropPath 恒为 null——前端据此走
  // 「模糊海报当背景」的降级路径。若哪天有人给 movie 也变出了 backdrop，这条必须变红。
  it('running/recent：movies 条目带出 posterPath，且 backdropPath 恒为 null（表无此列的不对称）', () => {
    // m1 已在 beforeEach 建行（posterPath='ptag-m1'）
    const jobId = insertWorkerTaskJob(db, { movieId: 'm1', taskType: 'find_subtitle', state: 'searching', priority: 50 })

    const result = buildWorkflowWorkers(db, NOW)
    const running = result.running.find(r => r.jobId === jobId)!
    expect(running).toMatchObject({ movieName: 'Movie Z', posterPath: 'ptag-m1', backdropPath: null })

    // recent 侧同款（新开一部电影，避开 m1 的 jobs_identity 身份占用）
    lib.upsertMovie({ id: 'm3', name: 'Movie W', path: '/media/movies/Movie W/w.mkv', subStatus: 'missing', posterPath: 'ptag-m3' })
    const movieJobId = insertJob(db, { kind: 'movie', movieId: 'm3', state: 'wanted', priority: 0 })
    insertRun(db, movieJobId, NOW - 200, 'installed', 'movie installed')
    const recentRow = buildWorkflowWorkers(db, NOW).recent.find(r => r.jobId === movieJobId)!
    expect(recentRow).toMatchObject({ movieName: 'Movie W', posterPath: 'ptag-m3', backdropPath: null })
  })

  it('running/recent：LEFT JOIN 两边都未命中时 posterPath/backdropPath 皆 null，不崩', () => {
    // series_id/movie_id 都为 NULL 的 worker_task（name 也查无的那种行）
    const jobId = insertWorkerTaskJob(db, { taskType: 'find_subtitle', state: 'searching', priority: 50 })
    // recent 侧：job_id 为 NULL 的孤儿 run
    db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
       VALUES (NULL, ?, ?, 'error', 'no job', '/j/orphan-img/decision.json')`
    ).run(NOW - 500, NOW - 400)

    const result = buildWorkflowWorkers(db, NOW)
    const running = result.running.find(r => r.jobId === jobId)!
    expect(running).toMatchObject({ seriesName: null, movieName: null, posterPath: null, backdropPath: null })
    const orphan = result.recent.find(r => r.jobId === null)!
    expect(orphan).toMatchObject({ seriesName: null, movieName: null, posterPath: null, backdropPath: null })
  })

  // installedLast24h：runs 里 decision='installed' 且 finished_at > now-86400e3 的计数——独立
  // COUNT 查询，now 由调用方传入（沿 buildWorkflowPending 的既有 now 传参先例）。
  it('installedLast24h：仅计入 24h 窗口内 decision=installed 的行，窗口外/其它 decision 不计', () => {    const dayMs = 86_400_000
    // season: 2（beforeEach 已占用 season 1 的 jobs_identity 身份，这里避免撞车）
    const jobId = insertJob(db, { kind: 'series_season', seriesId: 's1', season: 2, state: 'wanted', priority: 0 })
    // 窗口内两条 installed
    insertRun(db, jobId, NOW - 1000, 'installed', 'in window 1')
    insertRun(db, jobId, NOW - 2000, 'installed', 'in window 2')
    // 窗口外一条 installed（超过 24h）
    insertRun(db, jobId, NOW - dayMs - 5000, 'installed', 'outside window')
    // 窗口内但非 installed
    insertRun(db, jobId, NOW - 1500, 'no_safe_match', 'in window but not installed')

    const result = buildWorkflowWorkers(db, NOW)
    expect(result.installedLast24h).toBe(2)
  })

  it('UX-P0:recent 行透传 llmCalls(runs.llm_calls),translatedLast24h 独立计数,held 队列只收未来重试行', () => {
    const dayMs = 86_400_000
    const jobId = insertJob(db, { kind: 'series_season', seriesId: 's1', season: 2, state: 'wanted', priority: 0 })
    insertRun(db, jobId, NOW - 1000, 'installed', 'find')
    // 窗口内两条 translate:installed(带 llm_calls);窗口外一条不计
    const r1 = db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, llm_calls) VALUES (?, ?, ?, 'translate:installed', 'ww e02', 58)`,
    ).run(jobId, NOW - 3000, NOW - 2500)
    db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, llm_calls) VALUES (?, ?, ?, 'translate:installed', 'ww e07', 44)`,
    ).run(jobId, NOW - 2000, NOW - 1500)
    db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, llm_calls) VALUES (?, ?, ?, 'translate:installed', 'old', 30)`,
    ).run(jobId, NOW - dayMs - 9000, NOW - dayMs - 8000)

    // held 三态:未来重试(收)/已过期(不收)/非 worker_task(不收)
    const heldJobId = Number(db.prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, priority, last_error, next_retry_at, error_attempt, created_at, updated_at)
       VALUES ('worker_task', 'translate:tmdb:1/s1e1', ?, 'failed', 0, 'translate held: term conformance 62.7%', ?, 3, ?, ?)`,
    ).run(JSON.stringify({ taskType: 'translate', itemId: 'tmdb:1/s1e1' }), NOW + dayMs, NOW, NOW).lastInsertRowid)
    db.prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, priority, last_error, next_retry_at, error_attempt, created_at, updated_at)
       VALUES ('worker_task', 'translate:tmdb:1/s1e2', ?, 'failed', 0, 'x', ?, 1, ?, ?)`,
    ).run(JSON.stringify({ taskType: 'translate', itemId: 'tmdb:1/s1e2' }), NOW - 1000, NOW, NOW)
    insertJob(db, { kind: 'series_season', seriesId: 's1', season: 3, state: 'failed', priority: 0 })
    db.prepare(`UPDATE jobs SET next_retry_at = ? WHERE kind = 'series_season' AND season = 3`).run(NOW + dayMs)

    const result = buildWorkflowWorkers(db, NOW)
    expect(result.translatedLast24h).toBe(2)
    const llmRow = result.recent.find((r) => r.detail === 'ww e02')
    expect(llmRow?.llmCalls).toBe(58)
    expect(result.held).toHaveLength(1)
    expect(result.held[0]).toMatchObject({
      jobId: heldJobId, itemId: 'tmdb:1/s1e1', errorAttempt: 3,
    })
    expect(result.held[0].reason).toContain('62.7%')
  })

  // 债务 D3：provider 配额事实从 settings 旁路键 quota_state_* 读取，过滤已过期/非法值。
  describe('buildWorkflowWorkers · providerQuota', () => {
    it('未过期键出现在 providerQuota', () => {
      const settings = new SettingsRepo(db)
      settings.set('quota_state_opensubtitles', JSON.stringify({ resetAt: '2026-01-01T00:00:00Z', observedAt: NOW - 1000 }), NOW)

      const result = buildWorkflowWorkers(db, NOW)

      expect(result.providerQuota).toEqual([
        { provider: 'opensubtitles', resetAt: '2026-01-01T00:00:00Z', observedAt: NOW - 1000 },
      ])
    })

    it('resetAt 已过期（早于 now）的键不出现', () => {
      const settings = new SettingsRepo(db)
      settings.set('quota_state_opensubtitles', JSON.stringify({ resetAt: '2020-01-01T00:00:00Z', observedAt: NOW - 1000 }), NOW)

      const result = buildWorkflowWorkers(db, NOW)

      expect(result.providerQuota).toEqual([])
    })

    it('值为垃圾字符串的键不出现、不炸端点', () => {
      const settings = new SettingsRepo(db)
      settings.set('quota_state_opensubtitles', '{not valid json', NOW)

      const result = buildWorkflowWorkers(db, NOW)

      expect(result.providerQuota).toEqual([])
    })

    it('无 quota_state_* 键时 providerQuota 为空数组', () => {
      const freshDb = openDb(':memory:')
      const result = buildWorkflowWorkers(freshDb, NOW)
      expect(result.providerQuota).toEqual([])
    })
  })
})

describe('buildRunTrace（GET /api/v2/workflow/runs/:id/trace：单 run 痕迹快照回放，F4）', () => {
  it('trace_json 携带事件 → 原样解析成 events 数组', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', taskType: 'find_subtitle', state: 'done', priority: 0 })
    const events = [
      { runKey: `job-${jobId}`, seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: NOW },
      { runKey: `job-${jobId}`, seq: 1, tool: 'get_candidate', argsSummary: '#3', resultSummary: 'fileList 22 entries', tookMs: 400, at: NOW + 1 },
    ]
    const runId = Number(
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'download', 'ok', NULL, ?)`
      ).run(jobId, NOW - 1000, NOW, JSON.stringify(events)).lastInsertRowid
    )

    expect(buildRunTrace(db, runId)).toEqual({ events })
  })

  it('trace_json 为 NULL → events:[]（run 行本身存在，只是没留下痕迹快照）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', taskType: 'find_subtitle', state: 'done', priority: 0 })
    const runId = Number(
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'download', 'ok', NULL, NULL)`
      ).run(jobId, NOW - 1000, NOW).lastInsertRowid
    )
    expect(buildRunTrace(db, runId)).toEqual({ events: [] })
  })

  it('trace_json 解析失败（脏数据）→ events:[]，不炸整个端点', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', taskType: 'find_subtitle', state: 'done', priority: 0 })
    const runId = Number(
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'download', 'ok', NULL, ?)`
      ).run(jobId, NOW - 1000, NOW, '{not valid json').lastInsertRowid
    )
    expect(buildRunTrace(db, runId)).toEqual({ events: [] })
  })

  it('行不存在 → null（router.ts 映射 404）', () => {
    expect(buildRunTrace(db, 999_999)).toBeNull()
  })
})

describe('buildLibrarySeriesDetail（GET /api/v2/library/series/:id：三层格阵合并——canonical ∪ 磁盘）', () => {
  beforeEach(() => {
    // season1 多一集只在 TMDB 应有集里（磁盘没有）；season3 纯 canonical（磁盘完全没有这季）。
    const insertCatalog = db.prepare(
      `INSERT INTO tmdb_seasons (series_id, season, episode, title, fetched_at) VALUES (?, ?, ?, ?, ?)`
    )
    insertCatalog.run('s1', 1, 1, 'Ep1 Title', NOW)
    insertCatalog.run('s1', 1, 4, 'Ep4 Title', NOW)
    insertCatalog.run('s1', 3, 1, 'S3E1 Title', NOW)
    db.prepare(
      `INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run('e1', '/media/tv/Series A/S01/e1.zh-Hans.srt', 'zh-Hans', 'scout-download', NOW)
  })

  // 2026-07-30（字幕校验）：onDisk 必须带 episodes.id。校验结论按 item_id 索引，
  // 前端不给 itemId 就无从关联——此前 DTO 只有 episode 号 + path，芯片压根接不上。
  it('onDisk 每条带 itemId（= episodes.id），前端据此查校验结论', () => {
    const detail = buildLibrarySeriesDetail(db, 's1')!
    const all = detail.seasons.flatMap((sn) => sn.onDisk)
    expect(all.length).toBeGreaterThan(0)
    for (const ep of all) {
      expect(typeof ep.itemId).toBe('string')
      expect(ep.itemId.length).toBeGreaterThan(0)
    }
    // 与库里的真实 id 对得上（不是编出来的）
    const ids = new Set(all.map((e) => e.itemId))
    expect(ids.has('e1')).toBe(true)
  })

  it('形状：series 行直译 + 季号并集升序 + 各季 canonical/onDisk/coverage', () => {
    const detail = buildLibrarySeriesDetail(db, 's1')!
    expect(detail.series).toEqual({
      id: 's1', name: 'Series A', chineseTitle: '甲剧', posterPath: 'ptag-s1', overview: null, backdropPath: null, year: 2021, layoutNonstandard: false,
    })
    expect(detail.seasons.map(s => s.season)).toEqual([1, 2, 3]) // 并集：磁盘{1,2} ∪ canonical{1,3}

    const season1 = detail.seasons[0]
    expect(season1.canonical).toEqual([
      { episode: 1, title: 'Ep1 Title', overview: null, airDate: null, stillPath: null },
      { episode: 4, title: 'Ep4 Title', overview: null, airDate: null, stillPath: null },
    ])
    expect(season1.onDisk.map(e => e.episode)).toEqual([1, 2, 3])
    expect(season1.onDisk[1]).toMatchObject({ episode: 2, subStatus: 'missing', statusReason: null, recheckAfter: null })
    expect(season1.coverage).toEqual([{ episode: 1, lang: 'zh-Hans', path: '/media/tv/Series A/S01/e1.zh-Hans.srt' }])

    const season2 = detail.seasons[1]
    expect(season2.canonical).toEqual([]) // 该季无 TMDB 缓存
    expect(season2.onDisk.map(e => e.episode)).toEqual([1])
    expect(season2.coverage).toEqual([])

    const season3 = detail.seasons[2]
    expect(season3.canonical).toEqual([{ episode: 1, title: 'S3E1 Title', overview: null, airDate: null, stillPath: null }])
    expect(season3.onDisk).toEqual([]) // 磁盘完全没有这季
    expect(season3.coverage).toEqual([])
  })

  it('series 不存在 → null（404 语义）', () => {
    expect(buildLibrarySeriesDetail(db, 'nope')).toBeNull()
  })

  // 详情页重设计 item B：series.overview/backdropPath + 逐集 canonical overview/airDate/stillPath 透传。
  it('buildLibrarySeriesDetail 出参带 series.overview/backdropPath 与逐集 canonical overview/airDate/stillPath', () => {
    const db2 = openDb(':memory:')
    db2.prepare(`INSERT INTO series (id, name, overview, backdrop_path) VALUES ('tmdb:9','S','ov','/bd.jpg')`).run()
    db2.prepare(`INSERT INTO tmdb_seasons (series_id, season, episode, title, overview, air_date, still_path, fetched_at) VALUES ('tmdb:9',1,1,'E1','eov','2011-10-05','/s1.jpg',1)`).run()
    const dto = buildLibrarySeriesDetail(db2, 'tmdb:9')!
    expect(dto.series.overview).toBe('ov')
    expect(dto.series.backdropPath).toBe('/bd.jpg')
    expect(dto.seasons[0].canonical[0]).toEqual({ episode: 1, title: 'E1', overview: 'eov', airDate: '2011-10-05', stillPath: '/s1.jpg' })
  })
})

describe('buildTriage（GET /api/v2/triage：pending=buildParked——认领半边已退役）', () => {
  it('形状：pending 转发 buildParked（含 reason）', () => {
    lib.upsertParkedPath('/media/tv/Unknown Show/e1.mkv', 'ambiguous match', NOW)

    const triage = buildTriage(db)
    expect(triage).toEqual({
      pending: [
        { path: '/media/tv/Unknown Show/e1.mkv', parkReason: 'ambiguous match', firstSeen: NOW, lastAttempt: NOW },
      ],
    })
  })

  it('空表：pending 空数组', () => {
    const freshDb = openDb(':memory:')
    expect(buildTriage(freshDb)).toEqual({ pending: [] })
  })
})

describe('redispatch（POST /api/v2/workflow/redispatch：转调 upsertWorkerTask，与 dispatch_find_subtitle_task 工具逐字段同形）', () => {
  it('合法 body → upsertWorkerTask({seriesId,season:null,movieId:null},{taskType:find_subtitle,...})，原样返回四态回执', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: 's1', seasons: [1, 2], includeThrottled: true }, NOW)
    expect(result).toEqual({ ok: true, outcome: { outcome: 'created' } })

    const row = db.prepare(`SELECT series_id, season, movie_id, payload FROM jobs WHERE kind = 'worker_task'`).get() as
      { series_id: string | null; season: number | null; movie_id: string | null; payload: string | null }
    expect(row.series_id).toBe('s1')
    expect(row.season).toBeNull()
    expect(row.movie_id).toBeNull()
    expect(JSON.parse(row.payload!)).toEqual({
      taskType: 'find_subtitle', seasons: [1, 2], reason: 'manual redispatch from dashboard', includeThrottled: true,
    })
  })

  it('省略 seasons/includeThrottled → seasons:null，includeThrottled:false（同 dispatch 工具默认）', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: 's2' }, NOW)
    expect(result).toEqual({ ok: true, outcome: { outcome: 'created' } })
    const row = db.prepare(`SELECT payload FROM jobs WHERE series_id = 's2'`).get() as { payload: string }
    expect(JSON.parse(row.payload)).toEqual({
      taskType: 'find_subtitle', seasons: null, reason: 'manual redispatch from dashboard', includeThrottled: false,
    })
  })

  it('zod 拒绝：seriesId 空字符串 → ok:false，不写任何行', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: '' }, NOW)
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('zod 拒绝：seasons 含非正整数 → ok:false', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: 's1', seasons: [0, -1] }, NOW)
    expect(result.ok).toBe(false)
  })
})

describe('dormantTargetLabel（Plan C spec §4.2：后端组标签，前端不拼）', () => {
  const base = {
    id: 1, series_id: 'tmdb:100', movie_id: null, season: null,
    series_name: 'The Rig', movie_name: null, seasons_json: null as string | null,
  }

  it('payload.seasons 单季 → "名, Season N"', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '[2]' })).toBe('The Rig, Season 2')
  })

  it('payload.seasons 多季 → "名, Seasons a, b"（升序）', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '[2,1]' })).toBe('The Rig, Seasons 1, 2')
  })

  it('payload.seasons 缺席但 jobs.season 有值 → 回落用列（存量 series_season 行）', () => {
    expect(dormantTargetLabel({ ...base, season: 3 })).toBe('The Rig, Season 3')
  })

  it('两处季信息都没有 → 只给系列名（全剧任务）', () => {
    expect(dormantTargetLabel(base)).toBe('The Rig')
  })

  it('电影行 → 电影名', () => {
    expect(dormantTargetLabel({
      ...base, series_id: null, series_name: null, movie_id: 'tmdb:777', movie_name: 'Dune',
    })).toBe('Dune')
  })

  it('join 不中（合成 series_id 的通用任务）→ 如实回落 id 本身，不伪造名字', () => {
    expect(dormantTargetLabel({
      ...base, series_id: 'orchestrator-shard-42-1', series_name: null,
    })).toBe('orchestrator-shard-42-1')
  })

  it('连 id 都没有 → 回落 job 号', () => {
    expect(dormantTargetLabel({ ...base, id: 77, series_id: null, series_name: null })).toBe('job #77')
  })

  it('seasons_json 是畸形 JSON 时不抛，按"没有季信息"处理', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '{oops' })).toBe('The Rig')
  })
})

describe('buildDormantTasks（Plan C spec §4.2）', () => {
  let db: ScoutDb
  beforeEach(() => { db = openDb(':memory:') })

  const insertJob = (over: Record<string, unknown> = {}) => {
    const row = {
      kind: 'worker_task', series_id: 'tmdb:100', season: null, movie_id: null,
      payload: JSON.stringify({ taskType: 'find_subtitle', reason: 'gaps', seasons: [2] }),
      state: 'dormant', attempt: 5, reap_count: 0,
      last_error: '连续 5 次进程崩溃/租约死亡回收未竟全功——疑确定性崩溃(poison task)',
      created_at: NOW, updated_at: NOW,
      ...over,
    }
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, payload, state, attempt, reap_count,
                         last_error, created_at, updated_at)
       VALUES (@kind, @series_id, @season, @movie_id, @payload, @state, @attempt, @reap_count,
               @last_error, @created_at, @updated_at)`,
    ).run(row)
  }

  it('DTO 键集合封闭为四键，中文 reason 串不泄漏', () => {
    db.prepare(`INSERT INTO series (id, name, year) VALUES ('tmdb:100', 'The Rig', 2023)`).run()
    insertJob()
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(1)
    expect(Object.keys(dto[0]).sort()).toEqual(['attempts', 'jobId', 'targetLabel', 'task'])
    expect(dto[0]).toEqual({ jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5 })
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain('崩溃')
    expect(serialized).not.toContain('poison')
    expect(serialized).not.toMatch(/"(reason|lastError|last_error|updatedAt|updated_at)":/)
  })

  it('只出 dormant——其余六态一律不出', () => {
    for (const state of ['wanted', 'searching', 'downloading', 'verifying', 'done', 'failed'] as const) {
      insertJob({ state, series_id: `tmdb:${state}` })
    }
    insertJob({ state: 'dormant', series_id: 'tmdb:parked', payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(1)
    expect(dto[0].targetLabel).toBe('tmdb:parked')
  })

  it('attempts 取两个计数器的大者——崩溃循环轨（reap_count=5, attempt=0）也报 5', () => {
    insertJob({ attempt: 0, reap_count: 5 })
    expect(buildDormantTasks(db)[0].attempts).toBe(5)
  })

  it('attempts 取两个计数器的大者——内容失败轨（attempt=5, reap_count=1）报 5', () => {
    insertJob({ attempt: 5, reap_count: 1 })
    expect(buildDormantTasks(db)[0].attempts).toBe(5)
  })

  it('payload 无 taskType 时 task 回落 kind，不给空串', () => {
    insertJob({ kind: 'realign', payload: null })
    expect(buildDormantTasks(db)[0].task).toBe('realign')
  })

  it('空表返回空数组', () => {
    expect(buildDormantTasks(db)).toEqual([])
  })

  it('排序钉死 ORDER BY updated_at DESC：最近停车的排前面', () => {
    insertJob({ series_id: 'tmdb:old', updated_at: NOW - 1000, payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    insertJob({ series_id: 'tmdb:new', updated_at: NOW, payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(2)
    expect(dto.map((d) => d.targetLabel)).toEqual(['tmdb:new', 'tmdb:old'])
  })
})

describe('buildLibraryMovieDetail', () => {
  it('返回 null 当电影不存在（404 语义）', () => {
    const settingsRepo = new SettingsRepo(db)
    expect(buildLibraryMovieDetail(db, settingsRepo, 'nonexistent')).toBeNull()
  })

  it('全部 14 键齐全：id/name/chineseTitle/year/posterPath/path/subStatus/statusReason/recheckAfter/originLang/nativeAudio/files/subtitles/recentJobs', () => {
    const settingsRepo = new SettingsRepo(db)
    const detail = buildLibraryMovieDetail(db, settingsRepo, 'm1')!
    expect(detail).toHaveProperty('id')
    expect(detail).toHaveProperty('name')
    expect(detail).toHaveProperty('chineseTitle')
    expect(detail).toHaveProperty('year')
    expect(detail).toHaveProperty('posterPath')
    expect(detail).toHaveProperty('path')
    expect(detail).toHaveProperty('subStatus')
    expect(detail).toHaveProperty('statusReason')
    expect(detail).toHaveProperty('recheckAfter')
    expect(detail).toHaveProperty('originLang')
    expect(detail).toHaveProperty('nativeAudio')
    expect(detail).toHaveProperty('files')
    expect(detail).toHaveProperty('subtitles')
    expect(detail).toHaveProperty('recentJobs')
    expect(Object.keys(detail)).toHaveLength(14)
  })

  it('键集合封闭：恰好 14 键，不多不少（无 backdropPath/overview/genres）', () => {
    const settingsRepo = new SettingsRepo(db)
    const detail = buildLibraryMovieDetail(db, settingsRepo, 'm1')!
    const keys = Object.keys(detail).sort()
    expect(keys).toEqual([
      'chineseTitle', 'files', 'id', 'name', 'nativeAudio', 'originLang',
      'path', 'posterPath', 'recentJobs', 'recheckAfter', 'statusReason',
      'subStatus', 'subtitles', 'year',
    ])
    expect(detail).not.toHaveProperty('backdropPath')
    expect(detail).not.toHaveProperty('overview')
    expect(detail).not.toHaveProperty('genres')
  })

  it('nativeAudio=true 当 originLang=zh 且默认 TARGET_LANGUAGES=zh', () => {
    const settingsRepo = new SettingsRepo(db)
    lib.upsertMovie({ id: 'm-zh', name: 'Chinese Film', path: '/media/movies/Film/f.mkv', subStatus: 'covered', originLang: 'zh' })
    const detail = buildLibraryMovieDetail(db, settingsRepo, 'm-zh')!
    expect(detail.originLang).toBe('zh')
    expect(detail.nativeAudio).toBe(true)
  })

  it('recentJobs 最近五个：movie_id 命中且 series_id IS NULL（过滤掉 series 目标的 worker_task）', () => {
    const settingsRepo = new SettingsRepo(db)

    // 使用新的 movie id 来避免与 beforeEach 中的 m1 job 冲突
    lib.upsertMovie({ id: 'm-jobs', name: 'Movie Jobs Test', path: '/media/movies/Test/test.mkv', subStatus: 'missing' })

    // 插入 2 个 movie job：1 个旧 kind='movie' + 1 个新 kind='worker_task' find_subtitle
    // （jobs_identity 约束：kind + series_id + season + movie_id + taskType 必须唯一，
    //  所以同一 movieId 只能有一个 worker_task/find_subtitle 组合）
    const jobId1 = insertJob(db, { kind: 'movie', movieId: 'm-jobs', state: 'wanted', priority: 10 })
    const jobId2 = insertWorkerTaskJob(db, { movieId: 'm-jobs', taskType: 'find_subtitle', state: 'searching', priority: 20 })

    // 干扰项：series_id 非空的 worker_task（应被 series_id IS NULL 过滤掉）
    insertWorkerTaskJob(db, { seriesId: 's1', season: 3, taskType: 'find_subtitle', state: 'searching', priority: 50 })

    // 干扰项：不同 movieId 的 job
    insertWorkerTaskJob(db, { movieId: 'm-other', taskType: 'find_subtitle', state: 'wanted', priority: 0 })

    const detail = buildLibraryMovieDetail(db, settingsRepo, 'm-jobs')!
    // 2 个 m-jobs 的 job（旧 kind='movie' + 新 kind='worker_task'）
    expect(detail.recentJobs).toHaveLength(2)
    const jobIds = detail.recentJobs.map(j => j.id).sort((a, b) => b - a)
    expect(jobIds).toEqual([jobId2, jobId1])
    expect(detail.recentJobs.every(j => j.state && typeof j.priority === 'number')).toBe(true)
    // 验证干扰项被正确过滤：series_id 非空的不在结果里
    expect(detail.recentJobs.every(j => j.id !== 50)).toBe(true)
  })
})
