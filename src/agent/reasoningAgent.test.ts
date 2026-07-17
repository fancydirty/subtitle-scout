import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { tool, generateText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { makeReasoningAgent } from './reasoningAgent.js'

const DecisionSchema = z.object({
  verdict: z.enum(['match', 'no_match']),
  reason: z.string(),
})

/** Terminal step the REAL model produces on the openai-compatible provider: a NATIVE tool_call
 *  to `finalize` carrying the structured decision as its arguments — NOT an Output.object text
 *  blob. This is the whole point of the finalize-tool fix, so every mock here scripts it. */
function finalizeCall(toolCallId: string, decision: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 8, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId, toolName: 'finalize', input: JSON.stringify(decision) }],
    warnings: [],
  }
}

function toolCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}

describe('makeReasoningAgent (finalize-tool mode)', () => {
  it('runs a tool-call step then finalizes via the finalize tool, exposing the decision through readFinalized()', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return toolCall('c1', 'peek', {})
        return finalizeCall('f1', { verdict: 'match', reason: 'metadata lines up' })
      },
    })

    const peekCalls: unknown[] = []
    const { agent, readFinalized } = makeReasoningAgent({
      model,
      tools: {
        peek: tool({
          description: 'peek at something',
          inputSchema: z.object({}),
          execute: async (input) => {
            peekCalls.push(input)
            return { ok: true }
          },
        }),
      },
      instructions: 'Decide match or no_match for the given evidence.',
      schema: DecisionSchema,
    })

    const result = await agent.generate({
      prompt: 'is this a match?',
      abortSignal: AbortSignal.timeout(30_000),
    })

    expect(peekCalls).toHaveLength(1)
    // Decision comes from the finalize tool's captured args, NOT result.output.
    expect(readFinalized()).toEqual({ verdict: 'match', reason: 'metadata lines up' })
    // Step 1 = peek, step 2 = finalize (hasToolCall('finalize') stops the loop here).
    expect(result.steps.length).toBe(2)
  })

  it('finalizes on the very first step when the model calls finalize immediately', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalizeCall('f1', { verdict: 'no_match', reason: 'no evidence' }),
    })
    const { agent, readFinalized } = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema })
    await agent.generate({ prompt: 'p' })
    expect(readFinalized()).toEqual({ verdict: 'no_match', reason: 'no evidence' })
  })

  it('readFinalized() throws if the model ends the loop without ever calling finalize', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: undefined, reasoning: undefined },
        },
        content: [{ type: 'text' as const, text: 'I give up' }],
        warnings: [],
      }),
    })
    const { agent, readFinalized } = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema })
    await agent.generate({ prompt: 'p' })
    expect(() => readFinalized()).toThrow(/finalize/)
  })

  // Diagnosability regression guard (v3 live test matrix, 2026-07-13): the production bug wasn't
  // "finalize never called" — it was "finalize called, but args failed schema validation, so
  // execute() never ran and captured stayed unset". The OLD generic message ("finished without
  // calling the finalize tool") was actively misleading for this case: it reads as if the model
  // never tried, when it did. readFinalized() must now tell these two failure modes apart and
  // surface the raw (invalid) args it saw.
  it('readFinalized() reports that finalize WAS called but failed schema validation, including the raw args, when execute() never ran', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: undefined, reasoning: undefined },
        },
        // Missing the required 'reason' field — DecisionSchema requires it. Mirrors the real
        // production bug: the model omitted/mis-shaped a finalize arg, tool-input schema
        // validation failed BEFORE execute() ever ran, and hasToolCall('finalize') still stopped
        // the loop (it fires on the call's presence, not its validity).
        content: [
          { type: 'tool-call' as const, toolCallId: 'f1', toolName: 'finalize', input: JSON.stringify({ verdict: 'match' }) },
        ],
        warnings: [],
      }),
    })
    const { agent, readFinalized } = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema })
    await agent.generate({ prompt: 'p' })
    let thrown: Error | undefined
    try {
      readFinalized()
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    expect(thrown!.message).toMatch(/finalize/i)
    // Must NOT read as "never called finalize" — it WAS called; the args were invalid.
    expect(thrown!.message).toMatch(/failed schema validation/i)
    // Raw args echoed back for diagnosis.
    expect(thrown!.message).toContain('verdict')
  })

  // Factory-boundary regression guard: proves reasoning:'high' becomes the model's `reasoning`
  // call option even when driven THROUGH makeReasoningAgent (not just generateText directly), so
  // it can't silently regress if the `?? 'high'` default is dropped or the settings cast eats it.
  it('wires reasoning:"high" through to the model doGenerate call options by default (factory boundary)', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalizeCall('f1', { verdict: 'no_match', reason: 'no evidence' }),
    })
    const { agent } = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema })
    await agent.generate({ prompt: 'p' })
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(model.doGenerateCalls[0].reasoning).toBe('high')
  })

  it('wires an explicit reasoning override ("none") through to the model doGenerate call options', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => finalizeCall('f1', { verdict: 'no_match', reason: 'no evidence' }),
    })
    const { agent } = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema, reasoning: 'none' })
    await agent.generate({ prompt: 'p' })
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(model.doGenerateCalls[0].reasoning).toBe('none')
  })

  // 痕迹通道 C：onStepEvent 是每步结算后对该步每个工具调用触发一次的诊断缝（finalize 也算一
  // 步），缺席时必须零行为差异——这组用例只覆盖"传了会发生什么"，其余用例（上面全部）本身就是
  // "不传时现状不变"的回归证据（它们从不传 onStepEvent，且行为与本文件改动前逐字节一致）。
  it('onStepEvent 回调在每个工具调用结算后触发（finalize 也算一步）', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return toolCall('c1', 'peek', { q: 'hello' })
        return finalizeCall('f1', { verdict: 'match', reason: 'metadata lines up' })
      },
    })

    const events: Array<{ tool: string; argsSummary: string; resultSummary: string; tookMs: number; at: number }> = []
    const { agent, readFinalized } = makeReasoningAgent({
      model,
      tools: {
        peek: tool({
          description: 'peek at something',
          inputSchema: z.object({ q: z.string() }),
          execute: async () => ({ found: true }),
        }),
      },
      schema: DecisionSchema,
      onStepEvent: (e) => events.push(e),
    })

    await agent.generate({ prompt: 'is this a match?', abortSignal: AbortSignal.timeout(30_000) })

    expect(readFinalized()).toEqual({ verdict: 'match', reason: 'metadata lines up' })
    // Step 1 = peek (1 tool call), step 2 = finalize (1 tool call) → 2 events total.
    expect(events).toHaveLength(2)
    expect(events[0].tool).toBe('peek')
    expect(events[0].argsSummary).toContain('hello')
    expect(events[0].resultSummary).toContain('found')
    expect(typeof events[0].tookMs).toBe('number')
    expect(events[0].tookMs).toBeGreaterThanOrEqual(0)
    expect(events[1].tool).toBe('finalize')
    expect(events[1].argsSummary).toContain('match')
  })

  it('onStepEvent 抛错不影响 agent 循环与 readFinalized', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return toolCall('c1', 'peek', {})
        return finalizeCall('f1', { verdict: 'no_match', reason: 'nothing found' })
      },
    })

    const { agent, readFinalized } = makeReasoningAgent({
      model,
      tools: {
        peek: tool({
          description: 'peek at something',
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      schema: DecisionSchema,
      onStepEvent: () => { throw new Error('boom — trace sink misbehaving') },
    })

    const result = await agent.generate({ prompt: 'p', abortSignal: AbortSignal.timeout(30_000) })

    expect(readFinalized()).toEqual({ verdict: 'no_match', reason: 'nothing found' })
    expect(result.steps.length).toBe(2)
  })

  // D1 回执截断治理：dispatch_* 工具返回 JSON 回执，200 字符 cap 会拦腰截断导致下游解析失败，
  // 因此仅其 resultSummary 放宽到 400；argsSummary 和其他工具维持 200 不变。
  it('dispatch_* 工具 resultSummary cap 放宽到 400，其余 cap 保持 200', async () => {
    let call = 0
    const longPayload = 'x'.repeat(300)
    const longArgs = 'y'.repeat(250)
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
            usage: {
              inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
            content: [
              { type: 'tool-call' as const, toolCallId: 'd1', toolName: 'dispatch_find_subtitle_task', input: JSON.stringify({ payload: longArgs }) },
              { type: 'tool-call' as const, toolCallId: 's1', toolName: 'search_source', input: JSON.stringify({ payload: longArgs }) },
            ],
            warnings: [],
          }
        }
        return finalizeCall('f1', { verdict: 'match', reason: 'dispatch result parsed' })
      },
    })

    const events: Array<{ tool: string; argsSummary: string; resultSummary: string; tookMs: number; at: number }> = []
    const { agent, readFinalized } = makeReasoningAgent({
      model,
      tools: {
        dispatch_find_subtitle_task: tool({
          description: 'dispatch a task',
          inputSchema: z.object({ payload: z.string() }),
          execute: async () => ({ result: longPayload }),
        }),
        search_source: tool({
          description: 'search source',
          inputSchema: z.object({ payload: z.string() }),
          execute: async () => ({ result: longPayload }),
        }),
      },
      schema: DecisionSchema,
      onStepEvent: (e) => events.push(e),
    })

    await agent.generate({ prompt: 'p', abortSignal: AbortSignal.timeout(30_000) })

    expect(readFinalized()).toEqual({ verdict: 'match', reason: 'dispatch result parsed' })
    const dispatchEvent = events.find((e) => e.tool === 'dispatch_find_subtitle_task')
    const searchEvent = events.find((e) => e.tool === 'search_source')
    expect(dispatchEvent).toBeDefined()
    expect(searchEvent).toBeDefined()

    // dispatch_* 回执是 JSON，需完整存活供下游解析。
    expect(dispatchEvent!.resultSummary.endsWith('…')).toBe(false)
    expect(dispatchEvent!.resultSummary.length).toBeGreaterThanOrEqual(300)
    expect(dispatchEvent!.resultSummary.length).toBeLessThan(400)
    // 普通工具仍维持 200 cap + 省略号。
    expect(searchEvent!.resultSummary.endsWith('…')).toBe(true)
    expect(searchEvent!.resultSummary.length).toBe(201)
    // argsSummary 不受 dispatch 例外影响。
    expect(dispatchEvent!.argsSummary.endsWith('…')).toBe(true)
    expect(dispatchEvent!.argsSummary.length).toBe(201)
  })
})

