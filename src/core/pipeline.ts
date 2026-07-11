import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'
import {
  type MediaContext, type MediaIdentity, type SearchPlan, type RankDecision,
  type OrphanDecision, type SeasonMap, type SubtitleCandidate,
  candidateKey, parseCandidateKey,
} from './schemas.js'
import type { CallStructuredResult } from '../agent/llm.js'
import type { LlmRuntime } from '../agent/runtime.js'
import { Journal } from './journal.js'
import { DecisionCache, cacheKeys, type CacheEntry } from './cache.js'
import { runGate } from './gate.js'
import { runOrphanGate } from './orphanGate.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import type { DownloadResult } from '../adapters/download/direct.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'
import { filterGraphicOnly } from '../agent/rankCandidates.js'
import { runSeasonPackGate } from './seasonPackGate.js'
import type { SeasonEpisode } from './episode.js'
import { harvestAlias, hasCjk } from '../agent/harvestAlias.js'
import { mapLooseEpisodes } from '../agent/mapLooseEpisodes.js'
import type { ProviderPort } from './providerPort.js'

export interface PipelineDeps {
  identify: (ctx: MediaContext) => Promise<CallStructuredResult<MediaIdentity>>
  plan: (ctx: MediaContext, id: MediaIdentity) => Promise<CallStructuredResult<SearchPlan>>
  rank: (ctx: MediaContext, id: MediaIdentity, cands: SubtitleCandidate[]) => Promise<CallStructuredResult<RankDecision>>
  providers: ProviderPort
  download: (url: string) => Promise<DownloadResult>
  cache: DecisionCache
  /** 现仅约束季横扫的按集 resolve 预算；搜索阶段的多查询/去重/gems 预算已下放 subtitle-fetch CLI 内部 */
  maxApiCallsPerJob: number
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
    /** providerRef: 命中候选的 provider-neutral 标识（candidateKey，如 "assrt:900900"）；供 v2 写 subtitles.provider_ref */
    onCovered: (ep: SeasonEpisode, subtitlePath: string, providerRef?: string) => void | Promise<void>
  }
}

