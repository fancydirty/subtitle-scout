/** A per-series cross-reference: whole-series absolute episode number <-> (season, episode-in-season).
 *  System-computed from TMDB so the model never does the arithmetic. Consumed as a HINT by the
 *  find-subtitle worker (surfaced in its prompt) — never as a belonging gate (north star: the worker
 *  still verifies the located file actually matches before installing). */
export interface AbsoluteEpisodeTable {
  entries: { absolute: number; season: number; episode: number }[]
  totalEpisodes: number
  source: 'tmdb-episode-group' | 'tmdb-season-concat'
  reliable: boolean
}

interface SeasonRow { seasonNumber: number; episodeCount: number }

const EMPTY_UNRELIABLE: AbsoluteEpisodeTable = { entries: [], totalEpisodes: 0, source: 'tmdb-season-concat', reliable: false }

export function buildFromSeasonConcat(seasons: SeasonRow[]): AbsoluteEpisodeTable {
  const clean = seasons.filter(s => Number.isInteger(s.seasonNumber) && Number.isInteger(s.episodeCount) && s.episodeCount > 0)
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
  if (clean.length === 0) return EMPTY_UNRELIABLE
  const entries: AbsoluteEpisodeTable['entries'] = []
  let running = 0
  for (const s of clean) {
    for (let ep = 1; ep <= s.episodeCount; ep++) {
      running++
      entries.push({ absolute: running, season: s.seasonNumber, episode: ep })
    }
  }
  return { entries, totalEpisodes: running, source: 'tmdb-season-concat', reliable: running > 0 }
}

export function absoluteFor(table: AbsoluteEpisodeTable, season: number, episode: number): number | null {
  if (!table.reliable) return null
  const hit = table.entries.find(e => e.season === season && e.episode === episode)
  return hit ? hit.absolute : null
}

/** absoluteFor 的逆向查表：整剧绝对集号 → (season, episode)。同一张表、同一套 reliable 门，
 *  只是查询方向相反——去 Jellyfin 化 P3 的摄取层用它把"路径只给出绝对集号"的番剧文件折算成
 *  可构造 episodeId 的 (season, episode) 对。 */
export function seasonEpisodeFor(table: AbsoluteEpisodeTable, absolute: number): { season: number; episode: number } | null {
  if (!table.reliable) return null
  const hit = table.entries.find(e => e.absolute === absolute)
  return hit ? { season: hit.season, episode: hit.episode } : null
}

export function buildFromAbsoluteOrder(ordered: { season: number; episode: number }[]): AbsoluteEpisodeTable {
  if (ordered.length === 0) return { ...EMPTY_UNRELIABLE, source: 'tmdb-episode-group' }
  const entries = ordered.map((e, i) => ({ absolute: i + 1, season: e.season, episode: e.episode }))
  return { entries, totalEpisodes: entries.length, source: 'tmdb-episode-group', reliable: true }
}

export interface AbsoluteOrderSource {
  getSeasonTable: (tvId: string) => Promise<{ seasonNumber: number; episodeCount: number }[] | null>
  getAbsoluteOrder: (tvId: string) => Promise<{ season: number; episode: number }[] | null>
}

/**
 * 数据源纪律的唯一实现：官方 Absolute 型 episode-group 优先（独立 try/catch，瞬时抛错绝不连坐
 * 季表兜底——否则 "concat fallback" 名不副实，一次抖动会把本可算出的绝对集号退化成 null，
 * FALLBACK-DENIAL）；官方分组缺失/为空 → 季表 concat 兜底（同样独立 try/catch）；两路都不可用
 * → null。resolveAbsoluteEpisode / seasonEpisodeForAbsolute 都只是在这张表上分别做正向/逆向查询
 * （absoluteFor / seasonEpisodeFor），数据源纪律不重复。
 *
 * 批量 mapper（胶水层修复）用它取表一次、逐集调 absoluteFor/seasonEpisodeFor，替代逐集调
 * resolveAbsoluteEpisode 造成的 2N 次 TMDB 往返。
 */
export async function resolveAbsoluteTable(
  src: AbsoluteOrderSource, tvId: string,
): Promise<AbsoluteEpisodeTable | null> {
  let official: { season: number; episode: number }[] | null = null
  try { official = await src.getAbsoluteOrder(tvId) } catch { official = null }
  if (official && official.length > 0) return buildFromAbsoluteOrder(official)
  try {
    const seasons = await src.getSeasonTable(tvId)
    if (!seasons) return null
    return buildFromSeasonConcat(seasons)
  } catch { return null }
}

export async function resolveAbsoluteEpisode(
  season: number | null, episode: number | null, src: AbsoluteOrderSource, tvId = '',
): Promise<number | null> {
  if (season == null || episode == null) return null
  const table = await resolveAbsoluteTable(src, tvId)
  return table ? absoluteFor(table, season, episode) : null
}

/**
 * resolveAbsoluteEpisode 的逆向版：绝对集号 → (season, episode)。数据源纪律见 resolveAbsoluteTable
 * ——官方表存在但查不到该集号时直接 null，不再向 concat 级联（官方表是该剧绝对编号的权威事实，
 * 编号超出它的范围时用 concat 猜一个别的答案只会更错）。
 */
export async function seasonEpisodeForAbsolute(
  absolute: number, src: AbsoluteOrderSource, tvId: string,
): Promise<{ season: number; episode: number } | null> {
  const table = await resolveAbsoluteTable(src, tvId)
  return table ? seasonEpisodeFor(table, absolute) : null
}
