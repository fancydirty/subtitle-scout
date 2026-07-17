// Offline eval harness for the find-subtitle worker across five task shapes (新片/在更剧/老片/
// 老剧/乱排布) plus a batch (multi-target) scenario. What this proves, and what it deliberately
// does NOT prove: it proves the worker's PLUMBING (every tool wired correctly, the sandbox holds,
// the finalize tool produces the right batch-report shape) across differently-shaped tasks, using
// a fully deterministic scripted mock model. It does NOT evaluate a real reasoning model's actual
// judgment quality — that is what the manual live acceptance procedure (Task 7) is for. Conflating
// "the scaffolding works" with "the model judges correctly" would misrepresent what an offline,
// mock-model test can ever show.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import type { FetchAdapter } from '../cli/fetchLib.js'
import { candidateKey, type SubtitleCandidate } from '../core/schemas.js'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import type { FindSubtitleTask, FindSubtitleTargetFact } from './findSubtitleWorker.schemas.js'

/** The flat, single-episode task-fact shape every fixture.json on disk still carries (predates
 *  the glue-layer repair's batch FindSubtitleTask). Each fixture becomes a single-target batch
 *  task below (buildTask) — the fixtures themselves are data, not part of this task's file set,
 *  so they are read as-is rather than reshaped on disk. */
interface EvalFixtureTaskFacts {
  videoFilename: string
  title: string
  originalTitle: string | null
  year: number | null
  season: number | null
  episode: number | null
  absoluteEpisode: number | null
  alternativeTitles: string[]
  overview: string | null
  runtimeMinutes: number | null
  providerIds: Record<string, string>
  targetLanguage?: string
}

interface EvalFixture {
  name: string
  jobId: string
  task: EvalFixtureTaskFacts
  candidates: SubtitleCandidate[]
  chosenCandidate: { provider: string; providerId: string; fileIndex: number | null } | null
  downloadedSrt: string | null
  expected: { decision: 'installed' | 'no_safe_match' | 'retry_later'; installedFilename: string | null }
}

function loadFixture(scenario: string): EvalFixture {
  const fixture = JSON.parse(readFileSync(`fixtures/v3-find-subtitle/${scenario}/fixture.json`, 'utf8')) as EvalFixture
  // Seam default: fixture.json predates FindSubtitleTask.targetLanguage — same seam-default
  // rationale as liveMatrix.ts's loadCell (the JSON cast hides the absent field from tsc).
  if (fixture.task.targetLanguage == null) fixture.task.targetLanguage = 'zh'
  return fixture
}

/** Builds a single-target batch FindSubtitleTask out of one fixture's flat task-fact shape —
 *  itemId defaults to the fixture's jobId (there is exactly one target per on-disk fixture). */
function buildTask(fixture: EvalFixture, mediaRoot: string, videoPath: string): FindSubtitleTask {
  const t = fixture.task
  return {
    jobId: fixture.jobId, mediaRoot, title: t.title, originalTitle: t.originalTitle, year: t.year,
    alternativeTitles: t.alternativeTitles, overview: t.overview, runtimeMinutes: t.runtimeMinutes,
    providerIds: t.providerIds, targetLanguage: t.targetLanguage ?? 'zh',
    targets: [{
      itemId: fixture.jobId, videoPath, videoFilename: t.videoFilename,
      season: t.season, episode: t.episode, absoluteEpisode: t.absoluteEpisode, imdbId: null,
    }],
  }
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

/** Same as findToolResultValue but returns the LATEST matching tool-result in the history —
 *  needed once a batch task has called the SAME tool (e.g. download_candidate/install_subtitle)
 *  more than once for different targets, where the first match is stale. */
function findLatestToolResultValue(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role !== 'tool') continue
    for (const part of msg.content as any[]) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') {
        return part.output.value
      }
    }
  }
  throw new Error(`no tool-result for ${toolName} found in prompt history`)
}

