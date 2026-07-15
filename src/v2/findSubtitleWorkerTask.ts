import { dirname, basename } from 'node:path'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RunsRepo } from './runsRepo.js'
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'
import { isDirWritable, isUnderRoots } from '../core/mediaContext.js'
import { candidateKey } from '../core/schemas.js'
import type { FindSubtitleTask, FindSubtitleDecision } from '../agent/findSubtitleWorker.schemas.js'
import { resolveAbsoluteEpisode } from '../agent/absoluteEpisodes.js'
import { tmdbIdFromOwnId } from './ownIds.js'

/** runs.detail is a human-readable summary the dashboard shows directly (src/v2/runsRepo.ts) —
 *  trim/cap so a raw agent reason or thrown error message (which can run long) doesn't blow out
 *  the timeline UI. */
function capDetail(s: string, max = 200): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export interface FindSubtitleWorkerTaskPayload { taskType: 'find_subtitle'; reason: string }

/** Deps needed to turn a claimed `worker_task` row (payload.taskType==='find_subtitle') into a
 *  concrete FindSubtitleTask. 去 Jellyfin 化 P4: this used to round-trip through a live Jellyfin
 *  item (deps.jf.getItem) and buildMediaContext (core/mediaContext.ts) to assemble the task; both
 *  are gone. episodes.path/movies.path are ALREADY local filesystem paths (T3's ingest layer walks
 *  the filesystem directly — no Jellyfin path remapping was ever needed for these rows, so no
 *  mapPath() call here either), and every other field (title/original_title/year/chinese
 *  titles/overview/runtime/provider_ids) comes straight off the series/movie library row plus a
 *  live TmdbClient.getDetails/getChineseTitles enrichment call keyed by tmdbIdFromOwnId(row.id) —
 *  see src/v2/ownIds.ts for why that extraction is a pure, zero-I/O string parse now that the row's
 *  own id IS its TMDB identity. */
export interface FindSubtitleTaskMapperDeps {
  lib: LibraryRepo
  /** null when TMDB_API_KEY isn't configured — getDetails/getChineseTitles enrichment is a
   *  gain-path: originalTitle/overview/runtimeMinutes/chinese alternative titles/absoluteEpisode
   *  all degrade to null/[] rather than failing the mapping. */
  tmdb: TmdbClient | null
  /** CRIT#1 (mirrors makeRunEpisode's opts.mediaRoots / realignExecutor's deps.mediaRoots):
   *  configured MEDIA_ROOTS/MEDIA_PATH_MAPPINGS whitelist — the OUTER sandbox boundary an admin
   *  configures. Distinct from FindSubtitleTask.mediaRoot, the tighter INNER per-task sandbox
   *  (this episode/movie's own containing directory) makeFindSubtitleWorker enforces on the agent
   *  itself ("each worker gets ONLY its series' media dir", phase ⑦ instructions). */
  mediaRoots: string[]
  /** A4 (spec-review fix #1): the PRIMARY configured target subtitle language — cli/index.ts
   *  wires `resolveTargetLanguages(process.env).targetLanguages[0]`. FindSubtitleTask.targetLanguage
   *  is single-valued, so a multi-language TARGET_LANGUAGES config tasks only its first entry;
   *  per-item multi-language tasking is future work (the per-item coverage model — one sub_status
   *  per item — can't express "covered for zh but missing for en" yet). Optional/defaulted to
   *  'zh' (the historical default) so existing tests/callers predating the config keep working. */
  targetLanguage?: string
}

/** Parses series/movies.provider_ids (JSON, written by T3's ingest layer as `{"tmdb":"<id>"}` —
 *  see src/v2/ingest.ts) into the plain lowercase-keyed record FindSubtitleTask.providerIds
 *  expects (same lowercase-key convention the old buildMediaContext used for Jellyfin ProviderIds).
 *  NULL column / malformed JSON / non-object → {} (this field is prompt-display enrichment only,
 *  never a control-flow input — see findSubtitleWorker.ts's own use of it). */
function parseProviderIds(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {}
  } catch {
    return {}
  }
}

/** Mirrors the old buildMediaContext's alternative_titles combination: TMDB's own official variants
 *  (getChineseTitles, an ordered list) first, the DB-cached single chinese_title appended last as a
 *  fallback source — de-duped and stripped of anything blank or equal to the primary title / TMDB
 *  original title (no point surfacing a "variant" that's actually the title already shown). */
