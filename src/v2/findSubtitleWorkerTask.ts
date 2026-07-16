import { dirname, basename } from 'node:path'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { LibraryRepo } from './libraryRepo.js'
import type { RunsRepo } from './runsRepo.js'
import type { TmdbClient, TmdbDetails } from '../adapters/providers/tmdb.js'
import { isDirWritable, isUnderRoots } from '../core/mediaContext.js'
import { candidateKey } from '../core/schemas.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'
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
// F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：includeThrottled 承载 orchestrator 的
// "这次要不要连未到期的停牌行也一起重查"判断（dispatch_find_subtitle_task 的同名参数写下来
// 的落点）——省略键=false（既有窗口语义锁，见 mapWorkerTaskToFindSubtitleTask 的解析）。
export interface FindSubtitleWorkerTaskPayload {
  taskType: 'find_subtitle'
  reason: string
  seasons?: number[] | null
  includeThrottled?: boolean
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
export async function fetchTmdbEnrichment(
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
  // F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：payload 现在提前到两个分支之前统一
  // 解析一次——movie 分支的 stillMissing 判断与 series 分支的 listMissingEpisodesForSeries 调用
  // 都要读 includeThrottled，此前只有 series 分支解析 payload（movie 分支从不看它）。省略键/
  // 非布尔值一律折叠为 false（既有窗口语义锁，不因新字段解析失败而意外放宽）。
  const payload = (() => {
    try {
      return JSON.parse(job.payload ?? '{}') as { seasons?: number[] | null; includeThrottled?: boolean }
    } catch {
      return {} as { seasons?: number[] | null; includeThrottled?: boolean }
    }
  })()
  const includeThrottled = payload.includeThrottled === true

  // ---- movie 分支：单目标批量任务（movies 没有"季"概念，天然只有一个目标） ----
  if (job.movie_id) {
    const movie = deps.lib.getMovie(job.movie_id)
    if (!movie) return null
    const stillMissing =
      movie.sub_status === 'missing' ||
      (movie.sub_status === 'unavailable' && (includeThrottled || (movie.recheck_after ?? 0) <= now))
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
  const gaps = payload.seasons !== undefined
    ? deps.lib.listMissingEpisodesForSeries(job.series_id, payload.seasons, now, includeThrottled)
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
   *  covers the agent loop itself in full.
   *  批量收割重写（2026-07-16，R-3）：一次调用返回三桶批量报告（installed/no_safe_match/
   *  retry_later），不再是旧的单一 FindSubtitleDecision——见 findSubtitleWorker.schemas.ts 的
   *  FindSubtitleBatchReportSchema。 */
  runTask: (task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>
  /** 退役T1 (W0-3a): optional so existing callers/tests keep compiling without threading it —
   *  when absent, runFindSubtitleWorkerTask silently skips writing a runs row (no throw). cmdWatch
   *  (src/cli/index.ts) wires the real RunsRepo it already constructs for the old pipeline; the
   *  v3 worker_task runners currently write NOTHING to `runs`, so the dashboard's run-history
   *  timeline (which reads that table) goes dark once the old pipeline is retired without this. */
  runs?: Pick<RunsRepo, 'insert'>
}

/** Claims-and-runs one worker_task row whose payload.taskType === 'find_subtitle' — the phase ③
 *  find-subtitle worker's counterpart to runRealignWorkerTask (phase ⑥, src/v2/realignWorkerTask.ts).
 *  Maps the row to a batch task, runs the worker once, and posts the resulting batch harvest
 *  report (installed/no_safe_match/retry_later) itself so the caller (cmdWatch's claim-dispatch
 *  switch, phase ⑦) is a thin routing switch, not business logic.
 *
 *  批量收割入账重写（2026-07-16，R-3 裁决——docs/design/2026-07-16-old-world-lineage-registry.md）：
 *  这个函数曾经按旧单决定契约把 mapper 的返回值解构成 `{ task, targetItemId }`（mapper 早在
 *  Task 4 就已经改造成纯信使、返回整批 FindSubtitleTask 本身，那次解构从那时起就在拿
 *  undefined），installed/no_safe_match 分支各自只认一个 itemId、且 no_safe_match 走的是已被
 *  处决的 jobs 侧 dormant 判决（completeNoMatch + 30 天封顶）。R-3 终局改写：
 *
 *  1. 事实先入账——installed 逐项 markCovered、no_safe_match 逐项 markUnavailable，不等队列判
 *     决落定；磁盘上字幕已经在了，队列怎么转都不改变这个事实。
 *  2. 内容退避彻底下沉到 item 事实层（LibraryRepo.markUnavailable 自己的阶梯，见该方法的注释）
 *     ——jobs 状态机从此不持有任何内容判决，completeNoMatch 因此零调用（不删，见该方法头注释）。
 *  3. 队列语义化简：报告落地即收官——installed/no_safe_match 都完成 completeDone；只有
 *     retry_later（瞬时故障的季剩余）走 completeError 的短退避节流轨（R-10 豁免：30s→15min→日，
 *     永不 dormant）。空报告（三桶皆空）视为一次失败的调用，也走 completeError。
 *
 *  Worker-exhaustion (phase ③/⑤ review, phase ⑦ critical instruction): runTask() (or the mapper
 *  above) can THROW — a step-cap/timeout/abort never produces a structured batch report, it throws
 *  out of agent.generate(). The entire body below is wrapped in one try/catch so a thrown worker
 *  fails this job via completeError + backoff instead of propagating up and crashing the daemon's
 *  claim loop. */
export async function runFindSubtitleWorkerTask(
  job: Job,
  deps: FindSubtitleWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError'>,
  now: () => number,
): Promise<FindSubtitleBatchReport | null> {
  const startedAt = now()
  // 退役T1 (W0-3a): one runs row per terminal outcome, mirroring executor.ts's own record()
  // shape (decision + human-readable detail, journalPath null — this runner has no journal).
  // executor.ts itself was deleted in the old-pipeline retirement; this comment only documents
  // where the shape was borrowed from.
  const recordRun = (decision: string, detail: string): void => {
    deps.runs?.insert({ jobId: job.id, startedAt, finishedAt: now(), decision, detail: capDetail(detail), journalPath: null })
  }
  try {
    const task = await mapWorkerTaskToFindSubtitleTask(job, deps, now())
    if (!task) {
      // Idempotent no-op: every target already covered by the time this row was claimed. No
      // worker report exists here, so this isn't one of the runs-worthy terminal outcomes —
      // nothing was actually produced.
      jobs.completeDone(job.id, now())
      return null
    }
    const report = await deps.runTask(task)

    // itemId 幻觉防线：清单外 id 一律丢弃告警——markCovered/markUnavailable 都是两表盲 UPDATE，
    // 幻觉 id 可能砸中任何行；宁可漏记一条真报告，不可错标一个非本任务目标（零误触发在入账层
    // 的镜像，同 T4/T4b 事实清单"呈事实不做选择"的既有纪律）。
    const validIds = new Set(task.targets.map((t) => t.itemId))
    const dropAlien = <T extends { itemId: string }>(bucket: T[], name: string): T[] =>
      bucket.filter((x) => {
        if (validIds.has(x.itemId)) return true
        console.error(`[find-subtitle-harvest] job ${job.id}: dropping alien itemId ${x.itemId} from ${name}`)
        return false
      })
    const installed = dropAlien(report.installed, 'installed')
    const noMatch = dropAlien(report.no_safe_match, 'no_safe_match')
    const retryLater = dropAlien(report.retry_later, 'retry_later')

    // 事实先入账（installed 永远先记——磁盘上字幕已经在了，队列怎么转都不改变这个事实）
    for (const item of installed) {
      const providerRef =
        item.candidateProvider && item.candidateProviderId
          ? candidateKey({ provider: item.candidateProvider, providerId: item.candidateProviderId })
          : undefined
      // A2: fall back to the task's own target language, not a hardcoded 'zh-Hans' — the worker
      // should always set installedLanguage on an installed item, this is only a defensive last
      // resort, and a Chinese-only default would misrecord a non-Chinese task's language.
      deps.lib.markCovered(
        item.itemId, item.installedPath, 'scout-download', providerRef,
        item.installedLanguage ?? task.targetLanguage,
      )
    }
    // R-3：no_safe_match 是 worker 的语义判决，落账为 item 事实；"何时再看"由 item 自己的
    // search_attempts 阶梯决定——jobs 状态机从此不持有任何内容判决。
    for (const item of noMatch) deps.lib.markUnavailable(item.itemId, item.reason, now())

    // 队列语义（R-3 终局）：报告落地即入账收官；仅 retry_later（瞬时故障的季剩余）走
    // completeError 节流轨（R-10 豁免：30s→15min→日，永不 dormant）。completeNoMatch 已死。
    if (installed.length === 0 && noMatch.length === 0 && retryLater.length === 0) {
      jobs.completeError(job.id, 'worker returned an empty batch report', now())
      recordRun('error', 'empty batch report')
    } else if (retryLater.length > 0) {
      jobs.completeError(
        job.id, `retry_later ${retryLater.length} item(s): ${capDetail(retryLater[0].reason)}`, now(),
      )
    } else {
      jobs.completeDone(job.id, now())
    }

    // runs：按非空桶各记一行，词表沿用（dashboard 时间线口径不破）
    if (installed.length) {
      recordRun('installed', `${installed.length} 集入账: ${installed.map((i) => i.itemId).join(', ')}`)
    }
    if (noMatch.length) {
      recordRun('no_safe_match', `${noMatch.length} 集判无: ${noMatch.map((i) => `${i.itemId}(${i.reason})`).join('; ')}`)
    }
    if (retryLater.length) {
      recordRun('retry_later', `${retryLater.length} 集待重试: ${retryLater.map((i) => i.itemId).join(', ')}`)
    }
    return report
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
    return null
  }
}
