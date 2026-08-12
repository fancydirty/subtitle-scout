// web/src/api/types.ts：必须与 src/dashboard/apiV2.ts 的 DTO 保持一致
export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored' | 'hardsub-assumed'

// ---- 2026-08-12（无活 UI 端点裁决）：旧库 DTO 一族已删除 ----
// CoverageDTO / LibraryJobDTO / LibraryItemDTO / SeriesEpisodeDTO / SeriesSeasonDTO /
// SeriesRunDTO / SeriesDetailDTO 随 /api/v2/library 与 /api/v2/series/:id 一并删除。
// 它们对应的后端 builder 长在 series/episodes/movies 三张生产 0 行的旧表上。
// 媒体库页现在的 DTO 是下方的 MediaLibraryItemDTO / MediaLibraryDetailDTO。

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

// ---- 2026-08-12（无活 UI 端点裁决）：/api/v2/library/series/:id 的响应体 DTO 已删除 ----
// LibrarySeriesSummaryDTO / LibrarySeriesDetailDTO 随端点一并删除（后端 builder 长在
// series/episodes 旧表，生产 0 行；前端 useLibrarySeriesDetail 在 Task ⑪ 后零调用）。
//
// ⚠️ 下面三个 DTO（LibraryCanonicalEpisodeDTO / LibraryOnDiskEpisodeDTO / LibrarySeasonDTO）
// **刻意保留**：它们已不再由任何 HTTP 端点产出，但 `_legacy/library/episodeState.ts` 与
// SeasonAccordion 仍在类型层引用它们（`_legacy/` 整体是被 tsc 与 vitest 覆盖的）。
// 什么时候可以删：`web/src/_legacy/` 整体删除那天（设计文档 §2.2 的"跑满一个巡检周期后"），
// 与这批 DTO 一起走，不需要单独裁决。
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

/** 15 个密钥白名单（spec §4.1 枚举 + §8.2 TRANSLATE_* 三凭证 + ZIMUKU_VISION_* 三凭证）。与后端 SECRET_NAMES 同序。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
  'TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL',
  'ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_MODEL',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export type ValidateTarget = 'tmdb' | 'llm' | 'translate' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku' | 'zimuku_vision'

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

// ---- 2026-08-12（无活 UI 端点裁决）：MovieDetailDTO / ItemFileCoverage 已删除 ----
// 随 /api/v2/library/movies/:id 一并删除：后端 buildLibraryMovieDetail 长在 movies 旧表上，
// 前端 useLibraryMovieDetail 在 Task ⑪ 之后零调用（AppShell 删旧分支时把它一并删了）。
// 电影在新架构里是 works 的一种，走 MediaLibraryDetailDTO。

/** Plan B：波形 peaks 响应——音频对齐可视化数据。 */
export interface WaveformPeaksResponse {
  itemId: string
  peaks: number[]
  sampleRate: number
  durationMs: number
}

/** zimuku vision 能力测试请求——Settings → Providers 区的 ZimukuVisionCard 测试按钮。 */
export interface TestVisionRequest {
  baseUrl: string
  apiKey: string
  model: string
}

/** zimuku vision 能力测试响应——成功 { success: true, digits }；失败 { success: false, error }。 */
export interface TestVisionResponse {
  success: boolean
  digits?: string
  error?: string
}

// ── Task ⑦：GET /api/v2/health（Task ⑤ 的端点）─────────────────────────────────
// 手抄自 src/dashboard/server.ts 的同名 interface（同本文件其余 DTO 的既有做法：web/ 是
// 独立 tsconfig 工程，跨出去 import 会把 node 侧类型面拖进来）。

/** `roots[]` 元素。字段一律 `| null` 而非可选——后端刻意如此（undefined 会让字段整个消失，
 *  前端就分不清"没有这个事实"与"这版后端还没这个字段"）。 */
export interface HealthRootDTO {
  path: string
  /** **三态，不是布尔**：null = 不知道（从没扫过 / 扫描结果已陈旧）。
   *  ⚠️ 后端点名的渲染纪律：null 必须画成灰的"未知"，**绝不许 `?? true` 兜底**——
   *  那正好把这个三态设计要防的那句假话原地复活。 */
  ok: boolean | null
  /** 上一轮扫描的判决原文。⚠️ `ok === null`（陈旧）时这条仍可能非 null，
   *  但它**不是当前结论**——当前结论只看 `ok`。 */
  lastError: string | null
  lastCheckedAt: number | null
}