function toolCallStep(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}
/** Terminal step: a NATIVE tool_call to `finalize` carrying the batch report as its args — what
 *  the real model does under finalize-tool mode (not an Output.object text blob). hasToolCall
 *  stops the loop here; readFinalized() surfaces these args as the report. */
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
 *  no-candidate finalize OMITS the installed/other-unresolved buckets entirely (only the one
 *  bucket matching fixture.expected.decision is sent) rather than sending them as null/"None"/[] —
 *  proven live (v3 live test matrix, 2026-07-13, 3/3 real runs) for the equivalent single-decision
 *  fields, and the batch report's tolerantArray (coerce.ts) folds an omitted bucket key to [].
 *  Feeding clean typed args, or even the "None"-string shape this mock used before, is exactly
 *  what let param-flow bugs (this one included — see coerce.ts's isNullishOrOmitted) hide from the
 *  offline suite: the finalize tool's inputSchema failed on the omitted keys, execute() never ran,
 *  and readFinalized() threw a misleading "never called finalize" error. */
function scriptFixture(fixture: EvalFixture) {
  let call = 0
  return async (options: LanguageModelV4CallOptions) => {
    call++
    if (call === 1) return toolCallStep('c1', 'search_source', { queries: [fixture.task.title] })
    if (fixture.chosenCandidate == null) {
      return finalStep({
        [fixture.expected.decision]: [{ itemId: fixture.jobId, reason: `no plausible candidate for ${fixture.name}` }],
        // the OTHER two buckets: OMITTED, not null/"None"/[] — real-model arg shape.
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
      installed: [{
        itemId: fixture.jobId, reason: `${fixture.name}: metadata + structural signals match`,
        installedPath: installed.path, installedLanguage: 'zh-Hans',
        candidateProvider: fixture.chosenCandidate!.provider, candidateProviderId: fixture.chosenCandidate!.providerId,
      }],
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
        installed: [{
          itemId: fixture.jobId, reason: 'season pack: picked the target episode out of the filelist by fileIndex',
          installedPath: installed.path, installedLanguage: 'zh-Hant',
          candidateProvider: pack.provider, candidateProviderId: pack.providerId,
        }],
      })
    }

    const model = new MockLanguageModelV4({ doGenerate })
    const runTask = makeFindSubtitleWorker({
      model, adapters: [adapter], cacheRoot: join(root, 'cache'),
      fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
    })

    const task = buildTask(fixture, mediaRoot, videoPath)
    const report = await runTask(task)

    expect(fileListVisibleToModel).toBe(true)          // the agent could SEE the pack's filelist
    expect(resolvedFileIndex).toBe(targetIndex)        // the chosen fileIndex flowed through to resolve
    expect(report.installed).toHaveLength(1)
    expect(report.installed[0].itemId).toBe(fixture.jobId)
    expect(report.installed[0].installedPath).toBe(join(showDir, fixture.expected.installedFilename!))
    expect(existsSync(report.installed[0].installedPath)).toBe(true)
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

      const task = buildTask(fixture, mediaRoot, videoPath)
      const report = await runTask(task)

      const bucket = report[fixture.expected.decision]
      expect(bucket).toHaveLength(1)
      expect(bucket[0].itemId).toBe(fixture.jobId)
      for (const key of ['installed', 'no_safe_match', 'retry_later'] as const) {
        if (key !== fixture.expected.decision) expect(report[key]).toEqual([])
      }
      if (fixture.expected.installedFilename) {
        const installedPath = (bucket[0] as { installedPath: string }).installedPath
        expect(installedPath).toBe(join(showDir, fixture.expected.installedFilename))
        expect(existsSync(installedPath)).toBe(true)
      }
    })
  },
)

