import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { execFile as nodeExecFile } from 'node:child_process'
import { openDb } from './db.js'
// 真实探针（不是替身）：FFPROBE_PATH 空串那组回归必须跨过 streamProbe.ts 的二进制解析那一档
// ——本次事故就坏在那里，而 C12 那组全用假 probe，从不经过它。
import { probeEmbeddedSubtitles, probeDurationSec } from '../files/streamProbe.js'
import { ScoutDaemonV2, INSPECT_INTERVAL_MS } from './daemonV2.js'
// 用真实队列函数做断言，不在测试里复述工作台谓词——复述等于测试自己也维护一份实现，
// 两份一漂移就是假绿（C27 这个 bug 的核心恰恰是"谓词组合起来构成卡死态"）。
import { listSubtitleQueue, subtitleJobId, runSubtitleWorkDir, RETRY_LATER_STREAK_CAP } from './subtitleScheduler.js'
// C21 用例 7b 端到端：用真实的抓源腿 locate 验"回填的产出真能被消费方读出来"，
// 而不是只断言列被写上（列值断言在"写了个 {} "的实现下同样为真）。
import { makeDbLocate } from '../cli/fetchSourceSub.js'

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
    // 探针默认注入 null（"探测不可用"）：沿用 IngestDeps.probe/probeDuration 的既有测试约定
    // ——测试永远注入固定值，**从不真的 spawn ffprobe**（否则测试快慢取决于 ffprobe-static
    // 装没装上，且会在扫描用例里意外产生真实进程）。
    probe: async () => null,
    probeDuration: async () => null,
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
      // 3-3 起阶段 3 在消费冻结快照前逐文件 stat（R12 / C23），故"这个视频在盘上"从此是
      // 字幕流的**输入**。本用例测的是阶段顺序，不注入的话会退化成默认 existsSync ——
      // 那两个路径在真实磁盘上并不存在 → 整簇被剔除 → subtitleSpy 一次都不被调 →
      // 断言 `order.indexOf('subtitle') >= 0` 当场红，红的理由却与阶段顺序无关。
      fileExists: (p: string) => p === '/media/Show/E01.mkv',
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

// ─────────────────────────────────────────────────────────────────────────────
// 第 1b 步：扫描删除清理（C1 / R6 / R7 / R8 / D1 / D20 / D21）
//
// 用户原话："数据库情况得真实反映磁盘中的情况，这也是为什么必须要先机械扫的原因。"
// 改动前 scanOnce 只做新增入库、零删除 → 用户删了资源，files 行还在，字幕流明天照样为
// 幽灵文件跑一整轮付费 LLM。整条流水线的"跑道"是假的。
//
// 这批用例的重点不是"删得掉"（那部分简单），而是**四条不许删**的防线——每条都有血案：
//   防线 1 (R8)  挂载掉线时目录"看起来是空的" → 无脑删就是一次删光全库
//   防线 2 (D20) /media 与 /media/115 并存，115 掉线 → /media 的差集吃掉 115 全库（C29）
//   防线 3 (D21) '/' 作为守备目录时 substr(path,1,1)='/' 对全库为真
//   防线 4 (D1)  逐根隔离，删 A 不许碰 B
// ─────────────────────────────────────────────────────────────────────────────

const BIG = 20 * 1024 * 1024   // > isScannable 的 10MB 下限，否则会被当垃圾跳过

/** 造一批 files 行（只填扫描/删除逻辑关心的列）。
 *  每行带一个 work_id：删除的证据不能只看 path——被误删的行紧接着会被它**自己那个根**的
 *  upsert 重新插回来（路径还在磁盘上），路径断言完全看不出差别。但重插的行 work_id 丢了，
 *  下轮巡检就是一整轮重识别 + 重找字幕的付费 LLM。work_id 才是"这行有没有被删过"的凭据。 */
