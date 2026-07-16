import { dirname, basename } from 'node:path'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RunsRepo } from './runsRepo.js'
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'
import { isDirWritable, isUnderRoots } from '../core/mediaContext.js'
import { candidateKey } from '../core/schemas.js'
import type { FindSubtitleTask, FindSubtitleDecision } from '../agent/findSubtitleWorker.schemas.js'
import { resolveAbsoluteTable, absoluteFor } from '../agent/absoluteEpisodes.js'
import { tmdbIdFromOwnId } from './ownIds.js'

/** runs.detail is a human-readable summary the dashboard shows directly (src/v2/runsRepo.ts) —
 *  trim/cap so a raw agent reason or thrown error message (which can run long) doesn't blow out
 *  the timeline UI. */
function capDetail(s: string, max = 200): string {
  const trimmed = s.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

// R-11（用户裁决 2026-07-16）：seasons 承载主代理裁量后的派活范围——数组=季子集，null=全剧
// （有缺口的季全部覆盖），可选键缺席=存量行（v11 迁移前写入，season 身份列有值）按旧语义单季
// 推导。三态而非二态：`undefined`（键缺席）与显式 `null` 携带不同语义，故字段类型必须允许两者
// 都出现，不能用 `?: number[] | null` 简化成默认值——mapper 靠 `'seasons' in payload` 之外的
// JSON.parse 后 `payload.seasons !== undefined` 检测来区分（见下方 mapWorkerTaskToFindSubtitleTask）。
export interface FindSubtitleWorkerTaskPayload {
  taskType: 'find_subtitle'
  reason: string
  seasons?: number[] | null
}

/** Deps needed to turn a claimed `worker_task` row (payload.taskType==='find_subtitle') into a
 *  concrete FindSubtitleTask. 去 Jellyfin 化 P4: this used to round-trip through a live Jellyfin
 *  item (deps.jf.getItem) and buildMediaContext (core/mediaContext.ts) to assemble the task; both
 *  are gone. episodes.path/movies.path are ALREADY local filesystem paths (T3's ingest layer walks
 *  the filesystem directly — no Jellyfin path remapping was ever needed for these rows, so no
 *  mapPath() call here either), and every other field (title/original_title/year/chinese
 *  titles/overview/runtime/provider_ids) comes straight off the series/movie library row plus a
 *  live TmdbClient.getDetails/getChineseTitles enrichment call keyed by tmdbIdFromOwnId(row.id) —
 *  see src/v2/ownIds.ts for why that extraction is a pure, zero-I/O string parse now that the row's
 *  own id IS its TMDB identity.
 *
 *  2026-07-16 架构事故修复：这个 mapper 曾经藏着 representativeEpisodeId()——一条
 *  `ORDER BY episode ASC LIMIT 1` 的私有查询，把主代理本该整季派发的一批缺口机械降解成
 *  "只查一集"的单集指令，注释还抄自旧管线，是本次事故的直接病灶。representativeEpisodeId /
 *  representativeMovieId 已处决。mapper 现在是纯信使：零目标选择、零顺序决策——季级缺口
 *  事实清单由 LibraryRepo.listMissingEpisodesInSeason 产出（ORDER BY episode 只是清单排序，
 *  不是执行顺序指令），mapper 只负责把整批事实清单原样装进一个 FindSubtitleTask.targets
 *  数组，连同该批目标共同的展示元数据（title/originalTitle/alternativeTitles/overview/…）
 *  一次性上车；哪个目标先处理、跳过哪个、算不算完成，通通是 worker/orchestrator 的判断，
 *  不是这层的活。 */
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

/** OUTER (MEDIA_ROOTS) 沙盒边界检查 + 写权限探测，两连 throw——processed 前的既有防线，从
 *  movie/series 两个分支各自的重复代码里抽出的模块内私有 helper。错误文案逐字保留：两条
 *  message 是既有测试锁（sandbox/unwritable 两类调用方都靠这段文案定位问题）。 */
function assertDirSafe(dir: string, roots: string[]): void {
  if (!isUnderRoots(dir, roots)) {
    throw new Error(`拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`)
  }
  if (!isDirWritable(dir)) {
    throw new Error(`Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`)
  }
}

/** 全部目标目录的公共祖先（INNER 沙盒根推导）。目录相等视为 under（isUnderRoots 既有语义）——
 *  同季目标通常共享同一 Season 目录，一步命中；只有磁盘布局不规范（同季文件散落多个子目录）
 *  时才需要真的逐级上探。 */
function commonDir(dirs: string[]): string {
  let candidate = dirs[0]
  while (!dirs.every((d) => isUnderRoots(d, [candidate]))) {
    const parent = dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return candidate
}

/** Maps a claimed worker_task row to a batch FindSubtitleTask, or null if there is nothing left
 *  to do (every target in the season/movie was already covered by the time this row got claimed
 *  — idempotent no-op, caller completes the job done without ever invoking the worker). Throws on
 *  a genuinely bad/unsafe wiring (library row vanished between claim and mapping, a target's video
 *  dir outside the configured MEDIA_ROOTS, unwritable dir) — callers (runFindSubtitleWorkerTask
 *  below) must treat a throw here the same as a thrown worker invocation: completeError, never
 *  crash the daemon.
 *
 *  2026-07-16 事故修复：this function used to pick ONE representative episode/movie id
 *  (representativeEpisodeId, now deleted — see the file-header note above) and hand the worker a
 *  single-episode task. It now hands over every still-open target in one shot: itemId travels
 *  inside each FindSubtitleTargetFact (task.targets), not as a separate side-channel return value
 *  — the messenger doesn't get to carry a second, undisclosed envelope. */
export async function mapWorkerTaskToFindSubtitleTask(
  job: Job, deps: FindSubtitleTaskMapperDeps, now: number,
): Promise<FindSubtitleTask | null> {
  // ---- movie 分支：单目标批量任务（movies 没有"季"概念，天然只有一个目标） ----
  if (job.movie_id) {
    const movie = deps.lib.getMovie(job.movie_id)
    if (!movie) return null
    const stillMissing =
      movie.sub_status === 'missing' || (movie.sub_status === 'unavailable' && (movie.recheck_after ?? 0) <= now)
    if (!stillMissing) return null

    const dir = dirname(movie.path)
    assertDirSafe(dir, deps.mediaRoots)

    const tmdbId = tmdbIdFromOwnId(movie.id)
    const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'movie', tmdbId)
    const originalTitle = details?.originalTitle ?? null

    return {
      jobId: String(job.id),
      mediaRoot: dir,
      title: movie.name,
      originalTitle,
      year: movie.year ?? details?.year ?? null,
      alternativeTitles: buildAlternativeTitles(chineseTitles, movie.chinese_title, movie.name, originalTitle),
      overview: details?.overview ?? null,
      runtimeMinutes: details?.runtimeMinutes ?? null,
      providerIds: parseProviderIds(movie.provider_ids),
      // A4: the primary configured target language (see FindSubtitleTaskMapperDeps.targetLanguage);
      // multi-language per-item tasking is future work.
      targetLanguage: deps.targetLanguage ?? 'zh',
      targets: [{
        itemId: movie.id,
        videoPath: movie.path,
        videoFilename: basename(movie.path),
        season: null,
        episode: null,
        // Movies have neither season nor episode — absoluteEpisode is meaningless for this branch.
        absoluteEpisode: null,
      }],
    }
  }

  // ---- series 分支：LibraryRepo 产出的缺口事实清单整批上车，mapper 不做任何取舍 ----
  // R-11（用户裁决 2026-07-16，原文锚点：「到底按季还是按剧，是根据具体情况具体分析的」）：派活
  // 范围是主代理的判断，不是系统常量——payload.seasons 决定这批任务覆盖哪些季：数组=季子集，
  // null=全剧（有缺口的季全部覆盖），键缺席=存量行（v11 迁移前写入）按 job.season 单季推导
  // （原语义，向后兼容）。season 身份列对新 find_subtitle 行恒 NULL，故不再要求它非空。
  if (!job.series_id) {
    throw new Error(
      `worker_task job ${job.id} (find_subtitle) has neither movie_id nor series_id identity`,
    )
  }
  const payload = (() => {
    try {
      return JSON.parse(job.payload ?? '{}') as { seasons?: number[] | null }
    } catch {
      return {} as { seasons?: number[] | null }
    }
  })()
  const gaps = payload.seasons !== undefined
    ? deps.lib.listMissingEpisodesForSeries(job.series_id, payload.seasons, now)
    : deps.lib.listMissingEpisodesInSeason(job.series_id, job.season ?? -1, now)
  // idempotent no-op: 本行被 claim 时范围内已无缺口——含病态"season 列为 null 且 payload 无
  // seasons 字段"的存量行（listMissingEpisodesInSeason(seriesId, -1, now) 恒空，无害兜底）。
  if (gaps.length === 0) return null

  const series = deps.lib.getSeries(job.series_id)
  if (!series) throw new Error(`series row ${job.series_id} not found for job ${job.id}`)

  const dirs = gaps.map((g) => dirname(g.path))
  for (const dir of dirs) assertDirSafe(dir, deps.mediaRoots)
  const mediaRoot = commonDir(dirs)
  if (!isUnderRoots(mediaRoot, deps.mediaRoots)) {
    // 逐目标 assertDirSafe 已经过；这里再兜一层是防"目标分散在多个根各自都合规、但公共祖先
    // 越出了全部根"的边界情形（每个单独的 dir 检查无法拦住这种组合态）。
    throw new Error(`拒绝在媒体根目录之外写入: ${mediaRoot} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`)
  }

  // tmdbId comes from the SERIES row's own id (episodes never carry the series' tmdb id
  // separately — the own id space nests episode ids under their series' id, see ownIds.ts).
  const tmdbId = tmdbIdFromOwnId(series.id)
  const { details, chineseTitles } = await fetchTmdbEnrichment(deps.tmdb, 'tv', tmdbId)
  const originalTitle = details?.originalTitle ?? null
  // 取表一次，逐集折算（resolveAbsoluteTable + absoluteFor）——不再是旧 resolveAbsoluteEpisode
  // 逐集各打一次 TMDB 往返（2N 次请求）。取不到表（tmdb 未配置/请求失败）→ 全部 null：
  // absoluteEpisode 是定位 hint 缺席不是 blocker，见 findSubtitleWorker.schemas.ts 的字段注释。
  const absTable = deps.tmdb && tmdbId ? await resolveAbsoluteTable(deps.tmdb, tmdbId) : null

  return {
    jobId: String(job.id),
    mediaRoot,
    title: series.name,
    originalTitle,
    year: series.year ?? details?.year ?? null,
    alternativeTitles: buildAlternativeTitles(chineseTitles, series.chinese_title, series.name, originalTitle),
    overview: details?.overview ?? null,
    runtimeMinutes: details?.runtimeMinutes ?? null,
    providerIds: parseProviderIds(series.provider_ids),
    // A4: the primary configured target language (see FindSubtitleTaskMapperDeps.targetLanguage);
    // multi-language per-item tasking is future work.
    targetLanguage: deps.targetLanguage ?? 'zh',
    // List order is fact-list order (gaps 已按 episode ASC，见 listMissingEpisodesInSeason),
    // not an execution-order instruction — see FindSubtitleTargetFact's own doc comment.
    targets: gaps.map((g) => ({
      itemId: g.id,
      videoPath: g.path,
      videoFilename: basename(g.path),
      season: g.season,
      episode: g.episode,
      absoluteEpisode: absTable ? absoluteFor(absTable, g.season, g.episode) : null,
    })),
  }
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