/** 「现在在处理什么」的快照。SSE 是**变化**流，断线期间的变化会丢；这个是**当前态**，
 *  可随时查询——两者并列存在是后端 F-6 的设计裁决，不是冗余。 */
export interface ScoutCurrentDTO {
  kind: 'identify' | 'subtitle' | 'translate'
  title: string | null
  /** 队列里的第几个。activity 之后、配对的 progress 之前是 null——**诚实的 null，不是缺陷**。 */
  index: number | null
  total: number | null
}

export interface HealthDTO {
  /** ⚠️ 语义警告（Task ⑤ 审计 🟡-3，**后端未修**）：这个字段落的是巡检的**开始时刻**，
   *  不是完成时刻。大库实测能跑 10h → 04:00 开始 14:00 结束，13:00 读到的是"9 小时前"
   *  而此刻**正在巡检中**。渲染成"上次巡检于 X 前"是在说一句半真的话。
   *  本 task 不消费它做任何判决（占位页不渲染时间），Task ⑨ 真要显示时必须先解决这条。 */
  lastInspectAt: number | null
  /** **daemon 到底会不会干活**（= engineEnabled && setupSatisfied，后端同源计算）。
   *  这是回答"为什么什么都没发生"的那个字段。 */
  workPermitted: boolean
  /** 用户那个总开关的状态。⚠️ **不是**"引擎在干活"——true 但 setupSatisfied 为 false 时
   *  daemon 照样全停。要显示"在干活"必须读 workPermitted。 */
  engineEnabled: boolean
  /** TMDB + LLM 三件套是否全部可解析。false = 去 setup 页填 key。 */
  setupSatisfied: boolean
  roots: HealthRootDTO[]
  current: ScoutCurrentDTO | null
}

// ── Task ⑧：媒体库页两个端点（GET /api/v2/mediaLibrary、/:workId）─────────────
// 手抄自 src/dashboard/mediaLibraryApi.ts 的同名 interface（同本文件其余 DTO 的既有做法：
// web/ 是独立 tsconfig 工程，跨出去 import 会把 node 侧类型面拖进来）。
//
// 🔴 命名撞车的裁决（任务书点名的债务①）：`web/src/library/episodeState.ts` 已存在一个
// `EpisodeCellState`，七态、值域完全不同（covered/hardsub/missing/throttled/error/dashed/
// partial），长在**旧** `episodes` 表的 `LibraryOnDiskEpisodeDTO.subStatus` 上。
// 本文件这个 `EpisodeState` 是后端 mediaLibraryApi.ts 的**八态**，长在**新** `files` 表的
// sub_status/needs_subtitle/skip_reason 三列上。
//
// 两套**绝不互相复用、绝不互相推导**：
//  ① 值域没有交集可言——同名的 'covered' 两边判据不同（旧的把 embedded/ignored 也折进
//     covered，新的 embedded 是独立一态）；'missing' 在新八态里根本不存在（对应
//     'pending'/'unsolvable' 两个语义相反的态）。写一个 map 把旧七态映到新八态，就是
//     把两套判据焊死，任一侧改动都会静默漂移出错误的染色。
//  ② 数据源不同——旧的读 episodes 表（生产 series 0 行、该表已死），新的读 files 表。
//  ③ 生命周期不同——旧七态随 Task ⑪ 与旧 library 页面一起移入 `_legacy`。
// 故新页面（web/src/media/）**一行都不 import 旧文件**，类型名也刻意不同
// （EpisodeCellState vs EpisodeState），撞不到一起。

/** 卡片右上角小圆点（后端 SubtitleDot）。**三态**，与下面的八态**共存不互推**：
 *  dot 回答"有没有中文字幕"，episodeState 回答"这一集现在处在什么状态"。
 *  前者是后者的**有损投影**（covered→green、embedded→blue、其余五态→none），反向推不回来。
 *  ⚠️ 媒体库页按 R-F12 用**集号染色**渲染状态，**不渲染圆点**——这个类型在本文件出现，
 *  只是因为 DTO 里有这个字段（如实手抄后端线形），不代表页面会画它。 */
export type MediaSubtitleDot = 'none' | 'blue' | 'green'

