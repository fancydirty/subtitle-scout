import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore } from './profile.js'
import { QUIRK_BODIES } from './quirks.js'

describe('QUIRK_BODIES', () => {
  it('starts with the DeepSeek thinking-disable quirk', () => {
    expect(QUIRK_BODIES[0].id).toBe('deepseek-thinking-disabled')
    expect(QUIRK_BODIES[0].body).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('ProfileStore', () => {
  const store = () => new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))

  it('round-trips a profile keyed by baseUrl+model', () => {
    const s = store()
    s.put('https://api.x.com/v1', 'm1', {
      mode: 'forced-tool-quirk', quirkId: 'deepseek-thinking-disabled',
      extraBody: { thinking: { type: 'disabled' } }, evidence: 'probe',
    })
    const p = s.get('https://api.x.com/v1', 'm1')
    expect(p?.mode).toBe('forced-tool-quirk')
    expect(p?.extraBody).toEqual({ thinking: { type: 'disabled' } })
  })

  it('different model = different profile', () => {
    const s = store()
    s.put('https://api.x.com/v1', 'm1', { mode: 'forced-tool', evidence: 'probe' })
    expect(s.get('https://api.x.com/v1', 'm2')).toBeNull()
  })

  it('expires after ttl and honors invalidate', () => {
    const s = store()
    s.put('u', 'm', { mode: 'forced-tool', evidence: 'probe' }, -1)
    expect(s.get('u', 'm')).toBeNull()
    s.put('u', 'm', { mode: 'forced-tool', evidence: 'probe' })
    s.invalidate('u', 'm')
    expect(s.get('u', 'm')).toBeNull()
  })

  it('treats malformed profile files as cache miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prof-'))
    const s = new ProfileStore(dir)
    s.put('u', 'm', { mode: 'forced-tool', evidence: 'x' })
    // 直接损坏磁盘文件
    const f = readdirSync(dir).find(f => f.endsWith('.json'))!
    writeFileSync(join(dir, f), '{corrupt')
    expect(s.get('u', 'm')).toBeNull()
  })
})
