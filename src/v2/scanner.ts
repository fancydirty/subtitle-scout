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
  // 1b. 兜底：无 TMDB 信号时，用剧集标题字符启发式（汉字且无假名无谚文，排除日番/韩剧）。
  //     但若条目自带 ProductionLocations（权威信号）且已判定非国产（走到这里说明 rule 1
  //     未命中），该权威证据必须否决这条粗糙的标题启发式——不能让"生活大爆炸"这类中文库名
  //     的西方剧被误伤 ignored（用户永远收不到该剧的字幕，是本 gate 最差的失败模式）。
  //     只有条目完全没有 ProductionLocations（无权威信号可用）时才允许标题启发式兜底。
  const hasProductionLocationSignal = (item.ProductionLocations ?? []).length > 0
  if (
    deps.skipChineseOrigin &&
    deps.originLang == null &&
    !hasProductionLocationSignal &&
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

/**
 * origin_lang 缓存里代表"resolver 已经问过一次、但没问出结果"的哨兵值。
 *
 * 权衡：不区分"这个系列 TMDB 永远查不到"和"这次刚好查不到、以后可能查到"——
 * 一旦写入 'unknown' 就不再重试，直到有人手动清缓存（清空 origin_lang 列）。
 * 换取的是把 O(集数) 的每轮重复回查收敛到 O(系列数) 一次；没有实现按时间间隔
 * 过期重试（仓库目前没有可复用的"定期刷新"模式，避免为此新增基础设施）。
 * 分类时必须把该哨兵值当 null 处理（见 classifyItem 调用处），否则会误伤
 * rule 1 / rule 1b 的兜底启发式。
 */
const ORIGIN_UNKNOWN = 'unknown'

/** 把 origin_lang 缓存读数换算成 classifyItem 能理解的值：哨兵 'unknown' 视同未解析（null）。 */
function resolvedOriginForClassification(cached: string | null): string | null {
  return cached === ORIGIN_UNKNOWN ? null : cached
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
        // 查不出结果（resolved==null）也要写回 ORIGIN_UNKNOWN 哨兵——否则每集都会重新回查
        // TMDB/Jellyfin，100 集的剧就是每轮 scan 100 次外部调用，永不收敛（见 db.ts:97 "resolve
        // once per series" 的不变式）。分类时把哨兵换算回 null，兜底启发式仍然逐轮生效。
        let cachedOriginLang = lib.getSeriesOriginLang(item.SeriesId)
        if (cachedOriginLang == null && opts.resolver) {
          const resolved = await opts.resolver.originFor(item)
          cachedOriginLang = resolved ?? ORIGIN_UNKNOWN
          lib.setSeriesOriginLang(item.SeriesId, cachedOriginLang)
        }

        const newStatus = classifyItem(item, {
          fileExists: opts.fileExists,
          mappings: opts.mappings,
          skipChineseOrigin: opts.skipChineseOrigin,
          originLang: resolvedOriginForClassification(cachedOriginLang),
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
        // 查不出结果（resolved==null）也要缓存 ORIGIN_UNKNOWN 哨兵，避免同一部电影每轮 scan
        // 都重新回查（root cause 与 series 分支一致，见上）。
        let cachedOriginLang = lib.getMovieOriginLang(item.Id)
        let originLangToCache: string | null = null
        if (cachedOriginLang == null && opts.resolver) {
          const resolved = await opts.resolver.originFor(item)
          cachedOriginLang = resolved ?? ORIGIN_UNKNOWN
          originLangToCache = cachedOriginLang
        }

        const newStatus = classifyItem(item, {
          fileExists: opts.fileExists,
          mappings: opts.mappings,
          skipChineseOrigin: opts.skipChineseOrigin,
          originLang: resolvedOriginForClassification(cachedOriginLang),
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

        if (originLangToCache != null) {
          lib.setMovieOriginLang(item.Id, originLangToCache)
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
