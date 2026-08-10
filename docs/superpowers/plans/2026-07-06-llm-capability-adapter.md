# LLM Capability Adapter Implementation Plan (Milestone 1.5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Coding tasks are executed by **sonnet-5 subagents**; real-credential verification is done by the controller.

**Goal:** 任何 OpenAI 兼容 provider 只配 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL` 三凭证即可工作——启动时自动探测怪癖并选择结构化输出模式，运行时遇 provider 行为变更自愈。

**Architecture:** 探针阶梯（forced-tool → forced-tool+quirk body → prompt-JSON）确定 `LlmProfile`，磁盘持久化 30 天。新增 `LlmRuntime` 抽象封装模式分派与失效重探；三个判断点函数改为依赖 `LlmRuntime` 而非裸 model。gate/pipeline/journal 结构不动，journal 增记当前 profile。

**Tech Stack:** 既有栈（ai@7、zod@4、vitest）。零新依赖（JSON Schema 生成用 zod v4 原生 `z.toJSONSchema`）。

**Spec:** `docs/superpowers/specs/2026-07-06-llm-capability-adapter-design.md`

**现有代码关键事实（子代理必读）：**

- `src/agent/llm.ts` 已有：`LlmConfig{baseUrl,apiKey,model,extraBody?}`、`injectExtraBody()`、`makeModel()`（extraBody 通过自定义 fetch 注入）、`callStructured()`（强制 tool + Zod 校验 + 带错误重试一次）、`StructuredOutputError`、`CallStructuredResult{parsed,rawText,prompt,retries,durationMs}`。
- `identifyMedia/planSearch/rankCandidates` 现签名 `(model: LanguageModel, ...)`，本计划改为 `(llm: LlmRuntime, ...)`。
- pipeline 通过 `PipelineDeps` 注入判断点闭包，pipeline 本体不需要动。
- 实测怪癖：DeepSeek v4 默认 thinking 拒绝一切非 auto tool_choice，报错文本含 "Thinking mode does not support this tool_choice"；解药 `{"thinking":{"type":"disabled"}}`。
- NodeNext ESM：本地 import 必须带 `.js` 后缀。

---

## File Structure

```
src/agent/
├── quirks.ts          # QUIRK_BODIES 档案库（独立小文件，PR 友好）
├── profile.ts         # LlmProfile 类型 + ProfileStore（读/写/失效，TTL 30d）
├── profile.test.ts
├── probe.ts           # probeCapability 探针状态机（attempts 注入，可测）
├── probe.test.ts
├── llm.ts             # 增：extractJson、callPromptJson、isToolChoiceRejection
├── llm.test.ts        # 增测
├── runtime.ts         # createLlmRuntime：档案解析、模式分派、运行时自愈
├── runtime.test.ts
├── identifyMedia.ts   # model 参数 → LlmRuntime
├── planSearch.ts      # 同上
└── rankCandidates.ts  # 同上
src/cli/index.ts       # 接入 ProfileStore + createLlmRuntime；journal 记 profile
```

---

### Task 1: quirks.ts + profile.ts

**Files:**
- Create: `src/agent/quirks.ts`, `src/agent/profile.ts`, `src/agent/profile.test.ts`

- [ ] **Step 1: 写失败测试** `src/agent/profile.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore } from './profile.js'
import { QUIRK_BODIES } from './quirks.js'

describe('QUIRK_BODIES', () => {
  it('starts with the DeepSeek thinking-disable quirk', () => {
    expect(QUIRK_BODIES[0].id).toBe('deepseek-thinking-disabled')
    expect(QUIRK_BODIES[0].body).toEqual({ thinking: { type: 'disabled' } })
  })
})

