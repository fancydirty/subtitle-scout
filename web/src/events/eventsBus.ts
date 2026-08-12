// web/src/events/eventsBus.ts：R-F10 那条 SSE 通道的**唯一**连接（GET /api/v2/events）。
//
// ── 为什么是单例（后端 R-F10 约束 3 的对侧）─────────────────────────────────────
// HTTP/1.1 每源 6 连接上限，三个页面各开一条会吃掉一半。后端为此刻意只开**一个**端点、
// 四类事件走同一条流（server.ts:940 的论证），前端这侧必须对称：整个 app 一条连接，
// 按 `event:` 类型分发给订阅者。形态照抄同仓既有先例 workflow/traceStream.ts
// （引用计数 + 模块级单例 + 惰性读 globalThis.EventSource 以便测试注入假实现）。
//
// ── 503 = 没跑 watch，**是终态不是故障**（本文件最要紧的一条）──────────────────
// `events` 总线只在 cmdWatch 里注入（cli/index.ts）；只跑 dashboard 不跑 watch 时
// /api/v2/events 返回 **503**（server.ts:960，后端刻意不做成静默的 200 空流）。
//
// 浏览器原生 EventSource 收到非 2xx 会把 readyState 打到 CLOSED(2) 并**放弃自动重连**——
// 但我们自己有退避重连（下面 scheduleReconnect），如果不区分 503 与"服务端重启了"，
// 就会变成**每 3 秒敲一次一个永远不会好的端点**，直到用户关掉标签页：这就是任务书点名的
// 重连风暴。而它在开发机上恰恰是**常态**（谁都可能只跑 dashboard 不跑 watch）。
//
// 处置：503 → `unavailable` 终态，**一次都不再重连**。
// ⚠️ 但 EventSource 的 onerror **拿不到 HTTP 状态码**（W3C 规范不暴露）——所以 503 必须
// 靠一次**旁路 fetch 探测**判定：onerror 且 readyState=CLOSED 时，fetch 一次同一个 URL 看
// 状态码，503 就停，其余才排重连。多打一个请求换"不打无限个请求"，划算。
// （这次探测本身失败——比如整个后端都没起——按"可重试"处理：那是 unavailable 之外的另一
// 种情况，服务器起来之后应该自己恢复。）
//
// ── 断线续传：两条通路，各管一半 ───────────────────────────────────────────
// 后端（server.ts:1003）按**头优先于 query**读断点：
//   ① 请求头 `Last-Event-ID` —— **浏览器原生重连**专用。EventSource 自己记着最后一条
//      `id:`，重连时自动带上。前端代码碰不到也改不了它（W3C 不暴露）。
//   ② query `?lastEventId=` —— **我们手工重建连接**专用。`new EventSource(url)` 除了
//      URL 什么都传不了，**不能带自定义头**，所以走②这条路的连接上①根本不存在。
// 头优先：浏览器自己攒的那个是权威，前端不该也无法覆盖它。
//
// 这条分工直接决定了 onerror 的处置形状：
//   readyState=CONNECTING(0) → 浏览器正在自行重连，**绝不插手**，续传走①。插手
//     （close + new）会把浏览器攒的 Last-Event-ID 连同那个实例一起扔掉，而我们手上
//     的 `lastSeenId` 只到"已派发过的最后一条"——比浏览器知道的更旧（缓冲里可能还有
//     它已收到但我们这次 tick 还没处理的帧），且平白多打一个连接。这条路上我们**不碰
//     实例**，一行代码都不执行。（守卫断言在 eventsBus.503.test.ts 与 resume 测试里，
//     否则将来有人"顺手统一成手工重连"就静默退化了。）
//   readyState=CLOSED(2) → 浏览器已放弃（非 2xx），我们接手退避重建。这条路上①不存在，
//     所以必须由**我们自己**在 URL 上挂②——这就是前端非得自己记一份 id 的理由：
//     浏览器的那份记在它的内部状态里，我们读不到，实例一关就没了。
//
// 前端记的那份 = `lastSeenId`（dispatch 里单调抬升的**最大已收事件 id**，不是条数）。
// 它同时是按 id 去重的基准：手工重连后后端会 replay(lastSeenId+1..)，理论上不重复，但
// 浏览器原生重连的 replay 一定会带来重复（①的语义是"从这条之后"，而边界事件可能在我们
// 侧已派发）。**去重与续传互补不冲突**：续传决定后端补多少，去重决定我们派发多少。
//
// ── ⚠️ 但 id 只在**一次后端进程启动**内单调（本模块最要命的那条）────────────────
// 后端 ScoutEventBus 的 nextId 是**进程内变量**，daemon/容器重启（软路由掉电是本项目常态）
// 后从 1 重数。而上面那个 `lastSeenId` 只单调上升，于是去重门 `id <= lastSeenId` 会把
// **重启后的全部新事件**当旧的丢掉。
//
// 症状是最坏的那种：页面不报错、连接是通的、状态一路显示 `open`，但**永远不再更新**。
// 用户完全无法察觉，只会觉得"这破软件又不干活了"。
//
// 处置：后端在每条连接建立时发一条 **`hello` 帧**（`{ bootId }`，src/core/sseWire.ts），
// bootId 是后端进程启动时生成的 epoch。前端发现 bootId 与上次不同 → **把 lastSeenId 清零**
// （见 onHello）。于是重启后的 id=1 不再撞上旧断点。
//
// 另一半在服务端，**改前端修不掉**：浏览器原生重连自动带的那个 `Last-Event-ID` 头前端
// 碰不到（W3C 不暴露），后端拿它 replay(>42) 就会把新进程刚发的 1..42 全跳过。
// 那一半靠把 epoch 编进 SSE 的 `id:` 行（`<bootId>:<seq>`）解决——纯服务端事，本文件
// 只需保证②那条通路（手工重连的 `?lastEventId=`）也带上 epoch，见 eventsUrl。
import { withToken } from '../api/client.js'
import type { ScoutEvent, ScoutEventType, EventsStatus } from './types.js'

