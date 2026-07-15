import { existsSync, statSync } from 'node:fs'
import { looksChineseTitle } from '../daemon/triggers.js'
import { tagsForLanguage, langOf } from '../agent/languages.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { walkVideoFiles } from '../daemon/selfScan.js'
import { seriesId, episodeId } from './ownIds.js'
import type { ScoutDb } from './db.js'
import type { LibraryRepo, SubStatus } from './libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { Recognized, Park } from '../recognition/index.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'

/**
 * 去 Jellyfin 化 P3（design: docs/design/2026-07-16-de-jellyfin-design.md §P3）的核心：
 * `FS 走盘 → recognize()（C 层）→ 覆盖探测（sidecar + 探针）→ 直写 series/episodes/movies 行`。
 * 顶替 v2/scanner.ts 的 Jellyfin API 读取整体（scanner.ts 本身留到 T4 才退役，见文件底部的
 * "分类规则移植"说明）。
 */

export interface IngestDeps {
  roots: string[]
  lib: LibraryRepo
  tmdb: TmdbClient
  /** 调用方预绑定好 tmdb + findOverride（recognition/index.ts 的 recognize 签名）。 */
  recognize: (videoPath: string) => Promise<Recognized | Park>
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  /** 默认 daemon/selfScan.ts 导出的 walkVideoFiles（B1 的同一份遍历实现，见该文件顶部注释）。 */
  listVideoFiles?: (root: string) => string[]
  fileExists?: (p: string) => boolean
  /** 测试注入点；默认 node:fs statSync 包一层 try/catch（失败→null）。 */
  statFile?: (p: string) => { mtimeMs: number; size: number } | null
  targetLanguages: string[]
  originSkipLanguages?: string[]
  log: (msg: string) => void
  now?: () => number
}

export interface IngestResult {
  scanned: number
  upserted: number
  parked: number
  removed: number
  changed: boolean
}

/** 本轮摄取 pass 是否正在进行——目前只是一个可观察的进程内标志（无并发保护语义，T4 决定
 *  是否/如何用它做互斥）。测试断言："pass 执行期间 held=true，pass 结束（含抛错）后 held=false"。 */
export const ingestLock = { held: false }

/** origin_lang 缓存哨兵：TMDB 明确答复"无 original_language 数据"（真·no-data，含 404）时写入，
 *  区别于"从未解析过"（列为 SQL NULL）——否则每次都会重新回查同一个已经问过没有答案的 id。
 *  与 v2/scanner.ts 的同名 ORIGIN_UNKNOWN 哨兵同一套思路，各自模块私有，不共享/不导出
 *  （摄取层与 scanner.ts 各自独立演化，scanner.ts 在 T4 整体退役）。 */
const ORIGIN_UNKNOWN = 'unknown'

function decodeOriginLang(cached: string | null): string | null {
  return cached === ORIGIN_UNKNOWN ? null : cached
}

function defaultStatFile(path: string): { mtimeMs: number; size: number } | null {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return null
  }
}

interface ExistingRow {
  id: string
  kind: 'episode' | 'movie'
  seriesId: string | null
  subStatus: SubStatus
}

/** 按 path 查现有行（尚未识别，只知道路径，不知道自有 id）——LibraryRepo 没有现成的
 *  "按 path 查"方法（T2 没提供，deleteEpisodeByPath/deleteMovieByPath 只按 path 删不查），
 *  直接对 lib.db 发 SQL——与 scanner.ts 对 meta 表的既有写法同一套口径（LibraryRepo.db 是
 *  公开字段，供没有专用方法覆盖的查询直接使用）。 */
function findRowByPath(db: ScoutDb, path: string): ExistingRow | null {
  const ep = db.prepare('SELECT id, series_id, sub_status FROM episodes WHERE path = ?').get(path) as
    | { id: string; series_id: string; sub_status: SubStatus }
    | undefined
  if (ep) return { id: ep.id, kind: 'episode', seriesId: ep.series_id, subStatus: ep.sub_status }
  const mv = db.prepare('SELECT id, sub_status FROM movies WHERE path = ?').get(path) as
    | { id: string; sub_status: SubStatus }
    | undefined
  if (mv) return { id: mv.id, kind: 'movie', seriesId: null, subStatus: mv.sub_status }
  return null
}

