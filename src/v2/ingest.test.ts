import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { SettingsRepo } from './settingsRepo.js'
import { makeIngestPass, ingestLock, looksChineseTitle, classifyStatError, type IngestDeps } from './ingest.js'
import type { Recognized, Park } from '../recognition/index.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'
import { TmdbRequestFailedError } from '../adapters/providers/tmdb.js'

let db: ScoutDb
let lib: LibraryRepo

beforeEach(() => {
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
})

function tvResult(overrides: Partial<Recognized> = {}): Recognized {
  return { tmdbId: '1', title: 'Show', isTv: true, season: 1, episode: 1, absoluteEpisode: null, ...overrides }
}
function movieResult(overrides: Partial<Recognized> = {}): Recognized {
  return { tmdbId: '603', title: 'Movie', isTv: false, season: null, episode: null, absoluteEpisode: null, ...overrides }
}
function track(overrides: Partial<EmbeddedSubtitleTrack> = {}): EmbeddedSubtitleTrack {
  return { lang: null, codec: null, isImageBased: false, ...overrides }
}

interface FakeTmdbOpts {
  getOriginLanguage?: (mediaType: 'tv' | 'movie', id: string) => Promise<string | null>
  getDetails?: (mediaType: 'tv' | 'movie', id: string) => Promise<TmdbDetails | null>
  getChineseTitles?: (mediaType: 'tv' | 'movie', id: string) => Promise<string[]>
  getExternalIds?: (mediaType: 'tv' | 'movie', id: string) => Promise<{ imdbId: string | null }>
  getSeasonTable?: (tvId: string) => Promise<{ seasonNumber: number; episodeCount: number; airDate: string | null }[] | null>
  getAbsoluteOrder?: (tvId: string) => Promise<{ season: number; episode: number }[] | null>
}
function fakeTmdb(opts: FakeTmdbOpts = {}): TmdbClient {
  return {
    getOriginLanguage: opts.getOriginLanguage ?? (async () => null),
    getDetails: opts.getDetails ?? (async () => null),
    getChineseTitles: opts.getChineseTitles ?? (async () => []),
    getExternalIds: opts.getExternalIds ?? (async () => ({ imdbId: null })),
    getSeasonTable: opts.getSeasonTable ?? (async () => null),
    getAbsoluteOrder: opts.getAbsoluteOrder ?? (async () => null),
  } as unknown as TmdbClient
}

/** 磁盘世界的最小内存模拟：显式登记的路径才"存在"，其余一律 404。 */
function fakeDisk() {
  const stats = new Map<string, { mtimeMs: number; size: number }>()
  const sidecars = new Set<string>()
  return {
    setVideo(path: string, mtimeMs = 1000, size = 100) {
      stats.set(path, { mtimeMs, size })
    },
    removeVideo(path: string) {
      stats.delete(path)
    },
    addSidecar(path: string) {
      sidecars.add(path)
    },
    removeSidecar(path: string) {
      sidecars.delete(path)
    },
    statFile: (p: string) => stats.get(p) ?? null,
    fileExists: (p: string) => stats.has(p) || sidecars.has(p),
  }
}

function makeDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    roots: () => ['/media'],
    lib,
    tmdb: fakeTmdb(),
    recognize: vi.fn(async (): Promise<Recognized | Park> => tvResult()),
    probe: vi.fn(async (): Promise<EmbeddedSubtitleTrack[] | null> => []),
    // 重复源 P4b：默认 null——从不在测试里真的 spawn ffprobe（同 probe 的既有约定），需要机械
    // 复制通道真正触发的测试自己覆写。
    probeDuration: vi.fn(async (): Promise<number | null> => null),
    listVideoFiles: () => [],
    fileExists: () => false,
    statFile: () => null,
    targetLanguages: () => ['zh'],
    log: () => {},
    now: () => 1_700_000_000_000,
    ...over,
  }
}

describe('makeIngestPass — new file recognized end-to-end (TV)', () => {
  it('writes series + episode rows with own-id shapes, provider_ids, poster_path, chinese_title', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/Show/Season 1/ep1.mkv', 5000, 12345)
    const tmdb = fakeTmdb({
      getDetails: async () => ({ overview: 'x', runtimeMinutes: 24, posterPath: '/poster.jpg', originalTitle: 'Show OT', year: 2020, genreIds: [] }),
      getChineseTitles: async () => ['演出'],
    })
    const recognize = vi.fn(async () => tvResult({ tmdbId: '108964', title: 'Spy x Family', season: 1, episode: 2 }))
    const probe = vi.fn(async () => [] as EmbeddedSubtitleTrack[])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/Show/Season 1/ep1.mkv'],
      recognize, probe, tmdb,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true })
    const series = lib.getSeries('tmdb:108964')
    expect(series).toMatchObject({
      id: 'tmdb:108964', name: 'Spy x Family', chinese_title: '演出',
      poster_path: '/poster.jpg', year: 2020, provider_ids: JSON.stringify({ tmdb: '108964' }),
    })
    const episode = lib.getEpisode('tmdb:108964/s1e2')
    expect(episode).toMatchObject({
      id: 'tmdb:108964/s1e2', series_id: 'tmdb:108964', season: 1, episode: 2,
      path: '/media/Show/Season 1/ep1.mkv', sub_status: 'missing',
    })
    expect(recognize).toHaveBeenCalledWith('/media/Show/Season 1/ep1.mkv')
    expect(probe).toHaveBeenCalledWith('/media/Show/Season 1/ep1.mkv')
  })
})

describe('makeIngestPass — new file recognized end-to-end (movie)', () => {
  it('writes a movie row with own-id shape, provider_ids, poster_path, chinese_title', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/movies/hero.mkv')
    const tmdb = fakeTmdb({
      getDetails: async () => ({ overview: null, runtimeMinutes: 136, posterPath: '/matrix.jpg', originalTitle: null, year: 1999, genreIds: [] }),
      getChineseTitles: async () => ['黑客帝国', '駭客任務'],
    })
    const recognize = vi.fn(async () => movieResult({ tmdbId: '603', title: 'The Matrix' }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/movies/hero.mkv'],
      recognize, tmdb,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true })
    const movie = lib.getMovie('tmdb:603')
    expect(movie).toMatchObject({
      id: 'tmdb:603', name: 'The Matrix', chinese_title: '黑客帝国', poster_path: '/matrix.jpg',
      year: 1999, path: '/media/movies/hero.mkv', provider_ids: JSON.stringify({ tmdb: '603' }),
      sub_status: 'missing',
    })
  })
})

