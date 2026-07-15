// web/src/api/client.ts：v2 只读数据层客户端。DASHBOARD_TOKEN 存在时带 ?token=。
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ReconcileAllResultDTO,
  ParkedItemDTO, ClaimParkedInput,
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
}
