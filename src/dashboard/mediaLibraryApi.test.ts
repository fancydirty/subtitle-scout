// src/dashboard/mediaLibraryApi.test.ts —— R-F2 / R-F5 媒体库页数据端点。
//
// 为什么是新文件而不是往 apiV2.test.ts 里加：被测的两个 builder 长在 files/works/tmdb_seasons
// 上，与 apiV2.ts 那 4 个旧 builder（series/episodes/movies）**没有一行共享代码**。混在一个
// 文件里，seed helper 就要同时喂两套表，读的人分不清哪张表在为哪个断言服务。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { buildMediaLibrary, buildMediaLibraryDetail } from './mediaLibraryApi.js'

let db: ScoutDb
const NOW = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
})

// ---- seed helper：直写 files/works/tmdb_seasons（新架构三张表） ----

function addWork(
  id: string,
  o: {
    title: string
    mediaType?: 'tv' | 'movie'
    year?: number | null
    posterPath?: string | null
    chineseTitles?: string[] | null
  },
): void {
  db.prepare(
    `INSERT INTO works (id, title, original_title, year, media_type, origin_lang, overview, poster_path, chinese_titles, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, o.title, null, o.year ?? null, o.mediaType ?? 'tv', null, null,
    o.posterPath ?? null, o.chineseTitles ? JSON.stringify(o.chineseTitles) : null, NOW, NOW,
  )
}

function addFile(o: {
  path: string
  workId: string | null
  season?: number | null
  episode?: number | null
  subStatus?: string | null
  embeddedLangs?: string[] | null
  /** NULL=judge 还没判 / 0=不需要 / 1=需要。**默认 1**——与本 helper 的历史行为逐字一致
   *  （八态之前这一列恒写 1），故既有用例的期望一个字都不用改。
   *  ⚠️ 用 `undefined` 表达"取默认值"、用 `null` 表达"真的写 NULL"：写成 `?? 1` 的话
   *  显式传 null 会被悄悄改写成 1，第 8 态（unjudged）就永远造不出测试数据来。 */
  needsSubtitle?: number | null
  skipReason?: string | null
}): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, season, episode, sub_status, embedded_langs, needs_subtitle, skip_reason, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.path, '/d', 'f.mkv', 100, NOW, '/d', o.workId,
    o.season ?? null, o.episode ?? null, o.subStatus ?? null,
    o.embeddedLangs ? JSON.stringify(o.embeddedLangs) : null,
    o.needsSubtitle === undefined ? 1 : o.needsSubtitle,
    o.skipReason ?? null,
    NOW,
  )
}

/** 应有集（R-F5 的数据源）。 */
function addCanonical(seriesId: string, season: number, episodes: number[]): void {
  const ins = db.prepare(
    `INSERT INTO tmdb_seasons (series_id, season, episode, title, fetched_at) VALUES (?,?,?,?,?)`,
  )
  for (const e of episodes) ins.run(seriesId, season, e, `E${e}`, NOW)
}

describe('buildMediaLibrary（列表：海报墙）', () => {
  it('只出已识别的作品，带海报/中文名/年份/媒体类型', () => {
    addWork('tmdb:1', { title: 'Breaking Bad', year: 2008, posterPath: '/bb.jpg', chineseTitles: ['绝命毒师'] })
    addFile({ path: '/m/bb/s1e1.mkv', workId: 'tmdb:1', season: 1, episode: 1 })
    addCanonical('tmdb:1', 1, [1, 2])

    const list = buildMediaLibrary(db)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      workId: 'tmdb:1',
      title: 'Breaking Bad',
      chineseTitle: '绝命毒师',
      year: 2008,
      posterPath: '/bb.jpg',
      mediaType: 'tv',
    })
  })

  it('🔴 R-F2 识别失败的孤儿不露出：work_id IS NULL 的 files 不产生任何列表项', () => {
    addFile({ path: '/m/who-knows/movie.mkv', workId: null })
    expect(buildMediaLibrary(db)).toEqual([])
  })

  it('🔴 作品行存在但磁盘上一个文件都没有（用户移除了目录）→ 不露出', () => {
    // 防回归：LEFT JOIN 写法会让空壳 works 行冒出一张没有任何卡片的海报。媒体库页描述的是
    // "磁盘上有什么"，一个文件都没有的作品不是媒体库的内容。
    addWork('tmdb:9', { title: 'Ghost Work' })
    expect(buildMediaLibrary(db)).toEqual([])
  })

  it('概览数字：应有/实有/已获取字幕三者分列，且缺集数 = 应有 - 实有', () => {
    addWork('tmdb:2', { title: 'ReZero', year: 2016 })
    addCanonical('tmdb:2', 1, [1, 2, 3, 4, 5])
    addFile({ path: '/m/rz/s1e1.mkv', workId: 'tmdb:2', season: 1, episode: 1, subStatus: 'covered' })
    addFile({ path: '/m/rz/s1e2.mkv', workId: 'tmdb:2', season: 1, episode: 2 })

    const [item] = buildMediaLibrary(db)
    // 🔴 字段名必须与真实含义逐字对应（本仓今天栽过三次"把中间量说成结论量"）：
    // expectedEpisodeCount 是 tmdb_seasons 的行数，onDiskEpisodeCount 是磁盘上有的集数，
    // 两者绝不许共用一个含混的 episodeCount。
    expect(item.expectedEpisodeCount).toBe(5)
    expect(item.onDiskEpisodeCount).toBe(2)
    expect(item.missingEpisodeCount).toBe(3)
    expect(item.subtitledEpisodeCount).toBe(1)
  })

  it('🔴 应有集缺失（tmdb_seasons 未回填）→ expectedEpisodeCount=0，missing 不许变负数', () => {
    addWork('tmdb:3', { title: 'Not Backfilled Yet' })
    addFile({ path: '/m/nb/s1e1.mkv', workId: 'tmdb:3', season: 1, episode: 1 })
    addFile({ path: '/m/nb/s1e2.mkv', workId: 'tmdb:3', season: 1, episode: 2 })

    const [item] = buildMediaLibrary(db)
    expect(item.expectedEpisodeCount).toBe(0)
    expect(item.onDiskEpisodeCount).toBe(2)
    // Math.max(0, ...) 的钉子：裸减法在这里得到 -2，前端会显示"缺 -2 集"。
    expect(item.missingEpisodeCount).toBe(0)
  })

  it('🔴 电影：没有季集，expectedEpisodeCount=0；有无字幕由 subtitledEpisodeCount 表达', () => {
    addWork('tmdb:100', { title: 'Dune', mediaType: 'movie', year: 2021 })
    addFile({ path: '/m/dune.mkv', workId: 'tmdb:100', season: null, episode: null, subStatus: 'covered' })

    const [item] = buildMediaLibrary(db)
    expect(item.mediaType).toBe('movie')
    expect(item.expectedEpisodeCount).toBe(0)
    expect(item.onDiskEpisodeCount).toBe(1)
    expect(item.missingEpisodeCount).toBe(0)
    expect(item.subtitledEpisodeCount).toBe(1)
  })

  it('🔴 R-F2 列表概览也按 work_id 合并：同一集两份文件只算一集，任一份有字幕就算已获取', () => {
    // 防回归：概览数字若按 files 行数直接 COUNT(*)，两个目录各一份的库会把"实有 1 集"
    // 报成 2 集，进而算出负的缺集数。
    addWork('tmdb:4', { title: 'Dup Dirs' })
    addCanonical('tmdb:4', 1, [1, 2])
    addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:4', season: 1, episode: 1, subStatus: 'covered' })
    addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:4', season: 1, episode: 1, subStatus: null })

    const [item] = buildMediaLibrary(db)
    expect(item.onDiskEpisodeCount).toBe(1)
    expect(item.subtitledEpisodeCount).toBe(1)
    expect(item.missingEpisodeCount).toBe(1)
  })

  it('多个作品：按标题稳定排序，列表可预期', () => {
    addWork('tmdb:20', { title: 'Zebra' })
    addFile({ path: '/z/e1.mkv', workId: 'tmdb:20', season: 1, episode: 1 })
    addWork('tmdb:21', { title: 'Apple' })
    addFile({ path: '/a/e1.mkv', workId: 'tmdb:21', season: 1, episode: 1 })

    expect(buildMediaLibrary(db).map((x) => x.title)).toEqual(['Apple', 'Zebra'])
  })
})

describe('buildMediaLibraryDetail（详情：季集网格）', () => {
  it('不存在的 work_id → null（404 语义）', () => {
    expect(buildMediaLibraryDetail(db, 'tmdb:nope')).toBeNull()
  })

  it('🔴 R-F5 季集网格：实有集 onDisk=true（实线），应有但没有 onDisk=false（虚线）', () => {
    addWork('tmdb:5', { title: 'ReZero', year: 2016 })
    addCanonical('tmdb:5', 1, [1, 2, 3])
    addFile({ path: '/m/rz/s1e1.mkv', workId: 'tmdb:5', season: 1, episode: 1 })
    addFile({ path: '/m/rz/s1e3.mkv', workId: 'tmdb:5', season: 1, episode: 3 })

    const detail = buildMediaLibraryDetail(db, 'tmdb:5')!
    expect(detail.seasons).toHaveLength(1)
    const s1 = detail.seasons[0]
    expect(s1.season).toBe(1)
    expect(s1.episodes.map((e) => [e.episode, e.onDisk])).toEqual([[1, true], [2, false], [3, true]])
    // 应有集带过来的标题（虚线卡片也要有字可显示）
    expect(s1.episodes[1].title).toBe('E2')
  })

  it('🔴 tmdb_seasons 缺失时优雅降级：只显示实有集，不崩、不吞数据', () => {
    addWork('tmdb:6', { title: 'No Canonical' })
    addFile({ path: '/m/nc/s2e4.mkv', workId: 'tmdb:6', season: 2, episode: 4 })

    const detail = buildMediaLibraryDetail(db, 'tmdb:6')!
    expect(detail.seasons.map((s) => s.season)).toEqual([2])
    expect(detail.seasons[0].episodes).toEqual([
      expect.objectContaining({ episode: 4, onDisk: true, dot: 'none', title: null }),
    ])
  })

  it('季号是应有 ∪ 实有的并集，升序（磁盘有第 3 季而 TMDB 只缓存了第 1 季时两边都不许丢）', () => {
    addWork('tmdb:7', { title: 'Union' })
    addCanonical('tmdb:7', 1, [1])
    addFile({ path: '/u/s3e1.mkv', workId: 'tmdb:7', season: 3, episode: 1 })
    expect(buildMediaLibraryDetail(db, 'tmdb:7')!.seasons.map((s) => s.season)).toEqual([1, 3])
  })

  describe('圆点三态（R-F2）', () => {
    it("🔴 无点：既无外挂中字也无内嵌中文轨 → dot='none'", () => {
      addWork('tmdb:10', { title: 'Bare' })
      addCanonical('tmdb:10', 1, [1])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:10', season: 1, episode: 1, subStatus: null, embeddedLangs: ['eng', 'jpn'] })
      expect(buildMediaLibraryDetail(db, 'tmdb:10')!.seasons[0].episodes[0].dot).toBe('none')
    })

    it("🔴 无点：embedded_langs=[] 是「探过、确认零轨」→ 仍是 none（不是 unknown 也不是 blue）", () => {
      addWork('tmdb:11', { title: 'ProbedEmpty' })
      addCanonical('tmdb:11', 1, [1])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:11', season: 1, episode: 1, embeddedLangs: [] })
      expect(buildMediaLibraryDetail(db, 'tmdb:11')!.seasons[0].episodes[0].dot).toBe('none')
    })

    // 🔴 中文标签的多种真实形态（C30：本仓栽过"两套字幕标签集漂移"）。langOf 单独用是不够的
    // ——实测 langOf('chs')==='chs'，绝不等于 'zh'；判据必须同时走 tagsForLanguage('zh')。
    // 参数化把五种形态一次钉住，任何"只认 chi/zho"的第二份实现都会在这里红。
    for (const tag of ['chi', 'zho', 'zh', 'chs', 'cht', 'zh-CN', 'zh-Hant']) {
      it(`🔴 蓝点：内嵌中文轨标签 '${tag}' 必须被认出 → dot='blue'`, () => {
        addWork('tmdb:12', { title: 'Embedded' })
        addCanonical('tmdb:12', 1, [1])
        addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:12', season: 1, episode: 1, embeddedLangs: ['eng', tag] })
        expect(buildMediaLibraryDetail(db, 'tmdb:12')!.seasons[0].episodes[0].dot).toBe('blue')
      })
    }

    it("🔴 绿点：sub_status='covered'（磁盘上观察到外挂中文 sidecar）→ dot='green'", () => {
      addWork('tmdb:13', { title: 'Covered' })
      addCanonical('tmdb:13', 1, [1])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:13', season: 1, episode: 1, subStatus: 'covered' })
      expect(buildMediaLibraryDetail(db, 'tmdb:13')!.seasons[0].episodes[0].dot).toBe('green')
    })

    it('🔴 绿点优先于蓝点：外挂 + 内嵌同时有时报 green（用户能改的那份才是可操作信息）', () => {
      addWork('tmdb:14', { title: 'Both' })
      addCanonical('tmdb:14', 1, [1])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:14', season: 1, episode: 1, subStatus: 'covered', embeddedLangs: ['chi'] })
      expect(buildMediaLibraryDetail(db, 'tmdb:14')!.seasons[0].episodes[0].dot).toBe('green')
    })

    it("🔴 handoff_translate / unsolvable 不是「有字幕」→ 仍 none", () => {
      // 防回归：这两个是流程中间态（已移交翻译 / 判定无解），不是磁盘事实。把 sub_status
      // 非 NULL 当成"有字幕"会让排队中的集提前变绿点。
      addWork('tmdb:15', { title: 'InFlight' })
      addCanonical('tmdb:15', 1, [1, 2])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:15', season: 1, episode: 1, subStatus: 'handoff_translate' })
      addFile({ path: '/x/s1e2.mkv', workId: 'tmdb:15', season: 1, episode: 2, subStatus: 'unsolvable' })
      expect(buildMediaLibraryDetail(db, 'tmdb:15')!.seasons[0].episodes.map((e) => e.dot)).toEqual(['none', 'none'])
    })

    it("🔴 应有但磁盘没有的那一集（虚线）→ dot 恒 none（没有文件就没有字幕事实）", () => {
      addWork('tmdb:16', { title: 'Dashed' })
      addCanonical('tmdb:16', 1, [1, 2])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:16', season: 1, episode: 1, subStatus: 'covered' })
      const eps = buildMediaLibraryDetail(db, 'tmdb:16')!.seasons[0].episodes
      expect(eps[1]).toMatchObject({ episode: 2, onDisk: false, dot: 'none' })
    })
  })

  describe('🔴 R-F2「不管来源」聚合（防猴子用户，用户点名条款）', () => {
    it('同一 work_id 下同一集两份文件，任一份有外挂字幕 → 该集算已获取（绿点）', () => {
      // 用户原话：两个「绝命毒师」目录，只要有一处 S01E03 有字幕，媒体库就显示这一集已获取
      // ——即使另一处那份仍要单独去配。合并键 = work_id。
      addWork('tmdb:1', { title: 'Breaking Bad' })
      addCanonical('tmdb:1', 1, [3])
      addFile({ path: '/media/bb-1080p/S01E03.mkv', workId: 'tmdb:1', season: 1, episode: 3, subStatus: 'covered' })
      addFile({ path: '/media/bb-4k/S01E03.mkv', workId: 'tmdb:1', season: 1, episode: 3, subStatus: null })

      const ep = buildMediaLibraryDetail(db, 'tmdb:1')!.seasons[0].episodes[0]
      expect(ep.dot).toBe('green')
      expect(ep.onDisk).toBe(true)
      // 一集一张卡片——两份文件不许变成两张卡
      expect(buildMediaLibraryDetail(db, 'tmdb:1')!.seasons[0].episodes).toHaveLength(1)
      // 但"另一处那份仍要单独去配"这个事实不许丢：文件级明细如实呈报。
      expect(ep.fileCount).toBe(2)
      expect(ep.subtitledFileCount).toBe(1)
    })

    it('顺序无关：无字幕的那份先入库、有字幕的后入库，结论同样是绿点', () => {
      // 防回归：`.get()` 取首行式的实现会因入库顺序不同给出相反结论——最阴险的形态是
      // 测试用例恰好按"有字幕的在前"写，于是永远绿。
      addWork('tmdb:1', { title: 'Breaking Bad' })
      addCanonical('tmdb:1', 1, [3])
      addFile({ path: '/media/bb-4k/S01E03.mkv', workId: 'tmdb:1', season: 1, episode: 3, subStatus: null })
      addFile({ path: '/media/bb-1080p/S01E03.mkv', workId: 'tmdb:1', season: 1, episode: 3, subStatus: 'covered' })
      expect(buildMediaLibraryDetail(db, 'tmdb:1')!.seasons[0].episodes[0].dot).toBe('green')
    })

    it('内嵌轨同样按任一份算：一份有 chi 内嵌轨、另一份零轨 → 蓝点', () => {
      addWork('tmdb:1', { title: 'Breaking Bad' })
      addCanonical('tmdb:1', 1, [3])
      addFile({ path: '/a/S01E03.mkv', workId: 'tmdb:1', season: 1, episode: 3, embeddedLangs: [] })
      addFile({ path: '/b/S01E03.mkv', workId: 'tmdb:1', season: 1, episode: 3, embeddedLangs: ['chi'] })
      expect(buildMediaLibraryDetail(db, 'tmdb:1')!.seasons[0].episodes[0].dot).toBe('blue')
    })

    it('🔴 不同 work_id 的同季同集互不影响（合并键是 work_id，不是 season/episode）', () => {
      addWork('tmdb:1', { title: 'A' })
      addWork('tmdb:2', { title: 'B' })
      addCanonical('tmdb:1', 1, [1])
      addCanonical('tmdb:2', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:1', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:2', season: 1, episode: 1, subStatus: null })
      expect(buildMediaLibraryDetail(db, 'tmdb:1')!.seasons[0].episodes[0].dot).toBe('green')
      expect(buildMediaLibraryDetail(db, 'tmdb:2')!.seasons[0].episodes[0].dot).toBe('none')
    })

    it('🔴 孤儿文件（work_id IS NULL）不许被算进任何作品的聚合', () => {
      addWork('tmdb:1', { title: 'A' })
      addCanonical('tmdb:1', 1, [1])
      addFile({ path: '/orphan/s1e1.mkv', workId: null, season: 1, episode: 1, subStatus: 'covered' })
      expect(buildMediaLibraryDetail(db, 'tmdb:1')!.seasons[0].episodes[0].dot).toBe('none')
    })
  })

  describe('🔴 EpisodeState 八态（R-F12 集号染色，优先级链在后端）', () => {
    /** 造一集一份文件，返回那一格的 episodeState。 */
    function stateOf(o: {
      subStatus?: string | null
      embeddedLangs?: string[] | null
      needsSubtitle?: number | null
      skipReason?: string | null
    }): string {
      addWork('tmdb:800', { title: 'StateProbe' })
      addCanonical('tmdb:800', 1, [1])
      addFile({ path: '/s/s1e1.mkv', workId: 'tmdb:800', season: 1, episode: 1, ...o })
      return buildMediaLibraryDetail(db, 'tmdb:800')!.seasons[0].episodes[0].episodeState
    }

    // ── ① sub_status 全值域逐个透传 ────────────────────────────────────────────
    // grep 全部生产写入点得到的实际值域是 { NULL, 'covered', 'handoff_translate', 'unsolvable' }
    // ——db.ts:555 的注释（'missing'/'covered'/'embedded'/'unavailable'）四个里三个是错的，
    // 该列无 CHECK 约束、注释是照旧 episodes/movies 表抄的。这四行把**代码实际会写入的**
    // 每一个值各钉一行，不依赖生产样本（生产 unsolvable/handoff_translate 各 0 行）。
    it("sub_status='covered' → 'covered'", () => {
      expect(stateOf({ subStatus: 'covered' })).toBe('covered')
    })

    it("sub_status='handoff_translate' → 'translating'（生产 0 行，靠造数据验）", () => {
      expect(stateOf({ subStatus: 'handoff_translate' })).toBe('translating')
    })

    it("sub_status='unsolvable' → 'unsolvable'（生产 0 行，靠造数据验）", () => {
      expect(stateOf({ subStatus: 'unsolvable' })).toBe('unsolvable')
    })

    it("sub_status=NULL + needs_subtitle=1 → 'pending'", () => {
      expect(stateOf({ subStatus: null, needsSubtitle: 1 })).toBe('pending')
    })

    // ── ② needs_subtitle / skip_reason ────────────────────────────────────────
    it("skip_reason='origin-skip' → 'origin-skip'（◇ 原生同语言）", () => {
      expect(stateOf({ needsSubtitle: 0, skipReason: 'origin-skip' })).toBe('origin-skip')
    })

    it("skip_reason='embedded' → 'embedded'（◆ 自带目标语言内嵌轨）", () => {
      expect(stateOf({ needsSubtitle: 0, skipReason: 'embedded' })).toBe('embedded')
    })

    it("🔴 第 8 态：needs_subtitle IS NULL → 'unjudged'（judge 还没轮到它）", () => {
      // 这一态是本 task 的存在理由之一：新扫进来的文件、以及被 D17 回填/指纹重置清空判决的行
      // 都会在这里停留一轮。塌缩进 pending 就是把"系统还没结论"说成"系统认为需要找字幕"（病 B）。
      expect(stateOf({ subStatus: null, needsSubtitle: null })).toBe('unjudged')
    })

    it("🔴 needs_subtitle=0 但 skip_reason 缺失（v40 之前的存量行）→ 'unjudged'，不许猜 ◇/◆", () => {
      // 生产实测：skip_reason 1192 行全 NULL。这批行 judge 判过（needs=0）但没留理由。
      // origin-skip 与 embedded 在换目标语言后命运完全相反，猜任何一个都是编造事实。
      expect(stateOf({ needsSubtitle: 0, skipReason: null })).toBe('unjudged')
    })

    it("needs_subtitle=0 + 不认识的 skip_reason → 'unjudged'（将来加了新 reason 而忘了跟这里）", () => {
      expect(stateOf({ needsSubtitle: 0, skipReason: 'brand-new-reason' })).toBe('unjudged')
    })

    it("未知的非 NULL sub_status → 'unjudged'（无 CHECK 约束，宁可说不知道也不归进 pending）", () => {
      expect(stateOf({ subStatus: 'some-future-parked-state', needsSubtitle: 1 })).toBe('unjudged')
    })

    // ── ③ 优先级链：冲突组合是常态不是边缘（设计文档教训八）────────────────────
    it("🔴 sub_status 优先于 needs_subtitle：handoff_translate + needs_subtitle=1 → 'translating'", () => {
      // 这是**正常库里必然出现**的组合，不是编造的边缘：subtitleScheduler.ts:326 满 7 次
      // 把行写成 handoff_translate，而 needs_subtitle 一直是 1（D8：装盘与停牌都不改它）。
      // 若 pending 排在前面，每一个在翻译的集都显示 '···'，⇄ 态在真实库里永不出现。
      expect(stateOf({ subStatus: 'handoff_translate', needsSubtitle: 1 })).toBe('translating')
    })

    it("🔴 unsolvable + needs_subtitle=1 → 'unsolvable'（同上，⊘ 态不许被 pending 吃掉）", () => {
      expect(stateOf({ subStatus: 'unsolvable', needsSubtitle: 1 })).toBe('unsolvable')
    })

    it("🔴 retarget 造出的真实组合：handoff_translate + needs_subtitle IS NULL → 'translating'", () => {
      // retarget.ts 换目标语言时清 needs_subtitle + skip_reason，却**刻意不清 sub_status**
      // （R24 铁律，清了会掀掉飞行中的翻译 / D10 守卫匹配 0 行）。于是这个组合必然出现。
      // 若 unjudged 排在 translating 前面，正在被翻译的那一集会显示 '?'。
      expect(stateOf({ subStatus: 'handoff_translate', needsSubtitle: null })).toBe('translating')
    })

    it("🔴 covered 优先于 translating：字幕已在盘上就不许显示「还在翻译」", () => {
      // observeSubtitle（daemonV2.ts:1603）对扫到 sidecar 的行**无条件**写 covered，
      // 停牌的解除凭据就是它（R23）。反向由 D10 的乐观守卫兜死。
      expect(stateOf({ subStatus: 'covered', needsSubtitle: 1 })).toBe('covered')
    })

    it("🔴 covered 优先于 skip_reason：needs=0(origin-skip) 但磁盘上真有字幕 → 'covered'", () => {
      expect(stateOf({ subStatus: 'covered', needsSubtitle: 0, skipReason: 'origin-skip' })).toBe('covered')
    })

    it("🔴 origin-skip 先于 embedded：国产片同时带中文内嵌轨 → 'origin-skip'", () => {
      // 照抄 judgeSubtitle 自己的规则顺序（origin_lang 命中在前）。反过来的话显示的 ◆
      // 会与库里 skip_reason 的值直接矛盾——同一个事实两处对不上，排障时无从下手。
      // judge 对这种片子写进 skip_reason 的就是 'origin-skip'，这里必须与它一致。
      expect(stateOf({ needsSubtitle: 0, skipReason: 'origin-skip', embeddedLangs: ['chi'] }))
        .toBe('origin-skip')
    })

    // ── ④ 虚线格与 R-F2 聚合 ──────────────────────────────────────────────────
    it("🔴 虚线格（onDisk=false）→ 'absent'，不染色", () => {
      addWork('tmdb:801', { title: 'Dashed' })
      addCanonical('tmdb:801', 1, [1, 2])
      addFile({ path: '/s/s1e1.mkv', workId: 'tmdb:801', season: 1, episode: 1, subStatus: 'covered' })
      const eps = buildMediaLibraryDetail(db, 'tmdb:801')!.seasons[0].episodes
      expect(eps.map((e) => [e.onDisk, e.episodeState])).toEqual([[true, 'covered'], [false, 'absent']])
    })

    it('🔴 R-F2 同一集两份文件：取优先级链最靠前的那一份（一份 covered、一份 pending → covered）', () => {
      addWork('tmdb:802', { title: 'TwoCopies' })
      addCanonical('tmdb:802', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:802', season: 1, episode: 1, subStatus: null, needsSubtitle: 1 })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:802', season: 1, episode: 1, subStatus: 'covered' })
      expect(buildMediaLibraryDetail(db, 'tmdb:802')!.seasons[0].episodes[0].episodeState).toBe('covered')
    })

    it('🔴 顺序无关：把上一条的两份文件调换入库顺序，结论必须一模一样', () => {
      // 防"取首行"式实现——它会因入库顺序不同给出相反结论，而测试若恰好按"好的在前"写就永远绿。
      addWork('tmdb:803', { title: 'TwoCopiesRev' })
      addCanonical('tmdb:803', 1, [1])
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:803', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:803', season: 1, episode: 1, subStatus: null, needsSubtitle: 1 })
      expect(buildMediaLibraryDetail(db, 'tmdb:803')!.seasons[0].episodes[0].episodeState).toBe('covered')
    })

    it('🔴 与 dot 同源：两个控件不许对同一格给出互相矛盾的结论', () => {
      // dot 是 episodeState 的有损投影（covered→green / embedded→blue / 其余→none）。
      // 这条把"投影关系"本身钉住：任何一侧单独改判据都会在这里红。
      addWork('tmdb:804', { title: 'Consistency' })
      addCanonical('tmdb:804', 1, [1, 2, 3])
      addFile({ path: '/c/s1e1.mkv', workId: 'tmdb:804', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/c/s1e2.mkv', workId: 'tmdb:804', season: 1, episode: 2, needsSubtitle: 0, skipReason: 'embedded', embeddedLangs: ['chi'] })
      addFile({ path: '/c/s1e3.mkv', workId: 'tmdb:804', season: 1, episode: 3, subStatus: 'unsolvable' })
      const eps = buildMediaLibraryDetail(db, 'tmdb:804')!.seasons[0].episodes
      expect(eps.map((e) => [e.episodeState, e.dot])).toEqual([
        ['covered', 'green'], ['embedded', 'blue'], ['unsolvable', 'none'],
      ])
    })

    it('🔴 电影那一格同样带 episodeState（不是只有剧集有）', () => {
      addWork('tmdb:805', { title: 'A Movie', mediaType: 'movie' })
      addFile({ path: '/m/a.mkv', workId: 'tmdb:805', season: null, episode: null, subStatus: 'handoff_translate' })
      expect(buildMediaLibraryDetail(db, 'tmdb:805')!.movie!.episodeState).toBe('translating')
    })

    it('🔴 SubtitleDot 保持三态：八态落地不许改动 dot 的既有取值', () => {
      // 它被三个 DTO 共用（列表页海报卡是"底部渐变嵌进度条"不是点）。扩它会波及列表页。
      // 五个非 covered/embedded 的态在 dot 上必须全部塌缩成 'none'，一个都不许漏出去。
      addWork('tmdb:806', { title: 'DotStable' })
      addCanonical('tmdb:806', 1, [1, 2, 3, 4])
      addFile({ path: '/d/s1e1.mkv', workId: 'tmdb:806', season: 1, episode: 1, subStatus: 'handoff_translate' })
      addFile({ path: '/d/s1e2.mkv', workId: 'tmdb:806', season: 1, episode: 2, subStatus: 'unsolvable' })
      addFile({ path: '/d/s1e3.mkv', workId: 'tmdb:806', season: 1, episode: 3, needsSubtitle: 0, skipReason: 'origin-skip' })
      addFile({ path: '/d/s1e4.mkv', workId: 'tmdb:806', season: 1, episode: 4, needsSubtitle: null })
      const eps = buildMediaLibraryDetail(db, 'tmdb:806')!.seasons[0].episodes
      expect(eps.map((e) => e.episodeState)).toEqual(['translating', 'unsolvable', 'origin-skip', 'unjudged'])
      expect(new Set(eps.map((e) => e.dot))).toEqual(new Set(['none']))
    })
  })

  describe('电影详情', () => {
    it('🔴 电影没有季集网格：seasons 为空，只有 movie 那一格的字幕事实', () => {
      addWork('tmdb:100', { title: 'Dune', mediaType: 'movie', year: 2021, posterPath: '/d.jpg' })
      addFile({ path: '/m/dune.mkv', workId: 'tmdb:100', season: null, episode: null, subStatus: 'covered' })

      const detail = buildMediaLibraryDetail(db, 'tmdb:100')!
      expect(detail.work).toMatchObject({ workId: 'tmdb:100', mediaType: 'movie', title: 'Dune', year: 2021 })
      expect(detail.seasons).toEqual([])
      expect(detail.movie).toMatchObject({ dot: 'green', fileCount: 1, subtitledFileCount: 1 })
    })

    it('电影无字幕 → dot none；剧集的 movie 字段恒 null', () => {
      addWork('tmdb:101', { title: 'Bare Movie', mediaType: 'movie' })
      addFile({ path: '/m/bare.mkv', workId: 'tmdb:101', season: null, episode: null })
      expect(buildMediaLibraryDetail(db, 'tmdb:101')!.movie!.dot).toBe('none')

      addWork('tmdb:102', { title: 'A Show', mediaType: 'tv' })
      addFile({ path: '/t/s1e1.mkv', workId: 'tmdb:102', season: 1, episode: 1 })
      expect(buildMediaLibraryDetail(db, 'tmdb:102')!.movie).toBeNull()
    })

    it('🔴 R-F2 电影也按任一份算：两份拷贝，一份有字幕 → 绿点', () => {
      addWork('tmdb:103', { title: 'Dup Movie', mediaType: 'movie' })
      addFile({ path: '/a/dup.mkv', workId: 'tmdb:103', season: null, episode: null, subStatus: null })
      addFile({ path: '/b/dup.mkv', workId: 'tmdb:103', season: null, episode: null, subStatus: 'covered' })
      const m = buildMediaLibraryDetail(db, 'tmdb:103')!.movie!
      expect(m.dot).toBe('green')
      expect(m.fileCount).toBe(2)
      expect(m.subtitledFileCount).toBe(1)
    })

    it('🔴 剧集里 season/episode 解析不出的文件（NULL）不许伪装成第 0 季卡片', () => {
      // files.season/episode 可空（parse_confidence='none'）。这类行进不了季集网格——
      // 强行按 NULL 分组会造出一个 season=null 的幽灵季。
      addWork('tmdb:104', { title: 'Partial Parse', mediaType: 'tv' })
      addFile({ path: '/t/s1e1.mkv', workId: 'tmdb:104', season: 1, episode: 1 })
      addFile({ path: '/t/weird-name.mkv', workId: 'tmdb:104', season: null, episode: null })
      const detail = buildMediaLibraryDetail(db, 'tmdb:104')!
      expect(detail.seasons.map((s) => s.season)).toEqual([1])
      expect(detail.seasons[0].episodes).toHaveLength(1)
      // 但这类文件的存在必须如实报告（不然用户看不出"有文件没进网格"）
      expect(detail.unplacedFileCount).toBe(1)
    })
  })

  it('坏 JSON 的 embedded_langs 按「没探过」处理，不许抛', () => {
    addWork('tmdb:200', { title: 'Bad JSON' })
    addCanonical('tmdb:200', 1, [1])
    db.prepare(
      `INSERT INTO files (path, dir, filename, size, mtime, work_id, season, episode, embedded_langs, updated_at)
       VALUES ('/x/s1e1.mkv','/x','f.mkv',1,1,'tmdb:200',1,1,'{not json',1)`,
    ).run()
    expect(() => buildMediaLibraryDetail(db, 'tmdb:200')).not.toThrow()
    expect(buildMediaLibraryDetail(db, 'tmdb:200')!.seasons[0].episodes[0].dot).toBe('none')
  })
})
