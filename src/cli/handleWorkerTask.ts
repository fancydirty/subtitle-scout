// src/cli/handleWorkerTask.ts
// ═══════════════════════════════════════════════════════════════════════════
// 🟡 2026-08-13：本模块**在生产零调用者**，这不是疏漏，是被承载的事实
// ═══════════════════════════════════════════════════════════════════════════
//
// 这个函数原本是 `cli/index.ts` 里 cmdWatch() 内部的一个局部 const 闭包。本次死代码清理
// 把它**原样搬到这里**（函数体逐字未改，只把 15 个闭包捕获变量收进显式的 deps 参数）。
//
// ── 为什么搬，而不是删、也不是留在原地 ──────────────────────────────────────
//
// 三条路各自的代价，摆在一起看：
//
// (a) **删掉**：不行。它是一整棵死树的**根**，删它会连带拖走
//     runFindSubtitleWorkerTask / runRealignWorkerTask / runTranslateWorkerTask /
//     runUnidentifiedFindSubtitleWorkerTask 四条 worker_task 执行路径、JobsRepo 的整套
//     claim/租约/reap 机制，以及 dashboard 上仍在写 jobs 行的 redispatch 端点。
//     那是"旧 jobs 队列整体退役"这个**独立的产品决策**（dashboard 的手动重派按钮是否
//     还有意义？），不是一次纯结构清理能顺手带走的。原注释的这条判断成立，本次沿用。
//
// (b) **留在 cmdWatch 里不动**：不行。开启 `noUnusedLocals` 之后它是编译错误，而为了
//     它一个而永久不开这个选项，等于放弃"下一个孤儿在编译期显形"——那正是本次清理的
//     全部目的。原注释也明确拒绝了 `void handleWorkerTask` 这条路（理由正确且照抄于此：
//     那一行的实际效果是把它从"待处理清单"里主动豁免出去，与"让事实显形"恰好相反）。
//
// (c) **提取成模块导出**（本次采用）：`export` 的符号不受 noUnusedLocals 约束——这不是
//     绕过检查，而是**换了一种更强的承载方式**。留在原地时，"零调用者"这个事实只由一段
//     中文注释承载，注释会过期、会被人略过；搬出来之后，同一个事实变成了**一条会红的
//     断言**：`src/cli/handleWorkerTask.orphan.test.ts` 扫全部生产源码（剥注释后）里对
//     本模块的 import，零个才绿。谁哪天把它接回去，那次 import 就是接线动作本身，
//     测试当场红并指名要重读哪两处裁决。
//
// 这与本仓 `subtitleVerify/verifySweep.ts` 那族资产是**同一种处理**：算法留着、导出留着、
// 接线不接，事实写在文件头。参照 `v2/subtitleVerifyRepo.ts` 的头部裁决。
//
// ── 零调用者的事实链（可复核，逐字取自原注释）────────────────────────────────
// 它唯一的调用点是原 `daemonDeps.executeJob` 闭包；`executeJob` 唯一的消费者是
// `ScoutDaemon.dispatch()`；而 ScoutDaemon 自第 2 步起就不再被构造（生产唯一入口 cmdWatch
// 构造的是 ScoutDaemonV2），第 7 步 B 组已把 ScoutDaemon 与 src/v2/daemon.ts 整体删除。
// 连带事实：`jobs.claimNext()` 在删除后**生产零调用点**——ScoutDaemon.dispatch 是它唯一的
// 非测试调用者。也就是说 jobs 队列现在只有生产者（dashboard 的 redispatch、
// 各 upsertWorkerTask），没有任何消费者。
//
// 🔴 由此产生的**真实后果**（2026-08-13 复核确认，不是推断）——本轮已处置其一：
//
//    ① `daemon/ingestTrigger.ts` 曾在 ingest 报 changed=true 时 upsertWorkerTask 一行
//       taskType='orchestrate' 的 job，而它的三个调用点（甄别台认领后、翻译装盘后、
//       daemonV2 的 requestIngest）都是活的。**该入队已于 2026-08-13 删除**，理由不是
//       "暂时没人认领"，而是 orchestrate 那行**即便队列整体复活也无法执行**：本文件的
//       路由表只有 find_subtitle / realign / translate 三支，orchestrate 会掉进 else 走
//       `completeError('unknown worker_task taskType')`；orchestrator 那套架构已于第
//       5.5 步整体删除，不存在"恢复接线"这个选项。完整论证见 ingestTrigger.ts 头注释。
//
//    ② dashboard 的 POST /api/v2/workflow/redispatch 仍会写一行 taskType='find_subtitle'
//       的 job，无人认领。**它与 ① 性质不同，故保留**：find_subtitle 背后是本文件那条
//       真实存在、测试覆盖的 runner，缺的只是一根 claim 接线——接回来当天那些行就会被
//       正常执行。它是"待接线的活"，不是"不可执行的死行"。
//       连带事实：该端点今天**没有任何活前端调用方**——唯一的调用点 RerunDialog.tsx 已随
//       旧活动页移入 `web/src/_legacy/`，活 UI 里点不到它（`web/src/api/client.ts` 的
//       `api.redispatch` 亦零活调用方）。所以"按钮语义为空"这个原始描述今天更准确的说法是：
//       **按钮本身已不在活 UI 里**，端点仍在，仍可被 curl 命中并写行。
//
// ── 什么时候可以删（**可证伪的判据，不是"跑稳后再说"**）──────────────────────
// 满足**任意一条**即可整族删除（本文件 + jobsRepo 的 claim/租约/reap 机制 + redispatch
// 端点及其 DTO + `web/src/_legacy/workflow/RerunDialog.tsx`）：
//
//   (a) 产品明确裁定"手动重派/worker_task 队列"这个能力不再需要——那就连四条 runner
//       一起删，别留半截；
//
//   (b) 【2026-08-14 用户裁决替换掉了这一条的时限】
//
//       原文是「距 2026-08-13 起再过一个发布周期，本模块仍没有被任何活代码 import」。
//       **删掉"一个发布周期"这个条件**，理由是它不可判定：本仓自 v0.1.0（2026-07-09）
//       之后再没打过 release tag，"一个发布周期"在这里没有可查的定义，于是这条判据
//       永远停在"技术上还没到期"——一个永不触发的自毁开关，比没有判据更糟，
//       因为它让人以为这里有个会自己了结的机制。
//
//       用户原话（2026-08-14，被问及"这个手动重派的能力还要不要"）：
//         「a，先不管。b. 也不管。这俩都是目前先 archive 的功能。
//           不删但也不接，等现在有的功能测试没毛病了再说。」
//
//       所以现在的判据是**人的裁决，不是时间**：
//         · 封存（archive）：不删、也不接线。维持零 import 现状。
//         · 解封条件：现有功能（字幕获取主链路）经 live test 确认无毛病之后，
//           由用户重新裁决"接通"还是"删除"。**到那时再问，不要自作主张删。**
//
//       ⚠️ 封存 ≠ 遗忘。下面这条命令仍然是"它是否还是孤儿"的判据，
//       孤儿状态一旦被打破（有人真的接线了），本文件顶部的 orphan 守卫会红：
//
//         rg -l "^import .*from '\./handleWorkerTask\.js'" src -g '!*.test.ts' -g '!cli/handleWorkerTask.ts'
//
//       ⚠️ 2026-08-13 更正：此前这里写的是
//       `rg -l "from './handleWorkerTask.js'" src --glob '!*.test.ts'`，**那个形态今天
//       已经假阳**——它命中本文件（上面这行注释含同一字符串）与 `dashboard/apiV2.ts`
//       （它头注释里也引用了这条命令）。照抄去核对会得出"队列复活了"的错误结论。
//       锚 `^import` 挡散文引用，`-g '!cli/handleWorkerTask.ts'` 挡自指。
//       本模块的守卫 `handleWorkerTask.orphan.test.ts` 解析 import 且剥注释，不受影响
//       ——错的只是这里抄下来的命令行，不是那份断言。
//
//       雪藏满两轮 = 没人真的要它。
//
// 反过来，**恢复**它只需要一处 wiring：在 cmdWatch 的主循环里加一个
// `jobs.claimNext(now)` → `handleWorkerTask(job, {...})` 的 claim 分支（deps 字段名与
// cmdWatch 的局部名逐字相同，见下方 HandleWorkerTaskDeps 注释）。队列一旦有了消费者，
// redispatch 端点与那四条 runner 立刻全部有意义。
//
// 🔴 不要只删一半（比如"UI 反正没了，把 redispatch 端点删了留 runner"）：那会留下一族
//    无入口的 runner，与本仓病 A 是同一形状。要么整族留，要么整族删。

