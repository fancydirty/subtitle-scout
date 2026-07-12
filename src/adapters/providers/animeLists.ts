// Fribb/anime-lists（https://github.com/Fribb/anime-lists）：社区维护的 AniDB↔TVDB↔TMDB 交叉映射表，
// 免费无 key。entry.season.tmdb / entry.episode_offset.tmdb 给出该 AniDB 条目（通常一部动画的一个季/cour）
// 在 TMDB 上对应的季号与集号偏移——用来交叉验证我们自己从 TMDB 季表算出的累计绝对编号映射。
export const ANIME_LISTS_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json'
export const ANIME_LISTS_TIMEOUT_MS = 15_000

export class AnimeListsRequestFailedError extends Error {
  constructor(cause: unknown) {
    super(`anime-lists request failed: ${String(cause)}`, { cause })
    this.name = 'AnimeListsRequestFailedError'
  }
}

export interface AnimeListsEntry {
  anidbId: number
  tmdbTvId: number | null
  tmdbSeason: number | null
  tmdbEpisodeOffset: number | null
}

interface RawEntry {
  anidb_id?: unknown
  themoviedb_id?: { tv?: unknown }
  season?: { tmdb?: unknown }
  episode_offset?: { tmdb?: unknown }
}

// fetchImpl 默认走全局 fetch，与仓库其余抓取器同一惯例（见 adapters/download/direct.ts、
// adapters/providers/tmdb.ts）——注入点让单测永远不真的碰网络，生产代码不必显式传参。
export async function fetchAnimeListsTable(fetchImpl: typeof fetch = fetch): Promise<AnimeListsEntry[]> {
  let res: Response
  try {
    res = await fetchImpl(ANIME_LISTS_URL, { signal: AbortSignal.timeout(ANIME_LISTS_TIMEOUT_MS) })
  } catch (e) {
    throw new AnimeListsRequestFailedError(e)
  }
  if (!res.ok) throw new AnimeListsRequestFailedError(`HTTP ${res.status}`)
  let raw: unknown
  try {
    raw = await res.json()
  } catch (e) {
    throw new AnimeListsRequestFailedError(e)
  }
  if (!Array.isArray(raw)) throw new AnimeListsRequestFailedError('response is not an array')

  const out: AnimeListsEntry[] = []
  for (const item of raw as RawEntry[]) {
    if (typeof item !== 'object' || item === null) continue
    const anidbId = item.anidb_id
    if (typeof anidbId !== 'number') continue
    const tmdbTv = item.themoviedb_id?.tv
    const season = item.season?.tmdb
    const offset = item.episode_offset?.tmdb
    out.push({
      anidbId,
      tmdbTvId: typeof tmdbTv === 'number' ? tmdbTv : null,
      tmdbSeason: typeof season === 'number' ? season : null,
      tmdbEpisodeOffset: typeof offset === 'number' ? offset : null,
    })
  }
  return out
}

export function entriesForTmdbTv(entries: AnimeListsEntry[], tmdbTvId: number): AnimeListsEntry[] {
  return entries.filter(e => e.tmdbTvId === tmdbTvId)
}