function seedFiles(db: ReturnType<typeof openDb>, paths: string[]): void {
  const ins = db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, updated_at)
                          VALUES (?,?,?,?,?,?,?,?)`)
  for (const p of paths) {
    const dir = p.slice(0, p.lastIndexOf('/'))
    ins.run(p, dir, p.slice(p.lastIndexOf('/') + 1), BIG, 1000, dir, `tmdb:${p}`, 1000)
  }
}

function pathsInDb(db: ReturnType<typeof openDb>): string[] {
  return (db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]).map(r => r.path)
}

/** 存活证据：path + work_id。work_id 为 null 说明这行曾被删掉又被 upsert 插回来（误删）。 */
function rowsInDb(db: ReturnType<typeof openDb>): Array<{ path: string; work_id: string | null }> {
  return db.prepare('SELECT path, work_id FROM files ORDER BY path').all() as Array<{ path: string; work_id: string | null }>
}

/** 期望这批路径原封不动地活着（work_id 未丢）。 */
function alive(paths: string[]): Array<{ path: string; work_id: string | null }> {
  return paths.map(p => ({ path: p, work_id: `tmdb:${p}` }))
}

/** 把「磁盘现状」建模成 root → 路径数组的表；值为 'EIO' 时模拟该守备目录不可访问。 */
function fakeFs(disk: Record<string, string[] | 'EIO'>) {
  return {
    listVideoFiles: (root: string) => {
      const v = disk[root]
      if (v === 'EIO') throw new Error(`ENOENT: mount gone ${root}`)
      return v ?? []
    },
    statFile: (_p: string) => ({ mtimeMs: 1000, size: BIG }),
  }
}

/** 直接驱动阶段 1，不跑整轮巡检——删除语义是纯同步的库/磁盘比对，绕开 agent 噪音。 */
async function scan(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).scanOnce()
}

describe('ScoutDaemonV2.scanOnce · 删除清理（C1 / R6 / R7）', () => {
  it('文件在磁盘消失 → 该 files 行被删除', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': ['/media/Show/E01.mkv'] }),   // E02 被用户删了
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    db.close()
  })

  it('整个作品目录消失 → 该目录下所有行被删除', async () => {
    const db = openDb(':memory:')
    seedFiles(db, [
      '/media/Gone/E01.mkv', '/media/Gone/E02.mkv', '/media/Gone/S02/E01.mkv',
      '/media/Stay/E01.mkv',
    ])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': ['/media/Stay/E01.mkv'] }),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Stay/E01.mkv'])
    db.close()
  })

  it('文件仍在且指纹未变 → 不删不改（幂等）', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv'])
    const before = db.prepare('SELECT * FROM files WHERE path = ?').get('/media/Show/E01.mkv')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': ['/media/Show/E01.mkv'] }),
    }))
    await scan(daemon)
    await scan(daemon)   // 跑两遍：幂等意味着第二遍也不该动它
    expect(db.prepare('SELECT * FROM files WHERE path = ?').get('/media/Show/E01.mkv')).toEqual(before)
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · 防线 1：R8 挂载保护', () => {
  it('守备目录不可访问 → 跳过删除，不清库', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': 'EIO' }),
      log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    expect(logs.join('\n')).toMatch(/跳过删除/)
    db.close()
  })

  it('守备目录扫出 0 个媒体文件 → 跳过删除，不清库（115 FUSE 掉线时目录"看起来是空的"）', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [] }),
      log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    expect(logs.join('\n')).toMatch(/跳过删除/)
    db.close()
  })

  it('挂载恢复后删除正常生效（证明防线 1 不是永久禁用删除）', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const disk: Record<string, string[] | 'EIO'> = { '/media': 'EIO' }
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: (root: string) => {
        const v = disk[root]
        if (v === 'EIO') throw new Error('mount gone')
        return v ?? []
      },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toHaveLength(2)          // 掉线期间一行不动
    disk['/media'] = ['/media/Show/E01.mkv']       // 挂载回来了，E02 确实没了
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · 防线 4：逐根隔离（D1）', () => {
  it('删除不波及其他守备目录的行——且一个根掉线不影响另一个根的删除', async () => {
    const db = openDb(':memory:')
    seedFiles(db, [
      '/media/tv/Show/E01.mkv', '/media/tv/Show/E02.mkv',
      '/media/movies/A/a.mkv', '/media/movies/B/b.mkv',
    ])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media/tv', '/media/movies'],
      ...fakeFs({
        '/media/tv': ['/media/tv/Show/E01.mkv'],   // E02 真没了 → 该删
        '/media/movies': 'EIO',                    // 掉线 → 一行都不许动
      }),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual([
      '/media/movies/A/a.mkv', '/media/movies/B/b.mkv', '/media/tv/Show/E01.mkv',
    ])
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · 防线 2：D20 嵌套根整体跳过', () => {
  it('存量嵌套根 → 整个跳过删除且打日志（C29：115 掉线时 /media 的差集会吃掉 115 全库）', async () => {
    const db = openDb(':memory:')
    // 第 1a 步的 detectNestedRoots 只**告警**、不改用户配置，所以存量嵌套是真实可达状态
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media', 'local', 1)
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media/115', 'local', 1)
    seedFiles(db, ['/media/tv/Show/E01.mkv', '/media/115/Anime/E01.mkv', '/media/tv/Show/E02.mkv'])
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media', '/media/115'],
      ...fakeFs({
        '/media': ['/media/tv/Show/E01.mkv'],   // walk 成功，但看不到掉线的 115
        '/media/115': 'EIO',
      }),
      log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 内层外层都算，一行不许删：
    //  · /media/115/... 由防线 3 的前缀排除兜住（它不归 /media 的差集管）
    //  · /media/tv/Show/E02.mkv 前缀上确实归 /media 管、且本轮确实没扫到 →
    //    **只有防线 2 能救它**。这一行是本用例的咬合点：删掉 nestedRootSet 检查它就会红。
    expect(pathsInDb(db)).toEqual([
      '/media/115/Anime/E01.mkv', '/media/tv/Show/E01.mkv', '/media/tv/Show/E02.mkv',
    ])
    expect(logs.join('\n')).toMatch(/嵌套/)
    db.close()
  })

  it('嵌套根跳过删除但 upsert 照常（新文件仍能入库）', async () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media', 'local', 1)
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media/115', 'local', 1)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media', '/media/115'],
      ...fakeFs({ '/media': ['/media/tv/New/E01.mkv'], '/media/115': [] }),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/tv/New/E01.mkv'])
    db.close()
  })

  it('无嵌套配置 → 删除照常生效（防线 2 不得误伤正常配置）', async () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media/tv', 'local', 1)
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media/movies', 'local', 1)
    seedFiles(db, ['/media/tv/Show/E01.mkv', '/media/tv/Show/E02.mkv'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media/tv', '/media/movies'],
      ...fakeFs({ '/media/tv': ['/media/tv/Show/E01.mkv'], '/media/movies': ['/media/movies/A/a.mkv'] }),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/movies/A/a.mkv', '/media/tv/Show/E01.mkv'])
    db.close()
  })
})

describe("ScoutDaemonV2.scanOnce · 防线 3：D21 根目录 '/' 防护", () => {
  it("'/' 作为守备目录时，它的差集不得覆盖其他守备目录名下的行", async () => {
    const db = openDb(':memory:')
    // 注意这里刻意**不写 media_roots**：deps.roots 是构造时的快照，与表可以漂移
    // （watchV2 读一次就再不刷新）。防线 2 靠不上时，防线 3 必须独立顶住——
    // substr(path,1,1)='/' 对每一条绝对路径都为真，一旦漏防就是全库清空。
    seedFiles(db, ['/media/tv/Show/E01.mkv', '/media/tv/Show/E02.mkv', '/etc/x/root-owned.mkv'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/', '/media/tv'],
      ...fakeFs({
        '/': ['/etc/x/root-owned.mkv'],                 // '/' 自己看到的
        '/media/tv': ['/media/tv/Show/E01.mkv'],        // tv 名下 E02 真没了
      }),
    }))
    await scan(daemon)
    // '/' 的差集只管不归更深根的行；/media/tv 的删除由它自己负责。
    // 断言必须看 work_id：/media/tv/Show/E01.mkv 即便被 '/' 误删，也会被 /media/tv 自己的
    // upsert 立刻插回来（文件还在磁盘上）→ 路径断言全绿，可 work_id 已经丢了，下轮就是
    // 一整轮重识别 + 重找字幕的付费 LLM。这正是 C29 的真实伤害形态。
    expect(rowsInDb(db)).toEqual(alive(['/etc/x/root-owned.mkv', '/media/tv/Show/E01.mkv']))
    db.close()
  })

  it("'/' 名下的文件消失仍能被删除（防线 3 不是把 '/' 整个豁免）", async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/etc/x/a.mkv', '/etc/x/b.mkv', '/media/tv/Show/E01.mkv'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/', '/media/tv'],
      ...fakeFs({ '/': ['/etc/x/a.mkv'], '/media/tv': ['/media/tv/Show/E01.mkv'] }),
    }))
    await scan(daemon)
    expect(rowsInDb(db)).toEqual(alive(['/etc/x/a.mkv', '/media/tv/Show/E01.mkv']))
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · LIKE 陷阱：路径含 % 与 _', () => {
  it('守备目录名含 % / _ 时，作用域不得把兄弟目录的行卷进来', async () => {
    const db = openDb(':memory:')
    // LIKE 语义下 '/media/Look_Back/%' 会匹配 '/media/LookXBack/...'（_ = 任意一字符），
    // '/media/100% Pascal-sensei/%' 会匹配 '/media/100Z Pascal-sensei/...'（% = 任意串）。
    // 这两个兄弟根都健康、都扫到了自己的文件，一旦被卷进别人的差集就是无辜误删。
    seedFiles(db, [
      '/media/Look_Back/E01.mkv', '/media/Look_Back/E02.mkv',
      '/media/LookXBack/E01.mkv',
      '/media/100% Pascal-sensei/E01.mkv',
      '/media/100Z Pascal-sensei/E01.mkv',
    ])
    const roots = ['/media/Look_Back', '/media/LookXBack', '/media/100% Pascal-sensei', '/media/100Z Pascal-sensei']
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots,
      ...fakeFs({
        '/media/Look_Back': ['/media/Look_Back/E01.mkv'],   // E02 真没了 → 只它该删
        '/media/LookXBack': ['/media/LookXBack/E01.mkv'],
        '/media/100% Pascal-sensei': ['/media/100% Pascal-sensei/E01.mkv'],
        '/media/100Z Pascal-sensei': ['/media/100Z Pascal-sensei/E01.mkv'],
      }),
    }))
    await scan(daemon)
    // 同样必须看 work_id：这几个兄弟根都健康、文件都在磁盘上，被误删的行会被自己那个根的
    // upsert 立刻插回来 → 路径断言看不出任何差别，只有 work_id 会露出破绽。
    expect(rowsInDb(db)).toEqual(alive([
      '/media/100% Pascal-sensei/E01.mkv',
      '/media/100Z Pascal-sensei/E01.mkv',
      '/media/LookXBack/E01.mkv',
      '/media/Look_Back/E01.mkv',
    ]))
    db.close()
  })

  it('路径含 % / _ 的目录整体消失时能被正确清理', async () => {
    const db = openDb(':memory:')
    seedFiles(db, [
      '/media/100% Pascal-sensei/E01.mkv', '/media/Look_Back/E01.mkv', '/media/Plain/E01.mkv',
    ])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': ['/media/Plain/E01.mkv'] }),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Plain/E01.mkv'])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 第 1b 步（续）：指纹变化状态重置（C11）+ embedded_langs 写入（C12）
//
// C11 的血案：用户把某集 720p 换成 1080p（**同路径、不同文件**）。旧的
// `ON CONFLICT DO UPDATE SET` 只覆盖 dir/filename/size/mtime/... 这批机械事实，
// 状态列（sub_status='covered' 等）原封不动残留 → 新文件明明没字幕，系统认为已覆盖，
// 永不补。这直接违背 R6"磁盘是真源，数据库是投影"。
//
// C12 的血案（本仓第三次栽在"写了某列却没人写/没人读"这一模式上，见 D17）：
// files.embedded_langs 全仓无人写入 → 永远 NULL → judge 规则 2（"已有内嵌中文轨 → 跳过"）
// 在新架构下**静默失效**，本该跳过的片子被送进字幕流白找一圈付费 LLM；D9 的 translatable
// 预判（日漫有日文内嵌轨时可翻译）同样失去前提，会误判死一批能救的片子。
//
// 这批用例的重点有三处咬合：
//   ① 逐列断言，不是只断言一列——C11 的六列各自对应一条独立的卡死通路，漏一列就是漏一个洞
//   ② 指纹**未变**时状态列必须原封不动（防"每轮巡检清空全库状态"这个过度清空的反向灾难）
//   ③ 指纹未变时**不许调 probe**（性能红线：115 网盘是 rclone FUSE 挂载，ffprobe 12-16s/文件）
// ─────────────────────────────────────────────────────────────────────────────

/** C11 关心的状态列 + judge/字幕流读它们的凭据。逐列取出来做断言，不做整行 toEqual
 *  ——整行断言会把 size/mtime/updated_at 这些**本来就该变**的机械列混进来，一变就红，
 *  于是维护者只会把断言改松，最后退化成"只断言 path"那种骗人的测试。
 *
 *  列集合按 schema 实际有的列取（`sub_attempt` / `translatable` 归 spec 第 3 步加，本步的库里
 *  还没有）——测试与实现共用同一条"按实际列取"的口径，否则第 3 步加完列，这里会静默漏测。 */
function stateOf(db: ReturnType<typeof openDb>, path: string): Record<string, unknown> {
  const have = new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map(c => c.name))
  const cols = ['work_id', 'needs_subtitle', 'sub_status', 'sub_attempt', 'sub_retry_streak',
    'translatable', 'recheck_after', 'embedded_langs', 'duration_sec'].filter(c => have.has(c))
  return db.prepare(`SELECT ${cols.join(', ')} FROM files WHERE path = ?`).get(path) as Record<string, unknown>
}

/** 造一行"已经走完全流程"的 files 行：识别过、判过、字幕覆盖过、探测过。
 *  换片源的伤害只有在这种"状态最满"的行上才看得见——空行没有可残留的东西。
 *  `sub_attempt`/`translatable` 只在库里真有这两列时才播种（第 3 步之后）。 */
function seedSettledFile(
  db: ReturnType<typeof openDb>,
  path: string,
  over: Partial<{ mtime: number; size: number; sub_status: string | null; needs_subtitle: number | null }> = {},
): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const have = new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map(c => c.name))
  const row: Record<string, unknown> = {
    path, dir, filename: path.slice(path.lastIndexOf('/') + 1),
    size: over.size ?? BIG, mtime: over.mtime ?? 1000, work_dir: dir, work_id: 'tmdb:42',
    needs_subtitle: over.needs_subtitle === undefined ? 1 : over.needs_subtitle,
    sub_status: over.sub_status === undefined ? 'covered' : over.sub_status,
    recheck_after: 9_999_999_999, embedded_langs: '["chi","eng"]', duration_sec: 1440, updated_at: 1000,
  }
  if (have.has('sub_attempt')) row.sub_attempt = 3
  // 播种一个"半程折算进度"（第 5 步下游加的 sub_retry_streak）：换片源的伤害只有在
  // 状态最满的行上才看得见。CAP-1 是最危险的取值——不清的话，新片源第一次撞限流就
  // 凭空折算出一次"真实尝试"，而它一次都没被真正搜过。
  if (have.has('sub_retry_streak')) row.sub_retry_streak = 2
  if (have.has('translatable')) row.translatable = 1
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO files (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => row[c]))
}

/** 磁盘建模 + 可数的探针。每个探针都记一次调用，用于"未变化的文件绝不 probe"的红线断言。 */
function fakeFsWithProbe(
  disk: Record<string, string[] | 'EIO'>,
  stats: Record<string, { mtimeMs: number; size: number }>,
  probeImpl?: (p: string) => Promise<Array<{ lang: string | null; codec: string | null; isImageBased: boolean }> | null>,
  durationImpl?: (p: string) => Promise<number | null>,
) {
  const probeCalls: string[] = []
  const durationCalls: string[] = []
  return {
    probeCalls,
    durationCalls,
    deps: {
      listVideoFiles: (root: string) => {
        const v = disk[root]
        if (v === 'EIO') throw new Error(`ENOENT: mount gone ${root}`)
        return v ?? []
      },
      statFile: (p: string) => stats[p] ?? { mtimeMs: 1000, size: BIG },
      probe: async (p: string) => {
        probeCalls.push(p)
        return probeImpl ? await probeImpl(p) : [{ lang: 'jpn', codec: 'subrip', isImageBased: false }]
      },
      probeDuration: async (p: string) => {
        durationCalls.push(p)
        return durationImpl ? await durationImpl(p) : 1500
      },
    },
  }
}

describe('ScoutDaemonV2.scanOnce · C11 指纹变化状态重置', () => {
  const P = '/media/Show/E01.mkv'

  it('mtime 变化（换片源）→ 状态列被逐列清空，work_id 保留', async () => {
    const db = openDb(':memory:')
    seedSettledFile(db, P, { mtime: 1000 })
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 5000, size: BIG } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)

    const s = stateOf(db, P)
    // 逐列断言：这几列各自是一条独立的卡死通路。
    //  · sub_status='covered' 残留 → 字幕流谓词 `sub_status IS NULL` 永远看不见它 → 永不补字幕
    //  · needs_subtitle=1/0 残留 → judge 谓词 `needs_subtitle IS NULL` 永不重判（C11 与 D17 同型：
    //    我们下一行就把 embedded_langs 清成 NULL 了，清掉证据却留着据此做出的判决 = 判决永久冻结。
    //    真实伤害：旧 720p 自带中文内嵌轨 → needs_subtitle=0；换成无中文轨的 1080p 后仍是 0 → 永不补）
    //  · sub_attempt=3 残留 → 新片源自带 3 次失败额度，4 次就进停牌（本该有 7 次）
    //  · recheck_after 残留 → 未来时刻的退避把新文件挡在字幕工作台外
    //  · embedded_langs/duration_sec 残留 → 描述的是**上一个文件**的内容，是纯错误事实
    expect(s.sub_status).toBeNull()
    expect(s.needs_subtitle).toBeNull()
    expect(s.recheck_after).toBeNull()
    // work_id 保留（C11 明写"同路径通常仍是同作品"）：换片源不改身份，清了就是白烧一轮识别 LLM
    expect(s.work_id).toBe('tmdb:42')
    // 机械事实照常更新
    expect(db.prepare('SELECT mtime FROM files WHERE path = ?').get(P)).toEqual({ mtime: 5000 })
    db.close()
  })

  it('size 变化（同 mtime，改封装/重灌）→ 状态列同样被清空', async () => {
    const db = openDb(':memory:')
    seedSettledFile(db, P, { mtime: 1000, size: BIG })
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 1000, size: BIG * 2 } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)

    const s = stateOf(db, P)
    expect(s.sub_status).toBeNull()
    expect(s.needs_subtitle).toBeNull()
    expect(s.recheck_after).toBeNull()
    expect(s.work_id).toBe('tmdb:42')
    db.close()
  })

  it('sub_attempt / translatable 列一旦存在（spec 第 3 步加列后）也必须被清', async () => {
    const db = openDb(':memory:')
    // 这两列原本归 spec 第 3 步加，本用例当初用手工 `ALTER TABLE ... ADD COLUMN` **预演**
    // 未来的 schema，把"未来加的列会自动被清"这件事提前钉住（实现按 PRAGMA 取交集）。
    //
    // 🔴 3-2 已真正加上这两列（v34/v35），预演随之到期：裸 ALTER 会撞 `duplicate column name`。
    // 处置是**把预演换成前置断言**而不是删掉本用例——它守的行为一点没变，反而变得更强：
    // 当初断言的是"假设将来有这两列，清空逻辑会覆盖它们"，现在断言的是"这两列真的在库里，
    // 且真的被清"。删掉它就等于把 v34 那条 `NOT NULL DEFAULT 0` 与 1b-3 的 dflt_value 回落
    // 之间的咬合（下面 toBe(0) 那条）交还给运气。
    const cols = new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map(c => c.name))
    expect(cols.has('sub_attempt')).toBe(true)
    expect(cols.has('translatable')).toBe(true)
    seedSettledFile(db, P, { mtime: 1000 })
    expect(stateOf(db, P).sub_attempt).toBe(3)   // 前置条件成立，否则下面断言无意义
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 5000, size: BIG } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)

    const s = stateOf(db, P)
    // sub_attempt 残留 → 新片源自带 3 次失败额度，4 次就进停牌（本该有 7 次）。
    // 值是 **0 而不是 NULL**：sub_attempt 是 NOT NULL DEFAULT 0（D22），清空按 dflt_value
    // 回落。写成 NULL 会当场撞 NOT NULL 约束把整轮扫描炸掉——这正是 1b-3 用 PRAGMA 读
    // dflt_value 而不是一律写 NULL 的全部理由。
    expect(s.sub_attempt).toBe(0)
    // translatable 残留 → D9 的可救性判决是基于**上一个文件**的内嵌轨算出来的，
    // 而我们刚把 embedded_langs 清成 NULL：清掉证据留下判决 = 判决永久冻结（D17 同型）
    expect(s.translatable).toBeNull()
    db.close()
  })

  it('🔴 sub_retry_streak 换片源时也被清（否则新片源自带"半程折算进度"）', async () => {
    // 论证：streak 的语义是"连续几轮**这个文件**在源站上问不到"。换片源之后这一行代表的是
    // 另一个文件（mtime/size 全变、embedded_langs 与 sub_attempt 都已清）。留着旧文件攒的
    // streak = 新片源自带半程折算进度：seedSettledFile 播的是 CAP-1，不清的话新文件第一次
    // 撞限流就凭空折算出一次"真实尝试"，而它一次都没被真正搜过。与 sub_attempt 残留
    // （新片源自带失败额度）是同一个洞的另一扇门。
    //
    // 值是 **0 而不是 NULL**：这一列是 NOT NULL DEFAULT 0，清空按 dflt_value 回落。
    // 写 NULL 会当场撞 NOT NULL 约束把整轮扫描炸掉。
    const db = openDb(':memory:')
    const cols = new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map(c => c.name))
    expect(cols.has('sub_retry_streak')).toBe(true)
    seedSettledFile(db, P, { mtime: 1000 })
    expect(stateOf(db, P).sub_retry_streak).toBe(2)   // 前置条件成立，否则本用例是空转的假绿
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 5000, size: BIG } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)
    expect(stateOf(db, P).sub_retry_streak).toBe(0)
    db.close()
  })

  it('指纹未变 → 状态列一列不动（防"每轮巡检清空全库状态"的反向灾难）', async () => {
    const db = openDb(':memory:')
    seedSettledFile(db, P, { mtime: 1000, size: BIG })
    const before = stateOf(db, P)
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 1000, size: BIG } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)
    await scan(daemon)   // 跑两遍：过度清空往往只在第二轮才露出来
    expect(stateOf(db, P)).toEqual(before)
    db.close()
  })

  it('指纹未变 → 一次 probe 都不许调（性能红线：115 是 rclone FUSE，ffprobe 12-16s/文件）', async () => {
    const db = openDb(':memory:')
    seedSettledFile(db, P, { mtime: 1000, size: BIG })
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 1000, size: BIG } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)
    await scan(daemon)
    // 用调用次数而非"结果没变"断言：结果相同可能只是探针恰好返回了同样的值，
    // 掩盖"每轮对全库重探一遍"这个真实成本（生产上是几万文件 × 12s）。
    expect(fs.probeCalls).toEqual([])
    expect(fs.durationCalls).toEqual([])
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · C12 embedded_langs / duration_sec 写入', () => {
  const P = '/media/Show/E01.mkv'

  it('新增文件 → probe 被调用，embedded_langs + duration_sec 落库', async () => {
    const db = openDb(':memory:')
    const fs = fakeFsWithProbe({ '/media': [P] }, {},
      async () => [
        { lang: 'jpn', codec: 'subrip', isImageBased: false },
        { lang: 'eng', codec: 'subrip', isImageBased: false },
      ],
      async () => 1423)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)

    expect(fs.probeCalls).toEqual([P])
    const s = stateOf(db, P)
    // 原始 ffprobe tag 原样存（不归一化）——与 streamProbe.ts 的契约、
    // 与 episodes/movies.embedded_langs 的既有口径一致，归一是消费方 langOf 的事。
    expect(JSON.parse(s.embedded_langs as string)).toEqual(['jpn', 'eng'])
    expect(s.duration_sec).toBe(1423)
    db.close()
  })

  it('图形字幕轨（PGS）与无语言标签的轨被剔除——位图叠加不算"已有可读字幕"', async () => {
    const db = openDb(':memory:')
    const fs = fakeFsWithProbe({ '/media': [P] }, {},
      async () => [
        { lang: 'chi', codec: 'hdmv_pgs_subtitle', isImageBased: true },  // 位图，无法当文本用
        { lang: null, codec: 'subrip', isImageBased: false },             // 无 tag，无从判语言
        { lang: 'eng', codec: 'subrip', isImageBased: false },
      ])
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)
    // 若不剔除 PGS：judge 规则 2 会把这行判成"已有内嵌中字 → needs_subtitle=0"，
    // 而用户实际看到的是一条没法读的位图轨——本该找字幕的片子被永久跳过。
    // 口径复用 ingest.ts 的 usableEmbeddedLangs（同一份"图形字幕不算覆盖"的既有裁决）。
    expect(JSON.parse(stateOf(db, P).embedded_langs as string)).toEqual(['eng'])
    db.close()
  })

  it('指纹变化 → probe 重跑并覆盖旧值（不是留着上一个文件的探测结果）', async () => {
    const db = openDb(':memory:')
    seedSettledFile(db, P, { mtime: 1000 })   // 旧值 '["chi","eng"]' / 1440
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 7000, size: BIG } },
      async () => [{ lang: 'jpn', codec: 'subrip', isImageBased: false }],
      async () => 1500)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)

    expect(fs.probeCalls).toEqual([P])
    const s = stateOf(db, P)
    expect(JSON.parse(s.embedded_langs as string)).toEqual(['jpn'])
    expect(s.duration_sec).toBe(1500)
    db.close()
  })

  it('probe 抛错（损坏文件 / 网盘超时）→ 该文件仍入库，其他文件照常，整轮不炸', async () => {
    const db = openDb(':memory:')
    const bad = '/media/Show/BROKEN.mkv'
    const good = '/media/Show/OK.mkv'
    const fs = fakeFsWithProbe({ '/media': [bad, good] }, {},
      async (p) => { if (p === bad) throw new Error('ffprobe timeout'); return [{ lang: 'eng', codec: 'subrip', isImageBased: false }] },
      async (p) => { if (p === bad) throw new Error('ffprobe timeout'); return 1200 })
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps, log: (m: string) => logs.push(m) }))
    // 不抛 = 整轮巡检不被单个损坏文件掀翻（ingest 的既有铁律："一个文件/一次抖动不能拖垮整轮 pass"）
    await expect(scan(daemon)).resolves.toBeUndefined()

    expect(pathsInDb(db)).toEqual([bad, good])
    // 失败文件留 NULL——**NULL 才是"没探测过"**（streamProbe.ts 的 load-bearing 契约）。
    // 若写 []（="探过、确认零轨"）：judge 规则 2 会当"确认无内嵌中字"照常放行（这一步侥幸无害），
    // 但 D9 的 translatable 会据此判"无同语言内嵌轨 → 不可救 → unsolvable"——把一个只是
    // 网盘超时过一次的日漫永久判死。留 NULL 则 D17 的回填 pass 还能靠 `embedded_langs IS NULL`
    // 找回来重探（那个谓词是失败重试的唯一凭据，写了 [] 就等于自己删掉重试通路）。
    expect(stateOf(db, bad).embedded_langs).toBeNull()
    expect(stateOf(db, bad).duration_sec).toBeNull()
    // 兄弟文件不受牵连
    expect(JSON.parse(stateOf(db, good).embedded_langs as string)).toEqual(['eng'])
    expect(stateOf(db, good).duration_sec).toBe(1200)
    expect(logs.join('\n')).toMatch(/probe/)
    db.close()
  })

  it('probe 返回 null（ffprobe 二进制缺席/不可用）→ embedded_langs 留 NULL，不写空数组', async () => {
    const db = openDb(':memory:')
    const fs = fakeFsWithProbe({ '/media': [P] }, {}, async () => null, async () => null)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)
    // streamProbe.ts 的契约把 null 与 [] 分得很死：null="探测不可用"，[]="探过、确认无轨"。
    // 折叠成 [] 会让"这台机器没装 ffprobe"看起来像"全库都确认没有内嵌轨"，
    // 于是 D9 会把全库日漫判成不可救。
    expect(stateOf(db, P).embedded_langs).toBeNull()
    db.close()
  })

  it('probe 返回 []（探过、容器里确实零字幕轨）→ 写空数组，不是 NULL', async () => {
    const db = openDb(':memory:')
    const fs = fakeFsWithProbe({ '/media': [P] }, {}, async () => [], async () => 900)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)
    // 这个区分是 load-bearing 的：D17 的回填 pass 用 `embedded_langs IS NULL` 挑重探对象。
    // 把"确认零轨"记成 NULL → 这批文件每次启动都被回填 pass 重探一遍，
    // 在 115 网盘上就是每次启动几万次 12s 的探测（永不收敛的重探循环）。
    expect(stateOf(db, P).embedded_langs).toBe('[]')
    expect(stateOf(db, P).duration_sec).toBe(900)
    db.close()
  })

  it('探针注入缺席（deps 不提供 probe）→ 扫描照常，不炸', async () => {
    const db = openDb(':memory:')
    // watchV2 之外还有别的构造点（测试脚手架、未来的 CLI 子命令）。probe 是增益不是前提，
    // 缺注入时退化成"只入库、不探测"，绝不能让阶段 1 整个失效。
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], probe: undefined, probeDuration: undefined,
      ...fakeFs({ '/media': [P] }),
    }))
    await expect(scan(daemon)).resolves.toBeUndefined()
    expect(pathsInDb(db)).toEqual([P])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 生产事故回归（FFPROBE_PATH 空串 → 61 文件静默全 NULL、日志报 ok=61）
//
// **为什么上面那整个 C12 describe 抓不到这个 bug**：它全部用假探针替身
// （`probe: async () => [...]`），从不经过 streamProbe.ts 的二进制解析那一档——它验的是
// "探针给了值 → 落库正确"，而生产坏在"探针给不出值"。更深一层：那批用例里
// "probe 返回 null → 留 NULL" 那条是**绿的且行为正确**——单测已经把生产的实际行为
// （全 NULL）断言成了预期行为，所以故障发生时没有任何一条测试变红。
//
// 这一组补两层：
//  B) 跨真实 streamProbe 边界——注入 execFileImpl 而不是替换整个 probe，
//     让二进制解析那一档真的进覆盖范围。
//  C) 钉住三态日志（wrote/unavailable/failed）与"整体不可用" warn 闸。
// ─────────────────────────────────────────────────────────────────────────────
describe('ScoutDaemonV2.scanOnce · FFPROBE_PATH 空串回归（跨真实 streamProbe 边界）', () => {
  const P = '/media/Show/E01.mkv'
  const ORIGINAL_FFPROBE_PATH = process.env.FFPROBE_PATH

  afterEach(() => {
    if (ORIGINAL_FFPROBE_PATH === undefined) delete process.env.FFPROBE_PATH
    else process.env.FFPROBE_PATH = ORIGINAL_FFPROBE_PATH
  })

  /** 与 streamProbe.test.ts 的 fakeExecFile 同形（那边是私有的，这里按同一份口径复述最小版）。 */
  function fakeExecFile(handler: (bin: string, args: readonly string[]) => { stdout: string } | { error: unknown }) {
    return ((bin: string, args: readonly string[], _o: unknown, cb: (e: unknown, so: string, se: string) => void) => {
      const r = handler(bin, args)
      if ('error' in r) cb(r.error, '', '')
      else cb(null, r.stdout, '')
    }) as unknown as typeof nodeExecFile
  }

  /** 把 daemon 的 probe/probeDuration 接到**真实的** streamProbe 上，只把最底层的 execFile
   *  和 ffprobe-static import 换成替身。二进制解析、三态归一、catch 吞错全在覆盖内。 */
  function realProbeDeps(opts: {
    execFileImpl: typeof nodeExecFile
    importFfprobeStatic?: () => Promise<unknown>
  }) {
    return {
      probe: (p: string) => probeEmbeddedSubtitles(p, opts),
      probeDuration: (p: string) => probeDurationSec(p, opts),
    }
  }

  it('FFPROBE_PATH 为空串（compose ${VAR:-} 的默认产物）→ 仍能经 ffprobe-static 探到值并落库', async () => {
    // 这条是整个事故的核心回归：修复前 bin="" → execFile("") 抛 ERR_INVALID_ARG_VALUE
    // → 被 streamProbe 的 catch 吞掉 → 两个探针都返回 null → 两列全 NULL。
    process.env.FFPROBE_PATH = ''
    const db = openDb(':memory:')
    const seenBins: string[] = []
    const execFileImpl = fakeExecFile((bin, args) => {
      seenBins.push(bin)
      return args.includes('-show_format')
        ? { stdout: JSON.stringify({ format: { duration: '210.016' } }) }
        : { stdout: JSON.stringify({ streams: [{ codec_name: 'subrip', tags: { language: 'jpn' } }] }) }
    })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [P] }),
      ...realProbeDeps({ execFileImpl, importFfprobeStatic: async () => ({ path: '/static/ffprobe' }) }),
    }))
    await scan(daemon)

    // 绝不能是空串——空串就是那次 61 文件静默失败的形态
    expect(seenBins).not.toContain('')
    expect(new Set(seenBins)).toEqual(new Set(['/static/ffprobe']))
    const s = stateOf(db, P)
    expect(JSON.parse(s.embedded_langs as string)).toEqual(['jpn'])
    expect(s.duration_sec).toBe(210)
    db.close()
  })

  it('FFPROBE_PATH 指向真实路径时照常使用它（空串归一不该顺手打坏正常配置）', async () => {
    process.env.FFPROBE_PATH = '/usr/bin/ffprobe'
    const db = openDb(':memory:')
    const seenBins: string[] = []
    const execFileImpl = fakeExecFile((bin) => {
      seenBins.push(bin)
      return { stdout: JSON.stringify({ streams: [], format: { duration: '100.5' } }) }
    })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [P] }),
      // 故意也给 static 替身：若解析顺序坏了会用错这个，断言能抓到
      ...realProbeDeps({ execFileImpl, importFfprobeStatic: async () => ({ path: '/static/ffprobe' }) }),
    }))
    await scan(daemon)
    expect(new Set(seenBins)).toEqual(new Set(['/usr/bin/ffprobe']))
    expect(stateOf(db, P).embedded_langs).toBe('[]')
    db.close()
  })

  it('空串 FFPROBE_PATH 且 ffprobe-static 也不可用 → 两列留 NULL 且 execFile 一次不碰（不是 execFile("")）', async () => {
    process.env.FFPROBE_PATH = ''
    const db = openDb(':memory:')
    let execFileCalled = false
    const execFileImpl = fakeExecFile(() => { execFileCalled = true; return { stdout: '{}' } })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [P] }),
      ...realProbeDeps({ execFileImpl, importFfprobeStatic: async () => ({}) }),
    }))
    await scan(daemon)
    // 真的没有可用二进制时留 NULL 是**正确**行为（三态契约）——这里钉的是"以何种方式到达 NULL"：
    // 必须是解析阶段判定不可用，而不是拿空串去 spawn 然后吞掉报错。
    expect(execFileCalled).toBe(false)
    expect(stateOf(db, P).embedded_langs).toBeNull()
    expect(stateOf(db, P).duration_sec).toBeNull()
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · probe 日志三态（可证伪）+ 整体不可用闸', () => {
  const A = '/media/Show/E01.mkv'
  const B = '/media/Show/E02.mkv'

  it('探到值 → wrote=N；旧的 ok=N 口径不再出现（它把静默失败报告成成功）', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = fakeFsWithProbe({ '/media': [A, B] }, {},
      async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }], async () => 1200)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps, log: (m: string) => logs.push(m) }))
    await scan(daemon)
    expect(logs).toContain('scan: probe wrote=2 unavailable=0 failed=0')
    // 旧口径必须彻底消失：`ok=2` 与 `wrote=2 unavailable=0` 在这一轮恰好等价，
    // 正是这种"正常时看不出差别"让它在故障时也没人怀疑。
    expect(logs.join('\n')).not.toMatch(/probe ok=/)
    db.close()
  })

  it('探针整体给不出值（探针不可用）→ wrote=0 unavailable=N，且打一条 warn 明说疑似 FFPROBE_PATH 配置错误', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    // 这正是生产那 61 个文件的形态：probe/probeDuration 都正常返回 null，一次没抛。
    const fs = fakeFsWithProbe({ '/media': [A, B] }, {}, async () => null, async () => null)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps, log: (m: string) => logs.push(m) }))
    await scan(daemon)

    // 旧实现在这里打的是 `scan: probe ok=2 failed=0`——两次静默失败被逐字报告成成功。
    expect(logs).toContain('scan: probe wrote=0 unavailable=2 failed=0')
    const warn = logs.find((m) => m.startsWith('warn: scan: probe 整体不可用'))
    expect(warn, `缺"整体不可用"warn 闸，日志：${logs.join(' | ')}`).toBeDefined()
    // warn 必须点名 FFPROBE_PATH——这条日志的全部价值就是让下一次同类故障在第一次
    // live test 的日志里自证，而不是等人去查数据库发现两列全 NULL。
    expect(warn).toMatch(/FFPROBE_PATH/)
    expect(warn).toMatch(/2 个文件/)
    db.close()
  })

  it('部分探到（一个有值一个不可用）→ 不打整体不可用 warn（那道闸只在"一个都没探到"时响，避免噪音）', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = fakeFsWithProbe({ '/media': [A, B] }, {},
      async (p) => (p === A ? [{ lang: 'eng', codec: 'subrip', isImageBased: false }] : null),
      async (p) => (p === A ? 1200 : null))
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps, log: (m: string) => logs.push(m) }))
    await scan(daemon)
    expect(logs).toContain('scan: probe wrote=1 unavailable=1 failed=0')
    expect(logs.some((m) => m.startsWith('warn: scan: probe 整体不可用'))).toBe(false)
    db.close()
  })

  it('抛异常的文件计入 failed 而非 unavailable（两者排障动作不同：坏文件 vs 坏环境）', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = fakeFsWithProbe({ '/media': [A, B] }, {},
      async (p) => { if (p === A) throw new Error('ffprobe timeout'); return null },
      async (p) => { if (p === A) throw new Error('ffprobe timeout'); return null })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps, log: (m: string) => logs.push(m) }))
    await scan(daemon)
    expect(logs).toContain('scan: probe wrote=0 unavailable=1 failed=1')
    // failed 与 unavailable 混在一起时不算"整体不可用"——抛错那条已有逐文件日志了。
    expect(logs.some((m) => m.startsWith('warn: scan: probe 整体不可用'))).toBe(false)
    db.close()
  })

  it('只有时长探到、字幕轨不可用 → 仍算 wrote（探到任一样东西就不是"整体不可用"）', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = fakeFsWithProbe({ '/media': [A] }, {}, async () => null, async () => 900)
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps, log: (m: string) => logs.push(m) }))
    await scan(daemon)
    expect(logs).toContain('scan: probe wrote=1 unavailable=0 failed=0')
    // embedded_langs 仍按三态契约留 NULL（不可用 ≠ 零轨），但 duration 落了库。
    expect(stateOf(db, A).embedded_langs).toBeNull()
    expect(stateOf(db, A).duration_sec).toBe(900)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 第 1b 步（收尾）：字幕存在性观察（R24 / R23 / C19）+ 两档机制（D12 / D16 / D18 / C42）
//                  + 两份漂移的标签集统一（C30）
//
// 用户原话（R24 的本体）："停牌恢复的前提是翻译 agent 确实翻译出了字幕，这样扫的时候发现了
// 与资源同名的字幕后就自然从停牌变成已获取了，也就是说在实际字幕出现在磁盘中前，显示都是
// 保持停牌。"
//
// 这句话把 covered 从"流程结果"改成了"事实观察"：**唯一有权写 covered 的是扫描**，
// 不是字幕/翻译 worker 的成功报告。worker 只负责把文件放到磁盘上，磁盘上有没有由扫描说了算。
// 三个连带收益（都是这批用例要钉住的东西）：
//   ① worker 声称装盘成功但文件其实没落地 → 系统不会误认为搞定
//   ② 用户嫌翻译质量差手删字幕 → 下次扫描自然回退 NULL 重新去找（C19 从根上消解，
//      **不需要任何额外的"回滚"逻辑**——这正是"事实观察"这个建模的全部价值）
//   ③ 用户自己手放一个字幕 → 扫描扫到就认（系统从未为它跑过字幕流也认）
//
// 而 R24 的代价是每个视频 15 中文标签 × 4 扩展名 = 60 次 stat，生产上有个守备目录是 115
// 网盘的 rclone FUSE 挂载（放大约 46 倍）→ 故有 D12 的两档机制。这批用例里**最贵的一条**
// 不是"能不能扫到字幕"，而是「未到点的文件一次 stat 都不许发」那条性能红线。
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_000_000_000_000   // mkDeps 注入的 now，与之保持一致

/** 磁盘上的字幕文件集合 + **低层** fileExists 探测日志。
 *
 *  为什么 spy 打在 fileExists 这一层，而不是注入一个 per-video 的 `hasChineseSubtitle()`：
 *  注入点越高层，测试就越测不到"这一轮到底发了多少次 stat"——而 D12 整套两档机制存在的
 *  唯一理由就是这个次数（115 FUSE 上 60 次/文件 × 46 倍放大）。高层 spy 会让"B 档退化成
 *  全量扫描"这种性能灾难在测试里完全隐形：状态列结果一模一样，全绿。 */
function fakeSubtitleDisk(subtitles: string[]) {
  const present = new Set(subtitles)
  const calls: string[] = []
  return {
    calls,
    fileExists: (p: string) => { calls.push(p); return present.has(p) },
    /** 往磁盘上放/删一个字幕（模拟用户手动操作、或 worker 装盘）。 */
    put: (p: string) => { present.add(p) },
    remove: (p: string) => { present.delete(p) },
    /** 从探测日志反推「本轮真的被检测过的视频」——性能红线断言的凭据。 */
    checkedVideos: (videos: string[]) => videos.filter((v) => {
      const prefix = v.replace(/\.[^.]+$/, '') + '.'
      return calls.some((c) => c.startsWith(prefix))
    }),
  }
}

/** 造一行"指纹与磁盘一致"的既有行，可指定 sub_status 与 sub_recheck_at。
 *  指纹一致是关键前置：否则它会落进 A 档，B 档的用例就测不到自己想测的东西了。 */
function seedRow(
  db: ReturnType<typeof openDb>,
  path: string,
  opts: { sub_status?: string | null; sub_recheck_at?: number | null; needs_subtitle?: number | null } = {},
): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                 needs_subtitle, sub_status, sub_recheck_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, dir, 'tmdb:42',
      opts.needs_subtitle === undefined ? 1 : opts.needs_subtitle,
      opts.sub_status === undefined ? null : opts.sub_status,
      opts.sub_recheck_at === undefined ? NOW + 5 * DAY : opts.sub_recheck_at,   // 默认「未到点」
      1000)
}

function subStatusOf(db: ReturnType<typeof openDb>, path: string): string | null {
  return (db.prepare('SELECT sub_status FROM files WHERE path = ?').get(path) as { sub_status: string | null }).sub_status
}

function recheckAtOf(db: ReturnType<typeof openDb>, path: string): number | null {
  return (db.prepare('SELECT sub_recheck_at FROM files WHERE path = ?').get(path) as { sub_recheck_at: number | null }).sub_recheck_at
}

describe('ScoutDaemonV2.scanOnce · R24 字幕存在性观察（covered 是事实观察，不是流程结果）', () => {
  const V = '/media/Show/E01.mkv'

  it('视频旁有同名中文字幕 → covered（**系统从未为它跑过字幕流也认**，用户手放的也认）', async () => {
    const db = openDb(':memory:')
    // 刻意不播种任何行：这是一个全新文件，系统从来没为它跑过字幕流、没装过盘。
    // R24 的建模下这不重要——covered 的判据是"磁盘上现在有没有"，不是"我们做过什么"。
    const sub = fakeSubtitleDisk([`/media/Show/E01.zh-Hans.srt`])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('covered')
    db.close()
  })

  it('原为 covered 但字幕被用户删了 → 回退 NULL，重进字幕工作台（C19 从根上消解）', async () => {
    const db = openDb(':memory:')
    // C19 的血案：用户嫌翻译质量差手删 .zh-Hans.srt → 视频 mtime/size **一点没变** →
    // 旧实现的扫描整行跳过 → judge 不看 → 字幕流谓词 sub_status IS NULL 看不见它
    // → 永久失覆盖，而界面上写着"已获取"。
    // R24 之下不需要写任何"回滚"逻辑：每轮复核就是重新观察一次事实，事实变了结论自然跟着变。
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])   // 字幕已被删
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it('原为 covered 且字幕仍在 → 保持 covered，不重复排队', async () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk(['/media/Show/E01.zh-Hans.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('covered')
    db.close()
  })

  it.each([['handoff_translate'], ['unsolvable']])(
    '停牌态（%s）的文件突然出现字幕 → 变 covered，停牌自然解除（R23）',
    async (stalled) => {
      const db = openDb(':memory:')
      // R23 的本体：「停牌」不是流程状态，而是"磁盘上当前没有中文字幕"这一事实。
      // 解除停牌的唯一凭据就是扫描发现同名字幕——翻译流领走了/在跑/跑失败期间一律仍显示停牌。
      // 这一条同时是 unsolvable「无永久终态」（R26）的实现证据。
      seedRow(db, V, { sub_status: stalled, sub_recheck_at: NOW - 1 })
      const sub = fakeSubtitleDisk(['/media/Show/E01.zh-Hans.srt'])   // 翻译 agent 刚装盘 / 用户手放
      const daemon = new ScoutDaemonV2(mkDeps(db, {
        roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
      }))
      await scan(daemon)
      expect(subStatusOf(db, V)).toBe('covered')
      db.close()
    })

  it('字幕不在、且原状态不是 covered → 不动那个状态（停牌不许被扫描擅自解除）', async () => {
    const db = openDb(':memory:')
    // 反向红线：R24 只授权扫描做两件事——发现字幕写 covered、发现字幕消失把 covered 回退。
    // 它**没有**被授权把停牌写回 NULL：那是阶段 2.6 复查闸的职责（D13），且节奏是周频。
    // 若扫描顺手把 handoff_translate 清成 NULL，就会掀掉飞行中的翻译（D10 守卫匹配 0 行
    // → 退避不写 → 付费 LLM 热循环从侧门回来）。
    seedRow(db, V, { sub_status: 'handoff_translate', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('handoff_translate')
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · C30 两份漂移标签集统一', () => {
  const V = '/media/Show/E01.mkv'

  // 改动前**两套标签集互不兼容**，各漏一半（这正是 C30）：
  //   · files/sidecar.ts   ：15 个中文 tag（含 cht 与全部 BCP-47 地区变体），但 **缺 .vtt**
  //   · daemonV2.ts:189 正则：有 .vtt，但只认 zh|chs|chi|zho，**缺 cht 与全部地区变体**
  // 于是同一个磁盘事实在两条代码路径上得到相反的结论。本项目已因"留两份漂移实现"栽过
  // （第 1a 步的 findOverlappingRoot），故统一到 sidecar.ts 这一份。
  it.each([
    ['.zh.srt', '/media/Show/E01.zh.srt'],
    ['.zh-Hans.srt', '/media/Show/E01.zh-Hans.srt'],
    ['.chs.ass', '/media/Show/E01.chs.ass'],
    ['.cht.ass（旧正则漏的：cht 是繁体的明确信号）', '/media/Show/E01.cht.ass'],
    ['.zh-TW.srt（旧正则漏的：BCP-47 地区变体，agent 白名单实测装出过）', '/media/Show/E01.zh-TW.srt'],
    ['.zh-cn.srt（Bazarr 遗留小写形态，NAS #recycle 实锤）', '/media/Show/E01.zh-cn.srt'],
    ['.zh-Hant.ssa', '/media/Show/E01.zh-Hant.ssa'],
    ['.zh.vtt（旧 sidecar.ts 漏的扩展名）', '/media/Show/E01.zh.vtt'],
  ])('认得 %s', async (_label, subtitlePath) => {
    const db = openDb(':memory:')
    const sub = fakeSubtitleDisk([subtitlePath])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('covered')
    db.close()
  })

  it('非中文字幕（.en.srt）不得误判为 covered', async () => {
    const db = openDb(':memory:')
    // 误判的代价是永久性的：covered 让字幕流谓词永远看不见这一行，
    // 而用户看到的是界面写着"已获取"、播放器里只有英文字幕。
    const sub = fakeSubtitleDisk(['/media/Show/E01.en.srt', '/media/Show/E01.eng.ass'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it('`X.1080p.zh.srt` 不得误归给 `X.mkv`（C30 误归属）', async () => {
    const db = openDb(':memory:')
    // 旧实现用 `startsWith(stem + '.')` 判同名 → `E01.1080p.zh.srt` 的前缀确实是 `E01.`，
    // 于是它被当成 `E01.mkv` 的字幕。真实剧本：同目录并存 `E01.mkv`（无字幕）与
    // `E01.1080p.mkv`（有字幕）→ 前者被误判 covered，永远不补字幕。
    // 收敛到 findExternalSidecar 后判据变成"构造 `<stem>.<tag><ext>` 再探测存在性"，
    // 精确到字符，这个洞在机制上就不存在了。
    const sub = fakeSubtitleDisk(['/media/Show/E01.1080p.zh.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': ['/media/Show/E01.mkv'] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, '/media/Show/E01.mkv')).toBeNull()
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · D12/D18 A 档：新增/指纹变化全量检测', () => {
  const V = '/media/Show/E01.mkv'

  it('新增文件 → 检测字幕 + 写 sub_recheck_at = now + 7 天', async () => {
    const db = openDb(':memory:')
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(sub.checkedVideos([V])).toEqual([V])
    expect(recheckAtOf(db, V)).toBe(NOW + 7 * DAY)
    db.close()
  })

  it('**新插入的行 sub_recheck_at 非 NULL**（C42 从侧门复活的防线）', async () => {
    const db = openDb(':memory:')
    // 这一条是整批用例里最容易被漏掉、后果最静默的一条（三个前序子代理都点出了这个缺口）：
    // v32 迁移把**存量**行随机打散到未来 7 天内、不留 NULL（D18），但如果 scanOnce 的 upsert
    // 不写这一列，**此后每一个新文件都是 NULL 起步** → B 档谓词 `sub_recheck_at <= now`
    // 在 NULL 上是三值逻辑的 unknown → **永远选不中它们** → D18 防的那个静默失效原样从
    // "新文件"这条侧门回来了，而且只影响新文件，存量库全绿、看不出任何异常。
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(recheckAtOf(db, V)).not.toBeNull()
    db.close()
  })

  // 上面那条**测不到它声称要防的东西**（第四个子代理的变异验证抓到的假绿）：
  // sub_recheck_at 有两个写入者——upsert 的兜底地板、以及 observeSubtitle 的观察路径。
  // 上面那条走的是观察路径正常工作的路子，所以把 upsert 里的 sub_recheck_at 整条摘掉
  // （列 + 占位符 + DO UPDATE 子句 + run 参数）之后，它**依然全绿**（已亲手变异复现）。
  // 它以为自己在钉 upsert，实际钉的是 detectSubtitles，而后者早被同块的另一条钉住了。
  //
  // 这一条把观察路径打断（fileExists 抛错模拟 FUSE stat 抖动），只留 upsert 这一条通路，
  // 才真正钉住"地板"的存在。地板存在的意义：观察路径任何原因没跑到（探针缺席、网盘抖动、
  // 未来有人给 detectSubtitles 加了提前 return），新行也不该留 NULL 起步。
  it('观察路径抖动时 upsert 地板仍保证 sub_recheck_at 非 NULL（C42 真防线）', async () => {
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [V] }),
      fileExists: () => { throw new Error('FUSE stat 抖动') },
    }))
    await scan(daemon)
    expect(recheckAtOf(db, V)).not.toBeNull()
    db.close()
  })

  it('指纹变化的行 → 同样写 sub_recheck_at（换片源后旧的复核排期作废）', async () => {
    const db = openDb(':memory:')
    // 换片源意味着"这个文件旁边有没有中文字幕"这件事的答案可能变了（老片源的字幕对不上新片源
    // 的时长/分段也算变了）。若沿用旧的 sub_recheck_at，最坏情况是再等 7 天才复核。
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW + 6 * DAY })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: () => [V],
      statFile: () => ({ mtimeMs: 9999, size: BIG }),   // 指纹变了
      fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(recheckAtOf(db, V)).toBe(NOW + 7 * DAY)
    expect(sub.checkedVideos([V])).toEqual([V])
    db.close()
  })
})

describe('ScoutDaemonV2.scanOnce · D12 B 档：到点轮转复核', () => {
  it('只挑 sub_recheck_at <= now 的行——**未到点的一次 stat 都不许发**（性能红线）', async () => {
    const db = openDb(':memory:')
    const due = '/media/Show/DUE.mkv'
    const notDue = '/media/Show/LATER.mkv'
    seedRow(db, due, { sub_recheck_at: NOW - 1 })
    seedRow(db, notDue, { sub_recheck_at: NOW + 3 * DAY })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [due, notDue] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 用**调用次数**断言而不是"状态列没变"：两者在结果上完全一致（都没字幕、都是 NULL），
    // 状态断言对"B 档退化成全量扫描"这个性能灾难完全瞎。而这正是 D12 存在的唯一理由——
    // 生产上一个守备目录是 115 网盘的 rclone FUSE 挂载，60 次 stat/文件 × 46 倍放大，
    // 全库几万文件全量复核就是把"秒级的机械扫描"变成跑一整天。
    expect(sub.checkedVideos([due, notDue])).toEqual([due])
    db.close()
  })

  it.each([['covered'], ['unsolvable'], ['handoff_translate'], [null]])(
    'B 档谓词**不按 sub_status 过滤**：sub_status=%s 的行同样轮到（D16 / C37）',
    async (status) => {
      const db = openDb(':memory:')
      // D16 是铁律，不是优化。C37 的推理链：用户手放字幕**不改视频文件指纹** → 这类文件
      // 永远进不了 A 档 → 若 B 档只抽样 covered，则 unsolvable / handoff_translate 的行
      // **永远不被检测** → R23/R24 承诺的"用户手放的也认""停牌自然解除"对停牌态永不生效。
      // 而停牌态恰恰是最需要它的那批（用户看到系统搞不定，才会自己去手放一个字幕）。
      const V = '/media/Show/E01.mkv'
      seedRow(db, V, { sub_status: status, sub_recheck_at: NOW - 1 })
      const sub = fakeSubtitleDisk([])
      const daemon = new ScoutDaemonV2(mkDeps(db, {
        roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
      }))
      await scan(daemon)
      expect(sub.checkedVideos([V])).toEqual([V])
      db.close()
    })

  it('停牌态文件被用户手放字幕 → B 档轮到时发现并转 covered（防 C37 回归的端到端形态）', async () => {
    const db = openDb(':memory:')
    // 上一条证明"轮到了"，这一条证明"轮到之后真的改了状态"——两条都要有：
    // 只断言 checkedVideos 的话，一个"检测了但不写 covered"的实现照样全绿。
    const V = '/media/Anime/E05.mkv'
    seedRow(db, V, { sub_status: 'unsolvable', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk(['/media/Anime/E05.cht.ass'])   // 用户手放了一份繁体
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('covered')
    db.close()
  })

  it('B 档检测后写 sub_recheck_at = now + 7 天（否则下一轮又选中它 → 每轮全量）', async () => {
    const db = openDb(':memory:')
    const V = '/media/Show/E01.mkv'
    seedRow(db, V, { sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(recheckAtOf(db, V)).toBe(NOW + 7 * DAY)
    db.close()
  })

  it('A 档已检测的文件本轮不被 B 档重复检测（先 A 后 B，靠 <= now 谓词天然排除）', async () => {
    const db = openDb(':memory:')
    // 断言"无重复探测路径"而不是"探测次数 == 60"：后者会随标签集/扩展名集扩容而假红，
    // 于是维护者只会把数字改大，最后测不到任何东西。重复路径才是"同一个文件被扫了两遍"的
    // 直接证据，且与标签集大小无关。
    const V = '/media/Show/NEW.mkv'
    const sub = fakeSubtitleDisk([])   // 一个都不命中 → 整个 tag×ext 笛卡尔积都会被探一遍
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(sub.calls.length).toBeGreaterThan(0)                      // 前置：A 档确实扫了
    expect(new Set(sub.calls).size).toBe(sub.calls.length)           // 无任何一条路径被探两次
    db.close()
  })

  it('已从磁盘删除的行不参与 B 档检测（删除清理先于字幕检测）', async () => {
    const db = openDb(':memory:')
    const gone = '/media/Show/GONE.mkv'
    const stay = '/media/Show/STAY.mkv'
    seedRow(db, gone, { sub_recheck_at: NOW - 1 })
    seedRow(db, stay, { sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [stay] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 对已经不存在的文件跑 60 次 stat 是纯浪费，在 FUSE 挂载上尤其贵（ENOENT 也要过网络）。
    expect(sub.checkedVideos([gone, stay])).toEqual([stay])
    expect(pathsInDb(db)).toEqual([stay])
    db.close()
  })

  it('fileExists 注入缺席 → 扫描照常不炸（同 probe：观察是增益，不是阶段 1 的前提）', async () => {
    const db = openDb(':memory:')
    const V = '/media/Show/E01.mkv'
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: undefined,
    }))
    await expect(scan(daemon)).resolves.toBeUndefined()
    expect(pathsInDb(db)).toEqual([V])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C27 / D8：needs_subtitle 与 sub_status 的职责切分（judge 不再判 sidecar）
//
// 卡死链条（spec C27）：judge 规则 3 为"磁盘上有外挂中字"这个**磁盘事实**写 needs_subtitle=0，
// 而 1b-4 又让扫描为同一个事实写 sub_status='covered'。用户嫌翻译质量差手删字幕之后：
//   · 扫描把 sub_status 回退成 NULL ✅
//   · needs_subtitle=0 留着 ✗ → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判它）、
//     又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）→ **这一集永久卡死，永不补字幕**
//
// 而 1b-4 还放大了这个洞：它把 judge 的 sidecar 探测面从"漏 cht 与全部 BCP-47 地区变体"
// 收敛成全认，于是能触发 needs_subtitle=0 的文件变多了，C27 的命中面跟着变大。
//
// 修法（D8）：needs_subtitle 只由**语言事实**决定（origin_lang / 内嵌轨），与磁盘上当前有没有
// 外挂字幕无关；磁盘事实归 sub_status，由扫描独占写入（R24）。
// ─────────────────────────────────────────────────────────────────────────────

/** 直接驱动 judge 阶段（阶段 2.5），绕开识别/字幕两个 agent 阶段的噪音。 */
async function judge(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).judgeOnce()
}

/** 造一行"已识别、未判定"的 files 行——judge 谓词（work_id IS NOT NULL AND
 *  needs_subtitle IS NULL）刚好命中它。origin_lang 挂在 works 上。
 *
 *  sub_recheck_at 默认设成**已到点**：这一行的指纹与 fakeFs 给的 stat 一致（它是上一轮扫描
 *  就已入库的既有行），所以它进不了 A 档，只能靠 B 档轮到。留 NULL 的话它两档都进不去
 *  （`<= now` 在 NULL 上是三值逻辑的 unknown），扫描阶段对它就是个 no-op——而 D18 已经
 *  写死了"库里不留 NULL"，那样的行在生产上根本不存在，拿它当夹具只会测出个假象。 */
function seedJudgeable(
  db: ReturnType<typeof openDb>,
  path: string,
  opts: { originLang?: string | null; embeddedLangs?: string | null; subStatus?: string | null } = {},
): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const workId = 'tmdb:42'
  const has = db.prepare('SELECT id FROM works WHERE id = ?').get(workId)
  if (!has) {
    db.prepare('INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(workId, 'Show', 'tv', opts.originLang === undefined ? 'en' : opts.originLang, 1000, 1000)
  }
  db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                 season, episode, needs_subtitle, sub_status, sub_recheck_at,
                                 embedded_langs, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, dir, workId,
      1, 1, null, opts.subStatus === undefined ? null : opts.subStatus, NOW - 1,
      opts.embeddedLangs === undefined ? null : opts.embeddedLangs, 1000)
}

function needsSubtitleOf(db: ReturnType<typeof openDb>, path: string): number | null {
  return (db.prepare('SELECT needs_subtitle FROM files WHERE path = ?').get(path) as { needs_subtitle: number | null }).needs_subtitle
}

describe('ScoutDaemonV2.judgeOnce · C27/D8 职责切分', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴 磁盘上有外挂中文字幕 → judge **不再**因此写 needs_subtitle=0（它由语言事实决定）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en' })
    const sub = fakeSubtitleDisk(['/media/Show/E01.zh-Hans.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], fileExists: sub.fileExists }))
    await judge(daemon)
    // 改动前：规则 3 命中 → needs_subtitle=0 → 用户手删字幕后永久卡死（C27）。
    // 改动后：origin_lang=en 且无内嵌中文轨 = 这资源**原则上**需要中文字幕，判 1。
    expect(needsSubtitleOf(db, V)).toBe(1)
    db.close()
  })

  it('🔴 判 1 之后仍不会被字幕工作台排中——因为扫描给了它 sub_status=covered（防"修了卡死却引入白找一圈"）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en' })
    const sub = fakeSubtitleDisk(['/media/Show/E01.zh-Hans.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    // 完整走一遍"扫描（写 sub_status）→ judge（写 needs_subtitle）"这两个真实阶段，
    // 不手工造 sub_status——否则测的就不是"两个阶段合起来仍然正确"这件事。
    await scan(daemon)
    await judge(daemon)
    expect(needsSubtitleOf(db, V)).toBe(1)
    expect(subStatusOf(db, V)).toBe('covered')
    // 删掉规则 3 之后，"磁盘已有外挂中字的文件不许被送进字幕流白烧一轮付费 LLM"这个**正确
    // 行为**必须仍然成立，只是换了保证者：从 needs_subtitle=0 换成 sub_status='covered'。
    // 用真实队列函数断言，不复述谓词——谓词是实现细节，复述一遍等于测试自己也维护一份，
    // 两份一漂移测试就变成假绿。
    expect(listSubtitleQueue(db, ['/media'], NOW).flatMap(q => q.files.map(f => f.path))).toEqual([])
    db.close()
  })

  it('🔴 C27 卡死态不再可达：用户手删字幕 → 扫描回退 NULL → 该文件**能**重进字幕工作台', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en' })
    const sub = fakeSubtitleDisk(['/media/Show/E01.zh-Hans.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    // 第 1 轮：字幕在磁盘上 → covered、judge 判 needs=1、队列为空（不白找）
    await scan(daemon)
    await judge(daemon)
    expect(listSubtitleQueue(db, ['/media'], NOW)).toEqual([])

    // 用户嫌翻译质量差，手删了字幕。视频 mtime/size **一点没变**（这正是 C19/C27 的前提），
    // 所以走的是 B 档轮转复核这条路——把复核时刻拨到已到点。
    sub.remove('/media/Show/E01.zh-Hans.srt')
    db.prepare('UPDATE files SET sub_recheck_at = ? WHERE path = ?').run(NOW - 1, V)

    // 第 2 轮：扫描观察到字幕没了 → sub_status 回 NULL
    await scan(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    // needs_subtitle 一列不动（D8：磁盘事实不改语言判决），仍是 1
    expect(needsSubtitleOf(db, V)).toBe(1)
    // **本 bug 的核心红线**：这一集必须能重回字幕工作台。改动前它是 needs_subtitle=0 +
    // sub_status=NULL 的双不满足态 → 永久卡死、界面上看不出任何异常。
    expect(listSubtitleQueue(db, ['/media'], NOW).flatMap(q => q.files.map(f => f.path))).toEqual([V])
    db.close()
  })

  it('国产片（origin_lang 是中文）仍然 needs_subtitle=0（规则 1 不受影响）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'zh' })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], fileExists: sub.fileExists }))
    await judge(daemon)
    expect(needsSubtitleOf(db, V)).toBe(0)
    db.close()
  })

  it('有内嵌中文轨仍然 needs_subtitle=0（规则 2 不受影响）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en', embeddedLangs: '["chi","eng"]' })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], fileExists: sub.fileExists }))
    await judge(daemon)
    expect(needsSubtitleOf(db, V)).toBe(0)
    db.close()
  })

  it('judge 阶段一次 sidecar stat 都不许发（探测面已整条移交扫描，留着就是 84 次/文件白付）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en' })
    const sub = fakeSubtitleDisk(['/media/Show/E01.zh-Hans.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], fileExists: sub.fileExists }))
    await judge(daemon)
    // 用调用次数断言而非结果：一个"照旧探 84 次但把结果丢掉"的实现在状态列上与正确实现
    // 完全一致，全绿——而生产上那是每轮巡检在 115 FUSE 挂载上白付一整套 stat。
    expect(sub.calls).toEqual([])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// D23：字幕存在性观察必须与 R8/D20 的跳过共进退
//
// 1b-2 给删除清理加了 R8 挂载保护（守备目录不可访问 / 扫出 0 个媒体文件 → 跳过该根的删除），
// 但 1b-4 的字幕存在性观察没有这个保护。挂载掉线时 fileExists 对整个根返回 false（或抛错）
// → 该根下所有 covered 被回退成 NULL → 挂载恢复后全部重新找一遍字幕，**而字幕其实一直在
// 磁盘上** → 烧掉整轮 LLM。R8 保护的本意是"目录看起来是空的，别当真"，这个本意对观察同样成立。
//
// 难点：B 档的挑选谓词 `WHERE sub_recheck_at <= now` 是**全库查询、不分根**，所以"哪些根本轮
// 被跳过"这个信息必须显式传进 detectSubtitles，靠库里的列是推不出来的。
// ─────────────────────────────────────────────────────────────────────────────

describe('ScoutDaemonV2.scanOnce · D23 被跳过的根不做字幕观察', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴 守备目录不可访问（walk 抛错）→ 该根下文件不做字幕观察，covered 不被回退', async () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    // 挂载掉线的真实形态：walk 抛错，且此后对该根下任何路径的 stat 一律返回 false
    // ——字幕文件明明在磁盘上，只是这一刻看不见。
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': 'EIO' }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 状态断言（真实伤害）：回退成 NULL 就是下一轮为这一集重跑一整个字幕 agent session。
    expect(subStatusOf(db, V)).toBe('covered')
    // 次数断言（机制）：一次 stat 都不该发——挂载掉线时对整根发 84 次/文件的 ENOENT 探测
    // 是纯浪费（FUSE 上 ENOENT 也要过一趟网络），且状态断言对"探了但恰好没改状态"的实现全瞎。
    expect(sub.calls).toEqual([])
    db.close()
  })

  it('🔴 守备目录扫出 0 个媒体文件 → 同上（115 FUSE 掉线时目录"看起来是空的"）', async () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [] }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('covered')
    expect(sub.calls).toEqual([])
    db.close()
  })

  it('🔴 嵌套根（D20 跳过删除的）→ 同上', async () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media', 'local', 1)
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media/115', 'local', 1)
    const inner = '/media/115/Anime/E01.mkv'
    seedRow(db, inner, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    // C29 的形态：/media 的 walk 成功（它自己不空），但掉线的 115 下面什么都看不见。
    // 删除侧靠 D20 整根跳过；观察侧若不跟着跳，115 全库的 covered 会被一次回退干净。
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media', '/media/115'],
      ...fakeFs({ '/media': ['/media/tv/Show/E01.mkv'], '/media/115': 'EIO' }),
      fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, inner)).toBe('covered')
    expect(sub.checkedVideos([inner])).toEqual([])
    db.close()
  })

  it('挂载恢复后字幕观察正常生效（证明不是永久禁用）', async () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const disk: Record<string, string[] | 'EIO'> = { '/media': 'EIO' }
    const sub = fakeSubtitleDisk([])   // 字幕这次是真被用户删了
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: (root: string) => {
        const v = disk[root]
        if (v === 'EIO') throw new Error('mount gone')
        return v ?? []
      },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBe('covered')   // 掉线期间不动
    disk['/media'] = [V]                          // 挂载回来了
    await scan(daemon)
    expect(subStatusOf(db, V)).toBeNull()        // 这才是真的"字幕没了"
    db.close()
  })

  it('正常根的字幕观察不受被跳过的根影响（隔离性）', async () => {
    const db = openDb(':memory:')
    const okFile = '/media/tv/Show/E01.mkv'
    const deadFile = '/media/115/Anime/E01.mkv'
    seedRow(db, okFile, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    seedRow(db, deadFile, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media/tv', '/media/115'],
      ...fakeFs({ '/media/tv': [okFile], '/media/115': 'EIO' }),
      fileExists: sub.fileExists,
    }))
    await scan(daemon)
    expect(subStatusOf(db, okFile)).toBeNull()      // 健康根照常观察、照常回退
    expect(subStatusOf(db, deadFile)).toBe('covered')  // 掉线根一列不动
    db.close()
  })

  it('🔴 被跳过观察的文件 sub_recheck_at 不许推进（否则挂载恢复后还要再等 7 天才复核）', async () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': 'EIO' }), fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 设计约束的两条边（见 detectSubtitles 里的论证）：
    //  · 推 7 天 → 挂载 5 分钟修好，这批文件的字幕存在性还要再瞎 7 天（B 档是唯一的复核通路）
    //  · 保持不动 → 下一轮 B 档天然重选它们，而"下一轮"是 24h 后的巡检，不是同轮内的循环，
    //    所以不存在 D12 担心的热循环；被跳过的根本轮一次 stat 都没发，成本是 0。
    // 故选"不动"。这与 observeSubtitle 里 stat 抖动时的处置同源（都是"本轮没能观察到"）。
    expect(recheckAtOf(db, V)).toBe(NOW - 1)
    db.close()
  })

  it('被跳过的根不影响它自己的 upsert（新文件仍能入库，只是不观察）', async () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media', 'local', 1)
    db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run('/media/115', 'local', 1)
    const nu = '/media/tv/New/E01.mkv'
    const sub = fakeSubtitleDisk(['/media/tv/New/E01.zh.srt'])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media', '/media/115'],
      ...fakeFs({ '/media': [nu], '/media/115': [] }),
      fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 入库照旧（D20 只跳过删除，upsert 不受影响），但 A 档观察被跳过 → 状态留 NULL，
    // 而 sub_recheck_at 仍由 upsert 的兜底地板写死（C42），下一轮 B 档会补上这次观察。
    expect(pathsInDb(db)).toEqual([nu])
    expect(subStatusOf(db, nu)).toBeNull()
    expect(sub.calls).toEqual([])
    expect(recheckAtOf(db, nu)).not.toBeNull()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 第 2 步：daemonV2 接容器 + 4 个运维器官（C2 + C16 + C22 + D4 + D5）
//
// 血案（db.ts:579-584 注释记有实案）：2026-07-21 软路由掉电，WAL 里 4MB 未 checkpoint 的
// 数据连库一起报废。所以 dbMaintenance 不是"可选增益"，它是这个项目在软路由上的生存条件。
//
// 这批用例守的是**切换动作本身**的两类伤害：
//   ① 静默丢器官（C16 / D5）：旧入口 cmdWatch 上挂着 4 个运维器官，daemonV2 零命中。
//      切过去而不接线 = 从此永不 checkpoint、永不备份、workspace 垃圾无人回收。
//      注意 spy 计数是**必要不充分**的：还必须钉住"运维不跟着 24h 巡检闸走"——
//      每天才 checkpoint 一次，等于把 WAL 里一整天的写入押在"今天不掉电"上。
//   ② 时间闸吃掉 24h（C22 / D4）：失败也推进时间闸 → 挂载抖一下，用户 5 分钟后修好挂载，
//      系统还要睡满 24 小时；而 R8 保护的本意恰恰是"挂载抖动要能优雅恢复"。
//      附带：闸从巡检**结束**算 → 真实周期 = 24h + 本轮耗时，大库跑 10h 就漂成 34h。
// ─────────────────────────────────────────────────────────────────────────────

/** 4 个运维器官的可数替身 + 一份能直接摊进 mkDeps 的 deps 片段。 */
function mkOrgans(over: {
  dbMaintenance?: () => void
  sweepWriteProbes?: () => number
  pruneTraces?: (before: number) => number
} = {}) {
  const calls = { dbMaintenance: 0, gcStaging: 0, sweepWriteProbes: 0, pruneTraces: [] as number[] }
  const gcStagingSaw: Array<string[]> = []
  return {
    calls,
    gcStagingSaw,
    deps: {
      dbMaintenance: () => { calls.dbMaintenance++; over.dbMaintenance?.() },
      gcStaging: (inFlight: ReadonlySet<string>) => {
        calls.gcStaging++
        gcStagingSaw.push([...inFlight])
        return 0
      },
      sweepWriteProbes: () => { calls.sweepWriteProbes++; return over.sweepWriteProbes?.() ?? 0 },
      traceRetentionDays: () => 30,
      runs: {
        pruneTraces: (before: number) => {
          calls.pruneTraces.push(before)
          return over.pruneTraces ? over.pruneTraces(before) : 0
        },
      },
    },
  }
}

/** 跑一次 run() 的头一圈（boot + 维护 + 可能的巡检），然后 abort。
 *  5 分钟的 idle sleep 是可中止的，abort 立刻结算，测试不会真的等。 */
async function oneLoop(daemon: ScoutDaemonV2): Promise<void> {
  const ctrl = new AbortController()
  const p = daemon.run(ctrl.signal)
  await new Promise(r => setTimeout(r, 30))
  ctrl.abort()
  await p
}

function lastInspectAt(db: ReturnType<typeof openDb>): number | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_inspect_at'`).get() as { value: string } | undefined
  return row ? Number(row.value) : null
}

