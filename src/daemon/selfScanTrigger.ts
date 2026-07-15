import { makeSelfScan, type SelfScanDeps, type SelfScanResult } from './selfScan.js'
import { mapPath, isUnderRoots, type PathMapping } from '../core/mediaContext.js'
import type { JobsRepo } from '../v2/jobsRepo.js'

/**
 * B2: the "refresh-bridge". B1's `makeSelfScan` (selfScan.ts) turns a filesystem pass into
 * recognize()/park verdicts but writes NOTHING to the library — by design, since the library
 * tables' id space IS Jellyfin's (the orchestrator's check_series_layout resolves tmdbId via
 * `jf.getItem(seriesId)`, and a synthetic self-scan id would poison that verified gate). This
 * module is what turns "we found something new on disk" into real ingestion, without ever
 * writing a library row itself:
 *
 *   1. recognize()/park already happened (B1) — that's detection + verification.
 *   2. On a genuinely NEW discovery (not one we already reacted to and are still waiting on),
 *      nudge Jellyfin's own scanner (`refreshLibrary`) so it ingests the file under ITS id space.
 *   3. Enqueue exactly one v3 orchestrator pass (the existing worker_task(taskType='orchestrate')
 *      mechanism — see src/agent/orchestratorAgent.tools.ts's spawn_sibling_orchestrator tool,
 *      which is the only other place that writes this job kind today) so the orchestrator's own
 *      scanLibrary mirrors the now-ingested item into episodes/movies and judges it. The
 *      orchestrator is the judgment layer; self-scan is inventory only — this is what preserves
 *      the orchestrator's verified zero-false-trigger gate instead of dispatching find/realign
 *      worker_tasks directly.
 *
 * "Change" detection: an in-process `awaiting` Set<string> remembers every path this module has
 * already reacted to (recognized OR parked) but that hasn't shown up in `knownPaths()` yet
 * (i.e. Jellyfin/the mirror hasn't ingested it). selfScan.ts itself has NO memory (a parked path
 * is retried every single pass, forever, by design — see its own doc comment) — without this
 * set, every 15-minute self-scan gate would re-trigger a refresh + orchestrator pass for the
 * exact same still-un-ingested file, spinning the daemon on files Jellyfin/TMDB simply hasn't
 * resolved yet. A path is evicted from the set once it appears in `knownPaths()` (ingestion
 * completed) — freeing it to trigger again if it somehow vanishes and reappears later.
 *
 * The set lives only in process memory: a daemon restart forgets it, so the first self-scan pass
 * after a restart may re-trigger one redundant refresh + orchestrator pass for paths that were
 * already "awaiting" before the restart. That one extra cycle is cheap (one refreshLibrary call
 * per already-known-to-be-affected library, one no-op-ish orchestrator pass) and deliberately not
 * worth persisting — same "no park table, no backoff, zero new persistent state" call B1 made.
 */

export interface VirtualFolderLike {
  id: string
  locations: string[]
}

/** Fixed worker_task identity for self-scan-triggered orchestrator passes. Deliberately a single
 *  constant (not one per affected series/library, unlike dispatch_find_subtitle_task/
 *  dispatch_realign_task): upsertWorkerTask's ON CONFLICT dedup is identity-keyed, so reusing the
 *  SAME identity on every trigger is what gives "at most one pending self-scan-triggered
 *  orchestrator job at a time" for free — a second trigger while the first is still
 *  wanted/searching/etc. just touches `updated_at` (see jobsRepo.ts's upsertWorkerTask), it does
 *  NOT enqueue a second row. Modeled on spawn_sibling_orchestrator's synthetic
 *  `orchestrator-shard-<parentJobId>-<n>` seriesId (orchestratorAgent.tools.ts) — same trick,
 *  simpler because self-scan has no parent job / shard index to encode. */
export const SELF_SCAN_ORCHESTRATE_SERIES_ID = 'self-scan-trigger'

export interface SelfScanTriggerDeps extends Omit<SelfScanDeps, 'now'> {
  now: () => number
  /** Library listing — same shape/semantics as JellyfinClient.getVirtualFolders() /
   *  RealignJellyfinPort.getVirtualFolders (realignExecutor.ts): `locations` are Jellyfin-side
   *  paths, mapped through `mappings` before comparing against local self-scan paths, exactly
   *  like realignExecutor.ts's own `folders.find(f => f.locations.some(loc => underLocation(...`
   *  matching. */
  getVirtualFolders: () => Promise<VirtualFolderLike[]>
  refreshLibrary: (libraryId: string) => Promise<void>
  mappings: PathMapping[]
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
}

