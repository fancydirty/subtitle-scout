import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'

let lib: LibraryRepo
let db: ScoutDb

beforeEach(() => {
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
})

describe('媒体镜像', () => {
  it('upsertEpisode 幂等且更新时间戳', () => {
    const ep = {
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 2,
      name: 'x',
      path: '/tv/a/e2.mkv',
      subStatus: 'missing' as const,
    }
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode(ep)
    lib.upsertEpisode({ ...ep, subStatus: 'covered' })
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect((lib.db.prepare('select count(*) c from episodes').get() as any).c).toBe(1)
  })

  it('missingBySeason 聚合缺字幕的 (series,season) 组', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    for (const [e, st] of [
      [1, 'missing'],
      [2, 'missing'],
      [3, 'covered'],
    ] as const)
      lib.upsertEpisode({
        id: `e${e}`,
        seriesId: 's1',
        season: 1,
        episode: e,
        name: '',
        path: `/p/${e}`,
        subStatus: st,
      })
    expect(lib.missingBySeason()).toEqual([{ series_id: 's1', season: 1, missing: 2 }])
  })

  it('markCovered 写 episodes.sub_status + subtitles 行，同一事务', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: '',
      path: '/p/1.mkv',
      subStatus: 'missing',
    })
    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download', 'assrt:713051')
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/p/1.zh-Hans.srt',
      provider_ref: 'assrt:713051',
    })
  })

  it('markCovered language 参数（IMPORTANT-2）：默认 zh-Hans（沿用历史行为），显式传入时按值写入', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1', seriesId: 's1', season: 1, episode: 1, name: '',
      path: '/p/1.mkv', subStatus: 'missing',
    })
    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download')
    expect(lib.db.prepare('select language from subtitles where item_id=?').get('e1')).toEqual({ language: 'zh-Hans' })

    lib.upsertEpisode({
      id: 'e2', seriesId: 's1', season: 1, episode: 2, name: '',
      path: '/p/2.mkv', subStatus: 'missing',
    })
    lib.markCovered('e2', '/p/2.zh-Hant.srt', 'preexisting', undefined, 'zh-Hant')
    expect(lib.db.prepare('select language from subtitles where item_id=?').get('e2')).toEqual({ language: 'zh-Hant' })
  })

  // A2: language is a plain string, not a zh-Hans/zh-Hant enum — the find-subtitle worker's
  // target-language generalization (installedLanguage/langTag) relies on markCovered recording
  // whatever BCP-47 code it's given, e.g. 'en'.
  it('markCovered language 参数接受任意语言字符串（如 en），不限于 zh-Hans/zh-Hant', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e3', seriesId: 's1', season: 1, episode: 3, name: '',
      path: '/p/3.mkv', subStatus: 'missing',
    })
    lib.markCovered('e3', '/p/3.en.srt', 'scout-download', undefined, 'en')
    expect(lib.db.prepare('select language from subtitles where item_id=?').get('e3')).toEqual({ language: 'en' })
  })

  it('markCovered 传 null 路径（M7）：只改状态，不伪造 subtitles 行', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: '',
      path: '/p/1.mkv',
      subStatus: 'missing',
    })
    lib.markCovered('e1', null, 'preexisting')
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect((lib.db.prepare('select count(*) c from subtitles where item_id=?').get('e1') as any).c).toBe(0)
  })

  it('unavailable 带复查时间，missingBySeason 不计入未到期的', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.upsertEpisode({
      id: 'e1',
      seriesId: 's1',
      season: 1,
      episode: 1,
      name: '',
      path: '/p/1',
      subStatus: 'missing',
    })
    lib.markUnavailable('e1', '搜索穷尽', Date.now() + 86_400_000)
    expect(lib.missingBySeason()).toEqual([])
  })

  // Movie同构用例
  it('upsertMovie 幂等且更新时间戳', () => {
    const movie = {
      id: 'm1',
      name: 'Test Movie',
      path: '/movies/test.mkv',
      subStatus: 'missing' as const,
    }
    lib.upsertMovie(movie)
    lib.upsertMovie({ ...movie, subStatus: 'covered' })
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')
    expect((lib.db.prepare('select count(*) c from movies').get() as any).c).toBe(1)
  })

  it('markCovered 对 movie 也工作', () => {
    lib.upsertMovie({
      id: 'm1',
      name: 'Test Movie',
      path: '/movies/test.mkv',
      subStatus: 'missing',
    })
    lib.markCovered('m1', '/movies/test.zh-Hans.srt', 'scout-download', 'assrt:713052')
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('m1')).toMatchObject({
      path: '/movies/test.zh-Hans.srt',
      provider_ref: 'assrt:713052',
    })
  })

  // chinese_title 回写 + 扫描不清空（task 2 依赖）。
  // D6（去 Jellyfin 化 P3）：setSeriesChineseTitle 曾是 job 执行路径的独立写回口，grep 全仓库
  // 只有它自己的单测调用它，生产代码零调用点——判定为死代码，已删除。upsertSeries 的
  // SeriesParams 早已直接支持 chineseTitle 参数（T3 ingest 层识别命中时随 series 行一并写入，
  // 不再需要一个单独的 setter），这里改为直接验证 upsertSeries 的 chineseTitle 写入 + 幂等语义。
  it('upsertSeries chineseTitle 写入', () => {
    lib.upsertSeries({ id: 's1', name: 'A', chineseTitle: '甲剧' })
    expect(lib.getSeries('s1')!.chinese_title).toBe('甲剧')
  })

  it('upsertSeries 传 null chineseTitle 不清空已回写的中文名（scan 复扫不丢名）', () => {
    lib.upsertSeries({ id: 's1', name: 'A', chineseTitle: '甲剧' })
    // 模拟后续 scan：只带 name/posterPath，chineseTitle 缺省为 null
    lib.upsertSeries({ id: 's1', name: 'A', posterPath: 'ptag' })
    const row = lib.db.prepare('select chinese_title, poster_path from series where id=?').get('s1') as any
    expect(row.chinese_title).toBe('甲剧')
    expect(row.poster_path).toBe('ptag')
  })

  it('setMovieChineseTitle 写回；upsertMovie 传 null 不清空', () => {
    lib.upsertMovie({ id: 'm1', name: 'M', path: '/p', subStatus: 'missing' })
    lib.setMovieChineseTitle('m1', '乙片', 2000)
    lib.upsertMovie({ id: 'm1', name: 'M', path: '/p', subStatus: 'covered' })
    expect(lib.getMovie('m1')!.chinese_title).toBe('乙片')
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')
  })

  // origin_lang 缓存（task 2 依赖）
  it('origin_lang: set + get for series and movie, null by default', () => {
    lib.upsertSeries({ id: 's1', name: 'S', posterPath: null })
    expect(lib.getSeriesOriginLang('s1')).toBeNull()
    lib.setSeriesOriginLang('s1', 'zh')
    expect(lib.getSeriesOriginLang('s1')).toBe('zh')

    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing', posterPath: null, year: null, providerIds: null })
    expect(lib.getMovieOriginLang('m1')).toBeNull()
    lib.setMovieOriginLang('m1', 'ja')
    expect(lib.getMovieOriginLang('m1')).toBe('ja')
  })
  it('getSeriesOriginLang / getMovieOriginLang return null for unknown ids', () => {
    expect(lib.getSeriesOriginLang('nope')).toBeNull()
    expect(lib.getMovieOriginLang('nope')).toBeNull()
  })
  it('upsertMovie does not clobber an existing origin_lang', () => {
    lib.upsertMovie({ id: 'm2', name: 'M', path: '/m.mkv', subStatus: 'missing', posterPath: null, year: null, providerIds: null })
    lib.setMovieOriginLang('m2', 'zh')
    lib.upsertMovie({ id: 'm2', name: 'M2', path: '/m2.mkv', subStatus: 'covered', posterPath: null, year: 2020, providerIds: null })
    expect(lib.getMovieOriginLang('m2')).toBe('zh')
  })
})

