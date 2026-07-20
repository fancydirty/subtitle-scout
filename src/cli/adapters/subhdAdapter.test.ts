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

  it('resolve 从 CDN url 派生 filename（扩展名驱动 writeSubtitle 分派：.ass/.srt 裸存、.zip 解包、.rar/.7z 诚实报错，而非被当 download.srt 写成垃圾）', async () => {
    const cases: [string, string][] = [
      ['https://dlus.subhd.me/2026/06/1782478768658.ass', '.ass'],
      ['https://dlus.subhd.me/x/y.srt', '.srt'],
      ['https://dlus.subhd.me/a/b.rar', '.rar'],
      ['https://dlus.subhd.me/a/b.7z', '.7z'],
      ['https://dlus.subhd.me/a/b.zip', '.zip'],
    ]
    for (const [url, ext] of cases) {
      const client = { search: async () => [], resolveDownload: async () => ({ url, cookie: null }) }
      const r = await makeSubhdAdapter(client).resolve({ provider: 'subhd', providerId: 'x', fileIndex: null }, () => {})
      expect(r.filename?.toLowerCase().endsWith(ext)).toBe(true)
    }
  })

  it('resolve：url 无扩展名 → 不返回 filename（不硬编一个错的兜底）', async () => {
    const client = { search: async () => [], resolveDownload: async () => ({ url: 'https://dlus.subhd.me/noext', cookie: null }) }
    const r = await makeSubhdAdapter(client).resolve({ provider: 'subhd', providerId: 'x', fileIndex: null }, () => {})
    expect(r.filename).toBeUndefined()
  })

  it('queries 为空 → 空候选', async () => {
    const a = makeSubhdAdapter({ search: async () => [oneResult], resolveDownload: async () => ({ url: '', cookie: null }) })
    expect(await a.search({ queries: [] }, () => {})).toEqual([])
  })
})
