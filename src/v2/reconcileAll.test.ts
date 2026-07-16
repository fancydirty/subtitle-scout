import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { runReconcileAll, runOrchestrateWorkerTask } from './reconcileAll.js'

/** Terminal step of a REAL orchestrator pass: a NATIVE tool_call to `finalize` carrying the
 *  OrchestratorDecision as its args (finalize-tool mode, not an Output.object text blob).
 *  hasToolCall('finalize') stops the loop; readFinalized() surfaces these args as the decision. */
function finalizeResult(output: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId: 'finalize-1', toolName: 'finalize', input: JSON.stringify(output) }],
    warnings: [],
  }
}

const fakeTmdb: Pick<TmdbClient, 'getSeasonTable'> = { getSeasonTable: async () => null }
const EMPTY_DECISION = { dispatchedFindSubtitle: 0, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'nothing to do' }

describe('runReconcileAll', () => {
  it('runs the ingest pass THEN one orchestrator pass, passing orchestratorJobId through unchanged (null for the root pass)', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    const model = new MockLanguageModelV4({ doGenerate: async () => finalizeResult(EMPTY_DECISION)})

    let ingestCalled = false
    const ingest = async () => {
      ingestCalled = true
      // Stand-in for a real v2/ingest.ts pass writing a row — runReconcileAll (去 Jellyfin 化 T4)
      // only cares that deps.ingest() ran before the orchestrator pass, not its internal shape.
      lib.upsertSeries({ id: 's1', name: 'Show' })
    }

    const decision = await runReconcileAll({
      ingest, lib, jobs, model, tmdb: fakeTmdb,
      now: () => 1000, orchestratorJobId: null, stepCap: 10,
    })

    expect(decision).toEqual(EMPTY_DECISION)
    expect(ingestCalled).toBe(true)
    // ingest really ran first — the row it wrote is visible in the library.
    expect(lib.getSeries('s1')).not.toBeNull()
  })

  it('rejects (via makeOrchestratorAgent\'s own FK guard) when orchestratorJobId is a fabricated, non-existent jobs row — never runs the model', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    const model = new MockLanguageModelV4({
      doGenerate: async () => { throw new Error('model must never be called') },
    })

    await expect(runReconcileAll({
      ingest: async () => {}, lib, jobs, model, tmdb: fakeTmdb,
      now: () => 1000, orchestratorJobId: 999999, stepCap: 10,
    })).rejects.toThrow(/orchestratorJobId=999999 does not reference an existing jobs row/)
  })
})

