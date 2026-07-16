// web/src/library/filter.test.ts
import { describe, it, expect } from 'vitest'
import { matchesLibraryFilter, groupBySection } from './filter.js'
import type { CoverageDTO, LibraryItemDTO } from '../api/types.js'

function cov(partial: Partial<CoverageDTO>): CoverageDTO {
  return { covered: 0, missing: 0, embedded: 0, unavailable: 0, ...partial }
}

describe('matchesLibraryFilter', () => {
  it('all 恒真', () => {
    expect(matchesLibraryFilter(cov({}), 'all')).toBe(true)
    expect(matchesLibraryFilter(cov({ missing: 5 }), 'all')).toBe(true)
  })

  it('gap：missing > 0', () => {
    expect(matchesLibraryFilter(cov({ missing: 1 }), 'gap')).toBe(true)
    expect(matchesLibraryFilter(cov({ missing: 0, unavailable: 3 }), 'gap')).toBe(false)
  })

  it('throttled：missing===0 且 unavailable > 0', () => {
    expect(matchesLibraryFilter(cov({ unavailable: 2 }), 'throttled')).toBe(true)
    expect(matchesLibraryFilter(cov({ missing: 1, unavailable: 2 }), 'throttled')).toBe(false)
  })

  it('full：missing===0 且 unavailable===0 且已有战果', () => {
    expect(matchesLibraryFilter(cov({ covered: 12 }), 'full')).toBe(true)
    expect(matchesLibraryFilter(cov({ embedded: 3 }), 'full')).toBe(true)
    expect(matchesLibraryFilter(cov({}), 'full')).toBe(false) // 零集不算全覆盖
    expect(matchesLibraryFilter(cov({ covered: 1, missing: 1 }), 'full')).toBe(false)
  })
})

describe('groupBySection', () => {
  function item(id: string, section: string): LibraryItemDTO {
    return {
      id, kind: 'series', name: id, chineseTitle: null, year: null, posterPath: null,
      section, coverage: cov({}), job: null,
    }
  }

  it('已知分区按 剧集→动漫→电影 排序，未知分区排最后按名称', () => {
    const groups = groupBySection([
      item('a', '电影'), item('b', '其他'), item('c', '剧集'), item('d', '动漫'),
    ])
    expect(groups.map((g) => g.section)).toEqual(['剧集', '动漫', '电影', '其他'])
  })

  it('每组保留原条目，空分区不产出', () => {
    const groups = groupBySection([item('a', '剧集'), item('b', '剧集')])
    expect(groups).toHaveLength(1)
    expect(groups[0].items).toHaveLength(2)
  })
})
