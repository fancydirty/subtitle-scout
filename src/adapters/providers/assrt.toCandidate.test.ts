import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { toCandidate } from './assrt.js'
import { AssrtSearchResponseSchema, type AssrtSub } from '../../core/schemas.js'

describe('toCandidate', () => {
  it('converts a real ASSRT search sub to a neutral candidate', () => {
    const resp = AssrtSearchResponseSchema.parse(
      JSON.parse(readFileSync('fixtures/assrt/search-matrix.json', 'utf8')))
    const sub = resp.sub.subs[0]
    const c = toCandidate(sub)
    expect(c.provider).toBe('assrt')
    expect(c.providerId).toBe(String(sub.id))
    expect(c.fileList.map(f => f.name)).toEqual(sub.filelist.map(f => f.f))
    expect(c.fileList.every((f, i) => f.index === i)).toBe(true)
  })
  it('joins array native_name with " / "', () => {
    const sub: AssrtSub = { id: 1, native_name: ['黑客帝国', '骇客任务'], filelist: [] }
    const c = toCandidate(sub)
    expect(c.nativeName).toBe('黑客帝国 / 骇客任务')
  })
  it('nullish edge cases: empty filelist, missing lang, missing videoname/filename', () => {
    const sub: AssrtSub = { id: 2, filelist: [] }
    const c = toCandidate(sub)
    expect(c.fileList).toEqual([])
    expect(c.language).toBeNull()
    expect(c.videoName).toBeNull()
  })
})
