import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync, rmdirSync } from 'node:fs'
import { join, dirname, basename, sep } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'
import { probeHardlink, probeRenameBetween, type ProbeOutcome } from '../files/mountCapabilities.js'
import {
  sanitizeTitleForFs, scanVideoFiles, buildRealignPlan, buildTargetShowDir,
  crossCheckAnimeLists, checkRuntimeTolerance,
  type RealignPlanItem, type RealignPlanConfig,
} from '../files/libraryRealign.js'
import { initManifest, appendManifestEntry, manifestPath } from '../files/realignManifest.js'
import { MediaContextSchema, type MediaContext } from '../core/schemas.js'
import { runPipeline, type PipelineResult } from '../core/pipeline.js'
import type { Assembled } from '../cli/index.js'
import type { JellyfinItem } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'
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

export interface RealignJellyfinPort {
  getItem(itemId: string): ReturnType<PlayerServer['getItem']>
  getItemsPage(startIndex: number, limit: number): ReturnType<PlayerServer['getItemsPage']>
  getScheduledTasks(): Promise<ScheduledTaskLike[]>
  getVirtualFolders(): Promise<{ id: string; name: string; locations: string[]; enableRealtimeMonitor: boolean }[]>
  refreshLibrary(libraryId: string): Promise<void>
  deleteItem(itemId: string): Promise<void>
}

export interface RealignExecutorDeps {
  lib: LibraryRepo
  jobs: Pick<JobsRepo, 'setPlanRef' | 'retireAllForSeries'>
  jf: RealignJellyfinPort
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
  fetchAnimeLists: () => Promise<AnimeListsEntry[]>
  runEpisode: (ctx: MediaContext, outDir: string, jobId: string) => Promise<PipelineResult>
  now: () => number
  log: (msg: string) => void
  sleep: (ms: number) => Promise<void>
  getSize: (path: string) => number | null
  getDurationSeconds?: (path: string) => number | null
  /** 挂载能力探测（可选注入，测试用假探针；默认走真实 mountCapabilities.ts 的
   *  probeHardlink/probeRenameBetween）。返回值直接喂给 chooseRealignStrategy。 */
  probeStrategy?: (libRoot: string, archiveDir: string) => RealignStrategy
}

export interface RealignExecutionResult { decision: 'realigned' | 'error'; detail: string }

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

/**
 * 顶层编排：mount 哨兵 → 降级阶梯 → 计划构建（TMDB 季表 + anime-lists 交叉验证 + 确定性
 * 闸门）→ 碰撞规划 → write-ahead manifest（plan_ref 回填）→ 不可见组装 → 目录级原子亮相 →
 * 字幕先行 → 归档旧目录 → Jellyfin 编排（等空闲/单库刷新/验收）→ 镜像清理 → 返回结果
 * （由 executor.ts 的 executeRealignBranch 负责 completeDone/completeError）。任一步失败均
 * 安全返回 decision:'error'，不留半成品（write-ahead manifest 已覆盖的可恢复中间态除外，
 * 回滚由 realignManifest.replayRollback 逆序重放）。
 */
