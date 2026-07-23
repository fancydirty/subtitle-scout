import Database from 'better-sqlite3'

export type ScoutDb = Database.Database

// 去 Jellyfin 化战役 P2（design: docs/design/2026-07-16-de-jellyfin-design.md §P2，D7 裁决）：
// 本文件历史上是一条 v1→v8 的逐步 ALTER 迁移链（8 条 entry，服务运行中用户库的原地升级）。
// v9 起该链被整体折叠成下面唯一一条终态 entry——不再是"从 v1 逐步迁移到 v9"，而是"任何空库
// （meta.schema_version 起始 0）直接落地 v9 终态 schema"。原因：用户拍板"一切开发期产生的
// 数据都可以牺牲"——真状态活在磁盘上的字幕文件，DB 只是索引，随时可从磁盘重建（B 组自研巡检
// 已具备这个能力）；旧 scout.db 留在盘上不会再被任何代码路径读取，操作者自行删除或改名 .bak。
// openDb() 的版本化机制本身（meta.schema_version 门、迁移前 FK 体检、迁移期 foreign_keys
// 开关、事务）原样保留——它是通用基础设施，不因当前 MIGRATIONS 只剩一条 entry 而失去意义：
// 未来若再长出 v10，这条机制照常够用，不需要重新发明。
type Migration = string | ((db: ScoutDb) => void)

