/**
 * 干测压测（第 5.5 步第 3 项）：A（工具桩化）+ C（ask-only prompt）
 *
 * 不产生副作用：所有写操作（download/install）都是桩，只记录调用不落盘。
 * 两个模型对比：mimo-v2.5（弱）vs mimo-v2.5-pro（强）——弱模型才暴露 skill 的模糊处。
 *
 * 场景按"有无真实事故记录"排序：
 *   S1 限流/配额  → Peacemaker 误判根因（skill 刚改的 retry_later 判据）
 *   S2 只有 pack  → skill 明写的死循环失败模式
 *   S3 同名陷阱   → Peacemaker 芬兰剧实案（装错 8 集）
 *   S4 首搜空     → "穷尽标准"是否被遵守（不许撂挑子）
 *   S5 绝对集号   → 番剧 pack 常见命名
 *   S6 结构可疑   → "信字节不信标签"
 *   S7 跨季同名   → itemId 消歧（首轮发现弱模型会省略）
 *   S8 混语言 pack→ 不许为"有个东西"装错语言
 */

import { describe, it, expect } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { makeModel, type LlmConfig } from './llm.js'
import { makeReasoningAgent } from './reasoningAgent.js'
import { makeFindSubtitleSkill } from './skills/findSubtitleSkill.js'
import { makeReadDocTool, systemPromptSkillIndex } from './skills/registry.js'

function cfg(variant: 'v2.5' | 'pro'): LlmConfig {
  return {
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: variant === 'v2.5' ? 'mimo-v2.5' : 'mimo-v2.5-pro',
  }
}

interface ToolCall { name: string; args: Record<string, unknown> }

/** 一个场景的桩数据：决定 search/get/download 各返回什么，用来逼出特定判断。 */
interface Scenario {
  id: string
  /** 送给 agent 的任务描述 */
  prompt: string
  searchResult: (queryCount: number) => unknown
  candidateDetail?: unknown
  downloadResult?: unknown
  /** 断言：给定工具调用序列 + finalize 报告，检查 agent 是否做对 */
  check: (calls: ToolCall[], report: Report) => void
}

interface Report {
  installed: { itemId: string; path: string }[]
  no_safe_match: { itemId: string | null; reason: string }[]
  retry_later?: { itemId: string | null; reason: string }[]
}

// 必须与生产的 FindSubtitleBatchReportSchema 同形状（{itemId, reason} 对象数组，
// 不是字符串数组）。曾把三桶写成 string[]：pro 按生产格式输出对象被 schema 拦下判为
// 失败，而弱模型凑巧写了字符串反而"通过"——测试 schema 与生产不一致时，结论会完全反过来。
const UnresolvedItem = z.object({
  itemId: z.string().nullable(),
  reason: z.string(),
})

const FinalizeSchema = z.object({
  installed: z.array(z.object({ itemId: z.string(), path: z.string() })),
  no_safe_match: z.array(UnresolvedItem),
  retry_later: z.array(UnresolvedItem).optional(),
})

/** 三桶的 itemId 取用助手——桶里是 {itemId, reason} 而非裸字符串。 */
const ids = (bucket: { itemId: string | null; reason: string }[] | undefined): (string | null)[] =>
  (bucket ?? []).map(x => x.itemId)

