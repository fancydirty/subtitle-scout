import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../adapters/fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import {
  makeFindSubtitleWorker, BATCH_BASE_TIMEOUT_MS, PER_TARGET_TIMEOUT_MS, BATCH_TIMEOUT_CAP_MS,
} from './findSubtitleWorker.js'
import type { FindSubtitleTask, FindSubtitleTargetFact } from './findSubtitleWorker.schemas.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-find-subtitle-e2e-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function fakeCandidate(): SubtitleCandidate {
  return {
    provider: 'assrt', providerId: '1', videoName: 'Show.S01E01.1080p',
    nativeName: null, language: 'zh-CN', subtype: null, releaseSite: null, uploadDate: null,
    fileList: [{ index: 0, name: 'Show.S01E01.srt' }],
  }
}

function fakeAdapter(): FetchAdapter {
  return {
    name: 'assrt',
    enabled: () => true,
    search: async () => [fakeCandidate()],
    resolve: async () => ({ url: 'http://file0.assrt.net/x.srt', filename: 'Show.S01E01.srt' }),
  }
}

/** Base fields shared by every task built in this file — only `targets` (and any overridden
 *  field) varies per test. */
function baseTask(mediaRoot: string, targets: FindSubtitleTargetFact[], overrides: Partial<FindSubtitleTask> = {}): FindSubtitleTask {
  return {
    jobId: 'job-1', mediaRoot, title: 'Show', originalTitle: null, year: 2024,
    alternativeTitles: [], overview: null, runtimeMinutes: 24, providerIds: {}, targetLanguage: 'zh',
    hardsubMode: 'off',
    localCandidates: [],
    targets,
    ...overrides,
  }
}

/** Reads a prior tool call's JSON result out of a scripted step's own prompt history — the
 *  only way a static-but-stateful mock model can react to a REAL runtime-generated value
 *  (like download_candidate's randomUUID() stagedFileId) it could not have known in advance. */
function findToolResultValue(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') {
        return part.output.value
      }
    }
  }
  throw new Error(`no tool-result for ${toolName} found in prompt history`)
}

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}

/** The terminal step of a REAL find-subtitle run on the openai-compatible provider: a NATIVE
 *  tool_call to `finalize` whose arguments ARE the FindSubtitleBatchReport. This is what the model
 *  actually does now (finalize-tool mode, not an Output.object text blob) — the whole reason the
 *  offline mock could not catch the live AI_NoObjectGeneratedError. hasToolCall('finalize') stops
 *  the loop here; readFinalized() returns these args as the batch report. */
function finalizeResult(output: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId: 'finalize-1', toolName: 'finalize', input: JSON.stringify(output) }],
    warnings: [],
  }
}