export const MIGRATIONS: Migration[] = [
  // v9: 终态 schema（去 Jellyfin 化 P2）。id 语义换自有：series/movies.id = 'tmdb:<TMDB id>'，
  // episodes.id = 'tmdb:<TMDB id>/s<N>e<M>'（无零填充）——id 即身份，一切"拿 id 换身份"的
  // jf.getItem 缝从根上消失（src/v2/ownIds.ts 的 seriesId/episodeId/tmdbIdFromOwnId 是这套
  // 形状的唯一构造/解析入口，T3 摄取层与下游消费方共同复用，命名不可漂移）。
  `
CREATE TABLE series (
  id TEXT PRIMARY KEY,            -- 自有 id：tmdb:<TMDB id>（TMDB 身份直嵌主键，无需二次换取）
  name TEXT NOT NULL,             -- 刮削名
  chinese_title TEXT,             -- zh-CN 中文名（可空=查过没有）
  chinese_title_checked_at INTEGER,
  poster_path TEXT,               -- TMDB 图片路径（如 '/dqZEN...jpg'；web 端自拼 CDN URL 前缀）
  year INTEGER, provider_ids TEXT,-- JSON（imdb 等备用 id；D5：v9 起 ingest 正常写入，非死列）
  origin_lang TEXT                -- TMDB original_language 缓存；NULL=未解析
);
CREATE TABLE episodes (
  id TEXT PRIMARY KEY,            -- 自有 id：tmdb:<TMDB id>/s<N>e<M>（无零填充，如 s1e2）
  series_id TEXT NOT NULL REFERENCES series(id),
  season INTEGER NOT NULL, episode INTEGER NOT NULL,
  name TEXT, path TEXT NOT NULL,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored','needs_review')),
  -- covered=外挂中字已就位; embedded=内嵌中字(不需处理); unavailable=搜索穷尽确认无(带复查时间);
  -- ignored=国产等策略跳过; needs_review 枚举值历史保留(YAGNI)——判定路径已死,不再有代码写它
  status_reason TEXT, recheck_after INTEGER,  -- unavailable 的衰减复查
  updated_at INTEGER NOT NULL,
  probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT
  -- ffprobe 内嵌字幕轨探测记忆化(P1 streamProbe.ts)：按 (path,mtime,size) 存库,文件不变不重探；
  -- embedded_langs=JSON 数组,原始 ffprobe 语言 tag(未归一,归一是消费方 langOf 的事)；
  -- NULL=从未探测过,或探测不可用(无 ffprobe 二进制/文件损坏/超时——降级为"只认 sidecar")
);
CREATE TABLE movies (               -- 与 episodes 同构，少 series 维度
  id TEXT PRIMARY KEY,            -- 自有 id：tmdb:<TMDB id>
  name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT,
  year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored','needs_review')),
  status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
  origin_lang TEXT,
  probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT
);
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('series_season','movie','realign','worker_task')),
  series_id TEXT, season INTEGER,   -- kind=series_season 时
  movie_id TEXT,                    -- kind=movie 时
  plan_ref TEXT,                    -- kind=realign：整理清单(manifest)路径；诊断创建时 NULL
  payload TEXT,                     -- kind=worker_task：JSON 通用载荷（v3 主代理派活）
  parent_job_id INTEGER REFERENCES jobs(id), -- worker_task 派生来源（如 100 溢出的 sibling 分片）
  state TEXT NOT NULL CHECK(state IN
    ('wanted','searching','downloading','verifying','done','failed','dormant')),
  priority INTEGER NOT NULL DEFAULT 0,   -- 播放触发 = 100，调和发现 = 0
  target_episodes TEXT,             -- JSON: 本 job 要覆盖的集（movie 为 null）
  attempt INTEGER NOT NULL DEFAULT 0,       -- 内容失败轨：1/2/4/8 天退避梯 + 第 5 次 dormant
  error_attempt INTEGER NOT NULL DEFAULT 0, -- 瞬时错误轨：30s..15min 短退避梯（与 attempt 分账，见 jobsRepo.ts 顶部注释）
  next_retry_at INTEGER,            -- 指数退避
  lease_until INTEGER,              -- 租约: 领取时置 now+30min；超租视为死亡可重领（防挂死锁死）
  last_error TEXT, journal_ref TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- SQLite 的 UNIQUE 视 NULL 互不相等，必须用表达式唯一索引防止同剧同季重复建 job。worker_task
-- 复用既有 series_id/season/movie_id 三列做身份 dedup（不是新 identity 方案）：kind 本身在
-- 元组里，worker_task 与同 series_id/season 的 series_season 行天然不冲突，天然获得"崩溃
-- 重启不重复派"的幂等 upsert（与 upsertWanted 同一套 ON CONFLICT DO UPDATE 语义）。没有自然
-- 季/剧归属的通用任务用合成 series_id（如 'orchestrator-shard-<parentJobId>-<n>'）+
-- season/movie_id 恒 NULL，同样落在这三列方案里：
CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''));
-- claimNext 派发热路径索引（state 过滤 + priority/created_at 排序）：
CREATE INDEX jobs_claim ON jobs(state, priority DESC, created_at);
CREATE INDEX jobs_parent ON jobs(parent_job_id);
CREATE TABLE runs (                 -- 替代 ledger.jsonl；journal_path 列结构上保留（旧管线的
                                     -- journalStore/withJournal 已随 Wave 2D 删除，今天所有
                                     -- 写入方都传 journalPath: null，没有实际 journal 文件可引用）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES jobs(id),
  started_at INTEGER NOT NULL, finished_at INTEGER,
  decision TEXT, detail TEXT,       -- detail=人话摘要（dashboard 直接用，不再啃 JSON）
  journal_path TEXT, llm_calls INTEGER, assrt_calls INTEGER  -- assrt_calls：现计全部 provider api 调用次数（列名历史沿用，非仅 ASSRT）
);
CREATE TABLE subtitles (            -- 借鉴 Bazarr TableEpisodesSubtitles：一个视频可挂多个字幕文件
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,            -- episodes.id 或 movies.id（自有 id 空间，值域随 P2 变化，结构不变）
  path TEXT NOT NULL, language TEXT NOT NULL,   -- any language tag, e.g. zh-Hans/zh-Hant/en (A2)
  source TEXT NOT NULL,             -- scout-download / adopted-local / preexisting
  provider_ref TEXT,                -- provider-neutral 候选标识 '<provider>:<providerId>'（如 assrt:713051）
  assrt_sub_id INTEGER,             -- 历史遗留列，不再写入，仅存量数据留存供追溯
  size INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(item_id, path)
);
CREATE TABLE blacklist (            -- 借鉴 Bazarr：已确认坏/错的候选，rank 前硬过滤
  provider_ref TEXT NOT NULL, filename TEXT NOT NULL DEFAULT '',
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(provider_ref, filename)
);
CREATE TABLE parked_paths (         -- 未识别文件的正式户口（不混进 episodes/movies）；每轮巡检重试，供 P6 救援页读取
  path TEXT PRIMARY KEY, park_reason TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL
);
CREATE TABLE identify_overrides (   -- P6 认领写入；识别层消歧前查（最长前缀匹配）
  path_prefix TEXT PRIMARY KEY, tmdb_id TEXT NOT NULL,
  is_tv INTEGER NOT NULL,
  season INTEGER,                 -- P7 disambiguation 补丁：认领时人类一并给出的季号（可空=未指定）。
                                   -- 仅 is_tv 时有意义——非空时 recognize() 的 claim-gated 宽松救援把
                                   -- 路径末尾数字当"该季内集号"直接采信（无歧义）；为空时只能当绝对
                                   -- 集号，多季剧下 ingest 层会 park('override-ambiguous-numbering')
                                   -- 而不是瞎猜（见 src/v2/ingest.ts、src/recognition/index.ts）。
  created_at INTEGER NOT NULL
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_reconcile_at 等
  `.trim(),
  // v10（胶水层修复战役，2026-07-16）：三列事实增量。layout_nonstandard=摄取层观察到的
  // "磁盘布局不合规范形"series 级事实（债务D1，realign 出生信号之一）；search_attempts=
  // item 级内容退避阶梯计数（裁决 R-3：退避从 jobs 状态机下沉到事实层）。
  `ALTER TABLE series ADD COLUMN layout_nonstandard INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE episodes ADD COLUMN search_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE movies ADD COLUMN search_attempts INTEGER NOT NULL DEFAULT 0`,
  // v11（R-11 用户裁决 2026-07-16）：taskType 进身份元组——find_subtitle 与 realign 对同一
  // series 不再共享身份；find 任务的范围事实（哪些季）随 payload.seasons 下发，season
  // 身份列对新 find 行恒 NULL。原 dispatch 工具的 null-season 拒绝守卫（其存在唯一理由就是
  // 这个身份碰撞）随之处决。
  `DROP INDEX jobs_identity;
   CREATE UNIQUE INDEX jobs_identity ON jobs(kind, ifnull(series_id,''), ifnull(season,-1), ifnull(movie_id,''), ifnull(json_extract(payload,'$.taskType'),''))`,
  // v12（dashboard 重建战役 G1）：三表一列增量，纯 CREATE TABLE / ADD COLUMN，不做表重建。
  `
CREATE TABLE tmdb_seasons (        -- spec §8.1 应有集缓存（三层格阵第一层）
  series_id TEXT NOT NULL,         -- own id: 'tmdb:<id>'
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  title TEXT,                      -- 集标题，可 NULL
  fetched_at INTEGER NOT NULL,     -- TTL 刷新锚（7 天）
  PRIMARY KEY (series_id, season, episode)
);
CREATE TABLE settings (            -- spec §7 行为级设置
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE media_roots (         -- spec §7 守备目录（Jellyfin 分界）
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'local',   -- 存储协议战役预留
  added_at INTEGER NOT NULL
);
ALTER TABLE runs ADD COLUMN trace_json TEXT;   -- 痕迹通道 C 收官快照
  `.trim(),
  // v13（验收修复轮一 Task V1，design: docs/design/2026-07-17-acceptance-round-1-design.md §A，
  // 用户裁决：媒体库分区与守备目录解耦，改由 TMDB 元数据派生）：纯增量一列。genres=TMDB genre id
  // 的 JSON 数组（如 '[16,35]'，16=Animation）；NULL=尚未富化（含存量 36 部剧与"空名 ? 卡"）。
  // 富化重试机制（ingest.ts pass 收尾）逐步回填，sectionOf 新规读它判"动漫 vs 剧集"。
  `ALTER TABLE series ADD COLUMN genres TEXT`,
  // v14（救援R4b）：特典机械排除的"用户翻案"豁免表。isMechanicalExtra 命中的路径在
  // exclude_extras 开启时会被 park excluded-extra；用户在甄别页「Excluded extras」箱点翻案时，
  // 把该 path 写进这里——机械过滤器每轮 pass 先查此表，命中即跳过铁案、让文件重回正常识别流
  // （否则文件名仍匹配 NC 正则，下一轮 pass 会无限再排除，翻案沦为 no-op）。持久化独立成表
  // 而非复用 parked_paths.reason：recognize() 的 upsertParkedPath 会覆写 reason，豁免标记若挂在
  // parked_paths 上会被识别失败的再 park 冲掉——独立表不受该覆写影响，豁免恒久生效。
  `CREATE TABLE extras_exemptions (
  path TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
)`,
  // v15（救援R5）：episodes/movies.sub_status 的 CHECK 约束需收 'hardsub-assumed'（agent 档判定
  // /aggressive 档机械直判都要能落这个值）——SQLite 不支持 ALTER 已有 CHECK 约束，标准作法是
  // 12 步建新表→拷数据→删旧表→改名（见 openDb() 顶部 pragma 注释，foreign_keys=OFF 已在迁移期
  // 全程生效，RENAME 回原名对 episodes.series_id 的外键身份判定无影响，因为没有任何表
  // REFERENCES episodes/movies——重建这两张表本身不触发"父表被引用"那条陷阱）。列清单/顺序=
  // 顶部 v9 终态定义 + v10 用 ALTER TABLE ADD COLUMN 追加的 search_attempts（该列不在 v9 那段
  // CREATE TABLE 原文里，只多一个枚举值，SELECT * 直拷才不炸——手抄漏掉这一列的教训已被
  // db.test.ts 的迁移安全性测试抓出过一次，不是纸上谈兵的提醒）。
  `
CREATE TABLE episodes_v15 (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES series(id),
  season INTEGER NOT NULL, episode INTEGER NOT NULL,
  name TEXT, path TEXT NOT NULL,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
  status_reason TEXT, recheck_after INTEGER,
  updated_at INTEGER NOT NULL,
  probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
  search_attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO episodes_v15 SELECT * FROM episodes;
DROP TABLE episodes;
ALTER TABLE episodes_v15 RENAME TO episodes;

CREATE TABLE movies_v15 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL, chinese_title TEXT, poster_path TEXT,
  year INTEGER, path TEXT NOT NULL, provider_ids TEXT,
  sub_status TEXT NOT NULL CHECK(sub_status IN
    ('missing','covered','embedded','unavailable','ignored','needs_review','hardsub-assumed')),
  status_reason TEXT, recheck_after INTEGER, updated_at INTEGER NOT NULL,
  origin_lang TEXT,
  probe_mtime INTEGER, probe_size INTEGER, embedded_langs TEXT,
  search_attempts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO movies_v15 SELECT * FROM movies;
DROP TABLE movies;
ALTER TABLE movies_v15 RENAME TO movies;
  `.trim(),
  // v16（重复源 P1）：同一条目的多个视频文件（4K/1080p/不同压制）从"后来者停车"升级为一等公民。
  // 主文件仍在 episodes/movies.path（最早入库者=身份锚）；副本进 item_files。subtitles 加 file_path
  // 归属列（NULL=挂主文件，兼容存量——覆盖判定按"该条目每个文件各有着落"）。两条都是纯增量
  // （CREATE TABLE + ADD COLUMN），不触发 12 步建新表，无 CHECK 约束变更。
  `
CREATE TABLE item_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,          -- episodes.id / movies.id（该条目的主文件行）
  path TEXT NOT NULL UNIQUE,      -- 副本文件绝对路径
  added_at INTEGER NOT NULL
);
CREATE INDEX item_files_item ON item_files(item_id);
ALTER TABLE subtitles ADD COLUMN file_path TEXT;
  `.trim(),
  // v17（批③ B3-4，专项#1：传播"不匹配判决"指纹记忆）：item_files 加两列，纯增量。
  // duration_verdict=上次时长判决结果（'mismatch'/'probe-failed'；NULL=未判过，或判过但已被
  // 文件变化清空语义上等价于"重判"——本仓不显式清空，指纹不匹配即等价于未判）。
  // verdict_fingerprint=判决那一刻主/副两个文件各自的 {mtimeMs,size} 快照（JSON），
  // subtitlePropagation.ts 用它判断"文件是否变了"——两个文件的当前 stat 与快照完全一致才敢
  // 直接沿用旧判决短路，跳过重新 ffprobe；任一文件变了就重判。成功复制路径不写这两列
  // （有字幕行本身就是短路锚点，见 propagateSubtitleToReplica 入口检查），只有 mismatch/
  // probe-failed 两个失败分支才写——避免每轮 pass 对同一对"确认不匹配"的文件重复真实探测
  // （生产实证：SPY×FAMILY 13 集×2 探测/每 pass 的探测空转）。
  `ALTER TABLE item_files ADD COLUMN duration_verdict TEXT;
   ALTER TABLE item_files ADD COLUMN verdict_fingerprint TEXT`,
  // v18（数据安全审计头号遗留修复，2026-07-18：CIFS 挂载抖动可致整库索引批量误删）：三层防线
  // 第②层"消失去抖"用的记账表，纯增量 CREATE TABLE，无 CHECK 约束变更，不触发 12 步建新表。
  // pending_removals：一个磁盘真相移除循环候选路径首次被判 gone 时记一行（first_missing_at=
  // 首次判 gone 的时刻，misses=累计连续 gone 轮次），连续 ≥REMOVAL_CONFIRM_PASSES（默认 2）轮
  // 才真删；期间任一轮 present/unknown（探测本身失败，如 ESTALE/EIO——见 v2/ingest.ts
  // classifyStatError/checkFileGone）都清零重计（对应行被删）。PRIMARY KEY(path)——同一路径
  // 同一时刻只有一个在途判决，无需额外身份维度。
  `
CREATE TABLE pending_removals (
  path TEXT PRIMARY KEY,
  first_missing_at INTEGER NOT NULL,
  misses INTEGER NOT NULL
)
  `.trim(),
  // v19（装机记账修复批，2026-07-18——本仓 MIGRATIONS 数组下标+1 与设计文档里的语义版本号历史上
  // 就不是一一对应，见 db.test.ts 头注释：这条数组序号是第 11 条 entry，落库 meta.schema_version
  // 会从 '10' 变成 '11'，正文/commit message 提到的"schema v11"就是指这个落库值，不是这里的注释
  // 标号）：两件存量清洗，纯 UPDATE，无 DDL 变更，不触发 12 步建新表。
  // W2：provider_ref 双前缀清洗——装机记账把 `provider:candidateProviderId` 拼接时，
  // candidateProviderId 全链唯一来源是 agent 在 candidateKey() 复合形态里见过的那个 id
  // （"assrt:661405"），本身已经带 provider 前缀；findSubtitleWorkerTask.ts 原代码无条件再拼一次
  // 前缀，落库成 "assrt:assrt:661405" 双前缀（审计实证 DxD/HOTD/Gracie 遍地）。剥一层前缀即可
  // （instr 定位第一个 ':'，substr 取它之后的部分——第二个 ':' 及其后的原始 providerId 原样保留）。
  // LIKE 谓词按 core/schemas.ts PROVIDERS 枚举里真实存在的两个非 local provider（assrt/
  // opensubtitles）收窄，只清洗确诊双前缀的行，不碰其余正常单前缀的 provider_ref。
  // W4：存量陈旧 status_reason 清洗——F-B 修复（ingest.ts writeSubStatusOnly 与本批 W3 新增的
  // markCovered reason 参数，"覆盖时清空/更新旧叙事"）只在"翻篇那一刻"生效，先于这些修复就已经
  // 是 covered/embedded 的行（如 TD S02E08/LD&R S03E08）留着修复前的失败叙事，永不自清。此后
  // covered/embedded 行的 status_reason 是 W3 写入的新鲜装机判词（或 NULL），不再是陈旧失败叙事。
  `
UPDATE subtitles SET provider_ref = substr(provider_ref, instr(provider_ref, ':') + 1)
  WHERE provider_ref LIKE 'assrt:assrt:%' OR provider_ref LIKE 'opensubtitles:opensubtitles:%';
UPDATE episodes SET status_reason = NULL WHERE sub_status IN ('covered','embedded') AND status_reason IS NOT NULL;
UPDATE movies SET status_reason = NULL WHERE sub_status IN ('covered','embedded') AND status_reason IS NOT NULL;
  `.trim(),
  // v16（详情页重设计 item B，design: docs/design/2026-07-20-detail-page-redesign-design.md）：
  // TMDB 元数据富化——series 剧集简介/背景图 + tmdb_seasons 逐集简介/首播日/剧照。纯 ADD COLUMN，
  // 不触发建新表。加列后现有 tmdb_seasons 行新字段为 NULL；UPDATE fetched_at=0 强制下轮
  // refreshSeriesCatalog 重富化回填（不干等 7 天 TTL）。series 层靠既有富化重试 pass 连带补齐。
  // （注：此处"v16"是设计文档 item 编号，非本仓 schema 历史里的 v16=item_files；本条是数组第 12 条
  // entry，落库 meta.schema_version 从 '11' 变成 '12'。）
  `ALTER TABLE series ADD COLUMN overview TEXT;
   ALTER TABLE series ADD COLUMN backdrop_path TEXT;
   ALTER TABLE tmdb_seasons ADD COLUMN overview TEXT;
   ALTER TABLE tmdb_seasons ADD COLUMN air_date TEXT;
   ALTER TABLE tmdb_seasons ADD COLUMN still_path TEXT;
   UPDATE tmdb_seasons SET fetched_at = 0`,
  // v20（SRE 审计 F1,2026-07-21：崩溃循环无退避=money fire——reap 故意不计内容失败(良性重启
  // 不占退避梯),但"claim→跑付费 LLM→进程死→docker 重启→reap→立即重 claim"的确定性崩溃
  // 循环也没有任何计数,会以重启速度无限烧钱。reap_count 只记"连续无完成回收"次数,到阈
  // (jobsRepo.REAP_PARK_THRESHOLD)由 reap 直接 park 隔离;任何完成(completeDone/completeError)
  // 清零。纯 ADD COLUMN,不触发建新表。本条是数组第 13 条 entry,落库 meta.schema_version 13。
  `ALTER TABLE jobs ADD COLUMN reap_count INTEGER NOT NULL DEFAULT 0`,
  // v21（parked-path 负缓存 Task 5）：未识别路径在 fingerprint 不变时按 1h→4h→24h 阶梯退避
  // 重识别，避免每轮 FULL PATH 白烧 TMDB/LLM。retry_count=已完成的退避阶数；next_retry_at=下次
  // 可重试时刻（NULL=立即 eligible，兼容存量迁移行）；probe_mtime/probe_size=park 时指纹。
  // 纯 ADD COLUMN。本条是数组第 14 条 entry，落库 meta.schema_version 14。
  `ALTER TABLE parked_paths ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE parked_paths ADD COLUMN next_retry_at INTEGER;
   ALTER TABLE parked_paths ADD COLUMN probe_mtime INTEGER;
   ALTER TABLE parked_paths ADD COLUMN probe_size INTEGER`,
  // v22（翻译账本补偿）：早期已初始化的 runs 表可能缺少原本只写进 v9 折叠终态的记账列。
  // 新库已有列，必须条件式补齐，不能裸 ALTER 让 fresh install 失败。
  (db) => {
    const runsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get()
    if (!runsExists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name),
    )
    if (!columns.has('llm_calls')) db.exec('ALTER TABLE runs ADD COLUMN llm_calls INTEGER')
    if (!columns.has('assrt_calls')) db.exec('ALTER TABLE runs ADD COLUMN assrt_calls INTEGER')
  },
]

