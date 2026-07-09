import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneOldDirs } from './retention.js'

describe('pruneOldDirs', () => {
  it('removes directories older than retainDays, keeps fresh ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'ret-'))
    const oldDir = join(root, 'item-100')
    const newDir = join(root, 'item-200')
    mkdirSync(oldDir); writeFileSync(join(oldDir, 'decision.json'), '{}')
    mkdirSync(newDir); writeFileSync(join(newDir, 'decision.json'), '{}')
    const old = new Date(Date.now() - 100 * 86_400_000)
    utimesSync(oldDir, old, old)
    pruneOldDirs(root, 90)
    expect(existsSync(oldDir)).toBe(false)
    expect(existsSync(newDir)).toBe(true)
  })
  it('tolerates missing root', () => {
    expect(() => pruneOldDirs('/nonexistent/nope', 90)).not.toThrow()
  })
})
