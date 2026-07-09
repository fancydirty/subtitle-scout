import { z } from 'zod'
import { formatEpisodeCode, type SeasonEpisode } from '../../core/episode.js'
import { needsChineseSubtitle } from '../../daemon/triggers.js'
import type { PlayerServer } from './types.js'

// 实录 ground truth：fixtures/jellyfin/。字段形状与录制冲突时以录制为准。
export const JellyfinMediaStreamSchema = z.object({
  Type: z.string(),
  Language: z.string().nullish(),
  Codec: z.string().nullish(),
  IsExternal: z.boolean().nullish(),
  DisplayTitle: z.string().nullish(),
  Index: z.number().nullish(),
}).passthrough()
export type JellyfinMediaStream = z.infer<typeof JellyfinMediaStreamSchema>

export const JellyfinItemSchema = z.object({
  Id: z.string(),
  Name: z.string(),
  OriginalTitle: z.string().nullish(),
  Type: z.string(),
  Path: z.string().nullish(),
  ProductionYear: z.number().nullish(),
  RunTimeTicks: z.number().nullish(),
  ProviderIds: z.record(z.string(), z.string()).nullish(),
  SeriesName: z.string().nullish(),
  SeriesId: z.string().nullish(),
  ParentIndexNumber: z.number().nullish(),
  IndexNumber: z.number().nullish(),
  MediaStreams: z.array(JellyfinMediaStreamSchema).nullish(),
  ProductionLocations: z.array(z.string()).nullish(),
  DateCreated: z.string().nullish(),
  Overview: z.string().nullish(),
}).passthrough()
export type JellyfinItem = z.infer<typeof JellyfinItemSchema>

export const JellyfinSessionSchema = z.object({
  Id: z.string(),
  UserName: z.string().nullish(),
  NowPlayingItem: JellyfinItemSchema.nullish(),
  PlayState: z.object({ IsPaused: z.boolean().nullish() }).passthrough().nullish(),
}).passthrough()
export const JellyfinSessionsSchema = z.array(JellyfinSessionSchema)
export type JellyfinSession = z.infer<typeof JellyfinSessionSchema>

export const JellyfinItemsResponseSchema = z.object({
  Items: z.array(JellyfinItemSchema).default([]),
  TotalRecordCount: z.number().nullish(),
}).passthrough()

export const JellyfinRemoteSearchResultSchema = z.object({
  Name: z.string().nullish(),
  ProductionYear: z.number().nullish(),
}).passthrough()
export const JellyfinRemoteSearchSchema = z.array(JellyfinRemoteSearchResultSchema)

export interface JellyfinClientOpts {
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
  onApiCall?: (r: { endpoint: string; params: Record<string, unknown>; status: number | null; durationMs: number; error?: string }) => void
}

const ITEM_FIELDS = 'Path,ProviderIds,MediaStreams,OriginalTitle,ProductionLocations,Overview,SeriesId'
export const JELLYFIN_TIMEOUT_MS = 30_000