describe('ScoutDaemonV2 · D5 运维器官接线（C16：切换入口不得静默丢失既有能力）', () => {
  it('🔴 4 个运维器官各自被调用（dbMaintenance / gcStaging / sweepWriteProbes / trace 修剪）', async () => {
    const db = openDb(':memory:')
    const o = mkOrgans()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [] }), ...o.deps,
    }))
    await oneLoop(daemon)
    expect(o.calls.dbMaintenance).toBeGreaterThanOrEqual(1)
    expect(o.calls.gcStaging).toBeGreaterThanOrEqual(1)
    expect(o.calls.sweepWriteProbes).toBeGreaterThanOrEqual(1)
    expect(o.calls.pruneTraces.length).toBeGreaterThanOrEqual(1)
    db.close()
  })

  it('🔴 trace 修剪按 retentionDays 算截止时刻（不是随手传个 now）', async () => {
    const db = openDb(':memory:')
    const o = mkOrgans()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [] }),
      ...o.deps, traceRetentionDays: () => 7,
    }))
    await oneLoop(daemon)
    // 只断言"调了"会让 pruneTraces(now) 这种把整个 trace 表清光的实现全绿。
    expect(o.calls.pruneTraces[0]).toBe(NOW - 7 * DAY)
    db.close()
  })

  it('trace 修剪有自己的天级时间门（同一进程内不每圈重跑）', async () => {
    const db = openDb(':memory:')
    const o = mkOrgans()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [] }), ...o.deps,
      maintenanceTickMs: 1,   // 多拍：dbMaintenance 每拍跑，trace 修剪只该跑第一拍
    }))
    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 60))
    ctrl.abort()
    await p
    expect(o.calls.dbMaintenance).toBeGreaterThan(1)   // 证明真的跑了多拍（防假绿）
    expect(o.calls.pruneTraces.length).toBe(1)
    db.close()
  })

  it('🔴 运维器官抛错 → 不拖垮主循环，也不拖垮彼此（运维是增益）', async () => {
    const db = openDb(':memory:')
    const o = mkOrgans({
      dbMaintenance: () => { throw new Error('disk full') },
      sweepWriteProbes: () => { throw new Error('EIO on FUSE') },
      pruneTraces: () => { throw new Error('db locked') },
    })
    const walked: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: (r: string) => { walked.push(r); return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      ...o.deps,
      gcStaging: () => { throw new Error('readdir failed') },
    }))
    await oneLoop(daemon)
    // 每个器官都被尝试过（一个坏了不许短路掉后面的）
    expect(o.calls.dbMaintenance).toBeGreaterThanOrEqual(1)
    expect(o.calls.sweepWriteProbes).toBeGreaterThanOrEqual(1)
    expect(o.calls.pruneTraces.length).toBeGreaterThanOrEqual(1)
    // 巡检照跑（这是"不拖垮主循环"的真实含义，不是"没抛到最外层"）
    expect(walked).toEqual(['/media'])
    expect(lastInspectAt(db)).toBe(NOW)
    db.close()
  })

  it('🔴 运维不受 24h 巡检闸限制（巡检没到点时运维仍在跑）', async () => {
    const db = openDb(':memory:')
    // 1h 前刚巡检过 → 巡检闸关着
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW - 1 * 3600_000))
    const o = mkOrgans()
    const walked: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: (r: string) => { walked.push(r); return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      ...o.deps,
    }))
    await oneLoop(daemon)
    expect(walked).toEqual([])                              // 巡检确实没跑
    expect(o.calls.dbMaintenance).toBeGreaterThanOrEqual(1) // 运维照跑
    expect(o.calls.sweepWriteProbes).toBeGreaterThanOrEqual(1)
    expect(o.calls.pruneTraces.length).toBeGreaterThanOrEqual(1)
    db.close()
  })

  it('运维器官全不注入 → 分支整个休眠，巡检照常（同 DaemonDeps 的 optional 门控口径）', async () => {
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fakeFs({ '/media': [] }) }))
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBe(NOW)
    db.close()
  })
})

