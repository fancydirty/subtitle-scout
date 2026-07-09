import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Journal } from './journal.js'

describe('Journal', () => {
  it('records steps, llm calls, api calls and writes decision.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'))
    const j = new Journal('req-1')
    j.step('identify', { note: 'started' })
    j.llmCall({ point: 'identifyMedia', prompt: 'p', rawText: 'r', parsed: { ok: true }, retries: 0, durationMs: 12 })
    j.apiCall({ endpoint: 'sub/search', params: { q: 'matrix' }, status: 0, durationMs: 30 })
    const out = j.finish({
      request_id: 'req-1', decision: 'no_safe_match',
      confidence: null, selected: null, reasons: ['none matched'], verification: null,
    }, dir)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    expect(written.decision.decision).toBe('no_safe_match')
    expect(written.steps.length).toBe(1)
    expect(written.llm_calls[0].point).toBe('identifyMedia')
    expect(written.api_calls[0].endpoint).toBe('sub/search')
    expect(written.request_id).toBe('req-1')
  })
})
