import { describe, it, expect } from 'vitest'
import { identifyFromPath, type Park, type PathIdentity } from './identifyFromPath.js'

function isPark(result: PathIdentity | Park): result is Park {
  return 'park' in result
}

describe('identifyFromPath — Show/Season NN/file layout', () => {
  it('grandparent title + season-folder parent + bare-episode file (CJK title)', () => {
    const r = identifyFromPath('间谍过家家/Season 1/ep 1.mp4')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('间谍过家家')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(1)
    expect(identity.isTv).toBe(true)
  })

  it('embedded [tmdbid-N] short-circuits search but season/episode still merge from structure', () => {
    const r = identifyFromPath('Show (2016) [tmdbid-65930]/Season 02/Show S02E03.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.embeddedTmdbId).toBe('65930')
    expect(identity.season).toBe(2)
    expect(identity.episode).toBe(3)
    expect(identity.title).toBe('Show')
    expect(identity.year).toBe(2016)
    expect(identity.isTv).toBe(true)
  })

  it('CJK bare-episode fallback via "第N话" marker inside a season folder', () => {
    const r = identifyFromPath('间谍过家家/Season 2/第3话.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('间谍过家家')
    expect(identity.season).toBe(2)
    expect(identity.episode).toBe(3)
    expect(identity.isTv).toBe(true)
  })

  it('"Specials" folder maps to season 0, bare-episode file still resolves against it', () => {
    const r = identifyFromPath('间谍过家家/Specials/ep 1.mp4')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('间谍过家家')
    expect(identity.season).toBe(0)
    expect(identity.episode).toBe(1)
    expect(identity.isTv).toBe(true)
  })
})

describe('identifyFromPath — Show/file.mkv layout (no season folder)', () => {
  it('title comes from the parent dir when the file segment has no movie-like year', () => {
    const r = identifyFromPath('Breaking Bad/Breaking.Bad.S01E05.720p.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
    expect(identity.isTv).toBe(true)
  })

  it('anime absolute numbering: title from parent dir, absoluteEpisode from the file, no season', () => {
    const r = identifyFromPath('My Hero Academia/[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('My Hero Academia')
    expect(identity.absoluteEpisode).toBe(26)
    expect(identity.season).toBeNull()
    expect(identity.isTv).toBe(true)
  })
})

describe('identifyFromPath — flat movie layout', () => {
  it('title+year come from the FILE segment, not the "movies" category-root parent', () => {
    const r = identifyFromPath('movies/Hero.2002.1080p.BluRay.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Hero')
    expect(identity.year).toBe(2002)
    expect(identity.isTv).toBe(false)
    expect(identity.season).toBeNull()
    expect(identity.episode).toBeNull()
  })
})

describe('identifyFromPath — park on no signal', () => {
  it('no embedded id, no season/episode/absoluteEpisode, no year anywhere -> parked', () => {
    const r = identifyFromPath('movies/aaa/bbb.mkv')
    expect(r).toEqual({ park: 'no-signal' })
  })
})

describe('identifyFromPath — path-string edge cases (node:path posix handling)', () => {
  it('Windows-style backslash path resolves the same as its POSIX equivalent', () => {
    const r = identifyFromPath('C:\\Media\\Breaking Bad\\Breaking.Bad.S01E05.720p.mkv')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
  })

  it('absolute POSIX path with a leading slash and a stray trailing slash both resolve fine', () => {
    const r = identifyFromPath('/mnt/media/Breaking Bad/Breaking.Bad.S01E05.720p.mkv/')
    expect(isPark(r)).toBe(false)
    const identity = r as PathIdentity
    expect(identity.title).toBe('Breaking Bad')
    expect(identity.season).toBe(1)
    expect(identity.episode).toBe(5)
  })
})
