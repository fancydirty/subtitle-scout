import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  MediaIdentitySchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
  PROVIDERS, SubtitleCandidateSchema, parseCandidateKey,
} from './schemas.js'

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
})

describe('ASSRT zero-result search (subs is an empty OBJECT, recorded 2026-07-06)', () => {
  it('normalizes subs {} to empty array', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/search-empty.json', 'utf8'))
    const r = AssrtSearchResponseSchema.parse(raw)
    expect(r.sub.subs).toEqual([])
  })
})

describe('PROVIDERS registry', () => {
  it('includes zimuku + local alongside assrt/opensubtitles（重复源 P4：local=本地候选，非真实网络适配器）', () => {
    expect(PROVIDERS).toEqual(['assrt', 'opensubtitles', 'zimuku', 'local'])
  })
  it('SubtitleCandidateSchema accepts provider:"zimuku"', () => {
    const c = SubtitleCandidateSchema.parse({
      provider: 'zimuku', providerId: '58421', videoName: null, nativeName: null,
      language: null, subtype: null, releaseSite: 'zimuku', uploadDate: null, fileList: [],
    })
    expect(c.provider).toBe('zimuku')
  })
  it('parseCandidateKey recognizes the zimuku: prefix', () => {
    expect(parseCandidateKey('zimuku:58421')).toEqual({ provider: 'zimuku', providerId: '58421' })
  })
})
