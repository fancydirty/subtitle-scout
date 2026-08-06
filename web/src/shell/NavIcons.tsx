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
