// web/src/workflow/trail.ts：TraceEvent 尾部合并——纯函数，独立于 useLiveTrail 的 React 生命
// 周期，方便单测直接覆盖去重/排序/裁剪三条规则，不必经过组件挂载。
import type { TraceEvent } from '../api/types.js'

/** 前端每 runKey 留尾的痕迹条数上限（DESIGN 任务规格："cap 每 runKey 前端留尾 100 条"）——
 *  跟后端 traceBus 的 RING_CAP 512 是两个不同层级的裁剪：后端保完整快照的近期窗口供收官落库/
 *  补拉，前端只保渲染实际需要的可视尾部。 */
const TRAIL_CAP = 100

/** 按 (runKey, seq) 去重合并两份事件（后出现的覆盖同键的先出现的——SSE 直播事件与 workers
 *  端点补拉理论上同键内容应当一致，覆盖只是"数据不一致时以谁为准"的防御性选择，正常情况下
 *  不会真的触发），按 (at, seq) 升序排序后只保留尾部 TRAIL_CAP 条。
 *
 *  R2D-13（R2 复审）：去重键不能只用 seq——realign WorkerCard 的 trail 混流了多个子集 runKey
 *  （`job-${jobId}-${absoluteEpisode}`），每个子集各自的 seq 独立从 0 起算，纯按 seq 去重会把
 *  不同子集的第 0 条事件互相当同一条覆盖掉（真实丢事件，不是无害去重）。带上 runKey 组成复合
 *  键消除这个碰撞；排序主键相应从 seq 改成 at（跨子集场景下 seq 不再是全局时间序，at 才是）。 */
export function mergeTrail(existing: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  const byKey = new Map<string, TraceEvent>()
  for (const e of existing) byKey.set(`${e.runKey}#${e.seq}`, e)
  for (const e of incoming) byKey.set(`${e.runKey}#${e.seq}`, e)
  const merged = [...byKey.values()].sort((a, b) => a.at - b.at || a.seq - b.seq)
  return merged.length <= TRAIL_CAP ? merged : merged.slice(merged.length - TRAIL_CAP)
}
