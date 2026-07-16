import { describe, it, expect } from 'vitest'
import { mergeTrail } from './trail.js'
import type { TraceEvent } from '../api/types.js'

function ev(seq: number, tool = 't'): TraceEvent {
  return { runKey: 'job-1', seq, tool, argsSummary: '', resultSummary: '', tookMs: 1, at: seq }
}

describe('mergeTrail', () => {
  it('按 seq 去重合并，升序排序', () => {
    const merged = mergeTrail([ev(0), ev(1)], [ev(1), ev(2)])
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('同 seq 以后来者为准', () => {
    const merged = mergeTrail([ev(0, 'old')], [{ ...ev(0, 'new') }])
    expect(merged).toHaveLength(1)
    expect(merged[0].tool).toBe('new')
  })

  it('乱序输入也能正确排序', () => {
    const merged = mergeTrail([ev(3), ev(1)], [ev(2), ev(0)])
    expect(merged.map((e) => e.seq)).toEqual([0, 1, 2, 3])
  })

  it('超过 100 条只保留尾部 100 条', () => {
    const existing = Array.from({ length: 90 }, (_, i) => ev(i))
    const incoming = Array.from({ length: 20 }, (_, i) => ev(90 + i))
    const merged = mergeTrail(existing, incoming)
    expect(merged).toHaveLength(100)
    expect(merged[0].seq).toBe(10) // 前 10 条（seq 0..9）被裁掉
    expect(merged[merged.length - 1].seq).toBe(109)
  })

  it('空输入两侧都不炸', () => {
    expect(mergeTrail([], [])).toEqual([])
    expect(mergeTrail([ev(0)], [])).toEqual([ev(0)])
    expect(mergeTrail([], [ev(0)])).toEqual([ev(0)])
  })
})
