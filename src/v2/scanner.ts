import { isChineseOrigin, looksChineseTitle, usableChineseSubtitleStreams } from '../daemon/triggers.js'
import { mapPath, type PathMapping } from '../core/mediaContext.js'
import { tagsForLanguage, langOf } from '../agent/languages.js'
import { findExternalSidecar, type SubtitleLanguage } from '../files/sidecar.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'
import type { LibraryRepo, SubStatus } from './libraryRepo.js'

export type { SubtitleLanguage }

/** scan-time sidecar adoption 的 subtitles.source 取值：复用 executor.ts 里 pipeline
 *  already_exists 决策对应的 'preexisting'（而不是新增一个值）——语义完全等价：磁盘上有一份
 *  字幕文件，但不是"这次运行写的"，只是这次运行（scan 或 pipeline）第一次观测到它。
 *  db.ts 的 subtitles.source 是纯 TEXT 无 CHECK 约束，新增值本可以不做迁移，但两者是同一件事，
 *  没有理由分裂出第二个近义值。 */
const DISK_ADOPTION_SOURCE = 'preexisting'

// findExternalSidecar/languageForTag 的表与实现已抽到 files/sidecar.ts（去 Jellyfin 化 P3，
// design §P3）——v2/ingest.ts 复用同一份逻辑，本文件改为纯机械的 import 替换，行为零变化。

export interface ClassifyResult {
  status: SubStatus
  /** 磁盘 arm（rule 3：非 Jellyfin MediaStreams 收录、纯靠 fileExists 直接发现）命中时的
   *  真实 sidecar 路径；其余所有分支（含 rule 2 的 Jellyfin 已收录 sidecar）都是 null。
   *  scanLibrary 借此在没有 subtitles 行时补上 path/provenance 记账——见事故复盘（崩溃的
   *  执行、或用户手放文件导致 daemon 自己没记下来）。 */
  diskSidecarPath: string | null
  /** 与 diskSidecarPath 成对出现（同为 null 或同时有值）：按匹配到的 tag 换算出的语言
   *  （languageForTag/LANGUAGE_BY_TAG），供 scanLibrary 建 subtitles 行时如实标注语言，
   *  而不是不分青红皂白硬编码 zh-Hans。 */
  diskSidecarLanguage: SubtitleLanguage | null
}

