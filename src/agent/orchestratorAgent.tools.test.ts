import { describe, it, expect } from 'vitest'
import { asSchema } from 'ai'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import {
  makeListMissingCoverageTool, makeDispatchFindSubtitleTaskTool, makeDispatchRealignTaskTool,
  makeDispatchRescueTaskTool, makeCheckSeriesLayoutTool, makeSpawnSiblingOrchestratorTool, type DispatchCounter, type MissingCoveragePage,
} from './orchestratorAgent.tools.js'

const fakeOpts = { toolCallId: 't1', messages: [] } as any

/** Tools' inputSchema is typed as the union FlexibleSchema (Zod | custom Schema | ...), which
 *  doesn't expose Zod's own .safeParse at the type level even though these tools are always
 *  built from plain Zod schemas at runtime — asSchema(...).validate() is the SDK's own
 *  schema-agnostic way to run that same validation (used internally by the tool-calling loop
 *  itself before execute() is ever invoked). */
async function validate(schema: unknown, value: unknown) {
  return asSchema(schema as any).validate!(value)
}

// Task 8c（裁决 R-3 呈现面）：fake missingBySeason/missingMovies rows now carry
// series_name/throttled/next_recheck_at/sample_reason — the SQL predicate no longer hides
// throttled gaps, so the tool's row shape must round-trip all of it, not just missing/count.
function seasonRow(over: Partial<ReturnType<LibraryRepo['missingBySeason']>[number]> = {}) {
  return {
    series_id: 's1', series_name: 'Series One', season: 1,
    missing: 2, throttled: 0, next_recheck_at: null, sample_reason: null,
    ...over,
  }
}
function movieRow(over: Partial<ReturnType<LibraryRepo['missingMovies']>[number]> = {}) {
  return {
    id: 'm1', name: 'Movie One',
    missing: 1 as const, throttled: 0 as const, next_recheck_at: null, sample_reason: null,
    ...over,
  }
}

