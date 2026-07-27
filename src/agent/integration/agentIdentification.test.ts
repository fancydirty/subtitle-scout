import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { openDb } from '../../v2/db.js'
import { LibraryRepo } from '../../v2/libraryRepo.js'
import { makeFindSubtitleWorker } from '../findSubtitleWorker.js'
import type { ScoutDb } from '../../v2/db.js'
import type { FindSubtitleTask } from '../findSubtitleWorker.schemas.js'

// Task 15：agent-first 识别的端到端集成测试——parked 文件带 raw data → agent 经 TMDB 证据
// 工具（search_tmdb/get_tmdb_details）识别 → write_identified_media 落库（series/episode 行 +
// 清 parked 户口）→ finalize 报 identity。
//
// 与任务书原文的几处最小偏差，均被 repo 现实强制：
// 1. mock 模型是 MockLanguageModelV4——doGenerate 返回的是 V4 形状（finishReason/usage/
//    content[{type:'tool-call', input: JSON.stringify(args)}]），不是 { toolCalls:[{args}] }；
//    与 findSubtitleWorker.test.ts 的 toolCallResult/finalizeResult 同法。
// 2. mediaRoot/cacheRoot 不能用 '/media/tv' 与 '/tmp'——worker 每次 run 都会真的
//    allocate() 一个 <mediaRoot>/.subtitle-staging/<jobId> 目录（macOS 非 root 建不了 /media），
//    result-set store 也 mkdirSync(cacheRoot)。用 mkdtempSync 的真临时目录（全仓既有惯例）。
// 3. TMDB mock 形状按 adapters/providers/tmdb.ts 的真实类型：TmdbSearchHit.id 是 number
//    （search_tmdb 工具内部 String(h.id) 归一）、无 mediaType 字段；TmdbDetails 无 seasons
//    字段（季表走独立的 getSeasonTable）；fingerprint.embeddedLangs 类型是 string[]（无
//    null——"未探测"的写法是省略该键，同 identityTools.test.ts 的既有口径）。
// 4. lib.getSeries/getEpisode 未命中返回 null（非 undefined）——ghost 断言用 toBeNull()。

let root: string
let db: ScoutDb
let lib: LibraryRepo

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scout-agent-identification-'))
  db = openDb(':memory:')
  lib = new LibraryRepo(db)
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function toolCallResult(toolCallId: string, toolName: string, input: unknown) {
  return {
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 5, text: undefined, reasoning: undefined },
    },
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) }],
    warnings: [],
  }
}

function finalizeResult(output: unknown) {
  return toolCallResult('finalize-1', 'finalize', output)
}

