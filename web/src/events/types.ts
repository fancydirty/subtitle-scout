// web/src/events/types.ts：SSE 事件的前端类型——**逐字对齐后端 src/core/scoutEvents.ts**。
//
// 为什么在前端重写一遍而不是 import 后端类型：web/ 是独立的 tsconfig 工程（浏览器侧，
// types 白名单只放 vitest/jest-dom），跨出 web/ 去 import src/ 会把整个 node 侧类型面
// 拖进来。既有的 api/types.ts 是同一个处置（它也是手抄后端 DTO），照它的先例。
//
// ⚠️ 手抄的代价是**后端改了这里不会报错**。缓解：events.contract.test.ts 里有一条
// 用真实后端事件形状（从 scoutEvents.ts 的注释逐字誊来的样例）喂解析器的用例。
// 这不能证明后端没改，只能证明"今天这个形状能被正确解析"——诚实地说，跨工程的类型漂移
// 在本仓的架构下没有编译期防线。

/** R-F10 的四类事件。**封闭集合**——后端 ScoutEventType 的镜像。
 *  这四个也正是本目录四层 Context 的分层依据（见 EventsProvider.tsx 的头注释）。 */
export type ScoutEventType = 'activity' | 'found' | 'health' | 'progress'

/** 三个工作台。**封闭三态**，与后端 ScoutWorkbench 同集合。 */
export type ScoutWorkbench = 'identify' | 'subtitle' | 'translate'

/**
 * 一条 SSE 事件。
 *
 * ⚠️ `workbench` **可选，而且必须当可选处理**（后端注释里点名警告过的坑）：
 * daemonV2 的 13 个 emit 点里有 6 个不属于任何工作台（巡检开始/完成/失败 + 阶段 1 扫描的
 * 三条 health）。判别口径是 **`workbench !== undefined`**，不是"哪个值"：
 *   有值 → 工作台级，按值分三路；
 *   无值 → 巡检/扫描级，走全局横幅，**不进任何 tab**。
 * **千万不要写 `?? 'identify'` 之类的兜底**——那会把巡检级事件混进识别状态条。
 */
export interface ScoutEvent {
  /** 单调递增，从 1 起。断线续传的 Last-Event-ID 就是它。 */
  id: number
  at: number
  type: ScoutEventType
  message: string
  title?: string
  workbench?: ScoutWorkbench
  data?: Record<string, unknown>
}

/** 连接状态——给 UI 说人话用。
 *  · `connecting` 首次建连中；
 *  · `open` 连上了；
 *  · `unavailable` 端点 503（**没跑 watch**，见 EventsProvider 的 503 论证）——终态，不再重连；
 *  · `retrying` 连接掉了，正在退避重连。 */
export type EventsStatus = 'connecting' | 'open' | 'unavailable' | 'retrying'
