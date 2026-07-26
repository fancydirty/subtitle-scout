import { tool } from 'ai'
import { z } from 'zod'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

export interface TmdbEvidenceToolsDeps {
  tmdb: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'>
}

/** 共享 TMDB 身份证据工具（2026-07-26，识别架构路 A）：search_tmdb / get_tmdb_details。
 *  findSubtitleWorker（Step 0 识别验证——核验机械猜测的库身份、猜错了重新识别）和
 *  rescueWorker（parked 目录救援）面对的是同一个"调 TMDB 拿身份证据"的需求，工具行为
 *  必须一致（同样的输入形状、同样的输出归一化），各写一份只会漂移——从
 *  rescueWorker.tools.ts 抽出共享，rescue 侧改为展开复用（行为零变化，其既有测试不动）。
 *
 *  输出刻意去 posterPath 等展示字段（hits 只留 id/title/originalTitle/year）——agent 拿
 *  这些工具是做身份判断（名字/年份/结构佐证），不是展示，字段越少越不容易被无关信息
 *  带偏。 */
export function makeTmdbEvidenceTools(deps: TmdbEvidenceToolsDeps) {
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
  }
}
