import type { LedgerEvent } from '../core/ledger.js'

/** 解析 --since 值为毫秒时间戳。裸 ISO 日期按 UTC 午夜解释（2026-07-07 = 2026-07-07T00:00:00Z）。 */
export function parseSince(raw: string, now: number): number {
  const rel = raw.match(/^(\d+)(h|d)$/)
  if (rel) return now - Number(rel[1]) * (rel[2] === 'h' ? 3600_000 : 86_400_000)
  const abs = Date.parse(raw)
  if (!Number.isNaN(abs)) return abs
  throw new Error(`invalid --since value: ${raw} (use 24h / 7d / ISO date)`)
}

type RunEvent = Extract<LedgerEvent, { type: 'run' }>
type QueueEvent = Extract<LedgerEvent, { type: 'queue' }>

export function formatReport(
  events: LedgerEvent[], badLines: number, queueNow: { pending: number; dormant: number },
): string {
  const runs = events.filter((e): e is RunEvent => e.type === 'run')
  const queues = events.filter((e): e is QueueEvent => e.type === 'queue')
  const lines: string[] = []

  if (events.length === 0) return '台账内无记录（指定时间范围内）\n'

  const byDecision = new Map<string, number>()
  const bySource = new Map<string, number>()
  for (const r of runs) {
    byDecision.set(r.decision, (byDecision.get(r.decision) ?? 0) + 1)
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1)
  }
  lines.push(`== 运行 ${runs.length} 次 ==`)
  for (const [d, n] of byDecision) lines.push(`  ${d}: ${n}`)
  lines.push(`  来源: ${[...bySource].map(([s, n]) => `${s}=${n}`).join(' ')}`)

  const failures = runs.filter(r => ['no_safe_match', 'ask_user', 'error'].includes(r.decision))
  if (failures.length) {
    lines.push(`== 未成功明细 ==`)
    for (const f of failures) {
      lines.push(`  [${f.decision}] ${f.name} (${f.source})${f.error ? ` — ${f.error.slice(0, 80)}` : ''}`)
      lines.push(`      journal: ${f.journalPath}`)
    }
  }

  const byQueueEvent = new Map<string, number>()
  for (const q of queues) byQueueEvent.set(q.event, (byQueueEvent.get(q.event) ?? 0) + 1)
  lines.push(`== 队列 ==`)
  for (const [e, n] of byQueueEvent) lines.push(`  ${e}: ${n}`)
  lines.push(`  当前: pending=${queueNow.pending} dormant=${queueNow.dormant}`)

  const llm = runs.reduce((s, r) => s + r.llmCalls, 0)
  const assrt = runs.reduce((s, r) => s + r.assrtCalls, 0)
  const modes = new Map<string, number>()
  for (const r of runs) modes.set(r.llmProfile.mode, (modes.get(r.llmProfile.mode) ?? 0) + 1)
  lines.push(`== 资源 ==`)
  lines.push(`  LLM 调用: ${llm}（模式: ${[...modes].map(([m, n]) => `${m}=${n}`).join(' ') || '-'}）`)
  lines.push(`  ASSRT 调用: ${assrt}`)
  if (badLines > 0) lines.push(`⚠ 台账坏行: ${badLines}`)
  return lines.join('\n') + '\n'
}
