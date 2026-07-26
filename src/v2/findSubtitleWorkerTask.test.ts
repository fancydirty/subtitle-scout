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
import { traceBus, type TraceEvent } from '../core/traceBus.js'

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

  // 重复源 P4：某个正常缺口目标所属的条目若还有副本，且副本已有字幕（partial 覆盖）——把那份
  // 已有字幕转成 provider:'local' 候选前置注入 task.localCandidates。（本单只做"从已覆盖副本
  // 传播到缺口主文件"这一可达场景——main 已覆盖、副本反而缺字幕的场景需要额外的"partial→
  // 可派活目标"机制，超出本单范围，如实标注不冒充已完成。）
  describe('localCandidates（重复源 P4 传播判断素材）', () => {
    it('主文件缺口 + 副本已有字幕 → 副本字幕转成 provider:local 候选', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-local-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '10'
      const sId = seriesId(tmdbId)
      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const mainPath = join(showDir, 'Show.S01E01.1080p.mkv')
      const replicaPath = join(showDir, 'Show.S01E01.4K.mkv')
      writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
      const epId = episodeId(tmdbId, 1, 1)
      // 主文件缺口（正常 gap，会被 listMissingEpisodesInSeason 选中）；副本已有字幕。
      lib.upsertEpisode({ id: epId, seriesId: sId, season: 1, episode: 1, name: 'E1', path: mainPath, subStatus: 'missing' })
      lib.addItemFile(epId, replicaPath, NOW)
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
        .run(epId, join(showDir, 'Show.S01E01.4K.zh-Hans.srt'), 'zh-Hans', 'scout-download', replicaPath, NOW)

      jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(task!.localCandidates).toHaveLength(1)
      expect(task!.localCandidates[0]).toMatchObject({
        provider: 'local', language: 'zh-Hans', videoName: 'Show.S01E01.4K.mkv',
      })
      expect(decodeURIComponent(task!.localCandidates[0].providerId)).toBe(join(showDir, 'Show.S01E01.4K.zh-Hans.srt'))
    })

    it('单文件条目（无副本）→ localCandidates 空数组', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-local-single-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '11'
      const sId = seriesId(tmdbId)
      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const path = join(showDir, 'Show.S01E01.mkv')
      writeFileSync(path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })

      jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)
      expect(task!.localCandidates).toEqual([])
    })

    it('多文件条目但全部覆盖或全部未覆盖（非 partial）→ localCandidates 空数组', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-local-full-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '12'
      const sId = seriesId(tmdbId)
      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      // e1：全覆盖（主+副本都有字幕）——已覆盖不产生这一集的目标，但仍验证不产生候选。
      const mainPath1 = join(showDir, 'Show.S01E01.mkv')
      const replicaPath1 = join(showDir, 'Show.S01E01.dup.mkv')
      writeFileSync(mainPath1, 'video'); writeFileSync(replicaPath1, 'video')
      const epId1 = episodeId(tmdbId, 1, 1)
      lib.upsertEpisode({ id: epId1, seriesId: sId, season: 1, episode: 1, name: 'E1', path: mainPath1, subStatus: 'covered' })
      lib.addItemFile(epId1, replicaPath1, NOW)
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
        .run(epId1, '/x.srt', 'zh-Hans', 'scout-download', replicaPath1, NOW)
      // e2：missing，但也有一个副本一样是 missing（全未覆盖）。
      const mainPath2 = join(showDir, 'Show.S01E02.mkv')
      const replicaPath2 = join(showDir, 'Show.S01E02.dup.mkv')
      writeFileSync(mainPath2, 'video'); writeFileSync(replicaPath2, 'video')
      const epId2 = episodeId(tmdbId, 1, 2)
      lib.upsertEpisode({ id: epId2, seriesId: sId, season: 1, episode: 2, name: 'E2', path: mainPath2, subStatus: 'missing' })
      lib.addItemFile(epId2, replicaPath2, NOW)

      jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)
      // e1 已全覆盖，不进 targets；e2 全未覆盖，是本任务唯一目标。两者都不产生本地候选。
      expect(task!.targets.map((t) => t.itemId)).toEqual([epId2])
      expect(task!.localCandidates).toEqual([])
    })

    it('movie 分支同理支持传播（主文件缺口 + 副本已有字幕）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-local-movie-'))
      const movieDir = join(root, 'Movie')
      mkdirSync(movieDir, { recursive: true })
      const tmdbId = '13'
      const mId = seriesId(tmdbId)
      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      const mainPath = join(movieDir, 'Movie.1080p.mkv')
      const replicaPath = join(movieDir, 'Movie.4K.mkv')
      writeFileSync(mainPath, 'video'); writeFileSync(replicaPath, 'video')
      // 主文件缺口（正常会被 stillMissing 选中）；副本已有字幕。
      lib.upsertMovie({ id: mId, name: 'Movie', path: mainPath, subStatus: 'missing' })
      lib.addItemFile(mId, replicaPath, NOW)
      db.prepare(`INSERT INTO subtitles (item_id, path, language, source, file_path, created_at) VALUES (?,?,?,?,?,?)`)
        .run(mId, join(movieDir, 'Movie.4K.zh-Hans.srt'), 'zh-Hans', 'scout-download', replicaPath, NOW)

      jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId: mId }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)
      expect(task!.localCandidates).toHaveLength(1)
      expect(task!.localCandidates[0].provider).toBe('local')
    })
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

  // 2026-07-18 事故修复回归锁：True Detective S02E08 从零 e2e 真实事故——getDetails 的剧级
  // "典型"单集时长（该剧首集/众数 ~58 分）被当作全季所有集的事实喂给 agent，S02E08 实际是
  // ~86 分钟的加长季终，agent 诚实地把时长正确的候选字幕全部拒判判无（agent 判断没错，喂的
  // 事实错了）。逐集实际时长（getSeasonEpisodeRuntimes）修复后，target 级必须携带该集本尊
  // 时长，不再是剧级典型值的复读。
  it('True Detective S02E08 事故回归锁：E08 target.runtimeMinutes 取该集本尊 86，非剧级典型 58', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-truedetective-'))
    const showDir = join(root, 'True Detective', 'Season 02')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '46648' // True Detective 的真实 TMDB id，事故背景锚点
    const sId = seriesId(tmdbId)

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertSeries({ id: sId, name: 'True Detective' })
    for (const ep of [7, 8]) {
      const path = join(showDir, `True.Detective.S02E0${ep}.mkv`)
      writeFileSync(path, 'video')
      lib.upsertEpisode({
        id: episodeId(tmdbId, 2, ep), seriesId: sId, season: 2, episode: ep, name: `E${ep}`,
        path, subStatus: 'missing',
      })
    }
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 2, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const tmdb = new TmdbClient({ apiKey: 'a'.repeat(32) })
    const spy = vi.fn(async (_tvId: string, _season: number) => new Map([[7, 58], [8, 86]]))
    tmdb.getSeasonEpisodeRuntimes = spy
    tmdb.getAbsoluteOrder = async () => null
    tmdb.getSeasonTable = async () => null
    // 典型单集时长（剧级 fallback）：该剧 episode_run_time[0]=58——task 顶层字段保持这个值
    // 不变（不是本次修复的目标，只是既有 fallback 语义），本单只验证 target 级取到本尊值。
    tmdb.getDetails = async () => ({
      overview: null, runtimeMinutes: 58, posterPath: null, backdropPath: null, originalTitle: null, year: null, genreIds: [],
    })
    tmdb.getChineseTitles = async () => []

    const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, tmdb }), NOW)

    const e7 = task!.targets.find((t) => t.episode === 7)!
    const e8 = task!.targets.find((t) => t.episode === 8)!
    expect(e7.runtimeMinutes).toBe(58)
    expect(e8.runtimeMinutes).toBe(86) // 关键断言：加长季终拿到本尊 86，不是剧级典型 58
    expect(task!.runtimeMinutes).toBe(58) // task 顶层典型值 fallback 不受影响
    expect(spy).toHaveBeenCalledTimes(1) // 一季一次调用，不逐集调
  })

  it('季端点失败（getSeasonEpisodeRuntimes 返回 null）→ 全部 target.runtimeMinutes 为 null，任务照常构造', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-seasonruntime-fail-'))
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const tmdbId = '999'
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

    const tmdb = new TmdbClient({ apiKey: 'a'.repeat(32) })
    tmdb.getSeasonEpisodeRuntimes = async () => null // 增益路径失败降级（本身已经不 throw，见 tmdb.ts）
    tmdb.getAbsoluteOrder = async () => null
    tmdb.getSeasonTable = async () => null
    tmdb.getDetails = async () => null
    tmdb.getChineseTitles = async () => []

    const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, tmdb }), NOW)

    expect(task).not.toBeNull()
    expect(task!.targets.every((t) => t.runtimeMinutes === null)).toBe(true)
  })

  it('movie 分支的 target.runtimeMinutes 取 details.runtimeMinutes（电影时长本就是单片级）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-movie-runtime-'))
    const movieDir = join(root, 'Movie (2020)')
    mkdirSync(movieDir, { recursive: true })
    const videoPath = join(movieDir, 'Movie.mkv')
    writeFileSync(videoPath, 'video')
    const movieId = seriesId('777')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertMovie({ id: movieId, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
    jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
    const job = jobsRepo.claimNext(NOW)!

    const tmdb = new TmdbClient({ apiKey: 'a'.repeat(32) })
    tmdb.getDetails = async () => ({
      overview: null, runtimeMinutes: 136, posterPath: null, backdropPath: null, originalTitle: null, year: 2020, genreIds: [],
    })
    tmdb.getChineseTitles = async () => []

    const movieTask = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, tmdb }), NOW)

    expect(movieTask!.targets[0].runtimeMinutes).toBe(136)
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

  // H4（2026-07-18 数据安全审计——gcOrphans 盲区修复）：stagingRoot 必须是配置媒体根一级
  // （deps.mediaRoots 里包含收窄 mediaRoot 的那一个），不是 mediaRoot 本身——见
  // findSubtitleWorker.schemas.ts 的 FindSubtitleTask.stagingRoot 字段文档。
  describe('stagingRoot (H4)', () => {
    it('季级任务：stagingRoot=deps.mediaRoots 里包含收窄 mediaRoot 的配置根，不是收窄目录本身', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-stagingroot-series-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '31'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const path = join(showDir, 'Show.S01E01.mkv')
      writeFileSync(path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
      jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, mediaRoots: [root] }), NOW)

      expect(task!.mediaRoot).toBe(showDir) // INNER 沙盒根不变——仍是收窄目录
      expect(task!.stagingRoot).toBe(root) // 但 staging 根对齐到配置根一级
    })

    it('movie 任务：stagingRoot=deps.mediaRoots 里包含 movie 目录的配置根', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-stagingroot-movie-'))
      const movieDir = join(root, 'Movie (2020)')
      mkdirSync(movieDir, { recursive: true })
      const videoPath = join(movieDir, 'Movie.mkv')
      writeFileSync(videoPath, 'video')
      const movieId = seriesId('556')

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertMovie({ id: movieId, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
      jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const movieTask = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib, mediaRoots: [root] }), NOW)

      expect(movieTask!.mediaRoot).toBe(movieDir)
      expect(movieTask!.stagingRoot).toBe(root)
    })

    it('找不到包含收窄目录的配置根（如 mediaRoots 未配置）→ fallback 到收窄目录本身，并 console.error 告警', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-stagingroot-fallback-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '32'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const path = join(showDir, 'Show.S01E01.mkv')
      writeFileSync(path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
      jobsRepo.upsertWorkerTask({ seriesId: sId, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, NOW)
      const job = jobsRepo.claimNext(NOW)!

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // mediaRoots: [] (mapperDeps 默认) — isUnderRoots 把它当"未配置=不限制"通过，但
        // containingRoot 对同样的空数组必然返回 null——这是 stagingRootFor 唯一可达的 fallback
        // 场景（一旦 mediaRoots 非空且这批目标已经过 assertDirSafe，containingRoot 必能命中同一个根）。
        const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

        expect(task!.stagingRoot).toBe(showDir) // fallback = 收窄目录本身
        expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/no configured mediaRoot contains/))
      } finally {
        errorSpy.mockRestore()
      }
    })
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

  // F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：orchestratorSkill 早就教"re-dispatching
  // a throttled-only row is YOUR call"，dispatch_find_subtitle_task 的 includeThrottled 参数把
  // 这个判断落进 payload，mapper 在这里读出来传给 listMissingEpisodesForSeries/movie stillMissing
  // 判断——没有这一步，模型的判断到了执行层照样被 recheck_after 窗口过滤器无声吃掉。
  describe('payload.includeThrottled (F-R2-4)', () => {
    it('series 分支：includeThrottled=true → 未到期 unavailable 的季也进 targets', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-throttled-series-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '100'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const path = join(showDir, 'Show.S01E01.mkv')
      writeFileSync(path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
      // 判决时刻=NOW，阶梯首次 +1 天 → 未到期（throttled，不是到期缺口）。
      lib.markUnavailable(episodeId(tmdbId, 1, 1), '搜索穷尽', NOW)

      jobsRepo.upsertWorkerTask(
        { seriesId: sId, season: null, movieId: null },
        { taskType: 'find_subtitle', seasons: null, includeThrottled: true, reason: 'operator says re-check now' },
        null, NOW,
      )
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(task!.targets.map(t => t.season)).toEqual([1])
    })

    it('series 分支：includeThrottled 省略（默认 false）→ 未到期 unavailable 仍被窗口排除（既有语义锁）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-throttled-series-default-'))
      const showDir = join(root, 'Show', 'Season 01')
      mkdirSync(showDir, { recursive: true })
      const tmdbId = '101'
      const sId = seriesId(tmdbId)

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertSeries({ id: sId, name: 'Show' })
      const path = join(showDir, 'Show.S01E01.mkv')
      writeFileSync(path, 'video')
      lib.upsertEpisode({ id: episodeId(tmdbId, 1, 1), seriesId: sId, season: 1, episode: 1, name: 'E1', path, subStatus: 'missing' })
      lib.markUnavailable(episodeId(tmdbId, 1, 1), '搜索穷尽', NOW)

      jobsRepo.upsertWorkerTask(
        { seriesId: sId, season: null, movieId: null },
        { taskType: 'find_subtitle', seasons: null, reason: 'routine dispatch' },
        null, NOW,
      )
      const job = jobsRepo.claimNext(NOW)!

      const task = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(task).toBeNull()
    })

    it('movie 分支：includeThrottled=true → 未到期 unavailable 的电影也 stillMissing（放宽判断）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-throttled-movie-'))
      const movieDir = join(root, 'Movie (2020)')
      mkdirSync(movieDir, { recursive: true })
      const videoPath = join(movieDir, 'Movie.mkv')
      writeFileSync(videoPath, 'video')
      const movieId = seriesId('556')

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertMovie({ id: movieId, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
      lib.markUnavailable(movieId, '搜索穷尽', NOW)

      jobsRepo.upsertWorkerTask(
        { seriesId: null, season: null, movieId },
        { taskType: 'find_subtitle', includeThrottled: true, reason: 'operator says re-check now' },
        null, NOW,
      )
      const job = jobsRepo.claimNext(NOW)!

      const movieTask = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(movieTask!.targets).toHaveLength(1)
    })

    it('movie 分支：includeThrottled 省略（默认 false）→ 未到期 unavailable 的电影仍是 null（既有语义锁）', async () => {
      const root = mkdtempSync(join(tmpdir(), 'find-subtitle-mapper-throttled-movie-default-'))
      const movieDir = join(root, 'Movie (2020)')
      mkdirSync(movieDir, { recursive: true })
      const videoPath = join(movieDir, 'Movie.mkv')
      writeFileSync(videoPath, 'video')
      const movieId = seriesId('557')

      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      const jobsRepo = new JobsRepo(db)
      lib.upsertMovie({ id: movieId, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
      lib.markUnavailable(movieId, '搜索穷尽', NOW)

      jobsRepo.upsertWorkerTask(
        { seriesId: null, season: null, movieId },
        { taskType: 'find_subtitle', reason: 'routine dispatch' },
        null, NOW,
      )
      const job = jobsRepo.claimNext(NOW)!

      const movieTask = await mapWorkerTaskToFindSubtitleTask(job, mapperDeps({ lib }), NOW)

      expect(movieTask).toBeNull()
    })
  })
})

