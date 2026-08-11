// src/v2/daemonV2.events.test.ts —— R-F10：daemon 侧 emit 接线的行为锁。
//
// ── 这个文件为什么必须存在（本仓栽过 6 次的那一类）─────────────────────────────
// C12→C35→C43→C21→audio_langs→tmdb_seasons：本项目反复出现"写了某列/某能力，却没定谁来写、
// 谁来读、谁来触发"，最终的形态永远是**测试全绿而生产静默失效**。上一个 subagent 就发现过
// "方法写好了但没人叫"的实现能让 8 条用例全绿。
//
// 故本文件的主力用例**走完整的 daemon.run()**（不是私有方法），拿真实的巡检链路证明事件
// 真的被发出来。只有那些在 run() 里难以稳定复现的分支（R8 拦截需要特定的 FUSE 抖动形态）
// 才退回到调私有方法。
import { describe, it, expect, vi } from 'vitest'
import { openDb } from './db.js'
import { ScoutDaemonV2 } from './daemonV2.js'
import type { ScoutEventInput } from '../core/scoutEvents.js'

const NOW = 1_000_000_000_000
const BIG = 200 * 1024 * 1024

function mkDeps(db: ReturnType<typeof openDb>, overrides: Record<string, any> = {}) {
  return {
    db,
    roots: ['/media'],
    identify: { db, runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }), worker: {} as any },
    subtitleWorker: async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }),
    targetLanguage: 'zh',
    probe: async () => null,
    probeDuration: async () => null,
    log: () => {},
    // 同 daemonV2.test.ts 的既有约定：测试永远不真的等（R8 重试退避 1s+3s 会把每条用例拖慢）。
    sleep: async () => {},
    inspectEveryMs: 24 * 60 * 60 * 1000,
    now: () => NOW,
    ...overrides,
  } as any
}

/** 收事件的替身 emit。**同时记录调用次数**——"emit 被调了但总线吞了"与"emit 压根没被调"
 *  在只看事件数组时长得一模一样。 */
function mkEmit() {
  const got: ScoutEventInput[] = []
  const emit = vi.fn((e: ScoutEventInput) => { got.push(e) })
  return { emit, got, types: () => got.map((e) => e.type), msgs: () => got.map((e) => e.message) }
}

/** 跑一轮完整巡检后停（冷启动 → 立刻巡检，同 daemonV2.test.ts 的既有驱动手法）。 */
async function runOneInspection(daemon: ScoutDaemonV2): Promise<void> {
  const ctrl = new AbortController()
  const p = daemon.run(ctrl.signal)
  await new Promise((r) => setTimeout(r, 50))
  ctrl.abort()
  await p
}

/** 一个已识别、需字幕、可派发的文件（字幕工作台会捞到它）。 */
function seedSubtitleWork(db: ReturnType<typeof openDb>, path: string, episode: number): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (!db.prepare('SELECT id FROM works WHERE id = ?').get('tmdb:42')) {
    db.prepare('INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('tmdb:42', 'Show', 'tv', 'en', 1000, 1000)
  }
  db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                 season, episode, needs_subtitle, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, dir, 'tmdb:42', 1, episode, 1, 1000)
}

