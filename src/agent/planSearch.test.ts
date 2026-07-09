import { describe, it, expect } from 'vitest'
import { planSearch } from './planSearch.js'
import type { LlmRuntime, RuntimeCallOpts } from './runtime.js'
import type { MediaContext, MediaIdentity } from '../core/schemas.js'
import type { z } from 'zod'

describe('planSearch', () => {
  it('instructs bare Chinese title WITHOUT 第N季 as season-level primary for episodes', async () => {
    let capturedPrompt = ''
    const mockRuntime: LlmRuntime = {
      call: async <S extends z.ZodType>(opts: RuntimeCallOpts<S>) => {
        capturedPrompt = opts.prompt
        return {
          parsed: { queries: [{ q: '测试剧', reason: 'season pack' }] },
          retries: 0,
          usage: { total: 20, input: 10, output: 10, cacheWrite: 0, cacheRead: 0 },
        } as never
      },
      profileInfo: () => ({ mode: 'test' }),
    }

    const ctx: MediaContext = {
      media: {
        type: 'episode',
        filename: 'test.mkv',
        alternative_titles: ['测试剧'],
        year: 2024,
        season: 1,
      },
    } as never

    const identity: MediaIdentity = {
      canonical_title: '测试剧',
      original_title: 'Test Show',
      type: 'episode',
      season: 1,
      episode: 1,
      year: 2024,
      edition: null,
      confidence: 0.95,
      evidence: [],
    }

    await planSearch(mockRuntime, ctx, identity)

    // Assert strategy text instructs bare Chinese title (NO "第N季") as season-level primary
    expect(capturedPrompt).toContain('Use the BARE title WITHOUT season modifiers')
    expect(capturedPrompt).toContain('bare "<Chinese title>" (NO "第N季", NO year)')
    expect(capturedPrompt).toContain('bare title is what actually surfaces season packs')
  })

  it('instructs bare original/English title for season-level when no Chinese title', async () => {
    let capturedPrompt = ''
    const mockRuntime: LlmRuntime = {
      call: async <S extends z.ZodType>(opts: RuntimeCallOpts<S>) => {
        capturedPrompt = opts.prompt
        return {
          parsed: { queries: [{ q: 'Test Show', reason: 'season pack' }] },
          retries: 0,
          usage: { total: 20, input: 10, output: 10, cacheWrite: 0, cacheRead: 0 },
        } as never
      },
      profileInfo: () => ({ mode: 'test' }),
    }

    const ctx: MediaContext = {
      media: {
        type: 'episode',
        filename: 'test.mkv',
        alternative_titles: [],
        year: 2024,
        season: 1,
      },
    } as never

    const identity: MediaIdentity = {
      canonical_title: 'Test Show',
      original_title: 'Test Show',
      type: 'episode',
      season: 1,
      episode: 1,
      year: 2024,
      edition: null,
      confidence: 0.95,
      evidence: [],
    }

    await planSearch(mockRuntime, ctx, identity)

    // Assert bare original/English title is used when no Chinese title (accounting for line breaks)
    expect(capturedPrompt).toContain('"<original/English title>"')
    expect(capturedPrompt).toContain('bare title is what actually surfaces season packs')
  })
})
