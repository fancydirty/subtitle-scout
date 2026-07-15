import type { ScoutDb } from './db.js'

// 双轨速率差是有意的：网络类错误快重试到好（阶梯 30s→5min，封顶 15min 防撞墙），
// 内容类失败按天退避（字幕产出以天为单位）。
export const CONTENT_BACKOFF_DAYS = [1, 2, 4, 8]
export const ERROR_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]
/** 1b 瞬时错误给-up 界：15min 封顶意味着无穷重试的瞬时错误每天要打 96 次完整
 *  identify+plan+search+/download，白烧 Jellyfin/TMDB/provider 调用。20 次 ≈ 20 * 15min = 5h
 *  的持续失败后，判定"短期内不会自愈"，退避阶梯升级为每天一次——但只是慢下来，
 *  绝不转 30 天 dormant（dormant 是内容轨在证实"搜索穷尽"后的专属结局；瞬时错误从来没有
 *  证明内容不存在，必须永远保持 failed 可重试）。一旦job 翻篇成功（done→wanted 复活），
 *  error_attempt 归零，重新从 30s 起步。 */
export const ERROR_GIVEUP_THRESHOLD = 20
export const ERROR_BACKOFF_DAILY_MS = 24 * 3_600_000
export const errorBackoffMs = (attempt: number) =>
  attempt > ERROR_GIVEUP_THRESHOLD ? ERROR_BACKOFF_DAILY_MS : (ERROR_BACKOFF_MS[attempt - 1] ?? 900_000)
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

export type JobKind = 'series_season' | 'movie' | 'realign' | 'worker_task'
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

export interface RealignJobIdentity {
  kind: 'realign'
  seriesId: string
}

export type JobIdent = JobIdentity | MovieJobIdentity | RealignJobIdentity

// worker_task 身份（v3 phase ④）：故意不并入 JobIdent 联合类型——upsertWanted 的
// if/else-if/else 三分支穷尽窄化正好对应 JobIdent 现有的三个变体，塞入第 4 个变体而不
// 重写那个 else 分支会让 worker_task 身份被静默路由进 realign 的 SQL 分支（写下 upsertWanted
// 现有实现之后才看清这个风险）。upsertWorkerTask 用这个独立类型，走独立方法。
export interface WorkerTaskIdentity {
  seriesId: string | null
  season: number | null
  movieId: string | null
}

export interface Job {
  id: number
  kind: JobKind
  series_id: string | null
  season: number | null
  movie_id: string | null
  plan_ref: string | null
  payload: string | null
  parent_job_id: number | null
  state: JobState
  priority: number
  target_episodes: string | null
  attempt: number
  error_attempt: number
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
  // 双轨 attempt 审计修正：error_attempt 与 attempt 同一套"done→wanted 才归零"语义——
  // completeError/completeNoMatch/completePartial 本身都不重置对方或自己的计数器（各自
  // 只增/减自己那条轨），归零统一发生在这里：job 彻底做完（done）后被下一轮复活，
  // 才算翻篇重新开始，两条轨一起清零。
  // plan_ref（D-review #1）：upsertWanted 的 INSERT 恒带 NULL（清单在执行阶段才由 setPlanRef
  // 回填），无条件 plan_ref = excluded.plan_ref 会让执行中/失败/休眠 job 的崩溃恢复清单指针
  // 被一次 mid-execution re-upsert 直接抹掉——只有 done→wanted 复活（翻篇重来）才重置，
  // 其余状态一律保留现值。
  private static readonly UPSERT_CONFLICT_SQL = `
           ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
           DO UPDATE SET
             updated_at = ?,
             plan_ref = CASE WHEN state = 'done' THEN excluded.plan_ref ELSE jobs.plan_ref END,
             state = CASE WHEN state = 'done' THEN 'wanted' ELSE state END,
             attempt = CASE WHEN state = 'done' THEN 0 ELSE attempt END,
             error_attempt = CASE WHEN state = 'done' THEN 0 ELSE error_attempt END,
             next_retry_at = CASE WHEN state = 'done' THEN NULL ELSE next_retry_at END`

