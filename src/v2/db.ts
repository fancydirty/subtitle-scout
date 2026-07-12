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
  // v6: needs_review 全灭——ask_user 判定路径不复存在(agent 判断链两态化,拿不准的候选
  // 走 staging 沙盒下载+体检+终审后必须二选一表态)。存量 needs_review 行复位为 missing
  // + recheck_after=now,下一轮调和用新流程重跑它们,预期开箱验证通过直接转绿。CHECK 约束
  // 里的 'needs_review' 枚举值有意保留容忍(YAGNI)——不再有代码写它,但不做又一次整表
  // 重建只为收紧一个再没人写的枚举值。
  `
UPDATE episodes
  SET sub_status = 'missing', status_reason = NULL,
      recheck_after = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE sub_status = 'needs_review';
UPDATE movies
  SET sub_status = 'missing', status_reason = NULL,
      recheck_after = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
      updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
  WHERE sub_status = 'needs_review';
  `.trim(),
  // v7: realign job kind + plan_ref——library realign 功能新增 job kind。SQLite 不支持
  // ALTER 已有 CHECK 约束，标准作法同 v5(needs_review)：建新表(扩容 CHECK + 新列 plan_ref)
  // → 显式列拷数据 → 删旧表 → 改名。与 v5 不同：jobs 表在此之前已有 jobs_identity/jobs_claim
  // 两个索引（v1 DDL 里紧跟 CREATE TABLE jobs 建的），DROP TABLE 会连带丢掉它们，必须显式
  // 重建，不能照抄 v5 注释"之前没有额外索引，重建无需连带重建"的结论。runs.job_id
  // REFERENCES jobs(id) 是本表的子表——DROP TABLE jobs 期间 SQLite 只在对子表做 DML 时
  // 检查外键，不会因父表被删而报错；INSERT INTO jobs_new ... SELECT ... FROM jobs 原样
  // 拷贝全部 id，RENAME 完成后 runs.job_id 依然精确指向同一批 id，外键关系完整无损。
  // realign job 语义：series_id 有值、season 恒 NULL、plan_ref 指向整理清单(manifest)路径
  // （诊断创建时为 NULL，真正开始执行、manifest 落盘后由 jobsRepo.setPlanRef 回填——诊断
  // 那一刻还没有清单可指）。jobs_identity 的表达式唯一索引 ifnull(season,-1) 天然让
  // "同剧只能有一个 realign job"成立，不需要为此单独改索引定义。
  `
CREATE TABLE jobs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('series_season','movie','realign')),
  series_id TEXT, season INTEGER,
  movie_id TEXT,
  plan_ref TEXT,
  state TEXT NOT NULL CHECK(state IN
    ('wanted','searching','downloading','verifying','done','failed','dormant')),
  priority INTEGER NOT NULL DEFAULT 0,
  target_episodes TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_attempt INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  lease_until INTEGER,
  last_error TEXT, journal_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
INSERT INTO jobs_new
  (id, kind, series_id, season, movie_id, state, priority, target_episodes,
   attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
   created_at, updated_at)
  SELECT id, kind, series_id, season, movie_id, state, priority, target_episodes,
         attempt, error_attempt, next_retry_at, lease_until, last_error, journal_ref,
         created_at, updated_at
  FROM jobs;
DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''));
CREATE INDEX jobs_claim ON jobs(state, priority DESC, created_at);
  `.trim(),
]

