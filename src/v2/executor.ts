// TODO(二期): I5c verify（下载后 Jellyfin 可见性复验）在二期 verifying 阶段实现，
// 见 docs/superpowers/plans/2026-07-09-v2-core.md Task 11 销项清单。
import type { LibraryRepo, Episode, Movie } from './libraryRepo.js'
import type { JobsRepo, Job } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import type { Assembled } from '../cli/index.js'
import {
  buildMediaContext, mediaDir, isDirWritable, isUnderRoots, applyConfidenceOverride,
} from '../core/mediaContext.js'
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
  log: (msg: string) => void
}

/** M8: pipeline decision → subtitles.source 映射 */
const SOURCE_BY_DECISION: Record<string, string> = {
  download: 'scout-download',
  adopted_local: 'adopted-local',
  already_exists: 'preexisting',
}

/** 重derive 本 job 当前的 missing targets（含 unavailable 复查到期），按集号升序。 */
function remainingTargets(job: Job, lib: LibraryRepo, now: number): (Episode | Movie)[] {
  if (job.kind === 'series_season') {
    return lib.db
      .prepare(
        `SELECT * FROM episodes
         WHERE series_id = ? AND season = ?
         AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))
         ORDER BY episode ASC`
      )
      .all(job.series_id, job.season, now) as Episode[]
  }
  const movie = lib.getMovie(job.movie_id!)
  if (!movie) return []
  const stillMissing =
    movie.sub_status === 'missing' ||
    (movie.sub_status === 'unavailable' && (movie.recheck_after ?? 0) <= now)
  return stillMissing ? [movie] : []
}

/**
 * 剧级执行器：重derive targets → 跑代表集 → 按结果分流 → 写 runs
 */
export async function executeJob(job: Job, deps: ExecutorDeps): Promise<void> {
  const { lib, jobs, runEpisode, now, log } = deps
  const startedAt = now()
  const runs = new RunsRepo(lib.db)

  /** I4: complete* 守卫失败（stale lease 被 reap 重派）时可观测——warn 日志 + runs.detail 加后缀。 */
  const record = (
    transitioned: boolean,
    decision: string,
    detail: string,
    journalPath: string | null
  ) => {
    let finalDetail = detail
    if (!transitioned) {
      log(`warn: job ${job.id} 结果被弃置：租约已被回收重派`)
      finalDetail = `${detail} (stale-lease 弃置)`
    }
    runs.insert({
      jobId: job.id,
      startedAt,
      finishedAt: now(),
      decision,
      detail: finalDetail,
      journalPath,
    })
  }

  try {
    // 1. Re-derive targets (missing episodes/movie for this job)
    const targets = remainingTargets(job, lib, now())
    if (targets.length === 0) {
      record(jobs.completeDone(job.id, now()), 'done', 'All targets already covered', null)
      return
    }

    // 2. Select representative (min episode number for series, the movie itself for movies)
    const representative = targets[0]

    // 3. Track coverage via onCovered callback (season pack hits are downloads)
    const coveredIds = new Set<string>()
    const onCovered = (episodeId: string, subtitlePath: string) => {
      lib.markCovered(episodeId, subtitlePath, 'scout-download')
      if (targets.some(t => t.id === episodeId)) {
        coveredIds.add(episodeId)
      }
    }

    // 4. Run pipeline for representative
    const result = await runEpisode(representative.id, onCovered)
    const { decision, detail } = result
    const journalPath = result.journalPath ?? null

    // 5. Route based on decision and coverage
    if (remainingTargets(job, lib, now()).length === 0) {
      // All targets covered (season pack callback or external)
      record(
        jobs.completeDone(job.id, now()),
        decision,
        detail ?? `All targets covered (${coveredIds.size} via callback)`,
        journalPath
      )
      return
    }

    if (coveredIds.size >= 1) {
      // Partial coverage: results already persisted in onCovered, job retries the remainder
      record(
        jobs.completePartial(job.id, now()),
        'partial',
        detail ?? `Partial coverage: ${coveredIds.size} of ${targets.length} targets`,
        journalPath
      )
      return
    }

    // 0 coverage: representative itself succeeded without season pack callback
    if (decision === 'download' || decision === 'already_exists' || decision === 'adopted_local') {
      // M7: already_exists 无可信文件路径传 null；download/adopted 用 detail 携带的 subtitlePath，
      // 没有则只改状态。M8: source 按 decision 映射。
      const subtitlePath = decision === 'already_exists' ? null : detail ?? null
      lib.markCovered(representative.id, subtitlePath, SOURCE_BY_DECISION[decision])

      if (remainingTargets(job, lib, now()).length === 0) {
        record(
          jobs.completeDone(job.id, now()),
          decision,
          detail ?? 'Representative covered, all done',
          journalPath
        )
      } else {
        record(
          jobs.completePartial(job.id, now()),
          'partial',
          detail ?? 'Representative covered, targets remaining',
          journalPath
        )
      }
      return
    }

    // 0 coverage, content failure: no_safe_match / ask_user → content backoff track
    if (decision === 'no_safe_match' || decision === 'ask_user') {
      const reason =
        decision === 'no_safe_match'
          ? 'No safe match found in search results'
          : 'Manual review required'

      const transitioned = jobs.completeNoMatch(job.id, now())

      // Mark targets unavailable with recheck tied to the job's own retry schedule
      if (transitioned) {
        const finalJob = jobs.get(job.id)!
        const recheckAfter =
          finalJob.state === 'dormant'
            ? now() + 30 * 86_400_000 // 30 days if dormant
            : finalJob.next_retry_at ?? now() + 86_400_000

        for (const target of targets) {
          lib.markUnavailable(target.id, reason, recheckAfter)
        }
      }

      record(transitioned, decision, detail ?? reason, journalPath)
      return
    }

    // C1: 0 coverage, transient decisions (error / retry_later / unknown) → short-backoff error track.
    // 根因：pipeline 外层 catch 是 return finish('error') 而非 throw，瞬时错误若走内容轨
    // 会 5 次即 dormant 30 天。
    record(
      jobs.completeError(job.id, detail ?? `pipeline decision: ${decision}`, now()),
      decision,
      detail ?? `Transient outcome: ${decision}`,
      journalPath
    )
  } catch (error) {
    // Exception handling: completeError with short backoff
    const errorMsg = error instanceof Error ? error.message : String(error)
    record(jobs.completeError(job.id, errorMsg, now()), 'error', `Error: ${errorMsg}`, null)
  }
}