  upsertWanted(ident: JobIdent, now: number): void {
    if (ident.kind === 'series_season') {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
           VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.seriesId, ident.season, now, now, now)
    } else if (ident.kind === 'movie') {
      this.db
        .prepare(
          `INSERT INTO jobs (kind, movie_id, state, priority, attempt, created_at, updated_at)
           VALUES ('movie', ?, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.movieId, now, now, now)
    } else {
      // realign：season 恒 NULL；plan_ref 诊断创建时未知，留 NULL，真正执行时由 setPlanRef 回填。
      this.db
        .prepare(
          `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
           VALUES ('realign', ?, NULL, NULL, 'wanted', 0, 0, ?, ?)${JobsRepo.UPSERT_CONFLICT_SQL}`
        )
        .run(ident.seriesId, now, now, now)
    }
  }

  /** 主代理派活(v3 phase ④/⑤)：写一行 worker_task job。复用 series_id/season/movie_id 三列做
   *  身份 dedup——jobs_identity 的 (kind, series_id, season, movie_id) 四元组里 kind 本身已经
   *  区分 worker_task 与 series_season/movie/realign，同一 identity 重复派发是幂等 upsert
   *  （镜像 upsertWanted 的 done→wanted 复活语义：非 done 态只碰 updated_at，done 态整体刷新
   *  payload/parent_job_id 并复活）。没有自然季/剧归属的任务（如 sibling-orchestrator 分片）
   *  用合成 seriesId（如 'orchestrator-shard-<parentJobId>-<n>'），season/movieId 恒 null。
   *  故意是独立方法而非塞进 upsertWanted：见上方 WorkerTaskIdentity 的注释。 */
  upsertWorkerTask(
    ident: WorkerTaskIdentity, payload: Record<string, unknown>, parentJobId: number | null, now: number,
  ): void {
    const payloadJson = JSON.stringify(payload)
    this.db
      .prepare(
        `INSERT INTO jobs (kind, series_id, season, movie_id, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
         VALUES ('worker_task', ?, ?, ?, ?, ?, 'wanted', 0, 0, ?, ?)
         ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
         DO UPDATE SET
           updated_at = ?,
           payload = CASE WHEN state = 'done' THEN excluded.payload ELSE jobs.payload END,
           parent_job_id = CASE WHEN state = 'done' THEN excluded.parent_job_id ELSE jobs.parent_job_id END,
           state = CASE WHEN state = 'done' THEN 'wanted' ELSE state END,
           attempt = CASE WHEN state = 'done' THEN 0 ELSE attempt END,
           error_attempt = CASE WHEN state = 'done' THEN 0 ELSE error_attempt END,
           next_retry_at = CASE WHEN state = 'done' THEN NULL ELSE next_retry_at END`
      )
      .run(ident.seriesId, ident.season, ident.movieId, payloadJson, parentJobId, now, now, now)
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

  /** FIX-4a（observability 审计修正）：journal_ref 是 schema v1 就有的列，此前从未被
   *  写过。executeJob 在真正跑 runEpisode（有网络/LLM 调用、可能撞上 lost async
   *  continuation 那类异常）之前，把本次调用要用的 journal 引用先落盘——即便这次调用
   *  之后进程"断线"、job 卡死，也能从这一行倒查是哪次运行、对应哪份 journal 明细，
   *  不再是零证据。只在 active 态生效（no-op 保护，同 renewLease 语义：job 若已被
   *  complete* 收尾，没有再写它的道理）。 */
  setJournalRef(jobId: number, journalRef: string, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET journal_ref = ?, updated_at = ? WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(journalRef, now, jobId)
  }

  /** 整理执行闭包在计划构建、manifest 落盘之后回填清单路径——诊断创建 job 那一刻还没有
   *  清单可指（诊断只判断"是不是绝对编号平铺"，不构建计划）。同 setJournalRef 语义：
   *  仅在 active 态生效，job 已被 complete* 收尾则是 no-op。 */
  setPlanRef(jobId: number, planRef: string, now: number): void {
    this.db
      .prepare(
        `UPDATE jobs SET plan_ref = ?, updated_at = ? WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(planRef, now, jobId)
  }

  /** 心跳续租：daemon 每 tick 为本进程仍在跑的 job（inflight）续租，防止合法长跑
   *  （如季包多集下载）被下一 tick 的 reapExpiredLeases 误判死亡回收、导致并发双派发。
   *  只作用于仍处活跃态的行——job 若已被 complete* 收尾则是 no-op。
   *  FIX-2：返回新写入的 lease_until（no-op 时返回 null），供调用方把这个值同步
   *  写回它自己持有的 Job 对象引用（daemon.inflightJobs 里的那个），让"这次调用是否
   *  还拥有租约"的判据（executor.ts 的 FIX-3 ownsLease 检查）能跟着合法续租一起前进，
   *  而不是永远比对 claim 那一刻的旧值——否则任何跑超一个 tick 间隔的长任务都会被
   *  误判"租约已失效"。 */
  renewLease(jobId: number, now: number): number | null {
    const leaseUntil = now + LEASE_DURATION_MS
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET lease_until = ?, updated_at = ?
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(leaseUntil, now, jobId)
    return info.changes > 0 ? leaseUntil : null
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

  /** FIX-1（派发饥饿审计修正）：单实例前提下，调用方（daemon tick）传入"本进程当前
   *  正在跟踪（inflight）"的 job id 集合——任何 active 态但 id 不在这个集合里的行，
   *  定义上就是孤儿（同 reapAllActive"旧进程遗孤"的论证，只是判据从"进程重启"换成
   *  "跟踪集合缺失"），不必等 30min 租约到期即可回收，堵死生产实案：executeJob 的
   *  promise 结算但其 continuation（.finally）从未被调度、导致 job 卡在 active 态且
   *  不再被本进程跟踪，过去只能靠 reapExpiredLeases 在租约到期后（最长 30 分钟）自愈。
   *  不 attempt+1——同 reapExpiredLeases/reapAllActive 的"reap 不是内容性失败"语义。
   *  返回被回收行的回收前快照（state 仍是原 active 态），供调用方记一行 warn 日志。
   *  MINOR（审计遗留）：这把单实例前提从"启动时一次性回收"升级成"每个 tick 都执行"——两个
   *  daemon 实例共享同一个 DB 时会互相把对方的 inflight job 当孤儿回收，陷入持续互 reap；
   *  真要支持多实例，落地判据得从"trackedIds 集合缺失"换成 jobs 表上的 pid/owner 列。 */
  reapOrphaned(trackedIds: Iterable<number>, now: number): Job[] {
    const excluded = [...trackedIds]
    const placeholders = excluded.map(() => '?').join(',')
    const notInClause = excluded.length > 0 ? `AND id NOT IN (${placeholders})` : ''
    return this.db.transaction(() => {
      const candidates = this.db
        .prepare(`SELECT * FROM jobs WHERE state IN ${ACTIVE_STATES_SQL} ${notInClause}`)
        .all(...excluded) as Job[]
      if (candidates.length === 0) return []
      const update = this.db.prepare(
        `UPDATE jobs SET state = 'wanted', lease_until = NULL, updated_at = ?
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      for (const c of candidates) update.run(now, c.id)
      return candidates
    })()
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

  /** Content failure (no_safe_match): exponential backoff 1/2/4/8 days, then dormant on the 5th failure.
   *  双轨 attempt 审计修正：只读写内容轨的 attempt 列，从不触碰 error_attempt——瞬时错误历史
   *  不该被内容判据消费，也不该被内容失败清零（各自独立，统一在 done→wanted 复活时一起归零）。 */
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
   *  双轨 attempt 审计修正：只读写 error_attempt，从不触碰内容轨的 attempt 列——两条速率
   *  差异巨大的退避梯（30s..15min..升级为每天 vs 1/2/4/8 天+dormant）曾共用一个计数器，
   *  一串瞬时错误会让下一次真正的 no_safe_match 越级跳档（见 db.ts v4 迁移注释）。
   *  quotaResetAt: OS 配额耗尽（quota_exhausted）时携带的 provider reset 时间——有效（可解析且未来）
   *  时按 resetAt+margin 精确排期，而不是走盲的 ERROR_BACKOFF_MS 阶梯（否则会在配额重置前每
   *  至多 15min 重打一次完整 identify+plan+search+/download，白烧 LLM/search 配额）。
   *  IMPORTANT-2: 配额停车不是瞬时错误的真实累积，不该推高 error_attempt——同 reapExpiredLeases/
   *  reapAllActive 的"不是失败别充电"语义。否则日常配额停车会悄悄推高 error_attempt，
   *  误触发 give-up 阈值升级到每天一次退避。 */
  completeError(jobId: number, error: string, now: number, quotaResetAt?: string | null): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const quotaRetry = quotaRetryAt(quotaResetAt, now)
      const newErrorAttempt = quotaRetry != null ? job.error_attempt : job.error_attempt + 1
      const nextRetryAt = quotaRetry ?? now + errorBackoffMs(newErrorAttempt)
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'failed', error_attempt = ?, next_retry_at = ?, last_error = ?, lease_until = NULL, updated_at = ?
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newErrorAttempt, nextRetryAt, error, now, jobId)
      return info.changes > 0
    })()
  }

  /** Partial success: attempt decrements (gradual escalation recovery), back to wanted for the remainder.
   *  双轨 attempt 审计修正：只减内容轨的 attempt，从不触碰 error_attempt——部分覆盖是内容轨的
   *  渐进恢复信号（验证过了这份候选是"可以往前走"的），与瞬时错误历史无关，不该替它归零。
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

  /** 停车（D-review #3）：active → dormant，一步到位、不走退避梯。与 completeError 的本质
   *  区别：completeError 服务"会自愈的瞬时故障"（网络/LLM/5xx），30s→15min→daily 重试有
   *  意义；park 服务"重试无意义的配置性缺陷"（如 executeRealign 未接线）——重试一万次也
   *  不会自己长出接线，走 error 轨就是无穷 errorloop。dormant 不参与 claimNext 派发，但
   *  保留 wake 唤醒通道（修好配置后可手动/播放唤醒），不是死刑是停车。
   *  同 complete* 守卫语义：仅从 active 态出发，否则 no-op。 */
  park(jobId: number, reason: string, now: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'dormant', last_error = ?, next_retry_at = NULL, lease_until = NULL, updated_at = ?
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(reason, now, jobId)
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

  /** W0-4 存量墓碑：cmdWatch 的 executeJob 闭包对旧 kind（series_season/movie）收到一个已经
   *  被 claimNext 领走（state='searching'）的存量行时调用——旧管线的执行器不再接线，这一行
   *  不是失败，是被 v3 orchestrator 的 list_missing_coverage 正常派活覆盖了同一个 series/movie
   *  的缺口。语义上与 completeDone（active→done，清 lease_until）完全同构，之所以不直接复用
   *  completeDone、另起一个名字，是让调用点和日后 grep 都能一眼认出"这是退休声明，不是真的
   *  跑完产出了字幕判断"（没有 runs 行、没有 subtitles 行）。
   *  与既有的单 id `retire()`（wanted/failed→done，聚合器清理语义）precondition 不同——那个
   *  方法服务的是"job 还没被认领、目标已被外部满足"，这里服务的是"job 已被认领
   *  （active/searching），但旧执行器已经死了，得体面收场"，两者状态前提不重叠，不能共用
   *  同一个方法（那会让 retire() 意外接受本不该由它处理的态）。
   *  DB 不迁移（W0-4 明确决定）：state 列 CHECK 约束没有专门的 'retired' 值，落回既有的
   *  'done'——这也是为什么这个方法不新增状态机分支，只是 completeDone 的一个语义化外壳。 */
  retireClaimed(jobId: number, now: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'done', lease_until = NULL, updated_at = ?
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(now, jobId)
    return info.changes > 0
  }

  /** realign 完成后的镜像清理一环：该剧旧的 series_season job（按老的、即将被清空的季划分）
   *  不再有意义（新结构下季/集边界完全变了，调和循环会在下一轮 scan 后按新结构重新聚合出
   *  正确的 job）——退休全部静止态：wanted/failed/dormant。dormant 必须包含（D-review #2）：
   *  它是"对着旧的错误排布搜索穷尽"的判决，本函数的全部意义就是宣告这类判决作废；漏掉它，
   *  realign 后这一季会被 30 天休眠卡死、永远不再重新搜索（聚合器 upsertWanted 对 dormant
   *  不复活）。active 态（理论上此刻不该有——realign 本身占着搜索槽，不会有同剧的
   *  series_season job 正在跑）留给它自己的状态机走完，不强退。 */
  retireAllForSeries(seriesId: string, now: number): number {
    const info = this.db
      .prepare(
        `UPDATE jobs SET state = 'done', updated_at = ?
         WHERE kind = 'series_season' AND series_id = ? AND state IN ('wanted', 'failed', 'dormant')`
      )
      .run(now, seriesId)
    return info.changes
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
    } else if (ident.kind === 'movie') {
      this.db
        .prepare(
          `UPDATE jobs
           SET priority = ?
           WHERE kind = 'movie' AND movie_id = ?`
        )
        .run(priority, ident.movieId)
    } else {
      // realign：没有季维度，按 series_id 定位——同 upsertWanted/retireAllForSeries
      // 已经确立的"realign 以剧为身份"语义。目前没有调用方会拿 realign 身份触发优先级
      // 提升（realign 不是播放触发的），这里补全只是让三态联合类型保持穷尽可编译，
      // 行为上与 series_season 分支对称。
      this.db
        .prepare(
          `UPDATE jobs
           SET priority = ?
           WHERE kind = 'realign' AND series_id = ?`
        )
        .run(priority, ident.seriesId)
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
    if (ident.kind === 'movie') {
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'wanted', priority = ?, next_retry_at = NULL, updated_at = ?
           WHERE kind = 'movie' AND movie_id = ? AND state = 'dormant'`
        )
        .run(priority, now, ident.movieId)
      return info.changes > 0
    }
    // realign：同 boostPriority 的对称补全，按 series_id 定位，行为上不会被现有调用方
    // 触发（realign 不是播放触发的），只为让穷尽检查通过。
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', priority = ?, next_retry_at = NULL, updated_at = ?
         WHERE kind = 'realign' AND series_id = ? AND state = 'dormant'`
      )
      .run(priority, now, ident.seriesId)
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
