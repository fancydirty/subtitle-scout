import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb, type ScoutDb } from './db.js'
import {
  runDbMaintenance, makeMaintenanceState,
  CHECKPOINT_EVERY_MS, BACKUP_EVERY_MS, BACKUP_RETAIN,
} from './dbMaintenance.js'

let dir: string
let db: ScoutDb

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'db-maint-'))
  db = openDb(join(dir, 'scout.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('runDbMaintenance', () => {
  it('到点 checkpoint(TRUNCATE),未到点不动', () => {
    const s = makeMaintenanceState()
    const r1 = runDbMaintenance(db, dir, s, 1000)
    expect(r1.checkpointed).toBe(true)
    expect(s.lastCheckpointAt).toBe(1000)
    const r2 = runDbMaintenance(db, dir, s, 1000 + CHECKPOINT_EVERY_MS - 1)
    expect(r2.checkpointed).toBe(false)
    const r3 = runDbMaintenance(db, dir, s, 1000 + CHECKPOINT_EVERY_MS)
    expect(r3.checkpointed).toBe(true)
  })

  it('到点 VACUUM INTO 备份到 backups/scout-<date>.db,快照可读且含数据', () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('k','v',1)").run()
    const s = makeMaintenanceState()
    const now = Date.parse('2026-07-21T12:00:00Z')
    const r = runDbMaintenance(db, dir, s, now)
    expect(r.backupPath).toBe(join(dir, 'backups', 'scout-20260721.db'))
    expect(existsSync(r.backupPath!)).toBe(true)
    const snap = openDb(r.backupPath!)
    expect(snap.prepare("SELECT value FROM settings WHERE key='k'").get()).toEqual({ value: 'v' })
    snap.close()
  })

  it('备份时间门:同一天内不重复', () => {
    const s = makeMaintenanceState()
    const now = Date.parse('2026-07-21T12:00:00Z')
    runDbMaintenance(db, dir, s, now)
    const r = runDbMaintenance(db, dir, s, now + BACKUP_EVERY_MS - 1)
    expect(r.backupPath).toBeNull()
  })

  it('保留最近 N 份,老档被清理', () => {
    const s = makeMaintenanceState()
    const dir2 = join(dir, 'backups')
    mkdirSyncAndSeed(dir2, 9)
    const now = Date.parse('2026-07-30T12:00:00Z')
    runDbMaintenance(db, dir, s, now)
    const left = readdirSync(dir2).filter((f) => /^scout-\d{8}\.db$/.test(f)).sort()
    expect(left.length).toBe(BACKUP_RETAIN)
    expect(left[left.length - 1]).toBe('scout-20260730.db')
    expect(left[0]).toBe('scout-20260724.db') // 10 份留 7:最老三份(21/22/23)被清
  })
})

function mkdirSyncAndSeed(dir2: string, days: number) {
  mkdirSync(dir2, { recursive: true })
  for (let i = 1; i <= days; i++) {
    writeFileSync(join(dir2, `scout-202607${String(20 + i).padStart(2, '0')}.db`), 'x')
  }
}
