import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSearchResults, parsePrepareDownload, extractTkCookie, parseApiSubDown } from './subhd.js'

const fx = (name: string) => readFileSync(join(__dirname, '__fixtures__/subhd', name), 'utf8')

describe('parseSearchResults (真机夹具 search-the-rig.html)', () => {
  const html = fx('search-the-rig.html')
  const results = parseSearchResults(html)

  it('解析出全部 20 张结果卡片，每条 id 非空', () => {
    expect(results.length).toBe(20)
    expect(results.every(r => r.id.length > 0)).toBe(true)
    // id 去重：同一 /a/<id> 每卡出现两次，结果里每个 id 只应一次
    expect(new Set(results.map(r => r.id)).size).toBe(results.length)
  })

  it('miSC8x：发布名/多语/格式/来源徽章全对', () => {
    const r = results.find(x => x.id === 'miSC8x')
    expect(r).toMatchObject({
      id: 'miSC8x',
      videoName: '伽马射线效应.The.Effect.of.Gamma.Rays.on.Man-in-the-Moon.Marigolds.1972-SONYHD',
      language: '简体/繁体/英语',
      subtype: 'SUP',
      releaseSite: '转载精修',
    })
  })

  it('AeKBjs：单语繁体 + HTML 实体解码（I&#39;ll → I’ll... apostrophe）', () => {
    const r = results.find(x => x.id === 'AeKBjs')
    expect(r?.language).toBe('繁体')
    expect(r?.subtype).toBe('SRT')
    expect(r?.releaseSite).toBe('官方字幕')
    expect(r?.videoName).toBe("繁粤 | I'll Be Right There (2023)")
  })

  it('UKfNhL：来源徽章带 bg-black 变体（AI翻润色）也能取到，多语双语/简体/英语', () => {
    const r = results.find(x => x.id === 'UKfNhL')
    expect(r?.releaseSite).toBe('AI翻润色')
    expect(r?.language).toBe('双语/简体/英语')
    expect(r?.subtype).toBe('ASS')
  })

  it('空/畸形 HTML → 空数组，不抛', () => {
    expect(parseSearchResults('')).toEqual([])
    expect(parseSearchResults('<html><body>no results</body></html>')).toEqual([])
  })
})

describe('parsePrepareDownload（step 2：拿 /down/<id> 相对路径）', () => {
  it('{success:true,url:"/down/x"} → "/down/x"；success:false → 抛', () => {
    expect(parsePrepareDownload(JSON.stringify({ success: true, url: '/down/aZ9' }))).toBe('/down/aZ9')
    expect(() => parsePrepareDownload(JSON.stringify({ success: false }))).toThrow()
    expect(() => parsePrepareDownload(JSON.stringify({ success: true }))).toThrow()
  })
  it('真机夹具 prepare-download-2BNs4Y.json → /down/2BNs4Y', () => {
    expect(parsePrepareDownload(fx('prepare-download-2BNs4Y.json'))).toBe('/down/2BNs4Y')
  })
})

describe('extractTkCookie（从 Set-Cookie 行数组提 tk_）', () => {
  it('提取首个 tk_ 段，无则 null', () => {
    expect(extractTkCookie(['tk_abc=xyz123; Max-Age=300; HttpOnly', 'other=1'])).toBe('tk_abc=xyz123')
    expect(extractTkCookie([])).toBeNull()
    expect(extractTkCookie(['session=nope; Path=/'])).toBeNull()
  })
  it('真机夹具 headers.txt → 完整 tk_…=… 段', () => {
    const lines = fx('prepare-download-2BNs4Y.headers.txt').split(/\r?\n/)
    const tk = extractTkCookie(lines)
    expect(tk).toBe('tk_663413_519a312e0c1377d16ab1e610=249e07620566c77e9b5683ee7e45765fe21f50c9d19f077ee0cc75ae0e893f61')
  })
})

describe('parseApiSubDown（step 4：拿真 CDN 文件 url）', () => {
  it('{success:true,pass:true,url:"https://…"} → url；success:false → 携 msg 抛', () => {
    expect(parseApiSubDown(JSON.stringify({ success: true, pass: true, url: 'https://dlus.subhd.me/x.ass' })))
      .toBe('https://dlus.subhd.me/x.ass')
    expect(() => parseApiSubDown(JSON.stringify({ success: false, msg: '时间过长本临时页面已经失效', url: null })))
      .toThrow(/时间过长/)
  })
  it('真机夹具 api-sub-down-2BNs4Y.json → dlus CDN url', () => {
    expect(parseApiSubDown(fx('api-sub-down-2BNs4Y.json'))).toBe('https://dlus.subhd.me/2026/06/1782478768658.ass')
  })
})
