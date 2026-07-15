import { makeSelfScan, type SelfScanDeps, type SelfScanResult } from './selfScan.js'
import { mapPath, isUnderRoots, type PathMapping } from '../core/mediaContext.js'
import type { JobsRepo } from '../v2/jobsRepo.js'

/**
 * B2: the "refresh-bridge". B1's `makeSelfScan` (selfScan.ts) turns a filesystem pass into
 * recognize()/park verdicts but writes NOTHING to the library — by design, since the library
 * tables' id space IS Jellyfin's (the orchestrator's check_series_layout resolves tmdbId via
 * `jf.getItem(seriesId)`, and a synthetic self-scan id would poison that verified gate). This
 * module turns "something changed on disk / in the library" into real ingestion + judgment,
 * without ever writing a library row itself, via TWO INDEPENDENT SIGNALS:
 *
 * **Signal A — our detection (refresh-bridge only, NO orchestrate).** A genuinely new path
 * (recognized OR parked by B1, and not already in the in-process `awaiting` set) nudges
 * Jellyfin's own scanner (`refreshLibrary`) for each affected library so the file gets ingested
 * under Jellyfin's id space. It deliberately does NOT enqueue an orchestrator pass: refresh →
 * Jellyfin scan → mirror pickup takes seconds-to-minutes, while a wanted orchestrate job is
 * claimed by the daemon's 15s dispatch loop — an orchestrate pass enqueued at detection time
 * essentially ALWAYS runs before the mirror has the new item (guaranteed no-op), and since the
 * awaiting set then suppresses any retrigger for that path, the new file would never get a
 * post-ingestion orchestrator look at all. Detection is a nudge, not a judgment trigger.
 *
 * **Signal B — ingestion confirmed (the orchestrate trigger).** An in-process snapshot of
 * `knownPaths()` from the previous pass is diffed against the current one; paths present now
 * but not in the snapshot mean the mirror actually caught up — whether our refresh-bridge
 * kicked it, or Jellyfin's own realtime monitor / scheduled scan beat us to detection entirely
 * (this signal covers both worlds for free, which Signal A alone never could). Only then is ONE
 * v3 orchestrator pass enqueued, via the existing worker_task(taskType='orchestrate') mechanism
 * (see src/agent/orchestratorAgent.tools.ts's spawn_sibling_orchestrator — the only other
 * writer of this job kind). Removed paths are ignored: deletion cleanup is the mechanical
 * reconcile's concern, not this trigger's. The orchestrator is the judgment layer; self-scan is
 * inventory only — never dispatch find/realign worker_tasks directly from here, which is what
 * preserves the orchestrator's verified zero-false-trigger gate.
 *
 * **Post-realign resume (v3 replacement for aggregate's re-derivation).** In the OLD pipeline,
 * once realignExecutor.ts's `retireAllForSeries` retired every job for a restructured series, the
 * next `aggregate()` pass re-derived fresh series_season jobs so subtitle searching resumed
 * against the new layout. With `aggregate()` gone, Signal B carries that resume responsibility:
 * realign renames files → the mechanical scan() mirror updates `episodes.path` → this signal's
 * grow-diff sees the new paths appear (the vanished old paths are simply ignored, same as any
 * other removal) → one orchestrate pass is enqueued → the orchestrator sees missing coverage on
 * the realigned series and dispatches find_subtitle worker_tasks. See selfScanTrigger.test.ts's
 * "post-realign resume" case for the REALIGN-shaped variant (simultaneous removals + additions).
 *
 * "Awaiting" set (Signal A's memory): every path we already reacted to (recognized OR parked)
 * but that hasn't shown up in `knownPaths()` yet. selfScan.ts itself has NO memory (a parked
 * path is retried every pass, forever, by design — see its own doc comment) — without this set,
 * every self-scan gate would re-refresh for the exact same still-un-ingested file. A path is
 * evicted once it appears in `knownPaths()` (ingestion completed — naturally a subset of Signal
 * B's grow-diff), freeing it to trigger again if it ever vanishes and reappears.
 *
 * Both pieces of state (awaiting set + knownPaths snapshot) live only in process memory. A
 * daemon restart forgets them, with two consequences, both accepted and one desirable:
 *  - awaiting forgotten → at most one redundant refreshLibrary cycle for paths still mid-ingest.
 *  - snapshot forgotten → the first pass sees EVERY known path as newly-known and fires one
 *    catch-up orchestrate pass per daemon restart. Deliberate: anything Jellyfin ingested while
 *    the daemon was down gets its post-ingestion orchestrator look this way (post-downtime
 *    catch-up), instead of silently never being judged.
 * Same "zero new persistent state" call B1 made — not worth a table.
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
  /** Signal A: paths discovered (recognized or parked) this pass that were NOT already in the
   *  awaiting set — the ones that drove refreshLibrary below. */
  newlyDiscovered: string[]
  /** Signal A: distinct Jellyfin library ids refreshed this pass (deduped — at most one
   *  refreshLibrary call per library per pass, per the design). */
  refreshedLibraries: string[]
  /** Signal B: paths present in knownPaths() now but not in the previous pass's snapshot —
   *  ingestion confirmed, whoever kicked it (our refresh-bridge or Jellyfin's own scanner). */
  ingestedNew: string[]
  /** Signal B fired: exactly one orchestrate worker_task upserted this pass. */
  orchestratorTriggered: boolean
}

