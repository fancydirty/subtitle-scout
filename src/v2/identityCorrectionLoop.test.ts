// 路 A Phase 1b 端到端闭环验证（2026-07-26）：agent 身份纠错 → identify_overrides 认领 →
// 下一轮 ingest 用**真 recognize**（recognition/index.ts 的真实链路，不是 mock）按新身份
// 建行 → 旧错身份行被清。
//
// 为什么单独一个文件：这条链路横跨三层（agent runner 写认领 / recognition 消歧前查认领 /
// ingest 建行+清旧行），任一层的单测都只能证明自己那一段。真实事故形态是"纠错报告发了，
// 但库里那部错的剧还在，dashboard 上永远躺着一部不存在的剧、还在被派活找字幕"——只有把
// 三层串起来跑才能证明闭环真的闭合。TMDB 是唯一 mock 的东西（网络层），身份判定/认领查询/
// 建行/清行全部走真实代码。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type ScoutDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'
import { makeIngestPass } from './ingest.js'
import { recognize } from '../recognition/index.js'
import type { TmdbClient, TmdbDetails, TmdbSearchHit, SeasonTableEntry } from '../adapters/providers/tmdb.js'

/** 只 mock 网络层：search 按 query 返回预置命中，getDetails/getSeasonTable 返回预置结构。
 *  两个身份——154494 = Lycoris Recoil（机械误判建的错身份），276161 = Teach You a Lesson
 *  （agent 纠正后的真身份），数据取自真 TMDB 实查。 */
function fakeTmdb(): TmdbClient {
  const details: Record<string, TmdbDetails> = {
    '154494': { overview: 'anime', runtimeMinutes: 24, posterPath: null, backdropPath: null, originalTitle: 'リコリス・リコイル', year: 2022, genreIds: [] },
    '276161': { overview: 'korean drama', runtimeMinutes: 70, posterPath: null, backdropPath: null, originalTitle: '참교육', year: 2026, genreIds: [] },
  }
  const seasons: Record<string, SeasonTableEntry[]> = {
    '154494': [{ seasonNumber: 1, episodeCount: 13, airDate: '2022-07-02' }],
    '276161': [{ seasonNumber: 1, episodeCount: 10, airDate: '2026-06-05' }],
  }
  return {
    search: vi.fn(async (_t: 'tv' | 'movie', query: string): Promise<TmdbSearchHit[]> => {
      // 机械层搜到的是错的（模拟真实事故：截断标题搜出风马牛不相及的条目）
      if (/teach|lesson/i.test(query)) return [{ id: 276161, title: 'Teach You a Lesson', originalTitle: '참교육', year: 2026, posterPath: null }]
      return [{ id: 154494, title: 'Lycoris Recoil', originalTitle: 'リコリス・リコイル', year: 2022, posterPath: null }]
    }),
    getDetails: vi.fn(async (_t: 'tv' | 'movie', id: string) => details[id] ?? null),
    getSeasonTable: vi.fn(async (id: string) => seasons[id] ?? null),
    getChineseTitles: vi.fn(async () => []),
    getExternalIds: vi.fn(async () => ({ imdbId: null })),
    getOriginLanguage: vi.fn(async () => null),
    getSeasonEpisodes: vi.fn(async () => []),
    getSeasonEpisodeRuntimes: vi.fn(async () => null),
  } as unknown as TmdbClient
}

