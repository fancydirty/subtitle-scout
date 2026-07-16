import type { ScoutDb } from './db.js'

export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored'

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
  year?: number | null
  providerIds?: string | null // JSON
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
}

// ---- P2 新面：parked_paths / identify_overrides / probe memo（去 Jellyfin 化 schema v9） ----

export interface ParkedPath {
  path: string
  park_reason: string
  first_seen: number
  last_attempt: number
}

export interface IdentifyOverride {
  tmdbId: string
  isTv: boolean
  /** P7 disambiguation 补丁：认领时人类一并给出的季号；未指定 = null（见 db.ts identify_overrides
   *  头注释）。始终存在于返回形状里（不是可选键）——DB 行本身总有这一列，值域是 number | null。 */
  season: number | null
}

export interface ProbeMemo {
  mtime: number
  size: number
  langs: string[] | null
}

export class LibraryRepo {
  readonly db: ScoutDb

  constructor(db: ScoutDb) {
    this.db = db
  }

  upsertSeries(params: SeriesParams): void {
    const posterPath = params.posterPath ?? null
    this.db
      .prepare(
        `INSERT INTO series (id, name, chinese_title, poster_path, year, provider_ids)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           chinese_title = COALESCE(excluded.chinese_title, chinese_title),
           poster_path = COALESCE(excluded.poster_path, poster_path),
           year = excluded.year,
           provider_ids = excluded.provider_ids
         WHERE name != excluded.name
            OR (excluded.chinese_title IS NOT NULL AND chinese_title IS NOT excluded.chinese_title)
            OR (excluded.poster_path IS NOT NULL AND poster_path IS NOT excluded.poster_path)
            OR year IS NOT excluded.year
            OR provider_ids IS NOT excluded.provider_ids`
      )
      .run(
        params.id,
        params.name,
        params.chineseTitle ?? null,
        posterPath,
        params.year ?? null,
        params.providerIds ?? null
      )
  }

