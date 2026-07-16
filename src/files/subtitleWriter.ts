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
  /** Any language/script tag used in the Jellyfin sidecar filename (`<video>.<langTag>.<ext>`) —
   *  historically only 'zh-Hans'/'zh-Hant', generalized (A2) since this writer never assumed
   *  Chinese; it just embeds whatever tag the caller passes into the output filename. */
  langTag: string
  outDir: string
}
export interface WriteSubtitleResult {
  path: string
  bytes: number
  encoding: string | null
  alreadyExists: boolean
}

/** C-D1 fix: a zip with >1 subtitle entries and no selectFileName can no longer be resolved
 *  mechanically (there is no correct default — that used to silently grab entries[0], stealing the
 *  choice from the agent, e.g. a season pack always yielding episode 1). This is a discriminable
 *  outcome unioned into writeSubtitle's return type rather than a thrown error, so the caller (the
 *  download_candidate tool) can hand the entry list back to the agent as a fact to choose from. */
export interface WriteSubtitleNeedsSelection {
  needsSelection: true
  /** Subtitle-extension entry names only (same filter as the direct-pick path), in zip order. */
  entries: string[]
}
export type WriteSubtitleOutcome = WriteSubtitleResult | WriteSubtitleNeedsSelection

type ZipPick = { name: string; data: Buffer } | WriteSubtitleNeedsSelection

// gate 按 filelist 的 file_index 校验范围；这里按文件名解析 zip 条目，因为 zip 内部顺序 ≠ filelist 顺序。
// selectFileName 给了但名字对不上 zip 内任何条目 → 仍然抛错（fail closed，行为不变）。没给
// selectFileName 时：恰好 1 个字幕条目 → 零摩擦直取（不变）；>1 个 → 不再机械偷取 entries[0]，
// 清单是事实，交回调用方（见 WriteSubtitleNeedsSelection）。
function pickFromZip(buf: Buffer, selectFileName?: string): ZipPick {
  const zip = new AdmZip(buf)
  const entries = zip.getEntries().filter(e =>
    !e.isDirectory &&
    SUBTITLE_EXTS.includes(extname(e.entryName).toLowerCase()) &&
    !basename(e.entryName).startsWith('.'))
  if (entries.length === 0) throw new Error('zip contains no subtitle files')
  if (selectFileName) {
    const chosen = entries.find(e => basename(e.entryName) === basename(selectFileName))
    if (!chosen) throw new Error(`selected file not found in zip: ${selectFileName}`)
    return { name: basename(chosen.entryName), data: chosen.getData() }
  }
  if (entries.length === 1) {
    return { name: basename(entries[0].entryName), data: entries[0].getData() }
  }
  return { needsSelection: true, entries: entries.map(e => basename(e.entryName)) }
}

export async function writeSubtitle(input: WriteSubtitleInput): Promise<WriteSubtitleOutcome> {
  const artifactExt = extname(input.artifactFilename).toLowerCase()
  let subtitleName: string
  let data: Buffer

  if (artifactExt === '.zip') {
    const picked = pickFromZip(input.artifact, input.selectFileName)
    if ('needsSelection' in picked) return picked
    ;({ name: subtitleName, data } = picked)
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
