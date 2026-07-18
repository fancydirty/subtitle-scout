import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { tagsForLanguage, langOf } from '../agent/languages.js'
import { seasonEpisodeForAbsolute } from '../agent/absoluteEpisodes.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { walkVideoFiles } from '../daemon/selfScan.js'
import { isMechanicalExtra } from './extrasFilter.js'
import { seriesId, episodeId, tmdbIdFromOwnId } from './ownIds.js'
import { refreshSeriesCatalog } from './tmdbCatalog.js'
import type { ScoutDb } from './db.js'
import type { LibraryRepo, SubStatus } from './libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { Recognized, Park } from '../recognition/index.js'
import { isCanonicalEpisodePath } from '../recognition/identifyFromPath.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import { propagateSubtitleToReplica } from './subtitlePropagation.js'

/**
 * 去 Jellyfin 化 P3（design: docs/design/2026-07-16-de-jellyfin-design.md §P3）的核心：
 * `FS 走盘 → recognize()（C 层）→ 覆盖探测（sidecar + 探针）→ 直写 series/episodes/movies 行`。
 * 顶替 v2/scanner.ts 的 Jellyfin API 读取整体（scanner.ts 本身按计划留到 T4 才退役，T4 已完成，
 * scanner.ts 现已整体删除，见下方"分类规则移植"说明的溯源记录）。
 */

