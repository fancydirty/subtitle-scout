import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { JobsRepo, type Job, ERROR_BACKOFF_MS, errorBackoffMs, heldBackoffMs, ERROR_GIVEUP_THRESHOLD, ERROR_BACKOFF_DAILY_MS } from './jobsRepo.js'

let db: ScoutDb
let repo: JobsRepo
beforeEach(() => { db = openDb(':memory:'); repo = new JobsRepo(db) })

// 清算波 R-6（A-F8）：jobsRepo.upsertWanted/find/findMovie/boostPriority/wake/completeNoMatch/
// completePartial/retire（连同 JobIdent 联合类型）已随死器官处决——production 已零调用点（旧
// series_season/movie/realign 三个旧 kind 的创建/查询/优先级/唤醒通路，以及旧管线内容退避梯，
// 全部随 Wave 2A/2D 和去 Jellyfin 化 T4 死绝，见 jobsRepo.ts 头部注释存档）。这个 describe 块
// 真正验证的是 claimNext/reap*/renewLease/completeDone/completeError/park/retireClaimed 这些
// kind 无关的通用状态机方法——过去只是借 upsertWanted/find 的 series_season 变体当一个方便的
// 造行/读回手段。下面两个本地 helper 直接对 db 做原生 SQL，逐字复刻 upsertWanted 已删除的
// series_season 分支（含 ON CONFLICT 的 done→wanted 复活语义——部分测试依赖同一 identity 重复
// 造行时复活同一行，而不是撞唯一索引），不引入任何新行为。
const UPSERT_CONFLICT_SQL = `
         ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''), ifnull(json_extract(payload,'$.taskType'),''))
         DO UPDATE SET
           updated_at = ?,
           state = CASE WHEN state = 'done' THEN 'wanted' ELSE state END,
           attempt = CASE WHEN state = 'done' THEN 0 ELSE attempt END,
           error_attempt = CASE WHEN state = 'done' THEN 0 ELSE error_attempt END,
           next_retry_at = CASE WHEN state = 'done' THEN NULL ELSE next_retry_at END`
const seedSeriesJob = (seriesId: string, season: number, now = Date.now()): void => {
  db.prepare(
    `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
     VALUES ('series_season', ?, ?, 'wanted', 0, 0, ?, ?)${UPSERT_CONFLICT_SQL}`
  ).run(seriesId, season, now, now, now)
}
const mkSeriesJob = (now = Date.now()) => seedSeriesJob('s1', 4, now)
const findSeriesJob = (seriesId: string, season: number): Job | null =>
  (db.prepare(`SELECT * FROM jobs WHERE kind = 'series_season' AND series_id = ? AND season = ?`)
    .get(seriesId, season) as Job | undefined) ?? null

