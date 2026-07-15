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

  it('change detected (newly recognized path) → exactly ONE orchestrate worker_task enqueued + refreshLibrary called once for the right library', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/new.mkv'],
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/media'] }],
      refreshLibrary,
    }))

    const result = await tick()

    expect(result.newlyDiscovered).toEqual(['/media/new.mkv'])
    expect(result.orchestratorTriggered).toBe(true)
    expect(result.refreshedLibraries).toEqual(['lib1'])
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(refreshLibrary).toHaveBeenCalledWith('lib1')

    const pending = pendingOrchestrateJobs()
    expect(pending.length).toBe(1)
    const payload = JSON.parse(pending[0].payload!)
    expect(payload.taskType).toBe('orchestrate')
  })

  it('second pass, same path still un-ingested (still not in knownPaths) → NO second trigger', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/new.mkv'],
      knownPaths: () => new Set(), // never ingested across both passes
      refreshLibrary,
    }))

    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(pendingOrchestrateJobs().length).toBe(1)

    const second = await tick()
    expect(second.newlyDiscovered).toEqual([])
    expect(second.orchestratorTriggered).toBe(false)
    // No additional refresh, no additional/duplicate enqueue.
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(pendingOrchestrateJobs().length).toBe(1)
  })

  it('path enters knownPaths → evicted from awaiting set; a later genuinely-new path still triggers normally', async () => {
    let known = new Set<string>()
    let files = ['/media/a.mkv']
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => files,
      knownPaths: () => known,
      refreshLibrary,
    }))

    // Pass 1: path A discovered, triggers.
    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    jobs.completeDone(pendingOrchestrateJobs()[0].id, now)

    // Ingestion completes: A now known. selfScan.ts itself skips known paths (never re-surfaces
    // them as recognized/parked), so this pass sees nothing new on disk — and A is evicted from
    // the awaiting set internally as a side effect.
    known = new Set(['/media/a.mkv'])
    const second = await tick()
    expect(second.newlyDiscovered).toEqual([])
    expect(second.orchestratorTriggered).toBe(false)
    expect(second.scan.skippedKnown).toBe(1)

    // Pass 3 (the "third appearance"): a genuinely different new path B shows up — must still
    // trigger normally, proving the eviction above didn't wedge the change-detection mechanism.
    files = ['/media/a.mkv', '/media/b.mkv']
    const third = await tick()
    expect(third.newlyDiscovered).toEqual(['/media/b.mkv'])
    expect(third.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).toHaveBeenCalledTimes(2)
  })

  it('no changes (no video files) → no refresh, no enqueue', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({ listVideoFiles: () => [], refreshLibrary }))

    const result = await tick()

    expect(result.newlyDiscovered).toEqual([])
    expect(result.orchestratorTriggered).toBe(false)
    expect(refreshLibrary).not.toHaveBeenCalled()
    expect(pendingOrchestrateJobs().length).toBe(0)
  })

  it('pending orchestrate job already queued (still wanted) → no duplicate enqueue when a second, different new path triggers', async () => {
    const refreshLibrary = vi.fn(async () => {})
    let files = ['/media/a.mkv']
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => files,
      knownPaths: () => new Set(), // A never gets ingested between passes
      refreshLibrary,
    }))

    const first = await tick()
    expect(first.orchestratorTriggered).toBe(true)
    const firstPending = pendingOrchestrateJobs()
    expect(firstPending.length).toBe(1)
    const firstJobId = firstPending[0].id

    // A different, genuinely new path B shows up while the first orchestrate job is still
    // pending (never claimed/completed) — must still dedupe onto the SAME row, not create a
    // second one.
    files = ['/media/a.mkv', '/media/b.mkv']
    const second = await tick()
    expect(second.newlyDiscovered).toEqual(['/media/b.mkv'])
    expect(second.orchestratorTriggered).toBe(true)

    const stillPending = pendingOrchestrateJobs()
    expect(stillPending.length).toBe(1)
    expect(stillPending[0].id).toBe(firstJobId) // same row, not a new one
  })

  it('parked path counts as a discovery (recognize() failed but the file is still new)', async () => {
    const recognize = vi.fn(async (): Promise<Recognized | Park> => ({ park: 'ambiguous' }))
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/media/junk.mkv'],
      recognize,
      refreshLibrary,
    }))

    const result = await tick()

    expect(result.newlyDiscovered).toEqual(['/media/junk.mkv'])
    expect(result.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
  })

  it('path matches no configured Jellyfin library → logged and skipped, still no crash; other libraries still refresh', async () => {
    const log = vi.fn()
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/outside/new.mkv', '/media/new.mkv'],
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/media'] }],
      refreshLibrary,
      log,
    }))

    const result = await tick()

    expect(result.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).toHaveBeenCalledTimes(1)
    expect(refreshLibrary).toHaveBeenCalledWith('lib1')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('/outside/new.mkv'))
  })

  it('two new paths in the same library → refreshLibrary called only once for that library (dedupe)', async () => {
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

  it('maps Jellyfin-side library locations through mappings before matching (mirrors realignExecutor.ts)', async () => {
    const refreshLibrary = vi.fn(async () => {})
    const tick = makeSelfScanTrigger(makeDeps({
      listVideoFiles: () => ['/local/tv/new.mkv'],
      mappings: [{ from: '/jellyfin/tv', to: '/local/tv' }],
      getVirtualFolders: async () => [{ id: 'lib1', locations: ['/jellyfin/tv'] }],
      refreshLibrary,
    }))

    const result = await tick()

    expect(result.orchestratorTriggered).toBe(true)
    expect(refreshLibrary).toHaveBeenCalledWith('lib1')
  })
})
