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
import { loadCell, type LoadedCell } from './liveMatrix.js'

/** Builds a single-target batch FindSubtitleTask out of one cell's flat task-fact shape — same
 *  wrapping precedent as buildTask() in findSubtitleWorker.eval.test.ts. itemId defaults to the
 *  cell's own jobId (there is exactly one target per on-disk cell). */
function buildTask(cell: LoadedCell, jobId: string, mediaRoot: string, videoPath: string): FindSubtitleTask {
  const t = cell.task
  return {
    jobId, mediaRoot, title: t.title, originalTitle: t.originalTitle, year: t.year,
    alternativeTitles: t.alternativeTitles, overview: t.overview, runtimeMinutes: t.runtimeMinutes,
    providerIds: t.providerIds, targetLanguage: t.targetLanguage ?? 'zh',
    targets: [{
      itemId: jobId, videoPath, videoFilename: t.videoFilename,
      season: t.season, episode: t.episode, absoluteEpisode: t.absoluteEpisode, imdbId: null,
    }],
  }
}

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
    const jobId = 'replay-anime-only-pack'
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
        installed: [{
          itemId: jobId, reason: 'picked S01E01 out of the recorded pack filelist',
          installedPath: installed.path, installedLanguage: cell.expected.installedLanguage,
          candidateProvider: cell.expected.candidateProvider, candidateProviderId: cell.expected.candidateProviderId,
        }],
      })
    }

    const runTask = makeFindSubtitleWorker({
      model: new MockLanguageModelV4({ doGenerate }),
      adapters, cacheRoot: join(root, 'cache'),
      fetchImpl: replay, stepCap: 12,   // worker's OWN download fetch also replays
    })

    const task = buildTask(cell, jobId, mediaRoot, videoPath)
    const report = await runTask(task)

    expect(report.installed).toHaveLength(1)
    const installed = report.installed[0]
    expect(installed.itemId).toBe(jobId)
    expect(installed.installedPath).toBe(join(showDir, cell.expected.installedFilename!))
    expect(existsSync(installed.installedPath)).toBe(true)
    expect(installed.candidateProviderId).toBe(cell.expected.candidateProviderId)
    // The installed filename derives from the VIDEO basename + langTag, so a wrong fileIndex would
    // still produce the identical name — only content equality pins the right episode's bytes.
    const downloadFixture = JSON.parse(readFileSync(join(cell.responsesDir, 'download.json'), 'utf8'))
    expect(readFileSync(installed.installedPath, 'utf8'))
      .toBe(Buffer.from(downloadFixture.bodyBase64, 'base64').toString('utf8'))
  })
})

// NOTE: cdrama/multi-version and cdrama/only-pack replay tests were removed here — cdrama is
// Chinese-audio content, and this project finds CHINESE subtitles, so "find a zh subtitle for a
// cdrama" is a void cell (never seek a subtitle in the content's own audio language). See the
// invariant + backlog comment above CELL_CATALOG in src/testing/liveMatrix.ts.
