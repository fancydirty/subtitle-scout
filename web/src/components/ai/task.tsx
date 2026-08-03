// AI Elements task 的 copy-in——§5.5 Triage 分区卡的折叠底座。偏离三处（删 SearchIcon、
// border-muted → border-border、不抄 TaskItem/TaskItemFile），逐条理由见 Plan C 任务 11。
// 接线在 Task 22-24：谁当触发器、默认开合，那里对着 PendingBox.tsx 现状定。
import type { ComponentProps } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js'
import { cn } from '../../lib/utils.js'

export type TaskProps = ComponentProps<typeof Collapsible>

export const Task = ({ defaultOpen = true, className, ...props }: TaskProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
)

export type TaskTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string
}

export const TaskTrigger = ({ children, className, title, ...props }: TaskTriggerProps) => (
  // `group` 是 chevron 那个 group-data-[state=open]:rotate-180 的锚，别删。
  <CollapsibleTrigger asChild className={cn('group', className)} {...props}>
    {children ?? (
      // 官方源这里还有一个 <SearchIcon />：删掉——放大镜宣称一个"搜索"动作，而这是分组区头。
      <div className="flex w-full cursor-pointer items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground">
        <p className="text-sm">{title}</p>
        <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </div>
    )}
  </CollapsibleTrigger>
)

export type TaskContentProps = ComponentProps<typeof CollapsibleContent>

export const TaskContent = ({ children, className, ...props }: TaskContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  >
    {/* 官方源这条左竖线是 border-muted：那是浅色主题下的可见浅灰，本仓 --color-muted 是
        #16181f，画在 #0b0c0f 页底上几乎不可见。--color-border 才是 §5.1 派给分隔线的 token。 */}
    <div className="mt-4 space-y-2 border-border border-l-2 pl-4">{children}</div>
  </CollapsibleContent>
)
