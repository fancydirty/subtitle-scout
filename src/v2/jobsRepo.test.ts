import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { JobsRepo, CONTENT_BACKOFF_DAYS, errorBackoffMs } from './jobsRepo.js'

let repo: JobsRepo
beforeEach(() => { repo = new JobsRepo(openDb(':memory:')) })
const mkSeriesJob = () => repo.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 4 })

describe('jobs 状态机', () => {
  it('upsertWanted 幂等：同剧同季只有一行', () => {
    mkSeriesJob(); mkSeriesJob()
    expect(repo.countByState('wanted')).toBe(1)
  })
  it('claimNext 原子领取：置 searching+租约，二次领取拿不到同一 job', () => {
    mkSeriesJob()
    const a = repo.claimNext(Date.now(), 'w1')
    expect(a?.state).toBe('searching')
    expect(repo.claimNext(Date.now(), 'w2')).toBeNull()
  })
  it('优先级高者先领', () => {
    mkSeriesJob()
    repo.upsertWanted({ kind: 'movie', movieId: 'm1' }); repo.boostPriority({ kind: 'movie', movieId: 'm1' }, 100)
    expect(repo.claimNext(Date.now(), 'w')?.movie_id).toBe('m1')
  })
  it('过租 job 被 reap 归位 wanted 且 attempt+1', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now(), 'w')!
    repo.reapExpiredLeases(Date.now() + 31 * 60_000)
    const again = repo.claimNext(Date.now() + 31 * 60_000, 'w')
    expect(again?.id).toBe(j.id); expect(again?.attempt).toBe(1)
  })
  it('内容性失败指数退避：1/2/4/8 天后 dormant', () => {
    mkSeriesJob()
    for (const days of CONTENT_BACKOFF_DAYS) {
      const j = repo.claimNext(Date.now(), 'w') ?? repo.forceClaim('s1', 4)  // 测试助手：无视 next_retry_at 领取
      repo.completeNoMatch(j!.id, Date.now())
      const row = repo.get(j!.id)!
      if (row.state === 'dormant') break
      expect(row.state).toBe('failed')
      expect(row.next_retry_at! - Date.now()).toBeGreaterThanOrEqual(days * 86_400_000 - 1000)
    }
    expect(repo.get(repo.find('s1', 4)!.id)!.state).toBe('dormant')
  })
  it('错误性失败短退避且与内容性分流', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now(), 'w')!
    repo.completeError(j.id, 'ASSRT 500', Date.now())
    const row = repo.get(j.id)!
    expect(row.state).toBe('failed')
    expect(row.next_retry_at! - Date.now()).toBeLessThanOrEqual(errorBackoffMs(1) + 1000)
  })
  it('部分成功 attempt 减 1 而非清零（escalation 渐进恢复）', () => {
    mkSeriesJob()
    let j = repo.claimNext(Date.now(), 'w')!
    repo.completeNoMatch(j.id, Date.now())            // attempt 1
    j = repo.forceClaim('s1', 4)!
    repo.completePartial(j.id, Date.now())            // attempt 应回 0
    expect(repo.get(j.id)!.attempt).toBe(0)
    expect(repo.get(j.id)!.state).toBe('wanted')      // 部分成功→回 wanted 继续追残集
  })
  it('completeDone 置 done 终态', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now(), 'w')!
    repo.completeDone(j.id, Date.now())
    expect(repo.get(j.id)!.state).toBe('done')
  })
  it('唤醒 dormant（播放触发语义）', () => {
    mkSeriesJob()
    repo.forceState('s1', 4, 'dormant')               // 测试助手
    repo.wake({ kind: 'series_season', seriesId: 's1', season: 4 }, 100)
    const row = repo.find('s1', 4)!
    expect(row.state).toBe('wanted'); expect(row.priority).toBe(100); expect(row.next_retry_at).toBeNull()
  })
})
