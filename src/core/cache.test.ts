import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DecisionCache, cacheKeys } from './cache.js'
import type { MediaIdentity } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: 'The Matrix', year: 1999,
  type: 'movie', season: null, episode: null, edition: null,
  confidence: 0.95, evidence: [],
}

describe('cacheKeys', () => {
  it('builds id-based and title-based keys', () => {
    const keys = cacheKeys(identity, { imdb: 'tt0133093' })
    expect(keys).toContain('id:imdb:tt0133093:S-:E-')
    expect(keys).toContain('title:the matrix|1999|movie|S-|E-')
  })
  it('includes season/episode for episodes', () => {
    const keys = cacheKeys({ ...identity, type: 'episode', season: 1, episode: 3 }, {})
    expect(keys[0]).toContain('S1')
    expect(keys[0]).toContain('E3')
  })
})

describe('DecisionCache', () => {
  it('stores and retrieves a positive entry by any key', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    c.put(['id:imdb:tt0133093:S-:E-', 'title:the matrix|1999|movie|S-|E-'],
      { kind: 'positive', provider: 'assrt', providerId: '673114', fileIndex: 0, confidence: 0.91 })
    const hit = c.get('title:the matrix|1999|movie|S-|E-')
    expect(hit?.kind).toBe('positive')
  })
  it('migrates legacy assrt_id entries to neutral shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-'))
    const c = new DecisionCache(dir)
    const key = 'id:imdb:tt0133093:S-:E-'
    const legacyStored = {
      entry: { kind: 'positive', assrt_id: 673114, file_index: 2, confidence: 0.9 },
      expiresAt: Date.now() + 365 * 86_400_000,
    }
    const path = join(dir, createHash('sha1').update(key).digest('hex') + '.json')
    writeFileSync(path, JSON.stringify(legacyStored, null, 2))
    const migrated = c.get(key)
    expect(migrated).toEqual({
      kind: 'positive',
      provider: 'assrt',
      providerId: '673114',
      fileIndex: 2,
      confidence: 0.9,
    })
  })
  it('expires negative entries after ttl', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    c.put(['k1'], { kind: 'negative', reason: 'no match' }, -1) // 已过期
    expect(c.get('k1')).toBeNull()
  })
  it('returns null on miss', () => {
    const c = new DecisionCache(mkdtempSync(join(tmpdir(), 'cache-')))
    expect(c.get('nope')).toBeNull()
  })
  it('negative entries default to 24h ttl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cache-'))
    const c = new DecisionCache(dir)
    c.put(['k24'], { kind: 'negative', reason: 'r' })
    // Read the stored file to verify expiresAt is ~24h from now
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    const storedEntry = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'))
    const ttlMs = storedEntry.expiresAt - Date.now()
    const hour = 60 * 60 * 1000
    expect(ttlMs).toBeGreaterThanOrEqual(23.9 * hour)
    expect(ttlMs).toBeLessThanOrEqual(24.1 * hour)
  })
})
