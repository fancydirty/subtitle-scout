import { dirname, basename } from 'node:path'

/**
 * 外挂字幕 sidecar 探测——从 v2/scanner.ts 的 classifyItemDetailed rule 3 抽出的共享模块
 * （去 Jellyfin 化 P3，design: docs/design/2026-07-16-de-jellyfin-design.md §P3）。scanner.ts
 * 与新的 v2/ingest.ts 都要用同一份"给定 tag 集合，逐 tag×ext 探测磁盘上是否存在
 * `<videoBase>.<tag><ext>` sidecar 文件"的逻辑与语言换算表——搬到这里做单一事实来源，
 * scanner.ts 改为从此处导入（纯机械的 import 替换，不改它自己的行为/调用方式）。
 */

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']

export type SubtitleLanguage = string

/** tag → subtitles.language 记账值。中文 tag 保留原有 zh-Hans/zh-Hant 二值域精修（db.ts ~:69）
 *  ——cht 是繁体的明确信号 → zh-Hant；zh-Hant 同理原样映射；其余（zh-Hans/zh/chs/chi/zho）落地
 *  简体（这些 tag 本身不携带简繁区分，chs 明确简体），与 core/schemas.ts:49 `language` 的默认值
 *  zh-Hans 一致，是本仓库已有的兜底口径。非中文语言（en/ja/ko 等）的 tag 一律折回其 BCP-47
 *  主语言码（eng→en 等）——没有登记在表里的 tag 直接原样返回，这对 tagsForLanguage() 兜底出的
 *  `[code]`（比如未表列语言的裸 code tag）天然正确。 */
const LANGUAGE_BY_TAG: Record<string, SubtitleLanguage> = {
  'zh-Hans': 'zh-Hans',
  'zh-Hant': 'zh-Hant',
  zh: 'zh-Hans',
  chs: 'zh-Hans',
  cht: 'zh-Hant',
  chi: 'zh-Hans',
  zho: 'zh-Hans',
  en: 'en',
  eng: 'en',
  ja: 'ja',
  jpn: 'ja',
  ko: 'ko',
  kor: 'ko',
}

export function languageForTag(tag: string): SubtitleLanguage {
  return LANGUAGE_BY_TAG[tag] ?? tag
}

/** 找到即返回真实 sidecar 路径 + 按匹配到的 tag 换算出的语言；未找到为 null。targetTags 是
 *  调用方按目标语言集合算好的 tag 并集（languages.ts 的 tagsForLanguage 逐语言展开后
 *  flatMap），本函数不关心它们分别属于哪个语言——探测机制（tag × ext 双层遍历、逐一
 *  fileExists 探测）与 scanner.ts 原实现完全一致。 */
export function findExternalSidecar(
  videoPath: string,
  targetTags: string[],
  fileExists: (path: string) => boolean
): { path: string; language: SubtitleLanguage } | null {
  const dir = dirname(videoPath)
  const videoBase = basename(videoPath).replace(/\.[^.]+$/, '')

  for (const tag of targetTags) {
    for (const ext of SUBTITLE_EXTS) {
      const sidecarPath = `${dir}/${videoBase}.${tag}${ext}`
      if (fileExists(sidecarPath)) {
        return { path: sidecarPath, language: languageForTag(tag) }
      }
    }
  }
  return null
}