export function openDb(path: string): ScoutDb {
  const db = new Database(path)

  // Pragma 四件套
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  // DB 审计🔴:软路由掉电常态,NORMAL 只 checkpoint 时 fsync,掉电丢最近 N 分钟提交——jobs/
  // blacklist/overrides/settings 不可从磁盘重建,静默状态分歧。本库写量极小(每 tick 几行),
  // FULL(每提交 fsync WAL)成本可忽略,掉电丢失窗口归零。
  db.pragma('synchronous = FULL')
  // DB 审计🟡:打开即体检(单趟快速版)。损坏库过去是 tick 循环里裸炸 SQLITE_CORRUPT 还无限
  // 重试,分不清磁盘满还是库死了;这里 fail-loud 指明文件+恢复路径。
  const qc = db.pragma('quick_check(1)') as Array<{ quick_check: string }>
  if (qc[0]?.quick_check !== 'ok') {
    db.close()
    throw new Error(
      `数据库体检失败(${path}): ${qc[0]?.quick_check}。` +
      `恢复:停 daemon → sqlite3 "${path}" ".recover" | sqlite3 recovered.db,或还原 cache/backups/ 最新快照`,
    )
  }
  // foreign_keys 故意先关掉、留到迁移跑完之后才打开（见下方 return 前的说明）——better-sqlite3
  // 的连接默认就是 foreign_keys=ON（不是"不设置=关闭"，是"不设置=已经开着"，必须显式 OFF）。
  // 这条机制是从 v1→v8 的历史 ALTER 迁移链继承下来的通用基础设施（v9 起该链已折叠成上面
  // 唯一一条纯 CREATE TABLE 的终态 entry，本身不触发下述场景，但机制原样保留供未来复用）：
  // SQLite 不支持 ALTER 已有 CHECK 约束或给已被别的表 REFERENCES 的表加列，标准作法是官方
  // 文档"Making Other Kinds Of Table Schema Changes"的 12 步流程（建新表→拷数据→删旧表→
  // 改名）。这个流程里 DROP TABLE 对声明了外键的父表（如曾经历史上的 jobs，被 runs.job_id
  // REFERENCES jobs(id) 引用）会做隐式检查：哪怕马上 RENAME 把同名表换回来、数据/id 都原样
  // 复原，foreign_keys=ON（含 defer_foreign_keys=ON 声明的延迟检查——实测过，同样在 COMMIT
  // 时报错）仍会判定引用失效而报 FOREIGN KEY constraint failed——延迟检查绑定的是"原表"这个
  // schema 对象的身份，不认"同名新表"。12 步流程步骤 1 要求在自动提交模式（不在事务内）下先
  // PRAGMA foreign_keys=OFF，重建完成后再 PRAGMA foreign_keys=ON（该 pragma 在事务中途切换
  // 是 no-op，必须在事务开始前完成）。迁移前的 PRAGMA foreign_key_check 体检不依赖这个开关
  // （体检本身独立于开关状态）；迁移后 return 前重新打开 foreign_keys=ON 让 runtime DML
  // 强校验照常生效。
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
    // DB 审计🔴:迁移前自动快照(任何进程 openDb 触发迁移都有恢复点,不靠运维记得手动备份)。
    // VACUUM INTO 在线一致、连 WAL 内容一起收;:memory: 跳过。
    if (path !== ':memory:') {
      try {
        db.exec(`VACUUM INTO '${path}.pre-v${MIGRATIONS.length}.bak'`)
      } catch { /* 快照失败不阻塞迁移(空间不足等),迁移事务本身仍是 all-or-nothing */ }
    }
    // Pre-flight: 历史迁移链的建新表→拷数据→删旧表→改名手法（见上方 pragma 注释）会把存量行
    // 原样拷进重建的表——若库里蛰伏着孤儿行（外键引用的父行已不存在，比如父行曾被手工删除、
    // 或数据是在 foreign_keys=OFF 时代写入的从未被真正验证过），拷贝期间这行数据本身就是脏
    // 的，不修就永远是脏的（与本连接这一刻 foreign_keys 开关无关，迁移期间这个开关本就故意
    // 关着）。这里在动手改表之前先体检一遍，把违例行（表名+rowid）摊开写进报错，一步到位可
    // 操作，避免守护进程日后拿一句晦涩的 FOREIGN KEY constraint failed 反复重启也炸不出头绪。
    // v9 起 MIGRATIONS 只剩一条纯 CREATE TABLE 的终态 entry（不做拷贝重建），体检当前不会
    // 命中，但机制原样保留供未来的增量迁移复用。
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
        const migration = MIGRATIONS[i]
        if (typeof migration === 'string') db.exec(migration)
        else migration(db)
        const newVersion = i + 1
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
          String(newVersion)
        )
      }
    })
    try {
      migrate()
    } catch (err) {
      // D-review #4：迁移失败时事务已整体回滚（库仍停留在旧版本），但句柄不能泄漏——
      // openDb 抛错后调用方拿不到 db，无从 close；残留的打开连接会占着 -wal/-shm 和
      // 文件锁，妨碍修复者（同上方 FK 体检失败路径的 close 语义）。
      db.close()
      // v9 起 MIGRATIONS 折叠：v1–v8 时代的老库(schema_version 落在 1–8 的 de-Jellyfin 之前世界)
      // 与折叠后的增量链不兼容——会在 v17+ 的 ALTER item_files 上撞 "no such table"(item_files
      // 建在被跳过的 v9 折叠 entry 里)。产品已裁决老库作废、操作者自删。给一句人话而不是裸 SQL 错。
      const msg = String((err as Error)?.message ?? err)
      if (currentVersion >= 1 && currentVersion < 9 && /no such (table|column)/i.test(msg)) {
        throw new Error(
          `数据库 schema v${currentVersion} 是 de-Jellyfin 化(v9)之前的旧版本,与当前折叠后的迁移链不兼容` +
          `(底层错误：${msg})。这类开发期老库已作废——请备份后删除 scout.db(及 -wal/-shm)让程序重新` +
          `初始化,重启后会从零重扫媒体库、重新识别与找字幕。`,
        )
      }
      throw err
    }
  }

  // 迁移（如果跑了）已经全部提交——现在才打开运行期外键强校验，覆盖有迁移和无迁移两条
  // 路径（无迁移路径同样需要它，只是从未被上面 if 分支覆盖到）。见顶部 pragma 注释：
  // 提前打开会导致历史上"建新表→删旧表→改名"手法的 DROP TABLE（含被引用的真实外键）无法完成。
  db.pragma('foreign_keys = ON')

  return db
}
