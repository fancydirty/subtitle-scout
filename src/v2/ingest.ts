import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { tagsForLanguage, langOf } from '../agent/languages.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { walkVideoFiles } from '../daemon/selfScan.js'
import { isMechanicalExtra } from './extrasFilter.js'
import { tmdbIdFromOwnId } from './ownIds.js'
import type { ScoutDb } from './db.js'
import type { LibraryRepo, SubStatus } from './libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { PathIdentity, Park } from '../recognition/index.js'
import { isCanonicalEpisodePath } from '../recognition/identifyFromPath.js'
import type { EmbeddedSubtitleTrack } from '../files/streamProbe.js'
import { propagateSubtitleToReplica } from './subtitlePropagation.js'
import { mapWithConcurrency } from './probeConcurrency.js'

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
  /** 纯机械结构解析（recognition/index.ts 的 recognize 签名，PathIdentity=结构提示，
   *  无 tmdbId）——身份裁决（TMDB 搜索/详情/建行）已上移到 agent 的 write_identified_media
   *  工具，ingest 只拿结构提示 + 原始探测数据落 parked_paths，等 agent 识别。 */
  recognize: (videoPath: string) => PathIdentity | Park
  probe: (videoPath: string) => Promise<EmbeddedSubtitleTrack[] | null>
  /** 重复源 P4b（"复制优先"机械通道，v2/subtitlePropagation.ts）：探测一个视频的时长（秒），
   *  失败（ffprobe 缺席/超时/非视频）返回 null——同 probe 一样，调用方永远显式提供，测试永远
   *  注入固定值/null，从不在测试里真的 spawn ffprobe。 */
  probeDuration: (videoPath: string) => Promise<number | null>
  /** FULL PATH raw-data 采集阶段**跨文件**的探针并发上限（同一文件的 duration+轨道两个探针仍
   *  串行，见下方 pendingProbes 一段）。默认 2：阿里云盘经 rclone WebDAV 单文件 ffprobe 是
   *  12-16s（~12s 是阿里云 CDN 延迟地板，绕过 FUSE 直读签名 URL 同样 12.1s，串行无从优化），
   *  27 个云盘文件串行约 6 分钟，并发 2 即降到约 3 分钟；而 CIFS/SMB NAS 上探针只 1.09s，
   *  并发在那边买不到什么，还白白放大挂载压力——故默认值取保守的 2，真正的调优值留给部署后
   *  按各根的实测延迟分别配。 */
  probeConcurrency?: number
  /** 默认 daemon/selfScan.ts 导出的 walkVideoFiles（B1 的同一份遍历实现，见该文件顶部注释）。 */
  listVideoFiles?: (root: string) => string[]
  fileExists?: (p: string) => boolean
  /** 三层防线①（CIFS 挂载抖动误删修复——审计头号遗留，2026-07-18）：磁盘真相移除循环用它区分
   *  "确认不在磁盘上"（ENOENT/ENOTDIR）与"探测本身失败/结果不确定"（其它任何 errno——ESTALE/
   *  EIO/ETIMEDOUT/ENOTCONN/EACCES 等，NAS/CIFS 挂载抖动典型；这类错误不代表文件真的被删了，
   *  只代表"这一刻问不出答案"，绝不能折叠成"消失"）。测试注入点；未提供时若提供了旧 fileExists，
   *  从它派生（布尔只能表达 present/gone 两态，永不产生 unknown——保持所有从未涉及这次改动的
   *  既有测试的行为不变，它们从来没测过 unknown 分支，不该被迫涉入）；两者都未提供时（生产默认
   *  路径）落到真实 statSync 包一层 try/catch，按 errno 分三态（见 classifyStatError/
   *  defaultCheckFileGone）。 */
  checkFileGone?: (p: string) => 'gone' | 'present' | 'unknown'
  /** 三层防线②（消失去抖）：同一路径连续判 gone 达到这个轮次才真删（默认 2，环境变量
   *  REMOVAL_CONFIRM_PASSES 可覆盖，见 makeIngestPass 顶部解析）。测试注入点，用于精确控制
   *  轮次边界断言。 */
  removalConfirmPasses?: number
  /** 三层防线③（骤降哨兵）：某根本轮 seenPaths 相对该根已知库存条目数（episodes+movies）的比例
   *  低于这个阈值（且已知条目数 ≥10）时，整根本轮跳过全部移除（默认 0.5，环境变量
   *  SCAN_COLLAPSE_RATIO 可覆盖）。测试注入点。 */
  scanCollapseRatio?: number
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
  /** ingest 已在跑时早退（dashboard 触发的 reconcile-all/requestIngest 并发保护）。 */
  skipped?: boolean
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

