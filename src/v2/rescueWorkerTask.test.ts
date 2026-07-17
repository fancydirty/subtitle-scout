import { describe, it, expect, vi } from 'vitest'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { JobsRepo } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import {
  mapWorkerTaskToRescueTask,
  runRescueWorkerTask,
  type RescueReport,
  type RescueWorkerTaskDeps,
} from './rescueWorkerTask.js'

const NOW = 1_800_000_000_000

function setup() {
  const db = openDb(':memory:')
  const lib = new LibraryRepo(db)
  const jobsRepo = new JobsRepo(db)
  jobsRepo.upsertWorkerTask(
    { seriesId: 'rescue', season: null, movieId: null },
    { taskType: 'rescue_identify', reason: 'rescue scan' },
    null,
    NOW,
  )
  const job = jobsRepo.claimNext(NOW)!
  return { db, lib, jobsRepo, job }
}

function baseDeps(lib: LibraryRepo, over: Partial<Omit<RescueWorkerTaskDeps, 'lib'>> = {}): RescueWorkerTaskDeps {
  return {
    lib,
    probeDuration: over.probeDuration ?? (async () => null),
    claimParked: over.claimParked ?? (() => ({ ok: true })),
    requestIngest: over.requestIngest,
    runs: over.runs,
    runTask: over.runTask ?? vi.fn(async () => ({ outcomes: [] })),
  }
}

function report(outcomes: RescueReport['outcomes']): RescueReport {
  return { outcomes }
}

describe('mapWorkerTaskToRescueTask', () => {
  it('groups parked paths by dirname and filters excluded/duplicate rows', async () => {
    const { lib } = setup()
    lib.upsertParkedPath('/media/A/a.mkv', 'no tmdb match', 1000)
    lib.upsertParkedPath('/media/A/b.mkv', 'no tmdb match', 1000)
    lib.upsertParkedPath('/media/B/c.mkv', 'ambiguous', 1000)
    lib.upsertParkedPath('/media/B/d.mkv', 'ambiguous', 1000)
    lib.upsertParkedPath('/media/C/e.mkv', 'excluded-extra', 1000)
    lib.upsertParkedPath('/media/D/f.mkv', 'duplicate-content', 1000)

    const probeDuration = vi.fn(async (path: string) => path === '/media/A/a.mkv' ? 100 : null)
    const task = await mapWorkerTaskToRescueTask({ lib, probeDuration }, 'job-1')

    expect(task).not.toBeNull()
    expect(task!.jobId).toBe('job-1')
    expect(task!.groups).toHaveLength(2)
    expect(task!.groups.map((g) => g.dir).sort()).toEqual(['/media/A', '/media/B'])

    const groupA = task!.groups.find((g) => g.dir === '/media/A')!
    expect(groupA.reason).toBe('no tmdb match')
    expect(groupA.files).toHaveLength(2)
    expect(groupA.files.find((f) => f.path === '/media/A/a.mkv')!.durationSec).toBe(100)
    expect(groupA.files.find((f) => f.path === '/media/A/b.mkv')!.durationSec).toBeNull()
  })

  it('returns null when no eligible parked paths exist', async () => {
    const { lib } = setup()
    lib.upsertParkedPath('/media/X/a.mkv', 'excluded-extra', 1000)
    const task = await mapWorkerTaskToRescueTask({ lib, probeDuration: async () => null }, 'job-1')
    expect(task).toBeNull()
  })
})

