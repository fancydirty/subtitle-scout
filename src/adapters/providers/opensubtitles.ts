import { z } from 'zod'
import type { SubtitleCandidate } from '../../core/schemas.js'

const BASE = 'https://api.opensubtitles.com/api/v1'
const DEFAULT_LANGUAGES = ['zh-cn', 'zh-tw']
// assrt/tmdb 客户端都用 15s（ASSRT_TIMEOUT_MS / TMDB_TIMEOUT_MS），OS 对齐同一个值——
// 之前 OS 是仓库里唯一没设超时的 provider，卡住的端点会拖满 180s 子进程预算（providerPort.ts 的 timeoutMs）。
export const OS_TIMEOUT_MS = 15_000

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

// HTTP 状态错误标记：区分于网络层错误（前者快失败，后者重试一次），仅内部使用。
// body：非 2xx 响应体（尽力 JSON 解析，拿不到就是 undefined）——resolveDownload 用它识别配额耗尽响应。
class OsHttpError extends Error {
  constructor(endpoint: string, public status: number, public body?: unknown) {
    super(`opensubtitles ${endpoint} HTTP ${status}`)
  }
}

// /download 配额耗尽响应体的宽松形状：remaining/reset_time_utc 存在即可判定，其余字段忽略。
// 用来从一个已知是"错误"的 body 里尽力挖配额信息，不代表这是唯一合法形状。
const OsQuotaBodySchema = z.object({
  remaining: z.number().nullish(),
  reset_time_utc: z.string().nullish(),
}).passthrough()

/**
 * OpenSubtitles 下载配额耗尽（remaining<=0 或 /download 406 且响应体带配额字段）。
 * code/resetAt 是给上游（executor 的后续消费者）按 reset 时间退避用的类型化契约——
 * 本次改动只在 adapter 侧定义+抛出/emit 这个契约，不接线到 executor（见 opensubtitlesAdapter.ts）。
 */
export class OsQuotaExhaustedError extends Error {
  readonly code = 'quota_exhausted' as const
  constructor(public resetAt: string | null, public remaining: number | null) {
    super(`opensubtitles download quota exhausted${resetAt ? ` (resets ${resetAt})` : ''}`)
  }
}

/** 从一个 HTTP 错误体里尽力识别"这是配额耗尽响应"：至少要有 remaining 或 reset_time_utc 字段，
 *  避免把无关的 502 网关错误页误判成配额响应。
 *
 *  误判防护（review finding）：字段"存在"不等于"配额耗尽"——一个无关的 4xx（如限流/校验错误）
 *  可能照样在响应体里回声 remaining 字段，且值健康（>0）。必须像成功路径（见
 *  opensubtitlesAdapter.ts 的 `r.remaining <= 0` 判断）一样，只有 remaining<=0 才算耗尽；
 *  remaining>0 一律不是配额响应，原样冒泡成普通 provider 错误。
 *  唯一例外：remaining 字段整体缺失、但 reset_time_utc 还在——OpenSubtitles REST v1 里
 *  reset_time_utc 只出现在 /download 配额响应中（其它错误形状不带这个字段），
 *  所以它单独出现时仍是无歧义的配额信号，判定为耗尽（remaining 记为 null，未知）。 */
function quotaInfoFromErrorBody(body: unknown): { resetAt: string | null; remaining: number | null } | null {
  if (body == null || typeof body !== 'object') return null
  const parsed = OsQuotaBodySchema.safeParse(body)
  if (!parsed.success) return null
  const { remaining, reset_time_utc } = parsed.data
  if (remaining == null && reset_time_utc == null) return null
  if (remaining != null && remaining > 0) return null
  return { resetAt: reset_time_utc ?? null, remaining: remaining ?? null }
}

export interface OsClientOpts {
  apiKey: string
  appUserAgent: string
  username?: string
  password?: string
  fetchImpl?: typeof fetch
  networkRetryDelayMs?: number
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string; droppedEntries?: number }) => void
}

/**
 * 同款脆弱性审计（ASSRT /sub/similar 生产事故同形）：data[] 里单条 datum 缺 id（或其它必填字段）
 * 会把整页搜索结果一起判死刑。逐条 safeParse：坏条目单独丢弃，好条目原样保留，交给外层
 * schema.parse 走一遍正常解析。复用已导出的 OsSearchResponseSchema 校验单条（包一层最小响应壳），
 * 不新增内部 per-item schema 导出。响应本身不可用（非对象/data 非数组）时原样放行，交给外层
 * schema.parse 正常报错——HTTP 错误等真实故障必须继续失败。
 */
function filterMalformedOsData(json: unknown): { data: unknown; dropped: number } {
  if (json == null || typeof json !== 'object') return { data: json, dropped: 0 }
  const rawData = (json as { data?: unknown }).data
  if (!Array.isArray(rawData)) return { data: json, dropped: 0 }
  const valid: unknown[] = []
  let dropped = 0
  for (const item of rawData) {
    const r = OsSearchResponseSchema.safeParse({ data: [item] })
    if (r.success) valid.push(item)
    else dropped++
  }
  if (dropped === 0) return { data: json, dropped: 0 }
  return { data: { ...json, data: valid }, dropped }
}

