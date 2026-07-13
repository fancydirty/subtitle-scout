import { ToolLoopAgent, Output, stepCountIs, type LanguageModel, type ToolSet, type ToolLoopAgentSettings, type DeepPartial } from 'ai'
import type { z } from 'zod'

export type ReasoningLevel = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

// `Context` (ToolLoopAgent's RUNTIME_CONTEXT default) isn't re-exported by name from 'ai' — pull
// it out structurally from ToolLoopAgentSettings' own default type argument instead of importing
// from the transitive @ai-sdk/provider-utils dependency directly.
type DefaultRuntimeContext = ToolLoopAgentSettings extends ToolLoopAgentSettings<any, any, infer C, any> ? C : never
type OutputFor<SCHEMA extends z.ZodType> = Output.Output<z.infer<SCHEMA>, DeepPartial<z.infer<SCHEMA>>, never>

export interface ReasoningAgentOptions<TOOLS extends ToolSet, SCHEMA extends z.ZodType> {
  model: LanguageModel
  tools: TOOLS
  schema: SCHEMA
  instructions?: string
  outputName?: string
  outputDescription?: string
  /** @default stepCountIs(20) — same default as the underlying ToolLoopAgent. Callers building
   *  production workers (phase ③) MUST override this explicitly (a big test-time ceiling like
   *  stepCountIs(500) per the spec's "observe first, cap later" test philosophy). */
  stopWhen?: ConstructorParameters<typeof ToolLoopAgent>[0]['stopWhen']
  /** @default 'high' — this is the actual fix for the old pipeline's thinking-disable illness
   *  (quirks.ts/probe.ts/profile.ts force thinking off to make forced tool_choice work). */
  reasoning?: ReasoningLevel
  telemetry?: { isEnabled: boolean }
}

/** Thin factory over ToolLoopAgent: bakes in Output.object(schema) for end-of-loop structured
 *  output and a sane reasoning default, so every v3 subagent (find-subtitle, orchestrator,
 *  realign-wrapper) configures the same handful of options instead of re-deriving the
 *  ToolLoopAgent constructor shape each time. Does NOT touch llm.ts's callStructured — this is
 *  a parallel, coexisting path (phase ① of the v3 migration). */
export function makeReasoningAgent<TOOLS extends ToolSet, SCHEMA extends z.ZodType>(
  opts: ReasoningAgentOptions<TOOLS, SCHEMA>,
): ToolLoopAgent<never, TOOLS, DefaultRuntimeContext, OutputFor<SCHEMA>> {
  // The cast below routes around a TS false-negative, not a real type-safety gap: `tools` is
  // generic (TOOLS extends ToolSet) inside this function body, so ToolLoopAgentSettings'
  // internal ToolsContextParameter<TOOLS> — a conditional type that makes `toolsContext`
  // optional/required/absent depending on whether TOOLS declares contextual tools — can't be
  // resolved at this generic boundary and TS conservatively rejects the object literal even
  // though none of this repo's tools use contextual (`toolsContext`) tools. The public
  // ReasoningAgentOptions<TOOLS, SCHEMA> signature above is unaffected and still fully checked.
  const settings = {
    model: opts.model,
    tools: opts.tools,
    instructions: opts.instructions,
    output: Output.object({
      schema: opts.schema,
      name: opts.outputName,
      description: opts.outputDescription,
    }),
    stopWhen: opts.stopWhen ?? stepCountIs(20),
    reasoning: opts.reasoning ?? 'high',
    telemetry: opts.telemetry,
  } as unknown as ToolLoopAgentSettings<never, TOOLS, DefaultRuntimeContext, OutputFor<SCHEMA>>
  return new ToolLoopAgent(settings)
}