describe('jobs 状态机', () => {
  it('claimNext 可排除 translate 车道，巡检任务先领；也可只领 translate', () => {
    const now = Date.now()
    seedSeriesJob('patrol', 1, now)
    db.prepare(`INSERT INTO jobs (kind, movie_id, payload, state, priority, attempt, created_at, updated_at)
                VALUES ('worker_task', 'movie:translate', '{"taskType":"translate"}', 'wanted', 0, 0, ?, ?)`)
      .run(now, now)

    const patrol = repo.claimNext(now, { excludeTaskType: 'translate' })
    expect(patrol?.series_id).toBe('patrol')
    expect(repo.countClaimable(now, { onlyTaskType: 'translate' })).toBe(1)
    expect(repo.countActiveTaskType('translate', true)).toBe(1)

    const translation = repo.claimNext(now, { onlyTaskType: 'translate' })
    expect(translation?.movie_id).toBe('movie:translate')
    expect(repo.countActiveTaskType('translate', false)).toBe(1)
  })

  it('heldBackoffMs：首周每日、次周三日、之后七日', () => {
    expect(heldBackoffMs(1)).toBe(86_400_000)
    expect(heldBackoffMs(7)).toBe(86_400_000)
    expect(heldBackoffMs(8)).toBe(3 * 86_400_000)
    expect(heldBackoffMs(14)).toBe(3 * 86_400_000)
    expect(heldBackoffMs(15)).toBe(7 * 86_400_000)
  })

  it('claimNext 原子领取：置 searching+租约，二次领取拿不到同一 job', () => {
    mkSeriesJob()
    const a = repo.claimNext(Date.now())
    expect(a?.state).toBe('searching')
    expect(repo.claimNext(Date.now())).toBeNull()
  })
  it('过租 job 被 reap 归位 wanted，attempt 不变（reap 不是内容性失败，不占内容退避梯名额）', () => {
    // 审计修正：reap 曾经 attempt+1，与内容退避梯共用计数器，会让"进程重启/租约抖动"错误地把
    // job 推向 dormant（见 jobsRepo.ts 历史 finding）。
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
    const row = findSeriesJob('s1', 4)!
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
      seedSeriesJob(s, 1, now)
    }
    repo.forceState('a', 1, 'searching', now)
    repo.forceState('b', 1, 'downloading', now)
    repo.forceState('c', 1, 'verifying', now)
    // 'w' 留 wanted
    repo.forceState('f', 1, 'failed', now)
    repo.forceState('d', 1, 'done', now)
    repo.forceState('z', 1, 'dormant', now)
    expect(repo.reapAllActive(now)).toBe(3)
    for (const s of ['a', 'b', 'c']) expect(findSeriesJob(s, 1)!.state).toBe('wanted')
    expect(findSeriesJob('a', 1)!.attempt).toBe(0)          // reap 不占内容退避梯名额
    expect(findSeriesJob('w', 1)!.state).toBe('wanted')
    expect(findSeriesJob('w', 1)!.attempt).toBe(0)          // 本就 wanted 的不被 attempt+1
    expect(findSeriesJob('f', 1)!.state).toBe('failed')
    expect(findSeriesJob('d', 1)!.state).toBe('done')
    expect(findSeriesJob('z', 1)!.state).toBe('dormant')
  })
  it('FIX-1: reapOrphaned 只回收 active 且不在调用方给出的 trackedIds 里的行，attempt 不变', () => {
    // 派发饥饿审计修正：daemon 每 tick 该拿"本进程当前正跟踪"的 id 集合去核对——单实例
    // 前提下，active 态但 id 不在这个集合里的行定义上就是孤儿（同 reapAllActive 的论证），
    // 不必等 30min 租约到期。trackedIds 里的 id（真正 inflight）必须被放过。
    const now = Date.now()
    for (const s of ['tracked', 'orphan1', 'orphan2', 'idle']) {
      seedSeriesJob(s, 1, now)
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

    expect(findSeriesJob('idle', 1)!.state).toBe('wanted') // 静止态不受影响
  })
  it('FIX-1: reapOrphaned 在 trackedIds 为空时回收全部 active 行（同 reapAllActive 语义）', () => {
    const now = Date.now()
    seedSeriesJob('s1', 1, now)
    const j = repo.claimNext(now)!
    expect(repo.reapOrphaned([], now).map(r => r.id)).toEqual([j.id])
    expect(repo.get(j.id)!.state).toBe('wanted')
  })
  it('心跳续租（renewLease）：仅对活跃态生效，续租后不会被 reapExpiredLeases 回收', () => {    const now = Date.now()
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

  describe('崩溃循环隔离（SRE F1:reap 计数,连续无完成回收触阈 → park 防 money fire）', () => {
    it('连续 5 次 claim→reapAllActive(模拟进程死+容器重启) → 第 5 次 park 成 dormant,不再被 claim', () => {
      const now = Date.now()
      mkSeriesJob(now)
      for (let i = 1; i <= 4; i++) {
        repo.claimNext(now)
        repo.reapAllActive(now)
        const row = findSeriesJob('s1', 4)!
        expect(row.state).toBe('wanted')          // 前 4 次仍归位(良性重启不受影响)
        expect(row.reap_count).toBe(i)
      }
      repo.claimNext(now)
      repo.reapAllActive(now)                      // 第 5 次触阈
      const row = findSeriesJob('s1', 4)!
      expect(row.state).toBe('dormant')
      expect(row.reap_count).toBe(5)
      expect(row.last_error).toContain('poison task')
      expect(repo.claimNext(now)).toBeNull()       // dormant 不参与派发
    })

    it('中途有完成(completeError) → reap_count 清零,重新起计', () => {
      const now = Date.now()
      mkSeriesJob(now)
      for (let i = 0; i < 3; i++) { repo.claimNext(now); repo.reapAllActive(now) }
      expect(findSeriesJob('s1', 4)!.reap_count).toBe(3)
      const j = repo.claimNext(now)!
      repo.completeError(j.id, 'boom', now)        // 完成了一次(内容失败结局)
      expect(findSeriesJob('s1', 4)!.reap_count).toBe(0)
      repo.forceState('s1', 4, 'searching', now)
      repo.reapAllActive(now)
      expect(findSeriesJob('s1', 4)!.reap_count).toBe(1)
    })

    it('completeDone 也清零 reap_count', () => {
      const now = Date.now()
      mkSeriesJob(now)
      repo.claimNext(now); repo.reapAllActive(now)
      expect(findSeriesJob('s1', 4)!.reap_count).toBe(1)
      const j = repo.claimNext(now)!
      repo.completeDone(j.id, now)
      expect(findSeriesJob('s1', 4)!.reap_count).toBe(0)
    })

    it('reapExpiredLeases 同款触阈 park(租约死亡路径)', () => {
      const now = Date.now()
      mkSeriesJob(now)
      repo.forceState('s1', 4, 'searching', now)
      db.prepare("UPDATE jobs SET reap_count = 4 WHERE kind='series_season' AND series_id='s1'").run()
      repo.reapExpiredLeases(now)
      const row = findSeriesJob('s1', 4)!
      expect(row.state).toBe('dormant')
      expect(row.reap_count).toBe(5)
    })
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
  it('双轨分流：completeError 只充 error_attempt，从不触碰内容计数器 attempt', () => {
    const t0 = Date.now()
    mkSeriesJob(t0)
    const j = repo.claimNext(t0)!
    repo.completeError(j.id, 'ASSRT 500', t0)
    const row = repo.get(j.id)!
    expect(row.error_attempt).toBe(1)
    expect(row.attempt).toBe(0) // 内容计数器纹丝不动——两条轨彻底独立
  })
  it('done→wanted 复活（I2 扩展）：error_attempt 与 attempt 一并归零，成功即翻篇', () => {
    const now = Date.now()
    mkSeriesJob(now)
    let j = repo.claimNext(now)!
    repo.completeError(j.id, 'timeout', now) // error_attempt=1，job 仍 failed
    j = repo.forceClaim('s1', 4, now)!
    repo.completeDone(j.id, now)
    mkSeriesJob(now) // 该季重新出现 missing → done→wanted 复活
    const revived = repo.get(j.id)!
    expect(revived.state).toBe('wanted')
    expect(revived.attempt).toBe(0)
    expect(revived.error_attempt).toBe(0)
  })
  it('completeDone 置 done 终态', () => {
    mkSeriesJob()
    const j = repo.claimNext(Date.now())!
    repo.completeDone(j.id, Date.now())
    expect(repo.get(j.id)!.state).toBe('done')
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
  it('状态守卫：complete* 只作用于 active 态（wanted 上调用 completeDone/completeError 全部 false）', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const j = findSeriesJob('s1', 4)!                      // state=wanted，未领取
    expect(repo.completeDone(j.id, now)).toBe(false)
    expect(repo.completeError(j.id, 'boom', now)).toBe(false)
    expect(repo.get(j.id)!.state).toBe('wanted')
  })
})

// 清算波 R-6（A-F8）：本 describe 原名"realign job kind"，测的其实是 setPlanRef/park 两个
// kind 无关的通用方法——过去只是借 upsertWanted({kind:'realign'}) 当造行手段（realign 是唯一
// 会写 plan_ref 的旧 kind）。upsertWanted 本身（含它测试过的幂等/plan_ref CASE-WHEN 语义）已
// 随死器官处决——production 的 realign 早已改走 upsertWorkerTask（taskType:'realign'，不带
// plan_ref 列），这条 SQL 分支不再存在，随之删除对它的直接测试。setPlanRef/park 仍是活体，
// 改借一个普通 series_season 行验证，语义不变。
describe('setPlanRef / park（kind 无关的通用状态机方法）', () => {
  it('setPlanRef 写入 plan_ref，仅在 active 态生效', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const job = repo.claimNext(now)!
    repo.setPlanRef(job.id, '/archive/s1-123/manifest.json', now)
    expect(repo.get(job.id)!.plan_ref).toBe('/archive/s1-123/manifest.json')
  })

  it('setPlanRef 对非 active 态 job 是 no-op', () => {
    const now = Date.now()
    mkSeriesJob(now)
    const job = repo.claimNext(now)!
    repo.completeDone(job.id, now)
    repo.setPlanRef(job.id, '/should/not/write', now)
    expect(repo.get(job.id)!.plan_ref).toBeNull()
  })

  // F10（审计修正 2026-07-16）：retireAllForSeries 曾经只退休 kind='series_season' 的行——
  // 那是已退役的旧管线 kind，v3 起没有任何生产代码再写它，这个方法因此从未真正作废过 realign
  // 该作废的判决。真正对着"旧排布"下判决的行是 kind='worker_task'（find_subtitle 的
  // dormant/failed 判决）。下面两个测试就地适配为 worker_task 身份，series_season 的对应
  // 回归测试挪到独立 it（证明该 kind 不再被本方法触碰）。
  it('retireAllForSeries：把该剧 wanted/failed 的 worker_task job 退休为 done，active 态不动', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'realign' }, null, now)
    repo.claimNext(now) // 两行之一变 searching（active，不该被 retire）
    const retired = repo.retireAllForSeries('s1', now)
    expect(retired).toBe(1)
  })

  // D-review #2：retireAllForSeries 的全部意义是"旧排布下的判决作废"——dormant 恰恰是
  // "对着错误排布搜索穷尽"的判决，不退休它，realign 后这一季永远不会被重新搜索。
  it('retireAllForSeries 连 dormant 一起退休，下一轮聚合能重建全新 wanted job', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    const job = repo.claimNext(now)!
    repo.park(job.id, 'old layout search exhausted', now)   // 旧排布下搜索穷尽的休眠判决
    expect(repo.retireAllForSeries('s1', now)).toBe(1)
    expect(repo.get(job.id)!.state).toBe('done')
    // realign 后新一轮派活重新 upsert 同 identity → done→wanted 复活，attempt 归零，重新可搜
    const revival = repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, now + 1)
    expect(revival).toEqual({ outcome: 'revived' })
    const revived = repo.get(job.id)!
    expect(revived.state).toBe('wanted')
    expect(revived.attempt).toBe(0)
  })

  it('retireAllForSeries 不再触碰 kind=series_season（已退役 kind，v3 无生产代码再写它）', () => {
    const now = Date.now()
    seedSeriesJob('s1', 1, now)
    repo.forceState('s1', 1, 'dormant', now)
    expect(repo.retireAllForSeries('s1', now)).toBe(0)
    expect(findSeriesJob('s1', 1)!.state).toBe('dormant')
  })

  it('retireAllForSeries 作废该剧全部静止态 worker_task 行（wanted/failed/dormant→done），不碰别剧', () => {
    const now = Date.now()

    // failed：先建、先领、先失败——这一刻它是唯一 wanted 行，claimNext 落点无歧义。
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'realign' }, null, now)
    const failedJob = repo.claimNext(now)!
    repo.completeError(failedJob.id, 'boom', now) // → failed，next_retry_at 在近未来，不会被下面的 claimNext 误领

    // dormant
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'orchestrate' }, null, now)
    const dormantJob = repo.claimNext(now)!
    repo.park(dormantJob.id, 'parked for test', now)

    // wanted：留原样不动
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    const wantedJobId = dormantJob.id + 1

    // 别剧：不该被碰
    repo.upsertWorkerTask({ seriesId: 's2', season: null, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    const otherSeriesJobId = wantedJobId + 1

    const retired = repo.retireAllForSeries('s1', now)
    expect(retired).toBe(3)

    expect(repo.get(failedJob.id)!.state).toBe('done')
    expect(repo.get(dormantJob.id)!.state).toBe('done')
    expect(repo.get(wantedJobId)!.state).toBe('done')
    expect(repo.get(otherSeriesJobId)!.state).toBe('wanted') // 别剧不受影响
  })

  // D-review #3：executeRealign 未接线的 realign job 曾走 completeError → 30s→15min→daily
  // 无穷 errorloop。park 提供"停车不重试"的诚实出口：active → dormant（不参与 claimNext）。
  describe('park（停车：active → dormant，不重试）', () => {
    it('active job 停车为 dormant，claimNext 不再派发（含一天后）', () => {
      const now = Date.now()
      mkSeriesJob(now)
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
      mkSeriesJob(now)
      const job = repo.claimNext(now)!
      repo.completeDone(job.id, now)
      expect(repo.park(job.id, 'x', now)).toBe(false)
      expect(repo.get(job.id)!.state).toBe('done')
    })
  })
})

