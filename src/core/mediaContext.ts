import { basename, dirname, resolve, sep } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'
import { MediaContextSchema, type MediaContext } from './schemas.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'

export interface PathMapping { from: string; to: string }

export function parsePathMappings(raw: string | undefined): PathMapping[] {
  if (!raw) return []
  return raw.split(',').filter(Boolean).map(pair => {
    const [from, to] = pair.split('=')
    if (!from || !to) throw new Error(`invalid MEDIA_PATH_MAPPINGS pair: ${pair}`)
    return { from, to }
  })
}

export function mapPath(path: string, mappings: PathMapping[]): string {
  // 最长前缀优先，避免 /media 抢了 /media/movies 的活
  const hit = [...mappings].sort((a, b) => b.from.length - a.from.length)
    .find(m => path.startsWith(m.from))
  return hit ? hit.to + path.slice(hit.from.length) : path
}

const TICKS_PER_MINUTE = 600_000_000

export function buildMediaContext(
  item: JellyfinItem,
  mappings: PathMapping[],
  enrichment: { chineseTitle?: string | null } = {},
): MediaContext {
  if (!item.Path) throw new Error(`jellyfin item ${item.Id} has no Path`)
  const path = mapPath(item.Path, mappings)
  const isEpisode = item.Type === 'Episode'
  const title = isEpisode ? (item.SeriesName ?? item.Name) : item.Name
  const alternative_titles = [enrichment.chineseTitle]
    .filter((t): t is string =>
      !!t && t.trim().length > 0 && t !== title && t !== item.OriginalTitle)
  return MediaContextSchema.parse({
    request_id: `jf-${item.Id}-${Date.now()}`,
    trigger: 'playback_start',
    media: {
      type: isEpisode ? 'episode' : 'movie',
      path,
      filename: basename(path),
      title,
      original_title: item.OriginalTitle ?? null,
      year: item.ProductionYear ?? null,
      season: item.ParentIndexNumber ?? null,
      episode: item.IndexNumber ?? null,
      runtime_minutes: item.RunTimeTicks ? Math.round(item.RunTimeTicks / TICKS_PER_MINUTE) : null,
      provider_ids: Object.fromEntries(
        Object.entries(item.ProviderIds ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      production_locations: item.ProductionLocations ?? [],
      alternative_titles,
      overview: item.Overview ?? null,
      existing_subtitles: (item.MediaStreams ?? [])
        .filter(s => s.Type === 'Subtitle')
        .map(s => ({
          language: s.Language ?? 'und',
          format: s.Codec ?? 'unknown',
          source: s.IsExternal ? 'external' : 'embedded',
        })),
    },
    preferences: {},
  })
}

export function mediaDir(ctx: MediaContext): string {
  return dirname(ctx.media.path)
}

/** path 是否位于任一 root 之下（或恰为 root）。roots 为空 → 视为不限制，返回 true */
export function isUnderRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true
  const p = resolve(path)
  return roots.some(r => {
    const root = resolve(r)
    return p === root || p.startsWith(root + sep)
  })
}

let writeProbeCounter = 0

/**
 * 目录是否可写:在 dir 下真实试写一个隐藏临时文件再删除。成功→true,任何异常→false
 * (目录不存在也会因写失败返回 false)。不用 fs.access(W_OK)——网络挂载(WebDAV/rclone/CIFS)
 * 上 W_OK 会撒谎,且容器内 root 会绕过权限位;真实试写走 sidecar 将来同一条写路径,是唯一可信信号。
 */
export function isDirWritable(dir: string): boolean {
  const probe = resolve(dir, `.subtitle-scout-writetest-${process.pid}-${writeProbeCounter++}`)
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    try { unlinkSync(probe) } catch { /* 写失败时无残留;写成功删失败的边界尽力清理 */ }
    return false
  }
}