// Batch (multi-target): the glue-layer repair's whole point — one worker run now covers every
// completable target in its scope, not one episode per run. This is deliberately NOT
// fixture-driven (no on-disk fixture predates the batch task shape): it directly builds a
// 2-target task sharing one season-pack candidate that covers both, and locks the semantics that
// must survive the batch rewrite — finalize is still called EXACTLY ONCE (for the whole batch,
// not once per target), and staging cleanup still runs in `finally` regardless of how many
// targets were installed.
describe('find-subtitle worker offline eval: batch (multi-target within one series/scope)', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-eval-batch-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('covers two targets from the same season pack in one run and reports both as installed, calling finalize exactly once', async () => {
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Show')
    mkdirSync(showDir, { recursive: true })

    const target1: FindSubtitleTargetFact = {
      itemId: 'ep-1', videoPath: join(showDir, 'Show.S01E01.mkv'), videoFilename: 'Show.S01E01.mkv',
      season: 1, episode: 1, absoluteEpisode: 1, imdbId: null,
    }
    const target2: FindSubtitleTargetFact = {
      itemId: 'ep-2', videoPath: join(showDir, 'Show.S01E02.mkv'), videoFilename: 'Show.S01E02.mkv',
      season: 1, episode: 2, absoluteEpisode: 2, imdbId: null,
    }

    const pack: SubtitleCandidate = {
      provider: 'assrt', providerId: 'pack-batch', videoName: 'Show S01 合集', nativeName: null,
      language: 'zh-CN', subtype: null, releaseSite: null, uploadDate: null,
      fileList: [
        { index: 0, name: 'Show.S01E01.srt' },
        { index: 1, name: 'Show.S01E02.srt' },
      ],
    }

    const adapter: FetchAdapter = {
      name: 'assrt', enabled: () => true,
      search: async () => [pack],
      resolve: async (ref) => {
        const entry = ref.fileIndex != null ? pack.fileList[ref.fileIndex] : undefined
        if (!entry) throw new Error('batch pack resolve requires a fileIndex naming a filelist entry')
        return { url: `http://file0.assrt.net/${entry.index}.srt`, filename: entry.name }
      },
    }
    const fetchImpl = async () => new Response(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n'))

    let call = 0
    let finalizeCalls = 0
    let installedPath1: string | undefined
    const doGenerate = async (options: LanguageModelV4CallOptions) => {
      call++
      if (call === 1) return toolCallStep('c1', 'search_source', { queries: ['Show'] })
      if (call === 2) {
        return toolCallStep('c2', 'download_candidate', {
          candidateId: candidateKey(pack), fileIndex: '0', videoFilename: target1.videoFilename,
        })
      }
      if (call === 3) {
        const downloaded = findLatestToolResultValue(options.prompt, 'download_candidate')
        return toolCallStep('c3', 'install_subtitle', {
          stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hans', videoFilename: target1.videoFilename,
        })
      }
      if (call === 4) {
        installedPath1 = findLatestToolResultValue(options.prompt, 'install_subtitle').path
        return toolCallStep('c4', 'download_candidate', {
          candidateId: candidateKey(pack), fileIndex: '1', videoFilename: target2.videoFilename,
        })
      }
      if (call === 5) {
        const downloaded = findLatestToolResultValue(options.prompt, 'download_candidate')
        return toolCallStep('c5', 'install_subtitle', {
          stagedFileId: downloaded.stagedFileId, langTag: 'zh-Hans', videoFilename: target2.videoFilename,
        })
      }
      // Terminal step — this must be reached EXACTLY once (call === 6): the loop stops the
      // instant finalize is called (hasToolCall), so a second finalize call would mean the
      // scripted flow above did not actually terminate the loop.
      finalizeCalls++
      const installedPath2 = findLatestToolResultValue(options.prompt, 'install_subtitle').path
      return finalStep({
        installed: [
          {
            itemId: target1.itemId, reason: 'batch: episode 1 out of the shared season pack',
            installedPath: installedPath1, installedLanguage: 'zh-Hans',
            candidateProvider: pack.provider, candidateProviderId: pack.providerId,
          },
          {
            itemId: target2.itemId, reason: 'batch: episode 2 out of the shared season pack',
            installedPath: installedPath2, installedLanguage: 'zh-Hans',
            candidateProvider: pack.provider, candidateProviderId: pack.providerId,
          },
        ],
        no_safe_match: [], retry_later: [],
      })
    }

    const model = new MockLanguageModelV4({ doGenerate })
    const runTask = makeFindSubtitleWorker({
      model, adapters: [adapter], cacheRoot: join(root, 'cache'),
      fetchImpl: fetchImpl as unknown as typeof fetch, stepCap: 10,
    })

    const task: FindSubtitleTask = {
      jobId: 'eval-batch', mediaRoot, title: 'Show', originalTitle: null, year: 2024,
      alternativeTitles: [], overview: null, runtimeMinutes: 24, providerIds: {}, targetLanguage: 'zh',
      targets: [target1, target2],
    }
    const report = await runTask(task)

    // Semantic lock: finalize called exactly once for the WHOLE batch, not once per target.
    expect(finalizeCalls).toBe(1)
    expect(report.installed).toHaveLength(2)
    expect(report.installed.map(i => i.itemId).sort()).toEqual(['ep-1', 'ep-2'])

    const byItemId = Object.fromEntries(report.installed.map(i => [i.itemId, i]))
    expect(byItemId['ep-1'].installedPath).toBe(join(showDir, 'Show.S01E01.zh-Hans.srt'))
    expect(byItemId['ep-2'].installedPath).toBe(join(showDir, 'Show.S01E02.zh-Hans.srt'))
    expect(existsSync(byItemId['ep-1'].installedPath)).toBe(true)
    expect(existsSync(byItemId['ep-2'].installedPath)).toBe(true)

    // Semantic lock: staging cleanup runs in `finally` — the staging dir is gone after the run
    // regardless of how many targets it covered.
    expect(existsSync(join(mediaRoot, '.subtitle-staging', 'eval-batch'))).toBe(false)
  })
})
