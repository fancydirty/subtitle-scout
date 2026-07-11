// web/src/lib/badge.ts
// 海报覆盖徽章的纯逻辑：覆盖计数 + 当前 job → 徽章形态。
// 单一事实源，五态互斥，供海报墙徽章、过滤 tab、顶栏事实数字共用。
import type { CoverageDTO, LibraryJobDTO } from '../api/types.js'

export type BadgeKind = 'full' | 'part' | 'work' | 'review' | 'none'

export interface Badge {
  kind: BadgeKind
  text: string
  /** 仅 work 态为 true：脉冲点只在真实 in-flight。 */
  pulse: boolean
}

const ACTIVE_JOB = new Set(['searching', 'downloading', 'verifying'])

/** job 是否真实在跑（脉冲的唯一依据）。 */
export function jobActive(job: LibraryJobDTO | null): boolean {
  return job != null && ACTIVE_JOB.has(job.state)
}

/** scout 关心的集数（内嵌与策略跳过不计；needsReview 计入——待确认仍是缺字幕范畴）。 */
export function scoutScope(cov: CoverageDTO): number {
  return cov.covered + cov.missing + cov.unavailable + cov.needsReview
}

/**
 * 徽章判定（优先级自上而下，互斥）：
 * 1. job 在跑 → work：脉冲 + covered/scope 分数
 * 2. 有 needsReview（ask_user：找到候选但置信不足）→ review：待确认，
 *    优先于 full/part/none——这是"找到了东西，只是需要你点头"，比"缺字幕"更值得
 *    单独抛出来，不能被 covered 数字掩盖（task 2：诚实区分于搜索穷尽的暂无）。
 * 3. 无缺无未决且有中字（外挂或内嵌）→ full：teal 勾
 * 4. 已补到一部分 → part：分数
 * 5. 一集未补：
 *    - 还有 missing（未搜过，含新入库排队中的）→ none：待搜索
 *    - 全是 unavailable（搜穷尽，会定期复查）→ none：暂无
 *    二者 kind/filter 行为一致（都算"缺字幕"），仅文案区分，
 *    避免用户把"还没搜"误读成"确认没有"。
 */
export function coverageBadge(cov: CoverageDTO, job: LibraryJobDTO | null): Badge {
  const scope = scoutScope(cov)
  if (jobActive(job)) {
    return { kind: 'work', text: scope > 0 ? `${cov.covered}/${scope}` : '', pulse: true }
  }
  if (cov.needsReview > 0) {
    return { kind: 'review', text: `${cov.needsReview} 待确认`, pulse: false }
  }
  const fullyHandled = cov.missing === 0 && cov.unavailable === 0 && (cov.covered > 0 || cov.embedded > 0)
  // 全覆盖：有实补集数时报 n/n（12/12），纯内嵌无 scout 战果则报 ✓。
  if (fullyHandled) return { kind: 'full', text: cov.covered > 0 ? `${cov.covered}/${scope}` : '✓', pulse: false }
  if (cov.covered > 0) return { kind: 'part', text: `${cov.covered}/${scope}`, pulse: false }
  if (cov.missing > 0) return { kind: 'none', text: '待搜索', pulse: false }
  return { kind: 'none', text: '暂无', pulse: false }
}

export type LibraryFilter = 'all' | 'missing' | 'working' | 'done'

/** 过滤谓词：复用徽章 kind，保证 tab 与徽章一致。needsReview 待确认仍算"缺字幕"，
 *  归入 missing tab——它还没有落地的中文字幕，用户点开"缺字幕"应该能看到它。 */
export function matchesFilter(badge: Badge, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'missing':
      return badge.kind === 'part' || badge.kind === 'none' || badge.kind === 'review'
    case 'working':
      return badge.kind === 'work'
    case 'done':
      return badge.kind === 'full'
  }
}