describe('makeListMissingCoverageTool', () => {
  it('paginates: first page returns `limit` rows + hasMore:true + correct total, second page returns the rest', async () => {
    // Seed 3 missing seasons — more than a limit of 2 — so a single unpaginated call would have
    // dumped the whole set inline (the finding this guards against).
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'listParkedPaths'> = {
      missingBySeason: () => [
        seasonRow({ series_id: 's1', series_name: 'Series One', missing: 2 }),
        seasonRow({ series_id: 's2', series_name: 'Series Two', missing: 1 }),
        seasonRow({ series_id: 's3', series_name: 'Series Three', missing: 5 }),
      ],
      missingMovies: () => [],
      listParkedPaths: () => [],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)

    const page1 = await listMissingCoverage.execute!({ offset: 0, limit: 2 }, fakeOpts) as MissingCoveragePage
    expect(page1.rows).toHaveLength(2)
    expect(page1.rows).toEqual([
      { kind: 'season', seriesId: 's1', seriesName: 'Series One', season: 1, missing: 2, throttled: 0, nextRecheckAt: null, sampleReason: null },
      { kind: 'season', seriesId: 's2', seriesName: 'Series Two', season: 1, missing: 1, throttled: 0, nextRecheckAt: null, sampleReason: null },
    ])
    expect(page1.total).toBe(3)
    expect(page1.offset).toBe(0)
    expect(page1.hasMore).toBe(true)

    const page2 = await listMissingCoverage.execute!({ offset: 2, limit: 2 }, fakeOpts) as MissingCoveragePage
    expect(page2.rows).toEqual([
      { kind: 'season', seriesId: 's3', seriesName: 'Series Three', season: 1, missing: 5, throttled: 0, nextRecheckAt: null, sampleReason: null },
    ])
    expect(page2.total).toBe(3)
    expect(page2.offset).toBe(2)
    expect(page2.hasMore).toBe(false)
  })

  it('combines missing seasons and missing movies into one offset-addressable list', async () => {
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'listParkedPaths'> = {
      missingBySeason: () => [seasonRow()],
      missingMovies: () => [movieRow()],
      listParkedPaths: () => [],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)
    const page = await listMissingCoverage.execute!({ offset: 0, limit: 50 }, fakeOpts) as MissingCoveragePage
    expect(page.total).toBe(2)
    expect(page.rows).toEqual([
      { kind: 'season', seriesId: 's1', seriesName: 'Series One', season: 1, missing: 2, throttled: 0, nextRecheckAt: null, sampleReason: null },
      { kind: 'movie', movieId: 'm1', name: 'Movie One', missing: 1, throttled: 0, nextRecheckAt: null, sampleReason: null },
    ])
    expect(page.hasMore).toBe(false)
  })

  // 停牌行的字段（seriesName/throttled/nextRecheckAt/sampleReason）在工具层完整透传，不是
  // libraryRepo 层加了字段、工具层还照旧只挑 seriesId/season/missing 三个老字段。
  it('season row carries seriesName/throttled/nextRecheckAt/sampleReason through to the model', async () => {
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'listParkedPaths'> = {
      missingBySeason: () => [
        seasonRow({ missing: 2, throttled: 1, next_recheck_at: 5000, sample_reason: '搜索穷尽' }),
      ],
      missingMovies: () => [],
      listParkedPaths: () => [],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)
    const page = await listMissingCoverage.execute!({ offset: 0, limit: 50 }, fakeOpts) as MissingCoveragePage
    expect(page.rows).toEqual([
      { kind: 'season', seriesId: 's1', seriesName: 'Series One', season: 1, missing: 2, throttled: 1, nextRecheckAt: 5000, sampleReason: '搜索穷尽' },
    ])
  })

  it('defaults offset to 0 and limit to 50 when called with no arguments', async () => {
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'listParkedPaths'> = {
      missingBySeason: () => [seasonRow()],
      missingMovies: () => [],
      listParkedPaths: () => [],
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)
    const result = await validate(listMissingCoverage.inputSchema, {})
    expect(result).toEqual({ success: true, value: { offset: 0, limit: 50 } })
  })

  // 救援R3：parked 事实块只计救援资格行，excluded-extra/duplicate-content 不计入也不进 sample。
  it('parked block counts only rescue-eligible rows and caps sample at 5', async () => {
    const lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'listParkedPaths'> = {
      missingBySeason: () => [],
      missingMovies: () => [],
      listParkedPaths: () => {
        const base = { first_seen: 1000, last_attempt: 1000, retry_count: 0, next_retry_at: null, probe_mtime: null, probe_size: null, duration_sec: null, embedded_langs: null }
        return [
          { path: '/media/A/a.mkv', park_reason: 'no tmdb match', ...base },
          { path: '/media/A/b.mkv', park_reason: 'ambiguous', ...base },
          { path: '/media/B/c.mkv', park_reason: 'excluded-extra', ...base },
          { path: '/media/C/d.mkv', park_reason: 'duplicate-content', ...base },
          { path: '/media/D/e.mkv', park_reason: 'no tmdb match', ...base },
          { path: '/media/E/f.mkv', park_reason: 'ambiguous', ...base },
          { path: '/media/F/g.mkv', park_reason: 'no tmdb match', ...base },
        ]
      },
    }
    const listMissingCoverage = makeListMissingCoverageTool(lib, () => 1000)
    const page = await listMissingCoverage.execute!({ offset: 0, limit: 50 }, fakeOpts) as MissingCoveragePage
    expect(page.parked.count).toBe(5)
    expect(page.parked.sample).toHaveLength(5)
    expect(page.parked.sample).toEqual([
      { path: '/media/A/a.mkv', reason: 'no tmdb match' },
      { path: '/media/A/b.mkv', reason: 'ambiguous' },
      { path: '/media/D/e.mkv', reason: 'no tmdb match' },
      { path: '/media/E/f.mkv', reason: 'ambiguous' },
      { path: '/media/F/g.mkv', reason: 'no tmdb match' },
    ])
  })
})

