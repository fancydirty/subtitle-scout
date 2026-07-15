import type { JellyfinItem, JellyfinMediaStream } from '../adapters/players/jellyfin.js'

/**
 * 去 Jellyfin 化 T4：本文件曾经的四个函数——isTriggerableType、isChineseOrigin（连同它专用的
 * CHINESE_ORIGIN 正则）、isChineseLang——已删除，rule-1 ProductionLocations 启发式与 v1
 * watcher 播放触发判据都随各自唯一的调用方（v2/scanner.ts、daemon/watcher.ts）一起退役，
 * 已确认零剩余生产调用方（各自的 .test.ts 描述块同步删除）。
 *
 * 保留 needsChineseSubtitle（连同它依赖的 usableChineseSubtitleStreams / CHINESE_LANG_TAGS）：
 * 唯一剩余调用方是 src/adapters/players/jellyfin.ts 的 JellyfinClient.getSeasonEpisodes——
 * 该方法目前本身没有生产调用方（只在 PlayerServer 接口/jellyfin.test.ts 里出现），但
 * jellyfin.ts/types.ts 属于 Jellyfin 出口清算（design §P7）的范围，不在本次任务改动范围内，
 * 删除 needsChineseSubtitle 会直接破坏 jellyfin.ts 的编译。
 *
 * looksChineseTitle 保留：v2/ingest.ts 直接从本文件导入（rule 1b 的标题启发式兜底，语义
 * 移植自旧 v2/scanner.ts，见 ingest.ts 顶部注释）。
 */

export const CHINESE_LANG_TAGS = /^(chi|zho|chs|cht|zh)([-_].*)?$/i
const IMAGE_SUB_CODECS = /pgs|vobsub|dvdsub|dvbsub/i

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

const HAN = /[一-鿿]/
const KANA = /[぀-ヿ]/
const HANGUL = /[가-힯]/
/** 兜底启发式：含汉字且无假名无谚文 → 视作中文（排除日番/韩剧）。无 TMDB 信号时用。 */
export function looksChineseTitle(title: string | null | undefined): boolean {
  return !!title && HAN.test(title) && !KANA.test(title) && !HANGUL.test(title)
}
