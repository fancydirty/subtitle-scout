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

// ── parked 族已整体删除，2026-08-13 ──────────────────────────────────────────
// `ParkedItemDTO` / `TriageDTO` / `api.parked` / `api.triage` / `api.unexclude` /
// `useParked` / `useTriage`，连同后端 GET /api/parked、GET /api/v2/triage、
// POST /api/v2/triage/unexclude 与 PendingBox/ExcludedBox 两个区。
// 判据：parked_paths 的唯一写入者 src/v2/ingest.ts 本轮退役，表从此零写入者——
// 留着读出面 = 给一张永远为空的表建界面。正本论证见 web/src/triage/TriagePage.tsx
// 头注释的「2.5 parked 族的结局」段。

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

// GET /api/v2/workflow/workers 的四个 DTO（WorkflowRunningWorkerDTO / WorkflowRecentRunDTO /
// WorkflowHeldJobDTO / WorkflowWorkersDTO）已于 2026-08-13 随后端端点一并删除。
// 裁决与论证见 `src/dashboard/apiV2.ts` 的墓碑注释；一句话版本：它的显示位已被
// `web/src/workbench/ActivityPage`（读 SSE + /api/v2/activity + /api/v2/health）取代，
// 而后继**刻意不读** jobs 表，所以它不是"缺一根接线的资产"，是一份已被取代的旧图纸。

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

// TmdbSearchResultDTO/TmdbSearchResponseDTO（GET /api/v2/tmdb/search 响应体）已随认领退役
// 删除——唯一消费方是已退役的 ClaimDialog。服务端只读代理端点仍在（无害），前端不再调用。

/** dashboard-F6：GET /api/v2/settings 响应体——行为级设置白名单五键，与 src/dashboard/apiV2.ts
 *  的 SETTINGS_KEYS/SettingsDTO 一致。每键 string|null，null=未设置（前端自行显示默认占位，
 *  见 web/src/settings/text.ts）。 */
export type SettingsKey =
  | 'target_languages'
  | 'ai_translate_enabled'
  | 'translate_after_attempts'
  | 'hardsub_mode'
  | 'scan_interval_ms'
  | 'trace_retention_days'
  | 'engine_enabled'
  | 'provider:SUBHD_ENABLED'
  | 'provider:ZIMUKU_ENABLED'

export type SettingsDTO = Record<SettingsKey, string | null> & { engineEnabled: boolean }

/** dashboard-F6：PUT /api/v2/settings 请求体——部分键值对象（全 string），与
 *  src/dashboard/apiV2.ts 的 updateSettings 输入形状一致（未列出的键不改动）。 */
export type SettingsPatch = Partial<Record<SettingsKey, string>>

/** 鉴权 A2：GET /api/v2/auth/status 响应体——App 层鉴权门（useAuthStatus）据此三态分流：
 *  未初始化→SetupWizard、已初始化未登录→LoginPage、已登录→Shell。与 src/dashboard/server.ts
 *  的 auth/status 端点一致。 */
export interface AuthStatusDTO {
  initialized: boolean
  authenticated: boolean
  /** TMDB 大陆可达线（2026-08-30）：部署层 env TMDB_IMAGE_BASE_URL 的下发管道——非空则前端
   *  图片 URL 改走它（{path} 模板/前缀两态，见 client.ts imageUrl），null=未配置（直连
   *  image.tmdb.org）。挂在 auth/status：AuthGate 首载必拉、三态都可达。 */
  tmdbImageBase: string | null
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

/** 详情页重设计 item B：逐集简介 / 首播日 / 剧照路径（web 端自拼 stillUrl w300）。 */
export interface LibraryCanonicalEpisodeDTO {
  episode: number
  title: string | null
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

/** 18 个密钥白名单（spec §4.1 枚举 + §8.2 TRANSLATE_* 三凭证 + ZIMUKU_VISION_* 三凭证
 *  + registry spec §4.1 的 R3SUB_* 账密对与 SUBDL_API_KEY）。与后端 SECRET_NAMES 同序。 */
export const SECRET_NAMES = [
  'TMDB_API_KEY',
  'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL',
  'ASSRT_TOKEN',
  'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_USERNAME', 'OPENSUBTITLES_PASSWORD',
  'JIMAKU_API_KEY',
  'R3SUB_EMAIL', 'R3SUB_PASSWORD',
  'SUBDL_API_KEY',
  'TRANSLATE_BASE_URL', 'TRANSLATE_API_KEY', 'TRANSLATE_MODEL',
  'ZIMUKU_VISION_BASE_URL', 'ZIMUKU_VISION_API_KEY', 'ZIMUKU_VISION_MODEL',
] as const
export type SecretName = (typeof SECRET_NAMES)[number]

export type ValidateTarget = 'tmdb' | 'llm' | 'translate' | 'assrt' | 'opensubtitles' | 'jimaku' | 'subhd' | 'zimuku' | 'r3sub' | 'subdl'

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
    /** registry spec §4.2：email+password 成对才 satisfied；masked=脱敏邮箱。 */
    r3sub: SetupSecretStateDTO
    subdl: SetupSecretStateDTO
  }
  roots: { count: number }
  engineEnabled: boolean
}