//
// ── 以下是它原有的设计注释，退役决策做出前原样保留 ──────────────────────────
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
// ═══════════════════════════════════════════════════════════════════════════

import type { LanguageModel } from 'ai'
import type { Job, JobsRepo } from '../v2/jobsRepo.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { RunsRepo } from '../v2/runsRepo.js'
import type { SettingsRepo } from '../v2/settingsRepo.js'
import type { ScoutDb } from '../v2/db.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { FetchEvent } from '../adapters/fetchLib.js'
import type { AdapterConfigResolver } from '../v2/secrets.js'
import type { RealignExecutorDeps } from '../v2/realignExecutor.js'
import { buildAdapters } from '../adapters/buildAdapters.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import { runFindSubtitleWorkerTask } from '../v2/findSubtitleWorkerTask.js'
import { runRealignWorkerTask } from '../v2/realignWorkerTask.js'
import { runTranslateWorkerTask } from '../v2/translateWorkerTask.js'
import { makeRealignLibraryPort } from '../v2/realignLibraryPort.js'
import { makeRealFetchSourceSub } from './fetchSourceSub.js'
import { tryAutoTranslateCfg, makeDaemonTranslateRunItem } from './translateItemCommand.js'
import {
  makeUnidentifiedFindSubtitleWorker, runUnidentifiedFindSubtitleWorkerTask,
} from './unidentifiedFindSubtitle.js'