describe('ScoutDaemonV2 · C34 gcStaging 的 in-flight 集合', () => {
  it('🔴 gcStaging 只在启动时跑一次，绝不进维护循环（否则会周期性 rm 掉正在跑的工作台）', async () => {
    const db = openDb(':memory:')
    const o = mkOrgans()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [] }), ...o.deps,
      maintenanceTickMs: 1,   // 一个 run() 内驱动出多拍
    }))
    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 60))
    ctrl.abort()
    await p
    // 维护器官每拍都跑（这是 D5 要的"运维不跟着日巡检走"）……
    expect(o.calls.dbMaintenance).toBeGreaterThan(1)
    // ……但 gcStaging 只有 boot 那一次。它是"无条件回收孤儿"语义（旧进程遗留的工作台全是垃圾），
    // 进了周期循环就会拿这个语义去砸本进程正在写的沙盒——in-flight 集合 + mtime 活性窗口
    // 任何一处判据失灵（gcOrphans 的 R6-9/R7-1 两次修复都在还这笔债）就是一场事故。
    expect(o.calls.gcStaging).toBe(1)
    db.close()
  })

  it('🔴 字幕工作台在飞行中时，它的 staging jobId 在 in-flight 集合里（空集合会 rm 掉正在跑的沙盒）', async () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:7', 'Show', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('/media/Show/E01.mkv', '/media/Show', 'E01.mkv', BIG, 1000, '/media/Show', 'tmdb:7', 1, 1, 1, 1000)

    let sawInFlight: string[] = []
    let daemon!: ScoutDaemonV2
    const subtitleWorker = vi.fn(async () => {
      // worker 跑到一半时，daemon 眼里的 in-flight 集合必须包含这个作品的 staging jobId——
      // gcOrphans 靠 jobId **目录名**判活（`<root>/.subtitle-staging/<jobId>/`），
      // 名字对不上就等于没保护。
      sawInFlight = [...(daemon as any).inFlightStagingJobIds as Set<string>]
      // 装盘成功一律返回空桶：只测在飞行期间的集合，不测回写
      return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
    })
    daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': ['/media/Show/E01.mkv'] }),
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: subtitleWorker as any,
      // 3-3 起阶段 3 消费快照前逐文件 stat（R12 / C23）：不注入会退化成默认 existsSync，
      // 而这个路径在真实磁盘上不存在 → 整簇被剔除 → worker 不被调、jobId 也不该被登记，
      // 于是本用例红在"worker 没被调用"而不是它想测的 in-flight 语义。
      fileExists: (p: string) => p === '/media/Show/E01.mkv',
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(subtitleWorker).toHaveBeenCalled()
    // 与 subtitleScheduler.buildSubtitleTask 实际用的 jobId 同源（不在测试里复述格式）
    expect(sawInFlight).toEqual([subtitleJobId('tmdb:7')])
    // 跑完必须摘掉，否则这个 jobId 会永久免疫 GC → 沙盒垃圾无界堆积
    expect([...((daemon as any).inFlightStagingJobIds as Set<string>)]).toEqual([])
    db.close()
  })

  it('字幕 worker 抛错也要把 in-flight 条目摘掉（finally 语义）', async () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:7', 'Show', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run('/media/Show/E01.mkv', '/media/Show', 'E01.mkv', BIG, 1000, '/media/Show', 'tmdb:7', 1, 1, 1, 1000)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': ['/media/Show/E01.mkv'] }),
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async () => { throw new Error('LLM 500') },
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect([...((daemon as any).inFlightStagingJobIds as Set<string>)]).toEqual([])
    db.close()
  })
})

describe('ScoutDaemonV2 · D4 时间闸（C22：一次故障不许吃掉 24h）', () => {
  /** 让巡检整轮抛错：注入的 statFile 是 scanOnce 里唯一没被 try/catch 包住的磁盘调用，
   *  形态也真实（FUSE 挂载上 stat 抖动）。 */
  const throwingScan = {
    listVideoFiles: () => ['/media/Show/E01.mkv'],
    statFile: () => { throw new Error('EIO: stat failed on FUSE mount') },
  }

  it('🔴 巡检抛错 → 时间闸不推进（否则挂载抖一下就睡满 24h，与 R8 优雅恢复正相反）', async () => {
    const db = openDb(':memory:')
    const seeded = NOW - 25 * 3600_000
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(seeded))
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...throwingScan }))
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBe(seeded)
    db.close()
  })

  it('🔴 巡检抛错后不许原地热重试（独立的短 failure backoff，与 24h 分账）', async () => {
    const db = openDb(':memory:')
    let clock = NOW
    let walks = 0
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      now: () => clock,
      inspectFailureBackoffMs: 30 * 60_000,
      listVideoFiles: () => { walks++; return ['/media/Show/E01.mkv'] },
      statFile: () => { throw new Error('EIO') },
    }))
    await oneLoop(daemon)
    expect(walks).toBe(1)
    clock += 60_000            // 1 分钟后：24h 闸开着（失败没推进），但退避没到
    await oneLoop(daemon)
    expect(walks).toBe(1)      // 不许再跑——否则每 5 分钟烧一整轮 LLM
    db.close()
  })

  it('🔴 失败退避到点后重试（证明不是永久停摆），成功一次即推进时间闸', async () => {
    const db = openDb(':memory:')
    let clock = NOW
    let broken = true
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      now: () => clock,
      inspectFailureBackoffMs: 30 * 60_000,
      // 必须返回一个文件：walk 返回空数组会被 R8 的"扫出 0 个媒体文件"整根跳过，
      // 于是 statFile 一次都不会被调、巡检**成功**返回——那样这条用例测的就不是它想测的东西。
      listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => { if (broken) throw new Error('EIO'); return { mtimeMs: 1000, size: BIG } },
    }))
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBeNull()
    broken = false                       // 用户 5 分钟就修好了挂载
    clock += 31 * 60_000
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBe(clock)
    db.close()
  })

  it('🔴 时间闸记的是巡检**开始**时刻，不是结束时刻（否则周期随耗时逐轮漂移）', async () => {
    const db = openDb(':memory:')
    let clock = NOW
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      now: () => clock,
      // 大库巡检真能跑 10 小时（115 FUSE 上几万文件）
      listVideoFiles: () => { clock += 10 * 3600_000; return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
    }))
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBe(NOW)
    db.close()
  })

  it('🔴 周期不漂移：上轮跑了 10h，距开始满 24h 就该再巡检（结束口径下这里会静默睡到 34h）', async () => {
    const db = openDb(':memory:')
    // 上一轮 NOW 开始、NOW+10h 结束
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW))
    let walks = 0
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      now: () => NOW + 24 * 3600_000 + 1,
      listVideoFiles: () => { walks++; return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
    }))
    await oneLoop(daemon)
    expect(walks).toBe(1)
    db.close()
  })

  it('巡检成功 → 时间闸正常推进（不许为了守住上面几条把推进整个删掉）', async () => {
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fakeFs({ '/media': [] }) }))
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBe(NOW)
    db.close()
  })
})

describe('ScoutDaemonV2 · 切换入口时同样不许丢的另外三样（与 4 器官同一类伤害）', () => {
  it('🔴 preTick 每圈最先跑：wizard 落库 → 同进程点火（否则配好密钥必须重启容器）', async () => {
    const db = openDb(':memory:')
    const order: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      preTick: async () => { order.push('preTick') },
      listVideoFiles: () => { order.push('scan'); return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      dbMaintenance: () => { order.push('maintenance') },
    }))
    await oneLoop(daemon)
    expect(order[0]).toBe('preTick')
    expect(order).toContain('scan')
    db.close()
  })

  it('preTick 抛错不拖垮本圈（同 DaemonDeps 的隔离口径）', async () => {
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [] }),
      preTick: async () => { throw new Error('secrets rebuild failed') },
    }))
    await oneLoop(daemon)
    expect(lastInspectAt(db)).toBe(NOW)
    db.close()
  })

  it('🔴 workPermitted=false → 不跑巡检（setup 模式零密钥不许空烧），但运维照跑', async () => {
    const db = openDb(':memory:')
    const o = mkOrgans()
    const walked: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      workPermitted: () => false,
      listVideoFiles: (r: string) => { walked.push(r); return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      ...o.deps,
    }))
    await oneLoop(daemon)
    expect(walked).toEqual([])
    expect(lastInspectAt(db)).toBeNull()          // 闸住时也不许推进时间闸
    expect(o.calls.dbMaintenance).toBeGreaterThanOrEqual(1)
    db.close()
  })

  it('🔴 守备目录惰性求值：dashboard 加根后下一轮巡检就该扫到（否则要重启容器）', async () => {
    const db = openDb(':memory:')
    let roots = ['/media/tv']
    const walked: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [],
      rootsProvider: () => roots,
      listVideoFiles: (r: string) => { walked.push(r); return [] },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(walked).toEqual(['/media/tv'])
    roots = ['/media/tv', '/media/movies']        // 用户在 dashboard 里加了一个根
    await (daemon as any).runInspection(new AbortController().signal)
    expect(walked).toEqual(['/media/tv', '/media/tv', '/media/movies'])
    db.close()
  })

  it('🔴 同一轮巡检内 roots 快照稳定（中途变动不许让删除作用域与扫描作用域对不上）', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/tv/Show/E01.mkv', '/media/115/Anime/E01.mkv'])
    let roots = ['/media/tv', '/media/115']
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [],
      rootsProvider: () => roots,
      listVideoFiles: (r: string) => {
        // 扫第一个根的过程中，用户把第二个根删了。若 deleteMissing 现读一份新快照，
        // /media/tv 的 deeperPrefixes 会变、/media/115 名下的行落进别人的差集被误删。
        roots = ['/media/tv']
        return r === '/media/tv' ? ['/media/tv/Show/E01.mkv'] : ['/media/115/Anime/E01.mkv']
      },
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(pathsInDb(db)).toEqual(['/media/115/Anime/E01.mkv', '/media/tv/Show/E01.mkv'])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 第 3 步前置迁移 2：embedded_langs 存量回填 pass（D17 加强版 / C38 + C43）
//
// 背景（为什么这个 pass 非有不可）：1b-3 已让扫描对**新增/指纹变化**的文件跑 probe 写
// embedded_langs。但存量行是在 probe 上线前入库的，这一列全是 NULL——而它是三样东西的共同
// 前提：subtitleJudge 规则 2（已有内嵌中文轨 → 跳过）、D9 的 translatable 判定（日漫有日文
// 内嵌轨时可翻译）、以及 C12 本身。存量行的指纹不会变，扫描那条路径**永远不会**探到它们
// （probeNewOrChanged 之前那行 `continue` 就走了），所以回填是它们唯一的通路。
//
// 第四轮审计发现"只写一个回填 pass"不够（这是本仓第三次栽在同一模式上：C12 → C35 → 本条）：
// 回填 embedded_langs **不会改 needs_subtitle**，而 judge 的谓词是 `needs_subtitle IS NULL`
// （judgeOnce）→ judge 永不再看存量行 → **回填等于白跑 ffprobe**，几万次 12s 的探测换来零行为
// 变化，且日志上一片"回填成功"。故三者缺一不可，下面每一条都各有一个用例钉住：
//   ① 回填内容：probe 写 embedded_langs + duration_sec
//   ② 同时置 NULL：needs_subtitle 与 translatable ← **重判通路**，缺了①就是白跑
//   ③ 执行位置：boot 一次性 pass，分批 200，失败记 last_error，不阻塞主巡检
// ─────────────────────────────────────────────────────────────────────────────

/** 造存量行：embedded_langs IS NULL（probe 上线前入库的形态），且**已经被 judge 判过**。
 *  needs_subtitle 必须是非 NULL 的既有判决——这正是重判通路要打通的那把锁。
 *  播种成 NULL 的话用例 6 会变成空转的假绿（断言"是 NULL"而它一开始就是 NULL）。 */
function seedLegacyFile(
  db: ReturnType<typeof openDb>,
  path: string,
  over: Partial<{ needs_subtitle: number | null; embedded_langs: string | null; translatable: number | null }> = {},
): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const have = new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map(c => c.name))
  const row: Record<string, unknown> = {
    path, dir, filename: path.slice(path.lastIndexOf('/') + 1), size: BIG, mtime: 1000,
    work_dir: dir, work_id: 'tmdb:42',
    needs_subtitle: over.needs_subtitle === undefined ? 1 : over.needs_subtitle,
    embedded_langs: over.embedded_langs === undefined ? null : over.embedded_langs,
    updated_at: 1000,
  }
  if (have.has('translatable')) row.translatable = over.translatable === undefined ? 0 : over.translatable
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO files (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map(c => row[c]))
}

