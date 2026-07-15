import { describe, it, expect } from 'vitest'
import { languageName } from './languages.js'

describe('languageName', () => {
  it('resolves zh to Chinese', () => {
    expect(languageName('zh')).toBe('Chinese')
  })

  it('resolves en to English', () => {
    expect(languageName('en')).toBe('English')
  })

  it('falls back to the raw code for an unknown language', () => {
    expect(languageName('xx')).toBe('xx')
  })
})
