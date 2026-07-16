// web/src/workflow/traceStream.test.ts：单例 EventSource 管理——jsdom 不自带 EventSource
// 实现，注入一个精简假类到 globalThis.EventSource 驱动 onopen/onmessage（DESIGN 任务规格建议
// 的"EventSource 假实现注入"测试手法）。每个用例结束都调用 __resetTraceStreamForTests 清空
// 模块级单例状态，避免用例之间互相串扰（单例本来就是全局唯一，不清理下一条用例会看到上一条
// 遗留的假连接）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { subscribeTrace, onTraceReconnect, __resetTraceStreamForTests } from './traceStream.js'
import type { TraceEvent } from '../api/types.js'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  close(): void {
    this.closed = true
  }

  emit(e: TraceEvent): void {
    this.onmessage?.({ data: JSON.stringify(e) } as MessageEvent)
  }

  open(): void {
    this.onopen?.({} as Event)
  }
}

function ev(runKey: string, seq: number): TraceEvent {
  return { runKey, seq, tool: 'search_source', argsSummary: '"x"', resultSummary: 'ok', tookMs: 100, at: 1 }
}

afterEach(() => {
  __resetTraceStreamForTests()
  FakeEventSource.instances = []
  vi.unstubAllGlobals()
})

describe('traceStream：单例 EventSource + runKey 分发', () => {
  it('订阅时才建连；同一个 runKey 收到事件分发给所有订阅者', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const received1: TraceEvent[] = []
    const received2: TraceEvent[] = []
    subscribeTrace('job-1', (e) => received1.push(e))
    subscribeTrace('job-1', (e) => received2.push(e))

    expect(FakeEventSource.instances).toHaveLength(1) // 单例——两次订阅只开一条连接
    FakeEventSource.instances[0].emit(ev('job-1', 0))

    expect(received1).toHaveLength(1)
    expect(received2).toHaveLength(1)
    expect(received1[0]).toEqual(ev('job-1', 0))
  })

  it('不同 runKey 的事件只分发给对应订阅者', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const receivedA: TraceEvent[] = []
    const receivedB: TraceEvent[] = []
    subscribeTrace('job-a', (e) => receivedA.push(e))
    subscribeTrace('job-b', (e) => receivedB.push(e))

    FakeEventSource.instances[0].emit(ev('job-a', 0))
    expect(receivedA).toHaveLength(1)
    expect(receivedB).toHaveLength(0)
  })

  it('引用计数归零才关闭底层连接；页面还有别的订阅者时不关闭', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const unsubA = subscribeTrace('job-a', () => {})
    const unsubB = subscribeTrace('job-b', () => {})
    const instance = FakeEventSource.instances[0]

    unsubA()
    expect(instance.closed).toBe(false) // job-b 还订阅着

    unsubB()
    expect(instance.closed).toBe(true) // 引用计数归零，连接关闭
  })

  it('重新订阅（连接已关闭后）会开一条新连接', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const unsub = subscribeTrace('job-1', () => {})
    unsub()
    expect(FakeEventSource.instances[0].closed).toBe(true)

    subscribeTrace('job-1', () => {})
    expect(FakeEventSource.instances).toHaveLength(2)
    expect(FakeEventSource.instances[1].closed).toBe(false)
  })

  it('首次 onopen 不算重连，不通知 onTraceReconnect', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const reconnectFn = vi.fn()
    onTraceReconnect(reconnectFn)
    subscribeTrace('job-1', () => {})
    FakeEventSource.instances[0].open()
    expect(reconnectFn).not.toHaveBeenCalled()
  })

  it('第二次及以后的 onopen 视为重连，通知 onTraceReconnect 订阅者', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const reconnectFn = vi.fn()
    onTraceReconnect(reconnectFn)
    subscribeTrace('job-1', () => {})
    const instance = FakeEventSource.instances[0]
    instance.open() // 首次——不算重连
    instance.open() // 第二次——浏览器原生自动重连成功
    expect(reconnectFn).toHaveBeenCalledTimes(1)
  })

  it('畸形 data 行静默丢弃，不炸订阅回调', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const received: TraceEvent[] = []
    subscribeTrace('job-1', (e) => received.push(e))
    const instance = FakeEventSource.instances[0]
    expect(() => instance.onmessage?.({ data: 'not json' } as MessageEvent)).not.toThrow()
    expect(received).toHaveLength(0)
  })

  it('退订函数是幂等的，多次调用不炸', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const unsub = subscribeTrace('job-1', () => {})
    unsub()
    expect(() => unsub()).not.toThrow()
  })
})
