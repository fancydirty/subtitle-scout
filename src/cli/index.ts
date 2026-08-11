import 'dotenv/config'
import { parseArgs } from 'node:util'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateText, type LanguageModel } from 'ai'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import { type FetchEvent, type FetchAdapter } from '../adapters/fetchLib.js'
import { applyQuotaEvent } from './quotaState.js'
import { gcOrphans } from '../files/stagingSandbox.js'
import { isDirWritable, sweepWriteProbes, type PathMapping } from '../core/mediaContext.js'
import { makeFileLogger } from '../core/fileLogger.js'
import { startDashboard } from '../dashboard/server.js'
import { ScoutEventBus } from '../core/scoutEvents.js'
import { AuthService } from '../dashboard/auth.js'
import { makeModel } from '../agent/llm.js'
import { cmdTranslateItem, tryAutoTranslateCfg, makeDaemonTranslateRunItem } from './translateItemCommand.js'
import { makeRealFetchSourceSub } from './fetchSourceSub.js'
import { runTranslateWorkerTask } from '../v2/translateWorkerTask.js'
import {
  checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkTmdb, checkMediaRoots,
  checkDatabase, checkStuckJobs, checkMountCapabilities, checkJimaku, checkSubhd,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { ZIMUKU_BASE } from '../adapters/providers/zimuku.js'
import { JimakuClient } from '../adapters/providers/jimaku.js'
import { curlFetch, SUBHD_BASE } from '../adapters/providers/subhd.js'
import { makeAdapterConfigResolver, envOnlyAdapterConfig, SECRET_NAMES, type AdapterConfigResolver } from '../v2/secrets.js'
import { setupSatisfied, workPermitted, makeSecretsWatcher, makeSatisfactionTracker, type ClientsHolder } from './watchClients.js'
import { openDb } from '../v2/db.js'
import { JobsRepo, type Job } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { makeMaintenanceState, runDbMaintenance } from '../v2/dbMaintenance.js'
import { SubtitleVerifyRepo } from '../v2/subtitleVerifyRepo.js'
import { verifyAndRecord } from '../subtitleVerify/verifySubtitle.js'
import { runVerifySweep } from '../subtitleVerify/verifySweep.js'
import { makeIngestPass, type IngestResult } from '../v2/ingest.js'
import { ScoutDaemonV2 } from '../v2/daemonV2.js'
import { buildDaemonV2Deps } from './watchWiring.js'
import { runIdentify } from '../agent/identifyWorker.js'
import type { IdentifySchedulerDeps } from '../v2/identifyScheduler.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'

import { fetchAnimeListsTable } from '../adapters/providers/animeLists.js'
import { makeRealignRunEpisode, type RealignExecutorDeps } from '../v2/realignExecutor.js'
import { makeRealignLibraryPort } from '../v2/realignLibraryPort.js'
import { replayRollback } from '../files/realignManifest.js'
import { runRealignWorkerTask } from '../v2/realignWorkerTask.js'
import { runFindSubtitleWorkerTask } from '../v2/findSubtitleWorkerTask.js'
import {
  makeUnidentifiedFindSubtitleWorker, runUnidentifiedFindSubtitleWorkerTask,
} from './unidentifiedFindSubtitle.js'
// (import removed - see comment above)
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { buildAdapters } from '../adapters/buildAdapters.js'
import { resolveTargetLanguages } from './targetLanguages.js'
import { identifyFromPath } from '../recognition/identifyFromPath.js'
import { makeIngestTrigger } from '../daemon/ingestTrigger.js'
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'
import { dashboardAuthStartupLines } from './dashboardTokenWarning.js'
import { zeroRootsWarningLine, rootsMismatchWarningLine, zeroSubtitleSourcesWarningLine, setupModeWarningLine, nestedRootSkipWarning, existingNestedRootsWarning } from './watchStartupWarnings.js'
import type { ReconcileAllResultDTO } from '../dashboard/apiV2.js'

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`missing required env var: ${name}`); process.exit(2) }
  return v
}

/** 进程级长命客户端的组装产物。setup 模式（spec A §4.7）：LLM/TMDB 任一不可解析 → 对应字段
 *  null + 一行 warn，**不再 exit**——硬性要求上提到门禁层（cmdWatch setup 闸 /
 *  cmdReconcileAll 双钥匙门），由它们决定"拒启动"还是"gated 存活"。
 *  （cacheRoot/mappings 两键的既有注释逐字保留，此处不重抄。） */
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
   *  makeModel() 建一个 LanguageModel 实例（setup 模式下 LLM 未配置 → null）。 */
  reasoningModel: LanguageModel | null
}

async function assemble(cfg: AdapterConfigResolver, warn: (msg: string) => void): Promise<Assembled> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  // 去 Jellyfin 化 P7：MEDIA_PATH_MAPPINGS 不再读取——mediaRoots() 的唯一根来源是 MEDIA_ROOTS
  // 环境变量（见下方）；mappings 恒为空数组，realign port 以 identity 操作消费它（D2）。
  const mappings: PathMapping[] = []
  // LLM_EXTRA_BODY 维持 env-only 高级项（spec §12 明确不收进 wizard）。**畸形 JSON 维持
  // exit 2**——缺的放行、错的照死：显式写错的部署配置不是 setup 模式要救的"缺 key"，
  // 行为与今天逐字一致。
  let extraBody: Record<string, unknown> | undefined
  if (process.env.LLM_EXTRA_BODY) {
    try { extraBody = JSON.parse(process.env.LLM_EXTRA_BODY) } catch {
      console.error(`LLM_EXTRA_BODY is not valid JSON: ${process.env.LLM_EXTRA_BODY}`)
      process.exit(2)
    }
  }
  const llmBaseUrl = cfg.secret('LLM_BASE_URL').value
  const llmApiKey = cfg.secret('LLM_API_KEY').value
  const llmModelName = cfg.secret('LLM_MODEL').value
  const reasoningModel = (llmBaseUrl && llmApiKey && llmModelName)
    ? makeModel({ baseUrl: llmBaseUrl, apiKey: llmApiKey, model: llmModelName, extraBody })
    : null
  if (!reasoningModel) warn('LLM is not fully configured (env or dashboard) — reasoning work stays gated until setup completes')
  const tmdbKey = cfg.secret('TMDB_API_KEY').value
  const tmdb = tmdbKey
    ? new TmdbClient({ apiKey: tmdbKey, baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL })
    : null
  if (!tmdb) warn('TMDB_API_KEY is not configured (env or dashboard) — engine stays gated until setup completes')
  return { cacheRoot, mappings, tmdb, reasoningModel }
}

/** 去 Jellyfin 化 T4：cmdWatch 与 cmdReconcileAll 共用的摄取 pass 组装——recognize 是纯路径结构
 *  解析 identifyFromPath（同步，无 TMDB/override 查询；身份裁决已上移到 agent 的
 *  write_identified_media，ingest 只落 raw data 等 agent 识别，见 v2/ingest.ts 的
 *  IngestDeps.recognize 注释），probe 绑定 ffprobe 探针（files/streamProbe.ts）。
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
    recognize: (videoPath: string) => identifyFromPath(videoPath),
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
 *  TMDB_API_KEY 与 LLM 三件套是硬性前置（spec A §4.7 步 6，env 或库皆可）——不同于 cmdWatch 里 realign 那种"没配置就静默
 *  跳过"（那是给日常 watch 循环的容错，缺检测能力不该拦住找字幕主线）：orchestrator 的
 *  check_series_layout 工具需要真实 TmdbClient 才能判断"季数是否超出 TMDB 季表"，摄取层本身
 *  也需要真实 TmdbClient 才能识别文件——手动触发的全仓校验若因为缺 key 而悄悄只做一半，
 *  会让使用者误以为已经跑过完整校验——所以这里直接报错退出，同 requireEnv 的硬依赖语义一致。 */
