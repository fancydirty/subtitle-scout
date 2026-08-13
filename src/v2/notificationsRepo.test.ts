import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import {
  recordFound, listRecentFound, listRecentFoundGrouped, pruneFound,
  NOTIFICATION_RETENTION_MS,
} from './notificationsRepo.js'

const DAY = 24 * 3600_000

describe('notificationsRepo（R-F3 通知页的持久化数据源）', () => {
  let db: ReturnType<typeof openDb>
  beforeEach(() => {
    db = openDb(':memory:')
  })

  // ── 写入 ────────────────────────────────────────────────────────────────────

  it('逐集存：一次装盘三集 → 三行，字段齐全（作品/季/集/时刻/来源）', () => {
    recordFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 3, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 5, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 7, via: 'fetch' }, 1000)
    const rows = listRecentFound(db, 1000)
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.episode).sort()).toEqual([3, 5, 7])
    expect(rows[0].workId).toBe('tmdb:1')
    expect(rows[0].title).toBe('绝命毒师')
    expect(rows[0].season).toBe(1)
    expect(rows[0].foundAt).toBe(1000)
    expect(rows[0].via).toBe('fetch')
  })

  it('电影：season/episode 皆 NULL（R-F3「电影就是已找到字幕」）', () => {
    recordFound(db, { workId: 'tmdb:9', title: '沙丘', season: null, episode: null, via: 'fetch' }, 1000)
    const [row] = listRecentFound(db, 1000)
    expect(row.season).toBeNull()
    expect(row.episode).toBeNull()
    expect(row.title).toBe('沙丘')
  })

  it('🔴 抓取来的与翻译来的能区分开（via 列——前端要显示"怎么来的"）', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 2, via: 'translate' }, 2000)
    const rows = listRecentFound(db, 3000)
    // 倒序：translate 的那条在前
    expect(rows.map(r => r.via)).toEqual(['translate', 'fetch'])
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-13：`season IS NULL` 的**两个含义**
  // ══════════════════════════════════════════════════════════════════════════
  // 生产症状：通知页把剧集渲染成「已找到字幕」的电影行。根因是前端判
  // `isMovie = season === null`，而这张表里 season=NULL 有两个来源：
  //   ① 真电影（上面那条用例）
  //   ② **剧集，但那个文件的季没解析出来**——装盘时 `f.season` 原样写进来就是 NULL。
  //      生产实测：112 个文件 season/episode 为 NULL，其中 79 个属于 TV 作品。
  // 消歧的载体是 works.media_type（结构事实），LEFT JOIN 现取。
  describe('mediaType：消解 season=NULL 的二义性', () => {
    const addWork = (id: string, type: string) =>
      db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
        .run(id, 'W', type, 1000, 1000)

    it('🔴 剧集 + season=NULL（季没解析出来）→ mediaType=**tv**，绝不是 movie', () => {
      addWork('tmdb:1', 'tv')
      recordFound(db, { workId: 'tmdb:1', title: 'W', season: null, episode: null, via: 'fetch' }, 1000)
      expect(listRecentFound(db, 1000)[0].mediaType).toBe('tv')
      expect(listRecentFoundGrouped(db, 1000)[0].mediaType).toBe('tv')
    })

    it('🔴 真电影 + season=NULL → mediaType=movie（阳性对照：不是恒 tv）', () => {
      addWork('tmdb:9', 'movie')
      recordFound(db, { workId: 'tmdb:9', title: 'W', season: null, episode: null, via: 'fetch' }, 1000)
      expect(listRecentFound(db, 1000)[0].mediaType).toBe('movie')
      expect(listRecentFoundGrouped(db, 1000)[0].mediaType).toBe('movie')
    })

    it('🔴 works 行不在（用户移了守备目录）→ **unknown**，且这条通知**照样返回**', () => {
      // LEFT 而不是 INNER 的判据。INNER 会把这条成果整条抹掉——用户前天确实收到了那条
      // 字幕，抹掉它比说不清它是电影还是剧集更糟。
      recordFound(db, { workId: 'tmdb:gone', title: 'W', season: null, episode: null, via: 'fetch' }, 1000)
      const rows = listRecentFound(db, 1000)
      expect(rows).toHaveLength(1)
      expect(rows[0].mediaType).toBe('unknown')
      expect(listRecentFoundGrouped(db, 1000)[0].mediaType).toBe('unknown')
    })

    it('media_type 是意料外的值 → unknown（不许静默当成 tv 或 movie）', () => {
      addWork('tmdb:7', 'anime')
      recordFound(db, { workId: 'tmdb:7', title: 'W', season: 1, episode: 1, via: 'fetch' }, 1000)
      expect(listRecentFound(db, 1000)[0].mediaType).toBe('unknown')
    })

    it('聚合不改变 mediaType（组内同 workId，恒等）', () => {
      addWork('tmdb:1', 'tv')
      recordFound(db, { workId: 'tmdb:1', title: 'W', season: 1, episode: 1, via: 'fetch' }, 1000)
      recordFound(db, { workId: 'tmdb:1', title: 'W', season: 1, episode: 2, via: 'fetch' }, 1100)
      const [g] = listRecentFoundGrouped(db, 1100)
      expect(g.episodes).toEqual([1, 2])
      expect(g.mediaType).toBe('tv')
    })
  })

  // ── 幂等 ────────────────────────────────────────────────────────────────────

  // 为什么"同一集重复装盘不产生重复通知"是**对的**、而不是该产生两条：
  // 通知页的语义是「找到了什么」（成果流水），不是「系统干了几次活」（那是 runs 表与日志）。
  // 同一集被重复装盘的真实成因有三个，全都不是新成果：
  //  ① 用户手删字幕 → 扫描回退 NULL → 重新找到（对用户是同一件事的重演，不是新收获）
  //  ② worker 报 installed 但文件没落地 → 下轮重找（R24 的既有形态）
  //  ③ 抓取装盘后翻译轨又装一遍（两个 via 都命中同一集）
  // 若逐次追加，一个"每天被重找一次"的文件会在一周内往通知页灌 7 条同文，把真正的新成果
  // 挤出屏幕——而 R-F3 明令「不做已读状态」，用户没有任何手段把它们清掉。
  // 故幂等键 = (work_id, season, episode)，重复装盘只**刷新时刻与来源**（它确实是"最近一次
  // 找到"），不新增行。冲突用 ON CONFLICT DO UPDATE，与本仓 jobs_identity 的既有口径同型。
  it('🔴 同一集重复装盘不产生重复通知（幂等键 work_id+season+episode）', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 3, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 3, via: 'fetch' }, 5000)
    const rows = listRecentFound(db, 9000)
    expect(rows).toHaveLength(1)
    // 时刻刷新成最近一次（它是"最近一次找到"，倒序流水里该往前排）
    expect(rows[0].foundAt).toBe(5000)
  })

  it('🔴 同一集先抓取后翻译 → 仍只一条，via 刷新为 translate（不在通知页分两个池子）', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 3, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 3, via: 'translate' }, 2000)
    const rows = listRecentFound(db, 9000)
    expect(rows).toHaveLength(1)
    expect(rows[0].via).toBe('translate')
  })

  it('电影的幂等：season/episode 皆 NULL 时同一 work 只一条（NULL 不自等的坑）', () => {
    // 🔴 SQLite 的 UNIQUE 视 NULL 互不相等 —— 裸 UNIQUE(work_id,season,episode) 对电影
    // **完全失效**（每次装盘都插新行）。故唯一索引必须用 ifnull() 表达式，同本仓
    // jobs_identity 的既有作法。这条用例就是钉这一点的。
    recordFound(db, { workId: 'tmdb:9', title: '沙丘', season: null, episode: null, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:9', title: '沙丘', season: null, episode: null, via: 'fetch' }, 2000)
    expect(listRecentFound(db, 9000)).toHaveLength(1)
  })

  // ── 读取 ────────────────────────────────────────────────────────────────────

  it('读取按时间倒序（R-F3「倒序流水」）', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:2', title: 'B', season: 1, episode: 1, via: 'fetch' }, 3000)
    recordFound(db, { workId: 'tmdb:3', title: 'C', season: 1, episode: 1, via: 'fetch' }, 2000)
    expect(listRecentFound(db, 9000).map(r => r.title)).toEqual(['B', 'C', 'A'])
  })

  it('🔴 超过一周的不返回（R-F3 保留一周——读时按时间窗过滤）', () => {
    const now = 100 * DAY
    recordFound(db, { workId: 'tmdb:1', title: '旧的', season: 1, episode: 1, via: 'fetch' }, now - 8 * DAY)
    recordFound(db, { workId: 'tmdb:2', title: '新的', season: 1, episode: 1, via: 'fetch' }, now - 6 * DAY)
    const rows = listRecentFound(db, now)
    expect(rows.map(r => r.title)).toEqual(['新的'])
  })

  it('🔴 一周窗是读时过滤，不依赖清理跑过（清理没跑也不许漏出陈年成果）', () => {
    const now = 100 * DAY
    recordFound(db, { workId: 'tmdb:1', title: '旧的', season: 1, episode: 1, via: 'fetch' }, now - 30 * DAY)
    // 刻意**不调** pruneFound —— 容器刚起、维护循环还没轮到时就是这个状态
    expect(listRecentFound(db, now)).toHaveLength(0)
  })

  // ── 聚合读（前端真正要的形状）─────────────────────────────────────────────

  it('🔴 按作品+季聚合：「XX 剧找到了 S01 的第 3/5/7 集」（R-F3 的展示形态）', () => {
    recordFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 3, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 7, via: 'fetch' }, 2000)
    recordFound(db, { workId: 'tmdb:1', title: '绝命毒师', season: 1, episode: 5, via: 'fetch' }, 3000)
    const groups = listRecentFoundGrouped(db, 9000)
    expect(groups).toHaveLength(1)
    expect(groups[0].workId).toBe('tmdb:1')
    expect(groups[0].title).toBe('绝命毒师')
    expect(groups[0].season).toBe(1)
    // 集号**升序**（展示用："第 3/5/7 集"），而组间才是时间倒序
    expect(groups[0].episodes).toEqual([3, 5, 7])
    // 组的时刻 = 该组最近一次找到（倒序排序锚点）
    expect(groups[0].latestAt).toBe(3000)
  })

  it('🔴 同一季分两次找到 → 合并成一组（存聚合会遇到的合并问题，逐集存天然免疫）', () => {
    const now = 100 * DAY
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, now - 3 * DAY)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 2, via: 'fetch' }, now - 1 * DAY)
    const groups = listRecentFoundGrouped(db, now)
    expect(groups).toHaveLength(1)
    expect(groups[0].episodes).toEqual([1, 2])
  })

  it('同一作品不同季 → 分成两组（S01 与 S02 是两条通知）', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 2, episode: 1, via: 'fetch' }, 2000)
    const groups = listRecentFoundGrouped(db, 9000)
    expect(groups).toHaveLength(2)
    expect(groups.map(g => g.season)).toEqual([2, 1])   // 组间时间倒序
  })

  it('聚合：组间按最近时刻倒序', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:2', title: 'B', season: 1, episode: 1, via: 'fetch' }, 5000)
    recordFound(db, { workId: 'tmdb:3', title: 'C', season: 1, episode: 1, via: 'fetch' }, 3000)
    expect(listRecentFoundGrouped(db, 9000).map(g => g.title)).toEqual(['B', 'C', 'A'])
  })

  it('聚合：电影一组一条，episodes 为空数组（前端据此渲染「已找到字幕」）', () => {
    recordFound(db, { workId: 'tmdb:9', title: '沙丘', season: null, episode: null, via: 'fetch' }, 1000)
    const [g] = listRecentFoundGrouped(db, 9000)
    expect(g.season).toBeNull()
    expect(g.episodes).toEqual([])
    expect(g.title).toBe('沙丘')
  })

  it('🔴 聚合读同样受一周窗约束（两个读口径必须一致，否则聚合页漏出陈年成果）', () => {
    const now = 100 * DAY
    recordFound(db, { workId: 'tmdb:1', title: '旧的', season: 1, episode: 1, via: 'fetch' }, now - 8 * DAY)
    expect(listRecentFoundGrouped(db, now)).toHaveLength(0)
  })

  it('🔴 聚合里 via 混合时标记 mixed（一季里有抓来的也有翻的，不许谎报单一来源）', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 2, via: 'translate' }, 2000)
    const [g] = listRecentFoundGrouped(db, 9000)
    expect(g.via).toBe('mixed')
  })

  it('聚合里 via 单一时如实标记', () => {
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'translate' }, 1000)
    recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 2, via: 'translate' }, 2000)
    expect(listRecentFoundGrouped(db, 9000)[0].via).toBe('translate')
  })

  // ── 清理 ────────────────────────────────────────────────────────────────────

  it('🔴 清理不误删一周内的', () => {
    const now = 100 * DAY
    recordFound(db, { workId: 'tmdb:1', title: '旧的', season: 1, episode: 1, via: 'fetch' }, now - 8 * DAY)
    recordFound(db, { workId: 'tmdb:2', title: '边界', season: 1, episode: 1, via: 'fetch' }, now - 7 * DAY + 1000)
    recordFound(db, { workId: 'tmdb:3', title: '新的', season: 1, episode: 1, via: 'fetch' }, now - 1 * DAY)
    const deleted = pruneFound(db, now)
    expect(deleted).toBe(1)
    const left = db.prepare('SELECT title FROM notifications ORDER BY found_at').all() as Array<{ title: string }>
    expect(left.map(r => r.title)).toEqual(['边界', '新的'])
  })

  it('清理保留期与读窗同一个常量（两处漂移 = 清理删掉还该显示的，或留下永不显示的垃圾）', () => {
    expect(NOTIFICATION_RETENTION_MS).toBe(7 * DAY)
  })

  it('空表清理不抛错、返回 0', () => {
    expect(pruneFound(db, 100 * DAY)).toBe(0)
  })

  // ── 隔离 ────────────────────────────────────────────────────────────────────

  it('🔴 写入失败绝不向调用方抛错（与 SSE emit 同一口径：通知写失败不许影响装盘）', () => {
    // 真造一个会让 INSERT 失败的形态：把表删掉
    db.exec('DROP TABLE notifications')
    expect(() => recordFound(db, { workId: 'tmdb:1', title: 'A', season: 1, episode: 1, via: 'fetch' }, 1000))
      .not.toThrow()
  })

  it('读取失败返回空数组而不抛错（通知页挂不许把整个 dashboard 带走）', () => {
    db.exec('DROP TABLE notifications')
    expect(listRecentFound(db, 1000)).toEqual([])
    expect(listRecentFoundGrouped(db, 1000)).toEqual([])
  })

  it('清理失败返回 0 而不抛错（它跑在 dbMaintenance 里，不许拖垮 VACUUM/checkpoint）', () => {
    db.exec('DROP TABLE notifications')
    expect(pruneFound(db, 1000)).toBe(0)
  })
})
