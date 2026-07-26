import { tool } from 'ai'
import { z } from 'zod'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { makeTmdbEvidenceTools } from './tmdbTools.js'

export interface RescueWorkerToolsDeps {
  tmdb: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'>
  taskDirs: Set<string>
}

const RECORDED_NOTE =
  'decision recorded — include it in your finalize report; nothing is applied until finalize'

export function makeRescueWorkerTools(deps: RescueWorkerToolsDeps) {
  return {
    // 共享身份证据工具（tmdbTools.ts）——search_tmdb/get_tmdb_details 与 findSubtitleWorker
    // 的 Step 0 识别验证共用同一实现，行为漂移零容忍。
    ...makeTmdbEvidenceTools(deps),

    claim_directory: tool({
      description:
        'Record a decision to claim a directory as a known TMDB entry. Validates the ' +
        'directory and tmdbId, then records the decision in your trace. The decision only ' +
        'takes effect when you include it in your final finalize report.',
      inputSchema: z.object({
        dir: z.string(),
        tmdbId: z.string().regex(/^\d+$/),
        isTv: z.boolean(),
        season: z.number().int().positive().nullable().optional(),
      }),
      execute: async ({ dir, tmdbId, isTv, season }) => {
        if (!deps.taskDirs.has(dir)) {
          return { error: `unknown directory: ${dir}` }
        }
        // Note: tmdbId regex is already enforced by inputSchema; this assertion keeps the
        // contract explicit for readers.
        if (!/^\d+$/.test(tmdbId)) {
          return { error: `tmdbId must be a numeric string: ${tmdbId}` }
        }
        return { recorded: true, decision: { dir, tmdbId, isTv, season }, note: RECORDED_NOTE }
      },
    }),

    exclude_extras: tool({
      description:
        'Record a decision that a directory contains non-episode extras (bonus material) ' +
        'and should be excluded. The decision only takes effect when you include it in your ' +
        'final finalize report.',
      inputSchema: z.object({
        dir: z.string(),
      }),
      execute: async ({ dir }) => {
        if (!deps.taskDirs.has(dir)) {
          return { error: `unknown directory: ${dir}` }
        }
        return { recorded: true, decision: { dir, outcome: 'excluded' }, note: RECORDED_NOTE }
      },
    }),

    keep_parked: tool({
      description:
        'Record a decision to keep a directory parked because you are not confident enough ' +
        'to claim it. Provide a human-readable reason. The decision only takes effect when ' +
        'you include it in your final finalize report.',
      inputSchema: z.object({
        dir: z.string(),
        reason: z.string().min(1),
      }),
      execute: async ({ dir, reason }) => {
        if (!deps.taskDirs.has(dir)) {
          return { error: `unknown directory: ${dir}` }
        }
        return { recorded: true, decision: { dir, outcome: 'parked', reason }, note: RECORDED_NOTE }
      },
    }),
  }
}
