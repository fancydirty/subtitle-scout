import 'dotenv/config'
import { parseArgs } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateText, type LanguageModel } from 'ai'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { type FetchEvent } from './fetchLib.js'
import { gcOrphans } from '../files/stagingSandbox.js'
import { isDirWritable, type PathMapping } from '../core/mediaContext.js'
import { makeFileLogger } from '../core/fileLogger.js'
import { startDashboard } from '../dashboard/server.js'
import { makeModel } from '../agent/llm.js'
import {
  checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkMediaRoots,
  checkDatabase, checkStuckJobs, checkMountCapabilities,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { openDb } from '../v2/db.js'
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { makeIngestPass } from '../v2/ingest.js'
import { ScoutDaemon, type DaemonDeps } from '../v2/daemon.js'
import { fetchAnimeListsTable } from '../adapters/providers/animeLists.js'
import { makeRealignRunEpisode, type RealignExecutorDeps } from '../v2/realignExecutor.js'
import { makeRealignLibraryPort } from '../v2/realignLibraryPort.js'
import { replayRollback } from '../files/realignManifest.js'
import { runRealignWorkerTask } from '../v2/realignWorkerTask.js'
import { runFindSubtitleWorkerTask } from '../v2/findSubtitleWorkerTask.js'
import { runReconcileAll, runOrchestrateWorkerTask } from '../v2/reconcileAll.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { buildAdapters } from './buildAdapters.js'
import { resolveTargetLanguages } from './targetLanguages.js'
import { recognize } from '../recognition/index.js'
import { makeIngestTrigger } from '../daemon/ingestTrigger.js'
import { SELF_SCAN_DEFAULT_INTERVAL_MS } from '../daemon/selfScan.js'
import { probeEmbeddedSubtitles } from '../files/streamProbe.js'
import { dashboardNoTokenWarningLines } from './dashboardTokenWarning.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

export interface Assembled {
  cacheRoot: string
  /** 去 Jellyfin 化 P7（design §P7 代码出口）：MEDIA_PATH_MAPPINGS 环境变量退役，恒为
   *  []——mapPath/PathMapping 机械函数本身保留（D2 软退役），realign port 继续以 identity
   *  操作的形态消费空 mappings（见下方 assemble() 与 cmdWatch 的 realignDeps.mappings）。 */
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
  // 去 Jellyfin 化 P7：MEDIA_PATH_MAPPINGS 不再读取——mediaRoots() 的唯一根来源是 MEDIA_ROOTS
  // 环境变量（见下方）；mappings 恒为空数组，realign port 以 identity 操作消费它（D2）。
  const mappings: PathMapping[] = []
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
  // 可选：TMDB 中文标题变体数据源（key 用户自备，见 README「第三把钥匙」）。增益路径，无 key
  // 时为 null——watch/reconcile-all 各自的硬性前置检查会因此报错退出（见 cmdWatch/cmdReconcileAll）。
  const tmdb = process.env.TMDB_API_KEY ? new TmdbClient({ apiKey: process.env.TMDB_API_KEY }) : null
  return { cacheRoot, mappings, tmdb, reasoningModel }
}

/** 去 Jellyfin 化 T4：cmdWatch 与 cmdReconcileAll 共用的摄取 pass 组装——recognize 预绑定 tmdb +
 *  lib.findOverride（P6 认领消歧，消歧前查），probe 绑定 ffprobe 探针（files/streamProbe.ts）。
 *  两个调用点各自决定 roots/targetLanguages/originSkipLanguages/log 的具体来源，其余接线逐字
 *  相同，不重复两份。
 *  dashboard G4：roots 从静态数组换成惰性提供者——两个调用点都传
 *  `() => settingsRepo.listRoots().map(r => r.path)`，dashboard 里增删守备目录后不需要重启进程
 *  或重建这个 pass 闭包，下一轮调用自然读到最新的根集合（见 v2/ingest.ts 的 IngestDeps.roots）。 */
function buildIngestPass(opts: {
  roots: () => string[]
  lib: LibraryRepo
  tmdb: TmdbClient
  targetLanguages: string[]
  originSkipLanguages: string[]
  log: (msg: string) => void
}): ReturnType<typeof makeIngestPass> {
  return makeIngestPass({
    roots: opts.roots,
    lib: opts.lib,
    tmdb: opts.tmdb,
    recognize: (videoPath: string) => recognize(videoPath, opts.tmdb, { findOverride: (p) => opts.lib.findOverride(p) }),
    probe: (videoPath: string) => probeEmbeddedSubtitles(videoPath),
    targetLanguages: opts.targetLanguages,
    originSkipLanguages: opts.originSkipLanguages,
    log: opts.log,
  })
}

/** on-demand "全仓校验" 触发器（v3 phase ⑦ Task 1）：跑一次摄取 pass（去 Jellyfin 化 T4：
 *  scanLibrary 机械预扫描 → v2/ingest.ts 的 makeIngestPass，见 reconcileAll.ts 的
 *  ReconcileAllDeps.ingest 字段注释）+ 一次编排器过（makeOrchestratorAgent）。与 cmdWatch 内
 *  daemon 每 15min 一次的 ingest 心跳相互独立、并存——这是新 v3 链路的手动触发入口。命令跑完
 *  即退出，写下的 worker_task 行要等一个正在跑的 `watch` daemon 进程认领执行（本命令自己从不
 *  认领任何行）。
 *  TMDB_API_KEY 是硬性前置——不同于 cmdWatch 里 realign 那种"没配置就静默
 *  跳过"（那是给日常 watch 循环的容错，缺检测能力不该拦住找字幕主线）：orchestrator 的
 *  check_series_layout 工具需要真实 TmdbClient 才能判断"季数是否超出 TMDB 季表"，摄取层本身
 *  也需要真实 TmdbClient 才能识别文件——手动触发的全仓校验若因为缺 key 而悄悄只做一半，
 *  会让使用者误以为已经跑过完整校验——所以这里直接报错退出，同 requireEnv 的硬依赖语义一致。 */
async function cmdReconcileAll() {
  const { tmdb, reasoningModel, cacheRoot } = await assemble()
  if (!tmdb) {
    console.error('reconcile-all requires TMDB_API_KEY（orchestrator 的 check_series_layout 工具与摄取层都需要真实 TMDB 数据）— 请在 .env 里配置')
    process.exit(2)
  }
  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const jobs = new JobsRepo(db)
  const lib = new LibraryRepo(db)
  // dashboard G4：守备目录 DB 化——settingsRepo 是 roots 的权威来源，MEDIA_ROOTS env 只在
  // media_roots 表为空时充当首启种子（见 SettingsRepo.seedRootsFromEnv）。这是一次性命令
  // （跑完即退出），不需要惰性求值带来的"运行期加根即时生效"收益，但仍然统一走同一套接线，
  // 不再维护第二套"从 env 直读"的旧逻辑。
  const settingsRepo = new SettingsRepo(db)
  settingsRepo.seedRootsFromEnv(process.env.MEDIA_ROOTS, Date.now())
  const currentRoots = () => settingsRepo.listRoots().map(r => r.path)
  // A4: TARGET_LANGUAGES (comma-separated, default 'zh') + legacy SKIP_CHINESE_ORIGIN compat.
  // Two lists: targetLanguages = coverage/hunting targets; originSkipLanguages = origin-audio
  // languages that suppress an item — see targetLanguages.ts's resolveTargetLanguages for the
  // exact mapping (locked by targetLanguages.test.ts).
  // dashboard G4：settings.target_languages（行为级设置，dashboard 里可改）优先于部署层的
  // TARGET_LANGUAGES env，见 resolveTargetLanguages 第二参的文档注释。
  const { targetLanguages, originSkipLanguages } = resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))
  const ingest = buildIngestPass({
    roots: currentRoots, lib, tmdb, targetLanguages, originSkipLanguages,
    log: (msg) => console.log(`[reconcile-all] ${msg}`),
  })
  const decision = await runReconcileAll({
    ingest, lib, jobs, model: reasoningModel, tmdb,
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
  // 去 Jellyfin 化 P5/Task 7：realign port 已切到库原生实现（makeRealignLibraryPort，下方），
  // assemble() 不再持有任何 jf/jellyfinClient 句柄；P7 起 JELLYFIN_URL/JELLYFIN_API_KEY 的
  // requireEnv 已一并删除（design §P7 代码出口）。
  const { cacheRoot, mappings, tmdb, reasoningModel } = await assemble()
  // 去 Jellyfin 化 T4：TMDB_API_KEY 从"realign/orchestrate 才需要，缺了静默降级"升级成 watch
  // 的硬性前置——v2/ingest.ts 的 makeIngestPass 不再有 Jellyfin fallback 世界，识别文件、
  // 拉 origin_lang/poster 全靠真实 TmdbClient。requireEnv-style：缺 key 直接报错退出（exit 2），
  // 不悄悄跑一个"什么都摄取不了"的 watch 进程。
  if (!tmdb) {
    console.error('missing required env var: TMDB_API_KEY（watch 现在依赖 v2/ingest.ts 直连 TMDB 识别文件——不再有 Jellyfin fallback 世界）')
    process.exit(2)
  }
  const shutdown = new AbortController()

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

  // dashboard G4：守备目录 DB 化——spec 裁决照抄 Jellyfin 分界：挂载是部署层（compose volume），
  // 守备目录是产品层（media_roots 表，dashboard 里增删）。MEDIA_ROOTS env 降级为首启种子值：
  // 只在 media_roots 表为空时生效一次（seedRootsFromEnv 的既有幂等语义），此后 DB 是唯一真相。
  // currentRoots 是惰性提供者，每次调用都重新查表——这是本任务的关键属性："dashboard 里加根后
  // ingest 下一轮就能扫到"要求 roots 不能是这里冻结的一份静态数组快照。下面把它传给
  // ingestPass；handleWorkerTask 的 realign/find_subtitle 分支也各自在派发时重新调用它，
  // 不复用一份旧闭包捕获的数组（见各自分支的注释）。
  const settingsRepo = new SettingsRepo(db)
  settingsRepo.seedRootsFromEnv(process.env.MEDIA_ROOTS, Date.now())
  const currentRoots = (): string[] => settingsRepo.listRoots().map(r => r.path)
  if (currentRoots().length === 0) {
    console.log('[watch] no media roots configured（DB media_roots 为空，MEDIA_ROOTS 首启种子也为空）— subtitle writes are not root-restricted; 去 dashboard 加一个守备目录，或设 MEDIA_ROOTS 作首启种子')
  }

  // Construct DaemonDeps
  // A4: TARGET_LANGUAGES (comma-separated, default 'zh') + legacy SKIP_CHINESE_ORIGIN compat.
  // Two lists: targetLanguages = coverage/hunting targets; originSkipLanguages = origin-audio
  // languages that suppress an item — see targetLanguages.ts's resolveTargetLanguages for the
  // exact mapping (locked by targetLanguages.test.ts).
  // dashboard G4：settings.target_languages（行为级设置）优先于部署层的 TARGET_LANGUAGES env
  // ——见 resolveTargetLanguages 第二参的文档注释；本战役唯一被真正消费的行为键。
  const { targetLanguages, originSkipLanguages } = resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))

  // 去 Jellyfin 化 T4/T7：ingest 心跳依赖——v2/ingest.ts 的 makeIngestPass 顶替旧的机械 scan()
  // + B2 self-scan refresh-bridge 两条独立分支。提前到这里构造（原先在 ingestTrigger 组装处，
  // 见下方沿用注释）：realign port（下方 realignDeps）的 refreshLibrary 也要复用同一个 ingest
  // pass 闭包——"整理搬完之后让库看见新结构"就是再踢一次这同一份摄取，不重新拼一份。
  const ingestPass = buildIngestPass({ roots: currentRoots, lib, tmdb, targetLanguages, originSkipLanguages, log })

  // provider 事件 → 日志（find-subtitle worker 用，v3 phase ⑦）：这条新链路没有旧管线的
  // 逐 job Journal（老管线的 journalStore/withJournal 已随 Wave 2D 一并删除），api_call 量大信号
  // 低，只把 error/notice 落一行 log。
  // 提到 realign 依赖块之前（Wall ②）：realign 的字幕先行现在也走这个 worker，组装它自己的
  // adapters 需要同一个 emit 函数。
  const emitProviderEvent = (e: FetchEvent) => {
    if (e.event === 'provider_error') log(`find-subtitle worker: provider error (${e.provider}): ${e.message}`)
    else if (e.event === 'provider_notice') log(`find-subtitle worker: provider notice (${e.provider}): ${e.message}`)
  }

  // realign 执行依赖：计划构建需要 TMDB 季表才有确定性闸门。清算波 R-6（F15）：cmdWatch 顶部
  // 已把 TMDB_API_KEY 做成 requireEnv 式硬前置（未配置直接 exit(2)，见函数开头），tmdb 从此在
  // 整个 cmdWatch 函数体内恒非空——这份 deps 因此不再需要"tmdb ? {...} : undefined"三元
  // （旧注释"没有 TMDB_API_KEY 时整个 realign 功能一起跳过"描述的是硬前置引入之前的降级行为，
  // 已不成立，随手一并订正）。
  // v3 phase ⑦：这份 deps 对象单独具名——cmdWatch claim 循环 kind==='worker_task' 分支把同一份
  // RealignExecutorDeps 转交给 runRealignWorkerTask（phase ⑥，src/v2/realignWorkerTask.ts）复用。
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
  // 去 Jellyfin 化 P5/Task 7：port 的实现从 JellyfinClient 适配换成库原生实现
  // （src/v2/realignLibraryPort.ts）——realignExecutor.ts 的 5 重安全层（restructuring/
  // manifest/reveal/rollback + GAP-A 崩溃恢复纪律）零改动，只换这个 port 对象的构造方式。
  // runIngest 复用上方已构造的 ingestPass 闭包（refreshLibrary 的库原生等价操作）。
  // dashboard G4：jf/mediaRoots 两字段下面用 currentRoots() 给一份构造时刻的快照——真正的
  // "加根即时生效"由 handleWorkerTask 的 realign 分支在每次派发时用新鲜的 currentRoots() 整体
  // 覆写这两个字段（见该分支注释），这里的初值只是满足 RealignExecutorDeps 的类型要求，不指望
  // 被直接消费。
  const realignDeps: RealignExecutorDeps = {
    lib, jobs,
    jf: makeRealignLibraryPort({ lib, roots: currentRoots(), runIngest: ingestPass }),
    // A-F13：getDetails/getChineseTitles 补上——realign 字幕先行阶段的 TMDB 富化补面
    // （见 realignExecutor.ts 步骤 12 附近的 fetchTmdbEnrichment 调用）需要它们。
    tmdb: {
      getSeasonTable: (id) => tmdb.getSeasonTable(id),
      getDetails: (mediaType, id) => tmdb.getDetails(mediaType, id),
      getChineseTitles: (mediaType, id) => tmdb.getChineseTitles(mediaType, id),
    },
    fetchAnimeLists: () => fetchAnimeListsTable(),
    runEpisode: realignRunEpisode,
    now: () => Date.now(),
    log,
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
    getSize: (p) => { try { return statSync(p).size } catch { return null } },
    // CRIT#1：与 findSubtitleWorkerTaskDeps 的 mediaRoots 同源白名单（旧 makeRunEpisode
    // 的 opts.mediaRoots 已随退役T7/Wave 2A 删除，同源不变量转移到这里描述）；IMP#8：
    // 镜像/库/验收路径去 Jellyfin 化后已是本地路径（makeRealignLibraryPort 直接产出本地
    // 路径），mappings 在库原生世界对这些路径退化为 identity（配置的 from 侧从不匹配
    // 已经是本地形态的路径），仍原样传入以防将来有其余映射用途。
    mediaRoots: currentRoots(),
    mappings,
  }

  // find-subtitle worker 依赖（v3 phase ⑦）：mediaRoots 是"已配置的根"白名单（外层沙盒，同
  // realignDeps 那道门）；FindSubtitleTask.mediaRoot（每个 task 各自的季/影片
  // 目录）才是 agent 自己受限的内层沙盒——两者不是同一个东西，见 findSubtitleWorkerTask.ts
  // 的 FindSubtitleTaskMapperDeps 注释。adapters 每次 claim 现建（同旧管线每次子进程重建一次
  // 的成本量级，非新增开销）。
  // 去 Jellyfin 化 P4: findSubtitleWorkerTaskDeps no longer threads jf/mappings — episodes.path/
  // movies.path are already local filesystem paths (T3's ingest layer walks the filesystem
  // directly), so the mapper no longer needs a Jellyfin item lookup or MEDIA_PATH_MAPPINGS
  // translation (see src/v2/findSubtitleWorkerTask.ts's FindSubtitleTaskMapperDeps doc comment).
  // dashboard G4：mediaRoots 同 realignDeps 的处置——这里给一份构造时刻的快照满足类型要求，
  // handleWorkerTask 的 find_subtitle 分支在每次派发时用新鲜的 currentRoots() 覆写。
  const findSubtitleWorkerTaskDeps = {
    // targetLanguage: A4, the PRIMARY configured target — same single-valued note as
    // realignRunEpisode above.
    lib, tmdb, mediaRoots: currentRoots(), targetLanguage: targetLanguages[0],
    // 退役T1 (W0-3a): v3 worker_task runners previously wrote NOTHING to `runs` — only the old
    // pipeline did — so the dashboard's run-history timeline went dark for v3-produced work.
    // Threading the same RunsRepo instance cmdWatch already builds for the old pipeline gives
    // both runners timeline parity ahead of the old pipeline's retirement.
    runs,
  }

  // orchestrator 依赖（v3 phase ⑦）：sibling-orchestrator worker_task（taskType==='orchestrate'）
  // 用到 makeOrchestratorAgent 的 check_series_layout 工具，需要真实 TmdbClient——tmdb 在
  // cmdWatch 顶部已 requireEnv 式硬前置（清算波 R-6/F15），不再需要"tmdb ? {...} : undefined"
  // 降级三元。去 Jellyfin 化 P4 起不再需要 jf——tmdbId 直接从 seriesId 自身解析（src/v2/ownIds.ts）。
  // F-R2-3（R2 复审）：runs 复用 cmdWatch 顶部已构造的同一份 RunsRepo 实例（同
  // findSubtitleWorkerTaskDeps/realignDeps 两处既有接线一致的注入形态）——runOrchestrateWorkerTask
  // 从此也写 dashboard 时间线，不再是黑洞。
  const orchestrateWorkerTaskDeps = { lib, tmdb, model: reasoningModel, now: () => Date.now(), runs }

  // ingestPass 已在函数上方构造（realignDeps 的 refreshLibrary 也要复用它）。
  // makeIngestTrigger（src/daemon/ingestTrigger.ts）包一层：pass 本身报告 changed 时才 upsert
  // 一个 orchestrate worker_task（identity 固定去重）。tmdb 在函数顶部已经 requireEnv 过，
  // 这里不再需要"缺 key 就跳过"的降级三元分支。
  const ingestTrigger = makeIngestTrigger({ ingest: ingestPass, jobs, now: () => Date.now(), log })

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
        // dashboard G4：mediaRoots 在每次派发时用新鲜的 currentRoots() 覆写——POST 加根后不需要
        // 重启 watch 进程，下一个被 claim 的 find_subtitle 行就能写进新根（否则 outer 沙盒检查
        // assertDirSafe 会一直拿着 watch 启动那一刻的旧白名单，新根永远进不来）。
        await runFindSubtitleWorkerTask(
          job, { ...findSubtitleWorkerTaskDeps, mediaRoots: currentRoots(), runTask }, jobs, () => Date.now(),
        )
      } else if (payload.taskType === 'realign') {
        // 清算波 R-6（F15）：realignDeps 恒非空（tmdb 已在函数顶部硬前置，见 realignDeps 构造处
        // 的注释）——"未接线（缺 TMDB_API_KEY）"停车分支在这道硬前置之后不可达，随之删除。
        // 退役T1 (W0-3a): thread the same RunsRepo instance into the realign runner too — see
        // the comment on findSubtitleWorkerTaskDeps above for the why.
        // dashboard G4：同 find_subtitle 分支——mediaRoots + jf（realign port 内部按 roots 走盘/
        // 列虚拟库）都用新鲜的 currentRoots() 重建，不复用 cmdWatch 启动时刻构造的旧闭包。
        const roots = currentRoots()
        await runRealignWorkerTask(job, {
          ...realignDeps, runs,
          mediaRoots: roots,
          jf: makeRealignLibraryPort({ lib, roots, runIngest: ingestPass }),
        }, jobs, () => Date.now())
      } else if (payload.taskType === 'orchestrate') {
        // 同上：orchestrateWorkerTaskDeps 恒非空，"未接线"停车分支不可达，随之删除。
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
    ingestTrigger,
    // dashboard G4：每次 daemon tick 调用时重新取一遍 roots——同 ingestPass，不锁定启动时刻的快照。
    gcStaging: () => gcOrphans(currentRoots(), new Set()),
    // 清算波 R-6（A-F7）：job.kind==='worker_task' 是 claimNext() 这条 kind 无关队列上唯一的
    // 活执行通路。旧管线的中转层（v2/executor.ts 的 executeJob/executeRealignBranch）与它的
    // 路由决策（cli/legacyJobRouting.ts 的 routeLegacyJob/tombstoneLegacyJob）已整体删除：
    // - kind==='realign' 的 worker_task 早已经由 handleWorkerTask 直连 runRealignWorkerTask
    //   （见上方 realign 分支），从不经过这个旧中转层——executor.ts 服务的是已作古的老式
    //   kind==='realign' 单行（非 worker_task），upsertWanted（唯一的创建方）已随死器官处决，
    //   production 早已零调用点，没有任何在制品行会走到这里。
    // - kind==='series_season'/'movie' 是更早退役（Wave 2A）的老式 kind，同样零创建点。
    // 两者的存量墓碑处理（tombstoneLegacyJob）已不再需要专门的"体面收场"语义——任何非
    // worker_task 的 job 到达这里都是接线回归警报（不应该发生的状态），completeError 兜底：
    // 失败退避而不是让 daemon 崩，同时在 last_error 里留下可诊断的痕迹。
    executeJob: async (job) => {
      if (job.kind === 'worker_task') {
        await handleWorkerTask(job)
        return
      }
      jobs.completeError(job.id, `unknown/retired job kind reached executeJob: ${job.kind} (job ${job.id})`, Date.now())
      log(`warn: job ${job.id} kind=${job.kind} 已不是活执行通路（legacy 管线已处决），已失败退避`)
    },
    log,
    now: () => Date.now(),
    concurrency: {
      searching: 1,
      downloading: 2,  // 一期由 executor 内部串行，此处预留
      verifying: 2,    // 一期由 executor 内部串行，此处预留
    },
    // ingest 心跳的时间门间隔——SCAN_INTERVAL_MS 环境变量沿用（原先驱动 B2 self-scan 的同一个
    // 旋钮，语义现在直接就是 ingest 心跳的节拍，见 daemon.ts DaemonDeps.ingestEveryMs 注释）。
    ingestEveryMs: Number(process.env.SCAN_INTERVAL_MS) || SELF_SCAN_DEFAULT_INTERVAL_MS,
  }

  // "全仓校验"触发器（v3 phase ⑦ Task 3）：与 cmdReconcileAll（独立 CLI 命令，自己开一份 db 连接）
  // 共用同一个 runReconcileAll 函数，这里复用 watch 进程里已经打开的 db/lib/jobs/jf 实例，不
  // 另起一个 SQLite 连接。同 realign/orchestrate worker_task 一样门在 tmdb——check_series_layout
  // 工具需要真实 TmdbClient；未配置时 startDashboard 收到 undefined，端点返回 503（不是崩溃/悬空）。
  const reconcileAllClosure = tmdb
    ? () => runReconcileAll({
        ingest: ingestPass, lib, jobs, model: reasoningModel, tmdb,
        now: () => Date.now(), orchestratorJobId: null,
      })
    : undefined

  // Dashboard v2（媒体库 API，读 v2 SQLite；海报直出 TMDB CDN，不再走服务端代理）
  const dashPort = Number(process.env.DASHBOARD_PORT) || 0
  if (dashPort > 0) {
    const distDir = join(new URL('../..', import.meta.url).pathname, 'web', 'dist')
    const dashServer = await startDashboard({
      db,
      port: dashPort,
      token: process.env.DASHBOARD_TOKEN || undefined,
      distDir,
      reconcileAll: reconcileAllClosure,
      // dashboard G5：POST /api/v2/workflow/redispatch（人类扳手）依赖真实 JobsRepo；
      // GET /api/v2/library/series/:id 命中时的惰性 TMDB 缓存刷新依赖真实 tmdb——两者在 cmdWatch
      // 顶部都已 requireEnv 式硬前置为非空（tmdb 硬前置见函数开头；jobs 在上方无条件构造），
      // 直接传，不需要"缺席则 undefined"的三元判断。
      jobs,
      tmdb,
    })
    if (dashServer.listening) {
      console.log(`dashboard on http://0.0.0.0:${dashPort}${process.env.DASHBOARD_TOKEN ? ' (token required)' : ''}`)
      // R2D-5（R2 复审，主控裁决）：无 token 高声告警——不做 403 硬拒（会砸现行无 token 的家用
      // 部署；正式鉴权归 Sonarr 式立项），只在这里把风险说清楚。三行文案见
      // dashboardTokenWarning.ts（那个模块单独测，这里不直接写在 index.ts 里的理由见其头注释）。
      if (!process.env.DASHBOARD_TOKEN) {
        for (const line of dashboardNoTokenWarningLines()) console.error(line)
      }
    } else {
      log('dashboard server failed to start (port conflict?), continuing without dashboard')
    }
  }

  // 去 Jellyfin 化 P7：不再有单一"正在看哪台 Jellyfin"的地址可报，改报实际生效的媒体根白名单
  // （DB media_roots 与 MEDIA_ROOTS 首启种子都为空时 currentRoots() 为空——上方已经打印过对应
  // 的告警行）。这里只是启动时刻的一次性播报，之后 dashboard 增删根不会回来改这行日志。
  const startupRoots = currentRoots()
  console.log(`subtitle-scout v2 watching (media roots: ${startupRoots.length > 0 ? startupRoots.join(', ') : '(none configured)'})`)

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

