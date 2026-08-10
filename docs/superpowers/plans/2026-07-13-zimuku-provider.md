# Zimuku Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `zimuku` as a second subtitle provider (alongside `assrt`/`opensubtitles`), covering the full chain — Yunsuo (云锁) WAF challenge detection/solving via a numeric-CAPTCHA LLM-vision agent, HTTP search/detail parsing, cookie-cached session reuse, and archive download with browser headers — landing candidates on the exact same `FetchAdapter` → `providerPort` → `pipeline.ts` staging/verify/install rails that `assrt` and `opensubtitles` already use, with zero changes to that staging pipeline itself.

**Architecture:** HTTP-client-first, no browser (per `docs/design/2026-07-13-zimuku-provider-design.md`). A standalone Yunsuo WAF module (`yunsuo.ts`) detects/parses/solves the "网站防火墙" challenge page via an injected `fetchImpl` and an injected `solve` callback (decoupled from the LLM). A `ZimukuClient` wraps it with a disk-cached session cookie (`ZimukuSessionStore`, invalidated by response not by clock) and a `MinIntervalLimiter` (reused from `assrt.ts`) for politeness. A `solveNumericCaptcha` agent reads the CAPTCHA PNG via a new multimodal extension to the existing LLM runtime (`images?: Buffer[]` threaded through `callStructured`/`callPromptJson`/`RuntimeCallOpts`). A `zimukuAdapter.ts` `FetchAdapter` wraps the client and returns provider-neutral `SubtitleCandidate`s with an empty `fileList` (zimuku doesn't expose archive contents pre-download — same shape as OpenSubtitles' single-file candidates) and a `.zip` filename from `resolve()` so `writeSubtitle`'s existing zip-pick logic fires automatically. Because `resolveDownload` crosses the CLI-subprocess boundary (`providerPort.ts` spawns `subtitle-fetch.ts` and only gets `{url, filename}` back over stdout JSON), the archive-download browser headers (UA / `Accept-Language: zh-CN` / `Referer`) travel as a new optional `headers` field on the resolve-result shape, threaded through `ProviderPort` → `PipelineDeps.download` → `downloadDirect`.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest, Zod v4, `ai@^7` + `@ai-sdk/openai-compatible@^3` (multimodal `generateText` with `{type:'file', data, mediaType:'image/png'}` message parts — verified experimentally against this repo's installed `ai`/`ai/test` packages before writing this plan), `adm-zip` (already a dependency, used only via the existing `writeSubtitle`/`pickFromZip` path — no new code touches it). No new dependencies are introduced by this plan.

> **Verification discipline for every task below — read this before starting Task 1:**
> - `npx vitest run <file>` does **NOT** type-check. Vitest transforms TypeScript with esbuild, which strips types without validating them — a test file can go fully green while the surrounding `.ts` files fail `tsc`. Every task's final verification step runs **both** `npx vitest run <file>` **and** `npm run check` (== `tsc --noEmit` over the whole repo). Don't defer the `tsc` check to the end of the plan — a type error introduced in Task 3 that isn't caught until Task 20's `npm run check` is a much worse debugging session than catching it immediately after Task 3.
> - Every "run the test, confirm it fails" step must confirm **RED for the right reason**. Read the actual failure output. A test failing because of a typo in the test file itself (wrong import path, wrong fixture path) is not the same as a test failing because the implementation doesn't exist yet. If the failure text doesn't match what this plan says to expect (e.g. `Cannot find module` when the plan says to expect `AssertionError` / `is not a function`), stop and fix the test before writing implementation code — don't paper over a broken RED with an implementation.
> - **All tests added by this plan are offline.** Every network call in every test is either an injected `fetchImpl` mock or a fixture file read from `fixtures/zimuku/`. **Never** let a test hit the real `zimuku.org` — not even by accident (e.g. a stray `fetch()` call with no injected `fetchImpl`, or a default parameter that silently falls back to the real `fetch` global). The three HTML fixtures this plan creates (`fixtures/zimuku/challenge.html`, `search-spy-family.html`, `detail-58421.html`) are **hand-authored from documented evidence** in the design doc (marker strings `YunsuoAutoJump`, `security_verify_img`, cookie name `security_session_verify`, and a community-script-referenced `id="down"` download-button convention) — they are not a live capture, because this plan was written read-only without touching zimuku.org. See the **Backlog** section at the end of this plan for the one manual/live-capture verification pass that must happen, by a human, before flipping `ZIMUKU_ENABLED=true` in production. That pass is explicitly *not* part of the automated test suite this plan builds.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/agent/llm.ts` (modify) | Build a multimodal `prompt` (text + image file parts) for `callStructured`/`callPromptJson` when `opts.images` is present; string prompt unchanged otherwise. |
| `src/agent/llm.test.ts` (modify) | New cases proving images reach the model call, and that omitting `images` leaves existing text-only behavior untouched. |
| `src/agent/runtime.ts` (modify) | Add `images?: Buffer[]` to `RuntimeCallOpts` (already spread through to `llm.ts` by the existing `defaultInternals()` — no dispatch logic changes needed). |
| `src/agent/runtime.test.ts` (modify) | Prove `images` threads from `LlmRuntime.call()` to `RuntimeInternals.callForcedTool`. |
| `src/agent/solveNumericCaptcha.ts` (new) | LLM-vision agent: PNG bytes → `{digits: string}` (3–6 digits, no confidence field). |
| `src/agent/solveNumericCaptcha.test.ts` (new) | Prompt/schema/threading tests, fake `LlmRuntime`. |
| `src/adapters/providers/yunsuo.ts` (new) | Yunsuo WAF module: `detectChallenge`, `parseChallenge` (generic form parser, not tied to guessed field names), `solveYunsuoChallenge` (bounded retry, cookie extraction), `ZimukuChallengeError`. LLM-decoupled — takes an injected `solve` callback. |
| `src/adapters/providers/yunsuo.test.ts` (new) | Offline tests against a hand-authored challenge-page fixture. |
| `src/adapters/providers/zimukuSession.ts` (new) | `ZimukuSessionStore` — single-entry disk-cached cookie, atomic write, `invalidate()` (no TTL; invalidation is response-driven per the design doc). |
| `src/adapters/providers/zimukuSession.test.ts` (new) | Round-trip / invalidate / corrupt-file tests. |
| `src/adapters/providers/zimuku.ts` (new) | `ZimukuClient` (search/detail, WAF-aware request layer, `MinIntervalLimiter` reuse from `assrt.ts`), `parseSearchResults`, `parseDetailPage`. |
| `src/adapters/providers/zimuku.test.ts` (new) | Parser + client tests against fixtures, offline `fetchImpl` mocks. |
| `src/cli/adapters/zimukuAdapter.ts` (new) | `FetchAdapter` factory wrapping `ZimukuClient` — mirrors `assrtAdapter.ts`/`opensubtitlesAdapter.ts`. |
| `src/cli/adapters/zimukuAdapter.test.ts` (new) | search()/resolve() contract tests with a fake client. |
| `src/cli/adapters/zimukuAdapter.integration.test.ts` (new) | Full offline chain: challenge → solve → search → resolve → download → unzip → write, through `runSearch`/`runResolve`/`downloadDirect`/`writeSubtitle`. |
| `src/core/schemas.ts` (modify) | `PROVIDERS` gains `'zimuku'`. |
| `src/core/schemas.test.ts` (modify) | Registry + `SubtitleCandidateSchema`/`parseCandidateKey` cases for `'zimuku'`. |
| `src/adapters/download/direct.ts` (modify) | `DownloadOpts.headers?: Record<string,string>`, forwarded into the `fetch` call. |
| `src/adapters/download/direct.test.ts` (modify) | Headers forwarded when given, omitted when not. |
| `src/core/providerPort.ts` (modify) | `ResolveOutSchema`/`ProviderPort.resolveDownload` return type gains optional `headers`. |
| `src/core/providerPort.test.ts` (modify) | Headers parse through the CLI-subprocess stdout JSON boundary. |
| `src/cli/fetchLib.ts` (modify) | `FetchAdapter.resolve`/`runResolve` return type gains optional `headers`; "no providers configured" message mentions `ZIMUKU_ENABLED`. |
| `src/cli/fetchLib.test.ts` (modify) | Headers pass-through; updated config-error message text. |
| `src/core/pipeline.ts` (modify) | `PipelineDeps.download` gains an optional `headers` parameter; all 4 `deps.download(resolved.url)` call sites become `deps.download(resolved.url, resolved.headers)`. |
| `src/core/pipeline.test.ts` (modify) | Headers threaded to `deps.download` when the provider port supplies them; `undefined` otherwise (existing behavior). |
| `src/cli/index.ts` (modify) | `download:` dep wiring passes `headers` through to `downloadDirect`; `cmdDoctor()` gains a zimuku probe block. |
| `src/cli/subtitle-fetch.ts` (modify) | `buildAdapters()` becomes `async`, registers `zimukuAdapter` behind `ZIMUKU_ENABLED=true`, constructs an `LlmRuntime` for captcha solving. |
| `src/cli/subtitle-fetch.test.ts` (modify) | `ZIMUKU_ENABLED=true` with missing LLM config fails fast with a clear message, offline (no network attempted). |
| `src/cli/doctor.ts` (modify) | `checkZimuku()` — skip when disabled; when enabled, probe homepage reachability (a Yunsuo challenge response is a **healthy** signal, not a failure). |
| `src/cli/doctor.test.ts` (modify) | skip / ok-not-challenged / ok-challenged / unreachable cases. |
| `.env.example` (modify) | Document `ZIMUKU_ENABLED` (default off — grey-area site, opt-in). |
| `fixtures/zimuku/challenge.html` (new) | Hand-authored Yunsuo challenge page fixture. |
| `fixtures/zimuku/search-spy-family.html` (new) | Hand-authored zimuku search-results fixture. |
| `fixtures/zimuku/detail-58421.html` (new) | Hand-authored zimuku detail-page fixture. |

---

## Phase A — Multimodal LLM entry + solveNumericCaptcha agent

### Task 1: `callStructured` accepts optional image bytes

**Files:**
- Modify: `src/agent/llm.ts`
- Test: `src/agent/llm.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/agent/llm.test.ts`, right after the existing `describe('callStructured', ...)` block (before `describe('injectExtraBody', ...)`):

```typescript
describe('callStructured with images (multimodal captcha solving)', () => {
  it('sends the image as a file part alongside the text prompt when opts.images is provided', async () => {
    let receivedPrompt: unknown
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        receivedPrompt = (options as { prompt: unknown }).prompt
        return {
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'report', input: JSON.stringify({ digits: '74504' }) },
          ],
          warnings: [],
        }
      },
    })
    const png = Buffer.from('fake-png-bytes')
    const r = await callStructured({
      model, name: 'report', description: 'd', prompt: 'read the digits',
      schema: z.object({ digits: z.string() }), images: [png],
    })
    expect(r.parsed).toEqual({ digits: '74504' })
    const messages = receivedPrompt as Array<{ role: string; content: Array<{ type: string; data?: unknown; mediaType?: string }> }>
    expect(messages[0].role).toBe('user')
    expect(messages[0].content[0]).toEqual({ type: 'text', text: 'read the digits' })
    expect(messages[0].content[1].type).toBe('file')
    expect(messages[0].content[1].mediaType).toBe('image/png')
  })

  it('falls back to a plain string prompt when opts.images is omitted (existing text-only callers unaffected)', async () => {
    let receivedPrompt: unknown
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        receivedPrompt = (options as { prompt: unknown }).prompt
        return {
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'report', input: JSON.stringify({ title: 'x', year: 1 }) },
          ],
          warnings: [],
        }
      },
    })
    await callStructured({ model, name: 'report', description: 'd', prompt: 'identify', schema })
    expect(typeof receivedPrompt).toBe('string')
    expect(receivedPrompt).toBe('identify')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/llm.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'images' does not exist in type...` (or, since vitest doesn't type-check, a runtime failure: the first test's assertion on `messages[0].content[1].type` throws because `receivedPrompt` is the plain string `'read the digits'`, not an array — `TypeError: Cannot read properties of undefined` or similar). Confirm the failure is about images not being wired in, not a typo elsewhere in the test.

- [ ] **Step 3: Implement**

In `src/agent/llm.ts`, add `images` to `CallStructuredOpts` (right after `maxOutputTokens?: number`):

```typescript
export interface CallStructuredOpts<S extends z.ZodType> {
  model: LanguageModel
  name: string
  description: string
  prompt: string
  schema: S
  maxOutputTokens?: number
  /** 附加图片(如验证码 PNG 字节)供多模态模型识别；省略则走纯文本 prompt。目前仅
   *  solveNumericCaptcha 使用。 */
  images?: Buffer[]
}
```

Add a helper function right above `callStructured` (after the `isRawToolChoiceApiError` function, before the `callStructured` export):

```typescript
/** 有图片时把 prompt 包成单条 user message(text part + file parts),走多模态;无图片原样
 *  返回字符串——generateText 的 prompt 参数本就接受 string | ModelMessage[] 两种形状(ai@7)。
 *  用 {type:'file', data, mediaType} 而不是已弃用的 {type:'image', image}(实测 ai@7.0.15 对
 *  后者打 deprecation warning)。 */
