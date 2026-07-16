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
