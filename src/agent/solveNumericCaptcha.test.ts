import { describe, it, expect } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { solveNumericCaptcha, SolveNumericCaptchaSchema } from './solveNumericCaptcha.js'

/** 每次 doGenerate 调用按序消费一个文本回复;超出数组长度时复用最后一个(镜像 llm.test.ts
 *  callPromptJson 测试里 textModel() 的写法)。 */
function textModel(texts: string[], onGenerate?: (options: unknown) => void) {
  let i = 0
  return new MockLanguageModelV4({
    doGenerate: async options => {
      onGenerate?.(options)
      return {
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: undefined, reasoning: undefined },
        },
        content: [{ type: 'text' as const, text: texts[Math.min(i++, texts.length - 1)] }],
        warnings: [],
      }
    },
  })
}

describe('solveNumericCaptcha', () => {
  it('returns a valid 5-digit reading as {digits}', async () => {
    const model = textModel(['74504'])
    const r = await solveNumericCaptcha(model as never, Buffer.from('fake-png-bytes'))
    expect(r).toEqual({ digits: '74504' })
  })

  it('forwards the image bytes as a file part in the multimodal prompt', async () => {
    let received: unknown
    const model = textModel(['74504'], options => { received = options })
    const png = Buffer.from('fake-png-bytes')
    await solveNumericCaptcha(model as never, png)
    // ai@7 内部把 file part 的 data 再包一层 {type:'data', data: Buffer}（实测,见
    // llm.test.ts 同款 file-part 断言只查 type==='file' 存在,这里多验证一层字节内容本身)。
    const options = received as { prompt: Array<{ content: Array<{ type: string; data?: { data?: unknown } }> }> }
    const filePart = options.prompt[0].content.find(p => p.type === 'file')
    expect(filePart).toBeDefined()
    expect(filePart?.data?.data).toEqual(png)
  })

  it('retries once on a bad first reading then succeeds', async () => {
    let calls = 0
    const model = textModel(['not five digits at all', '74504'], () => { calls++ })
    const r = await solveNumericCaptcha(model as never, Buffer.from('x'))
    expect(r).toEqual({ digits: '74504' })
    expect(calls).toBe(2)
  })

  it('throws a clear error when both readings are invalid', async () => {
    const model = textModel(['nope', 'still nope'])
    await expect(solveNumericCaptcha(model as never, Buffer.from('x')))
      .rejects.toThrow(/did not return a valid 5-digit reading/)
  })
})

describe('SolveNumericCaptchaSchema', () => {
  it('accepts exactly 5-digit strings', () => {
    expect(SolveNumericCaptchaSchema.parse({ digits: '74504' }).digits).toBe('74504')
  })
  it('rejects non-digit or wrong-length lengths', () => {
    expect(() => SolveNumericCaptchaSchema.parse({ digits: '1234' })).toThrow() // 4 位太短
    expect(() => SolveNumericCaptchaSchema.parse({ digits: '123456' })).toThrow() // 6 位太长
    expect(() => SolveNumericCaptchaSchema.parse({ digits: 'abcde' })).toThrow() // 非数字
  })
})
