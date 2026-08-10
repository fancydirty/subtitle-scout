import { basename, dirname } from 'node:path'
import type { LanguageModel } from 'ai'
import type { Job, JobsRepo } from '../v2/jobsRepo.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import { isParkedPathEligible, PARK_REASON } from '../v2/libraryRepo.js'
import { groupIntoWorkUnits, type WorkUnitKind } from '../v2/workUnit.js'
import type { RunsRepo } from '../v2/runsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { identifyFromPath } from '../recognition/identifyFromPath.js'
import { candidateKey } from '../core/schemas.js'
import { traceBus } from '../core/traceBus.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import type {
  FindSubtitleTask, FindSubtitleTargetFact, FindSubtitleBatchReport,
} from '../agent/findSubtitleWorker.schemas.js'
import {
  assertDirSafe, capDetail, stagingRootFor,
} from '../v2/findSubtitleWorkerTask.js'

/** Task 12（agent-first 识别主链路的 CLI 接线）→ 管线拆分（2026-07-28 事故裁决）：
 *  payload.scope==='unidentified' 的 find_subtitle worker_task——目标不是库行（那是既有
 *  findSubtitleWorkerTask.ts 的 mapper 世界：series/movies 行已带身份，缺口清单整批上车），
 *  而是 parked_paths 里的未识别文件。
 *
 *  🔴 2026-07-28 事故（一晚 446 文件全量批）：识别+找字幕挤在同一个 agent run 里，agent
 *  烧 ~450/500 步做识别（424 次 write_identified_media 对 7 次 search_source），步数见底后
 *  凭空编造 384 条 no_safe_match（理由写着 "no Chinese subtitles found via any provider"
 *  ——其实从未搜过），242 集被假 unavailable。裁决：识别归识别，找字幕归找字幕，DB 为
 *  状态机。本 job（②）从此是**识别专用**：agent 识别 → write_identified_media 写库
 *  （sub_status=missing 的新库行）→ 既有库行字幕管线（orchestrator 见 missing → 派
 *  per-series/season find_subtitle worker）接手。两个 agent 从不直接交接。
 *
 *  这里负责三件事：
 *  ① 从 parked_paths 读 raw data（duration_sec/embedded_langs，schema v25 起由 ingest 落）
 *     + identifyFromPath 的结构提示（season/episode/absoluteEpisode），建成 itemId=null 的
 *     FindSubtitleTargetFact 清单（批次上限默认 60、最久 parked 先上——见
 *     buildUnidentifiedTargets）；
 *  ② 组装 identifyOnly worker——只挂识别工具（read_doc/search_tmdb/get_tmdb_details/
 *     write_identified_media/finalize），字幕工具零挂载（零误触发纪律，见
 *     findSubtitleWorker.ts 的 identifyOnly 文档）；
 *  ③ 收割入账——识别专用 run 里 installed 天然恒空（没有安装工具可产出它），但 itemId
 *     幻觉防线整套保留（防御纵深）；unidentified 结局的 park-reason 回写照旧（Task 3 的
 *     二分语义）。 */

/** parked_paths（eligible）→ raw-evidence 目标清单。park_reason 终局机械裁决
 *  （excluded-extra/duplicate-content）由 isParkedPathEligible 滤掉，不上车。
 *
 *  insufficient-evidence（等用户改名）单独滤——这是"等用户行动"，不是"机械终局判决"，
 *  所以不进 isParkedPathEligible，两个概念分开放。不重查指纹：行的 reason 是
 *  insufficient-evidence 就意味着证据没变过——用户改名走磁盘真相清理+新行（reason=
 *  awaiting-agent-identification），原地换内容走 ingest 指纹检查（shouldRetryParkedPath）
 *  重 park 为 awaiting-agent-identification，两条自愈链都会先把 reason 洗掉；还挂着
 *  insufficient-evidence 的行 = 证据未变的行，重跑识别是确定性浪费（烧 token）。 */
export interface BuildTargetsOptions {
  /** 配置媒体根（作品根推导要用）。缺省 [] → workRootOf 退化为"文件所在目录即单元"。 */
  roots?: readonly string[]
  /** 退避窗判定的当下时刻。缺省 Date.now()。 */
  now?: number
  /** 单批最多几个作品单元。缺省 DEFAULT_UNIT_LIMIT(3)；0 = 回滚到旧扁平语义。 */
  unitLimit?: number
  /** 单批最多几个目标文件。缺省 MAX_TARGETS_PER_JOB(60)。 */
  maxTargets?: number
}

/** 一个作品单元的派活料：单元边界（workRoot 当 INNER 沙盒根 / kind 决定 prompt 措辞）+ 它的
 *  target 行。runner 逐单元派 worker——单元边界不能在这层丢掉，否则 mediaRoot 只能靠
 *  commonDir 求全局祖先，那正是本轮 §2 要修的越界 bug。 */
export interface UnidentifiedWorkUnit {
  workRoot: string
  kind: WorkUnitKind
  targets: FindSubtitleTargetFact[]
}