/** CHEAP PATH 专用：只改 sub_status（+updated_at），不碰其余列——"重跑覆盖分类，不是重新摄取"。
 *  LibraryRepo 没有通用的"任意改 sub_status"方法（markCovered/markUnavailable 都是带副作用的
 *  专用写法），直接对 lib.db 发 SQL，同 findRowByPath 的既有口径。 */
function writeSubStatusOnly(db: ScoutDb, kind: 'episode' | 'movie', id: string, status: SubStatus, now: number): void {
  const table = kind === 'episode' ? 'episodes' : 'movies'
  db.prepare(`UPDATE ${table} SET sub_status = ?, updated_at = ? WHERE id = ?`).run(status, now, id)
}

/** "unavailable 复查中"的条目，若本轮重新分类算出来是 missing，不能被打回 missing——那会
 *  丢掉 find-subtitle worker 设的 recheck_after 退避窗口，让"搜索穷尽"状态机形同虚设。
 *  其余任何计算结果（covered/embedded/ignored，或本来就不是 unavailable）照常覆盖写入。
 *  移植自 v2/scanner.ts scanLibrary 的同名逻辑（技术上在 classifyItemDetailed 82-187 行范围
 *  之外，但不带走它就是行为倒退——unavailable 条目会被每轮摄取强制拉回 missing，详见 T3 报告）。 */
function resolveStatusToWrite(computed: SubStatus, priorStatus: SubStatus | null): SubStatus {
  if (computed === 'missing' && priorStatus === 'unavailable') return 'unavailable'
  return computed
}

/** rule 2（探针）memoize 前先过滤掉图形字幕轨（isImageBased，PGS/DVD/DVB/XSub——位图叠加，
 *  没法当文本比对，不算"已有可读字幕"）与无语言标签的轨——与旧 usableChineseSubtitleStreams
 *  (item, treatPgsAsMissing=true) 同一套"图形字幕不算覆盖"口径，泛化到任意目标语言。 */
function usableEmbeddedLangs(tracks: EmbeddedSubtitleTrack[]): string[] {
  return [...new Set(
    tracks.filter(t => !t.isImageBased && t.lang !== null).map(t => t.lang as string)
  )]
}

interface ClassifyInput {
  title: string
  originLang: string | null
  originResolutionFailed: boolean
  embeddedLangs: string[] | null
  path: string
  targetLanguages: string[]
  originSkipLanguages: string[]
  fileExists: (path: string) => boolean
}

/**
 * 分类规则移植自 v2/scanner.ts:82-187 `classifyItemDetailed` 的 rule 0-4（语义保持，数据源换
 * 自有——design §P3 "分类规则(原 classifyItemDetailed 的 rule 0-4)语义保持，数据源换自有"）：
 *
 * - rule 0（权威跳过门）：origin_lang 已解析且落在 originSkipLanguages 里 → ignored。数据源从
 *   Jellyfin ProductionLocations/scanner 的 OriginResolver 换成 TMDB getOriginLanguage 直填的
 *   series/movies.origin_lang 缓存列（T2 已有），判定逻辑（langOf 归一 + includes）逐字不变。
 *
 * - rule 1（ProductionLocations 国产地启发式）：**已删除，不移植**。原实现读 Jellyfin item 的
 *   ProductionLocations 字段猜国产——这是 Jellyfin 刮削器的专属元数据，没有非 Jellyfin 等价物
 *   （TMDB 详情端点没有对应的"制片地区"字段可以零成本顶替）。design 文档已预判此缺口："这条
 *   ProductionLocations 的启发式没有非 Jellyfin 等价物"，本次按其指示直接丢弃，不发明替代品
 *   （YAGNI——rule 1b 的标题启发式仍在，覆盖了绝大多数"国产剧用中文库名"的实际场景）。
 *
 * - rule 1b（标题中文启发式兜底）：origin_lang 未解析（=null，含"本轮解析瞬时失败"抑制，含
 *   "resolver 尚未确认过"）且 zh ∈ originSkipLanguages 时，looksChineseTitle(title) 命中 →
 *   ignored。原实现还有一层"若条目自带 ProductionLocations 权威信号则该信号否决标题启发式"的
 *   veto——因为 rule 1 已被删除、ProductionLocations 信号在本世界压根不存在，veto 条件恒不成立，
 *   等价于直接去掉这层 veto（不是遗漏，是原逻辑在信号源缺失后的自然坍缩）。
 *
 * - rule 2（内嵌字幕轨覆盖）：探针记忆化的 embedded_langs（原始 ffprobe tag，如 'chi'/'eng'）
 *   与 targetLanguages 展开出的 tag 集合（tagsForLanguage）取交集，非空 → 'embedded'。**与旧
 *   Jellyfin 版本的关键差异**：旧版按 MediaStreams 的 IsExternal 字段区分"内嵌"(embedded)与
 *   "Jellyfin 已收录的外挂 sidecar"(covered)，两者都命中时 covered 优先。探针
 *   （ffprobe -show_streams）只读视频容器内部的流，天生不会看到独立的 sidecar 文件——没有
 *   IsExternal 这层歧义，探针命中 = 真内嵌，直接映射 'embedded'，不复刻旧版的二选一（这是
 *   架构简化，不是语义丢失：旧版"内嵌但其实是已收录 sidecar"的中间态本就是 Jellyfin 收录时序
 *   的产物，在直连世界里不存在）。rule 2 命中即返回，不再看 rule 3（顺位与旧版一致）。
 *   探针不可用（embedded_langs 为 null）→ 本条规则不生效，直接降级到 rule 3（sidecar-only，
 *   streamProbe.ts 自己的"宁多查勿漏配"契约）。
 *
 * - rule 3（磁盘 sidecar）：findExternalSidecar（现搬到 files/sidecar.ts，见该文件头注释）按
 *   同一套 targetTags 探测磁盘 `<videoBase>.<tag>.<ext>` sidecar，命中 → 'covered'。逐字不变。
 *
 * - rule 4（兜底）：以上都不命中 → 'missing'。
 */
