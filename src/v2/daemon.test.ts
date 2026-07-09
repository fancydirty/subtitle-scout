import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { ScoutDaemon, type DaemonDeps } from './daemon.js'
import type { Job } from './jobsRepo.js'
import type { PlaybackSession } from '../adapters/players/types.js'

describe('ScoutDaemon', () => {
  let jobs: JobsRepo
  let lib: LibraryRepo
  let runs: RunsRepo
  let now: number
  const logs: string[] = []

  beforeEach(() => {
    const db = openDb(':memory:')
    jobs = new JobsRepo(db)
    lib = new LibraryRepo(db)
    runs = new RunsRepo(db)
    now = Date.now()
    logs.length = 0
  })

  const makeDeps = (overrides?: Partial<DaemonDeps>): DaemonDeps => ({
    lib,
    jobs,
    runs,
    scan: vi.fn(async () => {}),
    aggregate: vi.fn(() => ({ created: 0, retired: 0 })),
    executeJob: vi.fn(async () => {}),
    getSessions: vi.fn(async () => []),
    episodeForSession: vi.fn(() => null),
    log: (msg) => logs.push(msg),
    now: () => now,
    reconcileEveryMs: 15 * 60_000, // 15 min
    fullScanEveryMs: 6 * 3600_000,  // 6 hours (not used in phase 1: scan = full scan)
    concurrency: { searching: 1, downloading: 2, verifying: 2 },
    ...overrides,
  })

  it('tick序列：reap → scan+aggregate → dispatch', async () => {
    const scan = vi.fn(async () => {})
    const aggregate = vi.fn(() => ({ created: 1, retired: 0 }))
    const executeJob = vi.fn(async () => {})

    // Mark last reconcile as long ago so reconcile will run
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', '0')`).run()

    // Create a wanted job
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, executeJob }))
    await daemon.tick()

    // Should have called reap, scan, aggregate
    expect(scan).toHaveBeenCalledOnce()
    expect(aggregate).toHaveBeenCalledOnce()

    // Should have claimed and executed the job
    expect(executeJob).toHaveBeenCalledOnce()
    // Check that a job was claimed
    expect(jobs.countByState('searching')).toBe(1)
    const claimedJob = jobs.find('s1', 1)
    expect(claimedJob?.state).toBe('searching')
  })

  it('dispatch尊重searching并发上限', async () => {
    const executeJob = vi.fn(async () => {
      // Simulate job taking time (doesn't complete within tick)
      await new Promise(() => {}) // Never resolves
    })

    // Create 3 wanted jobs
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's2', season: 1 }, now)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's3', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ executeJob, concurrency: { searching: 1, downloading: 2, verifying: 2 } }))
    await daemon.tick()

    // Should only claim 1 job (concurrency limit)
    expect(executeJob).toHaveBeenCalledTimes(1)
    expect(jobs.countByState('searching')).toBe(1)
    expect(jobs.countByState('wanted')).toBe(2)
  })

  it('过租job被reap后可再领取', async () => {
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const job = jobs.claimNext(now)
    expect(job?.state).toBe('searching')

    // Advance time past lease expiry
    now += 31 * 60_000

    // Just call reap directly to test the reap logic
    jobs.reapExpiredLeases(now)

    // Job should be back to wanted with attempt incremented
    const reaped = jobs.find('s1', 1)
    expect(reaped?.state).toBe('wanted')
    expect(reaped?.attempt).toBe(1)
  })

  it('executeJob抛错不炸主循环', async () => {
    const executeJob = vi.fn(async () => {
      throw new Error('Simulated error')
    })

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    // Should not throw
    await expect(daemon.tick()).resolves.toBeUndefined()

    // Error should be logged
    expect(logs.some(l => l.includes('Simulated error'))).toBe(true)
  })

  it('scan抛错时跳过aggregate但继续dispatch', async () => {
    const scan = vi.fn(async () => {
      throw new Error('Scan failed')
    })
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))
    const executeJob = vi.fn(async () => {})

    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', '0')`).run()
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, executeJob }))
    await daemon.tick()

    // Scan was attempted
    expect(scan).toHaveBeenCalled()
    // Aggregate should be skipped due to scan error
    expect(aggregate).not.toHaveBeenCalled()
    // But dispatch should still run
    expect(executeJob).toHaveBeenCalled()
    // Error logged
    expect(logs.some(l => l.includes('Scan failed'))).toBe(true)
  })

  it('reconcile仅在到点时运行', async () => {
    const scan = vi.fn(async () => {})
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))

    // Set last reconcile to 10 minutes ago (not yet time for 15-min interval)
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)`).run(String(now - 10 * 60_000))

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, reconcileEveryMs: 15 * 60_000 }))
    await daemon.tick()

    // Should not scan/aggregate yet
    expect(scan).not.toHaveBeenCalled()
    expect(aggregate).not.toHaveBeenCalled()

    // Advance past reconcile interval
    now += 6 * 60_000
    await daemon.tick()

    // Now should scan/aggregate
    expect(scan).toHaveBeenCalledOnce()
    expect(aggregate).toHaveBeenCalledOnce()
  })

  it('pollSessions命中退避中的集（unavailable+未来recheck+dormant job）也能wake/boost', async () => {
    // 真实态：内容性失败穷尽退避后——集 unavailable 且 recheck_after 在未来，job dormant。
    // 播放触发存在的意义就是让用户能对着难找的剧手动催，判据不吃 recheck 门。
    lib.upsertSeries({ id: 's1', name: 'Series 1' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Episode 1',
      path: '/media/s1e1.mkv',
      subStatus: 'missing',
    })
    lib.markUnavailable('e1', '搜索穷尽', now + 30 * 86_400_000) // recheck 在未来 30 天

    // Job dormant（退避穷尽）
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.forceState('s1', 1, 'dormant', now)

    const getSessions = vi.fn(async () => [{
      Id: 'session1',
      NowPlayingItem: { Id: 'e1', Type: 'Episode', SeriesId: 's1', ParentIndexNumber: 1 },
    }] as PlaybackSession[])

    const episodeForSession = vi.fn((item) =>
      item.Type === 'Episode' && item.SeriesId === 's1' && item.ParentIndexNumber === 1
        ? { kind: 'series_season' as const, seriesId: 's1', season: 1 }
        : null
    )

    const daemon = new ScoutDaemon(makeDeps({ getSessions, episodeForSession }))
    await daemon.pollSessions()

    // Job should be woken from dormant with priority 100
    const job = jobs.find('s1', 1)
    expect(job?.state).toBe('wanted')
    expect(job?.priority).toBe(100)

    // 该集 recheck_after 应被拉回 now，让 executor 重derive 能纳入它
    const ep = lib.getEpisode('e1')!
    expect(ep.sub_status).toBe('unavailable')
    expect(ep.recheck_after).toBeLessThanOrEqual(now)
  })

  it('pollSessions对covered条目不wake', async () => {
    lib.upsertSeries({ id: 's1', name: 'Series 1' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Episode 1',
      path: '/media/s1e1.mkv',
      subStatus: 'covered',
    })

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    jobs.forceState('s1', 1, 'dormant', now)

    const getSessions = vi.fn(async () => [{
      Id: 'session1',
      NowPlayingItem: { Id: 'e1', Type: 'Episode', SeriesId: 's1', ParentIndexNumber: 1 },
    }] as PlaybackSession[])

    const episodeForSession = vi.fn(() => ({
      kind: 'series_season' as const, seriesId: 's1', season: 1,
    }))

    const daemon = new ScoutDaemon(makeDeps({ getSessions, episodeForSession }))
    await daemon.pollSessions()

    // Covered episode should not trigger wake
    expect(jobs.find('s1', 1)?.state).toBe('dormant')
  })

  it('pollSessions错误不影响后续运行', async () => {
    const getSessions = vi.fn(async () => {
      throw new Error('Sessions fetch failed')
    })

    const daemon = new ScoutDaemon(makeDeps({ getSessions }))

    // Should not throw
    await expect(daemon.pollSessions()).resolves.toBeUndefined()

    // Error should be logged
    expect(logs.some(l => l.includes('Sessions fetch failed'))).toBe(true)
  })

  it('run启动即回收上个进程的活跃租约（未过期也回收）', async () => {
    // 生产实案：部署重启瞬间在跑的 job 租约僵尸占 searching 槽最长 30 分钟。
    // 模拟旧进程遗孤：claim 后"进程死了"，租约仍在 30min 窗口内未过期。
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const orphan = jobs.claimNext(now)!
    expect(orphan.state).toBe('searching')

    const daemon = new ScoutDaemon(makeDeps())
    const controller = new AbortController()
    const runPromise = daemon.run(controller.signal)

    await new Promise(r => setTimeout(r, 20))
    controller.abort()
    await runPromise

    // 回收发生且被 log；attempt+1 证明走的是 reap 通道
    // （之后 tick 可能已把它重新领走，所以断言 attempt 而非最终 state）
    expect(logs.some(l => l.includes('boot: reaped 1'))).toBe(true)
    expect(jobs.get(orphan.id)!.attempt).toBe(1)
  })

  it('run启动时无活跃租约则不打回收log', async () => {
    const daemon = new ScoutDaemon(makeDeps())
    const controller = new AbortController()
    const runPromise = daemon.run(controller.signal)

    await new Promise(r => setTimeout(r, 20))
    controller.abort()
    await runPromise

    expect(logs.some(l => l.includes('boot: reaped'))).toBe(false)
  })

  it('run循环：tick+pollSessions并发，signal退出', async () => {
    const executeJob = vi.fn(async () => {})

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))
    const controller = new AbortController()

    // Run daemon in background
    const runPromise = daemon.run(controller.signal)

    // Let it run for a bit
    await new Promise(r => setTimeout(r, 50))

    // Signal abort
    controller.abort()

    // Should exit cleanly
    await expect(runPromise).resolves.toBeUndefined()
  })

  it('graceful shutdown: 等待inflight完成或30s超时', async () => {
    let jobRunning = true
    const executeJob = vi.fn(async () => {
      // Simulate long-running job
      await new Promise(resolve => {
        const check = () => {
          if (!jobRunning) resolve(undefined)
          else setTimeout(check, 10)
        }
        check()
      })
    })

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))
    const controller = new AbortController()

    // Trigger one tick to start a job
    await daemon.tick()
    expect(executeJob).toHaveBeenCalled()

    // Start run loop
    const runPromise = daemon.run(controller.signal)

    // Immediately signal abort
    await new Promise(r => setTimeout(r, 10))
    controller.abort()

    // Job should still be running
    await new Promise(r => setTimeout(r, 20))

    // Complete the job
    jobRunning = false

    // Should exit cleanly after job completes
    await expect(runPromise).resolves.toBeUndefined()
  }, 10000)
})
