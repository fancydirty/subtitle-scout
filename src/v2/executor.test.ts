import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { JobsRepo, ERROR_BACKOFF_MS, ERROR_GIVEUP_THRESHOLD, ERROR_BACKOFF_DAILY_MS } from './jobsRepo.js'
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
      return { decision: 'download', journalPath: '/journals/test.json' }
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
    const runEpisode = vi.fn(async (episodeId: string, onCovered: (id: string, path: string, providerRef?: string) => void) => {
      expect(episodeId).toBe('e1')
      // Simulate season pack covering all episodes (MS-P1: 季包路径携带 provider_ref)
      onCovered('e1', '/tv/s1e1.zh-Hans.srt', 'assrt:900900')
      onCovered('e2', '/tv/s1e2.zh-Hans.srt', 'assrt:900900')
      onCovered('e3', '/tv/s1e3.zh-Hans.srt', 'assrt:900900')
      return { decision: 'download', journalPath: '/journals/test.json' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify all 3 episodes are covered
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e2')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e3')!.sub_status).toBe('covered')

    // MS-P1: 季包覆盖的每集 subtitles 行都带 provider_ref
    for (const id of ['e1', 'e2', 'e3']) {
      expect(lib.db.prepare('select provider_ref from subtitles where item_id=?').get(id)).toEqual({
        provider_ref: 'assrt:900900',
      })
    }

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')

    // Verify runs record exists，detail 为人话摘要（季号 + 命中集数，无路径）
    const runRecords = runs.getByJobId(job.id)
    expect(runRecords.length).toBe(1)
    expect(runRecords[0].decision).toBe('download')
    expect(runRecords[0].detail).toBe('第 1 季 3 集字幕已就位')
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
      return { decision: 'download', journalPath: '/journals/test.json' }
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
    // 部分覆盖单集 → runs.detail 人话摘要 SxxExx
    expect(runs.getByJobId(job2.id)[0].detail).toBe('S01E01 字幕已就位')
  })

  it('IMPORTANT-1a: 部分覆盖但携带 quotaExhausted → completePartial 按 resetAt+margin 排期，不走盲的 30 秒节流', async () => {
    // 季包/季横扫中途撞配额耗尽、已覆盖 e1 时，剩余部分不该在配额重置前每 30 秒重打一次全链路。
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    const resetAt = new Date(now + 3 * 3_600_000).toISOString()

    const runEpisode = vi.fn(async (episodeId: string, onCovered: (id: string, path: string) => void) => {
      expect(episodeId).toBe('e1')
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return {
        decision: 'download', journalPath: '/journals/test.json',
        quotaExhausted: { resetAt },
      }
    })

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.getEpisode('e2')!.sub_status).toBe('missing')

    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('wanted')
    // 不是盲的 30s 节流——对齐到 resetAt+margin
    expect(finalJob.next_retry_at).toBeGreaterThan(now + 60_000)
    expect(finalJob.next_retry_at).toBeGreaterThanOrEqual(Date.parse(resetAt))
  })

  it('全军覆没 no_safe_match → completeNoMatch + 未覆盖集标记 unavailable', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: no match found
    const runEpisode = vi.fn(async () => {
      return { decision: 'no_safe_match', journalPath: '/journals/test.json' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify episodes are marked as unavailable
    const ep1 = lib.getEpisode('e1')!
    const ep2 = lib.getEpisode('e2')!
    expect(ep1.sub_status).toBe('unavailable')
    expect(ep2.sub_status).toBe('unavailable')
    expect(ep1.recheck_after).toBeGreaterThan(now)
    expect(ep2.recheck_after).toBeGreaterThan(now)
    // status_reason 人话化（修掉英文 tooltip）
    expect(ep1.status_reason).toBe('没找到合适的中文字幕')

    // Verify job is failed (or dormant after multiple attempts)
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    // runs.detail 人话化
    expect(runs.getByJobId(job.id)[0].detail).toBe('没找到合适的中文字幕')
  })

  it('task 2: ask_user → needs_review（诚实区分"找到候选待确认"与穷尽未找到的 unavailable），detail 带置信数字', async () => {
    // 修正前：ask_user 和 no_safe_match 一样被 markUnavailable，前端展示"暂无"——
    // 掩盖了本可人工确认的候选。ask_user 仍走内容轨的 completeNoMatch（job 状态机
    // 语义不变，见同一 it 组的 no_safe_match 用例），只是集级 sub_status 诚实区分。
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({
      decision: 'ask_user',
      journalPath: '/journals/test.json',
      confidence: 0.82,
      minConfidence: 0.86,
    }))

    await executeJob(job, mkDeps(runEpisode))

    const ep1 = lib.getEpisode('e1')!
    expect(ep1.sub_status).toBe('needs_review')
    // 集级 status_reason 用带数字的详细版（供未来"确认队列"功能展示具体把握程度）
    expect(ep1.status_reason).toBe('找到候选但把握不足（置信 0.82 < 0.86），待人工确认')
    expect(ep1.recheck_after).toBeGreaterThan(now)
    expect(runs.getByJobId(job.id)[0].detail).toBe('找到候选但把握不足（置信 0.82 < 0.86），待人工确认')
    // job 状态机走内容轨，和 no_safe_match 一样（backoff/dormancy 语义不因 sub_status 改变而变）
    expect(jobs.get(job.id)!.state).toBe('failed')
    expect(jobs.get(job.id)!.attempt).toBe(1)
  })

  it('task 2: ask_user 复查到期后重新计入该季 remainingTargets（needs_review 可重新进入执行）', async () => {
    mkEpisode('e1', 's1', 1, 1)
    lib.markNeedsReview('e1', '找到候选但把握不足', now - 1) // 复查已到期
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async (episodeId: string) => {
      expect(episodeId).toBe('e1') // needs_review 且复查已到期——仍被当作待处理目标
      return { decision: 'download', journalPath: '/j.json', subtitlePath: '/tv/s1e1.zh-Hans.srt' }
    })

    await executeJob(job, mkDeps(runEpisode))
    expect(runEpisode).toHaveBeenCalledTimes(1)
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
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
    // runs.detail 人话化（错因保留但不裸露路径）
    expect(runs.getByJobId(job.id)[0].detail).toBe('遇到临时错误，稍后自动重试：ASSRT API timeout')
  })

  it('1b: error_attempt 跨过 ERROR_GIVEUP_THRESHOLD 时 warn 日志一次，退避变每天一次，state 仍 failed', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    // 先攒到刚好卡在阈值：error_attempt = ERROR_GIVEUP_THRESHOLD（尚未跨过，不该有日志）
    let claimed = jobs.claimNext(now)!
    for (let i = 0; i < ERROR_GIVEUP_THRESHOLD; i++) {
      jobs.completeError(claimed.id, 'timeout', now)
      claimed = jobs.forceClaim('s1', 1, now)!
    }
    expect(jobs.get(claimed.id)!.error_attempt).toBe(ERROR_GIVEUP_THRESHOLD)
    expect(logs.some(l => l.includes('退避'))).toBe(false)

    // 再一次瞬时错误：跨过阈值，触发一次性 warn 日志 + 退避升级为每天一次
    const runEpisode = vi.fn(async () => {
      throw new Error('ASSRT API timeout')
    })
    await executeJob(claimed, mkDeps(runEpisode))

    const finalJob = jobs.get(claimed.id)!
    expect(finalJob.state).toBe('failed') // 绝不转 dormant
    expect(finalJob.error_attempt).toBe(ERROR_GIVEUP_THRESHOLD + 1)
    expect(finalJob.next_retry_at).toBe(now + ERROR_BACKOFF_DAILY_MS)
    expect(logs.some(l => l.includes(`job ${claimed.id}`) && l.includes('每天'))).toBe(true)

    // 再次触发 completeError（已经在升级态）：不该重复打日志
    const logsBefore = logs.length
    const claimed2 = jobs.forceClaim('s1', 1, now)!
    await executeJob(claimed2, mkDeps(vi.fn(async () => { throw new Error('ASSRT API timeout') })))
    expect(logs.slice(logsBefore).some(l => l.includes('每天'))).toBe(false)
  })

  it('C1: decision=error（pipeline 内部 catch 不 throw）→ completeError 短退避轨，不掉内容轨', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => {
      // pipeline.ts 外层 catch 是 return finish('error') 而不是 throw
      return { decision: 'error', journalPath: '/journals/err.json', reasons: ['LLM 502'] }
    })

    await executeJob(job, mkDeps(runEpisode))

    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    // 短退避窗口（30s），而不是内容轨的 1 天
    expect(finalJob.next_retry_at).toBe(now + ERROR_BACKOFF_MS[0])
    expect(finalJob.last_error).toBe('LLM 502')
    // 集不被标 unavailable（这不是内容性结论）
    expect(lib.getEpisode('e1')!.sub_status).toBe('missing')
    // runs.detail 人话化，携带简短错因
    expect(runs.getByJobId(job.id)[0].detail).toBe('遇到临时错误，稍后自动重试：LLM 502')
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

  it('C1+quota: decision=error carrying quotaExhausted.resetAt → next_retry_at aligned to resetAt, not the short ladder', async () => {
    // 复现 bug：OS 20/日配额耗尽后，若这里丢了 resetAt，job 会在配额重置前每至多 15min 重打一次
    // 完整 identify+plan+search+/download，白烧 LLM/search 配额。
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    const resetAt = new Date(now + 3 * 3_600_000).toISOString()

    const runEpisode = vi.fn(async () => ({
      decision: 'error', journalPath: '/journals/quota.json',
      reasons: ['opensubtitles download quota exhausted'],
      quotaExhausted: { resetAt },
    }))

    await executeJob(job, mkDeps(runEpisode))

    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('failed')
    expect(finalJob.next_retry_at).toBeGreaterThan(now + ERROR_BACKOFF_MS[ERROR_BACKOFF_MS.length - 1])
    expect(finalJob.next_retry_at).toBeGreaterThanOrEqual(Date.parse(resetAt))
  })

  it('C1+quota: quotaExhausted present but resetAt null (proactive signal, no reset time) → falls back to the short ladder', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({
      decision: 'error', journalPath: '/journals/quota.json',
      reasons: ['opensubtitles download quota exhausted'],
      quotaExhausted: { resetAt: null },
    }))

    await executeJob(job, mkDeps(runEpisode))

    const finalJob = jobs.get(job.id)!
    expect(finalJob.next_retry_at).toBe(now + ERROR_BACKOFF_MS[0])
  })

  it('I4: 租约被回收后 complete* 守卫失败 → warn 日志 + runs.detail 带弃置后缀', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    // 模拟执行期间租约过期被 reap 归位（job 不再是 active 态）
    jobs.forceState('s1', 1, 'wanted', now)

    const runEpisode = vi.fn(async (_: string, onCovered: (id: string, path: string) => void) => {
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json' }
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
      return { decision: 'download', journalPath: '/journals/test.json', subtitlePath: '/movies/test.zh-Hans.srt' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify movie is covered
    expect(lib.getMovie('m1')!.sub_status).toBe('covered')

    // Verify job is done
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('done')
    // 电影 detail 人话摘要
    expect(runs.getByJobId(job.id)[0].detail).toBe('字幕已就位')
  })

  it('代表集自身被搞定但未走季包：download → markCovered(detail 路径, scout-download)', async () => {
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // Mock runEpisode: only representative episode covered (no season pack callback)
    const runEpisode = vi.fn(async (episodeId: string) => {
      expect(episodeId).toBe('e1')
      // No onCovered callback, but decision is download with subtitlePath
      return { decision: 'download', journalPath: '/journals/test.json', subtitlePath: '/tv/s1e1.zh-Hans.srt' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // Verify e1 is covered with real subtitles row (M8: source=scout-download)
    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    // IMPORTANT-2: executor 的 markCovered 调用不传 language 参数，必须仍落地默认值
    // zh-Hans（executor path unchanged — 只有 scanner.ts 的磁盘 arm 领养会显式传入真实语言）。
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/tv/s1e1.zh-Hans.srt',
      source: 'scout-download',
      language: 'zh-Hans',
    })

    // Verify e2 is still missing
    expect(lib.getEpisode('e2')!.sub_status).toBe('missing')

    // Verify job is partial (back to wanted since e2 still missing)
    const finalJob = jobs.get(job.id)!
    expect(finalJob.state).toBe('wanted')
  })

  it('MS-P1: runEpisode 结果带 selected → markCovered 写 provider_ref="<provider>:<providerId>"', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({
      decision: 'download',
      journalPath: '/journals/test.json',
      subtitlePath: '/tv/s1e1.zh-Hans.srt',
      selected: { provider: 'opensubtitles', provider_id: '7174766' },
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/tv/s1e1.zh-Hans.srt',
      provider_ref: 'opensubtitles:7174766',
    })
  })

  it('M7/M8: already_exists 携带真实路径 → 代表集 covered + subtitles 行记录真实路径/source=preexisting/无 provider_ref', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // 84fd17a: pipeline 的 already_exists 决策（预检或下载后 existsSync 两条路径）
    // 现在总是携带真实磁盘路径；selected 为 null（没有新的 resolve 发生）。
    const runEpisode = vi.fn(async () => ({
      decision: 'already_exists',
      journalPath: '/journals/test.json',
      subtitlePath: '/tv/s1e1.zh-Hans.srt',
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/tv/s1e1.zh-Hans.srt',
      source: 'preexisting',
      provider_ref: null,
      language: 'zh-Hans', // executor path unchanged (IMPORTANT-2)
    })
    expect(jobs.get(job.id)!.state).toBe('done')
  })

  it('M7 fallback: already_exists 无路径（残留分支兜底）→ 仍不伪造 subtitles 行', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    // 若某个 pipeline 分支仍返回 already_exists 但没给出可信路径，绝不能伪造一行 subtitles。
    const runEpisode = vi.fn(async () => ({
      decision: 'already_exists',
      journalPath: '/journals/test.json',
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
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
      subtitlePath: '/tv/s1e1.zh-Hans.ass',
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(lib.db.prepare('select * from subtitles where item_id=?').get('e1')).toMatchObject({
      path: '/tv/s1e1.zh-Hans.ass',
      source: 'adopted-local',
    })
  })

  it('runs.llm_calls/assrt_calls 落盘：取自 pipeline stub 返回的 stats', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({
      decision: 'download',
      journalPath: '/journals/test.json',
      subtitlePath: '/tv/s1e1.zh-Hans.srt',
      stats: { llmCalls: 3, apiCalls: 5 },
    }))

    await executeJob(job, mkDeps(runEpisode))

    const run = runs.getByJobId(job.id)[0]
    expect(run.llm_calls).toBe(3)
    expect(run.assrt_calls).toBe(5)
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

  it('runs.detail 守卫：不裸露 /media 路径、不出现纯英文句', async () => {
    // 覆盖各结局，收集 runs.detail 做整体断言
    // download（单集代表）
    mkEpisode('e1', 'sA', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 'sA', season: 1 }, now)
    const jA = jobs.claimNext(now)!
    await executeJob(jA, mkDeps(vi.fn(async () => ({
      decision: 'download', journalPath: '/j.json', subtitlePath: '/media/tv/sA/e1.zh-Hans.srt',
    }))))

    // no_safe_match
    mkEpisode('e2', 'sB', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 'sB', season: 1 }, now)
    const jB = jobs.claimNext(now)!
    await executeJob(jB, mkDeps(vi.fn(async () => ({ decision: 'no_safe_match', journalPath: '/j.json' }))))

    // error（错因带路径，应被清洗）
    mkEpisode('e3', 'sC', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 'sC', season: 1 }, now)
    const jC = jobs.claimNext(now)!
    await executeJob(jC, mkDeps(vi.fn(async () => ({
      decision: 'error', journalPath: '/j.json', reasons: ['refused write to /media/tv/sC/e1'],
    }))))

    const details = runs.getByJobId(jA.id).concat(runs.getByJobId(jB.id), runs.getByJobId(jC.id))
      .map(r => r.detail ?? '')
    for (const d of details) {
      expect(d).not.toMatch(/\/media/)          // 无裸路径前缀
      expect(d).toMatch(/[一-鿿]/)      // 至少含中文（非纯英文句）
    }
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

  it('I5b: 目录不可写预检必须先于 Jellyfin/TMDB 网络调用——不为注定失败的写路径烧配额', async () => {
    // 审计修正 (executor.ts:315)：原顺序是 getItem → getChineseTitle → tmdbTitles →
    // (root 校验) → isDirWritable。只读挂载/WebDAV 上，每次注定失败的尝试都已经把
    // Jellyfin getChineseTitle + TMDB 两次调用烧掉了才发现写不了。预检应提到这些调用之前。
    const readOnlyDir = join(mediaRoot, 'readonly')
    mkdirSync(readOnlyDir, { recursive: true })
    chmodSync(readOnlyDir, 0o555) // 只读——isDirWritable 的真实试写探针必然失败

    const jf = mkJf(join(readOnlyDir, 'test.mkv'))
    const runEpisode = makeRunEpisode(mkAssembled(jf), lib, { mediaRoots: [mediaRoot] })

    await expect(runEpisode('m1', vi.fn())).rejects.toThrow(/Media dir not writable/)

    // 核心断言：precheck 先跑，Jellyfin/TMDB 侧调用一次都不该发生。
    expect(jf.getChineseTitle).not.toHaveBeenCalled()
    expect(runPipelineMock).not.toHaveBeenCalled()

    chmodSync(readOnlyDir, 0o755) // 清理：避免只读目录残留干扰临时目录回收
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

    expect(result).toEqual({
      decision: 'download',
      journalPath: '/j.json',
      subtitlePath: '/subs/x.srt',
      confidence: null,
      minConfidence: 0.5,
      reasons: [],
      selected: null,
      stats: { llmCalls: 0, apiCalls: 0 },
    })
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

    // 从 makeDeps 捕获 perRun.onCovered 适配器，模拟季包命中一集（MS-P1: providerRef 透传）
    const perRun = vi.mocked(assembled.makeDeps).mock.calls[0][0]!
    const ep = { itemId: 'e9', seasonNumber: 1, episodeNumber: 9, episodeCode: 'S01E09', videoPath: '/v', videoFilename: 'v.mkv', needsChinese: true } satisfies SeasonEpisode
    await perRun.onCovered(ep, '/subs/e9.srt', 'assrt:900900')

    expect(onCovered).toHaveBeenCalledWith('e9', '/subs/e9.srt', 'assrt:900900')
    expect(jf.refreshItem).toHaveBeenCalledWith('e9') // I5d
  })

  it('解析到中文名时写回 movies 行（task 2 回写）', async () => {
    lib.upsertMovie({ id: 'm1', name: 'Test Movie', path: join(mediaRoot, 'movie', 'test.mkv'), subStatus: 'missing' })
    const jf = {
      getItem: vi.fn(async () => ({ Id: 'm1', Type: 'Movie', Name: 'Test Movie', Path: join(mediaRoot, 'movie', 'test.mkv') })),
      getChineseTitle: vi.fn(async () => '测试电影'),
      refreshItem: vi.fn(async () => {}),
    }
    runPipelineMock.mockResolvedValue({
      decision: 'no_safe_match', journalPath: '/j.json',
      stats: { durationMs: 1, llmCalls: 0, apiCalls: 0 },
    })
    const runEpisode = makeRunEpisode(mkAssembled(jf), lib, { mediaRoots: [mediaRoot] })
    await runEpisode('m1', vi.fn())
    expect(lib.getMovie('m1')!.chinese_title).toBe('测试电影')
  })

  it('解析到中文名时写回 series 行（episode → SeriesId）', async () => {
    lib.upsertSeries({ id: 's1', name: 'Test Series' })
    lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: join(mediaRoot, 'movie', 'test.mkv'), subStatus: 'missing' })
    const jf = {
      getItem: vi.fn(async () => ({ Id: 'e1', Type: 'Episode', SeriesId: 's1', Name: 'E1', Path: join(mediaRoot, 'movie', 'test.mkv') })),
      getChineseTitle: vi.fn(async () => '测试剧集'),
      refreshItem: vi.fn(async () => {}),
    }
    runPipelineMock.mockResolvedValue({
      decision: 'no_safe_match', journalPath: '/j.json',
      stats: { durationMs: 1, llmCalls: 0, apiCalls: 0 },
    })
    const runEpisode = makeRunEpisode(mkAssembled(jf), lib, { mediaRoots: [mediaRoot] })
    await runEpisode('e1', vi.fn())
    const row = lib.db.prepare('select chinese_title from series where id=?').get('s1') as any
    expect(row.chinese_title).toBe('测试剧集')
  })
})
