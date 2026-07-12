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
  it('carries target identity, candidate metadata, and inspection signal VALUES into the prompt', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    const p = prompt()
    expect(p).toContain('"season":2')
    expect(p).toContain('"episode":5')
    expect(p).toContain('assrt')
    expect(p).toContain('801')
    // Assert actual signal VALUES reached the prompt (not just field names, which also
    // appear in the surrounding prose) — pins that `signals` was actually serialized in.
    expect(p).toContain('320') // signals.cueCount
    expect(p).toContain(String(signals.spanMs))
    expect(p).toContain('zh-Hans') // signals.detectedScript
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

  it('instructs fail-toward-false: cannot tell means match=false', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(prompt()).toMatch(/cannot tell, that is match=false/i)
  })

  it('instructs that inspected file content is ground truth over candidate-claimed metadata', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    const p = prompt()
    // Pins the product-critical instruction: candidate videoName/nativeName/releaseSite is an
    // unverified uploader CLAIM, while inspection signals are the actual downloaded bytes — and
    // when they conflict, a right-looking name over wrong-looking content is NOT a match.
    expect(p).toMatch(/uploader's claim/i)
    expect(p).toMatch(/right-looking name/i)
    expect(p).toMatch(/wrong-looking content/i)
    expect(p).toMatch(/is not a match/i)
    // ordering: the "right-looking name ... wrong-looking content" framing must precede the verdict
    expect(p.toLowerCase().indexOf('right-looking name')).toBeLessThan(p.toLowerCase().indexOf('is not a match'))
  })

  it('returns the parsed {match, reason} from the LLM call', async () => {
    const { llm } = capture()
    const result = await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(result.parsed).toEqual({ match: true, reason: 'matches' })
  })
})
