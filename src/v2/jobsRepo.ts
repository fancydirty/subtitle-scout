import type { ScoutDb } from './db.js'

// 双轨速率差是有意的：网络类错误快重试到好（阶梯 30s→5min，封顶 15min 防撞墙），
// 内容类失败按天退避（字幕产出以天为单位）。
export const ERROR_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]
/** 1b 瞬时错误给-up 界：15min 封顶意味着无穷重试的瞬时错误每天要打 96 次完整
 *  identify+plan+search+/download，白烧 TMDB/provider 调用。20 次 ≈ 20 * 15min = 5h
 *  的持续失败后，判定"短期内不会自愈"，退避阶梯升级为每天一次——但只是慢下来，
 *  绝不转 30 天 dormant（dormant 是内容轨在证实"搜索穷尽"后的专属结局；瞬时错误从来没有
 *  证明内容不存在，必须永远保持 failed 可重试）。一旦job 翻篇成功（done→wanted 复活），
 *  error_attempt 归零，重新从 30s 起步。 */
export const ERROR_GIVEUP_THRESHOLD = 20
export const ERROR_BACKOFF_DAILY_MS = 24 * 3_600_000
export const errorBackoffMs = (attempt: number) =>
  attempt > ERROR_GIVEUP_THRESHOLD ? ERROR_BACKOFF_DAILY_MS : (ERROR_BACKOFF_MS[attempt - 1] ?? 900_000)

const LEASE_DURATION_MS = 30 * 60_000 // 30 minutes

// Active (non-rest) states — every complete* transition must originate here.
const ACTIVE_STATES_SQL = `('searching', 'downloading', 'verifying')`

export type JobKind = 'series_season' | 'movie' | 'realign' | 'worker_task'
export type JobState = 'wanted' | 'searching' | 'downloading' | 'verifying' | 'done' | 'failed' | 'dormant'

/** R-2（裁决 2026-07-16，审计 A-F1）：派发不再有静默结局——每次 upsert 返回它实际做了什么。
 *  考古定罪：upsertWorkerTask 曾经对非 done 态行静默 no-op 且从不返回任何东西，而 dispatch
 *  工具（orchestratorAgent.tools.ts）无条件回报 {dispatched:true}——dormant/failed 行悄悄
 *  吞掉主代理的新派发，还向它谎报成功，制造永久活锁（主代理以为派了，实际这一行纹丝不动）。
 *  blocked_dormant 是四态里唯一"没写"的结局：dormant 行不复活（park 通常意味着一个配置性
 *  缺陷被记录在案，机械复活=让同一个错误循环回归），但事实必须原样抵达 orchestrator，由它
 *  （而不是这一层沉默的 SQL）决定告警、绕行、还是上报人类。
 *
 *  F-R2-5（R2 复审，审计定罪：coalesced 谎报"identical"+新意图丢弃）：coalesced 分裂出
 *  intentRefreshed——wanted/failed 两态还没被认领，没有 worker 正在读它的 payload，本次
 *  dispatch 携带的最新意图（新的季范围/reason/remainingWorkSummary）现在真的会覆盖旧的
 *  （intentRefreshed:true）；active（searching/downloading/verifying）态有一个 worker 正在
 *  跑、正在读着旧 payload，此刻覆写对它没有意义，继续保持"只碰 updated_at"的旧行为
 *  （intentRefreshed:false）。考古定罪：旧代码对 wanted/failed/active 一视同仁地只刷
 *  updated_at，本次 dispatch 的新意图在 wanted/failed 情形下被无声丢弃在原地，coalesced 回执
 *  还谎称"an identical task"——多数情况下并不 identical，只是撞了同一个 identity。 */
export type WorkerTaskUpsertOutcome =
  | { outcome: 'created' }
  | { outcome: 'revived' }                              // done → wanted 复活
  | { outcome: 'coalesced'; pendingState: JobState; intentRefreshed: boolean }
  | { outcome: 'blocked_dormant'; lastError: string | null }