/** R-F12 集号染色的八态。优先级链已在后端算完（见 mediaLibraryApi.ts 的 classifyFileState），
 *  前端**只做符号映射，不做任何判定**——前端不知道 target_languages 是什么，那是 R-F15 的
 *  后端判据，在浏览器里复制一份必然与后端漂移。
 *
 *  符号（设计文档 §4.3 裁决，内联 SVG，见 web/src/media/EpisodeMark.tsx）：
 *    covered ✓ / translating ⇄ / unsolvable ⊘ / origin-skip ◇ / embedded ◆ /
 *    pending ··· / unjudged ? / absent 虚线不染色（不画任何符号） */
export type EpisodeState =
  | 'absent'
  | 'covered'
  | 'translating'
  | 'unsolvable'
  | 'origin-skip'
  | 'embedded'
  | 'pending'
  | 'unjudged'

/** GET /api/v2/mediaLibrary 的行——海报墙一张卡。
 *  四个计数字段名与后端逐字对应（后端头注释的命名铁律：绝不出现含混的 episodeCount）。 */
export interface MediaLibraryItemDTO {
  /** works.id（'tmdb:<id>'）。**这就是详情页的路由 id**，也是 R-F2 的合并键。 */
  workId: string
  title: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  mediaType: 'tv' | 'movie'
  /** 应有集数 = tmdb_seasons 行数（R-F5）。**电影恒 0**；剧集为 0 = 应有集缓存还没回填，
   *  **不是**"这剧只有 0 集"——前端据此隐藏"应有 N 集"那半句，不许显示 "0 集"。 */
  expectedEpisodeCount: number
  /** 实有集数 = 磁盘上有文件的**去重后**集数（R-F2：同一集两份文件只算 1）。 */
  onDiskEpisodeCount: number
  /** 虚线卡片数 = max(0, 应有 - 实有)（后端已夹 0）。 */
  missingEpisodeCount: number
  /** 已获取中文字幕的格数（R-F2「任一份有就算」口径；绿点 + 蓝点都计入）。 */
  subtitledEpisodeCount: number
}

/** 详情页一格（一集）。 */
export interface MediaLibraryEpisodeDTO {
  episode: number
  title: string | null
  /** **实线 vs 虚线的唯一判据**（R-F5）：true=磁盘上真有文件（实线）；
   *  false=TMDB 说这季有、磁盘上没有（虚线）。 */
  onDisk: boolean
  dot: MediaSubtitleDot
  /** R-F12 集号染色的唯一判据。onDisk=false 时后端恒给 'absent'（虚线格不染色）。 */
  episodeState: EpisodeState
  /** 该集在磁盘上的文件份数（同一集在两个目录各一份 → 2）。虚线格为 0。 */
  fileCount: number
  /** 其中有外挂中文 sidecar 的份数。R-F2「另一处那份仍要单独去配」的可见依据：
   *  `subtitledFileCount < fileCount` 即"还有份没配上"。 */
  subtitledFileCount: number
}

export interface MediaLibrarySeasonDTO {
  season: number
  episodes: MediaLibraryEpisodeDTO[]
}

/** 电影那一格（剧集恒 null）。
 *  ⚠️ 后端注释点名：**不许假设电影格必有文件**——详情端点没有列表页那个 INNER JOIN，
 *  零文件的空壳 works 打得进来，此时 episodeState 就是 'absent'。 */
export interface MediaLibraryMovieDTO {
  dot: MediaSubtitleDot
  episodeState: EpisodeState
  fileCount: number
  subtitledFileCount: number
}

export interface MediaLibraryWorkDTO {
  workId: string
  title: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  mediaType: 'tv' | 'movie'
}

/** GET /api/v2/mediaLibrary/:workId 响应体。 */
export interface MediaLibraryDetailDTO {
  work: MediaLibraryWorkDTO
  /** 季集网格。**电影恒空数组**（R-F5：电影没有季集）。 */
  seasons: MediaLibrarySeasonDTO[]
  /** 电影那一格；剧集恒 null。 */
  movie: MediaLibraryMovieDTO | null
  /** 属于本作品、但 season/episode 解析不出因而进不了季集网格的文件数。
   *  **必须如实露出**：不报的话用户会以为系统把文件弄丢了。电影恒 0。 */
  unplacedFileCount: number
}

