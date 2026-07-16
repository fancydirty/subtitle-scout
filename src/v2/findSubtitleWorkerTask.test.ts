import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import {
  runFindSubtitleWorkerTask, mapWorkerTaskToFindSubtitleTask,
  type FindSubtitleWorkerTaskDeps, type FindSubtitleTaskMapperDeps,
} from './findSubtitleWorkerTask.js'
import type {
  FindSubtitleBatchReport, FindSubtitleInstalledItem, FindSubtitleUnresolvedItem, FindSubtitleTask,
} from '../agent/findSubtitleWorker.schemas.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { seriesId, episodeId } from './ownIds.js'

// 2026-07-16 事故修复回归测试：representativeEpisodeId 把季级派活机械降解为单集指令的
// 架构事故已处决——mapper 现在是纯信使，零目标选择、零顺序决策，缺口事实清单由
// LibraryRepo.listMissingEpisodesInSeason 产出、整批上车。以下 describe 块直接测
// mapWorkerTaskToFindSubtitleTask（不经 runFindSubtitleWorkerTask 的收割/队列外壳）。
describe('mapWorkerTaskToFindSubtitleTask (胶水层修复 2026-07-16: mapper 降级纯信使)', () => {
  const NOW = 1_800_000_000_000

  function mapperDeps(over: Partial<FindSubtitleTaskMapperDeps> = {}): FindSubtitleTaskMapperDeps {
    return { lib: over.lib!, tmdb: null, mediaRoots: [], ...over }
  }

  it('季级 job 映射为携带全部缺口的批量任务（不是一集）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-season-'))
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '9'
    const sId = seriesId(tmdbId)

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'Show' })
    for (let ep = 1; ep <= 5; ep++) {
      const path = join(showDir, `Show.S01E0${ep}.mkv`)
      writeFileSync(path, 'video')
      lib.upsertEpisode({
        id: episodeId(tmdbId, 1, ep), seriesId: sId, season: 1, episode: ep, name: `E${ep}`,
        path, subStatus: 'missing',
      })
    }
    // e2 covered, e4 unavailable but not yet due for recheck — both excluded from the gap list.
    // R-3: markUnavailable's 3rd arg is now `now` (the ladder computes recheck_after itself,
    // 1 day out on the first call) — passing NOW here still lands recheck_after in the future
    // relative to NOW, satisfying "not yet due".
    lib.markCovered(episodeId(tmdbId, 1, 2), null, 'preexisting')
    lib.markUnavailable(episodeId(tmdbId, 1, 4), 'not due yet', NOW)

    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

    expect(task!.targets.map(t => t.episode)).toEqual([1, 3, 5])
    expect(task!.targets.map(t => t.itemId)).toEqual(['tmdb:9/s1e1', 'tmdb:9/s1e3', 'tmdb:9/s1e5'])
  })

  it('绝对集号一次取表逐集折算（getSeasonTable 只打一次）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-abstable-'))
    const showDir = join(root, 'Show', 'Season 02')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '20'
    const sId = seriesId(tmdbId)

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'Show' })
    for (let ep = 1; ep <= 2; ep++) {
      const path = join(showDir, `Show.S02E0${ep}.mkv`)
      writeFileSync(path, 'video')
      lib.upsertEpisode({
        id: episodeId(tmdbId, 2, ep), seriesId: sId, season: 2, episode: ep, name: `E${ep}`,
        path, subStatus: 'missing',
      })
    }
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 2, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const tmdb = new TmdbClient({ apiKey: 'a'.repeat(32) })
    const spy = vi.fn(async () => [
      { seasonNumber: 1, episodeCount: 12, airDate: null },
      { seasonNumber: 2, episodeCount: 12, airDate: null },
    ])
    tmdb.getSeasonTable = spy
    tmdb.getAbsoluteOrder = async () => null
    // 富化路径也必须 stub——不 stub 时 fetchTmdbEnrichment 会拿假 key 打真 TMDB（.catch 兜底
    // 所以不报错，但网络往返让本测试在 5s 默认超时下 flaky——T8 交卷时定位的 T4 遗留卫生问题）。
    tmdb.getDetails = async () => null
    tmdb.getChineseTitles = async () => []

    const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, tmdb }), NOW)

    expect(task!.targets[0].absoluteEpisode).toBe(13)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('mediaRoot=全部目标的公共祖先目录', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-mediaroot-'))
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '30'
    const sId = seriesId(tmdbId)

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'Show' })
    for (const ep of [1, 2]) {
      const path = join(showDir, `Show.S01E0${ep}.mkv`)
      writeFileSync(path, 'video')
      lib.upsertEpisode({
        id: episodeId(tmdbId, 1, ep), seriesId: sId, season: 1, episode: ep, name: `E${ep}`,
        path, subStatus: 'missing',
      })
    }
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

    expect(task!.mediaRoot).toBe(showDir)
  })

  it('movie job 映射为单目标批量任务', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-movie-'))
    const movieDir = join(root, 'Movie (2020)')
    mkdirSync(movieDir, { recursive: true })
    const videoPath = join(movieDir, 'Movie.mkv')
    writeFileSync(videoPath, 'video')
    const movieId = seriesId('555')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertMovie({ id: movieId, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
    jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const movieTask = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

    expect(movieTask!.targets).toHaveLength(1)
    expect(movieTask!.targets[0]).toMatchObject({ itemId: 'tmdb:555', season: null, episode: null })
  })

  it('全部已覆盖 → null（幂等 no-op 语义保留）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-allcovered-'))
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '40'
    const sId = seriesId(tmdbId)
    const path = join(showDir, 'Show.S01E01.mkv')
    writeFileSync(path, 'video')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'Show' })
    lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
    lib.markCovered(episodeId(tmdbId, 1, 1), null, 'preexisting')
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

    expect(task).toBeNull()
  })

  it('目标目录在 MEDIA_ROOTS 之外 → throw（沙盒外层边界保留）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-outsideroot-'))
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '50'
    const sId = seriesId(tmdbId)
    const path = join(showDir, 'Show.S01E01.mkv')
    writeFileSync(path, 'video')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'Show' })
    lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    await expect(
      mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, mediaRoots: ['/completely/different/root'] }), NOW),
    ).rejects.toThrow(/拒绝在媒体根目录之外写入/)
  })

  it('目标目录不可写 → throw（既有防线保留）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-unwritable-'))
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '60'
    const sId = seriesId(tmdbId)
    const path = join(showDir, 'Show.S01E01.mkv')
    writeFileSync(path, 'video')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'Show' })
    lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    chmodSync(showDir, 0o555)
    try {
      await expect(
        mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW),
      ).rejects.toThrow(/not writable/)
    } finally {
      chmodSync(showDir, 0o755) // 还原，避免 vitest 清理临时目录时因权限报错
    }
  })

  // R-11（用户裁决 2026-07-16）：派活范围是主代理的判断，不是系统常量——"进击的巨人有三季资源都
  // 缺字幕就整季派，只有第三季资源就只找第三季"。mapper 不再自己按 job.season 单季推导，改按
  // payload.seasons 下发的范围事实取缺口清单；job.season 列对 find_subtitle 行恒 NULL。
  describe('payload.seasons 范围裁量（R-11）', () => {
    it('payload.seasons=null → 全剧缺口整批上车（跨季 targets，mediaRoot=剧目录公共祖先）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-wholeseries-'))
      const s1Dir = join(root, 'Show', 'Season 01')
      const s2Dir = join(root, 'Show', 'Season 02')
      mkdirSync(s1Dir, { recursive: true })
      mkdirSync(s2Dir, { recursive: true })
      const tmdbId = '70'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const s1Path = join(s1Dir, 'Show.S01E01.mkv')
      const s2Path = join(s2Dir, 'Show.S02E01.mkv')
      writeFileSync(s1Path, 'video')
      writeFileSync(s2Path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path: s1Path, subStatus: 'missing' })
      lib.upsertEpisode({ id: episodeId(tmdbId, 2, 1), seriesId: sId, season: 2, episode: 1, name: 'E1', path: s2Path, subStatus: 'missing' })

      // season 列恒 NULL——范围事实随 payload.seasons 下发，不是身份列（R-11）。
      jobsRepo.upsertWorkerTask({ seriesId: sId, season: null, movieId: null }, { taskType: 'find_subtitle', seasons: null, reason: 'whole series' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(task!.targets.map(t => [t.season, t.episode])).toEqual([[1, 1], [2, 1]])
      expect(task!.mediaRoot).toBe(join(root, 'Show'))
    })

    it('payload.seasons=[3] → 只带 S3 缺口（用户例：只有第三季资源就找第三季）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-s3only-'))
      const s3Dir = join(root, 'Show', 'Season 03')
      mkdirSync(s3Dir, { recursive: true })
      const tmdbId = '80'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const s3Path = join(s3Dir, 'Show.S03E01.mkv')
      writeFileSync(s3Path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 3, 1), seriesId: sId, season: 3, episode: 1, name: 'E1', path: s3Path, subStatus: 'missing' })

      jobsRepo.upsertWorkerTask({ seriesId: sId, season: null, movieId: null }, { taskType: 'find_subtitle', seasons: [3], reason: 'season 3 only' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(task!.targets.map(t => t.season)).toEqual([3])
    })

    it('旧行兼容：payload 无 seasons 字段 + job.season 有值 → 按该季推导（存量行语义不变）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-legacy-'))
      const showDir = join(root, 'Show', 'Season 02')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '90'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const path = join(showDir, 'Show.S02E01.mkv')
      writeFileSync(path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 2, 1), seriesId: sId, season: 2, episode: 1, name: 'E1', path, subStatus: 'missing' })

      // 存量行：v11 迁移前写入的形状——season 列有值，payload 里没有 seasons 字段。
      jobsRepo.upsertWorkerTask({ seriesId: sId, season: 2, movieId: null }, { taskType: 'find_subtitle', reason: 'legacy row' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(task!.targets.map(t => t.season)).toEqual([2])
    })
  })
})

