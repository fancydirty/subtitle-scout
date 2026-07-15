// Manual live-verification runner — NOT wired into `npm test`. Requires TMDB_API_KEY and real
// filesystem roots; refuses to run under `vitest`/CI. Walks one or more root directories, runs
// C4's recognize() on every video file found, and prints one JSON line per file plus a final
// summary line. Judging whether the recognitions/parks are actually CORRECT is the operator's
// job — this script only collects evidence, it is not a pass/fail gate.
//
// Usage:
//   npx tsx scripts/live-recognize.ts <root...> [--ext mkv,mp4,avi]
//
// Env:
//   TMDB_API_KEY   required (same construction as src/cli/index.ts's `new TmdbClient({ apiKey })`
//                  — NOT mirrored from live-accept-find-subtitle.ts, which never builds a
//                  TmdbClient at all; that script only wires subtitle-provider adapters + an LLM).
import { parseArgs } from 'node:util'
import { readdirSync } from 'node:fs'
import { join, extname } from 'node:path'
import 'dotenv/config'
import { recognize, type Recognized, type Park } from '../src/recognition/index.js'
import { TmdbClient } from '../src/adapters/providers/tmdb.js'

if (process.env.VITEST) {
  throw new Error('live-recognize.ts must not run under vitest — it hits real TMDB network')
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

function isPark(result: Recognized | Park): result is Park {
  return 'park' in result
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`live-recognize.ts requires ${name}`)
  return v
}

async function main() {
  const tmdb = new TmdbClient({ apiKey: requireEnv('TMDB_API_KEY') })

  const files: string[] = []
  for (const root of positionals) walk(root, files)
  console.error(`live-recognize: found ${files.length} video file(s) under ${positionals.length} root(s)`)

  let recognizedCount = 0
  const parked: Record<string, number> = {}

  // Sequential on purpose: TMDB rate limits, and this is a one-shot evidence pass, not a
  // performance-sensitive path — no concurrency policy is part of C4's (deliberately thin) scope.
  // recognize()'s own contract lets a transient TmdbRequestFailedError propagate rather than
  // silently downgrading it to a park (see src/recognition/index.ts); that propagation is left
  // intact here too, so a network blip aborts the run (exit 1) instead of being misreported as a
  // park the operator would otherwise mistake for a real TMDB answer.
  for (const path of files) {
    const result = await recognize(path, tmdb)
    console.log(JSON.stringify({ path, result }))
    if (isPark(result)) {
      parked[result.park] = (parked[result.park] ?? 0) + 1
    } else {
      recognizedCount++
    }
  }

  console.log(JSON.stringify({ files: files.length, recognized: recognizedCount, parked }))
}

main().catch(e => { console.error(e); process.exit(1) })
