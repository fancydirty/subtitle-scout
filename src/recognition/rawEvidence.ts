import type { PathIdentity } from './identifyFromPath.js'

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
  }
}

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
    },
  }
}
