import { tool } from 'ai'
import { z } from 'zod'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

export interface RescueWorkerToolsDeps {
  tmdb: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'>
  taskDirs: Set<string>
}

const RECORDED_NOTE =
  'decision recorded — include it in your finalize report; nothing is applied until finalize'

export function makeRescueWorkerTools(deps: RescueWorkerToolsDeps) {
  return {
    search_tmdb: tool({
      description:
        'Search TMDB for a tv or movie title. Returns a list of hits with id, title, ' +
        'originalTitle and year. Use this to gather name evidence.',
      inputSchema: z.object({
        query: z.string().min(1),
        mediaType: z.enum(['tv', 'movie']),
        year: z.number().int().positive().optional(),
      }),
      execute: async ({ query, mediaType, year }) => {
        const hits = await deps.tmdb.search(mediaType, query, year)
        return {
          hits: hits.map((h) => ({
            id: String(h.id),
            title: h.title,
            originalTitle: h.originalTitle,
            year: h.year,
          })),
        }
      },
    }),

    get_tmdb_details: tool({
      description:
        'Fetch full TMDB details for a numeric tmdbId. For TV entries, also returns the ' +
        'season table (episode count per season). Use this to verify structure and year evidence.',
      inputSchema: z.object({
        tmdbId: z.string().regex(/^\d+$/),
        isTv: z.boolean(),
      }),
      execute: async ({ tmdbId, isTv }) => {
        const mediaType = isTv ? 'tv' : 'movie'
        const [details, seasons] = await Promise.all([
          deps.tmdb.getDetails(mediaType, tmdbId),
          isTv ? deps.tmdb.getSeasonTable(tmdbId) : Promise.resolve(null),
        ])
        return { details, seasons }
      },
    }),

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
