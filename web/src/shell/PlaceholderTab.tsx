// web/src/shell/PlaceholderTab.tsx：F2 阶段四 tab 的统一 Empty 态占位，F3-F6 逐个换成真内容。
// 衬线全站只允许出现一次（真正的 Empty 态留着用）——这四块占位故意不用衬线，见 EmptyState
// 默认排版（DESIGN.md §3/§4，任务说明也建议"都不用，留给真 Empty 态"）。
import { EmptyState } from '@astryxdesign/core/EmptyState'

interface Props {
  title: string
  description: string
}

export function PlaceholderTab({ title, description }: Props) {
  return <EmptyState title={title} description={description} />
}
