import { describe, it, expect, beforeEach, vi } from 'vitest'
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

  it('M8/onCovered: 季包/横扫覆盖里某一集其实本来就在磁盘上（alreadyExisted=true）→ source=preexisting，不与真正新抓的那集混同', async () => {
    // 单集 already_exists 决策早就映射到 source='preexisting'（见下面 M7/M8 用例）；这里补的是
    // 季横扫/季包升格路径——pipeline 的 onCovered 现在带 alreadyExisted 这个第 4 个参数
    // （findOnDiskNfc 装机前命中磁盘上的既有文件，本轮并没有真的写它），executeJob 的 onCovered
    // 必须据此选 source，而不是不管三七二十一都记 'scout-download'。
    mkEpisode('e1', 's1', 1, 1)
    mkEpisode('e2', 's1', 1, 2)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async (episodeId: string, onCovered: (id: string, path: string, providerRef?: string, alreadyExisted?: boolean) => void) => {
      expect(episodeId).toBe('e1')
      onCovered('e1', '/tv/s1e1.zh-Hans.srt', 'assrt:900900', true)  // 本来就在磁盘上
      onCovered('e2', '/tv/s1e2.zh-Hans.srt', 'assrt:900900', false) // 这次真的新写了
      return { decision: 'download', journalPath: '/journals/test.json' }
    })

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.db.prepare('select source from subtitles where item_id=?').get('e1')).toEqual({ source: 'preexisting' })
    expect(lib.db.prepare('select source from subtitles where item_id=?').get('e2')).toEqual({ source: 'scout-download' })
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

  it('no_safe_match is the only content-failure outcome — no ask_user/needs_review branch left', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async () => ({ decision: 'no_safe_match', reasons: ['没有安全匹配'] }))
    await executeJob(job, mkDeps(runEpisode))

    const ep1 = lib.getEpisode('e1')!
    expect(ep1.sub_status).toBe('unavailable') // no_safe_match 统一走 unavailable，没有第二条内容失败轨
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

  it('FIX-3: onCovered 侧写守卫——租约已不属于本次 invocation（真实 reap，lease_until 已变）时跳过写盘', async () => {
    // 区别于上面的 I4：forceState 只改 state，不动 lease_until，onCovered 的 ownership
    // 判据（lease_until 比对）测不出来。这里用真实 reap（reapAllActive）复现生产场景——
    // detached invocation 的 pipeline 仍在跑，写盘副作用（onCovered→markCovered）本该
    // 在"发现租约已不是自己的"那一刻就止血，而不是像过去那样只在最终 complete* 才拦。
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    jobs.reapAllActive(now) // 真实回收：state→wanted 且 lease_until→NULL，与 job.lease_until 分道扬镳

    const runEpisode = vi.fn(async (_: string, onCovered: (id: string, path: string) => void) => {
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json' }
    })

    await executeJob(job, mkDeps(runEpisode))

    // 写盘被跳过——不信任 detached invocation 的战果。
    expect(lib.getEpisode('e1')!.sub_status).toBe('missing')
    expect((lib.db.prepare('select count(*) c from subtitles where item_id=?').get('e1') as any).c).toBe(0)
    // 跳过本身被记了一笔（journal 记录，供事后复盘）。
    expect(logs.some(l => l.includes(`job ${job.id}`) && l.includes('跳过'))).toBe(true)
    // 既有的 complete* 守卫依旧照常触发（FIX-3 不取代它，只是更早止血）。
    expect(logs.some(l => l.includes(`job ${job.id} 结果被弃置`))).toBe(true)
  })

  it('FIX-4d: stale-discard warn 打印观测到的实际 state/lease_until，而不是断言唯一因（避免误诊）', async () => {
    // 生产实案：真实观测是 state=wanted、lease=NULL，却被日志一律断言成"租约已被回收
    // 重派"——把结论写死成唯一原因，掩盖了真实情况可能是别的（例如从未被正常 claim
    // 过、或别的路径把它拨回了 wanted）。改为如实打印观测到的 state/lease_until。
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    jobs.reapAllActive(now) // 真实观测现场：state→wanted，lease_until→NULL

    const runEpisode = vi.fn(async () => ({ decision: 'download', journalPath: '/j.json' }))
    await executeJob(job, mkDeps(runEpisode))

    const warnLine = logs.find(l => l.includes(`job ${job.id} 结果被弃置`))
    expect(warnLine).toBeDefined()
    expect(warnLine).toContain('state=wanted')
    expect(warnLine).toContain('lease_until=null')
    // 不再断言唯一因——旧文案硬编码"租约已被回收重派"，即便真实原因是别的也照样打印。
    expect(warnLine).not.toContain('租约已被回收重派')
  })

  it('FIX-3: 租约仍属于本次 invocation（fresh token）时 onCovered 照常写盘——不误伤正常路径', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!

    const runEpisode = vi.fn(async (_: string, onCovered: (id: string, path: string) => void) => {
      onCovered('e1', '/tv/s1e1.zh-Hans.srt')
      return { decision: 'download', journalPath: '/journals/test.json' }
    })

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
    expect(jobs.get(job.id)!.state).toBe('done')
  })

  it('FIX-3: 代表集自身命中（无季包 onCovered）时，租约失效也跳过直接 markCovered 写盘', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    jobs.reapAllActive(now)

    const runEpisode = vi.fn(async () => ({
      decision: 'download', journalPath: '/journals/test.json', subtitlePath: '/tv/s1e1.zh-Hans.srt',
    }))

    await executeJob(job, mkDeps(runEpisode))

    expect(lib.getEpisode('e1')!.sub_status).toBe('missing')
    expect((lib.db.prepare('select count(*) c from subtitles where item_id=?').get('e1') as any).c).toBe(0)
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

  it('FIX-4a: jobs.journal_ref 在跑 runEpisode 之前落盘——即便调用之后进程"断线"，也已有证据可倒查', async () => {
    mkEpisode('e1', 's1', 1, 1)
    jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
    const job = jobs.claimNext(now)!
    expect(job.journal_ref).toBeNull() // schema v1 列，此前从未写过

    let journalRefDuringRun: string | null = null
    let journalRefArg: string | undefined
    const runEpisode = vi.fn(async (_episodeId: string, _onCovered, journalRef?: string) => {
      // 调用发生时（pipeline 真正跑之前）jobs.journal_ref 应该已经落盘。
      journalRefDuringRun = jobs.get(job.id)!.journal_ref
      journalRefArg = journalRef
      return { decision: 'download', journalPath: '/j.json', subtitlePath: '/tv/s1e1.zh-Hans.srt' }
    })

    await executeJob(job, mkDeps(runEpisode))

    expect(journalRefDuringRun).toBeTruthy()
    expect(journalRefDuringRun).toContain('e1') // 引用含目标集 id，便于人工定位
    expect(journalRefArg).toBe(journalRefDuringRun) // 传给 runEpisode 的和落盘的是同一个引用
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

  // IMPORTANT-1（fix/lifecycle-forensics 审计——guard coverage hole）：detached invocation
  // 的 job 被孤儿回收（reapOrphaned）后又被一次新 invocation 重新 claim——旧代码只在
  // onCovered/代表集 markCovered 两处写盘拦了 ownsLease()，post-runEpisode 的最终分流
  // （completeNoMatch/completeError/completeDone）和 markUnavailable
  // 完全没守，会把新 invocation 仍在用的那一行错误转移（state/attempt/error_attempt/
  // lease_until 全部覆盖）。下面每个场景都覆盖一条分流分支，并在收尾处证明"活着"的
  // invocation #2 事后仍能正常收尾（其自身 lease_until 没被 stale invocation 的写盘捣毁，
  // 否则它自己的 ownsLease 也会跟着翻假，静默丢弃它自己的战果——审计 (c) 级联）。
  describe('IMPORTANT-1: detached invocation after reclaim — post-runEpisode 路由整段拦截', () => {
    it('no_safe_match 分支：不充 attempt、不写 markUnavailable、新 claim 的行不受影响', async () => {
      mkEpisode('e1', 's1', 1, 1)
      jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
      const job1 = jobs.claimNext(now)! // invocation #1 的冻结 token

      // invocation #1 的 continuation 还没跑到这里之前，job 被孤儿回收（reapOrphaned 空
      // 跟踪集视角，同 daemon FIX-1）——不是进程重启，只是"这次调用已经没人跟踪了"。
      jobs.reapOrphaned([], now)
      expect(jobs.get(job1.id)!.state).toBe('wanted')

      // 一个新 invocation 重新领走同一行——推进 now 保证 lease_until 数值不同，否则两次
      // claim 巧合撞出同一个数字，ownsLease() 的比对测不出区别。
      now += 1000
      const job2 = jobs.claimNext(now)!
      expect(job2.id).toBe(job1.id)
      expect(job2.lease_until).not.toBe(job1.lease_until)

      // invocation #1（stale）此刻才跑到 runEpisode 返回，结论是 no_safe_match。
      const staleRunEpisode = vi.fn(async () => ({ decision: 'no_safe_match', journalPath: '/stale.json' }))
      await executeJob(job1, mkDeps(staleRunEpisode))

      // 新 claim 的行完全未被动。
      const afterStale = jobs.get(job1.id)!
      expect(afterStale.state).toBe('searching')
      expect(afterStale.lease_until).toBe(job2.lease_until)
      expect(afterStale.attempt).toBe(0) // 没有被内容轨误充值
      expect(lib.getEpisode('e1')!.sub_status).toBe('missing') // 没有 markUnavailable 写脏

      // 诚实留痕：runs 表仍记一行，标注 stale-lease 弃置（观测信息不丢）。
      const runRows = runs.getByJobId(job1.id)
      expect(runRows.length).toBe(1)
      expect(runRows[0].detail).toContain('(stale-lease 弃置)')

      // invocation #2（活的那个）事后正常收尾——证明它自己的 lease_until 没被
      // invocation #1 的迟到路由捣毁。
      const liveRunEpisode = vi.fn(async (_id: string, onCovered: (id: string, path: string) => void) => {
        onCovered('e1', '/tv/s1e1.zh-Hans.srt')
        return { decision: 'download', journalPath: '/live.json' }
      })
      await executeJob(job2, mkDeps(liveRunEpisode))
      expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
      expect(jobs.get(job2.id)!.state).toBe('done')
    })

    it('decision=error（内容轨瞬时错误分支）：不充 error_attempt、不 NULL 新 claim 的 lease', async () => {
      mkEpisode('e1', 's1', 1, 1)
      jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
      const job1 = jobs.claimNext(now)!
      jobs.reapOrphaned([], now)
      now += 1000
      const job2 = jobs.claimNext(now)!

      const staleRunEpisode = vi.fn(async () => ({
        decision: 'error', journalPath: '/stale.json', reasons: ['LLM 502'],
      }))
      await executeJob(job1, mkDeps(staleRunEpisode))

      const afterStale = jobs.get(job1.id)!
      expect(afterStale.state).toBe('searching')
      expect(afterStale.lease_until).toBe(job2.lease_until) // 没被 completeError NULL 掉
      expect(afterStale.error_attempt).toBe(0)
      expect(afterStale.last_error).toBeNull()

      const liveRunEpisode = vi.fn(async (_id: string, onCovered: (id: string, path: string) => void) => {
        onCovered('e1', '/tv/s1e1.zh-Hans.srt')
        return { decision: 'download', journalPath: '/live.json' }
      })
      await executeJob(job2, mkDeps(liveRunEpisode))
      expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
      expect(jobs.get(job2.id)!.state).toBe('done')
    })

    it('runEpisode 抛异常（catch 块，同一个 completeErrorLogged）：同样不充 error_attempt、不 NULL 新 claim 的 lease', async () => {
      mkEpisode('e1', 's1', 1, 1)
      jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
      const job1 = jobs.claimNext(now)!
      jobs.reapOrphaned([], now)
      now += 1000
      const job2 = jobs.claimNext(now)!

      const staleRunEpisode = vi.fn(async () => { throw new Error('ASSRT API timeout') })
      await executeJob(job1, mkDeps(staleRunEpisode))

      const afterStale = jobs.get(job1.id)!
      expect(afterStale.state).toBe('searching')
      expect(afterStale.lease_until).toBe(job2.lease_until)
      expect(afterStale.error_attempt).toBe(0)
      expect(afterStale.last_error).toBeNull() // jobs.completeError 从未被真正调用过

      const runRows = runs.getByJobId(job1.id)
      expect(runRows.length).toBe(1)
      expect(runRows[0].detail).toContain('(stale-lease 弃置)')

      const liveRunEpisode = vi.fn(async (_id: string, onCovered: (id: string, path: string) => void) => {
        onCovered('e1', '/tv/s1e1.zh-Hans.srt')
        return { decision: 'download', journalPath: '/live.json' }
      })
      await executeJob(job2, mkDeps(liveRunEpisode))
      expect(lib.getEpisode('e1')!.sub_status).toBe('covered')
      expect(jobs.get(job2.id)!.state).toBe('done')
    })

    it('全覆盖 completeDone 分支：invocation #2 抢先覆盖但尚未自己收尾时，stale invocation 迟到的路由不能提前把它拍成 done', async () => {
      // 这一支必须真正交错：invocation #1 的 runEpisode 挂起不返回（detached 但"活着"），
      // 期间 invocation #2 领到同一行、自己的 onCovered 已经落盘覆盖 e1，但还没走到它
      // 自己的 complete* 收尾（仍是 searching）——这正是旧代码的窟窿：invocation #1 一旦
      // 醒来发现 remainingTargets() 为空，会误判"我搞定的"，把仍在 active 态的这一行
      // 提前拍成 done。
      mkEpisode('e1', 's1', 1, 1)
      jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now)
      const job1 = jobs.claimNext(now)!

      type RunResult = { decision: string; journalPath?: string; subtitlePath?: string }
      let resolveStale: (r: RunResult) => void = () => {}
      const staleRunEpisode = vi.fn(
        () => new Promise<RunResult>((resolve) => { resolveStale = resolve })
      )
      const stalePromise = executeJob(job1, mkDeps(staleRunEpisode))

      // invocation #1 仍挂起未返回（detached 但"活着"）时，job 被孤儿回收+重新 claim。
      jobs.reapOrphaned([], now)
      now += 1000
      const job2 = jobs.claimNext(now)!
      expect(job2.lease_until).not.toBe(job1.lease_until)

      let resolveLive: (r: RunResult) => void = () => {}
      const liveRunEpisode = vi.fn(
        (_id: string, onCovered: (id: string, path: string) => void) => {
          onCovered('e1', '/tv/s1e1.zh-Hans.srt') // 同步落盘覆盖，但自己还没收尾
          return new Promise<RunResult>((resolve) => { resolveLive = resolve })
        }
      )
      const livePromise = executeJob(job2, mkDeps(liveRunEpisode))
      await Promise.resolve() // 让 liveRunEpisode 的同步部分（onCovered）跑完

      expect(lib.getEpisode('e1')!.sub_status).toBe('covered') // invocation #2 已覆盖
      expect(jobs.get(job2.id)!.state).toBe('searching') // 但尚未收尾，仍是 active 态

      // invocation #1（stale）现在才醒：它自己的 runEpisode 返回 download（它对季包已经
      // 被 invocation #2 覆盖这件事一无所知）。
      resolveStale({ decision: 'download', journalPath: '/stale.json' })
      await stalePromise

      // invocation #2 的行完全未被 stale invocation 的迟到路由提前收尾。
      const afterStale = jobs.get(job2.id)!
      expect(afterStale.state).toBe('searching')
      expect(afterStale.lease_until).toBe(job2.lease_until)

      // invocation #2 自己正常收尾。
      resolveLive({ decision: 'download', journalPath: '/live.json' })
      await livePromise
      expect(jobs.get(job2.id)!.state).toBe('done')
    })
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

  it('I5e: runPipeline 传 bypassNegativeCache', async () => {
    // I5a（ctx 应用 AUTO_DOWNLOAD_MIN_CONFIDENCE 环境变量置信度覆盖）已随
    // applyConfidenceOverride() 一并删除（commit 6cdcdcd：判定链两态化后置信度阈值整条
    // 拔除，MediaContextSchema.preferences 不再有 auto_download_min_confidence 字段）——
    // 这里只保留仍然成立的 I5e 部分（bypassNegativeCache 透传）。
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
      reasons: [],
      selected: null,
      stats: { llmCalls: 0, apiCalls: 0 },
    })
    const [, ctx, outDir, , opts] = runPipelineMock.mock.calls[0]
    expect(ctx.preferences).not.toHaveProperty('auto_download_min_confidence')
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

    // 从 makeDeps 捕获 perRun.onCovered 适配器，模拟季包命中一集（MS-P1: providerRef 透传；
    // 本条 alreadyExisted=false，即真的新写了这一集——下一条用例覆盖 alreadyExisted=true）
    const perRun = vi.mocked(assembled.makeDeps).mock.calls[0][0]!
    const ep = { itemId: 'e9', seasonNumber: 1, episodeNumber: 9, episodeCode: 'S01E09', videoPath: '/v', videoFilename: 'v.mkv', needsChinese: true } satisfies SeasonEpisode
    await perRun.onCovered(ep, '/subs/e9.srt', 'assrt:900900', false)

    expect(onCovered).toHaveBeenCalledWith('e9', '/subs/e9.srt', 'assrt:900900', false)
    expect(jf.refreshItem).toHaveBeenCalledWith('e9') // I5d
  })

  it('I5d/M8: onCovered 适配层透传 alreadyExisted=true（季横扫/季包命中的这一集其实本来就在磁盘上）', async () => {
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

    const perRun = vi.mocked(assembled.makeDeps).mock.calls[0][0]!
    const ep = { itemId: 'e9', seasonNumber: 1, episodeNumber: 9, episodeCode: 'S01E09', videoPath: '/v', videoFilename: 'v.mkv', needsChinese: true } satisfies SeasonEpisode
    await perRun.onCovered(ep, '/subs/e9.srt', 'assrt:900900', true)

    expect(onCovered).toHaveBeenCalledWith('e9', '/subs/e9.srt', 'assrt:900900', true)
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
