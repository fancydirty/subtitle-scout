import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZimukuSessionStore } from './zimukuSession.js'

describe('ZimukuSessionStore', () => {
  const store = () => new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-session-')))

  it('returns null when nothing cached yet', () => {
    expect(store().get()).toBeNull()
  })

  it('round-trips a session', () => {
    const s = store()
    s.put({ cookie: 'security_session_verify=abc123', capturedAt: 1000 })
    expect(s.get()).toEqual({ cookie: 'security_session_verify=abc123', capturedAt: 1000 })
  })

  it('invalidate clears the cached session', () => {
    const s = store()
    s.put({ cookie: 'security_session_verify=abc123', capturedAt: 1000 })
    s.invalidate()
    expect(s.get()).toBeNull()
  })

  it('treats a malformed cache file as a miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-session-'))
    const s = new ZimukuSessionStore(dir)
    s.put({ cookie: 'x', capturedAt: 1 })
    const f = readdirSync(dir).find(f => f.endsWith('.json'))!
    writeFileSync(join(dir, f), '{corrupt')
    expect(s.get()).toBeNull()
  })

  it('invalidate on an empty store is a no-op (no throw)', () => {
    expect(() => store().invalidate()).not.toThrow()
  })
})
