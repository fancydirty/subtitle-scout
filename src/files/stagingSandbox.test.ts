import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, symlinkSync, lstatSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, cleanup, install, gcOrphans } from './stagingSandbox.js'

// Finding 4: production code has no call sites for install() yet, so defaulting this to
// a short ladder everywhere retries are exercised keeps this suite fast without touching
// the production default (which stays the real backoff ladder — see stagingSandbox.ts).
const fastDelays = { delaysMs: [1, 1, 1, 1] }

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

// Addendum A: install() fsyncs the parent directory fd after a successful rename (best-effort).
// Same vi.mock pattern as renameSyncOverride above — openSync/fsyncSync/closeSync are individually
// overridable so tests can observe the calls and simulate fsync failing without touching the real
// rename/write behavior exercised by the rest of this suite.
let openSyncOverride: ((real: typeof import('node:fs').openSync, path: string, flags: string) => number) | null = null
let fsyncSyncOverride: ((real: typeof import('node:fs').fsyncSync, fd: number) => void) | null = null
let closeSyncOverride: ((real: typeof import('node:fs').closeSync, fd: number) => void) | null = null

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
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (openSyncOverride) {
        return openSyncOverride(actual.openSync, args[0] as string, args[1] as string)
      }
      return actual.openSync(...args)
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      if (fsyncSyncOverride) {
        return fsyncSyncOverride(actual.fsyncSync, args[0])
      }
      return actual.fsyncSync(...args)
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      if (closeSyncOverride) {
        return closeSyncOverride(actual.closeSync, args[0])
      }
      return actual.closeSync(...args)
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

describe('install — parent-directory fsync (addendum A: 尽力 fsync 目录)', () => {
  afterEach(() => {
    openSyncOverride = null
    fsyncSyncOverride = null
    closeSyncOverride = null
  })

  it('opens, fsyncs, and closes the parent directory fd after a successful rename', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const openedPaths: string[] = []
    let fsyncedFd: number | null = null
    let closedFd: number | null = null
    openSyncOverride = (real, path, flags) => {
      openedPaths.push(path)
      return real(path, flags)
    }
    fsyncSyncOverride = (real, fd) => {
      fsyncedFd = fd
      return real(fd)
    }
    closeSyncOverride = (real, fd) => {
      closedFd = fd
      return real(fd)
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(openedPaths).toContain(root) // dirname(finalPath) === root
    expect(fsyncedFd).not.toBeNull()
    expect(closedFd).toBe(fsyncedFd)
  })

  it('swallows a directory-fsync failure without failing the install (best-effort, e.g. platforms without dir-fd fsync support)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'still installed')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    fsyncSyncOverride = () => {
      throw Object.assign(new Error('fsync not supported on directory fd'), { code: 'EINVAL' })
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('still installed')
  })

  it('swallows an open-failure on the parent directory too (best-effort all the way through)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'installed anyway')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    openSyncOverride = () => {
      throw Object.assign(new Error('cannot open directory'), { code: 'EACCES' })
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
  })

  it('also fsyncs the parent directory on the EXDEV copy+rename fallback path', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    renameSyncOverride = (real, from, to) => {
      renameCalls++
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return real(from, to)
    }
    let fsyncedFd: number | null = null
    fsyncSyncOverride = (real, fd) => {
      fsyncedFd = fd
      return real(fd)
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(fsyncedFd).not.toBeNull()
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
    const result = await install(stagedPath, finalPath, fastDelays)
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
    await expect(install(stagedPath, finalPath, fastDelays)).rejects.toThrow(/perm/)
  })

  it('does not retry a non-retryable code (EACCES): fails on the first attempt with no delay', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let calls = 0
    renameSyncOverride = () => {
      calls++
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    }
    // Real ladder on purpose: if this ever *did* retry, the un-mocked delays would make
    // the test slow — that would itself be a signal something regressed.
    await expect(install(stagedPath, finalPath)).rejects.toThrow(/access denied/)
    expect(calls).toBe(1)
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

  it('does not leak the copyThenRenameSameDir temp file into the media dir when the fallback rename fails', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    renameSyncOverride = () => {
      renameCalls++
      // 1st call: install()'s primary rename → force the EXDEV fallback path.
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      // 2nd call: copyThenRenameSameDir's own same-dir rename → simulate a non-retryable
      // failure (e.g. EACCES) at the last step, after the temp file has already been
      // written+fsynced. Nothing above install() retries this fallback's rename, so this
      // must surface as a real failure — and must not leave the temp file behind in the
      // media directory.
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    }

    await expect(install(stagedPath, finalPath)).rejects.toThrow(/access denied/)

    const leftovers = readdirSync(root).filter(f => f.startsWith('.subtitle-scout-install-'))
    expect(leftovers).toEqual([])
  })
})

