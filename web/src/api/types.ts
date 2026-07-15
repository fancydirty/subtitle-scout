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

/** POST /api/parked/claim 请求体。 */
export interface ClaimParkedInput {
  path: string
  tmdbId: string
  isTv: boolean
}
