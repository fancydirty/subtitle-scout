import 'dotenv/config'
import { parseArgs } from 'node:util'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateText, type LanguageModel } from 'ai'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { TmdbClient, resolveTmdbRefStrict } from '../adapters/providers/tmdb.js'
import { type FetchEvent } from './fetchLib.js'
import { gcOrphans } from '../files/stagingSandbox.js'
import { JellyfinClient } from '../adapters/players/jellyfin.js'
import type { PlayerServer } from '../adapters/players/types.js'
import { parsePathMappings, isDirWritable, type PathMapping } from '../core/mediaContext.js'
// import { Watcher } from '../daemon/watcher.js'  // v1 watcher — 保留文件但不再引用
// import { PrefetchQueue } from '../daemon/queue.js'  // v1 queue — v2 不用
import { Ledger } from '../core/ledger.js'
import { parseSince, formatReport } from './report.js'
import { makeFileLogger } from '../core/fileLogger.js'
import { startDashboard } from '../dashboard/server.js'
import { makeModel } from '../agent/llm.js'
import {
  checkJellyfin, checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkMediaRoots, checkPathMappings,
  checkDatabase, checkStuckJobs, checkMountCapabilities,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { openDb } from '../v2/db.js'
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { scanLibrary, type OriginResolver } from '../v2/scanner.js'
import { executeJob } from '../v2/executor.js'
import { ScoutDaemon, type DaemonDeps } from '../v2/daemon.js'
import type { MediaItem } from '../adapters/players/types.js'
import { fetchAnimeListsTable } from '../adapters/providers/animeLists.js'
import { executeRealign, makeRealignRunEpisode, type RealignExecutorDeps } from '../v2/realignExecutor.js'
import { replayRollback } from '../files/realignManifest.js'
import { runRealignWorkerTask } from '../v2/realignWorkerTask.js'
import { runFindSubtitleWorkerTask, type FindSubtitleWorkerTaskDeps } from '../v2/findSubtitleWorkerTask.js'
import { runReconcileAll, runOrchestrateWorkerTask } from '../v2/reconcileAll.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { buildAdapters } from './buildAdapters.js'
import { resolveTargetLanguages } from './targetLanguages.js'
import { recognize } from '../recognition/index.js'
import { makeSelfScanTrigger, type SelfScanTriggerDeps } from '../daemon/selfScanTrigger.js'
import { SELF_SCAN_DEFAULT_INTERVAL_MS } from '../daemon/selfScan.js'
import { routeLegacyJob, tombstoneLegacyJob } from './legacyJobRouting.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

export interface Assembled {
  cacheRoot: string
  jf: PlayerServer
  /** realign 编排需要 PlayerServer 之外的能力（ScheduledTasks/VirtualFolders/单库刷新/删条目）
   *  ——与 jf 是同一个 JellyfinClient 实例，只是这里保留具体类型，不经过 PlayerServer 抽象
   *  （realign 目前是 Jellyfin-专属能力，尚无跨播放器抽象需求，YAGNI）。 */
  jellyfinClient: JellyfinClient
  mappings: PathMapping[]
  /** 有 TMDB_API_KEY 时可用；取全部中文标题变体（增益路径，无 key 则 null）。 */
  tmdb: TmdbClient | null
  /** v3 phase ⑦：orchestrator/find-subtitle 两个新 ToolLoopAgent-based 子代理要的是一个真实
   *  `LanguageModel`（ai@7 的 `agent.generate()` 接口）。同一组 LLM_* env var，走 llm.ts 的
   *  makeModel() 建一个 LanguageModel 实例。 */
  reasoningModel: LanguageModel
}

async function assemble(): Promise<Assembled> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const jf = new JellyfinClient({ baseUrl: requireEnv('JELLYFIN_URL'), apiKey: requireEnv('JELLYFIN_API_KEY') })
  let extraBody: Record<string, unknown> | undefined
  if (process.env.LLM_EXTRA_BODY) {
    try { extraBody = JSON.parse(process.env.LLM_EXTRA_BODY) } catch {
      console.error(`LLM_EXTRA_BODY is not valid JSON: ${process.env.LLM_EXTRA_BODY}`)
      process.exit(2)
    }
  }
  const llmBaseUrl = requireEnv('LLM_BASE_URL')
  const llmApiKey = requireEnv('LLM_API_KEY')
  const llmModelName = requireEnv('LLM_MODEL')
  // v3 phase ⑦：a real LanguageModel for the new ToolLoopAgent-based orchestrator/find-subtitle
  // subagents — same LLM_* env.
  const reasoningModel = makeModel({ baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModelName, extraBody })
  // 可选：TMDB 中文标题变体数据源（key 用户自备，见 README「第四把钥匙」）。缺 key → null，走 jellyfin fallback。
  const tmdb = process.env.TMDB_API_KEY ? new TmdbClient({ apiKey: process.env.TMDB_API_KEY }) : null
  return { cacheRoot, jf, jellyfinClient: jf, mappings, tmdb, reasoningModel }
}

