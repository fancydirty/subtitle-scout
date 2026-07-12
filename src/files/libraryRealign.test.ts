import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAbsoluteEpisodeNumber, scanVideoFiles } from './libraryRealign.js'
import { buildAbsoluteMap, buildTargetShowDir, buildTargetSeasonDir, buildTargetFilename } from './libraryRealign.js'
import { buildRealignPlan } from './libraryRealign.js'
import type { ScannedVideoFile } from './libraryRealign.js'
import { crossCheckAnimeLists, checkRuntimeTolerance } from './libraryRealign.js'
import type { AnimeListsEntry } from '../adapters/providers/animeLists.js'
import type { SeasonTableEntry } from '../adapters/providers/tmdb.js'

describe('parseAbsoluteEpisodeNumber', () => {
  it('CJK "第N话"', () => {
    expect(parseAbsoluteEpisodeNumber('间谍过家家 第26话.mkv')).toEqual({ absoluteEpisode: 26, matchedToken: '第26话' })
  })
  it('CJK "第N集"（简体）', () => {
    expect(parseAbsoluteEpisodeNumber('Show 第5集 1080p.mkv')).toEqual({ absoluteEpisode: 5, matchedToken: '第5集' })
  })
  it('方括号 [26]', () => {
    expect(parseAbsoluteEpisodeNumber('[SubGroup] Spy x Family [26][1080p].mkv')).toEqual({ absoluteEpisode: 26, matchedToken: '[26]' })
  })
  it('裸 E26', () => {
    expect(parseAbsoluteEpisodeNumber('Spy.x.Family.E26.1080p.mkv')).toEqual({ absoluteEpisode: 26, matchedToken: 'E26' })
  })
  it('已含 SxxExx 的文件不是绝对编号平铺——返回 null（不猜、不当绝对号处理）', () => {
    expect(parseAbsoluteEpisodeNumber('Show S02E05.mkv')).toBeNull()
  })
  it('合集文件（E01-02 范围记法）解不出单一集号——返回 null（隔离区，不猜）', () => {
    expect(parseAbsoluteEpisodeNumber('Show - 01-02.mkv')).toBeNull()
  })
  it('E 前缀范围合集（E01-E02）→ null，不得误取首集 E01', () => {
    expect(parseAbsoluteEpisodeNumber('Show E01-E02 1080p.mkv')).toBeNull()
  })
  it('E 前缀范围合集（E01-02 混合写法）→ null', () => {
    expect(parseAbsoluteEpisodeNumber('Show E01-02.mkv')).toBeNull()
  })
  it('"E05 - 1080p"（集号后跟画质标记）不是范围合集——正常解析出 E05', () => {
    expect(parseAbsoluteEpisodeNumber('Show E05 - 1080p.mkv')).toEqual({ absoluteEpisode: 5, matchedToken: 'E05' })
  })
  it('无任何可识别集号标记——返回 null', () => {
    expect(parseAbsoluteEpisodeNumber('random_file.mkv')).toBeNull()
  })
  it('季码+CJK 混合名——SxxEyy 守卫先于一切提取模式，拒绝解析（否则 S02E01 被当 abs 1 错误改名）', () => {
    expect(parseAbsoluteEpisodeNumber('Show S02E01 第1话.mkv')).toBeNull()
  })
  it('季码+方括号混合名——同样先被 SxxEyy 守卫拦下', () => {
    expect(parseAbsoluteEpisodeNumber('[Group] Show S02E01 [01][1080p].mkv')).toBeNull()
  })
})

describe('scanVideoFiles', () => {
  it('只挑视频扩展名，逐个跑 parseAbsoluteEpisodeNumber', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realign-scan-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Show - 01.mkv'), '')
    writeFileSync(join(dir, 'Show - 02.mp4'), '')
    writeFileSync(join(dir, 'Show.nfo'), '') // 非视频，跳过
    writeFileSync(join(dir, 'poster.jpg'), '') // 非视频，跳过
    const files = scanVideoFiles(dir)
    expect(files.map(f => f.filename).sort()).toEqual(['Show - 01.mkv', 'Show - 02.mp4'])
    // "Show - 01.mkv" 没有字母 E，也没有 CJK/方括号标记——三种确定性模式都不命中，纯数字裸词
    // 歧义太大不收（spec 只列 CJK/bracket/E码三种），match 应为 null。
    expect(files.find(f => f.filename === 'Show - 01.mkv')!.match).toBeNull()
  })
})

