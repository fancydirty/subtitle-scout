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
import {
  checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkTmdb, checkMediaRoots,
  checkDatabase, checkStuckJobs, checkMountCapabilities, checkJimaku, checkR3sub, checkSubdl, checkSubhd,
  formatDoctorReport, overallOk, withTimeout, relevantSourceForDoctor, type DoctorResult,
} from './doctor.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
import { ZIMUKU_BASE } from '../adapters/providers/zimuku.js'
import { JimakuClient } from '../adapters/providers/jimaku.js'
import { R3subClient } from '../adapters/providers/r3sub.js'
import { R3subSessionStore } from '../adapters/providers/r3subSession.js'
import { SubdlClient } from '../adapters/providers/subdl.js'
import { curlFetch, SUBHD_BASE } from '../adapters/providers/subhd.js'
import { makeAdapterConfigResolver, SECRET_NAMES, type AdapterConfigResolver } from '../v2/secrets.js'
import { setupSatisfied, workPermitted, makeSecretsWatcher, makeSatisfactionTracker, type ClientsHolder } from './watchClients.js'
import { clampTranslateAfterAttempts } from '../v2/subtitleScheduler.js'
import { openDb } from '../v2/db.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { makeMaintenanceState, runDbMaintenance } from '../v2/dbMaintenance.js'
// ── 字幕校验巡检（雪藏中，2026-08-07）：本文件**刻意不 import 它** ──────────────
// 这里曾有三行：`SubtitleVerifyRepo` / `verifyAndRecord` / `runVerifySweep`，三个都是
// import 进来后零调用。2026-08-13 清理把它们删掉，理由**不是**"这些资产没用"——恰恰相反，
// src/subtitleVerify/ 是 246 条用例覆盖的真算法（⚠️ 2026-08-14 取证更正：这 246 条里
// 只有 verifySweep 的 33 条与孤儿族耦合，另外 213 条 —— alignDetect/referenceSource/
// shiftTiming/subtitleSpans/verifySubtitle —— 与本族**零耦合**，删族不会带走它们。
// 此前流传的「246 条全靠 addReplicaSubtitle 撑着」是假的：那个函数定义在族外的
// libraryRepo.ts:1019，且在整个 subtitleVerify/ 里只出现在一行负面样本 fixture 上），
// `v2/subtitleVerifyRepo.ts` 头部有一份
// 完整裁决明令保留（🔴 那份注释不要删）。
//
// 删的是**假信号**：一个零调用的 import 会让 `rg 'runVerifySweep' src/cli/` 出现命中，
// 读者据此以为"cli 这边已经接上了、只差最后一步"。真相是一根线都没接。让 grep 诚实地
// 返回零结果，比留一个指向空处的 import 更接近"让事实显形"。
//
// 恢复接线要做的事（照抄 subtitleVerifyRepo.ts §「反过来，恢复它只需要」）：
//   1. 在 daemonV2 加一个 pass 调 runVerifySweep，并写 `last_verify_sweep_at` meta 键
//      （apiV2.ts 的 lastVerifySweepAt 字段已就位，无需改动即自动复活）；
//   2. 把 TriagePage 挂回 AppShell。
// 那一天在这里重新 import 是一行的事——而在此之前，这里不该有任何东西。

import { ScoutDaemonV2, clampInterval } from '../v2/daemonV2.js'
import { buildDaemonV2Deps } from './watchWiring.js'
import { runIdentify } from '../agent/identifyWorker.js'
import type { IdentifySchedulerDeps } from '../v2/identifyScheduler.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'

import { fetchAnimeListsTable } from '../adapters/providers/animeLists.js'
import { makeRealignRunEpisode, type RealignExecutorDeps } from '../v2/realignExecutor.js'
import { makeRealignLibraryPort } from '../v2/realignLibraryPort.js'
import { replayRollback } from '../files/realignManifest.js'
// (import removed - see comment above)
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { buildAdapters, buildR3subClient } from '../adapters/buildAdapters.js'
import { resolveTargetLanguages } from './targetLanguages.js'
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'
import { dashboardAuthStartupLines } from './dashboardTokenWarning.js'
import { zeroRootsWarningLine, zeroSubtitleSourcesWarningLine, setupModeWarningLine, existingNestedRootsWarning } from './watchStartupWarnings.js'
// 2026-08-13 清理：`import type { ReconcileAllResultDTO }` 已删除。它是 cmdReconcileAll 的
// 返回类型，而 cmdReconcileAll 本身已随第 5.5 步（orchestrator 及其旧架构全删）消失——
// 一个只为已删函数存在的类型 import。DTO 本体仍留在 apiV2.ts（web/src/api/client.ts 的
// `reconcileAll()` 还在引用同名前端 DTO，见下方"发现但没修"）。