export class JellyfinClient implements PlayerServer {
  private fetchImpl: typeof fetch
  constructor(private opts: JellyfinClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const t0 = Date.now()
    const url = `${this.opts.baseUrl}${path}`
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'X-Emby-Token': this.opts.apiKey,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(JELLYFIN_TIMEOUT_MS),
      })
      const durationMs = Date.now() - t0
      this.opts.onApiCall?.({ endpoint: path, params: {}, status: res.status, durationMs })
      if (!res.ok) throw new Error(`jellyfin ${method} ${path}: HTTP ${res.status}`)
      const text = await res.text()
      return text ? JSON.parse(text) : null
    } catch (e) {
      // onApiCall 已在 res 到达后记录；纯网络错误在此记录
      if (!(e instanceof Error && e.message.startsWith('jellyfin '))) {
        this.opts.onApiCall?.({ endpoint: path, params: {}, status: null, durationMs: Date.now() - t0, error: String(e) })
      }
      throw e
    }
  }

  async getSessions(): Promise<JellyfinSession[]> {
    return JellyfinSessionsSchema.parse(await this.call('GET', '/Sessions'))
  }

  async getItem(itemId: string): Promise<JellyfinItem> {
    const raw = await this.call('GET', `/Items?ids=${encodeURIComponent(itemId)}&fields=${ITEM_FIELDS}`)
    const r = JellyfinItemsResponseSchema.parse(raw)
    const item = r.Items[0]
    if (!item) throw new Error(`jellyfin item not found: ${itemId}`)
    return item
  }

  /** 必须 FullRefresh：裸 refresh 不重扫外部字幕文件（2026-07-06 实测） */
  async refreshItem(itemId: string): Promise<void> {
    await this.call('POST', `/Items/${encodeURIComponent(itemId)}/Refresh?metadataRefreshMode=FullRefresh&replaceAllMetadata=false`)
  }

  async getRecentItems(limit: number): Promise<JellyfinItem[]> {
    const raw = await this.call('GET',
      `/Items?recursive=true&includeItemTypes=Movie,Episode&sortBy=DateCreated&sortOrder=Descending&limit=${limit}&fields=${ITEM_FIELDS},DateCreated`)
    return JellyfinItemsResponseSchema.parse(raw).Items
  }

  async getItemsPage(startIndex: number, limit: number): Promise<JellyfinItem[]> {
    const raw = await this.call('GET',
      `/Items?recursive=true&includeItemTypes=Movie,Episode&sortBy=DateCreated&sortOrder=Ascending&startIndex=${startIndex}&limit=${limit}&fields=${ITEM_FIELDS},DateCreated`)
    return JellyfinItemsResponseSchema.parse(raw).Items
  }

  /**
   * 用 Jellyfin RemoteSearch 取中文译名，语言阶梯 zh-CN → zh-TW：TMDB 的 zh-CN 翻译记录
   * 逐片可能缺名（实案：Love, Death & Robots 的 zh-CN 返回英文名而 zh-TW 有繁体名——
   * 生产语言矩阵实验证明参数端到端有效，坑在 TMDB 数据洞）。返回值必须含 CJK 字符，
   * 英文结果视同没有。失败/无 provider id/非 Movie|Series 一律静默返回 null，绝不阻塞主流程。
   */
  async getChineseTitle(item: JellyfinItem): Promise<string | null> {
    // 剧集没有自己的 RemoteSearch 端点——解析到所属系列再查（系列名才是搜字幕的主键）
    if (item.Type === 'Episode' && item.SeriesId) {
      try {
        const series = await this.getItem(item.SeriesId)
        if (series.Type !== 'Episode') {
          return await this.getChineseTitle(series)
        }
        return null
      } catch {
        return null
      }
    }
    const endpoint = item.Type === 'Movie' ? 'Movie' : item.Type === 'Series' ? 'Series' : null
    if (!endpoint) return null
    const providerIds = item.ProviderIds ?? {}
    if (Object.keys(providerIds).length === 0) return null
    const hasCjk = (s: string) => /[一-鿿]/.test(s)
    for (const lang of ['zh-CN', 'zh-TW']) {
      try {
        const body = {
          SearchInfo: {
            Name: item.Name,
            Year: item.ProductionYear ?? undefined,
            ProviderIds: providerIds,
            MetadataLanguage: lang,
          },
          ItemId: item.Id,
        }
        const raw = await this.call('POST', `/Items/RemoteSearch/${endpoint}`, body)
        const results = JellyfinRemoteSearchSchema.parse(raw)
        const name = results[0]?.Name?.trim()
        if (name && hasCjk(name)) return name
      } catch (e) {
        this.opts.onApiCall?.({ endpoint: `/Items/RemoteSearch/${endpoint}`, params: {}, status: null, durationMs: 0, error: String(e) })
        return null
      }
    }
    return null
  }

  /**
   * 枚举该剧该季全部集（含每集 SxxExx 与是否缺中字）。无 SeriesId / 无季号 / 失败 → 静默返回 []。
   * 返回 Jellyfin 侧原始路径，调用方负责 MEDIA_PATH_MAPPINGS 映射为本地路径。
   */
  async getSeasonEpisodes(item: JellyfinItem): Promise<SeasonEpisode[]> {
    const seriesId = item.SeriesId
    const season = item.ParentIndexNumber
    if (!seriesId || season == null) return []
    try {
      const raw = await this.call('GET',
        `/Shows/${encodeURIComponent(seriesId)}/Episodes?season=${season}&fields=Path,MediaStreams`)
      const r = JellyfinItemsResponseSchema.parse(raw)
      const out: SeasonEpisode[] = []
      for (const ep of r.Items) {
        if (ep.Type !== 'Episode' || ep.IndexNumber == null || ep.ParentIndexNumber == null || !ep.Path) continue
        out.push({
          itemId: ep.Id,
          seasonNumber: ep.ParentIndexNumber,
          episodeNumber: ep.IndexNumber,
          episodeCode: formatEpisodeCode(ep.ParentIndexNumber, ep.IndexNumber),
          videoPath: ep.Path,
          videoFilename: ep.Path.split('/').pop() ?? ep.Path,
          needsChinese: needsChineseSubtitle(ep, true),
        })
      }
      return out
    } catch {
      return []
    }
  }
}
