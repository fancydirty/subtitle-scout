import { filenameParse, type ParsedFilename, type ParsedShow } from '@ctrl/video-filename-parser'

/** Recognition-ready shape for a single filename or bare path segment. Consumed by C2 (path-aware
 *  merging) and C3 (TMDB resolution) — keep the field names stable, they are the contract. */
export interface ParsedName {
  title: string | null
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  isTv: boolean
  isMultiSeason: boolean
  complete: boolean
}

function isShowResult(result: ParsedFilename): result is ParsedShow {
  return 'isTv' in result && result.isTv === true
}

function toYear(rawYear: string | null | undefined): number | null {
  if (!rawYear) return null
  const n = Number(rawYear)
  // movieTitleYearPatterns includes a "pass-the-popcorn-tag" pattern that captures ANY bracketed
  // tag (e.g. a fansub hash like "[ABCD1234]") into the same `year` group — guard against that.
  return Number.isFinite(n) ? n : null
}

/**
 * @ctrl/video-filename-parser's lowest-priority season pattern ("four-digit-scene-numbering")
 * treats any bare "NNMM" digit run as season NN / episode MM once nothing more specific matches —
 * including a release year sitting right before quality tags (e.g. "Hero.2002.1080p...mkv" reads
 * as season 20 / episode 02). Guard against that specific false positive: if the movie-mode parse
 * independently recovered the exact same four digits as a `year` (a much more targeted regex,
 * anchored on a following resolution/source keyword), it's almost certainly a movie, not a show.
 */
function isYearMisreadAsSeasonEpisode(tv: ParsedShow, movie: ParsedFilename): boolean {
  if (tv.seasons.length !== 1 || tv.episodeNumbers.length !== 1 || !movie.year) return false
  const asFourDigits = `${String(tv.seasons[0]).padStart(2, '0')}${String(tv.episodeNumbers[0]).padStart(2, '0')}`
  return asFourDigits === movie.year
}

/**
 * Thin wrapper around @ctrl/video-filename-parser's `filenameParse`. Pure string -> structure: no
 * path/dirname logic (that's C2's job) and no TMDB lookups (that's C3's).
 *
 * `filenameParse(name, isTv)` needs the isTv flag decided up front, and the two modes are not
 * simple variants of each other — TV mode never populates `year` (see the library's
 * filenameParse.ts: `year` is only assigned in the `!isTv` branch) and only returns a TV-shaped
 * result (`isTv: true` present) when its internal `parseSeason` actually matched season/episode
 * structure; otherwise it silently returns an (mostly empty) movie-shaped result. So rather than
 * guess from the input, we parse the name BOTH ways and pick: trust the TV parse if it found
 * structure, unless that structure is the year-misread-as-SxxExx false positive above, in which
 * case fall back to the movie parse.
 */
export function parseFilename(name: string): ParsedName {
  const movie = filenameParse(name, false)
  const tv = filenameParse(name, true)

  if (isShowResult(tv) && !isYearMisreadAsSeasonEpisode(tv, movie)) {
    // Anime absolute-episode patterns (e.g. "[Group] Title - 26 [hash].mkv") report the episode
    // number through the same `episodeNumbers` field as a normal S/E match, but leave `seasons`
    // empty — that emptiness is the library's only signal that a number is "absolute" (no season
    // context) rather than season-scoped. When a season IS present alongside an absolute number
    // (e.g. "One Piece S10E14 214"), the library overwrites `episodeNumbers` with the absolute
    // value and the real episode (14) is lost — a known lossy quirk of the upstream lib, not
    // something this wrapper can recover; documented in parseFilename.test.ts.
    const isAbsolute = tv.seasons.length === 0

    // Multi-episode files (episodeNumbers holding a range, e.g. [5, 6] for "S01E05E06") collapse
    // to the first episode; multi-episode spans are out of scope for this wrapper.
    return {
      title: tv.title || null,
      year: null, // TV-mode parses never carry a year (upstream library behavior, see above)
      season: isAbsolute ? null : (tv.seasons[0] ?? null),
      episode: isAbsolute ? null : (tv.episodeNumbers[0] ?? null),
      absoluteEpisode: isAbsolute ? (tv.episodeNumbers[0] ?? null) : null,
      isTv: true,
      isMultiSeason: tv.isMultiSeason,
      complete: tv.complete ?? false,
    }
  }

  return {
    title: movie.title || null,
    year: toYear(movie.year),
    season: null,
    episode: null,
    absoluteEpisode: null,
    isTv: false,
    isMultiSeason: false,
    complete: movie.complete ?? false,
  }
}
