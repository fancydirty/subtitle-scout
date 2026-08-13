// src/dashboard/activityApi.test.ts —— R-F13 活动页排队段（GET /api/v2/activity）。
//
// 为什么是新文件：被测的 buildActivity 长在 works/files 上并**复用 daemon 的两个取件谓词**
// （listSubtitleQueue / listNewTranslateCandidates）。混进 mediaLibraryApi.test.ts 会让
// seed helper 同时服务两套完全不同的判据（那边是"磁盘上有什么"，这边是"接下来要跑什么"）。
//
// 本文件要钉的几条，每条都是"改坏了不报错"的形态：
//  ① backdropPath 读的是 **works.backdrop_path**（v42），不是旧世界的 series.backdrop_path
//     ——照抄旧 DTO 的 JOIN 会让横版图恒 null，而无图降级路径本来就存在，
//     没有任何既有用例会红。
//     ⚠️ 这里原先写的理由是「后者生产 0 行」。**行数不是判据**（2026-08-14 修正论证）：
//     `media_roots=0` 的库上每张表都是 0 行，活表 `item_files` 今天同样 0 行；行数分不出
//     "这条路死了"与"这条路还没被走过"。真正的理由是**静态可达性**：新架构的写入侧
//     （daemonV2 的 works upsert）只写 `works`，`series` 的唯一写入方 libraryRepo.upsertSeries
//     在生产代码里零调用（剥注释后全仓只剩 src/testing/seedBacklog.ts 这一个测试造数器
//     在调它）——所以 series.backdrop_path 对本端点恒 null 是**结构性**的，与今天几行无关。
//     下面 :100 那条"读错表"诱饵用例正是这条判据的执行载体：它种一行同 id 的 series，
//     真去 JOIN 旧表就会拿到诱饵值而变红。
//  ② **不产出 total/index**（与 /api/v2/health「刻意不返回 queue」那条裁决的分工，
//     完整论证见 activityApi.ts 头注释）。加一个 total 字段"方便前端"会正面违反 :578。
//  ③ 识别台**没有对应段**（R-F1 的后端侧执行）。
//  ④ 谓词真的复用了 daemon 的那两个函数：造一行"退避窗未到"的数据，它必须**不**出现在队列里
//     ——若有人在这里重写了一遍 WHERE 而漏了 recheck_after，这条会红。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { buildActivity } from './activityApi.js'
import { listSubtitleQueue } from '../v2/subtitleScheduler.js'
import { listNewTranslateCandidates } from '../v2/translateWorkerTask.js'

let db: ScoutDb
const NOW = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
})