// cmdReconcileAll 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）


async function cmdWatch() {
  // R8-1：进程启动时间——gcOrphans 的两条保留条件之一（① mtime 新于 bootTime 的"新建未写"工作台
  // ② 最近 10 分钟内有写入的活跃工作台），两者任一满足就不清，避免误删并发 CLI 正在用的工作台。
  const bootTimeMs = Date.now()
  // 去 Jellyfin 化 P5/Task 7：realign port 已切到库原生实现（makeRealignLibraryPort，下方），
  // assemble() 不再持有任何 jf/jellyfinClient 句柄；P7 起 JELLYFIN_URL/JELLYFIN_API_KEY 的
  // requireEnv 已一并删除（design §P7 代码出口）。
  const shutdown = new AbortController()

  // spec A §4.7：openDb 必须先于 assemble——cfg 的 dbGet 要读 settings 表。cacheRoot 不依赖
  // 任何密钥（与 assemble 内同一表达式），这里先算一份给 fileLog/openDb。
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const fileLog = makeFileLogger(join(cacheRoot, 'logs'), Number(process.env.LOG_RETAIN_DAYS) || 30)
  const log = (msg: string) => {
    const line = `[watch ${new Date().toISOString()}] ${msg}`
    console.log(line)
    fileLog(msg)
  }
  const warn = (msg: string) => log(`warn: ${msg}`)

  // Open v2 database
  const dbPath = join(cacheRoot, 'scout.db')
  const db = openDb(dbPath)
  const jobs = new JobsRepo(db)
  const lib = new LibraryRepo(db)
  const runs = new RunsRepo(db)
  // 字幕校验巡检（Task 6）的持久层。dashboard 那侧（server.ts）自己也建一个实例——两者
  // 无状态（只包一个 db 引用），共享同一个 sqlite 连接，各建一个与共用一个等价。
  // 2026-08-07（spec §5）：巡检注入本轮雪藏（承载它的 daemonDeps 字面量已于第 7 步 B 组删除，
  // 雪藏状态不变——daemonV2 侧从未有过 verifySweep 字段），这个实例
  // 目前只剩"恢复注入时现成可用"的意义——按用户裁决不删。
  const verifyRepo = new SubtitleVerifyRepo(db)

  // dashboard G4：守备目录 DB 化——spec 裁决照抄 Jellyfin 分界：挂载是部署层（compose volume），
  // 守备目录是产品层（media_roots 表，dashboard 里增删）。MEDIA_ROOTS env 降级为首启种子值：
  // 只在 media_roots 表为空时生效一次（seedRootsFromEnv 的既有幂等语义），此后 DB 是唯一真相。
  // currentRoots 是惰性提供者，每次调用都重新查表——这是本任务的关键属性："dashboard 里加根后
  // ingest 下一轮就能扫到"要求 roots 不能是这里冻结的一份静态数组快照。下面把它传给
  // ingestPass；handleWorkerTask 的 realign/find_subtitle 分支也各自在派发时重新调用它，
  // 不复用一份旧闭包捕获的数组（见各自分支的注释）。
  const settingsRepo = new SettingsRepo(db)
  // F2（2026-08-08）：同上，先归一化存量非规范根，再 seed。
  settingsRepo.normalizeRoots()
  // D7（2026-08-08）：同上，种子过嵌套闸门 + 绝对路径门，跳过的要让运维看见。
  for (const r of settingsRepo.seedRootsFromEnv(process.env.MEDIA_ROOTS, Date.now()).rejected) {
    console.warn(nestedRootSkipWarning(r))
  }
  const currentRoots = (): string[] => settingsRepo.listRoots().map(r => r.path)
  // D7 附加（2026-08-08）：存量嵌套根告警。放在 normalizeRoots + seed 之后——非规范形态
  // 归一化前会因 '//' 拼接漏检（F1 同一漏洞面）。程序不擅自删用户的配置，只点名报出来。
  const nestedWarning = existingNestedRootsWarning(settingsRepo.detectNestedRoots())
  if (nestedWarning) console.warn(nestedWarning)
  if (currentRoots().length === 0) {
    console.log(zeroRootsWarningLine())
  } else {
    const envRoots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const dbRoots = currentRoots()
    const warning = rootsMismatchWarningLine(envRoots, dbRoots)
    if (warning) console.warn(warning)
  }

  // spec A §4.3：密钥解析器——env 优先、库兜底，dbGet 惰性读库（每 tick/每重建都是新鲜值）。
  const cfg = makeAdapterConfigResolver(process.env, (k) => settingsRepo.get(k))

  // 语言/识别配置的解析
  // A4: TARGET_LANGUAGES (comma-separated, default 'zh') + legacy SKIP_CHINESE_ORIGIN compat.
  // Two lists: targetLanguages = coverage/hunting targets; originSkipLanguages = origin-audio
  // languages that suppress an item — see targetLanguages.ts's resolveTargetLanguages for the
  // exact mapping (locked by targetLanguages.test.ts).
  // dashboard G4：settings.target_languages（行为级设置）优先于部署层的 TARGET_LANGUAGES env
  // ——见 resolveTargetLanguages 第二参的文档注释；本战役唯一被真正消费的行为键。
  // 债务D5：语言配置提供者——settings 行为级 > env 部署级的求值挪进闭包，每次消费新鲜读。
  const { targetLanguages } = resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))
  const languagesNow = () => resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))

  // provider 事件 → 日志（find-subtitle worker 用，v3 phase ⑦）：这条新链路没有旧管线的
  // 逐 job Journal（老管线的 journalStore/withJournal 已随 Wave 2D 一并删除），api_call 量大信号
  // 低，只把 error/notice 落一行 log。
  // 提到 buildCurrent 之前（holder 化后 realign adapters 在 buildCurrent 里组装，需要同一个 emit
  // 函数，且 const 不能被前向引用）。
  // R-F10：全站唯一那条 SSE 通道的事件总线。**一个实例、两个消费方**——daemon 产
  // （buildDaemonV2Deps 的 emit），dashboard 推给浏览器（startDashboard 的 events）。
  //
  // 建在这里（dashboard 启动之前、daemon 组装之前）是刚性的：两者都在本函数里构造，
  // 谁先建都行但必须**是同一个实例**。只喂一头是本仓栽过 6 次的那个静默形态——有产无收
  // （daemon 发了没人推）或有收无产（端点在但永远没数据），两者在界面上都只是"很安静"。
  // 守卫在 watchWiring.test.ts 的源码断言（它按 `scoutEvents` 这个符号名定位这两处接线）。
  const scoutEvents = new ScoutEventBus()

  const emitProviderEvent = (e: FetchEvent) => {
    applyQuotaEvent(e, settingsRepo, Date.now())
    if (e.event === 'provider_error') log(`find-subtitle worker: provider error (${e.provider}): ${e.message}`)
    else if (e.event === 'provider_notice') log(`find-subtitle worker: provider notice (${e.provider}): ${e.message}`)
  }

  // spec A §4.2：一切由密钥派生的长命客户端收进 holder，secrets_version 变化时整体重建换
  // current——wizard 落库 → 同进程点火，容器零重启。消费方一律经 clients.current 现取。
  interface WatchClients {
    mappings: PathMapping[]
    tmdb: TmdbClient | null
    reasoningModel: LanguageModel | null
    /** realign 字幕先行的长驻 adapters（既有注释：同一次 executeRealign 内几十集
     *  紧凑循环，重建只有 Zimuku session 重读盘的开销——故随 holder 代际重建，不 per-claim）。 */
    realignAdapters: FetchAdapter[]
    /** tmdb 缺席 → null（闸保证不会被调用，null 只是结构性的，spec §4.7 步 5）。 */
    ingestPass: (() => Promise<IngestResult>) | null
    /** !tmdb || !reasoningModel → null。 */
    realignDeps: RealignExecutorDeps | null
    findSubtitleWorkerTaskDeps: {
      lib: LibraryRepo; tmdb: TmdbClient; mediaRoots: string[]; targetLanguage: string; runs: RunsRepo
    } | null
    // orchestrateWorkerTaskDeps 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）
    // reconcileAll 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）
    /** 第 2 步（C2）：daemonV2 的识别工作台 deps；!tmdb || !model → null（闸住时不会被调）。 */
    identifyDeps: IdentifySchedulerDeps | null
    /** 第 2 步（C2）：daemonV2 的字幕工作台执行体；!model → null。 */
    subtitleWorkerV2: ((task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>) | null

  }

  /** setup 模式下的 ingest 兜底空实现（spec §4.7：闸保证它实际不会被调到——bootIngestPending
   *  在 setup 期间一直被闸住；它只是让 ingestTrigger/requestIngest 的类型与形状闭合）。 */
  const EMPTY_INGEST_RESULT: IngestResult = { scanned: 0, upserted: 0, parked: 0, removed: 0, changed: false }

  /** setup 模式下 daemonV2 两条工作台的兜底空实现（同 EMPTY_INGEST_RESULT 的既有语义：
   *  workPermitted 恒 false 把整轮巡检闸住，这两个实际不会被调到；它们只让类型闭合）。
   *
   *  为什么不在这里 throw：§4.7 步 5 的既有口径是"闸住 ≠ 崩"。setup 模式下 dashboard 必须
   *  可达（wizard 就在那儿），一个抛错的工作台会把 daemon 主循环打成失败退避，用户连配密钥的
   *  界面都进不去。空 report 的语义也刚好正确——"这一轮什么也没做"。 */
  const EMPTY_IDENTIFY_DEPS: IdentifySchedulerDeps = {
    db,
    runIdentify: async () => ({ tmdbId: null, title: null, reason: 'setup incomplete — engine is gated' }),
    worker: { model: null as unknown as LanguageModel, tmdb: { search: async () => [], getDetails: async () => null } },
  }
  const EMPTY_SUBTITLE_REPORT: FindSubtitleBatchReport = {
    installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
  }


  const buildCurrent = async (): Promise<WatchClients> => {
    const { mappings, tmdb, reasoningModel } = await assemble(cfg, warn)
    const satisfied = tmdb !== null && reasoningModel !== null
    const realignAdapters = await buildAdapters(emitProviderEvent, cfg, warn)
    const ingestPass = tmdb
      ? buildIngestPass({
          roots: currentRoots, lib, tmdb,
          targetLanguages: () => languagesNow().targetLanguages,
          originSkipLanguages: () => languagesNow().originSkipLanguages,
          excludeExtras: () => settingsRepo.get('exclude_extras') === 'true',
          hardsubMode: () => {
            const v = settingsRepo.get('hardsub_mode')
            return v === 'agent' || v === 'aggressive' ? v : 'off'
          },
          log,
        })
      : null
    const realignRunEpisode = satisfied
      ? makeRealignRunEpisode({
          runFindSubtitleTask: makeFindSubtitleWorker({
            model: reasoningModel,
            adapters: realignAdapters,
            cacheRoot,
            tmdb,
          }),
          // 债务D5 注记（修订）：targetLanguage 随 holder 代际新鲜求值（secrets 变更驱动重建），
          // 仍非 per-task 新鲜——改语言后下轮 ingest 自然生效，realign 这条路径要等下一次重建。
          targetLanguage: languagesNow().targetLanguages[0],
          mediaRoots: currentRoots(),
        })
      : null
    const realignDeps: RealignExecutorDeps | null = (satisfied && ingestPass && realignRunEpisode)
      ? {
          lib, jobs,
          jf: makeRealignLibraryPort({ lib, roots: currentRoots(), runIngest: ingestPass }),
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
          mediaRoots: currentRoots(),
          mappings,
        }
      : null
    const findSubtitleWorkerTaskDeps = satisfied
      ? { lib, tmdb, mediaRoots: currentRoots(), targetLanguage: languagesNow().targetLanguages[0], runs }
      : null
    // 第 2 步（C2）：daemonV2 的两条工作台执行体。跟着 holder 一起换代——密钥落库后
    // preTick 重建，daemon 下一拍就拿到能用的客户端（getter 注入见 watchWiring.ts）。
    //
    // identify 的 tmdb 适配是把 TmdbClient 的四个方法拼成 IdentifyWorkerDeps 要的那一个
    // getDetails（详情 + 中文标题 + 原始语言）。origin_lang 必须在这里落库：R21 的
    // translatable 预判、D9 的日漫内嵌轨判定都以它为前提。
    const identifyDeps: IdentifySchedulerDeps | null = (satisfied && tmdb && reasoningModel)
      ? {
          db,
          runIdentify,
          worker: {
            model: reasoningModel,
            tmdb: {
              search: (mt, q, y) => tmdb.search(mt, q, y),
              getDetails: async (mt, id) => {
                const d = await tmdb.getDetails(mt, id)
                if (!d) return null
                // 中文标题与原始语言是**增益**（catch 兜住）：TMDB 的这两个副接口挂掉不该让
                // 整次识别失败——身份认定只依赖 getDetails 本体（同 tmdbCatalog 的既有口径）。
                const chinese = await tmdb.getChineseTitles(mt, id).catch(() => [])
                const ol = await tmdb.getOriginLanguage(mt, id).catch(() => null)
                return {
                  id: Number(id), title: d.title || d.originalTitle || String(id),
                  originalTitle: d.originalTitle ?? null, year: d.year, overview: d.overview,
                  posterPath: d.posterPath, genreIds: d.genreIds,
                  // v42 / R-F13 接线：横版背景图。TmdbClient.getDetails 早就在解析
                  // backdrop_path（tmdb.ts:325，v16 详情页重设计时加的），此前在**这一行**
                  // 被丢弃 → works.backdrop_path 无论加不加列都恒 NULL。
                  //
                  // **这一行不接，本 task 的两个写入点就同时是装饰品**（写入点①
                  // identifyScheduler、写入点② daemonV2.backfillBackdropPaths 都从这个
                  // 适配器取值）——同 C5 那一行的既有教训：deps 上它是 optional，
                  // 漏接线是**静默**的，界面上只表现为活动页永远退化成模糊海报，没有报错。
                  backdropPath: d.backdropPath,
                  originLanguage: ol, chineseTitles: chinese,
                }
              },
              // C5 接线：采真 imdb 落 works.provider_ids。**这一行不接就是本仓第五次同型缺陷**
              // （写了列却没人写值）——deps 上它是 optional（几十个既有构造点的编译成本），
              // 故生产漏接线是静默的：抓源腿照旧退化成文本 query，界面上什么都看不出来。
              // 不加 catch：identifyScheduler 内部已经把这次调用整个 try 住并退化成
              // provider_ids=null（留给回填 pass 重试）。在这里再兜一层会把"失败"伪装成
              // "TMDB 确认没有"，那一行从此永久收敛、永不重试。
              getExternalIds: (mt, id) => tmdb.getExternalIds(mt, id),
              // R-F5 接线：季集表采集，供 daemonV2.backfillSeasonCatalog 把 TMDB 应有集写进
              // tmdb_seasons（媒体库页虚线小卡片的数据来源）。**与上一行同一个坑的第六次**：
              // deps 上它是 optional，漏接线时回填 pass 整支静默休眠（探针缺席不动列），
              // 界面上只表现为"虚线一根都不画"，没有任何报错。
              //
              // 不加 catch，理由同上一行但机制不同：refreshSeriesCatalog 内部已按 gain-path
              // 降级（任一季拿不到就原样返回、旧缓存纹丝不动、一行不落）。在这里兜一层返回
              // 空数组，会把"没抓到"伪装成"这剧确实零季"→ 媒体库页把它读成 0 集。
              getSeasonTable: (id) => tmdb.getSeasonTable(id),
              getSeasonEpisodes: (id, season) => tmdb.getSeasonEpisodes(id, season),
            },
          },
        }
      : null
    // 字幕 worker：与旧管线 find_subtitle 分支同门（makeFindSubtitleWorker），adapters 用
    // holder 代际那一份 realignAdapters——**不 per-task 重建**。新架构里一轮巡检会连着跑几十个
    // 作品，每个作品重建一整套 provider adapters（含 Zimuku 的 session 重读盘）纯属白付。
    const subtitleWorkerV2 = (satisfied && reasoningModel)
      ? makeFindSubtitleWorker({ model: reasoningModel, adapters: realignAdapters, cacheRoot, tmdb })
      : null

    // orchestrateWorkerTaskDeps 已删（第 5.5 步）
    // reconcileAll 已删（第 5.5 步）
    return {
      mappings, tmdb, reasoningModel, realignAdapters, ingestPass,
      realignDeps, findSubtitleWorkerTaskDeps,
      identifyDeps, subtitleWorkerV2,
    }
  }

  const clients: ClientsHolder<WatchClients> = { current: await buildCurrent() }

  // spec A §4.2：ingest pass 经 holder 现取——setup 模式下 ingestPass 为 null，注入兜底空
  // 实现（workPermitted 闸保证它实际不会被调到）；点火后同一闭包自然吃到新 pass。
  const ingestTrigger = makeIngestTrigger({
    ingest: () => clients.current.ingestPass?.() ?? Promise.resolve(EMPTY_INGEST_RESULT),
    jobs, now: () => Date.now(), log,
  })

  // ⚠️ 第 7 步 B 组的实测发现：**这个函数在生产已无调用者**，但刻意保留、不在本组删除。
  //
  // 事实链（可复核）：它唯一的调用点是原 `daemonDeps.executeJob` 闭包；`executeJob` 唯一的
  // 消费者是 `ScoutDaemon.dispatch()`；而 ScoutDaemon 自第 2 步起就不再被构造（生产唯一入口
  // cmdWatch 构造的是 ScoutDaemonV2），本组已把 ScoutDaemon 与 src/v2/daemon.ts 整体删除。
  // 连带事实：`jobs.claimNext()` 在删除后**生产零调用点**——ScoutDaemon.dispatch 是它唯一的
  // 非测试调用者。也就是说 jobs 队列现在只有生产者（dashboard 的 redispatch、
  // dispatchTranslateTasks、各 upsertWorkerTask），没有任何消费者。
  //
  // 为什么本组不删它：这不是"B 组把它弄死的"，而是第 2 步切换入口那一刻就已经死了、B 组只是
  // 让它显形。删它会连带拖走 runFindSubtitleWorkerTask / runRealignWorkerTask /
  // runTranslateWorkerTask / runUnidentifiedFindSubtitleWorkerTask 四条 worker_task 执行路径、
  // JobsRepo 的整套 claim/租约/reap 机制，以及 dashboard 上仍在写 jobs 行的 redispatch 端点
  // ——那是"旧 jobs 队列整体退役"这个独立决策，涉及产品语义（dashboard 的手动重派按钮是否
  // 还有意义），不是一次纯结构清理能顺手带走的。本组的硬性约束是"ScoutDaemonV2 行为一个
  // 字节都不能变"，故只报告、不动手。
  //
  // 关于"零调用者"这个事实如何被承载：**只由本注释承载**。本仓当前**未开启**
  // `--noUnusedLocals`（tsconfig 里没有它），所以编译器今天对此完全沉默；开启那天，
  // 它会与 `cli/index.ts` 已有的六处未读局部/未读 import 一同显形——`:40` verifyAndRecord、
  // `:41` runVerifySweep、`:67` ReconcileAllResultDTO、`:69` requireEnv、`:204` verifyRepo、
  // `:245` targetLanguages（六处全部先于本组存在）。刻意**不写** `void handleWorkerTask`：
  // 那一行的实际效果是把本函数从"开启那天自动进入待处理清单"里主动豁免出去，成为七个孤儿
  // 里唯一被特殊对待的一个——与本注释想要的"让事实显形"恰好相反。
  //
  // ── 以下是它原有的设计注释，退役决策做出前原样保留 ──
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
    let payload: { taskType?: unknown; scope?: unknown } = {}
    try {
      payload = JSON.parse(job.payload ?? '{}')
    } catch {
      jobs.completeError(job.id, `worker_task job ${job.id} has unparseable payload: ${job.payload}`, Date.now())
      return
    }
    const c = clients.current
    if (!c.tmdb || !c.reasoningModel) {
      // spec §4.7 步 5：闸全关保证不会有工作流到这里——这行只在"任务在飞、密钥被并发
      // 删空"的竞态下可达。不断言、不崩，失败退避留可诊断痕迹（同下方组装兜底的既有口径）。
      jobs.completeError(job.id, 'setup incomplete — engine is gated (secrets removed mid-flight?)', Date.now())
      return
    }
    try {
      if (payload.taskType === 'find_subtitle') {
        if (payload.scope === 'unidentified') {
          // 管线拆分（2026-07-28 事故裁决：424 写库/7 搜索/384 编造/242 假 unavailable——
          // 识别归识别，找字幕归找字幕，DB 为状态机）：scope='unidentified' 的 find_subtitle
          // 行从此是**识别专用** job。从 parked_paths 读 raw data（duration_sec/embedded_langs）
          // + identifyFromPath 结构提示建 targets（批次上限 60，最久 parked 先上）；worker 是
          // identifyOnly 形态（只挂识别工具，字幕工具零挂载）——识别结果由
          // write_identified_media 落库为 sub_status=missing 的库行，找字幕由既有库行管线
          // （orchestrator 见 missing → 派 per-series worker）接手。不再 buildAdapters：
          // 识别 run 用不到任何字幕 provider，省掉整套 provider 组装。
          // runner 与类型细节见 cli/unidentifiedFindSubtitle.ts。
          const runTask = makeUnidentifiedFindSubtitleWorker({
            model: c.reasoningModel,
            cacheRoot,
            tmdb: c.tmdb,
            lib,
            // 作品单元管线（spec 2026-08-07 §4）：识别 job 的步数上限从共享兜底 500 提到 2000。
            // 一个作品单元现在可能带整部剧的全部集数（§3.2 的分组收益），按 5 步/文件估算，
            // MAX_TARGETS_PER_JOB=60 的批次约 300 步，2000 留足余量。
            // 🔴 必须在这里显式传，绝不改 findSubtitleWorker.ts 的 `deps.stepCap ?? 500`——
            // 那是识别与字幕两个 scope 共享的兜底，改它会把库行 scope 的字幕 worker 一起放开，
            // 那是不同的活（审计 M10）。2000 不是无限：无限意味着一个死循环 agent 能烧到配额见底。
            stepCap: 2000,
          })
          // dashboard G4 / 债务D5：mediaRoots/targetLanguage/hardsubMode 每次派发新鲜读取——
          // 同下方库行分支的既有口径，不锁定 watch 启动时刻的快照。
          await runUnidentifiedFindSubtitleWorkerTask(
            job, {
              lib, mediaRoots: currentRoots(),
              targetLanguage: languagesNow().targetLanguages[0],
              hardsubMode: (() => {
                const v = settingsRepo.get('hardsub_mode')
                return v === 'agent' || v === 'aggressive' ? v : 'off'
              })(),
              runTask, runs,
            }, jobs, () => Date.now(),
          )
          return
        }
        // spec §4.7 步 5：holder 代际内 tmdb/model 由 10-6 护栏收窄非空，deps 的可空性由 buildCurrent
        // 的同一 satisfied 条件决定——护栏通过后 deps 必非空，这里的兜底只为不让 TS 撒谎。
        const fsDeps = c.findSubtitleWorkerTaskDeps
        if (!fsDeps) { jobs.completeError(job.id, 'setup incomplete — engine is gated', Date.now()); return }
        const runTask = makeFindSubtitleWorker({
          model: c.reasoningModel,
          adapters: await buildAdapters(emitProviderEvent, cfg, warn),
          cacheRoot,
          // 路 A：Step 0 识别验证的证据源（同 realignRunEpisode 处的注释——holder 代际内 tmdb 非空）。
          tmdb: c.tmdb,
        })
        // dashboard G4：mediaRoots 在每次派发时用新鲜的 currentRoots() 覆写——POST 加根后不需要
        // 重启 watch 进程，下一个被 claim 的 find_subtitle 行就能写进新根（否则 outer 沙盒检查
        // assertDirSafe 会一直拿着 watch 启动那一刻的旧白名单，新根永远进不来）。
        // 债务D5：targetLanguage 同 mediaRoots 在每次派发时新鲜读取——设置页改 target_languages
        // 后被 claim 的 find_subtitle 任务立即生效。
        await runFindSubtitleWorkerTask(
          job, {
            ...fsDeps, mediaRoots: currentRoots(),
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
        // spec §4.7 步 5：realignDeps 的非空由 buildCurrent 的 satisfied 条件决定（holder 代际内），
        // 10-6 护栏已收窄 tmdb/model——这里的兜底只为 TS 类型闭合，护栏通过后 rDeps 必非空。
        // 退役T1 (W0-3a): thread the same RunsRepo instance into the realign runner too — see
        // the comment on findSubtitleWorkerTaskDeps above for the why.
        // dashboard G4：同 find_subtitle 分支——mediaRoots + jf（realign port 内部按 roots 走盘/
        // 列虚拟库）都用新鲜的 currentRoots() 重建，不复用 cmdWatch 启动时刻构造的旧闭包。
        const rDeps = c.realignDeps
        if (!rDeps) { jobs.completeError(job.id, 'setup incomplete — engine is gated', Date.now()); return }
        const roots = currentRoots()
        await runRealignWorkerTask(job, {
          ...rDeps, runs,
          mediaRoots: roots,
          jf: makeRealignLibraryPort({ lib, roots, runIngest: c.ingestPass ?? (() => Promise.resolve(EMPTY_INGEST_RESULT)) }),
        }, jobs, () => Date.now())
      } else if (payload.taskType === 'translate') {
        // E AI 翻译:daemon 自动翻一个可译候选。**双重 env 门控**——tryAutoTranslateCfg 只认显式
        // TRANSLATE_* 三件套(绝不回退 LLM_*=mimo 烧配额),不全则拒跑走 completeError(等用户配齐;
        // 与 dispatch 侧门控对称,即便有残留 translate 行也不会误用弱模型)。deps 与手动 CLI 共用
        // makeDaemonTranslateRunItem→makeTranslateAgentDeps(workspace agent 主路径)防漂移。
        const translateCfg = tryAutoTranslateCfg(cfg)
        if (!translateCfg) {
          jobs.completeError(job.id, 'translate 未启用:需配 TRANSLATE_MODEL/TRANSLATE_BASE_URL/TRANSLATE_API_KEY 三件套', Date.now())
        } else {
          // P3:translate 分支从 legacy translateItem 切到 workspace agent。库内定位身份
          // (origin_lang/itemId) → 工作台翻译;glossaryStore/critic/TMDB 与手动 CLI 同门接线。
          // adapters 每次 claim 现建(同 find_subtitle 分支口径),fetchSourceSub 防漂移共用。
          // translateCfg 是 tryAutoTranslateCfg(cfg) 的返回值（专用翻译三凭证），与外层
          // AdapterConfigResolver 同名 cfg 不再遮蔽——重命名为 translateCfg 消除歧义。
          const adapters = await buildAdapters(emitProviderEvent)
          const fetchSourceSub = makeRealFetchSourceSub(db, adapters, emitProviderEvent)
          const runItem = makeDaemonTranslateRunItem({
            db, cfg: translateCfg, fetchSourceSub, tmdb: c.tmdb, roots: currentRoots,
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
  // 到此为止：本函数生产零调用者，保留是刻意的——事实链、退役归属与"为什么不写
  // `void handleWorkerTask`"全部见上方头注释。

  // Dashboard v2（媒体库 API，读 v2 SQLite；海报直出 TMDB CDN，不再走服务端代理）
  // spec A §4.7 步 1：dashboard 先于门禁评估与 worker 装配启动——顺序即语义，容器健康检查
  // 从此在零 key 首启下也转绿，bootstrap wizard 在密钥落库前就可达。
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
      // reconcileAll 已删（第 5.5 步）
      // dashboard G5：POST /api/v2/workflow/redispatch（人类扳手）依赖真实 JobsRepo（jobs 在上方
      // 无条件构造，直接传）。tmdb/reconcileAll 改 getter 注入（spec A §4.2 holder 覆盖 dashboard
      // 注入面）——setup 模式下现取现得 null，端点照既有降级先例 503/跳过。
      jobs,
      tmdb: () => clients.current.tmdb,
      cacheRoot,
      setupDeps: {
        env: process.env,
        settingsRepo,
        cacheRoot,
        // SettingsRepo 上的方法名是 listRoots（不是 listMediaRoots）——见 src/v2/settingsRepo.ts:59。
        rootsCount: () => settingsRepo.listRoots().length,
        now: () => Date.now(),
      },
      // 验收修复轮一 Task V2：甄别台目录组认领成功后踢一脚扫描（DashboardOpts.requestIngest
      // 注释）——复用上方已经构造好的同一个 ingestTrigger 闭包（daemonV2 的翻译流装盘后也调它，
      // 见下方 requestIngest），认领这一刻立即触发一轮，不用等下一轮自然巡检。
      // fire-and-forget：不 await（不让 POST /api/v2/triage/claim 卡在一整轮扫描后才响应），
      // ingestTrigger() 返回的 promise 若拒绝，在这里兜底记日志，不让未捕获的 rejection 冒到
      // 进程顶层（server.ts 那侧的 try/catch 只兜同步抛错，异步失败必须自己接住）。
      requestIngest: () => {
        void ingestTrigger().catch((e) => log(`warn: 甄别认领后踢一脚扫描失败（下一个自然周期还会再扫一次）: ${String(e)}`))
      },
      // R-F10：SSE 通道的消费端（GET /api/v2/events）。与下方 daemon 的 emit 是同一个实例。
      events: scoutEvents,
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

  // spec A §4.7 步 2：setup 模式不 exit——dashboard 已起，引擎闸全关，日志里留唯一路标。
  if (!setupSatisfied(cfg)) console.warn(setupModeWarningLine())

  // spec A §4.2：secrets_version watcher（daemon preTick 每 tick 比对）与点火日志追踪，二者在
  // daemonV2 接线之前定义——rebuild 整体换 clients.current，satisfaction tracker 记 engine live。
  const secretsWatcher = makeSecretsWatcher({
    readVersion: () => settingsRepo.secretsVersion(),
    rebuild: async () => { clients.current = await buildCurrent() },
    log,
    initialVersion: settingsRepo.secretsVersion(),
  })
  const satisfactionTracker = makeSatisfactionTracker({ satisfied: () => setupSatisfied(cfg), log })

  // 第 7 步 B 组：原先这里是一个 15 字段的 `DaemonDeps` 字面量，它存在的唯一理由已经是
  // "给下面 4 个运维器官的闭包找个地方待着"——ScoutDaemonV2 只从它身上取 dbMaintenance /
  // traceRetentionDays / preTick / workPermitted 四个，另外 11 个字段（lib/jobs/runs/
  // ingestTrigger/gcStaging/executeJob/log/now/dispatchTranslate/concurrency/ingestEveryMs）
  // 自 ScoutDaemon 停止被构造起就零消费者。承载它们的类型 DaemonDeps 与唯一消费者
  // ScoutDaemon 已随 src/v2/daemon.ts 整体删除，故字面量一并拆掉：4 个器官直接内联进下方
  // buildDaemonV2Deps({...}) 的调用（那里本就是它们唯一的去处），不再绕一层"先塞进一个
  // 15 字段的类型、再用 `!` 非空断言取出来"——那 4 处 `!` 正是 DaemonDeps 把它们声明成
  // optional 留下的疤，内联后类型天然收紧（WatchWiringArgs 上这 4 个字段是必填的）。
  //
  // dbMaintenance 的闭包工厂在这里独立成 const 而不是内联进下方对象字面量：它需要一个
  // 跨调用存活的 makeMaintenanceState()（内部时间门控就靠这份 state 记"上次 checkpoint /
  // 上次备份是什么时候"），写成 IIFE 塞进字面量会让这层意图埋在 40 行接线中间。
  // DB 审计🔴 耐久运维：周期 wal_checkpoint + 天级 VACUUM INTO 在线备份（留 7 份），
  // 内部时间门控；失败只记日志（运维是增益，不拖主循环）。
  const dbMaintenance = (() => {
    const state = makeMaintenanceState()
    return () => runDbMaintenance(db, cacheRoot, state, Date.now(), log)
  })()

  // 去 Jellyfin 化 P7：不再有单一"正在看哪台 Jellyfin"的地址可报，改报实际生效的媒体根白名单
  // （DB media_roots 与 MEDIA_ROOTS 首启种子都为空时 currentRoots() 为空——上方已经打印过对应
  // 的告警行）。这里只是启动时刻的一次性播报，之后 dashboard 增删根不会回来改这行日志。
  const startupRoots = currentRoots()
  console.log(`subtitle-scout v2 watching (media roots: ${startupRoots.length > 0 ? startupRoots.join(', ') : '(none configured)'})`)

  // 零字幕源告警:所有找字幕任务都会落空(配置缺失的故障和真实的"没找到"在 UI 上不可区分)
  const subtitleSourcesWarning = zeroSubtitleSourcesWarningLine(process.env)
  if (subtitleSourcesWarning) console.warn(subtitleSourcesWarning)

  // 第 2 步（C2 + C16 + D5）：容器入口跑 ScoutDaemonV2（每日巡检模型）。
  //
  // 切换方式是**内部替换**，不是换 Dockerfile 的 CMD 指向另一个入口（D5 裁决）：那 4 个运维
  // 器官（dbMaintenance / gcStaging / traceRetentionDays+runs / 写探针清扫，外加 preTick /
  // workPermitted）的接线天然留在这个函数里，不用在第二个入口文件里重建第二份——重建 =
  // 第二份实现 = 必然漂移，本仓已经反复栽过（D7 的 findOverlappingRoot、C30 的两套字幕标签集）。
  // 曾经存在的那个备选入口 watchV2.ts 已于**第 7 步删除**（它从未被 CMD 指过，是死代码）。
  //
  // 第 7 步 B 组：旧 ScoutDaemon 与它的 DaemonDeps 类型已**整体删除**（src/v2/daemon.ts 不再
  // 存在）。翻译流早在第 4 步就迁到了 daemonV2（下方 translateEnabled / translateRunItem 两根
  // 线），不再挂在旧 daemon 的 dispatchTranslate 上，那条"停摆到第 4 步"的过渡代价已经结清。
  //
  // 这里原有一句"handleWorkerTask 仍被 dashboard 的手动 redispatch 用"——**那是假的**，已删。
  // dashboard 的 POST /api/v2/workflow/redispatch 走 triageOps.redispatch → jobs.upsertWorkerTask，
  // 只**写一行 jobs 记录**，从不调用 handleWorkerTask。真实情况见下方 handleWorkerTask 定义处
  // 的注释：随 ScoutDaemon 删除，jobs 队列在生产已无任何认领者（claimNext 零生产调用点）。
  const daemon = new ScoutDaemonV2(buildDaemonV2Deps({
    db,
    rootsProvider: currentRoots,
    // holder 现取（spec A §4.2）：setup 模式下这两个是 null，此时 workPermitted 恒 false
    // 把整轮巡检闸住，daemon 一次都不会读到它们；点火后同一个 getter 自然吃到新客户端。
    // `?? throw` 形态的兜底不写在这里——那会把"闸住"变成"崩"，与 §4.7 步 5 的既有口径相反。
    identifyProvider: () => clients.current.identifyDeps ?? EMPTY_IDENTIFY_DEPS,
    subtitleWorker: (task) => {
      const w = clients.current.subtitleWorkerV2
      if (!w) return Promise.resolve(EMPTY_SUBTITLE_REPORT)
      return w(task)
    },
    // 债务D5 的既有口径：settings.target_languages 行为级优先，每次求值。
    targetLanguage: () => languagesNow().targetLanguages[0],
    log,
    now: () => Date.now(),
    // ── D5 的 4 个运维器官（C16：切换入口不得静默丢失既有能力）──
    // 第 7 步 B 组：这 4 个直接内联在这里。此前它们先被塞进一个 15 字段的 `DaemonDeps`
    // 字面量、再用 `daemonDeps.dbMaintenance!` 这种非空断言取回来——那层中转随
    // ScoutDaemon/DaemonDeps 一起删掉了，`!` 也跟着消失（WatchWiringArgs 上这 4 个字段必填）。
    gcOrphans,
    bootTimeMs,
    dbMaintenance,
    // 写探针清扫（C16 第 4 项）：旧世界里它挂在 ingest 的走盘循环里（ingest.ts:894，顺便扫
    // 本轮见过的每个目录），而 daemonV2 不跑 ingest——不在这里接就没有任何代码路径会清它，
    // 而 daemonV2 自己每次 writableRoots() 探测都会在守备目录根上再留一枚新探针
    // （2026-07-29 实测残留 175 个）。作用域取守备目录根一级：探针正是写在那一级的
    // （isDirWritable(root)），逐目录递归扫是白付 IO。
    sweepWriteProbes: () => {
      let swept = 0
      for (const root of currentRoots()) {
        swept += sweepWriteProbes(root, (d) => { try { return readdirSync(d) } catch { return [] } })
      }
      return swept
    },
    runs,
    // 债务D5：trace 保留天数惰性读，默认 30 天（设置页改完下一轮巡检生效，不用重启容器）。
    traceRetentionDays: () => Number(settingsRepo.get('trace_retention_days')) || 30,
    // spec A §4.2/§4.7：preTick 每拍最先跑——secrets_version 变了在这里完成热重建
    // （整体换 clients.current），随后 satisfaction tracker 在"点火"那一刻记 engine live。
    preTick: async () => {
      await secretsWatcher()
      satisfactionTracker()
    },
    // spec A §4.6/§4.7 步 3：产工作许可 = engine_enabled(fail-open) ∧ setup 闸(TMDB+LLM 可解析)。
    // false 时整轮巡检跳过，维护循环（dbMaintenance/trace 修剪/孤儿回收）不闸——分界见
    // daemonV2.ts 里 DaemonV2Deps.workPermitted 的字段注释。
    //
    // 合取式本身收在 watchClients.workPermitted 里（此前就地写在这一行，导致
    // /api/v2/health 只抄到了左半边 engineEnabled，见那个函数的头注释）。这里只负责
    // 把两个数据源接上去——判据全仓一份。
    workPermitted: () => workPermitted((k) => settingsRepo.get(k), cfg),
    // D14 / C41：阶段 2.6 停牌复查闸的取件范围。双门控 = TRANSLATE_* 三凭证部署层 ∧
    // settings.ai_translate_enabled 行为级（默认关）。
    //
    // 这份判据曾**与旧 daemon 的 `dispatchTranslate` 字段逐字同源**——那是"派活"一侧，本处是
    // "复查"一侧，两处若各写一份，用户眼里"翻译开着"这一件事会在两条路上得到相反答案（本仓
    // 已因"留两份漂移实现"栽过多次：D7 的 findOverlappingRoot、C30 的两套字幕标签集）。
    // 该字段已于**第 7 步 B 组随 src/v2/daemon.ts 一并删除**（15 个零消费者字段之一），所以
    // **今天这是全仓唯一一处此判据**，不再有"另一端"需要对齐。防漂移的意义随之从"两处保持
    // 一致"变成"新增第二处派活闸时必须回到这里复用，而不是就地手写"——守卫在
    // watchWiring.test.ts 的 `translateEnabled` 源码断言用例（它按符号名定位本行）。
    //
    // 惰性求值（每轮巡检现取，非组装时求值一次）：用户在 dashboard 里关掉翻译后，停在
    // handoff_translate 的行下一轮就该恢复复查，不用重启容器——它们正是 C41 那批"翻译不启动
    // 就永久卡死"的行，最不该等一次重启。
    translateEnabled: () => !!tryAutoTranslateCfg(cfg) && settingsRepo.get('ai_translate_enabled') === 'true',
    // 第 4 步（C3 + R19）：翻译流真正接回来的那根线。**每次调用现建**（不是启动时建一次）：
    // runItem 内部攥着 LLM 客户端与 adapters，而 secrets_version 变化时 preTick 会整体重建
    // 它们——建一次就等于把"点火前的世界"冻死在进程里，wizard 里配完 TRANSLATE_* 还得重启容器。
    //
    // 凭证走 tryAutoTranslateCfg（与上方 translateEnabled 逐字同源）：只认显式 TRANSLATE_* 三件套，
    // **绝不回退 LLM_*** 弱模型——回退的后果是拿一个过不了质量闸的模型反复 held，每次都是一个
    // 付费 session（旧世界实案：job29 重试 11 次全同样错误）。凭证不全时返回 no-embedded 而不是
    // no-source：no-source 是"确实没有源"这个**终局事实**，会按 §5 映射直接写 unsolvable 停牌，
    // 而"用户还没配翻译凭证"根本不是关于源的判断——拿它去判死一批文件是错的。
    // （translateEnabled 双门控此时本就为 false，翻译流不会领活；这一支是防御性的第二道。）
    //
    // 与手动 `translate-item` CLI 共用 makeDaemonTranslateRunItem → makeTranslateAgentDeps
    // 这一份组装，不在这里另写第二份（两份必然漂移，本仓已反复栽过）。
    translateRunItem: async (videoPath: string) => {
      const translateCfg = tryAutoTranslateCfg(cfg)
      if (!translateCfg) {
        return { status: 'no-embedded' as const, reason: 'translate 未启用：需配 TRANSLATE_MODEL/TRANSLATE_BASE_URL/TRANSLATE_API_KEY 三件套' }
      }
      const adapters = await buildAdapters(emitProviderEvent, cfg, warn)
      const fetchSourceSub = makeRealFetchSourceSub(db, adapters, emitProviderEvent)
      const runItem = makeDaemonTranslateRunItem({
        db, cfg: translateCfg, fetchSourceSub, tmdb: clients.current.tmdb, roots: currentRoots,
      })
      return runItem(videoPath)
    },
    // 装盘成功踢一脚扫描：新 sidecar 越早被扫到、covered 越早落库（R24：只有扫描有权写它，
    // 翻译 worker 的成功报告不算）。复用上方同一个 ingestTrigger 闭包，不建第二个。
    requestIngest: () => {
      void ingestTrigger().catch((e) => log(`warn: 翻译后踢一脚扫描失败（下一轮自然巡检仍会确认）: ${String(e)}`))
    },
    // C12：探针复用 files/streamProbe.ts 的既有实现（旧 ingest 接的是同一对函数），不写第二份。
    probe: (videoPath: string) => probeEmbeddedSubtitles(videoPath),
    probeDuration: (videoPath: string) => probeDurationSec(videoPath),
    // R-F10：SSE 通道的生产端。与上方 startDashboard 的 events 是同一个 ScoutEventBus 实例
    // ——节流（progress 1s）、续传缓冲（50 条）、订阅者广播都长在总线里，这里只负责发。
    emit: (e) => scoutEvents.publish(e),
  }))


  const stop = () => {
    log('received shutdown signal')
    shutdown.abort()
  }

  // R5-6 修复：daemon 无二次信号强退——SIGINT/SIGTERM 只 shutdown.abort()，shutdown 等 inflight
  // （30s）或长 ingest 期间再按 Ctrl-C 完全无效。第二次调用时直接 process.exit(1)。
  let stopCalled = false
  const gracefulStop = () => {
    if (stopCalled) {
      log('received second shutdown signal, force exit')
      process.exit(1)
    }
    stopCalled = true
    stop()
  }

  process.on('SIGINT', gracefulStop)
  process.on('SIGTERM', gracefulStop)

  await daemon.run(shutdown.signal)
  // 干净退出:关连接(checkpoint 落 WAL)再走,别把未落盘提交交给运气(软路由断电常态)。
  try { db.close() } catch { /* 尽力 */ }
  process.exit(0)
}

async function cmdDoctor() {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const roots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const results: DoctorResult[] = []

  // 启动面（spec A §4.3）：密钥来源无关化——env 与库里的 secret:*/provider:* 都算。doctor 是
  // 一次性快照式体检，这里开一条短命连接把两个键空间读进内存就立刻 close，后面所有检查项都读
  // 这份快照，绝不持有活 handle（下方每个 dbExists 块各自 openDb/close，持 handle 必炸）。
  const dbPath = join(cacheRoot, 'scout.db')
  const dbExists = existsSync(dbPath)
  const secretSnap = new Map<string, string | null>()
  if (dbExists) {
    try {
      const { openDb } = await import('../v2/db.js')
      const snapDb = openDb(dbPath)
      try {
        const repo = new SettingsRepo(snapDb)
        for (const name of SECRET_NAMES) secretSnap.set(`secret:${name}`, repo.get(`secret:${name}`))
        for (const flag of ['SUBHD_ENABLED', 'ZIMUKU_ENABLED']) secretSnap.set(`provider:${flag}`, repo.get(`provider:${flag}`))
      } finally {
        snapDb.close()
      }
    } catch {
      // openDb 抛错（迁移失败/外键违例）时快照留空 → 本次体检退化成 env-only。同一种抛错由下方
      // checkDatabase 转成 ✗ 诊断行，这里不重复报（R2D-20 的既有口径）。
    }
  }
  const cfg = dbExists
    ? makeAdapterConfigResolver(process.env, (k) => secretSnap.get(k) ?? null)
    : envOnlyAdapterConfig(process.env)

  // env 缺失走诊断项（✗ + hint、exit 1），不 requireEnv 急切崩溃（那是 exit 2 的”用法错误”通道）
  // TMDB 排最前:它是 watch 的硬前置(缺 key 直接拒绝启动),缺它 doctor 必须 ✗ 而非
  // 假装全绿——修复"doctor 通过但 watch 立刻因缺 TMDB_API_KEY 退出"的假信心。
  const tmdbKey = cfg.secret('TMDB_API_KEY').value
  if (!tmdbKey) {
    results.push({
      name: 'tmdb', ok: false, detail: 'TMDB_API_KEY 未配置（watch 的硬前置，缺它直接拒绝启动）（也可在 dashboard 的 setup wizard 里配置）',
      hint: '获取：https://www.themoviedb.org → 账户设置 → API → 复制 API Key(v3 auth)。墙内环境可配 TMDB_PROXY_URL 或 TMDB_BASE_URL 走反代。',
    })
  } else {
    const tmdb = new TmdbClient({ apiKey: tmdbKey, baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL })
    results.push(await checkTmdb(() => withTimeout(tmdb.search('movie', 'The Matrix', 1999), 10_000, 'TMDB').then(h => h.length)))
  }

  const assrtToken = cfg.secret('ASSRT_TOKEN').value
  if (!assrtToken) {
    results.push({
      name: 'assrt', ok: false, detail: 'ASSRT_TOKEN 未配置',
      hint: '注册/获取：https://assrt.net → 登录 → 用户中心复制 API token。',
    })
  } else {
    const assrt = new AssrtClient({ token: assrtToken, cacheDir: join(cacheRoot, 'assrt-responses') })
    results.push(await checkAssrt({ quota: () => withTimeout(assrt.quota(), 10_000, 'ASSRT') }))
  }

  const osKey = cfg.secret('OPENSUBTITLES_API_KEY').value
  if (!osKey) {
    results.push(await checkOpenSubtitles(null))
  } else {
    const os = new OpenSubtitlesClient({
      apiKey: osKey, appUserAgent: 'subtitlescout v0.2.0',
      username: cfg.secret('OPENSUBTITLES_USERNAME').value ?? undefined, password: cfg.secret('OPENSUBTITLES_PASSWORD').value ?? undefined,
    })
    // The Matrix：配额免费的探测目标，只验证 key/网络，不耗下载配额
    results.push(await checkOpenSubtitles({
      search: () => withTimeout(os.search({ imdbId: 133093, languages: ['zh-cn'] }), 10_000, 'OpenSubtitles'),
    }))
  }

  const jimakuKey = cfg.secret('JIMAKU_API_KEY').value
  if (!jimakuKey) {
    results.push({ name: 'jimaku', ok: true, skip: true, detail: '未配置(可选 provider)', hint: '设 JIMAKU_API_KEY 启用（jimaku.cc 账号设置复制）。' })
  } else {
    const jk = new JimakuClient({ apiKey: jimakuKey })
    results.push(await checkJimaku(() => withTimeout(jk.search({ query: 'test' }), 10_000, 'Jimaku')))
  }

  const zimukuEnabled = cfg.flag('ZIMUKU_ENABLED').enabled
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

  results.push(await checkSubhd(() =>
    withTimeout(curlFetch(process.env.SUBHD_BASE_URL ?? SUBHD_BASE, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status), 10_000, 'subhd')))

  const llmBase = cfg.secret('LLM_BASE_URL').value
  const llmKey = cfg.secret('LLM_API_KEY').value
  const llmModel = cfg.secret('LLM_MODEL').value
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
  // 这就是"真正生效"的清单。dbPath/dbExists 已在函数顶部的密钥快照块里算好，这里复用。
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

const USAGE = 'usage: subtitle-scout watch | doctor | translate-item <videoPath> | realign-rollback <archiveDir> | auth reset'

/** 鉴权 A4 Task 15：`subtitle-scout auth reset`——诚实找回密码。删管理员三键回到未初始化态，
 *  下次访问 dashboard 重进创建管理员向导。复用 cmdWatch 同一套 db 定位（SUBTITLE_SCOUT_CACHE_DIR）。 */
function cmdAuthReset(): void {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const dbPath = process.env.SUBTITLE_SCOUT_DB || join(cacheRoot, 'scout.db')
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
  // 'reconcile-all' 已删（第 5.5 步，orchestrator 及其依赖的旧架构全删）
  if (cmd === 'doctor') return cmdDoctor()
  if (cmd === 'translate-item' && positionals[1]) return cmdTranslateItem(positionals[1])
  if (cmd === 'realign-rollback' && positionals[1]) return cmdRealignRollback(positionals[1])
  if (cmd === 'auth' && positionals[1] === 'reset') return cmdAuthReset()
  console.error(USAGE)
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
