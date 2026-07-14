import { describe, it, expect } from 'vitest'
import { asSchema } from 'ai'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { PlayerServer } from '../adapters/players/types.js'
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

describe('dispatch_find_subtitle_task identity validation', () => {
  it('rejects a null season paired with a non-null seriesId (collides with dispatch_realign_task\'s worker_task identity for the same series)', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', season: null, movieId: null, reason: 'bad identity',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(String((result.error as Error).message)).toMatch(/collides with dispatch_realign_task/)
    }
  })

  it('rejects seriesId+season set together with a movieId', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', season: 1, movieId: 'm1', reason: 'bad identity',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an all-null identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: null, season: null, movieId: null, reason: 'nothing to dispatch',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a well-formed series+season identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', season: 1, movieId: null, reason: 'missing season 1',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a well-formed movie-only identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: null, season: null, movieId: 'm1', reason: 'missing movie',
    })
    expect(result.success).toBe(true)
  })

  // Root cause under test (v3 live matrix, 2026-07-13): the real model naturally OMITS the other
  // kind's field entirely rather than sending it as an explicit JSON null — a plain `.nullable()`
  // rejects the omitted key (only `.nullish()`/`.optional()` accept `undefined`), so these
  // tool-calls were rejected before execute() ever ran and zero worker_task rows landed. See
  // orchestratorAgent.test.ts for the end-to-end regression that reproduces the live symptom.
  it('accepts movieId OMITTED entirely for a series+season dispatch (real model natural shape) — normalizes to movieId:null', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', season: 1, reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: 'norm', season: 1, movieId: null, reason: 'x' } })
  })

  it('accepts seriesId/season OMITTED entirely for a movie-only dispatch (real model natural shape) — normalizes to seriesId:null, season:null', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      movieId: 'mov', reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: null, season: null, movieId: 'mov', reason: 'x' } })
  })

  it('coerces a string-encoded season ("1") to the integer 1', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', season: '1', movieId: null, reason: 'x',
    })
    expect(result).toEqual({ success: true, value: { seriesId: 'norm', season: 1, movieId: null, reason: 'x' } })
  })

  it('still rejects a genuinely-malformed identity (both seriesId+season AND movieId set) even after tolerant normalization', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => {} }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', season: 1, movieId: 'mov', reason: 'x',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(String((result.error as Error).message)).toMatch(/collides with dispatch_realign_task/)
    }
  })
})

describe('makeCheckSeriesLayoutTool', () => {
  // Root cause under test: the orchestrator model has NO source for a series' tmdbId
  // (list_missing_coverage rows are {seriesId, season, missing} only) — the tool must resolve
  // tmdbId itself via a live jf.getItem lookup (the house convention confirmed in
  // makeDiagnoseSeason, src/v2/executor.ts:539-546), NOT take it as a model-supplied input.
  it('resolves tmdbId internally via jf.getItem and reports exceedsSeasonTable:true when the mirror overshoots the TMDB season table', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason'> = {
      countEpisodesInSeason: (seriesId, season) => {
        expect(seriesId).toBe('s1')
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
    const jf: Pick<PlayerServer, 'getItem'> = {
      getItem: async (itemId) => {
        expect(itemId).toBe('s1')
        return { ProviderIds: { Tmdb: '1429' } } as any
      },
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb, jf)

    const result = await checkSeriesLayout.execute!({ seriesId: 's1', season: 2 }, fakeOpts)

    expect(result).toEqual({ mirrorEpisodeCount: 30, tmdbEpisodeCount: 12, exceedsSeasonTable: true })
  })

  it('gracefully reports exceedsSeasonTable:false (never throws) when jf.getItem has no resolvable Tmdb provider id', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason'> = { countEpisodesInSeason: () => 30 }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async () => { throw new Error('must never be called — no tmdbId to look up') },
    }
    const jf: Pick<PlayerServer, 'getItem'> = { getItem: async () => null as any }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb, jf)

    const result = await checkSeriesLayout.execute!({ seriesId: 's1', season: 2 }, fakeOpts)

    expect(result).toEqual({ mirrorEpisodeCount: 30, tmdbEpisodeCount: null, exceedsSeasonTable: false })
  })

  it('no tmdbId param in the input schema (model cannot fabricate one) — seriesId/season alone validate', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason'> = { countEpisodesInSeason: () => 0 }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = { getSeasonTable: async () => null }
    const jf: Pick<PlayerServer, 'getItem'> = { getItem: async () => null as any }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb, jf)

    const result = await validate(checkSeriesLayout.inputSchema, { seriesId: 's1', season: 2 })
    expect(result).toEqual({ success: true, value: { seriesId: 's1', season: 2 } })
  })
})
