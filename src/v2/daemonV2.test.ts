import { describe, it, expect, vi, afterEach } from 'vitest'
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
// 翻译工作台的 jobId 同源断言（GC 炸弹）：不在测试里复述目录名格式，理由同 subtitleJobId。
import { translateJobId } from './ownIds.js'
// R-F5 应有集回填：断言走**真实读出方**（媒体库页虚线小卡片就是读它），不在测试里复述
// tmdb_seasons 的 SELECT——复述等于测试自己维护第二份读实现，两份一漂移就是假绿。
import { canonicalEpisodes } from './tmdbCatalog.js'
// R-F15：换目标语言的全库重判。用**真实实现**做断言（不在测试里复述那条 UPDATE）——
// 复述等于测试自己维护第二份实现，两份一漂移就是假绿（同上面 listSubtitleQueue 的既有理由）。
import { retargetForLanguageChange } from './retarget.js'
import { SettingsRepo } from './settingsRepo.js'

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
    // C46：测试**永远不真的等**（同 probe/subtitleWorker "从不真跑"的既有约定）。
    // 不默认掉的话，每条用空守备目录建模的既有用例都会撞上 R8 重试的 1s+3s 退避——
    // 这个文件里这样的用例有一大把，整体从 2 秒涨到 64 秒。
    // 需要主循环真的按拍走的用例（维护循环那几条）显式覆盖回真 sleep。
    sleep: async () => {},
    // 2026-08-13：从写死的 `24 * 60 * 60 * 1000` 改为 import 进来的真常量。
    // INSPECT_INTERVAL_MS 一直被 import 却从未使用（清理时由 noUnusedLocals 抓出）——
    // 而这里手抄的字面量恰好就是它的值。抄一份的后果是：生产改巡检周期那天，这个文件里
    // 所有"距上次巡检不足/已满一个周期"的用例仍按旧值建模，测的是一个已经不存在的系统。
    inspectEveryMs: INSPECT_INTERVAL_MS,
    now: () => 1_000_000_000_000,
    ...overrides,
  } as any
}

