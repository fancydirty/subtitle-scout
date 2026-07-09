import type { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, JobState, JobIdent } from './jobsRepo.js'

export interface AggregateResult {
  created: number
  retired: number
}

/**
 * Aggregator: bridges missing coverage (library) to jobs.
 *
 * Creates/updates wanted jobs for all missing seasons and movies,
 * then retires jobs whose targets are no longer missing (satisfied externally).
 *
 * Idempotent: safe to run repeatedly — upserts are no-ops for existing jobs,
 * and retirement only affects wanted/failed jobs whose coverage disappeared.
 *
 * Revival channels:
 * - done job whose season/movie re-appears missing → upsertWanted resets to wanted (I2, in JobsRepo).
 * - dormant job whose targets' recheck window expired (or new episodes arrived) → wake with
 *   priority 0 (I3). attempt is preserved: one failure re-dormants for another 30-day window —
 *   "one bullet per recheck window" semantics.
 */
export function aggregate(lib: LibraryRepo, jobs: JobsRepo, now: number): AggregateResult {
  let created = 0
  let retired = 0

  // Build sets of current missing identities for fast lookup during cleanup
  const missingSeasonsSet = new Set<string>()
  const missingMoviesSet = new Set<string>()

  // Create/update jobs for all missing seasons
  const missingSeasons = lib.missingBySeason(now)
  for (const { series_id, season } of missingSeasons) {
    const key = `${series_id}:${season}`
    missingSeasonsSet.add(key)

    const ident: JobIdent = { kind: 'series_season', seriesId: series_id, season }
    const existing = jobs.find(series_id, season)
    if (!existing) {
      jobs.upsertWanted(ident, now)
      created++
    } else if (existing.state === 'dormant') {
      // I3: recheck window expired (or new missing episodes) — give the dormant job one shot.
      jobs.wake(ident, 0, now)
    } else {
      // Touch updated_at; also revives done → wanted (I2)
      jobs.upsertWanted(ident, now)
    }
  }

  // Create/update jobs for all missing movies
  const missingMovies = lib.missingMovies(now)
  for (const movie of missingMovies) {
    missingMoviesSet.add(movie.id)

    const ident: JobIdent = { kind: 'movie', movieId: movie.id }
    const existing = jobs.findMovie(movie.id)
    if (!existing) {
      jobs.upsertWanted(ident, now)
      created++
    } else if (existing.state === 'dormant') {
      jobs.wake(ident, 0, now)
    } else {
      jobs.upsertWanted(ident, now)
    }
  }

  // Cleanup: retire wanted/failed jobs whose targets are no longer missing
  // (satisfied externally, e.g., user manually placed subtitles)
  const retirableStates: JobState[] = ['wanted', 'failed']

  for (const state of retirableStates) {
    for (const job of jobs.listByState(state)) {
      let shouldRetire = false

      if (job.kind === 'series_season' && job.series_id && job.season !== null) {
        const key = `${job.series_id}:${job.season}`
        shouldRetire = !missingSeasonsSet.has(key)
      } else if (job.kind === 'movie' && job.movie_id) {
        shouldRetire = !missingMoviesSet.has(job.movie_id)
      }

      if (shouldRetire) {
        const didRetire = jobs.retire(job.id, now)
        if (didRetire) {
          retired++
        }
      }
    }
  }

  return { created, retired }
}
