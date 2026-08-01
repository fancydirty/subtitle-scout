import { describe, test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeCaptchaSolver } from './captchaSolver.js'

const fakeModel = {} as never

// 一张真验证码（读数 02998）+ 一份必不命中的垃圾字节
const REAL = new Uint8Array(readFileSync('fixtures/zimuku/captcha/cap-00.bmp'))
const GARBAGE = new Uint8Array([0x42, 0x4d, 1, 2, 3, 4])

describe('makeCaptchaSolver', () => {
  test('模板命中：直接返回，不调视觉兜底，不发 notice', async () => {
    const solveVision = vi.fn()
    const events: unknown[] = []
    const solve = makeCaptchaSolver({ model: fakeModel, emit: e => events.push(e), solveVision })
    const r = await solve(REAL)
    expect(r).toEqual({ digits: '02998' })
    expect(solveVision).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  test('模板未命中：发 captcha_template_miss notice 并恰好调一次视觉兜底', async () => {
    const solveVision = vi.fn(async () => ({ digits: '12345' }))
    const events: unknown[] = []
    const solve = makeCaptchaSolver({ model: fakeModel, emit: e => events.push(e), solveVision })
    const r = await solve(GARBAGE)
    expect(r).toEqual({ digits: '12345' })
    expect(solveVision).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      expect.objectContaining({ event: 'provider_notice', provider: 'zimuku', code: 'captcha_template_miss' }),
    ])
  })

  test('模板未命中且视觉兜底也失败：返回 digits=null（由接线层转为抛错重试）', async () => {
    const solveVision = vi.fn(async () => { throw new Error('LLM unavailable') })
    const solve = makeCaptchaSolver({ model: fakeModel, emit: () => {}, solveVision })
    const r = await solve(GARBAGE)
    expect(r).toEqual({ digits: null })
  })
})
