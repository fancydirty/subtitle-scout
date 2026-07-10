import { describe, it, expect } from 'vitest'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs } from './fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'

const cand = (provider: 'assrt' | 'opensubtitles', id: string): SubtitleCandidate =>
  ({ provider, providerId: id, videoName: null, nativeName: null, language: null,
     subtype: null, releaseSite: null, uploadDate: null, fileList: [] })

function adapter(name: string, opts: Partial<FetchAdapter> = {}): FetchAdapter {
  return {
    name,
    enabled: () => true,
    search: async () => [cand('assrt', `${name}-1`)],
    resolve: async () => ({ url: `https://dl/${name}` }),
    ...opts,
  }
}

describe('runSearch', () => {
  const args: FetchArgs = { queries: ['q1'], deep: false }
  it('merges results from all enabled adapters', async () => {
    const r = await runSearch(args, [adapter('a'), adapter('b')], () => {})
    expect(r.map(c => c.providerId).sort()).toEqual(['a-1', 'b-1'])
  })
  it('skips disabled adapters', async () => {
    const r = await runSearch(args, [adapter('a'), adapter('b', { enabled: () => false })], () => {})
    expect(r.map(c => c.providerId)).toEqual(['a-1'])
  })
  it('fail-soft: one adapter throwing does not kill the run, emits provider_error', async () => {
    const events: unknown[] = []
    const r = await runSearch(args, [
      adapter('boom', { search: async () => { throw new Error('cf block') } }),
      adapter('ok'),
    ], e => events.push(e))
    expect(r.map(c => c.providerId)).toEqual(['ok-1'])
    expect(events).toContainEqual(expect.objectContaining({ event: 'provider_error', provider: 'boom' }))
  })
  it('dedupes identical provider:providerId across adapters', async () => {
    const dup = cand('assrt', 'same')
    const r = await runSearch(args, [
      adapter('a', { search: async () => [dup] }),
      adapter('b', { search: async () => [dup] }),
    ], () => {})
    expect(r.length).toBe(1)
  })
  it('ALL enabled adapters failing → rejects (transient outage must not read as "no subtitles")', async () => {
    await expect(runSearch(args, [
      adapter('a', { search: async () => { throw new Error('429 rate limited') } }),
      adapter('b', { search: async () => { throw new Error('socket timeout') } }),
    ], () => {})).rejects.toThrow(/all providers failed.*429 rate limited.*socket timeout/s)
  })
  it('one dead one alive → fail-soft, returns the survivor results', async () => {
    const r = await runSearch(args, [
      adapter('dead', { search: async () => { throw new Error('503') } }),
      adapter('alive'),
    ], () => {})
    expect(r.map(c => c.providerId)).toEqual(['alive-1'])
  })
  it('zero adapters configured → fail-fast, never an "honest empty" result', async () => {
    // 没配任何 provider key 时若输出 [] exit 0，pipeline 会写负缓存——整库静默毒化
    await expect(runSearch(args, [], () => {})).rejects.toThrow(/no providers configured/)
  })
})

describe('runResolve', () => {
  it('dispatches to the adapter owning the provider', async () => {
    const r = await runResolve({ provider: 'assrt', providerId: '1', fileIndex: 0 },
      [adapter('assrt'), adapter('opensubtitles')])
    expect(r.url).toBe('https://dl/assrt')
  })
  it('throws when no adapter owns the provider', async () => {
    await expect(runResolve({ provider: 'opensubtitles', providerId: '1', fileIndex: null }, [adapter('assrt')]))
      .rejects.toThrow(/no adapter/)
  })
  it('zero adapters configured → fail-fast with configuration error', async () => {
    await expect(runResolve({ provider: 'assrt', providerId: '1', fileIndex: null }, []))
      .rejects.toThrow(/no providers configured/)
  })
})
