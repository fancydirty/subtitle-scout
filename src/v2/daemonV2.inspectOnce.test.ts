import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, closeSync, openSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.js'
import { ScoutDaemonV2, INSPECT_INTERVAL_MS } from './daemonV2.js'

function mkDeps(db: ReturnType<typeof openDb>, over: Record<string, unknown> = {}) {
  return {
    db,
    roots: ['/media'],
    identify: { db, runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }), worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } } },
    subtitleWorker: async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }),
    targetLanguage: 'zh',
    probe: async () => null,
    probeDuration: async () => null,
    log: () => {},
    sleep: async () => {},
    inspectEveryMs: INSPECT_INTERVAL_MS,
    now: () => 1_000_000_000_000,
    emit: () => {},
    ...over,
  } as any
}

function materializeZeroByteMkv(prefix: string): { root: string; video: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const dir = join(root, 'Movies', 'Casablanca (1942)')
  mkdirSync(dir, { recursive: true })
  const video = join(dir, 'Casablanca.1942.mkv')
  closeSync(openSync(video, 'w'))
  return { root, video }
}

describe('ScoutDaemonV2.inspectOnce', () => {
  it('is public and scans a 0-byte mkv into files', async () => {
    const { root, video } = materializeZeroByteMkv('inspect-once-')
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: [root], rootsProvider: () => [root] }))
    await daemon.inspectOnce(new AbortController().signal)
    const row = db.prepare('SELECT path, size FROM files').get() as { path: string; size: number } | undefined
    expect(row?.path).toBe(video)
    expect(row?.size).toBe(0)
    db.close()
  })

  it('honors pre-aborted signal via this.stopping (skips identify)', async () => {
    const { root } = materializeZeroByteMkv('inspect-once-abort-')
    const db = openDb(':memory:')
    const identifySpy = vi.fn(async () => ({ tmdbId: null, title: null, reason: 'noop' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [root],
      rootsProvider: () => [root],
      identify: { db, runIdentify: identifySpy, worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } } },
    }))
    const ctrl = new AbortController()
    ctrl.abort()
    await daemon.inspectOnce(ctrl.signal)
    expect(identifySpy).not.toHaveBeenCalled()
    db.close()
  })

  it('bypasses the 24h last_inspect_at gate', async () => {
    const now = 1_000_000_000_000
    const { root } = materializeZeroByteMkv('inspect-once-bypass-')
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(now - 60_000))
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [root],
      rootsProvider: () => [root],
      now: () => now,
    }))
    await daemon.inspectOnce(new AbortController().signal)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n
    expect(count).toBe(1)
    db.close()
  })

  it('inspectOnce calls runInspection (does not copy the inner loop)', () => {
    const src = readFileSync(new URL('./daemonV2.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/async inspectOnce\s*\(\s*signal:\s*AbortSignal\s*\)/)
    const method = src.slice(src.indexOf('async inspectOnce'))
    const body = method.slice(0, method.indexOf('\n  async ') > 0 ? method.indexOf('\n  async ') : 400)
    expect(body).toContain('this.runInspection')
    expect(body).not.toContain('runInspectionInner')
  })
})
