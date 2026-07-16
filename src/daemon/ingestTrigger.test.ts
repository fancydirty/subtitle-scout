import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
import { makeIngestTrigger, INGEST_ORCHESTRATE_SERIES_ID, type IngestTriggerDeps } from './ingestTrigger.js'
import type { IngestResult } from '../v2/ingest.js'

function ingestResult(over: Partial<IngestResult> = {}): IngestResult {
  return { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false, ...over }
}

describe('makeIngestTrigger (去 Jellyfin 化 T4：selfScanTrigger 两信号 refresh-bridge 的替代)', () => {
  let jobs: JobsRepo
  let db: ScoutDb
  let now: number

  beforeEach(() => {
    db = openDb(':memory:')
    jobs = new JobsRepo(db)
    now = Date.now()
  })

  // 清算波 R-6（A-F8）：jobsRepo.listByState 已随死器官处决（production 零调用点）——直接换成
  // 对同一个 db 连接的原生 SQL 查询，语义逐字不变。
  function pendingOrchestrateJobs(): Job[] {
    return (db.prepare(`SELECT * FROM jobs WHERE state = 'wanted'`).all() as Job[])
      .filter(j => j.kind === 'worker_task' && j.series_id === INGEST_ORCHESTRATE_SERIES_ID)
  }

  function makeDeps(over: Partial<IngestTriggerDeps> = {}): IngestTriggerDeps {
    return {
      ingest: vi.fn(async () => ingestResult()),
      jobs,
      now: () => now,
      log: () => {},
      ...over,
    }
  }

  it('always calls ingest() exactly once and surfaces its result verbatim', async () => {
    const result = ingestResult({ scanned: 5, upserted: 2, parked: 1, removed: 0, changed: true })
    const ingest = vi.fn(async () => result)
    const tick = makeIngestTrigger(makeDeps({ ingest }))

    const out = await tick()

    expect(ingest).toHaveBeenCalledTimes(1)
    expect(out.ingest).toEqual(result)
  })

  it('changed=false → no orchestrate worker_task enqueued', async () => {
    const tick = makeIngestTrigger(makeDeps({ ingest: async () => ingestResult({ changed: false }) }))

    const out = await tick()

    expect(out.orchestratorTriggered).toBe(false)
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('changed=true → exactly one orchestrate worker_task upserted with the fixed identity', async () => {
    const tick = makeIngestTrigger(makeDeps({
      ingest: async () => ingestResult({ scanned: 3, upserted: 1, removed: 0, changed: true }),
    }))

    const out = await tick()

    expect(out.orchestratorTriggered).toBe(true)
    const pending = pendingOrchestrateJobs()
    expect(pending.length).toBe(1)
    expect(pending[0].series_id).toBe(INGEST_ORCHESTRATE_SERIES_ID)
    expect(pending[0].season).toBeNull()
    expect(pending[0].movie_id).toBeNull()
    const payload = JSON.parse(pending[0].payload!)
    expect(payload.taskType).toBe('orchestrate')
  })

  it('dedupe: a second changed=true pass while the first orchestrate job is still pending → same row, no duplicate (carried over from selfScanTrigger Signal B dedupe semantics)', async () => {
    let calls = 0
    const tick = makeIngestTrigger(makeDeps({
      ingest: async () => {
        calls++
        return ingestResult({ upserted: calls, changed: true })
      },
    }))

    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    const firstPending = pendingOrchestrateJobs()
    expect(firstPending.length).toBe(1)
    const firstJobId = firstPending[0].id

    const second = await tick()
    expect(second.orchestratorTriggered).toBe(true)

    const stillPending = pendingOrchestrateJobs()
    expect(stillPending.length).toBe(1)
    expect(stillPending[0].id).toBe(firstJobId) // same row, not a new one
  })

  it('the same identity row revives done → wanted on the next triggered pass (upsertWorkerTask semantics, not a fresh row)', async () => {
    const tick = makeIngestTrigger(makeDeps({ ingest: async () => ingestResult({ changed: true }) }))

    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    const firstJobId = pendingOrchestrateJobs()[0].id
    // 清算波 R-6（A-F8）：jobsRepo.retire 已随死器官处决（production 零调用点，原 v2/aggregate
    // 模块已随旧管线一起删除）。等价改走活体路径：claim 再 completeDone——同样是 wanted→done，
    // 只是经由 active 态中转，而不是 retire() 的 wanted/failed→done 直跳。
    expect(jobs.claimNext(now)?.id).toBe(firstJobId)
    jobs.completeDone(firstJobId, now)
    expect(pendingOrchestrateJobs().length).toBe(0)

    const second = await tick()
    expect(second.orchestratorTriggered).toBe(true)
    const pending = pendingOrchestrateJobs()
    expect(pending.length).toBe(1)
    expect(pending[0].id).toBe(firstJobId) // same identity → same row, revived done→wanted
  })

  it('log line fires only when changed=true; ingest() throwing propagates (no catch inside the trigger — daemon.ts owns fault isolation)', async () => {
    const log = vi.fn()
    const tickSilent = makeIngestTrigger(makeDeps({ ingest: async () => ingestResult({ changed: false }), log }))
    await tickSilent()
    expect(log).not.toHaveBeenCalled()

    const tickThrows = makeIngestTrigger(makeDeps({ ingest: async () => { throw new Error('boom') } }))
    await expect(tickThrows()).rejects.toThrow('boom')
  })
})
