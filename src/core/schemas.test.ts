import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MediaContextSchema, MediaIdentitySchema, SearchPlanSchema,
  RankDecisionSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
  FinalDecisionSchema, OrphanDecisionSchema, LooseEpisodesMapSchema,
  VerifyDecisionSchema,
} from './schemas.js'

describe('MediaContextSchema', () => {
  it('accepts the matrix fixture', () => {
    const raw = JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8'))
    const ctx = MediaContextSchema.parse(raw)
    expect(ctx.media.title).toBe('The Matrix')
    expect(ctx.media.season).toBeNull()
  })
  it('rejects unknown media type', () => {
    const raw = JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8'))
    raw.media.type = 'music'
    expect(() => MediaContextSchema.parse(raw)).toThrow()
  })
})

describe('ASSRT response schemas', () => {
  it('parses recorded search response incl. empty-object filelist', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8'))
    const r = AssrtSearchResponseSchema.parse(raw)
    expect(r.status).toBe(0)
    expect(r.sub.subs.length).toBeGreaterThan(0)
    expect(r.sub.subs.some(s => s.filelist.length === 0)).toBe(true)
    expect(r.sub.subs.some(s => s.filelist.length > 0)).toBe(true)
  })
  it('parses recorded detail response with per-file urls', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/detail-673114.json', 'utf8'))
    const r = AssrtDetailResponseSchema.parse(raw)
    expect(r.sub.subs[0].url).toMatch(/^http/)
    expect(r.sub.subs[0].filelist[0].url).toMatch(/^http/)
  })
})

describe('agent output schemas', () => {
  it('RankDecision requires assrt_id when decision=download', () => {
    expect(() => RankDecisionSchema.parse({
      decision: 'download', confidence: 0.9, reasons: ['x'], rejected: [],
    })).toThrow()
  })
  it('SearchPlan caps at 3 queries', () => {
    expect(() => SearchPlanSchema.parse({
      queries: [{ q: 'a', reason: 'r' }, { q: 'b', reason: 'r' }, { q: 'c', reason: 'r' }, { q: 'd', reason: 'r' }],
    })).toThrow()
  })
  it('MediaIdentity roundtrips', () => {
    const id = MediaIdentitySchema.parse({
      canonical_title: 'The Matrix', year: 1999, type: 'movie',
      season: null, episode: null, edition: null,
      confidence: 0.95, evidence: ['filename contains 1999'],
    })
    expect(id.type).toBe('movie')
  })
})

