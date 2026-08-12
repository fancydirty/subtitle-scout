// web/src/workbench/inspectFreshness.ts —— 活动页顶部状态条的**时间判决**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 本文件处理任务书点名的两条既有债务。两条都是**后端未修**，前端必须自己扛。
// ══════════════════════════════════════════════════════════════════════════════
//
// ── 债务一：`lastInspectAt` 落的是巡检的**开始**时刻，不是完成时刻 ─────────────
// （Task ⑤ 审计 🟡-3，后端未修。api/types.ts 的 HealthDTO 字段注释也记着这条。）
//
// 大库实测能跑 10h：04:00 开始、14:00 结束。13:00 读到的是"9 小时前"，而此刻
// **正在巡检中**。把它渲染成「上次巡检于 9 小时前」是在说一句半真的话——用户会以为
// 系统闲着，实际它正忙。
//
// 处置：**永不单独渲染这个时刻**。它只在与 `current`（当前在处理谁）合取之后才有意义：
//   · current 非 null  → 说「正在巡检」，那个时刻是**本轮开始于**，不是"上次"
//   · current 为 null  → 才可以说「上次巡检开始于 X 前」
// 注意即便在第二支里，文案也是「**开始于**」而不是「完成于」——我们确实不知道它何时完成，
// 编一个"完成"出来就是本仓的病 B（把中间量说成结论量）。
//
// ── 债务二：陈旧门覆盖不到"daemon 死了"，横幅会报绿 48h ──────────────────────
// （任务书点名。）`/health` 的 `roots[].ok` 陈旧门是 `2 × INSPECT_INTERVAL_MS = 48h`，
// 而且它衡量的是 `media_roots.last_checked_at`——那是**扫描**写的。容器挂了之后
// 没有任何人再写这一列，于是"最后一次成功扫描"的时间戳被冻在那里，48 小时之内
// 它一直落在容差内、一直报 `ok: true`，横幅一路绿灯。
//
// `lastInspectAt` 本可提供这个信号（daemon 活着就会周期性推进它），但后端**没有把它
// 折进任何判决**。故这里自己算 `now - lastInspectAt`：
//   · 超过 `STALE_AFTER_MS`（= 1.5 个巡检周期）且当前没有任何工作台在跑
//     → 判定 `'stale'`，状态条说「daemon 可能没在跑」并给出实际间隔。
//
// 🔴 为什么阈值是 1.5 个周期而不是 1 个：巡检**本身**要跑几小时（见债务一），
// 而 lastInspectAt 记的是开始时刻。取 1 个周期会让"昨天 04:00 开始、今天 04:00 还没
// 轮到下一轮"这种完全正常的节奏被误报成死亡。取 2 个周期（48h）则与那个报绿的陈旧门
// 一样迟钝，等于没修。1.5 是"确实晚了半个周期"的最早可辩护点。
//
// 🔴 为什么要合取「当前没有工作台在跑」：正在跑 10 小时大库的那台机器，
// lastInspectAt 就是会很旧——它旧得**有正当理由**。此时报"daemon 可能没在跑"
// 是把最忙的时刻误判成死亡，正是债务一那句半真的话的镜像版。

/** 巡检周期。**与后端 INSPECT_INTERVAL_MS 同值，但这是手抄的第二份**——
 *  web/ 是独立 tsconfig 工程，跨出去 import 会把 node 侧类型面拖进来（同 api/types.ts
 *  与 events/types.ts 全文件的既有处置）。
 *
 *  ⚠️ 手抄的代价如实记在这里：后端把巡检周期改成别的值，这里不会报错，只会让
 *  "daemon 可能没在跑"的阈值悄悄偏离。缓解是它**只影响一句提示文案的出现时机**，
 *  不参与任何判决与写操作——把 24h 抄错成 12h 的后果是提示早出现半天，不是数据错误。 */
const INSPECT_INTERVAL_MS = 24 * 60 * 60 * 1000

/** 超过这么久没开新一轮巡检 → 疑似 daemon 没在跑。见文件头「为什么是 1.5 个周期」。 */
export const STALE_AFTER_MS = 1.5 * INSPECT_INTERVAL_MS