/** 直接驱动回填 pass（绕开整轮 run()：boot 顺序另有专门用例钉）。 */
async function backfill(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).backfillEmbeddedLangs()
}

describe('ScoutDaemonV2 · D17 embedded_langs 存量回填 pass（C38 + C43）', () => {
  const P = '/media/Show/E01.mkv'

  it('🔴 存量 embedded_langs IS NULL 的行 → 回填后非 NULL（含 duration_sec）', async () => {
    const db = openDb(':memory:')
    seedLegacyFile(db, P)
    const fs = fakeFsWithProbe({}, {},
      async () => [{ lang: 'jpn', codec: 'subrip', isImageBased: false }], async () => 1423)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)

    expect(fs.probeCalls).toEqual([P])
    const s = stateOf(db, P)
    expect(JSON.parse(s.embedded_langs as string)).toEqual(['jpn'])
    expect(s.duration_sec).toBe(1423)
    db.close()
  })

  it('🔴🔴 回填后 needs_subtitle 被置 NULL —— 重判通路红线（C43 的核心）', async () => {
    const db = openDb(':memory:')
    // 原本这里有一条手工 `ALTER TABLE files ADD COLUMN translatable INTEGER` 预演未来 schema；
    // 3-2 真正加上该列（v35）后预演到期（裸 ALTER 撞 duplicate column），改为前置断言。
    expect(new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>)
      .map(c => c.name)).has('translatable')).toBe(true)
    seedLegacyFile(db, P, { needs_subtitle: 0, translatable: 0 })
    // 前置条件：这一行**已经被判过**（needs_subtitle=0），否则本用例是空转的假绿。
    expect(stateOf(db, P).needs_subtitle).toBe(0)
    expect(stateOf(db, P).translatable).toBe(0)

    const fs = fakeFsWithProbe({}, {},
      async () => [{ lang: 'jpn', codec: 'subrip', isImageBased: false }], async () => 1400)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)

    // 这两条是全套改动里唯一真正 load-bearing 的断言：
    //  · needs_subtitle 留着旧值 → judgeOnce 的谓词 `needs_subtitle IS NULL` 永不选中它 →
    //    刚探出来的 embedded_langs 一辈子没人读 → 几万次 ffprobe 白跑，行为零变化
    //  · translatable 留着旧值 → D9 的可救性判决是基于"没有 embedded_langs"算出来的，
    //    证据刚补上、判决却冻结着 → 一个有日文内嵌轨的日漫仍被当作不可救判死
    expect(stateOf(db, P).needs_subtitle).toBeNull()
    expect(stateOf(db, P).translatable).toBeNull()
    db.close()
  })

  it('🔴 重判通路真的通了：回填后 judgeOnce 能重新判到这一行（端到端，不只断言列值）', async () => {
    // 为什么要有这条而不是只有上面那条：上面断言的是"列被置 NULL"，那是**手段**；
    // 真正的承诺是"judge 会再看一眼这一行"。前六轮子代理踩过的假绿正是这类——
    // 声称守某条通路、实际只钉了通路上的一个中间变量。故这里把真实的 judgeOnce 接上跑。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES (?,?,?,?,?,?)`).run('tmdb:42', 'Anime', 'tv', 'ja', 1000, 1000)
    // 存量行的旧判决：judge 在没有 embedded_langs 的年代判了"需要中文字幕"。
    seedLegacyFile(db, P, { needs_subtitle: 1 })
    // 探针揭示的真相：容器里本来就有一条中文内嵌轨 → 规则 2 应当判 needs=0，本不该找字幕。
    const fs = fakeFsWithProbe({}, {},
      async () => [{ lang: 'chi', codec: 'subrip', isImageBased: false }], async () => 1400)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)
    await (daemon as any).judgeOnce()

    // 判决被真实修正 = 回填不是白跑。缺了"置 NULL"那一步，这里会停在 1（judge 没看它），
    // 系统继续为一个自带中文内嵌轨的片子每天烧一轮付费 LLM 找字幕。
    expect(stateOf(db, P).needs_subtitle).toBe(0)
    db.close()
  })

  it('🔴 已有 embedded_langs 的行不被重复 probe（性能红线：115 是 rclone FUSE，12-16s/文件）', async () => {
    const db = openDb(':memory:')
    seedLegacyFile(db, '/media/Show/done.mkv', { embedded_langs: '["eng"]' })
    seedLegacyFile(db, '/media/Show/empty.mkv', { embedded_langs: '[]' })   // "探过、确认零轨"
    seedLegacyFile(db, '/media/Show/todo.mkv')                              // 真正的存量行
    const fs = fakeFsWithProbe({}, {})
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)
    await backfill(daemon)   // 跑两遍：自然收敛也一起钉住（见下一条的论证）

    // '[]' 必须与 NULL 区分对待：把"确认零轨"当成"没探过"就是每次启动重探全库，
    // 在 115 上永不收敛（streamProbe.ts 的三态契约，C12 的既有裁决）。
    expect(fs.probeCalls).toEqual(['/media/Show/todo.mkv'])
    db.close()
  })

  it('🔴 全部回填完后再启动 → 一次 probe 都不发（靠 `embedded_langs IS NULL` 谓词自然收敛）', async () => {
    const db = openDb(':memory:')
    seedLegacyFile(db, P)
    const fs = fakeFsWithProbe({}, {}, async () => [], async () => 900)   // 返回 [] 而非 null
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)
    expect(fs.probeCalls).toEqual([P])
    // 第二次启动（新进程同一个库）：谓词已选不中它 → 零 probe。
    // 这条与上一条不同：上面验的是"别人的行不碰"，这里验的是"自己刚回填的行不再碰"——
    // 探针返回 [] 时若实现把它写成 NULL，收敛就失效，而列值断言看不出来（NULL 本来也是 NULL）。
    const daemon2 = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon2)
    expect(fs.probeCalls).toEqual([P])   // 仍是 1 次，没有第 2 次
    db.close()
  })

  it('🔴 分批：250 行存量，一轮只处理 200（每批上限，FUSE 挂载上的硬要求）', async () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 250; i++) seedLegacyFile(db, `/media/Show/E${String(i).padStart(3, '0')}.mkv`)
    const fs = fakeFsWithProbe({}, {})
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)
    // 用调用次数断言而不是"还有多少行是 NULL"：后者在"实现一次探完 250 行但只写回 200 行"
    // 这种形态下同样为真，而真实成本（250 × 12s 的 FUSE IO）一分不少。
    expect(fs.probeCalls.length).toBe(200)
    // 剩下的 50 行留在 NULL，下次启动继续（不丢活）。
    const left = db.prepare('SELECT COUNT(*) AS n FROM files WHERE embedded_langs IS NULL').get() as { n: number }
    expect(left.n).toBe(50)
    db.close()
  })

  it('🔴 probe 失败的行 → 记 last_error，不阻塞其他行，整轮不炸', async () => {
    const db = openDb(':memory:')
    const bad = '/media/Show/BROKEN.mkv'
    const good = '/media/Show/OK.mkv'
    seedLegacyFile(db, bad)
    seedLegacyFile(db, good)
    const fs = fakeFsWithProbe({}, {},
      async (p) => { if (p === bad) throw new Error('ffprobe timeout'); return [{ lang: 'eng', codec: 'subrip', isImageBased: false }] },
      async (p) => { if (p === bad) throw new Error('ffprobe timeout'); return 1200 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await expect(backfill(daemon)).resolves.toBeUndefined()

    // 失败行：留 NULL（下轮重探的唯一凭据）+ 记 last_error（留待下轮，且让运维能分辨
    // "这片子真没内嵌轨"与"这台机器的 ffprobe 坏了"）。
    expect(stateOf(db, bad).embedded_langs).toBeNull()
    const err = db.prepare('SELECT last_error FROM files WHERE path = ?').get(bad) as { last_error: string | null }
    expect(err.last_error).not.toBeNull()
    // 兄弟行照常完成——一个损坏文件不许让整批 200 行的回填白跑。
    expect(JSON.parse(stateOf(db, good).embedded_langs as string)).toEqual(['eng'])
    expect(stateOf(db, good).duration_sec).toBe(1200)
    db.close()
  })

  it('🔴 last_error 不许写死识别轨的终态值（否则回填会把文件踢出识别队列）', async () => {
    // last_error 是**共用列**：identifyScheduler 的队列谓词是
    // `last_error IS NULL OR last_error != 'tmdb-404'`。回填若往这一列写 'tmdb-404'，
    // 一次 ffprobe 超时就把文件永久踢出识别队列——跨轨串味的静默灾难。
    const db = openDb(':memory:')
    const bad = '/media/Show/BROKEN.mkv'
    seedLegacyFile(db, bad)
    const fs = fakeFsWithProbe({}, {}, async () => { throw new Error('boom') }, async () => { throw new Error('boom') })
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)
    const err = db.prepare('SELECT last_error FROM files WHERE path = ?').get(bad) as { last_error: string | null }
    expect(err.last_error).not.toBe('tmdb-404')
    db.close()
  })

  // 上一条守的是"回填**写**这列时不许串味"。这一条守反方向：回填**成功清**这列时
  // 同样不许跨轨——`tmdb-404` 是识别轨的终态凭据（identifyScheduler 靠它把 404 目录
  // 永久排除），被字幕轨的一次 probe 成功洗掉，那个目录就重进识别队列白烧一次 TMDB。
  // 两条轨共用一列，各自只许销自己的账。
  it('🔴 回填成功只清自己写的 probe: 失败叙事，不碰识别轨的 tmdb-404', async () => {
    const db = openDb(':memory:')
    const own = '/media/Show/own.mkv'      // 自己上轮 probe 失败留下的
    const other = '/media/Show/other.mkv'  // 识别轨写的终态
    seedLegacyFile(db, own)
    seedLegacyFile(db, other)
    db.prepare("UPDATE files SET last_error = 'probe: boom' WHERE path = ?").run(own)
    db.prepare("UPDATE files SET last_error = 'tmdb-404' WHERE path = ?").run(other)

    const fs = fakeFsWithProbe({}, {},
      async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
      async () => 1200)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await backfill(daemon)

    const read = (p: string) => (db.prepare('SELECT last_error FROM files WHERE path = ?')
      .get(p) as { last_error: string | null }).last_error
    expect(read(own)).toBeNull()          // 自己的账，销掉
    expect(read(other)).toBe('tmdb-404')  // 别人的账，原样留着
    db.close()
  })

  it('🔴 translatable 列不存在时（3-2 之前的 schema）→ 回填照常进行，不抛错', async () => {
    const db = openDb(':memory:')
    // 原本这条靠"今天的 schema 里本来就没有 translatable"来构造前提。3-2 加上该列（v35）后
    // 那个前提消失了，但**要守的行为没有消失**：回填 pass 按 PRAGMA 取交集拼列，是为了让它
    // 在"列还没加"的库上不抛 `no such column` 而炸掉 boot。生产上这个形态真实存在——
    // 容器滚更时新代码可能先于迁移跑起来（或用户从旧备份恢复出一个 v34 之前的库）。
    // 故用 DROP COLUMN **主动造回**旧 schema，而不是把用例删掉：删掉就等于把"动态拼列"
    // 这个设计的唯一守卫者拿走，日后谁把它改回硬编码 SQL 都不会红。
    db.exec('ALTER TABLE files DROP COLUMN translatable')
    const cols = new Set((db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map(c => c.name))
    expect(cols.has('translatable')).toBe(false)   // 前置条件成立，否则本用例无意义
    seedLegacyFile(db, P, { needs_subtitle: 1 })
    const fs = fakeFsWithProbe({}, {}, async () => [{ lang: 'jpn', codec: 'subrip', isImageBased: false }], async () => 1400)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...fs.deps }))
    await expect(backfill(daemon)).resolves.toBeUndefined()

    expect(JSON.parse(stateOf(db, P).embedded_langs as string)).toEqual(['jpn'])
    expect(stateOf(db, P).needs_subtitle).toBeNull()   // 重判通路照样打通
    db.close()
  })

  it('🔴 探针未注入 → 回填整支休眠，一列不动（不许把 needs_subtitle 白清一遍）', async () => {
    // 反向灾难：若实现先无条件置 NULL 再探测，探针缺注入时就会把全库判决清空却没有任何新证据
    // → 下一轮 judge 拿着同一批 NULL 的 embedded_langs 重判一遍，纯白烧，且每次启动重复一次。
    const db = openDb(':memory:')
    seedLegacyFile(db, P, { needs_subtitle: 1 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { probe: undefined, probeDuration: undefined }))
    await expect(backfill(daemon)).resolves.toBeUndefined()
    expect(stateOf(db, P).needs_subtitle).toBe(1)
    db.close()
  })

  it('🔴 boot 时被调用，且**不阻塞主巡检**（失败也照样进巡检）', async () => {
    const db = openDb(':memory:')
    seedLegacyFile(db, P)
    const identifySpy = vi.fn(async () => ({ tmdbId: null, title: null, reason: 'noop' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [],
      // 回填整支抛错（不是单文件失败，是 pass 级别的爆炸，比如库被锁）。
      probe: async () => { throw new Error('probe exploded') },
      probeDuration: async () => { throw new Error('probe exploded') },
      identify: { db, runIdentify: identifySpy, worker: {} as any },
      listVideoFiles: () => [],
    }))
    await oneLoop(daemon)
    // 巡检照常发生（meta 被写）= 回填不是主巡检的前置条件。回填是增益，它挂了
    // 顶多是存量行晚一天重判；把它做成阻塞项就是"一个 ffprobe 故障停掉整条流水线"。
    expect(lastInspectAt(db)).not.toBeNull()
    db.close()
  })

  it('🔴 回填与 1b-3 的 probeNewOrChanged 不重复探同一批文件（boot 先跑，扫描后跑）', async () => {
    // 两个 pass 靠"这一行当前有没有 embedded_langs"天然分区：
    //  · 新增文件 boot 时还没有 files 行 → 回填的谓词看不见它 → 只被扫描探
    //  · 指纹变化的行 boot 时 embedded_langs 还是**旧的非 NULL 值** → 回填跳过 → 只被扫描探
    //  · 存量行指纹不变 → 扫描那条路径的 `continue` 提前走掉 → 只被回填探
    // 若把回填挪到扫描之后（同一轮内），第三类之外还会多探一批：刚被 upsert 清成 NULL、
    // 探针又恰好失败的行会在同一轮里被立刻重探一次，FUSE 上的成本直接翻倍。
    const db = openDb(':memory:')
    const legacy = '/media/Show/legacy.mkv'
    const fresh = '/media/Show/fresh.mkv'
    seedLegacyFile(db, legacy)                       // 存量行，磁盘上也在（指纹不变）
    const fs = fakeFsWithProbe({ '/media': [legacy, fresh] }, {
      [legacy]: { mtimeMs: 1000, size: BIG },        // 与播种值一致 → 指纹未变
      [fresh]: { mtimeMs: 2000, size: BIG },
    })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await backfill(daemon)
    await scan(daemon)
    // 每个文件恰好被探一次：legacy 归回填，fresh 归扫描。任何一方多探一次这里就红。
    expect(fs.probeCalls.filter(p => p === legacy).length).toBe(1)
    expect(fs.probeCalls.filter(p => p === fresh).length).toBe(1)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C21：works.provider_ids 存量回填 pass。
//
// 为什么必须有一条**独立于识别队列**的回填通路（这是 C21 的全部内容）：识别成功后
// `files.work_id` 非 NULL，而 identifyScheduler 的队列谓词是 `work_id IS NULL`
// → 那个作品目录**永不再进识别队列**。于是"识别时顺手采 imdb"这条改动只覆盖**今后**新识别的
// 作品；CURRENT-STATE 记录的 83 个已识别作品的 provider_ids 会永远是 NULL，
// 翻译抓源腿对它们退化成纯文本 query（假阴性多），而第 6 步的 e2e 恰好就在这批存量上跑
// → 会在退化状态下量出一个偏低的命中率，并被当成"真实命中率"。
//
// 这是本仓栽过四次的同型缺陷（C12 → C35 → D17 → D18：写了某列却没定谁来写/谁来重读）。
// 手法照 3-1 已落地的 embedded_langs 回填 pass：boot 一次性 pass、分批、失败不阻塞、
// 靠 `IS NULL` 谓词自然收敛。
//
// 与 embedded_langs 那个 pass 的一处关键差别：**这里没有"重判通路"要打通**。
// embedded_langs 回填必须额外置 `needs_subtitle=NULL`/`translatable=NULL`（D17/C43），
// 因为那两列是**据旧证据做出的判决**，证据换了判决必须重来。provider_ids 不是判决的输入，
// 它只是搜索时的一个可选增益参数 —— 补上之后下一次抓源自然就带上了，无需推动任何状态机。
// 这个差别是**论证过的**，不是遗漏：若日后 provider_ids 变成 judge 的判据（例如"有 imdb
// 才算可抓源"），这条论证即失效，那时必须同步加重判通路。
// ─────────────────────────────────────────────────────────────────────────────
async function backfillIds(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).backfillProviderIds()
}

function providerIdsOf(db: ReturnType<typeof openDb>, id: string): string | null {
  return (db.prepare('SELECT provider_ids FROM works WHERE id = ?').get(id) as { provider_ids: string | null }).provider_ids
}

function seedWork(db: ReturnType<typeof openDb>, id: string, over: {
  mediaType?: 'tv' | 'movie'; providerIds?: string | null
} = {}) {
  db.prepare(`INSERT INTO works (id, title, media_type, provider_ids, created_at, updated_at)
              VALUES (?,?,?,?,?,?)`)
    .run(id, `Work ${id}`, over.mediaType ?? 'tv', over.providerIds ?? null, 1000, 1000)
}

/** 只注入 getExternalIds 的最小 identify deps（回填只用得到它一个方法）。 */
function idDeps(db: ReturnType<typeof openDb>, impl?: (mt: 'tv' | 'movie', id: string) => Promise<{ imdbId: string | null }>) {
  const calls: Array<[string, string]> = []
  return {
    calls,
    deps: {
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: {
          model: {} as any,
          tmdb: {
            search: async () => [],
            getDetails: async () => null,
            getExternalIds: impl
              ? async (mt: 'tv' | 'movie', id: string) => { calls.push([mt, id]); return impl(mt, id) }
              : async (mt: 'tv' | 'movie', id: string) => { calls.push([mt, id]); return { imdbId: `tt${id}` } },
          } as any,
        },
      },
    },
  }
}

