import { readdirSync, type Dirent } from 'node:fs'
import { join, extname } from 'node:path'

/**
 * B1: self-hosted periodic filesystem scan + diff detection.
 *
 * 清算波 R-6（A-F9/C-A4）：本模块曾经还导出一个 `makeSelfScan` 编排函数（walk → diff against
 * LibraryRepo.knownPaths() → recognize() whatever's new）+ 它的 SelfScanDeps/SelfScanResult
 * 类型——去 Jellyfin 化 T4 把它的唯一生产调用点（daemon.ts 的 B2 self-scan refresh-bridge）
 * 折叠进了 v2/ingest.ts 的统一 ingest 心跳（daemon.ts 头注释："机械 scan()...+ B2 self-scan
 * refresh-bridge 两条独立分支"已删除），production 自此零调用点，随死器官处决整体删除。
 * 本文件仍导出的 walkVideoFiles/isVideoFile（内部）/isJunkDir（内部）/
 * SELF_SCAN_DEFAULT_INTERVAL_MS 是活体——v2/ingest.ts、v2/realignLibraryPort.ts、
 * cli/index.ts、v2/daemon.ts 仍在用同一份遍历实现与心跳间隔常量。
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
 *  - dot-dirs (`.`-prefixed) — matches the convention src/files/orphanScanner.ts (`name.startsWith('.')`)
 *    used to establish before that module was deleted in the R-6 dead-organ purge; covers this
 *    codebase's own `.subtitle-staging/` and `.realign-build/` housekeeping dirs along with
 *    anything else hidden.
 *  - `@`-prefixed dirs — covers Synology-style `@eaDir` per-directory thumbnail caches and similar
 *    NAS vendor housekeeping junk that isn't dot-prefixed but is exactly the same kind of "not
 *    actually part of the library" noise.
 * Nothing in this codebase currently exports an equivalent junk-dir predicate to reuse, so this is
 * a fresh, self-scan-local helper.
 */
function isJunkDir(name: string): boolean {
  return name.startsWith('.') || name.startsWith('@') || name.startsWith('#')
}

/**
 * Default recursive walker: plain node:fs, no dependency. Same "skip and warn on unreadable
 * subtree rather than abort the whole pass" behavior as scripts/live-recognize.ts's walk(), plus
 * the isJunkDir exclusion that script doesn't need (a one-shot evidence run over an
 * operator-chosen root doesn't loop back over its own daemon-created staging/build dirs forever;
 * a recurring self-scan tick would, without this).
 *
 * Exported (去 Jellyfin 化 P3, design §P3) so v2/ingest.ts's `makeIngestPass` and
 * v2/realignLibraryPort.ts can reuse the exact same walk — one filesystem-walking implementation,
 * not two quietly drifting apart. (清算波 R-6/A-F9: this module's own `makeSelfScan` wrapper that
 * used to default to this walker has since been retired — see the file header comment.)
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
