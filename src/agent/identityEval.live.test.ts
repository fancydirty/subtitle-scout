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
  {
    // 真实生产事故 A（The Rig，已防住的那个）：同名不同 kind 不同年——2023 剧集 vs 2010
    // 电影。机械把剧集认领成了电影 46368（2010）。agent 该发现 kind/year 都不对
    // （目标有 S01E01 结构 + 2023）→ 纠正为 tv/112581。
    name: 'The Rig 同名陷阱（机械认领成 2010 电影 46368）→ 纠正为 2023 剧集 112581',
    dirName: 'The.Rig.S01.2023.1080p.AMZN.WEB-DL',
    fileName: 'The.Rig.S01E01.2023.1080p.AMZN.WEB-DL.DDP5.1.H.264.mkv',
    runtimeMinutes: 58, season: 1, episode: 1,
    guessedTitle: 'The Rig', guessedYear: 2010, guessedTmdbId: '46368', isTv: false,
    expectedVerdict: { kind: 'corrected', tmdbId: '112581', isTv: true },
  },
  {
    // 真实生产事故 B（Peacemaker，栽了的那个——整季 8 集被装成芬兰同名剧的字幕）：
    // tv/108886 是 Rauhantekijä (2020, 芬兰)，tv/110492 才是 DC 的 Peacemaker (2022)。
    // 机械认领成了芬兰剧。agent 该发现 year 2020≠2022 + 原名 Rauhantekijä 不是本剧
    // → 纠正为 110492。季表两者都是 8 集（结构陷阱完美，必须靠 year/原名判）。
    name: 'Peacemaker 同名不同国（机械认领成芬兰 Rauhantekijä 108886）→ 纠正为 DC 110492',
    dirName: 'Peacemaker.S01.2022.1080p.HMAX.WEB-DL',
    fileName: 'Peacemaker.S01E01.2022.1080p.HMAX.WEB-DL.DD5.1.H.264-NTb.mkv',
    runtimeMinutes: 40, season: 1, episode: 1,
    guessedTitle: 'Peacemaker', guessedYear: 2020, guessedTmdbId: '108886', isTv: true,
    expectedVerdict: { kind: 'corrected', tmdbId: '110492', isTv: true },
  },
  {
    // 中文名搜 TMDB 命中错条目的陷阱：搜"怪奇物语"TMDB 第一条返回的是 Osoroshi
    // （おそろし～三島屋変調百物語, 2014），Stranger Things (66732) 排第二——考验 agent
    // 会不会"取第一条就跑"。机械认领成了 Osoroshi 108262；目标是 S04E09（Stranger
    // Things S04 确有 9 集），agent 该靠季表 + 年份纠正为 66732。
    name: '怪奇物语 S04E09（机械认领成同名日剧 Osoroshi 108262）→ 纠正为 Stranger Things 66732',
    dirName: '怪奇物语.Stranger.Things.S04.2160p',
    fileName: '怪奇物语.S04E09.1080p.mkv',
    runtimeMinutes: 139, season: 4, episode: 9,
    guessedTitle: '怪奇物语', guessedYear: 2014, guessedTmdbId: '108262', isTv: true,
    expectedVerdict: { kind: 'corrected', tmdbId: '66732', isTv: true },
  },
  {
    // 🔴 北极星红线 case（零误认）：机械身份就是对的，但 raw 数据里的季/集结构**超出**
    // TMDB 季表（Stranger Things S04 只有 9 集，这里给 S04E13）。这不是身份问题——身份
    // 核验该通过（名字/年份都对），agent 不该因为单集号越界就去纠正整个身份（那会把一部
    // 正确的剧改成别的剧，是灾难性误纠）。期望：confirmed（不报 correction），越界的单集
    // 由后续找字幕环节自己处理（找不到就 no_safe_match）。
    name: '🔴 Stranger Things S04E13（集号越界但身份正确）→ 不许误纠身份',
    dirName: 'Stranger.Things.S04.2160p.NF.WEB-DL',
    fileName: 'Stranger.Things.S04E13.2160p.NF.WEB-DL.mkv',
    runtimeMinutes: 78, season: 4, episode: 13,
    guessedTitle: 'Stranger Things', guessedYear: 2016, guessedTmdbId: '66732', isTv: true,
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

/** Ground truth 快照（2026-07-26 真 TMDB 实查）。preflight 拿它跟当前 TMDB 对账——数据漂了
 *  就明确报"ground truth 漂移"，而不是让评估用例以"identity_correction tmdbId mismatch"的
 *  面目变红（那和真的模型退化长得一模一样，会让人去改 skill 追一个 TMDB 的数据变更）。
 *  尤其危险的是三个**未上映**条目（276161/1083381/1038392）：预发布条目被合并、改号、改名、
 *  改档是常态。 */
const GROUND_TRUTH: Array<{ tmdbId: string; isTv: boolean; year: number; runtimeMinutes: number | null; note: string }> = [
  { tmdbId: '138843', isTv: false, year: 2013, runtimeMinutes: 112, note: 'The Conjuring' },
  { tmdbId: '1038392', isTv: false, year: 2025, runtimeMinutes: 136, note: 'Last Rites（未上映，易漂）' },
  { tmdbId: '1083381', isTv: false, year: 2026, runtimeMinutes: 111, note: 'Backrooms（未上映，易漂）' },
  { tmdbId: '46368', isTv: false, year: 2010, runtimeMinutes: null, note: 'The Rig 2010 电影（同名陷阱的错侧）' },
  { tmdbId: '154494', isTv: true, year: 2022, runtimeMinutes: null, note: 'Lycoris Recoil' },
  { tmdbId: '276161', isTv: true, year: 2026, runtimeMinutes: null, note: 'Teach You a Lesson（未上映，易漂）' },
  { tmdbId: '112581', isTv: true, year: 2023, runtimeMinutes: null, note: 'The Rig 2023 剧集' },
  { tmdbId: '110492', isTv: true, year: 2022, runtimeMinutes: null, note: 'Peacemaker DC' },
  { tmdbId: '108886', isTv: true, year: 2020, runtimeMinutes: null, note: 'Rauhantekijä（芬兰同名剧，事故的错侧）' },
  { tmdbId: '66732', isTv: true, year: 2016, runtimeMinutes: null, note: 'Stranger Things' },
  { tmdbId: '108262', isTv: true, year: 2014, runtimeMinutes: null, note: 'Osoroshi（怪奇物语搜索陷阱的错侧）' },
]

describe('识别评估集 ground truth 对账（漂移检测，IDENTITY_EVAL_LIVE=1）', () => {
  it.skipIf(!live)('全部硬编码 tmdbId 在 TMDB 上仍存在且年份未变', async () => {
    const tmdb = new TmdbClient({
      apiKey: process.env.TMDB_API_KEY!,
      baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL,
    })
    const drifted: string[] = []
    for (const g of GROUND_TRUTH) {
      const d = await tmdb.getDetails(g.isTv ? 'tv' : 'movie', g.tmdbId).catch(() => null)
      if (!d) { drifted.push(`tmdb:${g.tmdbId} (${g.note}) 已不存在/404`); continue }
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

  // 两个陷阱 case 依赖的是**否定事实**（TMDB 搜索排序 / 季集数上界），漂了会让陷阱静默失效
  // ——测试照样绿，但已经不再考验它本来要考验的东西（假绿比假红更糟）。
  it.skipIf(!live)('陷阱前提仍成立：怪奇物语搜索首条不是 Stranger Things；ST S04 集数 < 13', async () => {
    const tmdb = new TmdbClient({
      apiKey: process.env.TMDB_API_KEY!,
      baseUrl: process.env.TMDB_BASE_URL, proxyUrl: process.env.TMDB_PROXY_URL,
    })
    const hits = await tmdb.search('tv', '怪奇物语')
    expect(
      hits.length > 0 && String(hits[0].id) !== '66732',
      '「怪奇物语」搜索首条现在就是 Stranger Things —— 该 case 的"取第一条就跑"陷阱已失效，需换素材',
    ).toBe(true)

    const seasons = await tmdb.getSeasonTable('66732')
    const s4 = seasons?.find((s) => s.seasonNumber === 4)
    expect(
      s4 != null && s4.episodeCount < 13,
      `Stranger Things S04 集数现在是 ${s4?.episodeCount} —— S04E13 越界红线 case 的前提已不成立`,
    ).toBe(true)
  }, 180_000)
})

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

      // ---- 判定 2（身份结论）：核验通过 case 不许改动库身份；纠错 case 的 tmdbId 必须
      // 命中 ground truth（纠成另一个错的比不纠更糟——那是二次误判）。
      if (c.expectedVerdict.kind === 'confirmed') {
        // 判据是"库身份不会被改动"，不是"模型没填字段"。第八轮 auto research 定论：模型在
        // 某些场景（如单集号越界）总想在纠错字段里交代一句"我核验过了，是对的"，四轮措辞
        // 加码 + 新增 identity_verified 字段都拦不住。这不该判为失败——**只要它提议的身份
        // 就是库里现有的那个**，runner 的空转纠错拦截会把它挡在写库之外（见
        // findSubtitleWorkerTask.ts 同名注释），库身份纹丝不动，红线（绝不误改一部正确
        // 识别的剧）没有被突破。真正要抓的是"提议了一个不同的身份"。
        const proposed = report.identity_correction?.tmdbId ?? null
        expect(
          proposed === null || proposed === c.guessedTmdbId,
          `identity was correct (tmdb:${c.guessedTmdbId}) but the agent proposed a DIFFERENT ` +
            `identity tmdb:${proposed} — that would rewrite a correctly-identified title.\n` +
            JSON.stringify(observed, null, 2),
        ).toBe(true)
      } else {
        expect(report.identity_correction, `expected identity_correction to tmdb:${c.expectedVerdict.tmdbId}, got none.\n${JSON.stringify(observed, null, 2)}`).not.toBeNull()
        expect(
          report.identity_correction!.tmdbId,
          `identity_correction tmdbId mismatch.\n${JSON.stringify(observed, null, 2)}`,
        ).toBe(c.expectedVerdict.tmdbId)
        expect(report.identity_correction!.isTv).toBe(c.expectedVerdict.isTv)
        // 证据先行的加强判定（审计建议 5）：光调过 get_tmdb_details 不够——必须核验过**它自己
        // 提议的那个 id**。只查了机械猜测的错 id、然后凭搜索结果直接 claim 一个新 id，属于
        // "换了个目标继续脑补"，两证据门槛里的结构证据那一条根本没走。
        expect(
          log.getDetails.some((d) => d.tmdbId === c.expectedVerdict.tmdbId),
          `agent proposed tmdb:${c.expectedVerdict.tmdbId} but never called get_tmdb_details on it — ` +
            `the structural evidence line was never checked.\n${JSON.stringify(observed, null, 2)}`,
        ).toBe(true)
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
