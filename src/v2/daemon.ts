import type { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, Job } from './jobsRepo.js'
import type { RunsRepo } from './runsRepo.js'
import type { AggregateResult } from './aggregator.js'
import type { PlaybackSession, MediaItem } from '../adapters/players/types.js'

export interface DaemonDeps {
  lib: LibraryRepo
  jobs: JobsRepo
  runs: RunsRepo
  /** 闭包：扫描 Jellyfin library → 镜像入 episodes/movies */
  scan: () => Promise<void>
  /** 闭包：聚合 missing → jobs 表 */
  aggregate: (now: number) => AggregateResult
  /** 闭包：执行一个 job（fire-and-forget，daemon 不 await） */
  executeJob: (job: Job) => Promise<void>
  /** 闭包：获取当前播放会话（已有 30s 超时保护） */
  getSessions: () => Promise<PlaybackSession[]>
  /** 闭包：从 MediaItem 解析剧集/电影 identity */
  episodeForSession: (item: MediaItem) => {
    kind: 'series_season' | 'movie'
    seriesId?: string
    season?: number
    movieId?: string
  } | null
  log: (msg: string) => void
  now: () => number
  reconcileEveryMs: number   // 默认 15min
  fullScanEveryMs: number    // 默认 6h（一期全量扫描，meta.last_full_scan_at 暂不用）
  concurrency: {
    searching: number        // 默认 1
    downloading: number      // 默认 2（一期由 executor 内部串行，此处预留）
    verifying: number        // 默认 2（一期由 executor 内部串行，此处预留）
  }
  /** 进程退出钩子（测试注入用，默认 process.exit）。tick 连续意外失败达阈值时调用，
   *  nonzero 码交给外部编排（docker restart:unless-stopped 等）重启进程。 */
  exit?: (code: number) => void
}

/** tick() 连续意外抛错（reap/meta读/dispatch 里未被内层 try/catch 覆盖的异常，如磁盘满）
 *  达到这个次数后判定进程已不可自愈——调用 exit(1) fail-fast，而不是无声停摆着存活。 */
export const MAX_CONSECUTIVE_TICK_FAILURES = 5

/**
 * v2 daemon: 两条独立循环
 * 1. tick (15s): reap → (到点)scan+aggregate → dispatch
 * 2. pollSessions (15s): 命中缺字幕条目 → wake/boost
 */
export class ScoutDaemon {
  private inflight = new Set<Promise<void>>()
  // 心跳续租用：本进程当前仍在跑的 job id 集合。每 tick 先为它们续租，
  // reapExpiredLeases 才不会误判"合法长跑"为死亡租约、导致并发双派发（starvation 审计修正）。
  private inflightJobIds = new Set<number>()
  private stopping = false
  // 部署重启瞬间：上个进程分钟前才写过 last_reconcile_at，纯时间门会让首次 scan 延迟
  // 最长 15 分钟，而 dispatch 每 15s 无条件跑——旧 wanted/failed job（含刚被
  // reapAllActive 复活的）会在扫描器套用新分类规则之前被派发。强制开机第一拍
  // 先 reconcile 一次，不管 last_reconcile_at 多新，堵死这个窗口。
  private bootReconcilePending = true
  // tick() 连续意外失败计数——任何一次 tick 顺利跑完（tickInner 不抛）就清零；
  // 达 MAX_CONSECUTIVE_TICK_FAILURES 时 fail-fast 退出进程（daemon.ts:249 审计修正）。
  private consecutiveTickFailures = 0

  constructor(private deps: DaemonDeps) {}

  /**
   * 一拍：reap → (到点)reconcile → dispatch
   * 隔离层：tickInner 里任何未被内层 try/catch 吸收的意外抛错（如磁盘满命中
   * reapExpiredLeases/meta SELECT/dispatch 的 claimNext）都在这里兜住、记日志，
   * 不让 tickLoop 的 promise reject——否则 Promise.all(...).catch(() => {}) 会
   * 悄悄吞掉它，tick 永久停摆但进程存活不退出。连续失败达阈值则 fail-fast 退出，
   * 交给外部编排（docker restart:unless-stopped）拉活。
   */
  async tick(): Promise<void> {
    try {
      await this.tickInner()
      this.consecutiveTickFailures = 0
    } catch (error) {
      this.consecutiveTickFailures++
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.log(
        `tick error (unexpected, isolated): ${msg} [consecutive=${this.consecutiveTickFailures}]`
      )
      if (this.consecutiveTickFailures >= MAX_CONSECUTIVE_TICK_FAILURES) {
        this.deps.log(
          `tick failed ${this.consecutiveTickFailures} times consecutively — exiting for restart`
        )
        const exit = this.deps.exit ?? process.exit
        exit(1)
      }
    }
  }

