import type { ScoutDb } from './db.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { tmdbIdFromOwnId } from './ownIds.js'

/** dashboard G2：三层格阵第一层——TMDB 应有集缓存（tmdb_seasons，db.ts v12）。
 *  刷新节奏是"惰性 + TTL 门"：调用方（ingest 新剧 enrich 后、未来 G5 的 API 读时过期触发）
 *  无脑调用即可，门本身挡掉 7 天内的重复拉取，不需要调用方自己记着上次刷了没。 */
export const CATALOG_TTL_MS = 7 * 86_400_000

/** 拉季表 + 逐季集标题写 tmdb_seasons。TTL 门：该 series 已有缓存行且最近一次 fetched_at
 *  距 now 未过 CATALOG_TTL_MS → 直接返回，不发任何 TMDB 请求（惰性触发点因此可以无脑调用）。
 *
 *  gain-path 降级（宁可陈旧不可清空）：seriesId 不是本形状的自有 id、getSeasonTable
 *  返回 null/抛错、或任一季的 getSeasonEpisodes 返回 null/抛错，一律原样返回、旧缓存纹丝不动
 *  ——只有拿到全部季的完整数据后，才在单事务里 DELETE 旧行 + INSERT 新行，绝不出现"部分季已经
 *  刷新、部分季还是上一轮"的半新半旧缓存。season 0（特典季）TMDB 季表若含则照样收进来——存不存
 *  是 getSeasonTable 自己的既有过滤（它已经滤掉 season_number<=0，即 tmdb_seasons 实际上不会
 *  出现 season 0 行；这条规矩来自季表本身，不是本函数额外加的判断），本层只负责把权威数据原样
 *  搬进缓存，不替上层做"该不该收录"的判断。 */
export async function refreshSeriesCatalog(
  db: ScoutDb,
  tmdb: Pick<TmdbClient, 'getSeasonTable' | 'getSeasonEpisodes'>,
  seriesId: string,
  now: number,
): Promise<void> {
  const latest = db
    .prepare('SELECT MAX(fetched_at) as ts FROM tmdb_seasons WHERE series_id = ?')
    .get(seriesId) as { ts: number | null }
  if (latest.ts !== null && now - latest.ts < CATALOG_TTL_MS) return

  const tmdbId = tmdbIdFromOwnId(seriesId)
  if (tmdbId === null) return // 非自有 id 形状——理论不可达（调用方总传自有 seriesId），防御性早退

  let seasonTable: Awaited<ReturnType<typeof tmdb.getSeasonTable>>
  try {
    seasonTable = await tmdb.getSeasonTable(tmdbId)
  } catch {
    return
  }
  if (!seasonTable) return

  const rows: { season: number; episode: number; title: string | null }[] = []
  for (const s of seasonTable) {
    let episodes: Awaited<ReturnType<typeof tmdb.getSeasonEpisodes>>
    try {
      episodes = await tmdb.getSeasonEpisodes(tmdbId, s.seasonNumber)
    } catch {
      return // 任一季失败 → 整体放弃，不留半新半旧缓存
    }
    if (!episodes) return
    for (const e of episodes) rows.push({ season: s.seasonNumber, episode: e.episode, title: e.title })
  }

  const writeRows = db.transaction(() => {
    db.prepare('DELETE FROM tmdb_seasons WHERE series_id = ?').run(seriesId)
    const insert = db.prepare(
      'INSERT INTO tmdb_seasons (series_id, season, episode, title, fetched_at) VALUES (?, ?, ?, ?, ?)'
    )
    for (const r of rows) insert.run(seriesId, r.season, r.episode, r.title, now)
  })
  writeRows()
}

/** 纯同步读——三层格阵第一层的呈现来源，按 episode 升序。无缓存行的季返回 []（不区分
 *  "从未刷新过"与"该季确实没有集"，呈现层要问"这剧到底刷新过没有"应看 fetched_at，不是这里）。 */
export function canonicalEpisodes(
  db: ScoutDb,
  seriesId: string,
  season: number,
): { episode: number; title: string | null }[] {
  return db
    .prepare('SELECT episode, title FROM tmdb_seasons WHERE series_id = ? AND season = ? ORDER BY episode ASC')
    .all(seriesId, season) as { episode: number; title: string | null }[]
}
