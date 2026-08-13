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
  lease_started_at INTEGER,         -- 本次 claim 发生的时刻，claimNext 置 now、renewLease 绝不触碰（与 lease_until/updated_at 不同，心跳不前移它）——活动页秒表"已进行 N 秒"的稳定锚点，见 v29 迁移
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
  first_seen INTEGER NOT NULL, last_attempt INTEGER NOT NULL,
  -- v25（agent-first identification）：agent 识别所需的 raw 数据——机械探测只写 raw 数据，
  -- agent 从 parked_paths 读取做识别。NULL=未探测。retry_count/next_retry_at/probe_* 四列
  -- 不在此终态定义里——它们由 v21 的裸 ALTER 迁移追加，fresh install 走完整 MIGRATIONS 链一次到位。
  duration_sec INTEGER, embedded_langs TEXT,
  -- v26（接回 [tmdbid-N] 证据通道）：路径里的 TMDB id 标签。来源有两个：①本项目自己产出的
  -- 规范布局（buildTargetShowDir: "Show (Year) [tmdbid-N]"）；②外部整理工具（*arr 生态）。
  -- 它是最强 hint，但仍只是 hint——agent 必须 TMDB 核验后才能认领。NULL=路径里没有标签
  -- （绝大多数情况），不是"未探测"：它是纯路径解析产物，同步、零 I/O。
  embedded_tmdb_id TEXT
);
CREATE TABLE subtitle_verify (      -- v28（字幕时间轴校验）：检测结论。刻意独立成表而不是往
                                    -- episodes/movies 加列——校验结论是**可重算的派生数据**
                                    -- （删掉整表只损失一次重算的代价），与 episodes 的身份/覆盖
                                    -- 状态是不同生命周期：后者是磁盘真相的索引，不可从别处重建。
  item_id TEXT PRIMARY KEY,         -- episodes.id 或 movies.id（同 runs/subtitles 的 item_id 惯例）
  -- 三值封闭，CHECK 锁死。铁律①"只有绿和红，绝不给黄"：aligned 与 unverifiable 在 UI 上
  -- **都是绿色**（前者=验过没问题，后者=没能验证；诚实体现在"不假装验证过"，而非打黄标让
  -- 用户焦虑），只有 shifted 是红色且可校正。刻意**没有**"警告/可疑"这第四档——多一档就会
  -- 有人把它渲染成黄色，铁律当场破防，所以在 schema 层就把它变成不可表达。
  verdict TEXT NOT NULL CHECK(verdict IN ('aligned','shifted','unverifiable')),
  offset_ms INTEGER,                -- 仅 verdict='shifted' 时有意义（内部字段）
  score REAL,                       -- 内部诊断（内部字段）
  reference_tier TEXT,              -- 'embedded' | 'sibling' | NULL=无参考源（内部字段）
  -- offset_ms / score / reference_tier 三列是**内部字段**：铁律②——UI 不展示任何数字。
  -- 它们只进 DB 与 trace 供排障，API/UI 层不得读出来做面向用户的文案。
  subtitle_path TEXT NOT NULL,      -- 本次检测的对象（一个 item 挂多个字幕时，记的是最后检的那个）
  subtitle_hash TEXT,               -- 内容哈希：字幕文件被替换后据此判定旧结论作废需重检。
                                    -- NULL=当时算不出（文件读不动）→ needsRecheck 一律判 true
  checked_at INTEGER NOT NULL,
  detail TEXT                       -- 内部诊断字符串（参考源选中了谁、其余为何落选）
);
CREATE INDEX subtitle_verify_verdict ON subtitle_verify(verdict);  -- listShifted 的批量查询
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- schema_version, last_reconcile_at 等
-- v30（2026-08-08 新架构）：files/works 表。机械扫描的产出与识别 agent 的产出。
-- （fresh install 走完整 MIGRATIONS 链，v30 entry 的 CREATE TABLE IF NOT EXISTS 会跳过；
-- 留在这里是为了让终态 schema 可读完整——同 v28 注释的口径。）
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE, dir TEXT NOT NULL, filename TEXT NOT NULL,
  size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  duration_sec INTEGER, embedded_langs TEXT, audio_langs TEXT,
  work_dir TEXT, season INTEGER, episode INTEGER, parse_confidence TEXT,
  work_id TEXT, needs_subtitle INTEGER, sub_status TEXT,
  attempt INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER, last_error TEXT,
  recheck_after INTEGER, sub_recheck_at INTEGER,
  sub_attempt INTEGER NOT NULL DEFAULT 0, translatable INTEGER,
  updated_at INTEGER NOT NULL
  -- sub_recheck_at（v32/D12）="下次该复核字幕存在性的时刻"，勿与 recheck_after 混淆（审计 F5）：
  -- recheck_after = 字幕流"再去找一次"的重试调度；sub_recheck_at = B 档"磁盘上有没有"的事实复核。
  --
  -- sub_attempt（v34/D22）= 字幕流真实尝试次数，**独立于上面那个 attempt**（后者被识别轨共用，
  -- 且识别成功时归零 → 复用它会让字幕轨永远攒不到 7 次，实测确认 / C7）。
  -- 必须 NOT NULL DEFAULT 0：sub_attempt >= 7 在 NULL 上是三值逻辑的 unknown，
  -- 可空版本会让停牌移交静默失效（与 D18 同一个坑）。
  --
  -- translatable（v35/R21+D9）= 翻译可救性预判，三态：NULL=暂不可判 / 0=不可救 / 1=可救。
  -- 刻意**可空**（与 sub_attempt 相反）：NULL 是有意义的第三态，C40 明令它不得判死。
  --
  -- tr_attempt / tr_recheck_after（v37/D3+D6）**不在此终态定义里**，由 v37 的条件式 ALTER
  -- 追加——照 provider_ids 的既有口径（终态里写了、条件式 ALTER 又跑一遍是无害的，但两处
  -- 定义漂移时以哪边为准会变成一个新问题）。语义见 v37 entry 的注释：翻译轨自己的退避轨，
  -- tr_attempt 必须 NOT NULL DEFAULT 0（'>= 3' 的三值逻辑），tr_recheck_after 刻意可空
  -- （NULL = 从没被翻译流碰过 = 立刻可领）。
  --
  -- sub_retry_streak（v38）同样**不在此终态定义里**，由 v38 的条件式 ALTER 追加（同上口径）。
  -- 语义 = 连续多少轮源站拒绝回答（retry_later）。它是"retry_later 不吃 sub_attempt 额度"
  -- 这条豁免的对价账本：连续达上限时折算一次 sub_attempt 并归零，任何非 retry_later 的结局
  -- 都把它归零。必须 NOT NULL DEFAULT 0（'>= CAP' 的三值逻辑，同 D22）。详见 v38 entry。
  --
  -- skip_reason / sidecar_langs（v40/R-F15）同样**不在此终态定义里**，由 v40 的条件式 ALTER
  -- 追加（同上口径）。前者 = judgeSubtitle 的 verdict.reason 原值（origin-skip/embedded/
  -- missing），后者 = 该视频旁边**全部**外挂字幕的语言集合 JSON（与当前 target_languages 无关的
  -- 磁盘事实）。两列皆可空，NULL 分别是"还没判"与"还没观察"的第三态。详见 v40 entry。
  --
  -- parser_version（v45/C48）同样**不在此终态定义里**，由 v45 的条件式 ALTER 追加（同上口径）。
  -- 语义 = 这一行的 work_dir/season/episode/parse_confidence 四列是用**哪个版本的解析规则**
  -- 算出来的。刻意可空且无 DEFAULT：NULL = "旧规则解析的（或未知）"，是重解析的唯一凭据。
  -- 给它 DEFAULT 当前版本会让全部存量行当场被标成"已最新" → 重解析一行都不发生，
  -- 正是这一列要修的那个静默失效原样复活。详见 v45 entry。
);
CREATE INDEX IF NOT EXISTS files_work_dir ON files(work_dir);
CREATE INDEX IF NOT EXISTS files_work_id ON files(work_id);
CREATE INDEX IF NOT EXISTS files_needs_subtitle ON files(needs_subtitle);
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, original_title TEXT, year INTEGER,
  media_type TEXT NOT NULL, origin_lang TEXT, overview TEXT, poster_path TEXT,
  chinese_titles TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- v39（R-F3）：通知流水。留在终态 schema 里是为了让它可读完整（同 v28/v30 注释的口径）；
-- fresh install 走完整 MIGRATIONS 链，v39 entry 的 CREATE TABLE IF NOT EXISTS 会跳过。
-- 逐集存、读时聚合；唯一索引必须走 ifnull()（电影 season/episode 恒 NULL，裸 UNIQUE 失效）。
-- 完整论证见 v39 entry。
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL, title TEXT NOT NULL,
  season INTEGER, episode INTEGER,          -- 皆 NULL = 电影
  via TEXT NOT NULL,                        -- 'fetch' / 'translate'
  found_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_identity
  ON notifications(work_id, ifnull(season,-1), ifnull(episode,-1));
