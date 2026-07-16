// web/src/workflow/trail.ts：TraceEvent 尾部合并——纯函数，独立于 useLiveTrail 的 React 生命
// 周期，方便单测直接覆盖去重/排序/裁剪三条规则，不必经过组件挂载。
import type { TraceEvent } from '../api/types.js'

/** 前端每 runKey 留尾的痕迹条数上限（DESIGN 任务规格："cap 每 runKey 前端留尾 100 条"）——
 *  跟后端 traceBus 的 RING_CAP 512 是两个不同层级的裁剪：后端保完整快照的近期窗口供收官落库/
 *  补拉，前端只保渲染实际需要的可视尾部。 */
const TRAIL_CAP = 100

/** 按 seq 去重合并两份事件（后出现的覆盖同 seq 的先出现的——SSE 直播事件与 workers 端点补拉
 *  理论上同 seq 内容应当一致，覆盖只是"数据不一致时以谁为准"的防御性选择，正常情况下不会
 *  真的触发），按 seq 升序排序后只保留尾部 TRAIL_CAP 条。 */
export function mergeTrail(existing: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  const bySeq = new Map<number, TraceEvent>()
  for (const e of existing) bySeq.set(e.seq, e)
  for (const e of incoming) bySeq.set(e.seq, e)
  const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
  return merged.length <= TRAIL_CAP ? merged : merged.slice(merged.length - TRAIL_CAP)
}
