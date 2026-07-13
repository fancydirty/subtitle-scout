import { describe, it, expect } from 'vitest'
import { asSchema } from 'ai'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import {
  makeListMissingCoverageTool, makeDispatchFindSubtitleTaskTool, type DispatchCounter,
  type MissingCoveragePage,
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
})
