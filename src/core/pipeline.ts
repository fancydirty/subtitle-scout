import { basename, dirname } from 'node:path'
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
            // 增益路径：providerErrors 不改判——全灭时 search 直接 reject，落进本 catch 静默降级
            const { candidates: freshSearched } = await deps.providers.search({
              queries: [alias],
              deep: false,
              filename: ctx.media.filename,
            })
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

    const resolved = await deps.providers.resolveDownload({
      provider: parsed.provider,
      providerId: parsed.providerId,
      fileIndex: rank.file_index ?? null,
    })
    const candidate = gateCandidate ?? candidates.find(c => candidateKey(c) === rank.candidate_id)
    const artifactFilename = resolved.filename
      ?? (candidate?.fileList[rank.file_index ?? -1]?.name)
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
    if (written.alreadyExists) return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'] })

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

  const coveredEpisodes: { episodeCode: string; subtitlePath: string; providerRef: string }[] = []
  const skipped: { episode: string; reason: string }[] = []
  let apiCallsUsed = 0
  const budget = deps.maxApiCallsPerJob - journal.counts().apiCalls

  for (const assignment of validAssignments) {
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
      const parsed = parseCandidateKey(assignment.candidate_id)
      if (!parsed) {
        skipped.push({ episode: assignment.episode_code, reason: 'invalid candidate_id' })
        continue
      }
      const candidate = candidates.find(c => candidateKey(c) === assignment.candidate_id)
      if (!candidate) {
        skipped.push({ episode: assignment.episode_code, reason: 'candidate not in pool' })
        continue
      }

      // 单集候选通常单文件；多文件时选含对应 episode code 的文件，选不出则用第一个字幕文件
      const subtitleFiles = candidate.fileList.filter(f => /\.(srt|ass|ssa)$/i.test(f.name))
      let fileIndex: number | null = null
      if (subtitleFiles.length > 0) {
        const matched = subtitleFiles.find(f => f.name.includes(assignment.episode_code))
        fileIndex = matched ? matched.index : subtitleFiles[0].index
      }

      const resolved = await deps.providers.resolveDownload({
        provider: parsed.provider,
        providerId: parsed.providerId,
        fileIndex,
      })
      apiCallsUsed++

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
