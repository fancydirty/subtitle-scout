import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { ScoutDaemon, type DaemonDeps, MAX_CONSECUTIVE_TICK_FAILURES } from './daemon.js'
import type { Job } from './jobsRepo.js'
import type { PlaybackSession } from '../adapters/players/types.js'
import { executeJob as realExecuteJob, type ExecutorDeps } from './executor.js'

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

  it('长跑 job 未过 30min 租约不该被 reap 双派发（心跳续租）：tick 每 15s 续租 inflight job，reap 不动它，dispatch 不重领', async () => {
    // 生产实案：季包 job 合法跑超 30min 租约（多集 resolveDownload/LLM），
    // 若无心跳续租，下一 tick 的 reapExpiredLeases 会把它打回 wanted，
    // dispatch 立刻重领同一 job，产生并发双跑（provider/LLM 配额翻倍、队头饿死）。
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    let resolveJob: () => void = () => {}
    const executeJob = vi.fn(() => new Promise<void>((resolve) => { resolveJob = resolve }))

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    // Tick 1: claims the job, executeJob starts and never resolves within this tick.
    await daemon.tick()
    expect(executeJob).toHaveBeenCalledTimes(1)
    expect(jobs.countByState('searching')).toBe(1)

    // Advance time past the 30-min lease — the job is still genuinely running
    // in this same process (inflight), just slow.
    now += 31 * 60_000

    // Tick 2: heartbeat must renew the inflight job's lease before reap runs,
    // so reapExpiredLeases must NOT touch it and dispatch must NOT re-claim it.
    await daemon.tick()

    expect(executeJob).toHaveBeenCalledTimes(1) // still only ran once — no double dispatch
    expect(jobs.countByState('searching')).toBe(1) // original claim still holds
    expect(jobs.countByState('wanted')).toBe(0) // not bounced back to wanted

    resolveJob()
  })

  it('过租job被reap后可再领取', async () => {
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const job = jobs.claimNext(now)
    expect(job?.state).toBe('searching')

    // Advance time past lease expiry
    now += 31 * 60_000

    // Just call reap directly to test the reap logic
    jobs.reapExpiredLeases(now)

    // Job should be back to wanted; attempt unchanged — reap is not a content
    // failure and must not consume a content-backoff-ladder slot (audit fix).
    const reaped = jobs.find('s1', 1)
    expect(reaped?.state).toBe('wanted')
    expect(reaped?.attempt).toBe(0)
  })

  it('tick 对意外抛错（如 reapExpiredLeases 命中满盘 SQLITE_FULL）保持隔离，不炸出 tick 之外', async () => {
    // 审计修正：reap、meta SELECT、dispatch 里的 claimNext/countByState 都不在原有的
    // scan+aggregate try/catch 覆盖范围内——任何一处意外抛错（如磁盘写满）会让整个
    // tickLoop promise reject，Promise.all(...).catch(() => {}) 悄悄吞掉，tick 永久停摆，
    // 进程却存活不退出（daemon.ts:249）。tick() 必须自己兜底、记日志、不向外抛。
    const reapSpy = vi.spyOn(jobs, 'reapExpiredLeases').mockImplementation(() => {
      throw new Error('SQLITE_FULL: database or disk is full')
    })

    const daemon = new ScoutDaemon(makeDeps())
    await expect(daemon.tick()).resolves.toBeUndefined()
    expect(logs.some(l => l.includes('SQLITE_FULL'))).toBe(true)

    reapSpy.mockRestore()
  })

  it('tick 连续失败达阈值后调用 exit(非零码)——防止磁盘满等故障下进程存活但永久停摆', async () => {
    const reapSpy = vi.spyOn(jobs, 'reapExpiredLeases').mockImplementation(() => {
      throw new Error('boom')
    })
    const exit = vi.fn()
    const daemon = new ScoutDaemon(makeDeps({ exit }))

    for (let i = 0; i < MAX_CONSECUTIVE_TICK_FAILURES - 1; i++) {
      await daemon.tick()
    }
    expect(exit).not.toHaveBeenCalled()

    await daemon.tick() // Nth consecutive failure
    expect(exit).toHaveBeenCalledWith(1)

    reapSpy.mockRestore()
  })

  it('tick 失败计数在中途恢复成功后重置——偶发抖动不该累积到 fail-fast 阈值', async () => {
    const reapSpy = vi.spyOn(jobs, 'reapExpiredLeases')
    reapSpy.mockImplementation(() => { throw new Error('transient blip') })

    const exit = vi.fn()
    const daemon = new ScoutDaemon(makeDeps({ exit }))

    for (let i = 0; i < MAX_CONSECUTIVE_TICK_FAILURES - 1; i++) {
      await daemon.tick()
    }

    reapSpy.mockRestore() // next tick succeeds, should reset the counter

    for (let i = 0; i < MAX_CONSECUTIVE_TICK_FAILURES - 1; i++) {
      await daemon.tick()
    }
    expect(exit).not.toHaveBeenCalled() // never reached N consecutive failures
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

  it('scan抛错时跳过aggregate但继续dispatch（稳态：boot reconcile 已成功后）', async () => {
    // 稳态语义：boot reconcile 成功之后，中途某轮 scan 抖动（Jellyfin 瞬时 5xx 等）
    // 不应停摆 dispatch。boot 阶段的 scan 抛错则相反——见 'boot scan 抛错的 tick 不 dispatch'。
    let scanCalls = 0
    const scan = vi.fn(async () => {
      scanCalls++
      if (scanCalls > 1) throw new Error('Scan failed')
    })
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))
    const executeJob = vi.fn(async () => {})

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, executeJob }))

    // Priming tick: boot reconcile 成功，消耗 boot 标志
    await daemon.tick()
    scan.mockClear()
    aggregate.mockClear()
    executeJob.mockClear()

    // 稳态：到点 reconcile，scan 抛错
    now += 16 * 60_000
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
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

  it('reconcile仅在到点时运行（稳态：boot 强制拍之后）', async () => {
    const scan = vi.fn(async () => {})
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, reconcileEveryMs: 15 * 60_000 }))

    // Prime: consume the boot-forced reconcile (see 'boot: first tick reconciles...'
    // tests) so this test can isolate the steady-state time-gate behavior below.
    await daemon.tick()
    scan.mockClear()
    aggregate.mockClear()

    // 9 minutes since the priming tick's reconcile — not yet due for the 15-min interval
    now += 9 * 60_000
    await daemon.tick()

    // Should not scan/aggregate yet
    expect(scan).not.toHaveBeenCalled()
    expect(aggregate).not.toHaveBeenCalled()

    // Advance past reconcile interval (16 min since priming tick's reconcile)
    now += 7 * 60_000
    await daemon.tick()

    // Now should scan/aggregate
    expect(scan).toHaveBeenCalledOnce()
    expect(aggregate).toHaveBeenCalledOnce()
  })

  it('boot: first tick reconciles BEFORE dispatching even when last_reconcile_at is recent', async () => {
    const callOrder: string[] = []
    const scan = vi.fn(async () => {
      callOrder.push('scan')
    })
    const aggregate = vi.fn(() => {
      callOrder.push('aggregate')
      return { created: 0, retired: 0 }
    })
    const executeJob = vi.fn(async () => {
      callOrder.push('dispatch')
    })

    // last_reconcile_at is recent (e.g. just written by a previous daemon process
    // seconds ago on a rolling deploy) — the time gate alone would skip the scan.
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)`).run(String(now - 5_000))

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, executeJob }))
    await daemon.tick()

    // Scan/aggregate must run despite the recent last_reconcile_at, and must run
    // before dispatch claims/executes jobs.
    expect(scan).toHaveBeenCalledOnce()
    expect(aggregate).toHaveBeenCalledOnce()
    expect(callOrder).toEqual(['scan', 'aggregate', 'dispatch'])
  })

  it('boot reconcile happens only once (second tick respects the time gate again)', async () => {
    const scan = vi.fn(async () => {})
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))

    // Recent last_reconcile_at — boot flag should force the first tick's scan anyway.
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)`).run(String(now - 5_000))

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate }))
    await daemon.tick()
    expect(scan).toHaveBeenCalledOnce()

    // Simulate another recent write to last_reconcile_at (e.g. some other process,
    // or just the boot tick's own update) — the boot flag has been consumed, so
    // the plain time gate takes back over and a still-recent timestamp skips scan.
    lib.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(now))

    await daemon.tick()

    // No additional scan/aggregate on the second tick.
    expect(scan).toHaveBeenCalledOnce()
    expect(aggregate).toHaveBeenCalledOnce()
  })

  it('boot reconcile retries next tick if the boot scan throws', async () => {
    let scanCalls = 0
    const scan = vi.fn(async () => {
      scanCalls++
      if (scanCalls === 1) throw new Error('boot scan failed')
    })
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))

    // Recent last_reconcile_at: without the boot flag surviving the throw, the
    // time gate alone would never retry the scan on tick 2.
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)`).run(String(now - 5_000))

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate }))

    await daemon.tick()
    expect(scan).toHaveBeenCalledTimes(1)
    expect(aggregate).not.toHaveBeenCalled() // skipped because scan threw

    await daemon.tick()
    expect(scan).toHaveBeenCalledTimes(2)
    expect(aggregate).toHaveBeenCalledOnce() // second scan succeeded, aggregate ran
  })

  it('boot scan 抛错的 tick 不 dispatch；下一 tick scan 成功后才放行旧 job', async () => {
    // 整栈重启实景：Jellyfin HTTP 未就绪 → scout 首 tick scan 必抛。此时库里还躺着
    // 上个进程遗留的 stale wanted job（新分类规则尚未跑过）——boot reconcile 成功前
    // 绝不能派发它，否则 boot 扫描失败窗口内旧（未过门）job 照样触发下载。
    let scanCalls = 0
    const scan = vi.fn(async () => {
      scanCalls++
      if (scanCalls === 1) throw new Error('jellyfin not ready')
    })
    const aggregate = vi.fn(() => ({ created: 0, retired: 0 }))
    const executeJob = vi.fn(async () => {})

    // Recent last_reconcile_at（上个进程分钟前写的）+ 一个 stale wanted job
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)`).run(String(now - 5_000))
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const daemon = new ScoutDaemon(makeDeps({ scan, aggregate, executeJob }))

    // Tick 1: boot scan 抛错 → dispatch 必须被压制
    await daemon.tick()
    expect(scan).toHaveBeenCalledTimes(1)
    expect(executeJob).not.toHaveBeenCalled()
    expect(jobs.countByState('wanted')).toBe(1) // job 原地未被 claim

    // Tick 2: scan 成功 → boot reconcile 完成 → dispatch 放行
    await daemon.tick()
    expect(scan).toHaveBeenCalledTimes(2)
    expect(executeJob).toHaveBeenCalledOnce()
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

  it('pollSessions命中退避中的needs_review集（recheck未来+dormant job）也能wake/boost，下一tick实际把该集纳入target而非误判done', async () => {
    // 复现审计发现：daemon.ts 的 resetRecheck 调用点只对 sub_status==='unavailable' 拉回
    // recheck_after，needs_review 被漏放——尽管 resetRecheck 本身（libraryRepo.ts）早已支持
    // 两者。播放触发 wake 了 dormant job，但 needs_review 集的 recheck_after 仍留在 30 天后，
    // executor 重derive targets（remainingTargets）的 recheck 门照样把这集挡在外面：零
    // target → job 误判 done（跑详情谎报"字幕均已就位"）→ 之后 recheck 自然到期时
    // done→wanted 复活，把 attempt 和 error_attempt 一起清零——既破坏"每个 recheck 窗口只
    // 打一枪"的节流，也让 needs_review 的播放强制重试静默失效。
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
    lib.markNeedsReview('e1', '找到候选但把握不足', now + 30 * 86_400_000) // recheck 在未来 30 天

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

    // needs_review 集的 recheck_after 也应被拉回 now，和 unavailable 同等对待
    const ep = lib.getEpisode('e1')!
    expect(ep.sub_status).toBe('needs_review')
    expect(ep.recheck_after).toBeLessThanOrEqual(now)

    // 端到端：下一 tick 真实 claim 到该 job 并跑真实 executor 时，remainingTargets 必须
    // 把这集纳入（而非因 recheck 门未拉回而零 target 误判 done）
    const runEpisode = vi.fn(async (
      episodeId: string,
      onCovered: (id: string, path: string, providerRef?: string) => void
    ) => {
      expect(episodeId).toBe('e1')
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/j.json', subtitlePath: '/tv/s1e1.zh-Hans.srt' }
    })

    const executeJob = (claimedJob: Job) =>
      realExecuteJob(claimedJob, { lib, jobs, runEpisode, now: () => now, log: () => {} } as ExecutorDeps)

    const daemon2 = new ScoutDaemon(makeDeps({ executeJob }))
    await daemon2.tick()

    expect(runEpisode).toHaveBeenCalledTimes(1)
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(jobs.find('s1', 1)?.state).toBe('done')
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

    // 回收发生且被 log（走的是 reap 通道；reap 不再 attempt+1——见审计修正，
    // 之后 tick 可能已把它重新领走，故不再断言 attempt/state，只断言回收 log 触发）。
    expect(logs.some(l => l.includes('boot: reaped 1'))).toBe(true)
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