// R-11（用户裁决 2026-07-16，原文锚点：「到底按季还是按剧，是根据具体情况具体分析的」）：派活
// 范围不再是系统常量（原先靠强制 season 非空来避免与 dispatch_realign_task 撞身份），而是主代理
// 按刮削出的磁盘事实自行裁量——seasons 数组下发范围事实，season 单值字段已删除。schema v11 起
// taskType 进了 jobs_identity 元组（db.ts / jobsRepo.ts），find_subtitle 与 realign 对同一
// series 不再共享身份行，原先"拒绝 null season"的唯一理由随之消失。
describe('dispatch_find_subtitle_task identity + scope validation (R-11)', () => {
  it('rejects seriesId+movieId set together', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', movieId: 'm1', reason: 'bad identity',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an all-null identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: null, movieId: null, reason: 'nothing to dispatch',
    })
    expect(result.success).toBe(false)
  })

  it('accepts a well-formed series identity with a seasons array (e.g. seasons:[1,2,3] to sweep a whole series in one worker)', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 's1', seasons: [1, 2, 3], movieId: null, reason: 'missing s1-3',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a well-formed movie-only identity', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: null, seasons: null, movieId: 'm1', reason: 'missing movie',
    })
    expect(result.success).toBe(true)
  })

  // Root cause under test (v3 live matrix, 2026-07-13): the real model naturally OMITS fields
  // entirely rather than sending them as explicit JSON null — a plain `.nullable()` rejects the
  // omitted key (only `.nullish()`/`.optional()` accept `undefined`), so these tool-calls were
  // rejected before execute() ever ran and zero worker_task rows landed.
  it('accepts movieId/seasons OMITTED entirely for a series dispatch (real model natural shape) — normalizes to movieId:null, seasons:null', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', reason: 'x',
    })
    expect(result).toEqual({
      success: true, value: { seriesId: 'norm', seasons: null, movieId: null, reason: 'x', includeThrottled: null },
    })
  })

  it('accepts seriesId/seasons OMITTED entirely for a movie-only dispatch (real model natural shape) — normalizes to seriesId:null, seasons:null', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      movieId: 'mov', reason: 'x',
    })
    expect(result).toEqual({
      success: true, value: { seriesId: null, seasons: null, movieId: 'mov', reason: 'x', includeThrottled: null },
    })
  })

  it('coerces string-encoded season numbers inside the seasons array (["1","2"]) to integers', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', seasons: ['1', '2'], movieId: null, reason: 'x',
    })
    expect(result).toEqual({
      success: true, value: { seriesId: 'norm', seasons: [1, 2], movieId: null, reason: 'x', includeThrottled: null },
    })
  })

  it('"None" string sentinel for seasons collapses to null (full-series scope, not an empty array)', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', seasons: 'None', movieId: null, reason: 'x',
    })
    expect(result).toEqual({
      success: true, value: { seriesId: 'norm', seasons: null, movieId: null, reason: 'x', includeThrottled: null },
    })
  })

  it('still rejects a genuinely-malformed identity (seriesId AND movieId both set) even with seasons present', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
    )
    const result = await validate(dispatchFindSubtitle.inputSchema, {
      seriesId: 'norm', seasons: [1], movieId: 'mov', reason: 'x',
    })
    expect(result.success).toBe(false)
  })

  it('dispatch: seriesId+seasons=[1,2,3] → 一行 worker_task，payload.seasons=[1,2,3]，season 列 NULL', async () => {
    const counter: DispatchCounter = { count: 0 }
    const calls: unknown[][] = []
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      {
        jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args); return { outcome: 'created' } as const } },
        now: () => 1000, parentJobId: null,
      }, counter,
    )
    await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1, 2, 3], movieId: null, reason: 'sweep whole series', includeThrottled: null }, fakeOpts)
    expect(calls).toHaveLength(1)
    const [ident, payload] = calls[0]
    expect(ident).toEqual({ seriesId: 's1', season: null, movieId: null })
    expect(payload).toEqual({ taskType: 'find_subtitle', seasons: [1, 2, 3], reason: 'sweep whole series', includeThrottled: false })
  })

  it('dispatch: seasons 省略/None → payload.seasons=null（全部有缺口的季）', async () => {
    const counter: DispatchCounter = { count: 0 }
    const calls: unknown[][] = []
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      {
        jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args); return { outcome: 'created' } as const } },
        now: () => 1000, parentJobId: null,
      }, counter,
    )
    await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: null, movieId: null, reason: 'whole series, all gaps', includeThrottled: null }, fakeOpts)
    expect(calls).toHaveLength(1)
    const [ident, payload] = calls[0]
    expect(ident).toEqual({ seriesId: 's1', season: null, movieId: null })
    expect(payload).toEqual({ taskType: 'find_subtitle', seasons: null, reason: 'whole series, all gaps', includeThrottled: false })
  })

  // F-R2-4（R2 复审，审计定罪：停牌提前重派的管道缺失）：includeThrottled 是真模型容错字段——
  // 省略/"None" 一律折叠为 null，execute() 里再显式 !!includeThrottled 折成 false，不让 null
  // 悄悄经 JSON.stringify 泄漏成 payload 里的 null（该字段的下游消费者按布尔读，不按三态读）。
  describe('dispatch_find_subtitle_task includeThrottled (F-R2-4)', () => {
    it('省略 includeThrottled → schema 校验出 null，payload 写 false（既有默认语义不变）', async () => {
      const counter: DispatchCounter = { count: 0 }
      const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
        { jobs: { upsertWorkerTask: () => ({ outcome: 'created' as const }) }, now: () => 1000, parentJobId: null }, counter,
      )
      const validated = await validate(dispatchFindSubtitle.inputSchema, { seriesId: 's1', reason: 'x' })
      expect(validated).toEqual({
        success: true,
        value: { seriesId: 's1', seasons: null, movieId: null, reason: 'x', includeThrottled: null },
      })
    })

    it('includeThrottled:true → payload.includeThrottled=true（操作员确认情况已变，主代理主动放宽）', async () => {
      const counter: DispatchCounter = { count: 0 }
      const calls: unknown[][] = []
      const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
        {
          jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args); return { outcome: 'created' } as const } },
          now: () => 1000, parentJobId: null,
        }, counter,
      )
      await dispatchFindSubtitle.execute!(
        { seriesId: 's1', seasons: null, movieId: null, includeThrottled: true, reason: 'operator fixed naming' }, fakeOpts,
      )
      expect(calls).toHaveLength(1)
      const [, payload] = calls[0]
      expect(payload).toEqual({
        taskType: 'find_subtitle', seasons: null, reason: 'operator fixed naming', includeThrottled: true,
      })
    })

    it('includeThrottled 省略/null → payload.includeThrottled=false（默认，不放宽）', async () => {
      const counter: DispatchCounter = { count: 0 }
      const calls: unknown[][] = []
      const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
        {
          jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args); return { outcome: 'created' } as const } },
          now: () => 1000, parentJobId: null,
        }, counter,
      )
      await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: null, movieId: null, reason: 'routine', includeThrottled: null }, fakeOpts)
      expect(calls).toHaveLength(1)
      const [, payload] = calls[0]
      expect(payload).toEqual({ taskType: 'find_subtitle', seasons: null, reason: 'routine', includeThrottled: false })
    })
  })

  it('dispatch_find_subtitle_task: seriesId 与 movieId 互斥仍然强制', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => { throw new Error('must never be called') } }, now: () => 1000, parentJobId: null }, counter,
    )
    const both = await validate(dispatchFindSubtitle.inputSchema, { seriesId: 's1', movieId: 'm1', reason: 'x' })
    expect(both.success).toBe(false)
    const neither = await validate(dispatchFindSubtitle.inputSchema, { seriesId: null, movieId: null, reason: 'x' })
    expect(neither.success).toBe(false)
  })
})

