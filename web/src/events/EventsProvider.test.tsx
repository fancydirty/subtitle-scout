// web/src/events/EventsProvider.test.tsx：四层 Context 的**运行时**隔离证明。
//
// ── 为什么是渲染计数器而不是源码断言（Task ⑤ 的教训）─────────────────────────
// Task ⑤ 写过一个"源码级接线断言"文件，一行行尾注释就能让 4 条全部假绿，最后整个删掉，
// 改用运行时探针。这里从一开始就走探针路线：给每类消费者包一个真实的渲染计数组件，
// 发事件，数它们各自渲染了几次。
//
// "progress 不触发全树重渲染"这句话的**可证伪形式**是：
//   发 N 条 progress 之后，progress 消费者的渲染次数涨了，
//   而 activity/found/health 消费者的渲染次数 **一次都没涨**。
// 变异验证（报告里有真实输出）：把四层合成一层 Context → 后半句立刻红。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'
import {
  EventsProvider, useActivityEvent, useFoundEvent, useHealthEvent, useProgressEvent,
  useEventsStatus, useRenderCount,
} from './EventsProvider.js'
import { __resetEventsBusForTests, getLastSeenId, EVENT_TYPES } from './eventsBus.js'
import type { ScoutEvent } from './types.js'

/** 假 EventSource——同仓 traceStream 测试的既有手法（jsdom 不自带 EventSource）。
 *  按名分发：后端每帧都发 `event: <type>`，所以必须支持 addEventListener(type)。 */
class FakeES {
  static instances: FakeES[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  closed = false
  private listeners = new Map<string, ((e: { data: string }) => void)[]>()
  constructor(public url: string) { FakeES.instances.push(this) }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() { this.closed = true; this.readyState = 2 }
  /** 驱动一帧：模拟服务端 `event: <type>\ndata: <json>`。 */
  emit(e: ScoutEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) })
  }
  open() { this.readyState = 1; this.onopen?.() }
  fail(readyState: number) { this.readyState = readyState; this.onerror?.() }
}

let seq = 0
const ev = (over: Partial<ScoutEvent> & Pick<ScoutEvent, 'type'>): ScoutEvent => ({
  id: ++seq, at: Date.now(), message: 'm', ...over,
})

/** 四类消费者各自的渲染计数——**探针本体**。
 *  每个组件只订自己那一类（这正是生产里各页面的用法：通知页只订 found）。 */
const counts = { activity: 0, found: 0, health: 0, progress: 0 }
function ActivityConsumer() {
  const e = useActivityEvent()
  counts.activity = useRenderCount()
  return <div data-testid="activity">{e?.message ?? '-'}</div>
}
function FoundConsumer() {
  const e = useFoundEvent()
  counts.found = useRenderCount()
  return <div data-testid="found">{e?.message ?? '-'}</div>
}
function HealthConsumer() {
  const e = useHealthEvent()
  counts.health = useRenderCount()
  return <div data-testid="health">{e?.message ?? '-'}</div>
}
function ProgressConsumer() {
  const e = useProgressEvent()
  counts.progress = useRenderCount()
  return <div data-testid="progress">{e?.message ?? '-'}</div>
}

function renderAll() {
  return render(
    <EventsProvider>
      <ActivityConsumer />
      <FoundConsumer />
      <HealthConsumer />
      <ProgressConsumer />
    </EventsProvider>,
  )
}

const bus = () => FakeES.instances[0]!

beforeEach(() => {
  FakeES.instances = []
  seq = 0
  counts.activity = counts.found = counts.health = counts.progress = 0
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, body: null, json: async () => ({}) }) as unknown as Response))
})
afterEach(() => { cleanup(); __resetEventsBusForTests(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('四层 Context：progress 不触发全树重渲染（本 task 的核心断言）', () => {
  it('连发 5 条 progress → 只有 progress 消费者重渲染，另外三个一次都没涨', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))

    // 基线：四个消费者都已首渲染。
    const before = { ...counts }
    expect(before.progress).toBeGreaterThan(0)

    // 五条 progress（生产里这是每秒一条的那一路）
    for (let i = 0; i < 5; i++) {
      act(() => { bus().emit(ev({ type: 'progress', workbench: 'subtitle', message: `p${i}`, data: { done: i, total: 5 } })) })
    }

    // progress 消费者确实收到了（不是"什么都没发生"导致的全体不变——那种假绿必须排除）
    expect(screen.getByTestId('progress').textContent).toBe('p4')
    expect(counts.progress).toBeGreaterThan(before.progress)

    // ⭐ 核心：另外三层**一次都没重渲染**
    expect(counts.activity, 'activity 消费者被 progress 带着重渲染了 → 四层隔离失效').toBe(before.activity)
    expect(counts.found, 'found 消费者被 progress 带着重渲染了 → 四层隔离失效').toBe(before.found)
    expect(counts.health, 'health 消费者被 progress 带着重渲染了 → 四层隔离失效').toBe(before.health)
  })

  it('反向同理：activity 事件不惊动 found/health/progress 三层', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    const before = { ...counts }

    act(() => { bus().emit(ev({ type: 'activity', workbench: 'subtitle', message: 'a1' })) })

    expect(screen.getByTestId('activity').textContent).toBe('a1')
    expect(counts.activity).toBeGreaterThan(before.activity)
    expect(counts.found).toBe(before.found)
    expect(counts.health).toBe(before.health)
    expect(counts.progress).toBe(before.progress)
  })

  it('每一类都只喂到自己那一层（四类逐个验，防"分发写死成某一类"）', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    for (const type of EVENT_TYPES) {
      act(() => { bus().emit(ev({ type, message: `only-${type}` })) })
      expect(screen.getByTestId(type).textContent).toBe(`only-${type}`)
      // 其余三个不该变成这条消息
      for (const other of EVENT_TYPES.filter((t) => t !== type)) {
        expect(screen.getByTestId(other).textContent).not.toBe(`only-${type}`)
      }
    }
  })
})

