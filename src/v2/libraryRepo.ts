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

export interface MissingBySeason {
  series_id: string
  season: number
  missing: number
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

  /** 该剧该季在镜像里的集数——diagnoseSeason 的主信号(镜像集数 vs TMDB)所需的"镜像集数"侧。 */
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

  /** B1（self-hosted 周期扫描）已知路径全集：episodes ∪ movies 的 path 列，供 selfScan 与
   *  磁盘现状做差集——库里已有路径不再重复 recognize()（该行本身就是"已识别过"的记忆）。
   *  UNION 天然去重；两表 path 列 schema 上是 NOT NULL，这里的 IS NOT NULL 是防御性写法，
   *  不依赖当前 schema 保证。返回 Set 而非数组：调用方要做的是 O(1) 成员判定，不是遍历。 */
  knownPaths(): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT path FROM episodes WHERE path IS NOT NULL
         UNION
         SELECT path FROM movies WHERE path IS NOT NULL`
      )
      .all() as { path: string }[]
    return new Set(rows.map(r => r.path))
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

  /** unavailable 复查到期后重新计入 missing——消费者是 v3 orchestrator 的
   *  list_missing_coverage 工具（orchestratorAgent.tools.ts），旧管线的聚合层
   *  （原 v2/aggregate 模块）已随退役T7 (Wave 2A) 删除。 */
  missingBySeason(now?: number): MissingBySeason[] {
    const timestamp = now ?? Date.now()
    return this.db
      .prepare(
        `SELECT series_id, season, count(*) as missing
         FROM episodes
         WHERE sub_status = 'missing'
            OR (sub_status = 'unavailable' AND recheck_after <= ?)
         GROUP BY series_id, season`
      )
      .all(timestamp) as MissingBySeason[]
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
   *  listMissingEpisodesInSeason 完全一致，只是不强制单季；ORDER BY season, episode 是清单
   *  排序，不是执行顺序指令（同 listMissingEpisodesInSeason 的既有措辞）。 */
  listMissingEpisodesForSeries(seriesId: string, seasons: number[] | null, now: number): MissingEpisodeFact[] {
    const seasonFilter = seasons && seasons.length > 0 ? `AND season IN (${seasons.map(() => '?').join(',')})` : ''
    return this.db
      .prepare(
        `SELECT id, path, season, episode FROM episodes
         WHERE series_id = ? ${seasonFilter}
         AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))
         ORDER BY season ASC, episode ASC`
      )
      .all(...(seasons && seasons.length > 0 ? [seriesId, ...seasons, now] : [seriesId, now])) as MissingEpisodeFact[]
  }

  missingMovies(now?: number): Movie[] {
    const timestamp = now ?? Date.now()
    return this.db
      .prepare(
        `SELECT * FROM movies
         WHERE sub_status = 'missing'
            OR (sub_status = 'unavailable' AND recheck_after <= ?)`
      )
      .all(timestamp) as Movie[]
  }

  /** scan 磁盘 arm 记账用：该 item 是否已有任意 subtitles 行。已经走过正规 pipeline 记账
   *  （scout-download/adopted-local/preexisting 任一来源）的条目不该被 scan 的磁盘 arm
   *  二次"认领"——即便这轮磁盘 arm 也命中（比如 Jellyfin 还没刷新 MediaStreams）。
   *  已知取舍（accepted debt）：本 guard 只看"有没有任意行"，不比较路径——若既有行是
   *  一条失效路径（文件已被移走/改名），磁盘上又冒出一个新路径的 sidecar，guard 仍会短路，
   *  新 sidecar 不会被记账（旧行继续代表该 item 的字幕来源）。这是刻意的取舍，不在本次
   *  修复范围内。 */
  hasSubtitleRecord(itemId: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM subtitles WHERE item_id = ? LIMIT 1').get(itemId) !== undefined
    )
  }

  /** M7: subtitlePath=null 表示只知道"已覆盖"但没有可信的字幕文件路径（如 already_exists）——
   *  只改状态，不伪造 subtitles 行。
   *  providerRef: provider-neutral 候选标识，形如 "assrt:673114" / "opensubtitles:7174766"
   *  （见 core/schemas.ts candidateKey）；无来源可考时传 undefined。
   *  language: subtitles.language 取值（db.ts ~:69，plain TEXT——历史上只出现过 zh-Hans/zh-Hant，
   *  A2 起泛化为任意语言标签，如 'en'），默认 'zh-Hans'——沿用历史行为，scout-download/
   *  adopted-local 等既有调用方（executor.ts）不传此参数，行为完全不变。find-subtitle worker
   *  （findSubtitleWorkerTask.ts）显式传入 decision.installedLanguage ?? task.targetLanguage；
   *  scan 磁盘 arm 领养（scanner.ts）会按匹配到的 CHINESE_TAGS tag 显式传入真实语言，不再无论
   *  简繁一律硬编码 zh-Hans。 */
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

  /**
   * 播放触发用：把 unavailable 条目的 recheck_after 拉回 now，
   * 让 executor 重derive targets 时能纳入它（后台调和的 recheck 门对播放触发不适用）。
   */
  resetRecheck(itemId: string, now: number): void {
    const episodeResult = this.db
      .prepare(
        `UPDATE episodes
         SET recheck_after = ?, updated_at = ?
         WHERE id = ? AND sub_status = 'unavailable'`
      )
      .run(now, now, itemId)

    if (episodeResult.changes === 0) {
      this.db
        .prepare(
          `UPDATE movies
           SET recheck_after = ?, updated_at = ?
           WHERE id = ? AND sub_status = 'unavailable'`
        )
        .run(now, now, itemId)
    }
  }

  /** R-3（裁决 2026-07-16）：worker 判"本轮搜索穷尽"（no_safe_match）后调用——item 级内容退避
   *  阶梯，替代原先由调用方算好 recheckAfter 直接传入的旧签名。`now` 既是这次判决发生的时刻
   *  （写入 updated_at），也是阶梯计算的锚点（recheck_after = now + 对应天数）。
   *
   *  实现选择：沿用既有"先 episodes 后 movies"两表尝试模式（同 markCovered/resetRecheck/
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

  /** job 执行时解析到电影中文名后写回 movies 行。仅当现值 IS NULL 或不同才写。 */
  setMovieChineseTitle(id: string, title: string, now: number): void {
    this.db
      .prepare(
        `UPDATE movies
         SET chinese_title = ?, updated_at = ?
         WHERE id = ? AND (chinese_title IS NULL OR chinese_title != ?)`
      )
      .run(title, now, id, title)
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

  /** 两表 UPDATE 尝试模式（同 markCovered/markUnavailable/resetRecheck 的既有写法）：itemId
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
