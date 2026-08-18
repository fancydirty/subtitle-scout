import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { MockLanguageModelV4 } from 'ai/test'
import { makeTranslateWorker, type TranslateWorkerDeps } from './translateWorker.js'
import type { TranslateTask } from './translateWorker.schemas.js'

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:02,000',
  'Hello Nico',
  '',
  '2',
  '00:00:03,000 --> 00:00:04,000',
  'Goodbye',
  '',
].join('\n')

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'scout-translate-worker-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

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

function baseTask(over: Partial<TranslateTask> = {}): TranslateTask {
  return {
    jobId: 'job-1', videoPath: join(root, 'Show', 'x.mkv'), itemId: 'tmdb:1/s1e1',
    originLang: 'en', targetLanguage: 'zh', title: 'Show', mediaRoot: join(root, 'Show'), stagingRoot: root,
    ...over,
  }
}

function baseDeps(model: any, over: Partial<TranslateWorkerDeps> = {}): TranslateWorkerDeps {
  return {
    model,
    resolveDeps: {
      probe: async () => [{ lang: 'eng', codec: 'subrip', isImageBased: false }],
      extract: async () => SRT,
    },
    install: (vp, content) => {
      const out = vp.replace(/\.mkv$/, '.zh-Hans.srt')
      writeFileSync(out, content)
      return out
    },
    ...over,
  }
}

