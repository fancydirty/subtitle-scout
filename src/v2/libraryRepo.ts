import type { ScoutDb } from './db.js'

export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored' | 'hardsub-assumed'

/** R-3（裁决 2026-07-16）：item 级内容退避阶梯。worker 判"本轮搜索穷尽"（no_safe_match）后，
 *  该 item 的重现节奏按自身 search_attempts 递增：1/2/4/8 天，第 5 次起 30 天封顶——只是
 *  越来越慢，永不隐形、永无死刑（对照已处决的 jobs 侧 dormant 判决）。 */
export const ITEM_CONTENT_BACKOFF_DAYS = [1, 2, 4, 8]
export const ITEM_BACKOFF_CAP_DAYS = 30

export interface SeriesParams {
  id: string
  name: string
  chineseTitle?: string | null
  posterPath?: string | null
  /** 详情页重设计 item B：TMDB 剧集简介 / hero 背景大图路径。undefined/null→NULL 绑定，
   *  ON CONFLICT 分支 COALESCE 保护既有值不被后续无值的重复调用清空（同 posterPath 语义）。 */
  overview?: string | null
  backdropPath?: string | null
  year?: number | null
  providerIds?: string | null // JSON
  /** 验收修复轮一 Task V1（design §A）：TMDB genre id 集合（如 [16,35]）。有值→JSON.stringify
   *  落库；undefined/null→NULL（不清空既有 genres，同 chineseTitle/posterPath 的既有 COALESCE
   *  语义——见 upsertSeries 实现，"未富化过"与"本次调用没给"两件事都用 SQL NULL 表示，不冲突：
   *  ingest 首次入库才可能真的给出 genres，后续每轮重跑 upsertSeries 不重新查 TMDB，传 undefined
   *  即可，既有值原样保留）。 */
  genres?: number[] | null
  /** Plan B Task 1: TMDB original_language（schema v14）。undefined/null→NULL 绑定，同 genres
   *  的 COALESCE 语义（不清空既有值）。 */
  originLang?: string | null
}

export interface EpisodeParams {
  id: string
  seriesId: string
  season: number
  episode: number
  name: string
  path: string
  subStatus: SubStatus
}

export interface MovieParams {
  id: string
  name: string
  path: string
  subStatus: SubStatus
  chineseTitle?: string | null
  posterPath?: string | null
  year?: number | null
  providerIds?: string | null // JSON
  /** Plan B Task 1: TMDB original_language（schema v14）。undefined/null→NULL 绑定，同
   *  chineseTitle/posterPath 的 COALESCE 语义（不清空既有值）。 */
  originLang?: string | null
}

export interface Episode {
  id: string
  series_id: string
  season: number
  episode: number
  name: string | null
  path: string
  sub_status: SubStatus
  status_reason: string | null
  recheck_after: number | null
  updated_at: number
  /** 胶水层修复（2026-07-16，schema v10）：item 级内容退避阶梯计数（裁决 R-3）。 */
  search_attempts: number
}

export interface Movie {
  id: string
  name: string
  chinese_title: string | null
  poster_path: string | null
  year: number | null
  path: string
  provider_ids: string | null
  sub_status: SubStatus
  status_reason: string | null
  recheck_after: number | null
  updated_at: number
  /** 胶水层修复（2026-07-16，schema v10）：item 级内容退避阶梯计数（裁决 R-3）。 */
  search_attempts: number
}

/** 胶水层修复（Task 8c，裁决 R-3 呈现面）：一季的覆盖事实行——不再是纯计数，退避窗口内的
 *  停牌缺口不再整行隐形。missing=现在该找的（missing ∪ 到期 unavailable），
 *  throttled=停牌中的（未到期 unavailable，之前被 SQL 谓词整行吃掉的那部分事实）。
 *  next_recheck_at/sample_reason 让 orchestrator 能看到"停牌到几时、为什么"——判断"这行
 *  值不值得提前重派"是 orchestrator 的事，机械层只负责把事实摆出来，不再替它做隐藏决定。 */
export interface MissingBySeason {
  series_id: string
  series_name: string
  season: number
  missing: number
  throttled: number
  next_recheck_at: number | null
  sample_reason: string | null
}

/** missingMovies 的行形状——missingBySeason 的电影同构版（电影没有"季"，所以是逐行事实而非
 *  分组聚合，但同一套 missing/throttled/next_recheck_at/sample_reason 语义）。 */
export interface MissingMovie {
  id: string
  name: string
  missing: 0 | 1
  throttled: 0 | 1
  next_recheck_at: number | null
  sample_reason: string | null
}

/** 胶水层修复（2026-07-16）：listMissingEpisodesInSeason 的行形状——一条缺口事实（不是聚合计数）。 */
export interface MissingEpisodeFact {
  id: string
  path: string
  season: number
  episode: number
}

export interface Series {
  id: string
  name: string
  chinese_title: string | null
  chinese_title_checked_at: number | null
  poster_path: string | null
  year: number | null
  provider_ids: string | null
  origin_lang: string | null
  /** 胶水层修复（2026-07-16，schema v10）：摄取层观察到的"磁盘布局不合规范形"series 级事实
   *  （债务 D1，realign 出生信号之一）。 */
  layout_nonstandard: number
  /** 验收修复轮一 Task V1（design §A，schema v13）：TMDB genre id 的 JSON 数组字符串（如
   *  '[16,35]'）；NULL=尚未富化。dashboard sectionOf 新规读它判"动漫（含 16）vs 剧集"。 */
  genres: string | null
}

// ---- P2 新面：parked_paths / probe memo（去 Jellyfin 化 schema v9；identify_overrides
// 曾同批出生，已随认领退役 DROP——见 db.ts 尾部迁移） ----

/** park 原因的权威值域。列本身是自由文本；本战役新增/触及的判定逻辑一律用这些常量。
 *  历史散落的裸字符串（recognition 层的 'no-signal'、ingest 的 'awaiting-agent-identification'
 *  等）尚未全量迁移——它们分布在多个"圣文件"里，收敛留到有理由动那些文件时再做，不在本
 *  战役范围（migration 前不为纯改名触碰识别核心）。 */
export const PARK_REASON = {
  awaitingAgent: 'awaiting-agent-identification',
  insufficientEvidence: 'insufficient-evidence',
  identificationFailed: 'identification-failed',
  excludedExtra: 'excluded-extra',
  duplicateContent: 'duplicate-content',
  noSignal: 'no-signal',
} as const

export interface ParkedPath {
  path: string
  park_reason: string
  first_seen: number
  last_attempt: number
  /** 已完成的退避阶数：0=刚 park（下次 1h），1=下次 4h，≥2=下次 24h。 */
  retry_count: number
  /** 下次可重试时刻（ms）；NULL/缺省视为立即 eligible。 */
  next_retry_at: number | null
  probe_mtime: number | null
  probe_size: number | null
  /** 探测时长（秒）；NULL=未探测。agent 从 parked_paths 读取做识别的 raw 数据（schema v25）。 */
  duration_sec: number | null
  /** 原始 ffprobe 语言 tag 的 JSON 数组串（如 '["eng","chi"]'，与 episodes/movies.embedded_langs 同构）；NULL=未探测。 */
  embedded_langs: string | null
  /** 路径里的 `[tmdbid-N]` 标签（schema v26）。NULL=路径无标签（绝大多数情况）。
   *  来源：本项目 buildTargetShowDir 的规范布局 或 外部整理工具（*arr 生态）。
   *  hint 不是判决——agent 仍须 TMDB 核验后才能认领。 */
  embedded_tmdb_id: string | null
}

/** parked-path 负缓存：文件指纹（stat mtimeMs + size）+ 可选探测 raw 数据（duration/内嵌轨语言）。
 *  durationSec/embeddedLangs 省略（undefined）= 本次未探测，指纹未变时保留库中已有值；
 *  embeddedLangs 空数组与省略同义（存 NULL，不落 '[]'）。
 *  embeddedTmdbId 省略同理保留（指纹未变时）——它来自路径解析（identifyFromPath 的
 *  TMDB_ID_PATTERN），park 分支不带该字段时传 undefined，"NULL = 路径无标签"由此守住。 */
export interface ParkedPathFingerprint {
  mtimeMs: number
  size: number
  durationSec?: number
  embeddedLangs?: string[]
  embeddedTmdbId?: string | null
}

/** 退避阶梯：retry_count 0→1h，1→4h，≥2→24h（封顶）。单位 ms。 */
const PARKED_RETRY_DELAYS_MS = [
  60 * 60 * 1000, // 1h after first park
  4 * 60 * 60 * 1000, // 4h after first retry
  24 * 60 * 60 * 1000, // 24h thereafter
] as const

function parkedRetryDelayMs(retryCount: number): number {
  if (retryCount <= 0) return PARKED_RETRY_DELAYS_MS[0]
  if (retryCount === 1) return PARKED_RETRY_DELAYS_MS[1]
  return PARKED_RETRY_DELAYS_MS[2]
}

