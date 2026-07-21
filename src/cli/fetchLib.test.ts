import { describe, it, expect } from 'vitest'
import { runSearch, runResolve, interleaveByProvider, providerErrorFields, providerNoticeFields, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
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

describe('runSearch: provider-diversity interleave (The Rig 2026-07-20 regression — a precise low-volume provider result must not be buried past the pagination window by a high-volume one)', () => {
  const many = (provider: SubtitleCandidate['provider'], n: number): SubtitleCandidate[] =>
    Array.from({ length: n }, (_, i) => ({
      provider, providerId: `${provider}-${i}`, videoName: null, nativeName: null,
      language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }))
  const provAdapter = (name: string, cands: SubtitleCandidate[]): FetchAdapter =>
    ({ name, enabled: () => true, search: async () => cands, resolve: async () => ({ url: 'x' }) })

  it('surfaces a low-volume provider\'s top candidate in the first ranks, not behind a high-volume provider\'s block', async () => {
    // Real bug: opensubtitles returned 50, zimuku returned 1 exact-match season pack → naive
    // concatenation put the zimuku pack at rank ~50, outside the agent's list_candidates limit-50 window.
    const r = await runSearch({ queries: ['q'] }, [
      provAdapter('opensubtitles', many('opensubtitles', 50)),
      provAdapter('zimuku', many('zimuku', 1)),
    ], () => {})
    const zimukuRank = r.findIndex(c => c.provider === 'zimuku')
    expect(zimukuRank).toBeGreaterThanOrEqual(0)
    expect(zimukuRank).toBeLessThan(5)   // visible up front, not ~rank 50
    expect(r).toHaveLength(51)           // pure reorder — nothing dropped
  })

  it('round-robin: every provider\'s Nth result precedes any provider\'s (N+1)th', async () => {
    const r = await runSearch({ queries: ['q'] }, [
      provAdapter('assrt', many('assrt', 3)),
      provAdapter('zimuku', many('zimuku', 2)),
    ], () => {})
    expect(r.map(c => c.providerId)).toEqual(['assrt-0', 'zimuku-0', 'assrt-1', 'zimuku-1', 'assrt-2'])
  })

  it('F2: ja 搜索时 jimaku 候选移到最前（日字专门源优先，真机 OS 日字曾致 critic held）', async () => {
    const r = await runSearch({ queries: ['Frieren'], languages: ['ja'] }, [
      provAdapter('opensubtitles', many('opensubtitles', 3)),
      provAdapter('jimaku', many('jimaku', 1)),
    ], () => {})
    expect(r[0].provider).toBe('jimaku')
    expect(r).toHaveLength(4)
  })

  it('非 ja 搜索（en）不重排，保持 round-robin', async () => {
    const r = await runSearch({ queries: ['q'], languages: ['en'] }, [
      provAdapter('opensubtitles', many('opensubtitles', 2)),
      provAdapter('jimaku', many('jimaku', 1)),
    ], () => {})
    expect(r.map(c => c.providerId)).toEqual(['opensubtitles-0', 'jimaku-0', 'opensubtitles-1'])
  })
})

describe('interleaveByProvider', () => {
  const c = (p: SubtitleCandidate['provider'], id: string): SubtitleCandidate =>
    ({ provider: p, providerId: id, videoName: null, nativeName: null, language: null,
       subtype: null, releaseSite: null, uploadDate: null, fileList: [] })
  it('round-robins uneven-length arrays and drops nothing (preserves each provider\'s internal order)', () => {
    const out = interleaveByProvider([
      [c('assrt', 'a0'), c('assrt', 'a1')],
      [c('zimuku', 'z0')],
      [c('subhd', 's0'), c('subhd', 's1'), c('subhd', 's2')],
    ])
    expect(out.map(x => x.providerId)).toEqual(['a0', 'z0', 's0', 'a1', 's1', 's2'])
  })
  it('empty input → empty output', () => {
    expect(interleaveByProvider([])).toEqual([])
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