/** 只依赖用到的成员——测试用精简假类满足这个形状即可，不必实现完整 EventSource
 *  （同 traceStream.ts 的 EventSourceLike 手法）。 */
interface EventSourceLike {
  onopen: (() => void) | null
  onerror: (() => void) | null
  addEventListener: (type: string, fn: (e: { data: string }) => void) => void
  close: () => void
  /** 0=CONNECTING 1=OPEN 2=CLOSED（W3C）。致命关闭判定用。 */
  readyState: number
}

type EventSourceCtor = new (url: string) => EventSourceLike

const EVENTS_PATH = '/api/v2/events'
const CLOSED = 2
const RECONNECT_DELAY_MS = 3000

/** 四类事件——与 types.ts 的 ScoutEventType 同集合。`addEventListener` 要按名注册，
 *  故这里要一份可遍历的运行时数组（类型是编译期的，遍历不了）。 */
export const EVENT_TYPES: readonly ScoutEventType[] = ['activity', 'found', 'health', 'progress']

/** 连接建立时后端发的那条一次性帧的事件名。**必须与后端 sseWire.ts 的 HELLO_EVENT 一致**
 *  （web/ 是独立 tsconfig 工程，跨工程 import 会把 node 侧类型面拖进浏览器工程——同
 *  types.ts 手抄后端类型的既有处置）。一致性由 sseWireContract.e2e.test.ts 证明：
 *  它用**后端真实的 helloFrame()** 造帧喂给本模块，名字对不上就收不到，用例即红。
 *  ⚠️ 它**不在** EVENT_TYPES 里：hello 不是四类业务事件之一，不该被分发给任何页面订阅者。 */
export const HELLO_EVENT = 'hello'

let es: EventSourceLike | null = null
let refCount = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let status: EventsStatus = 'connecting'
/** 见文件头「断线续传」段：**最大已收事件 id**（不是条数）。两个用途：
 *  ① 按 id 去重的基准；② 手工重建连接时挂到 `?lastEventId=` 上的续传断点。
 *  ⚠️ 它只在**一个 bootId 内**有意义（见文件头 ⚠️ 段）——换 epoch 必须清零。 */
let lastSeenId = 0
/** 上一条 hello 报的后端 epoch。`null` = 本次会话还没收到过 hello
 *  （首连的 hello 到达之前，或对面是没有 hello 帧的旧版后端）。 */
let bootId: string | null = null

const listenersByType = new Map<ScoutEventType, Set<(e: ScoutEvent) => void>>()
const statusListeners = new Set<(s: EventsStatus) => void>()

function setStatus(next: EventsStatus): void {
  if (status === next) return
  status = next
  for (const fn of statusListeners) {
    try { fn(next) } catch { /* 一个订阅者抛错不许连坐其余（同后端总线的既有口径） */ }
  }
}

export function getStatus(): EventsStatus {
  return status
}

/** 最后收到的事件 id（0 = 还没收到过任何事件）。导出供测试断言"它真的在跟踪"——
 *  这个值是去重与续传的唯一依据，不可观测就没法证明它没被写死成 0 / 没被写成条数。 */
export function getLastSeenId(): number {
  return lastSeenId
}

/** 当前认得的后端 epoch（null = 还没收到过 hello）。导出供测试断言"epoch 真的换了"——
 *  只断言"重启后收得到事件"证明不了是 epoch 起的作用（把去重整个删掉也能让它绿）。 */
