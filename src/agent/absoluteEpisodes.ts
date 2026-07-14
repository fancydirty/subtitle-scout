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

export function buildFromAbsoluteOrder(ordered: { season: number; episode: number }[]): AbsoluteEpisodeTable {
  if (ordered.length === 0) return { ...EMPTY_UNRELIABLE, source: 'tmdb-episode-group' }
  const entries = ordered.map((e, i) => ({ absolute: i + 1, season: e.season, episode: e.episode }))
  return { entries, totalEpisodes: entries.length, source: 'tmdb-episode-group', reliable: true }
}
