import type { ScoutDb } from './db.js'

// 双轨速率差是有意的：网络类错误快重试到好（阶梯 30s→5min，封顶 15min 防撞墙），
// 内容类失败按天退避（字幕产出以天为单位）。
export const CONTENT_BACKOFF_DAYS = [1, 2, 4, 8]
export const ERROR_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]
export const errorBackoffMs = (attempt: number) => ERROR_BACKOFF_MS[attempt - 1] ?? 900_000
/** Partial-success throttle (I6): back to wanted but not immediately claimable — avoids tight re-claim loop. */
export const PARTIAL_RETRY_MS = 30_000
/** OS 配额耗尽 resetAt 之上的固定余量：吸收我们与 provider 之间的时钟偏差，避免恰好卡在
 *  重置边界重领仍扑空。是个保守 margin，不是真随机 jitter。 */
export const QUOTA_RESET_MARGIN_MS = 5 * 60_000

/** resetAt 是否值得据其单独排期：能解析 + 严格晚于 now 才行；否则 null（调用方落回默认阶梯）。
 *  过去时间/乱码字符串一律当作"没有可用的 resetAt"处理——不能让畸形 provider 数据把 job 卡死。 */
function quotaRetryAt(resetAt: string | null | undefined, now: number): number | null {
  if (!resetAt) return null
  const parsed = Date.parse(resetAt)
  if (Number.isNaN(parsed) || parsed <= now) return null
  return parsed + QUOTA_RESET_MARGIN_MS
}

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

  /** 心跳续租：daemon 每 tick 为本进程仍在跑的 job（inflight）续租，防止合法长跑
   *  （如季包多集下载）被下一 tick 的 reapExpiredLeases 误判死亡回收、导致并发双派发。
   *  只作用于仍处活跃态的行——job 若已被 complete* 收尾则是 no-op。 */
  renewLease(jobId: number, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs
         SET lease_until = ?, updated_at = ?
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(now + LEASE_DURATION_MS, now, jobId)
  }

  reapExpiredLeases(now: number): void {
    // Active state with NULL lease is anomalous (should never happen) — reap it too.
    // NOTE: 不再 attempt+1——reap 只是"租约死了/异常态"，不是内容性失败，不该占内容退避梯
    // 的名额（否则进程重启/租约抖动会把 job 错误地推向 30 天 dormant，见审计 jobsRepo.ts:119
    // / :133 的 attempt 计数器混同问题）。
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', lease_until = NULL, updated_at = ?
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
    // NOTE: 不再 attempt+1——同 reapExpiredLeases 的理由：进程重启/崩溃回收的 job 不是
    // 内容性失败，不该消耗内容退避梯的名额。
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', lease_until = NULL, updated_at = ?
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

  /** Transient error (network/LLM/5xx): short backoff, separate track from content failures.
   *  quotaResetAt: OS 配额耗尽（quota_exhausted）时携带的 provider reset 时间——有效（可解析且未来）
   *  时按 resetAt+margin 精确排期，而不是走盲的 ERROR_BACKOFF_MS 阶梯（否则会在配额重置前每
   *  至多 15min 重打一次完整 identify+plan+search+/download，白烧 LLM/search 配额）。
   *  IMPORTANT-2: 配额停车不是内容性失败，不该占内容退避梯的名额——同 reapExpiredLeases/
   *  reapAllActive 的 attempt 不变语义。否则日常配额停车会悄悄推高 attempt，后面一次真正的
   *  no_safe_match 就会越级跳到 30 天 dormant，跳过 1/2/4/8 天梯。 */
  completeError(jobId: number, error: string, now: number, quotaResetAt?: string | null): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const quotaRetry = quotaRetryAt(quotaResetAt, now)
      const newAttempt = quotaRetry != null ? job.attempt : job.attempt + 1
      const nextRetryAt = quotaRetry ?? now + errorBackoffMs(newAttempt)
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
   *  I6: 带 30 秒节流窗（PARTIAL_RETRY_MS），防止 partial → wanted → 立即重领的紧循环。
   *  quotaResetAt: 季包/季横扫中途撞配额耗尽时携带的 provider reset 时间（IMPORTANT-1a）——有效时
   *  按 resetAt+margin 精确排期，而不是走盲的 30 秒节流，否则配额重置前每 30 秒重打一次覆盖剩余
   *  集的全链路，白烧配额。 */
  completePartial(jobId: number, now: number, quotaResetAt?: string | null): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const newAttempt = Math.max(0, job.attempt - 1)
      const nextRetryAt = quotaRetryAt(quotaResetAt, now) ?? now + PARTIAL_RETRY_MS
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'wanted', attempt = ?, next_retry_at = ?, lease_until = NULL, updated_at = ?
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newAttempt, nextRetryAt, now, jobId)
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

  /** Retire satisfied jobs from wanted/failed → done (aggregator cleanup semantic).
   *  A 'failed' job with a pending next_retry_at is mid content-backoff (1/2/4/8d
   *  ladder) — its target can look momentarily "not missing" (e.g. unavailable with
   *  a future recheck_after) without being externally satisfied. Retiring it here
   *  flips it to 'done', and the next upsertWanted done→wanted revival resets
   *  attempt to 0, silently defeating the ladder. Only retire once the backoff
   *  window has actually elapsed (or there never was one). */
  retire(jobId: number, now: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'done', updated_at = ?
         WHERE id = ? AND state IN ('wanted', 'failed')
         AND (next_retry_at IS NULL OR next_retry_at <= ?)`
      )
      .run(now, jobId, now)
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
