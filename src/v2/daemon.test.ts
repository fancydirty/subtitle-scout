import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo, type Job } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { ScoutDaemon, type DaemonDeps, MAX_CONSECUTIVE_TICK_FAILURES } from './daemon.js'
import { SELF_SCAN_DEFAULT_INTERVAL_MS } from '../daemon/selfScan.js'
import { INGEST_ORCHESTRATE_SERIES_ID, type IngestTriggerResult } from '../daemon/ingestTrigger.js'
import { VERIFY_SWEEP_EVERY_MS, VERIFY_SWEEP_META_KEY } from '../subtitleVerify/verifySweep.js'

function fakeIngestTriggerResult(over: Partial<IngestTriggerResult['ingest']> = {}): IngestTriggerResult {
  return {
    ingest: { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false, ...over },
    orchestratorTriggered: false,
  }
}

describe('ScoutDaemon', () => {
  let jobs: JobsRepo
  let lib: LibraryRepo
  let runs: RunsRepo

  // 清算波 R-6（A-F8）：jobsRepo.upsertWanted/find/boostPriority 已随死器官处决——ScoutDaemon
  // 测的是通用 claim/lease/dispatch 状态机（kind 无关），过去只是借 series_season 身份的
  // upsertWanted/find 当一个方便的行种子/读回手段。改为直接对 lib.db（与 jobs 共享同一个
  // sqlite 连接，见 daemon.test.ts 已有的 `lib.db.prepare(...INSERT INTO meta...)` 先例）
  // 写/读同形状的 series_season 行——forceClaim/forceState 两个仍在用的测试助手本身就
  // 硬编码 kind='series_season'，保持这个 kind 不变才能继续复用它们，语义与删除前逐字一致。
  const seedJob = (seriesId: string, season: number, seedNow: number): void => {
    lib.db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)`
    ).run(seriesId, season, seedNow, seedNow)
  }
  const findJob = (seriesId: string, season: number): Job | null =>
    (lib.db.prepare(`SELECT * FROM jobs WHERE kind = 'series_season' AND series_id = ? AND season = ?`)
      .get(seriesId, season) as Job | undefined) ?? null
  const setPriority = (seriesId: string, season: number, priority: number): void => {
    lib.db.prepare(`UPDATE jobs SET priority = ? WHERE kind = 'series_season' AND series_id = ? AND season = ?`)
      .run(priority, seriesId, season)
  }
  let now: number
  const logs: string[] = []

  beforeEach(() => {
    const db = openDb(':memory:')
    jobs = new JobsRepo(db)
    lib = new LibraryRepo(db)
    runs = new RunsRepo(db)
    now = Date.now()
    logs.length = 0
    // 债务D2 适配注记：orchestrate 兜底心跳的冷启动语义是"meta 缺失 → 视为早已过期 →
    // 立即补一拍"（真实生产场景下的合理默认）。但这套件里几乎每个既有测试都会在一个
    // 全新内存库上至少 tick() 一次，且 now 取真实 Date.now() 纪元值——远超任何合理的
    // 心跳阈值（含默认 24h）。若不预置这行 meta，绝大多数与 orchestrate 心跳无关的既有
    // 测试都会在其第一次 tick() 里意外多出一行 orchestrate worker_task（污染
    // wanted/searching 计数断言）。这里把"套件起点"预置为心跳基线的 ambient 假设——真正
    // 想测试冷启动语义的用例（见下方"债务D2"describe 块）会显式删除这行 meta 再跑。
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_orchestrate_at', ?)`).run(String(now))
  })

  const makeDeps = (overrides?: Partial<DaemonDeps>): DaemonDeps => ({
    lib,
    jobs,
    runs,
    ingestTrigger: vi.fn(async () => fakeIngestTriggerResult()),
    executeJob: vi.fn(async () => {}),
    log: (msg) => logs.push(msg),
    now: () => now,
    concurrency: { searching: 1 },
    ...overrides,
  })

  it('tick序列：reap → ingest → dispatch（去 Jellyfin 化 T4：机械 scan + B2 self-scan 折叠成单条 ingest 心跳）', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const executeJob = vi.fn(async () => {})

    seedJob('s1', 1, now)

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))
    await daemon.tick()

    // Should have called reap (implicitly, via jobsRepo calls below), ingest
    expect(ingestTrigger).toHaveBeenCalledOnce()

    // Should have claimed and executed the job
    expect(executeJob).toHaveBeenCalledOnce()
    // Check that a job was claimed
    expect(jobs.countByState('searching')).toBe(1)
    const claimedJob = findJob('s1', 1)
    expect(claimedJob?.state).toBe('searching')
  })

  it('相位分隔：巡检队列未空时先领巡检，巡检完成后的下一拍才领 translate，且不占巡检车道', async () => {
    seedJob('patrol', 1, now)
    lib.db.prepare(
      `INSERT INTO jobs (kind, movie_id, payload, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 'movie:translate', '{"taskType":"translate"}', 'wanted', 0, 0, ?, ?)`,
    ).run(now, now)

    const executeJob = vi.fn(async (job: Job) => {
      jobs.completeDone(job.id, now)
    })
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick()
    expect(executeJob).toHaveBeenCalledTimes(1)
    expect((executeJob.mock.calls[0]![0] as Job).series_id).toBe('patrol')

    await Promise.resolve()
    await daemon.tick()
    expect(executeJob).toHaveBeenCalledTimes(2)
    expect((executeJob.mock.calls[1]![0] as Job).movie_id).toBe('movie:translate')
  })

  it('FIX-4c: dispatch 为每次 claim 记一行 log——job id、series/kind、lease_until', async () => {
    seedJob('s1', 3, now)
    const executeJob = vi.fn(async () => {})
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick()

    const claimed = findJob('s1', 3)!
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
    seedJob('s1', 1, now)
    seedJob('s2', 1, now)
    seedJob('s3', 1, now)

    const daemon = new ScoutDaemon(makeDeps({ executeJob, concurrency: { searching: 1 } }))
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
    seedJob('s1', 1, now)

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
    seedJob('s1', 1, now)
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
    seedJob('s1', 1, now) // 将成为孤儿
    seedJob('s2', 1, now) // 排队中，优先级更高
    setPriority('s2', 1, 100)

    // forceClaim（测试助手）：指名领取 s1，绕开 claimNext 的 priority 排序——s2 优先级更高，
    // 若走 claimNext 反而会先领到 s2，测不出"孤儿腾出槽位给别的 job"这个点。
    const orphan = jobs.forceClaim('s1', 1, now)! // 未被任何 daemon 跟踪
    expect(orphan.series_id).toBe('s1')

    const executeJob = vi.fn(async (_job) => {})
    const daemon = new ScoutDaemon(
      makeDeps({ executeJob, concurrency: { searching: 1 } })
    )

    await daemon.tick()

    // s1 孤儿被回收（未被跟踪）→ 唯一的 searching 槽让优先级更高、排队中的 s2 领到。
    expect(executeJob).toHaveBeenCalledOnce()
    const claimedJob = executeJob.mock.calls[0][0]
    expect(claimedJob.series_id).toBe('s2')
    // s1 本身回到 wanted、没有在同一 tick 内被抢回去，attempt 不变（reap 不占内容退避梯名额）。
    expect(findJob('s1', 1)!.state).toBe('wanted')
    expect(findJob('s1', 1)!.attempt).toBe(0)
  })

  it('FIX-1: 真正 inflight（daemon 自己 claim 且仍在跟踪）的 job 不被孤儿侦测误伤', async () => {
    seedJob('s1', 1, now)

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
    seedJob('s1', 1, now)
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
    seedJob('s1', 1, now)

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
    expect(findJob('s1', 1)!.state).toBe('wanted')

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
    seedJob('s1', 1, now)

    const job = jobs.claimNext(now)
    expect(job?.state).toBe('searching')

    // Advance time past lease expiry
    now += 31 * 60_000

    // Just call reap directly to test the reap logic
    jobs.reapExpiredLeases(now)

    // Job should be back to wanted; attempt unchanged — reap is not a content
    // failure and must not consume a content-backoff-ladder slot (audit fix).
    const reaped = findJob('s1', 1)
    expect(reaped?.state).toBe('wanted')
    expect(reaped?.attempt).toBe(0)
  })

  it('tick 对意外抛错（如 reapExpiredLeases 命中满盘 SQLITE_FULL）保持隔离，不炸出 tick 之外', async () => {
    // 审计修正：reap、meta SELECT、dispatch 里的 claimNext/countByState 都不在原有的
    // try/catch 覆盖范围内——任何一处意外抛错（如磁盘写满）会让整个
    // tickLoop promise reject，悄悄被吞掉，tick 永久停摆，进程却存活不退出。
    // tick() 必须自己兜底、记日志、不向外抛。
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

    seedJob('s1', 1, now)

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

    seedJob('s1', 1, now)
    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await daemon.tick()

    const job = findJob('s1', 1)!
    const runRows = runs.getByJobId(job.id)
    expect(runRows.length).toBe(1)
    expect(runRows[0].decision).toBe('error')
    expect(runRows[0].detail).toContain('Simulated crash')
  })

  it('FIX-4b: synthetic run 行落盘本身失败（fail-soft）——不能让记录动作反过来炸主循环', async () => {
    const executeJob = vi.fn(async () => {
      throw new Error('Simulated crash')
    })
    seedJob('s1', 1, now)

    const runsSpy = vi.spyOn(runs, 'insert').mockImplementation(() => {
      throw new Error('disk full while writing runs row')
    })

    const daemon = new ScoutDaemon(makeDeps({ executeJob }))

    await expect(daemon.tick()).resolves.toBeUndefined()
    // 原有的 error log 仍然要打出来——记录失败不该吞掉既有的可观测性
    expect(logs.some(l => l.includes('Simulated crash'))).toBe(true)

    runsSpy.mockRestore()
  })

  it('ingest 抛错但继续 dispatch（稳态：boot ingest 已成功后）', async () => {
    // 稳态语义：boot ingest 成功之后，中途某轮 ingest 抖动（TMDB/文件系统瞬时故障等）
    // 不应停摆 dispatch。boot 阶段的 ingest 抛错则相反——见 'boot ingest 抛错的 tick 不 dispatch'。
    let ingestCalls = 0
    const ingestTrigger = vi.fn(async () => {
      ingestCalls++
      if (ingestCalls > 1) throw new Error('Ingest failed')
      return fakeIngestTriggerResult()
    })
    const executeJob = vi.fn(async () => {})

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))

    // Priming tick: boot ingest 成功，消耗 boot 标志
    await daemon.tick()
    ingestTrigger.mockClear()
    executeJob.mockClear()

    // 稳态：到点 ingest，抛错
    now += 16 * 60_000
    seedJob('s1', 1, now)
    await daemon.tick()

    // Ingest was attempted
    expect(ingestTrigger).toHaveBeenCalled()
    // But dispatch should still run
    expect(executeJob).toHaveBeenCalled()
    // Error logged
    expect(logs.some(l => l.includes('Ingest failed'))).toBe(true)
  })

  it('ingest仅在到点时运行（稳态：boot 强制拍之后）', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, ingestEveryMs: 15 * 60_000 }))

    // Prime: consume the boot-forced ingest (see 'boot: first tick ingests...'
    // tests) so this test can isolate the steady-state time-gate behavior below.
    await daemon.tick()
    ingestTrigger.mockClear()

    // 9 minutes since the priming tick's ingest — not yet due for the 15-min interval
    now += 9 * 60_000
    await daemon.tick()

    // Should not ingest yet
    expect(ingestTrigger).not.toHaveBeenCalled()

    // Advance past ingest interval (16 min since priming tick's ingest)
    now += 7 * 60_000
    await daemon.tick()

    // Now should ingest
    expect(ingestTrigger).toHaveBeenCalledOnce()
  })

  it('defaults ingestEveryMs to SELF_SCAN_DEFAULT_INTERVAL_MS when not overridden (沿用 daemon/selfScan.ts 已有常量，见字段注释)', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger })) // no ingestEveryMs override

    await daemon.tick() // priming tick
    ingestTrigger.mockClear()

    now += SELF_SCAN_DEFAULT_INTERVAL_MS - 1
    await daemon.tick()
    expect(ingestTrigger).not.toHaveBeenCalled()

    now += 2 // now >= SELF_SCAN_DEFAULT_INTERVAL_MS since the priming tick
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledOnce()
  })

  it('boot: first tick ingests BEFORE dispatching even when last_ingest_at is recent', async () => {
    const callOrder: string[] = []
    const ingestTrigger = vi.fn(async () => {
      callOrder.push('ingest')
      return fakeIngestTriggerResult()
    })
    const executeJob = vi.fn(async () => {
      callOrder.push('dispatch')
    })

    // last_ingest_at is recent (e.g. just written by a previous daemon process
    // seconds ago on a rolling deploy) — the time gate alone would skip the ingest.
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)`).run(String(now - 5_000))

    seedJob('s1', 1, now)

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))
    await daemon.tick()

    // Ingest must run despite the recent last_ingest_at, and must run
    // before dispatch claims/executes jobs.
    expect(ingestTrigger).toHaveBeenCalledOnce()
    expect(callOrder).toEqual(['ingest', 'dispatch'])
  })

  it('boot ingest happens only once (second tick respects the time gate again)', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())

    // Recent last_ingest_at — boot flag should force the first tick's ingest anyway.
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)`).run(String(now - 5_000))

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger }))
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledOnce()

    // Simulate another recent write to last_ingest_at (e.g. some other process,
    // or just the boot tick's own update) — the boot flag has been consumed, so
    // the plain time gate takes back over and a still-recent timestamp skips ingest.
    lib.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(now))

    await daemon.tick()

    // No additional ingest on the second tick.
    expect(ingestTrigger).toHaveBeenCalledOnce()
  })

  it('boot ingest retries next tick if the boot pass throws', async () => {
    let calls = 0
    const ingestTrigger = vi.fn(async () => {
      calls++
      if (calls === 1) throw new Error('boot ingest failed')
      return fakeIngestTriggerResult()
    })

    // Recent last_ingest_at: without the boot flag surviving the throw, the
    // time gate alone would never retry the ingest on tick 2.
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)`).run(String(now - 5_000))

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger }))

    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(1)

    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(2)
  })

  it('boot ingest 抛错的 tick 不 dispatch；下一 tick ingest 成功后才放行旧 job', async () => {
    // 整栈重启实景：文件系统/TMDB 未就绪 → scout 首 tick ingest 必抛。此时库里还躺着
    // 上个进程遗留的 stale wanted job（新分类规则尚未跑过）——boot ingest 成功前
    // 绝不能派发它，否则 boot 失败窗口内旧（未过门）job 照样触发下载。
    let ingestCalls = 0
    const ingestTrigger = vi.fn(async () => {
      ingestCalls++
      if (ingestCalls === 1) throw new Error('tmdb not ready')
      return fakeIngestTriggerResult()
    })
    const executeJob = vi.fn(async () => {})

    // Recent last_ingest_at（上个进程分钟前写的）+ 一个 stale wanted job
    lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)`).run(String(now - 5_000))
    seedJob('s1', 1, now)

    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))

    // Tick 1: boot ingest 抛错 → dispatch 必须被压制
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(1)
    expect(executeJob).not.toHaveBeenCalled()
    expect(jobs.countByState('wanted')).toBe(1) // job 原地未被 claim

    // Tick 2: ingest 成功 → boot 完成 → dispatch 放行
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(2)
    expect(executeJob).toHaveBeenCalledOnce()
  })

  describe('D4: ingest-vs-realign exclusion（design §P3，ingest 磁盘真相 walker 与 realign 整理搬移在同一批路径上跑会互相踩脚）', () => {
    it('一个正在跑的 realign worker_task 压制这一轮 ingest——即便是 boot 强制拍，也整轮跳过并留一行日志', async () => {
      vi.spyOn(jobs, 'hasActiveRealignWorkerTask').mockReturnValue(true)
      seedJob('s1', 1, now)
      const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
      const executeJob = vi.fn(async () => {})
      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))

      await daemon.tick()

      expect(ingestTrigger).not.toHaveBeenCalled()
      expect(logs.some(l => l.includes('realign') && /skip/i.test(l))).toBe(true)
      // boot 从未成功过（ingest 从未跑）→ dispatch 依旧被压制，同 boot ingest 抛错的语义一致。
      expect(executeJob).not.toHaveBeenCalled()
      expect(jobs.countByState('wanted')).toBe(1)
    })

    it('稳态（boot 已成功）中 realign 压制本轮 ingest，但 dispatch 不受影响——照常派发其他 wanted job', async () => {
      const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
      const executeJob = vi.fn(async () => {})
      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))

      await daemon.tick() // boot ingest 成功（此时无 realign 在跑），bootIngestPending 清零
      ingestTrigger.mockClear()
      executeJob.mockClear()

      vi.spyOn(jobs, 'hasActiveRealignWorkerTask').mockReturnValue(true)
      seedJob('s1', 1, now)
      now += 16 * 60_000 // 到点，若非 D4 压制本该触发 ingest

      await daemon.tick()

      expect(ingestTrigger).not.toHaveBeenCalled() // D4 压制了这一轮 ingest
      expect(executeJob).toHaveBeenCalledOnce() // dispatch 照常认领 wanted job
      expect(jobs.countByState('searching')).toBe(1)
    })

    it('realign 不再活跃后，ingest 在下一次到点/boot-forced 检查时恢复', async () => {
      const spy = vi.spyOn(jobs, 'hasActiveRealignWorkerTask')
      spy.mockReturnValue(true)
      const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger }))

      await daemon.tick() // boot round 被 D4 压制
      expect(ingestTrigger).not.toHaveBeenCalled()

      spy.mockReturnValue(false)
      await daemon.tick() // bootIngestPending 仍为 true（上轮从未成功）→ 强制再次尝试，这次放行

      expect(ingestTrigger).toHaveBeenCalledOnce()
    })
  })

  it('债务D5：ingestEveryMs 支持函数，每 tick 惰性求值（设置页改 interval 后不用重启 daemon）', async () => {
    let currentInterval = 1e9
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, ingestEveryMs: () => currentInterval }))

    // 首 tick 仍受 boot 强制拍驱动，与惰性读本身无关；清掉后才能隔离稳态时间门行为。
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(1)
    ingestTrigger.mockClear()

    // 稳态：间隔仍很大，不该触发 ingest
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(0)

    // 模拟设置页改小 scan_interval_ms -> 下一 tick 立即触发，不用重启
    currentInterval = 0
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledTimes(1)
  })

  it('债务D5：trace 快照每日修剪——只清过期 trace_json，runs 行保留，且 meta 记录时间门', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, traceRetentionDays: () => 30 }))

    seedJob('prune-series', 1, now)
    const jobId = findJob('prune-series', 1)!.id
    const oldFinishedAt = now - 31 * 86_400_000
    runs.insert({
      jobId,
      startedAt: oldFinishedAt - 1000,
      finishedAt: oldFinishedAt,
      decision: 'installed',
      detail: 'old run',
      journalPath: null,
      traceJson: '[{"old": true}]',
    })

    // 首 tick 触发修剪（冷启动 meta 缺失，视为已过期）
    await daemon.tick()

    const rows = runs.getByJobId(jobId)
    expect(rows).toHaveLength(1)
    expect(rows[0].trace_json).toBeNull()
    const metaRow = lib.db
      .prepare(`SELECT value FROM meta WHERE key = 'last_trace_prune_at'`)
      .get() as { value: string } | undefined
    expect(metaRow).toBeDefined()
    expect(Number(metaRow!.value)).toBeGreaterThan(0)

    // 再种一行旧 trace，但时间门未过，不应再修剪
    const pruneSpy = vi.spyOn(runs, 'pruneTraces')
    runs.insert({
      jobId,
      startedAt: oldFinishedAt - 1000,
      finishedAt: oldFinishedAt,
      decision: 'installed',
      detail: 'another old run',
      journalPath: null,
      traceJson: '[{"old": true}]',
    })
    now += 1000
    await daemon.tick()
    expect(pruneSpy).not.toHaveBeenCalled()
    pruneSpy.mockRestore()
  })

  describe('债务D2（胶水层修复战役）：orchestrate 24h 兜底心跳——无变化世界里 ingest 恒 changed=0 永不触发 orchestrate，"识别晚到/pending 屏蔽"类惰性收敛洞永不愈合', () => {
    // orchestrate worker_task 行的固定 identity（同 ingest 触发的那一行）——两条来源天然落
    // 同一行，故意不按 state 过滤：心跳/ingest 各自 upsert 后行可能已被 dispatch 认领进
    // searching，仍要能查到同一行（idempotent dedup 的证据）。
    function orchestrateWorkerTaskRows() {
      return lib.db
        .prepare(`SELECT id, payload, state FROM jobs WHERE kind = 'worker_task' AND series_id = ?`)
        .all(INGEST_ORCHESTRATE_SERIES_ID) as Array<{ id: number; payload: string | null; state: string }>
    }

    it('无变化世界到点补一个 orchestrate 兜底 pass（identity=ingest-trigger，幂等）', async () => {
      // beforeEach 的 ambient 种子把 last_orchestrate_at 预置成了套件起点——这里删掉它，
      // 显式还原到"meta 真的缺失"这个要测的冷启动状态。
      lib.db.prepare(`DELETE FROM meta WHERE key = 'last_orchestrate_at'`).run()

      // ingestTrigger 恒返回零变化/未触发；orchestrateHeartbeatMs 注入一个小值。
      const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, orchestrateHeartbeatMs: 1000 }))

      // Tick 1（boot 首拍）：ingest 成功；meta 里 last_orchestrate_at 缺失 → 视同"早已过期"，
      // 心跳立即补一拍（冷启动语义：停机期间积累的惰性洞正好接住）。
      await daemon.tick()
      expect(orchestrateWorkerTaskRows().length).toBe(1)

      // 再跨过一次阈值：identity 去重保证还是同一行，不多出第二行。
      now += 1000
      await daemon.tick()

      const rows = orchestrateWorkerTaskRows()
      expect(rows.length).toBe(1)
      const payload = JSON.parse(rows[0].payload!)
      expect(payload.taskType).toBe('orchestrate')
    })

    it('ingest 自己触发过 orchestrate 的 tick 刷新时钟，不重复入队', async () => {
      const orchestrateHeartbeatMs = 5000

      // 故意把种子值设成"已经过期"（早于阈值）——模拟"心跳本该已经到点，但这一 tick 里
      // ingest 自己先一步触发了 orchestrate"。若 daemon 没有落实"任何一次 orchestrate
      // 入队都刷新时钟"，心跳块会在同一 tick 内基于这个陈旧种子值误判过期、重复触发
      // （可观测为一行 'orchestrate heartbeat' log）。
      lib.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('last_orchestrate_at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(String(now - orchestrateHeartbeatMs - 1))

      // 模拟真实 makeIngestTrigger 的副作用：ingest 自己检测到变化时会 upsert 一行
      // orchestrate worker_task 并报告 orchestratorTriggered=true。
      const ingestTrigger = vi.fn(async () => {
        jobs.upsertWorkerTask(
          { seriesId: INGEST_ORCHESTRATE_SERIES_ID, season: null, movieId: null },
          { taskType: 'orchestrate', reason: 'ingest: scanned=1 upserted=1 parked=0 removed=0' },
          null,
          now,
        )
        return {
          ingest: { scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true },
          orchestratorTriggered: true,
        }
      })

      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, orchestrateHeartbeatMs }))

      await daemon.tick()

      expect(orchestrateWorkerTaskRows().length).toBe(1) // 幂等：同一 identity，未产生第二行
      expect(logs.some(l => l.includes('orchestrate heartbeat'))).toBe(false) // 心跳块本 tick 未再触发
    })

    it('心跳未到点不入队', async () => {
      // ambient 种子（beforeEach）已把 last_orchestrate_at 设为套件起点 now，未删除 →
      // 走的是稳态时间门判定，不涉及冷启动路径。
      const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, orchestrateHeartbeatMs: 24 * 3_600_000 }))

      now += 60_000 // 远未到 24h 阈值
      await daemon.tick()

      expect(logs.some(l => l.includes('orchestrate heartbeat'))).toBe(false)
      expect(orchestrateWorkerTaskRows().length).toBe(0)
    })

    it('boot 首拍 ingest 未成功前不心跳', async () => {
      // boot ingest 抛错 → bootIngestPending 仍为 true → tickInner 在心跳块之前的
      // `if (this.bootIngestPending) return` 守卫处提前返回，心跳块根本不会跑到——
      // 即便阈值小到 1ms 也不该触发（stale 世界不派活的既有语义对齐）。
      const ingestTrigger = vi.fn(async () => { throw new Error('tmdb not ready') })
      const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, orchestrateHeartbeatMs: 1 }))

      await daemon.tick()

      expect(logs.some(l => l.includes('orchestrate heartbeat'))).toBe(false)
      expect(orchestrateWorkerTaskRows().length).toBe(0)
    })
  })

  it('run启动即回收上个进程的活跃租约（未过期也回收）', async () => {
    // 生产实案：部署重启瞬间在跑的 job 租约僵尸占 searching 槽最长 30 分钟。
    // 模拟旧进程遗孤：claim 后"进程死了"，租约仍在 30min 窗口内未过期。
    seedJob('s1', 1, now)
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

  it('run循环：单条 tick loop 运行，signal退出', async () => {
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

    seedJob('s1', 1, now)

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

  describe('E AI 翻译:dispatchTranslate 钩子(env 门控)', () => {
    it('注入时每 tick 触发一次(boot ingest 门后)', async () => {
      const dispatchTranslate = vi.fn(() => {})
      const daemon = new ScoutDaemon(makeDeps({ dispatchTranslate }))
      await daemon.tick()
      expect(dispatchTranslate).toHaveBeenCalledOnce()
    })

    it('未注入(功能休眠)时 tick 正常不崩', async () => {
      const daemon = new ScoutDaemon(makeDeps({ dispatchTranslate: undefined }))
      await expect(daemon.tick()).resolves.toBeUndefined()
    })

    it('派活抛错只 warn 不炸 tick(增益路径不拖垮主循环)', async () => {
      const dispatchTranslate = vi.fn(() => { throw new Error('translate dispatch boom') })
      const executeJob = vi.fn(async () => {})
      const daemon = new ScoutDaemon(makeDeps({ dispatchTranslate, executeJob }))
      await expect(daemon.tick()).resolves.toBeUndefined()
      expect(logs.some((l) => l.includes('translate dispatch failed'))).toBe(true)
    })
  })

  // Task 6：字幕校验巡检接线。这条分支是校验功能对用户可见的唯一通道——correct/revert
  // 两条写路径的前置都是"库里已有一行结论"，没有任何地方给"从未检测过"的条目做首次检测
  // （见 subtitleVerify/verifySweep.ts 头注释）。
  describe('字幕校验巡检:verifySweep 钩子(低频时间门 + optional)', () => {
    const readSweepMeta = (): number | null => {
      const row = lib.db.prepare(`SELECT value FROM meta WHERE key = ?`)
        .get(VERIFY_SWEEP_META_KEY) as { value: string } | undefined
      return row ? Number(row.value) : null
    }

    it('未注入(既有测试/CLI 调用点不传)时整个分支跳过,不写 meta,tick 不崩', async () => {
      const daemon = new ScoutDaemon(makeDeps({ verifySweep: undefined }))
      await expect(daemon.tick()).resolves.toBeUndefined()
      expect(readSweepMeta()).toBeNull()
    })

    it('meta 缺失(冷启动)→ 立即扫一拍,并写下时间戳', async () => {
      const verifySweep = vi.fn(async () => {})
      const daemon = new ScoutDaemon(makeDeps({ verifySweep }))
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      expect(readSweepMeta()).toBe(now)
    })

    // 时间门回归锁：去掉时间门（每 tick 都跑）时这个断言必红。6h 间隔 vs 15s 一拍，
    // 每拍都扫会让 ffmpeg 抽轨成为主循环的常态成本。
    it('时间门未到点 → 不扫(不是每 tick 都跑)', async () => {
      const verifySweep = vi.fn(async () => {})
      const deps = makeDeps({ verifySweep, verifySweepEveryMs: 6 * 3_600_000 })
      const daemon = new ScoutDaemon(deps)
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      // 第二拍：15s 后，远未到 6h
      now += 15_000
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      // 到点后才第二次
      now += 6 * 3_600_000
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledTimes(2)
    })

    it('默认间隔 = VERIFY_SWEEP_EVERY_MS(6h)', async () => {
      const verifySweep = vi.fn(async () => {})
      const daemon = new ScoutDaemon(makeDeps({ verifySweep }))
      await daemon.tick()
      now += VERIFY_SWEEP_EVERY_MS - 1
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      now += 1
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledTimes(2)
    })

    it('间隔支持函数形式(惰性求值,同 ingestEveryMs 的债务D5 口径)', async () => {
      const verifySweep = vi.fn(async () => {})
      let every = 6 * 3_600_000
      const daemon = new ScoutDaemon(makeDeps({ verifySweep, verifySweepEveryMs: () => every }))
      await daemon.tick()
      now += 60_000
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      // 运行中把间隔改小 → 下一拍即生效，不用重启进程
      every = 30_000
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledTimes(2)
    })

    it('meta 行损坏(NaN)→ 防御性归零,时间门不静默永久失效', async () => {
      lib.db.prepare(`INSERT INTO meta (key, value) VALUES (?, 'garbage')`).run(VERIFY_SWEEP_META_KEY)
      const verifySweep = vi.fn(async () => {})
      const daemon = new ScoutDaemon(makeDeps({ verifySweep }))
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
    })

    // 失败隔离回归锁：去掉这一层 catch 时 tick 会 reject（或冒成 unhandled rejection），
    // 断言必红。
    it('扫描抛错只 warn 不炸 tick(增益路径不拖垮主循环)', async () => {
      const verifySweep = vi.fn(async () => { throw new Error('sweep boom') })
      const daemon = new ScoutDaemon(makeDeps({ verifySweep }))
      await expect(daemon.tick()).resolves.toBeUndefined()
      // fire-and-forget：等 microtask 队列排空后 catch 才落到 log
      await new Promise((r) => setTimeout(r, 0))
      expect(logs.some((l) => l.includes('verify sweep failed'))).toBe(true)
    })

    it('fire-and-forget:不 await 扫描(5 分钟预算不能堵住 dispatch)', async () => {
      let release = (): void => {}
      const verifySweep = vi.fn(() => new Promise<void>((r) => { release = r }))
      const executeJob = vi.fn(async () => {})
      seedJob('s1', 1, now)
      const daemon = new ScoutDaemon(makeDeps({ verifySweep, executeJob }))
      // 扫描还挂着没结算，tick 就该返回、且 dispatch 已经派过活
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      expect(executeJob).toHaveBeenCalledOnce()
      release()
    })

    // 并发防线：一次扫描墙钟预算 5 分钟 ≈ 20 拍。若重入锁失效，20 路 ffmpeg 并发抽轨——
    // 正是"绝不并行"要防的事。
    it('上一轮扫描仍在跑时不重入(即便时间门到点)', async () => {
      let release = (): void => {}
      const verifySweep = vi.fn(() => new Promise<void>((r) => { release = r }))
      const daemon = new ScoutDaemon(makeDeps({ verifySweep, verifySweepEveryMs: 1 }))
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      now += 3_600_000
      await daemon.tick()
      now += 3_600_000
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledOnce()
      // 结算后才允许下一轮
      release()
      await new Promise((r) => setTimeout(r, 0))
      now += 3_600_000
      await daemon.tick()
      expect(verifySweep).toHaveBeenCalledTimes(2)
    })

    it('boot ingest 未完成时不扫(同 dispatch 的 boot 守卫之后)', async () => {
      const verifySweep = vi.fn(async () => {})
      const ingestTrigger = vi.fn(async () => { throw new Error('ingest down') })
      const daemon = new ScoutDaemon(makeDeps({ verifySweep, ingestTrigger }))
      await daemon.tick()
      expect(verifySweep).not.toHaveBeenCalled()
    })
  })

describe('ScoutDaemon · 发动机闸（spec A §4.6/§4.7）', () => {
  it('permitted=false → 产工作全闸、dbMaintenance 照跑、队列原样保留', async () => {
    let permitted = true
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const executeJob = vi.fn(async () => {})
    const dispatchTranslate = vi.fn()
    const dbMaintenance = vi.fn()
    const verifySweep = vi.fn(async () => {})
    const daemon = new ScoutDaemon(makeDeps({
      ingestTrigger, executeJob, dispatchTranslate, dbMaintenance, verifySweep,
      workPermitted: () => permitted,
    }))
    await daemon.tick()   // tick1：permitted → boot ingest 成功，bootIngestPending 清掉
    expect(ingestTrigger).toHaveBeenCalledOnce()
    ingestTrigger.mockClear(); executeJob.mockClear(); dispatchTranslate.mockClear()
    verifySweep.mockClear(); dbMaintenance.mockClear()

    seedJob('s1', 1, now)
    permitted = false
    now += 7 * 3_600_000   // ingest（15min）与 verifySweep（6h）双双到点——不到点没法区分"闸"与"门"
    await daemon.tick()    // tick2：全闸
    expect(ingestTrigger).not.toHaveBeenCalled()
    expect(dispatchTranslate).not.toHaveBeenCalled()
    expect(verifySweep).not.toHaveBeenCalled()
    expect(executeJob).not.toHaveBeenCalled()            // dispatch 被闸 → 无人 claim
    expect(findJob('s1', 1)!.state).toBe('wanted')       // 暂停语义：队列原样保留，重开后续跑
    expect(dbMaintenance).toHaveBeenCalledOnce()         // 维护循环不闸
  })

  it('workPermitted 缺省 → 一切照旧（回归：今天的行为）', async () => {
    const ingestTrigger = vi.fn(async () => fakeIngestTriggerResult())
    const executeJob = vi.fn(async () => {})
    seedJob('s1', 1, now)
    const daemon = new ScoutDaemon(makeDeps({ ingestTrigger, executeJob }))
    await daemon.tick()
    expect(ingestTrigger).toHaveBeenCalledOnce()
    expect(executeJob).toHaveBeenCalledTimes(1)
  })

  it('off→on→off 翻转各记一行日志；首个 tick 不记（null 初始）', async () => {
    let permitted = true
    const daemon = new ScoutDaemon(makeDeps({
      ingestTrigger: vi.fn(async () => fakeIngestTriggerResult()),
      executeJob: vi.fn(async () => {}),
      workPermitted: () => permitted,
    }))
    await daemon.tick()
    expect(logs.filter((l) => l.startsWith('engine '))).toHaveLength(0)
    permitted = false
    await daemon.tick()
    expect(logs.some((l) => l.includes('engine off'))).toBe(true)
    expect(logs.some((l) => l.includes('engine on'))).toBe(false)
    permitted = true
    await daemon.tick()
    expect(logs.some((l) => l.includes('engine on'))).toBe(true)
  })

  it('preTick 每 tick 最先被调用（先于 ingest/dispatch）', async () => {
    const order: string[] = []
    const daemon = new ScoutDaemon(makeDeps({
      ingestTrigger: vi.fn(async () => { order.push('ingest'); return fakeIngestTriggerResult() }),
      executeJob: vi.fn(async () => {}),
      preTick: async () => { order.push('preTick') },
    }))
    await daemon.tick()
    expect(order[0]).toBe('preTick')
    expect(order).toContain('ingest')
  })
})
})