export interface IngestDeps {
  /** dashboard G4：守备目录 DB 化——不再是启动时冻结的静态数组，惰性提供者，每轮 pass 起点
   *  （见下方 ingestPass() 顶部）才求值一次。cmdWatch/cmdReconcileAll 传入
   *  `() => settingsRepo.listRoots().map(r => r.path)`，dashboard 里加/删根后不需要重启进程或
   *  重建这个 deps 对象，下一轮 pass 自然看见最新的根集合。 */
  roots: () => string[]
  lib: LibraryRepo
  tmdb: TmdbClient
  /** 调用方预绑定好 tmdb + findOverride（recognition/index.ts 的 recognize 签名）。 */
  recognize: (videoPath: string) => Promise<Recognized | Park>
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  /** 重复源 P4b（"复制优先"机械通道，v2/subtitlePropagation.ts）：探测一个视频的时长（秒），
   *  失败（ffprobe 缺席/超时/非视频）返回 null——同 probe 一样，调用方永远显式提供，测试永远
   *  注入固定值/null，从不在测试里真的 spawn ffprobe。 */
  probeDuration: (videoPath: string) => Promise<number | null>
  /** 默认 daemon/selfScan.ts 导出的 walkVideoFiles（B1 的同一份遍历实现，见该文件顶部注释）。 */
  listVideoFiles?: (root: string) => string[]
  fileExists?: (p: string) => boolean
  /** 测试注入点；默认 node:fs statSync 包一层 try/catch（失败→null）。 */
  statFile?: (p: string) => { mtimeMs: number; size: number } | null
  /** 债务D5：target_languages/origin_skip_languages 提供者化——每轮 pass 起点才新鲜求值
   *  （dashboard G4 roots 同款手法）。设置页改 target_languages 后，下一轮扫描即生效；
   *  find_subtitle worker 的每次派发也独立覆写，无需重启 watch 进程。 */
  targetLanguages: () => string[]
  originSkipLanguages?: () => string[]
  /** 救援R4：特典机械排除开关（settings.exclude_extras）。() => true 才启用铁案过滤。
   *  提供者化：每轮 pass 新鲜求值，设置页改完下一轮生效。缺省 false（保守）。 */
  excludeExtras?: () => boolean
  /** 救援R5：hardsub_mode 提供者（settings.hardsub_mode）。'off'/'agent' 时 classify() 的
   *  rule 4b 不生效（agent 档判断归 find-subtitle skill，不在这里）；'aggressive' 才机械直判。
   *  提供者化，同 excludeExtras 手法：每轮 pass 新鲜求值，设置页改完下一轮生效。缺省 'off'。 */
  hardsubMode?: () => 'off' | 'agent' | 'aggressive'
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
 *  与 v2/scanner.ts 曾经的同名 ORIGIN_UNKNOWN 哨兵同一套思路，各自模块私有，不共享/不导出
 *  （摄取层与 scanner.ts 当年各自独立演化；scanner.ts 已随 T4 整体退役删除）。 */
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
 *  直接对 lib.db 发 SQL——与已删除的 scanner.ts 当年对 meta 表的写法同一套口径（LibraryRepo.db
 *  是公开字段，供没有专用方法覆盖的查询直接使用）。 */
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

/** CHEAP PATH 专用：只改 sub_status（+updated_at，+F-R2-6 的 search_attempts，+B3-2 的
 *  status_reason 清理），不碰其余列——"重跑覆盖分类，不是重新摄取"。LibraryRepo 没有通用的
 *  "任意改 sub_status"方法（markCovered/markUnavailable 都是带副作用的专用写法），直接对
 *  lib.db 发 SQL，同 findRowByPath 的既有口径。
 *  R-9（判决可稽核）：reason 非空时（目前只有 rule 1b 会给）连带写 status_reason；reason 为 null
 *  时原则上完全不碰该列（不是写 null 清空它）——沿用改前的窄写口径，避免这次收窄改动波及其余
 *  状态转换（如 covered→missing）本不该动的列。
 *
 *  B3-2（批③领养记账，审计定罪：领养翻 covered 后 status_reason 残留旧失败叙事）：上面这条
 *  "reason 为 null 就不碰该列"的窄口径有个例外——status 落地为 covered 时（rule 3 sidecar 领养，
 *  reason 恒 null）主动清空 status_reason。理由：covered 是终局态之一，若该行此前是
 *  unavailable/rule 1b ignored 留下的旧叙事（如 markUnavailable 的"搜索穷尽"人话理由），领养
 *  成功后这条旧理由已经完全不适用（生产实证：tmdb:86831/s3e8 covered 而 status_reason 仍是
 *  "unknown videoFilename…"，误导人工回看）。missing/ignored 等其余转换不受影响——reason 为
 *  null 且 status 不是 covered 时仍保持"不碰该列"的既有窄口径不变。
 *
 *  F-R2-6（R2 复审，审计定罪：ingest 覆盖路径绕过阶梯归零，R-3 不变式）：status 落地为
 *  covered/embedded 时同步把 search_attempts 归零——"翻篇"事件。此前只有 markCovered
 *  （find-subtitle worker 的 installed 落账）归零 search_attempts，ingest 自己判出的
 *  covered/embedded（手工放字幕被摄取发现、内嵌轨被探针发现）从未归零：该行若之后又翻回
 *  missing/unavailable，首次 markUnavailable 直接沿用滞留的旧计数，跳过 1 天档、错落到更远
 *  的阶梯位置——阶梯的"翻篇即归零"单一语义被这条绕过的路径破坏。 */
function writeSubStatusOnly(
  db: ScoutDb, kind: 'episode' | 'movie', id: string, status: SubStatus, now: number, reason: string | null = null,
): void {
  const table = kind === 'episode' ? 'episodes' : 'movies'
  const attemptsClause = status === 'covered' || status === 'embedded' ? `, search_attempts = 0` : ''
  if (reason != null) {
    db.prepare(`UPDATE ${table} SET sub_status = ?, status_reason = ?, updated_at = ?${attemptsClause} WHERE id = ?`).run(status, reason, now, id)
  } else if (status === 'covered' || status === 'embedded') {
    // B3-2 + 批③a F-B：领养（covered）/内嵌覆盖（embedded）终局，清掉可能残留的旧
    // unavailable/ignored 叙事。
    db.prepare(`UPDATE ${table} SET sub_status = ?, status_reason = NULL, updated_at = ?${attemptsClause} WHERE id = ?`).run(status, now, id)
  } else {
    db.prepare(`UPDATE ${table} SET sub_status = ?, updated_at = ?${attemptsClause} WHERE id = ?`).run(status, now, id)
  }
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
  /** 救援R5 aggressive 档：机械层直判开关。'agent'/'off' 时这条规则不生效（agent 档的判断
   *  归 find-subtitle skill，机械层不越权代劳；见 rule 4b 注释）。 */
  hardsubMode: 'off' | 'agent' | 'aggressive'
}

/**
 * 分类规则移植自 v2/scanner.ts:82-187 `classifyItemDetailed` 的 rule 0-4（语义保持，数据源换
 * 自有——design §P3 "分类规则(原 classifyItemDetailed 的 rule 0-4)语义保持，数据源换自有"）。
 * v2/scanner.ts 本身已随 T4（去 Jellyfin 化）整体退役删除——下面的行号引用只是移植时刻的历史
 * 快照，今天已经找不到那份源码核对，只作为"这套规则从哪来"的溯源记录：
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
 *   等价于直接去掉这层 veto（不是遗漏，是原逻辑在信号源缺失后的自然坍缩）。R-9（判决可稽核）：
 *   这条是启发式猜测而非权威信号（不同于 rule 0 的 TMDB 直答），命中时连带记一条 status_reason
 *   （见下方 RULE_1B_REASON），供人工回看"这行为什么被判 ignored"；rule 0 命中不留 reason
 *   （TMDB 原生语种是权威事实，不需要额外解释）。
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
 * - rule 4b（救援R5 §4 aggressive 档，机械层直判，新增）：仅在 hardsubMode==='aggressive' 且
 *   探针**确凿**判定"零内嵌字幕轨"（embeddedLangs 非 null 且为空数组——探针真的跑过、真的没
 *   查到任何轨；embeddedLangs 为 null 是"探针不可用/未知"，不是证据，不能触发这条规则）且文件名
 *   带括号发布组标记（fansub 惯例，如 [Group] Show - 01.mkv）时，直接判 hardsub-assumed，不落
 *   missing——这类文件根本不会被派给 find-subtitle worker 做徒劳搜索。agent 档的同款判断
 *   （证据完全一致：组名标记+确认无内嵌，只是"搜索已穷尽"这第三重证据机械层拿不到）故意不在
 *   这里做——那是 find-subtitle skill 的职责（agent 判断先搜索、机械层直接跳过搜索），两档
 *   共享判据但不共享代码路径，避免机械层偷跑 agent 档的职责边界。
 * - rule 4（兜底）：以上都不命中 → 'missing'。
 */

const HAN = /[一-鿿]/
const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯]/
/** rule 4b 的发布组标记：文件名以 [任意非] 字符] 开头——fansub 命名惯例（[Group] Show...）。
 *  只看 basename，不看目录名（目录名带括号更常是年份/tmdbid 标记，不是发布组）。 */
