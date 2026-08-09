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
  const cols = ['work_id', 'needs_subtitle', 'sub_status', 'sub_attempt', 'translatable',
    'recheck_after', 'embedded_langs', 'duration_sec'].filter(c => have.has(c))
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
    // 这两列归 spec 第 3 步加，本步的 schema 里还没有。但清空名单若按"今天有哪些列"硬编码，
    // 第 3 步加完列的那天就会**静默漏清**——本仓已经三次栽在"写了某列却没人写/没人读"
    // （C12 → C35 → D17）。故实现按 PRAGMA 实际列取交集，这条用例用手工 ALTER 预演第 3 步的
    // schema，把"未来加的列会自动被清"这件事钉住，不留给下一个 task 去发现。
    db.exec('ALTER TABLE files ADD COLUMN sub_attempt INTEGER NOT NULL DEFAULT 0')
    db.exec('ALTER TABLE files ADD COLUMN translatable INTEGER')
    seedSettledFile(db, P, { mtime: 1000 })
    expect(stateOf(db, P).sub_attempt).toBe(3)   // 前置条件成立，否则下面断言无意义
    const fs = fakeFsWithProbe({ '/media': [P] }, { [P]: { mtimeMs: 5000, size: BIG } })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], ...fs.deps }))
    await scan(daemon)

    const s = stateOf(db, P)
    // sub_attempt 残留 → 新片源自带 3 次失败额度，4 次就进停牌（本该有 7 次）
    expect(s.sub_attempt).toBe(0)
    // translatable 残留 → D9 的可救性判决是基于**上一个文件**的内嵌轨算出来的，
    // 而我们刚把 embedded_langs 清成 NULL：清掉证据留下判决 = 判决永久冻结（D17 同型）
    expect(s.translatable).toBeNull()
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
