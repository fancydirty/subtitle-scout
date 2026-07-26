// Auto-research 识别评估（路 A，2026-07-26）——真模型 + 真 TMDB 跑 find-subtitle worker 的
// Step 0 识别验证，对照 ground truth 判定识别质量。这是 agent 识别能力的"单元测试"：
// 每条 case = 一份 raw 数据（文件路径/目录名/时长/结构）+ 一份机械猜测（可能对可能错）
// + 一个 ground truth（正确 tmdbId / 核验该通过）。
//
// 🔴 env 门控，默认 CI 跳过（同 subhd.live.test.ts 范式）。打开：
//   IDENTITY_EVAL_LIVE=1 npx vitest run src/agent/identityEval.live.test.ts
// 需要 .env 里 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/TMDB_API_KEY 四件套（生产同款配置——
// 评的就是生产 agent 的真实判断质量，换个模型评出来的不是同一件事）。
//
// 方法论（docs/design/2026-07-21-campaign-run-log.md 战役 12 沉淀）：fail-closed——FAIL 不是
// 终点是诊断原料。每条 FAIL 打印 agent 的实际工具调用序列（它搜了什么、核验了什么、在哪
// 一步走偏），那是下一轮 skill 措辞迭代的靶子。只信数据不信叙述。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import { makeModel } from './llm.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import type { TmdbSearchHit, TmdbDetails, SeasonTableEntry } from '../adapters/providers/tmdb.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'

