import type { LibraryRepo } from './libraryRepo.js'
import type { JobsRepo, Job } from './jobsRepo.js'
import type { RunsRepo } from './runsRepo.js'
import { SELF_SCAN_DEFAULT_INTERVAL_MS } from '../daemon/selfScan.js'
import { INGEST_ORCHESTRATE_SERIES_ID, type IngestTriggerResult } from '../daemon/ingestTrigger.js'

/** 债务D2（胶水层修复战役）：orchestrate 低频兜底心跳间隔。无变化世界里 ingest 恒
 *  changed=0、永不触发 orchestrate——"识别晚到/pending 屏蔽"类惰性收敛洞永不愈合
 *  （R4：吞吐异象=架构信号）。24h 兜底一拍，见 tickInner 步骤 2b 的注释。 */
export const ORCHESTRATE_HEARTBEAT_MS = 24 * 3_600_000

export interface DaemonDeps {
  lib: LibraryRepo
  jobs: JobsRepo
  runs: RunsRepo
  /** 去 Jellyfin 化 T4：唯一的周期重活分支——src/daemon/ingestTrigger.ts 的 makeIngestTrigger(...)
   *  返回值，调用方（cli/index.ts cmdWatch）已经用 v2/ingest.ts 的 makeIngestPass 预绑定好
   *  recognize/probe/tmdb。取代了旧的机械 scan()（镜像 Jellyfin library）+ B2 self-scan
   *  refresh-bridge 两条分支——ingest 是"检测即摄取"的单步直写，不再需要分两条时间门。
   *  非 optional：cmdWatch 现在把 TMDB_API_KEY 做成硬性前置（watch 依赖 ingest 层的真实
   *  TmdbClient 才能识别文件），不再有"缺 key 时整个分支跳过"的降级世界。 */
  ingestTrigger: () => Promise<IngestTriggerResult>
  /** 闭包：执行一个 job（fire-and-forget，daemon 不 await） */
  executeJob: (job: Job) => Promise<void>
  log: (msg: string) => void
  now: () => number
  /** ingest 心跳的时间门间隔——number=构造时快照（测试注入沿用）；函数=每 tick 惰性求值
   *  （债务D5：settings.scan_interval_ms 改后下一 tick 即生效，不用重启守护进程）。默认
   *  SELF_SCAN_DEFAULT_INTERVAL_MS(15min)。 */
  ingestEveryMs?: number | (() => number)
  /** 债务D5：trace 快照保留天数（settings.trace_retention_days 惰性读），默认 30。 */
  traceRetentionDays?: () => number
  /** 债务D2：orchestrate 兜底心跳间隔（测试注入）。默认 ORCHESTRATE_HEARTBEAT_MS(24h)。 */
  orchestrateHeartbeatMs?: number
  /** E AI 翻译（2026-07-21）：机械派 translate worker_task 的钩子（translateWorkerTask.ts 的
   *  dispatchTranslateTasks 预绑定 db/jobs）。**env 门控在 cli 接线侧**：TRANSLATE_MODEL/LLM_MODEL
   *  未配 → cmdWatch 根本不注入本钩子（undefined），功能休眠零成本（同 SUBHD_ENABLED 模式）。
   *  候选=sub_status='unavailable' 且内嵌非中文轨——翻译是最后手段，天然候选极少。放在 tick 的
   *  dispatch 之前、boot ingest 门之后：与 orchestrate 心跳同一时机语义（判定纯机械无 LLM，
   *  幂等 upsert，每 tick 调也只在候选出现时建行）。 */
  dispatchTranslate?: () => void
  /** DB 审计🔴 耐久运维钩:每 tick 调用一次,内部时间门控(小时级 wal_checkpoint /
   *  天级 VACUUM INTO 备份)。cli 接线侧预绑定 db/cacheDir/state;失败只记日志不炸 tick。 */
  dbMaintenance?: () => void
  concurrency: {
    searching: number        // 默认 1（唯一起实际作用的并发槽;downloading/verifying 已随 executor 处决）
  }
  /** 进程退出钩子（测试注入用，默认 process.exit）。tick 连续意外失败达阈值时调用，
   *  nonzero 码交给外部编排（docker restart:unless-stopped 等）重启进程。 */
  exit?: (code: number) => void
  /** 沙盒孤儿 GC：daemon 启动时调用一次，镜像 jobs.reapAllActive 的"单实例前提，无条件
   *  回收"语义——旧进程遗留的 .subtitle-staging/<jobId> 目录全部视为孤儿垃圾。 */
  gcStaging?: () => number
}

