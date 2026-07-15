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
    for (const t of [
      'series', 'episodes', 'movies', 'jobs', 'runs', 'subtitles', 'blacklist', 'meta',
      'parked_paths', 'identify_overrides',
    ]) expect(tables).toContain(t)
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '1' })
  })
  it('重复打开幂等（不重跑建表）', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    openDb(p).close(); const db2 = openDb(p)
    expect(db2.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '1' })
  })

  it('v9 终态：series/movies 用 poster_path，无 poster_tag；episodes/movies 有探针 memo 列', () => {
    const db = openDb(':memory:')
    const seriesCols = (db.prepare('PRAGMA table_info(series)').all() as { name: string }[]).map((c) => c.name)
    expect(seriesCols).toContain('poster_path')
    expect(seriesCols).not.toContain('poster_tag')

    const movieCols = (db.prepare('PRAGMA table_info(movies)').all() as { name: string }[]).map((c) => c.name)
    expect(movieCols).toContain('poster_path')
    expect(movieCols).not.toContain('poster_tag')
    expect(movieCols).toEqual(expect.arrayContaining(['probe_mtime', 'probe_size', 'embedded_langs']))

    const episodeCols = (db.prepare('PRAGMA table_info(episodes)').all() as { name: string }[]).map((c) => c.name)
    expect(episodeCols).toEqual(expect.arrayContaining(['probe_mtime', 'probe_size', 'embedded_langs']))
  })

  it('v9 终态：parked_paths / identify_overrides 列形状齐全', () => {
    const db = openDb(':memory:')
    const parkedCols = (db.prepare('PRAGMA table_info(parked_paths)').all() as { name: string }[]).map((c) => c.name)
    expect(parkedCols).toEqual(['path', 'park_reason', 'first_seen', 'last_attempt'])

    const overrideCols = (db.prepare('PRAGMA table_info(identify_overrides)').all() as { name: string }[]).map((c) => c.name)
    expect(overrideCols).toEqual(['path_prefix', 'tmdb_id', 'is_tv', 'season', 'created_at'])
  })
})
