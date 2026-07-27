import { tool } from 'ai'
import { z } from 'zod'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo, WorkerTaskUpsertOutcome } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import { tmdbIdFromOwnId } from '../v2/ownIds.js'
import { mirrorExceedsSeasonTable } from '../core/seasonShape.js'
import { coercibleInt, nullableTolerant } from './coerce.js'
import { isParkedPathEligible } from '../v2/libraryRepo.js'

/** Task 8c（裁决 R-3 呈现面）：行形状增 throttled/nextRecheckAt/sampleReason——停牌中的缺口
 *  现在是可见事实，不再被 SQL 谓词整行吃掉（见 libraryRepo.ts missingBySeason 头注释）。
 *  seriesName 让模型不必再靠 seriesId 反查剧名。 */
export interface MissingSeasonRow {
  kind: 'season'; seriesId: string; seriesName: string; season: number
  missing: number; throttled: number; nextRecheckAt: number | null; sampleReason: string | null
}
export interface MissingMovieRow {
  kind: 'movie'; movieId: string; name: string
  missing: 0 | 1; throttled: 0 | 1; nextRecheckAt: number | null; sampleReason: string | null
}
export type MissingCoverageRow = MissingSeasonRow | MissingMovieRow

export interface MissingCoveragePage {
  rows: MissingCoverageRow[]
  total: number
  offset: number
  hasMore: boolean
  /** 停车场事实块——机械事实不是指令（北极星④）。count=agent 可处理的资格行数
   *  （谓词=libraryRepo.isParkedPathEligible）；sample=前 5 条
   *  {path, reason}。excluded-extra/duplicate-content 不进这个数（各归其役）。 */
  parked: { count: number; sample: Array<{ path: string; reason: string }> }
}

const DEFAULT_MISSING_COVERAGE_LIMIT = 50
const MAX_MISSING_COVERAGE_LIMIT = 200

/** Paginated (mirrors resultHandles.ts's list_candidates(id, offset, limit) shape) — the 100-cap
 *  on dispatch exists specifically to bound how much the orchestrator ingests per turn, and an
 *  unbounded inline dump here would defeat that premise on a large-enough library even though
 *  season-aggregation keeps the realistic common case small (5000 episodes -> ~200 season rows).
 *  Seasons and movies are combined into one flat, offset-addressable list rather than paginated
 *  separately, so a single (offset, limit) pair pages through the whole backlog. */
export function makeListMissingCoverageTool(lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'listParkedPaths'>, now: () => number) {
  return tool({
    description:
      'The mechanical pre-scan\'s living-doc: every series/season and movie with subtitle gaps ' +
      '— both currently-actionable gaps (missing) and throttled ones (recently exhausted, with ' +
      'their recheck time and reason). This is factual bookkeeping only; whether a throttled ' +
      'row is worth re-dispatching early is YOUR judgment. Paginated: returns at most `limit` ' +
      'rows per call (default 50, max 200) starting at `offset`. When `hasMore` is true, call ' +
      'again with a higher `offset` to see the rest — do not assume one call returned the whole ' +
      'backlog. The response also carries a `parked` fact block (unidentified files eligible for agent processing) — when its count is non-zero, dispatch_unidentified_identification is the tool that acts on it.',
    inputSchema: z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_MISSING_COVERAGE_LIMIT).default(DEFAULT_MISSING_COVERAGE_LIMIT),
    }),
    execute: async ({ offset, limit }): Promise<MissingCoveragePage> => {
      const seasonRows: MissingCoverageRow[] = lib.missingBySeason(now()).map(s => ({
        kind: 'season', seriesId: s.series_id, seriesName: s.series_name, season: s.season,
        missing: s.missing, throttled: s.throttled, nextRecheckAt: s.next_recheck_at, sampleReason: s.sample_reason,
      }))
      const movieRows: MissingCoverageRow[] = lib.missingMovies(now()).map(m => ({
        kind: 'movie', movieId: m.id, name: m.name,
        missing: m.missing, throttled: m.throttled, nextRecheckAt: m.next_recheck_at, sampleReason: m.sample_reason,
      }))
      const all = [...seasonRows, ...movieRows]
      const total = all.length
      const rows = all.slice(offset, offset + limit)
      const eligible = lib.listParkedPaths().filter(p => isParkedPathEligible(p.park_reason))
      const parked = {
        count: eligible.length,
        sample: eligible.slice(0, 5).map(p => ({ path: p.path, reason: p.park_reason })),
      }
      return { rows, total, offset, hasMore: offset + rows.length < total, parked }
    },
  })
}

