// web/src/workflow/traceStream.ts：单例 EventSource——整页一条连接，按 runKey 分发给各
// WorkerCard 的订阅者（DESIGN 任务规格："订阅：单例 EventSource（整页一个连接，按 runKey
// 分发给各 WorkerCard），组件卸载退订"）。引用计数归零才真正关闭底层连接，避免"最后一个
// WorkerCard 卸载"和"页面还剩别的 WorkerCard 在跑"这两种情况互相踩踏。
//
// 断线由浏览器 EventSource 原生自动重连；重连成功（第二次及以后触发的 onopen——首次连接不算
// "重连"）会通知 onTraceReconnect 订阅者，让调用方（Lanes.tsx 里的 useWorkflowWorkers().reload()）
// 主动补拉一次 workers 端点，弥补断线窗口期可能漏掉的直播事件（同 server.ts trace-stream 端点
// 注释里"断线靠 EventSource 自动重连 + 落后补拉 workers 端点"的既定约定）。
//
// 可测试性：不直接硬编码 `new EventSource(...)`，而是在每次需要新建连接时才读取当时的
// globalThis.EventSource——jsdom 不自带 EventSource 实现，测试可以在渲染组件前把一个假实现类
// 挂到 globalThis.EventSource 上，驱动 onopen/onmessage 回调，不需要真的开一条网络连接
// （DESIGN 任务规格建议的测试手法之一："EventSource 假实现注入"）。
import { withToken } from '../api/client.js'
import type { TraceEvent } from '../api/types.js'

/** 只依赖用到的那三个成员，方便测试用一个精简假类满足这个形状，不用实现完整 EventSource 接口
 *  （readyState/CLOSED 等常量测试假类用不上）。 */
interface EventSourceLike {
  onopen: ((ev: Event) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onerror: ((ev: Event) => void) | null
  /** 0=CONNECTING 1=OPEN 2=CLOSED（W3C EventSource）。致命关闭判定用（dashboard 审计 #3）。 */
  readyState: number
  close(): void
}
type EventSourceCtor = new (url: string) => EventSourceLike

const TRACE_STREAM_PATH = '/api/v2/workflow/trace-stream'
const CLOSED = 2 // EventSource.CLOSED
const RECONNECT_DELAY_MS = 3000

let es: EventSourceLike | null = null
let hasOpenedOnce = false
let refCount = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const listenersByRunKey = new Map<string, Set<(e: TraceEvent) => void>>()
const reconnectListeners = new Set<() => void>()

/** 致命关闭后的退避重连（dashboard 审计 #3）：单次挂起，到点若仍有订阅者就重建连接。重连出的
 *  新连接 onopen 会（hasOpenedOnce 仍为 true）触发 reconnectListeners，让 Lanes 补拉 workers
 *  弥补断线窗口。自身若再次致命关闭会再排一次，天然形成带退避的重试。 */
function scheduleReconnect(): void {
  if (reconnectTimer != null) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (refCount > 0) ensureConnected()
  }, RECONNECT_DELAY_MS)
}

function currentCtor(): EventSourceCtor | undefined {
  return (globalThis as { EventSource?: EventSourceCtor }).EventSource
}

function ensureConnected(): void {
  if (es) return
  const Impl = currentCtor()
  if (!Impl) return // 环境没有 EventSource 实现（理论上只会发生在没打桩的测试环境）——静默跳过，不炸调用方
  const instance = new Impl(withToken(TRACE_STREAM_PATH))
  instance.onopen = () => {
    if (hasOpenedOnce) {
      for (const fn of reconnectListeners) fn()
    }
    hasOpenedOnce = true
  }
  instance.onerror = () => {
    // readyState CONNECTING(0)：浏览器正在自行重连（网络瞬断）——不插手，交给原生自动重连。
    // CLOSED(2)：致命关闭（非 2xx 响应，如服务端重启 502/会话失效 401），浏览器不会自动重连，
    // 且单例 es 常驻非 null 会让后续 subscribeTrace 全部短路（if (es) return）→ 直播永久卡死
    // （dashboard 审计 #3）。主动 teardown 当前连接 + 退避重连。
    if (instance.readyState === CLOSED && es === instance) {
      instance.close()
      es = null
      scheduleReconnect()
    }
  }
  instance.onmessage = (ev) => {
    let parsed: TraceEvent
    try {
      parsed = JSON.parse(ev.data) as TraceEvent
    } catch {
      return // 畸形 data 行——静默丢弃，不让一条坏事件打断整条订阅
    }
    // R2D-13（R2 复审）：realign 字幕先行阶段逐集起 `job-${jobId}-${absoluteEpisode}` runKey——
    // WorkerCard 订阅的仍是 `job-${jobId}`（子集号是 realignExecutor 内部循环的实现细节，订阅方
    // 不知道也不该知道）。分发谓词从"精确匹配"放宽成"精确匹配或以 key+'-' 为前缀"：`key+'-'`
    // 的尾连字符防止 job-42 误吞 job-420 这类数字延伸、并不相关的另一个 job。
    for (const [key, set] of listenersByRunKey) {
      if (parsed.runKey === key || parsed.runKey.startsWith(`${key}-`)) {
        for (const fn of set) fn(parsed)
      }
    }
  }
  es = instance
}

function teardownIfUnused(): void {
  if (refCount <= 0 && es) {
    es.close()
    es = null
    hasOpenedOnce = false
  }
}

/** 订阅某个 runKey 的直播事件。返回退订函数——组件卸载时调用；引用计数归零即关闭底层连接。 */
export function subscribeTrace(runKey: string, onEvent: (e: TraceEvent) => void): () => void {
  refCount++
  ensureConnected()
  let set = listenersByRunKey.get(runKey)
  if (!set) {
    set = new Set()
    listenersByRunKey.set(runKey, set)
  }
  set.add(onEvent)
  return () => {
    set?.delete(onEvent)
    if (set && set.size === 0) listenersByRunKey.delete(runKey)
    refCount--
    teardownIfUnused()
  }
}

/** 重连通知——第二次及以后的 onopen（首次连接不算"重连"）。返回退订函数。 */
export function onTraceReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn)
  return () => {
    reconnectListeners.delete(fn)
  }
}

/** 仅供测试：强制关闭当前连接并清空全部模块级状态，让下一次 subscribeTrace 重新走
 *  ensureConnected（重新读取彼时的 globalThis.EventSource，测试可以借此在用例之间切换/重置
 *  假实现，不必担心上一条用例留下的单例连接串扰下一条）。 */
export function __resetTraceStreamForTests(): void {
  if (es) es.close()
  es = null
  hasOpenedOnce = false
  refCount = 0
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  listenersByRunKey.clear()
  reconnectListeners.clear()
}
