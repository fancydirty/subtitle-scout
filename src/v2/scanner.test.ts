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

  it('IsExternal 缺失的中字轨仍归 embedded（无外挂标记视为内嵌）', () => {
    const item = movieItem({
      MediaStreams: [
        { Type: 'Subtitle', Language: 'chi', Codec: 'subrip' },
      ] as any,
    })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('embedded')
  })

  it('IsExternal=true 的中字轨归 covered 而非 embedded（Jellyfin 登记的盘上 sidecar）', () => {
    // 生产实案：字幕落盘后 Jellyfin FullRefresh 把外挂字幕收进 MediaStreams，
    // 下一轮 scan 不得把它误判成 embedded 导致账目从 covered 漂移。
    const item = movieItem({
      MediaStreams: [
        { Type: 'Video', Codec: 'h264' },
        { Type: 'Subtitle', Language: 'zh-Hans', IsExternal: true, Codec: 'subrip' },
      ] as any,
    })
    // 不依赖 fileExists——MediaStreams 里的 IsExternal=true 本身就是外挂证据
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('covered')
  })

  it('内嵌+外挂中字轨并存 → covered 优先（外挂是 scout 战果/用户手动放置，展示价值更高）', () => {
    const item = movieItem({
      MediaStreams: [
        { Type: 'Subtitle', Language: 'zh-Hans', IsExternal: false, Codec: 'ass' },
        { Type: 'Subtitle', Language: 'zh-Hant', IsExternal: true, Codec: 'subrip' },
      ] as any,
    })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('covered')
  })

  it('IsExternal=true 但仅图形字幕（PGS）不算可用 → missing', () => {
    const item = movieItem({
      MediaStreams: [
        { Type: 'Subtitle', Language: 'zh-Hans', IsExternal: true, Codec: 'PGSSUB' },
      ] as any,
    })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true })
    expect(status).toBe('missing')
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

  it('Episode 有 SeriesId 无 SeriesName：scan 不炸且 series 行存在（FK guard）', async () => {
    const pages = [[epItem('e1', 1, 1, { SeriesName: undefined })], []]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 10,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    // series 行必须存在（name 用 SeriesId 兜底），episode 正常入库
    expect(lib.db.prepare('select id, name from series where id=?').get('s1')).toMatchObject({ id: 's1', name: 's1' })
    expect(lib.getEpisode('e1')).not.toBeNull()
  })
})
