import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { JobsRepo, ERROR_BACKOFF_MS } from './jobsRepo.js'
import { LibraryRepo } from './libraryRepo.js'
import { RunsRepo } from './runsRepo.js'
import { executeJob, makeRunEpisode, type ExecutorDeps } from './executor.js'
import { runPipeline } from '../core/pipeline.js'
import type { Assembled } from '../cli/index.js'
import type { SeasonEpisode } from '../core/episode.js'

vi.mock('../core/pipeline.js', () => ({ runPipeline: vi.fn() }))
const runPipelineMock = vi.mocked(runPipeline)

let lib: LibraryRepo
let jobs: JobsRepo
let runs: RunsRepo
let now: number
let logs: string[]

beforeEach(() => {
  const db = openDb(':memory:')
  lib = new LibraryRepo(db)
  jobs = new JobsRepo(db)
  runs = new RunsRepo(db)
  now = Date.now()
  logs = []
  runPipelineMock.mockReset()
})

const log = (msg: string) => logs.push(msg)

const mkEpisode = (id: string, seriesId: string, season: number, episode: number, subStatus: 'missing' | 'covered' = 'missing') => {
  lib.upsertSeries({ id: seriesId, name: 'Test Series' })
  lib.upsertEpisode({ id, seriesId, season, episode, name: `Episode ${episode}`, path: `/tv/s${season}e${episode}.mkv`, subStatus })
}

const mkMovie = (id: string, subStatus: 'missing' | 'covered' = 'missing') => {
  lib.upsertMovie({ id, name: 'Test Movie', path: '/movies/test.mkv', subStatus })
}

const mkDeps = (runEpisode: ExecutorDeps['runEpisode']): ExecutorDeps =>
  ({ lib, jobs, runEpisode, now: () => now, log })

