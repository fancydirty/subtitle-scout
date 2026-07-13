// Offline eval harness for the find-subtitle worker across five task shapes (新片/在更剧/老片/
// 老剧/乱排布). What this proves, and what it deliberately does NOT prove: it proves the
// worker's PLUMBING (every tool wired correctly, the sandbox holds, Output.object produces the
// right decision shape) across five differently-shaped tasks, using a fully deterministic
// scripted mock model. It does NOT evaluate a real reasoning model's actual judgment quality —
// that is what the manual live acceptance procedure (Task 7) is for. Conflating "the scaffolding
// works" with "the model judges correctly" would misrepresent what an offline, mock-model test
// can ever show.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../cli/fetchLib.js'
import type { SubtitleCandidate } from '../core/schemas.js'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'

interface EvalFixture {
  name: string
  jobId: string
  task: Omit<FindSubtitleTask, 'jobId' | 'mediaRoot' | 'videoPath'>
  candidates: SubtitleCandidate[]
  chosenCandidate: { provider: string; providerId: string; fileIndex: number | null } | null
  downloadedSrt: string | null
  expected: { decision: 'installed' | 'no_safe_match' | 'retry_later'; installedFilename: string | null }
}

function loadFixture(scenario: string): EvalFixture {
  return JSON.parse(readFileSync(`fixtures/v3-find-subtitle/${scenario}/fixture.json`, 'utf8'))
}

function findToolResultValue(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content as any[]) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') {
        return part.output.value
      }
    }
  }
  return undefined
}

function toolCallStep(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}
function finalStep(output: unknown) {
  return {
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: undefined, reasoning: undefined } },
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    warnings: [],
  }
}

/** Generic scripted driver: search → (download → install)? → final, parameterized entirely by
 *  fixture data. See the module header note above — this proves plumbing, not judgment. */
function scriptFixture(fixture: EvalFixture) {
  let call = 0
  return async (options: LanguageModelV4CallOptions) => {
    call++
    if (call === 1) return toolCallStep('c1', 'search_source', { queries: [fixture.task.title] })
    if (fixture.chosenCandidate == null) {
      return finalStep({
        decision: fixture.expected.decision, reason: `no plausible candidate for ${fixture.name}`,
        installedPath: null, installedLanguage: null, candidateProvider: null, candidateProviderId: null,
      })
    }
    if (call === 2) return toolCallStep('c2', 'download_candidate', fixture.chosenCandidate)
    if (call === 3) {
      const downloaded = findToolResultValue(options.prompt, 'download_candidate')
      return toolCallStep('c3', 'install_subtitle', { stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hans' })
    }
    const installed = findToolResultValue(options.prompt, 'install_subtitle')
    return finalStep({
      decision: 'installed', reason: `${fixture.name}: metadata + structural signals match`,
      installedPath: installed.path, installedLanguage: 'zh-Hans',
      candidateProvider: fixture.chosenCandidate!.provider, candidateProviderId: fixture.chosenCandidate!.providerId,
    })
  }
}

describe.each(['new-release', 'ongoing-series', 'old-movie', 'old-series', 'messy-layout'])(
  'find-subtitle worker offline eval: %s',
  (scenario) => {
    let root: string
    beforeEach(() => { root = mkdtempSync(join(tmpdir(), `scout-eval-${scenario}-`)) })
    afterEach(() => { rmSync(root, { recursive: true, force: true }) })

    it('matches the recorded expected decision', async () => {
      const fixture = loadFixture(scenario)
      const mediaRoot = join(root, 'media')
      const showDir = join(mediaRoot, 'Show')
      mkdirSync(showDir, { recursive: true })
      const videoPath = join(showDir, fixture.task.videoFilename)

      // Deviation from the plan's literal test snippet, a genuine bug found while implementing
      // (PLAN-BUG DISCIPLINE): the plan hardcoded `name: 'assrt'` on this fake adapter for every
      // fixture, but runResolve() looks up the adapter by `adapters.find(a => a.name ===
      // ref.provider)` (src/cli/fetchLib.ts) — the ongoing-series fixture's chosenCandidate names
      // provider 'zimuku' and old-movie's names 'opensubtitles', so a hardcoded 'assrt' adapter
      // would make download_candidate throw "no adapter for provider zimuku/opensubtitles" for
      // those two fixtures. The adapter's name must track whichever provider this fixture's
      // chosenCandidate actually names (falling back to 'assrt' for the two fixtures with no
      // chosenCandidate, where resolve() is never called at all).
      const adapter: FetchAdapter = {
        name: fixture.chosenCandidate?.provider ?? 'assrt', enabled: () => true,
        search: async () => fixture.candidates,
        resolve: async () => ({ url: 'http://file0.assrt.net/x.srt', filename: fixture.task.videoFilename.replace(/\.mkv$/, '.srt') }),
      }
      const fetchImpl = async () => new Response(Buffer.from(fixture.downloadedSrt ?? ''))

      const model = new MockLanguageModelV4({ doGenerate: scriptFixture(fixture) })
      const runTask = makeFindSubtitleWorker({
        model, adapters: [adapter], cacheRoot: join(root, 'cache'),
        fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
      })

      const task: FindSubtitleTask = { ...fixture.task, jobId: fixture.jobId, mediaRoot, videoPath }
      const decision = await runTask(task)

      expect(decision.decision).toBe(fixture.expected.decision)
      if (fixture.expected.installedFilename) {
        expect(decision.installedPath).toBe(join(showDir, fixture.expected.installedFilename))
        expect(existsSync(decision.installedPath!)).toBe(true)
      } else {
        expect(decision.installedPath).toBeNull()
      }
    })
  },
)