  /** F-R2-6（R2 复审，审计定罪：ingest 覆盖路径绕过阶梯归零，R-3 不变式）：ON CONFLICT 分支的
   *  search_attempts CASE——excluded.sub_status（本次要写入的新状态）落在 covered/embedded 时
   *  归零，否则保持原值不动。这是 ingest 的 FULL PATH（新识别/probeMemo 过期，见 ingest.ts）
   *  写入 covered/embedded 的落点：INSERT（新行）本就默认 0（db.ts schema default），只有
   *  UPDATE（已存在的行，例如此前是 unavailable/missing）需要这条 CASE 主动归零。 */
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
  upsertMovie(params: MovieParams): void {
    const now = Date.now()
    const posterPath = params.posterPath ?? null
    this.db
      .prepare(
        `INSERT INTO movies (id, name, path, sub_status, chinese_title, poster_path, year, provider_ids, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           sub_status = excluded.sub_status,
           search_attempts = CASE WHEN excluded.sub_status IN ('covered', 'embedded') THEN 0 ELSE search_attempts END,
           chinese_title = COALESCE(excluded.chinese_title, chinese_title),
           poster_path = COALESCE(excluded.poster_path, poster_path),
           year = excluded.year,
           provider_ids = excluded.provider_ids,
           updated_at = excluded.updated_at
         WHERE name != excluded.name
            OR path != excluded.path
            OR sub_status != excluded.sub_status
            OR (excluded.chinese_title IS NOT NULL AND chinese_title IS NOT excluded.chinese_title)
            OR (excluded.poster_path IS NOT NULL AND poster_path IS NOT excluded.poster_path)
            OR year IS NOT excluded.year
            OR provider_ids IS NOT excluded.provider_ids`
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

  /** 该剧该季在镜像里的集数——core/seasonShape.ts 的 SeasonShape.mirrorEpisodeCount 侧
   *  （镜像集数 vs TMDB 该季 episode_count 的主信号，消费方是 v3 orchestrator 的布局检查
   *  orchestratorAgent.tools.ts；同一套判据在旧管线时代叫 diagnoseSeason，该模块已随
   *  旧管线退役删除）。 */
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

  /** 镜像清理：realign 完成、Jellyfin 用新 SeriesId 重刮之后，旧 seriesId 下的
   *  episodes/subtitles/series 行永远不会再被下一轮 scanLibrary 碰到（它只 upsert Jellyfin
   *  当前报告的条目），是永久性的镜像鬼影，必须显式清除。subtitles 表未声明外键到
   *  episodes(id)，但同属一份账目，一并清理保持镜像干净。 */
  deleteSeriesRows(seriesId: string): void {
    const tx = this.db.transaction(() => {
      const episodeIds = this.db.prepare(`SELECT id FROM episodes WHERE series_id = ?`).all(seriesId) as { id: string }[]
      const delSub = this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`)
      for (const e of episodeIds) delSub.run(e.id)
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
   *  调用方会真的落到它。 */
  markCovered(
    itemId: string,
    subtitlePath: string | null,
    source: string,
    providerRef?: string,
    language: string = 'zh-Hans'
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
           SET sub_status = 'covered', search_attempts = 0, updated_at = ?
           WHERE id = ?`
        )
        .run(now, itemId)

      // If episode not found, try movie
      if (episodeResult.changes === 0) {
        this.db
          .prepare(
            `UPDATE movies
             SET sub_status = 'covered', search_attempts = 0, updated_at = ?
             WHERE id = ?`
          )
          .run(now, itemId)
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

  // ---- P2：parked_paths（未识别文件的正式户口，去 Jellyfin 化 schema v9） ----

  /** 插入或更新一条 park 记录：reason/last_attempt 每轮巡检覆盖，first_seen 首次写入后不再变
   *  （同一路径第二次被 park 时沿用最早发现时间，供 P6 救援页按"挂了多久"排序）。 */
  upsertParkedPath(path: string, reason: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO parked_paths (path, park_reason, first_seen, last_attempt)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           park_reason = excluded.park_reason,
           last_attempt = excluded.last_attempt`
      )
      .run(path, reason, now, now)
  }

  /** 认领成功（identify_overrides 命中）后调用，路径退出 park 户口。 */
  clearParkedPath(path: string): void {
    this.db.prepare(`DELETE FROM parked_paths WHERE path = ?`).run(path)
  }

  /** P6 救援页读取；first_seen DESC——挂得最久的排最前，救援优先级天然对齐。 */
  listParkedPaths(): ParkedPath[] {
    return this.db
      .prepare(
        `SELECT path, park_reason, first_seen, last_attempt FROM parked_paths ORDER BY first_seen DESC`
      )
      .all() as ParkedPath[]
  }

  // ---- P2：identify_overrides（P6 认领写入，识别层消歧前查） ----

  /** P6 手工认领写入：ON CONFLICT 幂等更新（同一前缀重新认领覆盖旧值）。P7：新增可选 season
   *  形参（默认 null=未指定，向后兼容既有调用方）——认领时人类一并给出季号，见 db.ts 头注释。 */
  addOverride(pathPrefix: string, tmdbId: string, isTv: boolean, now: number, season: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO identify_overrides (path_prefix, tmdb_id, is_tv, season, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path_prefix) DO UPDATE SET
           tmdb_id = excluded.tmdb_id,
           is_tv = excluded.is_tv,
           season = excluded.season,
           created_at = excluded.created_at`
      )
      .run(pathPrefix, tmdbId, isTv ? 1 : 0, season, now)
  }

  /** 最长前缀匹配：candidates = path 以 path_prefix 开头的全部 override 行，取 path_prefix
   *  最长者（嵌套前缀时更具体的那条胜出）。实现为 SQL 全表扫描 + JS 过滤而非 LIKE/GLOB
   *  通配符匹配——path_prefix 本身可能含 % / * / ? 等对 LIKE/GLOB 有特殊含义的字符，字面量
   *  startsWith 比较不会误判，正确性优先于取巧。identify_overrides 是 P6 手工认领写入的表，
   *  预期行数很小（几十到几百量级），全表扫描代价可忽略。 */
  findOverride(path: string): IdentifyOverride | null {
    const rows = this.db
      .prepare(`SELECT path_prefix, tmdb_id, is_tv, season FROM identify_overrides`)
      .all() as { path_prefix: string; tmdb_id: string; is_tv: number; season: number | null }[]
    let best: { path_prefix: string; tmdb_id: string; is_tv: number; season: number | null } | null = null
    for (const row of rows) {
      if (!path.startsWith(row.path_prefix)) continue
      if (!best || row.path_prefix.length > best.path_prefix.length) best = row
    }
    if (!best) return null
    return { tmdbId: best.tmdb_id, isTv: best.is_tv === 1, season: best.season }
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
   *  与 deleteSeriesRows 同样理由一并清理）。路径不存在时是空操作。 */
  deleteEpisodeByPath(path: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM episodes WHERE path = ?`).get(path) as
        | { id: string }
        | undefined
      if (!row) return
      this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`).run(row.id)
      this.db.prepare(`DELETE FROM episodes WHERE path = ?`).run(path)
    })
    tx()
  }

  /** 按 path 删 movie 行 + 关联 subtitles（同 deleteEpisodeByPath）。 */
  deleteMovieByPath(path: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM movies WHERE path = ?`).get(path) as
        | { id: string }
        | undefined
      if (!row) return
      this.db.prepare(`DELETE FROM subtitles WHERE item_id = ?`).run(row.id)
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
    }
  }
}
