import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo, CONTENT_BACKOFF_DAYS, ERROR_BACKOFF_MS, errorBackoffMs, PARTIAL_RETRY_MS, QUOTA_RESET_MARGIN_MS, ERROR_GIVEUP_THRESHOLD, ERROR_BACKOFF_DAILY_MS } from './jobsRepo.js'

let repo: JobsRepo
beforeEach(() => { repo = new JobsRepo(openDb(':memory:')) })
const mkSeriesJob = (now = Date.now()) => repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 4 }, now)

describe('jobs 状态机', () => {
  it('upsertWanted 幂等：同剧同季只有一行', () => {
    mkSeriesJob(); mkSeriesJob()
    expect(repo.countByState('wanted')).toBe(1)
  })
  it('claimNext 原子领取：置 searching+租约，二次领取拿不到同一 job', () => {
    mkSeriesJob()
    const a = repo.claimNext(Date.now())
    expect(a?.state).toBe('searching')
    expect(repo.claimNext(Date.now())).toBeNull()
  })
  it('优先级高者先领', () => {
    const now = Date.now()
    mkSeriesJob(now)
    repo.upsertWanted({ kind: 'movie', movieId: 'm1' }, now); repo.boostPriority({ kind: 'movie', movieId: 'm1' }, 100)
    expect(repo.claimNext(now)?.movie_id).toBe('m1')
  })
  it('过租 job 被 reap 归位 wanted，attempt 不变（reap 不是内容性失败，不占内容退避梯名额）', () => {
    // 审计修正：reap 曾经 attempt+1，与 completeNoMatch 的内容退避梯共用计数器，
    // 会让"进程重启/租约抖动"错误地把 job 推向 30 天 dormant（见 jobsRepo.ts:119/:133 finding）。
    mkSeriesJob()
    const j = repo.claimNext(Date.now())!
    repo.reapExpiredLeases(Date.now() + 31 * 60_000)
    const again = repo.claimNext(Date.now() + 31 * 60_000)
    expect(again?.id).toBe(j.id); expect(again?.attempt).toBe(0)
  })
  it('active 态无租约（异常）也被 reap 归位，attempt 不变', () => {
    const now = Date.now()
    mkSeriesJob(now)
    repo.forceState('s1', 4, 'searching', now)         // lease_until 为 NULL 的异常 active 态
    repo.reapExpiredLeases(now)
    const row = repo.find('s1', 4)!
    expect(row.state).toBe('wanted'); expect(row.attempt).toBe(0)
  })
  it('reapAllActive：未过期租约也被无条件归位（启动回收，单实例前提），attempt 不变', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!                      // 租约刚发，远未过期
    expect(j.state).toBe('searching')
    expect(repo.reapAllActive(now)).toBe(1)
    const row = repo.get(j.id)!
    expect(row.state).toBe('wanted')
    expect(row.attempt).toBe(0)
    expect(row.lease_until).toBeNull()
  })
  it('reapAllActive：覆盖全部活跃态，静止态（wanted/failed/done/dormant）不动', () => {
    const now = Date.now()
    for (const s of ['a', 'b', 'c', 'w', 'f', 'd', 'z']) {
      repo.upsertWanted({ kind: 'series_season', seriesId: s, season: 1 }, now)
    }
    repo.forceState('a', 1, 'searching', now)
    repo.forceState('b', 1, 'downloading', now)
    repo.forceState('c', 1, 'verifying', now)
    // 'w' 留 wanted
    repo.forceState('f', 1, 'failed', now)
    repo.forceState('d', 1, 'done', now)
    repo.forceState('z', 1, 'dormant', now)
    expect(repo.reapAllActive(now)).toBe(3)
    for (const s of ['a', 'b', 'c']) expect(repo.find(s, 1)!.state).toBe('wanted')
    expect(repo.find('a', 1)!.attempt).toBe(0)          // reap 不占内容退避梯名额
    expect(repo.find('w', 1)!.state).toBe('wanted')
    expect(repo.find('w', 1)!.attempt).toBe(0)          // 本就 wanted 的不被 attempt+1
    expect(repo.find('f', 1)!.state).toBe('failed')
    expect(repo.find('d', 1)!.state).toBe('done')
    expect(repo.find('z', 1)!.state).toBe('dormant')
  })
  it('FIX-1: reapOrphaned 只回收 active 且不在调用方给出的 trackedIds 里的行，attempt 不变', () => {
    // 派发饥饿审计修正：daemon 每 tick 该拿"本进程当前正跟踪"的 id 集合去核对——单实例
    // 前提下，active 态但 id 不在这个集合里的行定义上就是孤儿（同 reapAllActive 的论证），
    // 不必等 30min 租约到期。trackedIds 里的 id（真正 inflight）必须被放过。
    const now = Date.now()
    for (const s of ['tracked', 'orphan1', 'orphan2', 'idle']) {
      repo.upsertWanted({ kind: 'series_season', seriesId: s, season: 1 }, now)
    }
    const tracked = repo.claimNext(now)! // 'tracked' — series 优先级/created_at 顺序决定先领到谁，逐个 claim 更明确
    const orphan1 = repo.forceClaim('orphan1', 1, now)!
    const orphan2 = repo.forceClaim('orphan2', 1, now)!
    // 'idle' 留 wanted 不动

    expect(tracked.lease_until).toBeGreaterThan(now) // 租约合法未过期
    expect(orphan1.lease_until).toBeGreaterThan(now)

    const reaped = repo.reapOrphaned([tracked.id], now)

    const reapedIds = reaped.map(r => r.id).sort()
    expect(reapedIds).toEqual([orphan1.id, orphan2.id].sort())

    expect(repo.get(tracked.id)!.state).toBe('searching') // 被跟踪的不动
    expect(repo.get(tracked.id)!.lease_until).toBe(tracked.lease_until)

    expect(repo.get(orphan1.id)!.state).toBe('wanted') // 孤儿被回收
    expect(repo.get(orphan1.id)!.lease_until).toBeNull()
    expect(repo.get(orphan1.id)!.attempt).toBe(0) // reap 不占内容退避梯名额
    expect(repo.get(orphan2.id)!.state).toBe('wanted')

    expect(repo.find('idle', 1)!.state).toBe('wanted') // 静止态不受影响
  })
  it('FIX-1: reapOrphaned 在 trackedIds 为空时回收全部 active 行（同 reapAllActive 语义）', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const j = repo.claimNext(now)!
    expect(repo.reapOrphaned([], now).map(r => r.id)).toEqual([j.id])
    expect(repo.get(j.id)!.state).toBe('wanted')
  })
  it('心跳续租（renewLease）：仅对活跃态生效，续租后不会被 reapExpiredLeases 回收', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    // 快到期前续租
    repo.renewLease(j.id, now + 29 * 60_000)
    // 原 30min 大限已过，但续租后新租约还没到期——不该被 reap
    repo.reapExpiredLeases(now + 31 * 60_000)
    expect(repo.get(j.id)!.state).toBe('searching')
  })
  it('心跳续租对非活跃态（如 done）是 no-op', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    repo.completeDone(j.id, now)
    repo.renewLease(j.id, now)
    expect(repo.get(j.id)!.state).toBe('done')
    expect(repo.get(j.id)!.lease_until).toBeNull()
  })
  it('FIX-2: renewLease 返回新写入的 lease_until（no-op 时返回 null）——供 daemon 把值同步回它持有的 Job 对象引用', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    const renewed = repo.renewLease(j.id, now + 1000)
    expect(renewed).toBe(repo.get(j.id)!.lease_until)
    expect(renewed).toBeGreaterThan(j.lease_until!)

    repo.completeDone(j.id, now)
    expect(repo.renewLease(j.id, now)).toBeNull() // 非活跃态 no-op
  })
  it('内容性失败指数退避：四次分别落 1/2/4/8 天，第 5 次才 dormant', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    for (let i = 0; i < CONTENT_BACKOFF_DAYS.length; i++) {
      const j = repo.forceClaim('s1', 4, t0)!           // 测试助手：无视 next_retry_at 领取
      expect(repo.completeNoMatch(j.id, t0)).toBe(true)
      const row = repo.get(j.id)!
      expect(row.state).toBe('failed')
      expect(row.attempt).toBe(i + 1)
      const expected = t0 + CONTENT_BACKOFF_DAYS[i] * 86_400_000
      expect(row.next_retry_at).toBeGreaterThanOrEqual(expected - 1000)
      expect(row.next_retry_at).toBeLessThanOrEqual(expected + 1000)
    }
    // 第 5 次内容性失败 → dormant
    const j5 = repo.forceClaim('s1', 4, t0)!
    expect(repo.completeNoMatch(j5.id, t0)).toBe(true)
    const final = repo.get(j5.id)!
    expect(final.state).toBe('dormant')
    expect(final.attempt).toBe(5)
    expect(final.next_retry_at).toBeNull()
  })
  it('错误性失败短退避且与内容性分流', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now())!
    repo.completeError(j.id, 'ASSRT 500', Date.now())
    const row = repo.get(j.id)!
    expect(row.state).toBe('failed')
    expect(row.next_retry_at! - Date.now()).toBeLessThanOrEqual(errorBackoffMs(1) + 1000)
  })
  it('错误退避阶梯激进：第 1 次 30s 后可重领，第 5+ 次 15min 封顶', () => {
    // 双轨速率差是有意的：网络类错误快重试到好，内容类失败按天退避
    expect(ERROR_BACKOFF_MS).toEqual([30_000, 60_000, 120_000, 300_000])
    expect(errorBackoffMs(5)).toBe(900_000)
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    repo.completeError(j.id, 'ASSRT 500', t0)
    expect(repo.get(j.id)!.next_retry_at).toBe(t0 + 30_000)
    expect(repo.claimNext(t0 + 29_000)).toBeNull()          // 30s 内不可领
    expect(repo.claimNext(t0 + 30_000)?.id).toBe(j.id)      // 30s 后可重领
    // 冲到第 5 次错误：封顶 15 分钟
    for (let i = 2; i <= 5; i++) {
      repo.completeError(j.id, 'ASSRT 500', t0)
      if (i < 5) repo.forceClaim('s1', 4, t0)
    }
    expect(repo.get(j.id)!.next_retry_at).toBe(t0 + 900_000)
  })
  it('1b 瞬时给-up 界：error_attempt 超过 ERROR_GIVEUP_THRESHOLD 后阶梯升级为每天一次，不再永远撞 15min 封顶', () => {
    // 根因：15min 封顶意味着无穷重试的瞬时错误会一天烧 96 次完整 identify+plan+search+/download
    // 的 Jellyfin/TMDB/provider 调用。ERROR_GIVEUP_THRESHOLD=20（≈20 * 15min = 5h 的持续失败后）
    // 升级为每天一次，仍保持 failed 可重试——绝不转 30 天 dormant（那是内容轨的专属结局）。
    expect(errorBackoffMs(ERROR_GIVEUP_THRESHOLD)).toBe(900_000) // 恰好等于阈值：仍在短退避封顶
    expect(errorBackoffMs(ERROR_GIVEUP_THRESHOLD + 1)).toBe(ERROR_BACKOFF_DAILY_MS) // 超过阈值：升级每天
    expect(errorBackoffMs(99)).toBe(ERROR_BACKOFF_DAILY_MS)
    expect(ERROR_BACKOFF_DAILY_MS).toBe(86_400_000)
  })
  it('1b: completeError 连续调用超过 ERROR_GIVEUP_THRESHOLD 次后 next_retry_at 变每天一次，state 仍是 failed（绝不 dormant）', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    let j = repo.claimNext(t0)!
    for (let i = 0; i < ERROR_GIVEUP_THRESHOLD; i++) {
      repo.completeError(j.id, 'timeout', t0)
      j = repo.forceClaim('s1', 4, t0)!
    }
    expect(repo.get(j.id)!.error_attempt).toBe(ERROR_GIVEUP_THRESHOLD)
    expect(repo.get(j.id)!.next_retry_at).toBe(t0 + 900_000) // 恰好在阈值：仍是短退避封顶

    // 再来一次，跨过阈值
    repo.completeError(j.id, 'timeout', t0)
    const row = repo.get(j.id)!
    expect(row.error_attempt).toBe(ERROR_GIVEUP_THRESHOLD + 1)
    expect(row.state).toBe('failed') // 绝不转 dormant——transient 永远保持可重试
    expect(row.next_retry_at).toBe(t0 + ERROR_BACKOFF_DAILY_MS)

    // 继续再来几十次，仍然是 failed + 每天一次，不会像内容轨一样有"第 N 次进 dormant"的悬崖
    for (let i = 0; i < 30; i++) {
      const claimed = repo.forceClaim('s1', 4, t0)!
      repo.completeError(claimed.id, 'timeout', t0)
    }
    const finalRow = repo.get(j.id)!
    expect(finalRow.state).toBe('failed')
    expect(finalRow.next_retry_at).toBe(t0 + ERROR_BACKOFF_DAILY_MS)
  })
  it('1b: 给-up 升级后一旦 job 成功翻篇（done→wanted 复活），error_attempt 归零，回到 30s 起步', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    let j = repo.claimNext(t0)!
    for (let i = 0; i <= ERROR_GIVEUP_THRESHOLD; i++) {
      repo.completeError(j.id, 'timeout', t0)
      j = repo.forceClaim('s1', 4, t0)!
    }
    expect(repo.get(j.id)!.error_attempt).toBeGreaterThan(ERROR_GIVEUP_THRESHOLD)

    repo.completeDone(j.id, t0)
    mkSeriesJob(t0) // 该季重新出现 missing → done→wanted 复活，两条计数器一并归零
    expect(repo.get(j.id)!.error_attempt).toBe(0)

    // 复活后第一次瞬时错误重新从 30s 起步，不再是每天一次
    const revived = repo.claimNext(t0)!
    repo.completeError(revived.id, 'timeout', t0)
    expect(repo.get(revived.id)!.next_retry_at).toBe(t0 + 30_000)
  })
  it('配额耗尽退避（quota_exhausted resetAt）：next_retry_at 对齐 resetAt+margin，不走盲阶梯', () => {
    // 根因：OS 20/日配额耗尽后，若还是走 ERROR_BACKOFF_MS 封顶 15min 的阶梯，job 会在
    // 配额于 UTC 重置前一直每 15min 重打一次 identify+plan+search+/download，白烧 LLM/search 配额。
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    const resetAt = new Date(t0 + 3 * 3_600_000).toISOString() // 3h 后重置
    repo.completeError(j.id, 'opensubtitles download quota exhausted', t0, resetAt)
    const row = repo.get(j.id)!
    expect(row.state).toBe('failed')
    expect(row.next_retry_at).toBe(Date.parse(resetAt) + QUOTA_RESET_MARGIN_MS)
    // 远大于短退避阶梯封顶(15min)，证明确实没有走 ERROR_BACKOFF_MS
    expect(row.next_retry_at!).toBeGreaterThan(t0 + 900_000)
  })
  it('配额 resetAt 缺失（undefined）→ 落回默认错误退避阶梯，行为与调用方不传第 4 参一致', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    repo.completeError(j.id, 'network blip', t0, undefined)
    expect(repo.get(j.id)!.next_retry_at).toBe(t0 + errorBackoffMs(1))
  })
  it('配额 resetAt 是过去时间（已过期/时钟偏差）→ 落回默认阶梯，不把 job 判"未来"', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    const pastResetAt = new Date(t0 - 60_000).toISOString()
    repo.completeError(j.id, 'opensubtitles download quota exhausted', t0, pastResetAt)
    expect(repo.get(j.id)!.next_retry_at).toBe(t0 + errorBackoffMs(1))
  })
  it('配额 resetAt 是无法解析的乱码字符串 → 落回默认阶梯，job 不会被永久搁置', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    repo.completeError(j.id, 'opensubtitles download quota exhausted', t0, 'not-a-date')
    expect(repo.get(j.id)!.next_retry_at).toBe(t0 + errorBackoffMs(1))
  })
  it('部分成功节流（I6）：30s 内 claimNext 拿不到，窗口过后可领', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    repo.completePartial(j.id, now)
    expect(repo.get(j.id)!.state).toBe('wanted')
    expect(repo.claimNext(now)).toBeNull()                       // 立即重领被节流
    expect(repo.claimNext(now + PARTIAL_RETRY_MS)?.id).toBe(j.id) // 窗口过后可领
  })
  it('IMPORTANT-2: 配额停车（completeError 带有效 quotaResetAt）不占瞬时错误梯——error_attempt 不变，同 reap* 语义', () => {
    // 根因（历史，已由独立 error_attempt 列根治）：completeError 曾无条件把 attempt+1，
    // 与内容轨共用一个计数器，配额停车会悄悄推高它，后面一次真正的 no_safe_match 就会
    // 越级跳到 30 天 dormant。现在 completeError 只读写 error_attempt，配额停车同样不该
    // 推高它——否则配额一天多次停车会误触发 give-up 阈值升级到每天一次。
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    expect(j.attempt).toBe(0)
    expect(j.error_attempt).toBe(0)
    const resetAt = new Date(t0 + 3 * 3_600_000).toISOString()
    repo.completeError(j.id, 'opensubtitles download quota exhausted', t0, resetAt)
    const row = repo.get(j.id)!
    expect(row.state).toBe('failed')
    expect(row.attempt).toBe(0) // 内容计数器：completeError 从不触碰
    expect(row.error_attempt).toBe(0) // 配额停车：error_attempt 不变
    expect(row.next_retry_at).toBe(Date.parse(resetAt) + QUOTA_RESET_MARGIN_MS)
  })
  it('双轨分流：completeError 只充 error_attempt，从不触碰内容计数器 attempt', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    repo.completeError(j.id, 'ASSRT 500', t0)
    const row = repo.get(j.id)!
    expect(row.error_attempt).toBe(1)
    expect(row.attempt).toBe(0) // 内容计数器纹丝不动——两条轨彻底独立
  })
  it('双轨分流：resetAt 无效（过去时间）时不算配额停车——落回默认阶梯，error_attempt 照常+1，attempt 仍不动', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    const pastResetAt = new Date(t0 - 60_000).toISOString()
    repo.completeError(j.id, 'opensubtitles download quota exhausted', t0, pastResetAt)
    const row = repo.get(j.id)!
    expect(row.error_attempt).toBe(1)
    expect(row.attempt).toBe(0)
  })
  it('双轨分流：completeNoMatch 只充内容计数器 attempt，从不触碰 error_attempt', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    repo.completeNoMatch(j.id, t0)
    const row = repo.get(j.id)!
    expect(row.attempt).toBe(1)
    expect(row.error_attempt).toBe(0)
  })
  it('双轨分流：先攒瞬时错误再遇到内容失败——attempt 只算内容失败次数，不被瞬时错误历史污染（根治本次审计的核心 bug）', () => {
    // 审计场景：一串瞬时错误（网络抖动）不该让紧接着的第一次真正 no_safe_match 就越级跳档。
    const t0 = Date.now()
    mkSeriesJob(t0)
    let j = repo.claimNext(t0)!
    repo.completeError(j.id, 'timeout 1', t0)
    j = repo.forceClaim('s1', 4, t0)!
    repo.completeError(j.id, 'timeout 2', t0)
    j = repo.forceClaim('s1', 4, t0)!
    repo.completeError(j.id, 'timeout 3', t0)
    expect(repo.get(j.id)!.error_attempt).toBe(3)
    expect(repo.get(j.id)!.attempt).toBe(0) // 三次瞬时错误，内容计数器仍是 0

    j = repo.forceClaim('s1', 4, t0)!
    repo.completeNoMatch(j.id, t0) // 第一次真正的内容失败
    const row = repo.get(j.id)!
    expect(row.attempt).toBe(1) // 走 1 天梯的第一档，而不是被污染跳到更后面
    expect(row.state).toBe('failed')
    expect(row.next_retry_at).toBeGreaterThanOrEqual(t0 + 1 * 86_400_000 - 1000)
    expect(row.next_retry_at).toBeLessThanOrEqual(t0 + 1 * 86_400_000 + 1000)
  })
  it('双轨分流：completePartial 只减内容计数器 attempt，从不触碰 error_attempt', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    let j = repo.claimNext(t0)!
    repo.completeError(j.id, 'timeout', t0) // error_attempt=1
    j = repo.forceClaim('s1', 4, t0)!
    repo.completeNoMatch(j.id, t0) // attempt=1
    j = repo.forceClaim('s1', 4, t0)!
    repo.completePartial(j.id, t0)
    const row = repo.get(j.id)!
    expect(row.attempt).toBe(0) // 1 - 1
    expect(row.error_attempt).toBe(1) // completePartial 不碰瞬时错误计数器
  })
  it('done→wanted 复活（I2 扩展）：error_attempt 与 attempt 一并归零，成功即翻篇', () => {
    const now = Date.now()
    mkSeriesJob(now)
    let j = repo.claimNext(now)!
    repo.completeError(j.id, 'timeout', now) // error_attempt=1，job 仍 failed
    j = repo.forceClaim('s1', 4, now)!
    repo.completeDone(j.id, now)
    mkSeriesJob(now) // 该季重新出现 missing → upsertWanted 的 done→wanted 复活
    const revived = repo.get(j.id)!
    expect(revived.state).toBe('wanted')
    expect(revived.attempt).toBe(0)
    expect(revived.error_attempt).toBe(0)
  })
  it('IMPORTANT-1a: completePartial 携带有效 quotaResetAt 时按 resetAt+margin 排期，不走盲的 30 秒节流', () => {
    // 季包/季横扫中途撞配额耗尽、已有 ≥1 集覆盖时，剩余部分不该在配额重置前每 30 秒重打一次全链路。
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    const resetAt = new Date(t0 + 3 * 3_600_000).toISOString()
    repo.completePartial(j.id, t0, resetAt)
    const row = repo.get(j.id)!
    expect(row.state).toBe('wanted')
    expect(row.next_retry_at).toBe(Date.parse(resetAt) + QUOTA_RESET_MARGIN_MS)
  })
  it('IMPORTANT-1a: completePartial 不传 quotaResetAt 时行为不变（盲的 30 秒节流）', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    repo.completePartial(j.id, now)
    expect(repo.get(j.id)!.next_retry_at).toBe(now + PARTIAL_RETRY_MS)
  })
  it('done 复活（I2）：upsertWanted 对 done 行复位 wanted/attempt=0，failed/dormant 不动', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    repo.completeDone(j.id, now)
    mkSeriesJob(now)                                     // 该季重新出现 missing → upsertWanted
    const revived = repo.get(j.id)!
    expect(revived.state).toBe('wanted')
    expect(revived.attempt).toBe(0)
    expect(revived.next_retry_at).toBeNull()
    // failed 不动（保留退避计划）
    const j2 = repo.claimNext(now)!
    repo.completeNoMatch(j2.id, now)
    mkSeriesJob(now)
    const failedRow = repo.get(j2.id)!
    expect(failedRow.state).toBe('failed')
    expect(failedRow.attempt).toBe(1)
    expect(failedRow.next_retry_at).not.toBeNull()
    // dormant 不动（只有 wake 可以复活）
    repo.forceState('s1', 4, 'dormant', now)
    mkSeriesJob(now)
    expect(repo.get(j2.id)!.state).toBe('dormant')
  })
  it('部分成功 attempt 减 1 而非清零（escalation 渐进恢复）', () => {
    const now = Date.now()
    mkSeriesJob(now)
    let j = repo.claimNext(now)!
    repo.completeNoMatch(j.id, now)                    // attempt 1
    j = repo.forceClaim('s1', 4, now)!
    repo.completePartial(j.id, now)                    // attempt 应回 0
    expect(repo.get(j.id)!.attempt).toBe(0)
    expect(repo.get(j.id)!.state).toBe('wanted')       // 部分成功→回 wanted 继续追残集
  })
  it('completeDone 置 done 终态', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now())!
    repo.completeDone(j.id, Date.now())
    expect(repo.get(j.id)!.state).toBe('done')
  })
  it('唤醒 dormant（播放触发语义）', () => {
    const now = Date.now()
    mkSeriesJob(now)
    repo.forceState('s1', 4, 'dormant', now)           // 测试助手
    expect(repo.wake({ kind: 'series_season', seriesId: 's1', season: 4 }, 100, now)).toBe(true)
    const row = repo.find('s1', 4)!
    expect(row.state).toBe('wanted'); expect(row.priority).toBe(100); expect(row.next_retry_at).toBeNull()
  })
  it('状态守卫：对 done 调 completeError 无效果返回 false', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    repo.completeDone(j.id, now)
    expect(repo.completeError(j.id, 'boom', now)).toBe(false)
    const row = repo.get(j.id)!
    expect(row.state).toBe('done')
    expect(row.attempt).toBe(0)
    expect(row.last_error).toBeNull()
  })
  it('状态守卫：complete* 只作用于 active 态（wanted 上调用全部 false）', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.find('s1', 4)!                      // state=wanted，未领取
    expect(repo.completeNoMatch(j.id, now)).toBe(false)
    expect(repo.completePartial(j.id, now)).toBe(false)
    expect(repo.completeDone(j.id, now)).toBe(false)
    expect(repo.get(j.id)!.state).toBe('wanted')
  })
  it('状态守卫：wake 只唤醒 dormant，对 searching 无效果', () => {
    const now = Date.now()
    mkSeriesJob(now)
    repo.claimNext(now)
    expect(repo.wake({ kind: 'series_season', seriesId: 's1', season: 4 }, 100, now)).toBe(false)
    const row = repo.find('s1', 4)!
    expect(row.state).toBe('searching'); expect(row.priority).toBe(0)
  })

  describe('retire (聚合器清理语义)', () => {
    it('retire wanted job → done', () => {
      const now = Date.now()
      mkSeriesJob(now)
      const j = repo.find('s1', 4)!
      expect(repo.retire(j.id, now)).toBe(true)
      expect(repo.get(j.id)!.state).toBe('done')
    })
    it('retire failed job → done', () => {
      const now = Date.now()
      mkSeriesJob(now)
      repo.forceState('s1', 4, 'failed', now)
      const j = repo.find('s1', 4)!
      expect(repo.retire(j.id, now)).toBe(true)
      expect(repo.get(j.id)!.state).toBe('done')
    })
    it('retire 对 active 态无效 (返回 false，状态不变)', () => {
      const now = Date.now()
      mkSeriesJob(now)
      const j = repo.claimNext(now)!                     // state=searching
      expect(repo.retire(j.id, now)).toBe(false)
      expect(repo.get(j.id)!.state).toBe('searching')
    })
    it('retire 对 dormant 无效 (dormant 有自己的复活通道)', () => {
      const now = Date.now()
      mkSeriesJob(now)
      repo.forceState('s1', 4, 'dormant', now)
      const j = repo.find('s1', 4)!
      expect(repo.retire(j.id, now)).toBe(false)
      expect(repo.get(j.id)!.state).toBe('dormant')
    })
    it('retire 对 done 幂等 (已退役则 false)', () => {
      const now = Date.now()
      mkSeriesJob(now)
      repo.forceState('s1', 4, 'done', now)
      const j = repo.find('s1', 4)!
      expect(repo.retire(j.id, now)).toBe(false)
      expect(repo.get(j.id)!.state).toBe('done')
    })
  })
})

