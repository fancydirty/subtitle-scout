import { describe, it, expect, vi } from 'vitest'
import { mapLooseEpisodes } from './mapLooseEpisodes.js'
import type { LlmRuntime } from './runtime.js'
import type { MediaContext, MediaIdentity, SubtitleCandidate } from '../core/schemas.js'
import type { SeasonEpisode } from '../core/episode.js'

const identity: MediaIdentity = {
  canonical_title: 'Show', original_title: 'Show', year: 2020,
  type: 'episode', season: 2, episode: 1, edition: null,
  confidence: 0.95, evidence: ['x'],
}
// mapLooseEpisodes does not read ctx; a stub is sufficient.
const ctx = {} as MediaContext

function ep(n: number, needsChinese = true): SeasonEpisode {
  const code = `S02E0${n}`
  return {
    itemId: `e${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: code,
    videoPath: `/m/Show.${code}.mkv`, videoFilename: `Show.${code}.mkv`, needsChinese,
  }
}

const mk = (id: number, native: string, file: string): SubtitleCandidate => ({
  provider: 'assrt', providerId: String(id),
  videoName: file.replace(/\.(chs|cht)?\.(ass|srt)$/i, ''),
  nativeName: native, language: 'zh', subtype: null, releaseSite: null, uploadDate: null,
  fileList: [{ index: 0, name: file }],
})

type Assignment = { episode_code: string; candidate_id: string }
function mockLlm(assignments: Assignment[]) {
  const call = vi.fn(async (_opts: { prompt: string }) => ({
    parsed: { assignments, reasons: [] },
    rawText: '', retries: 0, durationMs: 1, prompt: '',
  }))
  return { call, llm: { call } as unknown as Pick<LlmRuntime, 'call'> }
}

describe('mapLooseEpisodes', () => {
  it('maps 3 loose candidates to their 3 episodes correctly', async () => {
    const candidates = [
      mk(801, '第1集', 'Show.S02E01.chs.ass'),
      mk(802, '第2集', 'Show.S02E02.chs.ass'),
      mk(803, '第3集', 'Show.S02E03.chs.ass'),
    ]
    const eps = [ep(1), ep(2), ep(3), ep(9, false)] // E09 not needed → must be absent from prompt
    const { call, llm } = mockLlm([
      { episode_code: 'S02E01', candidate_id: 'assrt:801' },
      { episode_code: 'S02E02', candidate_id: 'assrt:802' },
      { episode_code: 'S02E03', candidate_id: 'assrt:803' },
    ])
    const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
    // pass-through of the parsed mapping
    const pairs = result.parsed.assignments.map(a => [a.candidate_id, a.episode_code])
    expect(pairs).toEqual([['assrt:801', 'S02E01'], ['assrt:802', 'S02E02'], ['assrt:803', 'S02E03']])
    // prompt carries the candidate_ids and only the still-needed episode codes
    const prompt = call.mock.calls[0][0].prompt
    expect(prompt).toContain('assrt:801')
    expect(prompt).toContain('S02E01')
    expect(prompt).toContain('S02E03')
    expect(prompt).not.toContain('S02E09') // needsChinese:false episode excluded
  })

  it('instructs the model to skip ambiguous guesses (leave a gap, do not misassign)', async () => {
    const candidates = [mk(801, '第1集', 'Show.S02E01.chs.ass'), mk(802, '模糊', 'Show.mystery.ass')]
    const eps = [ep(1), ep(2)]
    const { call, llm } = mockLlm([{ episode_code: 'S02E01', candidate_id: 'assrt:801' }])
    const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
    expect(result.parsed.assignments).toHaveLength(1)
    expect(result.parsed.assignments.map(a => a.episode_code)).not.toContain('S02E02')
    expect(call.mock.calls[0][0].prompt).toMatch(/safer to leave a gap/i)
    expect(call.mock.calls[0][0].prompt.toLowerCase()).not.toMatch(/confidence < 0\.75/)
  })

  it('instructs the model to assign at most one candidate per episode (double entry → pick one)', async () => {
    // Two candidates both plausibly episode 1.
    const candidates = [
      mk(801, '第1集', 'Show.S02E01.v1.chs.ass'),
      mk(811, '第一集', 'Show.S02E01.v2.cht.ass'),
    ]
    const eps = [ep(1), ep(2)]
    // Model picks the single clearer entry for E01, drops the duplicate.
    const { call, llm } = mockLlm([{ episode_code: 'S02E01', candidate_id: 'assrt:811' }])
    const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
    const forE01 = result.parsed.assignments.filter(a => a.episode_code === 'S02E01')
    expect(forE01).toHaveLength(1)
    expect(forE01[0].candidate_id).toBe('assrt:811')
    expect(call.mock.calls[0][0].prompt).toContain('AT MOST one candidate')
  })
})