export interface PipelineResult {
  decision: 'download' | 'ask_user' | 'no_safe_match' | 'retry_later' | 'already_exists' | 'error' | 'adopted_local'
  subtitlePath?: string
  journalPath: string
  fromCache?: boolean
  /** 门评置信度（ask_user 展示用；不适用时 null） */
  confidence?: number | null
  /** 结论理由（人话摘要/错因取首条） */
  reasons?: string[]
  stats: { durationMs: number; llmCalls: number; apiCalls: number }
  coveredEpisodes?: { episodeCode: string; subtitlePath: string; providerRef?: string }[]
  /** 命中的候选来源（provider-neutral）；供 v2 executor 建 subtitles.provider_ref。仅 download 决议有值 */
  selected?: { provider: string; provider_id: string; subtitle_name: string; language: string; format: string } | null
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

export async function runPipeline(
  deps: PipelineDeps, ctx: MediaContext, outDir: string, journalDir: string = outDir,
  opts: { bypassNegativeCache?: boolean } = {},
): Promise<PipelineResult> {
  const t0 = Date.now()
  const journal = new Journal(ctx.request_id)
  deps.journalReady?.(journal)
  const finish = (
    decision: PipelineResult['decision'],
    extra: { reasons?: string[]; confidence?: number | null; subtitlePath?: string; bytes?: number; encoding?: string | null; fromCache?: boolean; coveredEpisodes?: { episodeCode: string; subtitlePath: string; providerRef?: string }[]; selected?: { provider: string; provider_id: string; subtitle_name: string; language: string; format: string } | null } = {},
  ): PipelineResult => {
    const journalPath = journal.finish({
      request_id: ctx.request_id, decision,
      confidence: extra.confidence ?? null, selected: extra.selected ?? null,
      reasons: extra.reasons ?? [],
      verification: extra.subtitlePath
        ? { downloaded: true, path: extra.subtitlePath, bytes: extra.bytes ?? null, encoding: extra.encoding ?? null }
        : null,
    }, journalDir)
    return { decision, subtitlePath: extra.subtitlePath, journalPath, fromCache: extra.fromCache, confidence: extra.confidence ?? null, reasons: extra.reasons ?? [], stats: { durationMs: Date.now() - t0, ...journal.counts() }, coveredEpisodes: extra.coveredEpisodes, selected: extra.selected ?? null }
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
          const ogate = runOrphanGate(judged.parsed, orphans, ctx.preferences.auto_download_min_confidence)
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
              return finish('already_exists', { reasons: ['subtitle already exists; adoption skipped'] })
            }
            return finish('adopted_local', {
              reasons: [`adopted local subtitle: ${ogate.orphan.filename}`, ...judged.parsed.reasons],
              confidence: judged.parsed.confidence,
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
      // 缓存命中：直接走 resolve→download，无需重构 detail response
      const cachedKey = candidateKey({ provider: cached.provider, providerId: cached.providerId })
      rank = { decision: 'download', candidate_id: cachedKey, file_index: cached.fileIndex, identity_match: 'confirmed', confidence: cached.confidence, reasons: ['cache hit'], rejected: [] }
      candidates = []  // gate 不需要候选池（缓存命中路径），下游直接 resolve
    } else {
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
      if (rank.decision === 'no_safe_match' && deps.llm && !upstreamHasCjk) {
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
              if (secondRank.parsed.decision !== 'no_safe_match') {
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
    }

    // 5-pre. 季横扫前置：代表集 rank 被拒时 gate 会早退短路季横扫——而这正是横扫的头号目标场景
    // （本集自己没候选，散装候选覆盖的是其他集）。故在 gate 早退之前先尝试横扫；覆盖 >0 直接 finish，
    // 0 覆盖则照旧落回 gate 早退（no_safe_match/ask_user 语义不变）。sweepRan 供 gate 后分支去重防重跑。
    let sweepRan = false
    if (!cached && deps.seasonPack && deps.llm && ctx.media.type === 'episode'
      && rank.decision !== 'download' && candidates.length > 0 && !pickSeasonPack(candidates)) {
      const seasonEpisodes = await deps.seasonPack.enumerate(ctx)
      if (seasonEpisodes.filter(e => e.needsChinese).length >= 2) {
        sweepRan = true
        const covered = await runSeasonSweep(deps, ctx, identity, candidates, seasonEpisodes, journal, 'pre-gate')
        if (covered.length > 0) {
          return finish('download', { reasons: [`season sweep: covered ${covered.length} episodes`], confidence: rank.confidence, coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath, selected: seasonSelected(covered[0].providerRef, covered[0].subtitlePath, ctx.preferences.language) })
        }
      }
    }

    // 4. gate（缓存命中路径跳过——缓存条目是历史 gate 已放行的结论，且此时无候选池可校验）
    let gateCandidate: SubtitleCandidate | undefined
    if (!(cached?.kind === 'positive')) {
      journal.step('gate')
      const gate = runGate(rank, candidates, identity, ctx.preferences)
      journal.step('gateResult', gate)
      if (!gate.ok) {
        // 候选集残缺（某源瞬时故障 fail-soft 成 [] 但另一源有候选）时，gate 的 no_safe_match/ask_user
        // 都不代表"确实没有安全匹配"——降级为 retry_later（瞬时可重试）且绝不写负缓存，否则该集被短路
        // 或冻结成待人工确认，而当时很可能是抽风的那一源本有确认匹配。providerErrors 为空才走诚实结论。
        if ((gate.decision === 'no_safe_match' || gate.decision === 'ask_user') && searchProviderErrors.length > 0) {
          journal.step('incompleteCandidateSet', { providerErrors: searchProviderErrors })
          return finish('retry_later', {
            reasons: [
              'candidate set incomplete due to provider failure — not cacheable',
              ...searchProviderErrors.map(e => `${e.provider} 搜索失败: ${e.message}`),
            ],
            confidence: rank.confidence,
          })
        }
        if (gate.decision === 'no_safe_match' && !cached) {
          deps.cache.put(keys, { kind: 'negative', reason: gate.failures.join('; ') || 'agent declined' })
        }
        return finish(gate.decision, { reasons: gate.failures.length ? gate.failures : rank.reasons, confidence: rank.confidence })
      }
      // gate 可能通过裸 providerId 自愈匹配（模型丢前缀）——归一化 candidate_id 为完整 key，
      // 否则下游 parseCandidateKey 对裸 id 返 null、下载段炸 error
      if (gate.candidate) {
        rank = { ...rank, candidate_id: candidateKey(gate.candidate) }
        gateCandidate = gate.candidate
      }
    }

    // 5.season 季包升格：仅 fresh-rank（非缓存命中）+ episode + 注入 seasonPack + 候选覆盖多集 + 该季≥2集缺中字
    // !cached 防止缓存命中路径误触发（否则每次命中都白调 enumerate、重复 detail、把单集缓存决策变异成季包）
    if (!cached && deps.seasonPack && ctx.media.type === 'episode') {
      const pack = pickSeasonPack(candidates)
      // enumerate 当有 pack 或可能需要 sweep 时（≥2 候选）：候选数 < 2 不可能满足 shouldGraduate / sweep
      const mayGraduate = candidates.length >= 2
      const seasonEpisodes = (pack || mayGraduate) ? await deps.seasonPack.enumerate(ctx) : []
      const needsCount = seasonEpisodes.filter(e => e.needsChinese).length
      if (pack && shouldGraduate(ctx, pack, seasonEpisodes)) {
        journal.step('seasonGraduate', { packId: pack.providerId, episodes: seasonEpisodes.length, needs: needsCount })
        const mapResult = await deps.seasonPack.map(ctx, identity, pack.fileList, seasonEpisodes)
        journal.llmCall({ point: 'mapSeasonPack', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
        const pairs = (mapResult.parsed.pairs ?? []).filter(p => p.filelist_index != null && p.confidence != null) as { filelist_index: number; episode_code: string; confidence: number; reason: string }[]
        // 为 gate 构造伪 filelist：不带 URL（resolve 按需延迟到下载前）
        const gateFilelist = pack.fileList.map(f => ({ f: f.name, url: 'pending' }))
        const gateRes = runSeasonPackGate({ map: { pairs }, filelist: gateFilelist, seasonEpisodes, minConfidence: ctx.preferences.auto_download_min_confidence })
        journal.step('seasonPackGate', { commit: gateRes.commit.length, dropped: gateRes.dropped.length })
        if (gateRes.commit.length > 0) {
          const packRef = candidateKey(pack)
          const coveredEpisodes: { episodeCode: string; subtitlePath: string; providerRef: string }[] = []
          let consecutiveFails = 0
          for (const item of gateRes.commit) {
            if (consecutiveFails >= 3) { journal.step('seasonCircuitBreak', { after: coveredEpisodes.length }); break }
            try {
              const resolved = await deps.providers.resolveDownload({
                provider: pack.provider,
                providerId: pack.providerId,
                fileIndex: item.filelistIndex,
              })
              const dl = await deps.download(resolved.url)
              const written = await writeSubtitle({
                artifact: dl.bytes, artifactFilename: resolved.filename ?? item.filename,
                videoFilename: item.videoFilename, langTag: ctx.preferences.language,
                outDir: dirname(item.videoPath),
              })
              coveredEpisodes.push({ episodeCode: item.episodeCode, subtitlePath: written.path, providerRef: packRef })
              const epMeta = seasonEpisodes.find(e => e.episodeCode === item.episodeCode)!
              try { await deps.seasonPack.onCovered(epMeta, written.path, packRef) } catch { /* 观测/联动不影响主流程 */ }
              consecutiveFails = 0
            } catch (e) {
              consecutiveFails++
              journal.step('seasonEpisodeFailed', { episode: item.episodeCode, message: String(e) })
            }
          }
          if (coveredEpisodes.length > 0) {
            return finish('download', { reasons: [`season pack: covered ${coveredEpisodes.length} episodes`], confidence: rank.confidence, coveredEpisodes, subtitlePath: coveredEpisodes[0].subtitlePath, selected: seasonSelected(packRef, coveredEpisodes[0].subtitlePath, ctx.preferences.language) })
          }
        }
        // 季模式 0 覆盖 → 落回单集路径（继续往下，不 return）
      } else if (!pack && needsCount >= 2 && deps.llm && !sweepRan) {
        // 5b. season sweep: 无整季包但有散装候选 + ≥2集缺中字 → 一轮横扫全季（gate 通过路径）。
        // gate 前若已横扫过（!sweepRan 守卫）则跳过，避免同一 job 内横扫跑两次。
        const covered = await runSeasonSweep(deps, ctx, identity, candidates, seasonEpisodes, journal, 'post-gate')
        if (covered.length > 0) {
          return finish('download', { reasons: [`season sweep: covered ${covered.length} episodes`], confidence: rank.confidence, coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath, selected: seasonSelected(covered[0].providerRef, covered[0].subtitlePath, ctx.preferences.language) })
        }
        // sweep 0 覆盖 → 落回单集路径
      }
    }

    // 6. resolve download URL
    journal.step('resolveDownloadUrl')
    const parsed = parseCandidateKey(rank.candidate_id!)
    if (!parsed) return finish('error', { reasons: [`invalid candidate_id: ${rank.candidate_id}`] })
    const candidate = gateCandidate ?? candidates.find(c => candidateKey(c) === rank.candidate_id)

    // 崩溃恢复预检：若能从候选的静态元数据（无需先 resolve/download）推出确定的输出文件名
    // 且它已经在磁盘上——说明这是"写盘成功但 DB 提交前崩溃"后的重跑，直接短路，绝不再打一次
    // provider API + 下载全量字节只为发现已存在（同 subtitleWriter 的命名规则；zip 包内文件名
    // 下载前不可知，跳过预检，走原有"下载后 writeSubtitle 自己发现已存在"路径）。
    const knownName = candidate?.fileList[rank.file_index ?? -1]?.name
    if (knownName && /\.(srt|ass|ssa)$/i.test(knownName)) {
      const videoBase = basename(ctx.media.filename).replace(/\.[^.]+$/, '')
      const predictedPath = resolvePath(join(outDir, `${videoBase}.${ctx.preferences.language}${extname(knownName).toLowerCase()}`))
      if (existsSync(predictedPath)) {
        return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten (pre-flight check, no re-download)'], subtitlePath: predictedPath })
      }
    }

    const resolved = await deps.providers.resolveDownload({
      provider: parsed.provider,
      providerId: parsed.providerId,
      fileIndex: rank.file_index ?? null,
    })
    const artifactFilename = resolved.filename
      ?? knownName
      ?? 'subtitle.srt'
    const subFormat = artifactFilename.match(/\.(srt|ass|ssa)$/i)?.[1] || 'srt'

    // 7. download + write
    journal.step('download', { url: resolved.url.slice(0, 80) })
    const dl = await deps.download(resolved.url)
    journal.step('write')
    const written = await writeSubtitle({
      artifact: dl.bytes,
      artifactFilename,
      videoFilename: ctx.media.filename,
      langTag: ctx.preferences.language,
      outDir,
    })
    if (written.alreadyExists) return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'], subtitlePath: written.path })

    // 8. cache + finish
    if (!cached) {
      deps.cache.put(keys, { kind: 'positive', provider: parsed.provider, providerId: parsed.providerId, fileIndex: rank.file_index ?? null, confidence: rank.confidence })
    }
    const selected = {
      provider: parsed.provider,
      provider_id: parsed.providerId,
      subtitle_name: artifactFilename,
      language: ctx.preferences.language,
      format: subFormat,
    }
    return finish('download', {
      reasons: rank.reasons, confidence: rank.confidence,
      subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
      fromCache: cached?.kind === 'positive',
      selected,
    })
  } catch (e) {
    journal.step('error', { message: String(e) })
    return finish('error', { reasons: [String(e)] })
  }
}

/**
 * 季横扫执行体：把散装候选映射到缺中字的集 → 逐集 detail→download→写盘→onCovered。
 * pre-gate（代表集 rank 被拒）与 post-gate（gate 通过后）两个触发点共用；trigger 供审计区分。
 * 覆盖 0 集时返回空数组，调用方据此决定落回 gate 早退 / 单集路径。
 */
async function runSeasonSweep(
  deps: PipelineDeps, ctx: MediaContext, identity: MediaIdentity,
  candidates: SubtitleCandidate[], seasonEpisodes: SeasonEpisode[],
  journal: Journal, trigger: 'pre-gate' | 'post-gate',
): Promise<{ episodeCode: string; subtitlePath: string; providerRef: string }[]> {
  const needsCount = seasonEpisodes.filter(e => e.needsChinese).length
  journal.step('seasonSweepStart', { candidates: candidates.length, needs: needsCount, trigger })
  const mapResult = await mapLooseEpisodes(deps.llm!, ctx, identity, candidates, seasonEpisodes)
  journal.llmCall({ point: 'mapLooseEpisodes', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
  const validAssignments = (mapResult.parsed.assignments ?? [])
    .filter((a): a is typeof a & { candidate_id: string } =>
      a.candidate_id != null && a.candidate_id !== '' && !!a.episode_code
      && a.confidence >= ctx.preferences.auto_download_min_confidence)
  journal.step('seasonSweepFiltered', { valid: validAssignments.length, total: mapResult.parsed.assignments.length })
  if (validAssignments.length === 0) return []

  // 同一 episode_code 收到 2+ 候选时，按 seasonPackGate 的 bestByCode 语义只保留置信度最高的那个——
  // 在任何 resolve/download 之前就丢弃劣者，既不产生质量倒退（保留低分覆盖），也不白打一次 API。
  const bestByCode = new Map<string, typeof validAssignments[number]>()
  for (const a of validAssignments) {
    const prev = bestByCode.get(a.episode_code)
    if (!prev || a.confidence > prev.confidence) bestByCode.set(a.episode_code, a)
  }
  const dedupedAssignments = [...bestByCode.values()]
  journal.step('seasonSweepDedup', { before: validAssignments.length, after: dedupedAssignments.length })

  const coveredEpisodes: { episodeCode: string; subtitlePath: string; providerRef: string }[] = []
  const skipped: { episode: string; reason: string }[] = []
  let apiCallsUsed = 0
  let consecutiveFails = 0
  const budget = deps.maxApiCallsPerJob - journal.counts().apiCalls
  // 一个候选(即一个物理文件)最多覆盖一集：按 "candidate_id#fileIndex" 去重。真整季散装候选
  // (每集各有独立文件、fileIndex 各不相同)不受影响；单文件候选被映射到多集时第 2+ 次必被拒。
  const usedFiles = new Set<string>()

  for (const assignment of dedupedAssignments) {
    // 与季包升格路径（line ~348）对齐的熔断：连续 3 次 resolve 失败视为源抖动/限流，
    // 停止继续为剩余集打 API（而不是逐集都打一次直到自然耗尽预算）。
    if (consecutiveFails >= 3) {
      journal.step('seasonSweepCircuitBreak', { after: coveredEpisodes.length })
      break
    }
    if (apiCallsUsed >= budget) {
      skipped.push({ episode: assignment.episode_code, reason: 'api call budget exhausted' })
      continue
    }
    const epMeta = seasonEpisodes.find(e => e.episodeCode === assignment.episode_code)
    if (!epMeta || !epMeta.needsChinese) {
      skipped.push({ episode: assignment.episode_code, reason: 'episode not in need list or already covered' })
      continue
    }

    try {
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

      const fileKey = `${candidateKey(parsed)}#${fileIndex ?? 'default'}`
      if (usedFiles.has(fileKey)) {
        skipped.push({ episode: assignment.episode_code, reason: `candidate ${assignment.candidate_id} file ${fileIndex ?? 'default'} already covers another episode — rejecting single-file fan-out across episodes` })
        continue
      }
      usedFiles.add(fileKey)

      // 预算计数放在 resolve 调用之前：失败尝试也要算进 apiCallsUsed，否则 406/限流风暴下
      // resolveDownload 全灭、预算守卫永不触发，整季逐集都会各打一次（budget 形同虚设）。
      apiCallsUsed++
      const resolved = await deps.providers.resolveDownload({
        provider: parsed.provider,
        providerId: parsed.providerId,
        fileIndex,
      })
      consecutiveFails = 0

      const dl = await deps.download(resolved.url)
      const written = await writeSubtitle({
        artifact: dl.bytes, artifactFilename: resolved.filename ?? candidate.fileList[fileIndex ?? 0]?.name ?? 'subtitle.srt',
        videoFilename: epMeta.videoFilename, langTag: ctx.preferences.language,
        outDir: dirname(epMeta.videoPath),
      })
      const providerRef = candidateKey(parsed) // == assignment.candidate_id（parseCandidateKey 已验证格式）
      coveredEpisodes.push({ episodeCode: assignment.episode_code, subtitlePath: written.path, providerRef })
      try { await deps.seasonPack!.onCovered(epMeta, written.path, providerRef) } catch { /* 观测/联动不影响主流程 */ }
    } catch (e) {
      consecutiveFails++
      skipped.push({ episode: assignment.episode_code, reason: String(e) })
    }
  }

  journal.step('seasonSweep', { candidates: candidates.length, assigned: validAssignments.length, covered: coveredEpisodes.length, skipped, trigger })
  return coveredEpisodes
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
