import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDb } from './db.js'
import { ScoutDaemonV2, INSPECT_INTERVAL_MS } from './daemonV2.js'

interface TestDeps {
  db?: ReturnType<typeof openDb>
  [k: string]: any
}

function mkDeps(db: ReturnType<typeof openDb>, overrides: TestDeps = {}) {
  return {
    db,
    roots: ['/media'],
    identify: { db, runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }), worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any } },
    subtitleWorker: async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }),
    targetLanguage: 'zh',
    log: () => {},
    inspectEveryMs: 24 * 60 * 60 * 1000,
    now: () => 1_000_000_000_000,
    ...overrides,
  } as any
}

describe('ScoutDaemonV2（巡检模型）', () => {
  it('冷启动（无 last_inspect_at）→ 立即跑巡检', async () => {
    const db = openDb(':memory:')
    const inspect = vi.fn()
    const daemon = new ScoutDaemonV2(mkDeps(db))
    // 注入 runInspection 到原型 spy 不方便——直接验证 meta 被写入
    // 通过一个可观察的行为：识别队列有活时会被处理
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('/media/Show/E01.mkv', '/media/Show', 'E01.mkv', 100, 1000, '/media/Show', 1000)
    const identifySpy = vi.fn(async () => ({ tmdbId: null, title: null, reason: 'noop' }))
    const daemon2 = new ScoutDaemonV2(mkDeps(db, { identify: { db, runIdentify: identifySpy, worker: {} as any } }))
    const ctrl = new AbortController()
    const p = daemon2.run(ctrl.signal)
    // 跑完一轮巡检后 meta 有 last_inspect_at
    await new Promise(r => setTimeout(r, 50))
    ctrl.abort()
    await p
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get() as { value: string } | undefined
    expect(row).toBeDefined()
    db.close()
  })

  it('距上次巡检不足 24h → 不跑（歇着）', async () => {
    const db = openDb(':memory:')
    const now = 1_000_000_000_000
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(now - 1 * 60 * 60 * 1000))  // 1h 前
    const identifySpy = vi.fn(async () => ({ tmdbId: null, title: null, reason: 'noop' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { identify: { db, runIdentify: identifySpy, worker: {} as any }, now: () => now }))
    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 50))
    ctrl.abort()
    await p
    expect(identifySpy).not.toHaveBeenCalled()  // 不足 24h 不巡检
    db.close()
  })

  it('识别跑空后才跑字幕（上下游串行）', async () => {
    const db = openDb(':memory:')
    // 识别队列有活 + 字幕队列有活
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('/media/Unident/E01.mkv', '/media/Unident', 'E01.mkv', 100, 1000, '/media/Unident', 1000)
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:1', 'Show', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('/media/Show/E01.mkv', '/media/Show', 'E01.mkv', 100, 1000, '/media/Show', 'tmdb:1', 1, 1000)

    const order: string[] = []
    const identifySpy = vi.fn(async () => { order.push('identify'); return { tmdbId: null, title: null, reason: 'noop' } })
    const subtitleSpy = vi.fn(async () => { order.push('subtitle'); return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] } })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      identify: { db, runIdentify: identifySpy, worker: {} as any },
      subtitleWorker: subtitleSpy as any,
      writableRoots: new Map([['/media', true]]),
    }))
    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 100))
    ctrl.abort()
    await p
    // 识别先于字幕
    const i = order.indexOf('identify')
    const s = order.indexOf('subtitle')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(i).toBeLessThan(s)
    db.close()
  })
})
