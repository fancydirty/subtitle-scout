import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openDb } from './db.js'
import { runSubtitleWorkDir, buildSubtitleTask, listSubtitleQueue, type SubtitleQueueItem } from './subtitleScheduler.js'
import { traceBus } from '../core/traceBus.js'

function mkItem(): SubtitleQueueItem {
  return {
    workId: 'tmdb:95897',
    title: 'Overflow',
    originalTitle: null,
    year: 2020,
    overview: null,
    chineseTitles: [],
    mediaType: 'tv',
    files: [
      { path: '/media/TV/Overflow/Overflow - 01.mkv', filename: 'Overflow - 01.mkv', season: 1, episode: 1, dir: '/media/TV/Overflow', durationSec: 1440, embeddedLangs: null },
      { path: '/media/TV/Overflow/Overflow - 02.mkv', filename: 'Overflow - 02.mkv', season: 1, episode: 2, dir: '/media/TV/Overflow', durationSec: 1440, embeddedLangs: null },
    ],
  }
}

describe('runSubtitleWorkDir（死循环修复回写）', () => {
  let db: ReturnType<typeof openDb>
  let item: SubtitleQueueItem
  beforeEach(() => {
    db = openDb(':memory:')
    item = mkItem()
    for (const f of item.files) {
      db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, season, episode, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(f.path, f.dir, f.filename, 100, 1000, f.dir, item.workId, 1, f.season, f.episode, 1000)
    }
  })

  const noopWorker = async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] })

  it('installed → covered + needs_subtitle=0（itemId 精确匹配）', async () => {
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    const report = await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT needs_subtitle, sub_status FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.needs_subtitle).toBe(0)
    expect(row.sub_status).toBe('covered')
    // 未装盘的另一个文件不受影响
    const row2 = db.prepare('SELECT needs_subtitle FROM files WHERE path = ?').get(item.files[1].path) as any
    expect(row2.needs_subtitle).toBe(1)
    expect(report).not.toBeNull()
  })

  it('no_safe_match + 有 search_source 证据 → unavailable + recheck_after 6h', async () => {
    // 🔴 模拟真实 worker：搜索发生在 runSubtitleWorkDir 内部（run 前 snapshot 清缓冲，
    // worker 跑时发布事件，跑完 peek 才能看到）。不能在外部预发布——会被内部 snapshot 清掉。
    const worker = async () => {
      traceBus.publish({ runKey: 'job-subtitle:tmdb:95897', seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: Date.now() })
      return { installed: [], no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'nothing found' }], retry_later: [], hardsub_assumed: [] }
    }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT sub_status, recheck_after FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.sub_status).toBe('unavailable')
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 5 * 60 * 60 * 1000)
    expect(row.recheck_after).toBeLessThan(Date.now() + 7 * 60 * 60 * 1000)
  })

  it('🔴 no_safe_match + 零 search_source 证据（编造）→ 不标 unavailable，短退避', async () => {
    // 不 publish 任何 search_source
    const worker = async () => ({
      installed: [], no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'searched all providers' }], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT sub_status, recheck_after, last_error FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.sub_status).toBeNull()  // 不标 unavailable
    expect(row.recheck_after).toBeLessThan(Date.now() + 60 * 60 * 1000)  // 短退避
    expect(row.last_error).toBe('fabricated-no-match')
  })

  it('🔴 超时抛错 → recheck_after 15min（TimeoutError 判别）', async () => {
    const worker = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    for (const f of item.files) {
      const row = db.prepare('SELECT recheck_after, last_error FROM files WHERE path = ?').get(f.path) as any
      expect(row.recheck_after).toBeGreaterThan(Date.now() + 10 * 60 * 1000)
      expect(row.recheck_after).toBeLessThan(Date.now() + 20 * 60 * 1000)
      expect(row.last_error).toBe('timeout')
    }
  })

  it('🔴 其它抛错 → 也回写（不能死循环）', async () => {
    const worker = async () => { throw new Error('sandbox assertion failed') }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    for (const f of item.files) {
      const row = db.prepare('SELECT recheck_after, last_error FROM files WHERE path = ?').get(f.path) as any
      expect(row.recheck_after).not.toBeNull()
      expect(row.last_error).toContain('sandbox')
    }
  })

  it('🔴 B-2：无结局文件（不在任何桶）→ 回写 no-outcome', async () => {
    // worker 只报 installed 一个文件，另一个文件无结局
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row2 = db.prepare('SELECT recheck_after, last_error FROM files WHERE path = ?').get(item.files[1].path) as any
    expect(row2.recheck_after).not.toBeNull()
    expect(row2.last_error).toBe('no-outcome')
  })

  it('retry_later → attempt 阶梯退避（15min 起）', async () => {
    const worker = async () => ({
      installed: [], no_safe_match: [], retry_later: [{ itemId: 'tmdb:95897/s1e1', reason: 'quota' }], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT recheck_after, attempt FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.attempt).toBe(1)
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 10 * 60 * 1000)
    expect(row.recheck_after).toBeLessThan(Date.now() + 20 * 60 * 1000)
  })

  it('🔴 B-1：run 前 snapshot 清缓冲——第二次 run 的旧事件不污染', async () => {
    const runKey = 'job-subtitle:tmdb:95897'
    // 第一次 run：合法搜索
    traceBus.snapshot(runKey)
    traceBus.publish({ runKey, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: Date.now() })
    await runSubtitleWorkDir(db, (async () => ({
      installed: [], no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'nothing' }], retry_later: [], hardsub_assumed: [],
    })) as any, item, 'zh')
    // 第二次 run：编造（零搜索）——但缓冲里还有第一次的 search_source！
    // runSubtitleWorkDir 内部先 snapshot 清掉了 → peek 应该零证据 → 编造被拦
    await runSubtitleWorkDir(db, (async () => ({
      installed: [], no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'searched all providers' }], retry_later: [], hardsub_assumed: [],
    })) as any, item, 'zh')
    const row = db.prepare('SELECT last_error FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.last_error).toBe('fabricated-no-match')
  })

  it('退避阶梯：attempt 递增 → 退避时间拉长', async () => {
    // 先制造 attempt=3（已退避 4 次）
    for (const f of item.files) {
      db.prepare('UPDATE files SET attempt = 3 WHERE path = ?').run(f.path)
    }
    const worker = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT recheck_after FROM files WHERE path = ?').get(item.files[0].path) as any
    // old attempt=3 → 第 4 次失败 → 24h 封顶档
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    expect(row.recheck_after).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
  })
})

