// web/src/api/types.ts：必须与 src/dashboard/apiV2.ts 的 DTO 保持一致
export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored'

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
  posterPath: string | null
  section: string
  coverage: CoverageDTO
  job: LibraryJobDTO | null
}

export interface SeriesEpisodeDTO {
  id: string
  episode: number
  name: string | null
  subStatus: SubStatus
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

export interface RunHistoryDTO {
  id: number
  jobId: number | null
  startedAt: number
  finishedAt: number | null
  decision: string | null
  detail: string | null
  journalPath: string | null
}

/** v3 phase ⑦："全仓校验"结果——POST /api/v2/reconcile-all 的响应体。 */
export interface ReconcileAllResultDTO {
  dispatchedFindSubtitle: number
  dispatchedRealign: number
  spawnedSiblings: number
  summary: string
}

/** 去 Jellyfin 化 P6：park 救援页——一次性脚手架，GET /api/parked 的响应体。 */
export interface ParkedItemDTO {
  path: string
  parkReason: string
  firstSeen: number
  lastAttempt: number
}

/** POST /api/parked/claim 请求体。season 为 P7 disambiguation 补丁：多季剧下裸集号有歧义，
 *  认领时可选一并给出季号（省略=未指定，走原有单季/绝对集号折算路径）。 */
export interface ClaimParkedInput {
  path: string
  tmdbId: string
  isTv: boolean
  season?: number
}

/** dashboard-F2：GET /api/v2/workflow/pending 响应体——与 src/dashboard/apiV2.ts 的
 *  WorkflowPendingDTO 一族保持一致。顶栏新鲜度行与侧栏甄别角标共用同一个请求（meta+parked）。 */
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
  roots: string[]
  lastScanAt: number | null
  files: number
}
export interface WorkflowPendingDTO {
  series: WorkflowPendingSeriesDTO[]
  movies: WorkflowPendingMovieDTO[]
  parked: number
  meta: WorkflowFreshnessDTO
}

/** dashboard-F4：GET /api/v2/workflow/passes?limit=20 响应体——orchestrate 通行记录 + receipts，
 *  与 src/dashboard/apiV2.ts 的 WorkflowPassDTO 一族保持一致。 */
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

/** dashboard-F4：痕迹通道 C 的事件形状——SSE data 行 / workers.running[].trail /
 *  runs/:id/trace 的 events 三处共用同一个形状（与 src/dashboard/traceBus.ts 的
 *  TraceEvent 一族保持一致）。runKey=`job-${jobId}`。 */
export interface TraceEvent {
  runKey: string
  seq: number
  tool: string
  argsSummary: string
  resultSummary: string
  tookMs: number
  at: number
}

/** dashboard-F4：GET /api/v2/workflow/workers 响应体，与 src/dashboard/apiV2.ts 的
 *  WorkflowWorkersDTO 一族保持一致。 */
export interface WorkflowRunningWorkerDTO {
  jobId: number
  seriesId: string | null
  movieId: string | null
  taskType: string | null
  seasons: number[] | null
  startedAtLease: number
  /** traceBus.peek 的直播补拉——非破坏性尾部 20 条，供 TraceRows 首屏渲染的初始 trail。 */
  trail: TraceEvent[]
}
/** R2D-1（R2 复审）：worker run 详情入口——id 是身份键（RunDetail/RerunDialog 用），
 *  seriesId/movieId 供 RunDetail 判断 Rerun 按钮是否可用（同 src/dashboard/apiV2.ts 的
 *  WorkflowRecentRunDTO 一致）。 */
export interface WorkflowRecentRunDTO {
  id: number
  jobId: number | null
  decision: string | null
  detail: string | null
  finishedAt: number | null
  seriesId: string | null
  movieId: string | null
  /** 验收修复轮一 Task V3：seriesId 对应行的 series.name（LEFT JOIN），空名/未富化诚实降级
   *  为 null——Workflow 叙事化的人话句用它替换裸 tmdb id。 */
  seriesName: string | null
  /** 同 seriesName，movieId 对应行的 movies.name。 */
  movieName: string | null
}
export interface WorkflowWorkersDTO {
  running: WorkflowRunningWorkerDTO[]
  recent: WorkflowRecentRunDTO[]
  /** 验收修复轮一 Task V3：顶部总览句"N episodes installed in the last 24h"的数据源。 */
  installedLast24h: number
}

/** dashboard-F4：GET /api/v2/workflow/runs/:id/trace 响应体——单 run 痕迹快照回放
 *  （RunDetail 右侧板用，区别于 workers.running[].trail 的直播补拉）。 */
export interface RunTraceDTO {
  events: TraceEvent[]
}

