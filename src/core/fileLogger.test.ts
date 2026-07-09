import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFileLogger } from './fileLogger.js'

describe('makeFileLogger', () => {
  it('writes dated files and rolls over at midnight', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flog-'))
    let now = Date.parse('2026-07-07T10:00:00Z')
    const log = makeFileLogger(dir, 30, () => now)
    log('first')
    now = Date.parse('2026-07-08T01:00:00Z')
    log('second')
    const files = readdirSync(dir).sort()
    expect(files.length).toBe(2)
    expect(readFileSync(join(dir, files[0]), 'utf8')).toContain('first')
    expect(readFileSync(join(dir, files[1]), 'utf8')).toContain('second')
  })
  it('prunes files older than retainDays', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flog-'))
    writeFileSync(join(dir, 'watch-2026-01-01.log'), 'old')
    let now = Date.parse('2026-07-07T10:00:00Z')
    const log = makeFileLogger(dir, 30, () => now)
    log('trigger cleanup')
    expect(readdirSync(dir).some(f => f.includes('2026-01-01'))).toBe(false)
  })
})
