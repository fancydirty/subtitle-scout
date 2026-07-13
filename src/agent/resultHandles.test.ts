import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFileResultSetStore } from './resultHandles.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import { makeSearchSourceTool, makeListCandidatesTool, makeGetCandidateTool, summarizeCandidate, type CandidateSummary } from './resultHandles.js'
import type { FetchAdapter } from '../cli/fetchLib.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scout-resultsets-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('makeFileResultSetStore', () => {
  it('creates a result set and returns its count', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }, { a: 3 }])
    expect(store.count(id)).toBe(3)
  })

  it('lists a page with offset/limit', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }])
    expect(store.list(id, 1, 2)).toEqual([{ a: 2 }, { a: 3 }])
  })

  it('gets a single item by index, or null when out of range', () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([{ a: 1 }, { a: 2 }])
    expect(store.get(id, 1)).toEqual({ a: 2 })
    expect(store.get(id, 5)).toBeNull()
  })

  it('throws a clear error for an unknown result set id', () => {
    const store = makeFileResultSetStore(dir)
    expect(() => store.count('does-not-exist')).toThrow(/unknown result set/)
  })

  it('two result sets in the same store are independent', () => {
    const store = makeFileResultSetStore(dir)
    const id1 = store.create([{ a: 1 }])
    const id2 = store.create([{ a: 2 }, { a: 3 }])
    expect(store.count(id1)).toBe(1)
    expect(store.count(id2)).toBe(2)
  })
})

function fakeCandidate(providerId: string, videoName: string): SubtitleCandidate {
  return {
    provider: 'assrt', providerId, videoName, nativeName: null, language: 'zh-CN',
    subtype: null, releaseSite: null, uploadDate: null,
    fileList: [{ index: 0, name: `${videoName}.srt` }],
  }
}

function fakeAdapter(results: SubtitleCandidate[]): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async () => results,
    resolve: async () => { throw new Error('not used in this test') },
  }
}

describe('search_source / list_candidates / get_candidate tools', () => {
  it('search_source writes full results to the store and returns a handle + top-N preview', async () => {
    const store = makeFileResultSetStore(dir)
    const results = [fakeCandidate('1', 'Show.S01E01'), fakeCandidate('2', 'Show.S01E02'), fakeCandidate('3', 'Show.S01E03')]
    const searchSource = makeSearchSourceTool({ adapters: [fakeAdapter(results)], store, topN: 2 })
    const out = await searchSource.execute!({ queries: ['Show S01E01'], languages: ['zh-Hans'] }, { toolCallId: 't1', messages: [] } as any) as { result_set_id: string; count: number; top: CandidateSummary[] }
    expect(out.count).toBe(3)
    expect(out.top).toHaveLength(2)
    expect(out.top[0]).toEqual(summarizeCandidate(results[0]))
    expect(store.count(out.result_set_id)).toBe(3)
  })

  it('list_candidates pages through a result set by handle', async () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([fakeCandidate('1', 'A'), fakeCandidate('2', 'B'), fakeCandidate('3', 'C')])
    const listCandidates = makeListCandidatesTool(store)
    const out = await listCandidates.execute!({ result_set_id: id, offset: 1, limit: 1 }, { toolCallId: 't1', messages: [] } as any) as { items: CandidateSummary[] }
    expect(out.items).toEqual([summarizeCandidate(fakeCandidate('2', 'B'))])
  })

  it('get_candidate returns a concise summary by default, full object when detail=detailed', async () => {
    const store = makeFileResultSetStore(dir)
    const candidate = fakeCandidate('1', 'A')
    const id = store.create([candidate])
    const getCandidate = makeGetCandidateTool(store)
    const concise = await getCandidate.execute!({ result_set_id: id, index: 0, detail: 'concise' }, { toolCallId: 't1', messages: [] } as any)
    expect(concise).toEqual(summarizeCandidate(candidate))
    const detailed = await getCandidate.execute!({ result_set_id: id, index: 0, detail: 'detailed' }, { toolCallId: 't1', messages: [] } as any)
    expect(detailed).toEqual(candidate)
  })

  it('get_candidate reports an error for an out-of-range index', async () => {
    const store = makeFileResultSetStore(dir)
    const id = store.create([fakeCandidate('1', 'A')])
    const getCandidate = makeGetCandidateTool(store)
    const out = await getCandidate.execute!({ result_set_id: id, index: 9, detail: 'concise' }, { toolCallId: 't1', messages: [] } as any)
    expect(out).toEqual({ error: `no candidate at index 9 in result set ${id}` })
  })
})
