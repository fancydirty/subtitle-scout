import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import {
  type MediaContext, type MediaIdentity, type SearchPlan, type RankDecision,
  type OrphanDecision, type SeasonMap, type SubtitleCandidate, type ProviderName,
  type VerifyDecision,
  candidateKey, parseCandidateKey,
} from './schemas.js'
import type { CallStructuredResult } from '../agent/llm.js'
import type { LlmRuntime } from '../agent/runtime.js'
import { Journal } from './journal.js'
import { DecisionCache, cacheKeys, type CacheEntry } from './cache.js'
import { runGate, type GateQueueItem } from './gate.js'
import { runOrphanGate } from './orphanGate.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import { inspectSubtitle, type InspectSignals } from '../files/subtitleInspect.js'
import type { DownloadResult } from '../adapters/download/direct.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'
import { filterGraphicOnly } from '../agent/rankCandidates.js'
import { runSeasonPackGate } from './seasonPackGate.js'
import type { SeasonEpisode } from './episode.js'
import { harvestAlias, hasCjk } from '../agent/harvestAlias.js'
import { mapLooseEpisodes } from '../agent/mapLooseEpisodes.js'
import { ProviderQuotaExhaustedError, type ProviderPort } from './providerPort.js'
import { containingRoot } from './mediaContext.js'

export interface PipelineDeps {
  identify: (ctx: MediaContext) => Promise<CallStructuredResult<MediaIdentity>>
  plan: (ctx: MediaContext, id: MediaIdentity) => Promise<CallStructuredResult<SearchPlan>>
  rank: (ctx: MediaContext, id: MediaIdentity, cands: SubtitleCandidate[]) => Promise<CallStructuredResult<RankDecision>>
  /** staging 沙盒终审：候选下载+体检后，agent 对"是不是这份资源的字幕"二选一表态。 */
  verify: (ctx: MediaContext, id: MediaIdentity, candidate: SubtitleCandidate, signals: InspectSignals) => Promise<CallStructuredResult<VerifyDecision>>
  providers: ProviderPort
  download: (url: string) => Promise<DownloadResult>
  cache: DecisionCache
  /** 约束候选队列试错（每候选一次 resolve/download）、季横扫按集 resolve、季包升格逐集 resolve
   *  共用同一份治理——三者共享一个从"下载阶段开始"起算的预算池（CRITICAL 修复，见 runPipeline
   *  里 downloadPhaseApiCallsSnapshot 的注释）：search 阶段（plan/providerSearch/alias 收割补搜）
   *  打的 api_call 绝不计入这份预算，只有下载阶段自己（sweep pre-gate/post-gate + season 升格 +
   *  单集候选队列）消耗的 api_call 才会让预算见底。 */
  maxApiCallsPerJob: number
  /** 配置的媒体根目录列表（MEDIA_ROOTS / mapping.to）。用于把字幕试错沙盒钉在"包含目标视频的
   *  媒体根"一级而不是视频所在的深层目录——见 runPipeline 里 stagingRoot 的计算与注释
   *  （FINDING-1：gcOrphans 按根非递归扫描，沙盒不挂在根一级就够不到）。可选；未注入或没有
   *  任何根匹配 outDir 时退回 outDir 本身（沙盒与视频仍同一文件系统，只是不可被 gcOrphans
   *  按根回收——裸 `cli run` 调试路径没有媒体根概念，这个退化是预期行为）。 */
  mediaRoots?: string[]
  /** journal 创建后回调，供调用方把 provider 的 onApiCall 等接入审计 */
  journalReady?: (journal: Journal) => void
  /** LLM runtime，用于中文别名收割兜底（可选；未注入则跳过该步） */
  llm?: LlmRuntime
  /** 本地孤儿字幕收编（可选；未注入则跳过该步） */
  adoption?: {
    scan: (dir: string, videoFilename: string) => OrphanSubtitle[]
    judge: (ctx: MediaContext, id: MediaIdentity, orphans: OrphanSubtitle[]) => Promise<CallStructuredResult<OrphanDecision>>
    read: (path: string) => Buffer
  }
  seasonPack?: {
    enumerate: (ctx: MediaContext) => Promise<SeasonEpisode[]>
    map: (ctx: MediaContext, id: MediaIdentity, filelist: { index: number; name: string }[], eps: SeasonEpisode[]) => Promise<CallStructuredResult<SeasonMap>>
    /** providerRef: 命中候选的 provider-neutral 标识（candidateKey，如 "assrt:900900"）；供 v2 写 subtitles.provider_ref。
     *  alreadyExisted: true 表示这一集的目标字幕文件在装机前已经在磁盘上（stageInspectVerifyInstall
     *  的 findOnDiskNfc 命中）——本次 run 并没有真的写这个文件，调用方（v2 executor）据此把
     *  subtitles.source 标成 'preexisting' 而不是 'scout-download'，与单集路径 already_exists→
     *  'preexisting' 的映射保持一致（不然季横扫/季包覆盖会把"本来就有"误记成"这次抓的"）。 */
    onCovered: (ep: SeasonEpisode, subtitlePath: string, providerRef?: string, alreadyExisted?: boolean) => void | Promise<void>
  }
  /** 字幕试错沙盒：候选下载进这里打开验，终审通过才原子安装进媒体目录。 */
  staging: {
    allocate: (jobId: string, mediaRootForVideo: string) => string
    install: (stagedPath: string, finalPath: string) => Promise<{ path: string }>
    cleanup: (jobId: string, mediaRootForVideo: string) => void
  }
}

export interface PipelineResult {
  decision: 'download' | 'no_safe_match' | 'retry_later' | 'already_exists' | 'error' | 'adopted_local'
  subtitlePath?: string
  journalPath: string
  fromCache?: boolean
  /** 保留字段，向后兼容历史 journal/dashboard 消费方——判定链已不产出真实置信度值，恒为 null。 */
  confidence?: number | null
  /** 结论理由（人话摘要/错因取首条） */
  reasons?: string[]
  stats: { durationMs: number; llmCalls: number; apiCalls: number }
  coveredEpisodes?: { episodeCode: string; subtitlePath: string; providerRef?: string }[]
  /** 命中的候选来源（provider-neutral）；供 v2 executor 建 subtitles.provider_ref。仅 download 决议有值 */
  selected?: { provider: string; provider_id: string; subtitle_name: string; language: string; format: string } | null
  /** 配额耗尽信号：仅当本次 error 是由 provider ProviderQuotaExhaustedError 导致时非空；resetAt 可能为
   *  null（provider 没给出重置时间）。供 v2 executor 据此精确退避而非走默认 ERROR_BACKOFF_MS 阶梯。 */
  quotaExhausted?: { resetAt: string | null }
}

/** 从形如 "S02E05" 的规范集号拆出 season/episode 数值。集号可超过两位（长篇动画如 One Piece E1050）。 */
function parseCanonicalEpisodeCode(code: string): { season: number; episode: number } | null {
  const m = /^S(\d{1,4})E(\d{1,4})$/i.exec(code.trim())
  if (!m) return null
  return { season: Number(m[1]), episode: Number(m[2]) }
}

/**
 * 容错集号匹配：候选文件名/元数据里的集号写法五花八门——大小写不敏感的 SxxEyy，以及 NxM 记法
 * （如 "2x05"）。原先 f.name.includes(assignment.episode_code) 是大小写敏感的精确子串匹配，会把
 * 常见的全小写发布命名（"show.s02e05.chs.srt"）误判为"无匹配"而跳过——相对 main 的覆盖率倒退。
 *
 * 边界防护：用非数字前瞻/后顾包住整个数字序列，防止 "s02e05" 误配 "s02e050"（长集号截断出的假阳性），
 * 也防止 NxM 记法里季号被吞进更大的数字（如目标季 2，误配 "12x05" 里的 "2x05" 子串）。
 *
 * 有意不支持的记法（收窄以控制误伤面，而非遗漏）：
 * - 裸 "E05"（无季号）——候选池经常跨季，无季号时指代不明，认领错季的代价远大于漏检一个候选。
 * - 中文"第N集"——分季语义不明确（"第5集"可能是第几季的第5集未说明），且"话/集/合集"等变体
 *   混杂，数字边界不如 SxxEyy/NxM 可靠，误伤率评估下来高于收益。
 */
export function matchesEpisodeCode(text: string, episodeCode: string): boolean {
  if (!text) return false
  const parsed = parseCanonicalEpisodeCode(episodeCode)
  if (!parsed) return false
  const { season, episode } = parsed
  const patterns = [
    new RegExp(`(?<![0-9])s0*${season}e0*${episode}(?![0-9])`, 'i'), // SxxEyy（大小写不敏感，零填充不定）
    new RegExp(`(?<![0-9])0*${season}x0*${episode}(?![0-9])`, 'i'),  // NxM，如 "2x05"
  ]
  return patterns.some(re => re.test(text))
}

