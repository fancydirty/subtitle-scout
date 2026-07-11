import { JellyfinItemNotFoundError } from '../players/jellyfin.js'

export const TMDB_TIMEOUT_MS = 15_000
const BASE = 'https://api.themoviedb.org/3'

export interface TmdbClientOpts {
  apiKey: string
  fetchImpl?: typeof fetch
}

// v4 Read Access Token 是 JWT，以 eyJ 开头 → Authorization: Bearer 头；
// 否则视为 v3 key（32 位 hex）→ api_key query 参数。
function isV4Token(apiKey: string): boolean {
  return apiKey.startsWith('eyJ')
}

const CJK = /[一-鿿]/

interface TmdbTranslation {
  iso_639_1?: string
  iso_3166_1?: string
  data?: { name?: string; title?: string }
}
interface TmdbAltTitle {
  iso_3166_1?: string
  title?: string
}

export interface TmdbRef { mediaType: 'tv' | 'movie'; tmdbId: string }

interface ItemLike {
  Type?: string | null
  SeriesId?: string | null
  ProviderIds?: Record<string, string> | null
}

/**
 * 严格版：从 Jellyfin item 解析 TMDB 引用。Movie→movie；Series→tv（用自身 Tmdb id）；
 * Episode→解析所属 series 的 Tmdb id（集级 ProviderIds 不含剧的 Tmdb，要回查 series）。
 *
 * Episode 分支 getItem(seriesId) 失败时两种结果严格区分（生产 originFor 接线依赖这条契约，
 * 见 cli/index.ts）：
 * - JellyfinItemNotFoundError（Jellyfin 明确答复查无此系列 id——脏/过期 SeriesId 是永久态）
 *   → 归入 no-data，返回 null，安全负缓存；
 * - 其余任何抛出（网络拒绝、超时、非 2xx——Jellyfin 请求瞬时失败）→ 原样向上抛出，调用方必须
 *   按"可重试"处理，绝不能当 no-data 缓存（否则一次 Jellyfin 抖动会把故障窗口内扫过的
 *   全部条目永久打成 unknown，权威 origin gate 从此失效）。
 * 需要静默吞错语义（TMDB 标题增益路径）的调用方走 resolveTmdbRef。
 */
export async function resolveTmdbRefStrict(
  item: ItemLike,
  getItem: (id: string) => Promise<ItemLike>,
): Promise<TmdbRef | null> {
  const tmdbOf = (it: ItemLike) => it.ProviderIds?.Tmdb ?? null
  if (item.Type === 'Movie') {
    const id = tmdbOf(item)
    return id ? { mediaType: 'movie', tmdbId: id } : null
  }
  if (item.Type === 'Series') {
    const id = tmdbOf(item)
    return id ? { mediaType: 'tv', tmdbId: id } : null
  }
  if (item.Type === 'Episode' && item.SeriesId) {
    let series: ItemLike
    try {
      series = await getItem(item.SeriesId)
    } catch (e) {
      if (e instanceof JellyfinItemNotFoundError) return null
      throw e
    }
    const id = tmdbOf(series)
    return id ? { mediaType: 'tv', tmdbId: id } : null
  }
  return null
}

/**
 * 拿全部中文标题变体（tmdbTitles）这类增益路径用的宽松版：任何失败（含 Episode 回查系列时
 * Jellyfin 请求瞬时失败）一律静默折叠成 null——这里没有"下轮重试权威数据"的下游语义，
 * 折叠成 null 只是让 tmdbTitles 照常返回 undefined，不阻塞主流程。
 * 需要区分"瞬时失败"与"查无数据"的调用方（如 scanner 的 origin_lang 解析）走 resolveTmdbRefStrict。
 */
export async function resolveTmdbRef(
  item: ItemLike,
  getItem: (id: string) => Promise<ItemLike>,
): Promise<TmdbRef | null> {
  try {
    return await resolveTmdbRefStrict(item, getItem)
  } catch {
    return null
  }
}

/**
 * TMDB 请求本身失败（网络拒绝、超时、非 2xx、非 JSON）——瞬时故障，调用方据此
 * 决定"下次重试"而非"缓存无数据"。风格对齐 llm.ts 的 ToolChoiceRejectionError。
 */
export class TmdbRequestFailedError extends Error {
  constructor(cause: unknown) {
    super(`TMDB request failed: ${String(cause)}`)
  }
}

