import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { MockLanguageModelV4 } from 'ai/test'
import { callStructured } from './llm.js'

const schema = z.object({ title: z.string(), year: z.number() })

function mockModelReturningToolCall(args: object) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: undefined, reasoning: undefined },
      },
      content: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'report',
          input: JSON.stringify(args),
        },
      ],
      warnings: [],
    }),
  })
}

describe('callStructured', () => {
  it('returns parsed object from forced tool call', async () => {
    const model = mockModelReturningToolCall({ title: 'The Matrix', year: 1999 })
    const r = await callStructured({
      model,
      name: 'report',
      description: 'report result',
      prompt: 'identify',
      schema,
    })
    expect(r.parsed).toEqual({ title: 'The Matrix', year: 1999 })
    expect(r.retries).toBe(0)
  })

  it('retries once when output fails schema, then surfaces error', async () => {
    const model = mockModelReturningToolCall({ title: 'The Matrix' }) // missing year
    await expect(
      callStructured({
        model,
        name: 'report',
        description: 'd',
        prompt: 'p',
        schema,
      }),
    ).rejects.toThrow(/schema|validation/i)
  })

  it('retries once when output fails schema, then succeeds', async () => {
    let callCount = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount++
        const args = callCount === 1 ? { title: 'The Matrix' } : { title: 'The Matrix', year: 1999 }
        return {
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [
            {
              type: 'tool-call',
              toolCallId: `c${callCount}`,
              toolName: 'report',
              input: JSON.stringify(args),
            },
          ],
          warnings: [],
        }
      },
    })

    const r = await callStructured({
      model,
      name: 'report',
      description: 'report result',
      prompt: 'identify',
      schema,
    })
    expect(r.parsed).toEqual({ title: 'The Matrix', year: 1999 })
    expect(r.retries).toBe(1)
  })

  it('throws ToolChoiceRejectionError immediately on provider tool_choice rejection without retrying', async () => {
    const { ToolChoiceRejectionError } = await import('./llm.js')
    let callCount = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        callCount++
        throw new Error('Thinking mode does not support this tool_choice')
      },
    })
    await expect(
      callStructured({
        model,
        name: 'report',
        description: 'd',
        prompt: 'p',
        schema,
      }),
    ).rejects.toThrow(ToolChoiceRejectionError)
    expect(callCount).toBe(1) // 绝不重试
  })
})

describe('callStructured with images (multimodal captcha solving)', () => {
  it('sends the image as a file part alongside the text prompt when opts.images is provided', async () => {
    let receivedPrompt: unknown
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        receivedPrompt = (options as { prompt: unknown }).prompt
        return {
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'report', input: JSON.stringify({ digits: '74504' }) },
          ],
          warnings: [],
        }
      },
    })
    const png = Buffer.from('fake-png-bytes')
    const r = await callStructured({
      model, name: 'report', description: 'd', prompt: 'read the digits',
      schema: z.object({ digits: z.string() }), images: [png],
    })
    expect(r.parsed).toEqual({ digits: '74504' })
    const messages = receivedPrompt as Array<{ role: string; content: Array<{ type: string; data?: unknown; mediaType?: string }> }>
    expect(messages[0].role).toBe('user')
    expect(messages[0].content[0]).toEqual({ type: 'text', text: 'read the digits' })
    expect(messages[0].content[1].type).toBe('file')
    expect(messages[0].content[1].mediaType).toBe('image/png')
  })

  it('falls back to a plain string prompt when opts.images is omitted (existing text-only callers unaffected)', async () => {
    let receivedPrompt: unknown
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        receivedPrompt = (options as { prompt: unknown }).prompt
        return {
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'report', input: JSON.stringify({ title: 'x', year: 1 }) },
          ],
          warnings: [],
        }
      },
    })
    await callStructured({ model, name: 'report', description: 'd', prompt: 'identify', schema })
    // PLAN NOTE: ai@7's generateText normalizes even a bare string prompt into a single
    // user/text-part message *before* doGenerate ever sees it (verified experimentally —
    // `typeof receivedPrompt` is 'object' here regardless of whether callStructured passes a
    // string or an equivalent one-part message array to generateText). So `typeof === 'string'`
    // can never be observed at this boundary — asserting it would make this test permanently
    // un-passable. What's actually observable and what matters for "text-only callers
    // unaffected" is that no file part gets appended when opts.images is omitted: the normalized
    // shape here must be byte-identical to what generateText produces for a plain string prompt.
    expect(receivedPrompt).toEqual([{ role: 'user', content: [{ type: 'text', text: 'identify' }] }])
  })
})

