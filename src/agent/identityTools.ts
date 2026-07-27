import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbDetails } from '../adapters/providers/tmdb.js'
import { seriesId, episodeId } from '../v2/ownIds.js'
import { coercibleNullableInt } from './coerce.js'

// 注意：embeddedLangs 刻意**不是**输入参数——agent 可能幻觉出 ['chi'] 把条目永久打成
// 'embedded'（terminal covered 态，字幕搜索从此沉默）。权威源是 parked_paths.embedded_langs
// （摄取层 ffprobe raw 数据），由 execute 内部读取。
/** 🔴 identityEval 六轮血案的真根因（2026-07-27）：这个 schema 原本用
 *  `z.number().int().nullable()` 收 season/episode——只接受 JSON null 和真数字。真模型的
 *  实际发法有六种，五种被拒（省略键 / "None"（Python 风格）/ "null" / "" / 字符串数字），
 *  于是 agent **想调写库工具却调不进去**：它试了、被 schema 拒了、把失败写进 finalize 的
 *  reason（实测原话："write_identified_media could not be called because the season/episode
 *  null parameters fail serialization (Python None becomes ...)"）。
 *
 *  我连续六轮把这个现象误判为"agent 不听话"，往 skill 里加了三轮措辞（"不是可选记账"/
 *  "是 FAILED run"/"没字幕也必须写库"），全打在空处——工具的门本来就是关着的。
 *
 *  本仓早有现成解法：coerce.ts 的 coercibleNullableInt 就是为"模型把数字发成字符串/发
 *  None/省略键"写的（见该常量的头注释）。新工具写 schema 时必须复用它，不要重新发明一个
 *  更窄的门。 */
const WriteIdentityInputSchema = z.object({
  tmdbId: z.string().regex(/^\d+$/),
  isTv: z.boolean(),
  title: z.string().min(1),
  season: coercibleNullableInt,
  episode: coercibleNullableInt,
  path: z.string().min(1),
})

interface WriteIdentityDeps {
  lib: LibraryRepo
  tmdb: {
    getDetails: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<TmdbDetails | null>
    getChineseTitles: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string[]>
    getExternalIds: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<{ imdbId: string | null } | null>
    getOriginLanguage: (mediaType: 'tv' | 'movie', tmdbId: string) => Promise<string | null>
  }
}

export function makeWriteIdentityTool(deps: WriteIdentityDeps) {
  return tool({
    description: 'Write the identified media to the database. Call this immediately after you have verified the identity through TMDB evidence (search + details with two-evidence bar). Embedded subtitle languages are read from the parked row (ffprobe data), not from your input. Returns the own-id you must use for subsequent subtitle installation.',
    inputSchema: WriteIdentityInputSchema,
    execute: async (input) => {
      const { tmdbId, isTv, title, season, episode, path } = input
      const { lib, tmdb } = deps

      const mediaType = isTv ? 'tv' : 'movie'

      // TV validation FIRST——在任何网络调用之前（TMDB 配额敏感，别为必败的请求烧一次 getDetails）
      if (isTv && (season === null || episode === null)) {
        throw new Error('TV identification requires season and episode')
      }

      // embeddedLangs 权威源：parked 行的 embedded_langs 列（ffprobe raw 数据的 JSON 数组串）。
      // parked 行不存在 / 列为 NULL（未探测）→ subStatus='missing'，宁可漏判 embedded 也
      // 不可信 agent 自报（幻觉会把条目锁死在 covered 态）。
      const parked = lib.listParkedPaths().find(p => p.path === path)
      let embeddedLangs: string[] | null = null
      if (parked?.embedded_langs) {
        try {
          embeddedLangs = JSON.parse(parked.embedded_langs) as string[]
        } catch {
          embeddedLangs = null // 坏 JSON 按未探测处理，不阻塞识别落地
        }
      }

      // 🔴 幻觉防线：tmdbId 必须在 TMDB 上真实存在
      let details: TmdbDetails | null = null
      try {
        details = await tmdb.getDetails(mediaType, tmdbId)
      } catch (err) {
        throw new Error(`TMDB getDetails failed for ${mediaType}:${tmdbId}`, { cause: err })
      }

      if (details === null) {
        throw new Error(`TMDB ${mediaType}:${tmdbId} does not exist (404) - refusing to create ghost row from hallucinated id`)
      }
      const meta = details // const 别名——narrowing 才能带进下面的事务闭包

      // Enrich from TMDB (non-fatal if these fail)
      let imdbId: string | null = null
      let chineseTitle: string | null = null
      let originLang: string | null = null

      try {
        const extIds = await tmdb.getExternalIds(mediaType, tmdbId)
        imdbId = extIds?.imdbId ?? null
      } catch (err) {
        // Non-fatal
      }

      try {
        const chineseTitles = await tmdb.getChineseTitles(mediaType, tmdbId)
        chineseTitle = chineseTitles?.[0] ?? null
      } catch (err) {
        // Non-fatal
      }

      try {
        originLang = await tmdb.getOriginLanguage(mediaType, tmdbId)
      } catch (err) {
        // Non-fatal
      }

      const providerIds = JSON.stringify({ tmdb: tmdbId, imdb: imdbId })
      const subStatus = embeddedLangs && embeddedLangs.length > 0 ? 'embedded' : 'missing'

      if (isTv) {
        const ownSeriesId = seriesId(tmdbId)
        const ownEpisodeId = episodeId(tmdbId, season!, episode!)

        // 多语句写入包在一个事务里：parked 清除与建行同生共死，不留"建了一半"的中间态
        lib.db.transaction(() => {
          // Upsert series
          lib.upsertSeries({
            id: ownSeriesId,
            name: title,
            chineseTitle,
            posterPath: meta.posterPath,
            overview: meta.overview,
            backdropPath: meta.backdropPath,
            year: meta.year,
            providerIds,
            genres: meta.genreIds,
          })

          // Set origin language if we got it
          if (originLang) {
            lib.setSeriesOriginLang(ownSeriesId, originLang)
          }

          // Upsert episode
          lib.upsertEpisode({
            id: ownEpisodeId,
            seriesId: ownSeriesId,
            season: season!,
            episode: episode!,
            name: title,
            path,
            subStatus,
          })

          // Set probe memo if we have embedded langs
          if (embeddedLangs && embeddedLangs.length > 0) {
            if (parked?.probe_mtime && parked?.probe_size) {
              lib.setProbeMemo(ownEpisodeId, parked.probe_mtime, parked.probe_size, embeddedLangs)
            }
          }

          // Clear from parked
          lib.clearParkedPath(path)
        })()

        return `Created series ${ownSeriesId} and episode ${ownEpisodeId}. Use "${ownEpisodeId}" as the itemId for subtitle operations.`
      } else {
        const ownMovieId = seriesId(tmdbId) // movies 复用 seriesId 构造器

        lib.db.transaction(() => {
          lib.upsertMovie({
            id: ownMovieId,
            name: title,
            path,
            subStatus,
            chineseTitle,
            posterPath: meta.posterPath,
            year: meta.year,
            providerIds,
          })

          if (originLang) {
            lib.setMovieOriginLang(ownMovieId, originLang)
          }

          if (embeddedLangs && embeddedLangs.length > 0) {
            if (parked?.probe_mtime && parked?.probe_size) {
              lib.setProbeMemo(ownMovieId, parked.probe_mtime, parked.probe_size, embeddedLangs)
            }
          }

          lib.clearParkedPath(path)
        })()

        return `Created movie ${ownMovieId}. Use "${ownMovieId}" as the itemId for subtitle operations.`
      }
    },
  })
}