describe('ProfileStore', () => {
  const store = () => new ProfileStore(mkdtempSync(join(tmpdir(), 'prof-')))

  it('round-trips a profile keyed by baseUrl+model', () => {
    const s = store()
    s.put('https://api.x.com/v1', 'm1', {
      mode: 'forced-tool-quirk', quirkId: 'deepseek-thinking-disabled',
      extraBody: { thinking: { type: 'disabled' } }, evidence: 'probe',
    })
    const p = s.get('https://api.x.com/v1', 'm1')
    expect(p?.mode).toBe('forced-tool-quirk')
    expect(p?.extraBody).toEqual({ thinking: { type: 'disabled' } })
  })

  it('different model = different profile', () => {
    const s = store()
    s.put('https://api.x.com/v1', 'm1', { mode: 'forced-tool', evidence: 'probe' })
    expect(s.get('https://api.x.com/v1', 'm2')).toBeNull()
  })

  it('expires after ttl and honors invalidate', () => {
    const s = store()
    s.put('u', 'm', { mode: 'forced-tool', evidence: 'probe' }, -1)
    expect(s.get('u', 'm')).toBeNull()
    s.put('u', 'm', { mode: 'forced-tool', evidence: 'probe' })
    s.invalidate('u', 'm')
    expect(s.get('u', 'm')).toBeNull()
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/agent/profile.test.ts` — Expected: FAIL (module not found)

- [ ] **Step 3: 实现** `src/agent/quirks.ts`

```ts
/** provider 怪癖档案库：探针按数组顺序尝试。新怪癖 = 加一行（注明来源）。
 *  参考来源：官方文档、LiteLLM provider 参数映射源码、实测 journal。 */
export interface QuirkEntry {
  id: string
  body: Record<string, unknown>
}

export const QUIRK_BODIES: QuirkEntry[] = [
  // DeepSeek v4 系列默认 thinking，thinking 拒绝非 auto tool_choice（2026-07-06 实测）
  { id: 'deepseek-thinking-disabled', body: { thinking: { type: 'disabled' } } },
  // Qwen/DashScope 风格思考开关（来源：官方文档）
  { id: 'qwen-enable-thinking-false', body: { enable_thinking: false } },
  // vLLM 自托管常见形态（来源：vLLM 文档）
  { id: 'vllm-chat-template-kwargs', body: { chat_template_kwargs: { enable_thinking: false } } },
]
```

`src/agent/profile.ts`

```ts
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export type StructuredMode = 'forced-tool' | 'forced-tool-quirk' | 'prompt-json'

export interface LlmProfile {
  mode: StructuredMode
  quirkId?: string
  extraBody?: Record<string, unknown>
  evidence: string
}

interface StoredProfile extends LlmProfile { probedAt: number; expiresAt: number }

const TTL_DAYS = 30

export class ProfileStore {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }) }

  private pathFor(baseUrl: string, model: string): string {
    const key = createHash('sha1').update(`${baseUrl}|${model}`).digest('hex')
    return join(this.dir, `${key}.json`)
  }

  get(baseUrl: string, model: string): LlmProfile | null {
    const p = this.pathFor(baseUrl, model)
    if (!existsSync(p)) return null
    const stored: StoredProfile = JSON.parse(readFileSync(p, 'utf8'))
    if (Date.now() > stored.expiresAt) return null
    const { probedAt: _p, expiresAt: _e, ...profile } = stored
    return profile
  }

  put(baseUrl: string, model: string, profile: LlmProfile, ttlDays: number = TTL_DAYS) {
    const stored: StoredProfile = {
      ...profile, probedAt: Date.now(), expiresAt: Date.now() + ttlDays * 86_400_000,
    }
    writeFileSync(this.pathFor(baseUrl, model), JSON.stringify(stored, null, 2))
  }

  invalidate(baseUrl: string, model: string) {
    rmSync(this.pathFor(baseUrl, model), { force: true })
  }
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/agent/profile.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/quirks.ts src/agent/profile.ts src/agent/profile.test.ts
git commit -m "feat: quirk registry and llm profile store with TTL"
```

---

### Task 2: llm.ts 增补——extractJson / callPromptJson / isToolChoiceRejection

**Files:**
- Modify: `src/agent/llm.ts`
- Test: `src/agent/llm.test.ts`（追加）

- [ ] **Step 1: 追加失败测试到** `src/agent/llm.test.ts`

```ts
describe('extractJson', () => {
  it('parses bare JSON', async () => {
    const { extractJson } = await import('./llm.js')
    expect(extractJson('{"ok":true}')).toEqual({ ok: true })
  })
  it('parses fenced JSON', async () => {
    const { extractJson } = await import('./llm.js')
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })
  it('parses JSON embedded in prose', async () => {
    const { extractJson } = await import('./llm.js')
    expect(extractJson('Sure! Here it is: {"a":{"b":1}} hope that helps')).toEqual({ a: { b: 1 } })
  })
  it('throws on no JSON', async () => {
    const { extractJson } = await import('./llm.js')
    expect(() => extractJson('no json here')).toThrow()
  })
})

describe('isToolChoiceRejection', () => {
  it('matches thinking/tool_choice provider errors', async () => {
    const { isToolChoiceRejection } = await import('./llm.js')
    expect(isToolChoiceRejection(new Error('AI_APICallError: Thinking mode does not support this tool_choice'))).toBe(true)
    expect(isToolChoiceRejection(new Error('tool_choice is not supported'))).toBe(true)
    expect(isToolChoiceRejection(new Error('Authentication Fails'))).toBe(false)
  })
})

describe('callPromptJson', () => {
  function textModel(texts: string[]) {
    let i = 0
    return new MockLanguageModelV4({
      doGenerate: async () => ({
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        content: [{ type: 'text', text: texts[Math.min(i++, texts.length - 1)] }],
        warnings: [],
      }),
    })
  }

  it('parses valid JSON text output', async () => {
    const { callPromptJson } = await import('./llm.js')
    const r = await callPromptJson({
      model: textModel(['{"title":"The Matrix","year":1999}']) as never,
      name: 'report', description: 'd', prompt: 'identify',
      schema: z.object({ title: z.string(), year: z.number() }),
    })
    expect(r.parsed).toEqual({ title: 'The Matrix', year: 1999 })
    expect(r.retries).toBe(0)
  })

  it('retries once on schema failure then succeeds', async () => {
    const { callPromptJson } = await import('./llm.js')
    const r = await callPromptJson({
      model: textModel(['{"title":"x"}', '{"title":"x","year":1999}']) as never,
      name: 'report', description: 'd', prompt: 'identify',
      schema: z.object({ title: z.string(), year: z.number() }),
    })
    expect(r.retries).toBe(1)
  })

  it('throws StructuredOutputError after retry exhausted', async () => {
    const { callPromptJson, StructuredOutputError } = await import('./llm.js')
    await expect(callPromptJson({
      model: textModel(['not json at all']) as never,
      name: 'report', description: 'd', prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
    })).rejects.toThrow(StructuredOutputError)
  })
})
```

注意：`MockLanguageModelV4` 的 doGenerate 返回形态以 milestone 1 已写好的 `src/agent/llm.test.ts` 顶部现有 mock 为准（它已经跑通），照抄结构改 content 为 text 类型。

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/agent/llm.test.ts` — Expected: 新用例 FAIL

- [ ] **Step 3: 在 `src/agent/llm.ts` 追加实现**

```ts
/** provider 拒绝强制 tool_choice / thinking 冲突类错误（探针阶梯与运行时自愈共用） */
export function isToolChoiceRejection(e: unknown): boolean {
  return /tool[_ ]choice|thinking mode/i.test(String(e))
}

/** 从模型文本输出中提取 JSON：裸 JSON、代码栅栏、散文包裹皆可 */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/g, '').trim()
  try { return JSON.parse(stripped) } catch { /* fall through */ }
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error(`no JSON object found in model output: ${text.slice(0, 120)}`)
  return JSON.parse(stripped.slice(start, end + 1))
}

/** Mode 3 降级路径：无 tools，纯 prompt 约束 + JSON 提取 + Zod 校验（重试一次） */
export async function callPromptJson<S extends z.ZodType>(
  opts: CallStructuredOpts<S>,
): Promise<CallStructuredResult<z.infer<S>>> {
  const t0 = Date.now()
  const jsonSchema = JSON.stringify(z.toJSONSchema(opts.schema))
  const basePrompt = [
    opts.prompt,
    '',
    `Respond with ONLY a single JSON object (no code fences, no commentary) that validates against this JSON Schema:`,
    jsonSchema,
  ].join('\n')
  let lastError = ''
  for (let attempt = 0; attempt <= 1; attempt++) {
    const prompt = attempt === 0
      ? basePrompt
      : `${basePrompt}\n\nYour previous answer failed validation:\n${lastError}\nOutput a corrected, complete JSON object.`
    const result = await generateText({
      model: opts.model,
      prompt,
      maxOutputTokens: opts.maxOutputTokens ?? 16000,
    })
    try {
      const parsed = opts.schema.safeParse(extractJson(result.text))
      if (parsed.success) {
        return { parsed: parsed.data, rawText: result.text, prompt, retries: attempt, durationMs: Date.now() - t0 }
      }
      lastError = `${parsed.error.message}\nraw output was: ${result.text.slice(0, 400)}`
    } catch (e) {
      lastError = String(e)
    }
  }
  throw new StructuredOutputError(`prompt-json validation failed after retry: ${lastError}`)
}
```

import 处需将 `import type { z } from 'zod'` 改为 `import { z } from 'zod'`（`z.toJSONSchema` 是运行时调用；zod v4 原生支持，若安装版本无此 API 则用 `JSON.stringify` 手写字段描述替代并在报告中说明）。

- [ ] **Step 4: 确认通过 + 全量回归** — Run: `npm run check && npm test` — Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/agent/llm.ts src/agent/llm.test.ts
git commit -m "feat: prompt-json fallback path, json extraction, tool-choice rejection classifier"
```

---

### Task 3: probe.ts 探针状态机

**Files:**
- Create: `src/agent/probe.ts`, `src/agent/probe.test.ts`

- [ ] **Step 1: 写失败测试** `src/agent/probe.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { probeCapability, type ProbeAttempts } from './probe.js'

function attempts(overrides: Partial<ProbeAttempts> = {}): ProbeAttempts {
  return {
    forcedTool: vi.fn(async () => {}),
    promptJson: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('probeCapability', () => {
  it('mode 1: bare forced tool works', async () => {
    const a = attempts()
    const p = await probeCapability(a)
    expect(p.mode).toBe('forced-tool')
    expect(a.forcedTool).toHaveBeenCalledTimes(1)
    expect(a.forcedTool).toHaveBeenCalledWith(undefined)
  })

  it('mode 2: second quirk body unlocks forced tool', async () => {
    const forcedTool = vi.fn(async (extraBody?: Record<string, unknown>) => {
      if (!extraBody || 'thinking' in extraBody === false && !('enable_thinking' in extraBody)) {
        // 裸调用与第一个解药都失败，只有 enable_thinking 成功
      }
      if (extraBody && 'enable_thinking' in extraBody) return
      throw new Error('Thinking mode does not support this tool_choice')
    })
    const p = await probeCapability(attempts({ forcedTool }))
    expect(p.mode).toBe('forced-tool-quirk')
    expect(p.quirkId).toBe('qwen-enable-thinking-false')
    expect(p.extraBody).toEqual({ enable_thinking: false })
  })

  it('mode 3: all forced-tool attempts fail, prompt-json works', async () => {
    const forcedTool = vi.fn(async () => { throw new Error('tool_choice not supported') })
    const a = attempts({ forcedTool })
    const p = await probeCapability(a)
    expect(p.mode).toBe('prompt-json')
    expect(a.promptJson).toHaveBeenCalledTimes(1)
  })

  it('total failure: throws with last error', async () => {
    const boom = async () => { throw new Error('everything is broken') }
    await expect(probeCapability({ forcedTool: boom, promptJson: boom }))
      .rejects.toThrow(/cannot produce structured output/i)
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/agent/probe.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/agent/probe.ts`

```ts
import { QUIRK_BODIES } from './quirks.js'
import type { LlmProfile } from './profile.js'

/** 探针尝试的注入接口：成功返回、失败抛错。真实实现在 runtime.ts 构造。 */
export interface ProbeAttempts {
  forcedTool: (extraBody?: Record<string, unknown>) => Promise<void>
  promptJson: () => Promise<void>
}

export class ProbeFailedError extends Error {}

/** 探针阶梯：forced-tool → forced-tool+quirk（按档案库序）→ prompt-json → 报错 */
export async function probeCapability(attempts: ProbeAttempts): Promise<LlmProfile> {
  let lastError: unknown
  try {
    await attempts.forcedTool(undefined)
    return { mode: 'forced-tool', evidence: 'probe: bare forced tool call succeeded' }
  } catch (e) { lastError = e }

  for (const quirk of QUIRK_BODIES) {
    try {
      await attempts.forcedTool(quirk.body)
      return {
        mode: 'forced-tool-quirk', quirkId: quirk.id, extraBody: quirk.body,
        evidence: `probe: forced tool succeeded with quirk ${quirk.id}`,
      }
    } catch (e) { lastError = e }
  }

  try {
    await attempts.promptJson()
    return { mode: 'prompt-json', evidence: 'probe: degraded to prompt-json mode' }
  } catch (e) { lastError = e }

  throw new ProbeFailedError(
    `this model cannot produce structured output in any supported mode; last error: ${String(lastError)}`,
  )
}
```

- [ ] **Step 4: 确认通过** — Run: `npx vitest run src/agent/probe.test.ts` — Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/probe.ts src/agent/probe.test.ts
git commit -m "feat: capability probe ladder over quirk registry"
```

---

### Task 4: runtime.ts——档案解析、模式分派、运行时自愈

**Files:**
- Create: `src/agent/runtime.ts`, `src/agent/runtime.test.ts`

- [ ] **Step 1: 写失败测试** `src/agent/runtime.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createLlmRuntime, type RuntimeInternals } from './runtime.js'
import { ProfileStore } from './profile.js'

const cfg = { baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' }
const schema = z.object({ ok: z.boolean() })
const callOpts = { name: 'report', description: 'd', prompt: 'p', schema }
const store = () => new ProfileStore(mkdtempSync(join(tmpdir(), 'rt-')))
const okResult = { parsed: { ok: true }, rawText: '', prompt: 'p', retries: 0, durationMs: 1 }

function internals(over: Partial<RuntimeInternals> = {}): RuntimeInternals {
  return {
    probe: vi.fn(async () => ({ mode: 'forced-tool' as const, evidence: 'test' })),
    callForcedTool: vi.fn(async () => okResult),
    callPromptJson: vi.fn(async () => okResult),
    ...over,
  }
}

describe('createLlmRuntime', () => {
  it('probes once on cold start and persists the profile', async () => {
    const s = store()
    const ints = internals()
    const rt = await createLlmRuntime(cfg, s, ints)
    await rt.call(callOpts)
    expect(ints.probe).toHaveBeenCalledTimes(1)
    expect(s.get(cfg.baseUrl, cfg.model)?.mode).toBe('forced-tool')
    expect(rt.profileInfo().mode).toBe('forced-tool')
  })

  it('skips probing on warm start (profile cached)', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'cached' })
    const ints = internals()
    await createLlmRuntime(cfg, s, ints)
    expect(ints.probe).not.toHaveBeenCalled()
  })

  it('skips probing when cfg.extraBody is set (manual override)', async () => {
    const s = store()
    const ints = internals()
    const rt = await createLlmRuntime({ ...cfg, extraBody: { thinking: { type: 'disabled' } } }, s, ints)
    expect(ints.probe).not.toHaveBeenCalled()
    expect(rt.profileInfo().mode).toBe('forced-tool')
    expect(rt.profileInfo().quirkId).toBe('manual-extra-body')
  })

  it('dispatches prompt-json mode to callPromptJson', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'prompt-json', evidence: 'cached' })
    const ints = internals()
    const rt = await createLlmRuntime(cfg, s, ints)
    await rt.call(callOpts)
    expect(ints.callPromptJson).toHaveBeenCalledTimes(1)
    expect(ints.callForcedTool).not.toHaveBeenCalled()
  })

  it('self-heals: tool_choice rejection at runtime → invalidate, reprobe, retry once', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'stale' })
    const callForcedTool = vi.fn()
      .mockRejectedValueOnce(new Error('Thinking mode does not support this tool_choice'))
      .mockResolvedValueOnce(okResult)
    const probe = vi.fn(async () => ({
      mode: 'forced-tool-quirk' as const, quirkId: 'deepseek-thinking-disabled',
      extraBody: { thinking: { type: 'disabled' } }, evidence: 'reprobe',
    }))
    const rt = await createLlmRuntime(cfg, s, internals({ callForcedTool, probe }))
    const r = await rt.call(callOpts)
    expect(r.parsed).toEqual({ ok: true })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(s.get(cfg.baseUrl, cfg.model)?.mode).toBe('forced-tool-quirk')
  })

  it('does not self-heal on non-tool_choice errors', async () => {
    const s = store()
    s.put(cfg.baseUrl, cfg.model, { mode: 'forced-tool', evidence: 'ok' })
    const callForcedTool = vi.fn(async () => { throw new Error('Authentication Fails') })
    const probe = vi.fn()
    const rt = await createLlmRuntime(cfg, s, internals({ callForcedTool, probe }))
    await expect(rt.call(callOpts)).rejects.toThrow(/Authentication/)
    expect(probe).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 确认失败** — Run: `npx vitest run src/agent/runtime.test.ts` — Expected: FAIL

- [ ] **Step 3: 实现** `src/agent/runtime.ts`

```ts
import type { z } from 'zod'
import {
  makeModel, callStructured, callPromptJson as realCallPromptJson,
  isToolChoiceRejection, type LlmConfig, type CallStructuredResult,
} from './llm.js'
import { probeCapability, type ProbeAttempts } from './probe.js'
import { ProfileStore, type LlmProfile } from './profile.js'
import { z as zod } from 'zod'

export interface RuntimeCallOpts<S extends z.ZodType> {
  name: string
  description: string
  prompt: string
  schema: S
  maxOutputTokens?: number
}

export interface LlmRuntime {
  call<S extends z.ZodType>(opts: RuntimeCallOpts<S>): Promise<CallStructuredResult<z.infer<S>>>
  profileInfo(): { mode: string; quirkId?: string }
}

/** 内部实现注入点（测试用）；生产默认用真实现 */
export interface RuntimeInternals {
  probe: (attempts: ProbeAttempts) => Promise<LlmProfile>
  callForcedTool: <S extends z.ZodType>(cfg: LlmConfig, extraBody: Record<string, unknown> | undefined, opts: RuntimeCallOpts<S>) => Promise<CallStructuredResult<z.infer<S>>>
  callPromptJson: <S extends z.ZodType>(cfg: LlmConfig, opts: RuntimeCallOpts<S>) => Promise<CallStructuredResult<z.infer<S>>>
}

const PROBE_SCHEMA = zod.object({ ok: zod.boolean() })
const PROBE_PROMPT = 'This is a connectivity probe. Report ok=true.'

function defaultInternals(): RuntimeInternals {
  return {
    probe: probeCapability,
    callForcedTool: (cfg, extraBody, opts) =>
      callStructured({ model: makeModel({ ...cfg, extraBody }), ...opts }),
    callPromptJson: (cfg, opts) =>
      realCallPromptJson({ model: makeModel({ ...cfg, extraBody: undefined }), ...opts }),
  }
}

export async function createLlmRuntime(
  cfg: LlmConfig,
  store: ProfileStore,
  internals: RuntimeInternals = defaultInternals(),
): Promise<LlmRuntime> {
  const makeAttempts = (): ProbeAttempts => ({
    forcedTool: async extraBody => {
      await internals.callForcedTool(cfg, extraBody, {
        name: 'report_probe', description: 'connectivity probe',
        prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 16000,
      })
    },
    promptJson: async () => {
      await internals.callPromptJson(cfg, {
        name: 'report_probe', description: 'connectivity probe',
        prompt: PROBE_PROMPT, schema: PROBE_SCHEMA, maxOutputTokens: 16000,
      })
    },
  })

  const resolveProfile = async (): Promise<LlmProfile> => {
    if (cfg.extraBody) {
      // 人工 override：最高优先级，跳过探测
      return { mode: 'forced-tool', quirkId: 'manual-extra-body', extraBody: cfg.extraBody, evidence: 'LLM_EXTRA_BODY override' }
    }
    const cached = store.get(cfg.baseUrl, cfg.model)
    if (cached) return cached
    const probed = await internals.probe(makeAttempts())
    store.put(cfg.baseUrl, cfg.model, probed)
    return probed
  }

  let profile = await resolveProfile()

  const dispatch = <S extends z.ZodType>(opts: RuntimeCallOpts<S>) =>
    profile.mode === 'prompt-json'
      ? internals.callPromptJson(cfg, opts)
      : internals.callForcedTool(cfg, profile.extraBody, opts)

  return {
    profileInfo: () => ({ mode: profile.mode, quirkId: profile.quirkId }),
    async call(opts) {
      try {
        return await dispatch(opts)
      } catch (e) {
        // 运行时自愈：provider 行为变更（如悄悄启用 thinking）→ 作废档案重探，重试一次
        if (!isToolChoiceRejection(e) || profile.quirkId === 'manual-extra-body') throw e
        store.invalidate(cfg.baseUrl, cfg.model)
        profile = await internals.probe(makeAttempts())
        store.put(cfg.baseUrl, cfg.model, profile)
        return await dispatch(opts)
      }
    },
  }
}
```

- [ ] **Step 4: 确认通过 + 全量回归** — Run: `npm run check && npm test` — Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/agent/runtime.ts src/agent/runtime.test.ts
git commit -m "feat: llm runtime with profile resolution, mode dispatch, self-healing"
```

---

### Task 5: 判断点与 CLI 接线

**Files:**
- Modify: `src/agent/identifyMedia.ts`, `src/agent/planSearch.ts`, `src/agent/rankCandidates.ts`, `src/cli/index.ts`, `src/core/pipeline.test.ts`（若 mock 需要调整则不动——判断点是注入的闭包，pipeline 测试不受影响）

- [ ] **Step 1: 三个判断点换签名**

每个文件：删除 `import type { LanguageModel } from 'ai'`，改为 `import type { LlmRuntime } from './runtime.js'`；函数第一参数 `model: LanguageModel` → `llm: LlmRuntime`；调用处 `callStructured({ model, name: ..., ... })` → `llm.call({ name: ..., ... })`（去掉 model 字段，其余参数不变）；删除现在多余的 `callStructured` import（保留 `CallStructuredResult` type import）。三个文件同构改法。以 identifyMedia 为例，改动后的调用尾部：

```ts
  return llm.call({
    name: 'report_identity',
    description: 'Report the identified media', prompt, schema: MediaIdentitySchema,
  })
```

- [ ] **Step 2: CLI 接线** `src/cli/index.ts`

- import 增加：`import { createLlmRuntime } from '../agent/runtime.js'`、`import { ProfileStore } from '../agent/profile.js'`；删除 `makeModel` import（不再直接用）。
- 替换 `const model = makeModel({...})` 为：

```ts
  const profileStore = new ProfileStore(join(cacheRoot, 'llm-profiles'))
  const llm = await createLlmRuntime({
    baseUrl: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    model: requireEnv('LLM_MODEL'),
    extraBody,
  }, profileStore)
```

- deps 中三个判断点闭包 `identifyMedia(model, c)` → `identifyMedia(llm, c)`，其余两个同理。
- journalReady 回调中追加档案记录：

```ts
    journalReady: j => { journalRef = j; j.step('llm_profile', llm.profileInfo()) },
```

- [ ] **Step 3: 验证** — Run: `npm run check && npm test` — Expected: 全绿（pipeline 测试注入的是闭包 fake，不感知本次改动）。再跑无凭据 CLI 冒烟：`npx tsx src/cli/index.ts 2>&1; echo exit=$?` — Expected: usage 报错，exit=2。

- [ ] **Step 4: 提交**

```bash
git add src/agent/ src/cli/
git commit -m "feat: judgment points and CLI use self-adapting llm runtime"
```

---

### Task 6: 真实验证（controller 持凭据执行，不派子代理）+ 文档

**Files:**
- Modify: `README.md`, `.env.example`

- [ ] **Step 1: 真实探测验证（controller）**

用独立缓存目录跑三组配置，检查 journal 的 `llm_profile` step 与最终行为：

1. MiMo（`mimo-v2.5`，SGP 端点，无 LLM_EXTRA_BODY）→ 期望 `mode: forced-tool`，探测只发生在第一次运行（第二次运行同缓存目录应无探针调用，可从耗时/日志判断）。
2. DeepSeek 裸三凭证（`deepseek-v4-flash`，无 LLM_EXTRA_BODY）→ 期望自动 `mode: forced-tool-quirk, quirkId: deepseek-thinking-disabled`，全链路走到 download/ask_user（当前网络 download 会 fetch failed，属已知环境问题，llm_profile 正确即算通过）。
3. DeepSeek + 手工 `LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` → 期望 `quirkId: manual-extra-body`，跳过探测。

- [ ] **Step 2: 文档更新**

README 配置表：`LLM_EXTRA_BODY` 行说明改为"（可选，高级）跳过自动探测、强制注入请求体。正常情况下无需配置——subtitle-scout 自动探测 provider 怪癖"。新增一段"自动适配"简述探针阶梯与降级模式。`.env.example` 的 `LLM_EXTRA_BODY` 注释同步改为可选/高级语气。

- [ ] **Step 3: 提交**

```bash
git add README.md .env.example
git commit -m "docs: auto-adaptation notes; LLM_EXTRA_BODY demoted to advanced override"
```

---

## Self-Review 结果（已执行）

- **Spec 覆盖**：探针阶梯(T3)、档案库 seed 三条(T1)、持久化+TTL+invalidate(T1)、运行时自愈(T4)、manual override 跳过探测(T4)、Mode3 prompt-JSON + Zod + gate 不变(T2/既有 gate 未动)、journal 记 profile(T5)、真实验证三组(T6)、LiteLLM 定位(文档，spec 已写)。спec"探针 schema 极简"由 `PROBE_SCHEMA={ok:boolean}` 落实。
- **占位符扫描**：无。
- **类型一致性**：`LlmProfile`(T1) ↔ probe 返回(T3) ↔ runtime 消费(T4)；`RuntimeCallOpts` 即 `CallStructuredOpts` 去 model，判断点(T5)调用形状与之吻合；`isToolChoiceRejection`(T2) 为 T3 测试与 T4 自愈共用。
