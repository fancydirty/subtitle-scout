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
  filename?: string
}): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, season, episode, sub_status, embedded_langs, needs_subtitle, skip_reason, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.path, '/d', o.filename ?? 'f.mkv', 100, NOW, '/d', o.workId,
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

  describe('uncoveredEpisodeCount（本地集 − 已下载 − 自带，后端夹 0）', () => {
    it('AHS 形：9 green + 11 blue / 20 onDisk → uncovered=0', () => {
      addWork('tmdb:ahs', { title: 'AHS' })
      for (let e = 1; e <= 9; e++) {
        addFile({ path: `/a/s1e${e}.mkv`, workId: 'tmdb:ahs', season: 1, episode: e, subStatus: 'covered' })
      }
      for (let e = 10; e <= 20; e++) {
        addFile({
          path: `/a/s1e${e}.mkv`, workId: 'tmdb:ahs', season: 1, episode: e,
          embeddedLangs: ['zh'],
        })
      }
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(20)
      expect(item.subtitledEpisodeCount).toBe(9)
      expect(item.embeddedEpisodeCount).toBe(11)
      expect(item.uncoveredEpisodeCount).toBe(0)
    })

    it('12 covered + 0 embedded / 30 onDisk → uncovered=18', () => {
      addWork('tmdb:bb', { title: 'BB' })
      for (let e = 1; e <= 30; e++) {
        addFile({
          path: `/b/s1e${e}.mkv`, workId: 'tmdb:bb', season: 1, episode: e,
          subStatus: e <= 12 ? 'covered' : null,
        })
      }
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(30)
      expect(item.subtitledEpisodeCount).toBe(12)
      expect(item.embeddedEpisodeCount).toBe(0)
      expect(item.uncoveredEpisodeCount).toBe(18)
    })

    it('电影 0/1 → uncovered=1；有 sidecar → 0', () => {
      addWork('tmdb:m0', { title: 'Bare', mediaType: 'movie' })
      addFile({ path: '/m/bare.mkv', workId: 'tmdb:m0', season: null, episode: null })
      expect(buildMediaLibrary(db)[0].uncoveredEpisodeCount).toBe(1)

      addWork('tmdb:m1', { title: 'Done', mediaType: 'movie' })
      addFile({ path: '/m/done.mkv', workId: 'tmdb:m1', season: null, episode: null, subStatus: 'covered' })
      expect(buildMediaLibrary(db).find((w) => w.workId === 'tmdb:m1')!.uncoveredEpisodeCount).toBe(0)
    })
   })

  describe('🔴 target_language 切换后内嵌轨按目标语言计数（2026-08-19 AHS/DxD 实案）', () => {
    // 生产事故：目标切 en 后，媒体库 index 的「自带 N」与蓝点硬编码中文——内嵌英文轨
    // 的文件不计入自带、显示成「没字幕」，而详情页因走 judge 按目标语言写的 skip_reason
    // 反而是对的（同一张页两个口径）。根因：fileHasEmbeddedChinese 硬编码 zh。
    it('en 目标 + 内嵌 eng 轨 → 自带计入、uncovered=0（不再显示「没字幕」）', () => {
      addWork('tmdb:ahs', { title: 'AHS' })
      addFile({
        path: '/a/s1e1.mkv', workId: 'tmdb:ahs', season: 1, episode: 1,
        embeddedLangs: ['eng'], needsSubtitle: 0, skipReason: 'embedded',
      })
      const [item] = buildMediaLibrary(db, 'en')
      expect(item.embeddedEpisodeCount).toBe(1)
      expect(item.uncoveredEpisodeCount).toBe(0)
      expect(item.subtitledEpisodeCount).toBe(0)
    })

    it('en 目标 + 内嵌三字母码 eng → 同样计入（isLang 三字母映射，同 judge 规则 2 修法）', () => {
      addWork('tmdb:tri', { title: 'Tri' })
      addFile({
        path: '/t/s1e1.mkv', workId: 'tmdb:tri', season: 1, episode: 1,
        embeddedLangs: ['jpn', 'eng'], needsSubtitle: 0, skipReason: 'embedded',
      })
      const [item] = buildMediaLibrary(db, 'en')
      expect(item.embeddedEpisodeCount).toBe(1)
    })

    it('en 目标 + 只有中文轨（不是目标语言）→ 不计入自带', () => {
      addWork('tmdb:zhonly', { title: 'ZhOnly' })
      addFile({
        path: '/z/s1e1.mkv', workId: 'tmdb:zhonly', season: 1, episode: 1,
        embeddedLangs: ['chi'], needsSubtitle: 1, skipReason: null,
      })
      const [item] = buildMediaLibrary(db, 'en')
      expect(item.embeddedEpisodeCount).toBe(0)
      expect(item.uncoveredEpisodeCount).toBe(1)
    })

    it('zh 目标（默认）+ 内嵌 chi 轨 → 自带计入（回归锁：旧默认行为不许破）', () => {
      addWork('tmdb:zh', { title: 'ZhShow' })
      addFile({
        path: '/c/s1e1.mkv', workId: 'tmdb:zh', season: 1, episode: 1,
        embeddedLangs: ['chi'], needsSubtitle: 0, skipReason: 'embedded',
      })
      const [item] = buildMediaLibrary(db) // 默认 zh
      expect(item.embeddedEpisodeCount).toBe(1)
      expect(item.uncoveredEpisodeCount).toBe(0)
    })

    it('详情页电影格同样按目标语言计 dot（en 目标 + eng 内嵌 → blue，不是 none）', () => {
      addWork('tmdb:dxe', { title: 'DxEn', mediaType: 'movie' })
      addFile({
        path: '/d/movie.mkv', workId: 'tmdb:dxe', season: null, episode: null,
        embeddedLangs: ['eng'], needsSubtitle: 0, skipReason: 'embedded',
      })
      const detail = buildMediaLibraryDetail(db, 'tmdb:dxe', 'en')
      expect(detail?.movie?.dot).toBe('blue')
    })

    it('🔴 origin-skip（原生就是目标语言、无内嵌轨）→ uncovered=0，不显示「没字幕」（2026-08-19 Young Sheldon 实案）', () => {
      // 小谢尔顿 origin=en + target=en → judge 判 origin-skip → embedded_langs=[]（BD 无内嵌
      // 文本轨）→ dot 'none'。旧公式 uncovered = onDisk - subtitled - embedded = 16 - 0 - 0 = 16
      // → 列表页「还有 16 集没字幕」，详情页「原生就是目标语言」——同一张页两个口径。
      addWork('tmdb:ys', { title: 'Young Sheldon' })
      for (let e = 1; e <= 16; e++) {
        addFile({
          path: `/y/s4e${e}.mkv`, workId: 'tmdb:ys', season: 4, episode: e,
          embeddedLangs: [], needsSubtitle: 0, skipReason: 'origin-skip',
        })
      }
      const [item] = buildMediaLibrary(db, 'en')
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(0)
      expect(item.uncoveredEpisodeCount).toBe(0)
    })
  })

  describe('🔴 ready/native 分区守恒（2026-08-19 Young Sheldon/Derry/Peacemaker 实案）', () => {
    it('16 个 origin-skip 且没有内嵌轨 → ready=16、native=16、uncovered=0', () => {
      addWork('tmdb:ys-ready', { title: 'Young Sheldon' })
      for (let e = 1; e <= 16; e++) {
        addFile({
          path: `/ys/s4e${e}.mkv`, workId: 'tmdb:ys-ready', season: 4, episode: e,
          embeddedLangs: [], needsSubtitle: 0, skipReason: 'origin-skip',
        })
      }

      const [item] = buildMediaLibrary(db, 'en')
      expect(item).toMatchObject({
        onDiskEpisodeCount: 16,
        subtitledEpisodeCount: 0,
        embeddedEpisodeCount: 0,
        originLanguageEpisodeCount: 16,
        readyEpisodeCount: 16,
        uncoveredEpisodeCount: 0,
      })
      expect(item.readyEpisodeCount + item.uncoveredEpisodeCount).toBe(item.onDiskEpisodeCount)
    })

    it('7 个内嵌 + 1 个 origin-skip → ready=8、embedded=7、native=1', () => {
      addWork('tmdb:derry-ready', { title: 'IT: Welcome to Derry' })
      for (let e = 1; e <= 8; e++) {
        addFile({
          path: `/derry/s1e${e}.mkv`, workId: 'tmdb:derry-ready', season: 1, episode: e,
          embeddedLangs: e <= 7 ? ['eng'] : [], needsSubtitle: 0, skipReason: 'origin-skip',
        })
      }

      const [item] = buildMediaLibrary(db, 'en')
      expect(item).toMatchObject({
        onDiskEpisodeCount: 8,
        embeddedEpisodeCount: 7,
        originLanguageEpisodeCount: 1,
        readyEpisodeCount: 8,
        uncoveredEpisodeCount: 0,
      })
    })

    it('8 个内嵌 + 8 个 origin-skip → ready=16、两个原因各自保留', () => {
      addWork('tmdb:peace-ready', { title: 'Peacemaker' })
      for (let e = 1; e <= 16; e++) {
        addFile({
          path: `/peace/s${e <= 8 ? 1 : 2}e${e <= 8 ? e : e - 8}.mkv`,
          workId: 'tmdb:peace-ready', season: e <= 8 ? 1 : 2, episode: e <= 8 ? e : e - 8,
          embeddedLangs: e <= 8 ? [] : ['eng'], needsSubtitle: 0, skipReason: 'origin-skip',
        })
      }

      const [item] = buildMediaLibrary(db, 'en')
      expect(item).toMatchObject({
        onDiskEpisodeCount: 16,
        embeddedEpisodeCount: 8,
        originLanguageEpisodeCount: 8,
        readyEpisodeCount: 16,
        uncoveredEpisodeCount: 0,
      })
    })

    it('sidecar 优先于内嵌和 origin-skip，ready 仍只计一次', () => {
      addWork('tmdb:covered-ready', { title: 'Covered' })
      addFile({
        path: '/covered/s1e1.mkv', workId: 'tmdb:covered-ready', season: 1, episode: 1,
        subStatus: 'covered', embeddedLangs: ['eng'], needsSubtitle: 0, skipReason: 'origin-skip',
      })

      const [item] = buildMediaLibrary(db, 'en')
      expect(item).toMatchObject({
        subtitledEpisodeCount: 1,
        embeddedEpisodeCount: 0,
        originLanguageEpisodeCount: 0,
        readyEpisodeCount: 1,
        uncoveredEpisodeCount: 0,
      })
    })
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

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-13：列表页与详情页对同一部剧的"磁盘上有几集"必须一致
  // ══════════════════════════════════════════════════════════════════════════
  // 生产症状：同一部剧，列表说「磁盘 78 / 缺 7」，详情说「磁盘 77 / 缺 8」。
  // 根因：列表页把 season/episode 为 NULL 的文件全塞进 key 为 '' 的**同一个假格**，
  // 于是 67 个特典文件给 cells.size 贡献 +1；详情页按 tmdb_seasons 逐格铺，它们进不去。
  describe('🔴 解析不出季集的文件（特典）不算进"磁盘上有几集"', () => {
    it('🔴 67 个进不了网格的文件 → onDisk **不因它们 +1**，而是记进 unplacedFileCount', () => {
      addWork('tmdb:50', { title: 'Extras Heavy' })
      addCanonical('tmdb:50', 1, [1, 2])
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:50', season: 1, episode: 1 })
      for (let i = 0; i < 67; i++) {
        addFile({ path: `/x/NCOP${i}.mkv`, workId: 'tmdb:50', season: null, episode: null })
      }
      const [item] = buildMediaLibrary(db)
      // 旧实现：onDisk=2（1 集 + 那个假格），missing=0。两个数字都是假的。
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.missingEpisodeCount).toBe(1)
      expect(item.unplacedFileCount).toBe(67)
    })

    it('🔴🔴 列表页与详情页的 onDisk / unplaced **逐字一致**（那条自相矛盾的直接判据）', () => {
      // 不断言各自的常量，而是把两页的数放在一起比——这是"两处漂移"唯一照得出来的形态。
      addWork('tmdb:51', { title: 'Cross Check' })
      addCanonical('tmdb:51', 1, [1, 2, 3])
      addFile({ path: '/y/s1e1.mkv', workId: 'tmdb:51', season: 1, episode: 1 })
      addFile({ path: '/y/s1e2.mkv', workId: 'tmdb:51', season: 1, episode: 2 })
      addFile({ path: '/y/NCED.mkv', workId: 'tmdb:51', season: null, episode: null })
      addFile({ path: '/y/menu.mkv', workId: 'tmdb:51', season: null, episode: null })

      const [item] = buildMediaLibrary(db)
      const detail = buildMediaLibraryDetail(db, 'tmdb:51')!
      const detailOnDisk = detail.seasons
        .flatMap((s) => s.episodes)
        .filter((e) => e.onDisk).length

      expect(item.onDiskEpisodeCount).toBe(detailOnDisk)
      expect(item.unplacedFileCount).toBe(detail.unplacedFileCount)
      // 阳性对照：这两个数不是恰好都为 0（否则一个恒返回 0 的实现也全绿）。
      expect(item.onDiskEpisodeCount).toBe(2)
      expect(item.unplacedFileCount).toBe(2)
    })

    it('🔴 一个 unplaced 都没有 → 恒 0（不许长出一个凭空的计数）', () => {
      addWork('tmdb:52', { title: 'Clean' })
      addFile({ path: '/z/s1e1.mkv', workId: 'tmdb:52', season: 1, episode: 1 })
      expect(buildMediaLibrary(db)[0].unplacedFileCount).toBe(0)
    })

    it('🔴 **电影不受影响**：它的文件本来就没季集，仍然算 1 格、unplaced 恒 0', () => {
      // 这条守的是那个 media_type 分流。一刀切按 NULL 判会把每部电影的唯一那份文件
      // 判成 unplaced → 全库电影的 onDisk 一夜之间变 0（而详情页照常显示有字幕）。
      addWork('tmdb:53', { title: 'Dune', mediaType: 'movie' })
      addFile({ path: '/m/dune.mkv', workId: 'tmdb:53', season: null, episode: null, subStatus: 'covered' })
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.subtitledEpisodeCount).toBe(1)
      expect(item.unplacedFileCount).toBe(0)
      expect(buildMediaLibraryDetail(db, 'tmdb:53')!.unplacedFileCount).toBe(0)
    })

    it('🔴 unplaced 文件即便**有字幕**也不计进 subtitledEpisodeCount（它不是"一集"）', () => {
      // 否则会出现 subtitled > onDisk：卡片上写「已配 2 · 磁盘 1」，用户当场看出这是假的。
      addWork('tmdb:54', { title: 'Subtitled Extra' })
      addFile({ path: '/w/s1e1.mkv', workId: 'tmdb:54', season: 1, episode: 1 })
      addFile({ path: '/w/PV.mkv', workId: 'tmdb:54', season: null, episode: null, subStatus: 'covered' })
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.unplacedFileCount).toBe(1)
    })

    it('🔴 只有 unplaced 文件的剧**仍然出现在海报墙上**（不许静默消失）', () => {
      // "不算进集数"绝不等于"这部剧不存在"。works JOIN files 仍然命中，
      // 卡片照出，只是它说"磁盘 0 集 · 3 个文件没进季集网格"——那才是真话。
      addWork('tmdb:55', { title: 'All Extras' })
      for (const n of ['NCOP', 'NCED', 'PV']) {
        addFile({ path: `/e/${n}.mkv`, workId: 'tmdb:55', season: null, episode: null })
      }
      const [item] = buildMediaLibrary(db)
      expect(item.workId).toBe('tmdb:55')
      expect(item.onDiskEpisodeCount).toBe(0)
      expect(item.unplacedFileCount).toBe(3)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-13（同日第二条裁决）：机械特典**不算进 unplacedFileCount**
  // ══════════════════════════════════════════════════════════════════════════
  // 用户原话：「特典逻辑我觉得可以删除掉，感觉为它增加我们的心智负担不值得。」
  //
  // 此前 unplacedFileCount 把两种东西混成一个数：
  //   · 系统**故意不管**的（NCOP/NCED/PV/menu —— judge 已判 skip_reason='extra'）
  //   · 系统**没搞定**的（解析器在真剧集上失败，改文件名即可修好）
  // 生产实测 Re:ZERO 报 67，其中 16 个属前者、51 个属后者。一个数同时表达两件事，
  // 用户无从分辨，而前者根本不需要他动一根手指——那正是"占脑子"。
  //
  // 扣除后这个数只剩一种含义：「解析器没能归位的真实文件」，且**可行动**。
  // 特典并没有被藏掉——它们在季集网格里以 episodeState='extra'（▭）可见。
  describe('🔴 机械特典（skip_reason=extra）不计入 unplacedFileCount', () => {
    it('🔴🔴 16 特典 + 51 解析失败 → unplaced 报 51，不是 67（生产 Re:ZERO 的真实构成）', () => {
      addWork('tmdb:60', { title: 'Re:ZERO' })
      addCanonical('tmdb:60', 1, [1])
      addFile({ path: '/r/s1e1.mkv', workId: 'tmdb:60', season: 1, episode: 1 })
      for (let i = 0; i < 16; i++) {
        addFile({ path: `/r/NCOP${i}.mkv`, workId: 'tmdb:60', season: null, episode: null,
          needsSubtitle: 0, skipReason: 'extra' })
      }
      for (let i = 0; i < 51; i++) {
        addFile({ path: `/r/unparsed${i}.mkv`, workId: 'tmdb:60', season: null, episode: null })
      }
      const [item] = buildMediaLibrary(db)
      expect(item.unplacedFileCount).toBe(51)
      // 特典既不进 unplaced、也**不进集数**（它们不是"某一集"）——两个数都不许被它们抬高。
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.missingEpisodeCount).toBe(0)
    })

    it('🔴 列表页与详情页**同一个数**（扣除口径也必须两页一致）', () => {
      // 这条守的是 isJudgedExtra 那份共用判据。两页各写一遍 `skip_reason==='extra'` 时，
      // 改一处忘一处会让两页的 unplacedFileCount 不相等——而这个字段当初正是为了修
      // "两页对同一部剧说不同的话"才引入的。
      addWork('tmdb:61', { title: 'Cross Check Extras' })
      addCanonical('tmdb:61', 1, [1])
      addFile({ path: '/c/s1e1.mkv', workId: 'tmdb:61', season: 1, episode: 1 })
      addFile({ path: '/c/NCOP.mkv', workId: 'tmdb:61', season: null, episode: null,
        needsSubtitle: 0, skipReason: 'extra' })
      addFile({ path: '/c/unparsed.mkv', workId: 'tmdb:61', season: null, episode: null })

      const [item] = buildMediaLibrary(db)
      const detail = buildMediaLibraryDetail(db, 'tmdb:61')!
      expect(item.unplacedFileCount).toBe(detail.unplacedFileCount)
      // 阳性对照：不是恰好都为 0，也不是"扣成了 0"——解析失败那一个必须还在。
      expect(item.unplacedFileCount).toBe(1)
    })

    it('🔴 **全是特典**的剧 → unplaced=0（用户一眼看过去无事可做，这就是"不占脑子"）', () => {
      addWork('tmdb:62', { title: 'All Mechanical Extras' })
      for (const n of ['NCOP', 'NCED', 'PV', 'menu']) {
        addFile({ path: `/a/${n}.mkv`, workId: 'tmdb:62', season: null, episode: null,
          needsSubtitle: 0, skipReason: 'extra' })
      }
      const [item] = buildMediaLibrary(db)
      expect(item.unplacedFileCount).toBe(0)
      expect(buildMediaLibraryDetail(db, 'tmdb:62')!.unplacedFileCount).toBe(0)
      // 但这部剧**仍然出现在海报墙上**——"不数它们"不等于"这部剧不存在"。
      expect(item.workId).toBe('tmdb:62')
    })

    it('🔴 judge 还没判到的行（skip_reason IS NULL）仍算 unplaced——诚实的"还没判"', () => {
      // 判据刻意是 `skip_reason='extra'`（judge 的判决）而不是在这一层重跑一次
      // isMechanicalExtra(filename)：后者是第二份判据，改 EXTRA_MARKERS 那天两处必然漂移。
      // 代价就是这一条——judge 还没轮到的特典会短暂被算进 unplaced。那是诚实的，不是错。
      addWork('tmdb:63', { title: 'Not Yet Judged' })
      addFile({ path: '/n/NCOP.mkv', workId: 'tmdb:63', season: null, episode: null,
        needsSubtitle: null, skipReason: null })
      expect(buildMediaLibrary(db)[0].unplacedFileCount).toBe(1)
    })

    it('🔴 其他 skip_reason（origin-skip / embedded）**照旧计入** unplaced', () => {
      // 只有 'extra' 这一个值有扣除效果。写成"needs_subtitle===0 就扣"会把一批
      // 国产片/带内嵌轨的**真剧集**（只是没解析出季集）一并藏掉——那是把"没搞定"藏了。
      addWork('tmdb:64', { title: 'Other Reasons' })
      addFile({ path: '/o/cn.mkv', workId: 'tmdb:64', season: null, episode: null,
        needsSubtitle: 0, skipReason: 'origin-skip' })
      addFile({ path: '/o/emb.mkv', workId: 'tmdb:64', season: null, episode: null,
        needsSubtitle: 0, skipReason: 'embedded' })
      expect(buildMediaLibrary(db)[0].unplacedFileCount).toBe(2)
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // 🔴 2026-08-14：「已配」与「自带」必须分开数（用户裁决③）
  // ══════════════════════════════════════════════════════════════════════════
  // 生产症状（实测 53/75 部作品命中）：《翘楚》列表页说「已配 5」，详情页 24 格
  // **全是**「原生语言不需要字幕」，数据库里外挂 sidecar 是 **0** 个 —— 那 5 集其实是
  // 片源自带的**内嵌字幕轨**。
  //
  // 根因：列表页的判据是 `aggregateDot(rows).dot !== 'none'`，把 green（外挂 sidecar）
  // 与 blue（内嵌轨）算成了同一件事。而 `subtitledEpisodeCount` 的字段定义写的是
  // 「已**获取**中文字幕的集数」——内嵌轨不是我们获取来的，磁盘上没有任何一份字幕文件。
  //
  // 用户裁决：**分开显示**（「已配 0 · 自带 5」）。理由是它是唯一能让两个页面说同一句话
  // 的方案：只数外挂会让数字突然变小且信息丢失，维持现状则两页永远对不上。
  //
  // 🔴 两个计数 = `dot` 三态的**逐格分区**，不是两个独立判据：
  //   subtitledEpisodeCount = dot==='green' 的格数（外挂 sidecar，可换可删的真文件）
  //   embeddedEpisodeCount  = dot==='blue'  的格数（片源自带轨，不需要处理）
  // 二者**互斥**（green 优先于 blue，同 aggregateDot 的既有口径），
  // 故 `subtitled + embedded === dot !== 'none' 的格数` 恒成立——旧那个数没有丢，
  // 只是被拆成了它本来就该是的两半。
  describe('🔴 外挂 sidecar 与内嵌轨分开计数', () => {
    it('🔴🔴 一格只有内嵌轨 → 进 embedded，**不进** subtitled（本 bug 的直接判据）', () => {
      // 这就是《翘楚》的形态：磁盘上 0 份字幕文件，却被报成「已配 5」。
      addWork('tmdb:289271', { title: 'Qiao Chu' })
      addCanonical('tmdb:289271', 1, [1, 2, 3])
      for (const ep of [1, 2, 3]) {
        addFile({ path: `/q/s1e${ep}.mkv`, workId: 'tmdb:289271', season: 1, episode: ep,
          subStatus: null, embeddedLangs: ['chi'] })
      }
      const [item] = buildMediaLibrary(db)
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(3)
    })

    it('🔴 一格有外挂 sidecar → 进 subtitled', () => {
      addWork('tmdb:70', { title: 'Sidecar Only' })
      addCanonical('tmdb:70', 1, [1, 2])
      addFile({ path: '/s/s1e1.mkv', workId: 'tmdb:70', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/s/s1e2.mkv', workId: 'tmdb:70', season: 1, episode: 2, subStatus: null })
      const [item] = buildMediaLibrary(db)
      expect(item.subtitledEpisodeCount).toBe(1)
      expect(item.embeddedEpisodeCount).toBe(0)
    })

    it('🔴 一格**内嵌 + 外挂都有** → 只算 subtitled（与 dot 的 green 优先自洽）', () => {
      // 理由：这两个数是 `dot` 三态的逐格分区，而 aggregateDot 已裁决「绿点优先于蓝点」
      // （外挂那份是用户能换能删的可操作对象，内嵌轨不是）。若这里两边都 +1，
      // 同一格会被数两次 → `subtitled + embedded > onDisk`，卡片上写「已配 3 · 自带 3 ·
      // 磁盘 3」，用户当场看出至少有一个数是假的。互斥是这两个数可加的前提。
      addWork('tmdb:71', { title: 'Both' })
      addCanonical('tmdb:71', 1, [1])
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:71', season: 1, episode: 1,
        subStatus: 'covered', embeddedLangs: ['chs'] })
      const [item] = buildMediaLibrary(db)
      expect(item.subtitledEpisodeCount).toBe(1)
      expect(item.embeddedEpisodeCount).toBe(0)
      // 两个数之和不许超过磁盘上的格数（同一格被数两次的唯一照妖镜）。
      expect(item.subtitledEpisodeCount + item.embeddedEpisodeCount)
        .toBeLessThanOrEqual(item.onDiskEpisodeCount)
    })

    it('🔴 一格里 A 份有外挂、B 份只有内嵌 → 仍只算 subtitled（R-F2 任一份算，格级）', () => {
      // 两个目录各一份的库。R-F2 的 `.some()` 在格级已经把它聚成 green，
      // 这里守的是分区判据读的是**聚合后的 dot**，不是逐份文件各自表态。
      addWork('tmdb:72', { title: 'Dup Dirs Mixed' })
      addCanonical('tmdb:72', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:72', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:72', season: 1, episode: 1,
        subStatus: null, embeddedLangs: ['zh'] })
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.subtitledEpisodeCount).toBe(1)
      expect(item.embeddedEpisodeCount).toBe(0)
    })

    it('🔴 没有任何中文字幕的格 → 两个数都不加', () => {
      addWork('tmdb:73', { title: 'Nothing' })
      addCanonical('tmdb:73', 1, [1, 2])
      addFile({ path: '/n/s1e1.mkv', workId: 'tmdb:73', season: 1, episode: 1,
        subStatus: null, embeddedLangs: ['eng', 'jpn'] })
      addFile({ path: '/n/s1e2.mkv', workId: 'tmdb:73', season: 1, episode: 2 })
      const [item] = buildMediaLibrary(db)
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(0)
    })

    it('🔴 电影同样分列：内嵌轨的电影是「已配 0 · 自带 1」', () => {
      addWork('tmdb:74', { title: 'Embedded Movie', mediaType: 'movie' })
      addFile({ path: '/m/em.mkv', workId: 'tmdb:74', season: null, episode: null,
        subStatus: null, embeddedLangs: ['cht'] })
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(1)
    })

    it('🔴 unplaced 文件的内嵌轨也不进 embedded（它不是"一集"，同 subtitled 的既有口径）', () => {
      addWork('tmdb:75', { title: 'Unplaced Embedded' })
      addFile({ path: '/u/s1e1.mkv', workId: 'tmdb:75', season: 1, episode: 1 })
      addFile({ path: '/u/PV.mkv', workId: 'tmdb:75', season: null, episode: null,
        subStatus: null, embeddedLangs: ['chi'] })
      const [item] = buildMediaLibrary(db)
      expect(item.onDiskEpisodeCount).toBe(1)
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(0)
      expect(item.unplacedFileCount).toBe(1)
    })

    // ────────────────────────────────────────────────────────────────────────
    // 🔴🔴 跨页一致性：这条是本次修复的**核心不变量**，也是用户选③的唯一理由
    // ────────────────────────────────────────────────────────────────────────
    it('🔴🔴 列表页 subtitledEpisodeCount === 详情页 subtitledFileCount>0 的格数', () => {
      // 不断言各自的常量，而是把两页的数放在一起比 —— 这是"两处漂移"唯一照得出来的形态
      // （同 onDisk/unplaced 那条跨页用例的写法）。
      //
      // 判据为什么是 `subtitledFileCount > 0`：那是详情页**唯一**表达"这一格磁盘上真有
      // 一份中文字幕文件"的字段（aggregateDot 里 green 的定义就是它 > 0）。
      // 旧实现的 `dot !== 'none'` 会把只有内嵌轨的格也算进来 → 这条等式当场破。
      addWork('tmdb:80', { title: 'Cross Page Subtitled' })
      addCanonical('tmdb:80', 1, [1, 2, 3, 4, 5])
      // 1 格外挂、1 格外挂+内嵌、2 格只有内嵌、1 格什么都没有、另有 1 格 TMDB 没有的第 6 集。
      addFile({ path: '/x/s1e1.mkv', workId: 'tmdb:80', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/x/s1e2.mkv', workId: 'tmdb:80', season: 1, episode: 2,
        subStatus: 'covered', embeddedLangs: ['chi'] })
      addFile({ path: '/x/s1e3.mkv', workId: 'tmdb:80', season: 1, episode: 3,
        subStatus: null, embeddedLangs: ['chi'] })
      addFile({ path: '/x/s1e4.mkv', workId: 'tmdb:80', season: 1, episode: 4,
        subStatus: null, embeddedLangs: ['cht'] })
      addFile({ path: '/x/s1e5.mkv', workId: 'tmdb:80', season: 1, episode: 5 })
      addFile({ path: '/x/s1e6.mkv', workId: 'tmdb:80', season: 1, episode: 6,
        subStatus: null, embeddedLangs: ['zh'] })

      const [item] = buildMediaLibrary(db)
      const cells = buildMediaLibraryDetail(db, 'tmdb:80')!.seasons.flatMap((s) => s.episodes)

      expect(item.subtitledEpisodeCount).toBe(cells.filter((e) => e.subtitledFileCount > 0).length)
      // 「自带」那一半同样要跨页对得上：详情页里"没有 sidecar 但 dot 是蓝"的格。
      expect(item.embeddedEpisodeCount)
        .toBe(cells.filter((e) => e.subtitledFileCount === 0 && e.dot === 'blue').length)

      // 阳性对照：这两个数不是恰好都为 0，也不是恰好相等（否则 `dot !== 'none'` 的旧实现
      // 或任何一个恒返回 0 的实现都会全绿）。
      expect(item.subtitledEpisodeCount).toBe(2)
      expect(item.embeddedEpisodeCount).toBe(3)
    })

    it('🔴🔴 电影分支的跨页一致性（电影走 movie 那一格，不走 seasons）', () => {
      addWork('tmdb:81', { title: 'Cross Page Movie', mediaType: 'movie' })
      addFile({ path: '/m/a.mkv', workId: 'tmdb:81', season: null, episode: null,
        subStatus: null, embeddedLangs: ['chi'] })
      const [item] = buildMediaLibrary(db)
      const movie = buildMediaLibraryDetail(db, 'tmdb:81')!.movie!
      expect(item.subtitledEpisodeCount).toBe(movie.subtitledFileCount > 0 ? 1 : 0)
      expect(item.embeddedEpisodeCount)
        .toBe(movie.subtitledFileCount === 0 && movie.dot === 'blue' ? 1 : 0)
      // 阳性对照。
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(1)
    })

    it('🔴🔴 《翘楚》生产形态：24 集全内嵌 → 「已配 0 · 自带 24」，详情页 0 格有 sidecar', () => {
      // 生产真实数据的复刻（tmdb:289271，实测外挂 0 份）。旧实现在这里报「已配 24」。
      addWork('tmdb:82', { title: 'Qiao Chu Full' })
      addCanonical('tmdb:82', 1, Array.from({ length: 24 }, (_, i) => i + 1))
      for (let ep = 1; ep <= 24; ep++) {
        addFile({ path: `/qc/s1e${ep}.mkv`, workId: 'tmdb:82', season: 1, episode: ep,
          subStatus: null, embeddedLangs: ['chi'], needsSubtitle: 0, skipReason: 'origin-skip' })
      }
      const [item] = buildMediaLibrary(db)
      const cells = buildMediaLibraryDetail(db, 'tmdb:82')!.seasons.flatMap((s) => s.episodes)
      expect(item.subtitledEpisodeCount).toBe(0)
      expect(item.embeddedEpisodeCount).toBe(24)
      expect(cells.filter((e) => e.subtitledFileCount > 0)).toHaveLength(0)
      expect(item.subtitledEpisodeCount).toBe(cells.filter((e) => e.subtitledFileCount > 0).length)
    })
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

    it("🔴 skip_reason='extra' → 'extra'（▭ 机械特典，2026-08-13 用户裁决）", () => {
      // 特典不进 unplacedFileCount，但**必须在格子层面可见**——两件事合起来才是
      // "减少心智负担而不隐瞒事实"：概览数字里不出现（用户无事可做），
      // 具体格子上如实标注（用户想查时查得到）。少了这一条就成了静默吞掉。
      expect(stateOf({ needsSubtitle: 0, skipReason: 'extra' })).toBe('extra')
    })

    it("🔴 第 8 态：needs_subtitle IS NULL → 'unjudged'（judge 还没轮到它）", () => {
      // 这一态是本 task 的存在理由之一：新扫进来的文件、以及被 D17 回填/指纹重置清空判决的行
      // 都会在这里停留一轮。塌缩进 pending 就是把"系统还没结论"说成"系统认为需要找字幕"（病 B）。
      expect(stateOf({ subStatus: null, needsSubtitle: null })).toBe('unjudged')
    })

    it("🔴 needs IS NULL 但 embedded_langs 已有中文轨 → embedded（与列表页蓝点同一份证据）", () => {
      // 猎人克莱文形态：probe 写了 chi，judge 还没把 skip_reason 落库。
      // 列表页 aggregateDot 已经据此画蓝点；详情若仍报 unjudged，同一部片子两个控件互相反驳。
      // 这里读的就是 fileHasEmbeddedChinese 那一份，不是第二套语言表。
      expect(stateOf({ subStatus: null, needsSubtitle: null, embeddedLangs: ['chi'] }))
        .toBe('embedded')
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

    it("🔴 skip_reason 的值直通 state：judge 说 'origin-skip'，界面就得是 ◇（不许自己按 embedded_langs 重算）", () => {
      // ⚠️ 这条用例原名「origin-skip 先于 embedded」并声称钉住了一条优先级——**审计 A-2 证伪**：
      // skip_reason 是单值列，两个守卫互斥，调换 if 顺序是空操作（实测 0 红）。
      // 它真正钉的是**映射**：judge 写进库的 reason 值，必须原样映射成对应的 state。
      // 把返回值互换（reason='origin-skip' 却返回 'embedded'）才会红——这才是真判据。
      //
      // 这里刻意给一个同时带 chi 内嵌轨的国产片：episodeState 必须听 skip_reason 的（◇），
      // **不许**自己去看 embedded_langs 改判成 ◆。理由见实现注释里那段"未声明的规格偏离"——
      // 语言判据只能有一份，且那一份在 judge 手里（R-F15 换语言时它会重算）。
      expect(stateOf({ needsSubtitle: 0, skipReason: 'origin-skip', embeddedLangs: ['chi'] }))
        .toBe('origin-skip')
    })

    it("🔴 反向对照：同样带 chi 轨，reason='embedded' 才给 ◆（证明上一条钉的是映射不是顺序）", () => {
      expect(stateOf({ needsSubtitle: 0, skipReason: 'embedded', embeddedLangs: ['chi'] }))
        .toBe('embedded')
    })

    it("🔴 reason 缺席时不许拿 embedded_langs 猜：有 chi 轨但 reason=NULL → unjudged（'还没判'）", () => {
      // 审计 A-3 记录的已知偏差就长在这里：此格 dot='blue'（有 chi 轨）而 state='unjudged'。
      // 两个控件口径不同是**有意的**——dot 描述磁盘事实，state 描述 judge 的判决。
      // 判决没下就说"还没判"，比拿磁盘事实替 judge 下结论诚实（换目标语言后后者会翻车）。
      expect(stateOf({ needsSubtitle: 0, skipReason: null, embeddedLangs: ['chi'] }))
        .toBe('unjudged')
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

    it('🔴 R-F2 违反（审计 A-4）：一份 unsolvable + 一份 embedded → 必须是 embedded，不是 unsolvable', () => {
      // ── 这条用例的来历 ────────────────────────────────────────────────────────
      // 审计实测：STATE_RANK 把 unsolvable（**流程失败态**）排在 embedded / origin-skip
      // （两个**不需要字幕的终态**）之前，于是一份文件配不到字幕，就把另一份"压根不需要
      // 字幕"的事实盖掉了。同一格上两个控件会互相打脸：
      //   圆点说 blue（有中文内嵌轨，不需处理）／集号染色说 ⊘（判定无解）
      // 这正是 R-F2「任一份有字幕就算已获取」要防的形态，只是换了个控件。
      // aggregateDot 用 .some() 遵守了 R-F2，aggregateState 必须与它同向。
      addWork('tmdb:804', { title: 'RankConflict' })
      addCanonical('tmdb:804', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:804', season: 1, episode: 1, subStatus: 'unsolvable' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:804', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'embedded', embeddedLangs: ['chi'] })
      const ep = buildMediaLibraryDetail(db, 'tmdb:804')!.seasons[0].episodes[0]
      expect(ep.episodeState).toBe('embedded')
      // 两个控件必须同向——这条断言才是本用例的真正目的
      expect(ep.dot).toBe('blue')
    })

    it('🔴 R-F2 违反（审计 A-4）：一份 unsolvable + 一份 origin-skip → 必须是 origin-skip', () => {
      addWork('tmdb:805', { title: 'RankConflict2' })
      addCanonical('tmdb:805', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:805', season: 1, episode: 1, subStatus: 'unsolvable' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:805', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'origin-skip' })
      expect(buildMediaLibraryDetail(db, 'tmdb:805')!.seasons[0].episodes[0].episodeState).toBe('origin-skip')
    })

    it('🔴 translating 同理不许盖掉"不需要字幕"：一份 handoff_translate + 一份 origin-skip → origin-skip', () => {
      addWork('tmdb:806', { title: 'RankConflict3' })
      addCanonical('tmdb:806', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:806', season: 1, episode: 1, subStatus: 'handoff_translate' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:806', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'origin-skip' })
      expect(buildMediaLibraryDetail(db, 'tmdb:806')!.seasons[0].episodes[0].episodeState).toBe('origin-skip')
    })

    it('🔴 但 covered 仍然最优先：一份 covered + 一份 origin-skip → covered（与 .some() 同向）', () => {
      addWork('tmdb:807', { title: 'RankCovered' })
      addCanonical('tmdb:807', 1, [1])
      addFile({ path: '/a/s1e1.mkv', workId: 'tmdb:807', season: 1, episode: 1, subStatus: 'covered' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:807', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'origin-skip' })
      expect(buildMediaLibraryDetail(db, 'tmdb:807')!.seasons[0].episodes[0].episodeState).toBe('covered')
    })

    // ── extra 的聚合位置（审计抓到的 R-F2 同型复发，与上面 A-4 两条同形）─────────────
    // 病灶：extra 原先排在 STATE_RANK 第 4 档（已解决段）。A-4 被盖掉的是"已解决"的事实，
    // 这里被盖掉的是**未解决**的事实——更糟：用户永远不会去点开那一格。
    it('🔴 R-F2 违反：一份 extra + 一份 pending 正片 → 必须是 pending，不是 extra', () => {
      // 审计用真代码造的数据：同一格里一份是特典、另一份是真需要字幕的正片。
      // 报 extra = 界面说「特典 · 不找字幕」，而那份正在排队的正片被完全盖掉。
      // `extra` 只说明**那一份**不算数，推不出**这一格**不用管——这是它与 embedded /
      // origin-skip 的根本区别（那两个是关于这一格的事实）。
      addWork('tmdb:808', { title: 'ExtraMasksPending' })
      addCanonical('tmdb:808', 1, [1])
      addFile({ path: '/a/s1e1.PV.mkv', workId: 'tmdb:808', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'extra' })
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:808', season: 1, episode: 1, needsSubtitle: 1 })
      const ep = buildMediaLibraryDetail(db, 'tmdb:808')!.seasons[0].episodes[0]
      expect(ep.episodeState).toBe('pending')
      // 两份文件的事实都要如实呈报，不许被聚合吞掉（同 aggregateDot 的既有口径）
      expect(ep.fileCount).toBe(2)
    })

    it('🔴 入库顺序调换后结论不变（防"取首行"：extra 在前 vs 正片在前）', () => {
      addWork('tmdb:809', { title: 'ExtraMasksPendingRev' })
      addCanonical('tmdb:809', 1, [1])
      addFile({ path: '/b/s1e1.mkv', workId: 'tmdb:809', season: 1, episode: 1, needsSubtitle: 1 })
      addFile({ path: '/a/s1e1.PV.mkv', workId: 'tmdb:809', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'extra' })
      expect(buildMediaLibraryDetail(db, 'tmdb:809')!.seasons[0].episodes[0].episodeState).toBe('pending')
    })

    it('🔴 电影分支：一个 Trailer 不许让正片从界面上消失', () => {
      // 电影格尤其危险——aggregateDot 把一部电影的**全部**文件聚成一格，
      // 没有集号维度可以分开，一个 Trailer.mkv 就能盖掉正片。
      addWork('tmdb:810', { title: 'A Movie With Trailer', mediaType: 'movie' })
      addFile({ path: '/m/[Trailer].mkv', workId: 'tmdb:810', needsSubtitle: 0, skipReason: 'extra' })
      addFile({ path: '/m/movie.mkv', workId: 'tmdb:810', needsSubtitle: 1 })
      const m = buildMediaLibraryDetail(db, 'tmdb:810')!.movie!
      expect(m.episodeState).toBe('pending')
      expect(m.fileCount).toBe(2)
    })

    it('🔴 反向对照：**全部**文件都是 extra 时才报 extra（这才是 extra 成立的唯一条件）', () => {
      // 这一条与上面三条成对。只锁"不许盖住正片"而不锁这一条的话，把 extra 从 STATE_RANK
      // 里整个删掉（→ indexOf 给 -1 → 无条件赢）也能让上面三条继续绿——那是另一个方向的坏。
      addWork('tmdb:811', { title: 'AllExtras', mediaType: 'movie' })
      addFile({ path: '/m/[PV].mkv', workId: 'tmdb:811', needsSubtitle: 0, skipReason: 'extra' })
      addFile({ path: '/m/[NCOP].mkv', workId: 'tmdb:811', needsSubtitle: 0, skipReason: 'extra' })
      expect(buildMediaLibraryDetail(db, 'tmdb:811')!.movie!.episodeState).toBe('extra')
    })

    it('🔴 extra 也不许盖住其余每一个未解决态（逐态遍历，不是只测 pending）', () => {
      // 只测 pending 的话，把 extra 挪到 translating/unsolvable/unjudged 之前仍然全绿。
      // 逐态钉死"extra 必须垫底"这条完整判据。
      const cases: Array<[string, { subStatus?: string | null; needsSubtitle?: number | null }, string]> = [
        ['translating', { subStatus: 'handoff_translate' }, 'translating'],
        ['unsolvable', { subStatus: 'unsolvable' }, 'unsolvable'],
        ['pending', { needsSubtitle: 1 }, 'pending'],
        ['unjudged', { needsSubtitle: null }, 'unjudged'],
      ]
      const got: string[] = []
      for (const [tag, props, _want] of cases) {
        const id = `tmdb:82-${tag}`
        addWork(id, { title: tag, mediaType: 'movie' })
        addFile({ path: `/m/${tag}/[PV].mkv`, workId: id, needsSubtitle: 0, skipReason: 'extra' })
        addFile({ path: `/m/${tag}/main.mkv`, workId: id, ...props })
        got.push(buildMediaLibraryDetail(db, id)!.movie!.episodeState)
      }
      expect(got).toEqual(cases.map(([, , want]) => want))
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

    it('🔴 电影那一格带出磁盘文件名；needs NULL + chi → embedded（猎人克莱文形态）', () => {
      addWork('tmdb:539972', { title: 'Kraven the Hunter', mediaType: 'movie' })
      addFile({
        path: '/m/Kraven the Hunter (2024).mkv', workId: 'tmdb:539972',
        season: null, episode: null, subStatus: null, needsSubtitle: null,
        embeddedLangs: ['chi'], filename: 'Kraven the Hunter (2024).mkv',
      })
      const m = buildMediaLibraryDetail(db, 'tmdb:539972')!.movie!
      expect(m.filename).toBe('Kraven the Hunter (2024).mkv')
      expect(m.episodeState).toBe('embedded')
      expect(m.dot).toBe('blue')
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

    it('🔴 零文件的电影（审计 A-6）：详情端点没有 INNER JOIN，空壳 works 打得进来 → absent 而非 unjudged', () => {
      // DTO 注释原先断言「电影那一格恒有文件，故不会是 absent」——那个推理只对**列表页**成立
      // （buildMediaLibrary 用 INNER JOIN files 滤掉了空壳）。详情页是 FROM works WHERE id=?，
      // 直接按 workId 打就能拿到零文件的 movie。此时 aggregateState([]) 会走兜底返回 unjudged，
      // 把"磁盘上什么都没有"报成"系统还没判它"——那是把 absent 说成 unjudged，病 B 的形态。
      addWork('tmdb:900', { title: 'GhostMovie', mediaType: 'movie' })
      const d = buildMediaLibraryDetail(db, 'tmdb:900')!
      expect(d.movie).not.toBeNull()
      expect(d.movie!.fileCount).toBe(0)
      expect(d.movie!.episodeState).toBe('absent')
      expect(d.movie!.dot).toBe('none')
      expect(d.movie!.filename).toBeNull()
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
