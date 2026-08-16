import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import type { SevenZipModule } from '7z-wasm'
import { loadSevenZip } from './sevenZip.js'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

export interface ArchiveEntry { name: string; data: Buffer }

let modulePromise: Promise<SevenZipModule> | null = null
let queue: Promise<unknown> = Promise.resolve()

function loadModule(): Promise<SevenZipModule> {
  modulePromise ??= loadSevenZip({ print() {}, printErr() {}, noExitRuntime: true })
  return modulePromise
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function walkFiles(sz: SevenZipModule, dir: string, root: string, acc: ArchiveEntry[]): void {
  for (const name of sz.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue
    const path = `${dir}/${name}`
    const st = sz.FS.stat(path)
    if (sz.FS.isDir(st.mode)) {
      walkFiles(sz, path, root, acc)
      continue
    }
    const rel = path.slice(root.length + 1)
    const data = Buffer.from(sz.FS.readFile(path))
    acc.push({ name: rel, data })
  }
}

function rmTree(sz: SevenZipModule, dir: string): void {
  for (const name of sz.FS.readdir(dir)) {
    if (name === '.' || name === '..') continue
    const path = `${dir}/${name}`
    const st = sz.FS.stat(path)
    if (sz.FS.isDir(st.mode)) rmTree(sz, path)
    else sz.FS.unlink(path)
  }
  sz.FS.rmdir(dir)
}

/** Unpack a 7z/rar (and any other 7-Zip-readable) archive in WASM and return subtitle entries.
 *  Serialized on a single module instance so MEMFS paths never collide across concurrent calls. */
export async function extractSubtitleEntries(archive: Buffer): Promise<ArchiveEntry[]> {
  return enqueue(async () => {
    const sz = await loadModule()
    const id = randomUUID()
    const archivePath = `/${id}.archive`
    const outDir = `/${id}-out`
    sz.FS.writeFile(archivePath, archive)
    sz.FS.mkdir(outDir)
    let code: number | void
    try {
      code = sz.callMain(['x', archivePath, `-o${outDir}`, '-y', '-bd']) as unknown as number | void
    } catch (e) {
      const status = e && typeof e === 'object' && 'status' in e ? Number((e as { status: unknown }).status) : NaN
      if (status !== 0) {
        try { rmTree(sz, outDir) } catch { /* ignore */ }
        try { sz.FS.unlink(archivePath) } catch { /* ignore */ }
        throw new Error(`archive extract failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      code = 0
    }
    try { sz.FS.unlink(archivePath) } catch { /* ignore */ }
    if (typeof code === 'number' && code !== 0) {
      try { rmTree(sz, outDir) } catch { /* ignore */ }
      throw new Error(`archive extract failed (7z exit ${code})`)
    }
    const files: ArchiveEntry[] = []
    try {
      walkFiles(sz, outDir, outDir, files)
    } finally {
      try { rmTree(sz, outDir) } catch { /* ignore */ }
    }
    const subs = files.filter((f) =>
      SUBTITLE_EXTS.includes(extname(f.name).toLowerCase()) &&
      !basename(f.name).startsWith('.'))
    if (subs.length === 0) throw new Error('archive contains no subtitle files')
    for (const s of subs) {
      if (s.data.length > MAX_ENTRY_BYTES) {
        throw new Error(
          `archive entry ${basename(s.name)} decompressed to ${s.data.length} bytes > cap ${MAX_ENTRY_BYTES} (zip bomb?)`,
        )
      }
    }
    return subs
  })
}
