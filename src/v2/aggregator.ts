import type { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, JobState } from './jobsRepo.js'

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

    const existing = jobs.find(series_id, season)
    if (!existing) {
      jobs.upsertWanted({ kind: 'series_season', seriesId: series_id, season }, now)
      created++
    } else {
      // Touch updated_at for existing jobs (upsertWanted is idempotent)
      jobs.upsertWanted({ kind: 'series_season', seriesId: series_id, season }, now)
    }
  }

  // Create/update jobs for all missing movies
  const missingMovies = lib.missingMovies(now)
  for (const movie of missingMovies) {
    missingMoviesSet.add(movie.id)

    const existing = findMovieJob(jobs, movie.id)
    if (!existing) {
      jobs.upsertWanted({ kind: 'movie', movieId: movie.id }, now)
      created++
    } else {
      jobs.upsertWanted({ kind: 'movie', movieId: movie.id }, now)
    }
  }

  // Cleanup: retire wanted/failed jobs whose targets are no longer missing
  // (satisfied externally, e.g., user manually placed subtitles)
  const retirabaleStates: JobState[] = ['wanted', 'failed']

  // Get all wanted/failed jobs
  for (const state of retirabaleStates) {
    const jobsToCheck = getAllJobsByState(jobs, state)

    for (const job of jobsToCheck) {
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

/**
 * Helper: find a movie job by movie_id.
 * JobsRepo doesn't expose a findMovie method, so we scan via get after finding by identity.
 */
function findMovieJob(jobs: JobsRepo, movieId: string): { id: number } | null {
  // We need to query the DB to find movie jobs
  // Since JobsRepo doesn't expose a generic query method, we work around this
  // by using the db property (which is readonly but accessible)
  const db = (jobs as any).db
  const job = db
    .prepare(`SELECT id FROM jobs WHERE kind = 'movie' AND movie_id = ?`)
    .get(movieId) as { id: number } | undefined
  return job ?? null
}

/**
 * Helper: get all jobs in a given state.
 */
function getAllJobsByState(jobs: JobsRepo, state: JobState): Array<{
  id: number
  kind: 'series_season' | 'movie'
  series_id: string | null
  season: number | null
  movie_id: string | null
}> {
  const db = (jobs as any).db
  return db
    .prepare(
      `SELECT id, kind, series_id, season, movie_id
       FROM jobs
       WHERE state = ?`
    )
    .all(state) as any[]
}