describe('install — conflict detection (H1, 2026-07-18 数据安全审计: renameSync 对已存在目标零防线)', () => {
  afterEach(() => {
    renameSyncOverride = null
  })

  it('目标位置已存在文件（用户手放字幕/上次崩溃残留）→ 不覆盖，返回冲突结果，原文件内容不变', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'NEW candidate content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    writeFileSync(finalPath, 'EXISTING content — must survive')

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ conflict: true, path: finalPath })
    expect(readFileSync(finalPath, 'utf8')).toBe('EXISTING content — must survive')
    // staged file untouched too — nothing was renamed away
    expect(existsSync(stagedPath)).toBe(true)
  })

  it('目标不存在 → 照常改名成功（结果不带 conflict 字段）', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ path: finalPath })
    expect('conflict' in result).toBe(false)
  })

  it('EXDEV 兜底路径同样受保护：跨设备重试前目标恰好被别处创建 → 冲突而非覆盖', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    renameSyncOverride = () => {
      // 模拟竞态：EXDEV 触发的那一刻，目标恰好已被别的进程/用户创建
      writeFileSync(finalPath, 'RACE WINNER content — must survive')
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    }

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ conflict: true, path: finalPath })
    expect(readFileSync(finalPath, 'utf8')).toBe('RACE WINNER content — must survive')
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

  it('P2.4: .subtitle-translate 工作台同法清扫(活跃 jobId 保留)', () => {
    const root = mediaRoot()
    mkdirSync(join(root, '.subtitle-translate', 'daemon-1'), { recursive: true })
    mkdirSync(join(root, '.subtitle-translate', 'daemon-2'), { recursive: true })
    const cleaned = gcOrphans([root], new Set(['daemon-2']))
    expect(cleaned).toBe(1)
    expect(existsSync(join(root, '.subtitle-translate', 'daemon-1'))).toBe(false)
    expect(existsSync(join(root, '.subtitle-translate', 'daemon-2'))).toBe(true)
  })

  it('removes a stray non-directory file squatting in .subtitle-staging (not just orphan job dirs)', () => {
    const root = mediaRoot()
    allocate('job-1', root) // 顺带创建 .subtitle-staging/.ignore
    const junkFile = join(root, '.subtitle-staging', 'not-a-job-dir.txt')
    writeFileSync(junkFile, 'squatter')

    const cleaned = gcOrphans([root], new Set())

    expect(existsSync(junkFile)).toBe(false)
    expect(cleaned).toBe(2) // job-1 dir + the junk file
  })

  it('removes a broken symlink in .subtitle-staging instead of leaving it to accumulate forever', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const stagingRoot = join(root, '.subtitle-staging')
    const brokenLink = join(stagingRoot, 'broken-link')
    symlinkSync(join(stagingRoot, 'does-not-exist-target'), brokenLink)

    gcOrphans([root], new Set())

    // existsSync follows the link and would report false for a broken link either way —
    // lstatSync is the only way to tell whether the link entry itself was actually removed.
    expect(() => lstatSync(brokenLink)).toThrow()
  })

  it('removes a symlink-to-directory as a link, leaving the target directory untouched', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const stagingRoot = join(root, '.subtitle-staging')
    const targetDir = mkdtempSync(join(tmpdir(), 'gcorphans-symlink-target-'))
    writeFileSync(join(targetDir, 'keep-me.txt'), 'still here')
    const linkPath = join(stagingRoot, 'link-to-dir')
    symlinkSync(targetDir, linkPath)

    gcOrphans([root], new Set())

    expect(() => lstatSync(linkPath)).toThrow() // the link entry itself is gone
    expect(existsSync(targetDir)).toBe(true) // but its target was never touched
    expect(existsSync(join(targetDir, 'keep-me.txt'))).toBe(true)
  })
})