let root: string
let db: ScoutDb
let lib: LibraryRepo

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scout-identity-loop-'))
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('身份纠错闭环端到端（agent 认领 → 真 recognize 消歧前查 → ingest 换身份 + 清旧行）', () => {
  it('错身份行 → 写认领 → 下一轮 ingest 按新身份建行且旧错行消失', async () => {
    const showDir = join(root, 'Show', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    const videoPath = join(showDir, 'Teach.You.a.Lesson.S01E01.1080p.mkv')
    writeFileSync(videoPath, 'video')
    const tmdb = fakeTmdb()

    // ---- 前置：库里已有一条机械误判建的错身份行（tmdb:154494 Lycoris Recoil）。
    // 直接预置而不是靠第一轮 ingest 造——生产里的错行来自历史某轮的机械误判（当时的解析
    // 规则/TMDB 搜索结果与现在不同），用当前代码去"重现误判"既脆弱又偏离本测试的靶心：
    // 本测试要证的是"错行存在时，认领能不能把它换掉"，不是"机械层怎么犯的错"。
    lib.upsertSeries({ id: 'tmdb:154494', name: 'Lycoris Recoil' })
    lib.upsertEpisode({
      id: 'tmdb:154494/s1e1', seriesId: 'tmdb:154494', season: 1, episode: 1,
      name: 'E1', path: videoPath, subStatus: 'missing',
    })
    lib.setProbeMemo('tmdb:154494/s1e1', 5000, statSync(videoPath).size, [])
    const wrongId = 'tmdb:154494/s1e1'

    // ---- agent 纠错落地：写一条认领（runner 的 addOverride 等价动作，path_prefix =
    // task.mediaRoot 即季目录）+ 清停车户口（本例无 parked 行，幂等 no-op，保持与生产
    // 动作一致）----
    lib.addOverride(showDir, '276161', true, 1_700_000_001_000)
    lib.clearParkedPath(videoPath)

    // ---- ingest 一轮：真 recognize 会先查认领 → 命中 276161 ----
    // statFile 返回与 memo 不同的 mtime，让 CHEAP PATH 失效强制走完整识别路径（生产里
    // 认领后靠 reconcile-all / 文件变动触发同样的完整路径）。
    const pass = makeIngestPass({
      roots: () => [root],
      lib,
      tmdb,
      recognize: (p: string) => recognize(p, tmdb, { findOverride: (path) => lib.findOverride(path) }),
      probe: async () => [],
      probeDuration: async () => null,
      listVideoFiles: () => [videoPath],
      fileExists: () => true,
      statFile: (p: string) => ({ ...statSync(p), mtimeMs: 9_999_999_999 } as ReturnType<typeof statSync>),
      targetLanguages: () => ['zh'],
      log: () => {},
      now: () => 1_700_000_002_000,
    })

    const result = await pass()
    expect(result.upserted).toBe(1)

    // ---- 闭环断言 ----
    // 新身份行建起来了
    const rows = db.prepare(`SELECT id, series_id FROM episodes`).all() as { id: string; series_id: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('tmdb:276161/s1e1')
    expect(rows[0].series_id).toBe('tmdb:276161')
    // 旧错身份行彻底消失（这是鬼影洞修复的真正意义——否则这里会是 2 行，
    // dashboard 上永远躺着一部不存在的 Lycoris Recoil，还继续被派活找字幕）
    expect(rows.some((r) => r.id === wrongId)).toBe(false)
    const seriesRows = db.prepare(`SELECT id FROM series`).all() as { id: string }[]
    expect(seriesRows.map((s) => s.id)).toEqual(['tmdb:276161'])
  })

  it('认领是保守的：只影响被认领的目录前缀，同名文件在别的目录仍走机械识别', async () => {
    const claimedDir = join(root, 'Claimed', 'Season 01')
    const otherDir = join(root, 'Other', 'Season 01')
    mkdirSync(claimedDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    // 两个目录放**同名**文件：文件名本身让机械层识别成 154494（fakeTmdb 对不含
    // teach/lesson 的查询恒返回 Lycoris Recoil）。只有被认领的那个目录该变成 276161。
    const claimedPath = join(claimedDir, 'Mystery.Show.S01E01.1080p.mkv')
    const otherPath = join(otherDir, 'Mystery.Show.S01E01.1080p.mkv')
    writeFileSync(claimedPath, 'video')
    writeFileSync(otherPath, 'video')
    const tmdb = fakeTmdb()

    lib.addOverride(claimedDir, '276161', true, 1_700_000_000_000)

    const pass = makeIngestPass({
      roots: () => [root],
      lib,
      tmdb,
      recognize: (p: string) => recognize(p, tmdb, { findOverride: (path) => lib.findOverride(path) }),
      probe: async () => [],
      probeDuration: async () => null,
      listVideoFiles: () => [claimedPath, otherPath],
      fileExists: () => true,
      statFile: (p: string) => statSync(p),
      targetLanguages: () => ['zh'],
      log: () => {},
      now: () => 1_700_000_000_000,
    })

    await pass()

    const rows = db.prepare(`SELECT id, path FROM episodes`).all() as { id: string; path: string }[]
    const claimed = rows.find((r) => r.path === claimedPath)
    const other = rows.find((r) => r.path === otherPath)
    // 认领目录：走认领身份
    expect(claimed?.id).toBe('tmdb:276161/s1e1')
    // 未认领目录：走机械识别自己的结论（154494），完全不受那条认领影响
    expect(other?.id).toBe('tmdb:154494/s1e1')
    expect(lib.findOverride(otherPath)).toBeNull()
  })
})
