import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo, CONTENT_BACKOFF_DAYS, ERROR_BACKOFF_MS, errorBackoffMs, PARTIAL_RETRY_MS } from './jobsRepo.js'

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
    expect(errorBackoffMs(99)).toBe(900_000)
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
  it('部分成功节流（I6）：30s 内 claimNext 拿不到，窗口过后可领', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = repo.claimNext(now)!
    repo.completePartial(j.id, now)
    expect(repo.get(j.id)!.state).toBe('wanted')
    expect(repo.claimNext(now)).toBeNull()                       // 立即重领被节流
    expect(repo.claimNext(now + PARTIAL_RETRY_MS)?.id).toBe(j.id) // 窗口过后可领
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
