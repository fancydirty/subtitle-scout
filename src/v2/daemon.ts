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
}

/**
 * v2 daemon: 两条独立循环
 * 1. tick (15s): reap → (到点)scan+aggregate → dispatch
 * 2. pollSessions (15s): 命中缺字幕条目 → wake/boost
 */
export class ScoutDaemon {
  private inflight = new Set<Promise<void>>()
  private stopping = false

  constructor(private deps: DaemonDeps) {}

  /**
   * 一拍：reap → (到点)reconcile → dispatch
   */
  async tick(): Promise<void> {
    const { jobs, lib, scan, aggregate, executeJob, log, now, reconcileEveryMs } = this.deps

    // 1. Reap expired leases
    jobs.reapExpiredLeases(now())

    // 2. Check if it's time for reconcile (scan + aggregate)
    const lastReconcileRow = lib.db
      .prepare(`SELECT value FROM meta WHERE key = 'last_reconcile_at'`)
      .get() as { value: string } | undefined

    const lastReconcile = lastReconcileRow ? Number(lastReconcileRow.value) : 0
    const timeSinceReconcile = now() - lastReconcile

    if (timeSinceReconcile >= reconcileEveryMs) {
      // Time for reconcile
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
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        log(`reconcile error (scan or aggregate failed): ${msg}`)
        // Skip aggregate if scan failed, continue to dispatch
      }
    }

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

      // Fire-and-forget: don't await, but track in inflight set
      const jobPromise = executeJob(job)
        .catch((error) => {
          const msg = error instanceof Error ? error.message : String(error)
          log(`executeJob error for job ${job.id}: ${msg}`)
        })
        .finally(() => {
          this.inflight.delete(jobPromise)
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

        // unavailable 的条目：recheck_after 拉回 now，否则 wake 了 job
        // 但 executor 重derive targets 时 recheck 门会把这集挡在外面，白跑一轮。
        if (row.sub_status === 'unavailable') {
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
