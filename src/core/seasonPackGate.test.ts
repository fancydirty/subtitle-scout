import { describe, it, expect } from 'vitest'
import { runSeasonPackGate } from './seasonPackGate.js'
import type { SeasonEpisode } from './episode.js'

function ep(n: number, needs = true): SeasonEpisode {
  return { itemId: `it${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E${String(n).padStart(2,'0')}`,
    videoPath: `/media/tv/Show/Season 2/Show.S02E${String(n).padStart(2,'0')}.mkv`,
    videoFilename: `Show.S02E${String(n).padStart(2,'0')}.mkv`, needsChinese: needs }
}
const seasonEps = [ep(1), ep(2), ep(3)]
const filelist = [
  { f: 'Show.S02E01.chs.ass', url: 'http://a/1' },
  { f: 'Show.S02E02.chs.ass', url: 'http://a/2' },
  { f: 'Show.S02E03.chs.ass', url: 'http://a/3' },
  { f: 'readme.txt', url: 'http://a/r' },
]

describe('runSeasonPackGate', () => {
  it('commits valid pairs joined by episode_code (not position)', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
    expect(r.commit.find(c => c.episodeCode === 'S02E01')!.downloadUrl).toBe('http://a/1')
    expect(r.commit.find(c => c.episodeCode === 'S02E01')!.videoFilename).toBe('Show.S02E01.mkv')
  })
  it('a missing episode leaves it uncovered without shifting others', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 2, episode_code: 'S02E03', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E03'])
  })
  it('drops pairs whose episode_code is not in the Jellyfin season set', () => {
    const map = { pairs: [{ filelist_index: 0, episode_code: 'S02E99', reason: 'special' }], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit).toEqual([])
    expect(r.dropped.some(d => /not in season/i.test(d.reason))).toBe(true)
  })
  it('drops out-of-range filelist_index and non-subtitle extensions', () => {
    const map = { pairs: [
      { filelist_index: 99, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 3, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit).toEqual([])
  })
  it('dedups a duplicate episode_code by keeping the FIRST occurrence in pairs[] order (no confidence to compare)', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'first' },
      { filelist_index: 1, episode_code: 'S02E01', reason: 'second' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit.length).toBe(1)
    expect(r.commit[0].filelistIndex).toBe(0)
    expect(r.dropped.some(d => /duplicate episode_code/i.test(d.reason))).toBe(true)
  })
  it('drops non-integer filelist_index cleanly (no crash)', () => {
    const map = { pairs: [
      { filelist_index: 1.5, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: NaN, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit).toEqual([])
    expect(r.dropped.length).toBe(2)
  })
  it('only covers episodes that still need Chinese (skips already-subbed)', () => {
    const eps = [ep(1, true), ep(2, false)]
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: eps })
    expect(r.commit.map(c => c.episodeCode)).toEqual(['S02E01'])
  })
})