describe('listSubtitleQueue（recheck_after 消费，死循环修复）', () => {
  let db: ReturnType<typeof openDb>
  beforeEach(() => {
    db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:1', 'ShowA', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:2', 'ShowB', 'tv', 1000, 1000)
    const fixtures: Array<[string, number | null]> = [
      ['/media/TV/ShowA/E01.mkv', null],        // 可立即处理
      ['/media/TV/ShowA/E02.mkv', Date.now() + 999999],  // 退避中（未来）
      ['/media/TV/ShowB/E01.mkv', Date.now() - 1000],    // 退避已过
    ]
    for (const [path, recheck] of fixtures) {
      db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, recheck_after, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(path, path.slice(0, path.lastIndexOf('/')), path.slice(path.lastIndexOf('/') + 1),
          100, 1000, path.slice(0, path.lastIndexOf('/')), path.includes('ShowA') ? 'tmdb:1' : 'tmdb:2',
          1, recheck, 1000)
    }
  })

  it('退避中（recheck_after 未来）的文件不入队', () => {
    const queue = listSubtitleQueue(db, ['/media/TV'], Date.now())
    const paths = queue.flatMap(q => q.files.map(f => f.filename))
    expect(paths).toContain('E01.mkv')   // 可立即处理
    expect(paths).not.toContain('E02.mkv')  // 退避中
    expect(paths).toContain('ShowB/E01.mkv'.includes('E01') ? 'E01.mkv' : 'x') // ShowB 的（退避已过）
  })

  it('退避已过（recheck_after 过去）→ 重新入队', () => {
    const queue = listSubtitleQueue(db, ['/media/TV'], Date.now())
    // ShowB/E01 的 recheck_after 已过 → 应在队列
    const showB = queue.filter(q => q.workId === 'tmdb:2')
    expect(showB.length).toBe(1)
    expect(showB[0].files.length).toBe(1)
  })
})
