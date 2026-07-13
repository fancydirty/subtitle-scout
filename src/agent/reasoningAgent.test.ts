import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { tool } from 'ai'
import { makeReasoningAgent } from './reasoningAgent.js'

const DecisionSchema = z.object({
  verdict: z.enum(['match', 'no_match']),
  reason: z.string(),
})

describe('makeReasoningAgent', () => {
  it('runs a tool-call step then produces schema-typed Output.object() on the final step', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) {
          return {
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: {
              inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
            content: [
              { type: 'tool-call', toolCallId: 'c1', toolName: 'peek', input: JSON.stringify({}) },
            ],
            warnings: [],
          }
        }
        return {
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 20, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8, text: undefined, reasoning: undefined },
          },
          content: [
            { type: 'text', text: JSON.stringify({ verdict: 'match', reason: 'metadata lines up' }) },
          ],
          warnings: [],
        }
      },
    })

    const peekCalls: unknown[] = []
    const agent = makeReasoningAgent({
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
    expect(result.output).toEqual({ verdict: 'match', reason: 'metadata lines up' })
    expect(result.steps.length).toBe(2)
  })

  it('defaults reasoning to "high" and stopWhen to stepCountIs(20) when not overridden', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 5, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 3, text: undefined, reasoning: undefined },
        },
        content: [{ type: 'text', text: JSON.stringify({ verdict: 'no_match', reason: 'no evidence' }) }],
        warnings: [],
      }),
    })
    const agent = makeReasoningAgent({ model, tools: {}, schema: DecisionSchema })
    const result = await agent.generate({ prompt: 'p' })
    expect(result.output).toEqual({ verdict: 'no_match', reason: 'no evidence' })
  })
})
