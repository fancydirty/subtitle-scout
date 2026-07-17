import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmdirSync, rmSync } from 'node:fs'
import { join, dirname, basename, sep, resolve } from 'node:path'
import {
  isDirWritable, isUnderRoots, containingRoot, mapPath, type PathMapping,
} from '../core/mediaContext.js'
import { probeHardlink, probeRenameBetween, type ProbeOutcome } from '../files/mountCapabilities.js'
import {
  sanitizeTitleForFs, scanVideoFiles, buildRealignPlan, buildTargetShowDir,
  crossCheckAnimeLists, checkRuntimeTolerance,
  type RealignPlanItem, type RealignPlanConfig,
} from '../files/libraryRealign.js'
import {
  initManifest, appendManifestEntry, appendRollbackMarker, manifestPath, readManifest, replayRollback,
  type ManifestDoc,
} from '../files/realignManifest.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'
import { fetchTmdbEnrichment } from './findSubtitleWorkerTask.js'
import { episodeId } from './ownIds.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, Job } from './jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { AnimeListsEntry } from '../adapters/providers/animeLists.js'

export interface MountSentinelResult { ok: boolean; reason?: string }

/**
 * 哨兵防线：动手前验证挂载活着。SMB 掉挂载在很多环境下看起来像一个空目录（而不是报错），
 * 是整理型守护毁库的经典死法——库根必须非空 + 真实可写，两条都过才放行。
 */
export function mountAliveSentinel(libRoot: string): MountSentinelResult {
  if (!existsSync(libRoot)) return { ok: false, reason: `库根不存在：${libRoot}` }
  let entries: string[]
  try {
    entries = readdirSync(libRoot)
  } catch (e) {
    return { ok: false, reason: `无法读取库根：${String(e)}` }
  }
  if (entries.length === 0) return { ok: false, reason: `库根为空——疑似挂载掉线，拒绝执行：${libRoot}` }
  if (!isDirWritable(libRoot)) return { ok: false, reason: `库根不可写：${libRoot}` }
  return { ok: true }
}

export type RealignStrategy = 'hardlink' | 'rename' | 'abandon'

/**
 * 降级阶梯：不可写→abandon；探明支持硬链接→hardlink（保种，优先）；否则看 rename 是否探明
 * 跨库根↔归档目录原子（EXDEV 探测）→ rename；否则→abandon。宁不做，不做烂——绝不 copy。
 * 探针是三态的（mountCapabilities.ProbeOutcome）：'unknown'（没条件探）绝不能当探出来了——
 * hardlink unknown 只是不走硬链接优先分支（rename 探明原子仍可整理）；renameAtomic
 * unknown/false 一律 abandon（无法证明原子性的 rename 可能把文件复制到一半断电）。
 * GAP B（re-review #2，one-line SHIP-blocking）：renameAtomic 的检查必须先于 hardlink 判断、
 * 且对 hardlink 结果同样生效——'hardlink' 只是省了 assembleInvisibleTree/finalizeShowDir
 * 那几跳 rename 的硬链接优化提示，实现里其实从未真正走硬链接路径（见 executeRealign 步骤 7b
 * 注释：全程只走 rename 一条执行路径）；archiveOldDir（步骤 14）在任何 strategy 下都无条件
 * 用 renameSync 把旧目录整棵搬进归档，若归档根跨设备（EXDEV）,这一步会失败/半途而废——
 * 与 strategy 是否探明支持硬链接无关。因此 renameAtomic !== true 必须直接 abandon，绝不能
 * 被"探明支持硬链接"绕过。
 */
export function chooseRealignStrategy(
  caps: { writable: boolean; hardlink: ProbeOutcome }, renameAtomic: ProbeOutcome,
): RealignStrategy {
  if (!caps.writable) return 'abandon'
  if (renameAtomic !== true) return 'abandon'
  if (caps.hardlink === true) return 'hardlink'
  return 'rename'
}

/** 归档位置：<归档根>/.archive/<剧名>-<时间戳>/。归档根必须在媒体库根之外（Jellyfin 不看），
 *  但通常在同一 share 内（rename 保持原子——由 probeRenameBetween 探明）。归档根解析顺序见
 *  executeRealign：deps.archiveRoot > REALIGN_ARCHIVE_ROOT 环境变量 > 库根上一级（默认）。
 *  剧名走与目标目录同一套文件系统安全化（'Fate/Zero' 不得拆层）。 */
export function archiveDirFor(archiveRootBase: string, seriesTitle: string, nowMs: number): string {
  return join(archiveRootBase, '.archive', `${sanitizeTitleForFs(seriesTitle)}-${nowMs}`)
}

export interface CollisionQuarantineItem extends RealignPlanItem { reason: string }

export interface CollisionPlan {
  toMove: RealignPlanItem[]
  alreadyDone: RealignPlanItem[]
  quarantine: CollisionQuarantineItem[]
}

/**
 * 碰撞检查（在真正搬任何文件之前跑）：目标位置（<libRoot>/<targetRelPath>）已存在——
 * 同尺寸视为上一次（可能崩溃的）运行已经完成，跳过（幂等 no-op）；不同尺寸不覆盖，隔离标记。
 * 不存在则正常纳入待搬列表。
 */
export function planCollisions(
  items: RealignPlanItem[], libRoot: string, getSize: (path: string) => number | null,
): CollisionPlan {
  const toMove: RealignPlanItem[] = []
  const alreadyDone: RealignPlanItem[] = []
  const quarantine: CollisionQuarantineItem[] = []
  for (const item of items) {
    const finalPath = join(libRoot, item.targetRelPath)
    const existingSize = getSize(finalPath)
    if (existingSize == null) {
      toMove.push(item)
      continue
    }
    const sourceSize = getSize(item.sourcePath)
    if (sourceSize != null && existingSize === sourceSize) {
      alreadyDone.push(item)
    } else {
      quarantine.push({ ...item, reason: `目标已存在但尺寸不同（已存在 ${existingSize} vs 源 ${sourceSize ?? '未知'}）` })
    }
  }
  return { toMove, alreadyDone, quarantine }
}

export function invisibleBuildDir(libRoot: string, showDirName: string): string {
  return join(libRoot, '.realign-build', showDirName)
}

/**
 * 不可见组装：把 toMove 列表里每个文件 rename 进 `.realign-build/<show>/...` 对应位置
 * （同文件系统单跳 rename，与视频原本同根，前提在 mount 哨兵已经验过）。onEntry 回调必须
 * 在 renameSync 之前调用（write-ahead：调用方在 onEntry 里做 manifest.appendManifestEntry），
 * 任何挂载上 Jellyfin 只能观测到 `.realign-build/` 这个点前缀目录，感知不到半成品。
 * build 目标位置已有文件时拒绝覆盖并抛错（IMP#5）——静默 clobber 会吞掉上一轮残留或
 * 并发写入的文件；抛错交给调用方走统一的回滚路径。
 */
export function assembleInvisibleTree(
  libRoot: string, showDirName: string, items: RealignPlanItem[],
  onEntry: (from: string, to: string) => void,
): void {
  const buildDir = invisibleBuildDir(libRoot, showDirName)
  mkdirSync(buildDir, { recursive: true })
  const ignorePath = join(libRoot, '.realign-build', '.ignore')
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, 'subtitle-scout realign staging — media servers should not scan this directory\n')
  }
  for (const item of items) {
    const targetPath = join(libRoot, '.realign-build', item.targetRelPath)
    if (existsSync(targetPath)) {
      throw new Error(`组装目标已存在，拒绝覆盖：${targetPath}`)
    }
    mkdirSync(dirname(targetPath), { recursive: true })
    onEntry(item.sourcePath, targetPath)
    renameSync(item.sourcePath, targetPath)
  }
}

