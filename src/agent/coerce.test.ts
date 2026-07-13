import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { coercibleNullableInt, nullableTolerant } from './coerce.js'
import { FindSubtitleDecisionSchema } from './findSubtitleWorker.schemas.js'

// Root-cause regression guard (v3 live matrix, 2026-07-13): the real model (mimo-v2.5) OMITS
// the four installed-only fields entirely on a no_safe_match finalize — it doesn't send them as
// JSON null or a "None" string, it just doesn't include the key. That makes the value `undefined`
// at parse time, not one of the string sentinels isNullishSentinel() was checking for, and
// `.nullable()` alone rejects `undefined` (only `.nullish()`/`.optional()` accept it). The finalize
// tool-call's inputSchema validation failed BEFORE execute() ever ran, captured never got set, and
// readFinalized() threw a misleading "finished without calling finalize" — the call WAS made.
describe('nullableTolerant', () => {
  it('parses undefined (an omitted key) to null for a plain string inner schema', () => {
    expect(nullableTolerant(z.string()).parse(undefined)).toBeNull()
  })

  it('parses undefined (an omitted key) to null for a nullable ENUM inner schema', () => {
    expect(nullableTolerant(z.enum(['zh-Hans', 'zh-Hant'])).parse(undefined)).toBeNull()
  })

  it('still collapses the string null-sentinels to null (no regression)', () => {
    for (const sentinel of ['None', 'null', '', 'NONE']) {
      expect(nullableTolerant(z.string()).parse(sentinel)).toBeNull()
    }
  })

  it('still accepts a real null and a real value unchanged', () => {
    expect(nullableTolerant(z.string()).parse(null)).toBeNull()
    expect(nullableTolerant(z.string()).parse('real-value')).toBe('real-value')
  })
})

describe('coercibleNullableInt', () => {
  it('parses undefined (an omitted key) to null', () => {
    expect(coercibleNullableInt.parse(undefined)).toBeNull()
  })

  it('still collapses string null-sentinels to null and coerces string numbers (no regression)', () => {
    expect(coercibleNullableInt.parse('None')).toBeNull()
    expect(coercibleNullableInt.parse('10')).toBe(10)
  })
})

describe('FindSubtitleDecisionSchema (end-to-end omitted-keys case)', () => {
  it('parses a no_safe_match finalize with all four installed-only fields OMITTED entirely', () => {
    const parsed = FindSubtitleDecisionSchema.parse({
      decision: 'no_safe_match',
      reason: 'no candidate plausibly named this episode',
      // installedPath / installedLanguage / candidateProvider / candidateProviderId all omitted —
      // this is the real-model arg shape observed live, not a hypothetical.
    })
    expect(parsed.installedPath).toBeNull()
    expect(parsed.installedLanguage).toBeNull()
    expect(parsed.candidateProvider).toBeNull()
    expect(parsed.candidateProviderId).toBeNull()
  })
})
