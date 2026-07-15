import { dirname } from 'node:path'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { PlayerServer } from '../adapters/players/types.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { tmdbTitles, resolveTmdbRef } from '../adapters/providers/tmdb.js'
import { buildMediaContext, isDirWritable, isUnderRoots, mapPath, type PathMapping } from '../core/mediaContext.js'
import { candidateKey } from '../core/schemas.js'
import type { FindSubtitleTask, FindSubtitleDecision } from '../agent/findSubtitleWorker.schemas.js'
import { resolveAbsoluteEpisode } from '../agent/absoluteEpisodes.js'

export interface FindSubtitleWorkerTaskPayload { taskType: 'find_subtitle'; reason: string }

/** Deps needed to turn a claimed `worker_task` row (payload.taskType==='find_subtitle') into a
 *  concrete FindSubtitleTask — mirrors makeRunEpisode's (src/v2/executor.ts) own Jellyfin-item →
 *  MediaContext assembly (root+writable pre-check, buildMediaContext) rather than re-deriving it,
 *  per the phase ⑦ plan note, but does NOT reuse runEpisode itself: that closure invokes the OLD
 *  callStructured pipeline end-to-end, which the find-subtitle worker (phase ③) replaces wholesale
 *  for this one task type. */
export interface FindSubtitleTaskMapperDeps {
  lib: LibraryRepo
  jf: Pick<PlayerServer, 'getItem' | 'getChineseTitle'>
  /** null when TMDB_API_KEY isn't configured — chineseTitles enrichment is a gain-path, same
   *  fallback semantics as makeRunEpisode/cmdRunItem's own `tmdb ? tmdbTitles(...) : undefined`. */
  tmdb: TmdbClient | null
  mappings: PathMapping[]
  /** CRIT#1 (mirrors makeRunEpisode's opts.mediaRoots / realignExecutor's deps.mediaRoots):
   *  configured MEDIA_ROOTS/MEDIA_PATH_MAPPINGS whitelist — the OUTER sandbox boundary an admin
   *  configures. Distinct from FindSubtitleTask.mediaRoot, the tighter INNER per-task sandbox
   *  (this episode/movie's own containing directory) makeFindSubtitleWorker enforces on the agent
   *  itself ("each worker gets ONLY its series' media dir", phase ⑦ instructions). */
  mediaRoots: string[]
}

/** Representative missing episode for a series+season identity — same query remainingTargets()
 *  (src/v2/executor.ts, private to that module) uses for the old pipeline's job.kind==='series_season'
 *  branch, just narrowed to LIMIT 1 / SELECT id since the caller only needs one id to act on. Not
 *  reusing remainingTargets() directly: that function is keyed off job.kind, and a worker_task row's
 *  kind is always 'worker_task' (never 'series_season') — reusing it would require constructing a
 *  fake Job with a lying kind field, which is worse than this small, independent query. */
function representativeEpisodeId(lib: LibraryRepo, seriesId: string, season: number, now: number): string | null {
  const row = lib.db
    .prepare(
      `SELECT id FROM episodes
       WHERE series_id = ? AND season = ?
       AND (sub_status = 'missing' OR (sub_status = 'unavailable' AND recheck_after <= ?))
       ORDER BY episode ASC LIMIT 1`
    )
    .get(seriesId, season, now) as { id: string } | undefined
  return row?.id ?? null
}

/** Movie identity mirrors remainingTargets()'s movie branch: still-missing check re-derived at
 *  claim time (idempotent — the dispatch that created this row may be stale by the time it's
 *  claimed, e.g. covered by a manual run in between). */
function representativeMovieId(lib: LibraryRepo, movieId: string, now: number): string | null {
  const movie = lib.getMovie(movieId)
  if (!movie) return null
  const stillMissing =
    movie.sub_status === 'missing' || (movie.sub_status === 'unavailable' && (movie.recheck_after ?? 0) <= now)
  return stillMissing ? movie.id : null
}

export interface MappedFindSubtitleTask {
  task: FindSubtitleTask
  /** Jellyfin item id to markCovered/markUnavailable once the worker decides — LibraryRepo's
   *  markCovered/markUnavailable try the episodes table then the movies table by this same id,
   *  so the caller doesn't need to know which table it lives in. */
  targetItemId: string
}

/** Maps a claimed worker_task row to a FindSubtitleTask, or null if there is nothing left to do
 *  (the target was already covered by the time this row got claimed — idempotent no-op, caller
 *  completes the job done without ever invoking the worker). Throws on a genuinely bad/unsafe
 *  wiring (missing Jellyfin Path, video dir outside the configured MEDIA_ROOTS, unwritable dir) —
 *  callers (runFindSubtitleWorkerTask below) must treat a throw here the same as a thrown worker
 *  invocation: completeError, never crash the daemon. */
