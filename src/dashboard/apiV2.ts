// src/dashboard/apiV2.ts
// v2 媒体库只读数据层：纯函数收 ScoutDb 返回 DTO（对照 api.ts 风格）。海报直接暴露 TMDB
// poster_path，前端自行拼 CDN URL（image.tmdb.org，公开、免 key）——不再经服务端代理。
import { dirname } from 'node:path'
import type { ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'

// ---- Library (海报墙) ----

export interface CoverageDTO {
  covered: number
  missing: number
  embedded: number
  unavailable: number
}

export interface LibraryJobDTO {
  state: string
  priority: number
}

export interface LibraryItemDTO {
  id: string
  kind: 'series' | 'movie'
  name: string
  chineseTitle: string | null
  year: number | null
  /** TMDB poster_path（如 '/abc.jpg'），前端拼 https://image.tmdb.org/t/p/w400 前缀；无海报为 null */
  posterPath: string | null
  /** 海报墙分区标签（剧集/动漫/电影/其他），按库目录结构零配置派生 */
  section: string
  coverage: CoverageDTO
  job: LibraryJobDTO | null
}

interface SeriesRow {
  id: string
  name: string
  chinese_title: string | null
  year: number | null
  poster_path: string | null
}
interface MovieRow extends SeriesRow {
  path: string
  sub_status: string
}
interface CoverageRow {
  key: string
  sub_status: string
  c: number
}
interface JobRow {
  key: string
  state: string
  priority: number
}

const emptyCoverage = (): CoverageDTO => ({ covered: 0, missing: 0, embedded: 0, unavailable: 0 })

/** 把一条 sub_status 累加进覆盖桶（ignored 不入桶，它不参与 scout）。 */
function addToCoverage(cov: CoverageDTO, status: string, n: number): void {
  if (status === 'covered') cov.covered += n
  else if (status === 'missing') cov.missing += n
  else if (status === 'embedded') cov.embedded += n
  else if (status === 'unavailable') cov.unavailable += n
}

// ---- Section 派生（海报墙分区，零配置按库目录结构分组）----

/** 常见库目录名 → 人话分区标签。key 统一小写。 */
const SECTION_LABELS: Record<string, string> = {
  tv: '剧集', tvshows: '剧集', shows: '剧集', series: '剧集', drama: '剧集',
  anime: '动漫', animation: '动漫', cartoon: '动漫',
  movie: '电影', movies: '电影', film: '电影', films: '电影',
}

/** 首字母大写（未知目录名原样展示）。 */
function titleCase(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** path 的目录段（去掉文件名），posix 风格，末尾空段丢弃。 */
function dirSegments(path: string): string[] {
  const segs = path.split('/')
  segs.pop() // 去掉文件名
  return segs
}

/**
 * 库内所有 path 的最长公共祖先目录段数 = 媒体根深度。
 * 任意用户按自己的库根自动对齐（如 /media 深度 2：['','media']）。
 */
export function commonRootDepth(paths: string[]): number {
  const arrays = paths.filter(Boolean).map(dirSegments)
  if (arrays.length === 0) return 0
  const shortest = Math.min(...arrays.map((a) => a.length))
  let k = 0
  for (; k < shortest; k++) {
    const seg = arrays[0][k]
    if (!arrays.every((a) => a[k] === seg)) break
  }
  return k
}

/**
 * 取 path 在媒体根下的一级目录名（rootDepth 处的段），映射为人话分区标签。
 * 如 rootDepth=2、/media/tv/... → "tv" → "剧集"；未知目录名首字母大写原样展示。
 */
export function sectionOf(path: string, rootDepth: number): string {
  if (!path) return '其他'
  const segs = dirSegments(path)
  // 媒体根下一级目录；越界（条目直接在根下）时回退到最末目录段
  const raw = segs[rootDepth] ?? segs[segs.length - 1] ?? ''
  const mapped = SECTION_LABELS[raw.toLowerCase()]
  if (mapped) return mapped
  return titleCase(raw) || '其他'
}


/** 库视图：series（按剧聚合集数）+ movies（单行），各带覆盖聚合与最新 job。 */
export function buildLibrary(db: ScoutDb): LibraryItemDTO[] {
  const seriesRows = db
    .prepare(
      `SELECT id, name, chinese_title, year, poster_path FROM series ORDER BY name ASC`
    )
    .all() as SeriesRow[]

  // 每剧代表 path：取该剧任一集的 min(path)，用于派生分区
  const seriesPathRows = db
    .prepare(`SELECT series_id AS key, min(path) AS path FROM episodes GROUP BY series_id`)
    .all() as { key: string; path: string }[]
  const pathBySeriesId = new Map<string, string>()
  for (const row of seriesPathRows) pathBySeriesId.set(row.key, row.path)

  // series 覆盖聚合：按 (series_id, sub_status) 计数
  const seriesCoverage = db
    .prepare(
      `SELECT series_id AS key, sub_status, count(*) AS c FROM episodes GROUP BY series_id, sub_status`
    )
    .all() as CoverageRow[]
  const coverageBySeriesId = new Map<string, CoverageDTO>()
  for (const row of seriesCoverage) {
    let cov = coverageBySeriesId.get(row.key)
    if (!cov) {
      cov = emptyCoverage()
      coverageBySeriesId.set(row.key, cov)
    }
    addToCoverage(cov, row.sub_status, row.c)
  }

  // series 的最新 job（跨季取 max(id)）。双源过渡期：旧 kind='series_season' 与 v3
  // kind='worker_task'（payload.taskType 为 find_subtitle/realign）都算series活动；
  // orchestrate 类 worker_task（含 self-scan 触发用的合成 series_id 'self-scan-trigger'）
  // 是编排通道不是内容产出，故意排除，不当作库行徽章。series_id IS NOT NULL 顺带排掉
  // movie 目标的 find_subtitle worker_task（其 series_id 恒为 NULL）。
  const seriesJobs = db
    .prepare(
      `SELECT j.series_id AS key, j.state, j.priority FROM jobs j
       WHERE (j.kind = 'series_season'
              OR (j.kind = 'worker_task'
                  AND json_extract(j.payload,'$.taskType') IN ('find_subtitle','realign')))
         AND j.series_id IS NOT NULL
         AND j.id = (SELECT max(id) FROM jobs j2
                     WHERE (j2.kind = 'series_season'
                            OR (j2.kind = 'worker_task'
                                AND json_extract(j2.payload,'$.taskType') IN ('find_subtitle','realign')))
                       AND j2.series_id = j.series_id)`
    )
    .all() as JobRow[]
  const jobBySeriesId = new Map<string, LibraryJobDTO>()
  for (const j of seriesJobs) jobBySeriesId.set(j.key, { state: j.state, priority: j.priority })

  const movieRows = db
    .prepare(
      `SELECT id, name, chinese_title, year, poster_path, path, sub_status FROM movies ORDER BY name ASC`
    )
    .all() as MovieRow[]

  // 媒体根深度：series 代表 path + movie path 一起求最长公共祖先（零配置对齐用户库根）
  const allPaths = [...pathBySeriesId.values(), ...movieRows.map((m) => m.path)]
  const rootDepth = commonRootDepth(allPaths)

  const seriesItems: LibraryItemDTO[] = seriesRows.map((s) => ({
    id: s.id,
    kind: 'series',
    name: s.name,
    chineseTitle: s.chinese_title,
    year: s.year,
    posterPath: s.poster_path,
    section: sectionOf(pathBySeriesId.get(s.id) ?? '', rootDepth),
    coverage: coverageBySeriesId.get(s.id) ?? emptyCoverage(),
    job: jobBySeriesId.get(s.id) ?? null,
  }))

  // movie 的最新 job：同理双源。makeDispatchFindSubtitleTaskTool → upsertWorkerTask 把
  // movieId 写进 movie_id 列本身（不是只落 payload，见 jobsRepo.ts upsertWorkerTask 的
  // INSERT 列表），故直接按列过滤，不需要 json_extract movieId。realign 无 movie 目标
  // （dispatch_realign_task 恒 movieId:null），故这里只认 find_subtitle。
  const movieJobs = db
    .prepare(
      `SELECT j.movie_id AS key, j.state, j.priority FROM jobs j
       WHERE (j.kind = 'movie'
              OR (j.kind = 'worker_task'
                  AND json_extract(j.payload,'$.taskType') = 'find_subtitle'))
         AND j.movie_id IS NOT NULL
         AND j.id = (SELECT max(id) FROM jobs j2
                     WHERE (j2.kind = 'movie'
                            OR (j2.kind = 'worker_task'
                                AND json_extract(j2.payload,'$.taskType') = 'find_subtitle'))
                       AND j2.movie_id = j.movie_id)`
    )
    .all() as JobRow[]
  const jobByMovieId = new Map<string, LibraryJobDTO>()
  for (const j of movieJobs) jobByMovieId.set(j.key, { state: j.state, priority: j.priority })

  const movieItems: LibraryItemDTO[] = movieRows.map((m) => {
    const coverage = emptyCoverage()
    addToCoverage(coverage, m.sub_status, 1)
    return {
      id: m.id,
      kind: 'movie',
      name: m.name,
      chineseTitle: m.chinese_title,
      year: m.year,
      posterPath: m.poster_path,
      section: sectionOf(m.path, rootDepth),
      coverage,
      job: jobByMovieId.get(m.id) ?? null,
    }
  })

  return [...seriesItems, ...movieItems]
}

// ---- Series detail (剧详情) ----

export interface SeriesEpisodeDTO {
  id: string
  episode: number
  name: string | null
  subStatus: string
  statusReason: string | null
  recheckAfter: number | null
}
export interface SeriesSeasonDTO {
  season: number
  episodes: SeriesEpisodeDTO[]
}
export interface SeriesRunDTO {
  startedAt: number
  finishedAt: number | null
  decision: string | null
  detail: string | null
  journalPath: string | null
}
export interface SeriesDetailDTO {
  id: string
  name: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  seasons: SeriesSeasonDTO[]
  runs: SeriesRunDTO[]
}

interface EpisodeDetailRow {
  id: string
  season: number
  episode: number
  name: string | null
  sub_status: string
  status_reason: string | null
  recheck_after: number | null
}
interface RunDetailRow {
  started_at: number
  finished_at: number | null
  decision: string | null
  detail: string | null
  journal_path: string | null
}

/** 剧详情：按季分节的集清单 + 经 job_id 关联该剧的 runs 时间线。未找到返回 null。 */
export function buildSeriesDetail(db: ScoutDb, id: string): SeriesDetailDTO | null {
  const series = db
    .prepare(`SELECT id, name, chinese_title, year, poster_path FROM series WHERE id = ?`)
    .get(id) as SeriesRow | undefined
  if (!series) return null

  const episodes = db
    .prepare(
      `SELECT id, season, episode, name, sub_status, status_reason, recheck_after
       FROM episodes WHERE series_id = ? ORDER BY season ASC, episode ASC`
    )
    .all(id) as EpisodeDetailRow[]

  const seasons: SeriesSeasonDTO[] = []
  const seasonIndex = new Map<number, SeriesSeasonDTO>()
  for (const ep of episodes) {
    let season = seasonIndex.get(ep.season)
    if (!season) {
      season = { season: ep.season, episodes: [] }
      seasonIndex.set(ep.season, season)
      seasons.push(season)
    }
    season.episodes.push({
      id: ep.id,
      episode: ep.episode,
      name: ep.name,
      subStatus: ep.sub_status,
      statusReason: ep.status_reason,
      recheckAfter: ep.recheck_after,
    })
  }

  // 双源同 buildLibrary：v3 worker_task（find_subtitle/realign）runs 行也计入本剧时间线。
  const runRows = db
    .prepare(
      `SELECT r.started_at, r.finished_at, r.decision, r.detail, r.journal_path
       FROM runs r JOIN jobs j ON r.job_id = j.id
       WHERE (j.kind = 'series_season'
              OR (j.kind = 'worker_task'
                  AND json_extract(j.payload,'$.taskType') IN ('find_subtitle','realign')))
         AND j.series_id = ?
       ORDER BY r.id DESC`
    )
    .all(id) as RunDetailRow[]

  const runs: SeriesRunDTO[] = runRows.map((r) => ({
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    decision: r.decision,
    detail: r.detail,
    journalPath: r.journal_path,
  }))

  return {
    id: series.id,
    name: series.name,
    chineseTitle: series.chinese_title,
    year: series.year,
    posterPath: series.poster_path,
    seasons,
    runs,
  }
}

// ---- Global runs history (运行历史页) ----

export interface RunHistoryDTO {
  id: number
  jobId: number | null
  startedAt: number
  finishedAt: number | null
  decision: string | null
  detail: string | null
  journalPath: string | null
}

interface RunHistoryRow {
  id: number
  job_id: number | null
  started_at: number
  finished_at: number | null
  decision: string | null
  detail: string | null
  journal_path: string | null
}

/** 全局历史：runs 表按 id desc 分页（默认 limit 50）。 */
export function buildRuns(db: ScoutDb, offset: number, limit: number): RunHistoryDTO[] {
  const rows = db
    .prepare(
      `SELECT id, job_id, started_at, finished_at, decision, detail, journal_path
       FROM runs ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as RunHistoryRow[]
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    decision: r.decision,
    detail: r.detail,
    journalPath: r.journal_path,
  }))
}

// ---- Reconcile-all (v3 phase ⑦ "全仓校验" 触发器) ----

/** Structurally matches src/agent/orchestratorAgent.ts's OrchestratorDecision — declared as its
 *  own DTO here (not imported from agent/) to keep this dashboard-facing layer decoupled from
 *  agent internals, same boundary convention as every other *DTO in this file. */
export interface ReconcileAllResultDTO {
  dispatchedFindSubtitle: number
  dispatchedRealign: number
  spawnedSiblings: number
  summary: string
}

// ---- Parked (去 Jellyfin 化 P6：最小 park 救援——一次性脚手架，不做搜索/候选/批量) ----

export interface ParkedItemDTO {
  path: string
  parkReason: string
  firstSeen: number
  lastAttempt: number
}

/** park 救援页列表：转发 LibraryRepo.listParkedPaths()（已 first_seen DESC 排序，挂得最久的排最前）。 */
export function buildParked(db: ScoutDb): ParkedItemDTO[] {
  return new LibraryRepo(db).listParkedPaths().map((p) => ({
    path: p.path,
    parkReason: p.park_reason,
    firstSeen: p.first_seen,
    lastAttempt: p.last_attempt,
  }))
}

export type ClaimParkedResult = { ok: true } | { ok: false; error: string }

/**
 * park 救援页认领：校验后写一条 identify_overrides。覆盖目标是 path 所在的**目录**
 * （dirname(path)，前缀匹配），不是这一个文件本身——同一部剧的其它集通常散在同一目录下，
 * 一次认领顺带救活整目录的兄弟集（LibraryRepo.findOverride 的最长前缀匹配语义）。
 *
 * 注意：这里**不**调用 clearParkedPath——认领只写 override，不代摄取层清 parked_paths 那一行。
 * 下一轮巡检 recognize() 命中这条 override、重新识别成功后，识别层自己调用 clearParkedPath
 * （T3 既有逻辑），parked_paths 这张表的"是否还挂着"由巡检的真实识别结果唯一决定，不由这个
 * 认领端点越权代劳——保持单一数据源。
 */
export function claimParked(
  db: ScoutDb,
  input: { path: string; tmdbId: string; isTv: boolean }
): ClaimParkedResult {
  const { path, tmdbId, isTv } = input
  if (!path) return { ok: false, error: 'path is required' }
  if (!/^\d+$/.test(tmdbId)) return { ok: false, error: 'tmdbId must be a numeric string' }

  const lib = new LibraryRepo(db)
  const parked = lib.listParkedPaths().some((p) => p.path === path)
  if (!parked) return { ok: false, error: 'path is not currently parked' }

  lib.addOverride(dirname(path), tmdbId, isTv, Date.now())
  return { ok: true }
}
