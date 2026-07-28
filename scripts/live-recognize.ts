// Manual live-verification runner — NOT wired into `npm test`. Walks one or more real
// filesystem roots, runs identifyFromPath() (the recognition layer's single entry point —
// pure mechanical path parse, no TMDB/network) on every video file found, and prints one JSON
// line per file plus a final summary line. Judging whether the identities/parks are actually
// CORRECT is the operator's job — this script only collects evidence, it is not a pass/fail gate.
//
// （2026-07-28 认领退役随手修：本脚本此前 import 的 `recognize`/`Recognized` 早已不存在于
// recognition 层的导出面——识别层退化成纯路径解析后脚本一直是坏的。现直接调 identifyFromPath，
// 顺带不再需要 TMDB_API_KEY——本层从不联网。）
//
// Usage:
//   npx tsx scripts/live-recognize.ts <root...> [--ext mkv,mp4,avi]
import { parseArgs } from 'node:util'
import { readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import { identifyFromPath, type PathIdentity, type Park } from '../src/recognition/identifyFromPath.js'

if (process.env.VITEST) {
  throw new Error('live-recognize.ts must not run under vitest — it walks real filesystem roots')
}

/**
 * No single exported "video extensions" constant exists in this codebase to reuse: the closest
 * thing is `VIDEO_EXT_RE` in src/files/libraryRealign.ts (mkv|mp4|avi|ts|m2ts), but it is a
 * private, unexported module-local const, and touching libraryRealign.ts is out of scope for C4.
 * This list is kept local and deliberately a superset (adds wmv/flv/webm) — a permissive default
 * is the right call for an evidence-collection pass over a real, possibly messy library.
 */
const DEFAULT_VIDEO_EXTS = ['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'wmv', 'flv', 'webm']

const { values, positionals } = parseArgs({
  options: { ext: { type: 'string' } },
  allowPositionals: true,
})

if (positionals.length === 0) {
  console.error('usage: npx tsx scripts/live-recognize.ts <root...> [--ext mkv,mp4,avi]')
  process.exit(1)
}

const videoExts = new Set(
  (values.ext ? values.ext.split(',') : DEFAULT_VIDEO_EXTS).map(e => e.trim().toLowerCase().replace(/^\./, '')),
)

function isVideoFile(path: string): boolean {
  return videoExts.has(extname(path).slice(1).toLowerCase())
}

/** Plain node:fs recursive walk — no dependency. Skips (and warns to stderr on) any directory
 *  it can't read (permission-denied subtree, a root that doesn't exist, etc.) rather than aborting
 *  the whole evidence-collection run over one bad path among possibly several roots. */
function walk(dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`skip unreadable path ${dir}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && isVideoFile(full)) {
      out.push(full)
    }
  }
}

function isPark(result: PathIdentity | Park): result is Park {
  return 'park' in result
}

function main() {
  const files: string[] = []
  for (const root of positionals) walk(root, files)
  console.error(`live-recognize: found ${files.length} video file(s) under ${positionals.length} root(s)`)

  let identifiedCount = 0
  const parked: Record<string, number> = {}

  for (const path of files) {
    const result = identifyFromPath(path)
    console.log(JSON.stringify({ path, result }))
    if (isPark(result)) {
      parked[result.park] = (parked[result.park] ?? 0) + 1
    } else {
      identifiedCount++
    }
  }

  console.log(JSON.stringify({ files: files.length, identified: identifiedCount, parked }))
}

main()