function addWork(
  id: string,
  o: {
    title: string
    mediaType?: 'tv' | 'movie'
    year?: number | null
    posterPath?: string | null
    backdropPath?: string | null
    chineseTitles?: string[] | null
  },
): void {
  db.prepare(
    `INSERT INTO works (id, title, original_title, year, media_type, origin_lang, overview, poster_path, backdrop_path, chinese_titles, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, o.title, null, o.year ?? null, o.mediaType ?? 'tv', null, null,
    o.posterPath ?? null, o.backdropPath ?? null,
    o.chineseTitles ? JSON.stringify(o.chineseTitles) : null, NOW, NOW,
  )
}

function addFile(o: {
  path: string
  workId: string | null
  season?: number | null
  episode?: number | null
  /** 字幕台谓词：needs_subtitle=1 AND sub_status IS NULL AND recheck_after<=now。 */
  needsSubtitle?: number | null
  subStatus?: string | null
  recheckAfter?: number | null
  trRecheckAfter?: number | null
}): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, season, episode,
                        sub_status, needs_subtitle, recheck_after, tr_recheck_after, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.path, '/d', 'f.mkv', 100, NOW, '/d', o.workId,
    o.season ?? null, o.episode ?? null, o.subStatus ?? null,
    o.needsSubtitle === undefined ? 1 : o.needsSubtitle,
    o.recheckAfter ?? null, o.trRecheckAfter ?? null, NOW,
  )
}

describe('buildActivity：字幕台排队段', () => {
  it('按作品聚合（R-F4 粒度 = 作品，不是集）：3 个文件 → 1 项，pendingFileCount=3', () => {
    addWork('tmdb:1', { title: 'Show A', year: 2018 })
    for (const ep of [1, 2, 3]) addFile({ path: `/d/a${ep}.mkv`, workId: 'tmdb:1', season: 1, episode: ep })

    const dto = buildActivity(db, { now: NOW })
    expect(dto.subtitleQueue).toHaveLength(1)
    expect(dto.subtitleQueue[0]).toMatchObject({
      workId: 'tmdb:1', title: 'Show A', year: 2018, pendingFileCount: 3,
    })
  })

  // 🔴 本 task 与旧世界的分界（任务书点名）：读 works.backdrop_path，不是 series.backdrop_path。
  it('backdropPath 取自 **works.backdrop_path**（v42 列），posterPath 取自 works.poster_path', () => {
    addWork('tmdb:1', { title: 'Show A', posterPath: '/p.jpg', backdropPath: '/bd.jpg' })
    addFile({ path: '/d/a.mkv', workId: 'tmdb:1', season: 1, episode: 1 })

    const item = buildActivity(db, { now: NOW }).subtitleQueue[0]!
    expect(item.posterPath).toBe('/p.jpg')
    expect(item.backdropPath).toBe('/bd.jpg')
  })

  // 反证上一条不是靠"恰好两列都有值"蒙的：series 表里放一个**不同**的 backdrop，
  // 若实现照抄了旧 DTO 的 `LEFT JOIN series`，这条会拿到 '/WRONG.jpg'。
  it('🔴 series.backdrop_path 有值而 works 的为 NULL 时 → 仍是 null（**没有**读旧表）', () => {
    addWork('tmdb:1', { title: 'Show A', backdropPath: null })
    addFile({ path: '/d/a.mkv', workId: 'tmdb:1', season: 1, episode: 1 })
    // 旧世界那张表：生产写入方为零（唯一写它的 libraryRepo.upsertSeries 在生产代码里
    // 零调用点），这里刻意种一行同 id 的，作为"读错表"的诱饵。
    // ——判据是"没人写它"，不是"它今天 0 行"：后者在 media_roots=0 的库上对每张表都成立。
    db.prepare(`INSERT INTO series (id, name, backdrop_path) VALUES ('tmdb:1', 'Show A', '/WRONG.jpg')`).run()

    expect(buildActivity(db, { now: NOW }).subtitleQueue[0]!.backdropPath).toBeNull()
  })

  it('无图 → 两个字段都是 null（前端据此降级纯排印，不是崩）', () => {
    addWork('tmdb:1', { title: 'Show A' })
    addFile({ path: '/d/a.mkv', workId: 'tmdb:1', season: 1, episode: 1 })

    const item = buildActivity(db, { now: NOW }).subtitleQueue[0]!
    expect(item.posterPath).toBeNull()
    expect(item.backdropPath).toBeNull()
  })

  it('chineseTitle 取 chinese_titles 首个；坏 JSON / 空数组 → null', () => {
    addWork('tmdb:1', { title: 'Show A', chineseTitles: ['甲剧', '甲剧场版'] })
    addFile({ path: '/d/a.mkv', workId: 'tmdb:1', season: 1, episode: 1 })
    addWork('tmdb:2', { title: 'Show B' })
    db.prepare(`UPDATE works SET chinese_titles = '{{bad' WHERE id = 'tmdb:2'`).run()
    addFile({ path: '/d/b.mkv', workId: 'tmdb:2', season: 1, episode: 1 })

    const byId = new Map(buildActivity(db, { now: NOW }).subtitleQueue.map((i) => [i.workId, i]))
    expect(byId.get('tmdb:1')!.chineseTitle).toBe('甲剧')
    expect(byId.get('tmdb:2')!.chineseTitle).toBeNull()
  })

  // 🔴 谓词复用的证据：这两行**各自**违反 listSubtitleQueue 的一条**归属**谓词。
  // 若有人在 activityApi 里重写了一遍 WHERE 而漏掉其中一条，对应那行就会冒出来。
  //
  // ⚠️ 退避窗那一条**刻意不在这里**（2026-08-13 改）：它不是归属谓词，是调度谓词。
  // 本端点问的是「还有什么在等」，退避中的行**必须**出现。见下一组。
  it('🔴 不满足**归属**谓词的行不进队列（needs_subtitle=0 / 已有 sub_status）', () => {
    addWork('tmdb:1', { title: 'Not Needed' })
    addFile({ path: '/d/1.mkv', workId: 'tmdb:1', season: 1, episode: 1, needsSubtitle: 0 })
    addWork('tmdb:2', { title: 'Already Covered' })
    addFile({ path: '/d/2.mkv', workId: 'tmdb:2', season: 1, episode: 1, subStatus: 'covered' })
    addWork('tmdb:4', { title: 'Genuinely Queued' })
    addFile({ path: '/d/4.mkv', workId: 'tmdb:4', season: 1, episode: 1 })

    // 阳性对照与两条否定并列：只有否定断言时，一个恒返回 [] 的实现也会全绿。
    expect(buildActivity(db, { now: NOW }).subtitleQueue.map((i) => i.workId)).toEqual(['tmdb:4'])
  })

  it('退避窗**到点**的行 dueNow=true / retryAfter=null（边界：recheck_after === now 算到点）', () => {
    addWork('tmdb:3', { title: 'Backing Off' })
    addFile({ path: '/d/3.mkv', workId: 'tmdb:3', season: 1, episode: 1, recheckAfter: NOW })
    const [item] = buildActivity(db, { now: NOW }).subtitleQueue
    expect(item).toMatchObject({ workId: 'tmdb:3', dueNow: true, retryAfter: null })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-13：「已排队 · 0 / 没有排队的作品」那句假话
  // ══════════════════════════════════════════════════════════════════════════
  // 生产实测：needs_subtitle=1 AND sub_status IS NULL 共 33 个文件，其中**到点可取 0**
  // （全在退避窗，最早约 16h 后）。此前本端点复用 daemon 的取件谓词（含退避窗）→
  // 返回 []，活动页说「没有排队的作品」。空态与"全都在退避里"共用了同一句话。
  describe('退避窗中的作品仍在队列里（空态 ≠ 全都在等重试）', () => {
    it('🔴 全部文件都在退避窗 → **照样出现**，dueNow=false 且给得出 retryAfter', () => {
      addWork('tmdb:3', { title: 'Backing Off' })
      const at = NOW + 16 * 3_600_000
      addFile({ path: '/d/3.mkv', workId: 'tmdb:3', season: 1, episode: 1, recheckAfter: at })
      const dto = buildActivity(db, { now: NOW })
      expect(dto.subtitleQueue).toHaveLength(1)
      expect(dto.subtitleQueue[0]).toMatchObject({
        workId: 'tmdb:3', pendingFileCount: 1, dueNow: false, retryAfter: at,
      })
    })

    it('🔴 retryAfter 是这一簇里**最早**的那个（用户要知道最早什么时候会动）', () => {
      addWork('tmdb:3', { title: 'Backing Off' })
      const soon = NOW + 2 * 3_600_000
      const later = NOW + 20 * 3_600_000
      addFile({ path: '/d/a.mkv', workId: 'tmdb:3', season: 1, episode: 1, recheckAfter: later })
      addFile({ path: '/d/b.mkv', workId: 'tmdb:3', season: 1, episode: 2, recheckAfter: soon })
      expect(buildActivity(db, { now: NOW }).subtitleQueue[0]).toMatchObject({
        pendingFileCount: 2, dueNow: false, retryAfter: soon,
      })
    })

    it('🔴 一簇里只要有一个到点 → dueNow=true、retryAfter=null（这一项现在真的会被跑）', () => {
      addWork('tmdb:3', { title: 'Mixed' })
      addFile({ path: '/d/a.mkv', workId: 'tmdb:3', season: 1, episode: 1, recheckAfter: NOW + 9_000_000 })
      addFile({ path: '/d/b.mkv', workId: 'tmdb:3', season: 1, episode: 2, recheckAfter: null })
      expect(buildActivity(db, { now: NOW }).subtitleQueue[0]).toMatchObject({
        dueNow: true, retryAfter: null,
      })
    })

    it('🔴 空态仍然是真的空态：库里没有满足归属谓词的行 → []（不许因放宽而无中生有）', () => {
      addWork('tmdb:2', { title: 'Covered' })
      addFile({ path: '/d/2.mkv', workId: 'tmdb:2', season: 1, episode: 1, subStatus: 'covered' })
      expect(buildActivity(db, { now: NOW }).subtitleQueue).toEqual([])
    })

    it('🔴 daemon 的取件语义**一字未改**：同一批数据，默认模式下退避行仍然不可取', () => {
      // 这条是本次放宽的**反向守卫**。若有人把 includeBackoff 默认成 true（或直接删掉
      // 那一条 WHERE），daemon 会当轮重选退避中的文件 → C26 付费 LLM 热循环，
      // 而本文件其余所有断言都还是绿的。故必须在这里正面钉住默认行为。
      addWork('tmdb:3', { title: 'Backing Off' })
      addFile({ path: '/d/3.mkv', workId: 'tmdb:3', season: 1, episode: 1, recheckAfter: NOW + 86_400_000 })
      expect(listSubtitleQueue(db, undefined, NOW)).toEqual([])
      expect(listSubtitleQueue(db, undefined, NOW, { includeBackoff: true })).toHaveLength(1)
    })
  })

  it('识别失败的孤儿（work_id IS NULL）不进队列——它连作品身份都没有', () => {
    addFile({ path: '/d/orphan.mkv', workId: null })
    expect(buildActivity(db, { now: NOW }).subtitleQueue).toEqual([])
  })

  it('roots 过滤：不在给定根下的文件不进队列；不传 roots = 不过滤（诚实的降级）', () => {
    addWork('tmdb:1', { title: 'Inside' })
    addFile({ path: '/media/in/a.mkv', workId: 'tmdb:1', season: 1, episode: 1 })
    addWork('tmdb:2', { title: 'Outside' })
    addFile({ path: '/other/b.mkv', workId: 'tmdb:2', season: 1, episode: 1 })

    expect(buildActivity(db, { roots: ['/media/in'], now: NOW }).subtitleQueue.map((i) => i.workId))
      .toEqual(['tmdb:1'])
    // 不传 = 全出（多列不少列，见 server.ts 那条口径差的论证）
    expect(buildActivity(db, { now: NOW }).subtitleQueue.map((i) => i.workId).sort())
      .toEqual(['tmdb:1', 'tmdb:2'])
  })

  it('work_id 指向不存在的作品 → 不出现（两个取件函数都 INNER JOIN works，daemon 同样不会跑它）', () => {
    // ⚠️ 这条**记录的是既有事实，不是本文件的设计**：listSubtitleQueue 的 SQL 是
    // `FROM files f JOIN works w ON f.work_id = w.id`（内连接），一个 work_id 指向空的行
    // 对 daemon 也是不可见的。所以队列里不出现它**不是**"界面把活藏了"——daemon 确实
    // 不会跑它。activityApi 里那层 `faces.get() ?? 回落` 因此是够不着的防御，
    // 留着只为"哪天取件函数改成 LEFT JOIN 时不至于渲染出一张空标题卡片"。
    addFile({ path: '/d/a.mkv', workId: 'tmdb:ghost', season: 1, episode: 1 })
    expect(buildActivity(db, { now: NOW }).subtitleQueue).toEqual([])
  })
})

describe('buildActivity：翻译台排队段', () => {
  it('逐文件的候选按作品折叠（R-F4）：一部剧 4 集待翻 → 1 项，pendingFileCount=4', () => {
    addWork('tmdb:9', { title: 'Trans Show', year: 2020 })
    for (const ep of [1, 2, 3, 4]) {
      addFile({
        path: `/d/t${ep}.mkv`, workId: 'tmdb:9', season: 1, episode: ep,
        subStatus: 'handoff_translate',
      })
    }
    const dto = buildActivity(db, { now: NOW })
    expect(dto.translateQueue).toHaveLength(1)
    expect(dto.translateQueue[0]).toMatchObject({ workId: 'tmdb:9', title: 'Trans Show', pendingFileCount: 4 })
  })

  it('两个台**互斥**：handoff_translate 的行不在字幕队列里，反之亦然（C14）', () => {
    addWork('tmdb:1', { title: 'Sub Side' })
    addFile({ path: '/d/s.mkv', workId: 'tmdb:1', season: 1, episode: 1 })
    addWork('tmdb:9', { title: 'Trans Side' })
    addFile({ path: '/d/t.mkv', workId: 'tmdb:9', season: 1, episode: 1, subStatus: 'handoff_translate' })

    const dto = buildActivity(db, { now: NOW })
    expect(dto.subtitleQueue.map((i) => i.workId)).toEqual(['tmdb:1'])
    expect(dto.translateQueue.map((i) => i.workId)).toEqual(['tmdb:9'])
  })

  it('翻译退避窗（tr_recheck_after）未到的**照样在队列里**，只是 dueNow=false', () => {
    // 2026-08-14：这条以前断言的是 `toEqual([])`，那正是 2026-08-13 在字幕台修掉的
    // 同一句假话——「全都在退避里」被折叠成「没有排队的作品」。见下面那一组的论证。
    addWork('tmdb:9', { title: 'Trans Show' })
    const at = NOW + 3_600_000
    addFile({
      path: '/d/t.mkv', workId: 'tmdb:9', season: 1, episode: 1,
      subStatus: 'handoff_translate', trRecheckAfter: at,
    })
    expect(buildActivity(db, { now: NOW }).translateQueue).toMatchObject([
      { workId: 'tmdb:9', pendingFileCount: 1, dueNow: false, retryAfter: at },
    ])
  })

  it('翻译项同样带两张图（一个作品会从排队走到在跑，那一刻横版图要已经在手）', () => {
    addWork('tmdb:9', { title: 'Trans Show', posterPath: '/p9.jpg', backdropPath: '/bd9.jpg' })
    addFile({ path: '/d/t.mkv', workId: 'tmdb:9', season: 1, episode: 1, subStatus: 'handoff_translate' })
    expect(buildActivity(db, { now: NOW }).translateQueue[0]).toMatchObject({
      posterPath: '/p9.jpg', backdropPath: '/bd9.jpg',
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-14：翻译台的空态歧义 —— 字幕台 2026-08-13 修过的同一个洞
  // ══════════════════════════════════════════════════════════════════════════
  // 上面那一组（字幕台）的病灶：界面复用 daemon 的取件谓词（含退避窗）→ 全在退避窗时
  // 返回 [] →「已排队 · 0 / 没有排队的作品」。翻译台留了同一个洞，只是退避列换成
  // `tr_recheck_after`（v37/D6，防付费 LLM 热循环）。
  //
  // ⚠️ 与字幕台不同的是：生产当前 handoff_translate **0 行**、翻译开关未配置，所以这**今天
  // 不是**用户可见的假话，是个装好的陷阱——一旦用户开翻译就踩。没有生产数据可验，
  // 全部靠这一组构造场景。
  describe('翻译台：退避窗中的作品仍在队列里（空态 ≠ 全都在等重试）', () => {
    it('🔴 全部文件都在退避窗 → **照样出现**，dueNow=false 且给得出 retryAfter', () => {
      addWork('tmdb:9', { title: 'Trans Backing Off' })
      const at = NOW + 16 * 3_600_000
      addFile({
        path: '/d/t.mkv', workId: 'tmdb:9', season: 1, episode: 1,
        subStatus: 'handoff_translate', trRecheckAfter: at,
      })
      const dto = buildActivity(db, { now: NOW })
      expect(dto.translateQueue).toHaveLength(1)
      expect(dto.translateQueue[0]).toMatchObject({
        workId: 'tmdb:9', pendingFileCount: 1, dueNow: false, retryAfter: at,
      })
    })

    it('🔴 retryAfter 是这一簇里**最早**的那个（对齐字幕台语义）', () => {
      addWork('tmdb:9', { title: 'Trans Backing Off' })
      const soon = NOW + 2 * 3_600_000
      const later = NOW + 20 * 3_600_000
      addFile({ path: '/d/a.mkv', workId: 'tmdb:9', season: 1, episode: 1, subStatus: 'handoff_translate', trRecheckAfter: later })
      addFile({ path: '/d/b.mkv', workId: 'tmdb:9', season: 1, episode: 2, subStatus: 'handoff_translate', trRecheckAfter: soon })
      expect(buildActivity(db, { now: NOW }).translateQueue[0]).toMatchObject({
        pendingFileCount: 2, dueNow: false, retryAfter: soon,
      })
    })

    it('🔴 一簇里只要有一个到点 → dueNow=true、retryAfter=null（这一项现在真的会被跑）', () => {
      // 与字幕台同一条论证（queueItemDueNow 的 `.some()`）：daemon 的取件是**逐文件**的，
      // 剩一个到点的文件就足以让这个作品当轮被领走。说它 dueNow=false 是假话。
      addWork('tmdb:9', { title: 'Trans Mixed' })
      addFile({ path: '/d/a.mkv', workId: 'tmdb:9', season: 1, episode: 1, subStatus: 'handoff_translate', trRecheckAfter: NOW + 9_000_000 })
      addFile({ path: '/d/b.mkv', workId: 'tmdb:9', season: 1, episode: 2, subStatus: 'handoff_translate', trRecheckAfter: null })
      expect(buildActivity(db, { now: NOW }).translateQueue[0]).toMatchObject({
        dueNow: true, retryAfter: null,
      })
    })

    it('🔴 边界：tr_recheck_after === now 算到点（dueNow=true / retryAfter=null）', () => {
      addWork('tmdb:9', { title: 'Trans Exact' })
      addFile({ path: '/d/t.mkv', workId: 'tmdb:9', season: 1, episode: 1, subStatus: 'handoff_translate', trRecheckAfter: NOW })
      expect(buildActivity(db, { now: NOW }).translateQueue[0]).toMatchObject({
        dueNow: true, retryAfter: null,
      })
    })

    it('🔴 空态仍然是真的空态：库里没有 handoff_translate 的行 → []（不许因放宽而无中生有）', () => {
      addWork('tmdb:2', { title: 'Covered' })
      addFile({ path: '/d/2.mkv', workId: 'tmdb:2', season: 1, episode: 1, subStatus: 'covered' })
      expect(buildActivity(db, { now: NOW }).translateQueue).toEqual([])
    })

    it('🔴 daemon 的取件语义**一字未改**：同一批数据，默认模式下退避行仍然不可取', () => {
      // 🔴🔴 这条是本次放宽的**反向守卫**，也是全组最重要的一条：若有人把 includeBackoff
      // 默认成 true（或直接删掉那一条 WHERE），daemon 的翻译循环（R19：主进程内独立循环，
      // 下一圈几秒后就来）会当轮重领退避中的文件 → 每圈一个**付费** LLM session，
      // 而本文件其余所有断言都还是绿的。故必须在这里正面钉住默认行为。
      addWork('tmdb:9', { title: 'Trans Backing Off' })
      addFile({
        path: '/d/t.mkv', workId: 'tmdb:9', season: 1, episode: 1,
        subStatus: 'handoff_translate', trRecheckAfter: NOW + 86_400_000,
      })
      expect(listNewTranslateCandidates(db, NOW)).toEqual([])
      expect(listNewTranslateCandidates(db, NOW, { includeBackoff: true })).toHaveLength(1)
    })
  })
})

describe('buildActivity：与 /api/v2/health「不返回 queue」那条裁决的分工', () => {
  // 🔴 这条守的是 activityApi.ts 头注释里那段论证。加一个 total"方便前端"会让活动页出现
  // 两个来源不同的 n（SSE 的冻结值 vs 这里的实时值），在生产上表现为进度条来回跳。
  it('响应里**没有** total / index / current 之类的计数字段', () => {
    addWork('tmdb:1', { title: 'A' })
    addFile({ path: '/d/a.mkv', workId: 'tmdb:1', season: 1, episode: 1 })
    const dto = buildActivity(db, { now: NOW })

    expect(Object.keys(dto).sort()).toEqual(['subtitleQueue', 'translateQueue'])
    for (const item of [...dto.subtitleQueue, ...dto.translateQueue]) {
      expect(Object.keys(item).sort()).toEqual(
        ['backdropPath', 'chineseTitle', 'dueNow', 'mediaType', 'pendingFileCount', 'posterPath',
         'retryAfter', 'title', 'workId', 'year'],
      )
      // pendingFileCount 是"这个作品自己有几集在等"，与队列长度无关——名字里没有 total
      // 是刻意的，见 DTO 的字段注释。
      expect('total' in item).toBe(false)
      expect('index' in item).toBe(false)
    }
  })

  // 🔴 R-F1 的后端侧执行：两个 tab 是「字幕/翻译」，不给识别产数据。
  it('🔴 响应里**没有 identify 段**（R-F1：识别不进活动页）', () => {
    expect('identifyQueue' in buildActivity(db, { now: NOW })).toBe(false)
  })

  it('空库 → 两段都是空数组（不是 null，前端不必区分"没有"和"没问到"）', () => {
    const dto = buildActivity(db, { now: NOW })
    expect(dto.subtitleQueue).toEqual([])
    expect(dto.translateQueue).toEqual([])
  })
})