export function classifyItemDetailed(
  item: JellyfinItem,
  deps: {
    fileExists: (path: string) => boolean
    mappings: PathMapping[]
    originLang?: string | null
    /**
     * 本轮 origin resolver 请求瞬时失败（TMDB 故障，非"查无数据"）。
     * 仅压制 rule 1b 的标题启发式：失败窗口内我们明知下轮 scan 就能拿到权威数据，
     * 不能凭粗糙启发式先把中文化命名的外国剧打成 ignored。ProductionLocations（rule 1）
     * 是权威证据，不受故障影响照常生效。
     */
    originResolutionFailed?: boolean
    /**
     * A4（spec-review fix #2 拆分后）：目标字幕语言集合——驱动"覆盖检测"，即 rule 2
     * （内嵌/已收录字幕轨，中文专属实现）与 rule 3（磁盘 sidecar tag 探测，tagsForLanguage
     * 逐语言展开后 flatMap）。未传时默认 `['zh']`，与泛化前行为逐位一致。
     * 注意与 originSkipLanguages 是两个概念：这里回答"哪些语言的字幕算数"，
     * originSkipLanguages 回答"哪些原声语言的条目整个不用管"。
     */
    targetLanguages?: string[]
    /**
     * 原声跳过语言集合——驱动 rule 0 的权威跳过门（`originSkipLanguages.includes(
     * langOf(originLang))` → ignored）及其中文兜底启发式（rule 1/1b）。未传时默认取
     * targetLanguages 的生效值（正常配置下两者相同）；只有 SKIP_CHINESE_ORIGIN=false
     * 兼容路径会传一个去掉 zh 的子集——"别跳过国产内容"≠"zh 不是目标语言"，
     * 该旗标从不影响 rule 2/3 的覆盖检测（否则已有中字的条目会被判 missing 反复重抓，
     * 正是 A3 防的那个 bug）。见 cli/targetLanguages.ts 的 resolveTargetLanguages。
     */
    originSkipLanguages?: string[]
  }
): ClassifyResult {
  const targetLanguages = deps.targetLanguages ?? ['zh']
  const originSkipLanguages = deps.originSkipLanguages ?? targetLanguages

  // 0. 权威信号（TMDB original_language）→ ignored，先于一切：条目原始音轨语言本身就在
  //    原声跳过集合里，就不用为它找字幕（中文观众不需要国产剧的中文字幕；泛化后同理
  //    ——英文字幕猎人不需要英语原声剧的英文字幕）。langOf() 把 originLang 折算到与
  //    originSkipLanguages 同一套主语言码空间（agent/languages.ts）。原值缺失（null/未解析）
  //    时不参与判断，交给下面 rule 1/1b 的中文兜底 或 rule 3/4 的正常流程。
  if (deps.originLang != null && originSkipLanguages.includes(langOf(deps.originLang))) {
    return { status: 'ignored', diskSidecarPath: null, diskSidecarLanguage: null }
  }

  // 1/1b. 中文专属兜底启发式——刻意不泛化到其它语言（不发明"像法语标题""像韩语标题"这类
  //       per-language 启发式，那是错误的设计气味：ProductionLocations/标题这类信号的可靠度
  //       和可得性因语言而异，中文有汉字这个廉价高信度信号，其它语言没有对等物）。作为
  //       rule 0 权威门的兜底，这两条跟着 originSkipLanguages（不是 targetLanguages）走：
  //       只有 'zh' 在原声跳过集合里时才跑；其它语言完全依赖上面 rule 0 的权威 TMDB 信号——
  //       TMDB 数据缺失时宁可放行（漏判成本是"多查一次白跑"，远低于"该查的没查"）。
  if (originSkipLanguages.includes('zh')) {
    // 1. 兜底：无 TMDB 信号（originLang 未解析）时，用 ProductionLocations 猜国产
    if (deps.originLang == null && isChineseOrigin(item)) {
      return { status: 'ignored', diskSidecarPath: null, diskSidecarLanguage: null }
    }
    // 1b. 兜底：无 TMDB 信号时，用剧集标题字符启发式（汉字且无假名无谚文，排除日番/韩剧）。
    //     但若条目自带 ProductionLocations（权威信号）且已判定非国产（走到这里说明 rule 1
    //     未命中），该权威证据必须否决这条粗糙的标题启发式——不能让"生活大爆炸"这类中文库名
    //     的西方剧被误伤 ignored（用户永远收不到该剧的字幕，是本 gate 最差的失败模式）。
    //     只有条目完全没有 ProductionLocations（无权威信号可用）时才允许标题启发式兜底。
    //     resolver 瞬时失败（originResolutionFailed）同样压制本条：那不是"无数据"，
    //     是"数据暂时拿不到"，下轮 scan 会重试权威信号，等它。
    const hasProductionLocationSignal = (item.ProductionLocations ?? []).length > 0
    if (
      deps.originLang == null &&
      !deps.originResolutionFailed &&
      !hasProductionLocationSignal &&
      looksChineseTitle(item.SeriesName ?? item.OriginalTitle)
    ) {
      return { status: 'ignored', diskSidecarPath: null, diskSidecarLanguage: null }
    }
  }

  // 2. 中字轨检测——同样中文专属，出 A4 scope（不动它的逻辑/位置，只加 'zh' in
  //    targetLanguages 门槛）。注意：这是"覆盖检测"，跟的是 targetLanguages 而非
  //    originSkipLanguages——SKIP_CHINESE_ORIGIN=false 只弱化跳过门，绝不该让已有中字的
  //    条目被判 missing。非中文目标配置下，中文内嵌/外挂字幕轨不该被误判成"覆盖了"一个
  //    跟中文无关的目标语言。按 IsExternal 分流：Jellyfin FullRefresh
  //    会把盘上的外挂字幕收进 MediaStreams（IsExternal=true）——那是 sidecar（scout 战果或
  //    用户手动放置），归 covered；只有 IsExternal 为 falsy 的才是真内嵌。两者都有时 covered
  //    优先（外挂展示价值更高）。diskSidecarPath 留 null——这条命中的是 Jellyfin 已经收录的
  //    证据，不是 scanner 自己直接摸到磁盘发现的新文件（记账口径见 ClassifyResult 注释）。
  if (targetLanguages.includes('zh')) {
    const zhTracks = usableChineseSubtitleStreams(item, true)
    if (zhTracks.some(s => s.IsExternal === true)) {
      return { status: 'covered', diskSidecarPath: null, diskSidecarLanguage: null }
    }
    if (zhTracks.length > 0) {
      return { status: 'embedded', diskSidecarPath: null, diskSidecarLanguage: null }
    }
  }

  // 3. Has external sidecar on disk → covered。diskSidecarPath 带真实路径，供 scanLibrary
  //    在该条目尚无 subtitles 行时补记账（scan-time adoption：daemon 自己没记下来的盘上文件）。
  if (item.Path) {
    const mappedPath = mapPath(item.Path, deps.mappings)
    const targetTags = targetLanguages.flatMap(tagsForLanguage)
    const sidecar = findExternalSidecar(mappedPath, targetTags, deps.fileExists)
    if (sidecar) {
      return { status: 'covered', diskSidecarPath: sidecar.path, diskSidecarLanguage: sidecar.language }
    }
  }

  // 4. Otherwise → missing
  return { status: 'missing', diskSidecarPath: null, diskSidecarLanguage: null }
}