describe('buildAbsoluteMap', () => {
  it('间谍过家家验收案例：25+12+3=40，累计偏移正确', () => {
    const table: SeasonTableEntry[] = [
      { seasonNumber: 1, episodeCount: 25, airDate: null },
      { seasonNumber: 2, episodeCount: 12, airDate: null },
      { seasonNumber: 3, episodeCount: 3, airDate: null },
    ]
    const map = buildAbsoluteMap(table)
    expect(map.get(1)).toEqual({ season: 1, episode: 1 })
    expect(map.get(25)).toEqual({ season: 1, episode: 25 })
    expect(map.get(26)).toEqual({ season: 2, episode: 1 })
    expect(map.get(37)).toEqual({ season: 2, episode: 12 })
    expect(map.get(38)).toEqual({ season: 3, episode: 1 })
    expect(map.get(40)).toEqual({ season: 3, episode: 3 })
    expect(map.get(41)).toBeUndefined()
  })
  it('季表乱序输入仍按季号排序累计', () => {
    const table: SeasonTableEntry[] = [
      { seasonNumber: 2, episodeCount: 2, airDate: null },
      { seasonNumber: 1, episodeCount: 3, airDate: null },
    ]
    const map = buildAbsoluteMap(table)
    expect(map.get(4)).toEqual({ season: 2, episode: 1 })
  })
  it('入参含 season<=0（特别篇本不该到这里）→ throw（不变量检查）', () => {
    const table: SeasonTableEntry[] = [
      { seasonNumber: 0, episodeCount: 5, airDate: null },
      { seasonNumber: 1, episodeCount: 3, airDate: null },
    ]
    expect(() => buildAbsoluteMap(table)).toThrow()
  })
  it('季号不连续（缺季 → 累计映射会整体错位）→ throw', () => {
    const table: SeasonTableEntry[] = [
      { seasonNumber: 1, episodeCount: 3, airDate: null },
      { seasonNumber: 3, episodeCount: 2, airDate: null }, // 缺 season 2
    ]
    expect(() => buildAbsoluteMap(table)).toThrow()
  })
  it('空季表 → throw（无从累计）', () => {
    expect(() => buildAbsoluteMap([])).toThrow()
  })
})

describe('目标命名（Jellyfin {jellyfin} 绑定）', () => {
  it('buildTargetShowDir', () => {
    expect(buildTargetShowDir('间谍过家家', 2022, '120089')).toBe('间谍过家家 (2022) [tmdbid-120089]')
  })
  it('buildTargetSeasonDir 零填充', () => {
    expect(buildTargetSeasonDir(2)).toBe('Season 02')
  })
  it('buildTargetFilename 保留原画质/组名标记、原绝对集号入名', () => {
    const name = buildTargetFilename('间谍过家家', 2022, 2, 1, 26, '[SubGroup] Spy x Family [26][1080p][CRC1234].mkv', '[26]')
    expect(name).toBe('间谍过家家 (2022) S02E01 - 026 - [[SubGroup] Spy x Family [1080p][CRC1234]].mkv')
  })
})

const seasonTable: SeasonTableEntry[] = [
  { seasonNumber: 1, episodeCount: 25, airDate: null },
  { seasonNumber: 2, episodeCount: 12, airDate: null },
  { seasonNumber: 3, episodeCount: 3, airDate: null },
]
const cfg = { seriesTitle: '间谍过家家', year: 2022, tmdbId: '120089', seasonTable }

function mkFiles(count: number): ScannedVideoFile[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    return { path: `/media/Show/Season 01/Show - ${n}.mkv`, filename: `Show - E${n}.mkv`, match: { absoluteEpisode: n, matchedToken: `E${n}` } }
  })
}

