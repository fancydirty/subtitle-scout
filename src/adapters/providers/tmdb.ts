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
 * 从 Jellyfin item 解析 TMDB 引用。Movie→movie；Series→tv（用自身 Tmdb id）；
 * Episode→解析所属 series 的 Tmdb id（集级 ProviderIds 不含剧的 Tmdb，要回查 series）。
 * 拿不到 id / 类型不匹配 / 回查失败一律静默返回 null。
 */
export async function resolveTmdbRef(
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
    try {
      const series = await getItem(item.SeriesId)
      const id = tmdbOf(series)
      return id ? { mediaType: 'tv', tmdbId: id } : null
    } catch {
      return null
    }
  }
  return null
}

export class TmdbClient {
  private fetchImpl: typeof fetch
  constructor(private opts: TmdbClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  // 任何失败（网络拒绝、超时、非 2xx、非 JSON）静默返回 null——TMDB 是增益路径，绝不阻塞主流程。
  private async getJson(path: string): Promise<Record<string, unknown> | null> {
    const v4 = isV4Token(this.opts.apiKey)
    const url = v4
      ? `${BASE}${path}`
      : `${BASE}${path}?api_key=${encodeURIComponent(this.opts.apiKey)}`
    const headers = v4 ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined
    try {
      const res = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
      })
      if (!res.ok) return null
      return await res.json() as Record<string, unknown>
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

  /** TMDB detail 端点的 original_language（movie/tv 通用，小写化）。失败静默返回 null（增益路径）。 */
  async getOriginLanguage(mediaType: 'tv' | 'movie', tmdbId: string): Promise<string | null> {
    const d = await this.getJson(`/${mediaType}/${tmdbId}`)
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
