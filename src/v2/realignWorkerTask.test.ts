import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runRealignWorkerTask, type RealignWorkerTaskDeps } from './realignWorkerTask.js'
import type { RealignExecutorDeps, RealignJellyfinPort } from './realignExecutor.js'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'

// Mirrors realignExecutor.test.ts's SEASONS_1x5/statSize/mkFlatLibrary/mkJf/mkDeps helpers
// (read in full before writing this file, per the phase ⑥ plan note) — trimmed to a 3-episode,
// 1-season fixture since this file is only proving the claim→executeRealign→complete wiring,
// not re-covering executeRealign's own business logic (already ~1100 lines of tests there).
const SEASONS_1x3 = [{ seasonNumber: 1, episodeCount: 3, airDate: null }]
const SHOW_DIR = 'Spy x Family (2022) [tmdbid-120089]'

const statSize = (p: string): number | null => {
  try {
    return statSync(p).size
  } catch {
    return null
  }
}

function mkFlatLibrary(root: string, count: number): string {
  const dir = join(root, 'lib', 'Spy x Family', 'Season 01')
  mkdirSync(dir, { recursive: true })
  for (let i = 1; i <= count; i++) writeFileSync(join(dir, `Spy x Family E${i}.mkv`), `video-${i}`)
  return dir
}

function mkJf(opts: {
  locations: string[]
  items?: { Type: string; Path: string; ParentIndexNumber: number }[]
}): RealignJellyfinPort {
  return {
    getItem: vi.fn(async () => ({
      Id: 'jf-series-1', Name: 'Spy x Family', Type: 'Series', ProductionYear: 2022, ProviderIds: { Tmdb: '120089' },
    }) as never),
    getItemsPage: vi.fn(async (start: number) => (start === 0 ? (opts.items ?? []) : []) as never),
    getScheduledTasks: vi.fn(async () => [{ id: '1', name: 'scan', isRunning: false }]),
    getVirtualFolders: vi.fn(async () => [
      { id: 'lib-1', name: 'TV', locations: opts.locations, enableRealtimeMonitor: false },
    ]),
    refreshLibrary: vi.fn(async () => {}),
  }
}

/** Mirrors realignExecutor.test.ts's own mkMirror, but seeds a kind='worker_task' row via
 *  upsertWorkerTask({taskType:'realign', reason}) instead of upsertWanted({kind:'realign'}) —
 *  this is the exact shape src/agent/orchestratorAgent.tools.ts's makeDispatchRealignTaskTool
 *  writes (phase ⑤, already merged): kind='worker_task', season=null, movieId=null, payload
 *  {taskType:'realign', reason}. Proving runRealignWorkerTask consumes THIS row shape (not a
 *  standalone kind='realign' identity) is the whole point of this test file. */
function mkWorkerTaskMirror(paths: string[], opts: { seriesId?: string; title?: string } = {}) {
  const seriesId = opts.seriesId ?? 'jf-series-1'
  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  lib.upsertSeries({ id: seriesId, name: opts.title ?? 'Spy x Family' })
  paths.forEach((p, i) => {
    lib.upsertEpisode({
      id: `jf-ep-${i + 1}`, seriesId, season: 1, episode: i + 1, name: `E${i + 1}`,
      path: p, subStatus: 'missing',
    })
  })
  jobsRepo.upsertWorkerTask(
    { seriesId, season: null, movieId: null },
    { taskType: 'realign', reason: 'mirror episode count exceeds TMDB season table' },
    null,
    Date.now(),
  )
  const job = jobsRepo.claimNext(Date.now())!
  return { db, lib, jobsRepo, job, seriesId }
}

function mkDeps(
  env: { lib: LibraryRepo; jobsRepo: JobsRepo; jf: RealignJellyfinPort; libRoot: string },
  over: Partial<RealignWorkerTaskDeps> = {},
): RealignWorkerTaskDeps {
  return {
    lib: env.lib, jobs: env.jobsRepo, jf: env.jf,
    tmdb: { getSeasonTable: vi.fn(async () => SEASONS_1x3) },
    fetchAnimeLists: vi.fn(async () => []),
    runEpisode: vi.fn(async () => ({
      decision: 'download' as const, journalPath: '/j.json', stats: { durationMs: 1, llmCalls: 1, apiCalls: 1 },
    })),
    now: () => Date.now(), log: () => {}, sleep: async () => {},
    getSize: statSize,
    mediaRoots: [env.libRoot],
    mappings: [],
    ...over,
  }
}

