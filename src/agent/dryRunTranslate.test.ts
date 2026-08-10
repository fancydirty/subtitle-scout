/**
 * 翻译 agent 干测压测（第 5.5 步第 3 项，续）
 *
 * 不产生副作用：resolve/merge/install 全是桩，磁盘零写入。
 * 桩复刻真实工具的 fail-closed 闸门（见 translateWorker.tools.ts）：
 *   ① install_sidecar 要求 out/target.srt 已存在（先 merge_to_srt）
 *   ② install_sidecar 要求 gate-pass 标记有效，且标记后未再编辑行
 *   ③ freeze_glossary 只能冻结一次
 * 上一轮教训：桩不像真实工具时，测出来的"agent 错误"其实是测试自己的错误。
 *
 * 场景（T1-T3 覆盖本轮刚补进 prompt 的 4 个工具）：
 *   T1 正常英语剧集 → 完整流程 + 用不用 fetch_tmdb_context/fetch_series_target_subs/list_rows
 *   T2 闸门失败带 violations → 必须进修复循环，不许直接 held
 *   T3 日漫无日文源 → 必须 no-source（R18 禁英文兜底），不许抽英轨
 *   T4 已有中文字幕 → already-covered，不该白翻一遍
 *   T5 装盘顺序 → 不许跳过 merge/gate 直接 install
 */

import { describe, it, expect } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { makeModel, type LlmConfig } from './llm.js'
import { makeReasoningAgent } from './reasoningAgent.js'
import { translateSkill } from './skills/translateSkill.js'
import { makeReadDocTool, systemPromptSkillIndex } from './skills/registry.js'

function cfg(variant: 'v2.5' | 'pro'): LlmConfig {
  return {
    baseUrl: process.env.LLM_BASE_URL!,
    apiKey: process.env.LLM_API_KEY!,
    model: variant === 'v2.5' ? 'mimo-v2.5' : 'mimo-v2.5-pro',
  }
}

interface ToolCall { name: string; args: Record<string, unknown> }

interface Report {
  status: 'installed' | 'held' | 'no-source' | 'extract-failed' | 'probe-failed' | 'already-covered'
  reason?: string | null
  sourceRef?: string | null
  sidecarPath?: string | null
}

const TranslateFinalize = z.object({
  status: z.enum(['installed', 'held', 'no-source', 'extract-failed', 'probe-failed', 'already-covered']),
  reason: z.string().nullable().optional(),
  sourceRef: z.string().nullable().optional(),
  sidecarPath: z.string().nullable().optional(),
})

interface Scenario {
  id: string
  prompt: string
  /** resolve_source 返回什么（决定有无源、什么语言） */
  resolve: unknown
  /** 行数（materialize 后的 pending 行数） */
  rowCount?: number
  /** 结构闸门第 n 次调用返回什么——用来造"先失败后通过"的修复循环 */
  gate?: (nth: number) => unknown
  /** resolve 前是否已有中文字幕 */
  alreadyCovered?: boolean
  check: (calls: ToolCall[], report: Report) => void
}

