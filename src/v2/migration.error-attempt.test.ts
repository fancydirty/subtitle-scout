// src/v2/migration.error-attempt.test.ts
// 双轨 attempt 审计修正 Task 1：jobs.attempt 今天同时被 completeNoMatch（内容退避梯）和
// completeError（瞬时错误短退避梯）充电，两者混同会互相污染对方的判据（见 jobsRepo.ts 顶部
// 注释）。根治：新增独立持久列 error_attempt 只服务瞬时错误轨，attempt 只服务内容轨。
// 手法同 migration.provider-ref.test.ts：手工重放到迁移前一版，插入旧形态数据，
// 再走 openDb 触发剩余迁移，校验存量数据无损、新列可用。
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

describe('migration: error_attempt（独立瞬时错误退避计数器）', () => {
  it('全新库：jobs.error_attempt 列存在，默认 0', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('error_attempt')
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, created_at, updated_at)
       VALUES ('series_season', 's1', 1, 'wanted', 0, 0, ?, ?)`
    ).run(Date.now(), Date.now())
    const row = db.prepare(`SELECT error_attempt FROM jobs WHERE series_id='s1'`).get() as {
      error_attempt: number
    }
    expect(row.error_attempt).toBe(0)
    db.close()
  })

  it('存量库（迁移前旧版）：已有 jobs 行无损迁移，error_attempt 回填为 0', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-errattempt-')), 'scout.db')

    // 手工建到"本次迁移前一版"：跑 MIGRATIONS[0..2]（v1 初始 schema + v2 provider_ref + v3 origin_lang），
    // 手写 meta.schema_version='3'，模拟一台已在生产跑了一阵子、attempt 已经攒了历史值的旧库。
    const raw = new Database(dbPath)
    raw.exec(MIGRATIONS[0])
    raw.exec(MIGRATIONS[1])
    raw.exec(MIGRATIONS[2])
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '3')").run()

    const now = Date.now()
    raw
      .prepare(
        `INSERT INTO jobs (kind, series_id, season, state, priority, attempt, next_retry_at, created_at, updated_at)
         VALUES ('series_season', 's1', 4, 'failed', 0, 3, ?, ?, ?)`
      )
      .run(now + 86_400_000, now, now)
    raw.close()

    // openDb: currentVersion=3 < MIGRATIONS.length → 只跑剩余迁移
    const db = openDb(dbPath)

    const row = db.prepare(`SELECT attempt, error_attempt, state FROM jobs WHERE series_id='s1'`).get() as {
      attempt: number
      error_attempt: number
      state: string
    }
    // 存量 attempt（内容退避梯历史）无损保留
    expect(row.attempt).toBe(3)
    expect(row.state).toBe('failed')
    // 新列回填默认值 0（旧库从未有过瞬时错误计数，不能凭空继承内容失败次数）
    expect(row.error_attempt).toBe(0)

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })

    db.close()
  })
})
