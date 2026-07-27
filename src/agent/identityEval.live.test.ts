// Auto-research 主识别评估（agent-first identification，2026-07-27）——真模型 mimo-v2.5
// （生产同款弱模型）+ 真 TMDB 跑 findSubtitleWorker 的 Step 0 主识别流程，对照 ground truth
// 判定识别质量。这是 agent 识别能力的 live 单元测试。
//
// 🔴 env 门控，默认 CI 跳过（同 subhd.live.test.ts 范式）。打开：
//   IDENTITY_EVAL_LIVE=1 npx vitest run src/agent/identityEval.live.test.ts
// 需要 .env 里 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/TMDB_API_KEY 四件套。
//
// 通过标准（用户钦定）：用 mimo-v2.5 弱模型修到**全部通过为止**，不设轮次上限。
// 单 case 有模型随机性，必须**连续两轮全绿**才算稳定——一次绿不算数。
//
// 方法论（Karpathy autoresearch / DSPy / SkillAxe）：定义成功标准（评估集 + ground truth），
// 评估驱动迭代 skill 措辞，不预设轮次。**防过拟合**：核心集（CORE_CASES）用来迭代，
// 推理 holdout 集（HOLDOUT_CASES）只在迭代完成后验证——如果核心集全绿但 holdout 翻车，
// 说明 skill 措辞过拟合到了核心集的具体案例上，不是真识别能力。
//
// 侦探式推理（用户钦定的评估深度）：不只评"识别对没有"，还要评**推理过程**——
// agent 有没有利用元数据交叉印证（2012 case：文件名只有数字，必须用 movies 目录 +
// 时长 158min → 狐疑搜 "2012" → 时长几乎相同 → 锚定），还是瞎猜/裸 claim。
// 网盘挂载（NFS/阿里云盘）忠实反馈元数据（时长等），raw 数据在网盘场景同样有效。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { makeFindSubtitleWorker } from './findSubtitleWorker.js'
import { makeModel } from './llm.js'
import { TmdbClient } from '../adapters/providers/tmdb.js'
import type { TmdbSearchHit, TmdbDetails, SeasonTableEntry } from '../adapters/providers/tmdb.js'
import type { FindSubtitleTask } from './findSubtitleWorker.schemas.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { openDb } from '../v2/db.js'
import { makeWriteIdentityTool } from './identityTools.js'
import { tool } from 'ai'
import { z } from 'zod'

