import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSearchResults } from './zimuku.js'

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
