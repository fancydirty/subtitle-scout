import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'
import { aggregate } from './aggregator.js'

let lib: LibraryRepo
let jobs: JobsRepo
let now: number

beforeEach(() => {
  const db = openDb(':memory:')
  lib = new LibraryRepo(db)
  jobs = new JobsRepo(db)
  now = Date.now()
})

describe('aggregator', () => {
  it('creates jobs for missing seasons', () => {
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'missing',
    })
    lib.upsertEpisode({
      id: 'e2',
      seriesId: 's1',
      season: 1,
      episode: 2,
      name: 'Ep2',
      path: '/tv/s1/e2.mkv',
      subStatus: 'missing',
    })

    const result = aggregate(lib, jobs, now)

    expect(result.created).toBe(1)
    expect(result.retired).toBe(0)
    expect(jobs.countByState('wanted')).toBe(1)
    const job = jobs.find('s1', 1)
    expect(job).toBeTruthy()
    expect(job!.kind).toBe('series_season')
    expect(job!.series_id).toBe('s1')
    expect(job!.season).toBe(1)
  })

  it('creates jobs for missing movies', () => {
    lib.upsertMovie({
      id: 'm1',
      name: 'Movie A',
      path: '/movies/m1.mkv',
      subStatus: 'missing',
    })

    const result = aggregate(lib, jobs, now)

    expect(result.created).toBe(1)
    expect(result.retired).toBe(0)
    expect(jobs.countByState('wanted')).toBe(1)
  })

  it('is idempotent: second run does not duplicate jobs', () => {
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'missing',
    })

    aggregate(lib, jobs, now)
    const result = aggregate(lib, jobs, now + 1000)

    expect(result.created).toBe(0) // No new jobs created
    expect(result.retired).toBe(0)
    expect(jobs.countByState('wanted')).toBe(1)
  })

  it('retires wanted job when season becomes fully covered', () => {
    // Setup: create missing episode and job
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'missing',
    })
    aggregate(lib, jobs, now)
    expect(jobs.countByState('wanted')).toBe(1)

    // Cover the episode
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'covered',
    })

    // Aggregate again — job should be retired
    const result = aggregate(lib, jobs, now + 1000)

    expect(result.created).toBe(0)
    expect(result.retired).toBe(1)
    expect(jobs.countByState('wanted')).toBe(0)
    expect(jobs.countByState('done')).toBe(1)
  })

  it('retires failed job when season becomes fully covered', () => {
    // Setup: create missing episode and job
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'missing',
    })
    aggregate(lib, jobs, now)
    const job = jobs.find('s1', 1)!

    // Simulate job failure
    jobs.forceState('s1', 1, 'failed', now)
    expect(jobs.countByState('failed')).toBe(1)

    // Cover the episode
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'covered',
    })

    // Aggregate again — failed job should be retired
    const result = aggregate(lib, jobs, now + 1000)

    expect(result.created).toBe(0)
    expect(result.retired).toBe(1)
    expect(jobs.countByState('failed')).toBe(0)
    expect(jobs.countByState('done')).toBe(1)
  })

  it('does not retire dormant jobs (they have their own revival path)', () => {
    // Setup: create missing episode and job
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'missing',
    })
    aggregate(lib, jobs, now)

    // Force job to dormant
    jobs.forceState('s1', 1, 'dormant', now)
    expect(jobs.countByState('dormant')).toBe(1)

    // Cover the episode
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'covered',
    })

    // Aggregate again — dormant job should NOT be retired
    const result = aggregate(lib, jobs, now + 1000)

    expect(result.retired).toBe(0)
    expect(jobs.countByState('dormant')).toBe(1)
    expect(jobs.countByState('done')).toBe(0)
  })

  it('handles mixed series and movies', () => {
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/tv/s1/e1.mkv',
      subStatus: 'missing',
    })
    lib.upsertMovie({
      id: 'm1',
      name: 'Movie A',
      path: '/movies/m1.mkv',
      subStatus: 'missing',
    })

    const result = aggregate(lib, jobs, now)

    expect(result.created).toBe(2)
    expect(jobs.countByState('wanted')).toBe(2)
  })

  it('done job 复活（I2）：季重新出现 missing 后 aggregate 回 wanted', () => {
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1,
      name: 'Ep1', path: '/tv/s1/e1.mkv', subStatus: 'missing',
    })
    aggregate(lib, jobs, now)
    const job = jobs.claimNext(now)!
    lib.markCovered('e1', '/tv/s1/e1.zh-Hans.srt', 'scout-download')
    jobs.completeDone(job.id, now)
    expect(jobs.get(job.id)!.state).toBe('done')

    // 新集入库 missing → 同一 job 复活而非新建
    lib.upsertEpisode({
      id: 'e2', seriesId: 's1', season: 1, episode: 2,
      name: 'Ep2', path: '/tv/s1/e2.mkv', subStatus: 'missing',
    })
    const result = aggregate(lib, jobs, now + 1000)
    expect(result.created).toBe(0)
    const revived = jobs.get(job.id)!
    expect(revived.state).toBe('wanted')
    expect(revived.attempt).toBe(0)
    expect(revived.next_retry_at).toBeNull()
  })

  it('dormant 复活通道（I3）：集 recheck 到期后 aggregate wake 回 wanted，attempt 保留', () => {
    lib.upsertSeries({ id: 's1', name: 'Series A' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1,
      name: 'Ep1', path: '/tv/s1/e1.mkv', subStatus: 'missing',
    })
    aggregate(lib, jobs, now)
    // 攒一次 attempt 再休眠，验证 wake 保留 attempt（一个复查窗口一发子弹）
    const job = jobs.claimNext(now)!
    jobs.completeNoMatch(job.id, now)              // attempt=1, failed
    jobs.forceState('s1', 1, 'dormant', now)
    // 集被标 unavailable 且复查已到期
    lib.markUnavailable('e1', '搜索穷尽', now - 1)

    const result = aggregate(lib, jobs, now + 1000)
    expect(result.created).toBe(0)
    const woken = jobs.get(job.id)!
    expect(woken.state).toBe('wanted')
    expect(woken.priority).toBe(0)                 // 调和唤醒不是播放触发，不给高优
    expect(woken.attempt).toBe(1)                  // attempt 保留：失败即再休眠
    expect(woken.next_retry_at).toBeNull()
  })

  it('retires movie job when movie becomes covered', () => {
    lib.upsertMovie({
      id: 'm1',
      name: 'Movie A',
      path: '/movies/m1.mkv',
      subStatus: 'missing',
    })
    aggregate(lib, jobs, now)
    expect(jobs.countByState('wanted')).toBe(1)

    // Cover the movie
    lib.upsertMovie({
      id: 'm1',
      name: 'Movie A',
      path: '/movies/m1.mkv',
      subStatus: 'covered',
    })

    const result = aggregate(lib, jobs, now + 1000)

    expect(result.retired).toBe(1)
    expect(jobs.countByState('wanted')).toBe(0)
    expect(jobs.countByState('done')).toBe(1)
  })
})
