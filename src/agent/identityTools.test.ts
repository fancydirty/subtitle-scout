import { describe, it, vi, beforeEach, afterEach } from 'vitest'
import { openDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { makeWriteIdentityTool, WriteIdentityInputSchema } from './identityTools.js'
import type { ScoutDb } from '../v2/db.js'

/** 单测里的路径解析桩：worker 生产实现按 basename 在 task.targets 里查真实绝对路径，
 *  单测直接把模型报的 file 当路径回传（等价于"该 target 存在且匹配"）。 */
const identityResolver = (file: string): string | null => file

// 注（与任务书原文的两处最小偏差，均被 repo 现实强制）：
// 1. lib.getSeries/getMovie/getEpisode 未命中返回 null（非 undefined）——ghost 断言用 toBeNull()；
//    与 libraryRepo.test.ts 既有口径一致（`expect(lib.getSeries('nope')).toBeNull()`）。
// 2. 行形状是 snake_case（series.chinese_title / episode.sub_status）——断言按真实列名写。
// 3. tool.execute 在 ai SDK v7 类型上需要第二参 ToolExecutionOptions——传 `{} as any`，
//    同 rescueWorker.tools.test.ts / findSubtitleWorker.tools.test.ts 的既有写法（CI 跑 tsc --noEmit）。
// 4. embeddedLangs 不是工具输入（agent 可幻觉，权威源是 parked_paths.embedded_langs 的
//    ffprobe raw 数据）——测试只通过 upsertParkedPath 的 fingerprint 播种。

describe('write_identified_media', () => {
  let db: ScoutDb
  let lib: LibraryRepo

  beforeEach(() => {
    db = openDb(':memory:')
    lib = new LibraryRepo(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates series and episode rows for TV identification', async ({ expect }) => {
    // Park a path first —— fingerprint 带 ffprobe 探测到的内嵌轨语言
    lib.upsertParkedPath(
      '/media/tv/Show.S01E05.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['eng'] }
    )

    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: '/poster.jpg',
        backdropPath: '/backdrop.jpg',
        overview: 'A great show',
        year: 2020,
        genreIds: [18, 80],
        originalTitle: 'Original Show',
      }),
      getChineseTitles: vi.fn().mockResolvedValue(['中文剧名']),
      getExternalIds: vi.fn().mockResolvedValue({ imdbId: 'tt1234567' }),
      getOriginLanguage: vi.fn().mockResolvedValue('en-US'),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    const result = await tool.execute({
      tmdbId: '12345',
      isTv: true,
      title: 'Show',
      season: 1,
      episode: 5,
      file: '/media/tv/Show.S01E05.mkv',
    }, {} as any)

    expect(result).toContain('tmdb:12345')
    expect(result).toContain('s1e5')

    const series = lib.getSeries('tmdb:12345')
    expect(series).toBeDefined()
    expect(series?.name).toBe('Show')
    expect(series?.year).toBe(2020)
    expect(series?.chinese_title).toBe('中文剧名')

    const episode = lib.getEpisode('tmdb:12345/s1e5')
    expect(episode).toBeDefined()
    expect(episode?.path).toBe('/media/tv/Show.S01E05.mkv')
    expect(episode?.season).toBe(1)
    expect(episode?.episode).toBe(5)
    // embedded_langs 权威源是 parked 行（['eng']）→ embedded
    expect(episode?.sub_status).toBe('embedded')

    // 探针记忆化同样来自 parked 行（mtime/size/langs 三元组）
    const memo = lib.probeMemo('tmdb:12345/s1e5')
    expect(memo).toEqual({ mtime: 500, size: 1024, langs: ['eng'] })

    // Parked path should be cleared
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Show.S01E05.mkv')
    expect(parked).toBeUndefined()

    expect(tmdb.getDetails).toHaveBeenCalledWith('tv', '12345')
  })

  it('creates movie row for movie identification', async ({ expect }) => {
    lib.upsertParkedPath(
      '/media/movies/Film.2021.mkv',
      'awaiting-agent-identification',
      1000,
      // fingerprint.embeddedLangs 省略 = 本次未探测（存 NULL），语义等同任务书原文的 null——
      // ParkedPathFingerprint.embeddedLangs 类型是 string[]（无 null），strict 下 null 不可赋。
      { mtimeMs: 500, size: 2048, durationSec: 7200 }
    )

    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: '/poster.jpg',
        backdropPath: null,
        overview: 'A film',
        year: 2021,
        genreIds: [28],
        originalTitle: 'Original Film',
      }),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue({ imdbId: 'tt7654321' }),
      getOriginLanguage: vi.fn().mockResolvedValue('en-US'),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    const result = await tool.execute({
      tmdbId: '67890',
      isTv: false,
      title: 'Film',
      season: null,
      episode: null,
      file: '/media/movies/Film.2021.mkv',
    }, {} as any)

    expect(result).toContain('tmdb:67890')

    const movie = lib.getMovie('tmdb:67890')
    expect(movie).toBeDefined()
    expect(movie?.name).toBe('Film')
    expect(movie?.path).toBe('/media/movies/Film.2021.mkv')
    expect(movie?.year).toBe(2021)
    // parked 行 embedded_langs 为 NULL（未探测）→ missing
    expect(movie?.sub_status).toBe('missing')
    // 🔴 挂车修复（2026-07-28 生产实证）：此前这里断言"未探测 → 不落探针记忆"——正是缺陷 A。
    // 无 memo 的行下一轮 ingest CHEAP PATH 必然 miss → FULL PATH 无条件 park → agent 重新
    // 识别 → 无限空转（tmdb:154494/s1e1 covered 行与 parked 行同时存在，parked 33→43）。
    // 现在只要 parked 行有 probe_mtime/probe_size 就必须落 memo；langs=null 诚实表达
    // "语言轨未探测"（与 probeMemo 既有语义一致：null=不知道，[]=探过确认零轨）。
    expect(lib.probeMemo('tmdb:67890')).toEqual({ mtime: 500, size: 2048, langs: null })

    const parked = lib.listParkedPaths().find(p => p.path === '/media/movies/Film.2021.mkv')
    expect(parked).toBeUndefined()
  })

  it('parked.embedded_langs is authoritative — subStatus follows DB, not agent claims', async ({ expect }) => {
    // 两条 parked：一条 ffprobe 探到内嵌轨，一条没探到。输入 schema 已无 embeddedLangs
    // 字段——agent 无法自报，sub_status 只能来自 parked 行。
    lib.upsertParkedPath(
      '/media/tv/HasTrack.S01E01.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['chi'] }
    )
    lib.upsertParkedPath(
      '/media/tv/NoTrack.S01E02.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400 } // 未探测 → NULL
    )

    const details = {
      posterPath: null,
      backdropPath: null,
      overview: 'Show',
      year: 2020,
      genreIds: [],
      originalTitle: 'Show',
    }
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue(details),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue(null),
      getOriginLanguage: vi.fn().mockResolvedValue(null),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    await tool.execute({
      tmdbId: '111',
      isTv: true,
      title: 'HasTrack',
      season: 1,
      episode: 1,
      file: '/media/tv/HasTrack.S01E01.mkv',
    }, {} as any)

    await tool.execute({
      tmdbId: '222',
      isTv: true,
      title: 'NoTrack',
      season: 1,
      episode: 2,
      file: '/media/tv/NoTrack.S01E02.mkv',
    }, {} as any)

    expect(lib.getEpisode('tmdb:111/s1e1')?.sub_status).toBe('embedded')
    expect(lib.probeMemo('tmdb:111/s1e1')).toEqual({ mtime: 500, size: 1024, langs: ['chi'] })

    expect(lib.getEpisode('tmdb:222/s1e2')?.sub_status).toBe('missing')
    // 🔴 挂车修复：见上方 movie 测试同款注释——无 embeddedLangs 也必须落 memo（langs=null），
    // 否则下一轮 ingest 把刚识别完的行重新 park，识别→park→识别无限空转。
    expect(lib.probeMemo('tmdb:222/s1e2')).toEqual({ mtime: 500, size: 1024, langs: null })
  })

  // 🔴 挂车修复的正面锁（缺陷 A，2026-07-28 生产实证 tmdb:154494/s1e1）：parked 行带
  // probe_mtime/probe_size 但 embedded_langs 为 NULL（云盘探针失败/未探测——生产大多数文件）
  // 时，写库工具**必须**落探针记忆，且 (mtime,size) 与 parked 指纹逐字一致——下一轮 ingest
  // 对未变文件必须命中 CHEAP PATH，绝不再 park。
  it('parked 行有指纹但无 embedded langs → memo 仍必须落地且命中 parked 指纹（挂车锁）', async ({ expect }) => {
    lib.upsertParkedPath(
      '/media/tv/Churn.S01E01.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 777_000, size: 888_999, durationSec: 1440 } // embeddedLangs 省略 = NULL（未探测）
    )
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: null, backdropPath: null, overview: 'x', year: 2024, genreIds: [], originalTitle: 'Churn',
      }),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue(null),
      getOriginLanguage: vi.fn().mockResolvedValue(null),
    }
    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    await tool.execute({
      tmdbId: '154494', isTv: true, title: 'Churn', season: 1, episode: 1,
      file: '/media/tv/Churn.S01E01.mkv',
    }, {} as any)

    expect(lib.probeMemo('tmdb:154494/s1e1')).toEqual({ mtime: 777_000, size: 888_999, langs: null })
    expect(lib.listParkedPaths().find(p => p.path === '/media/tv/Churn.S01E01.mkv')).toBeUndefined()
  })

  it('unparked path (no DB row) falls back to missing, never embedded', async ({ expect }) => {
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: null,
        backdropPath: null,
        overview: 'Film',
        year: 2021,
        genreIds: [],
        originalTitle: 'Film',
      }),
      getChineseTitles: vi.fn().mockResolvedValue([]),
      getExternalIds: vi.fn().mockResolvedValue(null),
      getOriginLanguage: vi.fn().mockResolvedValue(null),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    await tool.execute({
      tmdbId: '333',
      isTv: false,
      title: 'Film',
      season: null,
      episode: null,
      file: '/media/movies/NeverParked.mkv',
    }, {} as any)

    expect(lib.getMovie('tmdb:333')?.sub_status).toBe('missing')
  })

  // 🔴 identityEval 第七轮修复的第二个同类缺陷：参数原本是绝对 `path`，而 prompt 出于沙盒
  // 纪律只给相对目录段+basename——模型拿不到绝对路径只能编（实测 14 次调用 13 次是
  // `../../../../../..` 拼接幻觉）。现在模型报 file 名、真实路径由 worker 的
  // resolveTargetPath 解析；报了本 run 不存在的文件名必须明确拒绝，不猜"大概是哪个"。
  it('拒绝本 run 里不存在的 file 名（不猜、不建幽灵行）', async ({ expect }) => {
    const tmdb = {
      getDetails: vi.fn(),
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }
    // 解析器只认识真 target；模型报别的名字一律 null
    const tool = makeWriteIdentityTool({
      lib, tmdb,
      resolveTargetPath: (f) => (f === 'Real.mkv' ? '/media/movies/Real.mkv' : null),
    })

    await expect(tool.execute({
      tmdbId: '14161', isTv: false, title: '2012', season: null, episode: null,
      file: '../../../../../../Users/x/幻觉拼接.mkv',
    }, {} as any)).rejects.toThrow(/no target in this task matches file/)

    // 早退在任何网络调用之前——不为必败的写入烧 TMDB 配额
    expect(tmdb.getDetails).not.toHaveBeenCalled()
  })

  it('REFUSES to create rows when tmdbId does not exist (404) - hallucination defense', async ({ expect }) => {
    lib.upsertParkedPath(
      '/media/tv/Fake.Show.S01E01.mkv',
      'awaiting-agent-identification',
      1000,
      { mtimeMs: 500, size: 1024, durationSec: 2400, embeddedLangs: ['eng'] }
    )

    const tmdb = {
      getDetails: vi.fn().mockResolvedValue(null), // 404
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    await expect(tool.execute({
      tmdbId: '99999999',
      isTv: true,
      title: 'Fake Show',
      season: 1,
      episode: 1,
      file: '/media/tv/Fake.Show.S01E01.mkv',
    }, {} as any)).rejects.toThrow(/does not exist/i)

    // Verify no rows created
    expect(lib.getSeries('tmdb:99999999')).toBeNull()

    // Verify parked path still there (not cleared)
    const parked = lib.listParkedPaths().find(p => p.path === '/media/tv/Fake.Show.S01E01.mkv')
    expect(parked).toBeDefined()
  })

  // ---- 行劫持锁（2026-07-28，全库跑前夜）：同一作品的第二份物理文件（NAS + 云盘双持）----
  // upsertMovie/upsertEpisode 是 ON CONFLICT(id) DO UPDATE SET path=excluded.path——识别云盘
  // 副本会静默改写既有行的 path，NAS 文件从台账消失 → 下轮 ingest 认不出 NAS 路径 → park →
  // agent 重识别 → path 又翻回去……两个文件互相劫持同一行，每轮白烧一次 LLM 识别（与 1919f86
  // 修的 re-park 空转同病类）。正确动作三分支：
  //   同 path         → 幂等重识别（既有行为不变）
  //   旧 path 文件已消失 → 晋升：新 path 合法继承行（照常 upsert）
  //   旧 path 文件还在   → 副本：不动行，addItemFile 入册 + 清 park，字幕传播交给
  //                        ingest B3-3（getItemFileByPath 命中 → propagateSubtitleToReplica，
  //                        幂等，下一轮 pass 必然触发——不在写库工具里穿 probeDuration）。

  const dupTmdb = () => ({
    getDetails: vi.fn().mockResolvedValue({
      posterPath: null, backdropPath: null, overview: 'x', year: 2013, genreIds: [], originalTitle: 'The Conjuring',
    }),
    getChineseTitles: vi.fn().mockResolvedValue([]),
    getExternalIds: vi.fn().mockResolvedValue(null),
    getOriginLanguage: vi.fn().mockResolvedValue(null),
  })

  it('🔴 行劫持锁（movie）：既有行的文件还在磁盘 → 不改 path，云盘副本入册 item_files + 清 park', async ({ expect }) => {
    const nasPath = '/media/movies/Conjuring/c.mkv'
    const aliyunPath = '/media/aliyun/Movie/conjuring-copy.mkv'
    const tmdb = dupTmdb()
    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver, fileExists: () => true })

    // 第一次识别：NAS 文件建行
    await tool.execute({
      tmdbId: '138843', isTv: false, title: 'The Conjuring', season: null, episode: null, file: nasPath,
    }, {} as any)
    expect(lib.getMovie('tmdb:138843')?.path).toBe(nasPath)

    // 云盘副本被 park 后送来识别——撞同一个 tmdbId
    lib.upsertParkedPath(aliyunPath, 'awaiting-agent-identification', 2000, { mtimeMs: 9, size: 9 })
    const result = await tool.execute({
      tmdbId: '138843', isTv: false, title: 'The Conjuring', season: null, episode: null, file: aliyunPath,
    }, {} as any)

    // 行的 path 纹丝不动（NAS 主文件不失册）
    expect(lib.getMovie('tmdb:138843')?.path).toBe(nasPath)
    // 云盘 path 以副本身份入册（B3-3 下轮按 getItemFileByPath 命中并触发字幕传播）
    expect(lib.getItemFileByPath(aliyunPath)?.item_id).toBe('tmdb:138843')
    // parked 行已清（这条 path 有归宿了）
    expect(lib.listParkedPaths().find(p => p.path === aliyunPath)).toBeUndefined()
    // 返回信息告诉 agent：这是重复文件，别单独装字幕
    expect(result).toContain('duplicate')
    expect(result).toContain('tmdb:138843')
  })

  it('🔴 行劫持锁（TV episode）：episode 行不被云盘副本改写 path，series 级元数据刷新无妨', async ({ expect }) => {
    const nasPath = '/media/tv/Show/S01E05.mkv'
    const aliyunPath = '/media/aliyun/TV/Show.S01E05.mkv'
    const tmdb = dupTmdb()
    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver, fileExists: () => true })

    await tool.execute({
      tmdbId: '555', isTv: true, title: 'Show', season: 1, episode: 5, file: nasPath,
    }, {} as any)
    expect(lib.getEpisode('tmdb:555/s1e5')?.path).toBe(nasPath)

    lib.upsertParkedPath(aliyunPath, 'awaiting-agent-identification', 2000, { mtimeMs: 9, size: 9 })
    const result = await tool.execute({
      tmdbId: '555', isTv: true, title: 'Show', season: 1, episode: 5, file: aliyunPath,
    }, {} as any)

    expect(lib.getEpisode('tmdb:555/s1e5')?.path).toBe(nasPath)
    expect(lib.getItemFileByPath(aliyunPath)?.item_id).toBe('tmdb:555/s1e5')
    expect(lib.listParkedPaths().find(p => p.path === aliyunPath)).toBeUndefined()
    expect(result).toContain('duplicate')
    expect(result).toContain('tmdb:555/s1e5')
  })

  it('晋升：既有行的旧文件已从磁盘消失 → 新 path 合法继承行，不入 item_files', async ({ expect }) => {
    const oldPath = '/media/movies/Old/gone.mkv'
    const newPath = '/media/aliyun/Movie/renamed.mkv'
    const tmdb = dupTmdb()
    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver, fileExists: () => false })

    await tool.execute({
      tmdbId: '700', isTv: false, title: 'Gone Film', season: null, episode: null, file: oldPath,
    }, {} as any)

    await tool.execute({
      tmdbId: '700', isTv: false, title: 'Gone Film', season: null, episode: null, file: newPath,
    }, {} as any)

    expect(lib.getMovie('tmdb:700')?.path).toBe(newPath) // 晋升，不是劫持
    expect(lib.getItemFileByPath(newPath)).toBeNull() // 不是副本
  })

  it('同 path 重识别 → 幂等，不入 item_files（回归锁）', async ({ expect }) => {
    const path = '/media/movies/Same/same.mkv'
    const tmdb = dupTmdb()
    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver, fileExists: () => true })

    await tool.execute({
      tmdbId: '800', isTv: false, title: 'Same Film', season: null, episode: null, file: path,
    }, {} as any)
    await tool.execute({
      tmdbId: '800', isTv: false, title: 'Same Film', season: null, episode: null, file: path,
    }, {} as any)

    expect(lib.getMovie('tmdb:800')?.path).toBe(path)
    expect(lib.getItemFileByPath(path)).toBeNull()
  })

  it('rejects TV identification without season/episode BEFORE any TMDB call', async ({ expect }) => {
    const tmdb = {
      getDetails: vi.fn().mockResolvedValue({
        posterPath: null,
        backdropPath: null,
        overview: 'Test',
        year: 2020,
        genreIds: [],
        originalTitle: 'Test',
      }),
      getChineseTitles: vi.fn(),
      getExternalIds: vi.fn(),
      getOriginLanguage: vi.fn(),
    }

    const tool = makeWriteIdentityTool({ lib, tmdb, resolveTargetPath: identityResolver })

    await expect(tool.execute({
      tmdbId: '12345',
      isTv: true,
      title: 'Show',
      season: null, // Missing!
      episode: null,
      file: '/media/tv/Show.mkv',
    }, {} as any)).rejects.toThrow(/season.*episode/i)

    // 校验在 getDetails 之前——必败的请求不烧 TMDB 配额
    expect(tmdb.getDetails).not.toHaveBeenCalled()
  })
})

