// TODO(二期): I5c verify（下载后 Jellyfin 可见性复验）在二期 verifying 阶段实现，
// 见 docs/superpowers/plans/2026-07-09-v2-core.md Task 11 销项清单。
import type { LibraryRepo, Episode, Movie } from './libraryRepo.js'
import { ERROR_GIVEUP_THRESHOLD, type JobsRepo, type Job } from './jobsRepo.js'
import { RunsRepo } from './runsRepo.js'
import type { Assembled } from '../cli/index.js'
import {
  buildMediaContext, isDirWritable, isUnderRoots, mapPath,
} from '../core/mediaContext.js'
import { tmdbTitles } from '../adapters/providers/tmdb.js'
import { runPipeline } from '../core/pipeline.js'
import { candidateKey } from '../core/schemas.js'
import type { SeasonEpisode } from '../core/episode.js'
import { join, dirname } from 'node:path'

export interface ExecutorDeps {
  lib: LibraryRepo
  jobs: JobsRepo
  /** 跑一个代表集的完整判断链；onCovered 在每个被季包/单集命中的集写盘成功后回调。
   *  FIX-4a: journalRef——executeJob 在调用前已把它写进 jobs.journal_ref（供死进程
   *  倒查），makeRunEpisode 的真实实现据此复用同一个引用命名它实际落盘的 journal 目录，
   *  避免 jobs.journal_ref 和真实 journal 目录各算各的、对不上号。 */
  runEpisode: (
    episodeId: string,
    onCovered: (coveredEpisodeId: string, subtitlePath: string, providerRef?: string) => void,
    journalRef?: string
  ) => Promise<{
    decision: string
    journalPath?: string
    /** 写盘字幕路径（供 markCovered 建 subtitles 行）；不进 runs.detail */
    subtitlePath?: string
    /** ask_user 门评置信度（人话摘要展示） */
    confidence?: number | null
    /** 自动下载门槛（与 confidence 配对展示） */
    minConfidence?: number
    /** 结论理由（错因取首条，人话化后入 detail） */
    reasons?: string[]
    /** 命中的候选来源（供 markCovered 建 provider_ref）；无来源可考（如 already_exists）为 null/undefined */
    selected?: { provider: string; provider_id: string } | null
    /** pipeline stats（llmCalls/apiCalls）→ runs.llm_calls/assrt_calls；异常路径（如 throw）拿不到，record() 落 null */
    stats?: { llmCalls: number; apiCalls: number }
    /** 透传自 PipelineResult.quotaExhausted（OS 配额耗尽）：resetAt 有效时 jobsRepo.completeError
     *  据此精确退避，而不是走盲的 ERROR_BACKOFF_MS 短退避阶梯（否则会在配额重置前反复重打全链路）。 */
    quotaExhausted?: { resetAt: string | null } | null
  }>
  now: () => number
  log: (msg: string) => void
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本轮命中的字幕人话摘要（不含路径，审计细节留 journal）。 */
function coveredDetail(job: Job, coveredIds: Set<string>, lib: LibraryRepo): string {
  if (job.kind === 'movie') return '字幕已就位'
  const ids = [...coveredIds]
  if (ids.length === 1) {
    const ep = lib.getEpisode(ids[0])
    if (ep) return `S${pad2(ep.season)}E${pad2(ep.episode)} 字幕已就位`
  }
  const season = job.season ?? 0
  if (ids.length === 0) return `第 ${season} 季字幕已就位`
  return `第 ${season} 季 ${ids.length} 集字幕已就位`
}

/** 门评置信度不足的人话摘要（有数字用数字）。 */
function askUserDetail(confidence?: number | null, minConfidence?: number): string {
  if (typeof confidence === 'number' && typeof minConfidence === 'number') {
    return `找到候选但把握不足（置信 ${confidence.toFixed(2)} < ${minConfidence.toFixed(2)}），待人工确认`
  }
  return '找到候选但把握不足，待人工确认'
}

/** 错因清洗：取首行、剔除绝对路径 token（原文仍留 last_error/journal）。 */
function briefCause(raw?: string): string {
  if (!raw) return ''
  return raw.split('\n')[0].replace(/\/\S+/g, '').replace(/\s+/g, ' ').trim()
}

const HUMAN_NO_MATCH = '没找到合适的中文字幕'
const HUMAN_ASK_USER = '找到候选但把握不足，待人工确认'

/** M8: pipeline decision → subtitles.source 映射 */
const SOURCE_BY_DECISION: Record<string, string> = {
  download: 'scout-download',
  adopted_local: 'adopted-local',
  already_exists: 'preexisting',
}

/** 重derive 本 job 当前的 missing targets（含 unavailable/needs_review 复查到期），按集号升序。
 *  needs_review（task 2: ask_user 诚实记账）复查到期后和 unavailable 一样重新参战——
 *  一个更好的候选或更丰富的元数据到时候可能就能解出来，不该被永久搁置在"待确认"。 */
function remainingTargets(job: Job, lib: LibraryRepo, now: number): (Episode | Movie)[] {
  if (job.kind === 'series_season') {
    return lib.db
      .prepare(
        `SELECT * FROM episodes
         WHERE series_id = ? AND season = ?
         AND (sub_status = 'missing'
              OR (sub_status = 'unavailable' AND recheck_after <= ?)
              OR (sub_status = 'needs_review' AND recheck_after <= ?))
         ORDER BY episode ASC`
      )
      .all(job.series_id, job.season, now, now) as Episode[]
  }
  const movie = lib.getMovie(job.movie_id!)
  if (!movie) return []
  const stillMissing =
    movie.sub_status === 'missing' ||
    ((movie.sub_status === 'unavailable' || movie.sub_status === 'needs_review') && (movie.recheck_after ?? 0) <= now)
  return stillMissing ? [movie] : []
}

/**
 * 剧级执行器：重derive targets → 跑代表集 → 按结果分流 → 写 runs
 */
export async function executeJob(job: Job, deps: ExecutorDeps): Promise<void> {
  const { lib, jobs, runEpisode, now, log } = deps
  const startedAt = now()
  const runs = new RunsRepo(lib.db)

  /** FIX-3（side-effect lease guard 审计修正）：本次 invocation 是否仍拥有这个 job 的
   *  租约。job.lease_until 由 daemon 的心跳续租原地维护（FIX-2 daemon.ts 的
   *  inflightJobs Map），跟着合法续租一起前进，所以长跑的季包 job 不会被误判——只有
   *  这一行真的被 reap（lease_until→NULL）或被另一次 invocation 重新领走（lease_until
   *  换成新值）时，DB 里的当前值才会和这里冻结的 job.lease_until 分道扬镳。
   *  运行期副作用（onCovered 的 markCovered、代表集自身命中的 markCovered）在真正落盘
   *  之前都要过这一关——过去只有最终的 complete* 转移被 record() 的 stale-lease 守卫
   *  拦住，运行期写盘毫无阻拦地继续，白白写脏一个早已不属于自己的 job 的战果。 */
  const ownsLease = (): boolean => {
    const current = jobs.get(job.id)
    return current !== null && current.lease_until === job.lease_until
  }

  /** I4: complete* 守卫失败（stale lease 被 reap 重派）时可观测——warn 日志 + runs.detail 加后缀。
   *  FIX-4d（诊断准确性审计修正）：旧文案硬编码断言唯一因"租约已被回收重派"——生产实案
   *  出现过真实观测是 state=wanted、lease=NULL，却也被这行日志一律套上同一个诊断，
   *  掩盖了真实原因可能不是"被回收重派"（比如从未被正常 claim 过）。改为如实打印
   *  observe 到的 state/lease_until，让日志描述现场而不是替它下结论。 */
  const record = (
    transitioned: boolean,
    decision: string,
    detail: string,
    journalPath: string | null,
    stats: { llmCalls: number; apiCalls: number } | null = null
  ) => {
    let finalDetail = detail
    if (!transitioned) {
      const observed = jobs.get(job.id)
      const observedDesc = observed
        ? `state=${observed.state} lease_until=${observed.lease_until ?? 'null'}`
        : 'job 行已不存在'
      log(`warn: job ${job.id} 结果被弃置：complete* 守卫未命中（观测 ${observedDesc}）`)
      finalDetail = `${detail} (stale-lease 弃置)`
    }
    runs.insert({
      jobId: job.id,
      startedAt,
      finishedAt: now(),
      decision,
      detail: finalDetail,
      journalPath,
      llmCalls: stats?.llmCalls,
      assrtCalls: stats?.apiCalls,
    })
  }

  /** 1b: completeError 的瞬时错误给-up 界——error_attempt 跨过 ERROR_GIVEUP_THRESHOLD 时
   *  退避从 15min 封顶升级为每天一次（jobsRepo.errorBackoffMs 已经算好 next_retry_at；
   *  这里只负责把这次"跨界"一次性记进日志，供人工/告警观测，不在每次仍处升级态的后续
   *  调用里重复刷屏）。job.error_attempt 是本轮 completeError 之前的快照（claimNext 之后
   *  只有这一次终结调用会改它），据此和调用后的最新值比较即可判断"刚好跨过"。 */
  const completeErrorLogged = (
    error: string,
    quotaResetAt?: string | null
  ): boolean => {
    // IMPORTANT-1（审计修正）：completeError 有两个调用点——try 块内容轨的瞬时错误
    // 分支（已经过下面 5. 顶部的 ownsLease 大门）和 catch 块（runEpisode 抛异常，
    // 完全绕开那道门直接落到这里）。守在这个两条路径唯一共用的 helper 里，一次覆盖
    // 两处：租约已丢失就不再碰这一行，也不再充 error_attempt——由调用方的 record()
    // 走既有的 stale-lease 弃置分支收尾（诊断照旧打印，只是不再误伤新 invocation）。
    if (!ownsLease()) return false
    const before = job.error_attempt
    const transitioned = jobs.completeError(job.id, error, now(), quotaResetAt)
    if (transitioned && before <= ERROR_GIVEUP_THRESHOLD) {
      const after = jobs.get(job.id)!
      if (after.error_attempt > ERROR_GIVEUP_THRESHOLD) {
        log(
          `warn: job ${job.id} 瞬时错误连续 ${after.error_attempt} 次，退避升级为每天一次重试（仍保持 failed 可重试，不转 30 天休眠）`
        )
      }
    }
    return transitioned
  }

  try {
    // 1. Re-derive targets (missing episodes/movie for this job)
    const targets = remainingTargets(job, lib, now())
    if (targets.length === 0) {
      record(jobs.completeDone(job.id, now()), 'done', '字幕均已就位，无需处理', null)
      return
    }

    // 2. Select representative (min episode number for series, the movie itself for movies)
    const representative = targets[0]

    // 3. Track coverage via onCovered callback (season pack hits are downloads)
    const coveredIds = new Set<string>()
    const onCovered = (episodeId: string, subtitlePath: string, providerRef?: string) => {
      // FIX-3: 租约已不属于本次 invocation——跳过写盘，不信任 detached invocation
      // 的战果（管线本身继续跑，只是不让它的产出再落库；不尝试取消管线，见 out of scope）。
      if (!ownsLease()) {
        log(
          `warn: job ${job.id} 跳过 onCovered 写盘（episode=${episodeId}）：` +
          `租约已不属于本次 invocation（观测 lease_until=${jobs.get(job.id)?.lease_until ?? 'null'}，` +
          `本次 invocation 持有 ${job.lease_until ?? 'null'}）`
        )
        return
      }
      lib.markCovered(episodeId, subtitlePath, 'scout-download', providerRef)
      if (targets.some(t => t.id === episodeId)) {
        coveredIds.add(episodeId)
      }
    }

    // 4. Run pipeline for representative
    // FIX-4a: 在真正跑 runEpisode（有网络/LLM 调用、可能撞上 lost async continuation
    // 那类异常）之前，先把本次调用要用的 journal 引用落盘到 jobs.journal_ref——即便
    // 这次调用之后进程"断线"，也已经留下"是哪次运行、对应哪个目标集"的证据。
    const journalRef = `${representative.id}-${startedAt}`
    jobs.setJournalRef(job.id, journalRef, now())
    const result = await runEpisode(representative.id, onCovered, journalRef)
    const { decision } = result
    const subtitlePath = result.subtitlePath ?? null
    const journalPath = result.journalPath ?? null
    const stats = result.stats ?? null

    // IMPORTANT-1（审计修正——guard coverage hole）：runEpisode 是本函数唯一的 await
    // 点，期间足够长（FIX-1 之后孤儿回收窗口缩到 15s，比旧 30min 租约窗口容易撞得多）
    // 可能让本次 invocation 的 job 被 reapOrphaned 回收、又被一次新 invocation 重新
    // claim——DB 里当前那行 searching/downloading/verifying 早已不是"我们"的了。下面
    // 所有分流分支共用的 complete*（completeDone/completePartial/completeNoMatch，
    // 以及经 completeErrorLogged 的 completeError）只按 active-state 守卫，认不出
    // "是不是我领的"，会把新 invocation 的战果错误地转移到 failed/done（state/attempt/
    // error_attempt 全部覆盖，还会把新 invocation 自己的 lease_until 直接 NULL 掉，
    // 导致新 invocation 自己的 ownsLease 也跟着翻假，静默丢弃它后续所有战果——见
    // 审计 (c) 级联）；markUnavailable/markNeedsReview 更是完全没有守卫。在进入任何
    // 分支之前，一次性用 ownsLease() 拦掉整段路由——租约已丢失就什么状态机/集状态都
    // 不碰，只留一行 runs 记录（复用 record() 既有的 stale-lease 弃置分支，诊断信息
    // 不丢）。这是覆盖全部分支的最窄卡口：其后每条分支要么直接依赖 ownsLease()==true
    // 才能到达这里（onCovered/代表集 markCovered 的既有守卫因此永远命中 true 分支，
    // 不是死代码——只是不再是唯一防线），要么经 completeErrorLogged 二次确认。
    if (!ownsLease()) {
      record(false, decision, '本次 invocation 已失去租约，结果整体弃置', journalPath, stats)
      return
    }

    // 5. Route based on decision and coverage
    if (remainingTargets(job, lib, now()).length === 0) {
      // All targets covered (season pack callback or external)
      record(
        jobs.completeDone(job.id, now()),
        decision,
        coveredDetail(job, coveredIds, lib),
        journalPath,
        stats
      )
      return
    }

    if (coveredIds.size >= 1) {
      // Partial coverage: results already persisted in onCovered, job retries the remainder.
      // IMPORTANT-1a: quotaExhausted mid-sweep/pack → schedule the remainder at resetAt+margin,
      // not the blind 30s partial throttle (the provider is globally out until reset).
      record(
        jobs.completePartial(job.id, now(), result.quotaExhausted?.resetAt),
        'partial',
        coveredDetail(job, coveredIds, lib),
        journalPath,
        stats
      )
      return
    }

    // 0 coverage: representative itself succeeded without season pack callback
    if (decision === 'download' || decision === 'already_exists' || decision === 'adopted_local') {
      // 84fd17a: pipeline 的 already_exists 决策（预检短路 or 下载后 existsSync）现在总是
      // 携带真实磁盘路径，download/adopted_local 同样用 subtitlePath；没有路径（旧分支残留
      // 兜底）则只改状态，绝不伪造 subtitles 行。M8: source 按 decision 映射。
      // FIX-3: 同 onCovered，落盘前先过一遍租约归属——租约已失效则跳过这一笔直接写盘，
      // 让下面的 record() 走既有的 stale-lease 弃置分支收尾。
      if (ownsLease()) {
        const coverPath = subtitlePath
        const providerRef = result.selected
          ? candidateKey({ provider: result.selected.provider, providerId: result.selected.provider_id })
          : undefined
        lib.markCovered(representative.id, coverPath, SOURCE_BY_DECISION[decision], providerRef)
        coveredIds.add(representative.id) // 供人话摘要计数
      } else {
        log(
          `warn: job ${job.id} 跳过代表集 markCovered 写盘（episode=${representative.id}）：` +
          `租约已不属于本次 invocation（观测 lease_until=${jobs.get(job.id)?.lease_until ?? 'null'}，` +
          `本次 invocation 持有 ${job.lease_until ?? 'null'}）`
        )
      }

      if (remainingTargets(job, lib, now()).length === 0) {
        record(
          jobs.completeDone(job.id, now()),
          decision,
          coveredDetail(job, coveredIds, lib),
          journalPath,
          stats
        )
      } else {
        record(
          jobs.completePartial(job.id, now()),
          'partial',
          coveredDetail(job, coveredIds, lib),
          journalPath,
          stats
        )
      }
      return
    }

    // 0 coverage, content failure: no_safe_match / ask_user → content backoff track
    // task 2: 两者共享 job 状态机语义（同一条内容退避梯/dormancy 悬崖），但集级 sub_status
    // 诚实分流——no_safe_match 是"搜索穷尽确认无"（unavailable），ask_user 是"找到候选但
    // 置信不足，待人工确认"（needs_review）。此前两者都被 markUnavailable，前端一律展示
    // "暂无"，掩盖了本可人工确认的候选（审计 executor.ts:219 finding）。
    if (decision === 'no_safe_match' || decision === 'ask_user') {
      // 人话化：no_safe_match 的 status_reason/detail 用简洁版；ask_user 的 status_reason
      // 也用带数字的详细版（不只是 runs.detail）——未来"确认队列"功能要按集展示具体把握程度。
      const humanReason = decision === 'no_safe_match' ? HUMAN_NO_MATCH : HUMAN_ASK_USER
      const humanDetail =
        decision === 'no_safe_match'
          ? HUMAN_NO_MATCH
          : askUserDetail(result.confidence, result.minConfidence)

      const transitioned = jobs.completeNoMatch(job.id, now())

      // Mark targets unavailable/needs_review with recheck tied to the job's own retry schedule
      if (transitioned) {
        const finalJob = jobs.get(job.id)!
        const recheckAfter =
          finalJob.state === 'dormant'
            ? now() + 30 * 86_400_000 // 30 days if dormant
            : finalJob.next_retry_at ?? now() + 86_400_000

        for (const target of targets) {
          if (decision === 'ask_user') {
            lib.markNeedsReview(target.id, humanDetail, recheckAfter)
          } else {
            lib.markUnavailable(target.id, humanReason, recheckAfter)
          }
        }
      }

      record(transitioned, decision, humanDetail, journalPath, stats)
      return
    }

    // C1: 0 coverage, transient decisions (error / retry_later / unknown) → short-backoff error track.
    // 根因：pipeline 外层 catch 是 return finish('error') 而非 throw，瞬时错误若走内容轨
    // 会 5 次即 dormant 30 天。
    // quota_exhausted（OS 配额耗尽）+ resetAt 有效时，jobsRepo.completeError 按 resetAt 精确退避，
    // 而不是走这条轨盲的 ERROR_BACKOFF_MS 阶梯（否则会在配额重置前反复重打全链路白烧配额）。
    const cause = briefCause(result.reasons?.[0])
    record(
      completeErrorLogged(result.reasons?.[0] ?? `pipeline decision: ${decision}`, result.quotaExhausted?.resetAt),
      decision,
      cause ? `遇到临时错误，稍后自动重试：${cause}` : '遇到临时错误，稍后自动重试',
      journalPath,
      stats
    )
  } catch (error) {
    // Exception handling: completeError with short backoff
    const errorMsg = error instanceof Error ? error.message : String(error)
    const cause = briefCause(errorMsg)
    record(
      completeErrorLogged(errorMsg),
      'error',
      cause ? `遇到临时错误，稍后自动重试：${cause}` : '遇到临时错误，稍后自动重试',
      null
    )
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
  const { jf, mappings, makeDeps, withJournal, cacheRoot, tmdb } = assembled

  return async (episodeId, onCovered, journalRef) => {
    // 1. Get item from Jellyfin
    const item = await jf.getItem(episodeId)

    // 1b. I5b + executor.ts:315 审计修正：root 限定 + 本地可写预检提到 Jellyfin
    //     getChineseTitle / TMDB 调用之前——只读挂载/WebDAV 上每次注定失败的尝试
    //     不该先烧掉这两处网络配额才发现写不了。dir 只依赖 item.Path，不需要
    //     chineseTitle/tmdbTitles 那些 enrichment 字段，可以提前算好并复用。
    if (!item.Path) throw new Error(`jellyfin item ${item.Id} has no Path`)
    const dir = dirname(mapPath(item.Path, mappings))
    if (!isUnderRoots(dir, opts.mediaRoots)) {
      throw new Error(
        `拒绝在媒体根目录之外写入: ${dir} — 检查 MEDIA_ROOTS / MEDIA_PATH_MAPPINGS 配置`
      )
    }
    if (!isDirWritable(dir)) {
      throw new Error(
        `Media dir not writable: ${dir} — sidecar 无法写入，检查挂载读写权限（只读网盘/WebDAV?）`
      )
    }

    // 2. Get chinese title (jellyfin fallback) + optional TMDB variants
    const chineseTitle = await jf.getChineseTitle(item).catch(() => null)
    const chineseTitles = tmdb ? await tmdbTitles(tmdb, item, id => jf.getItem(id)).catch(() => undefined) : undefined

    // 2b. Write chinese title back to library (仅当解析到 CJK 名时；失败静默不阻塞主流程)
    if (chineseTitle) {
      try {
        if (item.Type === 'Episode' && item.SeriesId) {
          lib.setSeriesChineseTitle(item.SeriesId, chineseTitle, Date.now())
        } else if (item.Type === 'Movie') {
          lib.setMovieChineseTitle(item.Id, chineseTitle, Date.now())
        }
      } catch {
        /* 中文名回写失败不影响字幕主流程 */
      }
    }

    // 3. Build MediaContext (I5a)
    const ctx = buildMediaContext(item, mappings, { chineseTitle, chineseTitles })
    // ctx.media.path 与上面 1b 算出的 dir 是同一次 mapPath 计算，dir 已在网络调用前验过。

    // 5. onCovered adapter: pipeline (ep: SeasonEpisode, path, providerRef) → deps (ep.itemId, path, providerRef)
    //    I5d: refresh Jellyfin item after each covered episode (v1 semantics)
    const onCoveredAdapter = async (ep: SeasonEpisode, path: string, providerRef?: string) => {
      onCovered(ep.itemId, path, providerRef)
      await jf.refreshItem(ep.itemId).catch(() => {})
    }

    // 6. Call runPipeline. I5e: bypassNegativeCache — v2 状态机拥有全部重试策略，
    //    管线自己的负缓存不许再叠一层门（正缓存保留）。
    // FIX-4a: journalRef（若调用方传入，即 executeJob 落盘到 jobs.journal_ref 的同一个
    //    引用）复用来命名这次实际落盘的 journal 目录，避免 jobs.journal_ref 记的引用和
    //    磁盘上真实 journal 目录各算各的、事后对不上号。未传入（如旧调用方/直接单测
    //    这个 closure）时落回原先自算的兜底，行为不变。
    const journalDir = join(cacheRoot, 'journals', journalRef ?? `${episodeId}-${Date.now()}`)
    const result = await withJournal(() =>
      runPipeline(
        makeDeps({ itemId: episodeId, onCovered: onCoveredAdapter }),
        ctx,
        dir,
        journalDir,
        { bypassNegativeCache: true }
      )
    )

    // 7. Map PipelineResult to executor result shape（subtitlePath 供写盘，人话摘要在 executor 生成）
    return {
      decision: result.decision,
      journalPath: result.journalPath,
      subtitlePath: result.subtitlePath ?? undefined,
      confidence: result.confidence ?? null,
      minConfidence: ctx.preferences.auto_download_min_confidence,
      reasons: result.reasons ?? [],
      selected: result.selected ?? null,
      stats: { llmCalls: result.stats.llmCalls, apiCalls: result.stats.apiCalls },
      quotaExhausted: result.quotaExhausted,
    }
  }
}