/** 季包/横扫路径的 selected 摘要：多集覆盖取首集作代表（provider/provider_id 供 v2 建 provider_ref） */
function seasonSelected(
  providerRef: string | undefined, firstSubtitlePath: string, language: string,
): PipelineResult['selected'] {
  const parsed = providerRef ? parseCandidateKey(providerRef) : null
  if (!parsed) return null
  return {
    provider: parsed.provider,
    provider_id: parsed.providerId,
    subtitle_name: basename(firstSubtitlePath),
    language,
    format: firstSubtitlePath.match(/\.(srt|ass|ssa)$/i)?.[1]?.toLowerCase() ?? 'srt',
  }
}

/** Addendum B：目标文件名 vs 磁盘目录项双向 NFC 归一化后比较。群晖等 SMB 存储可能把文件名按
 *  NFD 落盘（macOS 客户端惯例）——若只归一化探测的目标文件名一侧，NFD 落盘的同名文件在朴素
 *  existsSync 下会被误判成"不存在"，导致明明已经装好/存在的字幕被重新下载/覆盖安装。安装侧
 *  （stagingSandbox.install）已经把 finalPath 归一为 NFC，这里只读探测侧同样双向归一才能对齐。
 *  返回磁盘上实际的（未归一化）路径供调用方回填 result 的真实路径；找不到返回 null。 */
function findOnDiskNfc(dir: string, filename: string): string | null {
  const target = filename.normalize('NFC')
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of entries) {
    if (name.normalize('NFC') === target) return join(dir, name)
  }
  return null
}

interface StageOutcome {
  path: string
  bytes: number
  encoding: string | null
  reason: string
  /** true：目标文件已经在磁盘上（NFC 归一化比对命中），本次跳过 install()，不覆盖既有文件。 */
  alreadyExisted: boolean
}

type StageVerdict =
  | { ok: true; outcome: StageOutcome }
  // FINDING-3: transient=true 仅当结构性拒绝是因为 isHtml——限流/人机挑战页返回 HTTP 200 + HTML
  // 正文，download() 不会抛错（只在 !res.ok 才抛），所以这类"провider 其实没打通"的情况一路
  // 解码到这里才现出原形。它不是"这份字幕内容确实不对"的决定性内容结论，语义上更接近
  // resolve/download 阶段的瞬时错误——调用方（队列耗尽判断 + 季包/季横扫熔断计数）据此把它当
  // 瞬时失败处理，而不是决定性拒绝（不可解码/零 cue 才是真正"打开看了、看不出字幕"的决定性
  // 结论；verify match:false 恒非瞬时——那是终审判过的内容结论）。
  | { ok: false; verdict: 'structural-reject' | 'verify-reject'; transient: boolean }

/**
 * 沙盒试错的公共内核：写进沙盒子目录 → 结构体检 → （体检过关才）agent 终审 → 通过才装机。
 * 单集候选队列、季包升格、季横扫三处（addendum C）共用这一份逻辑，保证"下载的每一个字节，
 * 写进媒体库之前都要经过同一套体检+终审"这条铁律不因调用路径不同而有缺口。
 *
 * 装机前用 findOnDiskNfc 探测目标文件名是否已在 finalDir 存在（addendum B）：命中则不调用
 * install()（不覆盖既有文件），直接把已存在的真实路径作为 outcome 返回，alreadyExisted=true。
 */
async function stageInspectVerifyInstall(
  deps: PipelineDeps, ctx: MediaContext, identity: MediaIdentity, candidate: SubtitleCandidate,
  artifact: Buffer, artifactFilename: string, videoFilename: string,
  attemptDir: string, finalDir: string, journal: Journal, label: string,
): Promise<StageVerdict> {
  const staged = await writeSubtitle({
    artifact, artifactFilename, videoFilename, langTag: ctx.preferences.language, outDir: attemptDir,
  })
  const signals = inspectSubtitle(staged.path)
  journal.step('candidateInspected', { candidate: label, signals })

  if (!signals.decodable || signals.isHtml || signals.cueCount === 0) {
    // FINDING-3: isHtml 单独拎出来当瞬时信号——不可解码/零 cue 是"这份候选打开看了，看不出字幕
    // 内容"的决定性结论；isHtml 几乎总是限流/人机挑战页，而非"这份字幕就是不对"。
    journal.step('candidateRejectedStructural', { candidate: label, isHtml: signals.isHtml })
    return { ok: false, verdict: 'structural-reject', transient: signals.isHtml }
  }

  const verifyResult = await deps.verify(ctx, identity, candidate, signals)
  journal.llmCall({ point: 'verifySubtitle', prompt: verifyResult.prompt, rawText: verifyResult.rawText, parsed: verifyResult.parsed, retries: verifyResult.retries, durationMs: verifyResult.durationMs })

  if (!verifyResult.parsed.match) {
    journal.step('candidateVerifyRejected', { candidate: label, reason: verifyResult.parsed.reason })
    return { ok: false, verdict: 'verify-reject', transient: false }
  }

  const finalName = basename(staged.path)
  const existing = findOnDiskNfc(finalDir, finalName)
  if (existing) {
    journal.step('candidateAlreadyExists', { candidate: label, path: existing })
    return {
      ok: true,
      outcome: { path: existing, bytes: staged.bytes, encoding: staged.encoding, reason: verifyResult.parsed.reason, alreadyExisted: true },
    }
  }

  const installed = await deps.staging.install(staged.path, resolvePath(join(finalDir, finalName)))
  journal.step('candidateInstalled', { candidate: label, path: installed.path, reason: verifyResult.parsed.reason })
  return {
    ok: true,
    outcome: { path: installed.path, bytes: staged.bytes, encoding: staged.encoding, reason: verifyResult.parsed.reason, alreadyExisted: false },
  }
}

interface CandidateInstallOutcome {
  candidate: SubtitleCandidate
  fileIndex: number | null
  path: string
  bytes: number
  encoding: string | null
  reason: string
  alreadyExisted: boolean
}

/** 候选试错子目录名：同一 job 沙盒内，不同候选各自独立目录，避免同扩展名候选互相
 *  覆盖（"已存在"短路会把第二个候选误判成第一个候选已经写过）。 */
function candidateSlug(candidate: { provider: string; providerId: string }, fileIndex: number | null): string {
  const key = candidateKey(candidate).replace(/[^a-zA-Z0-9_.-]/g, '_')
  return `${key}_f${fileIndex ?? 'x'}`
}

/** 沙盒候选队列执行体：依次下载→体检→终审，第一个终审"是"即装机结束，返回其安装结果；
 *  用尽全部候选仍无匹配返回 outcome=null。结构体检硬拒（不可解码/HTML 错误页/零 cue）不
 *  触发终审调用，直接试下一个。预算：每次尝试消耗一份 provider API 调用配额，用尽
 *  deps.maxApiCallsPerJob 时停止尝试剩余候选——终审 LLM 调用与候选下载共用同一份预算治理。
 *  撞见 ProviderQuotaExhaustedError 直接向上抛，交调用方按 resetAt 精确退避（同季横扫语义）。
 *
 *  CRITICAL 修复：budget 不再拿 journal.counts().apiCalls 的绝对值去减——那个计数是
 *  job 全程累计的，search 阶段（plan/providerSearch/alias 收割补搜）在这里开始之前就已经
 *  journal 过好几笔 api_call（ASSRT 查询×2 + similar/gems + OS 登录+搜索，生产默认
 *  maxApiCallsPerJob=4 时这就已经 ≥4），若直接相减会让 budget≤0、循环在试第一个候选之前
 *  就 break——tried=[] 让调用方误判成"确实没有安全匹配"写 1 天负缓存（旗舰下载路径静默
 *  不试就投降、还顺手把缓存喂毒）。改为 apiCallsSnapshot 参数（downloadPhaseApiCallsSnapshot，
 *  runPipeline 进入下载阶段那一刻的快照）——budget 只按"进入下载阶段之后新增的 api_call"
 *  折算，search 阶段的计数被天然排除在外。 */
