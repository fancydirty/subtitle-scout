import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import { runFindSubtitleWorkerTask, type FindSubtitleWorkerTaskDeps } from './findSubtitleWorkerTask.js'
import type { FindSubtitleDecision, FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { seriesId, episodeId } from './ownIds.js'

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
  it('installs: maps the worker_task row to a FindSubtitleTask, marks the episode covered, and completes the job done', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async (_task: FindSubtitleTask) => decision({ installedPath: join(videoPath, '..', 'x.srt'), candidateProvider: 'assrt', candidateProviderId: '123' }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result?.decision).toBe('installed')
    expect(runTask).toHaveBeenCalledTimes(1)
    const task = runTask.mock.calls[0][0]
    expect(task.jobId).toBe(String(job.id))
    expect(task.title).toBe('Show')
    expect(task.season).toBe(1)
    expect(task.episode).toBe(1)

    expect(lib.getEpisode(SHOW_EPISODE_ID)!.sub_status).toBe('covered')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  // A2: markCovered's language fallback used to be a hardcoded 'zh-Hans' no matter the task's
  // actual target language. It must now fall back to task.targetLanguage instead — a defensive
  // last resort for the rare case the worker finalizes 'installed' without installedLanguage set.
  it('markCovered records task.targetLanguage (not a hardcoded zh-Hans) when the decision omits installedLanguage', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => decision({
      installedPath: join(videoPath, '..', 'x.srt'), installedLanguage: null,
      candidateProvider: 'assrt', candidateProviderId: '123',
    }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = lib.db.prepare('select language from subtitles where item_id=?').get(SHOW_EPISODE_ID) as { language: string }
    // deps.targetLanguage is unset here, so the mapper's own default ('zh') is what flows through
    // — the point is the fallback source (task.targetLanguage), not the value.
    expect(row.language).toBe('zh')
  })

  // Spec-review fix #1 (A1's "A4 接配置"): the task's targetLanguage comes from configuration
  // (deps.targetLanguage, wired from TARGET_LANGUAGES' primary entry in cli/index.ts), not a
  // hardcoded 'zh'. With TARGET_LANGUAGES=en, dispatched workers must hunt English subtitles.
  it('threads deps.targetLanguage into the constructed FindSubtitleTask (en config → en task)', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async (_task: FindSubtitleTask) => decision({ installedPath: join(videoPath, '..', 'x.srt') }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask, targetLanguage: 'en' })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(runTask.mock.calls[0][0].targetLanguage).toBe('en')
  })

  it('deps.targetLanguage omitted → task.targetLanguage defaults to zh (historical default)', async () => {
    const { videoPath, lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async (_task: FindSubtitleTask) => decision({ installedPath: join(videoPath, '..', 'x.srt') }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(runTask.mock.calls[0][0].targetLanguage).toBe('zh')
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
    const movieId = seriesId('603')
    lib.upsertMovie({ id: movieId, name: 'Movie', path: videoPath, subStatus: 'missing', year: 2020 })
    jobsRepo.upsertWorkerTask({ seriesId: null, season: null, movieId }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const runTask = vi.fn(async () => decision())
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(lib.getMovie(movieId)!.sub_status).toBe('covered')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

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

  it('no_safe_match: completes the job via content-backoff and marks the episode unavailable with a recheck_after', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => decision({ decision: 'no_safe_match', reason: '没有找到匹配的字幕' }))
    const deps = baseDeps({ lib, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    const ep = lib.getEpisode(SHOW_EPISODE_ID)!
    expect(ep.sub_status).toBe('unavailable')
    expect(ep.status_reason).toBe('没有找到匹配的字幕')
    expect(ep.recheck_after).not.toBeNull()
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

  // 去 Jellyfin 化 P4: absoluteEpisode's tmdbId now comes straight off the SERIES row's own id
  // (tmdbIdFromOwnId(series.id)) — no more round-trip through a Jellyfin item lookup to read the
  // series' ProviderIds.Tmdb. This fixture seeds the series id AS 'tmdb:9999' so that extraction
  // resolves for real against a real TmdbClient (fetchImpl-backed, no live network).
  it('computes absoluteEpisode from TMDB season-concat data when tmdb is configured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'find-subtitle-worker-task-abs-'))
    const showDir = join(root, 'Show', 'Season 02')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, 'Show.S02E01.mkv')
    writeFileSync(videoPath, 'video')

    const db = openDb(':memory:')
    const lib = new LibraryRepo(db)
    const jobsRepo = new JobsRepo(db)
    const sId = seriesId('9999')
    lib.upsertSeries({ id: sId, name: 'Show' })
    lib.upsertEpisode({ id: episodeId('9999', 2, 1), seriesId: sId, season: 2, episode: 1, name: 'E1', path: videoPath, subStatus: 'missing' })
    jobsRepo.upsertWorkerTask({ seriesId: sId, season: 2, movieId: null }, { taskType: 'find_subtitle', reason: 'missing' }, null, Date.now())
    const job = jobsRepo.claimNext(Date.now())!

    const fetchImpl = async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/episode_groups')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      if (u.includes('/translations')) return new Response(JSON.stringify({ translations: [] }), { status: 200 })
      if (u.includes('/alternative_titles')) return new Response(JSON.stringify({ results: [] }), { status: 200 })
      if (u.includes('/tv/9999')) {
        return new Response(JSON.stringify({
          seasons: [
            { season_number: 1, episode_count: 25, air_date: null },
            { season_number: 2, episode_count: 12, air_date: null },
          ],
        }), { status: 200 })
      }
      throw new Error(`unexpected TMDB fetch in test: ${u}`)
    }
    const tmdb = new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl: fetchImpl as unknown as typeof fetch })

    const runTask = vi.fn(async (_task: FindSubtitleTask) => decision())
    const deps = baseDeps({ lib, tmdb, mediaRoots: [], runTask })

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(runTask).toHaveBeenCalledTimes(1)
    const task = runTask.mock.calls[0][0]
    expect(task.season).toBe(2)
    expect(task.episode).toBe(1)
    expect(task.absoluteEpisode).toBe(26) // 25 (season 1) + episode 1 of season 2
  })

  it('absoluteEpisode is null when deps.tmdb is not configured', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async (_task: FindSubtitleTask) => decision())
    const deps = baseDeps({ lib, mediaRoots: [], runTask }) // baseDeps defaults tmdb to null

    await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(runTask).toHaveBeenCalledTimes(1)
    const task = runTask.mock.calls[0][0]
    expect(task.absoluteEpisode).toBeNull()
  })

  // 退役T1 (W0-3a): v3 runner writes a `runs` row at each terminal outcome so the dashboard's
  // run-history timeline (which reads the `runs` table) has parity with the old pipeline while
  // it's still live. `runs` is optional on the deps — these tests both prove the row shape when
  // present and prove the runner doesn't crash when it's absent (existing tests above already
  // exercise the absent case implicitly since baseDeps never sets `runs`).
  describe('runs row (timeline parity, 退役T1)', () => {
    it('installed: writes one runs row with decision "installed" and a detail containing the worker reason', async () => {
      const { videoPath, lib, jobsRepo, job, db } = setup()
      const runs = new RunsRepo(db)
      const runTask = vi.fn(async () => decision({
        installedPath: join(videoPath, '..', 'x.srt'), reason: 'best match: S01E01.zh.srt',
      }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask, runs })

      await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('installed')
      expect(rows[0].detail).toContain('best match: S01E01.zh.srt')
      expect(rows[0].journal_path).toBeNull()
    })

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

    it('deps.runs omitted: does not crash and simply skips writing a runs row', async () => {
      const { videoPath, lib, jobsRepo, job } = setup()
      const runTask = vi.fn(async () => decision({ installedPath: join(videoPath, '..', 'x.srt') }))
      const deps = baseDeps({ lib, mediaRoots: [], runTask }) // no `runs` key at all

      const result = await runFindSubtitleWorkerTask(job, deps, jobsRepo, () => Date.now())

      expect(result?.decision).toBe('installed')
      expect(jobsRepo.get(job.id)!.state).toBe('done')
    })
  })
})