describe('buildRealignPlan', () => {
  it('40 集绝对编号平铺 → 全部映射成功，S1×25/S2×12/S3×3', () => {
    const result = buildRealignPlan(mkFiles(40), cfg)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toHaveLength(40)
    expect(result.items.filter(i => i.targetSeason === 1)).toHaveLength(25)
    expect(result.items.filter(i => i.targetSeason === 2)).toHaveLength(12)
    expect(result.items.filter(i => i.targetSeason === 3)).toHaveLength(3)
    expect(result.quarantined).toHaveLength(0)
  })

  it('解不出集号的文件进隔离区，不阻塞其余文件的整理（覆盖率仍达标）', () => {
    const files = [...mkFiles(9), { path: '/media/Show/Season 01/合集.mkv', filename: '合集 01-02.mkv', match: null }]
    const result = buildRealignPlan(files, { ...cfg, seasonTable: [{ seasonNumber: 1, episodeCount: 25, airDate: null }] })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.items).toHaveLength(9) // 9/10 = 90% ≥ 80% 覆盖率闸门
    expect(result.quarantined.map(f => f.filename)).toEqual(['合集 01-02.mkv'])
  })

  it('可解析文件覆盖率 < 80% → 整剧拒绝（防半迁移库）', () => {
    // 3 可解析 + 2 隔离 = 3/5 = 60% < 80%
    const files = [
      ...mkFiles(3),
      { path: '/a.mkv', filename: 'a 合集 01-02.mkv', match: null },
      { path: '/b.mkv', filename: 'random.mkv', match: null },
    ]
    const result = buildRealignPlan(files, { ...cfg, seasonTable: [{ seasonNumber: 1, episodeCount: 25, airDate: null }] })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('覆盖率') || f.includes('可解析'))).toBe(true)
  })

  it('单可解析文件的连续性空洞（大量文件里只有 1 个能解析）→ 覆盖率闸门拒绝', () => {
    const files: ScannedVideoFile[] = [
      { path: '/a.mkv', filename: 'a-E5.mkv', match: { absoluteEpisode: 5, matchedToken: 'E5' } },
      { path: '/b.mkv', filename: 'b.mkv', match: null },
      { path: '/c.mkv', filename: 'c.mkv', match: null },
      { path: '/d.mkv', filename: 'd.mkv', match: null },
    ]
    const result = buildRealignPlan(files, { ...cfg, seasonTable: [{ seasonNumber: 1, episodeCount: 25, airDate: null }] })
    expect(result.ok).toBe(false)
  })

  it('恰好 80% 覆盖率 → 通过（阈值边界，>= 而非 >）', () => {
    // 8 可解析 + 2 隔离 = 8/10 = 80%
    const files = [
      ...mkFiles(8),
      { path: '/a.mkv', filename: 'a.mkv', match: null },
      { path: '/b.mkv', filename: 'b.mkv', match: null },
    ]
    const result = buildRealignPlan(files, { ...cfg, seasonTable: [{ seasonNumber: 1, episodeCount: 25, airDate: null }] })
    expect(result.ok).toBe(true)
  })

  it('绝对集号超出 TMDB 累计上限 → 整剧放弃', () => {
    const result = buildRealignPlan(mkFiles(41), cfg) // 41 > 40 累计总数
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('超出'))).toBe(true)
  })

  it('映射目标重复（同一 SxxEyy 被两个文件抢占）→ 整剧放弃', () => {
    const files: ScannedVideoFile[] = [
      { path: '/a.mkv', filename: 'a-E1.mkv', match: { absoluteEpisode: 1, matchedToken: 'E1' } },
      { path: '/b.mkv', filename: 'b-第1话.mkv', match: { absoluteEpisode: 1, matchedToken: '第1话' } },
    ]
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('映射目标重复'))).toBe(true)
  })

  it('绝对集号不连续（疑似缺集）→ 整剧放弃', () => {
    const files: ScannedVideoFile[] = [
      { path: '/a.mkv', filename: 'a-E1.mkv', match: { absoluteEpisode: 1, matchedToken: 'E1' } },
      { path: '/b.mkv', filename: 'b-E5.mkv', match: { absoluteEpisode: 5, matchedToken: 'E5' } },
    ]
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('不连续'))).toBe(true)
  })

  it('全部文件都解不出集号 → 整剧放弃', () => {
    const files: ScannedVideoFile[] = [{ path: '/a.mkv', filename: 'random.mkv', match: null }]
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
  })

  it('整目录 SxxEyy+第N话 混合命名 → 零可解析 → 计划失败（而非四闸门全绿地把 S2 错误改名成 S1）', () => {
    const files: ScannedVideoFile[] = [1, 2, 3].map(n => {
      const name = `Show S02E0${n} 第${n}话.mkv`
      return { path: `/media/Show/${name}`, filename: name, match: parseAbsoluteEpisodeNumber(name) }
    })
    const result = buildRealignPlan(files, cfg)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.failures.some(f => f.includes('没有任何文件能解析出绝对集号'))).toBe(true)
  })
})

