export const TMDB_TIMEOUT_MS = 15_000
const BASE = 'https://api.themoviedb.org/3'

export interface TmdbClientOpts {
  apiKey: string
  fetchImpl?: typeof fetch
  /** 债务 D4：镜像域配置口（CN 直连超时解药）。缺省=官方 https://api.themoviedb.org/3。
   *  末尾斜杠会被剥掉，路径拼接口径与 BASE 一致。 */
  baseUrl?: string
  /** 债务 D4：HTTP 代理。有值时动态 import('undici') 挂 ProxyAgent dispatcher；import 失败
   *  （理论上不该发生，undici 是 Node 内置 fetch 的实现库）打一行告警后继续直连——代理是增益，
   *  绝不许把无代理也能通的请求搞挂。 */
  proxyUrl?: string
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

export interface SeasonTableEntry { seasonNumber: number; episodeCount: number; airDate: string | null }

/** Normalized `/search/{tv,movie}` hit — id/title/year regardless of which endpoint answered
 *  (tv: name/first_air_date; movie: title/release_date — TMDB's own field-naming split).
 *  originalTitle = tv original_name / movie original_title (the title in the work's own language,
 *  e.g. a CJK name) — C3's clean-title tiebreak matches queries against it too, so a CJK query
 *  can hit a work whose display title is localized. Missing/blank → null.
 *  posterPath = TMDB image path (e.g. '/dqZEN...jpg', web 端自拼 CDN URL 前缀) — 去 Jellyfin 化
 *  P3（design: docs/design/2026-07-16-de-jellyfin-design.md §P3）新增字段，供 ingest 层落
 *  series/movies.poster_path。Missing/blank → null，同其余字段口径。 */
export interface TmdbSearchHit {
  id: number
  title: string
  originalTitle: string | null
  year: number | null
  posterPath: string | null
}

/** `/tv/{id}` `/movie/{id}` 详情端点归一化——去 Jellyfin 化 P3 新增，供 ingest 层一次性补全
 *  series/movies 行的展示元数据（目前只有 posterPath/year 落库；overview/runtimeMinutes/
 *  originalTitle 是通用详情面，供未来消费方使用，T3 本身不落这两列——schema v9 没有对应列）。
 *  tv: episode_run_time?.[0]/first_air_date 年份/original_name；movie: runtime/release_date
 *  年份/original_title——TMDB 两端点自己的字段名分裂，不是本类型的选择。 */
export interface TmdbDetails {
  overview: string | null
  runtimeMinutes: number | null
  posterPath: string | null
  originalTitle: string | null
  year: number | null
  /** 验收修复轮一 Task V1（design: 2026-07-17-acceptance-round-1-design.md §A，用户裁决）：
   *  `genres[].id` 原样保留（如 [16,35]，16=Animation）——dashboard sectionOf 用它判"动漫 vs
   *  剧集"。genres 缺失/非数组/元素 id 非 number → 过滤兜底为 `[]`，恒是数组，从不是 null——
   *  "该剧是否已富化"这件事体现在 series.genres 落库列是否为 SQL NULL，不是这个字段本身
   *  （getDetails 整体 404/失败时 TmdbDetails 本身为 null/抛错，调用方据此区分，见下方实现）。 */
  genreIds: number[]
}

/**
 * TMDB 请求本身失败（网络拒绝、超时、非 2xx、非 JSON）——瞬时故障，调用方据此
 * 决定"下次重试"而非"缓存无数据"。风格对齐 llm.ts 的 ToolChoiceRejectionError。
 * cause 链回原始错误（而非 String() 拍扁）以保留原始 stack，便于诊断真正的网络/HTTP 故障点。
 */
export class TmdbRequestFailedError extends Error {
  constructor(cause: unknown) {
    super(`TMDB request failed: ${String(cause)}`, { cause })
    this.name = 'TmdbRequestFailedError'
  }
}

export class TmdbClient {
  private fetchImpl: typeof fetch
  private base: string
  private dispatcherP: Promise<unknown>
  constructor(private opts: TmdbClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.base = (opts.baseUrl ?? BASE).replace(/\/+$/, '')
    this.dispatcherP = opts.proxyUrl
      ? import('undici').then(
          (u) => new u.ProxyAgent(opts.proxyUrl!),
          (e) => { console.error(`TMDB_PROXY_URL 设置了但 undici 不可用，继续直连: ${String(e)}`); return undefined },
        )
      : Promise.resolve(undefined)
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
      ? `${this.base}${path}`
      : `${this.base}${path}?api_key=${encodeURIComponent(this.opts.apiKey)}`
    const headers = v4 ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined
    const dispatcher = await this.dispatcherP
    let res: Response
    try {
      const init: RequestInit = { headers, signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
      // dispatcher 是 undici 扩展字段，TS 的 RequestInit 类型不认识，cast 记录型绕过。
      if (dispatcher) (init as Record<string, unknown>).dispatcher = dispatcher
      res = await this.fetchImpl(url, init)
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

  /**
   * 季表：season_number/episode_count/air_date，供绝对集号累计偏移映射用。
   * 过滤 season_number<=0（TMDB 用 0 表示特别篇，不参与正片累计编号）。
   * 语义同 getOriginLanguage：null=真·无数据（含404），抛 TmdbRequestFailedError=瞬时故障可重试。
   * 权威数据形状异常一律按"可重试的请求失败"处理，绝不静默降级：
   * - seasons 非数组（含缺字段）→ throw（否则裸 .filter 会抛 TypeError）；
   * - 正片季缺 episode_count → throw（绝不 ??0，那会算出错误的累计表并静默错误改名）。
   */
  async getSeasonTable(tvId: string): Promise<SeasonTableEntry[] | null> {
    const d = await this.getJsonStrict(`/tv/${tvId}`)
    if (!d) return null
    const seasons = d.seasons
    if (!Array.isArray(seasons)) {
      throw new TmdbRequestFailedError(`TMDB /tv/${tvId} 响应缺少 seasons 数组`)
    }
    const rows = seasons as Array<{ season_number?: number; episode_count?: number; air_date?: string | null }>
    return rows
      .filter((s): s is { season_number: number; episode_count?: number; air_date?: string | null } =>
        typeof s.season_number === 'number' && s.season_number > 0)
      .map(s => {
        if (typeof s.episode_count !== 'number') {
          throw new TmdbRequestFailedError(`TMDB /tv/${tvId} 第 ${s.season_number} 季缺少 episode_count`)
        }
        return { seasonNumber: s.season_number, episodeCount: s.episode_count, airDate: s.air_date ?? null }
      })
      .sort((a, b) => a.seasonNumber - b.seasonNumber)
  }

  /** 官方 TMDB 绝对编号 episode group，展平为 (season, episode) 序列；剧无 Absolute 型分组则返回
   *  null。绝对编号分组的 type === 2。用 getJson（吞错）——分组缺失是正常情形而非故障。 */
  async getAbsoluteOrder(tvId: string): Promise<{ season: number; episode: number }[] | null> {
    const list = await this.getJson(`/tv/${tvId}/episode_groups`)
    const results = Array.isArray(list?.results) ? (list!.results as Array<{ id?: string; type?: number }>) : []
    const abs = results.find(g => g.type === 2 && typeof g.id === 'string')
    if (!abs?.id) return null
    const detail = await this.getJson(`/tv/episode_group/${abs.id}`)
    const groups = Array.isArray(detail?.groups) ? (detail!.groups as Array<{ order?: number; episodes?: unknown[] }>) : []
    const ordered: { season: number; episode: number }[] = []
    for (const g of [...groups].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      const eps = Array.isArray(g.episodes) ? (g.episodes as Array<{ season_number?: number; episode_number?: number; order?: number }>) : []
      for (const e of [...eps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
        if (typeof e.season_number === 'number' && typeof e.episode_number === 'number') {
          ordered.push({ season: e.season_number, episode: e.episode_number })
        }
      }
    }
    return ordered.length > 0 ? ordered : null
  }

  /**
   * 与 getJsonStrict 同构的严格请求,但支持查询参数——search 端点必须带 query= 等参数,
   * 与 getJsonStrict"path 不含问号"的既有假设冲突(它固定在 path 后拼 `?api_key=`),
   * 故不复用/不改动它,独立实现,保证 getJsonStrict 及其现有调用方零变化。
   * 失败语义同 getJsonStrict:404→null(真·无数据),其余失败→TmdbRequestFailedError(瞬时,可重试)。
   */
  private async getJsonStrictQuery(
    path: string,
    params: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const v4 = isV4Token(this.opts.apiKey)
    const qs = new URLSearchParams(params)
    if (!v4) qs.set('api_key', this.opts.apiKey)
    const url = `${this.base}${path}?${qs.toString()}`
    const headers = v4 ? { Authorization: `Bearer ${this.opts.apiKey}` } : undefined
    const dispatcher = await this.dispatcherP
    let res: Response
    try {
      const init: RequestInit = { headers, signal: AbortSignal.timeout(TMDB_TIMEOUT_MS) }
      // dispatcher 是 undici 扩展字段，TS 的 RequestInit 类型不认识，cast 记录型绕过。
      if (dispatcher) (init as Record<string, unknown>).dispatcher = dispatcher
      res = await this.fetchImpl(url, init)
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

  /**
   * 标题搜索——C3(resolveToTmdb)消歧的唯一数据源。tv→/search/tv(取 name/first_air_date),
   * movie→/search/movie(取 title/release_date;year 查询参数名两端点不同——tv 是
   * first_air_date_year,movie 是 year,这是 TMDB 自己的 API 形状,不是本函数的选择)。
   * 404 与"查无结果"同等对待,按空数组处理(TMDB search 端点正常不会 404,但形状收敛到
   * 与 getJsonStrict 一致的"404=no-data"哲学,调用方不必分情况处理)。
   */
  async search(mediaType: 'tv' | 'movie', query: string, year?: number): Promise<TmdbSearchHit[]> {
    const path = mediaType === 'tv' ? '/search/tv' : '/search/movie'
    const params: Record<string, string> = { query }
    if (year !== undefined) {
      params[mediaType === 'tv' ? 'first_air_date_year' : 'year'] = String(year)
    }
    const d = await this.getJsonStrictQuery(path, params)
    const results = Array.isArray(d?.results) ? (d!.results as Array<Record<string, unknown>>) : []
    return results
      .map((r): TmdbSearchHit | null => {
        const id = r.id
        if (typeof id !== 'number') return null
        const title = mediaType === 'tv'
          ? (typeof r.name === 'string' ? r.name : '')
          : (typeof r.title === 'string' ? r.title : '')
        const rawOriginal = mediaType === 'tv' ? r.original_name : r.original_title
        const originalTitle = typeof rawOriginal === 'string' && rawOriginal ? rawOriginal : null
        const dateStr = mediaType === 'tv' ? r.first_air_date : r.release_date
        const year = typeof dateStr === 'string' && dateStr.length >= 4 ? Number(dateStr.slice(0, 4)) : null
        const rawPoster = r.poster_path
        const posterPath = typeof rawPoster === 'string' && rawPoster ? rawPoster : null
        return { id, title, originalTitle, year: Number.isFinite(year) ? year : null, posterPath }
      })
      .filter((h): h is TmdbSearchHit => h !== null)
  }

  /**
   * 详情端点(`/tv/{id}` `/movie/{id}`)——去 Jellyfin 化 P3：识别命中后顺手拉 overview/runtime/
   * poster/originalTitle/year 一次性补全展示元数据。语义同 getSeasonTable/getOriginLanguage：
   * 404→null(真·无数据，脏/过期 TMDB id 是永久态)；其余失败(网络/超时/非 2xx/非 JSON)→
   * 抛 TmdbRequestFailedError(瞬时，可重试，调用方绝不能当无数据静默降级/负缓存)。
   */
  async getDetails(mediaType: 'tv' | 'movie', tmdbId: string): Promise<TmdbDetails | null> {
    const d = await this.getJsonStrict(`/${mediaType}/${tmdbId}`)
    if (!d) return null

    const overview = typeof d.overview === 'string' && d.overview ? d.overview : null
    const rawPoster = d.poster_path
    const posterPath = typeof rawPoster === 'string' && rawPoster ? rawPoster : null
    const rawGenres = d.genres
    const genreIds = Array.isArray(rawGenres)
      ? (rawGenres as Array<{ id?: unknown }>)
          .map((g) => g?.id)
          .filter((id): id is number => typeof id === 'number')
      : []

    let runtimeMinutes: number | null = null
    let originalTitle: string | null = null
    let year: number | null = null
    if (mediaType === 'tv') {
      const ert = d.episode_run_time
      if (Array.isArray(ert) && typeof ert[0] === 'number') runtimeMinutes = ert[0]
      const rawOriginal = d.original_name
      originalTitle = typeof rawOriginal === 'string' && rawOriginal ? rawOriginal : null
      const dateStr = d.first_air_date
      year = typeof dateStr === 'string' && dateStr.length >= 4 ? Number(dateStr.slice(0, 4)) : null
    } else {
      runtimeMinutes = typeof d.runtime === 'number' ? d.runtime : null
      const rawOriginal = d.original_title
      originalTitle = typeof rawOriginal === 'string' && rawOriginal ? rawOriginal : null
      const dateStr = d.release_date
      year = typeof dateStr === 'string' && dateStr.length >= 4 ? Number(dateStr.slice(0, 4)) : null
    }

    return {
      overview, runtimeMinutes, posterPath, originalTitle,
      year: Number.isFinite(year) ? year : null, genreIds,
    }
  }

  /**
   * 外部 id 端点（`/tv/{id}/external_ids` `/movie/{id}/external_ids`）——验收修复轮一：摄取时采
   * 真 imdb id，堵住 LLM 把 tmdb id 幻觉成 "tt<tmdbId>" 的源头。语义同 getDetails：
   * 404→{imdbId:null}（真·无数据），其余失败→抛 TmdbRequestFailedError（瞬时，可重试）。
   * 空串/缺失/非字符串→统一返回 null。 */
  async getExternalIds(mediaType: 'tv' | 'movie', tmdbId: string): Promise<{ imdbId: string | null }> {
    const d = await this.getJsonStrict(`/${mediaType}/${tmdbId}/external_ids`)
    if (!d) return { imdbId: null }
    const imdbId = typeof d.imdb_id === 'string' && d.imdb_id ? d.imdb_id : null
    return { imdbId }
  }

  /**
   * 单季集清单（`/tv/{id}/season/{n}`）——dashboard G2 应有集缓存（tmdbCatalog.ts）用它逐季拉
   * episode_number/name 补全 getSeasonTable 只给到的季级 episode_count。语义同 getSeasonTable：
   * null=真·无数据（含 404，该季不存在），抛 TmdbRequestFailedError=瞬时故障可重试，调用方
   * （refreshSeriesCatalog）按 gain-path 降级处理，绝不当无数据清空旧缓存。
   * episodes 非数组按空集处理（不 throw）——不同于 getSeasonTable 对 seasons 数组的严格校验：
   * 季级 episode_count 已经是权威计数来源，这里拿不到集清单只是降级到"标题为 null"，不是
   * 数据完整性红线。
   */
  async getSeasonEpisodes(tvId: string, season: number): Promise<{ episode: number; title: string | null }[] | null> {
    const d = await this.getJsonStrict(`/tv/${tvId}/season/${season}`)
    if (!d) return null
    const episodes = d.episodes
    if (!Array.isArray(episodes)) return null
    return (episodes as Array<{ episode_number?: number; name?: string }>)
      .filter((e): e is { episode_number: number; name?: string } => typeof e.episode_number === 'number')
      .map(e => ({ episode: e.episode_number, title: typeof e.name === 'string' && e.name ? e.name : null }))
  }

  /**
   * 单季逐集实际时长（`/tv/{id}/season/{n}`，与 getSeasonEpisodes 同一端点）——喂给
   * find-subtitle worker 的"该集本尊时长"事实来源。根因：getDetails 的 `episode_run_time[0]`
   * 只是 TMDB 给的剧级"典型"单集时长（通常是首集/众数，不代表某一集），加长集/季终集会被
   * 错误对齐——真实事故（2026-07-18 从零 e2e）：True Detective S02E08 实际约 86 分钟的加长
   * 季终，被剧级典型约 58 分钟误喂给 agent，agent 诚实地把时长正确的候选字幕全部拒判判无
   * （agent 判断没错，喂的事实错了）。
   *
   * 返回 episode_number→runtime(分钟) 的 Map；runtime 缺失/null/非正数的集跳过（不进 Map，
   * 不是 0——"没有数据"和"时长为 0"不该混同）。
   *
   * 增益路径（同 getChineseTitles/getAbsoluteOrder，用 getJson 而非 getJsonStrict）：任何失败
   * （网络拒绝、超时、非 2xx、非 JSON、404）一律静默返回 null——这是喂给 agent 的补充事实，
   * 不是权威阻断信号,绝不能让一次 TMDB 抽风拖垮整批任务构造（调用方 findSubtitleWorkerTask.ts
   * 同样绝不因此失败，见该文件消费处的注释）。episodes 非数组同样按 null 处理，不 throw——
   * 季级 episode_count 已经是权威计数来源（getSeasonTable），这里拿不到集清单只是这批目标
   * 少一条辅助事实，不是数据完整性红线。
   */
  async getSeasonEpisodeRuntimes(tvId: string, season: number): Promise<Map<number, number> | null> {
    const d = await this.getJson(`/tv/${tvId}/season/${season}`)
    if (!d) return null
    const episodes = d.episodes
    if (!Array.isArray(episodes)) return null
    const out = new Map<number, number>()
    for (const e of episodes as Array<{ episode_number?: number; runtime?: number | null }>) {
      if (typeof e.episode_number === 'number' && typeof e.runtime === 'number' && e.runtime > 0) {
        out.set(e.episode_number, e.runtime)
      }
    }
    return out
  }
}
