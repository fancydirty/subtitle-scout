# v2 推倒重来设计：SQLite 状态机 + 按剧调和

日期：2026-07-09
状态：执行中（用户判决驱动，方向已定，不设批准门）

## 判决书（为什么推倒而非修补）

生产审计（2026-07-09）证实：现架构把状态摊在六处（queue.json、decisions 文件缓存、
内存 cooldown、内存 skip-cache、内存 inFlight、ledger+journals），无单一事实源、无事务边界。
确诊的队头饿死、error 无退避、crash 窗口、inFlight 泄漏、全局单行道挂死，全部是这一个病的症状。
调度按"逐集 × 10 分钟"消费，对完结剧是结构性的蠢。dashboard 无库视图、无海报、无中文名、
裸 JSON、自我陈述式"监控中"徽章——视觉与逻辑双不合格。用户判决：底层重来。

**v1 保留的资产**（这些经过生产验证，原样继承）：管线判断链（identify→planSearch→search→
rank→gate→seasonPack→download→write→verify 及全部 LLM 判断点与校准）、AssrtClient（限速+缓存）、
JellyfinClient/PlayerServer、subtitleWriter、写探针、doctor、三个准确率修复（episode 中文名、
裸名查询、judgeOrphan 宽容）。**v2 重写的是状态与调度层，不是判断链。**

## 目标 / 非目标

**目标**：①单一事实源（SQLite）；②剧级作业（一部剧缺 N 集=1 个 job）；③库覆盖视图
（每剧每集 缺/有/处理中/确认无）；④调度可并发、可恢复、可解释；⑤dashboard 重做至 taste 标准。
**非目标**：多用户/权限、live SSE（轮询够用）、通知通道（M6 另立）、Plex/Emby 适配、
v1 数据迁移（状态从扫描重建，历史不搬）。

## 1. 数据库

技术：`better-sqlite3`（同步 API、事务干净；调研确认 glibc/slim 基底下 prebuilt 覆盖 amd64/arm64，
**禁用 Alpine/musl**）。库文件：`$CACHE_ROOT/scout.db`。
初始化 pragma 三件套（调研定论）：`journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`；
每日维护任务跑 `wal_checkpoint(TRUNCATE)` 防 WAL 膨胀。所有写操作走事务，写事务用 `BEGIN IMMEDIATE`。

```sql
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
```

**状态机不变量**（事务保证，测试用 property 断言）：
- 任何 job 状态迁移与其副作用记录（runs 行、episodes.sub_status 更新）同一事务。
- `done/failed/dormant` 是仅有的静止态；`searching/downloading/verifying` 必须持有效租约，
  调度器启动时与每轮开始时把过租 job 归位为 `wanted`（attempt+1）——**崩溃恢复与挂死恢复是同一条路径**。
- episodes.sub_status 只由两处写：调和扫描（对齐现实）与 job 完成事务（记录战果）。

## 2. 调和循环（替代三节拍）

单一 `reconcile()`，默认每 15 分钟 + 启动时立即 + 播放触发时对单条目即时：

1. **扫描**：getRecentItems 分页拉全库（首次全量，此后按 DateCreated 增量+每 6 小时全量对账
   ——watermark 漏网问题就此消灭），逐条目判定 sub_status（内嵌中字→embedded、外挂在盘→covered、
   国产→ignored、其余→missing），镜像入库。
2. **聚合**：对 `missing` 的 episodes 按 (series, season) 分组 → upsert `series_season` job（wanted）；
   movie 单独成 job。**一部缺 40 集的剧 = 1 个 job。**
3. **派发**：原子领取（调研定论，SQS 语义）——单条 `UPDATE jobs SET state='searching',
   lease_until=?, updated_at=? WHERE id = (SELECT id FROM jobs WHERE state='wanted'
   AND (next_retry_at IS NULL OR next_retry_at<=?) ORDER BY priority DESC, created_at ASC LIMIT 1)
   RETURNING *`，不搞先 SELECT 再 UPDATE 的两步竞态写法。
4. **level-triggered 铁律**：job 执行开始时把 `target_episodes` 从 episodes 表**重新推导**（不信任
   建 job 时的快照）——期间用户手动放了字幕/删了集，以当下现实为准。调和幂等：同一现实跑两遍
   reconcile，库中状态与 job 集合不变。

