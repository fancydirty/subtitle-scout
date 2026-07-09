import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { classifyItem, scanLibrary } from './scanner.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'

let lib: LibraryRepo
beforeEach(() => {
  lib = new LibraryRepo(openDb(':memory:'))
})

function movieItem(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: 'm1',
    Name: 'The Matrix',
    Type: 'Movie',
    Path: '/media/movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264.mkv',
    ProductionYear: 1999,
    ProductionLocations: ['United States of America'],
    ProviderIds: { Imdb: 'tt0133093' },
    MediaStreams: [],
    ...overrides,
  } as JellyfinItem
}

function epItem(id: string, season = 1, episode = 1, overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: id,
    Name: `Episode ${episode}`,
    Type: 'Episode',
    SeriesId: 's1',
    SeriesName: 'Test Series',
    Path: `/media/tv/Show/Season ${season}/Show.S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}.mkv`,
    ParentIndexNumber: season,
    IndexNumber: episode,
    ProductionLocations: ['United States'],
    MediaStreams: [],
    ...overrides,
  } as JellyfinItem
}

describe('classifyItem', () => {
  const mappings = [{ from: '/media', to: '/mnt/media' }]

  it('Chinese origin → ignored', () => {
    const item = movieItem({ ProductionLocations: ['China', 'Hong Kong'] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('ignored')
  })

  it('embedded Chinese subtitle → embedded', () => {
    const item = movieItem({
      MediaStreams: [
        { Type: 'Video', Codec: 'h264' },
        { Type: 'Subtitle', Language: 'zh-Hans', IsExternal: false, Codec: 'ass' },
      ] as any,
    })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('embedded')
  })

  it('external sidecar on disk → covered', () => {
    const item = movieItem({ Path: '/media/movies/Matrix/movie.mkv' })
    const fileExists = vi.fn((p: string) => p === '/mnt/media/movies/Matrix/movie.zh-Hans.srt')
    const status = classifyItem(item, { fileExists, mappings, skipChineseOrigin: true })
    expect(status).toBe('covered')
    expect(fileExists).toHaveBeenCalled()
  })

  it('no Chinese subtitle → missing', () => {
    const item = movieItem()
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('missing')
  })

  it('skipChineseOrigin=false allows Chinese origin through', () => {
    const item = movieItem({ ProductionLocations: ['China'] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: false })
    expect(status).toBe('missing')
  })
})

describe('scanLibrary', () => {
  const mappings = [{ from: '/media', to: '/mnt/media' }]

  it('paged full scan, mirrors episodes and movies', async () => {
    const pages = [
      [epItem('e1', 1, 1), epItem('e2', 1, 2)],
      [movieItem({ Id: 'm1' })],
      [],
    ]
    let callIndex = 0
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async (startIndex: number) => {
        const page = pages[callIndex++] ?? []
        return page
      }),
    }
    await scanLibrary(jf, lib, {
      pageSize: 2,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    expect(lib.db.prepare('select count(*) as c from episodes').get()).toMatchObject({ c: 2 })
    expect(lib.db.prepare('select count(*) as c from movies').get()).toMatchObject({ c: 1 })
    expect(lib.db.prepare('select count(*) as c from series').get()).toMatchObject({ c: 1 })
    const meta = lib.db.prepare("select value from meta where key='last_scan_at'").get() as any
    expect(meta.value).toBeTruthy()
  })

  it('second scan is idempotent', async () => {
    const pages = [[epItem('e1')], [movieItem()], []]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 10,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    const snap1 = {
      episodes: lib.db.prepare('select id, sub_status from episodes order by id').all(),
      movies: lib.db.prepare('select id, sub_status from movies order by id').all(),
    }
    // Second scan
    const pages2 = [[epItem('e1')], [movieItem()], []]
    const jf2: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages2.shift() ?? []),
    }
    await scanLibrary(jf2, lib, {
      pageSize: 10,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    const snap2 = {
      episodes: lib.db.prepare('select id, sub_status from episodes order by id').all(),
      movies: lib.db.prepare('select id, sub_status from movies order by id').all(),
    }
    expect(snap2).toEqual(snap1)
  })

  it('unavailable status is preserved when reality says missing', async () => {
    lib.upsertSeries({ id: 's1', name: 'Test' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/media/tv/ep1.mkv',
      subStatus: 'missing',
    })
    lib.markUnavailable('e1', 'search exhausted', Date.now() + 86400000)
    expect(lib.getEpisode('e1')!.sub_status).toBe('unavailable')

    const pages = [[epItem('e1')], []]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 10,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    // Should remain unavailable, not overwritten by missing
    expect(lib.getEpisode('e1')!.sub_status).toBe('unavailable')
  })

  it('unavailable is overwritten when reality says covered', async () => {
    lib.upsertSeries({ id: 's1', name: 'Test' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: 'Ep1',
      path: '/media/tv/ep1.mkv',
      subStatus: 'missing',
    })
    lib.markUnavailable('e1', 'search exhausted', Date.now() + 86400000)

    const pages = [[epItem('e1', 1, 1, { Path: '/media/tv/ep1.mkv' })], []]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 10,
      fileExists: (p) => p.includes('ep1') && p.includes('.zh-Hans.srt'),
      mappings,
      skipChineseOrigin: true,
    })
    // Should be overwritten to covered
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
  })

  it('Episode without SeriesId is skipped', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pages = [[epItem('e1', 1, 1, { SeriesId: undefined })], []]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 10,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    expect(lib.db.prepare('select count(*) as c from episodes').get()).toMatchObject({ c: 0 })
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining('Episode without SeriesId'))
    consoleWarn.mockRestore()
  })
})
