// src/v2/migration.provider-ref.test.ts
// MS-P1 Task 7: subtitles/blacklist 从 assrt_sub_id（ASSRT 专属数字 id）迁移到
// provider_ref（"<provider>:<providerId>"，见 core/schemas.ts candidateKey）。
// 手法：手工重放到迁移前一版（只跑 MIGRATIONS[0]，不含本次新增迁移），插入旧形态的行，
// 再走 openDb 触发剩余迁移，校验回填结果。
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

describe('migration: provider_ref 回填（subtitles + blacklist）', () => {
  it('assrt_sub_id → provider_ref="assrt:<id>"；NULL assrt_sub_id → NULL provider_ref', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-')), 'scout.db')

    // 1. 手工建到"迁移前一版"：只执行 MIGRATIONS[0]，并手写 meta.schema_version='1'
    //    （openDb 本身才会在跑完每版迁移后写 meta，这里绕过它模拟"已在 v1 的旧库"）
    const raw = new Database(dbPath)
    raw.exec(MIGRATIONS[0])
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run()

    const now = Date.now()
    raw
      .prepare(
        `INSERT INTO subtitles (item_id, path, language, source, assrt_sub_id, created_at)
         VALUES (?, ?, 'zh-Hans', 'scout-download', ?, ?)`
      )
      .run('e1', '/tv/e1.zh-Hans.srt', 673114, now)
    raw
      .prepare(
        `INSERT INTO subtitles (item_id, path, language, source, assrt_sub_id, created_at)
         VALUES (?, ?, 'zh-Hans', 'preexisting', NULL, ?)`
      )
      .run('e2', '/tv/e2.zh-Hans.srt', now)
    raw
      .prepare(
        `INSERT INTO blacklist (assrt_sub_id, filename, reason, created_at) VALUES (?, ?, ?, ?)`
      )
      .run(99, 'bad.srt', 'mismatch', now)
    raw.close()

    // 2. openDb：currentVersion=1 < MIGRATIONS.length → 只跑剩余（本次新增的 provider_ref）迁移
    const db = openDb(dbPath)

    const sub1 = db
      .prepare('SELECT provider_ref FROM subtitles WHERE item_id = ?')
      .get('e1') as { provider_ref: string | null }
    expect(sub1.provider_ref).toBe('assrt:673114')

    const sub2 = db
      .prepare('SELECT provider_ref FROM subtitles WHERE item_id = ?')
      .get('e2') as { provider_ref: string | null }
    expect(sub2.provider_ref).toBeNull()

    const bl = db
      .prepare('SELECT provider_ref, filename, reason, created_at FROM blacklist')
      .get() as { provider_ref: string; filename: string; reason: string | null; created_at: number }
    expect(bl.provider_ref).toBe('assrt:99')
    expect(bl.filename).toBe('bad.srt')
    expect(bl.reason).toBe('mismatch')
    expect(bl.created_at).toBe(now)

    // 3. schema_version 追上最新（当前 = MIGRATIONS.length = 2）
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })

    db.close()
  })

  it('全新库（无历史数据）直接建表，provider_ref/blacklist 均可用', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-fresh-')), 'scout.db')
    const db = openDb(dbPath)

    // subtitles.provider_ref 列存在（PRAGMA table_info 校验，而非依赖插入）
    const subCols = (db.prepare('PRAGMA table_info(subtitles)').all() as { name: string }[]).map(
      c => c.name
    )
    expect(subCols).toContain('provider_ref')
    expect(subCols).toContain('assrt_sub_id') // 旧列保留，仅弃写

    const blCols = (db.prepare('PRAGMA table_info(blacklist)').all() as { name: string }[]).map(
      c => c.name
    )
    expect(blCols).toEqual(
      expect.arrayContaining(['provider_ref', 'filename', 'reason', 'created_at'])
    )
    expect(blCols).not.toContain('assrt_sub_id')

    db.close()
  })
})