describe('runRealignWorkerTask', () => {
  it('claims a kind=worker_task row (payload.taskType=realign, the phase ⑤ dispatch shape) and completes it done on a successful realign', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-worker-task-ok-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkWorkerTaskMirror(
      Array.from({ length: 3 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
    )
    expect(job.kind).toBe('worker_task')
    expect(JSON.parse(job.payload!)).toEqual({
      taskType: 'realign', reason: 'mirror episode count exceeds TMDB season table',
    })

    const jf = mkJf({
      locations: [libRoot],
      items: Array.from({ length: 3 }, (_, i) => ({
        Type: 'Episode',
        Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i + 1}.mkv`),
        ParentIndexNumber: 1,
      })),
    })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result!.decision).toBe('realigned')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
    db.close()
  })

  it('parks the job (dormant) when executeRealign returns a park decision (e.g. empty mirror — no episode paths at all)', async () => {
    const libRoot = mkdtempSync(join(tmpdir(), 'realign-worker-task-park-'))
    const { db, lib, jobsRepo, job } = mkWorkerTaskMirror([]) // no episodes -> park before any fs write
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result!.decision).toBe('park')
    expect(jobsRepo.get(job.id)!.state).toBe('dormant')
    db.close()
  })

  it('fails the job (retryable, next_retry_at set) when executeRealign returns an error decision (e.g. mount sentinel: empty library root)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-worker-task-error-'))
    const libRoot = join(root, 'lib')
    mkdirSync(libRoot, { recursive: true }) // exists but EMPTY — mountAliveSentinel rejects a dead-looking mount
    const { db, lib, jobsRepo, job } = mkWorkerTaskMirror(
      [join(libRoot, 'Show', 'Season 01', 'a.mkv')], { title: 'Show' },
    )
    const jf = mkJf({ locations: [libRoot] })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })

    const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

    expect(result!.decision).toBe('error')
    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.next_retry_at).not.toBeNull()
    db.close()
  })

  it('a thrown executeRealign (e.g. Jellyfin outage mid-call — getVirtualFolders rejects) fails the job via completeError with backoff, instead of leaving it stuck in searching with no backoff (the spin-loop bug: unlike runFindSubtitleWorkerTask/runOrchestrateWorkerTask, this wrapper previously had NO try/catch around executeRealign, so a throw propagated out, reapOrphaned would later flip the row back to wanted with error_attempt/next_retry_at untouched, and the very next claim would throw again — an unbounded, backoff-free spin loop that floods the runs table and monopolizes the realign concurrency slot for the whole outage)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realign-worker-task-throw-'))
    const oldSeasonDir = mkFlatLibrary(root, 3)
    const libRoot = join(root, 'lib')
    const { db, lib, jobsRepo, job } = mkWorkerTaskMirror(
      Array.from({ length: 3 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
    )
    const jf = mkJf({ locations: [libRoot] })
    // Simulate a Jellyfin outage: getVirtualFolders (realignExecutor.ts step 3, called before any
    // fs mutation) rejects instead of resolving — executeRealign has no top-level try/catch of its
    // own around this call, so it genuinely throws out to the caller.
    jf.getVirtualFolders = vi.fn(async () => { throw new Error('ECONNREFUSED: jellyfin unreachable') })
    const deps = mkDeps({ lib, jobsRepo, jf, libRoot })
    const before = jobsRepo.get(job.id)!
    expect(before.state).toBe('searching') // claimed, mid-flight

    const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now()).catch(e => e)

    // Must NOT throw out of the wrapper (that's the whole bug) — it must resolve, having routed
    // the throw to completeError itself.
    expect(result).not.toBeInstanceOf(Error)

    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed') // NOT left in 'searching', NOT bounced to 'wanted' with no backoff
    expect(row.error_attempt).toBeGreaterThan(before.error_attempt) // error-track attempt incremented
    expect(row.next_retry_at).not.toBeNull() // backoff scheduled — precludes the immediate-reclaim spin
    expect(row.next_retry_at!).toBeGreaterThan(Date.now()) // genuinely in the future, not a no-op backoff
    expect(row.last_error).toMatch(/ECONNREFUSED/)
    db.close()
  })

  // 退役T1 (W0-3a): v3 runner writes a `runs` row at each terminal outcome so the dashboard's
  // run-history timeline (which reads the `runs` table) has parity with the old pipeline. `runs`
  // is optional on the deps — the four tests above (which never pass `runs`) already prove the
  // no-crash-when-absent case; these tests prove the row shape when it's present.
  describe('runs row (timeline parity, 退役T1)', () => {
    it('success: writes one runs row with decision "realign:done"', async () => {
      const root = mkdtempSync(join(tmpdir(), 'realign-worker-task-runs-ok-'))
      const oldSeasonDir = mkFlatLibrary(root, 3)
      const libRoot = join(root, 'lib')
      const { db, lib, jobsRepo, job } = mkWorkerTaskMirror(
        Array.from({ length: 3 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
      )
      const jf = mkJf({
        locations: [libRoot],
        items: Array.from({ length: 3 }, (_, i) => ({
          Type: 'Episode',
          Path: join(libRoot, SHOW_DIR, 'Season 01', `f${i + 1}.mkv`),
          ParentIndexNumber: 1,
        })),
      })
      const runs = new RunsRepo(db)
      const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { runs })

      const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

      expect(result!.decision).toBe('realigned')
      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('realign:done')
      expect(rows[0].journal_path).toBeNull()
      db.close()
    })

    it('park: writes one runs row with decision "realign:parked"', async () => {
      const libRoot = mkdtempSync(join(tmpdir(), 'realign-worker-task-runs-park-'))
      const { db, lib, jobsRepo, job } = mkWorkerTaskMirror([])
      const jf = mkJf({ locations: [libRoot] })
      const runs = new RunsRepo(db)
      const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { runs })

      const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

      expect(result!.decision).toBe('park')
      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('realign:parked')
      db.close()
    })

    it('error: writes one runs row with decision "realign:error"', async () => {
      const root = mkdtempSync(join(tmpdir(), 'realign-worker-task-runs-error-'))
      const libRoot = join(root, 'lib')
      mkdirSync(libRoot, { recursive: true })
      const { db, lib, jobsRepo, job } = mkWorkerTaskMirror(
        [join(libRoot, 'Show', 'Season 01', 'a.mkv')], { title: 'Show' },
      )
      const jf = mkJf({ locations: [libRoot] })
      const runs = new RunsRepo(db)
      const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { runs })

      const result = await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

      expect(result!.decision).toBe('error')
      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('realign:error')
      db.close()
    })

    it('thrown executeRealign: writes one runs row with decision "realign:error" and the thrown message as detail', async () => {
      const root = mkdtempSync(join(tmpdir(), 'realign-worker-task-runs-throw-'))
      const oldSeasonDir = mkFlatLibrary(root, 3)
      const libRoot = join(root, 'lib')
      const { db, lib, jobsRepo, job } = mkWorkerTaskMirror(
        Array.from({ length: 3 }, (_, i) => join(oldSeasonDir, `Spy x Family E${i + 1}.mkv`)),
      )
      const jf = mkJf({ locations: [libRoot] })
      jf.getVirtualFolders = vi.fn(async () => { throw new Error('ECONNREFUSED: jellyfin unreachable') })
      const runs = new RunsRepo(db)
      const deps = mkDeps({ lib, jobsRepo, jf, libRoot }, { runs })

      await runRealignWorkerTask(job, deps, jobsRepo, () => Date.now())

      const rows = runs.getByJobId(job.id)
      expect(rows).toHaveLength(1)
      expect(rows[0].decision).toBe('realign:error')
      expect(rows[0].detail).toContain('ECONNREFUSED')
      db.close()
    })
  })
})