function classify(input: ClassifyInput): SubStatus {
  const { title, originLang, originResolutionFailed, embeddedLangs, path, targetLanguages, originSkipLanguages, fileExists } = input

  // rule 0
  if (originLang != null && originSkipLanguages.includes(langOf(originLang))) {
    return 'ignored'
  }

  // rule 1b（rule 1 已删除，见上方函数头注释）
  if (originSkipLanguages.includes('zh')) {
    if (originLang == null && !originResolutionFailed && looksChineseTitle(title)) {
      return 'ignored'
    }
  }

  const targetTags = targetLanguages.flatMap(tagsForLanguage)

  // rule 2
  if (embeddedLangs && embeddedLangs.some(lang => targetTags.includes(lang))) {
    return 'embedded'
  }

  // rule 3
  if (findExternalSidecar(path, targetTags, fileExists)) {
    return 'covered'
  }

  // rule 4
  return 'missing'
}

/** origin_lang 解析 + 缓存写回，一份实现给 series/movie 两条分支复用（回调式 setCached 屏蔽
 *  两表 setSeriesOriginLang/setMovieOriginLang 的签名差异）。已缓存（含哨兵）直接解码返回，
 *  不重新请求 TMDB——"resolve once per series/movie"是 scanner.ts 就有的不变式，这里保持。
 *  请求瞬时失败（TmdbRequestFailedError）→ 不缓存（下轮重试），返回 lang:null + failed:true，
 *  调用方据此压制 rule 1b 的标题启发式（"数据暂时拿不到"≠"确认无数据"，绝不能被兜底覆盖）。 */
async function resolveOriginLang(
  cached: string | null,
  mediaType: 'tv' | 'movie',
  tmdbId: string,
  tmdb: TmdbClient,
  setCached: (lang: string) => void,
  log: (msg: string) => void,
): Promise<{ lang: string | null; failed: boolean }> {
  if (cached != null) return { lang: decodeOriginLang(cached), failed: false }
  try {
    const resolved = await tmdb.getOriginLanguage(mediaType, tmdbId)
    setCached(resolved ?? ORIGIN_UNKNOWN)
    return { lang: resolved, failed: false }
  } catch (e) {
    log(`ingest: origin resolution failed for ${mediaType}:${tmdbId}, degraded origin gate this pass (retry next pass): ${e instanceof Error ? e.message : String(e)}`)
    return { lang: null, failed: true }
  }
}

