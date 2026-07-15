import { describe, it, expect, vi } from 'vitest'
import { routeLegacyJob, tombstoneLegacyJob, type LegacyJobKind } from './legacyJobRouting.js'

describe('routeLegacyJob (W0-4 切 feed 路由决策)', () => {
  it('series_season → tombstone', () => {
    expect(routeLegacyJob('series_season')).toBe('tombstone')
  })
  it('movie → tombstone', () => {
    expect(routeLegacyJob('movie')).toBe('tombstone')
  })
  it('realign → execute-realign（保留机械，走老 executor.ts 的 executeRealignBranch）', () => {
    expect(routeLegacyJob('realign')).toBe('execute-realign')
  })
  it('穷尽 LegacyJobKind 的三个变体，逐一核验（防止未来新增变体漏分支）', () => {
    const kinds: LegacyJobKind[] = ['series_season', 'movie', 'realign']
    const results = kinds.map(routeLegacyJob)
    expect(results).toEqual(['tombstone', 'tombstone', 'execute-realign'])
  })
})

describe('tombstoneLegacyJob (W0-4 存量墓碑)', () => {
  it('series_season job → retireClaimed 被调用 + 记一行 retired log，不抛错', () => {
    const jobs = { retireClaimed: vi.fn(() => true) }
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)
    const job = { id: 42, kind: 'series_season' as const }

    expect(() => tombstoneLegacyJob(job, jobs, log, 1000)).not.toThrow()

    expect(jobs.retireClaimed).toHaveBeenCalledWith(42, 1000)
    expect(logs.some(l => l.includes('retired legacy series_season job 42'))).toBe(true)
    // 成功转移时不该额外打 stale-lease warn
    expect(logs.some(l => l.includes('stale lease'))).toBe(false)
  })

  it('movie job → 同样 retireClaimed + retired log，不抛错', () => {
    const jobs = { retireClaimed: vi.fn(() => true) }
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)
    const job = { id: 7, kind: 'movie' as const }

    expect(() => tombstoneLegacyJob(job, jobs, log, 2000)).not.toThrow()

    expect(jobs.retireClaimed).toHaveBeenCalledWith(7, 2000)
    expect(logs.some(l => l.includes('retired legacy movie job 7'))).toBe(true)
  })

  it('retireClaimed 返回 false（stale lease，如已被并发 reap）时额外打 warn，仍不抛错', () => {
    const jobs = { retireClaimed: vi.fn(() => false) }
    const logs: string[] = []
    const log = (msg: string) => logs.push(msg)
    const job = { id: 99, kind: 'series_season' as const }

    expect(() => tombstoneLegacyJob(job, jobs, log, 3000)).not.toThrow()

    expect(logs.some(l => l.includes('retired legacy series_season job 99'))).toBe(true)
    expect(logs.some(l => l.includes('warn: job 99') && l.includes('stale lease'))).toBe(true)
  })
})