function makeTools(sc: Scenario) {
  const calls: ToolCall[] = []
  const rec = (name: string, args: Record<string, unknown>) => { calls.push({ name, args }) }
  let searchCount = 0

  const tools = {
    search_source: tool({
      description: 'Search subtitle providers. Returns result_set_id + count + top-N preview.',
      inputSchema: z.object({ itemId: z.string(), queries: z.array(z.string()) }),
      execute: async (a) => { rec('search_source', a); searchCount++; return sc.searchResult(searchCount) },
    }),
    list_candidates: tool({
      description: 'Page through a result set.',
      inputSchema: z.object({ resultSetId: z.string(), page: z.number().optional() }),
      execute: async (a) => { rec('list_candidates', a); return sc.searchResult(searchCount) },
    }),
    get_candidate: tool({
      description: 'Get one candidate in detail, including its fileList.',
      inputSchema: z.object({
        resultSetId: z.string(), index: z.number(),
        detail: z.enum(['summary', 'detailed']).optional(),
      }),
      execute: async (a) => {
        rec('get_candidate', a)
        return sc.candidateDetail ?? { error: 'no such candidate' }
      },
    }),
    download_candidate: tool({
      description: 'Download + stage a candidate for structural inspection (STUB: nothing written).',
      inputSchema: z.object({
        candidateId: z.string(), videoFilename: z.string(),
        fileIndex: z.number().nullable().optional(),
        archiveEntryName: z.string().nullable().optional(),
        itemId: z.string().nullable().optional(),
      }),
      execute: async (a) => {
        rec('download_candidate', a)
        // 复刻真实工具的二段式行为（assrtAdapter.ts + findSubtitleWorker.tools.ts）：
        // fileIndex 为空且候选是多条目包 → 不 staging，返回 archiveEntries 让 agent 二次选集。
        // 少了这一段，桩会假装"整包下载直接就是那一集"，把真实的选集要求测没了。
        const fl = (sc.candidateDetail as { fileList?: { index: number; name: string }[] } | undefined)?.fileList
        const isMultiEntryPack = (fl?.length ?? 0) > 1
        if (isMultiEntryPack && a.fileIndex == null && a.archiveEntryName == null) {
          return {
            archiveEntries: fl!.map(e => e.name),
            hint: 'multiple subtitle entries in this archive — call again with archiveEntryName to pick your episode',
          }
        }
        return sc.downloadResult ?? {
          stagedFileId: 'stub-staged-1', detectedScript: 'Hans',
          cueCount: 245, spanMinutes: 23.5, decodable: true, isHtml: false,
        }
      },
    }),
    install_subtitle: tool({
      description: 'Atomically install a staged subtitle next to the video (STUB: nothing written).',
      inputSchema: z.object({
        stagedFileId: z.string(), videoFilename: z.string(), langTag: z.string(),
        itemId: z.string().nullable().optional(),
      }),
      execute: async (a) => {
        rec('install_subtitle', a)
        return { ok: true, installedPath: `/media/x/${a.videoFilename}.${a.langTag}.srt` }
      },
    }),
    check_episode_code_safety: tool({
      description: 'Advisory: does a filename episode code match this season/episode?',
      inputSchema: z.object({ filename: z.string(), season: z.number(), episode: z.number() }),
      execute: async (a) => {
        rec('check_episode_code_safety', a)
        const want = `S${String(a.season).padStart(2, '0')}E${String(a.episode).padStart(2, '0')}`
        return { safe: a.filename.toUpperCase().includes(want), expectedCode: want }
      },
    }),
  }
  return { tools, calls }
}

async function runScenario(sc: Scenario, variant: 'v2.5' | 'pro') {
  const skill = makeFindSubtitleSkill('zh', 'off')
  const { tools, calls } = makeTools(sc)
  const docs = [skill]
  const instructions = [
    '## DRY-RUN MODE',
    'All write operations are stubbed — nothing is ever written to disk.',
    'Explain your reasoning as you go, then act.',
    '',
    skill.content,
    '',
    'Available skill documents:',
    systemPromptSkillIndex(docs),
  ].join('\n')

  const { agent, readFinalized } = makeReasoningAgent({
    model: makeModel(cfg(variant)),
    tools: { ...tools, read_doc: makeReadDocTool(docs) },
    instructions,
    schema: FinalizeSchema,
  })

  await agent.generate({ prompt: sc.prompt, abortSignal: AbortSignal.timeout(300_000) })
  const report = readFinalized() as Report

  console.log(`\n### [${variant}] ${sc.id}`)
  calls.forEach((c, i) => console.log(`  ${i + 1}. ${c.name} ${JSON.stringify(c.args)}`))
  console.log(`  → installed=${report.installed.length} no_match=${report.no_safe_match.length} retry=${report.retry_later?.length ?? 0}`)

  sc.check(calls, report)
  return { calls, report }
}

