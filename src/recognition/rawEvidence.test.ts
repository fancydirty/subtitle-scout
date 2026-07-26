import { describe, it } from 'vitest'
import { buildRawEvidence } from './rawEvidence.js'
import type { PathIdentity } from './identifyFromPath.js'

describe('buildRawEvidence', () => {
  it('extracts dirName and fileName from path', ({ expect }) => {
    const identity: PathIdentity = {
      title: 'Test',
      year: 2020,
      season: 1,
      episode: 1,
      absoluteEpisode: null,
      isTv: true,
      embeddedTmdbId: null,
    }

    const raw = buildRawEvidence(
      '/media/tv/Test.S01E01.mkv',
      identity,
      3600,
      ['eng', 'jpn'],
    )

    expect(raw.dirName).toBe('tv')
    expect(raw.fileName).toBe('Test.S01E01.mkv')
    expect(raw.durationSec).toBe(3600)
    expect(raw.embeddedLangs).toEqual(['eng', 'jpn'])
    expect(raw.structureHints.season).toBe(1)
    expect(raw.structureHints.episode).toBe(1)
  })

  it('handles Windows backslash paths', ({ expect }) => {
    const identity: PathIdentity = {
      title: 'Movie',
      year: 2021,
      season: null,
      episode: null,
      absoluteEpisode: null,
      isTv: false,
      embeddedTmdbId: null,
    }

    const raw = buildRawEvidence(
      'D:\\Movies\\Movie.2021.mkv',
      identity,
      7200,
      null,
    )

    expect(raw.dirName).toBe('Movies')
    expect(raw.fileName).toBe('Movie.2021.mkv')
  })
})