describe('makeIngestPass — 摄取采集 imdb id（验收修复轮一）', () => {
  it('TV 首次入库：external_ids 有 imdb 时 provider_ids 同时写入 tmdb + imdb', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/Show/Season 1/ep1.mkv')
    const tmdb = fakeTmdb({
      getExternalIds: async () => ({ imdbId: 'tt10872600' }),
    })
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/Show/Season 1/ep1.mkv'],
      tmdb,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const series = lib.getSeries('tmdb:1')
    expect(series).toMatchObject({
      provider_ids: JSON.stringify({ tmdb: '1', imdb: 'tt10872600' }),
    })
  })

  it('movie 首次入库：external_ids 有 imdb 时 provider_ids 同时写入 tmdb + imdb', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/movies/hero.mkv')
    const tmdb = fakeTmdb({
      getExternalIds: async () => ({ imdbId: 'tt0133093' }),
    })
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/movies/hero.mkv'],
      recognize: vi.fn(async () => movieResult({ tmdbId: '603', title: 'The Matrix' })),
      tmdb,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const movie = lib.getMovie('tmdb:603')
    expect(movie).toMatchObject({
      provider_ids: JSON.stringify({ tmdb: '603', imdb: 'tt0133093' }),
    })
  })

  it('external_ids 瞬时失败时，其余富化照常、provider_ids 仍写 tmdb（不拖垮）', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/Show/Season 1/ep1.mkv')
    const tmdb = fakeTmdb({
      getDetails: async () => ({ overview: 'x', runtimeMinutes: 24, posterPath: '/poster.jpg', originalTitle: 'Show', year: 2020, genreIds: [] }),
      getChineseTitles: async () => ['演出'],
      getExternalIds: async () => { throw new TmdbRequestFailedError(new Error('ECONNREFUSED')) },
    })
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/Show/Season 1/ep1.mkv'],
      tmdb,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const series = lib.getSeries('tmdb:1')
    expect(series).toMatchObject({
      provider_ids: JSON.stringify({ tmdb: '1' }),
      poster_path: '/poster.jpg',
      chinese_title: '演出',
      year: 2020,
    })
  })
})
describe('makeIngestPass — park', () => {
  it('a Park outcome writes a parked_paths row, not an episode/movie row', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/junk.mkv')
    const recognize = vi.fn(async (): Promise<Recognized | Park> => ({ park: 'no-match' }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/junk.mkv'],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 0, parked: 1, removed: 0, changed: false })
    const parked = lib.listParkedPaths()
    expect(parked).toEqual([{ path: '/media/junk.mkv', park_reason: 'no-match', first_seen: 1_700_000_000_000, last_attempt: 1_700_000_000_000 }])
  })

  it('TV recognition with no episode number at all (no season structure, no absolute) → park no-episode-number', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/Show/Season 1/junk.mkv')
    const recognize = vi.fn(async () => tvResult({ season: 1, episode: null, absoluteEpisode: null }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/Show/Season 1/junk.mkv'],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    const result = await pass()
    expect(result.parked).toBe(1)
    expect(lib.listParkedPaths()[0].park_reason).toBe('no-episode-number')
  })

  it('absolute-only recognition where TMDB genuinely cannot map it (no episode group, no season table) → park absolute-episode-unresolved', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/Anime/ep-1050.mkv')
    const recognize = vi.fn(async () => tvResult({ season: null, episode: null, absoluteEpisode: 1050 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/Anime/ep-1050.mkv'],
      recognize,
      tmdb: fakeTmdb({ getSeasonTable: async () => null, getAbsoluteOrder: async () => null }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    const result = await pass()
    expect(result.parked).toBe(1)
    expect(lib.listParkedPaths()[0].park_reason).toBe('absolute-episode-unresolved')
  })

  it('absolute number beyond the resolvable range → park absolute-episode-unresolved (never guesses)', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/Anime/ep-1050.mkv')
    const recognize = vi.fn(async () => tvResult({ season: null, episode: null, absoluteEpisode: 1050 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/Anime/ep-1050.mkv'],
      recognize,
      tmdb: fakeTmdb({ getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 12, airDate: null }] }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    const result = await pass()
    expect(result.parked).toBe(1)
    expect(lib.listParkedPaths()[0].park_reason).toBe('absolute-episode-unresolved')
  })
})

describe('makeIngestPass — absolute-episode resolution (anime flat numbering)', () => {
  it('absolute-only recognition resolved via season-table concat → normal episode row with the mapped (season, episode) own-id', async () => {
    const path = '/media/Anime/My Hero Academia/ep 26.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '65930', title: 'My Hero Academia', season: null, episode: null, absoluteEpisode: 26 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({
        getSeasonTable: async () => [
          { seasonNumber: 1, episodeCount: 25, airDate: null },
          { seasonNumber: 2, episodeCount: 12, airDate: null },
        ],
      }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true })
    const episode = lib.getEpisode('tmdb:65930/s2e1') // absolute 26 = S2E1 under 25+12 concat
    expect(episode).toMatchObject({
      id: 'tmdb:65930/s2e1', series_id: 'tmdb:65930', season: 2, episode: 1, path,
    })
    expect(lib.listParkedPaths()).toEqual([])
  })

  it('official absolute episode-group order wins over season concat (same discipline as the forward direction)', async () => {
    const path = '/media/Anime/Show/ep 2.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '42', season: null, episode: null, absoluteEpisode: 2 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({
        // concat 会把绝对 2 折算成 S1E2；官方表说绝对 2 = S2E1——必须采信官方表。
        getSeasonTable: async () => [
          { seasonNumber: 1, episodeCount: 25, airDate: null },
          { seasonNumber: 2, episodeCount: 12, airDate: null },
        ],
        getAbsoluteOrder: async () => [{ season: 1, episode: 1 }, { season: 2, episode: 1 }],
      }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:42/s2e1')).not.toBeNull()
    expect(lib.getEpisode('tmdb:42/s1e2')).toBeNull()
  })

  it('a previously-parked absolute-numbered path exits parked_paths once resolution succeeds', async () => {
    const path = '/media/Anime/ep 26.mkv'
    lib.upsertParkedPath(path, 'absolute-episode-unresolved', 1000)
    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '65930', season: null, episode: null, absoluteEpisode: 26 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({
        getSeasonTable: async () => [
          { seasonNumber: 1, episodeCount: 25, airDate: null },
          { seasonNumber: 2, episodeCount: 12, airDate: null },
        ],
      }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.listParkedPaths()).toEqual([])
    expect(lib.getEpisode('tmdb:65930/s2e1')).not.toBeNull()
  })
})

// P7 disambiguation 补丁（零误认红线）：viaOverrideLenient 标记的 absoluteEpisode 来自
// recognize() 的 claim-gated 宽松裸数字救援——认领只回答了"这是哪部剧"，没回答"这串裸数字在
// 哪季"。多季剧下直接当绝对集号折算会静默错季（真实撞过的例子：High School DxD 第四季
// 'Hero - 01' 被误当全剧绝对第 1 集，实际是 S4E01）。这条守卫只针对 viaOverrideLenient 生效
// ——上面 describe 块里 identifyFromPath 自己结构化解析出的 absoluteEpisode（不带这个标记）
// 走的还是老路径，两季数据一样能正常折算成功，见 209 行那条既有测试（回归覆盖）。
describe('makeIngestPass — P7 disambiguation guard: claim-gated lenient absoluteEpisode (viaOverrideLenient)', () => {
  it('multi-season series + lenient claim-rescued absoluteEpisode → parks override-ambiguous-numbering, never guesses a season', async () => {
    const path = '/media/TV/High School D×D/[The-Nut] High School DxD Hero - 01.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({
      tmdbId: '24240', season: null, episode: null, absoluteEpisode: 1, viaOverrideLenient: true,
    }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({
        getSeasonTable: async () => [
          { seasonNumber: 1, episodeCount: 12, airDate: null },
          { seasonNumber: 2, episodeCount: 12, airDate: null },
          { seasonNumber: 3, episodeCount: 12, airDate: null },
          { seasonNumber: 4, episodeCount: 13, airDate: null },
        ],
      }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.parked).toBe(1)
    expect(result.upserted).toBe(0)
    expect(lib.listParkedPaths()[0].park_reason).toBe('override-ambiguous-numbering')
    // 没有猜出任何一行——尤其没有静默写出错误的 S1E01（真实撞到的误认场景）。
    expect(lib.getEpisode('tmdb:24240/s1e1')).toBeNull()
  })

  it('single-season series + lenient claim-rescued absoluteEpisode → unambiguous, resolves normally (absolute == season-local)', async () => {
    const path = '/media/TV/Show/Show - 03.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({
      tmdbId: '99', season: null, episode: null, absoluteEpisode: 3, viaOverrideLenient: true,
    }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({
        getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 12, airDate: null }],
      }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true })
    expect(lib.getEpisode('tmdb:99/s1e3')).not.toBeNull()
  })

  it('season table unavailable (null) + lenient claim-rescued absoluteEpisode → guard does not fire on unknown data, falls through to honest absolute-episode-unresolved park', async () => {
    const path = '/media/TV/Show/Show - 03.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({
      tmdbId: '99', season: null, episode: null, absoluteEpisode: 3, viaOverrideLenient: true,
    }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({ getSeasonTable: async () => null, getAbsoluteOrder: async () => null }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.parked).toBe(1)
    expect(lib.listParkedPaths()[0].park_reason).toBe('absolute-episode-unresolved')
  })

  it('regression: multi-season series + PARSER-derived absoluteEpisode (no viaOverrideLenient) is unaffected by the guard — resolves normally', async () => {
    const path = '/media/Anime/My Hero Academia/ep 26.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    // 没有 viaOverrideLenient：identifyFromPath 自己从 fansub 命名结构解析出的绝对集号
    // （既有行为，见上面 209 行同款场景），守卫必须完全不介入。
    const recognize = vi.fn(async () => tvResult({
      tmdbId: '65930', title: 'My Hero Academia', season: null, episode: null, absoluteEpisode: 26,
    }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      tmdb: fakeTmdb({
        getSeasonTable: async () => [
          { seasonNumber: 1, episodeCount: 25, airDate: null },
          { seasonNumber: 2, episodeCount: 12, airDate: null },
        ],
      }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true })
    expect(lib.getEpisode('tmdb:65930/s2e1')).not.toBeNull()
  })
})

describe('makeIngestPass — memo-hit cheap path', () => {
  it('probeMemo (mtime,size) matches current stat → recognize() and probe() are NOT called', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    const recognize = vi.fn(async () => tvResult())
    const probe = vi.fn(async () => [] as EmbeddedSubtitleTrack[])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize, probe,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(recognize).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    // status unchanged (still no sidecar/embedded) → no write, changed stays false
    expect(result).toEqual({ scanned: 1, upserted: 0, parked: 0, removed: 0, changed: false })
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
  })

  it('sidecar deleted since last probe (video mtime/size unchanged) → cheap path flips covered → missing, changed=true (the P7 acceptance mechanism)', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'covered' })
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345) // video itself unchanged — memo still matches
    // sidecar NOT registered → simulates "user deleted the installed subtitle file"
    const recognize = vi.fn(async () => tvResult())
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(recognize).not.toHaveBeenCalled()
    expect(result.changed).toBe(true)
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
  })

  it('cheap path preserves "unavailable" even when recomputed coverage is missing (does not defeat the recheck backoff)', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 99999)
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.changed).toBe(false)
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('unavailable')
  })

  it('memo present but stale (mtime changed) → treated as full path, recognize() IS called again', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 9999, 12345) // mtime changed → memo stale
    const recognize = vi.fn(async () => tvResult())
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(recognize).toHaveBeenCalledTimes(1)
  })

  it('re-recognition flips kind (movie row → recognize() now says TV, e.g. a P6 override correction) → stale movie row is cleaned up, no duplicate-kind ghost row survives', async () => {
    const path = '/media/reclaimed.mkv'
    lib.upsertMovie({ id: 'tmdb:999', name: 'Old Guess', path, subStatus: 'covered' })
    lib.setProbeMemo('tmdb:999', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 9999, 12345) // mtime changed → memo stale → full path re-runs
    const recognize = vi.fn(async () => tvResult({ tmdbId: '999', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getMovie('tmdb:999')).toBeNull()
    expect(lib.getEpisode('tmdb:999/s1e1')).toMatchObject({ path })
  })

  it('re-recognition flips kind (episode row → recognize() now says movie) → stale episode row cleaned up, series dropped if it becomes empty', async () => {
    const path = '/media/reclaimed2.mkv'
    lib.upsertSeries({ id: 'tmdb:999', name: 'Old Guess' })
    lib.upsertEpisode({ id: 'tmdb:999/s1e1', seriesId: 'tmdb:999', season: 1, episode: 1, name: 'x', path, subStatus: 'covered' })
    lib.setProbeMemo('tmdb:999/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 9999, 12345)
    const recognize = vi.fn(async () => movieResult({ tmdbId: '999' }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:999/s1e1')).toBeNull()
    expect(lib.getSeries('tmdb:999')).toBeNull()
    expect(lib.getMovie('tmdb:999')).toMatchObject({ path })
  })

  it('park after a prior successful ingest does NOT delete the previously-working row (graceful degradation, not data loss)', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'x', path, subStatus: 'covered' })
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 9999, 12345) // stale memo → full path
    const recognize = vi.fn(async () => tvResult({ season: 1, episode: null, absoluteEpisode: null }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.parked).toBe(1)
    expect(lib.getEpisode('tmdb:1/s1e1')).not.toBeNull() // old row survives the park
  })
})