// .env 自加载（不依赖调用方 source——vitest worker 进程对环境继承的边界情形免疫）：
// 已存在的环境变量优先（CI/显式覆盖场景），.env 只补缺。Node≥20.12 原生支持。
try {
  if (existsSync('.env')) (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile('.env')
} catch { /* 没有 .env 或加载失败——环境变量靠外部注入，门控判缺席自然 skip */ }

const live = process.env.IDENTITY_EVAL_LIVE === '1'

/** 评估 case：raw 数据（无身份候选——agent 从零识别）+ ground truth。
 *  expectedVerdict 两态：
 *  - { kind: 'identified', tmdbId, isTv, season?, episode? }：该识别出正确身份+结构
 *  - { kind: 'unidentifiable' }：该诚实放弃（绝不误认红线） */
interface IdentityCase {
  name: string
  /** raw 数据（模拟 ingest 给的——网盘/NFS 挂载下同样忠实） */
  dirName: string
  fileName: string
  durationSec: number | null
  embeddedLangs: string[] | null
  structureHints: { season: number | null; episode: number | null; absoluteEpisode: number | null }
  /** ground truth */
  expectedVerdict:
    | { kind: 'identified'; tmdbId: string; isTv: boolean; season?: number; episode?: number }
    | { kind: 'unidentifiable' }
}

/** 核心集（迭代用）——9 个真实命名压力 case，ground truth 全部真 TMDB 实查（2026-07-26）。
 *  覆盖：版权规避乱写 / 乱码 / fansub / 中文截断 / 同名不同 kind / 同名不同国 /
 *  TMDB 搜索陷阱 / 单集越界红线 / 常规 case。 */
const CORE_CASES: IdentityCase[] = [
  {
    name: '招z魂z4 (2025)：版权规避乱写 → The Conjuring: Last Rites',
    dirName: '招z魂z4 (2025) 4K HDR', fileName: '2025.HDR.2160p.Web.H265.mkv',
    durationSec: 8160, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '1038392', isTv: false },
  },
  {
    name: 'H）后丨室（2026）：乱码+纯技术文件名 → Backrooms',
    dirName: 'H）后丨室（2026）4K DV HDR 高码率 简英特效',
    fileName: '2026.2160p.iT.WEB-DL.DDP.5.1.Atmos.DV.HDR10+.H.265.mkv',
    durationSec: 6660, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '1083381', isTv: false },
  },
  {
    name: '莉可丽丝 fansub：[诸神字幕组][莉可丽丝][01] → Lycoris Recoil S01E01',
    dirName: 'anime', fileName: '[诸神字幕组][莉可丽丝][01][1080P][简繁内封].mkv',
    durationSec: 1440, embeddedLangs: ['chi', 'jpn'],
    structureHints: { season: null, episode: null, absoluteEpisode: 1 },
    expectedVerdict: { kind: 'identified', tmdbId: '154494', isTv: true, season: 1, episode: 1 },
  },
  {
    name: '铁拳教育：BT站目录+中文截断灾难 → Teach You a Lesson S01E01',
    dirName: '[BT之家]铁拳教育[全10集][简繁英字幕].Teach.You.a.Lesson.S01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264-BlackTV',
    fileName: 'Teach.You.a.Lesson.S01E01.1080p.NF.WEB-DL.DDP.5.1.Atmos.H.264-BlackTV.mkv',
    durationSec: 4200, embeddedLangs: ['chi'],
    structureHints: { season: 1, episode: 1, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '276161', isTv: true, season: 1, episode: 1 },
  },
  {
    name: 'The Rig：同名不同 kind 不同年（2010 电影 vs 2023 剧集）→ 2023 剧集',
    dirName: 'The.Rig.S01.2023.1080p.AMZN.WEB-DL',
    fileName: 'The.Rig.S01E01.2023.1080p.AMZN.WEB-DL.DDP5.1.H.264.mkv',
    durationSec: 3480, embeddedLangs: null,
    structureHints: { season: 1, episode: 1, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '112581', isTv: true, season: 1, episode: 1 },
  },
  {
    name: 'Peacemaker：同名不同国（芬兰 Rauhantekijä vs DC）→ DC 2022',
    dirName: 'Peacemaker.S01.2022.1080p.HMAX.WEB-DL',
    fileName: 'Peacemaker.S01E01.2022.1080p.HMAX.WEB-DL.DD5.1.H.264-NTb.mkv',
    durationSec: 2400, embeddedLangs: null,
    structureHints: { season: 1, episode: 1, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '110492', isTv: true, season: 1, episode: 1 },
  },
  {
    name: '怪奇物语 S04E09：TMDB 搜索首条是错条目（Osoroshi）→ Stranger Things',
    dirName: '怪奇物语.Stranger.Things.S04.2160p',
    fileName: '怪奇物语.S04E09.1080p.mkv',
    durationSec: 8340, embeddedLangs: null,
    structureHints: { season: 4, episode: 9, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '66732', isTv: true, season: 4, episode: 9 },
  },
  {
    name: '🔴 Stranger Things S04E13：集号越界但身份正确 → 不许误纠/不许放弃',
    dirName: 'Stranger.Things.S04.2160p.NF.WEB-DL',
    fileName: 'Stranger.Things.S04E13.2160p.NF.WEB-DL.mkv',
    durationSec: 4680, embeddedLangs: null,
    structureHints: { season: 4, episode: 13, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '66732', isTv: true, season: 4, episode: 13 },
  },
  {
    name: '招魂 The Conjuring (2013)：常规 case → 不许误纠',
    dirName: '招魂', fileName: '招魂.The.Conjuring.2013.2160p.mkv',
    durationSec: 6720, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '138843', isTv: false },
  },
]

/** 推理 holdout 集（防过拟合验证用）——考验**侦探式推理**的硬 case：
 *  纯数字标题（文件名只有数字，必须用目录+时长交叉印证）/ 符号标题 / 单字母 / 重制。
 *  这些 case 哪怕最精巧的机械刮削都会失灵，必须依靠 agent 的推理能力：
 *  看到 "2012" 一头雾水 → 注意到在 movies 目录 + 时长 158min → 狐疑搜 "2012" →
 *  发现时长几乎相同 → 八成锚定。评估要检查这个推理过程，不只是最终答案。 */
