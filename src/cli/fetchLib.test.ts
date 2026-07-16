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
  const args: FetchArgs = { queries: ['q1'] }
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
  const args: FetchArgs = { queries: ['q1'] }
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

describe('runResolve header pass-through (zimuku archive download needs browser headers)', () => {
  it('forwards headers returned by the adapter unchanged', async () => {
    const headers = { 'User-Agent': 'test-ua', Referer: 'https://www.zimuku.org/' }
    const zimukuAdapter = adapter('zimuku', { resolve: async () => ({ url: 'https://dl/zimuku', headers }) })
    const r = await runResolve({ provider: 'zimuku', providerId: '1', fileIndex: null }, [zimukuAdapter])
    expect(r.headers).toEqual(headers)
  })
  it('headers stays undefined when the adapter does not return them (assrt/opensubtitles unaffected)', async () => {
    const r = await runResolve({ provider: 'assrt', providerId: '1', fileIndex: 0 }, [adapter('assrt')])
    expect(r.headers).toBeUndefined()
  })
})

describe('"no providers configured" message mentions all three provider gates', () => {
  it('mentions ZIMUKU_ENABLED alongside ASSRT_TOKEN/OPENSUBTITLES_API_KEY', async () => {
    await expect(runSearch({ queries: ['q'] }, [], () => {})).rejects.toThrow(/ZIMUKU_ENABLED/)
  })
})

describe('runSearch: A4 default-language plumbing for enabled() gating (a language-gated adapter — e.g. assrt — must not silently drop off a search that never specified languages)', () => {
  // Mirrors the real assrtAdapter.ts gate (China-only source): enabled iff some requested
  // language looks Chinese. This adapter double checks BOTH sides of the trace: what `enabled`
  // actually saw AND whether it ended up included/excluded from the search.
  function languageGatedAdapter(name: string, seenArgsLog: FetchArgs[]): FetchAdapter {
    return {
      name,
      enabled: (a) => { seenArgsLog.push(a); return (a.languages ?? []).some(l => /^zh/i.test(l)) },
      search: async () => [cand('assrt', `${name}-1`)],
      resolve: async () => ({ url: `https://dl/${name}` }),
    }
  }

  it('args.languages omitted entirely (no explicit target — the un-annotated old fetch path / model-omitted search_source call) → still resolves to a Chinese default, assrt-like adapter stays enabled', async () => {
    const seen: FetchArgs[] = []
    const adapter = languageGatedAdapter('assrt', seen)
    const r = await runSearch({ queries: ['q1'] }, [adapter], () => {})
    expect(r.map(c => c.providerId)).toEqual(['assrt-1'])
    expect(seen[0]?.languages).toEqual(['zh'])
  })

  it('args.languages explicitly set to a non-Chinese target (e.g. [\'en\']) → NOT overridden, adapter correctly excluded', async () => {
    const seen: FetchArgs[] = []
    const adapter = languageGatedAdapter('assrt', seen)
    await expect(runSearch({ queries: ['q1'], languages: ['en'] }, [adapter], () => {}))
      .rejects.toThrow(/no providers configured/)
    expect(seen[0]?.languages).toEqual(['en'])
  })

  it('args.languages explicitly set to a Chinese target → passed through unchanged (not clobbered by the default)', async () => {
    const seen: FetchArgs[] = []
    const adapter = languageGatedAdapter('assrt', seen)
    await runSearch({ queries: ['q1'], languages: ['zh-cn'] }, [adapter], () => {})
    expect(seen[0]?.languages).toEqual(['zh-cn'])
  })

  it('the default only affects the enabled() gate check — the args an adapter\'s own search() receives are untouched (an adapter\'s own internal language default, e.g. OpenSubtitles/Zimuku\'s zh-cn/zh-tw, must not be double-defaulted)', async () => {
    let searchSawLanguages: string[] | undefined = ['sentinel-not-overwritten']
    const adapter: FetchAdapter = {
      name: 'os',
      enabled: () => true,
      search: async (a) => { searchSawLanguages = a.languages; return [cand('assrt', 'os-1')] },
      resolve: async () => ({ url: 'https://dl/os' }),
    }
    await runSearch({ queries: ['q1'] }, [adapter], () => {})
    expect(searchSawLanguages).toBeUndefined()
  })
})
