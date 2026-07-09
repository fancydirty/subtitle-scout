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
})
