import type { z } from 'zod'
import { dirname } from 'node:path'
import {
  type MediaContext, type MediaIdentity, type SearchPlan, type RankDecision,
  type AssrtSub, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
  type OrphanDecision, type SeasonMap,
} from './schemas.js'
import type { CallStructuredResult } from '../agent/llm.js'
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

type SearchResponse = z.infer<typeof AssrtSearchResponseSchema>
type DetailResponse = z.infer<typeof AssrtDetailResponseSchema>

export interface PipelineDeps {
  identify: (ctx: MediaContext) => Promise<CallStructuredResult<MediaIdentity>>
  plan: (ctx: MediaContext, id: MediaIdentity) => Promise<CallStructuredResult<SearchPlan>>
  rank: (ctx: MediaContext, id: MediaIdentity, cands: AssrtSub[]) => Promise<CallStructuredResult<RankDecision>>
  assrt: {
    search: (q: string) => Promise<SearchResponse>
    detail: (id: number) => Promise<DetailResponse>
  }
  download: (url: string) => Promise<DownloadResult>
  cache: DecisionCache
  maxApiCallsPerJob: number
  /** journal 创建后回调，供调用方把 provider 的 onApiCall 等接入审计 */
  journalReady?: (journal: Journal) => void
  /** 本地孤儿字幕收编（可选；未注入则跳过该步） */
  adoption?: {
    scan: (dir: string, videoFilename: string) => OrphanSubtitle[]
    judge: (ctx: MediaContext, id: MediaIdentity, orphans: OrphanSubtitle[]) => Promise<CallStructuredResult<OrphanDecision>>
    read: (path: string) => Buffer
  }
  seasonPack?: {
    enumerate: (ctx: MediaContext) => Promise<SeasonEpisode[]>
    map: (ctx: MediaContext, id: MediaIdentity, filelist: { f: string }[], eps: SeasonEpisode[]) => Promise<CallStructuredResult<SeasonMap>>
    onCovered: (ep: SeasonEpisode, subtitlePath: string) => void | Promise<void>
  }
}

