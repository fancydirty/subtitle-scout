import { describe, it, expect } from 'vitest'
import { openDb, MIGRATIONS } from './db.js'
import type { ScoutDb } from './db.js'

// spec: docs/design/2026-08-08-PIPELINE-SPEC.md §5「字幕存在性检测的两档机制」/ 裁决 D12·D16·D18
//
// 本文件只守 schema 层（列存在 + 迁移打散），检测逻辑本身是后续 task 的事。
// 为什么这几条断言值得单独立一个文件：D18 是一条**反缺陷裁决**——它存在的唯一理由是
// 前两条显然路都会炸（留 NULL + 纯谓词 = 静默失效；留 NULL + `IS NULL OR` = 首轮全库
// 45 次 stat 雪崩）。这类"为了不发生某件事"的实现最容易在后续重构里被顺手抹平（本仓
// 已经栽过三次同型：C12 → C35 → D17，都是"写了某列却没人读/没人写"），所以打散的
// **非 NULL**、**落在 7 天窗内**、**真的散开** 三件事必须各有一条测试钉住。

const SEVEN_DAYS_MS = 7 * 86400 * 1000

// 复刻 openDb() 迁移循环的分派（字符串 entry 走 exec / 函数 entry 直接调用）。
// 从 17 起而非 0：v9 折叠 entry 是裸 CREATE TABLE，重放会撞 "table already exists"；
// 17 起的尾部 entry 全是幂等的（条件式 ALTER / CREATE TABLE IF NOT EXISTS），
// 与 db.test.ts 既有用例同口径。用区间而非"最后一条"是为了不被日后追加的 v33 撬歪。
function replayTailMigrations(db: ScoutDb): void {
  for (let i = 17; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]
    if (typeof migration === 'function') migration(db)
    else db.exec(migration)
  }
}

// 造"迁移前的老库"：fresh install 的终态已含该列，故先摘掉它再重放迁移。
// 选 DROP COLUMN（SQLite 3.35+）而非手工 CREATE 一张 v31 形状的 files：手抄表定义会
// 随真实 schema 漂移成一份僵化副本，测试反而先于实现腐烂。
function openPreMigrationDb(): ScoutDb {
  const db = openDb(':memory:')
  db.exec('ALTER TABLE files DROP COLUMN sub_recheck_at')
  return db
}

function insertFile(db: ScoutDb, path: string): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(path, '/media', path.split('/').pop(), 1024, 1_700_000_000_000, 1_700_000_000_000)
}

function readAll(db: ScoutDb): Array<{ path: string; sub_recheck_at: number | null }> {
  return db.prepare('SELECT path, sub_recheck_at FROM files ORDER BY path').all() as Array<{
    path: string
    sub_recheck_at: number | null
  }>
}

describe('files.sub_recheck_at（D12 B 档轮转复核的到点列）', () => {
  it('fresh install 建出的 files 表含 sub_recheck_at 列', () => {
    const db = openDb(':memory:')
    try {
      const columns = (db.prepare('PRAGMA table_info(files)').all() as Array<{
        name: string
        type: string
      }>)
      const column = columns.find((c) => c.name === 'sub_recheck_at')
      expect(column).toBeDefined()
      expect(column?.type).toBe('INTEGER')
    } finally {
      db.close()
    }
  })

  it('迁移后存量行的 sub_recheck_at 不为 NULL（D18：不留 NULL）', () => {
    const db = openPreMigrationDb()
    try {
      for (let i = 0; i < 5; i++) insertFile(db, `/media/old-${i}.mkv`)
      // 前置确认这些行**确实**是"迁移前"形状（列还不存在），否则下面的断言可能在测一个假的
      // 前提——列若已在，ALTER 会被跳过、UPDATE 也可能无事可做，测试就成了空转。
      const columnsBefore = (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
      expect(columnsBefore.some((c) => c.name === 'sub_recheck_at')).toBe(false)

      replayTailMigrations(db)

      const rows = readAll(db)
      expect(rows).toHaveLength(5)
      for (const row of rows) expect(row.sub_recheck_at).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('打散范围落在 (now, now+7天] 内（既不在过去、也不超出一个复核周期）', () => {
    const db = openPreMigrationDb()
    try {
      for (let i = 0; i < 30; i++) insertFile(db, `/media/scatter-${i}.mkv`)

      const before = Date.now()
      replayTailMigrations(db)
      const after = Date.now()

      for (const row of readAll(db)) {
        const value = row.sub_recheck_at as number
        // 下界用 before（而非严格 > now）：`abs(random() % N)` 可能取 0，
        // 落在"恰好 now"是合法的——重点是**不在过去**，否则首轮就全库命中 = 雪崩。
        expect(value).toBeGreaterThanOrEqual(before)
        expect(value).toBeLessThanOrEqual(after + SEVEN_DAYS_MS)
      }
    } finally {
      db.close()
    }
  })

  it('打散是真的散开：50 行至少 40 个不同时刻（防"全部设成同一时刻"= 雪崩延后 7 天）', () => {
    const db = openPreMigrationDb()
    try {
      for (let i = 0; i < 50; i++) insertFile(db, `/media/spread-${i}.mkv`)

      replayTailMigrations(db)

      const distinct = new Set(readAll(db).map((r) => r.sub_recheck_at))
      expect(distinct.size).toBeGreaterThanOrEqual(40)
    } finally {
      db.close()
    }
  })

  it('迁移幂等：连续重放两次不抛错、不重复加列', () => {
    const db = openPreMigrationDb()
    try {
      insertFile(db, '/media/idempotent.mkv')

      expect(() => {
        replayTailMigrations(db)
        replayTailMigrations(db)
      }).not.toThrow()

      const occurrences = (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .filter((c) => c.name === 'sub_recheck_at')
      expect(occurrences).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('老库没有 files 表时迁移不抛错（同 v29/v31 的条件式 ALTER 口径）', () => {
    const db = openDb(':memory:')
    try {
      db.exec('DROP TABLE files')
      expect(() => replayTailMigrations(db)).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('已有非 NULL 值的行不被覆盖（重跑迁移不该重置已安排好的复核时刻）', () => {
    const db = openPreMigrationDb()
    try {
      insertFile(db, '/media/scheduled.mkv')
      replayTailMigrations(db)

      // 模拟"B 档已经排好了下一次复核"——用一个绝不会被随机撞上的哨兵值
      const sentinel = 4_000_000_000_000
      db.prepare('UPDATE files SET sub_recheck_at = ? WHERE path = ?').run(sentinel, '/media/scheduled.mkv')

      replayTailMigrations(db)

      const row = readAll(db)[0]
      expect(row.sub_recheck_at).toBe(sentinel)
    } finally {
      db.close()
    }
  })
})
