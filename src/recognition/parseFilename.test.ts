import { describe, it, expect } from 'vitest'
import { parseFilename } from './parseFilename.js'

describe('parseFilename — anime absolute episode', () => {
  it('fansub bracket + absolute episode number (no season context)', () => {
    const r = parseFilename('[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(r.title).toContain('My Hero Academia')
    expect(r.absoluteEpisode).toBe(26)
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(true)
  })

  it('CJK title + fansub bracket + absolute episode number', () => {
    // Documents real behavior on a CJK title, not just ASCII — the lib title-cleans by
    // separator tokens, not by script, so CJK passes through unmangled.
    const r = parseFilename('[SubGroup] 间谍过家家 - 05 [ABCD1234].mkv')
    expect(r.title).toBe('间谍过家家')
    expect(r.absoluteEpisode).toBe(5)
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(true)
  })
})

describe('parseFilename — standard TV', () => {
  it('SxxExx with quality tags', () => {
    const r = parseFilename('Show.Name.S01E05.1080p.WEB-DL.mkv')
    expect(r.title).toContain('Show Name')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(true)
  })

  it('multi-episode file surfaces only the first episode number', () => {
    // @ctrl/video-filename-parser reports episodeNumbers as a range ([5, 6] here); multi-episode
    // spans are out of scope for this wrapper (left for a future task if ever needed).
    const r = parseFilename('Show.Name.S01E05E06.1080p.WEB-DL.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
  })
})

describe('parseFilename — movie with quality-token digits (live NAS regression)', () => {
  // The lib's anime absolute-episode pattern eats the '10' out of '10bit', returning an
  // ABSOLUTE-ONLY tv parse (seasons empty) for what is plainly a movie — which downstream (C3)
  // sends to /search/tv where it can never match. The wrapper must prefer the movie
  // interpretation whenever the tv parse is absolute-only AND the movie parse independently
  // recovered a finite year. Genuine anime absolute files stay safe: their movie-mode parse
  // never yields a finite year (the bracketed fansub hash fails toYear's Number.isFinite guard).
  it('Kraven: "10bit" digits must not become an absolute episode when a movie year is present', () => {
    const r = parseFilename('Kraven the Hunter (2024) (2160p BluRay x265 10bit DV HDR r00t).mkv')
    expect(r.title).toBe('Kraven the Hunter')
    expect(r.year).toBe(2024)
    expect(r.isTv).toBe(false)
    expect(r.absoluteEpisode).toBeNull()
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  it('Conjuring variant: same 10bit misread, movie year wins', () => {
    const r = parseFilename('The Conjuring Last Rites (2025) (2160p BluRay x265 10bit DV HDR).mkv')
    expect(r.title).toBe('The Conjuring Last Rites')
    expect(r.year).toBe(2025)
    expect(r.isTv).toBe(false)
    expect(r.absoluteEpisode).toBeNull()
  })

  it('regression anchor: genuine anime absolute file (no finite movie year) keeps the TV-absolute path', () => {
    const r = parseFilename('[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(r.absoluteEpisode).toBe(26)
    expect(r.isTv).toBe(true)
    expect(r.year).toBeNull()
  })
})

describe('parseFilename — movie', () => {
  it('title + year, no season/episode', () => {
    const r = parseFilename('Hero.2002.1080p.BluRay.mkv')
    expect(r.title).toBe('Hero')
    expect(r.year).toBe(2002)
    expect(r.isTv).toBe(false)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  it('plain "title (year)" segment with no other release tokens', () => {
    const r = parseFilename('SPY x FAMILY (2022)')
    expect(r.title).toBe('SPY x FAMILY')
    expect(r.year).toBe(2022)
    expect(r.isTv).toBe(false)
  })

  it('bare CJK title segment, no year/quality tokens', () => {
    const r = parseFilename('间谍过家家')
    expect(r.title).toBe('间谍过家家')
    expect(r.year).toBeNull()
    expect(r.isTv).toBe(false)
  })
})

describe('parseFilename — bare directory segments (IMPORTANT: known gap, see report)', () => {
  it('bare "Season N" segment does NOT parse as a season — C2 must handle season folders itself', () => {
    // @ctrl/video-filename-parser's season-only patterns all require a title token before
    // "Season N" (e.g. "Show Name Season 2"); a bare "Season 2" folder segment matches none of
    // them, so parseSeason() returns null and the wrapper falls back to the movie parse, which
    // has no year/season concept either — it just echoes the string back as a literal title.
    const r = parseFilename('Season 2')
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(false)
    expect(r.title).toBe('Season 2')
  })
})