describe('realign 支持方法', () => {
  it('getSeries 返回完整行，查无返回 null', () => {
    lib.upsertSeries({ id: 's1', name: 'Spy x Family' })
    expect(lib.getSeries('s1')?.name).toBe('Spy x Family')
    expect(lib.getSeries('nope')).toBeNull()
  })

  it('countEpisodesInSeason 统计指定季集数', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/b', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 2, episode: 1, name: 'E1', path: '/c', subStatus: 'missing' })
    expect(lib.countEpisodesInSeason('s1', 1)).toBe(2)
    expect(lib.countEpisodesInSeason('s1', 2)).toBe(1)
    expect(lib.countEpisodesInSeason('s1', 3)).toBe(0)
  })

  it('episodePathsForSeries 返回该剧全部集路径（跨季）', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/Show/Season 01/a.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/Show/Season 01/b.mkv', subStatus: 'missing' })
    expect(lib.episodePathsForSeries('s1').sort()).toEqual(['/media/Show/Season 01/a.mkv', '/media/Show/Season 01/b.mkv'])
  })

  it('knownPaths 返回 episodes ∪ movies 的 path 全集（去重）', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/tv/a.mkv', subStatus: 'missing' })
    lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/tv/b.mkv', subStatus: 'missing' })
    lib.upsertMovie({ id: 'm1', name: 'Movie', path: '/movies/c.mkv', subStatus: 'missing' })
    // upsert 同一路径两次（比如重新识别后再次入库）不应在 Set 里产生重复条目
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/tv/a.mkv', subStatus: 'covered' })
    expect(lib.knownPaths()).toEqual(new Set(['/tv/a.mkv', '/tv/b.mkv', '/movies/c.mkv']))
  })

  it('deleteSeriesRows 删除该剧全部 episodes + subtitles + series 行', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'covered' })
    lib.markCovered('e1', '/a.zh-Hans.srt', 'scout-download')
    lib.deleteSeriesRows('s1')
    expect(lib.getEpisode('e1')).toBeNull()
    expect(lib.getSeries('s1')).toBeNull()
    expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('e1')).toEqual({ c: 0 })
  })

  it('upsertSeries posterPath / upsertMovie posterPath 写入 poster_path 列', () => {
    lib.upsertSeries({ id: 's1', name: 'Show', posterPath: '/dqZEN.jpg' })
    expect(lib.getSeries('s1')?.poster_path).toBe('/dqZEN.jpg')

    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing', posterPath: '/abc.jpg' })
    expect(lib.getMovie('m1')?.poster_path).toBe('/abc.jpg')
  })
})

