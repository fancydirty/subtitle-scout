// AI Elements queue 的 copy-in。官方 16 个导出这里只保留三个薄壳，逐条裁剪理由见 Plan C
// 任务 10 的表（要点：指示点用 Task 8 的 StatusDot 三档、动作位用 shadcn Button 常显文字钮、
// 分区不做可折叠——这三条都是"不改按钮的有无"这条铁律的直接后果）。
//
// QueueList 去掉了官方的 Radix ScrollArea：现网 Up next / Just finished 是全量列表，官方那层
// max-h-40（160px）内滚会把第三行往下的都裁进滚动条，属行为改动；且 Task 6 的依赖闭集里
// 没有 @radix-ui/react-scroll-area。
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils.js'

export type QueueProps = ComponentProps<'div'>

export const Queue = ({ className, ...props }: QueueProps) => (
  <div
    className={cn(
      // rounded-xl → rounded-card：两者都是 12px，只是按 copy-in 铁规③统一叫法。
      // bg-background 与页面底同色是有意的：这是"有边框的区域"，不是浮起来的卡片。
      'flex flex-col gap-2 rounded-card border border-border bg-background px-3 pt-2 pb-2 shadow-xs',
      className,
    )}
    {...props}
  />
)

export type QueueListProps = ComponentProps<'ul'>

// 官方源在 ScrollArea 上挂的是 `-mb-1 mt-2`：那个负下边距是给 ScrollArea 抵边距用的，
// 没有那层就不该留（留着会让区块底部少 4px）。
export const QueueList = ({ className, ...props }: QueueListProps) => (
  <ul className={cn('mt-2', className)} {...props} />
)

export type QueueItemProps = ComponentProps<'li'>

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li
    className={cn(
      // rounded-md 按铁规③保留（列表行既不是控件也不是弹层）；hover:bg-muted 里的
      // --color-muted 已经是 §5.1 表内的 token（#16181f），不用换。
      'group flex flex-col gap-1 rounded-md px-3 py-1 text-sm transition-colors hover:bg-muted',
      className,
    )}
    {...props}
  />
)