/** FindSubtitleBatchReport 构造 helper：四桶默认皆空，测试按需覆写。 */
function report(over: Partial<FindSubtitleBatchReport> = {}): FindSubtitleBatchReport {
  return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], ...over }
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
// 下沉到 item 自己的 search_attempts 阶梯（见 libraryRepo.ts markUnavailable）。
// 清算波 R-6（A-F8）：jobs.completeNoMatch 当时"零调用不删"，现已确认 production 全仓
// 零调用点，随死器官处决整体删除（jobsRepo.ts 不再有这个方法）——原先在这里用 vi.spyOn
// 验证"零调用"的回归测试因此撤下：TypeScript 本身就会在任何重新写出
// `jobsRepo.completeNoMatch(...)` 调用点时报编译错误（方法已不存在），是比运行时 spy 更强
// 的保证，不需要重复验证。
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
  // （完整场景验证——见上面 describe 头注释：completeNoMatch 已删除，"零调用"由编译期保证。）
  it('全 no_safe_match 场景：job 仍走 completeDone 收尾（批量收割入账不因内容判决而卡住）', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(2)
    const runTask = vi.fn(async () => report({ no_safe_match: episodeIds.map((id) => unresolvedItem(id)) }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  // 救援R5：hardsub_assumed 是 agent 档的正面判决——markHardsubAssumed 落 sub_status，不进
  // markUnavailable 的内容退避阶梯（search_attempts/recheck_after 都不动）。
  it('hardsub_assumed: 批量逐项 markHardsubAssumed（不进退避阶梯），job 走 completeDone', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(2)
    const runTask = vi.fn(async () => report({
      hardsub_assumed: episodeIds.map((id) => unresolvedItem(id, '发布组标记+搜索已穷尽')),
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    for (const id of episodeIds) {
      const ep = lib.getEpisode(id)!
      expect(ep.sub_status).toBe('hardsub-assumed')
      expect(ep.status_reason).toBe('发布组标记+搜索已穷尽')
      // 不进退避阶梯——search_attempts 不动（初始 0），不像 markUnavailable 那样 +1。
      expect(ep.search_attempts).toBe(0)
      expect(ep.recheck_after).toBeNull()
    }
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('installed + hardsub_assumed 混合桶：两边各自入账，job 仍 completeDone', async () => {
    const { lib, jobsRepo, job, episodeIds } = setupBatch(2)
    const [installedId, hardsubId] = episodeIds
    const runTask = vi.fn(async () => report({
      installed: [installedItem(installedId)],
      hardsub_assumed: [unresolvedItem(hardsubId, 'x')],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getEpisode(installedId)!.sub_status).toBe('covered')
    expect(lib.getEpisode(hardsubId)!.sub_status).toBe('hardsub-assumed')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('hardsub_assumed 桶里的幻觉 itemId 被 dropAlien 丢弃，不入账、不炸', async () => {
    const { lib, jobsRepo, job } = setup()
    const alienId = 'tmdb:999/s9e9'
    const runTask = vi.fn(async () => report({
      hardsub_assumed: [unresolvedItem(alienId, 'x')],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getEpisode(alienId)).toBeNull()
    // 全空批（幻觉被丢弃后四桶皆空）→ error 收尾，不是 completeDone。
    expect(jobsRepo.get(job.id)!.state).toBe('failed')
    errorSpy.mockRestore()
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

  // W2（装机记账修复批，2026-07-18，审计实证 DxD/HOTD/Gracie 遍地）：agent 上报的
  // candidateProviderId 全链唯一来源就是它自己在 candidateKey() 复合形态里见过的那个 id
  // （"assrt:661405"），不是裸 providerId。原代码无条件再拼一次 provider 前缀，落库成
  // "assrt:assrt:661405" 双前缀——这里锁住修复：candidateProviderId 已含 provider 前缀时原样
  // 使用，不重复拼接。
  it('provider_ref: candidateProviderId 已含 provider 前缀（agent 复述 candidateKey 复合形态）时不重复拼接', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({
      installed: [installedItem(SHOW_EPISODE_ID, { candidateProvider: 'assrt', candidateProviderId: 'assrt:661405' })],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = lib.db.prepare('select provider_ref from subtitles where item_id=?').get(SHOW_EPISODE_ID) as { provider_ref: string }
    expect(row.provider_ref).toBe('assrt:661405')
  })

  // 防御性兜底的另一半：candidateProviderId 若真的是裸 id（不含冒号），仍要正常拼上 provider
  // 前缀——修复不能把这条路径也堵死。
  it('provider_ref: candidateProviderId 是裸 id（不含冒号）时仍正常拼接 provider 前缀', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({
      installed: [installedItem(SHOW_EPISODE_ID, { candidateProvider: 'assrt', candidateProviderId: '661405' })],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = lib.db.prepare('select provider_ref from subtitles where item_id=?').get(SHOW_EPISODE_ID) as { provider_ref: string }
    expect(row.provider_ref).toBe('assrt:661405')
  })

  // W3（装机记账修复批，观察性：坏装机事后要有判词可查）：installed item 的 reason（finalize
  // 里 agent 给出的判词）要落进该集的 status_reason——此前 markCovered 从不碰这一列，covered
  // 行的 status_reason 恒为装机前残留的旧叙事（或 null），Peacemaker 错装 5 天后无迹可查。
  it('W3: installed item 的 reason 落进该集 status_reason（装机判词可查）', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => report({
      installed: [installedItem(SHOW_EPISODE_ID, { reason: 'S3E11 season-pack 内文件名与集号完全吻合' })],
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getEpisode(SHOW_EPISODE_ID)!.status_reason).toBe('S3E11 season-pack 内文件名与集号完全吻合')
  })

  // 翻篇仍会清（F-B 逻辑不受影响）：装机判词入账之后，该集若之后又被判 no_safe_match（翻回
  // unavailable），走的是 markUnavailable 自己的写路径，会把 status_reason 换成新的失败叙事——
  // 不会永久卡着装机判词。这里用两次独立的 runFindSubtitleWorkerTask 调用模拟"翻篇"。
  it('W3: 装机判词落库后，后续翻 unavailable 仍会清（换成新的失败叙事，不背装机判词）', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask1 = vi.fn(async () => report({
      installed: [installedItem(SHOW_EPISODE_ID, { reason: '装机判词' })],
    }))
    const deps1 = baseDeps({ lib, mediaRoots: [], runTask: runTask1 })
    await runFindSubtitleWorkerTask(job, deps1, jobsRepo, () => Date.now())
    expect(lib.getEpisode(SHOW_EPISODE_ID)!.status_reason).toBe('装机判词')

    // 手工把该集重新置回 missing，模拟"下一轮巡检又发现缺口"（真实流程由 ingest.ts 完成，
    // 这里只关心 markCovered 写入的判词不会赖着不走）。
    lib.db.prepare(`UPDATE episodes SET sub_status='missing' WHERE id=?`).run(SHOW_EPISODE_ID)
    jobsRepo.upsertWorkerTask({ seriesId: SHOW_SERIES_ID, season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing again' }, null, Date.now())
    const job2 = jobsRepo.claimNext(Date.now())!
    const runTask2 = vi.fn(async () => report({
      no_safe_match: [unresolvedItem(SHOW_EPISODE_ID, '搜索穷尽（新一轮）')],
    }))
    const deps2 = baseDeps({ lib, mediaRoots: [], runTask: runTask2 })
    await runFindSubtitleWorkerTask(job2, deps2, jobsRepo, () => Date.now())

    expect(lib.getEpisode(SHOW_EPISODE_ID)!.status_reason).toBe('搜索穷尽（新一轮）')
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

    // 救援R5：hardsub_assumed 桶同 installed/no_safe_match/retry_later 的记法一致——非空即记一行。
    it('hardsub_assumed: writes one runs row with decision "hardsub_assumed" and a detail containing the itemId', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => report({
        hardsub_assumed: [unresolvedItem(SHOW_EPISODE_ID, '发布组标记+搜索已穷尽')],
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('hardsub_assumed')
      expect(rows[0].detail).toContain(SHOW_EPISODE_ID)
    })

    // 路 A（2026-07-26 识别架构）：identity_correction——agent Step 0 核验发现库身份错了
    // 并重新识别出正确条目。Phase 1 只记录不迁行：runs 单独一行（dashboard 时间线可见），
    // targets 按 skill 约定全在 no_safe_match（那行 runs 照旧记），队列语义不被纠错报告扭曲。
    it('identity_correction: writes a dedicated runs row alongside the no_safe_match row, does not distort queue semantics', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => report({
        no_safe_match: [unresolvedItem(SHOW_EPISODE_ID, 'identity mismatch: season table does not contain S03')],
        identity_correction: { tmdbId: '271828', isTv: true, reason: 'raw dir name 后室 matches Backrooms (2022), season table fits' },
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      const decisions = rows.map((r) => r.decision)
      expect(decisions).toContain('no_safe_match')
      expect(decisions).toContain('identity_correction')
      const correctionRow = rows.find((r) => r.decision === 'identity_correction')!
      expect(correctionRow.detail).toContain('tmdb:271828')
      expect(correctionRow.detail).toContain('Backrooms')
      // 队列语义：no_safe_match 非空 → completeDone（纠错报告不该让 job 走 error 轨）
      const jobRow = db.prepare(`SELECT state FROM jobs WHERE id = ?`).get(job.id) as { state: string }
      expect(jobRow.state).toBe('done')
    })

    it('identity_correction 缺席（核验通过的常规 run）：不多记任何行', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows.map((r) => r.decision)).toEqual(['installed'])
    })
  })

  // 路 A Phase 1b（2026-07-26）：identity_correction 的**真正落地**——写一条 identify_overrides
  // 认领（复用 P6 人工认领的同一机制，认领者从人变成 agent），下一轮 ingest 的 recognize()
  // 消歧前查命中它按正确身份建行，旧错身份行由 ingest 的"同路径换身份"分支清理。刻意不手写
  // id 迁移（own-id 链 + 五张表外键，中途崩溃无幂等恢复点）——见 runner 实现处的长注释。
  describe('identity_correction 落地为 identify_overrides 认领（Phase 1b）', () => {
    it('写入认领：findOverride(目标路径) 能查到 agent 纠正后的身份', async () => {
      const { lib, jobsRepo, job, videoPath } = setup()
      const runTask = vi.fn(async () => report({
        no_safe_match: [unresolvedItem(SHOW_EPISODE_ID, 'identity mismatch')],
        identity_correction: { tmdbId: '276161', isTv: true, reason: 'season table + runtime fit' },
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask })

      // 前置：没有任何认领
      expect(lib.findOverride(videoPath)).toBeNull()

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      // 认领已落地，且对这批 target 的路径可查（path_prefix = task.mediaRoot，即目标公共祖先）
      const override = lib.findOverride(videoPath)
      expect(override).not.toBeNull()
      expect(override!.tmdbId).toBe('276161')
      expect(override!.isTv).toBe(true)
    })

    it('清停车户口：纠错后该路径的 parked 行被清掉，下一轮 ingest 必重新识别（不被退避挡住）', async () => {
      const { lib, jobsRepo, job, videoPath } = setup()
      // 模拟这条路径身上残留的停车户口（旧身份时代累积的）
      lib.upsertParkedPath(videoPath, 'no-episode-number', Date.now(), { mtimeMs: 1, size: 2 })
      expect(lib.listParkedPaths().some((p) => p.path === videoPath)).toBe(true)

      const runTask = vi.fn(async () => report({
        no_safe_match: [unresolvedItem(SHOW_EPISODE_ID, 'identity mismatch')],
        identity_correction: { tmdbId: '276161', isTv: true, reason: 'evidence' },
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      expect(lib.listParkedPaths().some((p) => p.path === videoPath)).toBe(false)
    })

    it('核验通过（无 correction）：不写任何认领，不碰停车户口', async () => {
      const { lib, jobsRepo, job, videoPath } = setup()
      const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      expect(lib.findOverride(videoPath)).toBeNull()
    })

    it('认领幂等：同一 mediaRoot 二次纠错覆盖旧认领（ON CONFLICT），不堆重复行', async () => {
      const { lib, jobsRepo, job, videoPath, db } = setup()
      const runCorrection = async (
        currentJob: typeof job, jobsFor: JobsRepo, tmdbId: string, reason: string,
      ) => {
        const deps = baseDeps({
          lib, mediaRoots: [],
          runTask: vi.fn(async () => report({
            no_safe_match: [unresolvedItem(SHOW_EPISODE_ID, 'identity mismatch')],
            identity_correction: { tmdbId, isTv: true, reason },
          })),
        })
        await runFindSubtitleWorkerTask(currentJob, deps, jobsFor, () => Date.now())
      }

      await runCorrection(job, jobsRepo, '111', 'first')
      expect(lib.findOverride(videoPath)!.tmdbId).toBe('111')

      // 二次纠错：把 e1 的缺口恢复（上一轮 no_safe_match 把它标成了 unavailable），再派一个
      // 同 season 的新 job——mediaRoot 相同，认领应被覆盖而非新增一行。
      lib.upsertEpisode({
        id: SHOW_EPISODE_ID, seriesId: SHOW_SERIES_ID, season: 1, episode: 1, name: 'E1',
        path: videoPath, subStatus: 'missing',
      })
      const jobsRepo2 = new JobsRepo(db)
      jobsRepo2.upsertWorkerTask(
        { seriesId: SHOW_SERIES_ID, season: 1, movieId: null },
        { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now() + 1,
      )
      const jobAgain = jobsRepo2.claimNext(Date.now() + 1)!
      await runCorrection(jobAgain, jobsRepo2, '222', 'second')

      expect(lib.findOverride(videoPath)!.tmdbId).toBe('222')
      const count = db.prepare(`SELECT COUNT(*) AS n FROM identify_overrides`).get() as { n: number }
      expect(count.n).toBe(1)
    })
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

    // G3（痕迹通道 C）：runKey 拼法必须与 findSubtitleWorker.ts 的 onStepEvent 接线处对齐
    // （`job-${job.id}`）——这里不跑真 agent，直接模拟 agent 跑过程中会往 traceBus 发布的事件，
    // 断言 runFindSubtitleWorkerTask 的收官落账把它们原样快照进 trace_json。
    describe('trace_json 收官快照（G3）', () => {
      it('installed: trace_json 携带 traceBus 缓冲里该 runKey 的全量事件', async () => {
        const { lib, jobsRepo, job, db } = setup()
        const runs = new RunsRepo(db)
        const runKey = `job-${job.id}`
        traceBus.publish({ runKey, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 10, at: 1 })
        traceBus.publish({ runKey, seq: 1, tool: 'download_candidate', argsSummary: '{}', resultSummary: '{}', tookMs: 20, at: 2 })
        const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
        const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

        await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

        const rows = runs.getByJobId(job.id)
        expect(rows).toHaveLength(1)
        const parsed = JSON.parse(rows[0].trace_json!) as TraceEvent[]
        expect(parsed).toHaveLength(2)
        expect(parsed.map((e) => e.tool)).toEqual(['search_source', 'download_candidate'])
        // snapshot 有清空副作用——第二次读同一个 runKey 必须是空的。
        expect(traceBus.snapshot(runKey)).toHaveLength(0)
      })

      it('未发布任何痕迹事件时 trace_json 落 null，不写 "[]" 噪音', async () => {
        const { lib, jobsRepo, job, db } = setup()
        const runs = new RunsRepo(db)
        const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
        const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

        await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

        const rows = runs.getByJobId(job.id)
        expect(rows[0].trace_json).toBeNull()
      })

      it('混合报告写 3 行 runs 时，三行共享同一份 trace_json（snapshot 只真正调用一次，不因多行清空丢数据）', async () => {
        const { lib, jobsRepo, job, db, episodeIds } = setupBatch(3)
        const runs = new RunsRepo(db)
        const runKey = `job-${job.id}`
        traceBus.publish({ runKey, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 5, at: 1 })
        const [installedId, noMatchId, retryId] = episodeIds
        const runTask = vi.fn(async () => report({
          installed: [installedItem(installedId)],
          no_safe_match: [unresolvedItem(noMatchId, '搜索穷尽')],
          retry_later: [unresolvedItem(retryId, 'provider timed out')],
        }))
        const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

        await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

        const rows = runs.getByJobId(job.id)
        expect(rows).toHaveLength(3)
        const traceJsons = rows.map((r) => r.trace_json)
        expect(traceJsons.every((t) => t !== null)).toBe(true)
        expect(new Set(traceJsons).size).toBe(1) // 三行的 trace_json 逐字节相同——同一次快照。
        expect(JSON.parse(traceJsons[0]!)).toHaveLength(1)
      })

      // 复审修复（可选链短路陷阱）：recordRun 曾把 traceJsonForThisRun() 留在 deps.runs?.insert
      // 的实参位置——deps.runs 缺席时可选链连实参求值一起短路，快照永不排空：残留会污染同 job
      // 重试的快照，且未排空的 runKey 缓冲随 job 数量增长无上界。排空必须无条件发生。
      it('deps.runs 缺席时缓冲同样被排空（runs 缺席=只排空不落账，不许连快照一起短路）', async () => {
        const { lib, jobsRepo, job } = setup()
        const runKey = `job-${job.id}`
        traceBus.publish({ runKey, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 1, at: 1 })
        const runTask = vi.fn(async () => report({ installed: [installedItem(SHOW_EPISODE_ID)] }))
        const deps = baseDeps({ lib, mediaRoots: [], runTask }) // no `runs`

        await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

        expect(traceBus.snapshot(runKey)).toHaveLength(0)
      })

      it('worker 抛错（catch 路径）时缓冲同样被排空，快照附在 error 行上', async () => {
        const { lib, jobsRepo, job, db } = setup()
        const runs = new RunsRepo(db)
        const runKey = `job-${job.id}`
        traceBus.publish({ runKey, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 1, at: 1 })
        const runTask = vi.fn(async () => { throw new Error('step count limit exceeded') })
        const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

        await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

        const rows = runs.getByJobId(job.id)
        expect(rows).toHaveLength(1)
        expect(rows[0].decision).toBe('error')
        expect(JSON.parse(rows[0].trace_json!)).toHaveLength(1)
        expect(traceBus.snapshot(runKey)).toHaveLength(0) // 无残留
      })
    })
})