/**
 * 最后一次目录级原子 rename：`.realign-build/<show>` → `<libRoot>/<show>`。目标已存在时
 * 拒绝覆盖并抛错（调用方决定如何处理，不在这里静默吞并两棵树）。
 */
export function finalizeShowDir(libRoot: string, showDirName: string): string {
  const from = invisibleBuildDir(libRoot, showDirName)
  const to = join(libRoot, showDirName)
  if (existsSync(to)) throw new Error(`目标目录已存在，拒绝覆盖：${to}`)
  renameSync(from, to)
  return to
}

/**
 * 旧目录一次 rename 进归档（<归档根>/.archive/<剧名>-<时间戳>/<oldDir 的 basename>）。
 * 归档目录内放空 `.ignore` 双保险（调研结论：点前缀目录被 Jellyfin 各版本反复横跳，
 * 不能只靠命名习惯）。永不删除——保留期交给用户（dashboard 显示占用，不自动清）。
 */
export function archiveOldDir(oldDir: string, archiveDir: string): string {
  mkdirSync(archiveDir, { recursive: true })
  const ignorePath = join(archiveDir, '.ignore')
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, 'subtitle-scout realign archive — permanent, never auto-cleaned by this tool\n')
  }
  const finalPath = join(archiveDir, basename(oldDir))
  renameSync(oldDir, finalPath)
  return finalPath
}

/**
 * 字幕先行阶段单集任务字段：此刻 Jellyfin/ingest 尚未刮新结构、镜像无条目，identify 所需的
 * 身份/tmdbid/季集/视频路径全在整理计划里，字面构造即可，不需要 jf.getItem。
 *
 * C-B4/A-F13 处决（考古定罪，裁决 R-7）：老实现在这里先拍一个 MediaContextSchema.parse(...)
 * 出来（借旧管线遗留的 MediaContext 当传声筒——trigger 恒 'library_scan'、
 * existing_subtitles/production_locations 等一堆恒空字段），再在 makeRealignRunEpisode 里把
 * 这个 MediaContext 拍扁回 FindSubtitleTask 的字段——两次转译，且中间那次还把 TMDB 本来查得到
 * 的 original_title/alternative_titles/overview/runtime_minutes 硬编码成 null/[]（文件刚被
 * 重编号、最需要佐证候选归属的时刻反而拿到最少证据）。现在直接构造 FindSubtitleTask 缺
 * jobId/mediaRoot 之外的全部字段本身——enrichment 参数来自调用方一次性取得的
 * fetchTmdbEnrichment 结果（findSubtitleWorkerTask.ts 导出，与非 realign 路径共用同一份
 * TMDB 富化实现，不重新发明）。
 */
export interface RealignEpisodeFields {
  title: string
  originalTitle: string | null
  year: number
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
  videoPath: string
  videoFilename: string
  season: number
  episode: number
  /** episodes 自有 id 空间的形状（ownIds.ts 的 episodeId）——这一集尚未被 ingest 重新扫描
   *  identify 之前就能字面拼出，且与 ingest 事后在新路径下识别出的同一集会得到的 episodes.id
   *  完全一致（tmdbId 钉死、季集来自整理计划），不是随手编的占位符。 */
  itemId: string
}

export function buildRealignEpisodeFields(
  seriesTitle: string, year: number, tmdbId: string, item: RealignPlanItem, videoPath: string,
  enrichment: {
    originalTitle: string | null; alternativeTitles: string[]
    overview: string | null; runtimeMinutes: number | null
  },
): RealignEpisodeFields {
  return {
    title: seriesTitle,
    originalTitle: enrichment.originalTitle,
    year,
    alternativeTitles: enrichment.alternativeTitles,
    overview: enrichment.overview,
    runtimeMinutes: enrichment.runtimeMinutes,
    providerIds: { tmdb: tmdbId },
    videoPath,
    videoFilename: basename(videoPath),
    season: item.targetSeason,
    episode: item.targetEpisode,
    itemId: episodeId(tmdbId, item.targetSeason, item.targetEpisode),
  }
}

const REALIGN_BUILD_SEGMENT = `${sep}.realign-build${sep}`

/**
 * FindSubtitleTask.mediaRoot 必须是"已配置的媒体库根"（libRoot，包含 .realign-build 的那一级），
 * 不是这一集自己的深层 outDir（<libRoot>/.realign-build/<show>/Season NN/）——两个原因都是
 * 安全/正确性问题，不是风格偏好：
 *  1. makeFindSubtitleWorker 的沙盒判定是 isUnderRoots(dirname(videoPath), [mediaRoot])——用
 *     libRoot（videoPath 的祖先目录）自然通过；
 *  2. stagingSandbox.allocate(jobId, mediaRootForVideo) 把试错沙盒挂在
 *     `<mediaRootForVideo>/.subtitle-staging/<jobId>/`，而 gcOrphans 只在每个"配置根"一级
 *     非递归扫这个目录——挂在更深的 outDir 上，硬杀在 allocate/cleanup 之间发生就永远泄漏，
 *     没有任何清扫路径够得到它。
 * 字幕先行阶段视频还在 `<libRoot>/.realign-build/<targetRelPath>` 里（亮相之前），libRoot 就是
 * `.realign-build` 这一段之前的路径——从 outDir 反着切出来，不需要改动 deps.runEpisode 的调用
 * 签名（executeRealign 的调用点保持 (ctx, outDir, jobId) 不变，见下方 makeRealignRunEpisode）。
 */
function libRootFromRealignBuildDir(outDir: string): string {
  const idx = outDir.indexOf(REALIGN_BUILD_SEGMENT)
  if (idx === -1) {
    throw new Error(`字幕先行 outDir 不含 .realign-build 段，无法推导库根（find-subtitle worker 的沙盒 mediaRoot 必需）：${outDir}`)
  }
  return outDir.slice(0, idx)
}

/**
 * runEpisode 接线（realign 版，v3 old-pipeline-retirement Wall ②）：不再走旧 callStructured
 * 管线（runPipeline），而是把 ctx 翻译成一个 FindSubtitleTask，直接跑 v3 的 find-subtitle worker
 * （src/agent/findSubtitleWorker.ts 的 makeFindSubtitleWorker(...) 产出的 runFindSubtitleTask）。
 * 那个 worker 自带沙盒（isUnderRoots）、staging、装机、清理，这里只负责字段映射，不复刻任何一层。
 *
 * mediaRoot 的选择是这次改动唯一微妙的地方——见 libRootFromRealignBuildDir 的注释：必须是
 * libRoot，不是这一集自己的深层目录。
 *
 * withJournal/journalDir 不再需要：那是旧管线 callStructured 的 apiCall/自愈事件记账机制
 * （assrt/llm 回调经 AsyncLocalStorage 取当前 journal 写入），find-subtitle worker 走自己的
 * ToolLoopAgent + telemetry（stderr 打点 `[find-subtitle-worker] job ... finished in N step(s)`），
 * 没有任何代码路径依赖这条 realign 调用链上的 journal——去掉是纯减负，不丢观测。
 *
 * 不再有"默认真实实现"可 import（老代码默认走模块顶层 import 的 runPipeline；find-subtitle
 * worker 的构造需要 model/adapters/cacheRoot 这些运行时依赖，理应由调用方——cli/index.ts 的
 * cmdWatch——组装，不该让这个纯字段映射的模块反过来引入 agent/llm 那一整套）。因此
 * runFindSubtitleTask 是必需参数，不是可选的 opts 覆盖——调用方（生产走真实
 * makeFindSubtitleWorker(...)，测试走假函数）永远显式传入，注入点同样清楚。
 */
