import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import { JobsRepo, type Job } from './jobsRepo.js'
import {
  listTranslateCandidates, dispatchTranslateTasks, runTranslateWorkerTask,
} from './translateWorkerTask.js'

let db: ScoutDb
let jobs: JobsRepo
beforeEach(() => { db = openDb(':memory:'); jobs = new JobsRepo(db) })

function seedSeries(id: string): void {
  db.prepare(`INSERT INTO series (id, name) VALUES (?, ?)`).run(id, id)
}
function seedEpisode(id: string, seriesId: string, subStatus: string, embeddedLangs: string | null, path = `/media/tv/${id}.mkv`): void {
  db.prepare(
    `INSERT INTO episodes (id, series_id, season, episode, path, sub_status, updated_at, embedded_langs)
     VALUES (?, ?, 1, 1, ?, ?, 0, ?)`,
  ).run(id, seriesId, path, subStatus, embeddedLangs)
}
function seedMovie(id: string, subStatus: string, embeddedLangs: string | null, path = `/media/movies/${id}.mkv`): void {
  db.prepare(
    `INSERT INTO movies (id, name, path, sub_status, updated_at, embedded_langs)
     VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(id, id, path, subStatus, embeddedLangs)
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

  it('held(fail-closed) → completeError(可重试,带原因)', async () => {
    const job = makeJob('/media/x.mkv')
    await runTranslateWorkerTask(job, {
      runItem: async () => ({ status: 'held', reason: '术语漂移' }),
    }, jobs, () => 99)
    const row = db.prepare(`SELECT state, last_error FROM jobs WHERE id=?`).get(job.id) as { state: string; last_error: string }
    expect(row.state).toBe('failed')
    expect(row.last_error).toContain('held')
  })

  it('already-covered / no-embedded → completeDone(无事可做,不算错)', async () => {
    for (const status of ['already-covered', 'no-embedded'] as const) {
      db.prepare(`DELETE FROM jobs`).run()
      const job = makeJob('/media/x.mkv')
      await runTranslateWorkerTask(job, { runItem: async () => ({ status }) }, jobs, () => 99)
      expect((db.prepare(`SELECT state FROM jobs WHERE id=?`).get(job.id) as { state: string }).state).toBe('done')
    }
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
})