describe('LLM output coercion (MiMo returns numbers as strings)', () => {
  it('MediaIdentity coerces numeric strings and dash-to-null', () => {
    const id = MediaIdentitySchema.parse({
      canonical_title: 'The Matrix', year: '1999', type: 'movie',
      season: '-', episode: '', edition: null,
      confidence: '0.95', evidence: [],
    })
    expect(id.year).toBe(1999)
    expect(id.season).toBeNull()
    expect(id.episode).toBeNull()
    expect(id.confidence).toBe(0.95)
  })
  it('MediaIdentity coerces Python-style "None" to null, incl. string fields', () => {
    const id = MediaIdentitySchema.parse({
      canonical_title: 'The Matrix', year: '1999', type: 'movie',
      season: 'None', episode: 'None', edition: 'None',
      confidence: 0.99, evidence: [],
    })
    expect(id.season).toBeNull()
    expect(id.episode).toBeNull()
    expect(id.edition).toBeNull()
  })
  it('MediaIdentity still rejects garbage numerics', () => {
    expect(() => MediaIdentitySchema.parse({
      canonical_title: 'x', year: 'about 1999', type: 'movie',
      season: null, episode: null, edition: null, confidence: 0.9, evidence: [],
    })).toThrow()
  })
  it('RankDecision coerces candidate_id numbers and file_index strings', () => {
    const r = RankDecisionSchema.parse({
      decision: 'download', candidate_id: 673114, file_index: '0',
      confidence: '0.91', reasons: [], rejected: [],
    })
    expect(r.candidate_id).toBe('673114') // JSON number → string（MiMo 同款边界事故防御）
    expect(r.file_index).toBe(0)
    expect(r.confidence).toBe(0.91)
  })
  it('RankDecision normalizes nullish-string candidate_id to null on non-download', () => {
    const r = RankDecisionSchema.parse({
      decision: 'no_safe_match', candidate_id: 'None', file_index: null,
      confidence: 0.3, reasons: [], rejected: [],
    })
    expect(r.candidate_id).toBeNull()
  })
  it('RankDecision tolerates numeric candidate_id inside rejected[]', () => {
    const r = RankDecisionSchema.parse({
      decision: 'download', candidate_id: 'assrt:673114', file_index: 0,
      confidence: 0.9, reasons: [], rejected: [{ candidate_id: 606770, reason: 'wrong cut' }],
    })
    expect(r.rejected[0].candidate_id).toBe('606770')
  })
  it('LooseEpisodesMap fail-soft: one bad candidate_id row does not kill the whole parse', () => {
    const m = LooseEpisodesMapSchema.parse({
      assignments: [
        { episode_code: 'S02E01', candidate_id: 'assrt:801', confidence: 0.95 },
        { episode_code: 'S02E02', candidate_id: null, confidence: 0.95 },
        { episode_code: 'S02E03', candidate_id: 803, confidence: 0.95 },
      ],
      reasons: [],
    })
    expect(m.assignments).toHaveLength(3)
    expect(m.assignments[0].candidate_id).toBe('assrt:801')
    expect(m.assignments[1].candidate_id).toBeNull()   // 下游 filter 剔除，不炸整季
    expect(m.assignments[2].candidate_id).toBe('803')  // 数字容忍
  })
})

describe('ASSRT zero-result search (subs is an empty OBJECT, recorded 2026-07-06)', () => {
  it('normalizes subs {} to empty array', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/search-empty.json', 'utf8'))
    const r = AssrtSearchResponseSchema.parse(raw)
    expect(r.sub.subs).toEqual([])
  })
})

describe('M4 additions', () => {
  it('FinalDecision accepts adopted_local', () => {
    const d = FinalDecisionSchema.parse({
      request_id: 'r', decision: 'adopted_local',
      confidence: 0.9, selected: null, reasons: ['adopted from orphan'], verification: null,
    })
    expect(d.decision).toBe('adopted_local')
  })
  it('OrphanDecision requires file+language when adopt=true', () => {
    expect(() => OrphanDecisionSchema.parse({
      adopt: true, confidence: 0.9, reasons: [],
    })).toThrow()
    const ok = OrphanDecisionSchema.parse({
      adopt: true, file: 'x.ass', language: 'zh-Hans', confidence: 0.9, reasons: ['chinese content'],
    })
    expect(ok.file).toBe('x.ass')
  })
  it('OrphanDecision allows "None" strings in rejection path (production case S04E12)', () => {
    // LLM outputs {"adopt":false,"file":"None","language":"None"} when rejecting — should parse and normalize to null
    const rejection = OrphanDecisionSchema.parse({
      adopt: false, file: 'None', language: 'None', confidence: 1, reasons: ['not this video'],
    })
    expect(rejection.file).toBeNull()
    expect(rejection.language).toBeNull()
  })
  it('OrphanDecision still enforces language enum when adopt=true', () => {
    // Strictness preserved: adopt=true requires valid enum, "None" is rejected
    expect(() => OrphanDecisionSchema.parse({
      adopt: true, file: 'x.ass', language: 'None', confidence: 0.9, reasons: [],
    })).toThrow()
  })
})

describe('VerifyDecisionSchema', () => {
  it('accepts {match, reason} with no confidence field', () => {
    const d = VerifyDecisionSchema.parse({ match: true, reason: 'cue count and span line up with the episode runtime' })
    expect(d.match).toBe(true)
  })
  it('rejects a missing reason', () => {
    expect(() => VerifyDecisionSchema.parse({ match: false })).toThrow()
  })
  it('rejects a non-boolean match', () => {
    expect(() => VerifyDecisionSchema.parse({ match: 'yes', reason: 'x' })).toThrow()
  })
})
