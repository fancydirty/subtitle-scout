// web/src/media/route.media.test.ts：#/media 二级路由 + 与旧 library 路由的**隔离**。
//
// 这个文件存在的理由是 Task ⑧ 引入了第二个"tab + id"形态的路由。两个已知的静默失效：
//  ① mediaWorkId 落在 libraryId 上（两个 id 空间混用）→ 媒体库详情页会拿旧端点的 id
//     去打新端点，或者反过来。TS 管不到（两个都是 string|null）。
//  ② 在 #/media 上误命中 library 的解析分支 → 媒体库详情页永远渲染列表。
import { describe, it, expect } from 'vitest'
import { parseShellHash, mediaItemHref, libraryItemHref } from '../shell/route.js'

describe('#/media 路由', () => {
  it('#/media → tab=media，mediaWorkId 为 null（列表页）', () => {
    const r = parseShellHash('#/media')
    expect(r.tab).toBe('media')
    expect(r.mediaWorkId ?? null).toBeNull()
  })

  it('#/media/tmdb%3A1396 → mediaWorkId 解码成 tmdb:1396', () => {
    const r = parseShellHash('#/media/tmdb%3A1396')
    expect(r.tab).toBe('media')
    expect(r.mediaWorkId).toBe('tmdb:1396')
  })

  it('mediaItemHref 与 parseShellHash 是**互逆**的（两处各写一份拼法必然漂移）', () => {
    for (const id of ['tmdb:1396', 'tmdb:1', 'weird/id', 'a b']) {
      expect(parseShellHash(mediaItemHref(id)).mediaWorkId).toBe(id)
    }
  })

  it('畸形百分号编码 → mediaWorkId 降级为 null（落回列表页，不炸整个外壳）', () => {
    const r = parseShellHash('#/media/%zz')
    expect(r.tab).toBe('media')
    expect(r.mediaWorkId).toBeNull()
  })

  // 🔴 两个 id 空间的隔离：libraryId 是旧 series.id、mediaWorkId 是 works.id。
  // 今天字面都长成 'tmdb:<n>'，但 series 表 0 行、works 表 110 行——不是同一张表的同一行。
  it('#/media/:id **不**污染 libraryId / movieId', () => {
    const r = parseShellHash('#/media/tmdb%3A1396')
    expect(r.libraryId).toBeNull()
    expect(r.movieId ?? null).toBeNull()
    expect(r.page).toBeUndefined()
  })

  it('#/library/:id **不**污染 mediaWorkId（反向）', () => {
    const r = parseShellHash('#/library/tmdb%3A123')
    expect(r.libraryId).toBe('tmdb:123')
    expect(r.mediaWorkId ?? null).toBeNull()
  })

  it('两个 href 助手产出不同前缀（合并成一个就会把两个 id 空间焊死）', () => {
    expect(mediaItemHref('tmdb:1')).toBe('#/media/tmdb%3A1')
    expect(libraryItemHref({ kind: 'series', libraryId: 'tmdb:1' })).toBe('#/library/tmdb%3A1')
  })
})
