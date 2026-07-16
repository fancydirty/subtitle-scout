// web/src/workflow/PassCard.tsx：中泳道——单条 orchestrator pass 卡（DESIGN.md §6："中=
// orchestrator passes"）。时间相对 mono + detail 一行截断 + receipts 分布 chip 排（非零才
// 显示，见 text.ts receiptChips 的既有口径）。点开交给 Lanes.tsx 的 RunDetail 右侧板。
import { relativeAgo } from './time.js'
import { truncate, receiptChips } from './text.js'
import type { WorkflowPassDTO } from '../api/types.js'

interface Props {
  pass: WorkflowPassDTO
  now: number
  onOpen: (pass: WorkflowPassDTO) => void
}

export function PassCard({ pass, now, onOpen }: Props) {
  const chips = receiptChips(pass.receipts)
  const at = pass.finishedAt ?? pass.startedAt

  return (
    <button type="button" className="wf-pass-card" onClick={() => onOpen(pass)}>
      <span className="wf-pass-time">{relativeAgo(now - at)}</span>
      {pass.detail ? <span className="wf-pass-detail">{truncate(pass.detail, 100)}</span> : null}
      {chips.length > 0 ? (
        <span className="wf-chip-row">
          {chips.map((c) => (
            <span className="wf-chip" key={c}>
              {c}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  )
}
