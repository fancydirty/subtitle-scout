// Deterministic integration: REAL assrt adapter + REAL AssrtClient over a REPLAY fetch of the
// cell's recorded raw responses, driven by a SCRIPTED mock model. Proves the recorded responses
// parse through the real provider path and the pack's fileIndex flows end-to-end to an installed
// file. It does NOT evaluate model judgment — that is scripts/run-live-matrix.ts (real model).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { AssrtClient, MinIntervalLimiter } from '../adapters/providers/assrt.js'
import { makeAssrtAdapter } from '../cli/adapters/assrtAdapter.js'
import { makeFindSubtitleWorker } from '../agent/findSubtitleWorker.js'
import type { FindSubtitleTask } from '../agent/findSubtitleWorker.schemas.js'
import { makeReplayFetch } from './replayFetch.js'
import { loadCell } from './liveMatrix.js'

function toolResult(prompt: LanguageModelV4Prompt, toolName: string): any {
  for (const msg of prompt) {
    if (msg.role !== 'tool') continue
    for (const part of msg.content as any[]) {
      if (part.type === 'tool-result' && part.toolName === toolName && part.output.type === 'json') return part.output.value
    }
  }
  return undefined
}
function step(id: string, name: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: { inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: undefined, reasoning: undefined } },
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
    warnings: [],
  }
}

describe('find-subtitle worker replay integration: anime/only-pack', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-replay-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('installs S01E01 from the recorded complete-series pack via the real assrt adapter', async () => {
    const cell = loadCell('anime', 'only-pack')
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Attack on Titan')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, cell.task.videoFilename)

    const replay = makeReplayFetch(cell.responsesDir)
    // Real client: replay fetch + zero-interval limiter (no 15s waits) + throwaway cache dir.
    const client = new AssrtClient({
      token: 'replay', cacheDir: join(root, 'assrt-cache'),
      fetchImpl: replay, limiter: new MinIntervalLimiter(0),
    })
    const adapters = [makeAssrtAdapter(client)]

    // Scripted mock, emitting args the way real mimo-v2.5 does (composite candidateKey id,
    // STRING-encoded fileIndex) — the exact shapes that hid the param-flow bugs pre-live-trace.
    let call = 0
    const doGenerate = async (options: LanguageModelV4CallOptions) => {
      call++
      if (call === 1) return step('c1', 'search_source', { queries: [cell.task.title, cell.task.originalTitle] })
      if (call === 2) {
        const searched = toolResult(options.prompt, 'search_source')
        return step('c2', 'get_candidate', { result_set_id: searched.result_set_id, index: 0, detail: 'detailed' })
      }
      if (call === 3) {
        const got = toolResult(options.prompt, 'get_candidate')
        const entry = (got.fileList as { index: number; name: string }[]).find(f => /S01E01/i.test(f.name))!
        return step('c3', 'download_candidate', { candidateId: `assrt:${cell.expected.candidateProviderId}`, fileIndex: String(entry.index) })
      }
      if (call === 4) {
        const dl = toolResult(options.prompt, 'download_candidate')
        return step('c4', 'install_subtitle', { stagedFileId: dl.stagedFileId, langTag: cell.expected.installedLanguage })
      }
      const installed = toolResult(options.prompt, 'install_subtitle')
      return step('finalize-1', 'finalize', {
        decision: 'installed', reason: 'picked S01E01 out of the recorded pack filelist',
        installedPath: installed.path, installedLanguage: cell.expected.installedLanguage,
        candidateProvider: cell.expected.candidateProvider, candidateProviderId: cell.expected.candidateProviderId,
      })
    }

    const runTask = makeFindSubtitleWorker({
      model: new MockLanguageModelV4({ doGenerate }),
      adapters, cacheRoot: join(root, 'cache'),
      fetchImpl: replay, stepCap: 12,   // worker's OWN download fetch also replays
    })

    const task: FindSubtitleTask = { ...cell.task, jobId: 'replay-anime-only-pack', mediaRoot, videoPath }
    const decision = await runTask(task)

    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(showDir, cell.expected.installedFilename!))
    expect(existsSync(decision.installedPath!)).toBe(true)
    expect(decision.candidateProviderId).toBe(cell.expected.candidateProviderId)
    // The installed filename derives from the VIDEO basename + langTag, so a wrong fileIndex would
    // still produce the identical name — only content equality pins the right episode's bytes.
    const downloadFixture = JSON.parse(readFileSync(join(cell.responsesDir, 'download.json'), 'utf8'))
    expect(readFileSync(decision.installedPath!, 'utf8'))
      .toBe(Buffer.from(downloadFixture.bodyBase64, 'base64').toString('utf8'))
  })
})

