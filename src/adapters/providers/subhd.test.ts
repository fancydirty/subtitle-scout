import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSearchResults } from './subhd.js'

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
