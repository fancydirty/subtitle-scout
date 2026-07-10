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

  /** M7: subtitlePath=null 表示只知道"已覆盖"但没有可信的字幕文件路径（如 already_exists）——
   *  只改状态，不伪造 subtitles 行。
   *  providerRef: provider-neutral 候选标识，形如 "assrt:673114" / "opensubtitles:7174766"
   *  （见 core/schemas.ts candidateKey）；无来源可考时传 undefined。 */
  markCovered(itemId: string, subtitlePath: string | null, source: string, providerRef?: string): void {
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
             VALUES (?, ?, 'zh-Hans', ?, ?, ?)
             ON CONFLICT(item_id, path) DO NOTHING`
          )
          .run(itemId, subtitlePath, source, providerRef ?? null, now)
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
