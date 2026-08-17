import type { Lang } from '../i18n/useT.js'

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

/** 给普通用户看的相对时间：中文用「8 小时前」，英文沿用短单位技术读数。 */
export function relAgoLabel(deltaMs: number, lang: Lang): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (lang !== 'zh') return relAgo(s * 1000)
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 相对时间的「后」方向（倒计时）。粒度同 relAgoLabel；delta<=0 返回空串，
 *  「即将开始」由 StatusBar 用 `wb_inspect_soon`，避免两处各写一句。 */
export function relUntilLabel(deltaMs: number, lang: Lang): string {
  if (deltaMs <= 0) return ''
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (lang !== 'zh') return relAgo(s * 1000)
  if (s < 60) return `约 ${s} 秒后`
  const m = Math.floor(s / 60)
  if (m < 60) return `约 ${m} 分钟后`
  const h = Math.floor(m / 60)
  if (h < 24) return `约 ${h} 小时后`
  return `约 ${Math.floor(h / 24)} 天后`
}

/** 距下次自动检查还有多久。优先后端 `nextInspectAt`；缺席时才回落 lastInspectAt + 周期
 *  （那份 24h 已经在本文件，不在 ActivityPage 再抄第三份）。 */
export function msUntilNextInspect(
  health: { nextInspectAt?: number | null; lastInspectAt: number | null },
  now: number,
): number {
  const due = health.nextInspectAt != null
    ? health.nextInspectAt
    : (health.lastInspectAt !== null ? health.lastInspectAt + INSPECT_INTERVAL_MS : now)
  return Math.max(0, due - now)
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

// ══════════════════════════════════════════════════════════════════════════════
// 🟡 读数的**新鲜度**——「你现在看到的这些数字，还是活的吗」
// ══════════════════════════════════════════════════════════════════════════════
// 上面两个判决读的都是 /health 的内容；这一个读的是**实时通道本身的电平**。
// 它与 `'stale'`（daemon 可能没在跑）是同一类判决的两半：
//   · stale       → 后端可能歇了，而我们连着
//   · 下面这个    → 后端可能在跑，而我们**听不见**
// 两半都不是排障（R-F9/R-F10 的裁决是排障类一律不推给用户），都是**诚实性**：
// 用户看着一句「正在处理 X」时，有权知道这句话是刚刚听来的还是很久以前的。
//
// 🔴 为什么必须读**电平**而不是边沿：`useEventsStatus` 全仓只有活动页与通知页在用，
// 两个页面都只用了它的边沿（"恢复了 → 拉一次"）。边沿的处置是"重连后纠正"——
// 而 `unavailable` 是 503 终态，eventsBus.ts:262 明写一次都不会再重连，那条纠正
// **根本不会被触发**；`retrying` 则可能退避任意久。这两段时间里屏幕上挂着的那句
// 「正在处理 X」是一句没人负责的谎话，而边沿判据在结构上就看不见它。
//
// ⚠️ 这个函数**只看连接状态，不看时间**。刻意的：挂一个"断了多少秒才提示"的阈值
// 等于在断线期间开一个定时器，而"读数是不是活的"在断开的那一刻就已经确定了。
// 抖动（掉一下立刻回来）的代价是提示条闪一下——远好于一句谎话挂几十分钟。

/** 实时读数的新鲜度。**三态**，对应三句能说给用户听的不同的话。 */
export type LiveFreshness =
  /** 通道通着（`open`），或还在首连（`connecting`——那一刻页面本来就在等首份数据，
   *  此时喊"可能过期"是把冷启动误报成故障，与 inspectFreshness 里
   *  「never 不许算成 56 年的陈旧」是同一条纪律）。 */
  | 'live'
  /** 掉线了，正在退避重连。**自己会好**——不要求用户做任何事。 */
  | 'retrying'
  /** 终态：端点 503（没跑 watch），eventsBus 一次都不会再重连。
   *  🔴 与 retrying 必须分开：**只有刷新页面才可能变**，不明说的话用户会盯着一个
   *  永远不动的界面等一个永远不会来的更新。 */
  | 'off'

/**
 * 连接状态 → 读数新鲜度。
 *
 * 入参故意用结构类型而不是 import EventsStatus：本模块是纯判决，
 * 不该为一个四态字符串反向依赖 events/ 那一层（events/ 已经依赖 workbench 的对侧了）。
 */
export function liveFreshness(status: 'connecting' | 'open' | 'unavailable' | 'retrying'): LiveFreshness {
  switch (status) {
    case 'open':        return 'live'
    // 首连中：页面正在等第一份数据，屏幕上还没有任何**旧**读数可言。
    // 说"可能过期"是无中生有——冷启动不是故障。
    case 'connecting':  return 'live'
    case 'retrying':    return 'retrying'
    case 'unavailable': return 'off'
    default: {
      // 编译期穷尽：EventsStatus 加了新成员，这里会报错，逼人当场定夺它算不算"活的"。
      const exhaustive: never = status
      void exhaustive
      // 运行时兜底取**最保守**的那一档（不是 'live'）：不认得的状态下，
      // 宁可多说一句"可能过期"，也不要替一个我们不理解的连接状态打包票。
      return 'retrying'
    }
  }
}