function buildAlternativeTitles(
  tmdbChineseTitles: string[], cachedChineseTitle: string | null, title: string, originalTitle: string | null,
): string[] {
  return [...tmdbChineseTitles, cachedChineseTitle]
    .filter((t): t is string => !!t && t.trim().length > 0 && t !== title && t !== originalTitle)
    .filter((t, i, arr) => arr.indexOf(t) === i)
}

/** Concurrent, gain-path TMDB enrichment for one (mediaType, tmdbId) — both calls silently degrade
 *  (getDetails via .catch, getChineseTitles already swallows its own failures internally) so a TMDB
 *  outage or a non-conforming id (tmdbId null) never fails the mapping, only impoverishes the task. */
async function fetchTmdbEnrichment(
  tmdb: TmdbClient | null, mediaType: 'tv' | 'movie', tmdbId: string | null,
): Promise<{ details: TmdbDetails | null; chineseTitles: string[] }> {
  if (!tmdb || !tmdbId) return { details: null, chineseTitles: [] }
  const [details, chineseTitles] = await Promise.all([
    tmdb.getDetails(mediaType, tmdbId).catch(() => null),
    tmdb.getChineseTitles(mediaType, tmdbId).catch(() => []),
  ])
  return { details, chineseTitles }
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
  /** Own library id (episodes.id or movies.id, 去 Jellyfin 化 P2's `tmdb:<id>[/s<N>e<M>]` id
   *  space) to markCovered/markUnavailable once the worker decides — LibraryRepo's
   *  markCovered/markUnavailable try the episodes table then the movies table by this same id,
   *  so the caller doesn't need to know which table it lives in. */
  targetItemId: string
}

/** Maps a claimed worker_task row to a FindSubtitleTask, or null if there is nothing left to do
 *  (the target was already covered by the time this row got claimed — idempotent no-op, caller
 *  completes the job done without ever invoking the worker). Throws on a genuinely bad/unsafe
 *  wiring (library row vanished between claim and mapping, video dir outside the configured
 *  MEDIA_ROOTS, unwritable dir) — callers (runFindSubtitleWorkerTask below) must treat a throw
 *  here the same as a thrown worker invocation: completeError, never crash the daemon. */
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

  if (job.movie_id) {
    const movie = deps.lib.getMovie(targetItemId)
    if (!movie) throw new Error(`movie row ${targetItemId} vanished between claim and mapping`)
    const dir = dirname(movie.path)
    if (!isUnderRoots(dir, deps.mediaRoots)) {
      throw new Error(`拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`)
    }
    if (!isDirWritable(dir)) {
      throw new Error(`Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
    }

    const tmdbId = tmdbIdFromOwnId(movie.id)
    const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'movie', tmdbId)
    const originalTitle = details?.originalTitle ?? null
    const alternativeTitles = buildAlternativeTitles(chineseTitles, movie.chinese_title, movie.name, originalTitle)

    const task: FindSubtitleTask = {
      jobId: String(job.id),
      mediaRoot: dir,
      videoPath: movie.path,
      videoFilename: basename(movie.path),
      title: movie.name,
      originalTitle,
      year: movie.year ?? details?.year ?? null,
      season: null,
      episode: null,
      // Movies have neither season nor episode — absoluteEpisode is meaningless for this branch.
      absoluteEpisode: null,
      alternativeTitles,
      overview: details?.overview ?? null,
      runtimeMinutes: details?.runtimeMinutes ?? null,
      providerIds: parseProviderIds(movie.provider_ids),
      // A4: the primary configured target language (see FindSubtitleTaskMapperDeps.targetLanguage);
      // multi-language per-item tasking is future work.
      targetLanguage: deps.targetLanguage ?? 'zh',
    }
    return { task, targetItemId }
  }

  const episode = deps.lib.getEpisode(targetItemId)
  if (!episode) throw new Error(`episode row ${targetItemId} vanished between claim and mapping`)
  const series = deps.lib.getSeries(episode.series_id)
  if (!series) throw new Error(`series row ${episode.series_id} not found for episode ${episode.id}`)

  const dir = dirname(episode.path)
  if (!isUnderRoots(dir, deps.mediaRoots)) {
    throw new Error(`拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`)
  }
  if (!isDirWritable(dir)) {
    throw new Error(`Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
  }

  // tmdbId comes from the SERIES row's own id (episodes never carry the series' tmdb id
  // separately — the own id space nests episode ids under their series' id, see ownIds.ts).
  const tmdbId = tmdbIdFromOwnId(series.id)
  const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'tv', tmdbId)
  const originalTitle = details?.originalTitle ?? null
  const alternativeTitles = buildAlternativeTitles(chineseTitles, series.chinese_title, series.name, originalTitle)
  const absoluteEpisode = deps.tmdb && tmdbId
    ? await resolveAbsoluteEpisode(episode.season, episode.episode, deps.tmdb, tmdbId)
    : null

  const task: FindSubtitleTask = {
    jobId: String(job.id),
    mediaRoot: dir,
    videoPath: episode.path,
    videoFilename: basename(episode.path),
    title: series.name,
    originalTitle,
    year: series.year ?? details?.year ?? null,
    season: episode.season,
    episode: episode.episode,
    absoluteEpisode,
    alternativeTitles,
    overview: details?.overview ?? null,
    runtimeMinutes: details?.runtimeMinutes ?? null,
    providerIds: parseProviderIds(series.provider_ids),
    // A4: the primary configured target language (see FindSubtitleTaskMapperDeps.targetLanguage);
    // multi-language per-item tasking is future work.
    targetLanguage: deps.targetLanguage ?? 'zh',
  }
  return { task, targetItemId }
}

