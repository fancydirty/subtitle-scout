// src/dashboard/story.test.ts
import { describe, it, expect } from 'vitest'
import { buildRunStory } from './story.js'

const baseJournal = (over: Record<string, unknown> = {}) => ({
  request_id: 'r', finished_at: 'ISO',
  decision: { request_id: 'r', decision: 'download', confidence: 0.9,
    selected: { assrt_id: 1, subtitle_name: 'Foo.简体.ass', language: 'zh-Hans', format: 'ass' },
    reasons: [], verification: { downloaded: true, path: '/m/x.ass', bytes: 100, encoding: 'utf-8' } },
  steps: [ { name: 'identify', at: 't' }, { name: 'planSearch', at: 't' },
    { name: 'assrtSearch', at: 't', data: { q: 'Foo' } }, { name: 'candidateFilter', at: 't', data: { raw: 5, kept: 3 } },
    { name: 'rankCandidates', at: 't', data: { count: 3 } }, { name: 'gate', at: 't' },
    { name: 'download', at: 't' }, { name: 'write', at: 't' } ],
  llm_calls: [ { point: 'identify', prompt: 'P', rawText: 'R', parsed: { title: 'Foo' }, retries: 0, durationMs: 12 } ],
  api_calls: [],
  ...over,
})
const ledgerEvent = { name: 'Foo (2020)', decision: 'download', ts: 1000 }

describe('buildRunStory', () => {
  it('renders a 4-step plain-language story for a single-episode download', () => {
    const s = buildRunStory(baseJournal(), ledgerEvent as any)
    expect(s.name).toBe('Foo (2020)')
    expect(s.outcomeLabel).toBe('已下好中文字幕')
    expect(s.steps).toHaveLength(4)
    expect(s.steps.map(x => x.title)).toEqual(['认出这部片', '去字幕站找了一圈', '挑了最靠谱的那份', '下好并放到位'])
    expect(s.steps.every(x => x.state === 'done')).toBe(true)
    expect(s.steps[3].detail).toContain('Jellyfin')
  })

  it('highlights whole-season coverage when seasonGraduate present', () => {
    const journal = baseJournal({
      steps: [ { name: 'identify', at: 't' }, { name: 'planSearch', at: 't' },
        { name: 'seasonGraduate', at: 't', data: { packId: 642240, episodes: 8, needs: 8 } },
        { name: 'seasonPackGate', at: 't', data: { commit: 8, dropped: 8 } },
        { name: 'write', at: 't' } ],
      decision: { ...baseJournal().decision, reasons: ['season pack: covered 8 episodes'] },
    })
    const s = buildRunStory(journal, ledgerEvent as any)
    expect(s.steps[1].detail).toContain('整季')
    expect(s.steps[3].detail).toContain('8 集')
  })

  it('marks the failing step for no_safe_match', () => {
    const journal = baseJournal({
      decision: { request_id: 'r', decision: 'no_safe_match', confidence: null, selected: null, reasons: [], verification: null },
      steps: [ { name: 'identify', at: 't' }, { name: 'planSearch', at: 't' },
        { name: 'assrtSearch', at: 't', data: { q: 'Foo' } }, { name: 'candidateFilter', at: 't', data: { raw: 0, kept: 0 } },
        { name: 'gate', at: 't' } ],
    })
    const s = buildRunStory(journal, { name: 'Foo', decision: 'no_safe_match', ts: 1 } as any)
    expect(s.tone).toBe('muted')
    const fail = s.steps.find(x => x.state === 'fail')
    expect(fail).toBeTruthy()
    expect(fail!.detail).not.toMatch(/gate|no_safe_match|升格|映射/) // 无黑话
  })

  it('exposes tier-2 raw pipeline steps + llm calls', () => {
    const s = buildRunStory(baseJournal(), ledgerEvent as any)
    expect(s.raw.pipelineSteps.map(x => x.name)).toContain('assrtSearch')
    expect(s.raw.llmCalls[0]).toMatchObject({ point: 'identify', durationMs: 12 })
  })
})
