import { dirname } from 'node:path'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RunsRepo } from './runsRepo.js'
import { traceBus } from '../dashboard/traceBus.js'

function capDetail(s: string, max = 200): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export interface RescueGroup {
  dir: string
  reason: string
  files: Array<{ path: string; durationSec: number | null }>
}

export interface RescueTask { jobId: string; groups: RescueGroup[] }

export type RescueGroupOutcome =
  | { dir: string; outcome: 'claimed'; tmdbId: string; isTv: boolean; season?: number | null }
  | { dir: string; outcome: 'parked'; reason: string }
  | { dir: string; outcome: 'excluded' }

export interface RescueReport { outcomes: RescueGroupOutcome[] }

export interface RescueWorkerTaskDeps {
  lib: LibraryRepo
  probeDuration: (path: string) => Promise<number | null>
  claimParked: (input: { path: string; tmdbId: string; isTv: boolean; season?: number | null }) => { ok: boolean; error?: string }
  requestIngest?: () => void
  runs?: Pick<RunsRepo, 'insert'>
  runTask: (task: RescueTask) => Promise<RescueReport>
}

/** 救援资格谓词：excluded-extra 已裁决、duplicate-content 归重复源战役（spec 非目标）。
 *  mapper 与 orchestrator 的 parked 事实块共用这一个谓词——两处过滤漂移=orchestrator 看见
 *  的数字与 rescue worker 实拿的任务组对不上。 */
export function isRescueEligible(parkReason: string): boolean {
  return parkReason !== 'excluded-extra' && parkReason !== 'duplicate-content'
}

export async function mapWorkerTaskToRescueTask(
  deps: { lib: LibraryRepo; probeDuration: (path: string) => Promise<number | null> },
  jobId: string,
): Promise<RescueTask | null> {
  const all = deps.lib.listParkedPaths()
  const eligible = all.filter((p) => isRescueEligible(p.park_reason))
  const byDir = new Map<string, typeof eligible>()
  for (const p of eligible) {
    const dir = dirname(p.path)
    const bucket = byDir.get(dir) ?? []
    bucket.push(p)
    byDir.set(dir, bucket)
  }
  if (byDir.size === 0) return null

  const groups: RescueGroup[] = []
  for (const [dir, paths] of byDir.entries()) {
    const reason = paths[0].park_reason
    const files = await Promise.all(
      paths.map(async (p) => ({ path: p.path, durationSec: await deps.probeDuration(p.path) })),
    )
    groups.push({ dir, reason, files })
  }

  return { jobId, groups }
}

export async function runRescueWorkerTask(
  job: Job,
  deps: RescueWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError'>,
  now: () => number,
): Promise<RescueReport | null> {
  const startedAt = now()
  const runKey = `job-${job.id}`
  let traceJsonCache: string | null | undefined
  const traceJsonForThisRun = (): string | null => {
    if (traceJsonCache === undefined) {
      const events = traceBus.snapshot(runKey)
      traceJsonCache = events.length > 0 ? JSON.stringify(events) : null
    }
    return traceJsonCache
  }
  const recordRun = (decision: string, detail: string): void => {
    const traceJson = traceJsonForThisRun()
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: capDetail(detail), journalPath: null,
      traceJson,
    })
  }

  try {
    const task = await mapWorkerTaskToRescueTask(deps, String(job.id))
    if (!task) {
      jobs.completeDone(job.id, now())
      return null
    }
    const report = await deps.runTask(task)

    const validDirs = new Set(task.groups.map((g) => g.dir))
    const outcomes = report.outcomes.filter((o) => {
      if (validDirs.has(o.dir)) return true
      console.error(`[rescue-harvest] job ${job.id}: dropping alien outcome dir ${o.dir}`)
      return false
    })

    let claimedAny = false
    const claimedDirs: string[] = []
    const parkedDirs: string[] = []
    const excludedDirs: string[] = []

    for (const outcome of outcomes) {
      const currentPaths = deps.lib.listParkedPaths()
      const currentPathSet = new Set(currentPaths.map((p) => p.path))
      const group = task.groups.find((g) => g.dir === outcome.dir)
      const stillParked = group?.files.map((f) => f.path).filter((p) => currentPathSet.has(p)) ?? []

      if (outcome.outcome === 'claimed') {
        const firstPath = stillParked[0]
        if (firstPath) {
          const result = deps.claimParked({
            path: firstPath, tmdbId: outcome.tmdbId, isTv: outcome.isTv, season: outcome.season,
          })
          if (result.ok) {
            claimedAny = true
            claimedDirs.push(outcome.dir)
          } else {
            console.error(`[rescue-harvest] job ${job.id}: claim failed for ${outcome.dir}: ${result.error}`)
            for (const p of stillParked) deps.lib.updateParkReason(p, result.error ?? 'claim failed', now())
            parkedDirs.push(`${outcome.dir}(${result.error ?? 'claim failed'})`)
          }
        }
      } else if (outcome.outcome === 'parked') {
        parkedDirs.push(outcome.dir)
        for (const p of stillParked) deps.lib.updateParkReason(p, outcome.reason, now())
      } else if (outcome.outcome === 'excluded') {
        excludedDirs.push(outcome.dir)
        for (const p of stillParked) deps.lib.updateParkReason(p, 'excluded-extra', now())
      }
    }

    if (claimedAny) deps.requestIngest?.()

    if (claimedDirs.length === 0 && parkedDirs.length === 0 && excludedDirs.length === 0) {
      jobs.completeError(job.id, 'empty rescue report', now())
      recordRun('error', 'empty rescue report')
    } else {
      jobs.completeDone(job.id, now())
    }

    if (claimedDirs.length) {
      recordRun('rescue:claimed', `${claimedDirs.length} 组认领: ${claimedDirs.join(', ')}`)
    }
    if (parkedDirs.length) {
      recordRun('rescue:parked', `${parkedDirs.length} 组留停: ${parkedDirs.join(', ')}`)
    }
    if (excludedDirs.length) {
      recordRun('rescue:excluded', `${excludedDirs.length} 组排除: ${excludedDirs.join(', ')}`)
    }

    return report
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
    return null
  }
}
