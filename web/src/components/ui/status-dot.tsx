// 自绘，取代 @astryxdesign/core 的 StatusDot（src/StatusDot/StatusDot.tsx）。
// 逐字保留的：8×8px、正圆、flex-shrink:0。
// 三档色改用 spec §5.1 的功能色（Astryx 的变体色表是它自己主题的，随主题一起退役）：
//   success → --color-fn-green (#28bf5c)
//   error   → --color-fn-red   (#e11d48)
//   neutral → --color-weak     (#6b7280)  ← §5.1"弱文本"，即 Just finished 灰点那一档
// 丢掉 Astryx 的 isPulsing（全仓零使用；hero 紫点的 1.6s 脉动是 .act-* 自绘 CSS）。
//
// 无障碍：不传 label 时整体 aria-hidden。本仓三个调用点的点都紧挨着一段说明文字
// （"Deployed" / "Idle" / 决策短语），再给点配一个 aria-label 只会让读屏器把状态念两遍。
// 传了 label 才升级成 role="img"（预留给"点是唯一状态载体"的将来场景）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

const STATUS_DOT_COLORS = {
  success: 'bg-fn-green',
  error: 'bg-fn-red',
  neutral: 'bg-weak',
} as const

export type StatusDotVariant = keyof typeof STATUS_DOT_COLORS

function StatusDot({
  variant,
  label,
  className,
  ...props
}: React.ComponentProps<'span'> & { variant: StatusDotVariant; label?: string }) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true }
  return (
    <span
      data-slot="status-dot"
      className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_DOT_COLORS[variant], className)}
      {...a11y}
      {...props}
    />
  )
}

export { StatusDot }
