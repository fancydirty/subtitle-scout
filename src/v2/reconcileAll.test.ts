import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { PlayerServer } from '../adapters/players/types.js'
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
const fakeJf: Pick<PlayerServer, 'getItem'> = { getItem: async () => null as never }

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
      ingest, lib, jobs, model, tmdb: fakeTmdb, jf: fakeJf,
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
      ingest: async () => {}, lib, jobs, model, tmdb: fakeTmdb, jf: fakeJf,
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

    const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, jf: fakeJf, model, now: () => 1000, stepCap: 10 }, jobs)

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

    const decision = await runOrchestrateWorkerTask(job, { lib, tmdb: fakeTmdb, jf: fakeJf, model, now: () => 1000, stepCap: 10 }, jobs)

    expect(decision).toBeNull()
    const row = jobs.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toMatch(/network exploded/)
  })
})
