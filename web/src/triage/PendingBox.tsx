// web/src/triage/PendingBox.tsx：待甄别箱——按目录分组渲染 park 救援清单。组头=目录尾段 mono +
// 文件计数 + 首末行（First seen…/last attempt…），组体=文件名只读列表（>5 折叠），末尾命名指引。
// 目录组卡用 AI Elements 的 Task 折叠件（组头作 TaskTrigger children，chevron 是折叠的唯一可视
// affordance）。Claim 按钮/duplicates 桶均已退役（见既有头注释历史，语义不变）。
import { useState } from 'react'
import { Task, TaskTrigger, TaskContent } from '../components/ai/task.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { ChevronDownIcon } from 'lucide-react'
import { useT } from '../i18n/useT.js'
import { pathTail, fileCountLabel, moreLabel, groupParkTimeLine, type DirGroup } from './text.js'

// 命名最佳实践路径样例——技术值，mono 且不翻译（DESIGN.md §3/§7），两种语言下原样出现。
const NAMING_PATTERN = 'Title (Year)/Season NN/Title SNNENN.mkv'
const FILES_COLLAPSE_AT = 5

function DirGroupCard({ group }: { group: DirGroup }) {
  const { lang } = useT()
  const now = Date.now()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? group.files : group.files.slice(0, FILES_COLLAPSE_AT)
  const hidden = group.files.length - visible.length

  return (
    <div className="triage-dirgroup">
      <Task defaultOpen>
        <TaskTrigger>
          {/* 原生 button——Radix Slot 只合并 onClick/aria-expanded/data-state，不给 div 补
              role/tabIndex/keydown（Task 11 评审实证）；div 触发器键盘不可达。
              w-full text-left font-[inherit] bg-transparent border-0 抵掉按钮默认样式。
              data-state 落在这个 button 上（它就是触发器），group 锚住 chevron 的
              group-data-[state=open]:rotate-180。 */}
          <button type="button" className="group flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-2">
            <span className="triage-dirgroup-tail" title={group.dir}>
              {group.dirTail}
            </span>
            <span className="font-mono text-[13px] leading-5 text-muted-foreground">
              {fileCountLabel(group.files.length, lang)}
            </span>
            <span className="text-[11px] leading-4 text-muted-foreground">
              {groupParkTimeLine(group, now, lang)}
            </span>
            <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </button>
        </TaskTrigger>
        <TaskContent>
          <div className="triage-dirgroup-files">
            {visible.map((f) => (
              <span key={f.path} className="triage-dirgroup-file" title={f.path}>
                {pathTail(f.path)}
              </span>
            ))}
            {hidden > 0 ? (
              <button type="button" className="triage-dialog-more" onClick={() => setExpanded(true)}>
                {moreLabel(hidden, lang)}
              </button>
            ) : null}
          </div>
        </TaskContent>
      </Task>
    </div>
  )
}

interface Props {
  /** 待识别的目录组（已由 TriagePage 通过 groupPending 分桶）。 */
  actionable: DirGroup[]
}

export function PendingBox({ actionable }: Props) {
  const { t } = useT()
  const actionableCount = actionable.reduce((n, g) => n + g.files.length, 0)

  return (
    <div className="triage-box">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium leading-5 text-foreground">{t('triage_pending_heading')}</span>
          <span className="font-mono text-[13px] leading-5 text-muted-foreground">{actionableCount}</span>
        </div>

        {actionable.length === 0 ? (
          <EmptyState isCompact title={t('triage_empty_title')} description={t('triage_empty_desc')} />
        ) : (
          <div className="triage-actionable-groups">
            <div className="flex flex-col gap-2">
              {actionable.map((group) => (
                <DirGroupCard key={group.dir} group={group} />
              ))}
            </div>
          </div>
        )}

        <div className="triage-naming-hint">
          {t('triage_naming_hint_prefix')}
          <code className="triage-naming-hint-code">{NAMING_PATTERN}</code>
        </div>
      </div>
    </div>
  )
}
