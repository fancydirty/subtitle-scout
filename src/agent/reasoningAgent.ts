import {
  ToolLoopAgent, hasToolCall, stepCountIs, tool,
  type LanguageModel, type ToolSet, type ToolLoopAgentSettings,
} from 'ai'
import type { z } from 'zod'

export type ReasoningLevel = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

// `Context` (ToolLoopAgent's RUNTIME_CONTEXT default) isn't re-exported by name from 'ai' — pull
// it out structurally from ToolLoopAgentSettings' own default type argument instead of importing
// from the transitive @ai-sdk/provider-utils dependency directly.
type DefaultRuntimeContext = ToolLoopAgentSettings extends ToolLoopAgentSettings<any, any, infer C, any> ? C : never

/** The name of the injected terminal tool. Fixed (not caller-configurable) because `hasToolCall`
 *  below must reference the exact same string to know when to stop the loop. */
export const FINALIZE_TOOL_NAME = 'finalize' as const

export interface ReasoningAgentOptions<TOOLS extends ToolSet, SCHEMA extends z.ZodType> {
  model: LanguageModel
  tools: TOOLS
  schema: SCHEMA
  instructions?: string
  /** Overrides the default finalize-tool description the model sees. */
  finalizeDescription?: string
  /** @default stepCountIs(20) — same default as the underlying ToolLoopAgent. Callers building
   *  production workers (phase ③) MUST override this explicitly (a big test-time ceiling like
   *  stepCountIs(500) per the spec's "observe first, cap later" test philosophy). This is ONE of
   *  two stop conditions: the loop also always stops the moment finalize is called. */
  stopWhen?: ConstructorParameters<typeof ToolLoopAgent>[0]['stopWhen']
  /** @default 'high' — this is the actual fix for the old pipeline's thinking-disable illness
   *  (quirks.ts/probe.ts/profile.ts force thinking off to make forced tool_choice work).
   *  reasoning:'high' + NATIVE tool-calling works fine on mimo-v2.5 (proven live) — the earlier
   *  fear that reasoning breaks tool-calling was disproven. */
  reasoning?: ReasoningLevel
  telemetry?: { isEnabled: boolean }
}

export interface ReasoningAgentHandle<TOOLS extends ToolSet, RESULT> {
  /** The assembled ToolLoopAgent. Call `agent.generate({ prompt, abortSignal })` to run the loop;
   *  `result.steps.length` etc. remain available for diagnostics. The final structured decision is
   *  NOT read from `result.output` — read it from `readFinalized()` after generate() resolves. */
  agent: ToolLoopAgent<never, TOOLS, DefaultRuntimeContext, never>
  /** The structured decision the model reported by calling the finalize tool. Throws if the loop
   *  ended without finalize ever being called (e.g. the model gave up or hit the step cap first). */
  readFinalized: () => RESULT
}

/** Thin factory over ToolLoopAgent for every v3 subagent (find-subtitle, orchestrator,
 *  realign-wrapper): the model reports its terminal structured decision by calling a `finalize`
 *  TOOL whose inputSchema IS the decision schema, and the loop stops the instant finalize is
 *  called (hasToolCall('finalize')). The captured finalize args become the structured result.
 *
 *  Why a finalize tool and NOT Output.object(): on the openai-compatible provider, Output.object
 *  injects `response_format:{type:'json_object'}` into EVERY request. Sent alongside `tools`, the
 *  real model (mimo-v2.5) gets confused and emits a ReAct-style TEXT blob {thought, actions:[...]}
 *  instead of native tool_calls; the SDK can parse it as neither, raising AI_NoObjectGeneratedError
 *  (finishReason 'stop'). Proven live. finalize-tool mode sends `tools` but never response_format,
 *  so native tool-calling — including the terminal decision — works, even with reasoning_effort:high.
 *
 *  This is now the only structured-decision path in the codebase — llm.ts's callStructured (the
 *  forced-JSON tool-call runtime this was originally built to coexist alongside) was deleted
 *  wholesale in the old-pipeline retirement. */
