import { type LanguageModel } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export const LLM_TIMEOUT_MS = 120_000

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 逐字段合并进每个请求体的额外参数。provider 怪癖逃生舱：不同 provider/模型各自的请求体
   *  怪癖用这个字段按需打补丁即可，不必为每种怪癖单独开一个 config 选项。例如某些 reasoning
   *  模型默认开 thinking，而调用方想要的输出形状要求显式关掉，就传
   *  {"thinking":{"type":"disabled"}}——具体哪家 provider/哪个版本有怪癖会随时间变化，机制
   *  本身跟怪癖是什么无关，这里不绑定某一次具体故障的细节。 */
  extraBody?: Record<string, unknown>
}

/** 把 extraBody 合并进 JSON 请求体；非 JSON body 原样放行（含"是 string 但非合法 JSON"的情况） */
export function injectExtraBody(init: RequestInit | undefined, extra: Record<string, unknown>): RequestInit | undefined {
  if (!init?.body || typeof init.body !== 'string') return init
  try {
    return { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...extra }) }
  } catch {
    // body 是 string 但非合法 JSON：原样放行（不合并 extra，让调用方按原样发送）
    return init
  }
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
