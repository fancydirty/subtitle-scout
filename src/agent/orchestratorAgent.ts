import { stepCountIs, type LanguageModel } from 'ai'
import { z } from 'zod'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../core/traceBus.js'
import { makeReadDocTool, systemPromptSkillIndex } from './skills/registry.js'
import { ORCHESTRATOR_SKILL } from './skills/orchestratorSkill.js'
import {
  makeListMissingCoverageTool, makeCheckSeriesLayoutTool, makeDispatchFindSubtitleTaskTool,
  makeDispatchRealignTaskTool, makeDispatchUnidentifiedIdentificationTool,
  makeSpawnSiblingOrchestratorTool, type DispatchCounter,
} from './orchestratorAgent.tools.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

// NOTE (advisory, phase ⑦): every field here is the model's OWN self-report of what it did this
// pass, not a DB-derived count re-tallied from the jobs table after the fact — a model could in
// principle mis-state these numbers (e.g. after a dispatch tool call errors) without anything in
// this file catching the discrepancy. Accepted for phase ⑤/⑥; making this DB-authoritative is
// out of scope here (tracked as a phase ⑦ note, not fixed by this file).
export const OrchestratorDecisionSchema = z.object({
  dispatchedFindSubtitle: z.number().int(),
  dispatchedRealign: z.number().int(),
  spawnedSiblings: z.number().int(),
  summary: z.string(),
})
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>

export interface OrchestratorAgentDeps {
  model: LanguageModel
  lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'countEpisodesInSeason' | 'getSeries' | 'listParkedPaths'>
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
  jobs: Pick<JobsRepo, 'upsertWorkerTask' | 'get'>
  now: () => number
  /** null for the root orchestrator (triggered directly, phase ⑦); set to the claiming job's
   *  own id when this run IS a sibling orchestrator claimed from the jobs table (phase ⑦'s
   *  claim-dispatch switch passes its own job.id here). */
  orchestratorJobId: number | null
  stepCap?: number
  maxDispatchesPerOrchestrator?: number
  /** B3（审计发现，意图黑洞）：spawn_sibling_orchestrator writes remainingWorkSummary into the
   *  spawned worker_task's payload, but until this fix nothing ever read it back — the parent
   *  pass's handoff context vanished on arrival, and the sibling had to re-derive everything from
   *  scratch. reconcileAll.ts's runOrchestrateWorkerTask reads it back off the claimed job's
   *  payload and passes it through here. Appended to the end of the initial user prompt, worded
   *  explicitly as context-not-command (北极星④: the mechanical layer only ever produces facts,
   *  never instructions) — the sibling still must re-derive what (if anything) to dispatch from
   *  list_missing_coverage's living-doc, not from this note alone. */
  promptSuffix?: string
}

