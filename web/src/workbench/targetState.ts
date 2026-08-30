// web/src/workbench/targetState.ts —— 活动卡覆盖格的两个纯函数：四档计数 + 单文件退化判据。
// 覆盖格把一部作品的每个 target 画成一格状态丸（剧集流逐集、电影流单枚）。这里只算数不渲染。
import type { ScoutCurrentDTO } from '../api/types.js'

export type Target = NonNullable<ScoutCurrentDTO['targets']>[number]

/** 覆盖格计数：installed / active / pending / pending-source 四档。
 *  pending-source（有目标但当前无源）单独成档，**不并入 pending**——两者用户可做的事不同。 */
export function countStates(targets: Target[]): { installed: number; active: number; pending: number; pendingSource: number } {
  const c = { installed: 0, active: 0, pending: 0, pendingSource: 0 }
  for (const t of targets) {
    if (t.state === 'installed') c.installed++
    else if (t.state === 'active') c.active++
    else if (t.state === 'pending-source') c.pendingSource++
    else c.pending++
  }
  return c
}

/** 单文件（电影）形态：覆盖格退化成一枚状态丸。判据 = 恰一个 target 且 key==='movie'。 */
export function isSingleFileGrid(targets: Target[]): boolean {
  return targets.length === 1 && targets[0]?.key === 'movie'
}