// worker_task 身份（v3 phase ④）。
// 清算波 R-6（A-F8）：这里原先解释"故意不并入 JobIdent 联合类型"——JobIdent（连同它的
// upsertWanted 消费者）已随死器官处决整体删除（series_season/movie/realign 三个旧 kind
// 的创建/查询/优先级/唤醒方法在生产代码里已零调用点，唯一幸存的旧管线残余是 kind='realign'
// worker_task 早已取代的老式行——见本文件历史 diff）。独立类型/独立方法的理由本身依然成立
// （taskType 参与 identity 元组，见下方 R-11 注释），只是不再有一个"JobIdent 三分支"可比较。
// R-11（用户裁决 2026-07-16，schema v11）：season 字段对 find_subtitle 任务恒为 null——派活
// 范围（哪些季）不再是身份的一部分，改由 payload.seasons 承载（数组=季子集，null=全剧，缺席=
// 存量行按旧语义单季推导，见 findSubtitleWorkerTask.ts 的 mapper）。identity 元组本身也已从
// (kind, series_id, season, movie_id) 扩到 (kind, series_id, season, movie_id, taskType)——
// taskType 从 payload 里 json_extract 出来参与 ON CONFLICT（见下方 upsertWorkerTask 的 SQL），
// 这样 find_subtitle 与 realign 对同一 series 才不会撞成同一行。
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
  /** SRE 审计 F1:连续"无完成回收"次数(claim→进程死→reap→重 claim 的崩溃循环计数)。
   *  到 REAP_PARK_THRESHOLD 由 reap 直接 park;任何完成(completeDone/completeError)清零。 */
  reap_count: number
  next_retry_at: number | null
  lease_until: number | null
  /** 本次 claim 发生的时刻（claimNext 置 now）。**renewLease 绝不触碰它**——这是它与
   *  lease_until/updated_at 的关键区别：心跳续租会把那两个刷到 ~now，而这个恒为 claim 时刻。
   *  dashboard 活动页 hero 的"已进行 N 秒"秒表拿它当稳定锚点（见 apiV2.buildWorkflowWorkers
   *  与 db.ts v29 迁移；存量在飞行中的行此列为 null，apiV2 端 ?? updated_at 兜底）。 */
  lease_started_at: number | null
  last_error: string | null
  journal_ref: string | null
  created_at: number
  updated_at: number
}

/** held 衰减梯(见 completeHeld):首周 +1d,次周 +3d,之后 +7d。 */
export function heldBackoffMs(errorAttempt: number): number {
  const DAY = 86_400_000
  if (errorAttempt <= 7) return DAY
  if (errorAttempt <= 14) return 3 * DAY
  return 7 * DAY
}

/** SRE 审计 F1:崩溃循环隔离阈。reap 故意不占内容退避梯(良性重启不该推向 dormant),但
 *  "确定性崩溃+容器自动重启"会以重启速度无限重跑付费 LLM 任务——连续这么多次无完成回收
 *  后,job 被 park 成 dormant(停车待人工,非死刑),不再参与 claimNext。 */
export const REAP_PARK_THRESHOLD = 5

/** reap 共用的两阶段 SQL:先把将触阈的行 park(计数照记,last_error 写明隔离原因),
 *  其余归位 wanted。reap_count 在任何完成处清零(completeDone/completeError)。 */
const REAP_PARK_REASON = `连续 ${REAP_PARK_THRESHOLD} 次进程崩溃/租约死亡回收未竟全功——疑确定性崩溃(poison task),已隔离防无限烧钱(修复后手动唤醒)`

export class JobsRepo {
  constructor(private db: ScoutDb) {}