// ───────────────────────── 场景定义 ─────────────────────────

const TARGET = 'itemId: ep-1 | S01E01 | runtime ~24 min | file: Show.S01E01.1080p.mkv'

const S1_throttled: Scenario = {
  id: 'S1 限流/配额耗尽 → 必须 retry_later，不许 no_safe_match',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Show (2023)\ntargets (1 item):\n- ${TARGET}`,
  searchResult: () => ({
    result_set_id: 'rs-1', count: 0, preview: [],
    providerFailures: [
      { provider: 'assrt', reason: 'HTTP 429 rate limited, retry after 60s' },
      { provider: 'opensubtitles', reason: 'daily download quota exhausted, resets 00:00 UTC' },
    ],
  }),
  check: (calls, report) => {
    expect(calls.some(c => c.name === 'search_source')).toBe(true)
    // 核心：两个 provider 都没答上话 → 这不是"确实没有"
    expect(ids(report.retry_later)).toContain('ep-1')
    expect(ids(report.no_safe_match)).not.toContain('ep-1')
    expect(report.installed).toHaveLength(0)
  },
}

const S2_packOnly: Scenario = {
  id: 'S2 只有 season pack → 必须从 pack 里取，不许等"干净单集"',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Show (2023)\ntargets (1 item):\n- ${TARGET}`,
  searchResult: () => ({
    result_set_id: 'rs-1', count: 2,
    preview: [
      { id: 'assrt-900', name: 'Show 第一季 全12集 合集 简繁双语', videoname: 'Show', year: 2023 },
      { id: 'assrt-901', name: 'Show S01 Complete 繁中字幕包', videoname: 'Show', year: 2023 },
    ],
  }),
  candidateDetail: {
    id: 'assrt-900', name: 'Show 第一季 全12集 合集 简繁双语', videoname: 'Show', year: 2023,
    fileList: Array.from({ length: 12 }, (_, i) => ({
      index: i, name: `Show.S01E${String(i + 1).padStart(2, '0')}.chs.srt`,
    })),
  },
  check: (calls, report) => {
    const dl = calls.filter(c => c.name === 'download_candidate')
    expect(dl.length).toBeGreaterThan(0)
    // 从 12 集包里取 E01 有两条合法路径（真实工具都支持）：
    //   ① 一步到位：download_candidate 带 fileIndex: 0
    //   ② 二段式：先不带 → 工具返回 archiveEntries → 再带 archiveEntryName 选集
    // 不合法的是"传了 fileIndex:null / 省略，然后拿到 archiveEntries 却不二次选集就装"。
    const pickedByIndex = dl.some(c => c.args.fileIndex === 0)
    const pickedByEntry = dl.some(c => typeof c.args.archiveEntryName === 'string'
      && (c.args.archiveEntryName as string).toUpperCase().includes('S01E01'))
    expect(pickedByIndex || pickedByEntry).toBe(true)
    expect(report.installed.map(i => i.itemId)).toContain('ep-1')
  },
}

