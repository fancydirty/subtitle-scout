import { dirname, basename } from 'node:path'
import { isChineseOrigin, usableChineseSubtitleStreams } from '../daemon/triggers.js'
import { mapPath, type PathMapping } from '../core/mediaContext.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'
import type { LibraryRepo, SubStatus } from './libraryRepo.js'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']
// Language tags that indicate Chinese subtitles (from triggers.ts CHINESE_LANG_TAGS pattern)
const CHINESE_TAGS = ['zh-Hans', 'zh-Hant', 'zh', 'chs', 'cht', 'chi', 'zho']

function hasExternalChineseSidecar(
  videoPath: string,
  fileExists: (path: string) => boolean
): boolean {
  const dir = dirname(videoPath)
  const videoBase = basename(videoPath).replace(/\.[^.]+$/, '')

  for (const tag of CHINESE_TAGS) {
    for (const ext of SUBTITLE_EXTS) {
      const sidecarPath = `${dir}/${videoBase}.${tag}${ext}`
      if (fileExists(sidecarPath)) {
        return true
      }
    }
  }
  return false
}

export function classifyItem(
  item: JellyfinItem,
  deps: {
    fileExists: (path: string) => boolean
    mappings: PathMapping[]
    skipChineseOrigin: boolean
  }
): SubStatus {
  // 1. Chinese origin → ignored (if skipChineseOrigin is true)
  if (deps.skipChineseOrigin && isChineseOrigin(item)) {
    return 'ignored'
  }

  // 2. 中字轨按 IsExternal 分流：Jellyfin FullRefresh 会把盘上的外挂字幕收进
  //    MediaStreams（IsExternal=true）——那是 sidecar（scout 战果或用户手动放置），
  //    归 covered；只有 IsExternal 为 falsy 的才是真内嵌。两者都有时 covered 优先
  //    （外挂展示价值更高）。
  const zhTracks = usableChineseSubtitleStreams(item, true)
  if (zhTracks.some(s => s.IsExternal === true)) {
    return 'covered'
  }
  if (zhTracks.length > 0) {
    return 'embedded'
  }

  // 3. Has external sidecar on disk → covered
  if (item.Path) {
    const mappedPath = mapPath(item.Path, deps.mappings)
    if (hasExternalChineseSidecar(mappedPath, deps.fileExists)) {
      return 'covered'
    }
  }

  // 4. Otherwise → missing
  return 'missing'
}

export async function scanLibrary(
  jf: Pick<PlayerServer, 'getItemsPage'>,
  lib: LibraryRepo,
  opts: {
    pageSize: number
    fileExists: (path: string) => boolean
    mappings: PathMapping[]
    skipChineseOrigin: boolean
    now?: number
  }
): Promise<void> {
  const now = opts.now ?? Date.now()
  let startIndex = 0

  while (true) {
    const items = await jf.getItemsPage(startIndex, opts.pageSize)
    if (items.length === 0) break

    for (const item of items) {
      const newStatus = classifyItem(item, {
        fileExists: opts.fileExists,
        mappings: opts.mappings,
        skipChineseOrigin: opts.skipChineseOrigin,
      })

      if (item.Type === 'Episode') {
        if (!item.SeriesId) {
          console.warn(`Episode without SeriesId: ${item.Id} (${item.Name})`)
          continue
        }

        // Upsert series first (dedupe by id)——只要有 SeriesId 就必须建 series 行，
        // 否则刮削残缺（无 SeriesName）的 Episode 会触发 FK 违例卡死整轮 scan。
        lib.upsertSeries({
          id: item.SeriesId,
          name: item.SeriesName ?? item.SeriesId,
          posterTag: item.SeriesPrimaryImageTag ?? null,
        })

        // Preserve unavailable only if reality still says missing
        // covered/embedded/ignored/missing are reality checks that overwrite unavailable
        // But if reality says missing and DB says unavailable, keep unavailable
        const existing = lib.getEpisode(item.Id)
        let statusToWrite = newStatus

        if (existing?.sub_status === 'unavailable' && newStatus === 'missing') {
          statusToWrite = 'unavailable'
        }

        lib.upsertEpisode({
          id: item.Id,
          seriesId: item.SeriesId,
          season: item.ParentIndexNumber ?? 0,
          episode: item.IndexNumber ?? 0,
          name: item.Name,
          path: item.Path ?? '',
          subStatus: statusToWrite,
        })
      } else if (item.Type === 'Movie') {
        // Preserve unavailable only if reality still says missing
        const existing = lib.getMovie(item.Id)
        let statusToWrite = newStatus

        if (existing?.sub_status === 'unavailable' && newStatus === 'missing') {
          statusToWrite = 'unavailable'
        }

        lib.upsertMovie({
          id: item.Id,
          name: item.Name,
          path: item.Path ?? '',
          subStatus: statusToWrite,
          posterTag: item.ImageTags?.Primary ?? null,
          year: item.ProductionYear ?? null,
          providerIds: item.ProviderIds
            ? JSON.stringify(item.ProviderIds)
            : null,
        })
      }
    }

    startIndex += opts.pageSize
  }

  // Write last_scan_at
  lib.db
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('last_scan_at', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(String(now))
}
