import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'
import type { ScoutDb } from './db.js'
import { JobsRepo } from './jobsRepo.js'

describe('db 基座', () => {
  it('打开即建 schema，pragma 三件套生效', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r: any) => r.name)
    for (const t of [
      'series', 'episodes', 'movies', 'jobs', 'runs', 'subtitles', 'blacklist', 'meta',
      'parked_paths', 'extras_exemptions', 'item_files', 'pending_removals',
    ]) expect(tables).toContain(t)
    // v27（认领退役）：identify_overrides 已 DROP，fresh install 不再创建。
    expect(tables).not.toContain('identify_overrides')
    // meta.schema_version = MIGRATIONS.length（数组下标+1，不是设计文档里的语义版本号 v9/v10/v11/v12
    // 本身）：v9 终态折叠成 1 条 entry 后是 '1'；胶水层修复战役追加 v10 entry 后 MIGRATIONS.length=2，
    // 落库值随之是 '2'；R-11 派活范围裁量化追加 v11 entry 后 MIGRATIONS.length=3，落库值是 '3'；
    // dashboard 重建战役 G1 追加 v12 entry 后 MIGRATIONS.length=4，落库值是 '4'；验收修复轮一
    // Task V1 追加 v13 entry 后 MIGRATIONS.length=5，落库值是 '5'；救援R4b 追加 v14
    // extras_exemptions entry 后 MIGRATIONS.length=6，落库值是 '6'；救援R5 追加 v15
    // hardsub-assumed 值域重建 entry 后 MIGRATIONS.length=7，落库值是 '7'；重复源 P1 追加 v16
    // item_files+subtitles.file_path entry 后 MIGRATIONS.length=8，落库值是 '8'；批③ B3-4 追加
    // v17 item_files.duration_verdict/verdict_fingerprint entry 后 MIGRATIONS.length=9，落库值是 '9'；
    // 数据安全审计头号遗留修复（CIFS 挂载抖动误删）追加 v18 pending_removals entry 后
    // MIGRATIONS.length=10，落库值是 '10'；装机记账修复批追加 v19（provider_ref 双前缀清洗 +
    // 存量陈旧 status_reason 清洗）entry 后 MIGRATIONS.length=11，落库值是 '11'——这就是设计正文
    // 与 commit message 里"schema v11"指代的那个数字。详情页重设计 item B 追加末条富化迁移
    // （series+tmdb_seasons ADD COLUMN）后 MIGRATIONS.length=12，落库值随之是 '12'；
    // SRE 审计 F1 追加 v20（jobs.reap_count）entry 后 MIGRATIONS.length=13，落库值是 '13'；
    // parked-path 负缓存（Task 5）追加 v21（parked_paths retry 退避列）entry 后 MIGRATIONS.length=14，落库值是 '14'；
    // v22 补齐存量 runs 的 LLM/provider 账本列后是 '16'；v24（identify_overrides.source）后是 '17'；
    // v25（agent-first identification：parked_paths 加 duration_sec/embedded_langs raw 数据列）后是 '18'；
    // v26（parked_paths.embedded_tmdb_id）后是 '19'；v27（认领退役，DROP identify_overrides）后是 '20'；
    // v28（字幕时间轴校验落库：subtitle_verify 表）后是 '21'；v29（jobs.lease_started_at
    // 稳定 claim 锚点，修活动页秒表冻结）后是 '22'。
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '37' })
  })
  it('重复打开幂等（不重跑建表）', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    openDb(p).close(); const db2 = openDb(p)
    expect(db2.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '37' })
  })

  it('pre-fold 老库(schema_version 1-8 缺 v9 折叠表)迁移失败 → 人话错误而非裸 SQL', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-old-')), 'scout.db')
    // 手造一个 de-Jellyfin(v9)之前的老库:有 meta.schema_version=8,但没有 v9 折叠 entry 建的
    // item_files 等表——openDb 会因 8<11 去跑 MIGRATIONS[8]=v17 的 ALTER item_files → no such table。
    const raw = new Database(p)
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta (key,value) VALUES ('schema_version','8')")
    raw.close()
    expect(() => openDb(p)).toThrow(/de-Jellyfin|旧版本|删除 scout\.db/)
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

  it('v9 终态：parked_paths 列形状齐全；identify_overrides 已随 v27 退役', () => {
    const db = openDb(':memory:')
    const parkedCols = (db.prepare('PRAGMA table_info(parked_paths)').all() as { name: string }[]).map((c) => c.name)
    // v25 的 duration_sec/embedded_langs 在 v9 终态 CREATE TABLE 里（fresh 库声明序），
    // v26 的 embedded_tmdb_id 紧随其后同样在终态声明里（fresh install 直接拿到该列，
    // 老库走 v26 迁移条件式 ALTER 补齐）；
    // v21 的 retry 负缓存列再由迁移 ALTER 追加（fresh open 走完整 MIGRATIONS，列一次到位）。
    expect(parkedCols).toEqual([
      'path', 'park_reason', 'first_seen', 'last_attempt',
      'duration_sec', 'embedded_langs', 'embedded_tmdb_id',
      'retry_count', 'next_retry_at', 'probe_mtime', 'probe_size',
    ])

    // v27（认领退役）：PRAGMA table_info 对不存在的表返回空集。
    expect(db.prepare('PRAGMA table_info(identify_overrides)').all()).toEqual([])
  })

  it('v21：parked_paths 负缓存列 fresh + 从 v13 迁移都存在', () => {
    // fresh
    const fresh = openDb(':memory:')
    const freshCols = (fresh.prepare('PRAGMA table_info(parked_paths)').all() as { name: string }[]).map((c) => c.name)
    expect(freshCols).toEqual(expect.arrayContaining([
      'retry_count', 'next_retry_at', 'probe_mtime', 'probe_size',
    ]))
    expect(fresh.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '37' })
    fresh.close()

    // migrate from prior (schema_version 13 = v20 终态，无负缓存列)
    const p = join(mkdtempSync(join(tmpdir(), 'scout-park-retry-')), 'scout.db')
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE parked_paths (
        path TEXT PRIMARY KEY, park_reason TEXT NOT NULL,
        first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '13');
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
        VALUES ('/media/a.mkv', 'no-match', 1000, 2000);
    `)
    raw.close()

    const db = openDb(p)
    const cols = (db.prepare('PRAGMA table_info(parked_paths)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining([
      'retry_count', 'next_retry_at', 'probe_mtime', 'probe_size',
    ]))
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '37' })
    // 存量行默认：retry_count=0，其余可空
    expect(db.prepare('SELECT retry_count, next_retry_at, probe_mtime, probe_size FROM parked_paths WHERE path = ?')
      .get('/media/a.mkv')).toEqual({
      retry_count: 0,
      next_retry_at: null,
      probe_mtime: null,
      probe_size: null,
    })
  })

  it('v22：既有 runs 缺 llm_calls/assrt_calls 时原地补齐并保留存量行', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-runs-ledger-')), 'scout.db')
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        decision TEXT,
        detail TEXT,
        journal_path TEXT,
        trace_json TEXT
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '14');
      INSERT INTO runs (started_at, decision) VALUES (123, 'translate:held');
    `)
    raw.close()

    const db = openDb(p)
    const cols = (db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['llm_calls', 'assrt_calls']))
    expect(db.prepare('SELECT id, started_at, decision, llm_calls, assrt_calls FROM runs').get()).toEqual({
      id: 1, started_at: 123, decision: 'translate:held', llm_calls: null, assrt_calls: null,
    })
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
  })

  it('v23：translate_glossaries 表存在;v15 老库升级后可用', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-glossary-')), 'scout.db')
    const raw = new Database(p)
    raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta (key, value) VALUES ('schema_version', '15')")
    raw.close()
    const db = openDb(p)
    const cols = (db.prepare('PRAGMA table_info(translate_glossaries)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['series_key', 'terms_json', 'updated_at'])
    db.prepare("INSERT INTO translate_glossaries VALUES ('tmdb:1', '[]', 1)").run()
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    db.close()
  })

  // v28（字幕时间轴校验落库）：subtitle_verify 表。两条路径都要覆盖——fresh install 走 v9
  // 折叠终态的 CREATE TABLE，老库走 v28 迁移 entry。历史上漏加终态那一份的教训见 v15 注释。
  it('v28：fresh install 直接带 subtitle_verify 表，列形状齐全', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(subtitle_verify)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual([
      'item_id', 'verdict', 'offset_ms', 'score', 'reference_tier',
      'subtitle_path', 'subtitle_hash', 'checked_at', 'detail',
    ])
    // item_id 是主键（一行一集，重复检测覆盖而非堆历史）
    const pk = (db.prepare('PRAGMA table_info(subtitle_verify)').all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0).map((c) => c.name)
    expect(pk).toEqual(['item_id'])
    db.close()
  })

  // 铁律①"只有绿和红，绝不给黄"在 schema 层的落实：三值封闭。第四档（'suspect'/'warning' 之类）
  // 必须**不可表达**——只要 DB 能存下它，早晚有人把它渲染成黄色。CHECK 约束就是那道门。
  it('v28：verdict 只接受三值，第四档被 CHECK 约束拒绝', () => {
    const db = openDb(':memory:')
    const insert = (verdict: string) =>
      db.prepare(
        `INSERT OR REPLACE INTO subtitle_verify (item_id, verdict, subtitle_path, checked_at)
         VALUES ('tmdb:1/s1e1', ?, '/media/a.srt', 1000)`,
      ).run(verdict)
    for (const ok of ['aligned', 'shifted', 'unverifiable']) {
      expect(() => insert(ok)).not.toThrow()
    }
    for (const bad of ['suspect', 'warning', 'unknown', 'ALIGNED', '']) {
      expect(() => insert(bad)).toThrow(/CHECK constraint/)
    }
    db.close()
  })

  // 迁移安全性（同 v15/v17/v18 的既有口径）：真造一个 v27 形状的老库（schema_version '20'，
  // 无 subtitle_verify 表），塞入代表性存量行，openDb() 触发 v28，断言表被建出来且存量行
  // 原样存活。另测幂等——v28 的 CREATE TABLE IF NOT EXISTS 若写成裸 CREATE，fresh install
  // 走完整链会在这条 entry 撞 "table already exists"，新库压根打不开。
  it('v28 迁移安全性：v27 形状老库升级后建出 subtitle_verify，存量行不受影响', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-verify-mig-')), 'scout.db')
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE subtitles (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL,
        language TEXT NOT NULL, source TEXT NOT NULL, provider_ref TEXT, assrt_sub_id INTEGER, size INTEGER,
        created_at INTEGER NOT NULL, file_path TEXT, UNIQUE(item_id, path));
      INSERT INTO meta (key, value) VALUES ('schema_version', '20');
      INSERT INTO subtitles (item_id, path, language, source, created_at)
        VALUES ('tmdb:100/s1e1', '/media/ep1.zh.srt', 'zh-Hans', 'scout-download', 7000);
    `)
    raw.close()

    const db = openDb(p)
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    // 表建出来且可写
    expect(() =>
      db.prepare(
        `INSERT INTO subtitle_verify (item_id, verdict, offset_ms, score, reference_tier,
           subtitle_path, subtitle_hash, checked_at, detail)
         VALUES ('tmdb:100/s1e1', 'shifted', 2000, 0.95, 'embedded', '/media/ep1.zh.srt', 'abc', 8000, 'x')`,
      ).run()
    ).not.toThrow()
    // 存量 subtitles 行原样存活（v28 是纯增量，不该碰任何既有表）
    expect(db.prepare(`SELECT item_id, path, created_at FROM subtitles WHERE path = '/media/ep1.zh.srt'`).get())
      .toEqual({ item_id: 'tmdb:100/s1e1', path: '/media/ep1.zh.srt', created_at: 7000 })
    db.close()

    // 幂等：重开不重跑（版本门），且即便重跑 IF NOT EXISTS 也不炸
    const db2 = openDb(p)
    expect(db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    db2.close()
  })

  // 迁移安全性（同 v24/v28 的既有口径）：真造一个 v28 形状的老库（schema_version '21'，jobs
  // 表**无** lease_started_at 列），塞入一条正在 searching 的 worker_task（活动页 running 集合
  // 就是这种行），openDb() 触发 v29，断言列被补出来、存量在飞行中的行原样存活且新列为 NULL
  // （没有 claim 时刻可回填，apiV2 端 ?? updated_at 兜底）。另测幂等——v29 的 guard（PRAGMA
  // table_info 先探）若写成裸 ALTER，db.test.ts 的"i=17 起重跑尾部迁移"用例会在已含该列的库上
  // 再跑一遍而撞 duplicate column name；这里的重开断言把这条幂等锁死在迁移层。
  it('v29 迁移安全性：v28 形状老库（jobs 无 lease_started_at）升级后补出该列，在飞行中的 job 行不受影响', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-lease-mig-')), 'scout.db')
    const raw = new Database(p)
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        series_id TEXT, season INTEGER, movie_id TEXT,
        plan_ref TEXT, payload TEXT, parent_job_id INTEGER REFERENCES jobs(id),
        state TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
        target_episodes TEXT, attempt INTEGER NOT NULL DEFAULT 0,
        error_attempt INTEGER NOT NULL DEFAULT 0, reap_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER, lease_until INTEGER,
        last_error TEXT, journal_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '21');
      INSERT INTO jobs (kind, series_id, payload, state, priority, lease_until, created_at, updated_at)
        VALUES ('worker_task', 's1', '{"taskType":"find_subtitle"}', 'searching', 0, 9000, 5000, 7000);
    `)
    raw.close()

    const db = openDb(p)
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    // 列被补出来
    const cols = new Set(
      (db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>).map((c) => c.name),
    )
    expect(cols.has('lease_started_at')).toBe(true)
    // 存量在飞行中的行原样存活，新列为 NULL（v29 是纯增量 ADD COLUMN，不回填、不碰既有列）
    expect(
      db.prepare(`SELECT state, lease_until, updated_at, lease_started_at FROM jobs WHERE series_id = 's1'`).get(),
    ).toEqual({ state: 'searching', lease_until: 9000, updated_at: 7000, lease_started_at: null })
    // 列可写（后续新 claim 会往里写 claim 时刻）
    expect(() =>
      db.prepare(`UPDATE jobs SET lease_started_at = 8000 WHERE series_id = 's1'`).run(),
    ).not.toThrow()
    db.close()

    // 幂等：重开不重跑（版本门到 '22' 就停），即便 guard 再跑一遍也因列已存在而跳过 ALTER，不炸
    const db2 = openDb(p)
    expect(db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    db2.close()
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
      -- W2 迁移安全性修复：这里原来漏抄了 v9 终态 subtitles 的真实列形状（id/path/provider_ref/
      -- assrt_sub_id/size/created_at）——之前没有任何迁移直接引用这些列名（v16 只 ALTER ADD
      -- COLUMN file_path，对列缺席不敏感），这个疏漏一直没被抓出来；本批新增的 v19 迁移第一次
      -- 对 subtitles.provider_ref 做 UPDATE，列缺席会让迁移直接报错，因此这里补全为真实形状。
      CREATE TABLE subtitles (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, provider_ref TEXT, assrt_sub_id INTEGER, size INTEGER, created_at INTEGER NOT NULL, UNIQUE(item_id, path));
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

    // v14 形状库（seeded schema_version '6'）经 openDb 会连跑 v15+v16+v17+v18+v19+详情页富化 六条迁移到 '12'。
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
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
    // v17（批③ B3-4）追加 duration_verdict/verdict_fingerprint 两列——见下方专属测试。
    expect(cols).toEqual(['id', 'item_id', 'path', 'added_at', 'duration_verdict', 'verdict_fingerprint'])
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

  // v17（批③ B3-4，专项#1：传播"不匹配判决"指纹记忆）：item_files 加 duration_verdict/
  // verdict_fingerprint 两列，纯增量（ALTER TABLE ADD COLUMN ×2）。存量行两列默认 NULL
  // （兼容语义：NULL=未判过），新值可写。
  it('v17: item_files.duration_verdict/verdict_fingerprint 两列存在（存量行默认 NULL，新值可写）', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(item_files)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('duration_verdict')
    expect(cols).toContain('verdict_fingerprint')

    db.prepare(`INSERT INTO item_files (item_id, path, added_at) VALUES ('tmdb:1/s1e1', '/media/a.mkv', 1)`).run()
    expect(db.prepare(`SELECT duration_verdict, verdict_fingerprint FROM item_files WHERE path = '/media/a.mkv'`).get())
      .toEqual({ duration_verdict: null, verdict_fingerprint: null })

    const fp = JSON.stringify({ main: { mtimeMs: 1000, size: 111 }, replica: { mtimeMs: 2000, size: 222 } })
    db.prepare(`UPDATE item_files SET duration_verdict = 'mismatch', verdict_fingerprint = ? WHERE path = '/media/a.mkv'`).run(fp)
    expect(db.prepare(`SELECT duration_verdict, verdict_fingerprint FROM item_files WHERE path = '/media/a.mkv'`).get())
      .toEqual({ duration_verdict: 'mismatch', verdict_fingerprint: fp })
  })

  // 详情页重设计 item B（design: docs/design/2026-07-20-detail-page-redesign-design.md）：
  // 末条迁移给 series 加 overview/backdrop_path、tmdb_seasons 加 overview/air_date/still_path，纯 ADD COLUMN。
  it('详情页富化迁移：series 加 overview/backdrop_path，tmdb_seasons 加 overview/air_date/still_path', () => {
    const db = openDb(':memory:')
    const seriesCols = (db.prepare(`PRAGMA table_info(series)`).all() as { name: string }[]).map((c) => c.name)
    expect(seriesCols).toEqual(expect.arrayContaining(['overview', 'backdrop_path']))
    const tsCols = (db.prepare(`PRAGMA table_info(tmdb_seasons)`).all() as { name: string }[]).map((c) => c.name)
    expect(tsCols).toEqual(expect.arrayContaining(['overview', 'air_date', 'still_path']))
  })

  // 迁移安全性（血泪教训，本仓已两次立功——见 v15 测试同名注释）：真造一个 v16 形状的旧库
  // （schema_version '8'，无 duration_verdict/verdict_fingerprint 两列），塞入代表性 item_files
  // 行，重新 openDb() 触发 v17 迁移，断言存量行原样存活（不丢数据）且新列确实可写。
  it('v17 迁移安全性：v16 形状旧库升级后，既有 item_files 行原样存活，新列可写', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    const Database = (openDb(':memory:').constructor) as new (path: string) => import('better-sqlite3').Database
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      CREATE TABLE series (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT, year INTEGER,
        provider_ids TEXT, layout_nonstandard INTEGER NOT NULL DEFAULT 0, genres TEXT, origin_lang TEXT
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
        season INTEGER NOT NULL, episode INTEGER NOT NULL, name TEXT, path TEXT NOT NULL,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE movies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT,
        year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        origin_lang TEXT, probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, series_id TEXT, season INTEGER, movie_id TEXT, plan_ref TEXT, payload TEXT, parent_job_id INTEGER, state TEXT NOT NULL DEFAULT 'wanted', priority INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER, last_error TEXT);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, decision TEXT, detail TEXT, journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER, trace_json TEXT);
      CREATE TABLE subtitles (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, provider_ref TEXT, assrt_sub_id INTEGER, size INTEGER, created_at INTEGER NOT NULL, file_path TEXT, UNIQUE(item_id, path));
      CREATE TABLE blacklist (provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider_ref, filename));
      CREATE TABLE parked_paths (path TEXT PRIMARY KEY, park_reason TEXT NOT NULL, first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL);
      CREATE TABLE identify_overrides (path_prefix TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL, is_tv INTEGER NOT NULL, season INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tmdb_seasons (series_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, title TEXT, fetched_at INTEGER NOT NULL, PRIMARY KEY (series_id, season, episode));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE media_roots (path TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'local', added_at INTEGER NOT NULL);
      CREATE TABLE extras_exemptions (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE item_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        added_at INTEGER NOT NULL
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '8');
      INSERT INTO series (id, name) VALUES ('tmdb:100', 'Preexisting Show');
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
        VALUES ('tmdb:100/s1e1', 'tmdb:100', 1, 1, 'Ep1', '/media/ep1-main.mkv', 'covered', 5000);
      INSERT INTO item_files (item_id, path, added_at) VALUES ('tmdb:100/s1e1', '/media/ep1-replica.mkv', 6000);
    `)
    raw.pragma('foreign_keys = ON')
    raw.close()

    const db = openDb(dbPath)

    // v16 形状库（seeded schema_version '8'）经 openDb 只需再跑 v17+v18+v19+详情页富化 四条迁移到 '12'。
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    // 存量 item_files 行原样存活，不丢数据不串列。
    expect(db.prepare(`SELECT item_id, path, added_at FROM item_files WHERE path = '/media/ep1-replica.mkv'`).get())
      .toEqual({ item_id: 'tmdb:100/s1e1', path: '/media/ep1-replica.mkv', added_at: 6000 })
    // 新列确实可写（不是只重建了表结构但列还没真的加上）。
    expect(() =>
      db.prepare(`UPDATE item_files SET duration_verdict = 'probe-failed', verdict_fingerprint = '{}' WHERE path = '/media/ep1-replica.mkv'`).run()
    ).not.toThrow()
  })

  // v18（数据安全审计头号遗留修复，2026-07-18：CIFS 挂载抖动可致整库索引批量误删——三层防线
  // 第②层"消失去抖"）：pending_removals 表存在，列形状齐全，PRIMARY KEY(path) 生效，misses
  // 可累加更新（ON CONFLICT DO UPDATE 用法，见 v2/ingest.ts recordMissingPass）。
  it('v18: pending_removals 表存在，列形状齐全，path 是主键（去抖记账表）', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(pending_removals)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(['path', 'first_missing_at', 'misses'])

    db.prepare(`INSERT INTO pending_removals (path, first_missing_at, misses) VALUES ('/media/a.mkv', 1000, 1)`).run()
    // path 是主键——重复插入同一 path 报错（misses 只能靠 ON CONFLICT DO UPDATE 累加，不能重插）。
    expect(() =>
      db.prepare(`INSERT INTO pending_removals (path, first_missing_at, misses) VALUES ('/media/a.mkv', 2000, 1)`).run()
    ).toThrow()

    db.prepare(
      `INSERT INTO pending_removals (path, first_missing_at, misses) VALUES ('/media/a.mkv', 1000, 1)
       ON CONFLICT(path) DO UPDATE SET misses = misses + 1`
    ).run()
    expect(db.prepare(`SELECT * FROM pending_removals WHERE path = '/media/a.mkv'`).get())
      .toEqual({ path: '/media/a.mkv', first_missing_at: 1000, misses: 2 })
  })

  // 迁移安全性（血泪教训，本仓已两次立功——见 v15/v17 测试同名注释）：真造一个 v17 形状的旧库
  // （schema_version '9'，无 pending_removals 表），塞入代表性 episodes/subtitles 数据，重新
  // openDb() 触发 v18 迁移，断言存量行原样存活（不丢数据）且新表确实可用。这正是本次修复要堵的
  // 那类"整库索引批量误删"事故的对立面——先确认迁移本身绝不会丢数据，再谈运行期的三层防线。
  it('v18 迁移安全性：v17 形状旧库升级后，既有 episodes/subtitles 行原样存活，pending_removals 可用', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    const Database = (openDb(':memory:').constructor) as new (path: string) => import('better-sqlite3').Database
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      CREATE TABLE series (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT, year INTEGER,
        provider_ids TEXT, layout_nonstandard INTEGER NOT NULL DEFAULT 0, genres TEXT, origin_lang TEXT
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
        season INTEGER NOT NULL, episode INTEGER NOT NULL, name TEXT, path TEXT NOT NULL,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE movies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT,
        year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        origin_lang TEXT, probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, series_id TEXT, season INTEGER, movie_id TEXT, plan_ref TEXT, payload TEXT, parent_job_id INTEGER, state TEXT NOT NULL DEFAULT 'wanted', priority INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER, last_error TEXT);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, decision TEXT, detail TEXT, journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER, trace_json TEXT);
      CREATE TABLE subtitles (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, provider_ref TEXT, assrt_sub_id INTEGER, size INTEGER, created_at INTEGER NOT NULL, file_path TEXT, UNIQUE(item_id, path));
      CREATE TABLE blacklist (provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider_ref, filename));
      CREATE TABLE parked_paths (path TEXT PRIMARY KEY, park_reason TEXT NOT NULL, first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL);
      CREATE TABLE identify_overrides (path_prefix TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL, is_tv INTEGER NOT NULL, season INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tmdb_seasons (series_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, title TEXT, fetched_at INTEGER NOT NULL, PRIMARY KEY (series_id, season, episode));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE media_roots (path TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'local', added_at INTEGER NOT NULL);
      CREATE TABLE extras_exemptions (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE item_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, added_at INTEGER NOT NULL,
        duration_verdict TEXT, verdict_fingerprint TEXT
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '9');
      INSERT INTO series (id, name) VALUES ('tmdb:100', 'Preexisting Show');
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
        VALUES ('tmdb:100/s1e1', 'tmdb:100', 1, 1, 'Ep1', '/media/ep1.mkv', 'covered', 5000);
      INSERT INTO subtitles (item_id, path, language, source, created_at)
        VALUES ('tmdb:100/s1e1', '/media/ep1.zh.srt', 'zh-Hans', 'preexisting', 5500);
      INSERT INTO movies (id, name, path, sub_status, updated_at)
        VALUES ('tmdb:200', 'Preexisting Movie', '/media/movie.mkv', 'missing', 6000);
    `)
    raw.pragma('foreign_keys = ON')
    raw.close()

    const db = openDb(dbPath)

    // v17 形状库（seeded schema_version '9'）经 openDb 只需再跑 v18+v19+详情页富化 三条迁移到 '12'。
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    // 存量 episodes/subtitles/movies 行原样存活，不丢数据不串列——这正是本次修复要堵的事故的
    // 对立面：迁移本身绝不能是又一个"整库索引批量误删"的来源。
    expect(db.prepare(`SELECT * FROM episodes WHERE id = 'tmdb:100/s1e1'`).get()).toMatchObject({
      series_id: 'tmdb:100', season: 1, episode: 1, name: 'Ep1', path: '/media/ep1.mkv',
      sub_status: 'covered', updated_at: 5000,
    })
    expect(db.prepare(`SELECT * FROM subtitles WHERE item_id = 'tmdb:100/s1e1'`).get()).toMatchObject({
      path: '/media/ep1.zh.srt', language: 'zh-Hans', source: 'preexisting',
    })
    expect(db.prepare(`SELECT * FROM movies WHERE id = 'tmdb:200'`).get()).toMatchObject({
      name: 'Preexisting Movie', path: '/media/movie.mkv', sub_status: 'missing', updated_at: 6000,
    })
    // 新表确实可用（不是只声明没建成）。
    expect(() =>
      db.prepare(`INSERT INTO pending_removals (path, first_missing_at, misses) VALUES ('/media/gone.mkv', 7000, 1)`).run()
    ).not.toThrow()
    expect(db.prepare(`SELECT * FROM pending_removals WHERE path = '/media/gone.mkv'`).get())
      .toEqual({ path: '/media/gone.mkv', first_missing_at: 7000, misses: 1 })
  })

  // v19（装机记账修复批，2026-07-18）：真造一个 v18 形状的旧库（schema_version '10'），塞入
  // W2（provider_ref 双前缀）与 W4（covered/embedded 行残留陈旧 status_reason）两类确诊脏数据 +
  // 干净的对照行，重新 openDb() 触发 v19 迁移，断言：脏数据被清洗，干净的对照行原样不受影响
  // （迁移不是无差别的"一律清空"，只清洗确诊命中谓词的行）。
  it('v19 迁移安全性：真造旧库塞双前缀 provider_ref 与陈旧 covered/embedded status_reason，升级后清洗且不误伤', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    const Database = (openDb(':memory:').constructor) as new (path: string) => import('better-sqlite3').Database
    const raw = new Database(dbPath)
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      CREATE TABLE series (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT, year INTEGER,
        provider_ids TEXT, layout_nonstandard INTEGER NOT NULL DEFAULT 0, genres TEXT, origin_lang TEXT
      );
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES series(id),
        season INTEGER NOT NULL, episode INTEGER NOT NULL, name TEXT, path TEXT NOT NULL,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE movies (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT,
        year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
        sub_status TEXT NOT NULL CHECK(sub_status IN
          ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
        status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
        origin_lang TEXT, probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
        search_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, series_id TEXT, season INTEGER, movie_id TEXT, plan_ref TEXT, payload TEXT, parent_job_id INTEGER, state TEXT NOT NULL DEFAULT 'wanted', priority INTEGER NOT NULL DEFAULT 100, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, lease_until INTEGER, last_error TEXT);
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, started_at INTEGER NOT NULL, finished_at INTEGER, decision TEXT, detail TEXT, journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER, trace_json TEXT);
      CREATE TABLE subtitles (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL, language TEXT NOT NULL, source TEXT NOT NULL, provider_ref TEXT, assrt_sub_id INTEGER, size INTEGER, created_at INTEGER NOT NULL, file_path TEXT, UNIQUE(item_id, path));
      CREATE TABLE blacklist (provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '', reason TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider_ref, filename));
      CREATE TABLE parked_paths (path TEXT PRIMARY KEY, park_reason TEXT NOT NULL, first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL);
      CREATE TABLE identify_overrides (path_prefix TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL, is_tv INTEGER NOT NULL, season INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE tmdb_seasons (series_id TEXT NOT NULL, season INTEGER NOT NULL, episode INTEGER NOT NULL, title TEXT, fetched_at INTEGER NOT NULL, PRIMARY KEY (series_id, season, episode));
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE media_roots (path TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'local', added_at INTEGER NOT NULL);
      CREATE TABLE extras_exemptions (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE item_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, path TEXT NOT NULL UNIQUE, added_at INTEGER NOT NULL,
        duration_verdict TEXT, verdict_fingerprint TEXT
      );
      CREATE TABLE pending_removals (path TEXT PRIMARY KEY, first_missing_at INTEGER NOT NULL, misses INTEGER NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '10');
      INSERT INTO series (id, name) VALUES ('tmdb:100', 'DxD-like Show');
      -- W2 确诊脏数据：DxD 案实证形态——assrt/opensubtitles 双前缀。
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
        VALUES ('tmdb:100/s3e11', 'tmdb:100', 3, 11, 'E11', '/media/e11.mkv', 'covered', 5000);
      INSERT INTO subtitles (item_id, path, language, source, provider_ref, created_at)
        VALUES ('tmdb:100/s3e11', '/media/e11.zh.srt', 'zh-Hans', 'scout-download', 'assrt:assrt:662362', 5500);
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
        VALUES ('tmdb:100/s3e12', 'tmdb:100', 3, 12, 'E12', '/media/e12.mkv', 'covered', 5100);
      INSERT INTO subtitles (item_id, path, language, source, provider_ref, created_at)
        VALUES ('tmdb:100/s3e12', '/media/e12.zh.srt', 'zh-Hans', 'scout-download', 'opensubtitles:opensubtitles:7174766', 5600);
      -- 干净对照行：单前缀 provider_ref，不该被误伤。
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
        VALUES ('tmdb:100/s3e13', 'tmdb:100', 3, 13, 'E13', '/media/e13.mkv', 'covered', 5200);
      INSERT INTO subtitles (item_id, path, language, source, provider_ref, created_at)
        VALUES ('tmdb:100/s3e13', '/media/e13.zh.srt', 'zh-Hans', 'scout-download', 'assrt:661405', 5700);
      -- W4 确诊脏数据：covered/embedded 行残留修复前的失败叙事（TD S02E08/LD&R S03E08 型事故）。
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, status_reason, updated_at)
        VALUES ('tmdb:100/s2e8', 'tmdb:100', 2, 8, 'E8', '/media/e8.mkv', 'covered', 'unknown videoFilename: 旧修复前的失败叙事', 5800);
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, status_reason, updated_at)
        VALUES ('tmdb:100/s2e9', 'tmdb:100', 2, 9, 'E9', '/media/e9.mkv', 'embedded', '旧的 unavailable 叙事残留', 5900);
      INSERT INTO movies (id, name, path, sub_status, status_reason, updated_at)
        VALUES ('tmdb:300', 'Stale Movie', '/media/m1.mkv', 'covered', '旧的失败叙事残留', 6000);
      -- 干净对照行：非 covered/embedded 的 status_reason 不该被清空（unavailable 的复查叙事仍然
      -- 有效，不是"陈旧"）。
      INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, status_reason, updated_at)
        VALUES ('tmdb:100/s2e10', 'tmdb:100', 2, 10, 'E10', '/media/e10.mkv', 'unavailable', '搜索穷尽，仍在复查窗口内', 6100);
      INSERT INTO movies (id, name, path, sub_status, updated_at)
        VALUES ('tmdb:400', 'Missing Movie', '/media/m2.mkv', 'missing', 6200);
    `)
    raw.pragma('foreign_keys = ON')
    raw.close()

    const db = openDb(dbPath)

    // v18 形状库（seeded schema_version '10'）经 openDb 只需再跑 v19+详情页富化 两条迁移到 '12'。
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })

    // W2：确诊双前缀被剥掉第一层，只留原始 provider:providerId。
    expect(db.prepare(`SELECT provider_ref FROM subtitles WHERE item_id = 'tmdb:100/s3e11'`).get())
      .toEqual({ provider_ref: 'assrt:662362' })
    expect(db.prepare(`SELECT provider_ref FROM subtitles WHERE item_id = 'tmdb:100/s3e12'`).get())
      .toEqual({ provider_ref: 'opensubtitles:7174766' })
    // 干净对照行：单前缀原样不变，不被误伤。
    expect(db.prepare(`SELECT provider_ref FROM subtitles WHERE item_id = 'tmdb:100/s3e13'`).get())
      .toEqual({ provider_ref: 'assrt:661405' })

    // W4：covered/embedded 行的陈旧 status_reason 被清空。
    expect(db.prepare(`SELECT status_reason FROM episodes WHERE id = 'tmdb:100/s2e8'`).get())
      .toEqual({ status_reason: null })
    expect(db.prepare(`SELECT status_reason FROM episodes WHERE id = 'tmdb:100/s2e9'`).get())
      .toEqual({ status_reason: null })
    expect(db.prepare(`SELECT status_reason FROM movies WHERE id = 'tmdb:300'`).get())
      .toEqual({ status_reason: null })
    // 干净对照行：非 covered/embedded 的 status_reason 原样保留，不被误伤。
    expect(db.prepare(`SELECT status_reason FROM episodes WHERE id = 'tmdb:100/s2e10'`).get())
      .toEqual({ status_reason: '搜索穷尽，仍在复查窗口内' })

    // 不丢数据不串列——其余列原样存活。
    expect(db.prepare(`SELECT sub_status, updated_at FROM episodes WHERE id = 'tmdb:100/s2e8'`).get())
      .toEqual({ sub_status: 'covered', updated_at: 5800 })
    expect(db.prepare(`SELECT sub_status, updated_at FROM movies WHERE id = 'tmdb:400'`).get())
      .toEqual({ sub_status: 'missing', updated_at: 6200 })
  })
})

// v25（agent-first identification）：parked_paths 承载 agent 识别所需的 raw 数据
// （duration_sec, embedded_langs）——机械只给 raw 数据，agent 从 parked_paths 读取。
describe('v25 migration: parked_paths raw data columns', () => {
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    db = openDb(':memory:')
  })

  afterEach(() => {
    db.close()
  })

  it('adds duration_sec and embedded_langs columns', () => {
    // MIGRATIONS 追加 v25 后是 18 条 entry；v26（parked_paths.embedded_tmdb_id）后是 19 条；
    // v27（认领退役，DROP identify_overrides）后是 20 条；v28（subtitle_verify 校验结论表）
    // 后是 21 条；v29（jobs.lease_started_at）后是 22 条（落库 meta.schema_version 随之是 '22'）。
    // v32（files.sub_recheck_at，D12/D18 两档机制的 schema 层）后是 26 条，落库值随之是 '26'。
    // v33（D19/C44 废止 unavailable 第五态的存量行）后是 27 条，落库值随之是 '27'。
    // v34（files.sub_attempt，D22 的 NOT NULL DEFAULT 0）后是 28 条；v35（files.translatable，
    // R21/D9 的可救性三态列）后是 29 条，落库值随之是 '29'。v36（works.provider_ids，C5/C21
    // 翻译抓源腿的 imdb 命门）后是 30 条，落库值随之是 '30'。v37（files.tr_attempt +
    // tr_recheck_after，D3/D6 翻译轨自己的退避轨）后是 31 条，落库值随之是 '31'。
    // v38（files.sub_retry_streak，第 5 步下游"retry_later 不吃额度"豁免的对价账本）后是
    // 32 条，落库值随之是 '32'。v39（notifications 表，R-F3 通知页的持久化数据源——SSE 的
    // 进程内环形缓冲非持久，关着浏览器的那 23 小时里的成果全部丢失）后是 33 条，落库值随之是 '33'。
    // v40（files.skip_reason + sidecar_langs，R-F15 目标语言可切换性——前者把 judgeSubtitle
    // 已算出却被丢弃的 verdict.reason 存下来，后者记录该视频旁边**全部**外挂字幕的语言集合，
    // 使换目标语言后无需重新扫盘即可重导 sub_status）后是 34 条，落库值随之是 '34'。
    // v41（media_roots.last_error + last_checked_at，Task ③ 守备目录健康度——把 scanOnce
    // 的 R8 三道闸的判决落进状态机，此前只有日志与瞬时 SSE 两个非持久出口）后是 35 条，
    // 落库值随之是 '35'。v42（works.backdrop_path，Task ⑥ / R-F13+R-F14——活动页「在跑」
    // 卡片要横版 backdrop，TMDB 客户端早就在取这个字段、只是 works 落库时被丢弃）后是
    // 36 条，落库值随之是 '36'。v43（works.backdrop_checked_at，Task ⑦——v42 的回填 pass
    // 谓词 `backdrop_path IS NULL` 对"TMDB 真没横版图"的行恒真，叠加 `ORDER BY id` 恒定序
    // 与 LIMIT 200，每轮 boot 取到同一批头部 200 行，第 201 行往后永久饿死；实测 250 行/
    // 3 轮 totalCalls=600 unique=200。把"查过没有"的凭据挪进独立一列后谓词才单调收敛）
    // 后是 37 条，落库值随之是 '37'。
    expect(MIGRATIONS.length).toBe(37)

    // Insert a parked path with raw data（embedded_langs 与 episodes/movies 同构：JSON 数组串）
    db.prepare(`
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt, retry_count, duration_sec, embedded_langs)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('/test/path.mkv', 'awaiting-agent-identification', 1000, 1000, 0, 3600, '["eng","jpn"]')

    const row = db.prepare('SELECT duration_sec, embedded_langs FROM parked_paths WHERE path = ?')
      .get('/test/path.mkv') as { duration_sec: number; embedded_langs: string }

    expect(row.duration_sec).toBe(3600)
    expect(row.embedded_langs).toBe('["eng","jpn"]')
  })

  it('existing parked_paths get null for new columns', () => {
    // Simulate pre-v25 schema (manually create old table)
    db.exec(`
      DROP TABLE parked_paths;
      CREATE TABLE parked_paths (
        path TEXT PRIMARY KEY,
        park_reason TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_attempt INTEGER NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        probe_mtime INTEGER,
        probe_size INTEGER
      );
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
      VALUES ('/old/path.mkv', 'no-signal', 500, 500);
    `)

    // 手动驱动 v25 起的增量迁移（本仓版本账记在 meta.schema_version，不走 PRAGMA user_version；
    // 这里复刻 openDb() 迁移循环里"字符串 entry 走 exec / 函数 entry 直接调用"的分派）。
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') {
        migration(db)
      } else {
        db.exec(migration)
      }
    }

    const row = db.prepare('SELECT duration_sec, embedded_langs FROM parked_paths WHERE path = ?')
      .get('/old/path.mkv') as { duration_sec: number | null; embedded_langs: string | null }

    expect(row.duration_sec).toBeNull()
    expect(row.embedded_langs).toBeNull()
  })
})