export function makeRealignRunEpisode(
  deps: { runFindSubtitleTask: (task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>; targetLanguage?: string },
): (ctx: RealignEpisodeFields, outDir: string, jobId: string) => Promise<unknown> {
  return async (ctx, outDir, jobId) => {
    const task: FindSubtitleTask = {
      jobId,
      mediaRoot: libRootFromRealignBuildDir(outDir),
      title: ctx.title,
      originalTitle: ctx.originalTitle,
      year: ctx.year,
      alternativeTitles: ctx.alternativeTitles,
      overview: ctx.overview,
      runtimeMinutes: ctx.runtimeMinutes,
      providerIds: ctx.providerIds,
      // A4: primary configured target language (TARGET_LANGUAGES[0], wired by cli/index.ts);
      // multi-language per-item tasking is future work.
      targetLanguage: deps.targetLanguage ?? 'zh',
      targets: [{
        itemId: ctx.itemId,
        videoPath: ctx.videoPath,
        videoFilename: ctx.videoFilename,
        season: ctx.season,
        episode: ctx.episode,
        // R-7 窄 diff：realign 的绝对集号（RealignPlanItem.absoluteEpisode，anime-lists 交叉
        // 验证过）与 FindSubtitleTargetFact.absoluteEpisode 语义不同源（后者是 worker 自用的
        // 归属定位 hint，来自 TMDB 绝对集表 resolveAbsoluteTable/absoluteFor）——两套来源不
        // 混用，此处显式 null；worker 靠 season/episode + title/tmdbId 判断归属，绝对集号
        // 缺席不是 blocker（同 findSubtitleWorker.schemas.ts 该字段自己的文档）。
        absoluteEpisode: null,
        // 验收轮一（imdb 采集）：realign 字幕先行的上下文（RealignSubtitleContext）不携带
        // provider_ids，无 imdb 可传——显式 null（worker 靠标题/季集判断归属，同上一字段的
        // 缺席语义；不许在这里编造或反查，宁缺毋假）。
        imdbId: null,
      }],
    }
    return deps.runFindSubtitleTask(task)
  }
}

export interface ScheduledTaskLike { id: string; name: string; isRunning: boolean }

/**
 * 等自家 ingest 走盘锁空闲（C-B3 改名前旧名 waitForJellyfinIdle——旧注释主语是 Jellyfin 扫描，
 * 去 Jellyfin 化 P5 之后这里等的其实一直是 realignLibraryPort.ts 的 ingestLock.held，主语记错了
 * 人；等待逻辑本体一行未动）。调研红线：走盘中挪文件=重复条目灾难。轮询直到无任务在跑或超时。
 * sleep/now 均可注入（测试用假时钟，不真等也不篡改全局 Date.now）。
 */
export async function waitForIngestIdle(
  jf: { getScheduledTasks(): Promise<ScheduledTaskLike[]> },
  opts: { pollMs: number; timeoutMs: number; sleep: (ms: number) => Promise<void>; now?: () => number },
): Promise<boolean> {
  const now = opts.now ?? Date.now
  const deadline = now() + opts.timeoutMs
  while (true) {
    const tasks = await jf.getScheduledTasks()
    if (!tasks.some(t => t.isRunning)) return true
    if (now() >= deadline) return false
    await opts.sleep(opts.pollMs)
  }
}

/**
 * 去 Jellyfin 化 P7（design §P7 代码出口）：players/jellyfin.ts、players/types.ts 已整体删除
 * （JellyfinItem/PlayerServer 随之消失）——本文件对"媒体条目"的类型需求收窄到这里实际读取
 * 的字段，不再从已退役的 Jellyfin 适配层引入完整线格式。verifyRealignedCounts 只读
 * Type/Path/ParentIndexNumber（下方 Pick）；executeRealign 的 jf.getItem(seriesId) 只读
 * Name/ProductionYear/ProviderIds?.Tmdb（:588-592 一带）。纯类型搬移，不改变任何一行运行时
 * 逻辑——[key: string]: unknown 索引签名保留旧 JellyfinItemSchema.passthrough() 的宽松度，
 * 让 realignLibraryPort.ts 现有的字面量返回值（多带 Id 等未列出字段）继续免改动通过类型检查。
 */
export interface RealignMediaItem {
  Type: string
  Name: string
  Path?: string | null
  ProductionYear?: number | null
  ParentIndexNumber?: number | null
  ProviderIds?: Record<string, string> | null
  [key: string]: unknown
}

/**
 * 验收：按新目录路径前缀统计 Jellyfin 实际刮出的各季集数，与计划值比对。复用既有
 * getItemsPage（已带 Path 字段），不需要新增端点——按 Path 是否落在新目录路径之下过滤
 * （按路径段切割，"Show Extended" 不会蹭进 "Show" 的账），旧目录残留（尚未清理/尚未重刮）
 * 天然被排除在统计之外。IMP#8：item.Path 是 Jellyfin 视角的路径，比对本地新目录前缀之前
 * 必须过一遍 MEDIA_PATH_MAPPINGS（不映射的话映射部署下验收永远数出 0 集）。
 */
export async function verifyRealignedCounts(
  jf: { getItemsPage(startIndex: number, limit: number): Promise<Pick<RealignMediaItem, 'Type' | 'Path' | 'ParentIndexNumber'>[]> },
  newShowDirPath: string, expectedCounts: Map<number, number>,
  opts: { pageSize: number; mappings?: PathMapping[] },
): Promise<{ ok: boolean; detail: string }> {
  const prefix = newShowDirPath.endsWith(sep) ? newShowDirPath : newShowDirPath + sep
  const mappings = opts.mappings ?? []
  const actualCounts = new Map<number, number>()
  let startIndex = 0
  while (true) {
    const items = await jf.getItemsPage(startIndex, opts.pageSize)
    if (items.length === 0) break
    for (const item of items) {
      const localPath = item.Path ? mapPath(item.Path, mappings) : null
      if (item.Type === 'Episode' && localPath?.startsWith(prefix) && item.ParentIndexNumber != null) {
        actualCounts.set(item.ParentIndexNumber, (actualCounts.get(item.ParentIndexNumber) ?? 0) + 1)
      }
    }
    startIndex += opts.pageSize
  }
  for (const [season, expected] of expectedCounts) {
    const actual = actualCounts.get(season) ?? 0
    if (actual !== expected) {
      return { ok: false, detail: `第 ${season} 季验收：走盘计数 ${actual} 集，计划 ${expected} 集，不一致` }
    }
  }
  return { ok: true, detail: '各季集数与计划一致' }
}

export interface RealignLibraryPort {
  getItem(itemId: string): Promise<RealignMediaItem>
  getItemsPage(startIndex: number, limit: number): Promise<RealignMediaItem[]>
  getScheduledTasks(): Promise<ScheduledTaskLike[]>
  getVirtualFolders(): Promise<{ id: string; name: string; locations: string[] }[]>
  refreshLibrary(libraryId: string): Promise<void>
}

export interface RealignExecutorDeps {
  lib: LibraryRepo
  jobs: Pick<JobsRepo, 'setPlanRef' | 'retireAllForSeries'>
  jf: RealignLibraryPort
  /** A-F13：getDetails/getChineseTitles 是 realign 字幕先行阶段的富化补面（见步骤 12 附近的
   *  fetchTmdbEnrichment 调用）——可选（Partial），不强改所有既有调用方/测试；未接线时按
   *  fetchTmdbEnrichment 自己的 gain-path 降级处理（tmdb 传 null → originalTitle/
   *  alternativeTitles/overview/runtimeMinutes 全部 null/[]），绝不因为缺这两个方法而抛错。 */
  tmdb: Pick<TmdbClient, 'getSeasonTable'> & Partial<Pick<TmdbClient, 'getDetails' | 'getChineseTitles'>>
  fetchAnimeLists: () => Promise<AnimeListsEntry[]>
  /** Wall ②（old-pipeline-retirement）：不再是 runPipeline 的 PipelineResult——现在是
   *  makeRealignRunEpisode（v3 find-subtitle worker 接线）的返回值。调用方（executeRealign
   *  步骤 12）本就丢弃返回值、只关心是否抛错（抛错被 catch 记录，不阻塞整理），因此这里放宽
   *  成 Promise<unknown>，不为一个从不被读取的返回值杜撰假的 PipelineResult 形状。 */
  runEpisode: (ctx: RealignEpisodeFields, outDir: string, jobId: string) => Promise<unknown>
  now: () => number
  log: (msg: string) => void
  sleep: (ms: number) => Promise<void>
  getSize: (path: string) => number | null
  getDurationSeconds?: (path: string) => number | null
  /** CRIT#1：本地媒体根白名单（与 makeRunEpisode 的 opts.mediaRoots 同源——MEDIA_ROOTS +
   *  MEDIA_PATH_MAPPINGS 的 to 侧）。库根只能从"已配置的根"里按最长前缀匹配推导，
   *  绝不按目录层数猜（dirname(dirname(...)) 在二层平铺库上会把剧搬到库外）。 */
  mediaRoots: string[]
  /** IMP#8：MEDIA_PATH_MAPPINGS——镜像里的集路径、getVirtualFolders 的 locations、验收时
   *  getItemsPage 的 item.Path 全是 Jellyfin 视角的路径，任何 fs 操作前必须映射到本地。 */
  mappings: PathMapping[]
  /** IMP#9：归档根覆盖（生产接线从 REALIGN_ARCHIVE_ROOT 环境变量注入）。未提供时依次落
   *  REALIGN_ARCHIVE_ROOT 环境变量 → 库根上一级目录（默认，与库根同 share 保 rename 原子）。 */
  archiveRoot?: string
  /** 挂载能力探测（可选注入，测试用假探针；默认走真实 mountCapabilities.ts 的
   *  probeHardlink/probeRenameBetween）。返回值直接喂给 chooseRealignStrategy。 */
  probeStrategy?: (libRoot: string, archiveDir: string) => RealignStrategy
}

/** park（IMP#11）：确定性失败（配置缺陷/计划闸门/挂载能力），重试一万次也不会自己变好——
 *  由调用方停车成 dormant（今天是 v2/realignWorkerTask.ts 的 runRealignWorkerTask 调
 *  jobs.park；旧管线时代由 executor.ts 承接同一职责，该文件已随旧管线退役删除），不进瞬时
 *  错误的重试环。error：瞬时故障，短退避重试有意义。 */
export interface RealignExecutionResult { decision: 'realigned' | 'error' | 'park'; detail: string }

/** 多数出现次数的目录名（绝对编号平铺库通常全部集塞在同一个目录里）；空数组返回 null。 */
function mostCommonDir(paths: string[]): string | null {
  if (paths.length === 0) return null
  const counts = new Map<string, number>()
  for (const p of paths) {
    const d = dirname(p)
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/** 默认策略探测：真实 probeHardlink + probeRenameBetween。probeRenameBetween 要求两侧目录都
 *  存在（探针铁律：绝不创建媒体根），archiveDir 此刻尚未存在——但它不是媒体根，是 realign
 *  自己的写路径（mount 哨兵已验过库根活着且可写），临时建出来探完即清（仅当本次新建且仍空），
 *  任何早退路径都不留空壳归档目录。 */
function probeStrategyDefault(libRoot: string, archiveDir: string): RealignStrategy {
  const archiveExisted = existsSync(archiveDir)
  mkdirSync(archiveDir, { recursive: true })
  try {
    return chooseRealignStrategy(
      { writable: true, hardlink: probeHardlink(libRoot) },
      probeRenameBetween(libRoot, archiveDir),
    )
  } finally {
    if (!archiveExisted) {
      try { rmdirSync(archiveDir) } catch { /* 非空/竞态——留着无害 */ }
      try { rmdirSync(dirname(archiveDir)) } catch { /* .archive 里还有别的归档——保留 */ }
    }
  }
}

const VIDEO_FILE_RE = /\.(mkv|mp4|avi|ts|m2ts)$/i

/** 递归清点目录下的视频文件数（build 残留 GC 的安全闸：还躺着视频就绝不 rm）。 */
function countVideoFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countVideoFiles(p)
    else if (VIDEO_FILE_RE.test(e.name)) n++
  }
  return n
}

/** 递归列出目录下所有视频文件的绝对路径（GAP C：scanVideoFiles 只扫顶层，见下方
 *  step 8 的嵌套内容清点用途——跟顶层扫描结果做差集，找出计划从未检查过的嵌套文件）。 */
function listVideoFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listVideoFilesRecursive(p))
    else if (VIDEO_FILE_RE.test(e.name)) out.push(p)
  }
  return out
}

