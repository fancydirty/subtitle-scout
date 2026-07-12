import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'
import type { ProbeOutcome } from '../files/mountCapabilities.js'
import { sanitizeTitleForFs, type RealignPlanItem } from '../files/libraryRealign.js'
import { MediaContextSchema, type MediaContext } from '../core/schemas.js'
import { runPipeline, type PipelineResult } from '../core/pipeline.js'
import type { Assembled } from '../cli/index.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'

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
 */
export function chooseRealignStrategy(
  caps: { writable: boolean; hardlink: ProbeOutcome }, renameAtomic: ProbeOutcome,
): RealignStrategy {
  if (!caps.writable) return 'abandon'
  if (caps.hardlink === true) return 'hardlink'
  if (renameAtomic === true) return 'rename'
  return 'abandon'
}

/** 归档位置：<share根>/.archive/<剧名>-<时间戳>/ —— 在 Movies/TV 库根之外（Jellyfin 不看），
 *  但在同一 share 内（rename 保持原子）。shareRoot 由调用方传入（通常是媒体根的上一级，
 *  或 REALIGN_ARCHIVE_ROOT 环境变量显式指定，见 realignExecutor 顶层编排函数）。
 *  剧名走与目标目录同一套文件系统安全化（'Fate/Zero' 不得拆层）。 */
export function archiveDirFor(shareRoot: string, seriesTitle: string, nowMs: number): string {
  return join(shareRoot, '.archive', `${sanitizeTitleForFs(seriesTitle)}-${nowMs}`)
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
 * 旧目录一次 rename 进归档（<share根>/.archive/<剧名>-<时间戳>/<oldDir 的 basename>）。
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
 * 字幕先行阶段的 MediaContext：此刻 Jellyfin 尚未刮新结构、镜像无条目，identify 所需的
 * 身份/tmdbid/季集/视频路径全在整理计划里，字面构造即可，不需要 jf.getItem。
 * trigger 用 'library_scan'（语义最贴近："库结构变化触发的搜索"，不是播放触发/手动搜索）。
 */
export function buildRealignMediaContext(
  seriesTitle: string, year: number, tmdbId: string, item: RealignPlanItem, videoPath: string,
): MediaContext {
  return MediaContextSchema.parse({
    request_id: `realign-${tmdbId}-S${item.targetSeason}E${item.targetEpisode}-${Date.now()}`,
    trigger: 'library_scan',
    media: {
      type: 'episode',
      path: videoPath,
      filename: basename(videoPath),
      title: seriesTitle,
      original_title: null,
      year,
      season: item.targetSeason,
      episode: item.targetEpisode,
      runtime_minutes: null,
      provider_ids: { tmdb: tmdbId },
      production_locations: [],
      alternative_titles: [],
      overview: null,
      existing_subtitles: [],
    },
    preferences: {},
  })
}

/**
 * runEpisode 接线（realign 版）：mirror makeRunEpisode 的尾段（调 runPipeline、包 journal），
 * 但跳过 jf.getItem/getChineseTitle/refreshItem——那些依赖 Jellyfin 已经刮削出条目，此刻还
 * 没有。调用方（executeRealign 顶层编排）已经把 MediaContext 构造好、root/可写预检已在
 * mount 哨兵阶段做过，这里只负责"跑一次完整判断链"。runPipelineImpl 可注入（测试用，
 * 默认走真实 core/pipeline.ts 的 runPipeline）。bypassNegativeCache 同 makeRunEpisode 的
 * I5e 语义：v2 状态机拥有全部重试策略，管线自己的负缓存不许再叠一层门。
 */
export function makeRealignRunEpisode(
  assembled: Pick<Assembled, 'makeDeps' | 'withJournal' | 'cacheRoot'>,
  opts: { runPipelineImpl?: typeof runPipeline } = {},
): (ctx: MediaContext, outDir: string, jobId: string) => Promise<PipelineResult> {
  const { makeDeps, withJournal, cacheRoot } = assembled
  const run = opts.runPipelineImpl ?? runPipeline
  return async (ctx, outDir, jobId) => {
    const journalDir = join(cacheRoot, 'journals', `realign-${jobId}-${Date.now()}`)
    return withJournal(() => run(makeDeps(), ctx, outDir, journalDir, { bypassNegativeCache: true }))
  }
}

export interface ScheduledTaskLike { id: string; name: string; isRunning: boolean }

/**
 * 等 Jellyfin 扫描空闲（调研红线：扫描中挪文件=重复条目灾难）。轮询直到无任务在跑或超时。
 * sleep/now 均可注入（测试用假时钟，不真等也不篡改全局 Date.now）。
 */
export async function waitForJellyfinIdle(
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
 * 验收：按新目录路径前缀统计 Jellyfin 实际刮出的各季集数，与计划值比对。复用既有
 * getItemsPage（已带 Path 字段），不需要新增端点——按 Path 是否落在新目录路径之下过滤
 * （按路径段切割，"Show Extended" 不会蹭进 "Show" 的账），旧目录残留（尚未清理/尚未重刮）
 * 天然被排除在统计之外。
 */
export async function verifyRealignedCounts(
  jf: { getItemsPage(startIndex: number, limit: number): Promise<Pick<JellyfinItem, 'Type' | 'Path' | 'ParentIndexNumber'>[]> },
  newShowDirPath: string, expectedCounts: Map<number, number>, opts: { pageSize: number },
): Promise<{ ok: boolean; detail: string }> {
  const prefix = newShowDirPath.endsWith(sep) ? newShowDirPath : newShowDirPath + sep
  const actualCounts = new Map<number, number>()
  let startIndex = 0
  while (true) {
    const items = await jf.getItemsPage(startIndex, opts.pageSize)
    if (items.length === 0) break
    for (const item of items) {
      if (item.Type === 'Episode' && item.Path?.startsWith(prefix) && item.ParentIndexNumber != null) {
        actualCounts.set(item.ParentIndexNumber, (actualCounts.get(item.ParentIndexNumber) ?? 0) + 1)
      }
    }
    startIndex += opts.pageSize
  }
  for (const [season, expected] of expectedCounts) {
    const actual = actualCounts.get(season) ?? 0
    if (actual !== expected) {
      return { ok: false, detail: `第 ${season} 季验收：Jellyfin 报告 ${actual} 集，计划 ${expected} 集，不一致` }
    }
  }
  return { ok: true, detail: '各季集数与计划一致' }
}
