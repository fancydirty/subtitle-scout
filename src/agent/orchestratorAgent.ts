import { stepCountIs, type LanguageModel } from 'ai'
import { z } from 'zod'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeReadDocTool, systemPromptSkillIndex } from './skills/registry.js'
import { ORCHESTRATOR_SKILL } from './skills/orchestratorSkill.js'
import {
  makeListMissingCoverageTool, makeCheckSeriesLayoutTool, makeDispatchFindSubtitleTaskTool,
  makeDispatchRealignTaskTool, makeSpawnSiblingOrchestratorTool, type DispatchCounter,
} from './orchestratorAgent.tools.js'
import type { LibraryRepo } from '../v2/libraryRepo.js'
import type { JobsRepo } from '../v2/jobsRepo.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

export const OrchestratorDecisionSchema = z.object({
  dispatchedFindSubtitle: z.number().int(),
  dispatchedRealign: z.number().int(),
  spawnedSiblings: z.number().int(),
  summary: z.string(),
})
export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>

export interface OrchestratorAgentDeps {
  model: LanguageModel
  lib: Pick<LibraryRepo, 'missingBySeason' | 'missingMovies' | 'countEpisodesInSeason'>
  tmdb: Pick<TmdbClient, 'getSeasonTable'>
  jobs: Pick<JobsRepo, 'upsertWorkerTask'>
  now: () => number
  /** null for the root orchestrator (triggered directly, phase ⑦); set to the claiming job's
   *  own id when this run IS a sibling orchestrator claimed from the jobs table (phase ⑦'s
   *  claim-dispatch switch passes its own job.id here). */
  orchestratorJobId: number | null
  stepCap?: number
  maxDispatchesPerOrchestrator?: number
}

export function makeOrchestratorAgent(deps: OrchestratorAgentDeps) {
  return async function runOrchestratorPass(): Promise<OrchestratorDecision> {
    const counter: DispatchCounter = { count: 0 }
    const dispatchDeps = { jobs: deps.jobs, now: deps.now, parentJobId: deps.orchestratorJobId }

    const tools = {
      read_doc: makeReadDocTool([ORCHESTRATOR_SKILL]),
      list_missing_coverage: makeListMissingCoverageTool(deps.lib, deps.now),
      // Hard gate (spec: "正常库零误触发"): the orchestrator MUST call this before
      // dispatch_realign_task — a season that does not exceed TMDB's episode count is never a
      // realign candidate, and this tool reports that as a fact rather than letting the model
      // infer it. executeRealign's own gates (unchanged, phase ⑥) are a second, independent
      // layer of defense on top of this, not the only one.
      check_series_layout: makeCheckSeriesLayoutTool(deps.lib, deps.tmdb),
      dispatch_find_subtitle_task: makeDispatchFindSubtitleTaskTool(
        { ...dispatchDeps, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator }, counter,
      ),
      dispatch_realign_task: makeDispatchRealignTaskTool(
        { ...dispatchDeps, maxDispatchesPerOrchestrator: deps.maxDispatchesPerOrchestrator }, counter,
      ),
      spawn_sibling_orchestrator: makeSpawnSiblingOrchestratorTool(dispatchDeps),
    }

    const instructions = [
      'You are the orchestrator. You plan dispatch order, you do not do the work yourself.',
      'Scale effort to the actual backlog — a handful of missing seasons does not need you to',
      'spawn many subagents; that is a known multi-agent cost blowup, not thoroughness.',
      'Before EVER calling dispatch_realign_task for a series/season, you MUST call',
      'check_series_layout for it first and only proceed if exceedsSeasonTable is true — never',
      'dispatch a realign task on a hunch.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([ORCHESTRATOR_SKILL]),
    ].join('\n')

    const agent = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: OrchestratorDecisionSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
    })

    const result = await agent.generate({
      prompt: 'Read the living-doc and dispatch worker tasks for whatever needs work right now.',
      abortSignal: AbortSignal.timeout(180_000),
    })
    return result.output
  }
}
