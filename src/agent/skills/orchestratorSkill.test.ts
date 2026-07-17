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

  // W0-5 live finding (2026-07-15) 存留 + R-8 改判（2026-07-16）：不查就永远不知道嫌疑——
  // "例行去看 layout 事实"的习惯教导保留（这是告诉 agent 眼睛往哪看，不是守门）；但旧版的
  // "only proceed if true / never dispatch" 判决式措辞已被 B5 定罪处决——布尔是证据，
  // 结论归 orchestrator，灾难防线在下游 executeRealign。
  it('teaches the routine layout-fact sweep (look for every series, movies exempt) WITHOUT verdict-gating wording', () => {
    const c = ORCHESTRATOR_SKILL.content
    expect(c).toMatch(/EVERY series/)
    expect(c).toMatch(/check_series_layout/)
    expect(c).toMatch(/movies?[\s\S]{0,80}(no|never)[\s\S]{0,80}layout/i)
    // 双信号并列呈现（R-8/C-B5：exceedsSeasonTable 未全死，diskLayoutNonstandard 为并列事实）
    expect(c).toMatch(/exceedsSeasonTable/)
    expect(c).toMatch(/diskLayoutNonstandard/)
    expect(c).toMatch(/tmdbUnavailable/)
    // 证据非判决——守门措辞已死
    expect(c).toMatch(/neither is a[\s\S]{0,20}verdict|evidence for your judgment/i)
    expect(c).not.toMatch(/only proceed if/i)
    expect(c).not.toMatch(/never dispatch realign/i)
  })

  // T8b/T8c/R-11 新灵魂条款锚：停牌事实读法、范围裁量、派发回执。
  it('teaches throttled-coverage reading, scope-by-disk-reality (seasons array), and dispatch receipts', () => {
    const c = ORCHESTRATOR_SKILL.content
    expect(c).toMatch(/throttled/)
    expect(c).toMatch(/nextRecheckAt/)
    expect(c).toMatch(/seasons: \[1, 2, 3\]|seasons array/i)
    expect(c).toMatch(/YOUR judgment/i)
    expect(c).toMatch(/coalesced/)
    expect(c).toMatch(/blocked_dormant/)
  })

  it('carries no hardcoded target-language assumption (A-generalization)', () => {
    expect(ORCHESTRATOR_SKILL.content).not.toMatch(/Chinese/i)
  })

  // 救援R3 锚：parked 事实块读法 + 救援派发礼仪（一趟一单/预算共享/识别判断归 rescue worker）。
  it('teaches the parked fact block and rescue dispatch etiquette', () => {
    const c = ORCHESTRATOR_SKILL.content
    expect(c).toMatch(/parked/)
    expect(c).toMatch(/dispatch_rescue_task/)
    expect(c).toMatch(/once per pass|never dispatch it more than once/i)
    expect(c).toMatch(/same 100-dispatch budget/i)
    // 识别判断归 rescue worker，orchestrator 不许自己猜停车路径是什么
    expect(c).toMatch(/belongs to that\s+worker|not to you/i)
  })
})