const HOLDOUT_CASES: IdentityCase[] = [
  {
    // 用户钦定的侦探式推理 case：文件名只有数字 "2012"，光看名字一头雾水。
    // 必须用 movies 目录 + 时长 9480s (158min) → 狐疑搜 "2012" → 时长几乎相同 → 锚定。
    name: '🔬 2012：纯数字标题+时长交叉印证 → 2012 (2009) 灾难片',
    dirName: 'movies', fileName: '2012.2009.1080p.BluRay.x264.mkv',
    durationSec: 9480, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '14161', isTv: false },
  },
  {
    name: '🔬 1917：纯数字标题+时长 → 1917 (2019) 战争片',
    dirName: 'movies', fileName: '1917.2019.2160p.UHD.BluRay.x265.mkv',
    durationSec: 7140, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '530915', isTv: false },
  },
  {
    name: '🔬 300：纯数字标题+时长 → 300 (2007)',
    dirName: 'movies', fileName: '300.2007.1080p.BluRay.DTS.x264.mkv',
    durationSec: 7020, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '1271', isTv: false },
  },
  {
    // 符号标题 π——搜索 "π" 或 "Pi" 都有歧义（Life of Pi 2012 vs Pi 1998）。
    // 必须用年份 1998 + 时长 84min 区分。
    name: '🔬 π (Pi)：符号标题+年份/时长区分（vs Life of Pi 2012）→ Pi (1998)',
    dirName: 'movies', fileName: 'Pi.1998.1080p.BluRay.x264.mkv',
    durationSec: 5040, embeddedLangs: null,
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '473', isTv: false },
  },
  {
    // 单字母标题 M——搜索 "M" 全是噪音。必须用年份 1931 + 时长 110min + 德国片特征。
    name: '🔬 M：单字母标题+年份/时长 → M (1931) Fritz Lang',
    dirName: 'movies', fileName: 'M.1931.1080p.Criterion.BluRay.x264.mkv',
    durationSec: 6600, embeddedLangs: ['ger'],
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '832', isTv: false },
  },
  {
    // 重制陷阱：Oldboy 2003 (韩国朴赞郁) vs 2013 (美国 Spike Lee)。
    // 目录名有 "올드보이" 韩文 + 年份 2003 + 时长 120min → 必须是 2003 版。
    name: '🔬 Oldboy：重制陷阱（2003 韩国 vs 2013 美国）→ 올드보이 2003',
    dirName: 'Oldboy.2003.올드보이.1080p.BluRay.x264',
    fileName: 'Oldboy.2003.1080p.BluRay.x264.mkv',
    durationSec: 7200, embeddedLangs: ['kor'],
    structureHints: { season: null, episode: null, absoluteEpisode: null },
    expectedVerdict: { kind: 'identified', tmdbId: '670', isTv: false },
  },
]

/** Ground truth 快照（2026-07-27 真 TMDB 实查）。preflight 拿它跟当前 TMDB 对账——数据漂了
 *  就明确报"ground truth 漂移"，而不是让评估用例以"identity tmdbId mismatch"的面目变红
 *  （那和真的模型退化长得一模一样，会让人去改 skill 追一个 TMDB 数据变更）。 */
const GROUND_TRUTH: Array<{ tmdbId: string; isTv: boolean; year: number; runtimeMinutes: number | null; note: string }> = [
  { tmdbId: '1038392', isTv: false, year: 2025, runtimeMinutes: 136, note: 'The Conjuring: Last Rites（未上映，易漂）' },
  { tmdbId: '1083381', isTv: false, year: 2026, runtimeMinutes: 111, note: 'Backrooms（未上映，易漂）' },
  { tmdbId: '154494', isTv: true, year: 2022, runtimeMinutes: null, note: 'Lycoris Recoil' },
  { tmdbId: '276161', isTv: true, year: 2026, runtimeMinutes: null, note: 'Teach You a Lesson（未上映，易漂）' },
  { tmdbId: '112581', isTv: true, year: 2023, runtimeMinutes: null, note: 'The Rig 2023 剧集' },
  { tmdbId: '110492', isTv: true, year: 2022, runtimeMinutes: null, note: 'Peacemaker DC' },
  { tmdbId: '66732', isTv: true, year: 2016, runtimeMinutes: null, note: 'Stranger Things' },
  { tmdbId: '138843', isTv: false, year: 2013, runtimeMinutes: 112, note: 'The Conjuring' },
  { tmdbId: '14161', isTv: false, year: 2009, runtimeMinutes: 158, note: '2012' },
  { tmdbId: '530915', isTv: false, year: 2019, runtimeMinutes: 119, note: '1917' },
  { tmdbId: '1271', isTv: false, year: 2007, runtimeMinutes: 117, note: '300' },
  { tmdbId: '473', isTv: false, year: 1998, runtimeMinutes: 84, note: 'Pi' },
  { tmdbId: '832', isTv: false, year: 1931, runtimeMinutes: 110, note: 'M (Fritz Lang)' },
  { tmdbId: '670', isTv: false, year: 2003, runtimeMinutes: 120, note: 'Oldboy 韩国' },
]

