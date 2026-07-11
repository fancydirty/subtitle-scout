// src/v2/migration.needs-review.test.ts
// ask_user 诚实记账 Task 2：executor.ts 曾把 gate 'ask_user'（候选存在但置信不足）和
// no_safe_match（穷尽未找到）一样映射成 sub_status='unavailable'——前端展示"暂无"，
// 是一句谎言，掩盖了本可人工确认的候选。根治：新增 sub_status='needs_review'。
// SQLite 不支持 ALTER 已有 CHECK 约束，标准作法（同 v2/v3 迁移之后新增的重建表手法）：
// 建新表（含扩展后的 CHECK）→ 显式列拷数据 → 删旧表 → 改名。
// 手法同 migration.provider-ref.test.ts / migration.error-attempt.test.ts：手工重放到
// 迁移前一版，插入旧形态数据，再走 openDb 触发剩余迁移，校验存量数据无损、新枚举值可用。
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

describe('migration: needs_review sub_status（episodes/movies CHECK 约束扩容）', () => {
  it('全新库：episodes/movies 都能写入 needs_review', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    db.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
       VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'needs_review', ?)`
    ).run(now)
    db.prepare(
      `INSERT INTO movies (id, name, path, sub_status, updated_at) VALUES ('m1', 'M1', '/m/m1.mkv', 'needs_review', ?)`
    ).run(now)
    expect((db.prepare(`SELECT sub_status FROM episodes WHERE id='e1'`).get() as any).sub_status).toBe(
      'needs_review'
    )
    expect((db.prepare(`SELECT sub_status FROM movies WHERE id='m1'`).get() as any).sub_status).toBe(
      'needs_review'
    )
    db.close()
  })

  it('旧枚举值仍被 CHECK 约束拒绝非法值（约束扩容而非移除）', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    expect(() =>
      db
        .prepare(
          `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
           VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'bogus_status', ?)`
        )
        .run(now)
    ).toThrow(/CHECK constraint failed/)
    db.close()
  })

  it('存量库（迁移前旧版）：已有 episodes/movies 行无损迁移（含 origin_lang），旧枚举值原样保留', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-needsreview-')), 'scout.db')

    // 手工建到"本次迁移前一版"：跑 MIGRATIONS[0..3]（v1..v4，含 error_attempt），
    // 手写 meta.schema_version='4'，模拟一台已有存量数据的旧库。
    const raw = new Database(dbPath)
    for (let i = 0; i < 4; i++) raw.exec(MIGRATIONS[i])
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '4')").run()

    const now = Date.now()
    raw.prepare(`INSERT INTO series (id, name, origin_lang) VALUES ('s1', 'Series A', 'ja')`).run()
    raw
      .prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, status_reason, recheck_after, updated_at)
         VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'unavailable', '搜索穷尽', ?, ?)`
      )
      .run(now + 86_400_000, now)
    raw
      .prepare(
        `INSERT INTO movies (id, name, path, sub_status, origin_lang, updated_at)
         VALUES ('m1', 'M1', '/m/m1.mkv', 'covered', 'zh', ?)`
      )
      .run(now)
    raw.close()

    // openDb: currentVersion=4 < MIGRATIONS.length → 只跑剩余（本次 needs_review）迁移
    const db = openDb(dbPath)

    const ep = db.prepare(`SELECT * FROM episodes WHERE id='e1'`).get() as any
    expect(ep.sub_status).toBe('unavailable') // 存量值无损保留
    expect(ep.status_reason).toBe('搜索穷尽')
    expect(ep.recheck_after).toBe(now + 86_400_000)
    expect(ep.series_id).toBe('s1')

    const movie = db.prepare(`SELECT * FROM movies WHERE id='m1'`).get() as any
    expect(movie.sub_status).toBe('covered')
    expect(movie.origin_lang).toBe('zh') // v3 迁移加的列在重建后仍在

    const series = db.prepare(`SELECT origin_lang FROM series WHERE id='s1'`).get() as any
    expect(series.origin_lang).toBe('ja')

    // 新枚举值现在可写
    db.prepare(`UPDATE episodes SET sub_status='needs_review' WHERE id='e1'`).run()
    expect((db.prepare(`SELECT sub_status FROM episodes WHERE id='e1'`).get() as any).sub_status).toBe(
      'needs_review'
    )

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })

    db.close()
  })

  it('外键约束在重建后仍然生效（episodes.series_id → series.id）', () => {
    const db = openDb(':memory:')
    expect(() =>
      db
        .prepare(
          `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
           VALUES ('e1', 'no-such-series', 1, 1, 'E1', '/tv/e1.mkv', 'missing', ?)`
        )
        .run(Date.now())
    ).toThrow(/FOREIGN KEY constraint failed/)
    db.close()
  })
})
