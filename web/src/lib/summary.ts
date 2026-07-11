// web/src/lib/summary.ts：顶栏一句事实数字，纯函数聚合库列表。
import type { LibraryItemDTO } from '../api/types.js'
import { coverageBadge } from './badge.js'

export interface LibraryFacts {
  series: number
  movies: number
  missing: number
  working: number
}

/** 事实统计：缺字幕=徽章 part/none/review（review 是 task 2 的待确认态，仍算缺字幕）；
 *  处理中=徽章 work。 */
export function libraryFacts(items: LibraryItemDTO[]): LibraryFacts {
  let series = 0
  let movies = 0
  let missing = 0
  let working = 0
  for (const it of items) {
    if (it.kind === 'series') series++
    else movies++
    const b = coverageBadge(it.coverage, it.job)
    if (b.kind === 'work') working++
    else if (b.kind === 'part' || b.kind === 'none' || b.kind === 'review') missing++
  }
  return { series, movies, missing, working }
}

/** 冷峻事实句，只报存在的量，零装饰。 */
export function factLine(f: LibraryFacts): string {
  const parts: string[] = []
  if (f.series) parts.push(`${f.series} 部剧`)
  if (f.movies) parts.push(`${f.movies} 部电影`)
  if (f.missing) parts.push(`缺字幕 ${f.missing}`)
  if (f.working) parts.push(`${f.working} 部处理中`)
  return parts.join(' · ')
}