function buildPrompt(text: string, images?: Buffer[]): string | ModelMessage[] {
  if (!images || images.length === 0) return text
  return [{
    role: 'user',
    content: [
      { type: 'text', text },
      ...images.map(image => ({ type: 'file' as const, data: image, mediaType: 'image/png' })),
    ],
  }]
}
```

Add `ModelMessage` to the `ai` import at the top of the file:

```typescript
import { generateText, tool, type LanguageModel, type ModelMessage } from 'ai'
```

Inside `callStructured`'s retry loop, change the `generateText` call's `prompt` field from `prompt` to `buildPrompt(prompt, opts.images)`:

```typescript
      result = await generateText({
        model: opts.model,
        prompt: buildPrompt(prompt, opts.images),
        tools: {
          [opts.name]: tool({
            description: opts.description,
            inputSchema: opts.schema,
          }),
        },
        toolChoice: { type: 'tool', toolName: opts.name },
        maxOutputTokens: opts.maxOutputTokens ?? 16000,
        abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/llm.test.ts && npm run check`
Expected: PASS — all `llm.test.ts` cases green (including the two new ones and every pre-existing case), and `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm.ts src/agent/llm.test.ts
git commit -m "feat(llm): multimodal images support in callStructured"
```

---

### Task 2: `callPromptJson` accepts the same optional image bytes

**Files:**
- Modify: `src/agent/llm.ts`
- Test: `src/agent/llm.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('callPromptJson', ...)` block in `src/agent/llm.test.ts` (as one more `it()`, after the `'throws StructuredOutputError after retry exhausted'` case):

```typescript
  it('sends the image as a file part when opts.images is provided (mode 3 fallback also supports multimodal)', async () => {
    let receivedPrompt: unknown
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        receivedPrompt = (options as { prompt: unknown }).prompt
        return {
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: undefined, reasoning: undefined },
          },
          content: [{ type: 'text', text: '{"digits":"74504"}' }],
          warnings: [],
        }
      },
    })
    const png = Buffer.from('fake-png-bytes')
    const { callPromptJson } = await import('./llm.js')
    const r = await callPromptJson({
      model: model as never, name: 'report', description: 'd', prompt: 'read the digits',
      schema: z.object({ digits: z.string() }), images: [png],
    })
    expect(r.parsed).toEqual({ digits: '74504' })
    const messages = receivedPrompt as Array<{ content: Array<{ type: string }> }>
    expect(messages[0].content.some(p => p.type === 'file')).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/llm.test.ts`
Expected: FAIL — `receivedPrompt` is a plain string (the JSON-schema-appended text prompt), so `messages[0]` is `undefined` and the test throws a `TypeError` trying to read `.content` off it.

- [ ] **Step 3: Implement**

In `src/agent/llm.ts`, inside `callPromptJson`, change the `generateText` call's `prompt` field from `prompt` to `buildPrompt(prompt, opts.images)` (reusing the `buildPrompt` helper added in Task 1):

```typescript
    const result = await generateText({
      model: opts.model,
      prompt: buildPrompt(prompt, opts.images),
      maxOutputTokens: opts.maxOutputTokens ?? 16000,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/llm.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/llm.ts src/agent/llm.test.ts
git commit -m "feat(llm): multimodal images support in callPromptJson"
```

---

### Task 3: `RuntimeCallOpts` threads `images` through to `llm.ts`

**Files:**
- Modify: `src/agent/runtime.ts`
- Test: `src/agent/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add inside `describe('createLlmRuntime', ...)` in `src/agent/runtime.test.ts`, after the `'passes the profile extraBody to forced-tool calls'` case:

```typescript
  it('threads opts.images through to callForcedTool (multimodal captcha solving)', async () => {
    const s = store()
    const ints = internals()
    const rt = await createLlmRuntime(cfg, s, ints)
    const png = Buffer.from('fake-png-bytes')
    await rt.call({ ...callOpts, images: [png] })
    expect(ints.callForcedTool).toHaveBeenCalledWith(
      cfg, undefined, expect.objectContaining({ images: [png] }),
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/runtime.test.ts`
Expected: FAIL with a TypeScript-shaped runtime complaint is not what you'll see (vitest doesn't type-check) — instead expect an assertion failure: `ints.callForcedTool` was called with an opts object that does NOT contain `images` (vitest will report `expect(received).toHaveBeenCalledWith(...)` failing to match) OR — if `RuntimeCallOpts` doesn't declare `images` yet, TypeScript would normally reject `{ ...callOpts, images: [png] }` at compile time, but since vitest skips type-checking, the extra property is just silently present on the object at runtime and passed straight through by the existing `...opts` spread in `defaultInternals()`. In that case this test may actually pass immediately without any implementation change. **This is expected** — read Step 3 before assuming something's wrong.

- [ ] **Step 3: Implement**

In `src/agent/runtime.ts`, add `images` to `RuntimeCallOpts` (right after `maxOutputTokens?: number`):

```typescript
export interface RuntimeCallOpts<S extends z.ZodType> {
  name: string
  description: string
  prompt: string
  schema: S
  maxOutputTokens?: number
  /** 透传给 llm.ts 的 callStructured/callPromptJson——见 agent/solveNumericCaptcha.ts。
   *  defaultInternals() 的 callForcedTool/callPromptJson 已经 `...opts` 展开转发,这里只是
   *  补上类型声明,让 TypeScript 承认这个字段合法(而不是悄悄允许多余属性透传)。 */
  images?: Buffer[]
}
```

No other changes needed — `defaultInternals()`'s `callForcedTool: (cfg, extraBody, opts) => callStructured({ model: makeModel({ ...cfg, extraBody }), ...opts })` already spreads `opts` (which now includes `images`) straight into `callStructured`'s opts object from Task 1.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/runtime.test.ts && npm run check`
Expected: PASS. The `tsc --noEmit` run is the one that actually matters here — before this step, `{ ...callOpts, images: [png] }` in the test file would have failed `tsc` (excess property on an object literal spread into a typed parameter is usually still checked because `rt.call<S>(opts: RuntimeCallOpts<S>)` is a generic call, so TS structurally checks the whole shape); after adding the field, `tsc --noEmit` goes clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent/runtime.ts src/agent/runtime.test.ts
git commit -m "feat(runtime): thread images through RuntimeCallOpts"
```

---

### Task 4: `solveNumericCaptcha` agent

**Files:**
- Create: `src/agent/solveNumericCaptcha.ts`
- Test: `src/agent/solveNumericCaptcha.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/agent/solveNumericCaptcha.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { solveNumericCaptcha, SolveNumericCaptchaSchema } from './solveNumericCaptcha.js'
import type { LlmRuntime, RuntimeCallOpts } from './runtime.js'

function capture(): { llm: LlmRuntime; opts: () => RuntimeCallOpts<typeof SolveNumericCaptchaSchema> } {
  let captured!: RuntimeCallOpts<typeof SolveNumericCaptchaSchema>
  const llm: LlmRuntime = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async call(opts: any) {
      captured = opts
      return { parsed: { digits: '74504' }, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt }
    },
    profileInfo: () => ({ mode: 'test' }),
  }
  return { llm, opts: () => captured }
}

describe('solveNumericCaptcha', () => {
  it('passes the image bytes through to llm.call as images: [imageBytes]', async () => {
    const { llm, opts } = capture()
    const png = Buffer.from('fake-png-bytes')
    await solveNumericCaptcha(llm, png)
    expect(opts().images).toEqual([png])
  })

  it('uses the SolveNumericCaptchaSchema (digits-only, no confidence field)', async () => {
    const { llm, opts } = capture()
    await solveNumericCaptcha(llm, Buffer.from('x'))
    expect(opts().schema).toBe(SolveNumericCaptchaSchema)
  })

  it('prompt asks for 3-6 digits with no confidence hedging', async () => {
    const { llm, opts } = capture()
    await solveNumericCaptcha(llm, Buffer.from('x'))
    expect(opts().prompt).toMatch(/3 to 6/)
    expect(opts().prompt.toLowerCase()).not.toContain('confidence')
  })

  it('returns the parsed {digits} from the LLM call', async () => {
    const { llm } = capture()
    const r = await solveNumericCaptcha(llm, Buffer.from('x'))
    expect(r.parsed).toEqual({ digits: '74504' })
  })
})

describe('SolveNumericCaptchaSchema', () => {
  it('accepts 3-6 digit strings', () => {
    expect(SolveNumericCaptchaSchema.parse({ digits: '745' }).digits).toBe('745')
    expect(SolveNumericCaptchaSchema.parse({ digits: '123456' }).digits).toBe('123456')
  })
  it('rejects non-digit or out-of-range lengths', () => {
    expect(() => SolveNumericCaptchaSchema.parse({ digits: '12' })).toThrow()
    expect(() => SolveNumericCaptchaSchema.parse({ digits: '1234567' })).toThrow()
    expect(() => SolveNumericCaptchaSchema.parse({ digits: 'abcde' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/solveNumericCaptcha.test.ts`
Expected: FAIL — `Cannot find module './solveNumericCaptcha.js'` (the file doesn't exist yet).

- [ ] **Step 3: Implement**

Create `src/agent/solveNumericCaptcha.ts`:

```typescript
import { z } from 'zod'
import type { LlmRuntime } from './runtime.js'
import type { CallStructuredResult } from './llm.js'

export const SolveNumericCaptchaSchema = z.object({
  digits: z.string().regex(/^\d{3,6}$/),
})
export type SolveNumericCaptcha = z.infer<typeof SolveNumericCaptchaSchema>

/** 云锁验证码识别:5 位纯数字像素图(样例见设计文档),无扭曲/无干扰线/无粘连——多模态模型
 *  直读即可,不需要置信度("无计算器"公理同款:让模型给出它最好的单次读数,读错了由上游
 *  yunsuo.ts 的有界重试兜底重刷验证码,不是靠模型自报"我不确定"来决定要不要重试)。 */
export async function solveNumericCaptcha(
  llm: LlmRuntime, imageBytes: Buffer,
): Promise<CallStructuredResult<SolveNumericCaptcha>> {
  const prompt = [
    'This image is a CAPTCHA challenge from a website: a short sequence of PLAIN, UNDISTORTED digits',
    'on a noisy or colored background (no overlapping strokes, no rotation, no connected characters).',
    'Read the digits exactly as printed, left to right, and report them as a single string of 3 to 6',
    'digits — no spaces, no letters, no punctuation.',
    '',
    'Give your best single reading even if part of the image is unclear — there is no confidence field',
    'to hedge with. A wrong reading just fails validation upstream and the caller retries with a freshly',
    'refreshed CAPTCHA image; there is no penalty for guessing wrong beyond that retry.',
  ].join('\n')
  return llm.call({
    name: 'report_captcha_digits',
    description: 'Report the digit sequence shown in the CAPTCHA image',
    prompt, schema: SolveNumericCaptchaSchema, images: [imageBytes],
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agent/solveNumericCaptcha.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/solveNumericCaptcha.ts src/agent/solveNumericCaptcha.test.ts
git commit -m "feat(agent): add solveNumericCaptcha vision agent"
```

---

## Phase B — Yunsuo WAF module

### Task 5: `detectChallenge`

**Files:**
- Create: `src/adapters/providers/yunsuo.ts`
- Test: `src/adapters/providers/yunsuo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/providers/yunsuo.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { detectChallenge } from './yunsuo.js'

describe('detectChallenge', () => {
  it('detects the YunsuoAutoJump marker', () => {
    expect(detectChallenge('<script>function YunsuoAutoJump(){}</script>')).toBe(true)
  })
  it('detects the security_verify_img marker', () => {
    expect(detectChallenge('<img src="/x/security_verify_img?r=1">')).toBe(true)
  })
  it('returns false for ordinary content pages', () => {
    expect(detectChallenge('<html><body><h1>间谍过家家 第一季</h1></body></html>')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts`
Expected: FAIL — `Cannot find module './yunsuo.js'`.

- [ ] **Step 3: Implement**

Create `src/adapters/providers/yunsuo.ts`:

```typescript
/**
 * 云锁(Yunsuo)WAF 破解模块——zimuku.org 命中的"网站防火墙"中间页处理。与 LLM/zimuku 客户端
 * 解耦:验证码识别通过注入的 solve 回调完成(生产接线用 solveNumericCaptcha,测试注入假实现),
 * 网络请求通过注入的 fetchImpl 完成,全部离线可测。
 *
 * 挑战页特征(实测证据,见 docs/design/2026-07-13-zimuku-provider-design.md):
 * body 含 "YunsuoAutoJump"(JS 跳转函数名)或 "security_verify_img"(验证码图片标记)。
 */

export function detectChallenge(html: string): boolean {
  return /YunsuoAutoJump|security_verify_img/.test(html)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/yunsuo.ts src/adapters/providers/yunsuo.test.ts
git commit -m "feat(yunsuo): detectChallenge for Yunsuo WAF challenge pages"
```

---

### Task 6: `parseChallenge` + challenge-page fixture

**Files:**
- Modify: `src/adapters/providers/yunsuo.ts`
- Create: `fixtures/zimuku/challenge.html`
- Modify: `src/adapters/providers/yunsuo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `fixtures/zimuku/challenge.html`:

```html
<!DOCTYPE html>
<html>
<head><title>网站防火墙</title></head>
<body>
<script type="text/javascript">function YunsuoAutoJump(){ location.href = document.referrer; }</script>
<div class="waf-challenge">
  <form id="checkform" action="/aq_wzws_confirm.html" method="post">
    <input type="hidden" name="wzws_sessionid" value="8f2c9a1b3e4d5f60" />
    <input type="hidden" name="return_url" value="/detail/58421.html" />
    <img src="/aq_wzws_security_verify_img?r=0.483920" alt="verify code" />
    <input type="text" name="sec_code" maxlength="6" />
    <button type="submit">提交验证</button>
  </form>
</div>
</body>
</html>
```

Add to `src/adapters/providers/yunsuo.test.ts` (new imports at the top, new describe block at the bottom):

```typescript
import { readFileSync } from 'node:fs'
import { parseChallenge } from './yunsuo.js'
```

```typescript
describe('parseChallenge', () => {
  const html = readFileSync('fixtures/zimuku/challenge.html', 'utf8')

  it('extracts the absolute form action', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.action).toBe('https://www.zimuku.org/aq_wzws_confirm.html')
  })
  it('extracts hidden fields verbatim', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.fields).toEqual({ wzws_sessionid: '8f2c9a1b3e4d5f60', return_url: '/detail/58421.html' })
  })
  it('extracts the captcha text input name', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.captchaFieldName).toBe('sec_code')
  })
  it('extracts the absolute captcha image url', () => {
    const form = parseChallenge(html, 'https://www.zimuku.org')
    expect(form.imageUrl).toBe('https://www.zimuku.org/aq_wzws_security_verify_img?r=0.483920')
  })
  it('throws when the page has no form (unexpected challenge shape)', () => {
    expect(() => parseChallenge('<html><body>no form here</body></html>', 'https://www.zimuku.org'))
      .toThrow(/no <form/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts`
Expected: FAIL — `(0 , yunsuo_js_1.parseChallenge) is not a function` / `parseChallenge is not exported`.

- [ ] **Step 3: Implement**

Add to `src/adapters/providers/yunsuo.ts` (after `detectChallenge`):

```typescript
export interface YunsuoChallengeForm {
  /** 表单提交的绝对 URL(相对路径已相对 baseUrl 解析) */
  action: string
  /** 表单里除验证码输入框外的所有字段(隐藏 token 等),提交时原样带上 */
  fields: Record<string, string>
  /** 用户输入验证码数字的那个 <input> 的 name 属性 */
  captchaFieldName: string
  /** 验证码图片的绝对 URL */
  imageUrl: string
}

/**
 * 解析挑战页的表单结构:不依赖具体字段名(真实云锁部署的字段名未经实地抓包确认),只依赖
 * 通用 HTML 表单形状——<form action=...>、<input type="hidden" name=... value=...>(原样透传的
 * token)、<input type="text" name=...>(验证码填空框)、<img src=...>(验证码图)。只要挑战页
 * 是标准表单,这份解析就适用,不绑定猜测的具体字段名。
 */
export function parseChallenge(html: string, baseUrl: string): YunsuoChallengeForm {
  const formMatch = html.match(/<form[^>]*action="([^"]+)"/)
  if (!formMatch) throw new Error('yunsuo challenge page has no <form action=...> — unexpected challenge page shape')
  const action = new URL(formMatch[1], baseUrl).toString()

  const fields: Record<string, string> = {}
  const hiddenRe = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = hiddenRe.exec(html))) fields[m[1]] = m[2]

  const captchaFieldMatch = html.match(/<input[^>]*type="text"[^>]*name="([^"]+)"/)
  if (!captchaFieldMatch) throw new Error('yunsuo challenge page has no captcha text <input> — unexpected challenge page shape')

  const imgMatch = html.match(/<img[^>]*src="([^"]+)"/)
  if (!imgMatch) throw new Error('yunsuo challenge page has no captcha <img src=...> — unexpected challenge page shape')
  const imageUrl = new URL(imgMatch[1], baseUrl).toString()

  return { action, fields, captchaFieldName: captchaFieldMatch[1], imageUrl }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/yunsuo.ts src/adapters/providers/yunsuo.test.ts fixtures/zimuku/challenge.html