/** tick() 连续意外抛错（reap/meta读/dispatch 里未被内层 try/catch 覆盖的异常，如磁盘满）
 *  达到这个次数后判定进程已不可自愈——调用 exit(1) fail-fast，而不是无声停摆着存活。 */
export const MAX_CONSECUTIVE_TICK_FAILURES = 5

/**
 * v2 daemon: 单条循环
 * tick (15s): reap → (到点，且无 realign 冲突) ingest → dispatch
 *
 * 去 Jellyfin 化 T4：原先的第二条循环（pollSessions，15s，Jellyfin 播放会话轮询 + 缺字幕条目
 * wake/boost）整体删除——用户根本不用 Jellyfin 播放（design 文档背景一节），这条播放优先级
 * 机制服务的场景在本战役的产品坐标下语义已死。同期删除的还有机械 scan()（镜像 Jellyfin
 * library）与 B2 self-scan refresh-bridge：两者折叠进下面 tickInner 的单条 ingest 心跳分支。
 */
export class ScoutDaemon {
  private inflight = new Set<Promise<void>>()
  // 心跳续租 + 派发身份追踪：本进程当前仍在跑的 job id → 那次 claim 拿到的 Job 对象
  // 引用（FIX-2：invocation 身份令牌）。每 tick 先为里面的 id 续租，reapExpiredLeases
  // 才不会误判"合法长跑"为死亡租约、导致并发双派发（starvation 审计修正）。
  //
  // 为什么值是 Job 对象而不是普通 number：同一个 job id 可能先后被两次 claim 领走
  // （reap 后重领）——若只用 Set<number> 去重，两次 invocation 会共享同一个 key，
  // 旧（detached）invocation 迟到的 .finally 一响就把新 invocation 的追踪条目也删了，
  // 新 invocation 从此失去心跳续租（FIX-2 审计修正）。改存 Job 对象引用后：
  //   1) 引用本身天然充当"这是哪一次 claim"的身份令牌——.finally 里用 === 比对，
  //      只有"我领到的那个对象仍是 map 里当前记录的那个"才允许删除自己的条目。
  //   2) 心跳续租每 tick 原地 mutate 这个共享对象的 lease_until（而不是替换成新对象）——
  //      这个设计最初是为旧管线 executor.ts 的 FIX-3 ownsLease 判据准备的
  //      （jobs.get(id).lease_until === job.lease_until，让它跟着合法续租一起前进，
  //      不被"合法续租"误判成"租约已被回收重派"）。executor.ts 已随旧管线退役删除，
  //      今天没有代码再做这个精确比对；in-place mutate 而非替换引用的写法本身仍然保留，
  //      与下方 renewLease 的返回值契约（jobsRepo.ts renewLease 注释）保持一致。
  private inflightJobs = new Map<number, Job>()
  private stopping = false
  // 部署重启瞬间：上个进程分钟前才写过 last_ingest_at，纯时间门会让首次 ingest 延迟
  // 最长一个 ingestEveryMs 周期，而 dispatch 每 15s 无条件跑——旧 wanted/failed job（含刚被
  // reapAllActive 复活的）会在 ingest 套用新分类规则之前被派发。强制开机第一拍
  // 先 ingest 一次，不管 last_ingest_at 多新，堵死这个窗口（旧 bootReconcilePending 的
  // 语义原样搬到这里，只是改名字并只服务 ingest 这一条分支）。
  private bootIngestPending = true
  // tick() 连续意外失败计数——任何一次 tick 顺利跑完（tickInner 不抛）就清零；
  // 达 MAX_CONSECUTIVE_TICK_FAILURES 时 fail-fast 退出进程（daemon.ts:249 审计修正）。
  private consecutiveTickFailures = 0

