import { describe, it, expect } from 'vitest'
import { asSchema } from 'ai'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import {
  makeListMissingCoverageTool, makeDispatchFindSubtitleTaskTool, makeCheckSeriesLayoutTool,
  type DispatchCounter, type MissingCoveragePage,
} from './orchestratorAgent.tools.js'

const fakeOpts = { toolCallId: 't1', messages: [] } as any

/** Tools' inputSchema is typed as the union FlexibleSchema (Zod | custom Schema | ...), which
 *  doesn't expose Zod's own .safeParse at the type level even though these tools are always
 *  built from plain Zod schemas at runtime — asSchema(...).validate() is the SDK's own
 *  schema-agnostic way to run that same validation (used internally by the tool-calling loop
 *  itself before execute() is ever invoked). */
async function validate(schema: unknown, value: unknown) {
  return asSchema(schema as any).validate!(value)
}

describe('makeListMissingCoverageTool', () => {
  it('paginates: first page returns `limit` rows + hasMore:true + correct total, second page returns the rest', async () => {
    // Seed 3 missing seasons — more than a limit of 2 — so a single unpaginated call would have
    // dumped the whole set inline (the finding this guards against).
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies'> = {
      missingBySeason: () => [
        { series_id: 's1', season: 1, missing: 2 },
        { series_id: 's2', season: 1, missing: 1 },
        { series_id: 's3', season: 1, missing: 5 },
      ],
      missingMovies: () => [],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)

    const page1 = await listMissingCoverage.execute!({ offset: 0, limit: 2 }, fakeOpts) as MissingCoveragePage
    expect(page1.rows).toHaveLength(2)
    expect(page1.rows).toEqual([
      { kind: 'season', seriesId: 's1', season: 1, missing: 2 },
      { kind: 'season', seriesId: 's2', season: 1, missing: 1 },
    ])
    expect(page1.total).toBe(3)
    expect(page1.offset).toBe(0)
    expect(page1.hasMore).toBe(true)

    const page2 = await listMissingCoverage.execute!({ offset: 2, limit: 2 }, fakeOpts) as MissingCoveragePage
    expect(page2.rows).toEqual([{ kind: 'season', seriesId: 's3', season: 1, missing: 5 }])
    expect(page2.total).toBe(3)
    expect(page2.offset).toBe(2)
    expect(page2.hasMore).toBe(false)
  })

  it('combines missing seasons and missing movies into one offset-addressable list', async () => {
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies'> = {
      missingBySeason: () => [{ series_id: 's1', season: 1, missing: 2 }],
      missingMovies: () => [{ id: 'm1', name: 'Movie One' } as any],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)
    const page = await listMissingCoverage.execute!({ offset: 0, limit: 50 }, fakeOpts) as MissingCoveragePage
    expect(page.total).toBe(2)
    expect(page.rows).toEqual([
      { kind: 'season', seriesId: 's1', season: 1, missing: 2 },
      { kind: 'movie', movieId: 'm1', name: 'Movie One' },
    ])
    expect(page.hasMore).toBe(false)
  })

  it('defaults offset to 0 and limit to 50 when called with no arguments', async () => {
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies'> = {
      missingBySeason: () => [{ series_id: 's1', season: 1, missing: 2 }],
      missingMovies: () => [],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)
    const result = await validate(listMissingCoverage.inputSchema, {})
    expect(result).toEqual({ success: true, value: { offset: 0, limit: 50 } })
  })
})

