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
import { ScoutEventBus, type ScoutEventInput } from '../core/scoutEvents.js'

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
    expect(got.find((e) => e.message.includes('巡检开始'))?.data).toEqual({ inspectRound: 'start' })
    expect(got.find((e) => e.message.includes('巡检完成'))?.data).toEqual({ inspectRound: 'end' })
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
    // Task ⓪ 审计 🔴-1：字段加了但没人读——实测把 daemonV2 的 7 个 workbench 全删光，
    // 3229 条测试无一变红、tsc 也过。那是本仓第 11 次「加了能力没定谁写/谁读/谁触发」。
    // 这条断言就是缺失的那个读者：删掉写入点，这里立刻红。
    expect(act.find((e) => e.message.includes('字幕'))?.workbench).toBe('subtitle')
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
    expect(found[0].workbench).toBe('subtitle')
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
    const prog = got.filter((e) => e.type === 'progress')
    expect(prog.length).toBeGreaterThan(0)
    // Task ⓪：progress 是 per-workbench 节流的**唯一**依据。这个字段一旦没填，
    // 总线会把三个工作台的进度当成同一路互相吃掉，而且不报任何错。
    expect(prog.every((e) => e.workbench === 'subtitle')).toBe(true)
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
    // Task ⓪：workbench 的值域同样必须封闭在三态。撑成五态（塞 'inspect'/'scan'）
    // 会让 current.kind 对不上——设计裁决是「巡检级/扫描级一律不填，判别靠 undefined」。
    for (const e of got) {
      if (e.workbench !== undefined) expect(['identify', 'subtitle', 'translate']).toContain(e.workbench)
    }
    // 巡检级的两条（巡检开始/完成）不属于任何工作台，必须不填——它们要是填了，
    // 前端按 workbench 分组时会凭空多出一个不存在的工作台。
    const patrol = got.filter((e) => e.message.includes('巡检开始') || e.message.includes('巡检完成'))
    expect(patrol.length).toBeGreaterThan(0)
    expect(patrol.every((e) => e.workbench === undefined)).toBe(true)
    expect(patrol.find((e) => e.message.includes('巡检开始'))?.data).toEqual({ inspectRound: 'start' })
    expect(patrol.find((e) => e.message.includes('巡检完成'))?.data).toEqual({ inspectRound: 'end' })
    db.close()
  })

  it('🔴 工作台收工必须发无 workbench 的 activity（审计 🔴-2：跨阶段脏值 = F-6 的同型复发）', async () => {
    // 阶段 2 识别循环结束 → judge（大库上分钟级）→ 停牌复查闸 → 阶段 3 字幕循环，
    // 中间**两段无 emit**。没有收工事件的话，ScoutEventBus 的 current 会一直停在
    // 最后一个识别的作品上，/api/v2/health 在这几分钟里说「正在识别 W9，第 47/47 个」
    // ——而识别台早已空了。这正是 F-6 那个缺陷，只是尺度从"跨巡检"缩到"跨阶段"。
    //
    // 判据：收工事件**不带 workbench**（归巡检级），总线据此清空 current。
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const { got } = mkEmit()
    const bus = new ScoutEventBus()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit: (e: ScoutEventInput) => { got.push(e as any); bus.publish(e) },
      roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    const done = got.filter((e) => e.message.includes('字幕工作台跑完'))
    expect(done).toHaveLength(1)
    expect(done[0].workbench).toBeUndefined()
    // 端到端的真正判据：巡检跑完后总线的 current 必须是 null，不许停在最后一个作品上
    expect(bus.getCurrent()).toBeNull()
    db.close()
  })

  it('🔴 R-F1 的执行前提：识别的 activity 必须带 workbench=identify（前端据此把它剔出活动页）', async () => {
    // ── 这条用例存在的理由（Task ⓪ 审计 🔴-2）─────────────────────────────────
    // R-F1「识别不进活动页」与生产代码正在推识别 activity 直接冲突（IMPL-DESIGN 教训七：
    // 两条裁决相隔 9 行，作者同时引用却没发现）。
    //
    // 裁决是三件事的组合：① 保留 emit（识别失败要能看见）② 打标 ③ 前端据标剔除。
    // ③ 的执行方在 Task ⑨，今天还不存在。**但 ② 一旦静默失效，③ 就永远无法正确实现**——
    // 前端会看到一条没有 workbench 的 activity，只能按"某个工作台"渲染，R-F1 当场违反。
    // 故在这里钉死 ②：识别的 activity 必须可被机器识别为识别。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, updated_at)
                VALUES ('/media/New/x.mkv','/media/New','x.mkv',?,1000,'/media/New',NULL,1,1000)`).run(BIG)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/New/x.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    // ⚠️ 用「正在识别」而不是「识别」：阶段收工事件的文案是「识别完成，处理了 N 个目录」，
    // 那是**巡检级**的（不带 workbench，见上一条用例），拿宽松的 includes('识别') 会把它捞进来。
    const ident = got.filter((e) => e.type === 'activity' && e.message.includes('正在识别'))
    // 若哪天识别不再推 activity（R-F1 的另一种合规实现），这条用例应当随之删除而不是放宽；
    // 故这里先断言"确实推了"，把"悄悄不推了"也变成一次可见的失败。
    expect(ident.length).toBeGreaterThan(0)
    expect(ident.every((e) => e.workbench === 'identify')).toBe(true)
    db.close()
  })

  it('🔴 R-F13 取图前提：字幕台的 activity/progress 必须带 data.workId（前端据它查横版图）', async () => {
    // ── 这条用例存在的理由（Task ⑨）──────────────────────────────────────────
    // R-F13 的「在跑」卡片要一张横版 backdrop。图片路径**不进事件通道**（静态资料随每条
    // 事件重复推是浪费），前端拿 workId 去 GET /api/v2/activity 那份作品身份表里查。
    //
    // 备选是让前端拿 `title` 字符串去匹配——否掉的理由是它**静默错位**：同名作品（不同
    // 年份的翻拍）与中文译名切换都会让匹配落到另一部剧上，表现为"卡片配了别人的图"，
    // 而这在测试里几乎照不出来。故判据必须是 id。
    //
    // 这个字段是本仓典型的"加了没人读会静默失效"形态：漏填不报错、tsc 不管
    // （data 是 Record<string, unknown>），前端只会退化成无图降级——而无图降级路径本来
    // 就存在且合法。故在发布方这一侧钉死。
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))

    const subAct = got.filter((e) => e.type === 'activity' && e.workbench === 'subtitle')
    expect(subAct.length).toBeGreaterThan(0)
    // seedSubtitleWork 种的作品 id 就是 'tmdb:42'——**不在这里复述一个字面量常量**的
    // 反面：这个值是 seed helper 的一部分，两处写死同一个串正是本仓 D7 的形态。
    // 但它同时是本条断言的全部内容（"带对了 id"），故取库里的真值来比对。
    const workId = (db.prepare('SELECT work_id FROM files WHERE path = ?')
      .get('/media/Show/E01.mkv') as { work_id: string }).work_id
    expect(subAct.every((e) => e.data?.workId === workId)).toBe(true)

    const subProg = got.filter((e) => e.type === 'progress' && e.workbench === 'subtitle')
    expect(subProg.length).toBeGreaterThan(0)
    expect(subProg.every((e) => e.data?.workId === workId)).toBe(true)
    // progress 的 done/total 是本作品的文件 tick（先 0/N，每成功装一条 +1），
    // 不是字幕队列里的作品下标。ScoutEventBus.updateCurrent 只认这两个键——加
    // workId / backdropPath / chineseTitle 不许把它们挤掉（否则 /health 的
    // current.index/total 双双变 null）。
    expect(subProg.every((e) => typeof e.data?.done === 'number' && typeof e.data?.total === 'number')).toBe(true)
    expect(subProg[0]?.data?.done).toBe(0)
    expect(subProg[0]?.data?.total).toBe(1)
    db.close()
  })

  it('🔴 同作品两文件：首帧 progress 是 0/2，不许发作品队列下标 1/1', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    seedSubtitleWork(db, '/media/Show/E02.mkv', 2)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv', '/media/Show/E02.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    const prog = got.filter((e) => e.type === 'progress' && e.workbench === 'subtitle')
    expect(prog[0]?.data?.done).toBe(0)
    expect(prog[0]?.data?.total).toBe(2)
    expect(prog.some((e) => e.data?.done === 1 && e.data?.total === 1)).toBe(false)
    db.close()
  })

  it('🔴 装上一条 → 文件 tick done=1/total=本作品文件数（空 worker 不会走到这里）', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    seedSubtitleWork(db, '/media/Show/E02.mkv', 2)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'],
      listVideoFiles: () => ['/media/Show/E01.mkv', '/media/Show/E02.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
      subtitleWorker: async () => ({
        installed: [{
          itemId: 'tmdb:42/s1e1', installedPath: '/media/Show/E01.zh-Hans.srt',
          installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: 'x', reason: 'ok',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
      }),
    })))
    const prog = got.filter((e) => e.type === 'progress' && e.workbench === 'subtitle')
    expect(prog.some((e) => e.data?.done === 0 && e.data?.total === 2)).toBe(true)
    expect(prog.some((e) => e.data?.done === 1 && e.data?.total === 2)).toBe(true)
    db.close()
  })

  it('🔴 走完整 run()：装上字幕后 requestScan（覆盖才能离开 pending）', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    const { emit } = mkEmit()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
      subtitleWorker: async () => ({
        installed: [{
          itemId: 'tmdb:42/s1e1', installedPath: '/media/Show/E01.zh-Hans.srt',
          installedLanguage: 'zh-Hans', candidateProvider: 'assrt', candidateProviderId: 'x', reason: 'ok',
        }],
        no_safe_match: [], retry_later: [], hardsub_assumed: [],
      }),
    }))
    const scan = vi.spyOn(daemon, 'requestScan')
    await runOneInspection(daemon)
    expect(scan).toHaveBeenCalled()
    db.close()
  })

  it('🔴 字幕台 activity/progress 带 works 上的 backdropPath 与 chineseTitle', async () => {
    const db = openDb(':memory:')
    seedSubtitleWork(db, '/media/Show/E01.mkv', 1)
    db.prepare(`UPDATE works SET backdrop_path = '/bd.jpg', chinese_titles = ? WHERE id = 'tmdb:42'`)
      .run(JSON.stringify(['黑暗智宅']))
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/Show/E01.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    const sub = got.filter((e) =>
      (e.type === 'activity' || e.type === 'progress') && e.workbench === 'subtitle')
    expect(sub.length).toBeGreaterThan(0)
    expect(sub.every((e) => e.data?.backdropPath === '/bd.jpg')).toBe(true)
    expect(sub.every((e) => e.data?.chineseTitle === '黑暗智宅')).toBe(true)
    db.close()
  })

  it('🔴 翻译：首帧 progress done:0 total:1，装盘后 done:1', async () => {
    const db = openDb(':memory:')
    db.prepare('INSERT INTO works (id, title, media_type, origin_lang, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run('tmdb:42', 'Show', 'tv', 'en', 1000, 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id, needs_subtitle, sub_status,
                                   sub_attempt, tr_attempt, updated_at)
                VALUES (?,?,?,?,?,?,1,'handoff_translate',7,0,?)`)
      .run('/media/Show/E01.mkv', '/media/Show', 'E01.mkv', BIG, 1000, 'tmdb:42', 1000)
    const { emit, got } = mkEmit()
    const daemon = new ScoutDaemonV2(mkDeps(db, {
      emit,
      translateEnabled: () => true,
      fileExists: () => true,
      translateRunItem: async () => ({ status: 'installed' as const }),
    }))
    await (daemon as any).advanceTranslateOnce()
    const prog = got.filter((e) => e.type === 'progress' && e.workbench === 'translate')
    expect(prog[0]?.data?.done).toBe(0)
    expect(prog[0]?.data?.total).toBe(1)
    expect(prog.some((e) => e.data?.done === 1 && e.data?.total === 1)).toBe(true)
    db.close()
  })

  it('🔴 识别的事件**不带 workId**（此刻还没有作品身份——编一个就是撒谎）', async () => {
    // 识别台处理的是**目录**（item.workDir），作品身份正是它要产出的东西。
    // 给它塞一个 workId 只能塞 null/空串，而前端的判据是"有没有这个键"——
    // 塞一个空值会让前端拿空 id 去查图表，查不到再降级，白走一趟且掩盖了语义。
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, needs_subtitle, updated_at)
                VALUES ('/media/New/x.mkv','/media/New','x.mkv',?,1000,'/media/New',NULL,1,1000)`).run(BIG)
    const { emit, got } = mkEmit()
    await runOneInspection(new ScoutDaemonV2(mkDeps(db, {
      emit, roots: ['/media'], listVideoFiles: () => ['/media/New/x.mkv'],
      statFile: () => ({ mtimeMs: 1000, size: BIG }), fileExists: () => true,
    })))
    const ident = got.filter((e) => e.workbench === 'identify')
    expect(ident.length).toBeGreaterThan(0)
    expect(ident.every((e) => e.data?.workId === undefined)).toBe(true)
    db.close()
  })

  it('🔴 emit 抛错必须被隔离：巡检照常跑完（SSE 挂了绝不能影响巡检）', async () => {    const db = openDb(':memory:')
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