function mediaRoots(mappings: PathMapping[]): string[] {
  const fromEnv = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return [...mappings.map(m => m.to), ...fromEnv]
}

/** on-demand "全仓校验" 触发器（v3 phase ⑦ Task 1）：跑一次机械预扫描（scanLibrary，未改动）
 *  + 一次编排器过（makeOrchestratorAgent）。与 cmdWatch 内 daemon 每 15min 一次的机械 scan
 *  （reconcile；W0-4 起 aggregate 已退休，不再喂旧管线）相互独立、并存——这是新 v3 链路的
 *  手动触发入口。命令跑完即退出，写下的 worker_task 行要等一个正在跑的 `watch` daemon
 *  进程认领执行（本命令自己从不认领任何行）。
 *  TMDB_API_KEY 是硬性前置——不同于 cmdWatch 里 realign 那种"没配置就静默
 *  跳过"（那是给日常 watch 循环的容错，缺检测能力不该拦住找字幕主线）：orchestrator 的
 *  check_series_layout 工具需要真实 TmdbClient 才能判断"季数是否超出 TMDB 季表"，手动触发的
 *  全仓校验若因为缺 key 而悄悄只做一半，会让使用者误以为已经跑过完整校验——所以这里直接
 *  报错退出，同 requireEnv 的硬依赖语义一致。 */
async function cmdReconcileAll() {
  const { jf, mappings, tmdb, reasoningModel, cacheRoot } = await assemble()
  if (!tmdb) {
    console.error('reconcile-all requires TMDB_API_KEY（orchestrator 的 check_series_layout 工具需要真实 TMDB 季表数据）— 请在 .env 里配置')
    process.exit(2)
  }
  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const jobs = new JobsRepo(db)
  const lib = new LibraryRepo(db)
  // A4: TARGET_LANGUAGES (comma-separated, default 'zh') + legacy SKIP_CHINESE_ORIGIN compat.
  // Two lists: targetLanguages = coverage/hunting targets; originSkipLanguages = origin-audio
  // languages that suppress an item — see targetLanguages.ts's resolveTargetLanguages for the
  // exact mapping (locked by targetLanguages.test.ts).
  const { targetLanguages, originSkipLanguages } = resolveTargetLanguages(process.env)
  const originResolver: OriginResolver = {
    originFor: async item => {
      const ref = await resolveTmdbRefStrict(item, id => jf.getItem(id))
      return ref ? tmdb.getOriginLanguage(ref.mediaType, ref.tmdbId) : null
    },
  }
  const decision = await runReconcileAll({
    jf, lib, jobs, model: reasoningModel, tmdb, mappings, targetLanguages, originSkipLanguages, originResolver,
    now: () => Date.now(), orchestratorJobId: null,
  })
  console.log(
    `[reconcile-all] ${decision.summary} (dispatched ${decision.dispatchedFindSubtitle} find-subtitle, ` +
    `${decision.dispatchedRealign} realign, spawned ${decision.spawnedSiblings} sibling orchestrators)`
  )
  db.close()
  process.exit(0)
}

