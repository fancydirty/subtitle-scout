import { describe, it, expect } from 'vitest'
import { batchIntoScenes } from './sceneBatcher.js'
import type { SrtCue } from './qualityGate.js'

function cue(index: number, startMs: number, endMs: number, text = 'x'): SrtCue {
  const fmt = (ms: number) => {
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
    const t = String(ms % 1000).padStart(3, '0')
    return `${h}:${m}:${s},${t}`
  }
  return { index: String(index), timing: `${fmt(startMs)} --> ${fmt(endMs)}`, text: [text] }
}

describe('batchIntoScenes', () => {
  it('连续(间隔≤阈值)的 cue 归为一批', () => {
    const cues = [cue(1, 0, 1000), cue(2, 1200, 2000), cue(3, 2100, 3000)]
    const batches = batchIntoScenes(cues, { gapSec: 2, maxBatch: 40 })
    expect(batches).toHaveLength(1)
    expect(batches[0].map((c) => c.index)).toEqual(['1', '2', '3'])
  })

  it('超过间隔阈值 → 切成新场景批', () => {
    const cues = [cue(1, 0, 1000), cue(2, 1500, 2000), cue(3, 5000, 6000), cue(4, 6100, 7000)]
    // 2→3 间隔 3s > 2s 阈值 → 在此切分
    const batches = batchIntoScenes(cues, { gapSec: 2, maxBatch: 40 })
    expect(batches).toHaveLength(2)
    expect(batches[0].map((c) => c.index)).toEqual(['1', '2'])
    expect(batches[1].map((c) => c.index)).toEqual(['3', '4'])
  })

  it('批达上限 → 即使无间隔也切分(防长上下文迷失中段)', () => {
    const cues = Array.from({ length: 10 }, (_, i) => cue(i + 1, i * 100, i * 100 + 50)) // 全部紧挨
    const batches = batchIntoScenes(cues, { gapSec: 2, maxBatch: 4 })
    expect(batches.map((b) => b.length)).toEqual([4, 4, 2])
    // 全部 cue 顺序无丢无重
    expect(batches.flat().map((c) => c.index)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
  })

  it('空输入 → 空批列表', () => {
    expect(batchIntoScenes([], {})).toEqual([])
  })

  it('默认参数(gap 2s / maxBatch 40)可用', () => {
    const cues = [cue(1, 0, 1000), cue(2, 1100, 2000)]
    expect(batchIntoScenes(cues)).toHaveLength(1)
  })

  it('时轴不可解析的 cue 不会中断分批(降级为不因间隔切,只受 maxBatch 约束)', () => {
    const bad: SrtCue = { index: '2', timing: 'garbage', text: ['x'] }
    const cues = [cue(1, 0, 1000), bad, cue(3, 1200, 2000)]
    const batches = batchIntoScenes(cues, { gapSec: 2, maxBatch: 40 })
    expect(batches.flat().map((c) => c.index)).toEqual(['1', '2', '3'])
  })
})
