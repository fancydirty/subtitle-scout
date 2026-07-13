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
