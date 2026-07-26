import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbDetails } from '../adapters/providers/tmdb.js'
import { seriesId, episodeId } from '../v2/ownIds.js'

const WriteIdentityInputSchema = z.object({
  tmdbId: z.string().regex(/^\d+$/),
  isTv: z.boolean(),
  title: z.string().min(1),
  season: z.number().int().nullable(),
  episode: z.number().int().nullable(),
  path: z.string().min(1),
  embeddedLangs: z.array(z.string()).nullable(),
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
    description: 'Write the identified media to the database. Call this immediately after you have verified the identity through TMDB evidence (search + details with two-evidence bar). Returns the own-id you must use for subsequent subtitle installation.',
    inputSchema: WriteIdentityInputSchema,
    execute: async (input) => {
      const { tmdbId, isTv, title, season, episode, path, embeddedLangs } = input
      const { lib, tmdb } = deps

      const mediaType = isTv ? 'tv' : 'movie'

      // 🔴 幻觉防线：tmdbId 必须在 TMDB 上真实存在
      let details: TmdbDetails | null = null
      try {
        details = await tmdb.getDetails(mediaType, tmdbId)
      } catch (err) {
        throw new Error(`TMDB getDetails failed for ${mediaType}:${tmdbId}: ${err}`)
      }

      if (details === null) {
        throw new Error(`TMDB ${mediaType}:${tmdbId} does not exist (404) - refusing to create ghost row from hallucinated id`)
      }

      // TV validation
      if (isTv && (season === null || episode === null)) {
        throw new Error('TV identification requires season and episode')
      }

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

        // Upsert series
        lib.upsertSeries({
          id: ownSeriesId,
          name: title,
          chineseTitle,
          posterPath: details.posterPath,
          overview: details.overview,
          backdropPath: details.backdropPath,
          year: details.year,
          providerIds,
          genres: details.genreIds,
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
          const parked = lib.listParkedPaths().find(p => p.path === path)
          if (parked?.probe_mtime && parked?.probe_size) {
            lib.setProbeMemo(ownEpisodeId, parked.probe_mtime, parked.probe_size, embeddedLangs)
          }
        }

        // Clear from parked
        lib.clearParkedPath(path)

        return `Created series ${ownSeriesId} and episode ${ownEpisodeId}. Use "${ownEpisodeId}" as the itemId for subtitle operations.`
      } else {
        const ownMovieId = seriesId(tmdbId) // movies 复用 seriesId 构造器

        lib.upsertMovie({
          id: ownMovieId,
          name: title,
          path,
          subStatus,
          chineseTitle,
          posterPath: details.posterPath,
          year: details.year,
          providerIds,
        })

        if (originLang) {
          lib.setMovieOriginLang(ownMovieId, originLang)
        }

        if (embeddedLangs && embeddedLangs.length > 0) {
          const parked = lib.listParkedPaths().find(p => p.path === path)
          if (parked?.probe_mtime && parked?.probe_size) {
            lib.setProbeMemo(ownMovieId, parked.probe_mtime, parked.probe_size, embeddedLangs)
          }
        }

        lib.clearParkedPath(path)

        return `Created movie ${ownMovieId}. Use "${ownMovieId}" as the itemId for subtitle operations.`
      }
    },
  })
}
