// src/cli/watchClients.ts：setup 模式（spec A §4.2/§4.7）——长命客户端 holder + secrets_version
// watcher（daemon preTick）+ 产工作许可谓词。cmdWatch boot 建一次 holder；wizard 落库
// bump version → 下一 tick rebuild 整体换 current → 同进程点火，容器零重启。
// 消费方纪律：一切长命客户端（tmdb/reasoningModel/realignAdapters/ingestPass/reconcileAll）
// 一律经 clients.current 现取，含 dashboard 注入面（getter 形式，见 Task 12）。

import type { AdapterConfigResolver } from '../v2/secrets.js'

/** 长命客户端 holder——cmdWatch 里所有闭包统一经 .current 取用（spec §4.2 钉死的替换机制）。 */
export interface ClientsHolder<T> { current: T }

export interface SecretsWatcherOpts {
  readVersion: () => number
  /** 版本变化时调用；内部负责重建并整体替换 holder.current。 */
  rebuild: (log: (msg: string) => void) => Promise<void>
  log: (msg: string) => void
  initialVersion: number
}

/** daemon preTick 钩：每 tick 比对 secrets_version，变了才 rebuild。首 tick 只建立基线
 *  （boot 已建过一轮）。rebuild 失败 → warn + seen 不前进 → 下一 tick 自动重试，
 *  旧客户端继续服役（热重建失败绝不弄死正在干活的进程）。 */
export function makeSecretsWatcher(opts: SecretsWatcherOpts): () => Promise<void> {
  let seen = opts.initialVersion
  return async () => {
    const v = opts.readVersion()
    if (v === seen) return
    try {
      await opts.rebuild(opts.log)
      opts.log(`secrets changed (version ${seen} → ${v}) — clients rebuilt`)
      seen = v
    } catch (e) {
      opts.log(`warn: secrets rebuild failed (version ${seen} → ${v}): ${e instanceof Error ? e.message : String(e)} — keeping previous clients, will retry next tick`)
    }
  }
}

/** setup 闸（spec §4.7 步 3）：TMDB + LLM 三件套全部可解析（env 或库）才算满足。
 *  cfg 的 dbGet 是惰性读库，每次调用都是新鲜值——wizard 落库后下一 tick 自然转 true。 */
export function setupSatisfied(cfg: AdapterConfigResolver): boolean {
  return cfg.secret('TMDB_API_KEY').value !== null
    && cfg.secret('LLM_BASE_URL').value !== null
    && cfg.secret('LLM_API_KEY').value !== null
    && cfg.secret('LLM_MODEL').value !== null
}

/** engine_enabled（spec §4.6）：fail-open——只有精确 'false' 才视为关，脏值/缺省一律开。 */
export function engineEnabled(get: (key: string) => string | null): boolean {
  return get('engine_enabled') !== 'false'
}

/** 点火日志追踪（spec §4.7 步 4）：setup 闸从"不满足"翻成"满足"的那一刻记一行
 *  'setup complete — engine live'——同进程点火的唯一可观测标志。初始即满足（现有 env
 *  部署升级）时永不记——那一行对老部署是假新闻。 */
export function makeSatisfactionTracker(opts: {
  satisfied: () => boolean
  log: (msg: string) => void
}): () => void {
  let was = opts.satisfied()
  return () => {
    const now = opts.satisfied()
    if (!was && now) opts.log('setup complete — engine live')
    was = now
  }
}