/** 巡检的时间态。**四态**，每一态对应一句能说给用户听的不同的话。 */
export type InspectPhase =
  /** 从没跑完过一轮（全新部署 / `meta.last_inspect_at` 还没写过）。
   *  ⚠️ 这是真实存在的常态，不是边缘：设计文档 §3.5 点名要求前端把它当**冷启动**处理，
   *  绝不能渲染成「上次巡检：1970-01-01」。 */
  | 'never'
  /** 有工作台在跑 → **正在巡检**。此时那个时刻是"本轮开始于"。 */
  | 'running'
  /** 跑过、当前空闲、且间隔正常 → 歇着等下一轮。 */
  | 'idle'
  /** 跑过、当前空闲、但已经太久没开新一轮 → **疑似 daemon 没在跑**（债务二）。 */
  | 'stale'

export interface InspectFreshness {
  phase: InspectPhase
  /** 距 `lastInspectAt` 多久（毫秒）。`never` 时为 null。
   *  🔴 语义是「距**本轮/上轮开始**多久」，**不是**"距完成多久"（债务一）。
   *  字段名带 SinceStart 就是为了让读到它的人不可能把它当成完成时刻。 */
  msSinceStart: number | null
}

/**
 * 算出巡检的时间态。
 *
 * `current` 只用它**是不是 null**（有没有工作台在跑），不看里面是哪个台——
 * 识别台在跑同样意味着 daemon 活着，而 R-F1 只管"识别不进 tab"，不管"识别算不算活着"。
 *
 * 时钟从参数进：这是本模块唯一的时间依赖，不注入就测不了阈值边界。
 */
export function inspectFreshness(
  health: { lastInspectAt: number | null; current: unknown | null },
  now: number,
): InspectFreshness {
  const at = health.lastInspectAt
  // 冷启动：从没跑完过一轮。**不许**回落成 0 再去算差值——那会算出 56 年的"陈旧"，
  // 然后把全新部署报成"daemon 死了"。
  if (at === null) return { phase: 'never', msSinceStart: null }

  const msSinceStart = now - at

  // 有工作台在跑 → 正在巡检（债务一：此时那个时刻是"本轮开始于"）。
  // 这一支**必须在陈旧判定之前**：跑 10 小时大库时 lastInspectAt 就是会很旧，
  // 而那是最不该报"没在跑"的时刻。
  if (health.current !== null) return { phase: 'running', msSinceStart }

  // 空闲 + 太久没开新一轮 → 疑似死了（债务二：这一档是陈旧门覆盖不到的那个）。
  if (msSinceStart > STALE_AFTER_MS) return { phase: 'stale', msSinceStart }

  return { phase: 'idle', msSinceStart }
}

/** 毫秒差 → 短促相对时长（s/m/h/d）。
 *  逐字照 shell/freshness.ts 的 relAgo——那是顶栏新鲜度行的既有粒度，
 *  两处显示同一类"技术性读数"却用不同粒度会让用户以为它们说的是两回事。
 *
 *  ⚠️ 负数（时钟回拨 / 后端时刻在未来）夹到 0：显示 "-3h ago" 只会让人以为界面坏了。 */
export function relAgo(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** 引擎为什么不干活——**三态**，对应 /health 那三个布尔的三种组合。
 *
 *  🔴 为什么读 `workPermitted` 而不是 `engineEnabled`（任务书要我论证的那条）：
 *  `engineEnabled` 只是用户那个总开关；`workPermitted = engineEnabled && setupSatisfied`
 *  是**daemon 到底会不会干活**（后端同源计算，与 daemon 派活调的是同一个函数）。
 *  只看 engineEnabled 会在"开关开着但 TMDB/LLM 凭据没配好"时说"引擎在跑"，
 *  而 daemon 其实整轮跳过——那正是"为什么什么都没发生"这个问题最常见的答案。
 *
 *  拆成三态而不是一个布尔，是因为两种不许可的**可执行动作完全不同**：
 *  开关关了 → 去打开它；凭据没配 → 去 setup 页填 key。合成一个字段这两者不可区分。 */
export type WorkPermission = 'permitted' | 'engine-off' | 'setup-incomplete'

export function workPermission(
  health: { workPermitted: boolean; engineEnabled: boolean; setupSatisfied: boolean },
): WorkPermission {
  if (health.workPermitted) return 'permitted'
  // 顺序：先报凭据缺失。两个都不满足时，先让用户去填 key——把开关打开而凭据仍缺
  // 依然什么都不会发生，那会是第二次徒劳。
  if (!health.setupSatisfied) return 'setup-incomplete'
  return 'engine-off'
}
