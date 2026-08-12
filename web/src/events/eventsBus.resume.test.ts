// web/src/events/eventsBus.resume.test.ts：**手工重连的断线续传**（`?lastEventId=`）。
//
// 后端两条通路（server.ts:1003，头优先于 query）：
//   ① 请求头 `Last-Event-ID` —— 浏览器**原生**重连带，前端碰不到；
//   ② query `?lastEventId=` —— **手工重建**带，因为 `new EventSource(url)` 不能带自定义头。
// 本文件只能测②（①在浏览器内部，jsdom 的假实现里根本不存在这个概念）——但正因如此，
// **"①那条路上我们不碰实例"这条守护断言必须在这里**：它是②不越界的边界。
// 没有它的话，将来有人把瞬断也"顺手统一"成手工重建，①就被②顶掉了，而②带的
// lastSeenId 比浏览器知道的更旧（只到已派发的最后一条）→ 静默丢事件。
//
// 断言的形式是**读构造器实际收到的 URL 字符串**，不是"看看代码里有没有写 lastEventId"。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { subscribeEvents, getLastSeenId, __resetEventsBusForTests } from './eventsBus.js'
import type { ScoutEvent } from './types.js'

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
  emit(e: ScoutEvent) {
    for (const fn of this.listeners.get(e.type) ?? []) fn({ data: JSON.stringify(e) })
  }
  /** 致命关闭（非 2xx）——浏览器放弃，我们接手手工重建。 */
  fatal() { this.readyState = 2; this.onerror?.() }
  /** 瞬断——浏览器正在自行重连（readyState 停在 CONNECTING）。 */
  transient() { this.readyState = 0; this.onerror?.() }
}

/** 只清 microtask（probe 那条 async 链），**不推进定时器**——推进了就分不清
 *  "退避存在吗"和"重连发生了吗"（503 测试文件里踩过这个坑，照抄它的口径）。 */
const flush = async () => { await vi.advanceTimersByTimeAsync(0) }

/** probe 返回非 503 → 走退避重连这条路（本文件要测的就是它）。 */
function mockProbe(status: number) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status < 400, status, body: null, json: async () => ({}),
  }) as unknown as Response))
}

const ev = (id: number, over: Partial<ScoutEvent> = {}): ScoutEvent => ({
  id, at: 1_700_000_000_000, type: 'activity', message: `m${id}`, ...over,
})

/** 走完一次「致命关闭 → 探测非 503 → 退避 3s → 手工重建」。 */
async function manualReconnect() {
  FakeES.instances[FakeES.instances.length - 1]!.fatal()
  await flush()
  await vi.advanceTimersByTimeAsync(3000)
}

const q = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1))