describe('ScoutDaemonV2（巡检模型）', () => {
  it('冷启动（无 last_inspect_at）→ 立即跑巡检', async () => {
    const db = openDb(':memory:')
    // 注入 runInspection 到原型 spy 不方便——改为验证两件**可观察**的事：
    //   ① meta 里落了 last_inspect_at（巡检确实收官过）
    //   ② 识别队列里那一行真的被处理了（identifySpy 被调用）
    // 2026-08-13 补：②此前只写在上面这句注释里、**没有对应断言**——测试造了带活的
    // files 行、造了 identifySpy，然后只断言 ①。于是"冷启动会不会真的开工"这件事
    // 其实没被守住：把 runInspection 里的识别那一段整段注释掉，本用例照样全绿
    // （meta 仍会被写）。补上 ② 之后才名副其实。
    // 同批删除的还有两个建完即弃的局部：`const inspect = vi.fn()`（从未注入任何地方）
    // 与 `const daemon = new ScoutDaemonV2(mkDeps(db))`（真正跑的是下面的 daemon2）。
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
    expect(identifySpy).toHaveBeenCalled()
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

/** 瞬时抖动建模（C46）：把 fakeFs 的「一个根一个固定磁盘现状」扩成「一个根一串逐次响应」。
 *
 *  为什么必须扩 fakeFs 而不是另造一套：R8 两道闸门的判据分别是 walk **抛错**与 walk 返回的
 *  路径集**过完 isScannable 后为空**，两者都长在 listVideoFiles 这一个注入点上。另造一份替身
 *  就是让"瞬时故障"这条路径与既有的"持续故障"用例跑在两套磁盘模型上，哪天 fakeFs 的口径改了
 *  （比如 statFile 的默认 size 调过 isScannable 的门），只有一半用例会红。
 *
 *  第 i 次 walk 取序列第 i 项，**耗尽后固定复用最后一项**——这正好建模两种形态：
 *   · `[[], [file]]`  = 抖一下就好（生产 02:48:39 那次，20 分钟后手工 ls 完全正常）
 *   · `[[]]`          = 持续为空（挂载真的掉了，R8 保护必须原样生效） */
function flakyFakeFs(disk: Record<string, Array<string[] | 'EIO'>>) {
  const walkCalls: string[] = []
  return {
    walkCalls,
    deps: {
      listVideoFiles: (root: string) => {
        // 本根已经被调过几次（walkCalls 里同名的个数）= 这次该取序列的第几项。
        const nth = walkCalls.filter(r => r === root).length
        walkCalls.push(root)
        const seq = disk[root] ?? [[]]
        const v = seq[Math.min(nth, seq.length - 1)]
        if (v === 'EIO') throw new Error(`ENOENT: mount gone ${root}`)
        return v
      },
      statFile: (_p: string) => ({ mtimeMs: 1000, size: BIG }),
    },
  }
}

/** no-op sleep 替身：记下每次被要求等多久，但**一秒都不真的等**。
 *
 *  这是硬要求而非提速技巧：重试的默认退避是 1s + 3s，两条"持续失败"用例各真睡 4 秒就是
 *  把 daemonV2.test.ts 从 2 秒拖到十几秒；更糟的是它会诱使后来人把退避调小来"救测试"，
 *  而退避小正是会打崩 115 网盘的那个行为。 */
function fakeSleep(onCall?: () => void) {
  const waited: number[] = []
  return {
    waited,
    sleep: async (ms: number, _signal?: AbortSignal) => { waited.push(ms); onCall?.() },
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

// ─────────────────────────────────────────────────────────────────────────────
// C46：R8 两道闸门的**当场重试**（瞬时抖动 ≠ 挂载掉线）
//
// 生产实测（2026-08-11 02:48:39）：
//   02:47:55  巡检开始
//   02:48:39  scan: 守备目录扫出 0 个媒体文件，跳过删除与字幕观察（R8 挂载保护 / D23）: .../Movies
//   02:48:40  scan: scanned=1155 upserted=1155     ← 同一轮里 Anime/TV 两个根完全正常
// 而同一个 Movies 目录 20 分钟后手工 ls 完全正常（36 个作品目录、51 个文件、2s 走完、
// rclone 日志零错误），随后连做 30 轮读取零失败——所以那是**几秒级的瞬时抖动**，
// 不是持续故障。openlist WebDAV + rclone FUSE 的 readdir 在抖动时**不抛错、只返回空数组**，
// 这正是 R8 第二道闸要防的那个最阴的形态。
//
// R8 保护本身做对了（没把"看起来是空的"当成"文件都被删了"去清库）。缺陷在于它只是
// `continue` —— 本轮跳过、等 24 小时后的下一轮巡检，而故障几秒后就自愈了。后果：
//  ① 一次几秒的抖动 = 这个根**一整天**不被处理（日巡检模型下抖动被放大 ~17000 倍）
//  ② 更糟：若每天巡检那一刻恰好都抖一下，这个根**永远**不会被处理，
//     而日志只会平静地说"跳过"，用户看不出任何异常（本仓已因"日志把中间量说成结论量"
//     栽过三次，见 probe ok=N / judge 总数当需字幕数 / mismatch 截断）
//
// 这批用例的重点是**两个方向都不能塌**：既要让瞬时抖动当场恢复，又不许因此削弱 R8——
// 重试全部失败后行为必须与改动前逐字一致（跳过删除、跳过字幕观察、不清库、打日志）。
// ─────────────────────────────────────────────────────────────────────────────

describe('ScoutDaemonV2.scanOnce · C46 R8 闸门的当场重试', () => {
  it('🔴 瞬时空列表（第 1 次空、第 2 次正常）→ 重试后拿到文件并正常入库，不走 R8 跳过', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    // 生产形态：readdir 不抛错，只返回空数组，几秒后自愈。
    const fs = flakyFakeFs({ '/media': [[], ['/media/Show/E01.mkv']] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 入库断言（真实收益）：这一行本来要等 24 小时才会出现。
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    // 机制断言：确实重试了一次（走了 2 次 walk），且退避真的被请求过。
    expect(fs.walkCalls).toEqual(['/media', '/media'])
    expect(sl.waited).toHaveLength(1)
    // 日志断言：用户必须能看出"我的挂载在抖"。只入库不吭声的话，抖动会一直恶化到
    // 重试也救不回来的那天才第一次被发现。
    expect(logs.join('\n')).toMatch(/第 1 次重试成功/)
    // 且**绝不能**同时打那条 R8 跳过日志——本轮根本没跳过。
    expect(logs.join('\n')).not.toMatch(/跳过删除/)
    db.close()
  })

  it('🔴 瞬时抛错 EIO（第 1 次抛、第 2 次正常）→ 重试后成功（第一道闸同样要覆盖）', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': ['EIO', ['/media/Show/E01.mkv']] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    expect(fs.walkCalls).toEqual(['/media', '/media'])
    expect(logs.join('\n')).toMatch(/第 1 次重试成功/)
    expect(logs.join('\n')).not.toMatch(/跳过删除/)
    db.close()
  })

  it('🔴 瞬时故障发生在第 2 次（第 1、2 次空，第 3 次正常）→ 第 2 次重试仍能救回来', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': [[], 'EIO', ['/media/Show/E01.mkv']] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    expect(fs.walkCalls).toHaveLength(3)
    // 退避必须**递增**（1s → 3s）：等长间隔在"网盘正在限流"这个最常见的抖动成因下
    // 就是拿同样的节奏再撞两次，而递增给了对端喘息窗口。
    expect(sl.waited).toEqual([1000, 3000])
    expect(logs.join('\n')).toMatch(/第 2 次重试成功/)
    db.close()
  })

  it('🔴 持续为空（重试都失败）→ 仍然走 R8 保护：跳过删除、不清库、打日志', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const logs: string[] = []
    // 序列只有一项 → 耗尽后固定复用，即"每次都空"（挂载真的掉了）。
    const fs = flakyFakeFs({ '/media': [[]] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 这条是本批用例存在的**首要理由**：防止"为了修重试把 R8 保护改坏"。
    // 一次删光该根全库是这个项目最严重的可能故障，重试是它上面的增益、不是替代品。
    expect(rowsInDb(db)).toEqual(alive(['/media/Show/E01.mkv', '/media/Show/E02.mkv']))
    expect(logs.join('\n')).toMatch(/跳过删除/)
    // 日志必须说清"已经重试过了"——否则运维看到"跳过"会以为系统没努力过，
    // 而真相是挂载连着 3 次读取都是空的（那是真掉线，该去看 rclone 了）。
    expect(logs.join('\n')).toMatch(/已重试 2 次/)
    expect(fs.walkCalls).toHaveLength(3)   // 首次 + 2 次重试，绝不多于此
    db.close()
  })

  it('🔴 持续抛错 EIO → 同上：R8 第一道闸原样生效', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': ['EIO'] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(rowsInDb(db)).toEqual(alive(['/media/Show/E01.mkv', '/media/Show/E02.mkv']))
    expect(logs.join('\n')).toMatch(/守备目录不可访问/)
    expect(logs.join('\n')).toMatch(/已重试 2 次/)
    // 抛错形态的原始错因（EIO 文本）不许在重试包装里被吃掉——那是排障的唯一线索。
    expect(logs.join('\n')).toMatch(/mount gone/)
    expect(fs.walkCalls).toHaveLength(3)
    db.close()
  })

  it('🔴 持续失败的根**仍然**不做字幕观察（重试不许绕过 D23 的联动）', async () => {
    const db = openDb(':memory:')
    const V = '/media/Show/E01.mkv'
    seedRow(db, V, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const fs = flakyFakeFs({ '/media': [[]] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 回退成 NULL = 下一轮为这一集重跑一整个付费字幕 agent session（D23 的原始伤害）。
    expect(subStatusOf(db, V)).toBe('covered')
    expect(sub.calls).toEqual([])
    db.close()
  })

  it('🔴 正常情况（第一次就拿到文件）→ 零重试、零退避（别白白放大慢挂载的压力）', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': [['/media/Show/E01.mkv']] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    // 这条是性能红线：生产上一个守备目录是 115 网盘的 rclone FUSE 挂载，
    // 无条件重试 = 每轮巡检对每个根多发两次全量 readdir（Movies 那次实测 44s 一趟）。
    expect(fs.walkCalls).toEqual(['/media'])
    expect(sl.waited).toEqual([])
    expect(logs.join('\n')).not.toMatch(/重试/)
    db.close()
  })

  it('🔴 重试期间收到停止信号 → 立刻收手，不再发第二次重试（docker stop 不该等满退避）', async () => {
    const db = openDb(':memory:')
    seedFiles(db, ['/media/Show/E01.mkv'])
    const ctrl = new AbortController()
    // 在第一次退避里 abort：真实剧本是运维 docker stop 时 daemon 正卡在 3s 退避上。
    const sl = fakeSleep(() => ctrl.abort())
    const fs = flakyFakeFs({ '/media': [[]] })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep,
    }))
    await (daemon as any).scanOnce(ctrl.signal)
    // 不加信号的话这个根会走满 3 次 walk（见上面"持续为空"那条）。abort 落在第一次退避里
    // → 退避当场返回、剩下的重试整个不发 → 只有最初那 1 次 walk。
    expect(fs.walkCalls).toHaveLength(1)
    // 收手也**必须**是 R8 那条安全路径：中断绝不能变成"拿着空快照去做差集"。
    expect(rowsInDb(db)).toEqual(alive(['/media/Show/E01.mkv']))
    db.close()
  })

  it('🔴 一个根抖动不拖累另一个根：A 根重试后成功，B 根照常一次过', async () => {
    const db = openDb(':memory:')
    const logs: string[] = []
    const fs = flakyFakeFs({
      '/media/tv': [[], ['/media/tv/Show/E01.mkv']],       // 抖一下
      '/media/movies': [['/media/movies/A/a.mkv']],        // 正常
    })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media/tv', '/media/movies'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual(['/media/movies/A/a.mkv', '/media/tv/Show/E01.mkv'])
    // 退避只为抖动的那个根付出，正常的根一次 walk 走完。
    expect(fs.walkCalls).toEqual(['/media/tv', '/media/tv', '/media/movies'])
    expect(sl.waited).toHaveLength(1)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C47：部分读取的比例守卫（R8 第三道闸）
//
// 生产实测（2026-08-11 04:07）——**真实数据损失**，不是推演：
//   scan: 删除磁盘上已消失的文件 572 行（R7）: .../Mediary Scout/TV
//   scan: scanned=720 upserted=135 skipped=2
// 上一轮扫到 1155，这一轮只读出 720，差集 572 行被当成"磁盘上已消失"删掉了——
// 而磁盘上一个文件都没少（同一小时内手工 ls 反复在"正常/空"之间横跳：
// 10:47 Movies 36 目录 → 02:48 扫描读出空 → 11:10 读出 51 → 11:35 读出 351 → 11:40 读出 0）。
//
// R8 原有两道闸只覆盖两种形态：walk 抛错、整根扫出 0 个。**部分成功**（720/1155）这第三种
// 形态没有任何防线——它长得跟"用户真的删了 572 个文件"一模一样，被当成可信事实拿去做差集。
//
// ★ 两个必须在测试里钉死的反直觉结论（都是本次设计时算出来、与最初直觉相反的）：
//
//  ① 阈值不能按"删除比例"定，必须按**存活比例**定。
//     572/1292 ≈ 44% 看起来"删了将近一半"，但守卫的判据是 seen/existing = 720/1292 = 55.7%
//     ——**高于 50%**。若按最初设想的"低于 50% 才拦"，这次生产事故会原样再发生一次。
//     这两个量方向相反，混淆一次就等于守卫完全失效，故用例直接用生产的绝对数字建模。
//
//  ② 纯比例守卫会把"用户真的删了一大批"**永久锁死**。
//     库 351 / 盘 200 → 57% → 拦下不删 → 下一轮库还是 351、盘还是 200 → 又拦 → 永远。
//     日志每轮平静地说"跳过删除"，用户看不出任何异常——正是 D18/C46 栽过的那类静默失效。
//     解法不加配置、不落持久状态：**再读一次**。真实删除在两次读取间是稳定的，
//     FUSE 抖动不是。据此三分：恢复→照常用；两次同数→坐实为真实删除→照删；
//     两次不同→读取自相矛盾→跳过该根。
// ─────────────────────────────────────────────────────────────────────────────

/** 造 n 个连着编号的剧集路径（比例守卫的用例都要成百上千行，手写不现实）。 */
function epPaths(root: string, n: number, from = 1): string[] {
  return Array.from({ length: n }, (_, i) => `${root}/Show/E${String(from + i).padStart(4, '0')}.mkv`)
}

describe('ScoutDaemonV2.scanOnce · C47 部分读取的比例守卫（R8 第三道闸）', () => {
  it('🔴 生产事故重演：库里 1292 行、本轮只读出 720（55.7%）→ 拦下删除，572 行一个不许掉', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 1292)
    seedFiles(db, all)
    const logs: string[] = []
    // 部分读取**稳定复现**同一个 720（序列耗尽后复用最后一项）——这是最凶的形态：
    // 确认性重读也拿到 720 的话，"两次同数"的放行分支会把它当成真实删除。
    // 所以这里的 720 必须由**不同的**再读结果来否定，见下一条用例；本条先钉最基本的：
    // 只要触发了守卫，572 行就绝不能在"第一次读到 720"这个事实上被删掉。
    const fs = flakyFakeFs({ '/media': [all.slice(0, 720), all] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 核心断言：一行都没少。用 rowsInDb 而不是 pathsInDb——被误删的行会被同一轮的 upsert
    // 用同一个路径插回来，只看路径完全看不出差别，work_id 丢了才是被删过的凭据。
    expect(rowsInDb(db)).toEqual(alive(all))
    // 日志必须给得出数字，让人当场判断这次拦截对不对（本仓已栽过三次"日志把中间量说成
    // 结论量"：probe ok=N 数的是没抛异常、judge 把总数说成需字幕数、mismatch 截断）。
    const joined = logs.join('\n')
    expect(joined).toMatch(/720/)      // 扫到多少
    expect(joined).toMatch(/1292/)     // 库里多少
    expect(joined).toMatch(/55\.7%/)   // 比例
    expect(joined).toMatch(/80%/)      // 阈值
    db.close()
  })

  it('🔴 两次读取给出**不同**的部分结果（720 → 890）→ 读取自相矛盾，跳过该根不删', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 1292)
    seedFiles(db, all)
    const logs: string[] = []
    // 用户原话点名的最坏情况："也可能每次都是不同的部分（更糟）"。
    // 两次都低于阈值且互不相同 → 没有任何一个数字可信 → 唯一安全的处置是整根跳过。
    const fs = flakyFakeFs({ '/media': [all.slice(0, 720), all.slice(0, 890)] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(rowsInDb(db)).toEqual(alive(all))
    expect(logs.join('\n')).toMatch(/跳过删除/)
    db.close()
  })

  it('🔴 首次入库（库里 0 行 → 读到 1155 行）→ 不是骤降，绝不许拦', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 1155)
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': [all] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 0 行既有 → 比例的分母为 0。写成 seen/existing 会得到 Infinity 或 NaN，
    // 而 NaN 参与的任何比较都是 false —— 究竟是"永远拦"还是"永远放"取决于比较写法，
    // 两种写错法都不会在别的用例里暴露。故首次入库单独钉一条。
    expect(pathsInDb(db)).toEqual([...all].sort())
    expect(logs.join('\n')).not.toMatch(/跳过删除/)
    // 且不该为它付出确认性重读的代价（115 FUSE 上一趟 readdir 实测 44s）。
    expect(fs.walkCalls).toEqual(['/media'])
    db.close()
  })

  it('🔴 用户真删了一整季（库 351、盘 331，94.3%）→ 正常删除，不许误拦', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 351)
    seedFiles(db, all)
    const logs: string[] = []
    const kept = all.slice(0, 331)          // 删掉 20 集 = 一整季
    const fs = flakyFakeFs({ '/media': [kept] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 守卫的存在价值有一半在这条：拦得住灾难但顺手把用户的正常使用也锁死的话，
    // 用户会去关掉整个删除逻辑，那比没有守卫更糟。
    expect(pathsInDb(db)).toEqual([...kept].sort())
    expect(logs.join('\n')).toMatch(/删除磁盘上已消失的文件 20 行/)
    // 没触发守卫 → 不该有确认性重读。
    expect(fs.walkCalls).toEqual(['/media'])
    db.close()
  })

  it('🔴 用户真删了一大批且两次读取一致（库 351、盘两次都是 200）→ 坐实为真实删除，照删不误', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 351)
    seedFiles(db, all)
    const logs: string[] = []
    const kept = all.slice(0, 200)          // 57% —— 低于阈值，守卫会触发
    // 序列只有一项 → 每次读都是同一批 200 个。这正是"用户真的删了 151 个文件"的形态。
    const fs = flakyFakeFs({ '/media': [kept] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 这条防的是纯比例守卫的**永久死锁**：库 351/盘 200 每一轮都是 57%，
    // 若只看比例就会每轮都拦、库永远停在 351、日志每轮平静地说"跳过删除"。
    // 确认性重读把"真实删除"与"抖动"分开：两次读到同一批 → 这是稳定事实 → 删。
    expect(pathsInDb(db)).toEqual([...kept].sort())
    expect(logs.join('\n')).toMatch(/删除磁盘上已消失的文件 151 行/)
    // 代价必须只在守卫触发时付：触发了 → 恰好一次确认性重读，绝不多于此。
    expect(fs.walkCalls).toEqual(['/media', '/media'])
    db.close()
  })

  it('🔴 确认性重读恢复到完整（720 → 1292）→ 用完整的那次入库并正常删除（顺带救回这一轮）', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 1292)
    seedFiles(db, all.slice(0, 1291))       // 库里少一行，验证"用重读结果"而不是"跳过了事"
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': [all.slice(0, 720), all] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    // 恢复后不该退化成"本轮什么也不做"：那等于把一次几秒的抖动放大成一整天的停摆
    // （C46 修的正是这个放大效应，新守卫不许把它请回来）。
    expect(pathsInDb(db)).toEqual([...all].sort())
    expect(logs.join('\n')).not.toMatch(/跳过删除/)
    db.close()
  })

  it('🔴 被守卫拦下的根**不做字幕观察**（D23 联动，与现有两道闸完全一致）', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 1292)
    // 全库都是"指纹与磁盘一致 + 已到复检点"的行 → 只要守卫没拦住，B 档就会去观察它们。
    for (const p of all) seedRow(db, p, { sub_status: 'covered', sub_recheck_at: NOW - 1 })
    const sub = fakeSubtitleDisk([])
    const fs = flakyFakeFs({ '/media': [all.slice(0, 720), all.slice(0, 890)] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, fileExists: sub.fileExists,
    }))
    await scan(daemon)
    // 只跳过删除却仍做观察 = 拿一份不可信的磁盘快照去把 covered 打回 NULL，
    // 下一轮就是为这 1292 集重跑一整轮付费字幕 agent session（D23 的原始伤害）。
    expect(subStatusOf(db, all[0])).toBe('covered')
    expect(sub.calls).toEqual([])
    db.close()
  })

  it('🔴 全部消失（库 351、盘 0）→ 仍然走既有的 seen.size===0 那道闸，不是新守卫', async () => {
    const db = openDb(':memory:')
    const all = epPaths('/media', 351)
    seedFiles(db, all)
    const logs: string[] = []
    const fs = flakyFakeFs({ '/media': [[]] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, log: (m: string) => logs.push(m),
    }))
    await scan(daemon)
    expect(rowsInDb(db)).toEqual(alive(all))
    // 归属断言：0 个必须由 R8 第二道闸接住（它带 1s+3s 退避重试），**不能**滑进新守卫
    // ——新守卫的"两次同数就删"分支在 0/0 上会得出"用户清空了这个根"并删光全库。
    expect(logs.join('\n')).toMatch(/扫出 0 个媒体文件/)
    expect(logs.join('\n')).not.toMatch(/骤降/)
    expect(sl.waited).toEqual([1000, 3000])
    db.close()
  })

  it('🔴 一个根被守卫拦下，另一个正常的根照常删除（逐根隔离，D1 不许被新守卫破坏）', async () => {
    const db = openDb(':memory:')
    const tv = epPaths('/media/tv', 1292)
    const movies = epPaths('/media/movies', 100)
    seedFiles(db, [...tv, ...movies])
    const fs = flakyFakeFs({
      '/media/tv': [tv.slice(0, 720), tv.slice(0, 890)],   // 抖 → 拦
      '/media/movies': [movies.slice(0, 99)],              // 真删 1 个 → 照删
    })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media/tv', '/media/movies'], ...fs.deps, sleep: sl.sleep,
    }))
    await scan(daemon)
    expect(pathsInDb(db)).toEqual([...movies.slice(0, 99), ...tv].sort())
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Task ③：守备目录健康度落库（media_roots.last_error / last_checked_at）
//
// R8 三道闸今天的两个出口（日志 + SSE health）都是**瞬时**的：日志没人看，SSE 只推给当时
// 正连着的订阅者。于是"这个根现在健不健康"在进程外没有任何持久载体——2026-08-11 04:07 那次
// C47 拦截，事后完全查不出"哪个根、什么时候、拦下了多少"。这两列把闸门的判决落进状态机。
//
// 这批用例钉的是**调用方真的在写**，不是"UPDATE 语句本身能跑"。教训来自 Task ⓪：那次
// 4 条测试全绿，把 7 个生产写入点全删光却无一变红——测试只测了工具，没锁住调用方。
// 故这里**一条都不直接调 markRoot**，全部经由 scanOnce 的真实故障注入驱动。
//
// ★ 四种结局各钉一条，外加两条结构性的：
//   ① 抛 EIO      → R8 第一道闸（`!read.ok` 且 error !== undefined）
//   ② 返回 []     → R8 第二道闸（`!read.ok` 且 error === undefined）
//   ③ 读到 40%    → C47 第三道闸分支 ③（生产 04:07 真实走的那一档）
//   ④ 恢复正常    → last_error **清回 NULL**（设计文档「教训九」点名的缺失点：
//                    只写不清 = 用户修好挂载后界面永远显示红的）
//   ⑤ last_checked_at 是"上次**检查**时间"不是"上次成功时间"——失败轮也必须推进
//   ⑥ D20 嵌套那处 continue 也真的走到 finally（三处 continue 的到达性证明）
//
// ⚠️ 全部用**注入式**故障建模（listVideoFiles 替身），不碰任何真实挂载：umount 只触发
//    第一道闸，而生产真出事那次走的是第三道 C47，用 umount 根本验不到。
// ─────────────────────────────────────────────────────────────────────────────

/** 往 media_roots 里放一个根。健康度两列刻意不填 —— NULL/NULL = "从没扫过"，
 *  正是 db.ts v41 论证里那个有意义的第三态，也是每条用例的干净起点。 */
function seedRoot(db: ReturnType<typeof openDb>, path: string): void {
  db.prepare('INSERT INTO media_roots (path, type, added_at) VALUES (?,?,?)').run(path, 'local', 1)
}

/** 读回一个根的健康度判决。断言直接打在**库里的行**上，不打在任何中间量上：
 *  这两列存在的全部意义就是"进程外可查"，只有查库才是真的在验它。 */
function rootHealth(
  db: ReturnType<typeof openDb>,
  path: string,
): { last_error: string | null; last_checked_at: number | null } {
  return db.prepare('SELECT last_error, last_checked_at FROM media_roots WHERE path = ?').get(path) as
    { last_error: string | null; last_checked_at: number | null }
}

describe('ScoutDaemonV2.scanOnce · Task ③ 守备目录健康度落库（media_roots.last_error / last_checked_at）', () => {
  it('🔴 ① walk 抛 EIO（R8 第一道闸）→ last_error 落库，原始错因不许被重试包装吃掉', async () => {
    const db = openDb(':memory:')
    seedRoot(db, '/media')
    seedFiles(db, ['/media/Show/E01.mkv'])
    const events: any[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': 'EIO' }),
      emit: (e: any) => events.push(e),
    }))
    await scan(daemon)

    const h = rootHealth(db, '/media')
    // 判决落库，且说的是**这一道闸**的事（不是"扫出 0 个"也不是"行数骤降"）。
    expect(h.last_error).toMatch(/守备目录读取失败/)
    // 原始错因是排障的唯一线索。只断言"非空"的话，把 String(read.error) 换成常量
    // 也照样绿——那正是生产 04:07 事后"查不出发生了什么"的成因。
    expect(h.last_error).toMatch(/mount gone \/media/)
    // 重试次数：R8 之上的增益。不带的话运维会以为系统没努力过。
    expect(h.last_error).toMatch(/已重试 2 次/)
    // 与 SSE health 事件**同源**：两个出口说同一件事，漂了就会出现
    // "SSE 说读取失败、库里说行数骤降"这种自相矛盾的排障现场。
    const health = events.filter(e => e.type === 'health').map(e => e.message).join('\n')
    expect(health).toMatch(/守备目录读取失败，本轮跳过（已重试 2 次）/)
    expect(h.last_error).toMatch(/守备目录读取失败，本轮跳过（已重试 2 次）/)
    // 时刻同轮写入（mkDeps 注入的 now）。
    expect(h.last_checked_at).toBe(NOW)
    // 闸门本体不许被这次记账削弱：一行都没掉。
    expect(rowsInDb(db)).toEqual(alive(['/media/Show/E01.mkv']))
    db.close()
  })

  it('🔴 ② walk 返回 []（R8 第二道闸，FUSE 掉线最阴的形态）→ last_error 落库', async () => {
    const db = openDb(':memory:')
    seedRoot(db, '/media')
    seedFiles(db, ['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    const events: any[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': [] }),
      emit: (e: any) => events.push(e),
    }))
    await scan(daemon)

    const h = rootHealth(db, '/media')
    expect(h.last_error).toMatch(/守备目录扫出 0 个媒体文件，疑似挂载异常，本轮跳过（已重试 2 次）/)
    // 归属断言：这一档**不能**被写成第一道闸的文案。两道闸判据不同（抛错 vs 读出空），
    // 混成一句话就等于库里的判决无法区分"挂载报错"与"挂载装死"，而后者才是 115 的常态形态。
    expect(h.last_error).not.toMatch(/读取失败/)
    expect(h.last_checked_at).toBe(NOW)
    const health = events.filter(e => e.type === 'health').map(e => e.message).join('\n')
    expect(health).toMatch(/守备目录扫出 0 个媒体文件，疑似挂载异常/)
    expect(rowsInDb(db)).toEqual(alive(['/media/Show/E01.mkv', '/media/Show/E02.mkv']))
    db.close()
  })

  it('🔴 ③ 只读到 40% 且两次不一致（C47 第三道闸 / 生产 04:07 真实走的那一档）→ last_error 带上判断依据的全部数字', async () => {
    const db = openDb(':memory:')
    seedRoot(db, '/media')
    const all = epPaths('/media', 1000)
    seedFiles(db, all)
    const events: any[] = []
    // 40% → 远低于 80% 阈值 → 守卫触发；重读拿到**另一个**低数字 → 分支 ③（两次自相矛盾）。
    // 这正是用户点名的最坏情况"也可能每次都是不同的部分（更糟）"。
    const fs = flakyFakeFs({ '/media': [all.slice(0, 400), all.slice(0, 500)] })
    const sl = fakeSleep()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fs.deps, sleep: sl.sleep, emit: (e: any) => events.push(e),
    }))
    await scan(daemon)

    const h = rootHealth(db, '/media')
    expect(h.last_error).toMatch(/守备目录行数骤降且两次读取不一致，已拦下删除/)
    // facts 原样带进去：那串数字是判断"这次拦截对不对"的**全部**依据。只断言前半句人话的话，
    // 把 facts 丢掉照样绿 —— 而丢掉 facts 就退回到了 04:07 那天"查不出拦下了多少"的原点。
    expect(h.last_error).toMatch(/扫到 400/)      // 本轮扫到多少
    expect(h.last_error).toMatch(/库里 1000/)     // 分母（与删除作用域同源）
    expect(h.last_error).toMatch(/40\.0%/)        // 存活比例（★ 不是删除比例）
    expect(h.last_error).toMatch(/80%/)           // 阈值
    expect(h.last_error).toMatch(/重读扫到 500/)  // 确认性重读的结果
    expect(h.last_checked_at).toBe(NOW)
    // 同源：SSE 与库里说同一件事。
    const health = events.filter(e => e.type === 'health').map(e => e.message).join('\n')
    expect(health).toMatch(/守备目录行数骤降且两次读取不一致，已拦下删除/)
    // 闸门本体：1000 行一个不许掉。
    expect(rowsInDb(db)).toEqual(alive(all))
    db.close()
  })

  it('🔴 ④【教训九】挂载修好后 → last_error 被**清回 NULL**（只写不清 = 界面永远显示红的）', async () => {
    const db = openDb(':memory:')
    seedRoot(db, '/media')
    // fakeFs 每次调用现读 disk 对象 → 直接改这个对象就是"用户把挂载修好了"。
    const disk: Record<string, string[] | 'EIO'> = { '/media': 'EIO' }
    let now = NOW
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs(disk), now: () => now,
    }))

    // 第 1 轮：挂载掉线 → 判决落库。先钉住这一步，否则第 2 轮的"清空"可能只是
    // "这一列从来就没被写过"，断言 NULL 会在**功能完全不存在**时同样为真（假绿）。
    await scan(daemon)
    expect(rootHealth(db, '/media').last_error).toMatch(/守备目录读取失败/)

    // 第 2 轮：用户重新挂上了 115。
    disk['/media'] = ['/media/Show/E01.mkv']
    now = NOW + 24 * 60 * 60 * 1000
    await scan(daemon)

    const h = rootHealth(db, '/media')
    // ★ 本任务点名的缺失点：成功路径必须**主动清空**。写成"只在出错时才发 UPDATE"的话
    // 这里会留着上一轮的 /守备目录读取失败/，用户修好挂载后界面永远显示红的。
    expect(h.last_error).toBeNull()
    // 且时刻推进到了这一轮 —— 证明"NULL"是本轮真写进去的，不是上一轮没写过。
    expect(h.last_checked_at).toBe(NOW + 24 * 60 * 60 * 1000)
    // 恢复轮本身正常干活（清空不是靠"这一轮什么也没做"换来的）。
    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv'])
    db.close()
  })

  it('🔴 ⑤ last_checked_at 是"上次**检查**时间"不是"上次成功时间"：失败轮也必须推进', async () => {
    const db = openDb(':memory:')
    seedRoot(db, '/media')
    const disk: Record<string, string[] | 'EIO'> = { '/media': ['/media/Show/E01.mkv'] }
    let now = NOW
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs(disk), now: () => now,
    }))

    // 轮 1 成功 → 立一个基准时刻。
    await scan(daemon)
    expect(rootHealth(db, '/media')).toEqual({ last_error: null, last_checked_at: NOW })

    // 轮 2 掉线 → 时刻仍须推进。若实现写成"只有成功才更新时刻"，运维看到的就是
    // "上次检查：昨天"，而系统其实每轮都在检查、每轮都失败 —— 那是一条与事实相反的记录，
    // 且会让人以为巡检本身停了，去排查一个根本不存在的问题。
    disk['/media'] = 'EIO'
    now = NOW + 1000
    await scan(daemon)
    const h2 = rootHealth(db, '/media')
    expect(h2.last_error).toMatch(/守备目录读取失败/)
    expect(h2.last_checked_at).toBe(NOW + 1000)

    // 轮 3 仍然掉线、时刻再推进一次 —— 钉死"失败轮推进"不是靠轮 1 那次成功的残留。
    now = NOW + 2000
    await scan(daemon)
    expect(rootHealth(db, '/media').last_checked_at).toBe(NOW + 2000)
    db.close()
  })

  it('🔴 ⑥ D20 嵌套根那处 continue 同样走到 finally（三处 continue 的到达性证明）', async () => {
    const db = openDb(':memory:')
    // 存量嵌套是真实可达状态：第 1a 步的 detectNestedRoots 只告警、不改用户配置。
    seedRoot(db, '/media')
    seedRoot(db, '/media/115')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media', '/media/115'],
      // 两个根的 walk 都**成功**（嵌套这条形态的特征就是"读得到，但作用域不可信"）→
      // 控制流必然走到 D20 那处 continue，而不是被前两道闸提前接走。
      ...fakeFs({ '/media': ['/media/tv/Show/E01.mkv'], '/media/115': ['/media/115/Anime/E01.mkv'] }),
    }))
    await scan(daemon)

    // 到达性凭据：last_checked_at 只由 finally 里那条 UPDATE 写。它从 NULL 变成 NOW，
    // 就证明这两个根**都**在 continue 之后仍然执行了 finally。把健康度记账挪回循环末尾
    // （最直觉的写法）时，这两行会原样停在 NULL —— 这条用例就是那种写法的照妖镜。
    expect(rootHealth(db, '/media').last_checked_at).toBe(NOW)
    expect(rootHealth(db, '/media/115').last_checked_at).toBe(NOW)
    // D20 分支同样要写 rootError（Task ③ 审计补的第四道判决）。
    //
    // 这条断言的来历值得记：上一版实现**不写**，于是三个出口两种结论——日志与 skippedRoots
    // 都说"这个根整轮停摆"，唯独库里说它健康。写这批测试的 subagent 发现了，但按
    // "不许扩大范围"如实钉住了当时的 `toBeNull()`，并写明"这不是背书"。
    // 那个做法是对的：它逼着改这一支的人必须同时改断言，不给静默漂移留缝。
    // 我（编排方）随后裁决补上 rootError——判据是**用户后果相同**（跳过删除与字幕观察、
    // 下一轮 24h 后），成因不同不改变判决，只改变文案指向（这条指向"怎么修"）。
    expect(rootHealth(db, '/media').last_error).toMatch(/嵌套关系/)
    expect(rootHealth(db, '/media').last_error).toMatch(/去掉其中一个/)
    // 嵌套的两边都要记——用户从任一边看过去都该知道这一轮没跑
    expect(rootHealth(db, '/media/115').last_error).toMatch(/嵌套关系/)
    db.close()
  })

  it('🔴 ⑦ 循环体里抛未预期异常 → 判决记成"出事了"再原样 rethrow（绝不能被记成健康）', async () => {
    const db = openDb(':memory:')
    seedRoot(db, '/media')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv'],
      // walk **成功**，炸在它后面 —— 这条路径不属于 R8 三道闸的任何一道，
      // 走的是 catch 那一支（生产上的对应形态：upsert 撞库、deleteMissing 抛错）。
      statFile: () => { throw new Error('boom: stat exploded') },
    }))

    // 控制流必须与本改动之前**逐字一致**：异常照旧向上传播（走 run() 的 health ④）。
    // 记账是增益，不许顺手把异常吞掉变成"静默跳过这个根"。
    await expect(scan(daemon)).rejects.toThrow(/boom: stat exploded/)

    const h = rootHealth(db, '/media')
    // 若 catch 里不记一笔，rootError 仍是 null → finally 把这一行写成**健康**，
    // 而整轮巡检随即失败：库里留下一条与事实正好相反的记录，且没有任何别的地方能推翻它。
    expect(h.last_error).toMatch(/扫描本根时异常/)
    expect(h.last_error).toMatch(/boom: stat exploded/)
    // 抛异常这条路径上 finally 一样要跑（continue / throw / 正常结束三种离开方式全覆盖）。
    expect(h.last_checked_at).toBe(NOW)
    db.close()
  })

  it('🔴 ⑧ 无 media_roots 表的库：记账整体失败但**绝不掀翻扫描**（审计 🔴-1 抓到的真回归）', async () => {
    // ── 这条用例的来历 ──────────────────────────────────────────────────────
    // 上一版把 `db.prepare('UPDATE media_roots ...')` 放在循环外、保护性 try **之外**。
    // better-sqlite3 在 **prepare 阶段就解析 SQL**（实测：无表时 prepare 当场抛
    // `SqliteError: no such table: media_roots`），于是那层 try/catch 声称的
    // 「记账失败不许掀翻整轮扫描」**保护不到自己**——审计端到端实测 Task ③ 之前 survived、
    // 之后 THREW。这是本 task 引入的真回归，不是既有债务。
    //
    // 审计还指出：针对这层保护的变异当时是 **0 红**（零覆盖），所以补这一条。
    // 判据不是"没抛错"，而是**扫描的正常产物照旧落库**——只有这样才能区分
    // "隔离成功"与"整个扫描被跳过了但异常被吞了"。
    const db = openDb(':memory:')
    // 刻意**不** seedRoot：openDb 建了 media_roots 表，这里把它整个删掉，
    // 模拟 v11 及更早的旧库（那时还没有这张表）。
    db.exec('DROP TABLE media_roots')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: 200 * 1024 * 1024 }),
      fileExists: () => true,
    }))
    await expect(scan(daemon)).resolves.not.toThrow()
    // 真正的判据：扫描的产物在库里。若只断言"不抛错"，那么"整轮被静默跳过"也会通过。
    const n = (db.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n
    expect(n).toBe(1)
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
  // 2026-08-13：取值从写死的 `2` 改为 `RETRY_LATER_STREAK_CAP - 1`。注释一直说的是"CAP-1"，
  // 而常量虽已 import 却从未被用（清理时由 noUnusedLocals 抓出）。写死的 2 会在 CAP 调值那天
  // 静默失去"最危险取值"的语义——用例照样绿，但它守的东西已经变了。
  if (have.has('sub_retry_streak')) row.sub_retry_streak = RETRY_LATER_STREAK_CAP - 1
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
    expect(stateOf(db, P).sub_retry_streak).toBe(RETRY_LATER_STREAK_CAP - 1)  // 前置条件成立，否则本用例是空转的假绿
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

// ─────────────────────────────────────────────────────────────────────────────
// R-F15：目标语言可切换性（用户点名的架构级缺口）
//
// 用户原话：「咱们这个项目之所以没有硬编码锚定中文，就是因为要考虑用户不止中国人，可能会是
// 美国人想要英文字幕的情况」「每个资源有哪些字幕，需要在一开始就记录下来，这样在用户更换
// 目标语言后，数据库能反应过来」。
//
// 三件改动的**职责切分**（本仓栽过 6 次「加了能力却没定谁写/谁读/谁触发」，故逐列写死）：
//  · files.skip_reason  —— 写：judgeOnce（与 needs_subtitle 同一条 UPDATE）。读：媒体库页
//    第三种标记 ◇。何时写全：judge 谓词 `needs_subtitle IS NULL` 覆盖的全部行。
//  · files.sidecar_langs —— 写：observeSubtitle（扫描独占，同 sub_status 的 R24 口径）。
//    读：换目标语言时的 sub_status 重导出。何时写全：A 档新增/指纹变化 + B 档 7 天轮转。
//  · 触发 —— updateSettings 里 target_languages **真的变了**才跑（幂等）。
// ─────────────────────────────────────────────────────────────────────────────
function skipReasonOf(db: ReturnType<typeof openDb>, path: string): string | null {
  return (db.prepare('SELECT skip_reason FROM files WHERE path = ?').get(path) as { skip_reason: string | null }).skip_reason
}

function sidecarLangsOf(db: ReturnType<typeof openDb>, path: string): string[] | null {
  const raw = (db.prepare('SELECT sidecar_langs FROM files WHERE path = ?').get(path) as { sidecar_langs: string | null }).sidecar_langs
  return raw === null ? null : JSON.parse(raw)
}

/** 造一行"已识别、待 judge"的文件（work_id 已绑、needs_subtitle still NULL）。 */
function seedForJudge(
  db: ReturnType<typeof openDb>, path: string,
  opts: { originLang?: string | null; embedded?: string[] | null } = {},
): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  db.prepare(`INSERT OR REPLACE INTO works (id, title, media_type, origin_lang, created_at, updated_at)
              VALUES ('tmdb:42','T','tv',?,1,1)`).run(opts.originLang ?? 'en')
  db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id,
                                 embedded_langs, needs_subtitle, updated_at)
              VALUES (?,?,?,?,?,?,'tmdb:42',?,NULL,1000)`)
    .run(path, dir, path.slice(path.lastIndexOf('/') + 1), BIG, 1000, dir,
      opts.embedded === undefined || opts.embedded === null ? null : JSON.stringify(opts.embedded))
}

describe('🔴 R-F15 缺口① · judge 把 verdict.reason 落进 files.skip_reason', () => {
  // 修复前 daemonV2 只用 verdict.needs，reason 算出来就扔——生产库 1026 个 needs_subtitle=0
  // 的文件分不出"本来就是目标语言"与"有内嵌字幕轨"，媒体库页第三种标记拿不到数据。
  it.each([
    ['origin-skip（片子本来就是目标语言）', { originLang: 'zh', embedded: null }, 0, 'origin-skip'],
    ['embedded（有内嵌目标语言字幕轨）', { originLang: 'ja', embedded: ['chi'] }, 0, 'embedded'],
    ['missing（需要找字幕）', { originLang: 'ja', embedded: ['jpn'] }, 1, 'missing'],
  ])('🔴 %s → skip_reason 落库', async (_label, seed, needs, reason) => {
    const db = openDb(':memory:')
    const V = '/media/Show/E01.mkv'
    seedForJudge(db, V, seed as any)
    const daemon = new ScoutDaemonV2(mkDeps(db, { targetLanguage: 'zh' }))
    await (daemon as any).judgeOnce()
    const row = db.prepare('SELECT needs_subtitle FROM files WHERE path = ?').get(V) as { needs_subtitle: number }
    expect(row.needs_subtitle).toBe(needs)
    expect(skipReasonOf(db, V)).toBe(reason)
    db.close()
  })
})

describe('🔴 R-F15 缺口② · 扫描记录全部外挂字幕语言（不只目标语言）', () => {
  const V = '/media/Show/E01.mkv'

  /** 目录 readdir 替身 + **调用计数**——性能红线的唯一凭据。 */
  function fakeDir(files: Record<string, string[]>) {
    const calls: string[] = []
    return { calls, readdir: (d: string) => { calls.push(d); return files[d] ?? [] } }
  }

  it('🔴 目标 zh，盘上只有 .en.srt → sidecar_langs 记下 en（换语言时的全部凭据）', async () => {
    const db = openDb(':memory:')
    const dir = fakeDir({ '/media/Show': ['E01.mkv', 'E01.en.srt'] })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), targetLanguage: 'zh',
      fileExists: () => false, readdir: dir.readdir,
    }))
    await scan(daemon)
    expect(sidecarLangsOf(db, V)).toEqual(['en'])
    // 但 sub_status 仍是 NULL：目标是 zh，一条英文字幕不构成"已覆盖"（既有语义不许被本改动放宽）
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it('🔴 一个视频旁边多条不同语言字幕 → 全部记录', async () => {
    const db = openDb(':memory:')
    const dir = fakeDir({ '/media/Show': ['E01.mkv', 'E01.zh-Hans.srt', 'E01.en.srt', 'E01.ja.ass'] })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), targetLanguage: 'zh',
      fileExists: () => false, readdir: dir.readdir,
    }))
    await scan(daemon)
    expect(sidecarLangsOf(db, V)).toEqual(['en', 'ja', 'zh-Hans'])
    expect(subStatusOf(db, V)).toBe('covered')   // 目标 zh 命中 zh-Hans
    db.close()
  })

  it('🔴 性能红线：同目录 8 个视频 → readdir 只发 1 次（per-scan 目录缓存）', async () => {
    // 这一条是本组**最贵**的用例。R24 现状是每视频 15 tag × 4 ext = 60 次 stat，115 网盘的
    // rclone FUSE 挂载上放大约 46 倍。改成 readdir 的全部理由就是把"每文件 60 次 syscall"
    // 压成"每目录 1 次"；若忘了做目录缓存，8 个视频就是 8 次 readdir，收益归零且比原来更糟
    // （readdir 单次比 stat 贵）。实测（本地 tmpfs，24 视频无中字）：1440 次 existsSync
    // 5.82ms vs 1 次 readdir 0.22ms，快 26 倍——而未命中恰恰是"需要找字幕"那批生产主力。
    const db = openDb(':memory:')
    const vids = Array.from({ length: 8 }, (_, i) => `/media/Show/E0${i + 1}.mkv`)
    const dir = fakeDir({ '/media/Show': [...vids.map((v) => v.split('/').pop()!), 'E01.en.srt'] })
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': vids }), targetLanguage: 'zh',
      fileExists: () => false, readdir: dir.readdir,
    }))
    await scan(daemon)
    expect(dir.calls).toEqual(['/media/Show'])
    db.close()
  })

  it('🔴 readdir 抛错（FUSE 抖动）→ sidecar_langs 留 NULL，不写成 []（三态契约）', async () => {
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), targetLanguage: 'zh',
      fileExists: () => false, readdir: () => { throw new Error('EIO') },
    }))
    await scan(daemon)
    // NULL = 没观察到；[] = 观察过确认零条。折叠成 [] 会让一次抖动被记成"这片子没有任何字幕"，
    // 换语言重判时据此重新找一遍（烧付费 LLM）。
    expect(sidecarLangsOf(db, V)).toBeNull()
    db.close()
  })
})

describe('🔴 R-F15 缺口③ · 换目标语言 → 全库重判（不重新扫盘）', () => {
  const V = '/media/Show/E01.mkv'

  it('🔴 核心场景：盘上有 .en.srt，目标 zh→en → 重判后判成"已有字幕"，且不碰磁盘', async () => {
    // 修复前：sub_status 是无语言布尔，改目标后该文件仍被当成"需要找字幕" → 系统重新找一遍
    // 一个磁盘上早就有的英文字幕。有了 sidecar_langs 之后，重判**不需要任何 stat/readdir**。
    const db = openDb(':memory:')
    const dir = { readdir: (_d: string) => ['E01.mkv', 'E01.en.srt'] }
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), targetLanguage: 'zh',
      fileExists: () => false, readdir: dir.readdir,
    }))
    await scan(daemon)
    expect(subStatusOf(db, V)).toBeNull()          // 目标 zh 时：英文字幕不算覆盖
    expect(sidecarLangsOf(db, V)).toEqual(['en'])  // 但语言事实已记下

    // 用户在设置页把目标改成 en。**一次磁盘访问都不许发**——readdir/fileExists 全给炸弹。
    const settings = new SettingsRepo(db)
    const before = settings.get('target_languages')
    expect(before).toBeNull()
    retargetForLanguageChange(db, ['en'], NOW + 1)

    expect(subStatusOf(db, V)).toBe('covered')     // 磁盘上那条 .en.srt 现在算覆盖了
    expect(db.prepare('SELECT needs_subtitle, skip_reason FROM files WHERE path = ?').get(V))
      .toEqual({ needs_subtitle: null, skip_reason: null })   // 判决列清空 → 下轮 judge 重判
    db.close()
  })

  it('🔴 反向：目标 zh→ja 而盘上只有 .en.srt → covered 回退 NULL，重进字幕工作台', async () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered' })
    db.prepare("UPDATE files SET sidecar_langs = '[\"en\"]' WHERE path = ?").run(V)
    retargetForLanguageChange(db, ['ja'], NOW + 1)
    expect(subStatusOf(db, V)).toBeNull()
    db.close()
  })

  it('🔴 R24 红线：不清 sub_status——磁盘事实不因改配置而丢失（sidecar_langs 未知的行原样不动）', () => {
    // 用户点名的约束：sub_status 是磁盘事实观察（R24），不该因为改配置就被清成 NULL。
    // sidecar_langs 为 NULL = "还没观察过这一行的语言"，此时**没有任何新证据**可据以重导出，
    // 清掉就是拿信息缺失当结论（今天栽过三次的「把中间量说成结论量」的同型）。
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'covered' })   // sidecar_langs 仍是 NULL（存量行）
    retargetForLanguageChange(db, ['en'], NOW + 1)
    expect(subStatusOf(db, V)).toBe('covered')
    db.close()
  })

  it.each([['handoff_translate'], ['unsolvable']])(
    '🔴 停牌态（%s）+ 新目标语言字幕不在盘上 → 一列不动（扫描都没权清它，重判更没有）',
    (stalled) => {
      const db = openDb(':memory:')
      seedRow(db, V, { sub_status: stalled })
      db.prepare("UPDATE files SET sidecar_langs = '[\"en\"]' WHERE path = ?").run(V)
      retargetForLanguageChange(db, ['ja'], NOW + 1)
      expect(subStatusOf(db, V)).toBe(stalled)
      db.close()
    })

  it('🔴 停牌态 + 新目标语言字幕**在**盘上 → covered（停牌自然解除，同 R23 既有口径）', () => {
    const db = openDb(':memory:')
    seedRow(db, V, { sub_status: 'handoff_translate' })
    db.prepare("UPDATE files SET sidecar_langs = '[\"en\"]' WHERE path = ?").run(V)
    retargetForLanguageChange(db, ['en'], NOW + 1)
    expect(subStatusOf(db, V)).toBe('covered')
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
// 🔴🔴 第 8 步 live test 第五轮实测缺陷：**装盘与观察之间没有衔接**
//
// spec 有 D12/D16/D18 三条裁决管两档调度，却没有任何一条说"worker 刚把字幕放到磁盘上之后，
// 谁负责立刻观察它"。于是刚装了字幕的文件**既不在 A 档、也不在 B 档**：
//   · A 档 = 本轮新增/指纹变化 → 装 sidecar **不改视频文件的 mtime/size** → 指纹没变，不命中
//   · B 档 = `sub_recheck_at <= now` → 上一轮 A 档检测时已推到 now+7 天 → 不命中
//
// 生产实测（第五轮巡检的库状态，逐字）：
//   sub_recheck_at 分布：未来|61（最早=最晚=2026-08-17，now=2026-08-10）
//   sub_status 分布：   (null)|61
//   磁盘上实际字幕数：   35
// 即：worker 装好的 35 个字幕要等 **7 天**才会被观察成 covered。这期间
//   ① 界面上这些文件一直显示"没有字幕"（用户看到的是假的）
//   ② 更贵的那条：sub_status 仍为 NULL ⇒ 它们**仍满足字幕工作台谓词** ⇒ 下一轮巡检
//      **再找一遍已经有字幕的文件**，白烧付费 LLM，35 文件 × 每轮一次 × 7 天。
//
// 这批用例与 subtitleScheduler.test.ts 里那批是**互补而非重复**，两边都必须有：
//   · 那边（单元）钉"装盘成功写出的排期值是已过期的"——写者一侧的契约。
//   · 这边（端到端）钉"下一轮扫描真的把它观察成 covered 了"——**读者一侧真的会命中**。
//     只有单元断言的话，谁把哨兵改成一个"看起来过期但读者时钟下是未来"的值（比如
//     `Date.now()-1` 撞上注入时钟）都不会红，而那恰是这个修法唯一的静默失效点。
//
// 同型缺陷第 5 次（C12 → C35 → C43 → C21 → 本条），形态是"写了某列却没定谁来写/谁来重读"，
// 这次的变体是"**放了文件却没定谁来观察它**"。
// ─────────────────────────────────────────────────────────────────────────────
describe('ScoutDaemonV2 · 装盘→观察的衔接（worker 装完盘，下一轮扫描必须就观察到）', () => {
  const V = '/media/Show/E01.mkv'
  const SUB = '/media/Show/E01.zh-Hans.srt'

  /** 复现生产第五轮的那个库状态：指纹与磁盘一致（进不了 A 档）、sub_recheck_at 在未来
   *  （进不了 B 档）、sub_status 为 NULL（仍在字幕工作台里）。 */
  function seedAfterADetect(db: ReturnType<typeof openDb>): void {
    seedRow(db, V, { sub_status: null, sub_recheck_at: NOW + 7 * DAY })
  }

  it('🔴🔴 worker 装盘 → **下一轮扫描**就观察成 covered（而不是等 7 天）', async () => {
    const db = openDb(':memory:')
    seedAfterADetect(db)
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))

    // ① 字幕流跑：worker 把 sidecar 放到磁盘上，并走真实的回写路径（不在测试里手写 UPDATE
    //    ——手写就等于测试自己维护一份实现，两份一漂移就是假绿）。
    const item = {
      workId: 'tmdb:42', title: 'Show', originalTitle: null, year: null, overview: null,
      chineseTitles: [], mediaType: 'tv',
      files: [{ path: V, filename: 'E01.mkv', season: 1, episode: 1, dir: '/media/Show', durationSec: 1440, embeddedLangs: null }],
    }
    sub.put(SUB)   // worker 真的把文件放上去了
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item as any, 'zh')

    // 装盘那一刻状态仍是 NULL（R24：worker 无权写 covered）——前置条件，也是 R24 的守卫。
    expect(subStatusOf(db, V)).toBeNull()

    // ② 下一轮巡检的扫描阶段。指纹没变（fakeFs 的 stat 恒定）⇒ A 档为空，
    //    所以这一条能绿的**唯一**通路就是 B 档真的选中了它。
    await scan(daemon)

    expect(sub.checkedVideos([V])).toEqual([V])   // 真的被观察了（而不是靠别的路径蒙对）
    expect(subStatusOf(db, V)).toBe('covered')
    db.close()
  })

  it('🔴🔴 观察完排期被推回 7 天后（拉到立即到点是一次性的，不许退化成每轮全量 / D12）', async () => {
    const db = openDb(':memory:')
    seedAfterADetect(db)
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    const item = {
      workId: 'tmdb:42', title: 'Show', originalTitle: null, year: null, overview: null,
      chineseTitles: [], mediaType: 'tv',
      files: [{ path: V, filename: 'E01.mkv', season: 1, episode: 1, dir: '/media/Show', durationSec: 1440, embeddedLangs: null }],
    }
    sub.put(SUB)
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item as any, 'zh')

    await scan(daemon)
    // 观察路径自己会把排期推回 now+7 天 ⇒ 哨兵天然自清除。
    // 没有这一条，"拉到立即到点"就有可能被实现成一个粘住的状态（比如某个布尔标记忘了清），
    // 于是这一行每轮都进 B 档、每轮 60 次 stat —— D12 的性能收益在它身上归零。
    expect(recheckAtOf(db, V)).toBe(NOW + 7 * DAY)

    // 再跑一轮：不该再被观察（已推到未来）。这是"一次性"的直接证据。
    const before = sub.calls.length
    await scan(daemon)
    expect(sub.calls.length).toBe(before)
    db.close()
  })

  it('🔴🔴 装盘声称成功但磁盘上其实没有 → 仍**不是** covered（R24 的价值，别被本修法绕过）', async () => {
    const db = openDb(':memory:')
    seedAfterADetect(db)
    // 用户裁决原文点名的那三种形态：装错了 / 装了个空文件 / 装了个 0 字节文件——
    // 流程认为成功，而磁盘上没有可用字幕。这正是"covered 必须是磁盘观察结果、不是流程结果"
    // 的全部理由。本修法只把**复核排期**提前，绝不能顺手把 worker 的成功报告变成结论：
    // 若哪天有人图省事让 worker 直接写 covered，这一条就是拦住它的那道门。
    const sub = fakeSubtitleDisk([])   // 磁盘上**没有**任何字幕（worker 撒谎/装失败）
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    const item = {
      workId: 'tmdb:42', title: 'Show', originalTitle: null, year: null, overview: null,
      chineseTitles: [], mediaType: 'tv',
      files: [{ path: V, filename: 'E01.mkv', season: 1, episode: 1, dir: '/media/Show', durationSec: 1440, embeddedLangs: null }],
    }
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item as any, 'zh')

    await scan(daemon)
    expect(sub.checkedVideos([V])).toEqual([V])   // 被观察了（排期确实拉到了立即到点）
    expect(subStatusOf(db, V)).toBeNull()         // 但观察不到 sidecar ⇒ 不是 covered
    db.close()
  })

  it('🔴🔴 端到端：装盘后的文件不再被字幕工作台重选（防"每轮重找已有字幕的文件"白烧 LLM）', async () => {
    const db = openDb(':memory:')
    seedAfterADetect(db)
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run('tmdb:42', 'Show', 'tv', 1000, 1000)
    const sub = fakeSubtitleDisk([])
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'], ...fakeFs({ '/media': [V] }), fileExists: sub.fileExists,
    }))
    const item = {
      workId: 'tmdb:42', title: 'Show', originalTitle: null, year: null, overview: null,
      chineseTitles: [], mediaType: 'tv',
      files: [{ path: V, filename: 'E01.mkv', season: 1, episode: 1, dir: '/media/Show', durationSec: 1440, embeddedLangs: null }],
    }
    sub.put(SUB)
    await runSubtitleWorkDir(db, (async () => ({
      installed: [{ itemId: 'tmdb:42/s1e1', installedPath: SUB, installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })) as any, item as any, 'zh')
    await scan(daemon)

    // 用**真实的队列函数**做断言，不复述谓词。这是"白烧付费 LLM"那条后果的直接凭据：
    // 断言 sub_status 只证明状态对了，而"会不会被再找一遍"取决于工作台谓词整体，
    // 谓词是那个真正花钱的东西。时刻用远未来（+30 天）排除 recheck_after 退避的干扰——
    // 出队的凭据必须是 covered，不能是"恰好还在退避里"（退避一到期就又被选中了）。
    const queued = listSubtitleQueue(db, ['/media'], Date.now() + 30 * DAY)
      .flatMap(q => q.files.map(f => f.path))
    expect(queued).not.toContain(V)
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

describe('ScoutDaemonV2.judgeOnce · 日志文案必须与计数口径逐字对应（2026-08-10 live test）', () => {
  // 起因：live test 里 61 个文件全被日志报成「judge: 61 个文件判定需字幕」，我据此误判
  // judge 规则 2（已有内嵌中文轨 → 跳过）在生产失效、停了引擎排查根因——查完发现规则完全
  // 正常（44 需 / 17 跳），错的是日志：`judged` 计的是**判定过的行数**，文案却说"判定需字幕"。
  //
  // 与同一天修掉的 `scan: probe ok=N`（统计"没抛异常"而非"写进去了"）是同一类缺陷：
  // **日志把一个中间量说成结论量**。这类缺陷不会让程序算错，但会让读日志的人算错——
  // 而 live test 阶段人读日志就是唯一的观测手段，误导一次的代价是一轮排查 + 一次停机。
  it('🔴 混合样本：日志分别报「需字幕」与「跳过」的条数，不把总数说成需字幕数', async () => {
    const db = openDb(':memory:')
    // 3 个需字幕（en 无内嵌中文） + 2 个该跳过（内嵌 chi / 国产）
    seedJudgeable(db, '/media/Show/E01.mkv', { originLang: 'en' })
    seedJudgeable(db, '/media/Show/E02.mkv', { originLang: 'en' })
    seedJudgeable(db, '/media/Show/E03.mkv', { originLang: 'en' })
    seedJudgeable(db, '/media/Show/E04.mkv', { originLang: 'en', embeddedLangs: JSON.stringify(['eng', 'chi']) })
    seedJudgeable(db, '/media/Show/E05.mkv', { originLang: 'en', embeddedLangs: JSON.stringify(['chi']) })
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], log: (m: string) => logs.push(m) }))
    await judge(daemon)

    const line = logs.find((l) => l.startsWith('judge:'))
    expect(line).toBeDefined()
    // 口径断言：DB 里真实的 needs=1 条数，必须等于日志里"需字幕"那个数字
    const needs = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE needs_subtitle = 1').get() as { n: number }).n
    const skipped = (db.prepare('SELECT COUNT(*) AS n FROM files WHERE needs_subtitle = 0').get() as { n: number }).n
    expect(needs).toBe(3)
    expect(skipped).toBe(2)
    expect(line).toContain(`${needs} 需字幕`)
    expect(line).toContain(`${skipped} 跳过`)
    // 反向防线：旧文案「judge: 5 个文件判定需字幕」会让 5(总数) 被读成需字幕数
    expect(line).not.toMatch(/^judge: 5 个文件判定需字幕$/)
    db.close()
  })

  it('🔴 全部跳过时日志不得写成「N 需字幕」（探针可用但全是内嵌中文的库）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, '/media/Show/E01.mkv', { originLang: 'en', embeddedLangs: JSON.stringify(['chi']) })
    seedJudgeable(db, '/media/Show/E02.mkv', { originLang: 'en', embeddedLangs: JSON.stringify(['chi']) })
    const logs: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'], log: (m: string) => logs.push(m) }))
    await judge(daemon)
    const line = logs.find((l) => l.startsWith('judge:'))
    expect(line).toContain('0 需字幕')
    expect(line).toContain('2 跳过')
    db.close()
  })
})

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
      // 返回一个真文件而不是 []：本用例断言的是"巡检**跑了一轮**"（walked 里出现几个根），
      // 空目录会触发 C46 的 R8 重试 → 同一个根出现 3 次，断言的语义当场从"跑了一轮"
      // 滑成"walk 被调了几次"，与本用例要守的东西（运维抛错不拖垮巡检）无关。
      listVideoFiles: (r: string) => { walked.push(r); return ['/media/Show/E01.mkv'] },
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
      // 非空目录：本用例数的是"巡检跑了几轮"，空目录会引入 C46 的 R8 重试噪音（见上）。
      listVideoFiles: () => { walks++; return ['/media/Show/E01.mkv'] },
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
      // 非空目录：本用例断言的是"这一轮扫了**哪些根**"（惰性求值有没有生效），
      // 空目录会因 C46 的 R8 重试让每个根重复 3 次，把名单断言变成计数断言。
      listVideoFiles: (r: string) => { walked.push(r); return [`${r}/Show/E01.mkv`] },
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
// 🔴 judgeOnce 必须把 **filename** 喂进 judgeSubtitle（规则 0 的唯一判据）。
//
// 为什么这组用例非有不可（而不是"subtitleJudge.test.ts 测过纯函数就够了"）：
// 这正是本仓栽过 5 次的那个形状（C12 → C35 → D17 → D18 → C43）——"判据写好了，
// 但没人把它接到生产路径上"。`isMechanicalExtra` 上一轮就是这么死的：函数完好、
// 用例全绿、生产零调用点，16 个特典照样每轮烧一次付费 LLM session。
// 纯函数用例对"judgeOnce 忘了传 filename"完全无感（它会全绿），只有端到端断言能抓住。
// ─────────────────────────────────────────────────────────────────────────────
// skipReasonOf 已在上方 R-F15 那组定义（:1948），此处复用——再声明一份是 SyntaxError，
// 而 vitest 对整文件语法错误的表现是**静默丢掉全部 3200+ 用例只报 0 test**（本轮实测踩到）。
describe('ScoutDaemonV2.judgeOnce · 机械特典不进字幕范围（2026-08-13 用户裁决）', () => {
  // 生产库实测的真实文件名（`/cache/scout.db`，Re:ZERO 那 16 个之一）。
  const EXTRA = '/media/Show/[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][NCOP1][1080P][BDRip][HEVC-10bit][FLAC].mkv'
  const REAL = '/media/Show/[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][01][1080P][BDRip][HEVC-10bit][FLACx2].mkv'

  it('🔴🔴 特典 → needs_subtitle=0 + skip_reason=extra（filename 真的被喂进去了）', async () => {
    const db = openDb(':memory:')
    // origin=ja + 日文内嵌轨：**没有规则 0 的话这一行必然判 needs=1**（走到规则 3）。
    // 所以这条断言只可能因为"filename 被喂进去且规则 0 生效"而通过。
    seedJudgeable(db, EXTRA, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    expect(needsSubtitleOf(db, EXTRA)).toBeNull()  // 前置：还没判过，否则用例是空转的假绿
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(needsSubtitleOf(db, EXTRA)).toBe(0)
    expect(skipReasonOf(db, EXTRA)).toBe('extra')
    db.close()
  })

  it('🔴 同一部剧的正片不受影响 → 仍然 needs_subtitle=1（零误伤）', async () => {
    // 与上一条**同一个作品、同一个目录、同一套语言事实**，只有文件名不同。
    // 这样两条合起来钉的是"判据确实是文件名"，而不是"某个作品被整体跳过了"。
    const db = openDb(':memory:')
    seedJudgeable(db, REAL, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(needsSubtitleOf(db, REAL)).toBe(1)
    expect(skipReasonOf(db, REAL)).toBe('missing')
    db.close()
  })

  it('🔴 特典与正片在**同一轮** judge 里被分开处理（逐行判据，不是整簇）', async () => {
    const db = openDb(':memory:')
    seedJudgeable(db, EXTRA, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    seedJudgeable(db, REAL, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    expect(needsSubtitleOf(db, EXTRA)).toBe(0)
    expect(needsSubtitleOf(db, REAL)).toBe(1)
    db.close()
  })

  it('🔴 判成特典的行**进不了字幕工作台**（这才是用户裁决要的最终效果）', async () => {
    // 前三条断言的是 files 两列的值；这一条断言的是**它带来的后果**——
    // 只钉列值的话，有人把工作台谓词从 `needs_subtitle = 1` 改成别的判据时不会红，
    // 而那正是"特典不算在找字幕的范围"这句话真正的含义所在。
    const db = openDb(':memory:')
    seedJudgeable(db, EXTRA, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    seedJudgeable(db, REAL, { originLang: 'ja', embeddedLangs: '["jpn"]' })
    const daemon = new ScoutDaemonV2(mkDeps(db, { roots: ['/media'] }))
    await judge(daemon)
    const queued = listSubtitleQueue(db, ['/media'], NOW)
      .flatMap((item) => item.files.map((f) => f.path))
    expect(queued).toContain(REAL)
    expect(queued).not.toContain(EXTRA)
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

  // ───────────────────────────────────────────────────────────────────────────
  // 翻译工作台的 in-flight 登记（CURRENT-STATE §八「翻译工作台 GC 炸弹」/ C34 的另一半）
  //
  // 字幕流早有这条（阶段 3 里 `inFlightStagingJobIds.add(subtitleJobId(item.workId))`），
  // 翻译流一直没有——文档记的根因是"翻译 jobId 是 `daemon-${Date.now()}`，每次不同、循环层
  // 无法预知"。既然 jobId 现在由 `translateJobId(workId, path)` 稳定派生，循环层在**开工前**
  // 就能算出与 worker 实际建目录**字节一致**的那个名字，这条登记从"做不到"变成"必须做"。
  //
  // 为什么不能只靠 gcOrphans 自己的 mtime 活性窗口（那是改动前唯一的保护）：
  // 窗口是 10 分钟递归最新 mtime，而翻译的单步可以很久没有磁盘写（一次 pro reasoning 的
  // update_rows 之间隔着分钟级的模型思考），且 gcStaging 只在 boot 跑一次——真实杀伤场景是
  // "手动 CLI 正在翻一部电影，运维重启 daemon"：boot GC 拿着空集合 + 一个刚好静默了 11 分钟
  // 的工作台，把跑了两小时的现场整个 rm 掉。in-flight 集合是这条路径上唯一确定性的判据。
  // ───────────────────────────────────────────────────────────────────────────

  it('🔴 翻译在飞行中时，它的工作台 jobId 在 in-flight 集合里（否则 boot GC 会 rm 掉正在跑的现场）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1)                                    // work_id 默认 tmdb:1
    let sawInFlight: string[] = []
    let daemon!: ScoutDaemonV2
    daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2,
      translateEnabled: () => true,
      fileExists: () => true,
      translateRunItem: async () => {
        // runItem 跑到一半时观察 daemon 眼里的集合——gcOrphans 靠 jobId **目录名**判活
        // （`<root>/.subtitle-translate/<jobId>/`），名字对不上就等于没保护。
        sawInFlight = [...((daemon as any).inFlightStagingJobIds as Set<string>)]
        return { status: 'installed' as const }
      },
    }))
    await advance(daemon)
    // 与生产实际用的那个 jobId **同源**（不在测试里复述格式）：这一条正是 C34 在字幕流
    // 立下的规矩——两边各手写一份，任何一侧改格式 GC 保护就静默失效而测试全绿。
    expect(sawInFlight).toEqual([translateJobId('tmdb:1', V1)])
    // 跑完必须摘掉，否则这个 jobId 永久免疫 GC → 工作台垃圾无界堆积
    expect([...((daemon as any).inFlightStagingJobIds as Set<string>)]).toEqual([])
    db.close()
  })

  it('🔴 runItem 抛错也要把 in-flight 条目摘掉（finally 语义，同字幕流）', async () => {
    const db = openDb(':memory:')
    seedHandoff(db, V1)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2,
      translateEnabled: () => true,
      fileExists: () => true,
      translateRunItem: async () => { throw new Error('LLM boom') },
    }))
    await advance(daemon)
    expect([...((daemon as any).inFlightStagingJobIds as Set<string>)]).toEqual([])
    db.close()
  })

  it('🔴 文件已消失（R12 跳过，runItem 一次不调）→ 不许登记（白白免疫一次 GC）', async () => {
    // 与字幕流"登记必须在剔除之后"同一条论证：一个根本没开工的 jobId 若也登记一次，
    // 它对应的（上一次失败留下的）工作台就白白躲过这一次 boot 回收。
    const db = openDb(':memory:')
    seedHandoff(db, V1)
    let calls = 0
    const seen: string[][] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      now: () => NOW2,
      translateEnabled: () => true,
      fileExists: () => false,                             // 磁盘上没了
      translateRunItem: async () => { calls++; return { status: 'installed' as const } },
      // gcStaging 不在这条路径上被调，故直接观察集合的终态 + 过程态
      log: (m: string) => { seen.push([m]) },
    }))
    await advance(daemon)
    expect(calls).toBe(0)
    expect([...((daemon as any).inFlightStagingJobIds as Set<string>)]).toEqual([])
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-F5：works 的 TMDB 应有集回填 pass（backfillSeasonCatalog）。
//
// **本条的实质是"给一张已存在但没人喂的表接上生产者"，不是新建缓存。**
// 实测现状（2026-08-11）：
//   · `tmdb_seasons` 表早在 db.ts v12 就建好，`tmdbCatalog.refreshSeriesCatalog` 是它唯一的
//     写入方，`canonicalEpisodes` 是唯一的读出方——两个函数都在、都有测试、都能跑。
//   · 但它**唯一的生产触发点**是 `server.ts:275` 的 `librarySeriesDetail`，而那条通路先查
//     `SELECT … FROM series WHERE id = ?`（apiV2.ts:1580），detail 为 null 就不触发刷新。
//   · `series` 表是**旧世界**的表，写入方只有 `libraryRepo.upsertSeries`，其唯一生产调用方
//     在 ingest 走盘循环里；而新架构的 daemonV2 **一行 series 都不写**（实测 grep 为 0），
//     它写的是 `works`。
//   → 于是新架构识别出来的 110 个 works 在 `series` 里没有对应行 → detail 恒 null →
//     `refreshSeriesCatalog` 对它们**一次都不会被调用** → `tmdb_seasons` 对新架构恒空。
//
// 这正是本仓栽过 5 次的同型缺陷的**第 6 例**（C12→C35→C43→C21→audio_langs）：
// 列/表写好了、读出函数也写好了，**但没定谁来写**。前 5 次是"谁来写/谁来重读"，
// 这一次更隐蔽——写入方存在，只是它的触发谓词长在另一张没人填的表上。
//
// 因此本 pass 的三个职责必须写死在这里：
//   · **谁写**：`ScoutDaemonV2.backfillSeasonCatalog`（boot 一次，照 backfillProviderIds 形态）
//   · **谁读**：`tmdbCatalog.canonicalEpisodes`（既有，媒体库页虚线小卡片的数据来源）
//   · **什么时候写全**：靠 `works` 全表扫 + 每轮 BACKFILL_BATCH_SIZE 上限，多轮 boot 收敛；
//     单轮内靠 refreshSeriesCatalog 自己的 7 天 TTL 门天然跳过已刷新的行。
//
// 为什么走回填 pass 而不是"识别成功那一刻同步抓"（这是 R-F5 落地形态的关键选择）：
// 与 C21 完全同构——识别成功后 `files.work_id` 非 NULL，而 identifyScheduler 的队列谓词是
// `work_id IS NULL` → 那个作品目录**永不再进识别队列**。只在识别时抓，覆盖的仅是**今后**新
// 识别的作品，库里现存的 110 个 works 永远没有季集表 → 媒体库页对存量剧一根虚线都画不出来。
// 回填 pass 同时覆盖存量与新增（新增作品下一次 boot 自然被谓词捞到），是唯一收敛的形态。
// ─────────────────────────────────────────────────────────────────────────────
async function backfillCatalog(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).backfillSeasonCatalog()
}

/** 只注入季集两个方法的最小 identify deps（回填只用得到它们）。 */
function catDeps(db: ReturnType<typeof openDb>, over: {
  table?: (tvId: string) => Promise<any>
  episodes?: (tvId: string, season: number) => Promise<any>
} = {}) {
  const tableCalls: string[] = []
  const epCalls: Array<[string, number]> = []
  return {
    tableCalls,
    epCalls,
    deps: {
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: {
          model: {} as any,
          tmdb: {
            search: async () => [],
            getDetails: async () => null,
            getSeasonTable: async (tvId: string) => {
              tableCalls.push(tvId)
              return over.table ? over.table(tvId) : [{ seasonNumber: 1, episodeCount: 2, airDate: '2022-01-01' }]
            },
            getSeasonEpisodes: async (tvId: string, season: number) => {
              epCalls.push([tvId, season])
              if (over.episodes) return over.episodes(tvId, season)
              return [
                { episode: 1, title: 'Ep1', overview: null, airDate: null, stillPath: null },
                { episode: 2, title: 'Ep2', overview: null, airDate: null, stillPath: null },
              ]
            },
          } as any,
        },
      },
    },
  }
}

function seedWorkFor(db: ReturnType<typeof openDb>, id: string, mediaType: 'tv' | 'movie' = 'tv') {
  db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(id, `Work ${id}`, mediaType, 1000, 1000)
}

function catalogRows(db: ReturnType<typeof openDb>, seriesId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM tmdb_seasons WHERE series_id = ?').get(seriesId) as { c: number }).c
}

describe('ScoutDaemonV2 · R-F5 works 应有集回填 pass', () => {
  it('🔴 电视剧 work 的 TMDB 季集表被抓进 tmdb_seasons（媒体库页虚线小卡片的数据来源）', async () => {
    const db = openDb(':memory:')
    seedWorkFor(db, 'tmdb:120089')
    // 前置：确实是空的，否则本用例空转（假绿最常见形态，照 C21 用例 7 的口径先断一次）
    expect(catalogRows(db, 'tmdb:120089')).toBe(0)

    const cat = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...cat.deps })))

    // 断言**读出方**的产出而不是"行数非 0"：媒体库页拿的是 canonicalEpisodes，
    // 写进去两行垃圾同样满足"行数非 0"，而虚线卡片仍画不出集号——列有值、功能照旧瘸。
    expect(canonicalEpisodes(db, 'tmdb:120089', 1)).toEqual([
      { episode: 1, title: 'Ep1', overview: null, airDate: null, stillPath: null },
      { episode: 2, title: 'Ep2', overview: null, airDate: null, stillPath: null },
    ])
    db.close()
  })

  it('🔴 media_type=movie 被跳过，不留空行、也不打 TMDB（电影没有季集）', async () => {
    const db = openDb(':memory:')
    seedWorkFor(db, 'tmdb:9', 'movie')
    const cat = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...cat.deps })))

    // 两条都要断：不打请求（白烧配额 + 保证 404）、不留行（空行会被读成"这剧有 0 季"）。
    expect(cat.tableCalls).toEqual([])
    expect(catalogRows(db, 'tmdb:9')).toBe(0)
    db.close()
  })

  it('🔴 TMDB 抓取失败 → 一行不写（留"没探过"，不写 0 集），下轮重试', async () => {
    // 三态契约与 embedded_langs 同源（daemonV2.backfillEmbeddedLangs 的既有论证）：
    // NULL/无行 = 没探过，有行 = 探过的权威结果。若失败时写 0 行**并记 fetched_at**，
    // 媒体库页会把它读成"这季确实有 0 集"→ 一根虚线都不画，而真相是没抓到。
    // tmdb_seasons 没有独立的"探过没有"标志列，`是否存在行`就是那个标志——所以
    // 失败路径必须一行都不落，让下一轮 boot 的 MAX(fetched_at) IS NULL 把它捡回来。
    const db = openDb(':memory:')
    seedWorkFor(db, 'tmdb:500')
    const boom = catDeps(db, { table: async () => { throw new Error('TMDB 429') } })
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...boom.deps })))
    expect(catalogRows(db, 'tmdb:500')).toBe(0)

    // 下一轮：同一行必须**再次**被捞起来重试（这才是"留 NULL 待重试"的实义；
    // 只断言"这轮没写"是半个断言——真正的回归是它从此再也不被捡起）。
    const good = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...good.deps })))
    expect(good.tableCalls).toEqual(['500'])
    expect(canonicalEpisodes(db, 'tmdb:500', 1).length).toBe(2)
    db.close()
  })

  it('🔴 存量回填：库里已识别的 works 全部被补上（不靠识别队列——它们永不再进队列）', async () => {
    const db = openDb(':memory:')
    for (const id of ['tmdb:1', 'tmdb:2', 'tmdb:3']) seedWorkFor(db, id)
    const cat = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...cat.deps })))
    expect(cat.tableCalls.sort()).toEqual(['1', '2', '3'])
    for (const id of ['tmdb:1', 'tmdb:2', 'tmdb:3']) {
      expect(canonicalEpisodes(db, id, 1).length).toBe(2)
    }
    db.close()
  })

  it('🔴 单轮有批量上限（照 backfillProviderIds 的 200 行口径，防 TMDB 配额雪崩）', async () => {
    // 110 个作品 × 每部若干季 = 每季一次 /tv/{id}/season/{n}。没有上限时一次 boot 能打出
    // 上千次请求 → 429 后整批白跑。上限的语义是"每轮 boot 最多推进这么多 work"，
    // 靠多轮 boot 收敛（同 C21）。
    const db = openDb(':memory:')
    const N = 205
    for (let i = 0; i < N; i++) seedWorkFor(db, `tmdb:${1000 + i}`)
    const cat = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...cat.deps })))
    expect(cat.tableCalls.length).toBe(200)
    db.close()
  })

  it('🔴 幂等：同一个 work 重复回填不产生重复行（TTL 门内甚至不再打 TMDB）', async () => {
    const db = openDb(':memory:')
    seedWorkFor(db, 'tmdb:77')
    const first = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...first.deps })))
    expect(catalogRows(db, 'tmdb:77')).toBe(2)

    // 第二轮：refreshSeriesCatalog 的 7 天 TTL 门应当挡掉整次请求。
    // 断言"没有重复行" + "没再打 TMDB" 两条——只断行数的话，一个
    // DELETE+INSERT 的实现会照样绿，而它每轮都在白烧配额。
    const second = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...second.deps })))
    expect(catalogRows(db, 'tmdb:77')).toBe(2)
    expect(second.tableCalls).toEqual([])
    db.close()
  })

  it('🔴 pass 级爆炸不阻塞主巡检（try/catch 隔离，照 backfillProviderIds/embedded_langs 口径）', async () => {
    // 库被锁 / 老库无 works 表（容器滚更时新代码先于迁移跑起来、或从 v30 前的备份恢复）。
    const noTable = openDb(':memory:')
    noTable.exec('DROP TABLE works')
    await expect(backfillCatalog(new ScoutDaemonV2(mkDeps(noTable, { ...catDeps(noTable).deps }))))
      .resolves.toBeUndefined()
    noTable.close()

    // 探针未注入（deps 漏接线）→ 整支休眠且一行不动，不抛。
    const db = openDb(':memory:')
    seedWorkFor(db, 'tmdb:1')
    const bare = new ScoutDaemonV2(mkDeps(db, {
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any },
      },
    }))
    await expect(backfillCatalog(bare)).resolves.toBeUndefined()
    expect(catalogRows(db, 'tmdb:1')).toBe(0)
    db.close()
  })

  it('🔴 非 tmdb: 形状的 id 被跳过（不拿解析不出 TMDB id 的串去打端点）', async () => {
    const db = openDb(':memory:')
    seedWorkFor(db, 'self-scan-trigger')
    const cat = catDeps(db)
    await backfillCatalog(new ScoutDaemonV2(mkDeps(db, { ...cat.deps })))
    expect(cat.tableCalls).toEqual([])
    db.close()
  })

  it('🔴 boot 时被真实调用（不是"写了个方法没人叫"——本仓五次同型缺陷的形状）', async () => {
    // 上面 8 条用例**全部**直接调 (daemon as any).backfillSeasonCatalog()，因此它们在
    // "方法写好了但 run() 里没人叫"的实现下会全绿——而那恰恰就是本条要修的那个缺陷本身
    // （C12→C35→C43→C21→audio_langs 的共同形状）。照 C21 那条同名用例的口径，
    // 这一条走**完整 run()**，没有任何测试专用的直接调用，是 R-F5 真正的验收点。
    const db = openDb(':memory:')
    seedWorkFor(db, 'tmdb:83')
    const cat = catDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [], listVideoFiles: () => [], ...cat.deps,
    }))
    await oneLoop(daemon)
    expect(cat.tableCalls).toEqual(['83'])
    expect(canonicalEpisodes(db, 'tmdb:83', 1).length).toBe(2)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// v42 / R-F13：works.backdrop_path 存量回填 pass（**写入点②**）。
//
// 为什么必须有这条**独立于识别队列**的通路：识别成功后 `files.work_id` 非 NULL，而
// identifyScheduler 的队列谓词是 `work_id IS NULL` → 那个作品目录**永不再进识别队列**。
// 于是"识别时顺手落 backdrop"（写入点①）只覆盖**今后**新识别的作品，库里现存的已识别
// 作品的 backdrop_path 会永远是 NULL，活动页对它们只能退化成「模糊海报当背景」。
// 反过来只有本 pass 而没有写入点①，新识别的作品要等下一次 boot 才有图。
// 这是本仓栽过 11 次的同型缺陷（加了能力却没定谁写/谁读/谁触发）的形状，手法照 C21。
//
// 与 C21 的关键差别：这里**没有"查过、确实没有"的凭据可写**。provider_ids 是 record，
// 能用 `{tmdb}`（非 NULL）收敛；backdrop_path 是裸路径串，TMDB 真没图时采回来就是 null，
// 与"还没采过"不可区分 → 每轮 boot 重查一次。已知代价，见 db.ts v42 entry。
// ─────────────────────────────────────────────────────────────────────────────
async function backfillBackdrops(daemon: ScoutDaemonV2): Promise<void> {
  await (daemon as any).backfillBackdropPaths()
}

function backdropOf(db: ReturnType<typeof openDb>, id: string): string | null {
  return (db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get(id) as { backdrop_path: string | null }).backdrop_path
}

/** v43：「查过没有」的凭据列。回填 pass 的取件谓词读的是**它**，不是 backdrop_path。 */
function checkedOf(db: ReturnType<typeof openDb>, id: string): number | null {
  return (db.prepare('SELECT backdrop_checked_at FROM works WHERE id = ?').get(id) as { backdrop_checked_at: number | null }).backdrop_checked_at
}

function seedWorkBd(db: ReturnType<typeof openDb>, id: string, over: {
  mediaType?: 'tv' | 'movie'; backdropPath?: string | null; checkedAt?: number | null
} = {}) {
  db.prepare(`INSERT INTO works (id, title, media_type, backdrop_path, backdrop_checked_at, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, `Work ${id}`, over.mediaType ?? 'tv', over.backdropPath ?? null, over.checkedAt ?? null, 1000, 1000)
}

