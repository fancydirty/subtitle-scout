// web/src/library/episodeState.ts：三层格阵合并的纯逻辑——canonical（TMDB 应有）∪ onDisk（磁盘
// 现状）按集号并集，逐格判定语义态。单一事实源，供 EpisodeCell 渲染、图例、覆盖句统计共用。
//
// 语义（DESIGN.md §4/§6 + 任务规格）：
//   covered   已补齐（covered/embedded/ignored——ignored 是策略跳过，视觉等同"不需处理"）
//   missing   灰格空点：genuinely missing，或 unavailable 但 recheckAfter 已到期可复查
//             （沿用 src/v2/libraryRepo.ts 已确立的口径：unavailable && recheckAfter <= now
//              算"缺口"不算"停牌"，跟 workflow/pending 聚合的判定一致，前后端不许各算一套）
//   throttled 灰点+斜体集号：unavailable 且 recheckAfter 仍在未来——排队/停牌=灰，不是警报
//   error     红点，谨慎：subStatus 落在未知值时的防御性兜底（数据异常，不是正常状态之一）
//   dashed    canonical 有但磁盘没有对应集——三层合成的核心呈现，不计入上述任何一态
import type { LibraryCanonicalEpisodeDTO, LibraryOnDiskEpisodeDTO, LibrarySeasonDTO } from '../api/types.js'

export type EpisodeCellState = 'covered' | 'hardsub' | 'missing' | 'throttled' | 'error' | 'dashed'

export interface GridCell {
  episode: number
  state: EpisodeCellState
  /** canonical 标题（有 TMDB 缓存时）；dashed 格用它做详情板文案。 */
  title: string | null
  /** 磁盘行——dashed 格恒为 null。 */
  onDisk: LibraryOnDiskEpisodeDTO | null
}

/** 单条磁盘记录 → 非 dashed 的四态之一。 */
function classifyOnDisk(ep: LibraryOnDiskEpisodeDTO, now: number): Exclude<EpisodeCellState, 'dashed'> {
  switch (ep.subStatus) {
    case 'covered':
    case 'embedded':
    case 'ignored':
      return 'covered'
    case 'hardsub-assumed':
      return 'hardsub'
    case 'unavailable':
      return ep.recheckAfter != null && ep.recheckAfter > now ? 'throttled' : 'missing'
    case 'missing':
      return 'missing'
    default:
      // 未知 sub_status——数据异常而非正常状态，红点谨慎提示而不是静默吞掉。
      return 'error'
  }
}

/** canonical ∪ onDisk 按集号并集升序合成格阵。 */
export function buildGridCells(season: LibrarySeasonDTO, now: number): GridCell[] {
  const canonicalByEp = new Map<number, LibraryCanonicalEpisodeDTO>(
    season.canonical.map((c) => [c.episode, c]),
  )
  const onDiskByEp = new Map<number, LibraryOnDiskEpisodeDTO>(season.onDisk.map((d) => [d.episode, d]))

  const episodes = new Set<number>()
  for (const c of season.canonical) episodes.add(c.episode)
  for (const d of season.onDisk) episodes.add(d.episode)

  return [...episodes]
    .sort((a, b) => a - b)
    .map((episode) => {
      const disk = onDiskByEp.get(episode) ?? null
      const title = canonicalByEp.get(episode)?.title ?? null
      if (disk) return { episode, state: classifyOnDisk(disk, now), title, onDisk: disk }
      return { episode, state: 'dashed' as const, title, onDisk: null }
    })
}

/** canonical 缓存尚未建立（该季从未拉过 TMDB 季表，见 tmdbCatalog.canonicalEpisodes 的注释：
 *  空数组不区分"没拉过"与"确实零集"）——呈现层只能通过"这一季 canonical 是空的"来猜，
 *  猜错的代价是把"真的零集"误判成"缓存未建"，但那种季本就不该在库里出现，可接受。 */
export function isCanonicalPending(season: LibrarySeasonDTO): boolean {
  return season.canonical.length === 0
}

export interface SeasonTally {
  covered: number
  hardsub: number
  missing: number
  throttled: number
  error: number
  dashed: number
  total: number
}

export function tallyGridCells(cells: GridCell[]): SeasonTally {
  const t: SeasonTally = { covered: 0, hardsub: 0, missing: 0, throttled: 0, error: 0, dashed: 0, total: cells.length }
  for (const c of cells) {
    switch (c.state) {
      case 'covered':
        t.covered++
        break
      case 'hardsub':
        t.hardsub++
        t.covered++
        break
      case 'missing':
        t.missing++
        break
      case 'throttled':
        t.throttled++
        break
      case 'error':
        t.error++
        break
      case 'dashed':
        t.dashed++
        break
    }
  }
  return t
}
