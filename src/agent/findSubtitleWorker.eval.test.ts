// Offline eval harness for the find-subtitle worker across five task shapes (新片/在更剧/老片/
// 老剧/乱排布). What this proves, and what it deliberately does NOT prove: it proves the
// worker's PLUMBING (every tool wired correctly, the sandbox holds, the finalize tool produces
// the right decision shape) across five differently-shaped tasks, using a fully deterministic
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
import { candidateKey, type SubtitleCandidate } from '../core/schemas.js'
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
/** Terminal step: a NATIVE tool_call to `finalize` carrying the decision as its args — what the
 *  real model does under finalize-tool mode (not an Output.object text blob). hasToolCall stops
 *  the loop here; readFinalized() surfaces these args as the decision. */
function finalStep(output: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId: 'finalize-1', toolName: 'finalize', input: JSON.stringify(output) }],
    warnings: [],
  }
}

/** Generic scripted driver: search → (download → install)? → final, parameterized entirely by
 *  fixture data. See the module header note above — this proves plumbing, not judgment.
 *
 *  Args are shaped the way the REAL model (mimo-v2.5, per live step-trace) emits them, NOT clean
 *  typed args: download_candidate gets the COMPOSITE candidateKey `id` the agent is shown (e.g.
 *  "assrt:1") — never a bare providerId — and a STRING-encoded fileIndex ("None" for null); the
 *  no-candidate finalize emits the string "None" for its null fields. Feeding clean typed args here
 *  is exactly what let the two param-flow bugs hide from the offline suite. */
function scriptFixture(fixture: EvalFixture) {
  let call = 0
  return async (options: LanguageModelV4CallOptions) => {
    call++
    if (call === 1) return toolCallStep('c1', 'search_source', { queries: [fixture.task.title] })
    if (fixture.chosenCandidate == null) {
      return finalStep({
        decision: fixture.expected.decision, reason: `no plausible candidate for ${fixture.name}`,
        installedPath: 'None', installedLanguage: 'None', candidateProvider: 'None', candidateProviderId: 'None',
      })
    }
    if (call === 2) return toolCallStep('c2', 'download_candidate', {
      candidateId: candidateKey(fixture.chosenCandidate),
      fileIndex: fixture.chosenCandidate.fileIndex == null ? 'None' : String(fixture.chosenCandidate.fileIndex),
    })
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

// Season-pack extraction, end-to-end (offline). Distinct from the generic driver above because it
// exercises the pack workflow the live acceptance exposed as missing: Chinese subtitles usually
// arrive as a SEASON PACK / COMPLETE-SERIES collection, and the ONLY viable candidate here is such
// a pack. To succeed, the model must (1) SEE the pack's filelist via get_candidate and (2) download
// the target episode's entry by its fileIndex. This locks in that low-level capability — the pack's
// fileIndex flows through download_candidate → runResolve → the adapter and installs the right file.
// (The behavioral fix that makes a REAL model do this is the skill; a scripted mock can only prove
// the plumbing carries a fileIndex the model picks — see the module header on plumbing vs judgment.)
describe('find-subtitle worker offline eval: season-pack', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-eval-season-pack-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('extracts the target episode from a season pack by fileIndex and installs it', async () => {
    const fixture = loadFixture('season-pack')
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, fixture.task.videoFilename)

    const pack = fixture.candidates[0]
    const targetIndex = fixture.chosenCandidate!.fileIndex!

    // resolve HONORS fileIndex like the real assrt adapter (src/cli/adapters/assrtAdapter.ts): the
    // download URL/filename come from the picked filelist entry. A null/wrong fileIndex would not
    // name the target episode — so this test only passes if the model's pick actually flows through.
    let resolvedFileIndex: number | null | undefined
    const adapter: FetchAdapter = {
      name: pack.provider, enabled: () => true,
      search: async () => fixture.candidates,
      resolve: async (ref) => {
        resolvedFileIndex = ref.fileIndex
        const entry = ref.fileIndex != null ? pack.fileList[ref.fileIndex] : undefined
        if (!entry) throw new Error('season pack resolve requires a fileIndex naming a filelist entry')
        return { url: `http://file0.assrt.net/${entry.index}.srt`, filename: entry.name }
      },
    }
    const fetchImpl = async () => new Response(Buffer.from(fixture.downloadedSrt ?? ''))

    // Scripted: search_source → get_candidate(detailed) → download_candidate(fileIndex) → install → final.
    let call = 0
    let fileListVisibleToModel = false
    const doGenerate = async (options: LanguageModelV4CallOptions) => {
      call++
      if (call === 1) return toolCallStep('c1', 'search_source', { queries: [fixture.task.title] })
      if (call === 2) {
        const searched = findToolResultValue(options.prompt, 'search_source')
        return toolCallStep('c2', 'get_candidate', { result_set_id: searched.result_set_id, index: 0, detail: 'detailed' })
      }
      if (call === 3) {
        // Like a human scanning a zip's contents: the pack's filelist must be visible here, and the
        // model reads the target episode's entry off it to choose the fileIndex to download.
        const got = findToolResultValue(options.prompt, 'get_candidate')
        const entry = (got.fileList as { index: number; name: string }[]).find(f => /S01E01/i.test(f.name))
        fileListVisibleToModel = entry != null
        // Real-model arg shape (the whole point of this fixture post-live-trace): the COMPOSITE
        // candidateKey `id` the agent saw ("assrt:pack-1"), NOT a bare providerId — download_candidate
        // must split it back — and a STRING-encoded fileIndex ("0"), which the coerced schema accepts.
        return toolCallStep('c3', 'download_candidate', { candidateId: candidateKey(pack), fileIndex: String(entry!.index) })
      }
      if (call === 4) {
        const downloaded = findToolResultValue(options.prompt, 'download_candidate')
        return toolCallStep('c4', 'install_subtitle', { stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hant' })
      }
      const installed = findToolResultValue(options.prompt, 'install_subtitle')
      return finalStep({
        decision: 'installed', reason: 'season pack: picked the target episode out of the filelist by fileIndex',
        installedPath: installed.path, installedLanguage: 'zh-Hant',
        candidateProvider: pack.provider, candidateProviderId: pack.providerId,
      })
    }

    const model = new MockLanguageModelV4({ doGenerate })
    const runTask = makeFindSubtitleWorker({
      model, adapters: [adapter], cacheRoot: join(root, 'cache'),
      fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
    })

    const task: FindSubtitleTask = { ...fixture.task, jobId: fixture.jobId, mediaRoot, videoPath }
    const decision = await runTask(task)

    expect(fileListVisibleToModel).toBe(true)          // the agent could SEE the pack's filelist
    expect(resolvedFileIndex).toBe(targetIndex)        // the chosen fileIndex flowed through to resolve
    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(showDir, fixture.expected.installedFilename!))
    expect(existsSync(decision.installedPath!)).toBe(true)
  })
})

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