describe('realign job kind', () => {
  it('upsertWanted({kind:"realign"}) 建 season=NULL 的 job，claimNext 能正常领取', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)
    expect(job?.kind).toBe('realign')
    expect(job?.series_id).toBe('s1')
    expect(job?.season).toBeNull()
  })

  it('同剧重复 upsertWanted realign 幂等：只有一行', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    expect(repo.countByState('wanted')).toBe(1)
  })

  it('setPlanRef 写入 plan_ref，仅在 active 态生效（同 setJournalRef 语义）', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!
    repo.setPlanRef(job.id, '/archive/s1-123/manifest.json', now)
    expect(repo.get(job.id)!.plan_ref).toBe('/archive/s1-123/manifest.json')
  })

  it('setPlanRef 对非 active 态 job 是 no-op', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!
    repo.completeDone(job.id, now)
    repo.setPlanRef(job.id, '/should/not/write', now)
    expect(repo.get(job.id)!.plan_ref).toBeNull()
  })

  it('retireAllForSeries：把该剧 wanted/failed 的 series_season job 退休为 done，active 态不动', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 2 }, now)
    repo.claimNext(now) // season 1 或 2 变 searching（active，不该被 retire）
    const retired = repo.retireAllForSeries('s1', now)
    expect(retired).toBe(1)
  })

  // D-review #2：retireAllForSeries 的全部意义是"旧排布下的判决作废"——dormant 恰恰是
  // "对着错误排布搜索穷尽"的判决，不退休它，realign 后这一季永远不会被重新搜索。
  it('retireAllForSeries 连 dormant 一起退休，下一轮聚合能重建全新 wanted job', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    repo.forceState('s1', 1, 'dormant', now)               // 旧排布下搜索穷尽的休眠判决
    expect(repo.retireAllForSeries('s1', now)).toBe(1)
    expect(repo.find('s1', 1)!.state).toBe('done')
    // realign 后新一轮 scan/aggregate 重新 upsert → done→wanted 复活，attempt 归零，重新可搜
    repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now + 1)
    const revived = repo.find('s1', 1)!
    expect(revived.state).toBe('wanted')
    expect(revived.attempt).toBe(0)
  })

  // D-review #1：UPSERT_CONFLICT_SQL 曾无条件 plan_ref = excluded.plan_ref——upsertWanted 的
  // INSERT 恒带 NULL，执行中/失败态 job 的崩溃恢复清单指针会被一次 re-upsert 直接抹掉。
  it('mid-execution re-upsert 不清洗 active job 的 plan_ref（崩溃恢复清单指针）', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!                                  // searching（active）
    repo.setPlanRef(job.id, '/archive/s1-1/manifest.json', now)
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now + 1)   // 诊断钩子再次触发同剧 upsert
    expect(repo.get(job.id)!.plan_ref).toBe('/archive/s1-1/manifest.json')
  })

  it('failed 静止态 re-upsert 同样保留 plan_ref（中断整理的清单仍要用于恢复/回滚）', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!
    repo.setPlanRef(job.id, '/archive/s1-1/manifest.json', now)
    repo.completeError(job.id, 'EXDEV', now)                          // → failed
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now + 1)
    expect(repo.get(job.id)!.plan_ref).toBe('/archive/s1-1/manifest.json')
  })

  it('done→wanted 复活时 plan_ref 重置（新一轮整理不该带上一轮的旧清单）', () => {
    const now = Date.now()
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
    const job = repo.claimNext(now)!
    repo.setPlanRef(job.id, '/archive/s1-1/manifest.json', now)
    repo.completeDone(job.id, now)                                    // → done（plan_ref 仍在）
    repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now + 1)   // done→wanted 复活
    const revived = repo.get(job.id)!
    expect(revived.state).toBe('wanted')
    expect(revived.plan_ref).toBeNull()
  })

  // D-review #3：executeRealign 未接线的 realign job 曾走 completeError → 30s→15min→daily
  // 无穷 errorloop。park 提供"停车不重试"的诚实出口：active → dormant（不参与 claimNext，
  // 唤醒通道 wake 仍可用）。
  describe('park（停车：active → dormant，不重试）', () => {
    it('active job 停车为 dormant，claimNext 不再派发（含一天后）', () => {
      const now = Date.now()
      repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
      const job = repo.claimNext(now)!
      expect(repo.park(job.id, 'realign executor not wired', now)).toBe(true)
      const parked = repo.get(job.id)!
      expect(parked.state).toBe('dormant')
      expect(parked.last_error).toBe('realign executor not wired')
      expect(parked.lease_until).toBeNull()
      expect(parked.next_retry_at).toBeNull()
      expect(repo.claimNext(now + 25 * 3_600_000)).toBeNull()
    })

    it('对非 active 态是 no-op（同 complete* 守卫语义）', () => {
      const now = Date.now()
      repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
      const job = repo.claimNext(now)!
      repo.completeDone(job.id, now)
      expect(repo.park(job.id, 'x', now)).toBe(false)
      expect(repo.get(job.id)!.state).toBe('done')
    })

    it('停车的 job 仍可被 wake 唤醒（不是死刑，是停车）', () => {
      const now = Date.now()
      repo.upsertWanted({ kind: 'realign', seriesId: 's1' }, now)
      const job = repo.claimNext(now)!
      repo.park(job.id, 'not wired', now)
      expect(repo.wake({ kind: 'realign', seriesId: 's1' }, 100, now)).toBe(true)
      expect(repo.get(job.id)!.state).toBe('wanted')
    })
  })
})