async function tryCandidateQueue(
  deps: PipelineDeps, ctx: MediaContext, identity: MediaIdentity,
  queue: GateQueueItem[], outDir: string, stagingDir: string, journal: Journal, apiCallsSnapshot: number,
): Promise<{
  outcome: CandidateInstallOutcome | null
  tried: { candidateId: string; verdict: string; transient: boolean }[]
  /** true：循环是被预算耗尽打断的（还有排好队的候选没试过）——调用方据此判 retry_later，
   *  绝不能当"每个候选都真的试过、决定性拒绝"的诚实结论去写负缓存。 */
  budgetExhausted: boolean
}> {
  const tried: { candidateId: string; verdict: string; transient: boolean }[] = []
  const budget = deps.maxApiCallsPerJob - (journal.counts().apiCalls - apiCallsSnapshot)
  let apiCallsUsed = 0
  let budgetExhausted = false

  for (const item of queue) {
    if (apiCallsUsed >= budget) {
      journal.step('candidateQueueBudgetExhausted', { candidate: candidateKey(item.candidate), tried: tried.length, remaining: queue.length - tried.length })
      budgetExhausted = true
      break
    }
    const candidateId = candidateKey(item.candidate)
    journal.step('candidateAttemptStart', { candidate: candidateId, identityMatch: item.identityMatch })
    try {
      apiCallsUsed++
      const resolved = await deps.providers.resolveDownload({
        provider: item.candidate.provider, providerId: item.candidate.providerId, fileIndex: item.fileIndex,
      })
      const dl = await deps.download(resolved.url)
      const attemptDir = join(stagingDir, candidateSlug(item.candidate, item.fileIndex))
      const artifactFilename = resolved.filename ?? item.candidate.fileList[item.fileIndex ?? -1]?.name ?? 'subtitle.srt'
      const verdict = await stageInspectVerifyInstall(
        deps, ctx, identity, item.candidate, dl.bytes, artifactFilename, ctx.media.filename,
        attemptDir, outDir, journal, candidateId,
      )
      if (!verdict.ok) {
        tried.push({ candidateId, verdict: verdict.verdict, transient: verdict.transient })
        continue
      }
      tried.push({ candidateId, verdict: verdict.outcome.alreadyExisted ? 'already-exists' : 'match', transient: false })
      return {
        outcome: {
          candidate: item.candidate, fileIndex: item.fileIndex,
          path: verdict.outcome.path, bytes: verdict.outcome.bytes, encoding: verdict.outcome.encoding,
          reason: verdict.outcome.reason, alreadyExisted: verdict.outcome.alreadyExisted,
        },
        tried,
        budgetExhausted: false,
      }
    } catch (e) {
      if (e instanceof ProviderQuotaExhaustedError) throw e
      journal.step('candidateAttemptFailed', { candidate: candidateId, error: String(e) })
      tried.push({ candidateId, verdict: 'error', transient: true })
    }
  }
  return { outcome: null, tried, budgetExhausted }
}

