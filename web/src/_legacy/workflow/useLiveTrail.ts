// web/src/workflow/useLiveTrail.ts：WorkerCard 的直播痕迹——baseTrail（来自 useWorkflowWorkers
// 轮询的 running[].trail，traceBus.peek 的补拉）作为种子，SSE 事件按 seq 去重追加
// （trail.ts 的 mergeTrail）。baseTrail 变化时（每次轮询刷新，或断线重连后 Lanes.tsx 主动
// reload() 触发的补拉）同样走一次合并，不会因为一次新的轮询响应而丢掉直播已经追加、轮询还
// 没来得及反映的事件。
import { useEffect, useState } from 'react'
import type { TraceEvent } from '../../api/types.js'
import { subscribeTrace } from './traceStream.js'
import { mergeTrail } from './trail.js'

/** jobId 为 null 时不订阅（调用方只应该在 running worker 上使用这个 hook；null 是防御性
 *  兜底，不是正常调用路径）。 */
export function useLiveTrail(jobId: number | null, baseTrail: TraceEvent[]): TraceEvent[] {
  const [trail, setTrail] = useState<TraceEvent[]>(baseTrail)

  useEffect(() => {
    setTrail((prev) => mergeTrail(prev, baseTrail))
  }, [baseTrail])

  useEffect(() => {
    if (jobId == null) return
    const runKey = `job-${jobId}`
    return subscribeTrace(runKey, (e) => {
      setTrail((prev) => mergeTrail(prev, [e]))
    })
  }, [jobId])

  return trail
}