/** 保留原始的纯状态签名给不关心磁盘 arm 记账细节的调用方（现有测试大量依赖此形状）。 */
export function classifyItem(
  item: JellyfinItem,
  deps: Parameters<typeof classifyItemDetailed>[1]
): SubStatus {
  return classifyItemDetailed(item, deps).status
}

/**
 * TMDB origin_lang 解析器。三种结果语义严格区分：
 * - 小写 language code：解析成功；
 * - null：真·no-data（无 TMDB 引用 / TMDB 明确答复无此数据）——scanner 会负缓存哨兵，不再回查；
 * - reject（抛错）：请求瞬时失败（网络/超时/TMDB 故障）——scanner 本轮按未解析处理、
 *   不写任何缓存，下轮 scan 重试。绝不能把 reject 折叠成 null，否则一次 TMDB 故障
 *   会把故障窗口扫过的全部条目永久打成 unknown（fire-and-forget 违例）。
 */
export interface OriginResolver {
  originFor: (item: JellyfinItem) => Promise<string | null>
}

/**
 * origin_lang 缓存里代表"resolver 已经问过一次、TMDB 明确答复无数据"的哨兵值。
 *
 * 只在真·no-data（resolver 返回 null：无 TMDB 引用 / 查无此 id / 无 original_language）
 * 时写入——一旦写入就不再重试，直到有人手动清缓存（清空 origin_lang 列）。换取的是把
 * O(集数) 的每轮重复回查收敛到 O(系列数) 一次；没有实现按时间间隔过期重试（仓库目前
 * 没有可复用的"定期刷新"模式，避免为此新增基础设施）。
 * resolver 抛错（请求瞬时失败）绝不写入本哨兵：那不是"无数据"而是"暂时拿不到"，
 * 固化它会让一次 TMDB 故障永久关闭故障窗口内所有条目的权威 origin gate。
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
    resolver?: OriginResolver
    now?: number
    /** A4（见 classifyItemDetailed 同名参数注释）：目标字幕语言集合（覆盖检测，rule 2/3），
     *  透传给 classifyItemDetailed。未传时默认 `['zh']`，向后兼容——现有调用方不受影响。 */
    targetLanguages?: string[]
    /** A4 spec-review fix #2（见 classifyItemDetailed 同名参数注释）：原声跳过语言集合
     *  （rule 0/1/1b），透传。未传时默认取 targetLanguages 的生效值。 */
    originSkipLanguages?: string[]
  }
): Promise<void> {
  const now = opts.now ?? Date.now()
  let startIndex = 0
  // resolver 瞬时失败的本轮记忆（只活到本次 scanLibrary 结束）：故障窗口内同一系列
  // 只试一次，避免退化回 O(集数) 的外部调用（每次 15s 超时的话 100 集就是 25 分钟）。
  // 故意不落库——下轮 scan 从零重试，这正是"瞬时失败不留永久状态"的要求。
  const failedSeriesOrigins = new Set<string>()
  // scan 内熔断器：series 级记忆解决了"同一系列重复调用"的放大问题，但电影每部本轮只出现
  // 一次、没有重复调用可省——TMDB/Jellyfin 大范围故障时，仍是每部未解析电影各付一次
  // resolver 超时（15s/次）。用连续失败计数熔断：达到阈值后本轮剩余条目（不分电影/剧集）
  // 直接跳过 resolver，视为失败处理；同样不落库，下轮 scan 从零重试。
  const RESOLVER_CIRCUIT_BREAKER_THRESHOLD = 3
  let consecutiveResolverFailures = 0
  let resolverCircuitOpen = false

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
        // 真·查无结果（resolved==null）才写回 ORIGIN_UNKNOWN 哨兵——否则每集都会重新回查
        // TMDB/Jellyfin，100 集的剧就是每轮 scan 100 次外部调用，永不收敛（见 db.ts:97 "resolve
        // once per series" 的不变式）。分类时把哨兵换算回 null，兜底启发式仍然逐轮生效。
        // resolver 抛错（瞬时失败）则什么都不缓存：本轮记入 failedSeriesOrigins（同系列不再重试），
        // 下轮 scan 重新回查——绝不能把一次 TMDB 故障固化成 unknown 哨兵（永久关闭权威 gate）。
        let cachedOriginLang = lib.getSeriesOriginLang(item.SeriesId)
        let originResolutionFailed = failedSeriesOrigins.has(item.SeriesId)
        if (cachedOriginLang == null && opts.resolver && !originResolutionFailed) {
          if (resolverCircuitOpen) {
            // 熔断已开：本轮不再花时间等 resolver，直接按失败处理（不缓存，下轮重试）。
            originResolutionFailed = true
            failedSeriesOrigins.add(item.SeriesId)
          } else {
            try {
              const resolved = await opts.resolver.originFor(item)
              cachedOriginLang = resolved ?? ORIGIN_UNKNOWN
              lib.setSeriesOriginLang(item.SeriesId, cachedOriginLang)
              consecutiveResolverFailures = 0
            } catch (e) {
              originResolutionFailed = true
              failedSeriesOrigins.add(item.SeriesId)
              console.warn(`origin resolution failed for series ${item.SeriesId} (${item.SeriesName ?? item.SeriesId}): degraded origin gate this scan (retry next scan) — ${e instanceof Error ? e.message : String(e)}`)
              consecutiveResolverFailures++
              if (consecutiveResolverFailures >= RESOLVER_CIRCUIT_BREAKER_THRESHOLD && !resolverCircuitOpen) {
                resolverCircuitOpen = true
                console.warn(`origin resolver: ${consecutiveResolverFailures} consecutive failures this scan — circuit breaker open, skipping resolver for remaining items (retry next scan)`)
              }
            }
          }
        }

        const { status: newStatus, diskSidecarPath, diskSidecarLanguage } = classifyItemDetailed(item, {
          fileExists: opts.fileExists,
          mappings: opts.mappings,
          originLang: resolvedOriginForClassification(cachedOriginLang),
          originResolutionFailed,
          targetLanguages: opts.targetLanguages,
          originSkipLanguages: opts.originSkipLanguages,
        })

        // Preserve unavailable only if reality still says missing;
        // covered/embedded/ignored/missing are reality checks that overwrite it.
        const existing = lib.getEpisode(item.Id)
        let statusToWrite = newStatus

        if (newStatus === 'missing' && existing?.sub_status === 'unavailable') {
          statusToWrite = existing.sub_status
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

        // scan-time sidecar adoption：磁盘 arm 直接发现的 sidecar，且该条目尚无 subtitles
        // 行时，把 path/provenance 记账补上——否则崩溃的执行/用户手放文件永久丢账（见事故复盘）。
        // language 按匹配到的 CHINESE_TAGS tag 换算（diskSidecarLanguage），如实标注简/繁，
        // 不再不分青红皂白硬编码 zh-Hans。
        if (diskSidecarPath && !lib.hasSubtitleRecord(item.Id)) {
          lib.markCovered(item.Id, diskSidecarPath, DISK_ADOPTION_SOURCE, undefined, diskSidecarLanguage ?? 'zh-Hans')
        }
      } else if (item.Type === 'Movie') {
        // origin_lang：先读缓存，缺失且有 resolver 才回查一次；但 movies 行可能是本轮才新建
        // （不像 series 先于 episode 分类而存在），setMovieOriginLang 的 UPDATE 此刻会是空操作。
        // 解出来的值先只留在内存里参与分类，真正写回缓存推迟到 upsertMovie 之后（行必然已存在）。
        // 真·查无结果（resolved==null）才缓存 ORIGIN_UNKNOWN 哨兵，避免同一部电影每轮 scan
        // 都重新回查（root cause 与 series 分支一致，见上）。resolver 抛错（瞬时失败）则
        // 什么都不缓存，下轮 scan 重试（电影每轮只出现一次，无需本轮失败记忆）。
        let cachedOriginLang = lib.getMovieOriginLang(item.Id)
        let originLangToCache: string | null = null
        let originResolutionFailed = false
        if (cachedOriginLang == null && opts.resolver) {
          if (resolverCircuitOpen) {
            // 熔断已开：跳过 resolver，按失败处理（不缓存，下轮重试）。
            originResolutionFailed = true
          } else {
            try {
              const resolved = await opts.resolver.originFor(item)
              cachedOriginLang = resolved ?? ORIGIN_UNKNOWN
              originLangToCache = cachedOriginLang
              consecutiveResolverFailures = 0
            } catch (e) {
              originResolutionFailed = true
              console.warn(`origin resolution failed for movie ${item.Id} (${item.Name}): degraded origin gate this scan (retry next scan) — ${e instanceof Error ? e.message : String(e)}`)
              consecutiveResolverFailures++
              if (consecutiveResolverFailures >= RESOLVER_CIRCUIT_BREAKER_THRESHOLD && !resolverCircuitOpen) {
                resolverCircuitOpen = true
                console.warn(`origin resolver: ${consecutiveResolverFailures} consecutive failures this scan — circuit breaker open, skipping resolver for remaining items (retry next scan)`)
              }
            }
          }
        }

        const { status: newStatus, diskSidecarPath, diskSidecarLanguage } = classifyItemDetailed(item, {
          fileExists: opts.fileExists,
          mappings: opts.mappings,
          originLang: resolvedOriginForClassification(cachedOriginLang),
          originResolutionFailed,
          targetLanguages: opts.targetLanguages,
          originSkipLanguages: opts.originSkipLanguages,
        })

        // Preserve unavailable only if reality still says missing (mirrors episode branch above)
        const existing = lib.getMovie(item.Id)
        let statusToWrite = newStatus

        if (newStatus === 'missing' && existing?.sub_status === 'unavailable') {
          statusToWrite = existing.sub_status
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

        // scan-time sidecar adoption（mirrors episode branch above，含 language 换算）
        if (diskSidecarPath && !lib.hasSubtitleRecord(item.Id)) {
          lib.markCovered(item.Id, diskSidecarPath, DISK_ADOPTION_SOURCE, undefined, diskSidecarLanguage ?? 'zh-Hans')
        }

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
