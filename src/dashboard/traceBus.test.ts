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