CREATE INDEX IF NOT EXISTS notifications_found_at ON notifications(found_at DESC);
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
  // v14（救援R4b）：特典机械排除的"用户翻案"豁免表。
  // ⚠️ 2026-08-13：这张表已由 **v44 entry DROP**（零行、零读取方、零写入方；用户裁决
  // 「特典都完全不算在找字幕的范围」后连"保留待裁"的前提都没了——完整论证见 v44）。
  // 本条 entry **保留原样不许删**：迁移链是按数组下标记版本的（meta.schema_version =
  // MIGRATIONS.length），删掉中间一条会让所有存量库的版本号与实际结构错位一格，
  // 后续 entry 全部跑错。fresh install 会先建它、再由 v44 立刻 DROP 掉——
  // 多一次建删的代价是几微秒，换的是版本账不错位。
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
  // v23（剧级术语持久化 P2）：跨 job 继承冻结术语表，消除同剧 canonical 方差（验收实证：
  // 同一模型同剧两 run 选出 东国/奥斯塔尼亚）。纯 CREATE TABLE，幂等 IF NOT EXISTS。
  `CREATE TABLE IF NOT EXISTS translate_glossaries (
    series_key TEXT PRIMARY KEY,
    terms_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // v24（识别架构路 A，2026-07-26 审计 B）：identify_overrides 加来源列。这张表原本只有人写
  // （P6 救援页手工认领），现在 find-subtitle agent 的 identity_correction 也落地成认领——
  // 两者权威等级不同：人在 dashboard 上明确点选是终局判断，agent 的 Step 0 核验是会出错的
  // 启发式。没有这一列就无法表达"人写的行 agent 不许覆盖"，也无法在 UI 上区分来源（triage
  // 页的空态文案至今还写着"手动认领会出现在这里"）。DEFAULT 'human' 让存量行语义正确——
  // 历史上确实只有人写过。条件式补齐（fresh install 的 CREATE TABLE 已含该列）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identify_overrides'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(identify_overrides)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('source')) {
      db.exec(`ALTER TABLE identify_overrides ADD COLUMN source TEXT NOT NULL DEFAULT 'human'`)
    }
  },
  // v25（agent-first identification）：parked_paths 承载 agent 识别所需的 raw 数据
  // （duration_sec, embedded_langs）。spec：机械只给 raw 数据，agent 从 parked_paths 读取。
  // 条件式补齐（fresh install 的 v9 终态 CREATE TABLE 已含这两列——同 v22/v24 的教训：
  // 新库已有列，必须条件式补齐，不能裸 ALTER 让 fresh install 撞 duplicate column name）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'parked_paths'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(parked_paths)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('duration_sec')) {
      db.exec(`ALTER TABLE parked_paths ADD COLUMN duration_sec INTEGER`)
    }
    if (!columns.has('embedded_langs')) {
      db.exec(`ALTER TABLE parked_paths ADD COLUMN embedded_langs TEXT`)
    }
  },
  // v26（接回 [tmdbid-N] 证据通道）：parked_paths 加一列存路径里的 TMDB id 标签。
  // 来源有两个：①本项目自己产出的规范布局（buildTargetShowDir: `Show (Year) [tmdbid-N]`）
  // ——此前这一列缺失意味着"本项目整理过的库，再次扫描时认不出自己写下的 id"；②外部整理
  // 工具（*arr 生态）。它是**最强 hint**，但仍只是 hint：标签可能过期或写错，agent 必须
  // TMDB 核验后才能认领，否则等于重开一个绕过 two-evidence bar 的后门。
  // NULL = 路径里没有标签（绝大多数情况），不是"未探测"——它是纯路径解析产物，同步、零 I/O。
  (db: ScoutDb) => {
    // 表存在性守卫（同 v24/v25 的既有口径，不是多余）：老库（v22/v23 等形状的 seeded 测试库、
    // 历史真实库）里 parked_paths 可能压根不存在，而 PRAGMA table_info 对不存在的表返回空集——
    // 只判 !columns.has(...) 会让守卫恒为真，裸 ALTER 直接炸 "no such table: parked_paths"，
    // 整条迁移链在事务里回滚，老库永远打不开。
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'parked_paths'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(parked_paths)').all() as Array<{ name: string }>).map((c) => c.name)
    )
    if (!columns.has('embedded_tmdb_id')) {
      db.exec(`ALTER TABLE parked_paths ADD COLUMN embedded_tmdb_id TEXT`)
    }
  },
  // v27（认领退役，2026-07-28 产品裁决）：DROP identify_overrides。认领允许用户/agent 对一条
  // 路径零证据指派 TMDB 身份，直接违反系统的两证据红线（识别必须凑齐两路独立证据）；且
  // override 的覆盖单元是目录前缀——对一个文件认领一次，该目录未来落进来的每个文件都被
  // 投毒成同一身份。识别现在完全 agent-owned（write_identified_media），正确的人类修复动作
  // 是改文件名，不是在面板里指派身份。DROP IF EXISTS：fresh install（v9 折叠终态已不再
  // CREATE 这张表）与老库两条路径都安全。存量认领行不迁移到任何地方——它们本就是零证据
  // 判断；openDb 的 pre-migration VACUUM 备份（.pre-vN.bak）保留了表内容，供考古取证。
  `DROP TABLE IF EXISTS identify_overrides`,
  // v28（字幕时间轴校验落库）：新增 subtitle_verify 表，承载"这条字幕的时间轴对不对"的检测
  // 结论，供 UI 读取（红=shifted 可校正，绿=aligned/unverifiable）。为什么要它：前置的三个
  // 纯模块（alignDetect/referenceSource/shiftTiming）此前零生产调用方，结论无处可存也就无人
  // 可读；编排层（subtitleVerify/verifySubtitle.ts）算完必须落到某处才成为可用功能。
  //
  // 为什么独立成表而不是往 episodes/movies 加列：校验结论是可重算的派生数据（丢了只损失一次
  // 重算），而 episodes 的身份/覆盖状态是磁盘真相的索引、不可从别处重建——两者生命周期不同，
  // 混在一张表里会让"清空重算校验结论"这个正常运维动作变成危险操作。
  //
  // 纯 CREATE TABLE + CREATE INDEX，无 CHECK 约束变更，不触发 12 步建新表。IF NOT EXISTS 是
  // **必需**而非防御性冗余：fresh install 从 currentVersion=0 起跑**完整** MIGRATIONS 链
  // （不是"只落 v9 终态"——见 v25 注释同一口径），因此新库会先由 v9 终态建出这张表、再流经
  // 本条 entry；裸 CREATE 会在这里撞 "table already exists"，整条链在事务里回滚，新库压根
  // 打不开。同 v22/v24/v25 的既有教训。
  //
  // 反过来说，正因为 fresh install 会跑到这条 entry，v9 终态里那份 CREATE TABLE 对"新库有没有
  // 这张表"其实不是必要条件（删掉它新库照样能建出表，实测如此）。保留它是为了让终态那段
  // schema 仍是一份**可读的完整现状**——它是全仓唯一能一眼看全表结构的地方，漏一张表会让
  // 后来者以为不存在。两份必须同步改动。
  `CREATE TABLE IF NOT EXISTS subtitle_verify (
  item_id TEXT PRIMARY KEY,
  verdict TEXT NOT NULL CHECK(verdict IN ('aligned','shifted','unverifiable')),
  offset_ms INTEGER,
  score REAL,
  reference_tier TEXT,
  subtitle_path TEXT NOT NULL,
  subtitle_hash TEXT,
  checked_at INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS subtitle_verify_verdict ON subtitle_verify(verdict)`,
  // v29（2026-08-01，活动页 hero 秒表"已进行 N 秒"实机冻结）：jobs 加 lease_started_at——
  // 本次 claim 发生的时刻。根因：dashboard 的 buildWorkflowWorkers 把 startedAtLease 映射成
  // jobs.updated_at，而 renewLease 心跳每 tick 把 updated_at 刷到 ~now，于是 now-startedAtLease
  // 每次 15s 轮询后又缩回极小值，秒表在屏上冻住（看起来像卡死，恰好破掉这一屏"系统还活着"的
  // 信号）。修法：claimNext 置这个稳定锚点、renewLease 绝不触碰它，apiV2 读它（?? updated_at
  // 兜底存量在飞行中的行）。同 v24/v25/v26：fresh install 的终态 CREATE TABLE 已含该列，这里
  // 只补存量库——条件式 ALTER（PRAGMA table_info 先探）保证幂等：新库/已迁库列已在→跳过，
  // 旧库列缺→补。**必须**幂等而非裸 ALTER：db.test.ts 的"迁移可在已迁库上重跑"用例会把尾部
  // 迁移在已含该列的库上再跑一遍，裸 ALTER 会抛 duplicate column name。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('lease_started_at')) {
      db.exec('ALTER TABLE jobs ADD COLUMN lease_started_at INTEGER')
    }
  },
  // v30（2026-08-08 新架构，spec docs/design/2026-08-08-new-architecture-design.md）：
  // 新增 files/works 两张表，承载"机械扫描 → 识别 agent → 传送带 → 字幕 agent"的新管线。
  //
  // 为什么新表而非改旧表：旧表（series/episodes/movies）是"按集建行"模型，新架构是
  // "文件级事实 + 作品级身份"模型——两者生命周期不同，混在一张表里会让迁移变成危险操作。
  // 旧表**保留不删**（新架构 spec-gap M6：subtitles.provider_ref 来源证据、unavailable 穷尽
  // 结论无法从磁盘重建，需在阶段 4 嫁接）。新表与旧表并行，前端切到新表后旧表冻结。
  //
  // files：机械扫描的产出，每行一个媒体文件，零身份判断（work_id NULL=未识别）。
  // works：识别 agent 的产出，每行一个作品（TMDB 身份）。
  //
  // 纯 CREATE TABLE + ADD COLUMN，无 CHECK 约束变更，不触发 12 步建新表。
  // CREATE TABLE IF NOT EXISTS 是**必需**：fresh install 从 v0 起跑完整 MIGRATIONS 链，
  // 新库会先由 v9 终态建出（见 v28 注释的同口径），裸 CREATE 会撞 "table already exists"。
  `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,          -- 绝对路径
  dir TEXT NOT NULL,                  -- 所在目录
  filename TEXT NOT NULL,             -- 文件名
  size INTEGER NOT NULL,              -- 字节
  mtime INTEGER NOT NULL,             -- 毫秒
  duration_sec INTEGER,               -- ffprobe 探测，可空（探测失败/未探测）
  embedded_langs TEXT,                -- JSON 数组，ffprobe 内嵌字幕轨语言
  audio_langs TEXT,                   -- JSON 数组，ffprobe 音轨语言
  work_dir TEXT,                      -- 作品根目录（扫描时算好，见 spec-gap M1）
  season INTEGER,                     -- 季号（按 Jellyfin 约定解析，可空）
  episode INTEGER,                    -- 集号（同上）
  parse_confidence TEXT,              -- 'high'/'low'/'none'（spec-gap M5）
  work_id TEXT,                       -- NULL=未识别；'tmdb:<id>'=已识别
  needs_subtitle INTEGER,             -- NULL=未判定；0=不需要；1=需要
  sub_status TEXT,                    -- NULL=未处理；'missing'/'covered'/'embedded'/'unavailable'
  attempt INTEGER NOT NULL DEFAULT 0, -- 识别尝试次数（spec-gap B2）
  next_retry_at INTEGER,              -- 下次可重试时刻；NULL=立即
  last_error TEXT,                    -- 最近失败原因（'tmdb-404'/'timeout'/...）
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_work_dir ON files(work_dir);
CREATE INDEX IF NOT EXISTS files_work_id ON files(work_id);
CREATE INDEX IF NOT EXISTS files_needs_subtitle ON files(needs_subtitle);
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,                -- 'tmdb:<id>'
  title TEXT NOT NULL,                -- TMDB 主标题
  original_title TEXT,                -- 原名
  year INTEGER,                       -- 首映年
  media_type TEXT NOT NULL,           -- 'tv' / 'movie'
  origin_lang TEXT,                   -- TMDB origin language（判定国产片用）
  overview TEXT,                      -- 简介
  poster_path TEXT,
  chinese_titles TEXT,                -- JSON 数组，中文译名变体
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
  -- provider_ids（v36/C5+C21）与 backdrop_path（v42/R-F13+R-F14）**都不在此终态定义里**，
  -- 分别由 v36 / v42 的条件式 ALTER 追加——
  -- 同 files 表的 recheck_after/sub_recheck_at/sub_attempt/translatable 的既有分工（见上方
  -- files 定义末尾的同款注记）：一列一条迁移 entry，fresh install 走完整链一次到位，
  -- 存量库靠同一条 entry 原地补齐。两处都写会让"改一处忘另一处"变成可能。
)`,
  // v30（续）：media_roots 加 content_type 列——照 Jellyfin 的库级类型定义
  // （spec-gap M2）。'movies'/'tv'/'mixed'，默认 'mixed'（agent 判断）。
  // 条件式 ALTER 保证幂等（同 v29 的 lease_started_at 口径）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_roots'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(media_roots)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('content_type')) {
      db.exec("ALTER TABLE media_roots ADD COLUMN content_type TEXT DEFAULT 'mixed'")
    }
  },
  // v31（2026-08-08 死循环修复，spec docs/design/2026-08-08-deadloop-fix-v2.md §2.1）：
  // files 表加 recheck_after——字幕"找不到"的退避标记。
  //
  // 死循环根因：no_safe_match 的文件保持 needs_subtitle=1、sub_status=null，
  // 字幕队列永远选中它（Peacemaker S01E08 实测反复重试）。
  // 修法：找不到 → 标 recheck_after=now+6h，队列 SQL 消费它，到期才重新入队。
  //
  // 与识别轨的 next_retry_at 分列不混淆：识别只挑 work_id IS NULL，字幕只挑
  // needs_subtitle=1——两队列天然不相交（审计确认）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('recheck_after')) {
      db.exec('ALTER TABLE files ADD COLUMN recheck_after INTEGER')
    }
  },
  // v32（2026-08-08 流水线 spec，docs/design/2026-08-08-PIPELINE-SPEC.md §5 + 裁决 D12/D16/D18）：
  // files 表加 sub_recheck_at——语义="下次该复核字幕存在性的时刻"（毫秒）。
  //
  // 为什么需要这一列：R24 把 sub_status='covered' 的唯一写入者收归扫描（"磁盘上真有同名中字"
  // 这个事实观察），不再由 worker 的成功报告代写。但全量检测代价是 15 语言标签 × 3 扩展名
  // = 45 次 stat/文件，而生产的守备目录是 115 网盘的 rclone FUSE 挂载，stat 代价放大约 46 倍。
  // 故 D12 分两档：A 档（新增/指纹变化）全量检测；B 档（未变化）按本列到点轮转，
  // 每轮只查 `sub_recheck_at <= now` 的那批 → 单轮开销 ≈ 全库 1/7。
  //
  // 为什么迁移必须**打散**而不能留 NULL（D18，这才是本条迁移的实质内容，加列只是顺带）：
  // 存量行由 ALTER 加入时全是 NULL，而 SQL 三值逻辑下 `NULL <= now` 不为真，于是
  //   · 照字面写谓词 `sub_recheck_at <= now` → NULL 行永不命中 → **静默失效**。本仓已经
  //     栽过三次同型缺陷（C12 → C35 → D17：写了某列却没定谁来重读它），不能有第四次。
  //   · 补成 `IS NULL OR sub_recheck_at <= now` → 首轮全库命中 → 几万文件 × 45 次 stat
  //     在 FUSE 挂载上**雪崩**，正是 D12 要避免的那件事。
  // 故走第三条路：迁移当场把存量行随机打散到未来 7 天内，一行不留 NULL，让谓词保持纯粹的
  // `sub_recheck_at <= now`（不带 `IS NULL OR`）。全库因此从第一轮起就是摊平的每周复核。
  //
  // `random() % N` 先取模再 abs 的顺序**不可交换**：random() 返回 64 位有符号整数，直接
  // abs() 撞上 INT64_MIN 会整数溢出报错；先取模把值收进 (-N, N) 再 abs 才安全。
  // random() 是非确定性函数，UPDATE 时逐行重算——这正是"散开"的来源，若被写成单个常量
  // （如先算好一个 JS 随机数再绑定）就退化成"全库同一时刻"，只是把雪崩推迟 7 天。
  //
  // `WHERE sub_recheck_at IS NULL` 双重把关：既保证迁移可重跑（幂等，不重置已经排好的复核
  // 时刻），也保证新库路径下（v9 终态 CREATE TABLE 已含该列、条件式 ALTER 跳过）这条
  // UPDATE 不会去动扫描逻辑写好的值。新插入行的这一列由后续 task 的扫描逻辑负责写。
  //
  // 纯 ADD COLUMN + UPDATE，无 CHECK 约束、无列类型变更 → 不触发 SQLite 的 12 步建表流程。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('sub_recheck_at')) {
      db.exec('ALTER TABLE files ADD COLUMN sub_recheck_at INTEGER')
    }
    db.prepare(
      `UPDATE files
          SET sub_recheck_at = ? + abs(random() % (7 * 86400 * 1000))
        WHERE sub_recheck_at IS NULL`,
    ).run(Date.now())
  },
  // v33（2026-08-08 流水线 spec，裁决 D19 / 缺口 C44）：废止 sub_status 第五态 'unavailable'
  // 的**存量行**，洗回 NULL。
  //
  // 为什么这条迁移必须**先于**"字幕工作台谓词收紧成 `sub_status IS NULL`"落地：
  // 顺序调整后第 2 步（daemonV2 接容器）先上线，而 `subtitleScheduler.ts` 至今仍在为
  // "搜过确实没有"这条**最常见的失败路径**写 `sub_status='unavailable'`。等到后续 task 把
  // 字幕工作台谓词从"排除 covered"收紧成 `IS NULL` 的那一刻，这批存量行会同时满足两条：
  //   · sub_status 非 NULL → 不在字幕工作台的取件范围里
  //   · 那条失败路径不递增 sub_attempt → 永远攒不到 7 次，进不了停牌复查闸
  // 于是它们**永久出局**，字幕再也不会被补，而 UI 上看不出任何异常（C44）。
  //
  // 反过来的顺序是无害的：写入点还活着时先洗，洗完又被写脏——脏行只是回到今天的状态，
  // 而今天的谓词（排除 covered）本来就能取到它们。故"先迁移、后删写入点"是唯一安全的顺序，
  // 也是本条独立于删写入点那个 task 的全部理由。**这里刻意不碰写入点**：那是另一个 task 的
  // 范围，在这条迁移上线与写入点删除之间的窗口里，新写的脏行由下一次迁移重跑…… 不会重跑
  // （迁移只跑一次），窗口内的脏行由那个 task 自己负责，本条只保证"历史存量清零"。
  //
  // 谓词写 `= 'unavailable'` 而不是 `IS NOT NULL`：后者在今天的库上完全测得过（库里只有
  // covered 和 unavailable），却会在停牌态（handoff_translate / unsolvable，后续 task 才写）
  // 上线那天把飞行中的翻译整个掀掉——D10 的乐观守卫 `WHERE sub_status='handoff_translate'`
  // 匹配 0 行 → 退避不写 → 付费 LLM 热循环从侧门回来。精确值匹配同时让本条天然幂等
  // （第二次跑匹配 0 行）。
  //
  // 条件式 files 表存在性检查照抄 v30/v31/v32：v29 及更早的库升级上来时 files 表还不存在
  // （v30 才建），裸 UPDATE 会 `no such table: files` 把 openDb 整个炸掉 → 用户的库再也打不开。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    db.prepare(`UPDATE files SET sub_status = NULL WHERE sub_status = 'unavailable'`).run()
  },
  // v34（2026-08-08 流水线 spec，裁决 D22 / 缺口 C7）：files 表加 sub_attempt
  // ——字幕流"真实尝试次数"的**独立**计数列。
  //
  // 为什么必须独立于既有的 `attempt` 列（C7，实测确认过不是推测）：`attempt` 被识别轨与
  // 字幕轨共用，而 identifyScheduler 在识别成功时把它**归零**
  // （`UPDATE files SET work_id=?, attempt=0 ... WHERE work_dir=?`）。于是 R10 的"满 7 次
  // 移交翻译"若复用这一列，任何一次识别重跑都会把字幕轨攒了几天的失败额度洗掉 → 永远攒不到
  // 7 次 → 停牌移交这条通路根本走不到。反方向同样脏：字幕失败会把识别的退避阶梯顶上去。
  // 一列一主是唯一解。
  //
  // 为什么是 `INTEGER NOT NULL DEFAULT 0` 而不是可空（D22，这才是本条迁移的实质）：
  // 分流谓词是 `sub_attempt >= 7`，而 SQL 三值逻辑下 `NULL >= 7` 求值为 **unknown**
  // （不是 false）→ WHERE 不取它、CASE 不进它 → 整套"满 7 次移交停牌"一行代码都不用改
  // 就静默失效了，日志与界面上什么都看不出来。这与 sub_recheck_at 栽的坑（D18）是同一个，
  // 本仓已四次栽在这个模式上（C12 → C35 → D17 → D18）——不能有第五次。
  //
  // DEFAULT 0 是第二项刚性需求，与 NOT NULL 各自解决不同的问题：
  //   · NOT NULL 保证谓词可判（上一段）
  //   · DEFAULT 0 保证**两类不写这一列的写入方**都拿到 0 而不是撞约束：
  //     ① daemonV2 的 upsert 语句列清单里没有 sub_attempt（它只写机械事实），新扫到的文件
  //        全靠这条 DEFAULT；
  //     ② 1b-3 的指纹变化清空（fingerprintResetColumns）对 NOT NULL 列**按 dflt_value 回落**，
  //        没有 DEFAULT 时它会 `continue` 跳过该列 → 换片源后旧的失败计数原样残留 →
  //        新片源自带失败额度，4 次就进停牌（本该有 7 次）。
  //     那边有一条 ALTER 预演用例正钉着这个行为，本条把预演变成现实。
  //
  // SQLite 的 `ADD COLUMN ... NOT NULL DEFAULT 0` 对存量行直接填 0（不是留 NULL），故升级
  // 路径与 fresh install 落到同一个值，无需额外 UPDATE 回填。
  //
  // 条件式 files 表存在性检查照抄 v30–v33：v29 及更早的库升级上来时 files 表还不存在
  // （v30 才建），裸 ALTER 会 `no such table: files` 把 openDb 整个炸掉 → 用户的库再也打不开。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('sub_attempt')) {
      db.exec('ALTER TABLE files ADD COLUMN sub_attempt INTEGER NOT NULL DEFAULT 0')
    }
  },
  // v35（2026-08-08 流水线 spec，裁决 R21 + D9 / 缺口 C24·C31·C40）：files 表加 translatable
  // ——"翻译救不救得了这一集"的预判事实列，judge 阶段写入。
  //
  // 为什么要预判（R21 / C24）：`works.origin_lang` 在识别时就已落库，即**第 0 天**就知道
  // 翻译救不救得了。而把这个判定留在翻译流内部（满 7 次之后）意味着：韩剧/法国片无中字 →
  // 字幕 agent 认真穷尽搜 7 天（7 个完整付费 LLM session + 全 provider 网络调用）→ 第 8 天
  // 移交翻译流 → 100ms 内判定 unsupported → unsolvable。O(1) 可判的终局不该塞在 7 天延迟之后。
  //
  // 为什么**可空**、且与 sub_attempt 刻意相反（C40 红线）：这一列的 NULL 是一个**有意义的
  // 第三态**——"暂不可判"（judge 还没跑到它，或 embedded_langs 缺失导致判据不全）。
  // C40 明令 `translatable IS NULL` **不得判死**：视为暂不可判，继续留在字幕流。
  // 若照 sub_attempt 的样子建成 `NOT NULL DEFAULT 0`，"还没判"与"判过、不可救"就撞成同一个
  // 值 → 满 7 次时一律走 unsolvable → 把一批还没来得及判的片子永久判死。
  // 三态语义：NULL=暂不可判 / 0=不可救（→ unsolvable）/ 1=可救（→ handoff_translate）。
  //
  // 判据不进 sub_status 而单独立列（R21）：sub_status 是"磁盘上现在什么情况"的投影，
  // 恰好四态（R17）；把可救性塞进去就是造第五态，正是本步在废止的那件事。
  //
  // 不加 CHECK 约束（值域 NULL/0/1）：SQLite 给已有表加 CHECK 需要官方 12 步重建表流程
  // （建新表→拷数据→删旧表→改名），而 files 表在生产上有几万行、且 DROP TABLE 会撞
  // foreign_keys 的隐式检查（见 openDb 里那段论证）。成本远超收益——写入者只有 judge 一处，
  // 由 judgeTranslatable 的返回类型在类型层收口。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('translatable')) {
      db.exec('ALTER TABLE files ADD COLUMN translatable INTEGER')
    }
  },
  // v36（2026-08-08 流水线 spec §4 第 4 步 · 缺口 C5 + C21）：works 表加 provider_ids
  // ——JSON 形如 `{"tmdb":"1","imdb":"tt14827638"}`，照旧表 series/movies.provider_ids 的既有口径。
  //
  // 为什么这一列是翻译抓源腿的命门而不是"顺手加的备用 id"：`cli/fetchSourceSub.ts` 顶部注释
  // 明写"兜底搜索**必须**带上 imdb（可行性验证：文本 query 有假阴性，imdb 命中率高得多）"。
  // OpenSubtitles 按 imdb 精确定位，按标题文本搜同名剧/重制版/不同年份的同名片会大量假阴性。
  // 缺这一列，抓源腿即便接通 files/works（C4）也只剩退化的文本查询——而第 6 步的 e2e 恰好
  // 就在这批存量作品上跑，会在退化状态下量出一个偏低的命中率并被当成"真实命中率"（C21 原话）。
  //
  // 为什么**可空**、且刻意不给 DEFAULT（这是本条的实质，加列只是顺带）：
  // NULL 在这里同时承担两个语义，缺一不可——
  //   ① "还没采过"，也就是 C21 存量回填 pass 的**唯一取件谓词**（`provider_ids IS NULL`）
  //   ② 因此也是这个 pass 的**收敛条件**：采过就非 NULL，谓词自然选不中，不需要额外的
  //      "回填完成"标记位（那种标记位本身又是一个"谁来写/谁来重读"的新洞）
  // 若照 sub_attempt 的样子建成 `NOT NULL DEFAULT '{}'`，存量行升级上来全是 '{}' → 回填一行
  // 都选不中 → CURRENT-STATE 里那 83 个已识别作品的 imdb 永远补不上，而这正是 C21 要修的
  // 那件事本身。这与 D18（sub_recheck_at 留 NULL）/ D22（sub_attempt 必须 NOT NULL）是
  // **同一族权衡的相反解**：那两列的 NULL 会让谓词求值成 unknown 从而静默失效，
  // 这一列的 NULL 恰恰是谓词赖以工作的信号。判据是"NULL 对这一列意味着什么"，不是"照抄上一条"。
  //
  // 与 sub_recheck_at（D18）的另一处相反：那条必须在迁移里把存量行**打散到未来**，因为
  // 它的谓词是 `<= now`（NULL 永不命中）且首轮全量会在 FUSE 挂载上雪崩。这一列不需要：
  // 谓词是 `IS NULL`（存量行天然命中），而回填 pass 自带每批 200 的上限，不会雪崩。
  //
  // 存量行**不做任何回填 UPDATE**，纯 ADD COLUMN：采 imdb 需要一次 TMDB 往返
  // （`getExternalIds`，tmdb.ts:365），而 openDb 是同步的、且在每个进程启动路径上——
  // 在迁移里打网络就是把"打开数据库"变成一个可能挂几分钟或失败的操作。采集归 boot 时的
  // 回填 pass（daemonV2.backfillProviderIds，有分批/失败隔离/不阻塞主巡检）。
  //
  // 纯 ADD COLUMN，无 CHECK 约束、无列类型变更 → 不触发 SQLite 的 12 步建表流程。
  // 条件式 works 表存在性检查照抄 v30–v35：v29 及更早的库升级上来时 works 表还不存在
  // （v30 才建），裸 ALTER 会 `no such table: works` 把 openDb 整个炸掉 → 用户的库再也打不开。
  // 列存在性检查保证幂等：db.test.ts 的"迁移可在已迁库上重跑"会把尾部迁移再跑一遍，
  // 裸 ALTER 会抛 duplicate column name。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'works'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(works)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('provider_ids')) {
      db.exec('ALTER TABLE works ADD COLUMN provider_ids TEXT')
    }
  },
  // v37（2026-08-08 流水线 spec §4 第 4 步 · 裁决 D3 + D6）：files 表加 tr_attempt / tr_recheck_after
  // ——翻译流**自己的**退避轨。
  //
  // 为什么必须是独立两列而不是复用字幕轨的 sub_attempt/recheck_after（D3，与 C7 同型）：
  // C7 已用实测证明"一列多主"的后果——`attempt` 被识别轨与字幕轨共用，identifyScheduler
  // 在识别成功时把它归零，于是字幕轨攒了几天的失败额度被一次识别重跑洗掉。翻译轨若复用
  // sub_attempt 是同一个坑的第三次：翻译失败会把字幕轨的额度顶上去（本该 7 次的文件 4 次
  // 就停牌），而字幕轨停牌写入的 recheck_after 是"+7 天"、翻译轨要的是"明天"，互相覆盖。
  //
  // 为什么 tr_attempt 必须 `INTEGER NOT NULL DEFAULT 0`（同 D22，本仓第五次面对这个坑）：
  // 分流谓词是 `tr_attempt >= 3`（held 满 3 次 → unsolvable），SQL 三值逻辑下 `NULL >= 3`
  // 求值为 **unknown**（不是 false）→ 谓词永不命中 → "翻译反复失败就停牌"静默失效，
  // 一个模型系统性过不了闸的文件被无限重试，每次都是一个付费 LLM session。
  // DEFAULT 0 另有一项**今天就 load-bearing** 的作用：daemonV2 的 upsert 列清单里没有
  // tr_attempt（它只写机械事实），每个新扫到的文件全靠这条 DEFAULT 拿到 0 而不是撞 NOT NULL。
  //
  // 为什么 tr_recheck_after 刻意**可空**（判据是"NULL 意味着什么"，不是照抄上一条）：
  // 它是"下次该轮到这一行"的时刻，NULL = "从没被翻译流碰过" = **应当立刻可领**。故翻译
  // 工作台谓词必须写成 `(tr_recheck_after IS NULL OR tr_recheck_after <= now)`，与字幕轨
  // recheck_after 的既有读法（3-2）保持同一种表示法——两条轨对同一概念用相反表示法是纯
  // 认知负担。反过来给它 `NOT NULL DEFAULT 0` 语义上等价（0 也 <= now），但会分叉口径。
  //
  // SQLite 的 `ADD COLUMN ... NOT NULL DEFAULT 0` 对存量行直接填 0（不留 NULL），故升级
  // 路径与 fresh install 落到同一个值，无需额外 UPDATE 回填。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v30–v36：前者防 v29 及更早的库（files 表 v30 才建）
  // 裸 ALTER 撞 `no such table: files` 把 openDb 整个炸掉 → 用户的库再也打不开；后者保证幂等
  // （db.test.ts 会把尾部迁移重放一遍，裸 ALTER 会抛 duplicate column name）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('tr_attempt')) {
      db.exec('ALTER TABLE files ADD COLUMN tr_attempt INTEGER NOT NULL DEFAULT 0')
    }
    if (!columns.has('tr_recheck_after')) {
      db.exec('ALTER TABLE files ADD COLUMN tr_recheck_after INTEGER')
    }
  },
  // v38（2026-08-08 流水线 spec 第 5 步的下游半边 · 裁决 R9 + R10 的语义修正）：
  // files 表加 sub_retry_streak ——"连续多少轮源站拒绝回答"的独立计数列。
  //
  // 它存在的全部理由是一个语义错误：第 5 步把字幕 agent 的 skill 改对之后（撞 provider
  // 限流/配额耗尽时报 retry_later 而不是误报 no_safe_match），下游 subtitleScheduler 仍把
  // retry_later 与"搜过确实没有"记在同一个 sub_attempt 上。而 `sub_attempt` 的含义是
  // **真实尝试过、确实找不到**的次数——R10 的"满 7 次移交翻译"整个建立在这个含义上。
  // retry_later 是"**问都没问到**"：429 / 配额耗尽 / 5xx / key 被拒时源站拒绝回答，
  // 它没有产生任何关于"这个字幕存不存在"的信息。实案（Peacemaker）：撞限流 7 天 →
  // 攒满 7 次 → 移交翻译流或判 unsolvable 停牌，**而那个字幕一直在源站上**。
  // v1 轨的口径本来就是对的（findSubtitleWorkerTask.ts 注释明写 retry_later 走
  // "completeError 的短退避节流轨，R-10 豁免，永不 dormant"），是新架构漏消费了这个区分。
  //
  // 那为什么不直接**无条件豁免**、连这一列都不要：provider 长期挂掉（API key 永久失效、
  // 站点关站）的文件会永远攒不到 7 次 sub_attempt → **永不进翻译流** → 永远躺在字幕
  // 工作台里每天烧一次付费 session，UI 上毫无异常。那是把一个永久卡死换成另一个。
  // 故裁决是"豁免计数，但配上限"：连续达到上限时折算一次 sub_attempt 并把连续计数归零。
  //
  // 为什么必须是**独立一列**（C7 的第四次，前三次都有实测血案）：两列表达两件不同的事，
  // 一列一主。把折算进度编码进 sub_attempt（负数/高位）会让每一个只读 sub_attempt 的
  // 地方——daemonV2 的快照剔除与 bumpAllAsAttempt、阶段 2.6 复查闸、UI——读出一个它
  // 无法解释的数。
  //
  // 为什么 `INTEGER NOT NULL DEFAULT 0`（D22 同型，本仓第六次面对这个坑）：
  // 折算谓词是 `sub_retry_streak >= CAP`，SQL 三值逻辑下 `NULL >= 3` 求值为 **unknown**
  // （不是 false）→ 谓词永不命中 → 上一段那条"最终仍会移交"的通路一行代码不用改就静默
  // 失效。DEFAULT 0 兜住两类不写这一列的写入方：① daemonV2 的 upsert（只写机械事实）；
  // ② 1b-3 的指纹变化清空（fingerprintResetColumns 对 NOT NULL 列按 dflt_value 回落，
  // 读不出 DEFAULT 就 `continue` 跳过该列 → 换片源后旧的折算进度残留）。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v30–v37（前者防 v29 及更早的库裸 ALTER 把
  // openDb 整个炸掉，后者保证幂等——db.test.ts 会把尾部迁移重放一遍）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('sub_retry_streak')) {
      db.exec('ALTER TABLE files ADD COLUMN sub_retry_streak INTEGER NOT NULL DEFAULT 0')
    }
  },
  // v39（R-F3 通知页的持久化数据源，2026-08-11）：notifications 表。纯 CREATE TABLE +
  // CREATE INDEX，无 CHECK 约束变更、不碰任何既有表，故不触发 12 步建新表流程。
  //
  // ── 为什么必须有这张表（这是本条唯一需要论证的事）────────────────────────────
  // 上一个 commit（32ceaeb）的 SSE 通道里 `found` 事件就是通知页的数据源，但它的续传缓冲是
  // **进程内环形缓冲**（ScoutEventBus.buffer，REPLAY_BUFFER_CAP=50，非持久）。而 R-F3 要求
  // 通知**保留一周**。两者的差距不是容量，是**生命周期**：用户关着浏览器的那 23 小时里找到的
  // 字幕全部丢失，容器重启同样清零。scoutEvents.ts 自己的注释已经把这条说穿了——"这条缓冲
  // 只服务'手机锁屏 30 秒再打开'这一档断线重连，**不是账目**（账目在 runs 表与日志文件里）"。
  // 通知页要的恰恰是账目。故 SSE 只负责"实时把新的推给正在看的人"，一周的流水必须落库。
  //
  // ── 为什么不能从既有表推导（逐个排除，全部实测过，不是推测）──────────────────
  //  · `files.sub_status='covered' + updated_at`：**推不出来**。updated_at 是"这一行最后被写过
  //    的时刻"，而不是"字幕找到的时刻"——observeSubtitle 每次 B 档复核（7 天一轮）都会
  //    无条件 `UPDATE files SET sub_status='covered', sub_recheck_at=?, updated_at=?`，
  //    一个三个月前配上字幕的文件每周被刷新一次 updated_at。实测：写入 updated_at=1000 后
  //    再复核一次即变 99999。照它做一周窗，通知页会天天冒出陈年老片假装"刚找到"；反过来
  //    真·新成果与假·复核刷新在这一列上**完全同形**，无从区分。而且它只有一个时刻，
  //    装盘与"用户手删后重新找到"也分不开。
  //  · `subtitles` 表（有 created_at，形状最接近）：**生产已无写入者**。它的两个写入点
  //    markCovered / recordAdoptedSidecar 都挂在 LibraryRepo 上，服务 episodes/movies 旧表；
  //    新架构 daemonV2 走 files/works 两表，装盘回写在 subtitleScheduler.markInstalled 里，
  //    一行都不碰 subtitles。用它 = 先给它接一个新生产者，那与新建表同等工作量却背上
  //    旧 item_id 值域（episodes.id）与新 work_id 值域的映射债。
  //  · `runs`：**生产零消费者也零新增生产者**——RunsRepo.insert 的 4 个调用点全在
  //    worker_task 路径上，而 jobs.claimNext 自第 2 步起生产零调用点（cli/index.ts:446 明记）。
  //    且它的粒度是"一次 job 的决策史"，没有季集维度，detail 是人话字符串。
  //  · `jobs`：同上，队列只剩生产者没有认领者；且它是**任务**表，任务完成即被改写，
  //    不是成果流水。
  //
  // ── 表结构的三个非显然选择 ──────────────────────────────────────────────────
  //  ① **逐集存，不存聚合**。R-F3 的展示形态是「XX 剧找到了 S01 的第 3/5/7 集」（按作品+季
  //     聚合），但存聚合会立刻撞上"同一季分两次找到"的合并问题：先找到 E1、两天后找到 E2，
  //     聚合行要么被覆盖（丢 E1）要么要读-改-写（两步之间掉电留半状态，软路由掉电是本项目
  //     常态）。逐集存 + 读时 GROUP BY 天然免疫，代价只是读时一次聚合——一周的量级是几十行。
  //  ② **唯一索引用 ifnull() 表达式**，不是裸 UNIQUE(work_id, season, episode)。SQLite 的
  //     UNIQUE 视 NULL 互不相等，而电影的 season/episode 恒 NULL → 裸 UNIQUE 对电影**完全
  //     失效**，每次装盘插一新行。同 jobs_identity 的既有作法（那条注释里记的是同一个坑）。
  //  ③ **不做已读状态**（R-F3 原话"少一个状态少一堆 bug"）：故无 read_at 列。倒序流水 +
  //     一周窗就是全部语义。
  //
  // 保留期**不由本表结构表达**（没有过期列）：一周窗是读时过滤 + dbMaintenance 顺手清，
  // 论证见 notificationsRepo.ts 顶部。
  (db) => {
    db.exec(`
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,            -- works.id（'tmdb:<id>'）。前端按它跳媒体库页
  title TEXT NOT NULL,              -- 冗余存作品标题：通知页不该为了显示一行字去 JOIN works，
                                    -- 而且作品行被删（用户移除根）后这条历史成果仍应可读
  season INTEGER,                   -- NULL = 电影（R-F3「电影就是已找到字幕」）
  episode INTEGER,                  -- NULL = 电影
  via TEXT NOT NULL,                -- 'fetch'（抓源装盘）/ 'translate'（翻译装盘）
  found_at INTEGER NOT NULL         -- 找到的时刻。倒序流水与一周窗的**唯一**锚点
                                    -- （刻意不复用 files.updated_at，见本 entry 上方论证）
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_identity
  ON notifications(work_id, ifnull(season,-1), ifnull(episode,-1));
