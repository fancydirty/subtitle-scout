// web/src/api/client.ts
import type { SummaryDTO, RunsDTO, StoryDTO, QueueDTO } from './types.js'

const token = () => new URLSearchParams(location.search).get('token')
function q(path: string): string {
  const t = token()
  return t ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}` : path
}
async function get<T>(path: string): Promise<T> {
  const res = await fetch(q(path))
  if (!res.ok) throw new Error(`${path} → ${res.status}`)
  return res.json() as Promise<T>
}
export const api = {
  summary: () => get<SummaryDTO>('/api/summary'),
  runs: () => get<RunsDTO>('/api/runs'),
  story: (id: string) => get<StoryDTO>(`/api/runs/${encodeURIComponent(id)}`),
  queue: () => get<QueueDTO>('/api/queue'),
}
