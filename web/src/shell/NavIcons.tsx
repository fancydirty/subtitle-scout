// web/src/shell/NavIcons.tsx：侧边栏导航图标——极简点线风格（2026-08-06 用户选定）。
// 每个图标 18×18 视口，笔画 1.8px，圆点半径 1.5px，继承 currentColor 以跟随选中态色变。
// 设计原则：最少笔画 + 最多留白，呼应 DESIGN.md §3 简洁主义。
import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

/** 媒体库 — 抽屉格（矩形 + 两条分隔线） */
export function LibraryIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect x="4" y="5" width="10" height="9" rx="1" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 5 L7 8 M11 5 L11 8" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

/** 工作流 — 三节点流（圆点×3 + 连线×2） */
export function WorkflowIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="4" cy="9" r="1.5" fill="currentColor" />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
      <circle cx="14" cy="9" r="1.5" fill="currentColor" />
      <path d="M5.5 9 L7.5 9 M10.5 9 L12.5 9" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

/** 甄别 — 靶心（大圆 + 中心点） */
export function TriageIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="9" cy="9" r="1.5" fill="currentColor" />
    </svg>
  )
}

/** 设置 — 树形结构（顶点 + 两分支点 + 连线） */
export function SettingsIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="9" cy="5" r="1.5" fill="currentColor" />
      <circle cx="5" cy="13" r="1.5" fill="currentColor" />
      <circle cx="13" cy="13" r="1.5" fill="currentColor" />
      <path d="M9 6.5 L9 11 M7 11 L11 11" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

// ── Task ⑦ 新导航三项的图标（同上：18×18 视口、笔画 1.8px、圆点半径 1.5、currentColor）──
// 三个形都刻意与既有四个共用同一套语汇（点 + 直线，无曲线无填充面），这样四项排在一起
// 不会有哪一个显得"更重"。

/** 活动 — 进度条（一条底线 + 一段跑在上面的实线）。
 *  取"正在跑到哪儿了"的意象，对应活动页的 Steam 下载页定位；与工作流的三节点刻意不同形，
 *  两者共存期（workflow 路由还在）不会看混。 */
export function ActivityIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path d="M3 11.5 L15 11.5" stroke="currentColor" strokeWidth="1.8" opacity="0.4" />
      <path d="M3 11.5 L10 11.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="10" cy="6.5" r="1.5" fill="currentColor" />
    </svg>
  )
}

/** 通知 — 一条成果流水（三条渐次缩短的横线，最上一条带一个点）。
 *  刻意**不用铃铛**：铃铛是"外发通知系统"的符号，而 FRONTEND-SPEC §六·五 明确本页是
 *  站内成果流水、不做已读状态、没有任何外发渠道。用铃铛会承诺一个不存在的能力。 */
export function NotificationsIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <circle cx="4" cy="5" r="1.5" fill="currentColor" />
      <path d="M7.5 5 L15 5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 9.5 L13 9.5" stroke="currentColor" strokeWidth="1.8" opacity="0.55" />
      <path d="M4 14 L10 14" stroke="currentColor" strokeWidth="1.8" opacity="0.35" />
    </svg>
  )
}

/** 媒体库 — 集号格阵（2×3 方点阵，右下角缺一个）。
 *  缺的那一格就是媒体库页的核心语义"应有但磁盘上没有"（R-F5 虚线卡片）——图标本身就说明
 *  了这个页面回答什么问题。与旧 LibraryIcon（抽屉格）明显不同形，共存期不会看混。 */
export function MediaIcon(props: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect x="3" y="4" width="3.4" height="3.4" rx="0.8" fill="currentColor" />
      <rect x="7.8" y="4" width="3.4" height="3.4" rx="0.8" fill="currentColor" />
      <rect x="12.6" y="4" width="3.4" height="3.4" rx="0.8" fill="currentColor" />
      <rect x="3" y="9.6" width="3.4" height="3.4" rx="0.8" fill="currentColor" />
      <rect x="7.8" y="9.6" width="3.4" height="3.4" rx="0.8" fill="currentColor" />
      {/* 缺席格：虚线描边而非实心——"应有但没有"，与页面里的虚线卡片同一套语言。 */}
      <rect
        x="12.6"
        y="9.6"
        width="3.4"
        height="3.4"
        rx="0.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="1.6 1.4"
        opacity="0.6"
      />
    </svg>
  )
}
