import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { JobsRepo, type Job } from './jobsRepo.js'
import { runTranslateWorkerTask } from './translateWorkerTask.js'

let db: ScoutDb
let jobs: JobsRepo
beforeEach(() => { db = openDb(':memory:'); jobs = new JobsRepo(db) })

describe('runTranslateWorkerTask — 结局映射', () => {
  // daemon 真实语序:先 claim(state→active)再 execute——completeDone/Error 只对 active 行生效,
  // 测试同样先置 active。
  function makeJob(videoPath: string): Job {
    jobs.upsertWorkerTask({ seriesId: 'translate:x', season: null, movieId: null }, { taskType: 'translate', videoPath, itemId: 'x' }, null, 0)
    db.prepare(`UPDATE jobs SET state='searching'`).run()
    return db.prepare(`SELECT * FROM jobs LIMIT 1`).get() as Job
  }

  it('installed → completeDone + requestIngest + runs 记录', async () => {
    const job = makeJob('/media/x.mkv')
    let ingested = false
    const runsRows: { decision: string }[] = []
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'installed', sidecarPath: '/media/x.zh-Hans.srt' }),
      requestIngest: () => { ingested = true },
      runs: { insert: (r: { decision: string }) => { runsRows.push(r) } } as never,
    }, jobs, () => 99)
    expect((db.prepare(`SELECT state FROM jobs WHERE id=?`).get(job.id) as { state: string }).state).toBe('done')
    expect(ingested).toBe(true)
    expect(runsRows[0]?.decision).toBe('translate:installed')
  })

  it('held(fail-closed) → completeHeld(首周每日衰减重试,带原因)', async () => {
    const job = makeJob('/media/x.mkv')
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'held', reason: '术语漂移' }),
    }, jobs, () => 99)
    const row = db.prepare(`SELECT state, last_error, error_attempt, next_retry_at FROM jobs WHERE id=?`).get(job.id) as { state: string; last_error: string; error_attempt: number; next_retry_at: number }
    expect(row.state).toBe('failed')
    expect(row.last_error).toContain('held')
    expect(row.error_attempt).toBe(1)
    expect(row.next_retry_at).toBe(99 + 86_400_000)
  })

  it('already-covered / no-embedded / no-source → completeDone(无事可做,不算错)', async () => {
    for (const status of ['already-covered', 'no-embedded', 'no-source'] as const) {
      db.prepare(`DELETE FROM jobs`).run()
      const job = makeJob('/media/x.mkv')
      await runTranslateWorkerTask(job, { runItem: async () => ({ status }) }, jobs, () => 99)
      expect((db.prepare(`SELECT state FROM jobs WHERE id=?`).get(job.id) as { state: string }).state).toBe('done')
    }
  })

  it('F1: no-source → runs 记录 decision=translate:no-source(同 no-embedded 口径)', async () => {
    const job = makeJob('/media/x.mkv')
    const runsRows: { decision: string; detail: string }[] = []
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'no-source' }),
      runs: { insert: (r: { decision: string; detail: string }) => { runsRows.push(r) } } as never,
    }, jobs, () => 99)
    expect(runsRows[0]?.decision).toBe('translate:no-source')
  })

  it('F1: installed 带 sourceRef → runs detail 里可追溯来源', async () => {
    const job = makeJob('/media/x.mkv')
    const runsRows: { decision: string; detail: string }[] = []
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'installed', sidecarPath: '/media/x.zh-Hans.srt', sourceRef: 'opensubtitles:12345' }),
      runs: { insert: (r: { decision: string; detail: string }) => { runsRows.push(r) } } as never,
    }, jobs, () => 99)
    expect(runsRows[0]?.decision).toBe('translate:installed')
    expect(runsRows[0]?.detail).toContain('opensubtitles:12345')
  })

  it('runItem 抛错 → completeError,不崩', async () => {
    const job = makeJob('/media/x.mkv')
    await runTranslateWorkerTask(job, { runItem: async () => { throw new Error('boom') } }, jobs, () => 99)
    expect((db.prepare(`SELECT state FROM jobs WHERE id=?`).get(job.id) as { state: string }).state).toBe('failed')
  })

  it('payload 缺 videoPath → completeError', async () => {
    jobs.upsertWorkerTask({ seriesId: 'translate:bad', season: null, movieId: null }, { taskType: 'translate' }, null, 0)
    db.prepare(`UPDATE jobs SET state='searching'`).run()
    const job = db.prepare(`SELECT * FROM jobs LIMIT 1`).get() as Job
    await runTranslateWorkerTask(job, { runItem: async () => ({ status: 'installed' }) }, jobs, () => 99)
    expect((db.prepare(`SELECT state FROM jobs WHERE id=?`).get(job.id) as { state: string }).state).toBe('failed')
  })

  it('held 同签名熔断:第二次相同 reason → park(dormant),不再自动重试', async () => {
    // 生产实案:job29 重试 11 次全同样的错误(衰减梯空转烧配额)。同签名反复 held = 模型对这条
    // 字幕系统性过不了闸 → park 成 dormant 转人工审查,而非无穷衰减重试。
    const job = makeJob('/media/x.mkv')
    // 第一次 held:正常衰减重试(completeHeld → failed)
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'held', reason: '术语漂移' }),
    }, jobs, () => 99)
    let row = db.prepare(`SELECT state, error_attempt FROM jobs WHERE id=?`).get(job.id) as { state: string; error_attempt: number }
    expect(row.state).toBe('failed')
    expect(row.error_attempt).toBe(1)

    // 重新 claim(state→searching),并重新取出 job 对象(拿最新的 last_error 供签名比对)
    db.prepare(`UPDATE jobs SET state='searching'`).run()
    const job2 = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(job.id) as Job

    // 第二次相同签名 held → park(dormant,转人工审查)
    await runTranslateWorkerTask(job2, {
      runItem: async () => ({ status: 'held', reason: '术语漂移' }),
    }, jobs, () => 200)
    const parked = db.prepare(`SELECT state, last_error, next_retry_at FROM jobs WHERE id=?`).get(job.id) as { state: string; last_error: string; next_retry_at: number | null }
    expect(parked.state).toBe('dormant')
    expect(parked.last_error).toContain('签名重复')
    expect(parked.next_retry_at).toBeNull()
  })

  it('held 不同签名 → 正常衰减重试(completeHeld),不熔断', async () => {
    const job = makeJob('/media/x.mkv')
    // 第一次 held:reason A
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'held', reason: '术语漂移' }),
    }, jobs, () => 99)

    db.prepare(`UPDATE jobs SET state='searching'`).run()
    const job2 = db.prepare(`SELECT * FROM jobs WHERE id=?`).get(job.id) as Job

    // 第二次不同签名 held(reason B)→ completeHeld 正常衰减,不熔断
    await runTranslateWorkerTask(job2, {
      runItem: async () => ({ status: 'held', reason: 'CPS 读速超标' }),
    }, jobs, () => 200)
    const row = db.prepare(`SELECT state, last_error, error_attempt, next_retry_at FROM jobs WHERE id=?`).get(job.id) as { state: string; last_error: string; error_attempt: number; next_retry_at: number }
    expect(row.state).toBe('failed')
    expect(row.error_attempt).toBe(2)
    expect(row.last_error).toContain('CPS')
  })

  it('installed/held insert 带 llmCalls(来自 result)', async () => {
    for (const [status, llmCalls] of [['installed', 5], ['held', 3]] as const) {
      db.prepare(`DELETE FROM jobs`).run()
      const job = makeJob('/media/x.mkv')
      const runsRows: { decision: string; llmCalls?: number }[] = []
      await runTranslateWorkerTask(job, {
        runItem: async () => (
          status === 'installed'
            ? { status: 'installed', sidecarPath: '/media/x.zh-Hans.srt', llmCalls }
            : { status: 'held', reason: '术语漂移', llmCalls }
        ),
        runs: { insert: (r: { decision: string; llmCalls?: number }) => { runsRows.push(r) } } as never,
      }, jobs, () => 99)
      expect(runsRows[0]?.llmCalls).toBe(llmCalls)
    }
  })

  it('no-source insert 带 llmCalls=0', async () => {
    const job = makeJob('/media/x.mkv')
    const runsRows: { decision: string; llmCalls?: number }[] = []
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'no-source', llmCalls: 0 }),
      runs: { insert: (r: { decision: string; llmCalls?: number }) => { runsRows.push(r) } } as never,
    }, jobs, () => 99)
    expect(runsRows[0]?.decision).toBe('translate:no-source')
    expect(runsRows[0]?.llmCalls).toBe(0)
  })

  it('write-failed insert 保留 result 的 llmCalls', async () => {
    const job = makeJob('/media/x.mkv')
    const runsRows: { decision: string; llmCalls?: number }[] = []
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'write-failed', reason: 'disk full', llmCalls: 2 }) as never,
      runs: { insert: (r: { decision: string; llmCalls?: number }) => { runsRows.push(r) } } as never,
    }, jobs, () => 99)
    expect((db.prepare(`SELECT state FROM jobs WHERE id=?`).get(job.id) as { state: string }).state).toBe('failed')
    expect(runsRows[0]).toMatchObject({ decision: 'translate:write-failed', llmCalls: 2 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 新架构翻译流（spec §4 第 4 步 · C3/C31/C32 + D3/D6/D10 + R12/R19/R24）。
//
// 历史注记（第 7 步已结清）：这里原本写着"上面那批 describe 测的是旧世界
// （episodes/movies + jobs 表派活），第 7 步才清理，故刻意留着不动"——那一批
// （listTranslateCandidates 11 条 + dispatchTranslateTasks 4 条）连同被测的两个函数
// 已于第 7 步删除，所以本文件现在**只剩新世界 + runTranslateWorkerTask**，不再有
// "两批共存"这回事，也不再需要提醒读者别把新旧两个候选函数搞混。
// ─────────────────────────────────────────────────────────────────────────────
import {
  listNewTranslateCandidates, applyTranslateOutcome, TRANSLATE_HELD_LIMIT,
  FETCHABLE_SOURCE_LANGS, EXTRACTABLE_SOURCE_LANGS, SUPPORTED_SOURCE_LANGS,
} from './translateWorkerTask.js'
import { translateItemId } from './ownIds.js'
import { seriesKeyOf } from './glossaryRepo.js'

const NOW = 1_000_000_000_000
const DAY = 86_400_000

/** 新架构的一行：files（含 work_id）+ works。 */
function seedFile(
  path: string,
  opts: {
    workId?: string
    subStatus?: string | null
    trAttempt?: number
    trRecheckAfter?: number | null
    originLang?: string | null
  } = {},
): void {
  const workId = opts.workId ?? 'tmdb:1'
  const dir = path.slice(0, path.lastIndexOf('/'))
  const exists = db.prepare('SELECT 1 FROM works WHERE id = ?').get(workId)
  if (!exists) {
    db.prepare('INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(workId, `Title ${workId}`, 'tv', opts.originLang ?? 'en', 1000, 1000)
  }
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_id, sub_status, tr_attempt, tr_recheck_after, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    path, dir, path.slice(path.lastIndexOf('/') + 1), 100, 1000, workId,
    opts.subStatus === undefined ? 'handoff_translate' : opts.subStatus,
    opts.trAttempt ?? 0, opts.trRecheckAfter ?? null, 1000,
  )
}

function fileRow(path: string) {
  return db.prepare('SELECT sub_status, tr_attempt, tr_recheck_after, sub_recheck_at FROM files WHERE path = ?')
    .get(path) as { sub_status: string | null; tr_attempt: number; tr_recheck_after: number | null; sub_recheck_at: number | null }
}

describe('listNewTranslateCandidates — 工作台谓词（C3 核心：改读 files/handoff_translate）', () => {
  it('🔴 用例 1：取 sub_status=handoff_translate 且 tr_recheck_after 到点/为 NULL 的行', () => {
    seedFile('/media/tv/Show/S01E01.mkv', { trRecheckAfter: null })          // 从没碰过 → 立刻可领
    seedFile('/media/tv/Show/S01E02.mkv', { trRecheckAfter: NOW - 1 })       // 已到点
    seedFile('/media/tv/Show/S01E03.mkv', { trRecheckAfter: NOW })           // 恰好到点（边界含等号）
    const got = listNewTranslateCandidates(db, NOW)
    expect(got.map((c) => c.videoPath).sort()).toEqual([
      '/media/tv/Show/S01E01.mkv', '/media/tv/Show/S01E02.mkv', '/media/tv/Show/S01E03.mkv',
    ])
  })

  it('🔴 用例 2：tr_recheck_after 未到点的**不被领**（D6 防付费 LLM 热循环）', () => {
    // 这条是 D6 的红线本身。翻译流是主进程内独立循环（R19），下一圈几秒后就来；
    // 没有这个出队闸，同一行会被反复领走，每次都是一个数分钟的付费 LLM session。
    seedFile('/media/tv/Show/S01E01.mkv', { trRecheckAfter: NOW + 1 })
    expect(listNewTranslateCandidates(db, NOW)).toEqual([])
  })

  it('🔴 其它三态一律不进翻译工作台（C14 两工作台互斥）', () => {
    seedFile('/media/a.mkv', { subStatus: null })
    seedFile('/media/b.mkv', { subStatus: 'covered', workId: 'tmdb:2' })
    seedFile('/media/c.mkv', { subStatus: 'unsolvable', workId: 'tmdb:3' })
    expect(listNewTranslateCandidates(db, NOW)).toEqual([])
  })

  it('🔴 未识别行（work_id IS NULL）不进 —— INNER JOIN works，不许兜底', () => {
    // itemId 的第一段就是 work_id，没有 work_id 就构造不出合法 itemId；
    // 硬塞一个占位值会让 glossary key 退化（C20），故必须整行不取。
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, sub_status, updated_at)
                VALUES (?,?,?,?,?,NULL,'handoff_translate',?)`)
      .run('/media/orphan.mkv', '/media', 'orphan.mkv', 100, 1000, 1000)
    expect(listNewTranslateCandidates(db, NOW)).toEqual([])
  })

  it('🔴 用例 3：itemId 由 translateItemId 产出（断言真实 candidate 形态 / C20 构造点）', () => {
    // 4-2 的交接点名了这条：C20 的既有红线测的是**构造器**，手拼 itemId 的话它们一条都不会红。
    // 故这里断言的是真实 candidate 的 itemId 字段，且**独立算出**期望值（写死的 sha1 前 12 位），
    // 不是拿 translateItemId 跟自己比 —— 后者在"实现改成手拼但恰好同形"时也会绿。
    seedFile('/media/tv/Show/S01E01.mkv', { workId: 'tmdb:42' })
    const [c] = listNewTranslateCandidates(db, NOW)
    expect(c.itemId).toBe('tmdb:42/e5569b3ed744')
    // 与唯一构造入口同值（这条是防"两份实现漂移"，与上面那条职责不同）
    expect(c.itemId).toBe(translateItemId('tmdb:42', '/media/tv/Show/S01E01.mkv'))
  })

  it('🔴 用例 4：同剧两集的 candidate itemId 被 seriesKeyOf 解出同一 key（C20 端到端）', () => {
    // C20 的实质伤害：itemId 若以绝对路径开头，seriesKeyOf 的 `idx > 0` 为假 → 返回整串 →
    // 每个文件一个 glossary key → 同剧第 2 集拿不到第 1 集冻结的术语表 → 人名地名每集换译法
    // （实案：同一模型同剧两 run 分别选出"东国 / 奥斯塔尼亚"）。纯质量漂移，别处无断言会红。
    seedFile('/media/tv/Show/Season 01/E01.mkv', { workId: 'tmdb:7' })
    seedFile('/media/tv/Show/Season 02/E01.mkv', { workId: 'tmdb:7' })
    const keys = listNewTranslateCandidates(db, NOW).map((c) => seriesKeyOf(c.itemId))
    expect(keys).toHaveLength(2)
    expect(new Set(keys)).toEqual(new Set(['tmdb:7']))
    // 且两集的 itemId 本身必须不同（同名 basename 撞车会让第二季第一集永远派不出活）
    const ids = listNewTranslateCandidates(db, NOW).map((c) => c.itemId)
    expect(new Set(ids).size).toBe(2)
  })

  it('🔴 candidate 带出 origin_lang 与 title（runItem 单跳选源要用，避免二次查库漂移）', () => {
    seedFile('/media/tv/Show/S01E01.mkv', { workId: 'tmdb:5', originLang: 'ja' })
    const [c] = listNewTranslateCandidates(db, NOW)
    expect(c.originLang).toBe('ja')
    expect(c.workId).toBe('tmdb:5')
  })
})

describe('applyTranslateOutcome — 8 种 worker status 按 §5 映射表处置（C + D）', () => {
  it('🔴 用例 5：installed → 不写 covered / 清 tr_attempt / 写 tr_recheck_after（三条分开断言）', () => {
    seedFile('/media/x.mkv', { trAttempt: 2 })
    applyTranslateOutcome(db, '/media/x.mkv', 'installed', NOW)
    const r = fileRow('/media/x.mkv')
    // ① 不写 covered（R24：covered 是扫描独占的事实投影，worker 的成功报告不算）
    expect(r.sub_status).toBe('handoff_translate')
    // ② 清 tr_attempt（成功把失败额度归零）
    expect(r.tr_attempt).toBe(0)
    // ③ 写 tr_recheck_after 出队（D6：成功也必须出队，否则独立循环下一圈重领同一行）
    expect(r.tr_recheck_after).toBe(NOW + DAY)
  })

  // ── 装盘与观察的衔接（字幕轨同型缺陷的第二条轨，2026-08-10 live test）─────────────
  //
  // 字幕轨已在 subtitleScheduler.markInstalled 修过（commit 12e4ab6）：装盘成功必须把
  // sub_recheck_at 拉到"立即到点"，否则该行既不在扫描的 A 档（指纹没变）也不在 B 档
  // （上一轮 A 档已把 recheck 推到 now+7 天）→ 装好的字幕要等 7 天才被观察成 covered。
  //
  // 翻译轨完全同型，且更隐蔽：daemonV2 在翻译 installed 后**已经**调了 requestIngest()
  // 踢扫描（注释写着"新 sidecar 越早被扫到、covered 越早落库"），但踢的那轮扫描两档谓词
  // 同样选不中它——**踢了扫描而扫描什么都不看**，这条衔接是装饰性的。
  //
  // 哨兵取 0 而非 now-1：这一列的唯一读者是 daemonV2 的 B 档谓词 `sub_recheck_at <= ?`，
  // 喂的是可注入时钟 deps.now()；而写者拿到的 now 来自调用方。两个时钟源不同源时
  // （测试注入 2001 年、写者用真实时间），now-1 对读者是"未来 25 年"→ 谓词永不命中，
  // 而单元测试全绿。0 在任何时钟源下都已过期。见 subtitleScheduler.ts 的同一论证。
  it('🔴 installed → sub_recheck_at 拉到「立即到点」，否则新装的字幕等 7 天才被观察', () => {
    seedFile('/media/x.mkv', { trAttempt: 2 })
    // 模拟上一轮 A 档已把复核推到 7 天后（生产实测形态：sub_recheck_at 未来|61）
    db.prepare('UPDATE files SET sub_recheck_at = ? WHERE path = ?').run(NOW + 7 * DAY, '/media/x.mkv')
    applyTranslateOutcome(db, '/media/x.mkv', 'installed', NOW)
    const r = fileRow('/media/x.mkv')
    expect(r.sub_recheck_at).not.toBeNull()          // D18：不许写 NULL
    expect(r.sub_recheck_at).toBeLessThanOrEqual(NOW) // 立即到点，下一轮 B 档就命中
    expect(r.sub_status).toBe('handoff_translate')    // R24 未被破坏：仍不写 covered
  })

  it('🔴 哨兵值在被注入的时钟下也已过期（不许用 now-1——写者与读者时钟不同源）', () => {
    seedFile('/media/x.mkv')
    // 写者拿到一个"很早的" now（本仓既有测试口径：注入 2001 年）
    applyTranslateOutcome(db, '/media/x.mkv', 'installed', 1_000_000_000_000)
    const v = fileRow('/media/x.mkv').sub_recheck_at as number
    // 读者可能用真实时钟（2026）——哨兵必须对**任何**时钟源都已过期
    expect(v).toBeLessThanOrEqual(1_000_000_000_000)
    expect(v).toBeLessThanOrEqual(Date.now())
  })

  it('🔴 失败轨不许拉 sub_recheck_at（否则找不到源的行每轮白扫 60 次 stat）', () => {
    for (const st of ['held', 'no-source', 'extract-failed'] as const) {
      seedFile('/media/f.mkv', { trAttempt: 0 })
      db.prepare('UPDATE files SET sub_recheck_at = ? WHERE path = ?').run(NOW + 7 * DAY, '/media/f.mkv')
      applyTranslateOutcome(db, '/media/f.mkv', st, NOW)
      expect(fileRow('/media/f.mkv').sub_recheck_at, `status=${st} 不该拉排期`).toBe(NOW + 7 * DAY)
      db.prepare('DELETE FROM files WHERE path = ?').run('/media/f.mkv')
    }
  })

  it('🔴 already-covered 同样拉排期（磁盘上本就有，扫描该尽快把它记成 covered）', () => {
    seedFile('/media/x.mkv')
    db.prepare('UPDATE files SET sub_recheck_at = ? WHERE path = ?').run(NOW + 7 * DAY, '/media/x.mkv')
    applyTranslateOutcome(db, '/media/x.mkv', 'already-covered', NOW)
    expect(fileRow('/media/x.mkv').sub_recheck_at).toBeLessThanOrEqual(NOW)
  })

  it('🔴 already-covered → 同 installed 一档（扫描本就会认）', () => {
    seedFile('/media/x.mkv', { trAttempt: 2 })
    applyTranslateOutcome(db, '/media/x.mkv', 'already-covered', NOW)
    const r = fileRow('/media/x.mkv')
    expect(r.sub_status).toBe('handoff_translate')
    expect(r.tr_attempt).toBe(0)
    expect(r.tr_recheck_after).toBe(NOW + DAY)
  })

  it('🔴 用例 6：no-source → unsolvable', () => {
    seedFile('/media/x.mkv')
    applyTranslateOutcome(db, '/media/x.mkv', 'no-source', NOW)
    expect(fileRow('/media/x.mkv').sub_status).toBe('unsolvable')
  })

  it('🔴 no-embedded → unsolvable（同 no-source 一档）', () => {
    seedFile('/media/x.mkv')
    applyTranslateOutcome(db, '/media/x.mkv', 'no-embedded', NOW)
    expect(fileRow('/media/x.mkv').sub_status).toBe('unsolvable')
  })

  it('🔴 判无源转 unsolvable 时必须写 recheck_after（R25：停牌仍每周复查，否则成永久终态）', () => {
    // 阶段 2.6 复查闸的取件谓词是 `recheck_after IS NOT NULL AND recheck_after <= now`。
    // 翻译流把行写成 unsolvable 却不写 recheck_after → 复查闸永远选不中它 → R26"无永久终态"
    // 被静默破坏，那一集再也不会被找字幕。这条在状态列断言里完全看不出来。
    seedFile('/media/x.mkv')
    applyTranslateOutcome(db, '/media/x.mkv', 'no-source', NOW)
    const r = db.prepare('SELECT recheck_after FROM files WHERE path = ?').get('/media/x.mkv') as { recheck_after: number | null }
    expect(r.recheck_after).not.toBeNull()
    expect(r.recheck_after).toBeGreaterThan(NOW)
  })

  it('🔴 用例 7：held 未满 3 次 → tr_attempt+1 + 退避到明天，状态不变', () => {
    seedFile('/media/x.mkv', { trAttempt: 0 })
    applyTranslateOutcome(db, '/media/x.mkv', 'held', NOW)
    let r = fileRow('/media/x.mkv')
    expect(r.tr_attempt).toBe(1)
    expect(r.tr_recheck_after).toBe(NOW + DAY)
    expect(r.sub_status).toBe('handoff_translate')

    applyTranslateOutcome(db, '/media/x.mkv', 'held', NOW + DAY)
    r = fileRow('/media/x.mkv')
    expect(r.tr_attempt).toBe(2)
    expect(r.sub_status).toBe('handoff_translate')
  })

  it('🔴 用例 7b：held 满 3 次 → unsolvable', () => {
    seedFile('/media/x.mkv', { trAttempt: 2 })   // 这次 +1 = 3 → 到限
    applyTranslateOutcome(db, '/media/x.mkv', 'held', NOW)
    const r = fileRow('/media/x.mkv')
    expect(r.tr_attempt).toBe(3)
    expect(r.sub_status).toBe('unsolvable')
    expect(TRANSLATE_HELD_LIMIT).toBe(3)
  })

  it('🔴 extract-failed / probe-failed / write-failed 走同一条退避轨', () => {
    for (const status of ['extract-failed', 'probe-failed', 'write-failed'] as const) {
      db.prepare('DELETE FROM files').run()
      seedFile('/media/x.mkv', { trAttempt: 0 })
      applyTranslateOutcome(db, '/media/x.mkv', status, NOW)
      const r = fileRow('/media/x.mkv')
      expect(r.tr_attempt).toBe(1)
      expect(r.tr_recheck_after).toBe(NOW + DAY)
      expect(r.sub_status).toBe('handoff_translate')
    }
  })

  it('🔴 三条失败态满 3 次同样转 unsolvable（与 held 共用额度，不是各自一套）', () => {
    seedFile('/media/x.mkv', { trAttempt: 2 })
    applyTranslateOutcome(db, '/media/x.mkv', 'write-failed', NOW)
    expect(fileRow('/media/x.mkv').sub_status).toBe('unsolvable')
  })

  it('🔴 用例 8（D10 红线）：回写前 sub_status 被扫描改成 covered → 回写不生效', () => {
    // 翻译流是 SELECT → await LLM（数分钟）→ UPDATE。这几分钟里扫描可能已扫到中文字幕并
    // 写了 covered（R24 扫描独占）。无守卫的回写会把那个**磁盘事实**覆盖成 handoff_translate/
    // unsolvable → 界面显示停牌，而磁盘上字幕明明已经在了。
    for (const status of ['installed', 'no-source', 'held'] as const) {
      db.prepare('DELETE FROM files').run()
      seedFile('/media/x.mkv', { trAttempt: 1 })
      db.prepare(`UPDATE files SET sub_status='covered' WHERE path=?`).run('/media/x.mkv')  // 扫描抢先
      const res = applyTranslateOutcome(db, '/media/x.mkv', status, NOW)
      const r = fileRow('/media/x.mkv')
      expect(r.sub_status).toBe('covered')      // 没被覆盖
      expect(r.tr_attempt).toBe(1)              // 一列都没动
      expect(res.guardMissed).toBe(true)        // 且这件事**可观察**（否则你不知道发生过）
    }
  })

  it('🔴 守卫命中时 guardMissed=false（防"恒 true"式假绿）', () => {
    seedFile('/media/x.mkv')
    expect(applyTranslateOutcome(db, '/media/x.mkv', 'installed', NOW).guardMissed).toBe(false)
  })
})

describe('SUPPORTED_SOURCE_LANGS 口径收敛（C31 末段 / G）', () => {
  it('🔴 用例 12：可抓源 / 可抽轨只有一份定义，daemonV2 与 judge 都从这里取', () => {
    // C31 末段记的口径不一：translateWorkerTask.ts 把"可抓源"（外挂搜索，MVP 仅 en）与
    // "可抽轨"（内嵌轨，en/ja 皆可）混成一个 SUPPORTED_SOURCE_LANGS=['en','ja']，
    // 而 3-2 在 daemonV2.ts 里另建了拆开的两个集合。两份定义漂移的那天没有测试会红，
    // 只是无内嵌轨的日漫又开始白绕一圈 7 天（判可救 → 抓不到日文源 → unsolvable）。
    expect(FETCHABLE_SOURCE_LANGS).toEqual(['en'])
    expect(EXTRACTABLE_SOURCE_LANGS).toEqual(['en', 'ja'])
  })
})