describe('agent identification integration', () => {
  it('identifies and writes from raw evidence end-to-end', async () => {
    const mediaRoot = join(root, 'media', 'tv')
    mkdirSync(mediaRoot, { recursive: true })
    const videoPath = join(mediaRoot, 'Breaking.Bad.S01E01.mkv')

    // Park a file with raw data（ffprobe raw：时长 + 内嵌轨语言）
    lib.upsertParkedPath(
      videoPath,
      'awaiting-agent-identification',
      1000,
      {
        mtimeMs: 500,
        size: 1024,
        durationSec: 2880,
        embeddedLangs: ['eng'],
      }
    )

    // Mock TMDB client（真实类型形状：search hit 的 id 是 number，details 无 seasons 字段）
    const tmdb = {
      search: vi.fn(async () => [
        { id: 1396, title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008, posterPath: null },
      ]),
      getDetails: vi.fn(async () => ({
        posterPath: '/poster.jpg',
        backdropPath: null,
        overview: 'A chemistry teacher...',
        runtimeMinutes: 49,
        year: 2008,
        genreIds: [18, 80],
        originalTitle: 'Breaking Bad',
      })),
      getChineseTitles: vi.fn(async () => ['绝命毒师']),
      getExternalIds: vi.fn(async () => ({ imdbId: 'tt0903747' })),
      getOriginLanguage: vi.fn(async () => 'en-US'),
      getSeasonTable: vi.fn(async () => [
        { seasonNumber: 1, episodeCount: 7, airDate: null },
      ]),
    }

    // Mock model that follows the identification flow:
    // search_tmdb → get_tmdb_details → write_identified_media → finalize(identified)
    let step = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step++
        if (step === 1) {
          // Step 1: search_tmdb
          return toolCallResult('call-1', 'search_tmdb', { query: 'Breaking Bad', mediaType: 'tv', year: 2008 })
        }
        if (step === 2) {
          // Step 2: get_tmdb_details
          return toolCallResult('call-2', 'get_tmdb_details', { tmdbId: '1396', isTv: true })
        }
        if (step === 3) {
          // Step 3: write_identified_media
          return toolCallResult('call-3', 'write_identified_media', {
            tmdbId: '1396',
            isTv: true,
            title: 'Breaking Bad',
            season: 1,
            episode: 1,
            // 2026-07-27：契约从绝对 path 改为 file 名（prompt 只给相对段+basename，
            // 索要绝对路径必然逼出幻觉）——真实路径由 worker 的 resolveTargetPath 解析。
            file: basename(videoPath),
          })
        }
        // Final: finalize report
        return finalizeResult({
          installed: [],
          no_safe_match: [],
          retry_later: [],
          hardsub_assumed: [],
          identity: {
            outcome: 'identified',
            tmdbId: '1396',
            isTv: true,
            season: 1,
            episode: 1,
            nameEvidence: 'Title matches "Breaking Bad"',
            structureEvidence: 'Season 1 exists in TMDB season table',
          },
        })
      },
    })

    const worker = makeFindSubtitleWorker({
      model,
      adapters: [], // No subtitle search for this test
      cacheRoot: join(root, 'cache'),
      stepCap: 10,
      tmdb: {
        search: tmdb.search,
        getDetails: tmdb.getDetails,
        getSeasonTable: tmdb.getSeasonTable,
      },
      identityDeps: {
        lib,
        tmdb: {
          getDetails: tmdb.getDetails,
          getChineseTitles: tmdb.getChineseTitles,
          getExternalIds: tmdb.getExternalIds,
          getOriginLanguage: tmdb.getOriginLanguage,
        },
      },
    })

    const task: FindSubtitleTask = {
      jobId: 'test-job',
      mediaRoot,
      title: '',
      originalTitle: null,
      year: null,
      alternativeTitles: [],
      overview: null,
      runtimeMinutes: null,
      providerIds: {},
      targetLanguage: 'zh',
      hardsubMode: 'off',
      localCandidates: [],
      targets: [
        {
          itemId: null,
          videoPath,
          videoFilename: 'Breaking.Bad.S01E01.mkv',
          season: 1,
          episode: 1,
          absoluteEpisode: null,
          imdbId: null,
          embeddedTmdbId: null,
          runtimeMinutes: 48,
          dirName: mediaRoot,
          durationSec: 2880,
          embeddedLangs: ['eng'],
        },
      ],
    }

    const report = await worker(task)

    // Verify report
    expect(report.identity?.outcome).toBe('identified')
    if (report.identity?.outcome !== 'identified') throw new Error('unreachable')
    expect(report.identity.tmdbId).toBe('1396')
    expect(report.identity.isTv).toBe(true)
    expect(report.identity.season).toBe(1)
    expect(report.identity.episode).toBe(1)

    // Verify database writes
    const series = lib.getSeries('tmdb:1396')
    expect(series).not.toBeNull()
    expect(series?.name).toBe('Breaking Bad')
    expect(series?.chinese_title).toBe('绝命毒师')

    const episode = lib.getEpisode('tmdb:1396/s1e1')
    expect(episode).not.toBeNull()
    expect(episode?.path).toBe(videoPath)
    // parked 行 embedded_langs=['eng']（ffprobe 权威源）→ embedded
    expect(episode?.sub_status).toBe('embedded')

    // Verify parked path cleared
    const parked = lib.listParkedPaths().find(p => p.path === videoPath)
    expect(parked).toBeUndefined()

    // Verify tools were called in order（search 签名：mediaType, query, year）
    expect(tmdb.search).toHaveBeenCalledWith('tv', 'Breaking Bad', 2008)
    expect(tmdb.getDetails).toHaveBeenCalledWith('tv', '1396')
  })

  it('reports unidentified when no TMDB hits', async () => {
    const mediaRoot = join(root, 'media', 'movies')
    mkdirSync(mediaRoot, { recursive: true })
    const videoPath = join(mediaRoot, 'Unknown.Film.2025.mkv')

    lib.upsertParkedPath(
      videoPath,
      'awaiting-agent-identification',
      1000,
      {
        mtimeMs: 500,
        size: 2048,
        durationSec: 7200,
        // embeddedLangs 省略 = 未探测（ParkedPathFingerprint.embeddedLangs 类型无 null）
      }
    )

    const tmdb = {
      search: vi.fn(async () => []), // No hits
      getDetails: vi.fn(async () => null),
      getChineseTitles: vi.fn(async () => []),
      getExternalIds: vi.fn(async () => ({ imdbId: null })),
      getOriginLanguage: vi.fn(async () => null),
      getSeasonTable: vi.fn(async () => null),
    }

    const model = new MockLanguageModelV4({
      doGenerate: async () => finalizeResult({
        installed: [],
        no_safe_match: [],
        retry_later: [],
        hardsub_assumed: [],
        identity: {
          outcome: 'unidentified',
          reason: 'No TMDB hits for cleaned title',
        },
      }),
    })

    const worker = makeFindSubtitleWorker({
      model,
      adapters: [],
      cacheRoot: join(root, 'cache'),
      stepCap: 10,
      tmdb: {
        search: tmdb.search,
        getDetails: tmdb.getDetails,
        getSeasonTable: tmdb.getSeasonTable,
      },
      identityDeps: {
        lib,
        tmdb: {
          getDetails: tmdb.getDetails,
          getChineseTitles: tmdb.getChineseTitles,
          getExternalIds: tmdb.getExternalIds,
          getOriginLanguage: tmdb.getOriginLanguage,
        },
      },
    })

    const task: FindSubtitleTask = {
      jobId: 'test-job',
      mediaRoot,
      title: '',
      originalTitle: null,
      year: null,
      alternativeTitles: [],
      overview: null,
      runtimeMinutes: null,
      providerIds: {},
      targetLanguage: 'zh',
      hardsubMode: 'off',
      localCandidates: [],
      targets: [
        {
          itemId: null,
          videoPath,
          videoFilename: 'Unknown.Film.2025.mkv',
          season: null,
          episode: null,
          absoluteEpisode: null,
          imdbId: null,
          embeddedTmdbId: null,
          runtimeMinutes: 120,
          dirName: mediaRoot,
          durationSec: 7200,
          embeddedLangs: null,
        },
      ],
    }

    const report = await worker(task)

    expect(report.identity?.outcome).toBe('unidentified')
    if (report.identity?.outcome !== 'unidentified') throw new Error('unreachable')
    expect(report.identity.reason).toMatch(/no.*hit/i)

    // Verify no database writes
    expect(lib.getSeries('tmdb:12345')).toBeNull()
    expect(lib.getMovie('tmdb:12345')).toBeNull()

    // Verify path remains parked
    const parked = lib.listParkedPaths().find(p => p.path === videoPath)
    expect(parked).toBeDefined()
  })
})