export function getBootId(): string | null {
  return bootId
}

/** 本次要连的 URL。
 *
 *  `lastSeenId > 0` 时挂 `?lastEventId=`（见文件头「断线续传」段的②）：这是**手工重建**
 *  才有的情形——首次连接没有"已收到的"这回事，不挂（挂 0 是噪音，后端也按 0 处理）。
 *  判据是"有没有收到过事件"而不是"这是第几次连接"，两者在本模块里等价，但前者才是
 *  这个参数真正的语义。
 *
 *  ⚠️ 值的形状是 **`<bootId>:<seq>`**（与后端 sseWire.formatEventId 同形），不是裸 seq。
 *  为什么必须带 epoch：手工重建**恰恰是后端刚重启时最常走的那条路**（进程死了 → 连接被
 *  拒 → CLOSED → 我们接手）。此时 lastSeenId 还是上个进程的号，裸报一个 `42` 会让新进程
 *  按 replay(>42) 处理，把它刚发的 1..42 全部跳过——**服务端侧的静默失聪**。带上 epoch，
 *  服务端 resolveReplayFrom 一看对不上就从缓冲头补发。
 *  还没收到过 hello（bootId===null）时退回裸 seq：后端 parseResumeToken 认这种形式
 *  （eventStream.test.ts 里的既有公开契约）。
 *
 *  ⚠️ 顺序：**先拼 lastEventId 再交给 withToken**。withToken 会看 path 里有没有 `?`
 *  来决定用 `?token=` 还是 `&token=`，反过来拼就会拼出两个 `?`（`?token=x?lastEventId=3`），
 *  后端 URL 解析把 `x?lastEventId=3` 整个当 token 值 → 鉴权失败 + 续传失效，一次坏两样。
 */
function eventsUrl(): string {
  if (lastSeenId <= 0) return withToken(EVENTS_PATH)
  const token = bootId === null ? String(lastSeenId) : `${bootId}:${lastSeenId}`
  return withToken(`${EVENTS_PATH}?lastEventId=${encodeURIComponent(token)}`)
}

function currentCtor(): EventSourceCtor | undefined {
  return (globalThis as { EventSource?: EventSourceCtor }).EventSource
}

/** 503 判定：EventSource 的 onerror 不给状态码，只能旁路 fetch 探一次（见文件头论证）。 */
async function probeUnavailable(): Promise<boolean> {
  try {
    const res = await fetch(withToken(EVENTS_PATH), { method: 'GET' })
    // 探测响应体不消费——只看状态码。SSE 流的 body 不 cancel 会挂着一条连接。
    try { await res.body?.cancel() } catch { /* 已经关了/环境没有 body：无所谓 */ }
    return res.status === 503
  } catch {
    // 探测本身失败（后端整个没起/网络断）——**不是** 503 那种"配置上就没有这条流"的终态，
    // 按可重试处理，让退避重连去等服务器起来。
    return false
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer != null) return
  setStatus('retrying')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (refCount > 0) ensureConnected()
  }, RECONNECT_DELAY_MS)
}

/**
 * **本次修复的客户端落点**：处理连接建立时的那条 hello 帧。
 *
 * bootId 与上次不同 = 对面换了一个后端进程，它的事件号从 1 重新计数。此刻 `lastSeenId`
 * 攥着的是**上个进程**的号（比如 42），不清零的话去重门 `id <= 42` 会把重启后的
 * 1..42 号事件全部丢掉——而那正是"页面显示已连接却永远不更新"的成因。
 *
 * ── 为什么是"不同就清零"，不是"变小就清零" ──
 * 后者要拿 id 猜进程身份，而 id 本身就是不可靠的那个东西：新进程跑上一整天后 id 会重新
 * 涨过 42，那时再重启一次就又猜不出来了（重启前 id=3、重启后 id=1 能猜中，重启前 id=3、
 * 重启后已经涨到 5 就猜不中）。epoch 是显式事实，不需要猜。
 *
 * ── 首次 hello（bootId === null）为什么也走同一条路 ──
 * 那一支里 lastSeenId 本来就是 0，清零是幂等 no-op。不为它单开一支：分支越少越难写错，
 * 而"首连也清一次"没有任何可观测的代价。
 *
 * ── 畸形 / 缺字段的 hello ──
 * 静默忽略（不清零、不改 bootId），同 dispatch 对畸形 data 行的既有口径：一条坏帧不许
 * 打断整条订阅。代价是这次连接退化成修复前的行为（可能丢事件），但那**严格不差于**
 * 拿一个解析不出的值去乱清断点。
 */
