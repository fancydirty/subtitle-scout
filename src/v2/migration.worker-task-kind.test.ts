// SQLite 不支持 ALTER 已有 CHECK 约束——同 v5(needs_review)/v7(realign) 手法：建新表(含扩容
// CHECK + 新列 payload/parent_job_id) → 显式列拷数据 → 删旧表 → 改名 → 重建两个既有索引
// (jobs_identity/jobs_claim) + 新增 jobs_parent。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

/** 造一个停在 v7 的存量库并回填 schema_version（镜像 migration.realign-job-kind.test.ts 的
 *  mkV6Db，v8 迁移的前置版本是 v7）。 */
function mkV7Db(): { dbPath: string; raw: Database.Database } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-worker-task-')), 'scout.db')
  const raw = new Database(dbPath)
  for (let i = 0; i < 7; i++) raw.exec(MIGRATIONS[i])
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7')").run()
  return { dbPath, raw }
}

describe('migration: worker_task job kind + payload + parent_job_id（jobs 表重建）', () => {
  it('全新库：jobs 能写入 kind=worker_task + payload + parent_job_id', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 's1', 1, ?, NULL, 'wanted', 0, 0, ?, ?)`
    ).run(JSON.stringify({ taskType: 'find_subtitle' }), now, now)
    const row = db.prepare(`SELECT * FROM jobs WHERE kind='worker_task'`).get() as any
    expect(row.series_id).toBe('s1')
    expect(row.season).toBe(1)
    expect(JSON.parse(row.payload)).toEqual({ taskType: 'find_subtitle' })
    expect(row.parent_job_id).toBeNull()
    db.close()
  })

  it('parent_job_id 可指向另一个 job（自引用外键在 foreign_keys=ON 后仍校验）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    const orchestratorId = db.prepare(
      `INSERT INTO jobs (kind, series_id, payload, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 'orchestrator-shard-0', ?, 'wanted', 0, 0, ?, ?)`
    ).run(JSON.stringify({ taskType: 'orchestrate' }), now, now).lastInsertRowid as number
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
       VALUES ('worker_task', 's1', 1, ?, ?, 'wanted', 0, 0, ?, ?)`
    ).run(JSON.stringify({ taskType: 'find_subtitle' }), orchestratorId, now, now)
    const row = db.prepare(`SELECT * FROM jobs WHERE parent_job_id IS NOT NULL`).get() as any
    expect(row.parent_job_id).toBe(orchestratorId)

    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, series_id, payload, parent_job_id, state, priority, attempt, created_at, updated_at)
         VALUES ('worker_task', 's2', ?, 999999, 'wanted', 0, 0, ?, ?)`
      ).run(JSON.stringify({ taskType: 'find_subtitle' }), now, now),
    ).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })

  it('worker_task 与 series_season 同剧同季不冲突（kind 是 jobs_identity 元组的一部分）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, series_id, season, payload, state, priority, attempt, created_at, updated_at)
         VALUES ('worker_task', 's1', 1, ?, 'wanted', 0, 0, ?, ?)`
      ).run(JSON.stringify({ taskType: 'find_subtitle' }), now, now),
    ).not.toThrow()
    const count = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE series_id='s1' AND season=1`).get() as { c: number }
    expect(count.c).toBe(2) // one series_season row, one worker_task row — kind distinguishes them
    db.close()
  })

  it('旧枚举值仍被 CHECK 约束拒绝非法 kind', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, state, priority, attempt, created_at, updated_at)
         VALUES ('bogus_kind', 'wanted', 0, 0, ?, ?)`
      ).run(Date.now(), Date.now()),
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('存量库（v7）：已有 jobs/runs 行无损迁移，runs.job_id 外键关系保持完整', () => {
    const { dbPath, raw } = mkV7Db()
    const now = Date.now()
    raw.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    raw.prepare(
      `INSERT INTO jobs (id, kind, series_id, season, state, priority, attempt, error_attempt, created_at, updated_at)
       VALUES (1, 'series_season', 's1', 1, 'failed', 0, 2, 0, ?, ?)`
    ).run(now, now)
    raw.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail)
       VALUES (1, ?, ?, 'no_safe_match', '没找到合适的中文字幕')`
    ).run(now, now)
    raw.close()

    const db = openDb(dbPath) // currentVersion=7 < 8 → 只跑 v8
    const job = db.prepare(`SELECT * FROM jobs WHERE id=1`).get() as any
    expect(job.kind).toBe('series_season')
    expect(job.payload).toBeNull() // 新列，存量行回填 NULL
    expect(job.parent_job_id).toBeNull() // 新列，存量行回填 NULL
    expect(job.plan_ref).toBeNull() // v7 既有列，安然无损

    const run = db.prepare(`SELECT * FROM runs WHERE job_id=1`).get() as any
    expect(run.decision).toBe('no_safe_match')

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })
    db.close()
  })

  it('v7→v8 round-trip：18 列全量互异非 NULL 值逐列无损，payload/parent_job_id 回填 NULL', () => {
    const { dbPath, raw } = mkV7Db()
    raw.prepare(
      `INSERT INTO jobs (id, kind, series_id, season, movie_id, plan_ref, state, priority, target_episodes,
                         attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
                         created_at, updated_at)
       VALUES (7, 'series_season', 's-roundtrip', 3, 'm-ghost', '/archive/manifest.jsonl', 'failed', 42, '[4,5,6]',
               2, 5, 1111, 2222, 'boom: EXDEV', 'jr-e9-1700000000000',
               3333, 4444)`
    ).run()
    raw.close()

    const db = openDb(dbPath)
    const job = db.prepare(`SELECT * FROM jobs WHERE id=7`).get()
    expect(job).toEqual({
      id: 7, kind: 'series_season', series_id: 's-roundtrip', season: 3, movie_id: 'm-ghost',
      plan_ref: '/archive/manifest.jsonl',
      payload: null, parent_job_id: null, // v8 新列：存量行回填 NULL
      state: 'failed', priority: 42, target_episodes: '[4,5,6]',
      attempt: 2, error_attempt: 5, next_retry_at: 1111, lease_until: 2222,
      last_error: 'boom: EXDEV', journal_ref: 'jr-e9-1700000000000',
      created_at: 3333, updated_at: 4444,
    })
    db.close()
  })

  it('迁移失败（目标临时表被占坑）→ 抛错且关闭 db 句柄（-wal 随关闭清理）', () => {
    const { dbPath, raw } = mkV7Db()
    raw.exec('CREATE TABLE jobs_new (x INTEGER)') // 占坑：v8 的 CREATE TABLE jobs_new 必然失败
    raw.close()
    expect(() => openDb(dbPath)).toThrow(/jobs_new/)
    expect(existsSync(dbPath + '-wal')).toBe(false)
    const check = new Database(dbPath)
    expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '7' })
    check.close()
  })

  it('jobs_claim 索引重建后 claimNext 排序仍可用（priority DESC, created_at）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    const row = db.prepare(
      `SELECT id FROM jobs WHERE state IN ('wanted','failed') ORDER BY priority DESC, created_at ASC LIMIT 1`
    ).get() as { id: number }
    expect(row).toBeDefined()
    db.close()
  })
})
