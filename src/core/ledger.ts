import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

export const LedgerRunEventSchema = z.object({
  ts: z.number(),
  type: z.literal('run'),
  itemId: z.string(),
  name: z.string(),
  source: z.enum(['playback', 'queue', 'cli']),
  decision: z.string(),
  confidence: z.number().nullish(),
  subtitlePath: z.string().nullish(),
  journalPath: z.string(),
  llmProfile: z.object({ mode: z.string(), quirkId: z.string().nullish() }).passthrough(),
  durationMs: z.number(),
  llmCalls: z.number(),
  assrtCalls: z.number(),
  error: z.string().nullish(),
})
export const LedgerQueueEventSchema = z.object({
  ts: z.number(),
  type: z.literal('queue'),
  event: z.enum(['enqueued', 'decayed', 'dormant', 'activated', 'removed']),
  itemId: z.string(),
  name: z.string(),
  attempts: z.number().nullish(),
  nextRetryAt: z.number().nullish(),
})
export const LedgerEventSchema = z.discriminatedUnion('type', [LedgerRunEventSchema, LedgerQueueEventSchema])
export type LedgerEvent = z.infer<typeof LedgerEventSchema>

/** 追加式运行台账。journal 是深度，ledger 是时间线。 */
export class Ledger {
  constructor(private file: string) { mkdirSync(dirname(file), { recursive: true }) }

  append(event: LedgerEvent) {
    appendFileSync(this.file, JSON.stringify(event) + '\n')
  }

  read(sinceMs: number): { events: LedgerEvent[]; badLines: number } {
    if (!existsSync(this.file)) return { events: [], badLines: 0 }
    const events: LedgerEvent[] = []
    let badLines = 0
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = LedgerEventSchema.parse(JSON.parse(line))
        if (parsed.ts >= sinceMs) events.push(parsed)
      } catch { badLines++ }
    }
    return { events, badLines }
  }
}
