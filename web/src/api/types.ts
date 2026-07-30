// web/src/api/types.ts：必须与 src/dashboard/apiV2.ts 的 DTO 保持一致
export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored' | 'hardsub-assumed'

export interface CoverageDTO {
  covered: number
  missing: number
  embedded: number
  unavailable: number
  /** 救援R5：硬字幕假定——独立桶，前端渲染独立样式，不冒充"外挂字幕已确认"的绿点。 */
  hardsubAssumed: number
  /** 重复源 P3b：文件级副本间覆盖不一致——独立桶。 */
  partial: number
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

// ClaimParkedInput（POST /api/parked/claim 请求体）已随认领退役删除——见 TriageDTO 注释。

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
  /** 验收修复轮一收官补刀（spec §B 铁律①）：跑中卡头主语=剧/片名；null=空名/查无（前端降级
   *  显示 id，诚实兜底）。 */
  seriesName: string | null
  movieName: string | null
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
  /** 审计 UX-P0：LLM 调用账本（翻译 run 写入；find/realign 为 null）——ActivityRow 成本后缀。 */
  llmCalls: number | null
}
/** 审计 UX-P0：held（fail-closed 拦下）落库可见——failed + 未来重试时刻的 worker_task。 */
export interface WorkflowHeldJobDTO {
  jobId: number
  itemId: string | null
  reason: string | null
  nextRetryAt: number | null
  errorAttempt: number
}
export interface WorkflowWorkersDTO {
  running: WorkflowRunningWorkerDTO[]
  recent: WorkflowRecentRunDTO[]
  /** 验收修复轮一 Task V3：顶部总览句"N episodes installed in the last 24h"的数据源。 */
  installedLast24h: number
  /** 审计 UX-P0：SummaryLine "N translated" 段数据源（translate:installed 24h 计数）。 */
  translatedLast24h: number
  /** 审计 UX-P0：held 队列。 */
  held: WorkflowHeldJobDTO[]
  /** 债务 D3：provider 配额事实——后端已滤除过期条目；resetAt=ISO 串或 null（未知重置时刻）。 */
  providerQuota: Array<{ provider: string; resetAt: string | null; observedAt: number }>
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

/** dashboard-F5：GET /api/v2/triage 响应体——待识别（pending，转发 buildParked）事实清单，
 *  与 src/dashboard/apiV2.ts 的 TriageDTO 一致。claimed 半边（ClaimedOverrideDTO）已随认领
 *  退役（2026-07-28 两证据红线裁决，见 src/v2/triageOps.ts 头注释）。 */
export interface TriageDTO {
  pending: ParkedItemDTO[]
}

// TmdbSearchResultDTO/TmdbSearchResponseDTO（GET /api/v2/tmdb/search 响应体）已随认领退役
// 删除——唯一消费方是已退役的 ClaimDialog。服务端只读代理端点仍在（无害），前端不再调用。

/** dashboard-F6：GET /api/v2/settings 响应体——行为级设置白名单五键，与 src/dashboard/apiV2.ts
 *  的 SETTINGS_KEYS/SettingsDTO 一致。每键 string|null，null=未设置（前端自行显示默认占位，
 *  见 web/src/settings/text.ts）。 */
export type SettingsKey =
  | 'target_languages' | 'hardsub_mode' | 'exclude_extras' | 'trace_retention_days' | 'scan_interval_ms'
  | 'ai_translate_enabled'
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

/** 鉴权 A2：GET /api/v2/auth/status 响应体——App 层鉴权门（useAuthStatus）据此三态分流：
 *  未初始化→SetupWizard、已初始化未登录→LoginPage、已登录→Shell。与 src/dashboard/server.ts
 *  的 auth/status 端点一致。 */
export interface AuthStatusDTO {
  initialized: boolean
  authenticated: boolean
}

/** 鉴权 A3：GET /api/v2/auth/security 响应体——Settings Security 区展示用（username + 完整
 *  apiKey，仅对已鉴权管理员回显；前端自行脱敏成尾 4 位）。与 src/dashboard/server.ts 的
 *  auth/security 端点一致。 */
export interface AuthSecurityDTO {
  username: string
  apiKey: string
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
  /** 详情页重设计 item B：TMDB 剧集简介 + hero 背景大图路径（web 端自拼 backdropUrl w1280）。 */
  overview: string | null
  backdropPath: string | null
  year: number | null
  layoutNonstandard: boolean
}
export interface LibraryCanonicalEpisodeDTO {
  episode: number
  title: string | null
  /** 详情页重设计 item B：逐集简介 / 首播日 / 剧照路径（web 端自拼 stillUrl w300）。 */
  overview: string | null
  airDate: string | null
  stillPath: string | null
}
export interface LibraryOnDiskEpisodeDTO {
  /** episodes.id——前端按它查字幕校验结论与对照数据（2026-07-30）。 */
  itemId: string
  episode: number
  path: string
  subStatus: string
  statusReason: string | null
  recheckAfter: number | null
  /** 重复源 P3b：逐文件覆盖（主文件 + 全部副本）。 */
  files: Array<{ path: string; isMain: boolean; covered: boolean }>
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

/** 字幕校验（2026-07-30 spec）：与 src/dashboard/subtitleVerifyApi.ts 的同名 DTO 一致。
 *  **恰好三个键**——offsetMs/score/referenceTier/detail 是内部诊断字段，故意不在这里
 *  （铁律②：UI 不展示任何数字。前端拿不到就不可能误显示成"偏移 2.4 秒"）。 */
export type SubtitleVisualState = 'ok' | 'shifted'
export interface SubtitleVerifyDTO {
  itemId: string
  /** 'ok' = 绿（含"验过没问题"与"没能验证"两档）；'shifted' = 红，可点校正。 */
  state: SubtitleVisualState
  /** false = 还没查过 → 不显示芯片（既不是绿也不是红）。 */
  checked: boolean
}
export interface SubtitleVerifyListDTO {
  items: SubtitleVerifyDTO[]
}

/** 对照图数据（2026-07-30）：与 src/dashboard/subtitleCompareApi.ts 的同名 DTO 一致。
 *  同样不含 score/offsetMs/referenceTier/detail——时间戳是定位坐标（画图必需），
 *  分数是质量评分（铁律②禁止）。 */
export interface CompareBlock {
  startMs: number
  endMs: number
  text: string | null
}
/** 结论判读（2026-07-31，审计 I-B1/I-B2）：与 src/dashboard/subtitleCompareApi.ts 的
 *  同名类型一致。**判定只在后端做**——前端曾自己从两轨时间戳做几何推断，既把符号丢了
 *  （偏早说成偏晚），又按下标配对（少几条 cue 就误判），而且它是第二个判定引擎、
 *  把着写按钮的闸，随时可能与后端的结论矛盾。现在前端只渲染，不推断。
 *
 *    'behind'      字幕比画面晚，平移可修
 *    'ahead'       字幕比画面早，平移可修
 *    'not-a-shift' 比过了、对不上，任何单一位移都修不好（帧率不匹配、装错剧集）
 *    'unknown'     没有可比对的东西，不下结论
 *
 *  这是枚举而非数字，不违反铁律②（offsetMs/score/referenceTier 仍然不出 DTO）。 */
export type CompareDiagnosis = 'behind' | 'ahead' | 'not-a-shift' | 'unknown'

export interface SubtitleCompareDTO {
  itemId: string
  reference: CompareBlock[]
  ours: CompareBlock[]
  durationMs: number
  waveformAvailable: boolean
  mountKind: 'local' | 'lan' | 'cloud'
  diagnosis: CompareDiagnosis
  /** 平移能不能修好它 = 给不给校正按钮。后端判，前端不再自己算。 */
  fixable: boolean
}
