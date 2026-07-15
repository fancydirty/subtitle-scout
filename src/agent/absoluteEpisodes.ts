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
export async function resolveAbsoluteEpisode(
  season: number | null, episode: number | null, src: AbsoluteOrderSource, tvId = '',
): Promise<number | null> {
  if (season == null || episode == null) return null
  // 官方分组查询与季表兜底必须各自独立包裹 try/catch：官方查询瞬时抛错绝不能连坐吞掉 concat 兜底，
  // 否则 "concat fallback" 名不副实——一次抖动会把本可算出的绝对集号退化成 null（FALLBACK-DENIAL）。
  let official: { season: number; episode: number }[] | null = null
  try { official = await src.getAbsoluteOrder(tvId) } catch { official = null }
  if (official && official.length > 0) return absoluteFor(buildFromAbsoluteOrder(official), season, episode)
  try {
    const seasons = await src.getSeasonTable(tvId)
    if (!seasons) return null
    return absoluteFor(buildFromSeasonConcat(seasons), season, episode)
  } catch { return null }
}

/**
 * resolveAbsoluteEpisode 的逆向版：绝对集号 → (season, episode)。数据源纪律逐字复刻正向实现
 * （见上方 FALLBACK-DENIAL 注释）：官方 Absolute 型 episode-group 优先（独立 try/catch，瞬时
 * 抛错绝不连坐 concat 兜底）；官方表存在但查不到该集号 → 直接 null，不再向 concat 级联（与
 * 正向同一裁决——官方表就是该剧绝对编号的权威事实，编号超出它的范围时用 concat 猜一个别的
 * 答案只会更错）；官方分组缺失/为空 → 季表 concat 兜底（独立 try/catch）；两路都不可用或
 * 集号越界 → null（调用方按"折算不出来"处理，如摄取层 park）。
 */
export async function seasonEpisodeForAbsolute(
  absolute: number, src: AbsoluteOrderSource, tvId: string,
): Promise<{ season: number; episode: number } | null> {
  let official: { season: number; episode: number }[] | null = null
  try { official = await src.getAbsoluteOrder(tvId) } catch { official = null }
  if (official && official.length > 0) return seasonEpisodeFor(buildFromAbsoluteOrder(official), absolute)
  try {
    const seasons = await src.getSeasonTable(tvId)
    if (!seasons) return null
    return seasonEpisodeFor(buildFromSeasonConcat(seasons), absolute)
  } catch { return null }
}
