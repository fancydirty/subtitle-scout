import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { openDb } from '../v2/db.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { makeOrchestratorAgent } from './orchestratorAgent.js'
import { seedBacklog, makeBacklogFakes, type BacklogShape } from '../testing/seedBacklog.js'

// Copied from orchestratorAgent.test.ts:11-37 — the scripted-model helpers this suite reuses.
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

/** Reads a prior tool call's JSON result out of a scripted step's own prompt history, keyed by
 *  toolCallId. Copied from orchestratorAgent.test.ts:43-50 — same helper, same reason (this suite
 *  also scripts multiple calls to the SAME tool with different toolCallIds). */
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

/** A stable sort key for a worker_task identity triple, used only to compare two SETs of
 *  identities without caring about dispatch order. */
function identityKey(x: { seriesId: string | null; season: number | null; movieId: string | null }): string {
  return JSON.stringify([x.seriesId ?? '', x.season ?? -1, x.movieId ?? ''])
}
function sortedIdentities(xs: { seriesId: string | null; season: number | null; movieId: string | null }[]) {
  return [...xs].sort((a, b) => identityKey(a).localeCompare(identityKey(b)))
}

// Two normal series (one season each, no realign candidate) + one missing movie — a deterministic
// backlog whose only correct dispatch outcome is 3 find_subtitle tasks and ZERO realign tasks.
const shape: BacklogShape = {
  name: 'plumbing-mixed',
  represents: 'two normal series each missing one season + a missing movie — deterministic dispatch plumbing check',
  series: [
    { id: 'tmdb:10', seasons: [{ season: 1, episodes: 12, missing: 4, tmdbEpisodeCount: 12 }] },
    { id: 'tmdb:20', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
  ],
  movies: [{ id: 'm1', missing: true }],
  expected: {
    findSubtitle: [
      // R-11（范围裁量化）：find_subtitle 行的 season 身份列恒 NULL——范围事实在 payload.seasons。
      { seriesId: 'tmdb:10', season: null, movieId: null },
      { seriesId: 'tmdb:20', season: null, movieId: null },
      { seriesId: null, season: null, movieId: 'm1' },
    ],
    realignSeriesIds: [],
  },
}

describe('orchestrator dispatch plumbing over a seeded backlog', () => {
  it('dispatches exactly the 3 find_subtitle identities with ZERO realign rows, and a re-dispatch ' +
     'of an already-wanted identity does not create a duplicate row', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    seedBacklog(lib, shape)
    const { tmdb } = makeBacklogFakes(shape)

    let call = 0
    const model1 = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'dispatch_find_subtitle_task', {
            seriesId: 'tmdb:10', seasons: [1], movieId: null, reason: 'missing season 1 for a',
          })
        }
        if (call === 2) {
          return toolCallResult('c2', 'dispatch_find_subtitle_task', {
            seriesId: 'tmdb:20', seasons: [1], movieId: null, reason: 'missing season 1 for b',
          })
        }
        if (call === 3) {
          return toolCallResult('c3', 'dispatch_find_subtitle_task', {
            seriesId: null, movieId: 'm1', reason: 'missing movie m1',
          })
        }
        return finalizeResult({
          dispatchedFindSubtitle: 3, dispatchedRealign: 0, spawnedSiblings: 0,
          summary: 'dispatched 3 find-subtitle tasks',
        })
      },
    })

    const runPass1 = makeOrchestratorAgent({
      model: model1, lib, tmdb, jobs, now: () => 1000, orchestratorJobId: null, stepCap: 20,
    })
    const decision1 = await runPass1()

    expect(decision1).toEqual({
      dispatchedFindSubtitle: 3, dispatchedRealign: 0, spawnedSiblings: 0,
      summary: 'dispatched 3 find-subtitle tasks',
    })

    expect(jobs.countByState('wanted')).toBe(3)
    const dispatched = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(dispatched).toHaveLength(3)

    // Identity check against the real row shape (series_id/season/movie_id), order-independent.
    const actualIdentities = dispatched.map(j => ({ seriesId: j.series_id, season: j.season, movieId: j.movie_id }))
    expect(sortedIdentities(actualIdentities)).toEqual(sortedIdentities(shape.expected.findSubtitle))

    // Zero-false-trigger pole star: no realign task landed for either series.
    const realignRows = dispatched.filter(j => (JSON.parse(j.payload!) as { taskType: string }).taskType === 'realign')
    expect(realignRows).toHaveLength(0)

    // Second pass: re-dispatch one of the SAME identities (series 'a' season 1). It must upsert
    // onto the existing 'wanted' row (dedup via kind+identity), not create a 4th row.
    let call2 = 0
    const model2 = new MockLanguageModelV4({
      doGenerate: async () => {
        call2++
        if (call2 === 1) {
          return toolCallResult('c1', 'dispatch_find_subtitle_task', {
            seriesId: 'tmdb:10', seasons: [1], movieId: null, reason: 're-dispatch same identity',
          })
        }
        return finalizeResult({
          dispatchedFindSubtitle: 1, dispatchedRealign: 0, spawnedSiblings: 0,
          summary: 're-dispatched a/season-1',
        })
      },
    })

    const runPass2 = makeOrchestratorAgent({
      model: model2, lib, tmdb, jobs, now: () => 2000, orchestratorJobId: null, stepCap: 20,
    })
    await runPass2()

    expect(jobs.countByState('wanted')).toBe(3)
    const dispatchedAfter = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(dispatchedAfter).toHaveLength(3)
    expect(sortedIdentities(dispatchedAfter.map(j => ({ seriesId: j.series_id, season: j.season, movieId: j.movie_id }))))
      .toEqual(sortedIdentities(shape.expected.findSubtitle))
  })
})