/** GAP C（re-review #3）阈值：嵌套（scanVideoFiles 扫不到的子目录）视频文件数超过此值才
 *  park——数量少（零星 Extras/NCOP/making-of）时数据本就不会丢（archiveOldDir 是整棵子树
 *  rename），只需 notes 告知；数量多则疑似整段并行内容被错误地扫进同一目录，零改动更安全。 */
const NESTED_VIDEO_PARK_THRESHOLD = 5

/** 段感知的"path 在 loc 之内"（MINOR#14：'/media/li' 不得吞并 '/media/lib'）。 */
function underLocation(path: string, localLoc: string): boolean {
  return isUnderRoots(path, [localLoc])
}

function briefError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.split('\n')[0]
}

/**
 * 顶层编排（崩溃幂等版）。步骤顺序（re-sequenced，见 Phase E 数据安全修复 + re-review #A
 * post-refresh 崩溃恢复重排——GAP A）：
 *  2. 镜像集路径 → mapPath 映射为本地路径 → scanDir（IMP#8）——只读镜像，不查 Jellyfin。
 *  3. 库根推导：scanDir 必须落在"已配置的根"（mediaRoots ∪ 映射后的 getVirtualFolders
 *     locations）里，按最长前缀取根；不在任何根之下 → park，零改动（CRIT#1）。
 *     目标虚拟库同时锁定（段感知匹配，MINOR#14）——刷新端点缺失也是配置缺陷，动手前就 park。
 *     getVirtualFolders 是库级配置查询，不依赖某个具体 series item 是否还在。
 *  6. 崩溃恢复（CRIT#4）：job.plan_ref 指向的 manifest 存在（无法解析的真损坏 → park）→
 *     a. 账本含 reveal 且新目录已在最终位置 且 build 目录无视频滞留（真 finalize 必然
 *        搬空 build；有滞留 = 外来目录占位 + 回滚未完成，绝不许伪装续走成功）→ 续走
 *        （forward-resume）：只补收尾（归档旧目录/刷新/镜像清理），绝不重搬，且从不
 *        调用 jf.getItem(seriesId)（re-review #A）；
 *     b. 否则回滚重放（replayRollback）+ 回滚标记 + GC build 残留，复用同一归档目录/账本
 *        （幂等：不另起时间戳），落回步骤 1 走正常流程。
 *  1. series 元数据（jf.getItem 活查 TMDB id/标题/年份）——re-review #A（GAP A）：排在步骤 6
 *     的续走判定之后才调用，不再排最前。收尾阶段的 refreshLibrary 会让 Jellyfin 重新刮削
 *     整个目标虚拟库，若进程恰好死在 refreshLibrary 之后（120s 空闲等待期间/验收分页途中），
 *     旧 seriesId 对应的条目大概率已被裁掉（新目录下的内容被识别成新条目）——jf.getItem 若
 *     仍排在续走判定之前，每次重跑都会在这一行抛错，被上层记成 'error' 走 30s→15min→daily
 *     的无穷重试环（Jellyfin 时代那类抛错是专门的 JellyfinItemNotFoundError，被旧管线
 *     executor.ts 的通用 catch 记成 error；executor.ts 已随旧管线退役删除，今天承接同一个
 *     catch 的是 v2/realignWorkerTask.ts 的 runRealignWorkerTask，去 Jellyfin 化 P7 后 port
 *     换成库原生实现，抛一个语义清晰的 plain Error 复现同样的可观察行为——见
 *     realignLibraryPort.ts 的 getItem 注释），永远无法触达本该接管的续走路径（新树已经
 *     亮相且带字幕，仅差收尾）——新树活着但镜像 ghost 常驻、旧季 job 永不退休。账本才是
 *     崩溃恢复的真相源（source of truth），不是这一刻的 Jellyfin 活查。
 *  4. mount 哨兵（库根非空+可写）
 *  5. Jellyfin 空闲等待——任何搬动（包括崩溃恢复回滚）之前（IMP#6）
 *  7. 归档根解析（库根之外，IMP#9）+ 降级阶梯探测（abandon → park）
 *  8. 计划构建（TMDB 季表 + anime-lists 交叉验证 + 确定性闸门；任一不过 → park，IMP#11）
 *  9. 碰撞规划 + 最终目标目录预检（CRIT#3：搬动之前判定；已存在且无账可考 → park，
 *     绝不组装后才发现 finalize 无路可走）
 * 10. write-ahead manifest（append-only JSONL）+ plan_ref 回填
 * 11. 不可见组装（每文件先记账后 rename，拒绝 clobber，IMP#5）
 * 12. 字幕先行——在 .realign-build 里、亮相之前（IMP#7）；单集失败记录不阻塞
 * 13. 亮相记账（IMP#10）→ 目录级原子亮相
 *     （11–13 任何抛错 → replayRollback 回滚 + GC build → error，库回到原样）
 * 14. 亮相后收尾（IMP#12，独立 try/catch，失败绝不回滚已亮相的完整树）：
 *     归档旧目录（记账，IMP#10）→ 单库刷新 → 等空闲 → 验收（只对账真实就位的集，IMP#13）
 *     → 镜像清理。失败返回 error，重跑走 6a 续走补齐。
 */