/** 三层防线①核心分类：errno → 'gone'（确认不在——ENOENT 路径本身不存在/ENOTDIR 路径某一节
 *  不是目录，两者都是"权威事实：这个路径现在解析不出东西"）| 'unknown'（其它任何 errno——
 *  ESTALE/EIO/ETIMEDOUT/ENOTCONN/EACCES/ENAMETOOLONG 等等，代表探测本身失败或给不出权威答案，
 *  绝不能等价于"消失"——CIFS/NFS 挂载抖动的典型症状就是整个挂载点下的每一次 stat 都抛同一类
 *  这种错误，若被当成"消失"处理，等于把"问不出答案"错读成"确认没了"）。纯函数，不做 IO，脱离
 *  真实文件系统单测（真实 statSync 包裹见 defaultCheckFileGone）。 */
export function classifyStatError(err: unknown): 'gone' | 'unknown' {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown'
}

/** IngestDeps.checkFileGone 的默认实现：真实 statSync 包一层 try/catch。'unknown' 分支主动
 *  console.error 一行警示（带 errno——同 daemon/selfScan.ts walk() 遇到不可读子树时的既有风格，
 *  那边也是直接 console.error，不走注入的 log 回调），供运维在真实 CIFS/NFS 抖动时从日志里
 *  立刻看到"这条路径这一刻问不出答案"，而不是被静默折叠成删除。 */
function defaultCheckFileGone(path: string): 'gone' | 'present' | 'unknown' {
  try {
    statSync(path)
    return 'present'
  } catch (e) {
    const verdict = classifyStatError(e)
    if (verdict === 'unknown') {
      const code = (e as NodeJS.ErrnoException | undefined)?.code ?? '(no errno)'
      console.error(
        `ingest: stat probe for ${path} failed with errno ${code} (not ENOENT/ENOTDIR) — ` +
        `treating as indeterminate, NOT removing this pass (mount-blip guard): ` +
        `${e instanceof Error ? e.message : String(e)}`
      )
    }
    return verdict
  }
}

/** path 是否落在 root 目录下（含 root 自身）——纯字符串前缀判断需要边界感知，否则 '/media2/x'
 *  会被误判成 '/media' 的子路径。骤降哨兵按根分组统计归属用它。 */
function pathUnderRoot(path: string, root: string): boolean {
  const withSep = root.endsWith('/') ? root : `${root}/`
  return path === root || path.startsWith(withSep)
}

/** 三层防线②（消失去抖）：本轮判定 gone 记一次账，返回累计 miss 次数（含本次）——真删门槛见
 *  removalConfirmPasses。pending_removals 是 schema v10 的纯增量小表（PRIMARY KEY(path)）。 */
function recordMissingPass(db: ScoutDb, path: string, now: number): number {
  db.prepare(
    `INSERT INTO pending_removals (path, first_missing_at, misses) VALUES (?, ?, 1)
     ON CONFLICT(path) DO UPDATE SET misses = misses + 1`
  ).run(path, now)
  const row = db.prepare(`SELECT misses FROM pending_removals WHERE path = ?`).get(path) as { misses: number }
  return row.misses
}

/** present/unknown 都要清零重计——复活或探测不确定都不该延续之前攒的 miss 计数（否则一次真实
 *  复活后紧跟着的下一次真实消失会被错误地立刻判定"已经连续够轮次"）。行不存在=无事发生。 */
