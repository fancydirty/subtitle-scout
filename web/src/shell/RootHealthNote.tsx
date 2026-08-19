// web/src/shell/RootHealthNote.tsx —— 守备目录健康度的**可见形态**（终局审计 🔴-1）。
//
// 这是 `media_roots.last_error` / `last_checked_at` 那条链的终点：
//   daemonV2.scanOnce 的 finally 单点收敛（写）
//     → buildRootHealth 折成三态 `ok`（Task ⑤）
//       → GET /api/v2/health 的 `roots[]`
//         → rootHealthSummary 折成两个名单
//           → **本组件**（第一个真正把它画出来的地方）
//
// ── 它回答的问题：「我的库是不是有问题」──────────────────────────────────
// **不是**排障面板（R-F9/R-F10：排障类一律不推给用户）。三条纪律的执行：
//  ① 健康的根**一个字都不占屏**——沉默即好消息（同 wb-perm-line 只在不许可时出现）。
//     全量列出守备目录会把这里变成一个"系统状态页"，那正是被否掉的形态。
//  ② **不透传 `lastError`**——那一列是带 errno 与重试次数的排障串
//     （`守备目录读取失败，本轮跳过（已重试 2 次）: Error: EIO …`）。原因归日志，
//     界面只说"目录可能不可用或为空，媒体库可能不是最新的"——同时覆盖读取失败与零媒体保护。
//  ③ 不弹窗、不 role="alert"、不给按钮。这条提示对应的动作在**用户的机器上**
//     （去把挂载修好），界面上没有任何按钮能替他做，画一个只会是打不通的按钮。
//
// ── 三态怎么画（`null` 必须灰）─────────────────────────────────────────────
// 两条独立的行，措辞与视觉都刻意不同——因为它们是**两件不同的事**：
//   `ok === false` → 「不可用或为空」。这是坏消息，走 amber（同 wb_inspect_stale 那一档）。
//   `ok === null`  → 「还没检查过 / 判决已陈旧」。这**不是**故障，走 muted 灰。
//                    绝不许 `?? true` 折成绿（后端 buildRootHealth 与 api/types.ts
//                    两处头注释都点名了这条），也不许 `?? false` 折成红。
// 折叠判据在 rootHealth.ts 的 `rootHealthSummary`（三分支恒等判定，不用 if/else）。
//
// ── Carbon 双通道（R-F11 拒绝投影）────────────────────────────────────────
// ① 文字自己把话说全——去掉全部 CSS 之后信息量一个字都不少，这是主通道；
// ② 形状：**方块**，实心=读不到 / 空心=未知。
//    🔴 刻意用方块而不是圆点：活动页状态条里已经有两个圆点（实心=巡检态、
//    空心=实时读数过期）。再加一对圆点会让四个语义共用两种形状，用户与色觉障碍者
//    都分不出哪个圆点说的是哪件事。方块 vs 圆点是真实的形状差异。
// ③ 颜色只是第三重。
import { useT } from '../i18n/useT.js'
import { rootHealthSummary, hasRootHealthNote } from './rootHealth.js'
import type { HealthRootDTO } from '../api/types.js'

/** 一条名单行。`kind` 同时决定文案、颜色与方块的实心/空心。 */
function RootLine({ kind, paths, label }: { kind: 'failed' | 'unknown'; paths: string[]; label: string }) {
  return (
    // role="status" + aria-live="polite"：这是一条**背景事实**，不是对用户操作的回应，
    // 也不是需要抢读的故障（role="alert" 留给真正打断用户的东西）。
    <span
      className="root-health-line"
      data-kind={kind}
      data-testid={`root-health-${kind}`}
      role="status"
      aria-live="polite"
    >
      <span className={`root-health-mark${kind === 'unknown' ? ' root-health-mark-hollow' : ''}`} aria-hidden="true" />
      {' '}
      {label}
      {': '}
      {/* 路径走 mono——同顶栏新鲜度行与媒体库卡片那套"技术性读数"的排印语言。
          路径**必须列出来**：用户有好几个守备目录时，"有目录读不到"而不说是哪个
          等于让他挨个去猜。这不是排障细节，这是这条提示唯一可操作的部分。 */}
      <span className="root-health-paths">{paths.join(', ')}</span>
    </span>
  )
}

/**
 * 守备目录健康度提示。**两个名单都空 → 返回 null（整段不渲染）**。
 *
 * `roots` 为 undefined/null（/health 还没回来，或这一页没拿到）时同样返回 null：
 * 不知道就不说话，绝不因为"没拿到"而报一句"一切正常"（那是 fail-open 报绿，
 * 正是这整条链要防的那句假话）。
 */
export function RootHealthNote({ roots }: { roots: readonly HealthRootDTO[] | null | undefined }) {
  const { t } = useT()
  if (!roots) return null
  const summary = rootHealthSummary(roots)
  if (!hasRootHealthNote(summary)) return null
  return (
    <>
      {summary.failed.length > 0 && (
        <RootLine kind="failed" paths={summary.failed} label={t('root_health_failed')} />
      )}
      {summary.unknown.length > 0 && (
        <RootLine kind="unknown" paths={summary.unknown} label={t('root_health_unknown')} />
      )}
    </>
  )
}
