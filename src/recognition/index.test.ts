import { describe, it, expect, vi } from 'vitest'
import { recognize } from './index.js'
import type { TmdbSearchHit } from '../adapters/providers/tmdb.js'

// recognize 不再做 TMDB 搜索（身份裁决已上移到 agent 的 write_identified_media，本层只出结构
// 提示）——tmdb 参数仅为过渡期调用点兼容保留，任何一次触碰都直接算测试失败。
const tmdb = {
  search: vi.fn(async (): Promise<TmdbSearchHit[]> => {
    throw new Error('recognize must not search TMDB')
  }),
}

describe('recognize — pure mechanical parse, structure hints only (no TMDB search)', () => {
  it('structured TV path → PathIdentity straight from identifyFromPath', () => {
    const result = recognize('间谍过家家/Season 1/ep 1.mp4', tmdb)
    expect(result).toEqual({
      title: '间谍过家家', year: null, season: 1, episode: 1,
      absoluteEpisode: null, isTv: true, embeddedTmdbId: null,
    })
    expect(tmdb.search).not.toHaveBeenCalled()
  })

  it('movie path with a year token → PathIdentity carrying the year hint', () => {
    const result = recognize('movies/Hero.2002.1080p.BluRay.mkv', tmdb)
    expect(result).toEqual({
      title: 'Hero', year: 2002, season: null, episode: null,
      absoluteEpisode: null, isTv: false, embeddedTmdbId: null,
    })
  })

  it('no-signal path → park passes through unchanged', () => {
    expect(recognize('movies/aaa/bbb.mkv', tmdb)).toEqual({ park: 'no-signal' })
    expect(tmdb.search).not.toHaveBeenCalled()
  })

  it('embedded [tmdbid-N] tag comes through as the embeddedTmdbId structure hint', () => {
    const result = recognize('Show [tmdbid-65930]/Season 1/ep 1.mp4', tmdb)
    expect(result).toMatchObject({ season: 1, episode: 1, isTv: true, embeddedTmdbId: '65930' })
    expect(tmdb.search).not.toHaveBeenCalled()
  })
})

// identify_overrides 消歧前查：认领（人工/agent）是权威身份——命中即把 tmdbId 落到
// embeddedTmdbId 通道返回，认领带上的 season/episode 覆盖路径结构；路径无结构（park）时
// 认领单独撑起一个最小 PathIdentity（旧 "no-signal park 永远救不回" 的 Bug 1 保持修复态）。
describe('recognize — identify_overrides consult (opts.findOverride)', () => {
  it('override hit → embeddedTmdbId from the claim, structure still from the path', () => {
    const findOverride = vi.fn(() => ({ tmdbId: '999', isTv: true }))
    const result = recognize('间谍过家家/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      title: '间谍过家家', year: null, season: 1, episode: 1,
      absoluteEpisode: null, isTv: true, embeddedTmdbId: '999',
    })
    expect(findOverride).toHaveBeenCalledWith('间谍过家家/Season 1/ep 1.mp4')
    expect(tmdb.search).not.toHaveBeenCalled()
  })

  it('override with season → claimed season wins over path structure (the live DxD case: Hero = season 4)', () => {
    const path = '/media/TV/High School D×D/[The-Nut] High School DxD Hero - 01.mkv'
    const findOverride = vi.fn(() => ({ tmdbId: '24240', isTv: true, season: 4 }))
    const result = recognize(path, tmdb, { findOverride })
    expect(result).toEqual({
      title: 'High School DxD Hero', year: null, season: 4, episode: null,
      absoluteEpisode: 1, isTv: true, embeddedTmdbId: '24240',
    })
  })

  it('override with episode → claimed episode wins over path structure', () => {
    const findOverride = vi.fn(() => ({ tmdbId: '1', isTv: true, episode: 12 }))
    const result = recognize('Show/Season 2/ep 3.mp4', tmdb, { findOverride })
    expect(result).toMatchObject({ season: 2, episode: 12, embeddedTmdbId: '1' })
  })

  it('no-signal park + override hit → minimal PathIdentity synthesized from the claim alone', () => {
    const findOverride = vi.fn(() => ({ tmdbId: '1', isTv: false }))
    const result = recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({
      title: null, year: null, season: null, episode: null,
      absoluteEpisode: null, isTv: false, embeddedTmdbId: '1',
    })
    expect(findOverride).toHaveBeenCalledWith('movies/aaa/bbb.mkv')
  })

  it('no-signal park + override with season/episode → synthesized PathIdentity carries them', () => {
    const findOverride = vi.fn(() => ({ tmdbId: '24240', isTv: true, season: 4, episode: 1 }))
    const result = recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({
      title: null, year: null, season: 4, episode: 1,
      absoluteEpisode: null, isTv: true, embeddedTmdbId: '24240',
    })
  })

  it('override miss (findOverride returns null) → falls back to pure mechanical parse', () => {
    const findOverride = vi.fn(() => null)
    const result = recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({ park: 'no-signal' })
    expect(findOverride).toHaveBeenCalledWith('movies/aaa/bbb.mkv')
    expect(tmdb.search).not.toHaveBeenCalled()
  })

  it('no opts passed at all → pure mechanical parse (backward compatible)', () => {
    const result = recognize('间谍过家家/Season 1/ep 1.mp4', tmdb)
    expect(result).toEqual({
      title: '间谍过家家', year: null, season: 1, episode: 1,
      absoluteEpisode: null, isTv: true, embeddedTmdbId: null,
    })
  })
})
