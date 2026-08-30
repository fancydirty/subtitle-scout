// src/v2/subtitleTargets.ts —— 活动卡覆盖格的 per-target key/label 派生。
// key 与 findSubtitleWorkerTask.ts 的 itemId 尾段（`/s{season}e{episode}`）刻意同构，
// 这样 report 桶（installed/no_safe_match/retry_later，itemId 形如 workId/s1e2）能按尾段
// 反解回格子，无需第二套解析。
export function targetKey(_workId: string, season: number | null, episode: number | null): string {
  return season != null && episode != null ? `s${season}e${episode}` : 'movie'
}

/** 展示标签：S01E02（补零两位）；电影无标签（格子退化成丸，标签空）。 */
export function targetLabel(season: number | null, episode: number | null): string {
  if (season == null || episode == null) return ''
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
}

/** 单文件（电影）形态：覆盖格退化成一枚状态丸。 */
export function isSingleFile(fileCount: number): boolean {
  return fileCount <= 1
}

/** report 桶里的 itemId（workId/s1e2 或纯 workId）→ 格子 key。尾段有 /sXeY 取之，否则 movie。 */
export function itemIdToKey(itemId: string): string {
  const m = /\/(s\d+e\d+)$/.exec(itemId)
  return m ? m[1] : 'movie'
}