/** Advisory inventory fact-check, NOT a code-level gate: the orchestrator's own instructions
 *  (skill text + system prompt) tell it to consult this before dispatch_realign_task, but that
 *  requirement is prompt-enforced only — dispatch_realign_task itself never reads
 *  exceedsSeasonTable, so nothing in code stops a model that ignores its instructions from
 *  dispatching a realign task on a hunch. The real code-level, zero-false-trigger
 *  ("正常库零误触发") gate lives downstream in executeRealign (phase ⑥, unchanged) — that is the
 *  safety net by design (the model decides dispatch; executeRealign is what actually must never
 *  misfire on an aligned library), not this tool. Reuses mirrorExceedsSeasonTable (pure,
 *  src/core/seasonShape.ts) — a season with mirrorEpisodeCount <= tmdbEpisodeCount is reported as
 *  NOT a realign candidate; the tool reports that fact, it does not enforce it.
 *
 *  Task 8c（裁决 R-4，审计发现 B6/B7）事实与结论分离：this tool used to fold a query failure into
 *  exceedsSeasonTable:false — a TMDB lookup that errored out looked identical to a TMDB lookup
 *  that genuinely found no overshoot, reporting a conclusion instead of the fact that the check
 *  couldn't run. tmdbUnavailable now surfaces that distinction explicitly (true when tmdbId
 *  couldn't be resolved from seriesId, or getSeasonTable threw) so the orchestrator can tell
 *  "TMDB says this season is fine" apart from "TMDB was unreachable this call, try again" instead
 *  of silently trusting a false. diskLayoutNonstandard adds a second, independent layout fact —
 *  the ingest layer's own layout_nonstandard column (series table, schema v10) — for the flat/
 *  absolute-numbering layouts ingest already normalized on write, which mirrorExceedsSeasonTable
 *  alone cannot see (it only compares episode counts, so a correctly-counted-but-flat layout
 *  passes it silently). Neither fact is a verdict; dispatch_realign_task still never reads either
 *  one — see the executeRealign note above.
 *
 *  tmdbId is resolved INTERNALLY via tmdbIdFromOwnId(seriesId) (src/v2/ownIds.ts), NOT taken as a
 *  model-supplied input — the orchestrator model has no source for a series' tmdbId
 *  (list_missing_coverage rows carry no tmdbId field), so a model-facing tmdbId param was
 *  uncallable in practice (the model could only fabricate one, which silently always resolved to
 *  exceedsSeasonTable:false). 去 Jellyfin 化 P4: the id IS the identity now (series.id =
 *  'tmdb:<TMDB id>', T2/ownIds.ts) — extracting it is a pure, zero-I/O string parse, no more live
 *  jf.getItem(seriesId) round-trip to read ProviderIds.Tmdb. This also retires the old
 *  "lib.getSeries().provider_ids is an unreliable historical mirror" caveat: T3's ingest layer
 *  (design D5) now writes provider_ids on every row, but that column was never the primary source
 *  of truth here anyway — the own id embedded in seriesId itself is, and always will be, since the
 *  id space's whole point is that identity round-trips through the id with zero I/O. */