function makeTools(sc: Scenario) {
  const calls: ToolCall[] = []
  const rec = (n: string, a: Record<string, unknown>) => { calls.push({ name: n, args: a }) }

  // 复刻真实工具的状态机
  let resolved = false
  let materialized = false
  let frozen = false
  let merged = false
  let gateCalls = 0
  let gatePassed = false
  let rowsEditedSinceGate = false
  const rowCount = sc.rowCount ?? 6
  const rows = new Map<string, { tgt: string; status: string }>()
  for (let i = 1; i <= rowCount; i++) rows.set(String(i), { tgt: '', status: 'pending' })

  const tools = {
    resolve_source: tool({
      description: 'Resolve the single-hop source subtitle (origin-language only). Writes canonical/source.srt.',
      inputSchema: z.object({}),
      execute: async () => {
        rec('resolve_source', {})
        if (sc.alreadyCovered) return { status: 'already-covered', reason: 'Chinese sidecar already exists' }
        resolved = true
        return sc.resolve
      },
    }),
    materialize_agent_view: tool({
      description: 'Build agent_view/source_clean.jsonl + pending bilingual rows.',
      inputSchema: z.object({}),
      execute: async () => {
        rec('materialize_agent_view', {})
        if (!resolved) return { error: 'no canonical source — run resolve_source first' }
        materialized = true
        return { ok: true, rows: rowCount }
      },
    }),
    fetch_tmdb_context: tool({
      description: 'Fetch TMDB synopsis/cast into context/tmdb.md.',
      inputSchema: z.object({}),
      execute: async () => { rec('fetch_tmdb_context', {}); return { ok: true, path: 'context/tmdb.md', chars: 800 } },
    }),
    fetch_series_target_subs: tool({
      description: 'Fetch same-series existing Chinese subtitle excerpts into context/.',
      inputSchema: z.object({}),
      execute: async () => { rec('fetch_series_target_subs', {}); return { ok: true, files: 1, excerptChars: 1200 } },
    }),
    read_workspace_doc: tool({
      description: 'Read a document inside this job workspace.',
      inputSchema: z.object({
        path: z.string(), offset: z.number().optional(), limit: z.number().optional(),
      }),
      execute: async (a) => {
        rec('read_workspace_doc', a)
        return { path: a.path, totalLines: 20, offset: 0, lines: ['(stub content)'] }
      },
    }),
    freeze_glossary: tool({
      description: 'Freeze the termbase. Can only be done ONCE per job.',
      inputSchema: z.object({
        terms: z.array(z.object({
          src: z.string(), zh: z.string(),
          note: z.string().optional(), keepOriginal: z.boolean().optional(),
        })),
      }),
      execute: async (a) => {
        rec('freeze_glossary', a)
        if (frozen) return { error: 'glossary is already frozen for this job' }
        frozen = true
        return { ok: true, terms: a.terms.length }
      },
    }),
    lookup_glossary: tool({
      description: 'Look up one frozen term.',
      inputSchema: z.object({ term: z.string() }),
      execute: async (a) => { rec('lookup_glossary', a); return { term: a.term, zh: '(stub)' } },
    }),
    list_rows: tool({
      description: 'List bilingual table rows (id/src/tgt/status), optionally filtered by status.',
      inputSchema: z.object({
        status: z.enum(['pending', 'draft', 'ok', 'needs_review', 'failed']).optional(),
        offset: z.number().optional(), limit: z.number().optional(),
      }),
      execute: async (a) => {
        rec('list_rows', a)
        const all = [...rows.entries()].map(([id, r]) => ({ id, src: `line ${id}`, ...r }))
        const filtered = a.status ? all.filter(r => r.status === a.status) : all
        return { total: filtered.length, offset: 0, rows: filtered }
      },
    }),
    get_window: tool({
      description: 'Read a window of cleaned cues around centerId.',
      inputSchema: z.object({ centerId: z.string(), radius: z.number().optional() }),
      execute: async (a) => {
        rec('get_window', a)
        return { centerId: a.centerId, range: ['1', String(rowCount)], cues: [{ id: a.centerId, text: 'stub line' }] }
      },
    }),
    update_row: tool({
      description: 'Write tgt/status for ONE bilingual row.',
      inputSchema: z.object({
        id: z.string(), tgt: z.string().optional(),
        status: z.enum(['pending', 'draft', 'ok', 'needs_review', 'failed']).optional(),
        notes: z.string().optional(),
      }),
      execute: async (a) => {
        rec('update_row', a)
        const r = rows.get(a.id)
        if (!r) return { error: `no bilingual row with id=${a.id}` }
        if (a.tgt != null) r.tgt = a.tgt
        if (a.status) r.status = a.status
        if (gatePassed) rowsEditedSinceGate = true   // 复刻 stale-marker 语义
        return { ok: true, row: { id: a.id, ...r } }
      },
    }),
    update_rows: tool({
      description: 'Batch write rows (all-or-nothing).',
      inputSchema: z.object({
        rows: z.array(z.object({
          id: z.string(), tgt: z.string().optional(),
          status: z.enum(['pending', 'draft', 'ok', 'needs_review', 'failed']).optional(),
          notes: z.string().optional(),
        })),
      }),
      execute: async (a) => {
        rec('update_rows', a)
        for (const p of a.rows) if (!rows.has(p.id)) return { error: `no bilingual row with id=${p.id}` }
        for (const p of a.rows) {
          const r = rows.get(p.id)!
          if (p.tgt != null) r.tgt = p.tgt
          if (p.status) r.status = p.status
        }
        if (gatePassed) rowsEditedSinceGate = true
        return { ok: true, count: a.rows.length }
      },
    }),
    update_summary: tool({
      description: 'Overwrite work/summary.md with a short rolling summary.',
      inputSchema: z.object({ content: z.string() }),
      execute: async (a) => { rec('update_summary', a); return { ok: true, chars: a.content.length } },
    }),
    run_critic: tool({
      description: 'Optional LLM-based quality critique over a row range.',
      inputSchema: z.object({ fromId: z.string().optional(), toId: z.string().optional() }),
      execute: async (a) => { rec('run_critic', a); return { ok: true, notes: [] } },
    }),
    run_structural_gate: tool({
      description: 'Term conformance + empty tgt + count checks over the bilingual table.',
      inputSchema: z.object({}),
      execute: async () => {
        rec('run_structural_gate', {})
        gateCalls++
        const res = sc.gate
          ? sc.gate(gateCalls)
          : { verdict: 'PASS', reasons: [] }
        const passed = (res as { verdict?: string }).verdict === 'PASS'
        if (passed) { gatePassed = true; rowsEditedSinceGate = false }
        return res
      },
    }),
    merge_to_srt: tool({
      description: 'Deterministic merge of canonical timings + bilingual tgt into out/target.srt.',
      inputSchema: z.object({}),
      execute: async () => {
        rec('merge_to_srt', {})
        if (!materialized) return { error: 'nothing to merge — run materialize_agent_view first' }
        const empty = [...rows.values()].filter(r => !r.tgt).length
        if (empty > 0) return { error: `${empty} row(s) still have empty tgt` }
        merged = true
        return { ok: true, path: 'out/target.srt', cues: rowCount }
      },
    }),
    install_sidecar: tool({
      description: 'Install out/target.srt next to the video (STUB: nothing written).',
      inputSchema: z.object({}),
      execute: async () => {
        rec('install_sidecar', {})
        // 复刻真实的两道硬门（translateWorker.tools.ts install_sidecar）
        if (!merged) return { error: 'out/target.srt missing — run merge_to_srt first' }
        if (!gatePassed || rowsEditedSinceGate) {
          return { error: 'no valid structural-gate pass for the current bilingual table — run run_structural_gate and do not edit rows afterwards' }
        }
        return { ok: true, sidecarPath: '/media/x/video.zh-Hans.srt' }
      },
    }),
  }
  return { tools, calls }
}