describe('makeFindSubtitleWorker (end-to-end, mock model)', () => {
  it('searches, downloads, compares, installs, and reports installed', async () => {
    const mediaRoot = join(root, 'media')
    const videoPath = join(mediaRoot, 'Show', 'Show.S01E01.mkv')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        call++
        if (call === 1) {
          return toolCallResult('c1', 'search_source', { queries: ['Show'], languages: ['zh-Hans'] })
        }
        if (call === 2) {
          // Real-model arg shape (mimo-v2.5 live trace): the COMPOSITE candidateKey `id` the agent was
          // shown ("assrt:1"), NOT a bare providerId, and a STRING-encoded null fileIndex ("None").
          return toolCallResult('c2', 'download_candidate', { candidateId: 'assrt:1', fileIndex: 'None' })
        }
        if (call === 3) {
          const downloaded = findToolResultValue(options.prompt, 'download_candidate')
          return toolCallResult('c3', 'install_subtitle', { stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hans' })
        }
        const installed = findToolResultValue(options.prompt, 'install_subtitle')
        return finalizeResult({
          installed: [{
            itemId: 'ep-1', reason: 'release name and cue count match S01E01',
            installedPath: installed.path, installedLanguage: 'zh-Hans',
            candidateProvider: 'assrt', candidateProviderId: '1',
          }],
          no_safe_match: [], retry_later: [],
        })
      },
    })

    const fetchImpl = async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n'))

    const runTask = makeFindSubtitleWorker({
      model, adapters: [fakeAdapter()], cacheRoot: join(root, 'cache'),
      fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
    })

    const task = baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath, videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
    ])

    const report = await runTask(task)

    expect(report.installed).toHaveLength(1)
    expect(report.no_safe_match).toEqual([])
    expect(report.retry_later).toEqual([])
    expect(report.installed[0].itemId).toBe('ep-1')
    expect(report.installed[0].installedPath).toBe(join(mediaRoot, 'Show', 'Show.S01E01.zh-Hans.srt'))
    expect(existsSync(report.installed[0].installedPath)).toBe(true)
    expect(readFileSync(report.installed[0].installedPath, 'utf8')).toContain('hello')
    // sandbox cleanup: the staging dir under mediaRoot/.subtitle-staging/job-1 is gone after the run
    expect(existsSync(join(mediaRoot, '.subtitle-staging', 'job-1'))).toBe(false)
  })

  it('rejects a task whose any target videoPath escapes its own mediaRoot before ever calling the model', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(mediaRoot, { recursive: true })
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('model should never be called') } })
    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache') })
    // Two targets: the first is fine, the second escapes — ANY escaping target must fail the
    // WHOLE task before the model is ever invoked, not just that one target.
    const task = baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
      { itemId: 'ep-2', videoPath: join(root, 'elsewhere', 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv', season: 1, episode: 2, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-2', year: null, runtimeMinutes: null })
    await expect(runTask(task)).rejects.toThrow(/escapes its own sandboxed mediaRoot/)
  })

  it('interpolates task.targetLanguage into the worker prompt as a human-readable language name', async () => {
    const mediaRoot = join(root, 'media')
    const videoPath = join(mediaRoot, 'Show', 'Show.S01E01.mkv')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        // Terminal step: no candidates worth pursuing, so the loop ends after one call.
        return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'nothing plausible' }], retry_later: [] })
      },
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    const task = baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath, videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-3', targetLanguage: 'en' })

    await runTask(task)

    // Both the header sentence and the field line carry the target language — and no trace of
    // the pre-parameterization hardcoded 'Chinese' may remain anywhere in the prompt template.
    expect(capturedPromptText).toContain('Find and install subtitles in English')
    expect(capturedPromptText).toContain('target subtitle language: English')
    expect(capturedPromptText).not.toContain('Chinese')
  })

  it('lists every target fact row in the prompt, including itemId and the absolute-episode hint', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        return finalizeResult({ installed: [], no_safe_match: [], retry_later: [] })
      },
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    const task = baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: 1, imdbId: null },
      { itemId: 'ep-2', videoPath: join(mediaRoot, 'Show', 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv', season: 1, episode: 2, absoluteEpisode: 2, imdbId: null },
      { itemId: 'movie-1', videoPath: join(mediaRoot, 'Show', 'Movie.mkv'), videoFilename: 'Movie.mkv', season: null, episode: null, absoluteEpisode: null, imdbId: 'tt0133093' },
    ], { jobId: 'job-4' })

    await runTask(task)

    // 验收轮一（imdb 采集）：目标行携带 imdb 事实——有值给真值（worker 用它做精确搜索），
    // 无值明示 unknown（禁止编造，见 search_source 工具描述）。
    expect(capturedPromptText).toContain('targets (3 item(s), current gaps in this scope):')
    expect(capturedPromptText).toContain('- itemId: ep-1 | S1E1 | absolute episode: 1 | imdb: unknown | file: Show.S01E01.mkv')
    expect(capturedPromptText).toContain('- itemId: ep-2 | S1E2 | absolute episode: 2 | imdb: unknown | file: Show.S01E02.mkv')
    expect(capturedPromptText).toContain('- itemId: movie-1 | (movie) | imdb: tt0133093 | file: Movie.mkv')
  })

  // 2026-07-18 事故修复（True Detective S02E08）：target 级实际时长事实必须与 task 级剧典型
  // fallback 值在措辞上可区分——agent 曾经只看到 task 级剧典型值（"runtime minutes: 58"），
  // 把它当全季所有集的事实，诚实地拒判了时长正确的加长季终候选字幕。
  it('target 行有 runtimeMinutes 时附加该集本尊时长事实；task 级行措辞明示是剧级典型 fallback', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        return finalizeResult({ installed: [], no_safe_match: [], retry_later: [] })
      },
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    const task = baseTask(mediaRoot, [
      // True Detective S02E08：加长季终，本尊时长 86 分——远高于剧级典型 58。
      { itemId: 'ep-8', videoPath: join(mediaRoot, 'Show', 'Show.S02E08.mkv'), videoFilename: 'Show.S02E08.mkv', season: 2, episode: 8, absoluteEpisode: null, imdbId: null, runtimeMinutes: 86 },
      // 没有本尊时长事实的 target（缺席/null）——不虚报一段 runtime。
      { itemId: 'ep-9', videoPath: join(mediaRoot, 'Show', 'Show.S02E09.mkv'), videoFilename: 'Show.S02E09.mkv', season: 2, episode: 9, absoluteEpisode: null, imdbId: null, runtimeMinutes: null },
    ], { jobId: 'job-5', runtimeMinutes: 58 })

    await runTask(task)

    expect(capturedPromptText).toContain('- itemId: ep-8 | S2E8 | imdb: unknown | runtime ~86 min | file: Show.S02E08.mkv')
    expect(capturedPromptText).toContain('- itemId: ep-9 | S2E9 | imdb: unknown | file: Show.S02E09.mkv')
    expect(capturedPromptText).not.toContain('itemId: ep-9 | S2E9 | imdb: unknown | runtime')
    // task 级行：措辞明示这是剧级典型/fallback 值，不是单集事实——绝不能让 agent 把它当
    // 每一集的实际时长使用。
    expect(capturedPromptText).toContain('typical episode runtime (series-level fallback, minutes): 58')
    expect(capturedPromptText).not.toContain('runtime minutes: 58')
  })

  // 🔴 第九轮 auto research 修复的 plumbing 缺口：Step 0 的 skill 明确教"文件名是纯技术
  // token 时标题只在目录名里"，但 prompt 此前只给 basename，目录名从未进过 prompt——教了一份
  // 模型拿不到的证据。实测后室 case 里模型写下 "No directory names were provided, so
  // re-identification is impossible"，诚实卡死在缺料上。
  it('prompt 携带目录名证据（沙盒根目录名 + 相对子目录段），不只是 basename', async () => {
    const mediaRoot = join(root, 'media', 'H）后丨室（2026）4K DV HDR')
    const seasonDir = join(mediaRoot, 'Season 01')
    mkdirSync(seasonDir, { recursive: true })

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'x' }], retry_later: [] })
      },
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    await runTask(baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath: join(seasonDir, '2026.2160p.iT.WEB-DL.H.265.mkv'), videoFilename: '2026.2160p.iT.WEB-DL.H.265.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-dirname' }))

    // 沙盒根目录名（标题就在这里）+ 相对子目录段
    expect(capturedPromptText).toContain('containing directory: H）后丨室（2026）4K DV HDR')
    expect(capturedPromptText).toContain('subdirectories: Season 01')
    // 沙盒纪律：不泄漏 mediaRoot 以外的路径
    expect(capturedPromptText).not.toContain(root)
  })

  it('文件直接躺在沙盒根下时省略 subdirectories 段（不虚报空值）', async () => {
    const mediaRoot = join(root, 'media', 'Show')
    mkdirSync(mediaRoot, { recursive: true })

    let capturedPromptText = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (options: LanguageModelV4CallOptions) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'x' }], retry_later: [] })
      },
    })
    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    await runTask(baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath: join(mediaRoot, 'a.mkv'), videoFilename: 'a.mkv', season: null, episode: null, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-flat' }))

    expect(capturedPromptText).toContain('containing directory: Show')
    expect(capturedPromptText).not.toContain('subdirectories:')
  })

  // 路 A（2026-07-26 识别架构）：deps.tmdb 决定识别证据工具是否挂载 + prompt 是否教
  // Step 0 验证——同开同关，不许出现"教了验证但没工具"或"有工具但没教"的分裂态。
  describe('identity evidence tools（路 A：tmdb 工具挂载与 prompt 标注）', () => {
    const fakeTmdb = () => ({
      search: vi.fn(async () => []),
      getDetails: vi.fn(async () => null),
      getSeasonTable: vi.fn(async () => null),
    })

    /** Captures the tools object the reasoning agent was assembled with, plus the prompt. */
    function captureModel(onCaptured: (options: LanguageModelV4CallOptions) => void) {
      return new MockLanguageModelV4({
        doGenerate: async (options: LanguageModelV4CallOptions) => {
          onCaptured(options)
          return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'x' }], retry_later: [] })
        },
      })
    }

    it('deps.tmdb 提供时：search_tmdb/get_tmdb_details 挂上且可调用，prompt 标注机械猜测', async () => {
      const mediaRoot = join(root, 'media')
      mkdirSync(join(mediaRoot, 'Show'), { recursive: true })
      const tmdb = fakeTmdb()

      let capturedPromptText = ''
      let capturedTools: string[] = []
      const model = captureModel((options) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        capturedTools = (options.tools ?? []).map((t: any) => t.name)
      })

      const runTask = makeFindSubtitleWorker({
        model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10, tmdb,
      })
      const task = baseTask(mediaRoot, [
        { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
      ], { jobId: 'job-tmdb-1' })

      await runTask(task)

      expect(capturedTools).toContain('search_tmdb')
      expect(capturedTools).toContain('get_tmdb_details')
      // prompt 把机械身份标注为猜测 + 指向 Step 0 验证
      expect(capturedPromptText).toContain('MECHANICAL GUESS')
      expect(capturedPromptText).toContain('verify it first per the skill document (Step 0)')
      expect(capturedPromptText).toContain('guessed title: Show')
    })

    it('deps.tmdb 缺席（TMDB 未配置）：识别工具不挂，prompt 明示无验证手段', async () => {
      const mediaRoot = join(root, 'media')
      mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

      let capturedPromptText = ''
      let capturedTools: string[] = []
      const model = captureModel((options) => {
        const userMessage = options.prompt.find(m => m.role === 'user')
        const textPart = (userMessage?.content as any[])?.find((p: any) => p.type === 'text')
        capturedPromptText = textPart?.text ?? ''
        capturedTools = (options.tools ?? []).map((t: any) => t.name)
      })

      const runTask = makeFindSubtitleWorker({
        model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10,
      })
      const task = baseTask(mediaRoot, [
        { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
      ], { jobId: 'job-tmdb-2' })

      await runTask(task)

      expect(capturedTools).not.toContain('search_tmdb')
      expect(capturedTools).not.toContain('get_tmdb_details')
      expect(capturedPromptText).toContain('MECHANICAL GUESS')
      expect(capturedPromptText).toContain('no verification tools are available')
      expect(capturedPromptText).not.toContain('Step 0')
    })

    it('tmdb 工具真实可执行：search_tmdb 透传 search 调用', async () => {
      const mediaRoot = join(root, 'media')
      mkdirSync(join(mediaRoot, 'Show'), { recursive: true })
      const tmdb = {
        search: vi.fn(async () => [{ id: 42, title: 'Real Show', originalTitle: null, year: 2020, posterPath: null }]),
        getDetails: vi.fn(async () => null),
        getSeasonTable: vi.fn(async () => null),
      }

      let call = 0
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          call++
          if (call === 1) {
            // agent 第一步就调 search_tmdb 做识别（Step 0 行为）
            return toolCallResult('t1', 'search_tmdb', { query: 'Show', mediaType: 'tv' })
          }
          return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'identity could not be verified' }], retry_later: [] })
        },
      })

      const runTask = makeFindSubtitleWorker({
        model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10, tmdb,
      })
      const task = baseTask(mediaRoot, [
        { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
      ], { jobId: 'job-tmdb-3' })

      await runTask(task)

      expect(tmdb.search).toHaveBeenCalledWith('tv', 'Show', undefined)
    })
  })

  // Task 9（agent-first 识别落地）：identityDeps 决定 write_identified_media 是否挂载——与
  // tmdb 证据工具同一纪律（依赖缺席时模型连工具名都看不到）。与任务书原文的两处最小偏差，
  // 均被 repo 现实强制：① makeFindSubtitleWorker 返回的是 run 函数，tools 在每个 run 内部
  // 现建（不在返回值上），只能由 mock model 在 doGenerate 里捕获 options.tools 断言，与上方
  // identity evidence tools 组同法；② 本 repo 的 mock 模型是 MockLanguageModelV4。
  describe('findSubtitleWorker with identityDeps', () => {
    const fakeIdentityTmdb = () => ({
      getDetails: vi.fn(),
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    })

    function captureToolsModel(captured: { tools: string[] }) {
      return new MockLanguageModelV4({
        doGenerate: async (options: LanguageModelV4CallOptions) => {
          captured.tools = (options.tools ?? []).map((t: any) => t.name)
          return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'x' }], retry_later: [] })
        },
      })
    }

    it('includes write_identified_media tool when identityDeps provided', async () => {
      const mediaRoot = join(root, 'media')
      mkdirSync(join(mediaRoot, 'Show'), { recursive: true })
      const db = openDb(':memory:')
      try {
        const lib = new LibraryRepo(db)
        const captured: { tools: string[] } = { tools: [] }
        const runTask = makeFindSubtitleWorker({
          model: captureToolsModel(captured), adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10,
          identityDeps: { lib, tmdb: fakeIdentityTmdb() },
        })
        await runTask(baseTask(mediaRoot, [
          { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
        ], { jobId: 'job-identity-1' }))

        expect(captured.tools).toContain('write_identified_media')
      } finally {
        db.close()
      }
    })

    it('omits write_identified_media tool when identityDeps not provided', async () => {
      const mediaRoot = join(root, 'media')
      mkdirSync(join(mediaRoot, 'Show'), { recursive: true })
      const captured: { tools: string[] } = { tools: [] }
      const runTask = makeFindSubtitleWorker({
        model: captureToolsModel(captured), adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10,
      })
      await runTask(baseTask(mediaRoot, [
        { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
      ], { jobId: 'job-identity-2' }))

      expect(captured.tools).not.toContain('write_identified_media')
    })
  })

  it('finalize returns a batch report keyed by installed/no_safe_match/retry_later buckets', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    const model = new MockLanguageModelV4({
      doGenerate: async () => finalizeResult({
        installed: [],
        no_safe_match: [{ itemId: 'ep-2', reason: 'no plausible candidate' }],
        retry_later: [{ itemId: 'ep-3', reason: 'provider timed out' }],
      }),
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    const task = baseTask(mediaRoot, [
      { itemId: 'ep-2', videoPath: join(mediaRoot, 'Show', 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv', season: 1, episode: 2, absoluteEpisode: null, imdbId: null },
      { itemId: 'ep-3', videoPath: join(mediaRoot, 'Show', 'Show.S01E03.mkv'), videoFilename: 'Show.S01E03.mkv', season: 1, episode: 3, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-5' })

    const report = await runTask(task)

    expect(report.installed).toEqual([])
    expect(report.no_safe_match).toEqual([{ itemId: 'ep-2', reason: 'no plausible candidate' }])
    expect(report.retry_later).toEqual([{ itemId: 'ep-3', reason: 'provider timed out' }])
  })

  // H4（2026-07-18 数据安全审计——gcOrphans 盲区修复）：allocate/cleanup 必须挂在
  // task.stagingRoot（配置媒体根一级），不是收窄的 task.mediaRoot——否则 gcOrphans 按配置根
  // 一级非递归扫描永远够不到它，硬杀在 allocate/cleanup 之间发生时就是永久泄漏。断言在
  // doGenerate 内部实时检查磁盘状态（跑到一半时），而不是只看运行结束后的状态——运行结束后
  // 两种实现（对/错）都会把目录清空，只有"运行期间"能分辨 allocate 到底把沙盒挂在了哪。
  it('allocate/cleanup 都用 task.stagingRoot 当沙盒根，不是收窄的 task.mediaRoot（H4）', async () => {
    const stagingRootDir = join(root, 'media') // 配置媒体根一级
    const narrowMediaRoot = join(stagingRootDir, 'Show', 'Season 01') // 收窄的 INNER 沙盒根
    mkdirSync(narrowMediaRoot, { recursive: true })
    const videoPath = join(narrowMediaRoot, 'Show.S01E01.mkv')

    let sawStagingUnderConfiguredRoot = false
    let sawNoStagingUnderNarrowRoot = false
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        sawStagingUnderConfiguredRoot = existsSync(join(stagingRootDir, '.subtitle-staging', 'job-h4'))
        sawNoStagingUnderNarrowRoot = !existsSync(join(narrowMediaRoot, '.subtitle-staging', 'job-h4'))
        return finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'nothing plausible' }], retry_later: [] })
      },
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    const task = baseTask(narrowMediaRoot, [
      { itemId: 'ep-1', videoPath, videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-h4', stagingRoot: stagingRootDir })

    await runTask(task)

    expect(sawStagingUnderConfiguredRoot).toBe(true) // allocate 挂在了 stagingRoot 下
    expect(sawNoStagingUnderNarrowRoot).toBe(true) // 没有误挂在收窄的 mediaRoot 下
    // cleanup 也用了同一个根——staging 目录在运行结束后被清空，不是留在 mediaRoot 下的空手套
    expect(existsSync(join(stagingRootDir, '.subtitle-staging', 'job-h4'))).toBe(false)
  })

  // stagingRoot 缺席（realignExecutor.ts 圣文件不带这个键的路径）→ fallback 到 task.mediaRoot，
  // 保持与 H4 之前完全一致的行为（回归测试：本次改动前 allocate/cleanup 一直只认 task.mediaRoot）。
  it('task.stagingRoot 缺席时 fallback 到 task.mediaRoot（realignExecutor.ts 兼容路径）', async () => {
    const mediaRoot = join(root, 'media-fallback')
    const videoPath = join(mediaRoot, 'Show', 'Show.S01E01.mkv')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    const model = new MockLanguageModelV4({
      doGenerate: async () => finalizeResult({ installed: [], no_safe_match: [{ itemId: 'ep-1', reason: 'nothing plausible' }], retry_later: [] }),
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    // no stagingRoot override — baseTask's overrides never set it, so task.stagingRoot is undefined.
    const task = baseTask(mediaRoot, [
      { itemId: 'ep-1', videoPath, videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null, imdbId: null },
    ], { jobId: 'job-h4-fallback' })

    await runTask(task)

    expect(existsSync(join(mediaRoot, '.subtitle-staging', 'job-h4-fallback'))).toBe(false) // cleaned up, no leak
  })
})

describe('timeout scaling by target count (BATCH_BASE_TIMEOUT_MS / PER_TARGET_TIMEOUT_MS / BATCH_TIMEOUT_CAP_MS)', () => {
  function makeTargets(n: number, mediaRoot: string): FindSubtitleTargetFact[] {
    return Array.from({ length: n }, (_, i) => ({
      itemId: `ep-${i + 1}`,
      videoPath: join(mediaRoot, 'Show', `Show.S01E${String(i + 1).padStart(2, '0')}.mkv`),
      videoFilename: `Show.S01E${String(i + 1).padStart(2, '0')}.mkv`,
      season: 1, episode: i + 1, absoluteEpisode: null, imdbId: null,
    }))
  }

  it.each([
    [1, BATCH_BASE_TIMEOUT_MS],
    [12, BATCH_BASE_TIMEOUT_MS + PER_TARGET_TIMEOUT_MS * 11],
    [40, BATCH_TIMEOUT_CAP_MS],
  ])('passes AbortSignal.timeout(%i target(s)) = %i ms when deps.timeoutMs is not set', async (n, expectedMs) => {
    const mediaRoot = join(root, 'media')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    const capturedMs: number[] = []
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      capturedMs.push(ms)
      return new AbortController().signal
    })
    try {
      const model = new MockLanguageModelV4({
        doGenerate: async () => finalizeResult({ installed: [], no_safe_match: [], retry_later: [] }),
      })
      const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
      const task = baseTask(mediaRoot, makeTargets(n, mediaRoot), { jobId: 'job-timeout' })

      await runTask(task)

      expect(capturedMs).toEqual([expectedMs])
    } finally {
      spy.mockRestore()
    }
  })

  it('deps.timeoutMs, when set, overrides the target-count-scaled default', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(join(mediaRoot, 'Show'), { recursive: true })

    const capturedMs: number[] = []
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      capturedMs.push(ms)
      return new AbortController().signal
    })
    try {
      const model = new MockLanguageModelV4({
        doGenerate: async () => finalizeResult({ installed: [], no_safe_match: [], retry_later: [] }),
      })
      const runTask = makeFindSubtitleWorker({
        model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10, timeoutMs: 42_000,
      })
      const task = baseTask(mediaRoot, makeTargets(12, mediaRoot), { jobId: 'job-timeout-override' })

      await runTask(task)

      expect(capturedMs).toEqual([42_000])
    } finally {
      spy.mockRestore()
    }
  })
})