// THE root-cause regression guard. The live failure (AI_NoObjectGeneratedError against real
// mimo-v2.5) was caused by Output.object injecting `response_format:{type:'json_object'}` into
// every request alongside `tools`, which confused the model into emitting a ReAct text blob
// instead of native tool_calls. finalize-tool mode must send `tools` (including finalize) and
// NEVER `response_format`. This drives makeReasoningAgent through the REAL openai-compatible
// serializer with a spy fetch, exactly mirroring how the live probe proved the poison.
describe('finalize-tool mode over the wire (@ai-sdk/openai-compatible)', () => {
  it('sends `tools` (incl. finalize) but NEVER `response_format`, and keeps reasoning_effort:"high"', async () => {
    const requestBodies: any[] = []
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(init!.body as string))
      return new Response(
        JSON.stringify({
          id: 'x', created: 0, model: 'm',
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_finalize_1',
                type: 'function',
                function: { name: 'finalize', arguments: JSON.stringify({ verdict: 'match', reason: 'metadata lines up' }) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = createOpenAICompatible({
      name: 'subtitle-scout-llm',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      fetch: fetchImpl as unknown as typeof fetch,
    })

    const { agent, readFinalized } = makeReasoningAgent({
      model: provider('test-model'),
      tools: {},
      schema: DecisionSchema,
      reasoning: 'high',
    })
    await agent.generate({ prompt: 'is this a match?' })

    expect(requestBodies).toHaveLength(1)
    const body = requestBodies[0]
    // The poison: must be entirely absent.
    expect(body.response_format).toBeUndefined()
    // Native tool calling is the mechanism — the finalize tool must be advertised.
    expect(Array.isArray(body.tools)).toBe(true)
    expect(body.tools.some((t: any) => t?.function?.name === 'finalize')).toBe(true)
    // reasoning stays on (reasoning_effort:high + native tools works on this model).
    expect(body.reasoning_effort).toBe('high')
    // Decision is read from the finalize tool call the model made natively.
    expect(readFinalized()).toEqual({ verdict: 'match', reason: 'metadata lines up' })
  })
})

describe('reasoning wiring over the wire (@ai-sdk/openai-compatible)', () => {
  it('reasoning:"high" is emitted as reasoning_effort:"high" in the request body', async () => {
    const requestBodies: unknown[] = []
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(init!.body as string))
      return new Response(
        JSON.stringify({
          id: 'x', created: 0, model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = createOpenAICompatible({
      name: 'subtitle-scout-llm',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await generateText({ model: provider('test-model'), prompt: 'hi', reasoning: 'high' })
    expect(requestBodies).toHaveLength(1)
    expect((requestBodies[0] as { reasoning_effort?: string }).reasoning_effort).toBe('high')
  })

  it('reasoning:"none" does NOT emit reasoning_effort (matches isCustomReasoning exclusion)', async () => {
    const requestBodies: unknown[] = []
    const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(init!.body as string))
      return new Response(
        JSON.stringify({
          id: 'x', created: 0, model: 'm',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const provider = createOpenAICompatible({
      name: 'subtitle-scout-llm',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      fetch: fetchImpl as unknown as typeof fetch,
    })
    await generateText({ model: provider('test-model'), prompt: 'hi', reasoning: 'none' })
    expect((requestBodies[0] as { reasoning_effort?: string }).reasoning_effort).toBeUndefined()
  })
})
