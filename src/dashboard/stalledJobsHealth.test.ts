// src/dashboard/stalledJobsHealth.test.ts —— 🔴-4「该被重试却再也没人管的活」。
//
// 生产事实（2026-08-13）：2 行 `state='failed'`，`next_retry_at` 过期 66 小时，
// 而 jobs 队列已无认领者（claimNext 生产零调用点）。此前界面上一个字都没有。
//
// 本文件要钉的核心不是"这两行能被查出来"，而是**判据的形态**：
//  · 它是**行为谓词**（该动而没动），不是断言（"队列退役了"）——队列被接回 claim 之后
//    这一段必须自动消失。那条用例（「被领走之后就查不到了」）是本文件最重要的一条。
//  · 它是 `claimNext` 取件谓词的**真子集**——不会误报还在正常退避里的活。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { buildStalledJobs, JOB_STALLED_AFTER_MS } from './stalledJobsHealth.js'
import { JobsRepo } from '../v2/jobsRepo.js'

let db: ScoutDb
const NOW = 1_700_000_000_000
const HOUR = 3_600_000

beforeEach(() => { db = openDb(':memory:') })

/** 直接写一行 jobs（绕开 JobsRepo 的状态机——本文件测的是**读**侧的判据）。 */
function seedJob(o: { state: string; nextRetryAt: number | null; id?: number }): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, next_retry_at, created_at, updated_at)
       VALUES ('worker_task', ?, ?, ?, ?, ?, ?)`,
    )
    .run(`tmdb:${o.id ?? Math.floor(Math.random() * 1e6)}`,
      JSON.stringify({ taskType: 'find_subtitle' }), o.state, o.nextRetryAt, NOW, NOW)
  return Number(info.lastInsertRowid)
}

describe('buildStalledJobs', () => {
  it('🔴 生产形态：2 条 failed、过期 66 小时 → count=2，overdueMs 报**最久**那条', () => {
    seedJob({ state: 'failed', nextRetryAt: NOW - 66 * HOUR })
    seedJob({ state: 'failed', nextRetryAt: NOW - 60 * HOUR })
    const dto = buildStalledJobs(db, NOW)
    expect(dto.count).toBe(2)
    expect(dto.overdueMs).toBe(66 * HOUR)
  })

  it('🔴🔴 **被领走之后就查不到了**——这一段的诚实性由行为保证，不由常量保证', () => {
    // 本文件最要紧的一条。若判据被写成"队列退役了"这个断言（硬编码），队列接回 claim
    // 之后这一段会继续报警，而那时它已经是一句假话，且没有任何用例会红。
    // 这里走**真实的 claimNext**：它把行改成 'searching' + 清 next_retry_at，
    // 于是本函数的谓词自然落空。
    seedJob({ state: 'failed', nextRetryAt: NOW - 66 * HOUR })
    expect(buildStalledJobs(db, NOW).count).toBe(1)   // 前置条件，否则本用例是空转的假绿

    const claimed = new JobsRepo(db).claimNext(NOW)
    expect(claimed).not.toBeNull()                     // claim 真的发生了
    expect(buildStalledJobs(db, NOW)).toEqual({ count: 0, overdueMs: null })
  })

  it('🔴 还在**正常退避**里的活不算（这就是字幕台那 33 个文件的处境，不许被说成停摆）', () => {
    seedJob({ state: 'failed', nextRetryAt: NOW + 16 * HOUR })
    expect(buildStalledJobs(db, NOW)).toEqual({ count: 0, overdueMs: null })
  })

  it('🔴 刚到点、还没超过容差的活不算（繁忙队列不许被报成停摆）', () => {
    // 派发有节奏，一件长活跑着时后面的活就是会排队。1× 门下这会周期性误报。
    seedJob({ state: 'failed', nextRetryAt: NOW - 1 })
    expect(buildStalledJobs(db, NOW).count).toBe(0)
    // 边界的另一侧：刚过容差 → 算
    seedJob({ state: 'failed', nextRetryAt: NOW - JOB_STALLED_AFTER_MS - 1 })
    expect(buildStalledJobs(db, NOW).count).toBe(1)
  })

  it('边界：恰好等于容差 → 算（谓词是 <=，与 claimNext 的 <= 同向）', () => {
    seedJob({ state: 'failed', nextRetryAt: NOW - JOB_STALLED_AFTER_MS })
    expect(buildStalledJobs(db, NOW).count).toBe(1)
  })

  it("🔴 wanted 也算（两态与 claimNext 同形——'该被领走'与状态叫什么无关）", () => {
    seedJob({ state: 'wanted', nextRetryAt: NOW - 66 * HOUR })
    expect(buildStalledJobs(db, NOW).count).toBe(1)
  })

  it('🔴 活跃态 / done / dormant 一律不算（它们不在 claimNext 的取件面上）', () => {
    for (const st of ['searching', 'downloading', 'verifying', 'done', 'dormant']) {
      seedJob({ state: st, nextRetryAt: NOW - 66 * HOUR })
    }
    expect(buildStalledJobs(db, NOW)).toEqual({ count: 0, overdueMs: null })
    // 阳性对照：同样过期的 failed 行是能被查到的（否则这条是恒真的空断言）
    seedJob({ state: 'failed', nextRetryAt: NOW - 66 * HOUR })
    expect(buildStalledJobs(db, NOW).count).toBe(1)
  })

  it('🔴 next_retry_at IS NULL 的行**不算**（刚 redispatch 写进来的，没有"过期多久"可言）', () => {
    // 算的话，用户每按一次 redispatch 就当场收到一句"有活停摆了"——把冷启动误报成故障。
    // 代价（那行确实永远不会被领走）如实记在 stalledJobsHealth.ts 的注释与报告里。
    seedJob({ state: 'wanted', nextRetryAt: null })
    expect(buildStalledJobs(db, NOW)).toEqual({ count: 0, overdueMs: null })
  })

  it('空表 → count=0 / overdueMs=null（**不是** 0——"没有这回事"与"过期 0 毫秒"是两件事）', () => {
    expect(buildStalledJobs(db, NOW)).toEqual({ count: 0, overdueMs: null })
  })

  it('表读不了 → 空态而不抛（这一段挂掉不许把整个 /health 带走）', () => {
    db.exec('DROP TABLE jobs')
    expect(() => buildStalledJobs(db, NOW)).not.toThrow()
    expect(buildStalledJobs(db, NOW)).toEqual({ count: 0, overdueMs: null })
  })

  it('时钟回拨（now 早于 next_retry_at）不产生负数读数', () => {
    seedJob({ state: 'failed', nextRetryAt: NOW - 66 * HOUR })
    const dto = buildStalledJobs(db, NOW - 100 * HOUR)
    expect(dto.overdueMs === null || dto.overdueMs >= 0).toBe(true)
  })
})
