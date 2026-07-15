import { candidateKey, type CandidateRef, type SubtitleCandidate } from '../core/schemas.js'

export interface FetchArgs {
  queries: string[]
  imdb?: string
  year?: number
  season?: number
  episode?: number
  filename?: string
  languages?: string[]   // lowercase; adapters default ['zh-cn','zh-tw']
  deep: boolean
}
export type FetchEvent =
  /** droppedEntries：per-entry fail-soft 过滤丢弃的条目数（见 adapters/providers/assrt.ts /
   *  opensubtitles.ts 的 filterMalformedSubs / filterMalformedOsData）。可选——大多数 api_call
   *  没有触发过滤。MINOR-1 review finding：这个字段之前只停在 provider client 的 onApiCall
   *  回调形状上，从未声明到 FetchEvent，journal 消费方（cli/index.ts）读不到它。 */
  | { event: 'api_call'; provider: string; endpoint: string; status: number | null; durationMs: number; error?: string; droppedEntries?: number }
  /** code/resetAt：OpenSubtitles 配额耗尽契约（见 adapters/providers/opensubtitles.ts 的
   *  OsQuotaExhaustedError）。可选——大多数 provider_error 没有配额语义，只带 provider/message。 */
  | { event: 'provider_error'; provider: string; message: string; code?: string; resetAt?: string | null }
  /** 信息性事件，不是失败：本次调用成功了，只是响应体里带了值得留意的信号（如 OS 下载成功但
   *  remaining<=0，提前预警下一次调用会撞配额）。journal/dashboard 消费方必须把它当成功路径的
   *  旁注渲染，不能算作 provider_error——否则一次成功下载在日志里显示成一个错误步骤
   *  （review finding：journal honesty）。同样带可选 code/resetAt，形状与 provider_error 对齐。 */
  | { event: 'provider_notice'; provider: string; message: string; code?: string; resetAt?: string | null }

/** provider_error 事件 → 消费方（journal 等）载荷：把 code/resetAt 随 provider/message 一并转发，
 *  避免各消费方各自 duck-type 读取 FetchEvent 上的可选字段。 */
export function providerErrorFields(
  e: Extract<FetchEvent, { event: 'provider_error' }>,
): { provider: string; message: string; code?: string; resetAt?: string | null } {
  return { provider: e.provider, message: e.message, code: e.code, resetAt: e.resetAt }
}

/** provider_notice 事件 → 消费方载荷，字段规则同 providerErrorFields（见上）；
 *  单独声明是为了让调用方按 event 分支各自持有类型化的 Extract，不必手写 duck-typing。 */
export function providerNoticeFields(
  e: Extract<FetchEvent, { event: 'provider_notice' }>,
): { provider: string; message: string; code?: string; resetAt?: string | null } {
  return { provider: e.provider, message: e.message, code: e.code, resetAt: e.resetAt }
}

export interface FetchAdapter {
  name: string   // equals the ProviderName it emits
  enabled: (args: FetchArgs, env: NodeJS.ProcessEnv) => boolean
  search: (args: FetchArgs, emit: (e: FetchEvent) => void) => Promise<SubtitleCandidate[]>
  resolve: (ref: CandidateRef, emit: (e: FetchEvent) => void) => Promise<{ url: string; filename?: string; headers?: Record<string, string> }>
}

/** A4: historical per-provider default when the caller doesn't specify languages — matches
 *  FetchArgs.languages's own documented "adapters default ['zh-cn','zh-tw']" convention. Every
 *  dispatch path that reaches runSearch (the old fetch path — pipeline.ts → providerPort.ts →
 *  subtitle-fetch.ts subprocess; the v3 find-subtitle worker's search_source tool, whose
 *  `languages` param the MODEL decides whether to pass; the standalone `subtitle-fetch` CLI
 *  without --languages) can leave args.languages undefined. A language-gated adapter (assrt —
 *  see assrtAdapter.ts, a China-only source) must not silently drop out of an un-annotated
 *  search just because nobody happened to say "zh" out loud — used ONLY to compute which
 *  adapters are `enabled` below, so it never overrides an adapter's own internal default for the
 *  args its search() actually receives. */
const DEFAULT_ENABLED_CHECK_LANGUAGES = ['zh']

export async function runSearch(
  args: FetchArgs, adapters: FetchAdapter[], emit: (e: FetchEvent) => void, env: NodeJS.ProcessEnv = process.env,
): Promise<SubtitleCandidate[]> {
  const gateArgs = args.languages?.length ? args : { ...args, languages: DEFAULT_ENABLED_CHECK_LANGUAGES }
  const enabled = adapters.filter(a => a.enabled(gateArgs, env))
  // 零 provider ≠ "诚实无结果"：配置缺失必须 fail-fast（CLI exit 1 → pipeline 'error'，不写负缓存）。
  // f0ab58b 删除了 assemble() 的 requireEnv 启动守卫后，这里是防"静默毒库"的唯一防线。
  if (enabled.length === 0) {
    throw new Error('no providers configured — set ASSRT_TOKEN, OPENSUBTITLES_API_KEY, and/or ZIMUKU_ENABLED=true')
  }
  const failures: { provider: string; message: string }[] = []
  const results = await Promise.all(enabled.map(a =>
    a.search(args, emit).catch(e => {
      emit({ event: 'provider_error', provider: a.name, message: String(e) })
      failures.push({ provider: a.name, message: String(e) })
      return [] as SubtitleCandidate[]
    })))
  // 全部启用的 provider 都失败 ≠ "确实没有字幕"：整体抛错（CLI exit 1 → pipeline 'error'，不写负缓存）。
  // 部分失败仍 fail-soft——活着的 provider 结果照常返回。
  if (failures.length === enabled.length) {
    throw new Error(`all providers failed: ${failures.map(f => `${f.provider}: ${f.message}`).join('; ')}`)
  }
  const byKey = new Map<string, SubtitleCandidate>()
  for (const c of results.flat()) if (!byKey.has(candidateKey(c))) byKey.set(candidateKey(c), c)
  return [...byKey.values()]
}

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
