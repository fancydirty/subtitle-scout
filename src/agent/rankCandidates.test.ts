import { describe, it, expect } from 'vitest'
import { compactCandidates, filterGraphicOnly, isGraphicOnly, MAX_CANDIDATES, MAX_FILELIST_ENTRIES } from './rankCandidates.js'
import type { AssrtSub } from '../core/schemas.js'

function fakeSub(id: number, files: number): AssrtSub {
  return {
    id, videoname: `v${id}`, native_name: null, release_site: null, subtype: null,
    lang: { desc: '简', langlist: null }, filename: null, size: null,
    filelist: Array.from({ length: files }, (_, i) => ({ f: `file${i}.ass` })),
  } as unknown as AssrtSub
}

describe('compactCandidates', () => {
  it('caps candidate count', () => {
    const out = compactCandidates(Array.from({ length: 20 }, (_, i) => fakeSub(i, 1)))
    expect(out.length).toBe(MAX_CANDIDATES)
  })
  it('truncates long filelists and records the truncation', () => {
    const out = compactCandidates([fakeSub(1, 100)])
    expect(out[0].filelist.length).toBe(MAX_FILELIST_ENTRIES)
    expect(out[0].filelist_truncated).toBe(100 - MAX_FILELIST_ENTRIES)
    expect(out[0].filelist[0]).toBe('file0.ass') // 保序：shown index === original index
  })
  it('leaves short filelists untouched', () => {
    const out = compactCandidates([fakeSub(1, 3)])
    expect(out[0].filelist.length).toBe(3)
    expect(out[0].filelist_truncated).toBeUndefined()
  })
})

function subWithFiles(id: number, files: string[], subtype: string | null = null): AssrtSub {
  return {
    id, videoname: `v${id}`, native_name: null, release_site: null, subtype,
    lang: { desc: '简', langlist: null }, filename: null, size: null,
    filelist: files.map(f => ({ f })),
  } as unknown as AssrtSub
}

describe('isGraphicOnly', () => {
  it('keeps candidates that contain any text subtitle', () => {
    expect(isGraphicOnly(subWithFiles(1, ['movie.chs.srt']))).toBe(false)
    expect(isGraphicOnly(subWithFiles(2, ['movie.ass']))).toBe(false)
    expect(isGraphicOnly(subWithFiles(3, ['movie.ssa']))).toBe(false)
  })
  it('keeps mixed packs that contain at least one text file', () => {
    expect(isGraphicOnly(subWithFiles(4, ['movie.sup', 'movie.chs.srt']))).toBe(false)
  })
  it('rejects PGS-only (.sup) packs', () => {
    expect(isGraphicOnly(subWithFiles(5, ['movie.sup']))).toBe(true)
  })
  it('rejects VobSub .idx+.sub pairs', () => {
    expect(isGraphicOnly(subWithFiles(6, ['movie.idx', 'movie.sub']))).toBe(true)
  })
  it('does NOT reject a lone .sub (may be MicroDVD text)', () => {
    expect(isGraphicOnly(subWithFiles(7, ['movie.sub']))).toBe(false)
  })
  it('does NOT reject on subtype=None with empty filelist (often effect ass)', () => {
    expect(isGraphicOnly(subWithFiles(8, [], 'None'))).toBe(false)
    expect(isGraphicOnly(subWithFiles(9, [], null))).toBe(false)
  })
  it('rejects empty filelist only when subtype is explicitly graphic', () => {
    expect(isGraphicOnly(subWithFiles(10, [], 'PGS'))).toBe(true)
    expect(isGraphicOnly(subWithFiles(11, [], 'VobSub'))).toBe(true)
  })
})

describe('filterGraphicOnly', () => {
  it('removes graphic-only candidates and preserves order', () => {
    const cands = [
      subWithFiles(1, ['a.chs.srt']),
      subWithFiles(2, ['b.sup']),
      subWithFiles(3, ['c.ass']),
    ]
    const out = filterGraphicOnly(cands)
    expect(out.map(c => c.id)).toEqual([1, 3])
  })
})
