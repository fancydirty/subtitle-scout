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
    originLang: 'en', title: 'Show', mediaRoot: join(root, 'Show'), stagingRoot: root,
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
    const run = makeTranslateWorker(baseDeps(model))
    const report = await run(baseTask())
    expect(report.status).toBe('installed')
    expect(report.sourceRef).toMatch(/embedded/)
    const sidecar = baseTask().videoPath.replace(/\.mkv$/, '.zh-Hans.srt')
    expect(existsSync(sidecar)).toBe(true)
    const text = readFileSync(sidecar, 'utf8')
    expect(text).toContain('你好妮可')
    expect(text).toContain('00:00:01,000 --> 00:00:02,000')
    // workspace artifacts on disk
    const jobRoot = join(root, '.subtitle-translate', 'job-1')
    expect(readFileSync(join(jobRoot, 'glossary', 'terms.json'), 'utf8')).toContain('妮可')
    expect(readFileSync(join(jobRoot, 'work', 'summary.md'), 'utf8')).toContain('道别')
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
