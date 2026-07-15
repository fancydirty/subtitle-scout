import { identifyFromPath, type PathIdentity, type Park } from './identifyFromPath.js'
import { resolveToTmdb, type Recognized } from './resolveToTmdb.js'
import type { ParsedName } from './parseFilename.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

// Re-exported so downstream consumers (B1/B2, the self-scan daemon) can import the whole
// recognition subsystem's public surface from this one module, e.g.
// `import { recognize, type Recognized, type Park } from '../recognition/index.js'`.
export type { PathIdentity, Park, ParsedName, Recognized }

/**
 * C4: the recognition subsystem's single entry point — path string in, TMDB identity or a park
 * reason out. Deliberately thin: just chains C2 (identifyFromPath) into C3 (resolveToTmdb) with
 * one short-circuit, and adds nothing of its own. No caching, no fs walking, no retry policy —
 * those are B's concerns (the self-scan daemon), explicitly out of scope here.
 *
 * A `Park` produced by identifyFromPath (pure path-string analysis, no network) short-circuits
 * before resolveToTmdb ever runs — there is nothing to search for a path with zero title signal.
 * A `TmdbRequestFailedError` thrown out of resolveToTmdb (transient network/5xx failure) is
 * deliberately NOT caught here and propagates to the caller unchanged — same distinction C3
 * documents throughout: a request that never actually got an answer is not the same thing as a
 * park (TMDB answered with nothing/too much), and collapsing the two would let a transient TMDB
 * blip get permanently misfiled as "no match".
 */
export async function recognize(videoPath: string, tmdb: TmdbClient): Promise<Recognized | Park> {
  const identity = identifyFromPath(videoPath)
  if ('park' in identity) return identity
  return resolveToTmdb(identity, tmdb)
}
