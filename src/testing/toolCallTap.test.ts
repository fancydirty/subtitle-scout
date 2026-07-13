// TDD for the out-of-band matrix-runner observability tap: proves (A) a single doGenerate step's
// tool-call parts are captured in order, (B) toolCalls ACCUMULATES across multiple agent steps
// (multiple doGenerate calls on the same wrapped model), and (C) the tap is a transparent
// passthrough — it must never alter what the underlying model returns.
import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider'
import { makeToolCallTap } from './toolCallTap.js'

const MINIMAL_PROMPT: LanguageModelV4CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
}

// `tap.model` is typed as the SDK's `LanguageModel` union (which also admits a bare provider
// registry ID string) — see the guard/comment in toolCallTap.ts. In this suite it is always the
// resolved wrapped instance wrapLanguageModel() returned, so this cast is safe: it lets the tests
// call doGenerate() directly to simulate individual agent steps without a full ToolLoopAgent.
function asModel(m: unknown): LanguageModelV4 { return m as LanguageModelV4 }

/** Same step shape used across the codebase's other ai@7 mock-model tests (see
 *  findSubtitleWorker.eval.test.ts, reasoningAgent.test.ts): a tool-calls step with one or more
 *  `tool-call` content parts, stringified input per LanguageModelV4ToolCall. */
function stepWithToolCalls(calls: Array<{ toolCallId: string; toolName: string; input: unknown }>) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: calls.map(c => ({ type: 'tool-call' as const, toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) })),
    warnings: [],
  }
}

describe('makeToolCallTap', () => {
  it('A: captures every tool-call part from a single doGenerate step, in call order', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => stepWithToolCalls([
        { toolCallId: 'c1', toolName: 'search_source', input: { queries: ['x'] } },
        { toolCallId: 'c2', toolName: 'get_candidate', input: { result_set_id: 'r1', index: 0 } },
      ]),
    })
    const tap = makeToolCallTap(model)

    await asModel(tap.model).doGenerate(MINIMAL_PROMPT)

    expect(tap.toolCalls).toEqual(['search_source', 'get_candidate'])
  })

  it('B: accumulates tool calls across multiple doGenerate calls (simulated agent steps)', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return stepWithToolCalls([{ toolCallId: 'c1', toolName: 'download_candidate', input: { candidateId: 'assrt:1' } }])
        return stepWithToolCalls([{ toolCallId: 'c2', toolName: 'finalize', input: { decision: 'no_safe_match' } }])
      },
    })
    const tap = makeToolCallTap(model)

    await asModel(tap.model).doGenerate(MINIMAL_PROMPT)
    await asModel(tap.model).doGenerate(MINIMAL_PROMPT)

    expect(tap.toolCalls).toEqual(['download_candidate', 'finalize'])
  })

  it('C: passthrough integrity — returns the exact same content/finishReason the underlying model produced', async () => {
    const underlyingResult = stepWithToolCalls([
      { toolCallId: 'c1', toolName: 'check_episode_code_safety', input: { code: 'S01E01' } },
    ])
    const model = new MockLanguageModelV4({ doGenerate: async () => underlyingResult })
    const tap = makeToolCallTap(model)

    const result = await asModel(tap.model).doGenerate(MINIMAL_PROMPT)

    expect(result.content).toEqual(underlyingResult.content)
    expect(result.finishReason).toEqual(underlyingResult.finishReason)
    expect(result.usage).toEqual(underlyingResult.usage)
    expect(result.warnings).toEqual(underlyingResult.warnings)
    // And the tap still observed it — transparency doesn't mean blindness.
    expect(tap.toolCalls).toEqual(['check_episode_code_safety'])
  })
})