// P7 真库闸门 Bug 2：两个不同磁盘路径识别到同一个 own-id（同 tmdbId+season/episode，movies 同 tmdbId）
// ——重复内容（多质量版本、种子机硬链接残留常见）。episodes/movies 的 path 列是单值，一行只能记
// 一个 path；不设防的话两条路径会在每一轮互相"抢" path 列。**重复源 P2 起**：后来者不再 park
// duplicate-content，而是登记为一等公民副本（item_files）——条目=文件集合，主文件（最早入库者）
// 占 episodes/movies.path，副本进 item_files。幂等性仍然成立：安静盘上主文件走 CHEAP PATH 不
// re-upsert，副本每轮命中撞身份守卫 addItemFile（ON CONFLICT 幂等）不 upsert。
describe('makeIngestPass — duplicate identity → item_files 副本入册（重复源 P2）', () => {
  it('two TV paths to the same tmdbId/season/episode: 主文件占 episodes.path，后来者进 item_files（不 park）；安静盘不 re-upsert', async () => {
    const pathA = '/media/Show/Season 1/ep1-copyA.mkv'
    const pathB = '/media/Show (dup)/Season 1/ep1-copyB.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathA, 5000, 111)
    disk.setVideo(pathB, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const probe = vi.fn(async () => [] as EmbeddedSubtitleTrack[])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [pathA, pathB],
      recognize, probe,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const r1 = await pass()
    expect(r1.upserted).toBe(1)
    expect(r1.parked).toBe(0) // P2：不再 park

    const r2 = await pass()
    expect(r2.upserted).toBe(0) // quiet disk — must NOT re-upsert
    expect(r2.parked).toBe(0)

    const episode = lib.getEpisode('tmdb:1/s1e1')
    expect(episode).not.toBeNull()
    // 一个 path 稳定占主文件行，另一个作为副本入 item_files（无 ping-pong）。
    expect([pathA, pathB]).toContain(episode!.path)
    const replicas = lib.listItemFiles('tmdb:1/s1e1')
    expect(replicas).toHaveLength(1)
    expect([pathA, pathB]).toContain(replicas[0].path)
    expect(replicas[0].path).not.toBe(episode!.path)
    // 停车场干净——副本不占停车位。
    expect(lib.listParkedPaths()).toEqual([])
  })

  it('movie 副本同理入 item_files（不 park duplicate-content）', async () => {
    const pathA = '/media/Movies/Hero (2002).mkv'
    const pathB = '/media/Movies (dup)/Hero (2002) [1080p].mkv'
    const disk = fakeDisk()
    disk.setVideo(pathA, 5000, 111)
    disk.setVideo(pathB, 5000, 222)
    const recognize = vi.fn(async () => movieResult({ tmdbId: '603' }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [pathA, pathB], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.listParkedPaths()).toEqual([])
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
    const replicas = lib.listItemFiles('tmdb:603')
    expect(replicas).toHaveLength(1)
    expect([pathA, pathB]).toContain(replicas[0].path)
  })

  it('存量自愈：既有 duplicate-content 停车行下一轮命中撞身份守卫 → 转副本入册 + 退户口', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show (dup)/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    // 先让主文件入库
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const passMainOnly = makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    await passMainOnly()
    // 手工模拟 P2 之前遗留的 duplicate-content 停车行
    lib.upsertParkedPath(pathDup, 'duplicate-content', 5000)
    expect(lib.listParkedPaths().map((p) => p.path)).toContain(pathDup)

    // 现在全量扫描（含 dup）→ dup 命中撞身份守卫 → addItemFile + clearParkedPath
    const passAll = makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    await passAll()

    expect(lib.listParkedPaths()).toEqual([]) // 自愈退户口
    expect(lib.listItemFiles('tmdb:1/s1e1').map((f) => f.path)).toEqual([pathDup])
  })

  it('主文件消失但有存活副本 → 最年长副本晋升，条目不退役', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const deps = makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    })
    await makeIngestPass(deps)()
    const mainBefore = lib.getEpisode('tmdb:1/s1e1')!.path

    // 主文件从盘上消失（只留副本）
    disk.removeVideo(mainBefore)
    const survivingReplica = [pathMain, pathDup].find((p) => p !== mainBefore)!
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [survivingReplica], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()

    // 条目没退役（removed 不因它 +1），主文件 path 顶替成存活副本，item_files 清空
    const ep = lib.getEpisode('tmdb:1/s1e1')
    expect(ep).not.toBeNull()
    expect(ep!.path).toBe(survivingReplica)
    expect(lib.listItemFiles('tmdb:1/s1e1')).toEqual([])
  })

  // 重复源 P4b："复制优先"机械通道接线验证——只验证 ingest.ts 在 addItemFile 分支正确调用
  // propagateSubtitleToReplica（正确的 itemId/mainPath/replicaPath），不重新验证复制/时长判断
  // 本身的逻辑（那部分已经在 subtitlePropagation.test.ts 用真实临时文件+真实 DB 独立覆盖）。
  it('TV 副本入册时，若主文件已有字幕，会用主副两个 path 调用 probeDuration（复制优先通道被正确触发）', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show (dup)/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()
    // 主文件已有一份字幕（无 file_path=挂主文件，既有兼容语义）。
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:1/s1e1', '/media/Show/Season 1/ep1-main.zh-Hans.srt', 'zh-Hans', 'scout-download', 1000)

    const probeDuration = vi.fn(async () => null) // 虚拟磁盘上没有真实视频文件——探测失败即可，只看接线
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
      probeDuration,
    }))()

    expect(probeDuration).toHaveBeenCalledWith(pathMain)
    expect(probeDuration).toHaveBeenCalledWith(pathDup)
  })

  it('movie 副本入册时同理会触发复制优先通道的探测调用', async () => {
    const pathA = '/media/Movies/Hero (2002).mkv'
    const pathB = '/media/Movies (dup)/Hero (2002) [1080p].mkv'
    const disk = fakeDisk()
    disk.setVideo(pathA, 5000, 111)
    disk.setVideo(pathB, 5000, 222)
    const recognize = vi.fn(async () => movieResult({ tmdbId: '603' }))
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathA], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:603', '/media/Movies/Hero (2002).zh-Hans.srt', 'zh-Hans', 'scout-download', 1000)

    const probeDuration = vi.fn(async () => null)
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathA, pathB], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
      probeDuration,
    }))()

    expect(probeDuration).toHaveBeenCalledWith(pathA)
    expect(probeDuration).toHaveBeenCalledWith(pathB)
  })

  it('主文件还没有字幕时，副本入册不会触发探测调用（最常见情形，零额外开销）', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show (dup)/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const probeDuration = vi.fn(async () => 1420)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
      probeDuration,
    }))

    await pass()

    expect(probeDuration).not.toHaveBeenCalled()
  })
})