describe('executor', () => {
  it('重derive targets：跑前用户手动放了字幕的集不再处理', async () => {
    // Setup: 3 episodes, e1 is manually covered, e2 and e3 are missing
    mkEpisode('e1', 's1', 1, 1, 'covered')
    mkEpisode('e2', 's1', 1, 2)
    mkEpisode('e3', 's1', 1, 3)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: only e2 is representative (min episode number among missing)
    const runEpisode = vi.fn(async (episodeId: string) => {
      expect(episodeId).toBe('e2') // Should pick e2, not e1 (covered)
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Downloaded successfully' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify runEpisode was called with e2 (the min episode number among missing)
    expect(runEpisode).toHaveBeenCalledTimes(1)
  })

  it('季包覆盖：runEpisode stub 触发 onCovered(e1..e3) → 三集 covered + job done + runs 记录', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    mkEpisode('e3', 's1', 1, 3)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: season pack covers all 3 episodes via onCovered callback
    const runEpisode = vi.fn(async (episodeId: string, onCovered: (id: string, path: string) => void) => {
      expect(episodeId).toBe('e1')
      // Simulate season pack covering all episodes
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      onCovered('e2', '/tv/s1e2.zh-Hans.srt')
      onCovered('e3', '/tv/s1e3.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Season pack downloaded' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify all 3 episodes are covered
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e2')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e3')!.sub_status).toBe('covered')

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')

    // Verify runs record exists
    const runRecords = runs.getByJobId(job.id)
    expect(runRecords.length).toBe(1)
    expect(runRecords[0].decision).toBe('download')
    expect(runRecords[0].detail).toBe('Season pack downloaded')
  })

  it('部分覆盖：只 covered e1 → completePartial（job 回 wanted, attempt-1），已覆盖战果保留', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    mkEpisode('e3', 's1', 1, 3)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    // Simulate a previous failure
    jobs.completeNoMatch(job.id, now)
    const job2 = jobs.forceClaim('s1', 1, now)!
    expect(job2.attempt).toBe(1)

    // Mock runEpisode: only covers e1
    const runEpisode = vi.fn(async (episodeId: string, onCovered: (id: string, path: string) => void) => {
      expect(episodeId).toBe('e1')
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'Partial coverage' }
    })

    await executeJob(job2, mkDeps(runEpisode))

    // Verify e1 is covered but e2, e3 are still missing
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e2')!.sub_status).toBe('missing')
    expect(lib.getEpisode('e3')!.sub_status).toBe('missing')

    // Verify job is back to wanted with attempt decremented
    const finalJob = jobs.get(job2.id)!
    expect(finalJob.state).toBe('wanted')
    expect(finalJob.attempt).toBe(0) // decremented from 1
  })

  it('全军覆没 no_safe_match → completeNoMatch + 未覆盖集标记 unavailable', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: no match found
    const runEpisode = vi.fn(async () => {
      return { decision: 'no_safe_match', journalPath: '/journals/test.json', detail: 'No safe match found' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify episodes are marked as unavailable
    const ep1 = lib.getEpisode('e1')!
    const ep2 = lib.getEpisode('e2')!
    expect(ep1.sub_status).toBe('unavailable')
    expect(ep2.sub_status).toBe('unavailable')
    expect(ep1.recheck_after).toBeGreaterThan(now)
    expect(ep2.recheck_after).toBeGreaterThan(now)

    // Verify job is failed (or dormant after multiple attempts)
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
  })

  it('runEpisode 抛错 → completeError，短退避', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: throws error
    const runEpisode = vi.fn(async () => {
      throw new Error('ASSRT API timeout')
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify job is failed with error
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    expect(finalJob.last_error).toContain('ASSRT API timeout')
    expect(finalJob.next_retry_at).toBe(now + ERROR_BACKOFF_MS[0]) // short backoff (30s)
  })

  it('C1: decision=error（pipeline 内部 catch 不 throw）→ completeError 短退避轨，不掉内容轨', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => {
      // pipeline.ts 外层 catch 是 return finish('error') 而不是 throw
      return { decision: 'error', journalPath: '/journals/err.json', detail: 'LLM 502' }
    })

    await executeJob(job, mkDeps(runEpisode))

    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    // 短退避窗口（30s），而不是内容轨的 1 天
    expect(finalJob.next_retry_at).toBe(now + ERROR_BACKOFF_MS[0])
    expect(finalJob.last_error).toBe('LLM 502')
    // 集不被标 unavailable（这不是内容性结论）
    expect(lib.getEpisode('e1')!.sub_status).toBe('missing')
  })

  it('C1: decision=retry_later 同走短退避轨', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({ decision: 'retry_later' }))

    await executeJob(job, mkDeps(runEpisode))

    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    expect(finalJob.next_retry_at).toBe(now + ERROR_BACKOFF_MS[0])
    expect(lib.getEpisode('e1')!.sub_status).toBe('missing')
  })

  it('I4: 租约被回收后 complete* 守卫失败 → warn 日志 + runs.detail 带弃置后缀', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    // 模拟执行期间租约过期被 reap 归位（job 不再是 active 态）
    jobs.forceState('s1', 1, 'wanted', now)

    const runEpisode = vi.fn(async (_: string, onCovered: (id: string, path: string) => void) => {
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json', detail: 'covered all' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // completeDone 守卫失败（state=wanted 非 active）→ warn + 后缀
    expect(logs.some(l => l.includes(`job ${job.id} 结果被弃置`))).toBe(true)
    const runRecords = runs.getByJobId(job.id)
    expect(runRecords.length).toBe(1)
    expect(runRecords[0].detail).toContain('(stale-lease 弃置)')
    // 战果本身保留（episodes 已写盘为准）
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    // job 状态未被弃置结果覆盖
    expect(jobs.get(job.id)!.state).toBe('wanted')
  })

  it('movie job 同构', async () => {
    mkMovie('m1')
    jobs.upsertWanted({ kind: 'movie', movieId: 'm1' }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: movie download
    const runEpisode = vi.fn(async (itemId: string) => {
      expect(itemId).toBe('m1')
      return { decision: 'download', journalPath: '/journals/test.json', detail: '/movies/test.zh-Hans.srt' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify movie is covered
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')
  })

  it('代表集自身被搞定但未走季包：download → markCovered(detail 路径, scout-download)', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: only representative episode covered (no season pack callback)
    const runEpisode = vi.fn(async (episodeId: string) => {
      expect(episodeId).toBe('e1')
      // No onCovered callback, but decision is download with subtitlePath in detail
      return { decision: 'download', journalPath: '/journals/test.json', detail: '/tv/s1e1.zh-Hans.srt' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify e1 is covered with real subtitles row (M8: source=scout-download)
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/tv/s1e1.zh-Hans.srt',
      source: 'scout-download',
    })

    // Verify e2 is still missing
    expect(lib.getEpisode('e2')!.sub_status).toBe('missing')

    // Verify job is partial (back to wanted since e2 still missing)
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('wanted')
  })

  it('M7/M8: already_exists → 代表集 covered 但不伪造 subtitles 行', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({
      decision: 'already_exists',
      journalPath: '/journals/test.json',
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    // M7: null 路径 → 不插 subtitles 行
    expect((lib.db.prepare('select count(*) c from subtitles where item_id=?').get('e1') as any).c).toBe(0)
    expect(jobs.get(job.id)!.state).toBe('done')
  })

  it('M8: adopted_local → source=adopted-local', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({
      decision: 'adopted_local',
      journalPath: '/journals/test.json',
      detail: '/tv/s1e1.zh-Hans.ass',
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/tv/s1e1.zh-Hans.ass',
      source: 'adopted-local',
    })
  })

  it('targets 为空时直接 completeDone', async () => {
    // Setup: all episodes already covered
    mkEpisode('e1', 's1', 1, 1, 'covered')
    mkEpisode('e2', 's1', 1, 2, 'covered')
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn()
    await executeJob(job, mkDeps(runEpisode))

    // Verify runEpisode was never called
    expect(runEpisode).not.toHaveBeenCalled()

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')
  })
})

describe('makeRunEpisode (Layer 2 接线)', () => {
  let mediaRoot: string
  let cacheRoot: string

  beforeEach(() => {
    mediaRoot = mkdtempSync(join(tmpdir(), 'scout-media-'))
    cacheRoot = mkdtempSync(join(tmpdir(), 'scout-cache-'))
    mkdirSync(join(mediaRoot, 'movie'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE
  })

  const mkAssembled = (jf: unknown): Assembled =>
    ({
      makeDeps: vi.fn((perRun?: unknown) => ({ perRun })),
      withJournal: <T,>(fn: () => Promise<T>) => fn(),
      cacheRoot,
      llm: { profileInfo: () => ({ mode: 'stub' }) },
      jf,
      mappings: [],
    }) as unknown as Assembled

  const mkJf = (path: string) => ({
    getItem: vi.fn(async () => ({ Id: 'm1', Type: 'Movie', Name: 'Test Movie', Path: path })),
    getChineseTitle: vi.fn(async () => null),
    refreshItem: vi.fn(async () => {}),
  })

  it('I5b: mediaDir 越出媒体根 → throw 人话错误（走 completeError）', async () => {
    const jf = mkJf(join(mediaRoot, 'movie', 'test.mkv'))
    const runEpisode = makeRunEpisode(mkAssembled(jf), lib, { mediaRoots: ['/some/other/root'] })

    await expect(runEpisode('m1', vi.fn())).rejects.toThrow(/拒绝在媒体根目录之外写入/)
    expect(runPipelineMock).not.toHaveBeenCalled()
  })

  it('I5a/e: ctx 应用置信度覆盖 + runPipeline 传 bypassNegativeCache', async () => {
    process.env.AUTO_DOWNLOAD_MIN_CONFIDENCE = '0.5'
    const jf = mkJf(join(mediaRoot, 'movie', 'test.mkv'))
    runPipelineMock.mockResolvedValue({
      decision: 'download',
      subtitlePath: '/subs/x.srt',
      journalPath: '/j.json',
      stats: { durationMs: 1, llmCalls: 0, apiCalls: 0 },
    })

    const runEpisode = makeRunEpisode(mkAssembled(jf), lib, { mediaRoots: [mediaRoot] })
    const result = await runEpisode('m1', vi.fn())

    expect(result).toEqual({ decision: 'download', journalPath: '/j.json', detail: '/subs/x.srt' })
    const [, ctx, outDir, , opts] = runPipelineMock.mock.calls[0]
    expect(ctx.preferences.auto_download_min_confidence).toBe(0.5) // I5a
    expect(outDir).toBe(join(mediaRoot, 'movie'))
    expect(opts).toEqual({ bypassNegativeCache: true }) // I5e
  })

  it('I5d: onCovered 适配层回调 deps 并 refreshItem（v1 语义）', async () => {
    const jf = mkJf(join(mediaRoot, 'movie', 'test.mkv'))
    const assembled = mkAssembled(jf)
    runPipelineMock.mockResolvedValue({
      decision: 'download',
      journalPath: '/j.json',
      stats: { durationMs: 1, llmCalls: 0, apiCalls: 0 },
    })

    const onCovered = vi.fn()
    const runEpisode = makeRunEpisode(assembled, lib, { mediaRoots: [mediaRoot] })
    await runEpisode('m1', onCovered)

    // 从 makeDeps 捕获 perRun.onCovered 适配器，模拟季包命中一集
    const perRun = vi.mocked(assembled.makeDeps).mock.calls[0][0]!
    const ep = { itemId: 'e9', seasonNumber: 1, episodeNumber: 9, episodeCode: 'S01E09', videoPath: '/v', videoFilename: 'v.mkv', needsChinese: true } satisfies SeasonEpisode
    await perRun.onCovered(ep, '/subs/e9.srt')

    expect(onCovered).toHaveBeenCalledWith('e9', '/subs/e9.srt')
    expect(jf.refreshItem).toHaveBeenCalledWith('e9') // I5d
  })
})
