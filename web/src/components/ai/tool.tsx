// AI Elements tool 的 copy-in——RunDetail 的痕迹回放卡（spec §5.2：名称/入参/结果/错误位）。
//
// 官方源第一行 import 的 `ToolUIPart`（`ai` 包，Vercel AI SDK）本仓没装也不会装（§5.2 不装
// 清单）。那个类型描述的是聊天里的一次工具调用；本仓的产出方是 TraceEvent
// （web/src/api/types.ts:144-152，七键封闭）。所以 state 收成两态、input/output 收成 string、
// CodeBlock 换 <pre>、错误分支去红——九条偏离逐条记在 Plan C 任务 11。
// 接线在 Task 12-18（RunDetail 回放），本任务不改任何屏。
import type { ComponentProps } from 'react'
import { CheckCircleIcon, ChevronDownIcon, ClockIcon, WrenchIcon } from 'lucide-react'
import { Badge } from '../ui/badge.js'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.js'
import { cn } from '../../lib/utils.js'

/** 只有这两态有真实产出方：回放里每条 TraceEvent 都是已完成事件，直播尾巴那一行是"仍在跑"。 */
export type ToolState = 'running' | 'completed'

/** 两个词逐字取自官方源的 labels 表（input-available / output-available 两项）。 */
const STATE_LABELS: Record<ToolState, string> = {
  running: 'Running',
  completed: 'Completed',
}

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  // 官方源是 `not-prose mb-4 w-full rounded-md border`。not-prose 删（本仓不装
  // @tailwindcss/typography，无对应规则）；rounded-md → rounded-card（§5.1 圆角表：卡 12px）。
  // 裸 border 的颜色来自 tw.css 的 @layer base 全局 border-color，不用补 border-border。
  // 注意：官方源**不给** Tool 设 defaultOpen（与 Task 相反），默认是收起的。
  <Collapsible className={cn('mb-4 w-full rounded-card border', className)} {...props} />
)

export type ToolHeaderProps = {
  /** TraceEvent.tool——**原始工具名**。不要在这里套 toolPhrase：回放路径显示技术值
   *  （见 TraceRows.tsx 文件头与 i18n §7）。commit d5988e0 修的"裸工具名上界面"是活动页
   *  传送带那条 phraseMode 路径，不是这一条。 */
  title: string
  state: ToolState
  className?: string
}

export const ToolHeader = ({ className, title, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger
    // `group` 是官方源漏掉的一个 class：chevron 的 group-data-[state=open]:rotate-180 在官方
    // 源里因此是死的（他们在 task.tsx 里记得加）。补在这里——Radix 会给触发器挂 data-state。
    className={cn('group flex w-full items-center justify-between gap-4 p-3', className)}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-4 text-muted-foreground" />
      <span className="font-medium text-sm">{title}</span>
      <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
        {state === 'running' ? (
          <ClockIcon className="size-4 animate-pulse" />
        ) : (
          // 官方源这里是 text-green-600（裸调色板，违 copy-in 铁规④）。
          <CheckCircleIcon className="size-4 text-fn-green" />
        )}
        {STATE_LABELS[state]}
      </Badge>
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
)

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
)

// 官方源这两块用的是 <CodeBlock language="json">：spec §5.2 的不装清单点名不装 code-block
// （它拉 shiki 一族重依赖），而现网 RunDetail 的 detail 本来就是 mono 块，<pre> 与现状同形。
const BLOCK_CLASS = 'overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-xs text-foreground'
const HEADING_CLASS = 'font-medium text-muted-foreground text-xs uppercase tracking-wide'

export type ToolInputProps = ComponentProps<'div'> & {
  /** TraceEvent.argsSummary——已经是给人看的摘要串，不要再 JSON.stringify（会套引号并转义）。 */
  input: string
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden p-4', className)} {...props}>
    <h4 className={HEADING_CLASS}>Parameters</h4>
    <pre className={BLOCK_CLASS}>{input}</pre>
  </div>
)

export type ToolOutputProps = ComponentProps<'div'> & {
  /** TraceEvent.resultSummary，允许空串。 */
  output: string
  /** 目前恒为 null——TraceEvent 没有 error 字段。留位不留假数据，见 Plan C 任务 11。 */
  errorText: string | null
}

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  // 双空短路照抄不动：resultSummary 允许是空串，这一句是"别渲染一个只有 Result 标题的空块"
  // 的唯一闸门。
  if (!(output || errorText)) {
    return null
  }

  return (
    <div className={cn('space-y-2 p-4', className)} {...props}>
      <h4 className={HEADING_CLASS}>{errorText ? 'Error' : 'Result'}</h4>
      {/* 官方源给错误分支的是 bg-destructive/10 text-destructive，且 errorText 与 output 两块
          都渲染。draft-6 铁律1 写死"卡片底色/边框/banner 一律不红"，红只留给卡死点与那一句红字
          事实句——所以错误与结果同底，区别只在标题词；标题已经是 Error 了，就不再挂 Result 内容。 */}
      <pre className={BLOCK_CLASS}>{errorText ?? output}</pre>
    </div>
  )
}