  constructor(private deps: DaemonDeps) {}

  /**
   * 一拍：reap → (到点)ingest → dispatch
   * 隔离层：tickInner 里任何未被内层 try/catch 吸收的意外抛错（如磁盘满命中
   * reapExpiredLeases/meta SELECT/dispatch 的 claimNext）都在这里兜住、记日志，
   * 不让 tickLoop 的 promise reject——否则会悄悄停摆但进程存活不退出。连续失败达阈值则
   * fail-fast 退出，交给外部编排（docker restart:unless-stopped）拉活。
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
    const { jobs, lib, log, now } = this.deps

    // 0. Heartbeat: 为本进程仍在跑的 job 续租，早于 reap 执行——防止合法长跑（如季包
    //    多集下载合法跑超 30min 租约）被误判死亡回收、被 dispatch 并发重领（starvation 审计修正）。
    //    FIX-2: 续租成功后把新 lease_until 原地写回追踪的 Job 对象——见字段声明处注释。
    for (const [jobId, trackedJob] of this.inflightJobs) {
      const renewed = jobs.renewLease(jobId, now())
      if (renewed !== null) trackedJob.lease_until = renewed
    }

    // 0b. FIX-1（派发饥饿审计修正）：单实例前提下，任何 active 态但 id 不在本进程
    //     inflightJobs 跟踪集合里的行，定义上就是孤儿（同 boot reapAllActive 的论证，
    //     只是判据从"进程重启"换成"跟踪集合缺失"）——不必等 30min 租约到期即可回收。
    //     生产实案：executeJob 的 promise 结算但其 continuation（.finally）从未被调度，
    //     job 卡在 active 态且不再被跟踪，过去只能靠 reapExpiredLeases 在租约到期后
    //     （最长 30 分钟）自愈，期间 searching 并发槽被永久占用、零 log/run 证据。
    //     Race-free 关键：这一步跑在 dispatch()（本 tick 唯一会新增 inflightJobs 条目
    //     的地方）之前——本 tick 刚被 dispatch 领走的行此刻根本还不存在于下面的查询结果
    //     里，不可能被误伤；真正 inflight 的行因为 id 在跟踪集合里，同样被天然排除。
    const orphaned = jobs.reapOrphaned(this.inflightJobs.keys(), now())
    for (const orphan of orphaned) {
      log(
        `warn: job ${orphan.id} (${orphan.kind} ${orphan.series_id ?? orphan.movie_id ?? '?'}) ` +
        `因派发饥饿孤儿被回收：state=${orphan.state} lease_until=${orphan.lease_until ?? 'null'} 但本进程未跟踪` +
        `（疑似 lost async continuation：executeJob 的 promise 结算但 continuation 从未运行）`
      )
    }

    // 1. Reap expired leases
    jobs.reapExpiredLeases(now())

    // 2. Ingest heartbeat（去 Jellyfin 化 T4：唯一的周期重活分支，取代了旧的机械 scan()
    //    reconcile + B2 self-scan refresh-bridge 两条独立时间门）。
    const lastIngestRow = lib.db
      .prepare(`SELECT value FROM meta WHERE key = 'last_ingest_at'`)
      .get() as { value: string } | undefined
    const lastIngestRaw = lastIngestRow ? Number(lastIngestRow.value) : 0
    // meta 行损坏时 NaN >= x 恒 false,ingest 心跳时间门静默永久失效——防御性归零
    const lastIngest = Number.isFinite(lastIngestRaw) ? lastIngestRaw : 0
    const timeSinceIngest = now() - lastIngest
    const ingestEveryDep = this.deps.ingestEveryMs
    const ingestEveryMs = (typeof ingestEveryDep === 'function' ? ingestEveryDep() : ingestEveryDep) ?? SELF_SCAN_DEFAULT_INTERVAL_MS

    if (this.bootIngestPending || timeSinceIngest >= ingestEveryMs) {
      // D4（design §P3 "Ingest-vs-realign exclusion"）：ingest 的磁盘真相 walker 与 realign
      // 的整理搬移在同一批路径上跑会互相踩脚——realign 正在搬的文件，中途状态对 walker
      // 而言像是"路径变了"，可能被误判成新文件重新识别，或误判成真的消失而删行。开跑前
      // 查一次：当下是否有一个 realign worker_task 正占着 searching 槽，有则整轮跳过。
      // 反方向（realign 的执行等待 ingestLock 空闲）是 realign 自己的职责，T7 处理。
      if (jobs.hasActiveRealignWorkerTask()) {
        log('ingest: skipped this round — a realign worker_task is active (avoids walker/file-move race, design D4)')
      } else {
        try {
          const result = await this.deps.ingestTrigger()
          log(
            `ingest: scanned=${result.ingest.scanned} upserted=${result.ingest.upserted} ` +
            `parked=${result.ingest.parked} removed=${result.ingest.removed} ` +
            `orchestratorTriggered=${result.orchestratorTriggered}`
          )

          lib.db
            .prepare(
              `INSERT INTO meta (key, value) VALUES ('last_ingest_at', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            )
            .run(String(now()))

          // 债务D2：ingest 自己这一轮触发了一次 orchestrate 入队——任何一次 orchestrate
          // 入队（不论来源）都刷新兜底心跳的时钟，避免 2b 步骤在同一 tick 或紧随其后的
          // 一拍里因为陈旧的 last_orchestrate_at 而误判"早已过期"、重复入队。
          if (result.orchestratorTriggered === true) {
            lib.db
              .prepare(
                `INSERT INTO meta (key, value) VALUES ('last_orchestrate_at', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
              )
              .run(String(now()))
          }

          // Boot ingest satisfied — only clear on success, so a failed boot pass keeps
          // retrying next tick instead of reopening the stale-gate window.
          this.bootIngestPending = false
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          log(`ingest error (isolated, will retry next gate): ${msg}`)
          // 稳态（boot 已成功后）中途 ingest 抖动不停摆 dispatch；boot 阶段则由下方守卫压制 dispatch。
        }
      }
    }

    // 2c. 债务D5：trace 快照每日修剪——runs 行保留（决策史不删），只把过保留期的 trace_json
    //     置 NULL。时间门同 last_ingest_at 的 meta 键手法，一天一次足矣（修剪不是热路径）。
    const lastPruneRow = lib.db
      .prepare(`SELECT value FROM meta WHERE key = 'last_trace_prune_at'`)
      .get() as { value: string } | undefined
    const lastPruneRaw = lastPruneRow ? Number(lastPruneRow.value) : 0
    // meta 行损坏时 NaN >= x 恒 false,trace-prune 时间门静默永久失效——防御性归零
    const lastPrune = Number.isFinite(lastPruneRaw) ? lastPruneRaw : 0
    if (now() - lastPrune >= 86_400_000) {
      const retentionDays = this.deps.traceRetentionDays?.() ?? 30
      const pruned = this.deps.runs.pruneTraces(now() - retentionDays * 86_400_000)
      if (pruned > 0) log(`trace prune: cleared ${pruned} snapshots older than ${retentionDays}d`)
      lib.db
        .prepare(`INSERT INTO meta (key, value) VALUES ('last_trace_prune_at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(String(now()))
    }

    // Boot: 首轮 ingest 成功之前绝不 dispatch——整栈重启时，库里还躺着上个进程遗留的
    // stale wanted job（新分类规则尚未跑过一轮 ingest），若照常 dispatch 会派发过时判断。
    if (this.bootIngestPending) return

    // 2b. 债务D2（胶水层修复战役）：orchestrate 低频兜底心跳。无变化世界里 ingest 恒
    // changed=0、永不触发 orchestrate，"识别晚到/pending 屏蔽"类惰性收敛洞永不愈合。
    // 任何一次 orchestrate 入队（ingest 触发或本心跳）都刷新时钟；identity 复用
    // INGEST_ORCHESTRATE_SERIES_ID——与 ingest 触发的 orchestrate 落同一 identity 行，天然幂等。
    // 冷启动 meta 缺失 → 立即补一拍：停机期间积累的惰性洞正好接住，属期望行为。
    const hbRow = lib.db.prepare(`SELECT value FROM meta WHERE key = 'last_orchestrate_at'`).get() as { value: string } | undefined
    const lastOrchestrateRaw = hbRow ? Number(hbRow.value) : 0
    // meta 行损坏时 NaN >= x 恒 false,orchestrate 心跳时间门静默永久失效——防御性归零
    const lastOrchestrate = Number.isFinite(lastOrchestrateRaw) ? lastOrchestrateRaw : 0
    if (now() - lastOrchestrate >= (this.deps.orchestrateHeartbeatMs ?? ORCHESTRATE_HEARTBEAT_MS)) {
      jobs.upsertWorkerTask(
        { seriesId: INGEST_ORCHESTRATE_SERIES_ID, season: null, movieId: null },
        { taskType: 'orchestrate', reason: 'heartbeat: periodic no-change-world convergence pass' },
        null, now(),
      )
      lib.db.prepare(`INSERT INTO meta (key, value) VALUES ('last_orchestrate_at', ?)
                      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(now()))
      log('orchestrate heartbeat: enqueued periodic convergence pass (24h fallback)')
    }

    // 2c. E AI 翻译：机械派 translate 任务（见 DaemonDeps.dispatchTranslate 的门控/时机注释）。
    // 失败只记一行 warn 不炸 tick——翻译是增益路径，绝不拖垮主循环。
    if (this.deps.dispatchTranslate) {
      try { this.deps.dispatchTranslate() } catch (e) { log(`warn: translate dispatch failed: ${String(e)}`) }
    }

    // 2d. DB 耐久运维（周期 checkpoint/在线备份，内部时间门控，见 dbMaintenance.ts）。
    if (this.deps.dbMaintenance) {
      try { this.deps.dbMaintenance() } catch (e) { log(`warn: db maintenance failed: ${String(e)}`) }
    }

    // 3. Dispatch: claim jobs up to concurrency limit
    await this.dispatch()
  }

  /**
   * Dispatcher: 双车道相位分隔(用户裁决 2026-07-22)。
   *  车道 A(巡检):find_subtitle/realign/orchestrate 等——照常占 searching 名额,永不被翻译堵。
   *  车道 B(翻译):taskType='translate'——**只在巡检世界全空**(无到点可领的非翻译任务、
   *  无非翻译活跃任务)且当前无翻译在跑时才领;不占 searching 名额(一场 2h 长翻译期间,
   *  新到的巡检工作照常走车道 A,互不阻塞)。
   */
  private async dispatch(): Promise<void> {
    const { jobs, log, now, concurrency } = this.deps

    // 车道 A:巡检任务(排除 translate)。本次 dispatch 只要领过巡检，就算本拍仍处于
    // patrol phase；即使 mock/极快 worker 同步完成，也要等下一 tick 才切 translate，
    // 不让两相位在同一拍背靠背混在一起。
    let patrolClaimedThisDispatch = false
    while (jobs.countActiveTaskType('translate', true) < concurrency.searching) {
      const job = jobs.claimNext(now(), { excludeTaskType: 'translate' })
      if (!job) break
      patrolClaimedThisDispatch = true
      this.claimAndRun(job)
    }

    // 车道 B:翻译——巡检队列全空 + 无翻译在跑,才领一条
    const patrolBusy =
      jobs.countClaimable(now(), { excludeTaskType: 'translate' }) > 0 ||
      jobs.countActiveTaskType('translate', true) > 0
    if (!patrolClaimedThisDispatch && !patrolBusy && jobs.countActiveTaskType('translate', false) === 0) {
      const job = jobs.claimNext(now(), { onlyTaskType: 'translate' })
      if (job) {
        log(`dispatch: 巡检队列已空,相位切换到翻译车道(claimed job ${job.id})`)
        this.claimAndRun(job)
      }
    }
  }

