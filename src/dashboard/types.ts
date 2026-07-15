// src/dashboard/types.ts
export type Tone = 'ok' | 'muted' | 'skip' | 'fail'

export interface SummaryDTO {
  status: 'running'
  todayReady: number
  totalReady: number
  queuePending: number
  queueDormant: number
  runsInWindow: number
  windowHours: number
}
export interface InFlightItemDTO { itemId: string; name: string; source: string }
export interface RunDTO {
  id: string; itemId: string; name: string; decision: string
  outcomeLabel: string; tone: Tone; ts: number; clickable: boolean
}
export interface RunsDTO { inFlight: InFlightItemDTO[]; runs: RunDTO[] }
export interface QueueItemDTO { itemId: string; name: string; statusLabel: string; nextRetryAt: number | null }
export interface QueueDTO { pending: QueueItemDTO[]; dormant: QueueItemDTO[] }
