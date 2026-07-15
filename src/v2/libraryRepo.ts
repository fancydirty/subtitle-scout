import type { ScoutDb } from './db.js'

export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored'

export interface SeriesParams {
  id: string
  name: string
  chineseTitle?: string | null
  posterTag?: string | null
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
  posterTag?: string | null
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
}

export interface Movie {
  id: string
  name: string
  chinese_title: string | null
  poster_tag: string | null
  year: number | null
  path: string
  provider_ids: string | null
  sub_status: SubStatus
  status_reason: string | null
  recheck_after: number | null
  updated_at: number
}

export interface MissingBySeason {
  series_id: string
  season: number
  missing: number
}

export interface Series {
  id: string
  name: string
  chinese_title: string | null
  chinese_title_checked_at: number | null
  poster_tag: string | null
  year: number | null
  provider_ids: string | null
  origin_lang: string | null
}

export class LibraryRepo {
  readonly db: ScoutDb

  constructor(db: ScoutDb) {
    this.db = db
  }

  upsertSeries(params: SeriesParams): void {
    this.db
      .prepare(
        `INSERT INTO series (id, name, chinese_title, poster_tag, year, provider_ids)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           chinese_title = COALESCE(excluded.chinese_title, chinese_title),
           poster_tag = COALESCE(excluded.poster_tag, poster_tag),
           year = excluded.year,
           provider_ids = excluded.provider_ids
         WHERE name != excluded.name
            OR (excluded.chinese_title IS NOT NULL AND chinese_title IS NOT excluded.chinese_title)
            OR (excluded.poster_tag IS NOT NULL AND poster_tag IS NOT excluded.poster_tag)
            OR year IS NOT excluded.year
            OR provider_ids IS NOT excluded.provider_ids`
      )
      .run(
        params.id,
        params.name,
        params.chineseTitle ?? null,
        params.posterTag ?? null,
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
    this.db
      .prepare(
        `INSERT INTO movies (id, name, path, sub_status, chinese_title, poster_tag, year, provider_ids, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           path = excluded.path,
           sub_status = excluded.sub_status,
           chinese_title = COALESCE(excluded.chinese_title, chinese_title),
           poster_tag = COALESCE(excluded.poster_tag, poster_tag),
           year = excluded.year,
           provider_ids = excluded.provider_ids,
           updated_at = excluded.updated_at
         WHERE name != excluded.name
            OR path != excluded.path
            OR sub_status != excluded.sub_status
            OR (excluded.chinese_title IS NOT NULL AND chinese_title IS NOT excluded.chinese_title)
            OR (excluded.poster_tag IS NOT NULL AND poster_tag IS NOT excluded.poster_tag)
            OR year IS NOT excluded.year
            OR provider_ids IS NOT excluded.provider_ids`
      )
      .run(
        params.id,
        params.name,
        params.path,
        params.subStatus,
        params.chineseTitle ?? null,
        params.posterTag ?? null,
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
      const episodeResult = this.db
        .prepare(
          `UPDATE episodes
           SET sub_status = 'covered', updated_at = ?
           WHERE id = ?`
        )
        .run(now, itemId)

      // If episode not found, try movie
      if (episodeResult.changes === 0) {
        this.db
          .prepare(
            `UPDATE movies
             SET sub_status = 'covered', updated_at = ?
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

  markUnavailable(itemId: string, reason: string, recheckAfter: number): void {
    const now = Date.now()

    // Try episode first
    const episodeResult = this.db
      .prepare(
        `UPDATE episodes
         SET sub_status = 'unavailable',
             status_reason = ?,
             recheck_after = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(reason, recheckAfter, now, itemId)

    // If episode not found, try movie
    if (episodeResult.changes === 0) {
      this.db
        .prepare(
          `UPDATE movies
           SET sub_status = 'unavailable',
               status_reason = ?,
               recheck_after = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(reason, recheckAfter, now, itemId)
    }
  }

  /** job 执行时解析到系列中文名后写回 series 行。仅当现值 IS NULL 或不同才写（幂等，失败静默由调用方兜）。 */
  setSeriesChineseTitle(id: string, title: string, now: number): void {
    this.db
      .prepare(
        `UPDATE series
         SET chinese_title = ?, chinese_title_checked_at = ?
         WHERE id = ? AND (chinese_title IS NULL OR chinese_title != ?)`
      )
      .run(title, now, id, title)
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
}
