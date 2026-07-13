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
    // effort-scaling / cost-blowup rule
    expect(ORCHESTRATOR_SKILL.content).toMatch(/scale|effort/i)
    // hard 100-dispatch cap + escape valve
    expect(ORCHESTRATOR_SKILL.content).toMatch(/100/)
    expect(ORCHESTRATOR_SKILL.content).toMatch(/spawn_sibling_orchestrator/)
  })
})
