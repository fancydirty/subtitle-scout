import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZimukuSessionStore } from './zimukuSession.js'

// 捕获 put() 内部 renameSync(tmpPath, finalPath) 的 tmpPath 参数,以验证 finding #7(tmp 文件名
// 加 pid+随机后缀,避免两个子进程并发 put() 时 tmp 路径撞车)。同一 vi.mock 模式复用自
// src/files/stagingSandbox.test.ts(node:fs 命名空间在这个仓库的原生 ESM loader 下是冻结的,
// vi.spyOn 直接对 fs 模块 spy 会抛 "Cannot redefine property",必须走 vi.mock 覆盖)。
let renameSyncOverride: ((real: typeof import('node:fs').renameSync, from: string, to: string) => void) | null = null

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

  it('names the tmp file with a pid + random suffix so two concurrent put()s cannot collide on the same tmp path', () => {
    const seenTmpPaths: string[] = []
    renameSyncOverride = (real, from, to) => { seenTmpPaths.push(from); real(from, to) }
    try {
      const s = store()
      s.put({ cookie: 'a', capturedAt: 1 })
      s.put({ cookie: 'b', capturedAt: 2 })
    } finally {
      renameSyncOverride = null
    }
    expect(seenTmpPaths).toHaveLength(2)
    // 两次 put() 各用了不同的 tmp 路径(靠随机后缀撞不上,即使是同一进程内连续调用)
    expect(seenTmpPaths[0]).not.toBe(seenTmpPaths[1])
    // 文件名里带了本进程 pid,便于事后诊断残留 tmp 文件是哪个进程留下的
    for (const p of seenTmpPaths) {
      expect(p).toMatch(new RegExp(`\\.${process.pid}\\.[^.]+\\.tmp$`))
    }
  })
})

