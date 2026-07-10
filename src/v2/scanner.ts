import { dirname, basename } from 'node:path'
import { isChineseOrigin, isChineseLang, looksChineseTitle, usableChineseSubtitleStreams } from '../daemon/triggers.js'
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
    originLang?: string | null
  }
): SubStatus {
  // 0. 国产（TMDB original_language=zh）→ ignored（先于一切，权威信号）
  if (deps.skipChineseOrigin && isChineseLang(deps.originLang)) {
    return 'ignored'
  }
  // 1. 兜底：无 TMDB 信号（originLang 未解析）时，用 ProductionLocations 猜国产
  if (deps.skipChineseOrigin && deps.originLang == null && isChineseOrigin(item)) {
    return 'ignored'
  }
  // 1b. 兜底：无 TMDB 信号时，用剧集标题字符启发式（汉字且无假名无谚文，排除日番/韩剧）
  if (
    deps.skipChineseOrigin &&
    deps.originLang == null &&
    looksChineseTitle(item.SeriesName ?? item.OriginalTitle)
  ) {
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

/** TMDB origin_lang 解析器：拿到就返回小写 language code，拿不到（无 TMDB/未匹配/请求失败）返回 null——增益路径，绝不阻塞主流程。 */
export interface OriginResolver {
  originFor: (item: JellyfinItem) => Promise<string | null>
}

export async function scanLibrary(
  jf: Pick<PlayerServer, 'getItemsPage'>,
  lib: LibraryRepo,
  opts: {
    pageSize: number
    fileExists: (path: string) => boolean
    mappings: PathMapping[]
    skipChineseOrigin: boolean
    resolver?: OriginResolver
    now?: number
  }
): Promise<void> {
  const now = opts.now ?? Date.now()
  let startIndex = 0

  while (true) {
    const items = await jf.getItemsPage(startIndex, opts.pageSize)
    if (items.length === 0) break

    for (const item of items) {
      if (item.Type === 'Episode') {
        if (!item.SeriesId) {
          console.warn(`Episode without SeriesId: ${item.Id} (${item.Name})`)
          continue
        }

        // Upsert series first (dedupe by id)——只要有 SeriesId 就必须建 series 行，
        // 否则刮削残缺（无 SeriesName）的 Episode 会触发 FK 违例卡死整轮 scan。
        // 必须先于 origin 解析/分类：origin 缓存写回 series 行，行不存在则 UPDATE 是空操作。
        lib.upsertSeries({
          id: item.SeriesId,
          name: item.SeriesName ?? item.SeriesId,
          posterTag: item.SeriesPrimaryImageTag ?? null,
        })

        // origin_lang：先读缓存，缺失且有 resolver 才回查一次并写回（同系列后续集直接命中缓存）。
        let originLang = lib.getSeriesOriginLang(item.SeriesId)
        if (originLang == null && opts.resolver) {
          const resolved = await opts.resolver.originFor(item)
          if (resolved != null) {
            lib.setSeriesOriginLang(item.SeriesId, resolved)
            originLang = resolved
          }
        }

        const newStatus = classifyItem(item, {
          fileExists: opts.fileExists,
          mappings: opts.mappings,
          skipChineseOrigin: opts.skipChineseOrigin,
          originLang,
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
        // origin_lang：先读缓存，缺失且有 resolver 才回查一次；但 movies 行可能是本轮才新建
        // （不像 series 先于 episode 分类而存在），setMovieOriginLang 的 UPDATE 此刻会是空操作。
        // 解出来的值先只留在内存里参与分类，真正写回缓存推迟到 upsertMovie 之后（行必然已存在）。
        let originLang = lib.getMovieOriginLang(item.Id)
        let resolvedOriginLang: string | null = null
        if (originLang == null && opts.resolver) {
          const resolved = await opts.resolver.originFor(item)
          if (resolved != null) {
            originLang = resolved
            resolvedOriginLang = resolved
          }
        }

        const newStatus = classifyItem(item, {
          fileExists: opts.fileExists,
          mappings: opts.mappings,
          skipChineseOrigin: opts.skipChineseOrigin,
          originLang,
        })

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

        if (resolvedOriginLang != null) {
          lib.setMovieOriginLang(item.Id, resolvedOriginLang)
        }
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
