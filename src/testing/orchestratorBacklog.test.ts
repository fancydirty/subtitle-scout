import { describe, it, expect } from 'vitest'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { makeCheckSeriesLayoutTool } from '../agent/orchestratorAgent.tools.js'
import { seedBacklog, makeBacklogFakes } from './seedBacklog.js'
import { ORCHESTRATOR_BACKLOG_SHAPES } from './orchestratorBacklog.js'

// Same fakeOpts shape .execute! expects as its 2nd arg — see orchestratorAgent.tools.test.ts:11.
const fakeOpts = { toolCallId: 't1', messages: [] } as any

describe('ORCHESTRATOR_BACKLOG_SHAPES', () => {
  it('has unique names and covers the clean/normal-missing/messy-realign baseline shapes', () => {
    const names = ORCHESTRATOR_BACKLOG_SHAPES.map(s => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('clean')
    expect(names).toContain('normal-missing')
    expect(names).toContain('messy-realign')
  })

  it('each shape\'s seeded world is internally consistent: exactly the series in ' +
     'expected.realignSeriesIds have SOME season that exceeds the TMDB season table, and no ' +
     'other series does', async () => {
    for (const shape of ORCHESTRATOR_BACKLOG_SHAPES) {
      const db = openDb(':memory:')
      const lib = new LibraryRepo(db)
      seedBacklog(lib, shape)
      const { tmdb } = makeBacklogFakes(shape)
      const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

      for (const series of shape.series) {
        const results = await Promise.all(
          series.seasons.map(se => checkSeriesLayout.execute!({ seriesId: series.id, season: se.season }, fakeOpts)),
        )
        const anyExceeds = results.some(r => (r as { exceedsSeasonTable: boolean }).exceedsSeasonTable)
        if (shape.expected.realignSeriesIds.includes(series.id)) {
          expect(anyExceeds, `shape "${shape.name}" series "${series.id}" should have a season exceeding TMDB`).toBe(true)
        } else {
          expect(anyExceeds, `shape "${shape.name}" series "${series.id}" should NOT have any season exceeding TMDB`).toBe(false)
        }
      }
    }
  })
})
