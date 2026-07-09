import type { SeasonEpisode } from '../../core/episode.js'
import type { JellyfinItem, JellyfinSession } from './jellyfin.js'

/** 媒体条目/会话的线格式与 Jellyfin API 同形（Emby 天然兼容；其他服务器的适配器负责映射成此形状）。 */
export type MediaItem = JellyfinItem
export type PlaybackSession = JellyfinSession

/**
 * 媒体服务器端口。实现一个新适配器 = 实现这六个方法（语义契约见 docs/adapting.md）。
 * 失败约定：getChineseTitle / getSeasonEpisodes 静默降级（null / []），其余方法抛错。
 */
export interface PlayerServer {
  getSessions(): Promise<PlaybackSession[]>
  getItem(itemId: string): Promise<MediaItem>
  refreshItem(itemId: string): Promise<void>
  getRecentItems(limit: number): Promise<MediaItem[]>
  getChineseTitle(item: MediaItem): Promise<string | null>
  getSeasonEpisodes(item: MediaItem): Promise<SeasonEpisode[]>
}
