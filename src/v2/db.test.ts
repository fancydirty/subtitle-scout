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
      'parked_paths', 'identify_overrides', 'extras_exemptions', 'item_files',
    ]) expect(tables).toContain(t)
    // meta.schema_version = MIGRATIONS.length（数组下标+1，不是设计文档里的语义版本号 v9/v10/v11/v12
    // 本身）：v9 终态折叠成 1 条 entry 后是 '1'；胶水层修复战役追加 v10 entry 后 MIGRATIONS.length=2，
    // 落库值随之是 '2'；R-11 派活范围裁量化追加 v11 entry 后 MIGRATIONS.length=3，落库值是 '3'；
    // dashboard 重建战役 G1 追加 v12 entry 后 MIGRATIONS.length=4，落库值是 '4'；验收修复轮一
    // Task V1 追加 v13 entry 后 MIGRATIONS.length=5，落库值是 '5'；救援R4b 追加 v14
    // extras_exemptions entry 后 MIGRATIONS.length=6，落库值是 '6'；救援R5 追加 v15
    // hardsub-assumed 值域重建 entry 后 MIGRATIONS.length=7，落库值是 '7'；重复源 P1 追加 v16
    // item_files+subtitles.file_path entry 后 MIGRATIONS.length=8，落库值是 '8'。
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '8' })
  })
  it('重复打开幂等（不重跑建表）', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    openDb(p).close(); const db2 = openDb(p)
    expect(db2.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '8' })
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

  // v13（验收修复轮一 Task V1，design: 2026-07-17-acceptance-round-1-design.md §A）：分区
  // 元数据化——series 加 genres 列（TMDB genre id 的 JSON 数组，NULL=尚未富化）。
  it('v13: series.genres 列存在', () => {
    const db = openDb(':memory:')
    const seriesCols = (db.prepare('PRAGMA table_info(series)').all() as { name: string }[]).map((c) => c.name)
    expect(seriesCols).toContain('genres')
  })

  // v15（救援R5）：episodes/movies.sub_status 的 CHECK 约束收 'hardsub-assumed'——CHECK 约束
  // 不能 ALTER，只能建新表→拷数据→改名（见 MIGRATIONS v15 entry 注释）。这条测试锁住"新值真的
  // 能写入"（不是只改了注释没改约束——CHECK 约束的枚举字符串手抄错一个字就会静默漏收）。
  it('v15: episodes/movies.sub_status 接受 hardsub-assumed（真实插入，不只是 PRAGMA 读列名）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO series (id, name) VALUES ('tmdb:1', 'S')`).run()
    // 新值可插入
    expect(() =>
      db
        .prepare(
          `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
           VALUES ('tmdb:1/s1e1', 'tmdb:1', 1, 1, 'E1', '/p', 'hardsub-assumed', 1000)`
        )
        .run()
    ).not.toThrow()
    // 旧枚举值原样合法（约束是"增补"不是"替换"）
    expect(() =>
      db
        .prepare(
          `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
           VALUES ('tmdb:1/s1e2', 'tmdb:1', 1, 2, 'E2', '/p2', 'covered', 1000)`
        )
        .run()
    ).not.toThrow()
    // 非法值仍被拒绝（约束没被松到"随便什么字符串都收"）
    expect(() =>
      db
        .prepare(
          `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
           VALUES ('tmdb:1/s1e3', 'tmdb:1', 1, 3, 'E3', '/p3', 'not-a-real-status', 1000)`
        )
        .run()
    ).toThrow()

    db.prepare(
      `INSERT INTO movies (id, name, path, sub_status, updated_at) VALUES ('tmdb:2', 'M', '/m', 'hardsub-assumed', 1000)`
    ).run()
    expect(db.prepare(`SELECT sub_status FROM movies WHERE id = 'tmdb:2'`).get()).toEqual({
      sub_status: 'hardsub-assumed',
    })
  })

  // 迁移安全性核心断言：真·旧库（v14 形状，无 hardsub-assumed 支持）里已有的数据在升级到 v15
  // 后必须原样存活——12 步建新表手法最容易犯的错就是拷数据时列漏了/顺序错了导致静默丢数据或
  // 串列（如 name 值跑进了 path 列）。这里手搭一个 v14 形状的库（不经过完整 MIGRATIONS 链，
  // 直接照 v14 终态列清单建表——与 db.ts 里 v15 entry 重建时用的列清单是同一份真相源，若两处
  // 手抄出现字段顺序不一致，这条测试会因取到错位的值而失败），插入代表性行，重新 openDb() 触发
  // v15 迁移，断言行数与字段值原样不变，且新库确实支持新值。
  it('v15 迁移安全性：v14 形状旧库升级后，既有 episodes/movies 行原样存活（不丢数据不串列）', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    const Database = (openDb(':memory:').constructor) as new (path: string) => import('better-sqlite3').Database
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      CREATE TABLE series (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT, year INTEGER,
        provider_ids TEXT, layout_nonstandard INTEGER NOT NULL DEFAULT 0, genres TEXT
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
        season INTEGER NOT NULL, episode INTEGER NOT NULL, name TEXT, path TEXT NOT NULL,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE movies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT,
        year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        origin_lang TEXT, probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, series_id TEXT, season INTEGER, movie_id TEXT, plan_ref TEXT, payload TEXT, parent_job_id INTEGER, state TEXT NOT NULL DEFAULT 'wanted', priority INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER, last_error TEXT);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, decision TEXT, detail TEXT, journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER, trace_json TEXT);
      CREATE TABLE subtitles (item_id TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, installed_at INTEGER NOT NULL);
      CREATE TABLE blacklist (provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider_ref, filename));
      CREATE TABLE parked_paths (path TEXT PRIMARY KEY, park_reason TEXT NOT NULL, first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL);
      CREATE TABLE identify_overrides (path_prefix TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL, is_tv INTEGER NOT NULL, season INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tmdb_seasons (series_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, title TEXT, fetched_at INTEGER NOT NULL, PRIMARY KEY (series_id, season, episode));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE media_roots (path TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'local', added_at INTEGER NOT NULL);
      CREATE TABLE extras_exemptions (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '6');
      INSERT INTO series (id, name) VALUES ('tmdb:100', 'Preexisting Show');
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
        VALUES ('tmdb:100/s1e1', 'tmdb:100', 1, 1, 'Ep1', '/media/ep1.mkv', 'covered', 5000);
      INSERT INTO movies (id, name, path, sub_status, updated_at)
        VALUES ('tmdb:200', 'Preexisting Movie', '/media/movie.mkv', 'missing', 6000);
    `)
    raw.pragma('foreign_keys = ON')
    raw.close()

    const db = openDb(dbPath)

    // v14 形状库（seeded schema_version '6'）经 openDb 会连跑 v15+v16 两条迁移到 '8'。
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '8' })
    expect(db.prepare(`SELECT * FROM episodes WHERE id = 'tmdb:100/s1e1'`).get()).toMatchObject({
      series_id: 'tmdb:100', season: 1, episode: 1, name: 'Ep1', path: '/media/ep1.mkv',
      sub_status: 'covered', updated_at: 5000,
    })
    expect(db.prepare(`SELECT * FROM movies WHERE id = 'tmdb:200'`).get()).toMatchObject({
      name: 'Preexisting Movie', path: '/media/movie.mkv', sub_status: 'missing', updated_at: 6000,
    })
    // 迁移后的库确实支持新值——不是只重建了表结构但约束还是老的。
    expect(() =>
      db.prepare(`UPDATE episodes SET sub_status = 'hardsub-assumed' WHERE id = 'tmdb:100/s1e1'`).run()
    ).not.toThrow()
  })

  // v16（重复源 P1）：item_files 表 + subtitles.file_path 列，纯增量。列出表存在 + 新列可写 +
  // subtitles 存量行 file_path 默认 NULL（兼容语义：NULL=挂主文件）。
  it('v16: item_files 表存在且 path UNIQUE，subtitles.file_path 列存在（存量行默认 NULL）', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(item_files)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['id', 'item_id', 'path', 'added_at'])
    const subCols = (db.prepare('PRAGMA table_info(subtitles)').all() as { name: string }[]).map((c) => c.name)
    expect(subCols).toContain('file_path')

    // item_files.path UNIQUE 生效
    db.prepare(`INSERT INTO item_files (item_id, path, added_at) VALUES ('tmdb:1/s1e1', '/media/a.mkv', 1)`).run()
    expect(() =>
      db.prepare(`INSERT INTO item_files (item_id, path, added_at) VALUES ('tmdb:1/s1e2', '/media/a.mkv', 2)`).run()
    ).toThrow()

    // subtitles.file_path 存量行默认 NULL（兼容：不带 file_path 的插入=挂主文件）
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES ('tmdb:1/s1e1', '/media/a.zh.srt', 'zh-Hans', 'scout-download', 1)`).run()
    expect(db.prepare(`SELECT file_path FROM subtitles WHERE item_id = 'tmdb:1/s1e1'`).get()).toEqual({ file_path: null })
  })
})
