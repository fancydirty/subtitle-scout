// web/src/api/client.ts：v2 只读数据层客户端。DASHBOARD_TOKEN 存在时带 ?token=。
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ReconcileAllResultDTO,
  ParkedItemDTO, ClaimParkedInput, WorkflowPendingDTO, LibrarySeriesDetailDTO,
  WorkflowPassDTO, WorkflowWorkersDTO, RunTraceDTO, RedispatchInput, RedispatchOutcomeDTO,
  TriageDTO, TmdbSearchResponseDTO,
} from './types.js'

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

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withToken(path), { signal })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

/** POST helper：错误响应体是 `{error: string}`（server.ts 的 reconcile-all/parked-claim 端点
 *  约定），优先把那条人话消息抛出来，而不是裸的 HTTP 状态码——503（未配置 TMDB_API_KEY）/
 *  400（认领校验失败）/401/405/500 各自的 error 文案都值得直接展示给使用者。`body` 给时按
 *  JSON 发送（POST /api/parked/claim 用）；不给时是无 body 的纯触发（reconcile-all 用）。 */
async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(withToken(path), {
    method: 'POST',
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const responseBody: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      responseBody && typeof responseBody === 'object' && 'error' in responseBody
        ? String((responseBody as { error: unknown }).error)
        : `${path} → ${res.status}`
    throw new Error(message)
  }
  return responseBody as T
}

export const api = {
  library: (signal?: AbortSignal) => get<LibraryItemDTO[]>('/api/v2/library', signal),
  series: (id: string, signal?: AbortSignal) =>
    get<SeriesDetailDTO>(`/api/v2/series/${encodeURIComponent(id)}`, signal),
  runs: (offset: number, limit: number, signal?: AbortSignal) =>
    get<RunHistoryDTO[]>(`/api/v2/runs?offset=${offset}&limit=${limit}`, signal),
  reconcileAll: () => post<ReconcileAllResultDTO>('/api/v2/reconcile-all'),
  // 去 Jellyfin 化 P6：park 救援页——一次性脚手架。
  parked: (signal?: AbortSignal) => get<ParkedItemDTO[]>('/api/parked', signal),
  claimParked: (input: ClaimParkedInput) => post<{ ok: true }>('/api/parked/claim', input),
  // dashboard-F2：顶栏新鲜度行 + 侧栏甄别角标共用同一份响应（meta + parked）。
  workflowPending: (signal?: AbortSignal) =>
    get<WorkflowPendingDTO>('/api/v2/workflow/pending', signal),
  // dashboard-F3：剧集页三层格阵详情（canonical ∪ 磁盘 ∪ 覆盖）。id 含冒号（tmdb:123），
  // encodeURIComponent 编码后由 router.ts 的 decodeIdSegment 解回。
  librarySeriesDetail: (id: string, signal?: AbortSignal) =>
    get<LibrarySeriesDetailDTO>(`/api/v2/library/series/${encodeURIComponent(id)}`, signal),
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
  // dashboard-F5：甄别台——pending+claimed 一次性查询（ClaimDialog 提交成功后由调用方手动
  // reload，同 useParked 的既有轮询口径：认领是低频动作，不值得为它常驻轮询）。
  triage: (signal?: AbortSignal) => get<TriageDTO>('/api/v2/triage', signal),
  // dashboard-F5：人类扳手②——甄别认领。与 claimParked 是同一个后端实现的第二个入口（见
  // src/dashboard/server.ts 的既有注释），这里单独开一个 client 函数指向 v2 路径，跟其余
  // v2 端点的命名口径一致，不复用旧 /api/parked/claim 那个一次性脚手架入口。
  claimTriage: (input: ClaimParkedInput) => post<{ ok: true }>('/api/v2/triage/claim', input),
  // dashboard-F5：ClaimDialog 的 TMDB 搜索代理（只读）——type 与 q 都做 URI 编码，q 可能含
  // CJK/空格/斜杠等需要转义的字符。
  tmdbSearch: (type: 'tv' | 'movie', q: string, signal?: AbortSignal) =>
    get<TmdbSearchResponseDTO>(`/api/v2/tmdb/search?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`, signal),
}
