import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo, CONTENT_BACKOFF_DAYS, errorBackoffMs } from './jobsRepo.js'

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
  it('过租 job 被 reap 归位 wanted 且 attempt+1', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now())!
    repo.reapExpiredLeases(Date.now() + 31 * 60_000)
    const again = repo.claimNext(Date.now() + 31 * 60_000)
    expect(again?.id).toBe(j.id); expect(again?.attempt).toBe(1)
  })
  it('active 态无租约（异常）也被 reap 归位', () => {
    const now = Date.now()
    mkSeriesJob(now)
    repo.forceState('s1', 4, 'searching', now)         // lease_until 为 NULL 的异常 active 态
    repo.reapExpiredLeases(now)
    const row = repo.find('s1', 4)!
    expect(row.state).toBe('wanted'); expect(row.attempt).toBe(1)
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
})
