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
  originLang: string | null
  nativeAudio: boolean
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
  /** 字幕校验巡检上次运行时刻（2026-07-31）。null=从未跑过。 */
  lastVerifySweepAt: number | null
  /** 已出校验结论 / 该被校验的条目数。裸计数不是百分比。 */
  verifiedItems: number
  verifiableItems: number
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
  /** 活动页铁律「必须有图」：TMDB 图片 path（URL 由 client.ts 的 posterUrl/backdropUrl 自拼，
   *  免 key 直连 TMDB）。series 命中取 series 的，movie 命中取 movies 的。
   *
   *  ⚠️ 不对称（不是 bug）：`movies` 表没有 backdrop_path 列（只有 series 有），所以 movie 目标的
   *  backdropPath 恒为 null——此时走「模糊海报当背景」的降级路径，不要当数据缺失报障。两边都查无
   *  （name 也 null 的行）时两字段都 null。 */
  posterPath: string | null
  backdropPath: string | null
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
  /** 活动页铁律「必须有图」：同 WorkflowRunningWorkerDTO 的同名两字段，口径一致——只给 path。
   *  ⚠️ movie 目标的 backdropPath 恒为 null（movies 表没有 backdrop_path 列），走模糊海报降级。 */
  posterPath: string | null
  backdropPath: string | null
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
  /** 剧名 / 片名（2026-07-31 审计 C-3）。此前前端靠 recent[] 按 jobId 反查名字与海报，
   *  但 held 停留是**天级**（heldBackoffMs +1d/+3d/+7d），recent 是 ORDER BY finished_at
   *  DESC LIMIT 20 的滑动窗口——生产节奏（每小时 20 条）下一小时内就被挤出，此后 join 恒
   *  MISS：卡死态没有图（违反 L4「必须有图」），且降级显示 tmdb:1396/s12e04 这种技术
   *  标识符（违反 L3「不暴露机械」）。 */
  seriesName: string | null
  movieName: string | null
  posterPath: string | null
  /** 仅 series 有值——movies 表没有 backdrop_path 列。电影恒 null，前端据此走模糊海报降级。 */
  backdropPath: string | null
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
  | 'target_languages'
  | 'ai_translate_enabled'
  | 'hardsub_mode'
  | 'exclude_extras'
  | 'scan_interval_ms'
  | 'trace_retention_days'
  | 'engine_enabled'
  | 'provider:SUBHD_ENABLED'
  | 'provider:ZIMUKU_ENABLED'

export type SettingsDTO = Record<SettingsKey, string | null> & { engineEnabled: boolean }

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

// ---------- Spec A 启动面 DTO（镜像 src/dashboard/setupApi.ts 的线形；键集合与 spec A §4.4 示例 JSON 逐键对齐） ----------

export type SecretSource = 'env' | 'db' | 'none'

/** 9 个密钥白名单（spec §4.1 枚举值；正文"10 个"系笔误）。与后端 SECRET_NAMES 同序。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export type ValidateTarget = 'tmdb' | 'llm' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku'

export interface ValidateResultDTO { ok: boolean; detail?: string; error?: string }

export interface SetupSecretStateDTO { satisfied: boolean; source: SecretSource; masked: string | null }

export interface SetupStatusDTO {
  bootstrapComplete: boolean
  tmdb: SetupSecretStateDTO
  llm: { satisfied: boolean; source: SecretSource; model: string | null }
  providers: {
    assrt: SetupSecretStateDTO
    opensubtitles: { satisfied: boolean; source: SecretSource; hasUsername: boolean; masked: string | null }
    jimaku: SetupSecretStateDTO
    subhd: { enabled: boolean; source: SecretSource }
    zimuku: { enabled: boolean; source: SecretSource; captchaReady: boolean }
  }
  roots: { count: number }
  engineEnabled: boolean
}

export interface SecretTestDTO { ok: boolean; at: number; error?: string }

export interface ProviderRowDTO {
  id: ValidateTarget
  secrets: { name: SecretName; set: boolean; source: SecretSource; masked: string | null }[]
  lastTest: SecretTestDTO | null
}

export interface ProvidersDTO { providers: ProviderRowDTO[] }

/** PUT /api/v2/settings/secrets 的 200 体；400 时走 client.ts 既有 {error} 抽取，进不了本类型。 */
export interface PutSecretResultDTO { ok: boolean; name?: SecretName; action?: 'set' | 'deleted' }

/** Plan C（spec §4.1）：GET /api/v2/subtitle/shifted 的行。后端 `ShiftedItemDTO` 的手抄件。
 *  **七键封闭**——`offsetMs`/`score`/`referenceTier`/`detail` 在 API 层就被剥掉了（铁律②），
 *  前端想犯错也拿不到字段。四个媒体字段可 null（电影行或库里已无此集），此时降级 mono
 *  itemId 占位（spec §8）。 */
export interface ShiftedItemDTO {
  itemId: string
  seriesId: string | null
  seriesName: string | null
  season: number | null
  episode: number | null
  checkedAt: number
  /** 有没有可还原的在先校正 = Undo 按钮给不给点。后端探的是备份文件存在性，与 revert
   *  自己的前置门同源，所以"能点"与"点了会成功"天然一致。仍可能被 C-A1 陈旧门拒
   *  （保护性拒绝，非按钮状态错误）。 */
  hasPriorCorrection: boolean
}

/** Plan C（spec §4.2）：GET /api/v2/workflow/dormant 的行。后端 `DormantTaskDTO` 的手抄件。
 *  **四键封闭。** 刻意没有 reason（现网是中文内部串，不透传——英文句子前端用 attempts 组）
 *  也没有任何时刻字段（草稿 6 的 dormant 行不渲染时刻）。**零按钮**：唤醒通道 spec 明确
 *  不补（§3 决策 1），别在 UI 上画一个打不通的按钮。 */
export interface DormantTaskDTO {
  jobId: number
  /** 裸工具名（如 `find_subtitle`），mono 弱显。 */
  task: string
  targetLabel: string
  attempts: number
}

/** Plan B：文件级副本与字幕覆盖的明细行——MovieDetailDTO 的嵌套子类型。 */
export interface ItemFileCoverage {
  path: string
  isMain: boolean
  covered: boolean
}

/** Plan B：电影详情——14 键，与后端 MovieDetailDTO 手抄同步。 */
export interface MovieDetailDTO {
  id: string
  name: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  path: string
  subStatus: SubStatus
  statusReason: string | null
  recheckAfter: number | null
  originLang: string | null
  nativeAudio: boolean
  files: ItemFileCoverage[]
  subtitles: { language: string; path: string }[]
  recentJobs: { id: number; state: string; priority: number; updatedAt: number }[]
}

/** Plan B：波形 peaks 响应——音频对齐可视化数据。 */
export interface WaveformPeaksResponse {
  itemId: string
  peaks: number[]
  sampleRate: number
  durationMs: number
}
