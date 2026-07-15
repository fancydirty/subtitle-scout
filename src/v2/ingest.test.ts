import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { makeIngestPass, ingestLock, looksChineseTitle, type IngestDeps } from './ingest.js'
import type { Recognized, Park } from '../recognition/index.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'

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
  getSeasonTable?: (tvId: string) => Promise<{ seasonNumber: number; episodeCount: number; airDate: string | null }[] | null>
  getAbsoluteOrder?: (tvId: string) => Promise<{ season: number; episode: number }[] | null>
}
function fakeTmdb(opts: FakeTmdbOpts = {}): TmdbClient {
  return {
    getOriginLanguage: opts.getOriginLanguage ?? (async () => null),
    getDetails: opts.getDetails ?? (async () => null),
    getChineseTitles: opts.getChineseTitles ?? (async () => []),
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
    roots: ['/media'],
    lib,
    tmdb: fakeTmdb(),
    recognize: vi.fn(async (): Promise<Recognized | Park> => tvResult()),
    probe: vi.fn(async (): Promise<EmbeddedSubtitleTrack[] | null> => []),
    listVideoFiles: () => [],
    fileExists: () => false,
    statFile: () => null,
    targetLanguages: ['zh'],
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
      getDetails: async () => ({ overview: 'x', runtimeMinutes: 24, posterPath: '/poster.jpg', originalTitle: 'Show OT', year: 2020 }),
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
      getDetails: async () => ({ overview: null, runtimeMinutes: 136, posterPath: '/matrix.jpg', originalTitle: null, year: 1999 }),
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
// 一个 path；不设防的话两条路径会在每一轮互相"抢" path 列——findRowByPath 按字面 path 查，谁都
// 找不到自己上一轮写的行，于是永远走 FULL PATH、永远 upserted++，在完全安静的库上 upserted 计数
// 永远不收敛到 0（真·幂等性泄漏，非 by-design：其余任何"每轮都会重跑"的既有行为——12 个 TMDB
// 抖动重试、park 条目本身每轮重新尝试——都有各自的既有理由且不计入 upserted；这一类没有）。
describe('makeIngestPass — idempotency: duplicate on-disk paths resolving to the same identity (Bug 2 fix)', () => {
  it('two TV paths recognized to the same tmdbId/season/episode: first pass creates the row + parks the loser; subsequent passes on a quiet disk do NOT re-upsert either one', async () => {
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
    expect(r1.parked).toBe(1)

    const r2 = await pass()
    expect(r2.upserted).toBe(0) // quiet disk — must NOT still be re-upserting
    expect(r2.parked).toBe(1)

    const r3 = await pass()
    expect(r3.upserted).toBe(0)
    expect(r3.parked).toBe(1)

    const episode = lib.getEpisode('tmdb:1/s1e1')
    expect(episode).not.toBeNull()
    // exactly one of the two paths stably owns the row across all three passes — no ping-pong.
    expect([pathA, pathB]).toContain(episode!.path)
    const parkedPaths = lib.listParkedPaths().map((p) => p.path)
    expect(parkedPaths).toHaveLength(1)
    expect([pathA, pathB]).toContain(parkedPaths[0])
    expect(parkedPaths[0]).not.toBe(episode!.path)
  })

  it('the losing duplicate path parks with an honest, distinct reason (duplicate-content)', async () => {
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

    const parked = lib.listParkedPaths()
    expect(parked).toHaveLength(1)
    expect(parked[0].park_reason).toBe('duplicate-content')
    expect(lib.getMovie('tmdb:603')).not.toBeNull()
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
      targetLanguages: ['zh'],
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
      targetLanguages: ['en'],
      originSkipLanguages: ['en'],
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
  it('a library row whose path is no longer seen AND no longer exists on disk → row removed, series dropped when it becomes empty', async () => {
    lib.upsertSeries({ id: 'tmdb:1', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:1/s1e1', seriesId: 'tmdb:1', season: 1, episode: 1, name: 'x', path: '/media/gone.mkv', subStatus: 'covered' })

    const pass = makeIngestPass(makeDeps({
      listVideoFiles: () => [], // nothing seen this pass
      fileExists: () => false, // confirmed gone
    }))

    const result = await pass()

    expect(result).toEqual({ scanned: 0, upserted: 0, parked: 0, removed: 1, changed: true })
    expect(lib.getEpisode('tmdb:1/s1e1')).toBeNull()
    expect(lib.getSeries('tmdb:1')).toBeNull()
  })

  it('series survives if a sibling episode remains', async () => {
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

    await pass()

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

  it('movie row removal (mirrors episode branch)', async () => {
    lib.upsertMovie({ id: 'tmdb:603', name: 'M', path: '/media/gone.mkv', subStatus: 'covered' })
    const pass = makeIngestPass(makeDeps({ listVideoFiles: () => [], fileExists: () => false }))
    const result = await pass()
    expect(result.removed).toBe(1)
    expect(lib.getMovie('tmdb:603')).toBeNull()
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