describe('injectExtraBody', () => {
  it('merges extra fields into a JSON string body', async () => {
    const { injectExtraBody } = await import('./llm.js')
    const init = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) }
    const out = injectExtraBody(init, { thinking: { type: 'disabled' } })
    expect(JSON.parse(out!.body as string)).toEqual({
      model: 'm', messages: [], thinking: { type: 'disabled' },
    })
  })
  it('passes through non-JSON bodies and undefined init', async () => {
    const { injectExtraBody } = await import('./llm.js')
    expect(injectExtraBody(undefined, { a: 1 })).toBeUndefined()
    const blobInit = { body: new Uint8Array([1]) as unknown as BodyInit }
    expect(injectExtraBody(blobInit, { a: 1 })).toBe(blobInit)
  })
})

describe('extractJson', () => {
  it('parses bare JSON', async () => {
    const { extractJson } = await import('./llm.js')
    expect(extractJson('{"ok":true}')).toEqual({ ok: true })
  })
  it('parses fenced JSON', async () => {
    const { extractJson } = await import('./llm.js')
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })
  it('parses JSON embedded in prose', async () => {
    const { extractJson } = await import('./llm.js')
    expect(extractJson('Sure! Here it is: {"a":{"b":1}} hope that helps')).toEqual({ a: { b: 1 } })
  })
  it('throws on no JSON', async () => {
    const { extractJson } = await import('./llm.js')
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('isToolChoiceRejection', () => {
  it('true only for ToolChoiceRejectionError instances', async () => {
    const { isToolChoiceRejection, ToolChoiceRejectionError, StructuredOutputError } = await import('./llm.js')
    expect(isToolChoiceRejection(new ToolChoiceRejectionError(new Error('Thinking mode does not support this tool_choice')))).toBe(true)
    // 关键回归：模型输出里带 "thinking mode" 的普通校验失败绝不能误判
    expect(isToolChoiceRejection(new StructuredOutputError('schema validation failed: raw tool input was: {"reason":"movie about thinking mode"}'))).toBe(false)
    expect(isToolChoiceRejection(new Error('tool_choice is not supported'))).toBe(false)
  })
})

describe('AbortSignal timeout coverage', () => {
  it('callStructured passes abortSignal to generateText', async () => {
    let receivedSignal: AbortSignal | undefined
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        receivedSignal = (options as unknown as { abortSignal?: AbortSignal }).abortSignal
        return {
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'report',
              input: JSON.stringify({ title: 'The Matrix', year: 1999 }),
            },
          ],
          warnings: [],
        }
      },
    })
    await callStructured({
      model,
      name: 'report',
      description: 'report result',
      prompt: 'identify',
      schema,
    })
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
  })
})

describe('callPromptJson', () => {
  function textModel(texts: string[]) {
    let i = 0
    return new MockLanguageModelV4({
      doGenerate: async () => ({
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)] }],
        warnings: [],
      }),
    })
  }

  it('parses valid JSON text output', async () => {
    const { callPromptJson } = await import('./llm.js')
    const r = await callPromptJson({
      model: textModel(['{"title":"The Matrix","year":1999}']) as never,
      name: 'report', description: 'd', prompt: 'identify',
      schema: z.object({ title: z.string(), year: z.number() }),
    })
    expect(r.parsed).toEqual({ title: 'The Matrix', year: 1999 })
    expect(r.retries).toBe(0)
  })

  it('retries once on schema failure then succeeds', async () => {
    const { callPromptJson } = await import('./llm.js')
    const r = await callPromptJson({
      model: textModel(['{"title":"x"}', '{"title":"x","year":1999}']) as never,
      name: 'report', description: 'd', prompt: 'identify',
      schema: z.object({ title: z.string(), year: z.number() }),
    })
    expect(r.retries).toBe(1)
  })

  it('throws StructuredOutputError after retry exhausted', async () => {
    const { callPromptJson, StructuredOutputError } = await import('./llm.js')
    await expect(callPromptJson({
      model: textModel(['not json at all']) as never,
      name: 'report', description: 'd', prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
    })).rejects.toThrow(StructuredOutputError)
  })
})