// 2026-08-13 清理：`requireEnv` 已删除（零调用者）。它的最后两个调用点是
// JELLYFIN_URL / JELLYFIN_API_KEY，随 design §P7「去 Jellyfin 化」的代码出口一并消失
// （见下方 cmdWatch 里那条已有注释）。今天所有凭证都走 AdapterConfigResolver
// （env **或** dashboard setup wizard 落库皆可，spec A §4.3），"缺就 exit(2)"这个
// 早退语义已被 §4.7 的 setup 闸取代：缺密钥不再崩，而是 gated 存活等用户补配。

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
  if (!reasoningModel) warn('LLM is not fully configured — finish the setup wizard in the dashboard; reasoning work stays gated until then')
  const tmdbKey = cfg.secret('TMDB_API_KEY').value
  const tmdb = tmdbKey
    ? new TmdbClient({ apiKey: tmdbKey, baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL })
    : null
  if (!tmdb) warn('TMDB_API_KEY is not configured — finish the setup wizard in the dashboard; engine stays gated until then')
  return { cacheRoot, mappings, tmdb, reasoningModel }
}

// `buildIngestPass`（cmdWatch 的摄取 pass 组装，v2/ingest.ts 的 makeIngestPass 接线）
// **已删除，2026-08-13**——ingest 整条链退役。它为什么是死的、三个"踢一脚扫描"调用点改接
// 到哪里去了，完整论证与实测证据在 `src/v2/daemonV2.ts` 的 `requestScan()` 头注释，不重抄。

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
  // 字幕校验巡检（Task 6）的持久层**曾在这里建一个实例**：`const verifyRepo = new
  // SubtitleVerifyRepo(db)`，赋值后零读取。2026-08-07（spec §5）巡检注入雪藏后，承载它的
  // daemonDeps 字面量于第 7 步 B 组删除（daemonV2 侧从未有过 verifySweep 字段），此后它
  // 只剩"恢复注入时现成可用"这一个意义，当时的裁决是不删。
  //
  // 🟡 2026-08-13 清理**推翻了这一条局部裁决**（只推翻这一条，资产族的保留裁决**不动**——
  // 见 v2/subtitleVerifyRepo.ts 头部那份完整论证，那份注释不要删）。理由：
  //   · 被保护的资产是 `SubtitleVerifyRepo` 这个类和 src/subtitleVerify/ 那 246 条用例，
  //     **不是这一行 new**。类还在、测试还在、dashboard 侧（server.ts:398）活着的实例还在。
  //   · 「现成可用」的收益是零：这个 repo 无状态（构造函数只存一个 db 引用），恢复注入时
  //     重新写 `new SubtitleVerifyRepo(db)` 就是一行——而那一行本来就已经明列在
  //     subtitleVerifyRepo.ts 的恢复清单里。留一个不读的实例并不能让恢复少做任何事。
  //   · 代价却是实的：它是本文件开启 noUnusedLocals 的最后一个障碍物，而开启它正是为了
  //     让**下一个**孤儿在编译期显形。为了一行零收益的占位而永久放弃全仓的孤儿告警，
  //     账算不过来。

  // dashboard G4：守备目录 DB 化——spec 裁决照抄 Jellyfin 分界：挂载是部署层（compose volume），
  // 守备目录是产品层（media_roots 表，dashboard 里增删）。MEDIA_ROOTS env 降级为首启种子值：
  // 只在 media_roots 表为空时生效一次（seedRootsFromEnv 的既有幂等语义），此后 DB 是唯一真相。
  // currentRoots 是惰性提供者，每次调用都重新查表——这是本任务的关键属性："dashboard 里加根后
  // ingest 下一轮就能扫到"要求 roots 不能是这里冻结的一份静态数组快照。下面把它传给
  // ingestPass；handleWorkerTask 的 realign/find_subtitle 分支也各自在派发时重新调用它，
  // 不复用一份旧闭包捕获的数组（见各自分支的注释）。
  const settingsRepo = new SettingsRepo(db)
  settingsRepo.normalizeRoots()
  const currentRoots = (): string[] => settingsRepo.listRoots().map(r => r.path)
  const nestedWarning = existingNestedRootsWarning(settingsRepo.detectNestedRoots())
  if (nestedWarning) console.warn(nestedWarning)
  if (currentRoots().length === 0) {
    console.log(zeroRootsWarningLine())
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
  //
  // 2026-08-13 清理：这里原本**并排**还有一行急切解构
  // `const { targetLanguages } = resolveTargetLanguages(...)`，零读取。它是 D5 改造前的形态，
  // 改造把所有消费点切到了下面这个惰性闭包，旧的那行没删干净。留着它有真实危害：它是一份
  // watch 启动时刻的**冻结快照**，而 D5 的全部意义就是"设置页改完下一轮就生效、不用重启
  // 容器"。下一个人顺手用了这个现成的 `targetLanguages` 变量，就悄悄退回改造前的行为，
  // 且不会有任何测试变红——正是 D5 注释里点名要防的那种静默漂移。
  const languagesNow = () => resolveTargetLanguages({}, settingsRepo.get('target_languages'))

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

  /** setup 模式下 daemonV2 两条工作台的兜底空实现（
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


  // ── "踢一脚扫描"的接线点（2026-08-13 换绳子）────────────────────────────────
  //
  // 这里原本是 `const ingestTrigger = makeIngestTrigger({ ingest: ... })`——一个绑定
  // v2/ingest.ts 摄取 pass 的闭包，三个调用点共用（加根后、手动扫描按钮、翻译装盘后）。
  // ingest 整条链已随本轮清理退役，理由与实测证据见 `v2/daemonV2.ts` 的 `requestScan()`
  // 头注释（一句话版：ingest 只写 series/episodes/movies/parked_paths 四张旧世界表，
  // 一行 `files` 都不写，而今天所有活着的读出面读的都是 files/works——那三脚全踢空了）。
  //
  // 替代品是 daemonV2 自己的 `requestScan()`（带外机械扫描）。但 daemon 在**下面**才被
  // 构造，而 startDashboard 在**上面**就要拿到这根线，故用一个 late-bound holder：
  //
  //  · 为什么不是"把 daemon 挪到 dashboard 前面构造"——dashboard 先起是 spec A §4.7 步 1
  //    的刚性顺序（零 key 首启时容器健康检查要能转绿、wizard 要可达），不能为接线倒过来。
  //  · 为什么不是 `daemon!` 非空断言——那会把"dashboard 起来了但 daemon 还没构造完的那几毫秒
  //    里恰好有人点了扫描"变成一次 TypeError 崩进 HTTP 处理器。holder 为 null 时如实返回
  //    false，端点据此答 503（"扫描触发器尚未就绪"），与它既有的"watch 没跑 → 503"同一档。
  const daemonHolder: { current: {
    requestScan: () => void
    requestInspect: () => 'queued' | 'already_running'
  } | null } = { current: null }

  /** 三个调用点共用的"踢一脚扫描"。daemon 尚未就绪 → 返回 false（调用方答 503），
   *  不假装成功。 */
  const requestScan = (): boolean => {
    const d = daemonHolder.current
    if (!d) return false
    d.requestScan()
    return true
  }

  const requestInspect = (): 'queued' | 'already_running' | 'not_ready' => {
    const d = daemonHolder.current
    if (!d) return 'not_ready'
    return d.requestInspect()
  }

  const buildCurrent = async (): Promise<WatchClients> => {
    const { mappings, tmdb, reasoningModel } = await assemble(cfg, warn)
    const satisfied = tmdb !== null && reasoningModel !== null
    const realignAdapters = await buildAdapters(cfg, emitProviderEvent, warn)
    // r3sub 下载旁路的 client（两跳下载不经 runResolve）——凭据齐才有，null 时 r3sub 候选下载报错。
    const r3subClient = buildR3subClient(cfg, emitProviderEvent) ?? undefined
    const realignRunEpisode = satisfied
      ? makeRealignRunEpisode({
          runFindSubtitleTask: makeFindSubtitleWorker({
            model: reasoningModel,
            adapters: realignAdapters,
            cacheRoot,
            tmdb,
            r3subClient,
          }),
          // 债务D5 注记（修订）：targetLanguage 随 holder 代际新鲜求值（secrets 变更驱动重建），
          // 仍非 per-task 新鲜——改语言后下轮 ingest 自然生效，realign 这条路径要等下一次重建。
          targetLanguage: languagesNow().targetLanguages[0],
          mediaRoots: currentRoots(),
        })
      : null
    // 2026-08-13：合取式里的 `ingestPass &&` 随 ingest 退役一并去掉——realign 的门控本来
    // 就是 satisfied（TMDB + 模型），ingestPass 只是它的一个派生物（`tmdb ? ... : null`），
    // 出现在这里是搭车而不是独立条件。
    const realignDeps: RealignExecutorDeps | null = (satisfied && realignRunEpisode)
      ? {
          lib, jobs,
          // port 的两根线接 daemonV2 的带外扫描（原为 runIngest: ingestPass）。
          // ⚠️ realignDeps 的唯一消费者是 `cli/handleWorkerTask.ts`（零生产调用者、保留待裁），
          // 它在派发时用新鲜的 currentRoots() **重建**这个 port，故这里构造的这一份实际不会被
          // 用到——`isScanning: () => false` 的诚实降级与那边同一口径，理由见那边的注释。
          jf: makeRealignLibraryPort({ lib, roots: currentRoots(), requestScan, isScanning: () => false }),
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
      ? makeFindSubtitleWorker({ model: reasoningModel, adapters: realignAdapters, cacheRoot, tmdb, r3subClient })
      : null

    // orchestrateWorkerTaskDeps 已删（第 5.5 步）
    // reconcileAll 已删（第 5.5 步）
    return {
      mappings, tmdb, reasoningModel, realignAdapters,
      realignDeps, findSubtitleWorkerTaskDeps,
      identifyDeps, subtitleWorkerV2,
    }
  }

  const clients: ClientsHolder<WatchClients> = { current: await buildCurrent() }

  // ⚠️ 原本这里有一个 140 行的 `const handleWorkerTask = async (job: Job) => {...}` 闭包，
  // **生产零调用者**。2026-08-13 死代码清理把它整体提取到 `./handleWorkerTask.ts`，
  // 函数体逐字未改，15 个闭包捕获变量收进显式 deps 参数（字段名与这里的局部名逐字相同）。
  //
  // 为什么是提取而不是删除或原地保留（三条路的完整权衡、零调用者的事实链、可证伪的删除
  // 判据）全部写在那个文件的头注释里，不在这里重抄。
  //
  // ⚠️ 这里原本还写着"它造成的两个真实后果"。2026-08-13 裁决后这句需要更新：
  //   · ingestTrigger 写无人认领的 orchestrate 行 —— **已修**（入队删除；那行即便队列
  //     复活也不可执行，全仓无 orchestrate 处理分支）。
  //   · dashboard 手动重派按钮语义为空 —— 更准确的说法是**按钮已不在活 UI 里**
  //     （RerunDialog 随旧活动页移入 `web/src/_legacy/`）；端点仍在且仍会写行，
  //     刻意保留，判据与 handleWorkerTask 同进退。
  //
  // 一句话版本：`export` 出去之后，"零调用者"这个事实从"由一段会过期的注释承载"变成了
  // **一条会红的断言**——`src/cli/handleWorkerTask.orphan.test.ts` 扫全部生产源码（剥注释
  // 后）里对它的 import，零个才绿。谁哪天把它接回去，那条断言当场红，并在失败信息里
  // 指名要重读哪两处裁决。
  //
  // 连带效果（提取后由编译器自动指认，不是手工找的）：本文件顶部有 5 个 import 的**唯一**
  // 消费者就是这个函数——`runFindSubtitleWorkerTask` / `runRealignWorkerTask` /
  // `runTranslateWorkerTask` / `makeUnidentifiedFindSubtitleWorker` +
  // `runUnidentifiedFindSubtitleWorkerTask`，以及 `type Job`。它们随函数一起搬走了。
  // 这正是"接线断了"的可见形状：cmdWatch 曾经看起来 import 了整套 worker_task 执行路径，
  // 实际上一条都没在用。

  // Dashboard v2（媒体库 API，读 v2 SQLite；海报直出 TMDB CDN，不再走服务端代理）
  // spec A §4.7 步 1：dashboard 先于门禁评估与 worker 装配启动——顺序即语义，容器健康检查
  // 从此在零 key 首启下也转绿，bootstrap wizard 在密钥落库前就可达。
  const dashPort = Number(process.env.DASHBOARD_PORT) || 0
  // setup 模式警告要按 dashboard 实态措辞（NAS 实测发现①：未起时不许说 "dashboard is up"）。
  let dashboardUp = false
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
      // "加了守备目录 / 点了立即扫描后立刻扫一轮"的接线（server.ts 的 DashboardOpts.requestScan）。
      //
      // 2026-08-13 换绳子：原字段名 `requestIngest`，接的是 ingestTrigger 闭包（→ v2/ingest.ts）。
      // 那条链对本功能**无效**——ingest 一行 files 都不写，而媒体库页读的正是 files/works，
      // 于是"加完目录立刻扫描"在界面上什么都不会发生（实测证据见 daemonV2.requestScan 头注释）。
      // 现在接到 daemonV2 的带外扫描上，那才是今天真正在写 files 的东西。
      //
      // 同步返回布尔而不是 fire-and-forget promise：requestScan() 只是给主循环置一个标志
      // （毫秒级、不会抛、不阻塞），端点拿它区分"已排队"（200）与"daemon 还没就绪"（503）。
      // 旧实现要 catch 一个可能长达一整轮扫描的 promise，那个复杂度随 ingest 一起消失了。
      requestScan,
      // 手动点火完整巡检（POST /api/v2/library/inspect）。与 requestScan 共用 daemonHolder：
      // daemon 尚未 new 出来 → 'not_ready'，端点答 503。不复用 scan 路由。
      requestInspect,

      // R-F10：SSE 通道的消费端（GET /api/v2/events）。与下方 daemon 的 emit 是同一个实例。
      events: scoutEvents,
    })
    if (dashServer.listening) {
      dashboardUp = true
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

  // spec A §4.7 步 2：setup 模式不 exit——引擎闸全关，日志里留唯一路标（措辞按 dashboard 实态）。
  if (!setupSatisfied(cfg)) console.warn(setupModeWarningLine(dashboardUp))

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
  const subtitleSourcesWarning = zeroSubtitleSourcesWarningLine({
    assrt: settingsRepo.getSecret('ASSRT_TOKEN') !== null,
    opensubtitles:
      settingsRepo.getSecret('OPENSUBTITLES_API_KEY') !== null &&
      settingsRepo.getSecret('OPENSUBTITLES_USERNAME') !== null &&
      settingsRepo.getSecret('OPENSUBTITLES_PASSWORD') !== null,
    zimuku: settingsRepo.get('provider:ZIMUKU_ENABLED') === 'true',
    subhd: settingsRepo.get('provider:SUBHD_ENABLED') === 'true',
    jimaku: settingsRepo.getSecret('JIMAKU_API_KEY') !== null,
  })
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
    // 债务D5 口径：设置页改 scan_interval_ms 下一轮巡检即生效（getter 每轮求值），不重启容器。
    // clampInterval 防呆：空/NaN/0 回默认 24h，越界钳回 [1h,7d]。BehaviorSection 的五档写的就是这个键。
    // 2026-08-28：这一行是死设置复活的接线终点——此前 scan_interval_ms 到 daemon 之间无任何一根线。
    inspectEveryMs: () => clampInterval(Number(settingsRepo.get('scan_interval_ms'))),
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
    // 2026-08-15 用户裁决：runs 历史保留一周（与通知页同窗）——默认 7。
    // trace_retention_days 设置仍可覆盖（改完下一轮维护拍生效，不用重启容器）。
    traceRetentionDays: () => Number(settingsRepo.get('trace_retention_days')) || 7,
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
    // 翻译移交阈值：每次派发现取（同上），脏值/未设由 clamp 回落 7（R10 默认档）。
    translateAfterAttempts: () => clampTranslateAfterAttempts(settingsRepo.get('translate_after_attempts')),
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
      const adapters = await buildAdapters(cfg, emitProviderEvent, warn)
      const fetchSourceSub = makeRealFetchSourceSub(db, adapters, emitProviderEvent)
      const runItem = makeDaemonTranslateRunItem({
        db, cfg: translateCfg, fetchSourceSub, tmdb: clients.current.tmdb, roots: currentRoots,
        // F2（2026-08-18 生产实案，spec §4.3）：目标语言用 languagesNow() 现取——与
        // daemonV2 deps.targetLanguage（上方 buildDaemonV2Deps 的同一来源）逐字同源，不另算
        // 一份。translateRunItem 每次领活现建 runItem，故这里的求值是 per-claim 新鲜的：
        // dashboard 里改 target_languages，下一个翻译任务就吃到新值，不用重启容器。
        // 不传的后果已被 DxD 实案证明：worker 对着 en 目标说"已有中文覆盖"→ 每日重领的
        // 僵尸循环。
        targetLanguage: languagesNow().targetLanguages[0],
      })
      return runItem(videoPath)
    },
    // 翻译装盘后的"踢一脚扫描"接线**已删除**（2026-08-13）：daemonV2 现在直接调自己的
    // requestScan()，不再从外面注一根线进去（同一进程内它自己就是那个扫描器）。
    // C12：探针复用 files/streamProbe.ts 的既有实现（旧 ingest 接的是同一对函数），不写第二份。
    probe: (videoPath: string) => probeEmbeddedSubtitles(videoPath),
    probeDuration: (videoPath: string) => probeDurationSec(videoPath),
    // R-F10：SSE 通道的生产端。与上方 startDashboard 的 events 是同一个 ScoutEventBus 实例
    // ——节流（progress 1s）、续传缓冲（50 条）、订阅者广播都长在总线里，这里只负责发。
    emit: (e) => scoutEvents.publish(e),
  }))

  // 把 daemon 交给上面那个 late-bound holder——`requestScan` 闭包（已经交给 startDashboard）
  // 从这一刻起变成真的会扫盘。在此之前它如实返回 false，端点答 503（见 holder 定义处的论证）。
  daemonHolder.current = daemon


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
        // 目标语言也进同一份快照（doctor 按语言分流无关源用）——与凭据同源同时刻，不另开连接。
        secretSnap.set('target_languages', repo.get('target_languages'))
      } finally {
        snapDb.close()
      }
    } catch {
      // openDb 抛错（迁移失败/外键违例）时快照留空 → 本次体检按"未配置"报。同一种抛错由下方
      // checkDatabase 转成 ✗ 诊断行，这里不重复报（R2D-20 的既有口径）。
      // 2026-08-20：不再回落 env-only——env 凭证路径已删（用户裁决），没配就是没配，
      // 指到 wizard 去配。
    }
  }
  // 2026-08-20（env 凭证删除）：doctor 与 watch 同源，一律读库。库未初始化/未配置 → ✗ + 指向
  // dashboard 向导，绝不再看 process.env（旧回落会让"compose 里塞了 env"的部署得到一张
  // 全绿的假体检单，而 watch 实际根本不认那些 env）。
  const cfg = makeAdapterConfigResolver(process.env, (k) => secretSnap.get(k) ?? null)

  // 源×语言分流（2026-08-30 E2E 实案）：en 目标下未配置的 ASSRT 曾被记 ✗、把整体判成"2 项
  // 未通过"——注册表世界里它对 en 用户是"无关"不是"缺失"。目标语言与 watch 同源
  // （settings 行为级、未设默认 zh——languagesNow 同款 resolveTargetLanguages({}, …) 口径）。
  // 分流规则见 doctor.ts relevantSourceForDoctor：不相关且未配 → skip；已配置照旧真探测；
  // 相关但未配保持既有语义（assrt ✗ / jimaku skip）。TMDB/LLM/OS/SubDL 等相关项行为不变。
  const { targetLanguages: doctorTargets } = resolveTargetLanguages({}, secretSnap.get('target_languages') ?? null)
  const skipIrrelevant = (name: string): DoctorResult => ({
    name, ok: true, skip: true,
    detail: `未配置(与目标语言 ${doctorTargets.join(',')} 无关)——在 dashboard 设置页配置后 doctor 仍会体检`,
  })

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
  if (relevantSourceForDoctor(doctorTargets, 'assrt', !!assrtToken) === 'skip-irrelevant') {
    results.push(skipIrrelevant('assrt'))
  } else if (!assrtToken) {
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
  if (relevantSourceForDoctor(doctorTargets, 'jimaku', !!jimakuKey) === 'skip-irrelevant') {
    results.push(skipIrrelevant('jimaku'))
  } else if (!jimakuKey) {
    results.push({ name: 'jimaku', ok: true, skip: true, detail: '未配置(可选 provider)', hint: '在 dashboard 设置页配置 JIMAKU_API_KEY 启用（jimaku.cc 账号设置复制）。' })
  } else {
    const jk = new JimakuClient({ apiKey: jimakuKey })
    results.push(await checkJimaku(() => withTimeout(jk.search({ query: 'test' }), 10_000, 'Jimaku')))
  }

  // r3sub / SubDL（registry spec §4.4）：BYO 凭据的可选源，未配置 → skip；已配置分别用
  // 真实登录 / 带 key 搜索探测（与 dashboard validate 探针同构）。
  const r3subEmail = cfg.secret('R3SUB_EMAIL').value
  const r3subPassword = cfg.secret('R3SUB_PASSWORD').value
  if (relevantSourceForDoctor(doctorTargets, 'r3sub', !!(r3subEmail && r3subPassword)) === 'skip-irrelevant') {
    results.push(skipIrrelevant('r3sub'))
  } else if (!r3subEmail || !r3subPassword) {
    results.push(await checkR3sub(null))
  } else {
    const r3 = new R3subClient({
      email: r3subEmail, password: r3subPassword,
      sessionStore: new R3subSessionStore(join(cacheRoot, 'r3sub-session')),
    })
    results.push(await checkR3sub(() => withTimeout(r3.login(), 10_000, 'r3sub')))
  }

  const subdlKey = cfg.secret('SUBDL_API_KEY').value
  if (!subdlKey) {
    results.push(await checkSubdl(null))
  } else {
    const subdl = new SubdlClient({ apiKey: subdlKey })
    results.push(await checkSubdl(() =>
      withTimeout(subdl.search({ filmName: 'The Matrix', type: 'movie', languages: ['EN'] }), 10_000, 'SubDL').then(r => r.length)))
  }

  const zimukuEnabled = cfg.flag('ZIMUKU_ENABLED').enabled
  if (relevantSourceForDoctor(doctorTargets, 'zimuku', zimukuEnabled) === 'skip-irrelevant') {
    results.push(skipIrrelevant('zimuku'))
  } else if (!zimukuEnabled) {
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

  // subhd 是无 key 的 toggle 源：既有语义对 zh 目标是"无条件探首页可达性"（开关只管引擎出网，
  // doctor 反正探的是公开首页）——保持不变；语言不相关且开关未开 → skip（开了就检，同上分流规则）。
  if (relevantSourceForDoctor(doctorTargets, 'subhd', cfg.flag('SUBHD_ENABLED').enabled) === 'skip-irrelevant') {
    results.push(skipIrrelevant('subhd'))
  } else {
    results.push(await checkSubhd(() =>
      withTimeout(curlFetch(process.env.SUBHD_BASE_URL ?? SUBHD_BASE, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status), 10_000, 'subhd')))
  }

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
      (await generateText({ model, prompt: '回复"ok"两个字母即可', abortSignal: AbortSignal.timeout(30_000) })).text, llmModel))
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

const USAGE = 'usage: subtitle-scout watch | doctor | sandbox-library | translate-item <videoPath> | realign-rollback <archiveDir> | auth reset'

async function cmdSandboxLibrary(argv: string[]) {
  const { runSandboxLibraryCommand } = await import('./sandboxLibrary/run.js')
  process.exit(await runSandboxLibraryCommand(argv))
}

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
    new AuthService(new SettingsRepo(db), db).reset()
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
  if (cmd === 'sandbox-library') return cmdSandboxLibrary(process.argv.slice(3))
  if (cmd === 'translate-item' && positionals[1]) return cmdTranslateItem(positionals[1])
  if (cmd === 'realign-rollback' && positionals[1]) return cmdRealignRollback(positionals[1])
  if (cmd === 'auth' && positionals[1] === 'reset') return cmdAuthReset()
  console.error(USAGE)
  process.exit(2)
}

main().catch(e => { console.error(e); process.exit(2) })
