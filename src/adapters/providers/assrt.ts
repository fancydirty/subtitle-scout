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
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string }) => void
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

  private async call<T>(endpoint: string, params: Record<string, string>, schema: z.ZodType<T>, cacheable = true): Promise<T> {
    const cacheFile = this.cachePath(endpoint, params)
    if (cacheable && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < RESPONSE_CACHE_TTL_MS) {
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
        this.opts.onApiCall?.({ endpoint, params, status, durationMs: Date.now() - t0 })
        if (status !== 0) throw new AssrtApiError(status ?? -1, endpoint)
        if (cacheable) writeFileSync(cacheFile, JSON.stringify(json))
        return schema.parse(json)
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
  detail(id: number) {
    // detail 含时效下载 URL，绝不磁盘缓存（live e2e 实测：缓存的 URL 过期后下载 HTTP 492）
    return this.call('sub/detail', { id: String(id) }, AssrtDetailResponseSchema, false)
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
    uploadDate: null,
    fileList: sub.filelist.map((f, i) => ({ index: i, name: f.f })),
  }
}
