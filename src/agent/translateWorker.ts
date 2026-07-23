import { basename } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../dashboard/traceBus.js'
import { translateSkill } from './skills/translateSkill.js'
import { systemPromptSkillIndex, makeReadDocTool } from './skills/registry.js'
import { makeTranslateWorkspaceTools } from './translateWorker.tools.js'
import { TranslateReportSchema, type TranslateReport, type TranslateTask } from './translateWorker.schemas.js'
import { ensureWorkspaceLayout } from '../translate/workspace/paths.js'
import type { ResolveSourceDeps } from '../translate/workspace/resolveSource.js'
import type { GlossaryTerm } from '../translate/workspace/types.js'

export interface TranslateWorkerDeps {
  model: LanguageModel
  resolveDeps: ResolveSourceDeps
  /** Install merge-produced SRT as the Chinese sidecar; returns installed path. */
  install: (videoPath: string, srtContent: string) => string
  videoDurationSec?: (videoPath: string) => Promise<number | null>
  /** Legacy parity: existing Chinese sidecar path, or null (already-covered short-circuit). */
  readExistingChineseSidecar?: (videoPath: string) => string | null
  /** P2: 剧级术语持久化(v2/glossaryRepo 的真实现由 CLI/daemon 接线)。 */
  glossaryStore?: {
    load: (seriesKey: string) => GlossaryTerm[]
    save: (seriesKey: string, terms: GlossaryTerm[], updatedAt: number) => void
  }
  fetchTmdbContext?: (task: TranslateTask) => Promise<string | null>
  fetchSeriesTargetSubs?: (task: TranslateTask) => Promise<string | null>
  /** @default 500 — windowed protocol needs room; exhaustion maps to held, not a crash. */
  stepCap?: number
  /** @default 900_000 */
  timeoutMs?: number
}

/** Assembles one translate workspace run. The model is the translator: it reads cleaned
 *  documents on the job workspace and writes tgt rows KV-style; final SRT comes only from
 *  the deterministic merge tool. Every dependency is injected — no global state. */
export function makeTranslateWorker(deps: TranslateWorkerDeps) {
  return async function runTranslateTask(task: TranslateTask): Promise<TranslateReport> {
    const stagingBase = task.stagingRoot ?? task.mediaRoot
    const paths = ensureWorkspaceLayout(stagingBase, task.jobId)

    const tools = {
      read_doc: makeReadDocTool([translateSkill]),
      ...makeTranslateWorkspaceTools({
        task,
        paths,
        resolveDeps: deps.resolveDeps,
        install: deps.install,
        videoDurationSec: deps.videoDurationSec,
        readExistingChineseSidecar: deps.readExistingChineseSidecar,
        glossaryStore: deps.glossaryStore,
        fetchTmdbContext: deps.fetchTmdbContext,
        fetchSeriesTargetSubs: deps.fetchSeriesTargetSubs,
      }),
    }

    const instructions = [
      'You are the translation clerk for exactly ONE video file. You know nothing about any other',
      'file, directory, or series — do not ask about or reference one.',
      'Your desk is a workspace of documents on disk; read and write ONLY through the provided tools.',
      '',
      'Available skill documents (call read_doc(name) to load the full text of one):',
      systemPromptSkillIndex([translateSkill]),
    ].join('\n')

    const prompt = [
      'Translate this video\'s subtitle into Simplified Chinese following the workspace playbook.',
      'Start with read_doc(translate-workspace), then resolve_source. Report via finalize exactly once.',
      '',
      `title: ${task.title}`,
      `itemId: ${task.itemId}`,
      `origin_lang: ${task.originLang ?? 'unknown'}`,
      `file: ${basename(task.videoPath)}`,
    ].join('\n')

    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: TranslateReportSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 500),
      reasoning: 'high',
      telemetry: { isEnabled: true },
      onStepEvent: makeRunTracer(`job-${task.jobId}`),
    })

    try {
      const result = await agent.generate({
        prompt,
        abortSignal: AbortSignal.timeout(deps.timeoutMs ?? 900_000),
      })
      console.error(`[translate-worker] job ${task.jobId} finished in ${result.steps.length} step(s)`)
      return readFinalized()
    } catch (e) {
      // 模型放弃/步数耗尽/abort 等未 finalize 的情形:诚实 held(fail-closed),绝不让异常
      // 以未捕获形态炸出调用方——与 find-subtitle worker-exhaustion 语义对齐。
      const reason = e instanceof Error ? e.message : String(e)
      console.error(`[translate-worker] job ${task.jobId} ended without a clean finalize: ${reason}`)
      return { status: 'held', reason: `worker exhausted: ${reason.slice(0, 200)}`, sourceRef: null, sidecarPath: null }
    }
  }
}
