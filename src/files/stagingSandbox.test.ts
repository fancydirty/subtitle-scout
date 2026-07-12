import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, cleanup } from './stagingSandbox.js'

const mediaRoot = () => mkdtempSync(join(tmpdir(), 'stage-root-'))

describe('allocate', () => {
  it('creates <mediaRoot>/.subtitle-staging/<jobId>/ and returns its path', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    expect(dir).toBe(join(root, '.subtitle-staging', 'job-1'))
    expect(existsSync(dir)).toBe(true)
  })

  it('drops a .ignore marker file next to the per-job dirs (Jellyfin should skip this tree)', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    expect(existsSync(ignorePath)).toBe(true)
    expect(readFileSync(ignorePath, 'utf8')).toContain('subtitle-scout staging')
  })

  it('is idempotent: allocating the same jobId twice does not throw and keeps existing files', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'marker.txt'), 'x')
    const dir2 = allocate('job-1', root)
    expect(dir2).toBe(dir)
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true)
  })

  it('does not overwrite an existing .ignore file on a second allocate', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    writeFileSync(ignorePath, 'custom content')
    allocate('job-2', root)
    expect(readFileSync(ignorePath, 'utf8')).toBe('custom content')
  })
})

describe('cleanup', () => {
  it('removes the whole per-job staging directory', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'leftover.srt'), 'junk')
    cleanup('job-1', root)
    expect(existsSync(dir)).toBe(false)
  })

  it('is a no-op (does not throw) when the directory was never allocated', () => {
    const root = mediaRoot()
    expect(() => cleanup('never-allocated', root)).not.toThrow()
  })
})
