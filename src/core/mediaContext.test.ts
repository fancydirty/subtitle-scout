import { describe, it, expect } from 'vitest'
import { mkdtempSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePathMappings, mapPath, isUnderRoots, containingRoot, isDirWritable } from './mediaContext.js'

describe('parsePathMappings', () => {
  it('parses comma-separated pairs', () => {
    expect(parsePathMappings('/media=/mnt/nas,/tv=/mnt/tv')).toEqual([
      { from: '/media', to: '/mnt/nas' }, { from: '/tv', to: '/mnt/tv' },
    ])
  })
  it('empty/undefined → identity (empty list)', () => {
    expect(parsePathMappings(undefined)).toEqual([])
    expect(parsePathMappings('')).toEqual([])
  })
  it('throws on malformed pair', () => {
    expect(() => parsePathMappings('/media')).toThrow(/invalid/i)
  })
})

describe('mapPath', () => {
  it('longest prefix wins', () => {
    const m = [{ from: '/media', to: '/A' }, { from: '/media/movies', to: '/B' }]
    expect(mapPath('/media/movies/x.mkv', m)).toBe('/B/x.mkv')
    expect(mapPath('/media/tv/y.mkv', m)).toBe('/A/tv/y.mkv')
  })
})

describe('isUnderRoots', () => {
  it('empty roots → unrestricted', () => {
    expect(isUnderRoots('/anywhere/x', [])).toBe(true)
  })
  it('accepts paths under a root, rejects outside and sibling-prefix tricks', () => {
    const roots = ['/mnt/media']
    expect(isUnderRoots('/mnt/media/Movies/x', roots)).toBe(true)
    expect(isUnderRoots('/mnt/media', roots)).toBe(true)
    expect(isUnderRoots('/etc', roots)).toBe(false)
    expect(isUnderRoots('/mnt/media-evil/x', roots)).toBe(false)
  })
})

describe('containingRoot', () => {
  it('returns the root that contains a deep path', () => {
    const roots = ['/mnt/media']
    expect(containingRoot('/mnt/media/Show/Season 01/x.mkv', roots)).toBe('/mnt/media')
  })
  it('returns the path itself when it equals a root exactly', () => {
    expect(containingRoot('/mnt/media', ['/mnt/media'])).toBe('/mnt/media')
  })
  it('returns null when no root is a prefix (including sibling-prefix tricks)', () => {
    expect(containingRoot('/etc/x', ['/mnt/media'])).toBeNull()
    expect(containingRoot('/mnt/media-evil/x', ['/mnt/media'])).toBeNull()
  })
  it('returns null for an empty roots list', () => {
    expect(containingRoot('/anywhere/x', [])).toBeNull()
  })
  it('picks the longest (most specific) matching root when roots are nested', () => {
    const roots = ['/mnt/media', '/mnt/media/tv']
    expect(containingRoot('/mnt/media/tv/Show/x.mkv', roots)).toBe('/mnt/media/tv')
    expect(containingRoot('/mnt/media/movies/x.mkv', roots)).toBe('/mnt/media')
  })
})

describe('isDirWritable', () => {
  it('returns true for a writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ok-'))
    expect(isDirWritable(dir)).toBe(true)
  })
  it('leaves no probe file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-clean-'))
    isDirWritable(dir)
    expect(readdirSync(dir).some(f => f.startsWith('.subtitle-scout-writetest'))).toBe(false)
  })
  it('returns false for a non-existent directory', () => {
    expect(isDirWritable(join(tmpdir(), 'wp-does-not-exist-zzz', 'nope'))).toBe(false)
  })
  it('returns false for a read-only directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ro-'))
    chmodSync(dir, 0o555)
    // 以 root 运行时权限位被绕过,该断言不成立 → 条件跳过
    if (process.getuid && process.getuid() === 0) return
    expect(isDirWritable(dir)).toBe(false)
  })
})