  private async tickInner(): Promise<void> {
    const { jobs, lib, scan, aggregate, executeJob, log, now, reconcileEveryMs } = this.deps

    // 0. Heartbeat: 为本进程仍在跑的 job 续租，早于 reap 执行——防止合法长跑（如季包
    //    多集下载合法跑超 30min 租约）被误判死亡回收、被 dispatch 并发重领（starvation 审计修正）。
    for (const jobId of this.inflightJobIds) {
      jobs.renewLease(jobId, now())
    }

    // 1. Reap expired leases
    jobs.reapExpiredLeases(now())

    // 2. Check if it's time for reconcile (scan + aggregate)
    const lastReconcileRow = lib.db
      .prepare(`SELECT value FROM meta WHERE key = 'last_reconcile_at'`)
      .get() as { value: string } | undefined

    const lastReconcile = lastReconcileRow ? Number(lastReconcileRow.value) : 0
    const timeSinceReconcile = now() - lastReconcile

    if (this.bootReconcilePending || timeSinceReconcile >= reconcileEveryMs) {
      // Time for reconcile (or boot forces one regardless of the time gate)
      try {
        await scan()
        const result = aggregate(now())
        log(
          `reconcile: scan ok, aggregate created=${result.created} retired=${result.retired}`
        )

        // Update last_reconcile_at
        lib.db
          .prepare(
            `INSERT INTO meta (key, value) VALUES ('last_reconcile_at', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          )
          .run(String(now()))

        // Boot reconcile satisfied — only clear on success, so a failed boot
        // scan keeps retrying next tick instead of reopening the stale-gate window.
        this.bootReconcilePending = false
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log(`reconcile error (scan or aggregate failed): ${msg}`)
        // Skip aggregate if scan failed. 稳态（boot 已成功后）中途 scan 抖动不停摆
        // dispatch；boot 阶段则由下方守卫压制 dispatch。
      }
    }

    // Boot: 首轮 reconcile 成功之前绝不 dispatch——整栈重启时 Jellyfin 未就绪、
    // boot scan 连续抛错，若照常 dispatch，旧（未过新分类门的）job 会在每个 tick
    // 被派发，等价于没堵 stale-gate 窗口。
    if (this.bootReconcilePending) return

    // 3. Dispatch: claim jobs up to concurrency limit
    await this.dispatch()
  }

  /**
   * Dispatcher: claim wanted/failed jobs until searching concurrency limit reached
   */
  private async dispatch(): Promise<void> {
    const { jobs, executeJob, log, now, concurrency } = this.deps

    // Keep claiming while under concurrency limit
    while (true) {
      // Check current searching count
      const searchingCount = jobs.countByState('searching')
      if (searchingCount >= concurrency.searching) {
        break
      }

      // Try to claim next job
      const job = jobs.claimNext(now())
      if (!job) {
        // No more jobs to claim
        break
      }

      // Fire-and-forget: don't await, but track in inflight set (promise + job id;
      // job id feeds the heartbeat renewal above so this job's lease never expires
      // out from under it while genuinely still running in this process).
      this.inflightJobIds.add(job.id)
      const jobPromise = executeJob(job)
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error)
          log(`executeJob error for job ${job.id}: ${msg}`)
        })
        .finally(() => {
          this.inflight.delete(jobPromise)
          this.inflightJobIds.delete(job.id)
        })

      this.inflight.add(jobPromise)
    }
  }

  /**
   * 独立循环：轮询播放会话，命中缺字幕条目时 wake/boost
   */
  async pollSessions(): Promise<void> {
    const { getSessions, episodeForSession, jobs, lib, log, now } = this.deps

    try {
      const sessions = await getSessions()

      for (const session of sessions) {
        const item = session.NowPlayingItem
        if (!item) continue

        const ident = episodeForSession(item)
        if (!ident) continue

        // 播放触发判据：正在播放的**具体条目**只要在库且非 covered/embedded/ignored，
        // 就无条件 wake+boost——包括 unavailable 且 recheck_after 在未来的（dormant/退避中）。
        // recheck 门是给后台调和用的，对"用户正对着这集催"不适用。
        const row =
          ident.kind === 'movie' && ident.movieId
            ? lib.getMovie(ident.movieId)
            : lib.getEpisode(item.Id)

        if (!row) continue // 不在库镜像里（未扫到/非媒体项）
        if (
          row.sub_status === 'covered' ||
          row.sub_status === 'embedded' ||
          row.sub_status === 'ignored'
        ) {
          continue // 已有中文字幕或不需要——不值得再试
        }

        // unavailable/needs_review 的条目：recheck_after 拉回 now，否则 wake 了 job
        // 但 executor 重derive targets 时 recheck 门会把这集挡在外面，白跑一轮（零 target
        // 误判 done）。resetRecheck 本身两态都支持，这里的守卫必须跟着展宽，否则
        // needs_review 是死代码——见 libraryRepo.resetRecheck 的 WHERE 子句。
        if (row.sub_status === 'unavailable' || row.sub_status === 'needs_review') {
          lib.resetRecheck(row.id, now())
        }

        // Item lacks a Chinese subtitle and is currently playing
        // Try to wake (if dormant) and boost priority
        if (ident.kind === 'series_season' && ident.seriesId && ident.season !== undefined) {
          const woken = jobs.wake(
            { kind: 'series_season', seriesId: ident.seriesId, season: ident.season },
            100,
            now()
          )
          if (woken) {
            log(
              `session poll: woke dormant job for ${ident.seriesId} S${ident.season} (now playing)`
            )
          }

          // Also boost priority if it's already wanted/failed
          jobs.boostPriority(
            { kind: 'series_season', seriesId: ident.seriesId, season: ident.season },
            100
          )
        } else if (ident.kind === 'movie' && ident.movieId) {
          const woken = jobs.wake({ kind: 'movie', movieId: ident.movieId }, 100, now())
          if (woken) {
            log(`session poll: woke dormant job for movie ${ident.movieId} (now playing)`)
          }

          jobs.boostPriority({ kind: 'movie', movieId: ident.movieId }, 100)
        }
      }
    } catch (error) {
      // Sessions poll error should not crash the loop
      const msg = error instanceof Error ? error.message : String(error)
      this.deps.log(`session poll error (skipping this round): ${msg}`)
    }
  }

  /**
   * 主循环：两条独立 setTimeout 链，signal 中止时退出
   * 退出前等待 inflight 清空或 30s 超时
   */
  async run(signal: AbortSignal): Promise<void> {
    const TICK_INTERVAL_MS = 15_000
    const POLL_INTERVAL_MS = 15_000
    const SHUTDOWN_TIMEOUT_MS = 30_000

    // Handle abort signal
    if (signal.aborted) {
      this.stopping = true
      return
    }

    // Boot recovery: 单实例前提下，daemon 启动时旧进程必已死，所有活跃态租约都是遗孤，
    // 无条件回收（不等租约过期——生产实案：重启瞬间在跑的 job 租约僵尸占 searching 槽
    // 最长 30 分钟，调度停摆）。
    const reaped = this.deps.jobs.reapAllActive(this.deps.now())
    if (reaped > 0) {
      this.deps.log(`boot: reaped ${reaped} orphaned active lease(s) from previous process`)
    }

    signal.addEventListener(
      'abort',
      () => {
        this.stopping = true
      },
      { once: true }
    )

    // Two independent loops
    const tickLoop = async () => {
      while (!this.stopping) {
        await this.tick()
        if (this.stopping) break
        await sleep(TICK_INTERVAL_MS, signal)
      }
    }

    const pollLoop = async () => {
      while (!this.stopping) {
        await this.pollSessions()
        if (this.stopping) break
        await sleep(POLL_INTERVAL_MS, signal)
      }
    }

    // Start both loops
    Promise.all([tickLoop(), pollLoop()]).catch(() => {})

    // Wait for stop signal
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.stopping) {
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })

    // Stop claiming new jobs
    this.deps.log('daemon shutting down, waiting for inflight jobs...')

    // Wait for inflight to clear or timeout
    const shutdownStart = Date.now()
    while (this.inflight.size > 0) {
      if (Date.now() - shutdownStart > SHUTDOWN_TIMEOUT_MS) {
        this.deps.log(
          `shutdown timeout: ${this.inflight.size} jobs still running, forcing exit`
        )
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }

    this.deps.log(`daemon stopped (${this.inflight.size} jobs abandoned)`)
  }
}

/**
 * setTimeout 的可中止版：signal.abort() 时立即 resolve
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
