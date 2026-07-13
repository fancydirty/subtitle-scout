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
 *  Does NOT touch llm.ts's callStructured — this is a parallel, coexisting path. */
export function makeReasoningAgent<TOOLS extends ToolSet, SCHEMA extends z.ZodType>(
  opts: ReasoningAgentOptions<TOOLS, SCHEMA>,
): ReasoningAgentHandle<TOOLS, z.infer<SCHEMA>> {
  let captured: z.infer<SCHEMA> | undefined
  let didFinalize = false

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
  } as unknown as ToolLoopAgentSettings<never, TOOLS, DefaultRuntimeContext, never>

  const agent = new ToolLoopAgent(settings)

  return {
    agent,
    readFinalized(): z.infer<SCHEMA> {
      if (!didFinalize) {
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
