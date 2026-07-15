import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb } from '../v2/db.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import {
  makeSelfScanTrigger,
  SELF_SCAN_ORCHESTRATE_SERIES_ID,
  type SelfScanTriggerDeps,
  type VirtualFolderLike,
} from './selfScanTrigger.js'
import type { Recognized, Park } from '../recognition/index.js'

function recognized(overrides: Partial<Recognized> = {}): Recognized {
  return { tmdbId: 1, title: 'Show', isTv: true, season: 1, episode: 1, absoluteEpisode: null, ...overrides } as Recognized
}

describe('makeSelfScanTrigger', () => {
  let jobs: JobsRepo
  let now: number

  beforeEach(() => {
    const db = openDb(':memory:')
    jobs = new JobsRepo(db)
    now = Date.now()
  })

  function pendingOrchestrateJobs() {
    return jobs
      .listByState('wanted')
      .filter(j => j.kind === 'worker_task' && j.series_id === SELF_SCAN_ORCHESTRATE_SERIES_ID)
  }

  function makeDeps(over: Partial<SelfScanTriggerDeps> = {}): SelfScanTriggerDeps {
    return {
      roots: ['/media'],
      knownPaths: () => new Set<string>(),
      recognize: vi.fn(async () => recognized()),
      listVideoFiles: () => [],
      log: () => {},
      now: () => now,
      getVirtualFolders: async (): Promise<VirtualFolderLike[]> => [{ id: 'lib1', locations: ['/media'] }],
      refreshLibrary: vi.fn(async () => {}),
      mappings: [],
      jobs,
      ...over,
    }
  }

  // ---- Signal A: detection → refresh-bridge only (NO orchestrate on this signal) ----

  it('Signal A: newly recognized path → refreshLibrary called once for the right library, NO orchestrate enqueued that pass', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/new.mkv'],
      knownPaths: () => new Set(), // not ingested yet — and empty snapshot diff too
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/media'] }],
      refreshLibrary,
    }))

    const result = await tick()

    expect(result.newlyDiscovered).toEqual(['/media/new.mkv'])
    expect(result.refreshedLibraries).toEqual(['lib1'])
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(refreshLibrary).toHaveBeenCalledWith('lib1')
    // The whole point of the two-signal split: detection alone must NOT enqueue an
    // orchestrator pass — the mirror hasn't ingested the file yet, the pass would be
    // a guaranteed no-op, and the awaiting set would then suppress any retrigger.
    expect(result.orchestratorTriggered).toBe(false)
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('Signal A: second pass, same path still un-ingested → NO second refresh (awaiting-set suppression)', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/new.mkv'],
      knownPaths: () => new Set(), // never ingested across both passes
      refreshLibrary,
    }))

    const first = await tick()
    expect(first.newlyDiscovered).toEqual(['/media/new.mkv'])
    expect(refreshLibrary).toHaveBeenCalledTimes(1)

    const second = await tick()
    expect(second.newlyDiscovered).toEqual([])
    expect(refreshLibrary).toHaveBeenCalledTimes(1) // no additional refresh
    expect(pendingOrchestrateJobs().length).toBe(0) // and still no orchestrate — nothing ingested
  })

  it('Signal A: parked path counts as a discovery (refresh fires) but still no orchestrate', async () => {
    const recognize = vi.fn(async (): Promise<Recognized | Park> => ({ park: 'ambiguous' }))
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/junk.mkv'],
      recognize,
      refreshLibrary,
    }))

    const result = await tick()

    expect(result.newlyDiscovered).toEqual(['/media/junk.mkv'])
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(result.orchestratorTriggered).toBe(false)
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('Signal A: path matches no configured Jellyfin library → logged and skipped; other libraries still refresh', async () => {
    const log = vi.fn()
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/outside/new.mkv', '/media/new.mkv'],
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/media'] }],
      refreshLibrary,
      log,
    }))

    await tick()

    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(refreshLibrary).toHaveBeenCalledWith('lib1')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/outside/new.mkv'))
  })

  it('Signal A: two new paths in the same library → refreshLibrary called only once for that library (dedupe)', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/a.mkv', '/media/b.mkv'],
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/media'] }],
      refreshLibrary,
    }))

    const result = await tick()

    expect(result.newlyDiscovered.sort()).toEqual(['/media/a.mkv', '/media/b.mkv'])
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(refreshLibrary).toHaveBeenCalledWith('lib1')
  })

  it('Signal A: maps Jellyfin-side library locations through mappings before matching (mirrors realignExecutor.ts)', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/local/tv/new.mkv'],
      mappings: [{ from: '/jellyfin/tv', to: '/local/tv' }],
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/jellyfin/tv'] }],
      refreshLibrary,
    }))

    await tick()

    expect(refreshLibrary).toHaveBeenCalledWith('lib1')
  })

  // ---- Signal B: ingestion confirmed (knownPaths grew) → the orchestrate trigger ----

  it('Signal B: next pass where the discovered path has entered knownPaths → orchestrate enqueued exactly once + path evicted from awaiting', async () => {
    let known = new Set<string>()
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/new.mkv'],
      knownPaths: () => known,
      refreshLibrary,
    }))

    // Pass 1: detection → refresh only, no orchestrate (Signal A).
    const first = await tick()
    expect(first.orchestratorTriggered).toBe(false)
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(pendingOrchestrateJobs().length).toBe(0)

    // Ingestion completes between passes (our refresh nudge landed, Jellyfin scanned, the
    // mirror's next mechanical scan picked it up): knownPaths now contains the path.
    known = new Set(['/media/new.mkv'])

    // Pass 2: Signal B fires — exactly one orchestrate pass, post-ingestion, when the
    // orchestrator can actually see the new item in the mirror.
    const second = await tick()
    expect(second.ingestedNew).toEqual(['/media/new.mkv'])
    expect(second.orchestratorTriggered).toBe(true)
    expect(pendingOrchestrateJobs().length).toBe(1)
    const payload = JSON.parse(pendingOrchestrateJobs()[0].payload!)
    expect(payload.taskType).toBe('orchestrate')
    // No extra refresh this pass — the path is known now, selfScan skips it, nothing new.
    expect(refreshLibrary).toHaveBeenCalledTimes(1)

    // Pass 3: knownPaths unchanged → snapshot diff empty → no re-enqueue.
    jobs.retire(pendingOrchestrateJobs()[0].id, now) // wanted → done (completeDone only covers active states)
    const third = await tick()
    expect(third.ingestedNew).toEqual([])
    expect(third.orchestratorTriggered).toBe(false)
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('Signal B: knownPaths grows WITHOUT us ever having recognized the path (Jellyfin self-detected) → orchestrate enqueued', async () => {
    let known = new Set<string>()
    const recognize = vi.fn(async () => recognized())
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => [], // self-scan never sees anything — Jellyfin's own scheduler won
      knownPaths: () => known,
      recognize,
      refreshLibrary,
    }))

    // Pass 1: nothing anywhere — establishes an empty snapshot.
    const first = await tick()
    expect(first.orchestratorTriggered).toBe(false)

    // Jellyfin's own realtime monitor / scheduled scan ingested a file we never discovered.
    known = new Set(['/media/jellyfin-found-this.mkv'])

    const second = await tick()
    expect(recognize).not.toHaveBeenCalled() // we truly never detected it ourselves
    expect(refreshLibrary).not.toHaveBeenCalled()
    expect(second.ingestedNew).toEqual(['/media/jellyfin-found-this.mkv'])
    expect(second.orchestratorTriggered).toBe(true)
    expect(pendingOrchestrateJobs().length).toBe(1)
  })

  it('Signal B: knownPaths unchanged across passes → no enqueue (idle passes stay silent)', async () => {
    const known = new Set(['/media/old.mkv'])
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/old.mkv'], // on disk AND known → skippedKnown
      knownPaths: () => known,
      refreshLibrary,
    }))

    // Pass 1 is the restart catch-up (see dedicated test below) — consume it.
    await tick()
    for (const j of pendingOrchestrateJobs()) jobs.retire(j.id, now) // wanted → done

    const second = await tick()
    expect(second.ingestedNew).toEqual([])
    expect(second.orchestratorTriggered).toBe(false)
    expect(refreshLibrary).not.toHaveBeenCalled()
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('Signal B: removed paths are ignored — knownPaths shrinking does not enqueue', async () => {
    let known = new Set(['/media/a.mkv', '/media/b.mkv'])
    const tick = makeSelfScanTrigger(makeDeps({ knownPaths: () => known }))

    await tick() // restart catch-up consumes the initial non-empty snapshot diff
    for (const j of pendingOrchestrateJobs()) jobs.retire(j.id, now) // wanted → done

    known = new Set(['/media/a.mkv']) // b was deleted from the library — not our concern here
    const second = await tick()
    expect(second.ingestedNew).toEqual([])
    expect(second.orchestratorTriggered).toBe(false)
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('post-realign resume: simultaneous path removals + additions still fire Signal B (aggregate-free resume path)', async () => {
    // Locks the v3 replacement for aggregate's post-realign re-derivation (design doc W0-2):
    // realignExecutor.retireAllForSeries retires every job for the realigned series, and — with
    // aggregate() gone — nothing re-derives fresh series_season jobs except this trigger's
    // Signal B. This exercises the REALIGN shape specifically: old paths vanish and new paths
    // appear in the SAME pass (not pure growth like the tests above), which is exactly what
    // happens once realign renames files and the mechanical scan() mirror updates
    // episodes.path to match.
    const preRealign = new Set(['/lib/Show/1.mkv', '/lib/Show/2.mkv'])
    const postRealign = new Set([
      '/lib/Show (2016) [tmdbid-1]/Season 01/S01E01.mkv',
      '/lib/Show (2016) [tmdbid-1]/Season 01/S01E02.mkv',
    ])
    let known = preRealign
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      // selfScan's own walk never contributes a NEW on-disk discovery in this scenario — by
      // the time each pass runs, the mirror already reflects that exact pass's knownPaths (the
      // mechanical scan() mirror ran first), so every path the walker reports is already known
      // and gets skipped. This isolates the assertions to Signal B alone, per the task's "keep
      // the scenario minimal and deterministic" instruction — no fs is touched either way.
      listVideoFiles: () => [...known],
      knownPaths: () => known,
      refreshLibrary,
    }))

    // Pass 1: process-start catch-up (see 'restart semantics' test below) fires on the
    // pre-realign set since the snapshot starts empty — not what's under test here, so retire
    // it to keep pass 2's assertions clean, per the existing tests' handling.
    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    for (const j of pendingOrchestrateJobs()) jobs.retire(j.id, now)

    // Realign happens between passes: retireAllForSeries has already run, files are renamed on
    // disk, and the mechanical scan() mirror has updated episodes.path to the new locations —
    // knownPaths() now reflects ONLY the new layout; the old paths are simultaneously gone.
    known = postRealign

    const second = await tick()
    expect(second.ingestedNew.sort()).toEqual([...postRealign].sort())
    expect(second.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).not.toHaveBeenCalled() // no Signal A — nothing newly discovered on disk
    expect(pendingOrchestrateJobs().length).toBe(1)
    const payload = JSON.parse(pendingOrchestrateJobs()[0].payload!)
    expect(payload.taskType).toBe('orchestrate')
  })

  it('restart semantics: fresh trigger instance + non-empty knownPaths → one catch-up enqueue on the first pass', async () => {
    // Process restart forgets the snapshot; the first pass sees every known path as
    // "newly known" and fires one catch-up orchestrate pass. Deliberate: anything ingested
    // during daemon downtime gets its post-ingestion orchestrator look this way.
    const tick = makeSelfScanTrigger(makeDeps({
      knownPaths: () => new Set(['/media/ingested-during-downtime.mkv']),
    }))

    const result = await tick()

    expect(result.ingestedNew).toEqual(['/media/ingested-during-downtime.mkv'])
    expect(result.orchestratorTriggered).toBe(true)
    expect(pendingOrchestrateJobs().length).toBe(1)
  })

  it('Signal B dedupe: a second ingestion event while the first orchestrate job is still pending → same row, no duplicate', async () => {
    let known = new Set<string>()
    const tick = makeSelfScanTrigger(makeDeps({ knownPaths: () => known }))

    await tick() // empty snapshot established (known is empty — no catch-up fires)
    expect(pendingOrchestrateJobs().length).toBe(0)

    known = new Set(['/media/a.mkv'])
    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    const firstPending = pendingOrchestrateJobs()
    expect(firstPending.length).toBe(1)
    const firstJobId = firstPending[0].id

    // Another file gets ingested while the first orchestrate job is still wanted (never
    // claimed) — upsertWorkerTask's identity dedup must land on the SAME row.
    known = new Set(['/media/a.mkv', '/media/b.mkv'])
    const second = await tick()
    expect(second.ingestedNew).toEqual(['/media/b.mkv'])
    expect(second.orchestratorTriggered).toBe(true)

    const stillPending = pendingOrchestrateJobs()
    expect(stillPending.length).toBe(1)
    expect(stillPending[0].id).toBe(firstJobId) // same row, not a new one
  })

  it('full lifecycle: detect → refresh (no orchestrate) → ingest → orchestrate → later new path repeats the cycle', async () => {
    let known = new Set<string>()
    let files = ['/media/a.mkv']
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => files,
      knownPaths: () => known,
      refreshLibrary,
    }))

    // Detect A → refresh only.
    const p1 = await tick()
    expect(p1.newlyDiscovered).toEqual(['/media/a.mkv'])
    expect(p1.orchestratorTriggered).toBe(false)
    expect(refreshLibrary).toHaveBeenCalledTimes(1)

    // A ingested → orchestrate.
    known = new Set(['/media/a.mkv'])
    const p2 = await tick()
    expect(p2.orchestratorTriggered).toBe(true)
    jobs.retire(pendingOrchestrateJobs()[0].id, now) // wanted → done (completeDone only covers active states)

    // New path B appears → Signal A again (awaiting-set eviction of A didn't wedge anything).
    files = ['/media/a.mkv', '/media/b.mkv']
    const p3 = await tick()
    expect(p3.newlyDiscovered).toEqual(['/media/b.mkv'])
    expect(p3.orchestratorTriggered).toBe(false)
    expect(refreshLibrary).toHaveBeenCalledTimes(2)

    // B ingested → orchestrate again (fresh row — previous one is done).
    known = new Set(['/media/a.mkv', '/media/b.mkv'])
    const p4 = await tick()
    expect(p4.ingestedNew).toEqual(['/media/b.mkv'])
    expect(p4.orchestratorTriggered).toBe(true)
    expect(pendingOrchestrateJobs().length).toBe(1)
  })
})
