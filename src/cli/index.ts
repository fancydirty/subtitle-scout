import 'dotenv/config'
import { parseArgs } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateText, type LanguageModel } from 'ai'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { type FetchEvent } from './fetchLib.js'
import { applyQuotaEvent } from './quotaState.js'
import { gcOrphans } from '../files/stagingSandbox.js'
import { isDirWritable, type PathMapping } from '../core/mediaContext.js'
import { makeFileLogger } from '../core/fileLogger.js'
import { startDashboard } from '../dashboard/server.js'
import { AuthService } from '../dashboard/auth.js'
import { makeModel } from '../agent/llm.js'
import { cmdTranslateItem, tryAutoTranslateCfg, makeDaemonTranslateRunItem } from './translateItemCommand.js'
import { makeRealFetchSourceSub } from './fetchSourceSub.js'
import { dispatchTranslateTasks, runTranslateWorkerTask } from '../v2/translateWorkerTask.js'
import {
  checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkTmdb, checkMediaRoots,
  checkDatabase, checkStuckJobs, checkMountCapabilities,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { ZIMUKU_BASE } from '../adapters/providers/zimuku.js'
import { openDb } from '../v2/db.js'
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { makeMaintenanceState, runDbMaintenance } from '../v2/dbMaintenance.js'
import { makeIngestPass } from '../v2/ingest.js'
import { ScoutDaemon, type DaemonDeps } from '../v2/daemon.js'
import { fetchAnimeListsTable } from '../adapters/providers/animeLists.js'
import { makeRealignRunEpisode, type RealignExecutorDeps } from '../v2/realignExecutor.js'
import { makeRealignLibraryPort } from '../v2/realignLibraryPort.js'
import { replayRollback } from '../files/realignManifest.js'
import { runRealignWorkerTask } from '../v2/realignWorkerTask.js'
import { runFindSubtitleWorkerTask } from '../v2/findSubtitleWorkerTask.js'
import { runRescueWorkerTask } from '../v2/rescueWorkerTask.js'
import { runReconcileAll, runOrchestrateWorkerTask } from '../v2/reconcileAll.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { makeRescueWorker } from '../agent/rescueWorker.js'
import { buildAdapters } from './buildAdapters.js'
import { resolveTargetLanguages } from './targetLanguages.js'
import { recognize } from '../recognition/index.js'
import { makeIngestTrigger } from '../daemon/ingestTrigger.js'
import { SELF_SCAN_DEFAULT_INTERVAL_MS } from '../daemon/selfScan.js'
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'
import { dashboardAuthStartupLines } from './dashboardTokenWarning.js'
import { claimParked } from '../dashboard/apiV2.js'

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
  const tmdb = process.env.TMDB_API_KEY
    ? new TmdbClient({ apiKey: process.env.TMDB_API_KEY, baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL })
    : null
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
  targetLanguages: () => string[]
  originSkipLanguages: () => string[]
  excludeExtras?: () => boolean
  hardsubMode?: () => 'off' | 'agent' | 'aggressive'
  log: (msg: string) => void
}): ReturnType<typeof makeIngestPass> {
  return makeIngestPass({
    roots: opts.roots,
    lib: opts.lib,
    tmdb: opts.tmdb,
    recognize: (videoPath: string) => recognize(videoPath, opts.tmdb, { findOverride: (p) => opts.lib.findOverride(p) }),
    probe: (videoPath: string) => probeEmbeddedSubtitles(videoPath),
    // 重复源 P4b："复制优先"机械通道（v2/subtitlePropagation.ts）接线——同 realign 那处既有接线
    // 复用同一个 probeDurationSec，不是新引入的探针实现。
    probeDuration: (videoPath: string) => probeDurationSec(videoPath),
    targetLanguages: opts.targetLanguages,
    originSkipLanguages: opts.originSkipLanguages,
    excludeExtras: opts.excludeExtras,
    hardsubMode: opts.hardsubMode,
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
  // 债务D5：语言配置提供者——settings 行为级 > env 部署级的求值挪进闭包，每次消费新鲜读。
  const languagesNow = () => resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))
  const ingest = buildIngestPass({
    roots: currentRoots, lib, tmdb,
    targetLanguages: () => languagesNow().targetLanguages,
    originSkipLanguages: () => languagesNow().originSkipLanguages,
    excludeExtras: () => settingsRepo.get('exclude_extras') === 'true',
    // 救援R5：hardsub_mode 提供者——非三态合法值（未设置/脏值）一律降级 'off'（最保守，
    // 同 exclude_extras 的默认关闭口径）。
    hardsubMode: () => {
      const v = settingsRepo.get('hardsub_mode')
      return v === 'agent' || v === 'aggressive' ? v : 'off'
    },
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
  // 债务D5：语言配置提供者——settings 行为级 > env 部署级的求值挪进闭包，每次消费新鲜读。
  const { targetLanguages } = resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))
  const languagesNow = () => resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))

  // 去 Jellyfin 化 T4/T7：ingest 心跳依赖——v2/ingest.ts 的 makeIngestPass 顶替旧的机械 scan()
  // + B2 self-scan refresh-bridge 两条独立分支。提前到这里构造（原先在 ingestTrigger 组装处，
  // 见下方沿用注释）：realign port（下方 realignDeps）的 refreshLibrary 也要复用同一个 ingest
  // pass 闭包——"整理搬完之后让库看见新结构"就是再踢一次这同一份摄取，不重新拼一份。
  const ingestPass = buildIngestPass({
    roots: currentRoots, lib, tmdb,
    targetLanguages: () => languagesNow().targetLanguages,
    originSkipLanguages: () => languagesNow().originSkipLanguages,
    excludeExtras: () => settingsRepo.get('exclude_extras') === 'true',
    // 救援R5：hardsub_mode 提供者——非三态合法值（未设置/脏值）一律降级 'off'（最保守，
    // 同 exclude_extras 的默认关闭口径）。
    hardsubMode: () => {
      const v = settingsRepo.get('hardsub_mode')
      return v === 'agent' || v === 'aggressive' ? v : 'off'
    },
    log,
  })

  // provider 事件 → 日志（find-subtitle worker 用，v3 phase ⑦）：这条新链路没有旧管线的
  // 逐 job Journal（老管线的 journalStore/withJournal 已随 Wave 2D 一并删除），api_call 量大信号
  // 低，只把 error/notice 落一行 log。
  // 提到 realign 依赖块之前（Wall ②）：realign 的字幕先行现在也走这个 worker，组装它自己的
  // adapters 需要同一个 emit 函数。
  const emitProviderEvent = (e: FetchEvent) => {
    applyQuotaEvent(e, settingsRepo, Date.now())
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
    // 债务D5：ingest/find_subtitle 已新鲜求值，realign 字幕先行仍是 watch 启动时快照
    // （realignExecutor 组装是长驻闭包，改语言后需重启才影响 realign 这一条路径——如实注记，
    // 非债务遗漏）。
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
        // 债务D5：targetLanguage 同 mediaRoots 在每次派发时新鲜读取——设置页改 target_languages
        // 后被 claim 的 find_subtitle 任务立即生效。
        await runFindSubtitleWorkerTask(
          job, {
            ...findSubtitleWorkerTaskDeps, mediaRoots: currentRoots(),
            targetLanguage: languagesNow().targetLanguages[0],
            // 救援R5：hardsub_mode 同 targetLanguage 的既有先例——每次派发新鲜读取，脏值/未设置
            // 降级 'off'（同 ingest 侧 buildIngestPass 调用点的同款判定逻辑）。
            hardsubMode: (() => {
              const v = settingsRepo.get('hardsub_mode')
              return v === 'agent' || v === 'aggressive' ? v : 'off'
            })(),
            runTask,
          }, jobs, () => Date.now(),
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
      } else if (payload.taskType === 'rescue_identify') {
        // 救援R2：agent 清停车场——runTask 每次 claim 现建（同 find_subtitle 分支的 adapters
        // 现建口径；rescue 无 adapters，只有 tmdb 只读三方法）。claimParked 走 apiV2 同一实现
        // 路径（防漂移铁律），requestIngest 沿甄别页认领的踢扫描先例（复用同一个 ingestTrigger
        // 闭包，fire-and-forget 并兜底未捕获 rejection）。
        await runRescueWorkerTask(job, {
          lib,
          probeDuration: (p) => probeDurationSec(p),
          claimParked: (input) => claimParked(db, input),
          requestIngest: () => {
            void ingestTrigger().catch((e) => log(`warn: rescue identify 后踢一脚扫描失败（下一个自然周期还会再扫一次）: ${String(e)}`))
          },
          runs,
          runTask: makeRescueWorker({ model: reasoningModel, tmdb }),
        }, jobs, () => Date.now())
      } else if (payload.taskType === 'translate') {
        // E AI 翻译:daemon 自动翻一个可译候选。**双重 env 门控**——tryAutoTranslateCfg 只认显式
        // TRANSLATE_* 三件套(绝不回退 LLM_*=mimo 烧配额),不全则拒跑走 completeError(等用户配齐;
        // 与 dispatch 侧门控对称,即便有残留 translate 行也不会误用弱模型)。deps 与手动 CLI 共用
        // makeDaemonTranslateRunItem→makeTranslateAgentDeps(workspace agent 主路径)防漂移。
        const cfg = tryAutoTranslateCfg()
        if (!cfg) {
          jobs.completeError(job.id, 'translate 未启用:需配 TRANSLATE_MODEL/TRANSLATE_BASE_URL/TRANSLATE_API_KEY 三件套', Date.now())
        } else {
          // P3:translate 分支从 legacy translateItem 切到 workspace agent。库内定位身份
          // (origin_lang/itemId) → 工作台翻译;glossaryStore/critic/TMDB 与手动 CLI 同门接线。
          // adapters 每次 claim 现建(同 find_subtitle 分支口径),fetchSourceSub 防漂移共用。
          const adapters = await buildAdapters(emitProviderEvent)
          const fetchSourceSub = makeRealFetchSourceSub(db, adapters, emitProviderEvent)
          const runItem = makeDaemonTranslateRunItem({
            db, cfg, fetchSourceSub, tmdb, roots: currentRoots,
          })
          await runTranslateWorkerTask(job, {
            runItem,
            requestIngest: () => {
              void ingestTrigger().catch((e) => log(`warn: translate 后踢一脚扫描失败（下一个自然周期还会再扫一次）: ${String(e)}`))
            },
            runs,
          }, jobs, () => Date.now())
        }
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
    // E AI 翻译:派活双门——①显式 TRANSLATE_* 三件套(部署层)②settings.ai_translate_enabled==='true'
    // (行为级开关,默认关)。**每 tick 惰性求值**(同 scan_interval_ms 的债务D5 口径):设置页改完
    // 下一 tick 生效,不用重启守护进程;TRANSLATE_* 缺席时 tryAutoTranslateCfg()=null 同样按 tick 现取。
    // 派活纯机械(SQL 筛候选 + 幂等 upsert,无 LLM);worker claim 端仍只认 TRANSLATE_*(开关只断派活,
    // 存量行不受影响)。失败只记一行 warn 不炸 tick。
    dispatchTranslate: () => {
      if (tryAutoTranslateCfg() && settingsRepo.get('ai_translate_enabled') === 'true') {
        dispatchTranslateTasks(db, jobs, () => Date.now())
      }
    },
    // DB 审计🔴 耐久运维:周期 wal_checkpoint + 天级 VACUUM INTO 在线备份(留 7 份),
    // 内部时间门控;失败只记日志(运维是增益,不拖主循环)。
    dbMaintenance: (() => {
      const state = makeMaintenanceState()
      return () => runDbMaintenance(db, cacheRoot, state, Date.now(), log)
    })(),
    concurrency: {
      searching: 1,
      downloading: 2,  // 一期由 executor 内部串行，此处预留
      verifying: 2,    // 一期由 executor 内部串行，此处预留
    },
    // 债务D5：改惰性读——行为级 settings.scan_interval_ms 优先于部署级 SCAN_INTERVAL_MS env
    // （同 target_languages 的既有优先级口径），每 tick 求值，设置页改完下一 tick 生效。
    ingestEveryMs: () => Number(settingsRepo.get('scan_interval_ms')) || Number(process.env.SCAN_INTERVAL_MS) || SELF_SCAN_DEFAULT_INTERVAL_MS,
    // 债务D5：trace 保留天数同款惰性读，默认 30 天。
    traceRetentionDays: () => Number(settingsRepo.get('trace_retention_days')) || 30,
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
    // fileURLToPath 而非 .pathname:file:// URL 的 .pathname 会百分号编码(路径含空格/非 ASCII 时
    // `/Users/My Projects/...`→`/Users/My%20Projects/...`),导致 existsSync 找不到 web/dist、SPA 全 404
    // 白屏(docker 固定 /app 无空格碰巧测不出)。fileURLToPath 正确解码成真实文件系统路径。
    const distDir = join(fileURLToPath(new URL('../..', import.meta.url)), 'web', 'dist')
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
      // 验收修复轮一 Task V2：甄别台目录组认领成功后踢一脚扫描（DashboardOpts.requestIngest
      // 注释）——复用上方已经构造好的同一个 ingestTrigger 闭包（daemon 自己的周期 tick 也调它，
      // 见 daemonDeps.ingestTrigger），认领这一刻立即触发一轮，不用等 ingestEveryMs 时间门。
      // fire-and-forget：不 await（不让 POST /api/v2/triage/claim 卡在一整轮扫描后才响应），
      // ingestTrigger() 返回的 promise 若拒绝，在这里兜底记日志，不让未捕获的 rejection 冒到
      // 进程顶层（server.ts 那侧的 try/catch 只兜同步抛错，异步失败必须自己接住）。
      requestIngest: () => {
        void ingestTrigger().catch((e) => log(`warn: 甄别认领后踢一脚扫描失败（下一个自然周期还会再扫一次）: ${String(e)}`))
      },
    })
    if (dashServer.listening) {
      // 鉴权 A4 Task 15：启动播报三态（裸奔告警退役）。DASHBOARD_TOKEN 现在只是 legacy 兼容
      // 输入；是否已建账号由 settings.auth_password_hash 决定。后缀与逐行播报都据这两态给。
      const tokenSet = Boolean(process.env.DASHBOARD_TOKEN)
      const initialized = new SettingsRepo(db).get('auth_password_hash') !== null
      const suffix = tokenSet ? ' (legacy token)' : initialized ? '' : ' (setup pending)'
      console.log(`dashboard on http://0.0.0.0:${dashPort}${suffix}`)
      for (const line of dashboardAuthStartupLines({ tokenSet, initialized })) console.error(line)
    } else {
      log('dashboard server failed to start (port conflict?), continuing without dashboard')
    }
  } else {
    // dashPort=0 有两种来路:未设(用户不要 dashboard,正常)vs 设了但值无效(如 "8o99"→NaN→0,
    // 静默不启动会让用户以为 dashboard 坏了却毫无线索)。区分播报,后者高声告警。
    const raw = process.env.DASHBOARD_PORT
    if (raw && raw.trim() !== '') {
      console.error(`warn: DASHBOARD_PORT="${raw}" 不是有效端口号，dashboard 未启动（设为正整数如 8099 启用，或删除该变量以静默禁用）`)
    } else {
      log('dashboard disabled (DASHBOARD_PORT 未设)')
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
  // 干净退出:关连接(checkpoint 落 WAL)再走,别把未落盘提交交给运气(软路由断电常态)。
  try { db.close() } catch { /* 尽力 */ }
  process.exit(0)
}

async function cmdDoctor() {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const roots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const results: DoctorResult[] = []

  // env 缺失走诊断项（✗ + hint、exit 1），不 requireEnv 急切崩溃（那是 exit 2 的”用法错误”通道）
  // TMDB 排最前:它是 watch/reconcile-all 的硬前置(缺 key 直接拒绝启动),缺它 doctor 必须 ✗ 而非
  // 假装全绿——修复"doctor 通过但 watch 立刻因缺 TMDB_API_KEY 退出"的假信心。
  const tmdbKey = process.env.TMDB_API_KEY
  if (!tmdbKey) {
    results.push({
      name: 'tmdb', ok: false, detail: 'TMDB_API_KEY 未配置（watch/reconcile-all 的硬前置，缺它直接拒绝启动）',
      hint: '获取：https://www.themoviedb.org → 账户设置 → API → 复制 API Key(v3 auth)。墙内环境可配 TMDB_PROXY_URL 或 TMDB_BASE_URL 走反代。',
    })
  } else {
    const tmdb = new TmdbClient({ apiKey: tmdbKey, baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL })
    results.push(await checkTmdb(() => withTimeout(tmdb.search('movie', 'The Matrix', 1999), 10_000, 'TMDB').then(h => h.length)))
  }

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
        const res = await withTimeout(fetch(`${ZIMUKU_BASE}/`, { signal: AbortSignal.timeout(10_000) }), 10_000, 'zimuku')
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
    // R2D-11 同源修正:挂载能力也探"真正生效的" DB 根(mediaRootsForDoctor),而不是 env 种子 roots
    // ——用户若只在 dashboard 加守备目录(MEDIA_ROOTS env 留空),用 env roots 会误报"未配置,跳过",
    // 而 realign 降级阶梯恰恰依赖这些 DB 根的硬链接/大小写能力。与紧邻的 checkMediaRoots 口径对齐。
    const { probeMountCapabilities } = await import('../files/mountCapabilities.js')
    results.push(checkMountCapabilities(mediaRootsForDoctor, probeMountCapabilities))
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

const USAGE = 'usage: subtitle-scout watch | reconcile-all | doctor | translate-item <videoPath> | realign-rollback <archiveDir> | auth reset'

/** 鉴权 A4 Task 15：`subtitle-scout auth reset`——诚实找回密码。删管理员三键回到未初始化态，
 *  下次访问 dashboard 重进创建管理员向导。复用 SUBTITLE_SCOUT_DB / cmdWatch 同一套 db 定位。 */
function cmdAuthReset(): void {
  const dbPath = process.env.SUBTITLE_SCOUT_DB || join(homedir(), '.subtitle-scout', 'scout.db')
  if (!existsSync(dbPath)) {
    console.error(`未找到数据库 ${dbPath}——尚无管理员账号可重置（或先设置 SUBTITLE_SCOUT_DB 指向正确路径）。`)
    process.exit(2)
  }
  const db = openDb(dbPath)
  try {
    new AuthService(new SettingsRepo(db)).reset()
    console.log('已清除管理员凭据。下次访问 dashboard 将重新进入创建管理员向导。')
  } finally {
    db.close()
  }
}

async function main() {
  // strict:false:parseArgs 默认 strict 会对任何未声明的 --flag(含用户本能敲的 --help/-h)抛原始
  // 错误,被顶层 catch 打成栈退出——新用户得到栈而非用法。改宽松解析,自己识别 help,未知子命令走 usage。
  const { positionals } = parseArgs({ allowPositionals: true, strict: false })
  const cmd = positionals[0]
  if (cmd === 'help' || cmd === undefined || process.argv.slice(2).some(a => a === '--help' || a === '-h')) {
    console.log(USAGE)
    process.exit(0)
  }
  if (cmd === 'watch') return cmdWatch()
  if (cmd === 'reconcile-all') return cmdReconcileAll()
  if (cmd === 'doctor') return cmdDoctor()
  if (cmd === 'translate-item' && positionals[1]) return cmdTranslateItem(positionals[1])
  if (cmd === 'realign-rollback' && positionals[1]) return cmdRealignRollback(positionals[1])
  if (cmd === 'auth' && positionals[1] === 'reset') return cmdAuthReset()
  console.error(USAGE)
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
