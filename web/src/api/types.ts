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
