import { describe, it, expect } from 'vitest'
import { RESOURCE_TYPES, SOURCE_FORMS, CELL_CATALOG, cellDir, loadCell } from './liveMatrix.js'

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

  it('every SEEDED cell loads with a task, expected answer, and a non-empty responses dir', () => {
    for (const c of CELL_CATALOG.filter(x => x.seeded)) {
      const loaded = loadCell(c.resourceType, c.sourceForm)
      expect(loaded.task.title.length).toBeGreaterThan(0)
      expect(['installed', 'no_safe_match', 'retry_later']).toContain(loaded.expected.decision)
      expect(loaded.responseCount).toBeGreaterThan(0)
    }
  })
})
