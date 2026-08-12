// web/src/shell/rootHealth.ts —— `/api/v2/health` 的 `roots[]` 折成**可渲染的两个名单**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 这个文件是链条的最后一跳（终局审计的 🔴-1）
// ══════════════════════════════════════════════════════════════════════════════
// 链条：Task ③ 建 `media_roots.last_error` + `last_checked_at`（daemonV2.scanOnce 的
// finally 单点收敛）→ Task ⑤ 用 `buildRootHealth` 折成三态 `ok` 出到 `/api/v2/health`
// → **此前前端一行都没读**。审计变异实测：把 server.ts 的 `roots: buildRootHealth(...)`
// 改成 `roots: []`，前端 1261 条用例 0 红——整套健康度记账在 API 边界断掉，
// 用户那边"守备目录挂载掉了"**界面上一处都不显示**。
//
// ── 渲染纪律：`ok` 是三态，`null` 必须画灰 ─────────────────────────────────
// 后端 `buildRootHealth` 的头注释点名了这条，`api/types.ts` 的 `HealthRootDTO.ok`
// 又抄了一遍：**绝不许 `?? true` 兜底**。三态的三种成因：
//   · `true`   新鲜且 last_error 为 null —— 这个根现在是好的
//   · `false`  新鲜且 last_error 非 null —— 这个根现在是坏的（R8 三道闸拦下了它）
//   · `null`   从没扫过 / 判决陈旧超 2 个巡检周期 —— **不知道**
// 写 `ok ?? true` 会把"刚加的根路径写错了"与"扫过且健康"折成同一个绿——那正是
// db.ts v41 那条迁移 entry 预言、buildRootHealth 专门绕开的坑，在前端原地复活。
// 写 `ok ?? false` 同样错（把"没扫过"报成"坏了"），两个方向都是拿中间量当结论量。
//
// ── 为什么折成两个名单，而不是把每个根逐行画出来 ──────────────────────────
// R-F9/R-F10：排障类不推给用户。逐行列出全部守备目录（含健康的那些）就是一个排障面板。
// 用户要的答案是"我的库是不是有问题"——健康的根**一个字都不该占屏**（沉默即好消息，
// 同 wb-perm-line 只在不许可时出现的既有口径）。故本函数只回答两件事：
//   ① 哪些根现在是坏的（要说，且要说是哪几个——用户得知道去修哪个挂载）
//   ② 哪些根状态未知（要说，但语气不同：这不是故障）
//
// ── 为什么**不透传 `lastError`** ──────────────────────────────────────────
// 那一列的原文形如 `守备目录读取失败，本轮跳过（已重试 2 次）: Error: EIO ...`——
// 带重试次数与 errno 的排障串（daemonV2.ts:1394 写入点）。把它贴到界面上就是把
// 日志文件搬到用户脸上，正是 R-F9/R-F10 否掉的那一类。路径本身足够定位（用户知道
// 自己挂了哪个目录），原因归日志。
// ⚠️ 另有一条硬理由：`ok === null`（陈旧）时 `lastError` **仍可能非 null**，
// 但它不是当前结论（后端注释点名）。一旦开始渲染它，"灰色未知"旁边就会挂着一句
// 红色的失败原文，两个通道自相矛盾。
import type { HealthRootDTO } from '../api/types.js'

/** 折出来的两个名单。**空数组 = 没有这一类**，调用方据此整段不渲染。
 *  刻意不给 `healthy: string[]`：没有任何 UI 该画健康的根（见文件头 §为什么折成两个名单），
 *  给了就一定有人拿去画。 */
export interface RootHealthSummary {
  /** `ok === false` 的根路径。**现在是坏的**——新鲜判决 + last_error 非 null。 */
  failed: string[]
  /** `ok === null` 的根路径。**不知道**——从没扫过，或判决已陈旧超 2 个巡检周期。 */
  unknown: string[]
}

/**
 * `roots[]` → 两个名单。纯映射，零判定。
 *
 * 🔴 三个分支**必须显式写全**，不许用 `if (ok) … else …` 两分支：
 * 两分支写法下 `null` 会掉进 else，与 `false` 合流——那就是把"不知道"报成"坏了"，
 * 与 `?? true` 是同一个错误的镜像。下面 `=== false` / `=== null` 两个恒等判定
 * 让第三种情况（`true`）**什么都不进**，这是唯一不会静默合流的写法。
 */
export function rootHealthSummary(roots: readonly HealthRootDTO[]): RootHealthSummary {
  const failed: string[] = []
  const unknown: string[] = []
  for (const r of roots) {
    if (r.ok === false) failed.push(r.path)
    else if (r.ok === null) unknown.push(r.path)
    // r.ok === true：健康的根不占屏（见文件头）。
  }
  return { failed, unknown }
}

/** 这份 summary 有没有话要说。两个名单都空 → 整段不渲染（沉默即好消息）。 */
export function hasRootHealthNote(s: RootHealthSummary): boolean {
  return s.failed.length > 0 || s.unknown.length > 0
}
