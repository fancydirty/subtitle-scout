import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { JobsRepo, type Job } from './jobsRepo.js'
import {
  listTranslateCandidates, dispatchTranslateTasks, runTranslateWorkerTask, SUPPORTED_SOURCE_LANGS,
} from './translateWorkerTask.js'

let db: ScoutDb
let jobs: JobsRepo
beforeEach(() => { db = openDb(':memory:'); jobs = new JobsRepo(db) })

function seedSeries(id: string, originLang: string | null = null): void {
  db.prepare(`INSERT INTO series (id, name, origin_lang) VALUES (?, ?, ?)`).run(id, id, originLang)
}
function seedEpisode(id: string, seriesId: string, subStatus: string, embeddedLangs: string | null, path = `/media/tv/${id}.mkv`): void {
  db.prepare(
    `INSERT INTO episodes (id, series_id, season, episode, path, sub_status, updated_at, embedded_langs)
     VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
  ).run(id, seriesId, path, subStatus, embeddedLangs)
}
function seedMovie(id: string, subStatus: string, embeddedLangs: string | null, path = `/media/movies/${id}.mkv`, originLang: string | null = null): void {
  db.prepare(
    `INSERT INTO movies (id, name, path, sub_status, updated_at, embedded_langs, origin_lang)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(id, id, path, subStatus, embeddedLangs, originLang)
}

describe('listTranslateCandidates — unavailable + 内嵌非中文轨才算可译候选', () => {
  beforeEach(() => seedSeries('tmdb:1'))

  it('unavailable + eng 内嵌轨 → 候选(episode 与 movie 都算)', () => {
    seedEpisode('tmdb:1/s1e1', 'tmdb:1', 'unavailable', '["eng"]')
    seedMovie('tmdb:9', 'unavailable', '["eng","jpn"]')
    const c = listTranslateCandidates(db)
    expect(c.map((x) => x.itemId).sort()).toEqual(['tmdb:1/s1e1', 'tmdb:9'])
  })

  it('covered/embedded/missing/ignored 不算(只翻搜索穷尽确认无的)', () => {
    seedEpisode('tmdb:1/s1e1', 'tmdb:1', 'covered', '["eng"]')
    seedEpisode('tmdb:1/s1e2', 'tmdb:1', 'missing', '["eng"]', '/media/tv/e2.mkv')
    seedEpisode('tmdb:1/s1e3', 'tmdb:1', 'ignored', '["eng"]', '/media/tv/e3.mkv')
    expect(listTranslateCandidates(db)).toEqual([])
  })

  it('unavailable 但内嵌只有中文轨/无轨/未探测 → 不算', () => {
    seedEpisode('tmdb:1/s1e1', 'tmdb:1', 'unavailable', '["chi"]')
    seedEpisode('tmdb:1/s1e2', 'tmdb:1', 'unavailable', '[]', '/media/tv/e2.mkv')
    seedEpisode('tmdb:1/s1e3', 'tmdb:1', 'unavailable', null, '/media/tv/e3.mkv')
    expect(listTranslateCandidates(db)).toEqual([])
  })
})

describe('listTranslateCandidates — F1 源语言腿:unavailable + origin_lang ∈ SUPPORTED_SOURCE_LANGS 也算候选', () => {
  it('SUPPORTED_SOURCE_LANGS 是单跳直译铁原则常量:en+ja(F2 jimaku;永不英语中继)', () => {
    expect(SUPPORTED_SOURCE_LANGS).toEqual(['en', 'ja'])
  })

  it('unavailable + 零内嵌 + series.origin_lang=en → 候选(episodes JOIN series 取 origin_lang)', () => {
    seedSeries('tmdb:1', 'en')
    seedEpisode('tmdb:1/s1e1', 'tmdb:1', 'unavailable', null)
    seedEpisode('tmdb:1/s1e2', 'tmdb:1', 'unavailable', '[]', '/media/tv/e2.mkv')
    expect(listTranslateCandidates(db).map((x) => x.itemId).sort()).toEqual(['tmdb:1/s1e1', 'tmdb:1/s1e2'])
  })

  it('origin_lang=ja → 候选(F2 jimaku;单跳日→中,永不英语中继)', () => {
    seedSeries('tmdb:2', 'ja')
    seedEpisode('tmdb:2/s1e1', 'tmdb:2', 'unavailable', null)
    expect(listTranslateCandidates(db).map((x) => x.itemId)).toEqual(['tmdb:2/s1e1'])
  })

  it('movies 同构:origin_lang=en/ja 零内嵌 → 候选;null/ko → 非', () => {
    seedMovie('tmdb:9', 'unavailable', null, '/media/movies/en.mkv', 'en')
    seedMovie('tmdb:10', 'unavailable', null, '/media/movies/ja.mkv', 'ja')
    seedMovie('tmdb:11', 'unavailable', null, '/media/movies/null.mkv', null)
    seedMovie('tmdb:13', 'unavailable', null, '/media/movies/ko.mkv', 'ko')
    expect(listTranslateCandidates(db).map((x) => x.itemId).sort()).toEqual(['tmdb:10', 'tmdb:9'])
  })

  it('origin_lang 脏值(大小写/空白)lower+trim 后比对:" EN " → 候选', () => {
    seedSeries('tmdb:3', ' EN ')
    seedEpisode('tmdb:3/s1e1', 'tmdb:3', 'unavailable', null)
    expect(listTranslateCandidates(db).map((x) => x.itemId)).toEqual(['tmdb:3/s1e1'])
  })

  it('origin_lang=en 但 sub_status 非 unavailable → 非候选(只救搜索穷尽确认无的)', () => {
    seedSeries('tmdb:4', 'en')
    seedEpisode('tmdb:4/s1e1', 'tmdb:4', 'missing', null)
    seedMovie('tmdb:12', 'covered', null, '/media/movies/c.mkv', 'en')
    expect(listTranslateCandidates(db)).toEqual([])
  })

  it('两腿是 OR:origin_lang=en + 内嵌非中文轨的同一条目只出现一次(不重复派活)', () => {
    seedSeries('tmdb:5', 'en')
    seedEpisode('tmdb:5/s1e1', 'tmdb:5', 'unavailable', '["eng"]')
    expect(listTranslateCandidates(db).map((x) => x.itemId)).toEqual(['tmdb:5/s1e1'])
  })
})

describe('dispatchTranslateTasks — 派 translate worker_task(合成 identity 幂等)', () => {
  beforeEach(() => seedSeries('tmdb:1'))

  it('每候选一行 job;重复派发幂等不翻倍', () => {
    seedEpisode('tmdb:1/s1e1', 'tmdb:1', 'unavailable', '["eng"]')
    seedEpisode('tmdb:1/s1e2', 'tmdb:1', 'unavailable', '["eng"]', '/media/tv/e2.mkv')
    expect(dispatchTranslateTasks(db, jobs, () => 1000)).toBe(2)
    expect(dispatchTranslateTasks(db, jobs, () => 2000)).toBe(0) // 幂等:已有行,created=0
    const rows = db.prepare(`SELECT payload FROM jobs WHERE kind='worker_task'`).all() as { payload: string }[]
    const payloads = rows.map((r) => JSON.parse(r.payload))
    expect(payloads).toHaveLength(2)
    expect(payloads.every((p) => p.taskType === 'translate' && typeof p.videoPath === 'string')).toBe(true)
  })

  it('同季两集不撞 identity(合成 seriesId 按 item)', () => {
    seedEpisode('tmdb:1/s1e1', 'tmdb:1', 'unavailable', '["eng"]')
    seedEpisode('tmdb:1/s1e2', 'tmdb:1', 'unavailable', '["eng"]', '/media/tv/e2.mkv')
    dispatchTranslateTasks(db, jobs, () => 1000)
    const n = db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }
    expect(n.n).toBe(2)
  })
})

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
