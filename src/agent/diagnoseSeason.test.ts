import { describe, it, expect, vi } from 'vitest'
import {
  diagnoseSeason, extractStructuredRejections, DiagnosisVerdictSchema,
} from './diagnoseSeason.js'
import type { LlmRuntime } from './runtime.js'
// mirrorExceedsSeasonTable moved to core/seasonShape.ts — its tests live in core/seasonShape.test.ts.

describe('diagnoseSeason', () => {
  it('主信号不成立 → 直接返回 unknown，不调用 LLM（省一次调用）', async () => {
    const llm: LlmRuntime = { call: vi.fn(), profileInfo: () => ({ mode: 'forced-tool' }) }
    const result = await diagnoseSeason(llm, { seriesId: 's1', season: 1, mirrorEpisodeCount: 12, tmdbEpisodeCount: 25 }, [], [])
    expect(result.parsed.verdict).toBe('unknown')
    expect(llm.call).not.toHaveBeenCalled()
  })

  it('主信号成立 → 调用 LLM，携带镜像/TMDB 集数对比 + 最近 runs + 结构化拒绝理由', async () => {
    const call = vi.fn(async (_opts: { prompt: string }) => ({
      parsed: { verdict: 'absolute_flat' as const, reason: '镜像 40 集远超 TMDB 25 集，且拒绝理由多为身份不符' },
      rawText: '', retries: 0, durationMs: 0, prompt: '',
    }))
    const llm = { call, profileInfo: () => ({ mode: 'forced-tool' }) } as unknown as LlmRuntime
    const result = await diagnoseSeason(
      llm, { seriesId: 's1', season: 1, mirrorEpisodeCount: 40, tmdbEpisodeCount: 25 },
      [{ decision: 'no_safe_match', detail: '没找到合适的中文字幕' }],
      ['wrong season entirely', 'wrong season entirely'],
    )
    expect(result.parsed.verdict).toBe('absolute_flat')
    expect(call).toHaveBeenCalledTimes(1)
    const prompt = call.mock.calls[0][0].prompt
    expect(prompt).toContain('40')
    expect(prompt).toContain('25')
    expect(prompt).toContain('wrong season entirely')
  })
})

describe('DiagnosisVerdictSchema', () => {
  it('拒绝非法 verdict 枚举值', () => {
    expect(DiagnosisVerdictSchema.safeParse({ verdict: 'maybe', reason: 'x' }).success).toBe(false)
  })
})

describe('extractStructuredRejections', () => {
  it('从 decision.json 形状里提取 rankCandidates 的 rejected[].reason', () => {
    const doc = JSON.stringify({
      llm_calls: [
        { point: 'rankCandidates', parsed: { rejected: [{ candidate_id: 'a:1', reason: 'wrong season entirely' }] } },
        { point: 'identifyMedia', parsed: {} },
      ],
    })
    expect(extractStructuredRejections('/fake/decision.json', () => doc)).toEqual(['wrong season entirely'])
  })
  it('文件缺失/JSON 损坏 → fail-soft 返回空数组', () => {
    expect(extractStructuredRejections('/nope.json', () => { throw new Error('ENOENT') })).toEqual([])
  })
  it('llm_calls 缺失/形状不对 → 空数组', () => {
    expect(extractStructuredRejections('/x.json', () => '{}')).toEqual([])
  })
})
