import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from './db.js'
import type { TmdbClient, SeasonTableEntry } from '../adapters/providers/tmdb.js'
import { CATALOG_TTL_MS, refreshSeriesCatalog, canonicalEpisodes } from './tmdbCatalog.js'

type FakeTmdb = Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes'>

let db: ScoutDb
beforeEach(() => { db = openDb(':memory:') })

const SERIES_ID = 'tmdb:120089'

describe('refreshSeriesCatalog', () => {
  it('拉季表+集标题写 tmdb_seasons，7 天内不重拉', async () => {
    let seasonTableCalls = 0
    const fake: FakeTmdb = {
      getSeasonTable: async () => {
        seasonTableCalls++
        return [{ seasonNumber: 1, episodeCount: 2, airDate: '2022-01-01' }] as SeasonTableEntry[]
      },
      getSeasonEpisodes: async (_tvId, season) =>
        season === 1 ? [{ episode: 1, title: 'Ep1' }, { episode: 2, title: 'Ep2' }] : null,
    }

    const t0 = 1_000_000
    await refreshSeriesCatalog(db, fake, SERIES_ID, t0)
    expect(seasonTableCalls).toBe(1)
    expect(canonicalEpisodes(db, SERIES_ID, 1)).toEqual([
      { episode: 1, title: 'Ep1' },
      { episode: 2, title: 'Ep2' },
    ])

    // 7 天内二次调用：TTL 门直接短路，fake 计数不增。
    await refreshSeriesCatalog(db, fake, SERIES_ID, t0 + CATALOG_TTL_MS - 1)
    expect(seasonTableCalls).toBe(1)
  })

  it('TMDB 失败 → 保留旧缓存不清空（gain-path 降级）', async () => {
    const good: FakeTmdb = {
      getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 1, airDate: null }] as SeasonTableEntry[],
      getSeasonEpisodes: async () => [{ episode: 1, title: 'Ep1' }],
    }
    const t0 = 1_000_000
    await refreshSeriesCatalog(db, good, SERIES_ID, t0)
    expect(canonicalEpisodes(db, SERIES_ID, 1)).toEqual([{ episode: 1, title: 'Ep1' }])

    // 过 TTL 后用返回 null 的 fake 再刷——请求本身"查无数据"或抛错都不该清空旧缓存。
    const failing: FakeTmdb = {
      getSeasonTable: async () => null,
      getSeasonEpisodes: async () => null,
    }
    await refreshSeriesCatalog(db, failing, SERIES_ID, t0 + CATALOG_TTL_MS + 1)
    expect(canonicalEpisodes(db, SERIES_ID, 1)).toEqual([{ episode: 1, title: 'Ep1' }])
  })

  it('TMDB 抛错 → 保留旧缓存不清空（gain-path 降级，同上但走异常路径）', async () => {
    const good: FakeTmdb = {
      getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 1, airDate: null }] as SeasonTableEntry[],
      getSeasonEpisodes: async () => [{ episode: 1, title: 'Ep1' }],
    }
    const t0 = 1_000_000
    await refreshSeriesCatalog(db, good, SERIES_ID, t0)

    const throwing: FakeTmdb = {
      getSeasonTable: async () => { throw new Error('TMDB 抖动') },
      getSeasonEpisodes: async () => [{ episode: 1, title: 'Ep1' }],
    }
    await refreshSeriesCatalog(db, throwing, SERIES_ID, t0 + CATALOG_TTL_MS + 1)
    expect(canonicalEpisodes(db, SERIES_ID, 1)).toEqual([{ episode: 1, title: 'Ep1' }])
  })

  it('canonicalEpisodes(seriesId, season) 返回缓存行，按 episode 升序', async () => {
    const fake: FakeTmdb = {
      getSeasonTable: async () => [{ seasonNumber: 1, episodeCount: 3, airDate: null }] as SeasonTableEntry[],
      getSeasonEpisodes: async () => [
        { episode: 3, title: 'Ep3' },
        { episode: 1, title: 'Ep1' },
        { episode: 2, title: null },
      ],
    }
    await refreshSeriesCatalog(db, fake, SERIES_ID, 1_000_000)
    expect(canonicalEpisodes(db, SERIES_ID, 1)).toEqual([
      { episode: 1, title: 'Ep1' },
      { episode: 2, title: null },
      { episode: 3, title: 'Ep3' },
    ])
    // 无缓存的季 → 空数组，不抛错。
    expect(canonicalEpisodes(db, SERIES_ID, 2)).toEqual([])
  })
})