/** cmdWatch 里那 15 个被捕获的闭包变量，逐一显式化。字段名与 cmdWatch 里的局部名**逐字相同**
 *  ——恢复接线那天在调用点写 `handleWorkerTask(job, { jobs, clients, lib, ... })` 即可，
 *  不需要在两边之间做任何改名映射。 */
export interface HandleWorkerTaskDeps {
  jobs: JobsRepo
  lib: LibraryRepo
  runs: RunsRepo
  db: ScoutDb
  settingsRepo: SettingsRepo
  cacheRoot: string
  cfg: AdapterConfigResolver
  currentRoots: () => string[]
  languagesNow: () => { targetLanguages: string[]; originSkipLanguages: string[] }
  emitProviderEvent: (e: FetchEvent) => void
  log: (msg: string) => void
  warn: (msg: string) => void
  /** "踢一脚扫描"。2026-08-13 换绳子：原为 `ingestTrigger: () => Promise<unknown>`
   *  （绑定 v2/ingest.ts 的摄取 pass，整条链已退役）。现在是 daemonV2 的带外扫描请求
   *  ——同步、幂等、只置标志。完整论证见 `v2/daemonV2.ts` 的 requestScan 头注释。
   *
   *  ⚠️ 本文件整体是"零生产调用者、保留待裁"的资产（见文件头注释）。换绳子而不是让它
   *  跟着 ingest 一起烂掉，正是为了让那句"接回来当天就能跑"继续为真——留一根指向已删
   *  模块的断线，等于单方面把它降级成不可恢复的死肉。 */
  requestScan: () => void
  /** cmdWatch 的 `clients: ClientsHolder<WatchClients>`——这里只声明本函数**实际读到**的
   *  那 5 个字段（结构化子集，holder 传进来天然满足）。 */
  clients: {
    current: {
      tmdb: TmdbClient | null
      reasoningModel: LanguageModel | null
      realignDeps: RealignExecutorDeps | null
      findSubtitleWorkerTaskDeps: {
        lib: LibraryRepo; tmdb: TmdbClient; mediaRoots: string[]; targetLanguage: string; runs: RunsRepo
      } | null
    }
  }
}

export const makeHandleWorkerTask = (deps: HandleWorkerTaskDeps) => {
  const {
    jobs, lib, runs, db, settingsRepo, cacheRoot, cfg, currentRoots, languagesNow,
    emitProviderEvent, log, warn, requestScan, clients,
  } = deps
  // ── 以下函数体逐字取自 cli/index.ts 的原 handleWorkerTask（2026-08-13 提取，零改动）──
  return async (job: Job): Promise<void> => {
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
        adapters: await buildAdapters(cfg, emitProviderEvent, warn),
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
        // 2026-08-13：port 的两根线换成 daemonV2 的带外扫描请求 + "扫描中"查询
        // （原为 runIngest: ingestPass）。isScanning 恒 false 是**诚实的降级**：本文件没有
        // daemon 实例可问，而它本就零生产调用者；真接回来时应把 daemon 的 isScanning 传进来。
        jf: makeRealignLibraryPort({ lib, roots, requestScan, isScanning: () => false }),
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
        // 2026-08-20 修复（env 凭证删除战役）：这里曾漏传 cfg——旧默认值 envOnlyAdapterConfig
        // 让翻译抓源腿的凭证面恒空（daemon 运行态 env 从来不生效）。buildAdapters 现在必传
        // cfg，漏接在编译期就红；此处与 find_subtitle 分支用同一个 resolver。
        const adapters = await buildAdapters(cfg, emitProviderEvent)
        const fetchSourceSub = makeRealFetchSourceSub(db, adapters, emitProviderEvent)
        const runItem = makeDaemonTranslateRunItem({
          db, cfg: translateCfg, fetchSourceSub, tmdb: c.tmdb, roots: currentRoots,
          // F2（spec §4.3）：目标语言与同文件 find_subtitle 分支（上方两处
          // languagesNow().targetLanguages[0]）同一个来源——不另算一份，already-covered
          // 按它判定，不再硬编码中文。
          targetLanguage: languagesNow().targetLanguages[0],
        })
        await runTranslateWorkerTask(job, {
          runItem,
          requestScan,
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
}
