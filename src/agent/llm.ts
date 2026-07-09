import { generateText, tool, type LanguageModel } from 'ai'
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

export function makeModel(cfg: LlmConfig): LanguageModel {
  const extra = cfg.extraBody
  const provider = createOpenAICompatible({
    name: 'subtitle-scout-llm',
    baseURL: cfg.baseUrl,
    apiKey: cfg.apiKey,
    ...(extra
      ? { fetch: ((url, init) => fetch(url, injectExtraBody(init, extra))) as typeof fetch }
      : {}),
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

/**
 * 强制单 tool 调用的结构化输出。绝不使用 response_format:json_schema——
 * MiMo 会静默忽略 schema（2026-07-06 实测）。
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
        prompt,
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
      prompt,
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