describe('ScoutDaemonV2 · C21 works.provider_ids 存量回填 pass', () => {
  it('🔴🔴 用例 7：provider_ids IS NULL 的存量行被补上（C21 红线）', async () => {
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83')
    // 前置条件：这一行确实是 NULL，否则本用例空转（假绿的最常见形态）
    expect(providerIdsOf(db, 'tmdb:83')).toBeNull()
    const ids = idDeps(db, async () => ({ imdbId: 'tt14827638' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)

    // 断言解析后的内容而不是"非 NULL"：写进去一个 '{}' 同样满足"非 NULL"，
    // 而抓源腿拿到的 imdb 仍是 undefined —— 列有值、功能照旧退化，最难查的那种假绿。
    expect(JSON.parse(providerIdsOf(db, 'tmdb:83')!)).toEqual({ tmdb: '83', imdb: 'tt14827638' })
    // mediaType 从 works.media_type 取（tv/movie 是两个不同的 TMDB 端点，猜错就是 404）
    expect(ids.calls).toEqual([['tv', '83']])
    db.close()
  })

  it('🔴 用例 7b：真正到达 fetchSourceSub 的抓源腿（端到端，不只断言列值）', async () => {
    // 为什么要有这条而不是只有上面那条：上面断言的是"列被写上"，那是**手段**；
    // 真正的承诺是"抓源搜索会带上 imdb"。3-1 的子代理在 embedded_langs 那个 pass 上
    // 被要求补过同型的端到端用例（"声称守某条通路、实际只钉了通路上的一个中间变量"）。
    // 故这里把真实的 makeDbLocate 接上，验回填的产出真能被消费方读出来。
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83', { mediaType: 'tv' })
    db.prepare(`UPDATE works SET origin_lang = 'en' WHERE id = 'tmdb:83'`).run()
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, work_id, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run('/media/TV/S01E01.mkv', '/media/TV', 'S01E01.mkv', 100, 1000, '/media/TV', 1, 1, 'tmdb:83', 1000)
    // 回填前：抓源腿拿不到 imdb（这就是 C21 描述的退化状态）
    expect(makeDbLocate(db)('/media/TV/S01E01.mkv')?.imdb).toBeUndefined()

    const ids = idDeps(db, async () => ({ imdbId: 'tt14827638' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)

    // 回填后：同一个消费方、同一条 path，imdb 出现了
    expect(makeDbLocate(db)('/media/TV/S01E01.mkv')?.imdb).toBe('tt14827638')
    db.close()
  })

  it('🔴 用例 8a：分批——250 行存量，一轮只处理 200（每批上限）', async () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 250; i++) seedWork(db, `tmdb:${i}`)
    const ids = idDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)
    // 用**调用次数**断言而不是"还有多少行是 NULL"：后者在"一次拉完 250 行但只写回 200 行"
    // 这种形态下同样为真，而真实成本（250 次 TMDB 往返、配额敏感）一分不少。
    expect(ids.calls.length).toBe(200)
    const left = db.prepare('SELECT COUNT(*) AS n FROM works WHERE provider_ids IS NULL').get() as { n: number }
    expect(left.n).toBe(50)   // 剩下的下次启动继续，不丢活
    db.close()
  })

  it('🔴 用例 8b：单个 work 失败 → 留 NULL 待下轮，兄弟行照常完成，整轮不炸', async () => {
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:bad')
    seedWork(db, 'tmdb:good')
    const ids = idDeps(db, async (_mt, id) => {
      if (id === 'bad') throw new Error('TMDB 503')
      return { imdbId: 'tt999' }
    })
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await expect(backfillIds(daemon)).resolves.toBeUndefined()

    // 失败行留 NULL —— 这是下轮重试的唯一凭据。写成 '{}' 就永久放弃这一行。
    expect(providerIdsOf(db, 'tmdb:bad')).toBeNull()
    expect(JSON.parse(providerIdsOf(db, 'tmdb:good')!).imdb).toBe('tt999')
    db.close()
  })

  it('🔴 用例 8c：pass 级爆炸不阻塞主巡检（boot 调用点被 try/catch 隔离）', async () => {
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [],
      listVideoFiles: () => [],
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        // 不是单个 work 失败，是 pass 级别的爆炸（deps 结构本身坏了）
        worker: { model: {} as any, tmdb: { get getExternalIds(): never { throw new Error('deps exploded') } } as any },
      },
    }))
    await oneLoop(daemon)
    // 巡检照常发生 = 回填不是主巡检的前置条件。回填是增益，它挂了顶多是抓源腿多退化一天；
    // 做成阻塞项就是"一次 TMDB 故障停掉整条流水线"。
    expect(lastInspectAt(db)).not.toBeNull()
    db.close()
  })

  it('🔴 用例 9：回填完成后不再触发（靠 `provider_ids IS NULL` 谓词自然收敛）', async () => {
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83')
    seedWork(db, 'tmdb:84', { providerIds: '{"tmdb":"84","imdb":"tt1"}' })   // 已有值，不该被碰
    const ids = idDeps(db, async () => ({ imdbId: 'tt14827638' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)
    expect(ids.calls).toEqual([['tv', '83']])
    // 第二次启动（新进程同一个库）：谓词已选不中它 → 零 TMDB 调用。
    const daemon2 = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon2)
    expect(ids.calls).toEqual([['tv', '83']])   // 仍是 1 次，没有第 2 次
    db.close()
  })

  it('🔴 用例 9b：TMDB 确认无 imdb（imdbId=null）→ 也写非 NULL，否则永不收敛', async () => {
    // 这条与用例 9 不同：那条验的是"成功采到的行不再碰"，这里验"查过但确实没有"的行。
    // 若实现只在 imdbId 非空时才写，这批作品每次 boot 都会重查一遍 —— 永不收敛，
    // 而列值断言看不出来（NULL 本来也是 NULL），正是 3-1 那个 pass 上同型的坑。
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83')
    const ids = idDeps(db, async () => ({ imdbId: null }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)
    expect(JSON.parse(providerIdsOf(db, 'tmdb:83')!)).toEqual({ tmdb: '83' })
    const daemon2 = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon2)
    expect(ids.calls.length).toBe(1)
    db.close()
  })

  it('🔴 getExternalIds 未注入 → 整支休眠，一行不动（不许把 works 写成 {} 假收敛）', async () => {
    // 反向灾难：若实现在探针缺席时也照写（比如 `{tmdb:id}`），一次"忘接线的启动"就把全库
    // 83 个作品标成"查过、没有 imdb"，而其实一次 TMDB 都没打 —— 抓源腿永久退化且再无人重试。
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any },
      },
    }))
    await expect(backfillIds(daemon)).resolves.toBeUndefined()
    expect(providerIdsOf(db, 'tmdb:83')).toBeNull()
    db.close()
  })

  it('🔴 老库无 works 表 / 无该列 → 回填静默跳过，不抛（照 backfillEmbeddedLangs 口径）', async () => {
    // 容器滚更时新代码可能先于迁移跑起来；用户也可能从 v30 之前的备份恢复。
    const noTable = openDb(':memory:')
    noTable.exec('DROP TABLE works')
    const d1 = new ScoutDaemonV2(mkDeps(noTable, { ...idDeps(noTable).deps }))
    await expect(backfillIds(d1)).resolves.toBeUndefined()
    noTable.close()

    const noCol = openDb(':memory:')
    noCol.exec('ALTER TABLE works DROP COLUMN provider_ids')
    seedWorkNoIds(noCol, 'tmdb:83')
    const d2 = new ScoutDaemonV2(mkDeps(noCol, { ...idDeps(noCol).deps }))
    await expect(backfillIds(d2)).resolves.toBeUndefined()
    noCol.close()
  })

  it('🔴 media_type=movie 的作品走 movie 端点（tv/movie 是两个不同 TMDB 端点，猜错就 404）', async () => {
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:9', { mediaType: 'movie' })
    const ids = idDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)
    expect(ids.calls).toEqual([['movie', '9']])
    db.close()
  })

  it('🔴 非 tmdb: 形状的 id 被跳过（不拿一个解析不出 TMDB id 的串去打端点）', async () => {
    // works.id 的形状由 ownIds.ts 收口成 'tmdb:<id>'，但库里历史上存在过合成 id
    // （ownIds.tmdbIdFromOwnId 的注释点名 'self-scan-trigger' 这类）。拿它去打
    // `/tv/self-scan-trigger/external_ids` 是保证 404 的白烧，且会把这一行写成
    // "查过没有"从而永久放弃它 —— 真正该做的是留 NULL 等人修数据。
    const db = openDb(':memory:')
    seedWork(db, 'weird-legacy-id')
    const ids = idDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...ids.deps }))
    await backfillIds(daemon)
    expect(ids.calls).toEqual([])
    expect(providerIdsOf(db, 'weird-legacy-id')).toBeNull()
    db.close()
  })

  it('🔴 boot 时被真实调用（不是"写了个方法没人叫"——本仓四次同型缺陷的形状）', async () => {
    const db = openDb(':memory:')
    seedWork(db, 'tmdb:83')
    const ids = idDeps(db, async () => ({ imdbId: 'tt777' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [], listVideoFiles: () => [], ...ids.deps,
    }))
    await oneLoop(daemon)
    // 走的是完整 run()，没有任何测试专用的直接调用 —— 这条是 C21 真正的验收点：
    // 前面所有用例都可以在"方法存在但 boot 里没人调"的情况下全绿。
    expect(ids.calls).toEqual([['tv', '83']])
    expect(JSON.parse(providerIdsOf(db, 'tmdb:83')!).imdb).toBe('tt777')
    db.close()
  })
})

/** 无 provider_ids 列的旧 schema 下播种（上面那个 seedWork 会撞 no such column）。 */
function seedWorkNoIds(db: ReturnType<typeof openDb>, id: string) {
  db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(id, `Work ${id}`, 'tv', 1000, 1000)
}

// ─────────────────────────────────────────────────────────────────────────────
// judgeOnce 写 translatable（R21 + D9 / 缺口 C24·C31·C40）。
//
// 为什么这一组必须走**真实的 judgeOnce** 而不是只测 judgeTranslatable 纯函数：
// C12/C35/D17 三次同型血案的共同形状是"写了某列却没定谁来写/谁来读"——纯函数全绿、
// 而生产上那一列永远是 NULL。translatable 的**唯一写入者**就是这里，
// 少了这组用例，judgeTranslatable 可以完美无缺地存在而 files.translatable 一辈子不被写。
// ─────────────────────────────────────────────────────────────────────────────
function translatableOf(db: ReturnType<typeof openDb>, path: string): number | null {
  return (db.prepare('SELECT translatable FROM files WHERE path = ?').get(path) as { translatable: number | null }).translatable
}