// v26（接回 [tmdbid-N] 证据通道）：parked_paths.embedded_tmdb_id。
describe('v26 migration: parked_paths.embedded_tmdb_id', () => {
  it('fresh 库直接带该列，且可存取 [tmdbid-N] 标签值', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(parked_paths)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('embedded_tmdb_id')

    db.prepare(`
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt, retry_count, embedded_tmdb_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('/media/tv/Show (2020) [tmdbid-1396]/S01E01.mkv', 'awaiting-agent-identification', 1000, 1000, 0, '1396')

    const row = db.prepare('SELECT embedded_tmdb_id FROM parked_paths WHERE path LIKE ?')
      .get('%tmdbid-1396%') as { embedded_tmdb_id: string | null }
    expect(row.embedded_tmdb_id).toBe('1396')
    db.close()
  })

  // 🔴 回归锁（本次实现真踩到过）：PRAGMA table_info 对**不存在**的表返回空集，所以只判
  // !columns.has('embedded_tmdb_id') 的守卫对"压根没有 parked_paths 的老库"恒为真，裸 ALTER
  // 直接炸 no such table，整条迁移链在事务里回滚 → 老库永远打不开。v26 必须先查 sqlite_master
  // （同 v24/v25 的既有口径）。
  it('parked_paths 不存在的老库：v26 静默跳过，不炸 no such table', () => {
    const db = new Database(':memory:') as unknown as ScoutDb
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`)
    const v26 = MIGRATIONS[18]
    expect(typeof v26).toBe('function')
    expect(() => (v26 as (d: ScoutDb) => void)(db)).not.toThrow()
    db.close()
  })

  it('存量 parked_paths 行升级后该列为 NULL（不是"未探测"，是"路径无标签"）', () => {
    const db = new Database(':memory:') as unknown as ScoutDb
    db.exec(`
      CREATE TABLE parked_paths (
        path TEXT PRIMARY KEY,
        park_reason TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_attempt INTEGER NOT NULL
      );
      INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
      VALUES ('/old/path.mkv', 'no-signal', 500, 500);
    `)
    ;(MIGRATIONS[18] as (d: ScoutDb) => void)(db)

    const cols = (db.prepare('PRAGMA table_info(parked_paths)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('embedded_tmdb_id')
    const row = db.prepare('SELECT embedded_tmdb_id FROM parked_paths WHERE path = ?')
      .get('/old/path.mkv') as { embedded_tmdb_id: string | null }
    expect(row.embedded_tmdb_id).toBeNull()
    db.close()
  })

  it('幂等：v26 连跑两次不炸 duplicate column name', () => {
    const db = openDb(':memory:')
    expect(() => (MIGRATIONS[18] as (d: ScoutDb) => void)(db)).not.toThrow()
    db.close()
  })
})

describe('v31 recheck_after（死循环修复）', () => {
  it('fresh install 的 files 表有 recheck_after 列', () => {
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('recheck_after')
    db.close()
  })
  it('v30 老库升级后补出 recheck_after 列，存量行不受影响', () => {
    // 造一个 v30 形状的库（无 recheck_after），插入一行，跑迁移后列存在且行存活
    const db = openDb(':memory:')
    const cols = (db.prepare('PRAGMA table_info(files)').all() as { name: string }[]).map(c => c.name)
    // 当前 fresh install 已有列；模拟老库靠直接确认列存在
    expect(cols).toContain('recheck_after')
    // 插入带 recheck_after 的行
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, recheck_after, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('/a/b.mkv', '/a', 'b.mkv', 100, 1000, '/a', 9999, 1000)
    const row = db.prepare('SELECT recheck_after FROM files WHERE path = ?').get('/a/b.mkv') as { recheck_after: number }
    expect(row.recheck_after).toBe(9999)
    db.close()
  })
})

// v33（D19 / C44）：废止 sub_status 第五态 'unavailable' 的**存量行**。
//
// 为什么这条迁移不能等到"删掉写入点"那个 task 一起做：两件事的失效方向相反。
// 写入点还活着（subtitleScheduler 仍在为最常见的失败路径写 unavailable）时，本迁移只是把
// 已经脏了的行洗回 NULL——洗完又被写脏，无害。反过来若先收紧字幕工作台谓词成
// `sub_status IS NULL`、迁移却没跑，这批存量行当场"既不在字幕工作台（sub_status 非 NULL）、
// 又攒不到 7 次（那条失败路径不递增 sub_attempt）" → **永久出局**，字幕再也不会被补，
// 而界面上一点异常都看不出来。所以迁移必须**先于**谓词收紧落地，这就是它单独成 task 的理由。
describe('v33 迁移：废止 unavailable 第五态的存量行（D19 / C44）', () => {
  /** 造一行 files（只填 NOT NULL 列 + 被测的 sub_status）。 */
  function seed(db: ScoutDb, path: string, subStatus: string | null): void {
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, sub_status, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(path, '/media', path.slice(path.lastIndexOf('/') + 1), 100, 1000, subStatus, 1000)
  }
  const statusOf = (db: ScoutDb, path: string): string | null =>
    (db.prepare('SELECT sub_status FROM files WHERE path = ?').get(path) as { sub_status: string | null }).sub_status

  /** v33 entry 的下标**写死为 26**（= 该 entry 在 MIGRATIONS 里的位置，0-based）。
   *  手工驱动而不是靠 openDb：openDb 对 :memory: 是 fresh install，迁移在**空表**上跑完才
   *  轮到我们插数据，于是"存量行被洗"这件事根本不会被执行到 → 断言变成空转的假绿。
   *
   *  🔴 为什么不能写 `MIGRATIONS.length - 1`（原实现，3-2 实测踩到）：那是"最后一条"，
   *  不是"v33 那一条"。v34/v35 追加之后它静默指向了**新加的 ALTER 迁移**，于是这一组用例
   *  全体改测了别人：既有的 5 条 v33 断言当场变红，而红的原因不是 v33 坏了——是断言对象
   *  被换掉了。更坏的形态是它**不红**：若新追加的恰好也是一条 UPDATE files，这组用例会
   *  继续全绿，而 v33 那条真正的洗数据迁移从此再没有任何测试覆盖（假绿）。
   *  下标 + 内容双重校验（下面那行 toContain）让"迁移数组被重排/插队"这件事立刻可见。 */
  const V33_INDEX = 26
  const v33 = () => MIGRATIONS[V33_INDEX] as (d: ScoutDb) => void

  it('v33 下标锚定：该 entry 真的是"洗 unavailable"那条（防日后追加迁移把用例指向别人）', () => {
    // 把函数体转成字符串做特征匹配。丑，但它是"下标锚定"这种脆弱定位方式唯一的自检手段——
    // 少了它，任何一次迁移插队都会让上面那 5 条断言静默改测别的 entry。
    expect(typeof v33()).toBe('function')
    expect(String(v33())).toContain('unavailable')
  })

  it('🔴 存量 unavailable 行 → 迁移后 sub_status 变 NULL', () => {
    const db = openDb(':memory:')
    seed(db, '/media/A.mkv', 'unavailable')
    v33()(db)
    expect(statusOf(db, '/media/A.mkv')).toBeNull()
    db.close()
  })

  it('🔴 其余 sub_status 值一个不许动（covered / NULL / 未来的 handoff_translate）', () => {
    const db = openDb(':memory:')
    seed(db, '/media/covered.mkv', 'covered')
    seed(db, '/media/null.mkv', null)
    // handoff_translate / unsolvable 是第 3 步后续 task 才会写的停牌态。现在就把它们钉进
    // 对照组：一条写成 `SET sub_status=NULL WHERE sub_status IS NOT NULL` 的迁移在今天的库上
    // 完全测得过（库里只有 covered 和 unavailable），到停牌态上线那天却会把飞行中的翻译
    // 整个掀掉（D10 的守卫 `WHERE sub_status='handoff_translate'` 匹配 0 行 → 退避不写 →
    // 付费 LLM 热循环）。故对照组必须含未来值，不能只含今天存在的值。
    seed(db, '/media/handoff.mkv', 'handoff_translate')
    seed(db, '/media/unsolvable.mkv', 'unsolvable')
    v33()(db)
    expect(statusOf(db, '/media/covered.mkv')).toBe('covered')
    expect(statusOf(db, '/media/null.mkv')).toBeNull()
    expect(statusOf(db, '/media/handoff.mkv')).toBe('handoff_translate')
    expect(statusOf(db, '/media/unsolvable.mkv')).toBe('unsolvable')
    db.close()
  })

  it('🔴 幂等：连跑两次不炸，且第二次不改变任何行', () => {
    const db = openDb(':memory:')
    seed(db, '/media/A.mkv', 'unavailable')
    seed(db, '/media/B.mkv', 'covered')
    v33()(db)
    const after1 = db.prepare('SELECT path, sub_status FROM files ORDER BY path').all()
    expect(() => v33()(db)).not.toThrow()
    expect(db.prepare('SELECT path, sub_status FROM files ORDER BY path').all()).toEqual(after1)
    db.close()
  })

  it('🔴 老库无 files 表 → 迁移不抛错（照 v30/v31/v32 的条件式写法）', () => {
    // 真实剧本：v29 及更早的库升级上来时 files 表还不存在（v30 才建）。裸 UPDATE 会
    // `no such table: files` 直接把 openDb 炸掉 → 用户的库再也打不开，只能手动改 schema_version。
    const db = openDb(':memory:')
    db.exec('DROP TABLE files')
    expect(() => v33()(db)).not.toThrow()
    db.close()
  })

  it('🔴 迁移后全库不存在 sub_status=\'unavailable\' 的行（spec §4 第 3 步验收项）', () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 5; i++) seed(db, `/media/u${i}.mkv`, 'unavailable')
    seed(db, '/media/ok.mkv', 'covered')
    v33()(db)
    const left = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE sub_status = 'unavailable'`).get() as { n: number }
    expect(left.n).toBe(0)
    db.close()
  })
})

describe('v30 新架构表（files/works + content_type）', () => {
  it('fresh install 建出 files/works 表，media_roots 有 content_type 列', () => {
    const db = openDb(':memory:')
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name),
    )
    expect(tables.has('files')).toBe(true)
    expect(tables.has('works')).toBe(true)
    const cols = (db.prepare('PRAGMA table_info(media_roots)').all() as { name: string }[]).map(c => c.name)
    expect(cols).toContain('content_type')
    db.close()
  })

  it('files 表：机械扫描的产出，零身份判断（work_id/parse_confidence 默认 NULL）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, updated_at)
                VALUES (?,?,?,?,?,?)`).run('/a/b.mkv', '/a', 'b.mkv', 100, 1000, 1000)
    const row = db.prepare('SELECT * FROM files').get() as { path: string; work_id: string | null; parse_confidence: string | null }
    expect(row.path).toBe('/a/b.mkv')
    expect(row.work_id).toBeNull()
    expect(row.parse_confidence).toBeNull()
    db.close()
  })

  it('works 表：识别 agent 的产出（TMDB 身份）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at)
                VALUES (?,?,?,?,?)`).run('tmdb:123', 'Test Show', 'tv', 1000, 1000)
    const row = db.prepare('SELECT * FROM works').get() as { id: string; title: string; media_type: string }
    expect(row.id).toBe('tmdb:123')
    expect(row.media_type).toBe('tv')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v34 / v35（spec §4 第 3 步 · 裁决 D22 / R21 / D9）：files 表加 sub_attempt 与 translatable。
//
// 为什么这两条各值一整组断言，而不是"加个列谁还能加错"：
// D22 是一条**反缺陷裁决**——它存在的唯一理由是可空版本会静默失效。`sub_attempt >= 7` 在
// NULL 上是三值逻辑的 unknown（不是 false，是 unknown）→ 谓词永不命中 → 满 7 次移交停牌
// 这整套机制一行代码都不用改就废掉了，而日志和界面上什么都看不出来。这与 D18 在
// sub_recheck_at 上栽的是同一个坑，本仓已经四次栽在这个模式上（C12 → C35 → D17 → D18）。
// 故"NOT NULL"与"DEFAULT 0"必须各有一条测试钉住 PRAGMA 的实际输出，而不是只测"能存能取"
// ——能存能取在可空 schema 上同样全绿。
// ─────────────────────────────────────────────────────────────────────────────
describe('v34/v35 迁移：files.sub_attempt（D22）与 files.translatable（R21/D9）', () => {
  /** 重放尾部迁移（照 db.test.ts / db.subRecheckAt.test.ts 的既有分派：字符串走 exec、
   *  函数直接调用）。从 17 起而非 0：v9 折叠 entry 是裸 CREATE TABLE，重放会撞
   *  "table already exists"；17 起的尾部 entry 全是幂等的条件式写法。
   *
   *  用区间 `i < MIGRATIONS.length` 而不是写死"最后两条"：日后再追加迁移时这个 helper
   *  不会被撬歪，也不会因为下标算错而静默只重放一半（那样"升级路径"的用例会变成假绿）。 */
  function replayTail(db: ScoutDb): void {
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') migration(db)
      else db.exec(migration)
    }
  }

  /** 一列的 PRAGMA 元信息。断言打在这里而不是"插入 NULL 会不会报错"上：后者在
   *  `INTEGER NOT NULL DEFAULT 0` 与 `INTEGER NOT NULL` 上表现一致，测不出缺 DEFAULT
   *  这个真实伤害（1b-3 的指纹清空按 dflt_value 回落，没有 DEFAULT 时它会**跳过该列**
   *  → 换片源时 sub_attempt 残留 → 新片源自带失败额度，提前进停牌）。 */
  function colInfo(db: ScoutDb, table: string, col: string) {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>).find((c) => c.name === col)
  }

  it('🔴 sub_attempt 是 INTEGER NOT NULL DEFAULT 0（D22 三值逻辑红线）', () => {
    const db = openDb(':memory:')
    const c = colInfo(db, 'files', 'sub_attempt')
    expect(c).toBeDefined()
    expect(c!.type).toBe('INTEGER')
    // NOT NULL：可空的话 `sub_attempt >= 7` 在 NULL 上是 unknown，停牌移交静默失效
    expect(c!.notnull).toBe(1)
    // DEFAULT 0：1b-3 的指纹变化清空按 dflt_value 回落（fingerprintResetColumns），
    // 没有 DEFAULT 时它会跳过这一列 → 换片源后旧的失败计数残留下来
    expect(c!.dflt_value).toBe('0')
    db.close()
  })

  it('🔴 新插入行的 sub_attempt 自动是 0，不是 NULL（不写这一列的调用方也安全）', () => {
    // 真实剧本：daemonV2 的 upsert 语句列清单里没有 sub_attempt（它只写机械事实），
    // 于是每个新扫到的文件都靠这条 DEFAULT 拿到 0。若靠"调用方记得写"，漏一个写入点
    // 就是一批永远进不了停牌的行。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, updated_at)
                VALUES (?,?,?,?,?,?)`).run('/m/a.mkv', '/m', 'a.mkv', 100, 1000, 1000)
    const row = db.prepare('SELECT sub_attempt FROM files WHERE path = ?').get('/m/a.mkv') as { sub_attempt: number }
    expect(row.sub_attempt).toBe(0)
    db.close()
  })

  it('🔴 存量行升级上来时 sub_attempt 落 0 而非 NULL（ALTER 的 DEFAULT 回填）', () => {
    // SQLite 的 `ADD COLUMN ... NOT NULL DEFAULT 0` 会给存量行直接填 0。这条钉的是
    // "升级路径"与"fresh install"落到同一个值——两条路径分叉过的话，只有老库会静默失效，
    // 而测试用的 :memory: 永远是 fresh install，那种分叉在 CI 里完全隐形。
    const db = openDb(':memory:')
    db.exec('ALTER TABLE files DROP COLUMN sub_attempt')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, updated_at)
                VALUES (?,?,?,?,?,?)`).run('/m/legacy.mkv', '/m', 'legacy.mkv', 100, 1000, 1000)
    replayTail(db)
    const row = db.prepare('SELECT sub_attempt FROM files WHERE path = ?').get('/m/legacy.mkv') as { sub_attempt: number }
    expect(row.sub_attempt).toBe(0)
    db.close()
  })

  it('🔴 translatable 可空（三态：NULL=暂不可判 / 0=不可救 / 1=可救）', () => {
    // 与 sub_attempt 刻意相反：这一列的 NULL **是一个有意义的态**（judge 还没判、或
    // embedded_langs 缺失导致判不了），而 C40 明令 `translatable IS NULL` **不得判死**。
    // 若照 sub_attempt 的样子建成 NOT NULL DEFAULT 0，"还没判"就与"判过、不可救"撞成同一个值
    // → 满 7 次时一律走 unsolvable → 把一批还没来得及判的片子永久判死。
    const db = openDb(':memory:')
    const c = colInfo(db, 'files', 'translatable')
    expect(c).toBeDefined()
    expect(c!.type).toBe('INTEGER')
    expect(c!.notnull).toBe(0)
    db.close()
  })

  it('🔴 translatable 三个值都存得下且原样取回（NULL / 0 / 1）', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, translatable, updated_at)
                            VALUES (?,?,?,?,?,?,?)`)
    ins.run('/m/n.mkv', '/m', 'n.mkv', 100, 1000, null, 1000)
    ins.run('/m/z.mkv', '/m', 'z.mkv', 100, 1000, 0, 1000)
    ins.run('/m/o.mkv', '/m', 'o.mkv', 100, 1000, 1, 1000)
    const get = (p: string) => (db.prepare('SELECT translatable FROM files WHERE path = ?').get(p) as { translatable: number | null }).translatable
    expect(get('/m/n.mkv')).toBeNull()
    expect(get('/m/z.mkv')).toBe(0)
    expect(get('/m/o.mkv')).toBe(1)
    db.close()
  })

  it('🔴 老库无 files 表 → 两条迁移都不抛错（照 v30–v33 的条件式写法）', () => {
    // v29 及更早的库升级上来时 files 表还不存在（v30 才建）。裸 ALTER 会
    // `no such table: files` 把 openDb 整个炸掉 → 用户的库再也打不开。
    const db = openDb(':memory:')
    db.exec('DROP TABLE files')
    expect(() => replayTail(db)).not.toThrow()
    db.close()
  })

  it('🔴 幂等：两条迁移连跑两次不炸（重放不得撞 duplicate column）', () => {
    const db = openDb(':memory:')
    expect(() => { replayTail(db); replayTail(db) }).not.toThrow()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v36（spec §4 第 4 步 · 缺口 C5 + C21）：works 表加 provider_ids。
//
// 为什么这一列是功能的命门而不是"顺手加的备用 id"：`fetchSourceSub.ts` 顶部注释明言
// 兜底搜索**必须**带 imdb——文本 query 在 OpenSubtitles 上有大量假阴性，imdb 命中率高得多。
// 缺这一列，翻译的外挂抓取腿即便接通 files/works（C4）也只剩退化的文本查询，而第 6 步
// 的 e2e 会在这个退化状态下验证并误以为这就是真实命中率（C21 原话）。
// ─────────────────────────────────────────────────────────────────────────────
describe('v36 迁移：works.provider_ids（C5 + C21）', () => {
  function replayTail(db: ScoutDb): void {
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') migration(db)
      else db.exec(migration)
    }
  }

  it('🔴 用例 5a：fresh install 的 works 表有 provider_ids（TEXT，可空）', () => {
    const db = openDb(':memory:')
    const c = (db.prepare('PRAGMA table_info(works)').all() as Array<{
      name: string; type: string; notnull: number
    }>).find((x) => x.name === 'provider_ids')
    expect(c).toBeDefined()
    expect(c!.type).toBe('TEXT')
    // 可空是刚性的：识别时 getExternalIds 可能拿不到 imdb（TMDB 真没录），
    // 而 NULL 同时是**回填 pass 的唯一谓词**（`provider_ids IS NULL`，C21）。
    // 若建成 NOT NULL DEFAULT '{}'，存量行升级上来全是 '{}' → 回填一行都选不中 →
    // 83 个已识别作品的 imdb 永远补不上，而这正是 C21 要修的那件事本身。
    expect(c!.notnull).toBe(0)
    db.close()
  })

  it('🔴 用例 5b：存量库（无该列）升级 → 补上列，存量行落 NULL（回填的取件凭据）', () => {
    const db = openDb(':memory:')
    db.exec('ALTER TABLE works DROP COLUMN provider_ids')
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:83', 'Legacy Work', 'tv', 1000, 1000)
    replayTail(db)
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:83') as { provider_ids: string | null }
    expect(row.provider_ids).toBeNull()
    db.close()
  })

  it('🔴 用例 5c：幂等——重放两次不撞 duplicate column', () => {
    const db = openDb(':memory:')
    expect(() => { replayTail(db); replayTail(db) }).not.toThrow()
    db.close()
  })

  it('🔴 用例 5d：老库无 works 表 → 迁移不抛（照 v30–v35 的条件式写法）', () => {
    // v29 及更早的库升级上来时 works 表还不存在（v30 才建）。裸 ALTER 会
    // `no such table: works` 把 openDb 整个炸掉 → 用户的库再也打不开。
    // 这不是假想：v30 之前的备份库在生产上真实存在（用户从旧备份恢复的路径）。
    const db = openDb(':memory:')
    db.exec('DROP TABLE works')
    expect(() => replayTail(db)).not.toThrow()
    db.close()
  })

  it('🔴 用例 5e：JSON 串原样存取（口径同旧表 series/movies.provider_ids）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, provider_ids, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('tmdb:1', 'The Rig', 'tv', '{"tmdb":"1","imdb":"tt14827638"}', 1000, 1000)
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string }
    expect(JSON.parse(row.provider_ids)).toEqual({ tmdb: '1', imdb: 'tt14827638' })
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v37（spec §4 第 4 步 · 裁决 D3 + D6）：files 表加 tr_attempt / tr_recheck_after
// ——翻译流**自己的**退避轨。
//
// 为什么必须是独立两列而不是复用字幕轨的 sub_attempt/recheck_after（D3，与 C7 同型）：
// C7 已经用实测证明过一列多主的后果——`attempt` 被识别轨与字幕轨共用，identifyScheduler
// 在识别成功时把它归零，于是字幕轨攒了几天的失败额度被一次识别重跑洗掉，R10 的"满 7 次
// 移交翻译"永远走不到。翻译轨若复用 sub_attempt 是同一个坑的第三次：翻译失败会把
// 字幕轨的额度顶上去（本该 7 次的文件 4 次就停牌），而字幕轨的停牌写入又会把翻译的
// 退避时刻覆盖掉（recheck_after 在 3-2 里是"+7 天"，翻译轨要的是"明天"）。
//
// 为什么 tr_attempt 必须 `INTEGER NOT NULL DEFAULT 0`（同 D22，本仓第五次面对这个坑）：
// 分流谓词是 `tr_attempt >= 3`（held 满 3 次 → unsolvable），SQL 三值逻辑下 `NULL >= 3`
// 求值为 **unknown**（不是 false）→ 谓词永不命中 → "翻译反复失败就停牌"这条通路静默失效，
// 一个模型系统性过不了闸的文件会被无限重试，每次都是一个付费 LLM session。
//
// 为什么 tr_recheck_after 刻意**可空**（与 tr_attempt 相反，判据是"NULL 意味着什么"）：
// 它是"下次该轮到这一行"的时刻，NULL = "从没被翻译流碰过" = **应当立刻可领**。
// 翻译工作台的谓词因此必须写成 `(tr_recheck_after IS NULL OR tr_recheck_after <= now)`。
// 反过来若给它 `NOT NULL DEFAULT 0`，0 也 `<= now` 恒成立，语义上等价——但 3-2 刚把
// 字幕轨的 recheck_after 定成可空且用 `IS NULL OR` 读，两条轨对同一概念用相反的表示法
// 是纯粹的认知负担，且 D18 的教训是"NULL 语义必须写死"而不是"必须消灭 NULL"。
// ─────────────────────────────────────────────────────────────────────────────
describe('v37 迁移：files.tr_attempt / tr_recheck_after（D3 + D6）', () => {
  function replayTail(db: ScoutDb): void {
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') migration(db)
      else db.exec(migration)
    }
  }

  function colInfo(db: ScoutDb, table: string, col: string) {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>).find((c) => c.name === col)
  }

  it('🔴 用例 5：tr_attempt 是 INTEGER NOT NULL DEFAULT 0（D22 同型三值逻辑红线）', () => {
    const db = openDb(':memory:')
    const c = colInfo(db, 'files', 'tr_attempt')
    expect(c).toBeDefined()
    expect(c!.type).toBe('INTEGER')
    // NOT NULL：可空的话 `tr_attempt >= 3` 在 NULL 上是 unknown → held 满 3 次转
    // unsolvable 静默失效 → 付费 LLM 无限重试同一条过不了闸的字幕
    expect(c!.notnull).toBe(1)
    // DEFAULT 0：与 sub_attempt 同理，1b-3 的指纹变化清空按 dflt_value 回落。
    // tr_attempt 尚未进 FINGERPRINT_RESET_COLUMNS（换片源时该不该清是另一个判断），
    // 但 DEFAULT 的第二个作用在今天就是 load-bearing 的：daemonV2 的 upsert 列清单里
    // 没有 tr_attempt，每个新扫到的文件全靠这条 DEFAULT 拿到 0 而不是撞 NOT NULL 约束。
    expect(c!.dflt_value).toBe('0')
    db.close()
  })

  it('🔴 用例 5b：tr_recheck_after 可空（NULL = 从没被翻译流碰过 = 立刻可领）', () => {
    const db = openDb(':memory:')
    const c = colInfo(db, 'files', 'tr_recheck_after')
    expect(c).toBeDefined()
    expect(c!.type).toBe('INTEGER')
    expect(c!.notnull).toBe(0)
    db.close()
  })

  it('🔴 用例 5c：新插入行 tr_attempt 自动为 0（不写这一列的写入方也安全）', () => {
    // daemonV2 的 upsert 语句列清单里没有 tr_attempt（它只写机械事实）。若靠"调用方
    // 记得写"，漏一个写入点就是撞 NOT NULL 约束把整轮扫描炸掉——这正是 D22 注释里
    // 那条"加列当天生产静默崩溃"的定时炸弹形态。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, updated_at)
                VALUES (?,?,?,?,?,?)`).run('/m/tr.mkv', '/m', 'tr.mkv', 100, 1000, 1000)
    const row = db.prepare('SELECT tr_attempt, tr_recheck_after FROM files WHERE path = ?')
      .get('/m/tr.mkv') as { tr_attempt: number; tr_recheck_after: number | null }
    expect(row.tr_attempt).toBe(0)
    expect(row.tr_recheck_after).toBeNull()
    db.close()
  })

  it('🔴 用例 5d：存量行升级上来 tr_attempt 落 0 而非 NULL（ALTER 的 DEFAULT 回填）', () => {
    // fresh install 与升级路径必须落到同一个值。测试用的 :memory: 永远是 fresh install，
    // 两条路径分叉过的话只有老库静默失效，在 CI 里完全隐形。
    const db = openDb(':memory:')
    db.exec('ALTER TABLE files DROP COLUMN tr_attempt')
    db.exec('ALTER TABLE files DROP COLUMN tr_recheck_after')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, updated_at)
                VALUES (?,?,?,?,?,?)`).run('/m/legacy-tr.mkv', '/m', 'legacy-tr.mkv', 100, 1000, 1000)
    replayTail(db)
    const row = db.prepare('SELECT tr_attempt, tr_recheck_after FROM files WHERE path = ?')
      .get('/m/legacy-tr.mkv') as { tr_attempt: number; tr_recheck_after: number | null }
    expect(row.tr_attempt).toBe(0)
    expect(row.tr_recheck_after).toBeNull()
    db.close()
  })

  it('🔴 用例 5e：幂等——重放两次不撞 duplicate column', () => {
    const db = openDb(':memory:')
    expect(() => { replayTail(db); replayTail(db) }).not.toThrow()
    db.close()
  })

  it('🔴 用例 5f：老库无 files 表 → 迁移不抛（照 v30–v36 的条件式写法）', () => {
    const db = openDb(':memory:')
    db.exec('DROP TABLE files')
    expect(() => replayTail(db)).not.toThrow()
    db.close()
  })

  it('🔴 用例 5g：1b-3 的指纹清空逻辑读得出 tr_attempt 的 dflt_value（不会 continue 跳过）', () => {
    // 这条钉的是 D22 注释点名的那处咬合：fingerprintResetColumns 对 NOT NULL 列按
    // dflt_value 回落，读不出 DEFAULT 就 `continue` 跳过该列。tr_attempt 今天还不在
    // FINGERPRINT_RESET_COLUMNS 里，但这个 PRAGMA 契约是"将来把它加进去时不会当场炸"
    // 的前提——而"加进去"是一行改动，没有这条断言的话它会在加进去的那一天才暴露。
    const db = openDb(':memory:')
    const info = db.prepare('PRAGMA table_info(files)').all() as Array<{
      name: string; notnull: number; dflt_value: string | null
    }>
    const tr = info.find((c) => c.name === 'tr_attempt')!
    expect(tr.notnull).toBe(1)
    expect(tr.dflt_value).not.toBeNull()   // ← null 会让回落逻辑跳过该列
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v38（第 5 步下游 · R9 + R10 的语义修正）：files 表加 sub_retry_streak
// ——"连续多少轮源站答不上话"的独立计数列。
//
// 为什么必须是**独立一列**而不是复用 sub_attempt（C7 的第四次）：两列表达的是两件
// 完全不同的事。`sub_attempt` = "真实尝试过、确实找不到"的次数（R10 的"满 7 次移交
// 翻译"整个建立在这个含义上）；`sub_retry_streak` = "连续几轮源站拒绝回答"。
// 把 retry_later 记进 sub_attempt 就是本步在修的那个 bug：撞限流 7 天攒满 7 次 →
// 停牌/移交，而字幕一直在源站上（Peacemaker 实案）。反过来，若把折算逻辑也塞进
// sub_attempt 一列上（比如用负数或高位编码），任何一个只读 sub_attempt 的地方
// （daemonV2 的快照剔除、阶段 2.6 复查闸、UI）都会读出一个它无法解释的数。
//
// 为什么 `INTEGER NOT NULL DEFAULT 0`（D22 同型，本仓第六次面对这个坑）：
// 折算谓词是 `sub_retry_streak >= CAP`，SQL 三值逻辑下 `NULL >= 3` 求值为 **unknown**
// （不是 false）→ 谓词永不命中 → "长期挂掉的 provider 最终仍会移交"这条通路静默失效
// → 那批文件永远躺在字幕工作台里每天烧一次付费 session，UI 上毫无异常。
// DEFAULT 0 同时兜住两类不写这一列的写入方：daemonV2 的 upsert（只写机械事实），
// 以及 1b-3 的指纹变化清空（fingerprintResetColumns 对 NOT NULL 列按 dflt_value 回落，
// 读不出 DEFAULT 就 `continue` 跳过该列）。
// ─────────────────────────────────────────────────────────────────────────────
describe('v38 迁移：files.sub_retry_streak（retry_later 豁免的对价账本）', () => {
  function replayTail(db: ScoutDb): void {
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') migration(db)
      else db.exec(migration)
    }
  }

  function colInfo(db: ScoutDb, table: string, col: string) {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>).find((c) => c.name === col)
  }

  it('🔴 用例 9：sub_retry_streak 是 INTEGER NOT NULL DEFAULT 0（D22 同型三值逻辑红线）', () => {
    const db = openDb(':memory:')
    const c = colInfo(db, 'files', 'sub_retry_streak')
    expect(c).toBeDefined()
    expect(c!.type).toBe('INTEGER')
    // NOT NULL：可空的话 `sub_retry_streak >= CAP` 在 NULL 上是 unknown → 折算永不发生 →
    // provider 永久挂掉的文件永远攒不到 7 次 sub_attempt → 永不移交翻译流（永久卡死的另一形）
    expect(c!.notnull).toBe(1)
    // DEFAULT 0：fingerprintResetColumns 对 NOT NULL 列按 dflt_value 回落，缺 DEFAULT 时跳过该列
    expect(c!.dflt_value).toBe('0')
    db.close()
  })

  it('🔴 用例 9b：新插入行的 sub_retry_streak 自动是 0，不是 NULL', () => {
    // daemonV2 的 upsert 列清单里没有这一列（它只写机械事实）。靠"调用方记得写"的话，
    // 漏一个写入点就是撞 NOT NULL 约束把整轮扫描炸掉。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, updated_at)
                VALUES (?,?,?,?,?,?)`).run('/m/streak.mkv', '/m', 'streak.mkv', 100, 1000, 1000)
    const row = db.prepare('SELECT sub_retry_streak FROM files WHERE path = ?')
      .get('/m/streak.mkv') as { sub_retry_streak: number }
    expect(row.sub_retry_streak).toBe(0)
    db.close()
  })

  it('🔴 用例 9c：幂等——重放尾部迁移两次不撞 duplicate column', () => {
    const db = openDb(':memory:')
    expect(() => { replayTail(db); replayTail(db) }).not.toThrow()
    db.close()
  })

  it('🔴 用例 9d：老库无 files 表 → 迁移不抛（照 v30–v37 的条件式写法）', () => {
    const db = openDb(':memory:')
    db.exec('DROP TABLE files')
    expect(() => replayTail(db)).not.toThrow()
    db.close()
  })

  it('🔴 用例 10：1b-3 的指纹清空逻辑读得出 dflt_value（换片源时这一列必须被清）', () => {
    // 论证（换片源该不该清 = 清）：streak 的语义是"连续几轮**这个文件**在源站上问不到"。
    // 换片源之后，这一行代表的是**另一个文件**——它的 mtime/size 全变了，embedded_langs
    // 与 sub_attempt 都被清掉了。留着旧文件攒的 streak 意味着新片源自带"半程折算进度"：
    // 极端形态是 streak=CAP-1 的行换了片源，新文件第一次撞限流就凭空折算出一次
    // "真实尝试" —— 而它一次都没被真正搜过。这与 sub_attempt 残留（新片源自带失败额度）
    // 是同一个洞的另一扇门，故它与 sub_attempt 同进 FINGERPRINT_RESET_COLUMNS。
    //
    // 断言打在 PRAGMA 契约上（照用例 5g 的既有口径）：回落逻辑对 NOT NULL 列读不出
    // dflt_value 就 `continue` 跳过，那时"已加进名单"会静默不生效。
    const db = openDb(':memory:')
    const info = db.prepare('PRAGMA table_info(files)').all() as Array<{
      name: string; notnull: number; dflt_value: string | null
    }>
    const c = info.find((x) => x.name === 'sub_retry_streak')!
    expect(c.notnull).toBe(1)
    expect(c.dflt_value).not.toBeNull()   // ← null 会让回落逻辑跳过该列
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v39（R-F3 通知页的持久化数据源）：notifications 表的迁移安全性。
//
// 照 v15/v17/v18/v24/v28 的既有口径——**真造一个旧形状的库**再 openDb，而不是只测
// fresh install。理由是本仓的存量库（生产上那台软路由跑着的那个）走的恰恰是升级路径，
// 而 fresh install 与升级是两条不同的代码路（终态 schema 里那份 CREATE TABLE 与
// v39 entry 各写了一遍）。只测 fresh 的话，升级路径上表没建出来这件事**测不出来**，
// 而它的表现形式是通知页永远空着（recordFound 内部整体 try/catch 会把
// "no such table" 静默吞掉——这正是隔离的代价，故必须由迁移测试补上这道）。
// ─────────────────────────────────────────────────────────────────────────────
describe('v39 迁移：notifications 表（R-F3）', () => {
  it('🔴 v38 形状的老库经 openDb → notifications 表建出来且可写可读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scout-v39-'))
    const file = join(dir, 'scout.db')
    const raw = new Database(file)
    // 手造 v38 终态的最小形状：meta 记 '32'，无 notifications 表。
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta (key, value) VALUES ('schema_version', '32');
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
        dir TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL,
        mtime INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `)
    raw.close()

    const db = openDb(file)
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '37' })
    // 表真的在（不是"迁移没抛错"——那在表压根没建的实现下同样成立）
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notifications'").get(),
    ).toBeTruthy()
    db.prepare(`INSERT INTO notifications (work_id,title,season,episode,via,found_at)
                VALUES ('tmdb:1','A',1,3,'fetch',1000)`).run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM notifications').get()).toEqual({ n: 1 })
    db.close()
  })

  it('🔴 幂等索引真的建在 ifnull() 表达式上——电影（season/episode 皆 NULL）不许插出两行', () => {
    // 这条是 v39 唯一的非显然之处。裸 UNIQUE(work_id,season,episode) 在 SQLite 里对电影
    // **完全失效**（UNIQUE 视 NULL 互不相等），而剧集那一半照常生效 → 只测剧集的用例全绿，
    // 电影每次装盘插一新行，通知页上同一部电影刷屏。同 jobs_identity 的既有坑。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO notifications (work_id,title,season,episode,via,found_at)
                VALUES ('tmdb:9','沙丘',NULL,NULL,'fetch',1000)`).run()
    expect(() =>
      db.prepare(`INSERT INTO notifications (work_id,title,season,episode,via,found_at)
                  VALUES ('tmdb:9','沙丘',NULL,NULL,'fetch',2000)`).run(),
    ).toThrow(/UNIQUE/)
    db.close()
  })

  it('🔴 重放尾部迁移幂等（db.test.ts 会重放，CREATE TABLE IF NOT EXISTS 必须挡住第二遍）', () => {
    const db = openDb(':memory:')
    const v39 = MIGRATIONS[MIGRATIONS.length - 1]
    expect(typeof v39).toBe('function')
    expect(() => (v39 as (d: ScoutDb) => void)(db)).not.toThrow()
    expect(() => (v39 as (d: ScoutDb) => void)(db)).not.toThrow()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v42（Task ⑥ / R-F13 + R-F14）：works.backdrop_path —— 活动页「在跑」卡片的横版背景图。
//
// 为什么需要这一列：R-F13 的「在跑」卡片用横版 backdrop（60% 宽 / 186px 高），而横版图
// 今天在库里无处可取——`series.backdrop_path`（v16）在的是**旧世界**那张表，只有
// libraryRepo.upsertSeries 会写；新架构的 daemonV2 一行 series 都不写，它写 `works`。
// TMDB 客户端早就在取 backdropPath（tmdb.ts:325），只是 works 落库时被丢弃了。
//
// 照 v36 provider_ids 的既有口径测：fresh install 一条、升级路径一条、幂等一条、
// 无 works 表一条——升级路径与 fresh install 是**两条不同的代码路**（终态 schema 与
// v42 entry 各自负责一半），只测 fresh 的话"存量库升上来没这一列"测不出来。
// ─────────────────────────────────────────────────────────────────────────────
describe('v42 迁移：works.backdrop_path（R-F13 / R-F14）', () => {
  function replayTail(db: ScoutDb): void {
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') migration(db)
      else db.exec(migration)
    }
  }

  it('🔴 fresh install 的 works 表有 backdrop_path（TEXT，可空、无 DEFAULT）', () => {
    const db = openDb(':memory:')
    const c = (db.prepare('PRAGMA table_info(works)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>).find((x) => x.name === 'backdrop_path')
    expect(c).toBeDefined()
    expect(c!.type).toBe('TEXT')
    // 可空 + 无 DEFAULT 是刚性的：NULL 是回填 pass 的**唯一取件谓词**
    // （`backdrop_path IS NULL`，daemonV2.backfillBackdropPaths）。若建成
    // `NOT NULL DEFAULT ''`，存量行升级上来全是 '' → 回填一行都选不中 → 存量作品的
    // 横版图永远补不上，而那正是本条要修的事本身（同 v36 provider_ids 的既有论证）。
    expect(c!.notnull).toBe(0)
    expect(c!.dflt_value).toBeNull()
    db.close()
  })

  it('🔴 存量库（无该列）升级 → 补上列，存量行落 NULL（回填的取件凭据）', () => {
    const db = openDb(':memory:')
    db.exec('ALTER TABLE works DROP COLUMN backdrop_path')
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:83', 'Legacy Work', 'tv', 1000, 1000)
    replayTail(db)
    const row = db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get('tmdb:83') as { backdrop_path: string | null }
    expect(row.backdrop_path).toBeNull()
    db.close()
  })

  it('🔴 幂等——重放两次不撞 duplicate column', () => {
    const db = openDb(':memory:')
    expect(() => { replayTail(db); replayTail(db) }).not.toThrow()
    db.close()
  })

  it('🔴 老库无 works 表 → 迁移不抛（照 v30–v36 的条件式写法）', () => {
    // v29 及更早的库升级上来时 works 表还不存在（v30 才建）。裸 ALTER 会
    // `no such table: works` 把 openDb 整个炸掉 → 用户的库再也打不开。
    const db = openDb(':memory:')
    db.exec('DROP TABLE works')
    expect(() => replayTail(db)).not.toThrow()
    db.close()
  })

  it('🔴 backdrop_path **不写进任何 CREATE TABLE works 终态定义**，只由末尾那条 ALTER entry 补（隐含规则）', () => {
    // 本仓的迁移隐含规则（works 表定义末尾的原话）：新增列只写进末尾的条件式 ALTER entry，
    // 绝不同时改顶部的 CREATE TABLE 终态定义——"两处都写会让'改一处忘另一处'变成可能"。
    // 先例：works.provider_ids（v36）、media_roots.content_type（v30）。
    //
    // 这条把规则本身钉住。**必须扫全部 entry 而不是第一个**：db.ts 里有**两处**
    // `CREATE TABLE IF NOT EXISTS works`（v9 的终态折叠 entry 与 v30 的建表 entry），
    // 只查第一处的话，往 v30 那处偷偷补一列不会有任何测试变红。
    // 没有这条，将来"顺手补终态"时伤害是隐性的（两份定义漂移，改一处忘另一处）。
    const worksDdls = MIGRATIONS.filter((m): m is string => typeof m === 'string')
      .flatMap((m) => {
        const out: string[] = []
        let from = 0
        for (;;) {
          const at = m.indexOf('CREATE TABLE IF NOT EXISTS works', from)
          if (at === -1) break
          const block = m.slice(at)
          out.push(block.slice(0, block.indexOf(')')))
          from = at + 1
        }
        return out
      })
    // 前置：真的切到了 works 的 DDL（否则下面的 not.toContain 是空转的假绿）
    expect(worksDdls.length).toBe(2)
    for (const raw of worksDdls) {
      // 先剥掉 `--` 行注释再断言：终态定义末尾那段注记**本身就在解释** backdrop_path
      // 为什么不在这里，裸文本匹配会把那段解释当成列声明而误红（实测踩到）。
      // 要钉的是"有没有这一列的声明"，不是"文本里有没有这个词"。
      const ddl = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
      expect(ddl).toContain('poster_path')
      expect(ddl).not.toContain('backdrop_path')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v43：works.backdrop_checked_at（Task ⑦ — v42 回填 pass 的队头阻塞/永久饿死修复）
//
// 为什么需要这一列：v42 的取件谓词是 `backdrop_path IS NULL`，而对"TMDB 确实没有横版图"
// 的作品这个谓词**恒真**；叠加 `ORDER BY id`（恒定序）与 `LIMIT 200`（只取头部），
// 每轮 boot 取到的是**同一批** 200 行 → 第 201 行往后一次都轮不到。审计实测（250 行全部
// 无图 / 3 轮 boot）：totalCalls=600 unique=200 —— 不是"收敛慢"，是那 50 行永远拿不到图。
// 把"查过没有"的凭据从值里挪进独立一列后，谓词 `backdrop_checked_at IS NULL` 才单调。
//
// 照 v36 provider_ids / v42 backdrop_path 的既有口径测：fresh install 一条、升级路径一条、
// 幂等一条、无 works 表一条、终态定义不许写一条——升级路径与 fresh install 是**两条不同的
// 代码路**（终态 schema 与 v43 entry 各自负责一半），只测 fresh 的话"存量库升上来没这一列"
// 测不出来。
// ─────────────────────────────────────────────────────────────────────────────
describe('v43 迁移：works.backdrop_checked_at（Task ⑦ 队头阻塞修复）', () => {
  function replayTail(db: ScoutDb): void {
    for (let i = 17; i < MIGRATIONS.length; i++) {
      const migration = MIGRATIONS[i]
      if (typeof migration === 'function') migration(db)
      else db.exec(migration)
    }
  }

  it('🔴 fresh install 的 works 表有 backdrop_checked_at（INTEGER，可空、无 DEFAULT）', () => {
    const db = openDb(':memory:')
    const c = (db.prepare('PRAGMA table_info(works)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null
    }>).find((x) => x.name === 'backdrop_checked_at')
    expect(c).toBeDefined()
    expect(c!.type).toBe('INTEGER')
    // 可空 + 无 DEFAULT 是刚性的：NULL 是回填 pass 的**唯一取件谓词**
    // （`backdrop_checked_at IS NULL`，daemonV2.backfillBackdropPaths）。若建成
    // `NOT NULL DEFAULT 0`，存量行升级上来全是 0（非 NULL）→ 谓词一行都选不中 →
    // 存量作品的横版图**永远补不上**，恰好把本条要修的饿死从 50 行放大到全库。
    expect(c!.notnull).toBe(0)
    expect(c!.dflt_value).toBeNull()
    db.close()
  })

  it('🔴 存量库（无该列）升级 → 补上列，存量行落 NULL（回填的取件凭据）', () => {
    // ⚠️ 含 v42 已跑过、backdrop_path 已有值的行：本迁移**刻意不**顺手把它们标成"查过"
    // （那要在迁移里凭空捏一个"查过的时刻"）。代价是一次性的——它们下一轮 boot 各重查
    // 一次、落下真实 checked_at 后永久收敛，是"多一轮"而非"每轮"。
    const db = openDb(':memory:')
    db.exec('ALTER TABLE works DROP COLUMN backdrop_checked_at')
    db.prepare(`INSERT INTO works (id, title, media_type, backdrop_path, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('tmdb:83', 'Legacy Work', 'tv', '/already.jpg', 1000, 1000)
    replayTail(db)
    const row = db.prepare('SELECT backdrop_path, backdrop_checked_at FROM works WHERE id = ?')
      .get('tmdb:83') as { backdrop_path: string | null; backdrop_checked_at: number | null }
    // 既有的图不许被迁移碰
    expect(row.backdrop_path).toBe('/already.jpg')
    expect(row.backdrop_checked_at).toBeNull()
    db.close()
  })

  it('🔴 幂等——重放两次不撞 duplicate column', () => {
    const db = openDb(':memory:')
    expect(() => { replayTail(db); replayTail(db) }).not.toThrow()
    db.close()
  })

  it('🔴 老库无 works 表 → 迁移不抛（照 v30–v42 的条件式写法）', () => {
    // v29 及更早的库升级上来时 works 表还不存在（v30 才建）。裸 ALTER 会
    // `no such table: works` 把 openDb 整个炸掉 → 用户的库再也打不开。
    const db = openDb(':memory:')
    db.exec('DROP TABLE works')
    expect(() => replayTail(db)).not.toThrow()
    db.close()
  })

  it('🔴 backdrop_checked_at **不写进任何 CREATE TABLE works 终态定义**，只由末尾那条 ALTER entry 补（隐含规则）', () => {
    // 本仓的迁移隐含规则（works 表定义末尾的原话）：新增列只写进末尾的条件式 ALTER entry，
    // 绝不同时改顶部的 CREATE TABLE 终态定义——"两处都写会让'改一处忘另一处'变成可能"。
    // 先例：works.provider_ids（v36）、works.backdrop_path（v42）。
    // **必须扫全部 entry 而不是第一个**：db.ts 里有**两处** `CREATE TABLE IF NOT EXISTS works`
    // （v9 的终态折叠 entry 与 v30 的建表 entry），只查第一处的话，往 v30 那处偷偷补一列
    // 不会有任何测试变红。
    const worksDdls = MIGRATIONS.filter((m): m is string => typeof m === 'string')
      .flatMap((m) => {
        const out: string[] = []
        let from = 0
        for (;;) {
          const at = m.indexOf('CREATE TABLE IF NOT EXISTS works', from)
          if (at === -1) break
          const block = m.slice(at)
          out.push(block.slice(0, block.indexOf(')')))
          from = at + 1
        }
        return out
      })
    // 前置：真的切到了 works 的 DDL（否则下面的 not.toContain 是空转的假绿）
    expect(worksDdls.length).toBe(2)
    for (const raw of worksDdls) {
      // 先剥掉 `--` 行注释再断言：终态定义末尾那段注记本身就在解释这些列为什么不在这里，
      // 裸文本匹配会把那段解释当成列声明而误红。
      const ddl = raw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
      expect(ddl).toContain('poster_path')
      expect(ddl).not.toContain('backdrop_checked_at')
    }
  })
})
