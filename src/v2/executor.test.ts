import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { executeJob, type ExecutorDeps } from './executor.js'

let lib: LibraryRepo
let jobs: JobsRepo
let runs: RunsRepo
let now: number
let logs: string[]

beforeEach(() => {
  const db = openDb(':memory:')
  lib = new LibraryRepo(db)
  jobs = new JobsRepo(db)
  runs = new RunsRepo(db)
  now = Date.now()
  logs = []
})

const log = (msg: string) => logs.push(msg)

// 退役T7 (Wave 2A)：series_season/movie 的旧执行内部（代表集重derive/onCovered/complete*
// 决策路由、makeRunEpisode Layer 2 接线）连同覆盖它们的整套用例已删除——旧执行器不再接线，
// cli/index.ts 的 routeLegacyJob 在 claimNext() 领到这两个 kind 之后、到达 executeJob 之前
// 就已经 tombstone 掉它们（见 legacyJobRouting.test.ts）。原 describe('执行器') 与
// describe('makeRunEpisode (Layer 2 接线)') 两个块（含 T3 no_safe_match/realign-upsert
// 不变量用例——其"subject"即旧 no_safe_match 分支本身已不存在，随之删除）已整体移除；
// 下面只保留仍然成立的两类覆盖：①新的"接线回归警报"防护网，②realign 分支（保留机械，
// 一行未动）。

describe('executeJob: old-pipeline kind 已退休（Wave 2A 接线回归警报）', () => {
  it('kind==="series_season" → throw（不再静默 no-op，也不再是旧执行内部）', async () => {
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    const deps: ExecutorDeps = { lib, jobs, now: () => now, log }
    await expect(executeJob(job, deps)).rejects.toThrow(/old-pipeline kind series_season retired \(Wave 2A\)/)
  })

  it('kind==="movie" → throw（同上）', async () => {
    jobs.upsertWanted({ kind: 'movie', movieId: 'm1' }, now)
    const job = jobs.claimNext(now)!
    const deps: ExecutorDeps = { lib, jobs, now: () => now, log }
    await expect(executeJob(job, deps)).rejects.toThrow(/old-pipeline kind movie retired \(Wave 2A\)/)
  })
})

describe('realign job 执行分流', () => {
  // D-review #3：未接线曾走 completeError → failed → 30s 后又被 claimNext 领走 → 再
  // completeError……30s→15min→daily 的无穷 errorloop。接线缺失不是瞬时故障，重试
  // 一万次也不会自己长出 executeRealign——诚实的出口是停车（dormant，不参与派发）。
  it('job.kind==="realign" 且 executeRealign 未注入 → 停车（单条 run，不可重领，无循环）', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    await executeJob(job, { lib, jobs, now: () => now, log })
    expect(jobs.get(job.id)!.state).toBe('dormant')
    const runRows = runs.getByJobId(job.id)
    expect(runRows).toHaveLength(1)
    expect(runRows[0].decision).toBe('error')
    expect(runRows[0].detail).toContain('未接线')
    expect(runRows[0].detail).toContain('停车')
    // 不可重试：一天后 claimNext 也捞不起来（dormant 不参与派发）
    expect(jobs.claimNext(now + 25 * 3_600_000)).toBeNull()
    expect(logs.some(l => l.includes('未接线') && l.includes('停车'))).toBe(true)
  })

  it('job.kind==="realign" + executeRealign 成功 → completeDone + runs 记人话', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => ({ decision: 'realigned' as const, detail: '把 40 集平铺整理成 3 季，字幕已就位' }))
    await executeJob(job, { lib, jobs, now: () => now, log, executeRealign })
    expect(jobs.get(job.id)!.state).toBe('done')
    expect(runs.getByJobId(job.id)[0].detail).toBe('把 40 集平铺整理成 3 季，字幕已就位')
  })

  it('job.kind==="realign" + executeRealign 判失败 → completeError', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => ({ decision: 'error' as const, detail: '挂载探针失败：库根为空' }))
    await executeJob(job, { lib, jobs, now: () => now, log, executeRealign })
    expect(jobs.get(job.id)!.state).toBe('failed')
  })

  it('job.kind==="realign" + executeRealign 判 park（确定性失败）→ 停车 dormant，不进重试环', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => ({ decision: 'park' as const, detail: '整理计划构建失败：映射目标重复' }))
    await executeJob(job, { lib, jobs, now: () => now, log, executeRealign })
    const after = jobs.get(job.id)!
    expect(after.state).toBe('dormant')
    expect(after.last_error).toContain('映射目标重复')
    const runRows = runs.getByJobId(job.id)
    expect(runRows).toHaveLength(1)
    expect(runRows[0].detail).toContain('停车')
    // 一天后也不可重领（dormant 不参与派发——不是 30s→daily 的瞬时错误重试环）
    expect(jobs.claimNext(now + 25 * 3_600_000)).toBeNull()
  })

  it('job.kind==="realign" + executeRealign 抛异常 → completeError（同 catch 路径）', async () => {
    jobs.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = jobs.claimNext(now)!
    const executeRealign = vi.fn(async () => { throw new Error('EXDEV') })
    await executeJob(job, { lib, jobs, now: () => now, log, executeRealign })
    expect(jobs.get(job.id)!.state).toBe('failed')
  })
})
