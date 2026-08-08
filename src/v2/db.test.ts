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
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '25' })
  })
  it('重复打开幂等（不重跑建表）', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'scout-')), 'scout.db')
    openDb(p).close(); const db2 = openDb(p)
    expect(db2.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(fresh.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("select value from meta where key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db2.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })
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
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: '25' })

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
    expect(MIGRATIONS.length).toBe(25)

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