export function makeOrchestratorAgent(deps: OrchestratorAgentDeps) {
  return async function runOrchestratorPass(): Promise<OrchestratorDecision> {
    // IMPORTANT: validate BEFORE the agent ever runs. parent_job_id carries a real
    // `REFERENCES jobs(id)` foreign key (foreign_keys=ON, src/v2/db.ts), so a non-existent
    // orchestratorJobId would make every upsertWorkerTask call inside the dispatch tools throw —
    // but the AI SDK's tool loop catches that throw, feeds it back to the model as a tool-error,
    // and keeps going. Left unchecked, that produces a truthful-LOOKING OrchestratorDecision
    // (e.g. dispatchedFindSubtitle: 1) while zero rows actually landed in the jobs table — a
    // silent, false-success failure mode. Fail loud here instead: a bad id must never let the
    // agent run at all. null is the root orchestrator's legitimate case and is allowed through.
    if (deps.orchestratorJobId !== null && deps.jobs.get(deps.orchestratorJobId) === null) {
      throw new Error(
        `runOrchestratorPass: orchestratorJobId=${deps.orchestratorJobId} does not reference an ` +
        'existing jobs row — refusing to run. Every dispatch this pass would carry that id as ' +
        'parent_job_id, which would throw inside upsertWorkerTask (FK violation) on the first ' +
        'dispatch attempt; that throw would otherwise be silently absorbed by the tool loop ' +
        'instead of failing this pass.'
      )
    }

    const counter: DispatchCounter = { count: 0 }
    const dispatchDeps = { jobs: deps.jobs, now: deps.now, parentJobId: deps.orchestratorJobId }

    const tools = {
      read_doc: makeReadDocTool([ORCHESTRATOR_SKILL]),
      list_missing_coverage: makeListMissingCoverageTool(deps.lib, deps.now),
      // Advisory inventory fact-check at this layer, not a hard gate — the orchestrator's
      // instructions (below + the skill doc) tell it to call this before dispatch_realign_task,
      // but dispatch_realign_task never consults exceedsSeasonTable itself, so nothing here
      // stops a model that ignores its instructions from dispatching anyway. The real
      // code-level, zero-false-trigger ("正常库零误触发") gate is executeRealign downstream
      // (phase ⑥) — that is the intended safety net: the model decides dispatch, executeRealign
      // is what must never misfire on an already-aligned library.
      check_series_layout: makeCheckSeriesLayoutTool(deps.lib, deps.tmdb),
      dispatch_find_subtitle_task: makeDispatchFindSubtitleTaskTool(
        { ...dispatchDeps, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator }, counter,
      ),
      dispatch_realign_task: makeDispatchRealignTaskTool(
        { ...dispatchDeps, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator }, counter,
      ),
      // Task 13: dispatch side of the unidentified backlog (claim side was Task 12). Not part of
      // the shared dispatch-cap counter — one call dispatches exactly ONE worker_task for the
      // whole eligible parked backlog, regardless of how many paths that backlog holds.
      dispatch_unidentified_identification: makeDispatchUnidentifiedIdentificationTool({
        lib: deps.lib, jobs: deps.jobs, now: deps.now, parentJobId: deps.orchestratorJobId,
      }),
      spawn_sibling_orchestrator: makeSpawnSiblingOrchestratorTool(dispatchDeps),
    }

    // R2 复审 F-R2-1（2026-07-16）：这里曾是 B5 定罪现场的另一半——skill 已改事实+理由式，
    // 但这段每轮必达的 system prompt 还留着 "you MUST … only proceed if exceedsSeasonTable is
    // true — never dispatch" 的守门原文，与 skill 直接冲突，且在指令层判死了 D1 的第二信号
    // （diskLayoutNonstandard）。守门措辞在此处一并处决：事实收集是例行，结论归 agent。
    const instructions = [
      'You are the orchestrator. You plan dispatch order, you do not do the work yourself.',
      'Scale effort to the actual backlog — a handful of missing seasons does not need you to',
      'spawn many subagents; that is a known multi-agent cost blowup, not thoroughness.',
      'Before dispatching for a series, routinely gather its layout facts via check_series_layout',
      '(a series never looks suspect from the living-doc alone — deciding without looking is',
      'deciding blind). The two layout facts are evidence for YOUR realign judgment, not gates;',
      'the skill document explains how to weigh them and why realign ordering matters.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([ORCHESTRATOR_SKILL]),
    ].join('\n')

    // finalize-tool mode (NOT Output.object): the orchestrator reports its OrchestratorDecision by
    // calling the injected `finalize` tool as its terminal step. Same root-cause fix as the
    // find-subtitle worker — on the openai-compatible provider Output.object injects
    // response_format:json_object into every request, which confuses real mimo-v2.5 into a ReAct
    // text blob instead of native tool_calls (AI_NoObjectGeneratedError). See reasoningAgent.ts.
    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: OrchestratorDecisionSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
      // 痕迹通道 C：null 是根编排器的合法测试矩阵态（deps.orchestratorJobId===null）——那种跑法
      // 没有一条真实 jobs 行可挂靠 runKey，零痕迹是正确行为，不是遗漏。runKey 拼法与收官快照
      // 读出时（reconcileAll.ts 的 runOrchestrateWorkerTask）必须一致，都是 `job-${id}`。
      onStepEvent: deps.orchestratorJobId !== null
        ? makeRunTracer(`job-${deps.orchestratorJobId}`)
        : undefined,
    })

    const handoffNote = deps.promptSuffix
      ? `\nHandoff note from the orchestrator that spawned you (context, not command — re-derive from the living-doc): ${deps.promptSuffix}`
      : ''

    await agent.generate({
      prompt: 'Read the living-doc and dispatch worker tasks for whatever needs work right now.' + handoffNote,
      abortSignal: AbortSignal.timeout(180_000),
    })
    return readFinalized()
  }
}