export function makeCheckSeriesLayoutTool(
  lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'>,
  tmdb: Pick<TmdbClient, 'getSeasonTable'>,
) {
  return tool({
    description:
      'Two independent layout facts for a series/season, neither is a verdict: ' +
      'exceedsSeasonTable (mirror episode count vs TMDB — still fires for mis-scraped "Season ' +
      '01"-folder layouts) and diskLayoutNonstandard (ingest observed this series deviating from ' +
      'the canonical Show (Year) [tmdbid-N]/Season NN/ shape — catches flat layouts that ingest ' +
      'normalized). tmdbUnavailable:true means the TMDB side could not be consulted this call — ' +
      'a fact, not a false. Resolves the series\' TMDB id internally from seriesId.',
    inputSchema: z.object({ seriesId: z.string(), season: z.number().int() }),
    execute: async ({ seriesId, season }) => {
      const mirrorEpisodeCount = lib.countEpisodesInSeason(seriesId, season)
      const diskLayoutNonstandard = !!lib.getSeries(seriesId)?.layout_nonstandard
      const tmdbId = tmdbIdFromOwnId(seriesId)
      if (!tmdbId) {
        return {
          mirrorEpisodeCount, tmdbEpisodeCount: null, exceedsSeasonTable: false,
          tmdbUnavailable: true, diskLayoutNonstandard,
        }
      }
      let seasonTable: Awaited<ReturnType<typeof tmdb.getSeasonTable>> = null
      let tmdbUnavailable = false
      try {
        seasonTable = await tmdb.getSeasonTable(tmdbId)
      } catch {
        tmdbUnavailable = true
      }
      const tmdbEpisodeCount = seasonTable?.find(s => s.seasonNumber === season)?.episodeCount ?? null
      const exceedsSeasonTable = mirrorExceedsSeasonTable({ seriesId, season, mirrorEpisodeCount, tmdbEpisodeCount })
      return { mirrorEpisodeCount, tmdbEpisodeCount, exceedsSeasonTable, tmdbUnavailable, diskLayoutNonstandard }
    },
  })
}

export interface DispatchDeps {
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  parentJobId: number | null
  maxDispatchesPerOrchestrator?: number
}

/** Shared mutable counter across every dispatch_* tool instance for one orchestrator run —
 *  the 100-cap is a single budget across ALL dispatch kinds, not 100 find-subtitle tasks PLUS
 *  100 realign tasks separately. */
export interface DispatchCounter { count: number }

function capCheck(counter: DispatchCounter, cap: number): { error: string } | null {
  if (counter.count >= cap) {
    return { error: `dispatch cap (${cap}) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly` }
  }
  return null
}

/** R-2（裁决 2026-07-16，审计 A-F1/F2）：dispatch 工具如实转告 upsertWorkerTask 的四态回执，
 *  不再无条件回报 {dispatched:true}——考古定罪：旧代码在 upsertWorkerTask 之后无条件
 *  `counter.count++; return { dispatched: true, ... }`，dormant/failed 行被静默 no-op 吞掉时
 *  主代理还是收到"派发成功"的假象，永久活锁（以为派了，其实那一行纹丝不动）。cap 只数真正
 *  落地的新/复活行（created/revived）——coalesced（已有等价行在途，本次派发合并进它）与
 *  blocked_dormant（这个身份被停车，本次派发无法唤醒）都没有产生任何新的待办工作量，不该
 *  占用 orchestrator 的 100-dispatch 预算。
 *
 *  F-R2-5（R2 复审，审计定罪：coalesced 谎报"identical"+新意图丢弃）：coalesced 的 note 按
 *  intentRefreshed 分流措辞——intentRefreshed:true（wanted/failed 行）时如实说"你的新
 *  scope/reason 已经生效"；intentRefreshed:false（active 行，一个 worker 正在跑）时如实说
 *  "你的新 scope 没有套用到这个在跑的行，等它跑完再重派"。旧的单一"an identical task"措辞对
 *  wanted/failed 已经不准确——upsertWorkerTask 从 F-R2-5 起真的会刷新那两态的 payload，不再是
 *  单纯的"identical，什么都没变"。 */
function reportDispatchOutcome(result: WorkerTaskUpsertOutcome, counter: DispatchCounter, cap: number) {
  if (result.outcome === 'created' || result.outcome === 'revived') {
    counter.count++
    return { dispatched: true, outcome: result.outcome, remainingCapacity: cap - counter.count }
  }
  if (result.outcome === 'coalesced') {
    return {
      dispatched: false, outcome: 'coalesced' as const, pendingState: result.pendingState,
      note: result.intentRefreshed
        ? 'merged into the pending task and its scope/reason was refreshed to yours'
        : 'already running — your new scope was NOT applied to the in-flight run; re-dispatch after it completes if it still matters',
    }
  }
  return {
    dispatched: false, outcome: 'blocked_dormant' as const, reason: result.lastError,
    note: 'this identity is parked dormant (a configuration-class defect was recorded) — dispatching cannot revive it; surface this to the operator if it matters',
  }
}

