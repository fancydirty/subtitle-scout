// web/src/library/filter.test.ts
import { describe, it, expect } from 'vitest'
import { matchesLibraryFilter, groupBySection, applyKindFilter } from './filter.js'
import type { CoverageDTO, LibraryItemDTO } from '../api/types.js'

function cov(partial: Partial<CoverageDTO>): CoverageDTO {
  return { covered: 0, missing: 0, embedded: 0, unavailable: 0, hardsubAssumed: 0, partial: 0, ...partial }
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
    expect(matchesLibraryFilter(cov({ hardsubAssumed: 3 }), 'full')).toBe(true)
    expect(matchesLibraryFilter(cov({ hardsubAssumed: 3 }), 'gap')).toBe(false)
    expect(matchesLibraryFilter(cov({}), 'full')).toBe(false) // 零集不算全覆盖
    expect(matchesLibraryFilter(cov({ covered: 1, missing: 1 }), 'full')).toBe(false)
  })
})

describe('applyKindFilter', () => {
  function item(id: string, kind: 'series' | 'movie'): LibraryItemDTO {
    return {
      id, kind, name: id, chineseTitle: null, year: null, posterPath: null,
      section: '剧集', coverage: cov({}), job: null,
      originLang: null, nativeAudio: false,
    }
  }

  const items: LibraryItemDTO[] = [
    item('s1', 'series'),
    item('m1', 'movie'),
    item('s2', 'series'),
  ]

  it('all 返回全部', () => {
    const result = applyKindFilter(items, 'all')
    expect(result).toHaveLength(3)
  })

  it('series 只返回 series 行', () => {
    const result = applyKindFilter(items, 'series')
    expect(result).toHaveLength(2)
    expect(result.every((x) => x.kind === 'series')).toBe(true)
  })

  it('movies 只返回 movie 行', () => {
    const result = applyKindFilter(items, 'movies')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('m1')
  })
})

describe('groupBySection', () => {
  function item(id: string, section: string): LibraryItemDTO {
    return {
      id, kind: 'series', name: id, chineseTitle: null, year: null, posterPath: null,
      section, coverage: cov({}), job: null,
      originLang: null, nativeAudio: false,
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
