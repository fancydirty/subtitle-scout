import type { JellyfinItem, JellyfinMediaStream } from '../adapters/players/jellyfin.js'

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

/** 可用中文字幕轨（treatPgsAsMissing=true 时排除图形字幕）。含内嵌与外挂，调用方按 IsExternal 自行区分。 */
export function usableChineseSubtitleStreams(
  item: JellyfinItem,
  treatPgsAsMissing: boolean
): JellyfinMediaStream[] {
  const subs = (item.MediaStreams ?? []).filter(s => s.Type === 'Subtitle')
  const chinese = subs.filter(s => s.Language && CHINESE_LANG_TAGS.test(s.Language))
  return treatPgsAsMissing
    ? chinese.filter(s => !s.Codec || !IMAGE_SUB_CODECS.test(s.Codec))
    : chinese
}

/** 判断是否缺可用中文字幕（外挂内嵌都算"有"——语义是"需不需要处理"）。treatPgsAsMissing=true 时图形字幕不算数。 */
export function needsChineseSubtitle(item: JellyfinItem, treatPgsAsMissing: boolean): boolean {
  return usableChineseSubtitleStreams(item, treatPgsAsMissing).length === 0
}

/** TMDB original_language 判国产：'zh' 及历史别名 'cn'。ja/ko/en 等一律 false。 */
export function isChineseLang(lang: string | null | undefined): boolean {
  return lang === 'zh' || lang === 'cn'
}

const HAN = /[一-鿿]/
const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯]/
/** 兜底启发式：含汉字且无假名无谚文 → 视作中文（排除日番/韩剧）。无 TMDB 信号时用。 */
export function looksChineseTitle(title: string | null | undefined): boolean {
  return !!title && HAN.test(title) && !KANA.test(title) && !HANGUL.test(title)
}