const S3_nameTrap: Scenario = {
  id: 'S3 同名不同剧（年份+产地标记不符）→ 必须拒装',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Peacemaker (2022)\nnative/original title: Peacemaker\ntargets (1 item):\n- itemId: ep-1 | S01E01 | runtime ~40 min | file: Peacemaker.S01E01.1080p.mkv`,
  searchResult: () => ({
    result_set_id: 'rs-1', count: 1,
    preview: [{
      id: 'assrt-777',
      name: '芬兰剧集 Rauhantekijä_Peacemaker (2020) 全8集 中文字幕',
      videoname: 'Rauhantekijä / Peacemaker', year: 2020, origin: 'Finland',
    }],
  }),
  candidateDetail: {
    id: 'assrt-777',
    name: '芬兰剧集 Rauhantekijä_Peacemaker (2020) 全8集 中文字幕',
    videoname: 'Rauhantekijä / Peacemaker', year: 2020, origin: 'Finland',
    // 结构上是个完美陷阱：8 集一一对应
    fileList: Array.from({ length: 8 }, (_, i) => ({
      index: i, name: `Peacemaker.S01E${String(i + 1).padStart(2, '0')}.chi.srt`,
    })),
  },
  check: (_calls, report) => {
    // 年份 2020≠2022 + 芬兰剧集标记 → 必须不装
    expect(report.installed).toHaveLength(0)
    expect(ids(report.no_safe_match)).toContain('ep-1')
  },
}

const S4_firstSearchEmpty: Scenario = {
  id: 'S4 首搜空但 provider 都答了 → 必须再搜（变体/系列级），不许立刻放弃',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Obscure Show (2019)\nnative/original title: 冷门剧\ntargets (1 item):\n- ${TARGET}`,
  searchResult: (n) => n === 1
    // 第一次：窄查询空，但没有 providerFailures（都答了，只是没货）
    ? { result_set_id: 'rs-1', count: 0, preview: [], providerFailures: [] }
    // 第二次以后：系列级查询有货
    : {
        result_set_id: 'rs-2', count: 1,
        preview: [{ id: 'assrt-555', name: '冷门剧 第一季 合集 简体', videoname: '冷门剧', year: 2019 }],
      },
  candidateDetail: {
    id: 'assrt-555', name: '冷门剧 第一季 合集 简体', videoname: '冷门剧', year: 2019,
    fileList: [{ index: 0, name: 'Show.S01E01.chs.srt' }],
  },
  check: (calls, _report) => {
    const searches = calls.filter(c => c.name === 'search_source')
    // 核心：一次空搜索不等于穷尽
    expect(searches.length).toBeGreaterThanOrEqual(2)
  },
}

const S5_absoluteEpisode: Scenario = {
  id: 'S5 pack 用绝对集号命名 → 必须用绝对集号定位',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Anime (2021)\ntargets (1 item):\n- itemId: ep-1 | S02E01 | absolute episode: 26 | runtime ~24 min | file: Anime.S02E01.1080p.mkv`,
  searchResult: () => ({
    result_set_id: 'rs-1', count: 1,
    preview: [{ id: 'assrt-333', name: 'Anime 全50集 合集 简体', videoname: 'Anime', year: 2021 }],
  }),
  candidateDetail: {
    id: 'assrt-333', name: 'Anime 全50集 合集 简体', videoname: 'Anime', year: 2021,
    // 只有绝对集号，没有 SxxExx
    fileList: Array.from({ length: 50 }, (_, i) => ({ index: i, name: `[Fansub] Anime - ${i + 1}.chs.ass` })),
  },
  check: (calls, report) => {
    const dl = calls.filter(c => c.name === 'download_candidate')
    expect(dl.length).toBeGreaterThan(0)
    // 关键是"有没有用绝对集号 26 定位"，而不是走哪条选集路径：
    //   ① fileIndex 25（0-based 的第 26 项）  ② archiveEntryName 里含 " 26"
    // 若它去拿 index 0 / 名字里是 1，就是把 S02E01 当成了全series第 1 集 → 装错集。
    const byIndex = dl.some(c => c.args.fileIndex === 25)
    const byEntry = dl.some(c => typeof c.args.archiveEntryName === 'string'
      && /(^|\D)26(\D|$)/.test(c.args.archiveEntryName as string))
    expect(byIndex || byEntry).toBe(true)
    expect(report.installed.map(i => i.itemId)).toContain('ep-1')
  },
}

const S6_structurallyWrong: Scenario = {
  id: 'S6 文件名完美但结构信号荒谬 → 必须信字节不信标签',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Show (2023)\ntargets (1 item):\n- ${TARGET}`,
  searchResult: () => ({
    result_set_id: 'rs-1', count: 1,
    preview: [{ id: 'assrt-111', name: 'Show.S01E01.简体中文.srt', videoname: 'Show', year: 2023 }],
  }),
  candidateDetail: {
    id: 'assrt-111', name: 'Show.S01E01.简体中文.srt', videoname: 'Show', year: 2023,
    fileList: [{ index: 0, name: 'Show.S01E01.chs.srt' }],
  },
  // 24 分钟的剧集，字幕只有 11 条 cue、跨度 2.5 分钟 → 荒谬
  downloadResult: {
    stagedFileId: 'stub-staged-1', detectedScript: 'Hans',
    cueCount: 11, spanMinutes: 2.5, decodable: true, isHtml: false,
  },
  check: (_calls, report) => {
    expect(report.installed).toHaveLength(0)
    expect(ids(report.no_safe_match)).toContain('ep-1')
  },
}

