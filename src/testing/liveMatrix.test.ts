import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RESOURCE_TYPES, SOURCE_FORMS, CELL_CATALOG, cellDir, loadCell, type CellExpectation } from './liveMatrix.js'
import type { RecordedResponse } from './replayFetch.js'

/** Structural gate for one recorded-response file; returns a human-readable problem or null.
 *  Guards the failure mode a filename count can't see: a corrupt file (bad JSON, missing
 *  signature/bodyBase64) passes the counting test today and only explodes later inside replay. */
function validateRecordedResponse(raw: string): string | null {
  let rec: RecordedResponse
  try { rec = JSON.parse(raw) as RecordedResponse } catch { return 'not valid JSON' }
  if (typeof rec.signature !== 'string' || rec.signature.length === 0) return 'signature missing or empty'
  if (typeof rec.status !== 'number') return 'status is not a number'
  if (rec.headers == null || typeof rec.headers !== 'object' || Array.isArray(rec.headers)) return 'headers is not an object'
  if (typeof rec.bodyBase64 !== 'string' || rec.bodyBase64.length === 0) return 'bodyBase64 missing or empty'
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(rec.bodyBase64)) return 'bodyBase64 is not valid base64'
  if (Buffer.from(rec.bodyBase64, 'base64').length === 0) return 'bodyBase64 decodes to an empty body'
  return null
}

describe('live matrix catalog', () => {
  it('every catalog cell names a valid axis pair', () => {
    for (const c of CELL_CATALOG) {
      expect(RESOURCE_TYPES).toContain(c.resourceType)
      expect(SOURCE_FORMS).toContain(c.sourceForm)
    }
  })

  it('cell ids are unique', () => {
    const ids = CELL_CATALOG.map(c => `${c.resourceType}/${c.sourceForm}`)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('cellDir maps to fixtures/v3-live/<type>/<form>', () => {
    expect(cellDir('anime', 'only-pack')).toMatch(/fixtures\/v3-live\/anime\/only-pack$/)
  })

  it('CellExpectation.installedLanguage accepts zh-any (coverage-first, no 简/繁 ranking)', () => {
    const expected: CellExpectation = {
      decision: 'installed',
      installedFilename: 'Some.Show.S01E01.zh-Hans.srt',
      installedLanguage: 'zh-any',
    }
    expect(expected.installedLanguage).toBe('zh-any')
  })

  it('every SEEDED cell loads with a task, expected answer, and a non-empty responses dir', () => {
    for (const c of CELL_CATALOG.filter(x => x.seeded)) {
      const loaded = loadCell(c.resourceType, c.sourceForm)
      expect(loaded.task.title.length).toBeGreaterThan(0)
      expect(['installed', 'no_safe_match', 'retry_later']).toContain(loaded.expected.decision)
      expect(loaded.responseCount).toBeGreaterThan(0)
    }
  })

  it('every recorded response in every SEEDED cell is a structurally valid RecordedResponse', () => {
    const problems: string[] = []
    for (const c of CELL_CATALOG.filter(x => x.seeded)) {
      const loaded = loadCell(c.resourceType, c.sourceForm)
      for (const f of readdirSync(loaded.responsesDir).filter(n => n.endsWith('.json'))) {
        const problem = validateRecordedResponse(readFileSync(join(loaded.responsesDir, f), 'utf8'))
        if (problem) problems.push(`${join(loaded.responsesDir, f)}: ${problem}`)
      }
    }
    expect(problems).toEqual([])
  })
})
