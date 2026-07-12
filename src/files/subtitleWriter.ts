import { existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs'
import { join, extname, basename, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { writeAll } from './fsUtil.js'
import { decodeToUtf8 } from './subtitleEncoding.js'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']

export class UnsupportedArchiveError extends Error {
  constructor(ext: string) { super(`unsupported archive format: ${ext} (only zip in v1)`) }
}

export interface WriteSubtitleInput {
  artifact: Buffer
  artifactFilename: string
  /** zip 包内要选的文件名（来自 ASSRT filelist[file_index].f）；非 zip 忽略 */
  selectFileName?: string
  videoFilename: string
  langTag: 'zh-Hans' | 'zh-Hant'
  outDir: string
}
export interface WriteSubtitleResult {
  path: string
  bytes: number
  encoding: string | null
  alreadyExists: boolean
}

// gate 按 filelist 的 file_index 校验范围；这里按文件名解析 zip 条目，因为 zip 内部顺序 ≠ filelist 顺序。名字对不上则抛错（fail closed）。
function pickFromZip(buf: Buffer, selectFileName?: string): { name: string; data: Buffer } {
  const zip = new AdmZip(buf)
  const entries = zip.getEntries().filter(e =>
    !e.isDirectory &&
    SUBTITLE_EXTS.includes(extname(e.entryName).toLowerCase()) &&
    !basename(e.entryName).startsWith('.'))
  if (entries.length === 0) throw new Error('zip contains no subtitle files')
  const chosen = selectFileName
    ? entries.find(e => basename(e.entryName) === basename(selectFileName))
    : entries[0]
  if (!chosen) throw new Error(`selected file not found in zip: ${selectFileName}`)
  return { name: basename(chosen.entryName), data: chosen.getData() }
}

export async function writeSubtitle(input: WriteSubtitleInput): Promise<WriteSubtitleResult> {
  const artifactExt = extname(input.artifactFilename).toLowerCase()
  let subtitleName: string
  let data: Buffer

  if (artifactExt === '.zip') {
    ({ name: subtitleName, data } = pickFromZip(input.artifact, input.selectFileName))
  } else if (SUBTITLE_EXTS.includes(artifactExt)) {
    subtitleName = input.artifactFilename
    data = input.artifact
  } else {
    throw new UnsupportedArchiveError(artifactExt)
  }

  // 编码归一化：非 UTF-8 转 UTF-8，记录原编码
  const decoded = decodeToUtf8(data)
  data = decoded.data
  const encoding = decoded.encoding

  const videoBase = basename(input.videoFilename).replace(/\.[^.]+$/, '')
  const outName = `${videoBase}.${input.langTag}${extname(subtitleName).toLowerCase()}`
  mkdirSync(input.outDir, { recursive: true })
  const outPath = join(input.outDir, outName)

  const resolvedOut = resolve(outPath)
  const resolvedOutDir = resolve(input.outDir)
  if (!resolvedOut.startsWith(resolvedOutDir + sep)) {
    throw new Error(`refusing to write outside outDir: ${resolvedOut}`)
  }

  // 与下方原子写用的是同一套确定性命名（resolvedOut + '.tmp'），因此短路分支也能按
  // 这个精确名字识别并清理"自己的"孤儿临时文件——不会误删任何不是这个命名模式产生的文件。
  const tmpPath = `${resolvedOut}.tmp`

  if (existsSync(resolvedOut)) {
    // 孤儿临时文件清理：上一次调用可能在 rename 前崩溃（或最终路径被其他来源写入），
    // 留下这个 writer 自己产生的 <resolvedOut>.tmp 垃圾文件。功能上无害（下次重试的
    // openSync('w') 会截断复用它），但会永久堆积在用户媒体目录旁——顺手清掉。
    // 只删这一个确定路径，绝不碰最终文件本身或任何其他文件。
    // 这是 best-effort 清理：某些文件系统（NAS/SMB 等）上 unlink 可能因 EPERM/EACCES/EBUSY
    // 失败，绝不能让清理失败把这个良性的"已存在"短路变成整次调用的硬失败。
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // swallow: orphan cleanup is opportunistic, not load-bearing
      }
    }
    return { path: resolvedOut, bytes: 0, encoding, alreadyExists: true }
  }

  // 原子写：先写同目录临时文件 + fsync，再 rename 到最终路径（同 fs 上 rename 是原子的）。
  // 这样任何时刻崩溃，最终路径要么不存在，要么是完整文件——不会出现被 existsSync 误判为
  // "已存在"从而永久跳过的半截字幕。
  const fd = openSync(tmpPath, 'w')
  try {
    writeAll(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, resolvedOut)
  return { path: resolvedOut, bytes: data.length, encoding, alreadyExists: false }
}
