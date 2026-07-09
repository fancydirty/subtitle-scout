import type { ScoutDb } from './db.js'

export const CONTENT_BACKOFF_DAYS = [1, 2, 4, 8]
export const errorBackoffMs = (attempt: number) => Math.min(attempt * 10 * 60_000, 6 * 3600_000)

const LEASE_DURATION_MS = 30 * 60_000 // 30 minutes

export type JobKind = 'series_season' | 'movie'
export type JobState = 'wanted' | 'searching' | 'downloading' | 'verifying' | 'done' | 'failed' | 'dormant'

export interface JobIdentity {
  kind: 'series_season'
  seriesId: string
  season: number
}

export interface MovieJobIdentity {
  kind: 'movie'
  movieId: string
}

export type JobIdent = JobIdentity | MovieJobIdentity

export interface Job {
  id: number
  kind: JobKind
  series_id: string | null
  season: number | null
  movie_id: string | null
  state: JobState
  priority: number
  target_episodes: string | null
  attempt: number
  next_retry_at: number | null
  lease_until: number | null
  last_error: string | null
  journal_ref: string | null
  created_at: number
  updated_at: number
}

export class JobsRepo {
  constructor(private db: ScoutDb) {}

  upsertWanted(ident: JobIdent): void {
    const now = Date.now()
    if (ident.kind === 'series_season') {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
           VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)
           ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
           DO UPDATE SET updated_at = ?`
        )
        .run(ident.seriesId, ident.season, now, now, now)
    } else {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, movie_id, state, priority, attempt, created_at, updated_at)
           VALUES ('movie', ?, 'wanted', 0, 0, ?, ?)
           ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
           DO UPDATE SET updated_at = ?`
        )
        .run(ident.movieId, now, now, now)
    }
  }

  claimNext(now: number, workerId: string): Job | null {
    const leaseUntil = now + LEASE_DURATION_MS
    const job = this.db
      .prepare(
        `UPDATE jobs SET state = 'searching', lease_until = ?, updated_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state IN ('wanted', 'failed')
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(leaseUntil, now, now) as Job | undefined
    return job ?? null
  }

  reapExpiredLeases(now: number): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', attempt = attempt + 1, lease_until = NULL, updated_at = ?
         WHERE state IN ('searching', 'downloading', 'verifying')
         AND lease_until < ?`
      )
      .run(now, now)
  }

  completeNoMatch(jobId: number, now: number): void {
    const job = this.get(jobId)
    if (!job) return

    const newAttempt = job.attempt + 1
    if (newAttempt >= CONTENT_BACKOFF_DAYS.length) {
      // Transition to dormant after exhausting all backoff days
      this.db
        .prepare(
          `UPDATE jobs
           SET state = 'dormant', attempt = ?, next_retry_at = NULL, lease_until = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(newAttempt, now, jobId)
    } else {
      // Apply exponential backoff
      const backoffDays = CONTENT_BACKOFF_DAYS[newAttempt - 1]
      const nextRetryAt = now + backoffDays * 86_400_000
      this.db
        .prepare(
          `UPDATE jobs
           SET state = 'failed', attempt = ?, next_retry_at = ?, lease_until = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(newAttempt, nextRetryAt, now, jobId)
    }
  }

  completeError(jobId: number, error: string, now: number): void {
    const job = this.get(jobId)
    if (!job) return

    const newAttempt = job.attempt + 1
    const nextRetryAt = now + errorBackoffMs(newAttempt)
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'failed', attempt = ?, next_retry_at = ?, last_error = ?, lease_until = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(newAttempt, nextRetryAt, error, now, jobId)
  }

  completePartial(jobId: number, now: number): void {
    const job = this.get(jobId)
    if (!job) return

    const newAttempt = Math.max(0, job.attempt - 1)
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', attempt = ?, next_retry_at = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(newAttempt, now, jobId)
  }

  completeDone(jobId: number, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'done', lease_until = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(now, jobId)
  }

  boostPriority(ident: JobIdent, priority: number): void {
    if (ident.kind === 'series_season') {
      this.db
        .prepare(
          `UPDATE jobs
           SET priority = ?
           WHERE kind = 'series_season' AND series_id = ? AND season = ?`
        )
        .run(priority, ident.seriesId, ident.season)
    } else {
      this.db
        .prepare(
          `UPDATE jobs
           SET priority = ?
           WHERE kind = 'movie' AND movie_id = ?`
        )
        .run(priority, ident.movieId)
    }
  }

  wake(ident: JobIdent, priority: number): void {
    const now = Date.now()
    if (ident.kind === 'series_season') {
      this.db
        .prepare(
          `UPDATE jobs
           SET state = 'wanted', priority = ?, next_retry_at = NULL, updated_at = ?
           WHERE kind = 'series_season' AND series_id = ? AND season = ?`
        )
        .run(priority, now, ident.seriesId, ident.season)
    } else {
      this.db
        .prepare(
          `UPDATE jobs
           SET state = 'wanted', priority = ?, next_retry_at = NULL, updated_at = ?
           WHERE kind = 'movie' AND movie_id = ?`
        )
        .run(priority, now, ident.movieId)
    }
  }

  find(seriesId: string, season: number): Job | null {
    const job = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE kind = 'series_season' AND series_id = ? AND season = ?`
      )
      .get(seriesId, season) as Job | undefined
    return job ?? null
  }

  get(id: number): Job | null {
    const job = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as Job | undefined
    return job ?? null
  }

  countByState(state: JobState): number {
    const result = this.db
      .prepare(`SELECT COUNT(*) as count FROM jobs WHERE state = ?`)
      .get(state) as { count: number }
    return result.count
  }

  // Test helpers

  /**
   * Test helper: Force claim a job ignoring next_retry_at
   */
  forceClaim(seriesId: string, season: number): Job | null {
    const now = Date.now()
    const leaseUntil = now + LEASE_DURATION_MS
    const job = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'searching', lease_until = ?, updated_at = ?
         WHERE kind = 'series_season' AND series_id = ? AND season = ?
         RETURNING *`
      )
      .get(leaseUntil, now, seriesId, season) as Job | undefined
    return job ?? null
  }

  /**
   * Test helper: Force a job to a specific state
   */
  forceState(seriesId: string, season: number, state: JobState): void {
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE jobs
         SET state = ?, updated_at = ?
         WHERE kind = 'series_season' AND series_id = ? AND season = ?`
      )
      .run(state, now, seriesId, season)
  }
}
