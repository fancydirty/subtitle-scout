import { describe, it, expect } from 'vitest'
import { LIBRARY_SANDBOX_ADDENDUM, withLibrarySandboxPreamble } from './librarySandbox.js'
import { LIBRARY_SANDBOX_SKILL } from './skills/librarySandboxSkill.js'
import { identifySystemPrompt } from './identifyWorker.js'
import { findSubtitleSystemPrompt } from './findSubtitleWorker.js'

describe('librarySandbox preamble', () => {
  it('starts with the production-absent marker', () => {
    expect(LIBRARY_SANDBOX_ADDENDUM.startsWith('LIBRARY SANDBOX TEST')).toBe(true)
  })
  it('off: body unchanged; on: addendum is prefixed', () => {
    expect(withLibrarySandboxPreamble('BODY', false)).toBe('BODY')
    expect(withLibrarySandboxPreamble('BODY', true).startsWith('LIBRARY SANDBOX TEST')).toBe(true)
    expect(withLibrarySandboxPreamble('BODY', true).endsWith('BODY')).toBe(true)
  })
  it('identify default prompt does not mention the test', () => {
    expect(identifySystemPrompt()).not.toContain('LIBRARY SANDBOX TEST')
    expect(identifySystemPrompt(true)).toContain('LIBRARY SANDBOX TEST')
  })
  it('find-subtitle default prompt and skill index omit the test doc', () => {
    const off = findSubtitleSystemPrompt({ librarySandbox: false, identifyOnly: false })
    expect(off.instructions).not.toContain('LIBRARY SANDBOX TEST')
    expect(off.skillNames).not.toContain('library-sandbox-test')
    const on = findSubtitleSystemPrompt({ librarySandbox: true, identifyOnly: false })
    expect(on.instructions.startsWith('LIBRARY SANDBOX TEST')).toBe(true)
    expect(on.skillNames[0]).toBe('library-sandbox-test')
  })
  it('skill name is library-sandbox-test and restates fail-closed', () => {
    expect(LIBRARY_SANDBOX_SKILL.descriptor.name).toBe('library-sandbox-test')
    expect(LIBRARY_SANDBOX_SKILL.content.toLowerCase()).toContain('fail-closed')
  })
})