async function cmdDoctor() {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const roots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const results: DoctorResult[] = []

  // env 缺失走诊断项（✗ + hint、exit 1），不 requireEnv 急切崩溃（那是 exit 2 的”用法错误”通道）
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

  // R2D-11（R2 复审）：MEDIA_ROOTS env 只是"首启种子"——dashboard G4 之后真正生效的守备目录
  // 存活在 DB media_roots 表（可经 dashboard 动态增删，env 早已不是唯一真源，见
  // settingsRepo.seedRootsFromEnv 的既有注释）。db 文件存在时读该表（沿用下方既有的动态 import
  // 手法，doctor 在数据库尚未初始化时不该白白 import 一整个 v2/db.js）并标注来源（db）；db
  // 尚未初始化（全新部署，一次 watch 都没跑过）时回落 env 首启种子并标注（env seed）——不假装
  // 这就是"真正生效"的清单。dbPath/dbExists 提前到这里算，下方 v2 database checks 复用同一份
  // 判定，不重复 existsSync。
  const dbPath = join(cacheRoot, 'scout.db')
  const dbExists = existsSync(dbPath)
  let mediaRootsForDoctor = roots
  let mediaRootsSource: 'db' | 'env seed' = 'env seed'
  if (dbExists) {
    // openDb 走既有的动态 import 手法（数据库尚未初始化时不 import v2/db.js）；SettingsRepo 本
    // 文件顶部已经静态 import 过（cmdWatch 也用它），这里直接复用，不重复动态 import 同一个类。
    // R2D-20：openDb 对迁移失败/外键违例是抛错路径——诊断工具不许死在它本该诊断的病上（下方
    // checkDatabase 会把同一种抛错转成 ✗ 诊断行），这里失败就回落 env seed 继续体检其余项。
    try {
      const { openDb } = await import('../v2/db.js')
      const db = openDb(dbPath)
      mediaRootsForDoctor = new SettingsRepo(db).listRoots().map(r => r.path)
      db.close()
      mediaRootsSource = 'db'
    } catch {
      // 保持 roots/env seed 初值——库打不开的具体病由 checkDatabase 如实呈报。
    }
  }
  results.push(checkMediaRoots(mediaRootsForDoctor, isDirWritable, mediaRootsSource))

  {
    const { probeMountCapabilities } = await import('../files/mountCapabilities.js')
    results.push(checkMountCapabilities(roots, probeMountCapabilities))
  }

  // v2 database checks (only if db file exists)
  if (dbExists) {
    const { openDb } = await import('../v2/db.js')

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
  const { positionals } = parseArgs({
    allowPositionals: true,
    options: {},
  })
  const cmd = positionals[0]
  if (cmd === 'watch') return cmdWatch()
  if (cmd === 'reconcile-all') return cmdReconcileAll()
  if (cmd === 'doctor') return cmdDoctor()
  if (cmd === 'realign-rollback' && positionals[1]) return cmdRealignRollback(positionals[1])
  console.error('usage: subtitle-scout watch | reconcile-all | doctor | realign-rollback <archiveDir>')
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