async function run(sc: Scenario, variant: 'v2.5' | 'pro') {
  const { tools, calls } = makeTools(sc)
  const docs = [translateSkill]
  const instructions = [
    '## DRY-RUN MODE',
    'All write operations are stubbed — nothing is ever written to disk.',
    'Explain your reasoning as you go, then act.',
    '',
    'You are the translation clerk for exactly ONE video file.',
    '',
    translateSkill.content,
    '',
    'Available skill documents:',
    systemPromptSkillIndex(docs),
  ].join('\n')

  const { agent, readFinalized } = makeReasoningAgent({
    model: makeModel(cfg(variant)),
    tools: { ...tools, read_doc: makeReadDocTool(docs) },
    instructions,
    schema: TranslateFinalize,
  })

  await agent.generate({ prompt: sc.prompt, abortSignal: AbortSignal.timeout(300_000) })
  const report = readFinalized() as Report

  console.log(`\n### [${variant}] ${sc.id}`)
  calls.forEach((c, i) => {
    const a = JSON.stringify(c.args)
    console.log(`  ${i + 1}. ${c.name}${a === '{}' ? '' : ' ' + (a.length > 110 ? a.slice(0, 110) + '…' : a)}`)
  })
  console.log(`  → status=${report.status} reason=${(report.reason ?? '').slice(0, 90)}`)

  sc.check(calls, report)
  return { calls, report }
}

