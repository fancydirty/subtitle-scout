import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'

/** A transparent model wrapper for the live-matrix runner: it observes every tool call the model
 *  makes across an agent run and never alters behavior. This is OUT-OF-BAND OBSERVABILITY ONLY —
 *  it must be a pure passthrough. wrapGenerate awaits the real doGenerate() and returns its result
 *  completely unchanged; the only side effect is pushing each `tool-call` part's toolName onto the
 *  shared `toolCalls` array, in call order.
 *
 *  Why generate-only (no wrapStream): makeReasoningAgent (src/agent/reasoningAgent.ts) drives the
 *  ToolLoopAgent via `agent.generate(...)`, never `agent.stream(...)` — confirmed by reading the
 *  worker's call path (src/agent/findSubtitleWorker.ts → reasoningAgent.ts). Each agent STEP is one
 *  doGenerate call, so wrapping doGenerate alone captures the full tool sequence across every step
 *  of one run. Adding wrapStream would be unexercised code for a path this worker never takes.
 *
 *  Fresh instance per run: the caller (scripts/run-live-matrix.ts) must call this once per cell run
 *  so `toolCalls` isn't contaminated across runs — the array is scoped to the closure, not global. */
export function makeToolCallTap(model: LanguageModel): { model: LanguageModel; toolCalls: string[] } {
  // `LanguageModel` is a union that also admits a bare provider-registry ID string (e.g.
  // 'openai:gpt-4'); wrapLanguageModel only accepts a resolved model instance. Every caller in
  // this codebase (makeModel in src/agent/llm.ts) always hands over a resolved instance, so this
  // guard narrows the type for wrapLanguageModel below rather than silencing a real gap.
  if (typeof model === 'string') {
    throw new Error('makeToolCallTap requires a resolved model instance, not a provider registry ID string')
  }
  const toolCalls: string[] = []

  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate()
      for (const part of result.content) {
        if (part.type === 'tool-call') toolCalls.push(part.toolName)
      }
      return result
    },
  }

  return { model: wrapLanguageModel({ model, middleware }), toolCalls }
}