git commit -m "feat(yunsuo): parseChallenge extracts WAF form/captcha/action"
```

---

### Task 7: `solveYunsuoChallenge` happy path

**Files:**
- Modify: `src/adapters/providers/yunsuo.ts`
- Modify: `src/adapters/providers/yunsuo.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the top of `src/adapters/providers/yunsuo.test.ts` imports:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { detectChallenge, parseChallenge, solveYunsuoChallenge, ZimukuChallengeError } from './yunsuo.js'
```

(By this point the file has three separate import lines from Tasks 5–6: `import { describe, it, expect } from 'vitest'`, `import { detectChallenge } from './yunsuo.js'`, and `import { parseChallenge } from './yunsuo.js'`. Replace **all three** with the two consolidated lines above — merging `detectChallenge` and `parseChallenge` into one `./yunsuo.js` import is required, not optional: leaving both the old `import { detectChallenge } from './yunsuo.js'` line and the new line that also imports `detectChallenge` would produce a TS2300 "Duplicate identifier" error.)

Add a new describe block at the end of the file:

```typescript
describe('solveYunsuoChallenge', () => {
  const html = readFileSync('fixtures/zimuku/challenge.html', 'utf8')

  it('fetches the captcha image, calls solve, submits digits, and returns the security_session_verify cookie on first try', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('security_verify_img')) {
        return new Response(Buffer.from('fake-png-bytes'))
      }
      expect(init?.method).toBe('POST')
      const body = new URLSearchParams(init!.body as URLSearchParams)
      expect(body.get('wzws_sessionid')).toBe('8f2c9a1b3e4d5f60')
      expect(body.get('sec_code')).toBe('74504')
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=abc123; Path=/; HttpOnly' } })
    })
    const solve = vi.fn(async () => ({ digits: '74504' }))
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html,
    )
    expect(r.cookie).toBe('security_session_verify=abc123')
    expect(solve).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts`
Expected: FAIL — `solveYunsuoChallenge is not a function` / `ZimukuChallengeError is not a constructor`.

- [ ] **Step 3: Implement**

Add to `src/adapters/providers/yunsuo.ts` (after `parseChallenge`):

```typescript
/** 挑战破解耗尽/仍被拦截:瞬时错误,不是"确实没有字幕"的内容结论——上游 fetchLib.runSearch 的
 *  通用 catch 会把它转成 provider_error,pipeline.ts 的残缺候选集守卫据此拒写负缓存。 */
export class ZimukuChallengeError extends Error {}

function extractCookie(res: Response, name: string): string | null {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? '']
  for (const line of raw) {
    const m = line.match(new RegExp(`${name}=([^;]+)`))
    if (m) return `${name}=${m[1]}`
  }
  return null
}

export interface SolveYunsuoChallengeDeps {
  fetchImpl: typeof fetch
  /** 验证码识别回调——生产接线用 solveNumericCaptcha(llm, png),与 LLM 解耦,测试注入假实现 */
  solve: (imageBytes: Buffer) => Promise<{ digits: string }>
}

/**
 * 有界重试破解云锁验证码:抓图→识别→提交,拿到 security_session_verify cookie 即成功返回;
 * 提交被拒(cookie 没出现在响应里)则重刷验证码重试,最多 maxAttempts 次(默认 5,与设计文档
 * 一致)。攻击性节流:失败重试之间等待 retryDelayMs(默认 2s),绝不无延迟重试风暴。
 */