export async function runPipeline(
  deps: PipelineDeps, ctx: MediaContext, outDir: string, journalDir: string = outDir,
  opts: { bypassNegativeCache?: boolean } = {},
): Promise<PipelineResult> {
  const t0 = Date.now()
  const journal = new Journal(ctx.request_id)
  deps.journalReady?.(journal)
  const finish = (
    decision: PipelineResult['decision'],
    extra: { reasons?: string[]; confidence?: number | null; subtitlePath?: string; bytes?: number; encoding?: string | null; fromCache?: boolean; coveredEpisodes?: { episodeCode: string; subtitlePath: string; providerRef?: string }[]; selected?: { provider: string; provider_id: string; subtitle_name: string; language: string; format: string } | null; downloaded?: boolean; quotaExhausted?: { resetAt: string | null } } = {},
  ): PipelineResult => {
    const journalPath = journal.finish({
      request_id: ctx.request_id, decision,
      confidence: extra.confidence ?? null, selected: extra.selected ?? null,
      reasons: extra.reasons ?? [],
      // MINOR-A: downloaded defaults to true whenever a path is present (the historical behavior
      // for the 'download'/'adopted_local' call sites), but already_exists call sites pass
      // downloaded:false explicitly — nothing was newly downloaded/written this run there, even
      // though we now also carry the real on-disk path for bookkeeping (IMPORTANT-3).
      verification: extra.subtitlePath
        ? { downloaded: extra.downloaded ?? true, path: extra.subtitlePath, bytes: extra.bytes ?? null, encoding: extra.encoding ?? null }
        : null,
    }, journalDir)
    return { decision, subtitlePath: extra.subtitlePath, journalPath, fromCache: extra.fromCache, confidence: extra.confidence ?? null, reasons: extra.reasons ?? [], stats: { durationMs: Date.now() - t0, ...journal.counts() }, coveredEpisodes: extra.coveredEpisodes, selected: extra.selected ?? null, quotaExhausted: extra.quotaExhausted }
  }

  try {
    // 1. identify
    journal.step('identify')
    const idResult = await deps.identify(ctx)
    journal.llmCall({ point: 'identifyMedia', prompt: idResult.prompt, rawText: idResult.rawText, parsed: idResult.parsed, retries: idResult.retries, durationMs: idResult.durationMs })
    const identity = idResult.parsed

    // 2. cache lookup（精确 key 命中即信任；v1 无模糊复用）
    journal.step('cacheLookup')
    const keys = cacheKeys(identity, ctx.media.provider_ids)
    let cached: CacheEntry | null = null
    for (const k of keys) {
      const hit = deps.cache.get(k)
      if (!hit) continue
      if (hit.kind === 'negative' || k.startsWith('id:')) { cached = hit; break }
      // title-only positive 命中不可信（LLM 派生键可能跨媒体碰撞），忽略并继续走完整流程
    }
    if (opts.bypassNegativeCache && cached?.kind === 'negative') cached = null
    if (cached?.kind === 'negative') {
      return finish('no_safe_match', { reasons: [`negative cache: ${cached.reason}`], fromCache: true })
    }

    // 2.5. adoptLocal（仅当无 positive 命中且注入了 adoption）
    // 孤儿收编是优化路径不是关键路径——失败不应杀死整个 run，降级为"不收编"继续走搜索
    if (!cached && deps.adoption) {
      journal.step('scanOrphans')
      const orphans = deps.adoption.scan(dirname(ctx.media.path), ctx.media.filename)
      if (orphans.length > 0) {
        journal.step('judgeOrphan', { count: orphans.length })
        try {
          const judged = await deps.adoption.judge(ctx, identity, orphans)
          journal.llmCall({ point: 'judgeOrphan', prompt: judged.prompt, rawText: judged.rawText, parsed: judged.parsed, retries: judged.retries, durationMs: judged.durationMs })
          const ogate = runOrphanGate(judged.parsed, orphans)
          journal.step('orphanGateResult', ogate)
          if (ogate.ok && ogate.orphan) {
            const written = await writeSubtitle({
              artifact: deps.adoption.read(ogate.orphan.path),
              artifactFilename: ogate.orphan.filename,
              videoFilename: ctx.media.filename,
              langTag: judged.parsed.language!,
              outDir,
            })
            if (written.alreadyExists) {
              // IMPORTANT-3: carry the real on-disk path, same as the other two already_exists
              // sites (pre-flight + post-download) — downstream persistence keys off subtitlePath
              // and would otherwise silently lose the subtitles-row bookkeeping for this orphan.
              // downloaded:false: adoption was skipped, nothing new was written this run (MINOR-A).
              return finish('already_exists', { reasons: ['subtitle already exists; adoption skipped'], subtitlePath: written.path, downloaded: false })
            }
            return finish('adopted_local', {
              reasons: [`adopted local subtitle: ${ogate.orphan.filename}`, ...judged.parsed.reasons],
              subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
            })
          }
        } catch (e) {
          // StructuredOutputError 或任何其他错误：降级为不收编，journal 记录，继续走搜索
          journal.step('judgeOrphanFailed', { error: String(e), fallback: 'proceed without adoption' })
        }
      }
    }

    // 3. search（缓存命中 positive 时跳过 plan/search/rank，直接用缓存的选择）
    let rank: RankDecision
    let candidates: SubtitleCandidate[]
    // 提升到搜索块外：gate 判 no_safe_match 后的负缓存写入需要它——某源瞬时故障导致候选集残缺时
    // 绝不能把"残缺集拒判"当成"确实没有"写 1 天负缓存（毒库回归）。
    let searchProviderErrors: { provider: string; message: string }[] = []

    if (cached?.kind === 'positive') {
      journal.step('cacheHitPositive', cached)
      // 缓存命中：直接 resolve→download→写盘，不进候选队列/沙盒——这是"上次已经验证过
      // 这个候选是对的"的复用路径，不是新的、需要重新试错的候选。
      const resolved = await deps.providers.resolveDownload({
        provider: cached.provider, providerId: cached.providerId, fileIndex: cached.fileIndex,
      })
      const artifactFilename = resolved.filename ?? 'subtitle.srt'
      journal.step('download', { url: resolved.url.slice(0, 80) })
      const dl = await deps.download(resolved.url)
      journal.step('write')
      const written = await writeSubtitle({
        artifact: dl.bytes, artifactFilename, videoFilename: ctx.media.filename,
        langTag: ctx.preferences.language, outDir,
      })
      if (written.alreadyExists) {
        return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'], subtitlePath: written.path, downloaded: false })
      }
      const selected = {
        provider: cached.provider, provider_id: cached.providerId,
        subtitle_name: artifactFilename, language: ctx.preferences.language,
        format: artifactFilename.match(/\.(srt|ass|ssa)$/i)?.[1]?.toLowerCase() ?? 'srt',
      }
      return finish('download', {
        reasons: ['cache hit'], subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
        fromCache: true, selected,
      })
    }

    journal.step('planSearch')
    const planResult = await deps.plan(ctx, identity)
    journal.llmCall({ point: 'planSearch', prompt: planResult.prompt, rawText: planResult.rawText, parsed: planResult.parsed, retries: planResult.retries, durationMs: planResult.durationMs })

    // 统一的多查询搜索：CLI 内部做 multi-query + dedupe + gems
    const queries = planResult.parsed.queries.slice(0, 2)
    journal.step('providerSearch', { queries: queries.map(q => q.q) })
    const { candidates: searched, providerErrors } = await deps.providers.search({
      queries: queries.map(q => q.q),
      imdb: ctx.media.provider_ids?.Imdb ?? ctx.media.provider_ids?.imdb,
      year: identity.year ?? ctx.media.year ?? undefined,
      season: identity.season ?? ctx.media.season ?? undefined,
      episode: identity.episode ?? ctx.media.episode ?? undefined,
      filename: ctx.media.filename,
      deep: false,
    })
    searchProviderErrors = providerErrors
    const byKey = new Map<string, SubtitleCandidate>()
    for (const c of searched) {
      const key = candidateKey(c)
      if (!byKey.has(key)) byKey.set(key, c)
    }

    candidates = filterGraphicOnly(searched)
    journal.step('candidateFilter', { raw: searched.length, kept: candidates.length, providerErrors: providerErrors.length })
    if (candidates.length === 0) {
      // 零候选 + provider 局部故障 ≠ "确实没有字幕"：判 error 且绝不写负缓存
      // （否则瞬时 429/5xx/超时会被放大成 1 天的静默失配）
      if (providerErrors.length > 0) {
        return finish('error', {
          reasons: ['zero candidates with provider failures — not cacheable',
            ...providerErrors.map(e => `${e.provider}: ${e.message}`)],
        })
      }
      const reason = searched.length > 0
        ? '仅存图形字幕，本产品处理文本字幕'
        : 'no candidates from any search query'
      deps.cache.put(keys, { kind: 'negative', reason })
      return finish('no_safe_match', { reasons: [reason] })
    }

    journal.step('rankCandidates', { count: candidates.length })
    const rankResult = await deps.rank(ctx, identity, candidates)
    journal.llmCall({ point: 'rankCandidates', prompt: rankResult.prompt, rawText: rankResult.rawText, parsed: rankResult.parsed, retries: rankResult.retries, durationMs: rankResult.durationMs })
    rank = rankResult.parsed

    // 中文别名收割兜底：仅当首轮 rank 无安全匹配 + 上游/识别均无 CJK 标题时触发。
    // 收割别名 → 补一次搜索 → 仅对"新"候选单独走 candidateFilter+rank（首轮候选已被拒过，不混排）。
    // 增益路径不是关键路径——任何失败静默降级为维持首轮结论。
    const upstreamHasCjk = ctx.media.alternative_titles.some(hasCjk)
      || hasCjk(ctx.media.title) || hasCjk(identity.canonical_title)
    if (rank.order.length === 0 && deps.llm && !upstreamHasCjk) {
      try {
        // 候选名：nativeName||videoName 前 40 字符 × 最多 15 条（CJK 预筛在 harvestAlias 内，零 LLM 成本）
        const candidateNames = candidates
          .slice(0, 15)
          .map(s => {
            const name = s.nativeName || s.videoName || ''
            return name.slice(0, 40)
          })
          .filter(n => n.length > 0)
        const alias = candidateNames.length > 0
          ? await harvestAlias(deps.llm, identity.canonical_title, candidateNames)
          : null
        if (alias) {
          journal.step('aliasHarvest', { alias })
          // 增益路径：全灭时 search 直接 reject，落进本 catch 静默降级维持首轮结论；
          // 部分失败则并入 searchProviderErrors，一并进入下游 gate 的残缺集判定。
          const { candidates: freshSearched, providerErrors: aliasErrors } = await deps.providers.search({
            queries: [alias],
            deep: false,
            filename: ctx.media.filename,
          })
          if (aliasErrors.length > 0) searchProviderErrors = [...searchProviderErrors, ...aliasErrors]
          const freshAssrt = freshSearched.filter(c => !byKey.has(candidateKey(c)))
          for (const c of freshAssrt) byKey.set(candidateKey(c), c)
          const freshCandidates = filterGraphicOnly(freshAssrt)
          journal.step('aliasSearchMerged', { alias, added: freshAssrt.length, kept: freshCandidates.length })
          if (freshCandidates.length > 0) {
            journal.step('rankCandidates', { count: freshCandidates.length, pass: 'aliasHarvest' })
            // 二轮 rank 仅喂 fresh（不与被拒的首轮候选混排——保留既有语义）
            const secondRank = await deps.rank(ctx, identity, freshCandidates)
            journal.llmCall({ point: 'rankCandidates', prompt: secondRank.prompt, rawText: secondRank.rawText, parsed: secondRank.parsed, retries: secondRank.retries, durationMs: secondRank.durationMs })
            if (secondRank.parsed.order.length > 0) {
              rank = secondRank.parsed
              // 候选并入去重：fresh 优先排前，保留首轮候选在后——季横扫需要全池，而非仅 fresh
              const mergedPool = new Map<string, SubtitleCandidate>()
              for (const c of freshCandidates) mergedPool.set(candidateKey(c), c)
              for (const c of candidates) {
                const key = candidateKey(c)
                if (!mergedPool.has(key)) mergedPool.set(key, c)
              }
              candidates = [...mergedPool.values()]
            }
          }
        } else {
          journal.step('aliasHarvest', { skipped: 'no confident alias extracted' })
        }
      } catch (e) {
        journal.step('aliasHarvestFailed', { error: String(e) })
      }
    }

    // 沙盒生命周期覆盖从这里到函数末尾的所有下载路径：季横扫（pre-gate/post-gate）、季包升格、
    // 单集候选队列——三者都要经过 stage→inspect→verify→install（addendum C）。job 结束（无论
    // 从哪条分支 return）都要清空沙盒，试错垃圾零残留。
    //
    // FINDING-1：沙盒必须挂在"包含该视频的媒体根"一级（<root>/.subtitle-staging/<jobId>），
    // 不能是 outDir 本身——outDir 是视频所在的深层目录（如 .../Show/Season 01/），daemon 启动
    // 时的 gcOrphans(roots, activeJobIds)（见 cli/index.ts gcStaging）只按配置的媒体根非递归
    // 扫描 <root>/.subtitle-staging/，够不到埋在深层目录里的沙盒。硬杀（SIGKILL/OOM/断电）在
    // allocate 和下面 finally 的 cleanup 之间发生时，那种沙盒就成了永久泄漏、gcOrphans 永远
    // 回收不到。deps.mediaRoots 未注入（裸 `cli run` 调试路径没有媒体根概念）或没有任何根是
    // outDir 的前缀时，退回 outDir 本身——不"正确"但安全：沙盒仍与视频同一文件系统，install()
    // 的原子 rename 单跳前提不破，只是那次退化不再被 gcOrphans 按根回收（同 cli run 路径本来
    // 就不受 gcOrphans 保护的现状一致）。
    const stagingRoot = containingRoot(outDir, deps.mediaRoots ?? []) ?? outDir
    if (stagingRoot === outDir && (deps.mediaRoots?.length ?? 0) > 0) {
      journal.step('stagingRootFallback', { outDir, mediaRoots: deps.mediaRoots })
    }
    const stagingDir = deps.staging.allocate(ctx.request_id, stagingRoot)
    // CRITICAL 修复：下载阶段（pre-gate/post-gate 季横扫 + 季包升格 + 单集候选队列，四个消费点
    // 共享同一份治理）的 api_call 预算从这里"清零"起算——快照 search 阶段（plan/providerSearch/
    // alias 收割补搜）已经 journal 掉的 api_call 数，后面每个消费点都拿 journal.counts().apiCalls
    // 减去这个快照得到"进入下载阶段之后新增的调用数"，而不是直接拿 maxApiCallsPerJob 减
    // journal 的绝对计数。生产接线里 search 阶段（ASSRT 查询×2 + similar/gems + OS 登录+搜索）
    // 在这里之前就已经打了 4-5 个 api_call（cli/index.ts 的 onEvent('api_call') 钩子实时 journal），
    // 默认 maxApiCallsPerJob=4 时，若不排除 search 的计数，下面任何一个消费点的预算在试第一个
    // 候选之前就已经 ≤0——旗舰下载路径静默不试任何候选就投降，还把 0-tried 的耗尽误判成
    // "确实没有安全匹配"写 1 天负缓存（详见 tryCandidateQueue/runSeasonSweep 的注释）。
    const downloadPhaseApiCallsSnapshot = journal.counts().apiCalls
    try {
      // 5-pre. 季横扫前置：代表集 rank 排序为空（triage 全灭）时，gate 必然拒绝——这正是横扫的
      // 头号目标场景（本集自己没候选，散装候选覆盖的是其他集）。故在 gate 早退之前先尝试横扫；
      // 覆盖 >0 直接 finish，0 覆盖则照旧落回 gate 早退。sweepRan 供 gate 后分支去重防重跑。
      let sweepRan = false
      if (deps.seasonPack && deps.llm && ctx.media.type === 'episode'
        && rank.order.length === 0 && candidates.length > 0 && !pickSeasonPack(candidates)) {
        const seasonEpisodes = await deps.seasonPack.enumerate(ctx)
        if (seasonEpisodes.filter(e => e.needsChinese).length >= 2) {
          sweepRan = true
          const { covered, quotaExhausted, budgetExhausted } = await runSeasonSweep(deps, ctx, identity, candidates, seasonEpisodes, journal, 'pre-gate', stagingDir, downloadPhaseApiCallsSnapshot)
          if (covered.length > 0) {
            return finish('download', { reasons: [`season sweep: covered ${covered.length} episodes`], coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath, selected: seasonSelected(covered[0].providerRef, covered[0].subtitlePath, ctx.preferences.language), quotaExhausted })
          }
          // IMPORTANT-1b: 0 覆盖 + 配额耗尽 → 绝不落回下面的 gate 早退（rank 仍是空队列，gate
          // 必然判 no_safe_match 并写 1 天负缓存，把"配额耗尽"误判成"确实没有安全匹配"，resetAt 丢失）。
          if (quotaExhausted) {
            return finish('error', { reasons: ['season sweep: quota exhausted before any episode coverage'], quotaExhausted })
          }
          // CRITICAL 修复（part 2）：0 覆盖是预算耗尽（还有 assignment 没试过）造成的——绝不能
          // 落回下面的 gate 早退（rank 仍是空队列，gate 必然判 no_safe_match 并写 1 天负缓存，
          // 把"预算不够"误判成"确实没有安全匹配"）。是预算而非证据结束了这轮横扫。
          if (budgetExhausted) {
            return finish('retry_later', { reasons: ['season sweep: api call budget exhausted before covering any episode — not cacheable'] })
          }
        }
      }

      // 4. gate：身份判决保留"是/不是"两态，产出结构校验过的候选队列。gate.ok=false 恒为
      // no_safe_match（ask_user 出口已在 Phase 4 拔除）。
      journal.step('gate')
      const gate = runGate(rank, candidates, identity)
      journal.step('gateResult', gate)
      if (!gate.ok) {
        // 候选集残缺（某源瞬时故障 fail-soft 成 [] 但另一源有候选）时，不代表"确实没有安全
        // 匹配"——降级为 retry_later（瞬时可重试）且绝不写负缓存。providerErrors 为空才走
        // 诚实结论。
        if (searchProviderErrors.length > 0) {
          journal.step('incompleteCandidateSet', { providerErrors: searchProviderErrors })
          return finish('retry_later', {
            reasons: [
              'candidate set incomplete due to provider failure — not cacheable',
              ...searchProviderErrors.map(e => `${e.provider} 搜索失败: ${e.message}`),
            ],
          })
        }
        deps.cache.put(keys, { kind: 'negative', reason: gate.failures.join('; ') || 'agent declined' })
        return finish('no_safe_match', { reasons: gate.failures.length ? gate.failures : rank.reasons })
      }

      // 5.season 季包升格：fresh-rank（缓存命中已在上面早退）+ episode + 注入 seasonPack +
      // 候选覆盖多集 + 该季≥2集缺中字
      if (deps.seasonPack && ctx.media.type === 'episode') {
        const pack = pickSeasonPack(candidates)
        const mayGraduate = candidates.length >= 2
        const seasonEpisodes = (pack || mayGraduate) ? await deps.seasonPack.enumerate(ctx) : []
        const needsCount = seasonEpisodes.filter(e => e.needsChinese).length
        if (pack && shouldGraduate(ctx, pack, seasonEpisodes)) {
          journal.step('seasonGraduate', { packId: pack.providerId, episodes: seasonEpisodes.length, needs: needsCount })
          const mapResult = await deps.seasonPack.map(ctx, identity, pack.fileList, seasonEpisodes)
          journal.llmCall({ point: 'mapSeasonPack', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
          const pairs = (mapResult.parsed.pairs ?? []).filter(p => p.filelist_index != null) as { filelist_index: number; episode_code: string; reason: string }[]
          // 为 gate 构造伪 filelist：不带 URL（resolve 按需延迟到下载前）
          const gateFilelist = pack.fileList.map(f => ({ f: f.name, url: 'pending' }))
          const gateRes = runSeasonPackGate({ map: { pairs }, filelist: gateFilelist, seasonEpisodes })
          journal.step('seasonPackGate', { commit: gateRes.commit.length, dropped: gateRes.dropped.length })
          if (gateRes.commit.length > 0) {
            const packRef = candidateKey(pack)
            const coveredEpisodes: { episodeCode: string; subtitlePath: string; providerRef: string }[] = []
            let consecutiveFails = 0
            // IMPORTANT-1: 配额是全局的——一旦某集撞见 ProviderQuotaExhaustedError，剩余集的
            // resolve/download 注定同样失败，立刻停手（不等到 consecutiveFails>=3 熔断），并把
            // resetAt 记下来供 finish() 携带，而不是被下面的 catch 当成普通瞬时失败吞掉。
            let packQuotaExhausted: { resetAt: string | null } | undefined
            // FINDING-2: 与队列试错/季横扫对齐，同一份 maxApiCallsPerJob 预算也约束季包升格逐集
            // resolve——原先只靠 seasonEpisodes 数量天然收尾，季很长时（数十集）会无视预算打穿。
            // CRITICAL 修复：budget 按 downloadPhaseApiCallsSnapshot 折算增量（search 阶段的
            // api_call 计数排除在外），语义同 tryCandidateQueue/runSeasonSweep。
            let apiCallsUsed = 0
            const budget = deps.maxApiCallsPerJob - (journal.counts().apiCalls - downloadPhaseApiCallsSnapshot)
            // CRITICAL 修复（part 2）：预算耗尽打断循环时（还有 commit 项没试过）不是决定性结论——
            // 见下面 packBudgetExhausted 用法。
            let packBudgetExhausted = false
            for (const item of gateRes.commit) {
              if (consecutiveFails >= 3) { journal.step('seasonCircuitBreak', { after: coveredEpisodes.length }); break }
              if (apiCallsUsed >= budget) { journal.step('seasonPackBudgetExhausted', { after: coveredEpisodes.length }); packBudgetExhausted = true; break }
              try {
                apiCallsUsed++
                const resolved = await deps.providers.resolveDownload({
                  provider: pack.provider,
                  providerId: pack.providerId,
                  fileIndex: item.filelistIndex,
                })
                const dl = await deps.download(resolved.url)
                // addendum C: 季包每集下载也要经过 stage→inspect→verify→install，不再直写媒体目录。
                const attemptDir = join(stagingDir, candidateSlug(pack, item.filelistIndex))
                const verdict = await stageInspectVerifyInstall(
                  deps, ctx, identity, pack, dl.bytes, resolved.filename ?? item.filename, item.videoFilename,
                  attemptDir, dirname(item.videoPath), journal, `${packRef}#${item.episodeCode}`,
                )
                if (!verdict.ok) {
                  // FINDING-4: 熔断器的意图是"停止继续打一个失灵的 provider"——决定性内容拒绝
                  // （结构体检不可解码/零 cue、或终审 match:false）恰恰证明这一轮下载+体检+终审
                  // 全部走通了，provider 是健康的，不该计入熔断计数（并重置，冲掉之前攒的瞬时
                  // 失败苗头）。只有 transient=true（isHtml 限流页，FINDING-3 同一套判定）才算
                  // 一次"没打通"，计入熔断。
                  if (verdict.transient) {
                    consecutiveFails++
                  } else {
                    consecutiveFails = 0
                  }
                  journal.step('seasonEpisodeRejected', { episode: item.episodeCode, verdict: verdict.verdict, transient: verdict.transient })
                  continue
                }
                coveredEpisodes.push({ episodeCode: item.episodeCode, subtitlePath: verdict.outcome.path, providerRef: packRef })
                const epMeta = seasonEpisodes.find(e => e.episodeCode === item.episodeCode)!
                try { await deps.seasonPack.onCovered(epMeta, verdict.outcome.path, packRef, verdict.outcome.alreadyExisted) } catch { /* 观测/联动不影响主流程 */ }
                consecutiveFails = 0
              } catch (e) {
                if (e instanceof ProviderQuotaExhaustedError) {
                  packQuotaExhausted = { resetAt: e.resetAt }
                  journal.step('seasonEpisodeQuotaExhausted', { episode: item.episodeCode, after: coveredEpisodes.length, resetAt: e.resetAt })
                  break
                }
                // resolve/download 阶段抛出的瞬时异常——provider 这次没打通，计入熔断。
                consecutiveFails++
                journal.step('seasonEpisodeFailed', { episode: item.episodeCode, message: String(e) })
              }
            }
            if (coveredEpisodes.length > 0) {
              return finish('download', { reasons: [`season pack: covered ${coveredEpisodes.length} episodes`], coveredEpisodes, subtitlePath: coveredEpisodes[0].subtitlePath, selected: seasonSelected(packRef, coveredEpisodes[0].subtitlePath, ctx.preferences.language), quotaExhausted: packQuotaExhausted })
            }
            // IMPORTANT-1b: 0 覆盖 + 配额耗尽 → 绝不落回单集路径（那会再打一次注定失败的 resolve，
            // 且万一单集候选恰巧跳过 provider 调用就会静默吞掉这次配额信号）；直接把 resetAt 透传出去。
            if (packQuotaExhausted) {
              return finish('error', { reasons: ['season pack: quota exhausted before any episode coverage'], quotaExhausted: packQuotaExhausted })
            }
            // CRITICAL 修复（part 2）：0 覆盖 + 预算耗尽（还有 commit 项没试过）→ 是预算而非证据
            // 结束了这轮升格，绝不能落回单集路径再打一次同样会被预算卡住的 resolve，也绝不能被
            // 上层误判成"确实没有安全匹配"。
            if (packBudgetExhausted) {
              return finish('retry_later', { reasons: ['season pack: api call budget exhausted before covering any episode — not cacheable'] })
            }
          }
          // 季模式 0 覆盖 → 落回单集路径（继续往下，不 return）
        } else if (!pack && needsCount >= 2 && deps.llm && !sweepRan) {
          // 5b. season sweep: 无整季包但有散装候选 + ≥2集缺中字 → 一轮横扫全季（gate 通过路径）。
          // gate 前若已横扫过（!sweepRan 守卫）则跳过，避免同一 job 内横扫跑两次。
          const { covered, quotaExhausted, budgetExhausted } = await runSeasonSweep(deps, ctx, identity, candidates, seasonEpisodes, journal, 'post-gate', stagingDir, downloadPhaseApiCallsSnapshot)
          if (covered.length > 0) {
            return finish('download', { reasons: [`season sweep: covered ${covered.length} episodes`], coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath, selected: seasonSelected(covered[0].providerRef, covered[0].subtitlePath, ctx.preferences.language), quotaExhausted })
          }
          // IMPORTANT-1b: 0 覆盖 + 配额耗尽 → 不落回单集路径，直接透传 resetAt（同季包升格分支语义）
          if (quotaExhausted) {
            return finish('error', { reasons: ['season sweep: quota exhausted before any episode coverage'], quotaExhausted })
          }
          // CRITICAL 修复（part 2）：0 覆盖 + 预算耗尽 → 是预算而非证据结束了这轮横扫，不落回
          // 单集路径（同季包升格分支语义；下面单集队列即便真的再试一次也共享同一份已耗尽的预算，
          // 会立刻再次预算耗尽——不如直接在这里诚实报告 retry_later）。
          if (budgetExhausted) {
            return finish('retry_later', { reasons: ['season sweep: api call budget exhausted before covering any episode — not cacheable'] })
          }
          // sweep 0 覆盖 → 落回单集路径
        }
      }

      // 6-8. 候选队列试错：依次下载进沙盒→体检→终审，第一个终审"是"即装机结束。
      // 崩溃恢复预检：若队首候选的静态元数据能推出确定的输出文件名且已在磁盘上（NFC 归一化
      // 双向比较，addendum B）——说明这是"写盘成功但 DB 提交前崩溃"后的重跑，直接短路，绝不
      // 再打一次候选队列。
      const head = gate.queue[0]
      const knownName = head.candidate.fileList[head.fileIndex ?? -1]?.name
      if (knownName && /\.(srt|ass|ssa)$/i.test(knownName)) {
        const videoBase = basename(ctx.media.filename).replace(/\.[^.]+$/, '')
        const predictedName = `${videoBase}.${ctx.preferences.language}${extname(knownName).toLowerCase()}`
        const found = findOnDiskNfc(outDir, predictedName)
        if (found) {
          return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten (pre-flight check, no re-download)'], subtitlePath: found, downloaded: false })
        }
      }

      journal.step('candidateQueue', { size: gate.queue.length })
      const { outcome, tried, budgetExhausted } = await tryCandidateQueue(deps, ctx, identity, gate.queue, outDir, stagingDir, journal, downloadPhaseApiCallsSnapshot)
      if (!outcome) {
        journal.step('candidateQueueExhausted', { tried, budgetExhausted })
        // CRITICAL 修复（part 2）：预算耗尽打断了循环（0 tried，或试过几个但还有排队候选没试过）——
        // 是预算而非证据结束了这轮试错，绝不能当"每个候选都真的试过、决定性拒绝"的诚实结论去写
        // 负缓存。budgetExhausted 时不看 tried[] 里的内容，直接 retry_later。
        if (budgetExhausted) {
          return finish('retry_later', {
            reasons: [
              `candidate queue budget exhausted: ${tried.length}/${gate.queue.length} candidate(s) tried before the per-job api-call budget ran out — not cacheable`,
              ...rank.reasons,
            ],
          })
        }
        // tried[].verdict 只会是 'structural-reject' / 'verify-reject'（候选真下载下来经过结构
        // 体检/终审评判过）或 'error'（tryCandidateQueue 的 catch 分支——resolveDownload/download
        // 阶段瞬时故障，从未真正拿到内容评判；'match'/'already-exists' 两种走的是上面的
        // outcome!=null 早退，不会出现在这里）。'error' 之外，FINDING-3：isHtml 触发的
        // structural-reject（tried[].transient===true）也当瞬时处理——HTTP 200 + HTML 正文的
        // 限流/挑战页不会让 download() 抛错（只在 !res.ok 才抛），一路解码到结构体检才现形，
        // 语义上是"没打通"而非"打通了但确认不是"。只有不可解码/零 cue 的结构拒绝、以及
        // verify match:false 才是决定性内容结论。任何一个瞬时结果都说明整体不能诚实判定
        // "确实没有安全匹配"——绝不能误判成诚实结论而写负缓存（历史高频回归的瞬时 vs 内容结论
        // 铁律；镜像 searchProviderErrors 守卫，约 line 540）。
        const transientErrors = tried.filter(t => t.transient)
        if (transientErrors.length > 0) {
          journal.step('candidateQueueTransientFailure', { transientErrors })
          return finish('retry_later', {
            reasons: [
              `candidate queue exhausted with transient failures — not cacheable: ${transientErrors.length}/${tried.length} candidate(s) errored before a content verdict`,
              ...rank.reasons,
            ],
          })
        }
        // 到这里 tried.length === gate.queue.length（budgetExhausted=false 已排除预算截断）且
        // 没有任何瞬时结果——每个排好队的候选都真的下载+体检+终审过，全部决定性拒绝，才是诚实的
        // "确实没有安全匹配"，负缓存正当写入。
        const reason = `queue exhausted: ${tried.length} candidate(s) tried, none verified as a match`
        deps.cache.put(keys, { kind: 'negative', reason })
        return finish('no_safe_match', { reasons: [reason, ...rank.reasons] })
      }
      if (outcome.alreadyExisted) {
        return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'], subtitlePath: outcome.path, downloaded: false })
      }
      deps.cache.put(keys, { kind: 'positive', provider: outcome.candidate.provider, providerId: outcome.candidate.providerId, fileIndex: outcome.fileIndex })
      const selected = {
        provider: outcome.candidate.provider, provider_id: outcome.candidate.providerId,
        subtitle_name: basename(outcome.path), language: ctx.preferences.language,
        format: outcome.path.match(/\.(srt|ass|ssa)$/i)?.[1]?.toLowerCase() ?? 'srt',
      }
      return finish('download', {
        reasons: [outcome.reason, ...rank.reasons], subtitlePath: outcome.path, bytes: outcome.bytes, encoding: outcome.encoding,
        selected,
      })
    } finally {
      deps.staging.cleanup(ctx.request_id, stagingRoot)
    }
  } catch (e) {
    journal.step('error', { message: String(e) })
    // ProviderQuotaExhaustedError（见 providerPort.ts）：resetAt 透传进 PipelineResult 供 v2 executor
    // 按重置时间精确退避，而不是把配额耗尽和其它瞬时故障混为一谈都走盲的短退避阶梯。
    const quotaExhausted = e instanceof ProviderQuotaExhaustedError ? { resetAt: e.resetAt } : undefined
    return finish('error', { reasons: [String(e)], quotaExhausted })
  }
}

/**
 * 季横扫执行体：把散装候选映射到缺中字的集 → 逐集 detail→download→stage→体检→终审→装机。
 * pre-gate（代表集 rank 被拒）与 post-gate（gate 通过后）两个触发点共用；trigger 供审计区分。
 * 覆盖 0 集时 covered 为空数组，调用方据此决定落回 gate 早退 / 单集路径。
 * IMPORTANT-1 (revised): quotaExhausted 非空时（撞见 ProviderQuotaExhaustedError）表示本轮至少
 * 有一个 provider 耗尽——配额是按 provider 而非全局的，循环只跳过该 provider 剩余的 assignment，
 * 仍会继续为其它（健康）provider 的 assignment 正常 resolve。调用方必须把 quotaExhausted 信号
 * 透传进 PipelineResult（即便 covered 非空），且 0 覆盖时不能落回可能导致负缓存/盲退避的默认分支。
 * apiCallsSnapshot：runPipeline 进入下载阶段那一刻的 journal.counts().apiCalls 快照（CRITICAL
 * 修复，见调用点注释）——预算按这份快照折算增量，search 阶段的 api_call 计数排除在外。
 * budgetExhausted：0 覆盖 + 预算耗尽（还有 assignment 没试过）时为 true，调用方据此判 retry_later，
 * 绝不能落回可能负缓存的 gate 早退/单集路径。
 */
async function runSeasonSweep(
  deps: PipelineDeps, ctx: MediaContext, identity: MediaIdentity,
  candidates: SubtitleCandidate[], seasonEpisodes: SeasonEpisode[],
  journal: Journal, trigger: 'pre-gate' | 'post-gate', stagingDir: string, apiCallsSnapshot: number,
): Promise<{
  covered: { episodeCode: string; subtitlePath: string; providerRef: string }[]
  quotaExhausted?: { resetAt: string | null }
  budgetExhausted: boolean
}> {
  const needsCount = seasonEpisodes.filter(e => e.needsChinese).length
  journal.step('seasonSweepStart', { candidates: candidates.length, needs: needsCount, trigger })
  const mapResult = await mapLooseEpisodes(deps.llm!, ctx, identity, candidates, seasonEpisodes)
  journal.llmCall({ point: 'mapLooseEpisodes', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
  const validAssignments = (mapResult.parsed.assignments ?? [])
    .filter((a): a is typeof a & { candidate_id: string } =>
      a.candidate_id != null && a.candidate_id !== '' && !!a.episode_code)
  journal.step('seasonSweepFiltered', { valid: validAssignments.length, total: mapResult.parsed.assignments.length })
  if (validAssignments.length === 0) return { covered: [], budgetExhausted: false }

  const skipped: { episode: string; reason: string }[] = []

  // 结构校验先于按 episode_code 择优（MINOR-B）：若顺序反过来——先择优再校验——一个先出现但
  // 结构对不上的 assignment 会在 dedup 阶段挤掉本该通过校验的候选，随后自己在校验环节被跳过：
  // 整集颗粒无收，而本可由那个"输给 dedup"的候选覆盖。这里不做任何网络调用（resolve/download），
  // 纯本地校验，可以安全地在 dedup 之前跑一遍。
  interface ValidatedAssignment {
    episode_code: string
    candidate: SubtitleCandidate
    parsedKey: { provider: ProviderName; providerId: string }
    fileIndex: number | null
  }
  const validatedAssignments: ValidatedAssignment[] = []
  for (const assignment of validAssignments) {
    let parsed = parseCandidateKey(assignment.candidate_id)
    let candidate = parsed ? candidates.find(c => candidateKey(c) === assignment.candidate_id) : undefined
    // LLM 自愈：与单集 gate（core/gate.ts）对称——模型偶尔丢 "provider:" 前缀只回裸 providerId。
    // 仅在候选池内恰好一个候选命中该裸 id 才自愈；0 或 2+ 命中（跨 provider id 碰撞）维持 fail-safe 跳过。
    if (!parsed && !assignment.candidate_id.includes(':')) {
      const matches = candidates.filter(c => c.providerId === assignment.candidate_id)
      if (matches.length === 1) {
        candidate = matches[0]
        parsed = { provider: candidate.provider, providerId: candidate.providerId }
      }
    }
    if (!parsed) {
      skipped.push({ episode: assignment.episode_code, reason: 'invalid candidate_id' })
      continue
    }
    if (!candidate) {
      skipped.push({ episode: assignment.episode_code, reason: 'candidate not in pool' })
      continue
    }

    // 单集候选通常单文件；多文件时必须选中含对应 episode code 的文件——这是校验而非"选不出兜底
    // 第一个"：写盘字幕永久标记该集覆盖，错配比不下载伤害大得多（防串号铁律，同单集 gate 语义）。
    const subtitleFiles = candidate.fileList.filter(f => /\.(srt|ass|ssa)$/i.test(f.name))
    let fileIndex: number | null = null
    if (subtitleFiles.length > 0) {
      const matched = subtitleFiles.find(f => matchesEpisodeCode(f.name, assignment.episode_code))
      if (!matched) {
        skipped.push({ episode: assignment.episode_code, reason: `no filelist entry matches episode code ${assignment.episode_code} in candidate ${assignment.candidate_id} — refusing to fall back to an arbitrary file` })
        continue
      }
      fileIndex = matched.index
    } else {
      // OS 风格的散装候选没有 fileList（单文件 provider，见 adapters/providers/opensubtitles.ts
      // osToCandidates——providerId=file_id，fileList 恒为 []）。这类候选之前完全跳过结构校验、
      // 直接放行——一次 LLM 幻觉映射即可无验证写盘（防串号铁律的一个缺口）。回退校验
      // candidate 级元数据（videoName/nativeName 常带发布名，通常含集号信号）；两者都没有可识别
      // 信号时 fail-safe 跳过——错误写入是永久的，跳过只是这次不覆盖、下次还能再来。
      const metaMatch = matchesEpisodeCode(candidate.videoName ?? '', assignment.episode_code)
        || matchesEpisodeCode(candidate.nativeName ?? '', assignment.episode_code)
      if (!metaMatch) {
        skipped.push({ episode: assignment.episode_code, reason: `candidate ${assignment.candidate_id} has an empty fileList and no recognizable episode signal in videoName/nativeName for ${assignment.episode_code} — refusing to write unverified` })
        continue
      }
    }
    validatedAssignments.push({ episode_code: assignment.episode_code, candidate, parsedKey: parsed, fileIndex })
  }

  // 同一 episode_code 收到 2+ 个"通过校验"的候选时，保留 pairs[] 里先出现的那个——排序本身就是
  // 模型的偏好表达（把更有把握的排前面），不再需要额外的数字置信度来打破平局。
  const bestByCode = new Map<string, ValidatedAssignment>()
  for (const a of validatedAssignments) {
    if (!bestByCode.has(a.episode_code)) bestByCode.set(a.episode_code, a)
  }
  const dedupedAssignments = [...bestByCode.values()]
  journal.step('seasonSweepDedup', { before: validAssignments.length, validated: validatedAssignments.length, after: dedupedAssignments.length })

  const coveredEpisodes: { episodeCode: string; subtitlePath: string; providerRef: string }[] = []
  let apiCallsUsed = 0
  let consecutiveFails = 0
  // CRITICAL 修复：budget 按 apiCallsSnapshot 折算增量（search 阶段的 api_call 计数排除在外），
  // 语义同 tryCandidateQueue/季包升格循环。
  const budget = deps.maxApiCallsPerJob - (journal.counts().apiCalls - apiCallsSnapshot)
  // CRITICAL 修复（part 2）：任一 assignment 因预算耗尽被跳过时置 true——0 覆盖时调用方据此判
  // retry_later，不当决定性结论去负缓存/落回 gate 早退。
  let budgetExhausted = false
  // 一个候选(即一个物理文件)最多覆盖一集：按 "candidate_id#fileIndex" 去重。真整季散装候选
  // (每集各有独立文件、fileIndex 各不相同)不受影响；单文件候选被映射到多集时第 2+ 次必被拒。
  const usedFiles = new Set<string>()
  // IMPORTANT-1 (revised): 配额是按 provider 而非全局的——sweep 的逐集 winner 可能来自不同 provider
  // （SubtitleCandidate.provider），撞见 ProviderQuotaExhaustedError 只说明"这一个 provider 这次耗尽了"，
  // 不代表另一个健康 provider 的剩余集也注定失败。一旦某 provider 报过配额耗尽，记它的名字进
  // exhaustedProviders，此后只跳过该 provider 的剩余 assignment（不再打注定失败的 resolve），
  // 但继续为其它 provider 的 assignment 正常 resolve——不再无差别 break 整个循环。
  let quotaExhausted: { resetAt: string | null } | undefined
  const exhaustedProviders = new Set<string>()

  for (const assignment of dedupedAssignments) {
    // 与季包升格路径对齐的熔断：连续 3 次失败（resolve 失败或体检/终审拒收）视为源抖动/限流
    // 或结构性问题堆积，停止继续为剩余集打 API（而不是逐集都打一次直到自然耗尽预算）。
    if (consecutiveFails >= 3) {
      journal.step('seasonSweepCircuitBreak', { after: coveredEpisodes.length })
      break
    }
    if (apiCallsUsed >= budget) {
      skipped.push({ episode: assignment.episode_code, reason: 'api call budget exhausted' })
      budgetExhausted = true
      continue
    }
    const epMeta = seasonEpisodes.find(e => e.episodeCode === assignment.episode_code)
    if (!epMeta || !epMeta.needsChinese) {
      skipped.push({ episode: assignment.episode_code, reason: 'episode not in need list or already covered' })
      continue
    }

    const { candidate, parsedKey: parsed, fileIndex } = assignment
    if (exhaustedProviders.has(parsed.provider)) {
      // 该 provider 本轮已知配额耗尽——resolve 注定同样失败，跳过而不白打一次 API（不计入
      // apiCallsUsed/consecutiveFails，语义同其它前置守卫式跳过，如预算耗尽/集不在需求列表）。
      skipped.push({ episode: assignment.episode_code, reason: `provider ${parsed.provider} quota exhausted earlier this sweep — skipping remaining ${parsed.provider} assignments` })
      continue
    }
    const fileKey = `${candidateKey(parsed)}#${fileIndex ?? 'default'}`
    if (usedFiles.has(fileKey)) {
      skipped.push({ episode: assignment.episode_code, reason: `candidate ${assignment.episode_code} file ${fileIndex ?? 'default'} already covers another episode — rejecting single-file fan-out across episodes` })
      continue
    }
    usedFiles.add(fileKey)

    try {
      // 预算计数放在 resolve 调用之前：失败尝试也要算进 apiCallsUsed，否则 406/限流风暴下
      // resolveDownload 全灭、预算守卫永不触发，整季逐集都会各打一次（budget 形同虚设）。
      apiCallsUsed++
      const resolved = await deps.providers.resolveDownload({
        provider: parsed.provider,
        providerId: parsed.providerId,
        fileIndex,
      })
      // FINDING-4: 不在这里提前把 consecutiveFails 清零——resolve 成功只说明"打通了"，不说明
      // 这一集最终会是决定性内容拒绝还是瞬时失败；提前清零会让下面 download()/体检/终审阶段的
      // 真实结果（尤其是紧跟着的瞬时下载失败）被"resolve 成功"这一步意外冲掉。清零改到确认
      // 是"决定性结论"（内容拒绝或完整覆盖）之后才做，见下方。

      const dl = await deps.download(resolved.url)
      // addendum C: 横扫每集下载也要经过 stage→inspect→verify→install，不再直写媒体目录。
      const attemptDir = join(stagingDir, candidateSlug(parsed, fileIndex))
      const artifactFilename = resolved.filename ?? candidate.fileList[fileIndex ?? 0]?.name ?? 'subtitle.srt'
      const verdict = await stageInspectVerifyInstall(
        deps, ctx, identity, candidate, dl.bytes, artifactFilename, epMeta.videoFilename,
        attemptDir, dirname(epMeta.videoPath), journal, `${candidateKey(parsed)}#${assignment.episode_code}`,
      )
      if (!verdict.ok) {
        // FINDING-4（同季包升格路径语义）：决定性内容拒绝（不可解码/零 cue/终审 match:false）
        // 证明这一轮下载+体检+终审全部走通、provider 健康——不计入熔断，且清零冲掉之前攒的
        // 瞬时失败苗头。只有 transient=true（isHtml 限流页，FINDING-3 同一套判定）才算一次
        // "没打通"，计入熔断。
        if (verdict.transient) {
          consecutiveFails++
        } else {
          consecutiveFails = 0
        }
        skipped.push({ episode: assignment.episode_code, reason: `verify rejected: ${verdict.verdict}` })
        continue
      }
      consecutiveFails = 0
      const providerRef = candidateKey(parsed)
      coveredEpisodes.push({ episodeCode: assignment.episode_code, subtitlePath: verdict.outcome.path, providerRef })
      try { await deps.seasonPack!.onCovered(epMeta, verdict.outcome.path, providerRef, verdict.outcome.alreadyExisted) } catch { /* 观测/联动不影响主流程 */ }
    } catch (e) {
      if (e instanceof ProviderQuotaExhaustedError) {
        quotaExhausted = { resetAt: e.resetAt }
        // 只标记这一个 provider 耗尽、继续横扫剩余（大概率不同 provider 的）assignment——不再
        // break 整个循环。resolveDownload 调用点上方已经知道是哪个 provider 的请求触发了这次
        // 错误（parsed.provider），无需类型化错误自带 provider 字段即可精确定位。
        exhaustedProviders.add(parsed.provider)
        journal.step('seasonSweepQuotaExhausted', { episode: assignment.episode_code, provider: parsed.provider, after: coveredEpisodes.length, resetAt: e.resetAt })
        continue
      }
      // resolve/download 阶段抛出的瞬时异常——provider 这次没打通，计入熔断。
      consecutiveFails++
      skipped.push({ episode: assignment.episode_code, reason: String(e) })
    }
  }

  journal.step('seasonSweep', { candidates: candidates.length, assigned: validAssignments.length, covered: coveredEpisodes.length, skipped, trigger })
  return { covered: coveredEpisodes, quotaExhausted, budgetExhausted }
}

export function shouldGraduate(
  ctx: MediaContext, candidate: SubtitleCandidate | undefined, seasonEpisodes: SeasonEpisode[],
): boolean {
  if (ctx.media.type !== 'episode') return false
  if (!candidate) return false
  const subFiles = candidate.fileList.filter(f => /\.(srt|ass|ssa)$/i.test(f.name))
  if (subFiles.length < 2) return false
  return seasonEpisodes.filter(e => e.needsChinese).length >= 2
}

/**
 * 在全部候选里挑最"整季包"的一个：字幕文件数最多且 ≥2 的候选。
 * 独立于 rank 的选择——rank 偏好本集最精准匹配（常是单集候选），但升格要的是整季包。
 */
export function pickSeasonPack(candidates: SubtitleCandidate[]): SubtitleCandidate | undefined {
  return candidates
    .map(c => ({ c, n: c.fileList.filter(f => /\.(srt|ass|ssa)$/i.test(f.name)).length }))
    .filter(x => x.n >= 2)
    .sort((a, b) => b.n - a.n)[0]?.c
}