const RELEASE_GROUP_TAG = /^\[[^\]]+\]/
/** rule 1b 的标题启发式：含汉字且无假名无谚文 → 视作中文（排除日番/韩剧）。无 TMDB origin
 *  信号时用（去 Jellyfin 化 P7：原属 daemon/triggers.ts，唯一消费方只剩这里，随出口清算搬来
 *  同一个文件——语义/正则逐字未变，纯位置移动）。 */
export function looksChineseTitle(title: string | null | undefined): boolean {
  return !!title && HAN.test(title) && !KANA.test(title) && !HANGUL.test(title)
}

/** R-9（判决可稽核）：rule 1b 命中时落的固定理由串——标题启发式是猜测，不是权威信号，人工回看
 *  一条 ignored 行时应该能立刻分辨"TMDB 说的"（rule 0，reason=null）和"猜的"（rule 1b，这条）。 */
const RULE_1B_REASON = 'ignored: 标题启发式判中文原声，origin 未确认'

interface ClassifyResult {
  status: SubStatus
  /** 非 null 仅当 rule 1b 命中——rule 0/2/3/4 都不留痕（rule 0 是权威事实，无需解释；2/3/4
   *  不是 ignored，reason 概念对它们不适用）。 */
  reason: string | null
  /** B3-1（批③领养记账）：rule 3（磁盘 sidecar）命中时的真实路径 + 按匹配 tag 换算出的语言——
   *  非 null 恒等价于 status === 'covered'（classify() 里只有 rule 3 会产出 'covered'），调用方
   *  据此补写 subtitles 行（领养入账，见 libraryRepo.recordAdoptedSidecar 头注释）。其余规则
   *  （0/1b/2/4/4b）恒 null。 */
  sidecar: { path: string; language: string } | null
}

function classify(input: ClassifyInput): ClassifyResult {
  const { title, originLang, originResolutionFailed, embeddedLangs, path, targetLanguages, originSkipLanguages, fileExists, hardsubMode } = input

  // rule 0
  if (originLang != null && originSkipLanguages.includes(langOf(originLang))) {
    return { status: 'ignored', reason: null, sidecar: null }
  }

  // rule 1b（rule 1 已删除，见上方函数头注释）
  if (originSkipLanguages.includes('zh')) {
    if (originLang == null && !originResolutionFailed && looksChineseTitle(title)) {
      return { status: 'ignored', reason: RULE_1B_REASON, sidecar: null }
    }
  }

  const targetTags = targetLanguages.flatMap(tagsForLanguage)

  // rule 2
  if (embeddedLangs && embeddedLangs.some(lang => targetTags.includes(lang))) {
    return { status: 'embedded', reason: null, sidecar: null }
  }

  // rule 3
  const sidecarMatch = findExternalSidecar(path, targetTags, fileExists)
  if (sidecarMatch) {
    return { status: 'covered', reason: null, sidecar: sidecarMatch }
  }

  // rule 4b（见函数头注释）：aggressive 档 + 探针确凿零内嵌轨 + 发布组标记 → 直判 hardsub-assumed。
  if (
    hardsubMode === 'aggressive' &&
    embeddedLangs !== null && embeddedLangs.length === 0 &&
    RELEASE_GROUP_TAG.test(basename(path))
  ) {
    return { status: 'hardsub-assumed', reason: 'aggressive 档机械直判：发布组标记 + 探针确认零内嵌字幕轨', sidecar: null }
  }

  // rule 4
  return { status: 'missing', reason: null, sidecar: null }
}

/** origin_lang 解析 + 缓存写回，一份实现给 series/movie 两条分支复用（回调式 setCached 屏蔽
 *  两表 setSeriesOriginLang/setMovieOriginLang 的签名差异）。已缓存（含哨兵）直接解码返回，
 *  不重新请求 TMDB——"resolve once per series/movie"是已删除的 scanner.ts 当年就有的不变式，
 *  这里保持。
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
): Promise<{ posterPath: string | null; year: number | null; chineseTitle: string | null; genres: number[] | null; originalTitle: string | null; imdbId: string | null }> {
  let posterPath: string | null = null
  let year: number | null = null
  let genres: number[] | null = null
  let originalTitle: string | null = null
  try {
    const details = await tmdb.getDetails(mediaType, tmdbId)
    posterPath = details?.posterPath ?? null
    year = details?.year ?? null
    // 债务D6：404（getDetails 契约=返回 null，TMDB 权威答复查无此 id，永久态）时 genres 落 []
    // 而不是 null——null 不写列（见 libraryRepo 两条写路的 != null 判定），该行会永远留在
    // listSeriesNeedingEnrich 的 `genres IS NULL` 候选里，空转击穿每轮 10 个重试槽。瞬时失败
    // （下面 catch 分支）维持 null → 下轮重试，两种"没拿到"必须分开。
    genres = details ? details.genreIds : []
    originalTitle = details?.originalTitle ?? null
  } catch (e) {
    log(`ingest: getDetails failed for ${mediaType}:${tmdbId}, proceeding without poster/year/genres/originalTitle this pass: ${e instanceof Error ? e.message : String(e)}`)
  }
  const zhTitles = await tmdb.getChineseTitles(mediaType, tmdbId) // 自身已 fail-soft，失败返回 []
  let imdbId: string | null = null
  try {
    imdbId = (await tmdb.getExternalIds(mediaType, tmdbId)).imdbId
  } catch (e) {
    log(`ingest: getExternalIds failed for ${mediaType}:${tmdbId}, proceeding without imdbId this pass: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { posterPath, year, chineseTitle: zhTitles[0] ?? null, genres, originalTitle, imdbId }
}

/** 合并 provider_ids：只在现有 JSON 不含 imdb 键且新值有 imdb 时才写入，否则返回 null。
 *  provider_ids 是 JSON 字符串，合并逻辑必须在 ingest 侧做（SQL 无法读 JSON 内键做 COALESCE）。
 *  损坏的现值 → 宁可不写也不覆盖；现值为 null 但有 tmdbId 时，用 tmdbId 兜底构建新对象。 */