export function openDb(path: string): ScoutDb {
  const db = new Database(path)

  // Pragma 三件套
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  // foreign_keys 故意先关掉、留到迁移跑完之后才打开（见下方 return 前的说明）——better-sqlite3
  // 的连接默认就是 foreign_keys=ON（不是"不设置=关闭"，是"不设置=已经开着"，必须显式 OFF），
  // v7 迁移重建 jobs 表时，runs.job_id REFERENCES jobs(id) 是真实声明的外键（不同于 v5 时的
  // episodes/movies，那两张表在当时没有任何子表声明 REFERENCES 指向它们）。SQLite 的
  // DROP TABLE 对声明了外键的父表会做隐式 DELETE 语义检查：哪怕马上 ALTER TABLE ... RENAME
  // 把同名表换回来、数据/id 都原样复原，foreign_keys=ON（含 defer_foreign_keys=ON 声明的
  // 延迟检查——实测过，同样在 COMMIT 时报错）仍然会判定引用失效而报 FOREIGN KEY constraint
  // failed——延迟检查绑定的是"原表"这个 schema 对象的身份，不认"同名新表"。这是 SQLite 官方
  // 文档"Making Other Kinds Of Table Schema Changes"12 步流程的明文要求：步骤 1 要求在自动
  // 提交模式（不在事务内）下先 PRAGMA foreign_keys=OFF，重建完成后再 PRAGMA foreign_keys=ON
  // （该 pragma 在事务中途切换是 no-op，必须在事务开始前完成）。迁移前的 PRAGMA
  // foreign_key_check 体检不依赖这个开关（体检本身独立于开关状态），迁移涉及的
  // INSERT ... SELECT 拷贝的数据完整性由体检已保证零违例，迁移后 return 前重新打开
  // foreign_keys=ON 让 runtime DML 强校验照常生效。
  db.pragma('foreign_keys = OFF')

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
    // Pre-flight: v5 迁移会拿 episodes/movies 里的存量行原样拷进新建的 episodes_new/
    // movies_new（同样声明 series_id → series(id) 外键）——若库里蛰伏着孤儿行（比如 series
    // 行曾被手工删除、或数据是在 foreign_keys=OFF 时代写入的，从未被真正验证过），拷贝
    // 期间这行数据本身就是脏的，不修就永远是脏的（与本连接这一刻 foreign_keys 开关无关，
    // 见上方 pragma 注释——迁移期间这个开关本就故意关着）。这里在动手改表之前先体检一遍，
    // 把违例行（表名+rowid）摊开写进报错，一步到位可操作，避免守护进程日后拿一句晦涩的
    // FOREIGN KEY constraint failed 反复重启也炸不出头绪。
    const violations = db.prepare('PRAGMA foreign_key_check').all() as Array<{
      table: string
      rowid: number | string | null
      parent: string
      fkid: number
    }>
    if (violations.length > 0) {
      const detail = violations
        .map((v) => {
          let idNote = ''
          try {
            const row = db.prepare(`SELECT id FROM "${v.table}" WHERE rowid = ?`).get(v.rowid) as
              | { id: unknown }
              | undefined
            if (row?.id !== undefined) idNote = ` (id=${JSON.stringify(row.id)})`
          } catch {
            // 表没有 id 列或查询失败——rowid 已足够定位，静默降级
          }
          return `${v.table} rowid=${v.rowid ?? '?'}${idNote} → 缺失 ${v.parent} 的外键引用`
        })
        .join('; ')
      const message =
        `数据库存在外键违例，无法安全迁移（schema v${currentVersion} → v${MIGRATIONS.length}）：${detail}。` +
        `请先手工修复（删除孤儿行或补全被引用的父行）后再重启 —— 迁移未执行，数据库仍停留在 v${currentVersion}。`
      db.close() // 不留半开连接：修复者接下来大概率要用另一个连接直接改数据
      throw new Error(message)
    }

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

  // 迁移（如果跑了）已经全部提交——现在才打开运行期外键强校验，覆盖有迁移和无迁移两条
  // 路径（无迁移路径同样需要它，只是从未被上面 if 分支覆盖到）。见顶部 pragma 注释：
  // 提前打开会导致 v7 迁移的 DROP TABLE jobs（含 runs.job_id 的真实外键引用）无法完成。
  db.pragma('foreign_keys = ON')

  return db
}