describe('runRescueWorkerTask', () => {
  it('completeDone and skips worker when mapper returns null', async () => {
    const { lib, jobsRepo, job } = setup()
    const runTask = vi.fn(async () => ({ outcomes: [] }))
    const deps = baseDeps(lib, { runTask })

    const result = await runRescueWorkerTask(job, deps, jobsRepo, () => NOW)

    expect(result).toBeNull()
    expect(runTask).not.toHaveBeenCalled()
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('harvests claimed/parked/excluded outcomes and updates park_reason', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.upsertParkedPath('/media/Claimed/a.mkv', 'no tmdb match', 1000)
    lib.upsertParkedPath('/media/Parked/b.mkv', 'ambiguous', 1000)
    lib.upsertParkedPath('/media/Excluded/c.mkv', 'ambiguous', 1000)

    const claimParked = vi.fn(() => ({ ok: true }))
    const requestIngest = vi.fn()
    const runTask = vi.fn(async () => report([
      { dir: '/media/Claimed', outcome: 'claimed', tmdbId: '123', isTv: true },
      { dir: '/media/Parked', outcome: 'parked', reason: 'still unsure' },
      { dir: '/media/Excluded', outcome: 'excluded' },
    ]))
    const deps = baseDeps(lib, { claimParked, requestIngest, runTask })

    await runRescueWorkerTask(job, deps, jobsRepo, () => NOW)

    expect(claimParked).toHaveBeenCalledWith({ path: '/media/Claimed/a.mkv', tmdbId: '123', isTv: true })
    expect(requestIngest).toHaveBeenCalledTimes(1)
    expect(lib.listParkedPaths().find((p) => p.path === '/media/Parked/b.mkv')!.park_reason).toBe('still unsure')
    expect(lib.listParkedPaths().find((p) => p.path === '/media/Excluded/c.mkv')!.park_reason).toBe('excluded-extra')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('writes one runs row per non-empty bucket', async () => {
    const { lib, jobsRepo, job, db } = setup()
    lib.upsertParkedPath('/media/Claimed/a.mkv', 'no tmdb match', 1000)
    lib.upsertParkedPath('/media/Parked/b.mkv', 'ambiguous', 1000)
    lib.upsertParkedPath('/media/Excluded/c.mkv', 'ambiguous', 1000)
    const runs = new RunsRepo(db)
    const runTask = vi.fn(async () => report([
      { dir: '/media/Claimed', outcome: 'claimed', tmdbId: '123', isTv: false },
      { dir: '/media/Parked', outcome: 'parked', reason: 'still unsure' },
      { dir: '/media/Excluded', outcome: 'excluded' },
    ]))
    const deps = baseDeps(lib, { claimParked: () => ({ ok: true }), runTask, runs })

    await runRescueWorkerTask(job, deps, jobsRepo, () => NOW)

    const rows = runs.getByJobId(job.id)
    const decisions = rows.map((r) => r.decision).sort()
    expect(decisions).toEqual(['rescue:claimed', 'rescue:excluded', 'rescue:parked'])
  })

  it('drops alien outcome dirs and logs an error without mutating parked_paths', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.upsertParkedPath('/media/Real/a.mkv', 'no tmdb match', 1000)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async () => report([
      { dir: '/media/Alien', outcome: 'claimed', tmdbId: '123', isTv: true },
    ]))
    const deps = baseDeps(lib, { runTask })

    await runRescueWorkerTask(job, deps, jobsRepo, () => NOW)

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('/media/Alien'))
    expect(lib.listParkedPaths().find((p) => p.path === '/media/Real/a.mkv')!.park_reason).toBe('no tmdb match')
    expect(jobsRepo.get(job.id)!.state).toBe('failed')
    errorSpy.mockRestore()
  })

  it('downgrades failed claim to parked with the error reason', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.upsertParkedPath('/media/Claimed/a.mkv', 'no tmdb match', 1000)
    const claimParked = vi.fn(() => ({ ok: false, error: 'path is not currently parked' }))
    const requestIngest = vi.fn()
    const runTask = vi.fn(async () => report([
      { dir: '/media/Claimed', outcome: 'claimed', tmdbId: '123', isTv: true },
    ]))
    const deps = baseDeps(lib, { claimParked, requestIngest, runTask })

    await runRescueWorkerTask(job, deps, jobsRepo, () => NOW)

    expect(requestIngest).not.toHaveBeenCalled()
    expect(lib.listParkedPaths().find((p) => p.path === '/media/Claimed/a.mkv')!.park_reason).toBe('path is not currently parked')
    expect(jobsRepo.get(job.id)!.state).toBe('done')
  })

  it('fails the job via completeError when worker throws', async () => {
    const { lib, jobsRepo, job } = setup()
    lib.upsertParkedPath('/media/A/a.mkv', 'no tmdb match', 1000)
    const runTask = vi.fn(async () => { throw new Error('step count limit exceeded') })
    const deps = baseDeps(lib, { runTask })

    const result = await runRescueWorkerTask(job, deps, jobsRepo, () => NOW)

    expect(result).toBeNull()
    const row = jobsRepo.get(job.id)!
    expect(row.state).toBe('failed')
    expect(row.last_error).toBe('step count limit exceeded')
  })
})