beforeEach(() => {
  vi.useFakeTimers()
  FakeES.instances = []
  __resetEventsBusForTests()
  vi.stubGlobal('EventSource', FakeES)
  mockProbe(500)
})
afterEach(() => {
  __resetEventsBusForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('手工重连带 ?lastEventId=（后端 query 通路的前端侧）', () => {
  it('首次连接**不带** lastEventId（没有"已收到的"这回事）', () => {
    subscribeEvents('activity', () => {})
    const url = FakeES.instances[0]!.url
    expect(FakeES.instances.length).toBe(1)
    expect(url, `首连不该带断点，实际 URL: ${url}`).not.toContain('lastEventId')
  })

  it('手工重建的 URL 带 lastEventId，值 = **已收到的最大 id**', async () => {
    subscribeEvents('activity', () => {})
    const first = FakeES.instances[0]!
    first.emit(ev(7))
    first.emit(ev(8))
    first.emit(ev(42))
    expect(getLastSeenId()).toBe(42)

    await manualReconnect()

    expect(FakeES.instances.length, '致命关闭后应当手工重建').toBe(2)
    const url = FakeES.instances[1]!.url
    expect(url, `重连 URL 没带断点: ${url}`).toContain('lastEventId')
    // ⭐ 值判据：42 是**最大 id**。写成条数就是 3，写成 0 就是"从头补发"——
    //   这三个数字在这条用例里两两不同，所以任何一种搞错都会红。
    expect(q(url).get('lastEventId'), `期望最大 id 42，实际 URL: ${url}`).toBe('42')
  })

  it('值不是"条数"——3 条事件但 id 稀疏时，带的是 id 不是 3', async () => {
    subscribeEvents('activity', () => {})
    const first = FakeES.instances[0]!
    first.emit(ev(11, { type: 'found' }))
    first.emit(ev(12))
    first.emit(ev(13, { type: 'health' }))

    await manualReconnect()

    const url = FakeES.instances[1]!.url
    expect(q(url).get('lastEventId'), `条数是 3，最大 id 是 13，实际: ${url}`).toBe('13')
  })

  it('值不是 0——收过事件就必须是正数（0 = 让后端 replay 全量，等于没做续传）', async () => {
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.emit(ev(5))
    await manualReconnect()
    const got = q(FakeES.instances[1]!.url).get('lastEventId')
    expect(got).not.toBe('0')
    expect(Number(got)).toBeGreaterThan(0)
  })

  it('去重逻辑不弄脏它：乱序/重复的旧 id 不会把断点拉低', async () => {
    subscribeEvents('activity', () => {})
    const first = FakeES.instances[0]!
    first.emit(ev(9))
    first.emit(ev(4))  // 迟到的旧事件 → 被去重丢弃
    first.emit(ev(9))  // 重复 → 被去重丢弃
    expect(getLastSeenId(), '去重路径把断点拉低了').toBe(9)

    await manualReconnect()
    expect(q(FakeES.instances[1]!.url).get('lastEventId')).toBe('9')
  })

  it('断点跨多次重连持续抬升（第二次重连带的是第二段收到的更大 id）', async () => {
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.emit(ev(2))
    await manualReconnect()
    expect(q(FakeES.instances[1]!.url).get('lastEventId')).toBe('2')

    FakeES.instances[1]!.emit(ev(30))
    await manualReconnect()
    expect(FakeES.instances.length).toBe(3)
    expect(q(FakeES.instances[2]!.url).get('lastEventId')).toBe('30')
  })

  it('与既有 ?token= 共存：两个参数都在，且只有一个 `?`', async () => {
    // withToken 读 location.search。jsdom 里用 history 改 URL 即可。
    const original = location.href
    history.replaceState(null, '', '/?token=se%2Fcret')
    try {
      subscribeEvents('activity', () => {})
      expect(FakeES.instances[0]!.url).toBe('/api/v2/events?token=se%2Fcret')

      FakeES.instances[0]!.emit(ev(6))
      await manualReconnect()

      const url = FakeES.instances[1]!.url
      // ⭐ 拼错顺序（先 withToken 再挂 lastEventId）会拼出第二个 `?`，token 值被污染。
      expect(url.split('?').length - 1, `URL 里有多个 ? : ${url}`).toBe(1)
      const p = q(url)
      expect(p.get('token'), `token 被拼坏了: ${url}`).toBe('se/cret')
      expect(p.get('lastEventId')).toBe('6')
    } finally {
      history.replaceState(null, '', original)
    }
  })
})

describe('边界：②不许越界侵占①和 503 终态', () => {
  it('瞬断（CONNECTING）→ **不碰实例**：不 close、不新建、也就谈不上带 lastEventId', async () => {
    // 守护断言。把这条路"顺手统一"成手工重建，续传就从①（浏览器权威）退化成
    // ②（我们只知道已派发到哪），断线期间的事件会静默丢。
    subscribeEvents('activity', () => {})
    const first = FakeES.instances[0]!
    first.emit(ev(3))

    first.transient()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(first.closed, '瞬断时关掉了连接 → 浏览器攒的 Last-Event-ID 被扔掉').toBe(false)
    expect(
      FakeES.instances.length,
      '瞬断时新建了连接 → 抢了浏览器原生重连的活，续传断点退化成前端的 lastSeenId',
    ).toBe(1)
  })

  it('503 终态：一次都不重连，也就不会有任何带 lastEventId 的 URL', async () => {
    mockProbe(503)
    subscribeEvents('activity', () => {})
    FakeES.instances[0]!.emit(ev(4))
    FakeES.instances[0]!.fatal()
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeES.instances.length, '503 之后还在重连 → 重连风暴').toBe(1)
    expect(FakeES.instances.some((i) => i.url.includes('lastEventId'))).toBe(false)
  })
})
