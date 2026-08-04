// 自绘，取代 @astryxdesign/core 的 EmptyState。
// 排版逐条换算自 src/EmptyState/EmptyState.tsx 的 stylex.create 块：
//   container      flex-col items-center justify-center text-center gap-4 py-8 px-6
//   compact        gap-2 + p-4
//   textGroup      flex-col items-center max-w-[360px]
//   title          --text-large-size (16px) / semibold / leading 1.5 / 主文本色
//   titleCompact   --text-label-size  (13px)，行高不变
//   description    --text-body-size   (13px) / normal / leading 1.5385 / 次文本色
//   descCompact    --text-supporting-size (11px)，行高不变
//   actions        flex items-center gap-2 mt-1；compact 时改 flex-col
// ⚠️ 上面四个 px 值走的是 scout.css 覆盖后的阶梯（见本 task 开头那张表），不是 Astryx 源码注释里
// 的 17/14/14/12——那是 Astryx 自己默认主题的值，本仓不用。
// 行高写成无单位任意值（leading-[1.5] 等）而不是让 Tailwind 用每个字号的默认行高：compact 只换字号
// 不换行高，靠默认行高会在 11px 档偏出 ~1px（Tailwind text-[11px] 会拿 16px 默认行高，
// 而这里要的是 11 × 1.5385 ≈ 16.9px）。
//
// 与 Astryx 的两处有意差异：
// 1. 丢掉 icon / headingLevel 两个 prop（全仓 9 个调用点零使用）。
// 2. description 用 <div> 不用 <p>（Astryx 的 Banner 文件头对同一问题有说明）：<p> 不能合法
//    包块级子节点，解析器会把它拆开。primitives.test.tsx 把这条锁成回归用例。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function EmptyState({
  title,
  description,
  isCompact = false,
  actions,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  title: string
  description?: React.ReactNode
  isCompact?: boolean
  actions?: React.ReactNode
}) {
  return (
    <div
      data-slot="empty-state"
      role="status"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        isCompact ? 'gap-2 p-4' : 'gap-4 px-6 py-8',
        className,
      )}
      {...props}
    >
      <div className="flex max-w-[360px] flex-col items-center">
        <h3
          className={cn(
            'm-0 font-semibold leading-[1.5] text-foreground',
            isCompact ? 'text-[13px]' : 'text-[16px]',
          )}
        >
          {title}
        </h3>
        {description != null && (
          <div
            className={cn(
              'm-0 font-normal leading-[1.5385] text-muted-foreground',
              isCompact ? 'text-[11px]' : 'text-[13px]',
            )}
          >
            {description}
          </div>
        )}
      </div>
      {actions != null && (
        <div className={cn('mt-1 flex items-center gap-2', isCompact && 'flex-col')}>{actions}</div>
      )}
    </div>
  )
}

export { EmptyState }