/** FindSubtitleBatchReport 构造 helper：三桶默认皆空，测试按需覆写。 */
function report(over: Partial<FindSubtitleBatchReport> = {}): FindSubtitleBatchReport {
  return { installed: [], no_safe_match: [], retry_later: [], ...over }
}

function installedItem(itemId: string, over: Partial<FindSubtitleInstalledItem> = {}): FindSubtitleInstalledItem {
  return {
    itemId, installedPath: '/p/placeholder.srt', installedLanguage: 'zh-Hans',
    candidateProvider: null, candidateProviderId: null, reason: 'looks right',
    ...over,
  }
}

function unresolvedItem(itemId: string, reason = 'looks unresolved'): FindSubtitleUnresolvedItem {
  return { itemId, reason }
}

// Own-id space (去 Jellyfin 化 P2): series/movies.id = 'tmdb:<TMDB id>'. Using a real tmdb id
// ('1429') as the fixture's series/episode identity means the mapper's tmdbIdFromOwnId extraction
// is exercised for real, not glossed over.
const SHOW_TMDB_ID = '1429'
const SHOW_SERIES_ID = seriesId(SHOW_TMDB_ID)
const SHOW_EPISODE_ID = episodeId(SHOW_TMDB_ID, 1, 1)

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'find-subtitle-worker-task-'))
  const showDir = join(root, 'Show', 'Season 01')
  mkdirSync(showDir, { recursive: true })
  const videoPath = join(showDir, 'Show.S01E01.mkv')
  writeFileSync(videoPath, 'video')

  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  lib.upsertSeries({ id: SHOW_SERIES_ID, name: 'Show' })
  lib.upsertEpisode({
    id: SHOW_EPISODE_ID, seriesId: SHOW_SERIES_ID, season: 1, episode: 1, name: 'E1',
    path: videoPath, subStatus: 'missing',
  })
  jobsRepo.upsertWorkerTask({ seriesId: SHOW_SERIES_ID, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
  const job = jobsRepo.claimNext(Date.now())!
  return { root, videoPath, db, lib, jobsRepo, job }
}

/** 批量收割测试用：同一季 episodeCount 集全部 missing，一次 claim 拿到携带全部目标的批量任务
 *  （镜像上方 mapper 测试"季级 job 映射为携带全部缺口的批量任务"的夹具形状）。 */
function setupBatch(episodeCount: number) {
  const root = mkdtempSync(join(tmpdir(), 'find-subtitle-worker-task-batch-'))
  const showDir = join(root, 'Show', 'Season 01')
  mkdirSync(showDir, { recursive: true })

  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  lib.upsertSeries({ id: SHOW_SERIES_ID, name: 'Show' })
  const episodeIds: string[] = []
  for (let ep = 1; ep <= episodeCount; ep++) {
    const id = episodeId(SHOW_TMDB_ID, 1, ep)
    const videoPath = join(showDir, `Show.S01E0${ep}.mkv`)
    writeFileSync(videoPath, 'video')
    lib.upsertEpisode({
      id, seriesId: SHOW_SERIES_ID, season: 1, episode: ep, name: `E${ep}`,
      path: videoPath, subStatus: 'missing',
    })
    episodeIds.push(id)
  }
  jobsRepo.upsertWorkerTask({ seriesId: SHOW_SERIES_ID, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
  const job = jobsRepo.claimNext(Date.now())!
  return { root, db, lib, jobsRepo, job, episodeIds }
}

const MOVIE_ID = seriesId('555')

function setupMovie() {
  const root = mkdtempSync(join(tmpdir(), 'find-subtitle-worker-task-movie-'))
  const movieDir = join(root, 'Movie (2020)')
  mkdirSync(movieDir, { recursive: true })
  const videoPath = join(movieDir, 'Movie.mkv')
  writeFileSync(videoPath, 'video')

  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  lib.upsertMovie({ id: MOVIE_ID, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
  jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId: MOVIE_ID }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
  const job = jobsRepo.claimNext(Date.now())!
  return { root, videoPath, db, lib, jobsRepo, job }
}

function baseDeps(over: Partial<FindSubtitleWorkerTaskDeps> = {}): FindSubtitleWorkerTaskDeps {
  return {
    lib: over.lib!,
    tmdb: null,
    mediaRoots: [],
    runTask: vi.fn(async () => report()),
    ...over,
  }
}

// R-3（裁决 2026-07-16）：批量收割入账 + 队列语义终局。旧单决定契约（mapper 返回
// `{ task, targetItemId }`，installed/no_safe_match 各处理一个 itemId，no_safe_match 走
// jobs 侧 dormant 判决）已随 Task 4 的 mapper 批量化处决——mapper 早就只返回整批
// FindSubtitleTask 本身。这个 describe 块（Task 8）把 runFindSubtitleWorkerTask 本体重写为
// 批量收割入账：installed/no_safe_match 逐项落账（markCovered/markUnavailable），内容退避
// 下沉到 item 自己的 search_attempts 阶梯（见 libraryRepo.ts markUnavailable），
// jobs.completeNoMatch 从此零调用（不删，见 jobsRepo.ts 头注释）。
describe('runFindSubtitleWorkerTask (R-3: 批量收割入账 + 队列语义终局)', () => {
  it('installed: 批量逐项 markCovered，job completeDone', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(3)
    const runTask = vi.fn(async () => report({ installed: episodeIds.map((id) => installedItem(id)) }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).not.toBeNull()
    for (const id of episodeIds) expect(lib.getEpisode(id)!.sub_status).toBe('covered')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('no_safe_match: 批量逐项 markUnavailable（item 级阶梯自算 recheck_after），job 仍 completeDone', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(2)
    const runTask = vi.fn(async () => report({
      no_safe_match: episodeIds.map((id) => unresolvedItem(id, '没有找到匹配的字幕')),
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    for (const id of episodeIds) {
      const ep = lib.getEpisode(id)!
      expect(ep.sub_status).toBe('unavailable')
      expect(ep.search_attempts).toBe(1)
      expect(ep.recheck_after).not.toBeNull()
      expect(ep.status_reason).toBe('没有找到匹配的字幕')
    }
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  // R-3: 内容退避彻底下沉到 item 事实层——jobs 状态机从此不持有任何内容判决，dormant 判决之死。
  it('全 no_safe_match 场景：jobsRepo.completeNoMatch 零调用（dormant 判决已死）', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(2)
    const completeNoMatchSpy = vi.spyOn(jobsRepo, 'completeNoMatch')
    const runTask = vi.fn(async () => report({ no_safe_match: episodeIds.map((id) => unresolvedItem(id)) }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(completeNoMatchSpy).not.toHaveBeenCalled()
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  // A2: markCovered's language fallback used to be a hardcoded 'zh-Hans' no matter the task's
  // actual target language. It must now fall back to task.targetLanguage instead — a defensive
  // last resort for the rare case the worker finalizes an installed item without installedLanguage.
  it('markCovered records task.targetLanguage (not a hardcoded zh-Hans) when the installed item omits installedLanguage', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({
      installed: [installedItem(SHOW_EPISODE_ID, { installedLanguage: null, installedPath: '/p/e1.en.srt' })],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask, targetLanguage: 'en' })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = lib.db.prepare('select language from subtitles where item_id=?').get(SHOW_EPISODE_ID) as { language: string }
    expect(row.language).toBe('en')
  })

  // Spec-review fix #1 (A1's "A4 接配置"): the task's targetLanguage comes from configuration
  // (deps.targetLanguage, wired from TARGET_LANGUAGES' primary entry in cli/index.ts), not a
  // hardcoded 'zh'. With TARGET_LANGUAGES=en, dispatched workers must hunt English subtitles.
  it('threads deps.targetLanguage into the constructed FindSubtitleTask (en config → en task)', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask, targetLanguage: 'en' })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'en' }))
  })

  it('deps.targetLanguage omitted → task.targetLanguage defaults to zh (historical default)', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({ targetLanguage: 'zh' }))
  })

  it('movie identity: resolves the movie row (not an episode) and marks it covered', async () => {
    const { lib, jobsRepo, job } = setupMovie()
    const runTask = vi.fn(async () => report({
      installed: [installedItem(MOVIE_ID, { installedPath: '/movies/Movie.zh-Hans.srt' })],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getMovie(MOVIE_ID)!.sub_status).toBe('covered')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  // itemId 幻觉防线：markCovered/markUnavailable 都是两表盲 UPDATE，且 subtitles.item_id 没有
  // FK 约束到 episodes(id)——不拦截的话，一个幻觉 itemId 能在没有任何对应 episodes 行的情况下,
  // 直接在 subtitles 表里插入一条来路不明的记录。
  it('itemId 幻觉防线：installed 报告里清单外的 itemId 被丢弃，不砸进 subtitles 表', async () => {
    const { lib, jobsRepo, job } = setup()
    const alienId = 'tmdb:9999/s1e1'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async () => report({
      installed: [
        installedItem(SHOW_EPISODE_ID, { installedPath: '/p/real.srt' }),
        installedItem(alienId, { installedPath: '/p/alien.srt' }),
      ],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getEpisode(SHOW_EPISODE_ID)!.sub_status).toBe('covered')
    const alienSubtitleCount = (
      lib.db.prepare('select count(*) c from subtitles where item_id=?').get(alienId) as { c: number }
    ).c
    expect(alienSubtitleCount).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(alienId))
    errorSpy.mockRestore()
  })

  it('idempotent no-op: if the target is already covered by claim time, completes the job done WITHOUT ever invoking the worker', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.markCovered(SHOW_EPISODE_ID, null, 'preexisting') // covered out-of-band before the worker claims this row
    const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).toBeNull()
    expect(runTask).not.toHaveBeenCalled()
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('retry_later: 非空时 job completeError（短退避），同批已判明的事实（installed/no_safe_match）照记', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(3)
    const [installedId, noMatchId, retryId] = episodeIds
    const runTask = vi.fn(async () => report({
      installed: [installedItem(installedId)],
      no_safe_match: [unresolvedItem(noMatchId, '搜索穷尽')],
      retry_later: [unresolvedItem(retryId, 'provider timed out')],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getEpisode(installedId)!.sub_status).toBe('covered')
    expect(lib.getEpisode(noMatchId)!.sub_status).toBe('unavailable')
    expect(lib.getEpisode(retryId)!.sub_status).toBe('missing') // untouched — retry_later 不落账
    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toContain('provider timed out')
  })

  it('空报告（三桶皆空）→ completeError', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report())
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).not.toBeNull() // report 本身返回了，只是三桶皆空——不是 mapper null 那个 no-op
    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toContain('empty batch report')
  })

  it('worker-exhaustion: a thrown worker invocation (step-cap/timeout/abort) fails the job via completeError instead of propagating', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => { throw new Error('step count limit exceeded') })
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).toBeNull()
    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toBe('step count limit exceeded')
  })

  it('sandbox: a mapped video path outside the configured MEDIA_ROOTS throws inside the mapper, and is caught the same way as a thrown worker (completeError, not a crash)', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
    // mediaRoots points somewhere that does NOT contain the episode's real path (set up() put it
    // under a tmpdir never listed here) — mirrors makeRunEpisode's root-restriction guard.
    const deps = baseDeps({ lib, mediaRoots: ['/completely/different/root'], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).toBeNull()
    expect(runTask).not.toHaveBeenCalled()
    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toMatch(/拒绝在媒体根目录之外写入/)
  })

  // mapper 自身对 resolveAbsoluteTable 的取表-折算行为已经在 mapWorkerTaskToFindSubtitleTask 的
  // 直接测试里覆盖（见上方"绝对集号一次取表逐集折算"）；这里额外验证批量化后 runFindSubtitleWorkerTask
  // 传给 runTask 的整批任务里，absoluteEpisode 挪进了 task.targets[i]（不再是 task 顶层字段）。
  it('computes absoluteEpisode from TMDB season-concat data when tmdb is configured', async () => {
    const { lib, jobsRepo, job } = setup()
    const tmdb = new TmdbClient({ apiKey: 'a'.repeat(32) })
    tmdb.getSeasonTable = vi.fn(async () => [{ seasonNumber: 1, episodeCount: 12, airDate: null }])
    tmdb.getAbsoluteOrder = async () => null
    // getDetails/getChineseTitles are gain-path enrichment unrelated to absoluteEpisode — stub
    // them out too so this test never makes a real network call (no live TMDB access in CI/sandbox).
    tmdb.getDetails = async () => null
    tmdb.getChineseTitles = async () => []
    const runTask = vi.fn(async (_task: FindSubtitleTask) => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask, tmdb })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const passedTask = runTask.mock.calls[0][0]
    expect(passedTask.targets[0].absoluteEpisode).toBe(1)
  })

  it('absoluteEpisode is null when deps.tmdb is not configured', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async (_task: FindSubtitleTask) => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask }) // tmdb: null (baseDeps default)

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const passedTask = runTask.mock.calls[0][0]
    expect(passedTask.targets[0].absoluteEpisode).toBeNull()
  })

  // 退役T1 (W0-3a): v3 runner writes a `runs` row at each terminal outcome so the dashboard's
  // run-history timeline (which reads the `runs` table) has parity with the old pipeline while
  // it's still live. `runs` is optional on the deps — these tests both prove the row shape when
  // present and prove the runner doesn't crash when it's absent (existing tests above already
  // exercise the absent case implicitly since baseDeps never sets `runs`).
  // R-3: 按非空桶各记一行（installed/no_safe_match/retry_later 词表沿用，dashboard 时间线口径不破）。
  describe('runs row (timeline parity, 退役T1；R-3：按非空桶各记一行)', () => {
    it('installed: writes one runs row with decision "installed" and a detail containing the itemId', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('installed')
      expect(rows[0].detail).toContain(SHOW_EPISODE_ID)
    })

    it('no_safe_match: writes one runs row with decision "no_safe_match" and the worker reason as detail', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => report({
        no_safe_match: [unresolvedItem(SHOW_EPISODE_ID, '没有找到匹配的字幕')],
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('no_safe_match')
      expect(rows[0].detail).toContain('没有找到匹配的字幕')
    })

    it('retry_later: writes one runs row with decision "retry_later" and a detail containing the itemId', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => report({
        retry_later: [unresolvedItem(SHOW_EPISODE_ID, 'provider timed out')],
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('retry_later')
      // R-3: runs 的 retry_later 行按桶记 itemId 清单（同 installed/no_safe_match 的记法一致），
      // 具体 reason 落在 jobs.last_error（completeError 那条消息）里，不是 runs.detail 的职责。
      expect(rows[0].detail).toContain(SHOW_EPISODE_ID)
    })

    it('worker-throw: writes one runs row with decision "error" and the thrown message as detail', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => { throw new Error('step count limit exceeded') })
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('error')
      expect(rows[0].detail).toContain('step count limit exceeded')
    })

    it('deps.runs omitted: does not crash and simply skips writing a runs row', async () => {
      const { lib, jobsRepo, job } = setup()
      const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask }) // no `runs`

      await expect(runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())).resolves.not.toBeNull()
      expect(lib.getEpisode(SHOW_EPISODE_ID)!.sub_status).toBe('covered')
    })

    it('runs 按非空桶各记一行：混合报告（installed+no_safe_match+retry_later）写 3 行，词表覆盖三种 decision', async () => {
      const { lib, jobsRepo, job, db, episodeIds } = setupBatch(3)
      const runs = new RunsRepo(db)
      const [installedId, noMatchId, retryId] = episodeIds
      const runTask = vi.fn(async () => report({
        installed: [installedItem(installedId)],
        no_safe_match: [unresolvedItem(noMatchId, '搜索穷尽')],
        retry_later: [unresolvedItem(retryId, 'provider timed out')],
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      const decisions = rows.map((r) => r.decision).sort()
      expect(decisions).toEqual(['installed', 'no_safe_match', 'retry_later'])
    })
  })
})
