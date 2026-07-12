import { existsSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'
import type { ProbeOutcome } from '../files/mountCapabilities.js'
import { sanitizeTitleForFs, type RealignPlanItem } from '../files/libraryRealign.js'

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
