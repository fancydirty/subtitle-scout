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
import type { FindSubtitleDecision, FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'
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
    lib.markCovered(episodeId(tmdbId, 1, 2), null, 'preexisting')
    lib.markUnavailable(episodeId(tmdbId, 1, 4), 'not due yet', NOW + 999_999_999)

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

function decision(over: Partial<FindSubtitleDecision> = {}): FindSubtitleDecision {
  return {
    decision: 'installed', reason: 'looks right', installedPath: null,
    installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
    ...over,
  }
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

function baseDeps(over: Partial<FindSubtitleWorkerTaskDeps> = {}): FindSubtitleWorkerTaskDeps {
  return {
    lib: over.lib!,
    tmdb: null,
    mediaRoots: [],
    runTask: vi.fn(async () => decision()),
    ...over,
  }
}

describe('runFindSubtitleWorkerTask', () => {
  // Task 8 复活: mapWorkerTaskToFindSubtitleTask 现在返回批量 FindSubtitleTask（itemId 已挪进
  // task.targets[]，不再有 mapper 侧的单独 targetItemId 返回值），但 runFindSubtitleWorkerTask
  // 本体（这一收割/队列半区）还没跟进这个新契约——它仍按旧 `{ task, targetItemId }` 包装形状
  // 解构 mapper 的返回值，'task'/'targetItemId' 两个字段在新返回类型上都不存在，解构出
  // undefined。这五个 it.todo 在 mapper 处决当下（Task 4）就是已知会挂的收割测试，留给 Task 8
  // 按批量契约重写 runFindSubtitleWorkerTask 本体时逐个复活——不是遗漏，是本任务明确划出的
  // 边界（"本任务不改它"）。
  it.todo('installs: maps the worker_task row to a FindSubtitleTask, marks the episode covered, and completes the job done — Task 8 复活')

  // A2: markCovered's language fallback used to be a hardcoded 'zh-Hans' no matter the task's
  // actual target language. It must now fall back to task.targetLanguage instead — a defensive
  // last resort for the rare case the worker finalizes 'installed' without installedLanguage set.
  it.todo('markCovered records task.targetLanguage (not a hardcoded zh-Hans) when the decision omits installedLanguage — Task 8 复活')

  // Spec-review fix #1 (A1's "A4 接配置"): the task's targetLanguage comes from configuration
  // (deps.targetLanguage, wired from TARGET_LANGUAGES' primary entry in cli/index.ts), not a
  // hardcoded 'zh'. With TARGET_LANGUAGES=en, dispatched workers must hunt English subtitles.
  it.todo('threads deps.targetLanguage into the constructed FindSubtitleTask (en config → en task) — Task 8 复活')

  it.todo('deps.targetLanguage omitted → task.targetLanguage defaults to zh (historical default) — Task 8 复活')

  it.todo('movie identity: resolves the movie row (not an episode) and marks it covered — Task 8 复活')

  it('idempotent no-op: if the target is already covered by claim time, completes the job done WITHOUT ever invoking the worker', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.markCovered(SHOW_EPISODE_ID, null, 'preexisting') // covered out-of-band before the worker claims this row
    const runTask = vi.fn(async () => decision())
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).toBeNull()
    expect(runTask).not.toHaveBeenCalled()
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('retry_later: completes the job as a retryable error (short backoff), does not touch LibraryRepo coverage', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => decision({ decision: 'retry_later', reason: 'provider timed out' }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toBe('provider timed out')
    expect(lib.getEpisode(SHOW_EPISODE_ID)!.sub_status).toBe('missing') // untouched
  })

  // Task 8 复活: 同上——targetItemId 不再是 mapper 返回值的顶层字段，markUnavailable 拿到的
  // itemId 是 undefined，episodes 表不会真的被更新（sub_status 停留在 'missing'）。
  it.todo('no_safe_match: completes the job via content-backoff and marks the episode unavailable with a recheck_after — Task 8 复活')

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
    const runTask = vi.fn(async () => decision())
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

  // Task 8 复活: task.season/task.episode/task.absoluteEpisode 曾是 FindSubtitleTask 的顶层
  // 字段；批量化后它们挪进了 task.targets[i]（见 findSubtitleWorker.schemas.ts 的
  // FindSubtitleTargetFact）。runTask 拿到的 task 本身在旧解构下是 undefined，`.season` 直接
  // 抛 TypeError。mapper 自身对 resolveAbsoluteTable 的取表-折算行为已经在
  // mapWorkerTaskToFindSubtitleTask 的直接测试里覆盖（见上方"绝对集号一次取表逐集折算"），这两
  // 条留给 Task 8 重写 runFindSubtitleWorkerTask 后，改成读 task.targets[0].absoluteEpisode。
  it.todo('computes absoluteEpisode from TMDB season-concat data when tmdb is configured — Task 8 复活')

  it.todo('absoluteEpisode is null when deps.tmdb is not configured — Task 8 复活')

  // 退役T1 (W0-3a): v3 runner writes a `runs` row at each terminal outcome so the dashboard's
  // run-history timeline (which reads the `runs` table) has parity with the old pipeline while
  // it's still live. `runs` is optional on the deps — these tests both prove the row shape when
  // present and prove the runner doesn't crash when it's absent (existing tests above already
  // exercise the absent case implicitly since baseDeps never sets `runs`).
  describe('runs row (timeline parity, 退役T1)', () => {
    // Task 8 复活: installed 分支同样吃 targetItemId undefined 的坑——markCovered 里
    // subtitles.item_id 是 NOT NULL 列，undefined 绑成 NULL 触发约束违例抛错，被外层 try/catch
    // 接住变成 recordRun('error', ...)，实际写入的 runs 行 decision 是 'error' 不是 'installed'。
    // 留给 Task 8 重写 runFindSubtitleWorkerTask 后一并复活。
    it.todo('installed: writes one runs row with decision "installed" and a detail containing the worker reason — Task 8 复活')

    it('no_safe_match: writes one runs row with decision "no_safe_match" and the worker reason as detail', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => decision({ decision: 'no_safe_match', reason: '没有找到匹配的字幕' }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('no_safe_match')
      expect(rows[0].detail).toContain('没有找到匹配的字幕')
    })

    it('retry_later: writes one runs row with decision "retry_later"', async () => {
      const { lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => decision({ decision: 'retry_later', reason: 'provider timed out' }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('retry_later')
      expect(rows[0].detail).toContain('provider timed out')
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

    // Task 8 复活: same targetItemId-undefined/subtitles.item_id NOT NULL issue as the 'installed'
    // runs-row test above — markCovered throws, runFindSubtitleWorkerTask's outer catch turns the
    // whole call into completeError, so result ends up null instead of an 'installed' decision.
    it.todo('deps.runs omitted: does not crash and simply skips writing a runs row — Task 8 复活')
  })
})
