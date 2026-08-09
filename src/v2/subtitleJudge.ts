// src/v2/subtitleJudge.ts：需字幕判定（新架构阶段 3，纯机械无 LLM）。
// spec: docs/design/2026-08-08-PIPELINE-SPEC.md 裁决 D8 / 缺口 C27
//
// 规则（身份确定后自动跑）：
//  1. origin_lang ∈ 目标语言（如 zh）→ needs_subtitle=0（国产片，不需要中文字幕）
//  2. embedded_langs 含目标语言 → needs_subtitle=0（已有内嵌中字）
//  3. 其余 → needs_subtitle=1（需要找字幕）
//
// **判据只有语言事实**（D8 的职责切分）：needs_subtitle 回答"这资源**原则上**需要中文字幕吗"，
// 与磁盘上当前有没有外挂字幕无关；后者归 sub_status，由扫描独占写入（R24）。
//
// 这里曾有第 3 条规则「磁盘已有同名 sidecar 中文字幕 → needs_subtitle=0」，删掉的原因（C27）：
// 同一个**磁盘事实**被两列各判一次，就会造出一个双不满足的永久卡死态——
//   用户嫌翻译质量差手删字幕 → 扫描把 sub_status 从 covered 回退成 NULL ✅
//   但 needs_subtitle=0 留着 → 既不满足 judge 谓词 `needs_subtitle IS NULL`（不会重判它）、
//   又不满足字幕工作台谓词 `needs_subtitle=1`（不会排它）→ **这一集永久不再补字幕**，
//   而界面上什么异常都看不出来。
// 删掉之后"磁盘已有外挂中字的文件不许被送进字幕流白烧一轮付费 LLM"这个正确行为并没有丢，
// 只是换了保证者：由扫描写的 `sub_status='covered'` 挡在字幕工作台门口（R24）。
// 一个磁盘事实只许有一个投影列——这是 C19 换列复活（C27）的唯一根治办法。
import { langOf, tagsForLanguage } from '../agent/languages.js'

export interface JudgeInput {
  originLang: string | null
  embeddedLangs: string[] | null
}

export interface JudgeDeps {
  targetLanguages: string[]
}

export type JudgeVerdict =
  | { needs: false; reason: 'origin-skip' | 'embedded' }
  | { needs: true; reason: 'missing' }

/** 判定一个文件是否需要找字幕。纯函数（只看语言事实，不碰磁盘）。 */
export function judgeSubtitle(input: JudgeInput, deps: JudgeDeps): JudgeVerdict {
  // 1. 国产片跳过：origin_lang 是目标语言（如 zh 目标中文时，中文影视不需要中文字幕）
  if (input.originLang != null && deps.targetLanguages.includes(input.originLang.toLowerCase())) {
    return { needs: false, reason: 'origin-skip' }
  }
  // 2. 已有内嵌中字
  if (input.embeddedLangs != null) {
    const hasTargetEmbedded = input.embeddedLangs.some((l) =>
      deps.targetLanguages.includes(langOf(l)))
    if (hasTargetEmbedded) return { needs: false, reason: 'embedded' }
  }
  // 3. 需要找字幕
  return { needs: true, reason: 'missing' }
}

/** 可抓源 / 可抽轨的源语言集合（R20 的 MVP 边界，两者**刻意不同**）。
 *
 *  · fetchableSourceLangs = 能从 provider **抓到外挂源语言字幕**的语言。MVP 仅 en
 *    （OpenSubtitles 靠 imdb 命中）。日语要等 F2 的 jimaku 落地，见 C6。
 *  · extractableSourceLangs = 能**抽内嵌文本轨**的语言。en/ja 皆可——抽轨是纯本地 ffmpeg
 *    操作、零 provider 依赖，故天然比抓取宽。
 *
 *  为什么必须是两个集合而不是一个（R20 的口径统一）：spec 正文写"MVP 仅 en"、而
 *  translateWorkerTask.ts:49 的 SUPPORTED_SOURCE_LANGS 实为 ['en','ja']——两处口径不一
 *  正是因为它们说的是不同的事。合成一个集合的话，取 ['en'] 会误判死有日文轨的日漫（C31），
 *  取 ['en','ja'] 会让无内嵌轨的韩剧…… 不，会让**无内嵌轨的日漫**被判可救 → 移交翻译流 →
 *  翻译流发现抓不到日文源 → unsolvable，白绕一圈（C24 想省掉的正是这种绕路）。 */
export interface TranslatableDeps {
  fetchableSourceLangs: string[]
  extractableSourceLangs: string[]
}

/** 三态可救性（R21 + D9）。**返回 null 是有意义的第三态，不是"失败"**。 */
export type Translatable = 0 | 1 | null

