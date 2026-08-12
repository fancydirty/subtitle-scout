// web/src/events/sseWireContract.e2e.test.ts —— **端到端整链**：那三道缝的唯一守卫。
//
// ── 这个文件存在的理由（上上个 subagent 报告过"中间那道缝没人守"）──────────────
// 这条链有四段，每段各有各的测试：
//   ① 前端拼 URL      → eventsBus.resume.test.ts（读构造器收到的 URL 字符串）
//   ② 后端读 query    → src/dashboard/eventStream.test.ts（真起 HTTP 服务）
//   ③ replay 起点     → 同上
//   ④ 前端去重 / 重置 → EventsProvider.test.tsx（渲染计数探针）
// 四段全绿，**中间三道缝仍然可以全断**：①发的形状与②认的形状可以对不上，
// ③算出的起点与④的去重门可以各自"正确"却互相抵消。四段测试各自都只证明"我这段自洽"。
//
// 缝之所以没人守，直接原因是**没有任何一段代码是两侧共有的**——后端的 frame() 原先是
// server.ts 里的闭包，前端的解析是 eventsBus.ts 里的一段 if。想写端到端用例就只能在测试里
// 把两边各手抄一遍，而手抄的那份**永远只会证明"我抄对了"**。
//
// src/core/sseWire.ts 把线格式与断点解析提成零依赖纯函数之后，本文件可以直接 import 它：
// 于是"后端怎么发"用的是 **helloFrame/eventFrame 的真身**，"后端怎么认断点"用的是
// **parseResumeToken/resolveReplayFrom 的真身**，"事件怎么编号"用的是 **ScoutEventBus 的
// 真身**，"前端怎么收"用的是 **eventsBus.ts 的真身**。整条链上没有一行是为测试手抄的。
//
// ⚠️ 唯一由本文件实现的是**浏览器那一段**（SSE 文本 → addEventListener 回调）——它本来就
// 不属于任何一侧，是 W3C 的。实现见 parseSseWire，逐字按 HTML 规范
// （`:` 开头的行忽略、`event:`/`data:`/`id:` 三个字段、空行派发）。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  subscribeEvents, getLastSeenId, getBootId, __resetEventsBusForTests,
} from './eventsBus.js'
import type { ScoutEvent } from './types.js'
// ⭐ 后端真身。跨工程 import 只在**测试**里做（生产代码仍各自独立，见 types.ts 的论证）。
import {
  helloFrame, eventFrame, parseResumeToken, resolveReplayFrom,
} from '../../../src/core/sseWire.js'
import { ScoutEventBus } from '../../../src/core/scoutEvents.js'

// ── 浏览器那一段：SSE 线格式解析（W3C，两侧都不拥有它）──────────────────────
interface SseFrame { event: string; data: string; id: string | null }

/** 按 HTML 规范逐行解析 SSE 文本。`:` 开头的行（注释帧/心跳）被忽略——这正是
 *  "保活不占事件通道"在客户端侧的体现，也是 bootId **不能**走注释帧的原因。 */
function parseSseWire(text: string): SseFrame[] {
  const out: SseFrame[] = []
  let event = 'message'
  let data: string[] = []
  let id: string | null = null
  for (const line of text.split('\n')) {
    if (line === '') {
      if (data.length > 0) out.push({ event, data: data.join('\n'), id })
      event = 'message'; data = []
      continue
    }
    if (line.startsWith(':')) continue           // 注释帧：客户端**永远看不到**
    const cut = line.indexOf(':')
    const name = cut < 0 ? line : line.slice(0, cut)
    let value = cut < 0 ? '' : line.slice(cut + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'event') event = value
    else if (name === 'data') data.push(value)
    else if (name === 'id') id = value           // 浏览器据此维护 Last-Event-ID
  }
  return out
}

/**
 * 假 EventSource——但**不是**手抄的假后端：它把 URL 交给真实的后端逻辑，
 * 把真实后端吐出的线格式文本交给真实的前端。它只负责当"浏览器 + 网线"。
 *
 * 模拟的浏览器行为有两条，都是 W3C 规定而前端代码碰不到的：
 *  · 记住最后一条 `id:` 行，原生重连时放进 `Last-Event-ID` 请求头；
 *  · 按 `event:` 名把 `data:` 交给对应的 addEventListener 回调（不交 `id:`）。
 */