export function makeReasoningAgent<TOOLS extends ToolSet, SCHEMA extends z.ZodType>(
  opts: ReasoningAgentOptions<TOOLS, SCHEMA>,
): ReasoningAgentHandle<TOOLS, z.infer<SCHEMA>> {
  let captured: z.infer<SCHEMA> | undefined
  let didFinalize = false
  // readFinalized() is called by the CALLER after agent.generate() resolves, with no arguments of
  // its own (see findSubtitleWorker.ts) — this is the only seam through which it can learn WHY
  // finalize never got captured. onStepEnd fires for every step, including the terminal one, so by
  // the time generate() resolves this always holds the last step's tool calls. That matters
  // because hasToolCall(FINALIZE_TOOL_NAME) below stops the loop the instant the model calls
  // finalize — valid or not — so an INVALID finalize call (schema validation failed, execute()
  // never ran) is always the last step's tool call whenever readFinalized() would otherwise throw
  // the generic "never called finalize" message. Diagnosed live (v3 live test matrix, 2026-07-13):
  // that generic message hid that finalize actually WAS attempted.
  let lastStepToolCalls: ReadonlyArray<{ toolName: string; invalid?: boolean; input?: unknown }> = []

  const finalizeTool = tool({
    description: opts.finalizeDescription ??
      'Call this EXACTLY ONCE, as your final action, with your complete structured decision as the ' +
      'arguments. Calling it ends the task. Do not call any other tool in the same step.',
    inputSchema: opts.schema,
    execute: async (input: z.infer<SCHEMA>) => {
      captured = input
      didFinalize = true
      return { ok: true }
    },
  })

  // The cast below routes around a TS false-negative, not a real type-safety gap: `tools` is
  // generic (TOOLS extends ToolSet) inside this function body, so ToolLoopAgentSettings'
  // internal ToolsContextParameter<TOOLS> — a conditional type that makes `toolsContext`
  // optional/required/absent depending on whether TOOLS declares contextual tools — can't be
  // resolved at this generic boundary and TS conservatively rejects the object literal even
  // though none of this repo's tools use contextual (`toolsContext`) tools. The public
  // ReasoningAgentOptions<TOOLS, SCHEMA> signature above is unaffected and still fully checked.
  const settings = {
    model: opts.model,
    tools: { ...opts.tools, [FINALIZE_TOOL_NAME]: finalizeTool },
    instructions: opts.instructions,
    // Two independent stop conditions (loop stops when EITHER is met): the finalize call, and the
    // step ceiling as a runaway backstop. finalize is the normal terminator.
    stopWhen: [opts.stopWhen ?? stepCountIs(20), hasToolCall(FINALIZE_TOOL_NAME)],
    reasoning: opts.reasoning ?? 'high',
    telemetry: opts.telemetry,
    // Diagnostic capture only — does not affect the loop's control flow or output. See the
    // lastStepToolCalls declaration above for why this is the only reachable seam.
    onStepEnd: (step: { toolCalls?: ReadonlyArray<{ toolName: string; invalid?: boolean; input?: unknown }> }) => {
      lastStepToolCalls = step.toolCalls ?? []
    },
  } as unknown as ToolLoopAgentSettings<never, TOOLS, DefaultRuntimeContext, never>

  const agent = new ToolLoopAgent(settings)

  return {
    agent,
    readFinalized(): z.infer<SCHEMA> {
      if (!didFinalize) {
        // Distinguish "finalize was never called" from "finalize WAS called but its arguments
        // failed schema validation" (execute() only runs on valid args) — the second case reads
        // as the first unless we look at the last step's raw tool calls, which is exactly the bug
        // the v3 live test matrix caught: the real model omitted required finalize fields, and the
        // old generic message here hid that finalize was actually attempted.
        const invalidFinalizeCall = lastStepToolCalls.find(
          (call) => call.toolName === FINALIZE_TOOL_NAME && call.invalid,
        )
        if (invalidFinalizeCall) {
          let rawArgs: string
          try {
            rawArgs = JSON.stringify(invalidFinalizeCall.input)
          } catch {
            rawArgs = String(invalidFinalizeCall.input)
          }
          const truncated = rawArgs.length > 500 ? `${rawArgs.slice(0, 500)}…(truncated)` : rawArgs
          throw new Error(
            `reasoning agent DID call the finalize tool, but its arguments failed schema validation — ` +
            `execute() never ran, so no structured decision was captured. (The loop still stopped: ` +
            `hasToolCall('${FINALIZE_TOOL_NAME}') fires on the call's presence, not its validity.) ` +
            `Raw finalize args: ${truncated}`,
          )
        }
        throw new Error(
          'reasoning agent finished without calling the finalize tool — no structured decision was ' +
          'produced. The model must call finalize({...}) exactly once as its terminal step (it may ' +
          'have given up, errored, or exhausted the step cap first).',
        )
      }
      return captured as z.infer<SCHEMA>
    },
  }
}
