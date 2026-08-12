// web/src/media/route.media.test.ts：#/media 二级路由 + 与**旧** library 路由的隔离。
//
// 这个文件存在的理由是 Task ⑧ 引入了第二个"tab + id"形态的路由。两个已知的静默失效：
//  ① mediaWorkId 落在旧的 libraryId 上（两个 id 空间混用）→ 媒体库详情页会拿旧端点的 id
//     去打新端点，或者反过来。TS 管不到（两个都是 string|null）。
//  ② 在 #/media 上误命中 library 的解析分支 → 媒体库详情页永远渲染列表。
//
// ── Task ⑪ 后这两条的形态变了（但一条都没放松）────────────────────────────────
// 旧 library 页面已移入 `_legacy/`，`ShellRoute` 上的 `libraryId`/`movieId`/`page` 三个
// 字段随之删除，`#/library*` 由 `LEGACY_REDIRECTS` **改写到 `#/media` 并丢弃 id 段**。
// 于是 ① 的判据从"别落到隔壁字段上"升级为**更硬的一条**：旧 hash 的 id 段必须
// **压根不出现在 route 上**。这才是真正要防的事——旧 `series.id` 与新 `works.id` 字面都长
// 成 `tmdb:<n>`，若改写时把 id 带过去，媒体库详情页就会拿 series 的 id 去打 works 的端点，
// 三种结局（正常/404/**显示另一部剧**）全都不报错。
import { describe, it, expect } from 'vitest'
import { parseShellHash, mediaItemHref } from '../shell/route.js'

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

  // 🔴 两个 id 空间的隔离：旧 series.id vs 新 works.id。今天字面都长成 'tmdb:<n>'，
  // 但 series 表 0 行、works 表 110 行——不是同一张表的同一行。
  it('#/media/:id 只落在 mediaWorkId 上（route 上再无第二个 id 字段可污染）', () => {
    const r = parseShellHash('#/media/tmdb%3A1396')
    expect(r.mediaWorkId).toBe('tmdb:1396')
    // Task ⑪ 起 ShellRoute 只剩 tab + mediaWorkId 两个键。多出任何一个 id 字段都意味着
    // 有人把旧的 libraryId/movieId/page 捞了回来——那正是两个 id 空间焊死的第一步。
    expect(Object.keys(r).sort()).toEqual(['mediaWorkId', 'tab'])
  })

  // 🔴🔴 Task ⑪ 的核心隔离条：旧 hash **改写到 #/media 列表，id 段必须被丢弃**。
  // 带着旧 series.id 转过去 = 拿它打 works 端点 = 静默串页（可能显示另一部剧）。
  it('旧 #/library/:id 改写到 #/media 列表，**id 段不带过去**（不许串页）', () => {
    for (const h of ['#/library/tmdb%3A123', '#/library/movies/tmdb%3A99', '#/library']) {
      const r = parseShellHash(h)
      expect(r.tab, `${h} 该落到 media`).toBe('media')
      expect(r.mediaWorkId ?? null, `${h} 把旧 id 带进了 mediaWorkId——静默串页`).toBeNull()
    }
  })

  it('旧 #/workflow 改写到活动页（不是 media，也不是兜底）', () => {
    expect(parseShellHash('#/workflow').tab).toBe('activity')
  })

  it('mediaItemHref 与 parseShellHash 互逆，且旧 library 拼址**不可能**产出 #/media', () => {
    expect(mediaItemHref('tmdb:1')).toBe('#/media/tmdb%3A1')
    // 旧海报卡的拼址函数已随页面搬到 `_legacy/library/legacyHref.ts`，它自己的测试也在
    // 那个目录里（`legacyHref.test.ts`）——**本文件刻意不 import 它**：活代码区（含测试）
    // 一旦依赖 `_legacy/`，`_legacy` 就删不掉，而 legacyIsolation.test.ts 的"全域方向铁律"
    // 那条会红。这里只钉住"新拼址产出的前缀"，旧的那半由上面的改写用例负责。
    expect(mediaItemHref('tmdb:1').startsWith('#/media/')).toBe(true)
  })
})