describe('find-subtitle worker replay integration: cdrama/multi-version', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-replay-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('installs S01E01 from the 简 (zh-Hans) season pack, one of two separate 简/繁 candidates', async () => {
    const cell = loadCell('cdrama', 'multi-version')
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'F4 Thailand Boys Over Flowers (2021)')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, cell.task.videoFilename)

    const replay = makeReplayFetch(cell.responsesDir)
    const client = new AssrtClient({
      token: 'replay', cacheDir: join(root, 'assrt-cache'),
      fetchImpl: replay, limiter: new MinIntervalLimiter(0),
    })
    const adapters = [makeAssrtAdapter(client)]

    // Unlike the anime/multi-version cell (three single-file candidates), here 简 and 繁 are each
    // their own SEASON PACK (assrt:713168 简, assrt:713167 繁) recorded via search q="F4 Thailand",
    // which returns 简 at index 0 — the scripted mock picks that one. Each pack's filelist mixes
    // real entries with macOS "._" resource-fork sidecars that ALSO substring-match "S01E01", so
    // the match must skip "._"-prefixed junk, not just grep the episode code.
    let call = 0
    const doGenerate = async (options: LanguageModelV4CallOptions) => {
      call++
      if (call === 1) return step('c1', 'search_source', { queries: [cell.task.title, cell.task.originalTitle] })
      if (call === 2) {
        const searched = toolResult(options.prompt, 'search_source')
        return step('c2', 'get_candidate', { result_set_id: searched.result_set_id, index: 0, detail: 'detailed' })
      }
      if (call === 3) {
        const got = toolResult(options.prompt, 'get_candidate')
        const entry = (got.fileList as { index: number; name: string }[])
          .find(f => /S01E01/i.test(f.name) && !f.name.startsWith('._'))!
        return step('c3', 'download_candidate', { candidateId: `assrt:${cell.expected.candidateProviderId}`, fileIndex: String(entry.index) })
      }
      if (call === 4) {
        const dl = toolResult(options.prompt, 'download_candidate')
        return step('c4', 'install_subtitle', { stagedFileId: dl.stagedFileId, langTag: 'zh-Hans' })
      }
      const installed = toolResult(options.prompt, 'install_subtitle')
      return step('finalize-1', 'finalize', {
        decision: 'installed', reason: 'picked the 简 (Simplified) season pack, S01E01 by filename match',
        installedPath: installed.path, installedLanguage: 'zh-Hans',
        candidateProvider: cell.expected.candidateProvider, candidateProviderId: cell.expected.candidateProviderId,
      })
    }

    const runTask = makeFindSubtitleWorker({
      model: new MockLanguageModelV4({ doGenerate }),
      adapters, cacheRoot: join(root, 'cache'),
      fetchImpl: replay, stepCap: 12,
    })

    const task: FindSubtitleTask = { ...cell.task, jobId: 'replay-cdrama-multi-version', mediaRoot, videoPath }
    const decision = await runTask(task)

    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(showDir, cell.expected.installedFilename!))
    expect(existsSync(decision.installedPath!)).toBe(true)
    expect(decision.candidateProviderId).toBe(cell.expected.candidateProviderId)
    expect(decision.installedLanguage).toBe('zh-Hans')
    const downloadFixture = JSON.parse(readFileSync(join(cell.responsesDir, 'download-zh-hans.json'), 'utf8'))
    expect(readFileSync(decision.installedPath!, 'utf8'))
      .toBe(Buffer.from(downloadFixture.bodyBase64, 'base64').toString('utf8'))
  })
})

