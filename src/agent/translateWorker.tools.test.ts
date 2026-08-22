import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { ensureWorkspaceLayout } from '../translate/workspace/paths.js'
// 2026-08-13 清理：materializeAgentView 的 import 已删（本文件零调用）。该函数活着，且
// 被 translateWorker.tools.ts:208 在生产路径上调用——覆盖它的是 materialize.test.ts 与
// merge.test.ts 两个文件，不是这里。本文件测的是工具层的读写契约，不直接建 agent 视图。
import { makeTranslateWorkspaceTools, type TranslateToolDeps } from './translateWorker.tools.js'
import type { TranslateTask } from './translateWorker.schemas.js'
import type { WorkspacePaths } from '../translate/workspace/types.js'
// C20 红线用真实的形态构造器现造 itemId（不写死一个恰好可解的字面量——写死的话，
// 生产形态退化成裸路径的那天这些用例照样绿）。
import { translateItemId } from '../v2/ownIds.js'

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
    // 历史默认目标 = zh（target_languages 未设置时的 parseTargetLanguages 缺省）。
    // F2 用例按场景覆写。
    originLang: 'en', targetLanguage: 'zh', title: 'Show', mediaRoot: base,
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

  // R7-8 修复：meta.json 走 tmp+rename（撕裂的 meta.json 会让 resolve_source 每次都抛，workspace
  // 永久砖化）。这条测试用文件系统语义区分两种写法：rename 覆盖只只只需目录可写，裸 writeFileSync
  // 写只读文件会 EACCES——所以"只读的旧 meta.json 能被成功覆盖"就是原子写的实证。
  it('resolve_source 原子覆盖只读的旧 meta.json（tmp+rename，不是裸 writeFileSync）', async () => {
    if (process.getuid?.() === 0) return // root 无视 mode 位，这条区分在 root 下失效
    writeFileSync(paths.metaPath, JSON.stringify({ stale: true }), { mode: 0o444 })
    chmodSync(paths.metaPath, 0o444)

    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r = await call(tools.resolve_source)

    expect(r.status).toBe('ok')
    expect(JSON.parse(readFileSync(paths.metaPath, 'utf8'))).toMatchObject({ itemId: 'tmdb:1/s1e1' })
    // 写完不留 tmp 垃圾
    expect(readdirSync(paths.jobRoot).filter(n => n.includes('.tmp'))).toEqual([])
  })

  // R18(2026-08-08 废止 2026-07-24 的 eng 兜底裁决):这条原先断言"ja + 只有 eng 轨 → fallback eng
  // + canonical 已写"。现在改为断言反面,并且**canonical 必须没被写出来**——只查 status 会漏掉
  // "先落了一份英文 canonical 再返回 no-source"这种留垃圾的实现。
  it('R18: ja origin with only eng embedded → no-source, canonical NOT written', async () => {
    task.originLang = 'ja'
    const tools = makeTranslateWorkspaceTools(baseDeps())
    const r = await call(tools.resolve_source)
    expect(r.status).toBe('no-source')
    expect(String(r.reason)).not.toMatch(/fallback|兜底/i)
    expect(existsSync(paths.canonicalSourcePath)).toBe(false)
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

  it('E02 实案:freeze 拒绝子串矛盾词条(Komeran→轩兰 ⊂ Arashi Komeran→岚科美兰),合法昵称豁免', async () => {
    const tools = makeTranslateWorkspaceTools(baseDeps({
      glossaryStore: {
        load: () => [{ src: 'Arashi Komeran', zh: '岚科美兰' }],
        save: () => {},
      },
    }))
    // fresh 加矛盾短词条(模型在 E02 生产的真实行为)
    const bad = await call(tools.freeze_glossary, {
      terms: [
        { src: 'Komeran', zh: '轩兰' },
        { src: 'Nico', zh: '妮可' },
      ],
    })
    expect(bad).toHaveProperty('error')
    expect(String(bad.error)).toMatch(/contradictory|conflict/i)

    // 合法昵称:short.zh ⊆ long.zh(Gon→小杰 / adult Gon→成年小杰)
    const paths2 = ensureWorkspaceLayout(mkdtempSync(join(tmpdir(), 'tw-tools-ok-')), 'job-ok')
    const tools2 = makeTranslateWorkspaceTools({ ...baseDeps(), paths: paths2 })
    const ok = await call(tools2.freeze_glossary, {
      terms: [
        { src: 'Gon', zh: '小杰' },
        { src: 'adult Gon', zh: '成年小杰' },
      ],
    })
    expect(ok).toMatchObject({ ok: true })
  })

  it('freeze_glossary rejects zh that is not Chinese; keepOriginal opt-out excluded from gate', async () => {    const tools = makeTranslateWorkspaceTools(baseDeps())
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
    // get_row 已删（第 5.5 步第 2 项），用 get_window 验证同样结果
    expect((await call(tools.get_window, { centerId: '1', radius: 0 })).centerId).toBe('1')
  })

  // write_workspace_doc 测试已删（第 5.5 步第 2 项）

  // 回归锁（F2 改造后 zh 时代行为不变）：zh 目标下 embedded 中文轨 / 盘上 zh sidecar
  // 仍然短路。deps 形状已改 readExistingSidecar(v, tags)（tags 由调用方组好传入）。
  it('already-covered 回归:zh 目标 + embedded 中文轨或 zh sidecar → 短路 resolve_source', async () => {
    const zhTrack = makeTranslateWorkspaceTools(baseDeps({
      resolveDeps: {
        probe: async () => [{ lang: 'chi', codec: 'subrip', isImageBased: false }],
        extract: async () => SAMPLE_SRT,
      },
    }))
    expect((await call(zhTrack.resolve_source)).status).toBe('already-covered')

    const sidecar = makeTranslateWorkspaceTools(baseDeps({
      resolveDeps: { probe: async () => [], extract: async () => SAMPLE_SRT },
      readExistingSidecar: (_v, tags) => tags.includes('zh-Hans') ? join(base, 'x.zh-Hans.srt') : null,
    }))
    expect((await call(sidecar.resolve_source)).status).toBe('already-covered')
    expect(existsSync(paths.canonicalSourcePath)).toBe(false)
  })

  // ── F2（2026-08-18 生产实案，spec §4.3）：already-covered 必须按目标语言判定 ──────
  //
  // DxD ep01：用户目标语言切 en，盘上有旧中文时代的 zh-Hans sidecar。旧实现（embedded
  // 检查写死 zh/chi/zho/chs/cht 前缀、sidecar 检查只认中文 tags）对着 en 目标说"已有中文
  // 覆盖"——与目标无关的答案，且配合每日目标语言扫描确认不了覆盖，引发永久日循环的僵尸
  // 卡片。already-covered 的语义必须是「**目标语言**已覆盖」，硬编码中文是 zh-only 时代
  // 的遗产。
  describe('F2: resolve_source already-covered 按目标语言判定', () => {
    // 盘上 sidecar 桩：模拟 findExternalSidecar(v, tags) 的契约——只认被问到的那份 tags
    // （en 目标只会问到 ['en','eng']，zh 目标问到 zh-Hans 等），模拟"盘上实际有什么"。
    const diskWith = (present: string[]) => (_v: string, tags: string[]) =>
      tags.find((t) => present.includes(t)) ? join(base, `x.${present[0]}.srt`) : null

    it('en 目标 + 盘上只有 zh sidecar → 不短路 already-covered（DxD 实案），继续走找源路径', async () => {
      task.targetLanguage = 'en'
      task.originLang = 'ja'
      const tools = makeTranslateWorkspaceTools(baseDeps({
        resolveDeps: {
          probe: async () => [{ lang: 'jpn', codec: 'subrip', isImageBased: false }],
          extract: async () => SAMPLE_SRT,
        },
        readExistingSidecar: diskWith(['zh-Hans']),
      }))
      const r = await call(tools.resolve_source)
      expect(r.status).not.toBe('already-covered')
      // 继续走完找源：单跳抽日文内嵌轨成功 → ok（而不是被"已有中文"挡回去重领）
      expect(r.status).toBe('ok')
    })

    it('en 目标 + en sidecar → already-covered 短路，reason 提到目标语言', async () => {
      task.targetLanguage = 'en'
      const tools = makeTranslateWorkspaceTools(baseDeps({
        resolveDeps: { probe: async () => [], extract: async () => SAMPLE_SRT },
        readExistingSidecar: diskWith(['en']),
      }))
      const r = await call(tools.resolve_source)
      expect(r.status).toBe('already-covered')
      expect(String(r.reason)).toMatch(/en/)
      expect(existsSync(paths.canonicalSourcePath)).toBe(false)
    })

    it('zh 目标 + zh sidecar → already-covered（回归不变）', async () => {
      const tools = makeTranslateWorkspaceTools(baseDeps({
        resolveDeps: { probe: async () => [], extract: async () => SAMPLE_SRT },
        readExistingSidecar: diskWith(['zh-Hans']),
      }))
      expect((await call(tools.resolve_source)).status).toBe('already-covered')
    })

    it('embedded：en 目标 + embedded eng 文本轨 → already-covered，reason 提到目标语言', async () => {
      task.targetLanguage = 'en'
      // baseDeps 默认 probe 即 eng 文本轨
      const tools = makeTranslateWorkspaceTools(baseDeps())
      const r = await call(tools.resolve_source)
      expect(r.status).toBe('already-covered')
      expect(String(r.reason)).toMatch(/en/)
    })

    it('embedded：en 目标 + embedded jpn 轨 → 不短路（源语言轨不构成目标语言覆盖）', async () => {
      task.targetLanguage = 'en'
      const tools = makeTranslateWorkspaceTools(baseDeps({
        resolveDeps: {
          probe: async () => [{ lang: 'jpn', codec: 'subrip', isImageBased: false }],
          extract: async () => SAMPLE_SRT,
        },
      }))
      const r = await call(tools.resolve_source)
      expect(r.status).not.toBe('already-covered')
    })
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

  // ───────────────────────────────────────────────────────────────────────────
  // C20 红线：itemId 换成新架构形态（work_id + file）后，这两个工具仍必须把同剧两集
  // 归到**同一个** glossary key。
  //
  // 为什么这条要放在这里、而不是只有 ownIds.test.ts 那份：那份验的是"形态本身可解"，
  // 走的是 ownIds 自己的 workIdFromTranslateItemId 与 glossaryRepo 的 seriesKeyOf。
  // 而真正会退化的是**这两个工具里的那两行**（tools.ts:346 load / :663 save）——
  // 它们是 C20 点名的隐藏消费者。只有让真实的 freeze_glossary / install_sidecar 跑一遍、
  // 观察它们实际请求/写入的 key，才能证明"术语表跨集继承"这件事真的成立。
  //
  // 上一条（P2）用的是旧世界形态 `tmdb:1/s1e1`，它在 seriesKeyOf 下当然可解——
  // 所以它**不能**充当 C20 的守卫者：itemId 改成裸路径的那天它照样绿（因为它自己就写死了
  // 一个 tmdb: 开头的 itemId）。这条则用 translateItemId 现造，形态一退化立刻红。
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴🔴 C20: 新架构 itemId（work_id+file）下同剧两集共享同一 glossary key（真实工具路径）', async () => {
    const workId = 'tmdb:1'
    const loadedKeys: string[] = []
    const savedKeys: string[] = []
    const store = {
      load: (key: string) => { loadedKeys.push(key); return [{ src: 'Nico', zh: '妮可' }] },
      save: (key: string) => { savedKeys.push(key) },
    }

    // 同一部剧的两个不同文件（不同季，且 basename 相同——basename-only 的实现会在这里撞车）
    for (const p of ['/mnt/media/Show/Season 01/E01.mkv', '/mnt/media/Show/Season 02/E01.mkv']) {
      const dir = mkdtempSync(join(tmpdir(), 'tw-c20-'))
      const jobPaths = ensureWorkspaceLayout(dir, 'job-c20')
      const t: TranslateTask = {
        jobId: 'job-c20', videoPath: join(dir, 'x.mkv'),
        itemId: translateItemId(workId, p),          // ← 新架构形态，现造不写死
        originLang: 'en', targetLanguage: 'zh', title: 'Show', mediaRoot: dir,
      }
      const tools = makeTranslateWorkspaceTools({
        task: t, paths: jobPaths,
        resolveDeps: { probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }], extract: async () => SAMPLE_SRT },
        install: () => join(dir, 'out.srt'),
        glossaryStore: store,
      })
      await call(tools.freeze_glossary, { terms: [{ src: 'Moi', zh: '莫伊' }] })
      await call(tools.resolve_source)
      await call(tools.materialize_agent_view)
      await call(tools.update_rows, { rows: [{ id: '1', tgt: '你好妮可', status: 'ok' }, { id: '2', tgt: '再见', status: 'ok' }] })
      await call(tools.merge_to_srt)
      expect((await call(tools.run_structural_gate)).verdict).toBe('pass')
      expect(await call(tools.install_sidecar)).toMatchObject({ ok: true })
      rmSync(dir, { recursive: true, force: true })
    }

    // 前置：两集确实各跑了一轮 load 与 save（否则下面的相等断言在空数组上也"成立"，假绿）
    expect(loadedKeys).toHaveLength(2)
    expect(savedKeys).toHaveLength(2)
    // 红线本体：两集的 key 相同，且就是 work_id。
    // itemId 一旦改成裸路径开头 → seriesKeyOf 返回整串 → 这里立刻变成两个不同的 key，
    // 而在真实生产里这一步不会报错，只会让第 2 集从空术语表重新决一次"东国 / 奥斯塔尼亚"。
    expect(new Set(loadedKeys)).toEqual(new Set([workId]))
    expect(new Set(savedKeys)).toEqual(new Set([workId]))
  })

  it('🔴 C20: 电影（单文件作品）的 key 也落在 work_id 上', async () => {
    const loaded: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'tw-c20m-'))
    const jobPaths = ensureWorkspaceLayout(dir, 'job-c20m')
    const t: TranslateTask = {
      jobId: 'job-c20m', videoPath: join(dir, 'x.mkv'),
      itemId: translateItemId('tmdb:9', '/mnt/media/Movies/Shelby Oaks (2025)/movie.mkv'),
      originLang: 'en', targetLanguage: 'zh', title: 'Shelby Oaks', mediaRoot: dir,
    }
    const tools = makeTranslateWorkspaceTools({
      task: t, paths: jobPaths,
      resolveDeps: { probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }], extract: async () => SAMPLE_SRT },
      install: () => join(dir, 'out.srt'),
      glossaryStore: { load: (k) => { loaded.push(k); return [] }, save: () => {} },
    })
    await call(tools.freeze_glossary, { terms: [{ src: 'Nico', zh: '妮可' }] })
    expect(loaded).toEqual(['tmdb:9'])
    rmSync(dir, { recursive: true, force: true })
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

  it('🔴 update_rows 成功后，argsSummary 带 cueDone/cueTotal（cue 级进度数据源）', async () => {
    // 初始化 3 条 pending 行（覆盖 baseDeps 的 2 行 SAMPLE_SRT）
    // 注：BilingualStatus 枚举无 'done'，「已翻完」= status:'ok'（用户确认）
    const srt3 = '1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:03,000 --> 00:00:04,000\nB\n\n3\n00:00:05,000 --> 00:00:06,000\nC\n'
    const tools = makeTranslateWorkspaceTools(baseDeps({
      resolveDeps: {
        probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
        extract: async () => srt3,
      },
    }))
    await call(tools.resolve_source)
    await call(tools.materialize_agent_view)
    // 先写 1 行
    await call(tools.update_row, { id: '1', tgt: '甲', status: 'ok' })
    // 再批量写 2 行
    const r = await call(tools.update_rows, { rows: [{ id: '2', tgt: '乙', status: 'ok' }, { id: '3', tgt: '丙', status: 'ok' }] })
    expect(r).toMatchObject({ ok: true })
    // cueDone/cueTotal 必须以可序列化形式出现在工具调用的进度信号里
    expect(r).toMatchObject({ cueDone: 3, cueTotal: 3 })
  })
})
