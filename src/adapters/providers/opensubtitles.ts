import { z } from 'zod'
import type { SubtitleCandidate } from '../../core/schemas.js'

const BASE = 'https://api.opensubtitles.com/api/v1'
const DEFAULT_LANGUAGES = ['zh-cn', 'zh-tw']

export const OsSearchResponseSchema = z.object({
  total_count: z.number().default(0),
  data: z.array(z.object({
    id: z.string(),
    attributes: z.object({
      subtitle_id: z.string().optional(),
      language: z.string().nullish(),
      release: z.string().nullish(),
      upload_date: z.string().nullish(),
      download_count: z.number().nullish(),
      feature_details: z.object({
        season_number: z.number().nullish(),
        episode_number: z.number().nullish(),
        year: z.number().nullish(),
        title: z.string().nullish(),
      }).passthrough().nullish(),
      files: z.array(z.object({
        file_id: z.number(),
        file_name: z.string().nullish(),
      })).default([]),
    }).passthrough(),
  })).default([]),
})
export type OsSearchResponse = z.infer<typeof OsSearchResponseSchema>

const OsDownloadResponseSchema = z.object({
  link: z.string(),
  file_name: z.string().nullish(),
  remaining: z.number().nullish(),
  reset_time_utc: z.string().nullish(),
})
const OsLoginResponseSchema = z.object({
  token: z.string(),
  base_url: z.string().nullish(),
  user: z.object({ allowed_downloads: z.number().nullish(), vip: z.boolean().nullish() }).nullish(),
})

// HTTP 状态错误标记：区分于网络层错误（前者快失败，后者重试一次），仅内部使用
class OsHttpError extends Error {
  constructor(endpoint: string, public status: number) {
    super(`opensubtitles ${endpoint} HTTP ${status}`)
  }
}

export interface OsClientOpts {
  apiKey: string
  appUserAgent: string
  username?: string
  password?: string
  fetchImpl?: typeof fetch
  networkRetryDelayMs?: number
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string }) => void
}
export interface OsSearchParams {
  imdbId?: number
  parentImdbId?: number // series-level imdb only; no current caller sets this (opensubtitlesAdapter always has an item-level imdb) — kept for API completeness
  season?: number
  episode?: number
  query?: string
  year?: number
  languages: string[]
}

export class OpenSubtitlesClient {
  private fetchImpl: typeof fetch
  private token: string | null = null
  // 并发 ensureLogin 共享同一次 login，防竞态双重登录
  private loginPromise: Promise<void> | null = null
  constructor(private opts: OsClientOpts) { this.fetchImpl = opts.fetchImpl ?? fetch }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { 'Api-Key': this.opts.apiKey, 'User-Agent': this.opts.appUserAgent }
    if (json) h['Content-Type'] = 'application/json'
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  // makeInit 是函数而非值：401 重登录后重试需要用新 token 重建 headers。
  // 网络层错误（fetch 拒绝、非 JSON）重试一次（与 assrt.ts 对齐）；
  // HTTP 状态错误快失败不重试——唯一例外是 401 token 过期自愈（只重试一次，防循环）。
  private async request<T>(endpoint: string, makeInit: () => RequestInit, schema: z.ZodType<T>, params: Record<string, unknown>, allowAuthRetry = true): Promise<T> {
    let lastNetworkError: unknown
    for (let attempt = 0; attempt <= 1; attempt++) {
      const t0 = Date.now()
      let status: number | null = null
      try {
        const res = await this.fetchImpl(`${BASE}${endpoint}`, { ...makeInit(), redirect: 'follow' })
        status = res.status
        if (!res.ok) throw new OsHttpError(endpoint, res.status)
        const body = await res.json()
        this.opts.onApiCall?.({ endpoint: `os${endpoint}`, params, status, durationMs: Date.now() - t0 })
        return schema.parse(body)
      } catch (e) {
        this.opts.onApiCall?.({ endpoint: `os${endpoint}`, params, status, durationMs: Date.now() - t0, error: String(e) })
        if (e instanceof OsHttpError) {
          if (e.status === 401 && this.token && allowAuthRetry) {
            // JWT 过期自愈：清 token 重登录，重试原请求一次
            this.token = null
            await this.ensureLogin()
            return this.request(endpoint, makeInit, schema, params, false)
          }
          throw e
        }
        lastNetworkError = e
        if (attempt < 1) await new Promise(r => setTimeout(r, this.opts.networkRetryDelayMs ?? 2000))
      }
    }
    throw lastNetworkError
  }

  private ensureLogin(): Promise<void> {
    if (this.token || !this.opts.username || !this.opts.password) return Promise.resolve()
    this.loginPromise ??= this.request('/login',
      () => ({ method: 'POST', headers: this.headers(true), body: JSON.stringify({ username: this.opts.username, password: this.opts.password }) }),
      OsLoginResponseSchema, { username: this.opts.username })
      .then(r => { this.token = r.token })
      .finally(() => { this.loginPromise = null })
    return this.loginPromise
  }

  /** 搜索不耗配额。languages 强制小写（大写会 301 循环，实测硬事实）；空数组默认中文双语。 */
  async search(p: OsSearchParams): Promise<OsSearchResponse> {
    const q = new URLSearchParams()
    if (p.parentImdbId != null) q.set('parent_imdb_id', String(p.parentImdbId))
    else if (p.imdbId != null) q.set('imdb_id', String(p.imdbId))
    if (p.season != null) q.set('season_number', String(p.season))
    if (p.episode != null) q.set('episode_number', String(p.episode))
    if (p.query && p.parentImdbId == null && p.imdbId == null) q.set('query', p.query)
    if (p.year != null && p.query) q.set('year', String(p.year))
    const langs = p.languages.length > 0 ? p.languages : DEFAULT_LANGUAGES
    q.set('languages', langs.map(l => l.toLowerCase()).join(','))
    return this.request(`/subtitles?${q}`, () => ({ method: 'GET', headers: this.headers() }), OsSearchResponseSchema, Object.fromEntries(q))
  }

  /** 消耗配额的一步（quota 扣在这，不扣在 link GET）。dev_mode（无账号密码）免 JWT。 */
  async resolveDownload(fileId: number): Promise<z.infer<typeof OsDownloadResponseSchema>> {
    await this.ensureLogin()
    return this.request('/download',
      () => ({ method: 'POST', headers: this.headers(true), body: JSON.stringify({ file_id: fileId }) }),
      OsDownloadResponseSchema, { file_id: fileId })
  }
}

/** OS 一个 subtitle 通常一个文件：providerId = file_id，fileList 留空（单文件 provider）。 */
export function osToCandidates(resp: OsSearchResponse): SubtitleCandidate[] {
  const out: SubtitleCandidate[] = []
  for (const item of resp.data) {
    const a = item.attributes
    for (const f of a.files) {
      out.push({
        provider: 'opensubtitles',
        providerId: String(f.file_id),
        videoName: a.release ?? f.file_name ?? null,
        nativeName: null,
        language: a.language ?? null,
        subtype: 'srt',
        releaseSite: null,
        uploadDate: a.upload_date ?? null,
        fileList: [],
      })
    }
  }
  return out
}