/** A well-formed identity is exactly one of (seriesId non-null, movieId null) XOR (movieId
 *  non-null, seriesId null) — plain XOR, no season involved.
 *
 *  R-11（用户裁决 2026-07-16，原文锚点：「到底按季还是按剧，是根据具体情况具体分析的」）: this
 *  used to also force season non-null for a series dispatch, because upsertWorkerTask's identity
 *  tuple was (kind='worker_task', series_id, ifnull(season,-1), ifnull(movie_id,'')) and
 *  dispatch_realign_task ALSO writes kind='worker_task' with season forced to null for the same
 *  seriesId — a find_subtitle dispatch with a null season collided with that realign identity.
 *  Schema v11 (db.ts MIGRATIONS[2]) folded payload's taskType into the jobs_identity unique index
 *  (kind, series_id, season, movie_id, taskType), and jobsRepo.upsertWorkerTask's ON CONFLICT
 *  target follows suit — find_subtitle and realign no longer share a row for the same series no
 *  matter what season is. That was the null-season guard's ONLY reason to exist; with the
 *  collision gone, dispatch scope (which seasons) is the orchestrator's own judgment call, carried
 *  in the `seasons` array (see makeDispatchFindSubtitleTaskTool's description) rather than forced
 *  through the identity tuple. */
function hasWellFormedFindSubtitleIdentity(v: { seriesId: string | null; movieId: string | null }): boolean {
  const isSeries = v.seriesId !== null && v.movieId === null
  const isMovie = v.seriesId === null && v.movieId !== null
  return isSeries || isMovie
}

const FIND_SUBTITLE_IDENTITY_ERROR =
  'dispatch_find_subtitle_task requires exactly one identity: either seriesId (optionally with ' +
  'a seasons array) with movieId null, or movieId alone with seriesId null.'

export function makeDispatchFindSubtitleTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description:
      'Dispatch a find-subtitle worker task. Scope it by YOUR judgment of the on-disk reality: ' +
      'pass seasons:[3] when only season 3 exists on disk, seasons:[1,2,3] to have one worker ' +
      'sweep a series whose seasons are all missing subtitles (one season pack often covers them ' +
      'all), or omit seasons to cover every season that currently has gaps. For a movie pass ' +
      'movieId alone. Huge backlogs may be split into several dispatches at your discretion. ' +
      'The result tells you truthfully what happened: outcome created/revived means a new or ' +
      'revived worker_task row landed and it counts against your dispatch cap; outcome coalesced ' +
      'means a task with this identity was already pending (no new row, no budget consumed — the ' +
      'note says whether your new scope/reason was refreshed onto it or the pending run was ' +
      'already in flight); outcome blocked_dormant means this identity is parked and nothing was ' +
      'written. ' +
      'Pass includeThrottled:true only when the situation genuinely changed (e.g. a realign just ' +
      'landed, the operator fixed naming) — it tells the worker to also take on items still ' +
      'inside their search backoff window.',
    // Tolerant of the real model's natural shape (proven live, v3 live matrix, 2026-07-13): it
    // OMITS the other kind's field entirely (e.g. no `movieId` key at all when dispatching a
    // series) rather than sending an explicit JSON null, and may send seasons entries as strings
    // (`["1","2"]`) or the whole field as the sentinel "None". Plain `.nullable()` rejects an
    // omitted key (only `.nullish()`/`.optional()` accept `undefined`), so the tool-call failed
    // validation before execute() ever ran and zero rows landed — same class of bug as the
    // A-layer finalize-undefined fix. nullableTolerant/coercibleInt normalize omitted-key/
    // string-sentinel/string-number inputs to `null` (never `undefined`) before
    // hasWellFormedFindSubtitleIdentity below ever sees them.
    inputSchema: z.object({
      seriesId: nullableTolerant(z.string()),
      seasons: nullableTolerant(z.array(coercibleInt)),
      movieId: nullableTolerant(z.string()),
      reason: z.string(),
      // F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：orchestratorSkill already teaches
      // "re-dispatching a throttled-only row is YOUR call for a genuinely changed situation", but
      // until this field existed there was no way for that judgment to reach the mapper — the
      // dispatched worker_task always got claimed and immediately no-op'd back to completeDone
      // against the same recheck-window-filtered fact list. Same real-model tolerance as
      // seriesId/seasons/movieId above: omitted/"None" → null → false (nullableTolerant + the
      // explicit !!includeThrottled below), never an accidental widen from a stray null.
      includeThrottled: nullableTolerant(z.boolean()),
    }).refine(hasWellFormedFindSubtitleIdentity, { message: FIND_SUBTITLE_IDENTITY_ERROR }),
    execute: async ({ seriesId, seasons, movieId, reason, includeThrottled }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      const result = deps.jobs.upsertWorkerTask(
        { seriesId, season: null, movieId },
        {
          taskType: 'find_subtitle', seasons: seasons && seasons.length > 0 ? seasons : null, reason,
          includeThrottled: !!includeThrottled,
        },
        deps.parentJobId, deps.now(),
      )
      return reportDispatchOutcome(result, counter, cap)
    },
  })
}