/** 重复源 P1：item_files 行——同一条目（episodes.id/movies.id）的副本文件（4K/1080p/不同压制）。
 *  主文件在 episodes/movies.path（身份锚），不进此表。 */
export interface ItemFile {
  id: number
  item_id: string
  path: string
  added_at: number
}

/** 重复源 P3：逐文件覆盖事实（itemFileCoverage 返回项）。isMain=是否主文件（其余为副本）；
 *  covered=该文件是否已有字幕着落（主文件看 sub_status，副本看 subtitles.file_path）。 */
export interface ItemFileCoverage {
  path: string
  isMain: boolean
  covered: boolean
}

export interface ProbeMemo {
  mtime: number
  size: number
  langs: string[] | null
}

/** B3-4（专项#1，schema v17）：一份文件的判决指纹快照（mtimeMs+size，同 ProbeMemo 的既有形状,
 *  这里不复用 ProbeMemo 本身——语义不同，这个快照只服务"文件是否变了"的判断，不带 langs）。 */
export interface FileFingerprint {
  mtimeMs: number
  size: number
}

/** 一次时长判决发生时刻，主文件与副本文件各自的指纹快照——item_files.verdict_fingerprint 的
 *  JSON 形状。 */
export interface VerdictFingerprint {
  main: FileFingerprint
  replica: FileFingerprint
}

export class LibraryRepo {
  readonly db: ScoutDb

  constructor(db: ScoutDb) {
    this.db = db
  }

  /** ⚠️ 第 7 步 C 组（2/2）：**本方法（及下方 upsertEpisode/upsertMovie）已无任何生产调用方**。
   *  唯一的生产写入方是 agent 的 write_identified_media 工具（原 agent/identityTools.ts），
   *  本组已将其整体删除——它是 series/episodes/movies 三张旧表最后的 INSERT 路径，而它整条
   *  上游链自第 2 步切换生产入口（cmdWatch → ScoutDaemonV2）起就不可达。
   *
   *  今天还在调它的只有 src/testing/seedBacklog.ts（测试 fixture 助手）与各测试文件。刻意
   *  保留而不删方法体：dashboard 的海报墙/详情页仍在**读**这三张表（HTTP 端点 + 15 秒轮询的
   *  React 组件），那些端点的测试必须能给旧表填行——删掉造数据的手，等于删掉活功能的测试
   *  验证能力。旧表本身也不能删（删表是功能迁移，不是死代码清理）。
   *
   *  因此本组交付的结构性保证精确表述为：**旧表在生产代码里已零写入方**（不是"SQL 已从仓里
   *  消失"）。日后若有人给这三个方法新接一个生产调用方，那就是在给一组只读的遗留表重新
   *  开写口——请先确认那不是应该写进 works/files 两张新表的东西。 */
  upsertSeries(params: SeriesParams): void {
    const posterPath = params.posterPath ?? null
    // 验收修复轮一 Task V1：genres 有值才 JSON.stringify，无值（undefined/null）→ NULL 绑定，
    // ON CONFLICT 分支用 COALESCE 保护既有值不被后续无 genres 的重复调用清空（同
    // chineseTitle/posterPath 的既有语义）。
    // name 的 CASE：空串是"从未识别成功过"的占位语义（同 applyEnrichment 的 name CASE）——
    // claim-gated 分支的 title 恒 ''，该剧每来一集新文件都带着空名重新 upsert，绝不能拿占位
    // 覆盖一个已治好的真名。WHERE 里的 excluded.name != '' 同步豁免：占位入参不算 name 变更。
    const genresJson = params.genres != null ? JSON.stringify(params.genres) : null
    const overview = params.overview ?? null
    const backdropPath = params.backdropPath ?? null
    const originLang = params.originLang ?? null
    this.db
      .prepare(
        `INSERT INTO series (id, name, chinese_title, poster_path, overview, backdrop_path, year, provider_ids, genres, origin_lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = CASE WHEN excluded.name = '' THEN name ELSE excluded.name END,
           chinese_title = COALESCE(excluded.chinese_title, chinese_title),
           poster_path = COALESCE(excluded.poster_path, poster_path),
           overview = COALESCE(excluded.overview, overview),
           backdrop_path = COALESCE(excluded.backdrop_path, backdrop_path),
           year = excluded.year,
           provider_ids = excluded.provider_ids,
           genres = COALESCE(excluded.genres, genres),
           origin_lang = COALESCE(excluded.origin_lang, origin_lang)
         WHERE (excluded.name != '' AND name != excluded.name)
            OR (excluded.chinese_title IS NOT NULL AND chinese_title IS NOT excluded.chinese_title)
            OR (excluded.poster_path IS NOT NULL AND poster_path IS NOT excluded.poster_path)
            OR (excluded.overview IS NOT NULL AND overview IS NOT excluded.overview)
            OR (excluded.backdrop_path IS NOT NULL AND backdrop_path IS NOT excluded.backdrop_path)
            OR year IS NOT excluded.year
            OR provider_ids IS NOT excluded.provider_ids
            OR (excluded.genres IS NOT NULL AND genres IS NOT excluded.genres)
            OR (excluded.origin_lang IS NOT NULL AND origin_lang IS NOT excluded.origin_lang)`
      )
      .run(
        params.id,
        params.name,
        params.chineseTitle ?? null,
        posterPath,
        overview,
        backdropPath,
        params.year ?? null,
        params.providerIds ?? null,
        genresJson,
        originLang
      )
  }

  /** 富化重试机制的候选清单（验收修复轮一 Task V1，design §A，一石二鸟）：genres 尚未富化
   *  （NULL——存量剧 + getDetails 抖动失败的剧）即候选；空名占位建行时 genres 必为 NULL，同样
   *  落网。genres 非 NULL 即"TMDB 已给过权威答复"——此时 name 仍为空只剩确定性无解形态
   *  （404 → genres=[]，或查无标题），重试必然拿到同一答案：定论即熄火（债务D6 收尾——旧谓词
   *  的 name='' 臂让 404 行永留候选，每轮空转烧 3 个 TMDB 请求并挤占 cap 槽）。可治愈的空名
   *  （建行时 getDetails 成功）已由建行当场回填 originalTitle 兜住（ingest.ts），不经过这里。
   *  limit 由调用方传 cap（ingest.ts pass 收尾每轮传 10，防 TMDB 抖动期连环空转拖垮整轮 pass）。 */
  listSeriesNeedingEnrich(limit: number): { id: string }[] {
    // 详情页重设计 item B（db.ts v16 迁移）：series.overview/backdrop_path 后加两列，存量
    // 已富化剧（genres 早已非 NULL）这两列恒 NULL——迁移注释假定"series 层靠既有富化重试 pass
    // 连带补齐"，但旧谓词只认 genres IS NULL 接不住它们。放宽第二臂 overview IS NULL 把它们
    // 拉回候选一次性回填；自熄火——overview 一旦落值即脱离该臂，不会 re-enrich 风暴。
    // 护栏 name != ''：第二臂只捞真名剧。空名占位（P6 认领债务 / 404 死 id，genres 已落 []
    // 但 overview 永远拿不到）绝不能经 overview 臂永留候选空转烧 TMDB 配额（复活债务D6 的
    // 熄火不变式——空名死 id 只能经 genres IS NULL 臂进候选、拿到 genres=[] 定论后彻底熄火）。
    return this.db
      .prepare(`SELECT id FROM series WHERE genres IS NULL OR (overview IS NULL AND name != '') LIMIT ?`)
      .all(limit) as { id: string }[]
  }

