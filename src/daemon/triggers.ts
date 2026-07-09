import type { JellyfinItem } from '../adapters/players/jellyfin.js'

export const CHINESE_LANG_TAGS = /^(chi|zho|chs|cht|zh)([-_].*)?$/i
const IMAGE_SUB_CODECS = /pgs|vobsub|dvdsub|dvbsub/i
const CHINESE_ORIGIN = /china|hong ?kong|taiwan|中国|大陆|香港|台湾|澳门|macao|macau/i

export function isTriggerableType(type: string): boolean {
  return type === 'Movie' || type === 'Episode'
}

/** 国产内容不需要我们找中文字幕。元数据缺失返回 false（放行触发，宁多查勿漏配）。 */
export function isChineseOrigin(item: JellyfinItem): boolean {
  return (item.ProductionLocations ?? []).some(l => CHINESE_ORIGIN.test(l))
}

/** 判断是否缺可用中文字幕。treatPgsAsMissing=true 时图形字幕不算数。 */
export function needsChineseSubtitle(item: JellyfinItem, treatPgsAsMissing: boolean): boolean {
  const subs = (item.MediaStreams ?? []).filter(s => s.Type === 'Subtitle')
  const chinese = subs.filter(s => s.Language && CHINESE_LANG_TAGS.test(s.Language))
  const usable = treatPgsAsMissing
    ? chinese.filter(s => !s.Codec || !IMAGE_SUB_CODECS.test(s.Codec))
    : chinese
  return usable.length === 0
}