export interface SecretTestDTO { ok: boolean; at: number; error?: string }

/** 某个字幕源"配额已耗尽"的事实（后端 `ProviderQuotaDTO` 的手抄件）。
 *  写入链：provider adapter 发 code='quota_exhausted' → cli/quotaState.applyQuotaEvent
 *  → settings 的 `quota_state_<provider>` 键；读取方是 GET /api/v2/setup/providers。
 *
 *  🔴 渲染纪律：`resetAt === null` 是**"不知道何时恢复"**，不是"马上恢复"也不是"不会恢复"。
 *  必须画成一句诚实的"恢复时间未知"，**绝不许**拿 observedAt 加一个猜的小时数兜底成
 *  一个看起来很确定的时刻——用户会照着那个时间来等，而我们根本没有这个信息。 */
export interface ProviderQuotaDTO { resetAt: string | null; observedAt: number }

export interface ProviderRowDTO {
  id: ValidateTarget
  secrets: { name: SecretName; set: boolean; source: SecretSource; masked: string | null }[]
  lastTest: SecretTestDTO | null
  quota: ProviderQuotaDTO | null
  /** registry spec §4.1：infra（TMDB/LLM/翻译，永远展示）还是字幕源（按语言派生展示）。 */
  kind: 'infra' | 'source'
  /** kind='source' 时来自后端 SOURCE_REGISTRY（'*'=全语言通用）；infra 行恒 null。
   *  设置页分组与 x/N 计数都从这里派生——前端不复制注册表。 */
  languages: '*' | string[] | null
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

/** 「某个工作台现在在处理什么」的快照——ScoutCurrentsDTO 的一个槽。SSE 是**变化**流，
 *  断线期间的变化会丢；这个是**当前态**，可随时查询——两者并列存在是后端 F-6 的设计裁决，
 *  不是冗余。 */
export interface ScoutCurrentDTO {
  kind: 'identify' | 'subtitle' | 'translate'
  title: string | null
  /** 队列里的第几个。activity 之后、配对的 progress 之前是 null——**诚实的 null，不是缺陷**。 */
  index: number | null
  total: number | null
  workId: string | null
  backdropPath: string | null
  chineseTitle: string | null
  startedAt: number | null
  lastStep: string | null
  /** 翻译 cue 级进度（2026-08-21 活动页重做）。字幕/识别流恒 null。 */
  cueDone: number | null
  cueTotal: number | null
  /** 活动卡覆盖格 per-target 状态（2026-08-30，对齐后端 ScoutCurrent.targets）。字幕流才有；
   *  识别/翻译恒 undefined。全量数组——每条里程碑帧带完整快照，重连后下一帧即完整真相。 */
  targets?: Array<{ key: string; label: string; state: 'pending' | 'active' | 'installed' | 'pending-source' }>
}

/** 三个工作台各自的当前态快照（对齐后端 ScoutCurrents，2026-08-30 起 per-workbench 三槽）。
 *
 *  ⚠️ 曾是单槽 `current`——daemonV2 两车道并发（字幕/翻译）下后 emit 的车道把前一车道的
 *  快照顶掉，字幕 tab 的覆盖格被翻译台高频帧反复抹掉（韩语 live test 实证）。
 *  渲染纪律：subtitle tab 读 subtitle 槽、translate tab 读 translate 槽、顶部识别状态条读
 *  identify 槽——**绝不许把某一槽当"任意在忙的台"用**（要"有没有台在忙"就三槽都判 null）。 */
export interface ScoutCurrentsDTO {
  identify: ScoutCurrentDTO | null
  subtitle: ScoutCurrentDTO | null
  translate: ScoutCurrentDTO | null
}

/** 一个认不出来的作品目录。**刻意只有两个字段**——后端点名的信息量边界
 *  （R-F9/R-F10：last_error / attempt / next_retry_at / 绝对路径全是排障读数，不出）。 */
export interface UnidentifiedDirDTO {
  /** 目录名（`work_dir` 最后一段），**不是绝对路径**。用户要改名的就是这个东西。 */
  dirName: string
  fileCount: number
}

/** 「有几个目录我认不出来」。
 *
 *  ⚠️ 渲染纪律：`dirCount === 0` 时**整段不渲染**（沉默即好消息，同 RootHealthNote）。
 *  `dirs` 是**截断**的（后端上限 8），说"有几个"一律用 `dirCount`，
 *  **绝不许拿 `dirs.length` 当总数**——那会在超过 8 个时对用户少报。 */
export interface UnidentifiedHealthDTO {
  dirCount: number
  dirs: UnidentifiedDirDTO[]
}

export interface HealthDTO {
  /** ⚠️ 语义警告（Task ⑤ 审计 🟡-3，**后端未修**）：这个字段落的是巡检的**开始时刻**，
   *  不是完成时刻。大库实测能跑 10h → 04:00 开始 14:00 结束，13:00 读到的是"9 小时前"
   *  而此刻**正在巡检中**。渲染成"上次巡检于 X 前"是在说一句半真的话。
   *  本 task 不消费它做任何判决（占位页不渲染时间），Task ⑨ 真要显示时必须先解决这条。 */
  lastInspectAt: number | null
  /** 下次巡检预计时刻。`lastInspectAt` 为 null（冷启动）时为 null；否则 lastInspectAt + 24h。 */
  nextInspectAt: number | null
  /** **daemon 到底会不会干活**（= engineEnabled && setupSatisfied，后端同源计算）。
   *  这是回答"为什么什么都没发生"的那个字段。 */
  workPermitted: boolean
  /** 用户那个总开关的状态。⚠️ **不是**"引擎在干活"——true 但 setupSatisfied 为 false 时
   *  daemon 照样全停。要显示"在干活"必须读 workPermitted。 */
  engineEnabled: boolean
  /** TMDB + LLM 三件套是否全部可解析。false = 去 setup 页填 key。 */
  setupSatisfied: boolean
  roots: HealthRootDTO[]
  /** 「有几个目录我认不出来」。R-F2 的「孤儿不露出」作用域是**媒体库海报墙**（不给卡片），
   *  不是"数量不许被知道"；R-F1 的「不给用户改」禁的是编辑。故这里只读、无任何动作入口。 */
  unidentified: UnidentifiedHealthDTO
  /** 「有几件活记着失败了，而且再也没人去重试」（🔴-4）。
   *  `count === 0` → 这段整段不渲染（沉默即好消息）。 */
  stalledJobs: StalledJobsDTO
  /** 三个工作台各自的当前态（per-workbench 三槽，见 ScoutCurrentsDTO 头注释）。
   *  后端不留旧 `current` 单槽字段：自部署产品前后端同镜像出货，一次切净。 */
  currents: ScoutCurrentsDTO
}

/** `/api/v2/health` 的 `stalledJobs` 段——手抄自 src/dashboard/stalledJobsHealth.ts。
 *
 *  🔴 判据是**行为**（jobs 里"该被 claimNext 领走却一直没动"的行），不是"队列退役了"
 *  这个断言。生产实测：2 行 failed、过期 66 小时、无认领者，此前界面上一个字都没有。
 *  队列被接回 claim 之后这些行会被真的领走 → count 自动归零 → 这一段自己消失。 */
export interface StalledJobsDTO {
  count: number
  /** 最久那件过期了多久（毫秒）。`count === 0` 时为 null——
   *  **不是 0**：「没有这回事」与「过期 0 毫秒」是两件事。 */
  overdueMs: number | null
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
 *    extra ▭ / pending ··· / unjudged ? / absent 虚线不染色（不画任何符号） */
export type EpisodeState =
  | 'absent'
  | 'covered'
  | 'translating'
  | 'unsolvable'
  | 'origin-skip'
  | 'embedded'
  /** ▭ 机械特典（后端 `skip_reason='extra'`）：NCOP/NCED/PV/menu 这类无对白映像。
   *  2026-08-13 用户裁决「特典都完全不算在找字幕的范围」。与 origin-skip / embedded
   *  同属"不用人操心"那一族，只是理由不同（前两者"不需要"，这个"不算数"）。
   *  ⚠️ 它**不计入卡片上的 unplacedFileCount**（后端已扣除），只在格子层面可见——
   *  两者合起来才是"减少心智负担而不隐瞒事实"。 */
  | 'extra'
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
  /** **外挂**中文字幕（sidecar）已就位的格数 —— 卡片上的「已配」。
   *
   *  🔴 2026-08-14 语义修正（用户裁决③「分开显示」）：内嵌轨**不再**计入。
   *  此前判据是后端的 `dot !== 'none'`，把外挂 sidecar 与内嵌轨算成同一件事，
   *  生产 53/75 部命中。最刺眼的形态是《翘楚》——列表卡说「已配 5」，点进详情页
   *  24 格**全是**「原生语言不需要字幕」，库里外挂 sidecar 是 0 个。
   *  两个页面对同一件事给了不同答案，而「已配」描述的是一份我们并没有做过的工作。
   *
   *  现判据 = 该格 `dot === 'green'`，**恒等于**详情页 `subtitledFileCount > 0` 的格数
   *  （后端同名用例钉住）。这条等式是跨页一致性的凭据。 */
  subtitledEpisodeCount: number
  /** **内嵌**中文轨（片源自带）的格数 —— 卡片上的「自带」。
   *
   *  与 subtitledEpisodeCount **互斥不重叠**：来自 dot 三态（green/blue/none 三选一，
   *  且 green 优先于 blue）。两者只表达外挂和内嵌轨；完整就绪数还会由后端加入原生语言格。
   *  0 时前端整段不渲染（沉默即好消息）。 */
  embeddedEpisodeCount: number
  /** 原生语言就是目标语言、且没有外挂或内嵌目标语言轨的格数。 */
  originLanguageEpisodeCount: number
  /** 本地格里已就绪的格数 = 已下载 + 自带 + 原生。后端直接返回，前端不重算。 */
  readyEpisodeCount: number
  /** 本地格里既无外挂、无自带、也非原生目标语言的格数。海报卡黄字只读这个。 */
  uncoveredEpisodeCount: number
  /** 属于这部作品、但季集解析不出因而**进不了季集网格**的文件数。电影恒 0。
   *
   *  🔴 2026-08-13：与详情页的同名字段**同一个数**。此前这些文件被后端塞进一个假格、
   *  算进 `onDiskEpisodeCount`，于是同一部剧列表说「磁盘 78 / 缺 7」、详情说
   *  「磁盘 77 / 缺 8」。现在它们不进集数，只在这里如实计数——
   *  **必须显示**：不显示的话用户看不出"有文件没进网格"，会以为系统把文件弄丢了。
   *
   *  🔴 2026-08-13（同日第二条裁决）：**已扣除机械特典**（后端 skip_reason='extra'）。
   *  此前这个数把"系统故意不管的特典"与"系统没搞定的解析失败"混成一个数（生产 Re:ZERO
   *  报 67 = 16 特典 + 51 解析失败），用户无从分辨而前者根本不需要他动手。
   *  扣除后它只剩一种含义：**解析器没能归位的真实文件**，且可行动（改文件名即可修好）。
   *  特典并没有被藏掉——它们在季集网格里以 `episodeState='extra'`（▭）可见。 */
  unplacedFileCount: number
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
  /** 磁盘文件名。零文件或一份以上时为 null（多份时文件名不是这一格能说清的事）。 */
  filename: string | null
  /** Hero D（2026-08-28）：单文件电影的时长（秒）。ffprobe 未探测 / 多份 / 零文件 → null。
   *  前端拼「1h48m」，null 时该段不渲染。 */
  durationSec: number | null
  /** Hero D（2026-08-28）：单文件电影的体积（字节）。多份 / 零文件 → null。
   *  前端拼「1.4 GB」，null 时该段不渲染。 */
  sizeBytes: number | null
}

export interface MediaLibraryWorkDTO {
  workId: string
  title: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null
  mediaType: 'tv' | 'movie'
  /** Hero D（2026-08-28）：全宽背景图（TMDB backdrop_path，web 端自拼 w1280 CDN）。
   *  null = 库里没有这张图 → 前端**整块不渲染**，无占位灰块。 */
  backdropPath: string | null
  /** Hero D（2026-08-28）：作品简介（works.overview）。null / 空 → 简介整段不渲染。 */
  overview: string | null
  /** 双语 overview（2026-09-01）：zh 简介。zh 界面优先取本字段、缺失回退 overview。 */
  overviewZh: string | null
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
  /** 作品类型三态（后端 LEFT JOIN works 现取）。
   *
   *  🔴 渲染层判"这是不是电影"**只许读这个**，不许用 `season === null`——那个判据在
   *  notifications 表里是二义的（真电影 / 剧集但季没解析出来），生产上正把剧集渲染成
   *  「已找到字幕」的电影行。'unknown' = works 行已删，我们**确实不知道**，
   *  渲染层必须走一条不声称任何一边的话（绝不 `?? 'movie'`）。 */
  mediaType: 'tv' | 'movie' | 'unknown'
  /** 读时 LEFT JOIN works.chinese_titles 首个非空译名。无则 null。不改 snapshot title。 */
  chineseTitle: string | null
  /** 读时 LEFT JOIN works.backdrop_path。无则 null。 */
  backdropPath: string | null
}

// ── Task ⑨ 活动页（#/activity）：GET /api/v2/activity ────────────────────────
// 手抄自 src/dashboard/activityApi.ts 的同名 interface（同本文件全文件的既有处置）。
//
// 🔴 这个端点**只回答"还有谁在等"**，不产出 total/index/当前在跑的是谁。
// 那三样只信 SSE 与 /api/v2/health 的 `currents`（冻结快照，per-workbench 三槽）。理由是 health 端点有一条
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
  /** 这一项**现在就能取**吗（false = 全部文件都还在退避窗里）。
   *
   *  🔴 2026-08-13 修复的那句假话：此前本端点复用 daemon 的取件谓词（含退避窗），
   *  生产上 33 个在等的文件恰好全在退避窗 → 端点返回 `[]` → 活动页说
   *  「已排队 · 0 / 没有排队的作品」。**空态与"全都在退避里"共用了同一句话。**
   *  现在退避中的项照样返回，只是 `dueNow: false`。
   *
   *  🔴 2026-08-14：**翻译台已按同一口径修好**（此前它恒 true，因为取件谓词没有短路
   *  形参 → 全在 `tr_recheck_after` 退避窗时同样返回空数组、同样说"没有排队的作品"）。
   *  两个 tab 现在含义逐字相同：判据（至少一个文件到点 = true）在后端只有一份文本。 */
  dueNow: boolean
  /** `dueNow === false` 时这一簇里**最早**的重试时刻（毫秒）；到点的项恒 null。
   *  前端拿它说「最早 16 小时后重试」——只说"在等"不说"等到什么时候"，
   *  用户分不出"系统在等"与"系统卡住了"。 */
  retryAfter: number | null
  /** `sub_recheck_at === 0` 是 `markInstalled` 的 IMMEDIATE_RECHECK 哨兵，**不是**失败重试窗。
   *  装盘后仍 needs_subtitle=1 / sub_status NULL，同时 recheck_after 在未来，看起来像 bump。
   *  true = 这一簇每个 remaining 文件都是哨兵 0。翻译台恒 false，键始终在。
   *  前端（Task 6）据此显示「核对片库」vs「等待重试」。 */
  awaitingRescan: boolean
}

export interface ActivityDTO {
  subtitleQueue: ActivityQueueItemDTO[]
  translateQueue: ActivityQueueItemDTO[]
}
