import { describe, it, vi, beforeEach, afterEach } from 'vitest'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { makeWriteIdentityTool } from './identityTools.js'
import type { ScoutDb } from '../v2/db.js'

// 注（与任务书原文的两处最小偏差，均被 repo 现实强制）：
// 1. lib.getSeries/getMovie/getEpisode 未命中返回 null（非 undefined）——ghost 断言用 toBeNull()；
//    与 libraryRepo.test.ts 既有口径一致（`expect(lib.getSeries('nope')).toBeNull()`）。
// 2. 行形状是 snake_case（series.chinese_title / episode.sub_status）——断言按真实列名写。
// 3. tool.execute 在 ai SDK v7 类型上需要第二参 ToolExecutionOptions——传 `{} as any`，
//    同 rescueWorker.tools.test.ts / findSubtitleWorker.tools.test.ts 的既有写法（CI 跑 tsc --noEmit）。

describe('write_identified_media', () => {
  let db: ScoutDb
  let lib: LibraryRepo

  beforeEach(() => {
    db = openDb(':memory:')
    lib = new LibraryRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates series and episode rows for TV identification', async ({ expect }) => {
    // Park a path first
    lib.upsertParkedPath(
      '/media/tv/Show.S01E05.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['eng'] }
    )

    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: '/poster.jpg',
        backdropPath: '/backdrop.jpg',
        overview: 'A great show',
        year: 2020,
        genreIds: [18, 80],
        originalTitle: 'Original Show',
      }),
      getChineseTitles: vi.fn().mockResolvedValue(['中文剧名']),
      getExternalIds: vi.fn().mockResolvedValue({ imdbId: 'tt1234567' }),
      getOriginLanguage: vi.fn().mockResolvedValue('en-US'),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb })

    const result = await tool.execute({
      tmdbId: '12345',
      isTv: true,
      title: 'Show',
      season: 1,
      episode: 5,
      path: '/media/tv/Show.S01E05.mkv',
      embeddedLangs: ['eng'],
    }, {} as any)

    expect(result).toContain('tmdb:12345')
    expect(result).toContain('s1e5')

    const series = lib.getSeries('tmdb:12345')
    expect(series).toBeDefined()
    expect(series?.name).toBe('Show')
    expect(series?.year).toBe(2020)
    expect(series?.chinese_title).toBe('中文剧名')

    const episode = lib.getEpisode('tmdb:12345/s1e5')
    expect(episode).toBeDefined()
    expect(episode?.path).toBe('/media/tv/Show.S01E05.mkv')
    expect(episode?.season).toBe(1)
    expect(episode?.episode).toBe(5)
    expect(episode?.sub_status).toBe('embedded')

    // Parked path should be cleared
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Show.S01E05.mkv')
    expect(parked).toBeUndefined()

    expect(tmdb.getDetails).toHaveBeenCalledWith('tv', '12345')
  })

  it('creates movie row for movie identification', async ({ expect }) => {
    lib.upsertParkedPath(
      '/media/movies/Film.2021.mkv',
      'awaiting-agent-identification',
      1000,
      // fingerprint.embeddedLangs 省略 = 本次未探测（存 NULL），语义等同任务书原文的 null——
      // ParkedPathFingerprint.embeddedLangs 类型是 string[]（无 null），strict 下 null 不可赋。
      { mtimeMs: 500, size: 2048, durationSec: 7200 }
    )

    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: '/poster.jpg',
        backdropPath: null,
        overview: 'A film',
        year: 2021,
        genreIds: [28],
        originalTitle: 'Original Film',
      }),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue({ imdbId: 'tt7654321' }),
      getOriginLanguage: vi.fn().mockResolvedValue('en-US'),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb })

    const result = await tool.execute({
      tmdbId: '67890',
      isTv: false,
      title: 'Film',
      season: null,
      episode: null,
      path: '/media/movies/Film.2021.mkv',
      embeddedLangs: null,
    }, {} as any)

    expect(result).toContain('tmdb:67890')

    const movie = lib.getMovie('tmdb:67890')
    expect(movie).toBeDefined()
    expect(movie?.name).toBe('Film')
    expect(movie?.path).toBe('/media/movies/Film.2021.mkv')
    expect(movie?.year).toBe(2021)

    const parked = lib.listParkedPaths().find(p => p.path === '/media/movies/Film.2021.mkv')
    expect(parked).toBeUndefined()
  })

  it('REFUSES to create rows when tmdbId does not exist (404) - hallucination defense', async ({ expect }) => {
    lib.upsertParkedPath(
      '/media/tv/Fake.Show.S01E01.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['eng'] }
    )

    const tmdb = {
      getDetails: vi.fn().mockResolvedValue(null), // 404
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb })

    await expect(tool.execute({
      tmdbId: '99999999',
      isTv: true,
      title: 'Fake Show',
      season: 1,
      episode: 1,
      path: '/media/tv/Fake.Show.S01E01.mkv',
      embeddedLangs: ['eng'],
    }, {} as any)).rejects.toThrow(/does not exist/i)

    // Verify no rows created
    expect(lib.getSeries('tmdb:99999999')).toBeNull()

    // Verify parked path still there (not cleared)
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Fake.Show.S01E01.mkv')
    expect(parked).toBeDefined()
  })

  it('rejects TV identification without season/episode', async ({ expect }) => {
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: null,
        backdropPath: null,
        overview: 'Test',
        year: 2020,
        genreIds: [],
        originalTitle: 'Test',
      }),
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb })

    await expect(tool.execute({
      tmdbId: '12345',
      isTv: true,
      title: 'Show',
      season: null, // Missing!
      episode: null,
      path: '/media/tv/Show.mkv',
      embeddedLangs: null,
    }, {} as any)).rejects.toThrow(/season.*episode/i)
  })
})