// 批③ B3-1（领养记账，F-A correctness）：classify() rule 3（磁盘 sidecar）判 covered 时，此前
// 只翻 sub_status，不写 subtitles 表行——生产实证 tmdb:86831/s3e8 covered 而 subtitles 表空。
// 后果：①provenance 账本缺口 ②adopted 主文件对副本传播失效（subtitlePropagation.ts 找主文件
// 字幕源靠 subtitles 行，无行=无源可复制）。修复：CHEAP PATH 与 FULL PATH（TV/movie 两分支）
// 判 covered 时同步调用 lib.recordAdoptedSidecar 补写一行（path=sidecar 真路径，
// source='preexisting'，language=findExternalSidecar 命中 tag 换算值）。
describe('makeIngestPass — B3-1 领养(sidecar)记账：covered 判定同时补写 subtitles 行', () => {
  it('cheap path：磁盘出现 sidecar（missing→covered）→ 补写 subtitles 行（path/source/language 断言）', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/Show/Season 1/ep1.zh.srt')
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.sub_status).toBe('covered')
    const row = db.prepare(`SELECT path, language, source, file_path FROM subtitles WHERE item_id = ?`).get('tmdb:1/s1e1')
    expect(row).toEqual({
      path: '/media/Show/Season 1/ep1.zh.srt', language: 'zh-Hans', source: 'preexisting', file_path: null,
    })
  })

  it('full path（新文件首次识别即命中 sidecar）→ 同样补写 subtitles 行', async () => {
    const path = '/media/Show/Season 1/ep2.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    disk.addSidecar('/media/Show/Season 1/ep2.zh.srt')
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 2 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e2')!.sub_status).toBe('covered')
    const row = db.prepare(`SELECT path, language, source FROM subtitles WHERE item_id = ?`).get('tmdb:1/s1e2')
    expect(row).toEqual({ path: '/media/Show/Season 1/ep2.zh.srt', language: 'zh-Hans', source: 'preexisting' })
  })

  it('连跑两轮（含安静盘重复命中 cheap path）→ 不重复插 subtitles 行（ON CONFLICT 幂等）', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])
    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/Show/Season 1/ep1.zh.srt')
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()
    await pass()
    await pass()

    const rows = db.prepare(`SELECT * FROM subtitles WHERE item_id = ?`).all('tmdb:1/s1e1')
    expect(rows).toHaveLength(1)
  })

  // 闭环测试（真实临时文件 + 真实 fs，同 subtitlePropagation.test.ts 的既有测试纪律——只
  // probeDuration 注入固定值，从不真的 spawn ffprobe）：B3-1 写的 subtitles 行必须真的能被
  // subtitlePropagation.ts 当作"主文件已有字幕"的源，传播到后来发现的副本身上——否则领养记账
  // 只是好看的数字，实际闭环没打通。
  it('闭环：adopted 主文件(sidecar 领养) + 后发现的缺字幕副本 → 传播能找到源并复制', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scout-ingest-b31-'))
    const realStatFile = (p: string) => {
      try {
        const s = statSync(p)
        return { mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    }
    try {
      const mainPath = join(root, 'Show.1080p.mkv')
      const dupPath = join(root, 'Show.4K.mkv')
      const sidecarPath = join(root, 'Show.1080p.zh.srt')
      writeFileSync(mainPath, 'video-main')
      writeFileSync(dupPath, 'video-dup')
      writeFileSync(sidecarPath, '1\n00:00:01,000 --> 00:00:02,000\nadopted sub\n')

      const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))

      // 第一轮：只扫主文件——命中磁盘 sidecar，领养 covered，B3-1 补写 subtitles 行。
      await makeIngestPass(makeDeps({
        listVideoFiles: () => [mainPath], recognize,
        fileExists: existsSync, statFile: realStatFile,
      }))()
      expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('covered')
      expect(db.prepare(`SELECT COUNT(*) as c FROM subtitles WHERE item_id = 'tmdb:1/s1e1'`).get()).toEqual({ c: 1 })

      // 第二轮：副本出现——撞既有身份 → addItemFile + 触发"复制优先"传播；源必须是刚领养的那行。
      const probeDuration = vi.fn(async () => 1420) // 主副时长一致（测接线，不测真探测）
      await makeIngestPass(makeDeps({
        listVideoFiles: () => [mainPath, dupPath], recognize,
        fileExists: existsSync, statFile: realStatFile,
        probeDuration,
      }))()

      const destPath = join(root, 'Show.4K.zh-Hans.srt')
      expect(existsSync(destPath)).toBe(true)
      expect(readFileSync(destPath, 'utf8')).toContain('adopted sub')
      expect(lib.listSubtitlesForFile('tmdb:1/s1e1', dupPath, false)).toEqual([
        { id: expect.any(Number), path: destPath, language: 'zh-Hans' },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// P0(zimuku 单源大考前置,2026-07-19)生产实证回归锁:探针以 langTag 'zh-CN' 装机(H2 白名单
// 合法),`.zh-CN.srt` 落盘且内容正确,但领养 tag 集无 BCP-47 地区变体 → 领养臂全瞎——episodes
// 停 unavailable(判无叙事还挂着),subtitles 零行(WITCH WATCH E02/05/11/20 + Adam's E05)。
// 本 describe 锁死修复后行为:cheap path 下一轮 pass 即领养,unavailable→covered(covered 可
// 覆写 unavailable,resolveStatusToWrite 只挡 missing),判无叙事清除,subtitles 行落账。
describe('makeIngestPass — P0 BCP-47 地区变体 sidecar 领养', () => {
  it('.zh-CN.srt + 条目 unavailable(带判无叙事) → cheap path 领养:covered + 叙事清除 + subtitles 行 zh-Hans', async () => {
    const path = '/media/WITCH WATCH/ep5.mkv'
    lib.upsertSeries({ id: 'tmdb:261868', name: 'Witch Watch' })
    lib.upsertEpisode({ id: 'tmdb:261868/s1e5', seriesId: 'tmdb:261868', season: 1, episode: 5, name: 'E5', path, subStatus: 'missing' })
    db.prepare(`UPDATE episodes SET sub_status = 'unavailable', status_reason = 'No Chinese subtitle found on any provider' WHERE id = 'tmdb:261868/s1e5'`).run()
    lib.setProbeMemo('tmdb:261868/s1e5', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/WITCH WATCH/ep5.zh-CN.srt')

    await makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()

    expect(lib.getEpisode('tmdb:261868/s1e5')!.sub_status).toBe('covered')
    const narrative = db.prepare(`SELECT status_reason r FROM episodes WHERE id = 'tmdb:261868/s1e5'`).get() as { r: string | null }
    expect(narrative.r).toBeNull()
    const row = db.prepare(`SELECT path, language, source FROM subtitles WHERE item_id = ?`).get('tmdb:261868/s1e5')
    expect(row).toEqual({ path: '/media/WITCH WATCH/ep5.zh-CN.srt', language: 'zh-Hans', source: 'preexisting' })
  })

  it('.zh-cn.srt(Bazarr 遗留小写) missing→covered 同样领养', async () => {
    const path = '/media/Show/Season 1/ep9.mkv'
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e9', seriesId: 'tmdb:9', season: 1, episode: 9, name: 'E9', path, subStatus: 'missing' })
    lib.setProbeMemo('tmdb:9/s1e9', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/Show/Season 1/ep9.zh-cn.srt')

    await makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()

    expect(lib.getEpisode('tmdb:9/s1e9')!.sub_status).toBe('covered')
    const row = db.prepare(`SELECT path, language, source FROM subtitles WHERE item_id = ?`).get('tmdb:9/s1e9')
    expect(row).toEqual({ path: '/media/Show/Season 1/ep9.zh-cn.srt', language: 'zh-Hans', source: 'preexisting' })
  })
})

// 批③ B3-2（领养清理 stale status_reason，F-B）：领养把 unavailable→covered 后，status_reason
// 此前仍残留旧失败叙事（生产实证同上，E08 的 reason 还是"unknown videoFilename…"）——误导人工
// 回看。修复：writeSubStatusOnly（cheap path）与 FULL PATH 的 TV/movie 两分支在 toWrite==='covered'
// 时主动清空 status_reason。
describe('makeIngestPass — B3-2 领养(sidecar)清理 stale status_reason', () => {
  it('cheap path：unavailable(带旧 reason)→sidecar 出现判 covered → status_reason 被清空', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', 'unknown videoFilename for tmdb:86831/s3e8', 1000)
    expect(lib.getEpisode('tmdb:1/s1e1')!.status_reason).toBe('unknown videoFilename for tmdb:86831/s3e8')
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/Show/Season 1/ep1.zh.srt')
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.sub_status).toBe('covered')
    expect(ep.status_reason).toBeNull()
  })

  it('full path（movie 分支，memo 过期重新识别）：unavailable(带旧 reason)→sidecar 命中 covered → status_reason 被清空', async () => {
    const path = '/media/movies/hero.mkv'
    lib.upsertMovie({ id: 'tmdb:603', name: 'The Matrix', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:603', '搜索穷尽', 1000)
    expect(lib.getMovie('tmdb:603')!.status_reason).toBe('搜索穷尽')

    const disk = fakeDisk()
    disk.setVideo(path)
    disk.addSidecar('/media/movies/hero.zh.srt')
    const recognize = vi.fn(async () => movieResult({ tmdbId: '603', title: 'The Matrix' }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const movie = lib.getMovie('tmdb:603')!
    expect(movie.sub_status).toBe('covered')
    expect(movie.status_reason).toBeNull()
  })

  // 批③a F-B 补齐：B3-2 当时只按生产实证覆盖了 covered（rule 3 sidecar）这一条翻篇路径——
  // embedded（rule 2，内嵌字幕轨覆盖）同样是"这轮判定已覆盖"的终局态，若此前是 unavailable
  // 留下的旧 status_reason，翻成 embedded 后同样不该继续显示陈旧叙事。
  it('cheap path：unavailable(带旧 reason)→内嵌轨被 memo 记住判 embedded → status_reason 被清空', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    expect(lib.getEpisode('tmdb:1/s1e1')!.status_reason).toBe('搜索穷尽')
    // memo 记住的内嵌轨已含目标语言标签 —— cheap path 重跑分类时 rule 2 命中，无需真的探测。
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, ['chi'])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.sub_status).toBe('embedded')
    expect(ep.status_reason).toBeNull()
  })

  it('full path（新识别/memo 过期，TV 分支）：unavailable(带旧 reason)→探针发现内嵌轨判 embedded → status_reason 被清空', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    expect(lib.getEpisode('tmdb:1/s1e1')!.status_reason).toBe('搜索穷尽')
    // 故意不设 probeMemo —— 走 full path（重新识别 + 探测）。

    const disk = fakeDisk()
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult())
    const probe = vi.fn(async (): Promise<EmbeddedSubtitleTrack[]> => [track({ lang: 'chi' })])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], recognize, probe,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.sub_status).toBe('embedded')
    expect(ep.status_reason).toBeNull()
  })
})

// 批③ B3-3（C-1，配额止血）：findRowByPath 只查 episodes/movies，看不到已登记副本（身份记在
// item_files，episodes/movies.path 仍指向主文件）——已登记副本每轮 pass 都会落到 FULL PATH 重新
// 真的 recognize()（真 TMDB 搜索），白烧配额。修复：主扫描循环在 CHEAP PATH 之后、FULL PATH
// 之前新增 item_files 反查短路——命中即跳过 recognize()，只照常触发一次幂等的传播调用。
describe('makeIngestPass — B3-3 已登记副本免重识别（配额止血）', () => {
  it('副本第二轮 pass 命中 item_files → 不再调用 recognize()（真实 TMDB 搜索的替身）', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show (dup)/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass() // 首轮：两条路径都要真识别一次（其中一条落 item_files 副本）
    expect(recognize).toHaveBeenCalledTimes(2)

    recognize.mockClear()
    await pass() // 二轮：安静盘——主文件走 CHEAP PATH，副本命中 item_files 短路，都不该调 recognize

    expect(recognize).not.toHaveBeenCalled()
  })

  it('副本命中短路分支后，仍照常触发幂等传播（主文件已有字幕时）', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show (dup)/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    // 首轮：只扫主文件入库。
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()
    // 二轮：扫到副本——此时还没登记过 item_files，走 FULL PATH 撞身份分支入册。
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()
    expect(lib.listItemFiles('tmdb:1/s1e1')).toHaveLength(1)

    // 主文件现在补上一份字幕。
    db.prepare(`INSERT INTO subtitles (item_id, path, language, source, created_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:1/s1e1', '/media/Show/Season 1/ep1-main.zh-Hans.srt', 'zh-Hans', 'scout-download', 1000)

    recognize.mockClear()
    const probeDuration = vi.fn(async () => null) // 虚拟磁盘没有真实视频文件——只看接线，不看复制结果
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
      probeDuration,
    }))()

    expect(recognize).not.toHaveBeenCalled() // B3-3：这轮副本走短路分支，不再重识别
    expect(probeDuration).toHaveBeenCalledWith(pathMain)
    expect(probeDuration).toHaveBeenCalledWith(pathDup)
  })

  // 回归锁：B3-3 短路分支不能破坏重复源 P2 的"主文件消失→最年长副本晋升"逻辑——该逻辑读
  // item_files 表本身，与副本本轮是走 CHEAP/B3-3/FULL 哪条分支无关。
  it('主文件消失但有存活副本（副本此前已在走 B3-3 短路）→ 晋升逻辑依然生效（回归锁）', async () => {
    const pathMain = '/media/Show/Season 1/ep1-main.mkv'
    const pathDup = '/media/Show/Season 1/ep1-dup.mkv'
    const disk = fakeDisk()
    disk.setVideo(pathMain, 5000, 111)
    disk.setVideo(pathDup, 5000, 222)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()
    const mainBefore = lib.getEpisode('tmdb:1/s1e1')!.path
    const survivingReplica = [pathMain, pathDup].find((p) => p !== mainBefore)!

    // 确认副本这轮已经在走 B3-3 短路（不再重识别）——晋升测试建立在这个前提上。
    recognize.mockClear()
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [pathMain, pathDup], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()
    expect(recognize).not.toHaveBeenCalled()

    // 主文件从盘上消失（只留副本）——晋升逻辑必须依然生效。
    disk.removeVideo(mainBefore)
    await makeIngestPass(makeDeps({
      listVideoFiles: () => [survivingReplica], recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()

    const ep = lib.getEpisode('tmdb:1/s1e1')
    expect(ep).not.toBeNull()
    expect(ep!.path).toBe(survivingReplica)
    expect(lib.listItemFiles('tmdb:1/s1e1')).toEqual([])
  })
})

describe('makeIngestPass — probe contract (streamProbe.ts: null=unavailable, degrade to sidecar-only)', () => {
  it('probe() returns null → embedded rule never fires; sidecar still detected', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    disk.addSidecar('/media/Show/Season 1/ep1.zh.srt')
    const probe = vi.fn(async (): Promise<EmbeddedSubtitleTrack[] | null> => null)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult()),
      probe,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('covered')
    expect(lib.probeMemo('tmdb:1/s1e1')).toEqual({ mtime: 1000, size: 100, langs: null })
  })

  it('embedded raw ffprobe tag "chi" counts as zh coverage via tagsForLanguage (CHINESE_SIDECAR_TAGS)', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const probe = vi.fn(async () => [track({ lang: 'chi', codec: 'subrip' })])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult()),
      probe,
      targetLanguages: () => ['zh'],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('embedded')
  })

  it('image-based embedded track (e.g. PGS) does not count as coverage', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const probe = vi.fn(async () => [track({ lang: 'chi', codec: 'hdmv_pgs_subtitle', isImageBased: true })])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult()),
      probe,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
  })
})

describe('makeIngestPass — TMDB origin gate (rule 0) and Chinese-title heuristic (rule 1b)', () => {
  it('origin_lang resolves to zh, zh in originSkipLanguages → ignored, and origin_lang cached on series row', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const getOriginLanguage = vi.fn(async () => 'zh')
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult()),
      tmdb: fakeTmdb({ getOriginLanguage }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('ignored')
    expect(lib.getSeriesOriginLang('tmdb:1')).toBe('zh')
  })

  it('origin_lang resolves to ja → NOT ignored (falls through to missing)', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult()),
      tmdb: fakeTmdb({ getOriginLanguage: async () => 'ja' }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
  })

  it('no TMDB origin signal (genuine no-data) + Han-only title + zh targeted → ignored via title heuristic (rule 1b)', async () => {
    const path = '/media/生活大爆炸/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult({ title: '甲剧标题' })),
      tmdb: fakeTmdb({ getOriginLanguage: async () => null }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('ignored')
    // R-9 rule1b 判决可稽核：标题启发式命中必须落 status_reason，不是裸 'ignored'。
    expect(lib.getEpisode('tmdb:1/s1e1')!.status_reason).toBeTruthy()
  })

  it('Kana/Hangul title does NOT trigger the Chinese heuristic', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult({ title: 'スパイファミリー' })),
      tmdb: fakeTmdb({ getOriginLanguage: async () => null }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
  })

  it('zh NOT in originSkipLanguages (custom config) → title heuristic never fires even for a Han-only title', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult({ title: '甲剧标题' })),
      tmdb: fakeTmdb({ getOriginLanguage: async () => null }),
      targetLanguages: () => ['en'],
      originSkipLanguages: () => ['en'],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
  })

  it('origin resolution failure (TMDB throws) suppresses the title heuristic this pass (data is "not available yet", not "confirmed absent")', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult({ title: '甲剧标题' })),
      tmdb: fakeTmdb({ getOriginLanguage: async () => { throw new Error('ECONNRESET') } }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
    expect(lib.getSeriesOriginLang('tmdb:1')).toBeNull() // not cached — retried next pass
  })

  it('origin_lang is resolved once per series per pass — a second episode of the same series reuses the cached value', async () => {
    const p1 = '/media/Show/Season 1/ep1.mkv'
    const p2 = '/media/Show/Season 1/ep2.mkv'
    const disk = fakeDisk()
    disk.setVideo(p1)
    disk.setVideo(p2)
    const getOriginLanguage = vi.fn(async () => 'zh')
    const recognize = vi.fn(async (path: string) => tvResult({ episode: path === p1 ? 1 : 2 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [p1, p2],
      recognize,
      tmdb: fakeTmdb({ getOriginLanguage }),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(getOriginLanguage).toHaveBeenCalledTimes(1)
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('ignored')
    expect(lib.getEpisode('tmdb:1/s1e2')!.sub_status).toBe('ignored')
  })
})

// 去 Jellyfin 化 P7：直接单测搬自 daemon/triggers.test.ts（原文件随出口清算删除——
// needsChineseSubtitle/usableChineseSubtitleStreams 随 jellyfin.ts 一起退役，looksChineseTitle
// 唯一消费方是本文件的 classify() rule 1b，随函数本体搬到同一处）。上面 rule 1b 的集成测试
// 只覆盖了 Han-only / kana 两个场景，这里补全 null/空串等纯函数边界用例。
describe('looksChineseTitle', () => {
  it('Han-only → true; kana/hangul present → false', () => {
    expect(looksChineseTitle('英雄')).toBe(true)
    expect(looksChineseTitle('流浪地球')).toBe(true)
    expect(looksChineseTitle('進撃の巨人')).toBe(false) // の is kana
    expect(looksChineseTitle('오징어 게임')).toBe(false) // hangul
    expect(looksChineseTitle('Peacemaker')).toBe(false) // no Han
    expect(looksChineseTitle(null)).toBe(false)
    expect(looksChineseTitle('')).toBe(false)
  })
})

describe('makeIngestPass — disk-truth removal', () => {
  it('a library row whose path is no longer seen AND no longer exists on disk → row removed after REMOVAL_CONFIRM_PASSES (default 2) consecutive confirmations, series dropped when it becomes empty', async () => {
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'x', path: '/media/gone.mkv', subStatus: 'covered' })

    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [], // nothing seen this pass
      fileExists: () => false, // confirmed gone
    }))

    // 三层防线②消失去抖：首轮判 gone 只记账不删（默认 REMOVAL_CONFIRM_PASSES=2）。
    const r1 = await pass()
    expect(r1).toEqual({ scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false })
    expect(lib.getEpisode('tmdb:1/s1e1')).not.toBeNull()
    expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = '/media/gone.mkv'`).get()).toEqual({ misses: 1 })

    // 第二轮仍然 gone——连续两轮确认，真删。
    const r2 = await pass()
    expect(r2).toEqual({ scanned: 0, upserted: 0, parked: 0, removed: 1, changed: true })
    expect(lib.getEpisode('tmdb:1/s1e1')).toBeNull()
    expect(lib.getSeries('tmdb:1')).toBeNull()
    expect(db.prepare(`SELECT * FROM pending_removals WHERE path = '/media/gone.mkv'`).get()).toBeUndefined()
  })

  it('series survives if a sibling episode remains (after two confirmed-gone passes)', async () => {
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'x', path: '/media/gone.mkv', subStatus: 'covered' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e2', seriesId: 'tmdb:1', season: 1, episode: 2, name: 'y', path: '/media/stays.mkv', subStatus: 'covered' })

    const disk = fakeDisk()
    disk.setVideo('/media/stays.mkv')
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/stays.mkv'],
      recognize: vi.fn(async () => tvResult({ episode: 2 })),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass() // 第一轮：gone 记账，未删
    expect(lib.getEpisode('tmdb:1/s1e1')).not.toBeNull()
    await pass() // 第二轮：确认删除

    expect(lib.getEpisode('tmdb:1/s1e1')).toBeNull()
    expect(lib.getSeries('tmdb:1')).not.toBeNull()
  })

  it('safety net: NOT seen this pass but fileExists() still says it is there → row is NOT removed (guards against a transient walk() readdir failure)', async () => {
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: '/media/still-there.mkv', subStatus: 'missing' })

    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [], // walker didn't see it this pass (e.g. transient readdir error)
      fileExists: (p) => p === '/media/still-there.mkv', // but it's genuinely still on disk
    }))

    const result = await pass()

    expect(result.removed).toBe(0)
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
  })

  it('a vanished parked_paths row is cleared too', async () => {
    lib.upsertParkedPath('/media/gone-junk.mkv', 'no-match', 1000)

    const pass = makeIngestPass(makeDeps({ listVideoFiles: () => [], fileExists: () => false }))
    await pass()

    expect(lib.listParkedPaths()).toEqual([])
  })

  it('movie row removal (mirrors episode branch, after two confirmed-gone passes)', async () => {
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: '/media/gone.mkv', subStatus: 'covered' })
    const pass = makeIngestPass(makeDeps({ listVideoFiles: () => [], fileExists: () => false }))
    const r1 = await pass()
    expect(r1.removed).toBe(0)
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
    const r2 = await pass()
    expect(r2.removed).toBe(1)
    expect(lib.getMovie('tmdb:603')).toBeNull()
  })
})

