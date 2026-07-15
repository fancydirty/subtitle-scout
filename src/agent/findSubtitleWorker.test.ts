import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../cli/fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'

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
 *  tool_call to `finalize` whose arguments ARE the FindSubtitleDecision. This is what the model
 *  actually does now (finalize-tool mode, not an Output.object text blob) — the whole reason the
 *  offline mock could not catch the live AI_NoObjectGeneratedError. hasToolCall('finalize') stops
 *  the loop here; readFinalized() returns these args as the decision. */
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
          decision: 'installed', reason: 'release name and cue count match S01E01',
          installedPath: installed.path, installedLanguage: 'zh-Hans',
          candidateProvider: 'assrt', candidateProviderId: '1',
        })
      },
    })

    const fetchImpl = async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n'))

    const runTask = makeFindSubtitleWorker({
      model, adapters: [fakeAdapter()], cacheRoot: join(root, 'cache'),
      fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
    })

    const task: FindSubtitleTask = {
      jobId: 'job-1', mediaRoot, videoPath, videoFilename: 'Show.S01E01.mkv',
      title: 'Show', originalTitle: null, year: 2024, season: 1, episode: 1, absoluteEpisode: null,
      alternativeTitles: [], overview: null, runtimeMinutes: 24, providerIds: {}, targetLanguage: 'zh',
    }

    const decision = await runTask(task)

    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(mediaRoot, 'Show', 'Show.S01E01.zh-Hans.srt'))
    expect(existsSync(decision.installedPath!)).toBe(true)
    expect(readFileSync(decision.installedPath!, 'utf8')).toContain('hello')
    // sandbox cleanup: the staging dir under mediaRoot/.subtitle-staging/job-1 is gone after the run
    expect(existsSync(join(mediaRoot, '.subtitle-staging', 'job-1'))).toBe(false)
  })

  it('rejects a task whose videoPath escapes its own mediaRoot before ever calling the model', async () => {
    const mediaRoot = join(root, 'media')
    mkdirSync(mediaRoot, { recursive: true })
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('model should never be called') } })
    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache') })
    const task: FindSubtitleTask = {
      jobId: 'job-2', mediaRoot, videoPath: join(root, 'elsewhere', 'Show.S01E01.mkv'),
      videoFilename: 'Show.S01E01.mkv', title: 'Show', originalTitle: null, year: null,
      season: 1, episode: 1, absoluteEpisode: null, alternativeTitles: [], overview: null, runtimeMinutes: null,
      providerIds: {}, targetLanguage: 'zh',
    }
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
        return {
          finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: undefined, reasoning: undefined },
          },
          content: [{
            type: 'tool-call' as const, toolCallId: 'finalize-1', toolName: 'finalize',
            input: JSON.stringify({ decision: 'no_safe_match', reason: 'nothing plausible' }),
          }],
          warnings: [],
        }
      },
    })

    const runTask = makeFindSubtitleWorker({ model, adapters: [], cacheRoot: join(root, 'cache'), stepCap: 10 })
    const task: FindSubtitleTask = {
      jobId: 'job-3', mediaRoot, videoPath, videoFilename: 'Show.S01E01.mkv',
      title: 'Show', originalTitle: null, year: 2024, season: 1, episode: 1, absoluteEpisode: null,
      alternativeTitles: [], overview: null, runtimeMinutes: 24, providerIds: {}, targetLanguage: 'en',
    }

    await runTask(task)

    // Both the header sentence and the field line carry the target language — and no trace of
    // the pre-parameterization hardcoded 'Chinese' may remain anywhere in the prompt template.
    expect(capturedPromptText).toContain('Find and install a subtitle in English')
    expect(capturedPromptText).toContain('target subtitle language: English')
    expect(capturedPromptText).not.toContain('Chinese')
  })
})