// ───────────────────────── 场景 ─────────────────────────

const T1_normal: Scenario = {
  id: 'T1 英语剧集正常翻译 → 完整流程（含刚补进 prompt 的 context/list_rows 工具）',
  prompt: [
    'Translate this episode into Simplified Chinese.',
    '',
    'videoPath: /media/Show/S01E01.mkv',
    'itemId: tmdb:100/s1e1',
    'title: Show',
    'origin_lang: en',
    'runtime: ~24 min',
  ].join('\n'),
  resolve: { status: 'ok', sourceRef: 'embedded:s:2', sourceLangName: '英文', cues: 6 },
  rowCount: 6,
  check: (calls, report) => {
    const n = calls.map(c => c.name)
    // 必经流程
    expect(n).toContain('resolve_source')
    expect(n).toContain('materialize_agent_view')
    expect(n).toContain('freeze_glossary')
    expect(n).toContain('run_structural_gate')
    expect(n).toContain('merge_to_srt')
    expect(n).toContain('install_sidecar')
    // 顺序：冻结术语表必须在批量写行之前
    const froze = n.indexOf('freeze_glossary')
    const firstWrite = Math.min(
      ...['update_row', 'update_rows'].map(t => (n.indexOf(t) === -1 ? Infinity : n.indexOf(t))),
    )
    expect(froze).toBeLessThan(firstWrite)
    // 装盘必须在 merge 与 gate 之后
    expect(n.indexOf('install_sidecar')).toBeGreaterThan(n.indexOf('merge_to_srt'))
    expect(n.indexOf('merge_to_srt')).toBeGreaterThan(n.indexOf('run_structural_gate'))
    expect(report.status).toBe('installed')
  },
}

const T2_gateRepair: Scenario = {
  id: 'T2 闸门报术语漂移 → 必须修复重跑，不许直接 held',
  prompt: [
    'Translate this episode into Simplified Chinese.',
    '',
    'videoPath: /media/Show/S01E02.mkv',
    'itemId: tmdb:100/s1e2',
    'title: Show',
    'origin_lang: en',
    'runtime: ~24 min',
  ].join('\n'),
  resolve: { status: 'ok', sourceRef: 'embedded:s:2', sourceLangName: '英文', cues: 5 },
  rowCount: 5,
  // 第一次闸门失败（点名 term + 出错的 cue id），第二次以后通过
  gate: (nth) => nth === 1
    ? {
        verdict: 'FAIL',
        reasons: ['term conformance below threshold'],
        violations: [{ term: 'Pictor', expectZh: '皮克托', missAtCues: ['2', '4'] }],
      }
    : { verdict: 'PASS', reasons: [] },
  check: (calls, report) => {
    const n = calls.map(c => c.name)
    const gates = n.filter(x => x === 'run_structural_gate').length
    // 核心：闸门失败后必须修 + 重跑，而不是直接 held
    expect(gates).toBeGreaterThanOrEqual(2)
    const firstGate = n.indexOf('run_structural_gate')
    const editedAfterFail = n.slice(firstGate + 1).some(x => x === 'update_row' || x === 'update_rows')
    expect(editedAfterFail).toBe(true)
    expect(report.status).toBe('installed')
  },
}

