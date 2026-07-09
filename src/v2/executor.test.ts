import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { executeJob, type ExecutorDeps } from './executor.js'
import type { Job } from './jobsRepo.js'

let lib: LibraryRepo
let jobs: JobsRepo
let runs: RunsRepo
let now: number

beforeEach(() => {
  const db = openDb(':memory:')
  lib = new LibraryRepo(db)
  jobs = new JobsRepo(db)
  runs = new RunsRepo(db)
  now = Date.now()
})

const mkEpisode = (id: string, seriesId: string, season: number, episode: number, subStatus: 'missing' | 'covered' = 'missing') => {
  lib.upsertSeries({ id: seriesId, name: 'Test Series' })
  lib.upsertEpisode({ id, seriesId, season, episode, name: `Episode ${episode}`, path: `/tv/s${season}e${episode}.mkv`, subStatus })
}

const mkMovie = (id: string, subStatus: 'missing' | 'covered' = 'missing') => {
  lib.upsertMovie({ id, name: 'Test Movie', path: '/movies/test.mkv', subStatus })
}

describe('executor', () => {
  it('重derive targets：跑前用户手动放了字幕的集不再处理', async () => {
    // Setup: 3 episodes, e1 is manually covered, e2 and e3 are missing
    mkEpisode('e1', 's1', 1, 1, 'covered')
    mkEpisode('e2', 's1', 1, 2)
    mkEpisode('e3', 's1', 1, 3)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: only e2 is representative (min episode number among missing)
    const runEpisode = vi.fn(async (episodeId: string) => {
      expect(episodeId).toBe('e2') // Should pick e2, not e1 (covered)
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Downloaded successfully' }
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify runEpisode was called with e2 (the min episode number among missing)
    expect(runEpisode).toHaveBeenCalledTimes(1)
  })

  it('季包覆盖：runEpisode stub 触发 onCovered(e1..e3) → 三集 covered + job done + runs 记录', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    mkEpisode('e3', 's1', 1, 3)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: season pack covers all 3 episodes via onCovered callback
    const runEpisode = vi.fn(async (episodeId: string, onCovered) => {
      expect(episodeId).toBe('e1')
      // Simulate season pack covering all episodes
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      onCovered('e2', '/tv/s1e2.zh-Hans.srt')
      onCovered('e3', '/tv/s1e3.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Season pack downloaded' }
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify all 3 episodes are covered
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e2')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e3')!.sub_status).toBe('covered')

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')

    // Verify runs record exists
    const runRecords = runs.getByJobId(job.id)
    expect(runRecords.length).toBe(1)
    expect(runRecords[0].decision).toBe('download')
    expect(runRecords[0].detail).toBe('Season pack downloaded')
  })

  it('部分覆盖：只 covered e1 → completePartial（job 回 wanted, attempt-1），已覆盖战果保留', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    mkEpisode('e3', 's1', 1, 3)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    // Simulate a previous failure
    jobs.completeNoMatch(job.id, now)
    const job2 = jobs.forceClaim('s1', 1, now)!
    expect(job2.attempt).toBe(1)

    // Mock runEpisode: only covers e1
    const runEpisode = vi.fn(async (episodeId: string, onCovered) => {
      expect(episodeId).toBe('e1')
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Partial coverage' }
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job2, deps)

    // Verify e1 is covered but e2, e3 are still missing
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e2')!.sub_status).toBe('missing')
    expect(lib.getEpisode('e3')!.sub_status).toBe('missing')

    // Verify job is back to wanted with attempt decremented
    const finalJob = jobs.get(job2.id)!
    expect(finalJob.state).toBe('wanted')
    expect(finalJob.attempt).toBe(0) // decremented from 1
  })

  it('全军覆没 no_safe_match → completeNoMatch + 未覆盖集标记 unavailable', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: no match found
    const runEpisode = vi.fn(async () => {
      return { decision: 'no_safe_match', journalPath: '/journals/test.json', detail: 'No safe match found' }
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify episodes are marked as unavailable
    const ep1 = lib.getEpisode('e1')!
    const ep2 = lib.getEpisode('e2')!
    expect(ep1.sub_status).toBe('unavailable')
    expect(ep2.sub_status).toBe('unavailable')
    expect(ep1.recheck_after).toBeGreaterThan(now)
    expect(ep2.recheck_after).toBeGreaterThan(now)

    // Verify job is failed (or dormant after multiple attempts)
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
  })

  it('runEpisode 抛错 → completeError，短退避', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: throws error
    const runEpisode = vi.fn(async () => {
      throw new Error('ASSRT API timeout')
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify job is failed with error
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    expect(finalJob.last_error).toContain('ASSRT API timeout')
    expect(finalJob.next_retry_at).toBeDefined()
    expect(finalJob.next_retry_at! - now).toBeLessThanOrEqual(10 * 60_000 + 1000) // short backoff
  })

  it('movie job 同构', async () => {
    mkMovie('m1')
    jobs.upsertWanted({ kind: 'movie', movieId: 'm1' }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: movie download
    const runEpisode = vi.fn(async (itemId: string) => {
      expect(itemId).toBe('m1')
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Movie downloaded' }
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify movie is covered
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')
  })

  it('代表集自身被搞定但未走季包：download/already_exists/adopted → 对代表集 markCovered', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: only representative episode covered (no season pack callback)
    const runEpisode = vi.fn(async (episodeId: string) => {
      expect(episodeId).toBe('e1')
      // No onCovered callback, but decision is download with subtitlePath
      return { decision: 'download', journalPath: '/journals/test.json', detail: '/tv/s1e1.zh-Hans.srt' }
    })

    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify e1 is covered
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')

    // Verify e2 is still missing
    expect(lib.getEpisode('e2')!.sub_status).toBe('missing')

    // Verify job is partial (back to wanted since e2 still missing)
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('wanted')
  })

  it('targets 为空时直接 completeDone', async () => {
    // Setup: all episodes already covered
    mkEpisode('e1', 's1', 1, 1, 'covered')
    mkEpisode('e2', 's1', 1, 2, 'covered')
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn()
    const deps: ExecutorDeps = { lib, jobs, runEpisode, now: () => now }
    await executeJob(job, deps)

    // Verify runEpisode was never called
    expect(runEpisode).not.toHaveBeenCalled()

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')
  })
})