describe('runOrchestrateWorkerTask', () => {
  it('claims a kind=worker_task row (payload.taskType=orchestrate), runs a sibling orchestrator pass with orchestratorJobId=job.id, and completes it done', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-0', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
    const job = jobs.claimNext(1000)!

    const model = new MockLanguageModelV4({ doGenerate: async () => finalizeResult(EMPTY_DECISION)})

    const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 1000, stepCap: 10 }, jobs)

    expect(decision).toEqual(EMPTY_DECISION)
    expect(jobs.get(job.id)!.state).toBe('done')
  })

  it('worker-exhaustion: a thrown orchestrator pass (schema mismatch, step-cap, network) fails the job via completeError instead of crashing the caller', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-1', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
    const job = jobs.claimNext(1000)!

    const model = new MockLanguageModelV4({
      doGenerate: async () => { throw new Error('network exploded') },
    })

    const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 1000, stepCap: 10 }, jobs)

    expect(decision).toBeNull()
    const row = jobs.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toMatch(/network exploded/)
  })

  // B3（审计发现，意图黑洞）：spawn_sibling_orchestrator 写下的 remainingWorkSummary 此前从未
  // 被读回——runOrchestrateWorkerTask 是读回它的落点，claim 到的 job.payload 里若带这个字段，
  // 就把它作为 promptSuffix 传给 makeOrchestratorAgent，最终拼进 sibling pass 的 prompt。
  it('payload.remainingWorkSummary is read back and injected into the sibling pass prompt as a handoff note', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    jobs.upsertWorkerTask(
      { seriesId: 'orchestrator-shard-root-2', season: null, movieId: null },
      { taskType: 'orchestrate', remainingWorkSummary: 'series s3..s10 still need dispatch' },
      null, 1000,
    )
    const job = jobs.claimNext(1000)!

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const userMessage = options.prompt.find((m: any) => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        return finalizeResult(EMPTY_DECISION)
      },
    })

    const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 1000, stepCap: 10 }, jobs)

    expect(decision).toEqual(EMPTY_DECISION)
    expect(capturedPromptText).toContain('Handoff note from the orchestrator that spawned you')
    expect(capturedPromptText).toContain('series s3..s10 still need dispatch')
  })

  it('payload without remainingWorkSummary (or malformed JSON) → no handoff note in the prompt, does not throw', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    jobs.upsertWorkerTask(
      { seriesId: 'orchestrator-shard-root-3', season: null, movieId: null },
      { taskType: 'orchestrate' }, // no remainingWorkSummary at all
      null, 1000,
    )
    const job = jobs.claimNext(1000)!

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const userMessage = options.prompt.find((m: any) => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        return finalizeResult(EMPTY_DECISION)
      },
    })

    const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 1000, stepCap: 10 }, jobs)

    expect(decision).toEqual(EMPTY_DECISION)
    expect(capturedPromptText).not.toContain('Handoff note')
  })

  // F-R2-3（R2 复审，审计定罪：orchestrator 汇报黑洞）：runOrchestrateWorkerTask 拿到
  // OrchestratorDecision 后此前只 completeDone，从不写 runs——sibling pass 的 summary（dispatch
  // 计数 + 措辞摘要）从未抵达 dashboard 时间线，是 blocked_dormant"上报人类"教导缺失的落地通道:
  // summary 进 runs = 进 dashboard 时间线。
  describe('runs row (dashboard 时间线落地, F-R2-3)', () => {
    it('completeDone 前写一行 decision="orchestrate" 的 runs，detail 汇总 dispatch 计数 + summary', async () => {
      const db = openDb(':memory:')
      const jobs = new JobsRepo(db)
      const lib = new LibraryRepo(db)
      const runs = new RunsRepo(db)
      jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-4', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
      const job = jobs.claimNext(1000)!

      const decision = { dispatchedFindSubtitle: 2, dispatchedRealign: 1, spawnedSiblings: 0, summary: 'dispatched the backlog' }
      const model = new MockLanguageModelV4({ doGenerate: async () => finalizeResult(decision) })

      const result = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 2000, stepCap: 10, runs }, jobs)

      expect(result).toEqual(decision)
      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        job_id: job.id, decision: 'orchestrate',
        detail: 'dispatched 2 find / 1 realign, siblings 0: dispatched the backlog',
      })
      expect(jobs.get(job.id)!.state).toBe('done')
    })

    it('caps an overlong summary at 200 chars in the runs detail (dashboard timeline hygiene)', async () => {
      const db = openDb(':memory:')
      const jobs = new JobsRepo(db)
      const lib = new LibraryRepo(db)
      const runs = new RunsRepo(db)
      jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-5', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
      const job = jobs.claimNext(1000)!

      const decision = { dispatchedFindSubtitle: 0, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'x'.repeat(300) }
      const model = new MockLanguageModelV4({ doGenerate: async () => finalizeResult(decision) })

      await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 2000, stepCap: 10, runs }, jobs)

      const rows = runs.getByJobId(job.id)
      expect(rows[0].detail!.length).toBe(200)
    })

    it('deps.runs omitted: does not crash, decision still completes done, simply skips writing a runs row', async () => {
      const db = openDb(':memory:')
      const jobs = new JobsRepo(db)
      const lib = new LibraryRepo(db)
      jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-6', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
      const job = jobs.claimNext(1000)!

      const model = new MockLanguageModelV4({ doGenerate: async () => finalizeResult(EMPTY_DECISION) })

      const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 1000, stepCap: 10 }, jobs)

      expect(decision).toEqual(EMPTY_DECISION)
      expect(jobs.get(job.id)!.state).toBe('done')
    })

    it('worker-exhaustion path (thrown pass) does NOT write a runs row — completeError already records last_error, no duplicate reporting channel', async () => {
      const db = openDb(':memory:')
      const jobs = new JobsRepo(db)
      const lib = new LibraryRepo(db)
      const runs = new RunsRepo(db)
      jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-7', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
      const job = jobs.claimNext(1000)!

      const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('network exploded') } })

      const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 1000, stepCap: 10, runs }, jobs)

      expect(decision).toBeNull()
      expect(runs.getByJobId(job.id)).toHaveLength(0)
      expect(jobs.get(job.id)!.state).toBe('failed')
    })

    // G3（痕迹通道 C）：端到端穿透——不手工往 traceBus 塞事件，而是让真实 ToolLoopAgent 走一步
    // 工具调用（list_missing_coverage）再 finalize，验证 orchestratorAgent.ts 的 onStepEvent
    // 接线（runKey=`job-${orchestratorJobId}`，此处 orchestratorJobId 即 job.id）与
    // runOrchestrateWorkerTask 的收官快照读出（同一个 runKey）真的对上了。
    it('runs 行的 trace_json 携带真实 agent 跑产生的工具调用痕迹（onStepEvent → traceBus → 收官快照全链路）', async () => {
      const db = openDb(':memory:')
      const jobs = new JobsRepo(db)
      const lib = new LibraryRepo(db)
      const runs = new RunsRepo(db)
      jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-8', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
      const job = jobs.claimNext(1000)!

      let call = 0
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          call++
          if (call === 1) {
            return {
              finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
              usage: {
                inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
                outputTokens: { total: 5, text: undefined, reasoning: undefined },
              },
              content: [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'list_missing_coverage', input: JSON.stringify({}) }],
              warnings: [],
            }
          }
          return finalizeResult(EMPTY_DECISION)
        },
      })

      await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model, now: () => 2000, stepCap: 10, runs }, jobs)

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].trace_json).not.toBeNull()
      const events = JSON.parse(rows[0].trace_json!) as Array<{ runKey: string; seq: number; tool: string }>
      expect(events.map((e) => e.tool)).toEqual(['list_missing_coverage', 'finalize'])
      expect(events.every((e) => e.runKey === `job-${job.id}`)).toBe(true)
      expect(events.map((e) => e.seq)).toEqual([0, 1])
    })

    // 复审修复：catch 分支必须排空缓冲——失败尝试的痕迹不入账（completeError 不写 runs 行），
    // 也不许残留到同一 job 重试成功那次的快照里（重试时 makeRunTracer 重新构造、seq 从 0 重计，
    // 残留+新事件混在同一环形缓冲 = seq 碰撞、回放乱序）。
    it('orchestrate 抛错后同 job 重试成功：成功行 trace_json 只含第二次的事件（失败尝试痕迹已排空，seq 从 0 单调无碰撞）', async () => {
      const db = openDb(':memory:')
      const jobs = new JobsRepo(db)
      const lib = new LibraryRepo(db)
      const runs = new RunsRepo(db)
      jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-9', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
      const job = jobs.claimNext(1000)!

      const listCall = () => ({
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: undefined, reasoning: undefined },
        },
        content: [{ type: 'tool-call' as const, toolCallId: 'c1', toolName: 'list_missing_coverage', input: JSON.stringify({}) }],
        warnings: [],
      })

      // 第一次尝试：走完一步真实工具调用（onStepEnd 发布一条痕迹进缓冲）之后模型爆炸——
      // runPass 抛出，completeError，不写 runs 行。
      let failingCall = 0
      const failingModel = new MockLanguageModelV4({
        doGenerate: async () => {
          failingCall++
          if (failingCall === 1) return listCall()
          throw new Error('network exploded mid-pass')
        },
      })
      const failed = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, model: failingModel, now: () => 2000, stepCap: 10, runs }, jobs)
      expect(failed).toBeNull()
      expect(runs.getByJobId(job.id)).toHaveLength(0)
      expect(jobs.get(job.id)!.state).toBe('failed')

      // 重试：backoff 过期后 claimNext 重新领取同一行（id 不变 ⇒ runKey 不变，正是污染场景）。
      const retried = jobs.claimNext(Number.MAX_SAFE_INTEGER)!
      expect(retried.id).toBe(job.id)
      let okCall = 0
      const okModel = new MockLanguageModelV4({
        doGenerate: async () => {
          okCall++
          if (okCall === 1) return listCall()
          return finalizeResult(EMPTY_DECISION)
        },
      })
      await runOrchestrateWorkerTask(retried, { lib, tmdb: fakeTmdb, model: okModel, now: () => 3000, stepCap: 10, runs }, jobs)

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      const events = JSON.parse(rows[0].trace_json!) as Array<{ seq: number; tool: string }>
      // 无残留：只有第二次尝试的两个事件；seq 从 0 单调（残留在场时会是 3 个事件且 seq 0,0,1 碰撞）。
      expect(events.map((e) => e.tool)).toEqual(['list_missing_coverage', 'finalize'])
      expect(events.map((e) => e.seq)).toEqual([0, 1])
    })
  })
})