/** 包装真 TmdbClient，记录每次调用（评估"证据先行"的凭证——没调工具就是没验证）。 */
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
    getChineseTitles: tmdb.getChineseTitles.bind(tmdb),
    getExternalIds: tmdb.getExternalIds.bind(tmdb),
    getOriginLanguage: tmdb.getOriginLanguage.bind(tmdb),
  }
  return { wrapped, log }
}

/** 写库调用记录（评估 agent 有没有真的调 write_identified_media）。 */
interface WriteCallLog {
  calls: Array<{ tmdbId: string; isTv: boolean; title: string; season: number | null; episode: number | null; file: string }>
}

/** 包装 makeWriteIdentityTool，记录每次调用（评估 agent 有没有真的调写库工具）。 */
function wrapWriteIdentityToolWithLog(deps: Parameters<typeof makeWriteIdentityTool>[0], log: WriteCallLog) {
  const realTool = makeWriteIdentityTool(deps)
  return tool({
    description: realTool.description,
    inputSchema: realTool.inputSchema,
    execute: async (input: unknown, opts: unknown) => {
      const { tmdbId, isTv, title, season, episode, file } = input as { tmdbId: string; isTv: boolean; title: string; season: number | null; episode: number | null; file: string }
      log.calls.push({ tmdbId, isTv, title, season, episode, file })
      return (realTool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, opts)
    },
  })
}

let root: string
let lib: LibraryRepo
let writeLog: WriteCallLog

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scout-identity-eval-'))
  lib = new LibraryRepo(openDb(':memory:'))
  writeLog = { calls: [] }
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

/** 跑一个 case：构造 raw-data task，agent 识别，返回报告 + 工具调用记录 + 写库记录。 */
async function runCase(c: IdentityCase) {
  const model = makeModel({
    baseUrl: process.env.LLM_BASE_URL!, apiKey: process.env.LLM_API_KEY!,
    model: process.env.LLM_MODEL!,
  })
  const tmdb = new TmdbClient({
    apiKey: process.env.TMDB_API_KEY!,
    baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL,
  })
  const { wrapped: tmdbWithLog, log } = wrapTmdbWithLog(tmdb)

  const mediaRoot = join(root, 'media', c.dirName)
  const videoPath = join(mediaRoot, c.fileName)
  mkdirSync(dirname(videoPath), { recursive: true })

  const runTask = makeFindSubtitleWorker({
    model,
    adapters: [], // 空 adapters——评估只关心 Step 0 身份判断，不评字幕搜索
    cacheRoot: join(root, 'cache'),
    tmdb: tmdbWithLog,
    identityDeps: {
      lib,
      tmdb: {
        getDetails: tmdbWithLog.getDetails,
        getChineseTitles: tmdbWithLog.getChineseTitles,
        getExternalIds: tmdbWithLog.getExternalIds,
        getOriginLanguage: tmdbWithLog.getOriginLanguage,
      },
      writeToolFactory: (deps) => wrapWriteIdentityToolWithLog(deps, writeLog) as ReturnType<typeof makeWriteIdentityTool>,
    },
    stepCap: 30, // 写库步骤加进来后步数变多（第三轮实测 2 个 case 烧完 20 步没到 finalize）
    timeoutMs: 600_000,
  })

  const task: FindSubtitleTask = {
    jobId: `eval-${c.name}`, mediaRoot,
    title: '', originalTitle: null, year: null,
    alternativeTitles: [], overview: null, runtimeMinutes: null,
    providerIds: {},
    targetLanguage: 'zh', hardsubMode: 'off', localCandidates: [],
    targets: [{
      itemId: null, // 未识别——agent 从零识别（spec：输入只有路径原文）
      videoPath, videoFilename: c.fileName,
      season: c.structureHints.season, episode: c.structureHints.episode,
      absoluteEpisode: c.structureHints.absoluteEpisode,
      imdbId: null,
      embeddedTmdbId: null,
      runtimeMinutes: c.durationSec ? Math.round(c.durationSec / 60) : null,
      dirName: c.dirName,
      durationSec: c.durationSec,
      embeddedLangs: c.embeddedLangs,
    }],
  }

  const report = await runTask(task)

  return { report, tmdbLog: log, writeLog }
}