export async function executeRealign(job: Job, deps: RealignExecutorDeps): Promise<RealignExecutionResult> {
  const seriesId = job.series_id!
  const notes: string[] = []
  const park = (detail: string): RealignExecutionResult => ({ decision: 'park', detail })

  // 2. 镜像集路径 → 本地路径（IMP#8：镜像存的是 Jellyfin 视角的 item.Path 原文）。只读
  //    镜像，不查 Jellyfin——必须先于步骤 1 的 jf.getItem（re-review #A，见函数顶部注释）。
  const paths = deps.lib.episodePathsForSeries(seriesId).map(p => mapPath(p, deps.mappings))
  const scanDir = mostCommonDir(paths)

  // 3. 库根推导（CRIT#1）：候选根 = 配置的本地媒体根 ∪ 映射后的 Jellyfin 虚拟库位置。
  //    在任何搬动/哨兵之前完成——推导失败是配置/数据问题，零改动停车。getVirtualFolders
  //    是库级配置查询，不依赖某个具体 series item 是否还在，可以安全地排在
  //    jf.getItem(seriesId) 之前。
  const folders = await deps.jf.getVirtualFolders()
  const mappedLocations = folders.flatMap(f => f.locations.map(l => mapPath(l, deps.mappings)))
  const candidateRoots = [...new Set([...deps.mediaRoots, ...mappedLocations])]

  // 6a'. 崩溃恢复指针（读账本不动盘，也不查 Jellyfin 的 series item）：plan_ref → manifest。
  //      re-review #A（GAP A）：必须排在步骤 1 的 jf.getItem(seriesId) 之前——收尾阶段的
  //      refreshLibrary 会让 Jellyfin 重新刮削整个目标虚拟库，若进程恰好死在 refreshLibrary
  //      之后（120s 空闲等待期间、或验收分页途中），旧 seriesId 对应的条目大概率已被裁掉
  //      （新目录下的内容被识别成一个新条目）。jf.getItem 若排在续走判定之前，每次重跑都会
  //      在那一行抛 JellyfinItemNotFoundError，被上层记成 'error' 走每日重试环，永远无法
  //      触达下方本该接管的续走路径——账本才是崩溃恢复的真相源，续走路径（forwardResume）
  //      本身也从不依赖 jf.getItem 的返回值。续走判定也要在 scanDir 推导失败之前做——收尾
  //      崩溃重跑时镜像可能已被清空（scanDir 为 null 是合法现场）。账本无法解析（撕裂级联
  //      之外的真损坏）是确定性缺陷：走 error 轨每天都会在同一行上再抛一次（daily
  //      errorloop，自动回滚永久瘫痪）——park（dormant、可人工修复后唤醒），此刻未动任何文件。
  const resumeArchiveDir = job.plan_ref ? dirname(job.plan_ref) : null
  let resumeManifest: ManifestDoc | null = null
  try {
    resumeManifest = resumeArchiveDir ? readManifest(resumeArchiveDir) : null
  } catch (error) {
    return park(
      `崩溃恢复账本无法解析（${briefError(error)}）——确定性损坏，重试不会自愈；` +
      `账本在 ${manifestPath(resumeArchiveDir!)}，需人工核查修复后唤醒`,
    )
  }
  const revealEntry = resumeManifest?.entries.find(e => e.reason === 'reveal')

  if (resumeArchiveDir && resumeManifest && revealEntry && existsSync(revealEntry.to)) {
    // 续走资格闸（re-review #1）：真正成功的 finalize 是目录级 rename，必然把 build 目录
    // 整个搬空——"reveal 记账 + revealEntry.to 存在"本身无法区分"我们的亮相真成功了"和
    // "外来目录占住了 finalTarget 且进程内回滚失败（无 rollback 标记）"。build 里还躺着
    // 视频 = 亮相从未发生：此时续走会伪造成功、归档空旧目录、清镜像退休 job，把用户的
    // 整季视频永久困在 .realign-build 里。只有 build 无视频滞留才许续走；否则落回下方
    // 回滚重放路径（回滚不净则 6c 停车），账本与现场都可恢复。
    if (countVideoFiles(revealEntry.from) === 0) {
      // ---- 6a. 续走（forward-resume）：上次已亮相，绝不重搬，只补收尾——从不调用
      // jf.getItem(seriesId)：post-refresh 崩溃后旧 series item 是否还在无关紧要
      // （GAP A：这是修复 post-refresh 崩溃 errorloop 的关键，见函数顶部注释）----
      return forwardResume(job, deps, {
        seriesId, archiveDir: resumeArchiveDir, finalShowDir: revealEntry.to,
        scanDir, candidateRoots, folders,
      })
    }
    deps.log(
      `realign 恢复：账本有 reveal 且 ${revealEntry.to} 已存在，但 ${revealEntry.from} 仍滞留视频——` +
      `判定外来目录占位 + 上次回滚未完成，拒绝续走，转入回滚路径`,
    )
  }

  if (!scanDir) {
    // 镜像空不是瞬时故障：realign job 由既有季 job 的诊断创建，镜像必然有过行——空说明
    // 剧已被删或上次收尾崩溃在镜像清理半途（账本无 reveal 可续走的双重故障）。走 error 轨
    // 只会每天空转一次，park 并说明现场。
    return park(`series ${seriesId} 镜像里没有任何集路径，无法定位待整理目录（剧已删除或上次收尾中断）——需人工核查`)
  }
  const libRoot = containingRoot(scanDir, candidateRoots)
  if (!libRoot) {
    return park(
      `待整理目录 ${scanDir} 不在任何已配置库根之下（检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS / Jellyfin 库位置）——` +
      `绝不按目录层数猜库根，拒绝动任何文件`,
    )
  }
  if (resolve(scanDir) === libRoot) {
    return park(`待整理目录就是库根本身（${scanDir}）——整理会归档整个库，拒绝执行`)
  }
  const targetFolder = folders.find(f => f.locations.some(loc => underLocation(scanDir, mapPath(loc, deps.mappings))))
  if (!targetFolder) {
    return park(`找不到包含 ${scanDir} 的 Jellyfin 虚拟库——无法在整理后定向刷新，拒绝动任何文件`)
  }
  // C-B2 处决：这里原有一条 targetFolder.enableRealtimeMonitor 分支——库原生实现
  // （realignLibraryPort.ts 的 getVirtualFolders）恒返回 false（库原生世界没有 Jellyfin
  // 的"实时监控"概念可言），这条分支永远走不到真，是纯粹的死代码，随字段一并删除。

  // 1. series 元数据——统一走 jf.getItem(seriesId) 活查（不是因为 series.provider_ids 镜像列
  //    是空洞——C-B7：T3 起 ingest 每行都写它——而是 realignLibraryPort.ts 的 getItem 实现根本
  //    不读这一列：series.id 本身就是 'tmdb:<id>' 形状，tmdbIdFromOwnId 直接从 id 结构化解出
  //    tmdbId，比再读一遍列/反序列化 JSON 更直接可信，没必要引入第二个数据源）。走到这里说明
  //    本轮不是 forward-resume（否则上面已经 return 了）：旧 series item 理应仍然存在——
  //    refreshLibrary 尚未发生（它只在步骤 14 收尾里调用，而收尾只会在 reveal 之后触发，
  //    reveal 之后必然满足上面的续走判定），因此这里调用 jf.getItem 是安全的（GAP A）。
  const seriesItem = await deps.jf.getItem(seriesId)
  const tmdbId = seriesItem.ProviderIds?.Tmdb
  const seriesTitle = seriesItem.Name
  const year = seriesItem.ProductionYear ?? null
  if (!tmdbId || !seriesTitle || year == null) {
    return { decision: 'error', detail: `series ${seriesId} 缺少 TMDB id/标题/年份，无法构建整理计划` }
  }

  // 4. mount 哨兵：库根必须活着（非空+可写），SMB 掉挂载不能被误判成"空库"。
  const sentinel = mountAliveSentinel(libRoot)
  if (!sentinel.ok) return { decision: 'error', detail: sentinel.reason! }

  // 5. Jellyfin 空闲等待（IMP#6 红线：扫描中挪文件=重复条目灾难）——先于包括回滚在内的
  //    一切搬动。
  const idleBefore = await waitForIngestIdle(deps.jf, { pollMs: 2000, timeoutMs: 60_000, sleep: deps.sleep, now: deps.now })
  if (!idleBefore) return { decision: 'error', detail: 'Jellyfin 扫描长时间未空闲，暂缓本次整理（下次重试）' }

  const showDirName = buildTargetShowDir(seriesTitle, year, tmdbId)
  const buildShowDir = invisibleBuildDir(libRoot, showDirName)
  const finalTarget = join(libRoot, showDirName)

  // 6b. 崩溃恢复：回滚重放（CRIT#4）。复用同一归档目录/账本——重跑幂等，不另起时间戳。
  let archiveDir: string
  if (resumeArchiveDir && resumeManifest) {
    if (resumeManifest.entries.length > 0) {
      deps.log(`realign 恢复：series ${seriesId} 存在未完成账本（${resumeManifest.entries.length} 条），先回滚再重来`)
      replayRollback(resumeArchiveDir, deps.log)
      appendRollbackMarker(resumeArchiveDir, deps.now())
      notes.push('上次中断的搬动已按账本回滚后重来')
    }
    archiveDir = resumeArchiveDir
  } else {
    // 7a. 归档根解析（IMP#9）：必须在库根之外（Jellyfin 不看），默认库根上一级（同 share，
    //     rename 原子性由下方探针核实）。
    const archiveRootBase = deps.archiveRoot ?? process.env.REALIGN_ARCHIVE_ROOT ?? dirname(libRoot)
    if (isUnderRoots(archiveRootBase, [libRoot])) {
      return park(`归档根 ${archiveRootBase} 位于库根之内（${libRoot}）——归档必须在媒体库之外，检查 REALIGN_ARCHIVE_ROOT`)
    }
    archiveDir = archiveDirFor(archiveRootBase, seriesTitle, deps.now())
    notes.push(`归档目录：${archiveDir}（${deps.archiveRoot != null || process.env.REALIGN_ARCHIVE_ROOT ? '来自 REALIGN_ARCHIVE_ROOT' : '默认：库根上一级'}）`)
  }

  // 6c. build 残留 GC（CRIT#4）：回滚后（或极端遗留）还立着的 .realign-build/<show> 骨架。
  //     还躺着视频文件说明回滚没能归位——绝不 rm，人工介入。
  if (existsSync(buildShowDir)) {
    const leftover = countVideoFiles(buildShowDir)
    if (leftover > 0) {
      return park(`.realign-build 里残留 ${leftover} 个视频文件且账本回滚未能归位：${buildShowDir}——不删不吞，需人工核查`)
    }
    rmSync(buildShowDir, { recursive: true, force: true })
  }

  // 7b. 降级阶梯：探测硬链接支持 + 库根↔归档目录间 rename 原子性。范围限定（YAGNI 边界）：
  //     本实现只走 rename 这一条执行路径，strategy==='hardlink' 时也按 rename 执行（安全，
  //     只是放弃保种收益）；只有 abandon（rename 原子性无法证明）才拒绝，且为确定性缺陷 → park。
  const strategy = deps.probeStrategy
    ? deps.probeStrategy(libRoot, archiveDir)
    : probeStrategyDefault(libRoot, archiveDir)
  if (strategy === 'abandon') {
    return park(`挂载能力不支持安全整理（硬链接不支持，且库根↔归档目录间 rename 非原子）：${libRoot} ↔ ${archiveDir}`)
  }

  // 8. 计划构建：扫描目录 → TMDB 季表 → anime-lists 交叉验证 → 确定性闸门（不过 → park）。
  const files = scanVideoFiles(scanDir)

  // GAP C（re-review #3）：scanVideoFiles 只扫 scanDir 顶层，但步骤 14 的 archiveOldDir
  // 会把 scanDir 整棵子树一并 rename 进归档——数据不会丢（目录级 rename，嵌套内容原样
  // 跟着走），但 coverage/continuity 闸门（buildRealignPlan）从未看过这些文件，用户也无从
  // 知晓库里"消失"的这批内容其实躺在归档目录下。动手之前先做一次递归清点，跟顶层扫描
  // 结果做差集：数量在阈值以下（零星 Extras/NCOP/making-of）就记进 notes，随最终 detail
  // 一起出现在 runs 详情里，照常整理（内容本就会跟着归档，不会丢）；超过阈值（疑似整段
  // 并行剧集树被错误地扫进了同一目录，继续整理会把用户完全没打算动的内容一并卷入归档）
  // 就直接 park，零改动，交人工核查（宁不做，不做烂）。
  const topLevelPaths = new Set(files.map(f => f.path))
  const nestedVideos = listVideoFilesRecursive(scanDir).filter(p => !topLevelPaths.has(p))
  if (nestedVideos.length > NESTED_VIDEO_PARK_THRESHOLD) {
    return park(
      `${scanDir} 下嵌套子目录里有 ${nestedVideos.length} 个整理计划从未检查过的视频文件` +
      `（超过 ${NESTED_VIDEO_PARK_THRESHOLD} 个阈值，疑似整段并行内容被扫进同一目录）——拒绝动任何文件，需人工核查`,
    )
  }
  if (nestedVideos.length > 0) {
    notes.push(
      `归档旧目录时一并带走 ${nestedVideos.length} 个整理计划未检查的嵌套视频文件（如 Extras/specials）：` +
      nestedVideos.map(p => basename(p)).join('、'),
    )
  }

  const seasonTable = await deps.tmdb.getSeasonTable(tmdbId)
  if (!seasonTable) return park(`TMDB 查无该剧季表（tmdbId=${tmdbId}）`)

  const animeListsEntries = await deps.fetchAnimeLists().catch(() => [] as AnimeListsEntry[])
  const crossCheck = crossCheckAnimeLists(seasonTable, animeListsEntries, Number(tmdbId))
  if (!crossCheck.ok) return park(crossCheck.reason!)

  const planConfig: RealignPlanConfig = { seriesTitle, year, tmdbId, seasonTable }
  const planResult = buildRealignPlan(files, planConfig)
  if (!planResult.ok) return park(`整理计划构建失败：${planResult.failures.join('; ')}`)

  if (deps.getDurationSeconds) {
    // ⚠️ 死枝（getDurationSeconds 从未接线）。若未来接线：禁止带 24 硬编码激活——45 分钟剧集
    // 会被 ±10% 闸门整剧误 park；精确时长用 tmdb.getDetails().runtimeMinutes。裁决 C-B1 登记在案。
    const expectedRuntime = 24 // 保守默认值：TMDB /tv/{id} 的 episode_run_time 平均值，
    // 精确值应在 step1 从 seriesItem 附带取得；此处为可选抽查闸门，取不到时以默认容差跳过。
    const runtimeFailures = checkRuntimeTolerance(planResult.items, expectedRuntime, deps.getDurationSeconds)
    if (runtimeFailures.length > 0) return park(`时长抽查未通过：${runtimeFailures.join('; ')}`)
  }

  // 9. 碰撞规划 + 最终目标预检（CRIT#3）——一切都在第一次搬动之前判定。
  const collision = planCollisions(planResult.items, libRoot, deps.getSize)
  if (collision.alreadyDone.length > 0) {
    notes.push(`${collision.alreadyDone.length} 个文件目标位置已有同尺寸文件（上次运行遗产），跳过搬动`)
  }
  if (collision.quarantine.length > 0) {
    notes.push(`${collision.quarantine.length} 个文件目标位置尺寸冲突，隔离（不覆盖不搬动，随旧目录一并归档）`)
  }
  const finalTargetExists = existsSync(finalTarget)
  if (finalTargetExists && collision.toMove.length > 0) {
    return park(
      `最终目标目录已存在（${finalTarget}）但账本没有它的亮相记录，且仍有 ${collision.toMove.length} 个文件待搬——` +
      `疑似同名异构目录（非本工具崩溃遗留），拒绝合并两棵树，需人工核查`,
    )
  }
  if (collision.toMove.length === 0 && collision.alreadyDone.length === 0) {
    return park(`没有任何文件可搬（${collision.quarantine.length} 个全部因目标尺寸冲突被隔离）——需人工核查`)
  }
  if (!finalTargetExists && collision.toMove.length === 0) {
    return park('待搬清单为空但最终目录不存在（全部条目被隔离/跳过）——现场不自洽，需人工核查')
  }

  // 10. write-ahead manifest（append-only JSONL）+ plan_ref 回填——第一次搬动之前落盘，
  //     崩溃恢复靠它找到账本。
  initManifest(archiveDir, { seriesId, seriesTitle, startedAt: deps.now() })
  deps.jobs.setPlanRef(job.id, manifestPath(archiveDir), deps.now())

  // 11–13. 组装 → 字幕先行 → 亮相：任何抛错整体回滚（库回到原样，error 短退避重试）。
  let finalShowDir = finalTarget
  try {
    if (collision.toMove.length > 0) {
      // 11. 不可见组装：先记账后 rename（write-ahead），拒绝 clobber（IMP#5）。
      assembleInvisibleTree(libRoot, showDirName, collision.toMove, (from, to) => {
        appendManifestEntry(archiveDir, {
          op: 'rename', from, to, size: deps.getSize(from) ?? 0, mtimeMs: deps.now(), reason: 'realign', ts: deps.now(),
        })
      })

      // 12. 字幕先行（IMP#7）：在 .realign-build 里、亮相之前跑完——亮相展示的是含字幕的
      //     完整树。单集失败不阻塞整理（字幕可由常规 season job 事后补），记录在案。
      // A-F13 处决：TMDB 富化一次性取（series 级数据，本轮全部目标共用同一份，不逐集各打一次
      // 往返）；getDetails/getChineseTitles 未接线（RealignExecutorDeps.tmdb 的可选字段缺席，
      // 多见于测试）或 TMDB 请求本身失败，都走 fetchTmdbEnrichment 自己的 gain-path 降级
      // （null/[]），这里绝不因为它失败而 park/throw。
      const tmdbForEnrichment = deps.tmdb.getDetails && deps.tmdb.getChineseTitles
        ? (deps.tmdb as unknown as TmdbClient) : null
      const { details, chineseTitles } = await fetchTmdbEnrichment(tmdbForEnrichment, 'tv', tmdbId)
      const enrichOriginalTitle = details?.originalTitle ?? null
      const enrichment = {
        originalTitle: enrichOriginalTitle,
        alternativeTitles: chineseTitles.filter((t, i, arr) =>
          t.trim().length > 0 && t !== seriesTitle && t !== enrichOriginalTitle && arr.indexOf(t) === i),
        overview: details?.overview ?? null,
        runtimeMinutes: details?.runtimeMinutes ?? null,
      }
      for (const item of collision.toMove) {
        const buildVideoPath = join(libRoot, '.realign-build', item.targetRelPath)
        const ctx = buildRealignEpisodeFields(seriesTitle, year, tmdbId, item, buildVideoPath, enrichment)
        try {
          await deps.runEpisode(ctx, dirname(buildVideoPath), `${job.id}-${item.absoluteEpisode}`)
        } catch (e) {
          const msg = briefError(e)
          deps.log(`warn: realign 字幕先行失败（abs ${item.absoluteEpisode}，不阻塞整理）：${msg}`)
          notes.push(`字幕先行失败（abs ${item.absoluteEpisode}）：${msg}`)
        }
      }

      // 13. 亮相记账（IMP#10：reveal 之后回滚才有据可依）→ 目录级原子亮相。
      appendManifestEntry(archiveDir, {
        op: 'rename', from: buildShowDir, to: finalTarget, size: 0, mtimeMs: deps.now(), reason: 'reveal', ts: deps.now(),
      })
      finalShowDir = finalizeShowDir(libRoot, showDirName)
    }
  } catch (error) {
    const msg = briefError(error)
    deps.log(`realign 组装/亮相中断，按账本回滚：${msg}`)
    try {
      replayRollback(archiveDir, deps.log)
      appendRollbackMarker(archiveDir, deps.now())
      if (existsSync(buildShowDir) && countVideoFiles(buildShowDir) === 0) {
        rmSync(buildShowDir, { recursive: true, force: true })
      }
    } catch (rollbackError) {
      return {
        decision: 'error',
        detail: `整理中断（${msg}）且回滚未完成（${briefError(rollbackError)}）——账本在 ${manifestPath(archiveDir)}，重试会继续恢复`,
      }
    }
    return { decision: 'error', detail: `整理中断，已按账本回滚，库保持原样：${msg}` }
  }

  // 14. 亮相后收尾（IMP#12）：新树已完整亮相，这里任何失败都绝不回滚（回滚反而制造二次
  //     搬动风险）；返回 error 后重跑走 6a 续走路径补齐剩余收尾——每一步都幂等/可恢复。
  // 验收只对账真实就位的集（IMP#13）：本轮搬动的 + 上次运行已就位的；隔离条目不在新树里，
  // 不得计入（旧实现按全计划对账，任何隔离都会让验收永久失败）。
  const expectedCounts = new Map<number, number>()
  for (const item of [...collision.toMove, ...collision.alreadyDone]) {
    expectedCounts.set(item.targetSeason, (expectedCounts.get(item.targetSeason) ?? 0) + 1)
  }
  try {
    // 归档旧目录（记账，IMP#10；scanDir 此刻只剩隔离文件/nfo/海报）。
    if (existsSync(scanDir)) {
      appendManifestEntry(archiveDir, {
        op: 'rename', from: scanDir, to: join(archiveDir, basename(scanDir)), size: 0,
        mtimeMs: deps.now(), reason: 'archive-old-dir', ts: deps.now(),
      })
      archiveOldDir(scanDir, archiveDir)
    }

    // Jellyfin 编排：单库刷新 → 等空闲 → 验收。
    await deps.jf.refreshLibrary(targetFolder.id)
    await waitForIngestIdle(deps.jf, { pollMs: 2000, timeoutMs: 120_000, sleep: deps.sleep, now: deps.now })

    const verify = await verifyRealignedCounts(deps.jf, finalShowDir, expectedCounts, {
      pageSize: 100, mappings: deps.mappings,
    })
    if (!verify.ok) {
      return { decision: 'error', detail: `${verify.detail}（新结构已亮相且不回滚；重试将走收尾续走路径）` }
    }

    // 镜像清理：旧 seriesId 的行永远不会再被下一轮 scan 碰到，显式清除；该剧全部旧
    // series_season job（含 dormant——旧排布下的"搜索穷尽"判决一并作废）退休。
    deps.lib.deleteSeriesRows(seriesId)
    deps.jobs.retireAllForSeries(seriesId, deps.now())
  } catch (error) {
    return {
      decision: 'error',
      detail: `整理已亮相，但收尾步骤失败（重试会按账本续走收尾，不会重搬文件）：${briefError(error)}`,
    }
  }

  const seasonSummary = [...expectedCounts.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `第 ${s} 季 ${n} 集`).join('、')
  const noteSuffix = notes.length > 0 ? `；${notes.join('；')}` : ''
  return {
    decision: 'realigned',
    detail: `把 ${collision.toMove.length + collision.alreadyDone.length} 集平铺整理成 ${expectedCounts.size} 季（${seasonSummary}），字幕已就位${noteSuffix}`,
  }
}

