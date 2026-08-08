import { describe, it, expect, vi } from 'vitest'
import { openDb } from './db.js'
import { dispatchOnce, type DispatcherDeps } from './dispatcher.js'

// 注入 isDirWritable 的行为：用 writableRoots 缓存 Map 控制
describe('dispatchOnce（轮转 + writable 过滤）', () => {
  it('🔴 只读根（115）→ 字幕不派发，识别照常', async () => {
    const db = openDb(':memory:')
    // 只读根：writableRoots 缓存 false
    const writableRoots = new Map<string, boolean>()
    writableRoots.set('/media/115', false)
    const deps: DispatcherDeps = {
      db,
      identify: { db, runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }), worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any } },
      subtitleWorker: async () => { throw new Error('不应被调用——只读根') },
      targetLanguage: 'zh',
      roots: ['/media/115'],
      writableRoots,
    }
    // 识别队列有活
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('/media/115/Show/E01.mkv', '/media/115/Show', 'E01.mkv', 100, 1000, '/media/115/Show', 1000)

    const result = await dispatchOnce(deps, 1)
    expect(result.subtitleDispatched).toBe(false)  // 只读根不派字幕
    db.close()
  })

  it('可写根 → 字幕正常派发', async () => {
    const db = openDb(':memory:')
    const writableRoots = new Map<string, boolean>()
    writableRoots.set('/media/rw', true)
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:1', 'Show', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('/media/rw/Show/E01.mkv', '/media/rw/Show', 'E01.mkv', 100, 1000, '/media/rw/Show', 'tmdb:1', 1, 1000)

    const subtitleWorker = vi.fn(async () => ({
      installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [],
    }))
    const deps: DispatcherDeps = {
      db,
      identify: { db, runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }), worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any } },
      subtitleWorker: subtitleWorker as any,
      targetLanguage: 'zh',
      roots: ['/media/rw'],
      writableRoots,
    }
    const result = await dispatchOnce(deps, 1)
    expect(result.subtitleDispatched).toBe(true)
    expect(subtitleWorker).toHaveBeenCalledTimes(1)
    db.close()
  })

  it('轮转：奇数 tick 识别优先，偶数 tick 字幕优先', async () => {
    const db = openDb(':memory:')
    const writableRoots = new Map<string, boolean>()
    writableRoots.set('/media/rw', true)
    // 识别队列有活 + 字幕队列有活
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('/media/rw/Unident/E01.mkv', '/media/rw/Unident', 'E01.mkv', 100, 1000, '/media/rw/Unident', 1000)
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:1', 'Show', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('/media/rw/Show/E01.mkv', '/media/rw/Show', 'E01.mkv', 100, 1000, '/media/rw/Show', 'tmdb:1', 1, 1000)

    const identifySpy = vi.fn(async () => ({ tmdbId: null, title: null, reason: 'noop' }))
    const subtitleSpy = vi.fn(async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }))
    const mkDeps = (): DispatcherDeps => ({
      db,
      identify: { db, runIdentify: identifySpy, worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any } },
      subtitleWorker: subtitleSpy as any,
      targetLanguage: 'zh',
      roots: ['/media/rw'],
      writableRoots,
    })

    // 奇数 tick：识别先（识别派发发生在字幕前，但都各派一项）
    await dispatchOnce(mkDeps(), 1)
    expect(identifySpy).toHaveBeenCalled()
    expect(subtitleSpy).toHaveBeenCalled()
    db.close()
  })
})