export interface PipelineResult {
  decision: 'download' | 'ask_user' | 'no_safe_match' | 'retry_later' | 'already_exists' | 'error' | 'adopted_local'
  subtitlePath?: string
  journalPath: string
  fromCache?: boolean
  stats: { durationMs: number; llmCalls: number; apiCalls: number }
  coveredEpisodes?: { episodeCode: string; subtitlePath: string }[]
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
    extra: { reasons?: string[]; confidence?: number | null; subtitlePath?: string; bytes?: number; encoding?: string | null; fromCache?: boolean; coveredEpisodes?: { episodeCode: string; subtitlePath: string }[] } = {},
  ): PipelineResult => {
    const journalPath = journal.finish({
      request_id: ctx.request_id, decision,
      confidence: extra.confidence ?? null, selected: null,
      reasons: extra.reasons ?? [],
      verification: extra.subtitlePath
        ? { downloaded: true, path: extra.subtitlePath, bytes: extra.bytes ?? null, encoding: extra.encoding ?? null }
        : null,
    }, journalDir)
    return { decision, subtitlePath: extra.subtitlePath, journalPath, fromCache: extra.fromCache, stats: { durationMs: Date.now() - t0, ...journal.counts() }, coveredEpisodes: extra.coveredEpisodes }
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
    if (!cached && deps.adoption) {
      journal.step('scanOrphans')
      const orphans = deps.adoption.scan(dirname(ctx.media.path), ctx.media.filename)
      if (orphans.length > 0) {
        journal.step('judgeOrphan', { count: orphans.length })
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
      }
    }

    // 3. search（缓存命中 positive 时跳过 plan/search/rank，直接用缓存的选择）
    let rank: RankDecision
    let candidates: AssrtSub[]
    if (cached?.kind === 'positive') {
      journal.step('cacheHitPositive', cached)
      const detail = await deps.assrt.detail(cached.assrt_id)
      candidates = detail.sub.subs
      rank = { decision: 'download', assrt_id: cached.assrt_id, file_index: cached.file_index, confidence: cached.confidence, reasons: ['cache hit'], rejected: [] }
    } else {
      journal.step('planSearch')
      const planResult = await deps.plan(ctx, identity)
      journal.llmCall({ point: 'planSearch', prompt: planResult.prompt, rawText: planResult.rawText, parsed: planResult.parsed, retries: planResult.retries, durationMs: planResult.durationMs })

      // 跑前 2 条查询，按 assrt id 并集去重（ASSRT 单条查询受上传时间偏置，并集提召回）
      const queries = planResult.parsed.queries.slice(0, 2)
      const byId = new Map<number, AssrtSub>()
      let apiCalls = 0
      for (const q of queries) {
        if (apiCalls >= deps.maxApiCallsPerJob) break
        journal.step('assrtSearch', { q: q.q })
        const resp = await deps.assrt.search(q.q)
        apiCalls++
        for (const s of resp.sub.subs) if (!byId.has(s.id)) byId.set(s.id, s)
      }
      const raw = [...byId.values()]
      candidates = filterGraphicOnly(raw)
      journal.step('candidateFilter', { raw: raw.length, kept: candidates.length })
      if (candidates.length === 0) {
        const reason = raw.length > 0
          ? '仅存图形字幕，本产品处理文本字幕'
          : 'no candidates from any search query'
        deps.cache.put(keys, { kind: 'negative', reason })
        return finish('no_safe_match', { reasons: [reason] })
      }

      journal.step('rankCandidates', { count: candidates.length })
      const rankResult = await deps.rank(ctx, identity, candidates)
      journal.llmCall({ point: 'rankCandidates', prompt: rankResult.prompt, rawText: rankResult.rawText, parsed: rankResult.parsed, retries: rankResult.retries, durationMs: rankResult.durationMs })
      rank = rankResult.parsed
    }

    // 4. gate
    journal.step('gate')
    const gate = runGate(rank, candidates, identity, ctx.preferences)
    journal.step('gateResult', gate)
    if (!gate.ok) {
      if (gate.decision === 'no_safe_match' && !cached) {
        deps.cache.put(keys, { kind: 'negative', reason: gate.failures.join('; ') || 'agent declined' })
      }
      return finish(gate.decision, { reasons: gate.failures.length ? gate.failures : rank.reasons, confidence: rank.confidence })
    }

    // 5.season 季包升格：仅 fresh-rank（非缓存命中）+ episode + 注入 seasonPack + 候选覆盖多集 + 该季≥2集缺中字
    // !cached 防止缓存命中路径误触发（否则每次命中都白调 enumerate、重复 detail、把单集缓存决策变异成季包）
    if (!cached && deps.seasonPack && ctx.media.type === 'episode') {
      const pack = pickSeasonPack(candidates)
      const seasonEpisodes = pack ? await deps.seasonPack.enumerate(ctx) : []
      if (pack && shouldGraduate(ctx, pack, seasonEpisodes)) {
        journal.step('seasonGraduate', { packId: pack.id, episodes: seasonEpisodes.length, needs: seasonEpisodes.filter(e => e.needsChinese).length })
        const detail = await deps.assrt.detail(pack.id)
        const packSub = detail.sub.subs.find(s => s.id === pack.id) ?? detail.sub.subs[0]
        if (packSub) {
          const mapResult = await deps.seasonPack.map(ctx, identity, packSub.filelist, seasonEpisodes)
          journal.llmCall({ point: 'mapSeasonPack', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
          const pairs = (mapResult.parsed.pairs ?? []).filter(p => p.filelist_index != null && p.confidence != null) as { filelist_index: number; episode_code: string; confidence: number; reason: string }[]
          const gateRes = runSeasonPackGate({ map: { pairs }, filelist: packSub.filelist, seasonEpisodes, minConfidence: ctx.preferences.auto_download_min_confidence })
          journal.step('seasonPackGate', { commit: gateRes.commit.length, dropped: gateRes.dropped.length })
          if (gateRes.commit.length > 0) {
            const coveredEpisodes: { episodeCode: string; subtitlePath: string }[] = []
            let consecutiveFails = 0
            for (const item of gateRes.commit) {
              if (consecutiveFails >= 3) { journal.step('seasonCircuitBreak', { after: coveredEpisodes.length }); break }
              try {
                const dl = await deps.download(item.downloadUrl)
                const written = await writeSubtitle({
                  artifact: dl.bytes, artifactFilename: item.filename,
                  videoFilename: item.videoFilename, langTag: ctx.preferences.language,
                  outDir: dirname(item.videoPath),
                })
                coveredEpisodes.push({ episodeCode: item.episodeCode, subtitlePath: written.path })
                const epMeta = seasonEpisodes.find(e => e.episodeCode === item.episodeCode)!
                try { await deps.seasonPack.onCovered(epMeta, written.path) } catch { /* 观测/联动不影响主流程 */ }
                consecutiveFails = 0
              } catch (e) {
                consecutiveFails++
                journal.step('seasonEpisodeFailed', { episode: item.episodeCode, message: String(e) })
              }
            }
            if (coveredEpisodes.length > 0) {
              return finish('download', { reasons: [`season pack: covered ${coveredEpisodes.length} episodes`], confidence: rank.confidence, coveredEpisodes, subtitlePath: coveredEpisodes[0].subtitlePath })
            }
          }
        }
        // 季模式 0 覆盖 → 落回单集路径（继续往下，不 return）
      }
    }

    // 6. resolve download URL（detail 的时效 URL）
    journal.step('resolveDownloadUrl')
    const detail = cached?.kind === 'positive'
      ? { sub: { subs: candidates } }
      : await deps.assrt.detail(rank.assrt_id!)
    const sub = detail.sub.subs.find(s => s.id === rank.assrt_id) ?? detail.sub.subs[0]
    if (!sub) return finish('error', { reasons: ['detail response contained no subs'] })
    const fileEntry = rank.file_index != null ? sub.filelist[rank.file_index] : undefined
    const url = fileEntry?.url ?? sub.url
    if (!url) return finish('error', { reasons: ['no download url in detail response'] })

    // 7. download + write
    journal.step('download', { url: url.slice(0, 80) })
    const dl = await deps.download(url)
    const artifactFilename = fileEntry?.f ?? sub.filename ?? 'subtitle.srt'
    journal.step('write')
    const written = await writeSubtitle({
      artifact: dl.bytes,
      artifactFilename,
      selectFileName: fileEntry?.f,
      videoFilename: ctx.media.filename,
      langTag: ctx.preferences.language,
      outDir,
    })
    if (written.alreadyExists) return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'] })

    // 8. cache + finish
    if (!cached) {
      deps.cache.put(keys, { kind: 'positive', assrt_id: rank.assrt_id!, file_index: rank.file_index ?? null, confidence: rank.confidence })
    }
    return finish('download', {
      reasons: rank.reasons, confidence: rank.confidence,
      subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
      fromCache: cached?.kind === 'positive',
    })
  } catch (e) {
    journal.step('error', { message: String(e) })
    return finish('error', { reasons: [String(e)] })
  }
}

export function shouldGraduate(
  ctx: MediaContext, candidate: AssrtSub | undefined, seasonEpisodes: SeasonEpisode[],
): boolean {
  if (ctx.media.type !== 'episode') return false
  if (!candidate) return false
  const subFiles = candidate.filelist.filter(f => /\.(srt|ass|ssa)$/i.test(f.f))
  if (subFiles.length < 2) return false
  return seasonEpisodes.filter(e => e.needsChinese).length >= 2
}

/**
 * 在全部候选里挑最"整季包"的一个：字幕文件数最多且 ≥2 的候选。
 * 独立于 rank 的选择——rank 偏好本集最精准匹配（常是单集候选），但升格要的是整季包。
 */
export function pickSeasonPack(candidates: AssrtSub[]): AssrtSub | undefined {
  return candidates
    .map(c => ({ c, n: c.filelist.filter(f => /\.(srt|ass|ssa)$/i.test(f.f)).length }))
    .filter(x => x.n >= 2)
    .sort((a, b) => b.n - a.n)[0]?.c
}