describe('ScoutDaemonV2.judgeOnce · translatable 预判写入（R21/D9）', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴 origin=en → translatable=1（用例 11 的端到端版）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en' })
    expect(translatableOf(db, V)).toBeNull()   // 前置条件：还没判过，否则用例是空转的假绿
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(translatableOf(db, V)).toBe(1)
    db.close()
  })

  it('🔴🔴 origin=ja 且有日文内嵌轨 → translatable=1（用例 12 / D9 防误判死日漫）', async () => {
    // 这条是整组里最 load-bearing 的一条：只看 origin_lang 的实现会在这里写 0，
    // 于是满 7 次后走 unsolvable → 一批 BD 压制的日漫（普遍带日文内嵌轨）永久停牌，
    // 而它们其实一抽轨就能救（纯本地操作，完全符合 R13 单跳）。
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(translatableOf(db, V)).toBe(1)
    db.close()
  })

  it('🔴 origin=ko 且探过、确认零内嵌轨 → translatable=0（用例 13）', async () => {
    const db = openDb(':memory:')
    // embedded_langs='[]' 是"探过、确认零轨"，与 NULL（没探过）是两回事——
    // streamProbe 的三态契约，消费方不许折叠。
    seedJudgeable(db, V, { originLang: 'ko', embeddedLangs: '[]' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(translatableOf(db, V)).toBe(0)
    db.close()
  })

  it('🔴 origin=ja 但 embedded_langs 还是 NULL（没探过）→ translatable 保持 NULL（C40 不判死）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'ja', embeddedLangs: null })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    // 判据不全就该留 NULL 等 D17 回填。写 0 = 拿"信息缺失"当"结论"，
    // 满 7 次时被当不可救直接 unsolvable，永久判死一部可能有日文轨的日漫。
    expect(translatableOf(db, V)).toBeNull()
    // 但 needs_subtitle 该判的照判——两列是独立事实，translatable 判不了不影响找字幕。
    expect(needsSubtitleOf(db, V)).toBe(1)
    db.close()
  })

  it('🔴 needs_subtitle 与 translatable 在**同一条 UPDATE** 里写（掉电不留半判决行）', async () => {
    // 分两条语句的话，进程在两条之间被杀（软路由掉电是本项目常态，见 db.ts 的
    // synchronous=FULL 论证）会留下 needs_subtitle 已判、translatable 还是 NULL 的行。
    // 而 judge 谓词是 `needs_subtitle IS NULL` → 这一行永不重判 → translatable 永久冻结在
    // NULL。C40 说 NULL 不判死（所以不会立刻出事），但它会**永远**停在"暂不可判"，
    // 满 7 次时既不移交翻译也不停牌，在字幕流里无限期打转 —— D17 同型的第五次。
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'en' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    const row = db.prepare('SELECT needs_subtitle, translatable FROM files WHERE path = ?').get(V) as any
    expect(row.needs_subtitle).toBe(1)
    expect(row.translatable).toBe(1)
    db.close()
  })

  it('🔴 国产片（origin=zh）→ needs_subtitle=0，translatable 不必纠结但必须被写过一次', async () => {
    // 边界：needs_subtitle=0 的行永远进不了字幕工作台，故它的 translatable 是什么都无所谓。
    // 但**不能因此跳过写入**——若实现写成"needs=0 就 continue"，将来 judge 谓词一变
    // （比如换片源把 needs 清成 NULL 重判）就会留下一批 translatable 语义不明的行。
    // 这里只钉"judge 跑过之后这一行不再处于未判状态"，不对具体值下断言。
    const db = openDb(':memory:')
    seedJudgeable(db, V, { originLang: 'zh' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(needsSubtitleOf(db, V)).toBe(0)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🔴🔴🔴 C27 永久卡死态的端到端红线（本 task 最重要的一条）。
//
// 生产上正在发生的数据损坏（用户实测复现：listSubtitleQueue 捞到 0 个作品）：
//   ① 字幕装盘成功 → 旧 markCovered 写 `needs_subtitle=0` + `sub_status='covered'`
//   ② 下一轮扫描发现字幕其实没落地（worker 声称成功但文件没写成）或用户手删 →
//      R24 让扫描把 sub_status 回退 NULL（1b-4 已实现）
//   ③ 但 `needs_subtitle=0` 留着 → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判）、
//      又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）
//   ④ → 这一集**再也不会被补字幕**，而界面上什么异常都看不出来。
//
// 为什么这一组必须**端到端串三个真实组件**（runSubtitleWorkDir → observeSubtitle →
// listSubtitleQueue），而不是分别断言各自的列：
// 卡死是**谓词组合**造成的，不是任何单个组件的行为错误。三个组件各自单测都能全绿——
// 装盘写了两列（"符合当时的设计"）、扫描回退了 sub_status（"正确"）、队列按谓词取件（"正确"）——
// 而合起来那一行永久消失。前七轮子代理反复踩到的假绿正是这一类：声称守某条通路、
// 实际只钉了通路上的一个中间变量。故这里用真实函数跑完整循环，断言"这一行回到了工作台"。
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 C27 端到端：装盘 → 字幕没落地/被手删 → 该行必须重回字幕工作台', () => {
  const V = '/media/Show/E01.mkv'
  const SUB = '/media/Show/E01.zh-Hans.srt'

  /** 造一行"已识别、已判需字幕、指纹与磁盘一致"的行 + 对应的 works。 */
  function seed(db: ReturnType<typeof openDb>): void {
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES (?,?,?,?,?,?)`).run('tmdb:42', 'Show', 'tv', 'en', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                   season, episode, needs_subtitle, sub_status, sub_recheck_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(V, '/media/Show', 'E01.mkv', BIG, 1000, '/media/Show', 'tmdb:42',
        1, 1, 1, null, NOW - 1, 1000)
  }

  /** 🔴 时钟口径：`runSubtitleWorkDir` 里的退避回写用的是**真实** `Date.now()`
   *  （它没有 now 注入点），而 daemon 侧用的是注入的假 NOW(1e12)——后者比真实时间**早约
   *  9100 天**。于是装盘写下的 recheck_after ≈ 真实now+1天，用假时钟去查队列永远落在退避
   *  窗口内，"这一行回到了工作台"这件事就永远看不见（本组用例第一版正是这么红的）。
   *
   *  故取件断言一律走真实时钟 + 一个足够跨过退避的余量。**不改成"把余量调到假时钟上"**：
   *  那样断言会依赖两个时钟的差值恰好是今天这个数，明年跑就变味了。
   *  扫描侧继续用假 NOW（它的 sub_recheck_at 逻辑全建立在 NOW 上），两边各用各的口径，
   *  唯一的耦合点就是这里的取件时刻——显式写出来而不是让它藏在数字里。 */
  const queueNow = () => Date.now() + 2 * DAY
  const queuePaths = (db: ReturnType<typeof openDb>, at: number) =>
    listSubtitleQueue(db, ['/media'], at).flatMap(q => q.files.map(f => f.path))

  it('🔴🔴 worker 声称装盘成功但字幕没落地 → 下一轮扫描后该行重回工作台（不是永久卡死）', async () => {
    const db = openDb(':memory:')
    seed(db)
    expect(queuePaths(db, NOW)).toContain(V)   // 前置：它本来在工作台里（尚无 recheck_after）

    // ── 第 1 轮：字幕流跑完，worker 报 installed（但磁盘上其实没有这个文件）──
    const item = listSubtitleQueue(db, ['/media'], NOW)[0]
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item, 'zh')

    // 装盘后当轮出队（D6 的 recheck_after 出队凭据 / 防 C26 热循环）。
    // 用**真实时钟的当下**查（不加余量）：此刻退避未过，理应取不到。
    expect(queuePaths(db, Date.now())).not.toContain(V)

    // ── 第 2 轮（次日）：扫描观察字幕存在性。磁盘上**没有**那个字幕文件 ──
    const sub = fakeSubtitleDisk([])   // 空磁盘：worker 声称成功但文件没写成
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], fileExists: sub.fileExists,
      ...fakeFs({ '/media': [V] }),
      now: () => NOW + DAY,
    }))
    await scan(daemon)

    // 🔴 这是全套改动里最 load-bearing 的一条断言：
    // 旧实现下 needs_subtitle 被装盘写成了 0 → 这一行永久消失，此处必然失败。
    expect(subStatusOf(db, V)).toBeNull()
    expect(needsSubtitleOf(db, V)).toBe(1)     // 语言事实没变，它仍然"原则上需要中文字幕"
    expect(queuePaths(db, queueNow())).toContain(V)
    db.close()
  })

  it('🔴🔴 用户嫌翻译质量差手删字幕 → 该行重回工作台（C19 的原始剧本）', async () => {
    const db = openDb(':memory:')
    seed(db)

    // 第 1 轮：装盘成功，且字幕**真的**落到磁盘上了
    const disk = fakeSubtitleDisk([SUB])
    const item = listSubtitleQueue(db, ['/media'], NOW)[0]
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item, 'zh')

    // 第 2 轮扫描：字幕在 → 扫描（唯一有权写 covered 的人 / R24）确认覆盖
    const d1 = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], fileExists: disk.fileExists, ...fakeFs({ '/media': [V] }), now: () => NOW + DAY,
    }))
    await scan(d1)
    expect(subStatusOf(db, V)).toBe('covered')
    expect(queuePaths(db, queueNow())).not.toContain(V)   // covered 的不该白烧付费 LLM

    // ── 用户手动删掉字幕（视频 mtime/size 不变 → 进不了 A 档，只能靠 B 档轮到）──
    disk.remove(SUB)
    const d2 = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], fileExists: disk.fileExists, ...fakeFs({ '/media': [V] }),
      now: () => NOW + 9 * DAY,   // 越过 sub_recheck_at 的 7 天，B 档轮到它
    }))
    await scan(d2)

    expect(subStatusOf(db, V)).toBeNull()      // 扫描回退（R24）
    expect(needsSubtitleOf(db, V)).toBe(1)     // 🔴 旧实现这里是 0 → 永久卡死
    expect(queuePaths(db, queueNow())).toContain(V)
    db.close()
  })

  it('🔴 judge 也能重新看见它（卡死的另一半：judge 谓词 needs_subtitle IS NULL）', async () => {
    // C27 有两条堵死的路，工作台谓词只是其中一条。另一条是 judge——若装盘把
    // needs_subtitle 写成 0，judge 的 `IS NULL` 谓词同样再也不会重判这一行。
    // 本用例钉住"装盘之后 needs_subtitle 仍是 judge 判出来的那个值"，即装盘没有越界改判决。
    const db = openDb(':memory:')
    seed(db)
    const item = listSubtitleQueue(db, ['/media'], NOW)[0]
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item, 'zh')
    // 装盘不碰 needs_subtitle（D8）：它是语言事实的投影，只有 judge 与换片源清空能改它。
    expect(needsSubtitleOf(db, V)).toBe(1)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 阶段 2.6 停牌复查闸（D13 + D14 + D15 / 缺口 C35 + C41 + C36）
//
// 用户原话：「可以改成每周一次，但是页面上还是显示停牌吧，除非哪天字幕真找到了」
// 即：停牌 ≠ 系统放弃。后台继续每周找一次，界面在字幕真出现前一直显示停牌。
//
// 这个洞的形状与 C12/C35/D17 完全同型（本仓已栽四次）：**有裁决、有写入者、没有读回来的人**。
// 3-2 已实现"满 7 次 → 写停牌态 + recheck_after=+7天"，但没有任何代码把它们放回来：
// 字幕工作台谓词是 `sub_status IS NULL`，停牌行根本不在它视野内 → 它看不见也就改不了（鸡生蛋）。
//
// 为什么必须是独立阶段而不能塞给字幕流（D13）：强行让字幕流改状态会掀掉**正在被翻译流处理**的
// handoff_translate 行 → 翻译回写时 D10 的乐观守卫 `WHERE sub_status='handoff_translate'`
// 匹配 0 行 → tr_recheck_after 不写 → D6 要防的付费 LLM 热循环从侧门放回来。
//
// 这一组里有两条**成本红线**，它们是本 task 唯一会静默退化的地方（错了照样全绿）：
//   · sub_attempt 归零 → 重新攒 7 次才停牌 → 7 次/14 天 ≈ 182 session/年（D15 要防的 3.5 倍）
//   · 取件不看翻译开关 → handoff_translate 在"翻译未启用"时成永久终态（C41 / 上一轮刚修掉的洞）
// 故两条都用**变异验证**钉过（改成错的实现必须红），不只靠"看起来断言了"。
// ─────────────────────────────────────────────────────────────────────────────

/** 直接驱动阶段 2.6，绕开识别/字幕两个 agent 阶段的噪音。
 *  端到端的"阶段顺序对不对"另有专门用例走完整 runInspection，不靠这个捷径。 */
async function reviewParked(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).reviewParkedOnce()
}

/** 造一行"已停牌"的 files 行：满 7 次未果、3-2 写下了停牌态 + recheck_after=+7天。
 *
 *  sub_attempt 默认播种 7 而不是 0：这是生产上停牌行的**真实形态**（它正是攒到 7 次才停牌的），
 *  而 D15 那条红线（不归零）只有在播种值非 0 时才看得见——播 0 的话"归零"与"不动"结果一样，
 *  用例就是个假绿。needs_subtitle=1 是刚性前置：放回 NULL 之后要能被字幕工作台谓词
 *  （needs_subtitle=1 AND sub_status IS NULL）捞走，少了它端到端那条用例测的就是别的东西。 */
function seedParked(
  db: ReturnType<typeof openDb>,
  path: string,
  opts: {
    sub_status: string | null
    recheck_after?: number | null
    sub_attempt?: number
    translatable?: number | null
    needs_subtitle?: number | null
  },
): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const workId = 'tmdb:42'
  if (!db.prepare('SELECT id FROM works WHERE id = ?').get(workId)) {
    db.prepare('INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(workId, 'Show', 'tv', 'en', 1000, 1000)
  }
  db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                 season, episode, needs_subtitle, sub_status, sub_attempt,
                                 translatable, recheck_after, sub_recheck_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, dir, workId,
      1, 1,
      opts.needs_subtitle === undefined ? 1 : opts.needs_subtitle,
      opts.sub_status,
      opts.sub_attempt === undefined ? 7 : opts.sub_attempt,
      opts.translatable === undefined ? 0 : opts.translatable,
      opts.recheck_after === undefined ? NOW - 1 : opts.recheck_after,
      NOW + 5 * DAY,   // 未到点：让 B 档不来搅局（本组测的是复查闸，不是字幕存在性观察）
      1000)
}

function attemptOf(db: ReturnType<typeof openDb>, path: string): number {
  return (db.prepare('SELECT sub_attempt FROM files WHERE path = ?').get(path) as { sub_attempt: number }).sub_attempt
}

function recheckAfterOf(db: ReturnType<typeof openDb>, path: string): number | null {
  return (db.prepare('SELECT recheck_after FROM files WHERE path = ?').get(path) as { recheck_after: number | null }).recheck_after
}

describe('ScoutDaemonV2.reviewParkedOnce · 阶段 2.6 停牌复查闸（D13）', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴 用例1: unsolvable 且 recheck_after 到点 → sub_status 放回 NULL（R25/R26：无永久终态）', async () => {
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1 })
    expect(subStatusOf(db, V)).toBe('unsolvable')   // 前置：确实停牌着，否则用例空转
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it('🔴 用例2: unsolvable 但 recheck_after 未到点 → 一列不动（防退化成日频，R25「每周一次」）', async () => {
    // 这一条守的是节奏而不是终态：少了它，实现可以写成"无脑把所有停牌行放回 NULL"，
    // 用例 1 照样绿，而生产上停牌行每天被字幕流重选一次 → 365 session/年（R25 要的是 52）。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW + 3 * DAY })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBe('unsolvable')
    db.close()
  })

  it('🔴🔴 用例3: 放回时 sub_attempt **保持不动**（D15 成本红线：归零 = 182 session/年 vs 52）', async () => {
    // 归零后要重新攒 7 次才再停牌 → 一个永远找不到字幕的文件变成 7 次/14 天 ≈ 182 session/年；
    // 不归零则回 NULL 后下次失败立即判 >=7 → 直接回停牌 → 稳定 1 次/周 ≈ 52 session/年。
    // 差 3.5 倍，且这个退化**完全静默**：状态流转看起来一模一样，只有账单会说话。
    // 播种值刻意是 7（生产真实形态）——播 0 的话"归零"与"不动"结果相同，用例就是假绿。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1, sub_attempt: 7 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBeNull()   // 放回确实发生了，否则下一行是空转的假绿
    expect(attemptOf(db, V)).toBe(7)
    db.close()
  })

  it('🔴 用例3b: sub_attempt=9 的行（超过 7）同样不归零（D15 与 `>= 7` 分流谓词的咬合）', async () => {
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1, sub_attempt: 9 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await reviewParked(daemon)
    expect(attemptOf(db, V)).toBe(9)
    db.close()
  })

  it('🔴🔴 用例4: 翻译**未启用** + handoff_translate 到点 → 放回 NULL（D14a / C41 永久终态红线）', async () => {
    // C41：默认场景下用户并没开翻译（双门控：TRANSLATE_* 凭证 + ai_translate_enabled==='true'）。
    // 于是满 7 次 → judge 判可翻译 → 写 handoff_translate → 翻译流不启动 → 复查闸又不管它
    // → **永久卡死**。这正是上一轮刚修掉的"永久判死"原地复活。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'handoff_translate', recheck_after: NOW - 1, translatable: 1 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], translateEnabled: () => false }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    expect(attemptOf(db, V)).toBe(7)   // D15 对这条支路同样成立
    db.close()
  })

  it('🔴🔴 用例5: 翻译**已启用** + handoff_translate 到点 → **一列不动**（D14：不许打断飞行中的翻译）', async () => {
    // 翻译流是 SELECT → await LLM（数分钟）→ 带守卫 UPDATE。复查闸若在这几分钟里把状态清成
    // NULL，D10 的乐观守卫 `WHERE sub_status='handoff_translate'` 就匹配 0 行 →
    // tr_recheck_after 不写 → 下一圈立刻重领同一行 → **付费 LLM 热循环**（D6 要防的那个，
    // 从侧门回来）。这也是 D13 坚持"复查闸必须独立、且取件范围随开关变"的全部理由。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'handoff_translate', recheck_after: NOW - 1, translatable: 1 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], translateEnabled: () => true }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBe('handoff_translate')
    db.close()
  })

  it('🔴 用例5b: 翻译已启用时 unsolvable **仍然**参与（D14「unsolvable 恒参与」）', async () => {
    // 防实现写成"翻译开着就整个阶段跳过"——那样 unsolvable 会跟着被误伤成永久终态，
    // 而它压根不归翻译流管（translatable=0，翻译流对它无能为力，R21 明令不给第 8 次机会）。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1, translatable: 0 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], translateEnabled: () => true }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it.each([['covered'], [null]])(
    '🔴 用例6: sub_status=%s 的行不被这个闸门碰（隔离性：复查闸只管停牌两态）',
    async (status) => {
      // covered 被碰 = 磁盘上明明有字幕却重进字幕工作台白烧付费 LLM，且违背 R24
      // （covered 的唯一写入/回退者是扫描，复查闸无权碰它）。
      // NULL 行被碰 = 它的 recheck_after 是"失败退避到明天"的凭据，被清掉就等于同轮/次日
      // 立刻重选 → 退避机制整个失效。故这条用例连 recheck_after 一起断言。
      const db = openDb(':memory:')
      seedParked(db, V, { sub_status: status as string | null, recheck_after: NOW - 1 })
      const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
      await reviewParked(daemon)
      expect(subStatusOf(db, V)).toBe(status)
      expect(recheckAfterOf(db, V)).toBe(NOW - 1)   // 退避凭据也不许被顺手动
      db.close()
    })

  it('🔴 用例10: 复查闸抛错不拖垮整轮巡检（与其他阶段一致的隔离口径）', async () => {
    // 口径与 gcStaging / 回填 pass / 各运维器官一致：复查是增益，它挂了顶多是停牌行晚一天
    // 被放回；做成阻塞项就是"一次库锁/一条坏 SQL 停掉整条流水线"——而流水线里还有扫描的
    // 删除清理（R6/R7 的地基）与两条工作台。
    //
    // 故障注入打在 db.prepare 上（复查闸唯一的外部依赖），而不是 monkey-patch 私有方法：
    // 后者会连"实现到底调没调这个方法"一起被替换掉，测出来的是替身的行为。
    //
    // 判据取 SQL 里的字面量 `unsolvable`——它在 daemonV2 里**只出现在复查闸的取件谓词中**。
    // 第一版写的是 `/sub_status\s*=\s*NULL/`，那同时命中了 scanOnce 的指纹重置子句
    // （C11 的 `sub_status=NULL`）→ 炸的是阶段 1 而不是 2.6，用例red 得理由都是假的。
    // 这正是"只看红不看红的理由"会漏掉的那类假红/假绿。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1 })
    const real = db.prepare.bind(db)
    const boom = {
      ...db,
      prepare: (sql: string) => {
        if (/unsolvable/.test(sql)) throw new Error('database is locked')
        return real(sql as any)
      },
    } as any
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      db: boom, roots: ['/media'], ...fakeFs({ '/media': [] }),
      log: (m: string) => logs.push(m),
    }))
    // 整轮巡检（不是只跑 2.6）：要证明的正是"它抛错也不掀翻别的阶段"。
    await expect((daemon as any).runInspection(new AbortController().signal)).resolves.toBeUndefined()
    expect(logs.some(l => l.includes('停牌复查'))).toBe(true)
    db.close()
  })
})

describe('阶段 2.6 · translateEnabled 未注入时的默认语义（C41 vs 飞行中的翻译）', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴 用例9: translateEnabled 未注入 → 默认「翻译未启用」，handoff_translate 参与复查', async () => {
    // 论证（两种默认各有伤害，取伤害小的那个）：
    //  · 默认"已启用" → handoff_translate 永远不被复查 → C41 的永久卡死**在缺省接线下复活**。
    //    而缺省接线正是最常见的形态（watchV2 那条独立入口、以及几十条既有测试的 mkDeps）。
    //    伤害是**永久的、静默的**：文件再也不补字幕，界面上什么异常都看不出来。
    //  · 默认"未启用" → 复查闸可能碰到飞行中的翻译。但翻译流**第 4 步才接入 daemonV2**
    //    （C3：daemonV2 里 translate 零命中，spec §4 明记"翻译从第 2 步起饿死"），
    //    所以**今天不存在飞行中的翻译**，这条伤害的前提为假。
    // 故默认"未启用"。第 4 步接入翻译流时，真实双门控必须同时接上（watchWiring 已接），
    // 那时缺省值只影响没接线的构造点，而那些构造点也不会跑翻译流——自洽。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'handoff_translate', recheck_after: NOW - 1, translatable: 1 })
    const deps = mkDeps(db, { roots: ['/media'] })
    delete (deps as any).translateEnabled   // 显式表达"没接线"，而不是靠 mkDeps 恰好没给
    const daemon = new ScoutDaemonV2(deps)
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it('🔴 translateEnabled 是**惰性求值**（dashboard 改开关后下一轮巡检即生效，不用重启容器）', async () => {
    // 仓库既有约定（rootsProvider / targetLanguage / traceRetentionDays 全是这个口径）。
    // 写成布尔值会把"启动那一刻的开关"冻死在进程里：用户在 dashboard 关掉翻译后，
    // handoff_translate 行要等容器重启才恢复复查——而它们正是最需要被放回来的那批。
    const db = openDb(':memory:')
    seedParked(db, '/media/Show/E01.mkv', { sub_status: 'handoff_translate', recheck_after: NOW - 1, translatable: 1 })
    let enabled = true
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], translateEnabled: () => enabled }))
    await reviewParked(daemon)
    expect(subStatusOf(db, '/media/Show/E01.mkv')).toBe('handoff_translate')   // 开着 → 不碰
    enabled = false                                                            // 用户在 dashboard 关掉
    await reviewParked(daemon)
    expect(subStatusOf(db, '/media/Show/E01.mkv')).toBeNull()                   // 同一个实例，无需重启
    db.close()
  })
})

describe('🔴 阶段 2.6 端到端：放回来的行本轮就能被字幕流捞走（D13 的阶段位置）', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴🔴 用例7: 复查闸放回 → **同一轮**巡检的字幕工作台就能取到它（2.6 必须在 3 之前）', async () => {
    // 为什么必须端到端跑**真实的 listSubtitleQueue** 而不是断言 sub_status 列：
    // 阶段顺序错了（2.6 放在阶段 3 之后）时，列的终值一模一样、用例 1 照样绿，
    // 只是放回来的行要白等一整天（24h 时间闸）才被捞走。这一条是唯一能看见阶段位置的断言。
    //
    // 同时它也顺带钉住了"放回后的行确实满足工作台的**完整**谓词"——needs_subtitle=1 +
    // sub_status IS NULL + recheck_after 过门，三条缺一不可。
    // 诚实备注（变异验证 M4 的结论）：这三条里 recheck_after 那条**今天钉不住**——闸门的取件
    // 条件 `recheck_after IS NOT NULL AND <= now` 蕴含工作台的 `IS NULL OR <= now`，故实现里
    // 清不清那一列，本用例都绿。删掉实现里的 `recheck_after = NULL` 跑全套是 0 红，已确认。
    // 不为它编一条假用例（造一个"闸门触发了但工作台谓词不满足"的库状态，在今天的谓词组合下
    // 根本构造不出来，硬造只能靠直接 SQL 违反不变量——那测的是不存在的生产场景）。
    // 若将来有人收紧工作台谓词（去掉 `IS NULL OR`），这一条就会自动变成真红线。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1 })
    // 前置：它现在**不在**工作台里（谓词 sub_status IS NULL 看不见停牌行）——这正是 C35 的鸡生蛋
    expect(listSubtitleQueue(db, ['/media'], NOW).flatMap(q => q.files.map(f => f.path))).not.toContain(V)

    const seenByWorker: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [V] }),
      writableRoots: new Map([['/media', true]]),
      // 3-3 起阶段 3 消费快照前逐文件 stat（R12 / C23）：视频必须"在盘上"，否则整簇被剔除，
      // 本用例会红在"文件不存在"而不是它要测的阶段位置。这里同时也是一条有用的耦合声明——
      // 复查闸放回来的行**也要过 stat 这道门**（幽灵文件不该因为被放回就白跑一轮 agent）。
      fileExists: (p: string) => p === V,
      subtitleWorker: async (task: any) => {
        for (const t of task.targets) seenByWorker.push(t.videoPath)
        return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
      },
    }))
    await (daemon as any).runInspection(new AbortController().signal)

    // 🔴 load-bearing：阶段 2.6 若在阶段 3 之后（或不存在），worker 这一轮什么也看不到。
    expect(seenByWorker).toContain(V)
    db.close()
  })

  it('🔴🔴 用例8: 放回后下次失败**立即**回停牌（`>= 7` 而非重新攒 7 次 / D15 的另一半）', async () => {
    // 走真实的 runSubtitleWorkDir（即 bump 的真实路径），证明 D15 的两半是咬合的：
    // "复查闸不归零" + "分流谓词 >= 7" 合起来才等于"每周 1 次"。任何一半错了都变 182 次/年，
    // 而两半各自单测都能全绿——这正是本仓栽过四次的那种"组合缺陷"。
    const db = openDb(':memory:')
    seedParked(db, V, { sub_status: 'unsolvable', recheck_after: NOW - 1, sub_attempt: 7, translatable: 0 })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await reviewParked(daemon)
    expect(subStatusOf(db, V)).toBeNull()
    expect(attemptOf(db, V)).toBe(7)

    // 下一次字幕尝试失败（no_safe_match，最常见的失败路径 / R17）。
    // 时钟口径：runSubtitleWorkDir 内部用真实 Date.now()（无注入点），故取件也用真实时钟 +
    // 余量跨过退避——与 C27 端到端那组同一套论证，不把余量硬编码成两个时钟的差值。
    const item = listSubtitleQueue(db, ['/media'], Date.now() + 2 * DAY)[0]
    expect(item).toBeDefined()   // 前置：放回后它真的在工作台里
    await runSubtitleWorkDir(db, (async () => ({
      installed: [],
      no_safe_match: [{ itemId: 'tmdb:42/s1e1', reason: 'searched, nothing' }],
      retry_later: [], hardsub_assumed: [],
    })) as any, item, 'zh')

    // 🔴 一次失败就回停牌（8 >= 7），不是"重新攒 7 次"。
    expect(attemptOf(db, V)).toBe(8)
    expect(subStatusOf(db, V)).toBe('unsolvable')
    // 且退避是 +7 天（供下一次复查取件），不是"明天"——否则复查退化成日频。
    const ra = recheckAfterOf(db, V)!
    expect(ra).toBeGreaterThan(Date.now() + 6 * DAY)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3-3：冻结快照（R4 / C23）+ 消费前逐文件 stat（R12 / C23）+ 计数单调（C13）
//
// 用户原话（R4 的本体）：「每次巡检开始，流水线是冻结的，开工没有回头箭，找到的记录，
// 找不到的不管，留给下次。」
//
// 改动前两条工作台都是 `while (true) { queue = listXxxQueue(...); if (empty) break; 处理 queue[0] }`
// —— **每圈重新查库**。这不是冻结，是滚动重算，两个真实伤害：
//   ① 大库在 115 FUSE 上真能跑 10h，期间新入库的文件会被本轮捞走 → "开工没有回头箭"被破坏
//   ② 任何一条失败路径忘了写退避 → 该行仍满足工作台谓词 → **同轮无限重选**，跑完整 agent
//      session 一直烧到进程被杀（C26 热循环的形态）。D6 靠"必须写 recheck_after"防它，
//      冻结是第二道防线——两道都在才叫防线，只有一道就是"哪天谁漏写一次就出事"。
//
// 为什么冻结之后**不需要**再补一轮"消费完再查一次"（用户点名要论证的那条）：
// spec §2 的阶段语义是"有活就一直跑，跑空才进下一步"，而阶段 2 → 2.5 → 2.6 → 3 是**串行**的。
// 阶段 3 开跑时上游已经全部静止：识别不会再绑新 work_id、judge 不会再写 needs_subtitle、
// 复查闸不会再放回停牌行、扫描早在阶段 1 就结束了。于是"快照拍完之后还能新增的字幕活"
// 只有两个来源，两个都**必须**被排除：
//   · 磁盘上新出现的文件 —— R4 原话点名不管（"找到的记录，找不到的不管，留给下次"）
//   · 快照拍摄那一刻仍在退避窗内、但跑到一半到点了的行 —— 这是"队列漂移"本身，
//     R4 那句"跑的过程中队列不漂移"就是在说它
// 故：拍一次，消费完即结束。补查一轮既违背 R4，又把 ① 的伤害原样放回来。
// ─────────────────────────────────────────────────────────────────────────────

/** 磁盘建模：视频 + 字幕**同一份** fileExists（它就是文件系统谓词，不该有两套）。
 *
 *  为什么本组必须显式注入它而既有的 R24 组用 fakeSubtitleDisk([]) 就够：3-3 让阶段 3 在消费
 *  快照前对每个视频 stat 一次，于是"视频在不在盘上"第一次成为**阶段 3 的输入**。
 *  fakeSubtitleDisk 建模的是"只有字幕在盘上"（视频路径不在集合里 → fileExists 返 false），
 *  拿它跑阶段 3 就等于声明"这些视频全没了"——那测的是别的东西。 */
function fakeVideoDisk(videos: string[], subtitles: string[] = []) {
  const present = new Set([...videos, ...subtitles])
  const calls: string[] = []
  return {
    calls,
    fileExists: (p: string) => { calls.push(p); return present.has(p) },
    /** 模拟巡检跑到一半用户删了文件（快照已冻结，磁盘变了）。 */
    remove: (p: string) => { present.delete(p) },
  }
}

/** 造一簇"在字幕工作台里"的行：已识别 + needs_subtitle=1 + sub_status NULL + 无退避。
 *  sub_recheck_at 刻意设成未到点：本组测的是工作台的取件与消费，不是字幕存在性观察——
 *  让 B 档来搅局的话，observeSubtitle 会顺手改 sub_status，断言就测不准了。 */
function seedWorkbench(
  db: ReturnType<typeof openDb>,
  workId: string,
  files: Array<{ path: string; season?: number | null; episode?: number | null }>,
): void {
  if (!db.prepare('SELECT id FROM works WHERE id = ?').get(workId)) {
    db.prepare(`INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at)
                VALUES (?,?,?,?,?,?)`).run(workId, `Show ${workId}`, 'tv', 'en', 1000, 1000)
  }
  const ins = db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                             season, episode, needs_subtitle, sub_status,
                                             recheck_after, sub_recheck_at, updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf('/'))
    ins.run(f.path, dir, f.path.slice(f.path.lastIndexOf('/') + 1), BIG, 1000, dir, workId,
      f.season === undefined ? 1 : f.season, f.episode === undefined ? 1 : f.episode,
      1, null, null, NOW + 5 * DAY, 1000)
  }
}

/** 数"某条 SQL 被 prepare 了几次"的 db 包装。
 *
 *  用 Proxy 而不是 `{...db, prepare}`：better-sqlite3 的方法挂在原型上，对象展开拿不到
 *  `transaction`（deleteMissing 要用）→ 扫描当场抛错，红得理由是假的。
 *
 *  判据是 SQL 里的字面量而不是"调了几次 listSubtitleQueue"：那个函数是静态 import 进
 *  daemonV2 的，模块级 mock 会把被测对象换成替身。代价是这条断言与 SQL 文本耦合——
 *  故正则取**只可能出现在该查询里**的片段（`needs_subtitle = 1` 只在 listSubtitleQueue，
 *  judgeOnce 用的是 `needs_subtitle IS NULL`）。文本改了这条会红，那时该改断言。 */
function countingDb(db: ReturnType<typeof openDb>, re: RegExp) {
  let n = 0
  const proxy = new Proxy(db as any, {
    get(target, key) {
      if (key === 'prepare') {
        return (sql: string) => { if (re.test(sql)) n++; return target.prepare(sql) }
      }
      const v = target[key]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return { proxy: proxy as ReturnType<typeof openDb>, count: () => n }
}

const SUBTITLE_QUEUE_SQL = /needs_subtitle = 1/
const IDENTIFY_QUEUE_SQL = /work_id IS NULL/

describe('ScoutDaemonV2 阶段 3 · R4 冻结快照（C23：至今未实现）', () => {
  const A = '/media/ShowA/E01.mkv'
  const B = '/media/ShowB/E01.mkv'

  it('🔴🔴 用例1: 巡检中途新入库的文件**不被本轮捞走**（R4「找不到的不管，留给下次」）', async () => {
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A }])
    // 🔴 B **必须在盘上**（连同 A 一起建模），否则本用例会被 3-3 的另一半（消费前 stat）
    // 顺手挡掉：变异验证 M1b 实测到过——撤销字幕冻结后这条仍然绿，因为 B 是被"文件不存在"
    // 剔除的，而不是被冻结拦住的。两个机制都能让 `seen` 只含 A，用例分辨不出是哪一个在起
    // 作用，于是它守的其实是"stat 生效"而不是"冻结生效"（一条名不副实的假绿）。
    // 让 B 存在之后，唯一还能把它挡在本轮之外的机制就只剩冻结。
    const disk = fakeVideoDisk([A, B])
    const seen: string[] = []

    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [A] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async (task: any) => {
        for (const t of task.targets) seen.push(t.videoPath)
        // 处理第一个作品时，另一部剧刚被别人写进库（真实来源：用户往守备目录里拷了新片，
        // 而本轮扫描早就跑完了；或者别的进程/API 写库）。滚动重算下它会被本轮捞走。
        if (seen.length === 1) {
          seedWorkbench(db, 'tmdb:2', [{ path: B }])
        }
        return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
      },
    }))
    await (daemon as any).runInspection(new AbortController().signal)

    // 🔴 冻结的全部含义：本轮只看见拍快照那一刻的活。
    expect(seen).toEqual([A])
    // 而 B 确实在库里、确实满足工作台谓词——它只是"留给下次"（否则本用例是空转的假绿）。
    expect(listSubtitleQueue(db, ['/media'], NOW).flatMap(q => q.files.map(f => f.path))).toContain(B)
    db.close()
  })

  it('🔴🔴 用例2: 字幕队列**只被查询一次**（滚动重算下是 N+1 次）', async () => {
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A }])
    seedWorkbench(db, 'tmdb:2', [{ path: B }])
    const disk = fakeVideoDisk([A, B])
    const c = countingDb(db, SUBTITLE_QUEUE_SQL)

    const daemon = new ScoutDaemonV2(mkDeps(db, {
      db: c.proxy,
      roots: ['/media'],
      ...fakeFs({ '/media': [A, B] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(c.count()).toBe(1)
    db.close()
  })

  it('🔴🔴 用例9: 快照消费完就结束——即便被处理的行**没有出队**也不死循环（C26 第二道防线）', async () => {
    // 这一条守的是"冻结本身就是一道防线"，与 D6 的出队凭据**互不替代**：
    // 造一条"跑完了但没写出队凭据"的失败路径（生产上任何一条 catch 漏了回写就是这个形态），
    // 滚动重算下它会被同轮无限重选、跑完整 agent session 一直烧到进程被杀。
    //
    // 🔴 故障必须注入在 **db.prepare** 这一层（同用例 10 的既有手法），不能在 subtitleWorker
    // 里擦掉 recheck_after：worker 返回之后 runSubtitleWorkDir 的 B-2「无结局」兜底还会再
    // bump 一次，把出队凭据又写回去——本用例第一版正是这么写的，于是**改动前就绿**
    // （空转的假绿：它测的是"bump 能出队"，那是 D6 的账，不是冻结的账）。
    // 把 subtitleScheduler 的两条回写语句整体空转，才是"这条路径漏了回写"的真实形态。
    //
    // worker 里有失控刹车：滚动重算下这个循环不会自己停（见下方对 abort 的论证）。
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A }])
    seedWorkbench(db, 'tmdb:2', [{ path: B }])
    const disk = fakeVideoDisk([A, B])
    let calls = 0

    // 只空转"字幕轨的回写"这两条形态（bump 与 markInstalled），其余 SQL 一律真跑——
    // 整体空转会连扫描的 upsert 一起废掉，那测的又是别的东西了。
    const noopStmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
    const real = db.prepare.bind(db)

    // 🔴 失控保护必须打在**队列查询**这一层，不能在 worker 里 throw、也不能靠 abort：
    //  · worker 抛错被 `runSubtitleWorkDir` 的 catch-all（B-3）吞掉，循环照转——本用例第一版
    //    就是这么写的，结果不是"红"而是把 vitest worker 进程跑到 **OOM**（106s 后 heap 爆掉，
    //    json 报表里显示成"0 failed"，一个彻头彻尾的假绿）。
    //  · abort 也停不住：`this.stopping` 只在 `run()` 里被 signal 监听器置位，而本组用例
    //    直接调 `runInspection`（既有测试的通行捷径），那个监听器根本没注册过。
    // 队列查询在阶段 3 循环里**不在任何 try 内**，从这里抛出的错会一路穿出 runInspection，
    // 于是"失控"表现为用例 reject + 计数不符，而不是挂死。
    let queries = 0
    const stmtFor = (sql: string) => {
      if (/^UPDATE files SET (sub_attempt = \?|recheck_after = \?, updated_at)/.test(sql)) return noopStmt
      if (SUBTITLE_QUEUE_SQL.test(sql) && ++queries > 3) {
        throw new Error(`同轮重选失控：字幕队列已被重查 ${queries} 次（冻结失效）`)
      }
      return real(sql as any)
    }
    const neutered = new Proxy(db as any, {
      get(target, key) {
        if (key === 'prepare') return stmtFor
        const v = target[key]
        return typeof v === 'function' ? v.bind(target) : v
      },
    })

    const daemon = new ScoutDaemonV2(mkDeps(db, {
      db: neutered,
      roots: ['/media'],
      ...fakeFs({ '/media': [A, B] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async () => {
        calls++
        return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
      },
    }))
    await expect((daemon as any).runInspection(new AbortController().signal)).resolves.toBeUndefined()
    expect(calls).toBe(2)   // 两个作品各一次，不多不少
    expect(queries).toBe(1) // 且队列只查了一次（冻结的直接凭据）
    // 前置自检：出队凭据确实没被写下（否则本用例又退回成"测 D6"的空转假绿）
    expect(recheckAfterOf(db, A)).toBeNull()
    db.close()
  })
})

describe('ScoutDaemonV2 阶段 2 · R4 冻结快照（识别流同样形态）', () => {
  const UA = '/media/UnA/E01.mkv'
  const UB = '/media/UnB/E01.mkv'

  /** 造一行"未识别"的文件（work_id NULL → 落在识别工作台里）。 */
  function seedUnidentified(db: ReturnType<typeof openDb>, path: string): void {
    const dir = path.slice(0, path.lastIndexOf('/'))
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, sub_recheck_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, dir, NOW + 5 * DAY, 1000)
  }

  it('🔴🔴 用例8: 识别中途新入库的目录不被本轮捞走（阶段 2 的冻结）', async () => {
    const db = openDb(':memory:')
    seedUnidentified(db, UA)
    const seen: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [UA] }),
      fileExists: () => false,
      identify: {
        db,
        worker: {} as any,
        runIdentify: async (_deps: any, facts: any) => {
          seen.push(facts.workDir)
          if (seen.length === 1) seedUnidentified(db, UB)
          return { tmdbId: null, title: null, reason: 'noop' }
        },
      },
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(seen).toEqual(['/media/UnA'])
    db.close()
  })

  it('🔴 识别队列也只被查询一次', async () => {
    const db = openDb(':memory:')
    seedUnidentified(db, UA)
    seedUnidentified(db, UB)
    const c = countingDb(db, IDENTIFY_QUEUE_SQL)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      db: c.proxy,
      roots: ['/media'],
      ...fakeFs({ '/media': [UA, UB] }),
      fileExists: () => false,
      identify: {
        db: c.proxy,
        worker: {} as any,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
      },
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(c.count()).toBe(1)
    db.close()
  })
})

describe('ScoutDaemonV2 阶段 3 · R12/C23 消费快照前逐文件 stat', () => {
  const A = '/media/ShowA/E01.mkv'
  const A2 = '/media/ShowA/E02.mkv'

  it('🔴🔴 用例3: 快照里的文件已从磁盘消失 → 剔除，且 sub_attempt **不变**（C23 红线）', async () => {
    // 改动前：agent 拿到一批不存在的 videoPath → staging 沙盒在已删目录 ENOENT → 抛错 →
    // catch 里 bump **全部**文件 → sub_attempt 白涨一次。连 7 天白涨 7 次后这个**已经不存在
    // 的文件**被"移交翻译流"，翻译流才用 R12 检出它不存在 → 7 天的 LLM 花在幽灵上。
    //
    // 关键在"不计数"：文件没了不是一次"失败尝试"。把它记成尝试就是让 R10 的 7 次额度
    // 被幽灵吃掉，而 R7（消失即删行）本来会在下一轮扫描把这一行整个删掉——那才是正解。
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A, episode: 1 }, { path: A2, episode: 2 }])
    const disk = fakeVideoDisk([A, A2])
    const seen: string[] = []

    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      // 磁盘上两个文件都还在（扫描阶段不删行），但**跑到阶段 3 时** A2 被用户删了。
      ...fakeFs({ '/media': [A, A2] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async (task: any) => {
        for (const t of task.targets) seen.push(t.videoPath)
        return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
      },
    }))
    // 快照冻结之后、消费到它之前，磁盘变了
    const origScan = (daemon as any).scanOnce.bind(daemon)
    ;(daemon as any).scanOnce = async () => { await origScan(); disk.remove(A2) }

    await (daemon as any).runInspection(new AbortController().signal)

    expect(seen).toEqual([A])                  // A2 被剔除，agent 一眼都没看到
    expect(attemptOf(db, A2)).toBe(0)          // 🔴 不计数：文件没了 ≠ 一次失败尝试
    expect(recheckAfterOf(db, A2)).toBeNull()  // 也不写退避（一列都不许动）
    expect(attemptOf(db, A)).toBe(1)           // 存在的那个照常走失败轨（B-2 无结局兜底）
    db.close()
  })

  it('🔴🔴 用例4: 整个作品的文件都不存在 → 跳过该作品，**不调 worker**', async () => {
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A, episode: 1 }, { path: A2, episode: 2 }])
    const disk = fakeVideoDisk([A, A2])
    const worker = vi.fn(async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }))

    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [A, A2] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: worker as any,
    }))
    const origScan = (daemon as any).scanOnce.bind(daemon)
    ;(daemon as any).scanOnce = async () => { await origScan(); disk.remove(A); disk.remove(A2) }

    await (daemon as any).runInspection(new AbortController().signal)

    expect(worker).not.toHaveBeenCalled()
    expect(attemptOf(db, A)).toBe(0)
    expect(attemptOf(db, A2)).toBe(0)
    // 沙盒也不许被登记为"在飞行"——登记了却没跑，这个 jobId 会白白免疫一次 GC
    expect([...((daemon as any).inFlightStagingJobIds as Set<string>)]).toEqual([])
    db.close()
  })

  it('🔴 用例5: 部分文件消失 → 只把还在的那些交给 agent（不是整簇丢掉）', async () => {
    // 反向红线：实现若写成"有任何一个文件不存在就跳过整个作品"，同一部剧里其他还在的集
    // 就被连坐——而它们本该照常补字幕。这一条与用例 4 是一对，缺一条实现就能两头讨好。
    const db = openDb(':memory:')
    const A3 = '/media/ShowA/E03.mkv'
    seedWorkbench(db, 'tmdb:1', [
      { path: A, episode: 1 }, { path: A2, episode: 2 }, { path: A3, episode: 3 },
    ])
    const disk = fakeVideoDisk([A, A2, A3])
    const seen: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [A, A2, A3] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async (task: any) => {
        for (const t of task.targets) seen.push(t.videoPath)
        return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
      },
    }))
    const origScan = (daemon as any).scanOnce.bind(daemon)
    ;(daemon as any).scanOnce = async () => { await origScan(); disk.remove(A2) }

    await (daemon as any).runInspection(new AbortController().signal)
    expect(seen.sort()).toEqual([A, A3].sort())
    expect(attemptOf(db, A2)).toBe(0)
    db.close()
  })
})

describe('ScoutDaemonV2 阶段 3 · C13 sub_attempt 单调递增', () => {
  const A = '/media/ShowA/E01.mkv'
  const SUB = '/media/ShowA/E01.zh-Hans.srt'

  it('🔴🔴 用例6: 字幕 worker 抛错 → sub_attempt 仍 +1（异常不许让计数停摆）', async () => {
    // 计数不单调 = 永远攒不到 7 次 = 停牌/移交翻译**静默失效**：那个文件每天被重选一次、
    // 每天烧一次付费 LLM，永不终止，而界面上什么异常都看不出来。
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A }])
    const disk = fakeVideoDisk([A])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [A] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async () => { throw new Error('LLM 500') },
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(attemptOf(db, A)).toBe(1)
    expect(recheckAfterOf(db, A)).not.toBeNull()   // 且写了退避，本轮/次日不会原地重选
    db.close()
  })

  it('🔴🔴 用例7: 装盘成功 → sub_attempt **不涨**（防"成功也计数"这个反向 bug）', async () => {
    // 3-2 刚明确"装盘成功不递增计数"：否则一个"每次都装盘成功但字幕总没落地"的文件会在
    // 7 轮后被判进停牌，而它一次都没"找不到"过。用例 6 的修法（保证回写）最容易顺手引入
    // 的正是这个反向 bug，故两条必须成对。
    const db = openDb(':memory:')
    seedWorkbench(db, 'tmdb:1', [{ path: A }])
    const disk = fakeVideoDisk([A])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [A] }),
      fileExists: disk.fileExists,
      writableRoots: new Map([['/media', true]]),
      subtitleWorker: async () => ({
        installed: [{ itemId: 'tmdb:1/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
      }),
    }))
    await (daemon as any).runInspection(new AbortController().signal)
    expect(attemptOf(db, A)).toBe(0)
    expect(subStatusOf(db, A)).toBeNull()          // 也不许写 covered（R24 仍然成立）
    expect(recheckAfterOf(db, A)).not.toBeNull()   // 但要出队（D6）
    db.close()
  })

  // 编排侧裁决（2026-08-08）：`bumpAllAsAttempt` 这条路径写的是 `sub_attempt + 1` ——
  // 它已经表态"这是一次真实尝试"。既然表了态，就必须同时归零 sub_retry_streak，
  // 否则同一次回写里自相矛盾：一边说算一次尝试、一边保留 retry_later 的豁免进度。
  // 极端形态：streak=CAP-1 的行在这里记一次尝试，下一次真限流立刻再折算一次，同一个
  // 失败被计两笔额度。修法已落地（daemonV2.ts 的 UPDATE 里加了 sub_retry_streak = 0）。
  //
  // 🔴 但这一行**目前没有测试守着**，如实记下来而不是造一条假绿：
  // 我试过三种注入方式都没能可靠触达这条缝——
  //   ① 让 subtitleWorker 抛错 → runSubtitleWorkDir 自己的 catch-all（subtitleScheduler.ts:352
  //      的 `bump(f, reason)`）先吞掉了，走的是 'attempted' 档，归零是 bump() 做的。
  //      摘掉 bumpAllAsAttempt 的归零后测试依然全绿 = 两个机制都让 streak 变 0，
  //      用例分辨不出谁在起作用（与本仓栽过多次的假绿同型）。
  //   ② mock db.prepare 让特定 SQL 抛错 → 那条 SQL 在本场景下压根没被执行到，
  //      `expect(thrown).toBe(true)` 当场证伪，测试红的理由是"故障没注入"而非"归零失效"。
  // 这条缝的触发条件是"runSubtitleWorkDir 调用点之外、finally 之前抛错"，从 deps 注入面
  // 够不到。要么给它开一个专门的测试缝（为测试改生产结构），要么承认它只能靠 code review 守。
  // 选后者：这一行的正确性是从"已表态算一次尝试"直接推出的，不是靠巧合成立的。
  // 若日后有人给 daemonV2 加了可注入的 hook，这里是补测试的入口。
})


// ─────────────────────────────────────────────────────────────────────────────
// 第 4 步：翻译流接进 daemonV2 —— 主进程内独立循环（R19 + C32 + C3）
//
// **循环形态与它的论证**（C32 要求形态必须明确）：照 spec §4 的建议——主巡检每轮**末尾**
// 推进一次翻译，**单次只处理一个作品**。
//
// 为什么这个形态满足 R11「翻译流独立，不与识别/字幕互相阻塞」：
//  · 不阻塞识别/字幕 —— 它跑在阶段 3 **之后**，此时两条上游工作台的快照都已消费完；
//    翻译再慢也只是让"歇到明天"晚开始，不会让任何一个字幕活等它（用例 11 钉这条）。
//  · 不被它们阻塞 —— 它有自己的取件谓词（sub_status='handoff_translate'）与自己的退避列
//    （tr_recheck_after / D3），与字幕流的谓词严格互斥（C14），故字幕流的队列状态挡不住它。
//    旧 daemon.ts 的设计恰恰相反（"translate 只在巡检世界全空时才领"= 被巡检阻塞），
//    那正是 C3 记的"旧设计与 R11 正相反"。
//  · 单次只处理一个作品 —— 一个作品的翻译是数分钟到数小时的付费 LLM。一轮吃光整个队列会
//    把巡检拖成几十小时，期间删除清理（R6/R7 的地基）与两条工作台全被堵在后面。
//    队列不会因此饿死：每轮巡检推进一个，且没被领到的行 tr_recheck_after 一列都没被碰过，
//    下一轮照样是最优先的候选（谓词是 `IS NULL OR <= now`，不是"轮转指针"）。
// ─────────────────────────────────────────────────────────────────────────────
describe('翻译工作流 · 主进程内独立循环（第 4 步 / R19 + R12 + C3 + C32 + D6 + D10）', () => {
  const NOW2 = 1_000_000_000_000
  const V1 = '/media/Show/E01.mkv'
  const V2 = '/media/Show/E02.mkv'

  /** 一行 handoff_translate 的待翻文件（files + works 都齐，谓词是 INNER JOIN）。 */
  function seedHandoff(
    db: ReturnType<typeof openDb>,
    path: string,
    opts: { workId?: string; trRecheckAfter?: number | null; trAttempt?: number; subStatus?: string } = {},
  ): void {
    const workId = opts.workId ?? 'tmdb:1'
    const dir = path.slice(0, path.lastIndexOf('/'))
    if (!db.prepare('SELECT 1 FROM works WHERE id = ?').get(workId)) {
      db.prepare('INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(workId, 'Show', 'tv', 'en', 1000, 1000)
    }
    db.prepare(
      `INSERT INTO files (path, dir, filename, size, mtime, work_id, needs_subtitle, sub_status,
                          sub_attempt, tr_attempt, tr_recheck_after, updated_at)
       VALUES (?,?,?,?,?,?,1,?,7,?,?,?)`,
    ).run(
      path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, workId,
      opts.subStatus ?? 'handoff_translate', opts.trAttempt ?? 0, opts.trRecheckAfter ?? null, 1000,
    )
  }

  function trRowOf(db: ReturnType<typeof openDb>, path: string) {
    return db.prepare('SELECT sub_status, tr_attempt, tr_recheck_after FROM files WHERE path = ?')
      .get(path) as { sub_status: string | null; tr_attempt: number; tr_recheck_after: number | null }
  }

  /** 直接驱动翻译推进一轮（绕开 24h 时间闸与前面三个阶段的噪音）。 */
  async function advance(daemon: ScoutDaemonV2): Promise<void> {
    await (daemon as any).advanceTranslateOnce()
  }

  it('🔴 到点的 handoff_translate 行被领走并跑 runItem（C3：翻译接回来了）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1)
    const seen: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2,
      translateEnabled: () => true,
      fileExists: () => true,
      translateRunItem: async (p: string) => { seen.push(p); return { status: 'installed' as const } },
    }))
    await advance(daemon)
    expect(seen).toEqual([V1])
    db.close()
  })

  it('🔴 用例 9：翻译开关关闭 → 不领新活（runItem 一次都不调）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1)
    let calls = 0
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2,
      translateEnabled: () => false,
      fileExists: () => true,
      translateRunItem: async () => { calls++; return { status: 'installed' as const } },
    }))
    await advance(daemon)
    expect(calls).toBe(0)
    // 且**一列都不许动**：关掉翻译不是"处理成失败"，这批行归阶段 2.6 复查闸管（D14a）
    expect(trRowOf(db, V1)).toMatchObject({ sub_status: 'handoff_translate', tr_attempt: 0, tr_recheck_after: null })
    db.close()
  })

  it('🔴 translateRunItem 未注入 → 整支休眠（缺省接线零成本，同 probe/gcStaging 的既有口径）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1)
    const daemon = new ScoutDaemonV2(mkDeps(db, { now: () => NOW2, translateEnabled: () => true, fileExists: () => true }))
    await advance(daemon)
    expect(trRowOf(db, V1).tr_recheck_after).toBeNull()
    db.close()
  })

  it('🔴 用例 2（端到端）：tr_recheck_after 未到点的不被领（D6 防付费 LLM 热循环）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1, { trRecheckAfter: NOW2 + 1 })
    let calls = 0
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true, fileExists: () => true,
      translateRunItem: async () => { calls++; return { status: 'installed' as const } },
    }))
    await advance(daemon)
    expect(calls).toBe(0)
    db.close()
  })

  it('🔴 单次只处理一个作品（C32 形态约束：不许一轮吃光队列）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1, { workId: 'tmdb:1' })
    seedHandoff(db, V2, { workId: 'tmdb:2' })
    const seen: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true, fileExists: () => true,
      translateRunItem: async (p: string) => { seen.push(p); return { status: 'installed' as const } },
    }))
    await advance(daemon)
    expect(seen).toHaveLength(1)
    // 没被领的那行一列都没动 → 下一轮它还是最优先候选（不会饿死）
    const untouched = seen[0] === V1 ? V2 : V1
    expect(trRowOf(db, untouched).tr_recheck_after).toBeNull()
    db.close()
  })

  it('🔴 用例 5（端到端）：installed → 不写 covered + 清 tr_attempt + 写 tr_recheck_after', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1, { trAttempt: 2 })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true, fileExists: () => true,
      translateRunItem: async () => ({ status: 'installed' as const }),
    }))
    await advance(daemon)
    const r = trRowOf(db, V1)
    expect(r.sub_status).toBe('handoff_translate')          // ① 不写 covered（R24 扫描独占）
    expect(r.tr_attempt).toBe(0)                            // ② 清额度
    expect(r.tr_recheck_after).toBe(NOW2 + 86_400_000)      // ③ 出队（D6）
    db.close()
  })

  it('🔴 用例 6（端到端）：no-source → unsolvable', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true, fileExists: () => true,
      translateRunItem: async () => ({ status: 'no-source' as const }),
    }))
    await advance(daemon)
    expect(trRowOf(db, V1).sub_status).toBe('unsolvable')
    db.close()
  })

  it('🔴 用例 7（端到端）：held 满 3 次 → unsolvable；未满 → 退避且状态不变', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1, { trAttempt: 0 })
    const mk = (now: number) => new ScoutDaemonV2(mkDeps(db, {
      now: () => now, translateEnabled: () => true, fileExists: () => true,
      translateRunItem: async () => ({ status: 'held' as const, reason: '术语漂移' }),
    }))
    await advance(mk(NOW2))
    expect(trRowOf(db, V1)).toMatchObject({ tr_attempt: 1, sub_status: 'handoff_translate' })
    await advance(mk(NOW2 + 86_400_000))
    expect(trRowOf(db, V1)).toMatchObject({ tr_attempt: 2, sub_status: 'handoff_translate' })
    await advance(mk(NOW2 + 2 * 86_400_000))
    expect(trRowOf(db, V1)).toMatchObject({ tr_attempt: 3, sub_status: 'unsolvable' })
    db.close()
  })

  it('🔴 用例 8（端到端 / D10）：跑 LLM 期间扫描写了 covered → 回写不生效且被观察到', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1, { trAttempt: 1 })
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true, fileExists: () => true,
      log: (m: string) => logs.push(m),
      // 在"LLM 跑着"的这一刻模拟扫描抢先写 covered（R24 扫描独占）——这就是 D10 的真实剧本
      translateRunItem: async () => {
        db.prepare(`UPDATE files SET sub_status='covered' WHERE path=?`).run(V1)
        return { status: 'installed' as const }
      },
    }))
    await advance(daemon)
    const r = trRowOf(db, V1)
    expect(r.sub_status).toBe('covered')     // 磁盘事实没被翻译回写覆盖
    expect(r.tr_attempt).toBe(1)             // 一列都没动
    // 守卫匹配 0 行必须**可观察**：否则你不知道发生过覆盖，也不知道 tr_recheck_after 没写上
    expect(logs.some((l) => l.includes('守卫'))).toBe(true)
    db.close()
  })

  it('🔴 用例 10（R12）：文件已不存在 → 跳过、不调 runItem、**不计 tr_attempt**', async () => {
    // R12 + C23 的同一条原则（字幕流的 dropVanishedFiles 已立过）：文件没了不是"一次失败尝试"。
    // 让幽灵吃掉失败额度就是把"满 3 次转 unsolvable"的判据整个污染——一个已被删除的文件会在
    // 3 轮后被写成 unsolvable，而它压根不该再有任何状态（R7：下一轮扫描会把这行整个删掉）。
    const db = openDb(':memory:')
    seedHandoff(db, V1, { trAttempt: 1 })
    let calls = 0
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true,
      fileExists: () => false,                       // 复用 1b-4 的注入点，不写第二份探针
      translateRunItem: async () => { calls++; return { status: 'installed' as const } },
    }))
    await advance(daemon)
    expect(calls).toBe(0)
    const r = trRowOf(db, V1)
    expect(r.tr_attempt).toBe(1)             // 不计数
    expect(r.sub_status).toBe('handoff_translate')
    db.close()
  })

  it('🔴 runItem 抛错 → 隔离（不掀翻巡检）且按失败轨记账', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1, { trAttempt: 0 })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2, translateEnabled: () => true, fileExists: () => true,
      translateRunItem: async () => { throw new Error('LLM boom') },
    }))
    await expect(advance(daemon)).resolves.toBeUndefined()
    // 抛错必须记一次失败额度（否则一个稳定抛错的文件永远攒不满 3 次 → 每轮重跑，C13 同型）
    expect(trRowOf(db, V1).tr_attempt).toBe(1)
    expect(trRowOf(db, V1).tr_recheck_after).toBe(NOW2 + 86_400_000)
    db.close()
  })

  it('🔴 用例 11：翻译不阻塞识别/字幕——翻译跑在阶段 3 之后，且它抛错也不影响两条工作台', async () => {
    // 形态论证的可测部分（见本 describe 顶部）：断言**顺序**（识别、字幕都先跑完）+ **隔离**
    // （翻译整支炸掉，前面阶段的产出照样落库、巡检照样算成功推进时间闸）。
    const db = openDb(':memory:')
    // 一个待识别目录 + 一个待找字幕的作品 + 一个待翻译的行
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('/media/New/E01.mkv', '/media/New', 'E01.mkv', BIG, 1000, '/media/New', 1000)
    db.prepare('INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('tmdb:9', 'Sub', 'tv', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, needs_subtitle, updated_at)
                VALUES (?,?,?,?,?,?,1,?)`)
      .run('/media/Sub/E01.mkv', '/media/Sub', 'E01.mkv', BIG, 1000, 'tmdb:9', 1000)
    seedHandoff(db, V1)

    const order: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2,
      roots: ['/media'],
      listVideoFiles: () => ['/media/New/E01.mkv', '/media/Sub/E01.mkv', V1],
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      fileExists: () => true,
      translateEnabled: () => true,
      identify: {
        db,
        runIdentify: async () => { order.push('identify'); return { tmdbId: null, title: null, reason: 'noop' } },
        worker: {} as any,
      },
      subtitleWorker: async () => {
        order.push('subtitle')
        return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }
      },
      translateRunItem: async () => { order.push('translate'); throw new Error('translate exploded') },
    }))
    // 整轮巡检必须**成功**（时间闸推进），翻译的爆炸被隔离
    await expect((daemon as any).runInspection(new AbortController().signal)).resolves.toBeUndefined()
    expect(order.indexOf('translate')).toBe(order.length - 1)     // 翻译在最后
    expect(order).toContain('identify')
    expect(order).toContain('subtitle')
    db.close()
  })
})