export interface FindSubtitleWorkerTaskDeps extends FindSubtitleTaskMapperDeps {
  /** The actual worker invocation — makeFindSubtitleWorker(...)'s returned runFindSubtitleTask in
   *  production; a plain vi.fn() in tests. Injected (not constructed in here) so this module's
   *  own tests never need a real LanguageModel/ToolLoopAgent — findSubtitleWorker.test.ts already
   *  covers the agent loop itself in full. */
  runTask: (task: FindSubtitleTask) => Promise<FindSubtitleDecision>
  /** 退役T1 (W0-3a): optional so existing callers/tests keep compiling without threading it —
   *  when absent, runFindSubtitleWorkerTask silently skips writing a runs row (no throw). cmdWatch
   *  (src/cli/index.ts) wires the real RunsRepo it already constructs for the old pipeline; the
   *  v3 worker_task runners currently write NOTHING to `runs`, so the dashboard's run-history
   *  timeline (which reads that table) goes dark once the old pipeline is retired without this. */
  runs?: Pick<RunsRepo, 'insert'>
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
  const startedAt = now()
  // 退役T1 (W0-3a): one runs row per terminal outcome, mirroring executor.ts's own record()
  // shape (decision + human-readable detail, journalPath null — this runner has no journal).
  const recordRun = (decision: string, detail: string): void => {
    deps.runs?.insert({ jobId: job.id, startedAt, finishedAt: now(), decision, detail: capDetail(detail), journalPath: null })
  }
  try {
    const mapped = await mapWorkerTaskToFindSubtitleTask(job, deps, now())
    if (!mapped) {
      // Idempotent no-op: target already covered by the time this row was claimed. No worker
      // decision exists here, so (per the campaign design doc's own done/no_safe_match/retry_later/
      // error enumeration) this isn't one of the four runs-worthy terminal outcomes — nothing was
      // actually produced.
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
      // A2: fall back to the task's own target language, not a hardcoded 'zh-Hans' — the worker
      // should always set installedLanguage on an 'installed' decision, this is only a defensive
      // last resort, and a Chinese-only default would misrecord a non-Chinese task's language.
      deps.lib.markCovered(
        targetItemId, decision.installedPath, 'scout-download', providerRef,
        decision.installedLanguage ?? task.targetLanguage,
      )
      jobs.completeDone(job.id, now())
      recordRun('installed', decision.reason)
    } else if (decision.decision === 'retry_later') {
      jobs.completeError(job.id, decision.reason, now())
      recordRun('retry_later', decision.reason)
    } else {
      // no_safe_match — same content-backoff bookkeeping as executor.ts's own no_safe_match branch.
      const transitioned = jobs.completeNoMatch(job.id, now())
      if (transitioned) {
        const finalJob = jobs.get(job.id)!
        const recheckAfter =
          finalJob.state === 'dormant' ? now() + 30 * 86_400_000 : finalJob.next_retry_at ?? now() + 86_400_000
        deps.lib.markUnavailable(targetItemId, decision.reason, recheckAfter)
      }
      recordRun('no_safe_match', decision.reason)
    }
    return decision
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
    return null
  }
}
