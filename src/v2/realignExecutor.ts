import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'
import type { ProbeOutcome } from '../files/mountCapabilities.js'
import { sanitizeTitleForFs } from '../files/libraryRealign.js'

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