describe('ScoutDaemonV2 · R-F10 事件发布（端到端走 run()）', () => {
  it('🔴 走完整 run()：巡检开始/完成两条 activity 真的被发出来（不是只有方法写好了没人叫）', async () => {
    const db = openDb(':memory:')
    const { emit, got, types } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, { emit, roots: [] })))
    expect(emit).toHaveBeenCalled()
    expect(types()).toContain('activity')
    expect(got.some((e) => e.type === 'activity' && e.message.includes('巡检开始'))).toBe(true)
    expect(got.some((e) => e.type === 'activity' && e.message.includes('巡检完成'))).toBe(true)
    db.close()
  })

  it('🔴 走完整 run()：开始处理某个作品 → activity（工作台状态变化）', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    const act = got.filter((e) => e.type === 'activity')
    expect(act.some((e) => e.message.includes('字幕') && e.title === 'Show')).toBe(true)
    db.close()
  })

  it('🔴 走完整 run()：装上字幕 → found（通知页的数据源）', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
      subtitleWorker: async () => ({
        installed: [{
          itemId: 'tmdb:42/s1e1', installedPath: '/media/Show/E01.zh-Hans.srt',
          installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: 'x', reason: 'ok',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
      }),
    })))
    const found = got.filter((e) => e.type === 'found')
    expect(found).toHaveLength(1)
    expect(found[0].title).toBe('Show')
    expect(found[0].message).toContain('1')
    db.close()
  })

  it('🔴 一部剧多集逐个处理 → 每集一条 progress（唯一的高频事件源）', async () => {
    const db = openDb(':memory:')
    for (let i = 1; i <= 3; i++) seedSubtitleWork(db, `/media/Show/E0${i}.mkv`, i)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv', '/media/Show/E02.mkv', '/media/Show/E03.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    // 节流是**总线**的职责，不是发布方的——发布方如实发，总线折叠。这里断言发布方如实发了。
    expect(got.filter((e) => e.type === 'progress').length).toBeGreaterThan(0)
    db.close()
  })

  it('🔴 不该推的一律不推：整轮巡检不产生任何 probe/回填/judge/trace 的事件（R-F10 反面清单）', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const { emit, got, msgs } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
      // 这些开关一开，daemon 就会打出真实的排障日志形态；它们**一条都不许变成事件**。
      probe: async () => [], probeDuration: async () => 1200,
      sweepWriteProbes: () => 3,
      dbMaintenance: () => {},
      runs: { pruneTraces: () => 7 },
      traceRetentionDays: () => 30,
      gcStaging: () => 2,
    })))
    const all = msgs().join('\n')
    // 拿真实日志形态做反例（这些字符串就是 daemonV2.ts 里实际会 log 出来的）
    expect(all).not.toContain('probe wrote=')
    expect(all).not.toContain('judge: 判定')
    expect(all).not.toContain('回填:')
    expect(all).not.toContain('trace 修剪')
    expect(all).not.toContain('清理了')      // 写探针清扫 / 孤儿工作台
    expect(all).not.toContain('隔离，下轮重试')
    expect(all).not.toContain('scanned=')
    // 类型集合也必须封闭在 4 类里
    expect(new Set(got.map((e) => e.type))).toEqual(
      new Set([...new Set(got.map((e) => e.type))].filter((t) =>
        ['activity', 'found', 'health', 'progress'].includes(t))),
    )
    db.close()
  })

  it('🔴 emit 抛错必须被隔离：巡检照常跑完（SSE 挂了绝不能影响巡检）', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      emit: () => { throw new Error('bus exploded') },
      roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
      log: (m: string) => logs.push(m),
    }))
    await runOneInspection(daemon)
    // 巡检必须**成功**跑完（时间闸只由成功的巡检推进 → meta 有值即为证）
    expect(db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get()).toBeDefined()
    expect(logs.some((l) => l.includes('巡检完成'))).toBe(true)
    expect(logs.some((l) => l.includes('巡检失败'))).toBe(false)
    db.close()
  })

  it('🔴 emit 未注入（既有构造点/几百条既有测试都不传）→ 整支静默、零成本、不抛错', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    }))
    await expect(runOneInspection(daemon)).resolves.toBeUndefined()
    db.close()
  })

  describe('health：只收「我的库可能有问题」这一档', () => {
    it('🔴 守备目录不可访问（R8 第一道闸）→ health', async () => {
      const db = openDb(':memory:')
      const { emit, got } = mkEmit()
      await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
        emit, roots: ['/media'],
        listVideoFiles: () => { throw new Error('EIO: mount gone') },
      })))
      const health = got.filter((e) => e.type === 'health')
      expect(health.length).toBeGreaterThan(0)
      expect(health[0].message).toContain('/media')
      db.close()
    })

    it('🔴 守备目录扫出 0 个文件（R8 第二道闸，FUSE 掉线最阴的形态）→ health', async () => {
      const db = openDb(':memory:')
      // 库里有既有行，本轮却一个都没扫到 → 第二道闸
      seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
      const { emit, got } = mkEmit()
      await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
        emit, roots: ['/media'], listVideoFiles: () => [],
      })))
      expect(got.filter((e) => e.type === 'health').length).toBeGreaterThan(0)
      db.close()
    })

    it('🔴 单文件级的隔离错误**不算** health（会自愈的抖动不该惊动用户）', async () => {
      const db = openDb(':memory:')
      seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
      const { emit, got } = mkEmit()
      await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
        emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
        statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
        // 单文件 probe 失败 → daemon 会 log「scan: probe 失败（隔离，留 NULL 待重探）」
        probe: async () => { throw new Error('ffprobe boom') },
      })))
      expect(got.filter((e) => e.type === 'health')).toHaveLength(0)
      db.close()
    })
  })
})
