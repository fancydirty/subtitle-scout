import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { ensureWorkspaceLayout } from '../translate/workspace/paths.js'
import { materializeAgentView } from '../translate/workspace/materialize.js'
import { makeTranslateWorkspaceTools, type TranslateToolDeps } from './translateWorker.tools.js'
import type { TranslateTask } from './translateWorker.schemas.js'
import type { WorkspacePaths } from '../translate/workspace/types.js'

const SAMPLE_SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'Hello Nico',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  'Goodbye',
  '',
].join('\n')

let base: string
let task: TranslateTask
let paths: WorkspacePaths

function baseDeps(over: Partial<TranslateToolDeps> = {}): TranslateToolDeps {
  return {
    task,
    paths,
    resolveDeps: {
      probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
      extract: async () => SAMPLE_SRT,
    },
    install: () => join(base, 'out.srt'),
    ...over,
  }
}

async function call(t: unknown, input: Record<string, unknown> = {}): Promise<any> {
  const tool = t as { execute: (args: any, opts: any) => Promise<any> }
  return tool.execute(input, { toolCallId: 't', messages: [], abortSignal: undefined as never })
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tw-tools-'))
  task = {
    jobId: 'job-1', videoPath: join(base, 'x.mkv'), itemId: 'tmdb:1/s1e1',
    originLang: 'en', title: 'Show', mediaRoot: base,
  }
  paths = ensureWorkspaceLayout(base, 'job-1')
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('translate workspace tools', () => {
  it('resolve_source writes canonical + meta.sourceRef and reports sourceLangName', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r = await call(tools.resolve_source)
    expect(r).toMatchObject({ status: 'ok', sourceLangName: '英文' })
    expect(r.sourceRef).toMatch(/embedded/)
    expect(readFileSync(paths.canonicalSourcePath, 'utf8')).toContain('Hello Nico')
  })

  it('resolve_source: ja origin with only eng embedded → fallback eng, canonical written', async () => {
    task.originLang = 'ja'
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r = await call(tools.resolve_source)
    expect(r.status).toBe('ok')
    expect(r.sourceRef).toMatch(/^fallback:embedded/)
    expect(existsSync(paths.canonicalSourcePath)).toBe(true)
  })

  it('read_workspace_doc rejects path escape outside jobRoot', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r = await call(tools.read_workspace_doc, { path: '../outside.txt' })
    expect(r).toHaveProperty('error')
    expect(String(r.error)).toMatch(/escapes|outside|whitelist/i)
  })

  it('freeze_glossary writes terms.json + FROZEN; second freeze fails closed', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r1 = await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    expect(r1).toMatchObject({ ok: true, count: 1 })
    expect(readFileSync(paths.glossaryPath, 'utf8')).toContain('妮可')
    expect(existsSync(paths.glossaryFrozenPath)).toBe(true)
    const r2 = await call(tools.freeze_glossary, { terms: [{ src: 'X', zh: '某' }] })
    expect(r2).toHaveProperty('error')
  })

  it('freeze_glossary rejects zh that is not Chinese; keepOriginal opt-out excluded from gate', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const bad = await call(tools.freeze_glossary, {
      terms: [{ src: 'Fulmer', zh: 'Fulmer', note: 'name' }],
    })
    expect(bad).toHaveProperty('error')
    expect(String(bad.error)).toMatch(/not Chinese|keepOriginal/)

    const ok = await call(tools.freeze_glossary, {
      terms: [
        { src: 'Fulmer', zh: '富尔默' },
        { src: 'ROV', zh: 'ROV', keepOriginal: true },
      ],
    })
    expect(ok).toMatchObject({ ok: true, count: 2, keepOriginal: 1 })

    // gate:keepOriginal 不计入 checks
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.update_row, { id: '1', tgt: '你好妮可', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    const gate = await call(tools.run_structural_gate)
    expect(gate.termChecks).toBe(0) // Fulmer/Nico 不在本批源文本;ROV 被排除
  })

  it('update_row cannot change src; tgt persists; list_rows reflects status', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    const bad = await call(tools.update_row, { id: '1', src: 'HACKED', tgt: '你好' } as any)
    expect(bad).toHaveProperty('error')
    const good = await call(tools.update_row, { id: '1', tgt: '你好', status: 'ok' })
    expect(good).toMatchObject({ ok: true })
    const listed = await call(tools.list_rows)
    const row1 = listed.rows.find((r: any) => r.id === '1')
    expect(row1).toMatchObject({ tgt: '你好', status: 'ok', src: 'Hello Nico' })
  })

  it('run_structural_gate fails on empty tgt, passes when filled + glossary conformant', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    const gateEmpty = await call(tools.run_structural_gate)
    expect(gateEmpty.verdict).toBe('fail')

    await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    await call(tools.update_row, { id: '1', tgt: '你好妮可', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    const gate = await call(tools.run_structural_gate)
    expect(gate.verdict).toBe('pass')
  })

  it('run_structural_gate fails on glossary drift (Nico translated wrong)', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    await call(tools.update_row, { id: '1', tgt: '你好尼古', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    const gate = await call(tools.run_structural_gate)
    expect(gate.verdict).toBe('fail')
  })

  it('merge_to_srt writes out/target.srt with canonical timing; install_sidecar invokes install', async () => {
    let installed: string | null = null
    const deps = baseDeps({
      install: (_vp, content) => { installed = content; return join(base, 'x.zh-Hans.srt') },
    })
    const tools = makeTranslateWorkspaceTools(deps)
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    await call(tools.update_row, { id: '1', tgt: '你好妮可', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    const m = await call(tools.merge_to_srt)
    expect(m).toMatchObject({ ok: true, cueCount: 2 })
    expect(readFileSync(paths.targetSrtPath, 'utf8')).toContain('00:00:01,000 --> 00:00:02,000')
    const gate = await call(tools.run_structural_gate)
    expect(gate.verdict).toBe('pass')
    const i = await call(tools.install_sidecar)
    expect(i).toMatchObject({ ok: true, sidecarPath: join(base, 'x.zh-Hans.srt') })
    expect(installed).toContain('你好妮可')
  })

  it('install_sidecar fails closed before merge (no target.srt)', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r = await call(tools.install_sidecar)
    expect(r).toHaveProperty('error')
  })

  it('C1: install_sidecar refuses without a gate pass even when target.srt exists', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.update_row, { id: '1', tgt: '你好妮可', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    await call(tools.merge_to_srt)
    // 无 freeze_glossary + 无 run_structural_gate → 拒绝
    const r = await call(tools.install_sidecar)
    expect(r).toHaveProperty('error')
    expect(String(r.error)).toMatch(/gate/i)
  })

  it('C1: row edit after gate pass invalidates install (stale marker)', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    await call(tools.update_row, { id: '1', tgt: '你好妮可', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    await call(tools.merge_to_srt)
    expect((await call(tools.run_structural_gate)).verdict).toBe('pass')
    await call(tools.update_row, { id: '2', tgt: '再会', status: 'ok' })
    const r = await call(tools.install_sidecar)
    expect(r).toHaveProperty('error')
  })

  it('tgt 净化:字面 \\n 转真换行;连续空行压单换行(不产生孤儿块)', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    const r = await call(tools.update_row, { id: '1', tgt: '第一行\\n第二行', status: 'ok' })
    expect(r.row.tgt).toBe('第一行\n第二行')
    const r2 = await call(tools.update_row, { id: '1', tgt: '上段\n\n\n下段', status: 'ok' })
    expect(r2.row.tgt).toBe('上段\n下段')
    // merge 后无无头块:全文每个块都必须含时轴
    await call(tools.update_row, { id: '2', tgt: '再见', status: 'ok' })
    await call(tools.merge_to_srt)
    const srt = readFileSync(paths.targetSrtPath, 'utf8')
    const blocks = srt.replace(/\r/g, '').split(/\n\n+/).filter(Boolean)
    expect(blocks.every((b) => b.includes('-->'))).toBe(true)
  })

  it('update_rows batch: all-or-nothing; bad id → nothing written', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    const bad = await call(tools.update_rows, { rows: [{ id: '1', tgt: '你好妮可' }, { id: '99', tgt: 'x' }] })
    expect(bad).toHaveProperty('error')
    expect((await call(tools.list_rows)).rows.every((r: any) => !r.tgt)).toBe(true)
    const good = await call(tools.update_rows, {
      rows: [
        { id: '1', tgt: '你好妮可', status: 'ok' },
        { id: '2', tgt: '再见', status: 'ok' },
      ],
    })
    expect(good).toMatchObject({ ok: true, count: 2 })
    expect((await call(tools.get_row, { id: '1' })).row).toMatchObject({ tgt: '你好妮可', status: 'ok' })
  })

  it('write_workspace_doc only allows .md under context/ or work/', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const ok = await call(tools.write_workspace_doc, { path: 'context/notes.md', content: '# 笔记' })
    expect(ok).toMatchObject({ ok: true })
    expect(readFileSync(join(paths.contextDir, 'notes.md'), 'utf8')).toContain('笔记')
    expect((await call(tools.write_workspace_doc, { path: 'canonical/evil.md', content: 'x' }))).toHaveProperty('error')
    expect((await call(tools.write_workspace_doc, { path: 'work/bilingual.jsonl', content: 'x' }))).toHaveProperty('error')
    expect((await call(tools.write_workspace_doc, { path: '../outside.md', content: 'x' }))).toHaveProperty('error')
  })

  it('already-covered: embedded zh text track or existing sidecar short-circuits resolve_source', async () => {
    const zhTrack = makeTranslateWorkspaceTools(baseDeps({
      resolveDeps: {
        probe: async () => [{ lang: 'chi', codec: 'subrip', isImageBased: false }],
        extract: async () => SAMPLE_SRT,
      },
    }))
    expect((await call(zhTrack.resolve_source)).status).toBe('already-covered')

    const sidecar = makeTranslateWorkspaceTools(baseDeps({
      readExistingChineseSidecar: () => join(base, 'x.zh-Hans.srt'),
    }))
    expect((await call(sidecar.resolve_source)).status).toBe('already-covered')
    expect(existsSync(paths.canonicalSourcePath)).toBe(false)
  })

  it('P2: freeze merges prior series glossary (prior wins), install persists merged terms', async () => {
    const saved: { key: string; terms: unknown[] }[] = []
    const deps = baseDeps({
      glossaryStore: {
        load: (key) => key === 'tmdb:1' ? [{ src: 'Nico', zh: '妮可', note: '官方' }] : [],
        save: (key, terms) => { saved.push({ key, terms }) },
      },
    })
    const tools = makeTranslateWorkspaceTools(deps)
    const r = await call(tools.freeze_glossary, {
      terms: [{ src: 'Nico', zh: '尼可' }, { src: 'Moi', zh: '莫伊' }],
    })
    expect(r).toMatchObject({ ok: true, count: 2, inherited: 1 })
    const merged = JSON.parse(readFileSync(paths.glossaryPath, 'utf8')) as { src: string; zh: string }[]
    expect(merged.find((t) => t.src === 'Nico')?.zh).toBe('妮可') // prior 胜,不被新值覆盖
    expect(merged.find((t) => t.src === 'Moi')?.zh).toBe('莫伊')  // 新术语补入

    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.update_rows, { rows: [{ id: '1', tgt: '你好妮可', status: 'ok' }, { id: '2', tgt: '再见', status: 'ok' }] })
    await call(tools.merge_to_srt)
    expect((await call(tools.run_structural_gate)).verdict).toBe('pass')
    const i = await call(tools.install_sidecar)
    expect(i).toMatchObject({ ok: true })
    expect(saved).toHaveLength(1)
    expect(saved[0].key).toBe('tmdb:1')
    expect(saved[0].terms).toHaveLength(2)
  })

  it('run_structural_gate: 检测行错位(possibleRowShift)——奥本海默实案:译文整体偏移', async () => {
    // 实案形状:6 行源,模型把 src3-6 的译文写进 tgt1-4(前两行源被合并吞掉,整体偏移 -2)
    const srt = [
      '1', '00:00:01,000 --> 00:00:02,000', 'Alpha one.', '',
      '2', '00:00:03,000 --> 00:00:04,000', 'Bravo two.', '',
      '3', '00:00:05,000 --> 00:00:06,000', 'Charlie three.', '',
      '4', '00:00:07,000 --> 00:00:08,000', 'Delta four.', '',
      '5', '00:00:09,000 --> 00:00:10,000', 'Echo five.', '',
      '6', '00:00:11,000 --> 00:00:12,000', 'Foxtrot six.', '',
    ].join('\n')
    const tools = makeTranslateWorkspaceTools(baseDeps({
      resolveDeps: {
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract: async () => srt,
      },
    }))
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.freeze_glossary, {
      terms: [
        { src: 'Charlie', zh: '查理' },
        { src: 'Delta', zh: '德尔塔' },
        { src: 'Echo', zh: '回声' },
        { src: 'Foxtrot', zh: '狐步' },
      ],
    })
    // tgt1-4 = src3-6 的译文(偏移);tgt5-6 = 乱写
    await call(tools.update_rows, {
      rows: [
        { id: '1', tgt: '查理三号。', status: 'ok' },
        { id: '2', tgt: '德尔塔四号。', status: 'ok' },
        { id: '3', tgt: '回声五号。', status: 'ok' },
        { id: '4', tgt: '狐步六号。', status: 'ok' },
        { id: '5', tgt: '无关内容甲。', status: 'ok' },
        { id: '6', tgt: '无关内容乙。', status: 'ok' },
      ],
    })
    const gate = await call(tools.run_structural_gate)
    expect(gate.verdict).toBe('fail')
    expect(gate.possibleRowShift).toBeDefined()
    expect(gate.possibleRowShift.delta).toBe(-2)
    expect(gate.possibleRowShift.votes).toBeGreaterThanOrEqual(3)
    expect(gate.reasons.join(' ')).toMatch(/row shift|wrong row ids/)
  })

  it('P2.2a: run_structural_gate fails on unbalanced 《》「」【】', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    await call(tools.update_row, { id: '1', tgt: '《呼……总算糊弄过去了', status: 'ok' })
    await call(tools.update_row, { id: '2', tgt: '正常对白', status: 'ok' })
    const gate = await call(tools.run_structural_gate)
    expect(gate.verdict).toBe('fail')
    expect(gate.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/bracket|括号|《》/i)]))
  })

  it('get_window returns clean cues without timing', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps())
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    const w = await call(tools.get_window, { centerId: '1', radius: 1 })
    expect(w.cues).toHaveLength(2)
    expect(JSON.stringify(w.cues)).not.toMatch(/-->/)
    expect(w.cues[0]).toMatchObject({ id: '1', text: 'Hello Nico' })
  })
})
