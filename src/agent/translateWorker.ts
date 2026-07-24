import { basename } from 'node:path'
import { stepCountIs, type LanguageModel } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeRunTracer } from '../core/traceBus.js'
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
  /** P2.2b critic 适配器(可选;TRANSLATE_CRITIC=off 时缺席)。 */
  critic?: {
    evaluate: (src: string[], tgt: string[], glossary: Array<{ en: string; zh: string }>) => Promise<string>
  }
  /** 步数上限（默认 2000,为 pro reasoning 留足余量;2026-07-24 Oppenheimer 压测）。 */
  stepCap?: number
  /** 超时毫秒（默认 4h,daemon 可注入有限值;Infinity → 无限;压测 pro reasoning 用）。 */
  timeoutMs?: number
}

export type TranslateRunReport = TranslateReport & { llmCalls?: number }

/** Assembles one translate workspace run. The model is the translator: it reads cleaned
 *  documents on the job workspace and writes tgt rows KV-style; final SRT comes only from
 *  the deterministic merge tool. Every dependency is injected — no global state.
 *  The returned report carries llmCalls = agent loop steps (runs 账本口径:尝试边界的模型调用)。 */
export function makeTranslateWorker(deps: TranslateWorkerDeps) {
  return async function runTranslateTask(task: TranslateTask): Promise<TranslateRunReport> {
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
        critic: deps.critic,
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

    const tracer = makeRunTracer(`job-${task.jobId}`)
    // 配额账本(复审 Important-2):耗尽/abort 路径 result.steps 不可得,llm 调用数必须走
    // onStepEvent 闭包计数——最烧配额的路径恰恰不能在账本里显示零成本。
    let stepCount = 0
    const { agent, readFinalized } = makeReasoningAgent({
      model: deps.model,
      tools,
      instructions,
      schema: TranslateReportSchema,
      stopWhen: stepCountIs(deps.stepCap ?? 2000),
      reasoning: 'high',
      telemetry: { isEnabled: true },
      onStepEvent: (e) => {
        stepCount++
        tracer(e)
      },
    })

    const timeoutMs = deps.timeoutMs ?? 14_400_000 // 默认 4h(Oppenheimer 压测级);undefined → 无限
    try {
      const result = await agent.generate({
        prompt,
        abortSignal: timeoutMs === Infinity ? undefined : AbortSignal.timeout(timeoutMs),
      })
      console.error(`[translate-worker] job ${task.jobId} finished in ${result.steps.length} step(s)`)
      return { ...readFinalized(), llmCalls: result.steps.length }
    } catch (e) {
      // 模型放弃/步数耗尽/abort 等未 finalize 的情形:诚实 held(fail-closed),绝不让异常
      // 以未捕获形态炸出调用方——与 find-subtitle worker-exhaustion 语义对齐。
      const reason = e instanceof Error ? e.message : String(e)
      console.error(`[translate-worker] job ${task.jobId} ended without a clean finalize: ${reason}`)
      return { status: 'held', reason: `worker exhausted: ${reason.slice(0, 200)}`, sourceRef: null, sidecarPath: null, llmCalls: stepCount }
    }
  }
}
