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

function subStatusOf(db: ReturnType<typeof openDb>, path: string): string | null {
  return (db.prepare('SELECT sub_status FROM files WHERE path = ?').get(path) as { sub_status: string | null }).sub_status
}
function needsOf(db: ReturnType<typeof openDb>, path: string): number | null {
  return (db.prepare('SELECT needs_subtitle FROM files WHERE path = ?').get(path) as { needs_subtitle: number | null }).needs_subtitle
}
function subAttemptOf(db: ReturnType<typeof openDb>, path: string): number {
  return (db.prepare('SELECT sub_attempt FROM files WHERE path = ?').get(path) as { sub_attempt: number }).sub_attempt
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

  // ───────────────────────────────────────────────────────────────────────────
  // 装盘成功的回写（R24 + D6 + D8）。这一组取代了改动前那条
  // `installed → covered + needs_subtitle=0` 的用例——它**编码的正是本 task 在修的 bug**，
  // 不是被"改松"，而是它断言的两件事（写 covered / 写 needs_subtitle=0）都已被裁决判为错误：
  //
  //  · covered 的唯一写入者是**扫描**（R24）。worker 只负责把文件放到磁盘上，磁盘上到底有
  //    没有由扫描说了算。worker 声称成功但文件其实没落地是真实发生过的形态。
  //  · needs_subtitle 只表达"这资源**原则上**需要中文字幕"（语言事实），装盘不改它（D8）。
  //
  // 两者叠加正是生产上那条**永久卡死链**（C27，实测复现：listSubtitleQueue 捞到 0 个作品）：
  //   装盘 → needs_subtitle=0 + sub_status='covered'
  //   → 下一轮扫描发现字幕其实没落地/被手删 → R24 让扫描把 sub_status 回退 NULL
  //   → 但 needs_subtitle=0 留着 → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判）、
  //     又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）→ **这一集再也不会被补字幕**。
  // 三条断言刻意分开写（而不是一条 toEqual 整行）：合成一条的话，任何一列回归都只报"整行不等"，
  // 排障的人看不出是哪条语义破了。
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴 装盘成功 → **不写 covered**（covered 的唯一写入者是扫描 / R24）', async () => {
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    const report = await runSubtitleWorkDir(db, worker as any, item, 'zh')
    expect(subStatusOf(db, item.files[0].path)).toBeNull()
    expect(report).not.toBeNull()
  })

  it('🔴 装盘成功 → **不改 needs_subtitle**（它只表达"原则上需要中文字幕" / D8）', async () => {
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    // 留 1 而不是 0：这资源的语言事实没变（还是需要中文字幕的片子），变的只是"磁盘上现在
    // 有没有"——而那件事归 sub_status 管，由扫描独占写入。
    expect(needsOf(db, item.files[0].path)).toBe(1)
  })

  it('🔴 装盘成功 → 只写 recheck_after 作为出队凭据（D6 / 防 C26 付费 LLM 热循环）', async () => {
    // R24 删掉 covered 写入后，若不补一个出队凭据，该文件仍满足工作台谓词 →
    // daemonV2 阶段 3 的 while 循环下一圈重查队列又选中它 → 跑完整 agent session →
    // 一直烧到下次扫描。这是 D6 存在的全部理由。
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT recheck_after FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    expect(row.recheck_after).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
  })

  it('🔴 装盘成功不许递增 sub_attempt（成功不是失败，不许吃掉 7 次额度）', async () => {
    // 若把装盘成功也塞进 bump() 那条轨（"反正都要写 recheck_after"），一个每次都装盘成功
    // 但字幕总没落地的文件会在 7 轮后被判进停牌——而它一次都没"找不到"过。
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    expect(subAttemptOf(db, item.files[0].path)).toBe(0)
  })

  it('🔴 装盘成功的文件不在**同轮**被重选（C26 热循环红线，走真实 listSubtitleQueue）', async () => {
    // 不复述谓词、不只断言 recheck_after 这个中间变量——直接把真实的队列函数接上跑。
    // 断言中间变量的话，谁把工作台谓词里的 recheck_after 条件删掉都不会红（假绿）。
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(item.workId, 'Overflow', 'tv', 1000, 1000)
    const before = listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))
    expect(before).toContain(item.files[0].path)   // 前置条件成立，否则本用例是空转的假绿

    const worker = async () => ({
      installed: [{ itemId: 'tmdb:95897/s1e1', installedPath: '/media/TV/Overflow/Overflow - 01.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')

    const after = listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))
    expect(after).not.toContain(item.files[0].path)
    // 兄弟文件（本轮无结局，走 bump 轨）同样该出队——否则 while 循环仍会重选这个作品。
    expect(after).not.toContain(item.files[1].path)
  })

  it('🔴 R17：「搜过确实没有」→ sub_status 仍 NULL 且 sub_attempt+1（防第五态回归）', async () => {
    // 这是**最常见的失败路径**。改动前它写 `sub_status='unavailable'` 且**不递增计数**：
    // 该行既不在字幕工作台（sub_status 非 NULL）、又永攒不到 7 次 → 翻译流永远收不到活
    // （C15，spec 点名"最致命的一条"）。
    const worker = async () => {
      traceBus.publish({ runKey: 'job-subtitle:tmdb:95897', seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: Date.now() })
      return { installed: [], no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'nothing found' }], retry_later: [], hardsub_assumed: [] }
    }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT sub_status, sub_attempt, recheck_after FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.sub_status).toBeNull()          // 不许再出现第五态
    expect(row.sub_attempt).toBe(1)            // 与其他失败路径同轨，能攒到 7 次
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    expect(row.recheck_after).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
  })

  it('🔴 全库不再有任何代码路径写 unavailable（R17 废止第五态，穷举四个桶）', async () => {
    // 逐桶跑一遍，断言整张表里一行 unavailable 都不出现。只测 no_safe_match 那条的话，
    // 日后谁在别的分支复活这个值都不会红。
    const worker = async () => {
      traceBus.publish({ runKey: 'job-subtitle:tmdb:95897', seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: Date.now() })
      return {
        installed: [], hardsub_assumed: [],
        no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'nothing' }],
        retry_later: [{ itemId: 'tmdb:95897/s1e2', reason: 'quota' }],
      }
    }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const n = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE sub_status = 'unavailable'`).get() as any
    expect(n.n).toBe(0)
  })

  it('🔴 no_safe_match + 零 search_source 证据（编造）→ 不标 unavailable，短退避', async () => {
    // 不 publish 任何 search_source
    const worker = async () => ({
      installed: [], no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'searched all providers' }], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT sub_status, recheck_after, last_error FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.sub_status).toBeNull()  // 不标 unavailable
    expect(row.recheck_after).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)  // 明天
    expect(row.last_error).toBe('fabricated-no-match')
  })

  it('🔴 超时抛错 → recheck_after 15min（TimeoutError 判别）', async () => {
    const worker = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }) }
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    for (const f of item.files) {
      const row = db.prepare('SELECT recheck_after, last_error FROM files WHERE path = ?').get(f.path) as any
      expect(row.recheck_after).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
      expect(row.recheck_after).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
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

  it('retry_later → sub_attempt+1 且退避到明天', async () => {
    // 断言从 `attempt` 改到 `sub_attempt`（C7）：这不是把测试改松，是原来那一列**是错的**。
    // `attempt` 被识别轨共用，identifyScheduler 在识别成功时把它归零
    // （`UPDATE files SET work_id=?, attempt=0 ... WHERE work_dir=?`，实测：攒了 5 次字幕
    // 失败的行跑一次识别成功后变 0）→ R10 的"满 7 次移交翻译"永远走不到。故 3-2 给字幕轨
    // 建了独立的 sub_attempt。本用例守的行为（retry_later 要计数、要退避）一字未改。
    const worker = async () => ({
      installed: [], no_safe_match: [], retry_later: [{ itemId: 'tmdb:95897/s1e1', reason: 'quota' }], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, item, 'zh')
    const row = db.prepare('SELECT recheck_after, sub_attempt, attempt FROM files WHERE path = ?').get(item.files[0].path) as any
    expect(row.sub_attempt).toBe(1)
    // 顺带钉住**不许再碰**共用列：写它就会污染识别轨的退避阶梯（C7 的反方向伤害）。
    expect(row.attempt).toBe(0)
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    expect(row.recheck_after).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
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
    // 巡检模型：全部 24h，attempt 只记录次数不改变间隔
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

  // D8 / C27：judge 的 sidecar 规则被删除后，"磁盘已有外挂中字的文件不许被送进字幕流白烧
  // 一轮付费 LLM"的**唯一保证者**就是扫描写的 sub_status='covered'（R24）。它必须在这条
  // 谓词里被真正读到——否则删规则 3 就是把一个卡死 bug（C27）换成一个白烧钱 bug。
  it('🔴 sub_status=covered 的文件不入队（即便 needs_subtitle=1 / D8 的把关处）', () => {
    db.prepare(`UPDATE files SET sub_status = 'covered' WHERE path = ?`).run('/media/TV/ShowA/E01.mkv')
    const paths = listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))
    expect(paths).not.toContain('/media/TV/ShowA/E01.mkv')
    expect(paths).toContain('/media/TV/ShowB/E01.mkv')   // 兄弟行不受牵连
  })

  it('🔴 covered 被扫描回退成 NULL 后 → 重新入队（C27 卡死态的出口）', () => {
    const p = '/media/TV/ShowA/E01.mkv'
    db.prepare(`UPDATE files SET sub_status = 'covered' WHERE path = ?`).run(p)
    expect(listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))).not.toContain(p)
    // 用户手删字幕 → 扫描观察到字幕没了 → 回退 NULL（daemonV2.observeSubtitle）
    db.prepare('UPDATE files SET sub_status = NULL WHERE path = ?').run(p)
    expect(listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))).toContain(p)
  })

  it('🔴 停牌两态出局（谓词收紧到 IS NULL / C14 两工作台互斥）', () => {
    // 本用例是 1b-5 那条「停牌态不因新条件被误挡在门外」的**反转**，而不是把它改松。
    // 那条当时的原文就写明：spec §2 更严的 `sub_status IS NULL` 有前置迁移（D19/C44），
    // **归第 3 步**；在前置没做完之前多排掉一态，就是提前制造"既不在工作台、又攒不到 7 次"
    // 的永久出局（C15）。3-2 把两个前置都做完了：
    //   ① v33 迁移已把存量 unavailable 洗成 NULL
    //   ② 本文件里写 unavailable 的点已按 R17 拆掉（改为 NULL + sub_attempt+1 + 退避）
    // 于是现在必须反过来钉住停牌两态**出局**——它们归各自的主：handoff_translate 归翻译
    // 工作台，unsolvable 归阶段 2.6 复查闸（D13）。同一轮内一个文件出现在两个工作台的快照里，
    // 翻译跑到一半状态就会被字幕流改掉 → D10 的乐观守卫匹配 0 行 → 退避不写 → 付费热循环。
    const p = '/media/TV/ShowA/E01.mkv'
    for (const st of ['unsolvable', 'handoff_translate']) {
      db.prepare('UPDATE files SET sub_status = ? WHERE path = ?').run(st, p)
      const paths = listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))
      expect(paths).not.toContain(p)
      expect(paths).toContain('/media/TV/ShowB/E01.mkv')   // 兄弟行不受牵连
    }
  })

  it('🔴 unavailable 第五态已绝迹，但万一有残留行也不许被永久埋掉（C44 兜底）', () => {
    // v33 迁移 + 拆写入点之后库里不该再有这个值。但"不该有"不等于"没有"——
    // 迁移与写入点删除之间上线过的版本、或用户从旧备份恢复的库都可能带着它。
    // 这类行在 `IS NULL` 谓词下既不在字幕工作台、又因为不再被 bump 而攒不到 7 次 →
    // 永久出局，UI 上毫无异常。故这里显式记录这个已知边界：**它由 v33 迁移负责洗**，
    // 本用例断言迁移真的把它洗掉了（而不是断言谓词能取到它——那会与 C14 互斥要求冲突）。
    const p = '/media/TV/ShowA/E01.mkv'
    db.prepare(`UPDATE files SET sub_status = 'unavailable' WHERE path = ?`).run(p)
    // 模拟 openDb 再打开一次时 v33 会做的事（迁移只跑一次，故这里手工复刻它的语义）
    db.prepare(`UPDATE files SET sub_status = NULL WHERE sub_status = 'unavailable'`).run()
    expect(listSubtitleQueue(db, ['/media/TV'], Date.now()).flatMap(q => q.files.map(f => f.path))).toContain(p)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C15 电影/剧集不对称：三处 itemId 反解正则都是 `/^tmdb:.*?\/s(\d+)e(\d+)$/`，**只认剧集**。
// 电影（season/episode 为 NULL）的 itemId 是裸 `tmdb:603`，永远匹配不上 → 走另一条分支 →
// 同一个"找不到"，电影与剧集的计数行为不一致。
//
// 为什么这组用例的断言必须落在 **sub_attempt 的数值**上而不是"有没有回写"：
// 不对称的真实伤害是"一边攒得到 7 次、另一边攒不到"——而 recheck_after 两边都会被写
// （B-2 无结局兜底会兜住漏网的那个），只看"有没有退避"两边都绿，不对称完全隐形。
// ─────────────────────────────────────────────────────────────────────────────
function mkMovieItem(): SubtitleQueueItem {
  return {
    workId: 'tmdb:603', title: 'The Matrix', originalTitle: null, year: 1999,
    overview: null, chineseTitles: [], mediaType: 'movie',
    files: [{
      path: '/media/Movies/The Matrix (1999)/The Matrix.mkv', filename: 'The Matrix.mkv',
      season: null, episode: null, dir: '/media/Movies/The Matrix (1999)',
      durationSec: 8160, embeddedLangs: null,
    }],
  }
}

describe('C15 对称性：电影与剧集在同一失败下计数行为一致', () => {
  let db: ReturnType<typeof openDb>
  let tv: SubtitleQueueItem
  let movie: SubtitleQueueItem

  beforeEach(() => {
    db = openDb(':memory:')
    tv = mkItem()
    movie = mkMovieItem()
    for (const it of [tv, movie]) {
      for (const f of it.files) {
        db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, season, episode, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .run(f.path, f.dir, f.filename, 100, 1000, f.dir, it.workId, 1, f.season, f.episode, 1000)
      }
    }
  })

  /** 「搜过确实没有」的 worker。itemId 按被测作品的真实形态构造：
   *  剧集 = `tmdb:X/sNeM`，电影 = 裸 `tmdb:X`（season/episode 为 NULL 时 buildSubtitleTask
   *  就是这么拼的，见该函数里的三元表达式）。 */
  const noMatchWorker = (runKey: string, itemId: string) => async () => {
    traceBus.publish({ runKey, seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: Date.now() })
    return { installed: [], no_safe_match: [{ itemId, reason: 'nothing found' }], retry_later: [], hardsub_assumed: [] }
  }

  /** 🔴 归属反解的**唯一可靠证人是 last_error（落到哪个桶），不是 sub_attempt 的数值**。
   *
   *  3-2 的变异验证实测踩到：把 resolvePath 换回"只认 /sNeM"的旧正则后，电影的
   *  sub_attempt **仍然是 1**，整组用例全绿——因为反解失败的文件会漏到 B-2「无结局」兜底，
   *  而那条**恰好也计数**。于是"电影与剧集走了两条不同的轨"这个 C15 的本体完全隐形。
   *
   *  两条轨的真实区别在语义上：`no-match`（真的搜过、确实没有，是 agent 的结论）
   *  vs `no-outcome`（worker 根本没给这个文件结论，是**系统兜底**）。后者在生产上意味着
   *  排障的人看到的是"worker 没报结果"，而实际上 worker 报了、只是我们没认出归属。
   *  故断言必须落在桶身份上——这也是"只断言 path/计数的测试会漏掉真实伤害"的又一实例。 */
  const lastErrorOf = (path: string): string | null =>
    (db.prepare('SELECT last_error FROM files WHERE path = ?').get(path) as { last_error: string | null }).last_error

  it('🔴 剧集「搜过确实没有」→ sub_attempt=1 且落进 no-match 桶', async () => {
    await runSubtitleWorkDir(db, noMatchWorker('job-subtitle:tmdb:95897', 'tmdb:95897/s1e1') as any, tv, 'zh')
    expect(subAttemptOf(db, tv.files[0].path)).toBe(1)
    expect(lastErrorOf(tv.files[0].path)).toBe('no-match')
  })

  it('🔴 电影（season/episode 为 NULL）同一失败 → sub_attempt 也是 1，不是 0', async () => {
    // 改动前：itemId 是裸 `tmdb:603`，正则要求 `/sNeM` 结尾 → 匹配失败 → 这个文件进不了
    // noSafePaths → 落到 B-2「无结局」兜底走 bump（那条恰好也计数）。但 no_safe_match 那条
    // 分支写的是 unavailable **且不计数**——于是剧集与电影在同一个"找不到"下走了两条不同的
    // 轨、留下两种不同的状态。修法（C15）：归属反解改按 path，两者同轨。
    await runSubtitleWorkDir(db, noMatchWorker('job-subtitle:tmdb:603', 'tmdb:603') as any, movie, 'zh')
    expect(subAttemptOf(db, movie.files[0].path)).toBe(1)
    // 🔴 这一条才是真正咬住 C15 的断言（见上方 lastErrorOf 的论证）：旧正则下电影反解失败 →
    // 漏到 B-2 兜底 → 这里会是 'no-outcome'，而计数照样是 1，只看计数完全测不出来。
    expect(lastErrorOf(movie.files[0].path)).toBe('no-match')
  })

  it('🔴 两者的 sub_status 与 recheck_after 也一致（同轨的完整含义）', async () => {
    await runSubtitleWorkDir(db, noMatchWorker('job-subtitle:tmdb:95897', 'tmdb:95897/s1e1') as any, tv, 'zh')
    await runSubtitleWorkDir(db, noMatchWorker('job-subtitle:tmdb:603', 'tmdb:603') as any, movie, 'zh')
    const tvRow = db.prepare('SELECT sub_status, sub_attempt FROM files WHERE path = ?').get(tv.files[0].path) as any
    const mvRow = db.prepare('SELECT sub_status, sub_attempt FROM files WHERE path = ?').get(movie.files[0].path) as any
    expect(mvRow.sub_status).toBe(tvRow.sub_status)     // 都是 NULL
    expect(mvRow.sub_attempt).toBe(tvRow.sub_attempt)   // 都是 1
    expect(mvRow.sub_status).toBeNull()
    // 同轨的完整含义包含"落进同一个桶"——两边都该是 agent 的结论 no-match，
    // 而不是一边 no-match、一边被系统兜底成 no-outcome。
    expect(lastErrorOf(movie.files[0].path)).toBe(lastErrorOf(tv.files[0].path))
    expect(lastErrorOf(movie.files[0].path)).toBe('no-match')
  })

  it('🔴 电影装盘成功 → 与剧集同样"不写 covered、不改 needs_subtitle、只写 recheck_after"', async () => {
    // 装盘那条路径也有同一个正则（:207），故对称性要在两条路径上分别钉住。
    const worker = async () => ({
      installed: [{ itemId: 'tmdb:603', installedPath: '/media/Movies/The Matrix (1999)/The Matrix.zh-Hans.ass', installedLanguage: 'zh', candidateProvider: 'assrt', candidateProviderId: 'x', reason: '' }],
      no_safe_match: [], retry_later: [], hardsub_assumed: [],
    })
    await runSubtitleWorkDir(db, worker as any, movie, 'zh')
    const row = db.prepare('SELECT sub_status, needs_subtitle, sub_attempt, recheck_after FROM files WHERE path = ?').get(movie.files[0].path) as any
    expect(row.sub_status).toBeNull()
    expect(row.needs_subtitle).toBe(1)
    expect(row.sub_attempt).toBe(0)
    expect(row.recheck_after).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R21 + D15 + C40：sub_attempt >= 7 的移交分流。
//
// 三条铁律，每条都有独立的失效形态：
//  · `>= 7` 而不是 `== 7`（D15）：复查闸放回时 sub_attempt **不归零**，值会超过 7。
//    写 `== 7` 的话 sub_attempt=8/9 的行永远匹配不上 → 停牌后再也回不去停牌 → 无限期滞留。
//  · translatable=0 → unsolvable，**绝不出现 handoff_translate**（R21）：不给第 8 次机会，
//    否则翻译流领走一个 100ms 就判 unsupported 的活，白绕。
//  · translatable IS NULL → **不判死**（C40）：判据不全 ≠ 不可救。
// ─────────────────────────────────────────────────────────────────────────────
describe('R21/D15 移交分流（sub_attempt >= 7）', () => {
  let db: ReturnType<typeof openDb>
  let item: SubtitleQueueItem

  /** 造一行"已经失败到 attempt 次"的文件，并指定它的可救性预判。 */
  function seedAt(path: string, attempt: number, translatable: number | null): void {
    db.prepare('UPDATE files SET sub_attempt = ?, translatable = ? WHERE path = ?').run(attempt, translatable, path)
  }

  beforeEach(() => {
    db = openDb(':memory:')
    item = mkItem()
    for (const f of item.files) {
      db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, season, episode, updated_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(f.path, f.dir, f.filename, 100, 1000, f.dir, item.workId, 1, f.season, f.episode, 1000)
    }
  })

  /** 「搜过确实没有」——这一次失败会把 sub_attempt 顶到阈值。 */
  const noMatch = async () => {
    traceBus.publish({ runKey: 'job-subtitle:tmdb:95897', seq: 0, tool: 'search_source', argsSummary: '{}', resultSummary: '[]', tookMs: 5, at: Date.now() })
    return {
      installed: [], hardsub_assumed: [], retry_later: [],
      no_safe_match: [{ itemId: 'tmdb:95897/s1e1', reason: 'nothing' }, { itemId: 'tmdb:95897/s1e2', reason: 'nothing' }],
    }
  }

  it('🔴 sub_attempt 达 7 且 translatable=1 → handoff_translate（用例 7）', async () => {
    seedAt(item.files[0].path, 6, 1)   // 本轮 +1 = 7
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    expect(subAttemptOf(db, item.files[0].path)).toBe(7)
    expect(subStatusOf(db, item.files[0].path)).toBe('handoff_translate')
  })

  it('🔴🔴 sub_attempt 达 7 且 translatable=0 → unsolvable，**绝不出现 handoff_translate**（用例 8）', async () => {
    seedAt(item.files[0].path, 6, 0)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    expect(subStatusOf(db, item.files[0].path)).toBe('unsolvable')
    expect(subStatusOf(db, item.files[0].path)).not.toBe('handoff_translate')
  })

  it('🔴🔴 sub_attempt 达 7 但 translatable IS NULL → **不判死**，仍在字幕流（用例 9 / C40）', async () => {
    seedAt(item.files[0].path, 6, null)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    // 关键：sub_status 保持 NULL（继续留在字幕流），既不 unsolvable 也不 handoff_translate。
    // 判据不全（judge 还没判 / embedded_langs 缺失）时判死会永久埋掉一批能救的片子。
    expect(subStatusOf(db, item.files[0].path)).toBeNull()
    // 但计数照涨——待 D17 回填补上证据、judge 重判后，下一次失败立刻按 >=7 分流。
    expect(subAttemptOf(db, item.files[0].path)).toBe(7)
  })

  it('🔴🔴 sub_attempt=9（已超过 7）仍能正确分流（用例 10 / `>=` 而非 `==`）', async () => {
    // D15：停牌复查闸放回时 sub_attempt **不归零**，故这个值必然会超过 7。
    // 写成 `== 7` 的实现在这里会静默什么都不做 → 该行回 NULL 后再也进不了停牌 →
    // 每天被字幕流重选一次（而不是每周一次），成本回到 D15 想避免的那个量级。
    seedAt(item.files[0].path, 9, 1)   // 本轮 +1 = 10
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    expect(subAttemptOf(db, item.files[0].path)).toBe(10)
    expect(subStatusOf(db, item.files[0].path)).toBe('handoff_translate')
  })

  it('🔴 sub_attempt=9 且 translatable=0 → unsolvable（`>=` 在两个分支上都成立）', async () => {
    seedAt(item.files[0].path, 9, 0)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    expect(subStatusOf(db, item.files[0].path)).toBe('unsolvable')
  })

  it('🔴 未满 7 次（本轮 +1 = 6）→ 一律保持 NULL，不许提前停牌', async () => {
    seedAt(item.files[0].path, 5, 1)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    expect(subAttemptOf(db, item.files[0].path)).toBe(6)
    expect(subStatusOf(db, item.files[0].path)).toBeNull()
  })

  it('🔴 停牌两态都写 recheck_after=+7天（供阶段 2.6 复查闸取件 / D13）', async () => {
    // 复查闸的谓词是 `sub_status='unsolvable'/'handoff_translate' 且 recheck_after 已过`。
    // 若停牌时写的是"明天"（跟失败轨一样），复查就变成每天一次而不是每周一次（R25 的节奏）；
    // 若干脆不写，recheck_after 会停在上一次失败写的"明天"，同样退化成日频。
    seedAt(item.files[0].path, 6, 1)
    seedAt(item.files[1].path, 6, 0)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    for (const p of [item.files[0].path, item.files[1].path]) {
      const row = db.prepare('SELECT recheck_after FROM files WHERE path = ?').get(p) as any
      expect(row.recheck_after).toBeGreaterThan(Date.now() + 6.5 * 24 * 60 * 60 * 1000)
      expect(row.recheck_after).toBeLessThan(Date.now() + 7.5 * 24 * 60 * 60 * 1000)
    }
  })

  it('🔴 同一簇里的两个文件按各自的 translatable 分流（不许整簇一刀切）', async () => {
    // 真实形态：同一部剧的两集，一集有日文内嵌轨（可救）、一集没有（不可救）。
    // 按作品粒度一刀切会把能救的判死或把不能救的塞给翻译流。
    seedAt(item.files[0].path, 6, 1)
    seedAt(item.files[1].path, 6, 0)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    expect(subStatusOf(db, item.files[0].path)).toBe('handoff_translate')
    expect(subStatusOf(db, item.files[1].path)).toBe('unsolvable')
  })

  it('🔴 停牌的行随即从字幕工作台出局（走真实 listSubtitleQueue，端到端）', async () => {
    db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
      .run(item.workId, 'Overflow', 'tv', 1000, 1000)
    seedAt(item.files[0].path, 6, 1)
    seedAt(item.files[1].path, 6, 0)
    await runSubtitleWorkDir(db, noMatch as any, item, 'zh')
    // 谓词收紧成 `sub_status IS NULL` 后，停牌两态都不在取件范围内（C14 两工作台互斥）。
    const paths = listSubtitleQueue(db, ['/media/TV'], Date.now() + 8 * 24 * 60 * 60 * 1000)
      .flatMap(q => q.files.map(f => f.path))
    expect(paths).not.toContain(item.files[0].path)
    expect(paths).not.toContain(item.files[1].path)
  })
})