  /** 主代理派活(v3 phase ④/⑤)：写一行 worker_task job。复用 series_id/season/movie_id 三列
   *  加上 payload 里的 taskType 做身份 dedup——jobs_identity 的 (kind, series_id, season,
   *  movie_id, taskType) 五元组（R-11，schema v11）里 kind 本身已经区分 worker_task 与
   *  series_season/movie/realign，taskType 进一步区分同一 series 下不同种类的 worker_task
   *  （find_subtitle vs realign 不再共享一行）。同一 identity 重复派发是幂等 upsert（done 态
   *  整体刷新 payload/parent_job_id 并复活；wanted/failed 态刷新 payload（F-R2-5：最新意图
   *  胜出，attempt/error_attempt/next_retry_at 不动）；active 态仅刷 updated_at——见下方 R-2/
   *  F-R2-5 outcome）。没有自然季/剧归属的任务（如 sibling-orchestrator 分片）用合成 seriesId
   *  （如 'orchestrator-shard-<parentJobId>-<n>'），season/movieId 恒 null。故意是独立方法：
   *  见上方 WorkerTaskIdentity 的注释。 */
  upsertWorkerTask(
    ident: WorkerTaskIdentity, payload: Record<string, unknown>, parentJobId: number | null, now: number,
  ): WorkerTaskUpsertOutcome {
    const payloadJson = JSON.stringify(payload)
    const taskType = typeof payload.taskType === 'string' ? payload.taskType : ''
    // R-2: SELECT-then-branch replaces the old blind ON CONFLICT DO UPDATE — the old SQL updated
    // a dormant row's updated_at/payload no differently than any other non-done row, silently
    // absorbing the new dispatch with zero signal that it went nowhere. Single transaction
    // (SELECT + the branch's own write) closes the TOCTOU window between reading current state
    // and acting on it — a concurrent writer can't flip the row between the two.
    // DB 审计🟡:读后再写的事务改 BEGIN IMMEDIATE(取 RESERVED 锁于 BEGIN——deferred 的快照
    //  升级写锁时撞并发写者会立即 SQLITE_BUSY_SNAPSHOT,busy_timeout 帮不上;跨进程(daemon vs
    //  docker exec 一次性 CLI)竞态从"升级死锁"变"诚实等待")。
    return this.db.transaction((): WorkerTaskUpsertOutcome => {
      const existing = this.db
        .prepare(
          `SELECT * FROM jobs
           WHERE kind = 'worker_task'
             AND ifnull(series_id,'') = ifnull(?,'')
             AND ifnull(season,-1) = ifnull(?,-1)
             AND ifnull(movie_id,'') = ifnull(?,'')
             AND ifnull(json_extract(payload,'$.taskType'),'') = ?`
        )
        .get(ident.seriesId, ident.season, ident.movieId, taskType) as Job | undefined

      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO jobs (kind, series_id, season, movie_id, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
             VALUES ('worker_task', ?, ?, ?, ?, ?, 'wanted', 0, 0, ?, ?)`
          )
          .run(ident.seriesId, ident.season, ident.movieId, payloadJson, parentJobId, now, now)
        return { outcome: 'created' }
      }

      // blocked_dormant: the one outcome that writes nothing at all (not even updated_at) — see
      // the WorkerTaskUpsertOutcome doc comment above for why dormant must never be silently
      // revived by a routine dispatch.
      if (existing.state === 'dormant') {
        return { outcome: 'blocked_dormant', lastError: existing.last_error }
      }

      if (existing.state === 'done') {
        this.db
          .prepare(
            `UPDATE jobs
             SET updated_at = ?, payload = ?, parent_job_id = ?,
                 state = 'wanted', attempt = 0, error_attempt = 0, next_retry_at = NULL, reap_count = 0
             WHERE id = ?`
          )
          .run(now, payloadJson, parentJobId, existing.id)
        return { outcome: 'revived' }
      }

      // F-R2-5（R2 复审，审计定罪：coalesced 谎报"identical"+新意图丢弃）：wanted/failed 两态
      // 的行还没被认领——没有 worker 正在读它的 payload，本次 dispatch 携带的最新意图（新的
      // 季范围/reason/remainingWorkSummary）理应赢过旧的，而不是被无声丢弃在原地。
      // attempt/error_attempt/next_retry_at 不动：这两条退避轨只由 done→revived（归零重试
      // 计数）和 dormant→blocked（停车判决）触碰，coalesced 从不改变它们（F1 裁决锁定的语义
      // 边界，不因 F-R2-5 的 payload 刷新而松动）。
      if (existing.state === 'wanted' || existing.state === 'failed') {
        this.db.prepare(`UPDATE jobs SET updated_at = ?, payload = ? WHERE id = ?`).run(now, payloadJson, existing.id)
        return { outcome: 'coalesced', pendingState: existing.state, intentRefreshed: true }
      }

      // active（searching/downloading/verifying）：一个 worker 正在跑、正在读着旧 payload——
      // 此刻覆写对它没有意义（读过了）也有风险（万一它还没读完就被换底），只刷 updated_at
      // （mirrors the old ON CONFLICT's no-op branch for this state only）。
      this.db.prepare(`UPDATE jobs SET updated_at = ? WHERE id = ?`).run(now, existing.id)
      return { outcome: 'coalesced', pendingState: existing.state, intentRefreshed: false }
    }).immediate()
  }

  claimNext(now: number, opts?: { onlyTaskType?: string; excludeTaskType?: string }): Job | null {
    const leaseUntil = now + LEASE_DURATION_MS
    // 相位分隔(用户裁决 2026-07-22):taskType 过滤进 claim 本身——translate 任务只在调用方
    // 显式 onlyTaskType 时才会被领走;主派发循环带 excludeTaskType:'translate',巡检工作
    // (find_subtitle/realign/orchestrate)永远先走,不被长翻译头阻塞。
    const only = opts?.onlyTaskType
    const exclude = opts?.excludeTaskType
    const taskFilter = only != null
      ? `AND ifnull(json_extract(payload,'$.taskType'),'') = ?`
      : exclude != null
        ? `AND ifnull(json_extract(payload,'$.taskType'),'') != ?`
        : ''
    const taskFilterParam = only ?? exclude ?? ''
    const job = this.db
      .prepare(
        `UPDATE jobs SET state = 'searching', lease_until = ?, updated_at = ?, lease_started_at = ?
         WHERE id = (
           SELECT id FROM jobs
           WHERE state IN ('wanted', 'failed')
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ${taskFilter}
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
         )
         RETURNING *`
      )
      .get(...(taskFilter ? [leaseUntil, now, now, now, taskFilterParam] : [leaseUntil, now, now, now])) as Job | undefined
    return job ?? null
  }

  /** claimNext 同款谓词的只读计数(wanted/failed 且到点,可按 taskType 收窄/排除)——
   *  相位分隔的"巡检队列已空"门:不计活跃态,只数"现在就能领的活"。 */
  countClaimable(now: number, opts?: { onlyTaskType?: string; excludeTaskType?: string }): number {
    const only = opts?.onlyTaskType
    const exclude = opts?.excludeTaskType
    const taskFilter = only != null
      ? `AND ifnull(json_extract(payload,'$.taskType'),'') = ?`
      : exclude != null
        ? `AND ifnull(json_extract(payload,'$.taskType'),'') != ?`
        : ''
    const taskFilterParam = only ?? exclude ?? ''
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM jobs
         WHERE state IN ('wanted', 'failed')
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ${taskFilter}`
      )
      .get(...(taskFilter ? [now, taskFilterParam] : [now])) as { c: number }
    return row.c
  }

  /** 活跃态(searching/downloading/verifying)按 taskType 计数:exclude=null 只数指定
   *  taskType;exclude 给定时数除它之外的(相位分隔的双车道计数)。 */
  countActiveTaskType(taskType: string, exclude: boolean): number {
    const cond = exclude
      ? `ifnull(json_extract(payload,'$.taskType'),'') != ?`
      : `ifnull(json_extract(payload,'$.taskType'),'') = ?`
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE state IN ${ACTIVE_STATES_SQL} AND ${cond}`)
      .get(taskType) as { c: number }
    return row.c
  }

  /** 整理执行闭包在计划构建、manifest 落盘之后回填清单路径——诊断创建 job 那一刻还没有
   *  清单可指（诊断只判断"是不是绝对编号平铺"，不构建计划）。仅在 active 态生效，job 已被
   *  complete* 收尾则是 no-op（同 renewLease 语义：job 若已收尾，没有再写它的道理）。 */
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
   *  写回它自己持有的 Job 对象引用（daemon.inflightJobs 里的那个，见 daemon.ts
   *  inflightJobs 字段声明处注释）。这个契约最初是为旧管线 executor.ts 的 FIX-3
   *  ownsLease 检查准备的——让"这次调用是否还拥有租约"的判据（jobs.get(id).lease_until
   *  === job.lease_until）能跟着合法续租一起前进，而不是永远比对 claim 那一刻的旧值，
   *  否则任何跑超一个 tick 间隔的长任务都会被误判"租约已失效"。executor.ts 已随旧管线
   *  退役删除，今天没有代码再做这个精确比对，但返回值契约本身仍按原样保留（daemon.ts
   *  照常消费，为未来需要精确对比的消费方留一致的语义）。 */
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
    // NOTE: 不 attempt+1——reap 只是"租约死了/异常态"，不是内容性失败，不占内容退避梯
    // 名额（见审计 jobsRepo.ts:119 的 attempt 计数器混同问题）。但 reap_count+1（崩溃循环
    // 计数，SRE F1）——触阈的行 park 隔离而非归位。
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'dormant', last_error = ?, lease_until = NULL, updated_at = ?, reap_count = reap_count + 1
         WHERE state IN ${ACTIVE_STATES_SQL}
         AND (lease_until < ? OR lease_until IS NULL)
         AND reap_count + 1 >= ${REAP_PARK_THRESHOLD}`
      )
      .run(REAP_PARK_REASON, now, now)
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', lease_until = NULL, updated_at = ?, reap_count = reap_count + 1
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
        `UPDATE jobs SET state = 'wanted', lease_until = NULL, updated_at = ?, reap_count = reap_count + 1
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      const park = this.db.prepare(
        `UPDATE jobs SET state = 'dormant', last_error = ?, lease_until = NULL, updated_at = ?, reap_count = reap_count + 1
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      for (const c of candidates) {
        if (c.reap_count + 1 >= REAP_PARK_THRESHOLD) park.run(REAP_PARK_REASON, now, c.id)
        else update.run(now, c.id)
      }
      return candidates
    }).immediate()
  }

  /** 启动即回收：无条件把所有活跃态 job 归位 wanted，**不看租约是否过期**。
   *  单实例前提——daemon 启动时旧进程必已死，任何还挂在 searching/downloading/verifying
   *  的租约都是上个进程留下的遗孤（重启瞬间在跑的 job 租约仍未过期，最长可占 searching 槽
   *  30 分钟拖停调度）。返回回收行数。 */
  reapAllActive(now: number): number {
    // NOTE: 不 attempt+1——同 reapExpiredLeases 的理由：进程重启/崩溃回收的 job 不是
    // 内容性失败，不该消耗内容退避梯的名额。reap_count 同款 +1/触阈 park（SRE F1）。
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'dormant', last_error = ?, lease_until = NULL, updated_at = ?, reap_count = reap_count + 1
         WHERE state IN ${ACTIVE_STATES_SQL}
         AND reap_count + 1 >= ${REAP_PARK_THRESHOLD}`
      )
      .run(REAP_PARK_REASON, now)
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'wanted', lease_until = NULL, updated_at = ?, reap_count = reap_count + 1
         WHERE state IN ${ACTIVE_STATES_SQL}`
      )
      .run(now)
    return info.changes
  }

  /** held 专用衰减梯(用户裁决 2026-07-22):翻译质量闸拦下不是瞬时故障——模型 nondeterministic
   *  值得再给机会,但频率要衰减:首周每天一次(n≤7 → +1d),然后隔三差五(n≤14 → +3d),
   *  之后周级(+7d)。永不热循环烧配额,也永不判死刑(unavailable 衰减复查语义一致)。 */
  completeHeld(jobId: number, error: string, now: number): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false
      const newErrorAttempt = job.error_attempt + 1
      const nextRetryAt = now + heldBackoffMs(newErrorAttempt)
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'failed', error_attempt = ?, next_retry_at = ?, last_error = ?, lease_until = NULL, updated_at = ?,
               reap_count = 0
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newErrorAttempt, nextRetryAt, error, now, jobId)
      return info.changes > 0
    }).immediate()
  }

  /** Transient error (network/LLM/5xx): short backoff, separate track from content failures.
   *  双轨 attempt 审计修正：只读写 error_attempt，从不触碰内容轨的 attempt 列——两条速率
   *  差异巨大的退避梯（30s..15min..升级为每天 vs 内容轨的天级梯+dormant）曾共用一个计数器，
   *  一串瞬时错误会让下一次真正的内容失败越级跳档（见 db.ts v4 迁移注释）。 */
  completeError(jobId: number, error: string, now: number): boolean {
    return this.db.transaction(() => {
      const job = this.get(jobId)
      if (!job) return false

      const newErrorAttempt = job.error_attempt + 1
      const nextRetryAt = now + errorBackoffMs(newErrorAttempt)
      const info = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'failed', error_attempt = ?, next_retry_at = ?, last_error = ?, lease_until = NULL, updated_at = ?,
               reap_count = 0
           WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
        )
        .run(newErrorAttempt, nextRetryAt, error, now, jobId)
      return info.changes > 0
    }).immediate()
  }

  completeDone(jobId: number, now: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE jobs
         SET state = 'done', lease_until = NULL, updated_at = ?, reap_count = 0
         WHERE id = ? AND state IN ${ACTIVE_STATES_SQL}`
      )
      .run(now, jobId)
    return info.changes > 0
  }

  /** 停车（D-review #3）：active → dormant，一步到位、不走退避梯。与 completeError 的本质
   *  区别：completeError 服务"会自愈的瞬时故障"（网络/LLM/5xx），30s→15min→daily 重试有
   *  意义；park 服务"重试无意义的配置性缺陷"（如 executeRealign 未接线）——重试一万次也
   *  不会自己长出接线，走 error 轨就是无穷 errorloop。dormant 不参与 claimNext 派发；
   *  复活语义=upsert 四态回执（created/revived/coalesced/blocked_dormant）——wake/boostPriority
   *  通道已随 R-2/R-6 处决（甄别页认领 claimParked 亦已随两证据红线裁决退役，见 triageOps.ts）。
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

  /** realign 完成后的镜像清理一环：该剧旧排布下判决过时的 job 不再有意义（新结构下季/集
   *  边界完全变了，调和循环会在下一轮 scan/派活后按新结构重新聚合出正确的 job）——退休全部
   *  静止态：wanted/failed/dormant。dormant 必须包含（D-review #2）：它是"对着旧的错误排布
   *  搜索穷尽"的判决，本函数的全部意义就是宣告这类判决作废；漏掉它，realign 后这一季会被
   *  30 天休眠卡死、永远不再重新搜索（upsertWorkerTask 对 dormant 不复活，见上方
   *  blocked_dormant）。active 态（理论上此刻不该有——realign 本身占着搜索槽）留给它自己的
   *  状态机走完，不强退。
   *  F10（审计修正 2026-07-16）：本方法曾经只退休 kind='series_season' 的行——那是已退役的
   *  旧管线 kind（legacyJobRouting.ts 把它列为退役 kind，旧执行器不再接线），v3 起没有任何
   *  生产代码再写它，这条 UPDATE 因此从未真正作废过 realign 该作废的判决，是个从未生效的
   *  死镜像清理。真正对着"旧排布"下判决、需要作废的行是同一 series 下的 worker_task 行——
   *  尤其 find_subtitle 的 dormant/failed 判决：它们是"对着旧排布搜索穷尽/失败"的结论，
   *  新排布下这些结论从未被重新验证过。改为按 kind='worker_task' + series_id 定位（不分
   *  taskType——同剧下 realign/orchestrate 类 worker_task 若恰好落在这三个静止态，同样是
   *  过时判决，一并作废）。调用方（realignExecutor.ts:819/:881）签名不变，无需改动。 */
  retireAllForSeries(seriesId: string, now: number): number {
    const info = this.db
      .prepare(
        `UPDATE jobs SET state = 'done', updated_at = ?
         WHERE kind = 'worker_task' AND series_id = ? AND state IN ('wanted', 'failed', 'dormant')`
      )
      .run(now, seriesId)
    return info.changes
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
         SET state = 'searching', lease_until = ?, updated_at = ?, lease_started_at = ?
         WHERE kind = 'series_season' AND series_id = ? AND season = ?
         RETURNING *`
      )
      .get(leaseUntil, now, now, seriesId, season) as Job | undefined
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