export function buildUnidentifiedWorkUnits(
  lib: Pick<LibraryRepo, 'listParkedPaths'>,
  opts: BuildTargetsOptions = {},
): UnidentifiedWorkUnit[] {
  // 作品单元分组（spec §3.2/§3.3）：把"扁平取 N 个文件"换成"按作品根成组取 N 个单元"。
  // groupIntoWorkUnits 同时承担活锁防线的消费侧——退避窗 filter + last_attempt ASC 排序，
  // 与 bumpParkedRetry 的写入侧配对（缺任一侧活锁就还在，见 spec §3.3.1）。
  const eligible = lib.listParkedPaths()
    .filter((p) => isParkedPathEligible(p.park_reason))
    .filter((p) => p.park_reason !== PARK_REASON.insufficientEvidence)

  const units = groupIntoWorkUnits(eligible, opts.roots ?? [], {
    now: opts.now ?? Date.now(),
    unitLimit: opts.unitLimit,
    maxTargets: opts.maxTargets,
  })

  const byPath = new Map(eligible.map((p) => [p.path, p]))
  return units.map((unit) => ({
    workRoot: unit.workRoot,
    kind: unit.kind,
    targets: unit.paths
      .map((path) => byPath.get(path))
      .filter((p): p is NonNullable<typeof p> => p !== undefined)
      .map((p) => {
        // 结构提示（纯路径解析，同步、零 I/O）——'no-signal' park 时全部 null。
        const identity = identifyFromPath(p.path)
        const hints = 'park' in identity
          ? { season: null, episode: null, absoluteEpisode: null }
          : identity
        // embedded_langs 是 JSON 数组串（与 episodes/movies 同构）；坏 JSON 按未探测处理，
        // 不阻塞上车（同原 identityTools.ts 的容错口径，该文件已于第 7 步 C 组删除）。
        let embeddedLangs: string[] | null = null
        if (p.embedded_langs) {
          try {
            embeddedLangs = JSON.parse(p.embedded_langs) as string[]
          } catch {
            embeddedLangs = null
          }
        }
        return {
          itemId: null, // 未识别——agent 必须先识别（Step 0 → write_identified_media）
          videoPath: p.path,
          videoFilename: basename(p.path),
          season: hints.season,
          episode: hints.episode,
          absoluteEpisode: hints.absoluteEpisode,
          imdbId: null, // 无身份即无 imdb——禁止编造（search_source 工具只许用事实值）
          runtimeMinutes: p.duration_sec ? Math.round(p.duration_sec / 60) : null,
          dirName: dirname(p.path),
          durationSec: p.duration_sec,
          embeddedLangs,
          // Task 2（[tmdbid-N] 证据通道）：取 DB 列，**不**用上面的 identity 重算——这一列是
          // ingest 当时记录下的事实（schema v26），identifyFromPath 只是它的来源之一；DB 值是
          // 单一真相，重算等于让呈现面与落库面各说各话。null=路径无标签（绝大多数情况）。
          embeddedTmdbId: p.embedded_tmdb_id,
        }
      }),
  }))
}

/** 向后兼容的扁平视图——既有测试与任何只关心"这批有哪些 target"的调用方继续可用。
 *  新代码应直接用 buildUnidentifiedWorkUnits（单元边界是派活的必需信息，见 §3.2.1）。 */
export function buildUnidentifiedTargets(
  lib: Pick<LibraryRepo, 'listParkedPaths'>,
  opts: BuildTargetsOptions = {},
): FindSubtitleTargetFact[] {
  return buildUnidentifiedWorkUnits(lib, opts).flatMap((u) => u.targets)
}

export interface UnidentifiedFindSubtitleWorkerDeps {
  model: LanguageModel
  cacheRoot: string
  /** Test phase per spec: no production step cap yet — observe actual step counts first.
   *  @default 500 */
  stepCap?: number
  /** 全量 TmdbClient——喂识别证据工具（search/getDetails/getSeasonTable）。cmdWatch 顶部
   *  已把 TMDB_API_KEY 做成硬前置，恒非空。
   *  第 7 步 C 组（2/2）：原注释还写着"也喂 identityDeps（write_identified_media 需要
   *  getDetails/getChineseTitles/getExternalIds/getOriginLanguage 四面富化）"——该工具已删，
   *  那半句已作废。 */
  tmdb: TmdbClient
  /** 第 7 步 C 组（2/2）：不再流向 worker 构造（identityDeps 已删），见下方
   *  makeUnidentifiedFindSubtitleWorker 头注释末段。 */
  lib: LibraryRepo
}

/** 组装未识别 scope 的 worker（管线拆分，2026-07-28）：identifyOnly——只做识别，字幕工具
 *  零挂载。adapters 从此不进这条链（省掉 provider 组装成本，也让"识别 run 绝不可能碰
 *  字幕工具"成为构造期事实而非运行期约定）。identifyOnly flag 是权威开关，不从 adapters
 *  空数组魔法推导。
 *
 *  ⚠️ 第 7 步 C 组（2/2）：**本函数产出的 worker 已无落库通道**。原本这里还传
 *  `identityDeps: { lib, tmdb }`，那是 write_identified_media 工具（agent/identityTools.ts）
 *  的唯一生产供应点，也是 series/episodes/movies 三张旧表最后的 INSERT 路径。该工具已随本
 *  组删除，理由是它整条上游链自第 2 步切换生产入口起就不可达：本函数唯一调用点是
 *  cli/index.ts 的 handleWorkerTask scope==='unidentified' 分支，而 handleWorkerTask 是零
 *  调用者孤儿（见该函数头注释的事实链）。
 *
 *  连带事实：deps.lib 现在只被本文件的 runner（runUnidentifiedFindSubtitleWorkerTask）用，
 *  不再流向 worker 构造；本函数的 deps.lib 字段因此成为纯签名残留，刻意保留——删它要动
 *  UnidentifiedFindSubtitleWorkerDeps 的形状与 cli/index.ts 的构造点，而整条链的退役属于
 *  "旧 jobs 队列整体退役"那个独立决策，不在本组范围。 */