async function cmdWatch() {
  const { cacheRoot, jf, jellyfinClient: jellyfinClientForRealign, mappings, tmdb, reasoningModel } = await assemble()
  const shutdown = new AbortController()
  const roots = mediaRoots(mappings)
  if (roots.length === 0) {
    console.log('[watch] no MEDIA_ROOTS/MEDIA_PATH_MAPPINGS configured — subtitle writes are not root-restricted; set MEDIA_ROOTS to harden')
  }

  const fileLog = makeFileLogger(join(cacheRoot, 'logs'), Number(process.env.LOG_RETAIN_DAYS) || 30)
  const log = (msg: string) => {
    const line = `[watch ${new Date().toISOString()}] ${msg}`
    console.log(line)
    fileLog(msg)
  }

  // Open v2 database
  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const jobs = new JobsRepo(db)
  const lib = new LibraryRepo(db)
  const runs = new RunsRepo(db)

  // Construct DaemonDeps
  // A4: TARGET_LANGUAGES (comma-separated, default 'zh') + legacy SKIP_CHINESE_ORIGIN compat.
  // Two lists: targetLanguages = coverage/hunting targets; originSkipLanguages = origin-audio
  // languages that suppress an item — see targetLanguages.ts's resolveTargetLanguages for the
  // exact mapping (locked by targetLanguages.test.ts).
  const { targetLanguages, originSkipLanguages } = resolveTargetLanguages(process.env)

  // TMDB origin_lang 解析器：有 tmdb（TMDB_API_KEY 已配置）才接线，否则 undefined——
  // scanLibrary 退化到 classifyItem 的 ProductionLocations/标题启发式兜底梯队。
  // 用 resolveTmdbRefStrict（而非 resolveTmdbRef）：Episode→series 回查若是 Jellyfin 请求
  // 瞬时失败（网络/5xx），必须原样向上抛出，scanLibrary 才能按"本轮不解析"处理（不落
  // ORIGIN_UNKNOWN 哨兵、标题启发式兜底也被压制）；resolveTmdbRef 的静默吞错语义只适合
  // tmdbTitles 那类增益路径，接在这里会把 Jellyfin 抖动误判成"查无数据"并永久缓存。
  const originResolver: OriginResolver | undefined = tmdb
    ? {
        originFor: async item => {
          const ref = await resolveTmdbRefStrict(item, id => jf.getItem(id))
          return ref ? tmdb.getOriginLanguage(ref.mediaType, ref.tmdbId) : null
        },
      }
    : undefined

  // provider 事件 → 日志（find-subtitle worker 用，v3 phase ⑦）：这条新链路没有旧管线的
  // 逐 job Journal（老管线的 journalStore/withJournal 已随 Wave 2D 一并删除），api_call 量大信号
  // 低，只把 error/notice 落一行 log。
  // 提到 realign 依赖块之前（Wall ②）：realign 的字幕先行现在也走这个 worker，组装它自己的
  // adapters 需要同一个 emit 函数。
  const emitProviderEvent = (e: FetchEvent) => {
    if (e.event === 'provider_error') log(`find-subtitle worker: provider error (${e.provider}): ${e.message}`)
    else if (e.event === 'provider_notice') log(`find-subtitle worker: provider notice (${e.provider}): ${e.message}`)
  }

  // realign 执行依赖（Task 21 的 executeRealign 柯里化）：门在 tmdb 是否配置——计划构建需要
  // TMDB 季表才有确定性闸门，没有 TMDB_API_KEY 时整个 realign 功能（诊断+执行）一起跳过，
  // 行为回退到"只有内容退避梯，没有排布诊断"的现状，不报错、不阻塞正常找字幕流程。
  // v3 phase ⑦：这份 deps 对象单独具名（不再只活在 executeRealignClosure 的闭包里）——
  // cmdWatch claim 循环新增的 kind==='worker_task' 分支要把同一份 RealignExecutorDeps 转交给
  // runRealignWorkerTask（phase ⑥，src/v2/realignWorkerTask.ts）复用，而不是重新拼一份。
  //
  // Wall ②（old-pipeline-retirement phase 1）：字幕先行不再走 runPipeline/withJournal 老管线，
  // 而是复用 v3 find-subtitle worker（同 handleWorkerTask 下 find_subtitle 分支一样的组装方式：
  // makeModel 建好的 reasoningModel + buildAdapters(...) 建的 adapters + cacheRoot）。adapters
  // 只在这里建一次（watch 进程生命周期内长驻）——不像 handleWorkerTask 那样每次 claim 重建：
  // realign 的字幕先行是同一次 executeRealign 调用内对几十集的紧凑循环，没有"每次 claim"的
  // 边界，重建 adapters 没有对应收益，只有多余开销（Zimuku session store 重新读盘等）。
  const realignRunEpisode = makeRealignRunEpisode({
    runFindSubtitleTask: makeFindSubtitleWorker({
      model: reasoningModel,
      adapters: await buildAdapters(emitProviderEvent),
      cacheRoot,
    }),
    // A4: the PRIMARY configured target language — FindSubtitleTask.targetLanguage is
    // single-valued; multi-language per-item tasking is future work.
    targetLanguage: targetLanguages[0],
  })
  const realignDeps: RealignExecutorDeps | undefined = tmdb
    ? {
        lib, jobs,
        jf: {
          getItem: (id) => jf.getItem(id),
          getItemsPage: (start, limit) => jf.getItemsPage(start, limit),
          getScheduledTasks: () => jellyfinClientForRealign.getScheduledTasks(),
          getVirtualFolders: () => jellyfinClientForRealign.getVirtualFolders(),
          refreshLibrary: (id) => jellyfinClientForRealign.refreshLibrary(id),
          deleteItem: (id) => jellyfinClientForRealign.deleteItem(id),
        },
        tmdb: { getSeasonTable: (id) => tmdb.getSeasonTable(id) },
        fetchAnimeLists: () => fetchAnimeListsTable(),
        runEpisode: realignRunEpisode,
        now: () => Date.now(),
        log,
        sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
        getSize: (p) => { try { return statSync(p).size } catch { return null } },
        // CRIT#1：与 findSubtitleWorkerTaskDeps 的 mediaRoots 同源白名单（旧 makeRunEpisode
        // 的 opts.mediaRoots 已随退役T7/Wave 2A 删除，同源不变量转移到这里描述）；IMP#8：
        // 镜像/库/验收路径全是 Jellyfin 视角，任何 fs 操作前都要经 MEDIA_PATH_MAPPINGS 映射到本地。
        mediaRoots: roots,
        mappings,
      }
    : undefined
  const executeRealignClosure = realignDeps
    ? (realignJob: Job) => executeRealign(realignJob, realignDeps)
    : undefined

  // find-subtitle worker 依赖（v3 phase ⑦）：mediaRoots 是"已配置的根"白名单（外层沙盒，同
  // realignDeps 那道门）；FindSubtitleTask.mediaRoot（每个 task 各自的季/影片
  // 目录）才是 agent 自己受限的内层沙盒——两者不是同一个东西，见 findSubtitleWorkerTask.ts
  // 的 FindSubtitleTaskMapperDeps 注释。adapters 每次 claim 现建（同旧管线每次子进程重建一次
  // 的成本量级，非新增开销）。
  const findSubtitleWorkerTaskDeps = {
    // targetLanguage: A4, the PRIMARY configured target — same single-valued note as
    // realignRunEpisode above.
    lib, jf, tmdb, mappings, mediaRoots: roots, targetLanguage: targetLanguages[0],
    // 退役T1 (W0-3a): v3 worker_task runners previously wrote NOTHING to `runs` — only the old
    // pipeline did — so the dashboard's run-history timeline went dark for v3-produced work.
    // Threading the same RunsRepo instance cmdWatch already builds for the old pipeline gives
    // both runners timeline parity ahead of the old pipeline's retirement.
    runs,
  }

  // orchestrator 依赖（v3 phase ⑦）：sibling-orchestrator worker_task（taskType==='orchestrate'）
  // 同样门在 tmdb——makeOrchestratorAgent 的 check_series_layout 工具需要真实 TmdbClient。
  const orchestrateWorkerTaskDeps = tmdb ? { lib, tmdb, jf, model: reasoningModel, now: () => Date.now() } : undefined

  // B2 self-scan 触发依赖（周期文件系统扫描 + refresh-bridge，src/daemon/selfScanTrigger.ts）：
  // 同样门在 tmdb——subsystem C 的 recognize() 需要真实 TmdbClient 才能把路径消歧到 TMDB id。
  // getVirtualFolders/refreshLibrary 复用 jellyfinClientForRealign（同 realignDeps.jf 那一个
  // 实例）——都是"库位置查询 + 单库刷新"这同一对 Jellyfin 能力，没有理由各自建一份。
  const selfScanTriggerDeps: SelfScanTriggerDeps | undefined = tmdb
    ? {
        roots,
        knownPaths: () => lib.knownPaths(),
        recognize: (videoPath: string) => recognize(videoPath, tmdb),
        log,
        now: () => Date.now(),
        getVirtualFolders: () => jellyfinClientForRealign.getVirtualFolders(),
        refreshLibrary: (id: string) => jellyfinClientForRealign.refreshLibrary(id),
        mappings,
        jobs,
      }
    : undefined
  if (!selfScanTriggerDeps) {
    log('warn: self-scan 未接线（缺 TMDB_API_KEY），已跳过——daemon 其余部分不受影响')
  }

  // v3 phase ⑦ claim-loop routing: kind==='worker_task' 三个 taskType 分流。每个 runXxxWorkerTask
  // 函数（runFindSubtitleWorkerTask/runRealignWorkerTask/runOrchestrateWorkerTask）在被调用之后，
  // 自己都已经把抛出的异常兜进 completeError（worker-exhaustion 要求：find-subtitle worker 撞
  // 步数上限/超时/abort 是抛错，不是结构化 retry_later；一个抛错的 worker 必须让这个 job 失败
  // 退避，不能让 daemon 崩）、并自己完成 job 的状态迁移。但 find_subtitle 分支在调用
  // runFindSubtitleWorkerTask 之前，还要先 await buildAdapters(...) + makeFindSubtitleWorker(...)
  // 组装 runTask 闭包——这两步本身在它们各自的 try/catch 之外（只在 ZIMUKU_ENABLED=true 且缺
  // LLM_BASE_URL 时抛，watch 场景下 LLM_* 已被 requireEnv'd 兜底，实际不会触发，但保留同样的
  // 抛错-即-completeError 契约仍是必须的），因此这里把三个分支整体包进同一个 try/catch：
  // 任何分支在完成路由之前抛出，都在这里兜底 completeError，而不是让异常逃出 handleWorkerTask
  // 把 daemon 的 claim 循环带崩（daemon.dispatch 是最后一道网，这里的 try/catch 是它前面一道，
  // 不依赖它兜底）。
  const handleWorkerTask = async (job: Job): Promise<void> => {
    let payload: { taskType?: unknown } = {}
    try {
      payload = JSON.parse(job.payload ?? '{}')
    } catch {
      jobs.completeError(job.id, `worker_task job ${job.id} has unparseable payload: ${job.payload}`, Date.now())
      return
    }
    try {
      if (payload.taskType === 'find_subtitle') {
        const runTask = makeFindSubtitleWorker({
          model: reasoningModel,
          adapters: await buildAdapters(emitProviderEvent),
          cacheRoot,
        })
        await runFindSubtitleWorkerTask(job, { ...findSubtitleWorkerTaskDeps, runTask }, jobs, () => Date.now())
      } else if (payload.taskType === 'realign') {
        if (!realignDeps) {
          jobs.park(job.id, 'realign executor not wired (TMDB_API_KEY missing)', Date.now())
          log(`warn: job ${job.id} worker_task(realign) 未接线（缺 TMDB_API_KEY），已停车`)
          return
        }
        // 退役T1 (W0-3a): thread the same RunsRepo instance into the realign runner too — see
        // the comment on findSubtitleWorkerTaskDeps above for the why.
        await runRealignWorkerTask(job, { ...realignDeps, runs }, jobs, () => Date.now())
      } else if (payload.taskType === 'orchestrate') {
        if (!orchestrateWorkerTaskDeps) {
          jobs.park(job.id, 'orchestrator not wired (TMDB_API_KEY missing)', Date.now())
          log(`warn: job ${job.id} worker_task(orchestrate) 未接线（缺 TMDB_API_KEY），已停车`)
          return
        }
        await runOrchestrateWorkerTask(job, orchestrateWorkerTaskDeps, jobs)
      } else {
        jobs.completeError(job.id, `unknown worker_task taskType: ${String(payload.taskType)}`, Date.now())
      }
    } catch (error) {
      // Closes the phase ⑦ review's IMP#8 asymmetry: buildAdapters/makeFindSubtitleWorker assembly
      // above sits outside runFindSubtitleWorkerTask's own try/catch (it hasn't been called yet),
      // so a throw there previously left the job in 'searching' just like the realign wrapper bug
      // (finding #1) did. A throw this late (after runXxxWorkerTask already routed to its own
      // completeError/completeDone/park) can't happen — those calls never throw past their own
      // try/catch — so this only ever fires for the assembly step itself.
      const msg = error instanceof Error ? error.message : String(error)
      jobs.completeError(job.id, msg, Date.now())
      log(`warn: job ${job.id} worker_task(${String(payload.taskType)}) 组装阶段抛错，已失败退避: ${msg}`)
    }
  }

  const daemonDeps: DaemonDeps = {
    lib,
    jobs,
    runs,
    scan: async () => {
      await scanLibrary(jf, lib, {
        pageSize: 100,
        fileExists: (p) => existsSync(p),
        mappings,
        targetLanguages,
        originSkipLanguages,
        resolver: originResolver,
      })
    },
    gcStaging: () => gcOrphans(roots, new Set()),
    executeJob: async (job) => {
      // v3 phase ⑦: job.kind==='worker_task' is a THIRD, independent execution path off the
      // same kind-agnostic claimNext() queue — routed by payload.taskType, never touching the
      // OLD pipeline's executeJob (v2/executor.ts). This is what makes claimNext() genuinely
      // serve the new find-subtitle worker and the realign wrapper off one queue.
      if (job.kind === 'worker_task') {
        await handleWorkerTask(job)
        return
      }
      // W0-4 切 feed: kind==='realign' still routes to the OLD executor.ts's executeJob — its
      // first line dispatches straight into executeRealignBranch, and that branch's
      // 5-layer-safety realignExecutor.ts call chain is kept machinery (not retired today).
      // 退役T7 (Wave 2A): the series_season/movie branch executeJob used to fall through to
      // (plus makeRunEpisode/deps.runEpisode, which fed it) has been deleted — that path now
      // throws if ever reached. series_season/movie never reach it: routeLegacyJob tombstones
      // them before this branch, same as before — see routeLegacyJob.
      if (routeLegacyJob(job.kind) === 'execute-realign') {
        // Wave 2D: executeJob's ExecutorDeps (src/v2/executor.ts) never had a journal-shaped
        // field — the old runPipeline/withJournal wrapper here was dead weight carried over
        // from the retired old-pipeline call site, not a real dependency of this branch.
        await executeJob(job, {
          lib,
          jobs,
          executeRealign: executeRealignClosure,
          now: () => Date.now(),
          log,
        })
        return
      }
      tombstoneLegacyJob(job, jobs, log, Date.now())
    },
    getSessions: () => jf.getSessions(),
    episodeForSession: (item: MediaItem) => {
      if (item.Type === 'Episode' && item.SeriesId && item.ParentIndexNumber !== undefined && item.ParentIndexNumber !== null) {
        return {
          kind: 'series_season' as const,
          seriesId: item.SeriesId,
          season: item.ParentIndexNumber,
        }
      }
      if (item.Type === 'Movie' && item.Id) {
        return {
          kind: 'movie' as const,
          movieId: item.Id,
        }
      }
      return null
    },
    log,
    now: () => Date.now(),
    // RECONCILE_EVERY_MS：机械 scan 的节拍旋钮（默认 15 min；W0-4 起 aggregate 已从这个
    // 节拍摘线退休）。自研巡检（B2）的 Signal B 依赖 scan() 把 Jellyfin 摄取结果镜像进
    // episodes/movies，所以真站验证/快速环境会把它调小；生产不设即维持原默认。
    reconcileEveryMs: Number(process.env.RECONCILE_EVERY_MS) || 15 * 60_000,
    fullScanEveryMs: 6 * 3600_000,   // 6 hours (一期全量扫描，此字段预留)
    concurrency: {
      searching: 1,
      downloading: 2,  // 一期由 executor 内部串行，此处预留
      verifying: 2,    // 一期由 executor 内部串行，此处预留
    },
    // B2: selfScanTriggerDeps 未接线（缺 TMDB_API_KEY）时 undefined——daemon.ts 的 tickInner
    // 整段 self-scan 分支静默跳过，同 realign/orchestrate worker_task 一样的降级语义。
    selfScan: selfScanTriggerDeps ? makeSelfScanTrigger(selfScanTriggerDeps) : undefined,
    selfScanEveryMs: Number(process.env.SCAN_INTERVAL_MS) || SELF_SCAN_DEFAULT_INTERVAL_MS,
  }

  // "全仓校验"触发器（v3 phase ⑦ Task 3）：与 cmdReconcileAll（独立 CLI 命令，自己开一份 db 连接）
  // 共用同一个 runReconcileAll 函数，这里复用 watch 进程里已经打开的 db/lib/jobs/jf 实例，不
  // 另起一个 SQLite 连接。同 realign/orchestrate worker_task 一样门在 tmdb——check_series_layout
  // 工具需要真实 TmdbClient；未配置时 startDashboard 收到 undefined，端点返回 503（不是崩溃/悬空）。
  const reconcileAllClosure = tmdb
    ? () => runReconcileAll({
        jf, lib, jobs, model: reasoningModel, tmdb, mappings, targetLanguages, originSkipLanguages, originResolver,
        now: () => Date.now(), orchestratorJobId: null,
      })
    : undefined

  // Dashboard v2（媒体库 API + 海报代理，读 v2 SQLite）
  const dashPort = Number(process.env.DASHBOARD_PORT) || 0
  if (dashPort > 0) {
    const distDir = join(new URL('../..', import.meta.url).pathname, 'web', 'dist')
    const dashServer = await startDashboard({
      db,
      port: dashPort,
      token: process.env.DASHBOARD_TOKEN || undefined,
      distDir,
      jellyfin: {
        baseUrl: requireEnv('JELLYFIN_URL'),
        apiKey: requireEnv('JELLYFIN_API_KEY'),
      },
      reconcileAll: reconcileAllClosure,
    })
    if (dashServer.listening) {
      console.log(`dashboard on http://0.0.0.0:${dashPort}${process.env.DASHBOARD_TOKEN ? ' (token required)' : ''}`)
    } else {
      log('dashboard server failed to start (port conflict?), continuing without dashboard')
    }
  }

  console.log(`subtitle-scout v2 watching ${process.env.JELLYFIN_URL}`)

  const daemon = new ScoutDaemon(daemonDeps)

  const stop = () => {
    log('received shutdown signal')
    shutdown.abort()
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  await daemon.run(shutdown.signal)
  process.exit(0)
}

async function cmdReport(since: string) {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const ledger = new Ledger(join(cacheRoot, 'ledger.jsonl'))
  let sinceMs: number
  try {
    sinceMs = parseSince(since, Date.now())
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
  const { events, badLines } = ledger.read(sinceMs)
  // v2: queue 不再使用，报告暂时传空队列状态（二期接 DB 后恢复）
  const queueNow = { pending: 0, dormant: 0 }
  // try { queueNow = new PrefetchQueue(join(cacheRoot, 'queue.json')).size() } catch { /* 无队列文件 */ }
  process.stdout.write(formatReport(events, badLines, queueNow))
  process.exit(0)
}

async function cmdDoctor() {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const roots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const results: DoctorResult[] = []

  // env 缺失走诊断项（✗ + hint、exit 1），不 requireEnv 急切崩溃（那是 exit 2 的”用法错误”通道）
  const jfUrl = process.env.JELLYFIN_URL
  const jfKey = process.env.JELLYFIN_API_KEY
  let jf: PlayerServer | undefined
  let jellyfinResult: DoctorResult
  if (!jfUrl || !jfKey) {
    jellyfinResult = {
      name: 'jellyfin', ok: false, detail: 'JELLYFIN_URL / JELLYFIN_API_KEY 未配置',
      hint: '在 .env 里填上这两项（获取方法见 README 三把钥匙一节）。',
    }
  } else {
    jf = new JellyfinClient({ baseUrl: jfUrl, apiKey: jfKey })
    const client = jf
    jellyfinResult = await checkJellyfin({ getSessions: () => withTimeout(client.getSessions(), 10_000, 'Jellyfin') })
  }
  results.push(jellyfinResult)

  const assrtToken = process.env.ASSRT_TOKEN
  if (!assrtToken) {
    results.push({
      name: 'assrt', ok: false, detail: 'ASSRT_TOKEN 未配置',
      hint: '注册/获取：https://assrt.net → 登录 → 用户中心复制 API token。',
    })
  } else {
    const assrt = new AssrtClient({ token: assrtToken, cacheDir: join(cacheRoot, 'assrt-responses') })
    results.push(await checkAssrt({ quota: () => withTimeout(assrt.quota(), 10_000, 'ASSRT') }))
  }

  const osKey = process.env.OPENSUBTITLES_API_KEY
  if (!osKey) {
    results.push(await checkOpenSubtitles(null))
  } else {
    const os = new OpenSubtitlesClient({
      apiKey: osKey, appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME, password: process.env.OPENSUBTITLES_PASSWORD,
    })
    // The Matrix：配额免费的探测目标，只验证 key/网络，不耗下载配额
    results.push(await checkOpenSubtitles({
      search: () => withTimeout(os.search({ imdbId: 133093, languages: ['zh-cn'] }), 10_000, 'OpenSubtitles'),
    }))
  }

  const zimukuEnabled = process.env.ZIMUKU_ENABLED === 'true'
  if (!zimukuEnabled) {
    results.push(await checkZimuku(null))
  } else {
    results.push(await checkZimuku({
      fetchHomepage: async () => {
        const res = await withTimeout(fetch('https://www.zimuku.org/', { signal: AbortSignal.timeout(10_000) }), 10_000, 'zimuku')
        const html = await res.text()
        return { ok: res.ok, challenged: detectChallenge(html) }
      },
    }))
  }

  const llmBase = process.env.LLM_BASE_URL
  const llmKey = process.env.LLM_API_KEY
  const llmModel = process.env.LLM_MODEL
  if (!llmBase || !llmKey || !llmModel) {
    results.push({
      name: 'llm', ok: false, detail: 'LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 未配置',
      hint: '三项必须来自同一个 AI 服务商（比如都用 DeepSeek），BASE_URL 通常以 /v1 结尾。',
    })
  } else {
    const model = makeModel({ baseUrl: llmBase, apiKey: llmKey, model: llmModel })
    results.push(await checkLlm(async () =>
      (await generateText({ model, prompt: '回复"ok"两个字母即可', abortSignal: AbortSignal.timeout(30_000) })).text))
  }

  results.push(checkMediaRoots(roots, isDirWritable))

  {
    const { probeMountCapabilities } = await import('../files/mountCapabilities.js')
    results.push(checkMountCapabilities(roots, probeMountCapabilities))
  }

  if (jf && jellyfinResult.ok) {
    try {
      const items = await jf.getRecentItems(20)
      results.push(checkPathMappings(items, mappings, { dirExists: d => existsSync(d), isWritable: isDirWritable }))
    } catch {
      results.push({ name: 'path-mapping', ok: true, skip: true, detail: '取媒体列表失败，跳过（先看 jellyfin 项）' })
    }
  } else {
    results.push({ name: 'path-mapping', ok: true, skip: true, detail: 'Jellyfin 不可达，跳过（先修复 jellyfin 项）' })
  }

  // v2 database checks (only if db file exists)
  const dbPath = join(cacheRoot, 'scout.db')
  if (existsSync(dbPath)) {
    const { openDb } = await import('../v2/db.js')
    const { JobsRepo } = await import('../v2/jobsRepo.js')

    results.push(checkDatabase(() => {
      const db = openDb(dbPath)
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      db.close()
      return { version: row?.value ?? '0' }
    }))

    results.push(checkStuckJobs(() => {
      const db = openDb(dbPath)
      const now = Date.now()
      const result = db.prepare(
        `SELECT COUNT(*) as count FROM jobs
         WHERE state IN ('searching', 'downloading', 'verifying')
         AND (lease_until < ? OR lease_until IS NULL)`
      ).get(now) as { count: number }
      db.close()
      return result.count
    }))
  } else {
    results.push({ name: 'database', ok: true, skip: true, detail: '数据库尚未初始化，起一次 watch 即建' })
    results.push({ name: 'stuck-jobs', ok: true, skip: true, detail: '数据库尚未初始化，起一次 watch 即建' })
  }
  console.log(formatDoctorReport(results))
  if (!overallOk(results)) process.exit(1)
}

/** 操作员回滚逃生舱：读 archiveDir 下的 write-ahead manifest，把整理搬动的文件逆序重放回
 *  原位。幂等（replayRollback 自身对已回滚/源缺失/尺寸不符都会跳过而非报错），可安全重跑。 */
async function cmdRealignRollback(archiveDir: string) {
  const log = (msg: string) => console.log(msg)
  try {
    replayRollback(archiveDir, log)
    console.log('回滚完成。')
    process.exit(0)
  } catch (e) {
    console.error(`回滚失败：${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      since: { type: 'string', default: '24h' },
    },
  })
  const cmd = positionals[0]
  if (cmd === 'watch') return cmdWatch()
  if (cmd === 'reconcile-all') return cmdReconcileAll()
  if (cmd === 'report') return cmdReport(values.since!)
  if (cmd === 'doctor') return cmdDoctor()
  if (cmd === 'realign-rollback' && positionals[1]) return cmdRealignRollback(positionals[1])
  console.error('usage: subtitle-scout watch | reconcile-all | report [--since <24h|7d|ISO-date-UTC>] | doctor | realign-rollback <archiveDir>')
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
