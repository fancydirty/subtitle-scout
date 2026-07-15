import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { ScoutDaemon, type DaemonDeps, MAX_CONSECUTIVE_TICK_FAILURES } from './daemon.js'
import type { Job } from './jobsRepo.js'
import type { PlaybackSession } from '../adapters/players/types.js'
import { executeJob as realExecuteJob, type ExecutorDeps } from './executor.js'
import { SELF_SCAN_DEFAULT_INTERVAL_MS } from '../daemon/selfScan.js'

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

  it('FIX-4c: dispatch 为每次 claim 记一行 log——job id、series/kind、lease_until', async () => {
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 3 }, now)
    const executeJob = vi.fn(async () => {})
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick()

    const claimed = jobs.find('s1', 3)!
    const claimLine = logs.find(l => l.includes('dispatch') && l.includes(`${claimed.id}`))
    expect(claimLine).toBeDefined()
    expect(claimLine).toContain('s1')
    expect(claimLine).toContain('series_season')
    expect(claimLine).toContain(String(claimed.lease_until))
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

  it('FIX-1: active 但不在本进程 inflight 跟踪里的孤儿行——即便租约合法未过期，也在秒级被回收（不必等 30min 租约到期）', async () => {
    // 生产实案复现：executeJob 的 promise 结算但其 continuation（.finally）从未被调度
    // ——job 卡在 active 态、租约仍合法未过期，但本进程再也不"跟踪"它了。过去只能等
    // 最长 30 分钟租约到期后 reapExpiredLeases 自愈，期间 searching 并发槽（默认=1）
    // 被永久占用，队列彻底停摆且零 log/run 证据。这里绕过 daemon 直接 claimNext，
    // 模拟"该 job 从未被本 daemon 实例的 dispatch()/inflight 跟踪过"。
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const orphan = jobs.claimNext(now)!
    expect(orphan.state).toBe('searching')
    expect(orphan.lease_until).toBeGreaterThan(now) // 租约合法，远未过期

    const executeJob = vi.fn(async () => {})
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick()

    // 秒级回收 log 触发，命名了 job 和异常——不必等 30min 租约到期。
    expect(logs.some(l => l.includes(`${orphan.id}`) && /孤儿|orphan/i.test(l))).toBe(true)
    // 本例队列里只有这一个 job：回收腾出的槽位在同一 tick 内被 dispatch 合法重新领取
    // （这次正常跟踪），派发槽没有被永久空置或双跑。
    expect(executeJob).toHaveBeenCalledOnce()
    expect(jobs.countByState('searching')).toBe(1)
  })

  it('FIX-1: 孤儿回收腾出的派发槽让另一个排队 job 得以领取（打破单槽饿死）', async () => {
    // 更贴近 spec 原句的场景：孤儿被回收回 wanted 后，槽位让**另一个**排队 job 拿到——
    // 而不是孤儿自己在同一 tick 内被重新领走。用优先级保证 claimNext 的选择确定性。
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now) // 将成为孤儿
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's2', season: 1 }, now) // 排队中，优先级更高
    jobs.boostPriority({ kind: 'series_season', seriesId: 's2', season: 1 }, 100)

    // forceClaim（测试助手）：指名领取 s1，绕开 claimNext 的 priority 排序——s2 优先级更高，
    // 若走 claimNext 反而会先领到 s2，测不出"孤儿腾出槽位给别的 job"这个点。
    const orphan = jobs.forceClaim('s1', 1, now)! // 未被任何 daemon 跟踪
    expect(orphan.series_id).toBe('s1')

    const executeJob = vi.fn(async (_job: Job) => {})
    const daemon = new ScoutDaemon(
      makeDeps({ executeJob, concurrency: { searching: 1, downloading: 2, verifying: 2 } })
    )

    await daemon.tick()

    // s1 孤儿被回收（未被跟踪）→ 唯一的 searching 槽让优先级更高、排队中的 s2 领到。
    expect(executeJob).toHaveBeenCalledOnce()
    const claimedJob = executeJob.mock.calls[0][0]
    expect(claimedJob.series_id).toBe('s2')
    // s1 本身回到 wanted、没有在同一 tick 内被抢回去，attempt 不变（reap 不占内容退避梯名额）。
    expect(jobs.find('s1', 1)!.state).toBe('wanted')
    expect(jobs.find('s1', 1)!.attempt).toBe(0)
  })

  it('FIX-1: 真正 inflight（daemon 自己 claim 且仍在跟踪）的 job 不被孤儿侦测误伤', async () => {
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    let resolveJob: () => void = () => {}
    const executeJob = vi.fn(() => new Promise<void>((resolve) => { resolveJob = resolve }))
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    // Tick 1: daemon 自己 claim 并跟踪这个 job（inflight），executeJob 尚未完成。
    await daemon.tick()
    expect(jobs.countByState('searching')).toBe(1)

    // Tick 2: 孤儿侦测跑在 dispatch 之前——这个 job 仍在本进程的 inflight 跟踪集合里，
    // 绝不能被当成孤儿回收。
    await daemon.tick()
    expect(jobs.countByState('searching')).toBe(1)
    expect(jobs.countByState('wanted')).toBe(0)
    expect(executeJob).toHaveBeenCalledOnce() // 没有被误回收+重新派发

    resolveJob()
  })

  it('FIX-1: 本 tick 刚被 dispatch 领走的 job 不会被同一 tick 的孤儿侦测误伤（顺序保证：侦测跑在 dispatch 之前）', async () => {
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const executeJob = vi.fn(() => new Promise<void>(() => {})) // 本 tick 内不会 settle
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick() // 孤儿侦测先跑（此时还没有任何 active 行）→ dispatch 才 claim+跟踪

    expect(jobs.countByState('searching')).toBe(1) // 未被本 tick 自己的孤儿侦测回收
    expect(jobs.countByState('wanted')).toBe(0)
  })

  it('FIX-2: reap+重领后，旧（detached）invocation 迟到的 finally 不驱逐新 invocation 的 inflight 追踪条目', async () => {
    // 生产语境：inflight 跟踪曾是 Set<number>（按 job id 去重），两次 claim 共享同一个
    // key——旧 invocation 的 .finally 一响就把新 invocation 的追踪条目也删了，新
    // invocation（仍在合法跑）从此失去心跳续租，租约到期后被误判死亡回收（双跑/饿死）。
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    let resolveFirst: () => void = () => {}
    let callCount = 0
    const executeJob = vi.fn(() => {
      callCount++
      if (callCount === 1) {
        return new Promise<void>((resolve) => { resolveFirst = resolve })
      }
      return new Promise<void>(() => {}) // 第二次 invocation：本测试内也不 settle
    })

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    // Tick 1：claim s1 → invocation #1 被跟踪（即将变成 detached）。
    await daemon.tick()
    expect(jobs.countByState('searching')).toBe(1)

    // 模拟：这一行在 invocation #1 仍"活着"（只是它的 continuation 还没运行）时被
    // 别处回收——确定性复现用 reapAllActive（同 FIX-1 的孤儿回收在其他时序下的效果）。
    jobs.reapAllActive(now)
    expect(jobs.find('s1', 1)!.state).toBe('wanted')

    // Tick 2：dispatch 重新领取 s1 给 invocation #2——同一个 job id，全新的 Job 对象/token。
    await daemon.tick()
    expect(jobs.countByState('searching')).toBe(1)
    expect(executeJob).toHaveBeenCalledTimes(2)

    // 现在 invocation #1（stale）才结算——它的 .finally 绝不能驱逐 invocation #2 的追踪条目。
    resolveFirst()
    await Promise.resolve()
    await Promise.resolve()

    // 证明 invocation #2 仍被跟踪：把时钟拨过 30min 租约再 tick——心跳必须还在为它续租
    // （id 仍在追踪集合里），reapExpiredLeases/FIX-1 孤儿侦测都不该碰它。
    now += 31 * 60_000
    await daemon.tick()

    expect(jobs.countByState('searching')).toBe(1) // 仍被跟踪+续租，没被回收
    expect(jobs.countByState('wanted')).toBe(0)
    expect(executeJob).toHaveBeenCalledTimes(2) // 没有多出一次误派发/双跑
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

  it('FIX-4b: executeJob 抛错时除了记 log 还落一条 synthetic error run 行——crashed invocation 不再零证据', async () => {
    // 过去 fire-and-forget 的 .catch 只记日志就完了；日志会轮转/丢失，runs 表才是
    // 持久证据。任何 crashed invocation 都该在 runs 表留痕，哪怕 executeJob 本身
    // 没机会（或没来得及）自己写一行。
    const executeJob = vi.fn(async () => {
      throw new Error('Simulated crash')
    })

    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick()

    const job = jobs.find('s1', 1)!
    const runRows = runs.getByJobId(job.id)
    expect(runRows.length).toBe(1)
    expect(runRows[0].decision).toBe('error')
    expect(runRows[0].detail).toContain('Simulated crash')
  })

  it('FIX-4b: synthetic run 行落盘本身失败（fail-soft）——不能让记录动作反过来炸主循环', async () => {
    const executeJob = vi.fn(async () => {
      throw new Error('Simulated crash')
    })
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    const runsSpy = vi.spyOn(runs, 'insert').mockImplementation(() => {
      throw new Error('disk full while writing runs row')
    })

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await expect(daemon.tick()).resolves.toBeUndefined()
    // 原有的 error log 仍然要打出来——记录失败不该吞掉既有的可观测性
    expect(logs.some(l => l.includes('Simulated crash'))).toBe(true)

    runsSpy.mockRestore()
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

  describe('B2: self-scan + refresh-bridge gate', () => {
    function fakeSelfScanResult(over: Partial<{
      scanned: number
      recognized: unknown[]
      parked: unknown[]
      newlyDiscovered: unknown[]
      refreshedLibraries: string[]
      ingestedNew: unknown[]
      orchestratorTriggered: boolean
    }> = {}) {
      return {
        scan: { scanned: 1, recognized: [], parked: [], skippedKnown: 0, ...over },
        newlyDiscovered: [],
        refreshedLibraries: [],
        ingestedNew: [],
        orchestratorTriggered: false,
        ...over,
      } as never // loosely-shaped test double — daemon.ts only reads the fields it logs
    }

    it('deps.selfScan undefined → self-scan branch skipped entirely, no crash, no log line', async () => {
      const daemon = new ScoutDaemon(makeDeps()) // no selfScan override
      await daemon.tick()
      expect(logs.some(l => l.includes('self-scan'))).toBe(false)
    })

    it('interval gate: tick before selfScanEveryMs elapsed → selfScan not invoked', async () => {
      const selfScan = vi.fn(async () => fakeSelfScanResult())
      const daemon = new ScoutDaemon(makeDeps({ selfScan, selfScanEveryMs: 15 * 60_000 }))

      // Priming tick: no last_self_scan_at row yet → gate is open on the very first tick.
      await daemon.tick()
      expect(selfScan).toHaveBeenCalledOnce()
      selfScan.mockClear()

      // 9 minutes later — not yet due for the 15-min interval.
      now += 9 * 60_000
      await daemon.tick()
      expect(selfScan).not.toHaveBeenCalled()
    })

    it('interval gate: tick after selfScanEveryMs elapsed → selfScan invoked', async () => {
      const selfScan = vi.fn(async () => fakeSelfScanResult())
      const daemon = new ScoutDaemon(makeDeps({ selfScan, selfScanEveryMs: 15 * 60_000 }))

      await daemon.tick() // priming tick consumes the "no row yet" open gate
      selfScan.mockClear()

      now += 16 * 60_000
      await daemon.tick()
      expect(selfScan).toHaveBeenCalledOnce()
    })

    it('defaults selfScanEveryMs to SELF_SCAN_DEFAULT_INTERVAL_MS when not overridden', async () => {
      const selfScan = vi.fn(async () => fakeSelfScanResult())
      const daemon = new ScoutDaemon(makeDeps({ selfScan })) // no selfScanEveryMs override

      await daemon.tick() // priming tick
      selfScan.mockClear()

      now += SELF_SCAN_DEFAULT_INTERVAL_MS - 1
      await daemon.tick()
      expect(selfScan).not.toHaveBeenCalled()

      now += 2 // now >= SELF_SCAN_DEFAULT_INTERVAL_MS since the priming tick
      await daemon.tick()
      expect(selfScan).toHaveBeenCalledOnce()
    })

    it('self-scan error is isolated (logged, tick completes) and last_self_scan_at is NOT advanced — retried next gate-open tick', async () => {
      let calls = 0
      const selfScan = vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('jellyfin not ready for refreshLibrary')
        return fakeSelfScanResult()
      })
      const daemon = new ScoutDaemon(makeDeps({ selfScan, selfScanEveryMs: 15 * 60_000 }))

      await expect(daemon.tick()).resolves.toBeUndefined()
      expect(selfScan).toHaveBeenCalledTimes(1)
      expect(logs.some(l => l.includes('self-scan error') && l.includes('jellyfin not ready'))).toBe(true)

      // Gate did NOT advance on failure — a tick one second later (still well inside the
      // interval) must retry immediately, same "boot scan throws → retry next tick" semantics
      // reconcile already has for last_reconcile_at.
      now += 1_000
      await daemon.tick()
      expect(selfScan).toHaveBeenCalledTimes(2)
    })

    it('does not block dispatch or the reconcile gate — self-scan is independent of bootReconcilePending', async () => {
      const selfScan = vi.fn(async () => fakeSelfScanResult())
      const scan = vi.fn(async () => { throw new Error('jellyfin not ready') }) // boot reconcile fails
      const executeJob = vi.fn(async () => {})
      jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

      const daemon = new ScoutDaemon(makeDeps({ selfScan, scan, executeJob }))
      await daemon.tick()

      // self-scan still ran despite boot reconcile failing (and dispatch being suppressed).
      expect(selfScan).toHaveBeenCalledOnce()
      expect(executeJob).not.toHaveBeenCalled() // boot-reconcile-pending guard still holds
    })
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

  it('IMPORTANT-2: 心跳续租写回（trackedJob.lease_until = renewed）是 ownsLease 跨 tick 存活的唯一支点——真实 executor 场景下 markCovered 必须落地', async () => {
    // 生产语境：runEpisode 是真正的网络/LLM 调用，季包多集下载能合法跑超一个 tick
    // 间隔（15s）甚至一次租约窗口（30min）。daemon.tick() 的心跳每拍为仍被跟踪的
    // inflight job 续租，并把新 lease_until **原地写回** daemon 自己持有的那个 Job
    // 对象（dispatch 时 claim 到的对象，和传给 executeJob 的是同一个引用）——
    // executor.ts 的 ownsLease() 读的正是这同一个对象的 .lease_until。若心跳只续了
    // DB 里的租约、却漏了这一行写回，executeJob 手里冻结的 job.lease_until 会永远
    // 停在 claim 那一刻的旧值：下一次 ownsLease() 比对必然判定"租约已丢失"，把
    // 这次货真价实、仍合法持有该行的 invocation 自己的 markCovered 静默丢弃——
    // job 永远做不完，且零报错，只是安静地卡住。
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
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)

    type RunResult = { decision: string; journalPath?: string; subtitlePath?: string }
    let capturedOnCovered: ((id: string, path: string) => void) | undefined
    let resolveRun: (r: RunResult) => void = () => {}
    const runEpisode = vi.fn(
      (_id: string, onCovered: (id: string, path: string) => void) => {
        capturedOnCovered = onCovered
        return new Promise<RunResult>((resolve) => { resolveRun = resolve })
      }
    )

    let executeJobPromise: Promise<void> | undefined
    const executeJob = (claimedJob: Job) => {
      const p = realExecuteJob(claimedJob, {
        lib, jobs, runEpisode, now: () => now, log: () => {},
      } as ExecutorDeps)
      executeJobPromise = p
      return p
    }

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    // Tick 1: dispatch claim 该 job，真实 executeJob 启动并卡在 await runEpisode(...)
    // ——job 仍在跑，尚未产出任何决策。
    await daemon.tick()
    expect(jobs.countByState('searching')).toBe(1)
    expect(runEpisode).toHaveBeenCalledTimes(1)

    // 时间推进跨过一次租约窗口——模拟真正跑得慢的长任务（多集季包）跨越了 tick 边界。
    now += 31 * 60_000

    // Tick 2: 心跳必须在这里为仍被跟踪的 job 续租、并把新 lease_until 写回同一个
    // Job 对象引用——否则下面的 reapExpiredLeases 会把它当死租约回收（state→wanted），
    // 之后 executeJob 结算时 ownsLease() 判定失败的原因会变成"state 已不是 active"，
    // 而不是本测试要单独钉住的"lease_until 比对失配"；只要这一拍没把它错误回收，
    // 就说明续租本身生效了——是否传导给 ownsLease() 则由最后的落盘断言验证。
    await daemon.tick()
    expect(jobs.countByState('searching')).toBe(1) // 没被误回收
    expect(jobs.countByState('wanted')).toBe(0)

    // runEpisode 终于返回：季包 onCovered 命中 e1，决策 download。
    capturedOnCovered!('e1', '/tv/s1e1.zh-Hans.srt')
    resolveRun({ decision: 'download', journalPath: '/j.json' })
    await executeJobPromise

    // 心跳续租若正常写回，ownsLease() 在这里应仍判定"我拥有"，markCovered 落地、
    // job 收尾成 done——而不是被静默弃置成 stale-lease。
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(jobs.find('s1', 1)!.state).toBe('done')
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

  it('run启动时调用 gcStaging 并在清理数>0 时打日志', async () => {
    const gcStaging = vi.fn(() => 2)
    const daemon = new ScoutDaemon(makeDeps({ gcStaging }))
    const controller = new AbortController()
    const runPromise = daemon.run(controller.signal)
    await new Promise(r => setTimeout(r, 20))
    controller.abort()
    await runPromise
    expect(gcStaging).toHaveBeenCalledTimes(1)
    expect(logs.some(l => l.includes('boot: cleaned 2 orphaned staging'))).toBe(true)
  })

  it('gcStaging 未注入或返回 0 时不打日志（不影响既有 reapAllActive 行为）', async () => {
    const daemon = new ScoutDaemon(makeDeps())
    const controller = new AbortController()
    const runPromise = daemon.run(controller.signal)
    await new Promise(r => setTimeout(r, 20))
    controller.abort()
    await runPromise
    expect(logs.some(l => l.includes('boot: cleaned'))).toBe(false)
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
