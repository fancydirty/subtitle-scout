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

  // W0-5 live finding (2026-07-15): with a mixed backlog the model dispatched find-subtitle tasks
  // WITHOUT ever consulting check_series_layout — the old wording only mandated the check before
  // dispatch_realign_task, which is circular: nothing tells the model a series is suspect until it
  // checks. The realign birth-right now lives ONLY in the orchestrator (executor diagnose hook
  // removed, T3), so the layout sweep must be mandatory per backlog series, not suspicion-driven.
  it('mandates a check_series_layout sweep for EVERY backlog series BEFORE any find-subtitle dispatch (realign birth-right discipline)', () => {
    const c = ORCHESTRATOR_SKILL.content
    expect(c).toMatch(/EVERY series/)
    expect(c).toMatch(/before dispatching ANY find-subtitle task/i)
    expect(c).toMatch(/only way to know whether/i)
    // movies are exempt (no seasons — a wasted call otherwise)
    expect(c).toMatch(/movies?.*(no|never).*layout|layout.*(not|never).*movies?/i)
  })

  it('carries no hardcoded target-language assumption (A-generalization)', () => {
    expect(ORCHESTRATOR_SKILL.content).not.toMatch(/Chinese/i)
  })
})
