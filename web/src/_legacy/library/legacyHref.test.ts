// web/src/_legacy/library/legacyHref.test.ts：旧海报卡拼址的断言。
//
// 这两条原本住在 `media/route.media.test.ts` 里（那时函数还叫 `shell/route.ts` 的
// `libraryItemHref`）。Task ⑪ 把函数搬到本目录后，测试**必须跟着搬进 `_legacy/`**：
// 活代码区（包括活的测试文件）一旦 import `_legacy/`，`_legacy` 就删不掉，
// 而 `media/legacyIsolation.test.ts` 的「全域方向铁律」那条会红。
// 实测确实红了一次——本文件就是那次的正解（把测试搬进来，而不是把守卫改软）。
//
// ⚠️ 这里断言的是**拼址函数的输出字面量**，不是"这个 hash 能打开旧详情页"。后者已经不成立：
// `shell/route.ts` 的 LEGACY_REDIRECTS 会把 `#/library*` 全部改写到 `#/media` 并丢弃 id 段
// （那条由 `media/route.media.test.ts` 与 `shell/nav.contract.test.tsx` 各钉一遍）。
import { describe, it, expect } from 'vitest'
import { libraryItemHref } from './legacyHref.js'

describe('libraryItemHref（已下架的旧海报卡拼址）', () => {
  it('series → #/library/:id，movie → #/library/movies/:id', () => {
    expect(libraryItemHref({ kind: 'series', libraryId: 'tmdb:1' })).toBe('#/library/tmdb%3A1')
    expect(libraryItemHref({ kind: 'movie', libraryId: 'tmdb:1' })).toBe('#/library/movies/tmdb%3A1')
  })

  it('id 里的冒号/斜杠/空格走 encodeURIComponent', () => {
    expect(libraryItemHref({ kind: 'series', libraryId: 'tmdb:123' })).toBe('#/library/tmdb%3A123')
    expect(libraryItemHref({ kind: 'series', libraryId: 'a b' })).toBe('#/library/a%20b')
    // 斜杠必须被编码——不编码会凭空多出一段路径
    expect(libraryItemHref({ kind: 'series', libraryId: 'weird/id' })).toBe('#/library/weird%2Fid')
  })
})
