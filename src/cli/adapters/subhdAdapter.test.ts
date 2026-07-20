import { describe, it, expect } from 'vitest'
import { makeSubhdAdapter } from './subhdAdapter.js'
import type { SubhdSearchResult } from '../../adapters/providers/subhd.js'

const oneResult: SubhdSearchResult = {
  id: 'aZ9', videoName: 'X.S01E01', language: '简体', subtype: 'ASS', releaseSite: '官方字幕',
}

describe('makeSubhdAdapter', () => {
  it('name=subhd；search 映射→SubtitleCandidate(provider=subhd)', async () => {
    const client = { search: async () => [oneResult], resolveDownload: async () => ({ url: '', cookie: null }) }
    const a = makeSubhdAdapter(client)
    expect(a.name).toBe('subhd')
    const cands = await a.search({ queries: ['X'] }, () => {})
    expect(cands[0]).toMatchObject({
      provider: 'subhd', providerId: 'aZ9', videoName: 'X.S01E01', nativeName: 'X.S01E01',
      language: '简体', subtype: 'ASS', releaseSite: '官方字幕', fileList: [],
    })
  })

  it('resolve → CDN url + SUBHD_HEADERS（cookie=null 时不带 Cookie）', async () => {
    const client = { search: async () => [], resolveDownload: async () => ({ url: 'https://dlus.subhd.me/x.ass', cookie: null }) }
    const r = await makeSubhdAdapter(client).resolve({ provider: 'subhd', providerId: 'aZ9', fileIndex: null }, () => {})
    expect(r.url).toBe('https://dlus.subhd.me/x.ass')
    expect(r.headers?.['User-Agent']).toMatch(/Mozilla/)
    expect(r.headers?.Cookie).toBeUndefined()
  })

  it('resolve 带 cookie 时透传 Cookie 头', async () => {
    const client = { search: async () => [], resolveDownload: async () => ({ url: 'u', cookie: 'tk_x=y' }) }
    const r = await makeSubhdAdapter(client).resolve({ provider: 'subhd', providerId: 'z', fileIndex: null }, () => {})
    expect(r.headers?.Cookie).toBe('tk_x=y')
  })

  it('queries 为空 → 空候选', async () => {
    const a = makeSubhdAdapter({ search: async () => [oneResult], resolveDownload: async () => ({ url: '', cookie: null }) })
    expect(await a.search({ queries: [] }, () => {})).toEqual([])
  })
})