// 数据安全审计头号遗留修复（2026-07-18）：CIFS 挂载抖动可致整库索引批量误删。原先的"双重条件"
// （!seenPaths.has(path) && !fileExists(path)）在整个挂载闪断场景下两个信号同源失效——
// daemon/selfScan.ts 的 walk() 对根目录 readdirSync 报错时整棵子树的 seenPaths 都是空的，默认
// fileExists 对 ESTALE/EIO/ETIMEDOUT/ENOTCONN 与 ENOENT 无差别折叠成 false。三层防线：
// ①errno 区分（checkFileGone）②消失去抖（pending_removals）③骤降哨兵（rootsCollapsed）。
describe('classifyStatError（三层防线①核心分类，纯函数，不碰真实文件系统）', () => {
  const errnoErr = (code: string) => Object.assign(new Error(code), { code })

  it('ENOENT / ENOTDIR → gone（确认不在磁盘上——权威事实）', () => {
    expect(classifyStatError(errnoErr('ENOENT'))).toBe('gone')
    expect(classifyStatError(errnoErr('ENOTDIR'))).toBe('gone')
  })

  it('ESTALE / EIO / ETIMEDOUT / ENOTCONN / EACCES / ENAMETOOLONG（CIFS/NFS 挂载抖动典型 errno）→ unknown（探测本身失败，不是"确认消失"）', () => {
    for (const code of ['ESTALE', 'EIO', 'ETIMEDOUT', 'ENOTCONN', 'EACCES', 'ENAMETOOLONG']) {
      expect(classifyStatError(errnoErr(code))).toBe('unknown')
    }
  })

  it('没有 errno（非 Node 系统错误——任意其它异常/非 Error 值）→ 保守判 unknown，不是 gone', () => {
    expect(classifyStatError(new Error('boom, no code'))).toBe('unknown')
    expect(classifyStatError('not even an Error object')).toBe('unknown')
    expect(classifyStatError(undefined)).toBe('unknown')
  })
})