/**
 * Builds one self-scan-trigger "tick": wraps B1's `makeSelfScan(deps)` with the two-signal
 * refresh-bridge decision described above. Like `makeSelfScan`, this carries no timer of its
 * own — the daemon (src/v2/daemon.ts) decides when to call it, gated by its own
 * `last_self_scan_at` meta-table timestamp, same idiom as `last_reconcile_at`.
 */
export function makeSelfScanTrigger(
  deps: SelfScanTriggerDeps,
): () => Promise<SelfScanTriggerResult> {
  const tick = makeSelfScan(deps)
  // In-process only — see this module's doc comment for why that's an accepted tradeoff.
  const awaiting = new Set<string>()
  // Signal B's memory: knownPaths() as of the previous pass. Starts empty on purpose — the
  // first pass after process start treats every known path as newly-known and fires one
  // catch-up orchestrate pass (post-downtime catch-up, see module doc comment).
  let knownSnapshot = new Set<string>()

  return async function selfScanTriggerTick(): Promise<SelfScanTriggerResult> {
    const scan = await tick()
    const known = deps.knownPaths()

    // ---- Signal B: ingestion confirmed (knownPaths grew vs previous pass's snapshot) ----
    // Computed BEFORE Signal A touches anything: it depends only on the library's own state,
    // not on what this pass discovered on disk. Removed paths are deliberately ignored.
    const ingestedNew = [...known].filter(path => !knownSnapshot.has(path))
    knownSnapshot = known

    // Evict awaiting paths that have completed ingestion (naturally a subset of ingestedNew,
    // but swept against the full awaiting set so a path that somehow entered knownPaths
    // before this closure ever snapshotted it still gets released). Frees them to trigger
    // again later, and keeps the set from growing without bound.
    for (const path of awaiting) {
      if (known.has(path)) awaiting.delete(path)
    }

    let orchestratorTriggered = false
    if (ingestedNew.length > 0) {
      // Exactly ONE orchestrator pass per ingestion event — never find/realign worker_tasks
      // directly (the orchestrator is the judgment layer; self-scan is inventory only). The
      // fixed identity makes this a same-row touch if an earlier self-scan-triggered
      // orchestrate job is still pending (see SELF_SCAN_ORCHESTRATE_SERIES_ID's doc comment).
      deps.jobs.upsertWorkerTask(
        { seriesId: SELF_SCAN_ORCHESTRATE_SERIES_ID, season: null, movieId: null },
        { taskType: 'orchestrate', reason: `self-scan: ${ingestedNew.length} path(s) confirmed ingested` },
        null,
        deps.now(),
      )
      orchestratorTriggered = true
      deps.log(`self-scan trigger: ${ingestedNew.length} path(s) confirmed ingested — orchestrator pass enqueued`)
    }

    // ---- Signal A: our detection → refresh-bridge nudge (NO orchestrate on this signal) ----
    // Both recognized AND parked paths count as "discovered" — a park means recognize()
    // couldn't establish an identity, not that the file isn't real; Jellyfin's own scanner may
    // still resolve it. Either way, once we've nudged for a path once, we don't nudge again
    // every pass just because it's still un-ingested.
    const discoveredThisPass = [
      ...scan.recognized.map(r => r.path),
      ...scan.parked.map(p => p.path),
    ]
    const newlyDiscovered = discoveredThisPass.filter(path => !awaiting.has(path))
    for (const path of discoveredThisPass) awaiting.add(path)

    const refreshedIds = new Set<string>()
    if (newlyDiscovered.length > 0) {
      // Map each newly-discovered (local) path to its owning Jellyfin library — same
      // Locations-based matching realignExecutor.ts uses (folders.find + mapPath +
      // underLocation), just walked in the opposite direction: realign starts from a series
      // and finds its library; here we start from a bare filesystem path.
      const folders = await deps.getVirtualFolders()
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

      // Dedupe: refresh each affected library at most once per pass, regardless of how many
      // new paths landed in it.
      for (const id of refreshedIds) {
        await deps.refreshLibrary(id)
      }
    }

    return {
      scan,
      newlyDiscovered,
      refreshedLibraries: [...refreshedIds],
      ingestedNew,
      orchestratorTriggered,
    }
  }
}