class WiredES {
  static instances: WiredES[] = []
  /** 当前"服务端进程"。重启 = 换一条总线（nextId 从 1 重数，bootId 不同）——
   *  这正是 ScoutEventBus 刻意不做成单例的用处。 */
  static bus = new ScoutEventBus({ bootId: 'boot-A' })
  /** 浏览器攒的 Last-Event-ID（**前端读不到**，只有原生重连才会带上）。 */
  static browserLastEventId: string | null = null
  /** 下一次连接是否走"浏览器原生重连"（带头）。手工重建时为 false。 */
  static nativeReconnect = false

  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 0
  closed = false
  /** 本条连接建立时，服务端算出的 replay 起点——断言用（那是缝③的落点）。 */
  readonly replayFrom: number
  /** 本条连接上服务端认到的断点原文——断言用（那是缝②的落点）。 */
  readonly resumeRaw: string | null
  private listeners = new Map<string, ((e: { data: string }) => void)[]>()

  constructor(public url: string) {
    WiredES.instances.push(this)
    const bus = WiredES.bus
    const bootId = bus.bootId()

    // ── 缝②：后端读断点。**头优先于 query**，与 server.ts 同序。 ──────────────
    // 头只有浏览器原生重连才有；手工重建走 query（EventSource 不能带自定义头）。
    const queryToken = new URL(url, 'http://x').searchParams.get('lastEventId')
    const raw = WiredES.nativeReconnect ? WiredES.browserLastEventId : queryToken
    this.resumeRaw = raw

    // ── 缝③：replay 起点。用的是**后端真身** resolveReplayFrom。 ─────────────
    const from = resolveReplayFrom(parseResumeToken(raw), bootId)
    this.replayFrom = from

    // 服务端把握手 + replay 写到线上——**后端真身** helloFrame / eventFrame。
    let wire = helloFrame(bootId)
    for (const e of bus.replay(from)) wire += eventFrame(bootId, e)
    // 构造器里不能立刻投递（订阅者还没注册）——存着，由 flushOpen 冲出去。
    this.pending = wire
  }

  private pending: string

  addEventListener(type: string, fn: (e: { data: string }) => void) {
    const arr = this.listeners.get(type) ?? []
    arr.push(fn)
    this.listeners.set(type, arr)
  }
  removeEventListener() {}
  close() { this.closed = true; this.readyState = 2 }

  /** 把线上已有的字节交付给前端（= 连接建立后的第一次 flush）。 */
  flushOpen() {
    this.deliver(this.pending)
    this.pending = ''
    this.readyState = 1
    this.onopen?.()
  }

  /** 服务端**实时**发一条事件（走真实总线编号 + 真实帧格式）。 */
  publish(input: { type: ScoutEvent['type']; message: string }) {
    const before = WiredES.bus.replay(0).length
    WiredES.bus.publish(input)
    const all = WiredES.bus.replay(0)
    // 被节流折叠的 progress 不进缓冲——那时什么都不发（与生产一致）。
    if (all.length === before) return
    const e = all[all.length - 1]!
    this.deliver(eventFrame(WiredES.bus.bootId(), e))
  }

  /** 线上字节 → 浏览器解析 → 按名派发。`id:` 只进浏览器内部状态，**不给前端**。 */
  private deliver(wire: string) {
    for (const f of parseSseWire(wire)) {
      if (f.id !== null) WiredES.browserLastEventId = f.id   // 浏览器记着，前端读不到
      for (const fn of this.listeners.get(f.event) ?? []) fn({ data: f.data })
    }
  }

  /** 致命关闭（非 2xx / 进程死了）——浏览器放弃，前端接手**手工重建**（不带头）。 */
  fatal() { this.readyState = 2; this.onerror?.() }
}

/** 走完一次「致命关闭 → 探测非 503 → 退避 3s → 手工重建 → 冲刷」。 */
async function manualReconnect() {
  WiredES.nativeReconnect = false
  WiredES.instances[WiredES.instances.length - 1]!.fatal()
  await vi.advanceTimersByTimeAsync(0)      // probe 的 async 链
  await vi.advanceTimersByTimeAsync(3000)   // 退避
  const fresh = WiredES.instances[WiredES.instances.length - 1]!
  fresh.flushOpen()
  return fresh
}

