// web/src/api/client.ts：v2 只读数据层客户端。DASHBOARD_TOKEN 存在时带 ?token=。
import type { LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ReconcileAllResultDTO } from './types.js'

const token = (): string | null => new URLSearchParams(location.search).get('token')

/** 给任意路径挂上 token（若配置）：img src 与 fetch 共用同一策略。 */
export function withToken(path: string): string {
  const t = token()
  if (!t) return path
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`
}

/** 海报代理 URL。无 posterTag 时返回 null，让调用方渲染占位。 */
export function posterUrl(itemId: string, posterTag: string | null): string | null {
  if (!posterTag) return null
  return withToken(`/api/poster/${encodeURIComponent(itemId)}?tag=${encodeURIComponent(posterTag)}`)
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withToken(path), { signal })
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}

/** POST helper：错误响应体是 `{error: string}`（server.ts 的 reconcile-all 端点约定），优先把
 *  那条人话消息抛出来，而不是裸的 HTTP 状态码——503（未配置 TMDB_API_KEY）/401/405/500 各自
 *  的 error 文案都值得直接展示给使用者。 */
async function post<T>(path: string): Promise<T> {
  const res = await fetch(withToken(path), { method: 'POST' })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${path} → ${res.status}`
    throw new Error(message)
  }
  return body as T
}

export const api = {
  library: (signal?: AbortSignal) => get<LibraryItemDTO[]>('/api/v2/library', signal),
  series: (id: string, signal?: AbortSignal) =>
    get<SeriesDetailDTO>(`/api/v2/series/${encodeURIComponent(id)}`, signal),
  runs: (offset: number, limit: number, signal?: AbortSignal) =>
    get<RunHistoryDTO[]>(`/api/v2/runs?offset=${offset}&limit=${limit}`, signal),
  reconcileAll: () => post<ReconcileAllResultDTO>('/api/v2/reconcile-all'),
}
