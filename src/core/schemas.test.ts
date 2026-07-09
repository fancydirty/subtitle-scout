import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MediaContextSchema, MediaIdentitySchema, SearchPlanSchema,
  RankDecisionSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
  FinalDecisionSchema, OrphanDecisionSchema,
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
  it('RankDecision coerces assrt_id and file_index strings', () => {
    const r = RankDecisionSchema.parse({
      decision: 'download', assrt_id: '673114', file_index: '0',
      confidence: '0.91', reasons: [], rejected: [],
    })
    expect(r.assrt_id).toBe(673114)
    expect(r.file_index).toBe(0)
    expect(r.confidence).toBe(0.91)
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
})
