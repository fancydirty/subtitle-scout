import { dirname, join } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { languageName } from './languages.js'
import { FIND_SUBTITLE_SKILL } from './skills/findSubtitleSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import {
  makeFileResultSetStore, makeSearchSourceTool, makeListCandidatesTool, makeGetCandidateTool,
} from './resultHandles.js'
import {
  makeDownloadCandidateTool, makeInstallSubtitleTool, makeCheckEpisodeCodeSafetyTool,
} from './findSubtitleWorker.tools.js'
import {
  FindSubtitleDecisionSchema, type FindSubtitleTask, type FindSubtitleDecision,
} from './findSubtitleWorker.schemas.js'
import { allocate, cleanup } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import type { FetchAdapter } from '../cli/fetchLib.js'

export interface FindSubtitleWorkerDeps {
  model: LanguageModel
  adapters: FetchAdapter[]
  cacheRoot: string
  /** Test phase per spec: no production step cap yet — observe actual step counts first.
   *  @default 500 */
  stepCap?: number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 300_000

/** Assembles one find-subtitle worker run. Every dependency (model, adapters, cacheRoot) is
 *  injected — this function has zero global state, so the caller (orchestrator in phase ⑤,
 *  the manual live-acceptance script in Task 7) can construct it identically in both offline
 *  tests and production. Returns a function that runs exactly one task end to end. */
export function makeFindSubtitleWorker(deps: FindSubtitleWorkerDeps) {
  return async function runFindSubtitleTask(task: FindSubtitleTask): Promise<FindSubtitleDecision> {
    const outDir = dirname(task.videoPath)
    // Sandbox layer 1 (code): verified BEFORE any tool exists or any model call happens — a
    // misconfigured task never even gets to try.
    if (!isUnderRoots(outDir, [task.mediaRoot])) {
      throw new Error(`task video path ${task.videoPath} escapes its own sandboxed mediaRoot ${task.mediaRoot}`)
    }

    const stagingDir = allocate(task.jobId, task.mediaRoot)
    const store = makeFileResultSetStore(join(deps.cacheRoot, 'result-sets', task.jobId))
    const stagedFiles = new Map<string, string>()

    const tools = {
      read_doc: makeReadDocTool([FIND_SUBTITLE_SKILL]),
      search_source: makeSearchSourceTool({ adapters: deps.adapters, store, targetLanguage: task.targetLanguage }),
      list_candidates: makeListCandidatesTool(store),
      get_candidate: makeGetCandidateTool(store),
      download_candidate: makeDownloadCandidateTool({
        adapters: deps.adapters, stagingDir, stagedFiles,
        videoFilename: task.videoFilename, targetLanguage: task.targetLanguage, fetchImpl: deps.fetchImpl,
      }),
      install_subtitle: makeInstallSubtitleTool({
        stagedFiles, outDir, mediaRoot: task.mediaRoot, videoFilename: task.videoFilename,
      }),
      check_episode_code_safety: makeCheckEpisodeCodeSafetyTool(),
    }

    // Sandbox layer 2 (prompt/skill): this instructions string is the ENTIRE system prompt —
    // no other directory name is ever mentioned anywhere in it.
    const instructions = [
      'You are the find-subtitle worker for exactly ONE media item. You have no knowledge of',
      'any other directory or media item in existence — do not ask about or reference one.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([FIND_SUBTITLE_SKILL]),
    ].join('\n')

    const prompt = [
      // "a subtitle in X" rather than "a X subtitle": sidesteps the a/an article problem
      // ("a English subtitle") no matter what languageName() returns.
      `Find and install a subtitle in ${languageName(task.targetLanguage)} for this media item, or report why you could not.`,
      '',
      `target subtitle language: ${languageName(task.targetLanguage)}`,
      `title: ${task.title}`,
      `original title: ${task.originalTitle ?? 'unknown'}`,
      `year: ${task.year ?? 'unknown'}`,
      `season/episode: S${task.season ?? '-'} E${task.episode ?? '-'}`,
      ...(task.absoluteEpisode != null
        ? [`absolute episode number (across the whole series): ${task.absoluteEpisode}`]
        : []),
      `filename: ${task.videoFilename}`,
      `alternative/native titles: ${task.alternativeTitles.length ? task.alternativeTitles.join(', ') : 'none'}`,
      `overview: ${task.overview ?? 'none'}`,
      `runtime minutes: ${task.runtimeMinutes ?? 'unknown'}`,
      `provider ids: ${JSON.stringify(task.providerIds)}`,
    ].join('\n')

    // finalize-tool mode (NOT Output.object): the model reports its FindSubtitleDecision by
    // calling the injected `finalize` tool as its terminal step, and readFinalized() returns those
    // captured args. This avoids the response_format:json_object the openai-compatible provider
    // would otherwise inject for Output.object — the poison that makes real mimo-v2.5 emit a ReAct
    // text blob instead of native tool_calls (AI_NoObjectGeneratedError). See reasoningAgent.ts.
    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: FindSubtitleDecisionSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
    })

    try {
      const result = await agent.generate({
        prompt,
        abortSignal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      // Diagnostic only (stderr, not part of the return contract): the live-acceptance
      // checklist (docs/design/2026-07-13-v3-live-acceptance-checklist.md, Step 6) asks a human
      // to record the step count of each real run — this is the only place that number
      // (result.steps.length, per the stepCountIs(500) test-phase ceiling) is ever observable,
      // since runFindSubtitleTask's return type is deliberately just the decision.
      console.error(`[find-subtitle-worker] job ${task.jobId} finished in ${result.steps.length} step(s)`)
      return readFinalized()
    } finally {
      // Try-error sandbox cleanup runs even on a thrown error — the staging dir never
      // survives a run, matching stagingSandbox's own "job ends, sandbox is deleted" contract.
      cleanup(task.jobId, task.mediaRoot)
    }
  }
}
