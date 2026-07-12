import { mkdirSync, writeFileSync, unlinkSync, renameSync, linkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'

let probeCounter = 0

/** 目录内硬链接支持探测：建源文件→试 linkSync 到同目录另一名→成功即支持，失败(EPERM/EXDEV/ENOSYS等)即不支持。 */
export function probeHardlink(dir: string): boolean {
  mkdirSync(dir, { recursive: true })
  const src = join(dir, `.subtitle-scout-hardlink-probe-src-${process.pid}-${probeCounter++}`)
  const dst = join(dir, `.subtitle-scout-hardlink-probe-dst-${process.pid}-${probeCounter++}`)
  try {
    writeFileSync(src, '')
  } catch {
    return false
  }
  try {
    linkSync(src, dst)
    try { unlinkSync(dst) } catch { /* best-effort */ }
    return true
  } catch {
    return false
  } finally {
    try { unlinkSync(src) } catch { /* best-effort */ }
  }
}

/** 大小写敏感性探测：写一个混合大小写文件名，看全大写别名是否"存在"（不敏感文件系统会别名到同一文件）。 */
export function probeCaseSensitivity(dir: string): boolean {
  mkdirSync(dir, { recursive: true })
  const name = `.subtitle-scout-case-probe-${process.pid}-${probeCounter++}`
  const lowerPath = join(dir, name)
  const upperPath = join(dir, name.toUpperCase())
  try {
    writeFileSync(lowerPath, '')
  } catch {
    return false
  }
  try {
    return !existsSync(upperPath)
  } finally {
    try { unlinkSync(lowerPath) } catch { /* best-effort */ }
    try { unlinkSync(upperPath) } catch { /* best-effort：大小写不敏感时这是同一个文件，可能已被上面删掉 */ }
  }
}

/** 两目录间 rename 原子性探测（真实涉及的两条路径，供 realign 归档路径判定用）：
 *  建探针文件于 dirA → renameSync 到 dirB → 成功=同设备(true)；EXDEV 等失败=跨设备(false)。
 *  两种结果都尽力清理残留（成功后探针文件在 dirB，失败后仍在 dirA）。 */
export function probeRenameBetween(dirA: string, dirB: string): boolean {
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })
  const name = `.subtitle-scout-rename-probe-${process.pid}-${probeCounter++}`
  const pathA = join(dirA, name)
  const pathB = join(dirB, name)
  try {
    writeFileSync(pathA, '')
  } catch {
    return false
  }
  try {
    renameSync(pathA, pathB)
    try { unlinkSync(pathB) } catch { /* best-effort */ }
    return true
  } catch {
    try { unlinkSync(pathA) } catch { /* best-effort */ }
    return false
  }
}

export interface MountCapabilities {
  writable: boolean
  hardlink: boolean
  caseSensitive: boolean
}

/** 单目录能力画像：写探针复用 core/mediaContext.ts 的 isDirWritable（同一个写探针实现，不重复造轮子）。 */
export function probeMountCapabilities(dir: string): MountCapabilities {
  return {
    writable: isDirWritable(dir),
    hardlink: probeHardlink(dir),
    caseSensitive: probeCaseSensitivity(dir),
  }
}
