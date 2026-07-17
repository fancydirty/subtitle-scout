import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { makeRescueWorker } from './rescueWorker.js'
import type { RescueTask, RescueReport } from '../v2/rescueWorkerTask.js'
import type { SeasonTableEntry, TmdbDetails, TmdbSearchHit } from '../adapters/providers/tmdb.js'

function baseTask(overrides: Partial<RescueTask> = {}): RescueTask {
  return {
    jobId: 'job-1',
    groups: [
      {
        dir: '/media/Claimed',
        reason: 'no tmdb match',
        files: [{ path: '/media/Claimed/a.mkv', durationSec: 100 }],
      },
      {
        dir: '/media/Parked',
        reason: 'ambiguous',
        files: [{ path: '/media/Parked/b.mkv', durationSec: null }],
      },
    ],
    ...overrides,
  }
}

function fakeTmdb() {
  return {
    search: async (_mediaType: 'tv' | 'movie', _query: string, _year?: number): Promise<TmdbSearchHit[]> => [],
    getDetails: async (_mediaType: 'tv' | 'movie', _id: string): Promise<TmdbDetails | null> => null,
    getSeasonTable: async (_id: string): Promise<SeasonTableEntry[] | null> => null,
  }
}

function multiToolCallResult(
  calls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: calls.map((c) => ({
      type: 'tool-call' as const,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      input: JSON.stringify(c.input),
    })),
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
    content: [{
      type: 'tool-call' as const,
      toolCallId: 'finalize-1',
      toolName: 'finalize',
      input: JSON.stringify(output),
    }],
    warnings: [],
  }
}

describe('makeRescueWorker (end-to-end, mock model)', () => {
  it('records decisions and returns a finalize report with one outcome per directory', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async (_options: LanguageModelV4CallOptions) => {
        call++
        if (call === 1) {
          return multiToolCallResult([
            { toolCallId: 'c1', toolName: 'claim_directory', input: { dir: '/media/Claimed', tmdbId: '123', isTv: true, season: 1 } },
            { toolCallId: 'c2', toolName: 'keep_parked', input: { dir: '/media/Parked', reason: 'ambiguous candidates' } },
          ])
        }
        return finalizeResult({
          outcomes: [
            { dir: '/media/Claimed', outcome: 'claimed', tmdbId: '123', isTv: true, season: 1 },
            { dir: '/media/Parked', outcome: 'parked', reason: 'ambiguous candidates' },
          ],
        })
      },
    })

    const runTask = makeRescueWorker({ model, tmdb: fakeTmdb() })
    const report = await runTask(baseTask())

    expect(report.outcomes).toHaveLength(2)
    expect(report.outcomes[0]).toEqual({ dir: '/media/Claimed', outcome: 'claimed', tmdbId: '123', isTv: true, season: 1 })
    expect(report.outcomes[1]).toEqual({ dir: '/media/Parked', outcome: 'parked', reason: 'ambiguous candidates' })
  })
})
