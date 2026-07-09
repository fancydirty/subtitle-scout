import type { ScoutDb } from './db.js'

// 双轨速率差是有意的：网络类错误快重试到好（阶梯 30s→5min，封顶 15min 防撞墙），
// 内容类失败按天退避（字幕产出以天为单位）。
export const CONTENT_BACKOFF_DAYS = [1, 2, 4, 8]
export const ERROR_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]
export const errorBackoffMs = (attempt: number) => ERROR_BACKOFF_MS[attempt - 1] ?? 900_000
/** Partial-success throttle (I6): back to wanted but not immediately claimable — avoids tight re-claim loop. */
export const PARTIAL_RETRY_MS = 30_000

const LEASE_DURATION_MS = 30 * 60_000 // 30 minutes

// Active (non-rest) states — every complete* transition must originate here.
const ACTIVE_STATES_SQL = `('searching', 'downloading', 'verifying')`

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

  // I2: done job 的目标重新出现 missing（新集入库/字幕被删）时复活回 wanted；
  //     failed/dormant/active 不动（各有自己的退避/唤醒通道）。
  private static readonly UPSERT_CONFLICT_SQL = `
           ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
           DO UPDATE SET
             updated_at = ?,
             state = CASE WHEN state = 'done' THEN 'wanted' ELSE state END,
             attempt = CASE WHEN state = 'done' THEN 0 ELSE attempt END,
             next_retry_at = CASE WHEN state = 'done' THEN NULL ELSE next_retry_at END`

  upsertWanted(ident: JobIdent, now: number): void {
    if (ident.kind === 'series_season') {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
           VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.seriesId, ident.season, now, now, now)
    } else {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, movie_id, state, priority, attempt, created_at, updated_at)
           VALUES ('movie', ?, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.movieId, now, now, now)
    }
  }

  claimNext(now: number): Job | null {
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
    // Active state with NULL lease is anomalous (should never happen) — reap it too.
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', attempt = attempt + 1, lease_until = NULL, updated_at = ?
         WHERE state IN ${ACTIVE_STATES_SQL}
         AND (lease_until < ? OR lease_until IS NULL)`
      )
      .run(now, now)
  }

  /** 启动即回收：无条件把所有活跃态 job 归位 wanted，**不看租约是否过期**。
   *  单实例前提——daemon 启动时旧进程必已死，任何还挂在 searching/downloading/verifying
   *  的租约都是上个进程留下的遗孤（重启瞬间在跑的 job 租约仍未过期，最长可占 searching 槽
   *  30 分钟拖停调度）。返回回收行数。 */
  reapAllActive(now: number): number {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', attempt = attempt + 1, lease_until = NULL, updated_at = ?
         WHERE state IN ${ACTIVE_STATES_SQL}`
      )
      .run(now)
    return info.changes
  }

  /** Content failure (no_safe_match): exponential backoff 1/2/4/8 days, then dormant on the 5th failure. */
  completeNoMatch(jobId: number, now: number): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const newAttempt = job.attempt + 1
      if (newAttempt > CONTENT_BACKOFF_DAYS.length) {
        // All backoff tiers exhausted — 5th content failure goes dormant.
        const info = this.db
          .prepare(
            `UPDATE jobs
             SET state = 'dormant', attempt = ?, next_retry_at = NULL, lease_until = NULL, updated_at = ?
             WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
          )
          .run(newAttempt, now, jobId)
        return info.changes > 0
      }
      const backoffDays = CONTENT_BACKOFF_DAYS[newAttempt - 1]
      const nextRetryAt = now + backoffDays * 86_400_000
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'failed', attempt = ?, next_retry_at = ?, lease_until = NULL, updated_at = ?
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newAttempt, nextRetryAt, now, jobId)
      return info.changes > 0
    })()
  }

  /** Transient error (network/LLM/5xx): short backoff, separate track from content failures. */
  completeError(jobId: number, error: string, now: number): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const newAttempt = job.attempt + 1
      const nextRetryAt = now + errorBackoffMs(newAttempt)
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'failed', attempt = ?, next_retry_at = ?, last_error = ?, lease_until = NULL, updated_at = ?
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newAttempt, nextRetryAt, error, now, jobId)
      return info.changes > 0
    })()
  }

  /** Partial success: attempt decrements (gradual escalation recovery), back to wanted for the remainder.
   *  I6: 带 30 秒节流窗（PARTIAL_RETRY_MS），防止 partial → wanted → 立即重领的紧循环。 */
  completePartial(jobId: number, now: number): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const newAttempt = Math.max(0, job.attempt - 1)
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'wanted', attempt = ?, next_retry_at = ?, lease_until = NULL, updated_at = ?
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newAttempt, now + PARTIAL_RETRY_MS, now, jobId)
      return info.changes > 0
    })()
  }

  completeDone(jobId: number, now: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'done', lease_until = NULL, updated_at = ?
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(now, jobId)
    return info.changes > 0
  }

  /** Retire satisfied jobs from wanted/failed → done (aggregator cleanup semantic). */
  retire(jobId: number, now: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'done', updated_at = ?
         WHERE id = ? AND state IN ('wanted', 'failed')`
      )
      .run(now, jobId)
    return info.changes > 0
  }

  /** Priority bump for existing (wanted/failed) jobs — does not change state. */
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

  /** Playback-triggered wake: only revives dormant jobs. For wanted/failed use boostPriority. */
  wake(ident: JobIdent, priority: number, now: number): boolean {
    if (ident.kind === 'series_season') {
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'wanted', priority = ?, next_retry_at = NULL, updated_at = ?
           WHERE kind = 'series_season' AND series_id = ? AND season = ? AND state = 'dormant'`
        )
        .run(priority, now, ident.seriesId, ident.season)
      return info.changes > 0
    }
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', priority = ?, next_retry_at = NULL, updated_at = ?
         WHERE kind = 'movie' AND movie_id = ? AND state = 'dormant'`
      )
      .run(priority, now, ident.movieId)
    return info.changes > 0
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

  findMovie(movieId: string): Job | null {
    const job = this.db
      .prepare(`SELECT * FROM jobs WHERE kind = 'movie' AND movie_id = ?`)
      .get(movieId) as Job | undefined
    return job ?? null
  }

  listByState(state: JobState): Job[] {
    return this.db.prepare(`SELECT * FROM jobs WHERE state = ?`).all(state) as Job[]
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

  // ---- Test helpers (仅供测试) ----

  /** Test helper: claim a specific series job ignoring state/next_retry_at gating. */
  forceClaim(seriesId: string, season: number, now: number): Job | null {
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

  /** Test helper: force a job to an arbitrary state, bypassing transition guards. */
  forceState(seriesId: string, season: number, state: JobState, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET state = ?, updated_at = ?
         WHERE kind = 'series_season' AND series_id = ? AND season = ?`
      )
      .run(state, now, seriesId, season)
  }
}
