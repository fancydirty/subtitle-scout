import { describe, it, expect, beforeEach } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { openDb } from '../v2/db.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { makeOrchestratorAgent } from './orchestratorAgent.js'

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}

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

/** Reads a prior tool call's JSON result out of a scripted step's own prompt history, keyed by
 *  toolCallId (not toolName) — this suite scripts multiple calls to the SAME tool
 *  (dispatch_find_subtitle_task) with different toolCallIds, so matching by name alone would
 *  always return the first match. Mirrors findSubtitleWorker.test.ts's findToolResultValue. */
function findToolResultValueById(prompt: LanguageModelV4Prompt, toolCallId: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content) {
      if (part.type === 'tool-result' && part.toolCallId === toolCallId && part.output.type === 'json') {
        return part.output.value
      }
    }
  }
  throw new Error(`no tool-result for toolCallId=${toolCallId} found in prompt history`)
}

const fakeTmdb: Pick<TmdbClient, 'getSeasonTable'> = {
  getSeasonTable: async () => null,
}

let jobs: JobsRepo
let lib: LibraryRepo

beforeEach(() => {
  const db = openDb(':memory:')
  jobs = new JobsRepo(db)
  lib = new LibraryRepo(db)
})

describe('makeOrchestratorAgent', () => {
  it('throws a descriptive error BEFORE the agent runs when orchestratorJobId does not reference an existing jobs row (was: silently dispatched zero rows behind a truthful-looking summary)', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('model must never be called — validation must happen before agent.generate()')
      },
    })

    const runPass = makeOrchestratorAgent({
      model, lib, tmdb: fakeTmdb, jobs, now: () => 1000, orchestratorJobId: 999999, stepCap: 10,
    })

    await expect(runPass()).rejects.toThrow(/orchestratorJobId=999999 does not reference an existing jobs row/)
    // Confirm the failure is loud, not a silent no-op: nothing was dispatched.
    expect(jobs.countByState('wanted')).toBe(0)
  })

  it('reads the living-doc and dispatches worker_task rows with the right payload/parent_job_id', async () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/x/e1.mkv', subStatus: 'missing',
    })
    lib.upsertMovie({ id: 'm1', name: 'Movie', path: '/x/m1.mkv', subStatus: 'missing' })

    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return toolCallResult('c1', 'list_missing_coverage', {})
        if (call === 2) {
          return toolCallResult('c2', 'dispatch_find_subtitle_task', {
            seriesId: 's1', season: 1, movieId: null, reason: 'missing season 1',
          })
        }
        if (call === 3) {
          return toolCallResult('c3', 'dispatch_find_subtitle_task', {
            seriesId: null, season: null, movieId: 'm1', reason: 'missing movie',
          })
        }
        return finalTextResult({
          dispatchedFindSubtitle: 2, dispatchedRealign: 0, spawnedSiblings: 0,
          summary: 'dispatched 2 find-subtitle tasks',
        })
      },
    })

    const runPass = makeOrchestratorAgent({
      model, lib, tmdb: fakeTmdb, jobs, now: () => 1000, orchestratorJobId: null, stepCap: 10,
    })

    const decision = await runPass()

    expect(decision).toEqual({
      dispatchedFindSubtitle: 2, dispatchedRealign: 0, spawnedSiblings: 0,
      summary: 'dispatched 2 find-subtitle tasks',
    })

    const dispatched = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(dispatched).toHaveLength(2)

    const seriesTask = dispatched.find(j => j.series_id === 's1')!
    expect(seriesTask.season).toBe(1)
    expect(seriesTask.movie_id).toBeNull()
    expect(JSON.parse(seriesTask.payload!)).toEqual({ taskType: 'find_subtitle', reason: 'missing season 1' })
    expect(seriesTask.parent_job_id).toBeNull()

    const movieTask = dispatched.find(j => j.movie_id === 'm1')!
    expect(JSON.parse(movieTask.payload!)).toEqual({ taskType: 'find_subtitle', reason: 'missing movie' })
    expect(movieTask.parent_job_id).toBeNull()
  })

  it('enforces the hard 100-dispatch cap (seeded low for the test) — a 3rd dispatch attempt is refused and only 2 worker_task rows land', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'dispatch_find_subtitle_task', {
            seriesId: 's1', season: 1, movieId: null, reason: 'r1',
          })
        }
        if (call === 2) {
          return toolCallResult('c2', 'dispatch_find_subtitle_task', {
            seriesId: 's2', season: 1, movieId: null, reason: 'r2',
          })
        }
        if (call === 3) {
          return toolCallResult('c3', 'dispatch_find_subtitle_task', {
            seriesId: 's3', season: 1, movieId: null, reason: 'r3',
          })
        }
        // Step 4: the model has just seen c3's tool-result — assert it really is the
        // cap-reached {error} object before scripting the final summary response.
        const c3Result = findToolResultValueById(options.prompt, 'c3')
        expect(c3Result).toEqual({
          error:
            "dispatch cap (2) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly",
        })
        return finalTextResult({
          dispatchedFindSubtitle: 2, dispatchedRealign: 0, spawnedSiblings: 0,
          summary: 'cap reached after 2 dispatches, handed off the rest',
        })
      },
    })

    const runPass = makeOrchestratorAgent({
      model, lib, tmdb: fakeTmdb, jobs, now: () => 1000, orchestratorJobId: null, stepCap: 10,
      maxDispatchesPerOrchestrator: 2,
    })

    await runPass()

    // Exactly 2 rows landed — the 3rd (s3) was refused by the cap, not silently written anyway.
    expect(jobs.countByState('wanted')).toBe(2)
    const dispatched = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(dispatched.map(j => j.series_id).sort()).toEqual(['s1', 's2'])
  })

  it('spawn_sibling_orchestrator does not count against the dispatch cap and records parent_job_id lineage', async () => {
    // orchestratorJobId must be a REAL existing jobs.id — parent_job_id carries a genuine
    // FOREIGN KEY REFERENCES jobs(id) constraint (confirmed in src/v2/db.ts, foreign_keys=ON),
    // so a fabricated id would make every upsertWorkerTask call throw inside execute(). Seed a
    // real worker_task row and claim it, mirroring how phase ⑦'s claim loop would pass its own
    // job.id in when this run IS a claimed sibling orchestrator.
    jobs.upsertWorkerTask({ seriesId: 'orchestrator-shard-root-0', season: null, movieId: null }, { taskType: 'orchestrate' }, null, 1000)
    const parentJob = jobs.claimNext(1000)!

    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'dispatch_find_subtitle_task', {
            seriesId: 's1', season: 1, movieId: null, reason: 'r1',
          })
        }
        if (call === 2) {
          return toolCallResult('c2', 'dispatch_find_subtitle_task', {
            seriesId: 's2', season: 1, movieId: null, reason: 'r2',
          })
        }
        if (call === 3) {
          return toolCallResult('c3', 'spawn_sibling_orchestrator', {
            shardIndex: 0, remainingWorkSummary: 'series s3..s10 still need dispatch',
          })
        }
        return finalTextResult({
          dispatchedFindSubtitle: 2, dispatchedRealign: 0, spawnedSiblings: 1,
          summary: 'cap reached, spawned a sibling orchestrator for the remainder',
        })
      },
    })

    const runPass = makeOrchestratorAgent({
      model, lib, tmdb: fakeTmdb, jobs, now: () => 1000, orchestratorJobId: parentJob.id, stepCap: 10,
      maxDispatchesPerOrchestrator: 2,
    })

    await runPass()

    // parentJob itself is 'searching' (claimed above), so 'wanted' holds only the 2 dispatched
    // find_subtitle tasks + the 1 spawned sibling orchestrator row = 3.
    expect(jobs.countByState('wanted')).toBe(3)
    const expectedShardId = `orchestrator-shard-${parentJob.id}-0`
    const sibling = jobs.listByState('wanted').find(j => j.series_id === expectedShardId)!
    expect(sibling).toBeDefined()
    expect(sibling.parent_job_id).toBe(parentJob.id)
    expect(JSON.parse(sibling.payload!)).toEqual({
      taskType: 'orchestrate', remainingWorkSummary: 'series s3..s10 still need dispatch',
    })
  })
})
