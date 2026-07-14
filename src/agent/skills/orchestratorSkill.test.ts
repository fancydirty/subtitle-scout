import { describe, it, expect } from 'vitest'
import { ORCHESTRATOR_SKILL } from './orchestratorSkill.js'

describe('ORCHESTRATOR_SKILL', () => {
  it('is non-empty and states the dispatch-order rule, the effort-scaling rule, and the 100-cap escape valve', () => {
    expect(ORCHESTRATOR_SKILL.descriptor.name).toBe('orchestrator-dispatch')
    expect(ORCHESTRATOR_SKILL.descriptor.description.length).toBeGreaterThan(0)
    // how to read the living-doc
    expect(ORCHESTRATOR_SKILL.content).toMatch(/list_missing_coverage/)
    // dependency ordering: realign before find-subtitle for the same series
    expect(ORCHESTRATOR_SKILL.content).toMatch(/realign/i)
    expect(ORCHESTRATOR_SKILL.content).toMatch(/before.*find-subtitle|find-subtitle.*after/i)
    // a realign-candidate series gets realign ONLY this pass — its find-subtitle is DEFERRED to a
    // later pass (realign restructures the layout; a find dispatched now targets files about to
    // move). This resolves the earlier self-contradiction that made the model flakily skip OR
    // over-dispatch the find on a mixed series (v3 B-layer live finding, 2026-07-14).
    expect(ORCHESTRATOR_SKILL.content).toMatch(/later.*pass|about to move/i)
    // effort-scaling / cost-blowup rule
    expect(ORCHESTRATOR_SKILL.content).toMatch(/scale|effort/i)
    // hard 100-dispatch cap + escape valve
    expect(ORCHESTRATOR_SKILL.content).toMatch(/100/)
    expect(ORCHESTRATOR_SKILL.content).toMatch(/spawn_sibling_orchestrator/)
  })
})
