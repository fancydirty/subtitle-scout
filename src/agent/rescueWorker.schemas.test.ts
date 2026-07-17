import { describe, it, expect } from 'vitest'
import { RescueReportSchema, type RescueReportParsed } from './rescueWorker.schemas.js'
import type { RescueReport } from '../v2/rescueWorkerTask.js'

describe('RescueReportSchema', () => {
  it('parses a claimed outcome', () => {
    const parsed = RescueReportSchema.parse({
      outcomes: [{ dir: '/media/A', outcome: 'claimed', tmdbId: '123', isTv: true, season: 1 }],
    })
    expect(parsed.outcomes).toHaveLength(1)
    expect(parsed.outcomes[0].outcome).toBe('claimed')
  })

  it('parses a parked outcome', () => {
    const parsed = RescueReportSchema.parse({
      outcomes: [{ dir: '/media/B', outcome: 'parked', reason: 'still unsure' }],
    })
    expect(parsed.outcomes[0].outcome).toBe('parked')
    expect((parsed.outcomes[0] as { reason: string }).reason).toBe('still unsure')
  })

  it('parses an excluded outcome', () => {
    const parsed = RescueReportSchema.parse({
      outcomes: [{ dir: '/media/C', outcome: 'excluded' }],
    })
    expect(parsed.outcomes[0].outcome).toBe('excluded')
  })

  it('rejects non-numeric tmdbId', () => {
    expect(() =>
      RescueReportSchema.parse({
        outcomes: [{ dir: '/media/A', outcome: 'claimed', tmdbId: 'abc', isTv: false }],
      })
    ).toThrow()
  })

  it('type-level shape matches RescueReport from v2/rescueWorkerTask.ts', () => {
    const parsed: RescueReportParsed = RescueReportSchema.parse({
      outcomes: [
        { dir: '/media/A', outcome: 'claimed', tmdbId: '123', isTv: true, season: 1 },
        { dir: '/media/B', outcome: 'parked', reason: 'unsure' },
        { dir: '/media/C', outcome: 'excluded' },
      ],
    })
    const _t: RescueReport = parsed
    expect(_t.outcomes).toHaveLength(3)
  })
})
