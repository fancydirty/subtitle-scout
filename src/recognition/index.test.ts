import { describe, it, expect, vi } from 'vitest'
import { recognize } from './index.js'
import { TmdbClient, TmdbRequestFailedError } from '../adapters/providers/tmdb.js'

function mkTmdb(fetchImpl: typeof fetch) {
  return new TmdbClient({ apiKey: 'a'.repeat(32), fetchImpl })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('recognize — park at the path-identity stage short-circuits TMDB entirely', () => {
  it('no-signal path never touches tmdb.search', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('movies/aaa/bbb.mkv', tmdb)
    expect(result).toEqual({ park: 'no-signal' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('recognize — happy path, full path-to-Recognized chain', () => {
  it('Show/Season NN/file layout resolves via a unique TMDB hit', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      expect(String(url)).toContain('/search/tv')
      return jsonResponse({
        results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
      })
    })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb)
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('recognize — park at the TMDB-resolution stage still passes through', () => {
  it('a well-formed identity with zero TMDB hits parks no-match (not path-level park)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('movies/Hero.2002.1080p.BluRay.mkv', tmdb)
    expect(result).toEqual({ park: 'no-match' })
    // one call with the scraped year, one retry without it — proves resolveToTmdb actually ran.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('recognize — transient TMDB failure propagates, is not swallowed into a park', () => {
  it('TmdbRequestFailedError from tmdb.search rejects recognize() rather than parking', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    await expect(recognize('movies/Hero.2002.1080p.BluRay.mkv', tmdb)).rejects.toThrow(TmdbRequestFailedError)
  })
})

// 去 Jellyfin 化 P6（identify_overrides 消歧前查）：opts.findOverride 是识别层唯一的覆盖表消费点。
describe('recognize — identify_overrides consult (opts.findOverride)', () => {
  it('override hit short-circuits TMDB search entirely — no network call', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '999', isTv: true }))
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '999', title: '间谍过家家', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(findOverride).toHaveBeenCalledWith('间谍过家家/Season 1/ep 1.mp4')
  })

  it('override isTv wins over path structure, but season/episode/absoluteEpisode still come from the path', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '42', isTv: false }))
    const result = await recognize('Show/Season 2/ep 3.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '42', title: 'Show', isTv: false, season: 2, episode: 3, absoluteEpisode: null,
    })
  })

  it('embedded [tmdbid-N] tag still wins first — override is never consulted', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '999', isTv: true }))
    const result = await recognize('Show [tmdbid-65930]/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect((result as { tmdbId: string }).tmdbId).toBe('65930')
    expect(findOverride).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no override hit (findOverride returns null) → falls through to normal TMDB search disambiguation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => null)
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('no opts passed at all → unchanged existing behavior (backward compatible)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ id: 108964, name: 'Spy x Family', first_air_date: '2022-04-09' }],
    }))
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('间谍过家家/Season 1/ep 1.mp4', tmdb)
    expect(result).toEqual({
      tmdbId: '108964', title: 'Spy x Family', isTv: true, season: 1, episode: 1, absoluteEpisode: null,
    })
  })

  it('no-signal park + no override hit (findOverride returns null) → still parks no-signal (override IS consulted now, just misses)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => null)
    const result = await recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({ park: 'no-signal' })
    expect(findOverride).toHaveBeenCalledWith('movies/aaa/bbb.mkv')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no-signal park + no opts at all (no findOverride passed) → unchanged existing behavior', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const result = await recognize('movies/aaa/bbb.mkv', tmdb)
    expect(result).toEqual({ park: 'no-signal' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Bug 1（真库闸门发现）：identify_overrides 救不回 'no-signal' park —— identifyFromPath 找不到
// 任何路径结构时 recognize() 过去直接短路返回 park，从不咨询覆盖表，人工认领永远够不着这一类
// park（偏偏它最需要救援：能被机械层解析出结构的 park 早晚能等到更好的命名；真正解析不出
// 任何结构的 fansub 命名，只有人工认领这一条出路）。修复：无论 identity 是否 park，都咨询
// 一次 override；命中 + park 时，用"人工已明确认领"这个强信号，做仅限于此处的宽松解析
// （absolute episode 的末尾数字提取），换取一个可用的 Recognized——philosophy：宽松解析只在
// 人工认领已经明确背书时才生效，无人值守路径（identity 非 park 或根本没有 override）永远不
// 触发这条宽松规则。
describe('recognize — Bug 1 fix: identify_overrides rescues a no-signal park (claim-gated lenient parsing)', () => {
  it('no-signal park + TV override (no season given) + a trailing episode number → Recognized via lenient extraction, marked viaOverrideLenient (season/episode null, ambiguous numbering left to ingest layer)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const path = '/media/TV/High School D×D/[The-Nut] High School DxD Hero - 01.mkv'
    const findOverride = vi.fn(() => ({ tmdbId: '24240', isTv: true, season: null }))
    const result = await recognize(path, tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '24240', title: '', isTv: true, season: null, episode: null, absoluteEpisode: 1,
      viaOverrideLenient: true,
    })
    expect(findOverride).toHaveBeenCalledWith(path)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no-signal park + movie override + a structureless name → Recognized (movie needs no episode number at all)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '1', isTv: false }))
    const result = await recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '1', title: '', isTv: false, season: null, episode: null, absoluteEpisode: null,
    })
  })

  it('no-signal park + TV override + a genuinely numberless name → still parks, but honestly (override-no-structure)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '1', isTv: true }))
    const result = await recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({ park: 'override-no-structure' })
  })

  // P7 disambiguation 补丁：认领时人类一并给出 season → 裸数字直接就是"该季内集号"，完全无歧义，
  // 不需要 ingest 层的多季守卫（不带 viaOverrideLenient 标记）。
  it('no-signal park + TV override WITH season → Recognized as an exact (season, episode) pair, no ambiguity marker (the live DxD case: Hero = season 4)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const path = '/media/TV/High School D×D/[The-Nut] High School DxD Hero - 01.mkv'
    const findOverride = vi.fn(() => ({ tmdbId: '24240', isTv: true, season: 4 }))
    const result = await recognize(path, tmdb, { findOverride })
    expect(result).toEqual({
      tmdbId: '24240', title: '', isTv: true, season: 4, episode: 1, absoluteEpisode: null,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no-signal park + TV override WITH season + a numberless name → still parks honestly (season alone is not an episode signal)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('should not be called') })
    const tmdb = mkTmdb(fetchImpl as unknown as typeof fetch)
    const findOverride = vi.fn(() => ({ tmdbId: '1', isTv: true, season: 4 }))
    const result = await recognize('movies/aaa/bbb.mkv', tmdb, { findOverride })
    expect(result).toEqual({ park: 'override-no-structure' })
  })
})
