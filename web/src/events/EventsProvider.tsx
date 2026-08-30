// web/src/events/EventsProvider.tsx：R-F10 四类事件的 Context 层。**四个独立 Context，
// 不是一个**。
//
// ── 为什么必须拆四层（本文件存在的全部理由）─────────────────────────────────────
// `progress` 是四类里唯一的高频事件（后端为它单独加了 1 秒节流，PROGRESS_THROTTLE_MS）。
// 一部 24 集的剧逐集完成会在几分钟里连发几十条。
//
// 如果四类共用一个 Context（`{activity, found, health, progress}` 一个对象）：progress
// 每到一条 → provider setState → **context value 换新引用** → **所有 useContext 的消费者
// 全部重渲染**，包括通知页那种一天更新几次的列表。React 的 context 传播不看你读了对象里
// 的哪个字段，只看 value 的引用变没变——这是 useContext 的机制，不是可以靠 memo 绕过去的
// （React.memo 拦不住 context 更新）。
//
// 拆成四个之后，progress 的 setState 只换 ProgressContext 的 value，另外三个 Context 的
// value 引用**原封不动** → 它们的消费者不重渲染。
//
// ── 这不是纸上谈兵，有运行时探针钉着 ────────────────────────────────────────
// EventsProvider.test.tsx 里给每类消费者包一个**渲染计数器**，断言"发 N 条 progress 之后
// progress 消费者渲染了，activity/found/health 消费者的渲染次数**一次都没涨**"。
// 变异验证：把四层合成一层 → 那条断言立刻红（报告里有真实输出）。
// 之所以用计数器而不是"源码里有四个 createContext"式的断言：Task ⑤ 的教训——源码级文本
// 断言一行尾注释就能喂饱，证明的是"写了这几个字"而不是"运行时真的隔离"。
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react'
import { subscribeEvents, subscribeStatus, getStatus } from './eventsBus.js'
import type { ScoutEvent, ScoutEventType, EventsStatus } from './types.js'

/** 每层 Context 存的东西：**最后一条**该类事件（null = 本次会话还没收到过）。
 *  为什么不存数组：本 task 只建壳，"攒多少条、怎么聚合"是各页面自己的事（通知页要一周
 *  流水、活动页只要当前态）。在壳里预设一个数组等于替 Task ⑧⑨⑩ 做了它们的数据结构决定，
 *  而且一个只增不减的数组在长跑标签页上就是内存泄漏。 */
export type EventSlot = ScoutEvent | null

// 四个独立 Context。**默认值 null**——Provider 之外读到的就是"没有事件"，
// 不抛错：壳外的组件（LoginPage 等）不该因为没包 Provider 就白屏。
const ActivityContext = createContext<EventSlot>(null)
const FoundContext = createContext<EventSlot>(null)
const HealthContext = createContext<EventSlot>(null)
const ProgressContext = createContext<EventSlot>(null)
/** 连接状态单独一层：它变化极少（connecting→open 各一次），但每个页面都可能要显示
 *  "实时通道不可用"。混进任何一个事件层都会让那层的消费者跟着状态变化白重渲染一次。 */
const StatusContext = createContext<EventsStatus>('connecting')

/** 一类事件订阅 + 存最后一条。每类各调一次——四个独立的 useState，
 *  于是四次 setState 互不相干（这就是"四层"在实现上的落点）。
 *
 *  ⚠️ 消费边界（2026-08-30 demo 双车道实案）：**last-wins 槽只服务快照型消费者**
 *  （found/health/巡检态这类"只关心最新一条"的读法）；**逐帧消费者必须直订阅
 *  eventsBus**（subscribeEvents，每条同步回调、无合并）。原因：同类型两条事件在
 *  同一个 passive-effect 窗口内连发（<一帧间隔）时，这里的 setSlot 被 React 批处理，
 *  消费方 `useEffect(()=>apply(x),[x])` 只带最终值跑一次——**前一条永久丢失**。
 *  demo 每 tick 成对连发 subtitle→translate progress，subtitle 帧每次被吞；产品级
 *  等价物是 SSE 重连 replay 的 50 帧连发突发。见 ActivityPage 的 useCurrentState /
 *  useStepLog（已改直订阅）。 */
function useEventSlot(type: ScoutEventType): EventSlot {
  const [slot, setSlot] = useState<EventSlot>(null)
  useEffect(() => subscribeEvents(type, setSlot), [type])
  return slot
}

export function EventsProvider({ children }: { children: ReactNode }) {
  const activity = useEventSlot('activity')
  const found = useEventSlot('found')
  const health = useEventSlot('health')
  const progress = useEventSlot('progress')

  const [status, setStatus] = useState<EventsStatus>(() => getStatus())
  useEffect(() => subscribeStatus(setStatus), [])

  // ⚠️ 嵌套顺序无关紧要（Context 之间互不影响），但**每个 value 必须是原始事件对象本身**，
  // 不许包成 `{event: x}`——包一层就等于每次任意一类更新时都新建一个对象，
  // 而这个 Provider 组件本身会因为 4 个 useState 中任意一个变化而重渲染。
  // 直接透传 slot 引用：progress 变化时 activity 的 value 仍是**同一个引用**，
  // React 据此跳过 ActivityContext 的消费者。这一行就是四层隔离真正生效的地方。
  return (
    <StatusContext.Provider value={status}>
      <ActivityContext.Provider value={activity}>
        <FoundContext.Provider value={found}>
          <HealthContext.Provider value={health}>
            <ProgressContext.Provider value={progress}>{children}</ProgressContext.Provider>
          </HealthContext.Provider>
        </FoundContext.Provider>
      </ActivityContext.Provider>
    </StatusContext.Provider>
  )
}

/** 四个消费 hook——**页面只订自己要的那一类**。
 *  Task ⑨ 活动页用 activity+progress；Task ⑩ 通知页只用 found（于是每秒的 progress
 *  完全不会碰它）；健康横幅用 health+status。 */
export const useActivityEvent = (): EventSlot => useContext(ActivityContext)
export const useFoundEvent = (): EventSlot => useContext(FoundContext)
export const useHealthEvent = (): EventSlot => useContext(HealthContext)
export const useProgressEvent = (): EventSlot => useContext(ProgressContext)
export const useEventsStatus = (): EventsStatus => useContext(StatusContext)

/** 渲染计数探针——**仅测试用**，但故意放在生产文件里（不是 testSupport/）：
 *  它必须与被测的 Context 是**同一批模块实例**，放到别处再 import 容易在某天的构建
 *  改动里变成两份模块、探针测的是另一个 Context 而全绿。
 *  用法见 EventsProvider.test.tsx。 */
export function useRenderCount(): number {
  const n = useRef(0)
  n.current++
  return n.current
}

/** 供测试与 Task ⑧⑨⑩ 复用：把一类事件累积成列表的最小实现。
 *  壳里不默认启用（见 EventSlot 的注释：累积策略是各页面自己的事），
 *  但四层里如果哪个页面要流水，不该各写一遍去重逻辑。 */
export function useEventLog(type: ScoutEventType, cap = 50): ScoutEvent[] {
  const [log, setLog] = useState<ScoutEvent[]>([])
  const append = useCallback((e: ScoutEvent) => {
    // 尾部截断到 cap：长跑标签页上不封顶就是内存泄漏。
    setLog((prev) => [...prev, e].slice(-cap))
  }, [cap])
  useEffect(() => subscribeEvents(type, append), [type, append])
  return useMemo(() => log, [log])
}