export function makeUnidentifiedFindSubtitleWorker(deps: UnidentifiedFindSubtitleWorkerDeps) {
  return makeFindSubtitleWorker({
    model: deps.model,
    adapters: [],
    cacheRoot: deps.cacheRoot,
    stepCap: deps.stepCap,
    tmdb: deps.tmdb,
    identifyOnly: true,
  })
}

export interface UnidentifiedFindSubtitleTaskDeps {
  lib: LibraryRepo
  /** 配置媒体根白名单（OUTER 沙盒）——每次派发新鲜读取（同库行 scope 的既有口径）。 */
  mediaRoots: string[]
  targetLanguage: string
  hardsubMode: 'off' | 'agent' | 'aggressive'
  runTask: (task: FindSubtitleTask) => Promise<FindSubtitleBatchReport>
  /** 退役T1 (W0-3a) 同口径：可选，缺席时只排空 trace 缓冲不落 runs 行。 */
  runs?: Pick<RunsRepo, 'insert'>
  /** 作品单元分组参数（spec §3.2/§3.3）。缺省时用 mediaRoots 作 roots、Date.now() 作 now、
   *  DEFAULT_UNIT_LIMIT/MAX_TARGETS_PER_JOB 作上限。测试注入以精确控制分组边界。 */
  groupOpts?: { roots?: readonly string[]; unitLimit?: number; maxTargets?: number }
}

/** Claims-and-runs 一行 payload.scope==='unidentified' 的 find_subtitle worker_task。
 *  契约镜像 runFindSubtitleWorkerTask（同文件注释）：worker/mapper 抛错一律兜进
 *  completeError + 退避，绝不让异常逃出炸 daemon 的 claim 循环；空报告（含幻觉过滤后
 *  全空）视为失败调用走 completeError；retry_later 走 completeError 节流轨；其余
 *  completeDone。识别不出时 parked 行的 park_reason 只在有 search 证据时回写（反幻觉门），
 *  但**退避轨无条件前进**（bumpParkedRetry，四条失败路径全接线）——这是活锁防线，见
 *  spec 2026-08-07 §3.3.1 与下方 bumpUnit 的注释。（历史注释曾写"重试节奏由 ingest 的退避
 *  阶梯决定，不在这层另建一套"——那是本层零推进导致坏单元恒排队首的根因，已作废。）
 *
 *  🔴 逐单元派活（spec 2026-08-07 §2 + §3.2.1，2026-08-06 夜生产事故的修复）：
 *  事故形状——干净库 + 全绿 doctor + 492 个真媒体文件，本 job 连续 10 次以同一错误失败、
 *  agent 一次都没跑起来：`拒绝在媒体根目录之外写入: /hostroot/mnt/nvme0n1-4/nas_media`。
 *  根因是本函数曾对**全批**目标求 commonDir（全局公共祖先）再校验该祖先在配置根内：目标散落
 *  Movies/TV/anime 三个配置根时，公共祖先必是它们的父目录 nas_media，而 MEDIA_ROOTS 里只有
 *  那三个子目录 → 必抛。"全局公共祖先在配置根内"这个约束与多根部署**逻辑上不可同时满足**，
 *  所以那对"求祖先 + 校验祖先"是设计缺陷，不是安全网（spec §2 的定罪）——已删除。
 *
 *  现在一个 job = N 个作品单元（buildUnidentifiedWorkUnits），**逐单元串行派 worker**，每个
 *  单元的 task.mediaRoot = 该单元的作品根（workRootOf 的推导保证它天然在某个配置根内）。
 *  保留的是 ①：逐目标 assertDirSafe——那才是真正的 OUTER 沙盒门（每个目标目录必须在配置根内
 *  且可写），安全性一步不退。
 *
 *  为什么串行而不是并发：identify agent 每单元一次 LLM run，并发会同时撞 TMDB 限流与 LLM 配额，
 *  且 stagingSandbox 的沙盒目录按 task.jobId 命名（`<stagingRoot>/.subtitle-staging/<jobId>/`），
 *  同 job 内并发的两个单元会互相 cleanup 掉对方的沙盒。串行下 allocate→cleanup 严格不重叠。
 *
 *  为什么"一个 job 处理全部单元"而不是"只处理 units[0]、其余留下一轮"：后者把吞吐绑死在
 *  orchestrator 的派发节奏上（每轮只推进一个单元），而 UNIT_LIMIT=3 的存在本身就是活锁防线的
 *  一部分（spec §3.3.1：单点失败不停摆）——只跑第一个等于把 UNIT_LIMIT 事实上退回 1，那正是
 *  一轮初稿被二轮审计推翻的错。 */
