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
import { traceBus } from '../core/traceBus.js'
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
    it('同一作品目录 100 行 → 整单元上车（§3.3.2：单元自身超限不切半）', () => {
      // first_seen 越早=挂得越久。path 编号 0..99，first_seen 递增——0 号挂最久。
      for (let i = 0; i < 100; i++) {
        lib.upsertParkedPath(
          join(root, 'media', 'Show', `ep${String(i).padStart(3, '0')}.mkv`),
          PARK_REASON.awaitingAgent, NOW + i, { mtimeMs: 100, size: 10 },
        )
      }

      // 作品单元语义（spec §3.3.2）：这 100 个文件同属一个作品目录，切半会把兄弟证据切散
      // （正是本轮要修的问题），所以整单元上车、接受超 MAX_TARGETS_PER_JOB。
      const targets = buildUnidentifiedTargets(lib, { roots: [join(root, 'media')], now: NOW + 999_999 })
      expect(targets).toHaveLength(100)
      // buildUnidentifiedTargets 是纯读，不动 parked 行
      expect(lib.listParkedPaths()).toHaveLength(100)
    })

    it('unitLimit 截断单元数；maxTargets 截断文件数（回滚语义 unitLimit=0）', () => {
      // 五部不同的剧各一集 → 五个单元
      for (let i = 0; i < 5; i++) {
        lib.upsertParkedPath(
          join(root, 'media', `Show${i}`, `ep${i}.mkv`),
          PARK_REASON.awaitingAgent, NOW + i, { mtimeMs: 100, size: 10 },
        )
      }
      const opts = { roots: [join(root, 'media')], now: NOW + 999_999 }
      expect(buildUnidentifiedTargets(lib, { ...opts, unitLimit: 2 })).toHaveLength(2)
      // unitLimit=0 是回滚开关：退回旧扁平语义，按 maxTargets 掐头
      expect(buildUnidentifiedTargets(lib, { ...opts, unitLimit: 0, maxTargets: 2 })).toHaveLength(2)
    })

    it('cap 在 eligibility 过滤之后生效（不许被 ineligible 行挤占名额）', () => {
      // 3 行 ineligible（挂得最久）+ 3 行 eligible——limit 2 必须取到 2 行 eligible。
      for (let i = 0; i < 3; i++) {
        lib.upsertParkedPath(join(root, 'media', 'x', `dead${i}.mkv`), 'excluded-extra', NOW + i, { mtimeMs: 1, size: 1 })
      }
      for (let i = 0; i < 3; i++) {
        lib.upsertParkedPath(join(root, 'media', 'Show', `ok${i}.mkv`), PARK_REASON.awaitingAgent, NOW + 10 + i, { mtimeMs: 1, size: 1 })
      }
      const targets = buildUnidentifiedTargets(lib, { unitLimit: 0, maxTargets: 2 })
      // 选集正确即可（顺序不是本测试的对象——这几行 last_attempt 相同）：两行都必须是 eligible 的
      expect(targets).toHaveLength(2)
      expect(targets.every((t) => /ok\d\.mkv$/.test(t.videoPath))).toBe(true)
    })
  })
})


  // ---- 作品单元分组（spec §3.2/§3.3，B2c）----
  describe('作品单元分组', () => {
    const parkFile = (rel: string, firstSeen: number) => {
      const p = join(root, 'media', rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'v')
      lib.upsertParkedPath(p, PARK_REASON.awaitingAgent, firstSeen, { mtimeMs: 100, size: 10 })
      return p
    }
    const roots = () => [join(root, 'media')]

    it('🔴 同一部剧的集数必在同一批（本轮核心收益：sibling 证据不被切散）', () => {
      // 三部剧各 3 集，交错 first_seen —— 旧的扁平取 N 会把它们切散。
      for (let i = 0; i < 3; i++) {
        parkFile(`TV/AlphaShow/S01E0${i}.mkv`, NOW + i * 10)
        parkFile(`TV/BetaShow/S01E0${i}.mkv`, NOW + i * 10 + 1)
        parkFile(`TV/GammaShow/S01E0${i}.mkv`, NOW + i * 10 + 2)
      }
      const targets = buildUnidentifiedTargets(lib, { roots: roots(), now: NOW + 99999, unitLimit: 1 })

      // 只取一个单元 → 全部 target 必属同一部剧
      const dirs = new Set(targets.map((t) => dirname(t.videoPath)))
      expect(dirs.size).toBe(1)
      expect(targets).toHaveLength(3)   // 该剧的 3 集完整上车
    })

    it('🔴 跨季目录的集数仍归同一单元', () => {
      parkFile('TV/SpyFamily/Season 01/E01.mkv', NOW)
      parkFile('TV/SpyFamily/Season 02/E01.mkv', NOW + 1)
      const targets = buildUnidentifiedTargets(lib, { roots: roots(), now: NOW + 99999, unitLimit: 1 })
      expect(targets).toHaveLength(2)
    })

    it('MAX_TARGETS_PER_JOB 生效：单元累加不超上限', () => {
      // 两部剧各 40 集 = 80 > 60 → 第二部留下一轮（整单元不切半）
      for (let i = 0; i < 40; i++) {
        parkFile(`TV/BigA/E${String(i).padStart(2, '0')}.mkv`, NOW + i)
        parkFile(`TV/BigB/E${String(i).padStart(2, '0')}.mkv`, NOW + 1000 + i)
      }
      const targets = buildUnidentifiedTargets(lib, { roots: roots(), now: NOW + 99999, unitLimit: 3 })
      expect(targets).toHaveLength(40)   // 只装得下 BigA
      expect(new Set(targets.map((t) => dirname(t.videoPath))).size).toBe(1)
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
    // INNER 沙盒根 = **该单元的作品根**（spec 2026-08-07 §2 改动 A）。
    // 🔴 语义变更：此前这里断言的是 seasonDir——那是旧 commonDir（全批目标的公共祖先）的产物，
    // 也正是 2026-08-06 夜生产事故的根因（多根部署下公共祖先必越出配置根 → 每次派发都抛
    // "拒绝在媒体根目录之外写入"）。现在 mediaRoot 由 workRootOf 推导：Season 01 是作品**内部**
    // 结构，作品根在它之上，即 `<media>/后室`。spec §2 的回归锁明文要求"单个作品单元内的目标 →
    // mediaRoot 恰为作品根"。
    expect(seenTask!.mediaRoot).toBe(join(mediaRoot, '后室'))
    // stagingRoot 仍是配置根一级（gcOrphans 可及，H4 防线不受本次改动影响）
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
  // B1（2026-07-28 反编造审计）：回写现在有证据门——trace 里必须真的有 search_tmdb 调用，
  // 无证据的 unidentified 主张不作数（park 原因不动，路径照常退避重试）。夹具因此要往
  // traceBus 发布一条 search_tmdb 事件（runKey 拼法 `job-${job.id}`，同 runner 的收官快照）。
  it('unidentified + kind=insufficient-evidence → 回写 park 原因（trace 有 search_tmdb 证据）', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'random')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, '1.mp4')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()
    traceBus.publish({
      runKey: `job-${job.id}`, seq: 0, tool: 'search_tmdb',
      argsSummary: '{"query":"1","mediaType":"movie"}', resultSummary: '[]', tookMs: 5, at: 1,
    })

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

  // B1（2026-07-28 反编造审计，同夜事故：agent 步数烧尽后凭空报 unidentified/no_safe_match）：
  // trace 里 ZERO search_tmdb 调用 = 这个 unidentified 结论从未被调查过——回写不执行，
  // park 原因不动（路径照常退避重试），大声告警。
  it('🔴 B1：unidentified 但 trace 零 search_tmdb → 回写被拒（park 原因不动）+ 大声告警', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'random')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, '1.mp4')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()
    // trace 非空但没有任何 search_tmdb——模拟"步数烧尽后直接 finalize 编结论"的形状。
    traceBus.publish({
      runKey: `job-${job.id}`, seq: 0, tool: 'read_doc',
      argsSummary: '{"name":"identify-media"}', resultSummary: '{}', tookMs: 5, at: 1,
    })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: '（编造）无法识别', kind: 'insufficient-evidence' },
    }))

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    // 回写被拒：park 原因保持 awaiting-agent-identification（照常退避重试），
    // 不落 insufficient-evidence（那会把路径永久钉死）。
    const row = db.prepare(`SELECT park_reason FROM parked_paths WHERE path = ?`).get(epPath) as
      | { park_reason: string } | undefined
    expect(row?.park_reason).toBe(PARK_REASON.awaitingAgent)
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('search_tmdb'))
    errSpy.mockRestore()
  })

  it('B1：trace 整体缺席（null）同样拒回写——零证据主张不作数', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'random')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, '1.mp4')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    const job = claimUnidentifiedJob()
    // 不发布任何 trace 事件——snapshot 为空，traceJson null。

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: '（编造）无法识别', kind: 'identification-failed' },
    }))

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW,
    )

    const row = db.prepare(`SELECT park_reason FROM parked_paths WHERE path = ?`).get(epPath) as
      | { park_reason: string } | undefined
    expect(row?.park_reason).toBe(PARK_REASON.awaitingAgent)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
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
    // B1 证据门：回写要过门就得有 search_tmdb 痕迹（本测试的对象是阶梯不重置，不是门本身）。
    traceBus.publish({
      runKey: `job-${job.id}`, seq: 0, tool: 'search_tmdb',
      argsSummary: '{"query":"ep1","mediaType":"tv"}', resultSummary: '[]', tookMs: 5, at: 1,
    })

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: 'TMDB 暂无此条目', kind: 'identification-failed' },
    }))

    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      // now 取足够大让退避窗已过——本测试的对象是"回写不重置阶梯"，不是退避窗本身
      // （retry_count 已是 1，受窗约束，见 workUnit.ts 的退避 filter）。
      jobs, () => NOW + 10 * 3600_000,
    )

    const after = db.prepare(`SELECT park_reason, retry_count FROM parked_paths WHERE path = ?`).get(epPath) as
      { park_reason: string; retry_count: number }
    expect(after.park_reason).toBe('identification-failed')
    // upsertParkedPath 在 reason 变化时会把 retry_count 归零重置 1h 档——回写必须用
    // updateParkReason，阶梯不动。
    expect(after.retry_count).toBeGreaterThanOrEqual(1)
  })


  // ---- 活锁防线（spec 2026-08-07 §3.3.1，二轮审计 R2-B1）----
  // 三条 identify 失败路径必须**全部**推进退避轨，缺一条就漏一个活锁入口：坏单元的
  // next_retry_at 不前进 → 退避窗恒开；last_attempt 不前进 → 恒排队首 → 整队列被它卡死。
  const parkedRow = (p: string) =>
    db.prepare(`SELECT retry_count, next_retry_at, last_attempt, park_reason FROM parked_paths WHERE path = ?`)
      .get(p) as { retry_count: number; next_retry_at: number; last_attempt: number; park_reason: string }

  const setupOneParked = () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const epPath = join(showDir, 'ep1.mkv')
    writeFileSync(epPath, 'video')
    lib.upsertParkedPath(epPath, PARK_REASON.awaitingAgent, NOW, { mtimeMs: 100, size: 10 })
    return { mediaRoot, epPath }
  }

  it('🔴 活锁防线①：拒识（有 search 证据）推进退避轨', async () => {
    const { mediaRoot, epPath } = setupOneParked()
    const rcBefore = parkedRow(epPath).retry_count
    const job = claimUnidentifiedJob()
    traceBus.publish({
      runKey: `job-${job.id}`, seq: 0, tool: 'search_tmdb',
      argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: 1,
    })
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: 'TMDB 无此条目', kind: 'identification-failed' },
    }))
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )
    const after = parkedRow(epPath)
    expect(after.retry_count).toBeGreaterThan(rcBefore)
    expect(after.next_retry_at).toBeGreaterThan(NOW + 5000)   // 退避窗真的往前推了
    expect(after.last_attempt).toBe(NOW + 5000)
    expect(after.park_reason).toBe('identification-failed')   // 有证据 → reason 照常回写
  })

  it('🔴 活锁防线②：编造被拒（零 search 证据）仍推进退避轨，但 reason 不动', async () => {
    // 这是二轮审计定罪的最隐蔽一条：分支体原本只有 console.error，零 DB 写 →
    // last_attempt/retry_count 双双不动 → 该单元永远是"最老且窗口恒开"，恒排队首。
    const { mediaRoot, epPath } = setupOneParked()
    const rcBefore = parkedRow(epPath).retry_count
    const job = claimUnidentifiedJob()
    // 刻意不 publish 任何 search_tmdb → 触发反编造门
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: 'searched all providers', kind: 'identification-failed' },
    }))
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )
    const after = parkedRow(epPath)
    // 退避轨必须前进（机械事实：确实试过一次）
    expect(after.retry_count).toBeGreaterThan(rcBefore)
    expect(after.next_retry_at).toBeGreaterThan(NOW + 5000)
    expect(after.last_attempt).toBe(NOW + 5000)
    // 🔴 但 reason 绝不能被编造的结论污染——反幻觉红线
    expect(after.park_reason).toBe(PARK_REASON.awaitingAgent)
  })

  it('🔴 活锁防线③：空报告（completeError 路径）也推进退避轨', async () => {
    const { mediaRoot, epPath } = setupOneParked()
    const rcBefore = parkedRow(epPath).retry_count
    const job = claimUnidentifiedJob()
    // 全空报告且无 identity → 走 'worker returned an empty batch report' 那条 completeError
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }))
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )
    expect(jobs.get(job.id)!.last_error).toContain('empty batch report')
    const after = parkedRow(epPath)
    expect(after.retry_count).toBeGreaterThan(rcBefore)
    expect(after.next_retry_at).toBeGreaterThan(NOW + 5000)
    expect(after.park_reason).toBe(PARK_REASON.awaitingAgent)
  })


  it('🔴 活锁防线④：runTask 抛错（超时/沙盒）也推进退避轨（审计 B-2，生产最高频失败形态）', async () => {
    // AbortSignal.timeout 的 1h 硬顶、沙盒断言、worker 内部未捕获异常都落 catch，会**跳过**
    // 上方全部分支。此前这条路径零 parked 写 → 下一轮原样重来。
    const { mediaRoot, epPath } = setupOneParked()
    const rcBefore = parkedRow(epPath).retry_count
    const job = claimUnidentifiedJob()
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      throw new Error('The operation was aborted due to timeout')
    })
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )
    expect(jobs.get(job.id)!.last_error).toContain('timeout')
    const after = parkedRow(epPath)
    expect(after.retry_count).toBeGreaterThan(rcBefore)
    expect(after.next_retry_at).toBeGreaterThan(NOW + 5000)
    expect(after.last_attempt).toBe(NOW + 5000)
    expect(after.park_reason).toBe(PARK_REASON.awaitingAgent)
  })


  it('🔴 端到端活锁防线：坏单元失败后退出候选，后续单元能被处理（spec §3.3.1 综合锁）', async () => {
    // "活锁真的被修掉了"这个核心命题的唯一证明——写入侧(bumpParkedRetry)与消费侧
    // (groupIntoWorkUnits 的退避窗 filter)必须真的接上。审计 B-3 指出此前两侧零测试跨接。
    const mediaRoot = join(root, 'media')
    const mk = (rel: string, firstSeen: number) => {
      const p = join(mediaRoot, rel)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, 'v')
      lib.upsertParkedPath(p, PARK_REASON.awaitingAgent, firstSeen, { mtimeMs: 100, size: 10 })
      return p
    }
    mk('TV/BadShow/E01.mkv', NOW)            // 最老 → 队首
    mk('TV/GoodShow/E01.mkv', NOW + 1000)

    const groupOpts = { roots: [mediaRoot], unitLimit: 1 }
    const first = buildUnidentifiedTargets(lib, { ...groupOpts, now: NOW + 5000 })
    expect(dirname(first[0].videoPath)).toContain('BadShow')

    // 坏单元失败（catch 路径＝超时形态，生产最高频）
    const job = claimUnidentifiedJob()
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      throw new Error('The operation was aborted due to timeout')
    })
    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs, groupOpts },
      jobs, () => NOW + 5000,
    )

    // 🔴 下一轮队首换人＝活锁被打破
    const second = buildUnidentifiedTargets(lib, { ...groupOpts, now: NOW + 6000 })
    expect(second.length).toBeGreaterThan(0)
    expect(dirname(second[0].videoPath)).toContain('GoodShow')
  })

  // ---- 身份产出判据（方案 2026-08-07-identity-decoupling-plan §8 回归锁 #1-7）----
  // 病：identifyOnly worker 字幕工具零挂载（findSubtitleWorker.ts:209），识别成功的单元
  // **必然**四个字幕桶全空 → 旧判据判成"空报告" → completeError → error_attempt 单调
  // 累积（30s → 15min → 每天，jobsRepo.ts:402-405），而 orchestrator 重派走 coalesced
  // 分支不动 next_retry_at（jobsRepo.ts:185-188）→ 自加速退化：识别越顺，退避越长。
  // 治：加一个只读的"还有几条没被识别走"维度（lib.countParked），有产出就不记 failure。
  const mkParkedIn = (abs: string, firstSeen: number) => {
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'v')
    lib.upsertParkedPath(abs, PARK_REASON.awaitingAgent, firstSeen, { mtimeMs: 100, size: 10 })
    return abs
  }
  /** 模拟 write_identified_media 的落地事务：建库行 + clearParkedPath（identityTools.ts:172/229）。 */
  const identifyInto = (tmdb: string, epNo: number, path: string) => {
    const sid = seriesId(tmdb)
    const eid = episodeId(tmdb, 1, epNo)
    lib.upsertSeries({ id: sid, name: `Show ${tmdb}` })
    lib.upsertEpisode({
      id: eid, seriesId: sid, season: 1, episode: epNo, name: `E0${epNo}`, path, subStatus: 'missing',
    })
    lib.clearParkedPath(path)
    return eid
  }
  const identifiedReport = (tmdbId: string): FindSubtitleBatchReport => ({
    installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
    identity: {
      outcome: 'identified', tmdbId, isTv: true, season: 1, episode: 1,
      nameEvidence: 'dir name matches TMDB title', structureEvidence: 'season layout fits',
    },
  })

  it('🔴 锁#1：有产出（两文件都识别成功）+ 四桶全空 → completeDone、runs 无 error 行', async () => {
    const mediaRoot = join(root, 'media')
    const a = mkParkedIn(join(mediaRoot, 'Show', 'E01.mkv'), NOW)
    const b = mkParkedIn(join(mediaRoot, 'Show', 'E02.mkv'), NOW + 1)
    // 🔴 污染行（对抗审计 M-1）：三条**与本单元无关**的 parked 路径，全程不清。
    // 它们让"分子取自本单元 targets"这个语义可被区分——若哪天有人把判据的分子写成
    // countParked(全库 parked)，这里会变成 3 < 2 = false → 走失败分支 → 本条红。
    // 没有这几行时两个数值在夹具里恒等（2 targets / 2 parked），那个改动 39 条全绿放行，
    // 而它在生产（492 行 parked）会让判据恒假 → 100% 静默退回旧病。实测存活过。
    // 放在另一个目录：workRootOf 会把它们分到别的作品单元，不进本单元的 targets。
    mkParkedIn(join(mediaRoot, 'Unrelated', 'X01.mkv'), NOW + 100)
    mkParkedIn(join(mediaRoot, 'Unrelated', 'X02.mkv'), NOW + 101)
    mkParkedIn(join(mediaRoot, 'Unrelated', 'X03.mkv'), NOW + 102)
    const job = claimUnidentifiedJob()

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      identifyInto('4242', 1, a)
      identifyInto('4242', 2, b)
      // identifyOnly worker 无字幕工具 → 四桶必然全空。这是正常终局。
      return identifiedReport('4242')
    })
    await runUnidentifiedFindSubtitleWorkerTask(
      job,
      {
        lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs,
        // unitLimit:1 → 只处理最老的单元（Show/），三条污染行留在库里不上车。
        // 这正是本锁要的形状：本单元 2 个 target 全清，但全库仍有 3 条 parked。
        groupOpts: { roots: [mediaRoot], unitLimit: 1 },
      },
      jobs, () => NOW + 5000,
    )

    expect(runTask).toHaveBeenCalledTimes(1)
    expect(jobs.get(job.id)!.state).toBe('done')
    expect(jobs.get(job.id)!.last_error ?? '').not.toContain('empty batch report')
    expect(runs.getByJobId(job.id).map((r) => r.decision)).not.toContain('error')
  })

  it('🔴 锁#2：无产出（两文件都没识别）+ 四桶全空 → completeError + runs 有 error + retry_count +1', async () => {
    const mediaRoot = join(root, 'media')
    const a = mkParkedIn(join(mediaRoot, 'Show', 'E01.mkv'), NOW)
    const b = mkParkedIn(join(mediaRoot, 'Show', 'E02.mkv'), NOW + 1)
    const rcA = parkedRow(a).retry_count
    const rcB = parkedRow(b).retry_count
    const job = claimUnidentifiedJob()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }))
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )
    errSpy.mockRestore()

    expect(jobs.get(job.id)!.state).toBe('failed')
    expect(jobs.get(job.id)!.last_error).toContain('empty batch report')
    expect(runs.getByJobId(job.id).map((r) => r.decision)).toContain('error')
    expect(parkedRow(a).retry_count).toBe(rcA + 1)
    expect(parkedRow(b).retry_count).toBe(rcB + 1)
  })

  it('🔴 锁#3：部分成功（1 成功 1 失败）+ 四桶全空 → 不记 failure，失败那个 retry_count 恰好 +0', async () => {
    const mediaRoot = join(root, 'media')
    const ok = mkParkedIn(join(mediaRoot, 'Show', 'E01.mkv'), NOW)
    const bad = mkParkedIn(join(mediaRoot, 'Show', 'E02.mkv'), NOW + 1)
    const rcBad = parkedRow(bad).retry_count
    const job = claimUnidentifiedJob()

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      identifyInto('4243', 1, ok)   // 只识别出一个
      return identifiedReport('4243')
    })
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )

    expect(jobs.get(job.id)!.state).toBe('done')
    expect(runs.getByJobId(job.id).map((r) => r.decision)).not.toContain('error')
    // 🔴 有产出走成功分支 → 一次 bump 都不发生。失败那条路径下一轮自然重来
    // （它的 parked 行还在，退避窗未被推后）。
    expect(parkedRow(bad).retry_count).toBe(rcBad)
    expect(parkedRow(bad).retry_count).toBe(0)
  })

  it('🔴 锁#4：identity=null + 四桶全空 + 零产出 → retry_count 恰好 +1（锁死不双重 bump）', async () => {
    // identity===null 时 `:468`（identity 分支）整段不执行，只有新判据的失败分支 bump。
    // 若把 bump 写成无条件（不留守卫）本条仍绿；真正锁死守卫位置的是本条 + 锁#5 的组合。
    const { mediaRoot, epPath } = setupOneParked()
    expect(parkedRow(epPath).retry_count).toBe(0)
    const job = claimUnidentifiedJob()

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    }))
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )
    errSpy.mockRestore()

    expect(jobs.get(job.id)!.last_error).toContain('empty batch report')
    expect(parkedRow(epPath).retry_count).toBe(1)   // 恰好 +1，不是 +2
  })

  it('🔴 锁#5：outcome=unidentified + 四桶全空 + 零产出 → retry_count 恰好 +1（锁死 `:468` 与新判据不重复）', async () => {
    // 这是"守卫位置正确"的唯一证据：`:468` 对 unidentified 形状无条件 bump，新判据的失败
    // 分支必须靠 `outcome !== 'unidentified'` 守卫让开，否则这条会看到 +2。
    const { mediaRoot, epPath } = setupOneParked()
    expect(parkedRow(epPath).retry_count).toBe(0)
    const job = claimUnidentifiedJob()
    traceBus.publish({
      runKey: `job-${job.id}`, seq: 0, tool: 'search_tmdb',
      argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: 1,
    })

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
      identity: { outcome: 'unidentified', reason: 'TMDB 无此条目', kind: 'identification-failed' },
    }))
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )

    expect(jobs.get(job.id)!.last_error).toContain('empty batch report')
    expect(parkedRow(epPath).retry_count).toBe(1)   // 🔴 恰好 +1，不是 +2
  })

  it('🔴 锁#6：replica 分支（库中已有 tmdb:X 行 + 旧文件在）→ stillParked=0 → 不记 failure', async () => {
    // replica 分支（identityTools.ts:169-181）**不建库行**，只 clearParkedPath —— 所以
    // "查 episodes/movies 判产出"会漏报（方案 §9 v1 错设计 2），而 countParked 照样看得见。
    const mediaRoot = join(root, 'media')
    const oldPath = join(mediaRoot, 'Show', 'E01.1080p.mkv')
    mkdirSync(dirname(oldPath), { recursive: true })
    writeFileSync(oldPath, 'v')
    const existing = episodeId('4244', 1, 1)
    lib.upsertSeries({ id: seriesId('4244'), name: 'Show 4244' })
    lib.upsertEpisode({
      id: existing, seriesId: seriesId('4244'), season: 1, episode: 1,
      name: 'E01', path: oldPath, subStatus: 'covered',
    })
    const replica = mkParkedIn(join(mediaRoot, 'Show', 'E01.2160p.mkv'), NOW)
    const job = claimUnidentifiedJob()

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      // replica：同一 tmdbId 且库行已在 → 不建新行，只把 parked 户口清掉。
      lib.clearParkedPath(replica)
      return identifiedReport('4244')
    })
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )

    expect(jobs.get(job.id)!.state).toBe('done')
    expect(jobs.get(job.id)!.last_error ?? '').not.toContain('empty batch report')
    expect(runs.getByJobId(job.id).map((r) => r.decision)).not.toContain('error')
    // 判据不依赖库行数量：replica 没建行，产出仍被看见。
    expect(lib.getEpisode(existing)!.path).toBe(oldPath)
  })

  it('🔴 锁#7：1 成功 + agent 报 outcome=unidentified（混合单元的自然报法）→ 不记 failure', async () => {
    // 混合单元里 agent 识别出一部分、对剩下的报 unidentified 是**正常**报法。此时机械事实
    // （parked 少了一条）优先于 agent 的 advisory 结论 —— 不记 failure。
    const mediaRoot = join(root, 'media')
    const ok = mkParkedIn(join(mediaRoot, 'Show', 'E01.mkv'), NOW)
    const bad = mkParkedIn(join(mediaRoot, 'Show', 'E02.mkv'), NOW + 1)
    const job = claimUnidentifiedJob()
    traceBus.publish({
      runKey: `job-${job.id}`, seq: 0, tool: 'search_tmdb',
      argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: 1,
    })

    const runTask = vi.fn(async (): Promise<FindSubtitleBatchReport> => {
      identifyInto('4245', 1, ok)
      return {
        installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
        identity: { outcome: 'unidentified', reason: 'E02 路径无片名信息', kind: 'identification-failed' },
      }
    })
    await runUnidentifiedFindSubtitleWorkerTask(
      job, { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
      jobs, () => NOW + 5000,
    )

    expect(jobs.get(job.id)!.state).toBe('done')
    expect(jobs.get(job.id)!.last_error ?? '').not.toContain('empty batch report')
    expect(runs.getByJobId(job.id).map((r) => r.decision)).not.toContain('error')
    // `:468` 仍按"agent 明确拒识"推进未识别路径的退避轨（这条与新判据无关，不许回退）。
    expect(parkedRow(bad).retry_count).toBe(1)
  })

  // ---- 逐单元派活（spec 2026-08-07 §2 / §3.2.1，改动 A）----
    // Regression: a clean library with multiple configured roots once failed every run before the
    // agent started. The runner calculated one common directory for the whole batch, but that
    // ancestor was outside every configured root.
  describe('🔴 逐单元派活（修 commonDir 越界事故）', () => {
    const mkParked = (abs: string, firstSeen: number) => {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, 'v')
      lib.upsertParkedPath(abs, PARK_REASON.awaitingAgent, firstSeen, { mtimeMs: 100, size: 10 })
      return abs
    }
    const emptyReport = async (): Promise<FindSubtitleBatchReport> => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null,
    })

    it('目标散落三个配置根 → 不再抛越界错；每单元各派一次 runTask，mediaRoot 恰为其作品根', async () => {
      // 事故的最小复现形状：三个平级配置根，父目录（root）不在 MEDIA_ROOTS 里。
      const movies = join(root, 'Movies')
      const tv = join(root, 'TV')
      const anime = join(root, 'anime')
      const moviePath = mkParked(join(movies, 'Pulp Fiction (1994)', 'movie.mkv'), NOW)
      const tvPath = mkParked(join(tv, 'Constellation', 'S01E03.mkv'), NOW + 1)
      const animePath = mkParked(join(anime, 'SpyFamily', 'Season 01', 'E01.mkv'), NOW + 2)
      const job = claimUnidentifiedJob()

      const seen: FindSubtitleTask[] = []
      const runTask = vi.fn(async (task: FindSubtitleTask) => {
        seen.push(task)
        return emptyReport()
      })
      await runUnidentifiedFindSubtitleWorkerTask(
        job,
        {
          lib, mediaRoots: [movies, tv, anime], targetLanguage: 'zh', hardsubMode: 'off',
          runTask, runs, groupOpts: { unitLimit: 3 },
        },
        jobs, () => NOW + 5000,
      )

      // 🔴 事故断言：越界错误绝不再出现
      expect(jobs.get(job.id)!.last_error ?? '').not.toContain('拒绝在媒体根目录之外写入')
      // 三个单元 → 三次派活（每单元一次 runTask）
      expect(runTask).toHaveBeenCalledTimes(3)
      const byTarget = new Map(seen.map((t) => [t.targets[0].videoPath, t]))
      // 每个单元的 mediaRoot 恰为其作品根（§3.2 的推导：作品目录层，不是季目录、不是公共祖先）
      expect(byTarget.get(moviePath)!.mediaRoot).toBe(join(movies, 'Pulp Fiction (1994)'))
      expect(byTarget.get(tvPath)!.mediaRoot).toBe(join(tv, 'Constellation'))
      expect(byTarget.get(animePath)!.mediaRoot).toBe(join(anime, 'SpyFamily'))
      // stagingRoot 仍是配置根一级（gcOrphans 可及，H4 防线不回退）
      expect(byTarget.get(moviePath)!.stagingRoot).toBe(movies)
      expect(byTarget.get(tvPath)!.stagingRoot).toBe(tv)
      expect(byTarget.get(animePath)!.stagingRoot).toBe(anime)
    })

    it('同一作品的跨季文件归一个单元；mediaRoot = 作品目录（不是季目录）', async () => {
      const mediaRoot = join(root, 'media')
      const a = mkParked(join(mediaRoot, 'TV', 'SpyFamily', 'Season 01', 'E01.mkv'), NOW)
      const b = mkParked(join(mediaRoot, 'TV', 'SpyFamily', 'Season 02', 'E01.mkv'), NOW + 1)
      const job = claimUnidentifiedJob()

      let seen: FindSubtitleTask | null = null
      const runTask = vi.fn(async (task: FindSubtitleTask) => {
        seen = task
        return emptyReport()
      })
      await runUnidentifiedFindSubtitleWorkerTask(
        job,
        { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
        jobs, () => NOW + 5000,
      )

      expect(runTask).toHaveBeenCalledTimes(1)
      expect(seen!.mediaRoot).toBe(join(mediaRoot, 'TV', 'SpyFamily'))
      expect(seen!.targets.map((t) => t.videoPath).sort()).toEqual([a, b].sort())
      expect(seen!.workUnitKind).toBe('work-dir')
    })

    it('🔴 安全性不回退：目标目录真的越出全部配置根 → ① assertDirSafe 仍抛', async () => {
      const mediaRoot = join(root, 'media')
      mkdirSync(mediaRoot, { recursive: true })
      const outside = mkParked(join(root, 'outside', 'Show', 'ep1.mkv'), NOW)
      const job = claimUnidentifiedJob()

      const runTask = vi.fn(emptyReport)
      await runUnidentifiedFindSubtitleWorkerTask(
        job,
        { lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
        jobs, () => NOW + 5000,
      )

      // OUTER 沙盒门（①）是真正的边界，删 ②③ 不许把它一起删掉
      expect(runTask).not.toHaveBeenCalled()
      expect(jobs.get(job.id)!.state).toBe('failed')
      expect(jobs.get(job.id)!.last_error).toContain('拒绝在媒体根目录之外写入')
      expect(jobs.get(job.id)!.last_error).toContain(dirname(outside))
      // 活锁防线：越界单元也要推进退避轨（否则下一轮原样重来）
      expect(parkedRow(outside).retry_count).toBeGreaterThan(0)
    })

    it('🔴 一个单元失败只 bump 该单元；成功单元的 parked 行不被牵连', async () => {
      const mediaRoot = join(root, 'media')
      const bad = mkParked(join(mediaRoot, 'TV', 'BadShow', 'E01.mkv'), NOW)
      const good = mkParked(join(mediaRoot, 'TV', 'GoodShow', 'E01.mkv'), NOW + 1000)
      const job = claimUnidentifiedJob()

      const goodEpisode = episodeId('999', 1, 1)
      const runTask = vi.fn(async (task: FindSubtitleTask): Promise<FindSubtitleBatchReport> => {
        if (task.mediaRoot.includes('BadShow')) throw new Error('The operation was aborted due to timeout')
        lib.upsertSeries({ id: seriesId('999'), name: 'Good' })
        lib.upsertEpisode({
          id: goodEpisode, seriesId: seriesId('999'), season: 1, episode: 1,
          name: 'Good', path: good, subStatus: 'missing',
        })
        lib.clearParkedPath(good)
        return {
          installed: [{
            itemId: goodEpisode, installedPath: join(dirname(good), 'E01.zh-Hans.srt'),
            installedLanguage: 'zh-Hans', candidateProvider: null, candidateProviderId: null,
            reason: 'ok',
          }],
          no_safe_match: [], retry_later: [], hardsub_assumed: [],
          identity: {
            outcome: 'identified', tmdbId: '999', isTv: true, season: 1, episode: 1,
            nameEvidence: 'n', structureEvidence: 's',
          },
        }
      })
      await runUnidentifiedFindSubtitleWorkerTask(
        job,
        {
          lib, mediaRoots: [mediaRoot], targetLanguage: 'zh', hardsubMode: 'off',
          runTask, runs, groupOpts: { unitLimit: 3 },
        },
        jobs, () => NOW + 5000,
      )

      expect(runTask).toHaveBeenCalledTimes(2)
      // 坏单元的退避轨前进
      expect(parkedRow(bad).retry_count).toBeGreaterThan(0)
      // 好单元：write_identified_media 已清出 parked（不许被 bump 复活/牵连）
      expect(db.prepare(`SELECT path FROM parked_paths WHERE path = ?`).get(good)).toBeUndefined()
      expect(lib.getEpisode(goodEpisode)!.sub_status).toBe('covered')
      // 一个单元失败 → job 落 failed（错误信息可诊断），但成功单元的入账已落库
      expect(jobs.get(job.id)!.state).toBe('failed')
      expect(jobs.get(job.id)!.last_error).toContain('timeout')
    })

    it('扁平文件合成单元：mediaRoot = 配置根，workUnitKind = flat-batch（prompt 措辞分支）', async () => {
      const movies = join(root, 'Movies')
      mkParked(join(movies, 'some.movie.2024.mkv'), NOW)
      const job = claimUnidentifiedJob()

      let seen: FindSubtitleTask | null = null
      const runTask = vi.fn(async (task: FindSubtitleTask) => {
        seen = task
        return emptyReport()
      })
      await runUnidentifiedFindSubtitleWorkerTask(
        job,
        { lib, mediaRoots: [movies], targetLanguage: 'zh', hardsubMode: 'off', runTask, runs },
        jobs, () => NOW + 5000,
      )

      expect(seen!.mediaRoot).toBe(movies)
      expect(seen!.workUnitKind).toBe('flat-batch')
    })
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
    // 第 7 步 C 组（2/2）：write_identified_media 已随 agent/identityTools.ts 删除——它是
    // series/episodes/movies 三张旧表最后的 INSERT 路径，本函数（makeUnidentifiedFindSubtitleWorker）
    // 是它 identityDeps 的唯一生产供应点，而这条链整体不可达（唯一调用者 cli/index.ts 的
    // handleWorkerTask 是零调用者孤儿）。本 worker 形态从此无落库通道，见被测函数头注释。
    expect([...capturedTools].sort()).toEqual(
      ['finalize', 'get_tmdb_details', 'read_doc', 'search_tmdb'].sort(),
    )
    // skill 索引只含识别文档；找字幕 playbook 不出现
    expect(capturedSystemText).toContain('identify-media')
    expect(capturedSystemText).not.toContain('find-subtitle-judgment')
    // prompt 是 unidentified 形态：raw evidence 保留（embedded langs 证据行必须在），
    // 不出现任何字幕工具名。
    expect(capturedPromptText).toContain('This task carries NO identity')
    expect(capturedPromptText).not.toContain('guessed title')
    expect(capturedPromptText).toContain(
      '- itemId: null (unidentified — identify first, then report it in finalize) | structure hint: season 1 | duration: 2530s | embedded langs: eng | file: 2026.2160p.iT.WEB-DL.H.265.mkv',
    )
    for (const name of ['search_source', 'list_candidates', 'get_candidate', 'download_candidate', 'install_subtitle', 'check_episode_code_safety']) {
      expect(capturedPromptText).not.toContain(name)
      expect(capturedSystemText).not.toContain(name)
    }
  })
})