  /** 富化重试的落笔处（验收修复轮一 Task V1，design §A）——宁可不写不可覆盖：这是"回填"，
   *  不是"覆盖"，任何字段只在当前列真的缺失时才被本次给出的新值填上，绝不用新值覆盖一个
   *  已经有效的旧值（哪怕旧值本身就是这次 enrich 想改进的东西——那不是这个方法的职责，
   *  改身份走 agent 的 write_identified_media）。
   *  - name：只在当前是空串且本次给出非 null 新值时才写（CASE 手法）——空串是"从未识别成功
   *    过"的占位语义（历史 P6 override 写入时的空名占位），非空 name 不会被这里改写。
   *  - chinese_title/poster_path/year/genres：COALESCE(现列, 新值)——现列非 NULL 就原样保留，
   *    现列 NULL 才落新值。调用方给的字段用 undefined/null 表示"这次没查到"，转成 SQL NULL，
   *    COALESCE 对它是 no-op，天然满足"没查到就不动"。 */
  applyEnrichment(
    id: string,
    e: {
      name?: string | null
      chineseTitle?: string | null
      posterPath?: string | null
      overview?: string | null
      backdropPath?: string | null
      year?: number | null
      genres?: number[] | null
      providerIds?: string | null
    }
  ): void {
    const genresJson = e.genres != null ? JSON.stringify(e.genres) : null
    this.db
      .prepare(
        // overview/backdrop_path（详情页重设计 item B）随 poster/genres 同一套"宁可不写不可覆盖"
        // COALESCE 手法回填——存量已富化剧经放宽后的 listSeriesNeedingEnrich 谓词重入候选后，
        // 由这里把 getDetails 拿到的 overview/backdrop 落进原本 NULL 的两列（现列非 NULL 则保留）。
        `UPDATE series SET
           name = CASE WHEN name = '' AND @name IS NOT NULL THEN @name ELSE name END,
           chinese_title = COALESCE(chinese_title, @chineseTitle),
           poster_path = COALESCE(poster_path, @posterPath),
           overview = COALESCE(overview, @overview),
           backdrop_path = COALESCE(backdrop_path, @backdropPath),
           year = COALESCE(year, @year),
           genres = COALESCE(genres, @genres),
           provider_ids = COALESCE(@providerIds, provider_ids)
         WHERE id = @id`
      )
      .run({
        id,
        name: e.name ?? null,
        chineseTitle: e.chineseTitle ?? null,
        posterPath: e.posterPath ?? null,
        overview: e.overview ?? null,
        backdropPath: e.backdropPath ?? null,
        year: e.year ?? null,
        genres: genresJson,
        providerIds: e.providerIds ?? null,
      })
  }

