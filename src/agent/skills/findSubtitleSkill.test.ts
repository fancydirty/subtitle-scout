import { describe, it, expect } from 'vitest'
import { FIND_SUBTITLE_SKILL } from './findSubtitleSkill.js'

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