export async function mapWorkerTaskToFindSubtitleTask(
  job: Job, deps: FindSubtitleTaskMapperDeps, now: number,
): Promise<MappedFindSubtitleTask | null> {
  let targetItemId: string | null
  if (job.movie_id) {
    targetItemId = representativeMovieId(deps.lib, job.movie_id, now)
  } else if (job.series_id && job.season !== null) {
    targetItemId = representativeEpisodeId(deps.lib, job.series_id, job.season, now)
  } else {
    throw new Error(
      `worker_task job ${job.id} (find_subtitle) has neither movie_id nor series_id+season identity`,
    )
  }
  if (!targetItemId) return null

  const item = await deps.jf.getItem(targetItemId)
  if (!item.Path) throw new Error(`jellyfin item ${item.Id} has no Path`)
  const dir = dirname(mapPath(item.Path, deps.mappings))
  if (!isUnderRoots(dir, deps.mediaRoots)) {
    throw new Error(`拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`)
  }
  if (!isDirWritable(dir)) {
    throw new Error(`Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
  }

  const chineseTitle = await deps.jf.getChineseTitle(item).catch(() => null)
  const chineseTitles = deps.tmdb
    ? await tmdbTitles(deps.tmdb, item, id => deps.jf.getItem(id)).catch(() => undefined)
    : undefined
  const ctx = buildMediaContext(item, deps.mappings, { chineseTitle, chineseTitles })

  // absoluteEpisode needs the SERIES' tmdb id, not the episode's own ProviderIds — an episode's
  // ProviderIds never carries the series' Tmdb id (see resolveTmdbRefStrict's own comment above),
  // so this round-trips through deps.jf.getItem(item.SeriesId) exactly like tmdbTitles/resolveTmdbRef
  // above (a second, independent lookup — tmdbTitles doesn't expose the ref it resolved internally).
  const tmdbRef = deps.tmdb ? await resolveTmdbRef(item, id => deps.jf.getItem(id)) : null
  const absoluteEpisode = deps.tmdb && tmdbRef
    ? await resolveAbsoluteEpisode(ctx.media.season ?? null, ctx.media.episode ?? null, deps.tmdb, tmdbRef.tmdbId)
    : null

  const task: FindSubtitleTask = {
    jobId: String(job.id),
    mediaRoot: dir,
    videoPath: ctx.media.path,
    videoFilename: ctx.media.filename,
    title: ctx.media.title,
    originalTitle: ctx.media.original_title ?? null,
    year: ctx.media.year ?? null,
    season: ctx.media.season ?? null,
    episode: ctx.media.episode ?? null,
    absoluteEpisode,
    alternativeTitles: ctx.media.alternative_titles,
    overview: ctx.media.overview ?? null,
    runtimeMinutes: ctx.media.runtime_minutes ?? null,
    providerIds: ctx.media.provider_ids,
    // Hard default for now — config wiring (per-library/per-job target language) is a later task.
    targetLanguage: 'zh',
  }
  return { task, targetItemId }
}

export interface FindSubtitleWorkerTaskDeps extends FindSubtitleTaskMapperDeps {
  /** The actual worker invocation — makeFindSubtitleWorker(...)'s returned runFindSubtitleTask in
   *  production; a plain vi.fn() in tests. Injected (not constructed in here) so this module's
   *  own tests never need a real LanguageModel/ToolLoopAgent — findSubtitleWorker.test.ts already
   *  covers the agent loop itself in full. */
  runTask: (task: FindSubtitleTask) => Promise<FindSubtitleDecision>
}

/** Claims-and-runs one worker_task row whose payload.taskType === 'find_subtitle' — the phase ③
 *  find-subtitle worker's counterpart to runRealignWorkerTask (phase ⑥, src/v2/realignWorkerTask.ts).
 *  Mirrors that file's shape: maps the row to a task, runs the worker, and completes the job's
 *  state transition itself (installed → completeDone + markCovered, retry_later → completeError,
 *  no_safe_match → completeNoMatch + markUnavailable) so the caller (cmdWatch's claim-dispatch
 *  switch, phase ⑦) is a thin routing switch, not business logic.
 *
 *  Worker-exhaustion (phase ③/⑤ review, phase ⑦ critical instruction): runTask() (or the mapper
 *  above) can THROW — a step-cap/timeout/abort never produces a structured retry_later, it throws
 *  out of agent.generate(). The entire body below is wrapped in one try/catch so a thrown worker
 *  fails this job via completeError + backoff instead of propagating up and crashing the daemon's
 *  claim loop. */
export async function runFindSubtitleWorkerTask(
  job: Job,
  deps: FindSubtitleWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeNoMatch' | 'completeError' | 'get'>,
  now: () => number,
): Promise<FindSubtitleDecision | null> {
  try {
    const mapped = await mapWorkerTaskToFindSubtitleTask(job, deps, now())
    if (!mapped) {
      // Idempotent no-op: target already covered by the time this row was claimed.
      jobs.completeDone(job.id, now())
      return null
    }
    const { task, targetItemId } = mapped
    const decision = await deps.runTask(task)

    if (decision.decision === 'installed') {
      const providerRef =
        decision.candidateProvider && decision.candidateProviderId
          ? candidateKey({ provider: decision.candidateProvider, providerId: decision.candidateProviderId })
          : undefined
      deps.lib.markCovered(
        targetItemId, decision.installedPath, 'scout-download', providerRef,
        decision.installedLanguage ?? 'zh-Hans',
      )
      jobs.completeDone(job.id, now())
    } else if (decision.decision === 'retry_later') {
      jobs.completeError(job.id, decision.reason, now())
    } else {
      // no_safe_match — same content-backoff bookkeeping as executor.ts's own no_safe_match branch.
      const transitioned = jobs.completeNoMatch(job.id, now())
      if (transitioned) {
        const finalJob = jobs.get(job.id)!
        const recheckAfter =
          finalJob.state === 'dormant' ? now() + 30 * 86_400_000 : finalJob.next_retry_at ?? now() + 86_400_000
        deps.lib.markUnavailable(targetItemId, decision.reason, recheckAfter)
      }
    }
    return decision
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    return null
  }
}