/** dashboard-F4：POST /api/v2/workflow/redispatch 的四态回执——与 src/v2/jobsRepo.ts 的
 *  WorkerTaskUpsertOutcome 一族保持一致。四态都是 200/事实，不是错误（DESIGN.md §8）。 */
export type RedispatchOutcomeDTO =
  | { outcome: 'created' }
  | { outcome: 'revived' }
  | { outcome: 'coalesced'; pendingState: string; intentRefreshed: boolean }
  | { outcome: 'blocked_dormant'; lastError: string | null }

/** POST /api/v2/workflow/redispatch 请求体——与 src/dashboard/apiV2.ts 的 REDISPATCH_SCHEMA 一致。 */
export interface RedispatchInput {
  seriesId: string
  seasons?: number[]
  includeThrottled?: boolean
}

/** dashboard-F5：GET /api/v2/triage 响应体——已认领 override 清单，与 src/dashboard/apiV2.ts 的
 *  ClaimedOverrideDTO 一族保持一致（identify_overrides 全行直译）。 */
export interface ClaimedOverrideDTO {
  pathPrefix: string
  tmdbId: string
  isTv: boolean
  season: number | null
  createdAt: number
}
/** dashboard-F5：GET /api/v2/triage 响应体——甄别台一页看全"待认领"（pending，转发
 *  buildParked）与"已认领"（claimed）两份事实，与 src/dashboard/apiV2.ts 的 TriageDTO 一致。 */
export interface TriageDTO {
  pending: ParkedItemDTO[]
  claimed: ClaimedOverrideDTO[]
}

/** dashboard-F5：GET /api/v2/tmdb/search 响应体——ClaimDialog 的 TMDB 搜索代理（只读）。字段名
 *  对齐 server.ts 独立分支的映射（TmdbSearchHit.title → name，见该文件该端点注释）。 */
export interface TmdbSearchResultDTO {
  id: number
  name: string
  year: number | null
  posterPath: string | null
}
export interface TmdbSearchResponseDTO {
  results: TmdbSearchResultDTO[]
}

/** dashboard-F6：GET /api/v2/settings 响应体——行为级设置白名单五键，与 src/dashboard/apiV2.ts
 *  的 SETTINGS_KEYS/SettingsDTO 一致。每键 string|null，null=未设置（前端自行显示默认占位，
 *  见 web/src/settings/text.ts）。 */
export type SettingsKey =
  | 'target_languages' | 'hardsub_mode' | 'exclude_extras' | 'trace_retention_days' | 'scan_interval_ms'
export type SettingsDTO = Record<SettingsKey, string | null>

/** dashboard-F6：PUT /api/v2/settings 请求体——部分键值对象（全 string），与
 *  src/dashboard/apiV2.ts 的 updateSettings 输入形状一致（未列出的键不改动）。 */
export type SettingsPatch = Partial<Record<SettingsKey, string>>

/** dashboard-F6：GET /api/v2/settings/deploy 响应体——env 脱敏只读展示，与
 *  src/dashboard/apiV2.ts 的 DeploySettingsDTO 一致。key 集合刻意不在前端复刻后端
 *  DEPLOY_SECRET_KEYS/DEPLOY_NONSECRET_KEYS 那两个字面量元组——DeploySection 只是遍历
 *  Object.entries 逐行渲染，后端增删 env key 时前端不需要跟着改一份重复清单。 */
export interface DeploySecretDTO {
  present: boolean
  tail: string
}
export interface DeploySettingsDTO {
  secrets: Record<string, DeploySecretDTO>
  nonSecrets: Record<string, string | null>
}

/** dashboard-F6：GET /api/v2/settings/roots 响应体行——与 src/v2/settingsRepo.ts 的
 *  MediaRoot 一致。 */
export interface MediaRootDTO {
  path: string
  type: string
  addedAt: number
}

/** dashboard-F6：DELETE /api/v2/settings/roots?path=… 成功响应体——与
 *  src/v2/settingsRepo.ts 的 RemoveRootResult 一致（级联清理计数，磁盘文件不动）。 */
export interface RemoveRootResultDTO {
  episodes: number
  movies: number
  series: number
  parked: number
}

/** dashboard-F6：GET /api/v2/fs/list?path=… 成功响应体——与 src/dashboard/apiV2.ts 的
 *  listMediaSubdirs 成功分支一致（失败分支是 {error} 字符串，走 client.ts 既有的错误抛出口径，
 *  不建一个 union 类型）。 */
export interface FsListDTO {
  dirs: string[]
}

/** dashboard-F3：GET /api/v2/library/series/:id 响应体——三层格阵合并详情（canonical ∪ 磁盘 ∪
 *  覆盖），与 src/dashboard/apiV2.ts 的 LibrarySeriesDetailDTO 一族保持一致。 */
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