/**
 * Layer 2: 真实 runEpisode 接线——组 ctx、根限定+可写预检、调 pipeline、映射结果。
 * 抛出的错误由 executeJob 捕获走 completeError 短退避（修复 v1 审计 B1 队头饿死）。
 */
export function makeRunEpisode(
  assembled: Assembled,
  lib: LibraryRepo,
  opts: { mediaRoots: string[] }
): ExecutorDeps['runEpisode'] {
  const { jf, mappings, makeDeps, withJournal, cacheRoot } = assembled

  return async (episodeId, onCovered) => {
    // 1. Get item from Jellyfin
    const item = await jf.getItem(episodeId)

    // 2. Get chinese title
    const chineseTitle = await jf.getChineseTitle(item).catch(() => null)

    // 3. Build MediaContext + confidence override (I5a)
    const ctx = buildMediaContext(item, mappings, { chineseTitle })
    applyConfidenceOverride(ctx)

    // 4a. I5b: root restriction — refuse writes outside media roots (security guard)
    const dir = mediaDir(ctx)
    if (!isUnderRoots(dir, opts.mediaRoots)) {
      throw new Error(
        `拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`
      )
    }

    // 4b. Check mediaDir is writable (throw → executeJob calls completeError)
    if (!isDirWritable(dir)) {
      throw new Error(
        `Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`
      )
    }

    // 5. onCovered adapter: pipeline (ep: SeasonEpisode, path) → deps (ep.itemId, path)
    //    I5d: refresh Jellyfin item after each covered episode (v1 semantics)
    const onCoveredAdapter = async (ep: SeasonEpisode, path: string) => {
      onCovered(ep.itemId, path)
      await jf.refreshItem(ep.itemId).catch(() => {})
    }

    // 6. Call runPipeline. I5e: bypassNegativeCache — v2 状态机拥有全部重试策略，
    //    管线自己的负缓存不许再叠一层门（正缓存保留）。
    const journalDir = join(cacheRoot, 'journals', `${episodeId}-${Date.now()}`)
    const result = await withJournal(() =>
      runPipeline(
        makeDeps({ itemId: episodeId, onCovered: onCoveredAdapter }),
        ctx,
        dir,
        journalDir,
        { bypassNegativeCache: true }
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
