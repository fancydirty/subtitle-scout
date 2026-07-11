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

  it('迁移前置体检：v3 存量库里蛰伏的孤儿 episode（series_id 指向已不存在的 series）在 v5 重建表之前就被清楚拦下，不是半途 FK 崩溃回滚', () => {
    // 复现：老库在某次 foreign_keys=OFF 的会话里写入过一行 series_id 指向不存在 series
    // 的 episode（比如直接用 sqlite3 CLI 改数据、或从旧备份 .dump 导回未逐条校验）——
    // 声明的外键从未在写入时被真正验证过，数据静静地蛰伏着。之后升级到本次 needs_review
    // 迁移（v5）：episodes 要被拷进新建的 episodes_new（同样声明该外键，且 openDb 已经把
    // foreign_keys pragma 打开），INSERT INTO ... SELECT 撞见这行孤儿数据时会在建表迁移
    // 中途抛 FOREIGN KEY constraint failed。修正前：单事务迁移虽然干净回滚回 v3，但守护
    // 进程接下来每次启动都拿着这句晦涩报错反复炸，直到有人翻 SQL 手工揪出脏行。修正后：
    // openDb 在动手迁移之前先 PRAGMA foreign_key_check 体检一遍，抛出指名表名/rowid 的
    // 清楚报错，db 完全没进入迁移事务，原地留在 v3。
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-orphan-')), 'scout.db')

    const raw = new Database(dbPath)
    for (let i = 0; i < 3; i++) raw.exec(MIGRATIONS[i]) // 手工建到 v3（早于本次 needs_review 迁移）
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run()

    const now = Date.now()
    // better-sqlite3 默认把 foreign_keys pragma 打开，所以要显式关掉才能塞进这行孤儿
    // 数据——模拟它是在某次外键校验关闭的窗口期写入、从未被验证过的历史脏数据。
    raw.pragma('foreign_keys = OFF')
    raw
      .prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
         VALUES ('e-orphan', 'no-such-series', 1, 1, 'E1', '/tv/e1.mkv', 'missing', ?)`
      )
      .run(now)
    raw.close()

    let caught: unknown
    try {
      openDb(dbPath)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/外键违例/)
    expect(message).toMatch(/episodes/)
    expect(message).toMatch(/e-orphan/)

    // db 原地留在 v3——迁移完全没执行，不是跑到一半又回滚
    const check = new Database(dbPath)
    expect(check.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: '3',
    })
    // v4 加的 error_attempt 列不存在，证实迁移事务连开都没开
    const jobsCols = (check.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map(
      (c) => c.name
    )
    expect(jobsCols).not.toContain('error_attempt')
    check.close()
  })
})
