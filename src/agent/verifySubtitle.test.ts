import { describe, it, expect } from 'vitest'
import { verifySubtitle } from './verifySubtitle.js'
import type { LlmRuntime } from './runtime.js'
import type { MediaContext, MediaIdentity, SubtitleCandidate, VerifyDecision } from '../core/schemas.js'
import type { InspectSignals } from '../files/subtitleInspect.js'

function capture(): { llm: LlmRuntime; prompt: () => string } {
  let captured = ''
  const llm: LlmRuntime = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async call(opts: any) {
      captured = opts.prompt
      const parsed: VerifyDecision = { match: true, reason: 'matches' }
      return { parsed, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt } as any
    },
    profileInfo: () => ({ mode: 'test' }),
  }
  return { llm, prompt: () => captured }
}

const ctx = {
  media: { filename: 'Show.S02E05.1080p.mkv', runtime_minutes: 45 },
} as unknown as MediaContext
const identity: MediaIdentity = {
  canonical_title: 'Show', original_title: null, year: 2020, type: 'episode',
  season: 2, episode: 5, edition: null, confidence: 0.9, evidence: [],
}
const candidate: SubtitleCandidate = {
  provider: 'assrt', providerId: '801', videoName: 'Show.S02E05.WEB-DL',
  nativeName: '节目 第5集', language: 'zh', subtype: null, releaseSite: '字幕组X', uploadDate: null,
  fileList: [],
}
const signals: InspectSignals = {
  decodable: true, isHtml: false, cueCount: 320,
  firstCueMs: 1000, lastCueMs: 44 * 60_000, spanMs: 44 * 60_000 - 1000,
  detectedScript: 'zh-Hans',
}

describe('verifySubtitle prompt', () => {
  it('carries target identity, candidate metadata, and inspection signals into the prompt', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    const p = prompt()
    expect(p).toContain('"season":2')
    expect(p).toContain('"episode":5')
    expect(p).toContain('assrt')
    expect(p).toContain('801')
    expect(p).toContain('cueCount')
    expect(p).toContain('zh-Hans')
  })

  it('never asks for or mentions a confidence score', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(prompt().toLowerCase()).not.toMatch(/confidence score|report.*confidence/i)
  })

  it('instructs the model to treat a wrong install as worse than a gap', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(prompt()).toMatch(/worse than no subtitle/i)
  })

  it('returns the parsed {match, reason} from the LLM call', async () => {
    const { llm } = capture()
    const result = await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(result.parsed).toEqual({ match: true, reason: 'matches' })
  })
})