/** 判定一个 case（核心集和 holdout 共用）。 */
function judgeCase(c: IdentityCase, report: any, tmdbLog: TmdbCallLog, writeLog: WriteCallLog) {
  const observed = {
    identity: report.identity,
    tmdbCalls: tmdbLog,
    writeCalls: writeLog.calls,
    buckets: {
      installed: report.installed.length,
      no_safe_match: report.no_safe_match.length,
      retry_later: report.retry_later.length,
    },
  }
  console.log(`\n[identity-eval] ${c.name}`)
  console.log(`  identity: ${JSON.stringify(report.identity)}`)
  console.log(`  tmdb calls: search=${tmdbLog.search.map(s => `"${s.query}"(${s.mediaType})`).join(', ') || 'none'} | details=[${tmdbLog.getDetails.map(d => d.tmdbId).join(',')}] | seasons=[${tmdbLog.getSeasonTable.map(s => s.tmdbId).join(',')}]`)
  console.log(`  write calls: ${writeLog.calls.length > 0 ? JSON.stringify(writeLog.calls) : 'none'}`)

  // ---- 判定 1（证据先行红线）：agent 必须真的调过工具——没调 search_tmdb 或
  // get_tmdb_details 就是没验证，无论结论对错都 FAIL（脑补红线）。
  expect(
    tmdbLog.search.length,
    `agent never called search_tmdb — identification was not evidence-based.\n${JSON.stringify(observed, null, 2)}`,
  ).toBeGreaterThan(0)
  expect(
    tmdbLog.getDetails.length,
    `agent never called get_tmdb_details — identity was not verified.\n${JSON.stringify(observed, null, 2)}`,
  ).toBeGreaterThan(0)

  if (c.expectedVerdict.kind === 'unidentifiable') {
    // ---- 红线 case：该诚实放弃——不许乱 claim（绝不误认）。
    expect(
      report.identity?.outcome,
      `expected 'unidentified' but agent claimed an identity.\n${JSON.stringify(observed, null, 2)}`,
    ).toBe('unidentified')
    // 不许写库
    expect(
      writeLog.calls,
      `agent wrote to DB despite being unable to identify.\n${JSON.stringify(observed, null, 2)}`,
    ).toEqual([])
    return
  }

  // ---- 判定 2（识别对没有）：tmdbId 必须命中 ground truth。
  expect(
    report.identity?.outcome,
    `expected 'identified' but got '${report.identity?.outcome}'.\n${JSON.stringify(observed, null, 2)}`,
  ).toBe('identified')
  expect(
    report.identity?.tmdbId,
    `tmdbId mismatch.\n${JSON.stringify(observed, null, 2)}`,
  ).toBe(c.expectedVerdict.tmdbId)
  expect(report.identity?.isTv).toBe(c.expectedVerdict.isTv)

  // ---- 判定 3（结构归位）：TV case 的 season/episode 必须判对（spec：结构也归 agent 判）。
  if (c.expectedVerdict.season !== undefined) {
    expect(
      report.identity?.season,
      `season mismatch.\n${JSON.stringify(observed, null, 2)}`,
    ).toBe(c.expectedVerdict.season)
  }
  if (c.expectedVerdict.episode !== undefined) {
    expect(
      report.identity?.episode,
      `episode mismatch.\n${JSON.stringify(observed, null, 2)}`,
    ).toBe(c.expectedVerdict.episode)
  }

  // ---- 判定 4（写库动作）：agent 必须真的调 write_identified_media，且参数对。
  const expectedTmdbId = c.expectedVerdict.tmdbId
  expect(
    writeLog.calls.length,
    `agent identified tmdb:${expectedTmdbId} but never called write_identified_media.\n${JSON.stringify(observed, null, 2)}`,
  ).toBeGreaterThan(0)
  const writeCall = writeLog.calls.find(call => call.tmdbId === expectedTmdbId)
  expect(
    writeCall,
    `write_identified_media was not called with the correct tmdbId ${expectedTmdbId}.\n${JSON.stringify(observed, null, 2)}`,
  ).toBeDefined()
  expect(writeCall!.isTv).toBe(c.expectedVerdict.isTv)

  // ---- 判定 5（侦探式推理）：agent 必须对**最终认领的那个 id** 调过 get_tmdb_details——
  // 只搜了但没验最终答案 = 没交叉印证 = 推理链断裂。
  expect(
    tmdbLog.getDetails.some(d => d.tmdbId === expectedTmdbId),
    `agent claimed tmdb:${expectedTmdbId} but never called get_tmdb_details on it — ` +
    `the structural evidence line was never checked (detective reasoning broken).\n${JSON.stringify(observed, null, 2)}`,
  ).toBe(true)

  // ---- 判定 6（证据字段非空且言之有物）：nameEvidence/structureEvidence 不能是空话。
  expect(
    report.identity?.nameEvidence?.length ?? 0,
    `nameEvidence is empty or missing.\n${JSON.stringify(observed, null, 2)}`,
  ).toBeGreaterThan(10)
  expect(
    report.identity?.structureEvidence?.length ?? 0,
    `structureEvidence is empty or missing.\n${JSON.stringify(observed, null, 2)}`,
  ).toBeGreaterThan(10)
}

