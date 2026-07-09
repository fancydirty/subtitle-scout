import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { FinalDecision } from './schemas.js'

export interface LlmCallRecord {
  point: string
  prompt: string
  rawText: string
  parsed: unknown
  retries: number
  durationMs: number
  error?: string
}
export interface ApiCallRecord {
  endpoint: string
  params: Record<string, unknown>
  status: number | null
  durationMs: number
  error?: string
}

export class Journal {
  private steps: Array<{ name: string; at: string; data?: unknown }> = []
  private llmCalls: LlmCallRecord[] = []
  private apiCalls: ApiCallRecord[] = []
  constructor(private requestId: string) {}

  step(name: string, data?: unknown) {
    this.steps.push({ name, at: new Date().toISOString(), data })
  }
  llmCall(r: LlmCallRecord) { this.llmCalls.push(r) }
  apiCall(r: ApiCallRecord) { this.apiCalls.push(r) }

  counts(): { llmCalls: number; apiCalls: number } {
    return { llmCalls: this.llmCalls.length, apiCalls: this.apiCalls.length }
  }

  finish(decision: FinalDecision, outDir: string): string {
    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, 'decision.json')
    writeFileSync(path, JSON.stringify({
      request_id: this.requestId,
      finished_at: new Date().toISOString(),
      decision,
      steps: this.steps,
      llm_calls: this.llmCalls,
      api_calls: this.apiCalls,
    }, null, 2))
    return path
  }
}