  /** F-R2-6（R2 复审，审计定罪：ingest 覆盖路径绕过阶梯归零，R-3 不变式）：ON CONFLICT 分支的
   *  search_attempts CASE——excluded.sub_status（本次要写入的新状态）落在 covered/embedded 时
   *  归零，否则保持原值不动。这是 ingest 的 FULL PATH（新识别/probeMemo 过期，见 ingest.ts）
   *  写入 covered/embedded 的落点：INSERT（新行）本就默认 0（db.ts schema default），只有
   *  UPDATE（已存在的行，例如此前是 unavailable/missing）需要这条 CASE 主动归零。 */
  /** 生产零调用方——见 upsertSeries 头注释（第 7 步 C 组）。 */
  upsertEpisode(params: EpisodeParams): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           series_id = excluded.series_id,
           season = excluded.season,
           episode = excluded.episode,
           name = excluded.name,
           path = excluded.path,
           sub_status = excluded.sub_status,
           search_attempts = CASE WHEN excluded.sub_status IN ('covered', 'embedded') THEN 0 ELSE search_attempts END,
           updated_at = excluded.updated_at
         WHERE series_id != excluded.series_id
            OR season != excluded.season
            OR episode != excluded.episode
            OR name IS NOT excluded.name
            OR path != excluded.path
            OR sub_status != excluded.sub_status`
      )
      .run(
        params.id,
        params.seriesId,
        params.season,
        params.episode,
        params.name,
        params.path,
        params.subStatus,
        now
      )
  }

  /** F-R2-6（R2 复审，审计定罪：ingest 覆盖路径绕过阶梯归零，R-3 不变式）：同 upsertEpisode 的
   *  search_attempts CASE——见该方法头注释。 */
  /** 生产零调用方——见 upsertSeries 头注释（第 7 步 C 组）。 */
  upsertMovie(params: MovieParams): void {
    const now = Date.now()
    const posterPath = params.posterPath ?? null
    const originLang = params.originLang ?? null
    this.db
      .prepare(
        `INSERT INTO movies (id, name, path, sub_status, chinese_title, poster_path, year, provider_ids, origin_lang, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           sub_status = excluded.sub_status,
           search_attempts = CASE WHEN excluded.sub_status IN ('covered', 'embedded') THEN 0 ELSE search_attempts END,
           chinese_title = COALESCE(excluded.chinese_title, chinese_title),
           poster_path = COALESCE(excluded.poster_path, poster_path),
           year = excluded.year,
           provider_ids = excluded.provider_ids,
           origin_lang = COALESCE(excluded.origin_lang, origin_lang),
           updated_at = excluded.updated_at
         WHERE name != excluded.name
            OR path != excluded.path
            OR sub_status != excluded.sub_status
            OR (excluded.chinese_title IS NOT NULL AND chinese_title IS NOT excluded.chinese_title)
            OR (excluded.poster_path IS NOT NULL AND poster_path IS NOT excluded.poster_path)
            OR year IS NOT excluded.year
            OR provider_ids IS NOT excluded.provider_ids
            OR (excluded.origin_lang IS NOT NULL AND origin_lang IS NOT excluded.origin_lang)`
      )
      .run(
        params.id,
        params.name,
        params.path,
        params.subStatus,
        params.chineseTitle ?? null,
        posterPath,
        params.year ?? null,
        params.providerIds ?? null,
        originLang,
        now
      )
  }

  getEpisode(id: string): Episode | null {
    const row = this.db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(id) as
      | Episode
      | undefined
    return row ?? null
  }

  getMovie(id: string): Movie | null {
    const row = this.db.prepare(`SELECT * FROM movies WHERE id = ?`).get(id) as Movie | undefined
    return row ?? null
  }

  getSeries(id: string): Series | null {
    const row = this.db.prepare(`SELECT * FROM series WHERE id = ?`).get(id) as Series | undefined
    return row ?? null
  }

  /** 该剧该季在镜像里的集数。（历史注释提到的 core/seasonShape.ts 的
   *  SeasonShape.mirrorEpisodeCount 侧、以及它的消费方 v3 orchestratorAgent.tools.ts，
   *  均已删除——前者本轮随死代码清理退役，后者早于旧管线退役时删除。此处只留本方法自身
   *  的语义说明，不再指向已不存在的模块。） */
  countEpisodesInSeason(seriesId: string, season: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM episodes WHERE series_id = ? AND season = ?`)
      .get(seriesId, season) as { count: number }
    return row.count
  }

  /** 该剧镜像里全部集的路径（跨季）——realignExecutor 据此推导出实际需要整理的磁盘目录
   *  （绝对编号平铺库通常全部塞在同一个被误刮成"Season 01"的目录里）。 */
  episodePathsForSeries(seriesId: string): string[] {
    return (this.db.prepare(`SELECT path FROM episodes WHERE series_id = ?`).all(seriesId) as { path: string }[])
      .map(r => r.path)
  }

  /** realign 收尾清旧 seriesId 下的 episodes/subtitles/series 行。
   *
   *  ⚠️ 数据腐蚀根因修复(2026-07-19,两路审计交叉确认 SEVERE):必须同时清 item_files。
   *  去 Jellyfin 后 seriesId 由 tmdb id 稳定派生(ownIds.ts),realign 收尾的 refreshLibrary→ingest
   *  会用**同一个 seriesId** 重识别整理好的新目录;与旧编号重叠的集触发 own-id 幂等副本分支,把新
   *  文件登记成旧行的 item_files 副本。若此处只删 episodes 不删 item_files,那些副本就成了 owner
   *  已删的孤儿——下一轮 ingest 的 B3-3 短路命中孤儿 path、ownerPath 为 null → continue,该路径
   *  **永远不再被重识别成 episode 行**,盘上有视频有字幕却从库里永久消失,非自愈。旧注释假设的
   *  "Jellyfin 重刮换新 SeriesId"不变式在去 Jellyfin 后已失效,故旧代码漏删 item_files 从良性变致命。
   *  subtitles/item_files 均未声明外键到 episodes(id),但同属一份账目,一并清理保持镜像干净。 */
  deleteSeriesRows(seriesId: string): void {
    const tx = this.db.transaction(() => {
      const episodeIds = this.db.prepare(`SELECT id FROM episodes WHERE series_id = ?`).all(seriesId) as { id: string }[]
      const delSub = this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`)
      const delItemFiles = this.db.prepare(`DELETE FROM item_files WHERE item_id = ?`)
      for (const e of episodeIds) { delSub.run(e.id); delItemFiles.run(e.id) }
      this.db.prepare(`DELETE FROM episodes WHERE series_id = ?`).run(seriesId)
      this.db.prepare(`DELETE FROM series WHERE id = ?`).run(seriesId)
    })
    tx()
  }

  /** TMDB original_language 缓存读取；NULL=未解析过。 */
  getSeriesOriginLang(seriesId: string): string | null {
    const row = this.db.prepare('SELECT origin_lang FROM series WHERE id = ?').get(seriesId) as
      | { origin_lang: string | null }
      | undefined
    return row?.origin_lang ?? null
  }

  /** TMDB original_language 缓存读取；NULL=未解析过。 */
  getMovieOriginLang(movieId: string): string | null {
    const row = this.db.prepare('SELECT origin_lang FROM movies WHERE id = ?').get(movieId) as
      | { origin_lang: string | null }
      | undefined
    return row?.origin_lang ?? null
  }

  /** 解析到 TMDB original_language 后写回，之后不再回查。 */
  setSeriesOriginLang(seriesId: string, lang: string): void {
    this.db.prepare('UPDATE series SET origin_lang = ? WHERE id = ?').run(lang, seriesId)
  }

  /** 解析到 TMDB original_language 后写回，之后不再回查。 */
  setMovieOriginLang(movieId: string, lang: string): void {
    this.db.prepare('UPDATE movies SET origin_lang = ? WHERE id = ?').run(lang, movieId)
  }

  /** 债务D1：摄取层每轮 pass 结束时写回的磁盘布局事实（1=本轮观察到任一集路径不合规范形）。 */
  setSeriesLayoutNonstandard(seriesId: string, nonstandard: boolean): void {
    this.db.prepare('UPDATE series SET layout_nonstandard = ? WHERE id = ?').run(nonstandard ? 1 : 0, seriesId)
  }

  /** 胶水层修复（Task 8c，裁决 R-3 呈现面——考古定罪：谓词曾是守门人，把退避窗口内的停牌缺口
   *  整行隐藏，orchestrator 连"有一集停牌中"这个事实都看不到）：一季的覆盖事实行，missing 与
   *  throttled 分开呈报，不再用 WHERE 谓词把 throttled 的整行吃掉——HAVING missing>0 OR
   *  throttled>0 只是"完全没缺口的季不出现"（无事实可报，不是隐藏事实）。JOIN series 拿
   *  series_name，消费者不必再自己二次查剧名。消费者是 v3 orchestrator 的 list_missing_coverage
   *  工具（orchestratorAgent.tools.ts），旧管线的聚合层（原 v2/aggregate 模块）已随退役T7
   *  (Wave 2A) 删除。 */
  missingBySeason(now?: number): MissingBySeason[] {
    const timestamp = now ?? Date.now()
    return this.db
      .prepare(
        `SELECT e.series_id, s.name AS series_name, e.season,
           SUM(CASE WHEN e.sub_status = 'missing' OR (e.sub_status = 'unavailable' AND e.recheck_after <= ?) THEN 1 ELSE 0 END) AS missing,
           SUM(CASE WHEN e.sub_status = 'unavailable' AND e.recheck_after > ? THEN 1 ELSE 0 END) AS throttled,
           MIN(CASE WHEN e.sub_status = 'unavailable' AND e.recheck_after > ? THEN e.recheck_after END) AS next_recheck_at,
           MAX(CASE WHEN e.sub_status = 'unavailable' THEN e.status_reason END) AS sample_reason
         FROM episodes e JOIN series s ON s.id = e.series_id
         GROUP BY e.series_id, e.season
         HAVING missing > 0 OR throttled > 0`
      )
      .all(timestamp, timestamp, timestamp) as MissingBySeason[]
  }

  /** 胶水层修复（2026-07-16）：某剧某季当前全部缺口的事实清单。机械预清洗产物，呈事实不做
   *  选择——ORDER BY episode 是清单排序，不是执行顺序指令（顺序决策归 worker/orchestrator）。
   *  谓词与 missingBySeason 完全一致。 */
  listMissingEpisodesInSeason(seriesId: string, season: number, now: number): MissingEpisodeFact[] {
    return this.db
      .prepare(
        `SELECT id, path, season, episode FROM episodes
         WHERE series_id = ? AND season = ?
         AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))
         ORDER BY episode ASC`
      )
      .all(seriesId, season, now) as MissingEpisodeFact[]
  }

  /** R-11（用户裁决 2026-07-16）：全剧（或季子集）缺口事实清单——派活范围不再是系统常量，是主
   *  代理按刮削出的磁盘事实自行裁量后经 payload.seasons 下发（数组=季子集，null=全剧）。谓词与
   *  listMissingEpisodesInSeason 基本一致，只是不强制单季；ORDER BY season, episode 是清单
   *  排序，不是执行顺序指令（同 listMissingEpisodesInSeason 的既有措辞）。
   *
   *  F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：新增第 4 参 includeThrottled（默认
   *  false，向后兼容既有调用点）。orchestratorSkill 早就教"re-dispatching a throttled-only row
   *  is YOUR call for a genuinely changed situation"，但这条谓词此前无条件要求
   *  recheck_after <= now——orchestrator 判断"该提前重查"之后，事实清单本身还是把停牌中的行
   *  整行滤掉，模型的判断没有实现它的管道。includeThrottled=true 时谓词放宽为
   *  sub_status IN ('missing','unavailable')，不再看 recheck_after；false（默认）时谓词与此前
   *  完全一致，既有窗口语义锁不变。 */
  listMissingEpisodesForSeries(
    seriesId: string, seasons: number[] | null, now: number, includeThrottled: boolean = false,
  ): MissingEpisodeFact[] {
    const seasonFilter = seasons && seasons.length > 0 ? `AND season IN (${seasons.map(() => '?').join(',')})` : ''
    const statusFilter = includeThrottled
      ? `AND (sub_status = 'missing' OR sub_status = 'unavailable')`
      : `AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))`
    const seasonParams = seasons && seasons.length > 0 ? seasons : []
    const params = includeThrottled ? [seriesId, ...seasonParams] : [seriesId, ...seasonParams, now]
    return this.db
      .prepare(
        `SELECT id, path, season, episode FROM episodes
         WHERE series_id = ? ${seasonFilter}
         ${statusFilter}
         ORDER BY season ASC, episode ASC`
      )
      .all(...params) as MissingEpisodeFact[]
  }

  /** missingBySeason 的电影同构版（同一裁决 R-3 呈现面）——电影没有"季"可分组，行形状从整
   *  Movie 行改为覆盖事实行：missing/throttled 是 0|1（电影本身就是一行，不是聚合计数），
   *  语义与 missingBySeason 完全一致。WHERE 只筛掉 covered/embedded/ignored（对两个事实
   *  字段都恒为 0，没有可报的缺口事实），不是把 throttled 藏起来——一行只要落在
   *  missing/unavailable 状态里，missing 与 throttled 两者必有其一为 1。 */
  missingMovies(now?: number): MissingMovie[] {
    const timestamp = now ?? Date.now()
    return this.db
      .prepare(
        `SELECT id, name,
           CASE WHEN sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?) THEN 1 ELSE 0 END AS missing,
           CASE WHEN sub_status = 'unavailable' AND recheck_after > ? THEN 1 ELSE 0 END AS throttled,
           CASE WHEN sub_status = 'unavailable' AND recheck_after > ? THEN recheck_after END AS next_recheck_at,
           CASE WHEN sub_status = 'unavailable' THEN status_reason END AS sample_reason
         FROM movies
         WHERE sub_status = 'missing' OR sub_status = 'unavailable'`
      )
      .all(timestamp, timestamp, timestamp) as MissingMovie[]
  }

  /** M7: subtitlePath=null 表示只知道"已覆盖"但没有可信的字幕文件路径（如 already_exists）——
   *  只改状态，不伪造 subtitles 行。
   *  providerRef: provider-neutral 候选标识，形如 "assrt:673114" / "opensubtitles:7174766"
   *  （见 core/schemas.ts candidateKey）；无来源可考时传 undefined。
   *  language: subtitles.language 取值（db.ts ~:69，plain TEXT——历史上只出现过 zh-Hans/zh-Hant，
   *  A2 起泛化为任意语言标签，如 'en'），默认 'zh-Hans'——沿用历史行为。今天唯一的生产调用点是
   *  find-subtitle worker（findSubtitleWorkerTask.ts），显式传入
   *  decision.installedLanguage ?? task.targetLanguage，不吃这个默认值。旧管线时代的
   *  scout-download/adopted-local 调用方（executor.ts）曾经不传此参数、吃这个默认值，
   *  scan 磁盘 arm 领养（scanner.ts）曾经会按匹配到的 CHINESE_TAGS tag 显式传入真实语言——
   *  executor.ts 与 scanner.ts 均已随各自的退役波删除，默认值本身原样保留，只是今天没有
   *  调用方会真的落到它。
   *  reason（W3，装机记账修复批，2026-07-18）：这次覆盖的判词——find-subtitle worker 传
   *  item.reason（finalize 里 agent 给出的"为什么装这个"人话理由），落进 status_reason，供事后
   *  观察性审计（Peacemaker 错装 5 天后无迹可查的教训：covered 行的 status_reason 此前恒为
   *  markCovered 从不碰这一列，旧的 unavailable/hardsub-assumed 叙事原样残留误导人工回看）。
   *  给了 reason 就写新的；省略/null 时照 ingest.ts writeSubStatusOnly 的既有 F-B 口径清空
   *  （covered 是终局态之一，旧叙事不再适用）——不是"不碰该列"，是"明确清空"。翻 missing/
   *  unavailable 走的是 markUnavailable 等其它写路径，不受这里影响，那条"翻篇清除"逻辑照旧。 */
  markCovered(
    itemId: string,
    subtitlePath: string | null,
    source: string,
    providerRef?: string,
    language: string = 'zh-Hans',
    reason?: string | null
  ): void {
    const now = Date.now()

    const markCoveredTransaction = this.db.transaction(() => {
      // Try to update episode first
      // R-3: markCovered 是内容退避阶梯的"翻篇"事件——item 终于被覆盖了，之前累积的
      // search_attempts 失去意义，归零；下次它再变回 missing/unavailable 时退避重新从
      // 1 天起步，不会背着上一轮的历史节奏。
      const episodeResult = this.db
        .prepare(
          `UPDATE episodes
           SET sub_status = 'covered', search_attempts = 0, status_reason = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(reason ?? null, now, itemId)

      // If episode not found, try movie
      if (episodeResult.changes === 0) {
        this.db
          .prepare(
            `UPDATE movies
             SET sub_status = 'covered', search_attempts = 0, status_reason = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(reason ?? null, now, itemId)
      }

      // Insert subtitle record (UNIQUE constraint handles duplicates)
      if (subtitlePath !== null) {
        this.db
          .prepare(
            `INSERT INTO subtitles (item_id, path, language, source, provider_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(item_id, path) DO NOTHING`
          )
          .run(itemId, subtitlePath, language, source, providerRef ?? null, now)
      }
    })

    markCoveredTransaction()
  }

  /** B3-1（批③领养记账）：ingest.ts classify() rule 3（磁盘 sidecar 探测，findExternalSidecar）
   *  判 covered 时的记账落点——只插入 subtitles 行，不碰 sub_status/search_attempts（那两个已经
   *  由调用方的 writeSubStatusOnly/upsertEpisode/upsertMovie 写过一次，这里不重复）。
   *  source 恒 'preexisting'（db.ts subtitles 表注释里的既有值——"摄取时发现磁盘上已经有"，
   *  不是新造的枚举），file_path 留 NULL（主文件语义，见 listSubtitlesForFile 头注释：sidecar
   *  是主文件旁边的外挂字幕，不是副本）。ON CONFLICT(item_id, path) DO NOTHING 防重——sidecar
   *  path 由 videoBase+tag 确定性派生，同一条目同一 pass/跨 pass 重复命中都是同一个 path，
   *  天然幂等，这里的 ON CONFLICT 只是同 markCovered 一样的防御性兜底。 */
  recordAdoptedSidecar(itemId: string, path: string, language: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO subtitles (item_id, path, language, source, created_at)
         VALUES (?, ?, ?, 'preexisting', ?)
         ON CONFLICT(item_id, path) DO NOTHING`
      )
      .run(itemId, path, language, now)
  }

  /** R-3（裁决 2026-07-16）：worker 判"本轮搜索穷尽"（no_safe_match）后调用——item 级内容退避
   *  阶梯，替代原先由调用方算好 recheckAfter 直接传入的旧签名。`now` 既是这次判决发生的时刻
   *  （写入 updated_at），也是阶梯计算的锚点（recheck_after = now + 对应天数）。
   *
   *  实现选择：沿用既有"先 episodes 后 movies"两表尝试模式（同 markCovered/markUnavailable/
   *  probeMemo 等既有写法），但没有用纯 SQL CASE 把整个阶梯揉进一条 UPDATE——那样天数表
   *  （ITEM_CONTENT_BACKOFF_DAYS）就要在 SQL 文本里再抄一遍，常量改了两处要同步改，是个
   *  维护陷阱。改为每表先 SELECT 出当前 search_attempts（判"这行是不是这张表"的信号，同时
   *  拿到算阶梯要用的输入），算出 newAttempts/recheckAfter 后一条 UPDATE 写回三列——单表
   *  两次往返，但 SQL 里没有魔法数字，天数表只有 ITEM_CONTENT_BACKOFF_DAYS 这一处真身。 */
  markUnavailable(itemId: string, reason: string, now: number): void {
    const stepLadder = (currentAttempts: number): { newAttempts: number; recheckAfter: number } => {
      const newAttempts = currentAttempts + 1
      const days =
        newAttempts <= ITEM_CONTENT_BACKOFF_DAYS.length
          ? ITEM_CONTENT_BACKOFF_DAYS[newAttempts - 1]
          : ITEM_BACKOFF_CAP_DAYS
      return { newAttempts, recheckAfter: now + days * 86_400_000 }
    }

    // Try episode first
    const episodeRow = this.db
      .prepare(`SELECT search_attempts FROM episodes WHERE id = ?`)
      .get(itemId) as { search_attempts: number } | undefined
    if (episodeRow) {
      const { newAttempts, recheckAfter } = stepLadder(episodeRow.search_attempts)
      this.db
        .prepare(
          `UPDATE episodes
           SET sub_status = 'unavailable',
               status_reason = ?,
               recheck_after = ?,
               search_attempts = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(reason, recheckAfter, newAttempts, now, itemId)
      return
    }

    // If episode not found, try movie
    const movieRow = this.db
      .prepare(`SELECT search_attempts FROM movies WHERE id = ?`)
      .get(itemId) as { search_attempts: number } | undefined
    if (movieRow) {
      const { newAttempts, recheckAfter } = stepLadder(movieRow.search_attempts)
      this.db
        .prepare(
          `UPDATE movies
           SET sub_status = 'unavailable',
               status_reason = ?,
               recheck_after = ?,
               search_attempts = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(reason, recheckAfter, newAttempts, now, itemId)
    }
  }

  /** 救援R5：agent 档判定/aggressive 档机械直判"硬字幕假定"——诚实标注为覆盖的一种（"已覆盖
   *  （硬字幕假定）"），不是失败判决，因此**不进**markUnavailable 的内容退避阶梯（search_attempts
   *  不动，不设 recheck_after）：这既不是"还没找到需要重试"，也不是"确认穷尽"，是"判断这条
   *  不需要再找外挂字幕"——三个既有终局（covered/unavailable/embedded）都不贴切，故 sub_status
   *  收新词而不是复用其中之一（schema v15 CHECK 约束扩容）。reason 落 status_reason（同
   *  markUnavailable 的人话理由字段），供 UI 覆盖详情面展示判定依据。 */
  markHardsubAssumed(itemId: string, reason: string, now: number): void {
    const episodeResult = this.db
      .prepare(
        `UPDATE episodes SET sub_status = 'hardsub-assumed', status_reason = ?, updated_at = ? WHERE id = ?`
      )
      .run(reason, now, itemId)
    if (episodeResult.changes === 0) {
      this.db
        .prepare(
          `UPDATE movies SET sub_status = 'hardsub-assumed', status_reason = ?, updated_at = ? WHERE id = ?`
        )
        .run(reason, now, itemId)
    }
  }

  // ---- P2：parked_paths（未识别文件的正式户口，去 Jellyfin 化 schema v9） ----

  /** 插入或更新一条 park 记录：reason/last_attempt 每轮巡检覆盖，first_seen 首次写入后不再变
   *  （同一路径第二次被 park 时沿用最早发现时间，供 P6 救援页按"挂了多久"排序）。
   *  fingerprint 可选：省略时不写 probe_* / 不推进退避阶梯（兼容旧调用方）；有指纹时按负缓存规则：
   *  - 新行 / reason 变 / fingerprint 变 → retry_count=0, next_retry_at=now+1h
   *  - 同 reason+同 fingerprint（到期后重 park）→ bump retry_count，下一档 4h→24h→cap 24h */
  upsertParkedPath(path: string, reason: string, now: number, fingerprint?: ParkedPathFingerprint): void {
    const existing = this.db
      .prepare(
        `SELECT park_reason, retry_count, probe_mtime, probe_size, duration_sec, embedded_langs, embedded_tmdb_id FROM parked_paths WHERE path = ?`
      )
      .get(path) as
      | {
          park_reason: string
          retry_count: number
          probe_mtime: number | null
          probe_size: number | null
          duration_sec: number | null
          embedded_langs: string | null
          embedded_tmdb_id: string | null
        }
      | undefined

    let retryCount = 0
    let nextRetryAt: number | null = now + parkedRetryDelayMs(0)
    let probeMtime: number | null = fingerprint?.mtimeMs ?? null
    let probeSize: number | null = fingerprint?.size ?? null
    let durationSec: number | null = fingerprint?.durationSec ?? null
    // 与 episodes/movies.embedded_langs 同构：JSON 数组串。空数组/省略 → NULL（避免 ''.split(',')
    // 式的幻影空语言；JSON.parse('[]') 虽安全，但 NULL 才是本列"未探测"的唯一语义）。
    let embeddedLangs: string | null = fingerprint?.embeddedLangs?.length
      ? JSON.stringify(fingerprint.embeddedLangs)
      : null
    // 路径标签（schema v26）：纯路径解析产物，NULL=路径无标签。
    let embeddedTmdbId: string | null = fingerprint?.embeddedTmdbId ?? null

    if (existing && fingerprint) {
      const sameReason = existing.park_reason === reason
      const sameFp =
        existing.probe_mtime === fingerprint.mtimeMs && existing.probe_size === fingerprint.size
      if (sameReason && sameFp) {
        // 完成当前档 → 进入下一档（0→1→2+）
        retryCount = existing.retry_count + 1
        nextRetryAt = now + parkedRetryDelayMs(retryCount)
      } else {
        // reason 或 fingerprint 变：重置 1h 档
        retryCount = 0
        nextRetryAt = now + parkedRetryDelayMs(0)
      }
      probeMtime = fingerprint.mtimeMs
      probeSize = fingerprint.size
      // raw 数据本次调用未提供 → 保留库中已有值（agent 识别依赖这些列，不被无探测的重 park 冲掉）。
      // 仅指纹未变才保留——文件变了则旧 duration/langs 已失效，必须随 !sameFp 重置路径一起清掉。
      if (sameFp) {
        if (durationSec === null) durationSec = existing.duration_sec
        if (embeddedLangs === null) embeddedLangs = existing.embedded_langs
        // 同上：本次未带标签的重 park 不该冲掉库中已记下的标签（park 分支的 outcome 就不带
        // 该字段）。指纹变了则路径可能已被改名/移动，旧标签同样失效，随重置路径清掉。
        if (embeddedTmdbId === null) embeddedTmdbId = existing.embedded_tmdb_id
      }
    } else if (existing && !fingerprint) {
      // 无指纹的旧调用：只覆写 reason/last_attempt，保留退避列
      retryCount = existing.retry_count
      nextRetryAt = null // 让 list 读回时用 DB 原值——下面 SQL 用 COALESCE 保护
      probeMtime = existing.probe_mtime
      probeSize = existing.probe_size
    }

    if (existing && !fingerprint) {
      this.db
        .prepare(
          `UPDATE parked_paths SET park_reason = ?, last_attempt = ? WHERE path = ?`
        )
        .run(reason, now, path)
      return
    }

    this.db
      .prepare(
        `INSERT INTO parked_paths (
           path, park_reason, first_seen, last_attempt,
           retry_count, next_retry_at, probe_mtime, probe_size,
           duration_sec, embedded_langs, embedded_tmdb_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           park_reason = excluded.park_reason,
           last_attempt = excluded.last_attempt,
           retry_count = excluded.retry_count,
           next_retry_at = excluded.next_retry_at,
           probe_mtime = excluded.probe_mtime,
           probe_size = excluded.probe_size,
           duration_sec = excluded.duration_sec,
           embedded_langs = excluded.embedded_langs,
           embedded_tmdb_id = excluded.embedded_tmdb_id`
      )
      .run(path, reason, now, now, retryCount, nextRetryAt, probeMtime, probeSize, durationSec, embeddedLangs, embeddedTmdbId)
  }

  /**
   * parked-path 负缓存：是否应在本轮 FULL PATH 重新 recognize。
   * - 未 park → true
   * - fingerprint 与库中不一致 → true（文件变了）
   * - next_retry_at 为 null 或 now >= next_retry_at → true
   * - 否则 false（仍在退避窗内）
   */
  shouldRetryParkedPath(path: string, fingerprint: ParkedPathFingerprint, now: number): boolean {
    const row = this.db
      .prepare(
        `SELECT park_reason, next_retry_at, probe_mtime, probe_size FROM parked_paths WHERE path = ?`
      )
      .get(path) as
      | { park_reason: string; next_retry_at: number | null; probe_mtime: number | null; probe_size: number | null }
      | undefined
    if (!row) return true
    if (row.probe_mtime !== fingerprint.mtimeMs || row.probe_size !== fingerprint.size) return true
    // 可自愈的终局：证据集合为空，指纹未变时重跑必然同样结果，纯浪费。用户改名 →
    // path 变 → 旧行随磁盘真相清理消失（ingest 收尾的 gone 清理）→ 新路径无 parked 行
    // → 上方 `if (!row) return true` 自然重走识别。本门优先级刻意低于指纹变化：
    // 用户动了文件就该立刻重试，不受本条约束。
    if (row.park_reason === PARK_REASON.insufficientEvidence) return false
    if (row.next_retry_at == null) return true
    return now >= row.next_retry_at
  }

  /** 识别成功（agent write_identified_media / unexclude 翻案）后调用，路径退出 park 户口。 */
  clearParkedPath(path: string): void {
    this.db.prepare(`DELETE FROM parked_paths WHERE path = ?`).run(path)
  }

  /** 救援R1：改写停车理由（agent keep_parked 的人话理由 / excluded-extra 裁决落档）。
   *  行不存在=无事发生（幽灵防御：收割时文件可能已被识别退户口）。 */
  updateParkReason(path: string, reason: string, now: number): void {
    this.db.prepare(`UPDATE parked_paths SET park_reason = ?, last_attempt = ? WHERE path = ?`).run(reason, now, path)
  }

  /** 活锁防线（作品单元管线 §3.3.1，2026-08-07）：只推进退避轨，不碰 park_reason。
   *
   *  为什么必须有这个方法（二轮审计 R2-B1 定罪的缺失接线）：identify 失败的三条路径
   *  ——拒识（updateParkReason）、编造被拒（只 console.error）、空报告（只 completeError）
   *  ——**没有一条**推进 retry_count/next_retry_at。而唯一推进它们的 upsertParkedPath 只被
   *  ingest 调用（ingest.ts:569,627,743）。后果：坏路径的 next_retry_at 永久停在首次 park 时
   *  写的 now+1h，一小时后该值恒为过去 → 退避窗恒开 → 组批时它恒在候选里；叠加
   *  last_attempt 也不动（编造/空报告两条路径），它还恒排队首 → 整个队列被单个坏单元卡死。
   *
   *  与 upsertParkedPath 的分工：那个是 ingest 的"重新发现这个文件"语义，reason 或 fingerprint
   *  变化时会把阶梯**重置**回 1h 档（见该方法注释）；这里是"agent 试过一次没成"语义，只加一档，
   *  绝不重置、绝不改 reason。reason 不改是反幻觉红线的要求：编造被拒时必须保持
   *  awaiting-agent-identification（不能让编造的结论污染 reason），但"试过一次"是与 agent 说了
   *  什么无关的机械事实，必须记。
   *
   *  阶梯复用 parkedRetryDelayMs（同 upsertParkedPath），不写第二份字面量。
   *  行不存在=空操作（同 updateParkReason 的幽灵防御口径）。 */
  bumpParkedRetry(path: string, now: number): void {
    const existing = this.db
      .prepare(`SELECT retry_count FROM parked_paths WHERE path = ?`)
      .get(path) as { retry_count: number } | undefined
    if (!existing) return
    const nextRetryCount = existing.retry_count + 1
    this.db
      .prepare(
        `UPDATE parked_paths SET retry_count = ?, next_retry_at = ?, last_attempt = ? WHERE path = ?`,
      )
      .run(nextRetryCount, now + parkedRetryDelayMs(nextRetryCount), now, path)
  }

  /** 判据用：这批路径里还有几条留在 parked_paths。纯读、零副作用、单次查询（分片除外）。
   *
   *  消费方（方案 2026-08-07-identity-decoupling-plan §3）：unidentifiedFindSubtitle 的
   *  identityProgress —— `stillParked < targets.length` 即"身份落库发生了"。为什么要它：
   *  identifyOnly worker 字幕工具零挂载（findSubtitleWorker.ts:209），识别成功的单元必然
   *  四个字幕桶全空，拿字幕产出当唯一成功判据会把识别成功判成"空报告"→ completeError →
   *  error_attempt 单调累积到天级退避。判据必须是机械事实，不能问 agent：identity 是
   *  advisory schema（findSubtitleWorker.schemas.ts:172-177）。
   *
   *  为什么"还剩几条"曾等价于"识别落库了"：write_identified_media 的事务无条件
   *  clearParkedPath，而已识别路径不会被 ingest 重新
   *  park —— fresh/promote 分支被 findRowByPath+probe memo 短路（ingest.ts:573-593），
   *  replica 分支被 getItemFileByPath 短路（ingest.ts:604-613）。
   *  🔴 第 7 步 C 组（2/2）：write_identified_media（agent/identityTools.ts）已删——它是
   *  series/episodes/movies 三张旧表最后的 INSERT 路径，整条上游链自第 2 步切换生产入口起
   *  不可达。因此上述等价关系**已不成立**：唯一消费方 unidentifiedFindSubtitle 的
   *  identityProgress 差值现在恒为 0。本方法本身仍是正确的纯读查询，保留不动。
   *
   *  空数组 → 直接 0，不发查询：SQLite 的 `IN ()` 是语法错误。
   *
   *  🔴 绝不用 LIKE 做路径匹配 —— 媒体路径合法含 % 和 _（"100% Pascal-sensei"、
   *  "Look_Back"），LIKE 会把它们当通配符展开造成计数虚高。这是 settingsRepo.ts:138-141
   *  的 removeRoot 当年改用 substr 的同一个陷阱；这里用参数化 IN 的字面量相等，天然免疫。 */
  countParked(paths: readonly string[]): number {
    if (paths.length === 0) return 0
    // 🔴 路径形态是**外部不变量**（审计 S-1，实测定罪）：本方法做**字面量**相等匹配，不做
    // 任何归一化。实测 parked 行为 '/media/tv/Show/E01.mkv' 时，'/media/tv/Show/../Show/E01.mkv'
    // 与 '/media/tv//Show/E01.mkv' 都返回 0。
    // 今天两侧同源所以一致：videoPath ← listParkedPaths().path ← upsertParkedPath ←
    // ingest.ts:627 ← walkVideoFiles 的 join()（selfScan.ts:78，join 会折叠 './' 与 '//'）。
    // 🔴 失效方向是最坏的那侧：若哪天一侧多/少一次归一化 → 命中数虚低 → 判据
    // (stillParked < targets.length) 恒真 → 失败单元永不记 failure、退避轨永不前进 →
    // **活锁**，正是本轮要修的病。任何把 target 路径改成"根 + 相对路径"重建的重构都会踩中。
    //
    // 入参重复不影响返回值（path 是 PRIMARY KEY，IN 是集合成员判定，实测重复 2 次仍返回 1）。
    // 消费方的分母 targets.length **不**去重，所以它假定 targets 无重复路径——该不变量由
    // listParkedPaths 的 PK 保证（审计 I-3）。
    //
    // 分片：SQLite 绑定变量上限实测 **32766**（SQLite ≥3.32；999 是 3.32 之前的旧默认值，
    // 本项目 3.53.2）。MAX_TARGETS_PER_JOB=60 远低于此，spec §3.3.2 的"单元自身超限时整单元
    // 上车"也到不了；取 500 是保守值，留 65× 余量。
    const CHUNK = 500
    let total = 0
    for (let i = 0; i < paths.length; i += CHUNK) {
      const chunk = paths.slice(i, i + CHUNK)
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM parked_paths WHERE path IN (${chunk.map(() => '?').join(',')})`
        )
        .get(...chunk) as { n: number }
      total += row.n
    }
    return total
  }

  /** P6 救援页读取；first_seen DESC——挂得最久的排最前，救援优先级天然对齐。 */
  listParkedPaths(): ParkedPath[] {
    return this.db
      .prepare(
        `SELECT path, park_reason, first_seen, last_attempt,
                retry_count, next_retry_at, probe_mtime, probe_size,
                duration_sec, embedded_langs, embedded_tmdb_id
         FROM parked_paths ORDER BY first_seen DESC`
      )
      .all() as ParkedPath[]
  }

  // ---- 救援R4b：特典机械排除的用户翻案豁免（extras_exemptions，schema v14） ----

  /** 翻案：把 path 写进豁免表（幂等 upsert）。机械过滤器此后跳过该 path 的 NC 铁案，
   *  让它重回正常识别流。见 db.ts v14 迁移注释的"为何独立成表"。 */
  addExtrasExemption(path: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO extras_exemptions (path, created_at) VALUES (?, ?)
         ON CONFLICT(path) DO NOTHING`
      )
      .run(path, now)
  }

  /** 机械过滤器每轮 pass 查询：该 path 是否已被用户翻案豁免。 */
  isExtrasExempt(path: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM extras_exemptions WHERE path = ?`).get(path)
    return row != null
  }

  // ---- 重复源 P1：item_files（同一条目的副本文件，schema v16） ----

  /** 副本入册（幂等 upsert on path）：path UNIQUE，同一副本第二次入册只刷 added_at 无害
   *  （实际调用方 ingest 只在识别到"撞既有身份但 path 不同"时调，天然不重复；ON CONFLICT
   *  防御性兜底 seenPaths 差异清理与重扫的竞态）。 */
  addItemFile(itemId: string, path: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO item_files (item_id, path, added_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET item_id = excluded.item_id`
      )
      .run(itemId, path, now)
  }

  /** 一个条目的全部副本（added_at ASC——最年长在前，promoteOldestReplica 晋升时取 [0]）。 */
  listItemFiles(itemId: string): ItemFile[] {
    return this.db
      .prepare(`SELECT id, item_id, path, added_at FROM item_files WHERE item_id = ? ORDER BY added_at ASC, id ASC`)
      .all(itemId) as ItemFile[]
  }

  /** B3-3（配额止血）：按 path 反查该 path 是否已是某条目的登记副本——ingest.ts 主扫描循环用它
   *  在调用昂贵的 recognize() 之前先判断"这条路径我们已经认得，只是副本身份"，从而跳过重新识别
   *  （findRowByPath 只查 episodes/movies，天生看不到副本；这条是它的 item_files 侧对应口）。
   *  找不到（路径不是任何条目的已登记副本）→ null。 */
  getItemFileByPath(path: string): ItemFile | null {
    const row = this.db
      .prepare(`SELECT id, item_id, path, added_at FROM item_files WHERE path = ?`)
      .get(path) as ItemFile | undefined
    return row ?? null
  }

  /** 副本文件从磁盘消失时删行（seenPaths 差异清理调用）。行不存在=无事发生。 */
  removeItemFileByPath(path: string): void {
    this.db.prepare(`DELETE FROM item_files WHERE path = ?`).run(path)
  }

  /** 主文件消失时：最年长副本晋升为主文件——episodes/movies.path 顶替成该副本 path，该副本
   *  从 item_files 退出（它现在是主文件了）。字幕行的 file_path 归属不动（spec §2）：原本挂在
   *  该副本 path 上的字幕，其 file_path 仍指向同一物理文件，只是这个文件现在的角色从"副本"变
   *  "主文件"，归属语义不变。无副本可晋升（列表空）=无事发生，调用方据此决定删条目还是留空壳。
   *  返回晋升后的新主文件 path（null=无副本可晋升）。 */
  promoteOldestReplica(itemId: string): string | null {
    const replicas = this.listItemFiles(itemId)
    if (replicas.length === 0) return null
    const promoted = replicas[0]
    const promote = this.db.transaction(() => {
      // 两表尝试（同 markCovered/markUnavailable 的既有口径）：itemId 要么是 episode 要么是 movie。
      const epResult = this.db.prepare(`UPDATE episodes SET path = ? WHERE id = ?`).run(promoted.path, itemId)
      if (epResult.changes === 0) {
        this.db.prepare(`UPDATE movies SET path = ? WHERE id = ?`).run(promoted.path, itemId)
      }
      this.db.prepare(`DELETE FROM item_files WHERE id = ?`).run(promoted.id)
    })
    promote()
    return promoted.path
  }

  /** B3-4（专项#1，schema v17）：某副本 path 上次记住的时长判决（mismatch/probe-failed）+ 判决
   *  那一刻主/副两个文件各自的 (mtimeMs,size) 快照。行不存在，或两列任一为 NULL（从未判过/
   *  ON CONFLICT 新建的副本行）→ null，调用方据此决定"必须重新真的探测一次"。 */
  getItemFileVerdict(path: string): { verdict: string; fingerprint: VerdictFingerprint } | null {
    const row = this.db
      .prepare(`SELECT duration_verdict, verdict_fingerprint FROM item_files WHERE path = ?`)
      .get(path) as { duration_verdict: string | null; verdict_fingerprint: string | null } | undefined
    if (!row || row.duration_verdict == null || row.verdict_fingerprint == null) return null
    return { verdict: row.duration_verdict, fingerprint: JSON.parse(row.verdict_fingerprint) as VerdictFingerprint }
  }

  /** B3-4：写入/刷新某副本 path 的时长判决记忆——subtitlePropagation.ts 唯一写口，仅在
   *  mismatch/probe-failed 两个失败分支调用（成功复制路径不需要 verdict，有字幕行本身就是短路
   *  锚点）。要求该 path 已在 item_files 里有行（调用方永远是 addItemFile 之后才调用
   *  propagateSubtitleToReplica，这个前提天然成立）。 */
  setItemFileVerdict(path: string, verdict: string, fingerprint: VerdictFingerprint): void {
    this.db
      .prepare(`UPDATE item_files SET duration_verdict = ?, verdict_fingerprint = ? WHERE path = ?`)
      .run(verdict, JSON.stringify(fingerprint), path)
  }

  /** 重复源 P3：逐文件覆盖事实——一个条目的每个文件（主文件 + 全部副本）各自是否已有字幕着落。
   *  主文件覆盖看 episodes/movies.sub_status（covered/embedded/hardsub-assumed 三态都算"已处理，
   *  无需再找外挂"）；副本覆盖看 subtitles.file_path 是否有对应该副本 path 的行（P2 起字幕可按
   *  file_path 归属到具体文件；file_path IS NULL 的存量字幕=挂主文件，不算副本覆盖）。
   *  条目不存在（两表都查不到）→ 空数组。派生态由调用方算：全 covered→covered、混合→partial、
   *  filesMissing=covered 为 false 的文件数。 */
  itemFileCoverage(itemId: string): ItemFileCoverage[] {
    const ep = this.db.prepare(`SELECT path, sub_status FROM episodes WHERE id = ?`).get(itemId) as
      | { path: string; sub_status: SubStatus } | undefined
    const main = ep ?? (this.db.prepare(`SELECT path, sub_status FROM movies WHERE id = ?`).get(itemId) as
      | { path: string; sub_status: SubStatus } | undefined)
    if (!main) return []

    const COVERED_ISH: ReadonlySet<string> = new Set(['covered', 'embedded', 'hardsub-assumed'])
    const replicaSubPaths = new Set(
      (this.db.prepare(`SELECT DISTINCT file_path FROM subtitles WHERE item_id = ? AND file_path IS NOT NULL`).all(itemId) as
        { file_path: string }[]).map((r) => r.file_path)
    )
    const replicas = this.listItemFiles(itemId)
    return [
      { path: main.path, isMain: true, covered: COVERED_ISH.has(main.sub_status) },
      ...replicas.map((r) => ({ path: r.path, isMain: false, covered: replicaSubPaths.has(r.path) })),
    ]
  }

  /** 重复源 P4：某个条目里一个具体文件（用 path 定位）挂着的字幕行——供传播判断构造本地候选
   *  （零成本、指纹=该文件的 release 解析）。isMainFile 由调用方传入（已从 itemFileCoverage 知道）
   *  ——file_path IS NULL 的存量字幕行只挂主文件（P1 兼容语义），非主文件永远不该捡到这些行。 */
  listSubtitlesForFile(itemId: string, filePath: string, isMainFile: boolean): Array<{ id: number; path: string; language: string }> {
    const rows = isMainFile
      ? this.db.prepare(`SELECT id, path, language FROM subtitles WHERE item_id = ? AND (file_path = ? OR file_path IS NULL)`).all(itemId, filePath)
      : this.db.prepare(`SELECT id, path, language FROM subtitles WHERE item_id = ? AND file_path = ?`).all(itemId, filePath)
    return rows as Array<{ id: number; path: string; language: string }>
  }

  /** 重复源 P4b（"复制优先"机械通道，v2/subtitlePropagation.ts 的唯一写口）：给一个具体副本文件
   *  挂一行字幕账——file_path 恒指向该副本自己的 path（永不是 NULL，NULL 是主文件的兼容语义，
   *  见 listSubtitlesForFile 头注释）。ON CONFLICT(item_id, path) DO NOTHING 同 markCovered 的
   *  既有写法：目标 path 是按副本 basename+langTag 派生的确定性文件名，重复调用（ingest 每轮都
   *  可能重新命中这个 hook，见 subtitlePropagation.ts 的幂等前置检查）天然幂等，这里的 ON
   *  CONFLICT 只是同一份防御性兜底，不承担主要幂等责任。不动 episodes/movies.sub_status——
   *  副本覆盖从来只由 subtitles.file_path 是否存在对应行反映（itemFileCoverage 头注释），没有
   *  独立状态列要更新。 */
  addReplicaSubtitle(itemId: string, filePath: string, subtitlePath: string, language: string, source: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO subtitles (item_id, path, language, source, file_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id, path) DO NOTHING`
      )
      .run(itemId, subtitlePath, language, source, filePath, now)
  }

  // ---- P2：ffprobe 探针记忆化（episodes/movies 共用列，见 db.ts P1 注释） ----

  /** 两表 UPDATE 尝试模式（同 markCovered/markUnavailable 的既有写法）：itemId
   *  的自有 id 空间里 episodes 与 movies 互斥（episodes 形状含 '/s<N>e<M>' 段，movies 没有），
   *  先按 episodes 查，查不到再查 movies，不需要额外的 kind 参数区分调用方意图。 */
  probeMemo(itemId: string): ProbeMemo | null {
    type Row = { probe_mtime: number | null; probe_size: number | null; embedded_langs: string | null }
    const episodeRow = this.db
      .prepare(`SELECT probe_mtime, probe_size, embedded_langs FROM episodes WHERE id = ?`)
      .get(itemId) as Row | undefined
    const row =
      episodeRow ??
      (this.db
        .prepare(`SELECT probe_mtime, probe_size, embedded_langs FROM movies WHERE id = ?`)
        .get(itemId) as Row | undefined)
    if (!row || row.probe_mtime == null || row.probe_size == null) return null
    return {
      mtime: row.probe_mtime,
      size: row.probe_size,
      langs: row.embedded_langs != null ? (JSON.parse(row.embedded_langs) as string[]) : null,
    }
  }

  /** 同 probeMemo 的两表尝试模式：先 UPDATE episodes，0 行受影响再 UPDATE movies。 */
  setProbeMemo(itemId: string, mtime: number, size: number, langs: string[] | null): void {
    const langsJson = langs != null ? JSON.stringify(langs) : null
    const episodeResult = this.db
      .prepare(`UPDATE episodes SET probe_mtime = ?, probe_size = ?, embedded_langs = ? WHERE id = ?`)
      .run(mtime, size, langsJson, itemId)
    if (episodeResult.changes === 0) {
      this.db
        .prepare(`UPDATE movies SET probe_mtime = ?, probe_size = ?, embedded_langs = ? WHERE id = ?`)
        .run(mtime, size, langsJson, itemId)
    }
  }

  // ---- P2：磁盘真相移除（T3 摄取层消费：文件从盘上消失 → 行退役） ----

  /** 按 path 删 episode 行 + 关联 subtitles（subtitles 未声明外键到 episodes(id)，同属一份账目，
   *  与 deleteSeriesRows 同样理由一并清理）。路径不存在时是空操作。
   *  R6-4 修复：也要删 item_files——deleteSeriesRows 的头注释把"owner 删了但 item_files 留孤儿"
   *  定性为 SEVERE 数据腐蚀（ingest B3-3 短路命中孤儿 path → ownerPath=null → continue → 盘上
   *  有视频有字幕却永久不再识别，非自愈），本方法与 deleteSeriesRows 同形，漏了同级清理。 */
  deleteEpisodeByPath(path: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM episodes WHERE path = ?`).get(path) as
        | { id: string }
        | undefined
      if (!row) return
      this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`).run(row.id)
      this.db.prepare(`DELETE FROM item_files WHERE item_id = ?`).run(row.id)
      this.db.prepare(`DELETE FROM episodes WHERE path = ?`).run(path)
    })
    tx()
  }

  /** 按 path 删 movie 行 + 关联 subtitles（同 deleteEpisodeByPath）。
   *  R6-4 修复：也要删 item_files（同 deleteEpisodeByPath 的理由）。 */
  deleteMovieByPath(path: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM movies WHERE path = ?`).get(path) as
        | { id: string }
        | undefined
      if (!row) return
      this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`).run(row.id)
      this.db.prepare(`DELETE FROM item_files WHERE item_id = ?`).run(row.id)
      this.db.prepare(`DELETE FROM movies WHERE path = ?`).run(path)
    })
    tx()
  }

  /** episodes 行随磁盘真相逐个被 deleteEpisodeByPath 删空后，该剧的 series 行变成永久性镜像
   *  鬼影（同 deleteSeriesRows 头注释的既有理由）——T3 摄取层在删完某剧最后一个 episode 后调用。 */
  deleteSeriesIfEmpty(seriesId: string): void {
    const row = this.db
      .prepare(`SELECT COUNT(*) as c FROM episodes WHERE series_id = ?`)
      .get(seriesId) as { c: number }
    if (row.c === 0) {
      this.db.prepare(`DELETE FROM series WHERE id = ?`).run(seriesId)
      // 审计 M4（2026-07-26）：tmdb_seasons 是 series 级联的一部分（settingsRepo 删守备目录
      // 时就是这么清的），此前这里漏了——身份纠错会频繁删空 series 行，孤儿季表随之无上界
      // 累积且无 GC。更实际的危害：同一个 series_id 日后若回归，tmdbCatalog 的 TTL 门读
      // MAX(fetched_at)，7 天内直接早退，那次"新剧首次入库刷应有集缓存"被静默跳过。
      this.db.prepare(`DELETE FROM tmdb_seasons WHERE series_id = ?`).run(seriesId)
    }
  }
}

/** Determines if a parked path is eligible for agent processing.
 * Excludes mechanical verdicts that are final (excluded-extra, duplicate-content).
 * Used by orchestrator to decide which parked paths to dispatch to the agent. */
export function isParkedPathEligible(parkReason: string): boolean {
  return parkReason !== PARK_REASON.excludedExtra && parkReason !== PARK_REASON.duplicateContent
}
