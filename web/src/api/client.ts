// web/src/api/client.ts：v2 只读数据层客户端。DASHBOARD_TOKEN 存在时带 ?token=。
import type { LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO } from './types.js'

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

export const api = {
  library: (signal?: AbortSignal) => get<LibraryItemDTO[]>('/api/v2/library', signal),
  series: (id: string, signal?: AbortSignal) =>
    get<SeriesDetailDTO>(`/api/v2/series/${encodeURIComponent(id)}`, signal),
  runs: (offset: number, limit: number, signal?: AbortSignal) =>
    get<RunHistoryDTO[]>(`/api/v2/runs?offset=${offset}&limit=${limit}`, signal),
}
