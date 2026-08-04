// 自绘，取代 @astryxdesign/core 的 Divider（src/Divider/Divider.tsx）。
// 逐字保留：role="separator" + aria-orientation。
// 丢掉 subtle/strong 变体：全仓唯一调用点（RunDetail.tsx:87）零 prop，
// 用的就是 subtle（--color-border）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Separator({
  orientation = 'horizontal',
  className,
  ...props
}: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }) {
  return (
    <div
      data-slot="separator"
      role="separator"
      aria-orientation={orientation}
      className={cn(
        'shrink-0 bg-border',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  )
}

export { Separator }
