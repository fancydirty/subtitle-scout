// src/dashboard/router.test.ts
import { describe, it, expect } from 'vitest'
import { handleApiRoute, type RouterDeps } from './router.js'
import type { LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO } from './apiV2.js'

const libItem: LibraryItemDTO = {
  id: 's1', kind: 'series', name: 'A', chineseTitle: null, year: null, posterPath: null, section: '剧集',
  coverage: { covered: 0, missing: 1, embedded: 0, unavailable: 0 }, job: null,
}
const seriesDetail: SeriesDetailDTO = {
  id: 's1', name: 'A', chineseTitle: null, year: null, posterPath: null, seasons: [], runs: [],
}
const run: RunHistoryDTO = {
  id: 1, jobId: 1, startedAt: 1, finishedAt: 2, decision: 'download', detail: 'ok', journalPath: null,
}

let lastRunsArgs: { offset: number; limit: number } | null = null
const deps: RouterDeps = {
  library: () => [libItem],
  series: (id) => (id === 's1' ? seriesDetail : null),
  runs: (offset, limit) => { lastRunsArgs = { offset, limit }; return [run] },
}

const call = (pathname: string, opts: { query?: Record<string, string>; token?: string; configuredToken?: string } = {}) =>
  handleApiRoute({ pathname, query: opts.query ?? {}, token: opts.token }, deps, opts.configuredToken)

describe('handleApiRoute (v2)', () => {
  it('routes /api/v2/library', () => {
    const r = call('/api/v2/library')
    expect(r.status).toBe(200)
    expect(r.json).toEqual([libItem])
  })
  it('routes /api/v2/series/:id and 404s unknown', () => {
    expect(call('/api/v2/series/s1').status).toBe(200)
    expect(call('/api/v2/series/nope').status).toBe(404)
  })
  it('rejects illegal series id with 400', () => {
    expect(call('/api/v2/series/a..b').status).toBe(400)
    expect(call('/api/v2/series/a%2fb').status).toBe(400) // '%' 不在允许字符集
  })
  it('routes /api/v2/runs with offset/limit defaults', () => {
    expect(call('/api/v2/runs').status).toBe(200)
    expect(lastRunsArgs).toEqual({ offset: 0, limit: 50 })
    call('/api/v2/runs', { query: { offset: '10', limit: '5' } })
    expect(lastRunsArgs).toEqual({ offset: 10, limit: 5 })
  })
  it('retires v1 endpoints with 410', () => {
    expect(call('/api/summary').status).toBe(410)
    expect(call('/api/queue').status).toBe(410)
    expect(call('/api/runs').status).toBe(410)
    expect(call('/api/runs/i-1000').status).toBe(410)
  })
  it('enforces token when configured', () => {
    expect(call('/api/v2/library', { configuredToken: 's3cret' }).status).toBe(401)
    expect(call('/api/v2/library', { configuredToken: 's3cret', token: 'wrong' }).status).toBe(401)
    expect(call('/api/v2/library', { configuredToken: 's3cret', token: 's3cret' }).status).toBe(200)
  })
  it('returns 404 for non-api paths (static handled elsewhere)', () => {
    expect(call('/index.html').status).toBe(404)
  })
})
