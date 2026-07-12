import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSearchResults, parseDetailPage, ZIMUKU_BASE } from './zimuku.js'

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