**播放触发**：轮询 Sessions（保留 15s 轻轮询，只调 getSessions 一个接口），命中缺字幕条目→
对应 job priority=100 并唤醒 dormant（等价 v1 的 bypassNegativeCache 语义，但走状态机）。

**剧级 job 执行**（继承 v1 判断链，重组编排）：解析系列中文名 → 季包搜索（裸名策略）→
pickSeasonPack/mapSeasonPack 批量映射 target_episodes → 命中集直连下载批量写盘 →
未覆盖的散集逐集兜底搜索（配额允许时）→ 全部完成置 done + 逐集更新 covered，
部分完成也提交部分战果（已写的集立即 covered），残集留在 job 重试语义里。

## 3. 并发、配额、超时

- **阶段化流水**：`searching` 全局并发 1（ASSRT 4/min 是硬约束，限速器仍在 AssrtClient）；
  `downloading`/`verifying` 并发各 2。一个剧在下载时，下一个剧可以在搜索。
- **超时全覆盖**（审计 C 轨内化）：Jellyfin 30s / ASSRT 15s / 下载 60s / LLM 120s，
  统一 `AbortSignal.timeout` 在 client 层；超时=普通失败走退避，绝无全局挂死——
  即便超时失灵，租约机制兜底。
- **退避语义**：`no_safe_match`→attempt+1 指数退避（1/2/4/8 天→dormant，unavailable 状态同步）；
  `error`（网络/LLM/5xx）→激进短退避（阶梯 30s/60s/2min/5min，封顶 15min——用户指令：网络抽风重试到好，
  封顶防撞墙），**与内容性失败分流**（审计 B 轨 Critical#2）。partial 部分成功带 30s 节流窗后立即续跑。
  借鉴 Sonarr escalation-level：部分成功（写了几集但没写完）时 attempt **减 1 而非清零**——
  渐进恢复，防止半好半坏的源反复满血重试。Bazarr 的静态 10 分钟全局冷却是已证实的反模式（
  其社区大量 "All providers are throttled" 投诉），不学。
- 不再有独立 cooldown/skip-cache/负缓存三层——全部由 sub_status + next_retry_at 表达。
  ASSRT 响应缓存（24h 文件缓存）保留，那是 API 层的事。

## 4. Dashboard v2（媒体库形态——2026-07-10 定稿，用户判决"设计成媒体库的形式"）

**设计读法**（taste skill 0.B）：自托管媒体库仪表盘，单个重度用户，暗色 premium 语系
（#0C0D0F + teal #2DD4BF 既有体系），Jellyfin 相邻的海报墙 UI。
拨盘：VARIANCE 4 / MOTION 3 / DENSITY 6（库浏览器天然密，海报即内容）。

**信息架构（三层）**：
1. **首页 = 海报墙**（默认视图，像打开 Jellyfin）：
   - 顶栏：品牌字标 + 一句事实（如"12 部待补 · 2 部处理中"）+ 过滤 tabs（全部/缺字幕/处理中/已完成）。
     一切自我陈述式徽章（"监控中"等）死刑。
   - 海报网格：series+movies 混排（或分区），每张海报=真实 Jellyfin Primary 图（经 daemon 代理）。
   - **覆盖徽章**：海报右下角一枚状态徽章——全覆盖=teal 勾；部分=分数（如 3/9）；
     处理中=teal 脉冲点（唯一允许的动效点，语义=真实在跑）；确认无=灰色"暂无"。
     内嵌中字的剧不在"缺字幕"过滤下出现（它们不需要 scout）。
2. **剧详情**（点海报进入）：海报大图+中文名（chinese_title 优先，fallback 刮削名）+年份 →
   按季分节的**集覆盖格子**（每集一格：teal=covered/暗灰=embedded/描边空格=missing/
   脉冲=job 进行中/深灰叉=unavailable，hover tooltip 显示人话原因与复查时间）→
   该剧 runs 时间线（detail 人话摘要，一行一次运行，可展开结构化步骤卡——裸 JSON 死刑）。
3. **全局历史页**：runs 表分页，最近优先。

**数据与 API**（daemon 内新端点组，读 SQLite）：
- `GET /api/v2/library`：series+movies 列表带覆盖聚合（covered/missing/embedded/unavailable 计数、
  active job 状态、chinese_title、poster_tag）