describe('连接与订阅', () => {
  it('整个 app 只开一条 EventSource（R-F10 约束 3：HTTP/1.1 每源 6 连接上限）', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    expect(bus().url).toContain('/api/v2/events')
  })

  it('四类都按名注册监听（写成 onmessage 会一条都收不到——后端每帧都带 event:）', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    for (const type of EVENT_TYPES) {
      act(() => { bus().emit(ev({ type, message: `x-${type}` })) })
      expect(screen.getByTestId(type).textContent).toBe(`x-${type}`)
    }
  })

  it('全部消费者卸载 → 底层连接关闭（长跑标签页上的连接泄漏）', async () => {
    const { unmount } = renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    const es = bus()
    unmount()
    await waitFor(() => expect(es.closed).toBe(true))
  })

  it('workbench 缺席（巡检级事件）照常送达，**不被兜底成 identify**', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    act(() => { bus().emit(ev({ type: 'activity', message: '巡检完成' })) })
    expect(screen.getByTestId('activity').textContent).toBe('巡检完成')
  })
})

describe('Last-Event-ID / 去重', () => {
  it('跟踪最后一条事件 id——重连续传的唯一依据，写死成 0 这条会红', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    expect(getLastSeenId()).toBe(0)
    act(() => { bus().emit(ev({ type: 'found', message: 'f1' })) })   // id=1
    expect(getLastSeenId()).toBe(1)
    act(() => { bus().emit(ev({ type: 'progress', message: 'p' })) }) // id=2
    expect(getLastSeenId()).toBe(2)
  })

  it('重连补发的重复事件被按 id 去重（浏览器原生重连必然带来重复）', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    const e1 = ev({ type: 'found', message: 'f1' })
    act(() => { bus().emit(e1) })
    const afterFirst = counts.found
    // 服务端 replay 把同一条又送一遍（id 相同）
    act(() => { bus().emit(e1) })
    expect(counts.found, '重复事件被二次派发 → 通知页会出现重复条目').toBe(afterFirst)
  })

  it('id 更小的陈旧事件也不派发（replay 会带来一批 id ≤ lastSeen 的）', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    act(() => { bus().emit({ id: 10, at: 0, type: 'found', message: 'new' }) })
    const after = counts.found
    act(() => { bus().emit({ id: 3, at: 0, type: 'found', message: 'stale' }) })
    expect(screen.getByTestId('found').textContent).toBe('new')
    expect(counts.found).toBe(after)
  })

  it('畸形 data 行静默丢弃，不打断整条订阅', async () => {
    renderAll()
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    // 直接向内部监听器投一段非 JSON（FakeES.emit 只会发合法 JSON，绕不过去）
    act(() => {
      const listeners = (bus() as unknown as {
        listeners: Map<string, ((e: { data: string }) => void)[]>
      }).listeners
      for (const fn of listeners.get('found') ?? []) fn({ data: '{not json' })
    })
    // 后续正常事件仍然送达 → 说明那条坏帧没把订阅打断
    act(() => { bus().emit(ev({ type: 'found', message: 'still-alive' })) })
    expect(screen.getByTestId('found').textContent).toBe('still-alive')
  })
})

describe('连接状态层', () => {
  function StatusProbe() {
    const s = useEventsStatus()
    return <div data-testid="status">{s}</div>
  }

  it('onopen → status 变 open', async () => {
    render(<EventsProvider><ActivityConsumer /><StatusProbe /></EventsProvider>)
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    act(() => { bus().open() })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('open'))
  })

  it('状态变化不惊动事件层消费者（状态混进事件层会让它们白重渲染）', async () => {
    render(<EventsProvider><ActivityConsumer /><StatusProbe /></EventsProvider>)
    await waitFor(() => expect(FakeES.instances.length).toBe(1))
    const before = counts.activity
    act(() => { bus().open() })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('open'))
    expect(counts.activity).toBe(before)
  })
})
