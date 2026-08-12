// web/src/events/resumeEdge.ts —— 「SSE 从掉线状态**恢复**了」这个边沿的**唯一**判据。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么值得单独一个模块（它就三行）
// ══════════════════════════════════════════════════════════════════════════════
// 这条判据在仓里有三个落点（活动页的 useCurrentState、活动页页面级、通知页），
// 三份手写副本已经**实际漂移过**：活动页两处写的是
//
//     was !== 'open' && status === 'open'
//
// 而 eventsBus 的初始状态就是 `'connecting'`（eventsBus.ts:99）——于是**首连的
// `connecting → open` 被当成了"重连"**，每次挂载都多打一次 /activity 与 /health。
// 通知页写对了（多一个 `was !== 'connecting'`），两个页面对同一件事给出两种答案。
//
// 判据只有一份、且是**编译期封闭**的（下面的 never 穷尽检查），漂移就不可能再发生。
//
// ══════════════════════════════════════════════════════════════════════════════
// 四个状态各自该不该拉（逐条对着 eventsBus 的状态机，不是照抄通知页那一行）
// ══════════════════════════════════════════════════════════════════════════════
// EventsStatus 是**四态封闭集**（types.ts:45）：connecting / open / unavailable / retrying。
// ⚠️ 没有 `'error'` 这个状态——审计提到的那一支在本仓不存在，探测失败走的是
// `retrying`（eventsBus.ts:172-175 明写"按可重试处理"）。
//
//  · `connecting → open`  **不拉**。
//      `connecting` 有且只有两个来源，两个都不是"掉过线"：
//      ① 模块初值（eventsBus.ts:99）——页面首载时读到的就是它；
//      ② `ensureConnected` 在**非退避**路径上重置（eventsBus.ts:244）——那条路只在
//         refCount 归零后重新订阅时走到，也就是"页面刚挂上"。
//      两种情形下页面自己的挂载期 fetch（useHealth/useActivity 的首个 effect）**已经**
//      取过一份快照了。再拉一次是纯粹的重复请求——这正是审计探针数出来的
//      `/activity 1 -> 2 | /health 1 -> 2`。
//
//  · `retrying → open`   **要拉**。连接掉过、退避重连成功。断线期间的事件在 50 槽环形
//      缓冲里可能已被冲掉（后端 F-6 的全部理由），本地那份靠事件推导的当前态必须用
//      /health 快照纠正，排队段也要补齐。这是本判据存在的**主用例**。
//
//  · `unavailable → open` **要拉**。`unavailable` 是 503 终态（没跑 watch），
//      eventsBus 一次都不会再重连（:262）。从它回到 open 只可能是**另一条连接**接手了
//      （refCount 归零后重挂 / probe 未决期间新实例抢先 onopen，见 eventsBus.ts:256-266
//      那段 async 窗口）。无论哪条，中间都有一整段**完全没有事件流**的时间——比 retrying
//      更长，更需要快照。
//      ⚠️ 实测里它多半以 `unavailable → connecting → open` 的形状出现（ensureConnected
//      会把非 retrying 的状态重置成 connecting），那一支落在上面 connecting 的口径里、
//      被判为"页面刚挂上"——这是**正确**的：那条路上确实伴随着一次重新挂载与一次首载
//      fetch。这里保留 `unavailable → open` 为 true 是为了那个 async 窗口的直达跃迁。
//
//  · `open → open`        **不拉**。setStatus 自带去重（eventsBus.ts:112），这个跃迁只会
//      以"effect 首次运行时 was === status"的形态出现——也就是**页面挂载时总线已经是
//      open**。那同样是"刚挂上、刚拉过"，拉第二次又是一次重复请求。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴 为什么是 switch + never，不是 `was !== 'open' && was !== 'connecting'`
// ══════════════════════════════════════════════════════════════════════════════
// 后者是**否定式白名单**：将来给 EventsStatus 加第五态（比如真的引入一个 'error'），
// 那一行会**静默地**把它当成"要拉"，没有任何东西会红。反过来写成肯定式白名单
// （`was === 'retrying' || was === 'unavailable'`）则会静默地把它当成"不拉"——
// 而"不拉"的代价是屏幕上继续挂着一句谎话，比多打一个请求严重。
//
// 两种静默都不接受。switch 上挂 never 穷尽检查之后，加第五态是一个**编译错误**
// （web/ 的 tsc --noEmit 会红），必须有人当场想清楚它该走哪支。
// default 的运行时兜底取"拉"——万一将来有人用 as 绕过类型，宁可多打一个请求，
// 也不要让界面继续撒谎。
import { useEffect, useRef } from 'react'
import type { EventsStatus } from './types.js'

/**
 * 「掉线之后**恢复**了」这个边沿。
 *
 * @param was  上一次看到的状态
 * @param next 这一次的状态
 * @returns true = 中间漏过事件，调用方应当拉一次快照
 */
export function isResumeEdge(was: EventsStatus, next: EventsStatus): boolean {
  // 只有**变成 open** 才可能是恢复。其余目标态一律不是边沿（掉线的那一刻不该拉：
  // 那时候连接都没有，拉回来的快照下一秒就又开始过期了——纠正的时机是恢复，不是掉线）。
  if (next !== 'open') return false
  switch (was) {
    case 'open':        return false // 见头注释：effect 首跑时的自等，页面刚挂上
    case 'connecting':  return false // 见头注释：首连 / 重新订阅，挂载期 fetch 已覆盖
    case 'retrying':    return true  // 退避重连成功——本判据的主用例
    case 'unavailable': return true  // 503 终态被另一条连接接手，中间断得更久
    default: {
      // 编译期穷尽：EventsStatus 加了新成员，这一行会报错，逼人回到头注释去定夺。
      const exhaustive: never = was
      void exhaustive
      return true // 运行时兜底：宁可多打一个请求，也不让界面继续挂着过期读数
    }
  }
}

/**
 * `isResumeEdge` 的 React 封装——把"记上一次状态"的样板收在一处。
 *
 * ⚠️ `onResume` **必须是稳定引用**（useCallback）。不稳定也不会误触发（那种情况下
 * effect 重跑时 `was === status`，isResumeEdge 走 open→open 那支返回 false），
 * 但会白跑一遍 effect。
 */
export function useResumeEdge(status: EventsStatus, onResume: () => void): void {
  const prev = useRef(status)
  useEffect(() => {
    const was = prev.current
    // ⚠️ 先落 prev 再判定：判定里如果抛错（onResume 是调用方给的），
    // prev 没更新的话下一次 effect 会拿着同一个 was 再判一次，变成重复拉取。
    prev.current = status
    if (isResumeEdge(was, status)) onResume()
  }, [status, onResume])
}
