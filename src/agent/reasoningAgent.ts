import {
  ToolLoopAgent, hasToolCall, stepCountIs, tool,
  type LanguageModel, type ToolSet, type ToolLoopAgentSettings,
} from 'ai'
import type { z } from 'zod'
// 只引类型不引单例——痕迹通道 C 的 TraceEvent 形状活在 dashboard/traceBus.ts，reasoningAgent
// 对那个模块的单例状态零依赖，onStepEvent 只是把数据递出去，不知道也不关心谁在订阅。
import type { TraceEvent } from '../core/traceBus.js'

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
  /** 痕迹通道 C：每步结算后对该步每个工具调用触发一次（finalize 也算）。缺席=零行为差异。
   *  回调抛错被吞——痕迹是增益，绝不许反噬 agent 循环。 */
  onStepEvent?: (e: Omit<TraceEvent, 'runKey' | 'seq'>) => void
  /** 工具开始执行即触发（ticker 实时性）——与 onStepEvent（结束后落格/计时）互补。
   *  抛错必须被吞（痕迹是增益，绝不反噬循环，同 onStepEvent 纪律）。 */
  onToolStart?: (e: { tool: string; argsSummary: string; at: number }) => void
}

/** argsSummary/resultSummary 都走这个 cap——JSON.stringify 失败（理论上不该发生，工具输入/
 *  输出都是普通对象，防御性兜底）就退化成 String(value)。截断加省略号，默认 cap 200 保直播可
 *  读；dispatch_* 回执是 JSON，下游需完整解析，故其 resultSummary 单独放宽到 400。 */
function summarizeForTrace(value: unknown, max = 200): string {
  let s: string
  try {
    s = JSON.stringify(value) ?? String(value)
  } catch {
    s = String(value)
  }
  return s.length > max ? `${s.slice(0, max)}…` : s
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
  // 痕迹通道 C 计时基准：每次 onStepEnd 末尾重置为当前时刻，故 tookMs 是"上一步结束到这一步
  // 结束"的墙钟耗时（含模型思考）。初始化在这里（构造时）而非真正字面意义的模块顶层——每个
  // makeReasoningAgent() 调用都会拿到自己独立的闭包变量，避免并发跑多个 agent 时互相踩计时
  // （见本文件顶部 lastStepToolCalls 同款闭包状态先例）。首步会多算"构造到 generate() 真正
  // 起步"这段间隙，生产中两者紧邻，可忽略。
  let stepStartedAt = Date.now()

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
    // ticker 实时性：工具开始执行即发（onStepEnd 只在该步结算后触发，一次长搜索期间 UI 干等）。
    // 走同一 as-cast，不需额外类型断言；payload 字段名以 ai/dist/index.d.ts 的
    // ToolExecutionStartEvent（e.toolCall.toolName / e.toolCall.input）为准。
    onToolExecutionStart: opts.onToolStart
      ? (e: { toolCall: { toolName: string; input?: unknown } }) => {
          try {
            opts.onToolStart!({ tool: e.toolCall.toolName, argsSummary: summarizeForTrace(e.toolCall.input), at: Date.now() })
          } catch { /* 痕迹增益，绝不反噬 agent 循环（同 onStepEvent 纪律） */ }
        }
      : undefined,
    // Diagnostic capture only — does not affect the loop's control flow or output. See the
    // lastStepToolCalls declaration above for why this is the only reachable seam. Also the sole
    // bridge for 痕迹通道 C's onStepEvent (below) — same seam, two independent consumers.
    onStepEnd: (step: {
      toolCalls?: ReadonlyArray<{ toolCallId?: string; toolName: string; invalid?: boolean; input?: unknown }>
      toolResults?: ReadonlyArray<{ toolCallId?: string; toolName: string; output?: unknown }>
    }) => {
      lastStepToolCalls = step.toolCalls ?? []
      // onStepEvent 未传时，下面这整段除了几次 Date.now()/数组分配之外不产生任何可观察副作用
      // ——lastStepToolCalls 的赋值（唯一原本就存在的行为）已经在上面完成，与改动前逐字节一致。
      if (opts.onStepEvent) {
        const now = Date.now()
        const tookMs = now - stepStartedAt
        const toolCalls = step.toolCalls ?? []
        const toolResults = step.toolResults ?? []
        for (const call of toolCalls) {
          const result = call.toolCallId != null
            ? toolResults.find((r) => r.toolCallId === call.toolCallId)
            : undefined
          try {
            opts.onStepEvent({
              tool: call.toolName,
              argsSummary: summarizeForTrace(call.input),
              resultSummary: result ? summarizeForTrace(result.output, call.toolName.startsWith('dispatch_') ? 400 : 200) : '',
              tookMs,
              at: now,
            })
          } catch {
            // 痕迹是增益，绝不许反噬 agent 循环——onStepEvent 抛错必须被吞。
          }
        }
      }
      stepStartedAt = Date.now()
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
          // 法证升级（job 34 第二次失败的直接教训）：raw-args 截断线以外的失败字段完全不可见，
          // 排障成了考古。现场重新 safeParse 一次，把 zod issues（路径 + 消息，前 5 条）直接
          // 写进错误——下一次同类 bug 一眼定位。截断线同步 500 → 2000。
          let issuesText: string
          const reparse = opts.schema.safeParse(invalidFinalizeCall.input)
          if (reparse.success) {
            // invalid 标记来自 SDK 层（多半是 JSON parse 失败），不是我们 schema 拒的。
            issuesText =
              'NOTE: SDK marked the call invalid but the input passes our schema — ' +
              'likely malformed JSON at the SDK layer.'
          } else {
            const issues = reparse.error.issues.slice(0, 5)
            const more = reparse.error.issues.length - issues.length
            issuesText =
              `Schema issues (first ${issues.length}${more > 0 ? ` of ${reparse.error.issues.length}` : ''}): ` +
              issues.map((i) => `[${i.path.join('.') || '(root)'}] ${i.message}`).join('; ')
          }
          const truncated = rawArgs.length > 2000 ? `${rawArgs.slice(0, 2000)}…(truncated)` : rawArgs
          throw new Error(
            `reasoning agent DID call the finalize tool, but its arguments failed schema validation — ` +
            `execute() never ran, so no structured decision was captured. (The loop still stopped: ` +
            `hasToolCall('${FINALIZE_TOOL_NAME}') fires on the call's presence, not its validity.) ` +
            `${issuesText} ` +
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