function clearPendingRemoval(db: ScoutDb, path: string): void {
  db.prepare(`DELETE FROM pending_removals WHERE path = ?`).run(path)
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

/** 新 series/movie 行的一次性 TMDB 元数据补全（poster/year via getDetails；chinese_title 取
 *  getChineseTitles 第一条——D6：见文件底部说明，chinese_title 直接随 upsertSeries/upsertMovie
 *  的既有参数写入，不走任何单独 setter）。只在行首次创建时调用一次（调用方按"行是否已存在"
 *  门控），避免每集/每次重跑都重复两次 TMDB 请求。getDetails 失败（TmdbRequestFailedError）
 *  按 fail-soft 处理——poster/year 这类展示增益字段不该因为一次 TMDB 抖动就阻塞识别与覆盖
 *  分类这条主线（本行为与 getChineseTitles 自身已经 fail-soft 的哲学一致，tmdb.ts 全文档）。
 *  详情页重设计 item B：overview/backdropPath 现随新 series 行一并落库（series 新增两列，
 *  见 db.ts 末条迁移）——仅新剧首次入库路径回填；movie 分支与既有 movies 表不受影响。
 *  runtimeMinutes 仍由 getDetails 一并返回但不落 series/movies 列（喂 find-subtitle worker 用）。 */
async function enrichNewSeriesOrMovie(
  mediaType: 'tv' | 'movie',
  tmdbId: string,
  tmdb: TmdbClient,
  log: (msg: string) => void,
): Promise<{ posterPath: string | null; backdropPath: string | null; overview: string | null; year: number | null; chineseTitle: string | null; genres: number[] | null; originalTitle: string | null; imdbId: string | null }> {
  let posterPath: string | null = null
  let backdropPath: string | null = null
  let overview: string | null = null
  let year: number | null = null
  let genres: number[] | null = null
  let originalTitle: string | null = null
  try {
    const details = await tmdb.getDetails(mediaType, tmdbId)
    posterPath = details?.posterPath ?? null
    backdropPath = details?.backdropPath ?? null
    overview = details?.overview ?? null
    year = details?.year ?? null
    // 债务D6（已收尾）：404（getDetails 契约=返回 null，TMDB 权威答复查无此 id，永久态）时
    // genres 落 [] 而不是 null——null 不写列（见 libraryRepo 两条写路的 != null 判定），行会
    // 留在 `genres IS NULL` 候选里空转击穿每轮 10 个重试槽；[] 即"已有定论"，配合收窄后的
    // listSeriesNeedingEnrich 谓词当轮熄火（此前谓词还有 name='' 臂，404 空名行照样永留候选）。
    // 瞬时失败（下面 catch 分支）维持 null → 下轮重试，两种"没拿到"必须分开。
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
  return { posterPath, backdropPath, overview, year, chineseTitle: zhTitles[0] ?? null, genres, originalTitle, imdbId }
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
  // 三层防线①：checkFileGone 优先用注入值；否则若注入了旧 fileExists，从它派生（布尔只有
  // present/gone 两态，不产生 unknown——保持所有从未涉及这次改动的既有测试的行为不变）；两者
  // 都没注入（生产默认路径）才落到真实 statSync 的 errno 分三态实现（defaultCheckFileGone）。
  const checkFileGone: (p: string) => 'gone' | 'present' | 'unknown' =
    deps.checkFileGone ?? (deps.fileExists ? ((p: string) => (deps.fileExists!(p) ? 'present' : 'gone')) : defaultCheckFileGone)
  // 三层防线②③的可配阈值——env 覆盖同 cli/index.ts 里 SCAN_INTERVAL_MS 等既有旋钮的解析口径
  // （数字环境变量 → 数字常量兜底），deps 注入优先于 env（测试精确控制轮次/比例边界）。
  const removalConfirmPasses = deps.removalConfirmPasses ?? (Number(process.env.REMOVAL_CONFIRM_PASSES) || 2)
  const scanCollapseRatio = deps.scanCollapseRatio ?? (Number(process.env.SCAN_COLLAPSE_RATIO) || 0.5)
  const statFile = deps.statFile ?? defaultStatFile
  // 跨文件探针并发上限，默认 2（保守值的完整理由见 IngestDeps.probeConcurrency 头注释）。
  const probeConcurrency = deps.probeConcurrency ?? 2
  const { lib, tmdb, log } = deps

  return async function ingestPass(): Promise<IngestResult> {
    // 互斥：dashboard 触发的 reconcile-all 和甄别页 requestIngest 不检查锁，daemon tick 的 ingest
    // 分支有 hasActiveRealignWorkerTask 互斥——如果 ingest 已在跑，直接早退（不排队，不并发）。
    if (ingestLock.held) {
      return { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false, skipped: true }
    }
    ingestLock.held = true
    try {
      // 债务D5：语言配置每轮 pass 新鲜求值——设置页改 target_languages 后下一轮扫描即生效。
      const targetLanguages = deps.targetLanguages()
      const originSkipLanguages = deps.originSkipLanguages?.() ?? targetLanguages
      const excludeExtras = deps.excludeExtras?.() ?? false
      const hardsubMode = deps.hardsubMode?.() ?? 'off'
      const nowMs = deps.now ? deps.now() : Date.now()
      const result: IngestResult = { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false }
      const seenPaths = new Set<string>()
      // 债务D1（realign 出生信号换代）：本轮观察到的每个 series 的磁盘布局事实——
      // true=本轮至少一集路径不合规范形。movies 豁免（没有规范形概念）、parked 路径不参与
      // （没有 series 归属），pass 收尾处全量重写（见文件底部）。
      const layoutObserved = new Map<string, boolean>()
      // FULL PATH 的探针待办：path → 该文件本轮的 stat 指纹 + 路径解析出的 [tmdbid-N] 标签。
      // 走盘循环里只登记，真探测推迟到走盘结束后统一按 probeConcurrency 并发跑（云盘单文件探针
      // 12-16s，收益全在并发）。embeddedTmdbId 必须搭这趟车跨过"循环内算出 / 循环后落库"这道
      // 边界——它是 recognize() 在循环内产出的结构提示，而 upsertParkedPath 已被推迟到循环之后。
      const pendingProbes = new Map<string, { mtimeMs: number; size: number; embeddedTmdbId: string | null }>()

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
              lib.upsertParkedPath(path, 'excluded-extra', nowMs, { mtimeMs: stat.mtimeMs, size: stat.size })
              result.parked++
              continue
            }
            const existing = findRowByPath(lib.db, path)

            // ---- CHEAP PATH：行存在 + 探针记忆化命中当前 (mtime,size) → 只重跑覆盖分类 ----
            // 🔴 认领穿透（2026-07-26 审计 C1）：override 命中且与当前行身份不一致时，绝不能
            // 走 CHEAP PATH。认领（人工 P6 / agent identity_correction）落地不会改动视频文件
            // 本身的 mtime/size，而 recognize()（唯一咨询 findOverride 的地方）和"同路径换身份"
            // 的清旧行分支都在下面的 FULL PATH 里——不设这道穿透的话，任何已成功入库过的行
            // 都会永远命中 memo 而 continue，认领永久悬空、新身份永远建不出来，且没有任何
            // 自愈路径（全库无清 probe memo 的写口）。只在"身份确实不一致"时穿透：认领与现行
            // 身份一致（认领已生效后的每一轮）照常走 CHEAP PATH，不为一条已兑现的认领反复付
            // 全量识别的代价。
            const overrideForPath = existing ? lib.findOverride(path) : null
            const overrideDisagrees =
              overrideForPath != null &&
              existing != null &&
              tmdbIdFromOwnId(existing.id) !== overrideForPath.tmdbId
            if (existing && !overrideDisagrees) {
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

            // ---- FULL PATH：无行，或行存在但探针记忆化已过期 → 结构解析 + raw data 落 parked ----
            // parked-path 负缓存（Task 5）：未变 fingerprint 的已 park 路径按 1h→4h→24h 退避，
            // 跳过昂贵 recognize；seenPaths 已登记本 path，收尾清理不会误删。identify override
            // 强制立即 eligible（用户刚认领，必须重走识别）。
            const pathFingerprint = { mtimeMs: stat.mtimeMs, size: stat.size }
            if (
              !lib.shouldRetryParkedPath(path, pathFingerprint, nowMs) &&
              !lib.findOverride(path)
            ) {
              continue
            }
            const outcome = await deps.recognize(path)
            if ('park' in outcome) {
              lib.upsertParkedPath(path, outcome.park, nowMs, pathFingerprint)
              result.parked++
              continue
            }

            // outcome 是 PathIdentity：纯结构提示（title/year/season/episode/embeddedTmdbId 等
            // 机械解析信号），没有 tmdbId——身份裁决（TMDB 搜索/详情/建行）已上移到 agent 的
            // write_identified_media 工具；ingest 只采集原始探测数据并 park，等 agent 识别。
            // 唯一从 outcome 取用的字段是 embeddedTmdbId（路径里的 `[tmdbid-N]` 标签）：它是
            // agent 能拿到的最强起点，必须随文件落进 parked_paths 交给 agent 核验——此前它在
            // 这里被整体丢弃，导致本项目 buildTargetShowDir 写下的规范布局，下一轮扫描自己都
            // 认不出来。仍只是 hint：agent 必须过 TMDB 核验才能认领（见 identifyMediaSkill）。

            // 采集 raw data：时长 + 内嵌字幕轨语言。**跨文件**并发（见 pendingProbes 与循环
            // 之后的 mapWithConcurrency 一段）：云盘上单文件探针 12-16s 是 CDN 延迟地板，串行
            // 无从优化，唯一的收益来源是并发。这里只登记"这个文件要探针"，真探测与随后的
            // parking 推迟到走盘循环结束后统一做——本文件在这条分支上后续没有任何工作。
            // 按 path 去重（Map 而非数组）：原先探测与 parking 就在这条分支内联完成，若同一
            // path 在走盘里出现两次，第二次会撞上刚写的 park 行的负缓存而跳过、探针只跑一遍；
            // 推迟之后不去重就会跑两遍。走盘实现本不产生重复路径，这只是把等价性钉死。
            // embeddedTmdbId 一并登记：outcome 只在这个作用域里存在，parking 已在循环之外。
            pendingProbes.set(path, { ...stat, embeddedTmdbId: outcome.embeddedTmdbId })
            continue
          } catch (e) {
            // 同 daemon/selfScan.ts 的既有哲学："一个文件/一次 TMDB 抖动不能拖垮整轮 pass"——
            // 记日志，这个文件本轮既不算 upserted 也不算 parked，下一轮 pass 重试。
            const msg = e instanceof Error ? e.message : String(e)
            log(`ingest: failed for ${path}, will retry next pass: ${msg}`)
          }
        }
      }

      // ---- FULL PATH 第二阶段：raw data 探针（跨文件有界并发）+ parking ----
      // 走盘循环里每个待 park 的文件只登记进 pendingProbes，真探测集中在这里做——因为唯一能
      // 压缩云盘探针墙钟的手段是并发（阿里云盘经 rclone WebDAV 单文件 12-16s，其中 ~12s 是
      // CDN 延迟地板，绕过 FUSE 直读签名 URL 同样 12.1s，串行无从优化；4 并发实测 16.1s 墙钟）。
      // 语义必须与内联版逐字等价：
      //  · allSettled（mapWithConcurrency）而非 Promise.all——ingest 的铁律是"一个文件/一次抖动
      //    不能拖垮整轮 pass"，Promise.all 一个 reject 会连带丢弃其余已完成的探测结果，把单文件
      //    探针失败升级成整批 raw data 丢失（正是本层最不能出的错：raw evidence 被污染）。
      //  · 同一文件内 duration 与轨道两个探针仍各自独立 try/catch 且**顺序**执行，调用次数、
      //    实参、日志措辞全部不变（"probeDuration failed for …" / "probe failed for …" 有既成的
      //    运维习惯依赖）。
      //  · 结果按下标归属（mapWithConcurrency 保序 + 任务自带 path），绝不按完成顺序——每个文件
      //    的 upsertParkedPath 只拿它自己那份 durationSec/embeddedLangs。走盘循环内算出的
      //    embeddedTmdbId 同样按下标归属（它随 pendingProbes 的 value 一起过界，与 stat 同行，
      //    天然不会串台）。
      // parking 与 result.parked 计数留在这个串行的 for 里（DB 写入是同步的 better-sqlite3，
      // 并发化没有收益，串行也保证了计数与写序确定）。
      const probeTargets = [...pendingProbes]
      const probed = await mapWithConcurrency(
        probeTargets,
        probeConcurrency,
        async ([path]) => {
          let durationSec: number | null = null
          let embeddedLangs: string[] | null = null

          try {
            durationSec = await deps.probeDuration(path)
          } catch (err) {
            deps.log(`probeDuration failed for ${path}: ${err}`)
          }

          try {
            const tracks = await deps.probe(path)
            embeddedLangs = tracks === null ? null : usableEmbeddedLangs(tracks)
          } catch (err) {
            deps.log(`probe failed for ${path}: ${err}`)
          }

          return { durationSec, embeddedLangs }
        },
      )

      for (let i = 0; i < probeTargets.length; i++) {
        const [path, stat] = probeTargets[i]
        const settled = probed[i]
        try {
          // rejected 理论不可达（探针任务体自身把两个探测都 try/catch 兜住了，不会向外抛），
          // 但真出了意料外的抛错（如 usableEmbeddedLangs 遇到畸形轨道数据）也绝不能让这个文件
          // 拖走其余文件的 parking——按"两个字段都没探到"处理，照常落 park 行，下一轮重探。
          const raw = settled.status === 'fulfilled'
            ? settled.value
            : { durationSec: null, embeddedLangs: null }
          if (settled.status === 'rejected') {
            log(`ingest: probe stage failed for ${path}, parking without raw data this pass: ${settled.reason}`)
          }

          // Park with raw data for agent identification。fingerprint 的 durationSec/embeddedLangs
          // 是 optional（undefined=本次未探测，指纹未变时保留库中已有值），故 null → undefined 换算。
          // embeddedTmdbId 不做这个换算：它不是"探测"结果而是路径解析产物，null 就是权威的
          // "这条路径没有标签"，直接透传（列语义见 db.ts v26 迁移注释）。
          lib.upsertParkedPath(
            path,
            'awaiting-agent-identification',
            nowMs,
            {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              durationSec: raw.durationSec ?? undefined,
              embeddedLangs: raw.embeddedLangs ?? undefined,
              embeddedTmdbId: stat.embeddedTmdbId,
            }
          )
          result.parked++
        } catch (e) {
          // 同走盘循环的既有哲学：一个文件的 parking 失败不拖垮整轮 pass，下一轮重试。
          const msg = e instanceof Error ? e.message : String(e)
          log(`ingest: failed for ${path}, will retry next pass: ${msg}`)
        }
      }


      // ---- 磁盘真相移除：本轮走盘没见到 + 磁盘复核确认真的不在了 → 行退役 ----
      // 三层防线（CIFS 挂载抖动误删修复——审计头号遗留，2026-07-18）：原先的"双重条件"
      // （!seenPaths.has(path) && !fileExists(path)）在**整个挂载闪断**场景下两个信号同源
      // 失效——walk() 对 readdirSync 报错 catch 后跳过整棵子树（根目录抛错→seenPaths 整根为
      // 空），默认 fileExists 对 ESTALE/ETIMEDOUT/EIO/ENOTCONN（CIFS 抖动典型 errno）与
      // ENOENT 无差别折叠成 false——一轮 pass 内该根全部条目被判"消失"，级联删 subtitles/series，
      // 物理文件无损但 DB 认知/用户纠正全丢。三层缺一不可，各自堵一类失效面：
      //  ①errno 区分（checkFileGone）——ENOENT/ENOTDIR 才是"确认不在"，其它 errno 判 'unknown'，
      //   本轮该路径原地不动（不进 pending_removals 计数，也不清零——真正的"不确定"，什么都不做）；
      //  ②消失去抖（pending_removals）——'gone' 只记账，连续 removalConfirmPasses 轮确认才真删，
      //   期间任何一轮 present/unknown 都清零重计；
      //  ③骤降哨兵（rootsCollapsed，pass 级）——某根本轮 seenPaths 相对已知库存暴跌时，整根
      //   跳过本轮全部移除。①②各自看的是单条路径的信号，堵不住"walk 根节点直接抛错导致
      //   seenPaths 整根为空"这种批量场景——③是这场景的最后闸门。
      // 晋升（promoteOldestReplica）是自愈性动作——不丢数据，误判也能在挂载恢复后的下一轮自我
      // 纠正——不需要等 removalConfirmPasses 这道确认闸，'gone' 就立即尝试；只有"无副本可晋升"
      // 这条真正会丢数据（级联删 subtitles/series）的分支才必须过这道闸。
      const episodeRows = lib.db.prepare('SELECT id, path, series_id FROM episodes').all() as
        { id: string; path: string; series_id: string }[]
      const movieRows = lib.db.prepare('SELECT id, path FROM movies').all() as { id: string; path: string }[]

      // 骤降哨兵：按根分组，"已知"=该根前缀下的 episodes+movies 路径数，"seen"=本轮 seenPaths
      // 命中同一前缀的数量。已知 < 10 的根不设防——样本太小，比例天然抖动，误伤（该删的也不删）
      // 成本高于收益；这也保持了绝大多数小规模场景/测试下的既有行为（旧测试的库通常只有个位数
      // 条目，从未触发这一层）。
      const rootsCollapsed = new Set<string>()
      for (const root of deps.roots()) {
        const known =
          episodeRows.filter(r => pathUnderRoot(r.path, root)).length +
          movieRows.filter(r => pathUnderRoot(r.path, root)).length
        if (known < 10) continue
        let seen = 0
        for (const p of seenPaths) if (pathUnderRoot(p, root)) seen++
        if (seen < known * scanCollapseRatio) {
          rootsCollapsed.add(root)
          console.error(
            `ingest: SCAN COLLAPSE guard tripped for root "${root}" — this pass saw ${seen}/${known} ` +
            `known library paths under it (ratio ${(seen / known).toFixed(2)} < ${scanCollapseRatio}); ` +
            `skipping ALL removal under this root this pass (mount-vanished guard)`
          )
        }
      }
      const isCollapsedRoot = (path: string): boolean => {
        for (const root of rootsCollapsed) if (pathUnderRoot(path, root)) return true
        return false
      }

      // 重复源 P2：item_files 副本清理**必须先于**下面的主文件退役循环——死副本先出表，晋升时
      // listItemFiles 只会看到仍在盘上的副本，promoteOldestReplica 不会把主文件 path 指向一个
      // 同样已消失的副本（否则要多轮扫描才收敛，中途主文件指向死文件）。三层防线同样覆盖这一
      // 环：错判"副本消失"会撤走 promoteOldestReplica 的安全网，把风险直接转嫁给下面的主文件
      // 循环（item_files 一旦被错删，同一轮里主文件的晋升就找不到它了）。
      for (const f of lib.db.prepare('SELECT path FROM item_files').all() as { path: string }[]) {
        // 文件本轮被走盘到(present)=消失序列中断,去抖计数必须清零——否则"消失→复现→再消失"会被
        // 误计为连续两轮消失而触发误删(防线②去抖本要防的正是非连续消失)。骤降哨兵根整根跳过,连
        // pending 都不碰(挂载抖动,保留跨轮状态)。
        if (seenPaths.has(f.path)) { clearPendingRemoval(lib.db, f.path); continue }
        if (isCollapsedRoot(f.path)) continue
        const state = checkFileGone(f.path)
        if (state !== 'gone') { clearPendingRemoval(lib.db, f.path); continue }
        const misses = recordMissingPass(lib.db, f.path, nowMs)
        if (misses >= removalConfirmPasses) {
          clearPendingRemoval(lib.db, f.path)
          lib.removeItemFileByPath(f.path)
          result.changed = true
        }
      }
      for (const row of episodeRows) {
        // present=消失序列中断,去抖计数清零(见 item_files 循环同款注释);骤降哨兵根整根跳过不碰 pending。
        if (seenPaths.has(row.path)) { clearPendingRemoval(lib.db, row.path); continue }
        if (isCollapsedRoot(row.path)) continue
        const state = checkFileGone(row.path)
        if (state !== 'gone') { clearPendingRemoval(lib.db, row.path); continue }
        // 重复源 P2：主文件消失但仍有（存活的）副本 → 最年长副本晋升顶替，条目不退役
        // （自愈动作，见上方总注释——不受 removalConfirmPasses 门控）。
        if (lib.promoteOldestReplica(row.id) !== null) {
          clearPendingRemoval(lib.db, row.path)
          result.changed = true
          continue
        }
        // 无副本可晋升才是真正会丢数据的分支——过消失去抖这道闸。
        const misses = recordMissingPass(lib.db, row.path, nowMs)
        if (misses >= removalConfirmPasses) {
          clearPendingRemoval(lib.db, row.path)
          lib.deleteEpisodeByPath(row.path)
          lib.deleteSeriesIfEmpty(row.series_id)
          result.removed++
          result.changed = true
        }
      }
      for (const row of movieRows) {
        // present=消失序列中断,去抖计数清零(见 item_files 循环同款注释);骤降哨兵根整根跳过不碰 pending。
        if (seenPaths.has(row.path)) { clearPendingRemoval(lib.db, row.path); continue }
        if (isCollapsedRoot(row.path)) continue
        const state = checkFileGone(row.path)
        if (state !== 'gone') { clearPendingRemoval(lib.db, row.path); continue }
        if (lib.promoteOldestReplica(row.id) !== null) {
          clearPendingRemoval(lib.db, row.path)
          result.changed = true
          continue
        }
        const misses = recordMissingPass(lib.db, row.path, nowMs)
        if (misses >= removalConfirmPasses) {
          clearPendingRemoval(lib.db, row.path)
          lib.deleteMovieByPath(row.path)
          result.removed++
          result.changed = true
        }
      }
      // parked_paths 同理清理（不计入 removed——那是 episodes/movies 行退役的计数，park 户口
      // 消失是另一件事，P6 救援页读 listParkedPaths 时自然看不到已经不在盘上的路径）。低风险、
      // 可自愈（文件真的还在的话下一轮会被重新 park）——只接入①errno 区分（unknown 不清），不
      // 接入②消失去抖/③骤降哨兵这两层重武装，维持既有单轮清理的响应速度。
      for (const p of lib.listParkedPaths()) {
        if (!seenPaths.has(p.path) && checkFileGone(p.path) === 'gone') {
          lib.clearParkedPath(p.path)
        }
      }
      if (result.removed > 0) result.changed = true
      // Agent-first 识别的触发缺口（2026-07-28 真库阶段一实测发现）：旧世界里新文件建行
      // （upserted++ → changed → orchestrate 入队），重构后新文件只 park 不建行，而 park
      // 从未接入 changed——于是 73 个新 park 的文件安静地躺着，orchestrator 要等 24h 兜底
      // 心跳才知道有活干。新 park（本轮把从未见过/证据已变的文件停进户口）就是库状态变化，
      // 必须触发编排；负缓存跳过的既有 parked 行不计入 result.parked，不会造成每轮空触发。
      if (result.parked > 0) result.changed = true

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
      // （历史上的机械识别层由 TMDB /search/tv 命中标题给出；该层已随 resolveToTmdb 一并删除），
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
            overview: enrich.overview,
            backdropPath: enrich.backdropPath,
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
