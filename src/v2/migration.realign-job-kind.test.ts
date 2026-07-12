// SQLite 不支持 ALTER 已有 CHECK 约束——同 v5(needs_review)手法：建新表(含扩容 CHECK + 新列)
// → 显式列拷数据 → 删旧表 → 改名 → 重建两个索引(jobs 有 jobs_identity/jobs_claim，v5 的
// episodes/movies 在那之前没有额外索引，这次不能照抄"无需连带重建"的结论)。
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

/** 造一个停在 v6 的存量库并回填 schema_version。 */
function mkV6Db(): { dbPath: string; raw: Database.Database } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-realign-')), 'scout.db')
  const raw = new Database(dbPath)
  for (let i = 0; i < 6; i++) raw.exec(MIGRATIONS[i])
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '6')").run()
  return { dbPath, raw }
}

describe('migration: realign job kind + plan_ref（jobs 表重建）', () => {
  it('全新库：jobs 能写入 kind=realign + plan_ref，season 为 NULL', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
       VALUES ('realign', 's1', NULL, '/archive/s1-123/manifest.json', 'wanted', 0, 0, ?, ?)`
    ).run(now, now)
    const row = db.prepare(`SELECT * FROM jobs WHERE kind='realign'`).get() as any
    expect(row.series_id).toBe('s1')
    expect(row.season).toBeNull()
    expect(row.plan_ref).toBe('/archive/s1-123/manifest.json')
    db.close()
  })

  it('旧枚举值仍被 CHECK 约束拒绝非法 kind', () => {
    const db = openDb(':memory:')
    expect(() =>
      db.prepare(
        `INSERT INTO jobs (kind, state, priority, attempt, created_at, updated_at)
         VALUES ('bogus_kind', 'wanted', 0, 0, ?, ?)`
      ).run(Date.now(), Date.now())
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('存量库（v6）：已有 jobs/runs 行无损迁移，runs.job_id 外键关系保持完整', () => {
    const { dbPath, raw } = mkV6Db()

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

    const db = openDb(dbPath) // currentVersion=6 < 7 → 只跑 v7

    const job = db.prepare(`SELECT * FROM jobs WHERE id=1`).get() as any
    expect(job.kind).toBe('series_season')
    expect(job.series_id).toBe('s1')
    expect(job.attempt).toBe(2)
    expect(job.plan_ref).toBeNull() // 新列，存量行回填 NULL

    const run = db.prepare(`SELECT * FROM runs WHERE job_id=1`).get() as any
    expect(run.decision).toBe('no_safe_match') // runs 外键引用的 job 迁移后依然存在、id 不变

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })
    db.close()
  })

  // D-review #5：v7 的 INSERT INTO jobs_new ... SELECT 逐列显式列名——漏拷/错位任何一列都
  // 该被这条 round-trip 抓住。v6 的全部 16 列逐一填互不相同的非 NULL 值，迁移后逐列钉死。
  it('v6→v7 round-trip：16 列全量互异非 NULL 值逐列无损，plan_ref 回填 NULL', () => {
    const { dbPath, raw } = mkV6Db()
    raw.prepare(
      `INSERT INTO jobs (id, kind, series_id, season, movie_id, state, priority, target_episodes,
                         attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
                         created_at, updated_at)
       VALUES (7, 'series_season', 's-roundtrip', 3, 'm-ghost', 'failed', 42, '[4,5,6]',
               2, 5, 1111, 2222, 'boom: EXDEV', 'jr-e9-1700000000000',
               3333, 4444)`
    ).run()
    raw.close()

    const db = openDb(dbPath)
    const job = db.prepare(`SELECT * FROM jobs WHERE id=7`).get()
    expect(job).toEqual({
      id: 7,
      kind: 'series_season',
      series_id: 's-roundtrip',
      season: 3,
      movie_id: 'm-ghost',
      plan_ref: null, // v7 新列：存量行回填 NULL
      state: 'failed',
      priority: 42,
      target_episodes: '[4,5,6]',
      attempt: 2,
      error_attempt: 5,
      next_retry_at: 1111,
      lease_until: 2222,
      last_error: 'boom: EXDEV',
      journal_ref: 'jr-e9-1700000000000',
      created_at: 3333,
      updated_at: 4444,
    })
    db.close()
  })

  // D-review #4：迁移中途失败曾把抛错的 db 句柄泄漏出去（openDb 只在 FK 体检失败路径
  // close）。观测手段：WAL 连接干净关闭时 SQLite 会 checkpoint 并删除 -wal 文件——句柄
  // 泄漏则 -wal 残留在盘上。
  it('迁移失败（目标临时表被占坑）→ 抛错且关闭 db 句柄（-wal 随关闭清理）', () => {
    const { dbPath, raw } = mkV6Db()
    raw.exec('CREATE TABLE jobs_new (x INTEGER)') // 占坑：v7 的 CREATE TABLE jobs_new 必然失败
    raw.close()

    expect(() => openDb(dbPath)).toThrow(/jobs_new/)
    expect(existsSync(dbPath + '-wal')).toBe(false)
    // 库未被半迁移：版本仍停在 6（事务整体回滚）
    const check = new Database(dbPath)
    expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '6' })
    check.close()
  })

  it('jobs_identity 唯一索引重建后仍生效：同剧 realign job 幂等（season NULL 不破坏表达式唯一约束）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    const insert = () => db.prepare(
      `INSERT INTO jobs (kind, series_id, season, plan_ref, state, priority, attempt, created_at, updated_at)
       VALUES ('realign', 's1', NULL, NULL, 'wanted', 0, 0, ?, ?)
       ON CONFLICT(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''))
       DO UPDATE SET updated_at = excluded.updated_at`
    ).run(now, now)
    insert(); insert()
    const count = db.prepare(`SELECT COUNT(*) as c FROM jobs WHERE kind='realign'`).get() as { c: number }
    expect(count.c).toBe(1)
    db.close()
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