// ── Task ⑩ 通知页（#/notifications）─────────────────────────────────────────
// 手抄自 src/v2/notificationsRepo.ts:48 的 `FoundGroup`（同 api/types.ts 全文件的既有处置：
// web/ 是独立 tsconfig 工程，跨出去 import 会把 node 侧类型面拖进浏览器工程）。
// ⚠️ 手抄的代价是后端改了这里不会报错——缓解在 notifications/notificationsWire.test.ts：
// 它拿**后端真实 listRecentFoundGrouped 的输出形状**（从源码注释逐字誊来的样例）喂给渲染层。

/** 一条通知的来路。后端 `FoundVia | 'mixed'`——组内混合来路时必须如实报 'mixed'
 *  （一季里有抓来的也有机翻的时，谎报单一来源会误导用户对字幕质量的预期）。 */
export type FoundVia = 'fetch' | 'translate' | 'mixed'

/** GET /api/v2/notifications 的一条。**按 work+season 聚合，不是逐集行**
 *  （R-F3 的展示形态是「XX 剧找到了 S01 的第 3/5/7 集」一条，不是三条）。
 *
 *  ⚠️ **没有稳定的行 id**——后端逐集存、读时聚合，组本身不是一行数据。React key 只能
 *  用 `workId + '/' + season` 自己拼（那正是后端聚合时用的幂等键，见 groupKey）。 */
export interface FoundGroupDTO {
  workId: string
  /** ⚠️ **写入时的快照**，不是 works 表的当前值。作品在一周窗内改过名的话，历史行的
   *  title 会与媒体库页显示的不一致——这是后端的刻意选择（通知是"当时发生了什么"的账目）。 */
  title: string
  /** null = 电影（此时 episodes 为空数组）。 */
  season: number | null
  /** **升序**（展示用"第 3/5/7 集"）。电影为空数组。 */
  episodes: number[]
  /** 组内最近一次找到的时刻——**组间倒序的锚点**。 */
  latestAt: number
  via: FoundVia
}

// ── Task ⑨ 活动页（#/activity）：GET /api/v2/activity ────────────────────────
// 手抄自 src/dashboard/activityApi.ts 的同名 interface（同本文件全文件的既有处置）。
//
// 🔴 这个端点**只回答"还有谁在等"**，不产出 total/index/当前在跑的是谁。
// 那三样只信 SSE 与 /api/v2/health 的 `current`（冻结快照）。理由是 health 端点有一条
// 明令「不返回 queue」的裁决：`listSubtitleQueue` 是**实时重查**，与 R4 的**冻结快照**
// 语义相反，拿它算「第 i/n 个」的 n 会与 SSE 那个冻结的 n 对不上、且随巡检推进越飘越远。
// 完整论证见后端 activityApi.ts 的头注释。
//
// 前端这一侧的执行纪律（ActivityPage 里有用例钉着）：
//  · 不许拿 `subtitleQueue.length` 当 total；
//  · 不许拿 SSE 的 total 减 done 去截断这个列表。
// 两个数字来源在 UI 上分开呈现、绝不互相推导。

/** 排队中的一个**作品**（R-F4：粒度是作品，不是集）。 */
export interface ActivityQueueItemDTO {
  /** works.id（'tmdb:<n>'）。与 SSE 事件的 `data.workId` 对齐用——**不靠标题字符串匹配**
   *  （同名翻拍与译名切换都会让字符串匹配静默错位，表现为"卡片配了别人的图"）。 */
  workId: string
  title: string
  chineseTitle: string | null
  year: number | null
  mediaType: 'tv' | 'movie'
  /** 竖版海报（R-F13 排队段用 59×88 竖版 poster）。null → 前端降级纯排印。 */
  posterPath: string | null
  /** 横版背景图（R-F13 在跑段用横版 backdrop）。排队项也带它——一个作品会从排队**走到**
   *  在跑，那一刻要立刻有横版图可用，否则会闪一帧无图降级。 */
  backdropPath: string | null
  /** 这个作品自己有几个文件在等（「2018 · 动画 · 13 集待处理」那个 13）。
   *  🔴 **不是 total、不是序号**，与队列长度无关。 */
  pendingFileCount: number
}

export interface ActivityDTO {
  subtitleQueue: ActivityQueueItemDTO[]
  translateQueue: ActivityQueueItemDTO[]
}
