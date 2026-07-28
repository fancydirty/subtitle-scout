import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo, PARK_REASON } from '../v2/libraryRepo.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import { RunsRepo } from '../v2/runsRepo.js'
import { seriesId, episodeId } from '../v2/ownIds.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'
import type { FindSubtitleTask, FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'
import {
  buildUnidentifiedTargets,
  makeUnidentifiedFindSubtitleWorker,
  runUnidentifiedFindSubtitleWorkerTask,
} from './unidentifiedFindSubtitle.js'

// Task 12（agent-first 识别主链路的 CLI 接线）：payload.scope==='unidentified' 的
// find_subtitle worker_task——从 parked_paths 读 raw data 建 itemId=null 的 targets，
// worker 挂 identityDeps（write_identified_media），agent 自己识别写库后继续找字幕。

const NOW = 1_800_000_000_000

let root: string
let db: ScoutDb
let lib: LibraryRepo
let jobs: JobsRepo
let runs: RunsRepo

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scout-unidentified-'))
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
  jobs = new JobsRepo(db)
  runs = new RunsRepo(db)
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

/** 终局机械裁决（excluded-extra/duplicate-content）不该上车；其余 park 理由全部 eligible。 */
describe('buildUnidentifiedTargets (parked_paths → raw-evidence targets)', () => {
  it('reads eligible parked paths, builds targets with raw evidence and structure hints', () => {
    const showDir = join(root, 'media', '后室', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, '2026.2160p.iT.WEB-DL.H.265.mkv')
    const moviePath = join(root, 'media', 'movies', 'Hero.2002.mkv')
    mkdirSync(dirname(moviePath), { recursive: true })
    writeFileSync(epPath, 'video')
    writeFileSync(moviePath, 'video')

    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, {
      mtimeMs: 100, size: 10, durationSec: 2530, embeddedLangs: ['eng'],
    })
    lib.upsertParkedPath(moviePath, 'no-match', NOW, { mtimeMs: 100, size: 10 })
    // 终局机械裁决——滤掉，不上车。
    lib.upsertParkedPath(join(root, 'media', 'extras', 'behind.mkv'), 'excluded-extra', NOW, { mtimeMs: 1, size: 1 })
    lib.upsertParkedPath(join(root, 'media', 'dup', 'copy.mkv'), 'duplicate-content', NOW, { mtimeMs: 1, size: 1 })

    const targets = buildUnidentifiedTargets(lib)

    expect(targets).toHaveLength(2)
    const ep = targets.find((t) => t.videoPath === epPath)!
    const movie = targets.find((t) => t.videoPath === moviePath)!

    // 未识别目标：itemId/imdbId 恒 null（身份等 agent 识别，禁止编造）
    expect(ep.itemId).toBeNull()
    expect(ep.imdbId).toBeNull()
    // raw evidence：duration/embeddedLangs 来自 parked_paths 列，dirName 是目录段
    expect(ep.durationSec).toBe(2530)
    expect(ep.runtimeMinutes).toBe(42) // Math.round(2530/60)
    expect(ep.embeddedLangs).toEqual(['eng'])
    expect(ep.dirName).toBe(showDir)
    expect(ep.videoFilename).toBe('2026.2160p.iT.WEB-DL.H.265.mkv')
    // 结构提示来自 identifyFromPath：Season 01 目录给出 season 提示；文件名是纯技术
    // token（无集信号），episode/absoluteEpisode 为 null。
    expect(ep.season).toBe(1)
    expect(ep.episode).toBeNull()
    expect(ep.absoluteEpisode).toBeNull()

    // 未探测的文件：duration/embeddedLangs 全 null，不虚报
    expect(movie.itemId).toBeNull()
    expect(movie.durationSec).toBeNull()
    expect(movie.runtimeMinutes).toBeNull()
    expect(movie.embeddedLangs).toBeNull()
    expect(movie.season).toBeNull()
    expect(movie.episode).toBeNull()
  })

  it('🔴 insufficient-evidence 的行不上 agent 批次（LLM 路径的经济门）', () => {
    const okPath = join(root, 'media', 'Show', 'ep1.mkv')
    const deadPath = join(root, 'media', 'random', '1.mp4')
    lib.upsertParkedPath(okPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    lib.upsertParkedPath(deadPath, PARK_REASON.insufficientEvidence, NOW, { mtimeMs: 100, size: 10 })

    const targets = buildUnidentifiedTargets(lib)

    expect(targets.map((t) => t.videoPath)).toEqual([okPath])
  })

  it('identification-failed 的行照常上批次（可自愈，继续尝试）', () => {
    const failedPath = join(root, 'media', 'Show', 'ep2.mkv')
    lib.upsertParkedPath(failedPath, PARK_REASON.identificationFailed, NOW, { mtimeMs: 100, size: 10 })

    const targets = buildUnidentifiedTargets(lib)

    expect(targets.map((t) => t.videoPath)).toEqual([failedPath])
  })

  // 管线拆分（2026-07-28 事故）：446 文件一批全上车 → agent 500 步烧尽在识别上。批次上限
  // 默认 60（识别 3-5 步/文件，60×5=300 < 500 stepCap 留余量）；取挂得最久的行先上
  // （listParkedPaths 按 first_seen DESC，挂最久=排最前），余量留 park，orchestrator 下轮再派。
  describe('批次上限（limit，默认 60，最久 parked 先上）', () => {
    it('100 行 parked → 只取 60 行挂得最久的；其余留 park 不动', () => {
      // first_seen 越早=挂得越久。path 编号 0..99，first_seen 递增——0 号挂最久。
      for (let i = 0; i < 100; i++) {
        lib.upsertParkedPath(
          join(root, 'media', 'Show', `ep${String(i).padStart(3, '0')}.mkv`),
          PARK_REASON.awaitingAgent, NOW + i, { mtimeMs: 100, size: 10 },
        )
      }

      const targets = buildUnidentifiedTargets(lib)

      expect(targets).toHaveLength(60)
      // 挂得最久的 60 行 = first_seen 最小的 0..59 号
      const nums = targets.map((t) => Number(/ep(\d+)\.mkv$/.exec(t.videoPath)![1])).sort((a, b) => a - b)
      expect(nums).toEqual(Array.from({ length: 60 }, (_, i) => i))
      // 其余 40 行仍在 parked_paths（buildUnidentifiedTargets 是纯读，本就不动行——这里锁语义）
      expect(lib.listParkedPaths()).toHaveLength(100)
    })

    it('limit 参数可覆盖默认值', () => {
      for (let i = 0; i < 5; i++) {
        lib.upsertParkedPath(
          join(root, 'media', 'Show', `ep${i}.mkv`),
          PARK_REASON.awaitingAgent, NOW + i, { mtimeMs: 100, size: 10 },
        )
      }
      expect(buildUnidentifiedTargets(lib, 2)).toHaveLength(2)
      expect(buildUnidentifiedTargets(lib, 2).map((t) => t.videoPath)).toEqual([
        join(root, 'media', 'Show', 'ep0.mkv'),
        join(root, 'media', 'Show', 'ep1.mkv'),
      ])
    })

    it('cap 在 eligibility 过滤之后生效（不许被 ineligible 行挤占名额）', () => {
      // 3 行 ineligible（挂得最久）+ 3 行 eligible——limit 2 必须取到 2 行 eligible。
      for (let i = 0; i < 3; i++) {
        lib.upsertParkedPath(join(root, 'media', 'x', `dead${i}.mkv`), 'excluded-extra', NOW + i, { mtimeMs: 1, size: 1 })
      }
      for (let i = 0; i < 3; i++) {
        lib.upsertParkedPath(join(root, 'media', 'Show', `ok${i}.mkv`), PARK_REASON.awaitingAgent, NOW + 10 + i, { mtimeMs: 1, size: 1 })
      }
      const targets = buildUnidentifiedTargets(lib, 2)
      expect(targets.map((t) => t.videoPath)).toEqual([
        join(root, 'media', 'Show', 'ok0.mkv'),
        join(root, 'media', 'Show', 'ok1.mkv'),
      ])
    })
  })
})

describe('runUnidentifiedFindSubtitleWorkerTask', () => {
  function claimUnidentifiedJob() {
    jobs.upsertWorkerTask(
      { seriesId: null, season: null, movieId: null },
      { taskType: 'find_subtitle', scope: 'unidentified', reason: 'parked backlog' },
      null, NOW,
    )
    return jobs.claimNext(NOW)!
  }

  it('passes parked-derived raw-evidence targets to the worker; agent-identified rows get harvest-accounted', async () => {
    const mediaRoot = join(root, 'media')
    const seasonDir = join(mediaRoot, '后室', 'Season 01')
    mkdirSync(seasonDir, { recursive: true })
    const epPath = join(seasonDir, '2026.2160p.iT.WEB-DL.H.265.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, {
      mtimeMs: 100, size: 10, durationSec: 2530, embeddedLangs: ['eng'],
    })
    const job = claimUnidentifiedJob()

    const ownSeriesId = seriesId('271828')
    const ownEpisodeId = episodeId('271828', 1, 1)
    let seenTask: FindSubtitleTask | null = null
    const runTask = vi.fn(async (task: FindSubtitleTask): Promise<FindSubtitleBatchReport> => {
      seenTask = task
      // 模拟真实 agent 行为：write_identified_media 落地（建库行 + 清 parked 户口），
      // 然后装上字幕后 finalize。
      lib.upsertSeries({ id: ownSeriesId, name: 'Backrooms' })
      lib.upsertEpisode({
        id: ownEpisodeId, seriesId: ownSeriesId, season: 1, episode: 1,
        name: 'Backrooms', path: epPath, subStatus: 'missing',
      })
      lib.clearParkedPath(epPath)
      return {
        installed: [{
          itemId: ownEpisodeId, installedPath: join(seasonDir, '2026.zh-Hans.srt'),
          installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: 'assrt:1',
          reason: 'season pack cue alignment',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
        identity: {
          outcome: 'identified', tmdbId: '271828', isTv: true, season: 1, episode: 1,
          nameEvidence: 'dir name 后室 matches Backrooms (2022)',
          structureEvidence: 'Season 01 layout fits TMDB season table',
        },
      }
    })

    const report = await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    expect(runTask).toHaveBeenCalledTimes(1)
    // worker 收到的 task：targets 从 parked_paths 建成（itemId=null + raw evidence）
    expect(seenTask!.targets).toHaveLength(1)
    expect(seenTask!.targets[0]).toMatchObject({
      itemId: null, videoPath: epPath, imdbId: null,
      season: 1, episode: null, durationSec: 2530, runtimeMinutes: 42,
      embeddedLangs: ['eng'], dirName: seasonDir,
    })
    // INNER 沙盒根 = parked 目标目录的公共祖先；stagingRoot = 配置根（gcOrphans 可及）
    expect(seenTask!.mediaRoot).toBe(seasonDir)
    expect(seenTask!.stagingRoot).toBe(mediaRoot)
    // 无身份可猜——task 级身份字段全空，不虚构 title
    expect(seenTask!.title).toBe('')
    expect(seenTask!.localCandidates).toEqual([])
    // 收割入账：agent 识别建出的库行被 markCovered
    expect(lib.getEpisode(ownEpisodeId)!.sub_status).toBe('covered')
    // 队列收官：installed 非空 → done；runs 时间线有 installed + identity 两行
    expect(jobs.get(job.id)!.state).toBe('done')
    expect(report).not.toBeNull()
    expect(runs.getByJobId(job.id).map((r) => r.decision)).toEqual(
      expect.arrayContaining(['installed', 'identity']),
    )
  })

  it('no eligible parked paths → completeDone without ever invoking the worker', async () => {
    jobs.upsertWorkerTask(
      { seriesId: null, season: null, movieId: null },
      { taskType: 'find_subtitle', scope: 'unidentified', reason: 'parked backlog' },
      null, NOW,
    )
    const job = jobs.claimNext(NOW)!
    lib.upsertParkedPath(join(root, 'media', 'extras', 'behind.mkv'), 'excluded-extra', NOW, { mtimeMs: 1, size: 1 })

    const runTask = vi.fn()
    const report = await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [join(root, 'media')], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    expect(runTask).not.toHaveBeenCalled()
    expect(report).toBeNull()
    expect(jobs.get(job.id)!.state).toBe('done')
  })

  it('identity outcome "unidentified" → installs dropped (runner gate), empty report → completeError', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()

    // 报告里的 itemId 必须是"本批 parked 目标路径上刚建出的行"才能过幻觉防线——这样
    // 拦截它的就只剩 identity 闸本身（schema 文档明文："unidentified 要求 installed 为空，
    // 后者由 runner 层把关"）。
    const ownSeriesId = seriesId('777')
    const ownEpisodeId = episodeId('777', 1, 1)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      lib.upsertSeries({ id: ownSeriesId, name: 'X' })
      lib.upsertEpisode({
        id: ownEpisodeId, seriesId: ownSeriesId, season: 1, episode: 1,
        name: 'X', path: epPath, subStatus: 'missing',
      })
      return {
        // 自相矛盾的报告：identity 说没识别出来，installed 却非空。
        installed: [{
          itemId: ownEpisodeId, installedPath: join(showDir, 'ep1.zh.srt'),
          installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
          reason: 'contradictory report',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
        identity: { outcome: 'unidentified', reason: 'no TMDB candidate survived the two-evidence bar', kind: 'identification-failed' },
      }
    })

    const report = await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    expect(report).not.toBeNull()
    // installed 被 identity 闸丢弃 → 行不得被 markCovered；空报告 → completeError 退避
    expect(lib.getEpisode(ownEpisodeId)!.sub_status).toBe('missing')
    expect(jobs.get(job.id)!.state).toBe('failed')
    expect(jobs.get(job.id)!.last_error).toContain('empty batch report')
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('DROPPING 1 installed item(s)'))
    errSpy.mockRestore()
  })

  it('alien itemId (not a row created from this task’s parked targets) is dropped, never harvest-accounted', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, { mtimeMs: 100, size: 10 })
    // 库里早有一行别的条目——agent 若把它的 id 报上来，绝不能被这笔 task 改状态。
    const otherSeries = seriesId('42')
    const otherEpisode = episodeId('42', 1, 1)
    lib.upsertSeries({ id: otherSeries, name: 'Other Show' })
    lib.upsertEpisode({
      id: otherEpisode, seriesId: otherSeries, season: 1, episode: 1,
      name: 'Other', path: join(mediaRoot, 'OtherShow', 'e1.mkv'), subStatus: 'missing',
    })
    const job = claimUnidentifiedJob()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [{
        itemId: otherEpisode, installedPath: join(showDir, 'ep1.zh.srt'),
        installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
        reason: 'hallucinated id of an unrelated row',
      }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }))

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    expect(lib.getEpisode(otherEpisode)!.sub_status).toBe('missing')
    expect(jobs.get(job.id)!.state).toBe('failed') // 过滤后空报告 → completeError
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining(`dropping itemId ${otherEpisode}`))
    errSpy.mockRestore()
  })

  // Task 3（park 原因二分）：unidentified 收割时把 agent 报的 kind 回写 parked_paths，
  // 让负缓存的指纹门（libraryRepo.shouldRetryParkedPath）分得开"确定不自愈"和"可能自愈"。
  it('unidentified + kind=insufficient-evidence → 回写 park 原因', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'random')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, '1.mp4')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: '路径无片名信息', kind: 'insufficient-evidence' },
    }))

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    const row = db.prepare(`SELECT park_reason FROM parked_paths WHERE path = ?`).get(epPath) as
      | { park_reason: string } | undefined
    expect(row?.park_reason).toBe('insufficient-evidence')
  })

  it('回写不重置退避阶梯（updateParkReason 而非 upsertParkedPath）', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    // 同 reason 同指纹 upsert 两次 → retry_count=1（4h 档）
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW + 1, { mtimeMs: 100, size: 10 })
    const before = db.prepare(`SELECT retry_count FROM parked_paths WHERE path = ?`).get(epPath) as
      { retry_count: number }
    expect(before.retry_count).toBe(1)
    const job = claimUnidentifiedJob()

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: 'TMDB 暂无此条目', kind: 'identification-failed' },
    }))

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    const after = db.prepare(`SELECT park_reason, retry_count FROM parked_paths WHERE path = ?`).get(epPath) as
      { park_reason: string; retry_count: number }
    expect(after.park_reason).toBe('identification-failed')
    // upsertParkedPath 在 reason 变化时会把 retry_count 归零重置 1h 档——回写必须用
    // updateParkReason，阶梯不动。
    expect(after.retry_count).toBeGreaterThanOrEqual(1)
  })

  it('identified 成功时不回写（clearParkedPath 已在写库事务里发生）', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()

    const ownSeriesId = seriesId('271828')
    const ownEpisodeId = episodeId('271828', 1, 1)
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      // 模拟 write_identified_media：建库行 + 清 parked 户口。
      lib.upsertSeries({ id: ownSeriesId, name: 'Backrooms' })
      lib.upsertEpisode({
        id: ownEpisodeId, seriesId: ownSeriesId, season: 1, episode: 1,
        name: 'Backrooms', path: epPath, subStatus: 'missing',
      })
      lib.clearParkedPath(epPath)
      return {
        installed: [{
          itemId: ownEpisodeId, installedPath: join(showDir, 'ep1.zh.srt'),
          installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
          reason: 'ok',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
        identity: {
          outcome: 'identified', tmdbId: '271828', isTv: true, season: 1, episode: 1,
          nameEvidence: 'name matches', structureEvidence: 'season table fits',
        },
      }
    })

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    // 已被 write_identified_media 清出 parked——收割回写不得复活这一行。
    const row = db.prepare(`SELECT park_reason FROM parked_paths WHERE path = ?`).get(epPath)
    expect(row).toBeUndefined()
  })

  // 六轮血案第三例（job 34，2026-07-28）：混合批里 agent 对 installed 项报 itemId:null——
  // 工具层自己就容忍 null itemId（resolveTarget）、prompt 的 target 行明写 itemId: null，
  // finalize 却拒收系统亲手递给模型的值。schema 放行后，runner 用 installedPath 反解归属：
  // dirname(installedPath) === dirname(target.videoPath) 且字幕名以视频 stem 为前缀
  // （install_subtitle 的命名约定 `<video-stem>.<langTag><ext>`）→ 查该 videoPath 的库行。
  it('🔴 installed 项 itemId:null → 从 installedPath 反解出库行入账（job34 形态）', async () => {
    const mediaRoot = join(root, 'media')
    const seasonDir = join(mediaRoot, '后室', 'Season 01')
    mkdirSync(seasonDir, { recursive: true })
    const epPath = join(seasonDir, '2026.2160p.iT.WEB-DL.H.265.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()

    const ownSeriesId = seriesId('271828')
    const ownEpisodeId = episodeId('271828', 1, 1)
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      // 模拟真实 agent：write_identified_media 建库行 + 清 parked，install 成功，
      // 但 finalize 时 installed 项漏报 itemId（弱模型实测形态）。
      lib.upsertSeries({ id: ownSeriesId, name: 'Backrooms' })
      lib.upsertEpisode({
        id: ownEpisodeId, seriesId: ownSeriesId, season: 1, episode: 1,
        name: 'Backrooms', path: epPath, subStatus: 'missing',
      })
      lib.clearParkedPath(epPath)
      return {
        installed: [{
          itemId: null,
          installedPath: join(seasonDir, '2026.2160p.iT.WEB-DL.H.265.zh-Hans.srt'),
          installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: 'assrt:1',
          reason: 'season pack cue alignment',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
        identity: {
          outcome: 'identified', tmdbId: '271828', isTv: true, season: 1, episode: 1,
          nameEvidence: 'name matches', structureEvidence: 'season table fits',
        },
      }
    })

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    // 反解成功：installedPath 落在 epPath 的目录、字幕名以视频 stem 为前缀 → 归属该库行。
    expect(lib.getEpisode(ownEpisodeId)!.sub_status).toBe('covered')
    expect(jobs.get(job.id)!.state).toBe('done')
  })

  it('installed 项 itemId:null 且反解失败（无库行）→ 丢弃告警，不炸不误账', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      // 没有任何库行被建出来——null itemId 无从反解。
      installed: [{
        itemId: null, installedPath: join(showDir, 'ep1.zh-Hans.srt'),
        installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
        reason: 'installed but no row exists',
      }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }))

    const report = await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    expect(report).not.toBeNull()
    expect(jobs.get(job.id)!.state).toBe('failed') // 丢弃后空报告 → completeError
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('itemId:null'))
    errSpy.mockRestore()
  })

  it('unresolved 桶（no_safe_match）itemId:null 无 installedPath 可反解 → 丢弃告警，不炸', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, 'awaiting-agent-identification', NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [],
      no_safe_match: [{ itemId: null, reason: 'nothing matched' }],
      retry_later: [], hardsub_assumed: [], identity: null,
    }))

    const report = await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    expect(report).not.toBeNull()
    expect(jobs.get(job.id)!.state).toBe('failed') // 丢弃后空报告 → completeError（不 crash）
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('makeUnidentifiedFindSubtitleWorker (identify-only wiring)', () => {
  it('assembles an identify-only worker: identification tools mounted, subtitle tools absent', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, '后室', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, '2026.2160p.iT.WEB-DL.H.265.mkv')
    writeFileSync(epPath, 'video')

    let capturedTools: string[] = []
    let capturedPromptText = ''
    let capturedSystemText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        capturedTools = (options.tools ?? []).map((t: any) => t.name)
        const userMessage = options.prompt.find((m) => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        const systemMessage = options.prompt.find((m) => m.role === 'system')
        capturedSystemText = typeof systemMessage?.content === 'string'
          ? systemMessage.content
          : ((systemMessage?.content as unknown as any[]) ?? []).map((p: any) => p.text ?? '').join('')
        return {
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: undefined, reasoning: undefined },
          },
          content: [{
            type: 'tool-call' as const, toolCallId: 'f1', toolName: 'finalize',
            input: JSON.stringify({
              installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
              identity: { outcome: 'unidentified', reason: 'could not verify any candidate' },
            }),
          }],
          warnings: [],
        }
      },
    })
    const fakeTmdb = {
      search: vi.fn(async () => []),
      getDetails: vi.fn(async () => null),
      getSeasonTable: vi.fn(async () => null),
      getChineseTitles: vi.fn(async () => []),
      getExternalIds: vi.fn(async () => ({ imdbId: null })),
      getOriginLanguage: vi.fn(async () => null),
    }

    const runTask = makeUnidentifiedFindSubtitleWorker({
      model, cacheRoot: join(root, 'cache'), stepCap: 10,
      tmdb: fakeTmdb as unknown as TmdbClient, lib,
    })
    const task: FindSubtitleTask = {
      jobId: 'job-u1', mediaRoot: showDir, stagingRoot: mediaRoot,
      title: '', originalTitle: null, year: null, alternativeTitles: [], overview: null,
      runtimeMinutes: null, providerIds: {}, targetLanguage: 'zh', hardsubMode: 'off',
      localCandidates: [],
      targets: [{
        itemId: null, videoPath: epPath, videoFilename: '2026.2160p.iT.WEB-DL.H.265.mkv',
        season: 1, episode: null, absoluteEpisode: null, imdbId: null, embeddedTmdbId: null,
        runtimeMinutes: 42, dirName: showDir, durationSec: 2530, embeddedLangs: ['eng'],
      }],
    }

    await runTask(task)

    // 管线拆分（2026-07-28 事故裁决）：识别专用 worker——识别工具全挂，字幕工具零挂载
    // （零误触发纪律：模型连工具名都看不到）。
    expect([...capturedTools].sort()).toEqual(
      ['finalize', 'get_tmdb_details', 'read_doc', 'search_tmdb', 'write_identified_media'].sort(),
    )
    // skill 索引只含识别文档；找字幕 playbook 不出现
    expect(capturedSystemText).toContain('identify-media')
    expect(capturedSystemText).not.toContain('find-subtitle-judgment')
    // prompt 是 unidentified 形态：raw evidence 保留（embedded langs 证据行必须在），
    // 不出现任何字幕工具名。
    expect(capturedPromptText).toContain('This task carries NO identity')
    expect(capturedPromptText).not.toContain('guessed title')
    expect(capturedPromptText).toContain(
      '- itemId: null (unidentified — identify first, then write_identified_media) | structure hint: season 1 | duration: 2530s | embedded langs: eng | file: 2026.2160p.iT.WEB-DL.H.265.mkv',
    )
    for (const name of ['search_source', 'list_candidates', 'get_candidate', 'download_candidate', 'install_subtitle', 'check_episode_code_safety']) {
      expect(capturedPromptText).not.toContain(name)
      expect(capturedSystemText).not.toContain(name)
    }
  })
})