describe('worker_task dispatch (v3 phase ④)', () => {
  it('upsertWorkerTask writes a new wanted row with payload and parent_job_id', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    // upsertWorkerTask 行 kind='worker_task'，不是 'series_season' — 走 claimNext 证明这一行
    // 真的在那儿、可被领取（旧版这里用已删除的 find() 断言它"看不见"这一行，find() 整个方法
    // 已随死器官处决，直接从领取动作本身证明身份，等价且更直接）。
    const claimed = repo.claimNext(now)
    expect(claimed?.kind).toBe('worker_task')
    expect(claimed?.series_id).toBe('s1')
    expect(JSON.parse(claimed!.payload!)).toEqual({ taskType: 'find_subtitle' })
    expect(claimed?.parent_job_id).toBeNull()
  })

  it('upsertWorkerTask is idempotent for the same identity while active (no duplicate row)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', retry: true }, null, now)
    expect(repo.countByState('wanted')).toBe(1)
  })

  it('upsertWorkerTask does not collide with an existing series_season job for the same series/season', () => {
    const now = Date.now()
    seedSeriesJob('s1', 1, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    expect(repo.countByState('wanted')).toBe(2)
  })

  it('records parent_job_id lineage for sibling-orchestrator style dispatch', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 'orchestrator-shard-0', season: null, movieId: null }, { taskType: 'orchestrate' }, null, now)
    const orchestratorJob = repo.claimNext(now)!
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, orchestratorJob.id, now)
    const dispatched = repo.get(orchestratorJob.id + 1)!
    expect(dispatched.parent_job_id).toBe(orchestratorJob.id)
  })

  it('done→wanted revival refreshes payload/parent_job_id (mirrors upsertWanted semantics)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
    const job = repo.claimNext(now)!
    repo.completeDone(job.id, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', round: 2 }, null, now)
    const revived = repo.get(job.id)!
    expect(revived.state).toBe('wanted')
    expect(JSON.parse(revived.payload!)).toEqual({ taskType: 'find_subtitle', round: 2 })
  })

  // R-11（用户裁决 2026-07-16）：schema v11 起 taskType 进 jobs_identity 元组——find_subtitle 与
  // realign 对同一 series 不再共享身份行，派活范围（哪些季）由主代理经 payload.seasons 下发。
  it('R-11 (v11): 同一 series 的 find_subtitle 与 realign worker_task 不再共享 identity——两次 upsert 落两行', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle', seasons: [1, 2, 3] }, null, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'realign' }, null, now)
    expect(repo.countByState('wanted')).toBe(2)
  })

  it('R-11 (v11): 同一 taskType 重复 upsert（season 恒 null）仍旧幂等——不因 taskType 加入元组而失去既有的重复派发保护', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle', seasons: [1] }, null, now)
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle', seasons: [1, 2] }, null, now)
    expect(repo.countByState('wanted')).toBe(1)
  })

  // R-2（裁决 2026-07-16，审计 A-F1/F2）：upsertWorkerTask 曾经对非 done 态行静默 no-op 且从
  // 不返回任何东西——dispatch 工具因此无条件回报 {dispatched:true}，dormant/failed 行悄悄吞掉
  // 主代理的新派发还谎报成功（永久活锁）。现在每次 upsert 返回它实际做了什么，四态穷尽。
  describe('upsertWorkerTask outcome 回执 (R-2)', () => {
    it('created/revived/coalesced/blocked_dormant 四态', () => {
      const now = Date.now()

      const created = repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
      expect(created).toEqual({ outcome: 'created' })

      const coalesced = repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', retry: true }, null, now)
      expect(coalesced).toEqual({ outcome: 'coalesced', pendingState: 'wanted', intentRefreshed: true })

      const job = repo.claimNext(now)!
      repo.completeDone(job.id, now)
      const revived = repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', round: 2 }, null, now)
      expect(revived).toEqual({ outcome: 'revived' })

      const job2 = repo.claimNext(now)!
      repo.park(job2.id, 'config defect', now)
      const blocked = repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
      expect(blocked).toEqual({ outcome: 'blocked_dormant', lastError: 'config defect' })
    })

    it('blocked_dormant 是唯一"没写"的结局：行完全不改（连 updated_at 也不刷），事实原样返回', () => {
      const now = Date.now()
      repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
      const job = repo.claimNext(now)!
      repo.park(job.id, 'realign executor not wired', now)
      const before = repo.get(job.id)!

      const result = repo.upsertWorkerTask(
        { seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', attempt: 'new' }, null, now + 1000,
      )

      expect(result).toEqual({ outcome: 'blocked_dormant', lastError: 'realign executor not wired' })
      expect(repo.get(job.id)!).toEqual(before)
    })

    it('coalesced 保留 pendingState=failed（不是只报 wanted）', () => {
      const now = Date.now()
      repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now)
      const job = repo.claimNext(now)!
      repo.completeError(job.id, 'boom', now)
      const result = repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle' }, null, now + 1)
      expect(result).toEqual({ outcome: 'coalesced', pendingState: 'failed', intentRefreshed: true })
    })
  })

  // F-R2-5（R2 复审，审计定罪：coalesced 谎报"identical"+新意图丢弃）：wanted/failed 两态还
  // 没被认领，没有 worker 正在读它的 payload——本次 dispatch 携带的最新意图（新的季范围/
  // reason/remainingWorkSummary）理应赢过旧的，而不是被无声丢弃在原地。active
  // （searching/downloading/verifying）态不同：有一个 worker 正在跑，此刻覆写它正在读的
  // payload 没有意义，继续保持"只碰 updated_at"的旧行为不变。attempt/error_attempt/
  // next_retry_at 无论哪一态都不动——这两条退避轨只由 done→revived（归零重试计数）和
  // dormant→blocked（停车判决）触碰，coalesced 从不改变它们（F1 裁决锁定的语义边界）。
  describe('coalesced 意图刷新 (F-R2-5)', () => {
    it('wanted 行 coalesce：payload 刷新为最新意图，intentRefreshed:true，updated_at 前进', () => {
      const now = Date.now()
      repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', seasons: [1] }, null, now)
      const jobId = (
        db.prepare(`SELECT id FROM jobs WHERE kind='worker_task' AND series_id='s1' AND season=1`).get() as { id: number }
      ).id
      const beforeRow = repo.get(jobId)!
      expect(beforeRow.updated_at).toBe(now)

      const result = repo.upsertWorkerTask(
        { seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', seasons: [1, 2, 3] }, null, now + 1000,
      )

      expect(result).toEqual({ outcome: 'coalesced', pendingState: 'wanted', intentRefreshed: true })
      const afterRow = repo.get(jobId)!
      expect(JSON.parse(afterRow.payload!)).toEqual({ taskType: 'find_subtitle', seasons: [1, 2, 3] })
      expect(afterRow.updated_at).toBe(now + 1000)
    })

    it('failed 行 coalesce：payload 也刷新，intentRefreshed:true，attempt/error_attempt/next_retry_at 不动', () => {
      const now = Date.now()
      repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', seasons: [1] }, null, now)
      const job = repo.claimNext(now)!
      repo.completeError(job.id, 'boom', now)
      const beforeRow = repo.get(job.id)!
      expect(beforeRow.error_attempt).toBe(1)
      const savedNextRetryAt = beforeRow.next_retry_at

      const result = repo.upsertWorkerTask(
        { seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', seasons: [4, 5] }, null, now + 1,
      )

      expect(result).toEqual({ outcome: 'coalesced', pendingState: 'failed', intentRefreshed: true })
      const afterRow = repo.get(job.id)!
      expect(JSON.parse(afterRow.payload!)).toEqual({ taskType: 'find_subtitle', seasons: [4, 5] })
      expect(afterRow.attempt).toBe(beforeRow.attempt)
      expect(afterRow.error_attempt).toBe(1)
      expect(afterRow.next_retry_at).toBe(savedNextRetryAt)
      expect(afterRow.state).toBe('failed')
    })

    it('active（searching）行 coalesce：payload 保持不动，intentRefreshed:false（只碰 updated_at，同旧行为）', () => {
      const now = Date.now()
      repo.upsertWorkerTask({ seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', seasons: [1] }, null, now)
      const job = repo.claimNext(now)!
      expect(job.state).toBe('searching')

      const result = repo.upsertWorkerTask(
        { seriesId: 's1', season: 1, movieId: null }, { taskType: 'find_subtitle', seasons: [9, 9, 9] }, null, now + 1000,
      )

      expect(result).toEqual({ outcome: 'coalesced', pendingState: 'searching', intentRefreshed: false })
      const afterRow = repo.get(job.id)!
      expect(JSON.parse(afterRow.payload!)).toEqual({ taskType: 'find_subtitle', seasons: [1] })
      expect(afterRow.updated_at).toBe(now + 1000)
      expect(afterRow.state).toBe('searching')
    })
  })
})

describe('hasActiveRealignWorkerTask (去 Jellyfin 化 T4, D4 ingest/realign 互斥门)', () => {
  it('false when there is no worker_task at all', () => {
    expect(repo.hasActiveRealignWorkerTask()).toBe(false)
  })

  it('false when a realign worker_task exists but is only wanted (not yet claimed)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'realign', reason: 'x' }, null, now)
    expect(repo.hasActiveRealignWorkerTask()).toBe(false)
  })

  it('true once a realign worker_task is claimed (state=searching)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'realign', reason: 'x' }, null, now)
    repo.claimNext(now)
    expect(repo.hasActiveRealignWorkerTask()).toBe(true)
  })

  it('false for a searching find_subtitle/orchestrate worker_task — only taskType=realign counts', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'find_subtitle', reason: 'x' }, null, now)
    repo.claimNext(now)
    expect(repo.hasActiveRealignWorkerTask()).toBe(false)
  })

  it('false again once the realign worker_task completes (no longer searching)', () => {
    const now = Date.now()
    repo.upsertWorkerTask({ seriesId: 's1', season: null, movieId: null }, { taskType: 'realign', reason: 'x' }, null, now)
    const job = repo.claimNext(now)!
    repo.completeDone(job.id, now)
    expect(repo.hasActiveRealignWorkerTask()).toBe(false)
  })

  it('false for a searching series_season/movie job (not kind=worker_task at all)', () => {
    const now = Date.now()
    seedSeriesJob('s1', 1, now)
    repo.claimNext(now)
    expect(repo.hasActiveRealignWorkerTask()).toBe(false)
  })
})
