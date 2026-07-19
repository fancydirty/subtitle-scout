import { describe, it, expect, vi } from 'vitest'
import { makeZimukuAdapter } from './zimukuAdapter.js'
import type { ZimukuClient } from '../../adapters/providers/zimuku.js'
import type { FetchArgs } from '../fetchLib.js'

type FakeZimukuClient = Pick<ZimukuClient, 'search' | 'resolveDownload'>

function fakeClient(overrides: Partial<FakeZimukuClient> = {}): FakeZimukuClient {
  return {
    search: vi.fn(async () => []),
    resolveDownload: vi.fn(async () => ({ url: 'https://zimuku.org/download/tok/svr/d0', cookie: 'PHPSESSID=abc' })),
    ...overrides,
  }
}

const args = (over: Partial<FetchArgs> = {}): FetchArgs => ({ queries: [], ...over })

describe('makeZimukuAdapter: search', () => {
  it('searches with the first query only and maps results to provider-neutral candidates with empty fileList', async () => {
    const search = vi.fn(async () => [{ id: '58421', title: '间谍过家家 第一季' }])
    const client = fakeClient({ search })
    const adapter = makeZimukuAdapter(client)

    const results = await adapter.search(args({ queries: ['间谍过家家', '第二个query不该被用到'] }), () => {})

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('间谍过家家')
    expect(results).toEqual([{
      provider: 'zimuku', providerId: '58421', videoName: '间谍过家家 第一季', nativeName: '间谍过家家 第一季',
      language: null, subtype: null, releaseSite: 'zimuku', uploadDate: null, fileList: [],
    }])
  })

  it('no queries → returns empty without calling search', async () => {
    const search = vi.fn(async () => [])
    const adapter = makeZimukuAdapter(fakeClient({ search }))
    const results = await adapter.search(args({ queries: [] }), () => {})
    expect(search).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })
})

describe('makeZimukuAdapter: resolve', () => {
  it('resolves via detail→dld to the first mirror url + browser headers incl. the PHPSESSID cookie (downloadDirect follows the 301 to the CDN)', async () => {
    const resolveDownload = vi.fn(async () => ({ url: 'https://zimuku.org/download/tok/svr/d0', cookie: 'PHPSESSID=xyz' }))
    const adapter = makeZimukuAdapter(fakeClient({ resolveDownload }))

    const r = await adapter.resolve({ provider: 'zimuku', providerId: '179286', fileIndex: null }, () => {})

    expect(resolveDownload).toHaveBeenCalledWith('179286')
    expect(r.url).toBe('https://zimuku.org/download/tok/svr/d0')
    expect(r.filename).toBeUndefined() // CandidateRef 无 videoName;下载层按 contentType 兜底命名
    expect(r.headers).toMatchObject({ 'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: 'PHPSESSID=xyz' })
  })

  it('omits the Cookie header when the dld page issued no PHPSESSID', async () => {
    const resolveDownload = vi.fn(async () => ({ url: 'https://zimuku.org/download/tok/svr/l0', cookie: null }))
    const adapter = makeZimukuAdapter(fakeClient({ resolveDownload }))
    const r = await adapter.resolve({ provider: 'zimuku', providerId: '1', fileIndex: null }, () => {})
    expect(r.headers && 'Cookie' in r.headers).toBe(false)
  })
})