/**
 * 续走（forward-resume，CRIT#3/#4）：账本显示上次运行已完成目录级亮相（reveal 条目 + 新目录
 * 真实在位）——文件一个都不许再搬（重搬 = 二次数据风险），只补齐剩余收尾：归档旧目录（若还在）
 * → 单库刷新 → 镜像清理。集数验收跳过（计划无从重建——旧目录可能已归档；新树的完整性由上次
 * 亮相前的账本保证）。每步幂等，本函数自身失败后再重跑仍会落到这里继续补。
 */
async function forwardResume(
  job: Job, deps: RealignExecutorDeps,
  ctx: {
    seriesId: string; archiveDir: string; finalShowDir: string; scanDir: string | null
    candidateRoots: string[]
    folders: { id: string; name: string; locations: string[] }[]
  },
): Promise<RealignExecutionResult> {
  const { seriesId, archiveDir, finalShowDir, scanDir, candidateRoots, folders } = ctx
  const libRoot = containingRoot(finalShowDir, candidateRoots)
  if (!libRoot) {
    return {
      decision: 'park',
      detail: `崩溃恢复：账本记录的新目录 ${finalShowDir} 不在任何已配置库根之下——配置疑似变更，需人工核查`,
    }
  }
  const sentinel = mountAliveSentinel(libRoot)
  if (!sentinel.ok) return { decision: 'error', detail: sentinel.reason! }

  const targetFolder = folders.find(f => f.locations.some(loc => underLocation(finalShowDir, mapPath(loc, deps.mappings))))
  if (!targetFolder) {
    return { decision: 'park', detail: `崩溃恢复：找不到包含 ${finalShowDir} 的 Jellyfin 虚拟库——无法定向刷新，需人工核查` }
  }

  const idle = await waitForIngestIdle(deps.jf, { pollMs: 2000, timeoutMs: 60_000, sleep: deps.sleep, now: deps.now })
  if (!idle) return { decision: 'error', detail: 'Jellyfin 扫描长时间未空闲，暂缓收尾续走（下次重试）' }

  try {
    // 旧目录还在（崩溃发生在归档之前）→ 补归档（记账在前）。scanDir 必须在库根之内才动它。
    if (scanDir && existsSync(scanDir) && resolve(scanDir) !== libRoot && isUnderRoots(scanDir, [libRoot])) {
      appendManifestEntry(archiveDir, {
        op: 'rename', from: scanDir, to: join(archiveDir, basename(scanDir)), size: 0,
        mtimeMs: deps.now(), reason: 'archive-old-dir', ts: deps.now(),
      })
      archiveOldDir(scanDir, archiveDir)
    }
    await deps.jf.refreshLibrary(targetFolder.id)
    await waitForIngestIdle(deps.jf, { pollMs: 2000, timeoutMs: 120_000, sleep: deps.sleep, now: deps.now })
    deps.lib.deleteSeriesRows(seriesId)
    deps.jobs.retireAllForSeries(seriesId, deps.now())
  } catch (error) {
    return {
      decision: 'error',
      detail: `崩溃恢复续走：收尾仍未完成（重试继续续走，不会重搬文件）：${briefError(error)}`,
    }
  }
  return {
    decision: 'realigned',
    detail: `崩溃恢复续走完成：新目录 ${basename(finalShowDir)} 已在库中，收尾（归档/刷新/镜像清理）补齐；本次未搬动任何文件，集数验收跳过`,
  }
}
