// web/src/_legacy/library/legacyHref.ts：旧海报墙的卡片拼址（`#/library/:id`、
// `#/library/movies/:id`）。
//
// ── 为什么它在这里而不在 shell/route.ts（Task ⑪）──────────────────────────────
// 它原是 `shell/route.ts` 的 `libraryItemHref`。Task ⑪ 把旧页面移入 `_legacy/` 后，它的
// **唯一调用方**（本目录的 PosterCard.tsx）也在 `_legacy` 里，而 `shell/route.ts` 是活的
// 外壳模块——把一个只服务已下架页面的拼址函数留在活模块里，等于给 `_legacy` 删除那天预留
// 一个孤儿函数（本仓病 A「谁写/谁读/谁触发缺一」的同型：删了读者不删写者）。
//
// ⚠️ **这两个 hash 今天已经不是可用路由**：`shell/route.ts` 的 LEGACY_REDIRECTS 会把
// `#/library*` 全部改写到 `#/media`（丢弃 id 段）。也就是说本函数产出的链接**点下去会落到
// 媒体库列表页**，不会打开旧详情页。这是有意的，不是 bug：
//  · 旧 library 页读 `series` 表（生产 0 行），保留它的详情路由就是把用户送进恒空页面
//    （设计文档教训十已裁决不许）；
//  · 但把这些 <a> 改成 <span> 属于**改旧页面的行为**，超出"移入 _legacy"的范围，
//    而且旧海报墙自身也已无入口（不在侧栏、不在 ⌘K、hash 被改写），改它没有收益。
// 整个目录的去留在"新页面跑满一个巡检周期"后单独裁决（设计文档 §2.2）。

/** `#/library/:id`（剧集）/ `#/library/movies/:id`（电影）。id 含冒号（`tmdb:123`），
 *  encodeURIComponent 编码。 */
export function libraryItemHref(item: { kind: 'series' | 'movie'; libraryId: string }): string {
  if (item.kind === 'movie') {
    return `#/library/movies/${encodeURIComponent(item.libraryId)}`
  }
  return `#/library/${encodeURIComponent(item.libraryId)}`
}
