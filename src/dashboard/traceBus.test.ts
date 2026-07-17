import { describe, it, expect } from 'vitest'
import { traceBus, makeRunTracer, type TraceEvent } from './traceBus.js'

// 每个用例用独立 runKey（例如 crypto.randomUUID 前缀）避免跨用例串扰——traceBus 是进程级单例，
// 测试跑在同一进程内，共享同一份 module-level Map。
function freshKey(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2)}`
}

function ev(runKey: string, seq: number, overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    runKey, seq, tool: 'search_source', argsSummary: '{"q":"x"}', resultSummary: '{"ok":true}',
    tookMs: 12, at: 1000 + seq,
    ...overrides,
  }
}

describe('traceBus', () => {
  it('publish/subscribe：订阅者收到完整 TraceEvent', () => {
    const runKey = freshKey('pubsub')
    const received: TraceEvent[] = []
    const unsubscribe = traceBus.subscribe((e) => received.push(e))
    try {
      const event = ev(runKey, 0)
      traceBus.publish(event)
      expect(received).toEqual([event])
    } finally {
      unsubscribe()
    }
  })

  it('退订后不再收到', () => {
    const runKey = freshKey('unsub')
    const received: TraceEvent[] = []
    const unsubscribe = traceBus.subscribe((e) => received.push(e))
    unsubscribe()
    traceBus.publish(ev(runKey, 0))
    expect(received).toHaveLength(0)
  })

  it('环形缓冲 cap 512 条/runKey，溢出丢最旧', () => {
    const runKey = freshKey('ring')
    for (let seq = 0; seq < 513; seq++) {
      traceBus.publish(ev(runKey, seq))
    }
    const snap = traceBus.snapshot(runKey)
    expect(snap).toHaveLength(512)
    expect(snap[0].seq).toBe(1)
    expect(snap[snap.length - 1].seq).toBe(512)
  })

  it('snapshot(runKey) 返回全量事件数组并 clear（二次 snapshot 为空）', () => {
    const runKey = freshKey('snap')
    traceBus.publish(ev(runKey, 0))
    traceBus.publish(ev(runKey, 1))
    const first = traceBus.snapshot(runKey)
    expect(first).toHaveLength(2)
    const second = traceBus.snapshot(runKey)
    expect(second).toHaveLength(0)
  })

  it('makeRunTracer 补全 runKey 与自增 seq', () => {
    const runKey = freshKey('tracer')
    const tracer = makeRunTracer(runKey)
    tracer({ tool: 'search_source', argsSummary: '{}', resultSummary: '{}', tookMs: 5, at: 1 })
    tracer({ tool: 'get_candidate', argsSummary: '{}', resultSummary: '{}', tookMs: 7, at: 2 })
    const snap = traceBus.snapshot(runKey)
    expect(snap).toHaveLength(2)
    expect(snap[0]).toMatchObject({ runKey, seq: 0, tool: 'search_source' })
    expect(snap[1]).toMatchObject({ runKey, seq: 1, tool: 'get_candidate' })
  })

  // G5：直播补拉用 peek——非破坏性读尾部 N 条，不能用 snapshot（会清空缓冲）。
  describe('peek（G5：直播补拉非破坏性读）', () => {
    it('返回尾部 limit 条，不清空缓冲（peek 之后 snapshot 仍拿到全量）', () => {
      const runKey = freshKey('peek')
      for (let seq = 0; seq < 5; seq++) traceBus.publish(ev(runKey, seq))

      const peeked = traceBus.peek(runKey, 3)
      expect(peeked.map(e => e.seq)).toEqual([2, 3, 4])

      // peek 不清空——再 peek 一次拿到同样的尾部
      expect(traceBus.peek(runKey, 3).map(e => e.seq)).toEqual([2, 3, 4])

      // snapshot 仍能拿到全量 5 条（peek 与 snapshot 互不干扰）
      const snap = traceBus.snapshot(runKey)
      expect(snap).toHaveLength(5)
      expect(snap.map(e => e.seq)).toEqual([0, 1, 2, 3, 4])
    })

    it('limit 超过缓冲长度时返回全量', () => {
      const runKey = freshKey('peek-over')
      traceBus.publish(ev(runKey, 0))
      traceBus.publish(ev(runKey, 1))
      expect(traceBus.peek(runKey, 20).map(e => e.seq)).toEqual([0, 1])
    })

    it('不存在的 runKey 返回空数组', () => {
      expect(traceBus.peek(freshKey('peek-missing'), 10)).toEqual([])
    })
  })

  // R2D-13（R2 复审）：realign 字幕先行阶段逐集起 runKey（`job-${jobId}-${absoluteEpisode}`），
  // 收官快照必须把同一个 job 下全部子集的缓冲一并收走——否则各集缓冲无上界残留，永远不被
  // snapshot 清空（审计脚本已实证的进程级泄漏）。
  describe('snapshotPrefix（R2D-13：realign 逐集 runKey 收官快照）', () => {
    it('收集并清空所有以 prefix 开头的 runKey 缓冲，合并后按 (at, seq) 升序返回', () => {
      const base = freshKey('snappfx')
      const jobPrefix = `${base}-`
      traceBus.publish(ev(`${jobPrefix}1`, 0, { at: 100 }))
      traceBus.publish(ev(`${jobPrefix}2`, 0, { at: 50 }))
      traceBus.publish(ev(`${jobPrefix}1`, 1, { at: 150 }))

      const snap = traceBus.snapshotPrefix(jobPrefix)
      expect(snap.map((e) => [e.runKey, e.seq])).toEqual([
        [`${jobPrefix}2`, 0], // at:50 最早
        [`${jobPrefix}1`, 0], // at:100
        [`${jobPrefix}1`, 1], // at:150
      ])
    })

    it('二次调用为空（缓冲已清空）', () => {
      const base = freshKey('snappfx-twice')
      const jobPrefix = `${base}-`
      traceBus.publish(ev(`${jobPrefix}1`, 0))
      traceBus.publish(ev(`${jobPrefix}2`, 0))
      expect(traceBus.snapshotPrefix(jobPrefix)).toHaveLength(2)
      expect(traceBus.snapshotPrefix(jobPrefix)).toEqual([])
    })

    it('语义是 startsWith(prefix)——不匹配的 runKey（含恰好等于去掉尾连字符的 job id 本身）不受影响', () => {
      const base = freshKey('snappfx-scope')
      const jobPrefix = `${base}-`
      const bareJobKey = base // 去掉尾连字符——不该被 `${base}-` 前缀命中
      traceBus.publish(ev(bareJobKey, 0))
      traceBus.publish(ev(`${jobPrefix}1`, 0))

      const snap = traceBus.snapshotPrefix(jobPrefix)
      expect(snap).toHaveLength(1)
      expect(snap[0].runKey).toBe(`${jobPrefix}1`)
      // bareJobKey 那条缓冲原封不动
      expect(traceBus.snapshot(bareJobKey)).toHaveLength(1)
    })

    it('不存在任何匹配 runKey 时返回空数组', () => {
      expect(traceBus.snapshotPrefix(`${freshKey('snappfx-missing')}-`)).toEqual([])
    })
  })

  describe('peekPrefix（R2D-13：直播补拉的前缀合并版）', () => {
    it('非破坏性合并读多个 runKey 缓冲尾部 limit 条，按 (at, seq) 排序', () => {
      const base = freshKey('peekpfx')
      const jobPrefix = `${base}-`
      traceBus.publish(ev(`${jobPrefix}1`, 0, { at: 10 }))
      traceBus.publish(ev(`${jobPrefix}2`, 0, { at: 20 }))
      traceBus.publish(ev(`${jobPrefix}1`, 1, { at: 30 }))

      const peeked = traceBus.peekPrefix(jobPrefix, 2)
      expect(peeked.map((e) => [e.runKey, e.seq])).toEqual([
        [`${jobPrefix}2`, 0],
        [`${jobPrefix}1`, 1],
      ])

      // 不清空——snapshotPrefix 之后仍能拿到全量 3 条
      expect(traceBus.snapshotPrefix(jobPrefix)).toHaveLength(3)
    })

    it('limit<=0 返回空数组', () => {
      const jobPrefix = `${freshKey('peekpfx-zero')}-`
      traceBus.publish(ev(`${jobPrefix}1`, 0))
      expect(traceBus.peekPrefix(jobPrefix, 0)).toEqual([])
    })

    it('无匹配 runKey 返回空数组', () => {
      expect(traceBus.peekPrefix(`${freshKey('peekpfx-missing')}-`, 10)).toEqual([])
    })
  })

  it('订阅者抛错不炸 publish 也不影响其他订阅者', () => {
    const runKey = freshKey('throw')
    const receivedByGood: TraceEvent[] = []
    const unsubBad = traceBus.subscribe(() => { throw new Error('boom') })
    const unsubGood = traceBus.subscribe((e) => receivedByGood.push(e))
    try {
      const event = ev(runKey, 0)
      expect(() => traceBus.publish(event)).not.toThrow()
      expect(receivedByGood).toEqual([event])
    } finally {
      unsubBad()
      unsubGood()
    }
  })
})
