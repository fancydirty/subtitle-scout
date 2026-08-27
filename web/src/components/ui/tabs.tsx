// web/src/components/ui/tabs.tsx：shadcn/ui Tabs（v4）copy-in，相对 import 适配。
import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils.js'

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-2', className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      // 窄屏溢出走 Material 的 scrollable tabs 口径（tabs.overflow.test.tsx 钉着）：
      // max-w-full + overflow-x-auto 横滚，末尾被裁一半的 tab 本身就是"还有更多"的暗示。
      // justify-start 而非 center：flex 居中 + 溢出会把左端裁到滚不回来；w-fit 下不溢出时
      // 列表宽度=内容宽度，两种 justify 视觉完全相同，所以这不是取舍而是白捡的正确。
      // 滚动条藏掉（两个引擎各一条），tab 条上出现滚动条比裁切更丑。
      className={cn(
        'inline-flex h-10 w-fit max-w-full items-center justify-start gap-1 overflow-x-auto rounded-control bg-stage-track p-1',
        '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // shrink-0 + whitespace-nowrap：trigger 永不被压缩折行（2026-08-27 实案：390px 下
        // 「字幕源」被压成每字一行的竖排）。溢出由 TabsList 的横滚承接，不在 trigger 层吸收。
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-[13px] font-medium leading-5 text-muted-foreground transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }