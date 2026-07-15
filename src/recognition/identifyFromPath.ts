import { posix } from 'node:path'
import { parseFilename, type ParsedName } from './parseFilename.js'

/** Recognition-ready shape for a full video path. Consumed by C3 (TMDB resolution) — keep the
 *  field names stable, they are the contract. */
export interface PathIdentity {
  title: string | null
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  isTv: boolean
  embeddedTmdbId: string | null
}

/** Deliberately a loose `{ park: string }` (not an enum) — C2 only ever produces 'no-signal';
 *  other park reasons (e.g. 'ambiguous') belong to C3's TMDB disambiguation step. */
export interface Park {
  park: string
}

/**
 * Splits a video path into its raw string segments, tolerant of Windows-style backslash
 * separators, a leading slash (absolute path), and a stray trailing slash. This function is pure
 * string handling — no `fs`, so it can't know the real platform a path came from (a video path
 * may describe an SMB/Windows share even while this process runs on Linux/macOS) — so behavior
 * must not depend on the host OS. We deliberately do NOT use the platform-dependent `path` module
 * for splitting (its separator varies by OS); `node:path`'s `posix` variant is used below only for
 * the extension-stripping helper, once slashes are already normalized to '/'.
 */
function toSegments(videoPath: string): string[] {
  const normalized = videoPath.replace(/\\/g, '/')
  return normalized.split('/').filter((segment) => segment.length > 0)
}

/** Our only metadata source is TMDB (YAGNI) — `[tvdbid-...]`/`[imdbid-...]` tags are ignored by
 *  construction: this regex only ever matches the `tmdbid` tag. Matches the folder convention this
 *  project itself emits (see `buildTargetShowDir` in libraryRealign.ts: `Show (Year) [tmdbid-N]`)
 *  and the same convention Sonarr/Radarr/Jellyfin use. */
const TMDB_ID_PATTERN = /\[tmdbid-(\d+)\]/i

function findEmbeddedTmdbId(segments: string[]): string | null {
  for (const segment of segments) {
    const match = segment.match(TMDB_ID_PATTERN)
    if (match) return match[1]
  }
  return null
}

/**
 * @ctrl/video-filename-parser (wrapped by parseFilename, C1) cannot recognize a bare season-folder
 * segment: `parseFilename('Season 2')` finds no season and just echoes 'Season 2' back as a
 * literal movie title. Worse, a zero-padded form like 'Season 02' gets swallowed by the lib's
 * anime-absolute-episode pattern (title 'Season', absoluteEpisode 2) — actively wrong, not just
 * empty. So season-folder detection runs on the RAW segment with our own regex, and (see below)
 * season-folder-shaped segments are never handed to parseFilename at all.
 */
const SEASON_FOLDER_PATTERNS: RegExp[] = [/^(?:season|series)[\s._-]*(\d{1,3})$/i, /^s(\d{1,3})$/i]

