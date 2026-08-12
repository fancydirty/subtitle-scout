// web/src/library/posterAngle.ts：海报卡覆盖角标的纯逻辑（任务规格：小 mono 数字 `24/28`，
// 全覆盖时绿点，缺口时灰字——不做彩色大 badge）。
import type { CoverageDTO } from '../../api/types.js'
import { isFullyCovered } from './filter.js'

export type PosterAngleKind = 'full' | 'gap' | 'none'

export interface PosterAngle {
  kind: PosterAngleKind
  /** gap 态才有文本（"covered/scope"）；full 只画绿点，none 什么都不画。 */
  text: string | null
}

/** scout 关心的集数（内嵌/策略跳过不计入分母，跟旧 lib/badge.ts 的 scoutScope 口径一致）。 */
function scoutScope(cov: CoverageDTO): number {
  return cov.covered + cov.hardsubAssumed + cov.missing + cov.unavailable
}

export function posterAngle(cov: CoverageDTO): PosterAngle {
  if (isFullyCovered(cov)) return { kind: 'full', text: null }
  const scope = scoutScope(cov)
  if (scope > 0) return { kind: 'gap', text: `${cov.covered + cov.hardsubAssumed}/${scope}` }
  return { kind: 'none', text: null }
}
