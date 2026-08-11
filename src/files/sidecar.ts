import { dirname, basename } from 'node:path'

/**
 * 外挂字幕 sidecar 探测——从 v2/scanner.ts 的 classifyItemDetailed rule 3 抽出的共享模块
 * （去 Jellyfin 化 P3，design: docs/design/2026-07-16-de-jellyfin-design.md §P3）。抽出当时
 * scanner.ts 与新的 v2/ingest.ts 都要用同一份"给定 tag 集合，逐 tag×ext 探测磁盘上是否存在
 * `<videoBase>.<tag><ext>` sidecar 文件"的逻辑与语言换算表——搬到这里做单一事实来源，
 * scanner.ts 当时改为从此处导入（纯机械的 import 替换，不改它自己的行为/调用方式）。
 * scanner.ts 本身已随 T4（去 Jellyfin 化）整体退役删除，今天的唯一消费方是 v2/ingest.ts。
 */

/** 探测面的扩展名集。
 *
 *  为什么这里含 `.vtt` 而 subtitleWriter.ts / referenceSource.ts 的同名常量不含（C30 收敛决策）：
 *  三处问的**不是同一个问题**，此前却因为"看起来同名同值"被当成必须一致，于是 daemonV2 那边
 *  自己另写了一份带 .vtt 的正则 → 两份实现漂移，各漏一半（本函数漏 .vtt，那份正则漏 cht 与
 *  全部 BCP-47 地区变体），同一个磁盘事实在两条代码路径上得到相反结论。
 *
 *   · subtitleWriter（"我们能装什么"）：装的是自己抓来的 artifact，产物形态由我们决定，
 *     没有理由主动生产 .vtt。
 *   · referenceSource（"什么能当对齐参考源"）：受 parseSrtCues/parseAssCues 的能力硬约束，
 *     .vtt 解析不了，收进来只会得到 0 条 cue 的假参考源（见该文件 SIBLING_SUBTITLE_EXTS 注释）。
 *   · 本函数（"磁盘上现在有没有这个语言的字幕"）：这是**事实观察**（R24），判据是用户/播放器
 *     视角的"有没有可用的中文字幕"，与我们能不能装、能不能解析无关。用户手放一份 .vtt
 *     （R23 明写"用户手放的也认"），系统若因为自己不生产 .vtt 就视而不见，就会一直去重复找
 *     一份用户已经有了的字幕——这正是 R24 要消解的那类"库与磁盘不一致"。
 *
 *  故此处放宽是有意的语义分歧，不是漂移；三处不再有"必须一致"的约束，各自的注释都写明了理由。 */
const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa', '.vtt']

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

/** 无语言标记的裸字幕（`<stem>.srt`）记账值。
 *
 *  为什么必须有一个显式值而不是跳过、也不是猜成目标语言：跳过会让"这一集旁边确实躺着一份
 *  字幕"这个事实彻底消失（sidecar_langs 记成 []，与"真的一条都没有"同形）；猜成目标语言则是
 *  拿信息缺失当结论——换语言重判时会据此判"已有字幕"，而那份字幕可能是任何语言。
 *  'und' 是 ISO 639-2 的标准 undetermined 码，且天然不等于任何真实目标语言码，
 *  故它在重判的集合判定里永远不构成覆盖，语义上正是我们要的"知道有、但不知道是什么"。 */
export const UNDETERMINED_LANGUAGE = 'und'

