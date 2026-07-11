import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { classifyItem, scanLibrary, type OriginResolver } from './scanner.js'
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

describe('classifyItem: TMDB origin gate (rule 0/1/1b)', () => {
  const mappings = [{ from: '/media', to: '/mnt/media' }]

  it('zh origin → ignored before any other rule', () => {
    const item = movieItem({ ProductionLocations: [] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true, originLang: 'zh' })
    expect(status).toBe('ignored')
  })

  it('ja origin → NOT ignored (falls through to missing)', () => {
    const item = movieItem({ ProductionLocations: [] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true, originLang: 'ja' })
    expect(status).toBe('missing')
  })

  it('fallback: null origin + Chinese ProductionLocations (movie) → ignored', () => {
    const item = movieItem({ ProductionLocations: ['China'] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true, originLang: null })
    expect(status).toBe('ignored')
  })

  it('fallback: null origin + Han-only series title + no ProductionLocations signal → ignored', () => {
    // ProductionLocations 显式置空（无权威信号）——与下面"有权威信号"的用例对照，
    // 隔离测试标题启发式本身。（此用例此前误用 epItem 默认的
    // ProductionLocations=['United States']，实际编码了 bug 本身：非国产地区却因
    // 中文标题被 ignored；已改为显式无信号场景，真正的权威信号场景见下一条用例。）
    const item = epItem('e1', 1, 1, { SeriesName: '三体', ProductionLocations: [] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true, originLang: null })
    expect(status).toBe('ignored')
  })

  it('fallback: null origin + kana series title → NOT ignored', () => {
    const item = epItem('e1', 1, 1, { SeriesName: '進撃の巨人' })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true, originLang: null })
    expect(status).toBe('missing')
  })

  it('fallback: null origin + Han-only series title BUT ProductionLocations proves non-Chinese origin → NOT ignored (authoritative evidence outranks title heuristic)', () => {
    // 生产实案：Jellyfin 库把《生活大爆炸》本地化命名为中文，但 ProductionLocations=['United States']
    // 已经证明非国产。权威信号（ProductionLocations）必须否决粗糙的标题启发式（rule 1b）。
    const item = epItem('e1', 1, 1, {
      SeriesName: '生活大爆炸',
      ProductionLocations: ['United States'],
    })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: true, originLang: null })
    expect(status).toBe('missing')
  })

  it('skipChineseOrigin=false disables ALL origin skipping (zh still processed)', () => {
    const item = movieItem({ ProductionLocations: [] })
    const status = classifyItem(item, { fileExists: () => false, mappings, skipChineseOrigin: false, originLang: 'zh' })
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

  it('captures poster_tag: episode → series.poster_tag, movie → movies.poster_tag', async () => {
    const pages = [
      [epItem('e1', 1, 1, { SeriesPrimaryImageTag: 'series-ptag' })],
      [movieItem({ ImageTags: { Primary: 'movie-ptag', Backdrop: 'x' } })],
      [],
    ]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 10,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
    })
    expect((lib.db.prepare('select poster_tag from series where id=?').get('s1') as any).poster_tag).toBe('series-ptag')
    expect(lib.getMovie('m1')!.poster_tag).toBe('movie-ptag')
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

  it('caches series origin once and reads it for episodes', async () => {
    let calls = 0
    const resolver: OriginResolver = { originFor: async () => { calls++; return 'zh' } }
    const pages = [
      [epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' }), epItem('e2', 1, 2, { SeriesId: 's9', SeriesName: 'Series 9' })],
      [],
    ]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(lib.getSeriesOriginLang('s9')).toBe('zh')
    expect(lib.getEpisode('e1')!.sub_status).toBe('ignored')
    expect(calls).toBe(1) // resolved once, second episode reads cache
  })

  it('negative-cache: unresolved (null) series origin is cached once, not re-resolved per episode', async () => {
    // 生产实案：TMDB 无法判定该剧 origin（无 provider id / 请求失败），resolver 每次都返回 null。
    // 修复前：originLang 永远缓存不上（只在 resolved!=null 时写回），每集都会重新回查一次，
    // 100 集的剧每轮 scan 就是 100 次 jf.getItem 调用，永不收敛。
    let calls = 0
    const resolver: OriginResolver = { originFor: async () => { calls++; return null } }
    const pages = [
      [
        epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' }),
        epItem('e2', 1, 2, { SeriesId: 's9', SeriesName: 'Series 9' }),
        epItem('e3', 1, 3, { SeriesId: 's9', SeriesName: 'Series 9' }),
      ],
      [],
    ]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(calls).toBe(1) // resolved-to-unknown once for the series, not once per episode
  })

  it('negative-cache: sentinel persists across scans — resolver not called again on a later scan', async () => {
    let calls = 0
    const resolver: OriginResolver = { originFor: async () => { calls++; return null } }

    const pages1 = [[epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' })], []]
    const jf1: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages1.shift() ?? []),
    }
    await scanLibrary(jf1, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(calls).toBe(1)

    // Second scan (later reconcile cycle) — the negative cache from scan 1 must still hold.
    const pages2 = [[epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' })], []]
    const jf2: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages2.shift() ?? []),
    }
    await scanLibrary(jf2, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(calls).toBe(1) // still 1 — resolver was NOT called again on the second scan
  })

  it('negative-cache: cached-unknown series still falls through to fallback heuristics for classification (sentinel != resolved-zh)', () => {
    // 缓存 sentinel 不能污染分类：classifyItem 必须继续把 unknown 当 null 处理，
    // 否则 rule 1/1b 的兜底启发式会被"已解析但值是 unknown"误判为"已解析、跳过兜底"，
    // 导致缓存写入后国产内容反而漏判（不再 ignored）。
    const item = movieItem({ ProductionLocations: ['China'] })
    const status = classifyItem(item, {
      fileExists: () => false,
      mappings: [{ from: '/media', to: '/mnt/media' }],
      skipChineseOrigin: true,
      originLang: null, // scanner.ts must pass null (not the raw 'unknown' sentinel) here
    })
    expect(status).toBe('ignored')
  })

  it('negative-cache: scanLibrary end-to-end — cached-unknown series origin still falls through to ProductionLocations heuristic (rule 1), episode stays ignored on both scans', async () => {
    // 端到端回归：上面那条测试直接调 classifyItem(originLang: null)，绕过了 scanner.ts 里
    // resolvedOriginForClassification 那次哨兵换算，测不出「scanner.ts 忘了换算、把裸的
    // ORIGIN_UNKNOWN='unknown' 字符串传进 classifyItem」这种回归（'unknown' !== null，
    // rule 1 的 `deps.originLang == null` 判断会直接失手，国产内容漏判 ignored）。
    // 这里改为通过 scanLibrary 走完整路径：resolver 解不出结果（返回 null，被写成
    // ORIGIN_UNKNOWN 哨兵缓存），条目自带 ProductionLocations=['China']，
    // 断言落库的 sub_status 在首次扫描和缓存命中的第二次扫描都是 'ignored'。
    const resolver: OriginResolver = { originFor: async () => null }
    const zhLocationEpisode = () =>
      epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9', ProductionLocations: ['China'] })

    const pages1 = [[zhLocationEpisode()], []]
    const jf1: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages1.shift() ?? []),
    }
    await scanLibrary(jf1, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(lib.getSeriesOriginLang('s9')).toBe('unknown')
    expect(lib.getEpisode('e1')!.sub_status).toBe('ignored')

    // Second scan (cache hit path — resolver not consulted again, sentinel read from DB).
    const pages2 = [[zhLocationEpisode()], []]
    const jf2: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages2.shift() ?? []),
    }
    await scanLibrary(jf2, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(lib.getEpisode('e1')!.sub_status).toBe('ignored')
  })

  it('negative-cache: unresolved movie origin is cached once, not re-resolved on a later scan', async () => {
    let calls = 0
    const resolver: OriginResolver = { originFor: async () => { calls++; return null } }

    const pages1 = [[movieItem({ Id: 'm9' })], []]
    const jf1: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages1.shift() ?? []),
    }
    await scanLibrary(jf1, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(calls).toBe(1)

    const pages2 = [[movieItem({ Id: 'm9' })], []]
    const jf2: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages2.shift() ?? []),
    }
    await scanLibrary(jf2, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(calls).toBe(1) // still 1 — resolver was NOT called again on the second scan
  })

  it('movie origin resolved + cached + classified ignored', async () => {
    const resolver: OriginResolver = { originFor: async () => 'zh' }
    const pages = [[movieItem({ Id: 'm1' })], []]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver,
    })
    expect(lib.getMovieOriginLang('m1')).toBe('zh')
    expect(lib.getMovie('m1')!.sub_status).toBe('ignored')
  })

  it('resolver FAILURE (series): nothing cached — origin re-resolved next scan, gate recovers', async () => {
    // 核心缺陷回归：TMDB 一次故障绝不能把 ORIGIN_UNKNOWN 哨兵写进缓存——
    // 否则该系列的权威 origin gate 被永久关闭（没有任何路径清 origin_lang）。
    // 瞬时失败必须留空（下轮 scan 重试），与正向路径"解析成功才写缓存"对称。
    let calls = 0
    const failingResolver: OriginResolver = {
      originFor: async () => { calls++; throw new Error('TMDB down') },
    }

    const pages1 = [[epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' })], []]
    const jf1: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages1.shift() ?? []),
    }
    await scanLibrary(jf1, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: failingResolver,
    })
    expect(calls).toBe(1)
    expect(lib.getSeriesOriginLang('s9')).toBeNull() // NOT the 'unknown' sentinel
    expect(lib.getEpisode('e1')!.sub_status).toBe('missing') // scan 本身不炸，条目照常入库

    // TMDB 恢复后的下一轮 scan：必须重新回查（缓存为空），权威 gate 立即生效。
    const recoveredResolver: OriginResolver = { originFor: async () => { calls++; return 'zh' } }
    const pages2 = [[epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' })], []]
    const jf2: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages2.shift() ?? []),
    }
    await scanLibrary(jf2, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: recoveredResolver,
    })
    expect(calls).toBe(2) // re-resolved (a cached sentinel would have short-circuited this)
    expect(lib.getSeriesOriginLang('s9')).toBe('zh')
    expect(lib.getEpisode('e1')!.sub_status).toBe('ignored')
  })

  it('resolver FAILURE (movie): nothing cached — origin re-resolved next scan, gate recovers', async () => {
    let calls = 0
    const failingResolver: OriginResolver = {
      originFor: async () => { calls++; throw new Error('TMDB down') },
    }
    const pages1 = [[movieItem({ Id: 'm9', ProductionLocations: [] })], []]
    const jf1: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages1.shift() ?? []),
    }
    await scanLibrary(jf1, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: failingResolver,
    })
    expect(calls).toBe(1)
    expect(lib.getMovieOriginLang('m9')).toBeNull() // NOT the 'unknown' sentinel
    expect(lib.getMovie('m9')!.sub_status).toBe('missing')

    const recoveredResolver: OriginResolver = { originFor: async () => { calls++; return 'zh' } }
    const pages2 = [[movieItem({ Id: 'm9', ProductionLocations: [] })], []]
    const jf2: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages2.shift() ?? []),
    }
    await scanLibrary(jf2, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: recoveredResolver,
    })
    expect(calls).toBe(2)
    expect(lib.getMovieOriginLang('m9')).toBe('zh')
    expect(lib.getMovie('m9')!.sub_status).toBe('ignored')
  })

  it('resolver FAILURE + Chinese-looking localized title of a non-Chinese show → NOT ignored (title heuristic suppressed during outage)', async () => {
    // 与"genuine no-data → 标题启发式兜底生效"的关键区别：no-data 时启发式是仅剩的最好信号，
    // 而瞬时失败时我们明知下轮 scan 就有权威数据——绝不能凭粗糙的标题启发式先把
    // 中文化命名的外国剧（无 ProductionLocations 刮削数据）打成 ignored。
    const failingResolver: OriginResolver = {
      originFor: async () => { throw new Error('TMDB down') },
    }
    const pages = [
      [epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: '怪奇物语', ProductionLocations: [] })],
      [],
    ]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: failingResolver,
    })
    expect(lib.getEpisode('e1')!.sub_status).toBe('missing') // NOT ignored
    expect(lib.getSeriesOriginLang('s9')).toBeNull()
  })

  it('resolver FAILURE + authoritative Chinese ProductionLocations → still ignored this scan (authoritative evidence unaffected by outage), origin NOT cached', async () => {
    // ProductionLocations 是权威信号（合并规则：权威证据 outranks 标题启发式），
    // TMDB 挂掉不影响它的效力——真国产条目在故障窗口内照样 ignored。
    // 但 origin_lang 缓存仍必须留空，下轮 scan 重新问 TMDB。
    const failingResolver: OriginResolver = {
      originFor: async () => { throw new Error('TMDB down') },
    }
    const pages = [
      [epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9', ProductionLocations: ['China'] })],
      [],
    ]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: failingResolver,
    })
    expect(lib.getEpisode('e1')!.sub_status).toBe('ignored')
    expect(lib.getSeriesOriginLang('s9')).toBeNull()
  })

  it('resolver FAILURE memoized within a single scan — one attempt per series, not per episode', async () => {
    // 故障窗口内不能退化回 O(集数) 的外部调用（resolver 每次 15s 超时的话，
    // 100 集的剧一轮 scan 就挂 25 分钟）；同一系列本轮只试一次，下轮 scan 再重试。
    let calls = 0
    const failingResolver: OriginResolver = {
      originFor: async () => { calls++; throw new Error('TMDB down') },
    }
    const pages = [
      [
        epItem('e1', 1, 1, { SeriesId: 's9', SeriesName: 'Series 9' }),
        epItem('e2', 1, 2, { SeriesId: 's9', SeriesName: 'Series 9' }),
        epItem('e3', 1, 3, { SeriesId: 's9', SeriesName: 'Series 9' }),
      ],
      [],
    ]
    const jf: Pick<PlayerServer, 'getItemsPage'> = {
      getItemsPage: vi.fn(async () => pages.shift() ?? []),
    }
    await scanLibrary(jf, lib, {
      pageSize: 50,
      fileExists: () => false,
      mappings,
      skipChineseOrigin: true,
      resolver: failingResolver,
    })
    expect(calls).toBe(1) // failure memoized for the scan
    expect(lib.getSeriesOriginLang('s9')).toBeNull() // and still nothing cached
  })
})
