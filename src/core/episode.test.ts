import { describe, it, expect } from 'vitest'
import { formatEpisodeCode } from './episode.js'

describe('formatEpisodeCode', () => {
  it('pads season and episode to 2 digits', () => {
    expect(formatEpisodeCode(2, 1)).toBe('S02E01')
    expect(formatEpisodeCode(1, 13)).toBe('S01E13')
  })
  it('does not truncate 3-4 digit episode numbers (long-running anime)', () => {
    expect(formatEpisodeCode(1, 1050)).toBe('S01E1050')
  })
  it('handles season 0 (specials)', () => {
    expect(formatEpisodeCode(0, 5)).toBe('S00E05')
  })
})
