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
})
