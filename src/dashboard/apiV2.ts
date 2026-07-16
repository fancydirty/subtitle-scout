// src/dashboard/apiV2.ts
// v2 媒体库只读数据层：纯函数收 ScoutDb 返回 DTO（对照 api.ts 风格）。海报直接暴露 TMDB
// poster_path，前端自行拼 CDN URL（image.tmdb.org，公开、免 key）——不再经服务端代理。
import { dirname, resolve } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { z } from 'zod'
import type { ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import type { SettingsRepo } from '../v2/settingsRepo.js'
import type { JobsRepo, WorkerTaskUpsertOutcome } from '../v2/jobsRepo.js'
import { canonicalEpisodes } from '../v2/tmdbCatalog.js'
import { traceBus, type TraceEvent } from './traceBus.js'
// 清算波 R-6（F9b）：只为下面的文档注释引用真实常量，而不是把它的字符串值抄一份陈旧副本
// （旧值 'self-scan-trigger' 已在去 Jellyfin 化 T4 改名为 INGEST_ORCHESTRATE_SERIES_ID=
// 'ingest-trigger'——注释里继续写旧值会误导读者去 grep 一个早已不存在的字符串）。
import { INGEST_ORCHESTRATE_SERIES_ID } from '../daemon/ingestTrigger.js'

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
  // orchestrate 类 worker_task（含 ingest 触发用的合成 series_id，见上方导入的
  // INGEST_ORCHESTRATE_SERIES_ID 常量）是编排通道不是内容产出，故意排除（用
  // taskType IN ('find_subtitle','realign') 白名单实现，不逐个 series_id 拉黑——INGEST_
  // ORCHESTRATE_SERIES_ID 本身也自然落在这条白名单外，无需再单独判它），不当作库行徽章。
  // series_id IS NOT NULL 顺带排掉 movie 目标的 find_subtitle worker_task（其 series_id 恒为 NULL）。
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
 *
 * P7 disambiguation 补丁：可选 season 入参——多季剧下裸集号有歧义（见 ingest.ts 的
 * override-ambiguous-numbering 守卫），认领时把季一起给上就能让 recognize() 直接构造出无歧义
 * 的 (season, episode)，绕开那道守卫。省略/传 null = 未指定（原有行为，交给 ingest 层判断单季
 * 剧可以无歧义折算、多季剧则诚实 park）。传了就必须是正整数——不接受 0/负数/小数，那些不是
 * 合法的季号，静默接受只会把一个用户输入错误伪装成"认领成功"。
 */
export function claimParked(
  db: ScoutDb,
  input: { path: string; tmdbId: string; isTv: boolean; season?: number | null }
): ClaimParkedResult {
  const { path, tmdbId, isTv, season } = input
  if (!path) return { ok: false, error: 'path is required' }
  if (!/^\d+$/.test(tmdbId)) return { ok: false, error: 'tmdbId must be a numeric string' }
  if (season !== undefined && season !== null && !(Number.isInteger(season) && season > 0)) {
    return { ok: false, error: 'season must be a positive integer' }
  }

  const lib = new LibraryRepo(db)
  const parked = lib.listParkedPaths().some((p) => p.path === path)
  if (!parked) return { ok: false, error: 'path is not currently parked' }

  lib.addOverride(dirname(path), tmdbId, isTv, Date.now(), season ?? null)
  return { ok: true }
}

// ---- Settings（dashboard 重建战役 G4：settings 表 + 守备目录 + 部署层只读展示） ----

/** spec §7 权威白名单——行为级设置的唯一合法 key 集合。本战役里只有 target_languages 真被
 *  消费（targetLanguages.ts 的 resolveTargetLanguages 第二参）；其余四键此刻只存取展示，值域
 *  校验在下方 updateSettings 的 zod 门（PUT /api/v2/settings 经 server.ts 转call），这里只负责
 *  "读的时候只读这五个"。 */
export const SETTINGS_KEYS = [
  'target_languages', 'hardsub_mode', 'exclude_extras', 'trace_retention_days', 'scan_interval_ms',
] as const
export type SettingsKey = typeof SETTINGS_KEYS[number]
export type SettingsDTO = Record<SettingsKey, string | null>

/** GET /api/v2/settings：白名单五键各自 get()，未设置=null（前端自行显示默认值，不由后端
 *  编造一份"默认值"跟真实存量状态混在一起）。 */
export function buildSettings(settingsRepo: Pick<SettingsRepo, 'get'>): SettingsDTO {
  const result = {} as SettingsDTO
  for (const key of SETTINGS_KEYS) result[key] = settingsRepo.get(key)
  return result
}

// ---- Deploy settings（GET /api/v2/settings/deploy：env 脱敏只读，Jellyfin 式部署/产品分界）----

/** 密钥类 env——绝不回显明文，只答"配了没有"+ 尾 4 位供人眼核对"是不是我以为的那把钥匙"。
 *  枚举来源：README「环境变量总表」+ src 内 process.env.* 全量 grep 核对（cli/index.ts、
 *  cli/doctor.ts、adapters/providers/*）。 */
const DEPLOY_SECRET_KEYS = [
  'TMDB_API_KEY', 'LLM_API_KEY', 'DASHBOARD_TOKEN',
  'ASSRT_TOKEN', 'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD',
] as const

/** 非机密 env——部署层信息，原样字符串展示（未设置为 null）帮助排障，不脱敏。 */
const DEPLOY_NONSECRET_KEYS = [
  'LLM_BASE_URL', 'LLM_MODEL', 'LLM_EXTRA_BODY', 'OPENSUBTITLES_USERNAME', 'ZIMUKU_ENABLED',
  'DASHBOARD_PORT', 'SUBTITLE_SCOUT_CACHE_DIR', 'LOG_RETAIN_DAYS', 'REALIGN_ARCHIVE_ROOT',
  'FFPROBE_PATH', 'SCAN_INTERVAL_MS', 'MEDIA_ROOTS',
] as const

export interface DeploySecretDTO { present: boolean; tail: string }
export interface DeploySettingsDTO {
  secrets: Record<(typeof DEPLOY_SECRET_KEYS)[number], DeploySecretDTO>
  nonSecrets: Record<(typeof DEPLOY_NONSECRET_KEYS)[number], string | null>
}

/** 尾 4 位，不足 4 位全遮（不直接回显短密钥的任何真实字符，遮罩长度仍等于原长度，供人眼判断
 *  "有没有配置"而不泄露内容）。 */
function maskSecret(v: string | undefined): DeploySecretDTO {
  if (!v) return { present: false, tail: '' }
  return { present: true, tail: v.length >= 4 ? v.slice(-4) : '*'.repeat(v.length) }
}

export function buildDeploySettings(env: Record<string, string | undefined>): DeploySettingsDTO {
  const secrets = {} as DeploySettingsDTO['secrets']
  for (const key of DEPLOY_SECRET_KEYS) secrets[key] = maskSecret(env[key])
  const nonSecrets = {} as DeploySettingsDTO['nonSecrets']
  for (const key of DEPLOY_NONSECRET_KEYS) nonSecrets[key] = env[key] ?? null
  return { secrets, nonSecrets }
}

// ---- fs/list（GET /api/v2/fs/list：dashboard 加根 UI 的目录选择器，Jellyfin 同款“挂载即可见”）----

export type FsListResult = { ok: true; dirs: string[] } | { ok: false; error: string }

/** 只列子**目录**名（排序），绝不列文件、绝不读文件内容——容器挂载本身就是可见性边界，这里
 *  不设额外白名单（同 Jellyfin 的目录选择器思路：能挂进容器的目录才可能被看到，配置只是在
 *  已挂载范围内挑选，不是打开一个任意读盘接口）。path 必须是绝对路径；resolve 后
 *  existsSync + isDirectory 才列，否则给一个诚实的 4xx 语义（ok:false + error）而不是抛错。
 *  复审修复 2：statSync/readdirSync 对权限拒绝（EACCES，NAS 挂载常态）会同步抛错——这是用户
 *  点目录浏览器时的正常路况，不是服务器故障，同样收敛成 ok:false，不许炸到 server.ts 变 500。 */
export function listMediaSubdirs(rawPath: string): FsListResult {
  if (!rawPath.startsWith('/')) return { ok: false, error: 'path must be an absolute path' }
  const resolved = resolve(rawPath)
  if (!existsSync(resolved)) return { ok: false, error: 'path does not exist' }
  try {
    const stat = statSync(resolved)
    if (!stat.isDirectory()) return { ok: false, error: 'path is not a directory' }
    const dirs = readdirSync(resolved, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    return { ok: true, dirs }
  } catch {
    return { ok: false, error: 'path is not readable (permission denied?)' }
  }
}

// ---- Settings 写入（PUT /api/v2/settings、POST/DELETE /api/v2/settings/roots）----
// server.ts 的独立 rawPath 分支只做 method/token 门 + body 解析，业务校验与写入收在这里
// （同 claimParked 的既有分层：server.ts 薄，判断逻辑集中在这一层可单测）。

/** spec §7 权威值域——每个白名单键各自的取值校验（"repo 只管字符串存取，值域校验在调用方
 *  边界做"，这里就是那个边界）。 */
const SETTINGS_VALUE_SCHEMAS: Record<SettingsKey, z.ZodType<string>> = {
  target_languages: z
    .string()
    .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*(,[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)*$/, 'must be comma-separated BCP-47 primary codes, e.g. "zh,en"'),
  hardsub_mode: z.enum(['off', 'agent', 'aggressive']),
  exclude_extras: z.enum(['true', 'false']),
  trace_retention_days: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer string'),
  scan_interval_ms: z.string().regex(/^[1-9][0-9]*$/, 'must be a positive integer string'),
}

export type UpdateSettingsResult = { ok: true; settings: SettingsDTO } | { ok: false; error: string }

/** PUT /api/v2/settings body 处理：白名单外的键 400；每键按值域校验，任一项不合法整体 400
 *  （全有或全无——不做"合法的先写、非法的报错"的部分成功，避免半成品状态混进设置表）。全部
 *  通过才落库，返回写入后的全量 settings（前端直接刷新展示，不用再发一次 GET）。 */
export function updateSettings(
  settingsRepo: Pick<SettingsRepo, 'get' | 'set'>, body: unknown, now: number,
): UpdateSettingsResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object of setting key-value pairs' }
  }
  const entries = Object.entries(body as Record<string, unknown>)
  for (const [key, value] of entries) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown setting key: ${key}` }
    }
    if (typeof value !== 'string') {
      return { ok: false, error: `setting ${key} must be a string` }
    }
    const parsed = SETTINGS_VALUE_SCHEMAS[key as SettingsKey].safeParse(value)
    if (!parsed.success) {
      return { ok: false, error: `setting ${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}` }
    }
  }
  for (const [key, value] of entries) settingsRepo.set(key, value as string, now)
  return { ok: true, settings: buildSettings(settingsRepo) }
}

export type AddMediaRootResult = { ok: true } | { ok: false; error: string }

/** POST /api/v2/settings/roots body={path} 处理：绝对路径 + 磁盘上存在 + 是目录才收——同
 *  listMediaSubdirs 的判定口径（Jellyfin 式"挂载即可见"边界，这里只是收窄到"必须先能列出来
 *  才能加"）。路径经 resolve() 归一化后落库（去掉冗余的尾斜杠/`.`/`..` 片段），避免同一个
 *  目录因写法不同（"/media/tv" vs "/media/tv/"）被误判成两个不同的根。addRoot 本身幂等
 *  （INSERT OR IGNORE），重复提交同一归一化路径直接 200，不报错。 */
export function addMediaRoot(
  settingsRepo: Pick<SettingsRepo, 'addRoot'>, rawPath: unknown, now: number,
): AddMediaRootResult {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, error: 'path is required' }
  }
  if (!rawPath.startsWith('/')) {
    return { ok: false, error: 'path must be an absolute path' }
  }
  const resolved = resolve(rawPath)
  if (!existsSync(resolved)) {
    return { ok: false, error: 'path does not exist' }
  }
  // 复审修复 2：同 listMediaSubdirs——statSync 对权限拒绝（EACCES）的同步抛错收敛成 ok:false
  // 的 4xx 语义（用户给了一个进程无权探测的路径是输入问题，不是服务器故障）。
  try {
    if (!statSync(resolved).isDirectory()) {
      return { ok: false, error: 'path is not a directory' }
    }
  } catch {
    return { ok: false, error: 'path is not readable (permission denied?)' }
  }
  settingsRepo.addRoot(resolved, now)
  return { ok: true }
}

// ---- dashboard 重建战役 G5：workflow/library/甄别聚合 API ----
// 北极星约束：这些端点是纯读聚合 + 两个人类扳手（redispatch/claim）——全部走既有 repo/模块，
// 不新增任何判断逻辑。机械层产出事实，不产出指令。

// ---- workflow/pending：缺口事实 + parked 计数 + 顶栏新鲜度行 ----

export interface WorkflowPendingSeriesDTO {
  seriesId: string
  seriesName: string
  season: number
  missing: number
  throttled: number
  nextRecheckAt: number | null
  sampleReason: string | null
}
export interface WorkflowPendingMovieDTO {
  id: string
  name: string
  missing: 0 | 1
  throttled: 0 | 1
  nextRecheckAt: number | null
  sampleReason: string | null
}
export interface WorkflowFreshnessDTO {
  /** settingsRepo.listRoots() 的路径列表。 */
  roots: string[]
  /** meta 表 'last_ingest_at' 键（摄取层每轮心跳的真实写入点，见 v2/daemon.ts tickInner；
   *  db.ts 注释里提到的 'last_reconcile_at' 未见任何代码路径写入，核实后改用真正被写的键）。
   *  从未摄取过（首启/空库）时为 null。 */
  lastScanAt: number | null
  /** episodes + movies 两表行数之和——库内文件总量的机械计数。 */
  files: number
}
export interface WorkflowPendingDTO {
  series: WorkflowPendingSeriesDTO[]
  movies: WorkflowPendingMovieDTO[]
  parked: number
  meta: WorkflowFreshnessDTO
}

/** GET /api/v2/workflow/pending：libraryRepo.missingBySeason/missingMovies 直译 camelCase +
 *  parked_paths 计数 + 顶栏新鲜度行。纯读聚合，不做任何"该不该派"的判断——那是 orchestrator
 *  的事，这里只把缺口事实摆出来。 */
export function buildWorkflowPending(
  db: ScoutDb, settingsRepo: Pick<SettingsRepo, 'listRoots'>, now: number,
): WorkflowPendingDTO {
  const lib = new LibraryRepo(db)

  const series: WorkflowPendingSeriesDTO[] = lib.missingBySeason(now).map((r) => ({
    seriesId: r.series_id, seriesName: r.series_name, season: r.season,
    missing: r.missing, throttled: r.throttled, nextRecheckAt: r.next_recheck_at, sampleReason: r.sample_reason,
  }))
  const movies: WorkflowPendingMovieDTO[] = lib.missingMovies(now).map((r) => ({
    id: r.id, name: r.name, missing: r.missing, throttled: r.throttled,
    nextRecheckAt: r.next_recheck_at, sampleReason: r.sample_reason,
  }))
  const parked = lib.listParkedPaths().length

  const lastScanRow = db.prepare(`SELECT value FROM meta WHERE key = 'last_ingest_at'`).get() as
    | { value: string }
    | undefined
  const filesRow = db
    .prepare(`SELECT (SELECT COUNT(*) FROM episodes) + (SELECT COUNT(*) FROM movies) AS c`)
    .get() as { c: number }

  return {
    series, movies, parked,
    meta: {
      roots: settingsRepo.listRoots().map((r) => r.path),
      lastScanAt: lastScanRow ? Number(lastScanRow.value) : null,
      files: filesRow.c,
    },
  }
}

// ---- workflow/passes：orchestrate 通行记录 + receipts（纯解析 trace_json 快照，不是新账目）----

export interface DispatchReceiptsDTO {
  created: number
  revived: number
  coalesced: number
  blocked_dormant: number
  unknown: number
}
export interface WorkflowPassDTO {
  id: number
  jobId: number | null
  startedAt: number
  finishedAt: number | null
  detail: string | null
  receipts: DispatchReceiptsDTO
}

interface OrchestrateRunRow {
  id: number
  job_id: number | null
  started_at: number
  finished_at: number | null
  detail: string | null
  trace_json: string | null
}

const DISPATCH_OUTCOME_RE = /"outcome"\s*:\s*"(created|revived|coalesced|blocked_dormant)"/

/** 把一行 orchestrate run 的 trace_json 快照解析成 receipts 计数：遍历事件，只看 tool 以
 *  'dispatch_' 开头的行（dispatch_find_subtitle_task/dispatch_realign_task——spawn_sibling_
 *  orchestrator 故意不算，那是分片交接不是缺口派发），从 resultSummary 里正则提取四态之一；
 *  提不出来（被 200 字符截断，或压根没有 outcome 字段）计入 unknown。这是纯解析呈现，不是
 *  新账目——traceBus 收官快照本身就是唯一真源，这里只是把它翻译给人看。 */
function parseDispatchReceipts(traceJson: string | null): DispatchReceiptsDTO {
  const receipts: DispatchReceiptsDTO = { created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 }
  if (!traceJson) return receipts

  let events: TraceEvent[]
  try {
    events = JSON.parse(traceJson) as TraceEvent[]
  } catch {
    return receipts
  }

  for (const e of events) {
    if (!e.tool || !e.tool.startsWith('dispatch_')) continue
    const match = DISPATCH_OUTCOME_RE.exec(e.resultSummary ?? '')
    if (match) receipts[match[1] as keyof DispatchReceiptsDTO]++
    else receipts.unknown++
  }
  return receipts
}

/** GET /api/v2/workflow/passes?limit=20：orchestrate runs 行（decision='orchestrate'），
 *  finished_at 降序；limit 由调用方（router.ts）clamp 到 [1,100] 后传入，这里原样消费
 *  （同 buildRuns 的既有分工：clamp 在路由层，聚合函数只管查询）。 */
export function buildWorkflowPasses(db: ScoutDb, limit: number): WorkflowPassDTO[] {
  const rows = db
    .prepare(
      `SELECT id, job_id, started_at, finished_at, detail, trace_json FROM runs
       WHERE decision = 'orchestrate' ORDER BY finished_at DESC LIMIT ?`
    )
    .all(limit) as OrchestrateRunRow[]
  return rows.map((r) => ({
    id: r.id, jobId: r.job_id, startedAt: r.started_at, finishedAt: r.finished_at, detail: r.detail,
    receipts: parseDispatchReceipts(r.trace_json),
  }))
}

// ---- workflow/workers：跑中的 worker_task + 近期非 orchestrate runs ----

export interface WorkflowRunningWorkerDTO {
  jobId: number
  seriesId: string | null
  movieId: string | null
  taskType: string | null
  seasons: number[] | null
  /** jobs.updated_at——本轮 claim/续租发生的时刻，jobs 表没有独立的 started_at 列，这是最接近
   *  "这个租约/尝试何时开始"的既有字段（同 claimNext/renewLease 都会刷新它）。 */
  startedAtLease: number
  /** traceBus.peek(`job-${jobId}`, 20) 的直播补拉——非破坏性读尾部 20 条，不影响该 job 收官时
   *  的 snapshot。 */
  trail: TraceEvent[]
}
export interface WorkflowRecentRunDTO {
  jobId: number | null
  decision: string | null
  detail: string | null
  finishedAt: number | null
}
export interface WorkflowWorkersDTO {
  running: WorkflowRunningWorkerDTO[]
  recent: WorkflowRecentRunDTO[]
}

/** worker_task 的 payload JSON 里取 taskType/seasons——容错解析（同 buildLibrary 对 worker_task
 *  payload 的既有查法口径一致），格式异常一律降级为 null，不炸聚合查询。 */
function parseWorkerTaskPayload(payload: string | null): { taskType: string | null; seasons: number[] | null } {
  if (!payload) return { taskType: null, seasons: null }
  try {
    const parsed = JSON.parse(payload) as { taskType?: unknown; seasons?: unknown }
    const taskType = typeof parsed.taskType === 'string' ? parsed.taskType : null
    const seasons = Array.isArray(parsed.seasons)
      ? parsed.seasons.filter((s): s is number => typeof s === 'number')
      : null
    return { taskType, seasons }
  } catch {
    return { taskType: null, seasons: null }
  }
}

/** GET /api/v2/workflow/workers：running=jobs 里 state='searching' 且 kind='worker_task' 的
 *  跑中行（附 traceBus.peek 直播补拉）；recent=非 orchestrate 的 runs 行（find_subtitle/realign
 *  worker 各自产出的收工记录），finished_at 降序 limit 20。 */
export function buildWorkflowWorkers(db: ScoutDb): WorkflowWorkersDTO {
  const runningRows = db
    .prepare(
      `SELECT id, series_id, movie_id, payload, updated_at FROM jobs
       WHERE state = 'searching' AND kind = 'worker_task'`
    )
    .all() as { id: number; series_id: string | null; movie_id: string | null; payload: string | null; updated_at: number }[]

  const running: WorkflowRunningWorkerDTO[] = runningRows.map((r) => {
    const { taskType, seasons } = parseWorkerTaskPayload(r.payload)
    return {
      jobId: r.id, seriesId: r.series_id, movieId: r.movie_id, taskType, seasons,
      startedAtLease: r.updated_at, trail: traceBus.peek(`job-${r.id}`, 20),
    }
  })

  const recentRows = db
    .prepare(
      `SELECT job_id, decision, detail, finished_at FROM runs
       WHERE decision IS NULL OR decision != 'orchestrate'
       ORDER BY finished_at DESC LIMIT 20`
    )
    .all() as { job_id: number | null; decision: string | null; detail: string | null; finished_at: number | null }[]
  const recent: WorkflowRecentRunDTO[] = recentRows.map((r) => ({
    jobId: r.job_id, decision: r.decision, detail: r.detail, finishedAt: r.finished_at,
  }))

  return { running, recent }
}

// ---- library/series/:id：三层格阵合并呈现（canonical ∪ 磁盘 ∪ 覆盖）----

export interface LibrarySeriesSummaryDTO {
  id: string
  name: string
  chineseTitle: string | null
  posterPath: string | null
  year: number | null
  layoutNonstandard: boolean
}
export interface LibraryCanonicalEpisodeDTO {
  episode: number
  title: string | null
}
export interface LibraryOnDiskEpisodeDTO {
  episode: number
  path: string
  subStatus: string
  statusReason: string | null
  recheckAfter: number | null
}
export interface LibraryCoverageRowDTO {
  episode: number
  lang: string
  path: string
}
export interface LibrarySeasonDTO {
  season: number
  canonical: LibraryCanonicalEpisodeDTO[]
  onDisk: LibraryOnDiskEpisodeDTO[]
  coverage: LibraryCoverageRowDTO[]
}
export interface LibrarySeriesDetailDTO {
  series: LibrarySeriesSummaryDTO
  seasons: LibrarySeasonDTO[]
}

interface LibrarySeriesRow {
  id: string
  name: string
  chinese_title: string | null
  poster_path: string | null
  year: number | null
  layout_nonstandard: number
}
interface OnDiskEpisodeRow {
  season: number
  episode: number
  path: string
  sub_status: string
  status_reason: string | null
  recheck_after: number | null
}
interface CoverageJoinRow {
  season: number
  episode: number
  lang: string
  path: string
}

/** GET /api/v2/library/series/:id：series 行直译 + 季号并集（canonical ∪ 磁盘）升序 + 各季
 *  三层数据（tmdbCatalog.canonicalEpisodes 应有集 / episodes 磁盘现状 / subtitles join 覆盖
 *  行）。未找到返回 null（404 语义）。惰性 TMDB 缓存刷新不在这里做——那是 server.ts 的 wiring
 *  职责（DashboardOpts.tmdb，fire-and-forget），这个函数保持纯同步、只读 ScoutDb。 */
export function buildLibrarySeriesDetail(db: ScoutDb, id: string): LibrarySeriesDetailDTO | null {
  const row = db
    .prepare(`SELECT id, name, chinese_title, poster_path, year, layout_nonstandard FROM series WHERE id = ?`)
    .get(id) as LibrarySeriesRow | undefined
  if (!row) return null

  const onDiskRows = db
    .prepare(
      `SELECT season, episode, path, sub_status, status_reason, recheck_after FROM episodes
       WHERE series_id = ? ORDER BY season ASC, episode ASC`
    )
    .all(id) as OnDiskEpisodeRow[]

  const canonicalSeasonRows = db
    .prepare(`SELECT DISTINCT season FROM tmdb_seasons WHERE series_id = ?`)
    .all(id) as { season: number }[]

  const coverageRows = db
    .prepare(
      `SELECT e.season AS season, e.episode AS episode, sub.language AS lang, sub.path AS path
       FROM subtitles sub JOIN episodes e ON e.id = sub.item_id
       WHERE e.series_id = ?`
    )
    .all(id) as CoverageJoinRow[]

  const seasonNumbers = new Set<number>()
  for (const r of onDiskRows) seasonNumbers.add(r.season)
  for (const r of canonicalSeasonRows) seasonNumbers.add(r.season)
  const sortedSeasons = [...seasonNumbers].sort((a, b) => a - b)

  const seasons: LibrarySeasonDTO[] = sortedSeasons.map((season) => ({
    season,
    canonical: canonicalEpisodes(db, id, season),
    onDisk: onDiskRows
      .filter((r) => r.season === season)
      .map((r) => ({
        episode: r.episode, path: r.path, subStatus: r.sub_status,
        statusReason: r.status_reason, recheckAfter: r.recheck_after,
      })),
    coverage: coverageRows
      .filter((r) => r.season === season)
      .map((r) => ({ episode: r.episode, lang: r.lang, path: r.path })),
  }))

  return {
    series: {
      id: row.id, name: row.name, chineseTitle: row.chinese_title, posterPath: row.poster_path,
      year: row.year, layoutNonstandard: row.layout_nonstandard === 1,
    },
    seasons,
  }
}

// ---- triage（甄别台）：pending=park 救援清单 + claimed=已认领 override 清单 ----

export interface ClaimedOverrideDTO {
  pathPrefix: string
  tmdbId: string
  isTv: boolean
  season: number | null
  createdAt: number
}
export interface TriageDTO {
  pending: ParkedItemDTO[]
  claimed: ClaimedOverrideDTO[]
}

interface IdentifyOverrideRow {
  path_prefix: string
  tmdb_id: string
  is_tv: number
  season: number | null
  created_at: number
}

/** identify_overrides 全行直译（created_at desc——最近认领的排最前，同 buildParked 的
 *  "越紧急/越新越靠前"呈现习惯）。 */
function buildClaimedOverrides(db: ScoutDb): ClaimedOverrideDTO[] {
  const rows = db
    .prepare(`SELECT path_prefix, tmdb_id, is_tv, season, created_at FROM identify_overrides ORDER BY created_at DESC`)
    .all() as IdentifyOverrideRow[]
  return rows.map((r) => ({
    pathPrefix: r.path_prefix, tmdbId: r.tmdb_id, isTv: r.is_tv === 1, season: r.season, createdAt: r.created_at,
  }))
}

/** GET /api/v2/triage：pending 转发 buildParked（含 reason），claimed 转发 identify_overrides
 *  全行直译——甄别台一页看全"待认领"与"已认领"两份事实。 */
export function buildTriage(db: ScoutDb): TriageDTO {
  return { pending: buildParked(db), claimed: buildClaimedOverrides(db) }
}

// ---- workflow/redispatch（人类扳手①：手动重派）----

export type RedispatchResult =
  | { ok: true; outcome: WorkerTaskUpsertOutcome }
  | { ok: false; error: string }

const REDISPATCH_SCHEMA = z.object({
  seriesId: z.string().min(1),
  seasons: z.array(z.number().int().positive()).optional(),
  includeThrottled: z.boolean().optional(),
})

/** POST /api/v2/workflow/redispatch：zod 校验后转调 jobs.upsertWorkerTask——与
 *  orchestratorAgent.tools.ts 的 dispatch_find_subtitle_task 工具逐字段同形（同一份身份元组、
 *  同一个 taskType='find_subtitle'），reason 固定标注"manual redispatch from dashboard"以便
 *  在 runs/日志里区分人工重派与 orchestrator 自主派发。回执 WorkerTaskUpsertOutcome 原样返回
 *  ——created/revived/coalesced/blocked_dormant 四态都是事实，不是错误，调用方（server.ts）统一
 *  按 200 回应；只有 zod 校验本身不通过才是 ok:false（对应 400）。 */
export function redispatch(
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>, body: unknown, now: number,
): RedispatchResult {
  const parsed = REDISPATCH_SCHEMA.safeParse(body)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid body' }
  }
  const { seriesId, seasons, includeThrottled } = parsed.data
  const outcome = jobs.upsertWorkerTask(
    { seriesId, season: null, movieId: null },
    {
      taskType: 'find_subtitle', seasons: seasons && seasons.length > 0 ? seasons : null,
      reason: 'manual redispatch from dashboard', includeThrottled: !!includeThrottled,
    },
    null, now,
  )
  return { ok: true, outcome }
}