/** 一个语言标签是否算作某个 BCP-47 主语言码（如 'jpn' 算 'ja'）。
 *
 *  🔴 为什么不能直接用 `langOf(a) === langOf(b)`（3-2 实测踩到，用例当场红）：
 *  `langOf` **只折叠中文别名**（ZH_ORIGIN_CODES = chi/zho/cmn/cn → zh），对其他语言是
 *  纯粹的"小写 + 去地区后缀"透传。于是 `langOf('jpn')` 得到 `'jpn'`，与 `'ja'` 不相等。
 *  而这两种形态在生产里**必然同时出现**：`works.origin_lang` 来自 TMDB 的 ISO-639-1
 *  两字母（ja/en/ko），`files.embedded_langs` 来自 ffprobe 的 ISO-639-2 三字母（jpn/eng/kor）。
 *  照字面比较的话，D9 第 ② 支对**每一部日漫**都判不成立 → 全体 translatable=0 → 永久停牌，
 *  正是 D9 存在的全部目的被静默取消。
 *
 *  复用 `tagsForLanguage`（'ja' → ['ja','jpn']）这一份既有映射，**不另写第二份折叠表**：
 *  本仓已因"留两份漂移实现"栽过（C30 的两处标签集各漏一半、第 1a 步的 findOverlappingRoot），
 *  语言映射尤其不能分叉——分叉的那天没有任何测试会红，只是日漫又开始被判死。 */
function isLang(tag: string | null | undefined, primary: string): boolean {
  if (!tag) return false
  const t = tag.toLowerCase()
  // 直接命中该语言的标签集（含三字母形态），或去掉地区/脚本后缀后命中主码
  // （'zh-Hans'→'zh'、'en-US'→'en'；ffprobe 偶尔给 'ja-JP' 这种）。
  return tagsForLanguage(primary).some((x) => x.toLowerCase() === t)
    || langOf(tag) === langOf(primary)
}

/** 预判"翻译救不救得了这一集"（R21），写入 files.translatable。纯函数，不碰磁盘。
 *
 *  两条**并列**判据（D9，缺一不可）：
 *   ① origin_lang ∈ 可抓源集合（MVP=en）→ 能抓外挂源语言字幕来译
 *   ② embedded_langs 含 **origin 同语言**文本轨 → 能抽轨来译（纯本地，符合 R13 单跳）
 *
 *  为什么第 ② 支非有不可（C31，这是本函数存在的全部理由）：`resolveSource.ts:56-65` 对
 *  `origin=ja` 且有日文内嵌轨的情况可以直接抽轨翻译。只看 origin_lang（第 ① 支）会把 BD
 *  压制的日漫——普遍带日文内嵌轨——判成不可救 → 满 7 次后直接 unsolvable → **永久停牌**，
 *  而它其实一抽就能救。
 *
 *  为什么第 ② 支要求"**同语言**"而不是"有任何内嵌轨"（R18 / C17）：R18 废止了 eng 兜底
 *  （JP→EN→CN 丢义严重，R13 只许单跳）。一部日漫只有英文内嵌轨时是**真的**不可救。
 *
 *  ── 何时返回 null（C40 铁律：`translatable IS NULL` 不得判死）──
 *  两条判据都不成立时还要分辨"确实不可救"与"暂时判不了"：
 *   · origin_lang 未知（NULL/空）→ null。TMDB 没刮到语言时**不许臆断**（C17 记有实案：
 *     resolveSource 曾把 origin==='' 当英语处理，语言完全未经证实）。连源语言都不知道，
 *     "单跳直译"的源是什么都说不出来，此时给 0 就是拿信息缺失当结论。
 *   · origin_lang 已知、但 embedded_langs 为 NULL（= "没探测过"，非 "[]确认零轨"）→ null。
 *     判据不全，待 D17 回填补上证据后重判；给 0 会永久判死一个可能有日文轨的日漫。
 *     注意：origin ∈ 可抓源集合时第 ① 支已足够定论，**不受这一条影响**（否则一批本可立刻
 *     判可救的英语片会白等一轮回填）。
 *  三态语义与 streamProbe 的 null/[] 契约一脉相承：null=不知道，0/[]=知道且为空。 */
export function judgeTranslatable(input: JudgeInput, deps: TranslatableDeps): Translatable {
  const origin = langOf(input.originLang)
  // origin 未知：两条判据都无从谈起（抽轨也要知道源语言是什么，见上方论证）。
  if (origin === '') return null

  // ① 可抓源集合。这一支不依赖内嵌轨证据，故先判——它能在 embedded_langs 还是 NULL 时定论。
  if (deps.fetchableSourceLangs.some((l) => isLang(l, origin))) return 1

  // ② 同语言内嵌文本轨。图形轨（PGS/DVD/DVB/XSub）已在 probe 写入前剔除，故这一列里的值
  //    一律视为文本轨——判据是 embedded_langs 这一列的语义，不是原始轨列表。
  if (deps.extractableSourceLangs.some((l) => isLang(l, origin))) {
    if (input.embeddedLangs === null) return null   // 判据不全（没探过）→ 暂不可判，不判死
    if (input.embeddedLangs.some((l) => isLang(l, origin))) return 1
    return 0   // 探过、确认没有同语言轨 → 真的不可救（不许 eng 兜底 / R18）
  }

  // origin 既不可抓、也不在可抽轨集合内（如 ko/fr）。此时内嵌轨有没有都不影响结论：
  // 抽出来一条韩文轨我们也没有 ko→zh 的单跳能力。故 embedded_langs 为 NULL 也照判 0
  // ——这不是"判据不全"，是"这门语言我们整体不支持"，补上证据也不会改变结论。
  return 0
}
