import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'

describe('db 基座', () => {
  it('打开即建 schema，pragma 三件套生效', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r: any) => r.name)
    for (const t of ['series', 'episodes', 'movies', 'jobs', 'runs', 'subtitles', 'blacklist', 'meta']) expect(tables).toContain(t)
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '3' })
  })
  it('重复打开幂等（不重跑建表）', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    openDb(p).close(); const db2 = openDb(p)
    expect(db2.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '3' })
  })
})
