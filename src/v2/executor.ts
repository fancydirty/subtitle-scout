import type { LibraryRepo, Episode, Movie } from './libraryRepo.js'
import type { JobsRepo, Job } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import type { Assembled } from '../cli/index.js'
import { buildMediaContext, mediaDir, isDirWritable } from '../core/mediaContext.js'
import { runPipeline } from '../core/pipeline.js'
import type { SeasonEpisode } from '../core/episode.js'
import { join } from 'node:path'

export interface ExecutorDeps {
  lib: LibraryRepo
  jobs: JobsRepo
  /** 跑一个代表集的完整判断链；onCovered 在每个被季包/单集命中的集写盘成功后回调 */
  runEpisode: (
    episodeId: string,
    onCovered: (coveredEpisodeId: string, subtitlePath: string) => void
  ) => Promise<{ decision: string; journalPath?: string; detail?: string }>
  now: () => number
}

/**
 * 剧级执行器：重derive targets → 跑代表集 → 按结果分流 → 写 runs
 */
export async function executeJob(job: Job, deps: ExecutorDeps): Promise<void> {
  const { lib, jobs, runEpisode, now } = deps
  const startedAt = now()
  const runs = new RunsRepo(lib.db)

  try {
    // 1. Re-derive targets (missing episodes for this job)
    let targets: Episode[] | Movie[]
    if (job.kind === 'series_season') {
      // For series, get all missing episodes for this season
      const allMissing = lib.missingBySeason(now())
      const seasonGroup = allMissing.find(
        g => g.series_id === job.series_id && g.season === job.season
      )

      if (!seasonGroup) {
        // No missing episodes, mark job as done
        jobs.completeDone(job.id, now())
        runs.insert({
          jobId: job.id,
          startedAt,
          finishedAt: now(),
          decision: 'done',
          detail: 'All episodes already covered',
          journalPath: null,
        })
        return
      }

      // Get actual episode records
      targets = lib.db
        .prepare(
          `SELECT * FROM episodes
           WHERE series_id = ? AND season = ?
           AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))
           ORDER BY episode ASC`
        )
        .all(job.series_id, job.season, now()) as Episode[]
    } else {
      // For movie
      const movie = lib.getMovie(job.movie_id!)
      if (!movie || (movie.sub_status !== 'missing' &&
                     (movie.sub_status !== 'unavailable' || (movie.recheck_after ?? 0) > now()))) {
        jobs.completeDone(job.id, now())
        runs.insert({
          jobId: job.id,
          startedAt,
          finishedAt: now(),
          decision: 'done',
          detail: 'Movie already covered',
          journalPath: null,
        })
        return
      }
      targets = [movie]
    }

    if (targets.length === 0) {
      jobs.completeDone(job.id, now())
      runs.insert({
        jobId: job.id,
        startedAt,
        finishedAt: now(),
        decision: 'done',
        detail: 'No targets remaining',
        journalPath: null,
      })
      return
    }

    // 2. Select representative (min episode number for series, the movie itself for movies)
    const representative = targets[0]
    const representativeId = representative.id

    // 3. Track coverage via onCovered callback
    const coveredIds = new Set<string>()
    const onCovered = (episodeId: string, subtitlePath: string) => {
      // Mark covered in library
      lib.markCovered(episodeId, subtitlePath, 'scout-download')
      // Track if it's in our target list
      if (targets.some(t => t.id === episodeId)) {
        coveredIds.add(episodeId)
      }
    }

    // 4. Run pipeline for representative
    const result = await runEpisode(representativeId, onCovered)
    const { decision, journalPath, detail } = result

    // 5. Route based on decision and coverage
    const finishedAt = now()
    const targetIds = new Set(targets.map(t => t.id))
    const coverageCount = coveredIds.size

    // Check if all targets are now covered (may have been covered by season pack or manual)
    const remainingMissing = job.kind === 'series_season'
      ? lib.db
          .prepare(
            `SELECT COUNT(*) as count FROM episodes
             WHERE series_id = ? AND season = ?
             AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))`
          )
          .get(job.series_id, job.season, now()) as { count: number }
      : lib.getMovie(job.movie_id!)?.sub_status === 'missing'
        ? { count: 1 }
        : { count: 0 }

    if (remainingMissing.count === 0) {
      // All covered
      jobs.completeDone(job.id, now())
      runs.insert({
        jobId: job.id,
        startedAt,
        finishedAt,
        decision,
        detail: detail ?? `All targets covered (${coverageCount} via callback)`,
        journalPath: journalPath ?? null,
      })
      return
    }

    // Partial coverage case
    if (coverageCount >= 1) {
      jobs.completePartial(job.id, now())
      runs.insert({
        jobId: job.id,
        startedAt,
        finishedAt,
        decision: 'partial',
        detail: detail ?? `Partial coverage: ${coverageCount} of ${targets.length} targets`,
        journalPath: journalPath ?? null,
      })
      return
    }

    // 0 coverage: check if representative was covered without season pack callback
    if (
      decision === 'download' ||
      decision === 'already_exists' ||
      decision === 'adopted_local'
    ) {
      // Representative episode was handled, mark it
      const subtitlePath = detail ?? `/sidecar/${representativeId}.zh-Hans.srt`
      lib.markCovered(representativeId, subtitlePath, 'scout-download')

      // Re-check if all targets are now covered
      const nowCovered = job.kind === 'series_season'
        ? lib.db
            .prepare(
              `SELECT COUNT(*) as count FROM episodes
               WHERE series_id = ? AND season = ?
               AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))`
            )
            .get(job.series_id, job.season, now()) as { count: number }
        : lib.getMovie(job.movie_id!)?.sub_status === 'missing'
          ? { count: 1 }
          : { count: 0 }

      if (nowCovered.count === 0) {
        jobs.completeDone(job.id, now())
        runs.insert({
          jobId: job.id,
          startedAt,
          finishedAt,
          decision,
          detail: detail ?? 'Representative covered, all done',
          journalPath: journalPath ?? null,
        })
      } else {
        // Still have remaining targets
        jobs.completePartial(job.id, now())
        runs.insert({
          jobId: job.id,
          startedAt,
          finishedAt,
          decision: 'partial',
          detail: detail ?? 'Representative covered, targets remaining',
          journalPath: journalPath ?? null,
        })
      }
      return
    }

    // 0 coverage with no_safe_match or ask_user: mark all targets as unavailable
    if (decision === 'no_safe_match' || decision === 'ask_user') {
      const reason =
        decision === 'no_safe_match'
          ? 'No safe match found in search results'
          : 'Manual review required'

      const succeeded = jobs.completeNoMatch(job.id, now())
      const finalJob = jobs.get(job.id)

      // If job became dormant or is in failed state, mark targets as unavailable
      if (succeeded && finalJob) {
        const recheckAfter =
          finalJob.state === 'dormant'
            ? now() + 30 * 86_400_000 // 30 days if dormant
            : finalJob.next_retry_at ?? now() + 86_400_000 // Use job's next_retry_at or default 1 day

        for (const target of targets) {
          lib.markUnavailable(target.id, reason, recheckAfter)
        }
      }

      runs.insert({
        jobId: job.id,
        startedAt,
        finishedAt,
        decision,
        detail: detail ?? reason,
        journalPath: journalPath ?? null,
      })
      return
    }

    // Other decisions (retry_later, error, etc.): treat as no match
    jobs.completeNoMatch(job.id, now())
    runs.insert({
      jobId: job.id,
      startedAt,
      finishedAt,
      decision,
      detail: detail ?? `No coverage: ${decision}`,
      journalPath: journalPath ?? null,
    })
  } catch (error) {
    // Exception handling: completeError with short backoff
    const errorMsg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, errorMsg, now())
    runs.insert({
      jobId: job.id,
      startedAt,
      finishedAt: now(),
      decision: 'error',
      detail: `Error: ${errorMsg}`,
      journalPath: null,
    })
  }
}