export class TmdbClient {
  private fetchImpl: typeof fetch
  constructor(private opts: TmdbClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * 严格版请求：区分"请求失败"和"查无此资源"。
   * - 网络拒绝 / 超时 / 非 2xx（404 除外）/ 非 JSON → 抛 TmdbRequestFailedError（瞬时，可重试）；
   * - 404 → 返回 null（TMDB 明确答复查无此 id——脏/过期 provider id 是永久态，属 no-data）。
   * 需要静默吞错语义的调用方走 getJson。
   */
  private async getJsonStrict(path: string): Promise<Record<string, unknown> | null> {
    const v4 = isV4Token(this.opts.apiKey)
    const url = v4
      ? `${BASE}${path}`
      : `${BASE}${path}?api_key=${encodeURIComponent(this.opts.apiKey)}`
    const headers = v4 ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
      })
    } catch (e) {
      throw new TmdbRequestFailedError(e)
    }
    if (res.status === 404) return null
    if (!res.ok) throw new TmdbRequestFailedError(`HTTP ${res.status}`)
    try {
      return await res.json() as Record<string, unknown>
    } catch (e) {
      throw new TmdbRequestFailedError(e)
    }
  }

  // 任何失败（网络拒绝、超时、非 2xx、非 JSON）静默返回 null——TMDB 是增益路径，绝不阻塞主流程。
  private async getJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.getJsonStrict(path)
    } catch {
      return null
    }
  }

  /** 拿全部中文标题变体，官方译名优先。任何失败静默返回 []（增益路径）。 */
  async getChineseTitles(mediaType: 'tv' | 'movie', tmdbId: string): Promise<string[]> {
    // 两端点并发；Promise.allSettled，一端失败不连坐；全失败返回 []。
    const [translations, altTitles] = await Promise.allSettled([
      this.getJson(`/${mediaType}/${tmdbId}/translations`),
      this.getJson(`/${mediaType}/${tmdbId}/alternative_titles`),
    ])

    const out: string[] = []
    const push = (s?: string) => {
      const t = s?.trim()
      if (t && CJK.test(t) && !out.includes(t)) out.push(t)
    }

    // ① translations：iso_639_1==='zh' 的官方译名，按 CN→TW→HK→SG 顺序（空串跳过）。
    if (translations.status === 'fulfilled' && translations.value) {
      const list = (translations.value.translations as TmdbTranslation[] | undefined) ?? []
      const rank: Record<string, number> = { CN: 0, TW: 1, HK: 2, SG: 3 }
      const zh = list
        .filter(t => t.iso_639_1 === 'zh')
        .sort((a, b) => (rank[a.iso_3166_1 ?? ''] ?? 9) - (rank[b.iso_3166_1 ?? ''] ?? 9))
      for (const t of zh) push(mediaType === 'tv' ? t.data?.name : t.data?.title)
    }

    // ② alternative_titles：iso_3166_1 ∈ {CN,TW,HK} 的 title（tv 响应字段 results，movie 是 titles）。
    if (altTitles.status === 'fulfilled' && altTitles.value) {
      const d = altTitles.value
      const list = ((d.results ?? d.titles) as TmdbAltTitle[] | undefined) ?? []
      for (const t of list) {
        if (['CN', 'TW', 'HK'].includes(t.iso_3166_1 ?? '')) push(t.title)
      }
    }

    return out
  }

  /**
   * TMDB detail 端点的 original_language（movie/tv 通用，小写化）。
   * 两类结果语义严格区分（scanner 的负缓存哨兵依赖这条契约）：
   * - null = TMDB 明确答复但无可用 original_language（含 404 查无此 id）——真·no-data，可安全负缓存；
   * - 抛 TmdbRequestFailedError = 请求本身失败（网络/超时/非 2xx/非 JSON）——瞬时故障，
   *   调用方必须按"可重试"处理，绝不能当 no-data 缓存（否则一次 TMDB 故障会把故障窗口内
   *   扫过的所有条目永久打成 unknown，权威 origin gate 从此失效）。
   */
  async getOriginLanguage(mediaType: 'tv' | 'movie', tmdbId: string): Promise<string | null> {
    const d = await this.getJsonStrict(`/${mediaType}/${tmdbId}`)
    const lang = d?.original_language
    return typeof lang === 'string' && lang ? lang.toLowerCase() : null
  }
}

/**
 * 便捷接线：解析 item 的 TMDB 引用并取全部中文标题变体。
 * 无引用 / 无结果一律返回 undefined（保持 buildMediaContext 的 enrichment 语义不变）。
 * getChineseTitles 内部已静默吞错，此处不会抛。
 */
export async function tmdbTitles(
  client: TmdbClient,
  item: ItemLike,
  getItem: (id: string) => Promise<ItemLike>,
): Promise<string[] | undefined> {
  const ref = await resolveTmdbRef(item, getItem)
  if (!ref) return undefined
  const titles = await client.getChineseTitles(ref.mediaType, ref.tmdbId)
  return titles.length ? titles : undefined
}
