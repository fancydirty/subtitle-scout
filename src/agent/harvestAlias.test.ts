import { describe, it, expect, vi } from 'vitest'
import { hasCjk, harvestAlias } from './harvestAlias.js'
import type { LlmRuntime } from './runtime.js'

describe('hasCjk', () => {
  it('returns true for Chinese characters', () => {
    expect(hasCjk('爱，死亡与机器人')).toBe(true)
    expect(hasCjk('Love, Death & Robots 爱死机')).toBe(true)
    expect(hasCjk('第二季')).toBe(true)
  })

  it('returns false for non-CJK strings', () => {
    expect(hasCjk('Love, Death & Robots')).toBe(false)
    expect(hasCjk('The Matrix 1999')).toBe(false)
    expect(hasCjk('S04E01.1080p.BluRay')).toBe(false)
    expect(hasCjk('')).toBe(false)
  })
})

describe('harvestAlias', () => {
  const mockLlm = (alias: string | null, confidence: number) => {
    const call = vi.fn(async (_opts: { prompt: string }) => ({
      parsed: { alias, confidence },
      rawText: '',
      retries: 0,
      durationMs: 1,
      prompt: '',
    }))
    return { mock: call, llm: { call } as unknown as Pick<LlmRuntime, 'call'> }
  }

  it('extracts Chinese alias from candidates with high confidence', async () => {
    const { llm, mock } = mockLlm('爱，死亡与机器人', 0.95)
    const candidateNames = [
      '爱、死亡与机器人.Love.Death.and.Robots.S04',
      'Love.Death.and.Robots.S04E01.1080p',
      '爱，死亡与机器人 第四季',
    ]
    const result = await harvestAlias(llm, 'Love, Death & Robots', candidateNames)
    expect(result).toBe('爱，死亡与机器人')
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('returns null when no CJK candidates exist (skips LLM call)', async () => {
    const { llm, mock } = mockLlm('should not be called', 0.95)
    const candidateNames = [
      'Love.Death.and.Robots.S04E01.1080p',
      'The.Matrix.1999.BluRay.x264',
    ]
    const result = await harvestAlias(llm, 'Love, Death & Robots', candidateNames)
    expect(result).toBe(null)
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns null when LLM confidence is too low', async () => {
    const { llm } = mockLlm('爱，死亡与机器人', 0.65)
    const candidateNames = ['爱、死亡与机器人.Love.Death.and.Robots.S04']
    const result = await harvestAlias(llm, 'Love, Death & Robots', candidateNames)
    expect(result).toBe(null)
  })

  it('returns null when LLM returns null alias', async () => {
    const { llm } = mockLlm(null, 0.95)
    const candidateNames = ['爱、死亡与机器人.Love.Death.and.Robots.S04']
    const result = await harvestAlias(llm, 'Love, Death & Robots', candidateNames)
    expect(result).toBe(null)
  })

  it('returns null when extracted alias has no CJK characters', async () => {
    const { llm } = mockLlm('Love Death Robots', 0.95)
    const candidateNames = ['爱、死亡与机器人.Love.Death.and.Robots.S04']
    const result = await harvestAlias(llm, 'Love, Death & Robots', candidateNames)
    expect(result).toBe(null)
  })

  it('returns null when alias is same as original title', async () => {
    const { llm } = mockLlm('The Matrix', 0.95)
    const candidateNames = ['The.Matrix.1999.BluRay']
    const result = await harvestAlias(llm, 'The Matrix', candidateNames)
    expect(result).toBe(null)
  })

  it('returns null when alias is all ASCII', async () => {
    const { llm } = mockLlm('Matrix', 0.95)
    const candidateNames = ['黑客帝国.The.Matrix.1999']
    const result = await harvestAlias(llm, 'The Matrix', candidateNames)
    expect(result).toBe(null)
  })

  it('prompt instructs the LLM to strip season/episode markers and release tags', async () => {
    const { llm, mock } = mockLlm('爱，死亡与机器人', 0.95)
    await harvestAlias(llm, 'Love, Death & Robots', ['爱，死亡与机器人 第四季.S04.1080p'])
    const opts = mock.mock.calls[0][0]
    expect(opts.prompt).toContain('Return ONLY the show title itself')
    expect(opts.prompt).toContain('strip season/episode markers')
    expect(opts.prompt).toContain('第X季/SxxExx')
  })
})
