import { describe, it, expect } from 'vitest'
import { solveNumericCaptcha, SolveNumericCaptchaSchema } from './solveNumericCaptcha.js'
import type { LlmRuntime, RuntimeCallOpts } from './runtime.js'

function capture(): { llm: LlmRuntime; opts: () => RuntimeCallOpts<typeof SolveNumericCaptchaSchema> } {
  let captured!: RuntimeCallOpts<typeof SolveNumericCaptchaSchema>
  // PLAN NOTE: LlmRuntime.call is generic (`call<S extends z.ZodType>(...)`) — an object literal
  // whose `call` method returns a fixed concrete shape can't structurally satisfy that generic
  // signature under tsc (confirmed: TS2322 "Type ... is not assignable to type '<S extends
  // z.ZodType>(opts: RuntimeCallOpts<S>) => ...'"). Cast through `unknown`, matching the existing
  // fake-LlmRuntime pattern used by harvestAlias.test.ts (`{ call } as unknown as
  // Pick<LlmRuntime, 'call'>`), rather than typing the object literal as `LlmRuntime` directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (opts: any) => {
    captured = opts
    return { parsed: { digits: '74504' }, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt }
  }
  const llm = { call, profileInfo: () => ({ mode: 'test' }) } as unknown as LlmRuntime
  return { llm, opts: () => captured }
}

describe('solveNumericCaptcha', () => {
  it('passes the image bytes through to llm.call as images: [imageBytes]', async () => {
    const { llm, opts } = capture()
    const png = Buffer.from('fake-png-bytes')
    await solveNumericCaptcha(llm, png)
    expect(opts().images).toEqual([png])
  })

  it('uses the SolveNumericCaptchaSchema (digits-only, no confidence field)', async () => {
    const { llm, opts } = capture()
    await solveNumericCaptcha(llm, Buffer.from('x'))
    expect(opts().schema).toBe(SolveNumericCaptchaSchema)
  })

  it('prompt asks for 3-6 digits with no confidence hedging', async () => {
    const { llm, opts } = capture()
    await solveNumericCaptcha(llm, Buffer.from('x'))
    expect(opts().prompt).toMatch(/3 to 6/)
    expect(opts().prompt.toLowerCase()).not.toContain('confidence')
  })

  it('returns the parsed {digits} from the LLM call', async () => {
    const { llm } = capture()
    const r = await solveNumericCaptcha(llm, Buffer.from('x'))
    expect(r.parsed).toEqual({ digits: '74504' })
  })
})

describe('SolveNumericCaptchaSchema', () => {
  it('accepts 3-6 digit strings', () => {
    expect(SolveNumericCaptchaSchema.parse({ digits: '745' }).digits).toBe('745')
    expect(SolveNumericCaptchaSchema.parse({ digits: '123456' }).digits).toBe('123456')
  })
  it('rejects non-digit or out-of-range lengths', () => {
    expect(() => SolveNumericCaptchaSchema.parse({ digits: '12' })).toThrow()
    expect(() => SolveNumericCaptchaSchema.parse({ digits: '1234567' })).toThrow()
    expect(() => SolveNumericCaptchaSchema.parse({ digits: 'abcde' })).toThrow()
  })
})
