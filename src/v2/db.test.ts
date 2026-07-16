import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'

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
    // meta.schema_version = MIGRATIONS.length（数组下标+1，不是设计文档里的语义版本号 v9/v10/v11/v12
    // 本身）：v9 终态折叠成 1 条 entry 后是 '1'；胶水层修复战役追加 v10 entry 后 MIGRATIONS.length=2，
    // 落库值随之是 '2'；R-11 派活范围裁量化追加 v11 entry 后 MIGRATIONS.length=3，落库值是 '3'；
    // dashboard 重建战役 G1 追加 v12 entry 后 MIGRATIONS.length=4，落库值是 '4'。
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '4' })
  })
  it('重复打开幂等（不重跑建表）', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    openDb(p).close(); const db2 = openDb(p)
    expect(db2.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '4' })
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

  it('v10：series.layout_nonstandard / episodes.search_attempts / movies.search_attempts 三列存在', () => {
    const db = openDb(':memory:')
    const seriesCols = (db.prepare('PRAGMA table_info(series)').all() as { name: string }[]).map((c) => c.name)
    expect(seriesCols).toContain('layout_nonstandard')

    const episodeCols = (db.prepare('PRAGMA table_info(episodes)').all() as { name: string }[]).map((c) => c.name)
    expect(episodeCols).toContain('search_attempts')

    const movieCols = (db.prepare('PRAGMA table_info(movies)').all() as { name: string }[]).map((c) => c.name)
    expect(movieCols).toContain('search_attempts')
  })

  // R-11（用户裁决 2026-07-16）：派活范围是主代理的判断，不是系统常量——taskType 进 jobs_identity
  // 唯一索引的元组，find_subtitle 与 realign 对同一 series 不再共享一行身份。
  it('v11: find_subtitle 与 realign 对同一 series 不再共享身份（可同时各有一行 pending）', () => {
    const db = openDb(':memory:')
    const jobs = new JobsRepo(db)
    const now = Date.now()
    jobs.upsertWorkerTask({ seriesId: 'tmdb:9', season: null, movieId: null }, { taskType: 'find_subtitle', seasons: [3], reason: 'x' }, null, now)
    jobs.upsertWorkerTask({ seriesId: 'tmdb:9', season: null, movieId: null }, { taskType: 'realign', reason: 'y' }, null, now)
    const rows = db
      .prepare("SELECT kind, json_extract(payload,'$.taskType') as taskType FROM jobs WHERE series_id = 'tmdb:9'")
      .all() as { kind: string; taskType: string }[]
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.taskType).sort()).toEqual(['find_subtitle', 'realign'])
  })

  // v12（dashboard 重建战役 G1）：三张新表（应有集缓存 + 行为级设置 + 守备目录）+ runs 表加
  // trace_json 痕迹列。
  it('v12: tmdb_seasons/settings/media_roots 三表存在，runs 表有 trace_json 列', () => {
    const db = openDb(':memory:')
    const tables = db
      .prepare("select name from sqlite_master where type='table' order by name")
      .all()
      .map((r: any) => r.name)
    for (const t of ['tmdb_seasons', 'settings', 'media_roots']) expect(tables).toContain(t)

    const runsCols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)
    expect(runsCols).toContain('trace_json')
  })
})
