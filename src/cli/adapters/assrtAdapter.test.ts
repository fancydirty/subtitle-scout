import { describe, it, expect, vi } from 'vitest'
import { makeAssrtAdapter } from './assrtAdapter.js'
import type { AssrtClient } from '../../adapters/providers/assrt.js'
import type { AssrtSub } from '../../core/schemas.js'
import type { FetchArgs } from '../fetchLib.js'

type FakeAssrtClient = Pick<AssrtClient, 'search' | 'similar' | 'searchByFilename' | 'detail'>

/** search/similar/searchByFilename/detail 共用的响应外壳（status/sub.subs） */
const resp = (subs: AssrtSub[]) => ({ status: 0, sub: { subs } })

/** 最小 AssrtSub 夹具：默认空 filelist，按需覆盖 */
const mkSub = (id: number, extra: Partial<AssrtSub> = {}): AssrtSub => ({ id, filelist: [], ...extra })

function fakeClient(overrides: Partial<FakeAssrtClient> = {}): FakeAssrtClient {
  return {
    search: vi.fn(async () => resp([])),
    similar: vi.fn(async () => resp([])),
    searchByFilename: vi.fn(async () => resp([])),
    detail: vi.fn(async () => resp([])),
    ...overrides,
  } as FakeAssrtClient
}

const args = (over: Partial<FetchArgs> = {}): FetchArgs => ({ queries: [], ...over })

describe('makeAssrtAdapter: enabled (A4 provider language gating — assrt is a China-only subtitle source)', () => {
  const adapter = makeAssrtAdapter(fakeClient())

  it('languages: [\'en\'] → disabled (assrt has nothing to offer a non-Chinese target)', () => {
    expect(adapter.enabled(args({ languages: ['en'] }), process.env)).toBe(false)
  })

  it('languages: [\'zh-cn\'] → enabled', () => {
    expect(adapter.enabled(args({ languages: ['zh-cn'] }), process.env)).toBe(true)
  })

  it('languages: [\'zh\'] → enabled', () => {
    expect(adapter.enabled(args({ languages: ['zh'] }), process.env)).toBe(true)
  })

  it('languages containing zh alongside other targets → enabled (any match is enough)', () => {
    expect(adapter.enabled(args({ languages: ['en', 'ja', 'zh'] }), process.env)).toBe(true)
  })

  it('languages: [] (explicitly empty, no targets at all) → disabled', () => {
    expect(adapter.enabled(args({ languages: [] }), process.env)).toBe(false)
  })
})