  /** 领到一个 job 后的统一执行簿记:日志 + inflight 跟踪 + fire-and-forget + 异常 synthetic run。 */
  private claimAndRun(job: Job): void {
    const { runs, executeJob, log, now } = this.deps

    // FIX-4c: 一行 log 记下每次 claim——job id、series/kind、lease_until，供人工
    // 追查"这个 job 是什么时候被派出去的、原定租约到几点"。
    log(
      `dispatch: claimed job ${job.id} (${job.kind} ${job.series_id ?? job.movie_id ?? '?'}` +
      `${job.kind === 'series_season' ? ` S${job.season}` : ''}) lease_until=${job.lease_until ?? 'null'}`
    )

    // Fire-and-forget: don't await, but track in inflight set (promise + job id →
    // Job object; the id feeds the heartbeat renewal above so this job's lease
    // never expires out from under it while genuinely still running in this
    // process). FIX-2: store the actual Job object (not just the id) — it doubles
    // as this invocation's identity token, see field-declaration comment above.
    this.inflightJobs.set(job.id, job)
    const jobPromise = executeJob(job)
      .catch((error) => {
        const msg = error instanceof Error ? error.message : String(error)
        log(`executeJob error for job ${job.id}: ${msg}`)
        // FIX-4b: fire-and-forget 的 catch 过去只记日志——日志会轮转/丢失，runs 表
        // 才是持久证据。补一条 synthetic error run 行，让每个 crashed invocation
        // 都在 runs 表留痕，即便 executeJob 内部自己那次 record() 没机会跑到
        // （比如异常发生在 handleWorkerTask/runXxxWorkerTask 各自 try/catch 覆盖范围
        // 之外的组装阶段——见 cli/index.ts handleWorkerTask 的 IMP#8 注释；旧管线
        // executor.ts 当年也有同类缺口，已随旧管线退役删除）。
        // Fail-soft：记录动作本身绝不能再抛出去炸主循环。
        try {
          runs.insert({
            jobId: job.id,
            startedAt: now(),
            finishedAt: now(),
            decision: 'error',
            detail: `daemon 捕获未处理异常（synthetic run 行，executeJob 本身未落 runs）：${msg}`,
            journalPath: null,
          })
        } catch (recordError) {
          const recordMsg = recordError instanceof Error ? recordError.message : String(recordError)
          log(`warn: job ${job.id} synthetic error run 行落盘失败（fail-soft，忽略）：${recordMsg}`)
        }
      })
      .finally(() => {
        this.inflight.delete(jobPromise)
        // FIX-2: only evict if the map still holds *this* invocation's own Job
        // object for this id — a stale/detached invocation's late .finally must
        // never delete a newer invocation's entry (reap+re-claim while the old
        // one is still "alive", i.e. its continuation just hasn't run yet).
        if (this.inflightJobs.get(job.id) === job) {
          this.inflightJobs.delete(job.id)
        }
      })

    this.inflight.add(jobPromise)
  }

  /**
   * 主循环：单条 setTimeout 链，signal 中止时退出
   * 退出前等待 inflight 清空或 30s 超时
   */
  async run(signal: AbortSignal): Promise<void> {
    const TICK_INTERVAL_MS = 15_000
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
    const stagingCleaned = this.deps.gcStaging?.() ?? 0
    if (stagingCleaned > 0) {
      this.deps.log(`boot: cleaned ${stagingCleaned} orphaned staging dir(s) from previous process`)
    }

    signal.addEventListener(
      'abort',
      () => {
        this.stopping = true
      },
      { once: true }
    )

    // Single tick loop
    const tickLoop = async () => {
      while (!this.stopping) {
        await this.tick()
        if (this.stopping) break
        await sleep(TICK_INTERVAL_MS, signal)
      }
    }

    tickLoop().catch(() => {})

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
