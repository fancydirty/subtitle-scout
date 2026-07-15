// 去 Jellyfin 化战役 P2（design: docs/design/2026-07-16-de-jellyfin-design.md §P2）：
// 自有 id 空间的唯一构造/解析入口。series/movies.id = 'tmdb:<TMDB id>'；
// episodes.id = 'tmdb:<TMDB id>/s<N>e<M>'（无零填充——s1e2，非 s01e02）。
// id 即身份：库行 id 本身就能换回 TMDB id，不再需要 jf.getItem 这类"拿 id 换身份"的缝。
// 命名锁定给下游消费：T3 摄取层用 seriesId/episodeId 写行；T5 orchestrator 缝、T7 realign
// port 用 tmdbIdFromOwnId 读行——三处都复用这里，不允许各写各的解析逻辑。

/** series/movies 的自有主键：tmdb:<id>（TMDB id 原样嵌入，不做零填充/格式化）。 */
export function seriesId(tmdbId: string): string {
  return `tmdb:${tmdbId}`
}

/** episodes 的自有主键：tmdb:<id>/s<N>e<M>（无零填充，如 s1e2，非 s01e02）。 */
export function episodeId(tmdbId: string, season: number, episode: number): string {
  return `tmdb:${tmdbId}/s${season}e${episode}`
}

// episodes 形状先匹配（更具体），否则 series 形状的宽松 [^/]+ 会拒绝任何带 '/' 的输入，
// 两个正则互斥不会误判。
const EPISODE_ID_RE = /^tmdb:([^/]+)\/s\d+e\d+$/
const SERIES_ID_RE = /^tmdb:([^/]+)$/

/**
 * 从自有 id 的任一形状提取 TMDB id：series/movies 的 'tmdb:<id>' 或 episodes 的
 * 'tmdb:<id>/s<N>e<M>'。非本形状（如遗留合成 id 'self-scan-trigger'、空串、格式错误）
 * 返回 null，不抛错——调用方拿到 null 按"非自有 id"分支处理，不该整个工具因为一个
 * 意外形状的 id 而崩溃。
 */
export function tmdbIdFromOwnId(ownId: string): string | null {
  const episodeMatch = ownId.match(EPISODE_ID_RE)
  if (episodeMatch) return episodeMatch[1]
  const seriesMatch = ownId.match(SERIES_ID_RE)
  if (seriesMatch) return seriesMatch[1]
  return null
}