export interface SelfScanTriggerResult {
  scan: SelfScanResult
  /** Paths discovered (recognized or parked) this pass that were NOT already in the awaiting
   *  set — i.e. the ones that actually drove refresh/enqueue below. */
  newlyDiscovered: string[]
  /** Distinct Jellyfin library ids refreshed this pass (deduped — at most one refreshLibrary
   *  call per library per pass, per the design). */
  refreshedLibraries: string[]
  orchestratorTriggered: boolean
}

/**
 * Builds one self-scan-trigger "tick": wraps B1's `makeSelfScan(deps)` with the refresh-bridge
 * decision described above. Like `makeSelfScan`, this carries no timer of its own — the daemon
 * (src/v2/daemon.ts) decides when to call it, gated by its own `last_self_scan_at` meta-table
 * timestamp, same idiom as `last_reconcile_at`.
 */
export function makeSelfScanTrigger(
  deps: SelfScanTriggerDeps,
): () => Promise<SelfScanTriggerResult> {
  const tick = makeSelfScan(deps)
  // In-process only — see this module's doc comment for why that's an accepted tradeoff.
  const awaiting = new Set<string>()

  return async function selfScanTriggerTick(): Promise<SelfScanTriggerResult> {
    const scan = await tick()

    // Evict paths that have completed ingestion since we last saw them — frees them to trigger
    // again later, and keeps the set from growing without bound over the daemon's lifetime.
    const known = deps.knownPaths()
    for (const path of awaiting) {
      if (known.has(path)) awaiting.delete(path)
    }

    // Both recognized AND parked paths count as "discovered" — a park means recognize() couldn't
    // establish an identity, not that the file isn't real; Jellyfin's own scanner may still
    // resolve it, and it's still worth one orchestrator look. Either way, once we've reacted to a
    // path once, we don't react to it again every pass just because it's still un-ingested.
    const discoveredThisPass = [
      ...scan.recognized.map(r => r.path),
      ...scan.parked.map(p => p.path),
    ]
    const newlyDiscovered = discoveredThisPass.filter(path => !awaiting.has(path))
    for (const path of discoveredThisPass) awaiting.add(path)

    if (newlyDiscovered.length === 0) {
      return { scan, newlyDiscovered, refreshedLibraries: [], orchestratorTriggered: false }
    }

    // Map each newly-discovered (local) path to its owning Jellyfin library — same
    // Locations-based matching realignExecutor.ts uses (folders.find + mapPath + underLocation),
    // just walked in the opposite direction: realign starts from a series and finds its library;
    // here we start from a bare filesystem path.
    const folders = await deps.getVirtualFolders()
    const refreshedIds = new Set<string>()
    for (const path of newlyDiscovered) {
      const owner = folders.find(f =>
        f.locations.some(loc => isUnderRoots(path, [mapPath(loc, deps.mappings)])),
      )
      if (!owner) {
        deps.log(`self-scan trigger: ${path} matches no configured Jellyfin library — skipping refresh`)
        continue
      }
      refreshedIds.add(owner.id)
    }

    // Dedupe: refresh each affected library at most once per pass, regardless of how many new
    // paths landed in it.
    for (const id of refreshedIds) {
      await deps.refreshLibrary(id)
    }

    // Exactly ONE orchestrator pass per pass with change — never dispatch find/realign
    // worker_tasks directly (see this module's doc comment: the orchestrator is the judgment
    // layer, self-scan is inventory only). The fixed identity is what makes this a no-op if an
    // earlier self-scan-triggered orchestrator job is still pending (see
    // SELF_SCAN_ORCHESTRATE_SERIES_ID's doc comment).
    deps.jobs.upsertWorkerTask(
      { seriesId: SELF_SCAN_ORCHESTRATE_SERIES_ID, season: null, movieId: null },
      { taskType: 'orchestrate', reason: `self-scan: ${newlyDiscovered.length} new path(s) discovered` },
      null,
      deps.now(),
    )

    return {
      scan,
      newlyDiscovered,
      refreshedLibraries: [...refreshedIds],
      orchestratorTriggered: true,
    }
  }
}
