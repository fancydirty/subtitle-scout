import type { PathIdentity } from './identifyFromPath.js'

/**
 * Raw data carrier from mechanical parsing (C1/C2) to the agent (C3): the observed facts about
 * one video file, handed over for identification. Consumed by the agent's TMDB-resolution step —
 * keep the field names stable, they are the contract.
 *
 * `structureHints` are UNVERIFIED candidates extracted mechanically from the path string
 * (@ctrl/video-filename-parser + our own regexes). They are guesses, not truth: the agent must
 * verify them against TMDB (title/year match, season table, episode existence) and must not
 * treat any hint as authoritative on its own.
 *
 * `embeddedTmdbId` (the `[tmdbid-N]` tag — the canonical layout this project itself emits, see
 * `buildTargetShowDir` in libraryRealign.ts) is the STRONGEST hint available, so it is carried
 * here rather than dropped. It is still only a hint, not a verdict: the tag was written by a
 * previous run or an external organizer and may be stale or wrong, so the agent must still
 * confirm it resolves correctly on TMDB before relying on it.
 */
export interface RawFileEvidence {
  path: string
  dirName: string
  fileName: string
  durationSec: number | null
  embeddedLangs: string[] | null
  structureHints: {
    title: string | null
    year: number | null
    season: number | null
    episode: number | null
    absoluteEpisode: number | null
    isTv: boolean
    embeddedTmdbId: string | null
  }
}

/**
 * Assembles the RawFileEvidence for one video file. Pure function: splits the path string
 * (tolerant of Windows backslashes and missing parent segments — a single-segment path yields
 * `dirName === ''`) and copies the mechanical parser's identity fields verbatim into
 * `structureHints`. No TMDB, no fs access — verification is the agent's job, not this layer's.
 */
export function buildRawEvidence(
  path: string,
  identity: PathIdentity,
  durationSec: number | null,
  embeddedLangs: string[] | null,
): RawFileEvidence {
  const segments = path.split(/[/\\]/).filter(Boolean)
  const fileName = segments[segments.length - 1] ?? ''
  const dirName = segments[segments.length - 2] ?? ''

  return {
    path,
    dirName,
    fileName,
    durationSec,
    embeddedLangs,
    structureHints: {
      title: identity.title,
      year: identity.year,
      season: identity.season,
      episode: identity.episode,
      absoluteEpisode: identity.absoluteEpisode,
      isTv: identity.isTv,
      embeddedTmdbId: identity.embeddedTmdbId,
    },
  }
}
