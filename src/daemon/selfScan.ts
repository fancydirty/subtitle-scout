import { readdirSync, type Dirent } from 'node:fs'
import { join, extname } from 'node:path'
import type { Recognized, Park } from '../recognition/index.js'

/**
 * B1: self-hosted periodic filesystem scan + diff detection. Subsystem C's `recognize()` turns a
 * video path into a TMDB identity (or a park); this module is the piece that decides WHICH paths
 * to feed it — a full pass over `roots`, diffed against what LibraryRepo already knows about, so
 * a daemon that no longer piggybacks on Jellyfin's own scanner still notices new files on disk.
 *
 * `makeSelfScan` carries no timer of its own — see its doc comment below for why, and what B2 is
 * expected to wire around it.
 */

/**
 * No single exported "video extensions" constant exists in this codebase to reuse: the closest
 * thing is `VIDEO_EXT_RE` in src/files/libraryRealign.ts (mkv|mp4|avi|ts|m2ts), but it's a
 * private, unexported module-local const, and touching libraryRealign.ts is out of scope here.
 * scripts/live-recognize.ts hit the exact same gap and settled on a permissive superset (adds
 * wmv/flv/webm) as its own script-local const with the same reasoning; this list is duplicated
 * from there rather than imported, since live-recognize.ts's version isn't exported either (and
 * is itself explicitly a one-shot evidence script, not something a daemon module should depend
 * on). If a third place ever needs this list, that's the signal to finally extract a shared
 * exported constant — not before.
 */
const DEFAULT_VIDEO_EXTS = new Set(['mkv', 'mp4', 'avi', 'ts', 'm2ts', 'wmv', 'flv', 'webm'])

function isVideoFile(path: string): boolean {
  return DEFAULT_VIDEO_EXTS.has(extname(path).slice(1).toLowerCase())
}

/**
 * Directory names the walk must never descend into:
 *  - dot-dirs (`.`-prefixed) — matches the convention already established by
 *    src/files/orphanScanner.ts (`name.startsWith('.')`); covers this codebase's own
 *    `.subtitle-staging/` and `.realign-build/` housekeeping dirs along with anything else hidden.
 *  - `@`-prefixed dirs — covers Synology-style `@eaDir` per-directory thumbnail caches and similar
 *    NAS vendor housekeeping junk that isn't dot-prefixed but is exactly the same kind of "not
 *    actually part of the library" noise.
 * Nothing in this codebase currently exports an equivalent junk-dir predicate to reuse, so this is
 * a fresh, self-scan-local helper.
 */
function isJunkDir(name: string): boolean {
  return name.startsWith('.') || name.startsWith('@')
}

/**
 * Default recursive walker: plain node:fs, no dependency. Same "skip and warn on unreadable
 * subtree rather than abort the whole pass" behavior as scripts/live-recognize.ts's walk(), plus
 * the isJunkDir exclusion that script doesn't need (a one-shot evidence run over an
 * operator-chosen root doesn't loop back over its own daemon-created staging/build dirs forever;
 * a recurring self-scan tick would, without this).
 *
 * Exported (去 Jellyfin 化 P3, design §P3) so v2/ingest.ts's `makeIngestPass` can reuse the exact
 * same walk — one filesystem-walking implementation, not two quietly drifting apart. This module
 * (`makeSelfScan`) keeps using it as its own default below; zero behavior change here.
 */
export function walkVideoFiles(root: string): string[] {
  const out: string[] = []
  walk(root, out)
  return out
}

