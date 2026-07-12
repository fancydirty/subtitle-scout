import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

describe('migration: needs_review removal (v6 — reset to missing, recheck_after=now)', () => {
  it('resets existing needs_review episodes/movies to missing with recheck_after ≈ now', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-needsreview-rm-')), 'scout.db')

    // 手工建到 v5(本次迁移前一版):跑 MIGRATIONS[0..4]
    const raw = new Database(dbPath)
    for (let i = 0; i < 5; i++) raw.exec(MIGRATIONS[i])
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5')").run()

    const past = Date.now() - 86_400_000
    const future = Date.now() + 30 * 86_400_000
    raw.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    raw.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, status_reason, recheck_after, updated_at)
       VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'needs_review', '找到候选但把握不足', ?, ?)`
    ).run(future, past)
    raw.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
       VALUES ('e2', 's1', 1, 2, 'E2', '/tv/e2.mkv', 'covered', ?)`
    ).run(past) // 非 needs_review 行不受影响
    raw.prepare(
      `INSERT INTO movies (id, name, path, sub_status, status_reason, recheck_after, updated_at)
       VALUES ('m1', 'M1', '/m/m1.mkv', 'needs_review', '找到候选但把握不足', ?, ?)`
    ).run(future, past)
    raw.close()

    const before = Date.now()
    const db = openDb(dbPath)
    const after = Date.now()

    const ep = db.prepare(`SELECT * FROM episodes WHERE id='e1'`).get() as any
    expect(ep.sub_status).toBe('missing')
    expect(ep.status_reason).toBeNull()
    expect(ep.recheck_after).toBeGreaterThanOrEqual(before)
    expect(ep.recheck_after).toBeLessThanOrEqual(after)

    const untouched = db.prepare(`SELECT * FROM episodes WHERE id='e2'`).get() as any
    expect(untouched.sub_status).toBe('covered')

    const movie = db.prepare(`SELECT * FROM movies WHERE id='m1'`).get() as any
    expect(movie.sub_status).toBe('missing')
    expect(movie.status_reason).toBeNull()
    expect(movie.recheck_after).toBeGreaterThanOrEqual(before)

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })
    db.close()
  })

  it('the needs_review enum value is still tolerated by the CHECK constraint (no table rebuild — YAGNI)', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    expect(() =>
      db.prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
         VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'needs_review', ?)`
      ).run(now)
    ).not.toThrow()
    db.close()
  })

  it('a fresh (never-migrated) database ends up on the latest schema version — v6 is a no-op there', () => {
    const db = openDb(':memory:')
    expect(db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()).toEqual({ value: String(MIGRATIONS.length) })
    db.close()
  })
})