CREATE INDEX IF NOT EXISTS notifications_found_at ON notifications(found_at DESC);
    `.trim())
  },
  // v40（R-F15 目标语言可切换性，2026-08-11）：files 表加 skip_reason + sidecar_langs 两列。
  // 纯条件式 ADD COLUMN，无 CHECK 约束变更、不碰既有表，故不触发 12 步建新表流程。
  //
  // ── 用户原话（这两列存在的全部理由）────────────────────────────────────────
  // 「咱们这个项目之所以没有硬编码锚定中文，就是因为要考虑用户不止中国人，可能会是美国人
  // 想要英文字幕的情况」「每个资源有哪些字幕，需要在一开始就记录下来，这样在用户更换目标
  // 语言后，数据库能反应过来」。目标语言是可配置的（settings.target_languages），而库里
  // 两个关键结论此前都**把目标语言烧死在了一个不可逆的投影里**：
  //
  //  ① needs_subtitle 是个布尔，丢掉了 judgeSubtitle 已经算出来的 reason。生产库 1026 个
  //     needs_subtitle=0 的文件分不出"片子本来就是目标语言"（origin-skip）与"有内嵌目标
  //     语言轨"（embedded）——这两者在换目标语言后的命运**完全相反**：origin=zh 的国产剧在
  //     目标改成 en 之后立刻需要找字幕，而有内嵌 zh 轨的片子在目标 en 下同样需要找。
  //     真正的区别在展示（媒体库页第三种标记 ◇ = 原生同语言）与排障（"这 1026 个到底为什么
  //     被跳过"此前无法回答）。reason 是 judge **已经算出来**的量，扔掉纯属浪费。
  //  ② sub_status='covered' 是个**无语言布尔**。磁盘上明明有 .en.srt/.ja.srt，系统却只在
  //     当前目标语言的 tag 集里找过一遍，其余语言从未被记录。后果是换目标语言后：
  //     已配 .zh-Hans.srt 的文件在目标 en 下**仍显示 covered**（错误），而磁盘上早有
  //     .en.srt 的文件会被**重新找一遍**（烧付费 LLM 找一个已经在盘上的字幕）。
  //
  // ── 两列的职责（谁写 / 谁读 / 何时写全）──────────────────────────────────────
  // 本仓已栽过 6 次「加了能力却没定谁写/谁读/谁触发」（C12 → C35 → D17 → D18 → C43 …），
  // 故每一列都在这里写死三件事：
  //
  //  skip_reason TEXT（可空）= judgeSubtitle 的 verdict.reason 原值：
  //    'origin-skip' / 'embedded' / 'extra' / 'missing'。
  //    （'extra' = 机械特典，2026-08-13 用户裁决「特典都完全不算在找字幕的范围」加的第四值，
  //     判据是文件名命中 extrasFilter 的标记表，见 subtitleJudge 的规则 0。）
  //    · 谁写：daemonV2.judgeOnce，与 needs_subtitle **同一条 UPDATE**（分两条会在掉电时
  //      留下"判决已写、理由还是旧的"的行，而 judge 谓词是 `needs_subtitle IS NULL` →
  //      这一行从此永不重判，理由列永久冻结在上一次目标语言的口径上）。
  //    · 谁读：媒体库页第三种标记 ◇（origin-skip）、◆（embedded）与 ▭（extra）；
  //      `mediaLibraryApi.isJudgedExtra`（把特典从 unplacedFileCount 里扣掉）；运维排障。
  //    · 何时写全：judge 谓词覆盖的全部行；换目标语言时随 needs_subtitle 一起清 NULL
  //      （retarget.ts），下轮 judge 按新语言重算。
  //      ⚠️ 'extra' 这一值**与目标语言无关**（判据是文件名），但它照旧随换语言一起被清、
  //      再由下一轮 judge 原样重算出来——多算一次纯函数的成本换"一列只有一个写入口径"，
  //      比在 retarget 里给它开一个"这个值不清"的例外划算得多（那个例外会让 retarget
  //      需要认识 skip_reason 的值域，等于把 judge 的判据复制一份过去）。
  //    刻意**不加 CHECK 约束**：值域由 JudgeVerdict 这个联合类型在编译期保证，SQLite 侧再写
  //      一份字面量就是第二处定义，将来加一种 reason 时必然漏改一处（本仓 C30 的原型）。
  //
  //  sidecar_langs TEXT（可空）= 该视频旁边**全部**外挂字幕的语言集合，JSON 数组，
  //    如 `["en","ja","zh-Hans"]`。与当前 target_languages **无关**——这是磁盘事实，
  //    不是"用户现在要什么"（同 KNOWN_LANGUAGE_TAGS 头注释确立的既有口径）。
  //    · 谁写：daemonV2.observeSubtitle，扫描独占（同 sub_status 的 R24 口径：磁盘上有什么
  //      由扫描说了算，不是 worker 的成功报告）。
  //    · 谁读：retarget.ts 换语言时据它重导 sub_status（**不需要重新扫盘**，这是本列最大的
  //      价值）；未来媒体库页可展示"这一集有哪些语言的字幕"。
  //    · 何时写全：A 档新增/指纹变化 + B 档 7 天轮转（D12 两档原样复用，不新增扫描通路）。
  //    三态**必须保持**（与 embedded_langs / streamProbe 的既有契约一脉相承）：
  //      NULL = 没观察过（FUSE 抖动读不了目录也留 NULL）；[] = 观察过、确认零条外挂字幕。
  //      折叠成 [] 会让一次挂载抖动被记成"这片子没有任何字幕"，换语言重判时据此重找一遍。
  //
  // ── 为什么 sidecar_langs 不写进上面那份 files 终态定义 ─────────────────────
  // 照 recheck_after / sub_recheck_at / sub_attempt / translatable / provider_ids 的既有分工：
  // 一列一条迁移 entry，fresh install 走完整链一次到位，存量库靠同一条 entry 原地补齐。
  // 两处都写会让"改一处忘另一处"变成可能。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v30–v38（前者防 v29 及更早的库裸 ALTER 把 openDb
  // 整个炸掉 → 用户的库再也打不开；后者保证幂等——db.test.ts 会把尾部迁移重放一遍）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    // 两列都**可空**且无 DEFAULT：NULL 在这两列上都是有意义的第三态（"还没判" / "还没观察"），
    // 与 sub_attempt/sub_retry_streak 那种 `NOT NULL DEFAULT 0` 的计数列语义相反——那边
    // NULL 会让 `>= N` 的三值逻辑静默失效，这边 NULL 恰恰是重判/重观察的唯一凭据。
    if (!columns.has('skip_reason')) {
      db.exec('ALTER TABLE files ADD COLUMN skip_reason TEXT')
    }
    if (!columns.has('sidecar_langs')) {
      db.exec('ALTER TABLE files ADD COLUMN sidecar_langs TEXT')
    }
  },
  // v41（Task ③ 守备目录健康度，2026-08-12）：media_roots 加 last_error + last_checked_at。
  // 纯条件式 ADD COLUMN，无 CHECK 约束变更、不碰既有表，故不触发 12 步建新表流程。
  //
  // ── 为什么需要这两列 ──────────────────────────────────────────────────────
  // scanOnce 的 R8 三道闸（读取抛错 / 扫出 0 个 / 行数骤降且重读不一致）今天**只有两个出口**：
  // 日志文件与一条 SSE health 事件。两者都是**瞬时**的——日志没人看，SSE 只推给当时正连着的
  // 订阅者。于是"这个根现在健不健康"这个事实在进程外**没有任何持久载体**：
  //   · 用户 24h 后打开界面，早上 04:07 那次拦截已经无处可查；
  //   · 任何"当前状态"型的读取方（如守备目录列表要标红、健康检查要判 roots.ok）
  //     没有数据源可查，只能凭空说"好的"——那就是撒谎。
  // 这两列把闸门的判决**落进状态机**（铁律①：数据库是状态机），让"上一轮扫描时这个根
  // 怎么样了"变成可查询的事实。
  //
  // ── 两列的职责（谁写 / 谁读 / 谁触发）─────────────────────────────────────
  // 本仓已栽过 11 次「加了能力却没定谁写/谁读/谁触发」（C12 → C35 → D17 → D18 → C43 …），
  // 故每一列都在这里写死三件事：
  //
  //  last_error TEXT（可空）= 上一轮扫描对这个根的判决。
  //    · 谁写：daemonV2.scanOnce 的**单点收敛**（每根一次 try/finally，见那里的论证）。
  //      失败路径写人话原因，成功路径**写 NULL**——只写不清等于错误永久粘住，
  //      用户修好挂载后界面永远显示红的。清空与写入是同一条 UPDATE 的两种取值，
  //      不是两条代码路径（分两条必然漏一条，这正是"教训九"点名的缺失点）。
  //    · 谁读：**目前没有读取方**。这是如实陈述而非疏漏：Task ⑤ 的 /api/v2/health
  //      将据它判 roots.ok，那个端点今天还不存在。在它落地之前，这两列是**只写不读**的，
  //      本条 entry 不为"计划中的读取方"背书。唯一的现实消费者是运维手工查库
  //      （`SELECT path, last_error, last_checked_at FROM media_roots`）。
  //    · 谁触发：每轮扫描（scanOnce），即 24h 巡检 + 任何直接调 scanOnce 的路径。
  //      粒度是"每根每轮一次"，不是"每次闸门触发一次"。
  //    刻意**不加 CHECK 约束**、不做枚举：值是给人看的原因串（含 root 路径与实测数字），
  //    枚举化会立刻催生"第二处定义"（同 v40 skip_reason 的既有论证）。
  //
  //  last_checked_at INTEGER（可空）= 上一轮扫描**处理完这个根**的时刻（毫秒）。
  //    · 谁写：同上，与 last_error 在**同一条 UPDATE 里**。分两条会在掉电时留下
  //      "错误已清、时刻还是旧的"（或反之）的行，而这两列的意义完全绑定在一起：
  //      `last_error IS NULL` 单独看不出是"健康"还是"从没扫过"，必须配 last_checked_at。
  //    · 谁读：同 last_error——今天没有读取方。
  //    · 谁触发：同上。
  //    刻意**可空且无 DEFAULT**：NULL = 这个根从没被扫过（用户刚在 dashboard 里加的根，
  //    下一轮巡检才会碰它）。这是有意义的第三态，与 last_error IS NULL 的"健康"截然不同——
  //    折叠成 `NOT NULL DEFAULT 0` 会让"刚加的根"与"扫过且健康的根"不可区分，
  //    未来的读取方会把前者当成绿的（同 D18 那类静默失效的形态）。
  //
  // ── 为什么不写进上面那份 media_roots 终态定义 ──────────────────────────────
  // 照 content_type（v30 续）/ recheck_after / sub_recheck_at / provider_ids / sidecar_langs
  // 的既有分工：一列一条迁移 entry，fresh install 走完整链一次到位，存量库靠同一条 entry
  // 原地补齐。两处都写会让"改一处忘另一处"变成可能（works 表定义末尾的原话）。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v30 的 content_type（前者防 v11 及更早、
  // 尚无 media_roots 表的库裸 ALTER 把 openDb 整个炸掉 → 用户的库再也打不开；
  // 后者保证幂等——db.test.ts 会把尾部迁移重放一遍）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_roots'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(media_roots)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('last_error')) {
      db.exec('ALTER TABLE media_roots ADD COLUMN last_error TEXT')
    }
    if (!columns.has('last_checked_at')) {
      db.exec('ALTER TABLE media_roots ADD COLUMN last_checked_at INTEGER')
    }
  },
  // v42（Task ⑥ 活动页横版背景图，2026-08-12）：works 加 backdrop_path。
  // 纯条件式 ADD COLUMN，无 CHECK 约束变更、不碰既有表，故不触发 12 步建新表流程。
  //
  // ── 为什么需要这一列 ──────────────────────────────────────────────────────
  // R-F13 的活动页「在跑」卡片要**横版** backdrop（60% 宽 / 186px 高），排队卡片才用竖版
  // poster。这不是审美偏好而是宽高比算术：`16:9 @ 70px高 = 124px宽`（窄行里看不清）
  // vs `2:3 @ 70px高 = 47px宽`（天生适合窄行）——两个位置形状不同是分工不是缺陷。
  //
  // 横版图今天在库里**无处可取**：`series.backdrop_path`（v16）确实存在，但 `series` 是
  // **旧世界**的表，只有 `libraryRepo.upsertSeries`（ingest 走盘循环）会写；新架构的
  // daemonV2 一行 series 都不写，它写的是 `works`。于是新架构识别出的作品全都没有横版图，
  // 活动页只能退化成「模糊海报当背景」。而 TMDB 客户端**早就在取**这个字段
  // （tmdb.ts:325 的 backdropPath，v16 详情页重设计时加的），只是 works 落库时漏了它——
  // 这一列买的是「已经付过 TMDB 往返的数据不要在落库那一步扔掉」。
  //
  // ── 这一列的职责（谁写 / 谁读 / 谁触发）─────────────────────────────────────
  // 本仓已栽过 11 次「加了能力却没定谁写/谁读/谁触发」（C12 → C35 → D17 → D18 → C43 …），
  // 故在这里写死三件事：
  //
  //  backdrop_path TEXT（可空）= TMDB 横版背景图路径（如 '/bd.jpg'；web 端自拼 w1280 CDN
  //    URL 前缀，同 poster_path 的既有口径——服务端不代理图片）。
  //    · 谁写：**两个**写入点，缺一不可（只补一个就是"只修一半"，本仓病 A 的典型形态）——
  //      ① `identifyScheduler.writeIdentified`：新识别的作品在落 works 行那一刻带上它。
  //         只有这个点的话，库里**存量**的已识别作品永远是空的：identifyScheduler 的队列
  //         谓词是 `files.work_id IS NULL`，识别成功后那个目录**永不再进识别队列**。
  //      ② `daemonV2.backfillBackdropPaths`：boot 时的存量回填 pass。只有这个点的话，
  //         新识别的作品要等到**下一次 boot** 才有图（而 boot 可能几周一次）。
  //      两个点合起来才收敛，这与 provider_ids（C5 写入点 + C21 回填 pass）是同一形态、
  //      同一理由——那一条的注释已经把这个论证写死过一遍，本条照抄其分工。
  //    · 谁读：**目前没有读取方**。这是如实陈述而非疏漏：Task ⑨ 的活动页「在跑」卡片
  //      将据它渲染横版背景，那个页面与它的 API 字段今天都还不存在。在它落地之前，
  //      这一列是**只写不读**的，本条 entry 不为"计划中的读取方"背书。唯一的现实消费者
  //      是运维手工查库（`SELECT id, title, backdrop_path FROM works`）。
  //
  //      ⚠️⚠️ **但有一个同名字段的读取方已经存在，且它接的不是这一列**（Task ⑥ 审计 🔴-2）：
  //      `apiV2.buildWorkflowWorkers`（旧活动页的 DTO 生产者）三处查询全部
  //      `LEFT JOIN series` / `LEFT JOIN movies`，读的是 `series.backdrop_path`。
  //      而那两张是**旧世界的表**（daemonV2.ts:2137 自陈），生产实测 **series 0 行 / movies 0 行**
  //      （works 110 行）——所以旧活动页的 backdropPath 恒 null，与本列填不填满无关。
  //
  //      这**不是**"读取方接错表"需要立刻改：旧活动页整个要被 Task ⑨ 重写，
  //      现在把 buildWorkflowWorkers 切到 works 等于给一个即将删除的页面做迁移。
  //      但 Task ⑨ 必须知道：**它要读的是 works.backdrop_path，不许照抄旧 DTO 的 JOIN**，
  //      否则会得到一个"填满了却全是 null"的字段，且排障时极难看出来。
  //      （顺带：这一列对 tv/movie 一视同仁，能顺手抹平 apiV2.ts:1126 记的那处
  //       "movies 表没有 backdrop 列"的不对称——生产 110 个 works 里 42 个是 movie。）
  //    · 谁触发：写入点①随每次识别成功；写入点②随每次进程 boot（每轮 200 行上限，
  //      多轮 boot 收敛）。
  //
  //  为什么**可空且无 DEFAULT**（判据是"NULL 对这一列意味着什么"，不是照抄上一条）：
  //    NULL = **这个作品没有横版图**（TMDB 真没有，或还没采过——v42 时这两者不可区分，
  //    v43 起"采没采过"由 `backdrop_checked_at` 单独承载，本列不再兼职表达它）。
  //    读取方（Task ⑨ 活动页）对 NULL 的处置恒定是"降级模糊海报"，与成因无关。
  //    ⚠️ v42 原文此处写的是「NULL 同时承担'还没采过'与回填 pass 的取件谓词/收敛条件」——
  //    那正是队头阻塞的根因（一个 NULL 兼两职，其中一职恒真 → 谓词永不收敛）。
  //    v43 起取件谓词是 `backdrop_checked_at IS NULL`，本列不再是谓词的输入。
  //    仍然必须可空且无 DEFAULT：若照 sub_attempt 的样子建成 `NOT NULL DEFAULT ''`，
  //    读取方就要去认识空串（apiV2 的 nullIfEmpty 已在为这种二义性付代价）。
  //
  //  ⚠️ 这一列与 provider_ids 有一处**关键的不同**，不许照抄那边的三态写法：
  //    provider_ids 能靠 `{tmdb}`（非 NULL）表达"查过、TMDB 确实没有"，因为它是个 record，
  //    有地方放这个凭据。backdrop_path 是**裸路径串**，没有第三个值可用：TMDB 确实没有
  //    横版图的作品（小众剧、部分电影常见），采回来就是 null，与"还没采过"在列上不可区分。
  //
  //    ⚠️⚠️ **v43 已修正本段的结论，下面这段保留作沿革，不再是现行设计。**
  //    原文当年判定"每轮 boot 重查一次"是**已知且接受**的代价，理由是"一次 getDetails
  //    往返，200 行上限，串行，量级与 provider_ids 回填相同"。这个成本估算**低估了一个
  //    量级**：真实后果不是"多花一次往返"，而是**永久饿死**——谓词恒真 + `ORDER BY id`
  //    恒定 + `LIMIT 200` 三者相乘，每轮取到的是同一批头部 200 行，第 201 行往后**一次
  //    都不会被查到**（审计实测 250 行 / 3 轮：totalCalls=600 unique=200）。
  //    修法正是本段末尾自己指出的那个——加一列 `backdrop_checked_at`，见 v43 entry。
  //    反面方案（写 `''` 当哨兵）的否决**依然有效**，v43 没有推翻它：apiV2 那一侧
  //    `nullIfEmpty` 的存在正说明本仓已经在为空串/NULL 二义性付代价，不该再造一个。
  //    v43 走的是"凭据另起一列"，backdrop_path 本身的语义（NULL = 没有图）一字未动。
  //
  // ── 为什么不写进上面那份 works 终态定义 ────────────────────────────────────
  // 照 provider_ids（v36）/ content_type（v30 续）/ recheck_after / sub_recheck_at /
  // sidecar_langs 的既有分工：一列一条迁移 entry，fresh install 走完整链一次到位，存量库靠
  // 同一条 entry 原地补齐。两处都写会让"改一处忘另一处"变成可能（works 表定义末尾的原话）。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v36 的 provider_ids（前者防 v29 及更早、尚无
  // works 表的库裸 ALTER 把 openDb 整个炸掉 → 用户的库再也打不开；后者保证幂等——
  // db.test.ts 会把尾部迁移重放一遍，裸 ALTER 会抛 duplicate column name）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'works'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(works)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('backdrop_path')) {
      db.exec('ALTER TABLE works ADD COLUMN backdrop_path TEXT')
    }
  },
  // v43（Task ⑦ backdrop 回填的队头阻塞修复，2026-08-12）：works 加 backdrop_checked_at。
  // 纯条件式 ADD COLUMN，无 CHECK 约束变更、不碰既有表，故不触发 12 步建新表流程。
  //
  // ── 这一列修的是什么（v42 entry 亲手记下的那笔债，现在到期了）─────────────────
  // v42 的 entry 末尾写着："若日后 TMDB 无图的作品占比高到让这个重查有成本，正确的修法是
  // 加一列 `backdrop_checked_at`（"查过"这件事自己的载体），而不是往路径列里塞哨兵值。"
  // 本条就是那一列。触发它的不是"占比高到有成本"，而是审计实测出的一个**更硬的**后果——
  // 那个已知代价被低估了一个量级：它不是"多花一次往返"，是**永久饿死**。
  //
  // 实测（250 行全部无横版图，跑 3 轮 boot）：
  //   totalCalls=600 unique=200 first=1 call#201=1
  // 600 次调用只覆盖了 200 个不同作品。原因是三件事凑在一起，缺一不可：
  //   ① 谓词 `backdrop_path IS NULL` 对"TMDB 真没图"的行**恒真**（v42 已知、已接受）
  //   ② `ORDER BY id` 是**恒定**序（不是随机、不是轮转）
  //   ③ `LIMIT 200` 每轮只取头部
  // → 每轮 boot 取到的是**同一批** 200 行，第 201–250 行**一次都没被查过**，且后续
  //   任何一轮都不会查到它们。这不是"收敛慢"，是那 50 行永远拿不到横版图。
  // 生产今天 110 行（< 200）不触发，但这是随库增长静默生效的定时炸弹；且 `ORDER BY id`
  // 是**字符串序**（`tmdb:1038392` 排在 `tmdb:99` 前面），谁被饿死不可预测、不可复现。
  //
  // ── 为什么是独立一列，而不是往 backdrop_path 里塞哨兵 ─────────────────────────
  // v42 entry 已经论证过反面方案（写 `''` 当"查过没有"的哨兵）：读取方会拿到空串，而
  // apiV2 那侧 `nullIfEmpty` 的存在正说明本仓已经在为空串/NULL 二义性付代价，不该再造一个。
  // 那条论证今天依然成立，本条不推翻它——本条是它指名的那个"正确修法"。
  //
  // 关键在于把**两件不同的事**拆回两列，各自的 NULL 语义才不再打架：
  //   · `backdrop_path`     = 「图是什么」。NULL = 没有图（无论查没查过）。**语义不变**，
  //                           读取方（Task ⑨ 活动页）照旧 `?? 降级模糊海报`，不需要认识哨兵。
  //   · `backdrop_checked_at` = 「查过没有、什么时候查的」。NULL = 从没查过。
  // 于是回填谓词从「图是不是空的」改成「查没查过」——后者才是这个 pass 真正想问的问题，
  // 而它天然单调：查一次就永久非 NULL，谓词再也选不中，**无论 TMDB 有没有图**。
  //
  // ── 为什么这与 C21 是同源形态而非"同一件事两套写法" ──────────────────────────
  // C21（provider_ids）的收敛靠的是「写一个非 NULL 的凭据表达'查过、确实没有'」——
  // `{tmdb}` 就是那个凭据。本条一字不差是同一个机制，只是凭据**放在哪里**不同：
  //   · provider_ids 是 record，凭据能塞进值里自己（`{tmdb}`），不必加列；
  //   · backdrop_path 是裸路径串，值里没有第三个槽位 → 凭据只能另起一列。
  // 换句话说 C21 是本条的**退化特例**（恰好不需要额外列），不是另一套方案。
  // 两者的收敛不变式是同一条：**每一个"从 TMDB 拿到了确定答案"的行，都必须落下一个
  // 非 NULL 的凭据；只有"没拿到答案"（调用失败/探针缺席）才允许留 NULL 等下轮。**
  //
  // 而且这个「裸值列 + 独立 _checked_at 列」的形状在本仓**早有先例，不是新发明**：
  // `series.chinese_title` + `series.chinese_title_checked_at`（v9 终态定义，db.ts:25-26）
  // 就是逐字同构的一对——中文名同样是裸串、同样"TMDB 真没有"与"还没查"不可区分，
  // 当年就是靠独立的 `_checked_at` 解决的。本条照抄那个既有形状，含命名。
  //
  // ── 这一列的职责（谁写 / 谁读 / 谁触发）─────────────────────────────────────
  // 本仓已栽过 11 次「加了能力却没定谁写/谁读/谁触发」，故照 v42 的规矩写死三件事：
  //
  //  backdrop_checked_at INTEGER（可空）= 最近一次**从 TMDB 得到确定答案**的时刻（epoch ms）。
  //    · 谁写：**两个**写入点，与 backdrop_path 的两个写入点一一配对（缺一就是只修一半）——
  //      ① `identifyScheduler.writeIdentified`：新识别时与 backdrop_path 同一条 INSERT 落下。
  //         不补这点的话，新识别的作品若 TMDB 无图，checked_at 恒 NULL → 回填 pass 每轮
  //         boot 把它捡回来重查一次，本条修的队头阻塞就从回填侧原样搬到识别侧。
  //      ② `daemonV2.backfillBackdropPaths`：存量回填 pass，本条的主战场。
  //    · 谁读：**只有回填 pass 的取件谓词**（`backdrop_checked_at IS NULL`）。这是如实陈述：
  //      它不是展示字段，Task ⑨ 的活动页读的是 backdrop_path，**不读这一列**。
  //      它的全部价值是"让谓词能收敛"，与 chinese_title_checked_at 的既有定位一致。
  //    · 谁触发：写入点①随每次识别成功；写入点②随每次进程 boot。
  //
  //  为什么**可空且无 DEFAULT**（判据是"NULL 对这一列意味着什么"，逐条重算而非照抄上一条）：
  //    NULL = "从没查过"，这正是回填 pass 的**唯一取件谓词**兼**收敛条件**。
  //    若建成 `NOT NULL DEFAULT 0`，存量行升级上来全是 0（非 NULL）→ 谓词一行都选不中
  //    → 存量作品的横版图**永远补不上**，恰好把本条要修的饿死从 50 行放大到全库。
  //    这与 v36 provider_ids / v42 backdrop_path 的 NULL 语义逐字同源。
  //
  //  ⚠️ 存量行（v42 已跑过、backdrop_path 已有值的行）在本迁移里**一律落 NULL**，
  //    刻意不做 `UPDATE … SET backdrop_checked_at = <now> WHERE backdrop_path IS NOT NULL`
  //    的"顺手回填"。理由：那种写法要在迁移里凭空捏一个"查过的时刻"，而 openDb 是同步的、
  //    在每个进程启动路径上（同 v36 "不在迁移里打网络"的既有口径的近亲）。代价是可控且
  //    **一次性**的：这些行下一轮 boot 会被谓词捡回来各重查一次，然后落下真实的 checked_at
  //    从此永久收敛——是"多一轮"，不是"每轮"，与本条要修的无限重查在量级上不同。
  //
  // ── 为什么不写进上面那份 works 终态定义 ────────────────────────────────────
  // 照 provider_ids（v36）/ backdrop_path（v42）的既有分工：一列一条迁移 entry，
  // fresh install 走完整链一次到位，存量库靠同一条 entry 原地补齐。两处都写会让
  // "改一处忘另一处"变成可能（works 表定义末尾的原话）。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v42（前者防 v29 及更早、尚无 works 表的库裸
  // ALTER 把 openDb 整个炸掉 → 用户的库再也打不开；后者保证幂等——db.test.ts 会把尾部
  // 迁移重放一遍，裸 ALTER 会抛 duplicate column name）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'works'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(works)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('backdrop_checked_at')) {
      db.exec('ALTER TABLE works ADD COLUMN backdrop_checked_at INTEGER')
    }
  },
  // v44（2026-08-13 用户裁决「特典都完全不算在找字幕的范围」）：两件事，一条 entry。
  //   ① 让存量特典行**重回 judge**（清 needs_subtitle + skip_reason → NULL）；
  //   ② DROP 掉零行、零读取方、零写入方的 extras_exemptions 表。
  //
  // ── ① 为什么必须有这条迁移（没有它，本轮代码改动对存量库完全不生效）───────────
  // judge 的取件谓词是 `needs_subtitle IS NULL`（daemonV2.judgeOnce）。生产库那 16 个
  // NCOP/NCED/PV/menu 文件今天全是 `needs_subtitle=1`——它们**早就被判过了**，
  // 于是新加的规则 0 永远轮不到它们，代码改了而生产一行不变（本仓栽过多次的"写了新判据
  // 却没定谁触发重判"，C12 → C35 → D17 → C43 那条血案的又一形态）。
  //
  // 谓词刻意是 `needs_subtitle IS NOT NULL`（**全量**清），不是"只清文件名命中的行"：
  //  · 清得多的代价是**零**——judge 下一轮把它们照原样重判一遍（纯函数、不碰磁盘、
  //    判据都在 files/works 两表里现成），语言判决会得到与今天逐字相同的结果。
  //  · 而"只清命中的行"要在 SQL 里复刻一遍 EXTRA_MARKERS 的正则（SQLite 没有 REGEXP，
  //    得摊成 7 个 LIKE），那就是**第二份判据**：改 TS 那张表时这里不会跟着变，
  //    以后新增的标记对存量行永远不生效，且没有任何测试会红。C30 的原型。
  //  · 清 NULL 是**安全**方向：NULL = "还没判"，judge 每轮都会来收，不存在滞留态。
  //    唯一的代价是重判当轮多跑一次纯函数。
  //
  // skip_reason 与 needs_subtitle **同一条 UPDATE 一起清**（照 retarget.ts 的既有口径）：
  // 分两条会在掉电时留下"判决已清、理由还是旧的"的行，而 judge 谓词只看 needs_subtitle
  // → 那一行重判时会覆盖 reason，看似自愈；但反序（reason 先清、needs 没清）就永久留下
  // 一个 needs=1 而 reason=NULL 的行，媒体库页据 reason 显示标记，用户看到的是空白。
  //
  // **刻意不碰 sub_status**（R24 铁律，同 retarget.ts:80 的论证）：那 16 行今天 sub_status
  // 全是 NULL，但这条 UPDATE 不该依赖那个观察。清它会掀掉飞行中的翻译。
  //
  // ── ② 为什么现在可以 DROP extras_exemptions ────────────────────────────────
  // 它是救援R4b 的"用户翻案"豁免表（v14）。三方全空，逐条核实过：
  //   · **零读取方**：唯一读它的是 `v2/ingest.ts` 的 excludeExtras 分支
  //     （`isMechanicalExtra(path) && !lib.isExtrasExempt(path)`），ingest 已整体退役。
  //   · **零写入方**：唯一写入面是 POST /api/v2/triage/unexclude 端点 + 前端 ExcludedBox，
  //     两者 2026-08-13 已删（见 dashboard/server.ts 与 triageOps.ts 的头注释）。
  //   · **生产零行**（2026-08-13 实测 `/cache/scout.db`）。
  // triageOps.ts 当时写的保留理由是"不单方面拆掉'保留待裁'资产的地基"——今天用户**已经
  // 裁决**了（「特典都完全不算在找字幕的范围」+「不值得为它增加心智负担」），
  // 保留待裁的前提消失，故一并清掉。`LibraryRepo.addExtrasExemption` / `isExtrasExempt`
  // 两个方法同批删除。
  //
  // 翻案能力就此消失，这是**有意的**：新的特典判据落在 needs_subtitle 这一列上，
  // 用户若真想给某个特典找字幕，通路是改文件名（同"认领退役"那条裁决的口径——
  // 改名对所有下游工具都修好，而豁免表只修我们一家）。
  //
  // `DROP TABLE IF EXISTS` 而非裸 DROP：v13 及更早的库根本没建过这张表（v14 才建），
  // 裸 DROP 会让那些库的 openDb 整个炸掉 → 用户的库再也打不开。
  (db) => {
    const columns = (() => {
      try {
        const exists = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
          .get()
        if (!exists) return new Set<string>()
        return new Set(
          (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
            .map((c) => c.name),
        )
      } catch { return new Set<string>() }
    })()
    // files 表存在且有 needs_subtitle 列时才清（v8 及更早的库没有这张表/这一列）。
    if (columns.has('needs_subtitle')) {
      db.exec(
        'UPDATE files SET needs_subtitle = NULL'
        + (columns.has('skip_reason') ? ', skip_reason = NULL' : '')
        + ' WHERE needs_subtitle IS NOT NULL',
      )
    }
    db.exec('DROP TABLE IF EXISTS extras_exemptions')
  },

  // v45（C48 解析器版本化重解析，2026-08-14）：files 表加 parser_version。
  // 纯条件式 ADD COLUMN，无 CHECK 约束变更、不碰既有表，故不触发 12 步建新表流程。
  //
  // ── 为什么需要这一列（没有它，解析器的任何改进对存量库**永远**不生效）─────────
  // scanOnce 的指纹闸是 `if (mtime 与 size 都没变) continue`，而它挡在 toMediaFileRow
  // （内含 parseStructure → parseFilename）**之前**。文件躺在 NAS 上不动 → 指纹永远不变
  // → 解析永远不重跑。cf0453c 修好了日文「話」集号与 CRC32 误判，生产库那 13 个日文文件
  // （12 个 season/episode 全 NULL + parse_confidence='none'；1 个 ep04 被 CRC 里的
  // `(4FE33E90)` 误读成 season=1/episode=90 且 confidence='high'）部署新代码后**一行不变**。
  //
  // 这是本仓招牌病 A（"加了能力却没人触发"）的第 13 次：C12 → C35 → D17 → D18 → C43 →
  // v44 的 needs_subtitle 重判 → …… 前几次的治法都是"再写一条一次性 UPDATE 迁移"，
  // 而那个治法**不治本**：下次改解析器时得记得再写一条，忘了没有任何测试会红。
  // 版本号把判据变成结构性的——解析规则一变就递增常量，扫描自己会发现落后的行。
  //
  // ── 默认值必须是 NULL，不能是 PARSER_VERSION（这是本条迁移唯一的要害）─────────
  // 存量行是**用旧规则解析出来的**，它们必须"看起来是旧版本"从而被重解析一次。
  // 若写成 `DEFAULT 1`（= 当前 PARSER_VERSION），全部存量行会当场被标成"已是最新"，
  // 重解析一行都不发生 —— 加了列、加了判据、加了代码，而生产库原封不动。
  // 那正是本条迁移要消灭的那个失效模式**穿着新衣服**再来一次，且这次连日志都不会响。
  //
  // 读取侧用 `(parser_version ?? 0) < PARSER_VERSION` 把 NULL 归一成 0（daemonV2）：
  // 不用 SQL 谓词判是刻意的——`parser_version < 1` 在 NULL 上是三值逻辑的 unknown，
  // **永远选不中存量行**，与 D18 踩的是同一个坑，而这里的静默失效恰恰是本列要修的病。
  // 判据放在 TS 侧、对着一个已经读出来的值做比较，NULL 归零是显式的一步。
  //
  // ── 谁写 / 谁读 / 谁触发 ────────────────────────────────────────────────
  //  · 谁写：daemonV2.scanOnce **独占**（正常 upsert 与 C48 重解析两条路径都恒写
  //    PARSER_VERSION）。没有第二个写入者，也不接受 worker/API 写它——它记的是
  //    "这一行的解析列是哪套规则算的"，只有算的人有资格说。
  //  · 谁读：daemonV2.scanOnce 的重解析判据，全仓唯一读者。不进 API、不进 UI、
  //    不参与任何业务判决——它是纯粹的记账列。
  //  · 谁触发：每轮巡检的 scanOnce。存量行在**下一轮扫描**被重解析一次并写上当前版本，
  //    此后收敛（`< PARSER_VERSION` 恒假），行为与今天的指纹闸逐字相同。
  //
  // 刻意**不加 CHECK 约束**、也**不加 NOT NULL**：NULL 是有意义的第三态（"旧规则/未知"），
  // 正是重解析的唯一凭据（同 v40 skip_reason/sidecar_langs 的既有口径）。
  //
  // 条件式表存在性 + 列存在性双重检查照抄 v30–v44（前者防 v29 及更早的库裸 ALTER 把
  // openDb 整个炸掉 → 用户的库再也打不开；后者保证幂等——db.test.ts 会把尾部迁移重放一遍）。
  (db) => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!exists) return
    const columns = new Set(
      (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
        .map((c) => c.name),
    )
    if (!columns.has('parser_version')) {
      db.exec('ALTER TABLE files ADD COLUMN parser_version INTEGER')
    }
  },
]

/** pre-fold（v9 折叠之前，Jellyfin 时代）老库的结构指纹：series.poster_tag 列存在。
 *  v9 终态把它换成了 poster_path，此后没有任何迁移会重新引入 poster_tag——所以"有它"就等价于
 *  "这库是 pre-fold 的"，不会随 MIGRATIONS 继续增长而失真。series 表不存在（空库/半初始化）
 *  时返回 false：指纹取不到就不拦，交给正常路径去建表。 */
function hasPreFoldFingerprint(db: ScoutDb): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(series)').all() as Array<{ name: string }>
    return cols.some((c) => c.name === 'poster_tag')
  } catch {
    return false // 库里连 series 都没有——不是 pre-fold 老库该有的样子，不拦
  }
}

/** pre-fold 老库的人话指引。语气与内容对齐既有那条 catch 兜底提示：说清"为什么没救"、
 *  "该做什么"、"做完会发生什么"。docker 部署形态下 scout.db 躺在 SUBTITLE_SCOUT_CACHE_DIR
 *  挂载卷里，所以路径要报全，并明确 -wal/-shm 一起删（只删主文件会让 SQLite 拿残留 WAL 重建
 *  出半个老库，用户会二次撞坑）。 */
function preFoldMessage(currentVersion: number, path: string): string {
  return (
    `数据库 schema v${currentVersion} 是 de-Jellyfin 化(v9)之前的旧版本,与当前折叠后的迁移链不兼容` +
    `——迁移未执行,数据库未被改动。这类开发期老库已作废,没有升级路径。` +
    `请停掉服务,备份后删除 ${path} 及同目录的 ${path}-wal / ${path}-shm(三个一起删,只删主文件会让 ` +
    `SQLite 拿残留 WAL 重建出半个老库),重启后程序会重新初始化,从零重扫媒体库、重新识别与找字幕。` +
    `docker 部署的话这些文件在 SUBTITLE_SCOUT_CACHE_DIR 挂载卷里,删之前先 cp 一份留底。` +
    `丢的只有索引与任务/黑名单记录(可重建),磁盘上已下好的字幕文件不受影响——它们是真状态,重扫会重新认领。`
  )
}

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

  // 迁移前置防线：包装在 try...catch 里，确保**任何**阶段抛错（FK 体检/VACUUM/迁移事务）
  // 都能正确关闭连接，绝不残留句柄与 -wal/-shm 锁阻碍重启或修复。
  try {
    // 前置版本闸（pre-fold 老库）：v9 折叠之前的老库（Jellyfin 时代，schema_version 1..8）与
    // 当前折叠后的迁移链**结构上不兼容**——它们的表形状是 v1→v8 逐步 ALTER 的产物，而折叠后
    // MIGRATIONS[0] 是"给空库落 v9 终态"的裸 CREATE TABLE，从下标 currentVersion 处接着跑
    // 只会撞上各式各样的 SQL 错误。这些错误的**形状不可枚举**：实测 schema_version=6 的真实
    // 老库跑到 v15（sub_status 值域重建，建 episodes_v15 → INSERT SELECT 拷贝）抛的是
    // "table episodes_v15 has 14 columns but 10 values were supplied"（列数不匹配），而
    // schema_version=8 的库抛的是 "no such table: item_files"。下游 catch 里那条人话提示原本
    // 只匹配 /no such (table|column)/，于是前者漏网、用户拿到裸 SqliteError 堆栈。往那条正则
    // 上继续贴补丁是打地鼠——下一个老迁移随时可能抛第三种形状（CHECK 约束失败、datatype
    // mismatch、UNIQUE 冲突……）。**根治办法是根本不进迁移链**：在动手之前就判定这是老库，
    // 直接给可操作指引。这样也顺带避免为一个注定失败的迁移白做一次 VACUUM 快照。
    //
    // 判据是"版本号 + 结构指纹"两条**同时**成立，不能只看版本号：meta.schema_version 落的是
    // MIGRATIONS 数组下标+1，而折叠把 v1..v8 压成了下标 0 这一条——于是"下标口径的 6"（fresh
    // install 只跑了前 6 条 entry，是完全健康的库，实测有 parked_paths、series.poster_path）
    // 与"语义口径的 v6"（Jellyfin 时代老库，实测有 series.poster_tag、无 parked_paths）数字
    // 完全撞车。只看 `currentVersion < 9` 会把前者也拦下来，误伤正常升级路径。结构指纹取
    // series.poster_tag：它是 Jellyfin 时代的图片 tag 列，v9 终态换成了 poster_path 且此后
    // 再没有任何迁移会重新引入 poster_tag——有它 ⇔ 这库是 pre-fold 的，判据稳定且不会随
    // MIGRATIONS 继续增长而失真。series 表不存在（空库/半初始化）时指纹取不到 → 不拦，交给
    // 正常路径。
    if (currentVersion >= 1 && currentVersion < 9 && hasPreFoldFingerprint(db)) {
      throw new Error(preFoldMessage(currentVersion, path))
    }

    // 执行未应用的迁移
    if (currentVersion < MIGRATIONS.length) {
      // DB 审计🔴:迁移前自动快照(任何进程 openDb 触发迁移都有恢复点,不靠运维记得手动备份)。
      // VACUUM INTO 在线一致、连 WAL 内容一起收;:memory: 跳过。
      if (path !== ':memory:') {
        try {
          db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}.pre-v${MIGRATIONS.length}.bak'`)
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
      migrate()
    }

    // 迁移（如果跑了）已经全部提交——现在才打开运行期外键强校验，覆盖有迁移和无迁移两条
    // 路径（无迁移路径同样需要它，只是从未被上面 if 分支覆盖到）。见顶部 pragma 注释：
    // 提前打开会导致历史上"建新表→删旧表→改名"手法的 DROP TABLE（含被引用的真实外键）无法完成。
    db.pragma('foreign_keys = ON')
  } catch (err) {
    // AUDIT-02 兜底：openDb 的任何迁移/体检/PRAGMA 错误路径均在抛错前统一 close，
    // 彻底防止死锁/句柄残留妨碍修复或守护进程重启。
    try { db.close() } catch { /* 忽略重复 close */ }
    const msg = String((err as Error)?.message ?? err)
    // 兜底（非主路径）：pre-fold 老库的主拦截是迁移**之前**的版本闸（见上方 hasPreFoldFingerprint
    // 调用处），它在动迁移链前就给出人话指引。这条保留作为第二道网——专门接"指纹取不到但确实是
    // 老库"的残缺形态（例如库里只有 meta 表、series 压根不存在，指纹判据无从落脚，迁移链跑起来
    // 撞 no such table）。注意它天生只认 /no such (table|column)/ 这一种错误形状，无法覆盖列数
    // 不匹配等其它形状——这正是不能把它当主防线的原因，别再往这条正则上贴补丁。
    if (currentVersion >= 1 && currentVersion < 9 && /no such (table|column)/i.test(msg)) {
      throw new Error(
        `数据库 schema v${currentVersion} 是 de-Jellyfin 化(v9)之前的旧版本,与当前折叠后的迁移链不兼容` +
        `(底层错误：${msg})。这类开发期老库已作废——请备份后删除 scout.db(及 -wal/-shm)让程序重新` +
        `初始化,重启后会从零重扫媒体库、重新识别与找字幕。`,
      )
    }
    throw err
  }

  return db
}