export async function runUnidentifiedFindSubtitleWorkerTask(
  job: Job,
  deps: UnidentifiedFindSubtitleTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError'>,
  now: () => number,
): Promise<FindSubtitleBatchReport | null> {
  const startedAt = now()
  // 痕迹通道 C 收官快照——runKey 拼法与 findSubtitleWorker.ts 的 onStepEvent 接线处一致
  // （`job-${jobId}`），同 runFindSubtitleWorkerTask 的既有口径。
  //
  // 🔴 逐单元派活后 runKey 仍是**一个**（全部单元共用 String(job.id) 当 task.jobId）：realign
  // 那种逐子集 runKey（`job-${id}-${sub}`）会让 apiV2.ts buildWorkflowWorkers 的
  // `traceBus.peek('job-'+id)` 直播补拉整体空转（它只对 taskType==='realign' 走 peekPrefix），
  // 为一个内部分组细节牺牲 WorkerCard 的直播面不值得。单元级的证据判定改用"跑前/跑后计数
  // 之差"实现（见下方 searchEvidenceCount）。
  const runKey = `job-${job.id}`
  let traceJsonCache: string | null | undefined
  const traceJsonForThisRun = (): string | null => {
    if (traceJsonCache === undefined) {
      const events = traceBus.snapshot(runKey)
      traceJsonCache = events.length > 0 ? JSON.stringify(events) : null
    }
    return traceJsonCache
  }
  /** 逐单元派活的配套：每个单元开跑前把快照缓存清空，让该单元的 runs 行拿到**它自己**那段
   *  trace。不重置的后果是缓存在第一个单元的 recordRun 时定型，后续单元的 runs 行全部
   *  traceJson=null——多单元 job 的过程证据只剩第一个单元的。snapshot 自身会清空缓冲，所以
   *  重置后的第一次调用天然只捞到上次清空之后（即本单元）产生的事件。 */
  const resetTraceCacheForNextUnit = (): void => {
    traceJsonCache = undefined
  }
  const recordRun = (decision: string, detail: string): void => {
    // traceJsonForThisRun() 必须先于可选链求值（runs 缺席=只排空不落账）——同
    // runFindSubtitleWorkerTask 的复审修复口径。
    const traceJson = traceJsonForThisRun()
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: capDetail(detail), journalPath: null,
      traceJson,
    })
  }
  /** trace 缓冲里有没有 search_tmdb——反编造门（B1）的判据。peek 是非破坏性读，绝不能用
   *  snapshot：那会提前抽干 runs 行的 trace 快照（见 traceBus.ts snapshot 注释："重复调用第二次
   *  起只会拿到空数组"）。
   *
   *  🔴 已知债务（逐单元派活引入，spec §2 改动 A）：判据是**job 级**的"有没有搜过"，不是单元级
   *  增量。多单元 job 里，若单元 A 真搜过、单元 B 编造 unidentified，B 也会被判为有证据 →
   *  reason 被回写（最坏形态：kind=insufficient-evidence 把 B 的路径永久钉死等用户改名）。
   *  为什么本轮不改成"跑前/跑后计数之差"：那个判据要求 trace 事件全部产生在 runTask 期间，而
   *  既有三条回归锁的夹具是在 runTask **之前**往 traceBus 预置 search_tmdb 事件（见
   *  unidentifiedFindSubtitle.test.ts 的 traceBus.publish 调用点）——改判据会把那三条锁一起改掉，
   *  超出本轮"让工作流跑起来"的范围。真正的干净解法是给每个单元一个 runKey 后缀
   *  （`job-${id}-u${i}`，同 realign 的逐集 runKey 先例），但那要连带改 apiV2.ts
   *  buildWorkflowWorkers 的直播补拉（它只对 taskType==='realign' 走 peekPrefix，find_subtitle
   *  走单 key peek → WorkerCard 直播会整体空转）。条件成熟时一并做。 */
  const hasSearchEvidence = (): boolean =>
    traceBus.peek(runKey, 512).some((e) => e.tool === 'search_tmdb')

  try {
    const units = buildUnidentifiedWorkUnits(deps.lib, {
      roots: deps.groupOpts?.roots ?? deps.mediaRoots,
      now: now(),
      unitLimit: deps.groupOpts?.unitLimit,
      maxTargets: deps.groupOpts?.maxTargets,
    })
    if (units.length === 0) {
      // Idempotent no-op：被 claim 时已无 eligible parked 行（可能都被认领先识别走了）。
      jobs.completeDone(job.id, now())
      return null
    }

    // 合并面（本函数的返回值）：各单元报告的四个桶按处理顺序拼接。identity 是**单元级**结论
    // （schema 注释已定性它建模的是"一个 task 一个身份"），多单元时单一 identity 语义上是胡话，
    // 所以只在恰好一个单元时透传——每个单元的识别结论都已经各自落了一行 runs（decision=
    // identity / identity_unidentified），账目不因这里返回 null 而丢失。
    const merged: FindSubtitleBatchReport = {
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }
    let sawAnyReport = false
    /** 各单元的失败理由（顺序即处理顺序）。全部单元跑完后统一收官：有失败 → completeError
     *  （取第一条当 last_error，其余计数在文案里），全成 → completeDone。 */
    const failures: string[] = []

    for (const unit of units) {
      const targets = unit.targets
      if (targets.length === 0) continue
      resetTraceCacheForNextUnit()
      // 🔴 活锁防线的单元级闭包（spec §3.3.1）：**按单元粒度** bump——哪个单元失败 bump 哪个，
      // 一个单元失败绝不把整批的退避轨一起推（那会让同批的健康单元被无辜推后，下一轮反而
      // 排到坏单元后面）。收成闭包而不是四处抄 for 循环：让"每个失败出口都 bump 了吗"这个
      // 不变量目视可查。
      const bumpUnit = () => {
        for (const t of targets) deps.lib.bumpParkedRetry(t.videoPath, now())
      }
      try {
        // OUTER 沙盒门（①，同库行 mapper 的既有防线）：每个 parked 目录必须在配置根内且可写。
        // 🔴 这是删掉 commonDir ②③ 之后**唯一**也是真正的沙盒边界，安全性不许回退。
        for (const t of targets) assertDirSafe(dirname(t.videoPath), deps.mediaRoots)
        // INNER 沙盒根 = 该单元的作品根（spec §2 的改法）。§3.2 的推导保证它在某个配置根内，
        // 所以 stagingRootFor 的 containingRoot 正常路径下必然命中（异常路径——mediaRoots 为空
        // 的开发态、派发与执行之间用户删了守备目录——沿用它既有的 warn + 退化返回 dir 本身，
        // 不抛错，见 spec §3.2.1 的裁决）。
        const mediaRoot = unit.workRoot
        const task: FindSubtitleTask = {
          jobId: String(job.id),
          mediaRoot,
          stagingRoot: stagingRootFor(mediaRoot, deps.mediaRoots, job.id),
          // 单元级上下文（spec §3.4）：work-dir 时 prompt 可以说"这批是同一部作品的完整文件集，
          // 一次搜索覆盖全部"；flat-batch（配置根下的扁平文件合成单元）绝不能那么说——那批
          // target 彼此不是同一部作品。零 FindSubtitleTargetFact schema 改动是刻意的：那个类型
          // 被 realignExecutor.ts（圣文件）复用，见 findSubtitleWorker.schemas.ts:50-52。
          workUnitKind: unit.kind,
          // 无身份可猜——prompt 的 unidentified 分支不渲染这些字段（见 findSubtitleWorker.ts），
          // 这里给类型的空值，不虚构一个 title。
          title: '',
          originalTitle: null,
          year: null,
          alternativeTitles: [],
          overview: null,
          runtimeMinutes: null,
          providerIds: {},
          targetLanguage: deps.targetLanguage,
          hardsubMode: deps.hardsubMode,
          localCandidates: [], // parked 文件没有库行/副本体系，无本地候选可传播
          targets,
        }
        const report = await deps.runTask(task)
        sawAnyReport = true

        // itemId 幻觉防线（本 scope 的变体）：有效 itemId = 识别落地后真实存在于库、且其 path
        // 属于**本单元** parked 目标的行。agent 上报的任何其它 id（旧库行/纯幻觉/别的单元的
        // 行）一律丢弃告警——markCovered/markUnavailable 都是两表盲 UPDATE，幻觉 id 可能砸中
        // 任何行。
        const targetPaths = new Set(targets.map((t) => t.videoPath))
        const isOwnedItemId = (itemId: string): boolean => {
          const ep = deps.lib.getEpisode(itemId)
          if (ep) return targetPaths.has(ep.path)
          const mv = deps.lib.getMovie(itemId)
          if (mv) return targetPaths.has(mv.path)
          return false
        }
        // 六轮血案第三例（job 34，见 findSubtitleWorker.schemas.ts 的 itemId 头注释）：schema 已
        // 容忍 installed 项 itemId:null（工具层容忍、prompt 明示 null，finalize 不得拒收）。null
        // 的归属由这里反解：install_subtitle 把字幕装在视频旁（`<video-stem>.<langTag><ext>`，
        // 见 findSubtitleWorker.tools.ts finalPath），所以 dirname(installedPath) 恒等于归属
        // target 的 dirname(videoPath)，且字幕 basename 以视频 stem + '.' 为前缀。命中唯一
        // target 后查该 videoPath 的库行（write_identified_media 刚建的），行的 id 即真 itemId。
        // 反解失败 → 丢弃告警（同 dropAlien 的口径），绝不猜。
        const rowIdByPath = (videoPath: string): string | null => {
          const ep = deps.lib.db.prepare(`SELECT id FROM episodes WHERE path = ?`).get(videoPath) as
            | { id: string } | undefined
          if (ep) return ep.id
          const mv = deps.lib.db.prepare(`SELECT id FROM movies WHERE path = ?`).get(videoPath) as
            | { id: string } | undefined
          return mv?.id ?? null
        }
        const resolveNullItemId = (installedPath: string): string | null => {
          const subDir = dirname(installedPath)
          const subBase = basename(installedPath)
          const owner = targets.filter((t) => {
            if (dirname(t.videoPath) !== subDir) return false
            const stem = basename(t.videoPath).replace(/\.[^.]+$/, '')
            return subBase.startsWith(`${stem}.`)
          })
          if (owner.length !== 1) return null // 零命中或歧义都不猜
          return rowIdByPath(owner[0].videoPath)
        }
        const resolvedInstalled = report.installed.flatMap((x) => {
          if (x.itemId != null) return [{ ...x, itemId: x.itemId }]
          const resolved = resolveNullItemId(x.installedPath)
          if (resolved) return [{ ...x, itemId: resolved }]
          console.error(
            `[find-subtitle-unidentified] job ${job.id}: dropping installed entry with itemId:null — ` +
              `could not resolve owning library row from installedPath ${x.installedPath}`,
          )
          return []
        })
        // unresolved 桶的 null itemId 没有 installedPath 可反解——无法归属任何行，丢弃告警。
        // （unidentified 结局的 park-reason 回写走 targetPaths 整批覆盖，丢这条不损失账目。）
        const dropNullUnresolved = <T extends { itemId: string | null; reason: string }>(
          bucket: T[], name: string,
        ): (T & { itemId: string })[] =>
          bucket.flatMap((x) => {
            if (x.itemId != null) return [{ ...x, itemId: x.itemId }]
            console.error(
              `[find-subtitle-unidentified] job ${job.id}: dropping ${name} entry with itemId:null ` +
                `(no installedPath to resolve from; reason was: ${x.reason})`,
            )
            return []
          })
        const dropAlien = <T extends { itemId: string }>(bucket: T[], name: string): T[] =>
          bucket.filter((x) => {
            if (isOwnedItemId(x.itemId)) return true
            console.error(
              `[find-subtitle-unidentified] job ${job.id}: dropping itemId ${x.itemId} from ${name} ` +
                `(not a library row created from this task's parked targets)`,
            )
            return false
          })
        const installed = dropAlien(resolvedInstalled, 'installed')
        const noMatch = dropAlien(dropNullUnresolved(report.no_safe_match, 'no_safe_match'), 'no_safe_match')
        const retryLater = dropAlien(dropNullUnresolved(report.retry_later, 'retry_later'), 'retry_later')
        const hardsubAssumed = dropAlien(dropNullUnresolved(report.hardsub_assumed, 'hardsub_assumed'), 'hardsub_assumed')

        // 语义反转闸（findSubtitleWorker.schemas.ts 的 identity 字段文档："后者由 runner 层把关"）：
        // identity.outcome==='unidentified' 时 installed 必须为空——身份未定时装的字幕会记到错的
        // 库行上。丢弃要吼出来，不静默。
        const installedToRecord = report.identity?.outcome === 'unidentified' ? [] : installed
        if (report.identity?.outcome === 'unidentified' && installed.length > 0) {
          console.error(
            `[find-subtitle-unidentified] job ${job.id}: DROPPING ${installed.length} installed item(s) — ` +
              `report's identity outcome is 'unidentified' (${report.identity.reason}), ` +
              `so installs would be recorded against no verified identity: ` +
              installed.map((i) => i.itemId).join(', '),
          )
        }

        // Task 3（park 原因二分回写）：agent 报 unidentified 时把 kind 落回 parked_paths，
        // 负缓存的指纹门（shouldRetryParkedPath）由此分得开"确定不自愈（insufficient-evidence，
        // 指纹未变永不重试）"和"可能自愈（identification-failed，照常退避）"。
        // 🔴 必须用 updateParkReason 而非 upsertParkedPath——后者在 reason 变化时把退避阶梯
        // 重置回 1h 档，identification-failed 会每轮归零永远停在 1h。
        // 🔴 只回写**本单元**的目标路径（targetPaths，同上方 itemId 幻觉防线的纪律）；识别成功
        // 的路径已被 write_identified_media 的事务 clearParkedPath 清出 parked——
        // updateParkReason 对不存在的行无事发生（幽灵防御），不会复活户口。
        //
        // 🔴 B1 反编造审计（2026-07-28 同夜事故：识别阶段烧尽步数后，agent 把 384 个目标
        // 凭空报成 no_safe_match/unidentified，理由写"searched all providers"——实际从没搜过）：
        // unidentified 结论必须有调查证据——trace 里至少一条 search_tmdb 调用。零搜索的
        // unidentified 主张不作数：不回写 park 原因（insufficient-evidence 会把路径永久钉死，
        // 那等于把编造落库成"确定不自愈"），park 保持 awaiting-agent-identification 照常退避，
        // 大声告警。这是防御层的粗门（exactly 今夜事故的复盘形状），不误伤正常情况——正常
        // 识别流程必然至少 search 一次（two-evidence bar 的 Step 1）。判据的 job 级粒度与它的
        // 已知债务见 hasSearchEvidence 的头注释。
        if (report.identity?.outcome === 'unidentified') {
          if (!hasSearchEvidence()) {
            console.error(
              `[find-subtitle-unidentified] job ${job.id}: report claims unidentified ` +
                `(${report.identity.reason}) but the trace contains ZERO search_tmdb calls — ` +
                `the claim is unsubstantiated fabrication (steps-exhausted give-up shape). ` +
                `REFUSING park-reason writeback; ${targetPaths.size} path(s) keep awaiting-agent-identification and will retry.`,
            )
          } else {
            for (const path of targetPaths) {
              deps.lib.updateParkReason(path, report.identity.kind, now())
            }
          }
          // 🔴 活锁防线（spec §3.3.1，二轮审计 R2-B1）：无论 reason 回写与否，退避轨都必须前进。
          // 这两件事的判据不同——reason 回写要过"有 search 证据"的反幻觉门（编造的结论不许污染
          // reason），而"试过一次"是与 agent 说了什么无关的**机械事实**，无条件记。
          // 缺这一步的后果（生产实测）：编造分支原本零 DB 写 → last_attempt/retry_count 双不动 →
          // 该单元永远"最老且退避窗恒开" → 恒排组批队首 → 整个队列被它卡死。
          bumpUnit()
        }

        // 事实先入账（同 runFindSubtitleWorkerTask 的 R-3 终局口径）。
        for (const item of installedToRecord) {
          // candidateProviderId 已含 "provider:" 前缀（candidateKey 复合形态）则原样使用——同
          // runFindSubtitleWorkerTask 的 W2 双前缀修复口径。
          const providerRef =
            item.candidateProvider && item.candidateProviderId
              ? item.candidateProviderId.includes(':')
                ? item.candidateProviderId
                : candidateKey({ provider: item.candidateProvider, providerId: item.candidateProviderId })
              : undefined
          deps.lib.markCovered(
            item.itemId, item.installedPath, 'scout-download', providerRef,
            item.installedLanguage ?? task.targetLanguage, item.reason,
          )
        }
        for (const item of noMatch) deps.lib.markUnavailable(item.itemId, item.reason, now())
        for (const item of hardsubAssumed) deps.lib.markHardsubAssumed(item.itemId, item.reason, now())

        merged.installed.push(...installedToRecord)
        merged.no_safe_match.push(...noMatch)
        merged.retry_later.push(...retryLater)
        merged.hardsub_assumed.push(...hardsubAssumed)
        // 🔴 `merged.identity` **零消费方**，不承载任何控制流（方案 2026-08-07-identity-decoupling-plan
        // §4 改动 4）：唯一读点是本函数末尾 `return sawAnyReport ? merged : null`，而唯一调用方
        // cli/index.ts:462 是裸 `await` 丢弃返回值。多单元 job 里它恒为 null（units.length !== 1），
        // 那是**正常状态**不是 bug —— 每个单元的识别结论都已各自落一行 runs（见下方 recordRun
        // ('identity'/'identity_unidentified')），账目不因这里是 null 而丢失。
        // 本文件所有读 identity 的控制流（装盘门 :423、反编造门 :450、下方失败分支的守卫）读的
        // 都是循环内的 `report.identity`（单元级正常值）。方案 v1 正是误把这两者混为一谈才误诊出
        // "三处控制流失效"，整套修复建立在不存在的病上（方案 §9）。改这行前先确认读点仍是零。
        if (units.length === 1) merged.identity = report.identity

        if (installedToRecord.length === 0 && noMatch.length === 0 && retryLater.length === 0 && hardsubAssumed.length === 0) {
          // 🔴 身份产出维度（方案 2026-08-07-identity-decoupling-plan §3/§4 改动 2）：四个桶全是
          // **字幕**结果，而 identifyOnly worker 字幕工具零挂载（findSubtitleWorker.ts:209，
          // 2026-07-28 管线拆分事故的修复措施）——识别成功的单元**必然**四桶全空。拿"字幕产出"
          // 当唯一成功判据去衡量一个不负责找字幕的 worker，是判据用错了对象。
          // 后果不是"日志刷红"：每条误判都走 completeError → error_attempt 单调累积
          // （30s → 15min → 每天，jobsRepo.ts:402-405），而 orchestrator 下一轮重派**缩不短它**
          // （upsertWorkerTask 对 failed 态走 coalesced，只刷 payload 不动 next_retry_at，
          // jobsRepo.ts:185-188）→ 自加速退化：识别越顺 → 红得越多 → 退避越长。
          //
          // 判据必须是**机械事实**，不能问 agent（identity 是 advisory schema，
          // findSubtitleWorker.schemas.ts:172-177，且会被 nullableJsonTolerantCaught 静默折叠）。
          // 显式 const 而不是内联进 if：调试时要看得见这个中间值（计划自审 ①）。
          const stillParked = deps.lib.countParked(targets.map((t) => t.videoPath))
          if (stillParked < targets.length) {
            // **有产出**：差值 > 0 ⇒ 至少一条路径被清出 parked ⇒ 身份落库发生了。
            // 🔴 第 7 步 C 组（2/2）：这个分支曾由 write_identified_media 的事务
            // （无条件 clearParkedPath）触发——该工具已随 agent/identityTools.ts 删除，本
            // worker 形态已无任何落库通道，因此这条差值现在**恒为 0**、本分支恒不进入。
            // 保留而不删：整条链（本 runner ← handleWorkerTask 零调用者孤儿）本身已不可达，
            // 它的退役属于"旧 jobs 队列整体退役"那个独立决策，见
            // makeUnidentifiedFindSubtitleWorker 头注释末段。
            // 识别成功但没找到字幕 —— 这是本 worker 形态下的**正常终局**，不是失败。
            // 字幕由 orchestrator 下一轮派 per-series find_subtitle 去找：落
            // sub_status='missing' → libraryRepo missingBySeason/missingMovies 都计入 →
            // orchestratorAgent.tools.ts 的 list_missing_coverage 读得到（方案 §6 已验证该链通）。
            // 🔴 不 bump：已识别的路径**已不在 parked 表里**（bump 对它是空操作），而剩下未识别的
            // 路径下一轮自然重来 —— 这个单元整体是"有进展"，不该被推退避。
            // completeDone 也不会卡住：unidentified-backlog 是固定合成 identity，upsertWorkerTask
            // 的 done 分支把 state 改回 wanted 且 attempt/error_attempt/next_retry_at 全部归零
            // （jobsRepo.ts:167-177）→ 下一轮立刻可跑。这正是"completeDone 严格优于 completeError"。
          } else {
            // 🔴 活锁防线（spec §3.3.1）：真的一无所获——退避轨必须前进，否则本单元的目标下一轮
            // 原样重来。典型来路是 agent 步数耗尽后交了一份空报告；**超时/抛错不走这里**
            // （那些跳过全部分支直接落 catch，见该处的第四条路径注释）。
            // 🔴 守卫（`!== 'unidentified'`）是**防与 `:468` 重复**，不是可有可无的装饰：
            // identity 分支对 outcome==='unidentified' 已无条件 bump 过一次（那是"agent 明确拒识"
            // 的路径）。三个形状各恰好 bump 一次（方案 §4 改动 3 的表）：
            //   有产出                              → 不进本分支，0 或 1（视 :468）
            //   无产出 + outcome==='unidentified'    → :468 一次，守卫在此拦住 = 1
            //   无产出 + 其它（含 identity===null）  → :468 不执行，本行一次     = 1
            // 回归锁 #4/#5（"retry_count 恰好 +1"）是这个位置正确性的唯一证据。
            if (report.identity?.outcome !== 'unidentified') bumpUnit()
            failures.push('worker returned an empty batch report')
            recordRun('error', 'empty batch report')
          }
        } else if (retryLater.length > 0) {
          // retry_later 同理：agent 明确说"这批现在做不了，稍后再来"，退避轨前进才是"稍后"的落点。
          if (report.identity?.outcome !== 'unidentified') bumpUnit()
          failures.push(`retry_later ${retryLater.length} item(s): ${capDetail(retryLater[0].reason)}`)
        } else {
          // 该单元成功——不记 failure，收官时若全部单元都走这条分支就 completeDone。
        }

        if (installedToRecord.length) {
          recordRun('installed', `${installedToRecord.length} 项入账: ${installedToRecord.map((i) => i.itemId).join(', ')}`)
        }
        if (noMatch.length) {
          recordRun('no_safe_match', `${noMatch.length} 项判无: ${noMatch.map((i) => `${i.itemId}(${i.reason})`).join('; ')}`)
        }
        if (retryLater.length) {
          recordRun('retry_later', `${retryLater.length} 项待重试: ${retryLater.map((i) => i.itemId).join(', ')}`)
        }
        if (hardsubAssumed.length) {
          recordRun('hardsub_assumed', `${hardsubAssumed.length} 项判定硬字幕假定: ${hardsubAssumed.map((i) => `${i.itemId}(${i.reason})`).join('; ')}`)
        }
        // agent-first 识别的可观测面：识别结论单独一行 runs（dashboard 时间线可见 agent 每轮
        // 识别出了什么/为什么识别不出）——write_identified_media 的落地细节在工具自身的
        // trace 里，这里记 finalize 上报的总结论。逐单元派活后**每个单元各记一行**，这正是
        // 多单元 job 里 identity 账目的落点（合并返回值里的 identity 因此可以是 null）。
        if (report.identity) {
          if (report.identity.outcome === 'identified') {
            recordRun(
              'identity',
              `agent 识别结论：tmdb:${report.identity.tmdbId} (isTv=${report.identity.isTv}, ` +
                `season=${report.identity.season}, episode=${report.identity.episode})；` +
                `名称证据：${report.identity.nameEvidence}；结构证据：${report.identity.structureEvidence}`,
            )
          } else {
            recordRun('identity_unidentified', `agent 未能识别：${report.identity.reason}`)
          }
        } else {
          // job 34 第二次失败的配套告警：identity 为 null 有两种来源——模型确实没做识别，或
          // schema 层把内层校验失败的 identity 折叠成了 null（nullableJsonTolerantCaught，见
          // coerce.ts）。折叠是无声的，这里必须吼一声：advisory 元数据丢失，park 原因回写本轮
          // 跳过——parked 行保持现有 reason 照常退避重试，这是安全默认。仅告警，零行为改变。
          console.error(
            `[find-subtitle-unidentified] job ${job.id}: report.identity is null ` +
              `(absent or folded from an inner validation failure) — advisory identity metadata lost; ` +
              `park-reason writeback skipped this round (parked rows keep their current reason and will retry).`,
          )
        }
      } catch (unitError) {
        // 🔴 活锁防线第四条路径（审计 B-2 实测定罪）：runTask 抛错（AbortSignal.timeout 的 1h
        // 硬顶、沙盒断言、worker 内部未捕获异常）会跳过上方全部分支落这里，而超时是生产上最
        // 高频的失败形态。此前这条路径零 parked 写 → 退避轨与 last_attempt 双不动 → 下一轮
        // 原样重来。
        // 🔴 catch 在**单元内层**（逐单元派活的直接推论）：一个单元炸了不许连坐其余单元——
        // 只 bump 它自己的路径、记一条失败，循环继续派下一个单元。
        const msg = unitError instanceof Error ? unitError.message : String(unitError)
        bumpUnit()
        failures.push(msg)
        recordRun('error', msg)
      }
    }

    // 收官（每个 job 恰好一次 completeDone/completeError）：任一单元失败 → completeError 走退避轨，
    // 全部单元成功 → completeDone。多单元失败时 last_error 取第一条 + 计数（jobs 表只有一个
    // last_error 列，逐条明细已在各单元自己的 runs 行里）。
    //
    // 为什么"有失败就 completeError"而不是"有成功就 completeDone"：completeError 是退避轨
    // （attempt+1 / next_retry_at 前进），done 会走 jobsRepo 的 done→revived 分支被下一轮 upsert
    // 复活成 wanted。失败单元的目标已由 bumpUnit 推进 parked 退避轨，不会活锁；把 job 记成 done
    // 会让"这一轮有单元失败了"这个事实在 jobs 表上不可见（last_error 恒空），运维查不到
    // ——§9.1 的冒烟判据 ④ 就是靠 jobs.last_error 定位越界事故的。
    if (failures.length > 0) {
      const detail = failures.length === 1
        ? failures[0]
        : `${failures[0]} (+${failures.length - 1} more unit failure(s) in this job)`
      jobs.completeError(job.id, detail, now())
    } else {
      jobs.completeDone(job.id, now())
    }
    return sawAnyReport ? merged : null
  } catch (error) {
    // 单元外层的兜底：组批本身抛错（listParkedPaths/分组推导）或收官写库抛错——异常绝不许逃出
    // 去炸 daemon 的 claim 循环。这条路径上"本批目标"这个概念可能还不存在，所以没有 bump 的
    // 对象（单元级 bump 全在上面的内层 catch 里，那才是失败路径的常态出口）。
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
    return null
  }
}
