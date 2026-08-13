// web/src/api/client.ts：v2 只读数据层客户端。DASHBOARD_TOKEN 存在时带 ?token=。
import type {
  RunHistoryDTO,
  WorkflowPendingDTO,
  SubtitleVerifyListDTO,
  SubtitleCompareDTO,
  WorkflowPassDTO, RunTraceDTO, RedispatchInput, RedispatchOutcomeDTO,
  SettingsDTO, SettingsPatch, DeploySettingsDTO, MediaRootDTO, RemoveRootResultDTO, FsListDTO,
  AuthStatusDTO, AuthSecurityDTO,
  SetupStatusDTO, ProvidersDTO, PutSecretResultDTO, ValidateResultDTO, ValidateTarget, SecretName,
  ShiftedItemDTO, DormantTaskDTO,
  WaveformPeaksResponse,
  TestVisionRequest, TestVisionResponse,
  HealthDTO,
  MediaLibraryItemDTO, MediaLibraryDetailDTO,
  ActivityDTO,
  FoundGroupDTO,
} from './types.js'
import { checkShape, ContractViolationError, arr, type Shape } from './contract.js'
import {
  HEALTH_SHAPE, MEDIA_LIBRARY_ITEM_SHAPE, MEDIA_LIBRARY_DETAIL_SHAPE,
  ACTIVITY_SHAPE, FOUND_GROUP_SHAPE, SETUP_STATUS_SHAPE,
} from './contracts.js'

/** 两个列表端点的响应体是**数组**——声明写的是"一行"，这里包成数组形状。
 *  在这里包而不是在 contracts.ts 里直接写 `arr(...)`：那边的每个 const 与一个 DTO
 *  一一对应（`MediaLibraryItemDTO` 就是一行），包不包数组是**端点**的事不是 DTO 的事。 */
const MEDIA_LIBRARY_LIST_SHAPE: Shape = arr(MEDIA_LIBRARY_ITEM_SHAPE)
const NOTIFICATIONS_SHAPE: Shape = arr(FOUND_GROUP_SHAPE)

/** 鉴权 A2：任意请求撞 401（会话过期/未登录）时派发的全局事件名。App 层 useAuthStatus 监听它，
 *  触发一次 auth/status 重探，自动把界面切回 LoginPage——避免每个数据 hook 各自处理 401。 */
export const UNAUTHORIZED_EVENT = 'scout:unauthorized'

const token = (): string | null => new URLSearchParams(location.search).get('token')