/** 只注入 getDetails 的最小 identify deps（本回填只用得到它一个方法）。 */
function bdDeps(db: ReturnType<typeof openDb>, impl?: (mt: 'tv' | 'movie', id: string) => Promise<unknown>) {
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
            getDetails: async (mt: 'tv' | 'movie', id: string) => {
              calls.push([mt, id])
              return impl ? impl(mt, id) : { backdropPath: `/bd-${id}.jpg` }
            },
          } as any,
        },
      },
    },
  }
}

describe('ScoutDaemonV2 · v42 works.backdrop_path 存量回填 pass（写入点②）', () => {
  it('🔴🔴 backdrop_path IS NULL 的存量行被补上（R-F13 红线）', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    // 前置条件：这一行确实是 NULL，否则本用例空转（假绿的最常见形态）
    expect(backdropOf(db, 'tmdb:83')).toBeNull()
    const bd = bdDeps(db, async () => ({ backdropPath: '/xyz.jpg' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon)

    expect(backdropOf(db, 'tmdb:83')).toBe('/xyz.jpg')
    // mediaType 从 works.media_type 取（tv/movie 是两个不同的 TMDB 端点，猜错就是 404）
    expect(bd.calls).toEqual([['tv', '83']])
    db.close()
  })

  it('🔴 分批——250 行存量，一轮只处理 200（每批上限，TMDB 配额敏感）', async () => {
    const db = openDb(':memory:')
    for (let i = 0; i < 250; i++) seedWorkBd(db, `tmdb:${i}`)
    const bd = bdDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon)
    // 用**调用次数**断言而不是"还有多少行是 NULL"：后者在"一次拉完 250 行但只写回 200 行"
    // 这种形态下同样为真，而真实成本（250 次 TMDB 往返）一分不少。
    expect(bd.calls.length).toBe(200)
    const left = db.prepare('SELECT COUNT(*) AS n FROM works WHERE backdrop_path IS NULL').get() as { n: number }
    expect(left.n).toBe(50)   // 剩下的下次启动继续，不丢活
    db.close()
  })

  it('🔴 单个 work 失败 → 留 NULL 待下轮，兄弟行照常完成，整轮不炸', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:bad')
    seedWorkBd(db, 'tmdb:good')
    const bd = bdDeps(db, async (_mt, id) => {
      if (id === 'bad') throw new Error('TMDB 503')
      return { backdropPath: '/ok.jpg' }
    })
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await expect(backfillBackdrops(daemon)).resolves.toBeUndefined()

    // 失败行留 NULL —— 这是下轮重试的唯一凭据。
    expect(backdropOf(db, 'tmdb:bad')).toBeNull()
    expect(backdropOf(db, 'tmdb:good')).toBe('/ok.jpg')
    db.close()
  })

  it('🔴 查过的行不被重查、已有图不被覆盖（靠 `backdrop_checked_at IS NULL` 谓词收敛）', async () => {
    // ⚠️ v43 语义变更：收敛的凭据从「backdrop_path 非空」换成「checked_at 非空」。
    // 原因是前者对"TMDB 真没图"的行恒为空 → 谓词恒真 → 队头阻塞永久饿死尾部行
    // （见下面 3 轮收敛 / 250 行两条用例）。这里同步改成钉新谓词。
    // tmdb:84 用「有图 **且** 已查过」构造 —— v42 的"只有图、没 checked_at"那种存量行
    // 该被捡回来重查一次（一次性代价），那由下面单独一条用例钉。
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    seedWorkBd(db, 'tmdb:84', { backdropPath: '/already.jpg', checkedAt: 5000 })   // 已收敛，不该被碰
    const bd = bdDeps(db, async () => ({ backdropPath: '/new.jpg' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon)
    expect(bd.calls).toEqual([['tv', '83']])
    expect(backdropOf(db, 'tmdb:84')).toBe('/already.jpg')
    expect(checkedOf(db, 'tmdb:84')).toBe(5000)   // 连凭据的时刻都不许被前移
    // 第二次启动（新进程同一个库）：谓词已选不中它们 → 零新增调用。
    const daemon2 = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon2)
    expect(bd.calls).toEqual([['tv', '83']])   // 仍是 1 次，没有第 2 次
    db.close()
  })

  it('🔴 TMDB 真没有横版图 → 不写 backdrop_path，但落 checked_at 收敛（不许拿空串当哨兵）', async () => {
    // 与 C21 用例 9b **同源**的取舍（v43 修正了 v42 的判断）：C21 靠 `{tmdb}` 这个非 NULL
    // 凭据表达"查过、确实没有"从而收敛；backdrop_path 是裸路径串，值里没有第三个槽位，
    // 于是凭据另起一列 `backdrop_checked_at`。两者是同一个机制，不是两套写法。
    //
    // v42 时这里接受的是"每轮重查一次"，实测证明那低估了一个量级——谓词恒真 +
    // ORDER BY id 恒定 + LIMIT 200 相乘 = 尾部行永久饿死（见下面 3 轮收敛/250 行两条用例）。
    // 但 v42 对空串哨兵的否决**依然有效且必须钉住**：backdrop_path 绝不能被写成 ''，
    // 读取方拿到空串就是新的二义性（apiV2 的 nullIfEmpty 已在为这种事付代价）。
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    const bd = bdDeps(db, async () => ({ backdropPath: null }))
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon)
    // 图这一列语义未变：NULL = 没有图。**不是空串**。
    expect(backdropOf(db, 'tmdb:83')).toBeNull()
    // 但"查过了"这件事必须留下凭据，否则下轮又被捡回来（本 task 修的饿死的根因）。
    expect(checkedOf(db, 'tmdb:83')).not.toBeNull()
    db.close()
  })

  it('🔴 getDetails 返回 null（TMDB 404）→ 不写图、落 checked_at、不抛', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    const bd = bdDeps(db, async () => null)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await expect(backfillBackdrops(daemon)).resolves.toBeUndefined()
    expect(backdropOf(db, 'tmdb:83')).toBeNull()
    db.close()
  })

  it('🔴 getDetails 未注入 → 整支休眠，一行不动（探针缺席不动列）', async () => {
    // 反向灾难同 C21：若实现在探针缺席时也照写（比如写空串"标记查过"），一次"忘接线的
    // 启动"就把全库标成"查过、没有横版图"，而其实一次 TMDB 都没打 → 活动页永久退化。
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: { model: {} as any, tmdb: { search: async () => [] } as any },
      },
    }))
    await expect(backfillBackdrops(daemon)).resolves.toBeUndefined()
    expect(backdropOf(db, 'tmdb:83')).toBeNull()
    db.close()
  })

  it('🔴 老库无 works 表 / 无该列 → 回填静默跳过，不抛', async () => {
    // 容器滚更时新代码可能先于迁移跑起来；用户也可能从 v30 之前的备份恢复。
    const noTable = openDb(':memory:')
    noTable.exec('DROP TABLE works')
    const d1 = new ScoutDaemonV2(mkDeps(noTable, { ...bdDeps(noTable).deps }))
    await expect(backfillBackdrops(d1)).resolves.toBeUndefined()
    noTable.close()

    const noCol = openDb(':memory:')
    noCol.exec('ALTER TABLE works DROP COLUMN backdrop_path')
    noCol.exec('ALTER TABLE works DROP COLUMN backdrop_checked_at')
    seedWorkNoIds(noCol, 'tmdb:83')
    const d2 = new ScoutDaemonV2(mkDeps(noCol, { ...bdDeps(noCol).deps }))
    await expect(backfillBackdrops(d2)).resolves.toBeUndefined()
    noCol.close()
  })

  it('🔴 media_type=movie 的作品走 movie 端点（猜错就 404）', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:9', { mediaType: 'movie' })
    const bd = bdDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon)
    expect(bd.calls).toEqual([['movie', '9']])
    db.close()
  })

  it('🔴 非 tmdb: 形状的 id 被跳过（不拿解析不出 TMDB id 的串去打端点）', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'weird-legacy-id')
    const bd = bdDeps(db)
    const daemon = new ScoutDaemonV2(mkDeps(db, { ...bd.deps }))
    await backfillBackdrops(daemon)
    expect(bd.calls).toEqual([])
    expect(backdropOf(db, 'weird-legacy-id')).toBeNull()
    db.close()
  })

  it('🔴 boot 时被真实调用（不是"写了个方法没人叫"——本仓 11 次同型缺陷的形状）', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    const bd = bdDeps(db, async () => ({ backdropPath: '/boot.jpg' }))
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [], listVideoFiles: () => [], ...bd.deps,
    }))
    await oneLoop(daemon)
    // 走的是完整 run()，没有任何测试专用的直接调用 —— 这条是本 pass 真正的验收点：
    // 前面所有用例都可以在"方法存在但 boot 里没人调"的情况下全绿。
    expect(bd.calls).toEqual([['tv', '83']])
    expect(backdropOf(db, 'tmdb:83')).toBe('/boot.jpg')
    db.close()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // v43：队头阻塞 / 永久饿死。**这两条是本次修复的验收点**，其余用例在有缺陷的
  // v42 实现下全都是绿的（它们每条只跑 1 轮、或规模 < 200，两个触发条件都不满足）。
  // ───────────────────────────────────────────────────────────────────────────

  it('🔴🔴 收敛——全库无横版图，跑 3 轮 boot，第 3 轮 TMDB 调用为 0', async () => {
    // 这是 v42 缺陷的最小复现：TMDB 对这些作品**真的没有**横版图（小众剧/部分电影常见），
    // 于是 `backdrop_path IS NULL` 这个谓词**恒真** → 每轮 boot 原样重查一遍，永不收敛。
    // v43 把"查过没有"的凭据挪进 backdrop_checked_at，谓词才单调。
    //
    // 断言**每轮的调用次数**而不是只看总数：只断言总数的话，"第 1 轮 0 次、第 2 轮 30 次"
    // 之类的错误分布也能凑出同一个总和。收敛是一个**逐轮**的性质。
    const db = openDb(':memory:')
    for (let i = 0; i < 30; i++) seedWorkBd(db, `tmdb:${i}`)
    const bd = bdDeps(db, async () => ({ backdropPath: null }))   // TMDB 一张横版图都没有

    const perRound: number[] = []
    for (let round = 0; round < 3; round++) {
      const before = bd.calls.length
      // 每轮 new 一个 daemon = 模拟**新进程**同一个库（回填是 boot 一次的 pass），
      // 不是同一实例调三遍——后者可能被实例内的记忆化蒙混过去。
      await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
      perRound.push(bd.calls.length - before)
    }

    // 第 1 轮查完 30 行；第 2、3 轮谓词一行都选不中 → 0 次。
    expect(perRound).toEqual([30, 0, 0])
    // 收敛的实质：图确实还是没有（TMDB 真没有，不许伪造成空串），但**查过**这件事留下了。
    const noImage = db.prepare('SELECT COUNT(*) AS n FROM works WHERE backdrop_path IS NULL').get() as { n: number }
    const unchecked = db.prepare('SELECT COUNT(*) AS n FROM works WHERE backdrop_checked_at IS NULL').get() as { n: number }
    expect(noImage.n).toBe(30)     // 图还是没有 —— 这正是 TMDB 的事实
    expect(unchecked.n).toBe(0)    // 但全都查过了 —— 这是收敛的凭据
    // 且绝不许拿空串当哨兵（db.ts v42 的否决，v43 未推翻）
    const emptyStr = db.prepare("SELECT COUNT(*) AS n FROM works WHERE backdrop_path = ''").get() as { n: number }
    expect(emptyStr.n).toBe(0)
    db.close()
  })

  it('🔴🔴 不饿死尾部——250 行（> LIMIT 200）全部无图，跑 3 轮后第 201–250 行都被查过', async () => {
    // 审计实跑的那个场景，v42 实现下的实测结论：
    //     totalCalls=600 unique=200 first=1 call#201=1
    // 600 次调用只覆盖 200 个不同作品，**第 201–250 行一次都没被查过**。根因是三件事
    // 相乘：谓词恒真 ＋ `ORDER BY id` 恒定序 ＋ LIMIT 200 只取头部 → 每轮同一批。
    //
    // ⚠️ 用 **unique 覆盖数**断言，不是 totalCalls：totalCalls=600 在"正确轮转"与
    // "同一批查三遍"两种实现下**完全相同**，正是它掩盖了这个缺陷 3 个月。
    const db = openDb(':memory:')
    for (let i = 0; i < 250; i++) seedWorkBd(db, `tmdb:${i}`)
    const bd = bdDeps(db, async () => ({ backdropPath: null }))

    const perRound: number[] = []
    for (let round = 0; round < 3; round++) {
      const before = bd.calls.length
      await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
      perRound.push(bd.calls.length - before)
    }

    // 第 1 轮 200（批上限）、第 2 轮剩下的 50、第 3 轮 0（全查完了）。
    expect(perRound).toEqual([200, 50, 0])
    const unique = new Set(bd.calls.map(([, id]) => id))
    expect(unique.size).toBe(250)            // v42 实现下这里是 200
    expect(bd.calls.length).toBe(250)        // 且一次都没重复查（v42 下是 600）

    // 逐行钉死"尾部真的被采到"，而不只是数个数。`ORDER BY id` 是**字符串**序
    // （'tmdb:1038392' < 'tmdb:99'），所以"尾部"不等于 i 大的那些——直接查库最可靠。
    const unchecked = db.prepare('SELECT COUNT(*) AS n FROM works WHERE backdrop_checked_at IS NULL').get() as { n: number }
    expect(unchecked.n).toBe(0)
    // 再点名审计报告里那个"第 201 行"：按字符串序排出来的第 201 行，必须被查过。
    const row201 = db.prepare('SELECT id FROM works ORDER BY id LIMIT 1 OFFSET 200').get() as { id: string }
    expect(checkedOf(db, row201.id)).not.toBeNull()
    expect(unique.has(row201.id.slice('tmdb:'.length))).toBe(true)
    db.close()
  })

  it('🔴 调用失败的行**不**落 checked_at —— 留 NULL 下轮重试（收敛不许吃掉重试）', async () => {
    // 收敛与重试的界线：本 task 让"查过"变单调，但**不能**顺手把"没查成"也标成查过——
    // 那会让一次 TMDB 抖动永久放弃这一行（identifyScheduler C5 注释点名的
    // "把失败伪装成 TMDB 确认没有"）。这是修复最容易过头的地方，必须钉住。
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:bad')
    seedWorkBd(db, 'tmdb:good')
    let failNext = true
    const bd = bdDeps(db, async (_mt, id) => {
      if (id === 'bad' && failNext) throw new Error('TMDB 503')
      return { backdropPath: id === 'bad' ? '/recovered.jpg' : '/ok.jpg' }
    })
    await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
    expect(checkedOf(db, 'tmdb:bad')).toBeNull()        // 没查成 → 不留凭据
    expect(checkedOf(db, 'tmdb:good')).not.toBeNull()   // 查成了 → 留凭据

    // 下一轮：好行已收敛不再查，坏行必须**被重新捡回来**并成功。
    failNext = false
    const before = bd.calls.length
    await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
    expect(bd.calls.slice(before)).toEqual([['tv', 'bad']])
    expect(backdropOf(db, 'tmdb:bad')).toBe('/recovered.jpg')
    db.close()
  })

  it('🔴 探针缺席（getDetails 未注入）→ 不许留下 checked_at（v43 之后这一条更要命）', async () => {
    // v42 时漏接线的后果是"这一轮白跑"，下轮还会重来。v43 之后 checked_at 是**单调**的，
    // 若在探针缺席时照写，一次"忘接线的启动"就把全库永久标成"查过、没有横版图"，
    // 再也没有任何一轮 boot 会回来 —— 活动页永久退化成模糊海报，且排障时毫无线索。
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: { model: {} as any, tmdb: { search: async () => [] } as any },
      },
    }))
    await expect(backfillBackdrops(daemon)).resolves.toBeUndefined()
    expect(backdropOf(db, 'tmdb:83')).toBeNull()
    expect(checkedOf(db, 'tmdb:83')).toBeNull()   // ← 这一条是本用例的实质
    db.close()
  })

  it('🔴 非 tmdb: 形状的 id **不**落 checked_at（没打过 TMDB，就没有"查过"这回事）', async () => {
    // 与上一条同源：skipped 计数里混着两种性质完全不同的行——"打通了、TMDB 说没有"
    // （该收敛）与"压根没打"（该留 NULL）。落错了就是永久放弃一行等人修数据的记录。
    const db = openDb(':memory:')
    seedWorkBd(db, 'weird-legacy-id')
    const bd = bdDeps(db)
    await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
    expect(bd.calls).toEqual([])
    expect(checkedOf(db, 'weird-legacy-id')).toBeNull()
    db.close()
  })

  it('🔴 已有图但 checked_at 为 NULL 的 v42 存量行 → 补一轮后收敛（迁移刻意不回填的那批）', async () => {
    // v43 迁移**不**顺手把 backdrop_path 非空的行标成"查过"（那要在迁移里凭空捏时刻）。
    // 代价必须是**一次性**的：这批行下一轮各重查一次、落下真实 checked_at 后永久收敛。
    // 这条钉的就是"多一轮，不是每轮"。
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83', { backdropPath: '/from-v42.jpg' })
    const bd = bdDeps(db, async () => ({ backdropPath: '/refreshed.jpg' }))
    await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
    expect(bd.calls).toEqual([['tv', '83']])
    expect(checkedOf(db, 'tmdb:83')).not.toBeNull()
    const before = bd.calls.length
    await backfillBackdrops(new ScoutDaemonV2(mkDeps(db, { ...bd.deps })))
    expect(bd.calls.length).toBe(before)   // 第二轮 0 次 —— 一次性代价，不是每轮
    db.close()
  })

  it('🔴 pass 级爆炸不阻塞主巡检（boot 调用点被独立 try/catch 隔离）', async () => {
    const db = openDb(':memory:')
    seedWorkBd(db, 'tmdb:83')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: [],
      listVideoFiles: () => [],
      identify: {
        db,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        // 不是单个 work 失败，是 pass 级别的爆炸（deps 结构本身坏了）
        worker: { model: {} as any, tmdb: { get getDetails(): never { throw new Error('deps exploded') } } as any },
      },
    }))
    await oneLoop(daemon)
    // 巡检照常发生 = 回填不是主巡检的前置条件。
    expect(lastInspectAt(db)).not.toBeNull()
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// requestScan：带外扫描（2026-08-13）
//
// 这一组守的是**一个真实的用户功能**："加了守备目录之后立刻能看见扫描结果"（还有它的两个
// 同门：Settings 页「立即扫描」按钮、翻译装盘后的 covered 记账）。
//
// ⚠️ 为什么它值得一整组用例：这三个调用点此前接的是 `v2/ingest.ts`，而 ingest **一行
// `files` 都不写**（它只写 series/episodes/movies/parked_paths 四张旧世界表，生产全部 0 行）
// ——也就是说这个功能在换绳子**之前就是坏的，且完全静默**：端点 200、日志正常、界面纹丝不动，
// 用户只能等最长 24 小时后的下一轮自然巡检。实测对照（临时库 + 真实实现走盘同一批文件）：
//     ingest            → parked_paths=2, files=0
//     daemonV2.scanOnce → files=2,        parked_paths=0
// 换绳子后这一组用例就是那个"曾经没有守卫"的位置上的守卫。
// ─────────────────────────────────────────────────────────────────────────────
describe('ScoutDaemonV2.requestScan · 带外扫描（"加根后立刻扫"的真实承载）', () => {
  it('🔴 requestScan() → 主循环真的跑了一轮 scanOnce，新文件**进 files 表**', async () => {
    // 这条是整组的核心：断言的不是"某个回调被调了"，而是**库里真的多了行**。
    // 换绳子前那条链在这条断言下必红（ingest 一行 files 都不写）。
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': ['/media/Show/E01.mkv', '/media/Show/E02.mkv'] }),
      // 巡检闸关死（inspectEveryMs 极大 + 已巡检过），确保写进 files 的**只可能**是
      // 带外扫描那一次——否则自然巡检会顺手扫一遍，这条就成了假绿。
      inspectEveryMs: Number.MAX_SAFE_INTEGER,
      maintenanceTickMs: 1,
      sleep: undefined,
    }))
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(1_000_000_000_000))

    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 20))
    expect(pathsInDb(db), '前提：带外扫描之前 files 是空的（否则下面的断言无意义）').toEqual([])

    daemon.requestScan()
    await new Promise(r => setTimeout(r, 60))
    ctrl.abort()
    await p

    expect(pathsInDb(db)).toEqual(['/media/Show/E01.mkv', '/media/Show/E02.mkv'])
    db.close()
  })

  it('🔴 requestScan() **提前唤醒** idle sleep——不必等满一整拍（"立刻"这两个字的承载）', async () => {
    // ⚠️ 这条与上一条不是重复。上一条用 maintenanceTickMs=1 建模，主循环本来就在飞转，
    // 即便 wakeIdle 整个失效它也照样绿（变异实测确认过：注掉 wakeIdle 那一行，上一条
    // 与幂等那条全绿）。真正要守的是**延迟**：没有 wakeIdle，用户加完守备目录得等满
    // 一个维护拍（生产 5 分钟）才开始扫。
    //
    // 故这里把拍设成 30s（远大于用例耐心），只有提前唤醒才可能在 100ms 内扫完。
    const db = openDb(':memory:')
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      ...fakeFs({ '/media': ['/media/Show/E01.mkv'] }),
      inspectEveryMs: Number.MAX_SAFE_INTEGER,
      maintenanceTickMs: 30_000,   // 不唤醒就得等 30 秒 → 用例超时/断言空
      sleep: undefined,
    }))
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(1_000_000_000_000))

    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 20))
    expect(pathsInDb(db), '前提：此刻主循环已经睡下了，files 仍空').toEqual([])

    daemon.requestScan()
    await new Promise(r => setTimeout(r, 100))   // ≪ 30s：只有被唤醒才来得及
    expect(pathsInDb(db), '🔴 请求后 100ms 内就该扫完——没唤醒的话这里还是空的').toEqual(['/media/Show/E01.mkv'])

    ctrl.abort()
    await p
    db.close()
  })

  it('🔴 幂等：连点 N 次只换来一轮扫描（加根 UI 的"猴子动作"不许放大成 N 轮走盘）', async () => {
    const db = openDb(':memory:')
    const walks: string[] = []
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: (root: string) => { walks.push(root); return ['/media/Show/E01.mkv'] },
      fileExists: () => true,
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
      inspectEveryMs: Number.MAX_SAFE_INTEGER,
      maintenanceTickMs: 1,
      sleep: undefined,
    }))
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(1_000_000_000_000))

    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 20))
    const before = walks.length

    // 同一拍里连按 5 次（防抖之外的第二道保险）。
    for (let i = 0; i < 5; i++) daemon.requestScan()
    await new Promise(r => setTimeout(r, 60))
    ctrl.abort()
    await p

    expect(walks.length - before, '5 次请求折叠成 1 轮走盘').toBe(1)
    db.close()
  })

  it('🔴 带外扫描抛错 → 隔离，主循环照常活着（它只是"早一点扫到"的增益）', async () => {
    // ⚠️ 靶子选择：不能用"走盘抛错"来制造这个场景——scanOnce 内部**逐根隔离**（防线 4/D1），
    // 单个根 walk 失败会被它自己接住并记进 media_roots.last_error，根本不冒到带外那层
    // try/catch。实测过：那样写这条恒绿（日志里是"跳过删除"而不是"带外扫描失败"），
    // 是一条测不到任何东西的假用例。改用 **pass 级**爆炸（statFile 抛错，穿过逐根隔离）。
    const db = openDb(':memory:')
    const logs: string[] = []
    let ticks = 0
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => { throw new Error('boom') },
      fileExists: () => true,
      inspectEveryMs: Number.MAX_SAFE_INTEGER,
      maintenanceTickMs: 1,
      sleep: undefined,
      log: (m: string) => logs.push(m),
      dbMaintenance: () => { ticks++ },
    }))
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(1_000_000_000_000))

    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise(r => setTimeout(r, 20))
    daemon.requestScan()
    await new Promise(r => setTimeout(r, 40))
    const ticksAfter = ticks
    await new Promise(r => setTimeout(r, 40))
    ctrl.abort()
    await p

    expect(logs.some((l) => l.includes('带外扫描失败')), '失败必须留痕（静默吞掉是本仓反面清单第一条）').toBe(true)
    expect(ticks, '主循环在带外扫描抛错之后仍在走拍').toBeGreaterThan(ticksAfter)
    db.close()
  })

  it('🔴 isScanning()：扫描期间为 true，扫完（含抛错）回落 false', async () => {
    // realignLibraryPort.getScheduledTasks 读它 → realignExecutor 的 waitForIngestIdle
    // 靠它实现"扫描中不许挪文件"。**卡住不回落**的后果是 realign 从此永远等不到 idle
    // 且完全静默——所以抛错路径这一半必须单独钉。
    const db = openDb(':memory:')
    const seen: boolean[] = []
    // ⚠️ 走盘必须返回**非空**：空结果会触发 R8 第二道闸的当场重试（C46），listVideoFiles
    // 被调 3 次，seen 就成了 [true,true,true]——断言写成 toEqual([true]) 会因为这个与
    // isScanning 毫不相干的原因变红。实测踩过一次，故这里给一个真文件。
    const ok = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: () => { seen.push(ok.isScanning()); return ['/media/Show/E01.mkv'] },
      fileExists: () => true,
      statFile: () => ({ mtimeMs: 1000, size: BIG }),
    }))
    expect(ok.isScanning(), '扫描前 false').toBe(false)
    await scan(ok)
    expect(seen, '扫描进行中（走盘回调里看自己）为 true').toEqual([true])
    expect(ok.isScanning(), '扫描后回落 false').toBe(false)

    // 抛错侧同样不能用"走盘抛错"（逐根隔离会接住，scanOnce 正常返回 → 这一半恒绿）。
    // 用 pass 级爆炸（statFile 抛错）才真的穿到 scanOnce 外面。
    const bad = new ScoutDaemonV2(mkDeps(db, {
      roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => { throw new Error('EIO') },
      fileExists: () => true,
    }))
    await expect(scan(bad)).rejects.toThrow('EIO')
    expect(bad.isScanning(), '🔴 抛错路径也必须由 finally 释放，否则 realign 永久等待').toBe(false)
    db.close()
  })
})
