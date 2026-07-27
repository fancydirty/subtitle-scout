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
// 4. embeddedLangs 不是工具输入（agent 可幻觉，权威源是 parked_paths.embedded_langs 的
//    ffprobe raw 数据）——测试只通过 upsertParkedPath 的 fingerprint 播种。

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
    // Park a path first —— fingerprint 带 ffprobe 探测到的内嵌轨语言
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
    // embedded_langs 权威源是 parked 行（['eng']）→ embedded
    expect(episode?.sub_status).toBe('embedded')

    // 探针记忆化同样来自 parked 行（mtime/size/langs 三元组）
    const memo = lib.probeMemo('tmdb:12345/s1e5')
    expect(memo).toEqual({ mtime: 500, size: 1024, langs: ['eng'] })

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
    }, {} as any)

    expect(result).toContain('tmdb:67890')

    const movie = lib.getMovie('tmdb:67890')
    expect(movie).toBeDefined()
    expect(movie?.name).toBe('Film')
    expect(movie?.path).toBe('/media/movies/Film.2021.mkv')
    expect(movie?.year).toBe(2021)
    // parked 行 embedded_langs 为 NULL（未探测）→ missing
    expect(movie?.sub_status).toBe('missing')
    // 未探测 → 不落探针记忆
    expect(lib.probeMemo('tmdb:67890')).toBeNull()

    const parked = lib.listParkedPaths().find(p => p.path === '/media/movies/Film.2021.mkv')
    expect(parked).toBeUndefined()
  })

  it('parked.embedded_langs is authoritative — subStatus follows DB, not agent claims', async ({ expect }) => {
    // 两条 parked：一条 ffprobe 探到内嵌轨，一条没探到。输入 schema 已无 embeddedLangs
    // 字段——agent 无法自报，sub_status 只能来自 parked 行。
    lib.upsertParkedPath(
      '/media/tv/HasTrack.S01E01.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['chi'] }
    )
    lib.upsertParkedPath(
      '/media/tv/NoTrack.S01E02.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400 } // 未探测 → NULL
    )

    const details = {
      posterPath: null,
      backdropPath: null,
      overview: 'Show',
      year: 2020,
      genreIds: [],
      originalTitle: 'Show',
    }
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue(details),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue(null),
      getOriginLanguage: vi.fn().mockResolvedValue(null),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb })

    await tool.execute({
      tmdbId: '111',
      isTv: true,
      title: 'HasTrack',
      season: 1,
      episode: 1,
      path: '/media/tv/HasTrack.S01E01.mkv',
    }, {} as any)

    await tool.execute({
      tmdbId: '222',
      isTv: true,
      title: 'NoTrack',
      season: 1,
      episode: 2,
      path: '/media/tv/NoTrack.S01E02.mkv',
    }, {} as any)

    expect(lib.getEpisode('tmdb:111/s1e1')?.sub_status).toBe('embedded')
    expect(lib.probeMemo('tmdb:111/s1e1')).toEqual({ mtime: 500, size: 1024, langs: ['chi'] })

    expect(lib.getEpisode('tmdb:222/s1e2')?.sub_status).toBe('missing')
    expect(lib.probeMemo('tmdb:222/s1e2')).toBeNull()
  })

  it('unparked path (no DB row) falls back to missing, never embedded', async ({ expect }) => {
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: null,
        backdropPath: null,
        overview: 'Film',
        year: 2021,
        genreIds: [],
        originalTitle: 'Film',
      }),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue(null),
      getOriginLanguage: vi.fn().mockResolvedValue(null),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb })

    await tool.execute({
      tmdbId: '333',
      isTv: false,
      title: 'Film',
      season: null,
      episode: null,
      path: '/media/movies/NeverParked.mkv',
    }, {} as any)

    expect(lib.getMovie('tmdb:333')?.sub_status).toBe('missing')
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
    }, {} as any)).rejects.toThrow(/does not exist/i)

    // Verify no rows created
    expect(lib.getSeries('tmdb:99999999')).toBeNull()

    // Verify parked path still there (not cleared)
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Fake.Show.S01E01.mkv')
    expect(parked).toBeDefined()
  })

  it('rejects TV identification without season/episode BEFORE any TMDB call', async ({ expect }) => {
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
    }, {} as any)).rejects.toThrow(/season.*episode/i)

    // 校验在 getDetails 之前——必败的请求不烧 TMDB 配额
    expect(tmdb.getDetails).not.toHaveBeenCalled()
  })
})

// 🔴 identityEval 六轮血案的回归锁（2026-07-27）：原 schema 用
// z.number().int().nullable() 收 season/episode，真模型六种发法五种被拒 —— agent 想调
// 写库工具却调不进去，把失败写进 finalize 的 reason，而我误判成"agent 不听话"，
// 往 skill 里加了三轮措辞全打在空处。这组测试钉死六种发法都必须收得下。
describe('write_identified_media inputSchema 的真模型编码容错（六轮血案回归锁）', () => {
  const variants: Array<[string, Record<string, unknown>, { season: number | null; episode: number | null }]> = [
    ['JSON null（标准）', { season: null, episode: null }, { season: null, episode: null }],
    ['省略键（真模型对 nullable 最常见的发法）', {}, { season: null, episode: null }],
    ['"None"（Python 风格字符串）', { season: 'None', episode: 'None' }, { season: null, episode: null }],
    ['"null"（JS 风格字符串）', { season: 'null', episode: 'null' }, { season: null, episode: null }],
    ['空字符串', { season: '', episode: '' }, { season: null, episode: null }],
    ['字符串数字（TV case 常见）', { season: '4', episode: '9' }, { season: 4, episode: 9 }],
  ]

  for (const [label, seasonEpisode, expected] of variants) {
    it(`收得下：${label}`, ({ expect }) => {
      const tool = makeWriteIdentityTool({ lib: {} as never, tmdb: {} as never })
      const parsed = tool.inputSchema!.safeParse({
        tmdbId: '14161', isTv: false, title: '2012', path: '/media/movies/2012.mkv',
        ...seasonEpisode,
      })
      expect(parsed.success, `被拒了：${label}`).toBe(true)
      if (parsed.success) {
        expect((parsed.data as { season: number | null }).season).toBe(expected.season)
        expect((parsed.data as { episode: number | null }).episode).toBe(expected.episode)
      }
    })
  }
})