function mergeProviderIds(existingJson: string | null, newImdbId: string | null, tmdbId: string | null): string | null {
  if (!newImdbId) return null
  let existing: Record<string, unknown>
  try {
    existing = existingJson ? JSON.parse(existingJson) as Record<string, unknown> : {}
  } catch {
    return null
  }
  if (existing.imdb) return null
  if (!existingJson && tmdbId) {
    existing = { tmdb: tmdbId }
  }
  existing.imdb = newImdbId
  return JSON.stringify(existing)
}

export function makeIngestPass(deps: IngestDeps): () => Promise<IngestResult> {
  const listVideoFiles = deps.listVideoFiles ?? walkVideoFiles
  const fileExists = deps.fileExists ?? ((p: string) => existsSync(p))
  const statFile = deps.statFile ?? defaultStatFile
  const { lib, tmdb, log } = deps

  return async function ingestPass(): Promise<IngestResult> {
    // 债务D5：语言配置每轮 pass 新鲜求值——设置页改 target_languages 后下一轮扫描即生效。
    const targetLanguages = deps.targetLanguages()
    const originSkipLanguages = deps.originSkipLanguages?.() ?? targetLanguages
    const excludeExtras = deps.excludeExtras?.() ?? false
    const hardsubMode = deps.hardsubMode?.() ?? 'off'
    ingestLock.held = true
    try {
      const nowMs = deps.now ? deps.now() : Date.now()
      const result: IngestResult = { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false }
      const seenPaths = new Set<string>()
      // 债务D1（realign 出生信号换代）：本轮观察到的每个 series 的磁盘布局事实——
      // true=本轮至少一集路径不合规范形。movies 豁免（没有规范形概念）、parked 路径不参与
      // （没有 series 归属），pass 收尾处全量重写（见文件底部）。
      const layoutObserved = new Map<string, boolean>()

      for (const root of deps.roots()) {
        for (const path of listVideoFiles(root)) {
          result.scanned++
          seenPaths.add(path)

          try {
            const stat = statFile(path)
            if (!stat) {
              log(`ingest: stat failed for ${path} (vanished mid-scan?), skipping this pass`)
              continue
            }

            // 救援R4（spec §3）：特典机械铁案——excludeExtras 开启时，文件名命中 NC/菜单/预告类
            // 标记直接 park excluded-extra，不进识别流（灰区 SP/OVA 不在这张表，归 rescueSkill）。
            // R4b：用户在甄别页翻过案的 path（extras_exemptions）跳过铁案——否则文件名仍匹配 NC
            // 正则，下一轮 pass 会无限再排除，翻案沦为 no-op。
            if (excludeExtras && isMechanicalExtra(path) && !lib.isExtrasExempt(path)) {
              lib.upsertParkedPath(path, 'excluded-extra', nowMs)
              result.parked++
              continue
            }
            const existing = findRowByPath(lib.db, path)

            // ---- CHEAP PATH：行存在 + 探针记忆化命中当前 (mtime,size) → 只重跑覆盖分类 ----
            if (existing) {
              const memo = lib.probeMemo(existing.id)
              if (memo && memo.mtime === stat.mtimeMs && memo.size === stat.size) {
                // 债务D1：cheap path 也是一次真实的磁盘观察——series_id 从既有行直接可得。
                if (existing.kind === 'episode' && existing.seriesId) {
                  layoutObserved.set(
                    existing.seriesId,
                    (layoutObserved.get(existing.seriesId) ?? false) || !isCanonicalEpisodePath(path)
                  )
                }
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
                  hardsubMode,
                })
                const toWrite = resolveStatusToWrite(computed.status, existing.subStatus)
                if (toWrite !== existing.subStatus) {
                  writeSubStatusOnly(lib.db, existing.kind, existing.id, toWrite, nowMs, computed.reason)
                  result.changed = true
                }
                // B3-1（批③领养记账）：toWrite==='covered' 恒来自 rule 3（sidecar），无关这次
                // if 是否真的改了 sub_status——已经是 covered 的行（上一轮已领养过）也要保证
                // subtitles 行存在（ON CONFLICT DO NOTHING 天然幂等，不重复插）。
                if (toWrite === 'covered' && computed.sidecar) {
                  lib.recordAdoptedSidecar(existing.id, computed.sidecar.path, computed.sidecar.language, nowMs)
                }
                continue
              }
            }

            // ---- B3-3（配额止血）：已登记副本——item_files 命中该 path → 跳过 recognize() ----
            // findRowByPath 只查 episodes/movies，天生看不到副本（副本的身份记在 item_files，
            // episodes/movies.path 仍指向主文件）；不设防的话，每一轮 pass 副本都会落到下面的
            // FULL PATH 重新真的 recognize()（真 TMDB 搜索）——生产实证：已登记副本每轮空转
            // 重识别，白烧 TMDB 配额。这条路径已知 itemId（从 item_files 反查），不需要重新识别，
            // 只需照常触发一次幂等的 propagateSubtitleToReplica（同 FULL PATH 撞身份分支的既有
            // 调用），别的什么都不用做——不碰 addItemFile（行已经在），不影响下面"主文件消失
            // 晋升"逻辑（该逻辑读 item_files 表本身，不关心这条路径本轮走了 CHEAP/B3-3/FULL 哪
            // 条分支；seenPaths 已在循环顶部加过这条 path，晋升清理不会误删它）。
            const existingReplica = existing ? null : lib.getItemFileByPath(path)
            if (existingReplica) {
              const ownerPath =
                lib.getEpisode(existingReplica.item_id)?.path ?? lib.getMovie(existingReplica.item_id)?.path ?? null
              if (ownerPath) {
                await propagateSubtitleToReplica(
                  { lib, probeDuration: deps.probeDuration, log }, existingReplica.item_id, ownerPath, path, nowMs,
                )
              }
              continue
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
              let resolvedSeason = outcome.season
              let resolvedEpisode = outcome.episode

              // 绝对集号折算（番剧平铺编号：路径只给出整剧绝对集号，无季/集结构）：用
              // agent/absoluteEpisodes.ts 的 TMDB 编号表（官方 Absolute 型 episode-group 优先，
              // 季表 concat 兜底——find-subtitle worker 正向折算用的同一套权威表）做逆向查询。
              // 折算命中 → 当普通集处理（行的 season/episode 就是折算出的对，绝对集号不另存
              // ——episodeId 形状就是身份）；折算不出（剧无编号表数据/集号越界/TMDB 双路失败）
              // → park 'absolute-episode-unresolved'（此时是真·"TMDB 说不出来"，不再是"没试过"）。
              if (resolvedEpisode === null && outcome.absoluteEpisode !== null) {
                // P7 disambiguation 守卫（零误认红线）：outcome.viaOverrideLenient 标记的
                // absoluteEpisode 来自 recognize() 的 claim-gated 宽松裸数字救援——认领只回答了
                // "这是哪部剧"，没回答"这串裸数字在哪季"。单季剧下无所谓（绝对集号==季内集号，
                // seasonEpisodeForAbsolute 的折算天然无歧义，照常往下走）；多季剧下这串数字可能
                // 是整剧绝对集号，也可能是当前季/品牌子系列内部编号（真实撞过的例子：High School
                // DxD 第四季副标题 'Hero'，文件名 'Hero - 01' 的 01 是 Hero 这一季的第 1 集，
                // 不是全剧绝对第 1 集——当绝对集号折算会错算成 S1E01，一整行错季错集地装错字幕）。
                // 拿不准就不动手：park 一个诚实的理由，让人类回到救援页把 season 一起补上
                // （见 identify_overrides.season + recognize() 里"认领带 season → 直接无歧义"
                // 的那条分支），而不是在这里替它猜。注意 getSeasonTable 本身已经过滤掉
                // season_number<=0（特别篇不计入"有几季"），"多于一季"就是这里唯一要判的门槛；
                // 拿不到季表（null/瞬时失败）时不在这里强行下判断——照常落到下面的
                // seasonEpisodeForAbsolute，它自己会用同一套数据源纪律得出 null，最终仍然诚实地
                // park('absolute-episode-unresolved')，不会把"查不到"误判成"能安全折算"。
                if (outcome.viaOverrideLenient) {
                  const seasonTable = await tmdb.getSeasonTable(tmdbId)
                  if (seasonTable && seasonTable.length > 1) {
                    lib.upsertParkedPath(path, 'override-ambiguous-numbering', nowMs)
                    result.parked++
                    continue
                  }
                }
                const mapped = await seasonEpisodeForAbsolute(outcome.absoluteEpisode, tmdb, tmdbId)
                if (mapped) {
                  resolvedSeason = mapped.season
                  resolvedEpisode = mapped.episode
                }
              }

              if (resolvedEpisode === null) {
                // 无法构造合法的 episodeId（tmdb:<id>/s<N>e<M> 要求具体集号）——absoluteEpisode
                // 非 null 时是折算失败的番剧编号场景（见上）；absoluteEpisode 也是 null 时是
                // 路径压根没给出任何集号信号。两种都不猜（"拿不准就不动手"），park——
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

              const season = resolvedSeason ?? 0
              const episode = resolvedEpisode
              const ownSeriesId = seriesId(tmdbId)
              const ownEpisodeId = episodeId(tmdbId, season, episode)

              // P7 真库闸门 Bug 2 修复：own-id（tmdbId+season+episode）幂等性守卫——两个不同磁盘
              // 路径识别到同一个 own-id 是真实会发生的情况（多质量重复下载、种子机硬链接残留、
              // 改名前后两份没清理干净），但 episodes 表 path 列是单值，一行只能记一个 path。不
              // 设防的话，两条路径会在每一轮互相"抢" path 列——每次都把对方刚写的 path 覆盖掉，
              // findRowByPath 按字面 path 查，谁都找不到自己上一轮写的行，于是永远走不到 CHEAP
              // PATH、永远当"新文件"重新识别+回写，upserted 计数在完全安静的库上也永远不收敛到
              // 0（真幂等性泄漏）。规则：这个 own-id 已经有另一条不同 path 的行占着 → 我是本轮
              // "迟到"的那条，不抢，park 'duplicate-content'（不是猜错，是诚实地报告"重复内容,
              // 需要人工去重"）；先占住的那条完全不受影响，继续走它自己正常的 CHEAP PATH。谁先
              // 谁后由 listVideoFiles 的遍历顺序 + 历史上谁先被摄取决定，不是本次修复要解决的
              // "该留哪份"的判断——那是人的事，不是摄取层的事（YAGNI，同 C3/C4 的"拿不准就不动
              // 手"哲学）。复用 priorEpisode 这次 DB 读，classify() 的 resolveStatusToWrite 下面
              // 还要用它，不重复查询。
              const priorEpisode = lib.getEpisode(ownEpisodeId)
              if (priorEpisode && priorEpisode.path !== path) {
                // 重复源 P2：撞既有身份但 path 不同 = 同一集的副本（4K/1080p/不同压制），不再
                // park duplicate-content，而是登记为一等公民副本（item_files）。clearParkedPath
                // 顺带自愈存量：此 path 若此前被 park 成 duplicate-content（P2 之前的行为），此刻
                // 退户口——存量迁移不需要独立脚本，就是这一行 no-op-safe 的清理（非停车路径删无害）。
                lib.addItemFile(ownEpisodeId, path, nowMs)
                lib.clearParkedPath(path)
                result.changed = true
                // 重复源 P4b："复制优先"机械通道——主文件已有字幕、这个副本还没有，时长够接近就
                // 直接复制装上（详见 subtitlePropagation.ts 头注释）。best-effort：探测/复制失败
                // 只落 log，绝不抛出打断这一轮扫描剩下的文件。
                await propagateSubtitleToReplica(
                  { lib, probeDuration: deps.probeDuration, log }, ownEpisodeId, priorEpisode.path, path, nowMs,
                )
                continue
              }

              const seriesExisted = lib.getSeries(ownSeriesId) !== null
              let posterPath: string | null = null
              let year: number | null = null
              let chineseTitle: string | null = null
              let genres: number[] | null = null
              let imdbId: string | null = null
              if (!seriesExisted) {
                const enrich = await enrichNewSeriesOrMovie('tv', tmdbId, tmdb, log)
                posterPath = enrich.posterPath
                year = enrich.year
                chineseTitle = enrich.chineseTitle
                genres = enrich.genres
                imdbId = enrich.imdbId
                // dashboard G2：三层格阵第一层——新剧首次入库顺手起播应有集缓存（tmdbCatalog.ts）。
                // fire-and-forget：不 await，失败仅 log，绝不阻塞摄取主流程（该函数自身已是
                // gain-path 降级，见其头注释）。
                void refreshSeriesCatalog(lib.db, tmdb, ownSeriesId, nowMs).catch(e =>
                  log(`ingest: refreshSeriesCatalog failed for ${ownSeriesId}, degraded this pass (retry next pass): ${e instanceof Error ? e.message : String(e)}`)
                )
              }
              lib.upsertSeries({
                id: ownSeriesId, name: title, chineseTitle, posterPath, year, genres,
                providerIds: imdbId
                  ? JSON.stringify({ tmdb: tmdbId, imdb: imdbId })
                  : JSON.stringify({ tmdb: tmdbId }),
              })

              const cachedOriginLang = lib.getSeriesOriginLang(ownSeriesId)
              const origin = await resolveOriginLang(
                cachedOriginLang, 'tv', tmdbId, tmdb,
                (lang) => lib.setSeriesOriginLang(ownSeriesId, lang), log,
              )

              const tracks = await deps.probe(path)
              const embeddedLangs = tracks === null ? null : usableEmbeddedLangs(tracks)

              // priorEpisode 已经在上面的 own-id 幂等性守卫里查过一次，直接复用，不重复查询。
              const computed = classify({
                title, originLang: origin.lang, originResolutionFailed: origin.failed,
                embeddedLangs, path, targetLanguages, originSkipLanguages, fileExists, hardsubMode,
              })
              const toWrite = resolveStatusToWrite(computed.status, priorEpisode?.sub_status ?? null)

              lib.upsertEpisode({
                id: ownEpisodeId, seriesId: ownSeriesId, season, episode,
                // TMDB 搜索命中只给到剧级标题，没有单集标题（旧版 item.Name 来自 Jellyfin 自己
                // 的刮削器，直连世界没有等价数据源——需要额外一次
                // /tv/{id}/season/{s}/episode/{e} 详情调用，T3a 未实现，YAGNI/留给未来）。
                // 合成一个诚实的占位名，好过留空看起来像 bug。
                name: `S${season}E${episode}`,
                path, subStatus: toWrite,
              })
              // R-9（判决可稽核）：upsertEpisode 的共享 SQL 不带 status_reason 列，写不进去就在
              // 它之后补一条窄 UPDATE——只在 rule 1b 真给了 reason 时才发（rule 0/2/3/4 都是
              // reason:null，不产生这条多余的写）。
              if (computed.reason) {
                lib.db.prepare(`UPDATE episodes SET status_reason = ? WHERE id = ?`).run(computed.reason, ownEpisodeId)
              } else if (toWrite === 'covered' || toWrite === 'embedded') {
                // B3-2 + 批③a F-B：同 CHEAP PATH（writeSubStatusOnly 头注释）——领养(sidecar)/
                // 内嵌覆盖(embedded)终局清掉 upsertEpisode 的 ON CONFLICT 分支不会碰、因而可能
                // 残留的旧 unavailable 叙事。upsertEpisode 全新 INSERT 分支本就默认 NULL，这条
                // UPDATE 对新行是无害 no-op。
                lib.db.prepare(`UPDATE episodes SET status_reason = NULL WHERE id = ?`).run(ownEpisodeId)
              }
              // B3-1（批③领养记账）：toWrite==='covered' 恒来自 rule 3（sidecar）——补写 subtitles
              // 行（ON CONFLICT DO NOTHING 幂等，跨 pass 重复命中不重复插）。
              if (toWrite === 'covered' && computed.sidecar) {
                lib.recordAdoptedSidecar(ownEpisodeId, computed.sidecar.path, computed.sidecar.language, nowMs)
              }
              // 债务D1：full path 的 series_id 从识别结果直接可得（ownSeriesId）。
              layoutObserved.set(ownSeriesId, (layoutObserved.get(ownSeriesId) ?? false) || !isCanonicalEpisodePath(path))
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

              // P7 真库闸门 Bug 2 修复：own-id 幂等性守卫，同 TV 分支同名注释——movies 直接用
              // tmdbId 当 own-id，同一部电影的两份重复文件（不同质量/硬链接残留）一样会在每一轮
              // 互相抢 path 列，一样需要挡在这里。priorMovie 这次查询同时替代了原来的
              // `movieExisted` 判定和下面 classify 前的 prior-状态查询（新电影场景下，原代码是在
              // 占位插入*之后*才查 priorMovie，拿到的是刚写入的占位值 'missing'；这里提前到占位
              // 插入*之前*查，拿到 null——resolveStatusToWrite 只特判 'unavailable'，'missing' 和
              // null 在它眼里等价，行为不变，见下方 toWrite 那行）。
              const priorMovie = lib.getMovie(ownMovieId)
              if (priorMovie && priorMovie.path !== path) {
                // 重复源 P2：同一部电影的副本 → item_files（同 TV 分支，见其注释）。clearParkedPath
                // 顺带自愈存量 duplicate-content 停车行。
                lib.addItemFile(ownMovieId, path, nowMs)
                lib.clearParkedPath(path)
                result.changed = true
                // 重复源 P4b：同 TV 分支（见其注释）。
                await propagateSubtitleToReplica(
                  { lib, probeDuration: deps.probeDuration, log }, ownMovieId, priorMovie.path, path, nowMs,
                )
                continue
              }

              const movieExisted = priorMovie !== null
              let posterPath: string | null = null
              let year: number | null = null
              let chineseTitle: string | null = null
              let imdbId: string | null = null
              if (!movieExisted) {
                const enrich = await enrichNewSeriesOrMovie('movie', tmdbId, tmdb, log)
                posterPath = enrich.posterPath
                year = enrich.year
                chineseTitle = enrich.chineseTitle
                imdbId = enrich.imdbId
                // 占位插入：origin_lang 缓存写回（setMovieOriginLang）是 UPDATE-only，必须先有
                // 行才能写——movies 表把"series 级元数据"和"episode 级 sub_status"揉进同一行，
                // 不像 series/episodes 天然分两张表，没有"先写不带 sub_status 的元数据行"这条
                // 路可走。subStatus 先给个占位值，下面算出真实值后立刻二次 upsert 覆盖。
                lib.upsertMovie({
                  id: ownMovieId, name: title, path, subStatus: 'missing',
                  chineseTitle, posterPath, year, providerIds: imdbId
                    ? JSON.stringify({ tmdb: tmdbId, imdb: imdbId })
                    : JSON.stringify({ tmdb: tmdbId }),
                })
              }

              const cachedOriginLang = lib.getMovieOriginLang(ownMovieId)
              const origin = await resolveOriginLang(
                cachedOriginLang, 'movie', tmdbId, tmdb,
                (lang) => lib.setMovieOriginLang(ownMovieId, lang), log,
              )

              const tracks = await deps.probe(path)
              const embeddedLangs = tracks === null ? null : usableEmbeddedLangs(tracks)

              // priorMovie 已经在上面的 own-id 幂等性守卫里查过一次，直接复用，不重复查询。
              const computed = classify({
                title, originLang: origin.lang, originResolutionFailed: origin.failed,
                embeddedLangs, path, targetLanguages, originSkipLanguages, fileExists, hardsubMode,
              })
              const toWrite = resolveStatusToWrite(computed.status, priorMovie?.sub_status ?? null)

              lib.upsertMovie({
                id: ownMovieId, name: title, path, subStatus: toWrite,
                chineseTitle, posterPath, year, providerIds: imdbId
                  ? JSON.stringify({ tmdb: tmdbId, imdb: imdbId })
                  : JSON.stringify({ tmdb: tmdbId }),
              })
              // R-9（判决可稽核）：同 TV 分支——upsertMovie 也不带 status_reason 列，rule 1b 命中
              // 时补一条窄 UPDATE。
              if (computed.reason) {
                lib.db.prepare(`UPDATE movies SET status_reason = ? WHERE id = ?`).run(computed.reason, ownMovieId)
              } else if (toWrite === 'covered' || toWrite === 'embedded') {
                // B3-2 + 批③a F-B：同 TV 分支（见其注释）——领养(sidecar)/内嵌覆盖(embedded)
                // 终局清掉可能残留的旧 unavailable 叙事。
                lib.db.prepare(`UPDATE movies SET status_reason = NULL WHERE id = ?`).run(ownMovieId)
              }
              // B3-1（批③领养记账）：同 TV 分支（见其注释）。
              if (toWrite === 'covered' && computed.sidecar) {
                lib.recordAdoptedSidecar(ownMovieId, computed.sidecar.path, computed.sidecar.language, nowMs)
              }
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
      //
      // 重复源 P2：item_files 副本清理**必须先于**下面的主文件退役循环——死副本先出表，晋升时
      // listItemFiles 只会看到仍在盘上的副本，promoteOldestReplica 不会把主文件 path 指向一个
      // 同样已消失的副本（否则要多轮扫描才收敛，中途主文件指向死文件）。
      for (const f of lib.db.prepare('SELECT path FROM item_files').all() as { path: string }[]) {
        if (!seenPaths.has(f.path) && !fileExists(f.path)) {
          lib.removeItemFileByPath(f.path)
          result.changed = true
        }
      }
      const episodeRows = lib.db.prepare('SELECT id, path, series_id FROM episodes').all() as
        { id: string; path: string; series_id: string }[]
      for (const row of episodeRows) {
        if (!seenPaths.has(row.path) && !fileExists(row.path)) {
          // 重复源 P2：主文件消失但仍有（存活的）副本 → 最年长副本晋升顶替，条目不退役；
          // 无副本可晋升才真正删行（既有行为）。
          if (lib.promoteOldestReplica(row.id) !== null) {
            result.changed = true
          } else {
            lib.deleteEpisodeByPath(row.path)
            lib.deleteSeriesIfEmpty(row.series_id)
            result.removed++
          }
        }
      }
      const movieRows = lib.db.prepare('SELECT id, path FROM movies').all() as { id: string; path: string }[]
      for (const row of movieRows) {
        if (!seenPaths.has(row.path) && !fileExists(row.path)) {
          if (lib.promoteOldestReplica(row.id) !== null) {
            result.changed = true
          } else {
            lib.deleteMovieByPath(row.path)
            result.removed++
          }
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

      // 债务D1：每轮全量重写本轮观察到的每个 series 的布局事实——磁盘真相语义（state=disk,
      // DB=index），realign 整理完成后下一轮观察自然回落 0，无需任何显式清除。
      for (const [sid, bad] of layoutObserved) lib.setSeriesLayoutNonstandard(sid, bad)

      // ---- 富化重试（验收修复轮一 Task V1，design §A，用户裁决，一石二鸟）----
      // 治愈空名 ? 卡与存量 genres 回填：P6 认领写入的 override 分支只知道 tmdbId，写不出
      // series.name（recognition/index.ts 的 claim-gated 分支恒 title:''），留下"空名 ? 卡"
      // 债务；旧库存量剧也从未拉过 genres（schema v13 新列，NULL=尚未富化）。两个缺口用同一
      // 条重试机制治愈：每轮 pass 收尾捞 lib.listSeriesNeedingEnrich 给出的候选（cap 10/轮，
      // 防 TMDB 抖动期连环空转把整轮 pass 拖垮），逐剧补拍 TMDB 详情，只回填缺失
      // （lib.applyEnrichment 的"宁可不写不可覆盖"语义，见该方法头注释）。
      //
      // 剧名来源：这条重试路径手上只有 tmdbId（listSeriesNeedingEnrich 只给 id），没有
      // recognize() 才有的原始文件名/路径可查——首次入库路径的 name 来自 outcome.title
      // （recognition/resolveToTmdb.ts 的 TMDB /search/tv 命中标题 adopted.title，见该文件），
      // 这条查询词驱动的搜索在这里用不上。getDetails 的 originalTitle 字段（tv: original_name）
      // 是这个端点唯一能给出的标题字段，虽是"原语言标题"而非展示标题，但好过永久空着——沿用
      // enrichNewSeriesOrMovie 同一套 fail-soft 手法，并复用它采集 imdbId（验收修复轮一：
      // 把真 imdb 回填空名/未富化剧，从源头封杀 LLM 把 tmdb id 幻觉成 imdb 的 bug）。
      // 这里只查 series 表（listSeriesNeedingEnrich 的 SQL 范围），故 mediaType 恒 'tv'。
      // 没有这条债务（P6 override 的 movie 分支同样写空 title，但 movies 表没有 genres 列，
      // 分区判据不需要它富化；空名 movie 留给未来若有需要再补，不在本轮范围内，YAGNI）。
      // 单剧失败（TMDB 抖动/getDetails 抛错）只 log 继续，不炸整轮 pass、不写任何字段——下一轮
      // pass 该剧仍在候选清单里，自然重试。
      for (const { id } of lib.listSeriesNeedingEnrich(10)) {
        try {
          const enrichTmdbId = tmdbIdFromOwnId(id)
          if (!enrichTmdbId) continue // 非本形状 id（理论不可达，series.id 恒 tmdb:<id>），跳过不炸
          const enrich = await enrichNewSeriesOrMovie('tv', enrichTmdbId, tmdb, log)
          const existing = lib.getSeries(id)
          const mergedProviderIds = mergeProviderIds(existing?.provider_ids ?? null, enrich.imdbId, enrichTmdbId)
          lib.applyEnrichment(id, {
            name: enrich.originalTitle,
            chineseTitle: enrich.chineseTitle,
            posterPath: enrich.posterPath,
            year: enrich.year,
            genres: enrich.genres,
            providerIds: mergedProviderIds,
          })
        } catch (e) {
          log(`ingest: enrich retry failed for ${id}, will retry next pass: ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      return result
    } finally {
      ingestLock.held = false
    }
  }
}