const S7_crossSeasonCollision: Scenario = {
  id: 'S7 跨季同名文件 → download/install 必须带 itemId 消歧',
  prompt: [
    'Find and install Chinese subtitles.',
    '',
    'title: Show (2023)',
    'NOTE: two targets below share the exact same file name — pass itemId to disambiguate.',
    'targets (2 items):',
    '- itemId: s1e1 | S01E01 | runtime ~24 min | dir: Season 01 | file: 01.mkv',
    '- itemId: s2e1 | S02E01 | runtime ~24 min | dir: Season 02 | file: 01.mkv',
  ].join('\n'),
  searchResult: () => ({
    result_set_id: 'rs-1', count: 1,
    preview: [{ id: 'assrt-222', name: 'Show S1+S2 合集 简体', videoname: 'Show', year: 2023 }],
  }),
  candidateDetail: {
    id: 'assrt-222', name: 'Show S1+S2 合集 简体', videoname: 'Show', year: 2023,
    fileList: [
      { index: 0, name: 'Show.S01E01.chs.srt' },
      { index: 1, name: 'Show.S02E01.chs.srt' },
    ],
  },
  check: (calls, _report) => {
    const writes = calls.filter(c => c.name === 'download_candidate' || c.name === 'install_subtitle')
    expect(writes.length).toBeGreaterThan(0)
    // 核心：同名冲突时每次写操作都必须带 itemId
    const missing = writes.filter(c => !c.args.itemId)
    expect(missing).toHaveLength(0)
  },
}

const S8_wrongLanguageInPack: Scenario = {
  id: 'S8 pack 里只有日文/英文轨 → 不许为"有个东西"装错语言',
  prompt: `Find and install a Chinese subtitle.\n\ntitle: Anime (2023)\ntargets (1 item):\n- ${TARGET}`,
  searchResult: () => ({
    result_set_id: 'rs-1', count: 1,
    preview: [{ id: 'assrt-444', name: 'Anime S01 字幕包', videoname: 'Anime', year: 2023 }],
  }),
  candidateDetail: {
    id: 'assrt-444', name: 'Anime S01 字幕包', videoname: 'Anime', year: 2023,
    // 整个 pack 一条中文都没有
    fileList: [
      { index: 0, name: 'Anime.S01E01.jpn.srt' },
      { index: 1, name: 'Anime.S01E01.eng.srt' },
    ],
  },
  downloadResult: {
    stagedFileId: 'stub-staged-1', detectedScript: 'Latn',
    cueCount: 240, spanMinutes: 23.5, decodable: true, isHtml: false,
  },
  check: (_calls, report) => {
    expect(report.installed).toHaveLength(0)
    expect(ids(report.no_safe_match)).toContain('ep-1')
  },
}

const SCENARIOS = [
  S1_throttled, S2_packOnly, S3_nameTrap, S4_firstSearchEmpty,
  S5_absoluteEpisode, S6_structurallyWrong, S7_crossSeasonCollision, S8_wrongLanguageInPack,
]

// ───────────────────────── 测试 ─────────────────────────

describe('findSubtitle agent 干测压测', () => {
  const skip = !process.env.LLM_BASE_URL || !process.env.LLM_API_KEY

  for (const sc of SCENARIOS) {
    describe(sc.id, () => {
      it.skipIf(skip)('mimo-v2.5', async () => { await runScenario(sc, 'v2.5') }, 330_000)
      it.skipIf(skip)('mimo-v2.5-pro', async () => { await runScenario(sc, 'pro') }, 330_000)
    })
  }
})
