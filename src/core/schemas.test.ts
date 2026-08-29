import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  AssrtSearchResponseSchema, AssrtDetailResponseSchema,
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

describe('ASSRT zero-result search (subs is an empty OBJECT, recorded 2026-07-06)', () => {
  it('normalizes subs {} to empty array', () => {
    const raw = JSON.parse(readFileSync('fixtures/assrt/search-empty.json', 'utf8'))
    const r = AssrtSearchResponseSchema.parse(raw)
    expect(r.sub.subs).toEqual([])
  })
})

describe('PROVIDERS registry', () => {
  it('includes zimuku + jimaku + r3sub + subdl + local alongside assrt/opensubtitles（F2:jimaku=日字源;r3sub=台版官方源;subdl=subscene接班国际源;local=本地候选非网络适配器）', () => {
    expect(PROVIDERS).toEqual(['assrt', 'opensubtitles', 'zimuku', 'subhd', 'jimaku', 'r3sub', 'subdl', 'local'])
  })
  it('parseCandidateKey 认得 r3sub/subdl（2026-08-29 双源接入）', () => {
    expect(parseCandidateKey('r3sub:S8g2H021493')).toEqual({ provider: 'r3sub', providerId: 'S8g2H021493' })
    expect(parseCandidateKey('subdl:3197651-3213944')).toEqual({ provider: 'subdl', providerId: '3197651-3213944' })
  })
  it("PROVIDERS 含 'jimaku'，且 provider:'jimaku' 的候选能通过校验", () => {
    expect(PROVIDERS).toContain('jimaku')
    const parsed = SubtitleCandidateSchema.safeParse({ provider: 'jimaku', providerId: '729' })
    expect(parsed.success).toBe(true)
  })
  it('parseCandidateKey recognizes the jimaku: prefix', () => {
    expect(parseCandidateKey('jimaku:729')).toEqual({ provider: 'jimaku', providerId: '729' })
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
  it("PROVIDERS 含 'subhd'，且 provider:'subhd' 的候选能通过校验", () => {
    expect(PROVIDERS).toContain('subhd')
    const parsed = SubtitleCandidateSchema.safeParse({ provider: 'subhd', providerId: 'aZ9' })
    expect(parsed.success).toBe(true)
  })
  it('parseCandidateKey recognizes the subhd: prefix', () => {
    expect(parseCandidateKey('subhd:aCZvOt')).toEqual({ provider: 'subhd', providerId: 'aCZvOt' })
  })
})