// .env 自加载（不依赖调用方 source——vitest worker 进程对环境继承的边界情形免疫）：
// 已存在的环境变量优先（CI/显式覆盖场景），.env 只补缺。Node≥20.12 原生支持。
try {
  if (existsSync('.env')) (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
} catch { /* 没有 .env 或加载失败——环境变量靠外部注入，门控判缺席自然 skip */ }

const live = process.env.IDENTITY_EVAL_LIVE === '1'

/** 评估 case：raw 数据 + 机械猜测 + ground truth。
 *  expectedVerdict 两态：
 *  - { kind: 'confirmed' }：机械猜对了，agent 核验该通过（无 identity_correction）。
 *  - { kind: 'corrected', tmdbId, isTv }：机械猜错了，agent 该报 identity_correction 且
 *    tmdbId 命中 ground truth。 */
interface IdentityCase {
  name: string
  /** raw 数据（模拟 ingest 给的目录/文件/时长/结构） */
  dirName: string
  fileName: string
  runtimeMinutes: number | null
  season: number | null
  episode: number | null
  /** 机械猜测（库身份——provider_ids 里的 tmdb id + title/year） */
  guessedTitle: string
  guessedYear: number | null
  guessedTmdbId: string
  isTv: boolean
  /** ground truth */
  expectedVerdict:
    | { kind: 'confirmed' }
    | { kind: 'corrected'; tmdbId: string; isTv: boolean }
}

/** Ground truth 全部来自真 TMDB 实查（2026-07-26，/tmp/tmdb-probe 脚本）：
 *  The Conjuring (2013) movie/138843 112min；Last Rites (2025) movie/1038392 136min；
 *  Backrooms (2026) movie/1083381 111min；Lycoris Recoil tv/154494 S01=13集 24min；
 *  Teach You a Lesson (참교육, 2026) tv/276161 S01=10集 70min。 */
const CASES: IdentityCase[] = [
  {
    // 机械对的常规 case——核验该通过，不许冤枉好人（误报 correction = 过度怀疑）。
    name: '招魂 The Conjuring (2013)：机械猜对 → 核验通过',
    dirName: '招魂', fileName: '招魂.The.Conjuring.2013.2160p.mkv',
    runtimeMinutes: 112, season: null, episode: null,
    guessedTitle: 'The Conjuring', guessedYear: 2013, guessedTmdbId: '138843', isTv: false,
    expectedVerdict: { kind: 'confirmed' },
  },
  {
    // 机械截断灾难（真实事故：铁拳教育被 @ctrl 截断成"铁."）——库身份给一个风马牛不相及
    // 的 tmdbId（Lycoris Recoil 154494，S01=13集24min vs 铁拳教育 S01=10集70min，名字/季表/
    // 时长全对不上）。agent 核验必失败 → 从 raw 文件名 'Teach.You.a.Lesson.S01E01' 重新识别
    // → 报 correction 276161。
    name: '铁拳教育（机械截断成"铁."+错 tmdbId）→ 重新识别为 Teach You a Lesson',
    dirName: '[BT之家]铁拳教育[全10集][简繁英字幕].Teach.You.a.Lesson.S01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264-BlackTV',
    fileName: 'Teach.You.a.Lesson.S01E01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264-BlackTV.mkv',
    runtimeMinutes: 70, season: 1, episode: 1,
    guessedTitle: '铁.', guessedYear: null, guessedTmdbId: '154494', isTv: true,
    expectedVerdict: { kind: 'corrected', tmdbId: '276161', isTv: true },
  },
  {
    // 版权规避乱写 + 机械给错代：招z魂z4 (2025) 被机械认领成初代 The Conjuring (2013)。
    // 核验时 year 2013≠2025、runtime 112≠136 全对不上 → 重新识别 → Last Rites 1038392。
    name: '招z魂z4 (2025)（机械认领成初代 138843）→ 纠正为 Last Rites',
    dirName: '招z魂z4 (2025) 4K HDR', fileName: '2025.HDR.2160p.Web.H265.mkv',
    runtimeMinutes: 136, season: null, episode: null,
    guessedTitle: '招魂4', guessedYear: 2025, guessedTmdbId: '138843', isTv: false,
    expectedVerdict: { kind: 'corrected', tmdbId: '1038392', isTv: false },
  },
  {
    // 乱码灾难：H）后丨室（2026）——机械 title 只剩一个 'H'，tmdbId 错。agent 得从
    // '2026' + runtime + 乱码里能救出的 '后室' 找到 Backrooms (2026)。最难的 case——
    // 失败即 auto research 根因原料（skill 该教什么清洗/搜索策略）。
    name: 'H）后丨室（2026）（机械只剩"H"+错 tmdbId）→ 纠正为 Backrooms',
    dirName: 'H）后丨室（2026）4K DV HDR 高码率 简英特效',
    fileName: '2026.2160p.iT.WEB-DL.DDP.5.1.Atmos.DV.HDR10+.H.265.mkv',
    runtimeMinutes: 111, season: null, episode: null,
    guessedTitle: 'H', guessedYear: 2026, guessedTmdbId: '138843', isTv: false,
    expectedVerdict: { kind: 'corrected', tmdbId: '1083381', isTv: false },
  },
  {
    // fansub 命名 + 机械对——核验该通过（[诸神字幕组][莉可丽丝][01]，绝对集号 01）。
    name: '莉可丽丝 fansub 命名（机械猜对 Lycoris Recoil）→ 核验通过',
    dirName: 'anime', fileName: '[诸神字幕组][莉可丽丝][01][1080P][简繁内封].mkv',
    runtimeMinutes: 24, season: 1, episode: 1,
    guessedTitle: 'Lycoris Recoil', guessedYear: 2022, guessedTmdbId: '154494', isTv: true,
    expectedVerdict: { kind: 'confirmed' },
  },
]

/** 包装真 TmdbClient，记录每次调用（评估"证据先行"的凭证——没调 get_tmdb_details 就是
 *  没验证，skill 的反脑补红线是否被遵守只能靠这个观测）。 */
interface TmdbCallLog {
  search: Array<{ mediaType: 'tv' | 'movie'; query: string; year?: number }>
  getDetails: Array<{ mediaType: 'tv' | 'movie'; tmdbId: string }>
  getSeasonTable: Array<{ tmdbId: string }>
}

function wrapTmdbWithLog(tmdb: TmdbClient) {
  const log: TmdbCallLog = { search: [], getDetails: [], getSeasonTable: [] }
  const wrapped = {
    search: async (mediaType: 'tv' | 'movie', query: string, year?: number): Promise<TmdbSearchHit[]> => {
      log.search.push({ mediaType, query, year })
      return tmdb.search(mediaType, query, year)
    },
    getDetails: async (mediaType: 'tv' | 'movie', tmdbId: string): Promise<TmdbDetails | null> => {
      log.getDetails.push({ mediaType, tmdbId })
      return tmdb.getDetails(mediaType, tmdbId)
    },
    getSeasonTable: async (tmdbId: string): Promise<SeasonTableEntry[] | null> => {
      log.getSeasonTable.push({ tmdbId })
      return tmdb.getSeasonTable(tmdbId)
    },
  }
  return { wrapped, log }
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-identity-eval-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('auto-research 识别评估（真模型 + 真 TMDB，IDENTITY_EVAL_LIVE=1）', () => {
  for (const c of CASES) {
    it.skipIf(!live)(`${c.name}`, async () => {
      const model = makeModel({
        baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!,
        model: process.env.LLM_MODEL!,
      })
      const tmdb = new TmdbClient({
        apiKey: process.env.TMDB_API_KEY!,
        baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL,
      })
      const { wrapped: tmdbWithLog, log } = wrapTmdbWithLog(tmdb)

      const mediaRoot = join(root, 'media')
      const videoPath = join(mediaRoot, c.dirName, c.fileName)
      mkdirSync(dirname(videoPath), { recursive: true })

      const runTask = makeFindSubtitleWorker({
        model,
        // 空 adapters——评估只关心 Step 0 身份判断。agent 核验完身份后 search_source
        // 找不到任何候选，自然 no_safe_match 收尾（核验通过 case）或 identity_correction
        // 收尾（纠错 case），不烧 step 在字幕搜索上。
        adapters: [],
        cacheRoot: join(root, 'cache'),
        tmdb: tmdbWithLog,
        stepCap: 20,
        timeoutMs: 600_000,
      })

      const task: FindSubtitleTask = {
        jobId: `eval-${c.name}`, mediaRoot: join(mediaRoot, c.dirName),
        title: c.guessedTitle, originalTitle: null, year: c.guessedYear,
        alternativeTitles: [], overview: null, runtimeMinutes: c.runtimeMinutes,
        providerIds: { tmdb: c.guessedTmdbId },
        targetLanguage: 'zh', hardsubMode: 'off', localCandidates: [],
        targets: [{
          itemId: 'eval-item-1', videoPath, videoFilename: c.fileName,
          season: c.season, episode: c.episode, absoluteEpisode: null, imdbId: null,
          runtimeMinutes: c.runtimeMinutes,
        }],
      }

      const report = await runTask(task)

      // ---- 观测报告（auto research 根因原料，FAIL 时全部打出）----
      const observed = {
        identityCorrection: report.identity_correction,
        tmdbCalls: log,
        buckets: {
          installed: report.installed.length,
          no_safe_match: report.no_safe_match.length,
          retry_later: report.retry_later.length,
        },
      }
      console.log(`\n[identity-eval] ${c.name}`)
      console.log(`  identity_correction: ${JSON.stringify(report.identity_correction)}`)
      console.log(`  tmdb calls: search=${log.search.map(s => `"${s.query}"(${s.mediaType})`).join(', ') || 'none'} | details=[${log.getDetails.map(d => d.tmdbId).join(',')}] | seasons=[${log.getSeasonTable.map(s => s.tmdbId).join(',')}]`)

      // ---- 判定 1（证据先行红线）：agent 必须真的调过 get_tmdb_details——没调就是没验证，
      // 无论结论对错都 FAIL（skill 的反脑补红线被遵守的唯一直接凭证）。
      expect(
        log.getDetails.length,
        `agent never called get_tmdb_details — identity was not verified from evidence.\n${JSON.stringify(observed, null, 2)}`,
      ).toBeGreaterThan(0)

      // ---- 判定 2（身份结论）：核验通过 case 不许报 correction；纠错 case 的 tmdbId 必须
      // 命中 ground truth（纠成另一个错的比不纠更糟——那是二次误判）。
      if (c.expectedVerdict.kind === 'confirmed') {
        expect(
          report.identity_correction,
          `expected identity confirmed (guessed tmdb:${c.guessedTmdbId} is correct), but agent reported a correction.\n${JSON.stringify(observed, null, 2)}`,
        ).toBeNull()
      } else {
        expect(report.identity_correction, `expected identity_correction to tmdb:${c.expectedVerdict.tmdbId}, got none.\n${JSON.stringify(observed, null, 2)}`).not.toBeNull()
        expect(
          report.identity_correction!.tmdbId,
          `identity_correction tmdbId mismatch.\n${JSON.stringify(observed, null, 2)}`,
        ).toBe(c.expectedVerdict.tmdbId)
        expect(report.identity_correction!.isTv).toBe(c.expectedVerdict.isTv)
      }

      // ---- 判定 3（纠错 case 不许装字幕——身份错时装的字幕记到错的库行上，skill 明禁）。
      if (c.expectedVerdict.kind === 'corrected') {
        expect(
          report.installed,
          `agent installed subtitles on an unverified/wrong identity.\n${JSON.stringify(observed, null, 2)}`,
        ).toEqual([])
      }
    }, 660_000)
  }
})