- `GET /api/v2/series/:id`：分季集清单+runs
- `GET /api/v2/runs?page=`：历史
- `GET /api/poster/:itemId`：Jellyfin Primary 图代理（API key 不出后端；磁盘缓存 + immutable cache 头）
- 依赖的数据补齐：scanner 捕获 poster_tag（episode 的 SeriesPrimaryImageTag→series 行，
  movie 的 ImageTags.Primary）；chinese_title 在 job 执行解析到时写回 series/movies 行。

**taste 红线**（自 design-taste-frontend，dashboard 适用子集，Pre-Flight 必查）：
零 em-dash；单一主题锁定（全暗，无节間反转）；单一 accent（teal，锁全页）；圆角制一套
（海报 8px/徽章 pill，成文即锁）；零装饰性状态点（脉冲点仅在真实 in-flight）；零 section 编号
眉标；文案冷峻（延续 v1 dashboard 文案家规：零内部黑话、无 AI 腔）；空/加载/错误三态齐
（骨架屏=海报形状占位，非转圈）；图标一族（Phosphor）；真实海报即"真实图片"要求的满足。
**视觉稿先过 visual companion 由用户过目，前端代码后行。**

**信息架构**（数据全部来自 SQLite，API 层薄查询）：
- **库视图（首页）**：每剧一行——海报（daemon 代理 `/api/poster/:id` 转 Jellyfin Primary 图，
  API key 不出后端）+ 中文名优先标题 + 集覆盖格子图（绿=covered/深灰=embedded/浅灰=missing/
  黄脉冲=job 进行中/红叉=unavailable 带人话原因 tooltip）+ 电影区同构卡片。
- **剧详情**：格子图放大 + 该剧 runs 时间线（detail 人话摘要），"原始细节"折叠为结构化步骤卡
  （每步：做了什么/结果/耗时），LLM 的英文 reason 由 detail 字段落库时翻译成中文——**裸 JSON 死刑**。
- **运行历史页**：runs 表分页。
- **顶栏**：只留身份与一个数字事实（如"本周补齐 N 部"）。"监控中"徽章及一切自我陈述式文案死刑。
**工程备注（一期审查遗留）**：dashboard API 若以独立进程/第二写连接接 DB，jobsRepo 三处
读改写事务须改 `.immediate()`；上线后任何 DDL 变更必须走新迁移版本（一期前可直接改 v1 DDL）。
**视觉**：动工前通读 `design-taste-frontend` skill 为硬性前置步骤；延续暗色 #0C0D0F + teal 体系；
设计稿经 visual companion 过目后才写前端代码。文案冷峻规范继续生效。

## 5. 上线与验收

- 无双轨：新 daemon 直接替换 watcher/queue；旧 queue.json/decisions/ledger 废弃（读也不读）。
- **验收仪式**（=用户要求的环境重置，此前生产零接触）：备份并删除 NAS 全部字幕 sidecar →
  清 scout 状态 → Jellyfin 全库重扫 → 起 v2 → 看首次 reconcile 全库镜像入库 → 按剧聚合 →
  剧级 job 批量补齐 → 库视图格子从灰变绿。验收标准：《小谢尔顿》级别的完结剧在**一个 job**
  内完成可得字幕的批量覆盖；dashboard 库视图与 NAS 实盘一致；kill -9 后重启无状态丢失、
  过租 job 自动归位。
- doctor 增加第 6 项：数据库可写与 schema 版本；第 7 项：卡死 job 检测（过租 job 计数，
  借鉴 Sonarr Health Check 分类法）。
- 崩溃恢复测试、状态机不变量测试、调和幂等测试（同一现实跑两次 reconcile 结果一致）为必备测试面。

## 实现顺序（供 writing-plans 展开）

DB 层与 schema（含迁移器）→ 状态机核心（jobs 领取/租约/退避，property 测试）→
调和扫描与聚合 → 剧级 job 执行器（重组 v1 管线调用）→ 播放触发接入 → 超时全覆盖 →
新 daemon 主循环替换 → dashboard API → dashboard UI（taste 前置）→ doctor 扩展 →
崩溃/幂等测试 → 真机验收仪式。
