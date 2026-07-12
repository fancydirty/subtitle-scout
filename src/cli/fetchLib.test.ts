import { describe, it, expect } from 'vitest'
import { runSearch, runResolve, providerErrorFields, providerNoticeFields, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
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

describe('FetchEvent api_call droppedEntries (MINOR-1: declared on the api_call variant so it can reach cli/index.ts\'s journal.apiCall, per-entry fail-soft observability)', () => {
  const args: FetchArgs = { queries: ['q1'], deep: false }
  it('an api_call event carrying droppedEntries type-checks and round-trips through runSearch\'s emit unchanged', async () => {
    const events: FetchEvent[] = []
    const withDrop = adapter('assrt', {
      search: async (_args, emit) => {
        emit?.({ event: 'api_call', provider: 'assrt', endpoint: 'sub/similar', status: 0, durationMs: 5, droppedEntries: 3 })
        return [cand('assrt', 'x1')]
      },
    })
    const r = await runSearch(args, [withDrop], e => events.push(e))
    expect(r.map(c => c.providerId)).toEqual(['x1'])
    expect(events).toContainEqual(expect.objectContaining({ event: 'api_call', endpoint: 'sub/similar', droppedEntries: 3 }))
  })
  it('an api_call event with no drops leaves droppedEntries undefined (optional field, not forced)', async () => {
    const events: FetchEvent[] = []
    const clean = adapter('assrt', {
      search: async (_args, emit) => {
        emit?.({ event: 'api_call', provider: 'assrt', endpoint: 'sub/search', status: 0, durationMs: 5 })
        return [cand('assrt', 'x1')]
      },
    })
    await runSearch(args, [clean], e => events.push(e))
    expect(events).toContainEqual(expect.not.objectContaining({ droppedEntries: expect.anything() }))
  })
})

describe('providerErrorFields', () => {
  // 供 cli/index.ts 的 journal step 消费：把 provider_error 事件上类型化的 code/resetAt
  // 随 provider/message 一起转发，消费方不用各自 duck-type 读取未声明字段。
  it('forwards code/resetAt from a quota_exhausted provider_error event', () => {
    const e: FetchEvent = {
      event: 'provider_error', provider: 'opensubtitles', message: 'quota exhausted',
      code: 'quota_exhausted', resetAt: '2026-07-12T00:00:00.000Z',
    }
    expect(providerErrorFields(e)).toEqual({
      provider: 'opensubtitles', message: 'quota exhausted',
      code: 'quota_exhausted', resetAt: '2026-07-12T00:00:00.000Z',
    })
  })
  it('leaves code/resetAt undefined for a plain provider_error (no quota contract attached)', () => {
    const e: FetchEvent = { event: 'provider_error', provider: 'assrt', message: '503 upstream' }
    expect(providerErrorFields(e)).toEqual({ provider: 'assrt', message: '503 upstream', code: undefined, resetAt: undefined })
  })
})

describe('providerNoticeFields', () => {
  // provider_notice：非错误的信息性事件（如 OS 下载成功但配额已耗尽的提前预警）——
  // journal 消费方（cli/index.ts）用它转发 code/resetAt，规则同 providerErrorFields。
  it('forwards provider/message/code/resetAt from a provider_notice event', () => {
    const e: FetchEvent = {
      event: 'provider_notice', provider: 'opensubtitles',
      message: 'opensubtitles download quota exhausted after this call (resets 2026-07-12T00:00:00.000Z)',
      code: 'quota_exhausted', resetAt: '2026-07-12T00:00:00.000Z',
    }
    expect(providerNoticeFields(e)).toEqual({
      provider: 'opensubtitles',
      message: 'opensubtitles download quota exhausted after this call (resets 2026-07-12T00:00:00.000Z)',
      code: 'quota_exhausted', resetAt: '2026-07-12T00:00:00.000Z',
    })
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