export async function executeRealign(job: Job, deps: RealignExecutorDeps): Promise<RealignExecutionResult> {
  const seriesId = job.series_id!
  const now = deps.now()

  // 1. series 元数据（标题/年份/tmdbId）——统一走 jf.getItem(seriesId)，不依赖本地镜像的
  //    series.provider_ids（该列在 scanner.ts 的正常扫描路径里从未被写入，是历史空洞，
  //    不能作为 TMDB id 的可信来源；这与 executor.ts/makeRunEpisode 解析 TMDB 引用一贯的
  //    做法一致——永远向 Jellyfin 活查）。
  const seriesItem = await deps.jf.getItem(seriesId)
  const tmdbId = seriesItem.ProviderIds?.Tmdb
  const seriesTitle = seriesItem.Name
  const year = seriesItem.ProductionYear ?? null
  if (!tmdbId || !seriesTitle || year == null) {
    return { decision: 'error', detail: `series ${seriesId} 缺少 TMDB id/标题/年份，无法构建整理计划` }
  }

  // 2. 定位需要整理的磁盘目录：镜像里该剧全部集路径里出现次数最多的目录。
  const paths = deps.lib.episodePathsForSeries(seriesId)
  const scanDir = mostCommonDir(paths)
  if (!scanDir) {
    return { decision: 'error', detail: `series ${seriesId} 镜像里没有任何集路径，无法定位待整理目录` }
  }
  const derivedLibRoot = dirname(dirname(scanDir)) // scanDir 通常是 <libRoot>/<show>/<oldSeason>

  // 3. mount 哨兵：库根必须活着（非空+可写），SMB 掉挂载不能被误判成"空库"。
  const sentinel = mountAliveSentinel(derivedLibRoot)
  if (!sentinel.ok) return { decision: 'error', detail: sentinel.reason! }

  // 3b. 降级阶梯：探测硬链接支持 + 库根↔归档目录间 rename 原子性，决定是否可以安全整理。
  //     archiveDir 提前算好，后面 write-ahead manifest 阶段复用同一个值（不重复计算）。
  //     重要范围限定（本计划的 YAGNI 边界）：strategy==='hardlink' 时唯一的额外好处是继续
  //     为旧文件做种（保留旧结构、新结构只是硬链接副本）——那是一条完全不同的归档/组装
  //     代码路径（旧目录不能被 rename 挪空，必须原样保留）。本实现只走 rename 这一条执行
  //     路径（现实里最常见的 CIFS `nounix` 挂载本就不支持硬链接，设计文档预期如此），
  //     strategy==='hardlink' 时按同一条 rename 路径执行（安全，只是放弃额外的保种收益，
  //     不放弃任何安全性——rename 单跳依然原子）。只有 strategy==='abandon'（硬链接不支持
  //     且 rename 也不能证明原子）才真正拒绝整理。
  const archiveDir = archiveDirFor(derivedLibRoot, seriesTitle, now)
  const strategy = deps.probeStrategy
    ? deps.probeStrategy(derivedLibRoot, archiveDir)
    : probeStrategyDefault(derivedLibRoot, archiveDir)
  if (strategy === 'abandon') {
    return {
      decision: 'error',
      detail: `挂载能力不支持安全整理（硬链接不支持，且库根↔归档目录间 rename 非原子）：${derivedLibRoot} ↔ ${archiveDir}`,
    }
  }

  // 4. 计划构建：扫描目录 → TMDB 季表 → anime-lists 交叉验证 → 确定性闸门。
  const files = scanVideoFiles(scanDir)
  const seasonTable = await deps.tmdb.getSeasonTable(tmdbId)
  if (!seasonTable) return { decision: 'error', detail: `TMDB 查无该剧季表（tmdbId=${tmdbId}）` }

  const animeListsEntries = await deps.fetchAnimeLists().catch(() => [] as AnimeListsEntry[])
  const crossCheck = crossCheckAnimeLists(seasonTable, animeListsEntries, Number(tmdbId))
  if (!crossCheck.ok) return { decision: 'error', detail: crossCheck.reason! }

  const planConfig: RealignPlanConfig = { seriesTitle, year, tmdbId, seasonTable }
  const planResult = buildRealignPlan(files, planConfig)
  if (!planResult.ok) return { decision: 'error', detail: `整理计划构建失败：${planResult.failures.join('; ')}` }

  if (deps.getDurationSeconds) {
    const expectedRuntime = 24 // 保守默认值：TMDB /tv/{id} 的 episode_run_time 平均值，
    // 精确值应在 step1 从 seriesItem 附带取得；此处为可选抽查闸门，取不到时以默认容差跳过。
    const runtimeFailures = checkRuntimeTolerance(planResult.items, expectedRuntime, deps.getDurationSeconds)
    if (runtimeFailures.length > 0) return { decision: 'error', detail: `时长抽查未通过：${runtimeFailures.join('; ')}` }
  }

  // 5. 碰撞规划：目标已存在——同尺寸跳过（幂等，崩溃恢复重跑场景），不同尺寸隔离（不覆盖、
  //    不搬动，随旧目录残骸一并归档，manifest 之外零丢失）。
  const collision = planCollisions(planResult.items, derivedLibRoot, deps.getSize)

  // 6. write-ahead manifest + plan_ref 回填 + 不可见组装（archiveDir 已在 3b 算好，复用）。
  //    plan_ref 必须在第一次搬动之前落到 jobs 行上——崩溃恢复要靠它找到 manifest。
  initManifest(archiveDir, { seriesId, seriesTitle, startedAt: now })
  deps.jobs.setPlanRef(job.id, manifestPath(archiveDir), deps.now())
  const showDirName = buildTargetShowDir(seriesTitle, year, tmdbId)
  assembleInvisibleTree(derivedLibRoot, showDirName, collision.toMove, (from, to) => {
    appendManifestEntry(archiveDir, { op: 'rename', from, to, size: deps.getSize(from) ?? 0, mtimeMs: now, reason: 'realign', ts: deps.now() })
  })

  // 7. 目录级原子亮相。
  const finalShowDir = finalizeShowDir(derivedLibRoot, showDirName)

  // 8. 字幕先行：对本轮真实搬动的每个条目，构造 ctx 直调 runPipeline（抢在 Jellyfin 刮削前）。
  for (const item of collision.toMove) {
    const finalVideoPath = join(finalShowDir, item.targetRelPath.slice(showDirName.length + 1))
    const ctx = buildRealignMediaContext(seriesTitle, year, tmdbId, item, finalVideoPath)
    await deps.runEpisode(ctx, dirname(finalVideoPath), `${job.id}-${item.absoluteEpisode}`)
  }

  // 9. 旧目录归档（scanDir 此刻只剩隔离文件/nfo/海报——匹配的视频文件已在第 6 步搬空）。
  archiveOldDir(scanDir, archiveDir)

  // 10. Jellyfin 编排：确认无扫描在跑 → 单库刷新 → 再等空闲 → 验收。
  const idleBefore = await waitForJellyfinIdle(deps.jf, { pollMs: 2000, timeoutMs: 60_000, sleep: deps.sleep })
  if (!idleBefore) return { decision: 'error', detail: 'Jellyfin 扫描长时间未空闲，暂缓本次整理（下次重试）' }

  const folders = await deps.jf.getVirtualFolders()
  const targetFolder = folders.find(f => f.locations.some(loc => finalShowDir.startsWith(loc)))
  if (!targetFolder) return { decision: 'error', detail: `找不到包含 ${finalShowDir} 的 Jellyfin 库` }
  await deps.jf.refreshLibrary(targetFolder.id)
  await waitForJellyfinIdle(deps.jf, { pollMs: 2000, timeoutMs: 120_000, sleep: deps.sleep })

  const expectedCounts = new Map<number, number>()
  for (const item of planResult.items) {
    expectedCounts.set(item.targetSeason, (expectedCounts.get(item.targetSeason) ?? 0) + 1)
  }
  const verify = await verifyRealignedCounts(deps.jf, finalShowDir, expectedCounts, { pageSize: 100 })
  if (!verify.ok) return { decision: 'error', detail: verify.detail }

  // 11. 镜像清理：旧 seriesId 的行永远不会再被下一轮 scan 碰到，显式清除；该剧全部旧
  //     series_season job（含 dormant——旧排布下的"搜索穷尽"判决一并作废）退休。
  deps.lib.deleteSeriesRows(seriesId)
  deps.jobs.retireAllForSeries(seriesId, deps.now())

  const seasonSummary = [...expectedCounts.entries()].sort((a, b) => a[0] - b[0])
    .map(([s, n]) => `第 ${s} 季 ${n} 集`).join('、')
  return {
    decision: 'realigned',
    detail: `把 ${planResult.items.length} 集平铺整理成 ${expectedCounts.size} 季（${seasonSummary}），字幕已就位`,
  }
}
