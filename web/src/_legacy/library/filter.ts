// web/src/library/filter.ts：海报墙筛选 chip 的纯逻辑——单一事实源，供 SeriesGrid 的
// SegmentedControl 与测试共用。/api/v2/library 的 CoverageDTO 只有 covered/missing/embedded/
// unavailable 四个桶（没有单独的 throttled 计数），"停牌中" 筛选借用 unavailable>0 且
// missing===0 近似——unavailable 就是"搜索穷尽、等定期复查"的桶（src/dashboard/apiV2.ts 的
// addToCoverage 注释），跟 workflow/pending 里 "unavailable 且 recheckAfter 未到期才算 throttled"
// 的精确口径不完全一致，但海报墙层级本就是粗粒度概览，精确口径留给剧集页格阵。
import type { CoverageDTO, LibraryItemDTO } from '../../api/types.js'

export type LibraryFilter = 'all' | 'gap' | 'throttled' | 'full'

export const LIBRARY_FILTERS: readonly LibraryFilter[] = ['all', 'gap', 'throttled', 'full']

export type KindFilter = 'all' | 'series' | 'movies'

export const KIND_FILTERS: readonly KindFilter[] = ['all', 'series', 'movies']

export function kindFilterLabel(f: KindFilter): string {
  switch (f) {
    case 'all':
      return 'All'
    case 'series':
      return 'Series'
    case 'movies':
      return 'Movies'
  }
}

export function applyKindFilter(items: LibraryItemDTO[], filter: KindFilter): LibraryItemDTO[] {
  if (filter === 'all') return items
  return items.filter((item) => {
    if (filter === 'series') return item.kind === 'series'
    if (filter === 'movies') return item.kind === 'movie'
    return true
  })
}

/** 全覆盖：无缺口无停牌，且确有已处理集数（covered/embedded 任一 > 0）。海报卡的角标
 *  （posterAngle.ts）复用这同一条判定，两处不许各算一套"什么叫全覆盖"。 */
export function isFullyCovered(cov: CoverageDTO): boolean {
  return cov.missing === 0 && cov.unavailable === 0 && (cov.covered > 0 || cov.embedded > 0 || cov.hardsubAssumed > 0)
}

export function matchesLibraryFilter(cov: CoverageDTO, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'gap':
      return cov.missing > 0
    case 'throttled':
      return cov.missing === 0 && cov.unavailable > 0
    case 'full':
      return isFullyCovered(cov)
  }
}

// 已知分区块序：剧集 → 动漫 → 电影 → 其他（未知目录名排在已知之后，按名称）——
// 沿用旧 PosterWall 的既有排序口径，只是搬进 F3 纯函数模块。
const KNOWN_SECTION_ORDER = ['剧集', '动漫', '电影']
function sectionRank(s: string): number {
  const i = KNOWN_SECTION_ORDER.indexOf(s)
  return i === -1 ? KNOWN_SECTION_ORDER.length : i
}

export interface LibrarySection {
  section: string
  items: LibraryItemDTO[]
}

/** 按 section 分块并排序（空块不产出）。 */
export function groupBySection(items: LibraryItemDTO[]): LibrarySection[] {
  const groups = new Map<string, LibraryItemDTO[]>()
  for (const it of items) {
    const key = it.section || '其他'
    const bucket = groups.get(key)
    if (bucket) bucket.push(it)
    else groups.set(key, [it])
  }
  return [...groups.keys()]
    .sort((a, b) => {
      const ra = sectionRank(a)
      const rb = sectionRank(b)
      return ra !== rb ? ra - rb : a.localeCompare(b, 'zh')
    })
    .map((section) => ({ section, items: groups.get(section)! }))
}
