// web/src/workbench/workbenchRouting.ts —— R-F1 的**执行点**：把一条 SSE 事件分到三条路。
//
// ══════════════════════════════════════════════════════════════════════════════
// 这个文件是 R-F1「识别不进活动页」在前端的唯一落点。改它之前请读完这段。
// ══════════════════════════════════════════════════════════════════════════════
//
// ── 背景：R-F1 与 R-F10 在同一份 SPEC 里相隔 9 行打起来了（IMPL-DESIGN 教训七）──
// R-F1 说「识别不进活动页」（理由：耗时短，不值得占一个 tab）。
// 而生产 daemonV2.ts:640 **正在推**识别的 activity 事件，注释还把它当功劳写着：
// 「识别是巡检里第一条真正"在动"的阶段，不推的话大库跑识别的那几小时活动页是死的」。
//
// 用户裁决是**三件事的组合**，缺一不可：
//   ① 保留 emit（识别失败要能看见——那条顾虑成立）
//   ② 后端给识别的事件打 `workbench: 'identify'`（Task ⓪ 已做，daemonV2.events.test.ts 钉着）
//   ③ **前端据标剔除**  ← 就是本文件
//
// ── 三条路（判别口径是 `workbench !== undefined`，**不是"哪个值"**）──────────────
// 后端 scoutEvents.ts 与 web/src/events/types.ts 两处头注释都点名警告过这条口径：
//
//   workbench === 'subtitle'   → 字幕 tab
//   workbench === 'translate'  → 翻译 tab
//   workbench === 'identify'   → **顶部状态条**（不占 tab，这就是 R-F1）
//   workbench === undefined    → 巡检级/扫描级 → **全局状态条**，不进任何 tab
//
// 第四条不是补丁，是生产事实：daemonV2 的 emit 点里有 **6 个不带 workbench**——
// 巡检开始/完成/失败（三条）+ 阶段 1 扫描的三条 health。它们不属于任何工作台。
//
// 🔴 **千万不要写 `?? 'identify'` 之类的兜底**（两处后端注释都单独警告过）：
// 那会把「巡检开始」「守备目录读取失败」混进识别状态条，用户会看到
// 「正在识别：守备目录读取失败」这种句子。
//
// ── 为什么剔除发生在**这一层**，而不是在渲染层各自 if ─────────────────────────
// 渲染层各写一遍 = 三个组件各有一次漏判机会，且"漏了"的表现是**多渲染一张卡片**，
// 不报错、不崩、没有任何用例天然会红。收在一个纯函数里之后，R-F1 的执行有了唯一的
// 可测点：activityRouting.test.ts 的变异用例（把 identify 分支删掉）必然红。
import type { ScoutEvent, ScoutWorkbench } from '../events/types.js'

/** 一条事件的去处。**四态封闭**，与上面四条路一一对应。 */
export type EventLane =
  /** 字幕 tab。 */
  | 'subtitle'
  /** 翻译 tab。 */
  | 'translate'
  /** 顶部状态条的**识别**那一格（R-F1：不占 tab）。 */
  | 'identify'
  /** 顶部状态条的**巡检/扫描**那一格（无 workbench 的 6 个 emit 点）。 */
  | 'patrol'

/** 两个 tab 的 id。**只有两个**——这就是 R-F1 的类型级表达：
 *  想给识别开第三个 tab 的人得先改这个联合，而改它会让下面 TAB_LANES 与
 *  i18n 的穷尽映射一起报错，不可能"顺手加一个"。 */
export type ActivityTab = 'subtitle' | 'translate'

/** 两个 tab 的顺序（设计文档 §2.1「两个 tab：字幕 / 翻译」的字面顺序）。 */
export const ACTIVITY_TABS: readonly ActivityTab[] = ['subtitle', 'translate']

/**
 * 一条事件该去哪条路。**R-F1 的执行点**。
 *
 * 纯函数、无副作用、不看事件内容（只看 workbench）——刻意不去解析 `message` 文案：
 * 本仓栽过两次"日志文案与实际口径不符"，按文案分流就是把 UI 分流建在流沙上
 * （后端 scoutEvents.ts 头注释里「为什么显式 emit 而非解析日志」是同一条论证）。
 */
export function laneOf(event: Pick<ScoutEvent, 'workbench'>): EventLane {
  const wb: ScoutWorkbench | undefined = event.workbench
  // 🔴 无 workbench = 巡检级/扫描级。这一支**必须在最前**且不许有兜底默认值。
  if (wb === undefined) return 'patrol'
  // 🔴 R-F1：识别有值、且值是 identify → 顶部状态条，**绝不进两个 tab**。
  if (wb === 'identify') return 'identify'
  return wb
}

/**
 * 这条事件属于某个 tab 吗（属于就给出是哪个）。
 *
 * 🔴 **这是两个 tab 的唯一入口**：任何"要不要把这条事件画进 tab"的判断都必须走它，
 * 不许在组件里写 `event.workbench === 'subtitle'`（那样就有了第二处判据，
 * 而 R-F1 的执行会随着组件数量线性地多出漏判机会）。
 *
 * 返回 null = 这条事件不属于任何 tab（识别 / 巡检 / 扫描）。
 */
export function tabOf(event: Pick<ScoutEvent, 'workbench'>): ActivityTab | null {
  const lane = laneOf(event)
  return lane === 'subtitle' || lane === 'translate' ? lane : null
}

/** 从事件的 `data.workId` 取作品 id（后端 Task ⑨ 补的字段，见 daemonV2 那两处 emit）。
 *
 *  `data` 的类型是 `Record<string, unknown>`，故必须验型后再用：
 *  非字符串/空串一律 null，**不做 String() 强转**——把 undefined 转成 "undefined"
 *  再拿去查图表，会静默匹配不到并降级成无图，而排查时那个字符串会让人以为后端发了脏值。
 *
 *  返回 null 是**常态不是异常**：识别台的事件天然没有 workId（此刻还没有作品身份），
 *  旧版本后端发的事件也没有。调用方据此降级到纯排印卡片。 */
export function workIdOf(event: Pick<ScoutEvent, 'data'>): string | null {
  const v = event.data?.workId
  return typeof v === 'string' && v !== '' ? v : null
}
