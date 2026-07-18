import { dirname, basename } from 'node:path'

/**
 * 外挂字幕 sidecar 探测——从 v2/scanner.ts 的 classifyItemDetailed rule 3 抽出的共享模块
 * （去 Jellyfin 化 P3，design: docs/design/2026-07-16-de-jellyfin-design.md §P3）。抽出当时
 * scanner.ts 与新的 v2/ingest.ts 都要用同一份"给定 tag 集合，逐 tag×ext 探测磁盘上是否存在
 * `<videoBase>.<tag><ext>` sidecar 文件"的逻辑与语言换算表——搬到这里做单一事实来源，
 * scanner.ts 当时改为从此处导入（纯机械的 import 替换，不改它自己的行为/调用方式）。
 * scanner.ts 本身已随 T4（去 Jellyfin 化）整体退役删除，今天的唯一消费方是 v2/ingest.ts。
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
  // P0(zimuku 单源大考前置,2026-07-19):BCP-47 地区变体。区码→简繁按业界惯例:CN/SG 简体、
  // TW/HK 繁体;小写形态是 Bazarr 装机遗留惯例(NAS #recycle 实锤),大写规范形是 agent H2
  // 白名单装机产物(生产实锤)。探测集侧的对应扩表见 agent/languages.ts CHINESE_BCP47_REGION_TAGS。
  'zh-CN': 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-SG': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'zh-tw': 'zh-Hant',
  'zh-HK': 'zh-Hant',
  'zh-hk': 'zh-Hant',
}

export function languageForTag(tag: string): SubtitleLanguage {
  return LANGUAGE_BY_TAG[tag] ?? tag
}

/** C-3（状态收敛,批③a）：本模块结构性认得的全部 tag(LANGUAGE_BY_TAG 的键集合)——
 *  subtitlePropagation.ts 的 EEXIST 分支用它判断"磁盘上已存在、传播被挡下的那份文件,文件名
 *  能不能被认出语言"，与用户当前配置的 target_languages 无关(这是"认不认识这个 tag"的问题,
 *  不是"用户现在要不要这个语言"的问题,两者故意不耦合——磁盘上一份可辨认语言的字幕,不该因为
 *  当前设置没勾这个语言就被当成"看不懂")。 */
export const KNOWN_LANGUAGE_TAGS: string[] = Object.keys(LANGUAGE_BY_TAG)

/** 找到即返回真实 sidecar 路径 + 按匹配到的 tag 换算出的语言；未找到为 null。targetTags 是
 *  调用方按目标语言集合算好的 tag 并集（languages.ts 的 tagsForLanguage 逐语言展开后
 *  flatMap），本函数不关心它们分别属于哪个语言——探测机制（tag × ext 双层遍历、逐一
 *  fileExists 探测）与已删除的 scanner.ts 原实现完全一致。 */
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
