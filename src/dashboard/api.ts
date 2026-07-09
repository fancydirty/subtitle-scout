// src/dashboard/api.ts
import type { LedgerEvent } from '../core/ledger.js'
import type { SummaryDTO, RunDTO } from './types.js'
import { decisionLabel } from './labels.js'

type RunEvent = Extract<LedgerEvent, { type: 'run' }>
const READY = new Set(['download', 'adopted_local'])
const WINDOW_HOURS = 168

/** 本地时区当日零点（prod TZ=Asia/Shanghai）。 */
export function localMidnight(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** journalPath `/…/journals/<id>/decision.json` → `<id>`；无 journal 返回 ''。 */
function journalIdOf(journalPath: string): string {
  const m = journalPath.match(/journals\/([^/]+)\/decision\.json$/)
  return m ? m[1] : ''
}

export function buildSummary(
  events: LedgerEvent[], queue: { pending: number; dormant: number }, now: number,
): SummaryDTO {
  const runs = events.filter((e): e is RunEvent => e.type === 'run')
  const mid = localMidnight(now)
  return {
    status: 'running',
    todayReady: runs.filter(r => r.ts >= mid && READY.has(r.decision)).length,
    totalReady: runs.filter(r => READY.has(r.decision)).length,
    queuePending: queue.pending,
    queueDormant: queue.dormant,
    runsInWindow: runs.length,
    windowHours: WINDOW_HOURS,
  }
}

export function buildRuns(events: LedgerEvent[], limit: number): RunDTO[] {
  return events
    .filter((e): e is RunEvent => e.type === 'run')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map(r => {
      const { label, tone } = decisionLabel(r.decision)
      const id = journalIdOf(r.journalPath)
      return { id, itemId: r.itemId, name: r.name, decision: r.decision, outcomeLabel: label, tone, ts: r.ts, clickable: id !== '' }
    })
}
