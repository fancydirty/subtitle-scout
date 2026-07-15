import { type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

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

/** v3 old-pipeline-retirement Wave 3：旧强制 tool-call 栈（callStructured/callPromptJson，及其
 *  专属的 ToolChoiceRejectionError/isToolChoiceRejection/extractJson 同伙）已随 runtime.ts/
 *  probe.ts/profile.ts/quirks.ts 一并删除。这个类单独留下来，是因为
 *  src/adapters/providers/yunsuo.test.ts 仍把它当一个方便的"任意异常类型"样例用在验证码求解
 *  重试测试里——生产路径 solveNumericCaptcha.ts 早已不抛它（见其文件头 Wall ① 注释：v3 已经切到
 *  朴素 generateText + 本地 zod 校验，不走这条旧栈）。不是遗留死代码，是一个仍有真实测试消费者
 *  的独立导出，删除前需先改 yunsuo.test.ts。 */
export class StructuredOutputError extends Error {}