function onHello(raw: string): void {
  let next: string
  try {
    const parsed = JSON.parse(raw) as { bootId?: unknown }
    if (typeof parsed.bootId !== 'string' || parsed.bootId === '') return
    next = parsed.bootId
  } catch {
    return
  }
  if (next === bootId) return  // 同一个后端进程（浏览器原生重连的常态）——断点照旧有效
  bootId = next
  lastSeenId = 0
}

function dispatch(raw: string): void {
  let parsed: ScoutEvent
  try {
    parsed = JSON.parse(raw) as ScoutEvent
  } catch {
    return // 畸形 data 行静默丢弃，不让一条坏事件打断整条订阅（同 traceStream 的口径）
  }
  // 去重：浏览器原生重连会让后端 replay 补发，缓冲里 id ≤ lastSeenId 的那些我们已经见过。
  // 不去重的话通知页会出现重复条目、活动页的计数会翻倍。
  if (typeof parsed.id === 'number' && parsed.id <= lastSeenId) return
  if (typeof parsed.id === 'number') lastSeenId = parsed.id
  const set = listenersByType.get(parsed.type)
  if (!set) return
  for (const fn of set) {
    try { fn(parsed) } catch { /* 同 setStatus：一个订阅者抛错不许连坐 */ }
  }
}

function ensureConnected(): void {
  if (es) return
  const Impl = currentCtor()
  if (!Impl) return // 环境没有 EventSource（只会发生在没打桩的测试里）——静默跳过，不炸调用方
  if (status !== 'retrying') setStatus('connecting')
  const instance = new Impl(eventsUrl())

  instance.onopen = () => {
    if (es === instance) setStatus('open')
  }

  instance.onerror = () => {
    // CONNECTING(0)：浏览器正在自行重连——**不插手**。插手就等于扔掉它攒着的
    // Last-Event-ID，断线期间的事件再也补不回来（见文件头论证）。
    if (instance.readyState !== CLOSED || es !== instance) return
    // CLOSED(2)：非 2xx，浏览器已放弃。先探一次是不是 503（没跑 watch = 终态）。
    instance.close()
    es = null
    void probeUnavailable().then((is503) => {
      if (is503) {
        // 终态：**一次都不再重连**。用户跑起 watch 之后刷新页面即可——为这种
        // "要改运维状态才会变"的条件挂一个永久轮询是没有意义的。
        setStatus('unavailable')
        return
      }
      if (refCount > 0) scheduleReconnect()
    })
  }

  // 后端每帧都发 `event: <type>`，所以 onmessage（只收无名事件）**永远不会触发**——
  // 必须按名注册四个监听器。这是一条静默失效点：写成 onmessage 不报错，只是一条都收不到。
  for (const type of EVENT_TYPES) {
    instance.addEventListener(type, (e) => dispatch(e.data))
  }
  // hello 单独注册，**不进 dispatch**：它不是四类业务事件，不该被派发给任何页面订阅者，
  // 也不参与 lastSeenId 的抬升（它没有 id）。见 onHello 的注释。
  instance.addEventListener(HELLO_EVENT, (e) => onHello(e.data))

  es = instance
}

function teardownIfUnused(): void {
  if (refCount <= 0 && es) {
    es.close()
    es = null
  }
}

/** 订阅某一类事件。返回退订函数——组件卸载时必须调用；引用计数归零即关闭底层连接。 */
export function subscribeEvents(type: ScoutEventType, fn: (e: ScoutEvent) => void): () => void {
  refCount++
  ensureConnected()
  let set = listenersByType.get(type)
  if (!set) {
    set = new Set()
    listenersByType.set(type, set)
  }
  set.add(fn)
  return () => {
    set?.delete(fn)
    if (set && set.size === 0) listenersByType.delete(type)
    // 同一退订函数被调两次会把计数减成负数、提前关掉还有订阅者的连接
    // （traceStream 的 R5-9 修过这个洞，这里照搬 clamp）。
    refCount = Math.max(0, refCount - 1)
    teardownIfUnused()
  }
}

/** 订阅连接状态变化。返回退订函数。 */
export function subscribeStatus(fn: (s: EventsStatus) => void): () => void {
  statusListeners.add(fn)
  return () => { statusListeners.delete(fn) }
}

/** 仅供测试：强制关闭连接并清空全部模块级状态，让下一条用例从干净的单例开始
 *  （同 traceStream 的 __resetTraceStreamForTests）。 */
export function __resetEventsBusForTests(): void {
  if (es) es.close()
  es = null
  refCount = 0
  status = 'connecting'
  lastSeenId = 0
  bootId = null
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  listenersByType.clear()
  statusListeners.clear()
}
