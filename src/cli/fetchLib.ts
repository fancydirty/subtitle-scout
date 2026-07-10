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
  | { event: 'api_call'; provider: string; endpoint: string; status: number | null; durationMs: number; error?: string }
  | { event: 'provider_error'; provider: string; message: string }

export interface FetchAdapter {
  name: string   // equals the ProviderName it emits
  enabled: (args: FetchArgs, env: NodeJS.ProcessEnv) => boolean
  search: (args: FetchArgs, emit: (e: FetchEvent) => void) => Promise<SubtitleCandidate[]>
  resolve: (ref: CandidateRef, emit: (e: FetchEvent) => void) => Promise<{ url: string; filename?: string }>
}

export async function runSearch(
  args: FetchArgs, adapters: FetchAdapter[], emit: (e: FetchEvent) => void, env: NodeJS.ProcessEnv = process.env,
): Promise<SubtitleCandidate[]> {
  const enabled = adapters.filter(a => a.enabled(args, env))
  const failures: { provider: string; message: string }[] = []
  const results = await Promise.all(enabled.map(a =>
    a.search(args, emit).catch(e => {
      emit({ event: 'provider_error', provider: a.name, message: String(e) })
      failures.push({ provider: a.name, message: String(e) })
      return [] as SubtitleCandidate[]
    })))
  // 全部启用的 provider 都失败 ≠ "确实没有字幕"：整体抛错（CLI exit 1 → pipeline 'error'，不写负缓存）。
  // 部分失败仍 fail-soft——活着的 provider 结果照常返回。
  if (enabled.length > 0 && failures.length === enabled.length) {
    throw new Error(`all providers failed: ${failures.map(f => `${f.provider}: ${f.message}`).join('; ')}`)
  }
  const byKey = new Map<string, SubtitleCandidate>()
  for (const c of results.flat()) if (!byKey.has(candidateKey(c))) byKey.set(candidateKey(c), c)
  return [...byKey.values()]
}

export async function runResolve(
  ref: CandidateRef, adapters: FetchAdapter[], emit: (e: FetchEvent) => void = () => {},
): Promise<{ url: string; filename?: string }> {
  const adapter = adapters.find(a => a.name === ref.provider)
  if (!adapter) throw new Error(`no adapter for provider ${ref.provider}`)
  return adapter.resolve(ref, emit)
}