/** 列出**该视频旁边全部外挂字幕的语言**（R-F15 缺口②）。三态：null=目录读不了（没观察到），
 *  []=观察过、确认零条，非空数组=去重且已排序的语言集合（如 `["en","ja","zh-Hans"]`）。
 *
 *  ── 与 findExternalSidecar 的分工（两者刻意并存，不是新旧替换）──────────────
 *   · findExternalSidecar 回答「**当前目标语言**的字幕在不在」——单个布尔判据，服务 sub_status
 *     与 ingest 的 rule 3，且要给出**命中的那条真实路径**（领养记账要用）。
 *   · 本函数回答「这个视频旁边**一共有哪些语言**的字幕」——与当前 target_languages 完全无关的
 *     磁盘事实（同 KNOWN_LANGUAGE_TAGS 头注释确立的既有口径：认不认识这个 tag ≠ 用户现在
 *     要不要这个语言）。正因为与配置无关，换目标语言后才能**不重新扫盘**就重导 sub_status。
 *
 *  ── 为什么机制是 readdir 而不是继续逐个 fileExists（性能是硬约束）──────────
 *  "所有语言"没有有限 tag 集，无法用现状的"构造 `<stem>.<tag><ext>` 再探存在性"枚举——
 *  硬要枚举就是 4 语言 × 15 tag × 4 ext = 240 次 stat/文件，在 115 的 rclone FUSE 挂载上
 *  必然打崩。反过来 readdir 一次拿到整个目录的文件名、在内存里正则匹配，**比现状还快**：
 *  现状是 15 中文 tag × 4 ext = 60 次 stat/文件，且**未命中时全额付费**——而未命中恰恰是
 *  "需要找字幕"那批（生产主力人群）。实测（本地 tmpfs，24 个视频的季目录、无中字）：
 *    逐个 existsSync 1440 次 syscall / 5.82ms   vs   readdir 1 次 / 0.22ms   → 快 26 倍。
 *  调用方必须做 **per-scan 的目录缓存**（daemonV2.detectSubtitles），否则同目录 24 个视频
 *  就是 24 次 readdir，收益归零且比原来更糟（单次 readdir 比单次 stat 贵）。
 *
 *  ── 匹配规则（误归属是 C30 的原案，机制上必须堵死）──────────────────────
 *  只认 `<stem>.<tag><ext>`：stem 后紧跟一个点、然后是**不含点**的单段 tag、然后是扩展名。
 *  `X.1080p.zh.srt` 因此**不会**归给 `X.mkv`（旧的 startsWith(stem+'.') 会误归，真实剧本是
 *  同目录并存 `E01.mkv` 与 `E01.1080p.mkv`，前者被误判 covered 后永远不补字幕）。
 *  `<stem><ext>`（无 tag 的裸字幕）单独认成 UNDETERMINED_LANGUAGE，见该常量注释。
 *
 *  tag → 语言的换算复用 languageForTag 这一份既有表，**不另写第二份折叠**：本仓已因"留两份
 *  漂移实现"栽过（C30 两处标签集各漏一半）。特别注意不能改用 agent/languages.ts 的 langOf——
 *  它**只折叠中文别名 chi/zho/cmn/cn**，对 `chs`/`cht` 返回自身（实测），漏判简繁两种最常见
 *  的中文 sidecar 形态。 */
export function listSidecarLanguages(
  videoPath: string,
  readdir: (dir: string) => string[],
): SubtitleLanguage[] | null {
  const dir = dirname(videoPath)
  const videoBase = basename(videoPath).replace(/\.[^.]+$/, '')

  let names: string[]
  try {
    names = readdir(dir)
  } catch {
    // FUSE 挂载抖动读不了目录 → null（没观察到），**绝不折叠成 []**。折叠的话一次抖动就被
    // 记成"这片子一条字幕都没有"，换语言重判时据此重新找一遍（烧付费 LLM），
    // 与 embedded_langs / streamProbe 的 null-vs-[] 三态契约同源。
    return null
  }

  const langs = new Set<SubtitleLanguage>()
  for (const name of names) {
    const ext = SUBTITLE_EXTS.find((e) => name.toLowerCase().endsWith(e))
    if (!ext) continue
    const stem = name.slice(0, name.length - ext.length)
    if (stem === videoBase) { langs.add(UNDETERMINED_LANGUAGE); continue }
    if (!stem.startsWith(`${videoBase}.`)) continue
    const tag = stem.slice(videoBase.length + 1)
    // 单段 tag（不含点）——多段的是别的视频的字幕或带修饰的文件名，不归本视频（C30）。
    if (tag === '' || tag.includes('.')) continue
    langs.add(languageForTag(tag))
  }
  // 排序让这一列的值**稳定**：同一组字幕不该因为 readdir 的返回顺序（不同 FS 不同）而写出
  // 不同的 JSON 串，否则每轮观察都在改写同一行、updated_at 无谓翻新，且测试无从断言。
  return [...langs].sort()
}
