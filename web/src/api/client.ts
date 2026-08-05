// web/src/api/client.ts：v2 只读数据层客户端。DASHBOARD_TOKEN 存在时带 ?token=。
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ReconcileAllResultDTO,
  ParkedItemDTO, WorkflowPendingDTO, LibrarySeriesDetailDTO,
  SubtitleVerifyListDTO,
  SubtitleCompareDTO,
  WorkflowPassDTO, WorkflowWorkersDTO, RunTraceDTO, RedispatchInput, RedispatchOutcomeDTO,
  TriageDTO,
  SettingsDTO, SettingsPatch, DeploySettingsDTO, MediaRootDTO, RemoveRootResultDTO, FsListDTO,
  AuthStatusDTO, AuthSecurityDTO,
  SetupStatusDTO, ProvidersDTO, PutSecretResultDTO, ValidateResultDTO, ValidateTarget, SecretName,
  ShiftedItemDTO, DormantTaskDTO,
  MovieDetailDTO, WaveformPeaksResponse,
  TestVisionRequest, TestVisionResponse,
} from './types.js'

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

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withToken(path), { signal })
  if (!res.ok) {
    notifyIfUnauthorized(res.status)
    const body: unknown = await res.json().catch(() => null)
    throw new Error(errorMessage(path, res.status, body))
  }
  return res.json() as Promise<T>
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
  library: (signal?: AbortSignal) => get<LibraryItemDTO[]>('/api/v2/library', signal),
  series: (id: string, signal?: AbortSignal) =>
    get<SeriesDetailDTO>(`/api/v2/series/${encodeURIComponent(id)}`, signal),
  runs: (offset: number, limit: number, signal?: AbortSignal) =>
    get<RunHistoryDTO[]>(`/api/v2/runs?offset=${offset}&limit=${limit}`, signal),
  reconcileAll: () => post<ReconcileAllResultDTO>('/api/v2/reconcile-all'),
  // ---------- Spec A 启动面（BootstrapGate / wizard / Settings Providers 区共用） ----------
  setupStatus: (signal?: AbortSignal) => get<SetupStatusDTO>('/api/v2/setup/status', signal),
  setupProviders: (signal?: AbortSignal) => get<ProvidersDTO>('/api/v2/setup/providers', signal),
  putSecret: (name: SecretName, value: string) =>
    put<PutSecretResultDTO>('/api/v2/settings/secrets', { name, value }),
  // credentials 提供 = wizard"先测后存"（服务端测请求体凭据、不落库）；省略 = 测已解析的 env/db 凭据。
  validateSetup: (target: ValidateTarget, credentials?: Partial<Record<SecretName, string>>) =>
    post<ValidateResultDTO>('/api/v2/setup/validate', credentials === undefined ? { target } : { target, credentials }),
  // 去 Jellyfin 化 P6：park 救援页——一次性脚手架。
  parked: (signal?: AbortSignal) => get<ParkedItemDTO[]>('/api/parked', signal),
  // dashboard-F2：顶栏新鲜度行 + 侧栏甄别角标共用同一份响应（meta + parked）。
  workflowPending: (signal?: AbortSignal) =>
    get<WorkflowPendingDTO>('/api/v2/workflow/pending', signal),
  // dashboard-F3：剧集页三层格阵详情（canonical ∪ 磁盘 ∪ 覆盖）。id 含冒号（tmdb:123），
  // encodeURIComponent 编码后由 router.ts 的 decodeIdSegment 解回。
  librarySeriesDetail: (id: string, signal?: AbortSignal) =>
    get<LibrarySeriesDetailDTO>(`/api/v2/library/series/${encodeURIComponent(id)}`, signal),
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
  workflowWorkers: (signal?: AbortSignal) => get<WorkflowWorkersDTO>('/api/v2/workflow/workers', signal),
  // dashboard-F4：RunDetail 快照回放——runId 是 runs.id（纯数字），不经 encodeURIComponent
  // 那一套（同 router.ts 该端点自己的纯数字校验口径，不是 tmdb:<n> 那种自有 id 空间）。
  runTrace: (runId: number, signal?: AbortSignal) =>
    get<RunTraceDTO>(`/api/v2/workflow/runs/${runId}/trace`, signal),
  // dashboard-F4：人类扳手①——手动重派。四态回执（created/revived/coalesced/blocked_dormant）
  // 都是 200，post() 的既有错误分支只在 zod 校验失败（400）/未配置（503）时触发。
  redispatch: (input: RedispatchInput) => post<RedispatchOutcomeDTO>('/api/v2/workflow/redispatch', input),
  // dashboard-F5：甄别台——pending 一次性查询（翻案成功后由调用方手动 reload，同 useParked
  // 的既有口径：低频人工动作，不值得为它常驻轮询）。认领端点（claimTriage/unclaim/tmdbSearch）
  // 已随认领退役删除（2026-07-28 两证据红线裁决，见 src/v2/triageOps.ts 头注释）。
  triage: (signal?: AbortSignal) => get<TriageDTO>('/api/v2/triage', signal),
  // 救援R4c：excluded-extra 停车行翻案——取消排除，让文件回到 pending 池重新参与 ingest。
  unexclude: (path: string) => post<{ ok: true }>('/api/v2/triage/unexclude', { path }),
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

  // Plan B: 电影详情
  movieDetail: (id: string, signal?: AbortSignal) =>
    get<MovieDetailDTO>(`/api/v2/library/movies/${id}`, signal),

  // Plan B: 波形 peaks
  waveformPeaks: (itemId: string, signal?: AbortSignal) =>
    get<WaveformPeaksResponse>(`/api/v2/subtitle/waveform-peaks?itemId=${itemId}`, signal),

  // zimuku vision 能力测试：Settings → Providers 区的 ZimukuVisionCard 测试按钮调用
  testVision: (req: TestVisionRequest) =>
    post<TestVisionResponse>('/api/v2/test-vision', req),
}