/** Task 13: deps for dispatch_unidentified_identification — DispatchDeps plus lib, because the
 *  tool re-checks parked-path eligibility itself at dispatch time (the parked fact block the
 *  model saw in list_missing_coverage may be stale by the time it decides). */
export interface OrchestratorToolDeps {
  lib: Pick<LibraryRepo, 'listParkedPaths'>
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  parentJobId: number | null
}

/** Task 13（unidentified 主链路的派发侧）：Task 12 wired the claim side (find_subtitle jobs with
 *  payload.scope==='unidentified' read raw data from parked_paths, cli/index.ts); this tool is
 *  the missing dispatch side — the parked fact block could SHOW eligible paths but nothing could
 *  act on them. One call dispatches ONE find_subtitle worker_task for the ENTIRE eligible
 *  backlog (never per-path): the synthetic 'unidentified-backlog' seriesId gives the whole
 *  backlog a single dedup identity, so repeat dispatches coalesce into the same pending row
 *  instead of piling up duplicates.
 *
 *  Same honesty discipline as reportDispatchOutcome (R-2): upsertWorkerTask returns a four-state
 *  WorkerTaskUpsertOutcome (no jobId exists to report), so the receipt surfaces that outcome
 *  verbatim under upsertOutcome rather than claiming an unconditional success. */
export function makeDispatchUnidentifiedIdentificationTool(deps: OrchestratorToolDeps) {
  return tool({
    description:
      'Dispatch a find_subtitle worker task (scope: unidentified) to identify and subtitle the ' +
      'currently-eligible unidentified parked paths. Use this when the parked fact block in ' +
      'list_missing_coverage shows eligible paths (count > 0) that need agent identification. ' +
      'One dispatch hands the worker the ENTIRE eligible backlog — never dispatch per path. ' +
      'The receipt truthfully reports the upsert outcome: created/revived means a worker will ' +
      'run; coalesced means the backlog task was already pending (your reason was refreshed ' +
      'onto it if it had not been claimed yet); blocked_dormant means it is parked and nothing ' +
      'was written.',
    inputSchema: z.object({
      reason: z.string().min(1),
    }),
    execute: async ({ reason }) => {
      const eligible = deps.lib.listParkedPaths().filter(p => isParkedPathEligible(p.park_reason))
      if (eligible.length === 0) {
        return { outcome: 'none' as const, message: 'No eligible parked paths' }
      }
      const result = deps.jobs.upsertWorkerTask(
        { seriesId: 'unidentified-backlog', season: null, movieId: null },
        { taskType: 'find_subtitle', scope: 'unidentified', reason },
        deps.parentJobId,
        deps.now(),
      )
      return {
        outcome: 'dispatched' as const,
        upsertOutcome: result.outcome,
        parkedCount: eligible.length,
      }
    },
  })
}

export function makeDispatchRealignTaskTool(deps: DispatchDeps, counter: DispatchCounter) {
  const cap = deps.maxDispatchesPerOrchestrator ?? 100
  return tool({
    description:
      'Dispatch a realign worker task for one series whose on-disk layout looks misaligned ' +
      'with TMDB (e.g. absolute-numbering flat layout). Dispatch this BEFORE find_subtitle for ' +
      'the same series if both are pending — realigning first means the subsequent ' +
      'find-subtitle task sees correctly-numbered files. The result tells you truthfully what ' +
      'happened: outcome created/revived means a new or revived worker_task row landed and it ' +
      'counts against your dispatch cap; outcome coalesced means one was already pending (no new ' +
      'row, no budget — the note says whether your reason was refreshed onto it); outcome ' +
      'blocked_dormant means this identity is parked and nothing was written.',
    inputSchema: z.object({ seriesId: z.string(), reason: z.string() }),
    execute: async ({ seriesId, reason }) => {
      const capped = capCheck(counter, cap)
      if (capped) return capped
      const result = deps.jobs.upsertWorkerTask(
        { seriesId, season: null, movieId: null }, { taskType: 'realign', reason }, deps.parentJobId, deps.now(),
      )
      return reportDispatchOutcome(result, counter, cap)
    },
  })
}