/**
 * Layer 2: 真实 runEpisode 接线——组 ctx、检查可写、调 pipeline、映射结果
 */
export function makeRunEpisode(
  assembled: Assembled,
  lib: LibraryRepo
): ExecutorDeps['runEpisode'] {
  const { jf, mappings, makeDeps, withJournal, cacheRoot } = assembled

  return async (episodeId, onCovered) => {
    // 1. Get item from Jellyfin
    const item = await jf.getItem(episodeId)

    // 2. Get chinese title
    const chineseTitle = await jf.getChineseTitle(item).catch(() => null)

    // 3. Build MediaContext
    const ctx = buildMediaContext(item, mappings, { chineseTitle })

    // 4. Check mediaDir is writable (throw if not → executeJob will call completeError)
    const dir = mediaDir(ctx)
    if (!isDirWritable(dir)) {
      throw new Error(
        `Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`
      )
    }

    // 5. Build onCovered adapter: pipeline's (ep: SeasonEpisode, path) → deps callback's (ep.itemId, path)
    const onCoveredAdapter = (ep: SeasonEpisode, path: string) => {
      onCovered(ep.itemId, path)
    }

    // 6. Call runPipeline with makeDeps including onCovered adapter
    const journalDir = join(cacheRoot, 'journals', `${episodeId}-${Date.now()}`)
    const result = await withJournal(() =>
      runPipeline(
        makeDeps({ itemId: episodeId, onCovered: onCoveredAdapter }),
        ctx,
        dir,
        journalDir
      )
    )

    // 7. Map PipelineResult to { decision, journalPath, detail }
    return {
      decision: result.decision,
      journalPath: result.journalPath,
      detail: result.subtitlePath ?? undefined,
    }
  }
}
