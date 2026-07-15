import type { TmdbClient, TmdbSearchHit } from '../adapters/providers/tmdb.js'
import type { PathIdentity, Park } from './identifyFromPath.js'

/**
 * C3: resolves a path-derived PathIdentity (C2's output) to a concrete TMDB id.
 *
 * Philosophy — 拿不准就不动手 (same standard as libraryRealign's absolute-episode reconciliation):
 * a wrong tmdbId silently corrupts a library entry forever, while a parked item just waits for a
 * retry or a human to disambiguate it. Every rule below is deterministic and only ever narrows a
 * hit set down to exactly one candidate before adopting it; anything the rules can't narrow parks
 * rather than guessing. Deliberately out of scope (YAGNI): fuzzy title scoring, popularity
 * ranking, language matching, multi-search fallback, model-assisted disambiguation, TVDB/AniDB,
 * zero-signal rescue.
 *
 * Note on failures: `tmdb.search` throwing `TmdbRequestFailedError` (network/timeout/5xx) is a
 * TRANSIENT failure and is deliberately left to propagate out of this function rather than being
 * caught and turned into a park — parking it would misrepresent "TMDB never actually answered" as
 * "TMDB answered with nothing/too much", the same distinction tmdb.ts draws throughout
 * (getSeasonTable/getOriginLanguage never collapse a request failure into a no-data result).
 */
export interface Recognized {
  tmdbId: string
  title: string
  isTv: boolean
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
}

export type ResolveResult = Recognized | Park

/** Picks exactly one hit to adopt, or null if the rules can't narrow further.
 *  (a) exactly one hit → that hit, unconditionally.
 *  (b) multiple hits + a known year → hits whose year matches exactly; adopt only if that narrows
 *      to exactly one.
 *  (c) anything else (zero hits, or still multiple after year-narrowing) → null, caller parks. */
function pickUniqueHit(hits: TmdbSearchHit[], year: number | null): TmdbSearchHit | null {
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) return null
  if (year !== null) {
    const exact = hits.filter((h) => h.year === year)
    if (exact.length === 1) return exact[0]
  }
  return null
}

export async function resolveToTmdb(identity: PathIdentity, tmdb: TmdbClient): Promise<ResolveResult> {
  // Rule 1: an embedded [tmdbid-N] is high-confidence by construction (our own realign wrote the
  // tag, or the library was already organized by Sonarr/Radarr/Jellyfin) — direct pass-through,
  // no search, no network call. identity.isTv is structure-derived (from season/episode presence),
  // not from the embedded id, so an embedded-id movie correctly carries isTv:false through here.
  if (identity.embeddedTmdbId !== null) {
    return {
      tmdbId: identity.embeddedTmdbId,
      title: identity.title ?? '',
      isTv: identity.isTv,
      season: identity.season,
      episode: identity.episode,
      absoluteEpisode: identity.absoluteEpisode,
    }
  }

  // Rule 2: nothing to search on.
  if (!identity.title) {
    return { park: 'no-title' }
  }

  const mediaType = identity.isTv ? 'tv' : 'movie'
  const hadYear = identity.year !== null
  let hits = await tmdb.search(mediaType, identity.title, identity.year ?? undefined)

  // Zero hits with a year in play: a year scraped from a dir/file name can be wrong (release year
  // vs. air year mismatch, or an unrelated 4-digit token) — retry once with the year signal
  // dropped from the TMDB query before giving up. Note pickUniqueHit's rule (a) below is
  // unconditional: a hit set that narrows to exactly one after this retry gets adopted without
  // re-checking identity.year against it (only the multi-hit path, rule b, consults the year) —
  // that is the spec's deliberate call, not an oversight: a single globally-unique title match is
  // treated as sufficient signal on its own, same as if no year had ever been scraped at all.
  if (hits.length === 0 && hadYear) {
    hits = await tmdb.search(mediaType, identity.title, undefined)
  }

  const adopted = pickUniqueHit(hits, identity.year)
  if (!adopted) {
    return { park: hits.length === 0 ? 'no-match' : 'ambiguous' }
  }

  return {
    tmdbId: String(adopted.id),
    title: adopted.title,
    isTv: identity.isTv,
    season: identity.season,
    episode: identity.episode,
    absoluteEpisode: identity.absoluteEpisode,
  }
}