/** F-R2-2（R2 复审）：如实转告 upsertWorkerTask 的四态回执——同 reportDispatchOutcome 的诚实
 *  纪律，但字段名是 spawned 不是 dispatched（这条工具从不占 dispatch cap，见下方 makeSpawnSiblingOrchestratorTool
 *  的头注释），且没有 counter/cap 要管。考古定罪：execute 曾经丢弃 upsertWorkerTask 的返回值、
 *  无条件回报 {spawned:true}——同一分片身份（seriesId 由 parentJobId+shardIndex 合成）若已有
 *  一行在途（coalesced）或被停车（blocked_dormant），本次派发携带的 remainingWorkSummary 悄悄
 *  被吞掉，主代理却看到"已生成"的假象、以为交接的上下文真的送达了 sibling。 */
function reportSpawnOutcome(result: WorkerTaskUpsertOutcome) {
  if (result.outcome === 'created' || result.outcome === 'revived') {
    return { spawned: true, outcome: result.outcome }
  }
  if (result.outcome === 'coalesced') {
    // F-R2-5 联动：wanted/failed 态的 coalesce 会刷新 payload——remainingWorkSummary 实际
    // 送达了那个待跑 sibling；只有 active 态（sibling 已在跑）才真的没送到。回执按事实分叉，
    // 不用一句对半错的固定文案（R2 复审子代理上报的跨修复张力，主控裁决收口）。
    return {
      spawned: false, outcome: 'coalesced' as const, pendingState: result.pendingState,
      note: result.intentRefreshed
        ? 'a sibling with this shard identity is already pending — no new row, but its handoff note was refreshed to YOUR remainingWorkSummary and will reach it when it runs'
        : 'a sibling with this shard identity is already RUNNING — your remainingWorkSummary was NOT delivered to it; if the handoff context matters, use a different shardIndex',
    }
  }
  return {
    spawned: false, outcome: 'blocked_dormant' as const, reason: result.lastError,
    note: 'this identity is parked dormant (a configuration-class defect was recorded) — dispatching cannot revive it; surface this to the operator if it matters',
  }
}

/** Does NOT count against the 100-dispatch cap — this IS the cap's escape valve. shardIndex is
 *  supplied by the model (or a simple incrementing counter the caller tracks) purely to keep
 *  the synthetic seriesId human-legible in the jobs table; it has no other significance. */
export function makeSpawnSiblingOrchestratorTool(deps: Omit<DispatchDeps, 'maxDispatchesPerOrchestrator'>) {
  return tool({
    description:
      'Hand off remaining dispatch work to a new sibling orchestrator job, once you have used ' +
      'up this orchestrator\'s dispatch capacity. Give it a short description of what remains. ' +
      'The result tells you truthfully what happened: outcome created/revived means a new/revived ' +
      'sibling row landed; outcome coalesced means a sibling with this shard identity already ' +
      'exists — the note says whether your remainingWorkSummary was refreshed onto the pending ' +
      'sibling or failed to reach an already-running one; outcome blocked_dormant means nothing ' +
      'was written.',
    inputSchema: z.object({ shardIndex: z.number().int(), remainingWorkSummary: z.string() }),
    execute: async ({ shardIndex, remainingWorkSummary }) => {
      const syntheticSeriesId = `orchestrator-shard-${deps.parentJobId ?? 'root'}-${shardIndex}`
      const result = deps.jobs.upsertWorkerTask(
        { seriesId: syntheticSeriesId, season: null, movieId: null },
        { taskType: 'orchestrate', remainingWorkSummary },
        deps.parentJobId,
        deps.now(),
      )
      return reportSpawnOutcome(result)
    },
  })
}