describe('识别评估集 ground truth 对账（漂移检测，IDENTITY_EVAL_LIVE=1）', () => {
  it.skipIf(!live)('全部硬编码 tmdbId 在 TMDB 上仍存在且年份/时长未变', async () => {
    const tmdb = new TmdbClient({
      apiKey: process.env.TMDB_API_KEY!,
      baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL,
    })
    const drifted: string[] = []
    // 限流容错（第五轮实测教训）：跑了几轮评估后 TMDB 会限流，单次 getDetails 返回 null
    // 会被误报成"数据漂移"（1038392 明明存在，同一轮的评估 case 还识别成功了）。
    // 重试 3 次 + 退避——真 404 三次都是 null，限流大概率第二次就过。
    const getDetailsWithRetry = async (mediaType: 'tv' | 'movie', tmdbId: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const d = await tmdb.getDetails(mediaType, tmdbId).catch(() => null)
        if (d) return d
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
      return null
    }
    for (const g of GROUND_TRUTH) {
      const d = await getDetailsWithRetry(g.isTv ? 'tv' : 'movie', g.tmdbId)
      if (!d) { drifted.push(`tmdb:${g.tmdbId} (${g.note}) 已不存在/404（已重试 3 次）`); continue }
      if (d.year !== g.year) drifted.push(`tmdb:${g.tmdbId} (${g.note}) 年份 ${g.year}→${d.year}`)
      if (g.runtimeMinutes != null && d.runtimeMinutes !== g.runtimeMinutes) {
        drifted.push(`tmdb:${g.tmdbId} (${g.note}) 时长 ${g.runtimeMinutes}→${d.runtimeMinutes}`)
      }
    }
    expect(
      drifted,
      `TMDB ground truth 已漂移，下面的评估用例失败与模型无关，先更新 CASES/GROUND_TRUTH：\n  ${drifted.join('\n  ')}`,
    ).toEqual([])
  }, 180_000)
})

describe('auto-research 主识别评估·核心集（迭代用，真模型 mimo-v2.5 + 真 TMDB）', () => {
  for (const c of CORE_CASES) {
    it.skipIf(!live)(c.name, async () => {
      const { report, tmdbLog, writeLog } = await runCase(c)
      judgeCase(c, report, tmdbLog, writeLog)
    }, 660_000)
  }
})

describe('auto-research 主识别评估·推理 holdout（防过拟合验证，迭代完成后跑）', () => {
  for (const c of HOLDOUT_CASES) {
    it.skipIf(!live)(c.name, async () => {
      const { report, tmdbLog, writeLog } = await runCase(c)
      judgeCase(c, report, tmdbLog, writeLog)
    }, 660_000)
  }
})