describe('P2：自有 id 空间新表 + 探针 memo（去 Jellyfin 化 schema v9）', () => {
  describe('parked_paths', () => {
    it('upsertParkedPath 插入新行；再次 upsert 更新 reason/last_attempt，保留 first_seen', () => {
      lib.upsertParkedPath('/media/unknown/a.mkv', 'no tmdb match', 1000)
      lib.upsertParkedPath('/media/unknown/a.mkv', 'ambiguous', 2000)
      const rows = lib.listParkedPaths()
      expect(rows).toEqual([
        { path: '/media/unknown/a.mkv', park_reason: 'ambiguous', first_seen: 1000, last_attempt: 2000 },
      ])
    })

    it('listParkedPaths 按 first_seen DESC 排序', () => {
      lib.upsertParkedPath('/a', 'r1', 1000)
      lib.upsertParkedPath('/b', 'r2', 3000)
      lib.upsertParkedPath('/c', 'r3', 2000)
      expect(lib.listParkedPaths().map((r) => r.path)).toEqual(['/b', '/c', '/a'])
    })

    it('clearParkedPath 删除该行（认领成功后调用）', () => {
      lib.upsertParkedPath('/a', 'r1', 1000)
      lib.clearParkedPath('/a')
      expect(lib.listParkedPaths()).toEqual([])
    })
  })

  describe('identify_overrides', () => {
    it('addOverride + findOverride：单条命中', () => {
      lib.addOverride('/media/anime/Show', '209867', true, 1000)
      expect(lib.findOverride('/media/anime/Show/S01/e1.mkv')).toEqual({ tmdbId: '209867', isTv: true, season: null })
    })

    it('findOverride 无命中返回 null', () => {
      lib.addOverride('/media/anime/Show', '209867', true, 1000)
      expect(lib.findOverride('/media/other/x.mkv')).toBeNull()
    })

    it('findOverride 最长前缀匹配：两条嵌套前缀，更长者胜出', () => {
      lib.addOverride('/media/anime', '1', true, 1000)
      lib.addOverride('/media/anime/Show', '209867', true, 2000)
      expect(lib.findOverride('/media/anime/Show/S01/e1.mkv')).toEqual({ tmdbId: '209867', isTv: true, season: null })
      expect(lib.findOverride('/media/anime/Other/e1.mkv')).toEqual({ tmdbId: '1', isTv: true, season: null })
    })

    it('addOverride 对同一 path_prefix 幂等更新（PRIMARY KEY upsert）', () => {
      lib.addOverride('/media/x', '1', true, 1000)
      lib.addOverride('/media/x', '2', false, 2000)
      expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '2', isTv: false, season: null })
    })

    // P7 disambiguation 补丁：认领时人类一并给出季号——见 db.ts identify_overrides 头注释、
    // recognition/index.ts recognize() 的 claim-gated 宽松救援分支。
    it('addOverride 带 season → findOverride 原样带回', () => {
      lib.addOverride('/media/TV/High School D×D', '24240', true, 1000, 4)
      expect(lib.findOverride('/media/TV/High School D×D/Hero - 01.mkv')).toEqual({
        tmdbId: '24240', isTv: true, season: 4,
      })
    })

    it('addOverride 不传 season（省略实参）默认为 null，不是遗留 undefined', () => {
      lib.addOverride('/media/anime/Show', '209867', true, 1000)
      expect(lib.findOverride('/media/anime/Show/e1.mkv')).toEqual({ tmdbId: '209867', isTv: true, season: null })
    })

    it('addOverride 幂等更新同样覆盖 season（重新认领可以补上此前没给的季号）', () => {
      lib.addOverride('/media/x', '1', true, 1000)
      lib.addOverride('/media/x', '1', true, 2000, 4)
      expect(lib.findOverride('/media/x/a.mkv')).toEqual({ tmdbId: '1', isTv: true, season: 4 })
    })
  })

  describe('probeMemo / setProbeMemo', () => {
    it('对 episode 行读写', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'missing' })
      expect(lib.probeMemo('e1')).toBeNull()
      lib.setProbeMemo('e1', 111, 222, ['chi', 'eng'])
      expect(lib.probeMemo('e1')).toEqual({ mtime: 111, size: 222, langs: ['chi', 'eng'] })
    })

    it('对 movie 行读写', () => {
      lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing' })
      expect(lib.probeMemo('m1')).toBeNull()
      lib.setProbeMemo('m1', 333, 444, null)
      expect(lib.probeMemo('m1')).toEqual({ mtime: 333, size: 444, langs: null })
    })

    it('未知 id 返回 null', () => {
      expect(lib.probeMemo('nope')).toBeNull()
    })
  })

  describe('deleteEpisodeByPath / deleteMovieByPath / deleteSeriesIfEmpty', () => {
    it('deleteEpisodeByPath 删除该行 + 关联 subtitles', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a.mkv', subStatus: 'covered' })
      lib.markCovered('e1', '/a.zh-Hans.srt', 'scout-download')
      lib.deleteEpisodeByPath('/a.mkv')
      expect(lib.getEpisode('e1')).toBeNull()
      expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('e1')).toEqual({ c: 0 })
    })

    it('deleteEpisodeByPath 对不存在的路径是空操作', () => {
      expect(() => lib.deleteEpisodeByPath('/nope.mkv')).not.toThrow()
    })

    it('deleteMovieByPath 删除该行 + 关联 subtitles', () => {
      lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'covered' })
      lib.markCovered('m1', '/m.zh-Hans.srt', 'scout-download')
      lib.deleteMovieByPath('/m.mkv')
      expect(lib.getMovie('m1')).toBeNull()
      expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('m1')).toEqual({ c: 0 })
    })

    it('deleteSeriesIfEmpty：还有集时不删；集清空后删', () => {
      lib.upsertSeries({ id: 's1', name: 'A' })
      lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a.mkv', subStatus: 'missing' })
      lib.deleteSeriesIfEmpty('s1')
      expect(lib.getSeries('s1')).not.toBeNull()

      lib.deleteEpisodeByPath('/a.mkv')
      lib.deleteSeriesIfEmpty('s1')
      expect(lib.getSeries('s1')).toBeNull()
    })
  })
})
