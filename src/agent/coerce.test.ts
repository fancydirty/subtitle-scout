import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { coercibleNullableInt, nullableTolerant, tolerantArray } from './coerce.js'

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

// Same motivation as nullableTolerant, one level up: batch finalize's three buckets
// (installed/no_safe_match/retry_later) are arrays, and the real model's "no value" encodings
// for an empty bucket aren't always a clean `[]` — an omitted key, or a string-encoded "None",
// must fold to an empty array rather than hard-failing the whole batch report.
describe('tolerantArray', () => {
  it('parses undefined (an omitted key) to an empty array', () => {
    expect(tolerantArray(z.string()).parse(undefined)).toEqual([])
  })

  it('collapses the string null-sentinels ("None"/"null"/"") to an empty array', () => {
    for (const sentinel of ['None', 'null', '']) {
      expect(tolerantArray(z.string()).parse(sentinel)).toEqual([])
    }
  })

  it('still parses a real array of items unchanged', () => {
    expect(tolerantArray(z.string()).parse(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('still enforces the item schema on non-empty arrays (not a blanket bypass)', () => {
    expect(() => tolerantArray(z.number()).parse(['not-a-number'])).toThrow()
  })
})