function detectSeasonFolder(rawSegment: string): number | null {
  const trimmed = rawSegment.trim()
  if (/^specials?$/i.test(trimmed)) return 0
  for (const pattern of SEASON_FOLDER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

/**
 * Minimal fallback for bare-episode FILE segments the lib can't parse — verified empirically:
 * 'ep 1.mp4', 'ep1.mp4', bare '01.mp4' / '1.mp4', and CJK '第3话'/'第3集' all fail to parse via
 * @ctrl/video-filename-parser (echoed back as a literal movie title, no episode/absoluteEpisode).
 * Only called once the lib parse found no season/episode/absoluteEpisode structure at all.
 * Digits capped at 3 (episodes rarely run past 999) so a bare 4-digit filename that's really a
 * year (e.g. a hypothetical 'movies/2016.mp4') doesn't get misread as an episode number.
 */
const BARE_EPISODE_PATTERNS: RegExp[] = [
  /^(?:ep|episode)[\s._-]*(\d{1,3})$/i,
  /^第\s*(\d{1,3})\s*[话集]$/,
  /^(\d{1,3})$/,
]

function parseBareEpisode(fileNameNoExt: string): number | null {
  const trimmed = fileNameNoExt.trim()
  for (const pattern of BARE_EPISODE_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) return Number(match[1])
  }
  return null
}

/**
 * Path-aware layer on top of parseFilename (C1): cuts the path's last three segments
 * (file / parent dir / grandparent dir), parses each, and deterministically merges them into one
 * identity — the `Show/Season NN/file` convention Jellyfin/Sonarr/Radarr all rely on. No models,
 * no TMDB, no fs access: a pure function of the path string.
 */
export function identifyFromPath(videoPath: string): PathIdentity | Park {
  const segments = toSegments(videoPath)
  if (segments.length === 0) return { park: 'no-signal' }

  // Rule 1: embedded [tmdbid-N] short-circuits TMDB *searching* (C3's job) but not the
  // season/episode/title structure below, which still gets merged normally.
  const embeddedTmdbId = findEmbeddedTmdbId(segments)

  const fileSeg = segments[segments.length - 1]
  const parentSeg = segments.length >= 2 ? segments[segments.length - 2] : null
  const grandparentSeg = segments.length >= 3 ? segments[segments.length - 3] : null

  // Rule 2: season folders detected on the RAW segment (lib can't do this — see above).
  const parentSeasonFolder = parentSeg !== null ? detectSeasonFolder(parentSeg) : null
  const grandparentSeasonFolder = grandparentSeg !== null ? detectSeasonFolder(grandparentSeg) : null
  const parentIsSeasonFolder = parentSeasonFolder !== null
  const grandparentIsSeasonFolder = grandparentSeasonFolder !== null

  const fileParsed: ParsedName = parseFilename(fileSeg)
  // A season-folder-like segment is NEVER a title candidate (rule 5) and is never worth running
  // through parseFilename at all — see the SEASON_FOLDER_PATTERNS comment for why letting the lib
  // near a string like 'Season 02' is actively harmful, not just unhelpful.
  const parentParsed: ParsedName | null =
    parentSeg !== null && !parentIsSeasonFolder ? parseFilename(parentSeg) : null
  const grandparentParsed: ParsedName | null =
    grandparentSeg !== null && !grandparentIsSeasonFolder ? parseFilename(grandparentSeg) : null

  // Rule 5: title precedence, structure-conditioned (deliberate deviation from a blind
  // grandparent > parent > file rule).
  let title: string | null
  let year: number | null
  if (parentIsSeasonFolder) {
    // Show/Season NN/file layout: the season folder ate the parent slot, so the title lives one
    // level up. Defensively fall back to the file segment if the grandparent is missing or is
    // itself season-folder-shaped (e.g. malformed 'Season 1/Season 1/file.mkv' nesting).
    if (grandparentParsed?.title && !grandparentIsSeasonFolder) {
      title = grandparentParsed.title
      year = grandparentParsed.year
    } else {
      title = fileParsed.title
      year = fileParsed.year
    }
  } else if (fileParsed.year !== null && fileParsed.title) {
    // Flat movie layout ('movies/Hero.2002.1080p.mkv'): the filename is the info-bearing segment;
    // the parent is often just a category root ('movies') that would misidentify if used as title.
    title = fileParsed.title
    year = fileParsed.year
  } else if (parentParsed?.title) {
    // Show/file.mkv layout: the parent dir is the show title.
    title = parentParsed.title
    year = parentParsed.year
  } else {
    title = fileParsed.title
    year = fileParsed.year
  }

  // Rule 4: file segment's own season wins; else season-folder parent; else null.
  const season = fileParsed.season ?? parentSeasonFolder ?? null

  // Rule 3: episode/absoluteEpisode. Trust the lib's own season+episode or absoluteEpisode
  // structure as-is when it found one (it already made the season-vs-absolute call). Only for a
  // file segment where the lib found NOTHING do we fall back to our own bare-number regex, and
  // only THERE does season-context decide episode vs absoluteEpisode (a bare number has no
  // inherent season/absolute distinction the way the lib's own parse does).
  let episode: number | null = null
  let absoluteEpisode: number | null = null
  if (fileParsed.episode !== null) {
    episode = fileParsed.episode
  } else if (fileParsed.absoluteEpisode !== null) {
    absoluteEpisode = fileParsed.absoluteEpisode
  } else if (!fileParsed.isTv) {
    const bare = parseBareEpisode(posix.parse(fileSeg).name)
    if (bare !== null) {
      if (season !== null) episode = bare
      else absoluteEpisode = bare
    }
  }

  // Rule 6: isTv iff episode/absoluteEpisode/season structure was found — embeddedTmdbId alone
  // doesn't decide it (an embedded id can point at a movie just as easily as a show).
  const isTv = season !== null || episode !== null || absoluteEpisode !== null

  // Rule 7: park on zero signal. Trade-off, deliberate: this parks a year-less flat movie (e.g.
  // 'movies/aaa/bbb.mkv') even though a human could probably still guess the title — zero-signal
  // rescue is out of scope for this mechanical layer (YAGNI), and a wrong tmdbId from guessing is
  // worse than a parked item that gets retried or manually identified later (C3/C4's job).
  const yearAnywhere = fileParsed.year ?? parentParsed?.year ?? grandparentParsed?.year ?? null
  if (embeddedTmdbId === null && !isTv && yearAnywhere === null) {
    return { park: 'no-signal' }
  }

  return {
    title,
    year,
    season,
    episode,
    absoluteEpisode,
    isTv,
    embeddedTmdbId,
  }
}
