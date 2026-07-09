import Database from 'better-sqlite3'

export type ScoutDb = Database.Database

const MIGRATIONS: string[] = [
  // v1: Complete schema from spec §1
  `
CREATE TABLE series (
  id TEXT PRIMARY KEY,            -- Jellyfin SeriesId
  name TEXT NOT NULL,             -- 刮削名
  chinese_title TEXT,             -- zh-CN RemoteSearch 结果（可空=查过没有）
  chinese_title_checked_at INTEGER,
  poster_tag TEXT,                -- Jellyfin Primary ImageTag（前端经代理取图）
  year INTEGER, provider_ids TEXT -- JSON
);
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,            -- Jellyfin ItemId
  series_id TEXT NOT NULL REFERENCES series(id),
  season INTEGER NOT NULL, episode INTEGER NOT NULL,
  name TEXT, path TEXT NOT NULL,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored')),
  -- covered=外挂中字已就位; embedded=内嵌中字(不需处理); unavailable=搜索穷尽确认无(带复查时间);
  -- ignored=国产等策略跳过
  status_reason TEXT, recheck_after INTEGER,  -- unavailable 的衰减复查
  updated_at INTEGER NOT NULL
);
CREATE TABLE movies (               -- 与 episodes 同构，少 series 维度
  id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_tag TEXT,
  year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored')),
  status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL
);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('series_season','movie')),
  series_id TEXT, season INTEGER,   -- kind=series_season 时
  movie_id TEXT,                    -- kind=movie 时
  state TEXT NOT NULL CHECK(state IN
    ('wanted','searching','downloading','verifying','done','failed','dormant')),
  priority INTEGER NOT NULL DEFAULT 0,   -- 播放触发 = 100，调和发现 = 0
  target_episodes TEXT,             -- JSON: 本 job 要覆盖的集（movie 为 null）
  attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,            -- 指数退避: 1d,2d,4d,8d → dormant
  lease_until INTEGER,              -- 租约: 领取时置 now+30min；超租视为死亡可重领（防挂死锁死）
  last_error TEXT, journal_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- SQLite 的 UNIQUE 视 NULL 互不相等，必须用表达式唯一索引防止同剧同季重复建 job：
CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''));
-- claimNext 派发热路径索引（state 过滤 + priority/created_at 排序）：
CREATE INDEX jobs_claim ON jobs(state, priority DESC, created_at);
CREATE TABLE runs (                 -- 替代 ledger.jsonl；journals 明细文件保留并引用
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id),
  started_at INTEGER NOT NULL, finished_at INTEGER,
  decision TEXT, detail TEXT,       -- detail=人话摘要（dashboard 直接用，不再啃 JSON）
  journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER
);
CREATE TABLE subtitles (            -- 借鉴 Bazarr TableEpisodesSubtitles：一个视频可挂多个字幕文件
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,            -- episodes.id 或 movies.id
  path TEXT NOT NULL, language TEXT NOT NULL,   -- zh-Hans/zh-Hant
  source TEXT NOT NULL,             -- scout-download / adopted-local / preexisting
  assrt_sub_id INTEGER, size INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(item_id, path)
);
CREATE TABLE blacklist (            -- 借鉴 Bazarr：已确认坏/错的候选，rank 前硬过滤
  assrt_sub_id INTEGER NOT NULL, filename TEXT NOT NULL DEFAULT '',
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(assrt_sub_id, filename)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_reconcile_at 等
  `.trim(),
]

export function openDb(path: string): ScoutDb {
  const db = new Database(path)

  // Pragma 三件套
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  // 读取当前 schema 版本（meta 表不存在时为 0）
  let currentVersion = 0
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
    if (row) {
      currentVersion = parseInt(row.value, 10)
    }
  } catch (err) {
    // meta 表不存在，currentVersion 保持为 0
  }

  // 执行未应用的迁移
  if (currentVersion < MIGRATIONS.length) {
    const migrate = db.transaction(() => {
      for (let i = currentVersion; i < MIGRATIONS.length; i++) {
        db.exec(MIGRATIONS[i])
        const newVersion = i + 1
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
          String(newVersion)
        )
      }
    })
    migrate()
  }

  return db
}
