import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AssrtSearchResponseSchema, AssrtDetailResponseSchema, AssrtQuotaResponseSchema,
  type AssrtSub, type SubtitleCandidate,
} from '../../core/schemas.js'
import type { z } from 'zod'

const BASE = 'https://api.assrt.net/v1'
const RESPONSE_CACHE_TTL_MS = 24 * 3600_000
// detail 的签名 URL 数小时内有效；10min 短缓存让季包 N 集 resolve 只打一次真请求，同时防过期 URL 落盘长期复用
const DETAIL_CACHE_TTL_MS = 10 * 60_000
// 实测配额 5/min，留余量:15s 间隔 = 4/min
export const DEFAULT_MIN_INTERVAL_MS = 15_000
export const ASSRT_TIMEOUT_MS = 15_000

export class AssrtApiError extends Error {
  constructor(public status: number, endpoint: string) {
    super(`ASSRT ${endpoint} returned status ${status}`)
  }
}

export class MinIntervalLimiter {
  private last = 0
  constructor(private intervalMs: number) {}
  async wait() {
    const now = Date.now()
    const delta = now - this.last
    if (delta < this.intervalMs) await new Promise(r => setTimeout(r, this.intervalMs - delta))
    this.last = Date.now()
  }
}

export interface AssrtClientOpts {
  token: string
  fetchImpl?: typeof fetch
  limiter?: MinIntervalLimiter
  cacheDir: string
  networkRetryDelayMs?: number
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string; droppedEntries?: number }) => void
}

/**
 * 生产事故复现：ASSRT /sub/similar 响应里 sub.subs[2..4] 缺 id 字段——zod 要求 id:number，
 * 单条非法就把整批 subs 一起判死刑（"Invalid input: expected number, received undefined" ×3），
 * similar() 抛错 → adapter emit provider_error → pipeline 残缺集守卫判 retry_later → 死循环重试。
 * 但主搜索/detail 明明拿到了好结果，不该因为混进几条坏数据就整批作废。
 *
 * 逐条 safeParse：坏条目（缺 id 或其它字段不合法）单独丢弃，好条目原样保留，交给外层
 * schema.parse 走一遍正常解析/归一化。复用已导出的 AssrtSearchResponseSchema 校验单条
 * （包一层最小响应壳）而不是新导出内部 per-item schema——判定标准和真实 parse 完全一致。
 * json 结构本身不可用（非对象/无 sub/subs 非数组）时原样放行，交给外层 schema.parse 正常报错——
 * 那才是"响应本身不可用"，必须继续失败以保住残缺集守卫。
 */
function filterMalformedSubs(json: unknown): { data: unknown; dropped: number } {
  if (json == null || typeof json !== 'object') return { data: json, dropped: 0 }
  const sub = (json as { sub?: unknown }).sub
  if (sub == null || typeof sub !== 'object') return { data: json, dropped: 0 }
  const rawSubs = (sub as { subs?: unknown }).subs
  if (!Array.isArray(rawSubs)) return { data: json, dropped: 0 }
  const valid: unknown[] = []
  let dropped = 0
  for (const item of rawSubs) {
    const r = AssrtSearchResponseSchema.safeParse({ status: 0, sub: { subs: [item] } })
    if (r.success) valid.push(item)
    else dropped++
  }
  if (dropped === 0) return { data: json, dropped: 0 }
  return { data: { ...json, sub: { ...sub, subs: valid } }, dropped }
}

export class AssrtClient {
  private fetchImpl: typeof fetch
  private limiter: MinIntervalLimiter
  constructor(private opts: AssrtClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.limiter = opts.limiter ?? new MinIntervalLimiter(DEFAULT_MIN_INTERVAL_MS)
    mkdirSync(opts.cacheDir, { recursive: true })
  }

  private cachePath(endpoint: string, params: Record<string, string>) {
    const key = createHash('sha1').update(endpoint + JSON.stringify(params)).digest('hex')
    return join(this.opts.cacheDir, `${key}.json`)
  }

