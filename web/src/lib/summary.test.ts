import { describe, it, expect } from 'vitest'
import { libraryFacts, factLine } from './summary.js'
import type { LibraryItemDTO } from '../api/types.js'

const item = (p: Partial<LibraryItemDTO> & Pick<LibraryItemDTO, 'id' | 'kind' | 'coverage'>): LibraryItemDTO =>
  ({ name: 'n', chineseTitle: null, year: null, posterTag: null, job: null, ...p })

describe('libraryFacts / factLine', () => {
  it('分类计数 + 缺字幕/处理中', () => {
    const items: LibraryItemDTO[] = [
      item({ id: 'a', kind: 'series', coverage: { covered: 12, missing: 0, embedded: 0, unavailable: 0 } }), // full
      item({ id: 'b', kind: 'series', coverage: { covered: 3, missing: 5, embedded: 0, unavailable: 0 } }), // part → missing
      item({ id: 'c', kind: 'series', coverage: { covered: 0, missing: 4, embedded: 0, unavailable: 0 }, job: { state: 'searching', priority: 0 } }), // work
      item({ id: 'd', kind: 'movie', coverage: { covered: 0, missing: 1, embedded: 0, unavailable: 0 } }), // none → missing
    ]
    const f = libraryFacts(items)
    expect(f).toEqual({ series: 3, movies: 1, missing: 2, working: 1 })
    expect(factLine(f)).toBe('3 部剧 · 1 部电影 · 缺字幕 2 · 1 部处理中')
  })
  it('只报存在的量', () => {
    expect(factLine({ series: 5, movies: 0, missing: 0, working: 0 })).toBe('5 部剧')
  })
})
