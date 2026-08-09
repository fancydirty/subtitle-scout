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