const T3_jaNoSource: Scenario = {
  id: 'T3 日漫无日文源 → 必须 no-source（R18 禁英文兜底）',
  prompt: [
    'Translate this episode into Simplified Chinese.',
    '',
    'videoPath: /media/Anime/S01E01.mkv',
    'itemId: tmdb:200/s1e1',
    'title: Anime',
    'origin_lang: ja',
    'runtime: ~24 min',
    '',
    'NOTE: the video carries an English embedded subtitle track, but no Japanese one.',
  ].join('\n'),
  resolve: {
    status: 'no-source',
    reason: 'origin_lang=ja: no Japanese source (jimaku/embedded ja) — single-hop only, English relay is forbidden',
  },
  check: (calls, report) => {
    const n = calls.map(c => c.name)
    expect(n).toContain('resolve_source')
    // 不许绕过 resolve 自己去翻英轨
    expect(n).not.toContain('install_sidecar')
    expect(report.status).toBe('no-source')
  },
}

const T4_alreadyCovered: Scenario = {
  id: 'T4 已有中文字幕 → already-covered，不该白翻一遍',
  prompt: [
    'Translate this episode into Simplified Chinese.',
    '',
    'videoPath: /media/Show/S01E03.mkv',
    'itemId: tmdb:100/s1e3',
    'title: Show',
    'origin_lang: en',
    'runtime: ~24 min',
  ].join('\n'),
  alreadyCovered: true,
  resolve: { status: 'already-covered', reason: 'Chinese sidecar already exists' },
  check: (calls, report) => {
    const n = calls.map(c => c.name)
    expect(n).toContain('resolve_source')
    // 已覆盖就该收工，不该继续冻结术语表/翻行/装盘
    expect(n).not.toContain('install_sidecar')
    expect(n).not.toContain('freeze_glossary')
    expect(report.status).toBe('already-covered')
  },
}

const T5_installOrder: Scenario = {
  id: 'T5 装盘闸门 → 跳过 merge/gate 会被拒，必须补齐顺序',
  prompt: [
    'Translate this episode into Simplified Chinese.',
    '',
    'videoPath: /media/Show/S01E04.mkv',
    'itemId: tmdb:100/s1e4',
    'title: Show',
    'origin_lang: en',
    'runtime: ~24 min',
    '',
    'Work efficiently: install the finished subtitle as soon as you can.',
  ].join('\n'),
  resolve: { status: 'ok', sourceRef: 'embedded:s:2', sourceLangName: '英文', cues: 4 },
  rowCount: 4,
  check: (calls, report) => {
    const n = calls.map(c => c.name)
    // 无论中间被拒几次，最终成功的装盘必须在 merge + gate 之后
    if (report.status === 'installed') {
      const lastInstall = n.lastIndexOf('install_sidecar')
      expect(n.lastIndexOf('merge_to_srt')).toBeLessThan(lastInstall)
      expect(n.lastIndexOf('run_structural_gate')).toBeLessThan(lastInstall)
    }
    // 且绝不能在没 merge 的情况下报 installed
    if (report.status === 'installed') expect(n).toContain('merge_to_srt')
  },
}

const SCENARIOS = [T1_normal, T2_gateRepair, T3_jaNoSource, T4_alreadyCovered, T5_installOrder]

describe('translate agent 干测压测', () => {
  const skip = !process.env.LLM_BASE_URL || !process.env.LLM_API_KEY
  for (const sc of SCENARIOS) {
    describe(sc.id, () => {
      it.skipIf(skip)('mimo-v2.5', async () => { await run(sc, 'v2.5') }, 330_000)
      it.skipIf(skip)('mimo-v2.5-pro', async () => { await run(sc, 'pro') }, 330_000)
    })
  }
})