/**
 * CRITICAL fix（同 assrt.ts 同名审计）：droppedEntries>0 且过滤后 data[] 一条不剩，不是"内容结论"
 * （真的查无搜索结果），是响应形状系统性坏了（provider schema drift 等）。之前被 fail-soft 悄悄
 * 吞成"成功但空"——pipeline 把"零候选 + 零 providerErrors"当成诚实的"确实没有字幕"，写 1 天
 * 负缓存。混合页（kept>=1）不受影响，继续 fail-soft：只丢坏条目，好条目照常返回。
 */
export class OsAllEntriesDroppedError extends Error {
  constructor(public endpoint: string, public droppedCount: number) {
    super(`opensubtitles ${endpoint}: all ${droppedCount} entries in data[] were malformed and dropped (provider schema drift?) — refusing to report this as an honest empty result`)
  }
}

function assertNotAllOsEntriesDropped(endpoint: string, payload: unknown, dropped: number): void {
  if (dropped === 0) return
  const data = (payload as { data?: unknown[] } | null)?.data
  if (!data || data.length === 0) throw new OsAllEntriesDroppedError(endpoint, dropped)
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
        const res = await this.fetchImpl(`${BASE}${endpoint}`, { ...makeInit(), redirect: 'follow', signal: AbortSignal.timeout(OS_TIMEOUT_MS) })
        status = res.status
        if (!res.ok) {
          // 尽力读错误体（配额耗尽响应带 remaining/reset_time_utc）；非 JSON 错误页（如网关 502 HTML）静默忽略。
          const errBody = await res.json().catch(() => undefined)
          throw new OsHttpError(endpoint, res.status, errBody)
        }
        const body = await res.json()
        // search 端点响应同 ASSRT 一样逐条 fail-soft（见 filterMalformedOsData）；其它 schema
        // （login/download）不含 data[] 页面结构，原样直通。
        const { data: payload, dropped } = (schema as unknown) === OsSearchResponseSchema
          ? filterMalformedOsData(body)
          : { data: body as unknown, dropped: 0 }
        // CRITICAL fix：全丢弃必须在 onApiCall(success) 之前抛错——同一条"schema.parse 必须先于
        // onApiCall(success)"纪律（见下），避免同一个 HTTP 请求先记一次假成功再在 catch 里记一次失败。
        assertNotAllOsEntriesDropped(endpoint, payload, dropped)
        // schema.parse 必须先于 onApiCall(success)：否则解析失败会先记一次"成功"再在 catch 里记一次
        // "失败"，同一个 HTTP 请求上报两次 api_call（其一是假成功）。
        const parsed = schema.parse(payload)
        this.opts.onApiCall?.({ endpoint: `os${endpoint}`, params, status, durationMs: Date.now() - t0, ...(dropped > 0 ? { droppedEntries: dropped } : {}) })
        return parsed
      } catch (e) {
        // droppedEntries 随错误一起上报（e instanceof 检查放在 onApiCall 里而不是分支之后：这条
        // onApiCall 调用本身就是本次 HTTP 请求唯一的一条记录，全丢弃时不会再有另一条"成功"记录）。
        this.opts.onApiCall?.({
          endpoint: `os${endpoint}`, params, status, durationMs: Date.now() - t0, error: String(e),
          ...(e instanceof OsAllEntriesDroppedError ? { droppedEntries: e.droppedCount } : {}),
        })
        if (e instanceof OsAllEntriesDroppedError) {
          // AssrtAllEntriesDroppedError 同款处理：确定性地不可用，不是网络层瞬时故障——不重试。
          throw e
        }
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

  /**
   * 消耗配额的一步（quota 扣在这，不扣在 link GET）。dev_mode（无账号密码）免 JWT。
   * 配额耗尽（HTTP 406/4xx 且响应体带 remaining/reset_time_utc）转为类型化 OsQuotaExhaustedError，
   * 而不是原样冒泡一个不带 reset 时间信息的 OsHttpError——调用方（opensubtitlesAdapter）据此
   * emit 一个带 code/resetAt 的 provider_error 事件，供上游按 reset 时间退避（该消费逻辑是后续工作）。
   */
  async resolveDownload(fileId: number): Promise<z.infer<typeof OsDownloadResponseSchema>> {
    await this.ensureLogin()
    try {
      return await this.request('/download',
        () => ({ method: 'POST', headers: this.headers(true), body: JSON.stringify({ file_id: fileId }) }),
        OsDownloadResponseSchema, { file_id: fileId })
    } catch (e) {
      if (e instanceof OsHttpError) {
        const quota = quotaInfoFromErrorBody(e.body)
        if (quota) throw new OsQuotaExhaustedError(quota.resetAt, quota.remaining)
      }
      throw e
    }
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