/** 新 series/movie 行的一次性 TMDB 元数据补全（poster/year via getDetails；chinese_title 取
 *  getChineseTitles 第一条——D6：见文件底部说明，chinese_title 直接随 upsertSeries/upsertMovie
 *  的既有参数写入，不走任何单独 setter）。只在行首次创建时调用一次（调用方按"行是否已存在"
 *  门控），避免每集/每次重跑都重复两次 TMDB 请求。getDetails 失败（TmdbRequestFailedError）
 *  按 fail-soft 处理——poster/year 这类展示增益字段不该因为一次 TMDB 抖动就阻塞识别与覆盖
 *  分类这条主线（本行为与 getChineseTitles 自身已经 fail-soft 的哲学一致，tmdb.ts 全文档）。
 *  overview/runtimeMinutes 由 getDetails 一并返回但 T3 不落库——schema v9 的 series/movies 都
 *  没有对应列（3a 的 getDetails 是通用详情面，供未来消费方使用）。 */
async function enrichNewSeriesOrMovie(
  mediaType: 'tv' | 'movie',
  tmdbId: string,
  tmdb: TmdbClient,
  log: (msg: string) => void,
): Promise<{ posterPath: string | null; year: number | null; chineseTitle: string | null }> {
  let posterPath: string | null = null
  let year: number | null = null
  try {
    const details = await tmdb.getDetails(mediaType, tmdbId)
    posterPath = details?.posterPath ?? null
    year = details?.year ?? null
  } catch (e) {
    log(`ingest: getDetails failed for ${mediaType}:${tmdbId}, proceeding without poster/year this pass: ${e instanceof Error ? e.message : String(e)}`)
  }
  const zhTitles = await tmdb.getChineseTitles(mediaType, tmdbId) // 自身已 fail-soft，失败返回 []
  return { posterPath, year, chineseTitle: zhTitles[0] ?? null }
}