function walk(dir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`self-scan: skip unreadable path ${dir}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  for (const entry of entries) {
    if (isJunkDir(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && isVideoFile(full)) {
      out.push(full)
    }
  }
}

/**
 * One source of truth for B2's interval wiring (SCAN_INTERVAL_MS env + the daemon loop's own
 * time-gate, the same shape as DaemonDeps.reconcileEveryMs in src/v2/daemon.ts). Picking the
 * default here — rather than leaving it to whichever call site first needs a number — means B2
 * and any future caller import the same constant instead of two modules quietly drifting apart.
 */
export const SELF_SCAN_DEFAULT_INTERVAL_MS = 15 * 60_000

export interface SelfScanDeps {
  /** MEDIA_ROOTS in mapped/local form — the same roots the rest of the daemon already walks. */
  roots: string[]
  /** LibraryRepo.knownPaths() — the library's own memory of "already recognized". */
  knownPaths: () => Set<string>
  /** Subsystem C's recognize(), pre-bound to a TmdbClient by the caller. */
  recognize: (videoPath: string) => Promise<Recognized | Park>
  /** Injectable walker for tests; defaults to a recursive fs walk filtering by video extension
   *  and excluding junk dirs (see isJunkDir above). */
  listVideoFiles?: (root: string) => string[]
  log: (msg: string) => void
  now?: () => number
}

export interface SelfScanResult {
  /** Video files seen on disk this pass, across all roots (known + new). */
  scanned: number
  recognized: { path: string; result: Recognized }[]
  parked: { path: string; reason: string }[]
  skippedKnown: number
}

/**
 * Builds one self-scan "tick": a function that, each time it's called, does exactly one full pass
 * over `deps.roots` — walk → diff against `knownPaths()` → `recognize()` whatever's new — and
 * returns a summary. No timer lives inside this module; interval wiring into the daemon loop
 * (SCAN_INTERVAL_MS env, the actual setTimeout/tick-gate mechanism) is explicitly B2's turf, same
 * as how src/v2/daemon.ts's `scan`/`aggregate` DaemonDeps hooks are plain closures the *daemon*
 * decides when to call, gated by its own `reconcileEveryMs` — this mirrors that shape so B2 can
 * wire it in the same way (its own meta-table timestamp + SELF_SCAN_DEFAULT_INTERVAL_MS gate).
 *
 * Park retry semantics (deliberate design choice, not an oversight): a parked path is NOT
 * persisted anywhere as "known" or "already parked" — parking just means the file isn't in the
 * library yet, so on the NEXT call to this tick function it is indistinguishable from a path
 * we've never seen, and recognize() runs on it again. No park table, no backoff, zero new
 * persistent state — the environment may have changed since the last pass (user renamed a
 * directory, TMDB indexed new data), and there is no cheap, correct way to distinguish "still
 * unrecognizable" from "now recognizable" other than trying again. This differs deliberately from
 * scripts/live-recognize.ts (a one-shot script that just reports what it saw once).
 *
 * Skip semantics: a path present in knownPaths() is never re-recognized — the corresponding
 * episodes/movies row IS the state machine's memory of "this path has already been through
 * recognition". Re-running recognize() on it would be wasted TMDB calls for no new information.
 *
 * Fault isolation: if recognize() throws (e.g. a transient TmdbRequestFailedError — see
 * src/recognition/index.ts's own doc comment on why that's deliberately NOT caught inside
 * recognize() itself), that single file is logged and counted in neither bucket, but the pass
 * keeps going for the rest of the files. It will be retried next pass — same non-memory as parks,
 * since a failed recognize() attempt never made it into the library either. This is a deliberate
 * departure from scripts/live-recognize.ts, which lets that same error propagate and abort the
 * whole run: live-recognize.ts is a one-shot manual evidence collector where "TMDB is down right
 * now" is useful information to surface immediately, but a recurring daemon pass must survive
 * TMDB flapping — one bad file (or one bad minute of TMDB) must never take down the whole tick.
 */
export function makeSelfScan(deps: SelfScanDeps): () => Promise<SelfScanResult> {
  const listVideoFiles = deps.listVideoFiles ?? walkVideoFiles

  return async function selfScanTick(): Promise<SelfScanResult> {
    const known = deps.knownPaths()
    const result: SelfScanResult = { scanned: 0, recognized: [], parked: [], skippedKnown: 0 }

    for (const root of deps.roots) {
      const files = listVideoFiles(root)
      for (const path of files) {
        result.scanned++

        if (known.has(path)) {
          result.skippedKnown++
          continue
        }

        try {
          const outcome = await deps.recognize(path)
          if ('park' in outcome) {
            result.parked.push({ path, reason: outcome.park })
          } else {
            result.recognized.push({ path, result: outcome })
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          deps.log(`self-scan: recognize() threw for ${path}, will retry next pass: ${msg}`)
          // Deliberately neither recognized nor parked — see this function's doc comment on
          // fault isolation. Not persisted anywhere, so the next tick sees this path as
          // untouched and tries again.
        }
      }
    }

    return result
  }
}
