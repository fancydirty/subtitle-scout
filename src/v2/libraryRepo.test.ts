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
    lib.markCovered('e1', '/p/1.zh-Hans.srt', 'scout-download', 713051)
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/p/1.zh-Hans.srt',
      assrt_sub_id: 713051,
    })
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
    lib.markCovered('m1', '/movies/test.zh-Hans.srt', 'scout-download', 713052)
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('m1')).toMatchObject({
      path: '/movies/test.zh-Hans.srt',
      assrt_sub_id: 713052,
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
})
