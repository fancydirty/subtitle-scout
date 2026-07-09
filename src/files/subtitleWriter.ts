import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, extname, basename, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import chardet from 'chardet'
import * as iconv from 'iconv-lite'

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
  const detected = chardet.detect(data)
  let encoding = detected ? String(detected).toLowerCase() : null
  if (encoding && encoding !== 'utf-8' && encoding !== 'ascii' && iconv.encodingExists(encoding)) {
    data = Buffer.from(iconv.decode(data, encoding), 'utf8')
  } else if (encoding === 'ascii') {
    encoding = 'utf-8' // ascii 是 utf-8 子集
  }

  const videoBase = basename(input.videoFilename).replace(/\.[^.]+$/, '')
  const outName = `${videoBase}.${input.langTag}${extname(subtitleName).toLowerCase()}`
  mkdirSync(input.outDir, { recursive: true })
  const outPath = join(input.outDir, outName)

  const resolvedOut = resolve(outPath)
  const resolvedOutDir = resolve(input.outDir)
  if (!resolvedOut.startsWith(resolvedOutDir + sep)) {
    throw new Error(`refusing to write outside outDir: ${resolvedOut}`)
  }

  if (existsSync(resolvedOut)) {
    return { path: resolvedOut, bytes: 0, encoding, alreadyExists: true }
  }
  writeFileSync(resolvedOut, data)
  return { path: resolvedOut, bytes: data.length, encoding, alreadyExists: false }
}
