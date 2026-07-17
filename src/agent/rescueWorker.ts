import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../dashboard/traceBus.js'
import { rescueSkill } from './skills/rescueSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import { makeRescueWorkerTools } from './rescueWorker.tools.js'
import { RescueReportSchema } from './rescueWorker.schemas.js'
import type { RescueTask, RescueReport } from '../v2/rescueWorkerTask.js'
import type { TmdbClient } from '../adapters/providers/tmdb.js'

export interface RescueWorkerDeps {
  model: LanguageModel
  tmdb: Pick<TmdbClient, 'search' | 'getDetails' | 'getSeasonTable'>
}

/** Assembles one rescue-identify worker run. The agent inspects parked directories, gathers TMDB
 *  evidence, and reports one outcome per directory via the finalize tool. Decision tools
 *  (claim_directory / exclude_extras / keep_parked) only record decisions in the agent's trace;
 *  the runner harvests the finalize report and applies it through the single claimParked
 *  implementation path. */
export function makeRescueWorker(deps: RescueWorkerDeps) {
  return async function runRescueTask(task: RescueTask): Promise<RescueReport> {
    const taskDirs = new Set(task.groups.map((g) => g.dir))

    const tools = {
      read_doc: makeReadDocTool([rescueSkill]),
      ...makeRescueWorkerTools({ tmdb: deps.tmdb, taskDirs }),
    }

    const groupsBlock = task.groups
      .map((g) => {
        const filesBlock = g.files
          .map((f) => {
            const duration = f.durationSec != null ? `duration: ${f.durationSec}s` : 'duration: unknown'
            return `  - ${f.path} (${duration})`
          })
          .join('\n')
        return `- directory: ${g.dir}\n  park reason: ${g.reason}\n  files:\n${filesBlock}`
      })
      .join('\n\n')

    const instructions = [
      'You are the rescue-identify worker. Your job is to identify parked media directories that the',
      'automatic scraper could NOT identify. For each directory, decide ONE of three outcomes:',
      'claim it (you are confident which TMDB entry it is), exclude it (it is non-episode extras',
      'material), or keep it parked (you are not confident). Every directory in your task MUST appear',
      'in your finalize report exactly once.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([rescueSkill]),
      '',
      'Read the playbook (read_doc) before deciding. Every directory must appear in finalize exactly once.',
      '',
      'Parked directories you are deciding on:',
      groupsBlock,
    ].join('\n')

    const prompt = [
      'Decide the outcome for every parked directory listed above.',
      'Call finalize exactly once with a complete RescueReport containing one outcome per directory.',
    ].join(' ')

    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: RescueReportSchema,
      stopWhen: stepCountIs(500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
      onStepEvent: makeRunTracer(`job-${task.jobId}`),
    })

    // Timeout scales with the number of directories: 5 minutes base + 1 minute per group,
    // capped at 20 minutes. This mirrors findSubtitleWorker's timeoutFor scaling without
    // requiring a separate helper.
    const timeoutMs = Math.min(20 * 60_000, 5 * 60_000 + task.groups.length * 60_000)

    const result = await agent.generate({
      prompt,
      abortSignal: AbortSignal.timeout(timeoutMs),
    })

    console.error(`[rescue-worker] job ${task.jobId} finished in ${result.steps.length} step(s)`)
    return readFinalized()
  }
}
