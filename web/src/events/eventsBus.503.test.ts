// web/src/events/eventsBus.503.test.ts：**503（没跑 watch）与重连风暴**。
//
// 这条路径在开发机上是**常态**：只跑 dashboard 不跑 watch 时 /api/v2/events 返回 503
// （events 总线只在 cmdWatch 里注入）。如果不区分 503 与"服务端重启了"，退避重连会变成
// 每 3 秒敲一次一个永远不会好的端点，直到用户关标签页——那就是任务书点名的重连风暴。
//
// 断言的形式是**数请求次数**（数 EventSource 实例数 + fetch 探测次数），
// 不是"看看有没有写 unavailable 这个字符串"。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  subscribeEvents, getStatus, subscribeStatus, __resetEventsBusForTests,
} from './eventsBus.js'

class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  closed = false
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; this.readyState = 2 }
  /** 致命关闭（非 2xx）——浏览器把 readyState 打到 CLOSED 并放弃自动重连。 */
  fatal() { this.readyState = 2; this.onerror?.() }
  /** 瞬断——浏览器正在自行重连，readyState 停在 CONNECTING。 */
  transient() { this.readyState = 0; this.onerror?.() }
}

/** 让挂起的 **microtask**（probe 那条 async 链）跑完，但**不推进定时器**。
 *  ⚠️ 不能用 runAllTimersAsync：它会把 3 秒退避那个 timer 也一起执行掉，
 *  于是"退避存在吗"和"退订后还重连吗"两条用例测的东西直接被助手函数抹掉（实测踩到，
 *  两条一开始都红在这里而不是实现上）。advanceTimersByTimeAsync(0) 只清 microtask 队列。 */
const flush = async () => { await vi.advanceTimersByTimeAsync(0) }

let fetchMock: ReturnType<typeof vi.fn>

function mockStatus(status: number) {
  fetchMock = vi.fn(async () => ({
    ok: status < 400, status, body: null, json: async () => ({}),
  }) as unknown as Response)
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeES.instances = []
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES)
})
afterEach(() => {
  __resetEventsBusForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('503（不跑 watch）= 终态，不重连', () => {
  it('致命关闭 + 探测到 503 → status=unavailable，且**不再新建任何连接**', async () => {
    mockStatus(503)
    subscribeEvents('activity', () => {})
    expect(FakeES.instances.length).toBe(1)

    FakeES.instances[0]!.fatal()
    await flush()

    expect(getStatus()).toBe('unavailable')
    // ⭐ 风暴判据：等足够长的时间（远超 3s 退避窗口），连接数必须**仍然是 1**。
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeES.instances.length, '503 之后还在重连 → 重连风暴').toBe(1)
  })

  it('503 之后 60 秒内只探测过一次（探测本身也不许变成轮询）', async () => {
    mockStatus(503)
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.fatal()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock.mock.calls.length).toBe(1)
  })

  it('状态订阅者收到 unavailable（UI 能据此说人话，而不是无限转圈）', async () => {
    mockStatus(503)
    const seen: string[] = []
    subscribeStatus((s) => seen.push(s))
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.fatal()
    await flush()
    expect(seen).toContain('unavailable')
  })
})

describe('非 503 的故障仍然重连（别把"服务器重启"也当终态）', () => {
  it('致命关闭 + 探测到 500 → 退避后重建连接', async () => {
    mockStatus(500)
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.fatal()
    await flush()
    expect(getStatus()).toBe('retrying')
    await vi.advanceTimersByTimeAsync(3000)
    expect(FakeES.instances.length, '非 503 故障应当重连').toBe(2)
  })

  it('探测本身失败（后端整个没起）→ 按可重试处理，不误判成 unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.fatal()
    await flush()
    expect(getStatus()).not.toBe('unavailable')
    await vi.advanceTimersByTimeAsync(3000)
    expect(FakeES.instances.length).toBe(2)
  })

  it('重连有退避——不是立即重连（3s 之前不许有新连接）', async () => {
    mockStatus(500)
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.fatal()
    await flush()
    await vi.advanceTimersByTimeAsync(2000)
    expect(FakeES.instances.length, '没有退避 = 忙等风暴').toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(FakeES.instances.length).toBe(2)
  })

  it('订阅者全退订后不再重连（关掉页面还在后台敲端点）', async () => {
    mockStatus(500)
    const off = subscribeEvents('activity', () => {})
    FakeES.instances[0]!.fatal()
    await flush()
    off()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeES.instances.length).toBe(1)
  })
})

describe('Last-Event-ID：瞬断绝不插手（插手 = 静默丢事件）', () => {
  // 这是本文件最要紧的一条，也是任务书点名的变异靶子。
  //
  // 后端只认**请求头** last-event-id，而浏览器原生 EventSource 不能带自定义头——
  // 所以那个头**只有浏览器自己在原生重连时会带**。readyState=CONNECTING 时如果我们
  // close() 再 new 一个，就把浏览器攒着的 Last-Event-ID 连同实例一起扔了，
  // 重建连接不带头 → 后端 replay(0) → 断线期间的 found 事件（通知页数据源）永久丢失。
  //
  // 这是**静默故障**：UI 上什么都不报，只是少了几条通知。所以必须有测试钉住。
  it('readyState=CONNECTING（瞬断）→ 不 close、不新建，把重连留给浏览器', async () => {
    mockStatus(200)
    subscribeEvents('activity', () => {})
    const first = FakeES.instances[0]!

    first.transient()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(first.closed, '瞬断时关掉了连接 → 浏览器攒的 Last-Event-ID 被扔掉').toBe(false)
    expect(FakeES.instances.length, '瞬断时新建了连接 → 新连接不带 Last-Event-ID，断线期间的事件永久丢失').toBe(1)
  })

  it('瞬断时也不做 503 探测（那次探测毫无意义，还多打一个请求）', async () => {
    mockStatus(200)
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.transient()
    await flush()
    expect(fetchMock.mock.calls.length).toBe(0)
  })
})
