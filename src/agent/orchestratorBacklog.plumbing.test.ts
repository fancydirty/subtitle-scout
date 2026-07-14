import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
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
    { id: 'a', tmdbId: '10', seasons: [{ season: 1, episodes: 12, missing: 4, tmdbEpisodeCount: 12 }] },
    { id: 'b', tmdbId: '20', seasons: [{ season: 1, episodes: 10, missing: 10, tmdbEpisodeCount: 10 }] },
  ],
  movies: [{ id: 'm1', missing: true }],
  expected: {
    findSubtitle: [
      { seriesId: 'a', season: 1, movieId: null },
      { seriesId: 'b', season: 1, movieId: null },
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
    const { tmdb, jf } = makeBacklogFakes(shape)

    let call = 0
    const model1 = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'dispatch_find_subtitle_task', {
            seriesId: 'a', season: 1, movieId: null, reason: 'missing season 1 for a',
          })
        }
        if (call === 2) {
          return toolCallResult('c2', 'dispatch_find_subtitle_task', {
            seriesId: 'b', season: 1, movieId: null, reason: 'missing season 1 for b',
          })
        }
        if (call === 3) {
          return toolCallResult('c3', 'dispatch_find_subtitle_task', {
            seriesId: null, season: null, movieId: 'm1', reason: 'missing movie m1',
          })
        }
        return finalizeResult({
          dispatchedFindSubtitle: 3, dispatchedRealign: 0, spawnedSiblings: 0,
          summary: 'dispatched 3 find-subtitle tasks',
        })
      },
    })

    const runPass1 = makeOrchestratorAgent({
      model: model1, lib, tmdb, jf, jobs, now: () => 1000, orchestratorJobId: null, stepCap: 20,
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
            seriesId: 'a', season: 1, movieId: null, reason: 're-dispatch same identity',
          })
        }
        return finalizeResult({
          dispatchedFindSubtitle: 1, dispatchedRealign: 0, spawnedSiblings: 0,
          summary: 're-dispatched a/season-1',
        })
      },
    })

    const runPass2 = makeOrchestratorAgent({
      model: model2, lib, tmdb, jf, jobs, now: () => 2000, orchestratorJobId: null, stepCap: 20,
    })
    await runPass2()

    expect(jobs.countByState('wanted')).toBe(3)
    const dispatchedAfter = jobs.listByState('wanted').filter(j => j.kind === 'worker_task')
    expect(dispatchedAfter).toHaveLength(3)
    expect(sortedIdentities(dispatchedAfter.map(j => ({ seriesId: j.series_id, season: j.season, movieId: j.movie_id }))))
      .toEqual(sortedIdentities(shape.expected.findSubtitle))
  })
})