describe('makeIngestPass — 三层防线①errno 区分：unknown 本轮跳过不删，不进消失去抖记账', () => {
  it('注入的 checkFileGone 对某条路径返回 unknown（模拟真实 ESTALE）→ 该路径本轮不删，pending_removals 也不留痕', async () => {
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: '/media/flaky.mkv', subStatus: 'covered' })

    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [],
      checkFileGone: (p) => (p === '/media/flaky.mkv' ? 'unknown' : 'gone'),
    }))

    const result = await pass()

    expect(result.removed).toBe(0)
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
    expect(db.prepare(`SELECT * FROM pending_removals WHERE path = '/media/flaky.mkv'`).get()).toBeUndefined()
  })

  it('真实 statSync 路径（未注入 checkFileGone/fileExists）：超长路径触发真实 ENAMETOOLONG（非 ENOENT/ENOTDIR）→ 不删 + console.error 带 errno 警示', async () => {
    const longPath = '/media/' + 'x'.repeat(5000) + '.mkv'
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: longPath, subStatus: 'missing' })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pass = makeIngestPass(makeDeps({
        listVideoFiles: () => [],
        fileExists: undefined,
        checkFileGone: undefined,
      }))

      const result = await pass()

      expect(result.removed).toBe(0)
      expect(lib.getMovie('tmdb:603')).not.toBeNull()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ENAMETOOLONG'))
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('makeIngestPass — 三层防线②消失去抖：连续确认才真删', () => {
  it('首轮 gone→不删且清零记账；第二轮仍 present→行清除，不删（复活场景）', async () => {
    lib.upsertMovie({ id: 'tmdb:900', name: 'M', path: '/media/flip-flop.mkv', subStatus: 'missing' })
    let onDisk = false
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [], // 只关心移除循环本身，不依赖主扫描循环把它标记为"seen"
      fileExists: () => onDisk,
    }))

    await pass() // 第一轮：gone，记账 misses=1，不删
    expect(lib.getMovie('tmdb:900')).not.toBeNull()
    expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = '/media/flip-flop.mkv'`).get()).toEqual({ misses: 1 })

    onDisk = true // 复活
    await pass() // 第二轮：present → 清零重计，不删
    expect(lib.getMovie('tmdb:900')).not.toBeNull()
    expect(db.prepare(`SELECT * FROM pending_removals WHERE path = '/media/flip-flop.mkv'`).get()).toBeUndefined()

    onDisk = false
    await pass() // 第三轮：gone again → 重新从 misses=1 开始，不是延续之前的计数直接判定"够轮次"
    expect(lib.getMovie('tmdb:900')).not.toBeNull()
    expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = '/media/flip-flop.mkv'`).get()).toEqual({ misses: 1 })
  })

  it('item_files 副本本身"消失"同样走 errno+去抖两层：首轮 gone 不删，连续两轮才真删', async () => {
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: '/media/main.mkv', subStatus: 'covered' })
    lib.addItemFile('tmdb:603', '/media/replica.mkv', 1000)

    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [],
      fileExists: (p) => p === '/media/main.mkv', // 主文件仍在盘上，副本已消失
    }))

    const r1 = await pass()
    expect(r1.removed).toBe(0)
    expect(lib.listItemFiles('tmdb:603')).toHaveLength(1) // 首轮只记账，不删
    expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = '/media/replica.mkv'`).get()).toEqual({ misses: 1 })
    // 主文件仍在（present），不受影响。
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
    expect(lib.getMovie('tmdb:603')!.path).toBe('/media/main.mkv')

    await pass() // 第二轮：副本仍然 gone → 确认删除
    expect(lib.listItemFiles('tmdb:603')).toHaveLength(0)
  })

  it('文件本轮被正常走盘到(在 seenPaths)也清零去抖计数——不只是 checkFileGone 那条 present 路径(修复:seenPaths 早退曾跳过 clearPendingRemoval → 非连续消失被误计为连续触发误删)', async () => {
    const path = '/media/walked.mkv'
    lib.upsertMovie({ id: 'tmdb:901', name: 'M', path, subStatus: 'covered' })
    lib.setProbeMemo('tmdb:901', 5000, 12345, []) // cheap path 命中,免 recognize
    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    let present = false
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => present ? [path] : [],
      fileExists: (p) => present && disk.fileExists(p),
      statFile: disk.statFile,
    }))

    await pass() // 第一轮:消失(不在 listVideoFiles)→ misses=1
    expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = ?`).get(path)).toEqual({ misses: 1 })

    present = true
    await pass() // 第二轮:文件回来且正常走盘(进 seenPaths)→ 必须清零(旧代码在此早退跳过清零)
    expect(db.prepare(`SELECT * FROM pending_removals WHERE path = ?`).get(path)).toBeUndefined()

    present = false
    await pass() // 第三轮:再消失 → 从 misses=1 重新开始,不是延续到 2 直接删
    expect(lib.getMovie('tmdb:901')).not.toBeNull()
    expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = ?`).get(path)).toEqual({ misses: 1 })
  })
})

describe('makeIngestPass — 三层防线③骤降哨兵：某根 seenPaths 相对已知库存暴跌时整根跳过本轮移除', () => {
  function seedTenMovies(): void {
    for (let i = 1; i <= 10; i++) {
      lib.upsertMovie({ id: `tmdb:${900 + i}`, name: `M${i}`, path: `/media/movie${i}.mkv`, subStatus: 'covered' })
    }
  }

  it('seen 骤降到已知库存的 40%（<0.5 默认阈值，已知=10≥10）→ 整根本轮零删除 + console.error 响亮警示（含根路径与 seen/known 数字）', async () => {
    seedTenMovies()
    const seenList = ['/media/movie1.mkv', '/media/movie2.mkv', '/media/movie3.mkv', '/media/movie4.mkv'] // 4/10 = 40%

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pass = makeIngestPass(makeDeps({
        listVideoFiles: (root) => (root === '/media' ? seenList : []),
        // seenPaths.add() 在主扫描循环顶部无条件发生，statFile 返回 null 使该分支在标记为
        // "seen"之后立刻 continue，不触发 recognize()/probe() 之类的后续机械——这里只关心移除
        // 循环怎么处理 seenPaths，不关心主循环的识别结果。
        statFile: () => null,
        fileExists: () => false, // 剩下 6 个若无哨兵，两轮后会被判定"确认消失"
      }))

      const result = await pass()

      expect(result.removed).toBe(0)
      for (let i = 1; i <= 10; i++) expect(lib.getMovie(`tmdb:${900 + i}`)).not.toBeNull()
      // 整根跳过——连"记一次 miss"这种去抖记账都不该发生（否则比例后续恢复时会带着一段旧计数）。
      expect((db.prepare('SELECT COUNT(*) as c FROM pending_removals').get() as { c: number }).c).toBe(0)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('SCAN COLLAPSE'))
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('/media'))
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('4/10'))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('比例正常（≥0.5）时不设防——消失去抖照常记账，不触发哨兵警示', async () => {
    seedTenMovies()
    const seenList = ['/media/movie1.mkv', '/media/movie2.mkv', '/media/movie3.mkv', '/media/movie4.mkv', '/media/movie5.mkv', '/media/movie6.mkv'] // 6/10 = 60%

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const pass = makeIngestPass(makeDeps({
        listVideoFiles: (root) => (root === '/media' ? seenList : []),
        statFile: () => null,
        fileExists: () => false,
      }))

      const result = await pass()

      expect(result.removed).toBe(0) // 消失去抖仍然只记第一次账，不代表哨兵没生效——这里断言的是"生效方式不同"
      for (let i = 7; i <= 10; i++) {
        expect(db.prepare(`SELECT misses FROM pending_removals WHERE path = '/media/movie${i}.mkv'`).get()).toEqual({ misses: 1 })
      }
      expect(errorSpy).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('makeIngestPass — 回归锁：审计点名的"同源失效"场景（walk 整根失败 + fileExists 全线不确定）', () => {
  it('walk 整根失败(seenPaths 空) + 磁盘复核对每条路径都给不出确定答案(模拟整挂载 ESTALE) → 零删除，连续两轮皆如此', async () => {
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    for (let e = 1; e <= 5; e++) {
      lib.upsertEpisode({
        id: `tmdb:1/s1e${e}`, seriesId: 'tmdb:1', season: 1, episode: e, name: `E${e}`,
        path: `/media/Show/s1e${e}.mkv`, subStatus: 'covered',
      })
    }
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: '/media/movie.mkv', subStatus: 'covered' })
    lib.addItemFile('tmdb:603', '/media/movie-replica.mkv', 1000)

    // walk() 遇到根目录本身 readdirSync 失败——seenPaths 整根为空（旧代码两个失效条件之一）。
    // 磁盘复核对每条路径都给不出确定答案——网络挂载抖动典型（ESTALE/EIO/ETIMEDOUT），旧代码
    // 默认 fileExists=裸 existsSync 会把这些无差别折叠成 false（"确认消失"），两个信号同源
    // 失效，一轮内批量误删整剧+电影+副本。新代码的 checkFileGone 把它们判 'unknown'，仅第①层
    // 防线就足以拦住——不需要等第②③层。
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [],
      checkFileGone: () => 'unknown',
    }))

    const result1 = await pass()
    expect(result1.removed).toBe(0)
    expect(result1.changed).toBe(false)
    for (let e = 1; e <= 5; e++) expect(lib.getEpisode(`tmdb:1/s1e${e}`)).not.toBeNull()
    expect(lib.getSeries('tmdb:1')).not.toBeNull()
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
    expect(lib.listItemFiles('tmdb:603')).toHaveLength(1)
    // 'unknown' 不进消失去抖记账——不该有任何 pending_removals 行残留。
    expect((db.prepare('SELECT COUNT(*) as c FROM pending_removals').get() as { c: number }).c).toBe(0)

    // 挂载持续闪断（连续第二轮仍然 unknown）——不是"debounce 只延迟了一轮，第二轮照样会删"。
    const result2 = await pass()
    expect(result2.removed).toBe(0)
    for (let e = 1; e <= 5; e++) expect(lib.getEpisode(`tmdb:1/s1e${e}`)).not.toBeNull()
    expect(lib.getSeries('tmdb:1')).not.toBeNull()
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
  })
})

describe('makeIngestPass — ingestLock', () => {
  it('held=true for the duration of the pass, observable from inside a fake dep', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/x.mkv')
    expect(ingestLock.held).toBe(false)
    let observedDuring: boolean | null = null
    const recognize = vi.fn(async () => {
      observedDuring = ingestLock.held
      return tvResult()
    })
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/x.mkv'], recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(observedDuring).toBe(true)
    expect(ingestLock.held).toBe(false)
  })

  it('released even when the pass throws (e.g. listVideoFiles itself blows up)', async () => {
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => { throw new Error('walk exploded') },
    }))

    await expect(pass()).rejects.toThrow('walk exploded')
    expect(ingestLock.held).toBe(false)
  })
})

// 债务D1（realign 出生信号换代）：磁盘布局规范形事实——识别层本来就看得见的事实
// （isCanonicalEpisodePath），落库为 series 级事实列，每轮全量重写（磁盘真相语义）。
describe('makeIngestPass — layout_nonstandard fact (debt D1)', () => {
  it('摄取一轮后 series.layout_nonstandard 反映本轮观察：平铺剧=1、规范形剧=0', async () => {
    const flatPath = '/media/Show Flat/ep1.mkv'
    const canonicalPath = '/media/Show Canon (2020) [tmdbid-22]/Season 01/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(flatPath)
    disk.setVideo(canonicalPath)
    const recognize = vi.fn(async (path: string) =>
      path === flatPath
        ? tvResult({ tmdbId: '11', season: 1, episode: 1 })
        : tvResult({ tmdbId: '22', season: 1, episode: 1 })
    )
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [flatPath, canonicalPath],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getSeries('tmdb:11')!.layout_nonstandard).toBe(1)
    expect(lib.getSeries('tmdb:22')!.layout_nonstandard).toBe(0)
  })

  it('布局修复后（文件挪到规范形路径）下一轮 pass 回落 0', async () => {
    const flatPath = '/media/Show Flat/ep1.mkv'
    const canonicalPath = '/media/Show Flat (2020) [tmdbid-33]/Season 01/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(flatPath, 5000, 12345)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '33', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [flatPath],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()
    expect(lib.getSeries('tmdb:33')!.layout_nonstandard).toBe(1)

    // 模拟 realign 已经把文件搬到规范形路径、DB 行的 path 列也已跟着改写（本测试只关心
    // layout_nonstandard 回落这一件事，不重放 realign 迁移本身跨轮次的落地细节）。
    lib.db.prepare('UPDATE episodes SET path = ? WHERE id = ?').run(canonicalPath, 'tmdb:33/s1e1')
    disk.removeVideo(flatPath)
    disk.setVideo(canonicalPath, 5000, 12345)

    const pass2 = makeIngestPass(makeDeps({
      listVideoFiles: () => [canonicalPath],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    await pass2()

    expect(lib.getSeries('tmdb:33')!.layout_nonstandard).toBe(0)
  })
})

describe('makeIngestPass — fault isolation', () => {
  it('recognize() throwing for one file does not kill the pass; other files still processed and the failed one is retried next pass', async () => {
    const disk = fakeDisk()
    disk.setVideo('/media/flaky.mkv')
    disk.setVideo('/media/ok.mkv')
    const recognize = vi.fn(async (path: string): Promise<Recognized | Park> => {
      if (path === '/media/flaky.mkv') throw new Error('transient TMDB blip')
      return tvResult({ tmdbId: '2', episode: 1 })
    })
    const log = vi.fn()
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => ['/media/flaky.mkv', '/media/ok.mkv'],
      recognize, log,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.scanned).toBe(2)
    expect(result.upserted).toBe(1)
    expect(lib.getEpisode('tmdb:2/s1e1')).not.toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/media/flaky.mkv'))
  })
})

// F-R2-6（R2 复审，审计定罪：ingest 覆盖路径绕过阶梯归零）：markCovered（find-subtitle worker
// 的 installed 落账）是"翻篇归零"的唯一入口，ingest 自己判出的 covered/embedded（手工放字幕、
// 内嵌轨被发现）从未归零 search_attempts——该行若之后又翻回 missing/unavailable，首次
// markUnavailable 直接沿用滞留的旧计数，跳过 1 天档、错落到更远的阶梯位置（R-3 不变式被绕过）。
describe('makeIngestPass — search_attempts 归零 (F-R2-6, R-3 不变式：覆盖路径亦需"翻篇归零")', () => {
  it('cheap path：unavailable→covered（sidecar 出现）时 search_attempts 归零', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    expect(lib.getEpisode('tmdb:1/s1e1')!.search_attempts).toBe(2)
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345) // video unchanged → memo hit, cheap path
    disk.addSidecar('/media/Show/Season 1/ep1.zh.srt')
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.sub_status).toBe('covered')
    expect(ep.search_attempts).toBe(0)
    expect(result.changed).toBe(true)
  })

  it('cheap path：unavailable→embedded（内嵌轨被 memo 记住）时 search_attempts 归零', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    expect(lib.getEpisode('tmdb:1/s1e1')!.search_attempts).toBe(1)
    // memo 记住的内嵌轨已含目标语言标签 —— cheap path 重跑分类时 rule 2 命中，无需真的探测。
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, ['chi'])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.sub_status).toBe('embedded')
    expect(ep.search_attempts).toBe(0)
  })

  it('full path（新识别/memo 过期，movie 分支）：unavailable→covered 时 search_attempts 归零', async () => {
    const path = '/media/movies/hero.mkv'
    lib.upsertMovie({ id: 'tmdb:603', name: 'The Matrix', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:603', '搜索穷尽', 1000)
    expect(lib.getMovie('tmdb:603')!.search_attempts).toBe(1)
    // 故意不设 probeMemo —— 走 full path（重新识别 + 探测），练到 upsertMovie 的 ON CONFLICT 分支。

    const disk = fakeDisk()
    disk.setVideo(path)
    disk.addSidecar('/media/movies/hero.zh.srt')
    const recognize = vi.fn(async () => movieResult({ tmdbId: '603', title: 'The Matrix' }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const movie = lib.getMovie('tmdb:603')!
    expect(movie.sub_status).toBe('covered')
    expect(movie.search_attempts).toBe(0)
  })

  // 验收场景（任务原文）：手工放字幕→ingest 判 covered→attempts 归零→sidecar 删→missing→
  // 首次 markUnavailable 回 1 天档（不是沿用滞留的旧 attempts、错落到更远的阶梯位置）。
  it('端到端：覆盖→归零→再消失→missing→首次 markUnavailable 回到 1 天档（不是沿用滞留的旧计数）', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const DAY = 86_400_000
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'S1E1', path, subStatus: 'missing' })
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', 1000)
    expect(lib.getEpisode('tmdb:1/s1e1')!.search_attempts).toBe(2)
    lib.setProbeMemo('tmdb:1/s1e1', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)

    // 1) 手工放字幕 → ingest 判 covered → attempts 归零
    disk.addSidecar('/media/Show/Season 1/ep1.zh.srt')
    const passCovered = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    await passCovered()
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('tmdb:1/s1e1')!.search_attempts).toBe(0)

    // 2) sidecar 删 → missing（video 本身未变，memo 仍命中，cheap path）
    disk.removeSidecar('/media/Show/Season 1/ep1.zh.srt')
    const passMissing = makeIngestPass(makeDeps({
      listVideoFiles: () => [path], fileExists: disk.fileExists, statFile: disk.statFile,
    }))
    await passMissing()
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')
    expect(lib.getEpisode('tmdb:1/s1e1')!.search_attempts).toBe(0) // 仍是 0——missing 转换本身不改动它

    // 3) 首次 markUnavailable → 1 天档（不是沿用滞留的旧 2 次计数错落到 4 天档）
    const NOW = 2_000_000
    lib.markUnavailable('tmdb:1/s1e1', '搜索穷尽', NOW)
    const ep = lib.getEpisode('tmdb:1/s1e1')!
    expect(ep.search_attempts).toBe(1)
    expect(ep.recheck_after).toBe(NOW + 1 * DAY)
  })
})

// dashboard G4：守备目录 DB 化——roots 不再是启动时冻结的静态数组，deps.roots 是惰性提供者
// （() => string[]），每轮 pass 起点才求值一次。这里直接接 SettingsRepo（cmdWatch 组装 ingestPass
// 时用的同一种 `() => settingsRepo.listRoots().map(r => r.path)` 写法）而不是 mock 一个手写的
// 可变数组，断言的是"生产接线会得到的真实行为"：POST /api/v2/settings/roots（=SettingsRepo.addRoot）
// 加根后，ingest 的下一轮 pass 就能扫到它，不需要重启进程重建 deps。
describe('makeIngestPass — roots 是惰性提供者（dashboard G4：守备目录 DB 化）', () => {
  it('deps.roots 每轮调用时才求值——加根后下一轮 pass 立刻扫描新根，不需要重建 ingestPass', async () => {
    const settings = new SettingsRepo(db)
    const seenRootsPerCall: string[][] = []
    const listVideoFiles = (root: string) => { seenRootsPerCall.push([root]); return [] }

    const pass = makeIngestPass(makeDeps({
      roots: () => settings.listRoots().map(r => r.path),
      listVideoFiles,
    }))

    settings.addRoot('/media/tv', 1_700_000_000_000)
    await pass()
    expect(seenRootsPerCall).toEqual([['/media/tv']])

    // POST /api/v2/settings/roots 的等价动作——运行期加一个新根，不重建 ingestPass 闭包。
    settings.addRoot('/media/anime', 1_700_000_001_000)
    seenRootsPerCall.length = 0
    await pass()
    expect(seenRootsPerCall.sort()).toEqual([['/media/anime'], ['/media/tv']])
  })
})

// 债务D5：target_languages 提供者化——每轮 pass 起点才求值，设置页改完后下一轮扫描生效。
describe('makeIngestPass — targetLanguages 是惰性提供者（债务D5）', () => {
  it('两轮返回不同 targetLanguages：内嵌 en 轨第一轮因目标为 zh 判 missing，第二轮目标改 en 判 embedded', async () => {
    const path = '/media/Show/Season 1/ep1.mkv'
    const disk = fakeDisk()
    disk.setVideo(path)
    const probe = vi.fn(async () => [track({ lang: 'eng', codec: 'subrip' })])
    let targets = ['zh']
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize: vi.fn(async () => tvResult()),
      probe,
      targetLanguages: () => targets,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('missing')

    targets = ['en']
    await pass()
    expect(lib.getEpisode('tmdb:1/s1e1')!.sub_status).toBe('embedded')
    // 第二轮命中 memo，无需重新探测
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

// 验收修复轮一 Task V1（design §A，用户裁决，一石二鸟）：pass 收尾处的富化重试——治愈"空名 ?
// 卡"（P6 认领只知道 tmdbId，写不出 name）与存量 genres 回填（schema v13 新列，NULL=尚未富化）。
describe('makeIngestPass — 富化重试（pass 收尾，spec §A 一石二鸟）', () => {
  it('空名/未富化 series 被补拍 name/chineseTitle/posterPath/year/genres', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: '' }) // 空名 ? 卡（模拟 P6 认领债务）
    const getDetails = vi.fn(async () => ({
      overview: null, runtimeMinutes: 24, posterPath: '/poster.jpg',
      originalTitle: 'Rescued Show', year: 2023, genreIds: [16, 35],
    }))
    const getChineseTitles = vi.fn(async () => ['救回剧'])
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails, getChineseTitles }),
      listVideoFiles: () => [], // 本轮无新文件，只测富化重试段
    }))

    const result = await pass()

    expect(getDetails).toHaveBeenCalledWith('tv', '24240')
    expect(getChineseTitles).toHaveBeenCalledWith('tv', '24240')
    const series = lib.getSeries('tmdb:24240')
    expect(series).toMatchObject({
      name: 'Rescued Show', chinese_title: '救回剧', poster_path: '/poster.jpg',
      year: 2023, genres: JSON.stringify([16, 35]),
    })
    // 富化重试不产生扫描计数变化（不是本轮 scanned/upserted 的文件）
    expect(result.scanned).toBe(0)
  })

  it('已富化（genres 非 NULL 且 name 非空）的剧不进候选清单，不被重跑', async () => {
    lib.upsertSeries({ id: 'tmdb:1', name: 'Already Good', genres: [35] })
    const getDetails = vi.fn(async () => ({
      overview: null, runtimeMinutes: null, posterPath: null, originalTitle: 'x', year: null, genreIds: [],
    }))
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails }),
      listVideoFiles: () => [],
    }))

    await pass()

    expect(getDetails).not.toHaveBeenCalled()
  })

  it('每轮 cap 10：候选超过 10 个时只补拍前 10 个（防 TMDB 抖动期连环空转）', async () => {
    for (let i = 0; i < 15; i++) lib.upsertSeries({ id: `tmdb:${i}`, name: '' })
    const getDetails = vi.fn(async () => ({
      overview: null, runtimeMinutes: null, posterPath: null, originalTitle: 'x', year: null, genreIds: [],
    }))
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails }),
      listVideoFiles: () => [],
    }))

    await pass()

    expect(getDetails).toHaveBeenCalledTimes(10)
  })

  it('TMDB 失败（getDetails 抛 TmdbRequestFailedError）时重试不写任何字段、不抛，下轮再试', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: '' })
    const getDetails = vi.fn(async () => { throw new TmdbRequestFailedError(new Error('ECONNREFUSED')) })
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails }),
      listVideoFiles: () => [],
    }))

    await expect(pass()).resolves.toMatchObject({ scanned: 0 }) // 不抛，pass 正常完成

    const series = lib.getSeries('tmdb:24240')
    expect(series).toMatchObject({ name: '', chinese_title: null, poster_path: null, year: null, genres: null })
    // 仍在候选清单里，下一轮 pass 会再试
    expect(lib.listSeriesNeedingEnrich(10).map((r) => r.id)).toEqual(['tmdb:24240'])
  })

  it('富化重试回填 imdb：现 provider_ids 无 imdb 时，external_ids 采到后并入', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: '' }) // 空名/未富化 → 进候选
    const getDetails = vi.fn(async () => ({
      overview: null, runtimeMinutes: 24, posterPath: '/poster.jpg',
      originalTitle: 'Rescued Show', year: 2023, genreIds: [16, 35],
    }))
    const getExternalIds = vi.fn(async () => ({ imdbId: 'tt24240' }))
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails, getExternalIds }),
      listVideoFiles: () => [],
    }))

    await pass()

    const series = lib.getSeries('tmdb:24240')
    expect(series).toMatchObject({
      name: 'Rescued Show',
      provider_ids: JSON.stringify({ tmdb: '24240', imdb: 'tt24240' }),
    })
  })

  it('富化重试回填 imdb：现 provider_ids 已含 imdb 时，不再覆盖/改写', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: '', providerIds: JSON.stringify({ tmdb: '24240', imdb: 'tt99999' }) })
    const getDetails = vi.fn(async () => ({
      overview: null, runtimeMinutes: 24, posterPath: '/poster.jpg',
      originalTitle: 'Rescued Show', year: 2023, genreIds: [16, 35],
    }))
    const getExternalIds = vi.fn(async () => ({ imdbId: 'tt24240' }))
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails, getExternalIds }),
      listVideoFiles: () => [],
    }))

    await pass()

    const series = lib.getSeries('tmdb:24240')
    // 现值已有 imdb → COALESCE 语义：不动，新采到的值不覆盖。
    expect(series!.provider_ids).toBe(JSON.stringify({ tmdb: '24240', imdb: 'tt99999' }))
  })

  // 债务D6：富化重试谓词护栏——404 死 id 必须落 '[]' 退出候选，瞬时失败保持 NULL 继续重试。
  it('D6：TMDB 回空 genres 时，genres 落 "[]" 并退出候选清单', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: 'Stub Name' })
    const getDetails = vi.fn(async () => ({
      overview: null, runtimeMinutes: null, posterPath: null,
      originalTitle: 'Rescued Show', year: null, genreIds: [] as number[],
    }))
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails }),
      listVideoFiles: () => [],
    }))

    await pass()

    const series = lib.getSeries('tmdb:24240')
    expect(series!.genres).toBe(JSON.stringify([]))
    expect(lib.listSeriesNeedingEnrich(10).map((r) => r.id)).not.toContain('tmdb:24240')
  })

  it('D6：404 死 id（getDetails 返回 null）时 genres 落 "[]" 并退出候选清单', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: 'Stub Name' })
    const getDetails = vi.fn(async () => null)
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails }),
      listVideoFiles: () => [],
    }))

    await pass()

    const series = lib.getSeries('tmdb:24240')
    expect(series!.genres).toBe(JSON.stringify([]))
    expect(lib.listSeriesNeedingEnrich(10).map((r) => r.id)).not.toContain('tmdb:24240')
  })

  it('D6：getDetails 瞬时失败时 genres 仍 NULL，保持在候选清单下轮重试', async () => {
    lib.upsertSeries({ id: 'tmdb:24240', name: 'Stub Name' })
    const getDetails = vi.fn(async () => { throw new TmdbRequestFailedError(new Error('ECONNREFUSED')) })
    const pass = makeIngestPass(makeDeps({
      tmdb: fakeTmdb({ getDetails }),
      listVideoFiles: () => [],
    }))

    await pass()

    const series = lib.getSeries('tmdb:24240')
    expect(series!.genres).toBeNull()
    expect(lib.listSeriesNeedingEnrich(10).map((r) => r.id)).toEqual(['tmdb:24240'])
  })
})

// 救援R4：特典机械三级排除——文件名级硬过滤受 exclude_extras 门控。
describe('makeIngestPass — mechanical extras (R4)', () => {
  it('excludeExtras=true → NCOP 文件 park excluded-extra，不进 recognize/probe', async () => {
    const disk = fakeDisk()
    const path = '/media/Show - NCOP01.mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult())
    const probe = vi.fn(async () => [] as EmbeddedSubtitleTrack[])
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize, probe,
      excludeExtras: () => true,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 1, upserted: 0, parked: 1, removed: 0, changed: false })
    expect(recognize).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    const parked = lib.listParkedPaths()
    expect(parked).toHaveLength(1)
    expect(parked[0]).toMatchObject({ path, park_reason: 'excluded-extra' })
  })

  it('excludeExtras=false → 同文件正常走 recognize，不park', async () => {
    const disk = fakeDisk()
    const path = '/media/Show - NCOP01.mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      excludeExtras: () => false,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.parked).toBe(0)
    expect(recognize).toHaveBeenCalledWith(path)
    expect(lib.getEpisode('tmdb:1/s1e1')).not.toBeNull()
  })

  it('excludeExtras 未提供时默认 false，不启用机械过滤', async () => {
    const disk = fakeDisk()
    const path = '/media/Show - NCOP01.mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    expect(result.parked).toBe(0)
    expect(recognize).toHaveBeenCalledWith(path)
  })

  it('R4b：已翻案豁免的 path 即使命中 NC 正则也跳过铁案，重走 recognize（防再排除循环）', async () => {
    const disk = fakeDisk()
    const path = '/media/Show - NCOP01.mkv'
    disk.setVideo(path)
    lib.addExtrasExemption(path, 1000) // 用户此前翻过案
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      excludeExtras: () => true, // 开关开着，但豁免优先
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    const result = await pass()

    // 没被再排除——豁免让它绕过铁案，正常进识别流
    expect(result.parked).toBe(0)
    expect(recognize).toHaveBeenCalledWith(path)
    expect(lib.getEpisode('tmdb:1/s1e1')).not.toBeNull()
  })
})

// 救援R5（rule 4b）：aggressive 档机械直判——发布组标记 + 探针确认零内嵌字幕轨 → hardsub-assumed，
// 不落 missing（不会被派 find-subtitle worker 徒劳搜索）。
describe('makeIngestPass — hardsub-assumed 机械直判 (R5 rule 4b)', () => {
  it("hardsubMode='aggressive' + 发布组标记 + probe 确认零内嵌轨 → 直判 hardsub-assumed", async () => {
    const disk = fakeDisk()
    const path = '/media/[SubsPlease] Show - 01 [1080p].mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]), // 探针真的跑了，零轨
      hardsubMode: () => 'aggressive',
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    const ep = lib.getEpisode('tmdb:1/s1e1')
    expect(ep?.sub_status).toBe('hardsub-assumed')
    expect(ep?.status_reason).toMatch(/aggressive/)
  })

  it("hardsubMode='agent'：worker 侧判断，机械层不代劳——同款证据下仍落 missing", async () => {
    const disk = fakeDisk()
    const path = '/media/[SubsPlease] Show - 01 [1080p].mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      hardsubMode: () => 'agent',
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')?.sub_status).toBe('missing')
  })

  it("hardsubMode='off'（缺省）：同款证据下仍落 missing", async () => {
    const disk = fakeDisk()
    const path = '/media/[SubsPlease] Show - 01 [1080p].mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')?.sub_status).toBe('missing')
  })

  it('aggressive 档但无发布组标记的文件名 → 仍落 missing（标记是硬证据，不是可选项）', async () => {
    const disk = fakeDisk()
    const path = '/media/Show - 01.mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      probe: vi.fn(async () => [] as EmbeddedSubtitleTrack[]),
      hardsubMode: () => 'aggressive',
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')?.sub_status).toBe('missing')
  })

  it('aggressive 档 + 发布组标记，但探针不可用（null，不是确认零轨）→ 不判定，仍落 missing', async () => {
    const disk = fakeDisk()
    const path = '/media/[SubsPlease] Show - 01 [1080p].mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      probe: vi.fn(async () => null), // 探针不可用=不知道，不是"确认没有"
      hardsubMode: () => 'aggressive',
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    expect(lib.getEpisode('tmdb:1/s1e1')?.sub_status).toBe('missing')
  })

  it('aggressive 档 + 发布组标记 + 探针确认有内嵌轨（非零）→ 不判定 hardsub-assumed', async () => {
    const disk = fakeDisk()
    const path = '/media/[SubsPlease] Show - 01 [1080p].mkv'
    disk.setVideo(path)
    const recognize = vi.fn(async () => tvResult({ tmdbId: '1', season: 1, episode: 1 }))
    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      recognize,
      probe: vi.fn(async () => [track({ lang: 'eng' })]),
      targetLanguages: () => ['eng'],
      hardsubMode: () => 'aggressive',
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))

    await pass()

    // 命中 rule 2（embedded），不会走到 rule 4b
    expect(lib.getEpisode('tmdb:1/s1e1')?.sub_status).toBe('embedded')
  })
})
