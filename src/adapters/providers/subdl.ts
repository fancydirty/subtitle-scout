/** SubDL 站点客户端——subscene 关站（2024-05）后的接班站，subscene 全库镜像 + 免费公开 API
 *  （Bazarr 在用）。标准 REST：GET 搜索 JSON + GET 下载 zip（单跳，走常规 resolve→downloadDirect）。
 *  API 契约见 spec §2（2026-08-29 从 subdl.com/api-doc 实勘）。凭据走 DB secret（SUBDL_API_KEY）。 */

const SEARCH_BASE = 'https://api.subdl.com/api/v1/subtitles'
const DL_BASE = 'https://dl.subdl.com'
const CLIENT_ID = 'subtitle-scout'   // client 参数：标识集成方（DX 礼貌，文档列举值含 bazarr/stremio/…）

/** 一条 SubDL 字幕结果（宽松取用到的字段；其余字段忽略）。 */
export interface SubdlSubtitle {
  release_name: string
  name?: string
  lang?: string          // 全称，如 'chinese_simplified'
  language?: string      // 短码，如 'ZH'
  url: string            // 形如 '/subtitle/3197651-3213944.zip'，拼 DL_BASE 即下载地址
  season?: number | null
  episode?: number | null
  hi?: boolean
}

export interface SubdlSearchArgs {
  filmName?: string
  imdbId?: string
  tmdbId?: number
  type: 'movie' | 'tv'
  languages: string[]
  season?: number
  episode?: number
}

export interface SubdlClientOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string }) => void
}

/** 下载地址：把 subtitles[].url 拼到 dl.subdl.com 前缀。 */
export function subdlDownloadUrl(url: string): string {
  return `${DL_BASE}${url}`
}

export class SubdlClient {
  private apiKey: string
  private fetchImpl: typeof fetch
  private onApiCall?: SubdlClientOptions['onApiCall']

  constructor(opts: SubdlClientOptions) {
    this.apiKey = opts.apiKey
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.onApiCall = opts.onApiCall
  }

  async search(args: SubdlSearchArgs): Promise<SubdlSubtitle[]> {
    const params = new URLSearchParams()
    params.set('api_key', this.apiKey)
    // imdb_id 优先于 film_name（IMDb 精准匹配，避免同名误召回）。
    if (args.imdbId) params.set('imdb_id', args.imdbId)
    else if (args.tmdbId != null) params.set('tmdb_id', String(args.tmdbId))
    else if (args.filmName) params.set('film_name', args.filmName)
    params.set('type', args.type)
    if (args.languages.length) params.set('languages', args.languages.map((l) => l.toUpperCase()).join(','))
    if (args.season != null) params.set('season_number', String(args.season))
    if (args.episode != null) params.set('episode_number', String(args.episode))
    params.set('subs_per_page', '30')
    params.set('client', CLIENT_ID)

    const url = `${SEARCH_BASE}?${params.toString()}`
    const started = Date.now()
    let res: Response
    try {
      res = await this.fetchImpl(url, { headers: { 'User-Agent': `${CLIENT_ID}/0.2` } })
    } catch (e) {
      this.onApiCall?.({ endpoint: SEARCH_BASE, status: null, durationMs: Date.now() - started, error: String(e) })
      throw e
    }
    this.onApiCall?.({ endpoint: SEARCH_BASE, status: res.status, durationMs: Date.now() - started })

    const data = (await res.json()) as { status?: boolean; error?: string; subtitles?: SubdlSubtitle[] }
    if (data.status === false) {
      throw new Error(`subdl 搜索失败：${data.error ?? '未知错误'}`)
    }
    return Array.isArray(data.subtitles) ? data.subtitles : []
  }
}
