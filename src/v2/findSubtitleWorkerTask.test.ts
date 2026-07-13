import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'
import { runFindSubtitleWorkerTask, type FindSubtitleWorkerTaskDeps } from './findSubtitleWorkerTask.js'
import type { PlayerServer } from '../adapters/players/types.js'
import type { FindSubtitleDecision, FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'

function mkJf(path: string, overrides: Partial<Pick<PlayerServer, 'getItem' | 'getChineseTitle'>> = {}) {
  return {
    getItem: vi.fn(async () => ({
      Id: 'jf-ep-1', Name: 'E1', Type: 'Episode', Path: path,
      SeriesId: 's1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1,
    }) as never),
    getChineseTitle: vi.fn(async () => null),
    ...overrides,
  }
}

function decision(over: Partial<FindSubtitleDecision> = {}): FindSubtitleDecision {
  return {
    decision: 'installed', reason: 'looks right', installedPath: null,
    installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
    ...over,
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'find-subtitle-worker-task-'))
  const showDir = join(root, 'Show', 'Season 01')
  mkdirSync(showDir, { recursive: true })
  const videoPath = join(showDir, 'Show.S01E01.mkv')
  writeFileSync(videoPath, 'video')

  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  lib.upsertSeries({ id: 's1', name: 'Show' })
  lib.upsertEpisode({ id: 'jf-ep-1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: videoPath, subStatus: 'missing' })
  jobsRepo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
  const job = jobsRepo.claimNext(Date.now())!
  return { root, videoPath, db, lib, jobsRepo, job }
}

function baseDeps(over: Partial<FindSubtitleWorkerTaskDeps> = {}, videoPath?: string): FindSubtitleWorkerTaskDeps {
  return {
    lib: over.lib!,
    jf: mkJf(videoPath ?? '/x'),
    tmdb: null,
    mappings: [],
    mediaRoots: [],
    runTask: vi.fn(async () => decision()),
    ...over,
  }
}

describe('runFindSubtitleWorkerTask', () => {
  it('installs: maps the worker_task row to a FindSubtitleTask, marks the episode covered, and completes the job done', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async (_task: FindSubtitleTask) => decision({ installedPath: join(videoPath, '..', 'x.srt'), candidateProvider: 'assrt', candidateProviderId: '123' }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask }, videoPath)

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result?.decision).toBe('installed')
    expect(runTask).toHaveBeenCalledTimes(1)
    const task = runTask.mock.calls[0][0]
    expect(task.jobId).toBe(String(job.id))
    expect(task.title).toBe('Show')
    expect(task.season).toBe(1)
    expect(task.episode).toBe(1)

    expect(lib.getEpisode('jf-ep-1')!.sub_status).toBe('covered')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('movie identity: resolves the movie row (not an episode) and marks it covered', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-worker-task-movie-'))
    const movieDir = join(root, 'Movie (2020)')
    mkdirSync(movieDir, { recursive: true })
    const videoPath = join(movieDir, 'Movie.mkv')
    writeFileSync(videoPath, 'video')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    lib.upsertMovie({ id: 'jf-movie-1', name: 'Movie', path: videoPath, subStatus: 'missing' })
    jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId: 'jf-movie-1' }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const jf = {
      getItem: vi.fn(async () => ({ Id: 'jf-movie-1', Name: 'Movie', Type: 'Movie', Path: videoPath, ProductionYear: 2020 }) as never),
      getChineseTitle: vi.fn(async () => null),
    }
    const runTask = vi.fn(async () => decision())
    const deps = baseDeps({ lib, jf, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getMovie('jf-movie-1')!.sub_status).toBe('covered')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('idempotent no-op: if the target is already covered by claim time, completes the job done WITHOUT ever invoking the worker', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.markCovered('jf-ep-1', null, 'preexisting') // covered out-of-band before the worker claims this row
    const runTask = vi.fn(async () => decision())
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result).toBeNull()
    expect(runTask).not.toHaveBeenCalled()
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('retry_later: completes the job as a retryable error (short backoff), does not touch LibraryRepo coverage', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => decision({ decision: 'retry_later', reason: 'provider timed out' }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask }, videoPath)

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toBe('provider timed out')
    expect(lib.getEpisode('jf-ep-1')!.sub_status).toBe('missing') // untouched
  })

  it('no_safe_match: completes the job via content-backoff and marks the episode unavailable with a recheck_after', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => decision({ decision: 'no_safe_match', reason: '没有找到匹配的字幕' }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask }, videoPath)

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    const ep = lib.getEpisode('jf-ep-1')!
    expect(ep.sub_status).toBe('unavailable')
    expect(ep.status_reason).toBe('没有找到匹配的字幕')
    expect(ep.recheck_after).not.toBeNull()
  })

  it('worker-exhaustion: a thrown worker invocation (step-cap/timeout/abort) fails the job via completeError instead of propagating', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => { throw new Error('step count limit exceeded') })
    const deps = baseDeps({ lib, mediaRoots: [], runTask }, videoPath)

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
})
