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

  // chinese_title 回写 + 扫描不清空（task 2 依赖）
  it('setSeriesChineseTitle 写回并记 checked_at，幂等', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.setSeriesChineseTitle('s1', '甲剧', 1000)
    const row = lib.db.prepare('select chinese_title, chinese_title_checked_at from series where id=?').get('s1') as any
    expect(row.chinese_title).toBe('甲剧')
    expect(row.chinese_title_checked_at).toBe(1000)
  })

  it('upsertSeries 传 null chineseTitle 不清空已回写的中文名（scan 复扫不丢名）', () => {
    lib.upsertSeries({ id: 's1', name: 'A' })
    lib.setSeriesChineseTitle('s1', '甲剧', 1000)
    // 模拟后续 scan：只带 name/posterTag，chineseTitle 缺省为 null
    lib.upsertSeries({ id: 's1', name: 'A', posterTag: 'ptag' })
    const row = lib.db.prepare('select chinese_title, poster_tag from series where id=?').get('s1') as any
    expect(row.chinese_title).toBe('甲剧')
    expect(row.poster_tag).toBe('ptag')
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
    lib.upsertSeries({ id: 's1', name: 'S', posterTag: null })
    expect(lib.getSeriesOriginLang('s1')).toBeNull()
    lib.setSeriesOriginLang('s1', 'zh')
    expect(lib.getSeriesOriginLang('s1')).toBe('zh')

    lib.upsertMovie({ id: 'm1', name: 'M', path: '/m.mkv', subStatus: 'missing', posterTag: null, year: null, providerIds: null })
    expect(lib.getMovieOriginLang('m1')).toBeNull()
    lib.setMovieOriginLang('m1', 'ja')
    expect(lib.getMovieOriginLang('m1')).toBe('ja')
  })
  it('getSeriesOriginLang / getMovieOriginLang return null for unknown ids', () => {
    expect(lib.getSeriesOriginLang('nope')).toBeNull()
    expect(lib.getMovieOriginLang('nope')).toBeNull()
  })
  it('upsertMovie does not clobber an existing origin_lang', () => {
    lib.upsertMovie({ id: 'm2', name: 'M', path: '/m.mkv', subStatus: 'missing', posterTag: null, year: null, providerIds: null })
    lib.setMovieOriginLang('m2', 'zh')
    lib.upsertMovie({ id: 'm2', name: 'M2', path: '/m2.mkv', subStatus: 'covered', posterTag: null, year: 2020, providerIds: null })
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

  it('deleteSeriesRows 删除该剧全部 episodes + subtitles + series 行', () => {
    lib.upsertSeries({ id: 's1', name: 'Show' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/a', subStatus: 'covered' })
    lib.markCovered('e1', '/a.zh-Hans.srt', 'scout-download')
    lib.deleteSeriesRows('s1')
    expect(lib.getEpisode('e1')).toBeNull()
    expect(lib.getSeries('s1')).toBeNull()
    expect(lib.db.prepare('SELECT COUNT(*) as c FROM subtitles WHERE item_id=?').get('e1')).toEqual({ c: 0 })
  })
})