// One series with 3 independent fully-missing seasons, none a realign candidate (mirror ==
// tmdbEpisodeCount for every season) — a deterministic stand-in for the real-model matrix's
// `over-cap-spillover` shape (src/testing/orchestratorBacklog.ts), used here only to prove the
// TOOL-LEVEL cap deterministically and cheaply against a scripted model, driven through the same
// seedBacklog/BacklogShape harness as the test above.
const capShape: BacklogShape = {
  name: 'plumbing-cap',
  // R-11（范围裁量化）后同一 series 的多个季共享一个 find_subtitle 身份行——原"一部剧三季=三次
  // 派发"的 cap 前提失效（后两次会 coalesce 进第一行）。改为三部各缺一季的剧：三个独立身份，
  // cap 语义原样可测。
  represents: 'three series each with one fully-missing season — used only to exercise the ' +
    'dispatch cap at a low, cheap-to-test override',
  capOverride: 2,
  series: [
    { id: 'tmdb:30', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
    { id: 'tmdb:31', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
    { id: 'tmdb:32', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
  ],
  movies: [],
  expected: { findSubtitle: [], realignSeriesIds: [] },
}

describe('orchestrator dispatch cap (tool-level), driven through the backlog-shape harness', () => {
  it('enforces maxDispatchesPerOrchestrator=2 over a seeded backlog with 3 dispatchable series: ' +
     'only 2 worker_task rows land, and the 3rd dispatch_find_subtitle_task call gets the ' +
     'cap-reached error back rather than a 3rd row', async () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const lib = new LibraryRepo(db)
    seedBacklog(lib, capShape)
    const { tmdb } = makeBacklogFakes(capShape)

    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'dispatch_find_subtitle_task', {
            seriesId: 'tmdb:30', seasons: [1], movieId: null, reason: 'missing season 1',
          })
        }
        if (call === 2) {
          return toolCallResult('c2', 'dispatch_find_subtitle_task', {
            seriesId: 'tmdb:31', seasons: [1], movieId: null, reason: 'missing season 1 of tmdb:31',
          })
        }
        if (call === 3) {
          return toolCallResult('c3', 'dispatch_find_subtitle_task', {
            seriesId: 'tmdb:32', seasons: [1], movieId: null, reason: 'missing season 1 of tmdb:32',
          })
        }
        // Step 4: the model has just seen c3's tool-result — assert it really is the
        // cap-reached {error} object (not a silently-written 3rd row) before scripting the final
        // summary response.
        const c3Result = findToolResultValueById(options.prompt, 'c3')
        expect(c3Result).toEqual({
          error:
            'dispatch cap (2) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly',
        })
        return finalizeResult({
          dispatchedFindSubtitle: 2, dispatchedRealign: 0, spawnedSiblings: 1,
          summary: 'cap reached after 2 dispatches, handed off the third series to a sibling',
        })
      },
    })

    const runPass = makeOrchestratorAgent({
      model, lib, tmdb, jobs, now: () => 1000, orchestratorJobId: null, stepCap: 20,
      maxDispatchesPerOrchestrator: 2,
    })
    await runPass()

    // Exactly 2 rows landed — the 3rd (tmdb:32) was refused by the cap, not silently written anyway.
    // R-11: find_subtitle 行的 season 身份列恒 NULL，请求的季在 payload.seasons 里核对。
    expect(jobs.countByState('wanted')).toBe(2)
    const dispatched = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(dispatched.map(j => j.series_id).sort()).toEqual(['tmdb:30', 'tmdb:31'])
    expect(dispatched.every(j => j.season === null)).toBe(true)
    expect(dispatched.map(j => (JSON.parse(j.payload!) as { seasons: number[] }).seasons)).toEqual([[1], [1]])
  })
})