  /** cacheTtlMs：命中缓存的时间窗口；false 表示完全不缓存（读/写都跳过）。默认 24h。 */
  private async call<T>(endpoint: string, params: Record<string, string>, schema: z.ZodType<T>, cacheTtlMs: number | false = RESPONSE_CACHE_TTL_MS): Promise<T> {
    const cacheFile = this.cachePath(endpoint, params)
    if (cacheTtlMs !== false && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < cacheTtlMs) {
      return schema.parse(JSON.parse(readFileSync(cacheFile, 'utf8')))
    }
    const qs = new URLSearchParams({ token: this.opts.token, ...params })
    // 网络层失败（fetch 拒绝、非 JSON）重试一次；API status 非 0 不重试
    let lastNetworkError: unknown
    for (let attempt = 0; attempt <= 1; attempt++) {
      await this.limiter.wait()
      const t0 = Date.now()
      try {
        const res = await this.fetchImpl(`${BASE}/${endpoint}?${qs}`, {
          signal: AbortSignal.timeout(ASSRT_TIMEOUT_MS),
        })
        const json = await res.json() as { status?: number }
        const status = typeof json.status === 'number' ? json.status : null
        // search/similar/searchByFilename/detail 共用 AssrtSearchResponseSchema（这四个 endpoint
        // 全部走这一份 sub.subs 解析逻辑）——只对这类响应做逐条 fail-soft 过滤；quota 等其它
        // schema 不含 subs，原样直通。
        const { data: payload, dropped } = status === 0 && (schema as unknown) === AssrtSearchResponseSchema
          ? filterMalformedSubs(json)
          : { data: json as unknown, dropped: 0 }
        this.opts.onApiCall?.({ endpoint, params, status, durationMs: Date.now() - t0, ...(dropped > 0 ? { droppedEntries: dropped } : {}) })
        if (status !== 0) throw new AssrtApiError(status ?? -1, endpoint)
        if (cacheTtlMs !== false) writeFileSync(cacheFile, JSON.stringify(payload))
        return schema.parse(payload)
      } catch (e) {
        if (e instanceof AssrtApiError) throw e
        this.opts.onApiCall?.({ endpoint, params, status: null, durationMs: Date.now() - t0, error: String(e) })
        lastNetworkError = e
        if (attempt < 1) await new Promise(r => setTimeout(r, this.opts.networkRetryDelayMs ?? 2000))
      }
    }
    throw lastNetworkError
  }

  quota() { return this.call('user/quota', {}, AssrtQuotaResponseSchema) }
  search(q: string) {
    return this.call('sub/search', { q, filelist: '1', no_muxer: '1' }, AssrtSearchResponseSchema)
  }
  /** ASSRT 白捡增益①：传命中 id 返最多 5 条相似字幕（免费召回扩展）。 */
  similar(id: number) {
    return this.call('sub/similar', { id: String(id) }, AssrtSearchResponseSchema)
  }
  /** ASSRT 白捡增益②：整文件名精确模式兜底查询。 */
  searchByFilename(filename: string) {
    return this.call('sub/search', { q: filename, is_file: '1', filelist: '1', no_muxer: '1' }, AssrtSearchResponseSchema)
  }
  detail(id: number) {
    // detail 的签名 URL 数小时内有效；10min 短缓存让季包 N 集 resolve 只打一次真请求，同时防过期 URL 落盘长期复用
    return this.call('sub/detail', { id: String(id) }, AssrtDetailResponseSchema, DETAIL_CACHE_TTL_MS)
  }
}

export function toCandidate(sub: AssrtSub): SubtitleCandidate {
  const native = Array.isArray(sub.native_name) ? sub.native_name.join(' / ') : sub.native_name
  return {
    provider: 'assrt',
    providerId: String(sub.id),
    videoName: sub.videoname ?? sub.filename ?? null,
    nativeName: native ?? null,
    language: sub.lang?.desc ?? null,
    subtype: sub.subtype ?? null,
    releaseSite: sub.release_site ?? null,
    uploadDate: null, // ASSRT 搜索响应不含上传日期
    fileList: sub.filelist.map((f, i) => ({ index: i, name: f.f })),
  }
}
