import { generateText, tool, type LanguageModel, type ModelMessage } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'

export const LLM_TIMEOUT_MS = 120_000

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 逐字段合并进每个请求体的额外参数。provider 怪癖逃生舱：
   *  例如 DeepSeek v4 系列默认开 thinking 且 thinking 模式拒绝强制 tool_choice，
   *  需要 {"thinking":{"type":"disabled"}}（2026-07-06 实测）。 */
  extraBody?: Record<string, unknown>
}

/** 把 extraBody 合并进 JSON 请求体；非 JSON body 原样放行 */
export function injectExtraBody(init: RequestInit | undefined, extra: Record<string, unknown>): RequestInit | undefined {
  if (!init?.body || typeof init.body !== 'string') return init
  return { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) }
}

/** True iff the error is a connection-ESTABLISHMENT failure — the request never reached the
 *  server, so retrying with a fresh connection is safe (no double-effect risk). Matches the
 *  undici/node connect-error shapes the soft-router mimo failure took ("Cannot connect to API:
 *  Connect Timeout Error", UND_ERR_CONNECT_TIMEOUT, ECONNREFUSED, …). Deliberately checks
 *  error `code`/`cause.code`/`cause.message` — NOT arbitrary message text — so a model output or
 *  a 4xx that merely mentions "connection timeout" is never misclassified as retryable.
 *  See docs/design/2026-07-14-provider-proxy-hijack-root-cause.md (软路由复核). */
export function isConnectError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown; cause?: { code?: unknown; message?: unknown } }
  const codes = [err?.code, err?.cause?.code].map(String).join(' ')
  if (/UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|UND_ERR_SOCKET/i.test(codes)) return true
  // fall back to the top-level Error message + cause.message (NOT a bare string, NOT nested output)
  const msgs = [err?.message, err?.cause?.message].filter(v => typeof v === 'string').join(' ')
  return /Connect Timeout|fetch failed|other side closed|socket hang up/i.test(msgs)
}

export interface ConnectRetryOpts {
  /** extra attempts AFTER the first (default 3 → up to 4 total). */
  retries?: number
  /** base backoff in ms; grows exponentially with jitter (default 400). */
  baseDelayMs?: number
  /** injectable for tests. */
  sleep?: (ms: number) => Promise<void>
}

/** Wrap a fetch so connection-establishment failures retry as BRAND-NEW fetch calls with backoff.
 *  Each retry is a fresh connection → fresh DNS resolution → likely a different IP from a
 *  multi-IP pool, which is the whole point: the soft-router mimo timeouts came from a subset of
 *  the endpoint's 8-IP Alibaba pool being intermittently blackholed, and the AI SDK's own retries
 *  reused the same bad connection. We only ever see PRE-Response throws here (once fetch resolves a
 *  Response we return it and never retry body-read errors), so retrying is idempotency-safe. */
export function withConnectRetry(fetchImpl: typeof fetch, opts: ConnectRetryOpts = {}): typeof fetch {
  const retries = opts.retries ?? 3
  const base = opts.baseDelayMs ?? 400
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fetchImpl(input, init)
      } catch (e) {
        lastErr = e
        if (!isConnectError(e) || attempt === retries) throw e
        if (init?.signal?.aborted) throw e
        const delay = base * 2 ** attempt + Math.floor(Math.random() * base)
        await sleep(delay)
      }
    }
    throw lastErr
  }) as typeof fetch
}

export function makeModel(cfg: LlmConfig): LanguageModel {
  const extra = cfg.extraBody
  const baseFetch: typeof fetch = extra
    ? ((url, init) => fetch(url, injectExtraBody(init, extra))) as typeof fetch
    : fetch
  const provider = createOpenAICompatible({
    name: 'subtitle-scout-llm',
    baseURL: cfg.baseUrl,
    apiKey: cfg.apiKey,
    // Connection-level resilience against transient overseas-transit blackholes on the mimo
    // endpoint's multi-IP pool (see withConnectRetry / the root-cause doc). Composes over the
    // extraBody-injecting fetch so provider quirks and retries both apply.
    fetch: withConnectRetry(baseFetch),
  })
  return provider(cfg.model)
}

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

export interface CallStructuredResult<T> {
  parsed: T
  rawText: string
  retries: number
  durationMs: number
  prompt: string
}

export class StructuredOutputError extends Error {}

export class ToolChoiceRejectionError extends Error {
  constructor(cause: unknown) {
    super(`provider rejected forced tool_choice: ${String(cause)}`)
  }
}

/** 只对 provider 原始 API 错误做文本匹配（未混入模型输出，无碰撞风险） */
function isRawToolChoiceApiError(e: unknown): boolean {
  return /tool[_ ]choice|thinking mode/i.test(String(e))
}

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

/**
 * 强制单 tool 调用的结构化输出。绝不使用 response_format:json_schema——
 * MiMo 会静默忽略 schema(2026-07-06 实测)。
 */
export async function callStructured<S extends z.ZodType>(
  opts: CallStructuredOpts<S>,
): Promise<CallStructuredResult<z.infer<S>>> {
  const t0 = Date.now()
  let lastError = ''
  let finalPrompt = opts.prompt

  for (let attempt = 0; attempt <= 1; attempt++) {
    const prompt =
      attempt === 0
        ? opts.prompt
        : `${opts.prompt}\n\nYour previous answer failed validation:\n${lastError}\nCall the tool again with a corrected, complete argument object.`
    finalPrompt = prompt

    let result
    try {
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
        // Reasoning models can burn thousands of tokens before the tool call.
        // 4000 was exhausted by reasoning alone on a 10-candidate ranking
        // (textTokens:1, reasoningTokens:3999) — raised to 16000.
        maxOutputTokens: opts.maxOutputTokens ?? 16000,
        abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      })
    } catch (e) {
      // provider 拒绝 tool_choice → 立即抛 ToolChoiceRejectionError（不重试）
      if (isRawToolChoiceApiError(e)) {
        throw new ToolChoiceRejectionError(e)
      }
      // SDK 层的 tool 参数校验失败等其他错误走重试路径
      lastError = String(e)
      continue
    }

    const call = result.toolCalls[0]
    if (!call) {
      lastError = 'no tool call was produced'
      continue
    }

    const parsed = opts.schema.safeParse(call.input)
    if (parsed.success) {
      return {
        parsed: parsed.data,
        rawText: result.text,
        retries: attempt,
        durationMs: Date.now() - t0,
        prompt: finalPrompt,
      }
    }
    lastError = `${parsed.error.message}\nraw tool input was: ${JSON.stringify(call.input)}`
  }

  throw new StructuredOutputError(
    `schema validation failed after retry: ${lastError}`,
  )
}

/** provider 拒绝强制 tool_choice / thinking 冲突类错误（探针阶梯与运行时自愈共用） */
export function isToolChoiceRejection(e: unknown): boolean {
  return e instanceof ToolChoiceRejectionError
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
      prompt: buildPrompt(prompt, opts.images),
      maxOutputTokens: opts.maxOutputTokens ?? 16000,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
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
