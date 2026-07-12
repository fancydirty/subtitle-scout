import { describe, it, expect, vi } from 'vitest'
import { makeZimukuAdapter } from './zimukuAdapter.js'
import type { ZimukuClient } from '../../adapters/providers/zimuku.js'
import type { FetchArgs } from '../fetchLib.js'

type FakeZimukuClient = Pick<ZimukuClient, 'search' | 'detail'>

function fakeClient(overrides: Partial<FakeZimukuClient> = {}): FakeZimukuClient {
  return {
    search: vi.fn(async () => []),
    detail: vi.fn(async () => ({ downloadUrl: 'https://static.zimuku.org/x.zip', filename: 'x.zip' })),
    ...overrides,
  }
}

const args = (over: Partial<FetchArgs> = {}): FetchArgs => ({ queries: [], deep: false, ...over })

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
  it('resolves to the archive url + filename + browser headers (needed by downloadDirect for the archive GET)', async () => {
    const detail = vi.fn(async () => ({ downloadUrl: 'https://static.zimuku.org/files/x.zip', filename: 'x.zip' }))
    const adapter = makeZimukuAdapter(fakeClient({ detail }))

    const r = await adapter.resolve({ provider: 'zimuku', providerId: '58421', fileIndex: null }, () => {})

    expect(detail).toHaveBeenCalledWith('58421')
    expect(r.url).toBe('https://static.zimuku.org/files/x.zip')
    expect(r.filename).toBe('x.zip')
    expect(r.headers).toMatchObject({ 'Accept-Language': 'zh-CN,zh;q=0.9' })
  })
})
