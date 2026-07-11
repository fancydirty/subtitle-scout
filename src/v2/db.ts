import Database from 'better-sqlite3'

export type ScoutDb = Database.Database

// runs.llm_calls/assrt_calls：来自 pipeline stats（executor.ts 的 runs.insert 调用点）；
// assrt_calls 现计全部 provider api 调用（列名历史沿用，非仅 ASSRT）。
// （MIGRATIONS[0] DDL 字符串里同名列的旧注释保持不动——迁移日志按惯例不做原地编辑，纠正写在这里。）

// export：供 migration.provider-ref.test.ts 手工重放到指定版本用
export const MIGRATIONS: string[] = [
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
  journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER  -- assrt_calls：多源后计入全部 provider api 调用次数，列名沿用
);
CREATE TABLE subtitles (            -- 借鉴 Bazarr TableEpisodesSubtitles：一个视频可挂多个字幕文件
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,            -- episodes.id 或 movies.id
  path TEXT NOT NULL, language TEXT NOT NULL,   -- zh-Hans/zh-Hant
  source TEXT NOT NULL,             -- scout-download / adopted-local / preexisting
  assrt_sub_id INTEGER,             -- 多源后弃写，仅历史数据保留（见 provider_ref 迁移）
  size INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(item_id, path)
);
CREATE TABLE blacklist (            -- 借鉴 Bazarr：已确认坏/错的候选，rank 前硬过滤
  assrt_sub_id INTEGER NOT NULL, filename TEXT NOT NULL DEFAULT '',
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(assrt_sub_id, filename)
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_reconcile_at 等
  `.trim(),
  // v2: provider-neutral 迁移 —— subtitles/blacklist 改用 provider_ref('<provider>:<providerId>')
  // 寻址；旧 assrt_sub_id 列保留（SQLite 删列代价高，且不再写入，仅历史数据留存供追溯）。
  `
ALTER TABLE subtitles ADD COLUMN provider_ref TEXT;
UPDATE subtitles SET provider_ref = 'assrt:' || assrt_sub_id WHERE assrt_sub_id IS NOT NULL;
CREATE TABLE blacklist_v2 (
  provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(provider_ref, filename)
);
INSERT INTO blacklist_v2 (provider_ref, filename, reason, created_at)
  SELECT 'assrt:' || assrt_sub_id, filename, reason, created_at FROM blacklist;
DROP TABLE blacklist;
ALTER TABLE blacklist_v2 RENAME TO blacklist;
  `.trim(),
  // v3: origin_lang——缓存 TMDB original_language，per 剧/片解析一次，避免重复回查
  // origin_lang: NULL=未解析；ISO code(zh/ja/en…)=已解析、不再回查 TMDB
  `
ALTER TABLE movies ADD COLUMN origin_lang TEXT;
ALTER TABLE series ADD COLUMN origin_lang TEXT;
  `.trim(),
  // v4: error_attempt——双轨 attempt 审计修正。jobs.attempt 曾同时被 completeNoMatch
  // （内容失败：1/2/4/8 天退避梯 + 第 5 次 dormant）和 completeError（瞬时错误：
  // 30s..15min 短退避梯）充电，两条速率差异巨大的轨共用一个计数器会互相污染判据
  // （见 jobsRepo.ts 顶部注释）。新增独立持久列只服务瞬时错误轨；attempt 之后只服务
  // 内容轨。旧库存量 attempt 是内容失败历史，不能凭空过继给 error_attempt，回填默认 0。
  `
ALTER TABLE jobs ADD COLUMN error_attempt INTEGER NOT NULL DEFAULT 0;
  `.trim(),
  // v5: needs_review sub_status——ask_user 诚实记账修正。executor.ts 曾把 gate 'ask_user'
  // （候选存在但置信不足）和 no_safe_match（穷尽未找到）一样映射成 unavailable——前端
  // 展示"暂无"，掩盖了本可人工确认的候选。新增 sub_status='needs_review' 让这类结果
  // 诚实区分。SQLite 不支持 ALTER 已有 CHECK 约束，标准作法：建新表（含扩容后的 CHECK）
  // →显式列拷数据→删旧表→改名（12-step 摘要版）。episodes/movies 都要扩容；两表在此
  // 之前的历次迁移里都没有额外索引/触发器，重建无需连带重建它们；episodes.series_id 的
  // 外键无子表引用 episodes，重建期间不会有悬空引用风险。
  `
CREATE TABLE episodes_new (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES series(id),
  season INTEGER NOT NULL, episode INTEGER NOT NULL,
  name TEXT, path TEXT NOT NULL,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored','needs_review')),
  status_reason TEXT, recheck_after INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO episodes_new
  (id, series_id, season, episode, name, path, sub_status, status_reason, recheck_after, updated_at)
  SELECT id, series_id, season, episode, name, path, sub_status, status_reason, recheck_after, updated_at
  FROM episodes;
DROP TABLE episodes;
ALTER TABLE episodes_new RENAME TO episodes;

CREATE TABLE movies_new (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, chinese_title TEXT, poster_tag TEXT,
  year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored','needs_review')),
  status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
  origin_lang TEXT
);
INSERT INTO movies_new
  (id, name, chinese_title, poster_tag, year, path, provider_ids, sub_status, status_reason, recheck_after, updated_at, origin_lang)
  SELECT id, name, chinese_title, poster_tag, year, path, provider_ids, sub_status, status_reason, recheck_after, updated_at, origin_lang
  FROM movies;
DROP TABLE movies;
ALTER TABLE movies_new RENAME TO movies;
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
