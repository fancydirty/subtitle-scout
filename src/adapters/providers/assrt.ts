import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  AssrtSearchResponseSchema, AssrtDetailResponseSchema, AssrtQuotaResponseSchema,
  type AssrtSub, type SubtitleCandidate, type SubtitleFile,
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

/**
 * CRITICAL fix（adversarial review finding）：droppedEntries>0 且过滤后 sub.subs 一条不剩，
 * 不是"内容结论"（真的查无字幕/相似），是响应形状系统性坏了（provider schema drift 等）。
 * 之前这种情况被 fail-soft 悄悄吞成一个"成功但空"的结果——pipeline 把"零候选 + 零
 * providerErrors"当成诚实的"确实没有字幕"，写 1 天负缓存，把一次 provider 故障永久毒化成
 * 假结论；对 similar() 而言还额外废掉了残缺候选集守卫的唯一信号（providerErrors 为空）。
 * 混合页（kept>=1）不受影响，继续 fail-soft：只丢坏条目，好条目照常返回。
 */
export class AssrtAllEntriesDroppedError extends Error {
  constructor(public endpoint: string, public droppedCount: number) {
    super(`ASSRT ${endpoint}: all ${droppedCount} entries in sub.subs were malformed and dropped (provider schema drift?) — refusing to report this as an honest empty result`)
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
 *
 * MINOR-3 (envelope fragility, noted not fixed here)：上面这条"原样放行"分支依赖 dropped 计数
 * 才能被下面的 assertNotAllSubsDropped 拦到——但 AssrtSearchResponseSchema 对 sub/sub.subs 都设了
 * z.default()，所以 sub:null 或整个 sub 字段缺失这种"信封本身就坏了"的畸形响应，会被 schema 的
 * 默认值悄悄吸收成合法的空数组（dropped 永远是 0，走不到全丢弃守卫），而不是抛错。这个残余风险
 * 被本次 CRITICAL 修复（全丢弃必抛错）大幅缓解——真实生产事故形状（subs 数组内单条缺字段）已覆盖——
 * 但没有消除：只要 schema 未来新增必填根字段，这条分支仍可能悄悄退化成假空结果。
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

/**
 * CRITICAL fix 的守卫本体：dropped>0 且过滤后 sub.subs 一条不剩 → 抛 AssrtAllEntriesDroppedError。
 * 供 call() 在 fresh fetch 和 cache-hit 两条路径上统一调用（IMPORTANT fix：cache-hit 路径之前
 * 完全跳过了过滤/守卫，见 call() 里的用法）。dropped===0 时（包括根本没触发过滤的场景）直接放行。
 */
function assertNotAllSubsDropped(endpoint: string, payload: unknown, dropped: number): void {
  if (dropped === 0) return
  const subs = (payload as { sub?: { subs?: unknown[] } } | null)?.sub?.subs
  if (!subs || subs.length === 0) throw new AssrtAllEntriesDroppedError(endpoint, dropped)
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
    // search/similar/searchByFilename/detail 共用 AssrtSearchResponseSchema（这四个 endpoint 全部走
    // 这一份 sub.subs 解析逻辑）——只对这类响应做逐条 fail-soft 过滤；quota 等其它 schema 不含
    // subs，原样直通。算一次，fresh fetch 和 cache-hit 两条路径共用同一个判定。
    const isSubsSchema = (schema as unknown) === AssrtSearchResponseSchema
    if (cacheTtlMs !== false && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < cacheTtlMs) {
      // IMPORTANT fix：cache-hit 之前是裸 schema.parse，绕过了过滤/全丢弃守卫——一个在写入时就已经
      // 畸形的响应（或写入时 schema 还没这条防线）会在 TTL 内每次命中缓存都重新炸一次。现在 fresh
      // fetch 和 cache-hit 走同一套 filterMalformedSubs + assertNotAllSubsDropped，行为对齐。
      // 只在 status===0 时才会被写入缓存（见下方 fresh path），所以这里不需要再判 status。
      const cachedJson = JSON.parse(readFileSync(cacheFile, 'utf8'))
      const { data: payload, dropped } = isSubsSchema ? filterMalformedSubs(cachedJson) : { data: cachedJson, dropped: 0 }
      assertNotAllSubsDropped(endpoint, payload, dropped)
      return schema.parse(payload)
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
        const { data: payload, dropped } = status === 0 && isSubsSchema
          ? filterMalformedSubs(json)
          : { data: json as unknown, dropped: 0 }
        this.opts.onApiCall?.({ endpoint, params, status, durationMs: Date.now() - t0, ...(dropped > 0 ? { droppedEntries: dropped } : {}) })
        if (status !== 0) throw new AssrtApiError(status ?? -1, endpoint)
        // CRITICAL fix：全丢弃必须在写缓存之前抛错——既不把这次故障当成功返回给调用方，
        // 也不把一个"内容整体不可用"的响应写进磁盘缓存喂给下一次 cache-hit。
        assertNotAllSubsDropped(endpoint, payload, dropped)
        if (cacheTtlMs !== false) writeFileSync(cacheFile, JSON.stringify(payload))
        return schema.parse(payload)
      } catch (e) {
        // AssrtAllEntriesDroppedError 和 AssrtApiError 同等对待：语义上是"这次调用的结果确定性地
        // 不可用"，不是网络层瞬时故障——不重试（重试大概率拿到同一个 schema drift），直接冒泡，
        // 让调用方（gems 的 similar() catch、runSearch 的 per-adapter catch）转成 provider_error。
        if (e instanceof AssrtApiError || e instanceof AssrtAllEntriesDroppedError) throw e
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

/** 保险丝：fileList 的 index 字段必须与数组下标一一对应（详见 schemas.ts 上 SubtitleFileSchema 的
 *  invariant 注释）——下游全是纯位置寻址（fileList[fileIndex]），不会按 .index 字段反查（今天的
 *  下游是 cli/adapters/assrtAdapter.ts 的 resolve()、v3 find-subtitle worker 的 fileIndex 参数；
 *  这条不变式最初是为已删除的 gate.ts / pipeline.ts 写的，二者已随旧管线退役删除，但寻址方式
 *  本身原样传给了它们的替代者）。当前 map((f, i) => ({ index: i, ... })) 的写法本身就保证这条
 *  不变式恒成立；这个断言只是给未来的改动（比如中途插了一次 filter/sort）上一道保险丝，出问题
 *  当场炸，而不是留到线上装错文件才被发现。 */
function assertFileListIndexInvariant(fileList: SubtitleFile[]): void {
  fileList.forEach((f, i) => {
    if (f.index !== i) throw new Error(`assrt fileList index invariant violated: entry at array position ${i} has index=${f.index}`)
  })
}

export function toCandidate(sub: AssrtSub): SubtitleCandidate {
  const native = Array.isArray(sub.native_name) ? sub.native_name.join(' / ') : sub.native_name
  // 构造时点：index 就是 map 的数组下标 i，从源头保证 index === array position。
  const fileList = sub.filelist.map((f, i) => ({ index: i, name: f.f }))
  assertFileListIndexInvariant(fileList)
  return {
    provider: 'assrt',
    providerId: String(sub.id),
    videoName: sub.videoname ?? sub.filename ?? null,
    nativeName: native ?? null,
    language: sub.lang?.desc ?? null,
    subtype: sub.subtype ?? null,
    releaseSite: sub.release_site ?? null,
    uploadDate: null, // ASSRT 搜索响应不含上传日期
    fileList,
  }
}