export function makeIngestPass(deps: IngestDeps): () => Promise<IngestResult> {
  const listVideoFiles = deps.listVideoFiles ?? walkVideoFiles
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p))
  const statFile = deps.statFile ?? defaultStatFile
  const originSkipLanguages = deps.originSkipLanguages ?? deps.targetLanguages
  const { lib, tmdb, targetLanguages, log } = deps

  return async function ingestPass(): Promise<IngestResult> {
    ingestLock.held = true
    try {
      const nowMs = deps.now ? deps.now() : Date.now()
      const result: IngestResult = { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false }
      const seenPaths = new Set<string>()

      for (const root of deps.roots) {
        for (const path of listVideoFiles(root)) {
          result.scanned++
          seenPaths.add(path)

          try {
            const stat = statFile(path)
            if (!stat) {
              log(`ingest: stat failed for ${path} (vanished mid-scan?), skipping this pass`)
              continue
            }

            const existing = findRowByPath(lib.db, path)

            // ---- CHEAP PATH：行存在 + 探针记忆化命中当前 (mtime,size) → 只重跑覆盖分类 ----
            if (existing) {
              const memo = lib.probeMemo(existing.id)
              if (memo && memo.mtime === stat.mtimeMs && memo.size === stat.size) {
                const originLangCached = existing.kind === 'episode'
                  ? (existing.seriesId ? lib.getSeriesOriginLang(existing.seriesId) : null)
                  : lib.getMovieOriginLang(existing.id)
                const title = existing.kind === 'episode'
                  ? (existing.seriesId ? (lib.getSeries(existing.seriesId)?.name ?? '') : '')
                  : (lib.getMovie(existing.id)?.name ?? '')

                const computed = classify({
                  title,
                  originLang: decodeOriginLang(originLangCached),
                  originResolutionFailed: false,
                  embeddedLangs: memo.langs,
                  path,
                  targetLanguages,
                  originSkipLanguages,
                  fileExists,
                })
                const toWrite = resolveStatusToWrite(computed, existing.subStatus)
                if (toWrite !== existing.subStatus) {
                  writeSubStatusOnly(lib.db, existing.kind, existing.id, toWrite, nowMs)
                  result.changed = true
                }
                continue
              }
            }

            // ---- FULL PATH：无行，或行存在但探针记忆化已过期 → 重新识别 + 补全 + 探测 ----
            const outcome = await deps.recognize(path)
            if ('park' in outcome) {
              lib.upsertParkedPath(path, outcome.park, nowMs)
              result.parked++
              continue
            }

            const tmdbId = outcome.tmdbId
            const title = outcome.title

            if (outcome.isTv) {
              if (outcome.episode === null) {
                // 无法构造合法的 episodeId（tmdb:<id>/s<N>e<M> 要求具体集号）——absoluteEpisode
                // 非 null 时是"只有绝对集号、缺季内集号"的番剧编号场景（旧世界靠 Jellyfin 自己的
                // 刮削器把它折算成季/集，scanner.ts 从没见过这个问题）；absoluteEpisode 也是
                // null 时是路径压根没给出任何集号信号。两种都不猜（"拿不准就不动手"），park——
                // 且刻意不清理 `existing`（若这条路径此前已经成功入库过一次）：一次识别遇挫
                // 不该把之前的可用行也搭进去，宁可留一条现在暂时对不上的旧行，也不无端丢数据。
                const reason = outcome.absoluteEpisode !== null ? 'absolute-episode-unresolved' : 'no-episode-number'
                lib.upsertParkedPath(path, reason, nowMs)
                result.parked++
                continue
              }

              // 同路径前后两轮识别出的"种类"不一致（剧集↔电影，罕见但真实可能——P6 认领可以用
              // identify_overrides 把一个先前已入库的路径重新认领成另一种 isTv）：旧行的 path
              // 仍然"被本轮看到 + fileExists 为真"，磁盘真相移除阶段的两条件永远不会命中它，
              // 放着不管就是一条永久性的错种类鬼影行。只有确认这轮要成功写新行时才清理旧行
              // （park 分支不清理，见上面的注释）。
              if (existing && existing.kind !== 'episode') {
                lib.deleteMovieByPath(path)
              }

              const season = outcome.season ?? 0
              const episode = outcome.episode
              const ownSeriesId = seriesId(tmdbId)
              const ownEpisodeId = episodeId(tmdbId, season, episode)

              const seriesExisted = lib.getSeries(ownSeriesId) !== null
              let posterPath: string | null = null
              let year: number | null = null
              let chineseTitle: string | null = null
              if (!seriesExisted) {
                const enrich = await enrichNewSeriesOrMovie('tv', tmdbId, tmdb, log)
                posterPath = enrich.posterPath
                year = enrich.year
                chineseTitle = enrich.chineseTitle
              }
              lib.upsertSeries({
                id: ownSeriesId, name: title, chineseTitle, posterPath, year,
                providerIds: JSON.stringify({ tmdb: tmdbId }),
              })

              const cachedOriginLang = lib.getSeriesOriginLang(ownSeriesId)
              const origin = await resolveOriginLang(
                cachedOriginLang, 'tv', tmdbId, tmdb,
                (lang) => lib.setSeriesOriginLang(ownSeriesId, lang), log,
              )

              const tracks = await deps.probe(path)
              const embeddedLangs = tracks === null ? null : usableEmbeddedLangs(tracks)

              const priorEpisode = lib.getEpisode(ownEpisodeId)
              const computed = classify({
                title, originLang: origin.lang, originResolutionFailed: origin.failed,
                embeddedLangs, path, targetLanguages, originSkipLanguages, fileExists,
              })
              const toWrite = resolveStatusToWrite(computed, priorEpisode?.sub_status ?? null)

              lib.upsertEpisode({
                id: ownEpisodeId, seriesId: ownSeriesId, season, episode,
                // TMDB 搜索命中只给到剧级标题，没有单集标题（旧版 item.Name 来自 Jellyfin 自己
                // 的刮削器，直连世界没有等价数据源——需要额外一次
                // /tv/{id}/season/{s}/episode/{e} 详情调用，T3a 未实现，YAGNI/留给未来）。
                // 合成一个诚实的占位名，好过留空看起来像 bug。
                name: `S${season}E${episode}`,
                path, subStatus: toWrite,
              })
              lib.setProbeMemo(ownEpisodeId, stat.mtimeMs, stat.size, embeddedLangs)
              lib.clearParkedPath(path)
              result.upserted++
              result.changed = true
            } else {
              // 同路径前后两轮识别出的"种类"不一致（剧集↔电影）：见 TV 分支同名注释——movies
              // 分支没有 park 中途退出的子情形，直接清理即可。
              if (existing && existing.kind !== 'movie') {
                lib.deleteEpisodeByPath(path)
                if (existing.seriesId) lib.deleteSeriesIfEmpty(existing.seriesId)
              }

              const ownMovieId = seriesId(tmdbId) // movies 复用同一构造器（ownIds.ts 头注释）

              const movieExisted = lib.getMovie(ownMovieId) !== null
              let posterPath: string | null = null
              let year: number | null = null
              let chineseTitle: string | null = null
              if (!movieExisted) {
                const enrich = await enrichNewSeriesOrMovie('movie', tmdbId, tmdb, log)
                posterPath = enrich.posterPath
                year = enrich.year
                chineseTitle = enrich.chineseTitle
                // 占位插入：origin_lang 缓存写回（setMovieOriginLang）是 UPDATE-only，必须先有
                // 行才能写——movies 表把"series 级元数据"和"episode 级 sub_status"揉进同一行，
                // 不像 series/episodes 天然分两张表，没有"先写不带 sub_status 的元数据行"这条
                // 路可走。subStatus 先给个占位值，下面算出真实值后立刻二次 upsert 覆盖。
                lib.upsertMovie({
                  id: ownMovieId, name: title, path, subStatus: 'missing',
                  chineseTitle, posterPath, year, providerIds: JSON.stringify({ tmdb: tmdbId }),
                })
              }

              const cachedOriginLang = lib.getMovieOriginLang(ownMovieId)
              const origin = await resolveOriginLang(
                cachedOriginLang, 'movie', tmdbId, tmdb,
                (lang) => lib.setMovieOriginLang(ownMovieId, lang), log,
              )

              const tracks = await deps.probe(path)
              const embeddedLangs = tracks === null ? null : usableEmbeddedLangs(tracks)

              const priorMovie = lib.getMovie(ownMovieId) // 占位插入后必然非 null
              const computed = classify({
                title, originLang: origin.lang, originResolutionFailed: origin.failed,
                embeddedLangs, path, targetLanguages, originSkipLanguages, fileExists,
              })
              const toWrite = resolveStatusToWrite(computed, priorMovie?.sub_status ?? null)

              lib.upsertMovie({
                id: ownMovieId, name: title, path, subStatus: toWrite,
                chineseTitle, posterPath, year, providerIds: JSON.stringify({ tmdb: tmdbId }),
              })
              lib.setProbeMemo(ownMovieId, stat.mtimeMs, stat.size, embeddedLangs)
              lib.clearParkedPath(path)
              result.upserted++
              result.changed = true
            }
          } catch (e) {
            // 同 daemon/selfScan.ts 的既有哲学："一个文件/一次 TMDB 抖动不能拖垮整轮 pass"——
            // 记日志，这个文件本轮既不算 upserted 也不算 parked，下一轮 pass 重试。
            const msg = e instanceof Error ? e.message : String(e)
            log(`ingest: failed for ${path}, will retry next pass: ${msg}`)
          }
        }
      }

      // ---- 磁盘真相移除：本轮走盘没见到 + fileExists 确认真的不在了 → 行退役 ----
      // 双重条件缺一不可：只看"本轮没见到"会在 walk() 遇到某子目录瞬时 readdir 失败时
      // （daemon/selfScan.ts 的 walk() 吞掉该错误、跳过整棵子树）误删仍然真实存在的文件的
      // 库行——"宁多查勿漏配"，加一道 fileExists 复核堵住这个假阳性。
      const episodeRows = lib.db.prepare('SELECT path, series_id FROM episodes').all() as
        { path: string; series_id: string }[]
      for (const row of episodeRows) {
        if (!seenPaths.has(row.path) && !fileExists(row.path)) {
          lib.deleteEpisodeByPath(row.path)
          lib.deleteSeriesIfEmpty(row.series_id)
          result.removed++
        }
      }
      const movieRows = lib.db.prepare('SELECT path FROM movies').all() as { path: string }[]
      for (const row of movieRows) {
        if (!seenPaths.has(row.path) && !fileExists(row.path)) {
          lib.deleteMovieByPath(row.path)
          result.removed++
        }
      }
      // parked_paths 同理清理（不计入 removed——那是 episodes/movies 行退役的计数，park 户口
      // 消失是另一件事，P6 救援页读 listParkedPaths 时自然看不到已经不在盘上的路径）。
      for (const p of lib.listParkedPaths()) {
        if (!seenPaths.has(p.path) && !fileExists(p.path)) {
          lib.clearParkedPath(p.path)
        }
      }
      if (result.removed > 0) result.changed = true

      return result
    } finally {
      ingestLock.held = false
    }
  }
}