/** 模拟后端进程重启：换一条总线（新 bootId、nextId 从 1 重数）。 */
function restartBackend(bootId: string) {
  WiredES.bus = new ScoutEventBus({ bootId })
}

const latest = () => WiredES.instances[WiredES.instances.length - 1]!

beforeEach(() => {
  vi.useFakeTimers()
  WiredES.instances = []
  WiredES.bus = new ScoutEventBus({ bootId: 'boot-A' })
  WiredES.browserLastEventId = null
  WiredES.nativeReconnect = false
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', WiredES)
  // probe 返回非 503 → 走退避重连（本文件要测的那条路）。
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false, status: 500, body: null, json: async () => ({}),
  }) as unknown as Response))
})
afterEach(() => {
  __resetEventsBusForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('端到端整链：前端 URL → 后端 query → replay 起点 → 前端去重', () => {
  it('同一个 epoch 内：手工重连只补漏掉的那些，已收到的不重复派发', async () => {
    const got: string[] = []
    subscribeEvents('found', (e) => got.push(e.message))
    latest().flushOpen()

    latest().publish({ type: 'found', message: '甲' })   // id=1
    latest().publish({ type: 'found', message: '乙' })   // id=2
    expect(got).toEqual(['甲', '乙'])
    expect(getLastSeenId()).toBe(2)

    // 断线期间服务端又发了两条（前端收不到）
    WiredES.bus.publish({ type: 'found', message: '丙' }) // id=3
    WiredES.bus.publish({ type: 'found', message: '丁' }) // id=4

    const conn2 = await manualReconnect()

    // ⭐ 缝②：后端认到的断点，正是前端拼进 URL 的那个（形状含 epoch）
    expect(conn2.resumeRaw, `前端拼的与后端认的对不上；URL=${conn2.url}`).toBe('boot-A:2')
    // ⭐ 缝③：起点 = 2（同 epoch → 信它的 seq），不是 0（那会重灌甲乙）
    expect(conn2.replayFrom).toBe(2)
    // ⭐ 缝④：补发的丙丁被派发，甲乙没有重复
    expect(got).toEqual(['甲', '乙', '丙', '丁'])
  })

  it('🔴 后端重启（epoch 变化）→ 前端重置断点，新进程的 id=1 照常送达', async () => {
    // 这就是"静默失聪"那条缺陷的整链复现：修复前，下面最后一条断言会是 []。
    const got: string[] = []
    subscribeEvents('found', (e) => got.push(e.message))
    latest().flushOpen()

    // 第一个进程跑出一段号（让 lastSeenId 涨到 3）
    for (const m of ['甲', '乙', '丙']) latest().publish({ type: 'found', message: m })
    expect(getLastSeenId()).toBe(3)
    expect(getBootId()).toBe('boot-A')

    // ── 后端重启（软路由掉电）。新进程 nextId 从 1 重数。 ──
    restartBackend('boot-B')
    WiredES.bus.publish({ type: 'found', message: '重启后-第1条' })  // id=1
    WiredES.bus.publish({ type: 'found', message: '重启后-第2条' })  // id=2

    const conn2 = await manualReconnect()

    // ⭐ 缝②：前端报的断点带着**旧** epoch
    expect(conn2.resumeRaw).toBe('boot-A:3')
    // ⭐ 缝③：epoch 对不上 → 起点归 0（补发全部缓冲）。修复前这里是 3 → 新进程的 1、2 全跳过
    expect(conn2.replayFrom, 'epoch 对不上却没有从缓冲头补发 → 服务端侧静默失聪').toBe(0)
    // ⭐ 缝④：hello 让前端把 lastSeenId 清零 → id=1、2 不再撞上旧断点
    expect(getBootId()).toBe('boot-B')
    expect(
      got,
      '后端重启后前端一条都没收到 → 这就是"页面显示已连接却永远不更新"',
    ).toEqual(['甲', '乙', '丙', '重启后-第1条', '重启后-第2条'])
  })

  it('🔴 浏览器**原生**重连遇上后端重启：靠 `id:` 里的 epoch 兜住（前端碰不到那个头）', async () => {
    // 这一半**改前端修不掉**：Last-Event-ID 头是浏览器维护的，W3C 不向脚本暴露。
    // 唯一的落点就是把 epoch 编进 `id:` 行，让那个头自带 epoch。
    const got: string[] = []
    subscribeEvents('found', (e) => got.push(e.message))
    latest().flushOpen()
    latest().publish({ type: 'found', message: '甲' })
    latest().publish({ type: 'found', message: '乙' })

    // 浏览器攒到的是复合形式——这是 eventFrame 写进 `id:` 行的那个值
    expect(WiredES.browserLastEventId, '`id:` 行没带 epoch → 那个头就自证不了身份').toBe('boot-A:2')

    restartBackend('boot-B')
    WiredES.bus.publish({ type: 'found', message: '重启后-A' })  // id=1

    // 浏览器原生重连：**带头、不带 query**
    WiredES.nativeReconnect = true
    const conn2 = new WiredES('/api/v2/events')
    expect(conn2.resumeRaw).toBe('boot-A:2')
    expect(conn2.replayFrom, '新进程拿旧号段当起点 → replay(>2) 把自己刚发的 1、2 全跳过').toBe(0)
  })

  it('epoch 未变时**不许**重置断点（否则每次重连都重灌一遍历史）', async () => {
    const got: string[] = []
    subscribeEvents('found', (e) => got.push(e.message))
    latest().flushOpen()
    latest().publish({ type: 'found', message: '甲' })
    latest().publish({ type: 'found', message: '乙' })

    // 同一个进程（bootId 不变）重连——hello 报的还是 boot-A
    const conn2 = await manualReconnect()

    expect(conn2.replayFrom).toBe(2)
    expect(getLastSeenId(), '同 epoch 却把断点清零了 → 每次重连都重灌历史').toBe(2)
    expect(got, '重连后重复派发了已收到的事件').toEqual(['甲', '乙'])
  })

  it('两次连续重启都能跟上（epoch 不是"只对第一次有效"）', async () => {
    const got: string[] = []
    subscribeEvents('found', (e) => got.push(e.message))
    latest().flushOpen()
    latest().publish({ type: 'found', message: 'A1' })

    restartBackend('boot-B')
    WiredES.bus.publish({ type: 'found', message: 'B1' })
    await manualReconnect()
    expect(getBootId()).toBe('boot-B')

    restartBackend('boot-C')
    WiredES.bus.publish({ type: 'found', message: 'C1' })
    await manualReconnect()
    expect(getBootId()).toBe('boot-C')

    expect(got).toEqual(['A1', 'B1', 'C1'])
  })

  it('hello 不进四类订阅者（它不是业务事件，也不该抬升 lastSeenId）', async () => {
    const seen: ScoutEvent[] = []
    for (const t of ['activity', 'found', 'health', 'progress'] as const) {
      subscribeEvents(t, (e) => seen.push(e))
    }
    latest().flushOpen()
    // 只有握手，没有任何事件
    expect(seen).toEqual([])
    expect(getLastSeenId()).toBe(0)
    expect(getBootId()).toBe('boot-A')
    // ⭐ 握手帧**不带 `id:` 行**：带了就会污染浏览器维护的 Last-Event-ID，下次原生重连
    //    拿一个不存在的号去续传。sseWire.helloFrame 的注释承诺了这条，这里把它钉住。
    expect(
      WiredES.browserLastEventId,
      'hello 带了 id: 行 → 污染了浏览器的 Last-Event-ID',
    ).toBeNull()
  })

  it('保活注释帧在客户端侧**完全不可见**——这就是 bootId 不能走注释帧的原因', () => {
    // 若把 bootId 塞进 `: bootId=...` 注释帧，客户端连看都看不到（W3C：`:` 开头的行忽略）。
    // 这条用例把那个事实钉死，免得日后有人"为了不加帧"改成注释帧。
    const frames = parseSseWire(`: ping\n\n: bootId=boot-A\n\n${helloFrame('boot-A')}`)
    expect(frames.length, '注释帧被当成了可见帧').toBe(1)
    expect(frames[0]!.event).toBe('hello')
    expect(JSON.parse(frames[0]!.data)).toEqual({ bootId: 'boot-A' })
  })
})