/** 给任意路径挂上 token（若配置）：img src 与 fetch 共用同一策略。 */
export function withToken(path: string): string {
  const t = token()
  if (!t) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`
}

/** TMDB 海报 CDN 前缀——公开、免 key，浏览器直连（决策 D3，见去 Jellyfin 化设计文档）。 */
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/w400'

/** 海报 URL：直接拼 TMDB CDN，不再经服务端代理。无 posterPath 时返回 null，让调用方渲染占位。 */
export function posterUrl(posterPath: string | null): string | null {
  if (!posterPath) return null
  return `${TMDB_IMAGE_BASE}${posterPath}`
}

/** 背景大图（hero 用）与逐集剧照的 CDN 前缀——详情页重设计 item B。背景走 w1280 大图，剧照
 *  走 w300 缩略，皆浏览器直连 TMDB（同 posterUrl 的免 key 直连策略）。 */
const TMDB_BACKDROP_BASE = 'https://image.tmdb.org/t/p/w1280'
const TMDB_STILL_BASE = 'https://image.tmdb.org/t/p/w300'

/** 背景大图 URL（hero 用），无 path → null 让调用方降级纯排印头部。 */
export function backdropUrl(path: string | null): string | null {
  if (!path) return null
  return `${TMDB_BACKDROP_BASE}${path}`
}

/** 逐集剧照缩略图 URL，无 path → null 让调用方不渲染 img。 */
export function stillUrl(path: string | null): string | null {
  if (!path) return null
  return `${TMDB_STILL_BASE}${path}`
}

/** 从失败响应体尝试抽取 `{error: string}` 形状的诚实消息（server.ts 端点失败时的既有约定），
 *  抽不出来（响应体不是 JSON、或没有 error 字段）就回落 "path → status" 形式——get()/mutate()
 *  共用同一套抽取逻辑。R2D-8（R2 复审）：get() 此前从不解析失败响应体，只吐裸状态码——
 *  DirBrowser 这类"如实展示后端错误文案"的调用方因此永远看不到后端已经给出的人话消息（比如
 *  listMediaSubdirs 的 "path is not readable (permission denied?)"），这里补齐，与 mutate() 的
 *  既有手法对称。 */
function errorMessage(path: string, status: number, body: unknown): string {
  // 401 = 整站 token 门未过(设了 DASHBOARD_TOKEN 但网址没带 ?token= 或 token 不对)。给一句可操作
  // 的人话,而不是每个面板各自显示裸的 "path → 401"/"unauthorized"——否则用户听劝设了 token 后
  // 直接开面板,只看到满屏 unauthorized/offline,不知道要手动拼 ?token= 参数。
  if (status === 401) {
    // 鉴权 A2：token 时代退役——401 现在意味"会话过期/未登录"。App 层收到 scout:unauthorized
    // 会自动切回 LoginPage，这条文案只在切换前的一瞬被面板短暂显示。
    return '会话未授权或已失效，请重新登录'
  }
  return body && typeof body === 'object' && 'error' in body
    ? String((body as { error: unknown }).error)
    : `${path} → ${status}`
}

/** 401 时派发全局 scout:unauthorized——get/mutate 共用；SSR 安全（typeof window 守卫，虽然本
 *  客户端只跑浏览器，守卫是零成本的稳妥）。 */
function notifyIfUnauthorized(status: number): void {
  if (status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  }
}

/** 契约违约的处置：**抛错，走每个 hook 已有的 error 分支**（不降级、不放行）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 三种处置的取舍（这是本层的核心设计，不是实现细节）
 * ══════════════════════════════════════════════════════════════════════════════
 * ① **放行 + 上报** —— 直接否掉。这个仓库**没有前端错误上报通道**（PageBoundary 的
 *    「刻意不上报」一节已经确立），所谓"上报"实际只剩 `console.warn`——用户看不见。
 *    于是它等价于纯放行：用户看到半截 UI（`NaN` 集、空白标签、假的"引擎没开"横幅），
 *    而系统认为一切正常。这正是**病 B（静默撒谎）**，是本层要消灭的那个东西本身。
 *
 * ② **降级成"没数据"** —— 同样否掉，理由更硬。把契约违例当成空结果，就是把
 *    「接口坏了」说成「真的没有数据」。本仓 §4.4 已有明令：**错误态绝不显示空态文案**
 *    （`MediaLibraryPage`/`NotificationsPage`/`ActivityPage` 三处各写了一遍
 *    "「库里没有东西」与「我没能问到」是两件事"）。在 API 边界做这个降级，等于在
 *    三个页面辛苦维持的诚实性上游把它统一破坏掉。
 *
 * ③ **抛错** —— 选它。抛出去之后落点有两个，**都已经存在，不需要新建任何机制**：
 *    · 数据 hook（`useHealth`/`useMediaLibrary`/…）的 `.catch` → `error` 字符串 →
 *      页面走它**已经写好**的错误态：一句人话 + 一个"重试"按钮。侧栏顶栏全在。
 *    · 渲染期消费点（`SettingsTabsPage.readProviders`）→ `PageBoundary` → 那一页降级。
 *
 * 上一轮确立的纪律：「假修复（`?.` 静默到底）比白屏更坏——白屏至少是诚实的」。
 * ③ 比白屏还好一档：它不是白屏，是**一句说得出原因的错误态**，且降级范围恰好等于
 * 真正坏掉的那一部分。
 *
 * ── 一条重要的边界：这**不会**把整站打崩 ──────────────────────────────────
 * 全站唯一"失败即整站不可用"的请求是 `/api/v2/auth/status`（App 层鉴权门）——
 * 而它**刻意不在名单里**（见 contracts.ts 的排除理由）。名单里 6 个端点的失败，
 * 每一个都落在某一页的 error 态里，外壳始终在场。
 */
function assertShape(path: string, body: unknown, shape: Shape | undefined): void {
  if (shape === undefined) return
  const bad = checkShape(body, shape)
  if (bad) throw new ContractViolationError(path, bad)
}

/**
 * `shape` 给了就校验，不给就是原来的纯 `as T`（**60+ 个非致命 DTO 保持零开销**）。
 *
 * 🔴 为什么校验放在 `get()` 里、而不是各个 `api.*` 方法各自校验：
 * 放这里它是**一道门**——新增端点时"要不要校验"是一个显式的选择（传不传第二个参数），
 * 而不是一件需要记得去做的事。放在调用方就会退化成"想起来的那几个加了"。
 */
async function get<T>(path: string, signal?: AbortSignal, shape?: Shape): Promise<T> {
  const res = await fetch(withToken(path), { signal })
  if (!res.ok) {
    notifyIfUnauthorized(res.status)
    const body: unknown = await res.json().catch(() => null)
    throw new Error(errorMessage(path, res.status, body))
  }
  // ⚠️ 拿 `unknown` 接住，**先校验再 as T**。写成 `const b = await res.json() as T`
  // 再校验的话，中间那一步已经把类型谎报给编译器了——后面的代码会以为 b 是 T，
  // 而校验还没跑。顺序在这里不是风格问题。
  const body: unknown = await res.json()
  assertShape(path, body, shape)
  return body as T
}

/** 非 GET 请求 helper：POST/PUT/DELETE 共用同一套响应体解析 + 错误消息抽取口径——错误响应体是
 *  `{error: string}`（server.ts 的 reconcile-all/parked-claim/settings 端点约定），优先把那条
 *  人话消息抛出来，而不是裸的 HTTP 状态码——503（未配置 TMDB_API_KEY）/400（校验失败）/401/
 *  404（settings/roots 删除非登记根）/405/500 各自的 error 文案都值得直接展示给使用者。`body`
 *  给时按 JSON 发送；不给时是无 body 的纯触发/query 传参请求（reconcile-all、DELETE
 *  /api/v2/settings/roots?path=… 用）。 */
async function mutate<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const responseBody: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    notifyIfUnauthorized(res.status)
    throw new Error(errorMessage(path, res.status, responseBody))
  }
  return responseBody as T
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  return mutate<T>('POST', path, body)
}
/** dashboard-F6：单键行为设置提交用（PUT /api/v2/settings，body 必给——同 mutate() 的 body!==
 *  undefined 判据，PUT 语义上不该有无 body 的调用形状）。 */
async function put<T>(path: string, body: unknown): Promise<T> {
  return mutate<T>('PUT', path, body)
}
/** dashboard-F6：删根用（DELETE /api/v2/settings/roots?path=…，query 传参不带 body）。 */
async function del<T>(path: string): Promise<T> {
  return mutate<T>('DELETE', path)
}

export const api = {
  runs: (offset: number, limit: number, signal?: AbortSignal) =>
    get<RunHistoryDTO[]>(`/api/v2/runs?offset=${offset}&limit=${limit}`, signal),
  // ---------- Spec A 启动面（BootstrapGate / wizard / Settings Providers 区共用） ----------
  // 契约①：providers.subhd.enabled 是**三层解引用**——上一轮整页白屏的那一处。
  setupStatus: (signal?: AbortSignal) => get<SetupStatusDTO>('/api/v2/setup/status', signal, SETUP_STATUS_SHAPE),
  setupProviders: (signal?: AbortSignal) => get<ProvidersDTO>('/api/v2/setup/providers', signal),
  putSecret: (name: SecretName, value: string) =>
    put<PutSecretResultDTO>('/api/v2/settings/secrets', { name, value }),
  // credentials 提供 = wizard"先测后存"（服务端测请求体凭据、不落库）；省略 = 测已解析的 env/db 凭据。
  validateSetup: (target: ValidateTarget, credentials?: Partial<Record<SecretName, string>>) =>
    post<ValidateResultDTO>('/api/v2/setup/validate', credentials === undefined ? { target } : { target, credentials }),
  // dashboard-F2：顶栏新鲜度行 + 侧栏甄别角标共用同一份响应（meta + parked）。
  workflowPending: (signal?: AbortSignal) =>
    get<WorkflowPendingDTO>('/api/v2/workflow/pending', signal),
  // 对照图数据（2026-07-30）：单条，供检视面板画双轨时间轴。
  subtitleCompare: (itemId: string, signal?: AbortSignal) =>
    get<SubtitleCompareDTO>(`/api/v2/subtitle/compare?itemId=${encodeURIComponent(itemId)}`, signal),
  // 唯二写扳手之一：校正时间轴。后端在这一步里已重新检测并覆盖落库，调用方只需刷新视图。
  subtitleCorrect: (itemId: string) =>
    post<{ ok: boolean; state: string; error?: string }>('/api/v2/subtitle/correct', { itemId }),
  // 撤销校正，恢复备份。
  subtitleRevert: (itemId: string) =>
    post<{ ok: boolean; state: string; error?: string }>('/api/v2/subtitle/revert', { itemId }),
  // 字幕校验（2026-07-30）：批量拿一季的校验结论。单条也走这个（items 恒为数组，
  // 后端刻意只给一种响应形状，免得前端写两条解析分支）。上限 500 个 id 由后端把关。
  subtitleVerify: (itemIds: readonly string[], signal?: AbortSignal) =>
    get<SubtitleVerifyListDTO>(
      `/api/v2/subtitle/verify?itemIds=${itemIds.map((id) => encodeURIComponent(id)).join(',')}`,
      signal,
    ),
  // Plan C（spec §4.1）：偏移清单——Triage 第三区与 Library 详情偏移行共用同一份数据。
  subtitleShifted: (signal?: AbortSignal) =>
    get<ShiftedItemDTO[]>('/api/v2/subtitle/shifted', signal),
  // Plan C（spec §4.2）：停车任务清单——只读，零动作。
  workflowDormant: (signal?: AbortSignal) =>
    get<DormantTaskDTO[]>('/api/v2/workflow/dormant', signal),
  // dashboard-F4：Workflow 三泳道——中泳道 pass 记录 + 右泳道跑中/近期 worker。
  workflowPasses: (limit: number, signal?: AbortSignal) =>
    get<WorkflowPassDTO[]>(`/api/v2/workflow/passes?limit=${limit}`, signal),
  // `workflowWorkers` 已于 2026-08-13 随后端端点删除（见 src/dashboard/apiV2.ts 墓碑注释）。
  // dashboard-F4：RunDetail 快照回放——runId 是 runs.id（纯数字），不经 encodeURIComponent
  // 那一套（同 router.ts 该端点自己的纯数字校验口径，不是 tmdb:<n> 那种自有 id 空间）。
  runTrace: (runId: number, signal?: AbortSignal) =>
    get<RunTraceDTO>(`/api/v2/workflow/runs/${runId}/trace`, signal),
  // dashboard-F4：人类扳手①——手动重派。四态回执（created/revived/coalesced/blocked_dormant）
  // 都是 200，post() 的既有错误分支只在 zod 校验失败（400）/未配置（503）时触发。
  redispatch: (input: RedispatchInput) => post<RedispatchOutcomeDTO>('/api/v2/workflow/redispatch', input),
  // dashboard-F6：Settings tab——行为级设置读写 + 部署层只读展示 + 守备目录管理 + 目录浏览器。
  settings: (signal?: AbortSignal) => get<SettingsDTO>('/api/v2/settings', signal),
  // 单键提交（BehaviorSection 每行改动即时 PUT，body 只含那一个改动的键）；200 回执是写入后的
  // 全量 settings，调用方直接拿它回写本地状态，不用再发一次 GET（同 src/dashboard/apiV2.ts
  // updateSettings 的既有约定）。
  updateSettings: (patch: SettingsPatch) => put<SettingsDTO>('/api/v2/settings', patch),
  deploySettings: (signal?: AbortSignal) => get<DeploySettingsDTO>('/api/v2/settings/deploy', signal),
  roots: (signal?: AbortSignal) => get<MediaRootDTO[]>('/api/v2/settings/roots', signal),
  addRoot: (path: string) => post<{ ok: true }>('/api/v2/settings/roots', { path }),
  // DELETE 成功回执是级联清理计数（RemoveRootResultDTO）；404（非登记在册的守备目录）由
  // mutate() 的既有错误口径抛出，调用方（RemoveRootDialog）如实展示那句 error 文案。
  removeRoot: (path: string) => del<RemoveRootResultDTO>(`/api/v2/settings/roots?path=${encodeURIComponent(path)}`),
  fsList: (path: string, signal?: AbortSignal) =>
    get<FsListDTO>(`/api/v2/fs/list?path=${encodeURIComponent(path)}`, signal),
  // 鉴权 A2/A3：账号鉴权端点。status 是 App 门的探测源（任何态放行）；setup/login/logout 走
  // 会话 cookie（服务端 set-cookie，浏览器自动携带，无需前端存 token）；security/改密/重生成
  // 是 Settings Security 区用。
  authStatus: (signal?: AbortSignal) => get<AuthStatusDTO>('/api/v2/auth/status', signal),
  authSetup: (username: string, password: string) =>
    post<{ ok: true; apiKey: string }>('/api/v2/auth/setup', { username, password }),
  login: (username: string, password: string) => post<{ ok: true }>('/api/v2/auth/login', { username, password }),
  logout: () => post<{ ok: true }>('/api/v2/auth/logout'),
  authSecurity: (signal?: AbortSignal) => get<AuthSecurityDTO>('/api/v2/auth/security', signal),
  changePassword: (oldPassword: string, newPassword: string) =>
    post<{ ok: true }>('/api/v2/auth/change-password', { oldPassword, newPassword }),
  regenerateApiKey: () => post<{ apiKey: string }>('/api/v2/auth/regenerate-api-key'),

  // Plan B: 波形 peaks
  waveformPeaks: (itemId: string, signal?: AbortSignal) =>
    get<WaveformPeaksResponse>(`/api/v2/subtitle/waveform-peaks?itemId=${itemId}`, signal),

  // zimuku vision 能力测试：Settings → Providers 区的 ZimukuVisionCard 测试按钮调用
  testVision: (req: TestVisionRequest) =>
    post<TestVisionResponse>('/api/v2/test-vision', req),

  // R6：手动触发扫描——添加目录后防抖触发。
  //
  // 🔴 **别看名字像 library 就顺手删掉**（2026-08-12「无活 UI 端点」裁决时点名的误删风险）：
  // 同一轮里 `/api/v2/library`、`/api/v2/library/series/:id`、`/api/v2/library/movies/:id`
  // 三条**同前缀**端点全部被删（旧表、无活 UI），唯独这一条**留下**——它与那三条毫无关系，
  // 既不读 series/episodes/movies，也不产 DTO，只是踢一脚 daemon 的 ingest。
  //
  // 活消费链（2026-08-12 实测，逐跳可复核）：
  //   POST /api/v2/library/scan
  //     ← api.triggerScan（本行）
  //     ← settings/scanDebouncer.ts createScanDebouncer（2 秒防抖）
  //     ← settings/RootsManager.tsx:41
  //     ← settings/SettingsTabsPage.tsx:132
  //     ← shell/AppShell.tsx 的 `route.tab === 'settings'` 分支（导航四项之一，天天在用）
  //
  // 什么时候可以删：当"加完守备目录后自动扫一次"这个产品行为被取消，或 RootsManager 不再
  // 调 scanDebouncer 时。判据是上面那条链断在任意一跳——不是"名字里有 library"。
  triggerScan: () => post<{ ok: true }>('/api/v2/library/scan'),

  // Task ⑦：健康快照。SSE（events/）给的是**变化**，这个给的是**当前态**——断线期间丢了
  // 事件之后靠它纠正，这正是后端设立该端点的理由（server.ts 的 F-6 论证）。
  // ⚠️ 不跑 watch 时它**照常 200**（只是 current 为 null），与隔壁 /api/v2/events 的 503
  // 刻意不同：另外三个字段全长在库上，与事件总线无关。
  // 契约②：全局壳的判决源——workPermitted 决定横幅说什么，roots[] 决定守备目录提示。
  // 这两个字段缺席时**不会崩，会撒谎**（falsy 兜底 → 假的"引擎没开"/挂载故障不显示）。
  health: (signal?: AbortSignal) => get<HealthDTO>('/api/v2/health', signal, HEALTH_SHAPE),

  // Task ⑧：媒体库页（R-F2 / R-F5）。**刻意不复用 `library`/`librarySeriesDetail`**——
  // 那两个端点长在旧 series/episodes/movies 表上（生产 series 0 行，读不出任何东西），
  // 这两个长在 works/files/tmdb_seasons 上。两套并存直到 Task ⑪ 下架旧的。
  // 契约③：媒体库页主数据源——四个计数字段参与算术，缺一个就出 NaN/假的"齐全"。
  mediaLibrary: (signal?: AbortSignal) =>
    get<MediaLibraryItemDTO[]>('/api/v2/mediaLibrary', signal, MEDIA_LIBRARY_LIST_SHAPE),
  // workId 含冒号（'tmdb:1396'）。encodeURIComponent 编码后由 router.ts 的 decodeIdSegment
  // 解回——同 librarySeriesDetail 的既有拼法（router.ts 注释明写两条同形、复用同一套
  // isSafeId/decodeIdSegment）。⚠️ 不编码的话冒号本身虽合法，但作品 id 空间将来若出现
  // 需要转义的字符就会静默 404。
  mediaLibraryDetail: (workId: string, signal?: AbortSignal) =>
    // 契约④：detail.data.work.title 两层解引用 + seasons.map——两条都是崩页形态。
    get<MediaLibraryDetailDTO>(`/api/v2/mediaLibrary/${encodeURIComponent(workId)}`, signal, MEDIA_LIBRARY_DETAIL_SHAPE),

  // Task ⑨：活动页排队段（R-F13）。**只给"还有谁在等 + 它们的图"**——
  // total/index/当前在跑的是谁一律不从这里来（见 api/types.ts 的 ActivityDTO 注释与
  // 后端 activityApi.ts 头注释对「health 不返回 queue」那条裁决的论证）。
  // 契约⑤：两个队列缺席会被 `?? []` 兜成"没有排队"——把接口坏了说成真没数据。
  activity: (signal?: AbortSignal) => get<ActivityDTO>('/api/v2/activity', signal, ACTIVITY_SHAPE),

  // Task ⑩：通知页（R-F3）。**通知列表的唯一数据源**——SSE 的 `found` 事件不进列表
  // （server.ts:814 的分工裁决：recordFound 是幂等刷新，SSE 每次装盘都发，两边条目数
  // 天然不等；拿 SSE 往列表里插，那个差值就是用户眼前的重复条目）。
  // 无分页无上限（实测 3600 行 → 300 组 / 39.6 KiB / 4ms，当前量级无害）。
  // 契约⑥：latestAt 缺席 → 分桶 NaN + `NaN:NaN` 时刻；非数组 → .map 崩。
  notifications: (signal?: AbortSignal) => get<FoundGroupDTO[]>('/api/v2/notifications', signal, NOTIFICATIONS_SHAPE),
}