describe('crossCheckAnimeLists（真实 Fribb 语义：episode_offset = 季内 cour 偏移）', () => {
  // 真实 TMDB 季表形状：SPY×FAMILY S1=25（两 cour：12+13）、S2=12
  const crossCheckTable: SeasonTableEntry[] = [
    { seasonNumber: 1, episodeCount: 25, airDate: null },
    { seasonNumber: 2, episodeCount: 12, airDate: null },
  ]
  // 真实 Fribb 条目形状（live anime-list-full.json 实测）：季界条目无 offset 字段，mid-cour 条目才有
  const spyFamilyEntries: AnimeListsEntry[] = [
    { anidbId: 16947, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: null }, // S1 cour 1
    { anidbId: 17061, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: 12 },   // S1 cour 2（Part II）
    { anidbId: 17784, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: null }, // S2
  ]

  it('旗舰验收：SPY×FAMILY 真实条目通过（cour 偏移 12 < S1 集数 25，不再假冲突）', () => {
    expect(crossCheckAnimeLists(crossCheckTable, spyFamilyEntries, 120089)).toEqual({ ok: true })
  })

  it('offset ≥ 该季 TMDB 集数（cour 起点落在季外）→ 两源冲突，放弃整理', () => {
    const entries: AnimeListsEntry[] = [
      { anidbId: 1, tmdbTvId: 120089, tmdbSeason: 2, tmdbEpisodeOffset: 12 }, // S2 只有 12 集
    ]
    const result = crossCheckAnimeLists(crossCheckTable, entries, 120089)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('两源冲突')
  })

  it('anime-lists 引用了 TMDB 季表里不存在的季 → 两源冲突', () => {
    const entries: AnimeListsEntry[] = [
      { anidbId: 1, tmdbTvId: 120089, tmdbSeason: 5, tmdbEpisodeOffset: 3 },
    ]
    const result = crossCheckAnimeLists(crossCheckTable, entries, 120089)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('两源冲突')
  })

  it('S0 特别篇条目跳过，不参与校验', () => {
    const entries: AnimeListsEntry[] = [
      { anidbId: 1, tmdbTvId: 120089, tmdbSeason: 0, tmdbEpisodeOffset: 99 },
    ]
    expect(crossCheckAnimeLists(crossCheckTable, entries, 120089).ok).toBe(true)
  })

  it('无任何可校验条目（无该剧记录 / 全是无 offset 的季界条目）→ 中性通过', () => {
    expect(crossCheckAnimeLists(crossCheckTable, [], 120089).ok).toBe(true)
    const boundaryOnly: AnimeListsEntry[] = [
      { anidbId: 16947, tmdbTvId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: null },
    ]
    expect(crossCheckAnimeLists(crossCheckTable, boundaryOnly, 120089).ok).toBe(true)
  })

  it('其他剧的条目不参与本剧校验', () => {
    const entries: AnimeListsEntry[] = [
      { anidbId: 1, tmdbTvId: 999, tmdbSeason: 2, tmdbEpisodeOffset: 99 },
    ]
    expect(crossCheckAnimeLists(crossCheckTable, entries, 120089).ok).toBe(true)
  })
})

describe('checkRuntimeTolerance（可选 ffprobe 时长抽查）', () => {
  it('实际时长在 TMDB 单集时长 ±10% 内 → 通过（空 failures）', () => {
    const items = [{ sourcePath: '/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'x' }]
    const failures = checkRuntimeTolerance(items, 24, p => (p === '/a.mkv' ? 24 * 60 * 1.05 : null))
    expect(failures).toEqual([])
  })
  it('偏差超过 10% → 记入 failures', () => {
    const items = [{ sourcePath: '/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'x' }]
    const failures = checkRuntimeTolerance(items, 24, () => 5 * 60) // 5 分钟 vs 期望 24 分钟
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('偏差超过')
  })
  it('ffprobe 拿不到时长（返回 null）→ 该文件跳过，不计入 failures（抽查而非硬闸）', () => {
    const items = [{ sourcePath: '/a.mkv', sourceFilename: 'a.mkv', absoluteEpisode: 1, targetSeason: 1, targetEpisode: 1, targetRelPath: 'x' }]
    expect(checkRuntimeTolerance(items, 24, () => null)).toEqual([])
  })
})
