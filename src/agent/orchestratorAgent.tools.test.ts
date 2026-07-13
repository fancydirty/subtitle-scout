import { describe, it, expect } from 'vitest'
import { asSchema } from 'ai'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import { makeListMissingCoverageTool, type MissingCoveragePage } from './orchestratorAgent.tools.js'

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