// 🔴 identityEval 六轮血案的回归锁（2026-07-27）：原 schema 用
// z.number().int().nullable() 收 season/episode，真模型六种发法五种被拒 —— agent 想调
// 写库工具却调不进去，把失败写进 finalize 的 reason，而我误判成"agent 不听话"，
// 往 skill 里加了三轮措辞全打在空处。这组测试钉死六种发法都必须收得下。
describe('write_identified_media inputSchema 的真模型编码容错（六轮血案回归锁）', () => {
  const variants: Array<[string, Record<string, unknown>, { season: number | null; episode: number | null }]> = [
    ['JSON null（标准）', { season: null, episode: null }, { season: null, episode: null }],
    ['省略键（真模型对 nullable 最常见的发法）', {}, { season: null, episode: null }],
    ['"None"（Python 风格字符串）', { season: 'None', episode: 'None' }, { season: null, episode: null }],
    ['"null"（JS 风格字符串）', { season: 'null', episode: 'null' }, { season: null, episode: null }],
    ['空字符串', { season: '', episode: '' }, { season: null, episode: null }],
    ['字符串数字（TV case 常见）', { season: '4', episode: '9' }, { season: 4, episode: 9 }],
  ]

  for (const [label, seasonEpisode, expected] of variants) {
    it(`收得下：${label}`, ({ expect }) => {
      // 直接校 schema（不经 tool 包装——ai 包的 FlexibleSchema 类型会遮掉 zod 的 safeParse）
      const parsed = WriteIdentityInputSchema.safeParse({
        tmdbId: '14161', isTv: false, title: '2012', file: '/media/movies/2012.mkv',
        ...seasonEpisode,
      })
      expect(parsed.success, `被拒了：${label}`).toBe(true)
      if (parsed.success) {
        expect((parsed.data as { season: number | null }).season).toBe(expected.season)
        expect((parsed.data as { episode: number | null }).episode).toBe(expected.episode)
      }
    })
  }
})
