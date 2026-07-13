import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { runReconcileAll, runOrchestrateWorkerTask } from './reconcileAll.js'

function finalTextResult(output: unknown) {
  return {
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    warnings: [],
  }
}

const fakeTmdb: Pick<TmdbClient, 'getSeasonTable'> = { getSeasonTable: async () => null }

const EMPTY_DECISION = { dispatchedFindSubtitle: 0, dispatchedRealign: 0, spawnedSiblings: 0, summary: 'nothing to do' }

describe('runReconcileAll', () => {
  it('runs the mechanical pre-scan (scanLibrary) THEN one orchestrator pass, passing orchestratorJobId through unchanged (null for the root pass)', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    const model = new MockLanguageModelV4({ doGenerate: async () => finalTextResult(EMPTY_DECISION) })

    const jf = {
      getItemsPage: async (start: number) => (start === 0 ? [
        { Id: 'e1', Name: 'E1', Type: 'Episode', Path: '/lib/Show/S01/e1.mkv', SeriesId: 's1', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 1 },
      ] as never : []),
    }

    const decision = await runReconcileAll({
      jf, lib, jobs, model, tmdb: fakeTmdb, mappings: [], skipChineseOrigin: true,
      now: () => 1000, orchestratorJobId: null, stepCap: 10,
    })

    expect(decision).toEqual(EMPTY_DECISION)
    // scanLibrary really ran first — the episode it saw got mirrored into the library.
    expect(lib.getSeries('s1')).not.toBeNull()
  })

  it('rejects (via makeOrchestratorAgent\'s own FK guard) when orchestratorJobId is a fabricated, non-existent jobs row — never runs the model', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    const model = new MockLanguageModelV4({
      doGenerate: async () => { throw new Error('model must never be called') },
    })
    const jf = { getItemsPage: async () => [] as never }

    await expect(runReconcileAll({
      jf, lib, jobs, model, tmdb: fakeTmdb, mappings: [], skipChineseOrigin: true,
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

    const model = new MockLanguageModelV4({ doGenerate: async () => finalTextResult(EMPTY_DECISION) })

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
})