describe('makeTranslateWorker (end-to-end, scripted model)', () => {
  it('desk workflow: resolve → materialize → glossary → rows → gate → merge → install → installed', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    writeFileSync(baseTask().videoPath, 'video-bytes')
    const steps = [
      toolCallResult('c1', 'resolve_source', {}),
      toolCallResult('c2', 'materialize_agent_view', {}),
      toolCallResult('c3', 'freeze_glossary', { terms: [{ src: 'Nico', zh: '妮可', note: '角色名' }] }),
      toolCallResult('c4', 'get_window', { centerId: '1', radius: 1 }),
      toolCallResult('c5', 'update_row', { id: '1', tgt: '你好妮可', status: 'ok' }),
      toolCallResult('c6', 'update_row', { id: '2', tgt: '再见', status: 'ok' }),
      toolCallResult('c7', 'update_summary', { content: '妮可与人打招呼后道别。' }),
      toolCallResult('c8', 'run_structural_gate', {}),
      toolCallResult('c9', 'merge_to_srt', {}),
      toolCallResult('c10', 'install_sidecar', {}),
      finalizeResult({
        status: 'installed', reason: null,
        sourceRef: 'embedded:s:0', sidecarPath: baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt'),
      }),
    ]
    let call = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(call++, steps.length - 1)] })
    // 工作台产物在**装盘那一刻**取样：成功后整棵工作台会被回收（2026-08-08 实测残留缺陷的
    // 修复，见 translateWorker.ts 的回收论证），事后读盘必然 ENOENT。取样点选 install 回调是
    // 因为它是 agent 真正走完 glossary→rows→gate→merge 之后才会被调到的那一步——
    // 断言强度不降：仍是"工具真的把东西写进了工作台"，只是观察时刻挪到了回收之前。
    const jobRoot = join(root, '.subtitle-translate', 'job-1')
    let sampledTerms = '', sampledSummary = ''
    const run = makeTranslateWorker(baseDeps(model, {
      install: (vp, content) => {
        sampledTerms = readFileSync(join(jobRoot, 'glossary', 'terms.json'), 'utf8')
        sampledSummary = readFileSync(join(jobRoot, 'work', 'summary.md'), 'utf8')
        const out = vp.replace(/\.mkv$/, '.zh-Hans.srt')
        writeFileSync(out, content)
        return out
      },
    }))
    const report = await run(baseTask())
    expect(report.status).toBe('installed')
    expect(report.sourceRef).toMatch(/embedded/)
    const sidecar = baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt')
    expect(existsSync(sidecar)).toBe(true)
    const text = readFileSync(sidecar, 'utf8')
    expect(text).toContain('你好妮可')
    expect(text).toContain('00:00:01,000 --> 00:00:02,000')
    // workspace artifacts（装盘时刻取样）
    expect(sampledTerms).toContain('妮可')
    expect(sampledSummary).toContain('道别')
  })

  // 这条**不走真 resolver**（MockLanguageModel 直接喂 finalize），验的是"管道把模型
  // finalize 的 sourceRef 原样透传"——取什么值对被测逻辑毫无影响。
  // 原标题写的是 "ja origin with only eng embedded → fallback eng"，而 R18（2026-08-08）
  // 已废止 eng 兜底、resolver 不再返回 `fallback:`。留着那个标题会让后人以为兜底还在
  // 且有测试覆盖（真正的红线在 resolveSource.test.ts 与 translateWorker.tools.test.ts）。
  // 故标题与取值都改成中性的，不再假装描述一个已被禁止的场景。
  it('管道原样透传模型 finalize 的 sourceRef（不解释、不校验其语义）', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    writeFileSync(baseTask().videoPath, 'video-bytes')
    const steps = [
      toolCallResult('c1', 'resolve_source', {}),
      toolCallResult('c2', 'materialize_agent_view', {}),
      toolCallResult('c3', 'freeze_glossary', { terms: [{ src: 'Nico', zh: '妮可' }] }),
      toolCallResult('c4', 'update_rows', { rows: [{ id: '1', tgt: '你好妮可', status: 'ok' }, { id: '2', tgt: '再见', status: 'ok' }] }),
      toolCallResult('c5', 'run_structural_gate', {}),
      toolCallResult('c6', 'merge_to_srt', {}),
      toolCallResult('c7', 'install_sidecar', {}),
      finalizeResult({
        status: 'installed', reason: null,
        sourceRef: 'embedded:s:1', sidecarPath: baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt'),
      }),
    ]
    let call = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(call++, steps.length - 1)] })
    const run = makeTranslateWorker(baseDeps(model))
    const report = await run(baseTask({ originLang: 'ja' }))
    expect(report.status).toBe('installed')
    expect(report.sourceRef).toBe('embedded:s:1')
  })

  it('gate fail → model finalizes held; nothing installed', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    writeFileSync(baseTask().videoPath, 'video-bytes')
    const steps = [
      toolCallResult('c1', 'resolve_source', {}),
      toolCallResult('c2', 'materialize_agent_view', {}),
      toolCallResult('c3', 'freeze_glossary', { terms: [{ src: 'Nico', zh: '妮可' }] }),
      toolCallResult('c4', 'update_row', { id: '1', tgt: '你好尼古', status: 'ok' }),
      toolCallResult('c5', 'update_row', { id: '2', tgt: '再见', status: 'ok' }),
      toolCallResult('c6', 'run_structural_gate', {}),
      finalizeResult({ status: 'held', reason: 'term conformance < 85%', sourceRef: 'embedded:s:0', sidecarPath: null }),
    ]
    let call = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(call++, steps.length - 1)] })
    const run = makeTranslateWorker(baseDeps(model))
    const report = await run(baseTask())
    expect(report.status).toBe('held')
    expect(existsSync(baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt'))).toBe(false)
  })

  it('修复循环:闸 fail 带 violations 明细 → 模型修 flagged 行 → 重闸 pass → installed', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    writeFileSync(baseTask().videoPath, 'video-bytes')
    const steps = [
      toolCallResult('c1', 'resolve_source', {}),
      toolCallResult('c2', 'materialize_agent_view', {}),
      toolCallResult('c3', 'freeze_glossary', { terms: [{ src: 'Nico', zh: '妮可' }] }),
      // 模型故意写错(Nico→尼古)
      toolCallResult('c4', 'update_rows', { rows: [{ id: '1', tgt: '你好尼古', status: 'ok' }, { id: '2', tgt: '再见', status: 'ok' }] }),
      toolCallResult('c5', 'run_structural_gate', {}),
      // 模型读到 violations(Nico 应为妮可,missAtCues=[1]) → 修复第 1 行
      toolCallResult('c6', 'update_row', { id: '1', tgt: '你好妮可', status: 'ok' }),
      toolCallResult('c7', 'run_structural_gate', {}),
      toolCallResult('c8', 'merge_to_srt', {}),
      toolCallResult('c9', 'install_sidecar', {}),
      finalizeResult({ status: 'installed', reason: null, sourceRef: 'embedded:s:0', sidecarPath: baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt') }),
    ]
    let call = 0
    let gateCallCount = 0
    const model = new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        const step = steps[Math.min(call++, steps.length - 1)]
        if (step.content[0].toolName === 'run_structural_gate') {
          gateCallCount++
          // 验证第二次闸在修复后发生
          if (gateCallCount === 2) {
            const prompt = JSON.stringify(opts.prompt)
            expect(prompt).toContain('violations')
          }
        }
        return step
      },
    })
    const run = makeTranslateWorker(baseDeps(model))
    const report = await run(baseTask())
    expect(report.status).toBe('installed')
    expect(gateCallCount).toBe(2) // 修复循环真发生了:fail → 修 → 重闸 pass
    const text = readFileSync(baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt'), 'utf8')
    expect(text).toContain('你好妮可') // 修复后的文本装盘
  })

  it('worker-exhaustion: model never finalizes → held report (not an uncaught throw)', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    writeFileSync(baseTask().videoPath, 'video-bytes')
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult('c1', 'get_window', { centerId: '1', radius: 1 }),
    })
    const run = makeTranslateWorker(baseDeps(model, { stepCap: 3 }))
    const report = await run(baseTask())
    expect(report.status).toBe('held')
    expect(report.reason).toMatch(/exhausted|finalize/i)
    expect(report.llmCalls).toBe(3) // 耗尽路径配额账本不失明(stepCap=3 步)
    expect(existsSync(baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt'))).toBe(false)
  })

  it('filename and facts reach the prompt (basename only, no other dirs)', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    writeFileSync(baseTask().videoPath, 'video-bytes')
    let seenPrompt = ''
    const model = new MockLanguageModelV4({
      doGenerate: async (opts: any) => {
        seenPrompt = JSON.stringify(opts.prompt)
        return finalizeResult({ status: 'no-source', reason: 'x', sourceRef: null, sidecarPath: null })
      },
    })
    const deps = baseDeps(model, {
      resolveDeps: {
        probe: async () => [],
        extract: async () => null,
      },
    })
    const run = makeTranslateWorker(deps)
    await run(baseTask())
    expect(seenPrompt).toContain(basename(baseTask().videoPath))
    expect(seenPrompt).toContain('origin_lang: en')
    expect(seenPrompt).toContain('tmdb:1/s1e1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 翻译工作台的生命周期（2026-08-08 live test 实测缺陷 / CURRENT-STATE §八「翻译工作台 GC 炸弹」）
//
// 实测证据：翻译成功、sub_status 已闭环到 covered，而
// `_scout_live_test/TV/.subtitle-translate/daemon-1786390499859/`（312KB，canonical/ + agent_view/
// + context/ + glossary/FROZEN + out/target.srt）仍留在媒体目录里。字幕流早有这条契约
// （findSubtitleWorker 的 finally 里 `cleanup(task.jobId, stagingBase)`，stagingSandbox 头注
// 原话"job 结束(无论成败)整个沙盒目录被删除"），翻译流一直没有对应实现——唯一的兜底是
// gcOrphans 的 mtime 活性窗口，而它只在 daemon **boot** 跑一次：一个长期不重启的 daemon
// 每翻一集就永久留一个工作台。
//
// 两侧刻意**不对称**（与字幕流的差异，需要论证而不是照抄）：
//  · 成功（installed / already-covered）→ 删。产物已装盘，工作台是纯垃圾。
//  · 未成功（held / no-source / extract-failed / probe-failed / worker-exhausted）→ 留现场。
//    翻译是数分钟到数小时的付费 LLM，held 的半成品（bilingual.jsonl 已译好的几百行 + 冻结的
//    术语表）是排障与人工救援的唯一材料，删掉就等于"失败了但没人知道模型到底卡在哪"。
//    留现场不会无界堆积**正因为 jobId 现在是稳定身份**：同一个文件重试永远复用同一个目录
//    （旧的 `daemon-${Date.now()}` 每次失败堆一个新的，那才是真的堆满磁盘）。
//    而跨文件的总量由 gcOrphans 的 boot 回收 + mtime 窗口收口——那条路径本就为此存在。
// ─────────────────────────────────────────────────────────────────────────────
describe('翻译工作台生命周期（GC 炸弹：live test 实测残留 312KB）', () => {
  /** 一次完整成功的脚本（resolve → … → install → finalize installed）。 */
  function installedSteps(task: TranslateTask) {
    return [
      toolCallResult('c1', 'resolve_source', {}),
      toolCallResult('c2', 'materialize_agent_view', {}),
      toolCallResult('c3', 'freeze_glossary', { terms: [{ src: 'Nico', zh: '妮可' }] }),
      toolCallResult('c4', 'update_rows', { rows: [{ id: '1', tgt: '你好妮可', status: 'ok' }, { id: '2', tgt: '再见', status: 'ok' }] }),
      toolCallResult('c5', 'run_structural_gate', {}),
      toolCallResult('c6', 'merge_to_srt', {}),
      toolCallResult('c7', 'install_sidecar', {}),
      finalizeResult({
        status: 'installed', reason: null, sourceRef: 'embedded:s:0',
        sidecarPath: task.videoPath.replace(/\.mkv$/, '.zh-Hans.srt'),
      }),
    ]
  }

  function scriptedModel(steps: unknown[]) {
    let call = 0
    return new MockLanguageModelV4({ doGenerate: async () => steps[Math.min(call++, steps.length - 1)] as any })
  }

  it('🔴 翻译成功 → 工作台目录被回收（实测残留 .subtitle-translate/<jobId>/ 312KB）', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    const task = baseTask({ jobId: 'stable-job' })
    writeFileSync(task.videoPath, 'video-bytes')
    const run = makeTranslateWorker(baseDeps(scriptedModel(installedSteps(task))))
    const report = await run(task)
    expect(report.status).toBe('installed')
    // 装盘产物必须还在（回收只碰工作台，绝不碰刚装好的 sidecar）
    expect(existsSync(task.videoPath.replace(/\.mkv$/, '.zh-Hans.srt'))).toBe(true)
    // 工作台目录整棵没了
    const jobRoot = join(root, '.subtitle-translate', 'stable-job')
    expect(existsSync(jobRoot)).toBe(false)
    // `.ignore` 标记留着（它是 `.subtitle-translate/` 一级的、跨 job 共用的媒体服务器屏蔽标记，
    // 跟着单个 job 一起删掉的话下一个 job 又要重建，且中间窗口 Jellyfin 会扫到半成品 srt）
    expect(existsSync(join(root, '.subtitle-translate', '.ignore'))).toBe(true)
  })

  it('🔴 already-covered 也回收（同为成功轨：没活可干，工作台一样是纯垃圾）', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    const task = baseTask({ jobId: 'covered-job' })
    writeFileSync(task.videoPath, 'video-bytes')
    const model = scriptedModel([
      finalizeResult({ status: 'already-covered', reason: '已有中文字幕', sourceRef: null, sidecarPath: null }),
    ])
    const report = await makeTranslateWorker(baseDeps(model))(task)
    expect(report.status).toBe('already-covered')
    expect(existsSync(join(root, '.subtitle-translate', 'covered-job'))).toBe(false)
  })

  it('🔴 held → **保留现场**（半成品与冻结术语表是排障唯一材料；稳定 jobId 保证不堆积）', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    const task = baseTask({ jobId: 'held-job' })
    writeFileSync(task.videoPath, 'video-bytes')
    const model = scriptedModel([
      toolCallResult('c1', 'resolve_source', {}),
      toolCallResult('c2', 'materialize_agent_view', {}),
      toolCallResult('c3', 'freeze_glossary', { terms: [{ src: 'Nico', zh: '妮可' }] }),
      toolCallResult('c4', 'update_row', { id: '1', tgt: '你好尼古', status: 'ok' }),
      toolCallResult('c5', 'run_structural_gate', {}),
      finalizeResult({ status: 'held', reason: 'term conformance < 85%', sourceRef: 'embedded:s:0', sidecarPath: null }),
    ])
    const report = await makeTranslateWorker(baseDeps(model))(task)
    expect(report.status).toBe('held')
    const jobRoot = join(root, '.subtitle-translate', 'held-job')
    expect(existsSync(jobRoot)).toBe(true)
    // 现场要真的有排障材料，不是一个空壳目录
    expect(existsSync(join(jobRoot, 'glossary', 'terms.json'))).toBe(true)
  })

  it('🔴 worker 耗尽（模型从不 finalize）→ 同样保留现场', async () => {
    mkdirSync(join(root, 'Show'), { recursive: true })
    const task = baseTask({ jobId: 'exhausted-job' })
    writeFileSync(task.videoPath, 'video-bytes')
    const model = new MockLanguageModelV4({
      doGenerate: async () => toolCallResult('c1', 'resolve_source', {}),
    })
    const report = await makeTranslateWorker(baseDeps(model, { stepCap: 2 }))(task)
    expect(report.status).toBe('held')
    expect(existsSync(join(root, '.subtitle-translate', 'exhausted-job'))).toBe(true)
  })

  it('🔴 开工前清掉上一次的残留（稳定 jobId 的连带风险：陈旧 FROZEN 会锁死这一次）', async () => {
    // 这一条是"把 jobId 改成稳定值"引入的**新**风险，必须同时钉住：
    // 上一次失败留下的 `glossary/FROZEN` 让 freeze_glossary 直接返回
    // "glossary is already frozen for this job"（那个工具刻意 one-shot），而 install_sidecar
    // 的 fail-closed 又要求 gate marker 对应**当前**的 bilingual 表——于是这一次翻译会在
    // 一个半旧半新的桌面上跑，最坏是永久 held（每轮烧一个付费 LLM session 却永远过不了闸）。
    // 残留还包括上一次的 bilingual.jsonl：模型会以为自己已经译过这些行。
    // 结论：稳定身份负责"不堆积"，开工前清空负责"不串味"，两者缺一不可。
    mkdirSync(join(root, 'Show'), { recursive: true })
    const task = baseTask({ jobId: 'reused-job' })
    writeFileSync(task.videoPath, 'video-bytes')
    // 手造一份上一次失败的残留
    const jobRoot = join(root, '.subtitle-translate', 'reused-job')
    mkdirSync(join(jobRoot, 'glossary'), { recursive: true })
    mkdirSync(join(jobRoot, 'work'), { recursive: true })
    writeFileSync(join(jobRoot, 'glossary', 'FROZEN'), 'frozen\n')
    writeFileSync(join(jobRoot, 'glossary', 'terms.json'), JSON.stringify([{ src: 'Nico', zh: '陈旧译名' }]))
    writeFileSync(join(jobRoot, 'work', 'bilingual.jsonl'), '{"id":"1","src":"stale","tgt":"陈旧","status":"ok"}\n')
    const run = makeTranslateWorker(baseDeps(scriptedModel(installedSteps(task))))
    const report = await run(task)
    // 残留没被清 → freeze_glossary 返回 already frozen → 术语表还是"陈旧译名" → 闸过不了 → 非 installed
    expect(report.status).toBe('installed')
    const text = readFileSync(task.videoPath.replace(/\.mkv$/, '.zh-Hans.srt'), 'utf8')
    expect(text).toContain('你好妮可')
    expect(text).not.toContain('陈旧')
  })
})