// R-2（裁决 2026-07-16，审计 A-F1/F2）：upsertWorkerTask 曾经对非 done 态行静默 no-op，而 dispatch
// 工具无条件回报 {dispatched:true}——dormant/failed 行悄悄吞掉主代理的新派发还谎报成功（永久
// 活锁）。这里锁死 dispatch 工具如实转告 upsertWorkerTask 的四态回执，且 coalesced/blocked_dormant
// 不耗 dispatch 预算（cap 只数真正落地的新/复活行）。
describe('dispatch_find_subtitle_task / dispatch_realign_task 如实转告 upsertWorkerTask 回执 (R-2)', () => {
  it('created → {dispatched:true, outcome:created, remainingCapacity}，耗 1 个 cap 名额', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' }) }, now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5 },
      counter,
    )
    const result = await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1], movieId: null, reason: 'x', includeThrottled: null }, fakeOpts)
    expect(result).toEqual({ dispatched: true, outcome: 'created', remainingCapacity: 4 })
    expect(counter.count).toBe(1)
  })

  it('revived → {dispatched:true, outcome:revived, remainingCapacity}，同 created 一样耗 cap', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'revived' }) }, now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5 },
      counter,
    )
    const result = await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1], movieId: null, reason: 'x', includeThrottled: null }, fakeOpts)
    expect(result).toEqual({ dispatched: true, outcome: 'revived', remainingCapacity: 4 })
    expect(counter.count).toBe(1)
  })

  // F-R2-5（R2 复审，审计定罪：coalesced 谎报"identical"+新意图丢弃）：note 措辞按
  // intentRefreshed 分流——wanted/failed 行的 payload 真的被刷新了（intentRefreshed:true），
  // note 如实说"merged...refreshed to yours"；active 行的 payload 保持不动
  // （intentRefreshed:false），note 如实说"NOT applied to the in-flight run"。旧的单一"an
  // identical task"措辞对 wanted/failed 已经不准确（往往不是 identical，只是同一 identity，
  // 且这次的新意图确实被采纳了）。
  it('coalesced（intentRefreshed:true，wanted/failed 行）→ {dispatched:false, outcome:coalesced, pendingState, note}，不耗 cap', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      {
        jobs: { upsertWorkerTask: () => ({ outcome: 'coalesced', pendingState: 'wanted', intentRefreshed: true }) },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const result = await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1], movieId: null, reason: 'x', includeThrottled: null }, fakeOpts)
    expect(result).toEqual({
      dispatched: false, outcome: 'coalesced', pendingState: 'wanted',
      note: 'merged into the pending task and its scope/reason was refreshed to yours',
    })
    expect(counter.count).toBe(0)
  })

  it('coalesced（intentRefreshed:false，active 行）→ note 如实说新 scope 未套用到在跑的行', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      {
        jobs: { upsertWorkerTask: () => ({ outcome: 'coalesced', pendingState: 'searching', intentRefreshed: false }) },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const result = await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1], movieId: null, reason: 'x', includeThrottled: null }, fakeOpts)
    expect(result).toEqual({
      dispatched: false, outcome: 'coalesced', pendingState: 'searching',
      note: 'already running — your new scope was NOT applied to the in-flight run; re-dispatch after it completes if it still matters',
    })
    expect(counter.count).toBe(0)
  })

  it('blocked_dormant → {dispatched:false, outcome:blocked_dormant, reason, note}，不耗 cap', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      {
        jobs: { upsertWorkerTask: () => ({ outcome: 'blocked_dormant', lastError: 'config defect' }) },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const result = await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1], movieId: null, reason: 'x', includeThrottled: null }, fakeOpts)
    expect(result).toEqual({
      dispatched: false, outcome: 'blocked_dormant', reason: 'config defect',
      note: 'this identity is parked dormant (a configuration-class defect was recorded) — dispatching cannot revive it; surface this to the operator if it matters',
    })
    expect(counter.count).toBe(0)
  })

  it('cap 已满时 capCheck 仍先于 upsertWorkerTask 拒绝（cap 满即拒，不看 upsertWorkerTask 会返回什么）', async () => {
    const counter: DispatchCounter = { count: 2 }
    const dispatchFindSubtitle = makeDispatchFindSubtitleTaskTool(
      {
        jobs: { upsertWorkerTask: () => { throw new Error('must never be called — cap must reject first') } },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 2,
      },
      counter,
    )
    const result = await dispatchFindSubtitle.execute!({ seriesId: 's1', seasons: [1], movieId: null, reason: 'x', includeThrottled: null }, fakeOpts)
    expect(result).toEqual({
      error: 'dispatch cap (2) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly',
    })
  })

  // dispatch_realign_task 是同一份回执逻辑的第二个调用点——同样锁死。
  it('dispatch_realign_task: coalesced → 不耗 cap；created → 耗 cap', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchRealign = makeDispatchRealignTaskTool(
      {
        jobs: { upsertWorkerTask: () => ({ outcome: 'coalesced', pendingState: 'failed', intentRefreshed: true }) },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const coalescedResult = await dispatchRealign.execute!({ seriesId: 's1', reason: 'x' }, fakeOpts)
    expect(coalescedResult).toEqual({
      dispatched: false, outcome: 'coalesced', pendingState: 'failed',
      note: 'merged into the pending task and its scope/reason was refreshed to yours',
    })
    expect(counter.count).toBe(0)

    const dispatchRealign2 = makeDispatchRealignTaskTool(
      { jobs: { upsertWorkerTask: () => ({ outcome: 'created' }) }, now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5 },
      counter,
    )
    const createdResult = await dispatchRealign2.execute!({ seriesId: 's2', reason: 'x' }, fakeOpts)
    expect(createdResult).toEqual({ dispatched: true, outcome: 'created', remainingCapacity: 4 })
    expect(counter.count).toBe(1)
  })

  it('dispatch_realign_task: blocked_dormant → {dispatched:false, outcome:blocked_dormant, reason}，不耗 cap', async () => {
    const counter: DispatchCounter = { count: 0 }
    const dispatchRealign = makeDispatchRealignTaskTool(
      {
        jobs: { upsertWorkerTask: () => ({ outcome: 'blocked_dormant', lastError: 'realign executor not wired' }) },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const result = await dispatchRealign.execute!({ seriesId: 's1', reason: 'x' }, fakeOpts)
    expect(result).toEqual({
      dispatched: false, outcome: 'blocked_dormant', reason: 'realign executor not wired',
      note: 'this identity is parked dormant (a configuration-class defect was recorded) — dispatching cannot revive it; surface this to the operator if it matters',
    })
    expect(counter.count).toBe(0)
  })

  // 救援R3：dispatch_rescue_task 固定单例身份，共享 dispatch 预算，四态回执与 realign 工具同形。
  it('dispatch_rescue_task: created → {dispatched:true, outcome:created, remainingCapacity}，耗 1 个 cap 名额', async () => {
    const counter: DispatchCounter = { count: 0 }
    const calls: unknown[][] = []
    const dispatchRescue = makeDispatchRescueTaskTool(
      {
        jobs: { upsertWorkerTask: (...args: unknown[]) => { calls.push(args); return { outcome: 'created' } as const } },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const result = await dispatchRescue.execute!({ reason: 'parked backlog looks worth a rescue pass' }, fakeOpts)
    expect(result).toEqual({ dispatched: true, outcome: 'created', remainingCapacity: 4 })
    expect(counter.count).toBe(1)
    expect(calls).toHaveLength(1)
    const [ident, payload] = calls[0]
    expect(ident).toEqual({ seriesId: 'rescue-backlog', season: null, movieId: null })
    expect(payload).toEqual({ taskType: 'rescue_identify', reason: 'parked backlog looks worth a rescue pass' })
  })

  it('dispatch_rescue_task: second call coalesces into the singleton identity without consuming cap', async () => {
    const counter: DispatchCounter = { count: 1 }
    const dispatchRescue = makeDispatchRescueTaskTool(
      {
        jobs: { upsertWorkerTask: () => ({ outcome: 'coalesced', pendingState: 'wanted', intentRefreshed: true }) },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 5,
      },
      counter,
    )
    const result = await dispatchRescue.execute!({ reason: 'still worth a rescue pass' }, fakeOpts)
    expect(result).toEqual({
      dispatched: false, outcome: 'coalesced', pendingState: 'wanted',
      note: 'merged into the pending task and its scope/reason was refreshed to yours',
    })
    expect(counter.count).toBe(1)
  })

  it('dispatch_rescue_task: cap reached returns error before upsertWorkerTask', async () => {
    const counter: DispatchCounter = { count: 2 }
    const dispatchRescue = makeDispatchRescueTaskTool(
      {
        jobs: { upsertWorkerTask: () => { throw new Error('must never be called — cap must reject first') } },
        now: () => 1000, parentJobId: null, maxDispatchesPerOrchestrator: 2,
      },
      counter,
    )
    const result = await dispatchRescue.execute!({ reason: 'cap full' }, fakeOpts)
    expect(result).toEqual({
      error: 'dispatch cap (2) reached for this orchestrator — call spawn_sibling_orchestrator to hand off the rest instead of dispatching more directly',
    })
  })
})

// F-R2-2（R2 复审）：spawn_sibling_orchestrator 曾经丢弃 upsertWorkerTask 的返回值、无条件回报
// {spawned:true}——同一分片身份（seriesId 由 parentJobId+shardIndex 合成）若已有一行在途/停车，
// 本次派发的 remainingWorkSummary 悄悄被吞掉，主代理却看到"已生成"的假象。如实转告四态，同
// dispatch 工具一样的诚实纪律（但字段名是 spawned 不是 dispatched，且不涉及 dispatch cap）。
describe('spawn_sibling_orchestrator 如实转告 upsertWorkerTask 回执 (F-R2-2)', () => {
  it('created → {spawned:true, outcome:created}', async () => {
    const spawnSibling = makeSpawnSiblingOrchestratorTool({
      jobs: { upsertWorkerTask: () => ({ outcome: 'created' }) }, now: () => 1000, parentJobId: null,
    })
    const result = await spawnSibling.execute!({ shardIndex: 0, remainingWorkSummary: 'x' }, fakeOpts)
    expect(result).toEqual({ spawned: true, outcome: 'created' })
  })

  it('revived → {spawned:true, outcome:revived}', async () => {
    const spawnSibling = makeSpawnSiblingOrchestratorTool({
      jobs: { upsertWorkerTask: () => ({ outcome: 'revived' }) }, now: () => 1000, parentJobId: null,
    })
    const result = await spawnSibling.execute!({ shardIndex: 0, remainingWorkSummary: 'x' }, fakeOpts)
    expect(result).toEqual({ spawned: true, outcome: 'revived' })
  })

  // F-R2-2 × F-R2-5 主控裁决收口：coalesce 送没送到 summary 取决于 intentRefreshed——
  // 待跑行（wanted/failed）的 payload 被刷新，summary 实际送达；在跑行（active）才是真没送到。
  // 回执按事实分叉，不用一句对半错的固定文案。
  it('coalesced（待跑行，intentRefreshed:true）→ note 如实说 handoff note 已刷新送达', async () => {
    const spawnSibling = makeSpawnSiblingOrchestratorTool({
      jobs: { upsertWorkerTask: () => ({ outcome: 'coalesced', pendingState: 'wanted', intentRefreshed: true }) }, now: () => 1000, parentJobId: null,
    })
    const result = await spawnSibling.execute!({ shardIndex: 0, remainingWorkSummary: 'x' }, fakeOpts)
    expect(result).toMatchObject({ spawned: false, outcome: 'coalesced', pendingState: 'wanted' })
    expect((result as { note: string }).note).toMatch(/refreshed to YOUR remainingWorkSummary/)
  })

  it('coalesced（在跑行，intentRefreshed:false）→ note 如实说 summary 未送达', async () => {
    const spawnSibling = makeSpawnSiblingOrchestratorTool({
      jobs: { upsertWorkerTask: () => ({ outcome: 'coalesced', pendingState: 'searching', intentRefreshed: false }) }, now: () => 1000, parentJobId: null,
    })
    const result = await spawnSibling.execute!({ shardIndex: 0, remainingWorkSummary: 'x' }, fakeOpts)
    expect((result as { note: string }).note).toMatch(/NOT delivered/)
  })

  it('blocked_dormant → {spawned:false, outcome:blocked_dormant, reason, note}（同 dispatch 工具的诚实形态）', async () => {
    const spawnSibling = makeSpawnSiblingOrchestratorTool({
      jobs: { upsertWorkerTask: () => ({ outcome: 'blocked_dormant', lastError: 'config defect' }) }, now: () => 1000, parentJobId: null,
    })
    const result = await spawnSibling.execute!({ shardIndex: 0, remainingWorkSummary: 'x' }, fakeOpts)
    expect(result).toEqual({
      spawned: false, outcome: 'blocked_dormant', reason: 'config defect',
      note: 'this identity is parked dormant (a configuration-class defect was recorded) — dispatching cannot revive it; surface this to the operator if it matters',
    })
  })
})

describe('makeCheckSeriesLayoutTool', () => {
  // Root cause under test: the orchestrator model has NO source for a series' tmdbId
  // (list_missing_coverage rows carry no tmdbId field) — the tool must resolve tmdbId itself,
  // NOT take it as a model-supplied input. 去 Jellyfin 化 P4: this resolution is now a pure,
  // zero-I/O string parse (tmdbIdFromOwnId, src/v2/ownIds.ts) off the seriesId itself (own-id
  // space: series.id = 'tmdb:<TMDB id>') — no more live jf.getItem lookup.
  it('resolves tmdbId internally from seriesId itself and reports exceedsSeasonTable:true when the mirror overshoots the TMDB season table', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'> = {
      countEpisodesInSeason: (seriesId, season) => {
        expect(seriesId).toBe('tmdb:1429')
        expect(season).toBe(2)
        return 30
      },
      getSeries: () => ({ layout_nonstandard: 0 } as any),
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async (tmdbId) => {
        expect(tmdbId).toBe('1429')
        return [{ seasonNumber: 2, episodeCount: 12, airDate: null }] as any
      },
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'tmdb:1429', season: 2 }, fakeOpts)

    expect(result).toEqual({
      mirrorEpisodeCount: 30, tmdbEpisodeCount: 12, exceedsSeasonTable: true,
      tmdbUnavailable: false, diskLayoutNonstandard: false,
    })
  })

  it('gracefully reports exceedsSeasonTable:false, tmdbUnavailable:true (never throws) when seriesId does not conform to the tmdb:<id> own-id shape', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'> = {
      countEpisodesInSeason: () => 30,
      getSeries: () => ({ layout_nonstandard: 0 } as any),
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async () => { throw new Error('must never be called — no tmdbId to look up') },
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'not-a-tmdb-id', season: 2 }, fakeOpts)

    expect(result).toEqual({
      mirrorEpisodeCount: 30, tmdbEpisodeCount: null, exceedsSeasonTable: false,
      tmdbUnavailable: true, diskLayoutNonstandard: false,
    })
  })

  // Task 8c（裁决 R-4，审计发现 B6/B7）：事实与结论分离——一次 TMDB 抛错（超时/5xx/网络故障）
  // 之前会被 .catch(() => null) 悄悄折叠成跟"TMDB 真的没查到"一模一样的 exceedsSeasonTable:
  // false，orchestrator 无法分辨"这季真的没超"和"这次没查成，应该重试"。tmdbUnavailable:true
  // 把这个事实摆出来，exceedsSeasonTable 仍然如实报 false（没有确定性信号时不猜）。
  it('TMDB 查询抛错（非 tmdbId 解析失败）→ tmdbUnavailable:true, exceedsSeasonTable:false', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'> = {
      countEpisodesInSeason: () => 30,
      getSeries: () => ({ layout_nonstandard: 0 } as any),
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async () => { throw new Error('TMDB 5xx / timeout') },
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'tmdb:1429', season: 2 }, fakeOpts)

    expect(result).toEqual({
      mirrorEpisodeCount: 30, tmdbEpisodeCount: null, exceedsSeasonTable: false,
      tmdbUnavailable: true, diskLayoutNonstandard: false,
    })
  })

  // Task 8c（审计发现 B12）：series.layout_nonstandard（schema v10，摄取层写入）如实透传——
  // 这是与 exceedsSeasonTable 独立的第二个布局事实，摄取层观察到的非常规磁盘布局，不受
  // TMDB 查询结果影响。
  it('series.layout_nonstandard=1 → diskLayoutNonstandard:true', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'> = {
      countEpisodesInSeason: () => 5,
      getSeries: (id) => {
        expect(id).toBe('tmdb:1429')
        return { layout_nonstandard: 1 } as any
      },
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = {
      getSeasonTable: async () => [{ seasonNumber: 2, episodeCount: 12, airDate: null }] as any,
    }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'tmdb:1429', season: 2 }, fakeOpts)

    expect(result).toEqual({
      mirrorEpisodeCount: 5, tmdbEpisodeCount: 12, exceedsSeasonTable: false,
      tmdbUnavailable: false, diskLayoutNonstandard: true,
    })
  })

  it('series row missing entirely (getSeries returns null) → diskLayoutNonstandard:false, never throws', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'> = {
      countEpisodesInSeason: () => 0,
      getSeries: () => null,
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = { getSeasonTable: async () => null }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await checkSeriesLayout.execute!({ seriesId: 'tmdb:1429', season: 2 }, fakeOpts)

    expect(result).toEqual({
      mirrorEpisodeCount: 0, tmdbEpisodeCount: null, exceedsSeasonTable: false,
      tmdbUnavailable: false, diskLayoutNonstandard: false,
    })
  })

  it('no tmdbId param in the input schema (model cannot fabricate one) — seriesId/season alone validate', async () => {
    const lib: Pick<LibraryRepo, 'countEpisodesInSeason' | 'getSeries'> = {
      countEpisodesInSeason: () => 0,
      getSeries: () => null,
    }
    const tmdb: Pick<TmdbClient, 'getSeasonTable'> = { getSeasonTable: async () => null }
    const checkSeriesLayout = makeCheckSeriesLayoutTool(lib, tmdb)

    const result = await validate(checkSeriesLayout.inputSchema, { seriesId: 's1', season: 2 })
    expect(result).toEqual({ success: true, value: { seriesId: 's1', season: 2 } })
  })
})
