import { describe, it, expect } from 'vitest'
import { FIND_SUBTITLE_SKILL, makeFindSubtitleSkill } from './findSubtitleSkill.js'

describe('FIND_SUBTITLE_SKILL', () => {
  it('is non-empty and states the north-star rules the agent must follow', () => {
    expect(FIND_SUBTITLE_SKILL.descriptor.name).toBe('find-subtitle-judgment')
    expect(FIND_SUBTITLE_SKILL.descriptor.description.length).toBeGreaterThan(0)
    expect(FIND_SUBTITLE_SKILL.content).toMatch(/metadata/i)
    expect(FIND_SUBTITLE_SKILL.content).toMatch(/MUST NOT/i)
    // must not accidentally reference dialogue-content reading — that is the exact anti-pattern
    // this worker replaces (north star #1: judge by metadata, never by reading subtitle text).
    expect(FIND_SUBTITLE_SKILL.content).not.toMatch(/read (the )?dialogue/i)
  })

  // The capability-cognition gap this skill closes (proven by live acceptance): Chinese subtitles
  // are distributed as SEASON PACKS / COMPLETE-SERIES collections far more often than as single
  // episodes. Without being told, the real model hunts for a "clean single episode" that usually
  // does not exist, rejects the packs, and loops without ever calling finalize. The skill must
  // teach that packs are the NORMAL, GOOD form.
  it('teaches that season packs / complete-series collections are the normal, expected form (not to be rejected)', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/season[- ]?pack|complete[- ]series|collection/i)
    // packs are framed as normal/expected/common, not as a defect
    expect(c).toMatch(/normal|expected|common/i)
  })

  it('teaches the filelist → fileIndex workflow for extracting the target episode from a pack', () => {
    const c = FIND_SUBTITLE_SKILL.content
    // the agent scans a pack's filelist (like reading a zip's contents) to find its episode...
    expect(c).toMatch(/filelist|file list|fileList/i)
    // ...then downloads that specific entry by its fileIndex
    expect(c).toMatch(/fileIndex/)
    expect(c).toMatch(/download_candidate/)
  })

  // Absolute-episode locator: packs (esp. anime) often name files by whole-series absolute number
  // instead of season+episode; the system now injects that number. The skill must teach using it to
  // LOCATE the file — but as a verify-first HINT, never a deterministic "number matches -> install"
  // gate (that would regress to Bazarr-style code matching, north star violation).
  it('teaches using a provided absolute episode number to locate an episode in differently-numbered packs, as a verify-first hint', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/absolute episode number/i)
    expect(c).toMatch(/hint/i)                                   // it is a locator hint...
    expect(c).toMatch(/still verify|verify its structural/i)     // ...belonging is STILL verified
  })

  // Coverage-first language (product decision): Simplified and Traditional are equally readable;
  // ranking them is arrogant. Any correct-episode Chinese subtitle is a win; a non-Chinese track is
  // NOT coverage. The skill must carry no 简-first (or 繁-first) preference.
  it('teaches coverage-first language: Simplified and Traditional equally good, non-Chinese is not coverage', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/simplified/i)
    expect(c).toMatch(/traditional/i)
    expect(c).toMatch(/equally good|do not rank|coverage/i)
    expect(c).toMatch(/non-chinese/i)
  })

  // north star: the season-pack teaching must NOT smuggle in a scoring/gating vocabulary. Rather
  // than a brittle absence check (the skill legitimately PROHIBITS confidence scores), assert the
  // existing prohibition survives the rewrite and that no positive threshold/score guidance appears.
  it('retains the north-star prohibition on numeric confidence scores and adds no scoring gate', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/numeric confidence score/i)
    // no "score >= N" / "threshold of" style deterministic gate language introduced
    expect(c).not.toMatch(/threshold|score\s*(>=|>|of\s+\d)/i)
  })
})

// A5: the skill is a per-task factory parameterized by target language. The Chinese wording is
// the canonical, live-acceptance-proven text — every test above pins it via FIND_SUBTITLE_SKILL,
// so the factory's zh output must be byte-identical to it. Non-Chinese targets get the same
// lessons with the target language named and WITHOUT the Chinese-only Hans/Hant script guidance.
describe('makeFindSubtitleSkill (target-language parameterization)', () => {
  it('zh output is byte-identical to the canonical FIND_SUBTITLE_SKILL', () => {
    const zh = makeFindSubtitleSkill('zh')
    expect(zh.content).toBe(FIND_SUBTITLE_SKILL.content)
    expect(zh.descriptor).toEqual(FIND_SUBTITLE_SKILL.descriptor)
  })

  it('non-Chinese target: names the target language, drops all Chinese-specific script wording', () => {
    const en = makeFindSubtitleSkill('en')
    expect(en.descriptor.name).toBe('find-subtitle-judgment') // read_doc lookup name is stable
    expect(en.content).toMatch(/target language is English/)
    expect(en.content).toMatch(/NOT[\s\n]+coverage/i)
    expect(en.content).not.toMatch(/simplified|traditional|zh-Hans|zh-Hant|non-chinese/i)
    expect(en.descriptor.description).toMatch(/English subtitles/)
    expect(en.descriptor.description).not.toMatch(/Simplified and Traditional/)
  })

  it('unknown language code falls back to the bare code in the wording', () => {
    const xx = makeFindSubtitleSkill('xx')
    expect(xx.content).toMatch(/target language is xx/)
  })
})
