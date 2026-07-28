import { basename, dirname } from 'node:path'
import type { LanguageModel } from 'ai'
import type { Job, JobsRepo } from '../v2/jobsRepo.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import { isParkedPathEligible, PARK_REASON } from '../v2/libraryRepo.js'
import type { RunsRepo } from '../v2/runsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { identifyFromPath } from '../recognition/identifyFromPath.js'
import { isUnderRoots } from '../core/mediaContext.js'
import { candidateKey } from '../core/schemas.js'
import { traceBus } from '../core/traceBus.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import type {
  FindSubtitleTask, FindSubtitleTargetFact, FindSubtitleBatchReport,
} from '../agent/findSubtitleWorker.schemas.js'
import {
  assertDirSafe, capDetail, commonDir, stagingRootFor,
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
export function buildUnidentifiedTargets(
  lib: Pick<LibraryRepo, 'listParkedPaths'>,
  limit = 60,
): FindSubtitleTargetFact[] {
  return lib.listParkedPaths()
    .filter((p) => isParkedPathEligible(p.park_reason))
    .filter((p) => p.park_reason !== PARK_REASON.insufficientEvidence)
    // 批次上限（管线拆分，2026-07-28 事故：446 文件一批直接烧穿 500 stepCap）：识别 3-5
    // 步/文件，60×5=300 < 500 留余量。最久 parked 的行先上（first_seen 最小=挂得最久）。
    // 🔴 不能直接吃 listParkedPaths 的顺序：它是 first_seen DESC——**最新的排最前**（其
    // 头注释写"挂得最久的排最前"是错的，libraryRepo.test.ts 的排序测试锁死了 DESC=新→旧
    // 语义；那是救援页"新问题先看"的口径，不是本处要的公平队列）。这里显式按 first_seen
    // ASC 重排后掐头 limit 条；eligibility 过滤在前，ineligible 行不挤占名额。余量留 park
    // 不动——orchestrator 的固定 identity（'unidentified-backlog'）upsert 会把 done 行复活
    // 成 wanted（jobsRepo.upsertWorkerTask 的 done→revived 分支），下一轮自然接着派。
    .sort((a, b) => a.first_seen - b.first_seen)
    .slice(0, limit)
    .map((p) => {
      // 结构提示（纯路径解析，同步、零 I/O）——'no-signal' park 时全部 null。
      const identity = identifyFromPath(p.path)
      const hints = 'park' in identity
        ? { season: null, episode: null, absoluteEpisode: null }
        : identity
      // embedded_langs 是 JSON 数组串（与 episodes/movies 同构）；坏 JSON 按未探测处理，
      // 不阻塞上车（同 identityTools.ts 的容错口径）。
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
    })
}

export interface UnidentifiedFindSubtitleWorkerDeps {
  model: LanguageModel
  cacheRoot: string
  /** Test phase per spec: no production step cap yet — observe actual step counts first.
   *  @default 500 */
  stepCap?: number
  /** 全量 TmdbClient——既喂识别证据工具（search/getDetails/getSeasonTable），也喂
   *  identityDeps（write_identified_media 需要 getDetails/getChineseTitles/getExternalIds/
   *  getOriginLanguage 四面富化）。cmdWatch 顶部已把 TMDB_API_KEY 做成硬前置，恒非空。 */
  tmdb: TmdbClient
  lib: LibraryRepo
}

/** 组装未识别 scope 的 worker（管线拆分，2026-07-28）：identifyOnly——只做识别，字幕工具
 *  零挂载。adapters 从此不进这条链（省掉 provider 组装成本，也让"识别 run 绝不可能碰
 *  字幕工具"成为构造期事实而非运行期约定）。identifyOnly flag 是权威开关，不从 adapters
 *  空数组魔法推导。 */
export function makeUnidentifiedFindSubtitleWorker(deps: UnidentifiedFindSubtitleWorkerDeps) {
  return makeFindSubtitleWorker({
    model: deps.model,
    adapters: [],
    cacheRoot: deps.cacheRoot,
    stepCap: deps.stepCap,
    tmdb: deps.tmdb,
    identityDeps: { lib: deps.lib, tmdb: deps.tmdb },
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
}

/** Claims-and-runs 一行 payload.scope==='unidentified' 的 find_subtitle worker_task。
 *  契约镜像 runFindSubtitleWorkerTask（同文件注释）：worker/mapper 抛错一律兜进
 *  completeError + 退避，绝不让异常逃出炸 daemon 的 claim 循环；空报告（含幻觉过滤后
 *  全空）视为失败调用走 completeError；retry_later 走 completeError 节流轨；其余
 *  completeDone。识别不出/parked 行保持 park 不动——重试节奏由 ingest 的 parked 退避
 *  阶梯决定，不在这层另建一套。 */
export async function runUnidentifiedFindSubtitleWorkerTask(
  job: Job,
  deps: UnidentifiedFindSubtitleTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError'>,
  now: () => number,
): Promise<FindSubtitleBatchReport | null> {
  const startedAt = now()
  // 痕迹通道 C 收官快照——runKey 拼法与 findSubtitleWorker.ts 的 onStepEvent 接线处一致
  // （`job-${jobId}`），同 runFindSubtitleWorkerTask 的既有口径。
  const runKey = `job-${job.id}`
  let traceJsonCache: string | null | undefined
  const traceJsonForThisRun = (): string | null => {
    if (traceJsonCache === undefined) {
      const events = traceBus.snapshot(runKey)
      traceJsonCache = events.length > 0 ? JSON.stringify(events) : null
    }
    return traceJsonCache
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
  try {
    const targets = buildUnidentifiedTargets(deps.lib)
    if (targets.length === 0) {
      // Idempotent no-op：被 claim 时已无 eligible parked 行（可能都被认领先识别走了）。
      jobs.completeDone(job.id, now())
      return null
    }

    // OUTER 沙盒门（同库行 mapper 的既有防线）：每个 parked 目录必须在配置根内且可写。
    for (const t of targets) assertDirSafe(dirname(t.videoPath), deps.mediaRoots)
    const dirs = [...new Set(targets.map((t) => dirname(t.videoPath)))]
    const mediaRoot = commonDir(dirs)
    if (!isUnderRoots(mediaRoot, deps.mediaRoots)) {
      // 逐目标检查已过的组合态兜底（目标散落多根、公共祖先越出全部配置根）——文案同
      // findSubtitleWorkerTask.ts 的同款检查。
      throw new Error(`拒绝在媒体根目录之外写入: ${mediaRoot} — 检查 MEDIA_ROOTS 配置（或 dashboard 设置页的守备目录）`)
    }

    const task: FindSubtitleTask = {
      jobId: String(job.id),
      mediaRoot,
      stagingRoot: stagingRootFor(mediaRoot, deps.mediaRoots, job.id),
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

    // itemId 幻觉防线（本 scope 的变体）：有效 itemId = 识别落地后真实存在于库、且其 path
    // 属于本批 parked 目标的行。agent 上报的任何其它 id（旧库行/纯幻觉）一律丢弃告警——
    // markCovered/markUnavailable 都是两表盲 UPDATE，幻觉 id 可能砸中任何行。
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
    // 🔴 只回写本 task 的目标路径（targetPaths，同上方 itemId 幻觉防线的纪律）；识别成功
    // 的路径已被 write_identified_media 的事务 clearParkedPath 清出 parked——
    // updateParkReason 对不存在的行无事发生（幽灵防御），不会复活户口。
    //
    // 🔴 B1 反编造审计（2026-07-28 同夜事故：识别阶段烧尽步数后，agent 把 384 个目标
    // 凭空报成 no_safe_match/unidentified，理由写"searched all providers"——实际从没搜过）：
    // unidentified 结论必须有调查证据——trace 里至少一条 search_tmdb 调用。零搜索的
    // unidentified 主张不作数：不回写 park 原因（insufficient-evidence 会把路径永久钉死，
    // 那等于把编造落库成"确定不自愈"），park 保持 awaiting-agent-identification 照常退避，
    // 大声告警。这是防御层的粗门（exactly 今夜事故的复盘形状），不误伤正常情况——正常
    // 识别流程必然至少 search 一次（two-evidence bar 的 Step 1）。
    if (report.identity?.outcome === 'unidentified') {
      // peek 非破坏性读——snapshot() 会清空缓冲，提前抽干 runs 行的 trace 快照（见
      // traceBus.ts snapshot 注释："重复调用第二次起只会拿到空数组"）。
      const traceTools = traceBus.peek(runKey, 512).map((e) => e.tool)
      const hasSearchEvidence = traceTools.includes('search_tmdb')
      if (!hasSearchEvidence) {
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

    if (installedToRecord.length === 0 && noMatch.length === 0 && retryLater.length === 0 && hardsubAssumed.length === 0) {
      jobs.completeError(job.id, 'worker returned an empty batch report', now())
      recordRun('error', 'empty batch report')
    } else if (retryLater.length > 0) {
      jobs.completeError(
        job.id, `retry_later ${retryLater.length} item(s): ${capDetail(retryLater[0].reason)}`, now(),
      )
    } else {
      jobs.completeDone(job.id, now())
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
    // trace 里，这里记 finalize 上报的总结论。
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
    return report
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
    return null
  }
}