describe('makeAssrtAdapter: search', () => {
  it('①两条 query → 2 次 search 调用，结果按 id 去重', async () => {
    const search = vi.fn(async (q: string) =>
      q === 'q1' ? resp([mkSub(1), mkSub(2)]) : resp([mkSub(2), mkSub(3)]))
    const client = fakeClient({ search })
    const adapter = makeAssrtAdapter(client)

    const results = await adapter.search(args({ queries: ['q1', 'q2'] }), () => {})

    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenNthCalledWith(1, 'q1')
    expect(search).toHaveBeenNthCalledWith(2, 'q2')
    expect(results.map(c => c.providerId).sort()).toEqual(['1', '2', '3'])
  })

  it('②三条 query → 只搜前 2 条（slice(0,2)）', async () => {
    const search = vi.fn(async () => resp([mkSub(1)]))
    const client = fakeClient({ search })
    const adapter = makeAssrtAdapter(client)

    await adapter.search(args({ queries: ['q1', 'q2', 'q3'] }), () => {})

    expect(search).toHaveBeenCalledTimes(2)
    expect(search).toHaveBeenNthCalledWith(1, 'q1')
    expect(search).toHaveBeenNthCalledWith(2, 'q2')
  })

  it('③hits>0 → similar(topId) 被调用，结果并入并去重', async () => {
    const search = vi.fn(async () => resp([mkSub(1), mkSub(2)]))
    const similar = vi.fn(async () => resp([mkSub(2), mkSub(3)])) // 2 重复，3 新增
    const client = fakeClient({ search, similar })
    const adapter = makeAssrtAdapter(client)

    const results = await adapter.search(args({ queries: ['q1'] }), () => {})

    expect(similar).toHaveBeenCalledWith(1) // top = 首个去重后收录的 id
    expect(results.map(c => c.providerId).sort()).toEqual(['1', '2', '3'])
  })

  it('④similar 抛错 → 主结果仍照常返回（gems 失败不影响主流程）', async () => {
    const search = vi.fn(async () => resp([mkSub(1)]))
    const similar = vi.fn(async () => { throw new Error('gems down') })
    const client = fakeClient({ search, similar })
    const adapter = makeAssrtAdapter(client)

    const results = await adapter.search(args({ queries: ['q1'] }), () => {})

    expect(results.map(c => c.providerId)).toEqual(['1'])
  })

  it('④b similar 抛错 → 不再裸吞：emit 一个 provider_error，供上游残缺集判定使用', async () => {
    // gems 扩召回失败若被裸吞，下游消费方永远看不到这个瞬时故障，可能把"残缺集拒判"当成
    // "确实没有"写 1 天负缓存（这个信号本是给旧管线 pipeline.ts 的 incomplete-candidate-set
    // 守卫用的——pipeline.ts 已随旧管线退役删除，但"失败不能裸吞"这条纪律本身跟消费方是谁
    // 无关，对今天的 search_source/cli 日志消费方同样成立）。
    const search = vi.fn(async () => resp([mkSub(1)]))
    const similar = vi.fn(async () => { throw new Error('gems down') })
    const client = fakeClient({ search, similar })
    const adapter = makeAssrtAdapter(client)
    const events: unknown[] = []

    const results = await adapter.search(args({ queries: ['q1'] }), e => events.push(e))

    expect(results.map(c => c.providerId)).toEqual(['1']) // 主结果不受影响
    expect(events).toContainEqual(expect.objectContaining({ event: 'provider_error', provider: 'assrt' }))
  })

  it('⑤0 命中 + 有 filename → 调用 searchByFilename 兜底', async () => {
    const search = vi.fn(async () => resp([]))
    const searchByFilename = vi.fn(async () => resp([mkSub(9)]))
    const client = fakeClient({ search, searchByFilename })
    const adapter = makeAssrtAdapter(client)

    const results = await adapter.search(args({ queries: ['q1'], filename: 'Show.S01E01.mkv' }), () => {})

    expect(searchByFilename).toHaveBeenCalledWith('Show.S01E01.mkv')
    expect(results.map(c => c.providerId)).toEqual(['9'])
  })

  it('⑥0 命中且无 filename → 不调用 searchByFilename，返回空结果', async () => {
    const search = vi.fn(async () => resp([]))
    const searchByFilename = vi.fn(async () => resp([mkSub(9)]))
    const client = fakeClient({ search, searchByFilename })
    const adapter = makeAssrtAdapter(client)

    const results = await adapter.search(args({ queries: ['q1'] }), () => {})

    expect(searchByFilename).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })
})

describe('makeAssrtAdapter: resolve', () => {
  it('⑦按 fileIndex 取 filelist[fileIndex].url', async () => {
    const detail = vi.fn(async () => resp([mkSub(5, {
      filelist: [{ f: 'a.srt', url: 'http://a' }, { f: 'b.srt', url: 'http://b' }],
    })]))
    const client = fakeClient({ detail })
    const adapter = makeAssrtAdapter(client)

    const r = await adapter.resolve({ provider: 'assrt', providerId: '5', fileIndex: 1 }, () => {})

    expect(r).toEqual({ url: 'http://b', filename: 'b.srt' })
  })

  it('⑧filelist 无对应项时回退 sub.url', async () => {
    const detail = vi.fn(async () => resp([mkSub(5, {
      url: 'http://fallback', filename: 'whole.srt', filelist: [],
    })]))
    const client = fakeClient({ detail })
    const adapter = makeAssrtAdapter(client)

    const r = await adapter.resolve({ provider: 'assrt', providerId: '5', fileIndex: null }, () => {})

    expect(r).toEqual({ url: 'http://fallback', filename: 'whole.srt' })
  })

  it('⑨完全没有 url（无 filelist 项也无 sub.url）时抛错', async () => {
    const detail = vi.fn(async () => resp([mkSub(5, { filelist: [] })]))
    const client = fakeClient({ detail })
    const adapter = makeAssrtAdapter(client)

    await expect(adapter.resolve({ provider: 'assrt', providerId: '5', fileIndex: null }, () => {}))
      .rejects.toThrow(/has no download url/)
  })
})
