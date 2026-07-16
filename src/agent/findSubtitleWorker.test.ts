import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../cli/fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'
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
      { itemId: 'ep-1', videoPath, videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null },
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
      { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null },
      { itemId: 'ep-2', videoPath: join(root, 'elsewhere', 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv', season: 1, episode: 2, absoluteEpisode: null },
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
      { itemId: 'ep-1', videoPath, videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: null },
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
      { itemId: 'ep-1', videoPath: join(mediaRoot, 'Show', 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv', season: 1, episode: 1, absoluteEpisode: 1 },
      { itemId: 'ep-2', videoPath: join(mediaRoot, 'Show', 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv', season: 1, episode: 2, absoluteEpisode: 2 },
      { itemId: 'movie-1', videoPath: join(mediaRoot, 'Show', 'Movie.mkv'), videoFilename: 'Movie.mkv', season: null, episode: null, absoluteEpisode: null },
    ], { jobId: 'job-4' })

    await runTask(task)

    expect(capturedPromptText).toContain('targets (3 item(s), current gaps in this scope):')
    expect(capturedPromptText).toContain('- itemId: ep-1 | S1E1 | absolute episode: 1 | file: Show.S01E01.mkv')
    expect(capturedPromptText).toContain('- itemId: ep-2 | S1E2 | absolute episode: 2 | file: Show.S01E02.mkv')
    expect(capturedPromptText).toContain('- itemId: movie-1 | (movie) | file: Movie.mkv')
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
      { itemId: 'ep-2', videoPath: join(mediaRoot, 'Show', 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv', season: 1, episode: 2, absoluteEpisode: null },
      { itemId: 'ep-3', videoPath: join(mediaRoot, 'Show', 'Show.S01E03.mkv'), videoFilename: 'Show.S01E03.mkv', season: 1, episode: 3, absoluteEpisode: null },
    ], { jobId: 'job-5' })

    const report = await runTask(task)

    expect(report.installed).toEqual([])
    expect(report.no_safe_match).toEqual([{ itemId: 'ep-2', reason: 'no plausible candidate' }])
    expect(report.retry_later).toEqual([{ itemId: 'ep-3', reason: 'provider timed out' }])
  })
})

describe('timeout scaling by target count (BATCH_BASE_TIMEOUT_MS / PER_TARGET_TIMEOUT_MS / BATCH_TIMEOUT_CAP_MS)', () => {
  function makeTargets(n: number, mediaRoot: string): FindSubtitleTargetFact[] {
    return Array.from({ length: n }, (_, i) => ({
      itemId: `ep-${i + 1}`,
      videoPath: join(mediaRoot, 'Show', `Show.S01E${String(i + 1).padStart(2, '0')}.mkv`),
      videoFilename: `Show.S01E${String(i + 1).padStart(2, '0')}.mkv`,
      season: 1, episode: i + 1, absoluteEpisode: null,
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