// R-11（用户裁决 2026-07-16，原文锚点：「到底按季还是按剧，是根据具体情况具体分析的」）：派活
// 范围不再是系统常量（原先靠强制 season 非空来避免与 dispatch_realign_task 撞身份），而是主代理
// 按刮削出的磁盘事实自行裁量——seasons 数组下发范围事实，season 单值字段已删除。schema v11 起
// taskType 进了 jobs_identity 元组（db.ts / jobsRepo.ts），find_subtitle 与 realign 对同一
// series 不再共享身份行，原先"拒绝 null season"的唯一理由随之消失。
describe('dispatch_find_subtitle_task identity + scope validation (R-11)', () => {
  it('rejects seriesId+movieId set together', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', movieId: 'm1', reason: 'bad identity',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an all-null identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: null, movieId: null, reason: 'nothing to dispatch',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a well-formed series identity with a seasons array (e.g. seasons:[1,2,3] to sweep a whole series in one worker)', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', seasons: [1, 2, 3], movieId: null, reason: 'missing s1-3',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a well-formed movie-only identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: null, seasons: null, movieId: 'm1', reason: 'missing movie',
    })
    expect(result.success).toBe(true)
  })

  // Root cause under test (v3 live matrix, 2026-07-13): the real model naturally OMITS fields
  // entirely rather than sending them as explicit JSON null — a plain `.nullable()` rejects the
  // omitted key (only `.nullish()`/`.optional()` accept `undefined`), so these tool-calls were
  // rejected before execute() ever ran and zero worker_task rows landed.
  it('accepts movieId/seasons OMITTED entirely for a series dispatch (real model natural shape) — normalizes to movieId:null, seasons:null', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: 'norm', seasons: null, movieId: null, reason: 'x' } })
  })

  it('accepts seriesId/seasons OMITTED entirely for a movie-only dispatch (real model natural shape) — normalizes to seriesId:null, seasons:null', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      movieId: 'mov', reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: null, seasons: null, movieId: 'mov', reason: 'x' } })
  })

  it('coerces string-encoded season numbers inside the seasons array (["1","2"]) to integers', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', seasons: ['1', '2'], movieId: null, reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: 'norm', seasons: [1, 2], movieId: null, reason: 'x' } })
  })

  it('"None" string sentinel for seasons collapses to null (full-series scope, not an empty array)', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', seasons: 'None', movieId: null, reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: 'norm', seasons: null, movieId: null, reason: 'x' } })
  })

  it('still rejects a genuinely-malformed identity (seriesId AND movieId both set) even with seasons present', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', seasons: [1], movieId: 'mov', reason: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('dispatch: seriesId+seasons=[1,2,3] → 一行 worker_task，payload.seasons=[1,2,3]，season 列 NULL', async () => {
    const counter: DispatchCounter = { count: 0 }
    const calls: unknown[][] = []
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args) } }, now: () => 1000, parentJobId: null }, counter,
    )
    await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1, 2, 3], movieId: null, reason: 'sweep whole series' }, fakeOpts)
    expect(calls).toHaveLength(1)
    const [ident, payload] = calls[0]
    expect(ident).toEqual({ seriesId: 's1', season: null, movieId: null })
    expect(payload).toEqual({ taskType: 'find_subtitle', seasons: [1, 2, 3], reason: 'sweep whole series' })
  })

  it('dispatch: seasons 省略/None → payload.seasons=null（全部有缺口的季）', async () => {
    const counter: DispatchCounter = { count: 0 }
    const calls: unknown[][] = []
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args) } }, now: () => 1000, parentJobId: null }, counter,
    )
    await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: null, movieId: null, reason: 'whole series, all gaps' }, fakeOpts)
    expect(calls).toHaveLength(1)
    const [ident, payload] = calls[0]
    expect(ident).toEqual({ seriesId: 's1', season: null, movieId: null })
    expect(payload).toEqual({ taskType: 'find_subtitle', seasons: null, reason: 'whole series, all gaps' })
  })

  it('dispatch_find_subtitle_task: seriesId 与 movieId 互斥仍然强制', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => { throw new Error('must never be called') } }, now: () => 1000, parentJobId: null }, counter,
    )
    const both = await validate(dispatchFindSubtitle.inputSchema, { seriesId: 's1', movieId: 'm1', reason: 'x' })
    expect(both.success).toBe(false)
    const neither = await validate(dispatchFindSubtitle.inputSchema, { seriesId: null, movieId: null, reason: 'x' })
    expect(neither.success).toBe(false)
  })
})

describe('makeCheckSeriesLayoutTool', () => {
  // Root cause under test: the orchestrator model has NO source for a series' tmdbId
  // (list_missing_coverage rows are {seriesId, season, missing} only) — the tool must resolve
  // tmdbId itself, NOT take it as a model-supplied input. 去 Jellyfin 化 P4: this resolution is now
  // a pure, zero-I/O string parse (tmdbIdFromOwnId, src/v2/ownIds.ts) off the seriesId itself
  // (own-id space: series.id = 'tmdb:<TMDB id>') — no more live jf.getItem lookup.
  it('resolves tmdbId internally from seriesId itself and reports exceedsSeasonTable:true when the mirror overshoots the TMDB season table', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason'> = {
      countEpisodesInSeason: (seriesId, season) => {
        expect(seriesId).toBe('tmdb:1429')
        expect(season).toBe(2)
        return 30
      },
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async (tmdbId) => {
        expect(tmdbId).toBe('1429')
        return [{ seasonNumber: 2, episodeCount: 12, airDate: null }] as any
      },
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'tmdb:1429', season: 2 }, fakeOpts)

    expect(result).toEqual({ mirrorEpisodeCount: 30, tmdbEpisodeCount: 12, exceedsSeasonTable: true })
  })

  it('gracefully reports exceedsSeasonTable:false (never throws) when seriesId does not conform to the tmdb:<id> own-id shape', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason'> = { countEpisodesInSeason: () => 30 }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async () => { throw new Error('must never be called — no tmdbId to look up') },
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'not-a-tmdb-id', season: 2 }, fakeOpts)

    expect(result).toEqual({ mirrorEpisodeCount: 30, tmdbEpisodeCount: null, exceedsSeasonTable: false })
  })

  it('no tmdbId param in the input schema (model cannot fabricate one) — seriesId/season alone validate', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason'> = { countEpisodesInSeason: () => 0 }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = { getSeasonTable: async () => null }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await validate(checkSeriesLayout.inputSchema, { seriesId: 's1', season: 2 })
    expect(result).toEqual({ success: true, value: { seriesId: 's1', season: 2 } })
  })
})
