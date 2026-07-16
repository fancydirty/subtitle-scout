// web/src/workflow/WorkerCard.tsx：右泳道上半——在跑 worker 卡（DESIGN.md §6："右=workers
// 直播"）。头行 mono："{taskType} · {target}[S{seasons}]"（text.ts workerHeaderText）+
// TraceRows 直播（useLiveTrail 订阅单例 EventSource 按 runKey 分发，见 traceStream.ts）。
import { useLiveTrail } from './useLiveTrail.js'
import { workerHeaderText } from './text.js'
import { TraceRows } from './TraceRows.js'
import type { WorkflowRunningWorkerDTO } from '../api/types.js'

interface Props {
  worker: WorkflowRunningWorkerDTO
}

export function WorkerCard({ worker }: Props) {
  const trail = useLiveTrail(worker.jobId, worker.trail)

  return (
    <div className="wf-worker-card">
      <div className="wf-worker-header">
        <span className="wf-dot-active" aria-hidden="true" />
        <span className="wf-worker-title">{workerHeaderText(worker)}</span>
      </div>
      <TraceRows events={trail} live />
    </div>
  )
}
