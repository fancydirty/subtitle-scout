import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, cleanup, install, gcOrphans } from './stagingSandbox.js'

const mediaRoot = () => mkdtempSync(join(tmpdir(), 'stage-root-'))

// Deviation from the plan: the plan's retry/EXDEV tests used
// `vi.spyOn(fsMod, 'renameSync').mockImplementation(...)` on the `node:fs` namespace
// object. Under Node's native ESM loader (which this repo's vitest config uses),
// built-in module namespace objects are frozen/non-configurable, so vi.spyOn throws
// "Cannot redefine property: renameSync" instead of producing the RED failure the
// plan describes. `src/files/subtitleWriter.test.ts` already solves this exact
// problem for the same module with `vi.mock('node:fs', async (importOriginal) =>
// ...)` plus a module-level mutable override — that is the established pattern in
// this codebase, so it is reused here instead of vi.spyOn.
// Note: the factory below must not synchronously write into a module-level `let`
// (e.g. `realRenameSync = actual.renameSync`) — vi.mock's factory runs at import
// resolution time, which precedes this file's own top-level `let` initializers
// regardless of source order, so any such write hits the temporal dead zone. Only
// *reading* a module-level `let` from inside a nested closure (deferred to call
// time, after the file has finished initializing) is safe — hence passing
// `actual.renameSync` through as a parameter to the override instead.
let renameSyncOverride:
  | ((real: typeof import('node:fs').renameSync, from: string, to: string) => void)
  | null = null

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameSyncOverride) {
        return renameSyncOverride(actual.renameSync, args[0] as string, args[1] as string)
      }
      return actual.renameSync(...args)
    },
  }
})

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

describe('install', () => {
  it('atomically renames the staged file to the final path', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.zh-Hans.srt')
    writeFileSync(stagedPath, '1\n00:00:01,000 --> 00:00:02,000\nhi\n')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(existsSync(stagedPath)).toBe(false)
  })

  it('NFC-normalizes the final path before writing (Synology SMB NFD landmine)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    // NFD-decomposed "e-acute": ASCII 'e' + U+0301 COMBINING ACUTE ACCENT (2 code
    // points), built via ́ escape rather than a precomposed literal char.
    // Deviation from the plan's literal source text: pasting a precomposed
    // character through the edit toolchain risks silent NFC re-normalization in
    // transit, which would make the input already-NFC and defeat this test's
    // purpose (asserting install() normalizes NFD input to NFC).
    const nfdName = "Café.zh-Hans.srt"
    const finalPath = join(root, nfdName)
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath.normalize('NFC'))
    expect(result.path).not.toBe(finalPath) // input is NFD, output must be NFC, bytes differ
  })
})

describe('install — retry and EXDEV fallback', () => {
  afterEach(() => {
    renameSyncOverride = null
  })

  it('retries on EBUSY (simulated SMB oplock jitter) and eventually succeeds', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let calls = 0
    renameSyncOverride = (real, from, to) => {
      calls++
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(from, to)
    }
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath)
    expect(calls).toBe(3)
    expect(existsSync(finalPath)).toBe(true)
  })

  it('gives up after exhausting retries on a persistently retryable error', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    renameSyncOverride = () => {
      throw Object.assign(new Error('perm'), { code: 'EPERM' })
    }
    await expect(install(stagedPath, finalPath)).rejects.toThrow(/perm/)
  })

  it('falls back to copy+fsync+rename on EXDEV (cross-device, theoretically unreachable given allocate() shares the video root)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    renameSyncOverride = (real, from, to) => {
      renameCalls++
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      // second call is copyThenRenameSameDir's internal same-device rename — pass through
      return real(from, to)
    }
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('cross-device content')
  })
})

describe('gcOrphans', () => {
  it('removes every staging dir not in activeJobIds, across multiple media roots', () => {
    const root1 = mediaRoot()
    const root2 = mediaRoot()
    allocate('job-orphan-1', root1)
    allocate('job-active', root1)
    allocate('job-orphan-2', root2)

    const cleaned = gcOrphans([root1, root2], new Set(['job-active']))

    expect(cleaned).toBe(2)
    expect(existsSync(join(root1, '.subtitle-staging', 'job-orphan-1'))).toBe(false)
    expect(existsSync(join(root1, '.subtitle-staging', 'job-active'))).toBe(true)
    expect(existsSync(join(root2, '.subtitle-staging', 'job-orphan-2'))).toBe(false)
  })

  it('is a no-op when a media root has no .subtitle-staging dir yet', () => {
    const root = mediaRoot()
    expect(() => gcOrphans([root], new Set())).not.toThrow()
    expect(gcOrphans([root], new Set())).toBe(0)
  })

  it('does not treat the .ignore marker file as an orphan directory', () => {
    const root = mediaRoot()
    allocate('job-1', root) // 顺带创建 .ignore
    gcOrphans([root], new Set())
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
  })

  it('boot semantics: empty activeJobIds nukes everything (mirrors jobsRepo.reapAllActive)', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    allocate('job-2', root)
    mkdirSync(join(root, '.subtitle-staging', 'job-3'), { recursive: true })
    const cleaned = gcOrphans([root], new Set())
    expect(cleaned).toBe(3)
  })
})