describe('find-subtitle worker replay integration: cdrama/only-pack', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-replay-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('installs episode 1 from the recorded 西游记(1986) complete-series pack via the real assrt adapter', async () => {
    const cell = loadCell('cdrama', 'only-pack')
    const mediaRoot = join(root, 'media')
    const showDir = join(mediaRoot, 'Journey to the West (1986)')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, cell.task.videoFilename)

    const replay = makeReplayFetch(cell.responsesDir)
    const client = new AssrtClient({
      token: 'replay', cacheDir: join(root, 'assrt-cache'),
      fetchImpl: replay, limiter: new MinIntervalLimiter(0),
    })
    const adapters = [makeAssrtAdapter(client)]

    // Same scripted-mock shape as the anime/only-pack anchor test, but the pack here is numbered
    // by plain "01.ass".."26.ass" (no SxxEyy substring at all) — matched by a leading "01." regex
    // instead of an episode-code substring, proving the plumbing does not assume SxxEyy naming.
    let call = 0
    const doGenerate = async (options: LanguageModelV4CallOptions) => {
      call++
      if (call === 1) return step('c1', 'search_source', { queries: [cell.task.title, cell.task.originalTitle] })
      if (call === 2) {
        const searched = toolResult(options.prompt, 'search_source')
        return step('c2', 'get_candidate', { result_set_id: searched.result_set_id, index: 0, detail: 'detailed' })
      }
      if (call === 3) {
        const got = toolResult(options.prompt, 'get_candidate')
        const entry = (got.fileList as { index: number; name: string }[]).find(f => /^01\.ass$/i.test(f.name))!
        return step('c3', 'download_candidate', { candidateId: `assrt:${cell.expected.candidateProviderId}`, fileIndex: String(entry.index) })
      }
      if (call === 4) {
        const dl = toolResult(options.prompt, 'download_candidate')
        return step('c4', 'install_subtitle', { stagedFileId: dl.stagedFileId, langTag: cell.expected.installedLanguage })
      }
      const installed = toolResult(options.prompt, 'install_subtitle')
      return step('finalize-1', 'finalize', {
        decision: 'installed', reason: 'picked episode 1 (01.ass) out of the recorded whole-series pack filelist',
        installedPath: installed.path, installedLanguage: cell.expected.installedLanguage,
        candidateProvider: cell.expected.candidateProvider, candidateProviderId: cell.expected.candidateProviderId,
      })
    }

    const runTask = makeFindSubtitleWorker({
      model: new MockLanguageModelV4({ doGenerate }),
      adapters, cacheRoot: join(root, 'cache'),
      fetchImpl: replay, stepCap: 12,
    })

    const task: FindSubtitleTask = { ...cell.task, jobId: 'replay-cdrama-only-pack', mediaRoot, videoPath }
    const decision = await runTask(task)

    expect(decision.decision).toBe('installed')
    expect(decision.installedPath).toBe(join(showDir, cell.expected.installedFilename!))
    expect(existsSync(decision.installedPath!)).toBe(true)
    expect(decision.candidateProviderId).toBe(cell.expected.candidateProviderId)
    // installedFilename is derived from the video basename + langTag, not the source extension of
    // the ACTUAL downloaded file — so this also pins that .ass (not .srt) survived writeSubtitle's
    // extension-preserving path (src/files/subtitleWriter.ts's SUBTITLE_EXTS includes .ass/.ssa).
    expect(decision.installedPath).toMatch(/\.ass$/)
    const downloadFixture = JSON.parse(readFileSync(join(cell.responsesDir, 'download.json'), 'utf8'))
    expect(readFileSync(decision.installedPath!, 'utf8'))
      .toBe(Buffer.from(downloadFixture.bodyBase64, 'base64').toString('utf8'))
  })
})
