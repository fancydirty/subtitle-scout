import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSearchResults, parseDetailPage, ZIMUKU_BASE, ZimukuClient, type ZimukuClientOpts } from './zimuku.js'
import { MinIntervalLimiter } from './assrt.js'
import { ZimukuSessionStore } from './zimukuSession.js'

describe('parseSearchResults', () => {
  it('extracts id + title from every /detail/<id>.html anchor', () => {
    const html = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const results = parseSearchResults(html)
    expect(results).toEqual([
      { id: '58421', title: '间谍过家家 第一季 SPY×FAMILY' },
      { id: '58422', title: '间谍过家家 第二季 SPY×FAMILY Season 2' },
    ])
  })

  it('returns an empty array for a page with no results', () => {
    expect(parseSearchResults('<html><body>没有找到相关字幕</body></html>')).toEqual([])
  })
})

describe('parseDetailPage', () => {
  it('extracts the absolute download url and derives the filename from it', () => {
    const html = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')
    const r = parseDetailPage(html, ZIMUKU_BASE)
    expect(r).toEqual({
      downloadUrl: 'https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip',
      filename: 'spy_family_s01_zh.zip',
    })
  })

  it('throws when the page has no id="down" download link (page shape drift)', () => {
    expect(() => parseDetailPage('<html><body>no download link</body></html>', ZIMUKU_BASE))
      .toThrow(/id="down"/)
  })
})

describe('ZimukuClient', () => {
  function client(overrides: Partial<ZimukuClientOpts> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
    return new ZimukuClient({
      sessionStore: new ZimukuSessionStore(dir),
      solve: vi.fn(async () => ({ digits: '00000' })),
      limiter: new MinIntervalLimiter(1), // 测试用 1ms 起步间隔,避免真的等 2s
      ...overrides,
    })
  }

  it('search: fetches /search?q=..., sends browser headers, parses results (no challenge)', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://www.zimuku.org/search?q=%E9%97%B4%E8%B0%8D%E8%BF%87%E5%AE%B6%E5%AE%B6')
      expect((init!.headers as Record<string, string>)['User-Agent']).toContain('Mozilla')
      expect((init!.headers as Record<string, string>)['Accept-Language']).toBe('zh-CN,zh;q=0.9')
      return new Response(searchHtml)
    })
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const results = await c.search('间谍过家家')
    expect(results).toEqual([
      { id: '58421', title: '间谍过家家 第一季 SPY×FAMILY' },
      { id: '58422', title: '间谍过家家 第二季 SPY×FAMILY Season 2' },
    ])
  })

  it('detail: fetches /detail/<id>.html and parses the download link', async () => {
    const detailHtml = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(detailHtml))
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await c.detail('58421')
    expect(r).toEqual({
      downloadUrl: 'https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip',
      filename: 'spy_family_s01_zh.zip',
    })
  })

  it('respects the MinIntervalLimiter between requests (politeness)', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(searchHtml))
    const limiter = new MinIntervalLimiter(50)
    const waitSpy = vi.spyOn(limiter, 'wait')
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch, limiter })
    await c.search('x')
    expect(waitSpy).toHaveBeenCalled()
  })
})
