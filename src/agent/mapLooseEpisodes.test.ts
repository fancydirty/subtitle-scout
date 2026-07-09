import { describe, it, expect, vi } from 'vitest'
import { mapLooseEpisodes } from './mapLooseEpisodes.js'
import type { LlmRuntime } from './runtime.js'
import type { MediaContext, MediaIdentity, AssrtSub } from '../core/schemas.js'
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

const mk = (id: number, native: string, file: string): AssrtSub =>
  ({ id, videoname: file.replace(/\.(chs|cht)?\.(ass|srt)$/i, ''), native_name: native, filelist: [{ f: file }] } as unknown as AssrtSub)

type Assignment = { episode_code: string; sub_id: number; confidence: number }
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
      { episode_code: 'S02E01', sub_id: 801, confidence: 0.95 },
      { episode_code: 'S02E02', sub_id: 802, confidence: 0.95 },
      { episode_code: 'S02E03', sub_id: 803, confidence: 0.95 },
    ])
    const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
    // pass-through of the parsed mapping
    const pairs = result.parsed.assignments.map(a => [a.sub_id, a.episode_code])
    expect(pairs).toEqual([[801, 'S02E01'], [802, 'S02E02'], [803, 'S02E03']])
    // prompt carries the candidate sub_ids and only the still-needed episode codes
    const prompt = call.mock.calls[0][0].prompt
    expect(prompt).toContain('801')
    expect(prompt).toContain('S02E01')
    expect(prompt).toContain('S02E03')
    expect(prompt).not.toContain('S02E09') // needsChinese:false episode excluded
  })

  it('instructs the model to skip low-confidence guesses (leave a gap, do not misassign)', async () => {
    const candidates = [mk(801, '第1集', 'Show.S02E01.chs.ass'), mk(802, '模糊', 'Show.mystery.ass')]
    const eps = [ep(1), ep(2)]
    // Model obeys the <0.75 rule: only the confident E01 comes back, E02 left unassigned.
    const { call, llm } = mockLlm([{ episode_code: 'S02E01', sub_id: 801, confidence: 0.95 }])
    const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
    expect(result.parsed.assignments).toHaveLength(1)
    expect(result.parsed.assignments.map(a => a.episode_code)).not.toContain('S02E02')
    expect(call.mock.calls[0][0].prompt).toContain('confidence < 0.75')
  })

  it('instructs the model to assign at most one candidate per episode (double entry → pick one)', async () => {
    // Two candidates both plausibly episode 1.
    const candidates = [
      mk(801, '第1集', 'Show.S02E01.v1.chs.ass'),
      mk(811, '第一集', 'Show.S02E01.v2.cht.ass'),
    ]
    const eps = [ep(1), ep(2)]
    // Model picks the single most-confident entry for E01, drops the duplicate.
    const { call, llm } = mockLlm([{ episode_code: 'S02E01', sub_id: 811, confidence: 0.92 }])
    const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
    const forE01 = result.parsed.assignments.filter(a => a.episode_code === 'S02E01')
    expect(forE01).toHaveLength(1)
    expect(forE01[0].sub_id).toBe(811)
    expect(call.mock.calls[0][0].prompt).toContain('AT MOST one candidate')
  })
})
