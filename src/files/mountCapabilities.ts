import { writeFileSync, unlinkSync, renameSync, linkSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isDirWritable } from '../core/mediaContext.js'

let probeCounter = 0

/**
 * 探测三态：true/false = 探出来了；'unknown' = 没条件探（目录不存在或写探针进不去）。
 * 只读挂载上报 false 是撒谎——不是"不支持硬链接"，是"没法探"；两者对 realign 降级阶梯的
 * 意义完全不同（unknown → 保守走拷贝路径并提示人工确认，false → 直接排除硬链接方案）。
 */
export type ProbeOutcome = boolean | 'unknown'

/**
 * 探针铁律：绝不创建目录。媒体根不存在 = 死挂载/接线错误——那正是 doctor 哨兵要抓的场景，
 * mkdirSync 会当场把证据毁掉（凭空造出一个空目录冒充挂载点），后续 realign 就会往宿主盘里写。
 */
function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 目录内硬链接支持探测：建源文件→试 linkSync 到同目录另一名→成功即支持，失败(EPERM/EXDEV/ENOSYS等)即不支持。
 *  目录不存在或写探针失败 → 'unknown'（没条件探测 ≠ 不支持）。 */
export function probeHardlink(dir: string): ProbeOutcome {
  if (!dirExists(dir)) return 'unknown'
  const src = join(dir, `.subtitle-scout-hardlink-probe-src-${process.pid}-${probeCounter++}`)
  const dst = join(dir, `.subtitle-scout-hardlink-probe-dst-${process.pid}-${probeCounter++}`)
  try {
    writeFileSync(src, '')
  } catch {
    return 'unknown'
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

/** 大小写敏感性探测：写一个混合大小写文件名，看全大写别名是否"存在"（不敏感文件系统会别名到同一文件）。
 *  目录不存在或写探针失败 → 'unknown'。 */
export function probeCaseSensitivity(dir: string): ProbeOutcome {
  if (!dirExists(dir)) return 'unknown'
  const name = `.subtitle-scout-case-probe-${process.pid}-${probeCounter++}`
  const lowerPath = join(dir, name)
  const upperPath = join(dir, name.toUpperCase())
  try {
    writeFileSync(lowerPath, '')
  } catch {
    return 'unknown'
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
 *  任一目录不存在或写探针失败 → 'unknown'（此时 rename 失败说明不了设备关系）。
 *  两种结果都尽力清理残留（成功后探针文件在 dirB，失败后仍在 dirA）。 */
export function probeRenameBetween(dirA: string, dirB: string): ProbeOutcome {
  if (!dirExists(dirA) || !dirExists(dirB)) return 'unknown'
  const name = `.subtitle-scout-rename-probe-${process.pid}-${probeCounter++}`
  const pathA = join(dirA, name)
  const pathB = join(dirB, name)
  try {
    writeFileSync(pathA, '')
  } catch {
    return 'unknown'
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
  hardlink: ProbeOutcome
  caseSensitive: ProbeOutcome
}

/** 单目录能力画像：写探针复用 core/mediaContext.ts 的 isDirWritable（同一个写探针实现，不重复造轮子）。
 *  单个探针内部意外崩溃不外抛——降级为 'unknown'（doctor 一次探针失败不许炸整个体检）。 */
export function probeMountCapabilities(dir: string): MountCapabilities {
  const safe = (probe: () => ProbeOutcome): ProbeOutcome => {
    try {
      return probe()
    } catch {
      return 'unknown'
    }
  }
  let writable: boolean
  try {
    writable = isDirWritable(dir)
  } catch {
    writable = false
  }
  return {
    writable,
    hardlink: safe(() => probeHardlink(dir)),
    caseSensitive: safe(() => probeCaseSensitivity(dir)),
  }
}
