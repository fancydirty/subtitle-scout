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
  readyState = 1 // OPEN 默认；致命关闭时测试置 2(CLOSED)

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  /** 模拟致命关闭（非 2xx 响应，如服务端重启 502/会话失效 401）：readyState→CLOSED + onerror。 */
  fatalClose(): void {
    this.readyState = 2
    this.onerror?.({} as Event)
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

  // R2D-13（R2 复审）：realign 字幕先行阶段逐集起 `job-${jobId}-${absoluteEpisode}` runKey——
  // WorkerCard 订阅的仍是 `job-${jobId}`（不知道、也不该知道子集号），分发谓词因此要接受
  // "精确匹配或以 key+'-' 为前缀"两种情况，否则 realign WorkerCard 的 SSE 直播永远空转。
  it('runKey 是 job-${jobId}-${子集号} 时也分发给 job-${jobId} 的订阅者（realign 逐集直播）', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const received: TraceEvent[] = []
    subscribeTrace('job-42', (e) => received.push(e))

    FakeEventSource.instances[0].emit(ev('job-42-13', 0))
    FakeEventSource.instances[0].emit(ev('job-42-14', 0))

    expect(received.map((e) => e.runKey)).toEqual(['job-42-13', 'job-42-14'])
  })

  it('前缀匹配不误吞数字延伸的不相关 job（job-420 不该命中 job-42 的订阅者）', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const received: TraceEvent[] = []
    subscribeTrace('job-42', (e) => received.push(e))

    FakeEventSource.instances[0].emit(ev('job-420', 0))
    FakeEventSource.instances[0].emit(ev('job-420-1', 0))

    expect(received).toHaveLength(0)
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

  it('致命关闭（readyState=CLOSED，服务端重启/会话失效）后退避重连，新连接事件仍达订阅者（审计 #3）', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.useFakeTimers()
    try {
      const received: TraceEvent[] = []
      subscribeTrace('job-1', (e) => received.push(e))
      const inst1 = FakeEventSource.instances[0]
      inst1.open()
      inst1.fatalClose() // 浏览器不会自动重连——旧代码单例 es 常驻非 null，直播永久卡死
      vi.advanceTimersByTime(5000)
      expect(FakeEventSource.instances).toHaveLength(2) // 主动退避重连出一条新连接
      const inst2 = FakeEventSource.instances[1]
      inst2.open()
      inst2.emit(ev('job-1', 0))
      expect(received).toHaveLength(1) // 直播恢复
    } finally {
      vi.useRealTimers()
    }
  })

  it('致命关闭后的重连成功（第二条连接 onopen）通知 onTraceReconnect（补拉 workers 弥补断线窗口）', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.useFakeTimers()
    try {
      const reconnectFn = vi.fn()
      onTraceReconnect(reconnectFn)
      subscribeTrace('job-1', () => {})
      const inst1 = FakeEventSource.instances[0]
      inst1.open() // 首次
      inst1.fatalClose()
      vi.advanceTimersByTime(5000)
      FakeEventSource.instances[1].open() // 重连成功
      expect(reconnectFn).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('浏览器正在自行重连（readyState=CONNECTING）时不插手，不新建连接', () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.useFakeTimers()
    try {
      subscribeTrace('job-1', () => {})
      const inst1 = FakeEventSource.instances[0]
      inst1.open()
      inst1.readyState = 0 // CONNECTING——浏览器原生瞬断重连中
      inst1.onerror?.({} as Event)
      vi.advanceTimersByTime(5000)
      expect(FakeEventSource.instances).toHaveLength(1) // 不干预原生重连
    } finally {
      vi.useRealTimers()
    }
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