export async function solveYunsuoChallenge(
  deps: SolveYunsuoChallengeDeps, baseUrl: string, challengeHtml: string,
  maxAttempts = 5, retryDelayMs = 2000,
): Promise<{ cookie: string }> {
  const form = parseChallenge(challengeHtml, baseUrl)
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const imgRes = await deps.fetchImpl(form.imageUrl)
    const imgBytes = Buffer.from(await imgRes.arrayBuffer())
    const { digits } = await deps.solve(imgBytes)
    const body = new URLSearchParams({ ...form.fields, [form.captchaFieldName]: digits })
    const res = await deps.fetchImpl(form.action, { method: 'POST', body })
    const cookie = extractCookie(res, 'security_session_verify')
    if (cookie) return { cookie }
    lastError = `attempt ${attempt}: no security_session_verify cookie in response (wrong digits?)`
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, retryDelayMs))
  }
  throw new ZimukuChallengeError(`yunsuo captcha solve exhausted after ${maxAttempts} attempts: ${lastError}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/yunsuo.ts src/adapters/providers/yunsuo.test.ts
git commit -m "feat(yunsuo): solveYunsuoChallenge happy path"
```

---

### Task 8: bounded retries + `ZimukuChallengeError` on exhaustion

**Files:**
- Modify: `src/adapters/providers/yunsuo.test.ts` (no further production code changes — Task 7's implementation already handles this; this task exists to prove it)

- [ ] **Step 1: Write the failing test**

Add two more `it()`s inside `describe('solveYunsuoChallenge', ...)` in `src/adapters/providers/yunsuo.test.ts`:

```typescript
  it('retries with a fresh captcha on a wrong-digits rejection, up to maxAttempts, then throws ZimukuChallengeError', async () => {
    let submitCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) return new Response(Buffer.from('png'))
      submitCount++
      return new Response('rejected') // no set-cookie header → treated as wrong digits
    })
    const solve = vi.fn(async () => ({ digits: '00000' }))
    await expect(
      solveYunsuoChallenge({ fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 3, 1),
    ).rejects.toThrow(ZimukuChallengeError)
    expect(submitCount).toBe(3) // 有界:恰好 maxAttempts 次提交,不多不少
  })

  it('succeeds on the Nth attempt after N-1 rejections (a fresh captcha image is fetched on every retry)', async () => {
    let imgFetches = 0
    let submitCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('security_verify_img')) { imgFetches++; return new Response(Buffer.from('png')) }
      submitCount++
      if (submitCount < 3) return new Response('rejected')
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=xyz; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '11111' }))
    const r = await solveYunsuoChallenge(
      { fetchImpl: fetchImpl as unknown as typeof fetch, solve }, 'https://www.zimuku.org', html, 5, 1,
    )
    expect(r.cookie).toBe('security_session_verify=xyz')
    expect(imgFetches).toBe(3)
    expect(submitCount).toBe(3)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts`
Expected: These should actually **pass immediately** — Task 7's implementation already contains the full bounded-retry loop. Run the file and confirm both new cases go green with zero production-code changes. **This is expected and correct** — Task 8 exists to lock this behavior in with its own explicit test coverage (retry count, fresh-image-per-attempt, exhaustion), not to drive new implementation. If either test fails, it means Task 7's loop doesn't actually retry/exhaust correctly — fix `solveYunsuoChallenge` before proceeding, don't adjust the test to match broken behavior.

- [ ] **Step 3: (no implementation step — behavior already exists from Task 7)**

- [ ] **Step 4: Run full file to confirm everything is green**

Run: `npx vitest run src/adapters/providers/yunsuo.test.ts && npm run check`
Expected: PASS — 12 total cases across `detectChallenge`/`parseChallenge`/`solveYunsuoChallenge`.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/yunsuo.test.ts
git commit -m "test(yunsuo): lock in bounded retry + ZimukuChallengeError on exhaustion"
```

---

## Phase C — zimuku client

### Task 9: `ZimukuSessionStore`

**Files:**
- Create: `src/adapters/providers/zimukuSession.ts`
- Test: `src/adapters/providers/zimukuSession.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/adapters/providers/zimukuSession.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZimukuSessionStore } from './zimukuSession.js'

describe('ZimukuSessionStore', () => {
  const store = () => new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-session-')))

  it('returns null when nothing cached yet', () => {
    expect(store().get()).toBeNull()
  })

  it('round-trips a session', () => {
    const s = store()
    s.put({ cookie: 'security_session_verify=abc123', capturedAt: 1000 })
    expect(s.get()).toEqual({ cookie: 'security_session_verify=abc123', capturedAt: 1000 })
  })

  it('invalidate clears the cached session', () => {
    const s = store()
    s.put({ cookie: 'security_session_verify=abc123', capturedAt: 1000 })
    s.invalidate()
    expect(s.get()).toBeNull()
  })

  it('treats a malformed cache file as a miss', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-session-'))
    const s = new ZimukuSessionStore(dir)
    s.put({ cookie: 'x', capturedAt: 1 })
    const f = readdirSync(dir).find(f => f.endsWith('.json'))!
    writeFileSync(join(dir, f), '{corrupt')
    expect(s.get()).toBeNull()
  })

  it('invalidate on an empty store is a no-op (no throw)', () => {
    expect(() => store().invalidate()).not.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/zimukuSession.test.ts`
Expected: FAIL — `Cannot find module './zimukuSession.js'`.

- [ ] **Step 3: Implement**

Create `src/adapters/providers/zimukuSession.ts`:

```typescript
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface ZimukuSession {
  cookie: string
  capturedAt: number
}

/**
 * zimuku 云锁会话 cookie 磁盘缓存——单文件、无 TTL 过期(云锁 security_session_verify 不绑 IP、
 * 可长期复用,实测证据见设计文档)。失效检测按响应而非计时:ZimukuClient 每次请求发现命中挑战页
 * 就调用 invalidate() 重破,而不是靠一个猜测的过期时间提前失效一个其实还有效的 cookie。
 * 原子写沿用 agent/profile.ts ProfileStore 的 tmp+rename 模式。
 */
export class ZimukuSessionStore {
  private path: string
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'session.json')
  }

  get(): ZimukuSession | null {
    if (!existsSync(this.path)) return null
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as ZimukuSession
    } catch {
      return null // 损坏文件 → 视作缓存未命中
    }
  }

  put(session: ZimukuSession): void {
    const tmpPath = `${this.path}.tmp`
    writeFileSync(tmpPath, JSON.stringify(session, null, 2))
    renameSync(tmpPath, this.path) // 原子操作(同 fs)
  }

  invalidate(): void {
    rmSync(this.path, { force: true })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/zimukuSession.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/zimukuSession.ts src/adapters/providers/zimukuSession.test.ts
git commit -m "feat(zimuku): ZimukuSessionStore disk-cached WAF cookie"
```

---

### Task 10: `parseSearchResults` + search fixture

**Files:**
- Create: `src/adapters/providers/zimuku.ts`
- Create: `fixtures/zimuku/search-spy-family.html`
- Create: `src/adapters/providers/zimuku.test.ts`

- [ ] **Step 1: Write the failing test**

Create `fixtures/zimuku/search-spy-family.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div class="persub clearfix">
  <div class="title"><a href="/detail/58421.html">间谍过家家 第一季 SPY×FAMILY</a></div>
</div>
<div class="persub clearfix">
  <div class="title"><a href="/detail/58422.html">间谍过家家 第二季 SPY×FAMILY Season 2</a></div>
</div>
</body>
</html>
```

Create `src/adapters/providers/zimuku.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSearchResults } from './zimuku.js'

describe('parseSearchResults', () => {
  it('extracts id + title from every /detail/<id>.html anchor', () => {
    const html = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const results = parseSearchResults(html)
    expect(results).toEqual([
      { id: '58421', title: '间谍过家家 第一季 SPY×FAMILY' },
      { id: '58422', title: '间谍过家家 第二季 SPY×FAMILY Season 2' },
    ])
  })

  it('returns an empty array for a page with no results', () => {
    expect(parseSearchResults('<html><body>没有找到相关字幕</body></html>')).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts`
Expected: FAIL — `Cannot find module './zimuku.js'`.

- [ ] **Step 3: Implement**

Create `src/adapters/providers/zimuku.ts`:

```typescript
export const ZIMUKU_BASE = 'https://www.zimuku.org'

export interface ZimukuSearchResult {
  id: string
  title: string
}

/**
 * 搜索结果列表解析:只依赖 /detail/<id>.html 详情页链接这个最稳定的锚点(不绑定具体的
 * class/容器结构——版面改版风险最低的选择,"够用就好",见设计文档)。
 */
export function parseSearchResults(html: string): ZimukuSearchResult[] {
  const results: ZimukuSearchResult[] = []
  const re = /<a href="\/detail\/(\d+)\.html">([^<]+)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) results.push({ id: m[1], title: m[2].trim() })
  return results
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/zimuku.ts src/adapters/providers/zimuku.test.ts fixtures/zimuku/search-spy-family.html
git commit -m "feat(zimuku): parseSearchResults"
```

---

### Task 11: `parseDetailPage` + detail fixture

**Files:**
- Modify: `src/adapters/providers/zimuku.ts`
- Create: `fixtures/zimuku/detail-58421.html`
- Modify: `src/adapters/providers/zimuku.test.ts`

- [ ] **Step 1: Write the failing test**

Create `fixtures/zimuku/detail-58421.html`:

```html
<!DOCTYPE html>
<html>
<body>
<div class="subinfo">
  <h1>间谍过家家 第一季.SPY.FAMILY.S01.2022.简体中文.srt</h1>
</div>
<a id="down" class="btn btn-sm btn-danger" href="https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip">下载</a>
</body>
</html>
```

Add to `src/adapters/providers/zimuku.test.ts` (extend the import line and append a new describe block):

```typescript
import { parseSearchResults, parseDetailPage, ZIMUKU_BASE } from './zimuku.js'
```

```typescript
describe('parseDetailPage', () => {
  it('extracts the absolute download url and derives the filename from it', () => {
    const html = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')
    const r = parseDetailPage(html, ZIMUKU_BASE)
    expect(r).toEqual({
      downloadUrl: 'https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip',
      filename: 'spy_family_s01_zh.zip',
    })
  })

  it('throws when the page has no id="down" download link (page shape drift)', () => {
    expect(() => parseDetailPage('<html><body>no download link</body></html>', ZIMUKU_BASE))
      .toThrow(/id="down"/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts`
Expected: FAIL — `parseDetailPage is not a function`.

- [ ] **Step 3: Implement**

Add to `src/adapters/providers/zimuku.ts` (add `basename` import at the top, and the new interface/function after `parseSearchResults`):

```typescript
import { basename } from 'node:path'
```

```typescript
export interface ZimukuDetailResult {
  downloadUrl: string
  filename: string
}

/**
 * 详情页解析:抓 id="down" 的下载锚点(社区脚本/实地侦察共同印证的下载按钮标记)。文件名从
 * 下载 URL 的 basename 派生(zimuku 静态文件名通常已含语言/季信息,比详情页标题更适合直接
 * 落盘);解析不出锚点视为页面结构漂移,fail closed 抛错而不是静默返回空。
 */
export function parseDetailPage(html: string, baseUrl: string): ZimukuDetailResult {
  const m = html.match(/id="down"[^>]*href="([^"]+)"/)
  if (!m) throw new Error('zimuku detail page has no download link (id="down") — page shape drift?')
  const downloadUrl = new URL(m[1], baseUrl).toString()
  const filename = basename(new URL(downloadUrl).pathname) || 'subtitle.zip'
  return { downloadUrl, filename }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/zimuku.ts src/adapters/providers/zimuku.test.ts fixtures/zimuku/detail-58421.html
git commit -m "feat(zimuku): parseDetailPage"
```

---

### Task 12: `ZimukuClient` happy path (search/detail, no challenge, politeness limiter)

**Files:**
- Modify: `src/adapters/providers/zimuku.ts`
- Modify: `src/adapters/providers/zimuku.test.ts`

- [ ] **Step 1: Write the failing test**

By this point (after Tasks 10–11) the top of `src/adapters/providers/zimuku.test.ts` has three import lines: `import { describe, it, expect } from 'vitest'`, `import { readFileSync } from 'node:fs'`, and `import { parseSearchResults, parseDetailPage, ZIMUKU_BASE } from './zimuku.js'`. Replace all three with:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSearchResults, parseDetailPage, ZIMUKU_BASE, ZimukuClient, type ZimukuClientOpts } from './zimuku.js'
import { MinIntervalLimiter } from './assrt.js'
import { ZimukuSessionStore } from './zimukuSession.js'
```


Add a new describe block at the end of the file:

```typescript
describe('ZimukuClient', () => {
  function client(overrides: Partial<ZimukuClientOpts> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
    return new ZimukuClient({
      sessionStore: new ZimukuSessionStore(dir),
      solve: vi.fn(async () => ({ digits: '00000' })),
      limiter: new MinIntervalLimiter(1), // 测试用 1ms 起步间隔,避免真的等 2s
      ...overrides,
    })
  }

  it('search: fetches /search?q=..., sends browser headers, parses results (no challenge)', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://www.zimuku.org/search?q=%E9%97%B4%E8%B0%8D%E8%BF%87%E5%AE%B6%E5%AE%B6')
      expect((init!.headers as Record<string, string>)['User-Agent']).toContain('Mozilla')
      expect((init!.headers as Record<string, string>)['Accept-Language']).toBe('zh-CN,zh;q=0.9')
      return new Response(searchHtml)
    })
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const results = await c.search('间谍过家家')
    expect(results).toEqual([
      { id: '58421', title: '间谍过家家 第一季 SPY×FAMILY' },
      { id: '58422', title: '间谍过家家 第二季 SPY×FAMILY Season 2' },
    ])
  })

  it('detail: fetches /detail/<id>.html and parses the download link', async () => {
    const detailHtml = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(detailHtml))
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await c.detail('58421')
    expect(r).toEqual({
      downloadUrl: 'https://static.zimuku.org/files/2026/07/12/spy_family_s01_zh.zip',
      filename: 'spy_family_s01_zh.zip',
    })
  })

  it('respects the MinIntervalLimiter between requests (politeness)', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async () => new Response(searchHtml))
    const limiter = new MinIntervalLimiter(50)
    const waitSpy = vi.spyOn(limiter, 'wait')
    const c = client({ fetchImpl: fetchImpl as unknown as typeof fetch, limiter })
    await c.search('x')
    expect(waitSpy).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts`
Expected: FAIL — `ZimukuClient is not a constructor`.

- [ ] **Step 3: Implement**

Add to `src/adapters/providers/zimuku.ts`. First, add imports at the top (alongside the existing `basename` import):

```typescript
import { MinIntervalLimiter } from './assrt.js'
import { detectChallenge } from './yunsuo.js'
import type { ZimukuSessionStore } from './zimukuSession.js'
```

Then add constants and the client class at the end of the file:

```typescript
export const ZIMUKU_TIMEOUT_MS = 15_000
// 设计文档要求的礼貌节流:单站串行、请求间延迟——住宅 IP 被封是真实家庭成本,绝不重试风暴。
export const DEFAULT_MIN_INTERVAL_MS = 2_000

/** 完整浏览器请求头:UA + 简体中文 Accept-Language + Referer——zimuku 对无头 HTTP 客户端的
 *  第一道防线就是这三样缺一漏出马脚。同一份头也要用在归档下载请求上(见 zimukuAdapter.ts 的
 *  resolve() 返回的 headers 字段),因为 resolveDownload 跨 CLI 子进程边界,下载本身发生在
 *  主进程的 downloadDirect() 里——必须把头随 URL 一起带出去,不能指望下载侧凭空知道。 */
export const ZIMUKU_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': `${ZIMUKU_BASE}/`,
}

export interface ZimukuClientOpts {
  fetchImpl?: typeof fetch
  limiter?: MinIntervalLimiter
  sessionStore: ZimukuSessionStore
  /** 验证码识别回调——生产接线用 solveNumericCaptcha(llm, png),客户端本身不依赖 LLM */
  solve: (imageBytes: Buffer) => Promise<{ digits: string }>
  maxCaptchaAttempts?: number
  onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string }) => void
}

export class ZimukuClient {
  private fetchImpl: typeof fetch
  private limiter: MinIntervalLimiter

  constructor(private opts: ZimukuClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.limiter = opts.limiter ?? new MinIntervalLimiter(DEFAULT_MIN_INTERVAL_MS)
  }

  private async fetchPath(path: string, cookie?: string): Promise<string> {
    const t0 = Date.now()
    const headers: Record<string, string> = { ...ZIMUKU_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
    try {
      const res = await this.fetchImpl(`${ZIMUKU_BASE}${path}`, {
        headers, signal: AbortSignal.timeout(ZIMUKU_TIMEOUT_MS),
      })
      const html = await res.text()
      this.opts.onApiCall?.({ endpoint: path, status: res.status, durationMs: Date.now() - t0 })
      return html
    } catch (e) {
      this.opts.onApiCall?.({ endpoint: path, status: null, durationMs: Date.now() - t0, error: String(e) })
      throw e
    }
  }

  /** 云锁破反爬 + 礼貌节流的统一入口:search()/detail() 都经过这里。命中挑战页时破解一次、
   *  缓存 cookie、用新 cookie 重试恰好一次。 */
  private async requestHtml(path: string): Promise<string> {
    await this.limiter.wait()
    const cached = this.opts.sessionStore.get()
    const html = await this.fetchPath(path, cached?.cookie)
    if (!detectChallenge(html)) return html
    return this.solveAndRetry(path, html)
  }

  // Task 13 will fill this in — for now the challenge branch is unreachable in tests
  // because every fixture response used by this task's tests returns non-challenge HTML.
  private async solveAndRetry(_path: string, _challengeHtml: string): Promise<string> {
    throw new Error('not implemented yet — see Task 13')
  }

  async search(query: string): Promise<ZimukuSearchResult[]> {
    const html = await this.requestHtml(`/search?q=${encodeURIComponent(query)}`)
    return parseSearchResults(html)
  }

  async detail(id: string): Promise<ZimukuDetailResult> {
    const html = await this.requestHtml(`/detail/${id}.html`)
    return parseDetailPage(html, ZIMUKU_BASE)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts && npm run check`
Expected: PASS — all three new `ZimukuClient` cases green (none of them hit the challenge branch), plus the pre-existing `parseSearchResults`/`parseDetailPage` cases still green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/zimuku.ts src/adapters/providers/zimuku.test.ts
git commit -m "feat(zimuku): ZimukuClient search/detail happy path + politeness limiter"
```

---

### Task 13: `ZimukuClient` — challenge detected → solve → cache cookie → retry succeeds

**Files:**
- Modify: `src/adapters/providers/zimuku.ts`
- Modify: `src/adapters/providers/zimuku.test.ts`

- [ ] **Step 1: Write the failing test**

Add two more `it()`s inside the existing `describe('ZimukuClient', ...)` block in `src/adapters/providers/zimuku.test.ts` (and extend the top-level import to include `ZimukuChallengeError`, `solveYunsuoChallenge` is not needed directly here):

```typescript
  it('on first hitting the challenge page, solves it, caches the cookie, and retries the original request once', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/challenge.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    let searchCallCount = 0
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/search?q=')) {
        searchCallCount++
        return searchCallCount === 1 ? new Response(challengeHtml) : new Response(searchHtml)
      }
      if (u.includes('security_verify_img')) return new Response(Buffer.from('png'))
      // captcha 表单提交
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=cached123; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '74504' }))
    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-client-')))
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    const results = await c.search('间谍过家家')
    expect(results.length).toBe(2)
    expect(searchCallCount).toBe(2) // 首次撞挑战页 + 破解后重试一次
    expect(sessionStore.get()?.cookie).toBe('security_session_verify=cached123')
  })

  it('reuses a cached cookie without re-solving when the session store already has one and the site does not challenge', async () => {
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect((init!.headers as Record<string, string>).Cookie).toBe('security_session_verify=warm456')
      return new Response(searchHtml)
    })
    const solve = vi.fn()
    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-client-')))
    sessionStore.put({ cookie: 'security_session_verify=warm456', capturedAt: Date.now() })
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    await c.search('x')
    expect(solve).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts`
Expected: FAIL — the first new test throws `Error: not implemented yet — see Task 13` (from the placeholder `solveAndRetry` stub added in Task 12).

- [ ] **Step 3: Implement**

In `src/adapters/providers/zimuku.ts`, add `solveYunsuoChallenge` to the `yunsuo.js` import:

```typescript
import { detectChallenge, solveYunsuoChallenge } from './yunsuo.js'
```

Replace the placeholder `solveAndRetry` method body:

```typescript
  private async solveAndRetry(path: string, challengeHtml: string): Promise<string> {
    // 命中挑战:缓存的 cookie(若有)已经失效——按响应失效检测,不按计时(设计文档)
    this.opts.sessionStore.invalidate()
    const { cookie } = await solveYunsuoChallenge(
      { fetchImpl: this.fetchImpl, solve: this.opts.solve },
      ZIMUKU_BASE, challengeHtml, this.opts.maxCaptchaAttempts ?? 5,
    )
    this.opts.sessionStore.put({ cookie, capturedAt: Date.now() })

    await this.limiter.wait()
    return this.fetchPath(path, cookie)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/zimuku.ts src/adapters/providers/zimuku.test.ts
git commit -m "feat(zimuku): ZimukuClient WAF challenge solve + cookie caching"
```

---

### Task 14: `ZimukuClient` — still challenged after solving → invalidate + throw

**Files:**
- Modify: `src/adapters/providers/zimuku.ts`
- Modify: `src/adapters/providers/zimuku.test.ts`

- [ ] **Step 1: Write the failing test**

Add one more `it()` inside `describe('ZimukuClient', ...)`. `zimuku.test.ts` has no existing import from `./yunsuo.js` yet (Tasks 10–13 never needed one — only the production `zimuku.ts` file imports from it), so add this as a new import line at the top of the test file, alongside the existing `./zimuku.js`/`./assrt.js`/`./zimukuSession.js` imports:

```typescript
import { ZimukuChallengeError } from './yunsuo.js'
```

```typescript
  it('invalidates the cookie and throws ZimukuChallengeError when still challenged immediately after solving', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/challenge.html', 'utf8')
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/search?q=')) return new Response(challengeHtml) // 每次都是挑战页——破解后仍被拦
      if (u.includes('security_verify_img')) return new Response(Buffer.from('png'))
      return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=stillbad; Path=/' } })
    })
    const solve = vi.fn(async () => ({ digits: '74504' }))
    const dir = mkdtempSync(join(tmpdir(), 'zimuku-client-'))
    const sessionStore = new ZimukuSessionStore(dir)
    const c = new ZimukuClient({
      sessionStore, solve, fetchImpl: fetchImpl as unknown as typeof fetch, limiter: new MinIntervalLimiter(1),
    })
    await expect(c.search('x')).rejects.toThrow(ZimukuChallengeError)
    expect(sessionStore.get()).toBeNull() // 失效的 cookie 没有残留在缓存里
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts`
Expected: FAIL — `search()` resolves successfully (with garbage `parseSearchResults` output parsed from the still-challenged HTML) instead of rejecting, because `requestHtml` currently returns `solveAndRetry`'s result unconditionally without re-checking for a challenge.

- [ ] **Step 3: Implement**

In `src/adapters/providers/zimuku.ts`, add `ZimukuChallengeError` to the `yunsuo.js` import:

```typescript
import { detectChallenge, solveYunsuoChallenge, ZimukuChallengeError } from './yunsuo.js'
```

Replace the `requestHtml` method:

```typescript
  private async requestHtml(path: string): Promise<string> {
    await this.limiter.wait()
    const cached = this.opts.sessionStore.get()
    const html = await this.fetchPath(path, cached?.cookie)
    if (!detectChallenge(html)) return html
    const retryHtml = await this.solveAndRetry(path, html)
    if (detectChallenge(retryHtml)) {
      this.opts.sessionStore.invalidate()
      throw new ZimukuChallengeError(`still challenged after solving captcha for ${path} — cookie rejected immediately`)
    }
    return retryHtml
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/providers/zimuku.test.ts && npm run check`
Expected: PASS — all `zimuku.test.ts` cases green (parseSearchResults, parseDetailPage, ZimukuClient × 6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/providers/zimuku.ts src/adapters/providers/zimuku.test.ts
git commit -m "fix(zimuku): invalidate cookie and throw when still challenged after solve"
```

---

## Phase D — zimukuAdapter + PROVIDERS registration

### Task 15: register `'zimuku'` in `PROVIDERS`

**Files:**
- Modify: `src/core/schemas.ts`
- Modify: `src/core/schemas.test.ts`

- [ ] **Step 1: Write the failing test**

Add `PROVIDERS`, `SubtitleCandidateSchema`, and `parseCandidateKey` to the import list at the top of `src/core/schemas.test.ts`:

```typescript
import {
  MediaContextSchema, MediaIdentitySchema, SearchPlanSchema,
  RankDecisionSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
  FinalDecisionSchema, OrphanDecisionSchema, LooseEpisodesMapSchema,
  VerifyDecisionSchema, PROVIDERS, SubtitleCandidateSchema, parseCandidateKey,
} from './schemas.js'
```

Add a new describe block at the end of the file:

```typescript
describe('PROVIDERS registry', () => {
  it('includes zimuku alongside assrt/opensubtitles', () => {
    expect(PROVIDERS).toEqual(['assrt', 'opensubtitles', 'zimuku'])
  })
  it('SubtitleCandidateSchema accepts provider:"zimuku"', () => {
    const c = SubtitleCandidateSchema.parse({
      provider: 'zimuku', providerId: '58421', videoName: null, nativeName: null,
      language: null, subtype: null, releaseSite: 'zimuku', uploadDate: null, fileList: [],
    })
    expect(c.provider).toBe('zimuku')
  })
  it('parseCandidateKey recognizes the zimuku: prefix', () => {
    expect(parseCandidateKey('zimuku:58421')).toEqual({ provider: 'zimuku', providerId: '58421' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/schemas.test.ts`
Expected: FAIL — `expected ['assrt', 'opensubtitles'] to equal ['assrt', 'opensubtitles', 'zimuku']`, and `SubtitleCandidateSchema.parse` throws (`provider` not in enum).

- [ ] **Step 3: Implement**

In `src/core/schemas.ts`, change:

```typescript
export const PROVIDERS = ['assrt', 'opensubtitles'] as const
```

to:

```typescript
export const PROVIDERS = ['assrt', 'opensubtitles', 'zimuku'] as const
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/schemas.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/schemas.ts src/core/schemas.test.ts
git commit -m "feat(schemas): register zimuku provider"
```

---

### Task 16: `zimukuAdapter.search()`

**Files:**
- Create: `src/cli/adapters/zimukuAdapter.ts`
- Create: `src/cli/adapters/zimukuAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/adapters/zimukuAdapter.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { makeZimukuAdapter } from './zimukuAdapter.js'
import type { ZimukuClient } from '../../adapters/providers/zimuku.js'
import type { FetchArgs } from '../fetchLib.js'

type FakeZimukuClient = Pick<ZimukuClient, 'search' | 'detail'>

function fakeClient(overrides: Partial<FakeZimukuClient> = {}): FakeZimukuClient {
  return {
    search: vi.fn(async () => []),
    detail: vi.fn(async () => ({ downloadUrl: 'https://static.zimuku.org/x.zip', filename: 'x.zip' })),
    ...overrides,
  }
}

const args = (over: Partial<FetchArgs> = {}): FetchArgs => ({ queries: [], deep: false, ...over })

describe('makeZimukuAdapter: search', () => {
  it('searches with the first query only and maps results to provider-neutral candidates with empty fileList', async () => {
    const search = vi.fn(async () => [{ id: '58421', title: '间谍过家家 第一季' }])
    const client = fakeClient({ search })
    const adapter = makeZimukuAdapter(client)

    const results = await adapter.search(args({ queries: ['间谍过家家', '第二个query不该被用到'] }), () => {})

    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith('间谍过家家')
    expect(results).toEqual([{
      provider: 'zimuku', providerId: '58421', videoName: '间谍过家家 第一季', nativeName: '间谍过家家 第一季',
      language: null, subtype: null, releaseSite: 'zimuku', uploadDate: null, fileList: [],
    }])
  })

  it('no queries → returns empty without calling search', async () => {
    const search = vi.fn(async () => [])
    const adapter = makeZimukuAdapter(fakeClient({ search }))
    const results = await adapter.search(args({ queries: [] }), () => {})
    expect(search).not.toHaveBeenCalled()
    expect(results).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/adapters/zimukuAdapter.test.ts`
Expected: FAIL — `Cannot find module './zimukuAdapter.js'`.

- [ ] **Step 3: Implement**

Create `src/cli/adapters/zimukuAdapter.ts`:

```typescript
import type { ZimukuClient, ZimukuSearchResult } from '../../adapters/providers/zimuku.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter } from '../fetchLib.js'

function toCandidate(r: ZimukuSearchResult): SubtitleCandidate {
  return {
    provider: 'zimuku',
    providerId: r.id,
    videoName: r.title,
    nativeName: r.title,
    language: null,
    subtype: null,
    releaseSite: 'zimuku',
    uploadDate: null,
    // zimuku 详情页不预先列出压缩包内文件清单(要解压才知道)——与 opensubtitles 单文件候选
    // 同款空 fileList 处理(见 core/pipeline.ts runSeasonSweep 对 OS 候选的注释)。v1 只支持
    // 单字幕压缩包,writeSubtitle 在没有 selectFileName 时默认取 zip 内第一个字幕文件。
    fileList: [],
  }
}

/**
 * zimuku FetchAdapter 工厂——镜像 assrtAdapter.ts/opensubtitlesAdapter.ts 的抽取模式。
 * client 收窄到用到的 2 个方法(Pick),测试用假 client 免造真 ZimukuClient(网络/WAF/限速)。
 */
export function makeZimukuAdapter(
  client: Pick<ZimukuClient, 'search' | 'detail'>,
): FetchAdapter {
  return {
    name: 'zimuku',
    enabled: () => true,
    search: async (args) => {
      // v1 只用首条 query(礼貌节流:zimuku 每次搜索都可能撞见验证码破解开销,不像 assrt 那样
      // 廉价到可以并发打多条 query——够用就好,见设计文档)。
      const q = args.queries[0]
      if (!q) return []
      const results = await client.search(q)
      return results.map(toCandidate)
    },
    resolve: async (ref) => {
      const detail = await client.detail(ref.providerId)
      return { url: detail.downloadUrl, filename: detail.filename }
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/adapters/zimukuAdapter.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/adapters/zimukuAdapter.ts src/cli/adapters/zimukuAdapter.test.ts
git commit -m "feat(zimukuAdapter): search() maps to provider-neutral candidates"
```

---

### Task 17: `zimukuAdapter.resolve()` returns archive url + browser headers

**Files:**
- Modify: `src/cli/adapters/zimukuAdapter.ts`
- Modify: `src/cli/adapters/zimukuAdapter.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block at the end of `src/cli/adapters/zimukuAdapter.test.ts`:

```typescript
describe('makeZimukuAdapter: resolve', () => {
  it('resolves to the archive url + filename + browser headers (needed by downloadDirect for the archive GET)', async () => {
    const detail = vi.fn(async () => ({ downloadUrl: 'https://static.zimuku.org/files/x.zip', filename: 'x.zip' }))
    const adapter = makeZimukuAdapter(fakeClient({ detail }))

    const r = await adapter.resolve({ provider: 'zimuku', providerId: '58421', fileIndex: null }, () => {})

    expect(detail).toHaveBeenCalledWith('58421')
    expect(r.url).toBe('https://static.zimuku.org/files/x.zip')
    expect(r.filename).toBe('x.zip')
    expect(r.headers).toMatchObject({ 'Accept-Language': 'zh-CN,zh;q=0.9' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/adapters/zimukuAdapter.test.ts`
Expected: FAIL — `expect(r.headers).toMatchObject(...)` fails because `r.headers` is `undefined` (Task 16's `resolve()` doesn't set it yet).

- [ ] **Step 3: Implement**

In `src/cli/adapters/zimukuAdapter.ts`, replace the existing `import type { ZimukuClient, ZimukuSearchResult } from '../../adapters/providers/zimuku.js'` line with:

```typescript
import { ZIMUKU_HEADERS, type ZimukuClient, type ZimukuSearchResult } from '../../adapters/providers/zimuku.js'
```

Update the `resolve` method:

```typescript
    resolve: async (ref) => {
      const detail = await client.detail(ref.providerId)
      return { url: detail.downloadUrl, filename: detail.filename, headers: ZIMUKU_HEADERS }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/adapters/zimukuAdapter.test.ts && npm run check`
Expected: PASS. (Note: `tsc --noEmit` will only be fully clean once `FetchAdapter.resolve`'s return type includes `headers` — that's Task 20. Until then, `npm run check` may report an excess-property error on this object literal. If it does, that's expected at this point in the plan — Task 20 fixes it. Confirm the *test* passes now; confirm `npm run check` is fully clean again after Task 20.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/adapters/zimukuAdapter.ts src/cli/adapters/zimukuAdapter.test.ts
git commit -m "feat(zimukuAdapter): resolve() returns archive url + browser headers"
```

---

## Phase E — download-path headers seam + provider registration wiring

### Task 18: `downloadDirect` accepts optional custom headers

**Files:**
- Modify: `src/adapters/download/direct.ts`
- Modify: `src/adapters/download/direct.test.ts`

- [ ] **Step 1: Write the failing test**

Add two more `it()`s to the `describe('downloadDirect', ...)` block in `src/adapters/download/direct.test.ts`:

```typescript
  it('forwards custom headers to fetchImpl when provided (zimuku archive download needs browser UA/Referer)', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('ok')))
    const headers = { 'User-Agent': 'test-ua', Referer: 'https://www.zimuku.org/' }
    await downloadDirect('http://x/y.zip', { fetchImpl: fetchImpl as unknown as typeof fetch, headers })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toEqual(headers)
  })
  it('omits headers from the fetch init when not provided (existing assrt/OS downloads unaffected)', async () => {
    const fetchImpl = vi.fn(async () => new Response(Buffer.from('ok')))
    await downloadDirect('http://x/y.ass', { fetchImpl: fetchImpl as unknown as typeof fetch })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toBeUndefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/adapters/download/direct.test.ts`
Expected: FAIL — the first new test's `init.headers` is `undefined` (not forwarded yet); the second test currently passes already (no regression risk, but confirm both are exercised).

- [ ] **Step 3: Implement**

In `src/adapters/download/direct.ts`:

```typescript
export interface DownloadResult { bytes: Buffer; contentType: string | null }
export interface DownloadOpts {
  fetchImpl?: typeof fetch
  retries?: number
  retryDelayMs?: number
  /** 自定义请求头(如 zimuku 归档下载需要的浏览器 UA/Accept-Language/Referer);省略则不发送
   *  除 fetch 默认值外的任何头,现有 assrt/opensubtitles 下载路径行为不变。 */
  headers?: Record<string, string>
}

export const DOWNLOAD_TIMEOUT_MS = 60_000

export async function downloadDirect(url: string, opts: DownloadOpts = {}): Promise<DownloadResult> {
  const { fetchImpl = fetch, retries = 1, retryDelayMs = 2000, headers } = opts
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        ...(headers ? { headers } : {}),
      })
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0) throw new Error('download returned empty body')
      return { bytes, contentType: res.headers.get('content-type') }
    } catch (e) {
      lastError = e
      if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs))
    }
  }
  throw lastError
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/adapters/download/direct.test.ts && npm run check`
Expected: PASS — all 7 `direct.test.ts` cases (5 pre-existing + 2 new) green.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/download/direct.ts src/adapters/download/direct.test.ts
git commit -m "feat(download): optional custom headers in downloadDirect"
```

---

### Task 19: `ProviderPort.resolveDownload` threads optional headers across the CLI-subprocess boundary

**Files:**
- Modify: `src/core/providerPort.ts`
- Modify: `src/core/providerPort.test.ts`

- [ ] **Step 1: Write the failing test**

Add two more `it()`s to the `describe('makeCliProviderPort', ...)` block in `src/core/providerPort.test.ts`:

```typescript
  it('resolveDownload: parses an optional headers field through from the CLI subprocess stdout JSON (zimuku archive download needs browser headers)', async () => {
    const port = makeCliProviderPort({
      command: ['sh', '-c', 'echo \'{"url":"https://dl.example/x.zip","filename":"x.zip","headers":{"User-Agent":"test-ua"}}\''],
    })
    const r = await port.resolveDownload({ provider: 'zimuku', providerId: '1', fileIndex: null })
    expect(r.headers).toEqual({ 'User-Agent': 'test-ua' })
  })
  it('resolveDownload: headers stays undefined when the CLI does not emit it (assrt/opensubtitles unaffected)', async () => {
    const port = makeCliProviderPort({ command: stub })
    const r = await port.resolveDownload({ provider: 'assrt', providerId: '1', fileIndex: 2 })
    expect(r.headers).toBeUndefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/providerPort.test.ts`
Expected: FAIL — the first new test's `r.headers` is `undefined` because `ResolveOutSchema` currently strips unknown fields (Zod objects drop unrecognized keys by default unless `.passthrough()`), so the `headers` field never survives `ResolveOutSchema.parse(...)`.

- [ ] **Step 3: Implement**

In `src/core/providerPort.ts`:

```typescript
export interface ProviderPort {
  search: (args: ProviderSearchArgs) => Promise<ProviderSearchResult>
  resolveDownload: (ref: CandidateRef) => Promise<{ url: string; filename?: string; headers?: Record<string, string> }>
}

const ResolveOutSchema = z.object({
  url: z.string(),
  filename: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/providerPort.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/providerPort.ts src/core/providerPort.test.ts
git commit -m "feat(providerPort): thread optional headers through resolveDownload"
```

---

### Task 20: `fetchLib.ts` — `FetchAdapter`/`runResolve` headers + config-error message

**Files:**
- Modify: `src/cli/fetchLib.ts`
- Modify: `src/cli/fetchLib.test.ts`

- [ ] **Step 1: Write the failing test**

Add two new describe blocks at the end of `src/cli/fetchLib.test.ts`:

```typescript
describe('runResolve header pass-through (zimuku archive download needs browser headers)', () => {
  it('forwards headers returned by the adapter unchanged', async () => {
    const headers = { 'User-Agent': 'test-ua', Referer: 'https://www.zimuku.org/' }
    const zimukuAdapter = adapter('zimuku', { resolve: async () => ({ url: 'https://dl/zimuku', headers }) })
    const r = await runResolve({ provider: 'zimuku', providerId: '1', fileIndex: null }, [zimukuAdapter])
    expect(r.headers).toEqual(headers)
  })
  it('headers stays undefined when the adapter does not return them (assrt/opensubtitles unaffected)', async () => {
    const r = await runResolve({ provider: 'assrt', providerId: '1', fileIndex: 0 }, [adapter('assrt')])
    expect(r.headers).toBeUndefined()
  })
})

describe('"no providers configured" message mentions all three provider gates', () => {
  it('mentions ZIMUKU_ENABLED alongside ASSRT_TOKEN/OPENSUBTITLES_API_KEY', async () => {
    await expect(runSearch({ queries: ['q'], deep: false }, [], () => {})).rejects.toThrow(/ZIMUKU_ENABLED/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/fetchLib.test.ts`
Expected: FAIL — the `headers` pass-through test fails because nothing strips or drops it today (it should actually pass already, since `runResolve` just returns `adapter.resolve(...)`'s result verbatim with no schema in between — confirm this by reading the failure; if it passes immediately, that's fine, move to the message test) and the `ZIMUKU_ENABLED` message test fails with the current message text `no providers configured — set ASSRT_TOKEN and/or OPENSUBTITLES_API_KEY`.

- [ ] **Step 3: Implement**

In `src/cli/fetchLib.ts`, update the `FetchAdapter` interface:

```typescript
export interface FetchAdapter {
  name: string   // equals the ProviderName it emits
  enabled: (args: FetchArgs, env: NodeJS.ProcessEnv) => boolean
  search: (args: FetchArgs, emit: (e: FetchEvent) => void) => Promise<SubtitleCandidate[]>
  resolve: (ref: CandidateRef, emit: (e: FetchEvent) => void) => Promise<{ url: string; filename?: string; headers?: Record<string, string> }>
}
```

Update `runSearch`'s error message:

```typescript
  if (enabled.length === 0) {
    throw new Error('no providers configured — set ASSRT_TOKEN, OPENSUBTITLES_API_KEY, and/or ZIMUKU_ENABLED=true')
  }
```

Update `runResolve`'s return type and error message:

```typescript
export async function runResolve(
  ref: CandidateRef, adapters: FetchAdapter[], emit: (e: FetchEvent) => void = () => {},
): Promise<{ url: string; filename?: string; headers?: Record<string, string> }> {
  if (adapters.length === 0) {
    throw new Error('no providers configured — set ASSRT_TOKEN, OPENSUBTITLES_API_KEY, and/or ZIMUKU_ENABLED=true')
  }
  const adapter = adapters.find(a => a.name === ref.provider)
  if (!adapter) throw new Error(`no adapter for provider ${ref.provider}`)
  return adapter.resolve(ref, emit)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/fetchLib.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/fetchLib.ts src/cli/fetchLib.test.ts
git commit -m "feat(fetchLib): thread optional headers through resolve/runResolve"
```

---

### Task 21: `pipeline.ts` threads `resolved.headers` into `deps.download`; `cli/index.ts` wiring

**Files:**
- Modify: `src/core/pipeline.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/core/pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block at the end of `src/core/pipeline.test.ts` (it needs `PipelineDeps` imported, which the file already does):

```typescript
describe('download header seam (zimuku archive downloads need browser headers)', () => {
  it('passes resolved.headers through to deps.download when the provider port supplies them', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const headers = { 'User-Agent': 'test-agent', Referer: 'https://www.zimuku.org/' }
    const download = vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' }))
    const deps = makeDeps({
      providers: makeProviders({
        resolveDownload: vi.fn(async () => ({
          url: 'https://static.zimuku.org/files/x.zip', filename: 'x.ass', headers,
        })),
      }),
      download: download as unknown as PipelineDeps['download'],
    })
    await runPipeline(deps, ctx, outDir)
    expect(download).toHaveBeenCalledWith('https://static.zimuku.org/files/x.zip', headers)
  })

  it('calls deps.download with undefined headers when the provider port does not supply them (existing assrt/OS behavior unchanged)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'out-'))
    const download = vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' }))
    const deps = makeDeps({ download: download as unknown as PipelineDeps['download'] })
    await runPipeline(deps, ctx, outDir)
    expect(download).toHaveBeenCalledWith(expect.any(String), undefined)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: FAIL — the first new test fails because `download` is called with only one argument (`resolved.url`), so `toHaveBeenCalledWith('https://static.zimuku.org/files/x.zip', headers)` doesn't match a call with a single argument. The second test should already pass (confirm it does — it's here to lock in the no-regression case).

- [ ] **Step 3: Implement**

In `src/core/pipeline.ts`, update `PipelineDeps.download`'s signature:

```typescript
  download: (url: string, headers?: Record<string, string>) => Promise<DownloadResult>
```

Then replace all 4 occurrences of `deps.download(resolved.url)` with `deps.download(resolved.url, resolved.headers)`. Since the old text is identical at all 4 call sites and the new text is identical too, use a global literal replace across the file (e.g. `sed -i '' 's/deps\.download(resolved\.url)/deps.download(resolved.url, resolved.headers)/g' src/core/pipeline.ts` on macOS, or your editor's "replace all" on the exact string `deps.download(resolved.url)`). Confirm afterward that exactly 4 occurrences changed:

```bash
grep -c "deps.download(resolved.url, resolved.headers)" src/core/pipeline.ts   # expect 4
grep -c "deps.download(resolved.url)" src/core/pipeline.ts                     # expect 0
```

In `src/cli/index.ts`, change the `download:` line inside `makeDeps` (around line 130):

```typescript
    download: (url, headers) => downloadDirect(url, { headers }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/pipeline.test.ts && npm run check`
Expected: PASS — all pipeline.test.ts cases green (the ~34 pre-existing `download:` mocks all still satisfy the new 2-arg signature since a mock declared with fewer parameters is structurally assignable to a function type expecting more).

- [ ] **Step 5: Commit**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts src/cli/index.ts
git commit -m "feat(pipeline): thread resolved.headers into deps.download at all download call sites"
```

---

### Task 22: `subtitle-fetch.ts` registers the zimuku adapter behind `ZIMUKU_ENABLED`

**Files:**
- Modify: `src/cli/subtitle-fetch.ts`
- Modify: `src/cli/subtitle-fetch.test.ts`

- [ ] **Step 1: Write the failing test**

Add one more `it()` to the `describe('subtitle-fetch CLI exit paths (MINOR-2)', ...)` block in `src/cli/subtitle-fetch.test.ts`:

```typescript
  it('ZIMUKU_ENABLED=true without LLM_BASE_URL exits 1 with a clear config error (no network call attempted)', () => {
    const res = spawnSync(tsxBin, [cliPath, '--query', 'test'], {
      encoding: 'utf8',
      env: {
        ...process.env, ASSRT_TOKEN: '', OPENSUBTITLES_API_KEY: '',
        ZIMUKU_ENABLED: 'true', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '',
      },
    })
    expect(res.status).toBe(1)
    const parsed = lastJsonLine(res.stderr) as { error: string }
    expect(parsed.error).toMatch(/ZIMUKU_ENABLED=true requires LLM_BASE_URL/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/subtitle-fetch.test.ts`
Expected: FAIL — with today's code, `ZIMUKU_ENABLED=true` is not read anywhere, so `buildAdapters()` returns `[]` (assuming ASSRT/OS keys are also empty in this test's env), and the CLI exits 1 with the pre-existing `no providers configured` message instead of the expected `ZIMUKU_ENABLED=true requires LLM_BASE_URL` message.

- [ ] **Step 3: Implement**

Replace the full contents of `src/cli/subtitle-fetch.ts`:

```typescript
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AssrtClient } from '../adapters/providers/assrt.js'
import { OpenSubtitlesClient } from '../adapters/providers/opensubtitles.js'
import { ZimukuClient } from '../adapters/providers/zimuku.js'
import { ZimukuSessionStore } from '../adapters/providers/zimukuSession.js'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { makeAssrtAdapter } from './adapters/assrtAdapter.js'
import { makeOpenSubtitlesAdapter } from './adapters/opensubtitlesAdapter.js'
import { makeZimukuAdapter } from './adapters/zimukuAdapter.js'
import { parseCandidateKey, type CandidateRef } from '../core/schemas.js'
import { createLlmRuntime } from '../agent/runtime.js'
import { ProfileStore } from '../agent/profile.js'
import { solveNumericCaptcha } from '../agent/solveNumericCaptcha.js'

const emit = (e: FetchEvent) => process.stderr.write(JSON.stringify(e) + '\n')

function requireEnvForZimuku(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`ZIMUKU_ENABLED=true requires ${name} (captcha solving needs a multimodal LLM) — set it alongside your other LLM_* vars`)
  return v
}

async function buildAdapters(): Promise<FetchAdapter[]> {
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const adapters: FetchAdapter[] = []

  if (process.env.ASSRT_TOKEN) {
    const client = new AssrtClient({
      token: process.env.ASSRT_TOKEN,
      cacheDir: join(cacheRoot, 'assrt-responses'),
      onApiCall: r => emit({ event: 'api_call', provider: 'assrt', ...r }),
    })
    adapters.push(makeAssrtAdapter(client))
  }

  if (process.env.OPENSUBTITLES_API_KEY) {
    const client = new OpenSubtitlesClient({
      apiKey: process.env.OPENSUBTITLES_API_KEY,
      appUserAgent: 'subtitlescout v0.2.0',
      username: process.env.OPENSUBTITLES_USERNAME,
      password: process.env.OPENSUBTITLES_PASSWORD,
      onApiCall: r => emit({ event: 'api_call', provider: 'opensubtitles', ...r }),
    })
    adapters.push(makeOpenSubtitlesAdapter(client))
  }

  if (process.env.ZIMUKU_ENABLED === 'true') {
    // 验证码破解需要多模态 LLM——子进程独立构建一份 LlmRuntime(继承父进程 env,含 LLM_* 变量;
    // ProfileStore 磁盘缓存,冷启动只探测一次)。只在真的撞见挑战页时才会被调用,不是每次
    // search/resolve 都要打一次 LLM。
    const llm = await createLlmRuntime({
      baseUrl: requireEnvForZimuku('LLM_BASE_URL'),
      apiKey: requireEnvForZimuku('LLM_API_KEY'),
      model: requireEnvForZimuku('LLM_MODEL'),
    }, new ProfileStore(join(cacheRoot, 'llm-profiles')))
    const client = new ZimukuClient({
      sessionStore: new ZimukuSessionStore(join(cacheRoot, 'zimuku-session')),
      solve: async png => (await solveNumericCaptcha(llm, png)).parsed,
      onApiCall: r => emit({ event: 'api_call', provider: 'zimuku', ...r }),
    })
    adapters.push(makeZimukuAdapter(client))
  }
  return adapters
}

async function main() {
  const isResolve = process.argv[2] === 'resolve'
  const rawArgs = isResolve ? process.argv.slice(3) : process.argv.slice(2)
  if (isResolve) {
    const { values } = parseArgs({ args: rawArgs, options: {
      provider: { type: 'string' }, id: { type: 'string' }, 'file-index': { type: 'string' },
    } })
    const parsed = parseCandidateKey(`${values.provider}:${values.id}`)
    if (!parsed) {
      process.stderr.write(JSON.stringify({ error: `unknown provider ${values.provider}` }) + '\n')
      process.exitCode = 1
      return
    }
    const ref: CandidateRef = { ...parsed, fileIndex: values['file-index'] != null ? Number(values['file-index']) : null }
    const out = await runResolve(ref, await buildAdapters(), emit)
    process.stdout.write(JSON.stringify(out) + '\n')
    return
  }
  const { values } = parseArgs({ args: rawArgs, options: {
    query: { type: 'string', multiple: true }, imdb: { type: 'string' }, year: { type: 'string' },
    season: { type: 'string' }, episode: { type: 'string' }, filename: { type: 'string' },
    languages: { type: 'string' }, deep: { type: 'boolean', default: false }, format: { type: 'string', default: 'json' },
  } })
  const args: FetchArgs = {
    queries: values.query ?? [],
    imdb: values.imdb, year: values.year ? Number(values.year) : undefined,
    season: values.season ? Number(values.season) : undefined,
    episode: values.episode ? Number(values.episode) : undefined,
    filename: values.filename,
    languages: values.languages?.split(',').map(s => s.trim().toLowerCase()),
    deep: values.deep!,
  }
  const candidates = await runSearch(args, await buildAdapters(), emit)
  process.stdout.write(JSON.stringify(candidates) + '\n')
}

main().catch(e => {
  process.stderr.write(JSON.stringify({ error: String(e) }) + '\n')
  process.exitCode = 1
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/subtitle-fetch.test.ts && npm run check`
Expected: PASS — all 3 `subtitle-fetch.test.ts` cases green (2 pre-existing + 1 new), no network call attempted for the new case (verify by watching the test run — it should finish in well under a second, not hang on a real HTTP request).

- [ ] **Step 5: Commit**

```bash
git add src/cli/subtitle-fetch.ts src/cli/subtitle-fetch.test.ts
git commit -m "feat(subtitle-fetch): register zimuku adapter behind ZIMUKU_ENABLED"
```

---

### Task 23: `doctor.ts` — `checkZimuku` probe + wiring + `.env.example`

**Files:**
- Modify: `src/cli/doctor.ts`
- Modify: `src/cli/index.ts`
- Modify: `.env.example`
- Modify: `src/cli/doctor.test.ts`

- [ ] **Step 1: Write the failing test**

Add `checkZimuku` to the import at the top of `src/cli/doctor.test.ts`:

```typescript
import { checkJellyfin, checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkMediaRoots, checkPathMappings, formatDoctorReport, overallOk, withTimeout, checkDatabase, checkStuckJobs } from './doctor.js'
```

Add a new describe block (place it after the `describe('doctor 远端三项', ...)` block):

```typescript
describe('doctor zimuku (可选 provider,默认关闭)', () => {
  it('未配置(probe=null) → skip 而非失败,hint 提到 ZIMUKU_ENABLED', async () => {
    const r = await checkZimuku(null)
    expect(r.skip).toBe(true)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('ZIMUKU_ENABLED')
  })
  it('已启用且首页可达、未触发验证页 → ok', async () => {
    const r = await checkZimuku({ fetchHomepage: async () => ({ ok: true, challenged: false }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('未触发验证页')
  })
  it('已启用且命中云锁验证页 → 仍然 ok(挑战页是预期健康状态,不是失败)', async () => {
    const r = await checkZimuku({ fetchHomepage: async () => ({ ok: true, challenged: true }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('验证页')
  })
  it('首页不可达 → 失败并给人话提示', async () => {
    const r = await checkZimuku({ fetchHomepage: async () => { throw new Error('ETIMEDOUT') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('zimuku.org')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: FAIL — `checkZimuku is not a function`.

- [ ] **Step 3: Implement**

Add to `src/cli/doctor.ts`, right after `checkOpenSubtitles`:

```typescript
/** zimuku 是可选 provider(默认关闭——灰色站点,条款风险自担,见 .env.example)。
 *  probe=null(ZIMUKU_ENABLED 未开)→ skip,非失败,规则同 checkOpenSubtitles。已启用时只探测
 *  首页可达性:命中云锁"网站防火墙"中间页是预期健康状态而非失败——运行时自动破解,doctor 不
 *  重复验证码破解链路(那是集成测试/实跑的职责)。 */
export async function checkZimuku(
  probe: { fetchHomepage(): Promise<{ ok: boolean; challenged: boolean }> } | null,
): Promise<DoctorResult> {
  if (!probe) {
    return {
      name: 'zimuku', ok: true, skip: true,
      detail: '未配置(可选 provider,灰色站点条款风险自担)——设 ZIMUKU_ENABLED=true 启用',
    }
  }
  try {
    const r = await probe.fetchHomepage()
    if (!r.ok) throw new Error('homepage did not return HTTP 200')
    return {
      name: 'zimuku', ok: true,
      detail: r.challenged
        ? 'zimuku.org 可达(命中云锁验证页,属预期——运行时会自动破解)'
        : 'zimuku.org 可达,未触发验证页',
    }
  } catch (e) {
    return {
      name: 'zimuku', ok: false, detail: `连接失败:${String(e)}`,
      hint: '检查网络能否直连 zimuku.org(灰色站点,部分网络环境可能被墙或限速);确认 ZIMUKU_ENABLED 拼写正确(区分大小写,值必须是字符串 "true")。',
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/doctor.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Wire it into `cli/index.ts`'s `cmdDoctor()`, and document the env var**

In `src/cli/index.ts`, add imports:

```typescript
import {
  checkJellyfin, checkAssrt, checkOpenSubtitles, checkZimuku, checkLlm, checkMediaRoots, checkPathMappings,
  checkDatabase, checkStuckJobs,
  formatDoctorReport, overallOk, withTimeout, type DoctorResult,
} from './doctor.js'
import { detectChallenge } from '../adapters/providers/yunsuo.js'
```

In `cmdDoctor()`, add this block right after the existing OpenSubtitles block (after `results.push(await checkOpenSubtitles({...}))` and its closing `}`, before the `const llmBase = ...` line):

```typescript
  const zimukuEnabled = process.env.ZIMUKU_ENABLED === 'true'
  if (!zimukuEnabled) {
    results.push(await checkZimuku(null))
  } else {
    results.push(await checkZimuku({
      fetchHomepage: async () => {
        const res = await withTimeout(fetch('https://www.zimuku.org/', { signal: AbortSignal.timeout(10_000) }), 10_000, 'zimuku')
        const html = await res.text()
        return { ok: res.ok, challenged: detectChallenge(html) }
      },
    }))
  }
```

In `.env.example`, add this block right after the `OPENSUBTITLES_PASSWORD=` line:

```
# 可选、默认关闭:zimuku 字幕站(灰色地带,条款风险自担)——设为 true 启用,需要同一份 LLM_*
# 配置支持识图(验证码破解需要多模态模型)
ZIMUKU_ENABLED=false
```

- [ ] **Step 6: Run the full suite + typecheck to confirm no regressions from the wiring changes (these lines in `cli/index.ts` have no dedicated unit test — `cli/index.ts` wiring is verified by `tsc --noEmit` + the existing test suite staying green, matching how the original assrt/opensubtitles wiring in this file was added)**

Run: `npx vitest run && npm run check`
Expected: PASS — full suite green, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts src/cli/index.ts .env.example
git commit -m "feat(doctor): add checkZimuku probe"
```

---

## Phase F — offline integration test + backlog

### Task 24: end-to-end offline integration test

**Files:**
- Create: `src/cli/adapters/zimukuAdapter.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/adapters/zimukuAdapter.integration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { makeZimukuAdapter } from './zimukuAdapter.js'
import { ZimukuClient } from '../../adapters/providers/zimuku.js'
import { ZimukuSessionStore } from '../../adapters/providers/zimukuSession.js'
import { MinIntervalLimiter } from '../../adapters/providers/assrt.js'
import { downloadDirect } from '../../adapters/download/direct.js'
import { writeSubtitle } from '../../files/subtitleWriter.js'
import { runSearch, runResolve } from '../fetchLib.js'

describe('zimuku end-to-end offline (challenge → solve → search → resolve → download → unzip → write)', () => {
  it('produces an installed subtitle file from a cold session, exercising the full FetchAdapter contract', async () => {
    const challengeHtml = readFileSync('fixtures/zimuku/challenge.html', 'utf8')
    const searchHtml = readFileSync('fixtures/zimuku/search-spy-family.html', 'utf8')
    const detailHtml = readFileSync('fixtures/zimuku/detail-58421.html', 'utf8')

    const zip = new AdmZip()
    zip.addFile('spy_family_s01_zh.srt', Buffer.from(
      '1\n00:00:01,000 --> 00:00:03,500\n阿尼亚喜欢花生\n\n2\n00:00:04,000 --> 00:00:06,200\n任务开始\n\n',
    ))
    const zipBuffer = zip.toBuffer()

    let searchCallCount = 0
    const fetchImpl = async (url: string) => {
      const u = String(url)
      if (u.includes('/search?q=')) {
        searchCallCount++
        return searchCallCount === 1 ? new Response(challengeHtml) : new Response(searchHtml)
      }
      if (u.includes('/detail/58421.html')) return new Response(detailHtml)
      if (u.includes('security_verify_img')) return new Response(Buffer.from('png'))
      if (u.includes('aq_wzws_confirm.html')) {
        return new Response('ok', { headers: { 'set-cookie': 'security_session_verify=e2e789; Path=/' } })
      }
      if (u.includes('static.zimuku.org')) return new Response(zipBuffer)
      throw new Error(`unexpected fetch in test: ${u}`)
    }

    const sessionStore = new ZimukuSessionStore(mkdtempSync(join(tmpdir(), 'zimuku-e2e-session-')))
    const client = new ZimukuClient({
      sessionStore, fetchImpl: fetchImpl as unknown as typeof fetch,
      solve: async () => ({ digits: '74504' }),
      limiter: new MinIntervalLimiter(1),
    })
    const adapter = makeZimukuAdapter(client)

    // 1. search(模拟 fetchLib.runSearch 的调度层)
    const candidates = await runSearch({ queries: ['间谍过家家'], deep: false }, [adapter], () => {})
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({ provider: 'zimuku', providerId: '58421', fileList: [] })

    // 2. resolve(模拟 fetchLib.runResolve)
    const resolved = await runResolve({ provider: 'zimuku', providerId: candidates[0].providerId, fileIndex: null }, [adapter])
    expect(resolved.filename).toBe('spy_family_s01_zh.zip')
    expect(resolved.headers).toMatchObject({ 'Accept-Language': 'zh-CN,zh;q=0.9' })

    // 3. download(headers 必须原样带到归档 GET——这是 Phase E 打通的那道缝)
    const dl = await downloadDirect(resolved.url, { fetchImpl: fetchImpl as unknown as typeof fetch, headers: resolved.headers })
    expect(dl.bytes.length).toBeGreaterThan(0)

    // 4. write(zero-changes 路径:pickFromZip 靠 .zip 扩展名自动触发,见 subtitleWriter.ts)
    const outDir = mkdtempSync(join(tmpdir(), 'zimuku-e2e-out-'))
    const written = await writeSubtitle({
      artifact: dl.bytes, artifactFilename: resolved.filename!,
      videoFilename: 'SPY.FAMILY.S01E01.mkv', langTag: 'zh-Hans', outDir,
    })
    expect(existsSync(written.path)).toBe(true)
    expect(written.path).toContain('SPY.FAMILY.S01E01.zh-Hans.srt')
    expect(readFileSync(written.path, 'utf8')).toContain('阿尼亚喜欢花生')

    // 会话 cookie 已经缓存下来,供下一次 job 复用(不必重新破解)
    expect(sessionStore.get()?.cookie).toBe('security_session_verify=e2e789')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/adapters/zimukuAdapter.integration.test.ts`
Expected: This test should actually **pass immediately** — every module it exercises (`ZimukuClient`, `makeZimukuAdapter`, `runSearch`/`runResolve`, `downloadDirect`, `writeSubtitle`) was already fully implemented and tested in Tasks 1–23. This task's purpose is to catch **integration** gaps that per-module unit tests can't see (e.g. a header key-casing mismatch between `zimukuAdapter.resolve()` and what `downloadDirect` expects, or the `.zip` filename not actually triggering `pickFromZip`). If it fails, read the failure carefully — it means one of the earlier tasks has a seam bug that its own unit tests didn't catch; fix the relevant module (not this test) before proceeding.

- [ ] **Step 3: (no implementation step — this task should be GREEN on first run if Tasks 1–23 are correct; do not skip Step 2)**

- [ ] **Step 4: Run full suite + typecheck**

Run: `npx vitest run && npm run check`
Expected: PASS — entire repo test suite green, `tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/adapters/zimukuAdapter.integration.test.ts
git commit -m "test(zimuku): offline end-to-end integration test"
```

---

## Backlog (explicitly deferred, per the design doc's "不做清单")

- **`.rar` archives.** v1 only unzips `.zip` (`writeSubtitle`'s `UnsupportedArchiveError` already fails closed on other extensions — zero new code needed to make this safe). If a zimuku detail page's download link resolves to a `.rar`, `resolve()` still returns it with a `.rar` filename and `writeSubtitle` throws `UnsupportedArchiveError`, which surfaces as a `structural-reject`/`error` candidate outcome in `pipeline.ts`, not a crash. Adding `.rar` support (`node-unrar` or shelling out to a system `unrar` binary) is deferred until real-traffic data shows how common it is on zimuku specifically.
- **Tesseract fast-path for CAPTCHA OCR.** v1 is LLM-vision-only (`solveNumericCaptcha`). The design doc notes a zero-cost local Tesseract fast-path (digit whitelist `0123456789`) as a possible latency/cost optimization, cascading to the LLM only on a low-confidence OCR read. Deferred — it needs production telemetry on solve latency/cost before it's worth the added dependency (`tesseract.js` or a native binding) and the confidence-scoring logic Tesseract would need to gate the cascade.
- **Multi-file zimuku season packs.** `parseDetailPage`/`ZimukuDetailResult` model v1 as single-subtitle archives (first subtitle entry in the zip, matching `writeSubtitle`'s default `selectFileName`-omitted behavior). If a zimuku archive contains a full season's worth of per-episode files, v1 has no way to enumerate them pre-download (`fileList` stays `[]`) — the season-pack graduation/sweep logic in `core/pipeline.ts` (`pickSeasonPack`, `shouldGraduate`) requires `fileList.length >= 2`, so zimuku candidates never qualify and always take the single-file path (harmless — just no season-pack upside, not a correctness bug). Enumerating a zimuku archive's contents pre-download would need either a HEAD-then-list-remote-zip trick or a download-then-inspect-before-candidate-selection redesign, both bigger changes than this plan's scope.
- **Live-markup verification (do this before `ZIMUKU_ENABLED=true` in production).** `parseSearchResults`, `parseDetailPage`, and `parseChallenge` in this plan are built against **hand-authored fixture HTML**, consistent with the design doc's documented evidence (`YunsuoAutoJump`, `security_verify_img`, cookie name `security_session_verify`, and an `id="down"` download-button convention referenced by community bypass scripts) — not a live capture, because this plan was authored read-only without hitting zimuku.org. Before enabling `ZIMUKU_ENABLED=true` in production: use `agent-browser` (already used for the design doc's initial recon, see `scratchpad/zimuku-landing.png`) to capture real `/search?q=...`, `/detail/<id>.html`, and challenge-page HTML; diff them against `fixtures/zimuku/*.html`; adjust the three parsers' regexes if the real markup differs. This is exactly the "real-site integration is a manual/e2e step, not an automated test" carve-out from the design doc's test-strategy section — it is intentionally **not** one of the 24 tasks above.
