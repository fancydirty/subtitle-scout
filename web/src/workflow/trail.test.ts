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

  // R2D-13（R2 复审）：realign WorkerCard 的 baseTrail/SSE 事件混合了多个子集 runKey
  // （`job-${jobId}-${absoluteEpisode}`），各子集各自的 seq 从 0 起算——纯按 seq 去重会把不同
  // 子集的第 0 条事件互相当同一条覆盖掉，丢事件。去重键必须带上 runKey。
  describe('跨 runKey 的 seq 重复（realign 逐集事件混流）', () => {
    function evAt(runKey: string, seq: number, at: number, tool = 't'): TraceEvent {
      return { runKey, seq, tool, argsSummary: '', resultSummary: '', tookMs: 1, at }
    }

    it('不同 runKey 的相同 seq 都保留，不互相覆盖', () => {
      const merged = mergeTrail(
        [evAt('job-42-1', 0, 100, 'a')],
        [evAt('job-42-2', 0, 50, 'b')],
      )
      expect(merged).toHaveLength(2)
      expect(merged.map((e) => e.runKey)).toEqual(['job-42-2', 'job-42-1']) // 按 at 升序：50 在前
    })

    it('同一 runKey 的相同 seq 仍然去重（后来者为准）', () => {
      const merged = mergeTrail(
        [evAt('job-42-1', 0, 100, 'old')],
        [evAt('job-42-1', 0, 100, 'new')],
      )
      expect(merged).toHaveLength(1)
      expect(merged[0].tool).toBe('new')
    })

    it('排序主键是 at，seq 只是同 at 时的次序 tie-break', () => {
      const merged = mergeTrail(
        [evAt('job-42-1', 5, 300), evAt('job-42-2', 1, 100)],
        [evAt('job-42-3', 2, 200)],
      )
      expect(merged.map((e) => e.runKey)).toEqual(['job-42-2', 'job-42-3', 'job-42-1'])
    })
  })
})
